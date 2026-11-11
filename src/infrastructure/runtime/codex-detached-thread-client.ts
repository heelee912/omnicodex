import { randomUUID } from "node:crypto";
import { answerAppServerApprovalRequest } from "../../application/app-server-request-handler.js";
import {
  type CodexThreadFollowUpOptions,
  type CodexThreadFollowUpResult,
  type CodexThreadMessageClient,
  CodexThreadPreDispatchError,
  CodexThreadUnknownDispatchError,
  isUnknownThreadDispatch,
  normalizeCodexThreadSettingsOverride,
} from "../../application/codex-thread-message-client.js";
import type {
  AppServerRpcClient,
  AppServerRpcRequestOptions,
} from "../../application/native-tool-catalog.js";
import type { RuntimeCandidate } from "../../domain/runtime.js";
import { CodexAppServerConnection } from "./codex-app-server-connection.js";
import type { CodexAppServerProcessOptions } from "./codex-app-server-process.js";
import {
  CodexThreadFollowUpQueueStore,
  type PersistedCodexThreadFollowUp,
} from "./codex-thread-follow-up-queue-store.js";
import type { JsonObject } from "./jsonl-rpc-client.js";
import type { CodexAppServerOwnershipRegistry } from "./owned-codex-app-server-registry.js";

const QUEUE_RETRY_DELAY_MS = 5_000;

export interface CodexDetachedThreadClientOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly completionTimeoutMs?: number;
  readonly replayWindowMs?: number;
  readonly onDiagnostic?: (message: JsonObject) => void;
  readonly onDynamicToolCall?: (params: Record<string, unknown>) => Promise<unknown> | unknown;
  readonly createProcess?: CodexDetachedAppServerProcessFactory;
  readonly ownershipRegistry?: CodexAppServerOwnershipRegistry;
  readonly queueStore?: CodexThreadFollowUpQueueStore;
  readonly recoverQueue?: boolean;
}

export interface CodexDetachedAppServerProcess {
  readonly client: AppServerRpcClient;
  readonly identity: { readonly ownershipNonce: string | undefined };
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type CodexDetachedAppServerProcessFactory = (
  candidate: RuntimeCandidate,
  options: CodexAppServerProcessOptions,
) => CodexDetachedAppServerProcess;

interface DetachedWorker {
  readonly process: CodexDetachedAppServerProcess;
  readonly threadId: string;
  readonly ownerClientId: string;
  readonly terminal: Deferred<void>;
  readonly closed: Deferred<void>;
  turnId: string | undefined;
  terminalObserved: boolean;
}

interface ReplayEntry {
  readonly fingerprint: string;
  readonly completion: Promise<CodexThreadFollowUpResult>;
  expiresAt?: number;
}

interface FollowUpBoundary {
  readonly deadlineUnixMs?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * Runs an inactive existing thread through a short-lived App Server transport.
 * The worker closes after the matching turn. Active desktop-owned threads
 * never enter this client.
 */
export class CodexDetachedThreadClient implements CodexThreadMessageClient {
  readonly #candidate: RuntimeCandidate;
  readonly #options: CodexDetachedThreadClientOptions;
  readonly #workers = new Map<string, DetachedWorker>();
  readonly #threadTails = new Map<string, Promise<void>>();
  readonly #replays = new Map<string, ReplayEntry>();
  readonly #queueStore: CodexThreadFollowUpQueueStore;
  readonly #queueOwnerId = randomUUID();
  readonly #queueDrains = new Map<string, Promise<void>>();
  readonly #completionTimeoutMs: number | undefined;
  readonly #replayWindowMs: number | undefined;
  #disposed = false;

  constructor(candidate: RuntimeCandidate, options: CodexDetachedThreadClientOptions = {}) {
    this.#candidate = candidate;
    this.#options = options;
    this.#queueStore = options.queueStore ?? new CodexThreadFollowUpQueueStore();
    this.#completionTimeoutMs = optionalTimeout(options.completionTimeoutMs, "completionTimeoutMs");
    this.#replayWindowMs = optionalTimeout(options.replayWindowMs, "replayWindowMs");
    if (options.recoverQueue !== false) void this.#recoverQueuedFollowUps();
  }

