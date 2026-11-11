import { constants as bufferConstants } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { connect, type Socket } from "node:net";

const WINDOWS_PIPE_DIRECTORY = "\\\\.\\pipe\\";
const CODEX_APP_TOOLS_PIPE =
  /^(?:codex-app-tools-|codex-browser-use(?:-|[\\/]))[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// The native protocol uses an unsigned 32-bit length prefix. Do not impose a
// smaller adapter content cap; Node's representable Buffer size is the only
// additional hard boundary.
const MAX_NATIVE_FRAME_BYTES = Math.min(0xffff_ffff, bufferConstants.MAX_LENGTH - 4);
const DISCOVERY_RESCAN_INTERVAL_MS = 100;
const CODEX_APP_READ_ONLY_TOOLS = new Set([
  "capture_screen_context",
  "get_handoff_status",
  "list_archived_threads",
  "list_projects",
  "list_threads",
  "load_workspace_dependencies",
  "read_thread",
  "read_thread_terminal",
  "wait_threads",
]);

export const CODEX_APP_TOOLS_SHARED_READINESS_ERROR_CODE =
  "CODEX_APP_TOOLS_SHARED_READINESS_UNAVAILABLE" as const;

/**
 * The Codex Desktop-owned app-global tools endpoint is temporarily absent or
 * rotating. This readiness boundary is shared by every candidate CLI runtime,
 * so callers must not interpret it as evidence that an older CLI is healthier.
 */
export class CodexAppToolsSharedReadinessError extends Error {
  readonly code = CODEX_APP_TOOLS_SHARED_READINESS_ERROR_CODE;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CodexAppToolsSharedReadinessError";
  }
}

export interface CodexAppNativeTool {
  readonly name: string;
  readonly namespace: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface CodexAppNativeToolCallParams {
  readonly arguments: Record<string, unknown>;
  /** Source of the calling thread, not the tool's target thread. */
  readonly callerSource?: "codex" | "chatgpt";
  readonly callId: string;
  readonly namespace: string;
  readonly threadId: string;
  readonly tool: string;
  readonly turnId: string;
}

export interface CodexAppNativeContentItem {
  readonly type: "inputText" | "inputImage" | "inputAudio";
  readonly text?: string;
  readonly imageUrl?: string;
  readonly audioUrl?: string;
}

export interface CodexAppNativeToolCallResponse {
  readonly success: boolean;
  readonly contentItems: readonly CodexAppNativeContentItem[];
}

export interface CodexAppToolsClient {
  listTools(options?: CodexAppToolsRequestOptions): Promise<readonly CodexAppNativeTool[]>;
  callTool(
    params: CodexAppNativeToolCallParams,
    options?: CodexAppToolsRequestOptions,
  ): Promise<CodexAppNativeToolCallResponse>;
  close(): void;
}

export interface CodexAppToolsRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly deadlineUnixMs?: number;
}

export interface CodexAppToolsPipeClientOptions {
  readonly discoverEndpoints?: () => Promise<readonly string[]>;
  readonly connectTimeoutMs?: number;
  readonly replayWindowMs?: number;
  readonly maxReplayEntries?: number;
  readonly catalogTtlMs?: number;
  readonly now?: () => number;
}

interface SelectedPipe {
  readonly endpoint: string;
  readonly transport: NativePipeTransport;
  readonly callReady: boolean;
  tools: readonly CodexAppNativeTool[];
  listedAt: number;
}

interface ReplayEntry {
  readonly fingerprint: string;
  readonly completion: Promise<CodexAppNativeToolCallResponse>;
  expiresAt: number;
}

interface SelectionFlight {
  readonly controller: AbortController;
  readonly promise: Promise<SelectedPipe>;
  waiters: number;
  settled: boolean;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

interface JsonRpcResponse {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: JsonRpcErrorObject;
}

interface JsonRpcErrorObject extends Record<string, unknown> {
  readonly code: number;
  readonly message: string;
}

/**
 * Persistent, multiplexed client for the app-global native tools host owned by
 * the installed Codex desktop process. It discovers the correct pipe by
 * capability instead of relying on a per-launch UUID.
 */
export class CodexAppToolsPipeClient implements CodexAppToolsClient {
  readonly #discoverEndpoints: () => Promise<readonly string[]>;
  readonly #connectTimeoutMs: number | undefined;
  readonly #replayWindowMs: number | undefined;
  readonly #maxReplayEntries: number | undefined;
  readonly #catalogTtlMs: number | undefined;
  readonly #now: () => number;
  readonly #replays = new Map<string, ReplayEntry>();
  #selected: SelectedPipe | undefined;
  #selecting: SelectionFlight | undefined;
  #closed = false;

