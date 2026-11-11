import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { omniCodexDataDirectory } from "../config/omnicodex-config-store.js";
import { canonicalJson } from "../safety/canonical-json.js";

const SCHEMA_VERSION = 1;
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

interface SnapshotPayload {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly revision: number;
  readonly jobs: readonly StoredJob[];
}

interface StoredSnapshot extends SnapshotPayload {
  readonly checksum: string;
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

const PROCESS_CORES_SYMBOL = Symbol.for("@heelee912/omnicodex/direct-job-cores/v1");
const processCores = processCoreRegistry();

/**
 * Owner-, conversation-, and work-session-bound durable ledger for native
 * direct jobs. It stores no native arguments and has no model/thread dispatch
 * capability; execution is supplied by the server-owned direct dispatcher.
 */
export class DirectJobStore {
  readonly #core: DirectJobCore;

  private constructor(core: DirectJobCore) {
    this.#core = core;
  }

  static async open(options: DirectJobStoreOptions = {}): Promise<DirectJobStore> {
    const configuration = durableConfiguration(options);
    const key = processPathKey(configuration.snapshotPath);
    const existing = processCores.get(key);
    if (existing !== undefined) {
      assertSameConfiguration(existing.configuration, configuration);
      return new DirectJobStore(await existing.promise);
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

  private constructor(
    configuration: DirectJobConfiguration,
    revision: number,
    jobs: Map<string, StoredJob>,
  ) {
    this.#configuration = configuration;
    this.#revision = revision;
    this.#jobs = jobs;
  }

  static async open(
    configuration: DirectJobConfiguration & { readonly snapshotPath: string },
  ): Promise<DirectJobCore> {
    const loaded = await loadSnapshot(configuration.snapshotPath, configuration.maxResultBytes);
    const core = new DirectJobCore(configuration, loaded.revision, loaded.jobs);
    await core.#recoverAfterRestart();
    return core;
  }

  static inMemory(configuration: DirectJobConfiguration): DirectJobCore {
    return new DirectJobCore(configuration, 0, new Map());
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
      const current = this.#jobs.get(jobId);
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
      const next = this.#prunedForInsert();
      next.set(jobId, created);
      await this.#commit(next);
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
      const current = this.#jobs.get(jobId);
      if (current === undefined) return undefined;
      assertScope(current, scope);
      if (current.fingerprintDigest !== fingerprintDigest) throw new DirectJobConflictError();
      return { disposition: "existing", job: publicView(current) };
    });
  }

