import { constants as bufferConstants } from "node:buffer";
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import {
  type CodexThreadFollowUpOptions,
  CodexThreadUnknownDispatchError,
  isUnknownThreadDispatch,
  normalizeCodexThreadSettingsOverride,
} from "../../application/codex-thread-message-client.js";
import {
  type CodexThreadFollowUpQueueReadback,
  CodexThreadFollowUpQueueStore,
  type PersistedCodexThreadFollowUp,
} from "../runtime/codex-thread-follow-up-queue-store.js";

const DEFAULT_CODEX_IPC_ENDPOINT = "\\\\.\\pipe\\codex-ipc";
const INITIALIZING_CLIENT_ID = "initializing-client";
const QUEUE_RETRY_DELAY_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_IPC_FRAME_BYTES = Math.min(0xffff_ffff, bufferConstants.MAX_LENGTH - 4);

const requestVersions: Readonly<Record<string, number>> = {
  "thread-owner-discovery": 1,
  "thread-follower-load-complete-history": 1,
  "thread-follower-start-turn": 2,
  "thread-follower-update-thread-settings": 1,
};

const broadcastVersions: Readonly<Record<string, number>> = {
  "thread-stream-following-changed": 1,
  "thread-stream-state-changed": 11,
};

interface PendingResponse {
  readonly resolve: (response: IpcResponse) => void;
  readonly reject: (error: Error) => void;
  cancelBoundary(): void;
}

interface IpcResponse {
  readonly type: "response";
  readonly requestId: string;
  readonly resultType: "success" | "error";
  readonly method?: string;
  readonly handledByClientId?: string;
  readonly result?: unknown;
  readonly error?: string;
}

interface IpcClientDiscoveryRequest {
  readonly type: "client-discovery-request";
  readonly requestId: string;
}

interface IpcBroadcast {
  readonly type: "broadcast";
  readonly method: string;
  readonly sourceClientId: string;
  readonly targetClientIds?: readonly string[];
  readonly params?: unknown;
}

interface IpcRequestOptions {
  readonly targetClientId?: string;
  readonly boundary?: OperationBoundary;
  readonly onDispatched?: () => void;
  readonly awaitResponseAfterBoundary?: boolean;
}

interface OperationBoundary {
  readonly deadlineUnixMs?: number;
  readonly signal?: AbortSignal;
}

interface FollowUpRequest {
  readonly threadId: string;
  readonly prompt: string;
  readonly clientUserMessageId: string;
  readonly cwd: string;
  readonly hostId: string;
  readonly threadSettings?: {
    readonly model?: string;
    readonly effort?: string | null;
  };
  readonly boundary: OperationBoundary;
}

interface FollowUpDispatchProgress {
  mutationDispatched: boolean;
}

interface FollowUpReplay {
  readonly fingerprint: string;
  readonly completion: Promise<CodexDesktopFollowUpResult>;
  readonly progress: FollowUpDispatchProgress;
  expiresAt: number;
}

interface PendingThreadSnapshot {
  readonly ownerClientId: string;
  readonly minimumRevision: number;
  readonly resolve: (snapshot: CodexDesktopThreadSnapshot) => void;
  readonly reject: (error: Error) => void;
  cancelBoundary(): void;
  cancel(): void;
}

interface ThreadFollowerState {
  readonly ownerClientId: string;
  readonly ready: Promise<void>;
  refCount: number;
}

export interface CodexDesktopFollowUpResult {
  readonly threadId: string;
  readonly ownerClientId: string;
  readonly disposition: "started" | "queued";
  readonly clientUserMessageId: string;
  readonly nativeResult: unknown;
  readonly queue?: CodexThreadFollowUpQueueReadback;
}

export interface CodexDesktopThreadSnapshot {
  readonly threadId: string;
  readonly hostId: string;
  readonly ownerClientId: string;
  readonly revision: number;
  readonly conversationState: Record<string, unknown>;
}

/**
 * Same-user client for the IPC router owned by the running Codex desktop app.
 * It never starts, resumes, stops, or authenticates an App Server process.
 */
export class CodexDesktopIpcClient {
  readonly #endpoint: string;
  readonly #clientType: string;
  readonly #followUpReplayWindowMs: number | undefined;
  readonly #followUpReplays = new Map<string, FollowUpReplay>();
  readonly #followUpDispatchTails = new Map<string, Promise<void>>();
  readonly #threadSnapshotLoads = new Map<string, Promise<CodexDesktopThreadSnapshot>>();
  readonly #latestThreadSnapshots = new Map<string, CodexDesktopThreadSnapshot>();
  readonly #pendingThreadSnapshots = new Map<string, Set<PendingThreadSnapshot>>();
  readonly #threadFollowers = new Map<string, ThreadFollowerState>();
  readonly #pendingResponses = new Map<string, PendingResponse>();
  readonly #queueStore: CodexThreadFollowUpQueueStore;
  readonly #queueOwnerId = randomUUID();
  readonly #queueDrains = new Map<string, Promise<void>>();
  readonly #onDiagnostic: ((message: Record<string, unknown>) => void) | undefined;
  #socket: Socket | undefined;
  #connectInFlight: Promise<void> | undefined;
  #clientId = INITIALIZING_CLIENT_ID;
  #readBuffer = Buffer.alloc(0);
  #disposed = false;

