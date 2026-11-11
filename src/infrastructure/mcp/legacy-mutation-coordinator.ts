import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { omniCodexDataDirectory } from "../config/omnicodex-config-store.js";
import { canonicalJson } from "../safety/canonical-json.js";

const SCHEMA_VERSION = 1;
const JOURNAL_SCHEMA_VERSION = 1;
const DEFAULT_JOURNAL_COMPACTION_ENTRIES = 512;
const RESTART_UNKNOWN_CODE = "PROCESS_RESTART_LEGACY_MUTATION_IN_FLIGHT";
const RESULT_REPLAY_EXPIRED_CODE = "LEGACY_MUTATION_RESULT_REPLAY_EXPIRED";

export type LegacyMutationJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly LegacyMutationJsonValue[]
  | { readonly [key: string]: LegacyMutationJsonValue };

export type LegacyMutationRequestId = string | number;

/** Public status projection. Never contains transport identities, arguments or result bodies. */
export interface LegacyMutationStatus {
  readonly operationId: string;
  readonly attemptId: string;
  readonly state: "in_flight" | "completed" | "outcome_unknown" | "result_replay_expired";
  readonly admittedAtUnixMs: number;
  readonly updatedAtUnixMs: number;
  readonly terminalAtUnixMs?: number;
  readonly code?: string;
  readonly completedResultRetained: boolean;
}

export interface LegacyMutationStatusQuery {
  /** Trusted integration value, never selected by a remote tool argument. */
  readonly authorizationBinding: string;
  readonly operationId?: string;
  readonly semanticDigest?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface LegacyMutationStatusPage {
  readonly matches: readonly LegacyMutationStatus[];
  readonly matchCount: number;
  readonly nextCursor: string | null;
}

/**
 * The semantic key must already be a SHA-256 digest computed by the integration
 * boundary. Authorization, session, and request identifiers are hashed before
 * any coordinator state is retained or written.
 */
export interface LegacyMutationRequestContext {
  readonly authorizationBinding: string;
  readonly semanticDigest: string;
  readonly sessionId: string;
  readonly requestId: LegacyMutationRequestId;
  /** Set only by the native-method classifier for operations safe to repeat after an unknown outcome. */
  readonly retrySafeAfterUnknown?: boolean;
}

export interface LegacyMutationCoordinatorOptions {
  readonly dataDirectory?: string;
  readonly snapshotPath?: string;
  /**
   * Lossless delta compaction cadence. This bounds rewrite frequency, not
   * retained mutations or replayable result data.
   */
  readonly journalCompactionEntries?: number;
  readonly maxCompletedResults?: number;
  readonly nowUnixMs?: () => number;
}

export interface InMemoryLegacyMutationCoordinatorOptions {
  readonly maxCompletedResults?: number;
  readonly nowUnixMs?: () => number;
}

export type LegacyMutationTerminal<T extends LegacyMutationJsonValue> =
  | { readonly kind: "completed"; readonly value: T }
  | { readonly kind: "retryable_pre_dispatch_failure"; readonly code: string }
  | { readonly kind: "outcome_unknown"; readonly code: string };

export interface LegacyMutationExecution<T extends LegacyMutationJsonValue> {
  readonly operationId: string;
  readonly attemptId: string;
  readonly completion: Promise<LegacyMutationTerminal<T>>;
  /** Durably publishes an authoritative, losslessly replayable result. */
  finish(value: T): Promise<void>;
  /** Durably prevents automatic replay when dispatch may have happened. */
  outcomeUnknown(code?: string): Promise<void>;
  /** Releases the cohort only when the caller knows dispatch did not happen. */
  failBeforeDispatch(code?: string): Promise<void>;
}

export type LegacyMutationAcquisition<T extends LegacyMutationJsonValue> =
  | {
      readonly kind: "execute";
      readonly operationId: string;
      readonly execution: LegacyMutationExecution<T>;
    }
  | {
      readonly kind: "join";
      readonly operationId: string;
      readonly completion: Promise<LegacyMutationTerminal<T>>;
    }
  | { readonly kind: "replay"; readonly operationId: string; readonly value: T }
  | { readonly kind: "outcome_unknown"; readonly operationId: string; readonly code: string };

export class LegacyMutationAmbiguityError extends Error {
  readonly code = "AMBIGUOUS_LEGACY_MUTATION_COHORT";

  constructor(_code: "AMBIGUOUS_LEGACY_MUTATION_COHORT") {
    super(
      "An unresolved legacy mutation may match this request; recover its operation or retry with its original request identity",
    );
    this.name = "LegacyMutationAmbiguityError";
  }
}

export class LegacyMutationRequestConflictError extends Error {
  readonly code = "LEGACY_MUTATION_REQUEST_CONFLICT";

  constructor() {
    super("The same JSON-RPC session and request ID was used for different mutation semantics");
    this.name = "LegacyMutationRequestConflictError";
  }
}

export class LegacyMutationStateError extends Error {
  readonly code = "LEGACY_MUTATION_INVALID_TRANSITION";

  constructor(message: string) {
    super(message);
    this.name = "LegacyMutationStateError";
  }
}

export class LegacyMutationSnapshotError extends Error {
  readonly code = "LEGACY_MUTATION_SNAPSHOT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "LegacyMutationSnapshotError";
  }
}

interface MemberDigest {
  readonly sessionDigest: string;
  readonly requestDigest: string;
}

interface RecordBase {
  readonly recordId: string;
  readonly authorizationDigest: string;
  readonly semanticDigest: string;
  readonly members: readonly MemberDigest[];
  readonly attemptId: string;
  readonly admittedAtUnixMs: number;
  readonly updatedAtUnixMs: number;
}

interface InFlightRecord extends RecordBase {
  readonly state: "in_flight";
}

interface CompletedRecord extends RecordBase {
  readonly state: "completed";
  readonly terminalAtUnixMs: number;
  readonly value: LegacyMutationJsonValue;
}

interface ResultReplayExpiredRecord extends RecordBase {
  readonly state: "result_replay_expired";
  readonly terminalAtUnixMs: number;
}

