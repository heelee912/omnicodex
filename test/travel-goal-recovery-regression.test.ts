import { afterEach, expect, it, vi } from "vitest";
import type { ChromeGoalContinuationTarget } from "../src/application/chrome-goal-continuation.js";
import { GoalContinuationController } from "../src/application/goal-continuation-controller.js";
import { DirectGoalStore } from "../src/infrastructure/mcp/direct-goal-store.js";

const controllers: GoalContinuationController[] = [];
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.stop()));
  vi.useRealTimers();
});

it("preserves send-side rejection backoff across successful read-only inspections", async () => {
  vi.useFakeTimers();
  const store = DirectGoalStore.inMemory();
  const goal = await store.create({
    authorizationBinding: "test-issuer\0test-owner\0test-client\0test-conversation",
    objective: "Continue requested work after a proven unsent rate limit",
    steps: [{ id: "work", description: "Perform requested work", mode: "successful_call" }],
  });
  const sendTimes: number[] = [];
  const operate = vi.fn(async (target: ChromeGoalContinuationTarget) => {
    if (target.operation === "inspect") return { outcome: "ready" };
    sendTimes.push(Date.now());
    return { outcome: "rate_limited", error: "typed pre-dispatch account cooldown" };
  });
  const controller = new GoalContinuationController(store, operate, async () => {});
  controllers.push(controller);
  await controller.observe([
    {
      conversationUrl: "https://chatgpt.com/c/11111111-2222-4333-8444-555555555555",
      goals: [
        {
          messageId: "observed-goal-result",
          toolName: "omnicodex__goal_create",
          goalId: goal.id,
          state: goal.state,
          revision: goal.revision,
          createdAtUnixMs: goal.createdAtUnixMs,
        },
      ],
      current: {
        id: "verified-final",
        authorRole: "assistant",
        status: "finished_successfully",
        endTurn: true,
        channel: "final",
      },
    },
  ]);
  await vi.advanceTimersByTimeAsync(0);
  expect(sendTimes).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(sendTimes).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(sendTimes).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(sendTimes).toHaveLength(3);
  expect(sendTimes.slice(1).map((at, i) => at - (sendTimes[i] as number))).toEqual([
    30_000, 60_000,
  ]);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(sendTimes).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(sendTimes).toHaveLength(4);
  expect((sendTimes[3] as number) - (sendTimes[2] as number)).toBe(120_000);
  expect((await store.pendingContinuations())[0]?.draft.state).toBe("ready");
});

import { GOAL_CONTINUATION_PROMPT } from "../src/application/chrome-goal-continuation.js";
import { continueDesktopChatGoal } from "../src/infrastructure/windows/desktop-chat-goal-continuation.js";

const chatId = "11111111-2222-4333-8444-555555555555";
const staleTarget = {
  goalId: "goal",
  conversationUrl: `https://chatgpt.com/c/${chatId}`,
  accountSourceId: "chatgpt:account:user",
  operation: "inspect" as const,
  draft: {
    token: "old-attempt",
    afterMessageId: "old-final",
    state: "dispatching" as const,
    transport: "desktop" as const,
  },
};
function advancedBranch(
  prompt = "Continue the work and repair the stalled continuation",
  status = "idle",
) {
  return {
    conversation_id: chatId,
    current_node: "new-final-node",
    status,
    mapping: {
      "old-final-node": {
        parent: null,
        message: {
          id: "old-final",
          author: { role: "assistant" },
          status: "finished_successfully",
          end_turn: true,
          channel: "final",
          content: { content_type: "text", parts: ["Previous partial work"] },
        },
      },
      "new-input-node": {
        parent: "old-final-node",
        message: {
          id: "new-input",
          author: { role: "user" },
          content: { content_type: "text", parts: [prompt] },
        },
      },
      "new-final-node": {
        parent: "new-input-node",
        message: {
          id: "new-final",
          author: { role: "assistant" },
          status: "finished_successfully",
          end_turn: true,
          channel: "final",
          content: { content_type: "text", parts: ["The repair work has a verified result"] },
        },
      },
    },
  };
}

it("retires an obsolete dispatch only after a different input has a completed reply on the same idle branch", async () => {
  const callRequiredNative = vi.fn();
  const readConversation = vi.fn().mockResolvedValue(advancedBranch());
  expect(
    await continueDesktopChatGoal(
      { callRequiredNative },
      staleTarget,
      undefined,
      undefined,
      async () => true,
      undefined,
      undefined,
      undefined,
      readConversation,
    ),
  ).toEqual({ outcome: "superseded" });
  expect(readConversation).toHaveBeenCalledExactlyOnceWith(chatId, undefined);
  expect(callRequiredNative).not.toHaveBeenCalled();
});

