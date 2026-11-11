import { describe, expect, it, vi } from "vitest";
import { EngineBuildFollower } from "../src/application/engine-build-follower.js";
import type { RuntimeCandidate, RuntimeDiscoveryReport } from "../src/domain/runtime.js";

const oldBuild: RuntimeCandidate = {
  executablePath: "C:\\Old\\codex.exe",
  canonicalPath: "C:\\Old\\codex.exe",
  source: "managed_install",
  buildSha256: "a".repeat(64),
};
const desktopBuild: RuntimeCandidate = {
  executablePath: "C:\\New\\codex.exe",
  canonicalPath: "C:\\New\\codex.exe",
  source: "managed_install",
  buildSha256: "b".repeat(64),
};
const report: RuntimeDiscoveryReport = {
  platform: "win32",
  candidates: [desktopBuild, oldBuild],
  warnings: [],
};

describe("EngineBuildFollower", () => {
  it("reports a newly installed engine while the gateway is still starting", async () => {
    const onRefreshOutcome = vi.fn();
    const follower = new EngineBuildFollower({
      readDesktopExecutablePath: async () => undefined,
      discover: async () => report,
      activeCandidate: () => undefined,
      switchRuntime: vi.fn(async () => undefined),
      refreshEngine: async () => ({
        status: "installed",
        activeExecutablePath: desktopBuild.executablePath,
        restartRequired: true,
      }),
      onRefreshOutcome,
    });
    expect(await follower.followOnce()).toBe(false);
    expect(onRefreshOutcome).toHaveBeenCalledExactlyOnceWith({
      status: "installed",
      activeExecutablePath: desktopBuild.executablePath,
      restartRequired: true,
    });
  });

  it("stages a new engine without restarting Desktop and follows its next natural start", async () => {
    let desktopPath = oldBuild.executablePath;
    const onRefreshOutcome = vi.fn();
    const switchRuntime = vi.fn(async () => undefined);
    const follower = new EngineBuildFollower({
      readDesktopExecutablePath: async () => desktopPath,
      discover: async () => report,
      activeCandidate: () => oldBuild,
      switchRuntime,
      refreshEngine: async () => ({
        status: "installed",
        activeExecutablePath: desktopBuild.executablePath,
        restartRequired: true,
      }),
      onRefreshOutcome,
    });
    expect(await follower.followOnce()).toBe(false);
    expect(await follower.followOnce()).toBe(false);
    expect(switchRuntime).not.toHaveBeenCalled();
    expect(onRefreshOutcome).toHaveBeenCalledTimes(2);
    expect(onRefreshOutcome).toHaveBeenNthCalledWith(2, {
      status: "staged",
      activeExecutablePath: desktopBuild.executablePath,
      restartRequired: true,
    });
    desktopPath = desktopBuild.executablePath;
    expect(await follower.followOnce()).toBe(true);
    expect(switchRuntime).toHaveBeenCalledExactlyOnceWith(desktopBuild.canonicalPath);
    expect(onRefreshOutcome).toHaveBeenCalledTimes(2);
  });

  it("keeps a staged engine when a later refresh is busy", async () => {
    let nowUnixMs = 0;
    let desktopPath = oldBuild.executablePath;
    const onRefreshOutcome = vi.fn();
    const switchRuntime = vi.fn(async () => undefined);
    const refreshEngine = vi
      .fn()
      .mockResolvedValueOnce({
        status: "installed",
        activeExecutablePath: desktopBuild.executablePath,
      })
      .mockResolvedValueOnce({ status: "busy" });
    const follower = new EngineBuildFollower({
      readDesktopExecutablePath: async () => desktopPath,
      discover: async () => report,
      activeCandidate: () => oldBuild,
      switchRuntime,
      refreshEngine,
      refreshIntervalMs: 1,
      nowUnixMs: () => nowUnixMs,
      onRefreshOutcome,
    });

    expect(await follower.followOnce()).toBe(false);
    nowUnixMs = 1;
    expect(await follower.followOnce()).toBe(false);
    expect(refreshEngine).toHaveBeenCalledTimes(2);
    expect(onRefreshOutcome).toHaveBeenCalledTimes(2);
    desktopPath = desktopBuild.executablePath;
    expect(await follower.followOnce()).toBe(true);
    expect(switchRuntime).toHaveBeenCalledExactlyOnceWith(desktopBuild.canonicalPath);
  });

  it("checks for a Desktop update even before the gateway has an active runtime", async () => {
    let nowUnixMs = 1_000;
    const refreshEngine = vi.fn(async () => undefined);
    const follower = new EngineBuildFollower({
      readDesktopExecutablePath: async () => undefined,
      discover: async () => report,
      activeCandidate: () => undefined,
      switchRuntime: vi.fn(async () => undefined),
      refreshEngine,
      refreshIntervalMs: 300_000,
      nowUnixMs: () => nowUnixMs,
    });
    expect(await follower.followOnce()).toBe(false);
    expect(await follower.followOnce()).toBe(false);
    expect(refreshEngine).toHaveBeenCalledTimes(1);
    nowUnixMs += 300_000;
    expect(await follower.followOnce()).toBe(false);
    expect(refreshEngine).toHaveBeenCalledTimes(2);
  });

  it("does not start a second refresh while the first one is running", async () => {
    let finishRefresh!: () => void;
    const refreshEngine = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          finishRefresh = () => resolve(undefined);
        }),
    );
    const follower = new EngineBuildFollower({
      readDesktopExecutablePath: async () => undefined,
      discover: async () => report,
      activeCandidate: () => undefined,
      switchRuntime: vi.fn(async () => undefined),
      refreshEngine,
    });
    const first = follower.followOnce();
    expect(await follower.followOnce()).toBe(false);
    expect(refreshEngine).toHaveBeenCalledTimes(1);
    follower.stop();
    finishRefresh();
    expect(await first).toBe(false);
  });

  it("switches only to the build currently owned by Codex Desktop", async () => {
    const switchRuntime = vi.fn(async () => undefined);
    let active = oldBuild;
    const follower = new EngineBuildFollower({
      readDesktopExecutablePath: async () => desktopBuild.executablePath,
      discover: async () => report,
      activeCandidate: () => active,
      switchRuntime,
    });
    expect(await follower.followOnce()).toBe(true);
    expect(switchRuntime).toHaveBeenCalledExactlyOnceWith(desktopBuild.canonicalPath);
    active = desktopBuild;
    expect(await follower.followOnce()).toBe(false);
    expect(switchRuntime).toHaveBeenCalledTimes(1);
  });

  it("switches when Desktop moves the same build to another executable path", async () => {
    const switchRuntime = vi.fn(async () => undefined);
    const sameBuildAtNewPath = { ...desktopBuild, buildSha256: oldBuild.buildSha256 };
    const follower = new EngineBuildFollower({
      readDesktopExecutablePath: async () => sameBuildAtNewPath.executablePath,
      discover: async () => ({ ...report, candidates: [sameBuildAtNewPath] }),
      activeCandidate: () => oldBuild,
      switchRuntime,
    });
    expect(await follower.followOnce()).toBe(true);
    expect(switchRuntime).toHaveBeenCalledExactlyOnceWith(sameBuildAtNewPath.canonicalPath);
  });

  it("does not switch when the desktop engine is absent or changed during discovery", async () => {
    const switchRuntime = vi.fn(async () => undefined);
    let active = oldBuild;
    let desktopPath: string | undefined;
    const follower = new EngineBuildFollower({
      readDesktopExecutablePath: async () => desktopPath,
      discover: async () => {
        active = desktopBuild;
        return report;
      },
      activeCandidate: () => active,
      switchRuntime,
    });
    expect(await follower.followOnce()).toBe(false);
    desktopPath = desktopBuild.executablePath;
    expect(await follower.followOnce()).toBe(false);
    expect(switchRuntime).not.toHaveBeenCalled();
  });

  it("reports a Desktop engine path that is missing from verified candidates", async () => {
    const onError = vi.fn();
    const switchRuntime = vi.fn(async () => undefined);
    const follower = new EngineBuildFollower({
      readDesktopExecutablePath: async () => "C:\\Unknown\\codex.exe",
      discover: async () => report,
      activeCandidate: () => oldBuild,
      switchRuntime,
      onError,
    });
    expect(await follower.followOnce()).toBe(false);
    expect(await follower.followOnce()).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0].message).toContain("absent from verified runtime candidates");
    expect(switchRuntime).not.toHaveBeenCalled();
  });
});