interface OutcomeUnknownRecord extends RecordBase {
  readonly state: "outcome_unknown";
  readonly terminalAtUnixMs: number;
  readonly code: string;
}

type StoredRecord =
  | InFlightRecord
  | CompletedRecord
  | ResultReplayExpiredRecord
  | OutcomeUnknownRecord;

interface SnapshotPayload {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly revision: number;
  readonly records: readonly StoredRecord[];
}

interface StoredSnapshot extends SnapshotPayload {
  readonly checksum: string;
}

interface JournalPayload {
  readonly schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  readonly previousRevision: number;
  readonly revision: number;
  readonly recordUpserts: readonly StoredRecord[];
  readonly recordDeletes: readonly string[];
}

interface StoredJournalEntry extends JournalPayload {
  readonly checksum: string;
}

interface RuntimeAttempt {
  readonly attemptId: string;
  readonly completion: Promise<LegacyMutationTerminal<LegacyMutationJsonValue>>;
  readonly resolve: (terminal: LegacyMutationTerminal<LegacyMutationJsonValue>) => void;
}

interface ValidatedRequest {
  readonly authorizationDigest: string;
  readonly semanticDigest: string;
  readonly member: MemberDigest;
  readonly retrySafeAfterUnknown: boolean;
}

interface DurableConfiguration {
  readonly kind: "durable";
  readonly snapshotPath: string;
  readonly journalDirectory: string;
  readonly journalCompactionEntries: number;
  readonly maxCompletedResults: number | undefined;
  readonly nowUnixMs: () => number;
}

interface InMemoryConfiguration {
  readonly kind: "memory";
  readonly maxCompletedResults: number | undefined;
  readonly nowUnixMs: () => number;
}

type CoreConfiguration = DurableConfiguration | InMemoryConfiguration;

interface CoreRegistryEntry {
  readonly configuration: DurableConfiguration;
  readonly promise: Promise<LegacyMutationCoordinatorCore>;
}

const PROCESS_CORES_SYMBOL = Symbol.for(
  "@heelee912/omnicodex/legacy-mutation-coordinator-cores/v1",
);
const processCores = processCoreRegistry();

/**
 * Process-shared, authorization-partitioned fan-out for legacy mutation tools
 * that cannot carry a caller-provided invocation ID.
 *
 * A cohort has no implicit deadline or replay TTL. This class intentionally
 * accepts no AbortSignal, so cancellation of a follower cannot cancel the
 * elected leader; the caller may stop awaiting its own completion independently.
 */
export class LegacyMutationCoordinator {
  readonly #core: LegacyMutationCoordinatorCore;

  private constructor(core: LegacyMutationCoordinatorCore) {
    this.#core = core;
  }

  static async open(
    options: LegacyMutationCoordinatorOptions = {},
  ): Promise<LegacyMutationCoordinator> {
    const configuration = durableConfiguration(options);
    const registryKey = processPathKey(configuration.snapshotPath);
    const existing = processCores.get(registryKey);
    if (existing !== undefined) {
      assertSameConfiguration(existing.configuration, configuration);
      return new LegacyMutationCoordinator(await existing.promise);
    }

    const promise = LegacyMutationCoordinatorCore.open(configuration);
    const entry = { configuration, promise };
    processCores.set(registryKey, entry);
    try {
      return new LegacyMutationCoordinator(await promise);
    } catch (error) {
      if (processCores.get(registryKey) === entry) processCores.delete(registryKey);
      throw error;
    }
  }

  static inMemory(
    options: InMemoryLegacyMutationCoordinatorOptions = {},
  ): LegacyMutationCoordinator {
    return new LegacyMutationCoordinator(
      LegacyMutationCoordinatorCore.inMemory(memoryConfiguration(options)),
    );
  }

  acquire<T extends LegacyMutationJsonValue = LegacyMutationJsonValue>(
    request: LegacyMutationRequestContext,
  ): Promise<LegacyMutationAcquisition<T>> {
    return this.#core.acquire<T>(validateRequest(request));
  }

  /** Observes the already-open coordinator; never acquires, joins, prunes or recovers state. */
  readStatus(query: LegacyMutationStatusQuery): Promise<LegacyMutationStatusPage> {
    return this.#core.readStatus(query);
  }

  /**
   * Losslessly folds durable deltas into the checksummed snapshot. Normal
   * mutation traffic never needs to call this method.
   */
  compact(): Promise<void> {
    return this.#core.compact();
  }

  get snapshotPath(): string | undefined {
    return this.#core.snapshotPath;
  }
}

class LegacyMutationCoordinatorCore {
  readonly #configuration: CoreConfiguration;
  #records: Map<string, StoredRecord>;
  readonly #attempts = new Map<string, RuntimeAttempt>();
  #revision: number;
  #journalEntries: number;
  #hasSnapshot: boolean;
  #tail: Promise<void> = Promise.resolve();

  private constructor(
    configuration: CoreConfiguration,
    revision: number,
    records: Map<string, StoredRecord>,
    journalEntries = 0,
    hasSnapshot = false,
  ) {
    this.#configuration = configuration;
    this.#revision = revision;
    this.#records = records;
    this.#journalEntries = journalEntries;
    this.#hasSnapshot = hasSnapshot;
  }

  static async open(configuration: DurableConfiguration): Promise<LegacyMutationCoordinatorCore> {
    const loaded = await loadState(configuration);
    const core = new LegacyMutationCoordinatorCore(
      configuration,
      loaded.revision,
      loaded.records,
      loaded.journalEntries,
      loaded.hasSnapshot,
    );
    await core.#recoverAfterRestart();
    return core;
  }

  static inMemory(configuration: InMemoryConfiguration): LegacyMutationCoordinatorCore {
    return new LegacyMutationCoordinatorCore(configuration, 0, new Map());
  }

  get snapshotPath(): string | undefined {
    return this.#configuration.kind === "durable" ? this.#configuration.snapshotPath : undefined;
  }

