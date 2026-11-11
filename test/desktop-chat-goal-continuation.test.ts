import { expect, it, vi } from "vitest";
import { ChatAccountRateLimitError } from "../src/application/chat-account-request-coordinator.js";
import {
  GOAL_CONTINUATION_PROMPT,
  goalContinuationPrompt,
} from "../src/application/chrome-goal-continuation.js";
import {
  continueDesktopChatGoal,
  desktopGoalContinuationPrompt,
  inspectDesktopChatGoalReadback,
  projectDesktopChatGoalReadback,
} from "../src/infrastructure/windows/desktop-chat-goal-continuation.js";

const id = "6a9c5e2f-eb48-83e8-a6c7-cc34e5cb3a17";
const anchor = "finished-message";
type Message = Record<string, unknown>;
const target = {
  goalId: "22222222-2222-4222-8222-222222222222",
  conversationUrl: `https://chatgpt.com/c/${id}`,
  accountSourceId: "chatgpt:account:user",
  draft: {
    token: "draft",
    afterMessageId: anchor,
    state: "dispatching" as const,
    transport: "desktop" as const,
  },
  operation: "send" as const,
};
const final = (messageId: string, extra = {}): Message => ({
  id: messageId,
  author: { role: "assistant" },
  status: "finished_successfully",
  channel: "final",
  end_turn: true,
  ...extra,
});
const input = (text: string): Message => ({
  id: "next-input",
  author: { role: "user" },
  content: { parts: [text] },
});
function transcript(messages: Message[] = [final(anchor)]) {
  const mapping: Record<string, { parent: string | null; message: Message | null }> = {};
  for (const [index, message] of messages.entries())
    mapping[message.id as string] = {
      parent: (messages[index - 1]?.id as string) ?? null,
      message,
    };
  return { conversation_id: id, current_node: messages.at(-1)?.id as string, mapping };
}
function run(
  options: {
    raw?: unknown;
    read?: (id: string, signal?: AbortSignal) => Promise<unknown>;
    send?: Parameters<typeof continueDesktopChatGoal>[0]["callRequiredNative"];
    operation?: "send" | "inspect";
    signal?: AbortSignal;
    verify?: (account: string, conversation: string, signal?: AbortSignal) => Promise<boolean>;
    record?: Parameters<typeof continueDesktopChatGoal>[5];
    resolve?: () => Promise<string>;
    canDispatch?: () => Promise<boolean>;
  } = {},
) {
  const send = options.send ?? vi.fn().mockResolvedValue({ threadId: id });
  const read = options.read ?? vi.fn().mockResolvedValue(options.raw ?? transcript());
  return {
    send,
    read,
    result: continueDesktopChatGoal(
      { callRequiredNative: send },
      { ...target, operation: options.operation ?? "send" },
      "native-context",
      options.signal,
      options.verify ?? (async () => true),
      options.record,
      options.resolve,
      options.canDispatch,
      read,
    ),
  };
}
const inspect = (raw: unknown) =>
  inspectDesktopChatGoalReadback(projectDesktopChatGoalReadback(raw, id), id, anchor);