  constructor(options: CodexAppToolsPipeClientOptions = {}) {
    this.#discoverEndpoints = options.discoverEndpoints ?? discoverCodexAppToolsPipes;
    this.#connectTimeoutMs = optionalPositiveInteger(options.connectTimeoutMs, "connectTimeoutMs");
    this.#replayWindowMs = optionalPositiveInteger(options.replayWindowMs, "replayWindowMs");
    this.#maxReplayEntries = optionalPositiveInteger(options.maxReplayEntries, "maxReplayEntries");
    this.#catalogTtlMs = optionalNonNegativeInteger(options.catalogTtlMs, "catalogTtlMs");
    this.#now = options.now ?? Date.now;
  }

  async listTools(
    options: CodexAppToolsRequestOptions = {},
  ): Promise<readonly CodexAppNativeTool[]> {
    const deadline = createDeadline(
      options.signal,
      options.timeoutMs,
      options.deadlineUnixMs,
      () =>
        new CodexAppToolsSharedReadinessError(
          options.timeoutMs === undefined
            ? `Codex app-global tools pipe was not ready before ${String(options.deadlineUnixMs)}`
            : `Codex app-global tools pipe was not ready within ${options.timeoutMs}ms`,
        ),
    );
    let selected: SelectedPipe | undefined;
    try {
      const previouslySelected = this.#selected;
      selected = await this.#select(deadline.signal);
      // Discovery already obtained an authoritative catalog for this call.
      // Later calls refresh by default; caching is only enabled when the
      // caller explicitly selects a catalog TTL.
      if (previouslySelected === undefined) return selected.tools;
      if (
        this.#catalogTtlMs !== undefined &&
        this.#now() - selected.listedAt < this.#catalogTtlMs
      ) {
        return selected.tools;
      }
      const tools = parseTools(
        await selected.transport.request("tools/list", undefined, {
          signal: deadline.signal,
          abortAfterDispatch: true,
        }),
      );
      if (!hasRequiredCapability(tools)) {
        throw new NativePipeTransportError(
          "Codex app tools pipe lost required codex_app/list_projects capability",
          false,
          undefined,
          true,
        );
      }
      selected.tools = tools;
      selected.listedAt = this.#now();
      return tools;
    } catch (error) {
      // tools/list is read-only. A disconnect after its frame was written may
      // be replayed against a newly discovered app-global endpoint, unlike a
      // mutation whose outcome would be ambiguous.
      if (deadline.signal.aborted || !isReadOnlyEndpointRediscoveryError(error)) throw error;
      if (selected !== undefined) this.#invalidate(selected);
      selected = await this.#select(deadline.signal);
      return selected.tools;
    } finally {
      deadline.dispose();
    }
  }

  async callTool(
    params: CodexAppNativeToolCallParams,
    options: CodexAppToolsRequestOptions = {},
  ): Promise<CodexAppNativeToolCallResponse> {
    options.signal?.throwIfAborted();
    const normalized = normalizeToolCall(params);
    const fingerprint = canonicalJson(normalized);
    this.#pruneExpiredReplays();
    const replay = this.#replays.get(normalized.callId);
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprint) {
        throw new Error(
          `Codex app tool callId ${normalized.callId} was reused with different input`,
        );
      }
      return replay.completion;
    }
    if (this.#maxReplayEntries !== undefined && this.#replays.size >= this.#maxReplayEntries) {
      throw new Error(
        `Codex app tool replay capacity is exhausted (${this.#maxReplayEntries} retained calls)`,
      );
    }

