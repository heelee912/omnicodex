import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireOmniCodexBridgeDirectoryLease,
  OMNICODEX_BRIDGE_DIRECTORY_LEASE_LOST,
  type OmniCodexBridgeHeartbeatRegistration,
  type OmniCodexBridgeHeartbeatScheduler,
} from "../src/application/omnicodex-bridge-directory-lease.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("OmniCodex Bridge directory lease", () => {
  it("atomically renews one owned lease and removes only its lease directory", async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, "bridge", "reconcile.lock");
    const clock = manualClock(1_000);
    const scheduler = new ManualHeartbeatScheduler();
    const lease = await acquireOmniCodexBridgeDirectoryLease(
      lockPath,
      leaseOptions(clock, scheduler, nonceSequence("first")),
    );

    expect(lease.fencingToken).toBe(1);
    const owner = await readJson(join(lockPath, "owner.json"));
    expect(owner).toMatchObject({
      schemaVersion: 1,
      nonce: lease.nonce,
      fencingToken: 1,
      acquiredAtUnixMs: 1_000,
    });

    clock.advance(25);
    await scheduler.tick();
    await lease.assertOwned();

    const holderDirectory = requiredString(owner.holderDirectory);
    const heartbeat = await readJson(join(lockPath, holderDirectory, "heartbeat.json"));
    expect(heartbeat).toMatchObject({
      nonce: lease.nonce,
      fencingToken: 1,
      renewedAtUnixMs: 1_025,
    });
    expect(await directoryEntries(holderDirectory, lockPath)).toEqual(["heartbeat.json"]);

    await lease.release();

    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readJson(`${lockPath}.fence.json`)).resolves.toMatchObject({ lastIssued: 1 });
    expect(scheduler.cancelled).toBe(true);
  });

  it("fails closed when the authoritative owner nonce changes and preserves the successor", async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, "bridge", "reconcile.lock");
    const clock = manualClock(2_000);
    const scheduler = new ManualHeartbeatScheduler();
    const lease = await acquireOmniCodexBridgeDirectoryLease(
      lockPath,
      leaseOptions(clock, scheduler, nonceSequence("owner-change")),
    );
    const original = await readJson(join(lockPath, "owner.json"));
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({ ...original, nonce: "successor", fencingToken: 2 })}\n`,
      "utf8",
    );

    const failure = await lease.assertOwned().catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: OMNICODEX_BRIDGE_DIRECTORY_LEASE_LOST,
    });
    expect(lease.lost).toBe(true);
    expect(lease.loss).toBe(failure);
    expect(scheduler.cancelled).toBe(true);

    await lease.release();
    await expect(readJson(join(lockPath, "owner.json"))).resolves.toMatchObject({
      nonce: "successor",
      fencingToken: 2,
    });
  });

  it("records a heartbeat write failure as permanent lease loss", async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, "bridge", "reconcile.lock");
    const clock = manualClock(3_000);
    const scheduler = new ManualHeartbeatScheduler();
    const lease = await acquireOmniCodexBridgeDirectoryLease(
      lockPath,
      leaseOptions(clock, scheduler, nonceSequence("heartbeat-failure")),
    );
    const owner = await readJson(join(lockPath, "owner.json"));
    await rm(join(lockPath, requiredString(owner.holderDirectory)), {
      recursive: true,
      force: true,
    });

    clock.advance(25);
    await scheduler.tick();

    expect(lease.lost).toBe(true);
    await expect(lease.assertOwned()).rejects.toMatchObject({
      code: OMNICODEX_BRIDGE_DIRECTORY_LEASE_LOST,
    });
    await lease.release();
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("takes over a stale lease with a higher fence and prevents late-owner cleanup", async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, "bridge", "reconcile.lock");
    const clock = manualClock(4_000);
    const firstScheduler = new ManualHeartbeatScheduler();
    const first = await acquireOmniCodexBridgeDirectoryLease(
      lockPath,
      leaseOptions(clock, firstScheduler, nonceSequence("stale-first")),
    );

    clock.advance(101);
    const secondScheduler = new ManualHeartbeatScheduler();
    const second = await acquireOmniCodexBridgeDirectoryLease(
      lockPath,
      leaseOptions(clock, secondScheduler, nonceSequence("stale-second")),
    );

    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
    await firstScheduler.tick();
    await expect(first.assertOwned()).rejects.toMatchObject({
      code: OMNICODEX_BRIDGE_DIRECTORY_LEASE_LOST,
    });
    await first.release();
    await expect(readJson(join(lockPath, "owner.json"))).resolves.toMatchObject({
      nonce: second.nonce,
      fencingToken: second.fencingToken,
    });

    await second.assertOwned();
    await second.release();
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a stale lease even when its process crashed inside the operation gate", async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, "bridge", "reconcile.lock");
    const clock = manualClock(5_000);
    const first = await acquireOmniCodexBridgeDirectoryLease(
      lockPath,
      leaseOptions(clock, new ManualHeartbeatScheduler(), nonceSequence("gate-first")),
    );
    const operationPath = join(lockPath, ".operation");
    await mkdir(operationPath);
    const operationNonce = "crashed-operation";
    const operationOwnerPath = join(
      operationPath,
      `owner-${createHash("sha256").update(operationNonce).digest("hex")}.json`,
    );
    await writeFile(
      operationOwnerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        nonce: operationNonce,
        acquiredAtUnixMs: clock.now(),
      })}\n`,
      "utf8",
    );

    clock.advance(101);
    const second = await acquireOmniCodexBridgeDirectoryLease(
      lockPath,
      leaseOptions(clock, new ManualHeartbeatScheduler(), nonceSequence("gate-second")),
    );

    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
    await first.release();
    await expect(readJson(join(lockPath, "owner.json"))).resolves.toMatchObject({
      nonce: second.nonce,
    });
    await second.release();
  });

  it("times out deterministically instead of stealing a fresh lease", async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, "bridge", "reconcile.lock");
    const clock = manualClock(6_000);
    const first = await acquireOmniCodexBridgeDirectoryLease(
      lockPath,
      leaseOptions(clock, new ManualHeartbeatScheduler(), nonceSequence("fresh-first")),
    );

    await expect(
      acquireOmniCodexBridgeDirectoryLease(lockPath, {
        ...leaseOptions(clock, new ManualHeartbeatScheduler(), nonceSequence("fresh-second")),
        waitTimeoutMs: 5,
      }),
    ).rejects.toThrow("Timed out waiting for the OmniCodex Bridge directory lease");
    expect(first.lost).toBe(false);
    await first.assertOwned();
    await first.release();
  });

  it("waits for a held lease without an internal acquisition deadline", async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, "bridge", "reconcile.lock");
    const clock = manualClock(7_000);
    const first = await acquireOmniCodexBridgeDirectoryLease(lockPath, {
      ...leaseOptions(clock, new ManualHeartbeatScheduler(), nonceSequence("unbounded-first")),
      staleAfterMs: 100_000,
    });
    let elapsedWaitMs = 0;

    const second = await acquireOmniCodexBridgeDirectoryLease(lockPath, {
      now: clock.now,
      nonce: nonceSequence("unbounded-second"),
      heartbeatScheduler: new ManualHeartbeatScheduler(),
      staleAfterMs: 100_000,
      heartbeatIntervalMs: 20_000,
      retryDelayMs: 6_000,
      sleep: async (milliseconds) => {
        clock.advance(milliseconds);
        elapsedWaitMs += milliseconds;
        if (elapsedWaitMs > 10_000) await first.release();
      },
    });

    expect(elapsedWaitMs).toBeGreaterThan(10_000);
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
    await second.release();
  });

  it("waits for the operation gate without an internal deadline", async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, "bridge", "reconcile.lock");
    const operationPath = join(lockPath, ".operation");
    const clock = manualClock(8_000);
    let operationWaitMs = 0;
    const lease = await acquireOmniCodexBridgeDirectoryLease(lockPath, {
      now: clock.now,
      nonce: nonceSequence("unbounded-operation"),
      heartbeatScheduler: new ManualHeartbeatScheduler(),
      staleAfterMs: 100_000,
      heartbeatIntervalMs: 20_000,
      retryDelayMs: 600,
      sleep: async (milliseconds) => {
        clock.advance(milliseconds);
        operationWaitMs += milliseconds;
        if (operationWaitMs > 1_000) {
          await rm(operationPath, { recursive: true, force: true });
        }
      },
    });
    await mkdir(operationPath);

    await expect(lease.assertOwned()).resolves.toBeUndefined();

    expect(operationWaitMs).toBeGreaterThan(1_000);
    await lease.release();
  });
});

