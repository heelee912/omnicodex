import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  type FileHandle,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type CodexThreadFollowUpOptions,
  normalizeCodexThreadSettingsOverride,
} from "../../application/codex-thread-message-client.js";
import { omniCodexDataDirectory } from "../config/omnicodex-config-store.js";

const STORE_VERSION = 1;
const STALE_LOCK_MS = 2 * 60_000;
const LOCK_RETRY_DELAY_MS = 25;

export type CodexThreadFollowUpTransport = "desktop_ipc" | "detached_app_server";

export interface PersistedCodexThreadFollowUp {
  readonly clientUserMessageId: string;
  readonly threadId: string;
  readonly prompt: string;
  readonly promptSha256: string;
  readonly cwd?: string;
  readonly hostId?: string;
  readonly threadSettings?: CodexThreadFollowUpOptions["threadSettings"];
  readonly acceptedAt: number;
  readonly transport: CodexThreadFollowUpTransport;
  readonly claim?: {
    readonly ownerId: string;
    readonly processId?: number;
    readonly expiresAt?: number;
  };
}

export interface CodexThreadFollowUpQueueReadback {
  readonly clientUserMessageId: string;
  readonly acceptedAt: number;
  readonly position: number;
  readonly persisted: true;
  readonly dispatchAfter: "active_turn_terminal";
}

interface QueueDocument {
  readonly version: 1;
  readonly items: readonly PersistedCodexThreadFollowUp[];
}

export interface CodexThreadFollowUpQueueStoreOptions {
  readonly path?: string;
  /** Optional default lock-acquisition boundary. Omitted means no cutoff. */
  readonly lockTimeoutMs?: number;
  /** Optional claim-recovery lease. Omitted claims remain owned until release/acknowledge. */
  readonly claimLeaseMs?: number;
  readonly now?: () => number;
}

export interface CodexThreadFollowUpQueueOperationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly deadlineUnixMs?: number;
}

interface LockAcquisitionBoundary {
  readonly signal?: AbortSignal;
  readonly deadlineUnixMs?: number;
}

/**
 * Process-shared, owner-profile queue for accepted follow-up mutations. Every
 * read/modify/write transaction is protected by an inter-process lock and the
 * document is replaced atomically. Prompts remain inside the OmniCodex data
 * directory and are created with owner-only POSIX modes (the Windows profile
 * ACL remains authoritative on Windows).
 */
export class CodexThreadFollowUpQueueStore {
  readonly #path: string;
  readonly #lockPath: string;
  readonly #lockTimeoutMs: number | undefined;
  readonly #claimLeaseMs: number | undefined;
  readonly #now: () => number;

  constructor(options: CodexThreadFollowUpQueueStoreOptions = {}) {
    this.#path =
      options.path ?? join(omniCodexDataDirectory(), "codex-thread-follow-up-queue.json");
    this.#lockPath = `${this.#path}.lock`;
    this.#lockTimeoutMs = optionalPositiveInteger(options.lockTimeoutMs, "lockTimeoutMs");
    this.#claimLeaseMs = optionalPositiveInteger(options.claimLeaseMs, "claimLeaseMs");
    this.#now = options.now ?? Date.now;
  }

