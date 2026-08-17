import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type HiddenCommandRunner,
  WindowsAutostartManager,
} from "../src/infrastructure/windows/windows-autostart-manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("WindowsAutostartManager", () => {
  it("creates a hidden WScript launcher and a limited ONLOGON task", async () => {
    const fixture = await makeFixture();
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const runner: HiddenCommandRunner = {
      run: async (executable, args) => {
        calls.push({ executable, args });
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const manager = new WindowsAutostartManager({ ...fixture, runner });

    await expect(manager.enable()).resolves.toMatchObject({ enabled: true });
    const launcher = await readFile(manager.launcherPath, "utf8");
    expect(launcher).toContain('CreateObject("WScript.Shell").Run');
    expect(launcher).toContain(", 0, False");
    expect(launcher).toContain('""start""');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(["/Create", "/SC", "ONLOGON", "/RL", "LIMITED", "/F"]),
    );
    expect(calls[0]?.args.join(" ")).toContain("wscript.exe");
  });

  it("queries and removes only the fixed OmniCodex task", async () => {
    const fixture = await makeFixture();
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const runner: HiddenCommandRunner = {
      run: async (_executable, args) => {
        mutableCalls.push([...args]);
        return { code: args[0] === "/Query" ? 0 : 1, stdout: "", stderr: "" };
      },
    };
    const manager = new WindowsAutostartManager({ ...fixture, runner });
    await expect(manager.status()).resolves.toMatchObject({ enabled: true });
    await expect(manager.disable()).resolves.toMatchObject({ enabled: false });
    expect(mutableCalls).toEqual([
      ["/Query", "/TN", "\\OmniCodex\\Gateway"],
      ["/Delete", "/TN", "\\OmniCodex\\Gateway", "/F"],
    ]);
  });
});

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "omnicodex-autostart-"));
  temporaryDirectories.push(root);
  const windowsDirectory = join(root, "Windows");
  const system32 = join(windowsDirectory, "System32");
  const nodeExecutable = join(root, "node.exe");
  const cliScript = join(root, "cli.js");
  await mkdir(system32, { recursive: true });
  await Promise.all(
    [nodeExecutable, cliScript, join(system32, "schtasks.exe"), join(system32, "wscript.exe")].map(
      (path) => writeFile(path, "", "utf8"),
    ),
  );
  return {
    nodeExecutable,
    cliScript,
    dataDirectory: join(root, "data"),
    windowsDirectory,
  };
}
