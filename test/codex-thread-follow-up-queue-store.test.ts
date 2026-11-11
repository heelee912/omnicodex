import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexThreadFollowUpQueueStore } from "../src/infrastructure/runtime/codex-thread-follow-up-queue-store.js";

describe("CodexThreadFollowUpQueueStore", () => {
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "omnicodex-queue-store-"));
    path = join(directory, "queue.json");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("serializes concurrent writers, preserves FIFO, and joins one durable operation id", async () => {
    const firstProcess = new CodexThreadFollowUpQueueStore({ path });
    const secondProcess = new CodexThreadFollowUpQueueStore({ path });

    const accepted = await Promise.all([
      firstProcess.enqueue("desktop_ipc", "thread-1", "first", {
        clientUserMessageId: "operation-1",
      }),
      secondProcess.enqueue("desktop_ipc", "thread-1", "second", {
        clientUserMessageId: "operation-2",
      }),
    ]);
    expect(accepted.map((item) => item.position).sort()).toEqual([1, 2]);

    const queued = await firstProcess.list("desktop_ipc", "thread-1");
    expect(queued).toHaveLength(2);
    expect(queued.map((item) => item.clientUserMessageId)).toEqual(
      [...accepted]
        .sort((left, right) => left.position - right.position)
        .map((item) => item.clientUserMessageId),
    );

    const first = queued[0];
    if (first === undefined) throw new Error("missing first queued item");
    const duplicate = await secondProcess.enqueue("desktop_ipc", "thread-1", first.prompt, {
      clientUserMessageId: first.clientUserMessageId,
    });
    expect(duplicate).toMatchObject({
      clientUserMessageId: first.clientUserMessageId,
      acceptedAt: first.acceptedAt,
      position: 1,
      persisted: true,
    });
    await expect(
      secondProcess.enqueue("desktop_ipc", "thread-1", "different", {
        clientUserMessageId: first.clientUserMessageId,
      }),
    ).rejects.toThrow("reused with different input");

    expect(await firstProcess.claim(first.clientUserMessageId, "worker-1")).toMatchObject({
      clientUserMessageId: first.clientUserMessageId,
    });
    await expect(secondProcess.claim(first.clientUserMessageId, "worker-2")).resolves.toBeNull();
    await firstProcess.release(first.clientUserMessageId, "worker-1");
    expect(await secondProcess.claim(first.clientUserMessageId, "worker-2")).toMatchObject({
      clientUserMessageId: first.clientUserMessageId,
    });
    expect(await secondProcess.acknowledge(first.clientUserMessageId, "worker-2")).toBe(true);
  });

  it("waits without a default cutoff and never steals a stale-aged live writer lock", async () => {
    let now = 1_000;
    const lockPath = `${path}.lock`;
    await writeFile(
      lockPath,
      JSON.stringify({ token: "live-writer", acquiredAt: now, processId: process.pid }),
      "utf8",
    );
    const store = new CodexThreadFollowUpQueueStore({ path, now: () => now });
    let settled = false;
    const waiting = store.list("desktop_ipc");
    void waiting.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await pause(50);
    now += 3 * 60_000;
    await pause(50);
    expect(settled).toBe(false);
    await expect(readFile(lockPath, "utf8")).resolves.toContain("live-writer");

    await unlink(lockPath);
    await expect(waiting).resolves.toEqual([]);
  });

  it("honors only explicitly selected lock timeout and abort boundaries", async () => {
    const lockPath = `${path}.lock`;
    await writeFile(
      lockPath,
      JSON.stringify({ token: "external-writer", acquiredAt: Date.now(), processId: process.pid }),
      "utf8",
    );
    const explicitlyBounded = new CodexThreadFollowUpQueueStore({ path, lockTimeoutMs: 30 });
    await expect(explicitlyBounded.list("desktop_ipc")).rejects.toMatchObject({
      name: "TimeoutError",
    });

    const controller = new AbortController();
    const callerBound = new CodexThreadFollowUpQueueStore({ path });
    const waiting = callerBound.list("desktop_ipc", undefined, { signal: controller.signal });
    await pause(30);
    controller.abort(new Error("caller stopped waiting"));
    await expect(waiting).rejects.toThrow("caller stopped waiting");
    await unlink(lockPath);
  });

  it("retains claims and complete prompts indefinitely unless a lease is explicitly configured", async () => {
    let now = 1_000;
    const prompt = `start:${"x".repeat(256 * 1024)}:end`;
    const store = new CodexThreadFollowUpQueueStore({ path, now: () => now });
    await store.enqueue("desktop_ipc", "thread-long", prompt, {
      clientUserMessageId: "indefinite-claim",
    });
    const claimed = await store.claim("indefinite-claim", "worker-one");
    expect(claimed?.claim).toMatchObject({ ownerId: "worker-one", processId: process.pid });
    expect(claimed?.claim).not.toHaveProperty("expiresAt");

    now += 365 * 24 * 60 * 60_000;
    await expect(store.claim("indefinite-claim", "worker-two")).resolves.toBeNull();
    await expect(store.list("desktop_ipc", "thread-long")).resolves.toMatchObject([
      { prompt, claim: { ownerId: "worker-one", processId: process.pid } },
    ]);

    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      items: Array<{ claim?: { processId?: number } }>;
    };
    const persistedClaim = persisted.items[0]?.claim;
    if (persistedClaim === undefined) throw new Error("missing persisted queue claim");
    persistedClaim.processId = 2_147_483_647;
    await writeFile(path, `${JSON.stringify(persisted)}\n`, "utf8");
    await expect(store.claim("indefinite-claim", "worker-after-restart")).resolves.toMatchObject({
      claim: { ownerId: "worker-after-restart", processId: process.pid },
    });

    const leasedPath = join(directory, "leased-queue.json");
    const leased = new CodexThreadFollowUpQueueStore({
      path: leasedPath,
      claimLeaseMs: 50,
      now: () => now,
    });
    await leased.enqueue("desktop_ipc", "thread-leased", "leased", {
      clientUserMessageId: "explicit-lease",
    });
    await expect(leased.claim("explicit-lease", "worker-one")).resolves.toMatchObject({
      claim: { ownerId: "worker-one", expiresAt: now + 50 },
    });
    now += 51;
    await expect(leased.claim("explicit-lease", "worker-two")).resolves.toMatchObject({
      claim: { ownerId: "worker-two", expiresAt: now + 50 },
    });
  });
});

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
