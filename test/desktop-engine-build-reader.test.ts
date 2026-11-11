import { describe, expect, it, vi } from "vitest";
import { DesktopEngineBuildReader } from "../src/infrastructure/windows/desktop-engine-build-reader.js";
import type { RecoveredWindowsProcessIdentity } from "../src/infrastructure/windows/hidden-child-process.js";

const desktop: RecoveredWindowsProcessIdentity = {
  pid: 100,
  parentPid: 1,
  name: "ChatGPT.exe",
  executablePath:
    "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe",
  commandLine:
    '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe"',
  startedAtIso: "2026-10-27T00:00:00.000Z",
};

const engine: RecoveredWindowsProcessIdentity = {
  pid: 200,
  parentPid: desktop.pid,
  name: "codex.exe",
  executablePath:
    "C:\\Users\\ExampleUser\\AppData\\Local\\OmniCodex\\engine-generations\\codex-build\\package\\codex.exe",
  commandLine:
    '"C:\\Users\\ExampleUser\\AppData\\Local\\OmniCodex\\engine-generations\\codex-build\\package\\codex.exe" app-server --listen stdio://',
  startedAtIso: "2026-10-27T00:00:01.000Z",
};

describe("DesktopEngineBuildReader", () => {
  it("reads the Desktop-owned app-server with one process snapshot", async () => {
    const inspect = vi.fn(async () => [desktop, engine]);
    const reader = new DesktopEngineBuildReader(inspect);
    expect(await reader.readExecutablePath()).toBe(engine.executablePath);
    expect(inspect).toHaveBeenCalledExactlyOnceWith([
      "ChatGPT.exe",
      "codex.exe",
      "OmniCodexDesktopEngine.exe",
      "node.exe",
    ]);
  });

  it("selects the newest Desktop engine while preserving every owned app server", async () => {
    const inspect = vi.fn(async () => [desktop, engine, { ...engine, pid: 201 }]);
    const reader = new DesktopEngineBuildReader(inspect);
    expect(await reader.readExecutablePath()).toBe(engine.executablePath);
    expect((await reader.readAppServerProcesses()).map((process) => process.pid)).toEqual([
      201, 200,
    ]);
    expect(await reader.readAppServerProcess()).toBeUndefined();
  });

  it("finds the stock engine behind the Desktop-owned OmniCodex bridge", async () => {
    const bridge = {
      ...engine,
      pid: 150,
      parentPid: desktop.pid,
      name: "OmniCodexDesktopEngine.exe",
      executablePath:
        "C:\\Users\\ExampleUser\\AppData\\Local\\OmniCodex\\bin\\OmniCodexDesktopEngine.exe",
      commandLine:
        '"C:\\Users\\ExampleUser\\AppData\\Local\\OmniCodex\\bin\\OmniCodexDesktopEngine.exe" app-server --listen stdio://',
    };
    const node = {
      ...bridge,
      pid: 175,
      parentPid: bridge.pid,
      name: "node.exe",
      commandLine:
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\ExampleUser\\AppData\\Local\\OmniCodex\\bin\\stock-app-server-stdio.mjs" app-server --listen stdio://',
    };
    const stock = { ...engine, parentPid: node.pid, pid: 201 };
    const reader = new DesktopEngineBuildReader(async () => [desktop, bridge, node, stock]);
    expect(await reader.readExecutablePath()).toBe(stock.executablePath);
  });
});
