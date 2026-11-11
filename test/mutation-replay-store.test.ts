import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MutationReplayAcquisition,
  MutationReplayExecution,
  MutationReplayIdentity,
  MutationReplayJsonValue,
} from "../src/infrastructure/mcp/mutation-replay-store.js";
import { canonicalJson } from "../src/infrastructure/safety/canonical-json.js";

type ReplayModule = typeof import("../src/infrastructure/mcp/mutation-replay-store.js");

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.resetModules();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("MutationReplayStore", () => {
  it("offers the same state machine without touching a durable path", async () => {
    const module = await freshModule();
    const store = module.MutationReplayStore.inMemory();
    expect(store.snapshotPath).toBeUndefined();
    const execution = expectExecution(await store.acquire(identity("memory")));
    await execution.markDispatched();
    await execution.complete({ source: "memory" });
    expect(await store.acquire(identity("memory"))).toMatchObject({
      kind: "replay",
      value: { source: "memory" },
    });
  });

  it("elects exactly one executor under concurrent duplicate acquisition", async () => {
    const module = await freshModule();
    const store = module.MutationReplayStore.inMemory();
    const acquisitions = await Promise.all(
      Array.from({ length: 64 }, async () => store.acquire(identity("concurrent"))),
    );
    expect(acquisitions.filter((acquisition) => acquisition.kind === "execute")).toHaveLength(1);
    expect(acquisitions.filter((acquisition) => acquisition.kind === "join")).toHaveLength(63);
    const operationIds = new Set(acquisitions.map((acquisition) => acquisition.operationId));
    expect(operationIds.size).toBe(1);

    const leader = acquisitions.find((acquisition) => acquisition.kind === "execute");
    if (leader === undefined) throw new Error("expected one elected execution");
    const execution = expectExecution(leader);
    await execution.failBeforeDispatch();
  });

  it("coordinates all instances in the process and durably replays one complete result", async () => {
    const module = await freshModule();
    const fixture = await createFixture();
    const firstStore = await module.MutationReplayStore.open(fixture.options);
    const reloadedModule = await freshModule();
    const secondStore = await reloadedModule.MutationReplayStore.open(fixture.options);

    const resultSentinel = "NATIVE_RESULT_MUST_REMAIN_LOSSLESS";
    const first = expectExecution<{ ok: boolean; receipt: string }>(
      await firstStore.acquire<{ ok: boolean; receipt: string }>(fixture.identity),
    );
    const duplicate = await secondStore.acquire<{ ok: boolean; receipt: string }>(fixture.identity);
    expect(duplicate.kind).toBe("join");
    expect(duplicate.operationId).toBe(first.operationId);
    expect(first.operationId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );

    await first.markDispatched();
    await first.complete({ ok: true, receipt: resultSentinel });
    if (duplicate.kind !== "join") throw new Error("expected join");
    await expect(duplicate.completion).resolves.toEqual({
      kind: "completed",
      value: { ok: true, receipt: resultSentinel },
    });

    const replay = await firstStore.acquire<{ ok: boolean; receipt: string }>(fixture.identity);
    expect(replay).toEqual({
      kind: "replay",
      operationId: first.operationId,
      value: { ok: true, receipt: resultSentinel },
    });

    const snapshot = await readFile(fixture.snapshotPath, "utf8");
    expect(snapshot).not.toContain(fixture.identity.authorizationBinding);
    expect(snapshot).not.toContain(fixture.identity.idempotencyKey);
    expect(snapshot).not.toContain(fixture.identity.fingerprint);
    expect(snapshot).toContain(resultSentinel);
    expect(snapshot).toContain('"value"');
  });

  it("rejects reuse of a retained key with a different canonical fingerprint", async () => {
    const module = await freshModule();
    const fixture = await createFixture();
    const store = await module.MutationReplayStore.open(fixture.options);
    const execution = expectExecution(await store.acquire(fixture.identity));

    await expect(
      store.acquire({ ...fixture.identity, fingerprint: "canonical:fingerprint:other" }),
    ).rejects.toMatchObject({
      name: "MutationReplayConflictError",
      code: "MUTATION_IDEMPOTENCY_CONFLICT",
    });

    await execution.failBeforeDispatch("TRANSPORT_NOT_OPENED");
  });

  it("releases only a proven pre-dispatch failure and fences the old attempt", async () => {
    const module = await freshModule();
    const fixture = await createFixture();
    const store = await module.MutationReplayStore.open(fixture.options);
    const first = expectExecution(await store.acquire(fixture.identity));
    const joined = await store.acquire(fixture.identity);
    if (joined.kind !== "join") throw new Error("expected join");

    await first.failBeforeDispatch("PIPE_NOT_CONNECTED");
    await expect(joined.completion).resolves.toEqual({
      kind: "retryable_pre_dispatch_failure",
      code: "PIPE_NOT_CONNECTED",
    });

    const retry = expectExecution(await store.acquire(fixture.identity));
    expect(retry.operationId).toBe(first.operationId);
    expect(retry.attemptId).not.toBe(first.attemptId);
    await expect(first.markDispatched()).rejects.toMatchObject({
      code: "MUTATION_REPLAY_INVALID_TRANSITION",
    });
    await retry.failBeforeDispatch();
  });

  it("accepts an explicit definitely-not-dispatched result after durable dispatch intent", async () => {
    const module = await freshModule();
    const store = module.MutationReplayStore.inMemory();
    const first = expectExecution(await store.acquire(identity("not-dispatched")));
    await first.markDispatched();
    await first.failBeforeDispatch("NATIVE_CLIENT_CONFIRMED_NOT_DISPATCHED");
    expect((await store.acquire(identity("not-dispatched"))).kind).toBe("execute");
  });

  it("losslessly replays a completed mutation after a process restart", async () => {
    const module = await freshModule();
    const fixture = await createFixture();
    const firstStore = await module.MutationReplayStore.open(fixture.options);
    const execution = expectExecution<{ receipt: string }>(
      await firstStore.acquire<{ receipt: string }>(fixture.identity),
    );
    await execution.markDispatched();
    await execution.complete({ receipt: "known-success" });

    const replay = await acquireInFreshProcess(fixture, "read");
    expect(replay).toEqual({
      kind: "replay",
      operationId: execution.operationId,
      value: { receipt: "known-success" },
    });
    expect(await readFile(fixture.snapshotPath, "utf8")).toContain("known-success");
  });

  it("preserves a completed result from an earlier compatible snapshot", async () => {
    const module = await freshModule();
    const fixture = await createFixture();
    const sentinel = "LEGACY_NATIVE_RESULT_PLAINTEXT_SENTINEL";
    await writeLegacyCompletedSnapshot(fixture, sentinel);

    const store = await module.MutationReplayStore.open(fixture.options);
    expect(await store.acquire(fixture.identity)).toMatchObject({
      kind: "replay",
      value: { receipt: sentinel },
    });
    await expect(
      store.acquire({ ...fixture.identity, fingerprint: "canonical:fingerprint:changed" }),
    ).rejects.toMatchObject({ code: "MUTATION_IDEMPOTENCY_CONFLICT" });

    const preserved = await readFile(fixture.snapshotPath, "utf8");
    expect(preserved).toContain('"state":"completed"');
    expect(preserved).toContain(sentinel);
    expect(preserved).toContain('"value"');
  });

  it("retries a restart-abandoned prepared attempt but never reruns a dispatched attempt", async () => {
    const module = await freshModule();
    const preparedFixture = await createFixture();
    const preparedStore = await module.MutationReplayStore.open(preparedFixture.options);
    const abandoned = expectExecution(await preparedStore.acquire(preparedFixture.identity));

    const retry = await acquireInFreshProcess(preparedFixture, "mark_dispatched");
    expect(retry.kind).toBe("execute");
    expect(retry.operationId).toBe(abandoned.operationId);
    expect(retry.attemptId).not.toBe(abandoned.attemptId);

    const unknown = await acquireInFreshProcess(preparedFixture, "read");
    expect(unknown).toEqual({
      kind: "outcome_unknown",
      operationId: abandoned.operationId,
      code: "PROCESS_RESTART_AFTER_DISPATCH",
    });
  });

  it("retains every in-flight and unknown record while bounding completed result payloads", async () => {
    const module = await freshModule();
    const fixture = await createFixture(1);
    const store = await module.MutationReplayStore.open(fixture.options);
    const inFlightIdentity = identity("in-flight");
    const unknownIdentity = identity("unknown");
    const oldCompletedIdentity = identity("completed-old");
    const newCompletedIdentity = identity("completed-new");

    const inFlight = expectExecution(await store.acquire(inFlightIdentity));
    const unknown = expectExecution(await store.acquire(unknownIdentity));
    await unknown.markDispatched();
    await unknown.markOutcomeUnknown("TRANSPORT_LOST_AFTER_SEND");

    const oldCompleted = expectExecution(await store.acquire(oldCompletedIdentity));
    await oldCompleted.markDispatched();
    await oldCompleted.complete({ sequence: 1 });
    const newCompleted = expectExecution(await store.acquire(newCompletedIdentity));
    await newCompleted.markDispatched();
    await newCompleted.complete({ sequence: 2 });

    expect((await store.acquire(inFlightIdentity)).kind).toBe("join");
    expect(await store.acquire(unknownIdentity)).toMatchObject({
      kind: "outcome_unknown",
      code: "TRANSPORT_LOST_AFTER_SEND",
    });
    expect(await store.acquire(oldCompletedIdentity)).toMatchObject({
      kind: "outcome_unknown",
      code: "RESULT_REPLAY_EXPIRED",
    });
    expect(await store.acquire(newCompletedIdentity)).toMatchObject({
      kind: "replay",
      value: { sequence: 2 },
    });

    await inFlight.failBeforeDispatch();
  });

  it("never re-executes a completed key after result retention overflows", async () => {
    const module = await freshModule();
    const store = module.MutationReplayStore.inMemory({ maxCompletedEntries: 1 });
    const firstIdentity = identity("overflow-first");
    const secondIdentity = identity("overflow-second");

    const first = expectExecution(await store.acquire(firstIdentity));
    await first.markDispatched();
    await first.complete({ receipt: "first" });

    const second = expectExecution(await store.acquire(secondIdentity));
    await second.markDispatched();
    await second.complete({ receipt: "second" });

    expect(await store.acquire(firstIdentity)).toEqual({
      kind: "outcome_unknown",
      operationId: first.operationId,
      code: "RESULT_REPLAY_EXPIRED",
    });
    await expect(
      store.acquire({ ...firstIdentity, fingerprint: "canonical:fingerprint:changed" }),
    ).rejects.toMatchObject({
      code: "MUTATION_IDEMPOTENCY_CONFLICT",
    });
    expect(await store.acquire(secondIdentity)).toMatchObject({
      kind: "replay",
      value: { receipt: "second" },
    });
  });

  it("persists completed tombstones across restart after result retention overflows", async () => {
    const module = await freshModule();
    const fixture = await createFixture(1);
    const store = await module.MutationReplayStore.open(fixture.options);
    const expiredIdentity = identity("restart-expired");
    const retainedIdentity = identity("restart-retained");

    const expired = expectExecution(await store.acquire(expiredIdentity));
    await expired.markDispatched();
    await expired.complete({ receipt: "PRUNED_RESULT_PAYLOAD_SENTINEL" });
    const retained = expectExecution(await store.acquire(retainedIdentity));
    await retained.markDispatched();
    await retained.complete({ receipt: "retained" });

    const restarted = await acquireIdentityInFreshProcess(fixture, expiredIdentity);
    expect(restarted).toEqual({
      kind: "outcome_unknown",
      operationId: expired.operationId,
      code: "RESULT_REPLAY_EXPIRED",
    });

    const snapshot = await readFile(fixture.snapshotPath, "utf8");
    expect(snapshot).toContain('"state":"result_replay_expired"');
    expect(snapshot).not.toContain("PRUNED_RESULT_PAYLOAD_SENTINEL");
  });

  it("has no default completed-result count cap and accepts unbounded stable identity text", async () => {
    const module = await freshModule();
    const store = module.MutationReplayStore.inMemory();
    const identities = Array.from({ length: 4_097 }, (_, index) => ({
      authorizationBinding: `${"owner".repeat(1_000)}\0${String(index)}`,
      idempotencyKey: `stable-${String(index)}-${"k".repeat(600)}`,
      fingerprint: `canonical-${String(index)}-${"f".repeat(8_300)}`,
    }));

    for (const [index, replayIdentity] of identities.entries()) {
      const execution = expectExecution(await store.acquire(replayIdentity));
      await execution.markDispatched();
      await execution.complete({ index });
    }

    expect(await store.acquire(identities[0] as MutationReplayIdentity)).toMatchObject({
      kind: "replay",
      value: { index: 0 },
    });
    expect(await store.acquire(identities.at(-1) as MutationReplayIdentity)).toMatchObject({
      kind: "replay",
      value: { index: 4_096 },
    });
  }, 60_000);

  it("rejects a non-JSON result without losing the dispatched tombstone", async () => {
    const module = await freshModule();
    const fixture = await createFixture();
    const store = await module.MutationReplayStore.open(fixture.options);
    const execution = expectExecution(await store.acquire(fixture.identity));
    await execution.markDispatched();

    await expect(execution.complete({ invalid: Number.NaN })).rejects.toThrow(/JSON value/);
    expect((await store.acquire(fixture.identity)).kind).toBe("join");
    await execution.markOutcomeUnknown("INVALID_RESULT_ENCODING");
    expect(await store.acquire(fixture.identity)).toMatchObject({
      kind: "outcome_unknown",
      code: "INVALID_RESULT_ENCODING",
    });
  });

  it("fails closed on a corrupt durable snapshot", async () => {
    const module = await freshModule();
    const fixture = await createFixture();
    await mkdir(join(fixture.snapshotPath, ".."), { recursive: true });
    await writeFile(
      fixture.snapshotPath,
      `${JSON.stringify({ schemaVersion: 1, revision: 0, records: [], checksum: "0".repeat(64) })}\n`,
      "utf8",
    );

    await expect(module.MutationReplayStore.open(fixture.options)).rejects.toMatchObject({
      name: "MutationReplaySnapshotError",
      code: "MUTATION_REPLAY_SNAPSHOT_INVALID",
    });
  });

  it("isolates identical idempotency keys across authorization bindings", async () => {
    const module = await freshModule();
    const fixture = await createFixture();
    const store = await module.MutationReplayStore.open(fixture.options);
    const first = expectExecution(await store.acquire(fixture.identity));
    const second = expectExecution(
      await store.acquire({ ...fixture.identity, authorizationBinding: "issuer\0other-subject" }),
    );
    expect(second.operationId).not.toBe(first.operationId);
    await first.failBeforeDispatch();
    await second.failBeforeDispatch();
  });
});

