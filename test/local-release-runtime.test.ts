import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalReleasePointer,
  LocalReleaseStateSnapshots,
} from "../src/infrastructure/release/local-release-runtime.js";
import { computeReleasePackageDigest } from "../src/infrastructure/release/npm-release-source.js";
import { StableReleaseLauncher } from "../src/infrastructure/release/stable-release-launcher.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("local release runtime adapters", () => {
  it("captures, integrity-checks, and restores config plus secret ciphertext", async () => {
    const data = await temporaryDirectory();
    await mkdir(join(data, "secrets"), { recursive: true });
    await Promise.all([
      writeFile(join(data, "config.json"), '{"schemaVersion":1,"value":"before"}\n', "utf8"),
      writeFile(join(data, "secrets", "token.bin"), "cipher-before", "utf8"),
    ]);
    const snapshots = new LocalReleaseStateSnapshots(data);
    const id = await snapshots.captureFor(staged("1.2.3", data));
    await Promise.all([
      writeFile(join(data, "config.json"), '{"schemaVersion":1,"value":"after"}\n', "utf8"),
      writeFile(join(data, "secrets", "token.bin"), "cipher-after", "utf8"),
    ]);
    await snapshots.restore(id);
    expect(await readFile(join(data, "config.json"), "utf8")).toContain("before");
    expect(await readFile(join(data, "secrets", "token.bin"), "utf8")).toBe("cipher-before");
  });

  it("switches a stable pointer, activates exact releases, and retains healthy history", async () => {
    const data = await temporaryDirectory();
    const oldRoot = await releaseFixture(data, "1.2.2");
    const nextRoot = await releaseFixture(data, "1.2.3");
    const launcher = new StableReleaseLauncher({ dataDirectory: data, nowUnixMs: () => 100 });
    await launcher.ensureBootstrap(join(oldRoot, "dist", "cli.js"), "1.2.2");
    const activated: string[] = [];
    const pointer = new LocalReleasePointer({
      dataDirectory: data,
      launcher,
      activate: async (active) => void activated.push(active.releasePath),
    });
    await pointer.markHealthy({ version: "1.2.2", releasePath: oldRoot, stateSnapshotId: "old" });
    await pointer.switchTo(nextRoot, "next", "old");
    const nextDigest = await computeReleasePackageDigest(nextRoot);
    await pointer.markHealthy({
      version: "1.2.3",
      releasePath: nextRoot,
      stateSnapshotId: "next",
      sourceCommit: "1".repeat(40),
      integrity: "sha512-Zml4dHVyZQ==",
      packageDigest: nextDigest,
    });
    expect(activated).toEqual([nextRoot]);
    await expect(pointer.current()).resolves.toMatchObject({ version: "1.2.3" });
    await expect(pointer.retainedHealthy()).resolves.toEqual([
      {
        version: "1.2.3",
        releasePath: nextRoot,
        stateSnapshotId: "next",
        sourceCommit: "1".repeat(40),
        integrity: "sha512-Zml4dHVyZQ==",
        packageDigest: nextDigest,
      },
      { version: "1.2.2", releasePath: oldRoot, stateSnapshotId: "old" },
    ]);
  });

  it("restores the previous stable pointer when candidate activation fails", async () => {
    const data = await temporaryDirectory();
    const oldRoot = await releaseFixture(data, "1.2.2");
    const nextRoot = await releaseFixture(data, "1.2.3");
    const launcher = new StableReleaseLauncher({ dataDirectory: data });
    await launcher.ensureBootstrap(join(oldRoot, "dist", "cli.js"), "1.2.2");
    const activations: string[] = [];
    const restoredSnapshots: string[] = [];
    const transactionEvents: string[] = [];
    const pointer = new LocalReleasePointer({
      dataDirectory: data,
      launcher,
      deactivate: async () => void transactionEvents.push("deactivate"),
      restoreState: async (snapshotId) => {
        restoredSnapshots.push(snapshotId);
        transactionEvents.push(`restore:${snapshotId}`);
      },
      activate: async (active) => {
        activations.push(active.releasePath);
        transactionEvents.push(`activate:${active.version}`);
        if (active.releasePath === nextRoot) throw new Error("candidate failed");
      },
    });
    await expect(pointer.switchTo(nextRoot, "next", "old")).rejects.toThrow("candidate failed");
    await expect(pointer.current()).resolves.toMatchObject({
      version: "1.2.2",
      releasePath: oldRoot,
    });
    expect(activations).toEqual([nextRoot, oldRoot]);
    expect(restoredSnapshots).toEqual(["next", "old"]);
    expect(transactionEvents).toEqual([
      "deactivate",
      "restore:next",
      "activate:1.2.3",
      "deactivate",
      "restore:old",
      "activate:1.2.2",
    ]);
  });

  it("refuses a retained release whose installed package bytes changed", async () => {
    const data = await temporaryDirectory();
    const oldRoot = await releaseFixture(data, "1.2.2");
    const nextRoot = await releaseFixture(data, "1.2.3");
    const launcher = new StableReleaseLauncher({ dataDirectory: data });
    await launcher.ensureBootstrap(join(oldRoot, "dist", "cli.js"), "1.2.2");
    await writeFile(join(nextRoot, "dist", "cli.js"), "// tampered", "utf8");
    const activations: string[] = [];
    const pointer = new LocalReleasePointer({
      dataDirectory: data,
      launcher,
      activate: async (active) => void activations.push(active.releasePath),
    });

    await expect(pointer.switchTo(nextRoot, "next", "old")).rejects.toThrow(
      "package files changed",
    );
    await expect(pointer.current()).resolves.toMatchObject({ releasePath: oldRoot });
    expect(activations).toEqual([]);
  });
});

function staged(version: string, releasePath: string) {
  return {
    version,
    releasePath,
    integrity: "sha512-Zml4dHVyZQ==",
    sourceCommit: "1".repeat(40),
    provenanceAvailable: true,
    sbomDigest: "a".repeat(64),
    packageDigest: "b".repeat(64),
  };
}

async function releaseFixture(data: string, version: string): Promise<string> {
  const root = join(data, "fixtures", version);
  await mkdir(join(root, "dist"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({ version }), "utf8"),
    writeFile(join(root, "dist", "cli.js"), "// cli", "utf8"),
    writeFile(join(root, "dist", "daemon.js"), "// daemon", "utf8"),
  ]);
  const packageDigest = await computeReleasePackageDigest(root);
  await writeFile(
    join(root, ".omnicodex-release.json"),
    JSON.stringify({
      schemaVersion: 3,
      sourceCommit: "1".repeat(40),
      integrity: "sha512-Zml4dHVyZQ==",
      packageDigest,
    }),
    "utf8",
  );
  return root;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-local-release-"));
  temporaryDirectories.push(directory);
  return directory;
}
