import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const scriptUrl = pathToFileURL(
  resolve("scripts/windows/desktop-engine/stock-app-server-stdio.mjs"),
).href;
const {
  acquireDesktopStartupLock,
  closeDesktopInput,
  desktopAppServerCandidates,
  isDesktopLauncher,
  isDirectEntrypoint,
  main,
  waitForDesktopAppServerPipe,
  waitForDesktopStartupState,
} = await import(scriptUrl);

const executablePath =
  "C:\\Users\\ExampleUser\\AppData\\Local\\OpenAI\\Codex\\bin\\build\\codex.exe";
const desktop = {
  pid: 10,
  parentPid: 1,
  name: "ChatGPT.exe",
  executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1_x64__abc\\app\\ChatGPT.exe",
  commandLine: "ChatGPT.exe",
  startedAtUnixMs: 1000,
};
const launcher = {
  pid: 20,
  parentPid: 10,
  name: "OmniCodexDesktopEngine.exe",
  startedAtUnixMs: 2000,
};
const node = {
  pid: 30,
  parentPid: 20,
  name: "node.exe",
  commandLine: '"C:\\node.exe" C:\\OmniCodex\\stock-app-server-stdio.mjs app-server',
  startedAtUnixMs: 3000,
};
const server = {
  pid: 40,
  parentPid: 30,
  name: "codex.exe",
  executablePath,
  commandLine: `"${executablePath}" app-server`,
  startedAtUnixMs: 10_000,
};
const processes = [desktop, launcher, node, server];
const nonce = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const record = {
  schemaVersion: 1,
  pid: server.pid,
  pipeName: `\\\\.\\pipe\\codex-app-server-${server.pid}-${nonce}`,
  executablePath,
  appServerVersion: "0.165.0-alpha.1.2",
  instanceNonce: nonce,
  startedAtUnixMs: 11_000,
  ownerKind: "desktop",
  routerProtocolVersion: 2,
};
const file = `desktop-app-server-${server.pid}-${nonce}.json`;

