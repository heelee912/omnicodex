import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ChromeGoalContinuationTarget } from "../src/application/chrome-goal-continuation.js";
import { GoalContinuationController } from "../src/application/goal-continuation-controller.js";
import type { OracleGoalConversation } from "../src/infrastructure/chatgpt/oracle-goal-conversation.js";
import {
  DirectGoalStore,
  type DirectGoalView,
} from "../src/infrastructure/mcp/direct-goal-store.js";

const owner = "issuer\0owner\0client\0conversation";
const conversationUrl = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const roots: string[] = [];
const controllers: GoalContinuationController[] = [];
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.useRealTimers();
});
const create = (store: DirectGoalStore, authorizationBinding = owner) =>
  store.create({
    authorizationBinding,
    idempotencyKey: "goal-continuation-test-0001",
    objective: "Inspect installation guidance",
    steps: [{ id: "read", description: "Read installation guidance", mode: "successful_call" }],
  });
const observed = (
  goal: DirectGoalView,
  message = "final-first",
): OracleGoalConversation & { current: NonNullable<OracleGoalConversation["current"]> } => ({
  conversationUrl,
  goals: [
    {
      messageId: "goal-result",
      toolName: "omnicodex__goal_create",
      goalId: goal.id,
      state: goal.state,
      revision: goal.revision,
      createdAtUnixMs: goal.createdAtUnixMs,
    },
  ],
  current: {
    id: message,
    ancestorMessageIds:
      message === "final-first" ? ["goal-result"] : ["final-first", "goal-result"],
    authorRole: "assistant",
    status: "finished_successfully",
    endTurn: true,
    channel: "final",
  },
});

const desktopSource = { kind: "desktop" as const, accountSourceId: "chatgpt:account-one:user-one" };

it("does not trigger unrelated turn readbacks for stopped unbound Goals and resumes discovery when active", async () => {
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  expect(await store.hasUnboundContinuation({ activeOnly: true })).toBe(true);
  await store.updateStatus({ authorizationBinding: owner, goalId: goal.id, status: "paused" });
  expect(await store.hasUnboundContinuation({ activeOnly: true })).toBe(false);
  expect(await store.hasUnboundContinuation()).toBe(false);
  await store.updateStatus({ authorizationBinding: owner, goalId: goal.id, status: "active" });
  expect(await store.hasUnboundContinuation({ activeOnly: true })).toBe(true);
});

it("does not bind a newly observed Goal to a conversation that only reads it", async () => {
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  const creation = observed(goal);
  await store.observeConversation({
    ...creation,
    goals: creation.goals.map((entry) => ({ ...entry, toolName: "omnicodex__goal_get" })),
  });
  expect(await store.pendingContinuations()).toEqual([]);
  expect((await store.get(owner, goal.id))?.continuation?.conversationUrl).toBeUndefined();
  await store.observeConversation(creation);
  expect((await store.pendingContinuations())[0]?.conversationUrl).toBe(conversationUrl);
});

it("pauses ready continuation without losing its draft and resumes it exactly once", async () => {
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  await store.observeConversation(observed(goal));
  const [ready] = await store.pendingContinuations();
  if (!ready) throw new Error("Missing draft");
  await store.updateStatus({ authorizationBinding: owner, goalId: goal.id, status: "paused" });
  expect(await store.pendingContinuations()).toEqual([]);
  expect(await store.transitionContinuation(ready, "dispatching")).toBe(false);
  expect((await store.get(owner, goal.id))?.continuation?.draft).toEqual(ready.draft);
  await store.updateStatus({ authorizationBinding: owner, goalId: goal.id, status: "active" });
  expect(await store.pendingContinuations()).toEqual([ready]);
  expect(await store.transitionContinuation(ready, "dispatching")).toBe(true);
  expect(await store.transitionContinuation(ready, "dispatching")).toBe(false);
});

it.each(["paused"] as const)(
  "retains a late dispatch result after %s without resending it on resume",
  async (status) => {
    const store = DirectGoalStore.inMemory();
    const goal = await create(store);
    await store.observeConversation(observed(goal));
    const [ready] = await store.pendingContinuations();
    if (!ready) throw new Error("Missing draft");
    await store.transitionContinuation(ready, "dispatching");
    const dispatching = { ...ready, draft: { ...ready.draft, state: "dispatching" as const } };
    await store.updateStatus({ authorizationBinding: owner, goalId: goal.id, status });
    expect(await store.pendingContinuations()).toEqual([]);
    expect(await store.transitionContinuation(dispatching, "sent")).toBe(true);
    await store.updateStatus({ authorizationBinding: owner, goalId: goal.id, status: "active" });
    expect(await store.pendingContinuations()).toEqual([]);
    expect((await store.get(owner, goal.id))?.continuation?.draft).toMatchObject({
      token: ready.draft.token,
      state: "sent",
    });
  },
);

