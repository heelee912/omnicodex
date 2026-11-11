import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChromeGoalContinuationTarget } from "../src/application/chrome-goal-continuation.js";
import { GoalContinuationController } from "../src/application/goal-continuation-controller.js";
import type { OracleGoalConversation } from "../src/infrastructure/chatgpt/oracle-goal-conversation.js";
import { DirectGoalStore } from "../src/infrastructure/mcp/direct-goal-store.js";
import { continueDesktopChatGoal } from "../src/infrastructure/windows/desktop-chat-goal-continuation.js";

const controllers: GoalContinuationController[] = [];
const releases: Array<() => void> = [];

function completedConversation(conversationId: string | undefined) {
  return {
    conversation_id: conversationId,
    current_node: "final-node",
    mapping: {
      "final-node": {
        parent: null,
        message: {
          id: "final-1",
          author: { role: "assistant" },
          status: "finished_successfully",
          end_turn: true,
          channel: "final",
          content: { content_type: "text", parts: ["Done"] },
        },
      },
    },
  };
}

it.each(["paused", "complete", "blocked", "deleted", "active"] as const)(
  "checks the durable Goal after desktop selection changes its state to %s",
  async (status) => {
    vi.useFakeTimers();
    const store = DirectGoalStore.inMemory();
    const observation = await goal(store, 1);
    const goalId = observation.goals[0]?.goalId;
    if (goalId === undefined) throw new Error("Missing fixture Goal");
    let changed = false;
    const authorizationBinding = "issuer\0owner-1\0client\0conversation-1";
    const threadId = observation.conversationUrl.split("/").at(-1);
    const callRequiredNative = vi.fn(async (name: string) => {
      expect(name).toBe("codex_app__send_message_to_thread");
      return { threadId };
    });
    const readConversation = vi.fn(async (conversationId: string, signal?: AbortSignal) => {
      expect(conversationId).toBe(threadId);
      expect(signal).toBeInstanceOf(AbortSignal);
      return completedConversation(conversationId);
    });
    const instance = controller(store, (target, signal) =>
      continueDesktopChatGoal(
        { callRequiredNative },
        target,
        undefined,
        signal,
        undefined,
        undefined,
        async () => {
          // Claim and both transcript reads already happened. The lifecycle
          // mutation completes while the last asynchronous preparation runs.
          expect(await store.canDispatchContinuation(target)).toBe(true);
          if (!changed) {
            if (status === "deleted") await store.delete({ authorizationBinding, goalId });
            else if (status !== "active")
              await store.updateStatus({
                authorizationBinding,
                goalId,
                status,
                ...(status === "blocked" ? { reason: "Required device disconnected" } : {}),
              });
          }
          changed = true;
          return "asdk_app_current";
        },
        () => store.canDispatchContinuation(target),
        readConversation,
      ),
    );
    await instance.observe([observation]);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      callRequiredNative.mock.calls.filter(([name]) => name.includes("send_message")),
    ).toHaveLength(status === "active" ? 1 : 0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      callRequiredNative.mock.calls.filter(([name]) => name.includes("send_message")),
    ).toHaveLength(status === "active" ? 1 : 0);
    if (status === "paused") {
      await store.updateStatus({ authorizationBinding, goalId, status: "active" });
      instance.wake();
      await vi.advanceTimersByTimeAsync(0);
      expect(
        callRequiredNative.mock.calls.filter(([name]) => name.includes("send_message")),
      ).toHaveLength(1);
    }
  },
);