describe("stock Desktop app-server attachment", () => {
  it("ends the Desktop input loop after the owned app-server exits", async () => {
    const input = new PassThrough();
    const lines = createInterface({ input, crlfDelay: Infinity });
    const pending = lines[Symbol.asyncIterator]().next();
    closeDesktopInput(lines, input);
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(input.isPaused()).toBe(true);
  });

  it.skipIf(process.platform !== "win32")(
    "exits and cleans the owner registry when stock dies during publication and Desktop stdin stays open",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "omnicodex-bridge-exit-"));
      const stockCode = `process.stdin.once('data', () => {
        process.stdout.write(JSON.stringify({ id: 1, result: { userAgent: 'test' } }) + '\\n', () => {
          setTimeout(() => process.exit(0), 30);
        });
      }); process.stdin.resume();`;
      const wrapperCode = `
        const { bridgeDesktopAppServer } = await import(${JSON.stringify(scriptUrl)});
        class Router {
          ready = false;
          constructor(transport) { this.transport = transport; }
          receiveDesktop(line) { this.transport.sendServer(line); }
          async receiveServer(line) { this.ready = true; this.transport.sendDesktop(line); }
        }
        await bridgeDesktopAppServer(process.execPath, ['-e', ${JSON.stringify(stockCode)}], false, {
          readVersion: async () => {
            await new Promise((resolve) => setTimeout(resolve, 250));
            return '0.1.0';
          },
          loadBridgeModules: async () => [
            { PolicyDocumentationService: class {} },
            { StdioAppServerRouter: Router, attachOmniClientSocket: () => {} },
          ],
        });
      `;
      const wrapper = spawn(process.execPath, ["--input-type=module", "-e", wrapperCode], {
        windowsHide: true,
        env: { ...process.env, CODEX_HOME: home },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      wrapper.stdout.on("data", (chunk) => (stdout += chunk.toString()));
      wrapper.stderr.on("data", (chunk) => (stderr += chunk.toString()));
      const exited = once(wrapper, "exit");
      try {
        wrapper.stdin.write('{"id":1,"method":"initialize","params":{}}\n');
        const [exitCode] = await Promise.race([
          exited,
          delay(5000, undefined, { ref: false }).then(() => {
            throw new Error(`Bridge remained alive with open Desktop stdin: ${stderr}`);
          }),
        ]);
        expect(exitCode, stderr).toBe(0);
        expect(stdout).toContain('"id":1');
        expect(wrapper.stdin.writableEnded).toBe(false);
        const entries = await readdir(join(home, "shared-app-server")).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
          },
        );
        expect(entries).toEqual([]);
      } finally {
        wrapper.kill();
        wrapper.stdin.destroy();
        await rm(home, { recursive: true, force: true });
      }
    },
    8000,
  );

  it("recognizes the actual entry path despite Windows path casing", () => {
    const scriptPath = resolve("scripts/windows/desktop-engine/stock-app-server-stdio.mjs");
    expect(isDirectEntrypoint(scriptPath, scriptPath)).toBe(true);
    expect(isDirectEntrypoint(undefined, scriptPath)).toBe(false);
    expect(isDirectEntrypoint(resolve("package.json"), scriptPath)).toBe(false);
    if (process.platform === "win32") {
      expect(isDirectEntrypoint(scriptPath.toUpperCase(), scriptPath)).toBe(true);
    }
  });

  it("recognizes Desktop's launcher and rejects another process as the owner", () => {
    expect(isDesktopLauncher(processes, node.pid)).toBe(true);
    expect(isDesktopLauncher([desktop, { ...launcher, parentPid: 999 }, node], node.pid)).toBe(
      false,
    );
    expect(
      isDesktopLauncher(
        [desktop, launcher, { ...node, commandLine: "node unrelated.js" }],
        node.pid,
      ),
    ).toBe(false);
  });

  it("keeps Desktop's initial server start even when stdio is explicit", async () => {
    const startDesktopServer = vi.fn(async () => undefined);
    const attachDesktopServer = vi.fn(async () => undefined);
    const args = ["app-server", "--listen", "stdio://"];
    await main(args, {
      currentPid: node.pid,
      inspectProcesses: async () => [desktop, launcher, node],
      findExecutable: async () => executablePath,
      acquireStartupLock: async () => ({ release: async () => undefined }),
      startDesktopServer,
      attachDesktopServer,
    });
    expect(startDesktopServer).toHaveBeenCalledWith(
      executablePath,
      args,
      false,
      expect.objectContaining({ onStartupFinished: expect.any(Function) }),
    );
    expect(attachDesktopServer).not.toHaveBeenCalled();
  });

  it("keeps Desktop's initial server start with the default stdio arguments", async () => {
    const startDesktopServer = vi.fn(async () => undefined);
    const attachDesktopServer = vi.fn(async () => undefined);
    const args = ["app-server", "--analytics-default-enabled"];
    await main(args, {
      currentPid: node.pid,
      inspectProcesses: async () => [desktop, launcher, node],
      findExecutable: async () => executablePath,
      acquireStartupLock: async () => ({ release: async () => undefined }),
      startDesktopServer,
      attachDesktopServer,
    });
    expect(startDesktopServer).toHaveBeenCalledWith(
      executablePath,
      args,
      false,
      expect.objectContaining({ onStartupFinished: expect.any(Function) }),
    );
    expect(attachDesktopServer).not.toHaveBeenCalled();
  });

  it("attaches a second Desktop launcher to the already-running Desktop server", async () => {
    const startDesktopServer = vi.fn(async () => undefined);
    const attachDesktopServer = vi.fn(async () => undefined);
    await main(["app-server", "--listen", "stdio://"], {
      currentPid: node.pid,
      inspectProcesses: async () => processes,
      acquireStartupLock: async () => ({ release: async () => undefined }),
      startDesktopServer,
      attachDesktopServer,
    });
    expect(startDesktopServer).not.toHaveBeenCalled();
    expect(attachDesktopServer).toHaveBeenCalledWith(processes);
  });

  it("returns a connection failure instead of starting a second server for a client", async () => {
    const startDesktopServer = vi.fn(async () => undefined);
    const findExecutable = vi.fn(async () => executablePath);
    const attachDesktopServer = vi.fn(async () => {
      throw new Error("Desktop pipe unavailable");
    });
    await expect(
      main(["app-server", "--listen", "stdio://"], {
        currentPid: 999,
        inspectProcesses: async () => processes,
        findExecutable,
        startDesktopServer,
        attachDesktopServer,
      }),
    ).rejects.toThrow("Desktop pipe unavailable");
    expect(startDesktopServer).not.toHaveBeenCalled();
    expect(findExecutable).not.toHaveBeenCalled();
  });

  it.each([["app-server"], ["app-server", "--listen=stdio://"]])(
    "attaches a non-Desktop stdio invocation %j to the existing server",
    async (...args: string[]) => {
      const startDesktopServer = vi.fn(async () => undefined);
      const attachDesktopServer = vi.fn(async () => undefined);
      await main(args, {
        currentPid: 999,
        inspectProcesses: async () => processes,
        startDesktopServer,
        attachDesktopServer,
      });
      expect(startDesktopServer).not.toHaveBeenCalled();
      expect(attachDesktopServer).toHaveBeenCalledWith(processes);
    },
  );

  it("passes a non-stdio listen option through to the installed executable", async () => {
    const args = ["app-server", "--listen=ws://127.0.0.1:7890"];
    const fakeChild = { once: vi.fn() };
    const spawnProcess = vi.fn(() => fakeChild);
    const inspectProcesses = vi.fn(async () => processes);
    const attachDesktopServer = vi.fn(async () => undefined);
    await main(args, {
      findExecutable: async () => executablePath,
      spawnProcess,
      inspectProcesses,
      attachDesktopServer,
    });
    expect(spawnProcess).toHaveBeenCalledWith(
      executablePath,
      args,
      expect.objectContaining({ windowsHide: true, stdio: "inherit" }),
    );
    expect(inspectProcesses).not.toHaveBeenCalled();
    expect(attachDesktopServer).not.toHaveBeenCalled();
  });

  it("selects the live Desktop record and rejects reused PIDs, unrelated servers and wrong paths", () => {
    const oldNonce = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const old = {
      file: `desktop-app-server-${server.pid}-${oldNonce}.json`,
      record: {
        ...record,
        instanceNonce: oldNonce,
        pipeName: `\\\\.\\pipe\\codex-app-server-${server.pid}-${oldNonce}`,
        startedAtUnixMs: 5000,
      },
    };
    expect(desktopAppServerCandidates([old, { file, record }], processes, 20_000)).toEqual([
      record,
    ]);
    expect(
      desktopAppServerCandidates(
        [{ file, record }],
        [desktop, launcher, node, { ...server, parentPid: 999 }],
        20_000,
      ),
    ).toEqual([]);
    expect(
      desktopAppServerCandidates(
        [{ file, record: { ...record, executablePath: "C:\\other\\codex.exe" } }],
        processes,
        20_000,
      ),
    ).toEqual([]);
    expect(
      desktopAppServerCandidates(
        [{ file, record: { ...record, ownerKind: "auxiliary" } }],
        processes,
        20_000,
      ),
    ).toEqual([]);
  });

  it("waits for an orphaned stock server to exit before starting another", async () => {
    const orphan = { ...server, parentPid: 999 };
    let clock = 20_000;
    const inspectProcesses = vi
      .fn()
      .mockResolvedValueOnce([desktop, launcher, node, orphan])
      .mockResolvedValueOnce([desktop, launcher, node]);
    const startup = await waitForDesktopStartupState({
      initialProcesses: [desktop, launcher, node, orphan],
      executablePath,
      inspectProcesses,
      now: () => clock,
      pause: async (ms: number) => {
        clock += ms;
      },
      timeoutMs: 5000,
    });
    expect(startup.action).toBe("start");
    expect(inspectProcesses).toHaveBeenCalledTimes(2);
  });

  it("fails with a deadline if the orphaned server does not exit", async () => {
    const orphan = { ...server, parentPid: 999 };
    let clock = 20_000;
    const active = [desktop, launcher, node, orphan];
    await expect(
      waitForDesktopStartupState({
        initialProcesses: active,
        executablePath,
        inspectProcesses: async () => active,
        now: () => clock,
        pause: async (ms: number) => {
          clock += ms;
        },
        timeoutMs: 500,
      }),
    ).rejects.toThrow("Previous Codex app-server did not exit within 500ms");
  });

  it("waits when a live bridge's launcher exited or its PID was reused", async () => {
    let clock = 20_000;
    const reusedLauncher = { ...launcher, startedAtUnixMs: 9000 };
    const staleChain = [desktop, reusedLauncher, node, server];
    await expect(
      waitForDesktopStartupState({
        initialProcesses: staleChain,
        executablePath,
        inspectProcesses: async () => staleChain,
        now: () => clock,
        pause: async (ms: number) => {
          clock += ms;
        },
        timeoutMs: 500,
      }),
    ).rejects.toThrow("Previous Codex app-server did not exit within 500ms");
    const missingLauncher = [desktop, node, server];
    await expect(
      waitForDesktopStartupState({
        initialProcesses: missingLauncher,
        executablePath,
        inspectProcesses: async () => missingLauncher,
        now: () => clock,
        pause: async (ms: number) => {
          clock += ms;
        },
        timeoutMs: 500,
      }),
    ).rejects.toThrow("Previous Codex app-server did not exit within 500ms");
  });

  it("does not mistake an unrelated server with a live parent for an orphan", async () => {
    const unrelatedParent = {
      pid: 999,
      parentPid: 1,
      name: "another-app.exe",
      startedAtUnixMs: 1000,
    };
    const unrelatedServer = { ...server, parentPid: unrelatedParent.pid };
    const startup = await waitForDesktopStartupState({
      initialProcesses: [desktop, launcher, node, unrelatedParent, unrelatedServer],
      executablePath,
      inspectProcesses: async () => [],
    });
    expect(startup.action).toBe("start");
  });

  it("waits for publication and retries a temporarily unavailable pipe", async () => {
    let clock = 20_000;
    let reads = 0;
    let connections = 0;
    const socket = { identity: "connected" };
    const result = await waitForDesktopAppServerPipe({
      initialProcesses: processes,
      readRecords: async () => (++reads < 3 ? [] : [{ file, record }]),
      inspectProcesses: async () => processes,
      connectPipe: async () => (++connections === 1 ? undefined : socket),
      now: () => clock,
      pause: async (ms: number) => {
        clock += ms;
      },
      timeoutMs: 3000,
    });
    expect(result).toEqual({ record, socket });
    expect(reads).toBe(4);
    expect(connections).toBe(2);
  });

  it("lets independent clients attach to the same server without sharing their sockets", async () => {
    const connectPipe = vi.fn(async () => ({}));
    const options = {
      initialProcesses: processes,
      readRecords: async () => [{ file, record }],
      inspectProcesses: async () => processes,
      connectPipe,
      now: () => 20_000,
      timeoutMs: 1000,
    };
    const [first, second] = await Promise.all([
      waitForDesktopAppServerPipe(options),
      waitForDesktopAppServerPipe(options),
    ]);
    expect(first.record.pid).toBe(server.pid);
    expect(second.record.pid).toBe(server.pid);
    expect(first.socket).not.toBe(second.socket);
    expect(connectPipe).toHaveBeenCalledTimes(2);
  });

  it("reports a bounded failure when Desktop never publishes a usable pipe", async () => {
    let clock = 20_000;
    const connectPipe = vi.fn(async () => undefined);
    await expect(
      waitForDesktopAppServerPipe({
        initialProcesses: processes,
        readRecords: async () => [{ file, record }],
        inspectProcesses: async () => processes,
        connectPipe,
        now: () => clock,
        pause: async (ms: number) => {
          clock += ms;
        },
        timeoutMs: 500,
      }),
    ).rejects.toThrow("not available within 500ms");
    expect(connectPipe).toHaveBeenCalledTimes(2);
  });
});

