import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { omniCodexDataDirectory } from "../config/omnicodex-config-store.js";
import { canonicalJson } from "../safety/canonical-json.js";

const SCHEMA_VERSION = 1;
const RESTART_UNKNOWN_CODE = "PROCESS_RESTART_AFTER_DISPATCH";
const RESULT_REPLAY_EXPIRED_CODE = "RESULT_REPLAY_EXPIRED";

export type MutationReplayJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly MutationReplayJsonValue[]
  | { readonly [key: string]: MutationReplayJsonValue };

export interface MutationReplayIdentity {
  /** Stable authorization boundary, for example authorizationBinding(identity). */
  readonly authorizationBinding: string;
  /** Caller-supplied stable key. A generated request ID is not an idempotency key. */
  readonly idempotencyKey: string;
  /** Canonical mutation fingerprint supplied by the caller. */
  readonly fingerprint: string;
}

export interface MutationReplayStoreOptions {
  readonly dataDirectory?: string;
  readonly snapshotPath?: string;
  readonly maxCompletedEntries?: number;
  readonly nowUnixMs?: () => number;
}

export interface InMemoryMutationReplayStoreOptions {
  readonly maxCompletedEntries?: number;
  readonly nowUnixMs?: () => number;
}

export type MutationReplayTerminal<T extends MutationReplayJsonValue> =
  | { readonly kind: "completed"; readonly value: T }
  | { readonly kind: "retryable_pre_dispatch_failure"; readonly code: string }
  | { readonly kind: "outcome_unknown"; readonly code: string };

export interface MutationReplayExecution<T extends MutationReplayJsonValue> {
  /** Stable hash-derived identifier for this authorization binding and idempotency key. */
  readonly operationId: string;
  readonly attemptId: string;
  readonly completion: Promise<MutationReplayTerminal<T>>;
  /** Must resolve before the external mutation is dispatched. */
  markDispatched(): Promise<void>;
  /** Durably records completion after dispatch, including its losslessly replayable result. */
  complete(value: T): Promise<void>;
  /**
   * Releases the key only with authoritative proof that dispatch did not occur.
   * It may follow markDispatched(), which durably records pessimistic intent before transport I/O.
   */
  failBeforeDispatch(code?: string): Promise<void>;
  /** Permanently blocks replay when dispatch occurred but its result is not known. */
  markOutcomeUnknown(code?: string): Promise<void>;
}

export type MutationReplayAcquisition<T extends MutationReplayJsonValue> =
  | {
      readonly kind: "execute";
      readonly operationId: string;
      readonly execution: MutationReplayExecution<T>;
    }
  | {
      readonly kind: "join";
      readonly operationId: string;
      readonly completion: Promise<MutationReplayTerminal<T>>;
    }
  | { readonly kind: "replay"; readonly operationId: string; readonly value: T }
  | { readonly kind: "outcome_unknown"; readonly operationId: string; readonly code: string };

export class MutationReplayConflictError extends Error {
  readonly code = "MUTATION_IDEMPOTENCY_CONFLICT";

  constructor() {
    super("Idempotency key was already used for a different mutation fingerprint");
    this.name = "MutationReplayConflictError";
  }
}

export class MutationReplayStateError extends Error {
  readonly code = "MUTATION_REPLAY_INVALID_TRANSITION";

  constructor(message: string) {
    super(message);
    this.name = "MutationReplayStateError";
  }
}

export class MutationReplaySnapshotError extends Error {
  readonly code = "MUTATION_REPLAY_SNAPSHOT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "MutationReplaySnapshotError";
  }
}

interface PreparedRecord {
  readonly recordId: string;
  readonly fingerprintDigest: string;
  readonly state: "prepared";
  readonly attemptId: string;
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
}

interface DispatchedRecord {
  readonly recordId: string;
  readonly fingerprintDigest: string;
  readonly state: "dispatched";
  readonly attemptId: string;
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
}

interface CompletedRecord {
  readonly recordId: string;
  readonly fingerprintDigest: string;
  readonly state: "completed";
  readonly attemptId: string;
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
  readonly terminalSequence: number;
  readonly value: MutationReplayJsonValue;
}