  readStatus(query: LegacyMutationStatusQuery): Promise<LegacyMutationStatusPage> {
    const { operationId, semanticDigest, cursor } = query;
    if (typeof query.authorizationBinding !== "string" || query.authorizationBinding.length === 0)
      throw new TypeError("LEGACY_STATUS_OWNER_REQUIRED");
    if (operationId === undefined && semanticDigest === undefined)
      throw new TypeError("LEGACY_STATUS_SELECTOR_REQUIRED");
    for (const value of [operationId, cursor]) {
      if (value !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value))
        throw new TypeError("LEGACY_STATUS_OPERATION_ID_INVALID");
    }
    if (semanticDigest !== undefined) validateDigest(semanticDigest, "semanticDigest");
    const limit = query.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new TypeError("LEGACY_STATUS_LIMIT_INVALID");
    const authorizationDigest = digestFramed("legacy-authorization-v1", [
      query.authorizationBinding,
    ]);
    return this.#serialized(async () => {
      // Filter ownership before selecting an operation or projecting any metadata.
      const matches = [...this.#records.values()]
        .filter(
          (record) =>
            record.authorizationDigest === authorizationDigest &&
            (operationId === undefined || publicOperationId(record.recordId) === operationId) &&
            (semanticDigest === undefined || record.semanticDigest === semanticDigest),
        )
        .map(
          (record): LegacyMutationStatus => ({
            operationId: publicOperationId(record.recordId),
            attemptId: record.attemptId,
            state: record.state,
            admittedAtUnixMs: record.admittedAtUnixMs,
            updatedAtUnixMs: record.updatedAtUnixMs,
            ...(record.state === "in_flight" ? {} : { terminalAtUnixMs: record.terminalAtUnixMs }),
            ...(record.state === "outcome_unknown"
              ? { code: record.code }
              : record.state === "result_replay_expired"
                ? { code: RESULT_REPLAY_EXPIRED_CODE }
                : {}),
            completedResultRetained: record.state === "completed",
          }),
        )
        .sort((left, right) => left.operationId.localeCompare(right.operationId, "en"));
      const remaining = matches.filter(
        (record) => cursor === undefined || record.operationId > cursor,
      );
      const page = remaining.slice(0, limit);
      return {
        matches: page,
        matchCount: matches.length,
        nextCursor: remaining.length > limit ? (page.at(-1)?.operationId ?? null) : null,
      };
    });
  }

  compact(): Promise<void> {
    return this.#serialized(async () => {
      if (this.#configuration.kind !== "durable") return;
      await writeSnapshot(this.#configuration.snapshotPath, this.#revision, this.#records);
      await clearJournalDirectory(this.#configuration.journalDirectory);
      this.#journalEntries = 0;
      this.#hasSnapshot = true;
    });
  }

  acquire<T extends LegacyMutationJsonValue>(
    request: ValidatedRequest,
  ): Promise<LegacyMutationAcquisition<T>> {
    return this.#serialized(async () => {
      const now = checkedTimestamp(this.#configuration.nowUnixMs());
      const authorizationRecords = [...this.#records.values()].filter(
        (record) => record.authorizationDigest === request.authorizationDigest,
      );
      const exact = authorizationRecords.filter((record) =>
        record.members.some((member) => member.requestDigest === request.member.requestDigest),
      );
      if (exact.length > 1) {
        throw new LegacyMutationSnapshotError(
          "A request digest is assigned to more than one legacy mutation cohort",
        );
      }
      const exactRecord = exact[0];
      if (exactRecord !== undefined) {
        if (exactRecord.semanticDigest !== request.semanticDigest) {
          throw new LegacyMutationRequestConflictError();
        }
        return this.#acquisitionFor<T>(exactRecord);
      }

      const semanticRecords = authorizationRecords.filter(
        (record) => record.semanticDigest === request.semanticDigest,
      );

      // A different request ID in any already participating session is an
      // independently intended action, never a transport retry.
      if (
        semanticRecords.some((record) =>
          record.members.some((member) => member.sessionDigest === request.member.sessionDigest),
        )
      ) {
        return this.#createExecution<T>(request, now);
      }

      // Equal arguments do not establish retry identity across MCP connections.
      // In particular a fresh Chrome exec/DOM read must not replay a completed
      // observation. Only the exact transport request above can replay here;
      // explicit invocation identities are handled by the mutation replay store.
      // An unresolved mutation is different: without a stable identity we cannot
      // safely decide whether dispatch would duplicate an outstanding side effect.
      const unresolved = semanticRecords.filter((record) => record.state !== "completed");
      if (
        unresolved.length > 0 &&
        (!request.retrySafeAfterUnknown ||
          unresolved.some((record) => record.state !== "outcome_unknown"))
      ) {
        throw new LegacyMutationAmbiguityError("AMBIGUOUS_LEGACY_MUTATION_COHORT");
      }

      return this.#createExecution<T>(request, now);
    });
  }

  async #createExecution<T extends LegacyMutationJsonValue>(
    request: ValidatedRequest,
    now: number,
  ): Promise<LegacyMutationAcquisition<T>> {
    const recordId = cohortRecordId(
      request.authorizationDigest,
      request.semanticDigest,
      request.member.requestDigest,
    );
    if (this.#records.has(recordId)) {
      throw new LegacyMutationSnapshotError("Legacy mutation cohort digest collision");
    }
    const attemptId = randomUUID();
    const record: InFlightRecord = {
      recordId,
      authorizationDigest: request.authorizationDigest,
      semanticDigest: request.semanticDigest,
      members: [request.member],
      attemptId,
      admittedAtUnixMs: now,
      updatedAtUnixMs: now,
      state: "in_flight",
    };
    const next = new Map(this.#records);
    next.set(recordId, record);
    await this.#commit(next);

    const attempt = deferredAttempt(attemptId);
    this.#attempts.set(recordId, attempt);
    const operationId = publicOperationId(recordId);
    const execution: LegacyMutationExecution<T> = {
      operationId,
      attemptId,
      completion: cloneCompletion<T>(attempt.completion),
      finish: async (value) => this.#finish(recordId, attemptId, value),
      outcomeUnknown: async (code = "LEGACY_MUTATION_OUTCOME_UNKNOWN") =>
        this.#outcomeUnknown(recordId, attemptId, code),
      failBeforeDispatch: async (code = "LEGACY_MUTATION_PRE_DISPATCH_FAILURE") =>
        this.#failBeforeDispatch(recordId, attemptId, code),
    };
    return { kind: "execute", operationId, execution };
  }

  #acquisitionFor<T extends LegacyMutationJsonValue>(
    record: StoredRecord,
  ): LegacyMutationAcquisition<T> {
    const operationId = publicOperationId(record.recordId);
    if (record.state === "completed") {
      return { kind: "replay", operationId, value: cloneJson(record.value) as T };
    }
    if (record.state === "result_replay_expired") {
      return { kind: "outcome_unknown", operationId, code: RESULT_REPLAY_EXPIRED_CODE };
    }
    if (record.state === "outcome_unknown") {
      return { kind: "outcome_unknown", operationId, code: record.code };
    }
    const attempt = this.#attempts.get(record.recordId);
    if (attempt === undefined || attempt.attemptId !== record.attemptId) {
      throw new LegacyMutationSnapshotError(
        "Live legacy mutation cohort is missing its process coordinator",
      );
    }
    return {
      kind: "join",
      operationId,
      completion: cloneCompletion<T>(attempt.completion),
    };
  }

  #finish<T extends LegacyMutationJsonValue>(
    recordId: string,
    attemptId: string,
    value: T,
  ): Promise<void> {
    const cloned = cloneJson(value);
    return this.#serialized(async () => {
      const current = this.#currentAttempt(recordId, attemptId);
      const now = this.#timestampAfter(current.updatedAtUnixMs);
      const completed: CompletedRecord = {
        ...current,
        state: "completed",
        updatedAtUnixMs: now,
        terminalAtUnixMs: now,
        value: cloned,
      };
      const next = new Map(this.#records);
      next.set(recordId, completed);
      await this.#commit(next);
      const attempt = this.#attempts.get(recordId);
      this.#attempts.delete(recordId);
      // Every public completion clones independently in cloneCompletion.
      attempt?.resolve({ kind: "completed", value: cloned });
    });
  }

  #outcomeUnknown(recordId: string, attemptId: string, code: string): Promise<void> {
    const validatedCode = validateOutcomeCode(code);
    return this.#serialized(async () => {
      const current = this.#currentAttempt(recordId, attemptId);
      const now = this.#timestampAfter(current.updatedAtUnixMs);
      const unknown: OutcomeUnknownRecord = {
        ...current,
        state: "outcome_unknown",
        updatedAtUnixMs: now,
        terminalAtUnixMs: now,
        code: validatedCode,
      };
      const next = new Map(this.#records);
      next.set(recordId, unknown);
      await this.#commit(next);
      const attempt = this.#attempts.get(recordId);
      this.#attempts.delete(recordId);
      attempt?.resolve({ kind: "outcome_unknown", code: validatedCode });
    });
  }

  #failBeforeDispatch(recordId: string, attemptId: string, code: string): Promise<void> {
    const validatedCode = validateOutcomeCode(code);
    return this.#serialized(async () => {
      this.#currentAttempt(recordId, attemptId);
      const next = new Map(this.#records);
      next.delete(recordId);
      await this.#commit(next);
      const attempt = this.#attempts.get(recordId);
      this.#attempts.delete(recordId);
      attempt?.resolve({ kind: "retryable_pre_dispatch_failure", code: validatedCode });
    });
  }

  #currentAttempt(recordId: string, attemptId: string): InFlightRecord {
    const current = this.#records.get(recordId);
    if (current === undefined || current.state !== "in_flight" || current.attemptId !== attemptId) {
      throw new LegacyMutationStateError(
        "Legacy mutation execution attempt is stale or already terminal",
      );
    }
    return current;
  }

  async #recoverAfterRestart(): Promise<void> {
    const now = checkedTimestamp(this.#configuration.nowUnixMs());
    const next = new Map<string, StoredRecord>();
    let changed = false;
    for (const [recordId, record] of this.#records) {
      if (record.state !== "in_flight") {
        next.set(recordId, record);
        continue;
      }
      changed = true;
      next.set(recordId, {
        ...record,
        state: "outcome_unknown",
        updatedAtUnixMs: Math.max(record.updatedAtUnixMs, now),
        terminalAtUnixMs: Math.max(record.updatedAtUnixMs, now),
        code: RESTART_UNKNOWN_CODE,
      });
    }
    const pruned = pruneCompleted(next, this.#configuration.maxCompletedResults);
    if (!sameRecordStates(next, pruned)) changed = true;
    if (changed) await this.#commit(pruned);
  }

  #timestampAfter(previous: number): number {
    return Math.max(previous, checkedTimestamp(this.#configuration.nowUnixMs()));
  }

  async #commit(candidate: ReadonlyMap<string, StoredRecord>): Promise<void> {
    const records = pruneCompleted(candidate, this.#configuration.maxCompletedResults);
    const revision = this.#nextRevision();
    if (this.#configuration.kind === "durable") {
      if (!this.#hasSnapshot) {
        await writeSnapshot(this.#configuration.snapshotPath, revision, records);
        this.#hasSnapshot = true;
        this.#journalEntries = 0;
      } else {
        const entry = journalDelta(this.#revision, this.#records, records);
        await writeJournalEntry(this.#configuration.journalDirectory, entry);
        this.#journalEntries += 1;
        if (this.#journalEntries >= this.#configuration.journalCompactionEntries) {
          await writeSnapshot(this.#configuration.snapshotPath, revision, records);
          await clearJournalDirectory(this.#configuration.journalDirectory);
          this.#journalEntries = 0;
        }
      }
    }
    this.#records = records;
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
      throw new LegacyMutationSnapshotError("Legacy mutation revision space is exhausted");
    }
    return revision;
  }
}

function durableConfiguration(options: LegacyMutationCoordinatorOptions): DurableConfiguration {
  const dataDirectory = resolve(options.dataDirectory ?? omniCodexDataDirectory());
  return {
    kind: "durable",
    ...durablePaths(
      resolve(
        options.snapshotPath ?? join(dataDirectory, "state", "legacy-mutation-coordinator.json"),
      ),
    ),
    journalCompactionEntries: validateJournalCompactionEntries(options.journalCompactionEntries),
    maxCompletedResults: validateMaxCompletedResults(options.maxCompletedResults),
    nowUnixMs: options.nowUnixMs ?? Date.now,
  };
}

function memoryConfiguration(
  options: InMemoryLegacyMutationCoordinatorOptions,
): InMemoryConfiguration {
  return {
    kind: "memory",
    maxCompletedResults: validateMaxCompletedResults(options.maxCompletedResults),
    nowUnixMs: options.nowUnixMs ?? Date.now,
  };
}

function validateMaxCompletedResults(configured: number | undefined): number | undefined {
  if (configured === undefined) return undefined;
  if (!Number.isSafeInteger(configured) || configured < 1) {
    throw new RangeError("maxCompletedResults must be a positive safe integer");
  }
  return configured;
}

function validateJournalCompactionEntries(configured: number | undefined): number {
  if (configured === undefined) return DEFAULT_JOURNAL_COMPACTION_ENTRIES;
  if (!Number.isSafeInteger(configured) || configured < 1) {
    throw new RangeError("journalCompactionEntries must be a positive safe integer");
  }
  return configured;
}

function durablePaths(snapshotPath: string): {
  readonly snapshotPath: string;
  readonly journalDirectory: string;
} {
  return {
    snapshotPath,
    journalDirectory: `${snapshotPath}.journal.d`,
  };
}

function assertSameConfiguration(
  current: DurableConfiguration,
  requested: DurableConfiguration,
): void {
  if (
    current.maxCompletedResults !== requested.maxCompletedResults ||
    current.journalCompactionEntries !== requested.journalCompactionEntries ||
    current.nowUnixMs !== requested.nowUnixMs
  ) {
    throw new Error(
      "Legacy mutation coordinator is already open with different process-wide options",
    );
  }
}

function processPathKey(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function processCoreRegistry(): Map<string, CoreRegistryEntry> {
  const scope = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = scope[PROCESS_CORES_SYMBOL];
  if (existing !== undefined) {
    if (!(existing instanceof Map)) {
      throw new Error("Global legacy mutation coordinator registry has an incompatible value");
    }
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

function validateRequest(request: LegacyMutationRequestContext): ValidatedRequest {
  if (typeof request.authorizationBinding !== "string" || request.authorizationBinding.length < 1) {
    throw new TypeError("authorizationBinding is not a valid opaque authorization boundary");
  }
  const authorizationDigest = digestFramed("legacy-authorization-v1", [
    request.authorizationBinding,
  ]);
  const semanticDigest = validateDigest(request.semanticDigest, "semanticDigest");
  if (
    request.retrySafeAfterUnknown !== undefined &&
    typeof request.retrySafeAfterUnknown !== "boolean"
  ) {
    throw new TypeError("retrySafeAfterUnknown must be a boolean");
  }
  if (typeof request.sessionId !== "string" || request.sessionId.length < 1) {
    throw new TypeError("sessionId is not a valid opaque session identifier");
  }
  if (
    (typeof request.requestId !== "string" && typeof request.requestId !== "number") ||
    (typeof request.requestId === "string" && request.requestId.length < 1) ||
    (typeof request.requestId === "number" && !Number.isFinite(request.requestId))
  ) {
    throw new TypeError("requestId is not a valid JSON-RPC request identifier");
  }
  const sessionDigest = digestFramed("legacy-session-v1", [request.sessionId]);
  const requestDigest = digestFramed("legacy-request-v1", [
    request.sessionId,
    typeof request.requestId,
    String(request.requestId),
  ]);
  return {
    authorizationDigest,
    semanticDigest,
    member: { sessionDigest, requestDigest },
    retrySafeAfterUnknown: request.retrySafeAfterUnknown === true,
  };
}

function validateDigest(value: string, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

function validateOutcomeCode(code: string): string {
  if (!/^[A-Z][A-Z0-9_:-]*$/.test(code)) {
    throw new TypeError("Legacy mutation outcome code is invalid");
  }
  return code;
}

function cohortRecordId(
  authorizationDigest: string,
  semanticDigest: string,
  originRequestDigest: string,
): string {
  return digestFramed("legacy-cohort-v1", [
    authorizationDigest,
    semanticDigest,
    originRequestDigest,
  ]);
}

function digestFramed(domain: string, values: readonly string[]): string {
  const hash = createHash("sha256").update(`${domain}\0`, "utf8");
  for (const value of values) {
    hash
      .update(String(Buffer.byteLength(value)), "utf8")
      .update(":", "utf8")
      .update(value, "utf8")
      .update("\0", "utf8");
  }
  return hash.digest("hex");
}

function publicOperationId(recordId: string): string {
  const bytes = Buffer.from(recordId.slice(0, 32), "hex");
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new LegacyMutationSnapshotError("Legacy mutation record digest is invalid");
  }
  bytes[6] = (versionByte & 0x0f) | 0x50;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function deferredAttempt(attemptId: string): RuntimeAttempt {
  let resolveCompletion:
    | ((terminal: LegacyMutationTerminal<LegacyMutationJsonValue>) => void)
    | undefined;
  const completion = new Promise<LegacyMutationTerminal<LegacyMutationJsonValue>>((resolve) => {
    resolveCompletion = resolve;
  });
  return {
    attemptId,
    completion,
    resolve: (terminal) => {
      if (resolveCompletion === undefined) return;
      const resolve = resolveCompletion;
      resolveCompletion = undefined;
      resolve(terminal);
    },
  };
}

function cloneCompletion<T extends LegacyMutationJsonValue>(
  completion: Promise<LegacyMutationTerminal<LegacyMutationJsonValue>>,
): Promise<LegacyMutationTerminal<T>> {
  return completion.then((terminal) =>
    terminal.kind === "completed"
      ? { kind: "completed", value: cloneJson(terminal.value) as T }
      : { ...terminal },
  );
}

function cloneJson<T extends LegacyMutationJsonValue>(value: T): T {
  assertJsonValue(value, new Set<object>(), "$result");
  return cloneValidatedJson(value) as T;
}

/** Copy mutable containers while sharing immutable strings, including image data. */
function cloneValidatedJson(value: LegacyMutationJsonValue): LegacyMutationJsonValue {
  if (Array.isArray(value)) return value.map(cloneValidatedJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          cloneValidatedJson(
            (value as Record<string, LegacyMutationJsonValue>)[key] as LegacyMutationJsonValue,
          ),
        ]),
    );
  }
  return value === 0 ? 0 : value;
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
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError(`${path}[${index}] is not a plain JSON item`);
        }
        assertJsonValue(descriptor.value, ancestors, `${path}[${index}]`);
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (
          typeof key !== "string" ||
          !/^(0|[1-9][0-9]*)$/.test(key) ||
          Number(key) >= value.length
        ) {
          throw new TypeError(`${path} contains a non-JSON array field`);
        }
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

function pruneCompleted(
  records: ReadonlyMap<string, StoredRecord>,
  maxCompletedResults: number | undefined,
): Map<string, StoredRecord> {
  if (maxCompletedResults === undefined) return new Map(records);
  const next = new Map(records);
  const completed = [...next.values()]
    .filter((record): record is CompletedRecord => record.state === "completed")
    .sort(
      (left, right) =>
        left.terminalAtUnixMs - right.terminalAtUnixMs ||
        left.recordId.localeCompare(right.recordId),
    );
  const overflow = completed.slice(0, Math.max(0, completed.length - maxCompletedResults));
  for (const record of overflow) {
    const { value: _value, ...terminal } = record;
    next.set(record.recordId, {
      ...terminal,
      state: "result_replay_expired",
    });
  }
  return next;
}

function sameRecordStates(
  left: ReadonlyMap<string, StoredRecord>,
  right: ReadonlyMap<string, StoredRecord>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [recordId, record] of left) {
    if (right.get(recordId)?.state !== record.state) return false;
  }
  return true;
}

function journalDelta(
  previousRevision: number,
  current: ReadonlyMap<string, StoredRecord>,
  next: ReadonlyMap<string, StoredRecord>,
): JournalPayload {
  const recordUpserts = [...next.entries()]
    .filter(([recordId, record]) => current.get(recordId) !== record)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([, record]) => record);
  const recordDeletes = [...current.keys()]
    .filter((recordId) => !next.has(recordId))
    .sort((left, right) => left.localeCompare(right, "en"));
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    previousRevision,
    revision: previousRevision + 1,
    recordUpserts,
    recordDeletes,
  };
}

async function loadState(configuration: DurableConfiguration): Promise<{
  readonly revision: number;
  readonly records: Map<string, StoredRecord>;
  readonly journalEntries: number;
  readonly hasSnapshot: boolean;
}> {
  const snapshot = await loadSnapshot(configuration.snapshotPath);
  const records = new Map(snapshot.records);
  const journal = await loadJournal(configuration.journalDirectory);
  let revision = snapshot.revision;
  for (const entry of journal) {
    // A crash after snapshot replacement but before delta cleanup is safe: the
    // compacted snapshot already contains these revisions.
    if (entry.revision <= revision) continue;
    if (entry.previousRevision !== revision || entry.revision !== revision + 1) {
      throw new LegacyMutationSnapshotError("Legacy mutation journal revisions are not contiguous");
    }
    for (const recordId of entry.recordDeletes) records.delete(recordId);
    for (const record of entry.recordUpserts) records.set(record.recordId, record);
    revision = entry.revision;
  }
  validateLoadedRecords(records);
  return {
    revision,
    records,
    journalEntries: journal.filter((entry) => entry.revision > snapshot.revision).length,
    hasSnapshot: snapshot.hasSnapshot,
  };
}

async function loadJournal(directory: string): Promise<StoredJournalEntry[]> {
  let names: string[];
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^[0-9]{20}\.json$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, "en"));
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return [];
    throw error;
  }
  const entries: StoredJournalEntry[] = [];
  for (const name of names) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(directory, name), "utf8"));
    } catch {
      throw new LegacyMutationSnapshotError(`Legacy mutation journal ${name} is not valid JSON`);
    }
    entries.push(parseJournalEntry(parsed, name));
  }
  return entries;
}

