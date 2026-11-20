import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { omniCodexDataDirectory } from "../config/omnicodex-config-store.js";
import { canonicalJson } from "../safety/canonical-json.js";
import { readLegacyDirectJobs } from "./direct-job-legacy-reader.js";
import {
  assertDirectJobMigrationSource,
  commitDirectJobMigration,
  type DirectJobMigrationState,
  prepareDirectJobMigration,
} from "./direct-job-migration-state.js";

const RESTART_BEFORE_DISPATCH = "PROCESS_RESTART_BEFORE_DISPATCH";
const RESTART_AFTER_DISPATCH = "PROCESS_RESTART_AFTER_DISPATCH";

export type DirectJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "outcome_unknown"
  | "cancelled";

export interface DirectJobScope {
  /** Stable server-derived authorization boundary. Never a bearer token. */
  readonly authorizationBinding: string;
  /** Stable opaque ChatGPT conversation identity supplied by the caller. */
  readonly conversationId: string;
  /** Stable opaque work-session identity that may survive MCP reconnects. */
  readonly workSessionId: string;
}

export interface DirectJobStartInput extends DirectJobScope {
  readonly idempotencyKey: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  /** Server-resolved immutable native target contract. Never caller-selected. */
  readonly targetContract?: DirectJobTargetContract;
}

export interface DirectJobTargetContract {
  readonly catalogRevision: string;
  readonly targetIdentity: string;
  readonly targetContractDigest: string;
  readonly modelEffect: "none" | "model" | "unknown";
}

export interface DirectJobAccessInput extends DirectJobScope {
  readonly jobId: string;
}

export interface DirectJobListInput extends DirectJobScope {
  readonly statuses?: readonly DirectJobStatus[];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface DirectJobErrorView {
  readonly code: string;
  readonly message: string;
  /** Complete JSON-safe native/transport rejection envelope, when available. */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly [field: string]: unknown;
}

export interface DirectJobView {
  readonly jobId: string;
  readonly operationId: string;
  readonly status: DirectJobStatus;
  readonly toolName: string;
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
  readonly startedAtUnixMs?: number;
  readonly finishedAtUnixMs?: number;
  readonly cancelRequestedAtUnixMs?: number;
  readonly result?: CallToolResult;
  readonly error?: DirectJobErrorView;
}

export interface DirectJobListView {
  readonly jobs: readonly DirectJobView[];
  readonly nextCursor?: string;
}

export interface DirectJobStartView {
  readonly disposition: "created" | "existing";
  readonly job: DirectJobView;
}

export interface DirectJobCancelView {
  readonly disposition: "cancelled" | "cancellation_requested" | "already_terminal";
  readonly job: DirectJobView;
}

export interface DirectJobStoreOptions {
  readonly dataDirectory?: string;
  readonly snapshotPath?: string;
  readonly maxJobs?: number;
  readonly maxResultBytes?: number;
  readonly nowUnixMs?: () => number;
  readonly randomUUID?: () => string;
}

export interface InMemoryDirectJobStoreOptions {
  readonly maxJobs?: number;
  readonly maxResultBytes?: number;
  readonly nowUnixMs?: () => number;
  readonly randomUUID?: () => string;
}

export class DirectJobConflictError extends Error {
  readonly code = "DIRECT_JOB_IDEMPOTENCY_CONFLICT";

  constructor() {
    super("Direct job idempotency key was already bound to different work");
    this.name = "DirectJobConflictError";
  }
}

export class DirectJobStateError extends Error {
  readonly code = "DIRECT_JOB_INVALID_TRANSITION";

  constructor(message: string) {
    super(message);
    this.name = "DirectJobStateError";
  }
}

export class DirectJobSnapshotError extends Error {
  readonly code = "DIRECT_JOB_SNAPSHOT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "DirectJobSnapshotError";
  }
}

interface StoredJob {
  readonly jobId: string;
  readonly operationId: string;
  readonly ownerDigest: string;
  readonly conversationDigest: string;
  readonly workSessionDigest: string;
  readonly idempotencyDigest: string;
  readonly fingerprintDigest: string;
  readonly status: DirectJobStatus;
  readonly toolName: string;
  readonly targetContract?: DirectJobTargetContract;
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
  readonly startedAtUnixMs?: number;
  readonly finishedAtUnixMs?: number;
  readonly cancelRequestedAtUnixMs?: number;
  readonly result?: CallToolResult;
  readonly error?: DirectJobErrorView;
}

interface LedgerMetadata {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly jobCount: number;
  readonly legacyChecksum: string | null;
}

interface MigrationBootstrap {
  readonly schemaVersion: 1;
  readonly pendingChecksum: string;
  readonly initialRevision: number;
  readonly initialJobCount: number;
  readonly legacyChecksum: string | null;
}

interface DirectJobConfiguration {
  readonly kind: "durable" | "memory";
  readonly snapshotPath?: string;
  readonly maxJobs: number | undefined;
  readonly maxResultBytes: number | undefined;
  readonly nowUnixMs: () => number;
  readonly randomUUID: () => string;
}

interface CoreRegistryEntry {
  readonly configuration: DirectJobConfiguration & { readonly snapshotPath: string };
  readonly promise: Promise<DirectJobCore>;
}

const PROCESS_CORES_SYMBOL = Symbol.for("@heelee912/omnicodex/direct-job-cores/sqlite-v1");
const processCores = processCoreRegistry();

/**
 * Owner-, conversation-, and work-session-bound durable ledger for native
 * direct jobs. It stores no native arguments and has no model/thread dispatch
 * capability; execution is supplied by the server-owned direct dispatcher.
 */
export class DirectJobStore {
  readonly #sharedCore: DirectJobCore;
  #closed = false;

  private constructor(core: DirectJobCore) {
    this.#sharedCore = core;
    core.retain();
  }

  get #core(): DirectJobCore {
    if (this.#closed) throw new DirectJobStateError("Direct job store is closed");
    return this.#sharedCore;
  }

  /** Releases this handle. Other handles opened for the same path remain usable. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#sharedCore.release();
  }

  static async open(options: DirectJobStoreOptions = {}): Promise<DirectJobStore> {
    const configuration = durableConfiguration(options);
    const key = processPathKey(configuration.snapshotPath);
    const existing = processCores.get(key);
    if (existing !== undefined) {
      assertSameConfiguration(existing.configuration, configuration);
      const core = await existing.promise;
      if (core.disposed) return DirectJobStore.open(options);
      return new DirectJobStore(core);
    }
    const promise = DirectJobCore.open(configuration);
    const entry = { configuration, promise };
    processCores.set(key, entry);
    try {
      return new DirectJobStore(await promise);
    } catch (error) {
      if (processCores.get(key) === entry) processCores.delete(key);
      throw error;
    }
  }

  static inMemory(options: InMemoryDirectJobStoreOptions = {}): DirectJobStore {
    return new DirectJobStore(DirectJobCore.inMemory(memoryConfiguration(options)));
  }

  get snapshotPath(): string | undefined {
    return this.#core.snapshotPath;
  }

  /** SQLite sidecar; snapshotPath remains the immutable legacy migration source. */
  get databasePath(): string | undefined {
    const path = this.#core.snapshotPath;
    return path === undefined ? undefined : `${path}.sqlite`;
  }

