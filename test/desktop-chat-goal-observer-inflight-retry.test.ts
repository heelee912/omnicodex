import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ChatAccountRateLimitError } from "../src/application/chat-account-request-coordinator.js";
import { DesktopChatGoalObserver } from "../src/application/desktop-chat-goal-observer.js";
import { DirectGoalStore } from "../src/infrastructure/mcp/direct-goal-store.js";
import type { DesktopChatCompletionVerification } from "../src/infrastructure/windows/desktop-chat-completion.js";
import type { DesktopChatObservedEvent } from "../src/infrastructure/windows/desktop-chat-event-source.js";

const roots: string[] = [];
const observers: DesktopChatGoalObserver[] = [];
const conversationUrl = "https://chatgpt.com/c/inflight-retry-test";
const accountSourceId = "chatgpt:account:user";
const final = (id = "final", parent = "goal-result") => ({
  id,
  author: { role: "assistant" },
  status: "finished_successfully",
  channel: "final",
  end_turn: true,
  metadata: { parent_id: parent },
});
const event = (messages: unknown[]): DesktopChatObservedEvent => ({
  source: {
    endpoint: "http://127.0.0.1:29341",
    processId: 1,
    startedAtIso: "2026-09-07T00:00:00Z",
  },
  targetId: "app",
  conversationUrl,
  notification: {
    type: "conversation-update",
    payload: { conversation_id: "inflight-retry-test", update_content: { messages } },
  },
});

afterEach(async () => {
  for (const observer of observers.splice(0)) await observer.stop();
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const root = await mkdtemp(join(tmpdir(), "observer-inflight-retry-"));
  roots.push(root);
  const path = join(root, "pending.json");
  const store = DirectGoalStore.inMemory();
  const goal = await store.create({
    authorizationBinding: "owner\0issuer\0account\0inflight-retry-test",
    objective: "test observer retry without dispatching anything",
  });
  let rejectRead!: (error: unknown) => void;
  const read = new Promise<DesktopChatCompletionVerification>((_resolve, reject) => {
    rejectRead = reject;
  });
  const options = {
    path,
    source: { ensureConnected: vi.fn(async () => false), stop: vi.fn(async () => {}) },
    store,
    verify: vi.fn(() => read),
    readback: vi.fn(
      async (): Promise<DesktopChatCompletionVerification> => ({ outcome: "awaiting_transcript" }),
    ),
    readScope: vi.fn(async () => ({ accountSourceId, connectorIds: ["asdk_app_installed"] })),
    observe: vi.fn(async () => {}),
    onConversationDeleted: vi.fn(async () => {}),
    report: vi.fn(async () => {}),
    readCooldown: vi.fn(async (): Promise<{ retryAtUnixMs: number } | undefined> => undefined),
  };
  const observer = new DesktopChatGoalObserver(options);
  observers.push(observer);
  await observer.start();
  await observer.accept(
    event([
      {
        id: "goal-result",
        author: { role: "tool", name: "api_tool.call_tool" },
        status: "finished_successfully",
        metadata: {
          invoked_resource: { resource_uri: "/asdk_app_installed/link_one/omnicodex__goal_create" },
        },
        content: { text: JSON.stringify(goal) },
      },
    ]),
  );
  await observer.accept(event([final()]));
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() =>
    expect(
      options.verify,
      JSON.stringify({ report: options.report.mock.calls, scope: options.readScope.mock.calls }),
    ).toHaveBeenCalledTimes(1),
  );
  return { observer, options, path, rejectRead };
}

async function persisted(path: string) {
  return JSON.parse(await readFile(path, "utf8")).entries[0];
}

const deletedMessage = JSON.stringify({
  detail: {
    message: "대화가 삭제되었습니다. 새 채팅을 시작하세요.",
    code: "conversation_deleted",
    can_retry: false,
    conversation_id: "inflight-retry-test",
  },
});
const deletedError = () =>
  Object.assign(new Error(deletedMessage), {
    code: "conversation_deleted",
    can_retry: false,
    accountSourceId,
    conversationUrl,
  });

