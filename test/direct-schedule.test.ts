import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DirectJobDispatchAdapter,
  DirectJobManager,
} from "../src/infrastructure/mcp/direct-job-mcp-tools.js";
import { DirectJobStore } from "../src/infrastructure/mcp/direct-job-store.js";
import {
  callDirectScheduleTool,
  type DirectScheduleInvocationContext,
  DirectScheduleManager,
  directScheduleTools,
} from "../src/infrastructure/mcp/direct-schedule-mcp-tools.js";
import {
  DirectScheduleStore,
  parseDirectScheduleRrule,
} from "../src/infrastructure/mcp/direct-schedule-store.js";
import { canonicalJson } from "../src/infrastructure/safety/canonical-json.js";

const key = Buffer.alloc(32, 0x42);
const scope = {
  authorizationBinding: "server-owner-binding",
  conversationId: "server-schedule-sub-owner",
  workSessionId: "stable-work-session",
};
const context: DirectScheduleInvocationContext = {
  authorizationBinding: scope.authorizationBinding,
  workSessionBinding: scope.workSessionId,
  directScheduleOwnerBinding: scope.conversationId,
  directJobOwnerBinding: "direct-job-sub-owner",
  directGoalClaimantBinding: "direct-goal-claimant",
  callerSessionId: "transport-session",
};
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DirectScheduleStore", () => {
  it("defines a small unambiguous RRULE subset and validates IANA time zones", async () => {
    expect(parseDirectScheduleRrule("FREQ=MINUTELY;INTERVAL=5")).toEqual({
      frequency: "MINUTELY",
      interval: 5,
    });
    expect(parseDirectScheduleRrule("FREQ=MINUTELY;INTERVAL=10081")).toEqual({
      frequency: "MINUTELY",
      interval: 10_081,
    });
    expect(parseDirectScheduleRrule("FREQ=DAILY;BYHOUR=9;BYMINUTE=30")).toEqual({
      frequency: "DAILY",
      interval: 1,
      byHour: 9,
      byMinute: 30,
    });
    expect(() => parseDirectScheduleRrule("FREQ=DAILY;BYHOUR=9")).toThrow(
      "requires BYHOUR and BYMINUTE",
    );
    expect(() => parseDirectScheduleRrule("FREQ=WEEKLY;BYDAY=MO")).toThrow(
      "FREQ must be MINUTELY or DAILY",
    );
    expect(() => parseDirectScheduleRrule("FREQ=MINUTELY;BYSECOND=10")).toThrow(
      "unsupported field",
    );

    const store = DirectScheduleStore.inMemory({ integrityKey: key, nowUnixMs: () => 1_000 });
    await expect(store.create(createInput({ timezone: "UTC" }))).rejects.toThrow(
      "explicit IANA region/city",
    );
  });

  it("makes create and manual trigger idempotent and isolates owner and work session", async () => {
    let now = 1_000;
    const store = DirectScheduleStore.inMemory({ integrityKey: key, nowUnixMs: () => now });
    const first = await store.create(createInput());
    now += 25_000;
    const repeated = await store.create(createInput());
    expect(first.disposition).toBe("created");
    expect(repeated).toMatchObject({
      disposition: "existing",
      schedule: { scheduleId: first.schedule.scheduleId },
    });
    await expect(store.create(createInput({ arguments: { path: "different" } }))).rejects.toThrow(
      "DIRECT_SCHEDULE_IDEMPOTENCY_CONFLICT",
    );

    const trigger = await store.trigger({
      ...scope,
      scheduleId: first.schedule.scheduleId,
      idempotencyKey: "manual-trigger-0001",
    });
    now += 10;
    const repeatedTrigger = await store.trigger({
      ...scope,
      scheduleId: first.schedule.scheduleId,
      idempotencyKey: "manual-trigger-0001",
    });
    expect(repeatedTrigger).toMatchObject({
      disposition: "existing",
      run: { runId: trigger.run.runId },
    });
    expect(
      await store.get({
        ...scope,
        authorizationBinding: "other-owner",
        scheduleId: first.schedule.scheduleId,
      }),
    ).toBeUndefined();
    expect(
      await store.get({
        ...scope,
        workSessionId: "other-session",
        scheduleId: first.schedule.scheduleId,
      }),
    ).toBeUndefined();
  });

  it("seals execution scope, detects tampering, and restores the original scope after reboot", async () => {
    const directory = await temporaryDirectory();
    const snapshotPath = join(directory, "schedule.json");
    let now = 10_000;
    const options = {
      snapshotPath,
      integrityKey: key,
      nowUnixMs: () => now,
      claimLeaseMs: 1_000,
      randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    } as const;
    const firstStore = await DirectScheduleStore.open(options);
    const created = await firstStore.create(createInput({ startAtUnixMs: now }));
    const firstClaim = await firstStore.claimDue(now);
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]?.executionScope).toEqual(scope);
    expect(firstClaim[0]?.schedule.scheduleId).toBe(created.schedule.scheduleId);
    if (firstClaim[0] === undefined) throw new Error("expected claim");
    await firstStore.markDispatched(firstClaim[0], "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

    const raw = await readFile(snapshotPath, "utf8");
    expect(raw).not.toContain(scope.authorizationBinding);
    expect(raw).not.toContain(scope.conversationId);
    expect(raw).not.toContain(scope.workSessionId);

    now += 1_001;
    const rebooted = await DirectScheduleStore.open(options);
    const reclaimed = await rebooted.claimDue(now);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.executionScope).toEqual(scope);
    expect(reclaimed[0]?.run).toMatchObject({
      runId: firstClaim[0]?.run.runId,
      attempt: 1,
      scheduledForUnixMs: now - 1_001,
      jobId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });

    const parsed = JSON.parse(await readFile(snapshotPath, "utf8")) as Record<string, unknown>;
    parsed.revision = Number(parsed.revision) + 1;
    await writeFile(snapshotPath, canonicalJson(parsed), "utf8");
    await expect(DirectScheduleStore.open(options)).rejects.toThrow(
      "DIRECT_SCHEDULE_SNAPSHOT_MAC_INVALID",
    );
  });

  it("materializes each scheduleId and scheduledFor pair once across catch-up pumps", async () => {
    let now = 0;
    const store = DirectScheduleStore.inMemory({ integrityKey: key, nowUnixMs: () => now });
    const created = await store.create(
      createInput({
        startAtUnixMs: 0,
        rrule: "FREQ=MINUTELY;INTERVAL=1",
        misfire: { mode: "catch_up", graceMs: 0, maxCatchUp: 10 },
      }),
    );
    now = 180_000;
    const claims = await store.claimDue(now);
    expect(claims.map((claim) => claim.run.scheduledForUnixMs)).toEqual([
      0, 60_000, 120_000, 180_000,
    ]);
    expect(new Set(claims.map((claim) => claim.run.runId)).size).toBe(4);
    expect(await store.claimDue(now)).toHaveLength(0);
    const runs = await store.runs({ ...scope, scheduleId: created.schedule.scheduleId });
    expect(runs.runs).toHaveLength(4);
    expect(
      new Set(runs.runs.map((run) => `${run.scheduleId}:${String(run.scheduledForUnixMs)}`)).size,
    ).toBe(4);
  });

  it("advances a huge missed window arithmetically without blocking another owner", async () => {
    const now = 6_600_000_000;
    const store = DirectScheduleStore.inMemory({ integrityKey: key, nowUnixMs: () => now });
    const old = await store.create(
      createInput({
        idempotencyKey: "huge-window-owner-a-0001",
        startAtUnixMs: 0,
        rrule: "FREQ=MINUTELY;INTERVAL=1",
        misfire: { mode: "catch_up", graceMs: 0, maxCatchUp: 3 },
      }),
    );
    const otherScope = {
      authorizationBinding: "other\0subject\0client\0resource",
      conversationId: "other-owner-conversation",
      workSessionId: "other-owner-work-session",
    };
    const current = await store.create(
      createInput({
        ...otherScope,
        idempotencyKey: "current-window-owner-b-0001",
        startAtUnixMs: now,
        rrule: "FREQ=MINUTELY;INTERVAL=1",
      }),
    );

    const claims = await store.claimDue(now, 200);

    expect(
      claims.filter((claim) => claim.schedule.scheduleId === old.schedule.scheduleId),
    ).toHaveLength(3);
    expect(
      claims.filter((claim) => claim.schedule.scheduleId === current.schedule.scheduleId),
    ).toHaveLength(1);
    expect(await store.get({ ...scope, scheduleId: old.schedule.scheduleId })).toMatchObject({
      nextRunAtUnixMs: now + 60_000,
    });
  });

  it("caps catch-up materialization per claim while preserving another owner's due work", async () => {
    const now = 6_600_000_000;
    const store = DirectScheduleStore.inMemory({ integrityKey: key, nowUnixMs: () => now });
    const old = await store.create(
      createInput({
        idempotencyKey: "bounded-window-owner-a-0001",
        startAtUnixMs: 0,
        rrule: "FREQ=MINUTELY;INTERVAL=1",
        misfire: { mode: "catch_up", graceMs: 0, maxCatchUp: 100 },
      }),
    );
    const otherScope = {
      authorizationBinding: "bounded\0subject\0client\0resource",
      conversationId: "bounded-owner-b-conversation",
      workSessionId: "bounded-owner-b-work-session",
    };
    const current = await store.create(
      createInput({
        ...otherScope,
        idempotencyKey: "bounded-window-owner-b-0001",
        startAtUnixMs: now,
      }),
    );

    const claims = await store.claimDue(now, 25);

    expect(claims).toHaveLength(25);
    expect(claims.some((claim) => claim.schedule.scheduleId === current.schedule.scheduleId)).toBe(
      true,
    );
    expect(
      claims.filter((claim) => claim.schedule.scheduleId === old.schedule.scheduleId),
    ).toHaveLength(24);
    expect(await store.get({ ...scope, scheduleId: old.schedule.scheduleId })).toMatchObject({
      nextRunAtUnixMs: 0,
    });
  });

  it("applies only caller-selected schedule, run, catch-up, claim, and paging limits", async () => {
    const now = 7_500_000;
    const wideScope = {
      authorizationBinding: `server-owner-${"a".repeat(4_100)}`,
      conversationId: `conversation-${"c".repeat(600)}`,
      workSessionId: `session-${"s".repeat(600)}`,
    };
    const store = DirectScheduleStore.inMemory({
      integrityKey: key,
      nowUnixMs: () => now,
      claimLeaseMs: 900_001,
      maxSchedules: 100_001,
      maxRuns: 1_000_001,
    });
    const created = await store.create(
      createInput({
        ...wideScope,
        idempotencyKey: "aaaaaaaaaaaaaaaa",
        startAtUnixMs: 0,
        rrule: "FREQ=MINUTELY;INTERVAL=1",
        retry: {
          maxAttempts: 11,
          initialDelayMs: 700_000_000,
          multiplier: 11,
          maxDelayMs: 800_000_000,
        },
      }),
    );
    for (let index = 0; index < 55; index += 1) {
      await store.create(
        createInput({
          ...wideScope,
          idempotencyKey: `unbounded-list-${String(index).padStart(4, "0")}`,
          startAtUnixMs: now + 60_000,
        }),
      );
    }

    const listed = await store.list(wideScope);
    expect(listed.schedules).toHaveLength(56);
    expect(listed.nextCursor).toBeUndefined();
    const claims = await store.claimDue(now);
    expect(claims).toHaveLength(126);
    const runs = await store.runs({
      ...wideScope,
      scheduleId: created.schedule.scheduleId,
      limit: 201,
    });
    expect(runs.runs).toHaveLength(126);
    expect(runs.nextCursor).toBeUndefined();

    const first = claims[0];
    if (first === undefined) throw new Error("expected a schedule claim");
    const longError = `first line\n${"diagnostic".repeat(1_000)}`;
    const settled = await store.settle(
      first.schedule.scheduleId,
      first.run.runId,
      "outcome_unknown",
      { code: "UPSTREAM_ERROR", message: longError },
    );
    expect(settled.error?.message).toBe(longError);
  });

  it("applies pause, resume, and tombstone delete authoritatively", async () => {
    let now = 50_000;
    const store = DirectScheduleStore.inMemory({ integrityKey: key, nowUnixMs: () => now });
    const created = await store.create(createInput({ startAtUnixMs: 60_000 }));
    expect(await store.pause({ ...scope, scheduleId: created.schedule.scheduleId })).toMatchObject({
      status: "paused",
    });
    now = 70_000;
    expect(await store.claimDue(now)).toHaveLength(0);
    const resumed = await store.resume({ ...scope, scheduleId: created.schedule.scheduleId });
    expect(resumed).toMatchObject({ status: "active" });
    expect(resumed.nextRunAtUnixMs).toBeGreaterThan(now);
    expect(await store.delete({ ...scope, scheduleId: created.schedule.scheduleId })).toMatchObject(
      { status: "deleted" },
    );
    await expect(
      store.trigger({
        ...scope,
        scheduleId: created.schedule.scheduleId,
        idempotencyKey: "deleted-trigger-0001",
      }),
    ).rejects.toThrow("DIRECT_SCHEDULE_DELETED");
  });
});

