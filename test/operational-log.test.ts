import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
  it("reads committed current-writer counters without reading logs or changing the snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-activity-"));
    temporaryDirectories.push(root);
    const path = join(root, "operations.jsonl");
    const log = new OmniCodexOperationalLog({ path, maxBytes: 1, compressArchivedSegments: false });
    expect(log.activity.events).toEqual({});
    await log.append("oracle_approval_requests_observed", {
      trigger: "queued_request",
      getCount: 2,
      postCount: 1,
      rateLimitCount: 0,
      moduleInitializationCount: 0,
      conversationIds: '["conversation-a"]',
    });
    await log.append("oracle_approval_requests_observed", {
      trigger: "recovery",
      getCount: 1,
      postCount: 0,
      rateLimitCount: 1,
      moduleInitializationCount: 0,
      conversationIds: '["conversation-b"]',
    });
    await log.append("oracle_remote_cdp_tunnel_ready", { attempt: 2, ownership: "owned" });
    const snapshot = log.activity;
    expect(snapshot).toMatchObject({
      scope: "current_log_writer",
      pid: process.pid,
      events: {
        oracle_approval_requests_observed: {
          count: 2,
          totals: { getCount: 3, postCount: 1, rateLimitCount: 1, moduleInitializationCount: 0 },
          lastDetails: { trigger: "recovery", conversationIds: '["conversation-b"]' },
        },
        oracle_remote_cdp_tunnel_ready: { count: 1, lastDetails: { attempt: 2 } },
      },
    });
    const last = snapshot.events.oracle_approval_requests_observed;
    if (last?.lastDetails === undefined) throw new Error("missing operation attribution");
    last.lastDetails.trigger = "caller-mutated-copy";
    expect(log.activity.events.oracle_approval_requests_observed?.lastDetails?.trigger).toBe(
      "recovery",
    );
    await rm(path);
    expect(log.activity.events.oracle_approval_requests_observed?.count).toBe(2);
    expect(new OmniCodexOperationalLog({ path }).activity.events).toEqual({});
  });

  it("does not count a failed log commit as an observed event", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-activity-failure-"));
    temporaryDirectories.push(root);
    const blocker = join(root, "not-a-directory");
    await writeFile(blocker, "block");
    const log = new OmniCodexOperationalLog({ path: join(blocker, "operations.jsonl") });
    await expect(log.append("oracle_action_catalog_refreshed")).rejects.toThrow();
    expect(log.activity.events).toEqual({});
  });

  it("persists durable receipt metadata across rotation and a new log reader", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-log-"));
    temporaryDirectories.push(root);
    const path = join(root, "operations.jsonl");
    const log = new OmniCodexOperationalLog({ path, maxBytes: 1, compressArchivedSegments: false });
    await log.append("daemon_starting");
    const details = {
      conversationIdSha256: "conversation",
      pendingMessageIdSha256: "pending",
      clientMessageIdSha256: "client",
      targetMessageIdSha256: "target",
      action: "allow",
      rememberAnswer: true,
      responseStatus: 200,
    };
    await log.append("oracle_approval_activated", details, { durable: true });
    const reopened = new OmniCodexOperationalLog({ path });
    await expect(reopened.read()).resolves.toMatchObject([
      { event: "daemon_starting" },
      { event: "oracle_approval_activated", details },
    ]);
  });

  it("preserves complete operational metadata and applies only an explicit tail limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-log-"));
    temporaryDirectories.push(root);
    const log = new OmniCodexOperationalLog({ path: join(root, "operations.jsonl") });
    await log.append("daemon_starting", { runtimePath: "x".repeat(3_000), "invalid key": "drop" });
    await log.append("daemon_ready", { port: 8787 });
    const complete = await log.read();
    const entries = await log.read(1);
    expect(complete).toHaveLength(2);
    expect(complete[0]?.details).toEqual({
      runtimePath: "x".repeat(3_000),
      "invalid key": "drop",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: "daemon_ready", details: { port: 8787 } });
  });

  it("rotates an exact log path without discarding earlier segments", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-log-"));
    temporaryDirectories.push(root);
    const path = join(root, "operations.jsonl");
    const log = new OmniCodexOperationalLog({
      path,
      maxBytes: 1,
      compressArchivedSegments: false,
    });
    await log.append("daemon_starting");
    await log.append("daemon_ready");
    await expect(log.read()).resolves.toMatchObject([
      { event: "daemon_starting" },
      { event: "daemon_ready" },
    ]);
    await expect(log.read(1)).resolves.toMatchObject([{ event: "daemon_ready" }]);
  });

  it("continues a cursor losslessly through multiple rotations", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-log-"));
    temporaryDirectories.push(root);
    const log = new OmniCodexOperationalLog({
      path: join(root, "operations.jsonl"),
      maxBytes: 1,
      compressArchivedSegments: false,
    });
    await log.append("daemon_starting");
    const cursor = await log.captureCursor();
    await log.append("daemon_ready", { port: 9519 });
    await log.append("daemon_stopping");

    const batch = await log.readFrom(cursor);
    expect(batch.entries).toMatchObject([
      { event: "daemon_ready", details: { port: 9519 } },
      { event: "daemon_stopping" },
    ]);
    await expect(log.readFrom(batch.cursor)).resolves.toEqual({
      entries: [],
      cursor: batch.cursor,
    });
  });

  it("compresses completed segments while preserving their readable history", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-log-"));
    temporaryDirectories.push(root);
    const path = join(root, "operations.jsonl");
    const log = new OmniCodexOperationalLog({ path, maxBytes: 1 });
    await log.append("daemon_starting", { runtimePath: "x".repeat(10_000) });
    await log.append("daemon_ready");
    await log.flush();

    const archived = await readdir(`${path}.segments`);
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatch(/\.jsonl\.gz$/);
    await expect(log.read()).resolves.toMatchObject([
      { event: "daemon_starting", details: { runtimePath: "x".repeat(10_000) } },
      { event: "daemon_ready" },
    ]);
  });

  it("reads only complete records appended after a captured cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-log-"));
    temporaryDirectories.push(root);
    const log = new OmniCodexOperationalLog({ path: join(root, "operations.jsonl") });
    await log.append("daemon_starting");
    const cursor = await log.captureCursor();
    await log.append("daemon_ready", { port: 9519 });

    const first = await log.readFrom(cursor);
    expect(first.entries).toMatchObject([{ event: "daemon_ready", details: { port: 9519 } }]);
    await expect(log.readFrom(first.cursor)).resolves.toEqual({
      entries: [],
      cursor: first.cursor,
    });
  });

  it("reads a high-cardinality segment without overflowing the argument stack", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-log-"));
    temporaryDirectories.push(root);
    const path = join(root, "operations.jsonl");
    const count = 130_000;
    const line = `${JSON.stringify({
      timestamp: "2026-09-02T00:00:00.000Z",
      event: "daemon_ready",
      pid: 1,
    })}\n`;
    await writeFile(path, line.repeat(count), "utf8");

    const entries = await new OmniCodexOperationalLog({ path }).read();

    expect(entries).toHaveLength(count);
    expect(entries[0]).toMatchObject({ event: "daemon_ready", pid: 1 });
    expect(entries.at(-1)).toMatchObject({ event: "daemon_ready", pid: 1 });
  });
});
