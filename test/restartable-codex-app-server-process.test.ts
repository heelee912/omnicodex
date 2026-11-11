import { describe, expect, it, vi } from "vitest";
import type { RuntimeCandidate } from "../src/domain/runtime.js";
import type {
  JsonlRpcRequestOptions,
  JsonObject,
} from "../src/infrastructure/runtime/jsonl-rpc-client.js";
import {
  RestartableCodexAppServerProcess,
  type RestartableCodexAppServerProcessOptions,
} from "../src/infrastructure/runtime/restartable-codex-app-server-process.js";

const candidate: RuntimeCandidate = {
  executablePath: "C:\\Program Files\\Codex\\codex.exe",
  canonicalPath: "c:\\program files\\codex\\codex.exe",
  source: "explicit",
  buildSha256: "f".repeat(64),
};

describe("RestartableCodexAppServerProcess", () => {
  it("retries a read after the writable stream is destroyed", async () => {
    const fixture = createFixture((generation, method) => {
      if (generation === 1) {
        throw Object.assign(new Error("Cannot call write after a stream was destroyed"), {
          code: "ERR_STREAM_DESTROYED",
        });
      }
      return { generation, method };
    });
    const process = fixture.process();
    await process.start();
    await expect(process.client.request("thread/read", {})).resolves.toEqual({
      generation: 2,
      method: "thread/read",
    });
    await process.stop();
  });

  it("keeps one client identity, retries reads, and preserves notifications across generations", async () => {
    const fixture = createFixture((generation, method, crash) => {
      if (generation === 1 && method === "thread/read") {
        crash(new Error("Codex App Server exited"));
        throw new Error("JSONL App Server stream ended");
      }
      return { generation, method };
    });
    const replaced: number[] = [];
    const process = fixture.process({
      onGenerationReplaced: (_current, generation) => {
        replaced.push(generation);
      },
    });

    await process.start();
    const client = process.client;
    const notifications: JsonObject[] = [];
    client.subscribeNotifications((message) => notifications.push(message));
    fixture.generations[0]?.client.emit({ method: "first" });

    await expect(client.request("thread/read", { threadId: "thread-1" })).resolves.toEqual({
      generation: 2,
      method: "thread/read",
    });
    expect(process.client).toBe(client);
    fixture.generations[1]?.client.emit({ method: "second" });
    expect(notifications.map((message) => message.method)).toEqual(["first", "second"]);
    expect(replaced).toEqual([2]);
    expect(fixture.generations).toHaveLength(2);

    await process.stop();
  });

  it("reports a disconnected transport to its runtime owner exactly once", async () => {
    const failure = new Error("Desktop app-server connection disconnected");
    const disconnected = vi.fn();
    const fixture = createFixture((generation, method, crash) => {
      if (generation === 1 && method === "thread/read") {
        crash(failure);
        throw new Error("JSONL App Server stream ended");
      }
      return { generation, method };
    });
    const process = fixture.process({ onDisconnected: disconnected });
    await process.start();
    await expect(process.client.request("thread/read", {})).resolves.toEqual({
      generation: 2,
      method: "thread/read",
    });
    expect(disconnected).toHaveBeenCalledExactlyOnceWith(failure);
    await process.stop();
  });

  it("recovers the transport but never replays an outcome-ambiguous mutation", async () => {
    let mutationDispatches = 0;
    const fixture = createFixture((generation, method, crash) => {
      if (method === "thread/start") mutationDispatches += 1;
      if (generation === 1 && method === "thread/start") {
        crash(new Error("Codex App Server exited"));
        throw new Error("JSONL App Server client is closed");
      }
      return { generation, method };
    });
    const replacement = deferred<void>();
    const process = fixture.process({
      onGenerationReplaced: () => replacement.resolve(),
    });

    await process.start();
    await expect(process.client.request("thread/start", {})).rejects.toThrow("client is closed");
    await replacement.promise;
    expect(mutationDispatches).toBe(1);
    expect(fixture.generations).toHaveLength(2);

    await process.stop();
  });

  it("replaces a stalled generation after an RPC deadline without replaying a native tool call", async () => {
    let nativeToolDispatches = 0;
    const fixture = createFixture((generation, method) => {
      if (method === "mcpServer/tool/call") nativeToolDispatches += 1;
      if (generation === 1 && method === "mcpServer/tool/call") {
        throw rpcDeadlineError(method);
      }
      return { generation, method };
    });
    const replacement = deferred<void>();
    const disconnected = vi.fn();
    const process = fixture.process({
      onGenerationReplaced: () => replacement.resolve(),
      onDisconnected: disconnected,
    });

    await process.start();
    await expect(process.client.request("mcpServer/tool/call", {})).rejects.toMatchObject({
      code: "JSONL_RPC_DEADLINE_EXCEEDED",
    });
    await replacement.promise;
    expect(nativeToolDispatches).toBe(1);
    expect(disconnected).not.toHaveBeenCalled();
    await expect(process.client.request("thread/read", {})).resolves.toEqual({
      generation: 2,
      method: "thread/read",
    });
    expect(fixture.generations[0]?.stopped()).toBe(true);

    await process.stop();
  });

  it("retries an idempotent read after replacing a generation that exceeded its RPC deadline", async () => {
    let readDispatches = 0;
    const fixture = createFixture((generation, method) => {
      if (method === "thread/read") readDispatches += 1;
      if (generation === 1 && method === "thread/read") throw rpcDeadlineError(method);
      return { generation, method };
    });
    const process = fixture.process();

    await process.start();
    await expect(process.client.request("thread/read", {})).resolves.toEqual({
      generation: 2,
      method: "thread/read",
    });
    expect(readDispatches).toBe(2);
    expect(fixture.generations[0]?.stopped()).toBe(true);

    await process.stop();
  });

  it("recovers when an installed generation exits after its raw client becomes unavailable", async () => {
    let generation = 0;
    let crashFirstGeneration!: () => void;
    const recovered = deferred<void>();
    const process = new RestartableCodexAppServerProcess(candidate, {
      recoveryDelayMs: 0,
      onGenerationReplaced: () => recovered.resolve(),
      processFactory: (_runtime, options) => {
        generation += 1;
        const ordinal = generation;
        const client = new FakeRpcTransport((method) => ({ ordinal, method }));
        let clientAvailable = true;
        if (ordinal === 1) {
          crashFirstGeneration = () => {
            clientAvailable = false;
            void options.onUnexpectedExit?.(new Error("generation exited before client readback"));
          };
        }
        return {
          get client() {
            if (!clientAvailable) throw new Error("Codex App Server has not been started");
            return client;
          },
          identity: {
            candidate,
            correlationId: `generation-${ordinal}`,
            pid: ordinal,
            ownershipNonce: undefined,
            spawnedAtUnixMs: undefined,
          },
          start: async () => undefined,
          stop: async () => undefined,
        };
      },
    });

    await process.start();
    crashFirstGeneration();
    await recovered.promise;
    await expect(process.client.request("thread/read", {})).resolves.toEqual({
      ordinal: 2,
      method: "thread/read",
    });

    await process.stop();
  });

  it("retains the exact owned generation after stop fails so a later stop retries it", async () => {
    const stop = vi
      .fn()
      .mockRejectedValueOnce(new Error("exact child still alive"))
      .mockResolvedValue(undefined);
    const fixture = createFixture(() => ({}), { stop });
    const process = fixture.process();
    await process.start();
    await expect(process.stop()).rejects.toThrow("exact child still alive");
    expect(fixture.generations[0]?.stopped()).toBe(false);

    await process.stop();
    expect(stop).toHaveBeenNthCalledWith(1, 1);
    expect(stop).toHaveBeenNthCalledWith(2, 1);
    expect(fixture.generations[0]?.stopped()).toBe(true);
    expect(fixture.generations).toHaveLength(1);
  });

  it("retries failed startup cleanup before a later explicit start creates another child", async () => {
    const stop = vi
      .fn()
      .mockRejectedValueOnce(new Error("startup child still alive"))
      .mockResolvedValue(undefined);
    const fixture = createFixture(() => ({}), {
      start: async (generation) => {
        if (generation === 1) throw new Error("initial handshake failed");
      },
      stop,
    });
    const process = fixture.process();
    await expect(process.start()).rejects.toThrow("generation startup and cleanup failed");
    expect(fixture.generations[0]?.stopped()).toBe(false);

    await process.start();
    expect(stop).toHaveBeenNthCalledWith(2, 1);
    expect(fixture.generations[0]?.stopped()).toBe(true);
    expect(fixture.generations).toHaveLength(2);
    await process.stop();
  });

  it("backs off and holds replacement creation until a failed generation really stops", async () => {
    vi.useFakeTimers();
    const stop = vi
      .fn()
      .mockRejectedValueOnce(new Error("exact child still alive"))
      .mockResolvedValue(undefined);
    const fixture = createFixture(
      (generation, method) => {
        if (generation === 1) throw rpcDeadlineError(method);
        return { generation };
      },
      { stop },
    );
    const process = fixture.process({ recoveryDelayMs: 100 });
    try {
      await process.start();
      await expect(process.client.request("mcpServer/tool/call", {})).rejects.toMatchObject({
        code: "JSONL_RPC_DEADLINE_EXCEEDED",
      });
      await vi.advanceTimersByTimeAsync(99);
      expect(fixture.generations).toHaveLength(1);
      expect(stop).toHaveBeenCalledTimes(1);
      const restarted = process.start();
      await vi.advanceTimersByTimeAsync(1);
      await restarted;
      expect(stop).toHaveBeenNthCalledWith(2, 1);
      expect(fixture.generations[0]?.stopped()).toBe(true);
      expect(fixture.generations).toHaveLength(2);
      await expect(process.client.request("thread/list", {})).resolves.toEqual({ generation: 2 });
    } finally {
      await process.stop();
      vi.useRealTimers();
    }
  });

  it("retires a failed replacement before trying another generation", async () => {
    vi.useFakeTimers();
    let secondStops = 0;
    const fixture = createFixture(
      (generation, method) => {
        if (generation === 1) throw rpcDeadlineError(method);
        return { generation };
      },
      {
        start: async (generation) => {
          if (generation === 2) throw new Error("replacement startup failed");
        },
        stop: async (generation) => {
          if (generation === 2 && ++secondStops === 1)
            throw new Error("replacement child still alive");
        },
      },
    );
    const process = fixture.process({ recoveryDelayMs: 100 });
    try {
      await process.start();
      await expect(process.client.request("mcpServer/tool/call", {})).rejects.toMatchObject({
        code: "JSONL_RPC_DEADLINE_EXCEEDED",
      });
      await vi.advanceTimersByTimeAsync(99);
      expect(fixture.generations).toHaveLength(2);
      expect(fixture.generations[1]?.stopped()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(fixture.generations).toHaveLength(3);
      expect(fixture.generations[1]?.stopped()).toBe(true);
      expect(secondStops).toBe(2);
      await expect(process.client.request("thread/list", {})).resolves.toEqual({ generation: 3 });
    } finally {
      await process.stop();
      vi.useRealTimers();
    }
  });
});

function createFixture(
  execute: (
    generation: number,
    method: string,
    crash: (error: Error) => void,
  ) => unknown | Promise<unknown>,
  lifecycle: {
    start?: (generation: number) => Promise<void>;
    stop?: (generation: number) => Promise<void>;
  } = {},
) {
  const generations: Array<{
    readonly client: FakeRpcTransport;
    readonly stopped: () => boolean;
  }> = [];
  return {
    generations,
    process(overrides: Partial<RestartableCodexAppServerProcessOptions> = {}) {
      return new RestartableCodexAppServerProcess(candidate, {
        recoveryDelayMs: 0,
        ...overrides,
        processFactory: (_runtime, options) => {
          const generation = generations.length + 1;
          let stopped = false;
          const crash = (error: Error) => {
            void options.onUnexpectedExit?.(error);
          };
          const client = new FakeRpcTransport((method) => execute(generation, method, crash));
          const record = { client, stopped: () => stopped };
          generations.push(record);
          return {
            client,
            identity: {
              candidate,
              correlationId: `generation-${generation}`,
              pid: generation,
              ownershipNonce: undefined,
              spawnedAtUnixMs: undefined,
            },
            start: async () => lifecycle.start?.(generation),
            stop: async () => {
              await lifecycle.stop?.(generation);
              stopped = true;
            },
          };
        },
      });
    },
  };
}

class FakeRpcTransport {
  readonly #execute: (method: string) => unknown | Promise<unknown>;
  readonly #listeners = new Set<(message: JsonObject) => void>();

  constructor(execute: (method: string) => unknown | Promise<unknown>) {
    this.#execute = execute;
  }

  async request<T>(
    method: string,
    _params: unknown,
    _timeoutOrOptions?: number | JsonlRpcRequestOptions,
  ): Promise<T> {
    return (await this.#execute(method)) as T;
  }

  subscribeNotifications(listener: (message: JsonObject) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(message: JsonObject): void {
    for (const listener of this.#listeners) listener(message);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function rpcDeadlineError(method: string): Error {
  const error = new Error(`App Server request timed out: ${method}`);
  error.name = "JsonlRpcRequestTimeoutError";
  Object.assign(error, { code: "JSONL_RPC_DEADLINE_EXCEEDED", method });
  return error;
}