describe("DirectScheduleManager", () => {
  it("executes due work only through DirectJobManager and records the authoritative result", async () => {
    const scheduleStore = DirectScheduleStore.inMemory({
      integrityKey: key,
      nowUnixMs: () => 1_000,
    });
    const jobManager = new DirectJobManager(DirectJobStore.inMemory());
    const startSpy = vi.spyOn(jobManager, "start");
    const manager = new DirectScheduleManager(scheduleStore, jobManager);
    const adapter = successfulAdapter();

    const created = await manager.create(
      withoutScope(createInput({ startAtUnixMs: 1_000 })),
      context,
      adapter,
    );
    await manager.shutdown();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "codex__functions__read_file",
        arguments: { path: "README.md" },
      }),
      expect.objectContaining({
        callerSessionId: expect.stringMatching(/^schedule:/u),
      }),
      adapter,
    );
    const runs = await manager.runs({ scheduleId: created.schedule.scheduleId }, context);
    expect(runs.runs).toMatchObject([
      {
        status: "succeeded",
        attempt: 1,
        jobId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      },
    ]);
  });

  it("preserves an admission failure message without the former 8192-character truncation", async () => {
    const scheduleStore = DirectScheduleStore.inMemory({
      integrityKey: key,
      nowUnixMs: () => 1_000,
    });
    const manager = new DirectScheduleManager(
      scheduleStore,
      new DirectJobManager(DirectJobStore.inMemory()),
    );
    const longError = `first line\n${"dispatch diagnostic".repeat(1_000)}`;
    let validation = 0;
    const adapter: DirectJobDispatchAdapter = {
      validate: vi.fn(() => {
        validation += 1;
        if (validation === 2) throw new Error(longError);
        return targetContract("long-admission-error");
      }),
      dispatch: vi.fn(() => {
        throw new Error("dispatch must not begin after admission validation fails");
      }),
    };

    const created = await manager.create(
      withoutScope(createInput({ startAtUnixMs: 1_000 })),
      context,
      adapter,
    );
    await manager.shutdown();

    const runs = await manager.runs({ scheduleId: created.schedule.scheduleId }, context);
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]).toMatchObject({
      status: "failed",
      error: {
        code: "DIRECT_SCHEDULE_DISPATCH_ADMISSION_FAILED",
        message: longError,
      },
    });
    expect(adapter.dispatch).not.toHaveBeenCalled();
  });

  it("retries a failed exact native job with a new attempt idempotency key", async () => {
    let now = 1_000;
    const scheduleStore = DirectScheduleStore.inMemory({ integrityKey: key, nowUnixMs: () => now });
    const manager = new DirectScheduleManager(
      scheduleStore,
      new DirectJobManager(DirectJobStore.inMemory({ nowUnixMs: () => now })),
    );
    let invocation = 0;
    const adapter: DirectJobDispatchAdapter = {
      validate: vi.fn(() => targetContract("retry")),
      dispatch: vi.fn(async (request) => {
        await request.beforeNativeDispatch();
        invocation += 1;
        return invocation === 1
          ? {
              status: "failed" as const,
              result: { isError: true, content: [{ type: "text" as const, text: "transient" }] },
            }
          : {
              status: "succeeded" as const,
              result: { content: [{ type: "text" as const, text: "recovered" }] },
            };
      }),
    };
    const created = await manager.create(
      withoutScope(
        createInput({
          startAtUnixMs: now,
          retry: { maxAttempts: 2, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1_000 },
        }),
      ),
      context,
      adapter,
    );
    await manager.shutdown();
    let runs = await manager.runs({ scheduleId: created.schedule.scheduleId }, context);
    expect(runs.runs[0]).toMatchObject({
      status: "retry_wait",
      attempt: 1,
      nextAttemptAtUnixMs: 1_100,
    });

    now = 1_100;
    await manager.pump(adapter, now);
    await manager.shutdown();
    runs = await manager.runs({ scheduleId: created.schedule.scheduleId }, context);
    expect(runs.runs[0]).toMatchObject({ status: "succeeded", attempt: 2 });
    expect(adapter.dispatch).toHaveBeenCalledTimes(2);
  });

  it("bounds runtime drain and durably fences an exact-native execution that never returns", async () => {
    const scheduleStore = DirectScheduleStore.inMemory({
      integrityKey: key,
      nowUnixMs: () => 1_000,
    });
    const jobManager = new DirectJobManager(DirectJobStore.inMemory());
    const fenceSpy = vi.spyOn(jobManager, "fenceCallerOutcomeUnknown");
    const manager = new DirectScheduleManager(scheduleStore, jobManager);
    const adapter: DirectJobDispatchAdapter = {
      validate: vi.fn(() => targetContract("shutdown-fence")),
      dispatch: vi.fn(async (request) => {
        await request.beforeNativeDispatch();
        return new Promise<never>(() => undefined);
      }),
    };
    const created = await manager.create(
      withoutScope(createInput({ startAtUnixMs: 1_000 })),
      context,
      adapter,
    );
    await vi.waitFor(() => expect(adapter.dispatch).toHaveBeenCalledTimes(1));

    await manager.shutdown({ drainTimeoutMs: 10, fenceTimeoutMs: 1_000 });

    expect(fenceSpy).toHaveBeenCalledOnce();
    expect(fenceSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^schedule:/u),
      expect.objectContaining({ code: "DIRECT_SCHEDULE_RUNTIME_DRAIN_TIMEOUT" }),
    );
    const runs = await manager.runs({ scheduleId: created.schedule.scheduleId }, context);
    expect(runs.runs).toMatchObject([
      {
        status: "outcome_unknown",
        error: { code: "DIRECT_SCHEDULE_RUNTIME_DRAIN_TIMEOUT" },
      },
    ]);
  });

  it("does not impose a second internal deadline while persisting a caller-timed-out fence", async () => {
    const scheduleStore = DirectScheduleStore.inMemory({
      integrityKey: key,
      nowUnixMs: () => 1_000,
    });
    const jobManager = new DirectJobManager(DirectJobStore.inMemory());
    let releaseFence!: () => void;
    const fenceGate = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    vi.spyOn(jobManager, "fenceCallerOutcomeUnknown").mockImplementation(async () => fenceGate);
    const manager = new DirectScheduleManager(scheduleStore, jobManager);
    const adapter: DirectJobDispatchAdapter = {
      validate: vi.fn(() => targetContract("uncapped-shutdown-fence")),
      dispatch: vi.fn(async (request) => {
        await request.beforeNativeDispatch();
        return new Promise<never>(() => undefined);
      }),
    };
    await manager.create(withoutScope(createInput({ startAtUnixMs: 1_000 })), context, adapter);
    await vi.waitFor(() => expect(adapter.dispatch).toHaveBeenCalledTimes(1));

    let settled = false;
    const shutdown = manager.shutdown({ drainTimeoutMs: 1 }).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    releaseFence();
    await shutdown;
    expect(settled).toBe(true);
  });

  it("recovers a persisted terminal job result without validating or dispatching it again", async () => {
    let now = 1_000;
    const scheduleStore = DirectScheduleStore.inMemory({
      integrityKey: key,
      nowUnixMs: () => now,
      claimLeaseMs: 1_000,
    });
    const jobStore = DirectJobStore.inMemory({ nowUnixMs: () => now });
    const created = await scheduleStore.create(createInput({ startAtUnixMs: now }));
    const [claim] = await scheduleStore.claimDue(now);
    if (claim === undefined) throw new Error("expected a due schedule claim");
    const recoveredScope = {
      authorizationBinding: claim.executionScope.authorizationBinding,
      conversationId: claim.executionScope.conversationId,
      workSessionId: claim.executionScope.workSessionId,
    };
    const job = await jobStore.start({
      ...recoveredScope,
      idempotencyKey: "persisted-schedule-job-0001",
      toolName: claim.schedule.toolName,
      arguments: claim.arguments,
    });
    const access = { ...recoveredScope, jobId: job.job.jobId };
    await jobStore.markRunning(access);
    await jobStore.succeed(access, {
      content: [{ type: "text", text: "persisted authoritative result" }],
    });
    await scheduleStore.markDispatched(claim, job.job.jobId);

    now += 1_001;
    const adapter: DirectJobDispatchAdapter = {
      validate: vi.fn(() => {
        throw new Error("runtime catalog no longer contains the old tool");
      }),
      dispatch: vi.fn(() => {
        throw new Error("persisted work must not dispatch again");
      }),
    };
    const manager = new DirectScheduleManager(scheduleStore, new DirectJobManager(jobStore));
    await manager.pump(adapter, now);
    await manager.shutdown();

    expect(adapter.validate).not.toHaveBeenCalled();
    expect(adapter.dispatch).not.toHaveBeenCalled();
    expect(await manager.runs({ scheduleId: created.schedule.scheduleId }, context)).toMatchObject({
      runs: [{ status: "succeeded", jobId: job.job.jobId }],
    });
  });

  it("publishes eight scope-free controls and rejects model/thread/control/nested-exec targets", async () => {
    const tools = directScheduleTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "omnicodex__schedule_create",
      "omnicodex__schedule_get",
      "omnicodex__schedule_list",
      "omnicodex__schedule_pause",
      "omnicodex__schedule_resume",
      "omnicodex__schedule_delete",
      "omnicodex__schedule_trigger",
      "omnicodex__schedule_runs",
    ]);
    const serialized = JSON.stringify(tools);
    expect(serialized).not.toContain("authorizationBinding");
    expect(serialized).not.toContain("workSessionBinding");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("send_message_to_thread");

    const manager = new DirectScheduleManager(
      DirectScheduleStore.inMemory({ integrityKey: key }),
      new DirectJobManager(DirectJobStore.inMemory()),
    );
    const adapter = successfulAdapter();
    for (const toolName of [
      "omnicodex__job_start",
      "omnicodex__schedule_runs",
      "omnicodex__goal_create",
      "codex_app__send_message_to_thread",
      "codex_app__create_thread",
      "codex__functions__exec",
      "functions.exec",
      "functions__exec",
      "OmniCodex.codex__functions__exec",
      "codex__functions__exec__h_a1b2c3d4e5f6",
    ]) {
      await expect(
        manager.create(
          withoutScope(createInput({ toolName, idempotencyKey: `allowed-${toolName}-0001` })),
          context,
          adapter,
        ),
      ).resolves.toMatchObject({ disposition: "created" });
    }
    expect(adapter.validate).toHaveBeenCalled();
    await manager.shutdown();
  });

  it("routes all MCP helpers without exposing caller-selectable scope", async () => {
    const manager = new DirectScheduleManager(
      DirectScheduleStore.inMemory({ integrityKey: key, nowUnixMs: () => 1_000 }),
      new DirectJobManager(DirectJobStore.inMemory()),
    );
    const adapter = successfulAdapter();
    const result = await callDirectScheduleTool(
      manager,
      adapter,
      "omnicodex__schedule_create",
      withoutScope(createInput({ startAtUnixMs: 999_999 })),
      context,
    );
    const parsed = JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "") as {
      schedule: { scheduleId: string };
    };
    const wrong = await callDirectScheduleTool(
      manager,
      adapter,
      "omnicodex__schedule_get",
      { scheduleId: parsed.schedule.scheduleId },
      { ...context, authorizationBinding: "wrong-owner" },
    );
    expect(wrong).toMatchObject({ isError: true });
  });
});