describe.skipIf(process.platform !== "win32")("Windows Desktop startup lock", () => {
  it("starts only one server when Desktop launchers race", async () => {
    const pipeName = `\\\\.\\pipe\\omnicodex-test-start-${randomUUID()}`;
    let running = false;
    let signalStarted: () => void = () => undefined;
    let allowReady: () => void = () => undefined;
    const started = new Promise<void>((resolveStarted) => {
      signalStarted = resolveStarted;
    });
    const ready = new Promise<void>((resolveReady) => {
      allowReady = resolveReady;
    });
    const startDesktopServer = vi.fn(
      async (
        _executable: string,
        _args: string[],
        _auxiliary: boolean,
        options: { onStartupFinished: () => Promise<void> },
      ) => {
        running = true;
        signalStarted();
        await ready;
        await options.onStartupFinished();
      },
    );
    const attachDesktopServer = vi.fn(async () => undefined);
    const options = {
      currentPid: node.pid,
      inspectProcesses: async () => (running ? processes : [desktop, launcher, node]),
      findExecutable: async () => executablePath,
      acquireStartupLock: () => acquireDesktopStartupLock({ pipeName, timeoutMs: 4000 }),
      startDesktopServer,
      attachDesktopServer,
    };
    const first = main(["app-server"], options);
    await started;
    const second = main(["app-server"], options);
    await delay(50);
    expect(attachDesktopServer).not.toHaveBeenCalled();
    allowReady();
    await Promise.all([first, second]);
    expect(startDesktopServer).toHaveBeenCalledTimes(1);
    expect(attachDesktopServer).toHaveBeenCalledTimes(1);
  });

  it("lets the next Desktop launcher start when the first startup fails", async () => {
    const pipeName = `\\\\.\\pipe\\omnicodex-test-failed-${randomUUID()}`;
    let running = false;
    let signalStarted: () => void = () => undefined;
    let allowFailure: () => void = () => undefined;
    const started = new Promise<void>((resolveStarted) => {
      signalStarted = resolveStarted;
    });
    const fail = new Promise<void>((resolveFailure) => {
      allowFailure = resolveFailure;
    });
    let attempts = 0;
    const startDesktopServer = vi.fn(
      async (
        _executable: string,
        _args: string[],
        _auxiliary: boolean,
        options: { onStartupFinished: () => Promise<void> },
      ) => {
        attempts += 1;
        if (attempts === 1) {
          signalStarted();
          await fail;
          throw new Error("first startup failed");
        }
        running = true;
        await options.onStartupFinished();
      },
    );
    const options = {
      currentPid: node.pid,
      inspectProcesses: async () => (running ? processes : [desktop, launcher, node]),
      findExecutable: async () => executablePath,
      acquireStartupLock: () => acquireDesktopStartupLock({ pipeName, timeoutMs: 4000 }),
      startDesktopServer,
      attachDesktopServer: vi.fn(async () => undefined),
    };
    const first = main(["app-server"], options);
    const results = Promise.allSettled([first, started.then(() => main(["app-server"], options))]);
    await started;
    await delay(50);
    allowFailure();
    const [failed, succeeded] = await results;
    expect(failed?.status).toBe("rejected");
    expect(succeeded?.status).toBe("fulfilled");
    expect(startDesktopServer).toHaveBeenCalledTimes(2);
  });

  it("times out instead of waiting forever when another startup holds the lock", async () => {
    const pipeName = `\\\\.\\pipe\\omnicodex-test-timeout-${randomUUID()}`;
    const first = await acquireDesktopStartupLock({ pipeName, timeoutMs: 1000 });
    try {
      await expect(acquireDesktopStartupLock({ pipeName, timeoutMs: 300 })).rejects.toThrow(
        "startup lock was unavailable within 300ms",
      );
    } finally {
      await first.release();
    }
    const next = await acquireDesktopStartupLock({ pipeName, timeoutMs: 1000 });
    await next.release();
  });

  it("releases the lock automatically when its owning process exits", async () => {
    const pipeName = `\\\\.\\pipe\\omnicodex-test-exit-${randomUUID()}`;
    const childCode = `
      const module = await import(process.argv[1]);
      await module.acquireDesktopStartupLock({ pipeName: process.argv[2], timeoutMs: 1500 });
      console.log('ready');
      process.stdin.once('end', () => process.exit(0));
      process.stdin.resume();
      setTimeout(() => process.exit(0), 4000);
    `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", childCode, scriptUrl, pipeName],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exited = once(child, "exit");
    try {
      await once(child.stdout, "data");
      const waiting = acquireDesktopStartupLock({ pipeName, timeoutMs: 3000 });
      await delay(50);
      child.stdin.end();
      const lock = await waiting;
      await lock.release();
      expect((await exited)[0]).toBe(0);
    } finally {
      child.stdin.end();
      await exited;
    }
  });
});