  get(input: DirectJobAccessInput): Promise<DirectJobView | undefined> {
    return this.#serialized(async () => {
      const current = this.#jobs.get(input.jobId);
      if (current === undefined || !scopeMatches(current, scopeDigests(input))) return undefined;
      return publicView(current);
    });
  }

  list(input: DirectJobListInput): Promise<DirectJobListView> {
    return this.#serialized(async () => {
      const scope = scopeDigests(input);
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
      const next = new Map(this.#jobs);
      next.set(current.jobId, nextJob);
      await this.#commit(next);
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
      const next = new Map(this.#jobs);
      next.set(current.jobId, nextJob);
      await this.#commit(next);
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
      const next = new Map(this.#jobs);
      next.set(current.jobId, nextJob);
      await this.#commit(next);
      return publicView(nextJob);
    });
  }

  #requiredScopedJob(jobId: string, scope: ScopeDigests): StoredJob {
    const current = this.#jobs.get(jobId);
    if (current === undefined || !scopeMatches(current, scope)) {
      throw new DirectJobStateError("Direct job was not found in this owner work session");
    }
    return current;
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
    let changed = false;
    const timestamp = checkedTimestamp(this.#configuration.nowUnixMs());
    const next = new Map<string, StoredJob>();
    for (const [jobId, job] of this.#jobs) {
      if (job.status === "queued") {
        changed = true;
        next.set(
          jobId,
          terminalJob(job, "cancelled", Math.max(timestamp, job.updatedAtUnixMs), {
            error: {
              code: RESTART_BEFORE_DISPATCH,
              message: "Daemon restarted before native dispatch began; the job is safe to resubmit",
            },
          }),
        );
      } else if (job.status === "running") {
        changed = true;
        next.set(
          jobId,
          terminalJob(job, "outcome_unknown", Math.max(timestamp, job.updatedAtUnixMs), {
            error: {
              code: RESTART_AFTER_DISPATCH,
              message: "Daemon restarted after native dispatch began; the job was not replayed",
            },
          }),
        );
      } else {
        next.set(jobId, job);
      }
    }
    if (changed) await this.#commit(next);
  }

  #timestampAfter(previous: number): number {
    return Math.max(previous, checkedTimestamp(this.#configuration.nowUnixMs()));
  }

  async #commit(candidate: Map<string, StoredJob>): Promise<void> {
    const revision = this.#nextRevision();
    if (this.#configuration.snapshotPath !== undefined) {
      await writeSnapshot(this.#configuration.snapshotPath, revision, candidate);
    }
    this.#jobs = candidate;
    this.#revision = revision;
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const scheduled = this.#tail.then(operation, operation);
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

function listStart(jobs: readonly StoredJob[], cursor: string): number {
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
  const index = jobs.findIndex(
    (job) => job.createdAtUnixMs === parsed.createdAtUnixMs && job.jobId === jobId,
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

async function loadSnapshot(
  path: string,
  maxResultBytes: number | undefined,
): Promise<{ readonly revision: number; readonly jobs: Map<string, StoredJob> }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { revision: 0, jobs: new Map() };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DirectJobSnapshotError("Direct job snapshot is not valid JSON");
  }
  const snapshot = validateSnapshot(value, maxResultBytes);
  const { checksum: storedChecksum, ...payload } = snapshot;
  if (checksum(payload) !== storedChecksum) {
    throw new DirectJobSnapshotError("Direct job snapshot checksum does not match");
  }
  return {
    revision: snapshot.revision,
    jobs: new Map(snapshot.jobs.map((job) => [job.jobId, job])),
  };
}

function validateSnapshot(value: unknown, maxResultBytes: number | undefined): StoredSnapshot {
  if (!isObject(value)) throw new DirectJobSnapshotError("Direct job snapshot must be an object");
  assertExactKeys(value, ["schemaVersion", "revision", "jobs", "checksum"], "snapshot");
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new DirectJobSnapshotError("Direct job snapshot schema version is unsupported");
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new DirectJobSnapshotError("Direct job snapshot revision is invalid");
  }
  if (!Array.isArray(value.jobs)) {
    throw new DirectJobSnapshotError("Direct job snapshot jobs must be an array");
  }
  const jobs = value.jobs.map((job, index) => validateStoredJob(job, index, maxResultBytes));
  const ids = new Set(jobs.map((job) => job.jobId));
  if (ids.size !== jobs.length) throw new DirectJobSnapshotError("Direct job IDs are duplicated");
  if (typeof value.checksum !== "string" || !/^[a-f0-9]{64}$/u.test(value.checksum)) {
    throw new DirectJobSnapshotError("Direct job snapshot checksum is invalid");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: value.revision as number,
    jobs,
    checksum: value.checksum,
  };
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

async function writeSnapshot(
  path: string,
  revision: number,
  jobs: ReadonlyMap<string, StoredJob>,
): Promise<void> {
  const payload: SnapshotPayload = {
    schemaVersion: SCHEMA_VERSION,
    revision,
    jobs: [...jobs.values()].sort((left, right) => left.jobId.localeCompare(right.jobId, "en")),
  };
  const snapshot: StoredSnapshot = { ...payload, checksum: checksum(payload) };
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(canonicalJson(snapshot), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function checksum(payload: SnapshotPayload): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