  async sendFollowUpMessage(
    threadIdValue: string,
    promptValue: string,
    options: CodexThreadFollowUpOptions = {},
  ): Promise<CodexThreadFollowUpResult> {
    if (this.#disposed) throw new Error("Codex detached thread client is disposed");
    const threadId = requiredString(threadIdValue, "threadId");
    const prompt = requiredPrompt(promptValue);
    const threadSettings = normalizeCodexThreadSettingsOverride(options.threadSettings);
    const { threadSettings: _discardedThreadSettings, ...optionsWithoutThreadSettings } = options;
    options = {
      ...optionsWithoutThreadSettings,
      ...(threadSettings === undefined ? {} : { threadSettings }),
    };
    const boundary = followUpBoundary(options);
    throwIfFollowUpBoundaryElapsed(boundary);
    const clientUserMessageId = options.clientUserMessageId ?? randomUUID();
    const replayKey = clientUserMessageId;
    const fingerprint = followUpFingerprint(threadId, prompt, options);
    if (this.#replayWindowMs !== undefined) {
      const now = Date.now();
      for (const [key, candidate] of this.#replays) {
        if (candidate.expiresAt !== undefined && candidate.expiresAt <= now) {
          this.#replays.delete(key);
        }
      }
    }
    const replay = this.#replays.get(replayKey);
    if (replay !== undefined) {
      assertMatchingReplay(replayKey, replay.fingerprint, fingerprint);
      return replay.completion;
    }

    const dispatchOptions: CodexThreadFollowUpOptions = {
      ...options,
      clientUserMessageId,
      ...(boundary.deadlineUnixMs === undefined ? {} : { deadlineUnixMs: boundary.deadlineUnixMs }),
    };
    let completion!: Promise<CodexThreadFollowUpResult>;
    completion = this.#withThreadLock(
      threadId,
      async () => {
        const active = this.#workers.get(threadId);
        if (active !== undefined) {
          const queue = await this.#queueStore.enqueue(
            "detached_app_server",
            threadId,
            prompt,
            dispatchOptions,
            followUpQueueOperationOptions(boundary),
          );
          this.#ensureQueueDrain(threadId);
          const queued: CodexThreadFollowUpResult = {
            threadId,
            ownerClientId: active.ownerClientId,
            disposition: "queued",
            clientUserMessageId,
            nativeResult: { queue },
            transport: "detached_app_server",
            queue,
          };
          return queued;
        }
        return this.#start(threadId, prompt, dispatchOptions);
      },
      boundary,
    ).then(
      (result) => {
        const current = this.#replays.get(replayKey);
        if (current?.completion === completion) {
          setReplayExpiry(current, this.#replayWindowMs);
        }
        return result;
      },
      (error: unknown) => {
        const current = this.#replays.get(replayKey);
        if (current?.completion === completion) {
          if (isUnknownThreadDispatch(error)) {
            setReplayExpiry(current, this.#replayWindowMs);
          } else {
            this.#replays.delete(replayKey);
          }
        }
        throw error;
      },
    );
    this.#replays.set(replayKey, {
      fingerprint,
      completion,
    });
    return completion;
  }