function parseJournalEntry(value: unknown, name: string): StoredJournalEntry {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "previousRevision",
      "revision",
      "recordUpserts",
      "recordDeletes",
      "checksum",
    ]) ||
    value.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.previousRevision) ||
    (value.previousRevision as number) < 0 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision !== (value.previousRevision as number) + 1 ||
    !Array.isArray(value.recordUpserts) ||
    !Array.isArray(value.recordDeletes) ||
    typeof value.checksum !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.checksum)
  ) {
    throw new LegacyMutationSnapshotError(
      `Legacy mutation journal ${name} has an invalid envelope`,
    );
  }
  const rawPayload: JournalPayload = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    previousRevision: value.previousRevision as number,
    revision: value.revision as number,
    recordUpserts: value.recordUpserts as StoredRecord[],
    recordDeletes: value.recordDeletes as string[],
  };
  if (value.checksum !== journalChecksum(rawPayload)) {
    throw new LegacyMutationSnapshotError(`Legacy mutation journal ${name} checksum mismatch`);
  }
  const recordUpserts = value.recordUpserts.map((record, index) => parseRecord(record, index));
  const recordDeletes = value.recordDeletes.map((recordId) => {
    if (typeof recordId !== "string" || !/^[a-f0-9]{64}$/.test(recordId)) {
      throw new LegacyMutationSnapshotError(
        `Legacy mutation journal ${name} has an invalid delete`,
      );
    }
    return recordId;
  });
  if (
    new Set(recordUpserts.map((record) => record.recordId)).size !== recordUpserts.length ||
    new Set(recordDeletes).size !== recordDeletes.length
  ) {
    throw new LegacyMutationSnapshotError(`Legacy mutation journal ${name} has duplicate records`);
  }
  return { ...rawPayload, recordUpserts, recordDeletes, checksum: value.checksum };
}

