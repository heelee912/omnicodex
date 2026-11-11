import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareDurableMcpEventDirectoryLayout } from "../src/infrastructure/mcp/durable-mcp-event-directory-layout.js";

describe("prepareDurableMcpEventDirectoryLayout", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("uses one authoritative directory for writes and restart replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-event-layout-"));
    roots.push(root);

    const layout = await prepareDurableMcpEventDirectoryLayout(root);
    const activeDirectory = join(root, "durable-mcp-events");
    expect(layout).toEqual({
      activeDirectory,
      replayDirectories: [activeDirectory],
    });
    expect(await readdir(root)).toEqual(["durable-mcp-events"]);

    await expect(prepareDurableMcpEventDirectoryLayout(root)).resolves.toEqual(layout);
    expect(await readdir(root)).toEqual(["durable-mcp-events"]);
  });
});