/**
 * Permanent terminal tombstone for a completed mutation whose result is not durable.
 * The key and fingerprint digests remain so the mutation can never execute again.
 */
interface ResultReplayExpiredRecord {
  readonly recordId: string;
  readonly fingerprintDigest: string;
  readonly state: "result_replay_expired";
  readonly attemptId: string;
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
  readonly terminalSequence: number;
}

interface UnknownRecord {
  readonly recordId: string;
  readonly fingerprintDigest: string;
  readonly state: "outcome_unknown";
  readonly attemptId: string;
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
  readonly terminalSequence: number;
  readonly code: string;
}

type StoredRecord =
  | PreparedRecord
  | DispatchedRecord
  | CompletedRecord
  | ResultReplayExpiredRecord
  | UnknownRecord;

type SnapshotRecord = StoredRecord;

interface SnapshotPayload {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly revision: number;
  readonly records: readonly SnapshotRecord[];
}

interface StoredSnapshot extends SnapshotPayload {
  readonly checksum: string;
}

interface RuntimeAttempt {
  readonly attemptId: string;
  readonly completion: Promise<MutationReplayTerminal<MutationReplayJsonValue>>;
  readonly resolve: (result: MutationReplayTerminal<MutationReplayJsonValue>) => void;
}

interface LoadedSnapshot {
  readonly revision: number;
  readonly records: Map<string, StoredRecord>;
}

interface DurableCoreConfiguration {
  readonly kind: "durable";
  readonly snapshotPath: string;
  readonly maxCompletedEntries: number | undefined;
  readonly nowUnixMs: () => number;
}

interface InMemoryCoreConfiguration {
  readonly kind: "memory";
  readonly maxCompletedEntries: number | undefined;
  readonly nowUnixMs: () => number;
}

type CoreConfiguration = DurableCoreConfiguration | InMemoryCoreConfiguration;

interface CoreRegistryEntry {
  readonly configuration: DurableCoreConfiguration;
  readonly promise: Promise<MutationReplayCore>;
}

const PROCESS_CORES_SYMBOL = Symbol.for("@heelee912/omnicodex/mutation-replay-cores/v1");
const processCores = processCoreRegistry();

/**
 * Process-wide and restart-durable idempotency coordinator for externally visible mutations.
 * It deliberately retains in-flight and unknown records without TTL eviction.
 */
export class MutationReplayStore {
  readonly #core: MutationReplayCore;

  private constructor(core: MutationReplayCore) {
    this.#core = core;
  }

  static async open(options: MutationReplayStoreOptions = {}): Promise<MutationReplayStore> {
    const configuration = configurationFrom(options);
    const registryKey = processPathKey(configuration.snapshotPath);
    const existing = processCores.get(registryKey);
    if (existing !== undefined) {
      assertSameConfiguration(existing.configuration, configuration);
      return new MutationReplayStore(await existing.promise);
    }

    const promise = MutationReplayCore.open(configuration);
    const entry = { configuration, promise };
    processCores.set(registryKey, entry);
    try {
      return new MutationReplayStore(await promise);
    } catch (error) {
      if (processCores.get(registryKey) === entry) {
        processCores.delete(registryKey);
      }
      throw error;
    }
  }

  /** Fresh non-persistent coordinator for tests and explicitly ephemeral server factories. */
  static inMemory(options: InMemoryMutationReplayStoreOptions = {}): MutationReplayStore {
    return new MutationReplayStore(MutationReplayCore.inMemory(memoryConfigurationFrom(options)));
  }

  acquire<T extends MutationReplayJsonValue = MutationReplayJsonValue>(
    identity: MutationReplayIdentity,
  ): Promise<MutationReplayAcquisition<T>> {
    return this.#core.acquire<T>(validateIdentity(identity));
  }

  get snapshotPath(): string | undefined {
    return this.#core.snapshotPath;
  }
}

class MutationReplayCore {
  readonly #configuration: CoreConfiguration;
  #records: Map<string, StoredRecord>;
  readonly #attempts = new Map<string, RuntimeAttempt>();
  #revision: number;
  #tail: Promise<void> = Promise.resolve();

  private constructor(
    configuration: CoreConfiguration,
    revision: number,
    records: Map<string, StoredRecord>,
  ) {
    this.#configuration = configuration;
    this.#revision = revision;
    this.#records = records;
  }

