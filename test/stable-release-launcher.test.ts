import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StableReleaseLauncher } from "../src/infrastructure/release/stable-release-launcher.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("StableReleaseLauncher", () => {
  it("bootstraps one stable shell-free launcher and preserves an existing pointer", async () => {
    const root = await fixtureRelease("1.2.3");
    const dataDirectory = await temporaryDirectory();
    const launcher = new StableReleaseLauncher({ dataDirectory, nowUnixMs: () => 100 });
    const first = await launcher.ensureBootstrap(join(root, "dist", "cli.js"), "1.2.3");
    const second = await launcher.ensureBootstrap(join(root, "dist", "cli.js"), "1.2.4");

    expect(second.active).toEqual(first.active);
    const source = await readFile(first.launcherPath, "utf8");
    expect(source).toContain("hidden-child-process.js");
    expect(source).toContain("spawnHidden");
    expect(source).toContain("const attempts = 1");
    expect(source).toContain("const result = await runOnce()");
    expect(source).toContain("process.exit(result.code");
    expect(source).toContain('"autostart_succeeded" : "autostart_failed"');
    expect(source).toContain("pointerActivatedAtUnixMs");
    expect(source).toContain("OMNICODEX_AUTOSTART_SOURCE");
    expect(source).toContain("bootedAtUnixMs");
    expect(source).toContain('"scheduled-task", "manual-test"');
    expect(source).toContain("const requestedArgs = process.argv.slice(2)");
    expect(source).toContain("autostart-action-ledger-scheduled-task.jsonl");
    expect(source).toContain('"autostart-action-ledger-" + launchSource');
    expect(source).toContain('process.pid + "-" + Date.now()');
    expect(source).toContain("configureDefaultHiddenChildActionLedger(actionLedgerPath)");
    expect(source.indexOf("const launchSource")).toBeLessThan(
      source.indexOf("configureDefaultHiddenChildActionLedger(actionLedgerPath)"),
    );
    expect(source).not.toContain('"action-ledger-" + process.pid');
    expect(source).not.toContain("node:child_process");
    expect(source).not.toContain("retryDelaysMs");
    expect(source).toContain("appendFile(diagnosticPath");
    expect(source).not.toContain("writeFile(diagnosticPath");
    expect(source).not.toContain("START_TIMEOUT");
    expect(source).not.toContain("terminateOwnedHiddenChild");
    expect(source).not.toContain("delete childEnvironment.OMNICODEX_AUTOSTART_SOURCE");
    expect(source).not.toContain("cmd.exe");
    expect(source).not.toContain("powershell");
  });

  it("selects the requesting release for an explicit restart across working trees", async () => {
    const oldRoot = await fixtureRelease("1.2.2");
    const nextRoot = await fixtureRelease("1.2.3");
    const launcher = new StableReleaseLauncher({ dataDirectory: await temporaryDirectory() });
    const original = await launcher.ensureBootstrap(join(oldRoot, "dist", "cli.js"), "1.2.2");
    const passive = await launcher.ensureBootstrap(join(nextRoot, "dist", "cli.js"), "1.2.3");
    expect(passive.active).toEqual(original.active);
    const selected = await launcher.ensureBootstrap(join(nextRoot, "dist", "cli.js"), "1.2.3", {
      activateCurrent: true,
    });
    expect(selected.active).toMatchObject({
      releasePath: nextRoot,
      cliScript: join(nextRoot, "dist", "cli.js"),
      daemonScript: join(nextRoot, "dist", "daemon.js"),
      version: "1.2.3",
    });
    await expect(launcher.readActive()).resolves.toEqual(selected.active);
    await expect(
      launcher.ensureBootstrap(join(nextRoot, "missing", "cli.js"), "1.2.3", {
        activateCurrent: true,
      }),
    ).rejects.toThrow();
    await expect(launcher.readActive()).resolves.toEqual(selected.active);
  });

  it("atomically switches to a contained verified release and reads it back", async () => {
    const oldRoot = await fixtureRelease("1.2.2");
    const nextRoot = await fixtureRelease("1.2.3");
    const dataDirectory = await temporaryDirectory();
    let now = 100;
    const launcher = new StableReleaseLauncher({ dataDirectory, nowUnixMs: () => now });
    await launcher.ensureBootstrap(join(oldRoot, "dist", "cli.js"), "1.2.2");
    now = 200;
    const active = await launcher.switchActive({
      version: "1.2.3",
      releasePath: nextRoot,
      cliScript: join(nextRoot, "dist", "cli.js"),
      daemonScript: join(nextRoot, "dist", "daemon.js"),
      stateSnapshotId: "snapshot-123",
    });
    expect(active).toMatchObject({ version: "1.2.3", activatedAtUnixMs: 200 });
    await expect(launcher.readActive()).resolves.toEqual(active);
  });

  it("rejects release executables outside their declared release root", async () => {
    const root = await fixtureRelease("1.2.3");
    const outside = await fixtureRelease("9.9.9");
    const launcher = new StableReleaseLauncher({ dataDirectory: await temporaryDirectory() });
    await expect(
      launcher.switchActive({
        version: "1.2.3",
        releasePath: root,
        cliScript: join(outside, "dist", "cli.js"),
        daemonScript: join(root, "dist", "daemon.js"),
        stateSnapshotId: "snapshot-123",
      }),
    ).rejects.toThrow("escaped");
  });
});

async function fixtureRelease(version: string): Promise<string> {
  const root = await temporaryDirectory();
  await mkdir(join(root, "dist"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "dist", "cli.js"), `// ${version}\n`, "utf8"),
    writeFile(join(root, "dist", "daemon.js"), `// ${version}\n`, "utf8"),
  ]);
  return root;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-release-"));
  temporaryDirectories.push(directory);
  return directory;
}
