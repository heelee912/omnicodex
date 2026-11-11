import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeCandidate } from "../src/domain/runtime.js";
import {
  CodexAppServerProcess,
  terminateOwnedAppServerChildAndWait,
} from "../src/infrastructure/runtime/codex-app-server-process.js";
import { JsonlRpcError } from "../src/infrastructure/runtime/jsonl-rpc-client.js";
import {
  HiddenChildProcessBoundary,
  type OwnedHiddenChildProcess,
  type RecoveredWindowsProcessIdentity,
} from "../src/infrastructure/windows/hidden-child-process.js";

const hiddenProcessMocks = vi.hoisted(() => ({ spawnHidden: vi.fn() }));

vi.mock("../src/infrastructure/windows/hidden-child-process.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/infrastructure/windows/hidden-child-process.js")>();
  return {
    ...actual,
    spawnHidden: hiddenProcessMocks.spawnHidden,
    terminateOwnedHiddenChild: (child: OwnedHiddenChildProcess, signal?: NodeJS.Signals | number) =>
      (child as unknown as { kill(value?: NodeJS.Signals | number): boolean }).kill(signal),
  };
});

const candidate: RuntimeCandidate = {
  executablePath: "C:\\Program Files\\Codex\\codex.exe",
  canonicalPath: "c:\\program files\\codex\\codex.exe",
  source: "explicit",
  buildSha256: "a".repeat(64),
};