  async dispose(): Promise<void> {
    if (this.#disposed && this.#workers.size === 0) return;
    this.#disposed = true;
    this.#replays.clear();
    const workers = [...this.#workers.values()];
    await Promise.all(
      workers.map(async (worker) => {
        worker.terminalObserved = true;
        worker.terminal.resolve();
        await worker.process.stop();
        if (this.#workers.get(worker.threadId) === worker) {
          this.#workers.delete(worker.threadId);
        }
        worker.closed.resolve();
      }),
    );
  }

  async #start(
    threadId: string,
    prompt: string,
    options: CodexThreadFollowUpOptions,
  ): Promise<CodexThreadFollowUpResult> {
    const clientUserMessageId =
      options.clientUserMessageId ??
      (() => {
        throw new Error("Detached dispatch is missing clientUserMessageId");
      })();
    const terminal = new Deferred<void>();
    // An unexpected process exit may precede installation of the lifecycle
    // monitor. Observe the promise immediately to avoid an unhandled rejection;
    // the later monitor still records and finalizes the worker.
    void terminal.promise.catch(() => undefined);
    const closed = new Deferred<void>();
    let worker: DetachedWorker | undefined;
    let turnStartIssued = false;
    const boundary = followUpBoundary(options);
    throwIfFollowUpBoundaryElapsed(boundary);
    const requestTimeoutMs = remainingFollowUpTimeout(boundary);
    const process = (this.#options.createProcess ?? defaultProcessFactory)(this.#candidate, {
      ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
      ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
      ...(this.#options.ownershipRegistry === undefined
        ? {}
        : { ownershipRegistry: this.#options.ownershipRegistry }),
      configOverrides: ["features.code_mode_host=true"],
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
      onNotification: (message) => {
        this.#options.onDiagnostic?.(message);
        if (worker !== undefined) this.#observeTerminalNotification(worker, message);
      },
      onServerRequest: (message) => this.#answerServerRequest(message),
      onUnexpectedExit: (error) => {
        terminal.reject(error);
      },
    });
    try {
      await awaitWithinFollowUpBoundary(process.start(), boundary);
      const ownerClientId = `detached-app-server:${process.identity.ownershipNonce ?? randomUUID()}`;
      worker = {
        process,
        threadId,
        ownerClientId,
        terminal,
        closed,
        turnId: undefined,
        terminalObserved: false,
      };
      this.#workers.set(threadId, worker);
      await process.client.request(
        "thread/resume",
        {
          threadId,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          excludeTurns: true,
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.threadSettings?.model === undefined
            ? {}
            : { model: options.threadSettings.model }),
        },
        followUpRpcOptions(boundary, true),
      );
      // From this point onward a timeout is an unknown-outcome failure. The
      // router must not replay the prompt through another owner.
      throwIfFollowUpBoundaryElapsed(boundary);
      turnStartIssued = true;
      const nativeResult = await process.client.request<unknown>(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text: prompt, text_elements: [] }],
          clientUserMessageId,
          approvalPolicy: "never",
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.threadSettings?.model === undefined
            ? {}
            : { model: options.threadSettings.model }),
          ...(options.threadSettings?.effort === undefined
            ? {}
            : { effort: options.threadSettings.effort }),
        },
        followUpRpcOptions(boundary, true),
      );
      worker.turnId = nestedString(nativeResult, "turn", "id");
      if (worker.turnId === undefined) {
        throw new Error("Codex detached App Server did not acknowledge a turn id");
      }
      this.#monitorWorker(worker);
      return {
        threadId,
        ownerClientId,
        disposition: "started",
        clientUserMessageId,
        nativeResult,
        transport: "detached_app_server",
      };
    } catch (error) {
      if (this.#workers.get(threadId) === worker) this.#workers.delete(threadId);
      await process.stop().catch(() => undefined);
      closed.resolve();
      if (!turnStartIssued) {
        throw new CodexThreadPreDispatchError(
          `Codex detached thread preparation failed before turn submission: ${toError(error).message}`,
          { cause: error },
        );
      }
      throw new CodexThreadUnknownDispatchError(
        `Codex detached turn acknowledgement was lost: ${toError(error).message}`,
        clientUserMessageId,
        { cause: error },
      );
    }
  }

  #observeTerminalNotification(worker: DetachedWorker, message: JsonObject): void {
    if (message.method !== "turn/completed") return;
    const params = asRecord(message.params);
    const turn = asRecord(params.turn);
    if (params.threadId !== worker.threadId) return;
    if (worker.turnId !== undefined && turn.id !== worker.turnId) return;
    worker.terminalObserved = true;
    worker.terminal.resolve();
  }

  #monitorWorker(worker: DetachedWorker): void {
    const timer =
      this.#completionTimeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            worker.terminal.reject(
              new Error(`Codex detached turn exceeded completion timeout: ${worker.threadId}`),
            );
          }, this.#completionTimeoutMs);
    timer?.unref?.();
    void worker.terminal.promise
      .catch((error: unknown) => {
        this.#options.onDiagnostic?.({
          method: "omnicodex/detached-thread/error",
          params: { threadId: worker.threadId, message: toError(error).message },
        });
      })
      .finally(async () => {
        if (timer !== undefined) clearTimeout(timer);
        worker.terminalObserved = true;
        await worker.process.client
          .request("thread/unsubscribe", { threadId: worker.threadId })
          .catch(() => undefined);
        try {
          await worker.process.stop();
        } catch (error) {
          this.#options.onDiagnostic?.({
            method: "omnicodex/detached-thread/stopFailed",
            params: { threadId: worker.threadId, message: toError(error).message },
          });
        } finally {
          if (this.#workers.get(worker.threadId) === worker) {
            this.#workers.delete(worker.threadId);
          }
          worker.closed.resolve();
          this.#ensureQueueDrain(worker.threadId);
        }
      });
  }

  async #recoverQueuedFollowUps(): Promise<void> {
    try {
      const queued = await this.#queueStore.list("detached_app_server");
      for (const threadId of new Set(queued.map((item) => item.threadId))) {
        this.#ensureQueueDrain(threadId);
      }
    } catch (error) {
      this.#queueDiagnostic("recoveryFailed", undefined, error);
    }
  }

  #ensureQueueDrain(threadId: string): void {
    if (this.#disposed || this.#queueDrains.has(threadId)) return;
    let drain!: Promise<void>;
    drain = this.#drainQueuedFollowUps(threadId).finally(() => {
      if (this.#queueDrains.get(threadId) === drain) this.#queueDrains.delete(threadId);
    });
    this.#queueDrains.set(threadId, drain);
    void drain.catch((error: unknown) => {
      this.#queueDiagnostic("drainFailed", threadId, error);
    });
  }

  async #drainQueuedFollowUps(threadId: string): Promise<void> {
    while (!this.#disposed) {
      const next = (await this.#queueStore.list("detached_app_server", threadId))[0];
      if (next === undefined) return;
      const active = this.#workers.get(threadId);
      if (active !== undefined) {
        await active.closed.promise.catch(() => undefined);
        continue;
      }
      let unknownOutcome = false;
      const dispatched = await this.#withThreadLock(threadId, async () => {
        const current = this.#workers.get(threadId);
        if (current !== undefined) return false;
        const claimed = await this.#queueStore.claim(next.clientUserMessageId, this.#queueOwnerId);
        if (claimed === null) return false;
        try {
          await this.#start(claimed.threadId, claimed.prompt, queuedOptions(claimed));
          await this.#queueStore.acknowledge(claimed.clientUserMessageId, this.#queueOwnerId);
          return true;
        } catch (error) {
          if (isUnknownThreadDispatch(error)) {
            unknownOutcome = true;
            this.#queueDiagnostic("dispatchOutcomeUnknown", threadId, error);
            return false;
          }
          await this.#queueStore.release(claimed.clientUserMessageId, this.#queueOwnerId);
          this.#queueDiagnostic("dispatchFailed", threadId, error);
          return false;
        }
      });
      if (unknownOutcome) return;
      if (!dispatched) {
        await queueDelay(QUEUE_RETRY_DELAY_MS);
      }
    }
  }

  #queueDiagnostic(kind: string, threadId: string | undefined, error: unknown): void {
    this.#options.onDiagnostic?.({
      method: `omnicodex/detached-follow-up-queue/${kind}`,
      params: {
        ...(threadId === undefined ? {} : { threadId }),
        message: toError(error).message,
      },
    });
  }

  async #answerServerRequest(message: JsonObject): Promise<unknown> {
    if (message.method === "item/tool/call") {
      if (this.#options.onDynamicToolCall === undefined) {
        return {
          success: false,
          contentItems: [
            { type: "inputText", text: "This Codex host tool is not available in this runtime." },
          ],
        };
      }
      const value = await this.#options.onDynamicToolCall(asRecord(message.params));
      return dynamicToolResponse(value);
    }
    return answerAppServerApprovalRequest(message);
  }

  async #withThreadLock<T>(
    threadId: string,
    operation: () => Promise<T>,
    boundary: FollowUpBoundary = {},
  ): Promise<T> {
    const previous = this.#threadTails.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.catch(() => undefined).then(() => tail);
    this.#threadTails.set(threadId, chained);
    try {
      await awaitWithinFollowUpBoundary(
        previous.catch(() => undefined),
        boundary,
      );
      throwIfFollowUpBoundaryElapsed(boundary);
      return await operation();
    } finally {
      release();
      if (this.#threadTails.get(threadId) === chained) this.#threadTails.delete(threadId);
    }
  }
}