  async enqueue(
    transport: CodexThreadFollowUpTransport,
    threadId: string,
    prompt: string,
    options: CodexThreadFollowUpOptions,
    operationOptions: CodexThreadFollowUpQueueOperationOptions = {},
  ): Promise<CodexThreadFollowUpQueueReadback> {
    const clientUserMessageId = requiredString(options.clientUserMessageId, "clientUserMessageId");
    const threadSettings = normalizeCodexThreadSettingsOverride(options.threadSettings);
    const candidate: PersistedCodexThreadFollowUp = {
      clientUserMessageId,
      threadId: requiredString(threadId, "threadId"),
      prompt: requiredString(prompt, "prompt"),
      promptSha256: promptDigest(prompt),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.hostId === undefined ? {} : { hostId: options.hostId }),
      ...(threadSettings === undefined ? {} : { threadSettings }),
      acceptedAt: this.#now(),
      transport,
    };
    return this.#transaction((document) => {
      const existingIndex = document.items.findIndex(
        (item) => item.clientUserMessageId === clientUserMessageId,
      );
      if (existingIndex >= 0) {
        const existing = document.items[existingIndex];
        if (existing === undefined || !sameMutation(existing, candidate)) {
          throw new Error(
            `Codex thread clientUserMessageId ${clientUserMessageId} was reused with different input`,
          );
        }
        return {
          document,
          value: queueReadback(existing, queuePosition(document.items, existingIndex)),
        };
      }
      const items = [...document.items, candidate];
      return {
        document: { version: STORE_VERSION, items },
        value: queueReadback(candidate, queuePosition(items, items.length - 1)),
      };
    }, operationOptions);
  }

  async list(
    transport: CodexThreadFollowUpTransport,
    threadId?: string,
    operationOptions: CodexThreadFollowUpQueueOperationOptions = {},
  ): Promise<readonly PersistedCodexThreadFollowUp[]> {
    return this.#transaction(
      (document) => ({
        document,
        value: document.items.filter(
          (item) =>
            item.transport === transport && (threadId === undefined || item.threadId === threadId),
        ),
      }),
      operationOptions,
    );
  }

  async claim(
    clientUserMessageId: string,
    ownerId: string,
    operationOptions: CodexThreadFollowUpQueueOperationOptions = {},
  ): Promise<PersistedCodexThreadFollowUp | null> {
    return this.#transaction((document) => {
      const index = document.items.findIndex(
        (item) => item.clientUserMessageId === clientUserMessageId,
      );
      const item = document.items[index];
      if (item === undefined) return { document, value: null };
      const now = this.#now();
      if (item.claim !== undefined && claimIsActive(item.claim, now)) {
        return { document, value: null };
      }
      const claimed: PersistedCodexThreadFollowUp = {
        ...item,
        claim: {
          ownerId,
          processId: process.pid,
          ...(this.#claimLeaseMs === undefined
            ? {}
            : { expiresAt: checkedFutureTimestamp(now, this.#claimLeaseMs, "claimLeaseMs") }),
        },
      };
      const items = [...document.items];
      items[index] = claimed;
      return { document: { version: STORE_VERSION, items }, value: claimed };
    }, operationOptions);
  }

  async release(
    clientUserMessageId: string,
    ownerId: string,
    operationOptions: CodexThreadFollowUpQueueOperationOptions = {},
  ): Promise<void> {
    await this.#transaction((document) => {
      const index = document.items.findIndex(
        (item) => item.clientUserMessageId === clientUserMessageId,
      );
      const item = document.items[index];
      if (item === undefined || item.claim?.ownerId !== ownerId) {
        return { document, value: undefined };
      }
      const { claim: _claim, ...released } = item;
      const items = [...document.items];
      items[index] = released;
      return { document: { version: STORE_VERSION, items }, value: undefined };
    }, operationOptions);
  }

  async acknowledge(
    clientUserMessageId: string,
    ownerId?: string,
    operationOptions: CodexThreadFollowUpQueueOperationOptions = {},
  ): Promise<boolean> {
    return this.#transaction((document) => {
      const index = document.items.findIndex(
        (item) => item.clientUserMessageId === clientUserMessageId,
      );
      const item = document.items[index];
      if (
        item === undefined ||
        (ownerId !== undefined && item.claim !== undefined && item.claim.ownerId !== ownerId)
      ) {
        return { document, value: false };
      }
      const items = [...document.items.slice(0, index), ...document.items.slice(index + 1)];
      return { document: { version: STORE_VERSION, items }, value: true };
    }, operationOptions);
  }

  async #transaction<T>(
    operation: (document: QueueDocument) => { readonly document: QueueDocument; readonly value: T },
    options: CodexThreadFollowUpQueueOperationOptions,
  ): Promise<T> {
    const boundary = lockAcquisitionBoundary(options, this.#lockTimeoutMs, this.#now);
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.#path), 0o700).catch(() => undefined);
    const lock = await this.#acquireLock(boundary);
    try {
      const current = await this.#readDocument();
      const result = operation(current);
      if (result.document !== current) await this.#writeDocument(result.document);
      return result.value;
    } finally {
      await lock.release();
    }
  }

  async #readDocument(): Promise<QueueDocument> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.#path, "utf8"));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { version: STORE_VERSION, items: [] };
      throw error;
    }
    return validateDocument(parsed);
  }

  async #writeDocument(document: QueueDocument): Promise<void> {
    const tempPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(document)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(tempPath, this.#path);
      await chmod(this.#path, 0o600).catch(() => undefined);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  async #acquireLock(boundary: LockAcquisitionBoundary): Promise<{ release(): Promise<void> }> {
    const token = randomUUID();
    for (;;) {
      throwIfLockBoundaryElapsed(boundary, this.#now);
      let handle: FileHandle | undefined;
      let created = false;
      try {
        handle = await open(this.#lockPath, "wx", 0o600);
        created = true;
        await handle.writeFile(
          JSON.stringify({ token, acquiredAt: this.#now(), processId: process.pid }),
          "utf8",
        );
        await handle.sync();
        try {
          throwIfLockBoundaryElapsed(boundary, this.#now);
        } catch (error) {
          await handle.close().catch(() => undefined);
          handle = undefined;
          await unlink(this.#lockPath).catch(() => undefined);
          throw error;
        }
        return {
          release: async () => {
            await handle?.close().catch(() => undefined);
            let ownerToken: string | undefined;
            try {
              ownerToken = asRecord(JSON.parse(await readFile(this.#lockPath, "utf8"))).token as
                | string
                | undefined;
            } catch {
              ownerToken = undefined;
            }
            if (ownerToken === token) await unlink(this.#lockPath).catch(() => undefined);
          },
        };
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (errorCode(error) !== "EEXIST") {
          if (created) await unlink(this.#lockPath).catch(() => undefined);
          throw error;
        }
        await this.#reclaimStaleLock();
        throwIfLockBoundaryElapsed(boundary, this.#now);
        await delayWithBoundary(LOCK_RETRY_DELAY_MS, boundary, this.#now);
      }
    }
  }

  async #reclaimStaleLock(): Promise<void> {
    try {
      const lockStat = await stat(this.#lockPath);
      let metadata: Record<string, unknown> = {};
      try {
        metadata = asRecord(JSON.parse(await readFile(this.#lockPath, "utf8")));
      } catch {
        // An incomplete lock file is reclaimed only after its stale horizon.
      }
      const acquiredAt = metadata.acquiredAt;
      const age =
        typeof acquiredAt === "number" && Number.isFinite(acquiredAt)
          ? this.#now() - acquiredAt
          : this.#now() - lockStat.mtimeMs;
      if (age < STALE_LOCK_MS) return;
      const processId = metadata.processId;
      if (typeof processId === "number" && Number.isSafeInteger(processId) && processId > 0) {
        if (processIsAlive(processId)) return;
      }
      // Atomically move the abandoned inode out of the lock namespace before
      // deleting it. Concurrent reclaimers then cannot unlink a fresh lock
      // that another writer acquired after the stale path disappeared.
      const abandonedPath = `${this.#lockPath}.${randomUUID()}.stale`;
      await rename(this.#lockPath, abandonedPath);
      await unlink(abandonedPath).catch(() => undefined);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return;
    }
  }
}

function validateDocument(value: unknown): QueueDocument {
  const record = asRecord(value);
  if (record.version !== STORE_VERSION || !Array.isArray(record.items)) {
    throw new Error("Invalid Codex follow-up queue document");
  }
  return {
    version: STORE_VERSION,
    items: record.items.map(validateItem),
  };
}

function validateItem(value: unknown): PersistedCodexThreadFollowUp {
  const item = asRecord(value);
  const transport = item.transport;
  if (transport !== "desktop_ipc" && transport !== "detached_app_server") {
    throw new Error("Invalid Codex follow-up queue transport");
  }
  const prompt = requiredString(item.prompt, "prompt");
  const promptSha256 = requiredString(item.promptSha256, "promptSha256");
  if (promptDigest(prompt) !== promptSha256) {
    throw new Error("Codex follow-up queue prompt digest mismatch");
  }
  const acceptedAt = item.acceptedAt;
  if (typeof acceptedAt !== "number" || !Number.isSafeInteger(acceptedAt) || acceptedAt < 0) {
    throw new Error("Invalid Codex follow-up queue acceptedAt");
  }
  const claimRecord = item.claim === undefined ? undefined : asRecord(item.claim);
  const claim =
    claimRecord === undefined
      ? undefined
      : {
          ownerId: requiredString(claimRecord.ownerId, "claim.ownerId"),
          ...(claimRecord.processId === undefined
            ? {}
            : {
                processId: requiredPositiveSafeInteger(claimRecord.processId, "claim.processId"),
              }),
          ...(claimRecord.expiresAt === undefined
            ? {}
            : { expiresAt: requiredSafeInteger(claimRecord.expiresAt, "claim.expiresAt") }),
        };
  const threadSettingsRecord =
    item.threadSettings === undefined ? undefined : asRecord(item.threadSettings);
  const threadSettings = normalizeCodexThreadSettingsOverride(
    threadSettingsRecord === undefined
      ? undefined
      : {
          ...(typeof threadSettingsRecord.model === "string"
            ? { model: threadSettingsRecord.model }
            : {}),
          ...(threadSettingsRecord.effort === undefined
            ? {}
            : {
                effort:
                  threadSettingsRecord.effort === null
                    ? null
                    : requiredString(threadSettingsRecord.effort, "threadSettings.effort"),
              }),
        },
  );
  return {
    clientUserMessageId: requiredString(item.clientUserMessageId, "clientUserMessageId"),
    threadId: requiredString(item.threadId, "threadId"),
    prompt,
    promptSha256,
    ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
    ...(typeof item.hostId === "string" ? { hostId: item.hostId } : {}),
    ...(threadSettings === undefined ? {} : { threadSettings }),
    acceptedAt,
    transport,
    ...(claim === undefined ? {} : { claim }),
  };
}

function sameMutation(
  left: PersistedCodexThreadFollowUp,
  right: PersistedCodexThreadFollowUp,
): boolean {
  return (
    left.threadId === right.threadId &&
    left.promptSha256 === right.promptSha256 &&
    left.cwd === right.cwd &&
    left.hostId === right.hostId &&
    left.transport === right.transport &&
    JSON.stringify(left.threadSettings) === JSON.stringify(right.threadSettings)
  );
}

function queuePosition(items: readonly PersistedCodexThreadFollowUp[], index: number): number {
  const item = items[index];
  if (item === undefined) return 0;
  return items
    .slice(0, index + 1)
    .filter(
      (candidate) => candidate.threadId === item.threadId && candidate.transport === item.transport,
    ).length;
}

function queueReadback(
  item: PersistedCodexThreadFollowUp,
  position: number,
): CodexThreadFollowUpQueueReadback {
  return {
    clientUserMessageId: item.clientUserMessageId,
    acceptedAt: item.acceptedAt,
    position,
    persisted: true,
    dispatchAfter: "active_turn_terminal",
  };
}

function promptDigest(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function requiredSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function requiredPositiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function optionalPositiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function lockAcquisitionBoundary(
  options: CodexThreadFollowUpQueueOperationOptions,
  configuredTimeoutMs: number | undefined,
  now: () => number,
): LockAcquisitionBoundary {
  options.signal?.throwIfAborted();
  const current = now();
  const deadlines: number[] = [];
  for (const [timeout, name] of [
    [configuredTimeoutMs, "lockTimeoutMs"],
    [options.timeoutMs, "timeoutMs"],
  ] as const) {
    if (timeout === undefined) continue;
    if (!Number.isSafeInteger(timeout) || timeout <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
    deadlines.push(checkedFutureTimestamp(current, timeout, name));
  }
  if (options.deadlineUnixMs !== undefined) {
    if (!Number.isSafeInteger(options.deadlineUnixMs) || options.deadlineUnixMs < 0) {
      throw new RangeError("deadlineUnixMs must be a non-negative safe integer");
    }
    deadlines.push(options.deadlineUnixMs);
  }
  const deadlineUnixMs = deadlines.length === 0 ? undefined : Math.min(...deadlines);
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(deadlineUnixMs === undefined ? {} : { deadlineUnixMs }),
  };
}

function checkedFutureTimestamp(now: number, durationMs: number, name: string): number {
  if (!Number.isSafeInteger(now) || now < 0 || durationMs > Number.MAX_SAFE_INTEGER - now) {
    throw new RangeError(`${name} exceeds the representable timestamp range`);
  }
  return now + durationMs;
}

function throwIfLockBoundaryElapsed(boundary: LockAcquisitionBoundary, now: () => number): void {
  if (boundary.signal?.aborted === true) throw abortReason(boundary.signal);
  if (boundary.deadlineUnixMs !== undefined && boundary.deadlineUnixMs <= now()) {
    const error = new Error("Timed out acquiring Codex follow-up queue lock");
    error.name = "TimeoutError";
    throw error;
  }
}

function delayWithBoundary(
  milliseconds: number,
  boundary: LockAcquisitionBoundary,
  now: () => number,
): Promise<void> {
  throwIfLockBoundaryElapsed(boundary, now);
  const remaining =
    boundary.deadlineUnixMs === undefined
      ? milliseconds
      : Math.min(milliseconds, Math.max(1, boundary.deadlineUnixMs - now()));
  return new Promise((resolve, reject) => {
    const signal = boundary.signal;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, remaining);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(
    signal?.reason === undefined
      ? "Codex follow-up queue lock acquisition was aborted"
      : `Codex follow-up queue lock acquisition was aborted: ${String(signal.reason)}`,
  );
  error.name = "AbortError";
  return error;
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function claimIsActive(
  claim: NonNullable<PersistedCodexThreadFollowUp["claim"]>,
  now: number,
): boolean {
  if (claim.processId !== undefined && !processIsAlive(claim.processId)) return false;
  return claim.expiresAt === undefined || claim.expiresAt > now;
}