function createInput(overrides: Partial<Parameters<DirectScheduleStore["create"]>[0]> = {}) {
  return {
    ...scope,
    idempotencyKey: "create-schedule-0001",
    timezone: "Asia/Seoul",
    rrule: "FREQ=MINUTELY;INTERVAL=5",
    toolName: "codex__functions__read_file",
    arguments: { path: "README.md" },
    ...overrides,
  };
}

function withoutScope<T extends Record<string, unknown>>(input: T) {
  const {
    authorizationBinding: _authorizationBinding,
    conversationId: _conversationId,
    workSessionId: _workSessionId,
    ...rest
  } = input;
  return rest;
}

function successfulAdapter(): DirectJobDispatchAdapter {
  return {
    validate: vi.fn(() => targetContract("successful")),
    dispatch: vi.fn(async (request) => {
      await request.beforeNativeDispatch();
      return {
        status: "succeeded" as const,
        result: {
          content: [{ type: "text" as const, text: "native result" }],
          structuredContent: { native: true },
        } satisfies CallToolResult,
      };
    }),
  };
}

function targetContract(identity: string) {
  return {
    catalogRevision: "c".repeat(64),
    targetIdentity: `schedule\0${identity}`,
    targetContractDigest: "d".repeat(64),
    modelEffect: "none" as const,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-direct-schedule-"));
  directories.push(directory);
  return directory;
}