it.each([
  "generating",
  "identical-prompt",
  "missing-user-id",
  "empty-input",
  "incomplete-turn",
  "no-new-final",
])("does not release an uncertain dispatch with %s evidence", async (scenario) => {
  const data = advancedBranch(
    scenario === "identical-prompt"
      ? GOAL_CONTINUATION_PROMPT
      : scenario === "empty-input"
        ? ""
        : "New requested work",
    scenario === "generating" ? "active" : "idle",
  );
  if (scenario === "missing-user-id")
    delete (data.mapping["new-input-node"].message as { id?: string }).id;
  if (scenario === "incomplete-turn") {
    data.mapping["new-final-node"].message.status = "in_progress";
    data.mapping["new-final-node"].message.end_turn = false;
  }
  if (scenario === "no-new-final") data.current_node = "new-input-node";
  const callRequiredNative = vi.fn();
  const readConversation = vi.fn().mockResolvedValue(data);
  const result = continueDesktopChatGoal(
    { callRequiredNative },
    staleTarget,
    undefined,
    undefined,
    async () => true,
    undefined,
    undefined,
    undefined,
    readConversation,
  );
  if (scenario === "missing-user-id")
    await expect(result).rejects.toThrow("DIRECT_GOAL_DESKTOP_BRANCH_INVALID");
  else await expect(result).resolves.toEqual({ outcome: "send_unconfirmed" });
  expect(readConversation).toHaveBeenCalledExactlyOnceWith(chatId, undefined);
  expect(callRequiredNative).not.toHaveBeenCalled();
});

it("promotes a newer verified final exactly once without replaying or acknowledging the stale send", async () => {
  const store = DirectGoalStore.inMemory();
  const owner = "recovery-issuer\0owner\0client\0conversation";
  const goal = await store.create({
    authorizationBinding: owner,
    objective: "Continue the unfinished task",
    steps: [{ id: "work", description: "Finish real work", mode: "successful_call" }],
  });
  const observation = {
    conversationUrl: staleTarget.conversationUrl,
    source: { kind: "desktop" as const, accountSourceId: staleTarget.accountSourceId },
    goals: [
      {
        messageId: "binding-result",
        toolName: "omnicodex__goal_create",
        goalId: goal.id,
        state: goal.state,
        revision: goal.revision,
        createdAtUnixMs: goal.createdAtUnixMs,
      },
    ],
    current: {
      id: "old-final",
      authorRole: "assistant" as const,
      status: "finished_successfully",
      endTurn: true,
      channel: "final",
    },
  };
  await store.observeConversation(observation);
  const ready = (await store.pendingContinuations())[0];
  if (!ready) throw new Error("Expected pending test draft");
  expect(await store.transitionContinuation(ready, "dispatching")).toBe(true);
  const old = (await store.pendingContinuations())[0];
  if (!old) throw new Error("Expected test dispatch");
  await store.observeBoundDesktopFinal({
    ...observation,
    current: {
      ...observation.current,
      id: "new-final",
      ancestorMessageIds: ["new-input", "old-final"],
    },
  });
  expect((await store.pendingContinuations())[0]?.draft.token).toBe(old.draft.token);
  const callRequiredNative = vi.fn();
  const readConversation = vi.fn().mockResolvedValue(advancedBranch());
  const result = await continueDesktopChatGoal(
    { callRequiredNative },
    { ...old, operation: "inspect" },
    undefined,
    undefined,
    async () => true,
    undefined,
    undefined,
    undefined,
    readConversation,
  );
  expect(result.outcome).toBe("superseded");
  expect(await store.transitionContinuation(old, "cancelled")).toBe(true);
  const next = (await store.pendingContinuations())[0];
  expect(next?.draft.afterMessageId).toBe("new-final");
  expect(next?.draft.token).not.toBe(old.draft.token);
  expect(next?.draft.state).toBe("ready");
  expect(next?.draft.nativeReceipt).toBeUndefined();
  expect(await store.transitionContinuation(old, "cancelled")).toBe(false);
  expect(readConversation).toHaveBeenCalledExactlyOnceWith(chatId, undefined);
  expect(callRequiredNative).not.toHaveBeenCalled();
  expect((await store.get(owner, goal.id))?.state).toBe("active");
});
