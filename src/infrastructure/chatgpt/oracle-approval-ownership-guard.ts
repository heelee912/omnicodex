import { Buffer } from "node:buffer";
import { assertExplicitLoopbackCdpEndpoint } from "./chatgpt-app-approval-adapter.js";
import {
  CdpFrameError,
  CdpProtocolError,
  type CdpWebSocketFactory,
  type CdpWebSocketLike,
  ORACLE_APPROVAL_OWNER_CLAIM_EXPRESSION,
} from "./chatgpt-cdp-transport.js";

const PAGE_TARGET_FILTER = [{ type: "page", exclude: false }, { exclude: true }] as const;

export interface OracleApprovalOwnershipGuardOptions {
  readonly endpoint: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly websocketFactory?: CdpWebSocketFactory;
  readonly timeoutMs?: number;
  /** Optional caller-selected cap; omission accepts the complete CDP frame. */
  readonly maxFrameBytes?: number;
  readonly onUnhealthy?: (error: Error) => Promise<void> | void;
}

/**
 * Browser-target CDP guard that establishes the daemon as the one approval
 * owner on every existing and future Oracle page. Auto-attachment never pauses
 * the renderer: the guard installs the owner in the current document and every
 * future document, while click authority remains in the run-bound watcher.
 */
export class OracleApprovalOwnershipGuard {
  readonly #endpoint: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #websocketFactory: CdpWebSocketFactory;
  readonly #timeoutMs: number | undefined;
  readonly #maxFrameBytes: number | undefined;
  readonly #onUnhealthy: ((error: Error) => Promise<void> | void) | undefined;
  readonly #pending = new Map<
    number,
    {
      readonly method: string;
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
      readonly cancelTimeout?: () => void;
      readonly abort?: () => void;
      readonly signal?: AbortSignal;
    }
  >();
  // Chrome can report an auto-attached session for a page at the same time as
  // startup inventory attaches another session to that page. Bootstrap and,
  // crucially, resume each CDP session independently. Coalescing by targetId
  // can strand the second session in waitForDebuggerOnStart and freeze the
  // renderer for every other client.
  readonly #sessionBootstraps = new Map<string, Promise<void>>();
  readonly #attachedSessions = new Set<string>();
  #socket: CdpWebSocketLike | undefined;
  #nextId = 0;
  #started = false;
  #stopping = false;
  #unhealthyReported = false;