    let completion!: Promise<CodexAppNativeToolCallResponse>;
    completion = this.#callToolOnce(normalized, options).then(
      (result) => {
        const current = this.#replays.get(normalized.callId);
        if (current?.completion === completion) {
          current.expiresAt = replayExpiry(this.#now(), this.#replayWindowMs);
        }
        return result;
      },
      (error: unknown) => {
        const current = this.#replays.get(normalized.callId);
        if (current?.completion === completion) {
          if (isDefinitelyNotDispatched(error)) {
            this.#replays.delete(normalized.callId);
          } else if (error instanceof CodexAppToolsRpcError) {
            current.expiresAt = replayExpiry(this.#now(), this.#replayWindowMs);
          } else {
            // A disconnected or cancelled mutation may already have taken
            // effect. Its correlation must never age out into a redispatch.
            current.expiresAt = Number.POSITIVE_INFINITY;
          }
        }
        throw error;
      },
    );
    this.#replays.set(normalized.callId, {
      fingerprint,
      completion,
      expiresAt: Number.POSITIVE_INFINITY,
    });
    return completion;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#selected?.transport.close();
    this.#selected = undefined;
    const selecting = this.#selecting;
    this.#selecting = undefined;
    selecting?.controller.abort(new Error("Codex app tools client is closed"));
    this.#replays.clear();
  }

  async #callToolOnce(
    params: CodexAppNativeToolCallParams,
    options: CodexAppToolsRequestOptions,
  ): Promise<CodexAppNativeToolCallResponse> {
    const deadline = createDeadline(options.signal, options.timeoutMs, options.deadlineUnixMs);
    try {
      let selected = await this.#select(deadline.signal, params);
      let result: unknown;
      try {
        const readOnly = nativeToolCallIsReadOnly(selected.tools, params);
        result = await selected.transport.request("tools/call", params, {
          signal: deadline.signal,
          abortAfterDispatch: readOnly,
        });
      } catch (error) {
        const readOnly = nativeToolCallIsReadOnly(selected.tools, params);
        if (
          deadline.signal.aborted ||
          (!isRetryableNotDispatched(error) &&
            !(readOnly && isReadOnlyEndpointRediscoveryError(error)))
        ) {
          throw error;
        }
        this.#invalidate(selected);
        selected = await this.#select(deadline.signal, params);
        result = await selected.transport.request("tools/call", params, {
          signal: deadline.signal,
          abortAfterDispatch: nativeToolCallIsReadOnly(selected.tools, params),
        });
      }
      return parseToolCallResponse(result);
    } finally {
      deadline.dispose();
    }
  }

  async #select(
    signal?: AbortSignal,
    callProbeParams?: CodexAppNativeToolCallParams,
  ): Promise<SelectedPipe> {
    signal?.throwIfAborted();
    if (this.#closed) return Promise.reject(new Error("Codex app tools client is closed"));
    if (this.#selected !== undefined) {
      if (callProbeParams === undefined || this.#selected.callReady) {
        return Promise.resolve(this.#selected);
      }
      // tools/list only proves that the renderer accepted a catalog request.
      // A suspended/stale renderer can still win that race and then never
      // answer tools/call. Re-select with a harmless native call probe before
      // dispatching the caller's operation.
      this.#invalidate(this.#selected);
    }
    let selecting = this.#selecting;
    if (selecting === undefined) {
      const controller = new AbortController();
      let flight!: SelectionFlight;
      const promise = this.#discover(controller.signal, callProbeParams)
        .then((selected) => {
          if (this.#closed || controller.signal.aborted) {
            selected.transport.close();
            throw abortReason(controller.signal);
          }
          const current = this.#selected;
          if (current !== undefined) {
            selected.transport.close();
            return current;
          }
          this.#selected = selected;
          return selected;
        })
        .finally(() => {
          flight.settled = true;
          if (this.#selecting === flight) this.#selecting = undefined;
        });
      flight = { controller, promise, waiters: 0, settled: false };
      selecting = flight;
      this.#selecting = flight;
    }
    selecting.waiters += 1;
    try {
      const selected = await waitWithSignal(selecting.promise, signal);
      if (callProbeParams !== undefined && !selected.callReady) {
        this.#invalidate(selected);
        return await this.#select(signal, callProbeParams);
      }
      return selected;
    } finally {
      selecting.waiters -= 1;
      if (selecting.waiters === 0 && !selecting.settled && this.#selecting === selecting) {
        selecting.controller.abort(new Error("Codex app tools selection no longer has a waiter"));
      }
    }
  }

  async #discover(
    signal?: AbortSignal,
    callProbeParams?: CodexAppNativeToolCallParams,
  ): Promise<SelectedPipe> {
    signal?.throwIfAborted();
    try {
      while (true) {
        let endpoints: readonly string[] = [];
        try {
          endpoints = [...new Set(await waitWithSignal(this.#discoverEndpoints(), signal))]
            .filter((endpoint) => endpoint.length > 0)
            .sort();
        } catch (_error) {
          if (signal?.aborted === true) throw abortReason(signal);
          // Endpoint enumeration is live readiness state; retry until the
          // caller's own boundary or client shutdown ends this discovery.
        }

        if (endpoints.length > 0) {
          try {
            return await this.#probeEndpoints(endpoints, signal, callProbeParams);
          } catch (_error) {
            if (signal?.aborted === true) throw abortReason(signal);
            if (_error instanceof CodexAppToolsRpcError && _error.code === -32602) throw _error;
            // A stale candidate must not terminate app-global discovery.
          }
        }

        await delayWithSignal(DISCOVERY_RESCAN_INTERVAL_MS, signal);
      }
    } catch (error) {
      if (signal?.aborted === true) throw abortReason(signal);
      throw error;
    }
  }

  async #probeEndpoints(
    endpoints: readonly string[],
    signal: AbortSignal | undefined,
    callProbeParams: CodexAppNativeToolCallParams | undefined,
  ): Promise<SelectedPipe> {
    const cancelLosers = new AbortController();
    const parentSignal =
      signal === undefined ? cancelLosers.signal : AbortSignal.any([signal, cancelLosers.signal]);
    const failures = new Array<string>(endpoints.length);
    let protocolError: CodexAppToolsRpcError | undefined;
    const probes = endpoints.map(async (endpoint, index) => {
      const transport = new NativePipeTransport(endpoint, this.#connectTimeoutMs);
      try {
        const result = await transport.request("tools/list", undefined, {
          signal: parentSignal,
          abortAfterDispatch: true,
        });
        const tools = parseTools(result);
        if (hasRequiredCapability(tools)) {
          if (callProbeParams !== undefined && endpoints.length > 1) {
            // The native protocol has no standalone ping. list_projects is a
            // read-only, app-owned operation and is the smallest authoritative
            // proof that this renderer can execute tools/call. Probe all live
            // candidates in parallel, then send the caller's operation only to
            // the first responsive renderer. This avoids both arbitrary health
            // timeouts and duplicate mutation dispatch.
            parseToolCallResponse(
              await transport.request(
                "tools/call",
                {
                  arguments: {},
                  callerSource: callProbeParams.callerSource ?? "codex",
                  callId: `omnicodex-native-readiness-${randomUUID()}`,
                  namespace: "codex_app",
                  threadId: callProbeParams.threadId,
                  tool: "list_projects",
                  turnId: callProbeParams.turnId,
                } satisfies CodexAppNativeToolCallParams,
                { signal: parentSignal, abortAfterDispatch: true },
              ),
            );
          }
          return {
            endpoint,
            transport,
            callReady: callProbeParams !== undefined,
            tools,
            listedAt: this.#now(),
          };
        }
        throw new Error("required codex_app/list_projects capability is absent");
      } catch (error) {
        // A live host rejected our wire contract. Retrying discovery cannot
        // repair invalid arguments, and silent renderers must not hide it.
        if (error instanceof CodexAppToolsRpcError && error.code === -32602) {
          protocolError = error;
          cancelLosers.abort(error);
        }
        failures[index] = `${endpoint}: ${toError(error).message}`;
        transport.close();
        throw error;
      }
    });
    const settled = Promise.allSettled(probes);
    try {
      const selected = await Promise.any(probes);
      cancelLosers.abort(new Error("Codex app tools pipe selected"));
      await settled;
      return selected;
    } catch (error) {
      cancelLosers.abort(toError(error));
      await settled;
      if (signal?.aborted === true) throw abortReason(signal);
      if (protocolError !== undefined) throw protocolError;
      if (parentSignal.aborted) throw abortReason(parentSignal);
      throw new NativePipeTransportError(
        `No Codex app-global tools pipe passed capability discovery (${failures.filter(Boolean).join("; ")})`,
        false,
        error,
        true,
      );
    } finally {
      cancelLosers.abort(new Error("Codex app tools discovery completed"));
    }
  }

  #invalidate(selected: SelectedPipe): void {
    if (this.#selected !== selected) return;
    this.#selected = undefined;
    selected.transport.close();
  }

  #pruneExpiredReplays(): void {
    const now = this.#now();
    for (const [callId, replay] of this.#replays) {
      if (replay.expiresAt <= now) this.#replays.delete(callId);
    }
  }
}

class NativePipeTransport {
  readonly #endpoint: string;
  readonly #connectTimeoutMs: number | undefined;
  readonly #pending = new Map<number, PendingRequest>();
  #socket: Socket | undefined;
  #connecting: Promise<void> | undefined;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #closed = false;

  constructor(endpoint: string, connectTimeoutMs: number | undefined) {
    this.#endpoint = endpoint;
    this.#connectTimeoutMs = connectTimeoutMs;
  }

  async request(
    method: string,
    params: unknown,
    options: {
      readonly signal?: AbortSignal;
      /** Read-only discovery may stop waiting after dispatch without an ambiguous mutation. */
      readonly abortAfterDispatch?: boolean;
    } = {},
  ): Promise<unknown> {
    options.signal?.throwIfAborted();
    try {
      await waitWithSignal(this.#connect(), options.signal);
    } catch (error) {
      if (error instanceof NativePipeTransportError) throw error;
      throw new NativePipeTransportError(toError(error).message, false, error);
    }
    options.signal?.throwIfAborted();
    const socket = this.#socket;
    if (socket === undefined || socket.destroyed) {
      throw new NativePipeTransportError("Codex app tools pipe closed before dispatch", false);
    }
    const id = this.#allocateId();
    const frame = encodeFrame({
      id,
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
    let abortListener: (() => void) | undefined;
    const cleanup = () => {
      if (abortListener !== undefined) options.signal?.removeEventListener("abort", abortListener);
    };
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, cleanup });
    });
    const requestCancel = (reason: Error) => {
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      if (this.#socket === socket && !socket.destroyed) {
        try {
          socket.write(encodeFrame({ id, jsonrpc: "2.0", method: "tools/cancel" }));
        } catch {
          // The original call already has an unknown/cancelled outcome.
        }
      }
      if (options.abortAfterDispatch === true) {
        this.#pending.delete(id);
        pending.cleanup();
        pending.reject(new NativePipeTransportError(reason.message, true, reason));
      }
    };
    if (options.signal !== undefined) {
      abortListener = () => {
        requestCancel(abortReason(options.signal));
      };
      options.signal.addEventListener("abort", abortListener, { once: true });
    }
    try {
      socket.write(frame);
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        this.#pending.delete(id);
        pending.cleanup();
        pending.reject(
          new NativePipeTransportError(
            `Codex app tool request was not dispatched: ${toError(error).message}`,
            false,
            error,
            true,
          ),
        );
      }
    }
    if (options.signal?.aborted === true) abortListener?.();
    const result = await response;
    // Mutating calls keep their correlation entry until the native host emits
    // a terminal response. This preserves authoritative settlement and keeps
    // the scheduler lane occupied even if the caller stopped waiting.
    options.signal?.throwIfAborted();
    return result;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const socket = this.#socket;
    this.#socket = undefined;
    this.#buffer = Buffer.alloc(0);
    socket?.destroy();
    this.#rejectAll(new NativePipeTransportError("Codex app tools pipe client closed", true));
  }

  #connect(): Promise<void> {
    if (this.#closed) {
      return Promise.reject(
        new NativePipeTransportError("Codex app tools pipe client closed", false),
      );
    }
    if (this.#socket !== undefined && !this.#socket.destroyed) return Promise.resolve();
    if (this.#connecting !== undefined) return this.#connecting;
    let connecting!: Promise<void>;
    connecting = new Promise<void>((resolve, reject) => {
      const socket = connect(this.#endpoint);
      const timer =
        this.#connectTimeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              socket.destroy();
              reject(
                new NativePipeTransportError(
                  `Timed out connecting to Codex app tools pipe after ${this.#connectTimeoutMs}ms`,
                  false,
                  undefined,
                  true,
                ),
              );
            }, this.#connectTimeoutMs);
      timer?.unref();
      const onInitialError = (error: Error) => {
        if (timer !== undefined) clearTimeout(timer);
        socket.destroy();
        reject(
          new NativePipeTransportError(
            `Failed to connect to Codex app tools pipe: ${error.message}`,
            false,
            error,
            true,
          ),
        );
      };
      socket.once("error", onInitialError);
      socket.once("connect", () => {
        if (timer !== undefined) clearTimeout(timer);
        socket.off("error", onInitialError);
        if (this.#closed) {
          socket.destroy();
          reject(new NativePipeTransportError("Codex app tools pipe client closed", false));
          return;
        }
        this.#socket = socket;
        this.#buffer = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => this.#onData(socket, chunk));
        socket.on("error", (error: Error) => this.#onDisconnect(socket, error));
        socket.on("close", () =>
          this.#onDisconnect(socket, new Error("Codex app tools pipe closed")),
        );
        resolve();
      });
    }).finally(() => {
      if (this.#connecting === connecting) this.#connecting = undefined;
    });
    this.#connecting = connecting;
    return connecting;
  }

  #onData(socket: Socket, chunk: Buffer): void {
    if (this.#socket !== socket) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const frameLength = this.#buffer.readUInt32LE(0);
      if (frameLength > MAX_NATIVE_FRAME_BYTES) {
        this.#onDisconnect(
          socket,
          new Error(
            `Codex app tools response exceeded the native protocol/runtime frame boundary ` +
              `(${MAX_NATIVE_FRAME_BYTES} bytes)`,
          ),
        );
        socket.destroy();
        return;
      }
      if (this.#buffer.length < frameLength + 4) return;
      const payload = this.#buffer.subarray(4, frameLength + 4);
      this.#buffer = this.#buffer.subarray(frameLength + 4);
      let response: JsonRpcResponse;
      try {
        response = parseResponse(JSON.parse(payload.toString("utf8")));
      } catch (error) {
        this.#onDisconnect(
          socket,
          new Error(`Codex app tools returned a malformed response: ${toError(error).message}`),
        );
        socket.destroy();
        return;
      }
      const pending = this.#pending.get(response.id);
      if (pending === undefined) continue;
      this.#pending.delete(response.id);
      pending.cleanup();
      if (response.error !== undefined) {
        pending.reject(new CodexAppToolsRpcError(response.error));
      } else {
        pending.resolve(response.result);
      }
    }
  }

  #onDisconnect(socket: Socket, error: Error): void {
    if (this.#socket !== socket) return;
    this.#socket = undefined;
    this.#buffer = Buffer.alloc(0);
    this.#rejectAll(
      new NativePipeTransportError(
        `Codex app tool request has an unknown outcome: ${error.message}`,
        true,
        error,
      ),
    );
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #allocateId(): number {
    while (this.#pending.has(this.#nextId)) {
      this.#nextId = this.#nextId >= Number.MAX_SAFE_INTEGER ? 1 : this.#nextId + 1;
    }
    const id = this.#nextId;
    this.#nextId = this.#nextId >= Number.MAX_SAFE_INTEGER ? 1 : this.#nextId + 1;
    return id;
  }
}

export class CodexAppToolsRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly rpcError: JsonRpcErrorObject;

  constructor(rpcError: JsonRpcErrorObject) {
    const serialized = JSON.stringify(rpcError);
    super(
      `Codex app tools RPC error ${rpcError.code}: ${rpcError.message}` +
        (serialized === undefined ? "" : `; details=${serialized}`),
      { cause: rpcError },
    );
    this.name = "CodexAppToolsRpcError";
    this.code = rpcError.code;
    this.data = rpcError.data;
    this.rpcError = rpcError;
  }
}