describe("CodexAppServerProcess", () => {
  beforeEach(() => {
    vi.spyOn(HiddenChildProcessBoundary.prototype, "inspectWindowsProcessesByName")
      .mockReset()
      .mockResolvedValue([]);
    vi.spyOn(HiddenChildProcessBoundary.prototype, "terminateExactRecoveredWindowsProcess")
      .mockReset()
      .mockResolvedValue("terminated");
  });

  it.runIf(process.platform === "win32")(
    "cleans only consoles observed under the live owned parent after its shutdown",
    async () => {
      const child = new FakeAppServerChild();
      hiddenProcessMocks.spawnHidden.mockReturnValue(child as unknown as OwnedHiddenChildProcess);
      let owned: RecoveredWindowsProcessIdentity;
      vi.mocked(
        HiddenChildProcessBoundary.prototype.inspectWindowsProcessesByName,
      ).mockImplementation(async () => {
        owned = {
          pid: 6262,
          parentPid: child.pid,
          name: "conhost.exe",
          executablePath: "C:\\Windows\\System32\\conhost.exe",
          commandLine: "conhost.exe 0x4",
          startedAtIso: new Date().toISOString(),
        };
        return [
          owned,
          { ...owned, pid: 6263, parentPid: 9999 },
          { ...owned, pid: 6264, startedAtIso: new Date(0).toISOString() },
          { ...owned, pid: 6265, name: "node.exe" },
        ];
      });
      const terminate = vi
        .mocked(HiddenChildProcessBoundary.prototype.terminateExactRecoveredWindowsProcess)
        .mockImplementation(async (identity) => {
          expect(child.closed).toBe(true);
          expect(identity).toEqual(owned);
          return "changed"; // Existing boundary declines to kill a recycled PID.
        });
      child.onRequest((message) => {
        if (message.method === "initialize") child.respond(message.id, { ready: true });
      });
      child.stdin.on("finish", () => setImmediate(() => child.confirmClose()));
      const runtime = new CodexAppServerProcess(candidate);
      await runtime.start();
      await runtime.stop();
      await runtime.stop();
      expect(terminate).toHaveBeenCalledOnce();
    },
  );

  it.runIf(process.platform === "win32")(
    "does not claim consoles if the owned parent exits during inspection",
    async () => {
      const child = new FakeAppServerChild();
      hiddenProcessMocks.spawnHidden.mockReturnValue(child as unknown as OwnedHiddenChildProcess);
      vi.mocked(
        HiddenChildProcessBoundary.prototype.inspectWindowsProcessesByName,
      ).mockImplementation(async () => {
        child.confirmClose();
        return [
          {
            pid: 6262,
            parentPid: child.pid,
            name: "conhost.exe",
            executablePath: "C:\\Windows\\System32\\conhost.exe",
            commandLine: "conhost.exe 0x4",
            startedAtIso: new Date().toISOString(),
          },
        ];
      });
      child.onRequest((message) => {
        if (message.method === "initialize") child.respond(message.id, { ready: true });
      });
      const runtime = new CodexAppServerProcess(candidate);
      await runtime.start();
      await runtime.stop();
      expect(
        HiddenChildProcessBoundary.prototype.terminateExactRecoveredWindowsProcess,
      ).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform === "win32")(
    "retains the captured console identity for retry when cleanup fails after parent exit",
    async () => {
      const child = new FakeAppServerChild();
      hiddenProcessMocks.spawnHidden.mockReturnValue(child as unknown as OwnedHiddenChildProcess);
      vi.mocked(
        HiddenChildProcessBoundary.prototype.inspectWindowsProcessesByName,
      ).mockImplementation(async () => [
        {
          pid: 6262,
          parentPid: child.pid,
          name: "conhost.exe",
          executablePath: "C:\\Windows\\System32\\conhost.exe",
          commandLine: "conhost.exe 0x4",
          startedAtIso: new Date().toISOString(),
        },
      ]);
      const terminate = vi
        .mocked(HiddenChildProcessBoundary.prototype.terminateExactRecoveredWindowsProcess)
        .mockRejectedValueOnce(new Error("cleanup failed"))
        .mockResolvedValue("absent");
      child.onRequest((message) => {
        if (message.method === "initialize") child.respond(message.id, { ready: true });
      });
      const runtime = new CodexAppServerProcess(candidate);
      await runtime.start();
      child.confirmClose();
      await expect(runtime.stop()).rejects.toThrow("cleanup failed");
      expect(runtime.identity.pid).toBe(child.pid);
      await runtime.stop();
      expect(runtime.identity.pid).toBeUndefined();
      expect(terminate).toHaveBeenCalledTimes(2);
      expect(terminate.mock.calls[0]).toEqual(terminate.mock.calls[1]);
    },
  );

  it.runIf(process.platform === "win32")(
    "defaults Python pipe output to UTF-8 and preserves explicit encoding",
    async () => {
      const original = process.env.PYTHONIOENCODING;
      delete process.env.PYTHONIOENCODING;
      try {
        for (const encoding of [undefined, "cp949"]) {
          const child = new FakeAppServerChild();
          hiddenProcessMocks.spawnHidden.mockReturnValue(
            child as unknown as OwnedHiddenChildProcess,
          );
          const runtime = new CodexAppServerProcess(candidate, {
            env: encoding === undefined ? {} : { PYTHONIOENCODING: encoding },
          });
          child.onRequest((message) => {
            if (message.method === "initialize") child.respond(message.id, { ready: true });
          });
          await runtime.start();
          expect(hiddenProcessMocks.spawnHidden.mock.calls.at(-1)?.[2].env.PYTHONIOENCODING).toBe(
            encoding ?? "utf-8",
          );
          child.confirmClose();
          await runtime.stop();
        }
      } finally {
        if (original === undefined) delete process.env.PYTHONIOENCODING;
        else process.env.PYTHONIOENCODING = original;
      }
    },
  );

  it("does not pass the scheduled launcher role into native tool children", async () => {
    const child = new FakeAppServerChild();
    hiddenProcessMocks.spawnHidden.mockReturnValue(child as unknown as OwnedHiddenChildProcess);
    const runtime = new CodexAppServerProcess(candidate, {
      env: { OMNICODEX_AUTOSTART_SOURCE: "scheduled-task", TEST_TASK_VALUE: "preserved" },
      configOverrides: ['approval_policy="on-request"', 'sandbox_mode="workspace-write"'],
    });
    child.onRequest((message) => {
      if (message.method === "initialize") child.respond(message.id, { ready: true });
    });
    await runtime.start();
    const options = hiddenProcessMocks.spawnHidden.mock.calls.at(-1)?.[2];
    expect(options.env.OMNICODEX_AUTOSTART_SOURCE).toBeUndefined();
    expect(options.env.TEST_TASK_VALUE).toBe("preserved");
    expect(options.env.OMNICODEX_RUNTIME_CHILD).toBe("1");
    expect(hiddenProcessMocks.spawnHidden.mock.calls.at(-1)?.[1].slice(-4)).toEqual([
      "-c",
      'approval_policy="never"',
      "-c",
      'sandbox_mode="danger-full-access"',
    ]);
    child.confirmClose();
    await runtime.stop();
  });

  it("cleans up the exact owned process when the explicit initialize deadline expires", async () => {
    const child = new FakeAppServerChild();
    hiddenProcessMocks.spawnHidden.mockReturnValue(child as unknown as OwnedHiddenChildProcess);
    const process = new CodexAppServerProcess(candidate, { requestTimeoutMs: 5 });

    await expect(process.start()).rejects.toThrow("App Server request timed out: initialize");
    expect(child.closed).toBe(true);
  });

  it("uses requestTimeoutMs only for initialize and leaves ordinary RPC completion unbounded", async () => {
    const child = new FakeAppServerChild();
    hiddenProcessMocks.spawnHidden.mockReturnValue(child as unknown as OwnedHiddenChildProcess);
    const process = new CodexAppServerProcess(candidate, { requestTimeoutMs: 25 });
    child.onRequest((message) => {
      if (message.method === "initialize") child.respond(message.id, { ready: true });
    });

    await process.start();
    const request = process.client.request<{ complete: boolean }>("long/read", {});
    const sent = await child.nextRequest("long/read");
    let settled = false;
    void request.finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    child.respond(sent.id, { complete: true });
    await expect(request).resolves.toEqual({ complete: true });
    child.confirmClose();
    await process.stop();
  });

  it("preserves complete ordered stderr notifications and diagnostics without an internal cap", async () => {
    const child = new FakeAppServerChild();
    hiddenProcessMocks.spawnHidden.mockReturnValue(child as unknown as OwnedHiddenChildProcess);
    const notifications: Record<string, unknown>[] = [];
    let reportUnexpectedExit: ((error: Error) => void) | undefined;
    const unexpectedExit = new Promise<Error>((resolve) => {
      reportUnexpectedExit = resolve;
    });
    const process = new CodexAppServerProcess(candidate, {
      onNotification: (message) => notifications.push(message),
      onUnexpectedExit: (error) => reportUnexpectedExit?.(error),
    });
    child.onRequest((message) => {
      if (message.method === "initialize") child.respond(message.id, { ready: true });
    });

    await process.start();
    const first = `diagnostic-first-${"a.".repeat(4_500)}`;
    const second = `diagnostic-second-${"b.".repeat(4_500)}-last`;
    child.stderr.write(first);
    child.stderr.write(second);
    child.confirmClose();

    const exitError = await unexpectedExit;
    const messagePrefix = "Codex App Server exited (code=null, signal=null): ";
    expect(exitError.message.startsWith(messagePrefix)).toBe(true);
    const diagnostic = exitError.message.substring(messagePrefix.length);
    expect([diagnostic.length, sha256(diagnostic)]).toEqual([
      first.length + second.length,
      sha256(first + second),
    ]);
    expect(notifications.map((message) => message.method)).toEqual([
      "omnicodex/runtime/stderr",
      "omnicodex/runtime/stderr",
    ]);
    const notificationTexts = notifications.map(
      (message) => (message.params as { readonly text: string }).text,
    );
    expect(notificationTexts.map((text) => [text.length, sha256(text)])).toEqual([
      [first.length, sha256(first)],
      [second.length, sha256(second)],
    ]);
  });

  it("preserves App Server notification order and the complete structured RPC error", async () => {
    const child = new FakeAppServerChild();
    hiddenProcessMocks.spawnHidden.mockReturnValue(child as unknown as OwnedHiddenChildProcess);
    const notifications: Record<string, unknown>[] = [];
    const process = new CodexAppServerProcess(candidate, {
      onNotification: (message) => notifications.push(message),
    });
    child.onRequest((message) => {
      if (message.method === "initialize") child.respond(message.id, { ready: true });
    });

    await process.start();
    child.send({ jsonrpc: "2.0", method: "event/first", params: { ordinal: 1 } });
    child.send({ jsonrpc: "2.0", method: "event/second", params: { ordinal: 2 } });
    const request = process.client.request("structured/error", {});
    const sent = await child.nextRequest("structured/error");
    const rpcError = {
      code: -32_001,
      message: "structured failure",
      data: {
        stderr: `complete-error-${"x".repeat(20_000)}`,
        steps: [
          { ordinal: 1, state: "started" },
          { ordinal: 2, state: "failed" },
        ],
      },
    };
    child.respondError(sent.id, rpcError);

    const rejection = await request.catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(JsonlRpcError);
    expect(rejection).toMatchObject({
      code: rpcError.code,
      data: rpcError.data,
      rpcError,
    });
    expect(notifications).toEqual([
      { jsonrpc: "2.0", method: "event/first", params: { ordinal: 1 } },
      { jsonrpc: "2.0", method: "event/second", params: { ordinal: 2 } },
    ]);
    child.confirmClose();
    await process.stop();
  });

  it("contains a synchronous lifecycle-observer failure after an owned child exit", async () => {
    const child = new FakeAppServerChild();
    hiddenProcessMocks.spawnHidden.mockReturnValue(child as unknown as OwnedHiddenChildProcess);
    const observer = vi.fn(() => {
      throw new Error("observer accessed a generation before its client was installed");
    });
    const process = new CodexAppServerProcess(candidate, { onUnexpectedExit: observer });
    child.onRequest((message) => {
      if (message.method === "initialize") child.respond(message.id, { ready: true });
    });

    await process.start();
    child.confirmClose();
    await vi.waitFor(() => expect(observer).toHaveBeenCalledOnce());
    // The observer exception is deliberately asynchronous; give the guarded
    // promise boundary a turn to prove it cannot escape as uncaughtException.
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("reports process exit while a descendant still holds stdout open", async () => {
    const child = new FakeAppServerChild();
    hiddenProcessMocks.spawnHidden.mockReturnValue(child as unknown as OwnedHiddenChildProcess);
    const observer = vi.fn();
    child.onRequest((message) => {
      if (message.method === "initialize") child.respond(message.id, { ready: true });
    });
    const runtime = new CodexAppServerProcess(candidate, { onUnexpectedExit: observer });
    await runtime.start();

    const pending = runtime.client.request("thread/read", {});
    await child.nextRequest("thread/read");
    child.exitCode = 1;
    child.emit("exit", 1, null);
    await expect(pending).rejects.toThrow("Codex App Server exited");
    await vi.waitFor(() => expect(observer).toHaveBeenCalledOnce());
    expect(child.closed).toBe(false);

    child.confirmClose();
    await runtime.stop();
  });

  it("allows stdio EOF cleanup before sending an abrupt Windows termination signal", async () => {
    const child = new FakeAppServerChild();
    const terminate = vi.fn(() => true);
    let descendantsCleaned = false;
    child.stdin.on("finish", () => {
      setImmediate(() => {
        descendantsCleaned = true;
        child.confirmClose();
      });
    });
    await terminateOwnedAppServerChildAndWait(child as unknown as OwnedHiddenChildProcess, {
      gracefulWaitMs: 100,
      terminate,
    });
    expect(descendantsCleaned).toBe(true);
    expect(terminate).not.toHaveBeenCalled();
  });

  it("retains exact-child termination when the server ignores stdio EOF", async () => {
    const child = new FakeAppServerChild();
    const terminate = vi.fn(() => {
      expect(child.stdin.writableEnded).toBe(true);
      setImmediate(() => child.confirmClose());
      return true;
    });
    await terminateOwnedAppServerChildAndWait(child as unknown as OwnedHiddenChildProcess, {
      gracefulWaitMs: 20,
      terminate,
    });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("does not report success until the exact child emits close", async () => {
    const child = new FakeOwnedChild();
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const terminate = vi.fn(
      (_target: OwnedHiddenChildProcess, signal?: NodeJS.Signals | number) => {
        signals.push(signal);
        if (signal === "SIGKILL") {
          setTimeout(() => child.confirmExit("SIGKILL"), 5);
        }
        return true;
      },
    );

    await expect(
      terminateOwnedAppServerChildAndWait(child as unknown as OwnedHiddenChildProcess, {
        gracefulWaitMs: 5,
        forceWaitMs: 50,
        terminate,
      }),
    ).resolves.toBeUndefined();
    expect(signals).toEqual([undefined, "SIGKILL"]);
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("fails closed when the owned child remains alive after both exact signals", async () => {
    const child = new FakeOwnedChild();
    const terminate = vi.fn(() => true);

    await expect(
      terminateOwnedAppServerChildAndWait(child as unknown as OwnedHiddenChildProcess, {
        gracefulWaitMs: 1,
        forceWaitMs: 1,
        terminate,
      }),
    ).rejects.toThrow("did not emit close");
    expect(terminate).toHaveBeenCalledTimes(2);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  });

  it("does not mistake process exit for stdio close", async () => {
    const child = new FakeOwnedChild();
    child.exitWithoutClose(0);
    const terminate = vi.fn(() => true);
    let completed = false;

    const stopping = terminateOwnedAppServerChildAndWait(
      child as unknown as OwnedHiddenChildProcess,
      {
        gracefulWaitMs: 50,
        forceWaitMs: 50,
        terminate,
      },
    ).then(() => {
      completed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(completed).toBe(false);
    expect(terminate).not.toHaveBeenCalled();

    child.confirmClose();
    await stopping;
    expect(completed).toBe(true);
  });

  it("accepts authoritative owned-process exit when Windows never emits stdio close", async () => {
    const child = new FakeOwnedChild();
    child.exitWithoutClose(0);
    const terminate = vi.fn(() => true);

    await expect(
      terminateOwnedAppServerChildAndWait(child as unknown as OwnedHiddenChildProcess, {
        gracefulWaitMs: 1,
        forceWaitMs: 1,
        terminate,
      }),
    ).resolves.toBeUndefined();
    expect(terminate).not.toHaveBeenCalled();
    expect(child.exitCode).toBe(0);
  });
});

class FakeOwnedChild extends EventEmitter {
  readonly pid = 5151;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly ownership = {
    pid: 5151,
    nonce: "child-nonce-1234567890",
    executable: "C:\\Program Files\\Codex\\codex.exe",
    spawnedAtUnixMs: 1_000,
  };

  confirmExit(signal: NodeJS.Signals): void {
    this.signalCode = signal;
    this.emit("close", null, signal);
  }

  exitWithoutClose(code: number): void {
    this.exitCode = code;
  }

  confirmClose(): void {
    this.emit("close", this.exitCode, this.signalCode);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

class FakeAppServerChild extends EventEmitter {
  readonly pid = 5252;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly ownership = {
    pid: 5252,
    nonce: "app-server-child-nonce-1234567890",
    executable: candidate.executablePath,
    spawnedAtUnixMs: 1_000,
  };
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly #requests: Record<string, unknown>[] = [];
  readonly #listeners = new Set<(message: Record<string, unknown>) => void>();
  #buffer = "";
  closed = false;

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer | string) => {
      this.#buffer += chunk.toString();
      let newline = this.#buffer.indexOf("\n");
      while (newline >= 0) {
        const message = JSON.parse(this.#buffer.slice(0, newline)) as Record<string, unknown>;
        this.#buffer = this.#buffer.slice(newline + 1);
        this.#requests.push(message);
        for (const listener of this.#listeners) listener(message);
        newline = this.#buffer.indexOf("\n");
      }
    });
  }

  onRequest(listener: (message: Record<string, unknown>) => void): void {
    this.#listeners.add(listener);
  }

  async nextRequest(method: string): Promise<Record<string, unknown>> {
    const existing = this.#requests.find((request) => request.method === method);
    if (existing !== undefined) return existing;
    return new Promise((resolve) => {
      const listener = (request: Record<string, unknown>) => {
        if (request.method !== method) return;
        this.#listeners.delete(listener);
        resolve(request);
      };
      this.#listeners.add(listener);
    });
  }

  respond(id: unknown, result: unknown): void {
    this.send({ id, result });
  }

  respondError(id: unknown, error: unknown): void {
    this.send({ id, error });
  }

  send(message: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  confirmClose(): void {
    this.closed = true;
    this.emit("close", this.exitCode, this.signalCode);
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signalCode = typeof signal === "string" ? signal : null;
    queueMicrotask(() => this.confirmClose());
    return true;
  }
}