class ManualHeartbeatScheduler implements OmniCodexBridgeHeartbeatScheduler {
  #heartbeat: (() => Promise<void>) | undefined;
  cancelled = false;

  schedule(
    heartbeat: () => Promise<void>,
    _intervalMs: number,
  ): OmniCodexBridgeHeartbeatRegistration {
    this.#heartbeat = heartbeat;
    this.cancelled = false;
    return {
      cancel: () => {
        this.cancelled = true;
      },
    };
  }

  async tick(): Promise<void> {
    if (!this.cancelled) await this.#heartbeat?.();
  }
}

interface ManualClock {
  now(): number;
  advance(milliseconds: number): void;
  sleep(milliseconds: number): Promise<void>;
}

function manualClock(initial: number): ManualClock {
  let now = initial;
  return {
    now: () => now,
    advance: (milliseconds) => {
      now += milliseconds;
    },
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
  };
}

function leaseOptions(
  clock: ManualClock,
  heartbeatScheduler: ManualHeartbeatScheduler,
  nonce: () => string,
) {
  return {
    now: clock.now,
    nonce,
    sleep: clock.sleep,
    heartbeatScheduler,
    staleAfterMs: 100,
    heartbeatIntervalMs: 20,
    waitTimeoutMs: 50,
    retryDelayMs: 1,
    operationWaitMs: 10,
  } as const;
}

function nonceSequence(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "omnicodex-bridge-lease-"));
  temporaryDirectories.push(path);
  return path;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function directoryEntries(holderDirectory: string, lockPath: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(join(lockPath, holderDirectory))).sort();
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string fixture field");
  return value;
}