  constructor(options: OracleApprovalOwnershipGuardOptions) {
    this.#endpoint = assertExplicitLoopbackCdpEndpoint(options.endpoint);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#websocketFactory =
      options.websocketFactory ?? ((url) => new WebSocket(url) as unknown as CdpWebSocketLike);
    this.#timeoutMs = optionalPositiveSafeInteger(options.timeoutMs, "timeoutMs");
    this.#maxFrameBytes = optionalPositiveSafeInteger(options.maxFrameBytes, "maxFrameBytes");
    this.#onUnhealthy = options.onUnhealthy;
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.#started) return;
    if (this.#socket !== undefined) throw new Error("Oracle approval ownership guard is starting");
    this.#stopping = false;
    this.#unhealthyReported = false;
    const websocketUrl = await this.#browserWebSocketUrl(signal);
    const socket = this.#websocketFactory(websocketUrl);
    this.#socket = socket;
    socket.addEventListener("message", (event) => this.#message(socket, event.data));
    socket.addEventListener("close", (event) =>
      this.#closed(socket, new CdpFrameError("CDP browser socket closed", event.data)),
    );
    socket.addEventListener("error", (event) =>
      this.#closed(socket, new CdpFrameError("CDP browser socket failed", event.data)),
    );
    try {
      await waitForOpen(socket, this.#timeoutMs, signal);
      await this.#command(
        "Target.setAutoAttach",
        {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: PAGE_TARGET_FILTER,
        },
        undefined,
        signal,
      );
      const result = await this.#command("Target.getTargets", {}, undefined, signal);
      const targetInfos = objectValue(result).targetInfos;
      if (!Array.isArray(targetInfos))
        throw new Error("Oracle browser target inventory is invalid");
      // Browser-socket ownership is established once auto-attach and inventory
      // succeed. A single already-open renderer can be busy or stale and must
      // not turn that browser-wide success into a tunnel failure. Bootstrap
      // existing pages in the background; future pages are still paused and
      // initialized before execution by Target.attachedToTarget.
      this.#started = true;
      for (const targetInfo of targetInfos) {
        const target = objectValue(targetInfo);
        if (target.type !== "page" || typeof target.targetId !== "string") continue;
        void this.#ensureExistingTarget(target.targetId, signal).catch(() => undefined);
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const socket = this.#socket;
    if (socket === undefined) {
      this.#started = false;
      return;
    }
    if (socket.readyState === 1) {
      await this.#command("Target.setAutoAttach", {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      }).catch(() => undefined);
    }
    this.#socket = undefined;
    this.#started = false;
    this.#sessionBootstraps.clear();
    this.#attachedSessions.clear();
    socket.close(1000, "approval-owner-guard-stopped");
    this.#failPending(new Error("Oracle approval ownership guard stopped"));
  }

  async #ensureExistingTarget(targetId: string, signal?: AbortSignal): Promise<void> {
    const attached = objectValue(
      await this.#command("Target.attachToTarget", { targetId, flatten: true }, undefined, signal),
    );
    if (typeof attached.sessionId !== "string") {
      throw new Error("Oracle page target attachment returned no session");
    }
    this.#attachedSessions.add(attached.sessionId);
    return this.#bootstrapSession(attached.sessionId, false, signal);
  }

  #bootstrapSession(
    sessionId: string,
    waitingForDebugger: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const existing = this.#sessionBootstraps.get(sessionId);
    if (existing !== undefined) return existing;
    const bootstrap = (async () => {
      let failure: unknown;
      let resumeFailure: unknown;
      try {
        await this.#command(
          "Page.addScriptToEvaluateOnNewDocument",
          { source: ORACLE_APPROVAL_OWNER_CLAIM_EXPRESSION },
          sessionId,
          signal,
        );
        if (!waitingForDebugger) {
          await this.#command(
            "Runtime.evaluate",
            {
              expression: ORACLE_APPROVAL_OWNER_CLAIM_EXPRESSION,
              returnByValue: true,
              awaitPromise: false,
            },
            sessionId,
            signal,
          );
        }
      } catch (error) {
        failure = error;
      } finally {
        if (waitingForDebugger) {
          try {
            await this.#resumeWaitingSession(sessionId);
          } catch (error) {
            resumeFailure = error;
          }
        }
      }
      if (failure !== undefined) throw failure;
      if (resumeFailure !== undefined) throw resumeFailure;
    })();
    this.#sessionBootstraps.set(sessionId, bootstrap);
    void bootstrap.catch(() => {
      // Target-scoped failures are reconnectable and may reflect one renderer,
      // not the browser socket or SSH forward. Forget the failed bootstrap so
      // a later attachment can retry; only browser-socket failures are global.
      if (this.#sessionBootstraps.get(sessionId) === bootstrap) {
        this.#sessionBootstraps.delete(sessionId);
      }
    });
    return bootstrap;
  }

