import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  compactDurableMcpEventSnapshots,
  type DurableMcpEventHistoryError,
  DurableMcpEventPersistenceError,
  DurableMcpEventSessionAmbiguousError,
  DurableMcpEventSessionBindingError,
  DurableMcpEventSessionExpiredError,
  DurableMcpEventSessionNotFoundError,
  DurableMcpEventStore,
  type DurableMcpEventStoreOptions,
} from "../src/infrastructure/mcp/durable-mcp-event-store.js";

const HMAC_KEY = Buffer.alloc(32, 0x5a);
const gunzipAsync = promisify(gunzip);

describe("DurableMcpEventStore", () => {
  it("retains ordered history by default beyond former count, byte, and TTL cutoffs", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-durable-lossless-"));
    let now = 1_000;
    const options = storeOptions(dataDirectory, { nowUnixMs: () => now });
    try {
      const store = await DurableMcpEventStore.open(options);
      const buffered = Array.from({ length: 4_100 }, (_, index) => ({
        id: `bootstrap.${String(index)}`,
        streamId: "stream",
        message: notification(String(index)),
        storedAtUnixMs: now,
      }));
      const largeId = "bootstrap.large";
      buffered.push({
        id: largeId,
        streamId: "stream",
        message: notification("x".repeat(24 * 1024 * 1024)),
        storedAtUnixMs: now,
      });
      await store.adoptBufferedEvents(buffered);

      now += 8 * 24 * 60 * 60_000;
      const reopened = await DurableMcpEventStore.rehydrate(options);
      await expect(reopened.getSessionMetadata()).resolves.toMatchObject({
        retainedEventCount: 4_101,
        earliestEventId: "bootstrap.0",
        latestEventId: largeId,
      });
      await expect(reopened.lookupEventState("bootstrap.0")).resolves.toBe("active");
      await expect(reopened.lookupEventState(largeId)).resolves.toBe("active");
      const replayed: string[] = [];
      await expect(
        reopened.replayEventsAfter("bootstrap.0", {
          send: async (eventId) => {
            replayed.push(eventId);
          },
        }),
      ).resolves.toBe("stream");
      expect(replayed).toHaveLength(4_100);
      expect(replayed[0]).toBe("bootstrap.1");
      expect(replayed.at(-1)).toBe(largeId);
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("reopens after restart, preserves monotonic IDs, and exposes SDK-compatible replay", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-durable-events-"));
    const options = storeOptions(dataDirectory);
    const firstStore = await DurableMcpEventStore.open(options);
    const first = await firstStore.storeEvent("stream-a", notification("one"));
    await firstStore.storeEvent("stream-b", notification("other"));

    // A fresh instance exercises the persisted snapshot rather than session-local memory.
    const reopened = await DurableMcpEventStore.rehydrate(options);
    const third = await reopened.storeEvent("stream-a", notification("three"));
    const replayed: unknown[] = [];
    await expect(
      reopened.replayEventsAfter(first, {
        send: async (eventId, message) => {
          replayed.push({ eventId, message });
        },
      }),
    ).resolves.toBe("stream-a");

    expect(first).toMatch(/^omev1_1_[A-Za-z0-9_-]{43}$/);
    expect(third).toMatch(/^omev1_3_[A-Za-z0-9_-]{43}$/);
    expect(replayed).toEqual([{ eventId: third, message: notification("three") }]);
    const metadata = await reopened.getSessionMetadata();
    expect(metadata).toMatchObject({
      retainedEventCount: 3,
      nextSequence: 4,
      earliestEventId: first,
      latestEventId: third,
    });
    await expect(DurableMcpEventStore.lookupSessionMetadata(options)).resolves.toMatchObject({
      opaqueSessionId: reopened.opaqueSessionId,
      nextSequence: 4,
    });
  });

  it("rehydrates unknown-session GET replay by authenticated transport without POST capability", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-durable-events-"));
    const options = storeOptions(dataDirectory);
    const store = await DurableMcpEventStore.open(options);
    const first = await store.storeEvent("stream", notification("one"));
    const second = await store.storeEvent("stream", notification("two"));

    const replay = await DurableMcpEventStore.rehydrateByTransport({
      dataDirectory,
      hmacKey: HMAC_KEY,
      ownerBinding: options.ownerBinding,
      surface: options.surface,
      transportSessionId: options.transportSessionId,
    });
    const replayed: unknown[] = [];
    await expect(
      replay.replayEventsAfter(first, {
        send: async (eventId, message) => {
          replayed.push({ eventId, message });
        },
      }),
    ).resolves.toBe("stream");
    expect(replayed).toEqual([{ eventId: second, message: notification("two") }]);
    expect("storeEvent" in replay).toBe(false);
    expect("tombstoneSession" in replay).toBe(false);

    await expect(
      DurableMcpEventStore.rehydrateByTransport({
        dataDirectory,
        hmacKey: HMAC_KEY,
        ownerBinding: "different-owner",
        surface: options.surface,
        transportSessionId: options.transportSessionId,
      }),
    ).rejects.toBeInstanceOf(DurableMcpEventSessionNotFoundError);
    await expect(
      DurableMcpEventStore.rehydrateByTransport({
        dataDirectory,
        hmacKey: HMAC_KEY,
        ownerBinding: options.ownerBinding,
        surface: "readonly",
        transportSessionId: options.transportSessionId,
      }),
    ).rejects.toBeInstanceOf(DurableMcpEventSessionNotFoundError);
  });

  it("fails closed for duplicate transport matches and bounded discovery overflow", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-durable-events-"));
    const options = storeOptions(dataDirectory);
    await DurableMcpEventStore.open(options);
    const secondOptions = storeOptions(dataDirectory, {
      workSessionBinding: "a-second-work-session",
    });
    await expect(DurableMcpEventStore.open(secondOptions)).rejects.toBeInstanceOf(
      DurableMcpEventSessionAmbiguousError,
    );
    await rm(join(dataDirectory, "transport-locators"), { recursive: true, force: true });
    await DurableMcpEventStore.open(secondOptions);
    await rm(join(dataDirectory, "transport-locators"), { recursive: true, force: true });
    const transportLookup = {
      dataDirectory,
      hmacKey: HMAC_KEY,
      ownerBinding: options.ownerBinding,
      surface: options.surface,
      transportSessionId: options.transportSessionId,
    } as const;

    await expect(DurableMcpEventStore.rehydrateByTransport(transportLookup)).rejects.toBeInstanceOf(
      DurableMcpEventSessionNotFoundError,
    );
    await expect(
      DurableMcpEventStore.rehydrateByTransport({
        ...transportLookup,
        allowLegacyMigrationScan: true,
      }),
    ).rejects.toBeInstanceOf(DurableMcpEventSessionAmbiguousError);
    await expect(
      DurableMcpEventStore.rehydrateByTransport({
        ...transportLookup,
        allowLegacyMigrationScan: true,
        maxSessionFilesToScan: 1,
      }),
    ).rejects.toThrow("bounded scan limit");
  });

  it("uses authenticated O(1) locators beyond 8192 snapshots with owner isolation", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-durable-locator-scale-"));
    const sharedTransport = "shared-opaque-transport";
    const firstOptions = storeOptions(dataDirectory, {
      ownerBinding: "owner-first-private",
      workSessionBinding: "work-first-private",
      transportSessionId: sharedTransport,
    });
    const lastOptions = storeOptions(dataDirectory, {
      ownerBinding: "owner-last-private",
      workSessionBinding: "work-last-private",
      transportSessionId: sharedTransport,
    });
    try {
      const first = await DurableMcpEventStore.open(firstOptions);
      const last = await DurableMcpEventStore.open(lastOptions);
      for (let offset = 0; offset < 8_191; offset += 256) {
        await Promise.all(
          Array.from({ length: Math.min(256, 8_191 - offset) }, (_, index) => {
            const suffix = (offset + index).toString(36).padStart(43, "0");
            return writeFile(join(dataDirectory, `omes1_${suffix}.snapshot.json`), "{}\n", "utf8");
          }),
        );
      }
      const snapshots = (await readdir(dataDirectory)).filter((name) =>
        name.endsWith(".snapshot.json"),
      );
      expect(snapshots).toHaveLength(8_193);

      const firstReplay = await DurableMcpEventStore.rehydrateByTransport({
        dataDirectory,
        hmacKey: HMAC_KEY,
        ownerBinding: firstOptions.ownerBinding,
        surface: firstOptions.surface,
        transportSessionId: sharedTransport,
        maxSessionFilesToScan: 1,
      });
      const lastReplay = await DurableMcpEventStore.rehydrateByTransport({
        dataDirectory,
        hmacKey: HMAC_KEY,
        ownerBinding: lastOptions.ownerBinding,
        surface: lastOptions.surface,
        transportSessionId: sharedTransport,
        maxSessionFilesToScan: 1,
      });
      expect(firstReplay.opaqueSessionId).toBe(first.opaqueSessionId);
      expect(lastReplay.opaqueSessionId).toBe(last.opaqueSessionId);
      await expect(
        DurableMcpEventStore.rehydrateByTransport({
          dataDirectory,
          hmacKey: HMAC_KEY,
          ownerBinding: "owner-unknown-private",
          surface: firstOptions.surface,
          transportSessionId: sharedTransport,
          maxSessionFilesToScan: 1,
        }),
      ).rejects.toBeInstanceOf(DurableMcpEventSessionNotFoundError);

      await rm(join(dataDirectory, "transport-locators"), { recursive: true, force: true });
      await expect(
        DurableMcpEventStore.rehydrateByTransport({
          dataDirectory,
          hmacKey: HMAC_KEY,
          ownerBinding: lastOptions.ownerBinding,
          surface: lastOptions.surface,
          transportSessionId: sharedTransport,
          allowLegacyMigrationScan: true,
        }),
      ).resolves.toMatchObject({ opaqueSessionId: last.opaqueSessionId });
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  it("applies an explicit legacy scan limit only to matching session snapshots", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-durable-exact-scan-limit-"));
    const options = storeOptions(dataDirectory);
    try {
      const store = await DurableMcpEventStore.open(options);
      await rm(join(dataDirectory, "transport-locators"), { recursive: true, force: true });
      await Promise.all(
        Array.from({ length: 128 }, (_, index) =>
          writeFile(join(dataDirectory, `unrelated-${index}.tmp`), "ignored\n", "utf8"),
        ),
      );

      await expect(
        DurableMcpEventStore.rehydrateByTransport({
          dataDirectory,
          hmacKey: HMAC_KEY,
          ownerBinding: options.ownerBinding,
          surface: options.surface,
          transportSessionId: options.transportSessionId,
          allowLegacyMigrationScan: true,
          maxSessionFilesToScan: 1,
        }),
      ).resolves.toMatchObject({ opaqueSessionId: store.opaqueSessionId });
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("authenticates locator contents and isolates a damaged locator", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-durable-locator-auth-"));
    const firstOptions = storeOptions(dataDirectory);
    const secondOptions = storeOptions(dataDirectory, {
      transportSessionId: "transport-unrelated",
      workSessionBinding: "work-unrelated",
    });
    await DurableMcpEventStore.open(firstOptions);
    const second = await DurableMcpEventStore.open(secondOptions);
    const locatorDirectory = join(dataDirectory, "transport-locators");
    const locatorFiles = await readdir(locatorDirectory);
    const locatorContents = await Promise.all(
      locatorFiles.map(async (name) => ({
        name,
        content: await readFile(join(locatorDirectory, name), "utf8"),
      })),
    );
    expect(
      locatorContents.every((entry) => !entry.content.includes(firstOptions.ownerBinding)),
    ).toBe(true);
    expect(
      locatorContents.every((entry) => !entry.content.includes(firstOptions.transportSessionId)),
    ).toBe(true);
    expect(
      locatorContents.every((entry) => !entry.content.includes(firstOptions.workSessionBinding)),
    ).toBe(true);
    // Locate the target through the authenticated opaque session ID, not raw boundary data.
    const matching = locatorContents.find(
      (entry) =>
        (JSON.parse(entry.content) as { readonly opaqueSessionId: string }).opaqueSessionId !==
        second.opaqueSessionId,
    );
    if (matching === undefined) throw new Error("Missing first transport locator fixture");
    await writeFile(
      join(locatorDirectory, matching.name),
      matching.content.replace('"schemaVersion":1', '"schemaVersion":2'),
      "utf8",
    );
    await expect(
      DurableMcpEventStore.rehydrateByTransport({
        dataDirectory,
        hmacKey: HMAC_KEY,
        ownerBinding: firstOptions.ownerBinding,
        surface: firstOptions.surface,
        transportSessionId: firstOptions.transportSessionId,
      }),
    ).rejects.toBeInstanceOf(DurableMcpEventPersistenceError);
    await expect(
      DurableMcpEventStore.rehydrateByTransport({
        dataDirectory,
        hmacKey: HMAC_KEY,
        ownerBinding: secondOptions.ownerBinding,
        surface: secondOptions.surface,
        transportSessionId: secondOptions.transportSessionId,
      }),
    ).resolves.toMatchObject({ opaqueSessionId: second.opaqueSessionId });
    expect(locatorFiles.every((name) => /^omel1_[A-Za-z0-9_-]{43}\.json$/.test(name))).toBe(true);
  });

  it("migrates an unindexed legacy snapshot while isolating a corrupt neighbor", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-durable-locator-migration-"));
    const options = storeOptions(dataDirectory);
    const store = await DurableMcpEventStore.open(options);
    await rm(join(dataDirectory, "transport-locators"), { recursive: true, force: true });
    await writeFile(
      join(dataDirectory, `omes1_${"z".repeat(43)}.snapshot.json`),
      "{not-json}\n",
      "utf8",
    );

    const migrated = await DurableMcpEventStore.rehydrateByTransport({
      dataDirectory,
      hmacKey: HMAC_KEY,
      ownerBinding: options.ownerBinding,
      surface: options.surface,
      transportSessionId: options.transportSessionId,
      allowLegacyMigrationScan: true,
    });
    expect(migrated.opaqueSessionId).toBe(store.opaqueSessionId);
    await expect(
      DurableMcpEventStore.rehydrateByTransport({
        dataDirectory,
        hmacKey: HMAC_KEY,
        ownerBinding: options.ownerBinding,
        surface: options.surface,
        transportSessionId: options.transportSessionId,
      }),
    ).resolves.toMatchObject({ opaqueSessionId: store.opaqueSessionId });
  });

  it("persists only keyed binding digests and rejects cross-boundary replay", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-durable-events-"));
    const snapshotPath = join(dataDirectory, "fixed.snapshot.json");
    const options = storeOptions(dataDirectory, { snapshotPath });
    const store = await DurableMcpEventStore.open(options);
    const eventId = await store.storeEvent("stream", notification("safe"));
    const persisted = await decodedSnapshot(snapshotPath);

    expect(persisted).not.toContain(options.ownerBinding);
    expect(persisted).not.toContain(options.workSessionBinding);
    expect(persisted).not.toContain(options.transportSessionId);
    expect(persisted).not.toContain(options.surface);

    const wrongOwner = storeOptions(dataDirectory, {
      snapshotPath,
      ownerBinding: "owner-beta-private",
    });
    await expect(DurableMcpEventStore.rehydrate(wrongOwner)).rejects.toBeInstanceOf(
      DurableMcpEventSessionBindingError,
    );

    const otherSurface = await DurableMcpEventStore.open(
      storeOptions(dataDirectory, { surface: "readonly", transportSessionId: "transport-other" }),
    );
    await expect(otherSurface.lookupEventState(eventId)).resolves.toBe("unknown");
    await expect(
      otherSurface.replayEventsAfter(eventId, { send: async () => undefined }),
    ).rejects.toMatchObject({ code: "MCP_EVENT_HISTORY_UNKNOWN" });
  });

  it("applies explicit count and TTL retention, retains tombstones, and fails closed", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-durable-events-"));
    let now = 10_000;
    const store = await DurableMcpEventStore.open(
      storeOptions(dataDirectory, {
        maxEvents: 2,
        maxEventBytes: 1_024,
        eventTtlMs: 100,
        tombstoneTtlMs: 1_000,
        nowUnixMs: () => now,
      }),
    );
    const evicted = await store.storeEvent("stream", notification("one"));
    now += 1;
    await store.storeEvent("stream", notification("two"));
    now += 1;
    const latest = await store.storeEvent("stream", notification("three"));

    await expect(store.lookupEventState(evicted)).resolves.toBe("expired");
    await expect(store.replayEventsAfter(evicted, { send: async () => undefined })).rejects.toEqual(
      expect.objectContaining<Partial<DurableMcpEventHistoryError>>({
        code: "MCP_EVENT_HISTORY_EXPIRED",
      }),
    );
    now += 101;
    await expect(store.getStreamIdForEventId(latest)).resolves.toBeUndefined();
    await expect(store.lookupEventState(latest)).resolves.toBe("expired");
  });

  it("tombstones expired sessions and refuses unknown or tombstoned rehydration", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-durable-events-"));
    let now = 1_000;
    const options = storeOptions(dataDirectory, {
      sessionTtlMs: 10,
      nowUnixMs: () => now,
    });
    const store = await DurableMcpEventStore.open(options);
    await store.storeEvent("stream", notification("before-expiry"));
    now = 1_011;
    await expect(DurableMcpEventStore.rehydrate(options)).rejects.toBeInstanceOf(
      DurableMcpEventSessionExpiredError,
    );
    await expect(DurableMcpEventStore.rehydrate(options)).rejects.toBeInstanceOf(
      DurableMcpEventSessionNotFoundError,
    );
    await expect(
      readFile(join(dataDirectory, `${store.opaqueSessionId}.snapshot.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(join(dataDirectory, "transport-locators"))).resolves.toEqual([]);

    await expect(
      DurableMcpEventStore.rehydrate(
        storeOptions(dataDirectory, { transportSessionId: "never-issued" }),
      ),
    ).rejects.toBeInstanceOf(DurableMcpEventSessionNotFoundError);
  });

  it("detects authenticated snapshot and journal tampering", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-durable-events-"));
    const snapshotPath = join(dataDirectory, "tamper.snapshot.json");
    const journalPath = `${snapshotPath}.journal`;
    const options = storeOptions(dataDirectory, { snapshotPath, journalPath });
    const store = await DurableMcpEventStore.open(options);
    await store.storeEvent("stream", notification("original"));
    const snapshot = await readFile(snapshotPath);
    const decoded = await decodedSnapshot(snapshotPath);
    await writeFile(snapshotPath, decoded.replace("original", "modified"), "utf8");
    await expect(DurableMcpEventStore.rehydrate(options)).rejects.toBeInstanceOf(
      DurableMcpEventPersistenceError,
    );

    // Restore the valid snapshot, then prove an unauthenticated WAL is rejected too.
    await writeFile(snapshotPath, snapshot);
    await writeFile(journalPath, `${JSON.stringify({ schemaVersion: 1 })}\n`, "utf8");
    await expect(DurableMcpEventStore.rehydrate(options)).rejects.toBeInstanceOf(
      DurableMcpEventPersistenceError,
    );
  });

  it("compresses durable snapshots without changing replay, event order, or authenticated content", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-durable-events-"));
    const options = storeOptions(dataDirectory);
    const store = await DurableMcpEventStore.open(options);
    const anchor = await store.storeEvent("stream", notification("x".repeat(256 * 1024)));
    const snapshotPath = join(dataDirectory, `${store.opaqueSessionId}.snapshot.json`);
    const stored = await readFile(snapshotPath);
    expect([...stored.subarray(0, 2)]).toEqual([0x1f, 0x8b]);

    const result = await compactDurableMcpEventSnapshots({
      dataDirectory,
      hmacKey: HMAC_KEY,
    });
    expect(result).toMatchObject({ snapshotCount: 1, compressedSnapshotCount: 0 });
    expect(result.bytesAfter).toBeLessThan(256 * 1024);

    const restarted = await DurableMcpEventStore.rehydrate(options);
    await expect(restarted.lookupEventState(anchor)).resolves.toBe("active");
  });

  it("explicitly tombstones a transport without affecting a separately bound session", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-durable-events-"));
    const firstOptions = storeOptions(dataDirectory);
    const first = await DurableMcpEventStore.open(firstOptions);
    const secondOptions = storeOptions(dataDirectory, { transportSessionId: "transport-two" });
    const second = await DurableMcpEventStore.open(secondOptions);
    await first.tombstoneSession();

    await expect(DurableMcpEventStore.rehydrate(firstOptions)).rejects.toBeInstanceOf(
      DurableMcpEventSessionNotFoundError,
    );
    await expect(
      DurableMcpEventStore.rehydrateByTransport({
        dataDirectory,
        hmacKey: HMAC_KEY,
        ownerBinding: firstOptions.ownerBinding,
        surface: firstOptions.surface,
        transportSessionId: firstOptions.transportSessionId,
      }),
    ).rejects.toBeInstanceOf(DurableMcpEventSessionNotFoundError);
    await expect(second.storeEvent("stream", notification("still-live"))).resolves.toMatch(
      /^omev1_1_/,
    );
  });
});

function storeOptions(
  dataDirectory: string,
  overrides: Partial<DurableMcpEventStoreOptions> = {},
): DurableMcpEventStoreOptions {
  return {
    dataDirectory,
    hmacKey: HMAC_KEY,
    ownerBinding: "owner-alpha-private",
    surface: "full",
    workSessionBinding: "work-session-private",
    transportSessionId: "transport-private",
    ...overrides,
  };
}

function notification(value: string) {
  return {
    jsonrpc: "2.0" as const,
    method: "notifications/progress" as const,
    params: { progressToken: value, progress: 1 },
  };
}

async function decodedSnapshot(path: string): Promise<string> {
  const stored = await readFile(path);
  const decoded = stored[0] === 0x1f && stored[1] === 0x8b ? await gunzipAsync(stored) : stored;
  return decoded.toString("utf8");
}