function validateLoadedRecords(records: ReadonlyMap<string, StoredRecord>): void {
  const requestOwners = new Set<string>();
  for (const record of records.values()) {
    for (const member of record.members) {
      const owner = `${record.authorizationDigest}:${member.requestDigest}`;
      if (requestOwners.has(owner)) {
        throw new LegacyMutationSnapshotError(
          "Legacy mutation state assigns one request to multiple cohorts",
        );
      }
      requestOwners.add(owner);
    }
  }
}

async function loadSnapshot(path: string): Promise<{
  revision: number;
  records: Map<string, StoredRecord>;
  hasSnapshot: boolean;
}> {
  let parsed: unknown;
  try {
    parsed = await readSnapshotDocument(path);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return { revision: 0, records: new Map(), hasSnapshot: false };
    }
    throw error;
  }
  const snapshot = parseSnapshot(parsed);
  return {
    revision: snapshot.revision,
    records: new Map(snapshot.records.map((record) => [record.recordId, record])),
    hasSnapshot: true,
  };
}

/** Keep the existing JSON/checksum format while parsing one cohort at a time.
 * A replay archive can exceed V8's string limit even though each native result
 * fits. Neither legacy compact JSON nor streamed output needs one archive string.
 */
async function readSnapshotDocument(path: string): Promise<unknown> {
  const envelope: string[] = [];
  const recordParts: string[] = [];
  const records: unknown[] = [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let inRecords = false;
  let foundRecords = false;
  let afterComma = false;
  const invalid = (): never => {
    throw new LegacyMutationSnapshotError("Legacy mutation snapshot is not valid JSON");
  };
  const finishRecord = (allowEmpty: boolean): void => {
    const text = recordParts.join("").trim();
    recordParts.length = 0;
    if (text.length === 0) {
      if (!allowEmpty) invalid();
      return;
    }
    try {
      records.push(JSON.parse(text));
    } catch {
      invalid();
    }
  };
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    const text = String(chunk);
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') {
        quoted = true;
        continue;
      }
      if (char === "[" && depth === 1) {
        envelope.push(text.slice(start, index));
        start = index + 1;
        if (foundRecords || !/"records"\s*:\s*$/u.test(envelope.join(""))) invalid();
        foundRecords = true;
        inRecords = true;
        envelope.push("[]");
      } else if (inRecords && depth === 2 && (char === "," || char === "]")) {
        recordParts.push(text.slice(start, index));
        start = index + 1;
        finishRecord(char === "]" && !afterComma && records.length === 0);
        afterComma = char === ",";
        if (char === "]") inRecords = false;
      }
      if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") depth -= 1;
      if (depth < 0) invalid();
    }
    (inRecords ? recordParts : envelope).push(text.slice(start));
  }
  if (quoted || depth !== 0 || inRecords || !foundRecords) invalid();
  try {
    const document: unknown = JSON.parse(envelope.join(""));
    if (!isObject(document)) return invalid();
    document.records = records;
    return document;
  } catch {
    return invalid();
  }
}