it("restores a claimed draft after the desktop pre-send read fails and sends only on recovery", async () => {
  vi.useFakeTimers();
  const store = DirectGoalStore.inMemory();
  const observation = await goal(store, 1);
  const threadId = observation.conversationUrl.split("/").at(-1);
  let reads = 0;
  const callRequiredNative = vi.fn(async (name: string) => {
    expect(name).toBe("codex_app__send_message_to_thread");
    return { threadId };
  });
  const readConversation = vi.fn(async (conversationId: string, signal?: AbortSignal) => {
    expect(conversationId).toBe(threadId);
    expect(signal).toBeInstanceOf(AbortSignal);
    reads += 1;
    // The controller's first inspection succeeds; the sender's own fresh
    // read then fails before any message has been submitted.
    if (reads === 2) throw new Error("READ_CONNECTION_RESET");
    return completedConversation(conversationId);
  });
  const instance = controller(store, (target, signal) =>
    continueDesktopChatGoal(
      { callRequiredNative },
      target,
      undefined,
      signal,
      undefined,
      undefined,
      undefined,
      undefined,
      readConversation,
    ),
  );
  await instance.observe([observation]);
  await vi.advanceTimersByTimeAsync(0);
  expect((await store.pendingContinuations())[0]?.draft.state).toBe("ready");
  expect(
    callRequiredNative.mock.calls.filter(([name]) => name.includes("send_message")),
  ).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(
    callRequiredNative.mock.calls.filter(([name]) => name.includes("send_message")),
  ).toHaveLength(1);
  // The native result lacks a message receipt in this fixture. Retain its
  // uncertainty and never turn another successful read into a second send.
  await vi.advanceTimersByTimeAsync(90_000);
  expect(
    callRequiredNative.mock.calls.filter(([name]) => name.includes("send_message")),
  ).toHaveLength(1);
});

it("restores the unsent claim after the Web sender reports an account change", async () => {
  vi.useFakeTimers();
  const store = DirectGoalStore.inMemory();
  const observation = await goal(store, 1);
  let accountChanged = true;
  const operate = vi.fn(async (target: ChromeGoalContinuationTarget) => {
    if (target.operation === "inspect") return { outcome: "ready" };
    return { outcome: accountChanged ? "account_source_mismatch" : "sent" };
  });
  const instance = controller(store, operate);
  await instance.observe([observation]);
  await vi.advanceTimersByTimeAsync(0);
  expect((await store.pendingContinuations())[0]?.draft.state).toBe("ready");
  accountChanged = false;
  instance.wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(operate.mock.calls.filter(([target]) => target.operation === "send")).toHaveLength(2);
  expect(await store.pendingContinuations()).toEqual([]);
});