it("retires exact deleted observation across restart and reactivates on a new final", async () => {
  const f = await fixture();
  f.rejectRead(deletedError());
  await vi.waitFor(async () => expect((await persisted(f.path)).pending).toBe(false));
  expect(f.options.report).toHaveBeenCalledWith("failed", `Error: ${deletedMessage}`);
  expect(f.options.onConversationDeleted).toHaveBeenCalledExactlyOnceWith(
    conversationUrl,
    accountSourceId,
  );
  expect((await persisted(f.path)).candidates).toEqual(["final"]);
  expect(f.options.observe).not.toHaveBeenCalled();
  await f.observer.stop();
  const restored = new DesktopChatGoalObserver(f.options);
  observers.push(restored);
  await restored.start();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f.options.verify).toHaveBeenCalledTimes(1);
  await restored.accept(event([final("next-final", "final")]));
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() => expect(f.options.readback).toHaveBeenCalledTimes(1));
  expect((await persisted(f.path)).pending).toBe(true);
});

it.each([
  { accountSourceId: "chatgpt:other:user" },
  { conversationUrl: "https://chatgpt.com/c/other" },
  { can_retry: true },
  { code: "other_failure" },
  { accountSourceId: undefined },
])("does not retire an unconfirmed deletion %j", async (changes) => {
  const f = await fixture();
  f.rejectRead(Object.assign(deletedError(), changes));
  await vi.waitFor(async () => expect((await persisted(f.path)).attempts).toBe(1));
  expect((await persisted(f.path)).pending).toBe(true);
  expect(f.options.observe).not.toHaveBeenCalled();
  expect(f.options.onConversationDeleted).not.toHaveBeenCalled();
});

it("preserves a newer event arriving during a deleted read", async () => {
  const f = await fixture();
  await f.observer.accept(event([final("next-final", "final")]));
  f.rejectRead(deletedError());
  await vi.waitFor(() =>
    expect(f.options.report).toHaveBeenCalledWith("failed", `Error: ${deletedMessage}`),
  );
  expect((await persisted(f.path)).pending).toBe(true);
  expect((await persisted(f.path)).candidates).toEqual(["final", "next-final"]);
});

it.each([
  ["duplicate final", () => [final()], ["final"]],
  [
    "streaming update",
    () => [{ id: "next-user", author: { role: "user" }, parent_id: "final" }],
    ["final"],
  ],
  ["new final", () => [final("next-final", "final")], ["final", "next-final"]],
] as const)(
  "preserves an in-flight 429 cooldown across a %s",
  async (_name, messages, expectedCandidates) => {
    const f = await fixture();
    await f.observer.accept(event(messages()));
    const retryAt = Date.now() + 120_000;
    f.rejectRead(new ChatAccountRateLimitError(retryAt, { status: 429 }));
    await vi.waitFor(() =>
      expect(f.options.report).toHaveBeenCalledWith(
        "failed",
        expect.stringContaining("CHAT_ACCOUNT_RATE_LIMITED"),
      ),
    );
    const state = await persisted(f.path);
    expect(state.retryAt).toBe(retryAt);
    expect(state.attempts).toBe(1);
    expect(state.pending).toBe(true);
    expect(state.candidates).toEqual(expectedCandidates);
    expect(f.options.observe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.options.verify).toHaveBeenCalledTimes(1);
    expect(f.options.readback).not.toHaveBeenCalled();
  },
);

it("persists the raced cooldown so a restart does not immediately repeat the failed read", async () => {
  const f = await fixture();
  await f.observer.accept(event([final()]));
  const retryAt = Date.now() + 120_000;
  f.rejectRead(new ChatAccountRateLimitError(retryAt, { status: 429 }));
  await vi.waitFor(() =>
    expect(f.options.report).toHaveBeenCalledWith(
      "failed",
      expect.stringContaining("CHAT_ACCOUNT_RATE_LIMITED"),
    ),
  );
  await f.observer.stop();
  const restored = new DesktopChatGoalObserver(f.options);
  observers.push(restored);
  await restored.start();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.options.verify).toHaveBeenCalledTimes(1);
  expect((await persisted(f.path)).retryAt).toBe(retryAt);
  expect(f.options.observe).not.toHaveBeenCalled();
});

it("honors the serialized native cooldown instead of falling back to a 30-second retry", async () => {
  const f = await fixture();
  const retryAt = Date.now() + 120_000;
  f.rejectRead(new Error(new ChatAccountRateLimitError(retryAt, undefined).message));
  await vi.waitFor(async () => expect((await persisted(f.path)).retryAt).toBe(retryAt));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.options.verify).toHaveBeenCalledTimes(1);
  expect(f.options.readback).not.toHaveBeenCalled();
  // The observer's existing 30-second tick may fall just before the deadline.
  await vi.advanceTimersByTimeAsync(90_000);
  await vi.waitFor(() => expect(f.options.verify).toHaveBeenCalledTimes(2));
});

