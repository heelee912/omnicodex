import { afterEach, expect, it, vi } from "vitest";
import { OracleChatGptServerApprovalClient } from "../src/infrastructure/chatgpt/oracle-chatgpt-server-approval-client.js";
import {
  ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION,
  oracleChatGptApprovalRuntimeUrl,
  oracleChatGptServerApprovalScanExpression,
} from "../src/infrastructure/chatgpt/oracle-chatgpt-server-approval-script.js";
import type { OracleConversationNotification } from "../src/infrastructure/chatgpt/oracle-conversation-event-source.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("retains partial turn confirmation when a duplicate empty done arrives", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  const connector = "asdk_app_partialturn";
  const key = `__omnicodexOracleServerApprovalV2:${connector}`;
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  let finished = false;
  const final = (id: string) => ({
    id,
    author: { role: "assistant" },
    status: "finished_successfully",
    end_turn: true,
    channel: "final",
  });
  const mapping = {
    a: { parent: null, message: { id: "a", author: { role: "tool" } } },
    fa: { parent: "a", message: final("fa") },
    user: { parent: "fa", message: { id: "user", author: { role: "user" } } },
    b: { parent: "user", message: { id: "b", author: { role: "tool" } } },
    fb: { parent: "b", message: final("fb") },
  };
  const requestClient = {
    safeGet: vi.fn(async () => ({
      conversation_id: "conversation",
      current_node: finished ? "fb" : "b",
      mapping,
    })),
    request: vi.fn(),
  };
  globals[key] = { module: {}, requestClient, handled: {}, inFlight: {} };
  const scan = (turns?: Array<{ turnId: string; messageIds: string[] }>) =>
    new Function(
      `return ${oracleChatGptServerApprovalScanExpression(connector, "OmniCodex", turns ? ["conversation"] : [], [], turns ? { goalCompletionReceipts: ["conversation"], goalCompletionTurns: { conversation: turns } } : undefined)}`,
    )();
  try {
    await scan([
      { turnId: "A", messageIds: ["a"] },
      { turnId: "B", messageIds: ["b"] },
    ]);
    let state = JSON.parse(storage.get(key) ?? "{}");
    expect(state.confirmedGoalCompletionTurnIds.conversation).toEqual(["A"]);
    expect(state.activeConversationRecovery.conversation.turns).toEqual([
      { turnId: "B", messageIds: ["b"] },
    ]);
    await vi.advanceTimersByTimeAsync(5_000);
    await scan([{ turnId: "A", messageIds: [] }]);
    state = JSON.parse(storage.get(key) ?? "{}");
    expect(state.activeConversationRecovery.conversation.turns).toEqual([
      { turnId: "B", messageIds: ["b"] },
    ]);
    finished = true;
    await vi.advanceTimersByTimeAsync(30_000);
    await scan();
    state = JSON.parse(storage.get(key) ?? "{}");
    expect(state.activeConversationRecovery).toEqual({});
    expect(state.confirmedGoalCompletionTurnIds.conversation).toEqual(["A", "B"]);
  } finally {
    delete globals[key];
  }
});

it("preserves interleaved native turns and merges a late final into a persisted empty receipt", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  const connector = "asdk_app_turnclient";
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const url = `https://chatgpt.com/c/${id}`;
  const key = `__omnicodexOracleServerApprovalV2:${connector}`;
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const final = {
    id: "late-final",
    author: { role: "assistant" },
    status: "finished_successfully",
    end_turn: true,
    channel: "final",
  };
  const mapping = {
    anchor: { parent: null, message: { id: "anchor", author: { role: "tool" } } },
    "late-final": { parent: "anchor", message: final },
    tail: { parent: "late-final", message: { id: "tail", author: { role: "tool" } } },
  };
  let current = "anchor";
  const requestClient = {
    safeGet: vi.fn(async () => ({ conversation_id: id, current_node: current, mapping })),
    request: vi.fn(),
  };
  globals[key] = { module: {}, requestClient, handled: {}, inFlight: {} };
  let notify: (url: string, notification?: OracleConversationNotification) => void = () => {};
  let connected = false;
  const client = new OracleChatGptServerApprovalClient({
    connectorId: connector,
    connectorName: "OmniCodex",
    cdpEndpoint: "http://127.0.0.1:9222",
    recoverGoalConversations: async () => [url],
    conversationEvents: {
      ensureConnected: async (callback) => {
        notify = callback;
        if (connected) return false;
        connected = true;
        return true;
      },
      stop: async () => {},
    },
    transport: {
      adoptOrOpenOwnedApprovalRuntimeTarget: async () => ({
        id: "runtime",
        url: oracleChatGptApprovalRuntimeUrl(connector),
      }),
    } as never,
    connectSession: (async () => ({
      close: () => {},
      command: async (_method: string, params: { expression: string }) => ({
        result: {
          value:
            params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION
              ? true
              : await new Function(`return ${params.expression}`)(),
        },
      }),
    })) as never,
  });
  const update = (turn: string, message: object) =>
    notify(url, {
      type: "conversation-update",
      payload: { turn_id: turn, update_content: { messages: [message] } },
    });
  const done = (turn: string) =>
    notify(url, { type: "conversation-turn-complete", payload: { turn_id: turn } });
  try {
    await client.scan(new AbortController().signal);
    done("late");
    await vi.advanceTimersByTimeAsync(5_000);
    await client.scan(new AbortController().signal);
    expect(JSON.parse(storage.get(key) ?? "{}").activeConversationRecovery[id].turns).toEqual([
      { turnId: "late", messageIds: [] },
    ]);
    update("first", { id: "anchor", author: { role: "tool" } });
    update("other", { id: "other-anchor", author: { role: "tool" } });
    done("first");
    current = "tail";
    update("late", final);
    await vi.advanceTimersByTimeAsync(30_000);
    await client.scan(new AbortController().signal);
    const state = JSON.parse(storage.get(key) ?? "{}");
    expect(state.activeConversationRecovery[id]).toBeUndefined();
    expect(state.confirmedGoalCompletionTurnIds[id]).toEqual(
      expect.arrayContaining(["first", "late"]),
    );
  } finally {
    await client.stop();
    delete globals[key];
  }
});

