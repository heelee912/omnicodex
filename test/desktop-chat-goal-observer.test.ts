import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ChatAccountRateLimitError } from "../src/application/chat-account-request-coordinator.js";
import {
  DesktopChatGoalObserver,
  type DesktopGoalBindingRecovery,
  desktopGoalBindingObservation,
} from "../src/application/desktop-chat-goal-observer.js";
import { DirectGoalStore } from "../src/infrastructure/mcp/direct-goal-store.js";
import type {
  DesktopChatCompletionCandidate,
  DesktopChatCompletionVerification,
} from "../src/infrastructure/windows/desktop-chat-completion.js";
import type { DesktopChatObservedEvent } from "../src/infrastructure/windows/desktop-chat-event-source.js";

const roots: string[] = [];
const observers: DesktopChatGoalObserver[] = [];
const url = "https://chatgpt.com/c/conversation";
const principal = { accountId: "account", userId: "user" };
const accountSourceId = "chatgpt:account:user";
afterEach(async () => {
  for (const observer of observers.splice(0)) await observer.stop();
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const event = (messages: unknown[], bare = false): DesktopChatObservedEvent => ({
  source: {
    endpoint: "http://127.0.0.1:29341",
    processId: 1,
    startedAtIso: "2026-09-07T00:00:00Z",
  },
  targetId: "app",
  conversationUrl: url,
  notification: {
    type: bare ? "conversation-turn-complete" : "conversation-update",
    payload: { conversation_id: "conversation", update_content: { messages } },
  },
});
const final = (id = "final", parent = "goal-result") => ({
  id,
  author: { role: "assistant" },
  status: "finished_successfully",
  channel: "final",
  end_turn: true,
  metadata: { parent_id: parent },
});
async function fixture(pauseBeforeOrigin = false, skipOrigin = false) {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const root = await mkdtemp(join(tmpdir(), "desktop-goal-observer-"));
  roots.push(root);
  const path = join(root, "pending.json");
  const store = DirectGoalStore.inMemory();
  const goal = await store.create({
    authorizationBinding: "owner\0issuer\0account\0conversation",
    objective: "continue",
  });
  const source = { ensureConnected: vi.fn(async () => false), stop: vi.fn(async () => {}) };
  const verify = vi.fn(
    async (
      completion: DesktopChatCompletionCandidate,
    ): Promise<DesktopChatCompletionVerification> => ({
      outcome: "verified",
      principal,
      accountSourceId,
      completion,
    }),
  );
  const observe = vi.fn(async (values) => {
    for (const value of values) await store.observeConversation(value);
  });
  const options = {
    path,
    source,
    store,
    verify,
    readback: vi.fn(
      async (): Promise<DesktopChatCompletionVerification> => ({ outcome: "awaiting_transcript" }),
    ),
    observe,
    readScope: vi.fn(async () => ({ accountSourceId, connectorIds: ["asdk_app_installed"] })),
    report: vi.fn(async () => {}),
  };
  const observer = new DesktopChatGoalObserver(options);
  observers.push(observer);
  await observer.start();
  if (pauseBeforeOrigin) {
    await store.updateStatus({
      authorizationBinding: "owner\0issuer\0account\0conversation",
      goalId: goal.id,
      status: "paused",
    });
  }
  const origin = {
    id: "goal-result",
    author: { role: "tool", name: "api_tool.call_tool" },
    status: "finished_successfully",
    metadata: {
      invoked_resource: { resource_uri: "/asdk_app_installed/link_one/omnicodex__goal_create" },
    },
    content: { text: JSON.stringify(goal) },
  };
  if (!skipOrigin) await observer.accept(event([origin]));
  return { observer, options, store, goal, origin, path, verify, observe };
}
async function tick() {
  await vi.advanceTimersByTimeAsync(1);
}
async function persisted(path: string) {
  return JSON.parse(await readFile(path, "utf8")).entries[0];
}

it("binds an installed-connector Goal only after native account/final verification", async () => {
  const f = await fixture();
  await f.observer.accept(event([final()]));
  await tick();
  await vi.waitFor(() => expect(f.observe).toHaveBeenCalledTimes(1));
  const work = (await f.store.pendingContinuations())[0];
  expect(work).toMatchObject({
    goalId: f.goal.id,
    accountSourceId,
    draft: { afterMessageId: "final", transport: "desktop", state: "ready" },
  });
  await f.observer.accept(event([final()]));
  await tick();
  expect(f.observe).toHaveBeenCalledTimes(1);
  expect((await f.store.pendingContinuations())[0]?.draft.token).toBe(work?.draft.token);
});

it.each([false, true])(
  "recovers a Goal omitted from a bare completion stream (restart=%s)",
  async (restart) => {
    const f = await fixture(false, true);
    await f.observer.stop();
    const recoverBinding = vi.fn(async () => ({
      conversationUrl: url,
      source: { kind: "web" as const, accountSourceId },
      goals: [
        {
          messageId: "goal-result",
          goalId: f.goal.id,
          toolName: "omnicodex__goal_create",
          state: f.goal.state,
          revision: f.goal.revision,
          createdAtUnixMs: f.goal.createdAtUnixMs,
        },
      ],
    }));
    const options = { ...f.options, recoverBinding };
    let observer = new DesktopChatGoalObserver(options);
    observers.push(observer);
    await observer.start();
    await observer.accept(event([], true));
    if (restart) {
      await observer.stop();
      observer = new DesktopChatGoalObserver(options);
      observers.push(observer);
      await observer.start();
    }
    f.options.readback.mockResolvedValue({
      outcome: "verified",
      principal,
      accountSourceId,
      completion: { conversationUrl: url, finalMessageId: "final" },
      ancestorMessageIds: ["goal-result"],
    });
    await tick();
    await vi.waitFor(() => expect(f.observe).toHaveBeenCalledTimes(1));
    expect(recoverBinding).toHaveBeenCalledTimes(1);
    expect(recoverBinding.mock.calls[0]?.slice(0, 2)).toEqual([url, accountSourceId]);
    expect((await f.store.pendingContinuations())[0]).toMatchObject({
      goalId: f.goal.id,
      draft: { afterMessageId: "final", transport: "desktop", state: "ready" },
    });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(recoverBinding).toHaveBeenCalledTimes(1);
    expect(f.options.readback).toHaveBeenCalledTimes(1);
  },
);

it.each([false, true])(
  "recovers legacy pending Goal binding and preserves cooldown (%s)",
  async (cooldown) => {
    const f = await fixture();
    if (cooldown)
      f.options.readback.mockRejectedValue(
        new ChatAccountRateLimitError(1_120_000, new Error("429")),
      );
    await f.observer.accept(event([], true));
    await tick();
    await vi.waitFor(async () => expect((await persisted(f.path)).attempts).toBe(1));
    await f.observer.stop();
    await f.store.delete({
      authorizationBinding: "owner\0issuer\0account\0conversation",
      goalId: f.goal.id,
    });
    const goal = await f.store.create({
      authorizationBinding: "owner\0issuer\0account\0conversation",
      objective: "new work",
    });
    const recoverBinding = vi.fn(async () => ({
      conversationUrl: url,
      source: { kind: "web" as const, accountSourceId },
      goals: [
        {
          messageId: "new-goal-result",
          goalId: goal.id,
          toolName: "omnicodex__goal_create",
          state: goal.state,
          revision: goal.revision,
          createdAtUnixMs: goal.createdAtUnixMs,
        },
      ],
    }));
    f.options.readback.mockResolvedValue({
      outcome: "verified",
      principal,
      accountSourceId,
      completion: { conversationUrl: url, finalMessageId: "new-final" },
      ancestorMessageIds: ["new-goal-result"],
    });
    const restored = new DesktopChatGoalObserver({ ...f.options, recoverBinding });
    observers.push(restored);
    await restored.start();
    expect((await persisted(f.path)).bindingReadPending).toBe(true);
    await tick();
    expect(recoverBinding).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(cooldown ? 120_000 : 30_000);
    await vi.waitFor(() => expect(f.observe).toHaveBeenCalledTimes(1));
    expect(recoverBinding).toHaveBeenCalledTimes(1);
    expect((await f.store.pendingContinuations())[0]).toMatchObject({
      goalId: goal.id,
      draft: { afterMessageId: "new-final", state: "ready" },
    });
  },
);

it("distinguishes a deferred observation from a missing or changed source", () => {
  expect(
    desktopGoalBindingObservation({ nextScanAtUnixMs: 2000 }, url, accountSourceId, 1000),
  ).toEqual({ outcome: "pending", retryAtUnixMs: 2000 });
  expect(() => desktopGoalBindingObservation({}, url, accountSourceId, 1000)).toThrow(
    "DESKTOP_GOAL_BINDING_OBSERVATION_MISSING",
  );
  expect(() =>
    desktopGoalBindingObservation(
      {
        nextScanAtUnixMs: 2000,
        goalConversations: [
          {
            conversationUrl: url,
            goals: [],
            source: { kind: "web", accountSourceId: "chatgpt:other:user" },
          },
        ],
      },
      url,
      accountSourceId,
      1000,
    ),
  ).toThrow("DESKTOP_GOAL_BINDING_SOURCE_CHANGED");
});

it("persists deferred binding recovery without an account-change error or retry inflation", async () => {
  const f = await fixture(false, true);
  await f.observer.stop();
  const retryAtUnixMs = Date.now() + 120_000;
  const recoverBinding = vi.fn(
    async (): Promise<DesktopGoalBindingRecovery> =>
      Date.now() < retryAtUnixMs
        ? { outcome: "pending", retryAtUnixMs }
        : { conversationUrl: url, source: { kind: "web", accountSourceId }, goals: [] },
  );
  let observer = new DesktopChatGoalObserver({ ...f.options, recoverBinding });
  observers.push(observer);
  await observer.start();
  await observer.accept(event([], true));
  await tick();
  await vi.waitFor(() => expect(recoverBinding).toHaveBeenCalledTimes(1));
  await observer.stop();
  const entry = JSON.parse(await readFile(f.options.path, "utf8")).entries[0];
  expect(entry).toMatchObject({
    pending: true,
    bindingReadPending: true,
    retryAt: retryAtUnixMs,
    attempts: 0,
  });
  expect(f.options.report).not.toHaveBeenCalledWith("failed", expect.any(String));
  observer = new DesktopChatGoalObserver({ ...f.options, recoverBinding });
  observers.push(observer);
  await observer.start();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(recoverBinding).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(90_000);
  await vi.waitFor(() => expect(recoverBinding).toHaveBeenCalledTimes(2));
  expect(f.observe).not.toHaveBeenCalled();
  expect(await f.store.pendingContinuations()).toEqual([]);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(recoverBinding).toHaveBeenCalledTimes(2);
});

it.each(["wrong-account", "no-matching-goal"])("does not bind a recovery with %s", async (kind) => {
  const f = await fixture(false, true);
  await f.observer.stop();
  const recoverBinding = vi.fn(async () => ({
    conversationUrl: url,
    source: {
      kind: "web" as const,
      accountSourceId: kind === "wrong-account" ? "chatgpt:other:user" : accountSourceId,
    },
    goals: [],
  }));
  const observer = new DesktopChatGoalObserver({ ...f.options, recoverBinding });
  observers.push(observer);
  await observer.start();
  await observer.accept(event([], true));
  await tick();
  await vi.waitFor(() => expect(recoverBinding).toHaveBeenCalledTimes(1));
  expect(f.observe).not.toHaveBeenCalled();
  expect(f.options.readback).not.toHaveBeenCalled();
  expect(await f.store.pendingContinuations()).toEqual([]);
  if (kind === "no-matching-goal") {
    await vi.advanceTimersByTimeAsync(90_000);
    expect(recoverBinding).toHaveBeenCalledTimes(1);
  } else
    await vi.waitFor(() =>
      expect(f.options.report).toHaveBeenCalledWith(
        "failed",
        expect.stringContaining("DESKTOP_GOAL_BINDING_SOURCE_CHANGED"),
      ),
    );
});

it("does not query or bind a Goal paused before its first final", async () => {
  const f = await fixture(true);
  await f.observer.accept(event([final()]));
  await tick();
  expect(f.verify).not.toHaveBeenCalled();
  expect(f.observe).not.toHaveBeenCalled();
  const goal = await f.store.get("owner\0issuer\0account\0conversation", f.goal.id);
  expect(goal).toMatchObject({
    id: f.goal.id,
    state: "paused",
    continuation: { enabled: true },
  });
  expect(goal?.continuation).not.toHaveProperty("conversationUrl");
  expect(goal?.continuation).not.toHaveProperty("accountSourceId");
  expect(goal?.continuation).not.toHaveProperty("bindingMessageId");
  expect(await f.store.pendingContinuations()).toEqual([]);
  expect(
    await f.store.resolveManagementTarget(["owner\0issuer\0account\0conversation"], {
      conversationUrl: url,
    }),
  ).toBeUndefined();
});

it.each(["paused", "completed", "deleted"] as const)(
  "stops pending native readbacks for a %s Goal while preserving resume state",
  async (state) => {
    const f = await fixture();
    await f.observer.accept(event([final()]));
    await tick();
    await vi.waitFor(async () => expect((await persisted(f.path)).pending).toBe(false));
    await f.observer.accept(event([], true));
    await tick();
    await vi.waitFor(async () => expect((await persisted(f.path)).attempts).toBe(1));
    const input = {
      authorizationBinding: "owner\0issuer\0account\0conversation",
      goalId: f.goal.id,
    };
    if (state === "deleted") await f.store.delete(input);
    else if (state === "completed") await f.store.complete(input);
    else await f.store.updateStatus({ ...input, status: "paused" });
    const reads = f.options.readback.mock.calls.length;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(f.options.readback).toHaveBeenCalledTimes(reads);
    expect((await persisted(f.path)).pending).toBe(true);
    await f.observer.stop();
    const restored = new DesktopChatGoalObserver(f.options);
    observers.push(restored);
    await restored.start();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(f.options.readback).toHaveBeenCalledTimes(reads);
    if (state !== "deleted") {
      await f.store.updateStatus({ ...input, status: "active" });
      f.options.readback.mockResolvedValue({
        outcome: "verified",
        principal,
        accountSourceId,
        completion: { conversationUrl: url, finalMessageId: "resumed-final" },
        ancestorMessageIds: ["final", "goal-result"],
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(f.observe).toHaveBeenCalledTimes(2));
      expect((await f.store.pendingContinuations())[0]?.draft.afterMessageId).toBe("resumed-final");
    }
  },
);

it("recovers an omitted turn-joining user edge from the exact native branch", async () => {
  const f = await fixture();
  await f.observer.accept(event([final()]));
  await tick();
  await vi.waitFor(() => expect(f.observe).toHaveBeenCalledTimes(1));
  await vi.waitFor(async () =>
    expect((await persisted(f.path)).pending, JSON.stringify(f.options.report.mock.calls)).toBe(
      false,
    ),
  );
  f.options.readback.mockResolvedValue({
    outcome: "verified",
    principal,
    accountSourceId,
    completion: { conversationUrl: url, finalMessageId: "second-final" },
    ancestorMessageIds: ["omitted-user", "final"],
  });
  await f.observer.accept(event([final("second-final", "omitted-user")]));
  await tick();
  await vi.waitFor(() => expect(f.observe).toHaveBeenCalledTimes(2));
  expect(f.options.readback).toHaveBeenCalledWith(url, "final", expect.any(AbortSignal));
  expect((await f.store.pendingContinuations())[0]?.draft.afterMessageId).toBe("second-final");
});

it("retains a candidate if native branch recovery returns a different newer final", async () => {
  const f = await fixture();
  await f.observer.accept(event([final()]));
  await tick();
  await vi.waitFor(async () => expect((await persisted(f.path)).pending).toBe(false));
  f.options.readback.mockResolvedValue({
    outcome: "verified",
    principal,
    accountSourceId,
    completion: { conversationUrl: url, finalMessageId: "third-final" },
    ancestorMessageIds: ["second-final", "final"],
  });
  await f.observer.accept(event([final("second-final", "omitted-user")]));
  await tick();
  await vi.waitFor(async () => expect((await persisted(f.path)).attempts).toBe(1));
  expect(f.observe).toHaveBeenCalledTimes(1);
  expect((await persisted(f.path)).candidates).toContain("second-final");
  expect((await f.store.pendingContinuations())[0]?.draft.afterMessageId).toBe("final");
});

it("duplicate final notifications do not reset pending backoff or amplify reads", async () => {
  const f = await fixture();
  f.verify.mockResolvedValue({ outcome: "awaiting_transcript" });
  await f.observer.accept(event([final()]));
  await tick();
  await vi.waitFor(async () => expect((await persisted(f.path)).attempts).toBe(1));
  const retryAt = (await persisted(f.path)).retryAt;
  for (let index = 0; index < 4; index++) {
    await f.observer.accept(event([final()]));
    await tick();
  }
  expect(f.verify).toHaveBeenCalledTimes(1);
  expect((await persisted(f.path)).retryAt).toBe(retryAt);
});

it("checks accumulated final candidates with one exact branch read and retains delayed candidates", async () => {
  const f = await fixture();
  f.verify.mockResolvedValue({ outcome: "awaiting_transcript" });
  await f.observer.accept(
    event([final("first"), final("current", "first"), final("delayed", "current")]),
  );
  await tick();
  await vi.waitFor(async () => expect((await persisted(f.path)).attempts).toBe(1));
  expect(f.options.readback).toHaveBeenCalledTimes(1);
  expect(f.verify).not.toHaveBeenCalled();
  expect((await persisted(f.path)).candidates).toEqual(["first", "current", "delayed"]);
  f.options.readback.mockResolvedValue({
    outcome: "verified",
    principal,
    accountSourceId,
    completion: { conversationUrl: url, finalMessageId: "current" },
    ancestorMessageIds: ["first", "goal-result"],
  });
  await vi.advanceTimersByTimeAsync(30_000);
  await vi.waitFor(() => expect(f.observe).toHaveBeenCalledTimes(1));
  expect(f.options.readback).toHaveBeenCalledTimes(2);
  expect(f.verify).not.toHaveBeenCalled();
  expect((await f.store.pendingContinuations())[0]?.draft.afterMessageId).toBe("current");
  await vi.waitFor(async () => expect((await persisted(f.path)).candidates).toEqual(["delayed"]));
  expect((await persisted(f.path)).pending).toBe(true);
});

it("uses the shared account cooldown after transcript delays instead of multiplying their attempts", async () => {
  const f = await fixture();
  f.verify.mockResolvedValue({ outcome: "awaiting_transcript" });
  await f.observer.accept(event([final()]));
  await tick();
  for (let attempt = 1; attempt <= 4; attempt++) {
    await vi.waitFor(async () => expect((await persisted(f.path)).attempts).toBe(attempt));
    if (attempt < 4) {
      vi.setSystemTime((await persisted(f.path)).retryAt);
      await vi.advanceTimersByTimeAsync(30_000);
    }
  }
  const next = (await persisted(f.path)).retryAt;
  const cooldown = next + 120_000;
  f.verify.mockRejectedValue(new ChatAccountRateLimitError(cooldown, undefined));
  vi.setSystemTime(next);
  await vi.advanceTimersByTimeAsync(30_000);
  await vi.waitFor(async () => expect((await persisted(f.path)).attempts).toBe(5));
  expect((await persisted(f.path)).retryAt).toBe(cooldown);
});

it("keeps delayed completion across more than three attempts and restart without another event", async () => {
  const f = await fixture();
  f.verify.mockResolvedValue({ outcome: "awaiting_transcript" });
  await f.observer.accept(event([final()]));
  await tick();
  for (let attempt = 1; attempt <= 4; attempt++) {
    await vi.waitFor(async () => expect((await persisted(f.path)).attempts).toBe(attempt));
    if (attempt < 4) {
      vi.setSystemTime((await persisted(f.path)).retryAt);
      await vi.advanceTimersByTimeAsync(30_000);
    }
  }
  await f.observer.stop();
  f.verify.mockImplementation(async (completion) => ({
    outcome: "verified",
    principal,
    accountSourceId,
    completion,
  }));
  const restored = new DesktopChatGoalObserver(f.options);
  observers.push(restored);
  await restored.start();
  await vi.advanceTimersByTimeAsync(240_000);
  await vi.waitFor(() => expect(f.observe).toHaveBeenCalledTimes(1));
  expect((await f.store.pendingContinuations())[0]?.draft.afterMessageId).toBe("final");
  await vi.advanceTimersByTimeAsync(300_000);
  expect(f.observe).toHaveBeenCalledTimes(1);
});

it("retains bare completion without fabricating a final from an old transcript", async () => {
  const f = await fixture();
  await f.observer.accept(event([], true));
  await tick();
  expect((await persisted(f.path)).pending).toBe(true);
  expect(f.observe).not.toHaveBeenCalled();
  expect(f.verify).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(f.options.readback).toHaveBeenCalledWith(url, undefined, expect.any(AbortSignal)),
  );
});

it("recovers a bare completion through exact native branch readback without another event", async () => {
  const f = await fixture();
  await f.observer.accept(event([final()]));
  await tick();
  await vi.waitFor(() => expect(f.observe).toHaveBeenCalledTimes(1));
  await vi.waitFor(async () => expect((await persisted(f.path)).pending).toBe(false));
  await f.observer.accept(event([], true));
  await tick();
  await vi.waitFor(() => expect(f.options.readback).toHaveBeenCalledTimes(1));
  await vi.waitFor(async () => expect((await persisted(f.path)).attempts).toBe(1));
  expect(f.observe).toHaveBeenCalledTimes(1);
  f.options.readback.mockResolvedValue({
    outcome: "verified",
    principal,
    accountSourceId,
    completion: { conversationUrl: url, finalMessageId: "late-final" },
    ancestorMessageIds: ["user-next", "final"],
  });
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(f.observe).toHaveBeenCalledTimes(2));
  expect((await f.store.pendingContinuations())[0]?.draft.afterMessageId).toBe("late-final");
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f.observe).toHaveBeenCalledTimes(2);
});