  #command(
    method: string,
    params: unknown,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== 1) {
      return Promise.reject(new Error("Oracle approval ownership guard is disconnected"));
    }
    if (signal?.aborted === true) {
      return Promise.reject(
        errorWithCause("Oracle approval ownership guard command cancelled", signal.reason),
      );
    }
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const cancelTimeout = optionalDeadline(this.#timeoutMs, () => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        this.#releasePending(pending);
        pending.reject(new Error(`${method}: CDP command timed out`));
      });
      const abort =
        signal === undefined
          ? undefined
          : () => {
              const pending = this.#pending.get(id);
              if (pending === undefined) return;
              this.#pending.delete(id);
              this.#releasePending(pending);
              pending.reject(errorWithCause(`${method}: CDP command cancelled`, signal.reason));
            };
      this.#pending.set(id, {
        method,
        resolve,
        reject,
        ...(cancelTimeout === undefined ? {} : { cancelTimeout }),
        ...(abort === undefined || signal === undefined ? {} : { abort, signal }),
      });
      if (abort !== undefined) signal?.addEventListener("abort", abort, { once: true });
      try {
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        cancelTimeout?.();
        if (abort !== undefined) signal?.removeEventListener("abort", abort);
        this.#pending.delete(id);
        reject(toError(error));
      }
    });
  }

  #message(socket: CdpWebSocketLike, data: unknown): void {
    if (socket !== this.#socket) return;
    if (typeof data !== "string") {
      this.#closed(socket, new CdpFrameError("CDP_BROWSER_FRAME_TYPE_INVALID", data));
      socket.close(1000, "invalid-frame");
      return;
    }
    if (this.#maxFrameBytes !== undefined && Buffer.byteLength(data) > this.#maxFrameBytes) {
      this.#closed(socket, new CdpFrameError("CDP_BROWSER_FRAME_OVERSIZED", data));
      socket.close(1000, "oversized-frame");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch (error) {
      this.#closed(socket, new CdpFrameError("CDP_BROWSER_FRAME_JSON_INVALID", data, error));
      socket.close(1000, "invalid-frame");
      return;
    }
    if (!isObject(parsed)) {
      this.#closed(socket, new CdpFrameError("CDP_BROWSER_FRAME_SHAPE_INVALID", parsed));
      socket.close(1000, "invalid-frame");
      return;
    }
    const message = parsed;
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      this.#releasePending(pending);
      if (message.error !== undefined) {
        pending.reject(new CdpProtocolError(pending.method, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method === "Target.attachedToTarget") {
      const params = objectValue(message.params);
      const targetInfo = objectValue(params.targetInfo);
      if (
        targetInfo.type !== "page" ||
        typeof targetInfo.targetId !== "string" ||
        typeof params.sessionId !== "string"
      ) {
        return;
      }
      this.#attachedSessions.add(params.sessionId);
      void this.#bootstrapSession(params.sessionId, params.waitingForDebugger === true);
      return;
    }
    if (message.method === "Target.detachedFromTarget") {
      const params = objectValue(message.params);
      if (typeof params.sessionId === "string") {
        this.#attachedSessions.delete(params.sessionId);
        this.#sessionBootstraps.delete(params.sessionId);
      }
    }
  }

  #closed(socket: CdpWebSocketLike, failure: string | Error): void {
    if (socket !== this.#socket) return;
    const wasStarted = this.#started;
    this.#socket = undefined;
    this.#started = false;
    this.#sessionBootstraps.clear();
    this.#attachedSessions.clear();
    const error = typeof failure === "string" ? new Error(failure) : failure;
    this.#failPending(error);
    if (!this.#stopping && wasStarted) void this.#reportUnhealthy(error);
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      this.#releasePending(pending);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #releasePending(pending: {
    readonly cancelTimeout?: () => void;
    readonly abort?: () => void;
    readonly signal?: AbortSignal;
  }): void {
    pending.cancelTimeout?.();
    if (pending.abort !== undefined) pending.signal?.removeEventListener("abort", pending.abort);
  }

  async #browserWebSocketUrl(signal?: AbortSignal): Promise<string> {
    const deadline = optionalAbortDeadline(
      this.#timeoutMs,
      "Oracle browser CDP preflight timed out",
    );
    let response: Response;
    let text: string;
    try {
      const requestSignal = combineAbortSignals(signal, deadline?.signal);
      response = await this.#fetch(new URL("/json/version", this.#endpoint), {
        method: "GET",
        redirect: "error",
        ...(requestSignal === undefined ? {} : { signal: requestSignal }),
      });
      text = await response.text();
    } finally {
      deadline?.cancel();
    }
    if (this.#maxFrameBytes !== undefined && Buffer.byteLength(text) > this.#maxFrameBytes) {
      throw new CdpFrameError("ORACLE_BROWSER_CDP_PREFLIGHT_OVERSIZED", text);
    }
    if (!response.ok) {
      throw errorWithCause(`Oracle browser CDP preflight HTTP ${String(response.status)}`, {
        status: response.status,
        statusText: response.statusText,
        payload: text,
      });
    }
    const payload = objectValue(JSON.parse(text) as unknown);
    if (typeof payload.Browser !== "string" || !payload.Browser.startsWith("Chrome/")) {
      throw new Error("Oracle browser CDP identity is invalid");
    }
    if (typeof payload.webSocketDebuggerUrl !== "string") {
      throw new Error("Oracle browser CDP websocket is unavailable");
    }
    const websocket = new URL(payload.webSocketDebuggerUrl);
    if (
      websocket.protocol !== "ws:" ||
      !isLoopbackHost(websocket.hostname) ||
      websocket.port !== this.#endpoint.port ||
      !websocket.pathname.startsWith("/devtools/browser/") ||
      websocket.username ||
      websocket.password ||
      websocket.search ||
      websocket.hash
    ) {
      throw new Error("Oracle browser CDP websocket identity is invalid");
    }
    return websocket.href;
  }

  async #reportUnhealthy(error: Error): Promise<void> {
    if (this.#unhealthyReported) return;
    this.#unhealthyReported = true;
    await Promise.resolve(this.#onUnhealthy?.(error)).catch(() => undefined);
  }

  async #resumeWaitingSession(sessionId: string): Promise<void> {
    let consecutiveFailures = 0;
    let lastFailure: Error | undefined;
    while (
      !this.#stopping &&
      this.#socket?.readyState === 1 &&
      this.#attachedSessions.has(sessionId)
    ) {
      try {
        await this.#command("Runtime.runIfWaitingForDebugger", {}, sessionId);
        return;
      } catch (error) {
        lastFailure = toError(error);
        consecutiveFailures += 1;
        // One dropped response is recoverable and runIfWaitingForDebugger is
        // idempotent. A second consecutive failure means a page can remain
        // browser-wide paused, so trigger the existing guard/tunnel recovery
        // while continuing to retry this exact attached session.
        if (consecutiveFailures >= 2) await this.#reportUnhealthy(lastFailure);
        await delay(Math.min(1_000, 50 * 2 ** Math.min(consecutiveFailures - 1, 4)));
      }
    }
    throw lastFailure ?? new Error("Oracle waiting page detached before it could be resumed");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOpen(
  socket: CdpWebSocketLike,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (socket.readyState === 1) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cancelTimeout?.();
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const cancelTimeout = optionalDeadline(timeoutMs, () =>
      finish(() => reject(new Error("Oracle browser CDP websocket open timed out"))),
    );
    const onAbort = () =>
      finish(() =>
        reject(errorWithCause("Oracle browser CDP websocket open cancelled", signal?.reason)),
      );
    socket.addEventListener("open", () => finish(resolve), { once: true });
    socket.addEventListener(
      "error",
      () => finish(() => reject(new Error("Oracle browser CDP websocket open failed"))),
      { once: true },
    );
    socket.addEventListener(
      "close",
      () => finish(() => reject(new Error("Oracle browser CDP websocket closed before open"))),
      { once: true },
    );
    if (signal?.aborted === true) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
  });
}

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

function optionalPositiveSafeInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Oracle approval ownership guard ${name} must be a positive safe integer`);
  }
  return value;
}

function optionalDeadline(
  timeoutMs: number | undefined,
  action: () => void,
): (() => void) | undefined {
  if (timeoutMs === undefined) return undefined;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remainingMs = timeoutMs;
  const schedule = (): void => {
    if (cancelled) return;
    const delayMs = Math.min(remainingMs, MAX_NODE_TIMER_DELAY_MS);
    timer = setTimeout(() => {
      remainingMs -= delayMs;
      if (remainingMs === 0) {
        action();
        return;
      }
      schedule();
    }, delayMs);
  };
  schedule();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

function optionalAbortDeadline(
  timeoutMs: number | undefined,
  message: string,
): { readonly signal: AbortSignal; readonly cancel: () => void } | undefined {
  if (timeoutMs === undefined) return undefined;
  const controller = new AbortController();
  const cancel = optionalDeadline(timeoutMs, () => controller.abort(new Error(message)));
  if (cancel === undefined) throw new Error("Oracle approval ownership guard deadline invalid");
  return { signal: controller.signal, cancel };
}

function combineAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return AbortSignal.any([first, second]);
}

function errorWithCause(message: string, cause: unknown): Error {
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

function isLoopbackHost(value: string): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(value.toLocaleLowerCase("en-US"));
}

function objectValue(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
