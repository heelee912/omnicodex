import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FirstPartyChromeSurfaceRecovery } from "../src/infrastructure/windows/first-party-chrome-surface-recovery.js";
import type {
  HiddenSpawnOptions,
  OwnedHiddenChildProcess,
} from "../src/infrastructure/windows/hidden-child-process.js";

describe("FirstPartyChromeSurfaceRecovery", () => {
  beforeEach(() => {
    vi.stubEnv("LOCALAPPDATA", "C:\\Users\\ExampleUser\\AppData\\Local");
    vi.stubEnv(
      "CODEX_CHROMIUM_PREFERENCES_PATH",
      "C:\\Users\\ExampleUser\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Preferences",
    );
  });
  afterEach(() => vi.unstubAllEnvs());
  it.runIf(process.platform === "win32")(
    "reports whether Chrome runs through the read-only diagnostic alone",
    async () => {
      const root = await chromePluginFixture();
      for (const running of [true, false]) {
        const calls: string[] = [];
        const recovery = new FirstPartyChromeSurfaceRecovery({
          codexHome: root,
          nodeExecutablePath: "node-for-test.exe",
          spawn: (_executable, args) => {
            const script = args[0] ?? "";
            calls.push(script);
            if (script.endsWith("chrome-is-running.js"))
              return completedChild(JSON.stringify({ running }));
            throw new Error("A running check must not diagnose, launch or focus Chrome");
          },
        });
        await expect(recovery.isExtensionHostRunning()).resolves.toBe(running);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.endsWith("chrome-is-running.js")).toBe(true);
      }
    },
  );

  it("rechecks repaired extension state on a later request without polling or duplicate windows", async () => {
    const root = await chromePluginFixture();
    let enabled = false;
    let now = 1_000;
    const calls: string[] = [];
    const recovery = new FirstPartyChromeSurfaceRecovery({
      codexHome: root,
      nodeExecutablePath: "node-for-test.exe",
      warmupMs: 0,
      nowUnixMs: () => now,
      inspectRunningProcesses: async () => [
        chromeProcess(
          '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --profile-directory=Default',
        ),
      ],
      spawn: (_executable, args) => {
        const script = args[0] ?? "";
        calls.push(script);
        if (script.endsWith("chrome-is-running.js"))
          return completedChild(JSON.stringify({ running: true }));
        if (script.endsWith("check-extension-installed.js"))
          return completedChild(
            JSON.stringify({
              ...enabledDefaultChromeExtension(),
              enabled,
              profiles: [{ profileDirectory: "Default", disableReasons: enabled ? [] : [1024] }],
            }),
            enabled ? 0 : 1,
          );
        if (script.endsWith("check-native-host-manifest.js"))
          return completedChild(JSON.stringify({ correct: true }));
        throw new Error("Diagnostic recovery must not create another Chrome window");
      },
    });
    const request = { operation: "documentation" as const, surface: "chrome" as const };
    await expect(recovery.recoverUnavailableSurface(request)).rejects.toThrow(
      "CHROME_EXTENSION_CORRUPTED",
    );
    expect(calls).toHaveLength(2);
    now += 30_000;
    expect(calls).toHaveLength(2);
    const retries = await Promise.allSettled(
      Array.from({ length: 8 }, () => recovery.recoverUnavailableSurface(request)),
    );
    expect(retries.every((result) => result.status === "rejected")).toBe(true);
    expect(calls).toHaveLength(4);
    enabled = true;
    now += 30_000;
    await expect(recovery.recoverUnavailableSurface(request)).rejects.toThrow(
      "CHROME_EXTENSION_CORRUPTED",
    );
    expect(calls).toHaveLength(4);
    now += 30_000;
    await expect(recovery.recoverUnavailableSurface(request)).resolves.toBeUndefined();
    expect(calls).toHaveLength(7);
  });
  it("forgets an old diagnosis after the native surface becomes available", async () => {
    const root = await chromePluginFixture();
    let enabled = false;
    const calls: string[] = [];
    const recovery = new FirstPartyChromeSurfaceRecovery({
      codexHome: root,
      nodeExecutablePath: "node-for-test.exe",
      warmupMs: 0,
      inspectRunningProcesses: async () => [
        chromeProcess(
          '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --profile-directory=Default',
        ),
      ],
      spawn: (_executable, args) => {
        const script = args[0] ?? "";
        calls.push(script);
        if (script.endsWith("chrome-is-running.js"))
          return completedChild(JSON.stringify({ running: true }));
        if (script.endsWith("check-extension-installed.js"))
          return completedChild(
            JSON.stringify({
              ...enabledDefaultChromeExtension(),
              enabled,
              profiles: [{ profileDirectory: "Default", disableReasons: enabled ? [] : [1024] }],
            }),
            enabled ? 0 : 1,
          );
        if (script.endsWith("check-native-host-manifest.js"))
          return completedChild(JSON.stringify({ correct: true }));
        throw new Error("A running recovered profile must not open another window");
      },
    });
    const request = { operation: "documentation" as const, surface: "chrome" as const };
    await expect(recovery.recoverUnavailableSurface(request)).rejects.toThrow(
      "CHROME_EXTENSION_CORRUPTED",
    );
    expect(calls).toHaveLength(2);

    enabled = true;
    recovery.noteSurfaceAvailable(request);
    expect(calls).toHaveLength(2);
    await expect(recovery.recoverUnavailableSurface(request)).resolves.toBeUndefined();
    expect(calls).toHaveLength(5);
  });

  it.each([
    { code: 1, installed: true, reasons: [1024], expected: "CHROME_EXTENSION_CORRUPTED" },
    { code: 1, installed: true, reasons: [1], expected: "CHROME_EXTENSION_REINSTALL_REQUIRED" },
    { code: 2, installed: false, reasons: [], expected: "CHROME_EXTENSION_REINSTALL_REQUIRED" },
  ])(
    "preserves the official extension diagnosis on exit $code ($expected)",
    async ({ code, installed, reasons, expected }) => {
      const root = await chromePluginFixture();
      const calls: string[] = [];
      const recovery = new FirstPartyChromeSurfaceRecovery({
        codexHome: root,
        nodeExecutablePath: "node-for-test.exe",
        warmupMs: 0,
        spawn: (_executable, args) => {
          const script = args[0] ?? "";
          calls.push(script);
          if (script.endsWith("chrome-is-running.js"))
            return completedChild(JSON.stringify({ running: true }));
          if (script.endsWith("check-extension-installed.js"))
            return completedChild(
              JSON.stringify({
                ...enabledDefaultChromeExtension(),
                installed,
                enabled: false,
                profiles: [{ profileDirectory: "Default", disableReasons: reasons }],
              }),
              code,
            );
          throw new Error("A disabled extension must not launch or reconfigure Chrome");
        },
      });
      await expect(
        recovery.recoverUnavailableSurface({ operation: "documentation", surface: "chrome" }),
      ).rejects.toThrow(expected);
      await expect(
        recovery.recoverUnavailableSurface({ operation: "documentation", surface: "chrome" }),
      ).rejects.toThrow(expected);
      expect(calls).toHaveLength(2);
    },
  );

  it("uses an explicitly selected profile for diagnostics and launches it once per outage", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-chrome-recovery-"));
    const { preferencesPath, userDataDirectory } = await setPreferredChromeProfile(root);
    vi.stubEnv("CODEX_CHROMIUM_PREFERENCES_PATH", preferencesPath);
    const scripts = join(root, "plugins", "cache", "openai-bundled", "chrome", "1.0.0", "scripts");
    await mkdir(scripts, { recursive: true });
    for (const name of [
      "chrome-is-running.js",
      "check-extension-installed.js",
      "check-native-host-manifest.js",
      "open-chrome-window.js",
    ]) {
      await writeFile(join(scripts, name), "// selected installed helper", "utf8");
    }

    const calls: Array<{
      executable: string;
      args: readonly string[];
      options: HiddenSpawnOptions | undefined;
    }> = [];
    const spawn = vi.fn(
      (executable: string, args: readonly string[], options?: HiddenSpawnOptions) => {
        calls.push({ executable, args, options });
        if (executable === "node-for-test.exe") {
          if (args[0]?.endsWith("chrome-is-running.js")) {
            return completedChild(JSON.stringify({ running: false }));
          }
          if (args[0]?.endsWith("check-extension-installed.js")) {
            return completedChild(JSON.stringify(enabledDefaultChromeExtension(userDataDirectory)));
          }
          if (args[0]?.endsWith("check-native-host-manifest.js")) {
            return completedChild(JSON.stringify({ correct: true }));
          }
          return completedChild(
            JSON.stringify({
              browserFamily: "chrome",
              browserName: "Google Chrome",
              platform: "win32",
              dryRun: true,
              profileDirectory: "Default",
              command: "cmd.exe",
              args: [
                "/d",
                "/s",
                "/c",
                "start",
                '""',
                "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
                "--profile-directory=Default",
                "--new-window",
                "about:blank",
              ],
            }),
          );
        }
        return spawnedChild();
      },
    );
    const recovery = new FirstPartyChromeSurfaceRecovery({
      codexHome: root,
      nodeExecutablePath: "node-for-test.exe",
      spawn,
      warmupMs: 0,
    });
    const request = { operation: "documentation" as const, surface: "chrome" as const };

    await recovery.recoverUnavailableSurface(request);
    await recovery.recoverUnavailableSurface(request);

    expect(calls).toHaveLength(5);
    expect(calls[0]?.executable).toBe("node-for-test.exe");
    expect(calls[0]?.args).toEqual([
      join(scripts, "chrome-is-running.js"),
      "--browser",
      "chrome",
      "--json",
    ]);
    const preloadOption = calls[0]?.options?.env?.NODE_OPTIONS?.split(" ").find((value) =>
      value.startsWith("--import=data:text/javascript,"),
    );
    expect(preloadOption).toBeDefined();
    if (preloadOption === undefined) throw new Error("Missing diagnostic child-process preload");
    const preload = decodeURIComponent(
      preloadOption.slice("--import=data:text/javascript,".length),
    );
    const nativeExec = vi.fn(
      (_file: string, _argv: readonly string[], _options: Record<string, unknown>) =>
        "unchanged diagnostic output",
    );
    const childProcess = { execFileSync: nativeExec };
    const syncExports = vi.fn();
    new Function("childProcess", "syncBuiltinESMExports", preload.replace(/^import .*;$/gm, ""))(
      childProcess,
      syncExports,
    );
    expect(
      childProcess.execFileSync("reg", ["query", "test"], {
        encoding: "utf8",
        windowsHide: false,
        shell: true,
      }),
    ).toBe("unchanged diagnostic output");
    expect(nativeExec).toHaveBeenCalledWith("reg", ["query", "test"], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    });
    expect(syncExports).toHaveBeenCalledOnce();
    expect(calls[1]?.options?.env?.CODEX_CHROMIUM_PREFERENCES_PATH).toBe(preferencesPath);
    expect(calls[3]?.options?.env?.CODEX_CHROMIUM_PREFERENCES_PATH).toBe(preferencesPath);
    expect(calls[4]).toMatchObject({
      executable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      args: [
        `--user-data-dir=${userDataDirectory}`,
        "--profile-directory=Default",
        "--new-window",
        "about:blank",
      ],
      options: { detached: true, stdio: "ignore" },
    });
    expect(calls.some((call) => call.executable.toLowerCase().endsWith("cmd.exe"))).toBe(false);

    recovery.noteSurfaceAvailable(request);
    await recovery.recoverUnavailableSurface(request);
    expect(calls).toHaveLength(10);
  });

  it("reconnects an already running profile without opening another Chrome window", async () => {
    const root = await chromePluginFixture();
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const spawn = vi.fn((executable: string, args: readonly string[]) => {
      calls.push({ executable, args });
      if (args[0]?.endsWith("chrome-is-running.js")) {
        return completedChild(JSON.stringify({ running: true }));
      }
      if (args[0]?.endsWith("check-extension-installed.js")) {
        return completedChild(JSON.stringify(enabledDefaultChromeExtension()));
      }
      if (args[0]?.endsWith("check-native-host-manifest.js")) {
        return completedChild(JSON.stringify({ correct: true }));
      }
      throw new Error(`unexpected process ${executable} ${args.join(" ")}`);
    });
    const recovery = new FirstPartyChromeSurfaceRecovery({
      codexHome: root,
      nodeExecutablePath: "node-for-test.exe",
      spawn,
      warmupMs: 0,
      inspectRunningProcesses: async () => [
        chromeProcess(
          '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --profile-directory=Default',
        ),
      ],
    });

    await recovery.recoverUnavailableSurface({ operation: "documentation", surface: "chrome" });

    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.executable === "node-for-test.exe")).toBe(true);
  });

  it("uses the official profile when no explicit selection is configured", async () => {
    vi.unstubAllEnvs();
    const root = await chromePluginFixture();
    const { userDataDirectory, preferencesPath } = await setPreferredChromeProfile(root);
    const spawn = vi.fn(
      (executable: string, args: readonly string[], options?: HiddenSpawnOptions) => {
        if (args[0]?.endsWith("chrome-is-running.js"))
          return completedChild(JSON.stringify({ running: false }));
        if (args[0]?.endsWith("check-extension-installed.js"))
          return completedChild(JSON.stringify(enabledDefaultChromeExtension(userDataDirectory)));
        if (args[0]?.endsWith("check-native-host-manifest.js"))
          return completedChild(JSON.stringify({ correct: true }));
        if (args[0]?.endsWith("open-chrome-window.js")) {
          expect(options?.env?.CODEX_CHROMIUM_PREFERENCES_PATH).toBe(preferencesPath);
          return completedChild(
            JSON.stringify({
              browserFamily: "chrome",
              dryRun: true,
              profileDirectory: "Default",
              command: "cmd.exe",
              args: [
                "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
                "--profile-directory=Default",
              ],
            }),
          );
        }
        if (executable.toLowerCase().endsWith("chrome.exe")) return spawnedChild();
        throw new Error(`unexpected process ${executable}`);
      },
    );
    const recovery = new FirstPartyChromeSurfaceRecovery({ codexHome: root, spawn, warmupMs: 0 });
    await expect(
      recovery.recoverUnavailableSurface({ operation: "documentation", surface: "chrome" }),
    ).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(5);
  });

  it.each(["", "--profile-directory=Profile 17"])(
    "reconnects an existing interactive Chrome without choosing last_used (%s)",
    async (argument) => {
      vi.unstubAllEnvs();
      const root = await chromePluginFixture();
      const spawn = vi.fn((_executable: string, args: readonly string[]) => {
        if (args[0]?.endsWith("chrome-is-running.js"))
          return completedChild(JSON.stringify({ running: true }));
        throw new Error("reconnection must not open or diagnose another profile");
      });
      const recovery = new FirstPartyChromeSurfaceRecovery({
        codexHome: root,
        spawn,
        warmupMs: 0,
        inspectRunningProcesses: async () => [chromeProcess(`chrome.exe ${argument}`)],
      });
      await expect(
        recovery.recoverUnavailableSurface({ operation: "documentation", surface: "chrome" }),
      ).resolves.toBeUndefined();
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects a diagnostic that ignores the caller's selected profile", async () => {
    const root = await chromePluginFixture();
    const { userDataDirectory } = await setPreferredChromeProfile(root);
    const spawn = vi.fn((_executable: string, args: readonly string[]) => {
      if (args[0]?.endsWith("chrome-is-running.js"))
        return completedChild(JSON.stringify({ running: false }));
      if (args[0]?.endsWith("check-extension-installed.js"))
        return completedChild(
          JSON.stringify({
            ...enabledDefaultChromeExtension(userDataDirectory),
            selectedProfileDirectory: "Profile 17",
          }),
        );
      throw new Error("no other process should be launched");
    });
    const recovery = new FirstPartyChromeSurfaceRecovery({ codexHome: root, spawn, warmupMs: 0 });
    await expect(
      recovery.recoverUnavailableSurface({
        operation: "documentation",
        surface: "chrome",
        browserId: "profile:chrome:Alpha",
        chromeProfileName: "Alpha",
      }),
    ).rejects.toThrow("CHROME_PROFILE_MISMATCH");
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it("does not substitute another profile for an explicit preferences path", async () => {
    const root = await chromePluginFixture();
    const { userDataDirectory, preferencesPath } = await setPreferredChromeProfile(root);
    vi.stubEnv("CODEX_CHROMIUM_PREFERENCES_PATH", preferencesPath);
    const spawn = vi.fn((_executable: string, args: readonly string[]) => {
      if (args[0]?.endsWith("chrome-is-running.js"))
        return completedChild(JSON.stringify({ running: false }));
      if (args[0]?.endsWith("check-extension-installed.js"))
        return completedChild(
          JSON.stringify({
            ...enabledDefaultChromeExtension(userDataDirectory),
            selectedProfileDirectory: "Profile 2",
          }),
        );
      throw new Error("another profile must not be launched");
    });
    const recovery = new FirstPartyChromeSurfaceRecovery({ codexHome: root, spawn, warmupMs: 0 });
    await expect(
      recovery.recoverUnavailableSurface({ operation: "documentation", surface: "chrome" }),
    ).rejects.toThrow("CHROME_PROFILE_MISMATCH");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("keeps simultaneous selected profiles independent while coalescing the same profile", async () => {
    const root = await chromePluginFixture();
    const { userDataDirectory } = await setPreferredChromeProfile(root);
    const betaDirectory = join(userDataDirectory, "Profile 2");
    await mkdir(betaDirectory, { recursive: true });
    await writeFile(join(betaDirectory, "Preferences"), "{}", "utf8");
    await writeFile(
      join(userDataDirectory, "Local State"),
      JSON.stringify({
        profile: { info_cache: { Default: { name: "Alpha" }, "Profile 2": { name: "Beta" } } },
      }),
      "utf8",
    );
    const launches: string[] = [];
    const spawn = vi.fn(
      (executable: string, args: readonly string[], options?: HiddenSpawnOptions) => {
        if (args[0]?.endsWith("chrome-is-running.js"))
          return completedChild(JSON.stringify({ running: false }));
        const selected = options?.env?.CODEX_CHROMIUM_PREFERENCES_PATH?.includes("Profile 2")
          ? "Profile 2"
          : "Default";
        if (args[0]?.endsWith("check-extension-installed.js"))
          return completedChild(
            JSON.stringify({
              ...enabledDefaultChromeExtension(userDataDirectory),
              selectedProfileDirectory: selected,
            }),
          );
        if (args[0]?.endsWith("check-native-host-manifest.js"))
          return completedChild(JSON.stringify({ correct: true }));
        if (args[0]?.endsWith("open-chrome-window.js"))
          return completedChild(
            JSON.stringify({
              browserFamily: "chrome",
              dryRun: true,
              profileDirectory: selected,
              command: "cmd.exe",
              args: [
                "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
                `--profile-directory=${selected}`,
              ],
            }),
          );
        if (executable.toLowerCase().endsWith("chrome.exe")) {
          launches.push(args.find((arg) => arg.startsWith("--profile-directory=")) ?? "");
          return spawnedChild();
        }
        throw new Error(`unexpected process ${executable}`);
      },
    );
    const recovery = new FirstPartyChromeSurfaceRecovery({ codexHome: root, spawn, warmupMs: 0 });
    const alpha = {
      operation: "documentation" as const,
      surface: "chrome" as const,
      browserId: "profile:chrome:default",
      chromeProfileName: "Alpha",
      ownerBinding: "owner-a",
      workSessionBinding: "same-work",
    };
    const beta = {
      operation: "documentation" as const,
      surface: "chrome" as const,
      browserId: "profile:chrome:default",
      chromeProfileName: "Beta",
      ownerBinding: "owner-b",
      workSessionBinding: "same-work",
    };
    const sameAlpha = { ...alpha, browserId: "extension:alpha", workSessionBinding: "work-c" };
    await Promise.all(
      [alpha, alpha, beta, beta].map((request) => recovery.recoverUnavailableSurface(request)),
    );
    await recovery.recoverUnavailableSurface(sameAlpha);
    expect(launches.sort()).toEqual([
      "--profile-directory=Default",
      "--profile-directory=Profile 2",
    ]);
    recovery.noteSurfaceAvailable(sameAlpha);
    await recovery.recoverUnavailableSurface(sameAlpha);
    expect(launches.filter((arg) => arg === "--profile-directory=Default")).toHaveLength(2);
  });

  it("keeps native selection when two profiles have the same name", async () => {
    const root = await chromePluginFixture();
    const { userDataDirectory } = await setPreferredChromeProfile(root);
    const other = join(userDataDirectory, "Profile 2");
    await mkdir(other, { recursive: true });
    await writeFile(join(other, "Preferences"), "{}", "utf8");
    await writeFile(
      join(userDataDirectory, "Local State"),
      JSON.stringify({
        profile: { info_cache: { Default: { name: "Alpha" }, "Profile 2": { name: "Alpha" } } },
      }),
      "utf8",
    );
    const spawn = vi.fn((_executable: string, args: readonly string[]) => {
      if (args[0]?.endsWith("chrome-is-running.js"))
        return completedChild(JSON.stringify({ running: false }));
      if (args[0]?.endsWith("check-extension-installed.js"))
        return completedChild(JSON.stringify(enabledDefaultChromeExtension(userDataDirectory)));
      throw new Error("an ambiguous name must not open another profile");
    });
    const recovery = new FirstPartyChromeSurfaceRecovery({ codexHome: root, spawn, warmupMs: 0 });
    await expect(
      recovery.recoverUnavailableSurface({
        operation: "documentation",
        surface: "chrome",
        browserId: "extension:alpha",
        chromeProfileName: "Alpha",
      }),
    ).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it.each(["cancel", "deadline"])(
    "does not launch Chrome after the last waiter %s",
    async (ending) => {
      const root = await chromePluginFixture();
      const { userDataDirectory, preferencesPath } = await setPreferredChromeProfile(root);
      vi.stubEnv("CODEX_CHROMIUM_PREFERENCES_PATH", preferencesPath);
      const planChild = fakeChild();
      let signalPlanStarted: (() => void) | undefined;
      const planStarted = new Promise<void>((resolve) => {
        signalPlanStarted = resolve;
      });
      let launchCount = 0;
      let planCount = 0;
      const plan = JSON.stringify({
        browserFamily: "chrome",
        dryRun: true,
        profileDirectory: "Default",
        command: "cmd.exe",
        args: [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "--profile-directory=Default",
        ],
      });
      const spawn = vi.fn((executable: string, args: readonly string[]) => {
        if (args[0]?.endsWith("chrome-is-running.js"))
          return completedChild(JSON.stringify({ running: false }));
        if (args[0]?.endsWith("check-extension-installed.js"))
          return completedChild(JSON.stringify(enabledDefaultChromeExtension(userDataDirectory)));
        if (args[0]?.endsWith("check-native-host-manifest.js"))
          return completedChild(JSON.stringify({ correct: true }));
        if (args[0]?.endsWith("open-chrome-window.js")) {
          planCount += 1;
          if (planCount === 1) {
            signalPlanStarted?.();
            return planChild;
          }
          return completedChild(plan);
        }
        if (executable.toLowerCase().endsWith("chrome.exe")) {
          launchCount += 1;
          return spawnedChild();
        }
        throw new Error(`unexpected process ${executable}`);
      });
      const recovery = new FirstPartyChromeSurfaceRecovery({ codexHome: root, spawn, warmupMs: 0 });
      const request = { operation: "list_tabs" as const, surface: "chrome" as const };
      const controller = new AbortController();
      const signal = ending === "deadline" ? AbortSignal.timeout(400) : controller.signal;
      const cancelled = recovery.recoverUnavailableSurface(request, signal);
      await planStarted;
      if (ending === "cancel") {
        controller.abort(new Error("caller cancelled"));
        await expect(cancelled).rejects.toThrow("caller cancelled");
      } else {
        await expect(cancelled).rejects.toMatchObject({ name: "TimeoutError" });
      }
      (planChild.stdout as PassThrough).end(plan);
      (planChild.stderr as PassThrough).end();
      planChild.emit("close", 0, null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(launchCount).toBe(0);
      await expect(recovery.recoverUnavailableSurface(request)).resolves.toBeUndefined();
      expect(launchCount).toBe(1);
    },
  );

  it("continues a shared recovery when another waiter remains", async () => {
    const root = await chromePluginFixture();
    const { userDataDirectory, preferencesPath } = await setPreferredChromeProfile(root);
    vi.stubEnv("CODEX_CHROMIUM_PREFERENCES_PATH", preferencesPath);
    const planChild = fakeChild();
    let signalPlanStarted: (() => void) | undefined;
    const planStarted = new Promise<void>((resolve) => {
      signalPlanStarted = resolve;
    });
    let launchCount = 0;
    const spawn = vi.fn((executable: string, args: readonly string[]) => {
      if (args[0]?.endsWith("chrome-is-running.js"))
        return completedChild(JSON.stringify({ running: false }));
      if (args[0]?.endsWith("check-extension-installed.js"))
        return completedChild(JSON.stringify(enabledDefaultChromeExtension(userDataDirectory)));
      if (args[0]?.endsWith("check-native-host-manifest.js"))
        return completedChild(JSON.stringify({ correct: true }));
      if (args[0]?.endsWith("open-chrome-window.js")) {
        signalPlanStarted?.();
        return planChild;
      }
      if (executable.toLowerCase().endsWith("chrome.exe")) {
        launchCount += 1;
        return spawnedChild();
      }
      throw new Error(`unexpected process ${executable}`);
    });
    const recovery = new FirstPartyChromeSurfaceRecovery({ codexHome: root, spawn, warmupMs: 0 });
    const request = { operation: "list_tabs" as const, surface: "chrome" as const };
    const firstController = new AbortController();
    const cancelled = recovery.recoverUnavailableSurface(request, firstController.signal);
    const surviving = recovery.recoverUnavailableSurface(request);
    await planStarted;
    firstController.abort(new Error("first waiter cancelled"));
    await expect(cancelled).rejects.toThrow("first waiter cancelled");
    const plan = JSON.stringify({
      browserFamily: "chrome",
      dryRun: true,
      profileDirectory: "Default",
      command: "cmd.exe",
      args: [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "--profile-directory=Default",
      ],
    });
    (planChild.stdout as PassThrough).end(plan);
    (planChild.stderr as PassThrough).end();
    planChild.emit("close", 0, null);
    await expect(surviving).resolves.toBeUndefined();
    expect(launchCount).toBe(1);
  });

  it("rejects a launch plan that switches away from the configured profile", async () => {
    const root = await chromePluginFixture();
    const { userDataDirectory, preferencesPath } = await setPreferredChromeProfile(root);
    vi.stubEnv("CODEX_CHROMIUM_PREFERENCES_PATH", preferencesPath);
    const spawn = vi.fn((_executable: string, args: readonly string[]) => {
      if (args[0]?.endsWith("chrome-is-running.js"))
        return completedChild(JSON.stringify({ running: false }));
      if (args[0]?.endsWith("check-extension-installed.js"))
        return completedChild(JSON.stringify(enabledDefaultChromeExtension(userDataDirectory)));
      if (args[0]?.endsWith("check-native-host-manifest.js"))
        return completedChild(JSON.stringify({ correct: true }));
      if (args[0]?.endsWith("open-chrome-window.js"))
        return completedChild(
          JSON.stringify({
            browserFamily: "chrome",
            dryRun: true,
            profileDirectory: "Profile 17",
            command: "cmd.exe",
            args: [
              "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
              "--profile-directory=Profile 17",
            ],
          }),
        );
      throw new Error("Chrome must not be launched for a mismatched plan");
    });
    const recovery = new FirstPartyChromeSurfaceRecovery({ codexHome: root, spawn, warmupMs: 0 });
    await expect(
      recovery.recoverUnavailableSurface({ operation: "documentation", surface: "chrome" }),
    ).rejects.toThrow("CHROME_PROFILE_MISMATCH");
    expect(spawn).toHaveBeenCalledTimes(4);
  });

  it("rejects a launch plan containing a second profile switch", async () => {
    const root = await chromePluginFixture();
    const { userDataDirectory, preferencesPath } = await setPreferredChromeProfile(root);
    vi.stubEnv("CODEX_CHROMIUM_PREFERENCES_PATH", preferencesPath);
    const spawn = vi.fn((_executable: string, args: readonly string[]) => {
      if (args[0]?.endsWith("chrome-is-running.js"))
        return completedChild(JSON.stringify({ running: false }));
      if (args[0]?.endsWith("check-extension-installed.js"))
        return completedChild(JSON.stringify(enabledDefaultChromeExtension(userDataDirectory)));
      if (args[0]?.endsWith("check-native-host-manifest.js"))
        return completedChild(JSON.stringify({ correct: true }));
      if (args[0]?.endsWith("open-chrome-window.js"))
        return completedChild(
          JSON.stringify({
            browserFamily: "chrome",
            dryRun: true,
            profileDirectory: "Default",
            command: "cmd.exe",
            args: [
              "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
              "--profile-directory=Default",
              "--profile-directory=Profile 17",
            ],
          }),
        );
      throw new Error("Chrome must not be launched for a mismatched plan");
    });
    const recovery = new FirstPartyChromeSurfaceRecovery({ codexHome: root, spawn, warmupMs: 0 });
    await expect(
      recovery.recoverUnavailableSurface({ operation: "documentation", surface: "chrome" }),
    ).rejects.toThrow("Installed Chrome helper did not bind the selected profile");
    expect(spawn).toHaveBeenCalledTimes(4);
  });

  it("does not mistake an agbrowse headless profile for the selected user Chrome profile", async () => {
    const root = await chromePluginFixture();
    const { userDataDirectory } = await setPreferredChromeProfile(root);
    vi.unstubAllEnvs();
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const spawn = vi.fn((executable: string, args: readonly string[]) => {
      calls.push({ executable, args });
      if (executable === "node-for-test.exe") {
        if (args[0]?.endsWith("chrome-is-running.js")) {
          return completedChild(JSON.stringify({ running: true }));
        }
        if (args[0]?.endsWith("check-extension-installed.js")) {
          return completedChild(JSON.stringify(enabledDefaultChromeExtension(userDataDirectory)));
        }
        if (args[0]?.endsWith("check-native-host-manifest.js")) {
          return completedChild(JSON.stringify({ correct: true }));
        }
        return completedChild(
          JSON.stringify({
            browserFamily: "chrome",
            browserName: "Google Chrome",
            platform: "win32",
            dryRun: true,
            profileDirectory: "Default",
            command: "cmd.exe",
            args: [
              "/d",
              "/s",
              "/c",
              "start",
              '""',
              "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
              "--profile-directory=Default",
              "--new-window",
              "about:blank",
            ],
          }),
        );
      }
      return spawnedChild();
    });
    const recovery = new FirstPartyChromeSurfaceRecovery({
      codexHome: root,
      nodeExecutablePath: "node-for-test.exe",
      spawn,
      warmupMs: 0,
      inspectRunningProcesses: async () => [
        chromeProcess(
          '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --headless=new --user-data-dir=C:\\Users\\ExampleUser\\.browser-agent\\browser-profile about:blank',
        ),
      ],
    });

    await recovery.recoverUnavailableSurface({ operation: "documentation", surface: "chrome" });

    expect(calls).toHaveLength(5);
    expect(calls[4]).toMatchObject({
      executable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      args: [
        `--user-data-dir=${userDataDirectory}`,
        "--profile-directory=Default",
        "--new-window",
        "about:blank",
      ],
    });
  });

  it("reports a broken Native Messaging installation without opening Chrome", async () => {
    const root = await chromePluginFixture();
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const spawn = vi.fn((executable: string, args: readonly string[]) => {
      calls.push({ executable, args });
      if (args[0]?.endsWith("chrome-is-running.js")) {
        return completedChild(JSON.stringify({ running: true }));
      }
      if (args[0]?.endsWith("check-extension-installed.js")) {
        return completedChild(JSON.stringify(enabledDefaultChromeExtension()));
      }
      if (args[0]?.endsWith("check-native-host-manifest.js")) {
        return completedChild(
          JSON.stringify({ correct: false, problem: "native host registration is missing" }),
          1,
        );
      }
      throw new Error(`unexpected process ${executable} ${args.join(" ")}`);
    });
    const recovery = new FirstPartyChromeSurfaceRecovery({
      codexHome: root,
      nodeExecutablePath: "node-for-test.exe",
      spawn,
      warmupMs: 0,
    });

    await expect(
      recovery.recoverUnavailableSurface({ operation: "documentation", surface: "chrome" }),
    ).rejects.toThrow(
      "CHROME_NATIVE_HOST_REGISTRATION_REQUIRED: native host registration is missing",
    );
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.executable === "node-for-test.exe")).toBe(true);
  });

  it("accepts a localized reg.exe default-value label when the bundled diagnostic misparses it", async () => {
    const root = await chromePluginFixture();
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const manifestPath =
      "C:\\Users\\ExampleUser\\AppData\\Local\\OpenAI\\extension\\com.openai.codexextension.json";
    const registryKey =
      "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.openai.codexextension";
    const spawn = vi.fn((executable: string, args: readonly string[]) => {
      calls.push({ executable, args });
      if (args[0]?.endsWith("chrome-is-running.js")) {
        return completedChild(JSON.stringify({ running: true }));
      }
      if (args[0]?.endsWith("check-extension-installed.js")) {
        return completedChild(JSON.stringify(enabledDefaultChromeExtension()));
      }
      if (args[0]?.endsWith("check-native-host-manifest.js")) {
        return completedChild(
          JSON.stringify({
            correct: false,
            exists: true,
            manifestPath,
            registryKey,
            problem: `Windows native host registry key does not exist: ${registryKey}`,
          }),
          1,
        );
      }
      if (executable === "reg.exe") {
        return completedChild(
          `HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.openai.codexextension\r\n    (�⺻��)    REG_SZ    ${manifestPath}\r\n`,
        );
      }
      throw new Error(`unexpected process ${executable} ${args.join(" ")}`);
    });
    const recovery = new FirstPartyChromeSurfaceRecovery({
      codexHome: root,
      nodeExecutablePath: "node-for-test.exe",
      spawn,
      warmupMs: 0,
      inspectRunningProcesses: async () => [
        chromeProcess(
          '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --profile-directory=Default',
        ),
      ],
    });

    await recovery.recoverUnavailableSurface({ operation: "documentation", surface: "chrome" });

    expect(calls).toHaveLength(4);
    expect(calls[3]).toEqual({ executable: "reg.exe", args: ["query", registryKey, "/ve"] });
  });

  it.runIf(process.platform === "win32")(
    "launches the selected profile from a localized Windows App Paths value",
    async () => {
      const root = await chromePluginFixture();
      const { userDataDirectory, preferencesPath } = await setPreferredChromeProfile(root);
      vi.stubEnv("CODEX_CHROMIUM_PREFERENCES_PATH", preferencesPath);
      const chromePath = join(root, "chrome.exe");
      await writeFile(chromePath, "test executable fixture");
      const calls: Array<{ executable: string; args: readonly string[] }> = [];
      const spawn = vi.fn((executable: string, args: readonly string[]) => {
        calls.push({ executable, args });
        if (args[0]?.endsWith("chrome-is-running.js"))
          return completedChild(JSON.stringify({ running: false }));
        if (args[0]?.endsWith("check-extension-installed.js"))
          return completedChild(JSON.stringify(enabledDefaultChromeExtension(userDataDirectory)));
        if (args[0]?.endsWith("check-native-host-manifest.js"))
          return completedChild(JSON.stringify({ correct: true }));
        if (args[0]?.endsWith("open-chrome-window.js"))
          return completedChild("Could not find the Google Chrome executable.", 2);
        if (executable === "reg.exe")
          return args[1]?.startsWith("HKLM\\")
            ? completedChild(`(기본값)    REG_SZ    ${chromePath}\r\n`)
            : completedChild("", 1);
        if (executable === chromePath) return spawnedChild();
        throw new Error(`unexpected process ${executable}`);
      });
      const recovery = new FirstPartyChromeSurfaceRecovery({
        codexHome: root,
        nodeExecutablePath: "node-for-test.exe",
        spawn,
        warmupMs: 0,
      });

      await recovery.recoverUnavailableSurface({ operation: "list_user_tabs", surface: "chrome" });

      expect(calls.at(-1)).toEqual({
        executable: chromePath,
        args: [
          `--user-data-dir=${userDataDirectory}`,
          "--profile-directory=Default",
          "--new-window",
          "about:blank",
        ],
      });
      expect(calls.some((call) => call.executable === "cmd.exe")).toBe(false);
    },
  );
});

function enabledDefaultChromeExtension(
  userDataDirectory = "C:\\Users\\ExampleUser\\AppData\\Local\\Google\\Chrome\\User Data",
): Record<string, unknown> {
  return {
    installed: true,
    enabled: true,
    userDataDirectory,
    selectedProfileDirectory: "Default",
  };
}

async function setPreferredChromeProfile(root: string): Promise<{
  preferencesPath: string;
  userDataDirectory: string;
}> {
  const userDataDirectory = join(root, "Chrome User Data");
  const profileDirectory = join(userDataDirectory, "Default");
  const preferencesPath = join(profileDirectory, "Preferences");
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(preferencesPath, "{}", "utf8");
  await writeFile(
    join(userDataDirectory, "Local State"),
    JSON.stringify({
      profile: { info_cache: { Default: { name: "Alpha" } } },
    }),
    "utf8",
  );
  return { preferencesPath, userDataDirectory };
}

function chromeProcess(commandLine: string): {
  readonly pid: number;
  readonly parentPid: number;
  readonly name: string;
  readonly executablePath: string;
  readonly commandLine: string;
  readonly startedAtIso: string;
} {
  return {
    pid: 42,
    parentPid: 1,
    name: "chrome.exe",
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    commandLine,
    startedAtIso: "2026-09-04T00:00:00.000Z",
  };
}

async function chromePluginFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omnicodex-chrome-recovery-"));
  const scripts = join(root, "plugins", "cache", "openai-bundled", "chrome", "1.0.0", "scripts");
  await mkdir(scripts, { recursive: true });
  for (const name of [
    "chrome-is-running.js",
    "check-extension-installed.js",
    "check-native-host-manifest.js",
    "open-chrome-window.js",
  ]) {
    await writeFile(join(scripts, name), "// selected installed helper", "utf8");
  }
  return root;
}

function completedChild(stdoutText: string, code = 0): OwnedHiddenChildProcess {
  const child = fakeChild();
  queueMicrotask(() => {
    const stdout = child.stdout as PassThrough;
    const stderr = child.stderr as PassThrough;
    stdout.write(stdoutText);
    stdout.end();
    stderr.end();
    child.emit("close", code, null);
  });
  return child;
}

function spawnedChild(): OwnedHiddenChildProcess {
  const child = fakeChild();
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

function fakeChild(): OwnedHiddenChildProcess {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = null;
  child.stdio = [null, child.stdout, child.stderr, null, null];
  child.connected = false;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.pid = 42;
  child.spawnargs = [];
  child.spawnfile = "";
  child.unref = vi.fn();
  child.ref = vi.fn();
  child.disconnect = vi.fn();
  child.send = vi.fn();
  return child as unknown as OwnedHiddenChildProcess;
}