/** Verifies the original bytes' logical checksum before normalizing the stored shape. */
function parseSnapshot(value: unknown): SnapshotPayload {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["schemaVersion", "revision", "records", "checksum"]) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Array.isArray(value.records) ||
    typeof value.checksum !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.checksum)
  ) {
    throw new LegacyMutationSnapshotError("Legacy mutation snapshot has an invalid envelope");
  }
  const rawPayload = {
    schemaVersion: SCHEMA_VERSION,
    revision: value.revision as number,
    records: value.records,
  };
  if (value.checksum !== checksum(rawPayload)) {
    throw new LegacyMutationSnapshotError("Legacy mutation snapshot checksum mismatch");
  }
  const records = value.records.map((record, index) => parseRecord(record, index));
  if (new Set(records.map((record) => record.recordId)).size !== records.length) {
    throw new LegacyMutationSnapshotError("Legacy mutation snapshot contains duplicate cohorts");
  }
  const requestOwners = new Set<string>();
  for (const record of records) {
    for (const member of record.members) {
      const owner = `${record.authorizationDigest}:${member.requestDigest}`;
      if (requestOwners.has(owner)) {
        throw new LegacyMutationSnapshotError(
          "Legacy mutation snapshot assigns one request to multiple cohorts",
        );
      }
      requestOwners.add(owner);
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: value.revision as number,
    records,
  };
}

