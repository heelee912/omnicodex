import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LegacyMutationAcquisition,
  LegacyMutationExecution,
  LegacyMutationJsonValue,
  LegacyMutationRequestContext,
} from "../src/infrastructure/mcp/legacy-mutation-coordinator.js";
import { canonicalJson } from "../src/infrastructure/safety/canonical-json.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.resetModules();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("LegacyMutationCoordinator", () => {
  it("isolates input, joined completions, and replays without serializing result strings", async () => {
    const module = await freshModule();
    const coordinator = module.LegacyMutationCoordinator.inMemory();
    const context = request("auth", "clone-isolation", "session", "request");
    type Value = { nested: [{ text: string }]; __proto__: { original: boolean } };
    const value = JSON.parse(
      '{"nested":[{"text":"original"}],"__proto__":{"original":true}}',
    ) as Value;
    const leader = expectExecution<Value>(await coordinator.acquire<Value>(context));
    const follower = await coordinator.acquire<Value>(context);
    if (follower.kind !== "join") throw new Error("expected join");
    const stringify = vi.spyOn(JSON, "stringify");
    await leader.finish(value);
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
    value.nested[0].text = "input changed";
    const first = await leader.completion;
    const second = await follower.completion;
    if (first.kind !== "completed" || second.kind !== "completed")
      throw new Error("expected completion");
    first.value.nested[0].text = "leader changed";
    expect(second.value.nested[0].text).toBe("original");
    expect(Object.hasOwn(second.value, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(second.value)).toBe(Object.prototype);
    const replay = await coordinator.acquire<Value>(context);
    if (replay.kind !== "replay") throw new Error("expected replay");
    replay.value.nested[0].text = "replay changed";
    expect(await coordinator.acquire<Value>(context)).toMatchObject({
      kind: "replay",
      value: { nested: [{ text: "original" }] },
    });
  });

  it("joins and replays an exact session/request without exposing cancellation", async () => {
    const module = await freshModule();
    const coordinator = module.LegacyMutationCoordinator.inMemory();
    const first = expectExecution<{ ok: boolean }>(
      await coordinator.acquire<{ ok: boolean }>(request("auth", "semantic", "session-a", "1")),
    );
    const duplicate = await coordinator.acquire<{ ok: boolean }>(
      request("auth", "semantic", "session-a", "1"),
    );

    expect(duplicate.kind).toBe("join");
    expect(duplicate.operationId).toBe(first.operationId);
    expect(first.operationId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect("signal" in first).toBe(false);

    await first.finish({ ok: true });
    if (duplicate.kind !== "join") throw new Error("expected a joined follower");
    await expect(duplicate.completion).resolves.toEqual({
      kind: "completed",
      value: { ok: true },
    });
    await expect(first.completion).resolves.toEqual({ kind: "completed", value: { ok: true } });
    expect(
      await coordinator.acquire<{ ok: boolean }>(request("auth", "semantic", "session-a", "1")),
    ).toEqual({ kind: "replay", operationId: first.operationId, value: { ok: true } });
  });

  it("does not infer cross-session retry identity from identical in-flight arguments", async () => {
    const module = await freshModule();
    const coordinator = module.LegacyMutationCoordinator.inMemory();
    const acquisitions = await Promise.allSettled(
      Array.from({ length: 64 }, async (_, index) =>
        coordinator.acquire(request("auth", "semantic", `session-${index}`, index)),
      ),
    );

    expect(acquisitions.filter((candidate) => candidate.status === "fulfilled")).toHaveLength(1);
    const rejected = acquisitions.filter((candidate) => candidate.status === "rejected");
    expect(rejected).toHaveLength(63);
    for (const candidate of rejected) {
      expect(candidate.reason).toMatchObject({ code: "AMBIGUOUS_LEGACY_MUTATION_COHORT" });
    }
    const leader = acquisitions.find((candidate) => candidate.status === "fulfilled");
    if (leader?.status !== "fulfilled") throw new Error("expected elected leader");
    await expectExecution(leader.value).finish({ receipt: "single-dispatch" });
  });

  it("treats a different request ID in the same session as a new intended action", async () => {
    const module = await freshModule();
    const coordinator = module.LegacyMutationCoordinator.inMemory();
    const first = expectExecution(
      await coordinator.acquire(request("auth", "semantic", "session-a", "request-1")),
    );
    const second = expectExecution(
      await coordinator.acquire(request("auth", "semantic", "session-a", "request-2")),
    );

    expect(second.operationId).not.toBe(first.operationId);
    await expect(
      coordinator.acquire(request("auth", "semantic", "session-b", "request-3")),
    ).rejects.toMatchObject({
      name: "LegacyMutationAmbiguityError",
      code: "AMBIGUOUS_LEGACY_MUTATION_COHORT",
    });
    await first.failBeforeDispatch();
    await second.failBeforeDispatch();
  });

  it("partitions identical semantic digests by authorization digest", async () => {
    const module = await freshModule();
    const coordinator = module.LegacyMutationCoordinator.inMemory();
    const first = expectExecution(
      await coordinator.acquire(request("auth-a", "semantic", "session-a", 1)),
    );
    const second = expectExecution(
      await coordinator.acquire(request("auth-b", "semantic", "session-b", 2)),
    );

    expect(second.operationId).not.toBe(first.operationId);
    await first.failBeforeDispatch();
    await second.failBeforeDispatch();
  });

  it("keeps a completed cohort replayable without an implicit admission deadline", async () => {
    let now = 0;
    const module = await freshModule();
    const coordinator = module.LegacyMutationCoordinator.inMemory({ nowUnixMs: () => now });
    const first = expectExecution<{ result: string }>(
      await coordinator.acquire<{ result: string }>(
        request("auth", "semantic", "session-a", "request-a"),
      ),
    );

    await first.finish({ result: "done" });
    now = 365 * 24 * 60 * 60 * 1_000;
    expect(
      await coordinator.acquire<{ result: string }>(
        request("auth", "semantic", "session-a", "request-a"),
      ),
    ).toEqual({ kind: "replay", operationId: first.operationId, value: { result: "done" } });
  });

  it("requires request identity for a late retry of an in-flight execution", async () => {
    let now = 100;
    const module = await freshModule();
    const coordinator = module.LegacyMutationCoordinator.inMemory({ nowUnixMs: () => now });
    const leader = expectExecution(
      await coordinator.acquire(request("auth", "semantic", "session-a", "request-a")),
    );

    now = 365 * 24 * 60 * 60 * 1_000;
    await expect(
      coordinator.acquire(request("auth", "semantic", "session-b", "request-b")),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_LEGACY_MUTATION_COHORT" });
    const lateRetry = await coordinator.acquire(
      request("auth", "semantic", "session-a", "request-a"),
    );
    expect(
      await coordinator.acquire(request("auth", "semantic", "session-a", "request-a")),
    ).toMatchObject({ kind: "join", operationId: leader.operationId });

    const independent = expectExecution(
      await coordinator.acquire(request("auth", "semantic", "session-a", "request-new")),
    );
    await leader.finish({ result: "late-authoritative-result" });
    if (lateRetry.kind !== "join") throw new Error("expected late retry to join");
    await expect(lateRetry.completion).resolves.toEqual({
      kind: "completed",
      value: { result: "late-authoritative-result" },
    });
    await independent.failBeforeDispatch();
  });

  it("does not replay completed observations on fresh connections reusing a JSON-RPC id", async () => {
    let now = 0;
    const module = await freshModule();
    const coordinator = module.LegacyMutationCoordinator.inMemory({ nowUnixMs: () => now });
    const old = expectExecution(
      await coordinator.acquire(request("auth", "semantic", "old-session", 1)),
    );
    await old.finish({ old: true });

    now = 365 * 24 * 60 * 60 * 1_000;
    for (const session of ["new-session", "another-session"]) {
      const fresh = expectExecution(
        await coordinator.acquire(request("auth", "semantic", session, 1)),
      );
      expect(fresh.operationId).not.toBe(old.operationId);
      await fresh.finish({ observedAt: session });
      expect(await coordinator.acquire(request("auth", "semantic", session, 1))).toEqual({
        kind: "replay",
        operationId: fresh.operationId,
        value: { observedAt: session },
      });
    }
  });

  it("releases only a proven pre-dispatch failure and fences the stale handle", async () => {
    const module = await freshModule();
    const coordinator = module.LegacyMutationCoordinator.inMemory();
    const context = request("auth", "semantic", "session-a", "request-a");
    const first = expectExecution(await coordinator.acquire(context));
    const follower = await coordinator.acquire(context);
    if (follower.kind !== "join") throw new Error("expected follower");

    await first.failBeforeDispatch("NATIVE_CLIENT_CONFIRMED_NOT_DISPATCHED");
    await expect(follower.completion).resolves.toEqual({
      kind: "retryable_pre_dispatch_failure",
      code: "NATIVE_CLIENT_CONFIRMED_NOT_DISPATCHED",
    });
    const retry = expectExecution(await coordinator.acquire(context));
    expect(retry.operationId).toBe(first.operationId);
    expect(retry.attemptId).not.toBe(first.attemptId);
    await expect(first.finish({ stale: true })).rejects.toMatchObject({
      code: "LEGACY_MUTATION_INVALID_TRANSITION",
    });
    await retry.failBeforeDispatch();
  });

  it("retains an unknown outcome across the window and never automatically reruns it", async () => {
    let now = 0;
    const module = await freshModule();
    const coordinator = module.LegacyMutationCoordinator.inMemory({ nowUnixMs: () => now });
    const leader = expectExecution(
      await coordinator.acquire(request("auth", "semantic", "session-a", "request-a")),
    );
    await leader.outcomeUnknown("TRANSPORT_LOST_AFTER_SEND");

    now = 50_000;
    expect(
      await coordinator.acquire(request("auth", "semantic", "session-a", "request-a")),
    ).toEqual({
      kind: "outcome_unknown",
      operationId: leader.operationId,
      code: "TRANSPORT_LOST_AFTER_SEND",
    });
    await expect(
      coordinator.acquire(request("auth", "semantic", "session-b", "request-b")),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_LEGACY_MUTATION_COHORT" });
  });

  it("rejects one session/request reused for different semantics", async () => {
    const module = await freshModule();
    const coordinator = module.LegacyMutationCoordinator.inMemory();
    const first = expectExecution(
      await coordinator.acquire(request("auth", "semantic-a", "session-a", "request-a")),
    );
    await expect(
      coordinator.acquire(request("auth", "semantic-b", "session-a", "request-a")),
    ).rejects.toMatchObject({
      name: "LegacyMutationRequestConflictError",
      code: "LEGACY_MUTATION_REQUEST_CONFLICT",
    });
    await first.failBeforeDispatch();
  });

  it("shares one durable core and persists full results without persisting raw identity", async () => {
    const module = await freshModule();
    const fixture = await createFixture();
    const now = () => 1_000;
    const firstCoordinator = await module.LegacyMutationCoordinator.open({
      snapshotPath: fixture.snapshotPath,
      nowUnixMs: now,
    });
    const secondCoordinator = await module.LegacyMutationCoordinator.open({
      snapshotPath: fixture.snapshotPath,
      nowUnixMs: now,
    });
    const context = request(
      "private\0authorization\0material",
      "raw-mutation-arguments",
      "raw-session-secret",
      "raw-request-secret",
    );
    const leader = expectExecution(await firstCoordinator.acquire(context));
    expect(await secondCoordinator.acquire(context)).toMatchObject({
      kind: "join",
      operationId: leader.operationId,
    });
    const resultSentinel = "PRIVATE_THREAD_TITLE_AND_NATIVE_TARGET_SENTINEL";
    await leader.finish({ receipt: resultSentinel });

    expect(await secondCoordinator.acquire(context)).toEqual({
      kind: "replay",
      operationId: leader.operationId,
      value: { receipt: resultSentinel },
    });

    await firstCoordinator.compact();
    const snapshot = await readFile(fixture.snapshotPath, "utf8");
    expect(snapshot).toContain(context.semanticDigest);
    expect(snapshot).not.toContain(context.authorizationBinding);
    expect(snapshot).not.toContain("raw-mutation-arguments");
    expect(snapshot).not.toContain("raw-session-secret");
    expect(snapshot).not.toContain("raw-request-secret");
    expect(snapshot).toContain(resultSentinel);
    expect(snapshot).toContain('"value"');
  });

  it("appends durable deltas instead of rewriting the full replay snapshot per mutation", async () => {
    const module = await freshModule();
    const fixture = await createFixture();
    const coordinator = await module.LegacyMutationCoordinator.open({
      snapshotPath: fixture.snapshotPath,
      journalCompactionEntries: 100,
      nowUnixMs: () => 1_000,
    });
    const firstContext = request("auth", "semantic-a", "session-a", "request-a");
    const first = expectExecution(await coordinator.acquire(firstContext));
    const originalSnapshot = await readFile(fixture.snapshotPath, "utf8");

    await first.finish({ receipt: "x".repeat(256 * 1024) });
    const second = expectExecution(
      await coordinator.acquire(request("auth", "semantic-b", "session-b", "request-b")),
    );
    await second.finish({ receipt: "second" });

    expect(await readFile(fixture.snapshotPath, "utf8")).toBe(originalSnapshot);
    const journalNames = (await readdir(`${fixture.snapshotPath}.journal.d`)).filter((name) =>
      /^[0-9]{20}\.json$/.test(name),
    );
    expect(journalNames).toHaveLength(3);
    expect(await coordinator.acquire(firstContext)).toMatchObject({
      kind: "replay",
      value: { receipt: "x".repeat(256 * 1024) },
    });
  });

  it("compacts and reloads losslessly without an archive-sized JSON string", async () => {
    const module = await freshModule();
    const fixture = await createFixture();
    const coordinator = await module.LegacyMutationCoordinator.open({
      snapshotPath: fixture.snapshotPath,
      journalCompactionEntries: 2,
      nowUnixMs: () => 1_000,
    });
    const canonical = await import("../src/infrastructure/safety/canonical-json.js");
    const originalCanonical = canonical.canonicalJson;
    const canonicalSpy = vi.spyOn(canonical, "canonicalJson").mockImplementation((value) => {
      if (value !== null && typeof value === "object")
        throw new RangeError("simulated archive string limit");
      return originalCanonical(value);
    });
    const contexts = Array.from({ length: 5 }, (_, index) =>
      request("auth", `stream-${index}`, "session", String(index)),
    );
    const value = {
      text: '한글😀},["records":\\\n'.repeat(4_000),
      nested: [{ quote: '\\"[]{}', empty: [], null: null }],
    };
    try {
      for (const context of contexts) {
        const execution = expectExecution(await coordinator.acquire(context));
        await execution.finish(value);
      }
      // Automatic compaction has occurred; keep one terminal delta to exercise
      // snapshot + journal restart recovery together.
    } finally {
      canonicalSpy.mockRestore();
    }
    const raw = await readFile(fixture.snapshotPath, "utf8");
    expect(raw.length).toBeGreaterThan(200_000);
    const persisted = JSON.parse(raw);
    expect(raw).toBe(`${canonicalJson(persisted)}\n`);
    // A distinct path prevents the process-wide live coordinator registry from
    // answering the reopen without loading the persisted bytes.
    const restoredFixture = await createFixture();
    await cp(fixture.snapshotPath, restoredFixture.snapshotPath);
    await cp(`${fixture.snapshotPath}.journal.d`, `${restoredFixture.snapshotPath}.journal.d`, {
      recursive: true,
    });
    const originalParse = JSON.parse;
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (text.length > 200_000) throw new RangeError("simulated archive string limit");
      return originalParse(text, reviver);
    });
    try {
      const reloadedModule = await freshModule();
      const reloaded = await reloadedModule.LegacyMutationCoordinator.open({
        snapshotPath: restoredFixture.snapshotPath,
        nowUnixMs: () => 1_500,
      });
      for (const context of contexts)
        expect(await reloaded.acquire(context)).toMatchObject({ kind: "replay", value });
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("recovers any restart-abandoned in-flight cohort as outcome unknown", async () => {
    const module = await freshModule();
    const fixture = await createFixture();
    const context = request("auth", "semantic", "session-a", "request-a");
    const coordinator = await module.LegacyMutationCoordinator.open({
      snapshotPath: fixture.snapshotPath,
      nowUnixMs: () => 1_000,
    });
    const leader = expectExecution(await coordinator.acquire(context));

    const recovered = await acquireInFreshProcess(fixture.snapshotPath, 1_500, context, "read");
    expect(recovered).toEqual({
      kind: "outcome_unknown",
      operationId: leader.operationId,
      code: "PROCESS_RESTART_LEGACY_MUTATION_IN_FLIGHT",
    });
  });

  it("losslessly replays a completed cohort after restart", async () => {
    let now = 1_000;
    const module = await freshModule();
    const fixture = await createFixture();
    const coordinator = await module.LegacyMutationCoordinator.open({
      snapshotPath: fixture.snapshotPath,
      nowUnixMs: () => now,
    });
    const leader = expectExecution<{ receipt: string }>(
      await coordinator.acquire<{ receipt: string }>(
        request("auth", "semantic", "session-a", "request-a"),
      ),
    );
    now = 2_000;
    await leader.finish({ receipt: "known" });

    const recovered = await acquireInFreshProcess(
      fixture.snapshotPath,
      5_999,
      request("auth", "semantic", "session-a", "request-a"),
      "read",
    );
    expect(recovered).toEqual({
      kind: "replay",
      operationId: leader.operationId,
      value: { receipt: "known" },
    });
  });

  it("preserves a compatible completed snapshot that contains a full result", async () => {
    let now = 1_000;
    const module = await freshModule();
    const fixture = await createFixture();
    const context = request("auth", "semantic", "session-a", "request-a");
    const coordinator = await module.LegacyMutationCoordinator.open({
      snapshotPath: fixture.snapshotPath,
      nowUnixMs: () => now,
    });
    const leader = expectExecution(await coordinator.acquire(context));
    now = 2_000;
    await leader.finish({ receipt: "safe-live-result" });
    await coordinator.compact();

    const safeSnapshot = JSON.parse(await readFile(fixture.snapshotPath, "utf8")) as {
      schemaVersion: number;
      revision: number;
      records: Array<Record<string, unknown>>;
      checksum: string;
    };
    const legacySentinel = "LEGACY_RAW_THREAD_ID_TITLE_TARGET_SENTINEL";
    const legacyValue = {
      nativeTarget: legacySentinel,
      nested: [{ z: 'quotes"\n한글😀', a: [null, true, false, 1.25, -10] }, {}, []],
      image: { type: "image", data: "aGVsbG8=".repeat(8_192) },
    };
    const legacyPayload = {
      schemaVersion: safeSnapshot.schemaVersion,
      revision: safeSnapshot.revision,
      records: safeSnapshot.records.map((record) => ({
        ...record,
        value: legacyValue,
      })),
    };
    const legacySnapshot = {
      ...legacyPayload,
      checksum: createHash("sha256").update(canonicalJson(legacyPayload), "utf8").digest("hex"),
    };
    await writeFile(fixture.snapshotPath, `${canonicalJson(legacySnapshot)}\n`, "utf8");

    const recovered = await acquireInFreshProcess(fixture.snapshotPath, 2_500, context, "read");
    expect(recovered).toEqual({
      kind: "replay",
      operationId: leader.operationId,
      value: legacyValue,
    });

    const rewritten = await readFile(fixture.snapshotPath, "utf8");
    expect(rewritten).toContain(legacySentinel);
    expect(rewritten).toContain('"value"');
    expect(rewritten).toContain('"state":"completed"');
  });

  it("bounds completed result payloads without evicting in-flight or unknown safety state", async () => {
    const module = await freshModule();
    const coordinator = module.LegacyMutationCoordinator.inMemory({ maxCompletedResults: 1 });
    const oldContext = request("auth", "semantic-old", "session-old", "request-old");
    const newContext = request("auth", "semantic-new", "session-new", "request-new");
    const unknownContext = request(
      "auth",
      "semantic-unknown",
      "session-unknown",
      "request-unknown",
    );
    const inFlightContext = request(
      "auth",
      "semantic-inflight",
      "session-inflight",
      "request-inflight",
    );

    const old = expectExecution(await coordinator.acquire(oldContext));
    await old.finish({ sequence: 1 });
    const unknown = expectExecution(await coordinator.acquire(unknownContext));
    await unknown.outcomeUnknown("UNKNOWN_RECEIPT");
    const inFlight = expectExecution(await coordinator.acquire(inFlightContext));
    const newest = expectExecution(await coordinator.acquire(newContext));
    await newest.finish({ sequence: 2 });

    expect(await coordinator.acquire(oldContext)).toEqual({
      kind: "outcome_unknown",
      operationId: old.operationId,
      code: "LEGACY_MUTATION_RESULT_REPLAY_EXPIRED",
    });
    expect(await coordinator.acquire(newContext)).toMatchObject({
      kind: "replay",
      value: { sequence: 2 },
    });
    expect(await coordinator.acquire(unknownContext)).toMatchObject({
      kind: "outcome_unknown",
      code: "UNKNOWN_RECEIPT",
    });
    expect(await coordinator.acquire(inFlightContext)).toMatchObject({
      kind: "join",
      operationId: inFlight.operationId,
    });
    await inFlight.failBeforeDispatch();
  });

  it("has no default replay count or opaque-context cap and preserves a large result", async () => {
    const module = await freshModule();
    const coordinator = module.LegacyMutationCoordinator.inMemory();
    const authorizationBinding = `authorization:${"owner".repeat(1_000)}\0\r\n`;
    const contexts = Array.from({ length: 4_097 }, (_, index) => ({
      authorizationBinding,
      semanticDigest: digest(`unbounded-semantic:${String(index)}`),
      sessionId: `session-${String(index)}-${"s".repeat(4_100)}\0\r\n`,
      requestId: `request-${String(index)}-${"r".repeat(4_100)}\0\r\n`,
    }));

    for (const [index, context] of contexts.entries()) {
      const execution = expectExecution(await coordinator.acquire(context));
      await execution.finish({ index });
    }

    const largePayload = "full-result-".padEnd(1_500_000, "x");
    const largeContext = request(
      "large-owner",
      "large-result",
      "large-result-session",
      "large-result-request",
    );
    const largeExecution = expectExecution<{ payload: string }>(
      await coordinator.acquire<{ payload: string }>(largeContext),
    );
    await largeExecution.finish({ payload: largePayload });

    expect(await coordinator.acquire(contexts[0] as LegacyMutationRequestContext)).toMatchObject({
      kind: "replay",
      value: { index: 0 },
    });
    expect(
      await coordinator.acquire(contexts.at(-1) as LegacyMutationRequestContext),
    ).toMatchObject({ kind: "replay", value: { index: 4_096 } });
    expect(await coordinator.acquire<{ payload: string }>(largeContext)).toMatchObject({
      kind: "replay",
      value: { payload: largePayload },
    });

    expect(() =>
      module.LegacyMutationCoordinator.inMemory({ maxCompletedResults: 100_001 }),
    ).not.toThrow();
  }, 60_000);

  it("preserves an explicitly reported long outcome code without truncation", async () => {
    const module = await freshModule();
    const coordinator = module.LegacyMutationCoordinator.inMemory();
    const context = request("auth", "long-outcome", "session", "request");
    const execution = expectExecution(await coordinator.acquire(context));
    const code = `NATIVE_OUTCOME_${"DETAIL_".repeat(1_000)}`;

    await execution.outcomeUnknown(code);

    expect(await coordinator.acquire(context)).toEqual({
      kind: "outcome_unknown",
      operationId: execution.operationId,
      code,
    });
  });

  it("fails closed on a corrupt checksummed snapshot", async () => {
    const module = await freshModule();
    const fixture = await createFixture();
    await writeFile(
      fixture.snapshotPath,
      `${JSON.stringify({
        schemaVersion: 1,
        revision: 0,
        records: [],
        checksum: "0".repeat(64),
      })}\n`,
      "utf8",
    );

    await expect(
      module.LegacyMutationCoordinator.open({ snapshotPath: fixture.snapshotPath }),
    ).rejects.toMatchObject({
      name: "LegacyMutationSnapshotError",
      code: "LEGACY_MUTATION_SNAPSHOT_INVALID",
    });
  });

  it("rejects invalid digest, clock, outcome, and result inputs without unsafe transitions", async () => {
    const module = await freshModule();
    const coordinator = module.LegacyMutationCoordinator.inMemory();
    expect(() =>
      coordinator.acquire({
        ...request("auth", "semantic", "session", "request"),
        semanticDigest: "not-a-digest",
      }),
    ).toThrow(/semanticDigest/);

    const invalidClock = module.LegacyMutationCoordinator.inMemory({ nowUnixMs: () => 1.5 });
    await expect(
      invalidClock.acquire(request("auth", "semantic", "session", "request")),
    ).rejects.toThrow(/clock/);

    const execution = expectExecution(
      await coordinator.acquire(request("auth", "semantic", "session", "request")),
    );
    await expect(execution.outcomeUnknown("bad code")).rejects.toThrow(/outcome code/);
    await expect(execution.finish({ invalid: Number.NaN })).rejects.toThrow(/JSON value/);
    expect(
      await coordinator.acquire(request("auth", "semantic", "session", "request")),
    ).toMatchObject({ kind: "join" });
    await execution.failBeforeDispatch();
  });
});

type CoordinatorModule = typeof import("../src/infrastructure/mcp/legacy-mutation-coordinator.js");

async function freshModule(): Promise<CoordinatorModule> {
  vi.resetModules();
  return import("../src/infrastructure/mcp/legacy-mutation-coordinator.js");
}

function request(
  authorizationSeed: string,
  semanticSeed: string,
  sessionId: string,
  requestId: string | number,
): LegacyMutationRequestContext {
  return {
    authorizationBinding: `authorization:${authorizationSeed}`,
    semanticDigest: digest(`semantic:${semanticSeed}`),
    sessionId,
    requestId,
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function expectExecution<T extends LegacyMutationJsonValue = LegacyMutationJsonValue>(
  acquisition: LegacyMutationAcquisition<T>,
): LegacyMutationExecution<T> {
  if (acquisition.kind !== "execute") {
    throw new Error(`expected execution, received ${acquisition.kind}`);
  }
  expect(acquisition.operationId).toBe(acquisition.execution.operationId);
  return acquisition.execution;
}

async function createFixture(): Promise<{ snapshotPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-legacy-mutation-"));
  temporaryDirectories.push(directory);
  return { snapshotPath: join(directory, "legacy-mutation-coordinator.json") };
}

async function acquireInFreshProcess(
  snapshotPath: string,
  nowUnixMs: number,
  context: LegacyMutationRequestContext,
  action: "read",
): Promise<Record<string, unknown>> {
  const moduleUrl = pathToFileURL(
    resolve("src", "infrastructure", "mcp", "legacy-mutation-coordinator.ts"),
  ).href;
  const script = `
    import { LegacyMutationCoordinator } from ${JSON.stringify(moduleUrl)};
    const coordinator = await LegacyMutationCoordinator.open({
      snapshotPath: ${JSON.stringify(snapshotPath)},
      nowUnixMs: () => ${JSON.stringify(nowUnixMs)}
    });
    const acquisition = await coordinator.acquire(${JSON.stringify(context)});
    const output = acquisition.kind === "execute"
      ? { kind: acquisition.kind, operationId: acquisition.operationId, attemptId: acquisition.execution.attemptId }
      : acquisition.kind === "replay"
        ? { kind: acquisition.kind, operationId: acquisition.operationId, value: acquisition.value }
        : acquisition.kind === "outcome_unknown"
          ? { kind: acquisition.kind, operationId: acquisition.operationId, code: acquisition.code }
          : { kind: acquisition.kind, operationId: acquisition.operationId };
    process.stdout.write(JSON.stringify(output) + "\\n");
  `;
  void action;
  const stdout = await executeNode(script);
  const line = stdout
    .split(/\r?\n/)
    .filter((candidate) => candidate.length > 0)
    .at(-1);
  if (line === undefined) throw new Error("fresh process produced no acquisition result");
  return JSON.parse(line) as Record<string, unknown>;
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