  constructor(
    options: {
      readonly endpoint?: string;
      readonly clientType?: string;
      readonly followUpReplayWindowMs?: number;
      readonly queueStore?: CodexThreadFollowUpQueueStore;
      readonly recoverQueue?: boolean;
      readonly onDiagnostic?: (message: Record<string, unknown>) => void;
    } = {},
  ) {
    this.#endpoint = options.endpoint ?? DEFAULT_CODEX_IPC_ENDPOINT;
    this.#clientType = options.clientType ?? "omnicodex";
    this.#queueStore = options.queueStore ?? new CodexThreadFollowUpQueueStore();
    this.#onDiagnostic = options.onDiagnostic;
    this.#followUpReplayWindowMs = optionalPositiveInteger(
      options.followUpReplayWindowMs,
      "followUpReplayWindowMs",
    );
    if (options.recoverQueue !== false) void this.#recoverQueuedFollowUps();
  }

  async findThreadOwner(
    threadId: string,
    options: {
      readonly hostId?: string;
      readonly timeoutMs?: number;
      readonly deadlineUnixMs?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<string | null> {
    const boundary = operationBoundary(options);
    const response = await this.#sendRequest(
      "thread-owner-discovery",
      { hostId: options.hostId ?? "local", conversationId: requiredString(threadId, "threadId") },
      { boundary },
    );
    if (response.resultType === "error") {
      if (response.error === "no-client-found") return null;
      throw new Error(`Codex desktop owner discovery failed: ${response.error ?? "unknown error"}`);
    }
    if (typeof response.handledByClientId !== "string" || response.handledByClientId.length === 0) {
      throw new Error("Codex desktop owner discovery returned no client id");
    }
    return response.handledByClientId;
  }

  async readThreadSnapshot(
    threadIdValue: string,
    options: {
      readonly hostId?: string;
      readonly completeHistory?: boolean;
      readonly timeoutMs?: number;
      readonly deadlineUnixMs?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<CodexDesktopThreadSnapshot> {
    const threadId = requiredString(threadIdValue, "threadId");
    const hostId = options.hostId ?? "local";
    const completeHistory = options.completeHistory ?? true;
    const boundary = operationBoundary(options);
    if (hasOperationBoundary(boundary)) {
      return this.#readThreadSnapshotOnce(threadId, hostId, completeHistory, boundary);
    }
    const loadKey = `${hostId}\u0000${threadId}\u0000${completeHistory ? "complete" : "loaded"}`;
    const existing = this.#threadSnapshotLoads.get(loadKey);
    if (existing !== undefined) return existing;
    let completion!: Promise<CodexDesktopThreadSnapshot>;
    completion = this.#readThreadSnapshotOnce(threadId, hostId, completeHistory, boundary).finally(
      () => {
        if (this.#threadSnapshotLoads.get(loadKey) === completion) {
          this.#threadSnapshotLoads.delete(loadKey);
        }
      },
    );
    this.#threadSnapshotLoads.set(loadKey, completion);
    return completion;
  }

  async #readThreadSnapshotOnce(
    threadId: string,
    hostId: string,
    completeHistory: boolean,
    boundary: OperationBoundary,
  ): Promise<CodexDesktopThreadSnapshot> {
    const ownerClientId = await this.findThreadOwner(threadId, {
      hostId,
      ...boundaryOptions(boundary),
    });
    if (ownerClientId === null) {
      throw new Error(`No running Codex desktop window owns thread ${threadId}`);
    }
    const releaseFollower = await this.#acquireThreadFollower(
      threadId,
      hostId,
      ownerClientId,
      boundary,
    );
    try {
      if (!completeHistory) {
        return await this.#waitForThreadSnapshot(threadId, hostId, ownerClientId, 0, boundary);
      }
      const loaded = await this.#sendRequest(
        "thread-follower-load-complete-history",
        { conversationId: threadId },
        { targetClientId: ownerClientId, boundary },
      );
      if (loaded.resultType === "error") {
        throw new Error(
          `Codex desktop complete-history load failed: ${loaded.error ?? "unknown error"}`,
        );
      }
      const result = asRecord(loaded.result);
      if (!Number.isSafeInteger(result.revision) || (result.revision as number) < 0) {
        throw new Error("Codex desktop complete-history load returned no valid revision");
      }
      const revision = result.revision as number;
      // Repeating the native following=true broadcast makes the owner send a
      // complete snapshot at the returned revision even when history loading
      // originally advanced the stream through incremental patches.
      await this.#sendBroadcast(
        "thread-stream-following-changed",
        { conversationId: threadId, hostId, following: true },
        { targetClientIds: [ownerClientId], boundary },
      );
      return await this.#waitForThreadSnapshot(threadId, hostId, ownerClientId, revision, boundary);
    } finally {
      await releaseFollower();
    }
  }

  async #acquireThreadFollower(
    threadId: string,
    hostId: string,
    ownerClientId: string,
    boundary: OperationBoundary = {},
  ): Promise<() => Promise<void>> {
    const key = threadSnapshotKey(threadId, hostId);
    let follower = this.#threadFollowers.get(key);
    if (follower !== undefined && follower.ownerClientId !== ownerClientId) {
      await withOperationBoundary(follower.ready, boundary).catch(() => undefined);
      throwIfOperationBoundaryElapsed(boundary);
      await this.#sendBroadcast(
        "thread-stream-following-changed",
        { conversationId: threadId, hostId, following: false },
        { targetClientIds: [follower.ownerClientId] },
      ).catch(() => undefined);
      this.#threadFollowers.delete(key);
      follower = undefined;
    }
    if (follower === undefined) {
      this.#latestThreadSnapshots.delete(key);
      const ready = this.#sendBroadcast(
        "thread-stream-following-changed",
        { conversationId: threadId, hostId, following: true },
        { targetClientIds: [ownerClientId], boundary },
      );
      follower = { ownerClientId, ready, refCount: 1 };
      this.#threadFollowers.set(key, follower);
      try {
        await ready;
      } catch (error) {
        if (this.#threadFollowers.get(key) === follower) this.#threadFollowers.delete(key);
        throw error;
      }
    } else {
      follower.refCount += 1;
      try {
        await withOperationBoundary(follower.ready, boundary);
      } catch (error) {
        follower.refCount -= 1;
        throw error;
      }
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      const current = this.#threadFollowers.get(key);
      if (current !== follower) return;
      current.refCount -= 1;
      if (current.refCount > 0) return;
      this.#threadFollowers.delete(key);
      await this.#sendBroadcast(
        "thread-stream-following-changed",
        { conversationId: threadId, hostId, following: false },
        { targetClientIds: [ownerClientId] },
      ).catch(() => undefined);
    };
  }

  async sendFollowUpMessage(
    threadIdValue: string,
    promptValue: string,
    options: {
      readonly cwd?: string;
      readonly hostId?: string;
      readonly threadSettings?: {
        readonly model?: string;
        readonly effort?: string | null;
      };
      readonly clientUserMessageId?: string;
      readonly timeoutMs?: number;
      readonly deadlineUnixMs?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<CodexDesktopFollowUpResult> {
    const threadId = requiredString(threadIdValue, "threadId");
    const prompt = requiredPrompt(promptValue);
    const clientUserMessageId = options.clientUserMessageId ?? randomUUID();
    const replayKey = clientUserMessageId;
    const boundary = operationBoundary(options);
    const threadSettings = normalizeCodexThreadSettingsOverride(options.threadSettings);
    const request: FollowUpRequest = {
      threadId,
      prompt,
      clientUserMessageId,
      cwd: options.cwd ?? "/",
      hostId: options.hostId ?? "local",
      ...(threadSettings === undefined ? {} : { threadSettings }),
      boundary,
    };
    const fingerprint = followUpRequestFingerprint(request);
    const now = Date.now();
    for (const [key, replay] of this.#followUpReplays) {
      if (replay.expiresAt <= now) this.#followUpReplays.delete(key);
    }
    const replay = this.#followUpReplays.get(replayKey);
    if (replay !== undefined) {
      assertMatchingFollowUpReplay(replayKey, replay.fingerprint, fingerprint);
      return this.#followUpCallerCompletion(replayKey, replay, boundary);
    }

    const progress: FollowUpDispatchProgress = { mutationDispatched: false };
    let completion!: Promise<CodexDesktopFollowUpResult>;
    completion = this.#serializeFollowUp(request, progress).then(
      (result) => {
        const current = this.#followUpReplays.get(replayKey);
        if (current?.completion === completion) {
          current.expiresAt = replayExpiry(Date.now(), this.#followUpReplayWindowMs);
        }
        return result;
      },
      (error: unknown) => {
        const current = this.#followUpReplays.get(replayKey);
        if (current?.completion === completion) {
          if (isUnknownThreadDispatch(error)) {
            // An unknown native acknowledgement is never safe to redispatch.
            current.expiresAt = Number.POSITIVE_INFINITY;
          } else {
            this.#followUpReplays.delete(replayKey);
          }
        }
        throw error;
      },
    );
    const replayEntry: FollowUpReplay = {
      fingerprint,
      completion,
      progress,
      expiresAt: Number.POSITIVE_INFINITY,
    };
    this.#followUpReplays.set(replayKey, replayEntry);
    return this.#followUpCallerCompletion(replayKey, replayEntry, boundary);
  }

  #serializeFollowUp(
    request: FollowUpRequest,
    progress: FollowUpDispatchProgress,
  ): Promise<CodexDesktopFollowUpResult> {
    const key = threadSnapshotKey(request.threadId, request.hostId);
    const previous = this.#followUpDispatchTails.get(key);
    const operation = (async () => {
      if (previous !== undefined) await previous;
      throwIfOperationBoundaryElapsed(request.boundary);
      if (this.#disposed) throw new Error("Codex desktop IPC client is disposed");
      return this.#sendFollowUpMessageOnce(request, progress);
    })();
    // A cancelled waiter still holds its place until the prior dispatch settles.
    // This prevents a later message from racing an in-flight turn start.
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#followUpDispatchTails.set(key, tail);
    void tail.then(() => {
      if (this.#followUpDispatchTails.get(key) === tail) {
        this.#followUpDispatchTails.delete(key);
      }
    });
    return operation;
  }

  #followUpCallerCompletion(
    replayKey: string,
    replay: FollowUpReplay,
    boundary: OperationBoundary,
  ): Promise<CodexDesktopFollowUpResult> {
    return withMutationOperationBoundary(replay.completion, boundary, () => {
      const boundaryError = operationBoundaryError(boundary);
      return replay.progress.mutationDispatched
        ? new CodexThreadUnknownDispatchError(
            `Codex desktop mutation acknowledgement is still pending: ${boundaryError.message}`,
            replayKey,
            { cause: boundaryError },
          )
        : boundaryError;
    });
  }

  async #sendFollowUpMessageOnce(
    request: FollowUpRequest,
    progress: FollowUpDispatchProgress,
  ): Promise<CodexDesktopFollowUpResult> {
    const { threadId, boundary } = request;
    const ownerClientId = await this.findThreadOwner(threadId, {
      hostId: request.hostId,
      ...boundaryOptions(boundary),
    });
    if (ownerClientId === null) {
      throw new Error(`No running Codex desktop window owns thread ${threadId}`);
    }

    const snapshot = await this.#readThreadSnapshotFromOwner(
      threadId,
      request.hostId,
      ownerClientId,
      boundary,
    );
    if (threadIsActive(snapshot.conversationState)) {
      return this.#enqueueDesktopFollowUp(request, ownerClientId);
    }

    return this.#startDesktopFollowUp(request, ownerClientId, progress);
  }

  async #readThreadSnapshotFromOwner(
    threadId: string,
    hostId: string,
    ownerClientId: string,
    boundary: OperationBoundary,
  ): Promise<CodexDesktopThreadSnapshot> {
    const releaseFollower = await this.#acquireThreadFollower(
      threadId,
      hostId,
      ownerClientId,
      boundary,
    );
    try {
      return await this.#waitForThreadSnapshot(threadId, hostId, ownerClientId, 0, boundary);
    } finally {
      await releaseFollower();
    }
  }

  async #startDesktopFollowUp(
    request: FollowUpRequest,
    ownerClientId: string,
    progress: FollowUpDispatchProgress,
  ): Promise<CodexDesktopFollowUpResult> {
    if (request.threadSettings !== undefined) {
      let settings: IpcResponse;
      try {
        settings = await this.#sendRequest(
          "thread-follower-update-thread-settings",
          {
            conversationId: request.threadId,
            threadSettings: request.threadSettings,
          },
          {
            targetClientId: ownerClientId,
            boundary: request.boundary,
            awaitResponseAfterBoundary: true,
            onDispatched: () => {
              progress.mutationDispatched = true;
            },
          },
        );
      } catch (error) {
        if (!progress.mutationDispatched) throw error;
        throw new CodexThreadUnknownDispatchError(
          `Codex desktop settings acknowledgement was lost: ${toError(error).message}`,
          request.clientUserMessageId,
          { cause: error },
        );
      }
      if (settings.resultType === "error") {
        throw new Error(
          `Codex desktop thread settings update failed: ${settings.error ?? "unknown error"}`,
        );
      }
    }

    const input = [{ type: "text", text: request.prompt, text_elements: [] }];
    let start: IpcResponse;
    let turnDispatched = false;
    try {
      start = await this.#sendRequest(
        "thread-follower-start-turn",
        {
          conversationId: request.threadId,
          turnStart: {
            request: {
              threadId: request.threadId,
              input,
              clientUserMessageId: request.clientUserMessageId,
            },
            context: { inheritThreadSettings: true },
          },
        },
        {
          targetClientId: ownerClientId,
          boundary: request.boundary,
          awaitResponseAfterBoundary: true,
          onDispatched: () => {
            progress.mutationDispatched = true;
            turnDispatched = true;
          },
        },
      );
    } catch (error) {
      if (!turnDispatched) throw error;
      throw new CodexThreadUnknownDispatchError(
        `Codex desktop turn-start acknowledgement was lost: ${toError(error).message}`,
        request.clientUserMessageId,
        { cause: error },
      );
    }
    if (start.resultType === "error") {
      const latest = await this.#readThreadSnapshotFromOwner(
        request.threadId,
        request.hostId,
        ownerClientId,
        request.boundary,
      );
      if (threadIsActive(latest.conversationState)) {
        return this.#enqueueDesktopFollowUp(request, ownerClientId);
      }
      throw new Error(`Codex desktop follow-up start failed: ${start.error ?? "unknown error"}`);
    }
    return {
      threadId: request.threadId,
      ownerClientId,
      disposition: "started",
      clientUserMessageId: request.clientUserMessageId,
      nativeResult: start.result,
    };
  }

  async #enqueueDesktopFollowUp(
    request: FollowUpRequest,
    ownerClientId: string,
  ): Promise<CodexDesktopFollowUpResult> {
    const queue = await this.#queueStore.enqueue(
      "desktop_ipc",
      request.threadId,
      request.prompt,
      followUpOptions(request),
      boundaryOptions(request.boundary),
    );
    this.#ensureQueueDrain(request.threadId);
    return {
      threadId: request.threadId,
      ownerClientId,
      disposition: "queued",
      clientUserMessageId: request.clientUserMessageId,
      nativeResult: { queue },
      queue,
    };
  }

  async #recoverQueuedFollowUps(): Promise<void> {
    try {
      const queued = await this.#queueStore.list("desktop_ipc");
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
      const next = (await this.#queueStore.list("desktop_ipc", threadId))[0];
      if (next === undefined) return;
      try {
        const ready = await this.#waitUntilThreadIdle(next);
        if (
          snapshotContainsClientMessage(ready.snapshot.conversationState, next.clientUserMessageId)
        ) {
          await this.#queueStore.acknowledge(next.clientUserMessageId);
          continue;
        }
        const claimed = await this.#queueStore.claim(next.clientUserMessageId, this.#queueOwnerId);
        if (claimed === null) {
          await queueDelay(QUEUE_RETRY_DELAY_MS);
          continue;
        }
        try {
          const result = await this.#serializeFollowUp(followUpRequest(claimed), {
            mutationDispatched: false,
          });
          if (result.disposition === "queued") {
            await this.#queueStore.release(claimed.clientUserMessageId, this.#queueOwnerId);
            continue;
          }
          await this.#queueStore.acknowledge(claimed.clientUserMessageId, this.#queueOwnerId);
        } catch (error) {
          if (isUnknownThreadDispatch(error)) {
            this.#queueDiagnostic("dispatchOutcomeUnknown", threadId, error);
            return;
          }
          await this.#queueStore.release(claimed.clientUserMessageId, this.#queueOwnerId);
          throw error;
        }
      } catch (error) {
        this.#queueDiagnostic("dispatchDeferred", threadId, error);
        await queueDelay(QUEUE_RETRY_DELAY_MS);
      }
    }
  }

  async #waitUntilThreadIdle(item: PersistedCodexThreadFollowUp): Promise<{
    readonly ownerClientId: string;
    readonly snapshot: CodexDesktopThreadSnapshot;
  }> {
    const hostId = item.hostId ?? "local";
    const ownerClientId = await this.findThreadOwner(item.threadId, { hostId });
    if (ownerClientId === null) {
      throw new Error(`No running Codex desktop window owns thread ${item.threadId}`);
    }
    const releaseFollower = await this.#acquireThreadFollower(item.threadId, hostId, ownerClientId);
    try {
      let snapshot = await this.#waitForThreadSnapshot(item.threadId, hostId, ownerClientId, 0, {});
      while (threadIsActive(snapshot.conversationState)) {
        snapshot = await this.#waitForThreadSnapshot(
          item.threadId,
          hostId,
          ownerClientId,
          snapshot.revision + 1,
          {},
        );
      }
      return { ownerClientId, snapshot };
    } finally {
      await releaseFollower();
    }
  }

  #queueDiagnostic(kind: string, threadId: string | undefined, error: unknown): void {
    this.#onDiagnostic?.({
      method: `omnicodex/desktop-follow-up-queue/${kind}`,
      params: {
        ...(threadId === undefined ? {} : { threadId }),
        message: toError(error).message,
      },
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#followUpReplays.clear();
    this.#followUpDispatchTails.clear();
    this.#threadSnapshotLoads.clear();
    this.#latestThreadSnapshots.clear();
    this.#threadFollowers.clear();
    this.#rejectPendingThreadSnapshots(new Error("Codex desktop IPC client disposed"));
    this.#rejectPending(new Error("Codex desktop IPC client disposed"));
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#readBuffer = Buffer.alloc(0);
    this.#clientId = INITIALIZING_CLIENT_ID;
  }

  async #sendRequest(
    method: string,
    params: unknown,
    options: IpcRequestOptions = {},
  ): Promise<IpcResponse> {
    const boundary = options.boundary ?? {};
    await withOperationBoundary(this.#ensureConnected(), boundary);
    throwIfOperationBoundaryElapsed(boundary);
    const socket = this.#socket;
    if (socket === undefined || !socket.writable)
      throw new Error("Codex desktop IPC is not connected");
    if (this.#clientId === INITIALIZING_CLIENT_ID && method !== "initialize") {
      throw new Error("Codex desktop IPC is not initialized");
    }

    const requestId = randomUUID();
    const remainingTimeoutMs = remainingTimeout(boundary);
    const request = {
      type: "request",
      requestId,
      sourceClientId: this.#clientId,
      version: requestVersions[method] ?? 0,
      method,
      params,
      ...(options.targetClientId === undefined ? {} : { targetClientId: options.targetClientId }),
      ...(remainingTimeoutMs === undefined ? {} : { timeoutMs: remainingTimeoutMs }),
    };
    let dispatched = false;
    const completion = new Promise<IpcResponse>((resolve, reject) => {
      const cancelBoundary = subscribeOperationBoundary(boundary, () => {
        const pending = this.#pendingResponses.get(requestId);
        if (pending === undefined) return;
        const boundaryError = operationBoundaryError(
          boundary,
          `Codex desktop IPC request: ${method}`,
        );
        if (dispatched && options.awaitResponseAfterBoundary === true) {
          pending.cancelBoundary();
          return;
        }
        this.#pendingResponses.delete(requestId);
        pending.cancelBoundary();
        pending.reject(boundaryError);
      });
      this.#pendingResponses.set(requestId, { resolve, reject, cancelBoundary });
    });
    try {
      throwIfOperationBoundaryElapsed(boundary);
      socket.write(encodeFrame(request));
      dispatched = true;
      options.onDispatched?.();
    } catch (error) {
      const pending = this.#pendingResponses.get(requestId);
      this.#pendingResponses.delete(requestId);
      pending?.cancelBoundary();
      pending?.reject(toError(error));
    }
    return completion;
  }

  async #sendBroadcast(
    method: string,
    params: unknown,
    options: {
      readonly targetClientIds?: readonly string[];
      readonly boundary?: OperationBoundary;
    } = {},
  ): Promise<void> {
    await withOperationBoundary(this.#ensureConnected(), options.boundary ?? {});
    throwIfOperationBoundaryElapsed(options.boundary ?? {});
    const socket = this.#socket;
    if (socket === undefined || !socket.writable) {
      throw new Error("Codex desktop IPC is not connected");
    }
    if (this.#clientId === INITIALIZING_CLIENT_ID) {
      throw new Error("Codex desktop IPC is not initialized");
    }
    const frame = encodeFrame({
      type: "broadcast",
      method,
      sourceClientId: this.#clientId,
      version: broadcastVersions[method] ?? 0,
      params,
      ...(options.targetClientIds === undefined
        ? {}
        : { targetClientIds: options.targetClientIds }),
    });
    await withOperationBoundary(
      new Promise<void>((resolve, reject) => {
        socket.write(frame, (error) => (error == null ? resolve() : reject(error)));
      }),
      options.boundary ?? {},
    );
  }

  #waitForThreadSnapshot(
    threadId: string,
    hostId: string,
    ownerClientId: string,
    minimumRevision: number,
    boundary: OperationBoundary,
  ): Promise<CodexDesktopThreadSnapshot> {
    const key = threadSnapshotKey(threadId, hostId);
    const latest = this.#latestThreadSnapshots.get(key);
    if (
      latest !== undefined &&
      latest.ownerClientId === ownerClientId &&
      latest.revision >= minimumRevision
    ) {
      return Promise.resolve(latest);
    }
    return new Promise((resolve, reject) => {
      let cancel = () => undefined;
      const cancelBoundary = subscribeOperationBoundary(boundary, () => {
        cancel();
        reject(
          operationBoundaryError(
            boundary,
            `Codex desktop thread snapshot at revision ${minimumRevision}: ${threadId}`,
          ),
        );
      });
      const pending: PendingThreadSnapshot = {
        ownerClientId,
        minimumRevision,
        resolve: (snapshot) => {
          cancel();
          resolve(snapshot);
        },
        reject: (error) => {
          cancel();
          reject(error);
        },
        cancelBoundary,
        cancel: () => cancel(),
      };
      cancel = () => {
        pending.cancelBoundary();
        const set = this.#pendingThreadSnapshots.get(key);
        set?.delete(pending);
        if (set?.size === 0) this.#pendingThreadSnapshots.delete(key);
      };
      const set = this.#pendingThreadSnapshots.get(key) ?? new Set<PendingThreadSnapshot>();
      set.add(pending);
      this.#pendingThreadSnapshots.set(key, set);
    });
  }

  async #ensureConnected(): Promise<void> {
    if (this.#disposed) throw new Error("Codex desktop IPC client is disposed");
    if (this.#socket?.writable === true && this.#clientId !== INITIALIZING_CLIENT_ID) return;
    if (this.#connectInFlight !== undefined) return this.#connectInFlight;
    this.#connectInFlight = this.#connectAndInitialize().finally(() => {
      this.#connectInFlight = undefined;
    });
    return this.#connectInFlight;
  }

  async #connectAndInitialize(): Promise<void> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = connect(this.#endpoint);
      candidate.once("connect", () => {
        resolve(candidate);
      });
      candidate.once("error", (error) => {
        reject(error);
      });
    });
    if (this.#disposed) {
      socket.destroy();
      throw new Error("Codex desktop IPC client is disposed");
    }
    this.#socket = socket;
    this.#readBuffer = Buffer.alloc(0);
    this.#clientId = INITIALIZING_CLIENT_ID;
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("close", () => this.#onSocketClosed(socket));
    socket.on("error", () => undefined);

    const initialized = await this.#sendRequestWithoutConnect("initialize", {
      clientType: this.#clientType,
    });
    if (initialized.resultType === "error") {
      socket.destroy();
      throw new Error(
        `Codex desktop IPC initialization failed: ${initialized.error ?? "unknown error"}`,
      );
    }
    const result = asRecord(initialized.result);
    if (typeof result.clientId !== "string" || result.clientId.length === 0) {
      socket.destroy();
      throw new Error("Codex desktop IPC initialization returned no client id");
    }
    this.#clientId = result.clientId;
  }

  async #sendRequestWithoutConnect(method: "initialize", params: unknown): Promise<IpcResponse> {
    const socket = this.#socket;
    if (socket === undefined || !socket.writable)
      throw new Error("Codex desktop IPC is not connected");
    const requestId = randomUUID();
    const completion = new Promise<IpcResponse>((resolve, reject) => {
      this.#pendingResponses.set(requestId, {
        resolve,
        reject,
        cancelBoundary: () => undefined,
      });
    });
    socket.write(
      encodeFrame({
        type: "request",
        requestId,
        sourceClientId: INITIALIZING_CLIENT_ID,
        version: 0,
        method,
        params,
      }),
    );
    return completion;
  }

  #onData(chunk: Buffer): void {
    this.#readBuffer = Buffer.concat([this.#readBuffer, chunk]);
    while (this.#readBuffer.length >= 4) {
      const length = this.#readBuffer.readUInt32LE(0);
      if (length === 0 || length > MAX_IPC_FRAME_BYTES) {
        this.#socket?.destroy(new Error(`Invalid Codex desktop IPC frame length: ${length}`));
        return;
      }
      if (this.#readBuffer.length < 4 + length) return;
      const payload = this.#readBuffer.subarray(4, 4 + length).toString("utf8");
      this.#readBuffer = this.#readBuffer.subarray(4 + length);
      let message: unknown;
      try {
        message = JSON.parse(payload);
      } catch {
        this.#socket?.destroy(new Error("Invalid Codex desktop IPC JSON frame"));
        return;
      }
      this.#handleMessage(message);
    }
  }

  #handleMessage(value: unknown): void {
    const message = asRecord(value);
    if (message.type === "broadcast") {
      this.#handleBroadcast(message as unknown as IpcBroadcast);
      return;
    }
    if (message.type === "response" && typeof message.requestId === "string") {
      const pending = this.#pendingResponses.get(message.requestId);
      if (pending === undefined) return;
      this.#pendingResponses.delete(message.requestId);
      pending.cancelBoundary();
      pending.resolve(message as unknown as IpcResponse);
      return;
    }
    if (message.type === "client-discovery-request" && typeof message.requestId === "string") {
      const discovery = message as unknown as IpcClientDiscoveryRequest;
      this.#socket?.write(
        encodeFrame({
          type: "client-discovery-response",
          requestId: discovery.requestId,
          response: { canHandle: false },
        }),
      );
    }
  }

  #handleBroadcast(message: IpcBroadcast): void {
    if (
      message.targetClientIds !== undefined &&
      !message.targetClientIds.includes(this.#clientId)
    ) {
      return;
    }
    if (message.method !== "thread-stream-state-changed") return;
    const params = asRecord(message.params);
    const change = asRecord(params.change);
    if (typeof params.conversationId !== "string" || typeof params.hostId !== "string") {
      return;
    }
    const key = threadSnapshotKey(params.conversationId, params.hostId);
    let snapshot: CodexDesktopThreadSnapshot | undefined;
    if (
      change.type === "snapshot" &&
      Number.isSafeInteger(change.revision) &&
      (change.revision as number) >= 0 &&
      isRecord(change.conversationState)
    ) {
      snapshot = {
        threadId: params.conversationId,
        hostId: params.hostId,
        ownerClientId: message.sourceClientId,
        revision: change.revision as number,
        conversationState: change.conversationState,
      };
    } else if (
      change.type === "patches" &&
      Number.isSafeInteger(change.baseRevision) &&
      Number.isSafeInteger(change.revision) &&
      Array.isArray(change.patches)
    ) {
      const previous = this.#latestThreadSnapshots.get(key);
      if (
        previous === undefined ||
        previous.ownerClientId !== message.sourceClientId ||
        previous.revision !== change.baseRevision
      ) {
        this.#requestThreadSnapshotResync(
          params.conversationId,
          params.hostId,
          message.sourceClientId,
        );
        return;
      }
      try {
        snapshot = {
          ...previous,
          revision: change.revision as number,
          conversationState: applyJsonPatches(previous.conversationState, change.patches),
        };
      } catch {
        this.#requestThreadSnapshotResync(
          params.conversationId,
          params.hostId,
          message.sourceClientId,
        );
        return;
      }
    }
    if (snapshot === undefined) return;
    this.#latestThreadSnapshots.set(key, snapshot);
    const pending = this.#pendingThreadSnapshots.get(key);
    if (pending === undefined) return;
    for (const waiter of [...pending]) {
      if (
        waiter.ownerClientId === snapshot.ownerClientId &&
        snapshot.revision >= waiter.minimumRevision
      ) {
        waiter.resolve(snapshot);
      }
    }
  }

  #requestThreadSnapshotResync(threadId: string, hostId: string, ownerClientId: string): void {
    const key = threadSnapshotKey(threadId, hostId);
    const follower = this.#threadFollowers.get(key);
    if (follower === undefined || follower.ownerClientId !== ownerClientId) return;
    this.#latestThreadSnapshots.delete(key);
    void follower.ready
      .then(() =>
        this.#sendBroadcast(
          "thread-stream-following-changed",
          { conversationId: threadId, hostId, following: true },
          { targetClientIds: [ownerClientId] },
        ),
      )
      .catch(() => undefined);
  }

  #onSocketClosed(socket: Socket): void {
    if (this.#socket !== socket) return;
    this.#socket = undefined;
    this.#readBuffer = Buffer.alloc(0);
    this.#clientId = INITIALIZING_CLIENT_ID;
    this.#latestThreadSnapshots.clear();
    this.#threadFollowers.clear();
    this.#rejectPendingThreadSnapshots(new Error("Codex desktop IPC connection closed"));
    this.#rejectPending(new Error("Codex desktop IPC connection closed"));
  }

  #rejectPending(error: Error): void {
    for (const [requestId, pending] of this.#pendingResponses) {
      this.#pendingResponses.delete(requestId);
      pending.cancelBoundary();
      pending.reject(error);
    }
  }

  #rejectPendingThreadSnapshots(error: Error): void {
    for (const pending of this.#pendingThreadSnapshots.values()) {
      for (const waiter of [...pending]) waiter.reject(error);
    }
    this.#pendingThreadSnapshots.clear();
  }
}

