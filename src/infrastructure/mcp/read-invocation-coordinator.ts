import { createHash, randomUUID } from "node:crypto";

export type ReadInvocationJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ReadInvocationJsonValue[]
  | { readonly [key: string]: ReadInvocationJsonValue };

export interface ReadInvocationIdentity {
  /** Stable authorization principal. It is hashed before being retained. */
  readonly authorizationBinding: string;
  /** Caller-supplied cross-transport invocation identity. It is never retained verbatim. */
  readonly invocationId: string;
  /** Exact native target identity. It is hashed before being retained. */
  readonly targetIdentity: string;
  /** SHA-256 of the stripped canonical native request contract and arguments. */
  readonly fingerprint: string;
  /**
   * Explicit tool-call identities are strict. Transport identities may be
   * shared by several distinct tool calls in one model turn, so their
   * canonical request fingerprint also participates in the coordination key.
   * Only overlapping transport reads can join; a completed result requires an
   * explicit invocation identity for replay. A trace is not a tool-call id.
   */
  readonly scope?: "explicit" | "transport";
}

/**
 * Retains the exact native arguments in a read fingerprint. A field named
 * `title` can be a native search condition, not just a presentation label.
 * Transport-only fields must be stripped by their owning contract before
 * this boundary; their names cannot be inferred for arbitrary native tools.
 */
export function readInvocationSemanticArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return args;
}

export interface ReadInvocationCoordinatorOptions {
  readonly replayTtlMs?: number;
  readonly maxCompletedEntries?: number;
  readonly maxCompletedBytes?: number;
  readonly maxReplayValueBytes?: number;
  readonly nowUnixMs?: () => number;
}

export interface ReadInvocationExecution<T extends ReadInvocationJsonValue> {
  readonly operationId: string;
  readonly completion: Promise<T>;
  /** Publishes the result to current joiners and optionally retains a short successful replay. */
  finish(value: T, replayable?: boolean): void;
  /** Releases the identity immediately so a later request can retry. */
  fail(error: unknown): void;
}

export type ReadInvocationAcquisition<T extends ReadInvocationJsonValue> =
  | {
      readonly kind: "execute";
      readonly operationId: string;
      readonly execution: ReadInvocationExecution<T>;
    }
  | {
      readonly kind: "join";
      readonly operationId: string;
      readonly completion: Promise<T>;
    }
  | {
      readonly kind: "replay";
      readonly operationId: string;
      readonly value: T;
    };

export class ReadInvocationConflictError extends Error {
  readonly code = "READ_INVOCATION_CONFLICT";

  constructor() {
    super("The same read invocation identity was used with different canonical arguments");
    this.name = "ReadInvocationConflictError";
  }
}

export class ReadInvocationStateError extends Error {
  readonly code = "READ_INVOCATION_INVALID_TRANSITION";

  constructor(message: string) {
    super(message);
    this.name = "ReadInvocationStateError";
  }
}

interface DeferredSerializedResult {
  readonly promise: Promise<string>;
  readonly resolve: (value: string) => void;
  readonly reject: (error: Error) => void;
}

interface InFlightEntry {
  readonly state: "in_flight";
  readonly keyDigest: string;
  readonly fingerprint: string;
  readonly operationId: string;
  readonly deferred: DeferredSerializedResult;
  readonly scope: "explicit" | "transport";
}

interface CompletedEntry {
  readonly state: "completed";
  readonly keyDigest: string;
  readonly fingerprint: string;
  readonly operationId: string;
  readonly serializedValue: string;
  readonly valueBytes: number;
  readonly expiresAtUnixMs?: number;
  lastAccessSequence: number;
}

type Entry = InFlightEntry | CompletedEntry;

/**
 * Runtime-generation-wide fan-in for explicit, side-effect-free native reads.
 *
 * This coordinator intentionally remains process-memory-only and short-lived:
 * it prevents model/transport retries from repeating an expensive read while
 * never carrying a prior runtime generation's snapshot across a hot switch.
 */
export class ReadInvocationCoordinator {
  readonly #replayTtlMs: number | undefined;
  readonly #maxCompletedEntries: number | undefined;
  readonly #maxCompletedBytes: number | undefined;
  readonly #maxReplayValueBytes: number | undefined;
  readonly #nowUnixMs: () => number;
  readonly #entries = new Map<string, Entry>();
  #completedBytes = 0;
  #accessSequence = 0;
  #transportGeneration = 0;