  static async open(configuration: DurableCoreConfiguration): Promise<MutationReplayCore> {
    const loaded = await loadSnapshot(configuration.snapshotPath);
    const core = new MutationReplayCore(configuration, loaded.revision, loaded.records);
    await core.#recoverAfterRestart();
    return core;
  }

  static inMemory(configuration: InMemoryCoreConfiguration): MutationReplayCore {
    return new MutationReplayCore(configuration, 0, new Map());
  }

  get snapshotPath(): string | undefined {
    return this.#configuration.kind === "durable" ? this.#configuration.snapshotPath : undefined;
  }

  acquire<T extends MutationReplayJsonValue>(
    identity: MutationReplayIdentity,
  ): Promise<MutationReplayAcquisition<T>> {
    return this.#serialized(async () => {
      const recordId = identityDigest(identity.authorizationBinding, identity.idempotencyKey);
      const operationId = publicOperationId(recordId);
      const fingerprintDigest = digest(identity.fingerprint);
      const current = this.#records.get(recordId);
      if (current !== undefined) {
        if (current.fingerprintDigest !== fingerprintDigest) {
          throw new MutationReplayConflictError();
        }
        if (current.state === "completed") {
          return { kind: "replay", operationId, value: cloneJson(current.value) as T };
        }
        if (current.state === "result_replay_expired") {
          return {
            kind: "outcome_unknown",
            operationId,
            code: RESULT_REPLAY_EXPIRED_CODE,
          };
        }
        if (current.state === "outcome_unknown") {
          return { kind: "outcome_unknown", operationId, code: current.code };
        }
        const attempt = this.#attempts.get(recordId);
        if (attempt === undefined || attempt.attemptId !== current.attemptId) {
          throw new MutationReplaySnapshotError(
            "Live in-flight mutation is missing its process coordinator",
          );
        }
        return {
          kind: "join",
          operationId,
          completion: cloneCompletion<T>(attempt.completion),
        };
      }

      const timestamp = checkedTimestamp(this.#configuration.nowUnixMs());
      const attemptId = randomUUID();
      const prepared: PreparedRecord = {
        recordId,
        fingerprintDigest,
        state: "prepared",
        attemptId,
        createdAtUnixMs: timestamp,
        updatedAtUnixMs: timestamp,
      };
      const next = new Map(this.#records);
      next.set(recordId, prepared);
      await this.#commit(next);

      const attempt = deferredAttempt(attemptId);
      this.#attempts.set(recordId, attempt);
      const execution: MutationReplayExecution<T> = {
        operationId,
        attemptId,
        completion: cloneCompletion<T>(attempt.completion),
        markDispatched: async () => this.#markDispatched(recordId, attemptId),
        complete: async (value) => this.#complete(recordId, attemptId, value),
        failBeforeDispatch: async (code = "PRE_DISPATCH_FAILURE") =>
          this.#failBeforeDispatch(recordId, attemptId, code),
        markOutcomeUnknown: async (code = "POST_DISPATCH_OUTCOME_UNKNOWN") =>
          this.#markOutcomeUnknown(recordId, attemptId, code),
      };
      return { kind: "execute", operationId, execution };
    });
  }

