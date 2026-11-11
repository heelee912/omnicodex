import { StringDecoder } from "node:string_decoder";
import { errorMessage, structuredErrorDetails } from "./structured-error-details.js";

export type JsonObject = Record<string, unknown>;

export interface JsonlReadable {
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "close" | "end", listener: () => void): this;
}

export interface JsonlWritable {
  on?(event: "error", listener: (error: Error) => void): this;
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  end(callback?: () => void): void;
}

export interface JsonlRpcClientOptions {
  readonly readable: JsonlReadable;
  readonly writable: JsonlWritable;
  readonly onNotification?: (message: JsonObject) => void;
  readonly onServerRequest?: (message: JsonObject) => Promise<unknown> | unknown;
}

export interface JsonlRpcRequestOptions {
  /** Exact caller-supplied completion timeout. Omit to wait for the response or stream closure. */
  readonly timeoutMs?: number;
  /** Absolute caller completion deadline. When both are present, the earlier boundary wins. */
  readonly deadlineUnixMs?: number;
  /** Explicit semantic cancellation of this caller's wait. */
  readonly signal?: AbortSignal;
  /**
   * Preserve a dispatched request until the App Server returns or the stream
   * closes. This keeps mutation ordering authoritative after caller timeout or
   * cancellation while still preventing dispatch past an expired boundary.
   */
  readonly awaitResponseAfterCancellation?: boolean;
}

interface PendingRequest {
  complete(value: unknown): void;
  fail(error: Error): void;
}

/** Lossless JSON-RPC error received from the App Server. */
export class JsonlRpcError extends Error {
  readonly code: unknown;
  readonly data: unknown;
  readonly rpcError: unknown;

  constructor(value: unknown) {
    super(rpcErrorMessage(value), { cause: value });
    this.name = "JsonlRpcError";
    this.code = isJsonObject(value) ? value.code : undefined;
    this.data = isJsonObject(value) ? value.data : undefined;
    this.rpcError = value;
  }
}

/** JSON-lines JSON-RPC-compatible transport used by `codex app-server --stdio`. */
export class JsonlRpcClient {
  readonly #writable: JsonlWritable;
  readonly #onNotification: ((message: JsonObject) => void) | undefined;
  readonly #onServerRequest: ((message: JsonObject) => Promise<unknown> | unknown) | undefined;
  readonly #pending = new Map<string | number, PendingRequest>();
  readonly #notificationListeners = new Set<(message: JsonObject) => void>();
  readonly #decoder = new StringDecoder("utf8");
  #buffer = "";
  #nextId = 1;
  #closed = false;
  readonly #dataListener: (chunk: Buffer | string) => void;
  readonly #errorListener: (error: Error) => void;
  readonly #writableErrorListener: (error: Error) => void;
  readonly #endListener: () => void;