  start(input: DirectJobStartInput): Promise<DirectJobStartView> {
    return this.#core.start(validateStartInput(input));
  }

  /**
   * Performs the durable idempotency/fingerprint lookup without creating a
   * job. Callers can therefore recover an existing result before consulting a
   * newer runtime catalog, while an absent record still follows normal create
   * validation and the serialized start race.
   */
  findExisting(input: DirectJobStartInput): Promise<DirectJobStartView | undefined> {
    return this.#core.findExisting(validateStartInput(input));
  }

  get(input: DirectJobAccessInput): Promise<DirectJobView | undefined> {
    return this.#core.get(validateAccessInput(input));
  }

  list(input: DirectJobListInput): Promise<DirectJobListView> {
    return this.#core.list(validateListInput(input));
  }

  markRunning(input: DirectJobAccessInput): Promise<DirectJobView> {
    return this.#core.markRunning(validateAccessInput(input));
  }

  failBeforeDispatch(
    input: DirectJobAccessInput,
    error: DirectJobErrorView,
    result?: CallToolResult,
  ): Promise<DirectJobView> {
    return this.#core.failBeforeDispatch(
      validateAccessInput(input),
      validateError(error),
      result === undefined ? undefined : cloneResult(result),
    );
  }

  succeed(input: DirectJobAccessInput, result: CallToolResult): Promise<DirectJobView> {
    return this.#core.succeed(validateAccessInput(input), cloneResult(result));
  }

  fail(
    input: DirectJobAccessInput,
    error: DirectJobErrorView,
    result?: CallToolResult,
  ): Promise<DirectJobView> {
    return this.#core.fail(
      validateAccessInput(input),
      validateError(error),
      result === undefined ? undefined : cloneResult(result),
    );
  }

  markOutcomeUnknown(
    input: DirectJobAccessInput,
    error: DirectJobErrorView,
  ): Promise<DirectJobView> {
    return this.#core.markOutcomeUnknown(validateAccessInput(input), validateError(error));
  }

  /**
   * Atomically establishes a terminal shutdown fence without a read/transition
   * race: queued work is cancelled, dispatched work becomes outcome_unknown,
   * and an existing terminal result is preserved verbatim.
   */
  fenceTerminal(input: DirectJobAccessInput, error: DirectJobErrorView): Promise<DirectJobView> {
    return this.#core.fenceTerminal(validateAccessInput(input), validateError(error));
  }

  requestCancel(input: DirectJobAccessInput): Promise<DirectJobCancelView> {
    return this.#core.requestCancel(validateAccessInput(input));
  }

  finishCancelled(
    input: DirectJobAccessInput,
    error: DirectJobErrorView = {
      code: "DIRECT_JOB_CANCELLED",
      message: "Direct job was cancelled",
    },
  ): Promise<DirectJobView> {
    return this.#core.finishCancelled(validateAccessInput(input), validateError(error));
  }
}

class DirectJobCore {
  readonly #configuration: DirectJobConfiguration;
  #jobs: Map<string, StoredJob>;
  #revision: number;
  #tail: Promise<void> = Promise.resolve();
  readonly #database: SqliteJobLedger | undefined;
  #references = 0;
  #disposed = false;

  private constructor(
    configuration: DirectJobConfiguration,
    revision: number,
    jobs: Map<string, StoredJob>,
    database?: SqliteJobLedger,
  ) {
    this.#configuration = configuration;
    this.#revision = revision;
    this.#jobs = jobs;
    this.#database = database;
  }