function parseRecord(value: unknown, index: number): StoredRecord {
  const invalid = (): never => {
    throw new LegacyMutationSnapshotError(`Legacy mutation record ${index + 1} is invalid`);
  };
  // deadlineUnixMs existed in the original schema. It is validated only so an
  // old checksummed snapshot can load, then deliberately omitted from `base`.
  if (
    !isObject(value) ||
    typeof value.recordId !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.recordId) ||
    typeof value.authorizationDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.authorizationDigest) ||
    typeof value.semanticDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.semanticDigest) ||
    !Array.isArray(value.members) ||
    value.members.length < 1 ||
    typeof value.attemptId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value.attemptId,
    ) ||
    !validTimestamp(value.admittedAtUnixMs) ||
    !validTimestamp(value.updatedAtUnixMs) ||
    value.updatedAtUnixMs < value.admittedAtUnixMs ||
    (Object.hasOwn(value, "deadlineUnixMs") &&
      (!validTimestamp(value.deadlineUnixMs) || value.deadlineUnixMs < value.admittedAtUnixMs))
  ) {
    return invalid();
  }
  const members = value.members.map((member) => parseMember(member, invalid));
  if (
    new Set(members.map((member) => member.requestDigest)).size !== members.length ||
    new Set(members.map((member) => member.sessionDigest)).size !== members.length
  ) {
    return invalid();
  }
  if (
    cohortRecordId(
      value.authorizationDigest,
      value.semanticDigest,
      members[0]?.requestDigest ?? "",
    ) !== value.recordId
  ) {
    return invalid();
  }
  const commonKeys = [
    "recordId",
    "authorizationDigest",
    "semanticDigest",
    "members",
    "attemptId",
    "admittedAtUnixMs",
    "updatedAtUnixMs",
    "state",
    ...(Object.hasOwn(value, "deadlineUnixMs") ? ["deadlineUnixMs"] : []),
  ];
  const base = {
    recordId: value.recordId,
    authorizationDigest: value.authorizationDigest,
    semanticDigest: value.semanticDigest,
    members,
    attemptId: value.attemptId,
    admittedAtUnixMs: value.admittedAtUnixMs,
    updatedAtUnixMs: value.updatedAtUnixMs,
  };
  if (value.state === "in_flight") {
    if (!hasOnlyKeys(value, commonKeys)) return invalid();
    return { ...base, state: "in_flight" };
  }
  if (!validTimestamp(value.terminalAtUnixMs) || value.terminalAtUnixMs < value.admittedAtUnixMs) {
    return invalid();
  }
  if (value.state === "completed") {
    const legacyKeys = [...commonKeys, "terminalAtUnixMs"];
    const replayableKeys = [...legacyKeys, "value"];
    if (hasOnlyKeys(value, legacyKeys)) {
      return {
        ...base,
        state: "result_replay_expired",
        terminalAtUnixMs: value.terminalAtUnixMs,
      };
    }
    if (!hasOnlyKeys(value, replayableKeys)) return invalid();
    try {
      assertJsonValue(value.value, new Set<object>(), "$result");
      return {
        ...base,
        state: "completed",
        terminalAtUnixMs: value.terminalAtUnixMs,
        // This value belongs exclusively to the JSON.parse result. The loader
        // transfers ownership to the core; public replay still clones it.
        value: value.value as LegacyMutationJsonValue,
      };
    } catch {
      return invalid();
    }
  }
  if (value.state === "result_replay_expired") {
    if (!hasOnlyKeys(value, [...commonKeys, "terminalAtUnixMs"])) return invalid();
    return {
      ...base,
      state: "result_replay_expired",
      terminalAtUnixMs: value.terminalAtUnixMs,
    };
  }
  if (value.state === "outcome_unknown" && typeof value.code === "string") {
    if (!hasOnlyKeys(value, [...commonKeys, "terminalAtUnixMs", "code"])) return invalid();
    try {
      return {
        ...base,
        state: "outcome_unknown",
        terminalAtUnixMs: value.terminalAtUnixMs,
        code: validateOutcomeCode(value.code),
      };
    } catch {
      return invalid();
    }
  }
  return invalid();
}

