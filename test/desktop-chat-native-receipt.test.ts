import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DirectGoalStore } from "../src/infrastructure/mcp/direct-goal-store.js";
import { continueDesktopChatGoal } from "../src/infrastructure/windows/desktop-chat-goal-continuation.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const conversationId = "6a9d8c74-a448-83e8-843e-41e6ac46f1bf";
const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
const accountSourceId = "chatgpt:account:user";
const owner = "issuer\0owner\0client\0conversation";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omnicodex-native-receipt-"));
  roots.push(root);
  const snapshotPath = join(root, "goals.json");
  const store = await DirectGoalStore.open({ snapshotPath });
  const goal = await store.create({
    authorizationBinding: owner,
    objective: "Continue app work",
    steps: [{ id: "work", description: "Complete the requested work", mode: "successful_call" }],
  });
  await store.observeConversation({
    conversationUrl,
    source: { kind: "desktop", accountSourceId },
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
      id: "final",
      authorRole: "assistant",
      status: "finished_successfully",
      endTurn: true,
      channel: "final",
    },
  });
  const ready = (await store.pendingContinuations())[0];
  if (!ready) throw new Error("Missing draft");
  await store.transitionContinuation(ready, "dispatching");
  const work = (await store.pendingContinuations())[0];
  if (!work) throw new Error("Missing dispatch");
  const readback = {
    conversation_id: conversationId,
    current_node: "final",
    mapping: {
      final: {
        parent: null,
        message: {
          id: "final",
          author: { role: "assistant" },
          status: "finished_successfully",
          channel: "final",
          end_turn: true,
        },
      },
    },
  };
  return { store, snapshotPath, goal, work, readback };
}

it("persists the exact native operation acknowledgement before returning sent and recovers it without another send", async () => {
  const f = await fixture();
  const callRequiredNative = vi.fn().mockResolvedValueOnce({ threadId: conversationId });
  const result = await continueDesktopChatGoal(
    { callRequiredNative },
    { ...f.work, operation: "send" },
    undefined,
    undefined,
    async () => true,
    (receipt) => f.store.recordNativeContinuationReceipt(f.work, receipt),
    undefined,
    undefined,
    async () => f.readback,
  );
  expect(result).toEqual({ outcome: "sent" });
  expect(callRequiredNative.mock.calls.map((call) => call[0])).toEqual([
    "codex_app__send_message_to_thread",
  ]);
  const receipt = {
    kind: "native_host_acknowledged",
    operationId: `goal-continuation:${f.work.draft.token}`,
    threadId: conversationId,
    accountSourceId,
  };
  expect((await f.store.get(owner, f.goal.id))?.continuation?.draft).toMatchObject({
    state: "dispatching",
    nativeReceipt: receipt,
  });
  (globalThis as unknown as Record<symbol, Map<string, unknown>>)[
    Symbol.for("@heelee912/omnicodex/direct-goal-cores/v2")
  ]?.clear();
  const reopened = await DirectGoalStore.open({ snapshotPath: f.snapshotPath });
  const pending = (await reopened.pendingContinuations())[0];
  if (!pending) throw new Error("Lost acknowledged dispatch");
  const noSend = vi.fn();
  expect(
    await continueDesktopChatGoal(
      { callRequiredNative: noSend },
      { ...pending, operation: "inspect" },
    ),
  ).toEqual({ outcome: "sent" });
  expect(noSend).not.toHaveBeenCalled();
  expect(await reopened.transitionContinuation(pending, "sent")).toBe(true);
});

it("rejects receipts for a different operation, account, or conversation", async () => {
  const f = await fixture();
  const receipt = {
    kind: "native_host_acknowledged" as const,
    operationId: `goal-continuation:${f.work.draft.token}`,
    threadId: conversationId,
    accountSourceId,
  };
  for (const replacement of [
    { operationId: "different-operation" },
    { threadId: "another-chat" },
    { accountSourceId: "chatgpt:other:user" },
  ])
    await expect(
      f.store.recordNativeContinuationReceipt(f.work, { ...receipt, ...replacement }),
    ).rejects.toThrow("DIRECT_GOAL_NATIVE_RECEIPT_INVALID");
  expect((await f.store.pendingContinuations())[0]?.draft.nativeReceipt).toBeUndefined();
});

it("keeps a lost native response or failed durable acknowledgement unconfirmed", async () => {
  const f = await fixture();
  const record = vi.fn(async () => false);
  const failed = vi.fn().mockRejectedValueOnce(new Error("native response lost"));
  await expect(
    continueDesktopChatGoal(
      { callRequiredNative: failed },
      { ...f.work, operation: "send" },
      undefined,
      undefined,
      async () => true,
      record,
      undefined,
      undefined,
      async () => f.readback,
    ),
  ).rejects.toThrow("native response lost");
  expect(record).not.toHaveBeenCalled();
  const succeeded = vi.fn().mockResolvedValueOnce({ threadId: conversationId });
  expect(
    await continueDesktopChatGoal(
      { callRequiredNative: succeeded },
      { ...f.work, operation: "send" },
      undefined,
      undefined,
      async () => true,
      record,
      undefined,
      undefined,
      async () => f.readback,
    ),
  ).toEqual({ outcome: "send_unconfirmed" });
  expect((await f.store.pendingContinuations())[0]?.draft.state).toBe("dispatching");
});

