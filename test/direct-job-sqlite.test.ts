import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as migrationState from "../src/infrastructure/mcp/direct-job-migration-state.js";
import {
  type DirectJobStartInput,
  DirectJobStore,
  type DirectJobStoreOptions,
  type DirectJobView,
} from "../src/infrastructure/mcp/direct-job-store.js";
import { canonicalJson } from "../src/infrastructure/safety/canonical-json.js";

const directories: string[] = [];
const stores: DirectJobStore[] = [];
const exec = promisify(execFile);
const moduleUrl = pathToFileURL(resolve("src/infrastructure/mcp/direct-job-store.ts")).href;
const scope = {
  authorizationBinding: "sqlite-owner-secret",
  conversationId: "sqlite-conversation",
  workSessionId: "sqlite-work-session",
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("DirectJobStore SQLite durability", () => {
  it("migrates every legacy state and envelope once, without changing the original", async () => {
    const path = await fixture();
    const seed = await fixture();
    const store = await openStore(seed);
    const targetContract = {
      catalogRevision: "a".repeat(64),
      targetIdentity: "native\0tool",
      targetContractDigest: "b".repeat(64),
      modelEffect: "none" as const,
    };
    const inputs = Array.from({ length: 6 }, (_, index) => ({ ...input(index), targetContract }));
    const jobs: DirectJobView[] = [];
    for (const item of inputs) jobs.push((await store.start(item)).job);
    const access = (index: number) => ({ ...scope, jobId: jobs[index]?.jobId as string });
    for (const index of [1, 2, 3, 4]) await store.markRunning(access(index));
    const result = {
      content: [{ type: "text" as const, text: 'unicode 😀 漢字 \\ quote "\n'.repeat(6_000) }],
      structuredContent: { nested: [null, false, { x: 1 }] },
      _meta: { complete: true },
    };
    await store.succeed(access(2), result);
    const error = {
      code: "NATIVE_FAILURE",
      message: "full",
      details: { nested: [1, 2] },
      retry: true,
    };
    await store.fail(access(3), error, { content: [], isError: true });
    await store.markOutcomeUnknown(access(4), error);
    await store.requestCancel(access(1));
    await store.requestCancel(access(5));
    const legacy = snapshot(seed);
    // Noncanonical formatting and metadata order must still validate the canonical checksum.
    const original = JSON.stringify(
      { jobs: legacy.jobs, checksum: legacy.checksum, revision: legacy.revision, schemaVersion: 1 },
      null,
      2,
    );
    await writeFile(path, original);
    const migrated = await openStore(path);
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await migrated.get(access(0))).toMatchObject({
      status: "cancelled",
      error: { code: "PROCESS_RESTART_BEFORE_DISPATCH" },
    });
    expect(await migrated.get(access(1))).toMatchObject({
      status: "outcome_unknown",
      cancelRequestedAtUnixMs: expect.any(Number),
      error: { code: "PROCESS_RESTART_AFTER_DISPATCH" },
    });
    expect(await migrated.get(access(2))).toMatchObject({ status: "succeeded", result });
    expect(await migrated.get(access(3))).toMatchObject({
      status: "failed",
      error,
      result: { content: [], isError: true },
    });
    expect(await migrated.get(access(4))).toMatchObject({ status: "outcome_unknown", error });
    expect(await migrated.get(access(5))).toMatchObject({ status: "cancelled" });
    for (const item of inputs) expect((await migrated.start(item)).disposition).toBe("existing");
    expect(
      await migrated.get({ ...access(2), authorizationBinding: "another-owner" }),
    ).toBeUndefined();
    await expect(
      migrated.findExisting({
        ...(inputs[2] as DirectJobStartInput),
        arguments: { different: true },
      }),
    ).rejects.toMatchObject({ code: "DIRECT_JOB_IDEMPOTENCY_CONFLICT" });
    expect(snapshot(path).jobs.map((job) => job.targetContract)).toEqual(
      inputs.map(() => targetContract),
    );
    await migrated.close();
    // A committed database is authoritative; an obsolete legacy file is not re-imported.
    await writeFile(path, "obsolete invalid JSON");
    const reopened = await openStore(path);
    expect(await reopened.get(access(2))).toMatchObject({ result });
    expect((await reopened.list(scope)).jobs).toHaveLength(6);
  });

  it.each(["checksum", "duplicate", "truncated", "unknown", "version"])(
    "rolls back an invalid %s migration, retaining a source-bound pending witness",
    async (kind) => {
      const path = await fixture();
      const valid = await smallLegacy(path);
      const value = JSON.parse(valid) as Record<string, unknown> & { jobs: unknown[] };
      if (kind === "checksum") value.checksum = "0".repeat(64);
      if (kind === "duplicate") value.jobs.push(value.jobs[0]);
      if (kind === "unknown") value.extra = true;
      if (kind === "version") value.schemaVersion = 99;
      const invalid = kind === "truncated" ? valid.slice(0, -9) : JSON.stringify(value);
      await writeFile(path, invalid);
      await expect(DirectJobStore.open({ snapshotPath: path })).rejects.toMatchObject({
        code: "DIRECT_JOB_SNAPSHOT_INVALID",
      });
      expect(await readFile(path, "utf8")).toBe(invalid);
      const witness = await readFile(migrationState.directJobMigrationPath(path), "utf8");
      await expect(DirectJobStore.open({ snapshotPath: path })).rejects.toMatchObject({
        code: "DIRECT_JOB_SNAPSHOT_INVALID",
      });
      const database = new DatabaseSync(`${path}.sqlite`);
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(),
      ).toHaveLength(0);
      database.close();
      await writeFile(path, valid);
      await expect(DirectJobStore.open({ snapshotPath: path })).rejects.toThrow(
        "source identity changed",
      );
      expect(await readFile(migrationState.directJobMigrationPath(path), "utf8")).toBe(witness);
    },
  );

  it.each(["payload", "projection", "metadata", "deleted", "file"])(
    "fails closed on committed SQLite %s corruption, even with valid legacy JSON",
    async (kind) => {
      const path = await fixture();
      await smallLegacy(path);
      const store = await openStore(path);
      await store.close();
      const database = new DatabaseSync(`${path}.sqlite`);
      if (kind === "payload") database.exec("UPDATE direct_jobs SET payload = '{}' ");
      if (kind === "projection") database.exec("UPDATE direct_jobs SET owner_digest = 'wrong'");
      if (kind === "metadata") database.exec("UPDATE direct_job_meta SET checksum = 'wrong'");
      if (kind === "deleted") database.exec("DELETE FROM direct_jobs");
      database.close();
      if (kind === "file") await writeFile(`${path}.sqlite`, "not SQLite");
      await expect(DirectJobStore.open({ snapshotPath: path })).rejects.toMatchObject({
        code: "DIRECT_JOB_SNAPSHOT_INVALID",
      });
    },
  );

  it.each(["", "-wal", "-shm"])("refuses an unmarked existing SQLite%s file", async (suffix) => {
    const path = await fixture();
    await smallLegacy(path);
    await writeFile(`${path}.sqlite${suffix}`, "");
    await expect(DirectJobStore.open({ snapshotPath: path })).rejects.toMatchObject({
      code: "DIRECT_JOB_SNAPSHOT_INVALID",
    });
    await expect(stat(migrationState.directJobMigrationPath(path))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["truncate", "remove", "empty_schema", "incomplete_schema"])(
    "never reimports stale JSON after a post-migration receipt when SQLite is %s",
    async (kind) => {
      const path = await fixture();
      const original = await smallLegacy(path);
      const store = await openStore(path);
      const created = await store.start(input(2));
      const access = { ...scope, jobId: created.job.jobId };
      await store.markRunning(access);
      await store.succeed(access, { content: [{ type: "text", text: "post-migration receipt" }] });
      await store.close();
      const witnessPath = migrationState.directJobMigrationPath(path);
      const witness = await readFile(witnessPath, "utf8");
      expect(witness.trimEnd().split("\n")).toHaveLength(2);
      if (kind === "remove") await removeDatabase(path);
      if (kind === "truncate") {
        await removeDatabase(path);
        await writeFile(`${path}.sqlite`, "");
      }
      if (kind === "empty_schema" || kind === "incomplete_schema") {
        const database = new DatabaseSync(`${path}.sqlite`);
        database.exec("DROP TABLE direct_job_migration; DROP TABLE direct_jobs;");
        if (kind === "empty_schema") database.exec("DROP TABLE direct_job_meta");
        database.close();
      }
      await expect(DirectJobStore.open({ snapshotPath: path })).rejects.toMatchObject({
        code: "DIRECT_JOB_SNAPSHOT_INVALID",
      });
      expect(await readFile(path, "utf8")).toBe(original);
      expect(await readFile(witnessPath, "utf8")).toBe(witness);
      if (kind === "remove")
        await expect(stat(`${path}.sqlite`)).rejects.toMatchObject({ code: "ENOENT" });
      if (kind === "truncate") expect((await stat(`${path}.sqlite`)).size).toBe(0);
    },
  );

  it("fences a fresh ledger too if its authoritative database disappears", async () => {
    const path = await fixture();
    const store = await openStore(path);
    await store.start(input(1));
    await store.close();
    await removeDatabase(path);
    await expect(DirectJobStore.open({ snapshotPath: path })).rejects.toMatchObject({
      code: "DIRECT_JOB_SNAPSHOT_INVALID",
    });
  });

  it("finalizes the SQLite-COMMIT/witness-publication crash window before restart fencing or operations", async () => {
    const path = await fixture();
    const seed = await fixture();
    const store = await openStore(seed);
    const created = await store.start(input(1));
    const legacy = snapshot(seed);
    await writeFile(path, canonicalJson(legacy));
    vi.spyOn(migrationState, "commitDirectJobMigration").mockRejectedValueOnce(
      new Error("publication interrupted"),
    );
    await expect(DirectJobStore.open({ snapshotPath: path })).rejects.toThrow(
      "publication interrupted",
    );
    // The actual initial SQLite COMMIT survived, but no recovery or new work was admitted.
    expect(snapshot(path).revision).toBe(legacy.revision);
    expect(snapshot(path).jobs[0]?.status).toBe("queued");
    const pending = await readFile(migrationState.directJobMigrationPath(path), "utf8");
    expect(pending.trimEnd().split("\n")).toHaveLength(1);
    const reopened = await openStore(path);
    expect(
      (await readFile(migrationState.directJobMigrationPath(path), "utf8")).startsWith(pending),
    ).toBe(true);
    expect((await migrationState.readDirectJobMigration(path))?.committed).toBeDefined();
    expect(await reopened.get({ ...scope, jobId: created.job.jobId })).toMatchObject({
      status: "cancelled",
      error: { code: "PROCESS_RESTART_BEFORE_DISPATCH" },
    });
    expect((await reopened.start(input(1))).disposition).toBe("existing");
  });

  it.each(["missing", "zero", "schema_empty"])(
    "retries an unchanged pending initial import with a %s database",
    async (kind) => {
      const path = await fixture();
      const original = await smallLegacy(path);
      vi.spyOn(migrationState, "commitDirectJobMigration").mockRejectedValueOnce(
        new Error("publication interrupted"),
      );
      await expect(DirectJobStore.open({ snapshotPath: path })).rejects.toThrow(
        "publication interrupted",
      );
      const pending = await readFile(migrationState.directJobMigrationPath(path), "utf8");
      await removeDatabase(path);
      if (kind === "zero") await writeFile(`${path}.sqlite`, "");
      if (kind === "schema_empty") new DatabaseSync(`${path}.sqlite`).close();
      const store = await openStore(path);
      expect((await store.list(scope)).jobs).toHaveLength(1);
      expect(await readFile(path, "utf8")).toBe(original);
      expect(
        (await readFile(migrationState.directJobMigrationPath(path), "utf8")).startsWith(pending),
      ).toBe(true);
    },
  );

  it.each(["changed", "replaced", "removed"])(
    "fails closed if a pending import's original source is %s before retry",
    async (kind) => {
      const path = await fixture();
      const original = await smallLegacy(path);
      vi.spyOn(migrationState, "commitDirectJobMigration").mockRejectedValueOnce(
        new Error("publication interrupted"),
      );
      await expect(DirectJobStore.open({ snapshotPath: path })).rejects.toThrow(
        "publication interrupted",
      );
      await removeDatabase(path);
      if (kind === "changed") await writeFile(path, `${original}\n`);
      if (kind === "removed" || kind === "replaced") await rm(path);
      if (kind === "replaced") await writeFile(path, original);
      await expect(DirectJobStore.open({ snapshotPath: path })).rejects.toThrow(
        "source identity changed",
      );
    },
  );

  it("refuses a pending database with advanced metadata rather than blessing unsealed writes", async () => {
    const path = await fixture();
    await smallLegacy(path);
    vi.spyOn(migrationState, "commitDirectJobMigration").mockRejectedValueOnce(
      new Error("publication interrupted"),
    );
    await expect(DirectJobStore.open({ snapshotPath: path })).rejects.toThrow(
      "publication interrupted",
    );
    const database = new DatabaseSync(`${path}.sqlite`);
    const metadata = JSON.parse(
      database.prepare("SELECT payload FROM direct_job_meta").get()?.payload as string,
    ) as { revision: number };
    metadata.revision += 1;
    const payload = canonicalJson(metadata);
    database
      .prepare("UPDATE direct_job_meta SET payload = ?, checksum = ?")
      .run(payload, createHash("sha256").update(payload).digest("hex"));
    database.close();
    await expect(DirectJobStore.open({ snapshotPath: path })).rejects.toThrow(
      "post-migration writes",
    );
    expect((await migrationState.readDirectJobMigration(path))?.committed).toBeUndefined();
  });

  it.each([
    "empty",
    "torn",
    "checksum",
    "unknown",
    "wrong_path",
    "missing",
    "changed_source",
    "bootstrap",
  ])(
    "fails closed on %s external migration state, even when the database is valid",
    async (kind) => {
      const path = await fixture();
      await smallLegacy(path);
      const store = await openStore(path);
      await store.close();
      const witnessPath = migrationState.directJobMigrationPath(path);
      const original = await readFile(witnessPath, "utf8");
      const lines = original.trimEnd().split("\n");
      if (kind === "empty") await writeFile(witnessPath, "");
      if (kind === "torn") await writeFile(witnessPath, original.slice(0, -9));
      if (kind === "checksum")
        await writeFile(witnessPath, original.replace(/"checksum":"./u, '"checksum":"z'));
      if (["unknown", "wrong_path", "changed_source"].includes(kind)) {
        const pending = (JSON.parse(lines[0] as string) as { payload: Record<string, unknown> })
          .payload;
        if (kind === "unknown") pending.state = "unexpected";
        if (kind === "wrong_path") pending.databasePathDigest = "0".repeat(64);
        if (kind === "changed_source")
          (pending.source as { sha256: string }).sha256 = "0".repeat(64);
        // Recomputed envelopes still cannot detach the witness from the SQLite bootstrap seal.
        const pendingChecksum = createHash("sha256").update(canonicalJson(pending)).digest("hex");
        const committed = (JSON.parse(lines[1] as string) as { payload: Record<string, unknown> })
          .payload;
        committed.pendingChecksum = pendingChecksum;
        await writeFile(witnessPath, `${stateEnvelope(pending)}\n${stateEnvelope(committed)}\n`);
      }
      if (kind === "bootstrap") {
        const committed = (JSON.parse(lines[1] as string) as { payload: Record<string, unknown> })
          .payload;
        committed.bootstrapChecksum = "0".repeat(64);
        await writeFile(witnessPath, `${lines[0]}\n${stateEnvelope(committed)}\n`);
      }
      if (kind === "missing") await rm(witnessPath);
      await expect(DirectJobStore.open({ snapshotPath: path })).rejects.toMatchObject({
        code: "DIRECT_JOB_SNAPSHOT_INVALID",
      });
    },
  );

  it("keeps indexed cursor ordering, ties, status filtering and stale/scope rejection identical to memory", async () => {
    const path = await fixture();
    const nowUnixMs = () => 42;
    const durable = await openStore(path, { nowUnixMs });
    const memory = DirectJobStore.inMemory({ nowUnixMs });
    for (let index = 0; index < 30; index += 1) {
      const item = {
        ...input(index),
        ...(index % 7 === 0 ? { conversationId: "other-conversation" } : {}),
      };
      for (const store of [durable, memory]) {
        const created = await store.start(item);
        if (index % 3 === 0) await store.requestCancel({ ...item, jobId: created.job.jobId });
      }
    }
    for (const statuses of [
      undefined,
      [],
      ["queued" as const],
      ["queued" as const, "cancelled" as const],
    ]) {
      let cursor: string | undefined;
      do {
        const request = {
          ...scope,
          limit: 4,
          ...(statuses === undefined ? {} : { statuses }),
          ...(cursor === undefined ? {} : { cursor }),
        };
        const actual = await durable.list(request);
        expect(actual).toEqual(await memory.list(request));
        cursor = actual.nextCursor;
      } while (cursor !== undefined);
    }
    const first = await durable.list({ ...scope, statuses: ["queued"], limit: 1 });
    const cursor = first.nextCursor as string;
    await expect(durable.list({ ...scope, authorizationBinding: "other", cursor })).rejects.toThrow(
      "stale or outside",
    );
    await durable.requestCancel({ ...scope, jobId: first.jobs[0]?.jobId as string });
    await expect(durable.list({ ...scope, statuses: ["queued"], cursor })).rejects.toThrow(
      "stale or outside",
    );
    await expect(durable.list({ ...scope, cursor: "not-valid-json" })).rejects.toThrow(
      "cursor is invalid",
    );
    expect((await durable.list({ ...scope, cursor })).jobs.length).toBeGreaterThan(0);
  });

  it("serializes owner-bound idempotent races and reference-counts shared process handles", async () => {
    const path = await fixture();
    const first = await openStore(path);
    const second = await openStore(path);
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) => (index % 2 ? first : second).start(input(1))),
    );
    expect(results.filter((result) => result.disposition === "created")).toHaveLength(1);
    const created = results[0]?.job;
    await first.close();
    expect((await second.start(input(1))).job).toEqual(created);
    for (const field of ["authorizationBinding", "conversationId", "workSessionId"]) {
      const different = { ...input(1), [field]: "different-scope" };
      expect((await second.start(different)).job.jobId).not.toBe(created?.jobId);
      expect(await second.get({ ...different, jobId: created?.jobId as string })).toBeUndefined();
    }
    await second.close();
    const reopened = await openStore(path);
    expect((await reopened.findExisting(input(1)))?.job.status).toBe("cancelled");
    const pendingOpen = openStore(path);
    await reopened.close();
    const concurrent = await pendingOpen;
    expect((await concurrent.findExisting(input(1)))?.job.status).toBe("cancelled");
    const [last] = await Promise.all([openStore(path), concurrent.close()]);
    expect((await last.start(input(2))).disposition).toBe("created");
  });

  it("rolls back a failed row/metadata commit, including capacity pruning, then accepts a retry", async () => {
    const path = await fixture();
    const store = await openStore(path, { maxJobs: 1 });
    const created = await store.start(input(1));
    const access = { ...scope, jobId: created.job.jobId };
    const database = new DatabaseSync(`${path}.sqlite`);
    try {
      database.exec(
        "CREATE TRIGGER fail_commit BEFORE UPDATE ON direct_job_meta BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END",
      );
      await expect(store.markRunning(access)).rejects.toThrow("injected commit failure");
      expect(await store.get(access)).toEqual(created.job);
      database.exec("DROP TRIGGER fail_commit");
      await store.markRunning(access);
      const terminal = await store.succeed(access, {
        content: [{ type: "text", text: "preserved" }],
      });
      database.exec(
        "CREATE TRIGGER fail_insert BEFORE INSERT ON direct_jobs BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END",
      );
      await expect(store.start(input(2))).rejects.toThrow("injected insert failure");
      expect(await store.get(access)).toEqual(terminal);
      database.exec("DROP TRIGGER fail_insert");
      const next = await store.start(input(2));
      expect(next.disposition).toBe("created");
      expect(await store.get(access)).toBeUndefined();
      await expect(store.start(input(3))).rejects.toThrow("capacity is exhausted");
      expect((await store.list(scope)).jobs).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("recovers a killed writer without replay and discards its uncommitted WAL changes", async () => {
    const path = await fixture();
    const seeded = (await child(`
      const store = await DirectJobStore.open({ snapshotPath: ${JSON.stringify(path)} });
      const jobs = [];
      for (let index = 0; index < 3; index++) {
        const item = { ...${JSON.stringify(scope)}, idempotencyKey: 'sqlite-crash-key-' + index, toolName: 'native_tool', arguments: {} };
        const job = (await store.start(item)).job;
        const access = { ...item, jobId: job.jobId };
        if (index > 0) await store.markRunning(access);
        if (index === 2) await store.succeed(access, { content: [{ type: 'text', text: 'committed' }] });
        jobs.push(job.jobId);
      }
      process.stdout.write(JSON.stringify(jobs));
      process.exit(0); // deliberately bypass close/checkpoint
    `)) as string[];
    await killAtReady(`
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(`${path}.sqlite`)});
      db.exec("BEGIN IMMEDIATE; UPDATE direct_jobs SET payload = '{}';");
      process.stdout.write('ready\\n');
      setInterval(() => {}, 1000);
    `);
    const reopened = await openStore(path);
    const recovered = await Promise.all(seeded.map((jobId) => reopened.get({ ...scope, jobId })));
    expect(recovered.map((job) => job?.status)).toEqual([
      "cancelled",
      "outcome_unknown",
      "succeeded",
    ]);
    expect(recovered[2]?.result).toEqual({ content: [{ type: "text", text: "committed" }] });
    await reopened.close();
    expect(
      (await (await openStore(path)).get({ ...scope, jobId: seeded[1] as string }))?.status,
    ).toBe("outcome_unknown");
  });

  it("writes linearly bounded WAL bytes per transition as the ledger grows", async () => {
    const path = await fixture();
    const store = await openStore(path);
    const database = new DatabaseSync(`${path}.sqlite`);
    const measure = async (offset: number) => {
      // Pin a reader snapshot so auto-checkpoint cannot recycle frames during the batch.
      database.exec("PRAGMA wal_checkpoint(TRUNCATE); BEGIN; SELECT COUNT(*) FROM direct_jobs;");
      const start = performance.now();
      try {
        for (let index = offset; index < offset + 100; index += 1) {
          const job = (await store.start(input(index))).job;
          const access = { ...scope, jobId: job.jobId };
          await store.markRunning(access);
          await store.succeed(access, { content: [{ type: "text", text: "x".repeat(1_024) }] });
        }
        return { bytes: (await stat(`${path}.sqlite-wal`)).size, ms: performance.now() - start };
      } finally {
        database.exec("ROLLBACK");
      }
    };
    try {
      const early = await measure(0);
      for (let index = 100; index < 1_000; index += 1) await store.start(input(index));
      const late = await measure(1_000);
      // Byte counts, unlike wall-clock timing, deterministically catch whole-ledger rewrites.
      expect(late.bytes).toBeLessThan(early.bytes * 3);
      expect(late.bytes).toBeLessThan(32 * 1024 * 1024);
      expect(late.ms).toBeLessThan(early.ms * 8 + 2_000);
      console.info("DirectJobStore incremental WAL benchmark", { early, late });
    } finally {
      database.close();
    }
  });

  it("crash-retries a 140MB/5000-job streaming migration and roundtrips it under a 96MiB heap", async () => {
    const path = await fixture();
    await largeLegacy(path, 5_000, 28 * 1024);
    const originalHash = await fileHash(path);
    const legacyBytes = (await stat(path)).size;
    const process = spawnChild(
      `
      await DirectJobStore.open({ snapshotPath: ${JSON.stringify(path)} });
      process.stdout.write('unexpectedly completed');
    `,
      ["--max-old-space-size=96"],
    );
    const exited = new Promise<void>((resolve) => process.once("exit", () => resolve()));
    let interrupted = false;
    try {
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        if (process.exitCode !== null) break;
        const size = await stat(`${path}.sqlite-wal`).then(
          (value) => value.size,
          () => 0,
        );
        if (size > 4 * 1024 * 1024) {
          interrupted = true;
          process.kill("SIGKILL");
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      process.kill("SIGKILL");
      await exited;
    }
    expect(interrupted).toBe(true);
    const result = (await child(
      `
      let peakHeap = 0, peakRss = 0;
      const sample = () => { const m = process.memoryUsage(); peakHeap = Math.max(peakHeap, m.heapUsed); peakRss = Math.max(peakRss, m.rss); };
      const timer = setInterval(sample, 10);
      let store = await DirectJobStore.open({ snapshotPath: ${JSON.stringify(path)} });
      await store.close();
      store = await DirectJobStore.open({ snapshotPath: ${JSON.stringify(path)} });
      sample();
      let count = 0, cursor;
      do {
        const page = await store.list({ ...${JSON.stringify(scope)}, limit: 50, ...(cursor ? { cursor } : {}) });
        for (const job of page.jobs) {
          if (job.status !== 'succeeded' || job.result.content[0].text !== 'x'.repeat(28 * 1024)) throw new Error('lossy roundtrip');
          count++;
        }
        cursor = page.nextCursor;
        sample();
      } while (cursor);
      const item = { ...${JSON.stringify(scope)}, idempotencyKey: 'post-migration-key-0001', toolName: 'native_tool', arguments: {} };
      const created = await store.start(item);
      const access = { ...item, jobId: created.job.jobId };
      await store.markRunning(access);
      const terminal = await store.succeed(access, { content: [{ type: 'text', text: 'incremental after 140MB' }] });
      await store.close();
      store = await DirectJobStore.open({ snapshotPath: ${JSON.stringify(path)} });
      if (JSON.stringify((await store.findExisting(item)).job) !== JSON.stringify(terminal)) throw new Error('restart changed committed job');
      sample();
      await store.close();
      clearInterval(timer);
      process.stdout.write(JSON.stringify({ count, peakHeap, peakRss, maxRssKiB: process.resourceUsage().maxRSS }));
    `,
      ["--max-old-space-size=96"],
    )) as { count: number; peakHeap: number; peakRss: number };
    expect(result.count).toBe(5_000);
    expect(await fileHash(path)).toBe(originalHash);
    console.info("DirectJobStore bounded migration memory", { legacyBytes, ...result });
  }, 120_000);
});

function input(index: number): DirectJobStartInput {
  return {
    ...scope,
    idempotencyKey: `sqlite-job-key-${String(index).padStart(6, "0")}`,
    toolName: "native_tool",
    arguments: {},
  };
}

async function fixture(): Promise<string> {
  const directory = await mkdtemp(
    join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "direct-job-sqlite-"),
  );
  directories.push(directory);
  return join(directory, "direct-job-store.json");
}

async function openStore(
  snapshotPath: string,
  options: DirectJobStoreOptions = {},
): Promise<DirectJobStore> {
  const store = await DirectJobStore.open({ ...options, snapshotPath });
  stores.push(store);
  return store;
}

function snapshot(path: string): {
  jobs: Record<string, unknown>[];
  revision: number;
  schemaVersion: 1;
  checksum: string;
} {
  const database = new DatabaseSync(`${path}.sqlite`, { readOnly: true });
  try {
    const jobs = database
      .prepare("SELECT payload FROM direct_jobs ORDER BY job_id")
      .all()
      .map((row) => JSON.parse(row.payload as string) as Record<string, unknown>);
    const meta = JSON.parse(
      database.prepare("SELECT payload FROM direct_job_meta").get()?.payload as string,
    ) as { revision: number };
    const payload = { schemaVersion: 1 as const, revision: meta.revision, jobs };
    return {
      ...payload,
      checksum: createHash("sha256").update(canonicalJson(payload)).digest("hex"),
    };
  } finally {
    database.close();
  }
}

async function smallLegacy(path: string): Promise<string> {
  const seed = await fixture();
  const store = await openStore(seed);
  const job = (await store.start(input(1))).job;
  await store.requestCancel({ ...scope, jobId: job.jobId });
  const text = canonicalJson(snapshot(seed));
  await writeFile(path, text);
  return text;
}

async function largeLegacy(path: string, count: number, bytes: number): Promise<void> {
  const seed = await fixture();
  const store = await openStore(seed);
  const job = (await store.start(input(1))).job;
  const access = { ...scope, jobId: job.jobId };
  await store.markRunning(access);
  await store.succeed(access, { content: [{ type: "text", text: "" }] });
  const template = snapshot(seed).jobs[0];
  const result = { content: [{ type: "text", text: "x".repeat(bytes) }] };
  const handle = await open(path, "wx");
  const hash = createHash("sha256").update('{"jobs":[');
  try {
    await handle.write('{"schemaVersion":1,"jobs":[');
    for (let index = 0; index < count; index += 1) {
      const text = canonicalJson({
        ...template,
        jobId: randomUUID(),
        operationId: randomUUID(),
        result,
      });
      const part = `${index ? "," : ""}${text}`;
      await handle.write(part);
      hash.update(part);
    }
    hash.update('],"revision":7,"schemaVersion":1}');
    await handle.write(`],"revision":7,"checksum":"${hash.digest("hex")}"}`);
  } finally {
    await handle.close();
  }
}

async function fileHash(path: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function script(body: string): string {
  return `const { DirectJobStore } = await import(${JSON.stringify(moduleUrl)});\n${body}`;
}

function spawnChild(body: string, flags: string[] = []) {
  return spawn(
    process.execPath,
    [...flags, "--import", "tsx", "--input-type=module", "-e", script(body)],
    { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function child(body: string, flags: string[] = []): Promise<unknown> {
  const { stdout } = await exec(
    process.execPath,
    [...flags, "--import", "tsx", "--input-type=module", "-e", script(body)],
    { cwd: resolve("."), windowsHide: true, maxBuffer: 1024 * 1024, timeout: 110_000 },
  );
  return JSON.parse(stdout) as unknown;
}

async function killAtReady(body: string): Promise<void> {
  const process = spawnChild(body);
  const exited = new Promise<void>((resolve) => process.once("exit", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      process.stdout.once("data", () => resolve());
      process.once("error", reject);
      process.once("exit", () => reject(new Error("Writer exited before crash injection")));
    });
  } finally {
    process.kill("SIGKILL");
    await exited;
  }
}

async function removeDatabase(path: string): Promise<void> {
  await Promise.all(
    ["", "-wal", "-shm"].map((suffix) => rm(`${path}.sqlite${suffix}`, { force: true })),
  );
}

function stateEnvelope(payload: unknown): string {
  return canonicalJson({
    payload,
    checksum: createHash("sha256").update(canonicalJson(payload)).digest("hex"),
  });
}