it("does not regress on an unseen delayed ancestor, including after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnicodex-goal-causality-"));
  roots.push(root);
  const snapshotPath = join(root, "goals.json");
  let store = await DirectGoalStore.open({ snapshotPath });
  const goal = await create(store);
  const newer = observed(goal, "new-final");
  await store.observeConversation({
    ...newer,
    current: { ...newer.current, ancestorMessageIds: ["old-unseen-final", "goal-result"] },
  });
  const before = await store.pendingContinuations();
  (globalThis as unknown as Record<symbol, Map<string, unknown>>)[
    Symbol.for("@heelee912/omnicodex/direct-goal-cores/v2")
  ]?.clear();
  store = await DirectGoalStore.open({ snapshotPath });
  await store.observeConversation(observed(goal, "old-unseen-final"));
  expect(await store.pendingContinuations()).toEqual(before);
  expect((await store.get(owner, goal.id))?.continuation?.settledMessageId).toBe("new-final");
});

it("persists an unordered or changed-branch candidate for readback and prevents an old draft dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnicodex-goal-pending-order-"));
  roots.push(root);
  const snapshotPath = join(root, "goals.json");
  const store = await DirectGoalStore.open({ snapshotPath });
  const goal = await create(store);
  await store.observeConversation(observed(goal));
  const [work] = await store.pendingContinuations();
  if (!work) throw new Error("Missing draft");
  const changed = observed(goal, "other-branch");
  await expect(
    store.observeConversation({
      ...changed,
      current: {
        ...changed.current,
        ancestorMessageIds: ["goal-result"],
      },
    }),
  ).rejects.toThrow("DIRECT_GOAL_CAUSAL_READBACK_REQUIRED");
  expect(await store.transitionContinuation(work, "dispatching")).toBe(false);
  expect(await store.pendingContinuations()).toEqual([]);
  expect((await store.get(owner, goal.id))?.continuation).toMatchObject({
    settledMessageId: "final-first",
    pendingFinalMessageIds: ["other-branch"],
  });
  (globalThis as unknown as Record<symbol, Map<string, unknown>>)[
    Symbol.for("@heelee912/omnicodex/direct-goal-cores/v2")
  ]?.clear();
  const reopened = await DirectGoalStore.open({ snapshotPath });
  expect((await reopened.get(owner, goal.id))?.continuation?.pendingFinalMessageIds).toEqual([
    "other-branch",
  ]);
  await reopened.observeConversation(observed(goal));
  expect(await reopened.pendingContinuations()).toEqual([work]);
});

it("re-anchors a changed branch when it explicitly reselects the same verified Goal", async () => {
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  await store.observeConversation(observed(goal));
  const changed = observed(goal, "reselected-branch-final");

  await store.observeConversation({
    ...changed,
    requestedGoalId: goal.id,
    current: {
      ...changed.current,
      ancestorMessageIds: ["goal-result"],
    },
  });

  const continuation = (await store.get(owner, goal.id))?.continuation;
  expect(continuation).toMatchObject({
    settledMessageId: "reselected-branch-final",
    draft: {
      afterMessageId: "reselected-branch-final",
      state: "ready",
    },
  });
  expect(continuation?.pendingFinalMessageIds).toBeUndefined();
});

it("does not re-anchor a changed branch from a bare Goal id without a matching result", async () => {
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  await store.observeConversation(observed(goal));
  const changed = observed(goal, "unverified-reselected-branch-final");
  const checkpoint = (await store.continuationCheckpoints())[0]?.checkpoint;
  if (!checkpoint) throw new Error("Missing checkpoint");

  await expect(
    store.observeConversation({
      ...changed,
      goals: [],
      requestedGoalId: goal.id,
      checkpoint,
      current: {
        ...changed.current,
        ancestorMessageIds: ["goal-result"],
      },
    }),
  ).rejects.toThrow("DIRECT_GOAL_CAUSAL_READBACK_REQUIRED");
  expect((await store.get(owner, goal.id))?.continuation).toMatchObject({
    settledMessageId: "final-first",
    pendingFinalMessageIds: ["unverified-reselected-branch-final"],
  });
});

it("compares ancestry against the checkpoint at commit when a newer final wins during verification", async () => {
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  await store.observeConversation(observed(goal));
  const middle = observed(goal, "middle-final");
  const newest = observed(goal, "newest-final");
  await store.observeConversation({
    ...newest,
    current: {
      ...newest.current,
      ancestorMessageIds: ["middle-final", "final-first", "goal-result"],
    },
  });
  const before = await store.pendingContinuations();
  await store.observeConversation(middle);
  expect(await store.pendingContinuations()).toEqual(before);
  const unknown = observed(goal, "unknown-final");
  const { ancestorMessageIds: _, ...withoutOrder } = unknown.current;
  await expect(store.observeConversation({ ...unknown, current: withoutOrder })).rejects.toThrow(
    "DIRECT_GOAL_CAUSAL_READBACK_REQUIRED",
  );
  expect((await store.get(owner, goal.id))?.continuation?.settledMessageId).toBe("newest-final");
});

