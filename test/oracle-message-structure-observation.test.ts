import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OracleChatGptServerApprovalClient } from "../src/infrastructure/chatgpt/oracle-chatgpt-server-approval-client.js";
import {
  isOracleChatGptServerApprovalScanExpression,
  ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION,
  oracleChatGptApprovalRuntimeUrl,
  oracleChatGptServerApprovalScanExpression,
} from "../src/infrastructure/chatgpt/oracle-chatgpt-server-approval-script.js";

const connectorId = "asdk_app_observation";
const stateKey = `__omnicodexOracleServerApprovalV2:${connectorId}`;
const conversationId = "12345678-1234-4234-8234-123456789abc";
const globals = globalThis as typeof globalThis & Record<string, unknown>;

describe("fixed Oracle message structure observation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
  });
  afterEach(() => {
    delete globals[stateKey];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function seed(
    safeGet = vi.fn(
      async (): Promise<{ messages: unknown[]; current_node?: unknown }> => ({ messages: [] }),
    ),
  ) {
    const state = {
      requestClient: { safeGet, request: vi.fn() },
      handled: { previous: true },
      receiptOutbox: { receipt: { clientMessageId: "receipt" } },
      inFlight: { pending: { conversationId: "another" } },
      pendingConversations: { queued: true },
      pendingConversationRevisions: { queued: "revision" },
      lastScanAt: 0,
      backoffUntil: 0,
      backoffMs: 300_000,
      lastRateLimit: null,
      drains: new Set(),
    };
    globals[stateKey] = state;
    return state;
  }

  function expression(canonicalResourceOrigin?: string) {
    return oracleChatGptServerApprovalScanExpression(
      connectorId,
      "OmniCodex",
      [conversationId],
      [],
      {
        observeMessageStructure: true,
        ...(canonicalResourceOrigin === undefined ? {} : { canonicalResourceOrigin }),
      },
    );
  }

  async function observe(canonicalResourceOrigin?: string) {
    return await new Function(`return ${expression(canonicalResourceOrigin)}`)();
  }

  it.each(["root", "missing_node", "cycle"])(
    "observes current-turn parent ancestry to %s without exposing message content",
    async (termination) => {
      const goal = {
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
            objective: "PRIVATE_BODY",
          }),
        },
      };
      const get = vi.fn(async () => ({
        conversation_id: conversationId,
        current_node: "final",
        messages: [
          { id: "final", author: { role: "assistant" }, parent_id: "empty" },
          {
            id: "empty",
            author: { role: "system" },
            parent_id:
              termination === "root" ? null : termination === "cycle" ? "final" : "missing",
          },
          goal,
        ],
      }));
      seed(get);
      const expression = oracleChatGptServerApprovalScanExpression(
        connectorId,
        "OmniCodex",
        [conversationId],
        [],
        { observeMessageStructure: true, observeBranchStructure: true },
      );
      expect(
        isOracleChatGptServerApprovalScanExpression(expression, connectorId, "OmniCodex"),
      ).toBe(true);
      const result = await new Function(`return ${expression}`)();
      const branch = result.messageStructureObservation.branchStructure;
      expect(branch.termination).toBe(termination);
      expect(branch.chain.map((node: { nodeId: string }) => node.nodeId)).toEqual([
        "final",
        "empty",
      ]);
      expect(branch.goalNodes).toMatchObject([
        { messageId: "goal-message", nodeIds: ["goal-message"], onCurrentBranch: false },
      ]);
      expect(JSON.stringify(branch)).not.toContain("PRIVATE_BODY");
      expect(get).toHaveBeenCalledOnce();
    },
  );

  it("reports exact Goal routes from another registration without accepting their binding", async () => {
    const route = "/asdk_app_other/link_existing/omnicodex__goal_get";
    seed(
      vi.fn(async () => ({
        messages: [
          {
            id: "native-goal-result",
            author: { role: "tool", name: "api_tool.call_tool" },
            status: "finished_successfully",
            metadata: { invoked_resource: { resource_uri: route } },
            content: {
              text: JSON.stringify({
                id: "11111111-1111-4111-8111-111111111111",
                state: "active",
                revision: 1,
                createdAtUnixMs: 1,
                steps: [],
              }),
            },
          },
        ],
      })),
    );
    const result = await observe();
    expect(result.messageStructureObservation.messages[0].invokedGoalResourceUri).toBe(route);
    expect(result.messageStructureObservation.goalConversation.goals).toEqual([]);
  });

  it("admits only the exact fixed single-conversation read operation", () => {
    expect(
      isOracleChatGptServerApprovalScanExpression(expression(), connectorId, "OmniCodex"),
    ).toBe(true);
    expect(
      isOracleChatGptServerApprovalScanExpression(
        `${expression()};fetch('/')`,
        connectorId,
        "OmniCodex",
      ),
    ).toBe(false);
    expect(() =>
      oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", [], [], {
        observeMessageStructure: true,
      }),
    ).toThrow("OBSERVATION_INVALID");
    expect(() =>
      oracleChatGptServerApprovalScanExpression(
        connectorId,
        "OmniCodex",
        [conversationId, "another"],
        [],
        { observeMessageStructure: true },
      ),
    ).toThrow("OBSERVATION_INVALID");
    expect(() =>
      oracleChatGptServerApprovalScanExpression(
        connectorId,
        "OmniCodex",
        [conversationId],
        ["receipt"],
        { observeMessageStructure: true },
      ),
    ).toThrow("OBSERVATION_INVALID");
    expect(
      isOracleChatGptServerApprovalScanExpression(
        expression().replace(
          '"observeMessageStructure":true',
          '"observeMessageStructure":true,"code":"fetch()"',
        ),
        connectorId,
        "OmniCodex",
      ),
    ).toBe(false);
  });

  it("reads once and projects structure without text, credentials, resource values, or approvals", async () => {
    const state = seed(
      vi.fn(async () => ({
        messages: [
          {
            id: "tool-message",
            author: { role: "tool", name: "OmniCodex" },
            content: {
              content_type: "text",
              parts: ["private conversation body"],
              result: {
                _meta: {
                  omnicodex: {
                    workSessionBinding: "private-binding",
                    continuationToken: "private-token",
                  },
                },
                content: [
                  { type: "resource_link", uri: "https://example.test/resource/private-id" },
                ],
              },
            },
            metadata: { accessToken: "private-access-token" },
          },
        ],
      })),
    );
    const preserved = JSON.stringify([
      state.handled,
      state.receiptOutbox,
      state.inFlight,
      state.pendingConversations,
      state.pendingConversationRevisions,
    ]);
    const result = await observe();
    expect(state.requestClient.safeGet).toHaveBeenCalledExactlyOnceWith(
      `/conversations/${conversationId}`,
      {
        parameters: { query: { include_has_versions: true, num_turns: 1 } },
        disableAutomaticRetry: true,
      },
    );
    expect(state.requestClient.request).not.toHaveBeenCalled();
    expect(
      JSON.stringify([
        state.handled,
        state.receiptOutbox,
        state.inFlight,
        state.pendingConversations,
        state.pendingConversationRevisions,
      ]),
    ).toBe(preserved);
    expect(result.messageStructureObservation.messages[0].resourceLinks).toEqual([
      {
        path: '$["content"]["result"]["content"][0]',
        keys: ["type", "uri"],
        uriType: "string",
      },
    ]);
    expect(result.messageStructureObservation.messages[0].containers).toContainEqual({
      path: '$["content"]["result"]["_meta"]["omnicodex"]',
      keys: ["workSessionBinding", "continuationToken"],
    });
    expect(JSON.stringify(result)).not.toMatch(/private-|private conversation/);
    await observe();
    expect(state.requestClient.safeGet).toHaveBeenCalledTimes(1);
  });

  it("honors and updates the existing account cooldown without retrying or initializing a client", async () => {
    const state = seed();
    state.backoffUntil = Date.now() + 20_000;
    expect((await observe()).examined).toBe(0);
    expect(state.requestClient.safeGet).not.toHaveBeenCalled();
    state.backoffUntil = 0;
    state.requestClient.safeGet.mockRejectedValue(
      Object.assign(new Error("secret response"), { status: 429 }),
    );
    const result = await observe();
    expect(result.errors[0]).toMatchObject({
      status: 429,
      error: "ORACLE_MESSAGE_STRUCTURE_READ_FAILED",
    });
    expect(state.backoffUntil).toBeGreaterThan(Date.now());
    expect(JSON.stringify(result)).not.toContain("secret response");
    await observe();
    expect(state.requestClient.safeGet).toHaveBeenCalledTimes(1);
    expect(state.requestClient.request).not.toHaveBeenCalled();
  });

  it("does not initialize a missing client or retry an authentication/policy rejection", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    globals[stateKey] = {};
    expect((await observe()).errors[0].error).toBe(
      "ORACLE_OBSERVATION_EXISTING_CLIENT_UNAVAILABLE",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    const state = seed();
    state.requestClient.safeGet.mockRejectedValue(
      Object.assign(new Error("private denied body"), { status: 403 }),
    );
    const result = await observe();
    expect(result).toMatchObject({ outcome: "partial", examined: 1, errors: [{ status: 403 }] });
    expect(state.requestClient.safeGet).toHaveBeenCalledTimes(1);
    expect(state.requestClient.request).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private denied body");
  });

  it("projects JSON-encoded code and attachment structures from the same single response", async () => {
    const toolResult = {
      _meta: {
        omnicodex: { workSessionBinding: "private-binding", continuationToken: "private-token" },
      },
      content: [{ type: "resource_link", uri: "https://example.test/resources/private-resource" }],
    };
    const state = seed(
      vi.fn(async () => ({
        messages: [
          {
            id: "last-attachment",
            author: { role: "tool", name: "api_tool.call_tool" },
            content: {
              content_type: "code",
              text: JSON.stringify(toolResult),
              parts: [
                JSON.stringify({ nested: { secret: "private-nested-value" } }),
                "non-JSON private prose",
              ],
            },
            metadata: {
              attachments: [{ id: "private-attachment-id", extra: { source: "private-source" } }],
            },
          },
        ],
      })),
    );
    const result = await observe();
    const observed = result.messageStructureObservation.messages[0];
    expect(observed.resourceLinks).toEqual([
      {
        path: '$["content"]["text"]#json["content"][0]',
        keys: ["type", "uri"],
        uriType: "string",
      },
    ]);
    expect(observed.containers).toEqual(
      expect.arrayContaining([
        {
          path: '$["content"]["text"]#json["_meta"]["omnicodex"]',
          keys: ["workSessionBinding", "continuationToken"],
        },
        { path: '$["metadata"]["attachments"][0]', keys: ["id", "extra"] },
        { path: '$["metadata"]["attachments"][0]["extra"]', keys: ["source"] },
        { path: '$["content"]["parts"][0]#json["nested"]', keys: ["secret"] },
      ]),
    );
    expect(JSON.stringify(result)).not.toMatch(/private-|private prose|example\.test/);
    expect(state.requestClient.safeGet).toHaveBeenCalledTimes(1);
    expect(state.requestClient.request).not.toHaveBeenCalled();
  });

  it("projects actual primitive state only from current_node without inferring completion", async () => {
    const state = seed(
      vi.fn(async () => ({
        current_node: "current-message",
        messages: [
          {
            id: "current-message",
            author: { role: "assistant" },
            status: "in_progress",
            end_turn: false,
            channel: "analysis",
            metadata: {
              is_complete: false,
              working_turn_id: "turn-current",
              turn_exchange_id: "exchange-current",
            },
          },
          {
            id: "not-current",
            author: { role: "assistant" },
            status: "finished_successfully",
            end_turn: true,
            channel: "final",
            metadata: { is_complete: true },
          },
        ],
      })),
    );
    const result = await observe();
    expect(result.messageStructureObservation).toMatchObject({
      currentNode: "current-message",
      currentMessage: {
        id: "current-message",
        authorRole: "assistant",
        status: "in_progress",
        endTurn: false,
        channel: "analysis",
        isComplete: false,
        workingTurnId: "turn-current",
        turnExchangeId: "exchange-current",
      },
    });
    expect(state.requestClient.safeGet).toHaveBeenCalledTimes(1);
    expect(state.requestClient.request).not.toHaveBeenCalled();
  });

  it("recognizes Goal origin only in this connector's successful host-recorded Goal actions", async () => {
    const goal = {
      id: "3b653f0c-013d-4f70-bf62-50306c1d4c03",
      state: "active",
      revision: 9,
      createdAtUnixMs: 1234,
      steps: [],
      objective: "private objective",
    };
    const message = (tool = "omnicodex__goal_get", body: unknown = goal) => ({
      id: "goal-message",
      author: { role: "tool", name: "api_tool.call_tool" },
      status: "finished_successfully",
      content: { content_type: "code", text: JSON.stringify(body) },
      metadata: { invoked_resource: { resource_uri: `/${connectorId}/link_123/${tool}` } },
    });
    const forged = [
      { ...message(), author: { role: "user", name: "api_tool.call_tool" } },
      { ...message(), author: { role: "assistant", name: "api_tool.call_tool" } },
      { ...message(), author: { role: "tool", name: "other_tool" } },
      { ...message(), status: "in_progress" },
      {
        ...message(),
        metadata: {
          invoked_resource: { resource_uri: "/asdk_app_other/link_123/omnicodex__goal_get" },
        },
      },
      {
        ...message(),
        metadata: {
          invoked_resource: { resource_uri: `/${connectorId}/link_123/omnicodex__goal_get?extra` },
        },
      },
      message("codex__app_server__command_exec"),
      message("omnicodex__goal_get", { ...goal, revision: "9" }),
      message("omnicodex__goal_get", { ...goal, id: "not-a-goal" }),
      message("omnicodex__goal_get", { text: "DIRECT_GOAL_NOT_FOUND", is_error: true }),
      { ...message(), content: { content_type: "text", text: `Goal ${goal.id}` } },
    ];
    const state = seed(
      vi.fn(async () => ({
        messages: [
          message(),
          message("omnicodex__goal_claim_next_step", { goal, claimToken: "private-claim-token" }),
          ...forged,
        ],
      })),
    );
    const observed = (await observe()).messageStructureObservation.messages;
    expect(observed[0].goalResult).toEqual({
      toolName: "omnicodex__goal_get",
      goalId: goal.id,
      state: "active",
      revision: 9,
      createdAtUnixMs: 1234,
    });
    expect(observed[1].goalResult).toEqual({
      ...observed[0].goalResult,
      toolName: "omnicodex__goal_claim_next_step",
    });
    for (const entry of observed.slice(2)) expect(entry).not.toHaveProperty("goalResult");
    expect(JSON.stringify(observed)).not.toMatch(/private objective|private-claim-token/);
    expect(state.requestClient.safeGet).toHaveBeenCalledTimes(1);
    expect(state.requestClient.request).not.toHaveBeenCalled();
  });

  it("projects Goal continuation from the existing approval read without extra hydration or approval writes", async () => {
    const state = seed(
      vi.fn(async () => ({
        current_node: "preamble",
        messages: [
          {
            id: "result",
            author: { role: "tool", name: "api_tool.call_tool" },
            status: "finished_successfully",
            metadata: {
              invoked_resource: { resource_uri: `/${connectorId}/link_123/omnicodex__goal_get` },
            },
            content: {
              text: JSON.stringify({
                id: "3b653f0c-013d-4f70-bf62-50306c1d4c03",
                state: "active",
                revision: 1,
                createdAtUnixMs: 1234,
                steps: [],
              }),
            },
          },
          {
            id: "final",
            author: { role: "assistant" },
            status: "finished_successfully",
            end_turn: true,
            channel: "final",
            metadata: { working_turn_id: "turn-final", turn_exchange_id: "turn-final" },
          },
          {
            id: "preamble",
            author: { role: "assistant" },
            status: "finished_successfully",
            end_turn: true,
            channel: "commentary",
            metadata: {
              working_turn_id: "turn-final",
              turn_exchange_id: "turn-final",
              is_thinking_preamble_message: true,
            },
          },
        ],
      })),
    );
    globals[stateKey] = {
      ...state,
      module: {},
      pendingConversations: {},
      inFlight: {},
      receiptOutbox: {},
    };
    const result = await new Function(
      `return ${oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", [conversationId])}`,
    )();
    expect(result.goalConversations).toMatchObject([
      {
        conversationUrl: `https://chatgpt.com/c/${conversationId}`,
        goals: [{ messageId: "result", toolName: "omnicodex__goal_get" }],
        current: { id: "final", endTurn: true, channel: "final" },
      },
    ]);
    expect(state.requestClient.safeGet).toHaveBeenCalledTimes(1);
    expect(state.requestClient.request).not.toHaveBeenCalled();
    expect(result.requestStats).toMatchObject({
      getCount: 1,
      postCount: 0,
      moduleInitializationCount: 0,
    });
    expect(result.followUpScanRequired).toBe(false);
    vi.advanceTimersByTime(120_000);
    const idle = await new Function(
      `return ${oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex")}`,
    )();
    expect(idle.requestStats.getCount).toBe(0);
    expect(state.requestClient.safeGet).toHaveBeenCalledTimes(1);
  });

  it("omits unexpected state types and does not substitute the array tail for a missing current node", async () => {
    const state = seed(
      vi.fn(async () => ({
        current_node: "current",
        messages: [
          {
            id: "current",
            author: { role: 1 },
            status: {},
            end_turn: null,
            channel: null,
            metadata: { is_complete: "true", working_turn_id: [], turn_exchange_id: 7 },
          },
        ],
      })),
    );
    expect((await observe()).messageStructureObservation.currentMessage).toEqual({
      id: "current",
      endTurn: null,
      channel: null,
    });
    vi.advanceTimersByTime(5_000);
    state.requestClient.safeGet.mockResolvedValue({ current_node: "absent", messages: [] });
    const missing = (await observe()).messageStructureObservation;
    expect(missing.currentNode).toBe("absent");
    expect(missing).not.toHaveProperty("currentMessage");
  });

  it("extracts only exact canonical resource IDs from confirmed tool metadata paths", async () => {
    const origin = "https://resource.example";
    const id = "A".repeat(43);
    const uri = `${origin}/resources/${id}`;
    const invalid = [
      `https://other.example/resources/${id}`,
      `${uri}?token=private`,
      `${uri}#fragment`,
      `https://name:secret@resource.example/resources/${id}`,
      `https://RESOURCE.example/resources/${id}`,
      `${origin}:443/resources/${id}`,
      `${origin}/before/../resources/${id}`,
      `${origin}/resources/${id}/`,
      `${origin}/resources/${id.slice(1)}`,
      `${origin}/resources/%41${id.slice(1)}`,
      `${origin}/resources/${"+".repeat(43)}`,
      7,
    ];
    const metadata = {
      attachments: [{ download_url: uri }, ...invalid.map((download_url) => ({ download_url }))],
      invoked_resource: { resource_uri: uri },
    };
    const state = seed(
      vi.fn(async () => ({
        messages: [
          {
            id: "tool",
            author: { role: "tool", name: "api_tool.call_tool" },
            metadata,
            content: { text: `User prose ${uri}` },
          },
          { id: "user", author: { role: "user" }, metadata },
          { id: "assistant", author: { role: "assistant" }, metadata },
          { id: "other-tool", author: { role: "tool", name: "unrelated" }, metadata },
        ],
      })),
    );
    const result = await observe(origin);
    expect(result.messageStructureObservation.messages[0].canonicalResources).toEqual([
      { path: '$["metadata"]["attachments"][0]["download_url"]', resourceId: id },
      { path: '$["metadata"]["invoked_resource"]["resource_uri"]', resourceId: id },
    ]);
    for (const message of result.messageStructureObservation.messages.slice(1))
      expect(message.canonicalResources).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(origin);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(state.requestClient.safeGet).toHaveBeenCalledTimes(1);
    expect(state.requestClient.request).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect((await observe()).messageStructureObservation.messages[0]).not.toHaveProperty(
      "canonicalResources",
    );
  });

  it("validates the optional resource origin within the exact fixed observation contract", () => {
    expect(
      isOracleChatGptServerApprovalScanExpression(
        expression("https://resource.example"),
        connectorId,
        "OmniCodex",
      ),
    ).toBe(true);
    for (const origin of [
      "https://resource.example/",
      "https://u:p@resource.example",
      "https://resource.example?x=1",
      "https://resource.example#x",
      "file://host",
      "https://RESOURCE.example",
      "invalid",
    ])
      expect(() => expression(origin)).toThrow("RESOURCE_ORIGIN_INVALID");
    expect(
      isOracleChatGptServerApprovalScanExpression(
        `${expression("https://resource.example")};fetch('/')`,
        connectorId,
        "OmniCodex",
      ),
    ).toBe(false);
  });

  it("retains the new typed projection through the attached client and rejects malformed state", async () => {
    const id = "A".repeat(43);
    seed(
      vi.fn(async () => ({
        current_node: "tool",
        messages: [
          {
            id: "tool",
            author: { role: "tool", name: "api_tool.call_tool" },
            status: "finished_successfully",
            end_turn: null,
            channel: "analysis",
            metadata: {
              attachments: [{ download_url: `https://resource.example/resources/${id}` }],
            },
          },
        ],
      })),
    );
    const observation = await observe("https://resource.example");
    const command = vi.fn(async (_method: string, params: { expression: string }) => ({
      result: {
        value:
          params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION
            ? true
            : {
                outcome: "ok",
                examined: 0,
                discovered: 0,
                approvalsPending: 0,
                conversationUrls: [],
                errors: [],
                receipts: [],
              },
      },
    }));
    const client = new OracleChatGptServerApprovalClient({
      connectorId,
      connectorName: "OmniCodex",
      cdpEndpoint: "http://127.0.0.1:9222",
      transport: {
        adoptOrOpenOwnedApprovalRuntimeTarget: vi.fn(async () => ({
          id: "runtime",
          url: oracleChatGptApprovalRuntimeUrl(connectorId),
        })),
      } as never,
      connectSession: vi.fn(async () => ({ command, close: vi.fn() })) as never,
    });
    const signal = new AbortController().signal;
    await client.scan(signal);
    command.mockResolvedValue({ result: { value: observation } });
    const result = await client.observeMessageStructure(
      `https://chatgpt.com/c/${conversationId}`,
      signal,
      { canonicalResourceOrigin: "https://resource.example" },
    );
    expect(result.messageStructureObservation).toEqual(observation.messageStructureObservation);
    observation.messageStructureObservation.currentMessage.isComplete = "true";
    await expect(
      client.observeMessageStructure(`https://chatgpt.com/c/${conversationId}`, signal),
    ).rejects.toThrow("ORACLE_MESSAGE_STRUCTURE_RESULT_INVALID");
  });
});
