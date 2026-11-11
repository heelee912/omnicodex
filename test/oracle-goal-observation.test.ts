import { afterEach, expect, it, vi } from "vitest";
import type {
  BoundedCdpSession,
  ChatGptLoopbackCdpTransport,
} from "../src/infrastructure/chatgpt/chatgpt-cdp-transport.js";
import { OracleChatGptServerApprovalClient } from "../src/infrastructure/chatgpt/oracle-chatgpt-server-approval-client.js";
import {
  isOracleChatGptServerApprovalScanExpression,
  ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION,
  oracleChatGptApprovalRuntimeUrl,
  oracleChatGptServerApprovalScanExpression,
} from "../src/infrastructure/chatgpt/oracle-chatgpt-server-approval-script.js";

const connectorId = "asdk_app_goalobserver";
const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
const globals = globalThis as typeof globalThis & Record<string, unknown>;
const expression = () =>
  oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", ["conversation"], [], {
    observeGoalsOnly: true,
  });
function seed(conversation: unknown) {
  const requestClient = { safeGet: vi.fn().mockResolvedValue(conversation), request: vi.fn() };
  const state = {
    module: {},
    requestClient,
    handled: { previous: true },
    pendingConversations: { other: true },
    pendingConversationRevisions: { other: "revision" },
    expectedApprovals: { other: [{ pendingMessageId: "pending" }] },
    inFlight: { uncertain: { conversationId: "other" } },
    receiptOutbox: { receipt: { clientMessageId: "receipt" } },
    activeConversationRecovery: { other: { awaitingGoalCompletion: true } },
    drains: new Set(),
    lastScanAt: 0,
    backoffUntil: 0,
    backoffMs: 300_000,
  };
  globals[key] = state;
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  return state;
}
afterEach(() => {
  delete globals[key];
  vi.unstubAllGlobals();
});

it("retains observer cooldown across a detached session without reconnecting", async () => {
  const nextScanAtUnixMs = Date.now() + 60_000;
  const command = vi.fn(async (_method: string, params: { expression?: string }) => ({
    result: {
      value:
        params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION
          ? true
          : {
              outcome: "partial",
              examined: 0,
              discovered: 0,
              approvalsPending: 0,
              followUpScanRequired: false,
              conversationUrls: [],
              receipts: [],
              errors: [],
              nextScanAtUnixMs,
            },
    },
  }));
  const transport = {
    adoptOrOpenOwnedApprovalRuntimeTarget: vi.fn(async () => ({
      id: "owned",
      url: oracleChatGptApprovalRuntimeUrl(connectorId),
    })),
  };
  const session = { command, close: vi.fn() };
  const client = new OracleChatGptServerApprovalClient({
    connectorId,
    connectorName: "OmniCodex",
    cdpEndpoint: "http://127.0.0.1:9222",
    transport: transport as unknown as ChatGptLoopbackCdpTransport,
    connectSession: async () => session as unknown as BoundedCdpSession,
  });
  await client.observeGoalConversation(
    "https://chatgpt.com/c/conversation",
    new AbortController().signal,
  );
  await client.stop();
  const result = await client.observeGoalConversation(
    "https://chatgpt.com/c/conversation",
    new AbortController().signal,
  );
  expect(result.nextScanAtUnixMs).toBe(nextScanAtUnixMs);
  expect(transport.adoptOrOpenOwnedApprovalRuntimeTarget).toHaveBeenCalledOnce();
  expect(command).toHaveBeenCalledTimes(2);
});