function parseMember(value: unknown, invalid: () => never): MemberDigest {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["sessionDigest", "requestDigest"]) ||
    typeof value.sessionDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sessionDigest) ||
    typeof value.requestDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.requestDigest)
  ) {
    return invalid();
  }
  return { sessionDigest: value.sessionDigest, requestDigest: value.requestDigest };
}

async function writeSnapshot(
  path: string,
  revision: number,
  records: ReadonlyMap<string, StoredRecord>,
): Promise<void> {
  const payload: SnapshotPayload = {
    schemaVersion: SCHEMA_VERSION,
    revision,
    records: [...records.values()].sort((left, right) =>
      left.recordId.localeCompare(right.recordId),
    ),
  };
  const snapshot: StoredSnapshot = { ...payload, checksum: checksum(payload) };
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await writeCanonicalDocument(handle, snapshot);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, absolute);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeJournalEntry(directory: string, payload: JournalPayload): Promise<void> {
  const absolute = resolve(directory);
  await mkdir(absolute, { recursive: true });
  const name = `${String(payload.revision).padStart(20, "0")}.json`;
  const destination = join(absolute, name);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const stored: StoredJournalEntry = {
    ...payload,
    checksum: journalChecksum(payload),
  };
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await writeCanonicalDocument(handle, stored);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function clearJournalDirectory(directory: string): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^[0-9]{20}\.json$/.test(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return;
    throw error;
  }
  for (const name of names) await rm(join(directory, name), { force: true });
}

function journalChecksum(payload: JournalPayload): string {
  return canonicalChecksum(payload);
}

function checksum(payload: {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly records: readonly unknown[];
}): string {
  return canonicalChecksum({
    schemaVersion: payload.schemaVersion,
    revision: payload.revision,
    records: payload.records,
  });
}

/** Hash the same canonical bytes without assembling a second full replay archive. */
function canonicalChecksum(value: unknown): string {
  const hash = createHash("sha256");
  for (const chunk of canonicalChunks(value)) hash.update(chunk, "utf8");
  return hash.digest("hex");
}

function* canonicalChunks(item: unknown): Generator<string> {
  if (Array.isArray(item)) {
    yield "[";
    for (let index = 0; index < item.length; index += 1) {
      if (index > 0) yield ",";
      yield* canonicalChunks(item[index]);
    }
    yield "]";
    return;
  }
  if (item !== null && typeof item === "object") {
    const record = item as Record<string, unknown>;
    yield "{";
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    for (const [index, key] of keys.entries()) {
      if (index > 0) yield ",";
      yield JSON.stringify(key);
      yield ":";
      yield* canonicalChunks(record[key]);
    }
    yield "}";
    return;
  }
  yield canonicalJson(item);
}

async function writeCanonicalDocument(
  handle: Awaited<ReturnType<typeof open>>,
  value: unknown,
): Promise<void> {
  // Buffer bounded UTF-8 bytes, not a joined archive string. Buffer slicing
  // also avoids splitting a surrogate pair across separate string writes.
  const limit = 64 * 1024;
  let chunks: Buffer[] = [];
  let size = 0;
  for (const text of canonicalChunks(value)) {
    const bytes = Buffer.from(text, "utf8");
    for (let offset = 0; offset < bytes.length; ) {
      const end = Math.min(bytes.length, offset + limit - size);
      chunks.push(bytes.subarray(offset, end));
      size += end - offset;
      offset = end;
      if (size === limit) {
        await handle.writeFile(Buffer.concat(chunks, size));
        chunks = [];
        size = 0;
      }
    }
  }
  if (size > 0) await handle.writeFile(Buffer.concat(chunks, size));
  await handle.writeFile("\n", "utf8");
}

function checkedTimestamp(value: number): number {
  if (!validTimestamp(value)) {
    throw new RangeError("Legacy mutation coordinator clock returned an invalid time");
  }
  return value;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === allowed.length && actual.every((key) => allowed.includes(key));
}

function getErrorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}
