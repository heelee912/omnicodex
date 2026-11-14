import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexDesktopLifecycleController } from "../src/infrastructure/windows/codex-desktop-lifecycle-controller.js";
import { HiddenChildProcessBoundary } from "../src/infrastructure/windows/hidden-child-process.js";

const stopped = {
  packageFamilyName: "OpenAI.Codex_test",
  packageFullName: "OpenAI.Codex_1.0.0.0_x64__test",
  version: "1.0.0.0",
  installLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_test",
  appUserModelId: "OpenAI.Codex_test!App",
  processes: [],
} as const;

const running = {
  ...stopped,
  processes: [{ pid: 4812, responding: true, startedAtIso: "2026-09-02T00:00:00Z" }],
} as const;

afterEach(() => vi.unstubAllEnvs());

describe("CodexDesktopLifecycleController", () => {
  it.skipIf(process.platform !== "win32")(
    "carries passive Chat event launch settings through the external launcher",
    async () => {
      let state: typeof stopped | typeof running = stopped;
      let launchInput: Record<string, unknown> | undefined;
      vi.stubEnv("OMNICODEX_TEST_NATIVE_ENV", "preserve-native-launch");
      const childProcesses = new HiddenChildProcessBoundary((_executable, _args, options) => {
        expect(options.windowsHide).toBe(true);
        expect(options.env?.OMNICODEX_TEST_NATIVE_ENV).toBe("preserve-native-launch");
        const child = Object.assign(new EventEmitter(), {
          pid: 9234,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        });
        let text = "";
        child.stdin.on("data", (chunk) => {
          text += String(chunk);
        });
        child.stdin.on("finish", () => {
          launchInput = JSON.parse(text);
          state = running;
          child.stdout.write('{"requested":true}');
          child.emit("close", 0, null);
        });
        return child as never;
      });
      const controller = new CodexDesktopLifecycleController({
        enableChatEvents: true,
        childProcesses,
        inspect: async () => state,
        nativeToolsReady: async () => true,
      });
      await expect(controller.ensureRunning()).resolves.toMatchObject({ disposition: "launched" });
      expect(launchInput).toEqual({
        packageFullName: stopped.packageFullName,
        appUserModelId: stopped.appUserModelId,
        enableChatEvents: true,
      });
    },
  );

  it.skipIf(process.platform !== "win32").each(["async write", "synchronous end"] as const)(
    "contains lifecycle stdin EPIPE from %s without killing or resettling the helper",
    async (failureMode) => {
      const cause = Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write" });
      const stdin = new Writable({
        write(_chunk, _encoding, callback) {
          expect(this.listenerCount("error")).toBeGreaterThan(0);
          setImmediate(() => callback(cause));
        },
      });
      if (failureMode === "synchronous end") {
        vi.spyOn(stdin, "end").mockImplementation(() => {
          expect(stdin.listenerCount("error")).toBeGreaterThan(0);
          throw cause;
        });
      }
      const child = lifecycleChild(stdin);
      const controller = new CodexDesktopLifecycleController({
        systemRoot: "C:\\Windows",
        childProcesses: new HiddenChildProcessBoundary(() => child as never),
      });
      const abort = new AbortController();
      const resolved = vi.fn();
      const rejected = vi.fn((error: unknown) => error);
      const result = controller
        .status({ signal: abort.signal, timeoutMs: 1_000 })
        .then(resolved, rejected);

      const error = await result;
      expect(error).toMatchObject({
        message: "CODEX_DESKTOP_LIFECYCLE_HELPER_STDIN_FAILED",
        cause,
        stdout: "",
        stderr: "",
      });
      expect((error as Error).cause).toBe(cause);
      abort.abort();
      child.stdout.end("null");
      child.emit("close", 0, null);
      expect(() => {
        stdin.emit("error", cause);
        stdin.emit("error", cause);
        child.emit("error", new Error("late helper error"));
      }).not.toThrow();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(resolved).not.toHaveBeenCalled();
      expect(rejected).toHaveBeenCalledTimes(1);
      expect(child.kill).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform !== "win32").each(["close", "abort", "deadline"] as const)(
    "keeps late lifecycle stdin errors handled after %s",
    async (firstEvent) => {
      vi.useFakeTimers();
      try {
        const child = lifecycleChild(new PassThrough());
        const controller = new CodexDesktopLifecycleController({
          systemRoot: "C:\\Windows",
          childProcesses: new HiddenChildProcessBoundary(() => child as never),
        });
        const abort = new AbortController();
        const settled = vi.fn((value: unknown) => value);
        const result = controller
          .status({ signal: abort.signal, timeoutMs: 10 })
          .then(settled, settled);
        if (firstEvent === "close") {
          child.stdout.end("null");
          child.emit("close", 0, null);
        } else if (firstEvent === "abort") abort.abort(new Error("caller cancelled"));
        else await vi.advanceTimersByTimeAsync(10);
        const value = await result;
        if (firstEvent === "close") expect(value).toMatchObject({ installed: false });
        else expect(value).toBeInstanceOf(Error);
        expect(() => {
          child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
          child.stdin.emit("error", new Error("late pipe error"));
        }).not.toThrow();
        child.emit("close", 7, null);
        abort.abort();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(settled).toHaveBeenCalledTimes(1);
        expect(child.kill).toHaveBeenCalledTimes(firstEvent === "close" ? 0 : 1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("completes graceful close, exact stop, launch, and native readiness as one restart", async () => {
    let state: typeof stopped | typeof running = running;
    const order: string[] = [];
    const inspect = vi.fn(async () => state);
    const controller = new CodexDesktopLifecycleController({
      inspect,
      requestGracefulClose: async (installed) => {
        order.push(`close:${installed.processes.map((process) => process.pid).join(",")}`);
        state = stopped;
      },
      requestLaunch: async (installed) => {
        order.push(`launch:${installed.appUserModelId}`);
        state = running;
      },
      nativeToolsReady: async () => {
        order.push("native-ready");
        return true;
      },
    });

    await expect(controller.restart()).resolves.toMatchObject({
      disposition: "restarted",
      before: { running: true, nativeToolsReady: false },
      after: { running: true, responding: true, nativeToolsReady: true },
    });
    expect(order).toEqual(["close:4812", "launch:OpenAI.Codex_test!App", "native-ready"]);
    expect(inspect).toHaveBeenCalledTimes(4);
  });

  it("launches an absent process without manufacturing an internal timeout", async () => {
    let state: typeof stopped | typeof running = stopped;
    const requestLaunch = vi.fn(async () => {
      state = running;
    });
    const controller = new CodexDesktopLifecycleController({
      inspect: async () => state,
      requestLaunch,
      nativeToolsReady: async (boundary) => {
        expect(boundary.timeoutMs).toBeUndefined();
        expect(boundary.deadlineUnixMs).toBeUndefined();
        return true;
      },
    });

    await expect(controller.ensureRunning()).resolves.toMatchObject({
      disposition: "launched",
      before: { running: false },
      after: { nativeToolsReady: true },
    });
    expect(requestLaunch).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent lifecycle mutations", async () => {
    let state: typeof stopped | typeof running = stopped;
    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const order: string[] = [];
    const controller = new CodexDesktopLifecycleController({
      inspect: async () => state,
      requestLaunch: async () => {
        order.push("launch-start");
        await launchGate;
        state = running;
        order.push("launch-end");
      },
      nativeToolsReady: async () => true,
    });

    const first = controller.ensureRunning();
    const second = controller.ensureRunning().then((value) => {
      order.push("second-complete");
      return value;
    });
    await vi.waitFor(() => expect(order).toEqual(["launch-start"]));
    releaseLaunch();

    await expect(first).resolves.toMatchObject({ disposition: "launched" });
    await expect(second).resolves.toMatchObject({ disposition: "already_running" });
    expect(order).toEqual(["launch-start", "launch-end", "second-complete"]);
  });
});

function lifecycleChild(stdin: Writable) {
  return Object.assign(new EventEmitter(), {
    pid: 9234,
    exitCode: null,
    signalCode: null,
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
}