async function freshModule(): Promise<ReplayModule> {
  vi.resetModules();
  return import("../src/infrastructure/mcp/mutation-replay-store.js");
}

async function createFixture(maxCompletedEntries?: number): Promise<{
  snapshotPath: string;
  options: { snapshotPath: string; maxCompletedEntries?: number };
  identity: MutationReplayIdentity;
}> {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-mutation-replay-"));
  temporaryDirectories.push(directory);
  const snapshotPath = join(directory, "state", "mutation-replay-store.json");
  return {
    snapshotPath,
    options: {
      snapshotPath,
      ...(maxCompletedEntries === undefined ? {} : { maxCompletedEntries }),
    },
    identity: identity("primary"),
  };
}

function identity(suffix: string): MutationReplayIdentity {
  return {
    authorizationBinding: `https://issuer.example\0owner-subject\0client\0resource-${suffix}`,
    idempotencyKey: `stable-idempotency-${suffix}`,
    fingerprint: `canonical:fingerprint:${suffix}`,
  };
}

function expectExecution<T extends MutationReplayJsonValue = MutationReplayJsonValue>(
  acquisition: MutationReplayAcquisition<T>,
): MutationReplayExecution<T> {
  if (acquisition.kind !== "execute") {
    throw new Error(`expected execution, received ${acquisition.kind}`);
  }
  expect(acquisition.operationId).toBe(acquisition.execution.operationId);
  return acquisition.execution;
}