function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length === 0 || payload.length > MAX_IPC_FRAME_BYTES) {
    throw new Error(`Invalid Codex desktop IPC payload length: ${payload.length}`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function followUpRequestFingerprint(request: FollowUpRequest): string {
  return JSON.stringify({
    threadId: request.threadId,
    prompt: request.prompt,
    cwd: request.cwd,
    hostId: request.hostId,
    threadSettings: request.threadSettings,
  });
}

function assertMatchingFollowUpReplay(key: string, expected: string, actual: string): void {
  if (expected === actual) return;
  throw new Error(`Codex thread clientUserMessageId ${key} was reused with different input`);
}

function requiredString(value: string, name: string): string {
  if (value.length === 0) throw new Error(`${name} must not be empty`);
  return value;
}

function requiredPrompt(value: string): string {
  if (value.trim().length === 0) throw new Error("prompt must not be empty");
  return value;
}

function threadSnapshotKey(threadId: string, hostId: string): string {
  return `${hostId}\u0000${threadId}`;
}

function followUpOptions(request: FollowUpRequest): CodexThreadFollowUpOptions {
  return {
    clientUserMessageId: request.clientUserMessageId,
    cwd: request.cwd,
    hostId: request.hostId,
    ...(request.threadSettings === undefined ? {} : { threadSettings: request.threadSettings }),
  };
}

function followUpRequest(item: PersistedCodexThreadFollowUp): FollowUpRequest {
  return {
    threadId: item.threadId,
    prompt: item.prompt,
    clientUserMessageId: item.clientUserMessageId,
    cwd: item.cwd ?? "/",
    hostId: item.hostId ?? "local",
    ...(item.threadSettings === undefined ? {} : { threadSettings: item.threadSettings }),
    boundary: {},
  };
}

function threadIsActive(conversationState: Record<string, unknown>): boolean {
  const runtimeStatus = asRecord(conversationState.threadRuntimeStatus);
  if (runtimeStatus.type === "active") return true;
  const turns = conversationState.turns;
  return (
    Array.isArray(turns) &&
    turns.some((candidate) => {
      const turn = asRecord(candidate);
      return turn.status === "inProgress" || turn.status === "in_progress";
    })
  );
}

function snapshotContainsClientMessage(
  conversationState: Record<string, unknown>,
  clientUserMessageId: string,
): boolean {
  const stack: unknown[] = [conversationState.turns];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      if (seen.has(value)) continue;
      seen.add(value);
      for (const item of value) stack.push(item);
      continue;
    }
    if (!isRecord(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (value.clientUserMessageId === clientUserMessageId) return true;
    stack.push(...Object.values(value));
  }
  return false;
}

function queueDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function operationBoundary(options: {
  readonly timeoutMs?: number;
  readonly deadlineUnixMs?: number;
  readonly signal?: AbortSignal;
}): OperationBoundary {
  let deadlineUnixMs: number | undefined;
  if (options.timeoutMs !== undefined) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive finite number");
    }
    const timeoutDeadline = Math.ceil(Date.now() + options.timeoutMs);
    if (!Number.isSafeInteger(timeoutDeadline)) {
      throw new RangeError("timeoutMs exceeds the supported timestamp range");
    }
    deadlineUnixMs = timeoutDeadline;
  }
  if (options.deadlineUnixMs !== undefined) {
    if (!Number.isSafeInteger(options.deadlineUnixMs) || options.deadlineUnixMs < 0) {
      throw new RangeError("deadlineUnixMs must be a non-negative safe integer");
    }
    deadlineUnixMs =
      deadlineUnixMs === undefined
        ? options.deadlineUnixMs
        : Math.min(deadlineUnixMs, options.deadlineUnixMs);
  }
  return {
    ...(deadlineUnixMs === undefined ? {} : { deadlineUnixMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function boundaryOptions(boundary: OperationBoundary): {
  readonly deadlineUnixMs?: number;
  readonly signal?: AbortSignal;
} {
  return {
    ...(boundary.deadlineUnixMs === undefined ? {} : { deadlineUnixMs: boundary.deadlineUnixMs }),
    ...(boundary.signal === undefined ? {} : { signal: boundary.signal }),
  };
}

function hasOperationBoundary(boundary: OperationBoundary): boolean {
  return boundary.deadlineUnixMs !== undefined || boundary.signal !== undefined;
}

function remainingTimeout(boundary: OperationBoundary): number | undefined {
  if (boundary.deadlineUnixMs === undefined) return undefined;
  return Math.max(1, Math.ceil(boundary.deadlineUnixMs - Date.now()));
}

function throwIfOperationBoundaryElapsed(boundary: OperationBoundary): void {
  if (
    boundary.signal?.aborted === true ||
    (boundary.deadlineUnixMs !== undefined && boundary.deadlineUnixMs <= Date.now())
  ) {
    throw operationBoundaryError(boundary);
  }
}

function operationBoundaryError(
  boundary: OperationBoundary,
  context = "Codex desktop IPC operation",
) {
  if (boundary.signal?.aborted === true) {
    if (boundary.signal.reason instanceof Error) return boundary.signal.reason;
    const error = new Error(
      boundary.signal.reason === undefined
        ? `${context} was aborted`
        : `${context} was aborted: ${String(boundary.signal.reason)}`,
    );
    error.name = "AbortError";
    return error;
  }
  const error = new Error(`${context} timed out`);
  error.name = "TimeoutError";
  return error;
}

function subscribeOperationBoundary(
  boundary: OperationBoundary,
  onElapsed: () => void,
): () => void {
  if (!hasOperationBoundary(boundary)) return () => undefined;
  let active = true;
  let timer: NodeJS.Timeout | undefined;
  const signal = boundary.signal;
  const onAbort = () => finish();
  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    signal?.removeEventListener("abort", onAbort);
  };
  const finish = () => {
    if (!active) return;
    active = false;
    cleanup();
    onElapsed();
  };
  const scheduleDeadline = () => {
    if (!active || boundary.deadlineUnixMs === undefined) return;
    const remaining = boundary.deadlineUnixMs - Date.now();
    if (remaining <= 0) {
      queueMicrotask(finish);
      return;
    }
    timer = setTimeout(
      remaining > MAX_TIMER_DELAY_MS ? scheduleDeadline : finish,
      Math.min(remaining, MAX_TIMER_DELAY_MS),
    );
  };
  if (signal?.aborted === true) queueMicrotask(finish);
  else signal?.addEventListener("abort", onAbort, { once: true });
  scheduleDeadline();
  return () => {
    if (!active) return;
    active = false;
    cleanup();
  };
}

function withOperationBoundary<T>(
  completion: Promise<T>,
  boundary: OperationBoundary,
  errorFactory: () => Error = () => operationBoundaryError(boundary),
): Promise<T> {
  if (!hasOperationBoundary(boundary)) return completion;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cancelBoundary = subscribeOperationBoundary(boundary, () => {
      if (settled) return;
      settled = true;
      reject(errorFactory());
    });
    completion.then(
      (value) => {
        if (settled) return;
        settled = true;
        cancelBoundary();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cancelBoundary();
        reject(error);
      },
    );
  });
}

function withMutationOperationBoundary<T>(
  completion: Promise<T>,
  boundary: OperationBoundary,
  errorFactory: () => Error,
): Promise<T> {
  if (!hasOperationBoundary(boundary)) return completion;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cancelBoundary = subscribeOperationBoundary(boundary, () => {
      if (settled) return;
      settled = true;
      reject(errorFactory());
    });
    completion.then(
      (value) => {
        if (settled) return;
        settled = true;
        cancelBoundary();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cancelBoundary();
        reject(error);
      },
    );
  });
}