  #markDispatched(recordId: string, attemptId: string): Promise<void> {
    return this.#serialized(async () => {
      const current = this.#currentAttempt(recordId, attemptId);
      if (current.state === "dispatched") return;
      if (current.state !== "prepared") {
        throw new MutationReplayStateError("Mutation cannot be dispatched from a terminal state");
      }
      const next = new Map(this.#records);
      next.set(recordId, {
        ...current,
        state: "dispatched",
        updatedAtUnixMs: this.#timestampAfter(current.updatedAtUnixMs),
      });
      await this.#commit(next);
    });
  }

  #complete<T extends MutationReplayJsonValue>(
    recordId: string,
    attemptId: string,
    value: T,
  ): Promise<void> {
    const cloned = cloneJson(value);
    return this.#serialized(async () => {
      const current = this.#currentAttempt(recordId, attemptId);
      if (current.state !== "dispatched") {
        throw new MutationReplayStateError("Mutation result requires a durable dispatched state");
      }
      const terminalSequence = this.#nextRevision();
      const completed: CompletedRecord = {
        ...current,
        state: "completed",
        updatedAtUnixMs: this.#timestampAfter(current.updatedAtUnixMs),
        terminalSequence,
        value: cloned,
      };
      const next = new Map(this.#records);
      next.set(recordId, completed);
      await this.#commit(this.#pruneCompletedResults(next));
      const attempt = this.#attempts.get(recordId);
      this.#attempts.delete(recordId);
      attempt?.resolve({ kind: "completed", value: cloneJson(cloned) });
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

  #markOutcomeUnknown(recordId: string, attemptId: string, code: string): Promise<void> {
    const validatedCode = validateOutcomeCode(code);
    return this.#serialized(async () => {
      const current = this.#currentAttempt(recordId, attemptId);
      if (current.state !== "dispatched") {
        throw new MutationReplayStateError("Unknown outcome requires a durable dispatched state");
      }
      const unknown: UnknownRecord = {
        ...current,
        state: "outcome_unknown",
        updatedAtUnixMs: this.#timestampAfter(current.updatedAtUnixMs),
        terminalSequence: this.#nextRevision(),
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

  #currentAttempt(recordId: string, attemptId: string): PreparedRecord | DispatchedRecord {
    const current = this.#records.get(recordId);
    if (
      current === undefined ||
      current.attemptId !== attemptId ||
      (current.state !== "prepared" && current.state !== "dispatched")
    ) {
      throw new MutationReplayStateError("Mutation execution attempt is stale or already terminal");
    }
    return current;
  }

  async #recoverAfterRestart(): Promise<void> {
    const next = new Map<string, StoredRecord>();
    let changed = false;
    const timestamp = checkedTimestamp(this.#configuration.nowUnixMs());
    for (const [recordId, record] of this.#records) {
      if (record.state === "prepared") {
        changed = true;
        continue;
      }
      if (record.state === "dispatched") {
        changed = true;
        next.set(recordId, {
          ...record,
          state: "outcome_unknown",
          updatedAtUnixMs: Math.max(timestamp, record.updatedAtUnixMs),
          terminalSequence: this.#nextRevision(),
          code: RESTART_UNKNOWN_CODE,
        });
        continue;
      }
      next.set(recordId, record);
    }
    const pruned = this.#pruneCompletedResults(next);
    if (pruned !== next) changed = true;
    if (changed) await this.#commit(pruned);
  }

  #pruneCompletedResults(records: Map<string, StoredRecord>): Map<string, StoredRecord> {
    const maximum = this.#configuration.maxCompletedEntries;
    if (maximum === undefined) return records;
    const completed = [...records.values()]
      .filter((record): record is CompletedRecord => record.state === "completed")
      .sort(
        (left, right) =>
          left.terminalSequence - right.terminalSequence ||
          left.recordId.localeCompare(right.recordId),
      );
    if (completed.length <= maximum) return records;
    const next = new Map(records);
    for (const record of completed.slice(0, completed.length - maximum)) {
      const { value: _value, ...terminal } = record;
      next.set(record.recordId, { ...terminal, state: "result_replay_expired" });
    }
    return next;
  }

  #timestampAfter(previous: number): number {
    return Math.max(previous, checkedTimestamp(this.#configuration.nowUnixMs()));
  }

  async #commit(candidate: Map<string, StoredRecord>): Promise<void> {
    const revision = this.#nextRevision();
    if (this.#configuration.kind === "durable") {
      await writeSnapshot(this.#configuration.snapshotPath, revision, candidate);
    }
    this.#records = candidate;
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
      throw new MutationReplaySnapshotError("Mutation replay revision space is exhausted");
    }
    return revision;
  }
}

function configurationFrom(options: MutationReplayStoreOptions): DurableCoreConfiguration {
  const maxCompletedEntries = validatedMaxCompletedEntries(options.maxCompletedEntries);
  const dataDirectory = resolve(options.dataDirectory ?? omniCodexDataDirectory());
  const snapshotPath = resolve(
    options.snapshotPath ?? join(dataDirectory, "state", "mutation-replay-store.json"),
  );
  return {
    kind: "durable",
    snapshotPath,
    maxCompletedEntries,
    nowUnixMs: options.nowUnixMs ?? Date.now,
  };
}