async function acquireInFreshProcess(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  action: "read" | "mark_dispatched",
): Promise<Record<string, unknown>> {
  const moduleUrl = pathToFileURL(
    resolve("src", "infrastructure", "mcp", "mutation-replay-store.ts"),
  ).href;
  const script = `
    import { MutationReplayStore } from ${JSON.stringify(moduleUrl)};
    const store = await MutationReplayStore.open(${JSON.stringify(fixture.options)});
    const acquisition = await store.acquire(${JSON.stringify(fixture.identity)});
    if (${JSON.stringify(action)} === "mark_dispatched") {
      if (acquisition.kind !== "execute") throw new Error("expected recovered execution");
      await acquisition.execution.markDispatched();
    }
    const output = acquisition.kind === "execute"
      ? { kind: acquisition.kind, operationId: acquisition.operationId, attemptId: acquisition.execution.attemptId }
      : acquisition.kind === "replay"
        ? { kind: acquisition.kind, operationId: acquisition.operationId, value: acquisition.value }
        : acquisition.kind === "outcome_unknown"
          ? { kind: acquisition.kind, operationId: acquisition.operationId, code: acquisition.code }
          : { kind: acquisition.kind, operationId: acquisition.operationId };
    process.stdout.write(JSON.stringify(output) + "\\n");
  `;
  const stdout = await executeNode(script);
  const line = stdout
    .split(/\r?\n/)
    .filter((candidate) => candidate.length > 0)
    .at(-1);
  if (line === undefined) throw new Error("fresh process produced no replay result");
  return JSON.parse(line) as Record<string, unknown>;
}