it("requires a fresh checkpoint revision and causal evidence for an already-bound native readback", async () => {
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  await store.observeConversation(observed(goal));
  const captured = (await store.continuationCheckpoints())[0];
  const work = (await store.pendingContinuations())[0];
  if (!captured || !work) throw new Error("Missing checkpoint");
  await store.transitionContinuation(work, "dispatching");
  const next = { ...observed(goal, "later-final"), goals: [], checkpoint: captured.checkpoint };
  await expect(store.observeConversation(next)).rejects.toThrow(
    "DIRECT_GOAL_CAUSAL_READBACK_REQUIRED",
  );
  expect((await store.get(owner, goal.id))?.continuation?.settledMessageId).toBe("final-first");
  const fresh = (await store.continuationCheckpoints())[0];
  if (!fresh) throw new Error("Missing new checkpoint");
  await store.observeConversation({ ...next, checkpoint: fresh.checkpoint });
  expect((await store.get(owner, goal.id))?.continuation).toMatchObject({
    settledMessageId: "later-final",
    draft: { token: work.draft.token, state: "dispatching" },
  });
});

it("continues after a final that preserves outcome-unknown operation identities", async () => {
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  await store.observeConversation(observed(goal));
  const claim = await store.claimNext({
    authorizationBinding: owner,
    claimantBinding: "session:causal-recovery",
    goalId: goal.id,
  });
  if (!claim) throw new Error("Missing claim");
  const reservation = {
    authorizationBinding: owner,
    claimantBinding: "session:causal-recovery",
    goalId: goal.id,
    stepId: "read",
    claimToken: claim.claimToken,
    role: "work" as const,
    operationId: "uncertain-read",
    toolName: "codex_app__read_thread",
    targetIdentity: "codex_app_native\0codex_app/read_thread",
    resourceDigest: "a".repeat(64),
    stateEffect: "read" as const,
    modelEffect: "none" as const,
  };
  await store.beginExecution(reservation);
  await store.markExecutionDispatched(reservation);
  await store.markExecutionOutcomeUnknown(reservation);
  const captured = (await store.continuationCheckpoints())[0];
  if (!captured) throw new Error("Missing checkpoint");

  const next = observed(goal, "recovery-final");
  await expect(
    store.observeConversation({ ...next, goals: [], checkpoint: captured.checkpoint }),
  ).resolves.toBeUndefined();
  expect((await store.get(owner, goal.id))?.continuation).toMatchObject({
    settledMessageId: "recovery-final",
    draft: { afterMessageId: "recovery-final", state: "ready" },
  });
  expect((await store.get(owner, goal.id))?.steps[0]?.reservation).toMatchObject({
    operationId: "uncertain-read",
    state: "outcome_unknown",
  });
});

