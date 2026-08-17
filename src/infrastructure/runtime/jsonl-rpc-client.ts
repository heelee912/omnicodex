import { StringDecoder } from "node:string_decoder";

export type JsonObject = Record<string, unknown>;

export interface JsonlReadable {
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "close" | "end", listener: () => void): this;
}

export interface JsonlWritable {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  end(callback?: () => void): void;
}

export interface JsonlRpcClientOptions {
  readonly readable: JsonlReadable;
  readonly writable: JsonlWritable;
  readonly defaultTimeoutMs?: number;
  readonly onNotification?: (message: JsonObject) => void;
  readonly onServerRequest?: (message: JsonObject) => Promise<unknown> | unknown;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** JSON-lines JSON-RPC-compatible transport used by `codex app-server --stdio`. */
export class JsonlRpcClient {
  readonly #writable: JsonlWritable;
  readonly #defaultTimeoutMs: number;
  readonly #onNotification: ((message: JsonObject) => void) | undefined;
  readonly #onServerRequest: ((message: JsonObject) => Promise<unknown> | unknown) | undefined;
  readonly #pending = new Map<string | number, PendingRequest>();
  readonly #decoder = new StringDecoder("utf8");
  #buffer = "";
  #nextId = 1;
  #closed = false;
  readonly #dataListener: (chunk: Buffer | string) => void;
  readonly #errorListener: (error: Error) => void;
  readonly #endListener: () => void;

  constructor(options: JsonlRpcClientOptions) {
    this.#writable = options.writable;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.#onNotification = options.onNotification;
    this.#onServerRequest = options.onServerRequest;
    this.#dataListener = (chunk) => this.#acceptChunk(chunk);
    this.#errorListener = (error) => this.close(error);
    this.#endListener = () => this.close(new Error("JSONL App Server stream ended"));
    options.readable.on("data", this.#dataListener);
    options.readable.on("error", this.#errorListener);
    options.readable.once("end", this.#endListener);
    options.readable.once("close", this.#endListener);
  }

  request<T>(method: string, params: unknown, timeoutMs = this.#defaultTimeoutMs): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new Error("JSONL App Server client is closed"));
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`App Server request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.#write(message).catch((error: unknown) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(toError(error));
      });
    });
  }

  notify(method: string, params: unknown): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error("JSONL App Server client is closed"));
    }
    return this.#write({ jsonrpc: "2.0", method, params });
  }

  close(reason = new Error("JSONL App Server client closed")): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
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
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length > 0) {
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
    if ((typeof id === "string" || typeof id === "number") && this.#pending.has(id)) {
      const pending = this.#pending.get(id);
      this.#pending.delete(id);
      if (pending === undefined) {
        return;
      }
      clearTimeout(pending.timer);
      if ("error" in message) {
        pending.reject(rpcError(message.error));
      } else {
        pending.resolve(message.result);
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
  }

  async #respondToServerRequest(message: JsonObject, id: string | number): Promise<void> {
    try {
      const result = await this.#onServerRequest?.(message);
      await this.#write({ jsonrpc: "2.0", id, result });
    } catch (error) {
      await this.#write({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: toError(error).message },
      });
    }
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcError(value: unknown): Error {
  if (isJsonObject(value) && typeof value.message === "string") {
    const code = typeof value.code === "number" ? ` (${value.code})` : "";
    return new Error(`App Server RPC error${code}: ${value.message}`);
  }
  return new Error("App Server RPC error");
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
