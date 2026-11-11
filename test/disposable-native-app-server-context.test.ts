import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createDisposableNativeAppServerContext,
  type DisposableNativeAppServerContextOptions,
} from "../src/application/disposable-native-app-server-context.js";
import type {
  AppServerRpcClient,
  AppServerRpcRequestOptions,
} from "../src/application/native-tool-catalog.js";
import type { RuntimeCandidate } from "../src/domain/runtime.js";
import { CodexAppServerConnection } from "../src/infrastructure/runtime/codex-app-server-connection.js";
import type { CodexAppServerProcessOptions } from "../src/infrastructure/runtime/codex-app-server-process.js";

const candidate: RuntimeCandidate = {
  executablePath: "C:\\Program Files\\Codex\\codex.exe",
  canonicalPath: "c:\\program files\\codex\\codex.exe",
  source: "explicit",
  buildSha256: "a".repeat(64),
};

describe("createDisposableNativeAppServerContext", () => {
  it("starts one exact process on creation and forwards process and executor options", async () => {
    const requests: RpcRequest[] = [];
    const client = createClient(requests);
    const onNotification = () => undefined;
    const processOptions: CodexAppServerProcessOptions = {
      cwd: "C:\\worktree",
      configOverrides: ['model="gpt-test"'],
      onNotification,
    };
    let receivedCandidate: RuntimeCandidate | undefined;
    let receivedOptions: CodexAppServerProcessOptions | undefined;
    let factoryCalls = 0;
    let startCalls = 0;
    let stopCalls = 0;

    const creation = createDisposableNativeAppServerContext(
      {
        candidate,
        processOptions,
        executorOptions: {
          threadId: "caller-thread",
          model: "gpt-test",
          reasoningEffort: "high",
          threadSource: "web",
          workspaceKind: "project",
        },
        processFactory: (runtimeCandidate, options) => {
          factoryCalls += 1;
          receivedCandidate = runtimeCandidate;
          receivedOptions = options;
          return {
            client,
            start: async () => {
              startCalls += 1;
            },
            stop: async () => {
              stopCalls += 1;
            },
          };
        },
      },
      new AbortController().signal,
    );

    expect(factoryCalls).toBe(1);
    expect(startCalls).toBe(1);
    const runtime = await creation;
    expect(receivedCandidate).toBe(candidate);
    expect(receivedOptions).toBe(processOptions);

    await runtime.nativeToolExecutor.call("browser", "read", { value: 1 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "mcpServer/tool/call",
      params: {
        server: "browser",
        threadId: "caller-thread",
        tool: "read",
        arguments: { value: 1 },
        _meta: {
          "x-codex-turn-metadata": {
            model: "gpt-test",
            reasoning_effort: "high",
            thread_id: "caller-thread",
            thread_source: "web",
            workspace_kind: "project",
          },
        },
      },
    });

    await runtime.close();
    expect(stopCalls).toBe(1);
  });

  it("coalesces concurrent closes and remains closed after a successful stop", async () => {
    const stopGate = deferred<void>();
    let stopCalls = 0;
    const runtime = await createContext({
      stop: () => {
        stopCalls += 1;
        return stopGate.promise;
      },
    });

    const first = runtime.close();
    const second = runtime.close();
    const third = runtime.close();
    await vi.waitFor(() => expect(stopCalls).toBe(1));
    stopGate.resolve();
    await Promise.all([first, second, third]);

    await runtime.close();
    expect(stopCalls).toBe(1);
  });

  it("releases its owned thread before closing the shared server connection", async () => {
    const requests: RpcRequest[] = [];
    const runtime = await createContext({ client: createClient(requests) });

    await runtime.nativeToolExecutor.call("browser", "read", {});
    await runtime.nativeToolExecutor.call("browser", "read", {});
    expect(startedThreadIds(requests)).toEqual(["ephemeral-1"]);
    expect(calledThreadIds(requests)).toEqual(["ephemeral-1", "ephemeral-1"]);

    await runtime.close();
    await runtime.nativeToolExecutor.call("browser", "read", {});
    expect(startedThreadIds(requests)).toEqual(["ephemeral-1", "ephemeral-2"]);
    expect(calledThreadIds(requests)).toEqual(["ephemeral-1", "ephemeral-1", "ephemeral-2"]);
    expect(requests.some((request) => request.method === "thread/delete")).toBe(true);
    expect(requests.some((request) => request.method === "thread/unsubscribe")).toBe(false);
  });

  it("unsubscribes a non-deletable ephemeral thread before closing its connection", async () => {
    const events: string[] = [];
    const client: AppServerRpcClient = {
      request: async <T>(method: string): Promise<T> => {
        events.push(method);
        if (method === "thread/start") return { thread: { id: "ephemeral-owned" } } as T;
        if (method === "thread/delete") {
          throw new Error("thread is not persisted and cannot be deleted: ephemeral-owned");
        }
        if (method === "thread/unsubscribe") return { status: "unsubscribed" } as T;
        return { content: [] } as T;
      },
    };
    const runtime = await createContext({
      client,
      stop: async () => {
        events.push("connection/stop");
      },
    });
    await runtime.nativeToolExecutor.call("server", "tool", {});
    await runtime.close();
    expect(events).toEqual([
      "thread/start",
      "mcpServer/tool/call",
      "thread/delete",
      "thread/unsubscribe",
      "connection/stop",
    ]);
  });

  it("releases a disconnected context only after its Desktop app-server has exited", async () => {
    let appServerExited = false;
    let stops = 0;
    const failure = new Error("JSONL App Server stream ended");
    const client: AppServerRpcClient = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "thread/start") return { thread: { id: "ephemeral-owned" } } as T;
        if (method === "thread/delete") throw failure;
        return { content: [] } as T;
      },
    };
    const runtime = await createContext({
      client,
      hasAppServerExited: () => appServerExited,
      stop: async () => {
        stops += 1;
      },
    });

    await runtime.nativeToolExecutor.call("server", "tool", {});
    await expect(runtime.close()).rejects.toBe(failure);
    expect(stops).toBe(0);

    appServerExited = true;
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(stops).toBe(1);
  });

  it("keeps a non-transport cleanup failure visible even after the app-server exits", async () => {
    const failure = new Error("unexpected thread retirement failure");
    let stops = 0;
    const client: AppServerRpcClient = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "thread/start") return { thread: { id: "ephemeral-owned" } } as T;
        if (method === "thread/delete") throw failure;
        return { content: [] } as T;
      },
    };
    const runtime = await createContext({
      client,
      hasAppServerExited: () => true,
      stop: async () => {
        stops += 1;
      },
    });

    await runtime.nativeToolExecutor.call("server", "tool", {});
    await expect(runtime.close()).rejects.toBe(failure);
    expect(stops).toBe(0);
  });

  it.skipIf(process.platform !== "win32")(
    "retires an owned context after the real server process exits",
    async () => {
      const pipeName = `\\\\.\\pipe\\omnicodex-dead-context-${randomUUID()}`;
      const program = [
        'const net = require("node:net");',
        "const server = net.createServer((socket) => {",
        '  let buffer = "";',
        '  socket.on("data", (chunk) => {',
        "    buffer += chunk.toString();",
        "    let end;",
        "    while ((end = buffer.indexOf(String.fromCharCode(10))) >= 0) {",
        "      const request = JSON.parse(buffer.slice(0, end));",
        "      buffer = buffer.slice(end + 1);",
        '      const result = request.method === "initialize" ? { codexHome: "C:/Codex" }',
        '        : request.method === "thread/start" ? { thread: { id: "owned" } }',
        '        : { content: [{ type: "text", text: "ok" }] };',
        '      socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + String.fromCharCode(10));',
        "    }",
        "  });",
        "});",
        'server.listen(process.argv[1], () => process.send("ready"));',
        'process.on("message", (message) => { if (message === "exit") process.exit(0); });',
      ].join("\n");
      const child = spawn(process.execPath, ["-e", program, pipeName], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let connection: CodexAppServerConnection | undefined;
      try {
        expect((await once(child, "message"))[0]).toBe("ready");
        expect(child.pid).toBeDefined();
        const runtime = await createDisposableNativeAppServerContext(
          {
            candidate,
            processFactory: (selected, options) => {
              connection = new CodexAppServerConnection(selected, options, {
                locate: async () => ({
                  transport: "named_pipe",
                  pid: child.pid as number,
                  pipeName,
                  executablePath: selected.executablePath,
                  appServerVersion: "test",
                  instanceNonce: randomUUID(),
                }),
              });
              return connection;
            },
          },
          new AbortController().signal,
        );
        await runtime.nativeToolExecutor.call("server", "tool", {});
        const exited = once(child, "exit");
        child.send("exit");
        await exited;
        await vi.waitFor(() => expect(connection?.hasAppServerExited()).toBe(true));
        await expect(runtime.close()).resolves.toBeUndefined();
      } finally {
        await connection?.stop();
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
    },
    15_000,
  );

  it("retries a failed process stop on the next close", async () => {
    const requests: RpcRequest[] = [];
    let stopCalls = 0;
    const runtime = await createContext({
      client: createClient(requests),
      stop: async () => {
        stopCalls += 1;
        if (stopCalls === 1) throw new Error("stop failed");
      },
    });

    await runtime.nativeToolExecutor.call("browser", "read", {});
    await expect(runtime.close()).rejects.toThrow("stop failed");
    await runtime.nativeToolExecutor.call("browser", "read", {});
    expect(startedThreadIds(requests)).toEqual(["ephemeral-1", "ephemeral-2"]);

    await runtime.close();
    expect(stopCalls).toBe(2);
    await runtime.nativeToolExecutor.call("browser", "read", {});
    expect(startedThreadIds(requests)).toEqual(["ephemeral-1", "ephemeral-2", "ephemeral-3"]);

    await runtime.close();
    expect(stopCalls).toBe(2);
  });

  it("does not create a process when context creation is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancel before creation"));
    let factoryCalls = 0;

    await expect(
      createDisposableNativeAppServerContext(
        {
          candidate,
          processFactory: () => {
            factoryCalls += 1;
            return createFakeProcess();
          },
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError", message: "cancel before creation" });
    expect(factoryCalls).toBe(0);
  });

  it("stops the process once when startup fails", async () => {
    const startupError = new Error("startup failed");
    let startCalls = 0;
    let stopCalls = 0;

    await expect(
      createDisposableNativeAppServerContext(
        {
          candidate,
          processFactory: () =>
            createFakeProcess({
              start: async () => {
                startCalls += 1;
                throw startupError;
              },
              stop: async () => {
                stopCalls += 1;
              },
            }),
        },
        new AbortController().signal,
      ),
    ).rejects.toBe(startupError);
    expect(startCalls).toBe(1);
    expect(stopCalls).toBe(1);
  });

  it("reports both startup and cleanup failures", async () => {
    const startupError = new Error("startup failed");
    const cleanupError = new Error("cleanup failed");

    const failure = await createDisposableNativeAppServerContext(
      {
        candidate,
        processFactory: () =>
          createFakeProcess({
            start: async () => {
              throw startupError;
            },
            stop: async () => {
              throw cleanupError;
            },
          }),
      },
      new AbortController().signal,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      message: "Disposable native App Server startup and cleanup failed",
      errors: [startupError, cleanupError],
    });
  });

  it("stops an in-flight startup once when creation is aborted", async () => {
    const startGate = deferred<void>();
    const controller = new AbortController();
    let stopCalls = 0;
    const creation = createDisposableNativeAppServerContext(
      {
        candidate,
        processFactory: () =>
          createFakeProcess({
            start: () => startGate.promise,
            stop: async () => {
              stopCalls += 1;
            },
          }),
      },
      controller.signal,
    );

    controller.abort("cancel in-flight creation");
    expect(stopCalls).toBe(1);
    startGate.resolve();
    await expect(creation).rejects.toMatchObject({
      name: "AbortError",
      message: "cancel in-flight creation",
    });
    expect(stopCalls).toBe(1);
  });
});