it("dispatches an independent Goal while another inspection is pending and keeps each Goal single-flight", async () => {
  const store = DirectGoalStore.inMemory();
  const first = await create(store);
  const second = await create(store, "issuer\0second-owner\0client\0second-conversation");
  await store.observeConversation(observed(first));
  await store.observeConversation({
    ...observed(second),
    conversationUrl: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222",
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const operate = vi.fn(async (target: ChromeGoalContinuationTarget) => {
    if (target.goalId === first.id) await pending;
    return { outcome: target.operation === "inspect" ? "ready" : "sent" };
  });
  const controller = new GoalContinuationController(store, operate, async () => {});
  controllers.push(controller);
  try {
    controller.start();
    await vi.waitFor(() =>
      expect(
        operate.mock.calls.some(
          ([target]) => target.goalId === second.id && target.operation === "send",
        ),
      ).toBe(true),
    );
    for (let i = 0; i < 4; i++) controller.wake();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(operate.mock.calls.filter(([target]) => target.goalId === first.id)).toHaveLength(1);
  } finally {
    release();
    await controller.stop();
  }
});

it("does not spend a provider inspection while the bound conversation is active", async () => {
  vi.useFakeTimers();
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  const operate = vi.fn(async (target: ChromeGoalContinuationTarget) => ({
    outcome: target.operation === "inspect" ? "ready" : "sent",
  }));
  const report = vi.fn(async () => {});
  let active = true;
  const conversationIsActive = vi.fn(async () => active);
  const controller = new GoalContinuationController(store, operate, report, conversationIsActive);
  controllers.push(controller);

  await controller.observe([observed(goal)]);
  await vi.advanceTimersByTimeAsync(0);
  expect(conversationIsActive).toHaveBeenCalledOnce();
  expect(operate).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledWith(goal.id, "generating");

  active = false;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(operate.mock.calls.map(([target]) => target.operation)).toEqual(["inspect", "send"]);
  expect((await store.get(owner, goal.id))?.continuation?.draft?.state).toBe("sent");
});

it("retains the first observer's dispatch route when app and Web deliver the same final", async () => {
  for (const desktopFirst of [true, false]) {
    const store = DirectGoalStore.inMemory();
    const goal = await create(store);
    const web = {
      ...observed(goal),
      source: { kind: "web" as const, accountSourceId: desktopSource.accountSourceId },
    };
    const app = { ...web, source: desktopSource };
    await store.observeConversation(desktopFirst ? app : web);
    const first = (await store.pendingContinuations())[0];
    await store.observeConversation(desktopFirst ? web : app);
    const second = (await store.pendingContinuations())[0];
    expect(second?.draft.token).toBe(first?.draft.token);
    expect(second?.draft.transport).toBe(desktopFirst ? "desktop" : undefined);
    expect(second?.accountSourceId).toBe(desktopSource.accountSourceId);
  }
});

it("filters continuation reads by verified account while retaining unassigned Goals", async () => {
  const store = DirectGoalStore.inMemory();
  const firstOwner = "issuer\0first\0client\0conversation";
  const secondOwner = "issuer\0second\0client\0conversation";
  const legacyOwner = "issuer\0unassigned\0client\0conversation";
  const first = await create(store, firstOwner);
  const second = await create(store, secondOwner);
  const legacy = await create(store, legacyOwner);
  const firstSource = { kind: "web" as const, accountSourceId: "chatgpt:first:user-first" };
  const secondSource = { kind: "web" as const, accountSourceId: "chatgpt:second:user-second" };
  const secondUrl = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";
  const legacyUrl = "https://chatgpt.com/c/33333333-3333-4333-8333-333333333333";
  await store.observeConversation({ ...observed(first), source: firstSource });
  await store.observeConversation({
    ...observed(second),
    conversationUrl: secondUrl,
    source: secondSource,
  });
  await store.observeConversation({ ...observed(legacy), conversationUrl: legacyUrl });

  expect(await store.continuationConversationUrls()).toEqual([
    conversationUrl,
    secondUrl,
    legacyUrl,
  ]);
  expect(await store.continuationConversationUrls(firstSource.accountSourceId)).toEqual([
    conversationUrl,
    legacyUrl,
  ]);
  expect(await store.continuationConversationUrls(secondSource.accountSourceId)).toEqual([
    secondUrl,
    legacyUrl,
  ]);
  const checkpoints = await store.continuationCheckpoints();
  expect(checkpoints.map((item) => item.checkpoint.goalId)).toEqual([
    first.id,
    second.id,
    legacy.id,
  ]);
  expect(await store.continuationCheckpoints(firstSource.accountSourceId)).toEqual([
    checkpoints[0],
    checkpoints[2],
  ]);
  expect(await store.continuationCheckpoints(secondSource.accountSourceId)).toEqual([
    checkpoints[1],
    checkpoints[2],
  ]);
  for (const pending of await store.pendingContinuations()) {
    expect(pending.draft.transport).toBeUndefined();
  }
  expect((await store.get(firstOwner, first.id))?.continuation).toMatchObject({
    accountSourceId: firstSource.accountSourceId,
  });
  expect((await store.get(secondOwner, second.id))?.continuation).toMatchObject({
    accountSourceId: secondSource.accountSourceId,
  });

  await store.observeConversation({
    ...observed(legacy),
    conversationUrl: legacyUrl,
    source: secondSource,
  });
  expect(await store.continuationConversationUrls(firstSource.accountSourceId)).toEqual([
    conversationUrl,
  ]);
  expect(await store.continuationConversationUrls(secondSource.accountSourceId)).toEqual([
    secondUrl,
    legacyUrl,
  ]);
  await expect(
    store.observeConversation({ ...observed(first), source: secondSource }),
  ).rejects.toThrow("DIRECT_GOAL_ACCOUNT_SOURCE_MISMATCH");
});

it("does not retain a desktop transport label when a newer final is observed on Web", async () => {
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  await store.observeConversation({ ...observed(goal), source: desktopSource });
  await store.observeConversation({
    ...observed(goal, "web-final"),
    source: { kind: "web", accountSourceId: desktopSource.accountSourceId },
  });
  const pending = (await store.pendingContinuations())[0];
  expect(pending?.accountSourceId).toBe(desktopSource.accountSourceId);
  expect(pending?.draft.afterMessageId).toBe("web-final");
  expect(pending?.draft.transport).toBeUndefined();
  expect((await store.get(owner, goal.id))?.continuation?.settledTransport).toBeUndefined();
});

it("advances a bound app Goal without fabricating another Goal tool result and rejects another account", async () => {
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  const observation = { ...observed(goal), source: desktopSource };
  const { current, ...binding } = observation;
  await store.observeBoundDesktopFinal({ conversationUrl, source: desktopSource, current });
  expect(await store.pendingContinuations()).toEqual([]);
  await store.observeConversation(binding);
  await store.observeBoundDesktopFinal({ conversationUrl, source: desktopSource, current });
  expect((await store.pendingContinuations())[0]?.draft.transport).toBe("desktop");
  const before = await store.get(owner, goal.id);
  await expect(
    store.observeBoundDesktopFinal({
      conversationUrl,
      current: { ...current, id: "other-final" },
      source: { kind: "desktop", accountSourceId: "chatgpt:account-two:user-two" },
    }),
  ).rejects.toThrow("ACCOUNT_SOURCE_MISMATCH");
  expect(await store.get(owner, goal.id)).toEqual(before);
});

it("preserves the newer final's route while an older send is unresolved", async () => {
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  await store.observeConversation(observed(goal));
  const first = (await store.pendingContinuations())[0];
  if (!first) throw new Error("Missing first draft");
  await store.transitionContinuation(first, "dispatching");
  await store.observeBoundDesktopFinal({
    conversationUrl,
    source: desktopSource,
    current: observed(goal, "app-final").current,
  });
  await store.transitionContinuation(
    { ...first, draft: { ...first.draft, state: "dispatching" } },
    "sent",
  );
  const next = (await store.pendingContinuations())[0];
  expect(next?.draft).toMatchObject({
    afterMessageId: "app-final",
    state: "ready",
    transport: "desktop",
  });
  expect(next?.accountSourceId).toBe(desktopSource.accountSourceId);
});

it("restores the account and the chosen app transport from the durable Goal record", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnicodex-goal-route-"));
  roots.push(root);
  const snapshotPath = join(root, "goals.json");
  const store = await DirectGoalStore.open({ snapshotPath });
  const goal = await create(store);
  await store.observeConversation({ ...observed(goal), source: desktopSource });
  const expected = await store.pendingContinuations();
  const registry = (globalThis as unknown as Record<symbol, Map<string, unknown>>)[
    Symbol.for("@heelee912/omnicodex/direct-goal-cores/v2")
  ];
  registry?.clear();
  const reopened = await DirectGoalStore.open({ snapshotPath });
  expect(await reopened.pendingContinuations()).toEqual(expected);
});

it("binds only a matching durable Goal, keeps one draft per turn, and excludes another conversation", async () => {
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  const goalReference = observed(goal).goals[0];
  if (goalReference === undefined) throw new Error("Missing test Goal reference");
  await store.observeConversation({
    ...observed(goal),
    goals: [{ ...goalReference, createdAtUnixMs: goal.createdAtUnixMs + 1 }],
  });
  expect(await store.pendingContinuations()).toEqual([]);
  await store.observeConversation(observed(goal));
  const pending = await store.pendingContinuations();
  await store.observeConversation(observed(goal));
  expect(await store.pendingContinuations()).toEqual(pending);
  await expect(
    store.observeConversation({
      ...observed(goal),
      conversationUrl: conversationUrl.replace("11111111-", "22222222-"),
    }),
  ).rejects.toThrow("CONVERSATION_MISMATCH");
  expect(await store.get("issuer\0other\0client\0conversation", goal.id)).toBeUndefined();
  expect((await store.get(owner, goal.id))?.state).toBe("active");
});

it("ignores commentary, stopped turns and missing current nodes", async () => {
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  const source = observed(goal);
  if (source.current === undefined) throw new Error("Missing test turn");
  for (const current of [
    undefined,
    { ...source.current, channel: "commentary" },
    { ...source.current, status: "interrupted" },
    { ...source.current, endTurn: false },
  ]) {
    const { current: _, ...withoutCurrent } = source;
    await store.observeConversation({
      ...withoutCurrent,
      ...(current === undefined ? {} : { current }),
    });
    expect(await store.pendingContinuations()).toEqual([]);
  }
});

it("keeps the first completion identity when a second surface replays an older final", async () => {
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  await Promise.all([
    store.observeConversation(observed(goal)),
    store.observeConversation(observed(goal)),
  ]);
  const [first] = await store.pendingContinuations();
  if (!first) throw new Error("Missing first draft");
  await store.transitionContinuation(first, "dispatching");
  await store.observeConversation(observed(goal, "final-second"));
  await store.observeConversation(observed(goal));
  await store.transitionContinuation(
    { ...first, draft: { ...first.draft, state: "dispatching" } },
    "sent",
  );
  const [second] = await store.pendingContinuations();
  expect(second?.draft.afterMessageId).toBe("final-second");
  await store.observeConversation(observed(goal));
  expect(await store.pendingContinuations()).toEqual([second]);
});

it("admits only one send when app and web observers finish the same turn concurrently", async () => {
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  const operate = vi.fn(async (target: ChromeGoalContinuationTarget) => ({
    outcome: target.operation === "send" ? "sent" : "ready",
  }));
  const app = new GoalContinuationController(store, operate, async () => {});
  const web = new GoalContinuationController(store, operate, async () => {});
  controllers.push(app, web);
  await Promise.all([app.observe([observed(goal)]), web.observe([observed(goal)])]);
  await vi.waitFor(async () => expect(await store.pendingContinuations()).toEqual([]));
  await Promise.all([app.observe([observed(goal)]), web.observe([observed(goal)])]);
  expect(operate.mock.calls.filter(([target]) => target.operation === "send")).toHaveLength(1);
});

it.each(["cancelled", "ready", "prepared"] as const)(
  "retains a newer completion when the earlier dispatch resolves as %s",
  async (outcome) => {
    const store = DirectGoalStore.inMemory();
    const goal = await create(store);
    await store.observeConversation(observed(goal));
    const [first] = await store.pendingContinuations();
    if (!first) throw new Error("Missing first draft");
    await store.transitionContinuation(first, "dispatching");
    await store.observeConversation(observed(goal, "final-second"));
    const dispatched = { ...first, draft: { ...first.draft, state: "dispatching" as const } };
    expect(await store.transitionContinuation(dispatched, outcome)).toBe(true);
    const [next] = await store.pendingContinuations();
    expect(next?.draft).toMatchObject({ afterMessageId: "final-second", state: "ready" });
    expect(next?.draft.token).not.toBe(first.draft.token);
    await store.observeConversation(observed(goal));
    await store.observeConversation(observed(goal, "final-second"));
    expect(await store.pendingContinuations()).toEqual([next]);
    expect(await store.transitionContinuation(dispatched, "sent")).toBe(false);
  },
);

it("handles a completion received during another inspection without waiting for the retry timer", async () => {
  vi.useFakeTimers();
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  let releaseInspection!: () => void;
  const inspecting = new Promise<void>((resolve) => {
    releaseInspection = resolve;
  });
  const operate = vi.fn(async (target: ChromeGoalContinuationTarget) => {
    if (target.draft.afterMessageId === "final-first") await inspecting;
    return { outcome: target.operation === "send" ? "sent" : "ready" };
  });
  const controller = new GoalContinuationController(store, operate, async () => {});
  controllers.push(controller);
  await controller.observe([observed(goal)]);
  await vi.advanceTimersByTimeAsync(0);
  expect(operate).toHaveBeenCalledTimes(1);
  await controller.observe([observed(goal, "final-second")]);
  releaseInspection();
  await vi.advanceTimersByTimeAsync(0);
  expect(
    operate.mock.calls
      .filter(([target]) => target.operation === "send")
      .map(([target]) => target.draft.afterMessageId),
  ).toEqual(["final-second"]);
});

it("retains response deduplication after reopening the durable Goal store", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnicodex-goal-event-replay-"));
  roots.push(root);
  const snapshotPath = join(root, "goals.json");
  const store = await DirectGoalStore.open({ snapshotPath });
  const goal = await create(store);
  await store.observeConversation(observed(goal));
  await store.observeConversation(observed(goal, "final-second"));
  const pending = await store.pendingContinuations();
  const registry = (globalThis as unknown as Record<symbol, Map<string, unknown>>)[
    Symbol.for("@heelee912/omnicodex/direct-goal-cores/v2")
  ];
  registry?.clear();
  const reopened = await DirectGoalStore.open({ snapshotPath });
  await reopened.observeConversation(observed(goal));
  expect(await reopened.pendingContinuations()).toEqual(pending);
});