it("uses the shared account deadline for the first native 429 while preserving its error", async () => {
  const f = await fixture();
  const retryAt = Date.now() + 300_000;
  f.options.readCooldown.mockResolvedValue({ retryAtUnixMs: retryAt });
  f.rejectRead(
    new Error(
      'Required Codex app native tool codex_app__read_thread failed: {"detail":"Too many requests"}',
    ),
  );
  await vi.waitFor(async () => expect((await persisted(f.path)).retryAt).toBe(retryAt));
  expect(f.options.readCooldown).toHaveBeenCalledWith(accountSourceId);
  expect(f.options.report).toHaveBeenCalledWith(
    "failed",
    expect.stringContaining('{"detail":"Too many requests"}'),
  );
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f.options.verify).toHaveBeenCalledTimes(1);
  expect(f.options.readback).not.toHaveBeenCalled();
});

it.each([false, true])(
  "preserves a settled 429 deadline when a newer final arrives (restart=%s)",
  async (restart) => {
    const f = await fixture();
    const retryAt = Date.now() + 120_000;
    f.rejectRead(new ChatAccountRateLimitError(retryAt, { status: 429 }));
    await vi.waitFor(async () => expect((await persisted(f.path)).retryAt).toBe(retryAt));
    let observer = f.observer;
    if (restart) {
      await observer.stop();
      observer = new DesktopChatGoalObserver(f.options);
      observers.push(observer);
      await observer.start();
    }
    await observer.accept(event([final("next-final", "final")]));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.options.verify).toHaveBeenCalledTimes(1);
    expect(f.options.readback).not.toHaveBeenCalled();
    expect((await persisted(f.path)).retryAt).toBe(retryAt);
    expect((await persisted(f.path)).candidates).toEqual(["final", "next-final"]);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(f.options.readback).toHaveBeenCalledTimes(1));
  },
);

it("still retries a newer final immediately after a non-429 read failure", async () => {
  const f = await fixture();
  f.rejectRead(new Error("TRANSCRIPT_TEMPORARILY_UNAVAILABLE"));
  await vi.waitFor(async () => expect((await persisted(f.path)).attempts).toBe(1));
  await f.observer.accept(event([final("next-final", "final")]));
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() => expect(f.options.readback).toHaveBeenCalledTimes(1));
});

it("keeps repeated transcript lag retries at 30 seconds without overlapping reads", async () => {
  const f = await fixture();
  f.options.verify.mockImplementation(async () => ({ outcome: "awaiting_transcript" }));
  f.rejectRead(new Error("TRANSCRIPT_TEMPORARILY_UNAVAILABLE"));
  await vi.waitFor(async () => expect((await persisted(f.path)).attempts).toBe(1));
  for (let attempt = 2; attempt <= 8; attempt++) {
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () => expect((await persisted(f.path)).attempts).toBe(attempt));
    const state = await persisted(f.path);
    expect(state.retryAt - Date.now()).toBeLessThanOrEqual(30_000);
    expect(state.pending).toBe(true);
    expect(state.candidates).toEqual(["final"]);
    expect(f.options.verify).toHaveBeenCalledTimes(attempt);
  }
  expect(f.options.observe).not.toHaveBeenCalled();
});

it("retires an old persisted exponential wait when the observer restarts", async () => {
  const f = await fixture();
  f.rejectRead(new Error("TRANSCRIPT_TEMPORARILY_UNAVAILABLE"));
  await vi.waitFor(async () => expect((await persisted(f.path)).attempts).toBe(1));
  await f.observer.stop();
  const state = await persisted(f.path);
  state.attempts = 8;
  state.retryAt = Date.now() + 1_800_000;
  await writeFile(f.path, JSON.stringify({ version: 1, entries: [state] }));
  f.options.verify.mockImplementation(async () => ({ outcome: "awaiting_transcript" }));
  const restored = new DesktopChatGoalObserver(f.options);
  observers.push(restored);
  await restored.start();
  await vi.advanceTimersByTimeAsync(30_000);
  await vi.waitFor(() => expect(f.options.verify).toHaveBeenCalledTimes(2));
  expect((await persisted(f.path)).pending).toBe(true);
});