  static async open(
    configuration: DirectJobConfiguration & { readonly snapshotPath: string },
  ): Promise<DirectJobCore> {
    const database = await SqliteJobLedger.open(configuration);
    const core = new DirectJobCore(configuration, 0, new Map(), database);
    try {
      await core.#recoverAfterRestart();
      return core;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  static inMemory(configuration: DirectJobConfiguration): DirectJobCore {
    return new DirectJobCore(configuration, 0, new Map());
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  retain(): void {
    if (this.#disposed) throw new DirectJobStateError("Direct job store is closed");
    this.#references += 1;
  }

  async release(): Promise<void> {
    this.#references -= 1;
    if (this.#references !== 0) return;
    await this.#tail;
    // An already-pending open may have retained this core while close drained.
    if (this.#references !== 0) return;
    this.#disposed = true;
    const path = this.#configuration.snapshotPath;
    if (path !== undefined) processCores.delete(processPathKey(path));
    this.#database?.close();
  }

  get snapshotPath(): string | undefined {
    return this.#configuration.snapshotPath;
  }

  start(input: DirectJobStartInput): Promise<DirectJobStartView> {
    return this.#serialized(async () => {
      const scope = scopeDigests(input);
      const idempotencyDigest = digestText(input.idempotencyKey);
      const fingerprintDigest = digestJson({
        contract: "omnicodex-direct-job-v1",
        toolName: input.toolName,
        arguments: input.arguments,
      });
      const recordDigest = directJobRecordDigest(scope, idempotencyDigest);
      const jobId = publicId(recordDigest, 4);
      const operationId = publicId(digestText(`operation\0${recordDigest}`), 5);
      const current = this.#getJob(jobId);
      if (current !== undefined) {
        assertScope(current, scope);
        if (current.fingerprintDigest !== fingerprintDigest) throw new DirectJobConflictError();
        return { disposition: "existing", job: publicView(current) };
      }

      const timestamp = checkedTimestamp(this.#configuration.nowUnixMs());
      const created: StoredJob = {
        jobId,
        operationId,
        ...scope,
        idempotencyDigest,
        fingerprintDigest,
        status: "queued",
        toolName: input.toolName,
        ...(input.targetContract === undefined ? {} : { targetContract: input.targetContract }),
        createdAtUnixMs: timestamp,
        updatedAtUnixMs: timestamp,
      };
      this.#commit(created, true);
      return { disposition: "created", job: publicView(created) };
    });
  }

  findExisting(input: DirectJobStartInput): Promise<DirectJobStartView | undefined> {
    return this.#serialized(async () => {
      const scope = scopeDigests(input);
      const idempotencyDigest = digestText(input.idempotencyKey);
      const fingerprintDigest = digestJson({
        contract: "omnicodex-direct-job-v1",
        toolName: input.toolName,
        arguments: input.arguments,
      });
      const jobId = publicId(directJobRecordDigest(scope, idempotencyDigest), 4);
      const current = this.#getJob(jobId);
      if (current === undefined) return undefined;
      assertScope(current, scope);
      if (current.fingerprintDigest !== fingerprintDigest) throw new DirectJobConflictError();
      return { disposition: "existing", job: publicView(current) };
    });
  }

  get(input: DirectJobAccessInput): Promise<DirectJobView | undefined> {
    return this.#serialized(async () => {
      const current = this.#getJob(input.jobId);
      if (current === undefined || !scopeMatches(current, scopeDigests(input))) return undefined;
      return publicView(current);
    });
  }

  list(input: DirectJobListInput): Promise<DirectJobListView> {
    return this.#serialized(async () => {
      const scope = scopeDigests(input);
      if (this.#database !== undefined) return this.#database.list(input, scope);
      const statusSet = input.statuses === undefined ? undefined : new Set(input.statuses);
      const scoped = [...this.#jobs.values()]
        .filter((job) => scopeMatches(job, scope) && (statusSet?.has(job.status) ?? true))
        .sort(compareJobsNewestFirst);
      const start = input.cursor === undefined ? 0 : listStart(scoped, input.cursor);
      const page =
        input.limit === undefined ? scoped.slice(start) : scoped.slice(start, start + input.limit);
      const last = page.at(-1);
      return {
        jobs: page.map(publicView),
        ...(start + page.length < scoped.length && last !== undefined
          ? { nextCursor: listCursor(last) }
          : {}),
      };
    });
  }

  markRunning(input: DirectJobAccessInput): Promise<DirectJobView> {
    return this.#transition(input, (current, timestamp) => {
      if (current.status !== "queued") {
        throw new DirectJobStateError("Only a queued direct job can begin native dispatch");
      }
      return {
        ...current,
        status: "running",
        startedAtUnixMs: timestamp,
        updatedAtUnixMs: timestamp,
      };
    });
  }

  failBeforeDispatch(
    input: DirectJobAccessInput,
    error: DirectJobErrorView,
    result?: CallToolResult,
  ): Promise<DirectJobView> {
    if (result !== undefined) this.#assertResultSize(result);
    return this.#transition(input, (current, timestamp) => {
      if (current.status !== "queued") {
        throw new DirectJobStateError("Only a queued direct job can fail before native dispatch");
      }
      return terminalJob(current, "failed", timestamp, {
        error,
        ...(result === undefined ? {} : { result }),
      });
    });
  }

  succeed(input: DirectJobAccessInput, result: CallToolResult): Promise<DirectJobView> {
    this.#assertResultSize(result);
    return this.#transition(input, (current, timestamp) => {
      if (current.status !== "running") {
        throw new DirectJobStateError("Only a running direct job can succeed");
      }
      return terminalJob(current, "succeeded", timestamp, { result });
    });
  }

  fail(
    input: DirectJobAccessInput,
    error: DirectJobErrorView,
    result?: CallToolResult,
  ): Promise<DirectJobView> {
    if (result !== undefined) this.#assertResultSize(result);
    return this.#transition(input, (current, timestamp) => {
      if (current.status !== "running") {
        throw new DirectJobStateError("Only a running direct job can fail");
      }
      return terminalJob(current, "failed", timestamp, {
        error,
        ...(result === undefined ? {} : { result }),
      });
    });
  }

  markOutcomeUnknown(
    input: DirectJobAccessInput,
    error: DirectJobErrorView,
  ): Promise<DirectJobView> {
    return this.#transition(input, (current, timestamp) => {
      if (current.status !== "running") {
        throw new DirectJobStateError("Only a running direct job can have an unknown outcome");
      }
      return terminalJob(current, "outcome_unknown", timestamp, { error });
    });
  }

  fenceTerminal(input: DirectJobAccessInput, error: DirectJobErrorView): Promise<DirectJobView> {
    return this.#serialized(async () => {
      const current = this.#requiredScopedJob(input.jobId, scopeDigests(input));
      if (isTerminal(current.status)) return publicView(current);
      const timestamp = this.#timestampAfter(current.updatedAtUnixMs);
      const nextJob = terminalJob(
        current,
        current.status === "queued" ? "cancelled" : "outcome_unknown",
        timestamp,
        { error },
      );
      this.#commit(nextJob);
      return publicView(nextJob);
    });
  }

  requestCancel(input: DirectJobAccessInput): Promise<DirectJobCancelView> {
    return this.#serialized(async () => {
      const scope = scopeDigests(input);
      const current = this.#requiredScopedJob(input.jobId, scope);
      if (isTerminal(current.status)) {
        return { disposition: "already_terminal", job: publicView(current) };
      }
      const timestamp = this.#timestampAfter(current.updatedAtUnixMs);
      const nextJob: StoredJob =
        current.status === "queued"
          ? terminalJob(current, "cancelled", timestamp, {
              error: {
                code: "DIRECT_JOB_CANCELLED_BEFORE_DISPATCH",
                message: "Direct job was cancelled before native dispatch",
              },
            })
          : {
              ...current,
              cancelRequestedAtUnixMs: current.cancelRequestedAtUnixMs ?? timestamp,
              updatedAtUnixMs: timestamp,
            };
      this.#commit(nextJob);
      return {
        disposition: current.status === "queued" ? "cancelled" : "cancellation_requested",
        job: publicView(nextJob),
      };
    });
  }

  finishCancelled(input: DirectJobAccessInput, error: DirectJobErrorView): Promise<DirectJobView> {
    return this.#transition(input, (current, timestamp) => {
      if (current.status !== "running" || current.cancelRequestedAtUnixMs === undefined) {
        throw new DirectJobStateError(
          "A running direct job needs a durable cancellation request before cancellation completes",
        );
      }
      return terminalJob(current, "cancelled", timestamp, { error });
    });
  }

  #transition(
    input: DirectJobAccessInput,
    update: (current: StoredJob, timestamp: number) => StoredJob,
  ): Promise<DirectJobView> {
    return this.#serialized(async () => {
      const current = this.#requiredScopedJob(input.jobId, scopeDigests(input));
      const nextJob = update(current, this.#timestampAfter(current.updatedAtUnixMs));
      this.#commit(nextJob);
      return publicView(nextJob);
    });
  }

  #requiredScopedJob(jobId: string, scope: ScopeDigests): StoredJob {
    const current = this.#getJob(jobId);
    if (current === undefined || !scopeMatches(current, scope)) {
      throw new DirectJobStateError("Direct job was not found in this owner work session");
    }
    return current;
  }

  #getJob(jobId: string): StoredJob | undefined {
    return this.#database?.get(jobId) ?? this.#jobs.get(jobId);
  }

  #assertResultSize(result: CallToolResult): void {
    if (this.#configuration.maxResultBytes === undefined) return;
    const bytes = Buffer.byteLength(canonicalJson(result), "utf8");
    if (bytes > this.#configuration.maxResultBytes) {
      throw new RangeError(
        `Direct job result exceeds the ${String(this.#configuration.maxResultBytes)} byte limit`,
      );
    }
  }

  #prunedForInsert(): Map<string, StoredJob> {
    if (this.#configuration.maxJobs === undefined) return new Map(this.#jobs);
    if (this.#jobs.size < this.#configuration.maxJobs) return new Map(this.#jobs);
    const terminal = [...this.#jobs.values()]
      .filter((job) => isTerminal(job.status))
      .sort(compareJobsOldestFirst);
    if (terminal.length === 0) {
      throw new DirectJobStateError("Direct job capacity is exhausted by active jobs");
    }
    const next = new Map(this.#jobs);
    const removeCount = this.#jobs.size - this.#configuration.maxJobs + 1;
    for (const job of terminal.slice(0, removeCount)) next.delete(job.jobId);
    if (next.size >= this.#configuration.maxJobs) {
      throw new DirectJobStateError("Direct job capacity is exhausted by active jobs");
    }
    return next;
  }

  async #recoverAfterRestart(): Promise<void> {
    await this.#serialized(async () => {
      const timestamp = checkedTimestamp(this.#configuration.nowUnixMs());
      // Recovery queries only active rows; startup integrity scanning is separate.
      if (this.#database !== undefined) {
        let current = this.#database.firstActive();
        let changed = false;
        while (current !== undefined) {
          this.#database.replace(recoveredJob(current, timestamp));
          changed = true;
          current = this.#database.firstActive();
        }
        if (changed) this.#database.advanceRevision(0);
      } else {
        for (const [id, job] of this.#jobs) {
          if (!isTerminal(job.status)) this.#jobs.set(id, recoveredJob(job, timestamp));
        }
      }
    });
  }

  #timestampAfter(previous: number): number {
    return Math.max(previous, checkedTimestamp(this.#configuration.nowUnixMs()));
  }

  #commit(job: StoredJob, insert = false): void {
    if (this.#database !== undefined) {
      this.#database.commitJob(job, insert, this.#configuration.maxJobs);
      return;
    }
    const revision = this.#nextRevision();
    if (insert) this.#jobs = this.#prunedForInsert();
    this.#jobs.set(job.jobId, job);
    this.#revision = revision;
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const scheduled = this.#tail.then(async () => {
      this.#database?.begin();
      try {
        const result = await operation();
        this.#database?.commit();
        return result;
      } catch (error) {
        this.#database?.rollback();
        throw error;
      }
    });
    this.#tail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }

  #nextRevision(): number {
    const revision = this.#revision + 1;
    if (!Number.isSafeInteger(revision)) {
      throw new DirectJobSnapshotError("Direct job revision space is exhausted");
    }
    return revision;
  }
}