class NativePipeTransportError extends Error {
  readonly dispatched: boolean;
  readonly retryable: boolean;

  constructor(message: string, dispatched: boolean, cause?: unknown, retryable = false) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NativePipeTransportError";
    this.dispatched = dispatched;
    this.retryable = retryable;
  }
}

export function decodeCodexAppToolResult(response: CodexAppNativeToolCallResponse): unknown {
  const content = response.contentItems.map(nativeContentToMcp);
  const structuredContent = response.success
    ? structuredNativeContent(response.contentItems)
    : undefined;
  return {
    content,
    ...(structuredContent === undefined ? {} : { structuredContent }),
    isError: !response.success,
  };
}

function structuredNativeContent(
  items: readonly CodexAppNativeContentItem[],
): Record<string, unknown> | undefined {
  if (items.length !== 1 || items[0]?.type !== "inputText" || typeof items[0].text !== "string") {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(items[0].text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function nativeContentToMcp(item: CodexAppNativeContentItem): Record<string, unknown> {
  if (item.type === "inputText") return { type: "text", text: item.text ?? "" };
  const dataUrl = item.type === "inputImage" ? item.imageUrl : item.audioUrl;
  const match = /^data:([^;,]+);base64,(.*)$/su.exec(dataUrl ?? "");
  if (match === null) return { type: "text", text: dataUrl ?? "" };
  return {
    type: item.type === "inputImage" ? "image" : "audio",
    mimeType: match[1],
    data: match[2],
  };
}

async function discoverCodexAppToolsPipes(): Promise<readonly string[]> {
  if (process.platform !== "win32") return [];
  const entries = await readdir(WINDOWS_PIPE_DIRECTORY);
  return entries
    .map(codexAppToolsPipeEndpoint)
    .filter((endpoint): endpoint is string => endpoint !== undefined);
}

/** Accepts app-global pipes and older browser-use pipe names. */
export function codexAppToolsPipeEndpoint(entry: string): string | undefined {
  return CODEX_APP_TOOLS_PIPE.test(entry) ? `${WINDOWS_PIPE_DIRECTORY}${entry}` : undefined;
}

function parseTools(value: unknown): readonly CodexAppNativeTool[] {
  if (!isObject(value) || !Array.isArray(value.tools)) {
    throw new Error("Codex app tools/list returned no tools array");
  }
  return value.tools.map((entry, index) => {
    if (!isObject(entry) || typeof entry.name !== "string" || typeof entry.namespace !== "string") {
      throw new Error(`Codex app tools/list returned an invalid tool at index ${index}`);
    }
    return entry as CodexAppNativeTool;
  });
}

function hasRequiredCapability(tools: readonly CodexAppNativeTool[]): boolean {
  return tools.some((tool) => tool.namespace === "codex_app" && tool.name === "list_projects");
}

function nativeToolCallIsReadOnly(
  tools: readonly CodexAppNativeTool[],
  params: CodexAppNativeToolCallParams,
): boolean {
  const descriptor = tools.find(
    (tool) => tool.namespace === params.namespace && tool.name === params.tool,
  );
  const annotations = isObject(descriptor?.annotations) ? descriptor.annotations : undefined;
  if (annotations?.readOnlyHint === true) return true;
  // The installed Codex Desktop catalog currently omits MCP annotations from
  // codex_app.* descriptors. Preserve the native operation semantics instead
  // of treating known queries as ambiguous mutations merely because transport
  // metadata is absent. Mixed-mode and mutating tools remain fail-closed.
  return params.namespace === "codex_app" && CODEX_APP_READ_ONLY_TOOLS.has(params.tool);
}

function parseToolCallResponse(value: unknown): CodexAppNativeToolCallResponse {
  if (
    !isObject(value) ||
    typeof value.success !== "boolean" ||
    !Array.isArray(value.contentItems)
  ) {
    throw new Error("Codex app tools/call returned an invalid result");
  }
  const contentItems = value.contentItems.map((item, index) => {
    if (!isObject(item)) throw new Error(`Invalid Codex app content item at index ${index}`);
    if (item.type === "inputText" && typeof item.text === "string") {
      return { type: "inputText" as const, text: item.text };
    }
    if (item.type === "inputImage" && typeof item.imageUrl === "string") {
      return { type: "inputImage" as const, imageUrl: item.imageUrl };
    }
    if (item.type === "inputAudio" && typeof item.audioUrl === "string") {
      return { type: "inputAudio" as const, audioUrl: item.audioUrl };
    }
    throw new Error(`Invalid Codex app content item at index ${index}`);
  });
  return { success: value.success, contentItems };
}

function parseResponse(value: unknown): JsonRpcResponse {
  if (!isObject(value) || value.jsonrpc !== "2.0") {
    throw new Error("response is not JSON-RPC 2.0");
  }
  const id = numericId(value.id);
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult === hasError) throw new Error("response must contain exactly one result or error");
  if (hasError) {
    if (
      !isObject(value.error) ||
      typeof value.error.code !== "number" ||
      !Number.isFinite(value.error.code) ||
      typeof value.error.message !== "string"
    ) {
      throw new Error("response contains an invalid error");
    }
    return { id, error: value.error as JsonRpcErrorObject };
  }
  return { id, result: value.result };
}

function numericId(value: unknown): number {
  const id = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("response contains an invalid id");
  return id;
}

function encodeFrame(message: unknown): Buffer {
  let payload: Buffer;
  try {
    payload = Buffer.from(JSON.stringify(message), "utf8");
  } catch (error) {
    throw new NativePipeTransportError(
      `Codex app tool request is not JSON serializable: ${toError(error).message}`,
      false,
      error,
    );
  }
  if (payload.length > MAX_NATIVE_FRAME_BYTES) {
    throw new NativePipeTransportError(
      `Codex app tool request exceeded the native protocol/runtime frame boundary ` +
        `(${MAX_NATIVE_FRAME_BYTES} bytes)`,
      false,
    );
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function normalizeToolCall(value: CodexAppNativeToolCallParams): CodexAppNativeToolCallParams {
  return {
    arguments: isObject(value.arguments) ? value.arguments : {},
    // OmniCodex's host context resolver supplies a local Codex thread. The
    // installed native host requires this discriminator even for local calls.
    callerSource: value.callerSource ?? "codex",
    callId: requiredString(value.callId, "callId"),
    namespace: requiredString(value.namespace, "namespace"),
    threadId: requiredString(value.threadId, "threadId"),
    tool: requiredString(value.tool, "tool"),
    turnId: requiredString(value.turnId, "turnId"),
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function createDeadline(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  deadlineUnixMs: number | undefined,
  timeoutError: (() => Error) | undefined = undefined,
): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  parentSignal?.throwIfAborted();
  const expiresAt = earlierDeadline(timeoutMs, deadlineUnixMs);
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(abortReason(parentSignal));
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const armTimer = (): void => {
    if (expiresAt === undefined || controller.signal.aborted) return;
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) {
      controller.abort(timeoutError?.() ?? new Error("Codex app tool deadline exceeded"));
      return;
    }
    timer = setTimeout(armTimer, Math.min(remainingMs, 2_147_483_647));
    timer.unref();
  };
  armTimer();
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

function earlierDeadline(
  timeoutMs: number | undefined,
  deadlineUnixMs: number | undefined,
): number | undefined {
  const now = Date.now();
  let timeoutDeadline: number | undefined;
  if (timeoutMs !== undefined) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be a positive safe integer");
    }
    if (timeoutMs > Number.MAX_SAFE_INTEGER - now) {
      throw new TypeError("timeoutMs exceeds the representable deadline range");
    }
    timeoutDeadline = now + timeoutMs;
  }
  if (
    deadlineUnixMs !== undefined &&
    (!Number.isSafeInteger(deadlineUnixMs) || deadlineUnixMs < 0)
  ) {
    throw new TypeError("deadlineUnixMs must be a non-negative safe integer");
  }
  if (timeoutDeadline === undefined) return deadlineUnixMs;
  if (deadlineUnixMs === undefined) return timeoutDeadline;
  return Math.min(timeoutDeadline, deadlineUnixMs);
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("Codex app tool request cancelled");
}

function isDefinitelyNotDispatched(value: unknown): boolean {
  return (
    value instanceof CodexAppToolsSharedReadinessError ||
    (value instanceof NativePipeTransportError && !value.dispatched)
  );
}

function isRetryableNotDispatched(value: unknown): boolean {
  return value instanceof NativePipeTransportError && !value.dispatched && value.retryable;
}

function isReadOnlyEndpointRediscoveryError(value: unknown): boolean {
  return (
    value instanceof CodexAppToolsSharedReadinessError || value instanceof NativePipeTransportError
  );
}

function delayWithSignal(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolveDelay();
      },
      Math.max(1, milliseconds),
    );
    timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function optionalNonNegativeInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
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

function replayExpiry(now: number, replayWindowMs: number | undefined): number {
  if (replayWindowMs === undefined) return Number.POSITIVE_INFINITY;
  const expiresAt = now + replayWindowMs;
  return Number.isSafeInteger(expiresAt) ? expiresAt : Number.POSITIVE_INFINITY;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