interface RpcRequest {
  readonly method: string;
  readonly params: unknown;
  readonly timeoutOrOptions?: number | AppServerRpcRequestOptions;
}

function createClient(requests: RpcRequest[] = []): AppServerRpcClient {
  let nextThread = 0;
  return {
    request: async <T>(
      method: string,
      params: unknown,
      timeoutOrOptions?: number | AppServerRpcRequestOptions,
    ): Promise<T> => {
      requests.push({
        method,
        params,
        ...(timeoutOrOptions === undefined ? {} : { timeoutOrOptions }),
      });
      if (method === "thread/start") {
        nextThread += 1;
        return { thread: { id: `ephemeral-${nextThread}` } } as T;
      }
      return { content: [{ type: "text", text: "ok" }] } as T;
    },
  };
}

function createFakeProcess(
  overrides: Partial<{
    readonly client: AppServerRpcClient;
    readonly start: () => Promise<void>;
    readonly stop: () => Promise<void>;
    readonly hasAppServerExited: () => boolean;
  }> = {},
) {
  return {
    client: overrides.client ?? createClient(),
    start: overrides.start ?? (async () => undefined),
    stop: overrides.stop ?? (async () => undefined),
    ...(overrides.hasAppServerExited === undefined
      ? {}
      : { hasAppServerExited: overrides.hasAppServerExited }),
  };
}

async function createContext(processOverrides: Parameters<typeof createFakeProcess>[0] = {}) {
  const options: DisposableNativeAppServerContextOptions = {
    candidate,
    processFactory: () => createFakeProcess(processOverrides),
  };
  return createDisposableNativeAppServerContext(options, new AbortController().signal);
}

function startedThreadIds(requests: readonly RpcRequest[]): string[] {
  return requests
    .filter((request) => request.method === "thread/start")
    .map((_request, index) => `ephemeral-${index + 1}`);
}

function calledThreadIds(requests: readonly RpcRequest[]): unknown[] {
  return requests
    .filter((request) => request.method === "mcpServer/tool/call")
    .map((request) => (isRecord(request.params) ? request.params.threadId : undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