it.each(["inspect", "send", "throw", "snapshot"] as const)(
  "honors the shared account deadline after %s without delaying another Goal",
  async (failureAt) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T14:00:00Z"));
    const retryAt = Date.now() + 3_600_000;
    const store = DirectGoalStore.inMemory();
    const first = await goal(store, 1);
    const second = await goal(store, 2);
    const operate = vi.fn(async (target: ChromeGoalContinuationTarget) => {
      if (target.conversationUrl === first.conversationUrl && Date.now() < retryAt) {
        const error = `CHAT_ACCOUNT_RATE_LIMITED: retry at ${new Date(retryAt).toISOString()}`;
        if (failureAt === "throw") throw new Error(error);
        if (failureAt === "snapshot" && target.operation === "inspect")
          return {
            outcome: "rate_limited",
            error: "Too many requests",
            rateLimit: { status: 429, retryAtUnixMs: retryAt },
          };
        if (target.operation === failureAt) return { outcome: "rate_limited", error };
      }
      return { outcome: target.operation === "send" ? "sent" : "ready" };
    });
    const instance = controller(store, operate);
    await instance.observe([first]);
    await vi.advanceTimersByTimeAsync(0);
    const before = operate.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    await instance.observe([second]);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      operate.mock.calls.filter(([target]) => target.conversationUrl === first.conversationUrl),
    ).toHaveLength(before);
    expect(
      operate.mock.calls.some(
        ([target]) =>
          target.conversationUrl === second.conversationUrl && target.operation === "send",
      ),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(2_970_000);
    expect(
      operate.mock.calls.filter(([target]) => target.conversationUrl === first.conversationUrl),
    ).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(
      operate.mock.calls.filter(([target]) => target.conversationUrl === first.conversationUrl),
    ).toHaveLength(before + 2);
  },
);
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(controllers.splice(0).map((instance) => instance.stop()));
  vi.useRealTimers();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  releases.push(resolve);
  return { promise, resolve };
}
async function goal(store: DirectGoalStore, index: number): Promise<OracleGoalConversation> {
  const created = await store.create({
    authorizationBinding: `issuer\0owner-${index}\0client\0conversation-${index}`,
    objective: `Continue independent work ${index}`,
    steps: [{ id: "read", description: "Read the requested source", mode: "successful_call" }],
  });
  return {
    conversationUrl: `https://chatgpt.com/c/${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
    goals: [
      {
        messageId: `goal-result-${index}`,
        toolName: "omnicodex__goal_create",
        goalId: created.id,
        state: created.state,
        revision: created.revision,
        createdAtUnixMs: created.createdAtUnixMs,
      },
    ],
    current: {
      id: `final-${index}`,
      authorRole: "assistant",
      status: "finished_successfully",
      endTurn: true,
      channel: "final",
    },
  };
}
function controller(
  store: DirectGoalStore,
  operate: (target: ChromeGoalContinuationTarget, signal: AbortSignal) => Promise<unknown>,
) {
  const instance = new GoalContinuationController(store, operate, async () => {});
  controllers.push(instance);
  return instance;
}
describe("independent Goal continuation execution", () => {
  it("restores a claimed draft when shutdown is proven to precede native send", async () => {
    vi.useFakeTimers();
    const store = DirectGoalStore.inMemory();
    const observation = await goal(store, 1);
    const entered = deferred();
    const operate = vi.fn(async (target: ChromeGoalContinuationTarget, signal: AbortSignal) => {
      if (target.operation === "inspect") return { outcome: "ready" };
      entered.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return {
        outcome: "send_not_started",
        error: "AbortError: readback cancelled before native send",
      };
    });
    const instance = controller(store, operate);
    await instance.observe([observation]);
    await vi.advanceTimersByTimeAsync(0);
    await entered.promise;
    await instance.stop();
    expect((await store.pendingContinuations())[0]?.draft.state).toBe("ready");
    expect(operate.mock.calls.filter(([target]) => target.operation === "send")).toHaveLength(1);
  });

  it("lets an existing independent Goal send while another inspection remains pending", async () => {
    vi.useFakeTimers();
    const store = DirectGoalStore.inMemory();
    const first = await goal(store, 1),
      second = await goal(store, 2);
    const slow = deferred();
    const operate = vi.fn(async (target: ChromeGoalContinuationTarget) => {
      if (target.conversationUrl === first.conversationUrl) {
        await slow.promise;
        return { outcome: "runtime_not_ready" };
      }
      return { outcome: target.operation === "send" ? "sent" : "ready" };
    });
    await controller(store, operate).observe([first, second]);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      operate.mock.calls.some(
        ([target]) =>
          target.conversationUrl === second.conversationUrl && target.operation === "send",
      ),
    ).toBe(true);
    expect(
      operate.mock.calls.filter(([target]) => target.conversationUrl === first.conversationUrl),
    ).toHaveLength(1);
  });
  it("keeps the full continuation transaction single-flight for one known account", async () => {
    vi.useFakeTimers();
    const store = DirectGoalStore.inMemory();
    const older = await goal(store, 1),
      newer = await goal(store, 2);
    const slow = deferred();
    const operate = vi.fn(async (target: ChromeGoalContinuationTarget) => {
      if (target.operation === "inspect") await slow.promise;
      return { outcome: target.operation === "send" ? "sent" : "ready" };
    });
    const accountSourceId = "chatgpt:user:shared-account";
    await controller(store, operate).observe([
      { ...older, source: { kind: "web", accountSourceId } },
      { ...newer, source: { kind: "web", accountSourceId } },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(operate).toHaveBeenCalledTimes(1);
    slow.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(new Set(operate.mock.calls.map(([target]) => target.conversationUrl))).toEqual(
      new Set([older.conversationUrl, newer.conversationUrl]),
    );
  });
  it("admits newly observed work without waiting for an older Goal flight to settle", async () => {
    vi.useFakeTimers();
    const store = DirectGoalStore.inMemory();
    const first = await goal(store, 1),
      slow = deferred();
    const operate = vi.fn(async (target: ChromeGoalContinuationTarget) => {
      if (target.conversationUrl === first.conversationUrl) await slow.promise;
      return { outcome: target.operation === "send" ? "sent" : "ready" };
    });
    const instance = controller(store, operate);
    await instance.observe([first]);
    await vi.advanceTimersByTimeAsync(0);
    const second = await goal(store, 2);
    await instance.observe([second]);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      operate.mock.calls.some(
        ([target]) =>
          target.conversationUrl === second.conversationUrl && target.operation === "send",
      ),
    ).toBe(true);
  });
  it("keeps one flight for a Goal whose draft changes during inspection", async () => {
    vi.useFakeTimers();
    const store = DirectGoalStore.inMemory(),
      slow = deferred();
    const first = await goal(store, 1);
    const operate = vi.fn(async (target: ChromeGoalContinuationTarget) => {
      if (target.draft.afterMessageId === "final-1") await slow.promise;
      return { outcome: target.operation === "send" ? "sent" : "ready" };
    });
    const instance = controller(store, operate);
    await instance.observe([first]);
    await vi.advanceTimersByTimeAsync(0);
    await instance.observe([
      { ...first, current: { ...first.current, id: "final-new", ancestorMessageIds: ["final-1"] } },
    ]);
    for (let i = 0; i < 20; i += 1) instance.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(operate).toHaveBeenCalledTimes(1);
    slow.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      operate.mock.calls
        .filter(([target]) => target.operation === "send")
        .map(([target]) => target.draft.afterMessageId),
    ).toEqual(["final-new"]);
  });
  it("does not duplicate an uncertain send while independent work completes", async () => {
    vi.useFakeTimers();
    const store = DirectGoalStore.inMemory(),
      slow = deferred();
    const first = await goal(store, 1),
      second = await goal(store, 2);
    const operate = vi.fn(async (target: ChromeGoalContinuationTarget) => {
      if (target.operation === "inspect") return { outcome: "ready" };
      if (target.conversationUrl === first.conversationUrl) {
        await slow.promise;
        return { outcome: "send_unconfirmed" };
      }
      return { outcome: "sent" };
    });
    const instance = controller(store, operate);
    await instance.observe([first]);
    await vi.advanceTimersByTimeAsync(0);
    await instance.observe([second]);
    for (let i = 0; i < 20; i += 1) instance.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      operate.mock.calls.some(
        ([target]) =>
          target.conversationUrl === second.conversationUrl && target.operation === "send",
      ),
    ).toBe(true);
    slow.resolve();
    await vi.advanceTimersByTimeAsync(0);
    instance.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      operate.mock.calls.filter(
        ([target]) =>
          target.conversationUrl === first.conversationUrl && target.operation === "send",
      ),
    ).toHaveLength(1);
    expect(
      (await store.pendingContinuations()).find(
        (work) => work.conversationUrl === first.conversationUrl,
      )?.draft.state,
    ).toBe("dispatching");
  });
  it("paces unchanged pending work instead of spinning when a flight finishes", async () => {
    vi.useFakeTimers();
    const store = DirectGoalStore.inMemory();
    const first = await goal(store, 1),
      second = await goal(store, 2);
    const operate = vi.fn(async () => ({ outcome: "runtime_not_ready" }));
    await controller(store, operate).observe([first, second]);
    await vi.advanceTimersByTimeAsync(0);
    expect(operate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(operate).toHaveBeenCalledTimes(8);
  });
  it("aborts all active lanes and never sends after shutdown even if a read ignores abort", async () => {
    vi.useFakeTimers();
    const store = DirectGoalStore.inMemory(),
      slow = deferred();
    const first = await goal(store, 1),
      second = await goal(store, 2);
    const signals: AbortSignal[] = [];
    const operate = vi.fn(async (target: ChromeGoalContinuationTarget, signal: AbortSignal) => {
      if (target.operation === "inspect") {
        signals.push(signal);
        await slow.promise;
      }
      return { outcome: target.operation === "send" ? "sent" : "ready" };
    });
    const instance = controller(store, operate);
    await instance.observe([first, second]);
    await vi.advanceTimersByTimeAsync(0);
    const stopping = instance.stop();
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    slow.resolve();
    await stopping;
    expect(operate.mock.calls.every(([target]) => target.operation === "inspect")).toBe(true);
    expect((await store.pendingContinuations()).every((work) => work.draft.state === "ready")).toBe(
      true,
    );
  });
  it("keeps failure backoff local while another Goal makes progress", async () => {
    vi.useFakeTimers();
    const store = DirectGoalStore.inMemory();
    const first = await goal(store, 1),
      second = await goal(store, 2);
    const operate = vi.fn(async (target: ChromeGoalContinuationTarget) => {
      if (target.conversationUrl === first.conversationUrl) throw new Error("READ_DISCONNECTED");
      return { outcome: target.operation === "send" ? "sent" : "ready" };
    });
    const instance = controller(store, operate);
    await instance.observe([first, second]);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i += 1) {
      instance.wake();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(
      operate.mock.calls.filter(([target]) => target.conversationUrl === first.conversationUrl),
    ).toHaveLength(1);
    expect(
      operate.mock.calls.some(
        ([target]) =>
          target.conversationUrl === second.conversationUrl && target.operation === "send",
      ),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(
      operate.mock.calls.filter(([target]) => target.conversationUrl === first.conversationUrl),
    ).toHaveLength(2);
  });
});

it("does not multiply unrelated reads when a previously woken slow Goal settles", async () => {
  vi.useFakeTimers();
  const store = DirectGoalStore.inMemory(),
    slow = deferred();
  const first = await goal(store, 1),
    second = await goal(store, 2);
  const operate = vi.fn(async (target: ChromeGoalContinuationTarget) => {
    if (target.conversationUrl === first.conversationUrl) await slow.promise;
    return { outcome: "runtime_not_ready" };
  });
  const instance = controller(store, operate);
  await instance.observe([first, second]);
  await vi.advanceTimersByTimeAsync(0);
  instance.wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(
    operate.mock.calls.filter(([target]) => target.conversationUrl === second.conversationUrl),
  ).toHaveLength(2);
  slow.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(
    operate.mock.calls.filter(([target]) => target.conversationUrl === second.conversationUrl),
  ).toHaveLength(2);
  expect(
    operate.mock.calls.filter(([target]) => target.conversationUrl === first.conversationUrl),
  ).toHaveLength(2);
});

it("reports a rejected observation without discarding valid work from the same event batch", async () => {
  vi.useFakeTimers();
  const store = DirectGoalStore.inMemory();
  const first = await goal(store, 1),
    second = await goal(store, 2);
  const operate = vi.fn(async (target: ChromeGoalContinuationTarget) => ({
    outcome: target.operation === "send" ? "sent" : "ready",
  }));
  const instance = controller(store, operate);
  await expect(
    instance.observe([{ ...first, conversationUrl: "not-a-conversation" }, second]),
  ).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(0);
  expect(
    operate.mock.calls.some(
      ([target]) =>
        target.conversationUrl === second.conversationUrl && target.operation === "send",
    ),
  ).toBe(true);
  expect(
    operate.mock.calls.some(([target]) => target.conversationUrl === first.conversationUrl),
  ).toBe(false);
});

it("restores a proven unsent draft when its atomic claim completes during shutdown", async () => {
  vi.useFakeTimers();
  const store = DirectGoalStore.inMemory(),
    slow = deferred();
  const first = await goal(store, 1);
  const original = store.transitionContinuation.bind(store);
  let claimed = false;
  vi.spyOn(store, "transitionContinuation").mockImplementation(async (work, state) => {
    const changed = await original(work, state);
    if (state === "dispatching" && changed) {
      claimed = true;
      await slow.promise;
    }
    return changed;
  });
  const operate = vi.fn(async (target: ChromeGoalContinuationTarget) => ({
    outcome: target.operation === "send" ? "sent" : "ready",
  }));
  const instance = controller(store, operate);
  await instance.observe([first]);
  await vi.advanceTimersByTimeAsync(0);
  expect(claimed).toBe(true);
  const stopping = instance.stop();
  slow.resolve();
  await stopping;
  expect(operate.mock.calls.map(([target]) => target.operation)).toEqual(["inspect"]);
  expect((await store.pendingContinuations())[0]?.draft.state).toBe("ready");
});

it("drains every lane and exposes reporting failures without an unhandled rejection", async () => {
  vi.useFakeTimers();
  const store = DirectGoalStore.inMemory();
  const first = await goal(store, 1),
    second = await goal(store, 2);
  const operate = vi.fn(async (target: ChromeGoalContinuationTarget) => ({
    outcome: target.operation === "send" ? "sent" : "ready",
  }));
  const instance = new GoalContinuationController(store, operate, async () => {
    throw new Error("LOG_WRITE_FAILED");
  });
  try {
    await instance.observe([first, second]);
    await vi.advanceTimersByTimeAsync(0);
    expect(operate.mock.calls.filter(([target]) => target.operation === "send")).toHaveLength(2);
    expect(await store.pendingContinuations()).toEqual([]);
    await expect(instance.stop()).rejects.toThrow("GOAL_CONTINUATION_REPORT_FAILED");
  } finally {
    await instance.stop().catch(() => undefined);
  }
});

it("preserves a successful send result that settles after shutdown begins", async () => {
  vi.useFakeTimers();
  const store = DirectGoalStore.inMemory(),
    slow = deferred();
  const first = await goal(store, 1);
  const operate = vi.fn(async (target: ChromeGoalContinuationTarget) => {
    if (target.operation === "send") {
      await slow.promise;
      return { outcome: "sent" };
    }
    return { outcome: "ready" };
  });
  const instance = controller(store, operate);
  await instance.observe([first]);
  await vi.advanceTimersByTimeAsync(0);
  expect(operate.mock.calls.filter(([target]) => target.operation === "send")).toHaveLength(1);
  const stopping = instance.stop();
  slow.resolve();
  await stopping;
  const result = await store.get("issuer\0owner-1\0client\0conversation-1");
  expect(result?.continuation?.draft?.state).toBe("sent");
  instance.wake();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(operate.mock.calls.filter(([target]) => target.operation === "send")).toHaveLength(1);
});

it("retains every original error when more than one observation is rejected", async () => {
  vi.useFakeTimers();
  const store = DirectGoalStore.inMemory();
  const first = await goal(store, 1),
    second = await goal(store, 2),
    third = await goal(store, 3);
  const operate = vi.fn(async (target: ChromeGoalContinuationTarget) => ({
    outcome: target.operation === "send" ? "sent" : "ready",
  }));
  const instance = controller(store, operate);
  const result = await instance
    .observe([
      { ...first, conversationUrl: "invalid-a" },
      second,
      { ...third, conversationUrl: "invalid-b" },
    ])
    .catch((error: unknown) => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect((result as AggregateError).errors).toHaveLength(2);
  for (const error of (result as AggregateError).errors)
    expect(error.message).toBe("DIRECT_GOAL_CONVERSATION_INVALID");
  await vi.advanceTimersByTimeAsync(0);
  expect(operate.mock.calls.filter(([target]) => target.operation === "send")).toHaveLength(1);
});