function memoryConfigurationFrom(
  options: InMemoryMutationReplayStoreOptions,
): InMemoryCoreConfiguration {
  return {
    kind: "memory",
    maxCompletedEntries: validatedMaxCompletedEntries(options.maxCompletedEntries),
    nowUnixMs: options.nowUnixMs ?? Date.now,
  };
}

function validatedMaxCompletedEntries(configured: number | undefined): number | undefined {
  if (configured === undefined) return undefined;
  if (!Number.isSafeInteger(configured) || configured < 1) {
    throw new RangeError("maxCompletedEntries must be a positive safe integer");
  }
  return configured;
}

function assertSameConfiguration(
  current: DurableCoreConfiguration,
  requested: DurableCoreConfiguration,
): void {
  if (
    current.maxCompletedEntries !== requested.maxCompletedEntries ||
    current.nowUnixMs !== requested.nowUnixMs
  ) {
    throw new Error("Mutation replay store is already open with different process-wide options");
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
      throw new Error("Global mutation replay registry has an incompatible value");
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

function validateIdentity(identity: MutationReplayIdentity): MutationReplayIdentity {
  if (
    typeof identity.authorizationBinding !== "string" ||
    identity.authorizationBinding.length < 1
  ) {
    throw new TypeError("authorizationBinding must be non-empty");
  }
  validateOpaqueText(identity.idempotencyKey, "idempotencyKey");
  validateOpaqueText(identity.fingerprint, "fingerprint");
  return identity;
}

function validateOpaqueText(value: string, name: string): void {
  if (typeof value !== "string" || value.length < 1 || /[\0\r\n]/.test(value)) {
    throw new TypeError(`${name} is not a valid stable opaque value`);
  }
}

function validateOutcomeCode(code: string): string {
  if (!/^[A-Z][A-Z0-9_:-]{0,127}$/.test(code)) {
    throw new TypeError("Mutation outcome code is invalid");
  }
  return code;
}

function identityDigest(authorizationBinding: string, idempotencyKey: string): string {
  return createHash("sha256")
    .update("omnicodex-mutation-replay-v1\0", "utf8")
    .update(String(Buffer.byteLength(authorizationBinding)), "utf8")
    .update(":", "utf8")
    .update(authorizationBinding, "utf8")
    .update("\0", "utf8")
    .update(String(Buffer.byteLength(idempotencyKey)), "utf8")
    .update(":", "utf8")
    .update(idempotencyKey, "utf8")
    .digest("hex");
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Deterministic UUIDv5-shaped public ID suitable for downstream native operation IDs. */
function publicOperationId(recordId: string): string {
  const bytes = Buffer.from(recordId.slice(0, 32), "hex");
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error("Mutation replay record digest is invalid");
  }
  bytes[6] = (versionByte & 0x0f) | 0x50;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function deferredAttempt(attemptId: string): RuntimeAttempt {
  let resolveCompletion:
    | ((result: MutationReplayTerminal<MutationReplayJsonValue>) => void)
    | undefined;
  const completion = new Promise<MutationReplayTerminal<MutationReplayJsonValue>>((resolve) => {
    resolveCompletion = resolve;
  });
  return {
    attemptId,
    completion,
    resolve: (result) => {
      if (resolveCompletion === undefined) return;
      const resolve = resolveCompletion;
      resolveCompletion = undefined;
      resolve(result);
    },
  };
}

function cloneCompletion<T extends MutationReplayJsonValue>(
  completion: Promise<MutationReplayTerminal<MutationReplayJsonValue>>,
): Promise<MutationReplayTerminal<T>> {
  return completion.then((terminal) => {
    if (terminal.kind === "completed") {
      return { kind: "completed", value: cloneJson(terminal.value) as T };
    }
    return { ...terminal };
  });
}

function cloneJson<T extends MutationReplayJsonValue>(value: T): T {
  assertJsonValue(value, new Set<object>(), "$result");
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
  if (typeof value !== "object") {
    throw new TypeError(`${path} is not a JSON value`);
  }
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (descriptor === undefined) throw new TypeError(`${path} contains a sparse array`);
        if (!descriptor.enumerable || !("value" in descriptor)) {
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

async function loadSnapshot(path: string): Promise<LoadedSnapshot> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return { revision: 0, records: new Map() };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MutationReplaySnapshotError("Mutation replay snapshot is not valid JSON");
  }
  const snapshot = parseSnapshot(parsed);
  const expectedChecksum = checksum(snapshot);
  if (snapshot.checksum !== expectedChecksum) {
    throw new MutationReplaySnapshotError("Mutation replay snapshot checksum mismatch");
  }
  const records = new Map<string, StoredRecord>();
  for (const record of snapshot.records) {
    records.set(record.recordId, record);
  }
  return { revision: snapshot.revision, records };
}

function parseSnapshot(value: unknown): StoredSnapshot {
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
    throw new MutationReplaySnapshotError("Mutation replay snapshot has an invalid envelope");
  }
  const revision = value.revision as number;
  const records = value.records.map((record, index) => parseRecord(record, index, revision));
  if (new Set(records.map((record) => record.recordId)).size !== records.length) {
    throw new MutationReplaySnapshotError("Mutation replay snapshot contains duplicate records");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    revision,
    records,
    checksum: value.checksum,
  };
}

function parseRecord(value: unknown, index: number, revision: number): SnapshotRecord {
  const invalid = () => {
    throw new MutationReplaySnapshotError(`Mutation replay record ${index + 1} is invalid`);
  };
  if (
    !isObject(value) ||
    typeof value.recordId !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.recordId) ||
    typeof value.fingerprintDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.fingerprintDigest) ||
    typeof value.attemptId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value.attemptId,
    ) ||
    !validTimestamp(value.createdAtUnixMs) ||
    !validTimestamp(value.updatedAtUnixMs) ||
    value.updatedAtUnixMs < value.createdAtUnixMs
  ) {
    return invalid();
  }
  const commonKeys = [
    "recordId",
    "fingerprintDigest",
    "state",
    "attemptId",
    "createdAtUnixMs",
    "updatedAtUnixMs",
  ];
  const base = {
    recordId: value.recordId,
    fingerprintDigest: value.fingerprintDigest,
    attemptId: value.attemptId,
    createdAtUnixMs: value.createdAtUnixMs,
    updatedAtUnixMs: value.updatedAtUnixMs,
  };
  if (value.state === "prepared" || value.state === "dispatched") {
    if (!hasOnlyKeys(value, commonKeys)) return invalid();
    return { ...base, state: value.state };
  }
  if (
    !Number.isSafeInteger(value.terminalSequence) ||
    (value.terminalSequence as number) < 1 ||
    (value.terminalSequence as number) > revision
  ) {
    return invalid();
  }
  if (value.state === "completed") {
    if (!hasOnlyKeys(value, [...commonKeys, "terminalSequence", "value"])) return invalid();
    try {
      return {
        ...base,
        state: "completed",
        terminalSequence: value.terminalSequence as number,
        value: cloneJson(value.value as MutationReplayJsonValue),
      };
    } catch {
      return invalid();
    }
  }
  if (value.state === "result_replay_expired") {
    if (!hasOnlyKeys(value, [...commonKeys, "terminalSequence"])) return invalid();
    return {
      ...base,
      state: "result_replay_expired",
      terminalSequence: value.terminalSequence as number,
    };
  }
  if (value.state === "outcome_unknown" && typeof value.code === "string") {
    if (!hasOnlyKeys(value, [...commonKeys, "terminalSequence", "code"])) return invalid();
    try {
      return {
        ...base,
        state: "outcome_unknown",
        terminalSequence: value.terminalSequence as number,
        code: validateOutcomeCode(value.code),
      };
    } catch {
      return invalid();
    }
  }
  return invalid();
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
    await handle.writeFile(`${canonicalJson(snapshot)}\n`, "utf8");
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

function checksum(payload: SnapshotPayload): string {
  const checksummed: SnapshotPayload = {
    schemaVersion: payload.schemaVersion,
    revision: payload.revision,
    records: payload.records,
  };
  return createHash("sha256").update(canonicalJson(checksummed), "utf8").digest("hex");
}

function checkedTimestamp(value: number): number {
  if (!validTimestamp(value))
    throw new RangeError("Mutation replay clock returned an invalid time");
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