it.each(["same", "later-user", "sibling", "missing-anchor", "legacy"])(
  "checks native turn anchors on the exact branch: %s",
  async (mode) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const connector = "asdk_app_turnreceipt";
    const key = `__omnicodexOracleServerApprovalV2:${connector}`;
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const anchor = { id: "anchor", author: { role: "tool" } };
    const final = {
      id: "final",
      author: { role: "assistant" },
      status: "finished_successfully",
      end_turn: true,
      channel: "final",
    };
    const mapping = {
      anchor: { parent: null, message: anchor },
      user: { parent: "anchor", message: { id: "user", author: { role: "user" } } },
      final: {
        parent: mode === "later-user" ? "user" : mode === "sibling" ? null : "anchor",
        message: final,
      },
      tail: { parent: "final", message: { id: "tail", author: { role: "tool" } } },
    };
    const requestClient = {
      safeGet: vi.fn(async () => ({
        conversation_id: "conversation",
        current_node: "tail",
        mapping,
      })),
      request: vi.fn(),
    };
    globals[key] = { module: {}, requestClient, handled: {}, inFlight: {} };
    const options = {
      goalCompletionReceipts: ["conversation"],
      ...(mode === "legacy"
        ? {}
        : {
            goalCompletionTurns: {
              conversation: [
                {
                  turnId: "envelope-not-working-turn",
                  messageIds: mode === "missing-anchor" ? [] : ["anchor"],
                },
              ],
            },
          }),
    };
    const scan = () =>
      new Function(
        `return ${oracleChatGptServerApprovalScanExpression(connector, "OmniCodex", ["conversation"], [], options)}`,
      )();
    try {
      await scan();
      let state = JSON.parse(localStorage.getItem(key) ?? "{}");
      if (mode === "same") {
        expect(state.activeConversationRecovery).toEqual({});
        expect(state.confirmedGoalCompletionTurnIds.conversation).toEqual([
          "envelope-not-working-turn",
        ]);
        expect(state.pendingConversations).toEqual({});
        const confirmedReadCount = requestClient.safeGet.mock.calls.length;
        expect(confirmedReadCount).toBeGreaterThan(0);
        await vi.advanceTimersByTimeAsync(60_000);
        await scan();
        expect(requestClient.safeGet).toHaveBeenCalledTimes(confirmedReadCount);
      } else {
        expect(state.activeConversationRecovery.conversation.awaitingGoalCompletion).toBe(true);
        if (mode !== "legacy")
          expect(state.activeConversationRecovery.conversation.turns).toEqual(
            options.goalCompletionTurns?.conversation,
          );
        else expect(state.activeConversationRecovery.conversation).not.toHaveProperty("turns");
        globals[key] = { ...state, module: {}, requestClient };
        await vi.advanceTimersByTimeAsync(30_000);
        await scan();
        state = JSON.parse(localStorage.getItem(key) ?? "{}");
        expect(state.activeConversationRecovery.conversation.awaitingGoalCompletion).toBe(true);
      }
      expect(requestClient.request).not.toHaveBeenCalled();
    } finally {
      delete globals[key];
    }
  },
);
