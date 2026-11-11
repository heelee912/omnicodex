import { describe, expect, it, vi } from "vitest";
import { DesktopAppServerLocator } from "../src/infrastructure/runtime/desktop-app-server-locator.js";
import type { RecoveredWindowsProcessIdentity } from "../src/infrastructure/windows/hidden-child-process.js";

const executablePath =
  "C:\\Users\\ExampleUser\\AppData\\Local\\OmniCodex\\engine-generations\\build\\package\\codex.exe";
const processIdentity: RecoveredWindowsProcessIdentity = {
  pid: 200,
  parentPid: 100,
  name: "codex.exe",
  executablePath,
  commandLine: `"${executablePath}" app-server --stdio`,
  startedAtIso: new Date(Date.now() - 5000).toISOString(),
};
const nonce = "e88ee61d-780e-48da-85a4-ae92f262f674";
const file = `desktop-app-server-${processIdentity.pid}-${nonce}.json`;
const record = {
  schemaVersion: 1,
  pid: processIdentity.pid,
  pipeName: `\\\\.\\pipe\\codex-app-server-${processIdentity.pid}-${nonce}`,
  executablePath,
  appServerVersion: "0.164.0-alpha.11.1",
  instanceNonce: nonce,
  startedAtUnixMs: Date.parse(processIdentity.startedAtIso) + 1000,
};

describe("DesktopAppServerLocator", () => {
  it("selects the live Desktop process record and rejects a stale PID reuse", async () => {
    const oldNonce = "00000000-0000-0000-0000-000000000001";
    const oldFile = `desktop-app-server-${processIdentity.pid}-${oldNonce}.json`;
    const readTextFile = vi.fn(async (path: string) =>
      JSON.stringify(
        path.endsWith(oldFile)
          ? {
              ...record,
              pipeName: `\\\\.\\pipe\\codex-app-server-${processIdentity.pid}-${oldNonce}`,
              instanceNonce: oldNonce,
              startedAtUnixMs: Date.parse(processIdentity.startedAtIso) - 1000,
            }
          : record,
      ),
    );
    const locator = new DesktopAppServerLocator({
      expectedExecutablePath: executablePath,
      codexHome: "C:\\Users\\ExampleUser\\.codex",
      readAppServerProcesses: async () => [processIdentity],
      readDirectory: async () => [oldFile, file],
      readTextFile,
    });

    expect(await locator.locate()).toEqual({
      transport: "named_pipe",
      pid: record.pid,
      pipeName: record.pipeName,
      executablePath,
      appServerVersion: record.appServerVersion,
      instanceNonce: nonce,
    });
    expect(readTextFile).toHaveBeenCalledTimes(2);
  });

  it("rejects a Desktop process running a different engine", async () => {
    const readDirectory = vi.fn(async () => [file]);
    const locator = new DesktopAppServerLocator({
      expectedExecutablePath: "C:\\Other\\codex.exe",
      readAppServerProcesses: async () => [processIdentity],
      readDirectory,
    });

    await expect(locator.locate()).rejects.toThrow("executable differs");
    expect(readDirectory).not.toHaveBeenCalled();
  });

  it("rejects the WebSocket route that lacks Desktop stdio verification", async () => {
    const locator = new DesktopAppServerLocator({
      expectedExecutablePath: executablePath,
      readAppServerProcesses: async () => [processIdentity],
      readDirectory: async () => [file],
      readTextFile: async () =>
        JSON.stringify({
          ...record,
          schemaVersion: 2,
          websocketUrl: "ws://127.0.0.1:25174",
        }),
    });
    await expect(locator.locate()).rejects.toThrow("was not published");
  });

  it("pins connections to the oldest live matching Desktop server", async () => {
    const laterProcess = {
      ...processIdentity,
      pid: 201,
      startedAtIso: new Date(Date.parse(processIdentity.startedAtIso) + 1000).toISOString(),
    };
    const laterNonce = "31a4f501-79a5-4f22-b88c-cfb764be99ae";
    const laterFile = `desktop-app-server-${laterProcess.pid}-${laterNonce}.json`;
    const locator = new DesktopAppServerLocator({
      expectedExecutablePath: executablePath,
      codexHome: "C:\\Users\\ExampleUser\\.codex",
      readAppServerProcesses: async () => [laterProcess, processIdentity],
      readDirectory: async () => [laterFile, file],
      readTextFile: async (path) =>
        JSON.stringify(
          path.endsWith(laterFile)
            ? {
                ...record,
                pid: laterProcess.pid,
                pipeName: `\\\\.\\pipe\\codex-app-server-${laterProcess.pid}-${laterNonce}`,
                instanceNonce: laterNonce,
                startedAtUnixMs: Date.parse(laterProcess.startedAtIso) + 1000,
              }
            : record,
        ),
    });

    expect(await locator.locate()).toMatchObject({
      pid: processIdentity.pid,
      instanceNonce: nonce,
    });
  });
});