it("backs off repeated native browser failures despite extra wake signals and recovers the same draft", async () => {
  vi.useFakeTimers();
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  let available = false;
  const operate = vi.fn(async (target: ChromeGoalContinuationTarget) =>
    available
      ? { outcome: target.operation === "send" ? "sent" : "ready" }
      : { isError: true, error: "Tab is already part of another browser session" },
  );
  const controller = new GoalContinuationController(store, operate, async () => {});
  controllers.push(controller);
  await controller.observe([observed(goal)]);
  await vi.advanceTimersByTimeAsync(0);
  expect(operate).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 10; i += 1) {
    controller.wake();
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(operate).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(operate).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(operate).toHaveBeenCalledTimes(2);
  available = true;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(operate).toHaveBeenCalledTimes(4);
  expect(operate.mock.calls.map(([target]) => target.operation)).toEqual([
    "inspect",
    "inspect",
    "inspect",
    "send",
  ]);
  expect((await store.get(owner, goal.id))?.continuation?.draft?.state).toBe("sent");
});

it("preserves a blocked Goal without sending and resumes its pending draft after an explicit update", async () => {
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  expect(await store.continuationConversationUrls()).toEqual([]);
  await store.observeConversation(observed(goal));
  expect(await store.continuationConversationUrls()).toEqual([conversationUrl]);
  const [ready] = await store.pendingContinuations();
  if (!ready) throw new Error("Missing draft");
  await store.transitionContinuation(ready, "dispatching");
  expect(
    (
      await store.updateStatus({
        authorizationBinding: owner,
        goalId: goal.id,
        status: "blocked",
        reason: "External impasse",
      })
    ).state,
  ).toBe("blocked");
  await store.transitionContinuation(
    { ...ready, draft: { ...ready.draft, state: "dispatching" } },
    "ready",
  );
  const blocked = await store.updateStatus({
    authorizationBinding: owner,
    goalId: goal.id,
    status: "blocked",
    reason: "External impasse",
  });
  const operate = vi.fn(async () => ({ outcome: "ready" }));
  const controller = new GoalContinuationController(store, operate, async () => {});
  controllers.push(controller);
  await controller.observe([observed(blocked, "blocked-final")]);
  await controller.stop();
  expect(operate).not.toHaveBeenCalled();
  expect(await store.pendingContinuations()).toEqual([]);
  expect(await store.continuationConversationUrls()).toEqual([]);
  expect(await store.transitionContinuation(ready, "dispatching")).toBe(false);
  const resumed = await store.updateStatus({
    authorizationBinding: owner,
    goalId: goal.id,
    status: "active",
  });
  expect(await store.continuationConversationUrls()).toEqual([conversationUrl]);
  expect(await store.pendingContinuations()).toEqual([ready]);
  await store.observeConversation(observed(resumed, "resumed-final"));
  expect((await store.pendingContinuations())[0]?.draft.afterMessageId).toBe("resumed-final");
});

