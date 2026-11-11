import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { HiddenChildProcessBoundary } from "../src/infrastructure/windows/hidden-child-process.js";
import {
  matchesOracleBrowserProcess,
  OracleBrowserSupervisor,
  resolveOracleBrowserLaunchSpec,
} from "../src/infrastructure/windows/oracle-browser-supervisor.js";

describe("OracleBrowserSupervisor", () => {
  it("resolves only the dedicated browser-agent profile and an installed Chrome", () => {
    const present = new Set([
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Users\\ExampleUser\\.browser-agent\\browser-profile",
    ]);
    expect(
      resolveOracleBrowserLaunchSpec({
        environment: { PROGRAMFILES: "C:\\Program Files" },
        homeDirectory: "C:\\Users\\ExampleUser",
        pathExists: (path) => present.has(path),
      }),
    ).toEqual({
      chromeExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      profilePath: "C:\\Users\\ExampleUser\\.browser-agent\\browser-profile",
    });
  });

  it("accepts a live endpoint only when Chrome and the exact listener process agree", () => {
    const endpoint = new URL("http://127.0.0.1:9222/json/version");
    const payload = {
      Browser: "Chrome/151.0.0.0",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/exact-id",
    };
    const exact = {
      pid: 42,
      parentPid: 41,
      name: "chrome.exe",
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      commandLine:
        '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir=C:\\Users\\ExampleUser\\.browser-agent\\browser-profile',
      startedAtIso: "2026-08-27T00:00:00.000Z",
    };
    const argumentsAfterListener = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Users\\ExampleUser\\.browser-agent\\browser-profile",
      endpoint,
    ] as const;
    expect(matchesOracleBrowserProcess(payload, exact, ...argumentsAfterListener)).toBe(true);
    expect(
      matchesOracleBrowserProcess(
        {
          ...payload,
        },
        {
          ...exact,
          commandLine:
            '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir=C:\\Users\\ExampleUser\\wrong-profile',
        },
        ...argumentsAfterListener,
      ),
    ).toBe(false);
    expect(
      matchesOracleBrowserProcess(
        { ...payload, Browser: "Microsoft Edge/151.0.0.0" },
        exact,
        ...argumentsAfterListener,
      ),
    ).toBe(false);
  });

  it("never falls back to a normal Chrome profile when the dedicated profile is absent", () => {
    expect(() =>
      resolveOracleBrowserLaunchSpec({
        environment: { PROGRAMFILES: "C:\\Program Files" },
        homeDirectory: "C:\\Users\\ExampleUser",
        pathExists: (path) => path.endsWith("chrome.exe"),
      }),
    ).toThrow("dedicated logged-in browser-agent profile");
  });

  it("launches one non-headless offscreen Chrome with the exact hidden process boundary", async () => {
    const child = new FakeChild(4242);
    let clock = 0;
    const probes: string[] = [];
    const spawnCalls: Array<{
      readonly executable: string;
      readonly args: readonly string[];
      readonly options: Record<string, unknown>;
    }> = [];
    const childProcesses = new HiddenChildProcessBoundary((executable, args, options) => {
      spawnCalls.push({ executable, args, options: options as Record<string, unknown> });
      return child as never;
    });
    const supervisor = new OracleBrowserSupervisor({
      cdpEndpoint: "http://127.0.0.1:9222",
      chromeExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      profilePath: "C:\\Users\\ExampleUser\\.oracle\\browser-profile",
      childProcesses,
      startupTimeoutMs: 10,
      probeIntervalMs: 1,
      now: () => clock,
      delay: async (milliseconds) => {
        clock += milliseconds;
      },
      probe: async (url) => {
        probes.push(url.href);
        return probes.length === 2;
      },
    });

    await expect(supervisor.start()).resolves.toEqual({
      ownership: "owned",
      cdpEndpoint: "http://127.0.0.1:9222",
      versionEndpoint: "http://127.0.0.1:9222/json/version",
      pid: 4242,
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      profilePath: "C:\\Users\\ExampleUser\\.oracle\\browser-profile",
    });
    expect(probes).toEqual([
      "http://127.0.0.1:9222/json/version",
      "http://127.0.0.1:9222/json/version",
    ]);
    expect(spawnCalls).toEqual([
      {
        executable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        args: [
          "--remote-debugging-address=127.0.0.1",
          "--remote-debugging-port=9222",
          "--user-data-dir=C:\\Users\\ExampleUser\\.oracle\\browser-profile",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-background-mode",
          "--window-position=-32000,-32000",
          "--window-size=1280,800",
          "--new-window",
          "about:blank",
        ],
        options: expect.objectContaining({
          env: process.env,
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        }),
      },
    ]);
    expect(spawnCalls[0]?.args.some((argument) => argument.includes("headless"))).toBe(false);
  });

  it("reuses an external CDP endpoint and never spawns or terminates it", async () => {
    let spawnCount = 0;
    const probeOptions: Array<{ readonly timeoutMs?: number } | undefined> = [];
    const childProcesses = new HiddenChildProcessBoundary(() => {
      spawnCount += 1;
      return new FakeChild(5151) as never;
    });
    const supervisor = new OracleBrowserSupervisor({
      cdpEndpoint: "http://localhost:9333",
      chromeExecutablePath: "chrome.exe",
      profilePath: "C:\\oracle-profile",
      childProcesses,
      probe: async (_url, options) => {
        probeOptions.push(options);
        return true;
      },
    });

    await expect(supervisor.start()).resolves.toEqual({
      ownership: "external",
      cdpEndpoint: "http://localhost:9333",
      versionEndpoint: "http://localhost:9333/json/version",
      executablePath: "chrome.exe",
      profilePath: "C:\\oracle-profile",
    });
    await supervisor.stop();
    expect(spawnCount).toBe(0);
    expect(probeOptions).toEqual([undefined]);
    expect(supervisor.status).toBeUndefined();
  });

  it("takes ownership with a dedicated hidden Chrome after an external listener disappears", async () => {
    const child = new FakeChild(5252);
    const probes = [true, false, false, true];
    let spawnCount = 0;
    const supervisor = new OracleBrowserSupervisor({
      cdpEndpoint: "http://127.0.0.1:9334",
      chromeExecutablePath: "chrome.exe",
      profilePath: "C:\\oracle-profile",
      childProcesses: new HiddenChildProcessBoundary(() => {
        spawnCount += 1;
        return child as never;
      }),
      probe: async () => probes.shift() ?? true,
    });
    await expect(supervisor.start()).resolves.toMatchObject({ ownership: "external" });

    await expect(supervisor.restart()).resolves.toMatchObject({
      ownership: "owned",
      pid: 5252,
    });
    expect(spawnCount).toBe(1);
  });

  it("reports one unexpected owned-browser exit and never reports an intentional stop", async () => {
    const first = new FakeChild(9191);
    const second = new FakeChild(9292);
    const children = [first, second];
    const errors: string[] = [];
    let probeCount = 0;
    const supervisor = new OracleBrowserSupervisor({
      cdpEndpoint: "http://127.0.0.1:9777",
      chromeExecutablePath: "chrome.exe",
      profilePath: "C:\\oracle-profile",
      childProcesses: new HiddenChildProcessBoundary(() => children.shift() as never),
      probe: async () => {
        probeCount += 1;
        return probeCount % 2 === 0;
      },
      onUnexpectedExit: (error) => {
        errors.push(error.message);
      },
    });

    await supervisor.start();
    first.exitCode = 1;
    first.emit("close", 1);
    await Promise.resolve();
    expect(errors).toEqual(["Owned Oracle browser exited unexpectedly"]);

    await supervisor.start();
    await supervisor.stop();
    second.emit("close", 0);
    await Promise.resolve();
    expect(errors).toHaveLength(1);
  });

  it("stops exactly its owned child and does not signal another handle", async () => {
    const ownedChild = new FakeChild(6161);
    const unrelatedChild = new FakeChild(6161);
    let probeCount = 0;
    const childProcesses = new HiddenChildProcessBoundary(() => ownedChild as never);
    const supervisor = new OracleBrowserSupervisor({
      cdpEndpoint: "http://127.0.0.1:9444",
      chromeExecutablePath: "chrome.exe",
      profilePath: "C:\\oracle-profile",
      childProcesses,
      probe: async () => {
        probeCount += 1;
        return probeCount === 2;
      },
    });

    await supervisor.start();
    expect(childProcesses.terminateOwnedHiddenChild(unrelatedChild as never)).toBe(false);
    await supervisor.stop();
    await supervisor.stop();

    expect(ownedChild.signals).toEqual(["SIGTERM"]);
    expect(unrelatedChild.signals).toEqual([]);
    expect(supervisor.status).toBeUndefined();
  });

  it("terminates its owned child when CDP readiness times out", async () => {
    const child = new FakeChild(7171);
    let clock = 0;
    const childProcesses = new HiddenChildProcessBoundary(() => child as never);
    const supervisor = new OracleBrowserSupervisor({
      cdpEndpoint: "http://127.0.0.1:9555",
      chromeExecutablePath: "chrome.exe",
      profilePath: "C:\\oracle-profile",
      childProcesses,
      startupTimeoutMs: 2,
      probeIntervalMs: 1,
      now: () => clock,
      delay: async (milliseconds) => {
        clock += milliseconds;
      },
      probe: async () => false,
    });

    await expect(supervisor.start()).rejects.toThrow("CDP readiness timed out");
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(supervisor.status).toBeUndefined();
  });

  it("terminates its owned handle when Chrome reports a launch error", async () => {
    const child = new FakeChild(8181);
    let probeCount = 0;
    const childProcesses = new HiddenChildProcessBoundary(() => {
      queueMicrotask(() => child.emit("error", new Error("Chrome launch failed")));
      return child as never;
    });
    const supervisor = new OracleBrowserSupervisor({
      cdpEndpoint: "http://127.0.0.1:9666",
      chromeExecutablePath: "chrome.exe",
      profilePath: "C:\\oracle-profile",
      childProcesses,
      probe: async () => {
        probeCount += 1;
        return false;
      },
    });

    await expect(supervisor.start()).rejects.toThrow("Chrome launch failed");
    expect(probeCount).toBeGreaterThanOrEqual(2);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(supervisor.status).toBeUndefined();
  });
});

class FakeChild extends EventEmitter {
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: Array<NodeJS.Signals | number> = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  get signalCount(): number {
    return this.signals.length;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }
}