it("reads the exact Chat and sends only through the unchanged host sender", async () => {
  const record = vi.fn(async () => true);
  const f = run({ record, resolve: async () => "asdk_app_current" });
  expect(await f.result).toEqual({ outcome: "sent" });
  expect(f.read).toHaveBeenCalledWith(id, undefined);
  expect(f.send).toHaveBeenCalledExactlyOnceWith(
    "codex_app__send_message_to_thread",
    {
      threadId: id,
      prompt: desktopGoalContinuationPrompt("asdk_app_current", target.goalId),
    },
    { callingThreadId: "native-context", operationId: "goal-continuation:draft" },
  );
  expect(record).toHaveBeenCalledWith({
    kind: "native_host_acknowledged",
    operationId: "goal-continuation:draft",
    threadId: id,
    accountSourceId: target.accountSourceId,
  });
});
it("never queries the Codex namespace without an exact reader", async () => {
  const send = vi.fn();
  expect(
    await continueDesktopChatGoal(
      { callRequiredNative: send },
      target,
      undefined,
      undefined,
      async () => true,
    ),
  ).toMatchObject({
    outcome: "send_not_started",
    error: expect.stringContaining("EXACT_READER_REQUIRED"),
  });
  expect(send).not.toHaveBeenCalled();
});
it("preserves the agreed wording and rejects an invalid app identity", () => {
  expect(
    desktopGoalContinuationPrompt("asdk_app_current", target.goalId)
      .replace(/^\[(.*)\]\(app:\/\/[^)]+\)/, "$1")
      .replaceAll("\\]", "]"),
  ).toBe(goalContinuationPrompt(target.goalId));
  expect(() => desktopGoalContinuationPrompt("invalid", target.goalId)).toThrow(
    "CONNECTOR_ID_INVALID",
  );
});
it("ignores sibling messages and follows parent edges across empty nodes", () => {
  const raw = transcript();
  raw.mapping.sibling = { parent: null, message: input("Stop") };
  const anchored = raw.mapping[anchor];
  if (!anchored) throw new Error("Missing fixture anchor");
  anchored.parent = "empty";
  raw.mapping.empty = { parent: "root", message: null };
  raw.mapping.root = { parent: null, message: null };
  expect(inspect(raw)).toBe("ready");
});
it.each(["cycle", "missing", "duplicate"])("rejects %s branch corruption", (kind) => {
  const raw = transcript([final("old"), final(anchor)]);
  const old = raw.mapping.old;
  if (!old?.message) throw new Error("Missing fixture old message");
  if (kind === "cycle") old.parent = anchor;
  if (kind === "missing") old.parent = "missing";
  if (kind === "duplicate") old.message.id = anchor;
  expect(() => inspect(raw)).toThrow("BRANCH_INVALID");
});
it("rejects a different conversation and an absent anchor", () => {
  expect(inspect({ ...transcript(), conversation_id: "another" })).toBe("conversation_changed");
  expect(inspect(transcript([final("another-final")]))).toBe("anchor_not_visible");
});
it.each([
  { status: "in_progress" },
  { channel: "analysis" },
  { channel: null },
  { end_turn: false },
])("does not promote non-final messages: %j", (extra) => {
  expect(inspect(transcript([final(anchor, extra)]))).not.toBe("ready");
});
it("keeps an active native conversation generating", () => {
  expect(inspect({ ...transcript(), status: { type: "active" } })).toBe("generating");
});
it("resolves a trailing preamble only to its same-turn final", () => {
  const raw = transcript([
    final(anchor, { metadata: { working_turn_id: "turn" } }),
    final("preamble", {
      channel: "analysis",
      metadata: { working_turn_id: "turn", is_thinking_preamble_message: true },
    }),
  ]);
  expect(inspect(raw)).toBe("ready");
  const preamble = raw.mapping.preamble?.message;
  if (!preamble) throw new Error("Missing fixture preamble");
  preamble.metadata = {
    working_turn_id: "other",
    is_thinking_preamble_message: true,
  };
  expect(inspect(raw)).toBe("superseded");
});
it.each([
  [GOAL_CONTINUATION_PROMPT, "send_unconfirmed"],
  [desktopGoalContinuationPrompt("asdk_app_current", target.goalId), "send_unconfirmed"],
  ["Revised objective", "superseded"],
])("keeps receipt uncertainty separate from completed input: %s", async (text, outcome) => {
  const f = run({
    operation: "inspect",
    raw: transcript([final(anchor), input(text), final("next-final")]),
  });
  expect(await f.result).toEqual({ outcome });
  expect(f.send).not.toHaveBeenCalled();
});
it("does not retire uncertainty while a newer input is generating", async () => {
  expect(
    await run({
      operation: "inspect",
      raw: transcript([final(anchor), input("Revised objective")]),
    }).result,
  ).toEqual({ outcome: "send_unconfirmed" });
});
it("retains long superseding input text without truncation", async () => {
  expect(
    await run({
      operation: "inspect",
      raw: transcript([
        final(anchor),
        input(`${"x".repeat(100000)}${GOAL_CONTINUATION_PROMPT}`),
        final("next-final"),
      ]),
    }).result,
  ).toEqual({ outcome: "superseded" });
});
it("releases failed pre-send reads but preserves an older dispatch", async () => {
  const read = vi.fn().mockRejectedValue(new Error("READ_CONNECTION_RESET"));
  const f = run({ read });
  expect(await f.result).toEqual({
    outcome: "send_not_started",
    error: "Error: READ_CONNECTION_RESET",
  });
  expect(f.send).not.toHaveBeenCalled();
  await expect(run({ read, operation: "inspect" }).result).rejects.toThrow("READ_CONNECTION_RESET");
});
it("preserves all native diagnostics and complete error cause", async () => {
  const raw = {
    isError: true,
    content: [
      { type: "text", text: "한도에 도달했습니다." },
      { type: "text", text: "request-id: original" },
    ],
  };
  expect(await run({ raw }).result).toMatchObject({
    outcome: "send_not_started",
    cause: raw,
    error: expect.stringContaining("한도에 도달했습니다.\nrequest-id: original"),
  });
});
it.each([
  { status: "systemError", error: { message: "Response failed" } },
  { error: "Native failure" },
])("reports actual conversation failure: %j", async (extra) => {
  const raw = { ...transcript(), ...extra };
  expect(await run({ raw }).result).toMatchObject({
    outcome: "send_not_started",
    cause: raw,
    error: expect.stringContaining("CONVERSATION_FAILED"),
  });
});
it("releases read cooldowns and only typed pre-dispatch sender cooldowns", async () => {
  expect(
    await run({ read: vi.fn().mockRejectedValue(new Error('{"detail":"Too many requests"}')) })
      .result,
  ).toMatchObject({ outcome: "rate_limited" });
  expect(
    await run({
      send: vi.fn().mockRejectedValue(new ChatAccountRateLimitError(Date.now() + 30000, undefined)),
    }).result,
  ).toMatchObject({ outcome: "rate_limited" });
  await expect(
    run({ send: vi.fn().mockRejectedValue(new Error("429 after native dispatch")) }).result,
  ).rejects.toThrow("429 after native dispatch");
});
it("retains uncertain native sends and never infers a receipt from text", async () => {
  await expect(
    run({ send: vi.fn().mockRejectedValue(new Error("SEND_CONNECTION_RESET")) }).result,
  ).rejects.toThrow("SEND_CONNECTION_RESET");
  const f = run();
  expect(await f.result).toEqual({ outcome: "send_unconfirmed" });
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.read).toHaveBeenCalledTimes(2);
});
it("revalidates account and durable dispatch after async selection", async () => {
  const changed = run({
    verify: vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false),
  });
  expect(await changed.result).toEqual({ outcome: "account_changed" });
  expect(changed.send).not.toHaveBeenCalled();
  const paused = run({ canDispatch: async () => false });
  expect(await paused.result).toEqual({ outcome: "send_not_started" });
  expect(paused.send).not.toHaveBeenCalled();
  expect(
    await run({
      resolve: async () => {
        throw new Error("CATALOG_CHANGED");
      },
    }).result,
  ).toEqual({ outcome: "send_not_started", error: "Error: CATALOG_CHANGED" });
});
it("keeps failed durable receipt persistence uncertain", async () => {
  expect(await run({ record: async () => false }).result).toEqual({ outcome: "send_unconfirmed" });
});
it("releases abort during the exact read before sender entry", async () => {
  const controller = new AbortController();
  const f = run({
    signal: controller.signal,
    read: async () => {
      controller.abort();
      controller.signal.throwIfAborted();
    },
  });
  expect(await f.result).toMatchObject({
    outcome: "send_not_started",
    error: expect.stringContaining("AbortError"),
  });
  expect(f.send).not.toHaveBeenCalled();
});