  constructor(options: JsonlRpcClientOptions) {
    this.#writable = options.writable;
    this.#onNotification = options.onNotification;
    this.#onServerRequest = options.onServerRequest;
    this.#dataListener = (chunk) => this.#acceptChunk(chunk);
    this.#errorListener = (error) => this.close(error);
    this.#writableErrorListener = (error) => this.close(error);
    this.#endListener = () => this.close(new Error("JSONL App Server stream ended"));
    options.readable.on("data", this.#dataListener);
    options.readable.on("error", this.#errorListener);
    options.writable.on?.("error", this.#writableErrorListener);
    options.readable.once("end", this.#endListener);
    options.readable.once("close", this.#endListener);
  }

  request<T>(
    method: string,
    params: unknown,
    timeoutOrOptions?: number | JsonlRpcRequestOptions,
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new Error("JSONL App Server client is closed"));
    }
    const options = requestOptions(timeoutOrOptions);
    if (options.signal?.aborted === true) {
      return Promise.reject(abortError(options.signal));
    }
    const deadlineUnixMs = earlierDeadline(options.timeoutMs, options.deadlineUnixMs);
    if (deadlineUnixMs !== undefined && deadlineUnixMs <= Date.now()) {
      return Promise.reject(requestTimeoutError(method, deadlineUnixMs));
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      let callerSettled = false;
      let dispatchStarted = false;
      let deferredBoundaryError: Error | undefined;
      let cancelDeadline: (() => void) | undefined;
      const settleBoundary = (error: Error) => {
        if (dispatchStarted && options.awaitResponseAfterCancellation === true) {
          deferredBoundaryError ??= error;
          return;
        }
        settleCaller(() => reject(error));
      };
      const onAbort = () => settleBoundary(abortError(options.signal));
      const cleanupCallerBoundary = () => {
        cancelDeadline?.();
        options.signal?.removeEventListener("abort", onAbort);
      };
      const settleCaller = (settle: () => void) => {
        if (callerSettled) return;
        callerSettled = true;
        cleanupCallerBoundary();
        settle();
      };
      const pending: PendingRequest = {
        complete: (value) =>
          settleCaller(() => {
            if (deferredBoundaryError === undefined) {
              resolve(value as T);
              return;
            }
            // A mutation can acknowledge only after the caller boundary has
            // elapsed. Preserve that authoritative late response on the exact
            // boundary error so higher layers can perform protocol cleanup
            // (for example interrupting a newly-created turn) without
            // pretending the original caller succeeded.
            Reflect.set(deferredBoundaryError, "rpcResponse", value);
            reject(deferredBoundaryError);
          }),
        fail: (error) => settleCaller(() => reject(error)),
      };
      this.#pending.set(id, pending);
      if (options.signal !== undefined) {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      if (deadlineUnixMs !== undefined) {
        cancelDeadline = scheduleDeadline(deadlineUnixMs, () => {
          // Keep the correlation entry until a late response or stream closure.
          // A timeout after write is an ambiguous transport outcome, not proof
          // that the App Server request did not execute.
          settleBoundary(requestTimeoutError(method, deadlineUnixMs));
        });
      }
      if (callerSettled) {
        cancelDeadline?.();
        this.#pending.delete(id);
        return;
      }
      dispatchStarted = true;
      this.#write(message).catch((error: unknown) => {
        this.#pending.delete(id);
        pending.fail(toError(error));
      });
    });
  }

  notify(method: string, params: unknown): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error("JSONL App Server client is closed"));
    }
    return this.#write({ jsonrpc: "2.0", method, params });
  }

  subscribeNotifications(listener: (message: JsonObject) => void): () => void {
    if (this.#closed) {
      throw new Error("JSONL App Server client is closed");
    }
    this.#notificationListeners.add(listener);
    return () => {
      this.#notificationListeners.delete(listener);
    };
  }

  close(reason = new Error("JSONL App Server client closed")): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      pending.fail(reason);
      this.#pending.delete(id);
    }
  }

  async #write(message: JsonObject): Promise<void> {
    await new Promise<void>((resolveWrite, rejectWrite) => {
      this.#writable.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error !== undefined && error !== null) {
          rejectWrite(error);
          return;
        }
        resolveWrite();
      });
    });
  }

  #acceptChunk(chunk: Buffer | string): void {
    this.#buffer += this.#decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim().length > 0) {
        this.#acceptLine(line);
      }
      newline = this.#buffer.indexOf("\n");
    }
  }

  #acceptLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#onNotification?.({
        method: "omnicodex/runtime/malformed_message",
        params: { line },
      });
      return;
    }
    if (!isJsonObject(message)) {
      return;
    }
    const id = message.id;
    // JSON-RPC request ids are scoped to each direction. A server request may
    // reuse the id of our pending request; only response envelopes settle it.
    if (
      typeof message.method !== "string" &&
      (typeof id === "string" || typeof id === "number") &&
      this.#pending.has(id)
    ) {
      const pending = this.#pending.get(id);
      this.#pending.delete(id);
      if (pending === undefined) {
        return;
      }
      if ("error" in message) {
        pending.fail(rpcError(message.error));
      } else {
        pending.complete(message.result);
      }
      return;
    }

    if (
      typeof message.method === "string" &&
      (typeof id === "string" || typeof id === "number") &&
      this.#onServerRequest !== undefined
    ) {
      void this.#respondToServerRequest(message, id);
      return;
    }
    this.#onNotification?.(message);
    for (const listener of this.#notificationListeners) {
      listener(message);
    }
  }

  async #respondToServerRequest(message: JsonObject, id: string | number): Promise<void> {
    let response: JsonObject;
    try {
      const result = await this.#onServerRequest?.(message);
      response = { jsonrpc: "2.0", id, result };
    } catch (error) {
      response = {
        jsonrpc: "2.0",
        id,
        error: {
          code: jsonRpcErrorCode(error),
          message: errorMessage(error),
          data: structuredErrorDetails(error),
        },
      };
    }
    try {
      await this.#write(response);
    } catch (error) {
      // A server request can race the exact App Server child closing stdin.
      // The writable error listener closes and rejects correlated requests;
      // never attempt a second write to the broken pipe or leak a rejection
      // from this intentionally detached responder into the public daemon.
      this.close(toError(error));
    }
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcError(value: unknown): JsonlRpcError {
  return new JsonlRpcError(value);
}