function replayExpiry(now: number, replayWindowMs: number | undefined): number {
  if (replayWindowMs === undefined) return Number.POSITIVE_INFINITY;
  const expiry = now + replayWindowMs;
  return Number.isSafeInteger(expiry) ? expiry : Number.POSITIVE_INFINITY;
}

function optionalPositiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function applyJsonPatches(
  value: Record<string, unknown>,
  patches: readonly unknown[],
): Record<string, unknown> {
  let root: unknown = structuredClone(value);
  for (const candidate of patches) {
    const patch = asRecord(candidate);
    if (patch.op !== "add" && patch.op !== "replace" && patch.op !== "remove") {
      throw new Error("Unsupported Codex desktop state patch operation");
    }
    const path = patchPath(patch.path);
    if (path.length === 0) {
      if (patch.op === "remove" || !isRecord(patch.value)) {
        throw new Error("Invalid Codex desktop root state patch");
      }
      root = structuredClone(patch.value);
      continue;
    }
    let parent: unknown = root;
    for (const segment of path.slice(0, -1)) {
      parent = patchChild(parent, segment);
    }
    const key = path.at(-1);
    if (key === undefined) throw new Error("Invalid Codex desktop state patch path");
    applyPatchAt(parent, key, patch.op, patch.value);
  }
  if (!isRecord(root)) throw new Error("Codex desktop state patch produced a non-object root");
  return root;
}