it("recovers the same persisted draft after restart and atomically admits one sender", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnicodex-goal-continuation-"));
  roots.push(root);
  const snapshotPath = join(root, "goals.json");
  const store = await DirectGoalStore.open({ snapshotPath });
  const goal = await create(store);
  await store.observeConversation(observed(goal));
  const [work] = await store.pendingContinuations();
  expect(work).toBeDefined();
  if (work === undefined) throw new Error("Missing continuation");
  const registry = (globalThis as unknown as Record<symbol, Map<string, unknown>>)[
    Symbol.for("@heelee912/omnicodex/direct-goal-cores/v2")
  ];
  registry?.clear();
  const reopened = await DirectGoalStore.open({ snapshotPath });
  expect(await reopened.pendingContinuations()).toEqual([work]);
  expect(
    await Promise.all([
      reopened.transitionContinuation(work, "dispatching"),
      reopened.transitionContinuation(work, "dispatching"),
    ]),
  ).toEqual([true, false]);
  registry?.clear();
  const recovered = await DirectGoalStore.open({ snapshotPath });
  expect((await recovered.pendingContinuations())[0]?.draft.state).toBe("dispatching");
});

it("retries only readback after a lost send acknowledgement, never another prompt", async () => {
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  const operate = vi.fn(async (target: ChromeGoalContinuationTarget) => ({
    outcome: target.operation === "inspect" ? "ready" : "send_unconfirmed",
  }));
  const report = vi.fn(async () => undefined);
  const first = new GoalContinuationController(store, operate, report);
  controllers.push(first);
  await first.observe([observed(goal)]);
  await vi.waitFor(() =>
    expect(report).toHaveBeenCalledWith(goal.id, "send_unconfirmed", undefined),
  );
  await first.stop();
  expect(operate.mock.calls.filter(([target]) => target.operation === "send")).toHaveLength(1);
  operate.mockImplementation(async () => ({ outcome: "sent" }));
  const second = new GoalContinuationController(store, operate, report);
  controllers.push(second);
  second.start();
  await vi.waitFor(async () => expect(await store.pendingContinuations()).toEqual([]));
  expect(operate.mock.calls.filter(([target]) => target.operation === "send")).toHaveLength(1);
  expect((await store.get(owner, goal.id))?.continuation?.draft?.state).toBe("sent");
});