function jsonRpcErrorCode(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return -32_000;
  const code = Reflect.get(value, "code");
  return typeof code === "number" && Number.isSafeInteger(code) ? code : -32_000;
}

function rpcErrorMessage(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (isJsonObject(value) && typeof value.message === "string") {
    const code = value.code === undefined ? "" : ` (${String(value.code)})`;
    const summary = `App Server RPC error${code}: ${value.message}`;
    return serialized === undefined ? summary : `${summary}; details=${serialized}`;
  }
  return serialized === undefined
    ? `App Server RPC error: ${String(value)}`
    : `App Server RPC error: ${serialized}`;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function requestOptions(
  value: number | JsonlRpcRequestOptions | undefined,
): JsonlRpcRequestOptions {
  if (value === undefined) return {};
  if (typeof value === "number") {
    return { timeoutMs: positiveTimeout(value) };
  }
  return {
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: positiveTimeout(value.timeoutMs) }),
    ...(value.deadlineUnixMs === undefined
      ? {}
      : { deadlineUnixMs: positiveDeadline(value.deadlineUnixMs) }),
    ...(value.signal === undefined ? {} : { signal: value.signal }),
    ...(value.awaitResponseAfterCancellation === true
      ? { awaitResponseAfterCancellation: true }
      : {}),
  };
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("JSONL RPC timeoutMs must be a positive safe integer");
  }
  return value;
}

function positiveDeadline(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("JSONL RPC deadlineUnixMs must be a positive safe integer");
  }
  return value;
}

function earlierDeadline(
  timeoutMs: number | undefined,
  deadlineUnixMs: number | undefined,
): number | undefined {
  if (timeoutMs === undefined) return deadlineUnixMs;
  const nowUnixMs = Date.now();
  if (timeoutMs > Number.MAX_SAFE_INTEGER - nowUnixMs) {
    throw new TypeError("JSONL RPC timeoutMs exceeds the representable deadline range");
  }
  const timeoutDeadline = nowUnixMs + timeoutMs;
  return deadlineUnixMs === undefined ? timeoutDeadline : Math.min(timeoutDeadline, deadlineUnixMs);
}

function scheduleDeadline(deadlineUnixMs: number, expire: () => void): () => void {
  const maximumTimerDelayMs = 2_147_483_647;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const arm = () => {
    if (cancelled) return;
    const remainingMs = deadlineUnixMs - Date.now();
    if (remainingMs <= 0) {
      expire();
      return;
    }
    timer = setTimeout(arm, Math.min(remainingMs, maximumTimerDelayMs));
    timer.unref?.();
  };
  arm();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

function requestTimeoutError(method: string, deadlineUnixMs: number): Error {
  const error = new Error(`App Server request timed out: ${method}`);
  error.name = "JsonlRpcRequestTimeoutError";
  Object.assign(error, {
    code: "JSONL_RPC_DEADLINE_EXCEEDED",
    deadlineUnixMs,
    method,
  });
  return error;
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  const message =
    reason instanceof Error
      ? reason.message
      : reason === undefined
        ? "App Server request cancelled"
        : String(reason);
  const error = new Error(message, { cause: reason });
  error.name = "AbortError";
  return error;
}