it("does not bind under another principal even if the message id matches", async () => {
  const f = await fixture();
  f.verify.mockImplementation(async (completion) => ({
    outcome: "verified",
    principal: { accountId: "other", userId: "user" },
    accountSourceId: "chatgpt:other:user",
    completion,
  }));
  await f.observer.accept(event([final()]));
  await tick();
  await vi.waitFor(() =>
    expect(f.options.report).toHaveBeenCalledWith("failed", "Error: DESKTOP_GOAL_ACCOUNT_CHANGED"),
  );
  expect(await f.store.pendingContinuations()).toEqual([]);
  expect((await persisted(f.path)).pending).toBe(true);
});

it("does not discard a newer candidate while its transcript still shows the older final", async () => {
  const f = await fixture();
  await f.observer.accept(event([final()]));
  await tick();
  await vi.waitFor(() => expect(f.observe).toHaveBeenCalledTimes(1));
  await vi.waitFor(async () => expect((await persisted(f.path)).pending).toBe(false));
  f.verify.mockResolvedValue({ outcome: "awaiting_transcript" });
  await f.observer.accept(event([final("new-final", "final")]));
  await tick();
  await vi.waitFor(async () => expect((await persisted(f.path)).attempts).toBe(1));
  expect((await persisted(f.path)).candidates).toEqual(["new-final"]);
  expect(f.observe).toHaveBeenCalledTimes(1);
});