it("retains a later settled turn when it arrives before the previous send acknowledgement", async () => {
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  await store.observeConversation(observed(goal));
  const work = (await store.pendingContinuations())[0];
  if (work === undefined) throw new Error("Missing continuation");
  await store.transitionContinuation(work, "dispatching");
  await store.observeConversation(observed(goal, "final-second"));
  const dispatched = { ...work, draft: { ...work.draft, state: "dispatching" as const } };
  await store.transitionContinuation(dispatched, "sent");
  const next = (await store.pendingContinuations())[0];
  expect(next?.draft.afterMessageId).toBe("final-second");
  expect(next?.draft.token).not.toBe(work.draft.token);
  expect(await store.transitionContinuation(dispatched, "sent")).toBe(false);
});

it("recovers a proven unclicked draft after restart without retrying a later uncertain click", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnicodex-goal-prepared-"));
  roots.push(root);
  const snapshotPath = join(root, "goals.json");
  const store = await DirectGoalStore.open({ snapshotPath });
  const goal = await create(store);
  const operate = vi.fn(async (target: ChromeGoalContinuationTarget) => ({
    outcome: target.operation === "inspect" ? "ready" : "inserted_not_sent",
  }));
  const report = vi.fn(async () => undefined);
  const first = new GoalContinuationController(store, operate, report);
  controllers.push(first);
  await first.observe([observed(goal)]);
  await vi.waitFor(() =>
    expect(report).toHaveBeenCalledWith(goal.id, "inserted_not_sent", undefined),
  );
  await first.stop();
  const [prepared] = await store.pendingContinuations();
  expect(prepared?.draft.state).toBe("prepared");
  const registry = (globalThis as unknown as Record<symbol, Map<string, unknown>>)[
    Symbol.for("@heelee912/omnicodex/direct-goal-cores/v2")
  ];
  registry?.clear();
  const reopened = await DirectGoalStore.open({ snapshotPath });
  expect(await reopened.pendingContinuations()).toEqual([prepared]);
  operate.mockClear();
  operate.mockImplementation(async (target) => ({
    outcome: target.operation === "inspect" ? "ready" : "send_unconfirmed",
  }));
  const second = new GoalContinuationController(reopened, operate, report);
  controllers.push(second);
  second.start();
  await vi.waitFor(() =>
    expect(report).toHaveBeenCalledWith(goal.id, "send_unconfirmed", undefined),
  );
  expect(
    operate.mock.calls.map(([target]) => [target.operation, target.resumePreparedDraft]),
  ).toEqual([
    ["inspect", true],
    ["send", true],
  ]);
  second.wake();
  await vi.waitFor(() => expect(operate).toHaveBeenCalledTimes(3));
  await second.stop();
  expect(operate.mock.calls[2]?.[0].resumePreparedDraft).toBe(false);
  expect(operate.mock.calls.filter(([target]) => target.operation === "send")).toHaveLength(1);
  expect((await reopened.pendingContinuations())[0]?.draft.state).toBe("dispatching");
});