it("durably prepares the native message before dispatch and confirms its exact input while response is still pending", async () => {
  const f = await fixture();
  const message = { id: "native-uuid", author: { role: "user" }, content: { parts: ["Continue"] } };
  const prepared = {
    operationId: `goal-continuation:${f.work.draft.token}`,
    conversationUrl,
    accountSourceId,
    clientUserMessageId: message.id,
    prompt: "Continue",
    nativeMessages: { message, extraDeveloperInstructionMessages: [] },
  };
  let raw: unknown = f.readback;
  const dispatch = vi.fn(async (value) => {
    expect(value).toEqual(prepared);
    expect((await f.store.get(owner, f.goal.id))?.continuation?.draft?.nativeReceipt).toMatchObject(
      {
        dispatchState: "dispatching",
        clientUserMessageId: message.id,
        nativeMessages: prepared.nativeMessages,
      },
    );
    raw = {
      ...f.readback,
      current_node: message.id,
      mapping: { ...f.readback.mapping, [message.id]: { parent: "final", message } },
    };
    return { threadId: conversationId, clientUserMessageId: message.id, accepted: true };
  });
  const oldSend = vi.fn();
  expect(
    await continueDesktopChatGoal(
      { callRequiredNative: oldSend },
      { ...f.work, operation: "send" },
      undefined,
      undefined,
      async () => true,
      (receipt) => f.store.recordNativeContinuationReceipt(f.work, receipt),
      undefined,
      undefined,
      async () => raw,
      { prepare: async () => prepared, dispatch },
    ),
  ).toEqual({ outcome: "sent" });
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(oldSend).not.toHaveBeenCalled();
  const pending = (await f.store.pendingContinuations())[0];
  if (!pending) throw new Error("Missing pending");
  expect(
    await continueDesktopChatGoal(
      { callRequiredNative: oldSend },
      { ...pending, operation: "inspect" },
      undefined,
      undefined,
      async () => true,
      (receipt) => f.store.recordNativeContinuationReceipt(pending, receipt),
      undefined,
      undefined,
      async () => raw,
      { prepare: async () => prepared, dispatch },
    ),
  ).toEqual({ outcome: "sent" });
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it("recovers a stored prepared message after restart and never repeats an uncertain dispatch", async () => {
  const f = await fixture();
  const message = { id: "native-uuid", author: { role: "user" }, content: { parts: ["Continue"] } };
  const prepared = {
    operationId: `goal-continuation:${f.work.draft.token}`,
    conversationUrl,
    accountSourceId,
    clientUserMessageId: message.id,
    prompt: "Continue",
    nativeMessages: { message },
  };
  await f.store.recordNativeContinuationReceipt(f.work, {
    kind: "native_message_prepared",
    operationId: prepared.operationId,
    threadId: conversationId,
    accountSourceId,
    clientUserMessageId: message.id,
    nativeMessages: prepared.nativeMessages,
    prompt: prepared.prompt,
    dispatchState: "prepared",
  });
  const pending = (await f.store.pendingContinuations())[0];
  if (!pending) throw new Error("Missing pending");
  const sender = {
    prepare: vi.fn(async () => prepared),
    dispatch: vi.fn(async () => {
      throw new Error("reply lost");
    }),
  };
  await expect(
    continueDesktopChatGoal(
      { callRequiredNative: vi.fn() },
      { ...pending, operation: "inspect" },
      undefined,
      undefined,
      async () => true,
      (receipt) => f.store.recordNativeContinuationReceipt(pending, receipt),
      undefined,
      undefined,
      async () => f.readback,
      sender,
    ),
  ).rejects.toThrow("reply lost");
  const uncertain = (await f.store.pendingContinuations())[0];
  if (!uncertain) throw new Error("Missing uncertain");
  expect(
    await continueDesktopChatGoal(
      { callRequiredNative: vi.fn() },
      { ...uncertain, operation: "inspect" },
      undefined,
      undefined,
      async () => true,
      (receipt) => f.store.recordNativeContinuationReceipt(uncertain, receipt),
      undefined,
      undefined,
      async () => f.readback,
      sender,
    ),
  ).toEqual({ outcome: "send_unconfirmed" });
  expect(sender.prepare).not.toHaveBeenCalled();
  expect(sender.dispatch).toHaveBeenCalledTimes(1);
});

it("restores the same prepared payload when cancellation is proven before native dispatch", async () => {
  const f = await fixture();
  const message = { id: "native-uuid", author: { role: "user" }, content: { parts: ["Continue"] } };
  const prepared = {
    operationId: `goal-continuation:${f.work.draft.token}`,
    conversationUrl,
    accountSourceId,
    clientUserMessageId: message.id,
    prompt: "Continue",
    nativeMessages: { message },
  };
  const failure = Object.assign(new Error("cancelled before dispatch"), {
    nativeDispatchNotStarted: true,
  });
  await expect(
    continueDesktopChatGoal(
      { callRequiredNative: vi.fn() },
      { ...f.work, operation: "send" },
      undefined,
      undefined,
      async () => true,
      (receipt) => f.store.recordNativeContinuationReceipt(f.work, receipt),
      undefined,
      undefined,
      async () => f.readback,
      {
        prepare: async () => prepared,
        dispatch: async () => {
          throw failure;
        },
      },
    ),
  ).rejects.toBe(failure);
  expect((await f.store.pendingContinuations())[0]?.draft.nativeReceipt).toMatchObject({
    dispatchState: "prepared",
    nativeMessages: prepared.nativeMessages,
    clientUserMessageId: message.id,
  });
});
