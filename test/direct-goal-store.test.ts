import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DirectGoalExecutionFinalizeInput,
  DirectGoalStore,
} from "../src/infrastructure/mcp/direct-goal-store.js";
import { canonicalJson } from "../src/infrastructure/safety/canonical-json.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DirectGoalStore", () => {
  it("lists account Goals and synchronizes pause, resume, and deletion with one conversation", async () => {
    let now = 10_000;
    const store = DirectGoalStore.inMemory({ nowUnixMs: () => now });
    const firstOwner = "issuer\0owner\0client\0conversation-a";
    const secondOwner = "issuer\0owner\0client\0conversation-b";
    const conversationUrl = "https://chatgpt.com/c/managed-lifecycle";
    const accountSourceId = "chatgpt:account:managed";
    const first = await store.create({ authorizationBinding: firstOwner, objective: "First Goal" });
    now += 1;
    const second = await store.create({
      authorizationBinding: secondOwner,
      objective: "Second Goal",
    });
    await store.complete({ authorizationBinding: secondOwner, goalId: second.id });
    now += 1;
    await store.observeConversation({
      conversationUrl,
      source: { kind: "web", accountSourceId },
      goals: [
        {
          messageId: `goal-${first.id}`,
          toolName: "omnicodex__goal_create",
          goalId: first.id,
          state: first.state,
          revision: first.revision,
          createdAtUnixMs: first.createdAtUnixMs,
        },
      ],
      current: {
        id: "managed-final",
        ancestorMessageIds: [`goal-${first.id}`],
        authorRole: "assistant",
        status: "finished_successfully",
        endTurn: true,
      },
    });
    expect(await store.list([firstOwner, secondOwner])).toEqual([
      expect.objectContaining({ id: first.id, objective: "First Goal" }),
      expect.objectContaining({ id: second.id, objective: "Second Goal" }),
    ]);
    expect(await store.pendingContinuations()).toHaveLength(1);

    now += 1;
    const paused = await store.pauseConversation({ conversationUrl, accountSourceId });
    expect(paused).toEqual([expect.objectContaining({ id: first.id, state: "paused" })]);
    expect(await store.list([firstOwner, secondOwner], ["paused"])).toEqual([
      expect.objectContaining({ id: first.id, state: "paused" }),
    ]);
    expect(await store.continuationConversationUrls(accountSourceId)).toEqual([]);
    expect(await store.continuationCheckpoints(accountSourceId)).toEqual([]);
    expect(await store.pendingContinuations()).toEqual([]);
    expect(await store.hasUnboundContinuation()).toBe(false);
    expect(
      await store.hasObservedGoalCandidate([
        {
          messageId: `goal-${first.id}`,
          toolName: "omnicodex__goal_get",
          goalId: first.id,
          state: "paused",
          revision: paused[0]?.revision ?? 0,
          createdAtUnixMs: first.createdAtUnixMs,
        },
      ]),
    ).toBe(false);

    now += 1;
    await store.updateStatus({
      authorizationBinding: firstOwner,
      goalId: first.id,
      status: "active",
    });
    expect(await store.continuationConversationUrls(accountSourceId)).toEqual([conversationUrl]);
    const [resumed] = await store.pendingContinuations();
    expect(resumed).toBeDefined();
    if (!resumed) throw new Error("Missing resumed continuation");
    expect(await store.transitionContinuation(resumed, "cancelled")).toBe(true);
    expect(await store.continuationConversationUrls(accountSourceId)).toEqual([]);
    expect(await store.continuationCheckpoints(accountSourceId)).toHaveLength(1);
    expect(await store.pendingContinuations()).toEqual([]);

    const deleted = await store.deleteConversation({ conversationUrl, accountSourceId });
    expect(deleted).toEqual([
      expect.objectContaining({ goalId: first.id, deleted: true, deletedAtUnixMs: now }),
    ]);
    expect(await store.deleteConversation({ conversationUrl, accountSourceId })).toEqual([]);
    expect(await store.get(firstOwner, first.id)).toBeUndefined();
    expect(await store.list([firstOwner, secondOwner])).toEqual([
      expect.objectContaining({ id: second.id, objective: "Second Goal" }),
    ]);
  });

  it("durably recovers connector provenance only from the exact existing binding result", async () => {
    const snapshotPath = join(await temporaryRoot(), "connector-provenance.json");
    let store = await DirectGoalStore.open({ snapshotPath });
    const authorizationBinding = "issuer\0owner\0client\0connector-owner";
    const conversationUrl = "https://chatgpt.com/c/connector-provenance";
    const goal = await createBoundManagementGoal(store, authorizationBinding, conversationUrl);
    const source = { kind: "web" as const, accountSourceId: "chatgpt:account:owner" };
    const result = {
      messageId: `goal-${goal.id}`,
      toolName: "omnicodex__goal_create",
      goalId: goal.id,
      state: goal.state,
      revision: goal.revision,
      createdAtUnixMs: goal.createdAtUnixMs,
      connectorId: "asdk_app_second",
    };
    expect(
      await store.continuationConversationUrls(source.accountSourceId, "asdk_app_web"),
    ).toEqual([conversationUrl]);
    expect(
      await store.continuationConversationUrls(source.accountSourceId, result.connectorId),
    ).toEqual([conversationUrl]);
    expect(await store.continuationCheckpoints(source.accountSourceId)).toHaveLength(1);
    expect(await store.continuationCheckpoints(source.accountSourceId, result.connectorId)).toEqual(
      [],
    );
    await store.observeConversation({
      conversationUrl,
      source,
      goals: [{ ...result, messageId: "later-get", toolName: "omnicodex__goal_get" }],
    });
    expect(
      (await store.get(authorizationBinding, goal.id))?.continuation?.connectorId,
    ).toBeUndefined();
    await store.observeConversation({ conversationUrl, source, goals: [result] });
    clearDirectGoalProcessCore(snapshotPath);
    store = await DirectGoalStore.open({ snapshotPath });
    expect(
      await store.continuationConversationUrls(source.accountSourceId, "asdk_app_web"),
    ).toEqual([]);
    expect(
      await store.continuationConversationUrls(source.accountSourceId, result.connectorId),
    ).toEqual([conversationUrl]);
    expect(await store.continuationConversationUrls(source.accountSourceId)).toEqual([
      conversationUrl,
    ]);
    expect(
      await store.continuationConversationUrls("chatgpt:other:owner", result.connectorId),
    ).toEqual([]);
    expect((await store.get(authorizationBinding, goal.id))?.continuation?.connectorId).toBe(
      result.connectorId,
    );
    expect(
      await store.continuationCheckpoints(source.accountSourceId, result.connectorId),
    ).toHaveLength(1);
    expect(await store.continuationCheckpoints(source.accountSourceId, "asdk_app_web")).toEqual([]);
    await expect(
      store.observeConversation({
        conversationUrl,
        source,
        goals: [{ ...result, connectorId: "asdk_app_web" }],
      }),
    ).rejects.toThrow("DIRECT_GOAL_CONNECTOR_MISMATCH");
    await store.observeConversation({
      conversationUrl,
      source,
      goals: [result],
      current: {
        id: "connector-final",
        ancestorMessageIds: [result.messageId],
        authorRole: "assistant",
        status: "finished_successfully",
        endTurn: true,
        channel: "final",
      },
    });
    expect(await store.pendingContinuations()).toEqual([
      expect.objectContaining({ connectorId: result.connectorId }),
    ]);
  });
  it("retains bound same-conversation get recovery without accepting management elsewhere", async () => {
    const store = DirectGoalStore.inMemory();
    const authorizationBinding = "issuer\0owner\0client\0bound-management";
    const conversationUrl = "https://chatgpt.com/c/original-bound-conversation";
    const created = await createBoundManagementGoal(store, authorizationBinding, conversationUrl);
    const bound = await store.get(authorizationBinding, created.id);
    if (bound === undefined) throw new Error("Expected bound Goal");
    const result = {
      messageId: "recovery-get-result",
      toolName: "omnicodex__goal_get",
      goalId: bound.id,
      state: bound.state,
      revision: bound.revision,
      createdAtUnixMs: bound.createdAtUnixMs,
    };
    const observation = {
      conversationUrl,
      goals: [result],
      current: {
        id: "recovery-final",
        ancestorMessageIds: [result.messageId],
        authorRole: "assistant",
        status: "finished_successfully",
        endTurn: true,
        channel: "final",
      },
    };
    expect(await store.hasObservedGoalCandidate([result])).toBe(true);
    await expect(
      store.observeConversation({
        ...observation,
        conversationUrl: "https://chatgpt.com/c/management-elsewhere",
      }),
    ).rejects.toThrow("DIRECT_GOAL_CONVERSATION_MISMATCH");
    expect(await store.get(authorizationBinding, bound.id)).toEqual(bound);
    expect(await store.pendingContinuations()).toEqual([]);
    await store.observeConversation(observation);
    const recovered = await store.get(authorizationBinding, bound.id);
    expect(recovered?.continuation).toMatchObject({
      conversationUrl,
      bindingMessageId: `goal-${bound.id}`,
      settledMessageId: "recovery-final",
      draft: { afterMessageId: "recovery-final", state: "ready" },
    });
    expect(await store.pendingContinuations()).toHaveLength(1);
  });

  it.each(["omnicodex__goal_get", "omnicodex__goal_update"])(
    "does not bind an unbound active Goal from another conversation's %s result",
    async (toolName) => {
      const store = DirectGoalStore.inMemory();
      const authorizationBinding = "issuer\0owner\0client\0cross-management";
      const goal = await store.create({
        authorizationBinding,
        objective: "Continue original work",
      });
      const result = {
        messageId: "management-result",
        toolName,
        goalId: goal.id,
        state: goal.state,
        revision: goal.revision,
        createdAtUnixMs: goal.createdAtUnixMs,
      };
      await store.observeConversation({
        conversationUrl: "https://chatgpt.com/c/management-conversation",
        source: { kind: "web", accountSourceId: "chatgpt:account:management" },
        goals: [result],
        current: {
          id: "management-final",
          ancestorMessageIds: [result.messageId],
          authorRole: "assistant",
          status: "finished_successfully",
          endTurn: true,
          channel: "final",
        },
      });
      expect(await store.get(authorizationBinding, goal.id)).toEqual(goal);
      expect(await store.hasObservedGoalCandidate([result])).toBe(false);
      expect(await store.pendingContinuations()).toEqual([]);
      expect(await store.hasUnboundContinuation()).toBe(true);
    },
  );

  it.each(["account", "url", "owner"] as const)(
    "does not partially bind historical Goals when a transcript has a conflicting %s",
    async (conflict) => {
      const store = DirectGoalStore.inMemory();
      const authorizationBinding = "issuer\0owner\0client\0batch-conflict";
      const oldGoal = await store.create({ authorizationBinding, objective: "Previous work" });
      await store.updateStatus({ authorizationBinding, goalId: oldGoal.id, status: "paused" });
      const newBinding =
        conflict === "owner" ? "issuer\0other\0client\0batch-conflict" : authorizationBinding;
      const newGoal = await store.create({
        authorizationBinding: newBinding,
        objective: "Current work",
      });
      const goals = [oldGoal, newGoal].map((goal) => ({
        messageId: `creation-${goal.id}`,
        toolName: "omnicodex__goal_create",
        goalId: goal.id,
        state: goal.state,
        revision: goal.revision,
        createdAtUnixMs: goal.createdAtUnixMs,
      }));
      const conversationUrl = "https://chatgpt.com/c/batch-conflict";
      const source = { kind: "web" as const, accountSourceId: "chatgpt:account:original" };
      await store.observeConversation({
        conversationUrl,
        source,
        goals: goals.filter((goal) => goal.goalId === newGoal.id),
      });
      const beforeOld = await store.get(authorizationBinding, oldGoal.id);
      const beforeNew = await store.get(newBinding, newGoal.id);
      await expect(
        store.observeConversation({
          conversationUrl:
            conflict === "url" ? "https://chatgpt.com/c/wrong-batch" : conversationUrl,
          source:
            conflict === "account"
              ? { ...source, accountSourceId: "chatgpt:account:wrong" }
              : source,
          goals,
        }),
      ).rejects.toThrow(
        conflict === "account"
          ? "DIRECT_GOAL_ACCOUNT_SOURCE_MISMATCH"
          : conflict === "url"
            ? "DIRECT_GOAL_CONVERSATION_MISMATCH"
            : "DIRECT_GOAL_CONVERSATION_AMBIGUOUS",
      );
      expect(await store.get(authorizationBinding, oldGoal.id)).toEqual(beforeOld);
      expect(await store.get(newBinding, newGoal.id)).toEqual(beforeNew);
      expect(await store.pendingContinuations()).toEqual([]);
    },
  );

  it.each(["active", "paused", "complete"] as const)(
    "binds historical inactive creation beside a newer %s creation in one transcript",
    async (newStatus) => {
      const store = DirectGoalStore.inMemory();
      const authorizationBinding = "issuer\0owner\0client\0historical-transcript";
      const oldGoal = await store.create({ authorizationBinding, objective: "Previous work" });
      await store.updateStatus({ authorizationBinding, goalId: oldGoal.id, status: "complete" });
      const newGoal = await store.create({ authorizationBinding, objective: "Current work" });
      if (newStatus !== "active")
        await store.updateStatus({ authorizationBinding, goalId: newGoal.id, status: newStatus });
      const goals = [oldGoal, newGoal].map((goal) => ({
        messageId: `creation-${goal.id}`,
        toolName: "omnicodex__goal_create",
        goalId: goal.id,
        state: goal.state,
        revision: goal.revision,
        createdAtUnixMs: goal.createdAtUnixMs,
      }));
      const conversationUrl = "https://chatgpt.com/c/historical-transcript";
      const source = { kind: "web" as const, accountSourceId: "chatgpt:account:history" };
      await store.observeConversation({
        conversationUrl,
        source,
        goals,
        current: {
          id: "current-final",
          ancestorMessageIds: goals.map((goal) => goal.messageId),
          authorRole: "assistant",
          status: "finished_successfully",
          endTurn: true,
          channel: "final",
        },
      });
      const oldBound = await store.get(authorizationBinding, oldGoal.id);
      const newBound = await store.get(authorizationBinding, newGoal.id);
      for (const goal of [oldBound, newBound])
        expect(goal?.continuation).toMatchObject({
          conversationUrl,
          accountSourceId: source.accountSourceId,
        });
      expect(oldBound?.state).toBe("completed");
      expect(oldBound?.continuation).not.toHaveProperty("draft");
      expect(await store.hasUnboundContinuation()).toBe(false);
      const pending = await store.pendingContinuations();
      if (newStatus === "active") {
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({
          goalId: newGoal.id,
          draft: { afterMessageId: "current-final" },
        });
      } else {
        expect(pending).toEqual([]);
        expect(newBound?.continuation).not.toHaveProperty("draft");
      }
    },
  );

  it("uses an explicit user-selected Goal to disambiguate active creations on one transcript", async () => {
    const store = DirectGoalStore.inMemory();
    const firstBinding = "issuer\0first-owner\0client\0selected-transcript";
    const secondBinding = "issuer\0second-owner\0client\0selected-transcript";
    const first = await store.create({
      authorizationBinding: firstBinding,
      objective: "Earlier work",
    });
    const second = await store.create({
      authorizationBinding: secondBinding,
      objective: "Selected work",
    });
    const results = [first, second].map((goal) => ({
      messageId: `creation-${goal.id}`,
      toolName: "omnicodex__goal_create",
      goalId: goal.id,
      state: goal.state,
      revision: goal.revision,
      createdAtUnixMs: goal.createdAtUnixMs,
    }));
    const conversationUrl = "https://chatgpt.com/c/selected-transcript";
    await store.observeConversation({
      conversationUrl,
      requestedGoalId: second.id,
      source: { kind: "web", accountSourceId: "chatgpt:account:selected" },
      goals: results,
      current: {
        id: "selected-final",
        ancestorMessageIds: results.map((goal) => goal.messageId),
        authorRole: "assistant",
        status: "finished_successfully",
        endTurn: true,
        channel: "final",
      },
    });
    expect((await store.get(firstBinding, first.id))?.continuation).toEqual({ enabled: true });
    expect((await store.get(secondBinding, second.id))?.continuation).toMatchObject({
      conversationUrl,
      bindingMessageId: `creation-${second.id}`,
      settledMessageId: "selected-final",
      draft: { afterMessageId: "selected-final", state: "ready" },
    });
    expect(await store.pendingContinuations()).toHaveLength(1);
  });

  it("prepares recovery only for an explicitly selected Goal left at an idle user turn", async () => {
    const store = DirectGoalStore.inMemory();
    const authorizationBinding = "issuer\0owner\0client\0idle-user-turn";
    const goal = await store.create({
      authorizationBinding,
      objective: "Resume the selected work",
    });
    const conversationUrl = "https://chatgpt.com/c/idle-user-turn";
    const observation = {
      conversationUrl,
      requestedGoalId: goal.id,
      source: { kind: "web" as const, accountSourceId: "chatgpt:account:idle-user" },
      goals: [
        {
          messageId: "creation-idle-user",
          toolName: "omnicodex__goal_create",
          goalId: goal.id,
          state: goal.state,
          revision: goal.revision,
          createdAtUnixMs: goal.createdAtUnixMs,
        },
      ],
      current: {
        id: "resume-user-message",
        ancestorMessageIds: ["creation-idle-user"],
        authorRole: "user",
        status: "finished_successfully",
      },
    };

    await store.observeConversation({ ...observation, nativeTaskStatus: "active" });
    expect(await store.pendingContinuations()).toEqual([]);

    await store.observeConversation({ ...observation, nativeTaskStatus: "idle" });
    expect(await store.pendingContinuations()).toMatchObject([
      {
        goalId: goal.id,
        conversationUrl,
        draft: {
          afterMessageId: "resume-user-message",
          state: "ready",
          resumeIdleUserTurn: true,
        },
      },
    ]);
  });

  it("recovers an idle ordinary follow-up through its exact active Goal checkpoint", async () => {
    const store = DirectGoalStore.inMemory();
    const authorizationBinding = "issuer\0owner\0client\0idle-checkpoint-followup";
    const goal = await store.create({
      authorizationBinding,
      objective: "Resume an ordinary follow-up after its tool work stops",
    });
    const conversationUrl = "https://chatgpt.com/c/idle-checkpoint-followup";
    const source = {
      kind: "web" as const,
      accountSourceId: "chatgpt:account:idle-checkpoint-followup",
    };
    const creation = {
      messageId: "creation-idle-checkpoint-followup",
      toolName: "omnicodex__goal_create",
      goalId: goal.id,
      state: goal.state,
      revision: goal.revision,
      createdAtUnixMs: goal.createdAtUnixMs,
    };
    await store.observeConversation({
      conversationUrl,
      source,
      goals: [creation],
      current: {
        id: "checkpoint-final",
        ancestorMessageIds: [creation.messageId],
        authorRole: "assistant",
        status: "finished_successfully",
        endTurn: true,
      },
    });
    const [initialContinuation] = await store.pendingContinuations();
    if (initialContinuation === undefined) throw new Error("Missing initial continuation");
    expect(await store.transitionContinuation(initialContinuation, "cancelled")).toBe(true);
    const [captured] = await store.continuationCheckpoints(source.accountSourceId);
    if (captured === undefined) throw new Error("Missing active Goal checkpoint");
    const followup = {
      conversationUrl,
      checkpoint: captured.checkpoint,
      source,
      goals: [] as const,
      current: {
        id: "ordinary-followup",
        ancestorMessageIds: ["checkpoint-final", creation.messageId],
        authorRole: "user",
        status: "finished_successfully",
      },
    };

    await store.observeConversation({ ...followup, nativeTaskStatus: "active" });
    expect(await store.pendingContinuations()).toEqual([]);

    await store.observeConversation({ ...followup, nativeTaskStatus: "idle" });
    expect(await store.pendingContinuations()).toMatchObject([
      {
        goalId: goal.id,
        conversationUrl,
        draft: {
          afterMessageId: "ordinary-followup",
          state: "ready",
          resumeIdleUserTurn: true,
        },
      },
    ]);
  });

  it("prepares Web recovery for an idle assistant tool turn that never produced a final", async () => {
    const store = DirectGoalStore.inMemory();
    const authorizationBinding = "issuer\0owner\0client\0idle-incomplete-turn";
    const goal = await store.create({
      authorizationBinding,
      objective: "Resume after tool work stopped before the final response",
    });
    const conversationUrl = "https://chatgpt.com/c/idle-incomplete-turn";
    const observation = {
      conversationUrl,
      requestedGoalId: goal.id,
      source: { kind: "web" as const, accountSourceId: "chatgpt:account:idle-incomplete" },
      goals: [
        {
          messageId: "creation-idle-incomplete",
          toolName: "omnicodex__goal_create",
          goalId: goal.id,
          state: goal.state,
          revision: goal.revision,
          createdAtUnixMs: goal.createdAtUnixMs,
        },
      ],
      current: {
        id: "assistant-tool-head",
        ancestorMessageIds: ["creation-idle-incomplete"],
        authorRole: "assistant",
        status: "finished_successfully",
        endTurn: false,
      },
    };

    await store.observeConversation({ ...observation, nativeTaskStatus: "active" });
    expect(await store.pendingContinuations()).toEqual([]);

    await store.observeConversation({ ...observation, nativeTaskStatus: "idle" });
    expect(await store.pendingContinuations()).toMatchObject([
      {
        goalId: goal.id,
        conversationUrl,
        draft: {
          afterMessageId: "assistant-tool-head",
          state: "ready",
          resumeIdleIncompleteTurn: true,
        },
      },
    ]);
  });

  it("returns the most recently updated continuation first", async () => {
    let now = 50_000;
    const store = DirectGoalStore.inMemory({ nowUnixMs: () => now });
    const bind = async (label: string) => {
      const goal = await store.create({
        authorizationBinding: `issuer\0owner\0client\0${label}`,
        objective: `${label} work`,
      });
      await store.observeConversation({
        conversationUrl: `https://chatgpt.com/c/${label}`,
        source: { kind: "web", accountSourceId: `chatgpt:account:${label}` },
        goals: [
          {
            messageId: `creation-${label}`,
            toolName: "omnicodex__goal_create",
            goalId: goal.id,
            state: goal.state,
            revision: goal.revision,
            createdAtUnixMs: goal.createdAtUnixMs,
          },
        ],
        current: {
          id: `final-${label}`,
          ancestorMessageIds: [`creation-${label}`],
          authorRole: "assistant",
          status: "finished_successfully",
          endTurn: true,
        },
      });
      return goal;
    };

    const older = await bind("older");
    now += 1;
    const newer = await bind("newer");
    expect((await store.pendingContinuations()).map((work) => work.goalId)).toEqual([
      newer.id,
      older.id,
    ]);
  });

  it("observes already stopped Goals from prior owner bindings without blocking the conversation watcher", async () => {
    const store = DirectGoalStore.inMemory();
    const conversationUrl = "https://chatgpt.com/c/stopped-prior-owner-bindings";
    const source = { kind: "web" as const, accountSourceId: "chatgpt:account:history" };
    const firstBinding = "issuer\0owner-one\0client\0stopped-history";
    const secondBinding = "issuer\0owner-two\0client\0stopped-history";
    const first = await store.create({
      authorizationBinding: firstBinding,
      objective: "First work",
    });
    await store.updateStatus({
      authorizationBinding: firstBinding,
      goalId: first.id,
      status: "complete",
    });
    const second = await store.create({
      authorizationBinding: secondBinding,
      objective: "Second work",
    });
    await store.updateStatus({
      authorizationBinding: secondBinding,
      goalId: second.id,
      status: "blocked",
      reason: "Stopped before the historical readback",
    });
    const observed = [
      { goal: await store.get(firstBinding, first.id), messageId: "first-creation" },
      { goal: await store.get(secondBinding, second.id), messageId: "second-creation" },
    ].map(({ goal, messageId }) => ({
      messageId,
      toolName: "omnicodex__goal_create",
      goalId: goal?.id as string,
      state: goal?.state as "completed" | "blocked",
      revision: goal?.revision as number,
      createdAtUnixMs: goal?.createdAtUnixMs as number,
    }));

    for (const result of observed) {
      await store.observeConversation({ conversationUrl, source, goals: [result] });
    }

    await expect(
      store.observeConversation({ conversationUrl, source, goals: observed }),
    ).resolves.toBeUndefined();
    expect(await store.pendingContinuations()).toEqual([]);
    for (const [binding, goal] of [
      [firstBinding, first],
      [secondBinding, second],
    ] as const) {
      expect(await store.get(binding, goal.id)).toMatchObject({
        state: expect.stringMatching(/^(completed|blocked)$/),
        continuation: {
          conversationUrl,
          accountSourceId: source.accountSourceId,
        },
      });
    }
  });

  it.each(["paused", "complete", "blocked"] as const)(
    "binds a delayed creation result after %s without scheduling continuation",
    async (status) => {
      const snapshotPath = join(await temporaryRoot(), `delayed-creation-${status}.json`);
      const authorizationBinding = "issuer\0owner\0client\0delayed-creation";
      let store = await DirectGoalStore.open({ snapshotPath });
      const goal = await store.create({
        authorizationBinding,
        objective: "Finish the requested work",
      });
      await store.updateStatus({
        authorizationBinding,
        goalId: goal.id,
        status,
        ...(status === "blocked" ? { reason: "Required device unavailable" } : {}),
      });
      const before = await store.get(authorizationBinding, goal.id);
      const creation = {
        messageId: "delayed-creation-result",
        toolName: "omnicodex__goal_create",
        goalId: goal.id,
        state: goal.state,
        revision: goal.revision,
        createdAtUnixMs: goal.createdAtUnixMs,
      };
      const observation = {
        conversationUrl: "https://chatgpt.com/c/delayed-creation",
        source: { kind: "desktop" as const, accountSourceId: "chatgpt:account:delayed" },
        goals: [creation],
        current: {
          id: "delayed-final",
          ancestorMessageIds: [creation.messageId],
          authorRole: "assistant",
          status: "finished_successfully",
          endTurn: true,
          channel: "final",
        },
      };
      expect(await store.hasUnboundContinuation()).toBe(false);
      expect(await store.hasUnboundContinuation({ activeOnly: true })).toBe(false);
      expect(await store.hasObservedGoalCandidate([creation])).toBe(false);
      for (const invalid of [
        { ...creation, toolName: "omnicodex__goal_get" },
        { ...creation, goalId: "different-goal" },
        { ...creation, createdAtUnixMs: goal.createdAtUnixMs + 1 },
        { ...creation, revision: (before?.revision ?? 0) + 1 },
      ]) {
        expect(await store.hasObservedGoalCandidate([invalid])).toBe(false);
        await store.observeConversation({ ...observation, goals: [invalid] });
        expect(await store.get(authorizationBinding, goal.id)).toEqual(before);
      }
      await store.observeConversation(observation);
      const bound = await store.get(authorizationBinding, goal.id);
      expect(bound).toMatchObject({
        state: before?.state,
        continuation: {
          enabled: true,
          conversationUrl: observation.conversationUrl,
          accountSourceId: observation.source.accountSourceId,
          bindingMessageId: creation.messageId,
        },
      });
      expect(bound?.continuation).not.toHaveProperty("draft");
      expect(bound?.continuation).not.toHaveProperty("settledMessageId");
      expect(bound?.continuation).not.toHaveProperty("pendingFinalMessageIds");
      expect(await store.hasUnboundContinuation()).toBe(false);
      expect(await store.hasObservedGoalCandidate([creation])).toBe(false);
      expect(await store.pendingContinuations()).toEqual([]);
      expect(await store.continuationConversationUrls()).toEqual([]);
      expect(
        await store.resolveManagementTarget([authorizationBinding], {
          conversationUrl: observation.conversationUrl,
        }),
      ).toEqual({ authorizationBinding, goalId: goal.id });
      clearDirectGoalProcessCore(snapshotPath);
      store = await DirectGoalStore.open({ snapshotPath });
      expect(await store.get(authorizationBinding, goal.id)).toEqual(bound);
      await store.observeConversation(observation);
      expect(await store.get(authorizationBinding, goal.id)).toEqual(bound);
      await store.delete({ authorizationBinding, goalId: goal.id });
      await store.observeConversation(observation);
      expect(await store.get(authorizationBinding, goal.id)).toBeUndefined();
      expect(await store.hasUnboundContinuation()).toBe(false);
      expect(await store.hasObservedGoalCandidate([creation])).toBe(false);
      expect(await store.pendingContinuations()).toEqual([]);
    },
  );

  it("does not bind a stopped Goal to a conversation already occupied by an active Goal", async () => {
    const store = DirectGoalStore.inMemory();
    const conversationUrl = "https://chatgpt.com/c/occupied-goal";
    await createBoundManagementGoal(store, "issuer\0owner-a\0client\0occupied", conversationUrl);
    const authorizationBinding = "issuer\0owner-b\0client\0delayed";
    const goal = await store.create({ authorizationBinding, objective: "Delayed creation" });
    await store.updateStatus({ authorizationBinding, goalId: goal.id, status: "paused" });
    const before = await store.get(authorizationBinding, goal.id);
    await expect(
      store.observeConversation({
        conversationUrl,
        goals: [
          {
            messageId: "delayed-create",
            toolName: "omnicodex__goal_create",
            goalId: goal.id,
            state: goal.state,
            revision: goal.revision,
            createdAtUnixMs: goal.createdAtUnixMs,
          },
        ],
      }),
    ).rejects.toThrow("DIRECT_GOAL_CONVERSATION_ALREADY_BOUND");
    expect(await store.get(authorizationBinding, goal.id)).toEqual(before);
  });

  it("resolves exact management targets only within supplied authorization bindings", async () => {
    const store = DirectGoalStore.inMemory();
    const binding = "issuer\0owner\0client\0management";
    const foreign = "issuer\0other-owner\0client\0management";
    const conversationUrl = "https://chatgpt.com/c/management-target";
    const goal = await createBoundManagementGoal(store, binding, conversationUrl);
    const target = { authorizationBinding: binding, goalId: goal.id };
    expect(await store.resolveManagementTarget([foreign, binding], { goalId: goal.id })).toEqual(
      target,
    );
    expect(
      await store.resolveManagementTarget([binding], {
        goalId: goal.id,
        conversationUrl: "https://chatgpt.com/g/project/c/management-target/?view=compact#latest",
      }),
    ).toEqual(target);
    expect(await store.resolveManagementTarget([foreign], { goalId: goal.id })).toBeUndefined();
    expect(await store.resolveManagementTarget([foreign], { conversationUrl })).toBeUndefined();
    expect(await store.resolveManagementTarget([], { goalId: goal.id })).toBeUndefined();
    expect(
      await store.resolveManagementTarget([binding], {
        goalId: goal.id,
        conversationUrl: "https://chatgpt.com/c/another-target",
      }),
    ).toBeUndefined();
    await expect(store.resolveManagementTarget([binding], {})).rejects.toThrow(
      "DIRECT_GOAL_MANAGEMENT_TARGET_REQUIRED",
    );
    await expect(
      store.resolveManagementTarget([binding], {
        conversationUrl: "https://example.com/c/management-target",
      }),
    ).rejects.toThrow("DIRECT_GOAL_CONVERSATION_INVALID");
  });

  it.each(["paused", "complete", "blocked"] as const)(
    "resolves a durable %s Goal by URL without changing the ledger",
    async (status) => {
      const snapshotPath = join(await temporaryRoot(), `management-${status}.json`);
      const binding = "issuer\0owner\0client\0management-state";
      const conversationUrl = "https://chatgpt.com/c/management-state";
      let store = await DirectGoalStore.open({ snapshotPath });
      const goal = await createBoundManagementGoal(store, binding, conversationUrl);
      await store.updateStatus({
        authorizationBinding: binding,
        goalId: goal.id,
        status,
        ...(status === "blocked" ? { reason: "Required device unavailable" } : {}),
      });
      const before = await readFile(snapshotPath, "utf8");
      clearDirectGoalProcessCore(snapshotPath);
      store = await DirectGoalStore.open({ snapshotPath });
      expect(await store.resolveManagementTarget([binding], { conversationUrl })).toEqual({
        authorizationBinding: binding,
        goalId: goal.id,
      });
      expect(await readFile(snapshotPath, "utf8")).toBe(before);
    },
  );

  it("selects an active URL match before a later inactive match, otherwise the latest match", async () => {
    const store = DirectGoalStore.inMemory();
    const binding = "issuer\0owner\0client\0management-selection";
    const conversationUrl = "https://chatgpt.com/c/management-selection";
    const first = await createBoundManagementGoal(store, binding, conversationUrl);
    await store.updateStatus({ authorizationBinding: binding, goalId: first.id, status: "paused" });
    const second = await createBoundManagementGoal(store, binding, conversationUrl);
    await store.updateStatus({
      authorizationBinding: binding,
      goalId: second.id,
      status: "complete",
    });
    expect(await store.resolveManagementTarget([binding], { conversationUrl })).toEqual({
      authorizationBinding: binding,
      goalId: second.id,
    });
    await store.updateStatus({ authorizationBinding: binding, goalId: first.id, status: "active" });
    expect(await store.resolveManagementTarget([binding], { conversationUrl })).toEqual({
      authorizationBinding: binding,
      goalId: first.id,
    });
    const unrelated = await createBoundManagementGoal(
      store,
      "issuer\0other\0client\0selection",
      "https://chatgpt.com/c/unrelated",
    );
    expect(
      await store.resolveManagementTarget([binding], { goalId: unrelated.id }),
    ).toBeUndefined();
  });

  it("rejects cross-owner URL ambiguity instead of choosing the active account", async () => {
    const store = DirectGoalStore.inMemory();
    const firstBinding = "issuer\0first-owner\0client\0management";
    const secondBinding = "issuer\0second-owner\0client\0management";
    const conversationUrl = "https://chatgpt.com/c/shared-management-url";
    const first = await createBoundManagementGoal(store, firstBinding, conversationUrl);
    await store.updateStatus({
      authorizationBinding: firstBinding,
      goalId: first.id,
      status: "paused",
    });
    const second = await createBoundManagementGoal(store, secondBinding, conversationUrl);
    await expect(
      store.resolveManagementTarget([firstBinding, secondBinding], { conversationUrl }),
    ).rejects.toThrow("DIRECT_GOAL_MANAGEMENT_TARGET_AMBIGUOUS");
    expect(
      await store.resolveManagementTarget([firstBinding, secondBinding], {
        goalId: second.id,
        conversationUrl,
      }),
    ).toEqual({
      authorizationBinding: secondBinding,
      goalId: second.id,
    });
    expect(
      await store.resolveManagementTarget([firstBinding, firstBinding], { conversationUrl }),
    ).toEqual({
      authorizationBinding: firstBinding,
      goalId: first.id,
    });
  });

  it("resolves an authorized deletion tombstone by ID for durable idempotent deletion", async () => {
    const snapshotPath = join(await temporaryRoot(), "management-deleted.json");
    const binding = "issuer\0owner\0client\0management-deleted";
    const conversationUrl = "https://chatgpt.com/c/management-deleted";
    let store = await DirectGoalStore.open({ snapshotPath });
    const goal = await createBoundManagementGoal(store, binding, conversationUrl);
    const deletion = await store.delete({ authorizationBinding: binding, goalId: goal.id });
    const before = await readFile(snapshotPath, "utf8");
    clearDirectGoalProcessCore(snapshotPath);
    store = await DirectGoalStore.open({ snapshotPath });
    const target = await store.resolveManagementTarget([binding], { goalId: goal.id });
    expect(target).toEqual({ authorizationBinding: binding, goalId: goal.id });
    if (target === undefined) throw new Error("Expected deletion target");
    expect(await store.delete(target)).toEqual(deletion);
    expect(await store.resolveManagementTarget([binding], { conversationUrl })).toBeUndefined();
    expect(
      await store.resolveManagementTarget([binding], { goalId: goal.id, conversationUrl }),
    ).toBeUndefined();
    expect(
      await store.resolveManagementTarget(["issuer\0foreign\0client\0management-deleted"], {
        goalId: goal.id,
      }),
    ).toBeUndefined();
    expect(await readFile(snapshotPath, "utf8")).toBe(before);
  });

  it.each(["read", "mutate"] as const)(
    "records an explicitly claimed %s outside the reference tool list",
    async (stateEffect) => {
      const snapshotPath = join(await temporaryRoot(), "reference-tool-list.json");
      const authorizationBinding = "issuer\0owner\0client\0reference-tool-list";
      const claimantBinding = "reference-turn";
      let store = await DirectGoalStore.open({ snapshotPath });
      const goal = await store.create({
        authorizationBinding,
        objective: "Use the native tool needed for the current work",
        steps: [
          {
            id: "reference",
            description: "Original suggested tool",
            mode: "successful_call",
            allowedToolNames: ["legacy__suggested_tool"],
          },
        ],
      });
      const claim = await store.claimNext({
        authorizationBinding,
        claimantBinding,
        goalId: goal.id,
      });
      if (!claim) throw new Error("Missing reference claim");
      const operation = {
        authorizationBinding,
        claimantBinding,
        goalId: goal.id,
        stepId: "reference",
        claimToken: claim.claimToken,
        role: "work" as const,
        operationId: `reference-${stateEffect}`,
        toolName: `native__${stateEffect}`,
        targetIdentity: `native\0${stateEffect}`,
        resourceDigest: sha("reference-resource"),
        stateEffect,
        modelEffect: "none" as const,
      };
      await expect(
        store.beginExecution({ ...operation, claimantBinding: "another-turn" }),
      ).rejects.toThrow("DIRECT_GOAL_CLAIM_INVALID_OR_EXPIRED");
      const recorded = await execute(store, {
        ...operation,
        resultDigest: sha("native-result"),
        outcome: "succeeded",
      });
      expect(recorded.steps[0]).toMatchObject({
        allowedToolNames: ["legacy__suggested_tool"],
        state: "completed",
        receipts: [
          { operationId: operation.operationId, toolName: operation.toolName, stateEffect },
        ],
      });
      await expect(
        store.beginExecution({ ...operation, toolName: "different__tool" }),
      ).rejects.toThrow("DIRECT_GOAL_OPERATION_ID_CONFLICT");
      clearDirectGoalProcessCore(snapshotPath);
      store = await DirectGoalStore.open({ snapshotPath });
      expect(await store.get(authorizationBinding, goal.id)).toEqual(recorded);
      expect(
        await store.get("issuer\0another-owner\0client\0reference-tool-list", goal.id),
      ).toBeUndefined();
    },
  );

  it.each(["paused", "complete", "blocked"] as const)(
    "preserves an allocated native call when %s races with beginExecution",
    async (status) => {
      const snapshotPath = join(await temporaryRoot(), "allocated-lifecycle.json");
      const authorizationBinding = "issuer\0owner\0client\0allocated-lifecycle";
      let store = await DirectGoalStore.open({ snapshotPath });
      const goal = await store.create({
        authorizationBinding,
        objective: "Finish the selected native operation",
      });
      const native = {
        authorizationBinding,
        claimantBinding: "allocated-turn",
        toolName: "codex__app_server__fs_writeFile",
        targetIdentity: "app_server\0fs/writeFile",
        resourceDigest: sha("allocated-resource"),
        stateEffect: "mutate" as const,
        modelEffect: "none" as const,
      };
      const context = await store.resolvePendingExecution(native);
      if (!context) throw new Error("Missing allocated native context");
      const operation = { ...native, ...context, operationId: "allocated-operation" };
      const changed = await store.updateStatus({
        authorizationBinding,
        goalId: goal.id,
        status,
        ...(status === "blocked" ? { reason: "Waiting for another resource" } : {}),
      });
      expect(changed.steps[0]?.reservation).toBeUndefined();
      expect(await store.resolvePendingExecution(native)).toBeUndefined();
      clearDirectGoalProcessCore(snapshotPath);
      store = await DirectGoalStore.open({ snapshotPath });
      expect(await store.get(authorizationBinding)).toEqual(changed);
      expect(await store.resolvePendingExecution(native)).toBeUndefined();
      await expect(
        store.beginExecution({ ...operation, claimantBinding: "unrelated-turn" }),
      ).rejects.toThrow("DIRECT_GOAL_CLAIM_INVALID_OR_EXPIRED");
      const result = await execute(store, {
        ...operation,
        resultDigest: sha("selected-write-result"),
        outcome: "succeeded",
      });
      expect(result.state).toBe(status === "complete" ? "completed" : status);
      expect(result.steps[0]?.receipts[0]?.operationId).toBe(operation.operationId);
      clearDirectGoalProcessCore(snapshotPath);
      store = await DirectGoalStore.open({ snapshotPath });
      expect(await store.get(authorizationBinding)).toEqual(result);
      const resumed = await store.updateStatus({
        authorizationBinding,
        goalId: goal.id,
        status: "active",
      });
      expect(resumed.steps).toEqual(result.steps);
      const next = await store.resolvePendingExecution(native);
      expect(next).toMatchObject({ goalId: goal.id, role: "work" });
      expect(next?.stepId).not.toBe(context.stepId);
    },
  );

  it.each(["paused", "complete", "blocked"] as const)(
    "preserves dispatched work across %s, disk restart, and late result recovery",
    async (status) => {
      const root = await temporaryRoot();
      const snapshotPath = join(root, "lifecycle.json");
      const authorizationBinding = "issuer\0owner\0client\0lifecycle";
      let store = await DirectGoalStore.open({ snapshotPath });
      const goal = await store.create({
        authorizationBinding,
        objective: "Read the requested file",
      });
      const native = {
        authorizationBinding,
        claimantBinding: "lifecycle-turn",
        toolName: "codex__app_server__fs_readFile",
        targetIdentity: "app_server\0fs/readFile",
        resourceDigest: sha("lifecycle-resource"),
        stateEffect: "read" as const,
        modelEffect: "none" as const,
      };
      const context = await store.resolvePendingExecution(native);
      if (!context) throw new Error("Missing execution context");
      const operation = { ...native, ...context, operationId: "lifecycle-operation" };
      await store.beginExecution(operation);
      await store.markExecutionDispatched(operation);
      const changed = await store.updateStatus({
        authorizationBinding,
        goalId: goal.id,
        status,
        ...(status === "blocked" ? { reason: "Waiting for required resource" } : {}),
      });
      expect(changed.steps[0]?.reservation?.operationId).toBe(operation.operationId);
      expect(await store.resolvePendingExecution(native)).toBeUndefined();
      clearDirectGoalProcessCore(snapshotPath);
      store = await DirectGoalStore.open({ snapshotPath });
      expect(await store.get(authorizationBinding)).toEqual(changed);
      expect(
        await store.resolvePendingExecution({ ...native, operationId: operation.operationId }),
      ).toEqual(context);
      const result = await store.finalizeExecution({
        ...operation,
        resultDigest: sha("file-content"),
        outcome: "succeeded",
      });
      expect(result.state).toBe(status === "complete" ? "completed" : status);
      expect(result.steps[0]?.receipts[0]?.operationId).toBe(operation.operationId);
      clearDirectGoalProcessCore(snapshotPath);
      store = await DirectGoalStore.open({ snapshotPath });
      const resumed = await store.updateStatus({
        authorizationBinding,
        goalId: goal.id,
        status: "active",
      });
      expect(resumed.steps).toEqual(result.steps);
      expect(resumed.id).toBe(goal.id);
      expect(resumed).not.toHaveProperty("completedAtUnixMs");
      expect(resumed).not.toHaveProperty("blockedReason");
    },
  );

  it("rejects completion while any declared step is unfinished", async () => {
    const root = await temporaryRoot();
    const snapshotPath = join(root, "reference-steps.json");
    const authorizationBinding = "issuer\0owner\0client\0reference-steps";
    let store = await DirectGoalStore.open({ snapshotPath });
    const goal = await store.create({
      authorizationBinding,
      objective: "Deliver the requested result",
      steps: [
        {
          id: "reference",
          description: "Optional progress note",
          mode: "mutation_and_readback",
          allowedToolNames: ["old-tool"],
        },
      ],
    });
    await expect(store.complete({ authorizationBinding, goalId: goal.id })).rejects.toThrow(
      "DIRECT_GOAL_HAS_UNFINISHED_STEPS: pending=1, claimed=0, awaiting_readback=0",
    );
    expect(await store.get(authorizationBinding)).toEqual(goal);
    clearDirectGoalProcessCore(snapshotPath);
    store = await DirectGoalStore.open({ snapshotPath });
    expect(await store.get(authorizationBinding)).toEqual(goal);
    await store.claimNext({ authorizationBinding, claimantBinding: "worker", goalId: goal.id });
    await expect(store.complete({ authorizationBinding, goalId: goal.id })).rejects.toThrow(
      "DIRECT_GOAL_HAS_UNFINISHED_STEPS: pending=0, claimed=1, awaiting_readback=0",
    );
  });

  it("persists deletion, ignores a late final, and allows a replacement Goal", async () => {
    const root = await temporaryRoot();
    const snapshotPath = join(root, "deleted-goal.json");
    const authorizationBinding = "issuer\0owner\0client\0deleted-conversation";
    let now = 1_000;
    let store = await DirectGoalStore.open({ snapshotPath, nowUnixMs: () => now });
    const goal = await store.create({
      authorizationBinding,
      idempotencyKey: "deleted-goal-test-0001",
      objective: "Temporary Goal",
    });

    now = 2_000;
    const deletion = await store.delete({ authorizationBinding, goalId: goal.id });
    expect(deletion).toEqual({ goalId: goal.id, deleted: true, deletedAtUnixMs: now });
    expect(await store.get(authorizationBinding)).toBeUndefined();
    expect(await store.get(authorizationBinding, goal.id)).toBeUndefined();
    expect(await store.pendingContinuations()).toEqual([]);

    clearDirectGoalProcessCore(snapshotPath);
    store = await DirectGoalStore.open({ snapshotPath, nowUnixMs: () => now });
    expect(await store.delete({ authorizationBinding, goalId: goal.id })).toEqual(deletion);
    await store.observeConversation({
      conversationUrl: "https://chatgpt.com/c/deleted-goal-test",
      goals: [
        {
          messageId: "deleted-goal-result",
          toolName: "omnicodex__goal_get",
          goalId: goal.id,
          state: "active",
          revision: goal.revision,
          createdAtUnixMs: goal.createdAtUnixMs,
        },
      ],
      current: {
        id: "late-final",
        ancestorMessageIds: ["deleted-goal-result"],
        authorRole: "assistant",
        status: "finished_successfully",
        endTurn: true,
        channel: "final",
      },
    });
    expect(await store.get(authorizationBinding, goal.id)).toBeUndefined();
    expect(await store.pendingContinuations()).toEqual([]);

    const replacement = await store.create({
      authorizationBinding,
      idempotencyKey: "deleted-goal-test-0001",
      objective: "Replacement Goal",
    });
    expect(replacement.id).not.toBe(goal.id);
    expect(await store.get(authorizationBinding)).toEqual(replacement);
  });

  it("preserves an in-flight execution when the user revises its objective", async () => {
    const store = DirectGoalStore.inMemory();
    const authorizationBinding = "issuer\0owner\0client\0objective-revision";
    const native = {
      authorizationBinding,
      claimantBinding: "turn-objective-revision",
      toolName: "codex__app_server__fs_readFile",
      targetIdentity: "app_server\0fs/readFile",
      resourceDigest: sha("objective-revision-resource"),
      stateEffect: "read" as const,
      modelEffect: "none" as const,
    };
    const goal = await store.create({
      authorizationBinding,
      objective: "Initial objective",
    });
    const context = await store.resolvePendingExecution(native);
    if (!context) throw new Error("Missing dynamic Goal execution context");
    const operation = {
      ...native,
      ...context,
      operationId: "objective-revision-operation",
    };
    await store.beginExecution(operation);
    await store.markExecutionDispatched(operation);

    const revised = await store.updateStatus({
      authorizationBinding,
      goalId: goal.id,
      objective: "Revised objective",
    });
    expect(revised.objective).toBe("Revised objective");
    expect(revised.steps[0]?.reservation?.operationId).toBe(operation.operationId);

    const finalized = await store.finalizeExecution({
      ...operation,
      resultDigest: sha("objective-revision-result"),
      outcome: "succeeded",
    });
    expect(finalized.objective).toBe("Revised objective");
    expect(finalized.steps[0]?.receipts[0]?.operationId).toBe(operation.operationId);
  });

  it("rolls back only a fresh dynamic allocation when a completed operation ID conflicts", async () => {
    const store = DirectGoalStore.inMemory();
    const native = {
      authorizationBinding: "issuer\0owner\0client\0conversation",
      claimantBinding: "turn",
      toolName: "codex__desktop_lifecycle__status",
      targetIdentity: "desktop",
      resourceDigest: sha("desktop"),
      stateEffect: "read" as const,
      modelEffect: "none" as const,
    };
    const goal = await store.create({
      authorizationBinding: native.authorizationBinding,
      objective: "Read status",
    });
    const first = await store.resolvePendingExecution(native);
    if (!first) throw new Error("Missing first claim");
    await execute(store, {
      ...native,
      ...first,
      operationId: "same-operation",
      resultDigest: sha("success"),
      outcome: "succeeded",
    });
    const duplicate = await store.resolvePendingExecution(native);
    if (!duplicate) throw new Error("Missing duplicate claim");
    await expect(
      store.beginExecution({ ...native, ...duplicate, operationId: "same-operation" }),
    ).rejects.toThrow("DIRECT_GOAL_OPERATION_ID_CONFLICT");
    const recovered = await store.get(native.authorizationBinding, goal.id);
    expect(recovered?.steps).toHaveLength(1);
    expect(recovered?.steps[0]?.receipts[0]?.operationId).toBe("same-operation");
    expect(
      (await store.complete({ authorizationBinding: native.authorizationBinding, goalId: goal.id }))
        .state,
    ).toBe("completed");
  });

  it("records dynamically selected native work across reconnects without predeclared steps", async () => {
    const root = await temporaryRoot();
    const snapshotPath = join(root, "dynamic-goal.json");
    const authorizationBinding = "issuer\0owner\0client\0dynamic-conversation";
    let store = await DirectGoalStore.open({ snapshotPath });
    const created = await store.create({
      authorizationBinding,
      objective: "Read, create, and verify the requested resource",
    });
    expect((await store.complete({ authorizationBinding, goalId: created.id })).state).toBe(
      "completed",
    );
    clearDirectGoalProcessCore(snapshotPath);
    store = await DirectGoalStore.open({ snapshotPath });
    await store.updateStatus({ authorizationBinding, goalId: created.id, status: "active" });
    for (const [turn, toolName, stateEffect, modelEffect] of [
      [1, "codex__app_server__fs_readFile", "read", "none"],
      [2, "codex__image_gen__imagegen", "mutate", "model"],
      [3, "codex__app_server__fs_getMetadata", "read", "none"],
      [4, "codex_app__send_message_to_thread", "mutate", "model"],
      [5, "codex__responses__turn_start", "mutate", "model"],
      [6, "codex__functions__exec", "mutate", "unknown"],
    ] as const) {
      const claimantBinding = `turn-${turn}`;
      const native = {
        authorizationBinding,
        claimantBinding,
        toolName,
        stateEffect,
        modelEffect,
        resourceDigest: sha("resource"),
      };
      expect(
        await store.resolvePendingExecution({
          ...native,
          authorizationBinding: "issuer\0other\0client\0dynamic-conversation",
        }),
      ).toBeUndefined();
      const context = await store.resolvePendingExecution(native);
      expect(context).toMatchObject({ goalId: created.id, role: "work" });
      if (context === undefined) throw new Error("Missing automatic Goal context");
      await execute(store, {
        ...native,
        ...context,
        operationId: `dynamic-operation-${turn}`,
        targetIdentity: "native-resource",
        resultDigest: sha(`actual-result-${turn}`),
        outcome: "succeeded",
      });
      clearDirectGoalProcessCore(snapshotPath);
      store = await DirectGoalStore.open({ snapshotPath });
      expect((await store.get(authorizationBinding))?.steps).toHaveLength(turn);
      expect(await store.create({ authorizationBinding, objective: created.objective })).toEqual(
        await store.get(authorizationBinding),
      );
    }
    const completed = await store.complete({ authorizationBinding, goalId: created.id });
    expect(completed.steps.map((step) => step.receipts[0]?.operationId)).toEqual([
      "dynamic-operation-1",
      "dynamic-operation-2",
      "dynamic-operation-3",
      "dynamic-operation-4",
      "dynamic-operation-5",
      "dynamic-operation-6",
    ]);
    clearDirectGoalProcessCore(snapshotPath);
    store = await DirectGoalStore.open({ snapshotPath });
    expect(await store.get(authorizationBinding)).toEqual(completed);
    expect(
      (await store.create({ authorizationBinding, objective: created.objective })).id,
    ).not.toBe(created.id);
  });

  it("bounds completed automatic execution receipts while preserving an unfinished fence", async () => {
    const store = DirectGoalStore.inMemory();
    const authorizationBinding = "issuer\0owner\0client\0bounded-dynamic-history";
    const goal = await store.create({
      authorizationBinding,
      objective: "Keep native execution history bounded",
    });
    const native = {
      authorizationBinding,
      claimantBinding: "bounded-session",
      toolName: "codex__app_server__fs_readFile",
      targetIdentity: "native-resource",
      resourceDigest: sha("bounded-resource"),
      stateEffect: "read" as const,
      modelEffect: "none" as const,
    };

    for (let index = 0; index < 66; index += 1) {
      const context = await store.resolvePendingExecution(native);
      if (context === undefined) throw new Error("Missing bounded automatic Goal context");
      await execute(store, {
        ...native,
        ...context,
        operationId: `bounded-operation-${String(index)}`,
        resultDigest: sha(`bounded-result-${String(index)}`),
        outcome: "succeeded",
      });
    }

    const pending = await store.resolvePendingExecution(native);
    if (pending === undefined) throw new Error("Missing unfinished automatic Goal context");
    const view = await store.get(authorizationBinding, goal.id);
    expect(view?.steps).toHaveLength(65);
    expect(view?.steps.filter((step) => step.state === "completed")).toHaveLength(64);
    expect(view?.steps[0]?.receipts[0]?.operationId).toBe("bounded-operation-2");
    expect(view?.steps.at(-1)).toMatchObject({ id: pending.stepId, state: "claimed" });
  });

  it("keeps concurrent dynamic operations and their outcomes distinct when Pro completes and reopens", async () => {
    const store = DirectGoalStore.inMemory();
    const authorizationBinding = "issuer\0owner\0client\0parallel-conversation";
    const goal = await store.create({
      authorizationBinding,
      objective: "Finish both native operations",
    });
    const native = {
      authorizationBinding,
      claimantBinding: "same-session",
      toolName: "codex__app_server__fs_readFile",
      stateEffect: "read" as const,
      modelEffect: "none" as const,
      resourceDigest: sha("resource"),
    };
    const abandoned = await store.resolvePendingExecution(native);
    if (abandoned === undefined) throw new Error("Missing pre-dispatch context");
    const preDispatch = {
      ...native,
      ...abandoned,
      operationId: "never-dispatched",
      targetIdentity: "file",
    };
    await store.beginExecution(preDispatch);
    await store.abortBeforeDispatch(preDispatch);
    const [first, second] = await Promise.all([
      store.resolvePendingExecution(native),
      store.resolvePendingExecution(native),
    ]);
    if (first === undefined || second === undefined) throw new Error("Missing dynamic contexts");
    expect(first.stepId).not.toBe(second.stepId);
    const one = {
      ...native,
      ...first,
      operationId: "parallel-one",
      targetIdentity: "file",
      resultDigest: sha("failure"),
      outcome: "failed" as const,
    };
    await execute(store, one);
    const two = {
      ...native,
      ...second,
      operationId: "parallel-two",
      targetIdentity: "file",
      resultDigest: sha("result"),
      outcome: "succeeded" as const,
    };
    await store.beginExecution(two);
    await store.markExecutionDispatched(two);
    expect((await store.complete({ authorizationBinding, goalId: goal.id })).state).toBe(
      "completed",
    );
    await store.finalizeExecution(two);
    expect((await store.get(authorizationBinding))?.state).toBe("completed");
    await store.updateStatus({ authorizationBinding, goalId: goal.id, status: "active" });
    const retry = await store.resolvePendingExecution(native);
    expect(retry?.stepId).toBe(first.stepId);
    if (retry === undefined) throw new Error("Missing retry");
    await execute(store, {
      ...one,
      ...retry,
      operationId: "parallel-one-retry",
      resultDigest: sha("recovered-result"),
      outcome: "succeeded",
    });
    expect((await store.complete({ authorizationBinding, goalId: goal.id })).state).toBe(
      "completed",
    );
  });

  it("keeps a Goal active and retryable after one authoritative tool error", async () => {
    const store = DirectGoalStore.inMemory();
    const authorizationBinding = "issuer\0owner\0client\0tool-error-retry";
    const claimantBinding = "work-session:tool-error-retry";
    const goal = await store.create({
      authorizationBinding,
      objective: "Finish after a rejected native call",
      steps: [{ id: "read", description: "Read the target", mode: "successful_call" }],
    });
    const claim = await store.claimNext({ authorizationBinding, claimantBinding, goalId: goal.id });
    if (claim === undefined) throw new Error("Missing initial Goal claim");
    const native = {
      authorizationBinding,
      claimantBinding,
      goalId: goal.id,
      stepId: claim.step.id,
      claimToken: claim.claimToken,
      role: "work" as const,
      toolName: "codex__app_server__fs_readFile",
      targetIdentity: "app_server\0fs/readFile",
      resourceDigest: sha("tool-error-resource"),
      stateEffect: "read" as const,
      modelEffect: "none" as const,
    };

    const afterError = await execute(store, {
      ...native,
      operationId: "rejected-native-call",
      resultDigest: sha("permission-denied-result"),
      outcome: "tool_error",
    });
    expect(afterError).toMatchObject({
      id: goal.id,
      state: "active",
      steps: [{ id: "read", state: "claimed", receipts: [] }],
    });

    await execute(store, {
      ...native,
      operationId: "successful-native-retry",
      resultDigest: sha("successful-result"),
      outcome: "succeeded",
    });
    expect((await store.complete({ authorizationBinding, goalId: goal.id })).state).toBe(
      "completed",
    );
  });

  it("persists a blocked Goal and resumes its original evidence only for its owner", async () => {
    const root = await temporaryRoot();
    const snapshotPath = join(root, "blocked-goal.json");
    const authorizationBinding = "issuer\0owner\0client\0conversation";
    const store = await DirectGoalStore.open({ snapshotPath });
    const goal = await store.create({
      authorizationBinding,
      idempotencyKey: "blocked-goal-create-0001",
      objective: "Finish the original work",
      steps: [{ id: "read", description: "Read source", mode: "successful_call" }],
    });
    await store.claimNext({ authorizationBinding, claimantBinding: "claimant", goalId: goal.id });
    await expect(
      store.updateStatus({ authorizationBinding, goalId: goal.id, status: "blocked", reason: " " }),
    ).rejects.toThrow("reason");
    await expect(
      store.updateStatus({
        authorizationBinding: "issuer\0other\0client\0conversation",
        goalId: goal.id,
        status: "blocked",
        reason: "Unavailable permission",
      }),
    ).rejects.toThrow();
    const blocked = await store.updateStatus({
      authorizationBinding,
      goalId: goal.id,
      status: "blocked",
      reason: "The required external permission remains unavailable after repeated attempts.",
    });
    expect(blocked).toMatchObject({
      state: "blocked",
      objective: goal.objective,
      blockedAtUnixMs: expect.any(Number),
      steps: [{ state: "pending", receipts: [] }],
    });
    expect(blocked.steps[0]).not.toHaveProperty("claimExpiresAtUnixMs");
    expect(
      await store.updateStatus({
        authorizationBinding,
        goalId: goal.id,
        status: "blocked",
        reason: blocked.blockedReason ?? "",
      }),
    ).toEqual(blocked);
    clearDirectGoalProcessCore(snapshotPath);
    const reopened = await DirectGoalStore.open({ snapshotPath });
    expect(await reopened.get(authorizationBinding)).toEqual(blocked);
    expect(
      await reopened.claimNext({
        authorizationBinding,
        claimantBinding: "claimant",
        goalId: goal.id,
      }),
    ).toBeUndefined();
    await expect(
      reopened.updateStatus({ authorizationBinding, goalId: goal.id, status: "complete" }),
    ).rejects.toThrow(
      "DIRECT_GOAL_HAS_UNFINISHED_STEPS: pending=1, claimed=0, awaiting_readback=0",
    );
    const resumed = await reopened.updateStatus({
      authorizationBinding,
      goalId: goal.id,
      status: "active",
    });
    expect(resumed.state).toBe("active");
    expect(resumed).not.toHaveProperty("blockedReason");
    expect(resumed).not.toHaveProperty("blockedAtUnixMs");
    expect(resumed.steps).toEqual(blocked.steps);
    expect(
      await reopened.updateStatus({ authorizationBinding, goalId: goal.id, status: "active" }),
    ).toEqual(resumed);
    const resumedClaim = await reopened.claimNext({
      authorizationBinding,
      claimantBinding: "claimant",
      goalId: goal.id,
    });
    if (resumedClaim === undefined) throw new Error("Missing resumed claim");
    await execute(reopened, {
      authorizationBinding,
      claimantBinding: "claimant",
      goalId: goal.id,
      stepId: "read",
      claimToken: resumedClaim.claimToken,
      role: "work",
      operationId: "resumed-read-operation",
      toolName: "codex__app_server__fs_readFile",
      targetIdentity: "app_server\0fs/readFile",
      resourceDigest: sha("resumed-resource"),
      resultDigest: sha("resumed-result"),
      stateEffect: "read",
      modelEffect: "none",
      outcome: "succeeded",
    });
    expect(
      (await reopened.updateStatus({ authorizationBinding, goalId: goal.id, status: "complete" }))
        .state,
    ).toBe("completed");
  });

  it("does not resume a blocked Goal over a different active Goal", async () => {
    const store = DirectGoalStore.inMemory();
    const authorizationBinding = "issuer\0owner\0client\0conversation";
    const definition = {
      authorizationBinding,
      objective: "Original scope",
      steps: [{ id: "read", description: "Read", mode: "successful_call" as const }],
    };
    const first = await store.create({ ...definition, idempotencyKey: "blocked-goal-one-0001" });
    await store.updateStatus({
      authorizationBinding,
      goalId: first.id,
      status: "blocked",
      reason: "Verified external impasse",
    });
    const second = await store.create({ ...definition, idempotencyKey: "blocked-goal-two-0002" });
    await expect(
      store.updateStatus({ authorizationBinding, goalId: first.id, status: "active" }),
    ).rejects.toThrow("DIRECT_GOAL_ALREADY_ACTIVE");
    expect((await store.get(authorizationBinding))?.id).toBe(second.id);
  });

  it("retains native outcome recovery while blocked and can reopen a completed Goal", async () => {
    const store = DirectGoalStore.inMemory();
    const authorizationBinding = "issuer\0owner\0client\0conversation";
    const claimantBinding = "claimant";
    const goal = await store.create({
      authorizationBinding,
      idempotencyKey: "blocked-inflight-0001",
      objective: "Complete the actual native operation",
      steps: [{ id: "read", description: "Read source", mode: "successful_call" }],
    });
    const claim = await store.claimNext({ authorizationBinding, claimantBinding, goalId: goal.id });
    const operation = {
      authorizationBinding,
      claimantBinding,
      goalId: goal.id,
      stepId: "read",
      claimToken: claim?.claimToken ?? "",
      role: "work" as const,
      operationId: "blocked-inflight-operation",
      toolName: "codex__app_server__fs_readFile",
      targetIdentity: "app_server\0fs/readFile",
      resourceDigest: sha("resource"),
      stateEffect: "read" as const,
      modelEffect: "none" as const,
    };
    await store.beginExecution(operation);
    await store.markExecutionDispatched(operation);
    await store.markExecutionOutcomeUnknown(operation);
    expect(
      (
        await store.updateStatus({
          authorizationBinding,
          goalId: goal.id,
          status: "blocked",
          reason: "Connection unavailable",
        })
      ).state,
    ).toBe("blocked");
    expect((await store.get(authorizationBinding))?.steps[0]?.reservation?.state).toBe(
      "outcome_unknown",
    );
    await store.finalizeExecution({
      ...operation,
      resultDigest: sha("result"),
      outcome: "succeeded",
    });
    const completed = await store.updateStatus({
      authorizationBinding,
      goalId: goal.id,
      status: "complete",
    });
    expect(completed.state).toBe("completed");
    expect(
      (await store.updateStatus({ authorizationBinding, goalId: goal.id, status: "active" })).state,
    ).toBe("active");
  });

  it("settles one dispatched dynamic mutation from an exact authoritative readback", async () => {
    const store = DirectGoalStore.inMemory();
    const authorizationBinding = "issuer\0owner\0client\0unknown-browser-execution";
    const claimantBinding = "work-session:company";
    const resourceDigest = sha("browser_native\0chrome__control_chrome");
    const goal = await store.create({
      authorizationBinding,
      objective: "Recover the exact Chrome operation without replaying it.",
    });
    const nativeMutation = {
      authorizationBinding,
      claimantBinding,
      toolName: "chrome__control_chrome",
      resourceDigest,
      stateEffect: "mutate" as const,
      modelEffect: "none" as const,
    };
    const context = await store.resolvePendingExecution(nativeMutation);
    if (context === undefined) throw new Error("Missing dynamic mutation context");
    const reservation = {
      ...nativeMutation,
      ...context,
      operationId: "unknown-browser-operation",
      targetIdentity: "browser_native\0chrome__control_chrome",
    };
    await store.beginExecution(reservation);
    await store.markExecutionDispatched(reservation);

    const readbackInput = {
      authorizationBinding,
      claimantBinding,
      resourceDigest,
      stateEffect: "read" as const,
      modelEffect: "none" as const,
    };
    expect(
      await store.resolveUnknownExecutionReadback({
        ...readbackInput,
        claimantBinding: "work-session:other",
      }),
    ).toBeUndefined();
    expect(
      await store.resolveUnknownExecutionReadback({
        ...readbackInput,
        resourceDigest: sha("another-browser-resource"),
      }),
    ).toBeUndefined();
    const recovery = await store.resolveUnknownExecutionReadback(readbackInput);
    expect(recovery).toEqual({
      goalId: goal.id,
      stepId: context.stepId,
      operationId: reservation.operationId,
      resourceDigest,
    });
    if (recovery === undefined) throw new Error("Missing exact readback recovery context");

    await store.updateStatus({
      authorizationBinding,
      goalId: goal.id,
      status: "paused",
    });
    expect(await store.resolveUnknownExecutionReadback(readbackInput)).toBeUndefined();
    await store.updateStatus({ authorizationBinding, goalId: goal.id, status: "active" });

    const finalized = await store.finalizeUnknownExecutionReadback({
      ...readbackInput,
      context: recovery,
      proofOperationId: "browser-inspection-proof",
      proofToolName: "chrome__control_chrome",
      proofTargetIdentity: "browser_native\0chrome__control_chrome",
      proofResultDigest: sha("fresh accessibility state"),
    });
    expect(finalized).toMatchObject({
      recoveredOperationId: reservation.operationId,
      proofOperationId: "browser-inspection-proof",
      goal: {
        id: goal.id,
        steps: [
          {
            id: context.stepId,
            state: "completed",
            receipts: [
              {
                operationId: "browser-inspection-proof",
                stateEffect: "read",
                resourceDigest,
              },
            ],
          },
        ],
      },
    });
    expect(await store.resolveUnknownExecutionReadback(readbackInput)).toBeUndefined();
  });

  it("atomically retains one active Goal and recovers it without an ID after restart", async () => {
    const root = await temporaryRoot();
    const snapshotPath = join(root, "current-goal.json");
    const authorizationBinding = "issuer\0owner\0client\0conversation";
    const store = await DirectGoalStore.open({ snapshotPath });
    expect(await store.get(authorizationBinding)).toBeUndefined();
    const definition = {
      authorizationBinding,
      objective: "Continue the same durable objective",
      steps: [{ id: "read", description: "Read the project", mode: "successful_call" as const }],
    };
    const inputs = ["concurrent-goal-create-01", "concurrent-goal-create-02"].map(
      (idempotencyKey) => ({ ...definition, idempotencyKey }),
    );
    const results = await Promise.allSettled(inputs.map((input) => store.create(input)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: { message: "DIRECT_GOAL_ALREADY_ACTIVE" } },
    ]);
    const current = await store.get(authorizationBinding);
    expect(current?.state).toBe("active");
    const winner = results.findIndex((result) => result.status === "fulfilled");
    const winningInput = inputs[winner];
    if (winningInput === undefined) throw new Error("Missing successful creation");
    expect(await store.create(winningInput)).toEqual(current);
    clearDirectGoalProcessCore(snapshotPath);
    const reloaded = await DirectGoalStore.open({ snapshotPath });
    expect(await reloaded.get(authorizationBinding)).toEqual(current);
    expect(await reloaded.get("issuer\0different-owner\0client\0conversation")).toBeUndefined();
  });

  it("persists an owner-bound idempotent goal without exposing ownership material", async () => {
    const root = await temporaryRoot();
    const snapshotPath = join(root, "direct-goals.json");
    const store = await DirectGoalStore.open({ snapshotPath });
    const input = {
      authorizationBinding: "issuer\0owner-a\0client\0resource",
      idempotencyKey: "goal-create-0000000000000001",
      objective: "Perform the work directly and verify it.",
      steps: [
        {
          id: "inspect",
          description: "Read the authoritative source.",
          mode: "successful_call" as const,
          allowedToolNames: ["codex__app_server__fs_readFile"],
        },
      ],
    };

    const created = await store.create(input);
    const replayed = await store.create(input);

    expect(replayed).toEqual(created);
    expect(await store.get(input.authorizationBinding, created.id)).toEqual(created);
    expect(await store.get("issuer\0owner-b\0client\0resource", created.id)).toBeUndefined();
    const persisted = await readFile(snapshotPath, "utf8");
    expect(persisted).not.toContain(input.authorizationBinding);
    expect(persisted).not.toContain(input.idempotencyKey);
  });

  it("records a later direct readback on the same resource in step history", async () => {
    const store = DirectGoalStore.inMemory();
    const authorizationBinding = "issuer\0owner\0client\0resource";
    const claimantBinding = "session:one";
    const goal = await store.create({
      authorizationBinding,
      idempotencyKey: "goal-create-0000000000000002",
      objective: "Write and read back one file.",
      steps: [
        {
          id: "write",
          description: "Write and verify the target file.",
          mode: "mutation_and_readback",
          allowedToolNames: ["codex__app_server__fs_writeFile", "codex__app_server__fs_readFile"],
        },
      ],
    });
    const claim = await store.claimNext({
      authorizationBinding,
      claimantBinding,
      goalId: goal.id,
    });
    expect(claim).toBeDefined();

    const afterWrite = await execute(store, {
      authorizationBinding,
      claimantBinding,
      goalId: goal.id,
      stepId: "write",
      claimToken: claim?.claimToken ?? "",
      role: "work",
      operationId: "write-operation-0001",
      toolName: "codex__app_server__fs_writeFile",
      targetIdentity: "app_server\0fs/writeFile",
      resourceDigest: sha("C:\\work\\target.txt"),
      resultDigest: sha("write-result"),
      stateEffect: "mutate",
      modelEffect: "none",
      outcome: "succeeded",
    });
    expect(afterWrite.steps[0]?.state).toBe("awaiting_readback");

    const readbackClaim = await store.resolvePendingExecution({
      authorizationBinding,
      claimantBinding,
      toolName: "codex__app_server__fs_readFile",
      resourceDigest: sha("C:\\work\\target.txt"),
      stateEffect: "read",
      modelEffect: "none",
    });
    expect(readbackClaim).toMatchObject({ goalId: goal.id, role: "work" });
    expect(readbackClaim?.stepId).not.toBe("write");
    const afterReadback = await execute(store, {
      authorizationBinding,
      claimantBinding,
      goalId: goal.id,
      stepId: "write",
      claimToken: claim?.claimToken ?? "",
      role: "readback",
      provesOperationId: "write-operation-0001",
      operationId: "read-operation-0001",
      toolName: "codex__app_server__fs_readFile",
      targetIdentity: "app_server\0fs/readFile",
      resourceDigest: sha("C:\\work\\target.txt"),
      resultDigest: sha("expected bytes"),
      stateEffect: "read",
      modelEffect: "none",
      outcome: "succeeded",
    });
    expect(afterReadback.steps[0]?.state).toBe("completed");
    expect((await store.complete({ authorizationBinding, goalId: goal.id })).state).toBe(
      "completed",
    );
    expect(await store.get(authorizationBinding)).toMatchObject({
      id: goal.id,
      state: "completed",
    });
    const next = await store.create({
      authorizationBinding,
      idempotencyKey: "goal-after-completion-0001",
      objective: "Start the next requested objective",
      steps: [{ id: "next", description: "Read the next file", mode: "successful_call" }],
    });
    expect(await store.get(authorizationBinding)).toEqual(next);
    expect(await store.get(authorizationBinding, goal.id)).toMatchObject({ state: "completed" });
  });

  it("renews a lost live token for the same awaiting-readback step", async () => {
    let now = 10_000;
    const store = DirectGoalStore.inMemory({ nowUnixMs: () => now });
    const authorizationBinding = "issuer\0owner\0client\0renew-readback";
    const claimantBinding = "session:renew-readback";
    const goal = await store.create({
      authorizationBinding,
      objective: "Write and verify one file after a reconnect.",
      steps: [
        {
          id: "write",
          description: "Write and read back.",
          mode: "mutation_and_readback",
          allowedToolNames: ["codex__app_server__fs_writeFile", "codex__app_server__fs_readFile"],
        },
      ],
    });
    const first = await store.claimNext({
      authorizationBinding,
      claimantBinding,
      goalId: goal.id,
      leaseMs: 60_000,
    });
    if (first === undefined) throw new Error("Missing initial claim");
    await execute(store, {
      authorizationBinding,
      claimantBinding,
      goalId: goal.id,
      stepId: "write",
      claimToken: first.claimToken,
      role: "work",
      operationId: "renew-work-operation-0001",
      toolName: "codex__app_server__fs_writeFile",
      targetIdentity: "app_server\0fs/writeFile",
      resourceDigest: sha("renew-resource"),
      resultDigest: sha("renew-work-result"),
      stateEffect: "mutate",
      modelEffect: "none",
      outcome: "succeeded",
    });

    now += 1_000;
    const renewed = await store.claimNext({
      authorizationBinding,
      claimantBinding,
      goalId: goal.id,
      leaseMs: 120_000,
    });
    expect(renewed).toMatchObject({
      step: { id: "write", state: "awaiting_readback" },
      claimExpiresAtUnixMs: now + 120_000,
    });
    expect(renewed?.claimToken).not.toBe(first.claimToken);
    await expect(
      store.beginExecution({
        authorizationBinding,
        claimantBinding,
        goalId: goal.id,
        stepId: "write",
        claimToken: first.claimToken,
        role: "readback",
        provesOperationId: "renew-work-operation-0001",
        operationId: "stale-read-operation-0001",
        toolName: "codex__app_server__fs_readFile",
        targetIdentity: "app_server\0fs/readFile",
        resourceDigest: sha("renew-resource"),
        stateEffect: "read",
        modelEffect: "none",
      }),
    ).rejects.toThrow("DIRECT_GOAL_CLAIM_INVALID_OR_EXPIRED");
  });

  it("accepts explicitly named tools from the full OmniCodex surface", async () => {
    const store = DirectGoalStore.inMemory();
    const authorizationBinding = "issuer\0owner\0client\0full-surface";
    const allowedToolNames = [
      "codex_app__send_message_to_thread",
      "codex_app__create_thread",
      "codex__functions__exec",
    ];
    const goal = await store.create({
      authorizationBinding,
      idempotencyKey: "goal-create-full-surface-0001",
      objective: "Use every explicitly selected OmniCodex tool.",
      steps: [
        {
          id: "full-surface",
          description: "Run the selected tool.",
          mode: "successful_call",
          allowedToolNames,
        },
      ],
    });

    expect(goal.steps[0]?.allowedToolNames).toEqual(allowedToolNames);
  });

  it("reopens an execution record even when an old step names a different tool", async () => {
    const snapshotPath = join(await temporaryRoot(), "legacy-tool-reference.json");
    const store = await DirectGoalStore.open({ snapshotPath });
    const authorizationBinding = "issuer\0owner\0client\0legacy-tool-reference";
    const claimantBinding = "current-session";
    const goal = await store.create({
      authorizationBinding,
      objective: "Use the tools needed for this work",
      steps: [
        {
          id: "work",
          description: "Continue the work",
          mode: "successful_call",
          allowedToolNames: ["legacy__suggestion"],
        },
      ],
    });
    const claim = await store.claimNext({ authorizationBinding, claimantBinding, goalId: goal.id });
    await store.beginExecution({
      authorizationBinding,
      claimantBinding,
      goalId: goal.id,
      stepId: "work",
      claimToken: claim?.claimToken ?? "",
      role: "work",
      operationId: "current-native-operation",
      toolName: "current__native_tool",
      targetIdentity: "native\0current",
      resourceDigest: sha("current-resource"),
      stateEffect: "read",
      modelEffect: "none",
    });
    const before = await store.get(authorizationBinding, goal.id);
    clearDirectGoalProcessCore(snapshotPath);
    const reopened = await DirectGoalStore.open({ snapshotPath });
    expect(await reopened.get(authorizationBinding, goal.id)).toEqual(before);
  });

  it("rejects resource-mismatched readback", async () => {
    const store = DirectGoalStore.inMemory();
    const authorizationBinding = "issuer\0owner\0client\0resource";
    const claimantBinding = "session:one";

    const goal = await store.create({
      authorizationBinding,
      idempotencyKey: "goal-create-0000000000000004",
      objective: "Use direct tools.",
      steps: [
        {
          id: "direct",
          description: "Mutate and read back.",
          mode: "mutation_and_readback",
        },
      ],
    });
    const claim = await store.claimNext({ authorizationBinding, claimantBinding, goalId: goal.id });
    await execute(store, {
      authorizationBinding,
      claimantBinding,
      goalId: goal.id,
      stepId: "direct",
      claimToken: claim?.claimToken ?? "",
      role: "work",
      operationId: "work-operation-0002",
      toolName: "codex__app_server__fs_writeFile",
      targetIdentity: "app_server\0fs/writeFile",
      resourceDigest: sha("resource-a"),
      resultDigest: sha("result"),
      stateEffect: "mutate",
      modelEffect: "none",
      outcome: "succeeded",
    });
    await expect(
      execute(store, {
        authorizationBinding,
        claimantBinding,
        goalId: goal.id,
        stepId: "direct",
        claimToken: claim?.claimToken ?? "",
        role: "readback",
        provesOperationId: "work-operation-0002",
        operationId: "read-operation-0002",
        toolName: "codex__app_server__fs_readFile",
        targetIdentity: "app_server\0fs/readFile",
        resourceDigest: sha("resource-b"),
        resultDigest: sha("result"),
        stateEffect: "read",
        modelEffect: "none",
        outcome: "succeeded",
      }),
    ).rejects.toThrow("DIRECT_GOAL_READBACK_RESOURCE_MISMATCH");
  });

  it.each(["model", "unknown"] as const)(
    "persists native work with %s model effect while requiring actual resource readback",
    async (modelEffect) => {
      const snapshotPath = join(await temporaryRoot(), "native-model-goal.json");
      let store = await DirectGoalStore.open({ snapshotPath });
      const authorizationBinding = "issuer\0owner\0client\0native-model-work";
      const claimantBinding = "session:native-work";
      const goal = await store.create({
        authorizationBinding,
        idempotencyKey: "native-model-goal-0001",
        objective: "Generate an image and verify the saved artifact.",
        steps: [{ id: "image", description: "Generate image", mode: "mutation_and_readback" }],
      });
      const claim = await store.claimNext({
        authorizationBinding,
        claimantBinding,
        goalId: goal.id,
      });
      const nativeWork = {
        authorizationBinding,
        claimantBinding,
        toolName: "codex__image_gen__imagegen",
        resourceDigest: sha("image-artifact"),
        stateEffect: "mutate" as const,
        modelEffect,
      };
      const context = {
        goalId: goal.id,
        stepId: "image",
        role: "work" as const,
        claimTokenDigest: sha(claim?.claimToken ?? ""),
      };
      const operation = {
        ...nativeWork,
        goalId: goal.id,
        stepId: "image",
        role: "work" as const,
        claimTokenDigest: context?.claimTokenDigest ?? "",
        operationId: "native-image-operation-0001",
        targetIdentity: "image_gen\0imagegen",
      };
      await store.beginExecution(operation);
      await store.markExecutionDispatched(operation);
      clearDirectGoalProcessCore(snapshotPath);
      store = await DirectGoalStore.open({ snapshotPath });
      expect((await store.get(authorizationBinding))?.steps[0]?.reservation).toMatchObject({
        state: "dispatched",
        modelEffect,
      });
      expect(
        await store.resolvePendingExecution({ ...nativeWork, operationId: operation.operationId }),
      ).toEqual(context);
      await expect(store.beginExecution({ ...operation, modelEffect: "none" })).rejects.toThrow(
        "DIRECT_GOAL_OPERATION_ID_CONFLICT",
      );
      await store.finalizeExecution({
        ...operation,
        resultDigest: sha("native image creation receipt"),
        outcome: "succeeded",
      });
      const readback = {
        ...operation,
        role: "readback" as const,
        operationId: "native-image-readback-0001",
        provesOperationId: operation.operationId,
        toolName: "codex__app_server__fs_readFile",
        targetIdentity: "app_server\0fs/readFile",
        stateEffect: "read" as const,
      };
      await expect(store.resolvePendingExecution(readback)).resolves.toBeUndefined();
      await expect(store.beginExecution(readback)).rejects.toThrow(
        "DIRECT_GOAL_READBACK_REQUIRES_NON_MODEL_EVIDENCE",
      );
      await execute(store, {
        ...readback,
        modelEffect: "none",
        resultDigest: sha("actual saved image bytes"),
        outcome: "succeeded",
      });
      const completed = await store.updateStatus({
        authorizationBinding,
        goalId: goal.id,
        status: "complete",
      });
      expect(completed.state).toBe("completed");
      clearDirectGoalProcessCore(snapshotPath);
      expect(
        await (await DirectGoalStore.open({ snapshotPath })).get(authorizationBinding),
      ).toEqual(completed);
    },
  );

  it("allocates separate native records without selecting or restricting reference claims", async () => {
    const store = DirectGoalStore.inMemory();
    const authorizationBinding = "issuer\0owner\0client\0server-binding";
    const claimantBinding = "work-session:exact";
    const goal = await store.create({
      authorizationBinding,
      idempotencyKey: "goal-server-bound-claim-0001",
      objective: "Bind one exact server-side work session.",
      steps: [
        {
          id: "read",
          description: "Read with the exact native tool.",
          mode: "successful_call",
          allowedToolNames: ["codex__app_server__fs_readFile"],
        },
      ],
    });
    await store.claimNext({ authorizationBinding, claimantBinding, goalId: goal.id });

    const input = {
      authorizationBinding,
      toolName: "codex__app_server__fs_readFile",
      resourceDigest: sha("C:\\work\\bound.txt"),
      stateEffect: "read" as const,
      modelEffect: "none" as const,
    };
    const other = await store.resolvePendingExecution({
      ...input,
      claimantBinding: "work-session:other",
    });
    const write = await store.resolvePendingExecution({
      ...input,
      claimantBinding,
      toolName: "codex__app_server__fs_writeFile",
      stateEffect: "mutate",
    });
    const bound = await store.resolvePendingExecution({ ...input, claimantBinding });
    for (const context of [other, write, bound]) {
      expect(context).toMatchObject({ goalId: goal.id, role: "work" });
      expect(context?.stepId).not.toBe("read");
    }
    expect(new Set([other?.stepId, write?.stepId, bound?.stepId]).size).toBe(3);
    expect(bound?.claimTokenDigest).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      store.claimNext({ authorizationBinding, claimantBinding, goalId: goal.id }),
    ).rejects.toThrow("DIRECT_GOAL_CLAIMANT_ALREADY_HAS_PENDING_STEP");
  });

  it("keeps restrictive reference steps unchanged while native records survive expiry and restart", async () => {
    const snapshotPath = join(await temporaryRoot(), "reference-native-records.json");
    let now = 10_000;
    const configuration = { snapshotPath, nowUnixMs: () => now };
    let store = await DirectGoalStore.open(configuration);
    const authorizationBinding = "issuer\0owner\0client\0reference-native-records";
    const claimantBinding = "native-session";
    const definition = {
      authorizationBinding,
      idempotencyKey: "reference-native-create-0001",
      objective: "Read and edit requested files with optional reference steps",
      steps: [
        {
          id: "reference",
          description: "Retain this exact progress note",
          mode: "mutation_and_readback" as const,
          allowedToolNames: ["legacy__unrelated_tool"],
        },
      ],
    };
    const goal = await store.create(definition);
    await store.claimNext({
      authorizationBinding,
      claimantBinding,
      goalId: goal.id,
      leaseMs: 1_000,
    });
    now += 1_001;
    const operations = [];
    for (const stateEffect of ["read", "mutate"] as const) {
      const native = {
        authorizationBinding,
        claimantBinding,
        toolName: `arbitrary__${stateEffect}`,
        targetIdentity: `native\0${stateEffect}`,
        resourceDigest: sha(`${stateEffect}-resource`),
        stateEffect,
        modelEffect: "none" as const,
      };
      const context = await store.resolvePendingExecution(native);
      if (!context) throw new Error("Missing automatic native execution record");
      expect(context.stepId).not.toBe("reference");
      operations.push({ ...native, ...context, operationId: `automatic-${stateEffect}` });
    }
    expect(operations[0]?.stepId).not.toBe(operations[1]?.stepId);
    expect((await store.get(authorizationBinding))?.steps[0]).toEqual(goal.steps[0]);
    const recorded = await store.get(authorizationBinding);
    expect(await store.create(definition)).toEqual(recorded);
    now += 5 * 60_000 + 1;
    clearDirectGoalProcessCore(snapshotPath);
    store = await DirectGoalStore.open(configuration);
    expect(await store.create(definition)).toEqual(recorded);
    for (const operation of operations) {
      await expect(
        store.beginExecution({ ...operation, claimantBinding: "different-session" }),
      ).rejects.toThrow("DIRECT_GOAL_CLAIM_INVALID_OR_EXPIRED");
      const finalized = await execute(store, {
        ...operation,
        resultDigest: sha(`${operation.operationId}-result`),
        outcome: "succeeded",
      });
      expect(finalized.steps.find((step) => step.id === operation.stepId)).toMatchObject({
        state: "completed",
        receipts: [{ operationId: operation.operationId }],
      });
      expect(finalized.steps[0]).toEqual(goal.steps[0]);
    }
    const finalized = await store.get(authorizationBinding);
    clearDirectGoalProcessCore(snapshotPath);
    store = await DirectGoalStore.open(configuration);
    expect(await store.get(authorizationBinding)).toEqual(finalized);
    expect(await store.create(definition)).toEqual(finalized);
  });

  it("allows an expired claim to be acquired by another session", async () => {
    let now = 10_000;
    let nonce = 0;
    const store = DirectGoalStore.inMemory({
      nowUnixMs: () => now,
      randomUUID: () => "00000000-0000-4000-a000-000000000001",
      randomBytes: () => Buffer.alloc(32, ++nonce),
    });
    const authorizationBinding = "issuer\0owner\0client\0resource";
    const goal = await store.create({
      authorizationBinding,
      idempotencyKey: "goal-create-0000000000000005",
      objective: "Survive worker replacement.",
      steps: [
        {
          id: "step",
          description: "One direct read.",
          mode: "successful_call",
        },
      ],
    });
    const first = await store.claimNext({
      authorizationBinding,
      claimantBinding: "session:first",
      goalId: goal.id,
      leaseMs: 1_000,
    });
    expect(first).toBeDefined();
    now += 1_001;
    const second = await store.claimNext({
      authorizationBinding,
      claimantBinding: "session:second",
      goalId: goal.id,
      leaseMs: 1_000,
    });
    expect(second?.claimToken).not.toBe(first?.claimToken);
  });

  it("preserves caller-sized objectives, steps, bindings, identities, and leases", async () => {
    const store = DirectGoalStore.inMemory({ nowUnixMs: () => 1_000 });
    const authorizationBinding = [
      `issuer-${"i".repeat(2_100)}`,
      `owner-${"o".repeat(2_100)}`,
      `client-${"c".repeat(2_100)}`,
      `resource-${"r".repeat(2_100)}`,
    ].join("\0");
    const claimantBinding = `session:${"s".repeat(8_300)}`;
    const objective = `objective:${"o".repeat(33_000)}`;
    const description = `description:${"d".repeat(8_300)}`;
    const steps = Array.from({ length: 257 }, (_, index) => ({
      id: `step-${String(index)}`,
      description: index === 0 ? description : `step ${String(index)}`,
      mode: "successful_call" as const,
    }));
    const goal = await store.create({
      authorizationBinding,
      idempotencyKey: "goal-unbounded-definition-0001",
      objective,
      steps,
    });

    expect(goal.objective).toBe(objective);
    expect(goal.steps).toHaveLength(257);
    expect(goal.steps[0]?.description).toBe(description);
    const claim = await store.claimNext({
      authorizationBinding,
      claimantBinding,
      goalId: goal.id,
      leaseMs: 1_800_001,
    });
    expect(claim?.claimExpiresAtUnixMs).toBe(1_801_001);

    const targetIdentity = `native-target\0${"t".repeat(8_300)}`;
    const completed = await execute(store, {
      authorizationBinding,
      claimantBinding,
      goalId: goal.id,
      stepId: "step-0",
      claimToken: claim?.claimToken ?? "",
      role: "work",
      operationId: "unbounded-operation-0001",
      toolName: "codex__app_server__fs_readFile",
      targetIdentity,
      resourceDigest: sha("large-resource"),
      resultDigest: sha("large-result"),
      stateEffect: "read",
      modelEffect: "none",
      outcome: "succeeded",
    });
    expect(completed.steps[0]?.receipts[0]?.targetIdentity).toBe(targetIdentity);
  });

  it("keeps more than 4096 operation bindings without silent eviction", async () => {
    const store = DirectGoalStore.inMemory({ nowUnixMs: () => 1_000 });
    const authorizationBinding = "issuer\0owner\0client\0unbounded-bindings";
    const claimantBinding = "session:unbounded-bindings";
    const goal = await store.create({
      authorizationBinding,
      idempotencyKey: "goal-unbounded-bindings-0001",
      objective: "Keep every immutable operation binding.",
      steps: [{ id: "read", description: "Eventually read.", mode: "successful_call" }],
    });
    const claim = await store.claimNext({ authorizationBinding, claimantBinding, goalId: goal.id });

    for (let index = 0; index < 4_097; index += 1) {
      const reservation = {
        authorizationBinding,
        claimantBinding,
        goalId: goal.id,
        stepId: "read",
        claimToken: claim?.claimToken ?? "",
        role: "work" as const,
        operationId: `failed-operation-${String(index).padStart(4, "0")}`,
        toolName: "codex__app_server__fs_readFile",
        targetIdentity: "app_server\0fs/readFile",
        resourceDigest: sha(`resource-${String(index)}`),
        stateEffect: "read" as const,
        modelEffect: "none" as const,
      };
      await store.beginExecution(reservation);
      await store.markExecutionDispatched(reservation);
      await store.finalizeExecution({
        ...reservation,
        resultDigest: sha(`result-${String(index)}`),
        outcome: "tool_error",
      });
    }

    await expect(
      store.beginExecution({
        authorizationBinding,
        claimantBinding,
        goalId: goal.id,
        stepId: "read",
        claimToken: claim?.claimToken ?? "",
        role: "work",
        operationId: "failed-operation-0000",
        toolName: "codex__app_server__fs_readFile",
        targetIdentity: "app_server\0fs/readFile",
        resourceDigest: sha("resource-0"),
        stateEffect: "read",
        modelEffect: "none",
      }),
    ).resolves.toMatchObject({ disposition: "created" });
  }, 60_000);

  it("keeps more than 4096 active conversation goals without eviction", async () => {
    const store = DirectGoalStore.inMemory({ nowUnixMs: () => 1_000 });
    const authorizationBinding = "issuer\0owner\0client\0unbounded-goals";
    let firstGoalId = "";
    for (let index = 0; index < 4_097; index += 1) {
      const goal = await store.create({
        authorizationBinding: `${authorizationBinding}-${index}`,
        idempotencyKey: `goal-unbounded-${String(index).padStart(8, "0")}`,
        objective: `Goal ${String(index)}`,
        steps: [{ id: "step", description: "Remain active.", mode: "successful_call" }],
      });
      if (index === 0) firstGoalId = goal.id;
    }
    await expect(store.get(`${authorizationBinding}-0`, firstGoalId)).resolves.toMatchObject({
      objective: "Goal 0",
      state: "active",
    });
  }, 60_000);

  it("keeps a durable reservation authoritative after lease expiry and rejects unrelated replay", async () => {
    let now = 1_000;
    const store = DirectGoalStore.inMemory({ nowUnixMs: () => now });
    const authorizationBinding = "issuer\0owner\0client\0reservation";
    const claimantBinding = "session:reservation-owner";
    const goal = await store.create({
      authorizationBinding,
      idempotencyKey: "goal-reservation-identity-0001",
      objective: "Bind exactly one native operation.",
      steps: [{ id: "read", description: "Read directly.", mode: "successful_call" }],
    });
    const claim = await store.claimNext({
      authorizationBinding,
      claimantBinding,
      goalId: goal.id,
      leaseMs: 50,
    });
    const reservation = {
      authorizationBinding,
      claimantBinding,
      goalId: goal.id,
      stepId: "read",
      claimToken: claim?.claimToken ?? "",
      role: "work" as const,
      operationId: "native-operation-reserved-0001",
      toolName: "codex__app_server__fs_readFile",
      targetIdentity: "app_server\0fs/readFile",
      resourceDigest: sha("file-a"),
      stateEffect: "read" as const,
      modelEffect: "none" as const,
    };

    await expect(store.beginExecution(reservation)).resolves.toMatchObject({
      disposition: "created",
      state: "prepared",
    });
    await expect(store.beginExecution(reservation)).resolves.toMatchObject({
      disposition: "joined",
      state: "prepared",
    });
    expect(await store.resolvePendingExecution(reservation)).toBeUndefined();
    await expect(
      store.beginExecution({ ...reservation, resourceDigest: sha("unrelated-file") }),
    ).rejects.toThrow("DIRECT_GOAL_OPERATION_ID_CONFLICT");
    now += 51;
    await expect(
      store.claimNext({
        authorizationBinding,
        claimantBinding: "session:thief",
        goalId: goal.id,
      }),
    ).resolves.toBeUndefined();
    await store.markExecutionDispatched(reservation);
    expect(await store.resolvePendingExecution(reservation)).toMatchObject({
      goalId: goal.id,
      stepId: "read",
      role: "work",
      claimTokenDigest: sha(claim?.claimToken ?? ""),
    });
    for (const mismatch of [
      { authorizationBinding: "issuer\0different-owner\0client\0conversation" },
      { claimantBinding: "session:thief" },
      { resourceDigest: sha("unrelated-file") },
      { toolName: "different-tool" },
      { operationId: "different-operation" },
      { stateEffect: "mutate" as const },
      { modelEffect: "model" as const },
    ]) {
      expect(await store.resolvePendingExecution({ ...reservation, ...mismatch })).toBeUndefined();
    }
    await expect(
      store.finalizeExecution({
        ...reservation,
        resultDigest: sha("result-after-lease"),
        outcome: "succeeded",
      }),
    ).resolves.toMatchObject({ steps: [{ state: "completed" }] });
    expect(await store.resolvePendingExecution(reservation)).toBeUndefined();
  });

  it("recovers a dispatched reservation from disk without persisting claim secrets", async () => {
    const root = await temporaryRoot();
    const snapshotPath = join(root, "reservation-recovery.json");
    const authorizationBinding = "issuer\0owner\0client\0durable-reservation";
    const claimantBinding = "session:durable";
    const first = await DirectGoalStore.open({ snapshotPath });
    const goal = await first.create({
      authorizationBinding,
      idempotencyKey: "goal-durable-reservation-0001",
      objective: "Recover exact execution after restart.",
      steps: [{ id: "inspect", description: "Inspect once.", mode: "successful_call" }],
    });
    const claim = await first.claimNext({ authorizationBinding, claimantBinding, goalId: goal.id });
    const reservation = {
      authorizationBinding,
      claimantBinding,
      goalId: goal.id,
      stepId: "inspect",
      claimToken: claim?.claimToken ?? "",
      role: "work" as const,
      operationId: "durable-native-operation-0001",
      toolName: "codex__app_server__fs_readFile",
      targetIdentity: "app_server\0fs/readFile",
      resourceDigest: sha("durable-resource"),
      stateEffect: "read" as const,
      modelEffect: "none" as const,
    };
    await first.beginExecution(reservation);
    await first.markExecutionDispatched(reservation);
    const persisted = await readFile(snapshotPath, "utf8");
    expect(persisted).not.toContain(reservation.claimToken);
    clearDirectGoalProcessCore(snapshotPath);

    const recovered = await DirectGoalStore.open({ snapshotPath });
    await expect(recovered.beginExecution(reservation)).resolves.toMatchObject({
      disposition: "recovery_required",
      state: "dispatched",
    });
    await recovered.markExecutionOutcomeUnknown(reservation);
    clearDirectGoalProcessCore(snapshotPath);
    const recoveredAgain = await DirectGoalStore.open({ snapshotPath });
    await expect(recoveredAgain.beginExecution(reservation)).resolves.toMatchObject({
      disposition: "recovery_required",
      state: "outcome_unknown",
    });
    await expect(
      recoveredAgain.finalizeExecution({
        ...reservation,
        resultDigest: sha("joined-replay-result"),
        outcome: "succeeded",
      }),
    ).resolves.toMatchObject({ steps: [{ state: "completed" }] });
  });

  it("only aborts prepared operations and releases expired claims after explicit abort", async () => {
    let now = 500;
    const store = DirectGoalStore.inMemory({ nowUnixMs: () => now });
    const authorizationBinding = "issuer\0owner\0client\0abort";
    const claimantBinding = "session:abort";
    const goal = await store.create({
      authorizationBinding,
      idempotencyKey: "goal-pre-dispatch-abort-0001",
      objective: "Abort before native dispatch.",
      steps: [{ id: "read", description: "Read.", mode: "successful_call" }],
    });
    const claim = await store.claimNext({
      authorizationBinding,
      claimantBinding,
      goalId: goal.id,
      leaseMs: 5,
    });
    const reservation = {
      authorizationBinding,
      claimantBinding,
      goalId: goal.id,
      stepId: "read",
      claimToken: claim?.claimToken ?? "",
      role: "work" as const,
      operationId: "abort-operation-0001",
      toolName: "codex__app_server__fs_readFile",
      targetIdentity: "app_server\0fs/readFile",
      resourceDigest: sha("abort-resource"),
      stateEffect: "read" as const,
      modelEffect: "none" as const,
    };
    await store.beginExecution(reservation);
    now += 6;
    await store.abortBeforeDispatch(reservation);
    await expect(
      store.claimNext({
        authorizationBinding,
        claimantBinding: "session:replacement",
        goalId: goal.id,
      }),
    ).resolves.toBeDefined();
  });

  it("rejects a checksummed snapshot whose nested goal structure is not exact", async () => {
    const root = await temporaryRoot();
    const snapshotPath = join(root, "strict-snapshot.json");
    const store = await DirectGoalStore.open({ snapshotPath });
    await store.create({
      authorizationBinding: "issuer\0owner\0client\0strict-snapshot",
      idempotencyKey: "goal-strict-snapshot-000001",
      objective: "Reject structurally invalid durable state.",
      steps: [{ id: "read", description: "Read.", mode: "successful_call" }],
    });
    const parsed = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      checksum: string;
      goals: Array<{ steps: Array<Record<string, unknown>> }>;
      [key: string]: unknown;
    };
    (parsed.goals[0]?.steps[0] as Record<string, unknown>).unexpected = true;
    const { checksum: _checksum, ...payload } = parsed;
    parsed.checksum = sha(canonicalJson(payload));
    await writeFile(snapshotPath, `${canonicalJson(parsed)}\n`, "utf8");
    clearDirectGoalProcessCore(snapshotPath);
    await expect(DirectGoalStore.open({ snapshotPath })).rejects.toThrow(
      "goal.step contains missing or unknown fields",
    );
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omnicodex-direct-goal-"));
  roots.push(root);
  return root;
}