async function acquireIdentityInFreshProcess(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  replayIdentity: MutationReplayIdentity,
): Promise<Record<string, unknown>> {
  const moduleUrl = pathToFileURL(
    resolve("src", "infrastructure", "mcp", "mutation-replay-store.ts"),
  ).href;
  const script = `
    import { MutationReplayStore } from ${JSON.stringify(moduleUrl)};
    const store = await MutationReplayStore.open(${JSON.stringify(fixture.options)});
    const acquisition = await store.acquire(${JSON.stringify(replayIdentity)});
    const output = acquisition.kind === "execute"
      ? { kind: acquisition.kind, operationId: acquisition.operationId, attemptId: acquisition.execution.attemptId }
      : acquisition.kind === "replay"
        ? { kind: acquisition.kind, operationId: acquisition.operationId, value: acquisition.value }
        : acquisition.kind === "outcome_unknown"
          ? { kind: acquisition.kind, operationId: acquisition.operationId, code: acquisition.code }
          : { kind: acquisition.kind, operationId: acquisition.operationId };
    process.stdout.write(JSON.stringify(output) + "\\n");
  `;
  const stdout = await executeNode(script);
  const line = stdout
    .split(/\r?\n/)
    .filter((candidate) => candidate.length > 0)
    .at(-1);
  if (line === undefined) throw new Error("fresh process produced no replay result");
  return JSON.parse(line) as Record<string, unknown>;
}

