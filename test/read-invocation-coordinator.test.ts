import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DirectGoalStore } from "../src/infrastructure/mcp/direct-goal-store.js";
import {
  ReadInvocationConflictError,
  ReadInvocationCoordinator,
  readInvocationSemanticArguments,
} from "../src/infrastructure/mcp/read-invocation-coordinator.js";

const baseIdentity = {
  authorizationBinding: "principal-owner",
  invocationId: "10000000-0000-4000-8000-000000000401",
  targetIdentity: "codex_app\0read_thread",
  fingerprint: digest("read-thread-args-v1"),
} as const;

describe("ReadInvocationCoordinator", () => {
  it("gives successive physical reads distinct Goal receipts while overlapping calls still join", async () => {
    const coordinator = new ReadInvocationCoordinator();
    const store = DirectGoalStore.inMemory();
    const identity = {
      ...baseIdentity,
      authorizationBinding: "issuer\0owner\0client\0conversation",
      scope: "transport" as const,
    };
    const goal = await store.create({
      authorizationBinding: identity.authorizationBinding,
      objective: "Read current desktop status twice",
    });
    const operationIds: string[] = [];
    for (let index = 0; index < 2; index++) {
      const read = coordinator.acquire(identity);
      if (read.kind !== "execute") throw new Error("Expected a fresh physical read");
      expect(coordinator.acquire(identity)).toMatchObject({
        kind: "join",
        operationId: read.operationId,
      });
      const native = {
        authorizationBinding: identity.authorizationBinding,
        claimantBinding: "same-turn",
        toolName: "codex__desktop_lifecycle__status",
        targetIdentity: identity.targetIdentity,
        resourceDigest: digest("desktop"),
        stateEffect: "read" as const,
        modelEffect: "none" as const,
      };
      const context = await store.resolvePendingExecution(native);
      if (!context) throw new Error("Missing dynamic Goal context");
      const execution = { ...native, ...context, operationId: read.operationId };
      await store.beginExecution(execution);
      await store.markExecutionDispatched(execution);
      await store.finalizeExecution({
        ...execution,
        outcome: "succeeded",
        resultDigest: digest(`status-${index}`),
      });
      read.execution.finish({ responsive: true });
      operationIds.push(read.operationId);
    }
    expect(new Set(operationIds).size).toBe(2);
    expect(
      (
        await store.complete({
          authorizationBinding: identity.authorizationBinding,
          goalId: goal.id,
        })
      ).state,
    ).toBe("completed");
  });

  it("does not traverse retained history when expiration and eviction are disabled", () => {
    const coordinator = new ReadInvocationCoordinator();
    const values = vi.spyOn(Map.prototype, "values");
    let enumerations: number;
    try {
      for (let index = 0; index < 1000; index += 1) {
        const result = coordinator.acquire({ ...baseIdentity, invocationId: `read-${index}` });
        if (result.kind !== "execute") throw new Error("missing independent read execution");
        result.execution.finish({ index });
      }
      enumerations = values.mock.calls.length;
    } finally {
      values.mockRestore();
    }
    expect(enumerations).toBe(0);
    // Optimization must not introduce a retention cap or lose old receipts.
    expect(coordinator.acquire({ ...baseIdentity, invocationId: "read-0" })).toMatchObject({
      kind: "replay",
      value: { index: 0 },
    });
  });

  it("preserves all native arguments including titles and caller-selected waits", () => {
    expect(
      readInvocationSemanticArguments({
        threadId: "thread-1",
        timeout_ms: 60_000,
        title: "Wait for the task",
      }),
    ).toEqual({ threadId: "thread-1", timeout_ms: 60_000, title: "Wait for the task" });
    expect(readInvocationSemanticArguments({ threadId: "thread-1", timeout_ms: 5_000 })).toEqual({
      threadId: "thread-1",
      timeout_ms: 5_000,
    });
  });

  it("does not replay another native title query in the same model turn", () => {
    const coordinator = new ReadInvocationCoordinator();
    const identity = (title: string) => ({
      ...baseIdentity,
      scope: "transport" as const,
      targetIdentity: "native\0find_by_title",
      fingerprint: digest(JSON.stringify(readInvocationSemanticArguments({ title }))),
    });
    const first = coordinator.acquire(identity("First document"));
    if (first.kind !== "execute") throw new Error("missing first title query");
    first.execution.finish({ documentId: "first" });

    expect(coordinator.acquire(identity("Second document")).kind).toBe("execute");
    expect(coordinator.acquire(identity("First document")).kind).toBe("execute");
  });

  it("joins an in-flight read, replays success, and isolates another target", async () => {
    const coordinator = new ReadInvocationCoordinator();
    const leader = coordinator.acquire<{ readonly value: string }>(baseIdentity);
    expect(leader.kind).toBe("execute");
    if (leader.kind !== "execute") throw new Error("missing elected read execution");

    const follower = coordinator.acquire<{ readonly value: string }>(baseIdentity);
    expect(follower.kind).toBe("join");
    if (follower.kind !== "join") throw new Error("missing joined read execution");

    const differentTarget = coordinator.acquire<{ readonly value: string }>({
      ...baseIdentity,
      targetIdentity: "app_server\0fs/getMetadata",
      fingerprint: digest("metadata-args-v1"),
    });
    expect(differentTarget.kind).toBe("execute");

    leader.execution.finish({ value: "one" });
    await expect(follower.completion).resolves.toEqual({ value: "one" });
    expect(coordinator.acquire(baseIdentity)).toMatchObject({
      kind: "replay",
      value: { value: "one" },
    });
  });

  it("fails closed on changed canonical arguments for the same target", () => {
    const coordinator = new ReadInvocationCoordinator();
    coordinator.acquire(baseIdentity);
    expect(() =>
      coordinator.acquire({ ...baseIdentity, fingerprint: digest("read-thread-args-v2") }),
    ).toThrow(ReadInvocationConflictError);
  });

  it("does not replay completed transport reads and preserves explicit receipts on mutation", () => {
    const coordinator = new ReadInvocationCoordinator();
    const transportIdentity = { ...baseIdentity, scope: "transport" as const };
    const first = coordinator.acquire<{ readonly value: string }>(transportIdentity);
    if (first.kind !== "execute") throw new Error("missing transport execution");
    first.execution.finish({ value: "before" });
    expect(coordinator.acquire(transportIdentity).kind).toBe("execute");

    const differentArguments = coordinator.acquire({
      ...transportIdentity,
      invocationId: "10000000-0000-4000-8000-000000000402",
      fingerprint: digest("read-thread-args-v2"),
    });
    expect(differentArguments.kind).toBe("execute");
    if (differentArguments.kind !== "execute") throw new Error("missing distinct transport read");
    differentArguments.execution.finish({ value: "different" });

    const explicit = coordinator.acquire<{ readonly value: string }>(baseIdentity);
    if (explicit.kind !== "execute") throw new Error("missing explicit execution");
    explicit.execution.finish({ value: "receipt" });

    coordinator.invalidateTransient();
    expect(coordinator.acquire(transportIdentity).kind).toBe("execute");
    expect(coordinator.acquire(baseIdentity)).toMatchObject({
      kind: "replay",
      value: { value: "receipt" },
    });
  });

  it("separates different reads that share one model-turn transport identity", () => {
    const coordinator = new ReadInvocationCoordinator();
    const transportIdentity = { ...baseIdentity, scope: "transport" as const };
    const first = coordinator.acquire<{ readonly value: string }>(transportIdentity);
    if (first.kind !== "execute") throw new Error("missing first transport execution");

    const differentArguments = coordinator.acquire<{ readonly value: string }>({
      ...transportIdentity,
      fingerprint: digest("read-thread-args-v2"),
    });
    expect(differentArguments.kind).toBe("execute");
    if (differentArguments.kind !== "execute") {
      throw new Error("different read was conflated with the first transport call");
    }

    expect(coordinator.acquire(transportIdentity).kind).toBe("join");
    expect(
      coordinator.acquire({
        ...transportIdentity,
        fingerprint: digest("read-thread-args-v2"),
      }).kind,
    ).toBe("join");

    first.execution.finish({ value: "first" });
    differentArguments.execution.finish({ value: "second" });
    expect(coordinator.acquire(transportIdentity).kind).toBe("execute");
    expect(
      coordinator.acquire({
        ...transportIdentity,
        fingerprint: digest("read-thread-args-v2"),
      }),
    ).toMatchObject({ kind: "execute" });
  });

  it("keeps a new transport invocation independent even when the read arguments match", async () => {
    const coordinator = new ReadInvocationCoordinator();
    const first = coordinator.acquire<{ readonly value: string }>({
      ...baseIdentity,
      scope: "transport",
    });
    if (first.kind !== "execute") throw new Error("missing elected transport execution");

    const retried = coordinator.acquire<{ readonly value: string }>({
      ...baseIdentity,
      invocationId: "10000000-0000-4000-8000-000000000999",
      scope: "transport",
    });
    expect(retried.kind).toBe("execute");
    if (retried.kind !== "execute") throw new Error("missing independent transport execution");

    const otherOwner = coordinator.acquire({
      ...baseIdentity,
      authorizationBinding: "another-principal-owner",
      invocationId: "10000000-0000-4000-8000-000000000999",
      scope: "transport",
    });
    expect(otherOwner.kind).toBe("execute");

    first.execution.finish({ value: "shared" }, false);
    retried.execution.finish({ value: "independent" }, false);
    await expect(retried.execution.completion).resolves.toEqual({ value: "independent" });
  });

  it("does not retain an in-flight transport snapshot across a mutation generation", async () => {
    const coordinator = new ReadInvocationCoordinator();
    const identity = { ...baseIdentity, scope: "transport" as const };
    const oldRead = coordinator.acquire<{ readonly value: string }>(identity);
    if (oldRead.kind !== "execute") throw new Error("missing old transport execution");

    coordinator.invalidateTransient();
    const freshRead = coordinator.acquire<{ readonly value: string }>(identity);
    expect(freshRead.kind).toBe("execute");
    oldRead.execution.finish({ value: "stale" });
    await expect(oldRead.execution.completion).resolves.toEqual({ value: "stale" });
    expect(coordinator.acquire(identity).kind).toBe("join");
  });

  it("starts a fresh physical attempt after tool errors, throws, and replay expiry", async () => {
    let now = 1_000;
    const coordinator = new ReadInvocationCoordinator({
      replayTtlMs: 120_000,
      nowUnixMs: () => now,
    });
    const toolError = coordinator.acquire<{ readonly isError: boolean }>(baseIdentity);
    if (toolError.kind !== "execute") throw new Error("missing error execution");
    const joinedError = coordinator.acquire<{ readonly isError: boolean }>(baseIdentity);
    if (joinedError.kind !== "join") throw new Error("missing error join");
    toolError.execution.finish({ isError: true }, false);
    await expect(joinedError.completion).resolves.toEqual({ isError: true });
    expect(coordinator.acquire(baseIdentity).kind).toBe("execute");

    const failedIdentity = { ...baseIdentity, invocationId: `${baseIdentity.invocationId}-failed` };
    const failed = coordinator.acquire(failedIdentity);
    if (failed.kind !== "execute") throw new Error("missing failed execution");
    const failedJoin = coordinator.acquire(failedIdentity);
    if (failedJoin.kind !== "join") throw new Error("missing failed join");
    failed.execution.fail(new Error("retryable"));
    await expect(failedJoin.completion).rejects.toThrow("retryable");
    expect(coordinator.acquire(failedIdentity).kind).toBe("execute");

    const expiringIdentity = {
      ...baseIdentity,
      invocationId: `${baseIdentity.invocationId}-expiring`,
    };
    const expiring = coordinator.acquire<{ readonly value: string }>(expiringIdentity);
    if (expiring.kind !== "execute") throw new Error("missing expiring execution");
    now = 50_000;
    expiring.execution.finish({ value: "completed-late" });
    now = 169_999;
    expect(coordinator.acquire(expiringIdentity).kind).toBe("replay");
    now = 170_000;
    expect(coordinator.acquire(expiringIdentity).kind).toBe("execute");
  });

  it("does not retain a completed value that exceeds the replay byte cap", () => {
    const coordinator = new ReadInvocationCoordinator({
      maxCompletedBytes: 64,
      maxReplayValueBytes: 32,
    });
    const first = coordinator.acquire<{ readonly value: string }>(baseIdentity);
    if (first.kind !== "execute") throw new Error("missing bounded execution");
    first.execution.finish({ value: "x".repeat(64) });
    expect(coordinator.acquire(baseIdentity).kind).toBe("execute");
  });

  it("retains large successful reads without an implicit size cap or expiry", () => {
    let now = 1_000;
    const coordinator = new ReadInvocationCoordinator({ nowUnixMs: () => now });
    const largeIdentity = {
      ...baseIdentity,
      authorizationBinding: `principal-${"a".repeat(9_000)}`,
      invocationId: `${baseIdentity.invocationId}-large`,
    };
    const output = { value: `start:${"결과".repeat(1_800_000)}:end` };
    const execution = coordinator.acquire<typeof output>(largeIdentity);
    if (execution.kind !== "execute") throw new Error("missing large read execution");
    execution.execution.finish(output);

    now += 365 * 24 * 60 * 60_000;
    expect(coordinator.acquire<typeof output>(largeIdentity)).toMatchObject({
      kind: "replay",
      value: output,
    });
  });
});

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