function followUpFingerprint(
  threadId: string,
  prompt: string,
  options: CodexThreadFollowUpOptions,
): string {
  return JSON.stringify({
    threadId,
    prompt,
    cwd: options.cwd,
    hostId: options.hostId,
    threadSettings:
      options.threadSettings === undefined
        ? undefined
        : {
            model: options.threadSettings.model,
            effort: options.threadSettings.effort,
          },
  });
}

function assertMatchingReplay(key: string, expected: string, actual: string): void {
  if (expected === actual) return;
  throw new Error(`Codex thread clientUserMessageId ${key} was reused with different input`);
}

function queuedOptions(item: PersistedCodexThreadFollowUp): CodexThreadFollowUpOptions {
  return {
    clientUserMessageId: item.clientUserMessageId,
    ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
    ...(item.hostId === undefined ? {} : { hostId: item.hostId }),
    ...(item.threadSettings === undefined ? {} : { threadSettings: item.threadSettings }),
  };
}

function followUpBoundary(options: CodexThreadFollowUpOptions): FollowUpBoundary {
  const timeoutMs = optionalTimeout(options.timeoutMs, "timeoutMs");
  let deadlineUnixMs = optionalDeadline(options.deadlineUnixMs, "deadlineUnixMs");
  if (timeoutMs !== undefined) {
    const now = Date.now();
    if (timeoutMs > Number.MAX_SAFE_INTEGER - now) {
      throw new RangeError("timeoutMs exceeds the representable timestamp range");
    }
    const timeoutDeadline = now + timeoutMs;
    deadlineUnixMs =
      deadlineUnixMs === undefined ? timeoutDeadline : Math.min(deadlineUnixMs, timeoutDeadline);
  }
  return {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(deadlineUnixMs === undefined ? {} : { deadlineUnixMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function followUpRpcOptions(
  boundary: FollowUpBoundary,
  mutation: boolean,
): AppServerRpcRequestOptions {
  return {
    ...(boundary.timeoutMs === undefined ? {} : { timeoutMs: boundary.timeoutMs }),
    ...(boundary.deadlineUnixMs === undefined ? {} : { deadlineUnixMs: boundary.deadlineUnixMs }),
    ...(boundary.signal === undefined ? {} : { signal: boundary.signal }),
    ...(mutation ? { awaitResponseAfterCancellation: true } : {}),
  };
}

function followUpQueueOperationOptions(boundary: FollowUpBoundary): {
  readonly deadlineUnixMs?: number;
  readonly signal?: AbortSignal;
} {
  return {
    ...(boundary.deadlineUnixMs === undefined ? {} : { deadlineUnixMs: boundary.deadlineUnixMs }),
    ...(boundary.signal === undefined ? {} : { signal: boundary.signal }),
  };
}

function remainingFollowUpTimeout(boundary: FollowUpBoundary): number | undefined {
  if (boundary.deadlineUnixMs === undefined) return undefined;
  throwIfFollowUpBoundaryElapsed(boundary);
  return Math.max(1, boundary.deadlineUnixMs - Date.now());
}

function throwIfFollowUpBoundaryElapsed(boundary: FollowUpBoundary): void {
  if (boundary.signal?.aborted === true) throw followUpBoundaryError(boundary);
  if (boundary.deadlineUnixMs !== undefined && boundary.deadlineUnixMs <= Date.now()) {
    throw followUpBoundaryError(boundary);
  }
}

function followUpBoundaryError(boundary: FollowUpBoundary): Error {
  if (boundary.signal?.aborted === true) {
    if (boundary.signal.reason instanceof Error) return boundary.signal.reason;
    const error = new Error(
      boundary.signal.reason === undefined
        ? "Codex detached follow-up was aborted"
        : `Codex detached follow-up was aborted: ${String(boundary.signal.reason)}`,
    );
    error.name = "AbortError";
    return error;
  }
  const error = new Error("Codex detached follow-up deadline exceeded");
  error.name = "TimeoutError";
  return error;
}

function awaitWithinFollowUpBoundary<T>(
  completion: Promise<T>,
  boundary: FollowUpBoundary,
): Promise<T> {
  throwIfFollowUpBoundaryElapsed(boundary);
  if (boundary.signal === undefined && boundary.deadlineUnixMs === undefined) return completion;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const signal = boundary.signal;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (operation: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const onAbort = () => settle(() => reject(followUpBoundaryError(boundary)));
    const scheduleDeadline = () => {
      if (settled || boundary.deadlineUnixMs === undefined) return;
      const remaining = boundary.deadlineUnixMs - Date.now();
      if (remaining <= 0) {
        queueMicrotask(() => settle(() => reject(followUpBoundaryError(boundary))));
        return;
      }
      timer = setTimeout(
        remaining > 2_147_483_647
          ? scheduleDeadline
          : () => settle(() => reject(followUpBoundaryError(boundary))),
        Math.min(remaining, 2_147_483_647),
      );
      timer.unref?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    scheduleDeadline();
    completion.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
    if (signal?.aborted === true) onAbort();
  });
}

function queueDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function defaultProcessFactory(
  candidate: RuntimeCandidate,
  options: CodexAppServerProcessOptions,
): CodexDetachedAppServerProcess {
  return new CodexAppServerConnection(candidate, options);
}

class Deferred<T> {
  readonly promise: Promise<T>;
  #resolve!: (value: T | PromiseLike<T>) => void;
  #reject!: (error: unknown) => void;
  #settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  resolve(value?: T): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolve(value as T);
  }

  reject(error: unknown): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#reject(error);
  }
}

function dynamicToolResponse(value: unknown): unknown {
  if (isRecord(value) && typeof value.success === "boolean" && Array.isArray(value.contentItems)) {
    return value;
  }
  return {
    success: true,
    contentItems: [{ type: "inputText", text: stringify(value) }],
  };
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

function optionalTimeout(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function optionalDeadline(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function optionalExpiry(windowMs: number | undefined): number | undefined {
  if (windowMs === undefined) return undefined;
  if (windowMs > Number.MAX_SAFE_INTEGER - Date.now()) {
    throw new Error("replayWindowMs exceeds the representable timestamp range");
  }
  return Date.now() + windowMs;
}

function setReplayExpiry(replay: ReplayEntry, windowMs: number | undefined): void {
  const expiresAt = optionalExpiry(windowMs);
  if (expiresAt === undefined) delete replay.expiresAt;
  else replay.expiresAt = expiresAt;
}

function requiredString(value: string, name: string): string {
  if (value.length === 0) throw new Error(`${name} must not be empty`);
  return value;
}

function requiredPrompt(value: string): string {
  if (value.trim().length === 0) throw new Error("prompt must not be empty");
  return value;
}

function nestedString(value: unknown, key: string, nestedKey: string): string | undefined {
  const parent = asRecord(value)[key];
  const nested = asRecord(parent)[nestedKey];
  return typeof nested === "string" && nested.length > 0 ? nested : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