/** Per-row checksums cover payloads and are checked against every indexed projection. */
class SqliteJobLedger {
  readonly #statements = new Map<string, StatementSync>();
  #metadata: LedgerMetadata | undefined;
  #authoritative = false;

  private constructor(
    readonly database: DatabaseSync,
    readonly maxResultBytes: number | undefined,
  ) {}

  static async open(
    configuration: DirectJobConfiguration & { readonly snapshotPath: string },
  ): Promise<SqliteJobLedger> {
    const path = `${configuration.snapshotPath}.sqlite`;
    let ledger: SqliteJobLedger | undefined;
    try {
      await mkdir(dirname(path), { recursive: true });
      const state = await prepareDirectJobMigration(configuration.snapshotPath);
      // A committed witness forbids SQLite's create-if-missing behavior, including zero-length files.
      if (state.committed !== undefined && (await stat(path)).size === 0) {
        throw new DirectJobSnapshotError("Authoritative direct job SQLite database is empty");
      }
      // r+ must succeed for a committed ledger; never recreate a missing authoritative database.
      const handle = await open(path, state.committed === undefined ? "a" : "r+", 0o600);
      await handle.close();
      const database = new DatabaseSync(path);
      ledger = new SqliteJobLedger(database, configuration.maxResultBytes);
      database.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA cache_size = -4096;
        PRAGMA temp_store = FILE;
      `);
      database.exec("BEGIN IMMEDIATE");
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      if (tables.length === 0) {
        if (state.committed !== undefined) {
          throw new DirectJobSnapshotError("Authoritative direct job SQLite schema is missing");
        }
        await assertDirectJobMigrationSource(configuration.snapshotPath, state);
        database.exec(`
          CREATE TABLE direct_job_meta (
            id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL, checksum TEXT NOT NULL
          );
          CREATE TABLE direct_job_migration (
            id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL, checksum TEXT NOT NULL
          );
          CREATE TABLE direct_jobs (
            job_id TEXT PRIMARY KEY, owner_digest TEXT NOT NULL,
            conversation_digest TEXT NOT NULL, work_session_digest TEXT NOT NULL,
            status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            payload TEXT NOT NULL, checksum TEXT NOT NULL
          ) STRICT;
          CREATE INDEX direct_jobs_scope ON direct_jobs
            (owner_digest, conversation_digest, work_session_digest, created_at DESC, job_id DESC);
          CREATE INDEX direct_jobs_scope_status ON direct_jobs
            (owner_digest, conversation_digest, work_session_digest, status, created_at DESC, job_id DESC);
          CREATE INDEX direct_jobs_active ON direct_jobs(job_id)
            WHERE status IN ('queued', 'running');
          CREATE INDEX direct_jobs_terminal ON direct_jobs(updated_at, job_id)
            WHERE status IN ('succeeded', 'failed', 'outcome_unknown', 'cancelled');
        `);
        await ledger.#migrate(configuration.snapshotPath);
        await assertDirectJobMigrationSource(configuration.snapshotPath, state);
        const metadata = ledger.#metadata;
        if (metadata === undefined)
          throw new DirectJobSnapshotError("Migration metadata is missing");
        const bootstrap: MigrationBootstrap = {
          schemaVersion: 1,
          pendingChecksum: state.pendingChecksum,
          initialRevision: metadata.revision,
          initialJobCount: metadata.jobCount,
          legacyChecksum: metadata.legacyChecksum,
        };
        const payload = canonicalJson(bootstrap);
        database
          .prepare("INSERT INTO direct_job_migration VALUES (1, ?, ?)")
          .run(payload, digestText(payload));
      } else {
        const check = database.prepare("PRAGMA quick_check").all();
        if (check.length !== 1 || Object.values(check[0] ?? {})[0] !== "ok") {
          throw new DirectJobSnapshotError("Direct job SQLite integrity check failed");
        }
        ledger.#metadata = ledger.#readMetadata();
        let count = 0;
        // Startup verifies ALL results, but never retains the entire ledger in JS memory.
        for (const row of database.prepare("SELECT * FROM direct_jobs").iterate()) {
          ledger.#decode(row);
          count += 1;
        }
        if (count !== ledger.#metadata.jobCount) {
          throw new DirectJobSnapshotError("Direct job SQLite job count does not match");
        }
      }
      database.exec("COMMIT");
      // Publication is serialized by SQLite's writer lock, after the import COMMIT.
      // No recovery fencing or public operation can run until the witness append is synced.
      database.exec("BEGIN IMMEDIATE");
      const bootstrap = ledger.#readBootstrap(state);
      ledger.#metadata = ledger.#readMetadata();
      if (
        ledger.#metadata.revision < bootstrap.initialRevision ||
        ledger.#metadata.legacyChecksum !== bootstrap.legacyChecksum
      ) {
        throw new DirectJobSnapshotError(
          "Direct job metadata does not match the migration baseline",
        );
      }
      if (
        state.committed === undefined &&
        (ledger.#metadata.revision !== bootstrap.initialRevision ||
          ledger.#metadata.jobCount !== bootstrap.initialJobCount ||
          ledger.#metadata.legacyChecksum !== bootstrap.legacyChecksum)
      ) {
        throw new DirectJobSnapshotError(
          "Pending direct job migration contains post-migration writes",
        );
      }
      await commitDirectJobMigration(configuration.snapshotPath, state, digestJson(bootstrap));
      database.exec("COMMIT");
      ledger.#authoritative = true;
      return ledger;
    } catch (error) {
      ledger?.rollback();
      ledger?.database.close();
      // Never fall back to legacy JSON when a committed SQLite ledger is invalid.
      if (error instanceof DirectJobSnapshotError) throw error;
      throw new DirectJobSnapshotError(
        `Direct job SQLite open/migration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #migrate(path: string): Promise<void> {
    let before: Awaited<ReturnType<typeof stat>>;
    try {
      before = await stat(path);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      this.#writeMetadata({ schemaVersion: 1, revision: 0, jobCount: 0, legacyChecksum: null });
      return;
    }
    const migrated = await readLegacyDirectJobs(path, (value, index) => {
      const job = validateStoredJob(value, index, this.maxResultBytes);
      const payload = canonicalJson(job);
      this.#insert(job, payload);
      return payload;
    });
    const after = await stat(path);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    ) {
      throw new DirectJobSnapshotError("Direct job legacy source changed during migration");
    }
    // Schema, every row and the bootstrap seal commit together; the external witness follows.
    this.#writeMetadata({
      schemaVersion: 1,
      revision: migrated.revision,
      jobCount: migrated.jobCount,
      legacyChecksum: migrated.checksum,
    });
  }

  #readBootstrap(state: DirectJobMigrationState): MigrationBootstrap {
    const rows = this.database.prepare("SELECT * FROM direct_job_migration").all();
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row?.id !== 1 ||
      typeof row.payload !== "string" ||
      digestText(row.payload) !== row.checksum
    ) {
      throw new DirectJobSnapshotError("Direct job migration bootstrap checksum does not match");
    }
    const value: unknown = JSON.parse(row.payload);
    if (!isObject(value))
      throw new DirectJobSnapshotError("Direct job migration bootstrap is invalid");
    assertExactKeys(
      value,
      ["schemaVersion", "pendingChecksum", "initialRevision", "initialJobCount", "legacyChecksum"],
      "bootstrap",
    );
    if (
      value.schemaVersion !== 1 ||
      value.pendingChecksum !== state.pendingChecksum ||
      !Number.isSafeInteger(value.initialRevision) ||
      (value.initialRevision as number) < 0 ||
      !Number.isSafeInteger(value.initialJobCount) ||
      (value.initialJobCount as number) < 0 ||
      (state.pending.source === null
        ? value.legacyChecksum !== null
        : typeof value.legacyChecksum !== "string" ||
          !/^[a-f0-9]{64}$/u.test(value.legacyChecksum)) ||
      (state.committed !== undefined && digestJson(value) !== state.committed.bootstrapChecksum)
    ) {
      throw new DirectJobSnapshotError(
        "Direct job migration bootstrap does not match external state",
      );
    }
    return value as unknown as MigrationBootstrap;
  }

  #statement(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.database.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  begin(): void {
    if (!this.#authoritative)
      throw new DirectJobSnapshotError("Direct job authority is not durable");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.#metadata = this.#readMetadata();
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  commit(): void {
    this.database.exec("COMMIT");
  }

  rollback(): void {
    if (this.database.isTransaction) this.database.exec("ROLLBACK");
    this.#metadata = undefined;
  }

  close(): void {
    this.database.close();
  }

  #readMetadata(): LedgerMetadata {
    const rows = this.#statement("SELECT * FROM direct_job_meta").all();
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row?.id !== 1 ||
      typeof row.payload !== "string" ||
      digestText(row.payload) !== row.checksum
    ) {
      throw new DirectJobSnapshotError("Direct job SQLite metadata checksum does not match");
    }
    const value: unknown = JSON.parse(row.payload);
    if (!isObject(value)) throw new DirectJobSnapshotError("Direct job SQLite metadata is invalid");
    assertExactKeys(value, ["schemaVersion", "revision", "jobCount", "legacyChecksum"], "metadata");
    if (
      value.schemaVersion !== 1 ||
      !Number.isSafeInteger(value.revision) ||
      (value.revision as number) < 0 ||
      !Number.isSafeInteger(value.jobCount) ||
      (value.jobCount as number) < 0 ||
      (value.legacyChecksum !== null &&
        (typeof value.legacyChecksum !== "string" || !/^[a-f0-9]{64}$/u.test(value.legacyChecksum)))
    ) {
      throw new DirectJobSnapshotError("Direct job SQLite metadata is invalid");
    }
    return value as unknown as LedgerMetadata;
  }

  #writeMetadata(metadata: LedgerMetadata): void {
    const payload = canonicalJson(metadata);
    this.#statement(`INSERT INTO direct_job_meta VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, checksum = excluded.checksum`).run(
      payload,
      digestText(payload),
    );
    this.#metadata = metadata;
  }

  advanceRevision(countDelta: number): void {
    const current = this.#metadata;
    if (current === undefined || !Number.isSafeInteger(current.revision + 1)) {
      throw new DirectJobSnapshotError("Direct job revision space is exhausted");
    }
    this.#writeMetadata({
      ...current,
      revision: current.revision + 1,
      jobCount: current.jobCount + countDelta,
    });
  }

  #decode(row: Record<string, unknown>): StoredJob {
    if (typeof row.payload !== "string" || digestText(row.payload) !== row.checksum) {
      throw new DirectJobSnapshotError("Direct job SQLite row checksum does not match");
    }
    const job = validateStoredJob(JSON.parse(row.payload) as unknown, 0, this.maxResultBytes);
    if (
      row.job_id !== job.jobId ||
      row.owner_digest !== job.ownerDigest ||
      row.conversation_digest !== job.conversationDigest ||
      row.work_session_digest !== job.workSessionDigest ||
      row.status !== job.status ||
      row.created_at !== job.createdAtUnixMs ||
      row.updated_at !== job.updatedAtUnixMs
    ) {
      throw new DirectJobSnapshotError(
        "Direct job SQLite indexed fields do not match the checksum payload",
      );
    }
    return job;
  }

  get(jobId: string): StoredJob | undefined {
    const row = this.#statement("SELECT * FROM direct_jobs WHERE job_id = ?").get(jobId);
    return row === undefined ? undefined : this.#decode(row);
  }

  firstActive(): StoredJob | undefined {
    const row = this.#statement(
      "SELECT * FROM direct_jobs WHERE status IN ('queued', 'running') ORDER BY job_id LIMIT 1",
    ).get();
    return row === undefined ? undefined : this.#decode(row);
  }

  #insert(job: StoredJob, payload = canonicalJson(job)): void {
    this.#statement("INSERT INTO direct_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      job.jobId,
      job.ownerDigest,
      job.conversationDigest,
      job.workSessionDigest,
      job.status,
      job.createdAtUnixMs,
      job.updatedAtUnixMs,
      payload,
      digestText(payload),
    );
  }

  replace(job: StoredJob): void {
    const payload = canonicalJson(job);
    const result = this.#statement(`UPDATE direct_jobs SET status = ?, updated_at = ?,
      payload = ?, checksum = ? WHERE job_id = ?`).run(
      job.status,
      job.updatedAtUnixMs,
      payload,
      digestText(payload),
      job.jobId,
    );
    if (result.changes !== 1)
      throw new DirectJobSnapshotError("Direct job disappeared during update");
  }

  commitJob(job: StoredJob, insert: boolean, maxJobs: number | undefined): void {
    let removed = 0;
    if (insert) {
      const count = this.#metadata?.jobCount ?? 0;
      while (maxJobs !== undefined && count - removed >= maxJobs) {
        const row = this.#statement(`SELECT * FROM direct_jobs
          WHERE status IN ('succeeded', 'failed', 'outcome_unknown', 'cancelled')
          ORDER BY updated_at, job_id LIMIT 1`).get();
        if (row === undefined) {
          throw new DirectJobStateError("Direct job capacity is exhausted by active jobs");
        }
        const oldest = this.#decode(row);
        this.#statement("DELETE FROM direct_jobs WHERE job_id = ?").run(oldest.jobId);
        removed += 1;
      }
      this.#insert(job);
    } else {
      this.replace(job);
    }
    this.advanceRevision((insert ? 1 : 0) - removed);
  }

  list(input: DirectJobListInput, scope: ScopeDigests): DirectJobListView {
    const conditions = ["owner_digest = ?", "conversation_digest = ?", "work_session_digest = ?"];
    const parameters: SQLInputValue[] = [
      scope.ownerDigest,
      scope.conversationDigest,
      scope.workSessionDigest,
    ];
    if (input.statuses !== undefined) {
      conditions.push(
        input.statuses.length === 0
          ? "0"
          : `status IN (${input.statuses.map(() => "?").join(",")})`,
      );
      parameters.push(...input.statuses);
    }
    if (input.cursor !== undefined) {
      const cursor = parseListCursor(input.cursor);
      const anchor = this.get(cursor.jobId);
      if (
        anchor === undefined ||
        !scopeMatches(anchor, scope) ||
        anchor.createdAtUnixMs !== cursor.createdAtUnixMs ||
        (input.statuses !== undefined && !input.statuses.includes(anchor.status))
      ) {
        throw new TypeError("Direct job list cursor is stale or outside this scope");
      }
      // Fixed lowercase UUIDs have the same binary and en locale ordering.
      conditions.push("(created_at, job_id) < (?, ?)");
      parameters.push(cursor.createdAtUnixMs, cursor.jobId);
    }
    let sql = `SELECT * FROM direct_jobs WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC, job_id DESC`;
    if (input.limit !== undefined) {
      sql += " LIMIT ?";
      parameters.push(Math.min(input.limit + 1, Number.MAX_SAFE_INTEGER));
    }
    const jobs: DirectJobView[] = [];
    let last: StoredJob | undefined;
    for (const row of this.#statement(sql).iterate(...parameters)) {
      if (input.limit !== undefined && jobs.length === input.limit && last !== undefined) {
        return { jobs, nextCursor: listCursor(last) };
      }
      last = this.#decode(row);
      jobs.push(publicView(last));
    }
    return { jobs };
  }
}

function recoveredJob(job: StoredJob, timestamp: number): StoredJob {
  const queued = job.status === "queued";
  return terminalJob(
    job,
    queued ? "cancelled" : "outcome_unknown",
    Math.max(timestamp, job.updatedAtUnixMs),
    {
      error: {
        code: queued ? RESTART_BEFORE_DISPATCH : RESTART_AFTER_DISPATCH,
        message: queued
          ? "Daemon restarted before native dispatch began; the job is safe to resubmit"
          : "Daemon restarted after native dispatch began; the job was not replayed",
      },
    },
  );
}

interface ScopeDigests {
  readonly ownerDigest: string;
  readonly conversationDigest: string;
  readonly workSessionDigest: string;
}

function scopeDigests(scope: DirectJobScope): ScopeDigests {
  return {
    ownerDigest: digestText(`owner\0${scope.authorizationBinding}`),
    conversationDigest: digestText(`conversation\0${scope.conversationId}`),
    workSessionDigest: digestText(`work-session\0${scope.workSessionId}`),
  };
}

function directJobRecordDigest(scope: ScopeDigests, idempotencyDigest: string): string {
  return digestJson({ contract: "omnicodex-direct-job-id-v1", ...scope, idempotencyDigest });
}

function scopeMatches(job: StoredJob, scope: ScopeDigests): boolean {
  return (
    job.ownerDigest === scope.ownerDigest &&
    job.conversationDigest === scope.conversationDigest &&
    job.workSessionDigest === scope.workSessionDigest
  );
}

function assertScope(job: StoredJob, scope: ScopeDigests): void {
  if (!scopeMatches(job, scope)) throw new DirectJobConflictError();
}

function publicView(job: StoredJob): DirectJobView {
  return {
    jobId: job.jobId,
    operationId: job.operationId,
    status: job.status,
    toolName: job.toolName,
    createdAtUnixMs: job.createdAtUnixMs,
    updatedAtUnixMs: job.updatedAtUnixMs,
    ...(job.startedAtUnixMs === undefined ? {} : { startedAtUnixMs: job.startedAtUnixMs }),
    ...(job.finishedAtUnixMs === undefined ? {} : { finishedAtUnixMs: job.finishedAtUnixMs }),
    ...(job.cancelRequestedAtUnixMs === undefined
      ? {}
      : { cancelRequestedAtUnixMs: job.cancelRequestedAtUnixMs }),
    ...(job.result === undefined ? {} : { result: cloneResult(job.result) }),
    ...(job.error === undefined ? {} : { error: cloneError(job.error) }),
  };
}

function terminalJob(
  current: StoredJob,
  status: Extract<DirectJobStatus, "succeeded" | "failed" | "outcome_unknown" | "cancelled">,
  timestamp: number,
  terminal: { readonly result?: CallToolResult; readonly error?: DirectJobErrorView },
): StoredJob {
  return {
    ...current,
    status,
    updatedAtUnixMs: timestamp,
    finishedAtUnixMs: timestamp,
    ...(terminal.result === undefined ? {} : { result: terminal.result }),
    ...(terminal.error === undefined ? {} : { error: terminal.error }),
  };
}

function isTerminal(status: DirectJobStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "outcome_unknown" ||
    status === "cancelled"
  );
}

function compareJobsNewestFirst(left: StoredJob, right: StoredJob): number {
  return (
    right.createdAtUnixMs - left.createdAtUnixMs || right.jobId.localeCompare(left.jobId, "en")
  );
}

function compareJobsOldestFirst(left: StoredJob, right: StoredJob): number {
  return (
    left.updatedAtUnixMs - right.updatedAtUnixMs || left.jobId.localeCompare(right.jobId, "en")
  );
}

function listCursor(job: StoredJob): string {
  return Buffer.from(
    canonicalJson({ createdAtUnixMs: job.createdAtUnixMs, jobId: job.jobId }),
    "utf8",
  ).toString("base64url");
}

function parseListCursor(cursor: string): { createdAtUnixMs: number; jobId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("Direct job list cursor is invalid");
  }
  if (!isObject(parsed) || !Number.isSafeInteger(parsed.createdAtUnixMs)) {
    throw new TypeError("Direct job list cursor is invalid");
  }
  const jobId = requiredIdentifier(parsed.jobId, "cursor.jobId", 128);
  return { createdAtUnixMs: parsed.createdAtUnixMs as number, jobId };
}

function listStart(jobs: readonly StoredJob[], cursor: string): number {
  const parsed = parseListCursor(cursor);
  const index = jobs.findIndex(
    (job) => job.createdAtUnixMs === parsed.createdAtUnixMs && job.jobId === parsed.jobId,
  );
  if (index < 0) throw new TypeError("Direct job list cursor is stale or outside this scope");
  return index + 1;
}

function validateStartInput(input: DirectJobStartInput): DirectJobStartInput {
  const scope = validateScope(input);
  const toolName = requiredToolName(input.toolName);
  const idempotencyKey = requiredIdentifier(input.idempotencyKey, "idempotencyKey", 128, 16);
  const argumentsValue = cloneObject(input.arguments, "arguments");
  return {
    ...scope,
    idempotencyKey,
    toolName,
    arguments: argumentsValue,
    ...(input.targetContract === undefined
      ? {}
      : { targetContract: validateDirectJobTargetContract(input.targetContract) }),
  };
}

export function validateDirectJobTargetContract(value: unknown): DirectJobTargetContract {
  if (!isObject(value)) throw new TypeError("Direct job target contract must be an object");
  assertRuntimeExactKeys(
    value,
    ["catalogRevision", "targetIdentity", "targetContractDigest", "modelEffect"],
    "Direct job target contract",
  );
  const catalogRevision = requiredSha256(value.catalogRevision, "catalogRevision");
  const targetContractDigest = requiredSha256(value.targetContractDigest, "targetContractDigest");
  const targetIdentity = requiredInternalBinding(value.targetIdentity, "targetIdentity", 4_096);
  if (
    value.modelEffect !== "none" &&
    value.modelEffect !== "model" &&
    value.modelEffect !== "unknown"
  ) {
    throw new TypeError("Direct job target contract has an invalid modelEffect");
  }
  return { catalogRevision, targetIdentity, targetContractDigest, modelEffect: value.modelEffect };
}

function validateAccessInput(input: DirectJobAccessInput): DirectJobAccessInput {
  return { ...validateScope(input), jobId: requiredIdentifier(input.jobId, "jobId", 128) };
}

function validateListInput(input: DirectJobListInput): DirectJobListInput {
  const scope = validateScope(input);
  const statuses = input.statuses?.map((status) => validateStatus(status));
  const uniqueStatuses = statuses === undefined ? undefined : [...new Set(statuses)];
  const limit = input.limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new TypeError("limit must be a positive safe integer");
  }
  const cursor =
    input.cursor === undefined ? undefined : requiredOpaque(input.cursor, "cursor", 1_024);
  return {
    ...scope,
    ...(uniqueStatuses === undefined ? {} : { statuses: uniqueStatuses }),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function validateScope(scope: DirectJobScope): DirectJobScope {
  return {
    authorizationBinding: requiredInternalBinding(
      scope.authorizationBinding,
      "authorizationBinding",
      4_096,
    ),
    conversationId: requiredOpaque(scope.conversationId, "conversationId", 512),
    workSessionId: requiredOpaque(scope.workSessionId, "workSessionId", 512),
  };
}

function validateStatus(status: unknown): DirectJobStatus {
  if (
    status !== "queued" &&
    status !== "running" &&
    status !== "succeeded" &&
    status !== "failed" &&
    status !== "outcome_unknown" &&
    status !== "cancelled"
  ) {
    throw new TypeError("Direct job status is invalid");
  }
  return status;
}

function validateError(error: DirectJobErrorView): DirectJobErrorView {
  const cloned = cloneError(error);
  const code = requiredOpaque(cloned.code, "error.code", 128);
  if (!/^[A-Z][A-Z0-9_:-]*$/u.test(code)) throw new TypeError("Direct job error code is invalid");
  if (typeof cloned.message !== "string" || cloned.message.length < 1) {
    throw new TypeError("error.message must be a non-empty string");
  }
  return { ...cloned, code, message: cloned.message };
}

function requiredToolName(value: unknown): string {
  const name = requiredOpaque(value, "toolName", 512);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u.test(name)) {
    throw new TypeError("toolName must be an exact first-class MCP tool name");
  }
  return name;
}

function requiredIdentifier(value: unknown, name: string, maximum: number, minimum = 1): string {
  const text = requiredOpaque(value, name, maximum);
  if (text.length < minimum || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(text)) {
    throw new TypeError(`${name} must be a stable identifier`);
  }
  return text;
}

function requiredOpaque(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`${name} must contain between 1 and ${String(maximum)} safe characters`);
  }
  return value;
}

/**
 * Gateway authorization bindings are internal values with deliberate NUL
 * field separators. Direct-job state persists only the keyed digest, never
 * this raw binding, so validate its bounds without rejecting that separator.
 */
function requiredInternalBinding(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\r\n]/u.test(value)
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function requiredSha256(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${name} must be a SHA-256 digest`);
  }
  return value;
}

function assertRuntimeExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  if (
    Object.keys(value).length !== allowedSet.size ||
    Object.keys(value).some((key) => !allowedSet.has(key))
  ) {
    throw new TypeError(`${label} has invalid fields`);
  }
}

function cloneObject(value: unknown, name: string): Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const cloned = cloneJson(value);
  if (!isObject(cloned) || Array.isArray(cloned)) throw new TypeError(`${name} must be an object`);
  return cloned;
}

function cloneResult(result: CallToolResult): CallToolResult {
  const cloned = cloneJson(result);
  if (!isObject(cloned) || !Array.isArray(cloned.content)) {
    throw new TypeError("Direct job result must be a valid MCP CallToolResult");
  }
  return cloned as unknown as CallToolResult;
}

function cloneError(error: DirectJobErrorView): DirectJobErrorView {
  const cloned = cloneJson(error);
  if (!isObject(cloned) || Array.isArray(cloned)) {
    throw new TypeError("Direct job error must be a JSON object");
  }
  return cloned as DirectJobErrorView;
}

function cloneJson<T>(value: T): T {
  assertJsonValue(value, new Set<object>(), "$value");
  return JSON.parse(canonicalJson(value)) as T;
}

function assertJsonValue(value: unknown, ancestors: Set<object>, path: string): void {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${path} is not a JSON value`);
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError(`${path} contains a sparse array`);
        assertJsonValue(value[index], ancestors, `${path}[${String(index)}]`);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new TypeError(`${path} contains a symbol key`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(`${path}.${key} is not a plain JSON field`);
      }
      assertJsonValue(descriptor.value, ancestors, `${path}.${key}`);
    }
  } finally {
    ancestors.delete(value);
  }
}

function durableConfiguration(
  options: DirectJobStoreOptions,
): DirectJobConfiguration & { readonly snapshotPath: string } {
  const dataDirectory = resolve(options.dataDirectory ?? omniCodexDataDirectory());
  return {
    kind: "durable",
    snapshotPath: resolve(
      options.snapshotPath ?? join(dataDirectory, "state", "direct-job-store.json"),
    ),
    maxJobs: validatedOptionalBound(options.maxJobs, "maxJobs"),
    maxResultBytes: validatedOptionalBound(options.maxResultBytes, "maxResultBytes"),
    nowUnixMs: options.nowUnixMs ?? Date.now,
    randomUUID: options.randomUUID ?? randomUUID,
  };
}

function memoryConfiguration(options: InMemoryDirectJobStoreOptions): DirectJobConfiguration {
  return {
    kind: "memory",
    maxJobs: validatedOptionalBound(options.maxJobs, "maxJobs"),
    maxResultBytes: validatedOptionalBound(options.maxResultBytes, "maxResultBytes"),
    nowUnixMs: options.nowUnixMs ?? Date.now,
    randomUUID: options.randomUUID ?? randomUUID,
  };
}

function validatedOptionalBound(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function assertSameConfiguration(
  current: DirectJobConfiguration,
  requested: DirectJobConfiguration,
): void {
  if (
    current.maxJobs !== requested.maxJobs ||
    current.maxResultBytes !== requested.maxResultBytes ||
    current.nowUnixMs !== requested.nowUnixMs ||
    current.randomUUID !== requested.randomUUID
  ) {
    throw new Error("Direct job store is already open with different process-wide options");
  }
}

function checkedTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DirectJobStateError("Direct job clock returned an invalid timestamp");
  }
  return value;
}

function publicId(hexDigest: string, version: 4 | 5): string {
  const bytes = Buffer.from(hexDigest.slice(0, 32), "hex");
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error("Direct job digest is invalid");
  }
  bytes[6] = (versionByte & 0x0f) | (version << 4);
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function processPathKey(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function processCoreRegistry(): Map<string, CoreRegistryEntry> {
  const scope = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = scope[PROCESS_CORES_SYMBOL];
  if (existing !== undefined) {
    if (!(existing instanceof Map)) throw new Error("Global direct job registry is incompatible");
    return existing as Map<string, CoreRegistryEntry>;
  }
  const registry = new Map<string, CoreRegistryEntry>();
  Object.defineProperty(scope, PROCESS_CORES_SYMBOL, {
    value: registry,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return registry;
}

function validateStoredJob(
  value: unknown,
  index: number,
  maxResultBytes: number | undefined,
): StoredJob {
  if (!isObject(value)) throw new DirectJobSnapshotError(`jobs[${String(index)}] is invalid`);
  const required = [
    "jobId",
    "operationId",
    "ownerDigest",
    "conversationDigest",
    "workSessionDigest",
    "idempotencyDigest",
    "fingerprintDigest",
    "status",
    "toolName",
    "createdAtUnixMs",
    "updatedAtUnixMs",
  ];
  const optional = [
    "targetContract",
    "startedAtUnixMs",
    "finishedAtUnixMs",
    "cancelRequestedAtUnixMs",
    "result",
    "error",
  ];
  assertExactKeys(value, [...required, ...optional], `jobs[${String(index)}]`, required);
  const status = validateStatus(value.status);
  const createdAtUnixMs = snapshotTimestamp(value.createdAtUnixMs, "createdAtUnixMs");
  const updatedAtUnixMs = snapshotTimestamp(value.updatedAtUnixMs, "updatedAtUnixMs");
  const startedAtUnixMs = optionalSnapshotTimestamp(value.startedAtUnixMs, "startedAtUnixMs");
  const finishedAtUnixMs = optionalSnapshotTimestamp(value.finishedAtUnixMs, "finishedAtUnixMs");
  const cancelRequestedAtUnixMs = optionalSnapshotTimestamp(
    value.cancelRequestedAtUnixMs,
    "cancelRequestedAtUnixMs",
  );
  if (updatedAtUnixMs < createdAtUnixMs) {
    throw new DirectJobSnapshotError("Direct job timestamps are out of order");
  }
  if (
    (status === "running" || status === "succeeded" || status === "outcome_unknown") &&
    startedAtUnixMs === undefined
  ) {
    throw new DirectJobSnapshotError("Dispatched direct job is missing startedAtUnixMs");
  }
  if (status === "queued" && startedAtUnixMs !== undefined) {
    throw new DirectJobSnapshotError("Queued direct job cannot have a dispatch timestamp");
  }
  if (isTerminal(status) !== (finishedAtUnixMs !== undefined)) {
    throw new DirectJobSnapshotError("Direct job terminal timestamp does not match status");
  }
  const result =
    value.result === undefined ? undefined : cloneResult(value.result as CallToolResult);
  if (
    result !== undefined &&
    maxResultBytes !== undefined &&
    Buffer.byteLength(canonicalJson(result), "utf8") > maxResultBytes
  ) {
    throw new DirectJobSnapshotError("Direct job result exceeds the configured limit");
  }
  const error = value.error === undefined ? undefined : validateSnapshotError(value.error);
  let targetContract: DirectJobTargetContract | undefined;
  try {
    targetContract =
      value.targetContract === undefined
        ? undefined
        : validateDirectJobTargetContract(value.targetContract);
  } catch (error) {
    throw new DirectJobSnapshotError(
      `Direct job target contract is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const digestFields = [
    value.ownerDigest,
    value.conversationDigest,
    value.workSessionDigest,
    value.idempotencyDigest,
    value.fingerprintDigest,
  ];
  if (digestFields.some((field) => typeof field !== "string" || !/^[a-f0-9]{64}$/u.test(field))) {
    throw new DirectJobSnapshotError("Direct job identity digest is invalid");
  }
  return {
    jobId: snapshotUuid(value.jobId, "jobId"),
    operationId: snapshotUuid(value.operationId, "operationId"),
    ownerDigest: value.ownerDigest as string,
    conversationDigest: value.conversationDigest as string,
    workSessionDigest: value.workSessionDigest as string,
    idempotencyDigest: value.idempotencyDigest as string,
    fingerprintDigest: value.fingerprintDigest as string,
    status,
    toolName: requiredToolName(value.toolName),
    ...(targetContract === undefined ? {} : { targetContract }),
    createdAtUnixMs,
    updatedAtUnixMs,
    ...(startedAtUnixMs === undefined ? {} : { startedAtUnixMs }),
    ...(finishedAtUnixMs === undefined ? {} : { finishedAtUnixMs }),
    ...(cancelRequestedAtUnixMs === undefined ? {} : { cancelRequestedAtUnixMs }),
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
  };
}

function validateSnapshotError(value: unknown): DirectJobErrorView {
  if (!isObject(value)) throw new DirectJobSnapshotError("Direct job error is invalid");
  try {
    return validateError(value as unknown as DirectJobErrorView);
  } catch (error) {
    throw new DirectJobSnapshotError(
      `Direct job error is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function snapshotTimestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DirectJobSnapshotError(`Direct job ${name} is invalid`);
  }
  return value as number;
}

function optionalSnapshotTimestamp(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : snapshotTimestamp(value, name);
}

function snapshotUuid(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[45][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)
  ) {
    throw new DirectJobSnapshotError(`Direct job ${name} is invalid`);
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  required: readonly string[] = allowed,
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new DirectJobSnapshotError(`${label} contains unknown fields`);
  }
  if (required.some((key) => !Object.hasOwn(value, key))) {
    throw new DirectJobSnapshotError(`${label} is missing required fields`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
