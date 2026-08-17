import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OmniCodexOperationalLog } from "../src/infrastructure/operations/operational-log.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("OmniCodexOperationalLog", () => {
  it("stores only bounded operational metadata and reads the tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-log-"));
    temporaryDirectories.push(root);
    const log = new OmniCodexOperationalLog({ path: join(root, "operations.jsonl") });
    await log.append("daemon_starting", { runtimePath: "x".repeat(3_000), "invalid key": "drop" });
    await log.append("daemon_ready", { port: 8787 });
    const entries = await log.read(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: "daemon_ready", details: { port: 8787 } });
  });

  it("rotates an exact log path at the configured bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-log-"));
    temporaryDirectories.push(root);
    const path = join(root, "operations.jsonl");
    const log = new OmniCodexOperationalLog({ path, maxBytes: 1 });
    await log.append("daemon_starting");
    await log.append("daemon_ready");
    await expect(log.read()).resolves.toMatchObject([{ event: "daemon_ready" }]);
  });
});