function patchPath(value: unknown): Array<string | number> {
  if (!Array.isArray(value)) throw new Error("Codex desktop state patch path must be an array");
  return value.map((segment) => {
    if (typeof segment !== "string" && !Number.isSafeInteger(segment)) {
      throw new Error("Invalid Codex desktop state patch segment");
    }
    if (segment === "__proto__" || segment === "prototype" || segment === "constructor") {
      throw new Error("Unsafe Codex desktop state patch segment");
    }
    return segment as string | number;
  });
}

function patchChild(parent: unknown, key: string | number): unknown {
  if (Array.isArray(parent)) {
    const index = patchArrayIndex(key, parent.length, false);
    const child = parent[index];
    if (child === undefined) throw new Error("Codex desktop state patch path does not exist");
    return child;
  }
  if (!isRecord(parent) || typeof key !== "string" || !(key in parent)) {
    throw new Error("Codex desktop state patch path does not exist");
  }
  return parent[key];
}

function applyPatchAt(
  parent: unknown,
  key: string | number,
  operation: "add" | "replace" | "remove",
  value: unknown,
): void {
  if (Array.isArray(parent)) {
    const index = patchArrayIndex(key, parent.length, operation === "add");
    if (operation === "add") parent.splice(index, 0, structuredClone(value));
    else if (operation === "remove") parent.splice(index, 1);
    else parent[index] = structuredClone(value);
    return;
  }
  if (!isRecord(parent) || typeof key !== "string") {
    throw new Error("Invalid Codex desktop state patch parent");
  }
  if (operation !== "add" && !(key in parent)) {
    throw new Error("Codex desktop state patch target does not exist");
  }
  if (operation === "remove") delete parent[key];
  else parent[key] = structuredClone(value);
}

function patchArrayIndex(key: string | number, length: number, allowEnd: boolean): number {
  if (key === "-" && allowEnd) return length;
  const index = typeof key === "number" ? key : Number(key);
  const maximum = allowEnd ? length : length - 1;
  if (!Number.isSafeInteger(index) || index < 0 || index > maximum) {
    throw new Error("Invalid Codex desktop state patch array index");
  }
  return index;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