it("returns a dispatch to ready when native inspection proves the send never started", async () => {
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  await store.observeConversation(observed(goal));
  const [ready] = await store.pendingContinuations();
  if (!ready) throw new Error("Missing continuation");
  await store.transitionContinuation(ready, "dispatching");
  const report = vi.fn(async () => undefined);
  const operate = vi.fn(async () => ({ outcome: "send_not_started" }));
  const controller = new GoalContinuationController(store, operate, report);
  controllers.push(controller);

  controller.start();
  await vi.waitFor(async () =>
    expect((await store.pendingContinuations())[0]?.draft.state).toBe("ready"),
  );
  expect(operate).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledWith(goal.id, "send_not_started");
});

it("preserves an occupied composer and continues on a later exact turn", async () => {
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  const operate = vi.fn(async () => ({ outcome: "draft_preserved" }));
  const report = vi.fn(async () => undefined);
  const controller = new GoalContinuationController(store, operate, report);
  controllers.push(controller);
  await controller.observe([observed(goal)]);
  await vi.waitFor(() => expect(operate).toHaveBeenCalledTimes(1));
  expect((await store.pendingContinuations())[0]?.draft.state).toBe("ready");
  await controller.stop();
  operate.mockImplementation(async () => ({ outcome: "superseded" }));
  const resumed = new GoalContinuationController(store, operate, report);
  controllers.push(resumed);
  resumed.start();
  await vi.waitFor(async () => expect(await store.pendingContinuations()).toEqual([]));
  await store.observeConversation(observed(goal, "final-next"));
  expect((await store.pendingContinuations())[0]?.draft.afterMessageId).toBe("final-next");
});

it("reports changed inspection blockers without repeating unchanged idle reports", async () => {
  vi.useFakeTimers();
  const store = DirectGoalStore.inMemory();
  const goal = await create(store);
  let outcome = "draft_preserved";
  const report = vi.fn(async () => undefined);
  const controller = new GoalContinuationController(store, async () => ({ outcome }), report);
  controllers.push(controller);
  await controller.observe([observed(goal)]);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(report.mock.calls).toEqual([[goal.id, "draft_preserved"]]);
  outcome = "anchor_not_visible";
  await vi.advanceTimersByTimeAsync(60_000);
  expect(report.mock.calls).toEqual([
    [goal.id, "draft_preserved"],
    [goal.id, "anchor_not_visible"],
  ]);
  outcome = "draft_preserved";
  await vi.advanceTimersByTimeAsync(30_000);
  expect(report).toHaveBeenCalledTimes(3);
  expect((await store.pendingContinuations())[0]?.draft.state).toBe("ready");
});