it("reads the exact conversation while leaving pending approvals and receipts untouched", async () => {
  const state = seed({
    conversation_id: "conversation",
    current_node: "final",
    messages: [
      {
        id: "pending",
        metadata: {
          jit_plugin_data: {
            from_server: {
              type: "confirm_action",
              body: { connector_id: connectorId, actions: [{ type: "always_allow" }] },
            },
          },
        },
      },
      {
        id: "final",
        author: { role: "assistant" },
        status: "finished_successfully",
        end_turn: true,
        channel: "final",
      },
    ],
  });
  const protectedState = () =>
    JSON.stringify({
      pending: state.pendingConversations,
      revisions: state.pendingConversationRevisions,
      expected: state.expectedApprovals,
      inFlight: state.inFlight,
      outbox: state.receiptOutbox,
      recovery: state.activeConversationRecovery,
      handled: state.handled,
    });
  const before = protectedState();
  const result = await new Function(`return ${expression()}`)();
  expect(result).toMatchObject({
    outcome: "ok",
    examined: 1,
    receipts: [],
    requestStats: { getCount: 1, postCount: 0 },
    goalConversations: [
      { conversationUrl: "https://chatgpt.com/c/conversation", current: { id: "final" } },
    ],
  });
  expect(state.requestClient.safeGet).toHaveBeenCalledOnce();
  expect(state.requestClient.safeGet.mock.calls[0]?.[0]).toBe("/conversations/conversation");
  expect(state.requestClient.safeGet.mock.calls[0]?.[1]).toEqual({
    parameters: { query: { include_has_versions: true, num_turns: 1 } },
    disableAutomaticRetry: true,
  });
  expect(state.requestClient.request).not.toHaveBeenCalled();
  expect(protectedState()).toBe(before);
  expect(isOracleChatGptServerApprovalScanExpression(expression(), connectorId, "OmniCodex")).toBe(
    true,
  );
});

it("reads only the current turn even when older pages exist", async () => {
  const message = {
    id: "goal-message",
    author: { role: "tool", name: "api_tool.call_tool" },
    status: "finished_successfully",
    metadata: {
      invoked_resource: { resource_uri: `/${connectorId}/link_existing/omnicodex__goal_get` },
    },
    content: {
      text: JSON.stringify({
        id: "11111111-1111-4111-8111-111111111111",
        state: "active",
        revision: 1,
        createdAtUnixMs: 1,
        steps: [],
      }),
    },
  };
  const state = seed({
    conversation_id: "conversation",
    current_node: message.id,
    messages: [message],
    page_info: { has_previous_page: true, start_cursor: "older" },
  });
  const result = await new Function(`return ${expression()}`)();
  expect(result.goalConversations[0].goals).toHaveLength(1);
  expect(state.requestClient.safeGet).toHaveBeenCalledOnce();
  expect(state.requestClient.safeGet).toHaveBeenCalledWith("/conversations/conversation", {
    parameters: { query: { include_has_versions: true, num_turns: 1 } },
    disableAutomaticRetry: true,
  });
});

it("rejects a different returned conversation before publishing its identity", async () => {
  const state = seed({ conversation_id: "another", messages: [] });
  const result = await new Function(`return ${expression()}`)();
  expect(result.outcome).toBe("partial");
  expect(result).not.toHaveProperty("goalConversations");
  expect(JSON.stringify(result.errors)).toContain("ORACLE_GOAL_CONVERSATION_MISMATCH");
  expect(state.requestClient.request).not.toHaveBeenCalled();
});

it("shares the account cooldown without reading or acknowledging unrelated work", async () => {
  const state = seed({ conversation_id: "conversation", messages: [] });
  state.backoffUntil = Date.now() + 60_000;
  const result = await new Function(`return ${expression()}`)();
  expect(result).toMatchObject({
    outcome: "partial",
    nextScanAtUnixMs: state.backoffUntil,
    receipts: [],
  });
  expect(state.requestClient.safeGet).not.toHaveBeenCalled();
  expect(state.receiptOutbox).toHaveProperty("receipt");
});

it("rejects approval options and receipt acknowledgements in observer mode", () => {
  for (const options of [
    { observeGoalsOnly: true, expectedApprovals: [] },
    { observeGoalsOnly: true, goalCompletionReceipts: [] },
    { observeGoalsOnly: true, observeMessageStructure: true },
  ] as const)
    expect(() =>
      oracleChatGptServerApprovalScanExpression(
        connectorId,
        "OmniCodex",
        ["conversation"],
        [],
        options,
      ),
    ).toThrow("OBSERVATION_INVALID");
  expect(() =>
    oracleChatGptServerApprovalScanExpression(
      connectorId,
      "OmniCodex",
      ["conversation"],
      ["receipt"],
      { observeGoalsOnly: true },
    ),
  ).toThrow("OBSERVATION_INVALID");
  expect(() =>
    oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", [], [], {
      observeGoalsOnly: true,
    }),
  ).toThrow("OBSERVATION_INVALID");
});