async function createBoundManagementGoal(
  store: DirectGoalStore,
  authorizationBinding: string,
  conversationUrl: string,
) {
  const goal = await store.create({
    authorizationBinding,
    objective: "Manage this conversation Goal",
  });
  await store.observeConversation({
    conversationUrl,
    goals: [
      {
        messageId: `goal-${goal.id}`,
        toolName: "omnicodex__goal_create",
        goalId: goal.id,
        state: goal.state,
        revision: goal.revision,
        createdAtUnixMs: goal.createdAtUnixMs,
      },
    ],
  });
  return goal;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clearDirectGoalProcessCore(snapshotPath: string): void {
  const symbol = Symbol.for("@heelee912/omnicodex/direct-goal-cores/v2");
  const registry = (globalThis as unknown as Record<symbol, Map<string, unknown> | undefined>)[
    symbol
  ];
  const key = process.platform === "win32" ? snapshotPath.toLocaleLowerCase("en-US") : snapshotPath;
  registry?.delete(key);
}

async function execute(store: DirectGoalStore, input: DirectGoalExecutionFinalizeInput) {
  const { resultDigest: _resultDigest, outcome: _outcome, ...reservation } = input;
  await store.beginExecution(reservation);
  await store.markExecutionDispatched(reservation);
  return store.finalizeExecution(input);
}