  constructor(options: ReadInvocationCoordinatorOptions = {}) {
    this.#replayTtlMs = optionalPositiveInteger(options.replayTtlMs, "Replay TTL");
    this.#maxCompletedEntries = optionalPositiveInteger(
      options.maxCompletedEntries,
      "Completed entry limit",
    );
    this.#maxCompletedBytes = optionalPositiveInteger(
      options.maxCompletedBytes,
      "Completed byte limit",
    );
    this.#maxReplayValueBytes = optionalPositiveInteger(
      options.maxReplayValueBytes,
      "Replay value byte limit",
    );
    if (
      this.#maxReplayValueBytes !== undefined &&
      this.#maxCompletedBytes !== undefined &&
      this.#maxReplayValueBytes > this.#maxCompletedBytes
    ) {
      throw new RangeError("Replay value byte limit cannot exceed the completed byte limit");
    }
    this.#nowUnixMs = options.nowUnixMs ?? Date.now;
  }

  acquire<T extends ReadInvocationJsonValue = ReadInvocationJsonValue>(
    identity: ReadInvocationIdentity,
  ): ReadInvocationAcquisition<T> {
    const validated = validateIdentity(identity);
    const now = checkedTimestamp(this.#nowUnixMs());
    this.#pruneExpired(now);
    const keyDigest =
      validated.scope === "transport"
        ? digestParts([validated.keyDigest, String(this.#transportGeneration)])
        : validated.keyDigest;
    const existing = this.#entries.get(keyDigest);
    if (existing !== undefined) {
      if (existing.fingerprint !== validated.fingerprint) {
        throw new ReadInvocationConflictError();
      }
      if (existing.state === "in_flight") {
        return {
          kind: "join",
          operationId: existing.operationId,
          completion: cloneCompletion<T>(existing.deferred.promise),
        };
      }
      existing.lastAccessSequence = ++this.#accessSequence;
      return {
        kind: "replay",
        operationId: existing.operationId,
        value: parseSerialized<T>(existing.serializedValue),
      };
    }

    const deferred = deferredSerializedResult();
    const entry: InFlightEntry = {
      state: "in_flight",
      keyDigest,
      fingerprint: validated.fingerprint,
      // The coordination key identifies join/replay eligibility, not a physical
      // execution. A finished transport read (or an evicted explicit read) may
      // execute again and must not reuse an earlier durable Goal receipt.
      operationId: `read-${randomUUID()}`,
      deferred,
      scope: validated.scope,
    };
    this.#entries.set(keyDigest, entry);
    const execution: ReadInvocationExecution<T> = {
      operationId: entry.operationId,
      completion: cloneCompletion<T>(deferred.promise),
      finish: (value, replayable = true) => {
        const current = this.#entries.get(entry.keyDigest);
        if (current !== entry) {
          throw new ReadInvocationStateError("Read execution is stale or already terminal");
        }
        let serialized: string;
        try {
          serialized = serializeJson(value);
        } catch (error) {
          this.#entries.delete(entry.keyDigest);
          deferred.reject(toError(error));
          throw error;
        }
        const valueBytes = Buffer.byteLength(serialized, "utf8");
        if (
          replayable &&
          entry.scope === "explicit" &&
          (this.#maxReplayValueBytes === undefined || valueBytes <= this.#maxReplayValueBytes)
        ) {
          const completedAtUnixMs = checkedTimestamp(this.#nowUnixMs());
          const completed: CompletedEntry = {
            state: "completed",
            keyDigest: entry.keyDigest,
            fingerprint: entry.fingerprint,
            operationId: entry.operationId,
            serializedValue: serialized,
            valueBytes,
            ...(this.#replayTtlMs === undefined
              ? {}
              : { expiresAtUnixMs: checkedDeadline(completedAtUnixMs, this.#replayTtlMs) }),
            lastAccessSequence: ++this.#accessSequence,
          };
          this.#entries.set(entry.keyDigest, completed);
          this.#completedBytes += valueBytes;
          this.#pruneCompleted();
        } else {
          this.#entries.delete(entry.keyDigest);
        }
        deferred.resolve(serialized);
      },
      fail: (error) => {
        const current = this.#entries.get(entry.keyDigest);
        if (current !== entry) {
          throw new ReadInvocationStateError("Read execution is stale or already terminal");
        }
        this.#entries.delete(entry.keyDigest);
        deferred.reject(toError(error));
      },
    };
    return { kind: "execute", operationId: entry.operationId, execution };
  }

  /**
   * Separates new model-turn reads from reads still in flight before a physical
   * mutation. Explicit caller-owned invocation receipts are preserved.
   */
  invalidateTransient(): void {
    this.#transportGeneration =
      this.#transportGeneration === Number.MAX_SAFE_INTEGER ? 0 : this.#transportGeneration + 1;
  }

  #pruneExpired(now: number): void {
    if (this.#replayTtlMs === undefined) return;
    for (const entry of this.#entries.values()) {
      if (
        entry.state === "completed" &&
        entry.expiresAtUnixMs !== undefined &&
        now >= entry.expiresAtUnixMs
      ) {
        this.#deleteCompleted(entry);
      }
    }
  }

  #pruneCompleted(): void {
    // The production contract retains results without arbitrary caps. Do not
    // copy and sort the whole history on every completion when no eviction
    // policy exists; that makes a long-running session increasingly expensive.
    if (this.#maxCompletedEntries === undefined && this.#maxCompletedBytes === undefined) return;
    const completed = [...this.#entries.values()]
      .filter((entry): entry is CompletedEntry => entry.state === "completed")
      .sort(
        (left, right) =>
          left.lastAccessSequence - right.lastAccessSequence ||
          left.keyDigest.localeCompare(right.keyDigest),
      );
    let completedCount = completed.length;
    for (const entry of completed) {
      if (
        (this.#maxCompletedEntries === undefined || completedCount <= this.#maxCompletedEntries) &&
        (this.#maxCompletedBytes === undefined || this.#completedBytes <= this.#maxCompletedBytes)
      ) {
        break;
      }
      this.#deleteCompleted(entry);
      completedCount -= 1;
    }
  }

  #deleteCompleted(entry: CompletedEntry): void {
    if (this.#entries.get(entry.keyDigest) !== entry) return;
    this.#entries.delete(entry.keyDigest);
    this.#completedBytes = Math.max(0, this.#completedBytes - entry.valueBytes);
  }
}

function validateIdentity(identity: ReadInvocationIdentity): {
  readonly keyDigest: string;
  readonly fingerprint: string;
  readonly scope: "explicit" | "transport";
} {
  const authorizationBinding = boundedIdentity(
    identity.authorizationBinding,
    "Authorization binding",
  );
  const invocationId = boundedIdentity(identity.invocationId, "Invocation ID");
  const targetIdentity = boundedIdentity(identity.targetIdentity, "Target identity");
  if (!/^[a-f0-9]{64}$/u.test(identity.fingerprint)) {
    throw new TypeError("Read invocation fingerprint must be a lowercase SHA-256 digest");
  }
  const scope = identity.scope ?? "explicit";
  if (scope !== "explicit" && scope !== "transport") {
    throw new TypeError("Read invocation scope must be explicit or transport");
  }
  const keyParts = [authorizationBinding, scope, invocationId, targetIdentity];
  return {
    keyDigest: digestParts(scope === "transport" ? [...keyParts, identity.fingerprint] : keyParts),
    fingerprint: identity.fingerprint,
    scope,
  };
}

function boundedIdentity(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 1) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function digestParts(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.byteLength(part, "utf8");
    hash.update(String(bytes), "utf8");
    hash.update(":", "utf8");
    hash.update(part, "utf8");
  }
  return hash.digest("hex");
}

function deferredSerializedResult(): DeferredSerializedResult {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // The elected execution may have no followers. Mark the rejection handled
  // without changing the promise observed by any later joiner.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function cloneCompletion<T extends ReadInvocationJsonValue>(promise: Promise<string>): Promise<T> {
  const completion = promise.then((serialized) => parseSerialized<T>(serialized));
  void completion.catch(() => undefined);
  return completion;
}

function serializeJson(value: ReadInvocationJsonValue): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Read result is not JSON serializable");
  return serialized;
}

function parseSerialized<T extends ReadInvocationJsonValue>(serialized: string): T {
  return JSON.parse(serialized) as T;
}

function optionalPositiveInteger(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function checkedTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Read invocation coordinator clock returned an invalid timestamp");
  }
  return value;
}

function checkedDeadline(now: number, ttlMs: number): number {
  const deadline = now + ttlMs;
  if (!Number.isSafeInteger(deadline)) {
    throw new RangeError("Read invocation replay deadline exceeds the timestamp range");
  }
  return deadline;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