async function writeLegacyCompletedSnapshot(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  resultSentinel: string,
): Promise<void> {
  const identityHash = createHash("sha256")
    .update("omnicodex-mutation-replay-v1\0", "utf8")
    .update(String(Buffer.byteLength(fixture.identity.authorizationBinding)), "utf8")
    .update(":", "utf8")
    .update(fixture.identity.authorizationBinding, "utf8")
    .update("\0", "utf8")
    .update(String(Buffer.byteLength(fixture.identity.idempotencyKey)), "utf8")
    .update(":", "utf8")
    .update(fixture.identity.idempotencyKey, "utf8")
    .digest("hex");
  const fingerprintDigest = createHash("sha256")
    .update(fixture.identity.fingerprint, "utf8")
    .digest("hex");
  const payload = {
    schemaVersion: 1,
    revision: 3,
    records: [
      {
        recordId: identityHash,
        fingerprintDigest,
        state: "completed",
        attemptId: "12345678-1234-4123-8123-123456789abc",
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
        terminalSequence: 3,
        value: { receipt: resultSentinel },
      },
    ],
  } as const;
  const checksum = createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
  await mkdir(dirname(fixture.snapshotPath), { recursive: true });
  await writeFile(fixture.snapshotPath, `${canonicalJson({ ...payload, checksum })}\n`, "utf8");
}

function executeNode(script: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 1_048_576,
        shell: false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolvePromise(stdout);
          return;
        }
        rejectPromise(new Error(`fresh process failed: ${stderr || error.message}`));
      },
    );
  });
}
