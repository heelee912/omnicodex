import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatAccountRequestCoordinator } from "../src/application/chat-account-request-coordinator.js";
import type { BoundedCdpSession } from "../src/infrastructure/chatgpt/chatgpt-cdp-transport.js";
import {
  OracleChatGptServerApprovalClient,
  type OracleChatGptServerApprovalClientOptions,
} from "../src/infrastructure/chatgpt/oracle-chatgpt-server-approval-client.js";
import {
  ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION,
  ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION,
  oracleChatGptApprovalRuntimeUrl,
  oracleChatGptServerApprovalScanExpression,
} from "../src/infrastructure/chatgpt/oracle-chatgpt-server-approval-script.js";
import type { OracleConversationNotification } from "../src/infrastructure/chatgpt/oracle-conversation-event-source.js";
import {
  ORACLE_GOAL_CONVERSATION_SOURCE,
  parseOracleGoalConversation,
} from "../src/infrastructure/chatgpt/oracle-goal-conversation.js";
import { DirectGoalStore } from "../src/infrastructure/mcp/direct-goal-store.js";

// Execution correlation is random; retain exact comparison of all work arguments.
function withoutTelemetry(expression: unknown): unknown {
  return typeof expression === "string"
    ? expression
        .replace(/,"telemetryId":"[a-f0-9-]{36}"/gu, "")
        .replace(/"telemetryId":"[a-f0-9-]{36}",?/gu, "")
        .replace(/,\{\}\)$/u, ")")
    : expression;
}
expect.addEqualityTesters([
  (left, right) =>
    typeof left === "string" &&
    typeof right === "string" &&
    left.startsWith("(async function oracleChatGptServerApprovalScan") &&
    right.startsWith("(async function oracleChatGptServerApprovalScan")
      ? withoutTelemetry(left) === withoutTelemetry(right)
      : undefined,
]);

describe("Oracle approval runtime readiness", () => {
  it("reports native conversation activity independently of connector approval work", () => {
    const conversationId = "550e8400-e29b-41d4-a716-446655440000";
    const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
    const activity = vi.fn();
    const client = new OracleChatGptServerApprovalClient({
      connectorId: "asdk_app_activity",
      connectorName: "OmniCodex",
      cdpEndpoint: "http://127.0.0.1:9222",
      onConversationActivity: activity,
    });
    const frame = (notification: OracleConversationNotification) =>
      JSON.stringify({
        method: "Network.webSocketFrameReceived",
        params: {
          response: {
            opcode: 1,
            payloadData: JSON.stringify({
              type: "message",
              payload: {
                ...notification,
                payload: {
                  conversation_id: conversationId,
                  ...(notification.payload as Record<string, unknown>),
                },
              },
            }),
          },
        },
      });

    client.observeConversationFrame(
      conversationUrl,
      frame({
        type: "conversation-update",
        payload: {
          turn_id: "turn-active",
          update_content: {
            messages: [
              {
                id: "assistant-progress",
                author: { role: "assistant" },
                status: "in_progress",
                end_turn: false,
              },
            ],
          },
        },
      }),
    );
    client.observeConversationFrame(
      conversationUrl,
      frame({
        type: "conversation-turn-complete",
        payload: { turn_id: "turn-active" },
      }),
    );

    expect(activity.mock.calls).toEqual([
      [conversationUrl, "active"],
      [conversationUrl, "idle"],
    ]);
  });

  it("reports an authoritative deleted-conversation read for exact Goal cleanup", async () => {
    const connectorId = "asdk_app_deletedgoal";
    const conversationId = "550e8400-e29b-41d4-a716-446655440000";
    const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
    const accountSourceId = "chatgpt:account:deleted-goal";
    const onConversationDeleted = vi.fn(async () => {});
    const command = vi.fn(async (_method: string, params: { expression: string }) => {
      if (params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION)
        return { result: { value: true } };
      if (params.expression === ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION)
        return { result: { value: accountSourceId } };
      return {
        result: {
          value: {
            outcome: "partial",
            examined: 1,
            discovered: 0,
            approvalsPending: 0,
            conversationUrls: [],
            receipts: [],
            errors: [
              {
                conversationId,
                operation: "conversation_read",
                status: 404,
                error: "Conversation has been deleted. Start a new chat.",
              },
            ],
          },
        },
      };
    });
    const client = new OracleChatGptServerApprovalClient({
      connectorId,
      connectorName: "OmniCodex",
      cdpEndpoint: "http://127.0.0.1:9222",
      transport: {
        adoptOrOpenOwnedApprovalRuntimeTarget: async () => ({
          id: "deleted-goal",
          url: oracleChatGptApprovalRuntimeUrl(connectorId),
        }),
      } as never,
      connectSession: async () => ({ command, close: vi.fn(), isClosed: false }) as never,
      accountCooldown: {
        read: async () => undefined,
        observe: async () => {},
      },
      onConversationDeleted,
    });
    try {
      await expect(
        client.observeGoalConversation(conversationUrl, new AbortController().signal),
      ).resolves.toMatchObject({
        errors: [{ conversationId, operation: "conversation_read", status: 404 }],
      });
      expect(onConversationDeleted).toHaveBeenCalledExactlyOnceWith(
        conversationUrl,
        accountSourceId,
      );
    } finally {
      await client.stop();
    }
  });

  it("publishes auth absence and recovery without suppressing runtime authentication rechecks", async () => {
    const connectorId = "asdk_app_authlifecycle";
    const url = "https://chatgpt.com/c/550e8400-e29b-41d4-a716-446655440000";
    let authenticated = false;
    const setAuthenticationFailure = vi.fn();
    const command = vi.fn(async (_method: string, params: { expression: string }) => ({
      result: {
        value:
          params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION
            ? authenticated || "ORACLE_SERVER_APPROVAL_RUNTIME_AUTHENTICATION_REQUIRED"
            : {
                outcome: "ok",
                examined: 1,
                discovered: 0,
                approvalsPending: 0,
                conversationUrls: [],
                receipts: [],
                errors: [],
              },
      },
    }));
    const connect = vi.fn(async () => ({ command, close: vi.fn(), isClosed: false }) as never);
    const client = new OracleChatGptServerApprovalClient({
      connectorId,
      connectorName: "OmniCodex",
      cdpEndpoint: "http://127.0.0.1:9222",
      transport: {
        adoptOrOpenOwnedApprovalRuntimeTarget: async () => ({
          id: "auth",
          url: oracleChatGptApprovalRuntimeUrl(connectorId),
        }),
      } as never,
      connectSession: connect,
      conversationEvents: {
        ensureConnected: vi.fn(async () => false),
        stop: vi.fn(async () => {}),
        setAuthenticationFailure,
      },
    });
    try {
      const signal = new AbortController().signal;
      await expect(client.observeGoalConversation(url, signal)).rejects.toThrow(
        "RUNTIME_AUTHENTICATION_REQUIRED",
      );
      expect(setAuthenticationFailure).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: "ORACLE_SERVER_APPROVAL_RUNTIME_AUTHENTICATION_REQUIRED",
        }),
      );
      authenticated = true;
      await expect(client.observeGoalConversation(url, signal)).resolves.toMatchObject({
        outcome: "ok",
      });
      expect(connect).toHaveBeenCalledTimes(2);
      expect(setAuthenticationFailure).toHaveBeenLastCalledWith(undefined);
    } finally {
      await client.stop();
    }
  });

  it("replaces a stale adopted approval runtime before running any approval operation", async () => {
    const connectorId = "asdk_app_staleruntime";
    const conversationUrl = "https://chatgpt.com/c/550e8400-e29b-41d4-a716-446655440000";
    const staleTarget = {
      id: "stale-runtime",
      url: oracleChatGptApprovalRuntimeUrl(connectorId),
    };
    const replacementTarget = {
      id: "replacement-runtime",
      url: oracleChatGptApprovalRuntimeUrl(connectorId),
    };
    const closeOwnedTarget = vi.fn(async () => undefined);
    const openOwnedApprovalRuntimeTarget = vi.fn(async () => replacementTarget);
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
                receipts: [],
                errors: [],
              },
      },
    }));
    const replacementSession = { command, close: vi.fn(), isClosed: false };
    const connectSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("CDP command timeout:Runtime.enable"))
      .mockResolvedValueOnce(replacementSession);
    const client = new OracleChatGptServerApprovalClient({
      connectorId,
      connectorName: "OmniCodex",
      cdpEndpoint: "http://127.0.0.1:9222",
      transport: {
        adoptOrOpenOwnedApprovalRuntimeTarget: vi.fn(async () => staleTarget),
        closeOwnedTarget,
        openOwnedApprovalRuntimeTarget,
      } as never,
      connectSession,
    });

    try {
      client.requestScan(conversationUrl);
      await expect(client.scan(new AbortController().signal)).resolves.toMatchObject({
        outcome: "ok",
      });
      expect(connectSession.mock.calls.map(([, targetId]) => targetId)).toEqual([
        staleTarget.id,
        replacementTarget.id,
      ]);
      expect(closeOwnedTarget).toHaveBeenCalledExactlyOnceWith(
        staleTarget.id,
        expect.any(AbortSignal),
      );
      expect(openOwnedApprovalRuntimeTarget).toHaveBeenCalledOnce();
    } finally {
      await client.stop();
    }
  });

  it("replaces an adopted runtime whose readiness evaluation stops responding", async () => {
    const connectorId = "asdk_app_stalereadiness";
    const staleTarget = {
      id: "stale-readiness-runtime",
      url: oracleChatGptApprovalRuntimeUrl(connectorId),
    };
    const replacementTarget = {
      id: "replacement-readiness-runtime",
      url: oracleChatGptApprovalRuntimeUrl(connectorId),
    };
    const staleSession = {
      command: vi.fn(async () => {
        throw new Error("CDP command timeout:Runtime.evaluate");
      }),
      close: vi.fn(),
      isClosed: false,
    };
    const replacementSession = {
      command: vi.fn(async (_method: string, params: { expression: string }) => ({
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
                  receipts: [],
                  errors: [],
                },
        },
      })),
      close: vi.fn(),
      isClosed: false,
    };
    const closeOwnedTarget = vi.fn(async () => undefined);
    const client = new OracleChatGptServerApprovalClient({
      connectorId,
      connectorName: "OmniCodex",
      cdpEndpoint: "http://127.0.0.1:9222",
      transport: {
        adoptOrOpenOwnedApprovalRuntimeTarget: vi.fn(async () => staleTarget),
        closeOwnedTarget,
        openOwnedApprovalRuntimeTarget: vi.fn(async () => replacementTarget),
      } as never,
      connectSession: vi
        .fn()
        .mockResolvedValueOnce(staleSession)
        .mockResolvedValueOnce(replacementSession),
    });

    try {
      client.requestScan("https://chatgpt.com/c/550e8400-e29b-41d4-a716-446655440000");
      await expect(client.scan(new AbortController().signal)).resolves.toMatchObject({
        outcome: "ok",
      });
      expect(staleSession.close).toHaveBeenCalledOnce();
      expect(closeOwnedTarget).toHaveBeenCalledExactlyOnceWith(
        staleTarget.id,
        expect.any(AbortSignal),
      );
    } finally {
      await client.stop();
    }
  });

  it("keeps a live shared session after a scan timeout without replaying the failed scan", async () => {
    const connectorId = "asdk_app_timeoutisolation";
    const url = "https://chatgpt.com/c/550e8400-e29b-41d4-a716-446655440000";
    let closed = false;
    const timeout = new Error("CDP command timeout:Runtime.evaluate");
    const scanCalls = vi.fn(() => {
      throw timeout;
    });
    const observation = {
      outcome: "ok",
      examined: 1,
      discovered: 0,
      approvalsPending: 0,
      conversationUrls: [],
      receipts: [],
      errors: [],
    };
    const command = vi.fn(async (_method: string, params: { expression: string }) => {
      if (closed) throw new Error("CDP session closed");
      if (params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION)
        return { result: { value: true } };
      if (params.expression.includes('"observeGoalsOnly":true'))
        return { result: { value: observation } };
      return scanCalls();
    });
    const close = vi.fn(() => {
      closed = true;
    });
    const session = {
      command,
      close,
      get isClosed() {
        return closed;
      },
    };
    const connect = vi.fn().mockResolvedValue(session);
    const adopt = vi.fn(async () => ({
      id: "shared-live-runtime",
      url: oracleChatGptApprovalRuntimeUrl(connectorId),
    }));
    const client = new OracleChatGptServerApprovalClient({
      connectorId,
      connectorName: "OmniCodex",
      cdpEndpoint: "http://127.0.0.1:9222",
      transport: { adoptOrOpenOwnedApprovalRuntimeTarget: adopt } as never,
      connectSession: connect,
    });
    try {
      const signal = new AbortController().signal;
      client.requestScan(url);
      await expect(client.scan(signal)).rejects.toMatchObject({
        message: "ORACLE_SERVER_APPROVAL_SESSION_FAILED:CDP command timeout:Runtime.evaluate",
        cause: timeout,
      });
      expect(scanCalls).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      expect(session.isClosed).toBe(false);
      await expect(client.observeGoalConversation(url, signal)).resolves.toMatchObject(observation);
      expect(connect).toHaveBeenCalledOnce();
      expect(adopt).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      expect(scanCalls).toHaveBeenCalledOnce();
    } finally {
      await client.stop();
    }
  });

  it("reconnects a closed cached session without replaying its failed operation", async () => {
    const connectorId = "asdk_app_closedsession";
    const url = "https://chatgpt.com/c/550e8400-e29b-41d4-a716-446655440000";
    let closed = false;
    const healthy = {
      outcome: "ok",
      examined: 0,
      discovered: 0,
      approvalsPending: 0,
      conversationUrls: [],
      receipts: [],
      errors: [],
    };
    const firstCommand = vi.fn(async (_method: string, params: { expression: string }) => {
      if (params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION)
        return { result: { value: true } };
      closed = true;
      throw new Error("CDP session closed");
    });
    const secondCommand = vi.fn(async (_method: string, params: { expression: string }) => ({
      result: {
        value:
          params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION ? true : healthy,
      },
    }));
    const firstSession = {
      command: firstCommand,
      close: vi.fn(),
      get isClosed() {
        return closed;
      },
    };
    const secondSession = { command: secondCommand, close: vi.fn(), isClosed: false };
    const connect = vi
      .fn()
      .mockResolvedValueOnce(firstSession)
      .mockResolvedValueOnce(secondSession);
    const adopt = vi.fn(async () => ({
      id: "existing-runtime",
      url: oracleChatGptApprovalRuntimeUrl(connectorId),
    }));
    const client = new OracleChatGptServerApprovalClient({
      connectorId,
      connectorName: "OmniCodex",
      cdpEndpoint: "http://127.0.0.1:9222",
      transport: { adoptOrOpenOwnedApprovalRuntimeTarget: adopt } as never,
      connectSession: connect,
    });
    const signal = new AbortController().signal;
    await expect(client.observeGoalConversation(url, signal)).rejects.toThrow("CDP session closed");
    expect(connect).toHaveBeenCalledTimes(1);
    await expect(client.observeGoalConversation(url, signal)).resolves.toMatchObject(healthy);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(firstCommand).toHaveBeenCalledTimes(2);
    await client.observeGoalConversation(url, signal);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(firstSession.close).not.toHaveBeenCalled();
  });

  const evaluate = (readyState: string, text: string, pathname = "/api/auth/session") =>
    new Function(
      "document",
      "location",
      `return ${ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION}`,
    )({ readyState, body: { innerText: text } }, { origin: "https://chatgpt.com", pathname });

  it("waits only for loading and accepts a nonempty session credential without returning it", () => {
    expect(evaluate("loading", "")).toBe(false);
    expect(evaluate("interactive", "{}")).toBe(false);
    expect(evaluate("complete", "previous document", "/")).toBe(false);
    expect(evaluate("complete", JSON.stringify({ accessToken: "private" }))).toBe(true);
  });

  it.each(["{}", '{"expires":"future"}', '{"accessToken":""}', "null"])(
    "reports a completed unauthenticated session without its body: %s",
    (text) => {
      expect(evaluate("complete", text)).toBe(
        "ORACLE_SERVER_APPROVAL_RUNTIME_AUTHENTICATION_REQUIRED",
      );
    },
  );

  it("classifies completed invalid documents and authentication redirects without leaking text", () => {
    expect(evaluate("complete", "private error document")).toBe(
      "ORACLE_SERVER_APPROVAL_RUNTIME_SESSION_DOCUMENT_INVALID",
    );
    expect(evaluate("complete", "private error document", "/auth/error")).toBe(
      "ORACLE_SERVER_APPROVAL_RUNTIME_AUTHENTICATION_REQUIRED",
    );
  });

  it.each([
    "ORACLE_SERVER_APPROVAL_RUNTIME_AUTHENTICATION_REQUIRED",
    "ORACLE_SERVER_APPROVAL_RUNTIME_SESSION_DOCUMENT_INVALID",
  ])(
    "surfaces %s through the existing scan failure path without polling forever",
    async (error) => {
      const close = vi.fn();
      const command = vi.fn(async () => ({ result: { value: error } }));
      const connectorId = "asdk_app_readiness";
      const client = new OracleChatGptServerApprovalClient({
        connectorId,
        connectorName: "OmniCodex",
        cdpEndpoint: "http://127.0.0.1:9222",
        transport: {
          adoptOrOpenOwnedApprovalRuntimeTarget: vi.fn(async () => ({
            id: "existing-runtime",
            url: oracleChatGptApprovalRuntimeUrl(connectorId),
          })),
        } as never,
        connectSession: vi.fn(async () => ({ command, close })) as never,
      });
      await expect(client.scan(new AbortController().signal)).rejects.toThrow(error);
      expect(command).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    },
  );
});

describe("Oracle/Desktop shared account cooldown", () => {
  const url = "https://chatgpt.com/c/550e8400-e29b-41d4-a716-446655440000";
  const signal = new AbortController().signal;
  const target = {
    goalId: "550e8400-e29b-41d4-a716-446655440001",
    conversationUrl: url,
    operation: "inspect" as const,
    draft: { token: "dispatch", afterMessageId: "final", state: "dispatching" as const },
  };
  const healthy = () => ({
    outcome: "ok",
    examined: 0,
    discovered: 0,
    approvalsPending: 0,
    conversationUrls: [],
    receipts: [],
    errors: [],
  });
  function fixture(
    coordinator: ChatAccountRequestCoordinator,
    initialAccount = "chatgpt:A:U",
    options: Partial<OracleChatGptServerApprovalClientOptions> = {},
    sharedCooldown = true,
  ) {
    let account = initialAccount;
    const execute = vi.fn<() => Promise<Record<string, unknown>>>(async () => healthy());
    const command = vi.fn(async (_method: string, params: { expression: string }) => ({
      result: {
        value:
          params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION
            ? true
            : params.expression === ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION
              ? account
              : await execute(),
      },
    }));
    const observe = vi.fn(
      (id: string, snapshot: { observedAtUnixMs: number; retryAtUnixMs: number }) =>
        coordinator.observeCooldown(id, snapshot),
    );
    const connectorId = "asdk_app_sharedcooldown";
    const client = new OracleChatGptServerApprovalClient({
      connectorId,
      connectorName: "OmniCodex",
      cdpEndpoint: "http://127.0.0.1:9222",
      ...(sharedCooldown
        ? {
            accountCooldown: {
              read: (id: string) => coordinator.readCooldown(id),
              observe,
              reserveBackgroundRequest: (id: string, minimumIntervalMs: number) =>
                coordinator.reserveBackgroundRequest(id, minimumIntervalMs),
            },
          }
        : {}),
      transport: {
        adoptOrOpenOwnedApprovalRuntimeTarget: vi.fn(async () => ({
          id: "runtime",
          url: oracleChatGptApprovalRuntimeUrl(connectorId),
        })),
      } as never,
      connectSession: vi.fn(async () => ({ command, close: vi.fn() })) as never,
      ...options,
    });
    return {
      client,
      execute,
      command,
      observe,
      setAccount: (value: string) => {
        account = value;
      },
    };
  }
  afterEach(() => vi.useRealTimers());

  it.each([
    "approval scan",
    "Goal observation",
    "activity observation",
    "message structure",
    "Goal continuation",
    "bound Goal continuation",
  ])(
    "does not dispatch %s after the account changes while admission is pending",
    async (operation) => {
      let admit!: (value: { admitted: boolean; retryAtUnixMs: number }) => void;
      let holdReservation = false;
      const reserve = vi.fn(async () => {
        if (!holdReservation) return { admitted: true, retryAtUnixMs: Date.now() };
        return new Promise<{ admitted: boolean; retryAtUnixMs: number }>((resolve) => {
          admit = resolve;
        });
      });
      const f = fixture(new ChatAccountRequestCoordinator({ spacingMs: 0 }), "chatgpt:A:U", {
        accountCooldown: {
          read: async () => undefined,
          observe: async () => {},
          reserveForegroundRequest: reserve,
          reserveRecoveryRequest: reserve,
          reserveGoalContinuationRequest: reserve,
        },
      });
      try {
        // Message-structure reads require an already attached runtime.
        if (operation === "message structure") await f.client.continueGoal(target, signal);
        f.execute.mockClear();
        reserve.mockClear();
        holdReservation = true;
        const pending =
          operation === "approval scan"
            ? f.client.scan(signal)
            : operation === "message structure"
              ? f.client.observeMessageStructure(url, signal)
              : operation === "Goal continuation" || operation === "bound Goal continuation"
                ? f.client.continueGoal(
                    operation === "bound Goal continuation"
                      ? { ...target, accountSourceId: "chatgpt:A:U" }
                      : target,
                    signal,
                  )
                : f.client.observeGoalConversation(url, signal, {
                    publishObservation: operation !== "activity observation",
                  });
        await vi.waitFor(() => expect(reserve).toHaveBeenCalledOnce());
        f.setAccount("chatgpt:B:V");
        const outcome =
          operation === "Goal continuation" || operation === "bound Goal continuation"
            ? expect(pending).resolves.toMatchObject({ outcome: "account_source_mismatch" })
            : expect(pending).rejects.toThrow("ORACLE_CHATGPT_ACCOUNT_SOURCE_CHANGED");
        admit({ admitted: true, retryAtUnixMs: Date.now() });
        await outcome;
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.client.accountSourceId).toBe("chatgpt:B:V");
      } finally {
        await f.client.stop();
      }
    },
  );

  it("paces automated Goal continuation through the shared account recovery budget", async () => {
    const reserveGoalContinuationRequest = vi
      .fn<() => Promise<{ admitted: boolean; retryAtUnixMs: number }>>()
      .mockResolvedValueOnce({ admitted: false, retryAtUnixMs: Date.now() + 120_000 })
      .mockResolvedValueOnce({ admitted: true, retryAtUnixMs: Date.now() + 120_000 });
    const f = fixture(new ChatAccountRequestCoordinator({ spacingMs: 0 }), "chatgpt:A:U", {
      accountCooldown: {
        read: async () => undefined,
        observe: async () => {},
        reserveGoalContinuationRequest,
      },
    });
    try {
      await expect(f.client.continueGoal(target, signal)).resolves.toEqual({
        outcome: "rate_limited",
      });
      expect(f.execute).not.toHaveBeenCalled();
      await expect(f.client.continueGoal(target, signal)).resolves.toMatchObject({ outcome: "ok" });
      expect(f.execute).toHaveBeenCalledOnce();
      expect(reserveGoalContinuationRequest).toHaveBeenCalledTimes(2);
      expect(reserveGoalContinuationRequest).toHaveBeenNthCalledWith(
        1,
        "chatgpt:A:U",
        120_000,
        signal,
      );
    } finally {
      await f.client.stop();
    }
  });

  it("queues a known Goal account before opening the CDP session", async () => {
    let admit!: (value: { admitted: boolean; retryAtUnixMs: number }) => void;
    const reserveGoalContinuationRequest = vi.fn(
      () =>
        new Promise<{ admitted: boolean; retryAtUnixMs: number }>((resolve) => {
          admit = resolve;
        }),
    );
    const f = fixture(new ChatAccountRequestCoordinator({ spacingMs: 0 }), "chatgpt:A:U", {
      accountCooldown: {
        read: async () => undefined,
        observe: async () => {},
        reserveGoalContinuationRequest,
      },
    });
    try {
      const pending = f.client.continueGoal({ ...target, accountSourceId: "chatgpt:A:U" }, signal);
      await vi.waitFor(() => expect(reserveGoalContinuationRequest).toHaveBeenCalledOnce());
      expect(f.command).not.toHaveBeenCalled();
      admit({ admitted: true, retryAtUnixMs: Date.now() + 120_000 });
      await expect(pending).resolves.toMatchObject({ outcome: "ok" });
      expect(reserveGoalContinuationRequest).toHaveBeenCalledOnce();
      expect(f.execute).toHaveBeenCalledOnce();
    } finally {
      await f.client.stop();
    }
  });

  it("shares and paces an exact Goal observation through the account recovery budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const retryAtUnixMs = 1_120_000;
    const reserveRecoveryRequest = vi
      .fn<() => Promise<{ admitted: boolean; retryAtUnixMs: number }>>()
      .mockResolvedValueOnce({ admitted: false, retryAtUnixMs })
      .mockResolvedValueOnce({ admitted: true, retryAtUnixMs });
    const f = fixture(new ChatAccountRequestCoordinator({ spacingMs: 0 }), "chatgpt:A:U", {
      accountCooldown: {
        read: async () => undefined,
        observe: async () => {},
        reserveRecoveryRequest,
      },
    });
    try {
      const first = f.client.observeGoalConversation(url, signal);
      const shared = f.client.observeGoalConversation(url, signal);
      await expect(first).resolves.toMatchObject({
        followUpScanRequired: true,
        nextScanAtUnixMs: retryAtUnixMs,
      });
      await expect(shared).resolves.toMatchObject({
        followUpScanRequired: true,
        nextScanAtUnixMs: retryAtUnixMs,
      });
      expect(reserveRecoveryRequest).toHaveBeenCalledOnce();
      expect(f.execute).not.toHaveBeenCalled();

      vi.setSystemTime(retryAtUnixMs);
      await expect(f.client.observeGoalConversation(url, signal)).resolves.toMatchObject({
        outcome: "ok",
      });
      expect(reserveRecoveryRequest).toHaveBeenCalledTimes(2);
      expect(f.execute).toHaveBeenCalledOnce();
      const scanCall = f.command.mock.calls.find(
        ([, params]) =>
          params.expression !== ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION &&
          params.expression !== ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION,
      );
      expect((scanCall as unknown as unknown[])?.[3]).toBe(180_000);
    } finally {
      await f.client.stop();
    }
  });

  it("lets an activity-only Goal observation bypass the durable Goal consumer", async () => {
    const onGoalConversations = vi.fn(async () => {
      throw new Error("DIRECT_GOAL_CONVERSATION_AMBIGUOUS");
    });
    const reserveForegroundRequest = vi.fn(async () => ({
      admitted: true,
      retryAtUnixMs: Date.now() + 120_000,
    }));
    const reserveRecoveryRequest = vi.fn(async () => ({
      admitted: true,
      retryAtUnixMs: Date.now(),
    }));
    const f = fixture(new ChatAccountRequestCoordinator({ spacingMs: 0 }), "chatgpt:A:U", {
      onGoalConversations,
      accountCooldown: {
        read: async () => undefined,
        observe: async () => {},
        reserveForegroundRequest,
        reserveRecoveryRequest,
      },
    });
    f.execute.mockResolvedValue({
      ...healthy(),
      goalConversations: [
        {
          conversationUrl: url,
          goals: [
            {
              messageId: "goal-result",
              toolName: "omnicodex__goal_create",
              goalId: "550e8400-e29b-41d4-a716-446655440001",
              state: "active",
              revision: 1,
              createdAtUnixMs: 1,
            },
          ],
          current: {
            id: "final",
            authorRole: "assistant",
            status: "finished_successfully",
            channel: "final",
            endTurn: true,
          },
        },
      ],
    });
    try {
      await expect(
        f.client.observeGoalConversation(url, signal, { publishObservation: false }),
      ).resolves.toMatchObject({
        goalConversations: [{ conversationUrl: url, current: { id: "final", endTurn: true } }],
      });
      expect(onGoalConversations).not.toHaveBeenCalled();
      expect(reserveRecoveryRequest).toHaveBeenCalledOnce();
      expect(reserveForegroundRequest).not.toHaveBeenCalled();
      await expect(f.client.observeGoalConversation(url, signal)).rejects.toThrow(
        "DIRECT_GOAL_CONVERSATION_AMBIGUOUS",
      );
      expect(onGoalConversations).toHaveBeenCalledOnce();
      expect(reserveForegroundRequest).toHaveBeenCalledOnce();
    } finally {
      await f.client.stop();
    }
  });

  it("paces an approval scan during account recovery without consuming its queued approval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const retryAtUnixMs = 1_120_000;
    const reserveRecoveryRequest = vi
      .fn<() => Promise<{ admitted: boolean; retryAtUnixMs: number }>>()
      .mockResolvedValueOnce({ admitted: false, retryAtUnixMs })
      .mockResolvedValueOnce({ admitted: true, retryAtUnixMs });
    const f = fixture(
      new ChatAccountRequestCoordinator({ spacingMs: 0 }),
      "chatgpt:A:U",
      {
        accountCooldown: {
          read: async () => undefined,
          observe: async () => {},
          reserveRecoveryRequest,
        },
      },
      false,
    );
    f.client.observeConversationFrame(
      url,
      JSON.stringify({
        method: "Network.webSocketFrameReceived",
        params: {
          response: {
            opcode: 1,
            payloadData: JSON.stringify({
              type: "message",
              payload: {
                type: "conversation-update",
                payload: {
                  conversation_id: new URL(url).pathname.slice(3),
                  messages: [
                    {
                      id: "pending",
                      metadata: {
                        jit_plugin_data: {
                          from_server: {
                            type: "confirm_action",
                            body: {
                              connector_id: "asdk_app_sharedcooldown",
                              actions: [
                                {
                                  type: "always_allow",
                                  always_allow: {
                                    type: "always_allow",
                                    target_message_id: "tool-result",
                                  },
                                },
                              ],
                            },
                          },
                        },
                      },
                    },
                  ],
                },
              },
            }),
          },
        },
      }),
    );
    try {
      await expect(f.client.scan(signal)).resolves.toMatchObject({
        followUpScanRequired: true,
        nextScanAtUnixMs: retryAtUnixMs,
      });
      expect(f.execute).not.toHaveBeenCalled();
      vi.setSystemTime(retryAtUnixMs);
      await expect(f.client.scan(signal)).resolves.toMatchObject({ outcome: "ok" });
      expect(f.execute).toHaveBeenCalledOnce();
      expect(reserveRecoveryRequest).toHaveBeenCalledTimes(2);
      expect(withoutTelemetry(f.command.mock.calls.at(-1)?.[1].expression)).toContain(
        '"pendingMessageId":"pending"',
      );
    } finally {
      await f.client.stop();
    }
  });

  it("shares only overlapping exact verified observations and keeps new work independent", async () => {
    const f = fixture(new ChatAccountRequestCoordinator({ spacingMs: 0 }));
    let release!: (value: Record<string, unknown>) => void;
    f.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const cancelled = new AbortController();
    try {
      const first = f.client.observeGoalConversation(url, cancelled.signal);
      await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
      const second = f.client.observeGoalConversation(url, signal);
      await vi.waitFor(() =>
        expect(
          f.command.mock.calls.filter(
            ([, params]) => params.expression === ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION,
          ).length,
        ).toBeGreaterThanOrEqual(2),
      );
      expect(f.execute).toHaveBeenCalledTimes(1);
      const failure = expect(first).rejects.toThrow("observer cancelled");
      cancelled.abort(new Error("observer cancelled"));
      await failure;
      release({ ...healthy(), goalConversations: [{ conversationUrl: url, goals: [] }] });
      expect(await second).toMatchObject({
        goalConversations: [{ conversationUrl: url, goals: [] }],
      });
      await f.client.observeGoalConversation(url, signal);
      expect(f.execute).toHaveBeenCalledTimes(2);

      f.execute.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const earlier = f.client.observeGoalConversation(url, signal);
      await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(3));
      // An exact new-work notification must not reuse the older pending read.
      f.client.requestScan(url);
      await f.client.observeGoalConversation(url, signal);
      expect(f.execute).toHaveBeenCalledTimes(4);
      release(healthy());
      await earlier;
    } finally {
      await f.client.stop();
    }
  });

  it("paces restored approval retries but admits a different pending approval immediately", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const f = fixture(
      new ChatAccountRequestCoordinator({ spacingMs: 0 }),
      "chatgpt:A:U",
      {},
      false,
    );
    const notify = (id: string) =>
      f.client.observeConversationFrame(
        url,
        JSON.stringify({
          method: "Network.webSocketFrameReceived",
          params: {
            response: {
              opcode: 1,
              payloadData: JSON.stringify({
                type: "message",
                payload: {
                  type: "conversation-update",
                  payload: {
                    conversation_id: new URL(url).pathname.slice(3),
                    messages: [
                      {
                        id,
                        metadata: {
                          jit_plugin_data: {
                            from_server: {
                              type: "confirm_action",
                              body: {
                                connector_id: "asdk_app_sharedcooldown",
                                actions: [
                                  {
                                    type: "always_allow",
                                    always_allow: {
                                      type: "always_allow",
                                      target_message_id: "tool-result",
                                    },
                                  },
                                ],
                              },
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              }),
            },
          },
        }),
      );
    f.execute.mockResolvedValueOnce({
      ...healthy(),
      nextScanAtUnixMs: 1_030_000,
      rateLimit: {
        status: 429,
        statusEvidence: "http_status",
        operation: "approval_scan",
        retryAtUnixMs: 1_030_000,
        localBackoffMs: 30_000,
        backoffSource: "local_backoff",
      },
    });
    try {
      await f.client.scan(signal);
      notify("pending-first");
      f.execute.mockRejectedValueOnce(new Error("CDP command timeout:Runtime.evaluate"));
      await expect(f.client.scan(signal)).rejects.toThrow("CDP command timeout:Runtime.evaluate");
      expect(f.execute).toHaveBeenCalledTimes(2);
      await f.client.scan(signal);
      expect(f.execute).toHaveBeenCalledTimes(2);
      notify("pending-first");
      await f.client.scan(signal);
      expect(f.execute).toHaveBeenCalledTimes(2);
      notify("pending-second");
      await f.client.scan(signal);
      expect(f.execute).toHaveBeenCalledTimes(3);
    } finally {
      await f.client.stop();
    }
  });

  it("retains a shorter shared server deadline when fresh approval skips local pacing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });
    const f = fixture(coordinator);
    f.execute.mockResolvedValueOnce({
      ...healthy(),
      nextScanAtUnixMs: 1_030_000,
      rateLimit: {
        status: 429,
        operation: "approval_scan",
        accountSourceId: "chatgpt:A:U",
        observedAtUnixMs: 1_000_000,
        retryAtUnixMs: 1_030_000,
        localBackoffMs: 30_000,
        backoffSource: "local_backoff",
      },
    });
    try {
      f.client.requestScan(url);
      await f.client.scan(signal);
      await coordinator.observeCooldown("chatgpt:A:U", {
        observedAtUnixMs: 1_000_000,
        retryAtUnixMs: 1_020_000,
        serverRetryAtUnixMs: 1_020_000,
      });
      f.client.observeConversationFrame(
        url,
        JSON.stringify({
          method: "Network.webSocketFrameReceived",
          params: {
            response: {
              opcode: 1,
              payloadData: JSON.stringify({
                type: "message",
                payload: {
                  type: "conversation-update",
                  payload: {
                    conversation_id: new URL(url).pathname.slice(3),
                    messages: [
                      {
                        id: "new-pending",
                        metadata: {
                          jit_plugin_data: {
                            from_server: {
                              type: "confirm_action",
                              body: {
                                connector_id: "asdk_app_sharedcooldown",
                                actions: [
                                  {
                                    type: "always_allow",
                                    always_allow: {
                                      type: "always_allow",
                                      target_message_id: "tool-result",
                                    },
                                  },
                                ],
                              },
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              }),
            },
          },
        }),
      );
      await f.client.scan(signal);
      expect(f.execute).toHaveBeenCalledTimes(1);
      vi.setSystemTime(1_020_000);
      await f.client.scan(signal);
      expect(f.execute).toHaveBeenCalledTimes(2);
    } finally {
      await f.client.stop();
    }
  });

  it("does not upgrade a shared headerless 429 fallback into a server deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });
    const first = fixture(coordinator);
    const sameAccount = fixture(coordinator);
    first.execute.mockResolvedValueOnce({
      ...healthy(),
      nextScanAtUnixMs: 1_030_000,
      rateLimit: {
        status: 429,
        operation: "approval_scan",
        accountSourceId: "chatgpt:A:U",
        observedAtUnixMs: 1_000_000,
        retryAtUnixMs: 1_030_000,
        localBackoffMs: 30_000,
        statusEvidence: "http_status",
        backoffSource: "local_backoff",
      },
    });
    try {
      first.client.requestScan(url);
      await first.client.scan(signal);
      expect(await coordinator.readCooldown("chatgpt:A:U")).toEqual({
        observedAtUnixMs: 1_000_000,
        retryAtUnixMs: 1_030_000,
      });
      sameAccount.client.observeConversationFrame(
        url,
        JSON.stringify({
          method: "Network.webSocketFrameReceived",
          params: {
            response: {
              opcode: 1,
              payloadData: JSON.stringify({
                type: "message",
                payload: {
                  type: "conversation-update",
                  payload: {
                    conversation_id: new URL(url).pathname.slice(3),
                    messages: [
                      {
                        id: "fresh-pending",
                        metadata: {
                          jit_plugin_data: {
                            from_server: {
                              type: "confirm_action",
                              body: {
                                connector_id: "asdk_app_sharedcooldown",
                                actions: [
                                  {
                                    always_allow: {
                                      target_message_id: "fresh-tool-result",
                                    },
                                  },
                                ],
                              },
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              }),
            },
          },
        }),
      );
      await sameAccount.client.scan(signal);
      expect(sameAccount.execute).toHaveBeenCalledOnce();
    } finally {
      await Promise.all([first.client.stop(), sameAccount.client.stop()]);
    }
  });

  it("restores historical Goal subscriptions without reading their transcripts across bindings", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });
    const recoveryOptions = () => ({
      conversationEvents: {
        ensureConnected: vi.fn(async () => true),
        stop: vi.fn(async () => {}),
      },
      recoverGoalConversations: vi.fn(async () => [url]),
    });
    const first = fixture(coordinator, "chatgpt:A:U", recoveryOptions());
    const second = fixture(coordinator, "chatgpt:A:U", recoveryOptions());
    try {
      await expect(first.client.scan(signal)).resolves.toMatchObject({ outcome: "ok" });
      expect(first.execute).toHaveBeenCalledOnce();
      expect(
        first.command.mock.calls.some(([, params]) =>
          params.expression.includes(new URL(url).pathname.slice(3)),
        ),
      ).toBe(true);

      await expect(second.client.scan(signal)).resolves.toMatchObject({
        outcome: "ok",
        examined: 0,
        followUpScanRequired: false,
      });
      expect(second.execute).toHaveBeenCalledOnce();
      expect(
        second.command.mock.calls.some(([, params]) =>
          params.expression.includes(new URL(url).pathname.slice(3)),
        ),
      ).toBe(true);

      await vi.advanceTimersByTimeAsync(120_000);
      await expect(second.client.scan(signal)).resolves.toMatchObject({ outcome: "ok" });
      expect(second.execute).toHaveBeenCalledOnce();
    } finally {
      await Promise.all([first.client.stop(), second.client.stop()]);
    }
  });

  it.each([
    { backoffSource: undefined, serverRetryAtUnixMs: undefined, sharedDeadline: undefined },
    { backoffSource: "local_backoff", serverRetryAtUnixMs: undefined, sharedDeadline: undefined },
    { backoffSource: undefined, serverRetryAtUnixMs: 1_020_000, sharedDeadline: 1_020_000 },
    { backoffSource: "local_backoff", serverRetryAtUnixMs: 1_020_000, sharedDeadline: 1_020_000 },
    {
      backoffSource: "server_retry_after",
      serverRetryAtUnixMs: undefined,
      sharedDeadline: 1_030_000,
    },
  ])(
    "shares only the server deadline for source $backoffSource and explicit deadline $serverRetryAtUnixMs",
    async ({ backoffSource, serverRetryAtUnixMs, sharedDeadline }) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      const f = fixture(new ChatAccountRequestCoordinator({ spacingMs: 0 }));
      f.execute.mockResolvedValueOnce({
        ...healthy(),
        rateLimit: {
          status: 429,
          operation: "approval_scan",
          accountSourceId: "chatgpt:A:U",
          observedAtUnixMs: 1_000_000,
          retryAtUnixMs: 1_030_000,
          localBackoffMs: 30_000,
          ...(backoffSource ? { backoffSource } : {}),
          ...(serverRetryAtUnixMs === undefined ? {} : { serverRetryAtUnixMs }),
        },
      });
      try {
        f.client.requestScan(url);
        await f.client.scan(signal);
        if (sharedDeadline === undefined) expect(f.observe).not.toHaveBeenCalled();
        else
          expect(f.observe).toHaveBeenCalledExactlyOnceWith("chatgpt:A:U", {
            observedAtUnixMs: 1_000_000,
            retryAtUnixMs: sharedDeadline,
            serverRetryAtUnixMs: sharedDeadline,
          });
      } finally {
        await f.client.stop();
      }
    },
  );

  it.each(["http_status", "error_text"] as const)(
    "shares local 429 only with HTTP evidence: %s",
    async (statusEvidence) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });
      const first = fixture(coordinator);
      const same = fixture(coordinator);
      const other = fixture(coordinator, "chatgpt:B:U");
      const rateLimit = {
        status: 429,
        operation: "goal_observation",
        accountSourceId: "chatgpt:A:U",
        observedAtUnixMs: 1_000_000,
        retryAtUnixMs: 1_030_000,
        localBackoffMs: 30_000,
        backoffSource: "local_backoff",
        statusEvidence,
      };
      first.execute.mockResolvedValueOnce({ ...healthy(), rateLimit });
      try {
        first.client.requestScan(url);
        await first.client.scan(signal);
        await same.client.observeGoalConversation(url, signal);
        await other.client.observeGoalConversation(url, signal);
        if (statusEvidence === "http_status") {
          expect(first.observe).toHaveBeenCalledExactlyOnceWith("chatgpt:A:U", {
            observedAtUnixMs: 1_000_000,
            retryAtUnixMs: 1_030_000,
          });
          expect(same.execute).not.toHaveBeenCalled();
        } else {
          expect(first.observe).not.toHaveBeenCalled();
          expect(same.execute).toHaveBeenCalledOnce();
        }
        expect(other.execute).toHaveBeenCalledOnce();
      } finally {
        await Promise.all([first.client.stop(), same.client.stop(), other.client.stop()]);
      }
    },
  );

  it("keeps a cached event failure's observation time until a new failure or recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const cached = new Error("CDP request timeout:GET:/json/list");
    let failure: Error | undefined = cached;
    const f = fixture(new ChatAccountRequestCoordinator(), "chatgpt:A:U", {
      conversationEvents: {
        ensureConnected: vi.fn(async () => {
          if (failure !== undefined) throw failure;
          return false;
        }),
        stop: vi.fn(async () => {}),
      },
    });
    const first = (await f.client.scan(signal)).errors[0];
    expect(first).toMatchObject({
      error: cached.message,
      operation: "conversation_event_stream",
      observedAtUnixMs: 1_000_000,
    });
    vi.setSystemTime(1_001_000);
    expect((await f.client.scan(signal)).errors[0]).toEqual(first);
    failure = new Error(cached.message);
    vi.setSystemTime(1_015_000);
    expect((await f.client.scan(signal)).errors[0]?.observedAtUnixMs).toBe(1_015_000);
    failure = undefined;
    expect((await f.client.scan(signal)).errors).toEqual([]);
    failure = cached;
    vi.setSystemTime(1_016_000);
    expect((await f.client.scan(signal)).errors[0]?.observedAtUnixMs).toBe(1_016_000);
    expect(f.execute).toHaveBeenCalledTimes(1);
    await f.client.stop();
  });

  it("announces the first verified account and changes only after shared cooldown has loaded", async () => {
    const requests = new ChatAccountRequestCoordinator({ spacingMs: 0 });
    const deadline = Date.now() + 60_000;
    await requests.observeCooldown("chatgpt:A:U", {
      observedAtUnixMs: Date.now(),
      retryAtUnixMs: deadline,
    });
    let loaded = false;
    const notified = vi.fn((_account: string) => {
      expect(loaded).toBe(true);
    });
    const f = fixture(requests, "chatgpt:A:U", {
      onAccountSourceVerified: notified,
      accountCooldown: {
        read: async (account) => {
          const value = await requests.readCooldown(account);
          loaded = true;
          return value;
        },
        observe: (account, snapshot) => requests.observeCooldown(account, snapshot),
      },
    });
    try {
      expect(await f.client.continueGoal(target, signal)).toMatchObject({
        outcome: "rate_limited",
        rateLimit: { retryAtUnixMs: deadline },
      });
      expect(notified.mock.calls).toEqual([["chatgpt:A:U"]]);
      await f.client.continueGoal(target, signal);
      expect(notified).toHaveBeenCalledTimes(1);
      loaded = false;
      f.setAccount("chatgpt:B:V");
      await f.client.continueGoal(target, signal);
      await f.client.continueGoal(target, signal);
      expect(notified.mock.calls).toEqual([["chatgpt:A:U"], ["chatgpt:B:V"]]);
      expect(f.execute).toHaveBeenCalledTimes(2);
    } finally {
      await f.client.stop();
    }
  });

  it("does not lose the first verification notification if shared cooldown loading fails once", async () => {
    const notified = vi.fn();
    const read = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error("cooldown read failed"));
    const f = fixture(new ChatAccountRequestCoordinator({ spacingMs: 0 }), "chatgpt:A:U", {
      onAccountSourceVerified: notified,
      accountCooldown: { read, observe: vi.fn(async () => {}) },
    });
    try {
      await expect(f.client.continueGoal(target, signal)).rejects.toThrow("cooldown read failed");
      expect(notified).not.toHaveBeenCalled();
      await f.client.continueGoal(target, signal);
      await f.client.continueGoal(target, signal);
      expect(notified).toHaveBeenCalledExactlyOnceWith("chatgpt:A:U");
    } finally {
      await f.client.stop();
    }
  });

  it("does not announce or relatch a stale account after a delayed cooldown read", async () => {
    const notified = vi.fn();
    let finish!: (value: { observedAtUnixMs: number; retryAtUnixMs: number }) => void;
    const read = vi.fn(async (account: string) =>
      account === "chatgpt:A:U"
        ? new Promise<{ observedAtUnixMs: number; retryAtUnixMs: number }>((resolve) => {
            finish = resolve;
          })
        : undefined,
    );
    const f = fixture(new ChatAccountRequestCoordinator({ spacingMs: 0 }), "chatgpt:A:U", {
      onAccountSourceVerified: notified,
      accountCooldown: { read, observe: vi.fn(async () => {}) },
    });
    try {
      const first = f.client.continueGoal(target, signal);
      await vi.waitFor(() => expect(read).toHaveBeenCalledWith("chatgpt:A:U"));
      f.setAccount("chatgpt:B:V");
      await f.client.continueGoal(target, signal);
      finish({ observedAtUnixMs: Date.now(), retryAtUnixMs: Date.now() + 60_000 });
      await first;
      expect(notified.mock.calls).toEqual([["chatgpt:B:V"]]);
      expect(f.client.accountSourceId).toBe("chatgpt:B:V");
      await f.client.continueGoal(target, signal);
      expect(f.execute).toHaveBeenCalledTimes(3);
    } finally {
      await f.client.stop();
    }
  });

  it("retries durable Goal recovery after a one-time principal failure without reconnecting", async () => {
    const recover = vi.fn(async (_account?: string) => [url]);
    const connected = vi.fn(async () => false).mockResolvedValueOnce(true);
    const f = fixture(new ChatAccountRequestCoordinator({ spacingMs: 0 }), "chatgpt:A:U", {
      recoverGoalConversations: recover,
      conversationEvents: { ensureConnected: connected, stop: vi.fn(async () => {}) } as never,
    });
    const original = f.command.getMockImplementation();
    if (!original) throw new Error("missing command fixture");
    let fail = true;
    f.command.mockImplementation(async (method, params) => {
      if (params.expression === ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION && fail) {
        fail = false;
        throw new Error("principal temporarily unavailable");
      }
      return original(method, params);
    });
    try {
      expect((await f.client.scan(signal)).errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ error: "principal temporarily unavailable" }),
        ]),
      );
      expect(recover).not.toHaveBeenCalled();
      await f.client.scan(signal);
      expect(recover).toHaveBeenCalledExactlyOnceWith("chatgpt:A:U");
      expect(
        f.command.mock.calls.some(([, params]) =>
          params.expression.includes(new URL(url).pathname.slice(3)),
        ),
      ).toBe(false);
      await f.client.scan(signal);
      expect(recover).toHaveBeenCalledTimes(1);
    } finally {
      await f.client.stop();
    }
  });

  it("retains recovery through callback failure and repeats it once after reconnection", async () => {
    const recover = vi
      .fn(async (_account?: string) => [url])
      .mockRejectedValueOnce(new Error("store temporarily unavailable"));
    const connected = vi.fn(async () => false).mockResolvedValueOnce(true);
    const f = fixture(new ChatAccountRequestCoordinator({ spacingMs: 0 }), "chatgpt:A:U", {
      recoverGoalConversations: recover,
      conversationEvents: { ensureConnected: connected, stop: vi.fn(async () => {}) } as never,
    });
    try {
      expect((await f.client.scan(signal)).errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ error: "store temporarily unavailable" }),
        ]),
      );
      await f.client.scan(signal);
      expect(recover).toHaveBeenCalledTimes(2);
      await f.client.scan(signal);
      expect(recover).toHaveBeenCalledTimes(2);
      connected.mockResolvedValueOnce(true);
      await f.client.scan(signal);
      expect(recover).toHaveBeenCalledTimes(3);
    } finally {
      await f.client.stop();
    }
  });

  it("does not apply stale account recovery and recovers the newly verified account", async () => {
    const bUrl = "https://chatgpt.com/c/550e8400-e29b-41d4-a716-446655440001";
    const recover = vi.fn(async (account?: string) => (account === "chatgpt:A:U" ? [url] : [bUrl]));
    const connected = vi.fn(async () => false).mockResolvedValueOnce(true);
    const f = fixture(new ChatAccountRequestCoordinator({ spacingMs: 0 }), "chatgpt:A:U", {
      recoverGoalConversations: recover,
      conversationEvents: { ensureConnected: connected, stop: vi.fn(async () => {}) } as never,
    });
    recover.mockImplementationOnce(async () => {
      f.setAccount("chatgpt:B:V");
      return [url];
    });
    try {
      expect((await f.client.scan(signal)).errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ error: "ORACLE_CHATGPT_ACCOUNT_SOURCE_CHANGED" }),
        ]),
      );
      expect(
        f.command.mock.calls.some(([, params]) =>
          params.expression.includes(new URL(url).pathname.slice(3)),
        ),
      ).toBe(false);
      await f.client.scan(signal);
      expect(recover.mock.calls.map(([account]) => account)).toEqual([
        "chatgpt:A:U",
        "chatgpt:B:V",
      ]);
      expect(
        f.command.mock.calls.some(([, params]) =>
          params.expression.includes(new URL(bUrl).pathname.slice(3)),
        ),
      ).toBe(false);
      await f.client.scan(signal);
      expect(recover).toHaveBeenCalledTimes(2);
    } finally {
      await f.client.stop();
    }
  });

  it("starts exact recovery again when another operation verifies a changed login", async () => {
    const recover = vi.fn(async (_account?: string) => []);
    const connected = vi.fn(async () => false).mockResolvedValueOnce(true);
    const f = fixture(new ChatAccountRequestCoordinator({ spacingMs: 0 }), "chatgpt:A:U", {
      recoverGoalConversations: recover,
      conversationEvents: { ensureConnected: connected, stop: vi.fn(async () => {}) } as never,
    });
    try {
      await f.client.scan(signal);
      f.setAccount("chatgpt:B:V");
      await f.client.continueGoal(target, signal);
      await f.client.scan(signal);
      expect(recover.mock.calls.map(([account]) => account)).toEqual([
        "chatgpt:A:U",
        "chatgpt:B:V",
      ]);
      await f.client.scan(signal);
      expect(recover).toHaveBeenCalledTimes(2);
    } finally {
      await f.client.stop();
    }
  });

  it("attributes Web observations and recovery/checkpoint callbacks to the verified principal", async () => {
    const recover = vi.fn(async (_account?: string) => [url]);
    const checkpoints = vi.fn(async (_account?: string) => []);
    const onGoals = vi.fn(async () => {});
    const f = fixture(new ChatAccountRequestCoordinator({ spacingMs: 0 }), "chatgpt:A:U", {
      recoverGoalConversations: recover,
      captureGoalCheckpoints: checkpoints,
      onGoalConversations: onGoals,
      conversationEvents: {
        ensureConnected: vi.fn(async () => true),
        stop: vi.fn(async () => {}),
      } as never,
    });
    f.execute.mockResolvedValue({
      ...healthy(),
      goalConversations: [{ conversationUrl: url, goals: [] }],
    });
    try {
      expect(f.client.accountSourceId).toBeUndefined();
      const result = await f.client.scan(signal);
      expect(f.client.accountSourceId).toBe("chatgpt:A:U");
      expect(recover).toHaveBeenCalledWith("chatgpt:A:U");
      expect(checkpoints).toHaveBeenCalledWith("chatgpt:A:U");
      expect(result.goalConversations?.[0]?.source).toEqual({
        kind: "web",
        accountSourceId: "chatgpt:A:U",
      });
      expect(onGoals).toHaveBeenCalledWith(result.goalConversations);
      expect(
        (await f.client.observeGoalConversation(url, signal)).goalConversations?.[0]?.source,
      ).toEqual({ kind: "web", accountSourceId: "chatgpt:A:U" });
    } finally {
      await f.client.stop();
    }
  });

  it("binds an unbound Goal from an exact activity read without duplicating its final draft", async () => {
    const store = DirectGoalStore.inMemory();
    const owner = "issuer\0owner\0client\0activity";
    const goal = await store.create({ authorizationBinding: owner, objective: "Continue work" });
    const onGoals = vi.fn(async (observations) => {
      for (const observation of observations) await store.observeConversation(observation);
    });
    const f = fixture(new ChatAccountRequestCoordinator({ spacingMs: 0 }), "chatgpt:A:U", {
      onGoalConversations: onGoals,
    });
    f.execute.mockResolvedValue({
      ...healthy(),
      goalConversations: [
        {
          conversationUrl: url,
          goals: [
            {
              messageId: "creation",
              toolName: "omnicodex__goal_create",
              goalId: goal.id,
              state: "active",
              revision: goal.revision,
              createdAtUnixMs: goal.createdAtUnixMs,
            },
          ],
          current: {
            id: "completed-final",
            ancestorMessageIds: ["creation"],
            authorRole: "assistant",
            status: "finished_successfully",
            channel: "final",
            endTurn: true,
          },
        },
      ],
    });
    try {
      expect(await store.pendingContinuations()).toHaveLength(0);
      await f.client.observeGoalConversation(url, signal);
      const first = await store.pendingContinuations();
      expect(first).toHaveLength(1);
      await f.client.observeGoalConversation(url, signal);
      expect(await store.pendingContinuations()).toEqual(first);
      expect(onGoals).toHaveBeenCalledTimes(2);
      expect((await store.get(owner, goal.id))?.continuation?.accountSourceId).toBe("chatgpt:A:U");
    } finally {
      await f.client.stop();
    }
  });

  it("returns account_source_mismatch before evaluating any Goal read/send script", async () => {
    const f = fixture(new ChatAccountRequestCoordinator({ spacingMs: 0 }));
    try {
      expect(
        await f.client.continueGoal({ ...target, accountSourceId: "chatgpt:B:V" }, signal),
      ).toEqual({ outcome: "account_source_mismatch" });
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.client.accountSourceId).toBe("chatgpt:A:U");
      await f.client.continueGoal({ ...target, accountSourceId: "chatgpt:A:U" }, signal);
      expect(f.execute).toHaveBeenCalledOnce();
    } finally {
      await f.client.stop();
    }
  });

  it("does not attach the previous principal when login changes during a Goal read", async () => {
    const f = fixture(new ChatAccountRequestCoordinator({ spacingMs: 0 }));
    f.execute.mockImplementationOnce(async () => {
      f.setAccount("chatgpt:B:V");
      return { ...healthy(), goalConversations: [{ conversationUrl: url, goals: [] }] };
    });
    try {
      await expect(f.client.observeGoalConversation(url, signal)).rejects.toThrow(
        "ORACLE_CHATGPT_ACCOUNT_SOURCE_CHANGED",
      );
      expect(f.client.accountSourceId).toBe("chatgpt:B:V");
    } finally {
      await f.client.stop();
    }
  });

  it("verifies an explicit target principal even without the shared cooldown adapter", async () => {
    const f = fixture(
      new ChatAccountRequestCoordinator({ spacingMs: 0 }),
      "chatgpt:A:U",
      {},
      false,
    );
    try {
      await f.client.continueGoal(target, signal);
      expect(f.client.accountSourceId).toBeUndefined();
      f.execute.mockClear();
      expect(
        await f.client.continueGoal({ ...target, accountSourceId: "chatgpt:B:V" }, signal),
      ).toEqual({ outcome: "account_source_mismatch" });
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.client.accountSourceId).toBe("chatgpt:A:U");
    } finally {
      await f.client.stop();
    }
  });

  it("honors a desktop deadline for every Oracle operation while another account proceeds", async () => {
    const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });
    const snapshot = { observedAtUnixMs: Date.now(), retryAtUnixMs: Date.now() + 60_000 };
    await coordinator.observeCooldown("chatgpt:A:U", snapshot);
    const a = fixture(coordinator);
    const b = fixture(coordinator, "chatgpt:B:V");
    try {
      a.client.requestScan(url);
      expect(await a.client.scan(signal)).toMatchObject({
        nextScanAtUnixMs: snapshot.retryAtUnixMs,
      });
      expect(await a.client.continueGoal(target, signal)).toMatchObject({
        outcome: "rate_limited",
        rateLimit: { retryAtUnixMs: snapshot.retryAtUnixMs },
      });
      expect(await a.client.observeGoalConversation(url, signal)).toMatchObject({
        nextScanAtUnixMs: snapshot.retryAtUnixMs,
      });
      expect(await a.client.observeMessageStructure(url, signal)).toMatchObject({
        nextScanAtUnixMs: snapshot.retryAtUnixMs,
      });
      expect(a.execute).not.toHaveBeenCalled();
      b.client.requestScan(url);
      await b.client.scan(signal);
      expect(b.execute).toHaveBeenCalledOnce();
      // Switching the same client also drops only the previous account latch.
      a.setAccount("chatgpt:B:V");
      await a.client.continueGoal(target, signal);
      expect(a.execute).toHaveBeenCalledOnce();
    } finally {
      await a.client.stop();
      await b.client.stop();
    }
  });

  it("publishes an attributed Oracle snapshot once semantically without extending duplicate observations", async () => {
    const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });
    const snapshot = { observedAtUnixMs: Date.now(), retryAtUnixMs: Date.now() + 60_000 };
    const a = fixture(coordinator);
    const duplicate = fixture(coordinator);
    const result = {
      ...healthy(),
      rateLimit: {
        status: 429,
        operation: "conversation_read",
        accountSourceId: "chatgpt:A:U",
        ...snapshot,
      },
      nextScanAtUnixMs: snapshot.retryAtUnixMs,
    };
    let resolveFirst!: (value: Record<string, unknown>) => void;
    let resolveSecond!: (value: Record<string, unknown>) => void;
    a.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    duplicate.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );
    try {
      const first = a.client.observeGoalConversation(url, signal);
      const second = duplicate.client.observeGoalConversation(url, signal);
      await vi.waitFor(() => expect(duplicate.execute).toHaveBeenCalledOnce());
      resolveFirst(result);
      await first;
      expect(await coordinator.readCooldown("chatgpt:A:U")).toEqual(snapshot);
      resolveSecond(result);
      await second;
      expect(await coordinator.readCooldown("chatgpt:A:U")).toEqual(snapshot);
      expect(await coordinator.readCooldown("chatgpt:B:V")).toBeUndefined();
      expect(a.observe).toHaveBeenCalledWith("chatgpt:A:U", snapshot);
      expect(duplicate.observe).toHaveBeenCalledWith("chatgpt:A:U", snapshot);
    } finally {
      await a.client.stop();
      await duplicate.client.stop();
    }
  });

  it("does not attribute a legacy renderer snapshot to the currently signed-in account", async () => {
    const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });
    const f = fixture(coordinator);
    f.execute.mockResolvedValueOnce({
      ...healthy(),
      rateLimit: {
        status: 429,
        operation: "conversation_read",
        observedAtUnixMs: Date.now(),
        retryAtUnixMs: Date.now() + 60_000,
      },
    });
    try {
      await f.client.observeGoalConversation(url, signal);
      expect(f.observe).not.toHaveBeenCalled();
      expect(await coordinator.readCooldown("chatgpt:A:U")).toBeUndefined();
    } finally {
      await f.client.stop();
    }
  });

  it("does not let a late account A result latch account B after the same client changes principal", async () => {
    const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });
    const f = fixture(coordinator);
    const snapshot = { observedAtUnixMs: Date.now(), retryAtUnixMs: Date.now() + 60_000 };
    let finishA!: (value: Record<string, unknown>) => void;
    f.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishA = resolve;
        }),
    );
    try {
      const pendingA = f.client.observeGoalConversation(url, signal);
      await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
      f.setAccount("chatgpt:B:V");
      await f.client.continueGoal(target, signal);
      finishA({
        ...healthy(),
        rateLimit: {
          status: 429,
          operation: "conversation_read",
          accountSourceId: "chatgpt:A:U",
          ...snapshot,
        },
        nextScanAtUnixMs: snapshot.retryAtUnixMs,
      });
      await pendingA;
      expect(await coordinator.readCooldown("chatgpt:A:U")).toEqual(snapshot);
      expect(await coordinator.readCooldown("chatgpt:B:V")).toBeUndefined();
      expect(await f.client.continueGoal(target, signal)).toEqual({ outcome: "ok" });
      expect(f.execute).toHaveBeenCalledTimes(3);
    } finally {
      await f.client.stop();
    }
  });
});

describe("OracleChatGptServerApprovalClient", () => {
  it("recovers an actual store causal checkpoint through a message-less native mapping node", async () => {
    vi.useFakeTimers();
    const connectorId = "asdk_app_causalempty";
    const conversationId = "550e8400-e29b-41d4-a716-446655440000";
    const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
    const owner = "issuer\0owner\0client\0isolated-causal";
    const store = DirectGoalStore.inMemory();
    const goal = await store.create({
      authorizationBinding: owner,
      idempotencyKey: "causal-empty-node-test",
      objective: "Continue isolated verification",
    });
    const project = new Function(`return (${ORACLE_GOAL_CONVERSATION_SOURCE})`)();
    const origin = {
      id: "goal-result",
      author: { role: "tool", name: "api_tool.call_tool" },
      status: "finished_successfully",
      metadata: {
        invoked_resource: {
          resource_uri: `/${connectorId}/link_test/omnicodex__goal_create`,
        },
      },
      content: { text: JSON.stringify(goal) },
    };
    const oldFinal = {
      id: "old-final",
      author: { role: "assistant" },
      status: "finished_successfully",
      end_turn: true,
      channel: "final",
      parent_id: origin.id,
    };
    const nextFinal = { ...oldFinal, id: "next-final", parent_id: undefined };
    const observe = (conversation: unknown) =>
      parseOracleGoalConversation(project(conversationId, conversation, connectorId));
    await store.observeConversation(
      observe({ current_node: oldFinal.id, messages: [origin, oldFinal] }),
    );
    const incomplete = observe({
      current_node: nextFinal.id,
      messages: [origin, oldFinal, nextFinal],
    });
    const exact = observe({
      current_node: nextFinal.id,
      mapping: {
        [nextFinal.id]: { parent: "empty-node", message: nextFinal },
        "empty-node": { parent: oldFinal.id, message: null },
        [oldFinal.id]: { parent: origin.id, message: oldFinal },
        [origin.id]: { parent: null, message: origin },
      },
    });
    const command = vi.fn(async (_method, params) => ({
      result: {
        value:
          params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION
            ? true
            : {
                outcome: "ok",
                examined: 1,
                discovered: 1,
                approvalsPending: 0,
                conversationUrls: [],
                receipts: [],
                errors: [],
                goalConversations: [
                  params.expression.includes('"observeGoalsOnly":true') ? exact : incomplete,
                ],
              },
      },
    }));
    const close = vi.fn();
    const client = new OracleChatGptServerApprovalClient({
      connectorId,
      connectorName: "OmniCodex",
      cdpEndpoint: "http://127.0.0.1:9222",
      captureGoalCheckpoints: () => store.continuationCheckpoints(),
      onGoalConversations: async (observations) => {
        for (const observation of observations) await store.observeConversation(observation);
      },
      transport: {
        adoptOrOpenOwnedApprovalRuntimeTarget: vi.fn(async () => ({
          id: "runtime",
          url: oracleChatGptApprovalRuntimeUrl(connectorId),
        })),
      } as never,
      connectSession: vi.fn(async () => ({ command, close })) as never,
    });
    try {
      const signal = new AbortController().signal;
      client.requestScan(conversationUrl);
      expect(await client.scan(signal)).toMatchObject({
        outcome: "partial",
        errors: [{ error: "DIRECT_GOAL_CAUSAL_READBACK_REQUIRED" }],
      });
      expect((await store.get(owner, goal.id))?.continuation?.pendingFinalMessageIds).toEqual([
        nextFinal.id,
      ]);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await client.scan(signal)).toMatchObject({ outcome: "ok" });
      const recovered = await store.get(owner, goal.id);
      expect(recovered?.continuation?.settledMessageId).toBe(nextFinal.id);
      expect(recovered?.continuation?.pendingFinalMessageIds).toBeUndefined();
      expect(recovered?.continuation?.draft?.afterMessageId).toBe(nextFinal.id);
      expect(close).not.toHaveBeenCalled();
      expect(command).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(120_000);
      await client.scan(signal);
      expect(command).toHaveBeenCalledTimes(3);
    } finally {
      await client.stop();
      vi.useRealTimers();
    }
  });
  it("retains a Goal send 429 deadline for every observer without changing the failed send result", async () => {
    vi.useFakeTimers();
    const connectorId = "asdk_app_goaldeadline";
    const conversationUrl = "https://chatgpt.com/c/550e8400-e29b-41d4-a716-446655440000";
    const retryAtUnixMs = Date.now() + 600_000;
    const command = vi.fn(async (_method, params) => ({
      result: {
        value:
          params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION
            ? true
            : {
                outcome: "send_rejected",
                error: "ORACLE_GOAL_SEND_HTTP_429",
                rateLimit: {
                  status: 429,
                  operation: "goal_send",
                  retryAtUnixMs,
                  observedAtUnixMs: Date.now(),
                  serverRetryAtUnixMs: retryAtUnixMs,
                  backoffSource: "server_retry_after",
                  responseHeaders: { "retry-after": "600", authorization: "not-forwarded" },
                },
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
    const target = {
      goalId: "550e8400-e29b-41d4-a716-446655440001",
      conversationUrl,
      operation: "send" as const,
      draft: { token: "dispatch", afterMessageId: "final", state: "dispatching" as const },
    };
    const signal = new AbortController().signal;
    try {
      expect(await client.continueGoal(target, signal)).toMatchObject({
        outcome: "send_rejected",
        error: "ORACLE_GOAL_SEND_HTTP_429",
        rateLimit: { status: 429, retryAtUnixMs, responseHeaders: { "retry-after": "600" } },
      });
      const calls = command.mock.calls.length;
      for (let attempt = 0; attempt < 2; attempt++) {
        client.requestScan(conversationUrl);
        for (const result of [
          await client.scan(signal),
          await client.observeGoalConversation(conversationUrl, signal),
          await client.observeMessageStructure(conversationUrl, signal),
        ]) {
          expect(result).toMatchObject({
            nextScanAtUnixMs: retryAtUnixMs,
            rateLimit: {
              status: 429,
              operation: "goal_send",
              retryAtUnixMs,
              responseHeaders: { "retry-after": "600" },
            },
          });
          expect(result.rateLimit?.responseHeaders?.authorization).toBeUndefined();
        }
        expect(await client.continueGoal(target, signal)).toMatchObject({
          outcome: "rate_limited",
          rateLimit: { retryAtUnixMs },
        });
      }
      expect(command).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(600_000);
      await client.continueGoal({ ...target, operation: "inspect" }, signal);
      expect(command).toHaveBeenCalledTimes(calls + 1);
    } finally {
      await client.stop();
      vi.useRealTimers();
    }
  });
  it("keeps the shared socket when a local Goal observer fails after successful readback", async () => {
    const connectorId = "asdk_app_sinkfailure";
    const close = vi.fn();
    const command = vi.fn(async (_method, params) => ({
      result: {
        value:
          params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION
            ? true
            : {
                outcome: "ok",
                examined: 1,
                discovered: 1,
                approvalsPending: 0,
                conversationUrls: [],
                receipts: [],
                errors: [],
                goalConversations: [
                  { conversationUrl: "https://chatgpt.com/c/conversation", goals: [] },
                ],
              },
      },
    }));
    const client = new OracleChatGptServerApprovalClient({
      connectorId,
      connectorName: "OmniCodex",
      cdpEndpoint: "http://127.0.0.1:9222",
      onGoalConversations: async () => {
        throw new Error("LOCAL_GOAL_STORE_WRITE_FAILED");
      },
      transport: {
        adoptOrOpenOwnedApprovalRuntimeTarget: async () => ({
          id: "runtime",
          url: oracleChatGptApprovalRuntimeUrl(connectorId),
        }),
      } as never,
      connectSession: (async () => ({ command, close })) as never,
    });
    try {
      client.requestScan("https://chatgpt.com/c/conversation");
      await expect(client.scan(new AbortController().signal)).rejects.toThrow(
        "LOCAL_GOAL_STORE_WRITE_FAILED",
      );
      expect(close).not.toHaveBeenCalled();
    } finally {
      await client.stop();
    }
  });

  it("rotates an unresolved causal read so another pending conversation can recover", async () => {
    vi.useFakeTimers();
    const connectorId = "asdk_app_causalfair";
    const ids = ["550e8400-e29b-41d4-a716-446655440000", "550e8400-e29b-41d4-a716-446655440001"];
    const observations = ids.map((id) => ({
      conversationUrl: `https://chatgpt.com/c/${id}`,
      goals: [],
    }));
    const command = vi.fn(async (_method, params) => {
      if (params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION)
        return { result: { value: true } };
      const causal = params.expression.includes('"observeGoalsOnly":true');
      const selected = causal
        ? observations.filter((_, i) => params.expression.includes(ids[i]))
        : observations;
      return {
        result: {
          value: {
            outcome: "ok",
            examined: selected.length,
            discovered: selected.length,
            approvalsPending: 0,
            conversationUrls: [],
            receipts: [],
            errors: [],
            goalConversations: selected,
          },
        },
      };
    });
    const sink = vi.fn(async (batch: readonly { conversationUrl: string }[]) => {
      if (batch.length > 1)
        throw new AggregateError(
          batch.map(() => new Error("DIRECT_GOAL_CAUSAL_READBACK_REQUIRED")),
        );
      if (batch[0]?.conversationUrl === observations[0]?.conversationUrl)
        throw new Error("DIRECT_GOAL_CAUSAL_READBACK_REQUIRED");
    });
    const close = vi.fn();
    const client = new OracleChatGptServerApprovalClient({
      connectorId,
      connectorName: "OmniCodex",
      cdpEndpoint: "http://127.0.0.1:9222",
      onGoalConversations: sink,
      transport: {
        adoptOrOpenOwnedApprovalRuntimeTarget: vi.fn(async () => ({
          id: "runtime",
          url: oracleChatGptApprovalRuntimeUrl(connectorId),
        })),
      } as never,
      connectSession: vi.fn(async () => ({ command, close })) as never,
    });
    try {
      const signal = new AbortController().signal;
      for (const observation of observations) client.requestScan(observation.conversationUrl);
      await client.scan(signal);
      await vi.advanceTimersByTimeAsync(120_000);
      await client.scan(signal);
      await vi.advanceTimersByTimeAsync(120_000);
      await client.scan(signal);
      expect(sink.mock.calls.map(([batch]) => batch.map((o) => o.conversationUrl))).toEqual([
        observations.map((o) => o.conversationUrl),
        [observations[0]?.conversationUrl],
        [observations[1]?.conversationUrl],
      ]);
      expect(close).not.toHaveBeenCalled();
    } finally {
      await client.stop();
      vi.useRealTimers();
    }
  });

  it("reads explicit Goal state immediately after causal failure while preserving the background retry schedule", async () => {
    vi.useFakeTimers();
    const connectorId = "asdk_app_causalread";
    const conversationId = "550e8400-e29b-41d4-a716-446655440000";
    const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
    const command = vi.fn(async (_method, params) => ({
      result: {
        value:
          params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION
            ? true
            : {
                outcome: "ok",
                examined: 1,
                discovered: 1,
                approvalsPending: 0,
                conversationUrls: [],
                receipts: [],
                errors: [],
                followUpScanRequired: false,
                goalConversations: [{ conversationUrl, goals: [] }],
              },
      },
    }));
    const sink = vi
      .fn()
      .mockRejectedValueOnce(new Error("DIRECT_GOAL_CAUSAL_READBACK_REQUIRED"))
      .mockResolvedValue(undefined);
    const close = vi.fn();
    const connectSession = vi.fn(async () => ({ command, close }));
    const client = new OracleChatGptServerApprovalClient({
      connectorId,
      connectorName: "OmniCodex",
      cdpEndpoint: "http://127.0.0.1:9222",
      onGoalConversations: sink,
      transport: {
        adoptOrOpenOwnedApprovalRuntimeTarget: vi.fn(async () => ({
          id: "runtime",
          url: oracleChatGptApprovalRuntimeUrl(connectorId),
        })),
      } as never,
      connectSession: connectSession as never,
    });
    try {
      const signal = new AbortController().signal;
      client.requestScan(conversationUrl);
      expect(await client.scan(signal)).toMatchObject({
        outcome: "partial",
        followUpScanRequired: true,
      });
      expect(close).not.toHaveBeenCalled();
      const callsBeforeRead = command.mock.calls.length;
      const explicit = await client.observeGoalConversation(conversationUrl, signal);
      expect(explicit.goalConversations).toEqual([{ conversationUrl, goals: [] }]);
      expect(command.mock.calls.length).toBe(callsBeforeRead + 1);
      expect(sink).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(119_000);
      await client.scan(signal);
      expect(sink).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await client.scan(signal);
      expect(sink).toHaveBeenCalledTimes(2);
      expect(connectSession).toHaveBeenCalledTimes(1);
      expect(withoutTelemetry(command.mock.calls.at(-1)?.[1].expression)).toBe(
        oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", [conversationId], [], {
          observeGoalsOnly: true,
        }),
      );
      await vi.advanceTimersByTimeAsync(120_000);
      await client.scan(signal);
      expect(sink).toHaveBeenCalledTimes(2);
    } finally {
      await client.stop();
      vi.useRealTimers();
    }
  });
  beforeEach(() => {
    const persisted = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => persisted.get(key) ?? null,
      setItem: (key: string, value: string) => persisted.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("preserves the event operation through a failed read and durable reconnect", async () => {
    vi.useFakeTimers();
    const connectorId = "asdk_app_eventrestore";
    const stateKey = `__omnicodexOracleServerApprovalV2:${connectorId}`;
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const requestClient = {
      safeGet: vi
        .fn()
        .mockRejectedValueOnce(new Error("connection lost"))
        .mockResolvedValue({
          current_node: "different-pending",
          messages: [
            {
              id: "different-pending",
              metadata: {
                jit_plugin_data: {
                  from_server: {
                    type: "confirm_action",
                    body: {
                      connector_id: connectorId,
                      actions: [
                        {
                          type: "always_allow",
                          always_allow: {
                            type: "always_allow",
                            target_message_id: "different-target",
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          ],
        }),
      request: vi.fn(),
    };
    const module = {};
    globals[stateKey] = { module, requestClient, handled: {}, inFlight: {}, drains: new Set() };
    try {
      const first = new Function(
        `return ${oracleChatGptServerApprovalScanExpression(
          connectorId,
          "OmniCodex",
          ["conversation"],
          [],
          {
            expectedApprovals: [
              {
                conversationId: "conversation",
                pendingMessageId: "event-pending",
                targetMessageIds: ["event-target"],
              },
            ],
          },
        )}`,
      );
      expect(await first()).toMatchObject({ outcome: "partial", followUpScanRequired: true });
      const persisted = JSON.parse(localStorage.getItem(stateKey) ?? "null");
      expect(persisted.expectedApprovals.conversation).toEqual({
        "event-pending": ["event-target"],
      });
      delete globals[stateKey];
      // Restore the durable record into the same authenticated runtime after reconnect.
      globals[stateKey] = { ...persisted, module, requestClient, drains: new Set() };
      await vi.advanceTimersByTimeAsync(30_000);
      const recovery = new Function(
        `return ${oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex")}`,
      );
      expect(await recovery()).toMatchObject({ approvalsPending: 0, followUpScanRequired: false });
      expect(requestClient.safeGet).toHaveBeenCalledTimes(2);
      expect(requestClient.request).not.toHaveBeenCalled();
    } finally {
      delete globals[stateKey];
      vi.useRealTimers();
    }
  });

  it("ignores unrelated events and idle ticks, then approves only the event's exact operation once", async () => {
    vi.useFakeTimers();
    const connectorId = "asdk_app_exactevent";
    const conversationId = "550e8400-e29b-41d4-a716-446655440000";
    const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
    const stateKey = `__omnicodexOracleServerApprovalV2:${connectorId}`;
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    let committed: unknown;
    let notify: (url: string, notification?: OracleConversationNotification) => void = () => {};
    const confirmation = (target: string, connector = connectorId) => ({
      id: "pending",
      metadata: {
        jit_plugin_data: {
          from_server: {
            type: "confirm_action",
            body: {
              connector_id: connector,
              actions: [
                {
                  type: "always_allow",
                  always_allow: { type: "always_allow", target_message_id: target },
                },
              ],
            },
          },
        },
      },
    });
    const requestClient = {
      safeGet: vi.fn(async (_path: string) => ({
        current_node: "pending",
        messages: [
          { id: "target", metadata: { connector_id: connectorId } },
          confirmation("target"),
          ...(committed ? [committed] : []),
        ],
      })),
      request: vi.fn(async (_method, _path, options) => {
        committed = options.requestBody.messages.at(-1);
        return { status: 200 };
      }),
    };
    globals[stateKey] = {
      module: {
        Eo: async () => ({}),
        Fo: async () => undefined,
        Ao: () => ({}),
        Uo: { getEnforcementToken: async () => "proof" },
        zo: { getEnforcementToken: async () => "turnstile" },
      },
      requestClient,
      handled: {},
      inFlight: {},
      drains: new Set(),
    };
    const command = vi.fn(async (_method, params) => ({
      result: {
        value:
          params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION
            ? true
            : await new Function(`return ${params.expression}`)(),
      },
    }));
    const client = new OracleChatGptServerApprovalClient({
      connectorId,
      connectorName: "OmniCodex",
      cdpEndpoint: "http://127.0.0.1:9222",
      conversationEvents: {
        ensureConnected: async (callback) => {
          notify = callback;
          return false;
        },
        stop: async () => {},
      },
      transport: {
        adoptOrOpenOwnedApprovalRuntimeTarget: async () => ({
          id: "runtime",
          url: oracleChatGptApprovalRuntimeUrl(connectorId),
        }),
      } as never,
      connectSession: async () => ({ command, close: vi.fn() }) as never,
    });
    const signal = new AbortController().signal;
    const event = (target: string, connector = connectorId): OracleConversationNotification => ({
      type: "conversation-update",
      payload: { update_content: { messages: [confirmation(target, connector)] } },
    });
    try {
      await client.scan(signal);
      const initialCommands = command.mock.calls.length;
      for (let i = 0; i < 20; i++) {
        notify(
          "https://chatgpt.com/c/550e8400-e29b-41d4-a716-446655440001",
          event("target", "asdk_app_foreign"),
        );
        notify(conversationUrl, { type: "conversation-turn-complete", payload: {} });
        await vi.advanceTimersByTimeAsync(30_000);
        await client.scan(signal);
      }
      expect(command).toHaveBeenCalledTimes(initialCommands);
      expect(requestClient.safeGet).not.toHaveBeenCalled();
      const nativeFrame = JSON.stringify({
        method: "Network.webSocketFrameReceived",
        params: {
          response: {
            opcode: 1,
            payloadData: JSON.stringify({
              type: "message",
              payload: {
                ...event("target"),
                payload: { conversation_id: conversationId, messages: [confirmation("target")] },
              },
            }),
          },
        },
      });
      client.observeConversationFrame(
        "https://chatgpt.com/c/550e8400-e29b-41d4-a716-446655440001",
        nativeFrame,
      );
      await client.scan(signal);
      expect(command).toHaveBeenCalledTimes(initialCommands);
      notify(conversationUrl, event("stale-target"));
      await client.scan(signal);
      expect(requestClient.safeGet).toHaveBeenCalledTimes(1);
      expect(requestClient.request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      client.observeConversationFrame(conversationUrl, nativeFrame);
      const approved = await client.scan(signal);
      expect(approved.receipts).toHaveLength(1);
      expect(approved.receipts[0]).toMatchObject({
        conversationId,
        pendingMessageId: "pending",
        targetMessageId: "target",
      });
      expect(requestClient.request).toHaveBeenCalledTimes(1);
      expect(
        requestClient.safeGet.mock.calls.every(
          (args) => args[0] === `/conversations/${conversationId}`,
        ),
      ).toBe(true);
      client.acknowledgeReceipts(approved.receipts);
      await vi.advanceTimersByTimeAsync(30_000);
      await client.scan(signal);
      const completedCommands = command.mock.calls.length;
      const completedGets = requestClient.safeGet.mock.calls.length;
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
        await client.scan(signal);
      }
      expect(command).toHaveBeenCalledTimes(completedCommands);
      expect(requestClient.safeGet).toHaveBeenCalledTimes(completedGets);
      expect(requestClient.request).toHaveBeenCalledTimes(1);
    } finally {
      await client.stop();
      delete globals[stateKey];
      vi.useRealTimers();
    }
  });

  it("restores verified active Goal subscriptions without passive transcript reads", async () => {
    const conversationId = "550e8400-e29b-41d4-a716-446655440000";
    const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
    let connected = true;
    let notify: (url: string, notification?: OracleConversationNotification) => void = () => {};
    const recover = vi.fn(async () => [conversationUrl, conversationUrl]);
    const command = vi.fn(async (_method, params) => ({
      result: {
        value:
          params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION
            ? true
            : {
                outcome: "ok",
                examined: 1,
                discovered: 1,
                approvalsPending: 0,
                conversationUrls: [],
                receipts: [],
                errors: [],
                followUpScanRequired: false,
              },
      },
    }));
    const client = new OracleChatGptServerApprovalClient({
      connectorId: "asdk_app_recovery",
      connectorName: "OmniCodex",
      cdpEndpoint: "http://127.0.0.1:9222",
      recoverGoalConversations: recover,
      conversationEvents: {
        ensureConnected: async (callback) => {
          notify = callback;
          const changed = connected;
          connected = false;
          return changed;
        },
        stop: async () => {},
      },
      transport: {
        adoptOrOpenOwnedApprovalRuntimeTarget: vi.fn(async () => ({
          id: "runtime",
          url: oracleChatGptApprovalRuntimeUrl("asdk_app_recovery"),
        })),
      } as never,
      connectSession: vi.fn(async () => ({ command, close: vi.fn() })) as never,
    });
    try {
      const signal = new AbortController().signal;
      await client.scan(signal);
      expect(recover).toHaveBeenCalledTimes(1);
      const expression = command.mock.calls.at(-1)?.[1].expression;
      expect(withoutTelemetry(expression)).toBe(
        oracleChatGptServerApprovalScanExpression("asdk_app_recovery", "OmniCodex", [], [], {
          activeGoalConversationIds: [conversationId],
        }),
      );
      const count = command.mock.calls.length;
      for (let i = 0; i < 20; i += 1) await client.scan(signal);
      expect(command).toHaveBeenCalledTimes(count);
      expect(recover).toHaveBeenCalledTimes(1);
      notify("https://chatgpt.com/c/550e8400-e29b-41d4-a716-446655440001", {
        type: "conversation-turn-complete",
        payload: {},
      });
      await client.scan(signal);
      expect(command).toHaveBeenCalledTimes(count);
      notify(conversationUrl, { type: "conversation-turn-complete", payload: {} });
      await client.scan(signal);
      expect(command).toHaveBeenCalledTimes(count + 1);
      expect(withoutTelemetry(command.mock.calls.at(-1)?.[1].expression)).toBe(
        oracleChatGptServerApprovalScanExpression(
          "asdk_app_recovery",
          "OmniCodex",
          [conversationId],
          [],
          {
            activeGoalConversationIds: [conversationId],
            goalCompletionReceipts: [conversationId],
          },
        ),
      );
      notify(conversationUrl, {
        type: "conversation-update",
        payload: {
          update_content: {
            messages: [
              {
                id: "actual-final",
                author: { role: "assistant" },
                status: "finished_successfully",
                end_turn: true,
                channel: "final",
              },
            ],
          },
        },
      });
      await client.scan(signal);
      expect(command).toHaveBeenCalledTimes(count + 2);
      expect(withoutTelemetry(command.mock.calls.at(-1)?.[1].expression)).toBe(
        oracleChatGptServerApprovalScanExpression(
          "asdk_app_recovery",
          "OmniCodex",
          [conversationId],
          [],
          {
            activeGoalConversationIds: [conversationId],
            goalCompletionReceipts: [conversationId],
            goalCompletionFinalIds: { [conversationId]: ["actual-final"] },
          },
        ),
      );
      for (let duplicate = 0; duplicate < 3; duplicate++) {
        notify(conversationUrl, {
          type: "conversation-update",
          payload: {
            update_content: {
              messages: [
                {
                  id: "actual-final",
                  author: { role: "assistant" },
                  status: "finished_successfully",
                  end_turn: true,
                  channel: "final",
                },
              ],
            },
          },
        });
        await client.scan(signal);
      }
      expect(command).toHaveBeenCalledTimes(count + 2);
      connected = true;
      await client.scan(signal);
      expect(recover).toHaveBeenCalledTimes(4);
      expect(command).toHaveBeenCalledTimes(count + 2);
    } finally {
      await client.stop();
    }
  });

  it.each<OracleConversationNotification>([
    { type: "conversation-turn-complete", payload: {} },
    {
      type: "conversation-update",
      payload: {
        update_content: {
          messages: [
            {
              id: "unbound-final",
              author: { role: "assistant" },
              status: "finished_successfully",
              end_turn: true,
              channel: "final",
            },
          ],
        },
      },
    },
  ])(
    "uses exact $type events to bind an unbound Goal without idle or account reads",
    async (notification) => {
      const connectorId = "asdk_app_unboundgoal";
      const conversationId = "550e8400-e29b-41d4-a716-446655440000";
      const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
      let notify: (url: string, notification?: OracleConversationNotification) => void = () => {};
      const hasUnboundGoal = vi.fn(async () => false);
      const command = vi.fn(async (_method, params) => ({
        result: {
          value:
            params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION
              ? true
              : {
                  outcome: "ok",
                  examined: 1,
                  discovered: 1,
                  approvalsPending: 0,
                  conversationUrls: [],
                  receipts: [],
                  errors: [],
                  followUpScanRequired: false,
                },
        },
      }));
      const client = new OracleChatGptServerApprovalClient({
        connectorId,
        connectorName: "OmniCodex",
        cdpEndpoint: "http://127.0.0.1:9222",
        hasUnboundGoal,
        conversationEvents: {
          ensureConnected: async (callback) => {
            notify = callback;
            return false;
          },
          stop: async () => {},
        },
        transport: {
          adoptOrOpenOwnedApprovalRuntimeTarget: vi.fn(async () => ({
            id: "runtime",
            url: oracleChatGptApprovalRuntimeUrl(connectorId),
          })),
        } as never,
        connectSession: vi.fn(async () => ({ command, close: vi.fn() })) as never,
      });
      try {
        const signal = new AbortController().signal;
        await client.scan(signal);
        expect(hasUnboundGoal).not.toHaveBeenCalled();
        const initialized = command.mock.calls.length;
        for (const invalidField of [
          { author: { role: "user" } },
          { status: "in_progress" },
          { end_turn: false },
          { channel: "analysis" },
          { id: undefined },
        ]) {
          notify(conversationUrl, {
            type: "conversation-update",
            payload: {
              update_content: {
                messages: [
                  {
                    id: "unfinished-message",
                    author: { role: "assistant" },
                    status: "finished_successfully",
                    end_turn: true,
                    channel: "final",
                    ...invalidField,
                  },
                ],
              },
            },
          });
          await client.scan(signal);
          expect(hasUnboundGoal).not.toHaveBeenCalled();
          expect(command).toHaveBeenCalledTimes(initialized);
        }
        notify(conversationUrl, notification);
        await client.scan(signal);
        expect(command).toHaveBeenCalledTimes(initialized);
        hasUnboundGoal.mockResolvedValue(true);
        // Local active state alone never nominates a conversation to fetch.
        await client.scan(signal);
        expect(command).toHaveBeenCalledTimes(initialized);
        notify(conversationUrl, notification);
        await client.scan(signal);
        expect(withoutTelemetry(command.mock.calls.at(-1)?.[1].expression)).toBe(
          oracleChatGptServerApprovalScanExpression(
            connectorId,
            "OmniCodex",
            [conversationId],
            [],
            {
              goalCompletionReceipts: [conversationId],
            },
          ),
        );
        const count = command.mock.calls.length;
        await client.scan(signal);
        expect(command).toHaveBeenCalledTimes(count);
      } finally {
        await client.stop();
      }
    },
  );

  it("retains turn completion received before the first Goal result lookup finishes", async () => {
    const connectorId = "asdk_app_goalrace";
    const conversationId = "550e8400-e29b-41d4-a716-446655440000";
    const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
    let notify: (url: string, notification?: OracleConversationNotification) => void = () => {};
    const command = vi.fn(async (_method, params) => ({
      result: {
        value:
          params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION
            ? true
            : {
                outcome: "ok",
                examined: 1,
                discovered: 1,
                approvalsPending: 0,
                conversationUrls: [],
                receipts: [],
                errors: [],
                followUpScanRequired: false,
                goalConversations: [{ conversationUrl, goals: [] }],
              },
      },
    }));
    const client = new OracleChatGptServerApprovalClient({
      connectorId,
      connectorName: "OmniCodex",
      cdpEndpoint: "http://127.0.0.1:9222",
      conversationEvents: {
        ensureConnected: async (callback) => {
          notify = callback;
          return false;
        },
        stop: async () => {},
      },
      transport: {
        adoptOrOpenOwnedApprovalRuntimeTarget: vi.fn(async () => ({
          id: "runtime",
          url: oracleChatGptApprovalRuntimeUrl(connectorId),
        })),
      } as never,
      connectSession: vi.fn(async () => ({ command, close: vi.fn() })) as never,
    });
    try {
      const signal = new AbortController().signal;
      await client.scan(signal);
      notify(conversationUrl, {
        type: "conversation-update",
        payload: {
          messages: [
            {
              author: { role: "tool", name: "api_tool.call_tool" },
              metadata: {
                invoked_resource: {
                  resource_uri: `/${connectorId}/link_result/omnicodex__goal_create`,
                },
              },
            },
          ],
        },
      });
      notify(conversationUrl, { type: "conversation-turn-complete", payload: {} });
      await client.scan(signal);
      expect(withoutTelemetry(command.mock.calls.at(-1)?.[1].expression)).toBe(
        oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", [conversationId], [], {
          goalCompletionReceipts: [conversationId],
        }),
      );
      // An authoritative lookup with no active Goal removes the candidate.
      const count = command.mock.calls.length;
      notify(conversationUrl, { type: "conversation-turn-complete", payload: {} });
      await client.scan(signal);
      expect(command).toHaveBeenCalledTimes(count);
    } finally {
      await client.stop();
    }
  });

  it("reports storage failure, never submits an unpersisted intent, and still delivers a committed receipt", async () => {
    vi.useFakeTimers();
    const connectorId = "asdk_app_storagefailure";
    const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const persisted = new Map<string, string>();
    let failureStage = "intent";
    let committedMessage: unknown;
    vi.stubGlobal("localStorage", {
      getItem: (name: string) => persisted.get(name) ?? null,
      setItem: (name: string, value: string) => {
        const next = JSON.parse(value);
        if (
          (failureStage === "intent" && Object.keys(next.inFlight).length > 0) ||
          (failureStage === "receipt" && Object.keys(next.receiptOutbox).length > 0)
        ) {
          throw new DOMException("Storage quota exceeded", "QuotaExceededError");
        }
        persisted.set(name, value);
      },
    });
    const requestClient = {
      safeGet: vi.fn(async () => ({
        current_node: "pending",
        messages: [
          { id: "older-user", author: { role: "user" } },
          { id: "origin-user", author: { role: "user" } },
          { id: "target", metadata: { connector_name: "OmniCodex" } },
          {
            id: "pending",
            metadata: {
              jit_plugin_data: {
                from_server: {
                  type: "confirm_action",
                  body: {
                    actions: [
                      {
                        type: "always_allow",
                        always_allow: {
                          type: "always_allow",
                          target_message_id: "target",
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
          ...(committedMessage ? [committedMessage] : []),
        ],
      })),
      request: vi.fn(async (_method, _path, options) => {
        committedMessage = options.requestBody.messages.at(-1);
        return { status: 200 };
      }),
    };
    globals[key] = {
      module: {
        Eo: async () => ({}),
        Fo: async () => undefined,
        Ao: () => ({}),
        Uo: { getEnforcementToken: async () => "proof" },
        zo: { getEnforcementToken: async () => "turnstile" },
      },
      requestClient,
      handled: {},
      inFlight: {},
      drains: new Set(),
    };
    const scan = new Function(
      `return ${oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", ["conversation"])}`,
    ) as () => Promise<{
      outcome: string;
      receipts: Array<{ clientMessageId: string }>;
      errors: unknown[];
    }>;
    try {
      expect(await scan()).toMatchObject({
        outcome: "partial",
        receipts: [],
        errors: expect.arrayContaining([
          expect.objectContaining({
            operation: "approval_intent_persist",
            error: "ORACLE_APPROVAL_DURABILITY_UNAVAILABLE",
            submissionState: "rejected",
          }),
        ]),
      });
      expect(requestClient.request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await scan()).outcome).toBe("partial");
      expect(requestClient.request).not.toHaveBeenCalled();

      failureStage = "receipt";
      await vi.advanceTimersByTimeAsync(5_000);
      const committed = await scan();
      expect(committed).toMatchObject({
        outcome: "partial",
        errors: expect.arrayContaining([
          expect.objectContaining({
            operation: "oracle_state_persist",
            error: "ORACLE_APPROVAL_DURABILITY_UNAVAILABLE",
          }),
        ]),
      });
      expect(committed.receipts).toEqual([
        expect.objectContaining({ userMessageId: "origin-user" }),
      ]);
      expect(requestClient.request).toHaveBeenCalledOnce();
      expect((await scan()).receipts).toEqual(committed.receipts);
      expect(requestClient.request).toHaveBeenCalledOnce();
      const ack = new Function(
        `return ${oracleChatGptServerApprovalScanExpression(
          connectorId,
          "OmniCodex",
          [],
          committed.receipts.map((receipt) => receipt.clientMessageId),
        )}`,
      ) as typeof scan;
      expect((await ack()).receipts).toEqual([]);
      expect(JSON.parse(persisted.get(key) ?? "{}").receiptOutbox).toEqual({});
      expect(requestClient.request).toHaveBeenCalledOnce();
    } finally {
      delete globals[key];
      vi.useRealTimers();
    }
  });

  it("redelivers an unacknowledged receipt and retries an acknowledgement lost on CDP", async () => {
    vi.useFakeTimers();
    const connectorId = "asdk_app_receiptack";
    const receipt = {
      userMessageId: "origin-user",
      conversationId: "conversation",
      conversationUrl: "https://chatgpt.com/c/conversation",
      pendingMessageId: "pending",
      clientMessageId: "client",
      targetMessageId: "target",
      action: "always_allow" as const,
      rememberAnswer: true,
    };
    const ackExpression = oracleChatGptServerApprovalScanExpression(
      connectorId,
      "OmniCodex",
      [],
      ["client"],
    );
    let loseAck = true;
    const command = vi.fn(async (_method: string, params: { expression: string }) => {
      if (params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION)
        return { result: { value: true } };
      if (withoutTelemetry(params.expression) === ackExpression && loseAck) {
        loseAck = false;
        throw new Error("CDP_RESPONSE_LOST");
      }
      return {
        result: {
          value: {
            outcome: "ok",
            examined: 0,
            discovered: 0,
            approvalsPending: 0,
            followUpScanRequired: false,
            conversationUrls: [],
            errors: [],
            receipts: withoutTelemetry(params.expression) === ackExpression ? [] : [receipt],
          },
        },
      };
    });
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
    try {
      expect((await client.scan(signal)).receipts).toEqual([receipt]);
      // A failed sink does not ack. The next paced scan delivers the evidence again.
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await client.scan(signal)).receipts).toEqual([receipt]);
      client.acknowledgeReceipts([receipt]);
      await expect(client.scan(signal)).rejects.toThrow("CDP_RESPONSE_LOST");
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await client.scan(signal)).receipts).toEqual([]);
      expect(
        command.mock.calls.filter(
          ([, params]) => withoutTelemetry(params.expression) === ackExpression,
        ),
      ).toHaveLength(2);
    } finally {
      await client.stop();
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "queues real event identities and keeps explicit approvals working when event discovery fails=%s",
    async (failed) => {
      const conversationId = "550e8400-e29b-41d4-a716-446655440000";
      const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
      const stopEvents = vi.fn(async () => {});
      const command = vi.fn(async (_method, params) => ({
        result: {
          value:
            params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION
              ? true
              : {
                  outcome: "ok",
                  examined: 1,
                  discovered: 1,
                  approvalsPending: 0,
                  conversationUrls: [],
                  receipts: [],
                  errors: [],
                  followUpScanRequired: false,
                },
        },
      }));
      const client = new OracleChatGptServerApprovalClient({
        connectorId: "asdk_app_events",
        connectorName: "OmniCodex",
        cdpEndpoint: "http://127.0.0.1:9222",
        conversationEvents: {
          ensureConnected: async (callback) => {
            if (failed) throw new Error("event stream unavailable");
            callback(conversationUrl, {
              type: "conversation-update",
              payload: {
                messages: [
                  {
                    id: "approval",
                    metadata: {
                      jit_plugin_data: {
                        from_server: {
                          type: "confirm_action",
                          body: {
                            connector_id: "asdk_app_events",
                            actions: [{ type: "allow", allow: { target_message_id: "operation" } }],
                          },
                        },
                      },
                    },
                  },
                ],
              },
            });
            return false;
          },
          stop: stopEvents,
        },
        transport: {
          adoptOrOpenOwnedApprovalRuntimeTarget: vi.fn(async () => ({
            id: "runtime",
            url: oracleChatGptApprovalRuntimeUrl("asdk_app_events"),
          })),
        } as never,
        connectSession: vi.fn(async () => ({ command, close: vi.fn() })) as never,
      });
      if (failed) client.requestScan(conversationUrl);
      try {
        const result = await client.scan(new AbortController().signal);
        expect(command.mock.calls.at(-1)?.[1].expression).toContain(conversationId);
        expect(result.examined).toBe(1);
        expect(result.errors).toEqual(
          failed ? [expect.objectContaining({ operation: "conversation_event_stream" })] : [],
        );
      } finally {
        await client.stop();
      }
      expect(stopEvents).toHaveBeenCalledOnce();
    },
  );

  it("retains a fresh request for the same conversation while an earlier scan is reading", async () => {
    const connectorId = "asdk_app_concurrentwake";
    const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    let startRead: () => void = () => {};
    let finishRead: (value: { messages: unknown[] }) => void = () => {};
    const readStarted = new Promise<void>((resolve) => {
      startRead = resolve;
    });
    const readFinished = new Promise<{ messages: unknown[] }>((resolve) => {
      finishRead = resolve;
    });
    const requestClient = {
      safeGet: vi
        .fn()
        .mockImplementationOnce(() => {
          startRead();
          return readFinished;
        })
        .mockResolvedValue({ messages: [{ id: "settled", end_turn: true }] }),
      request: vi.fn(),
    };
    globals[key] = { module: {}, requestClient, handled: {}, inFlight: {} };
    vi.useFakeTimers();
    try {
      const run = new Function(
        `return ${oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", ["conversation"])}`,
      ) as () => Promise<{ followUpScanRequired: boolean }>;
      const earlier = run();
      await readStarted;
      expect(await run()).toMatchObject({ examined: 0, followUpScanRequired: true });
      finishRead({ messages: [] });
      expect(await earlier).toMatchObject({ followUpScanRequired: true });
      expect(requestClient.safeGet).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(5_000);
      const resume = new Function(
        `return ${oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex")}`,
      ) as typeof run;
      expect(await resume()).toMatchObject({ examined: 1, followUpScanRequired: false });
      expect(requestClient.safeGet).toHaveBeenCalledTimes(2);
      expect(requestClient.request).not.toHaveBeenCalled();
    } finally {
      finishRead({ messages: [] });
      delete globals[key];
      vi.useRealTimers();
    }
  });

  it.each(["user", "preamble", "commentary"])(
    "waits for a new approval event after a %s read and does not discover work with timers",
    async (initialMessage) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      const connectorId = "asdk_app_activeturn";
      const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
      const globals = globalThis as typeof globalThis & Record<string, unknown>;
      const user = {
        id: "user",
        author: { role: "user" },
        metadata: { connector_id: connectorId },
      };
      const intermediate = {
        id: "intermediate",
        author: { role: "assistant" },
        channel: "commentary",
        status: "finished_successfully",
        end_turn: initialMessage === "preamble",
        metadata:
          initialMessage === "preamble"
            ? { is_thinking_preamble_message: true, poll_interval_ms: 30_000 }
            : { is_complete: true },
      };
      const pending = {
        id: "pending",
        author: { role: "tool", name: "api_tool.call_tool" },
        metadata: {
          jit_plugin_data: {
            from_server: {
              type: "confirm_action",
              body: {
                connector_id: connectorId,
                actions: [{ type: "allow", allow: { target_message_id: "user" } }],
              },
            },
          },
        },
      };
      let phase = "running";
      let approved: unknown;
      const requestClient = {
        safeGet: vi.fn(async (path: string) => {
          if (path.endsWith("/other"))
            return { current_node: "final", messages: [{ id: "final", end_turn: true }] };
          return {
            current_node:
              phase === "running"
                ? initialMessage === "user"
                  ? "not-yet-hydrated-root"
                  : "intermediate"
                : approved
                  ? "final"
                  : "pending",
            messages: [
              user,
              ...(phase === "running" && initialMessage !== "user" ? [intermediate] : []),
              ...(phase === "running" ? [] : [pending]),
              ...(approved
                ? [
                    approved,
                    {
                      id: "final",
                      author: { role: "assistant" },
                      channel: "final",
                      end_turn: true,
                      metadata: { poll_interval_ms: 30_000 },
                    },
                  ]
                : []),
            ],
          };
        }),
        request: vi.fn(async (_method, _path, options) => {
          approved = options.requestBody.messages.at(-1);
          return { status: 200 };
        }),
      };
      const module = {
        Eo: async () => ({}),
        Fo: async () => undefined,
        Ao: () => ({}),
        Uo: { getEnforcementToken: async () => "proof" },
        zo: { getEnforcementToken: async () => "turnstile" },
      };
      globals[key] = { module, requestClient, handled: {}, inFlight: {}, drains: new Set() };
      const scan = (ids: string[] = [], acknowledgements: string[] = []) =>
        new Function(
          `return ${oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", ids, acknowledgements)}`,
        )();
      try {
        expect(await scan(["conversation"])).toMatchObject({
          followUpScanRequired: false,
          requestStats: { getCount: 1, postCount: 0 },
        });
        globals[key] = {
          ...JSON.parse(localStorage.getItem(key) ?? "null"),
          module,
          requestClient,
          drains: new Set(),
        };
        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(30_000);
          expect(await scan()).toMatchObject({
            followUpScanRequired: false,
            requestStats: { getCount: 0, postCount: 0 },
          });
        }
        phase = "pending";
        const recovered = await scan(["conversation"]);
        expect(recovered).toMatchObject({
          requestStats: { getCount: 3, postCount: 1, rateLimitCount: 0 },
          receipts: [{ responseStatus: 200 }],
        });
        expect(requestClient.request).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(
          await scan(
            [],
            recovered.receipts.map((r: { clientMessageId: string }) => r.clientMessageId),
          ),
        ).toMatchObject({
          followUpScanRequired: false,
          requestStats: { getCount: 0, postCount: 0 },
        });
        expect(JSON.parse(localStorage.getItem(key) ?? "null").activeConversationRecovery).toEqual(
          {},
        );
        expect(
          requestClient.safeGet.mock.calls.every(([path]) => path.startsWith("/conversations/")),
        ).toBe(true);
      } finally {
        delete globals[key];
        vi.useRealTimers();
      }
    },
  );

  it.each(["pending", "expected", "inflight", "receipt"])(
    "keeps mirror work for %s approvals alongside Goal completion recovery",
    async (kind) => {
      const connectorId = `asdk_app_completionmirror${kind}`;
      const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
      const globals = globalThis as typeof globalThis & Record<string, unknown>;
      const receipt = {
        conversationId: "conversation",
        conversationUrl: "https://chatgpt.com/c/conversation",
        pendingMessageId: "approval",
        clientMessageId: "client",
        targetMessageId: "target",
        action: "allow",
        rememberAnswer: true,
      };
      const requestClient = {
        safeGet: vi.fn(async () => ({
          current_node: "working",
          messages: [
            {
              id: "working",
              author: { role: "assistant" },
              status: "in_progress",
              metadata: {
                connector_id: connectorId,
                ...(kind === "pending"
                  ? {
                      jit_plugin_data: {
                        from_server: { type: "confirm_action", body: { actions: [] } },
                      },
                    }
                  : {}),
              },
            },
          ],
        })),
        request: vi.fn(),
      };
      globals[key] = {
        module: {},
        requestClient,
        handled: {},
        inFlight: kind === "inflight" ? { approval: receipt } : {},
        receiptOutbox: kind === "receipt" ? { client: receipt } : {},
        expectedApprovals: kind === "expected" ? { conversation: { approval: ["target"] } } : {},
      };
      try {
        const result = await new Function(
          `return ${oracleChatGptServerApprovalScanExpression(
            connectorId,
            "OmniCodex",
            ["conversation"],
            [],
            { goalCompletionReceipts: ["conversation"] },
          )}`,
        )();
        expect(result).toMatchObject({
          conversationUrls: ["https://chatgpt.com/c/conversation"],
          followUpScanRequired: true,
        });
        if (kind === "receipt") expect(result.receipts).toEqual([receipt]);
        expect(requestClient.request).not.toHaveBeenCalled();
      } finally {
        delete globals[key];
      }
    },
  );

  it("retains quiet completion readback without reopening historical connector mirrors across restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const connectorId = "asdk_app_boundedcompletion";
    const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const requestClient = {
      safeGet: vi.fn(async () => ({
        current_node: "working",
        messages: [
          {
            id: "working",
            metadata: { connector_id: connectorId },
            author: { role: "assistant" },
            status: "in_progress",
            channel: "analysis",
            end_turn: false,
          },
        ],
      })),
      request: vi.fn(),
    };
    globals[key] = { module: {}, requestClient, handled: {}, inFlight: {} };
    const scan = (receipt = false) =>
      new Function(
        `return ${oracleChatGptServerApprovalScanExpression(
          connectorId,
          "OmniCodex",
          receipt ? ["conversation"] : [],
          [],
          receipt ? { goalCompletionReceipts: ["conversation"] } : undefined,
        )}`,
      )();
    try {
      expect(await scan(true)).toMatchObject({ conversationUrls: [], followUpScanRequired: true });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await scan()).toMatchObject({ conversationUrls: [], followUpScanRequired: true });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await scan()).toMatchObject({ conversationUrls: [], followUpScanRequired: true });
      const durable = JSON.parse(localStorage.getItem(key) ?? "null");
      globals[key] = { ...durable, module: {}, requestClient };
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await scan()).toMatchObject({
        conversationUrls: [],
        requestStats: { getCount: 1, postCount: 0 },
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await scan()).toMatchObject({
        followUpScanRequired: true,
        requestStats: { getCount: 0, postCount: 0 },
      });
      expect(requestClient.safeGet).toHaveBeenCalledTimes(4);
      requestClient.safeGet.mockResolvedValue({
        current_node: "late-final",
        messages: [
          {
            id: "late-final",
            metadata: { connector_id: connectorId },
            author: { role: "assistant" },
            status: "finished_successfully",
            channel: "final",
            end_turn: true,
          },
        ],
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await scan()).toMatchObject({
        followUpScanRequired: false,
        conversationUrls: [],
        requestStats: { getCount: 1, postCount: 0 },
      });
      expect(JSON.parse(localStorage.getItem(key) ?? "null").activeConversationRecovery).toEqual(
        {},
      );
      // Reconnecting must retain the exact completion receipt, not replay its GET.
      globals[key] = { module: {}, requestClient, handled: {}, inFlight: {} };
      expect(requestClient.request).not.toHaveBeenCalled();
    } finally {
      delete globals[key];
      vi.useRealTimers();
    }
  });

  it.each(["parent", "mapping", "missing_edge", "other_branch", "bare"])(
    "settles only the notified final proven on the current branch after manual continuation (%s)",
    async (evidence) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      const connectorId = "asdk_app_latefinal";
      const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
      const globals = globalThis as typeof globalThis & Record<string, unknown>;
      const final = {
        id: "notified-final",
        author: { role: "assistant" },
        status: "finished_successfully",
        end_turn: true,
        channel: "final",
      };
      const next = {
        id: "manual-next",
        author: { role: "user" },
        ...(evidence === "parent" || evidence === "bare"
          ? { parent_id: final.id }
          : evidence === "other_branch"
            ? { parent_id: "different-final" }
            : {}),
      };
      const conversation = {
        current_node: next.id,
        messages: [final, next],
        ...(evidence === "mapping"
          ? {
              mapping: {
                [next.id]: { message: next, parent: final.id },
                [final.id]: { message: final, parent: null },
              },
            }
          : {}),
      };
      const requestClient = { safeGet: vi.fn(async () => conversation), request: vi.fn() };
      globals[key] = { module: {}, requestClient, handled: {}, inFlight: {} };
      const scan = (receipt = false) =>
        new Function(
          `return ${oracleChatGptServerApprovalScanExpression(
            connectorId,
            "OmniCodex",
            receipt ? ["conversation"] : [],
            [],
            receipt
              ? {
                  goalCompletionReceipts: ["conversation"],
                  ...(evidence === "bare"
                    ? {}
                    : { goalCompletionFinalIds: { conversation: [final.id] } }),
                }
              : undefined,
          )}`,
        )();
      try {
        const resolved = evidence === "parent" || evidence === "mapping";
        expect(await scan(true)).toMatchObject({
          followUpScanRequired: !resolved,
          requestStats: { getCount: 1, postCount: 0 },
        });
        const durable = JSON.parse(localStorage.getItem(key) ?? "null");
        globals[key] = { ...durable, module: {}, requestClient };
        if (resolved) {
          expect(durable.activeConversationRecovery).toEqual({});
          expect(durable.pendingConversations).toEqual({});
        } else if (evidence !== "bare") {
          expect(durable.activeConversationRecovery.conversation.finalMessageIds).toEqual([
            final.id,
          ]);
        }
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await scan()).toMatchObject({
          followUpScanRequired: !resolved,
          requestStats: { getCount: resolved ? 0 : 1, postCount: 0 },
        });
        expect(requestClient.safeGet).toHaveBeenCalledTimes(resolved ? 1 : 2);
        expect(requestClient.request).not.toHaveBeenCalled();
      } finally {
        delete globals[key];
        vi.useRealTimers();
      }
    },
  );

  it("preserves paced recovery for duplicate completion events across reconnects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const connectorId = "asdk_app_duplicatecompletion";
    const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const requestClient = {
      safeGet: vi.fn(async () => ({ current_node: "pending", messages: [] })),
      request: vi.fn(),
    };
    globals[key] = { module: {}, requestClient, handled: {}, inFlight: {} };
    const scan = (finalId: string, approval = false) =>
      new Function(
        `return ${oracleChatGptServerApprovalScanExpression(
          connectorId,
          "OmniCodex",
          ["conversation"],
          [],
          {
            goalCompletionReceipts: ["conversation"],
            goalCompletionFinalIds: { conversation: [finalId] },
            ...(approval
              ? {
                  expectedApprovals: [
                    {
                      conversationId: "conversation",
                      pendingMessageId: "approval",
                      targetMessageIds: ["target"],
                    },
                  ],
                }
              : {}),
          },
        )}`,
      )();
    try {
      await scan("final");
      const durable = JSON.parse(localStorage.getItem(key) ?? "null");
      expect(durable.activeConversationRecovery.conversation).toMatchObject({
        attempts: 1,
        nextReadAt: 1_030_000,
      });
      globals[key] = { ...durable, module: {}, requestClient };
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await scan("final")).toMatchObject({ requestStats: { getCount: 0 } });
      const replayed = JSON.parse(localStorage.getItem(key) ?? "null");
      expect(replayed.activeConversationRecovery).toEqual(durable.activeConversationRecovery);
      expect(replayed.pendingConversationRevisions).toEqual(durable.pendingConversationRevisions);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await scan("final")).toMatchObject({ requestStats: { getCount: 1 } });
      expect(
        JSON.parse(localStorage.getItem(key) ?? "null").activeConversationRecovery.conversation,
      ).toMatchObject({
        attempts: 2,
        nextReadAt: 1_090_000,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await scan("new-final")).toMatchObject({ requestStats: { getCount: 1 } });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await scan("new-final", true)).toMatchObject({ requestStats: { getCount: 1 } });
      expect(requestClient.request).not.toHaveBeenCalled();
    } finally {
      delete globals[key];
      vi.useRealTimers();
    }
  });

  it("retires only resolved final receipts and persists the remaining exact identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const connectorId = "asdk_app_partialfinal";
    const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const first = {
      id: "first-final",
      author: { role: "assistant" },
      status: "finished_successfully",
      end_turn: true,
      channel: "final",
    };
    const requestClient = {
      safeGet: vi.fn(async () => ({ current_node: first.id, messages: [first] })),
      request: vi.fn(),
    };
    globals[key] = { module: {}, requestClient, handled: {}, inFlight: {} };
    try {
      const result = await new Function(
        `return ${oracleChatGptServerApprovalScanExpression(
          connectorId,
          "OmniCodex",
          ["conversation"],
          [],
          {
            goalCompletionReceipts: ["conversation"],
            goalCompletionFinalIds: { conversation: ["first-final", "later-final"] },
          },
        )}`,
      )();
      expect(result.followUpScanRequired).toBe(true);
      const durable = JSON.parse(localStorage.getItem(key) ?? "null");
      expect(durable.activeConversationRecovery.conversation.finalMessageIds).toEqual([
        "later-final",
      ]);
    } finally {
      delete globals[key];
      vi.useRealTimers();
    }
  });

  it("resolves Goal completion from one current-turn projection without historical mapping", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const connectorId = "asdk_app_completionbranch";
    const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const final = {
      id: "final",
      author: { role: "assistant" },
      status: "finished_successfully",
      end_turn: true,
      channel: "final",
    };
    const next = { id: "next-user", author: { role: "user" }, parent_id: final.id };
    const requestClient = {
      safeGet: vi.fn(async () => ({
        conversation_id: "conversation",
        current_node: next.id,
        messages: [final, next],
        page_info: { has_previous_page: true, start_cursor: "older" },
      })),
      request: vi.fn(),
    };
    globals[key] = { module: {}, requestClient, handled: {}, inFlight: {} };
    try {
      const result = await new Function(
        `return ${oracleChatGptServerApprovalScanExpression(
          connectorId,
          "OmniCodex",
          ["conversation"],
          [],
          {
            goalCompletionReceipts: ["conversation"],
            goalCompletionFinalIds: { conversation: [final.id] },
          },
        )}`,
      )();
      expect(result.followUpScanRequired).toBe(false);
      expect(result.requestStats).toMatchObject({ getCount: 1, postCount: 0 });
      expect(requestClient.safeGet).toHaveBeenCalledWith("/conversations/conversation", {
        parameters: { query: { include_has_versions: true, num_turns: 1 } },
        disableAutomaticRetry: true,
      });
      expect(JSON.parse(localStorage.getItem(key) ?? "null").activeConversationRecovery).toEqual(
        {},
      );
      await vi.advanceTimersByTimeAsync(60_000);
      await new Function(
        `return ${oracleChatGptServerApprovalScanExpression(
          connectorId,
          "OmniCodex",
          ["conversation"],
          [],
          {
            goalCompletionReceipts: ["conversation"],
            goalCompletionFinalIds: { conversation: [final.id] },
          },
        )}`,
      )();
      expect(requestClient.safeGet).toHaveBeenCalledTimes(1);
      expect(requestClient.request).not.toHaveBeenCalled();
      final.id = "next-final";
      await vi.advanceTimersByTimeAsync(60_000);
      await new Function(
        `return ${oracleChatGptServerApprovalScanExpression(
          connectorId,
          "OmniCodex",
          ["conversation"],
          [],
          {
            goalCompletionReceipts: ["conversation"],
            goalCompletionFinalIds: { conversation: [final.id] },
          },
        )}`,
      )();
      expect(requestClient.safeGet).toHaveBeenCalledTimes(2);
    } finally {
      delete globals[key];
      vi.useRealTimers();
    }
  });

  it("does not request a second body or historical read during Goal completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const connectorId = "asdk_app_nohistory";
    const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const final = {
      id: "final",
      author: { role: "assistant" },
      status: "finished_successfully",
      end_turn: true,
      channel: "final",
    };
    const requestClient = {
      safeGet: vi.fn(async () => ({
        conversation_id: "conversation",
        current_node: final.id,
        messages: [
          {
            id: "goal-tool",
            author: { role: "tool", name: "api_tool.call_tool" },
            status: "finished_successfully",
            content: { text: "" },
            metadata: {
              invoked_resource: {
                resource_uri: `/${connectorId}/link_test/omnicodex__goal_get`,
              },
            },
          },
          final,
        ],
        page_info: { has_previous_page: true, start_cursor: "older" },
      })),
      request: vi.fn(),
    };
    globals[key] = { module: {}, requestClient, handled: {}, inFlight: {} };
    try {
      const result = await new Function(
        `return ${oracleChatGptServerApprovalScanExpression(
          connectorId,
          "OmniCodex",
          ["conversation"],
          [],
          {
            goalCompletionReceipts: ["conversation"],
            goalCompletionFinalIds: { conversation: [final.id] },
          },
        )}`,
      )();
      expect(result).toMatchObject({
        followUpScanRequired: false,
        requestStats: { getCount: 1, postCount: 0 },
      });
      expect(requestClient.safeGet).toHaveBeenCalledOnce();
      expect(requestClient.safeGet).toHaveBeenCalledWith("/conversations/conversation", {
        parameters: { query: { include_has_versions: true, num_turns: 1 } },
        disableAutomaticRetry: true,
      });
      expect(requestClient.request).not.toHaveBeenCalled();
    } finally {
      delete globals[key];
      vi.useRealTimers();
    }
  });
  it("retains a received Goal completion across delayed final persistence and reconnect without approval discovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const connectorId = "asdk_app_completionreceipt";
    const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    let finalPersisted = false;
    const requestClient = {
      safeGet: vi.fn(async () => ({
        current_node: finalPersisted ? "final" : "pending",
        messages: [
          {
            id: "pending",
            author: { role: "tool" },
            metadata: {
              jit_plugin_data: {
                from_server: {
                  type: "confirm_action",
                  body: {
                    connector_id: connectorId,
                    actions: [
                      {
                        type: "always_allow",
                        always_allow: { type: "always_allow", target_message_id: "target" },
                      },
                    ],
                  },
                },
              },
            },
          },
          ...(finalPersisted
            ? [
                {
                  id: "final",
                  author: { role: "assistant" },
                  status: "finished_successfully",
                  end_turn: true,
                  channel: "final",
                },
              ]
            : []),
        ],
      })),
      request: vi.fn(),
    };
    globals[key] = { module: {}, requestClient, handled: {}, inFlight: {} };
    const scan = (receipt = false) =>
      new Function(
        `return ${oracleChatGptServerApprovalScanExpression(
          connectorId,
          "OmniCodex",
          receipt ? ["conversation"] : [],
          [],
          receipt ? { goalCompletionReceipts: ["conversation"] } : undefined,
        )}`,
      )();
    try {
      expect(await scan(true)).toMatchObject({
        followUpScanRequired: true,
        nextScanAtUnixMs: 1_030_000,
        requestStats: { getCount: 1, postCount: 0 },
      });
      const durable = JSON.parse(localStorage.getItem(key) ?? "null");
      expect(durable.activeConversationRecovery.conversation).toEqual({
        awaitingGoalCompletion: true,
        attempts: 1,
        nextReadAt: 1_030_000,
      });
      globals[key] = { ...durable, module: {}, requestClient };
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await scan()).toMatchObject({ requestStats: { getCount: 0, postCount: 0 } });
      }
      finalPersisted = true;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await scan()).toMatchObject({
        followUpScanRequired: false,
        requestStats: { getCount: 1, postCount: 0 },
      });
      expect(JSON.parse(localStorage.getItem(key) ?? "null").activeConversationRecovery).toEqual(
        {},
      );
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await scan()).toMatchObject({ requestStats: { getCount: 0, postCount: 0 } });
      }
      expect(requestClient.safeGet).toHaveBeenCalledTimes(2);
      expect(requestClient.request).not.toHaveBeenCalled();
    } finally {
      delete globals[key];
      vi.useRealTimers();
    }
  });

  it("retains a notified conversation across an empty first read and recovery until its connector is visible", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const connectorId = "asdk_app_hydration";
    const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const requestClient = {
      safeGet: vi
        .fn()
        .mockResolvedValueOnce({ messages: [] })
        .mockResolvedValue({
          messages: [{ author: { role: "user" }, metadata: { connector_id: connectorId } }],
        }),
      request: vi.fn(),
    };
    globals[key] = { module: {}, requestClient, handled: {}, inFlight: {} };
    const scan = (ids: string[] = []) =>
      new Function(
        `return ${oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", ids)}`,
      )();
    try {
      expect(await scan(["conversation"])).toMatchObject({
        followUpScanRequired: true,
        conversationUrls: [],
        requestStats: {
          getCount: 1,
          postCount: 0,
          requests: [{ messageCount: 0, userMessageCount: 0, connectorReferenced: false }],
        },
      });
      const durable = JSON.parse(localStorage.getItem(key) ?? "null");
      expect(durable.pendingConversations).toEqual({ conversation: true });
      globals[key] = { ...durable, module: {}, requestClient };
      for (let wake = 0; wake < 25; wake++) await scan();
      expect(requestClient.safeGet).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await scan()).toMatchObject({
        followUpScanRequired: false,
        conversationUrls: ["https://chatgpt.com/c/conversation"],
        requestStats: {
          getCount: 1,
          postCount: 0,
          requests: [{ messageCount: 1, userMessageCount: 1, connectorReferenced: true }],
        },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await scan()).toMatchObject({ requestStats: { getCount: 0, postCount: 0 } });
      expect(requestClient.safeGet).toHaveBeenCalledTimes(2);
      expect(requestClient.request).not.toHaveBeenCalled();
    } finally {
      delete globals[key];
      vi.useRealTimers();
    }
  });

  it.each([403, 502, undefined])(
    "preserves conversation-read failure status %s and recovery identity",
    async (status) => {
      const connectorId = "asdk_app_readfailure";
      const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
      const globals = globalThis as typeof globalThis & Record<string, unknown>;
      const failure = Object.assign(new TypeError("Failed to fetch"), {
        ...(status === undefined ? {} : { response: { status } }),
        headers: new Headers({ "x-request-id": "read-failure", authorization: "private" }),
      });
      const requestClient = {
        safeGet: vi.fn().mockRejectedValue(failure),
        request: vi.fn(),
      };
      globals[key] = { module: {}, requestClient, handled: {}, inFlight: {} };
      try {
        const startedAt = Date.now();
        const run = new Function(
          `return ${oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", ["conversation"])}`,
        ) as () => Promise<{ errors: Record<string, unknown>[] }>;
        const result = await run();
        expect(result).toMatchObject({
          outcome: "partial",
          followUpScanRequired: true,
          receipts: [],
          errors: [
            {
              conversationId: "conversation",
              error: "TypeError:Failed to fetch",
              operation: "conversation_read",
              responseHeaders: { "x-request-id": "read-failure" },
            },
          ],
        });
        expect(result.errors[0]?.status).toBe(status);
        expect(result.errors[0]?.observedAtUnixMs).toBeGreaterThanOrEqual(startedAt);
        expect(result.errors[0]).not.toHaveProperty("submissionState");
        expect(JSON.stringify(result)).not.toContain("private");
        expect(requestClient.request).not.toHaveBeenCalled();
        expect(
          (globals[key] as { pendingConversations: Record<string, boolean> }).pendingConversations,
        ).toEqual({ conversation: true });
      } finally {
        delete globals[key];
      }
    },
  );

  it.each(["readiness", "scan"])(
    "preserves the owned runtime and its cooldown after a %s transport failure",
    async (failureStage) => {
      vi.useFakeTimers();
      const connectorId = "asdk_app_reconnect";
      const conversationId = "a6b0d2f0-7590-4197-a40c-29a6de66da22";
      const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
      const retryAtUnixMs = Date.now() + 120_000;
      const closeOwnedTarget = vi.fn();
      const target = { id: "persisted", url: oracleChatGptApprovalRuntimeUrl(connectorId) };
      const adopt = vi.fn().mockResolvedValue(target);
      const closeFailed = vi.fn();
      const closeRecovered = vi.fn();
      let failedSessionClosed = false;
      const failedCommand = vi.fn(async (_method, params) => {
        if (
          failureStage === "scan" &&
          params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION
        ) {
          return { result: { value: true } };
        }
        failedSessionClosed = true;
        throw new Error("CDP_CONNECTION_LOST");
      });
      const recoveredCommand = vi.fn(async (_method, params) => {
        if (params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION) {
          return { result: { value: true } };
        }
        return {
          result: {
            value: {
              outcome: "partial",
              examined: 0,
              discovered: 0,
              approvalsPending: 0,
              conversationUrls: [],
              errors: [
                {
                  conversationId,
                  error: "Error:chatgpt_approval_http_502",
                  status: 502,
                  operation: "approval_submission",
                  observedAtUnixMs: 1_000_000,
                  responseHeaders: { "x-request-id": "failed-post", "set-cookie": "private" },
                },
              ],
              receipts: [],
              followUpScanRequired: true,
              nextScanAtUnixMs: retryAtUnixMs,
              rateLimit: {
                status: 429,
                operation: "conversation_read",
                retryAtUnixMs,
                observedAtUnixMs: 1_000_000,
                serverRetryAtUnixMs: 1_600_000,
                localBackoffMs: 300_000,
                backoffSource: "server_retry_after",
                statusEvidence: "http_status",
                responseHeaders: {
                  "retry-after": "600",
                  "x-request-id": "request-a",
                  authorization: "must-not-leave-browser",
                  "set-cookie": "must-not-leave-browser",
                },
              },
            },
          },
        };
      });
      const connectSession = vi
        .fn()
        .mockResolvedValueOnce({
          command: failedCommand,
          close: closeFailed,
          get isClosed() {
            return failedSessionClosed;
          },
        })
        .mockResolvedValueOnce({ command: recoveredCommand, close: closeRecovered });
      const client = new OracleChatGptServerApprovalClient({
        connectorId,
        connectorName: "OmniCodex",
        cdpEndpoint: "http://127.0.0.1:19222",
        transport: { adoptOrOpenOwnedApprovalRuntimeTarget: adopt, closeOwnedTarget } as never,
        connectSession,
      });
      const signal = new AbortController().signal;
      try {
        client.requestScan(conversationUrl);
        await expect(client.scan(signal)).rejects.toThrow("CDP_CONNECTION_LOST");
        expect(closeFailed).toHaveBeenCalledOnce();
        expect(closeOwnedTarget).not.toHaveBeenCalled();
        for (let tick = 0; tick < 10; tick += 1) await client.scan(signal);
        expect(adopt).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(client.scan(signal)).resolves.toMatchObject({
          nextScanAtUnixMs: retryAtUnixMs,
          errors: [
            {
              conversationId,
              error: "Error:chatgpt_approval_http_502",
              status: 502,
              operation: "approval_submission",
              observedAtUnixMs: 1_000_000,
              responseHeaders: { "x-request-id": "failed-post" },
            },
          ],
          rateLimit: {
            observedAtUnixMs: 1_000_000,
            serverRetryAtUnixMs: 1_600_000,
            localBackoffMs: 300_000,
            backoffSource: "server_retry_after",
            statusEvidence: "http_status",
            responseHeaders: { "retry-after": "600", "x-request-id": "request-a" },
          },
        });
        expect(adopt).toHaveBeenCalledTimes(2);
        expect(connectSession.mock.calls.map((call) => call[1])).toEqual([
          "persisted",
          "persisted",
        ]);
        expect(recoveredCommand).toHaveBeenLastCalledWith(
          "Runtime.evaluate",
          expect.objectContaining({
            expression: oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", [
              conversationId,
            ]),
          }),
          signal,
          180_000,
        );
        client.requestScan(conversationUrl);
        const cached = await client.scan(signal);
        expect(cached.rateLimit).toMatchObject({ status: 429, retryAtUnixMs });
        expect(cached.rateLimit?.responseHeaders).toEqual({
          "retry-after": "600",
          "x-request-id": "request-a",
        });
        expect(recoveredCommand).toHaveBeenCalledTimes(2);
        expect(recoveredCommand.mock.calls.some((call) => call[0] === "Page.navigate")).toBe(false);
      } finally {
        await client.stop();
      }
      expect(closeRecovered).toHaveBeenCalledOnce();
      expect(closeOwnedTarget).not.toHaveBeenCalled();
      vi.useRealTimers();
    },
  );

  it("reuses one owned lightweight target and returns an authoritative persisted receipt", async () => {
    const connectorId = "asdk_app_omnicodex";
    const connectorName = "OmniCodex";
    const conversationId = "WEB:a6b0d2f0-7590-4197-a40c-29a6de66da22";
    const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
    const target = {
      id: "oracle-runtime",
      type: "page",
      url: "about:blank?omnicodex_target=00000000-0000-4000-8000-000000000001",
      webSocketDebuggerUrl: "ws://127.0.0.1:19222/devtools/page/oracle-runtime",
    } as const;
    const adoptOrOpenOwnedApprovalRuntimeTarget = vi.fn().mockResolvedValue(target);
    const closeOwnedTarget = vi.fn().mockResolvedValue(undefined);
    const command = vi.fn(async (method: string, params: unknown) => {
      if (method === "Page.navigate") return {};
      const expression = (params as { expression?: string }).expression;
      if (expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION) {
        return { result: { value: true } };
      }
      if (
        withoutTelemetry(expression) ===
          oracleChatGptServerApprovalScanExpression(connectorId, connectorName) ||
        withoutTelemetry(expression) ===
          oracleChatGptServerApprovalScanExpression(connectorId, connectorName, [conversationId])
      ) {
        return {
          result: {
            value: {
              outcome: "ok",
              examined: 1,
              discovered: 1,
              approvalsPending: 1,
              conversationUrls: [conversationUrl],
              errors: [],
              receipts: [
                {
                  conversationId,
                  conversationUrl,
                  pendingMessageId: "pending",
                  clientMessageId: "client",
                  targetMessageId: "target",
                  action: "allow",
                  rememberAnswer: true,
                  responseStatus: 200,
                },
              ],
            },
          },
        };
      }
      throw new Error(`unexpected ${method}`);
    });
    const close = vi.fn();
    const transport = {
      adoptOrOpenOwnedApprovalRuntimeTarget,
      closeOwnedTarget,
    };
    const connectSession = vi
      .fn()
      .mockResolvedValue({ command, close } as unknown as BoundedCdpSession);
    const client = new OracleChatGptServerApprovalClient({
      connectorId,
      connectorName,
      cdpEndpoint: "http://127.0.0.1:19222",
      transport: transport as never,
      connectSession,
    });
    const signal = new AbortController().signal;

    client.requestScan(conversationUrl);
    await expect(client.scan(signal)).resolves.toMatchObject({
      conversationUrls: [conversationUrl],
      receipts: [{ rememberAnswer: true, responseStatus: 200 }],
    });
    client.requestScan(conversationUrl);
    await expect(client.scan(signal)).resolves.toMatchObject({ outcome: "ok" });
    expect(adoptOrOpenOwnedApprovalRuntimeTarget).toHaveBeenCalledOnce();
    expect(connectSession).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledWith(
      "Page.navigate",
      { url: oracleChatGptApprovalRuntimeUrl(connectorId) },
      signal,
      60_000,
    );
    expect(command).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({
        expression: oracleChatGptServerApprovalScanExpression(connectorId, connectorName, [
          conversationId,
        ]),
      }),
      signal,
      180_000,
    );

    await client.stop();
    expect(close).toHaveBeenCalledOnce();
    expect(closeOwnedTarget).not.toHaveBeenCalled();
  });

  it("performs one local pending restore and stays idle for unattributed requests", async () => {
    vi.useFakeTimers();
    const command = vi.fn(async () => ({
      result: {
        value: {
          outcome: "ok",
          examined: 0,
          discovered: 0,
          approvalsPending: 0,
          conversationUrls: [],
          errors: [],
          receipts: [],
          followUpScanRequired: false,
        },
      },
    }));
    const client = new OracleChatGptServerApprovalClient({
      connectorId: "asdk_app_idle",
      connectorName: "OmniCodex",
      cdpEndpoint: "http://127.0.0.1:19222",
      transport: {
        adoptOrOpenOwnedApprovalRuntimeTarget: vi.fn().mockResolvedValue({
          id: "owned",
          url: oracleChatGptApprovalRuntimeUrl("asdk_app_idle"),
        }),
      } as never,
      connectSession: vi.fn().mockResolvedValue({
        command: vi.fn(async (_method, params) =>
          params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION
            ? { result: { value: true } }
            : command(),
        ),
        close: vi.fn(),
      } as never),
    });
    try {
      await client.scan(new AbortController().signal);
      for (let index = 0; index < 50; index += 1) {
        client.requestScan();
        await vi.advanceTimersByTimeAsync(5_000);
        await client.scan(new AbortController().signal);
      }
      expect(command).toHaveBeenCalledOnce();
    } finally {
      await client.stop();
      vi.useRealTimers();
    }
  });

  it("does not turn an account rate limit into a delayed background retry", async () => {
    vi.useFakeTimers();
    try {
      const command = vi.fn(async (method: string, params: unknown) => {
        if (method === "Page.navigate") return {};
        const expression = (params as { expression?: string }).expression;
        if (expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION) {
          return { result: { value: true } };
        }
        return {
          result: {
            value: {
              outcome: "partial",
              examined: 0,
              discovered: 0,
              approvalsPending: 0,
              conversationUrls: [],
              receipts: [],
              errors: [{ conversationId: "account", error: "rate_limited_backoff" }],
            },
          },
        };
      });
      const client = new OracleChatGptServerApprovalClient({
        connectorId: "asdk_app_omnicodex",
        connectorName: "OmniCodex",
        cdpEndpoint: "http://127.0.0.1:19222",
        transport: {
          adoptOrOpenOwnedApprovalRuntimeTarget: vi.fn().mockResolvedValue({
            id: "oracle-runtime",
            type: "page",
            url: "about:blank",
            webSocketDebuggerUrl: "ws://127.0.0.1:19222/devtools/page/oracle-runtime",
          }),
          closeOwnedTarget: vi.fn(),
        } as never,
        connectSession: vi.fn().mockResolvedValue({ command, close: vi.fn() } as never),
      });
      const signal = new AbortController().signal;

      client.requestScan();
      await expect(client.scan(signal)).resolves.toMatchObject({ outcome: "partial" });
      const evaluateCallsAfterRateLimit = command.mock.calls.filter(
        ([method]) => method === "Runtime.evaluate",
      ).length;

      await vi.advanceTimersByTimeAsync(600_000);
      await expect(client.scan(signal)).resolves.toMatchObject({ examined: 0, discovered: 0 });
      expect(command.mock.calls.filter(([method]) => method === "Runtime.evaluate")).toHaveLength(
        evaluateCallsAfterRateLimit,
      );
      await client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts only fixed code with validated exact conversation identities", () => {
    const expression = oracleChatGptServerApprovalScanExpression(
      "asdk_app_omnicodex",
      "OmniCodex",
      ["target"],
    );
    expect(expression).not.toContain('safeGet("/conversations",');
    expect(expression).not.toContain("historicalRecovery");
    expect(expression).not.toContain("bootstrapQueue");
    expect(expression).toContain("pendingConversations: state.pendingConversations");
    expect(expression).toContain("preDispatchConversation?.current_node !== pending.id");
    expect(expression).toContain("disableAutomaticRetry: true");
    expect(expression).toContain("root.localStorage.setItem(");
    expect(expression).not.toContain('model: ""');
    expect(() =>
      oracleChatGptServerApprovalScanExpression("asdk_app_omnicodex", "OmniCodex", ["../other"]),
    ).toThrow();
    expect(() => new Function(`return ${expression}`)).not.toThrow();
  });

  it("does not fork a stale approval after another client advances the conversation", async () => {
    const connectorId = "asdk_app_mobilebranch";
    const connectorName = "OmniCodex";
    const conversationId = "mobile-advanced-conversation";
    const targetMessageId = "target-message";
    const pendingMessageId = "pending-approval";
    let conversationReads = 0;
    const pendingMessage = {
      id: pendingMessageId,
      author: { name: "api_tool.call_tool", role: "tool" },
      metadata: {
        jit_plugin_data: {
          from_server: {
            type: "confirm_action",
            body: {
              actions: [
                {
                  type: "always_allow",
                  always_allow: {
                    type: "always_allow",
                    target_message_id: targetMessageId,
                  },
                },
              ],
            },
          },
        },
      },
    };
    const requestClient = {
      safeGet: vi.fn(async (path: string) => {
        if (path === "/conversations") {
          return {
            items: [
              {
                id: conversationId,
                update_time: 1,
                current_node: pendingMessageId,
                default_model_slug: "gpt-5-pro",
              },
            ],
          };
        }
        if (path !== `/conversations/${conversationId}`) {
          throw new Error(`unexpected path ${path}`);
        }
        conversationReads += 1;
        const advanced = conversationReads >= 2;
        return {
          id: conversationId,
          current_node: advanced ? "mobile-user-message" : pendingMessageId,
          default_model_slug: "gpt-5-pro",
          messages: advanced
            ? [
                {
                  id: "mobile-user-message",
                  author: { role: "user" },
                  content: { content_type: "text", parts: ["newer mobile instruction"] },
                },
              ]
            : [
                {
                  id: targetMessageId,
                  author: { role: "tool" },
                  metadata: { connector_name: connectorName },
                  recipient: "all",
                },
                pendingMessage,
              ],
        };
      }),
      request: vi.fn(),
    };
    const module = {
      No: vi.fn(),
      Eo: vi.fn(async () => ({})),
      Fo: vi.fn(async () => undefined),
      Ao: vi.fn(() => ({})),
      Uo: { getEnforcementToken: vi.fn(async () => "proof") },
      zo: { getEnforcementToken: vi.fn(async () => "turnstile") },
    };
    const stateKey = `__omnicodexOracleServerApprovalV2:${connectorId}`;
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    globals[stateKey] = {
      module,
      requestClient,
      assetPath: null,
      seen: Object.create(null),
      handled: Object.create(null),
      inFlight: Object.create(null),
      initialized: false,
      nextHeadScanAt: 0,
      backoffUntil: 0,
      backoffMs: 60_000,
      drains: new Set(),
    };
    try {
      const run = new Function(
        `return ${oracleChatGptServerApprovalScanExpression(connectorId, connectorName, [conversationId])}`,
      ) as () => Promise<{ approvalsPending: number; receipts: unknown[] }>;

      await expect(run()).resolves.toMatchObject({ approvalsPending: 1, receipts: [] });
      expect(conversationReads).toBe(2);
      expect(requestClient.request).not.toHaveBeenCalled();
      const state = globals[stateKey] as {
        seen: Record<string, unknown>;
        lastConversationChangeAt: Record<string, unknown>;
      };
      expect(state.seen[conversationId]).toBeUndefined();
      expect(state.lastConversationChangeAt?.[conversationId]).toBeUndefined();
    } finally {
      delete globals[stateKey];
    }
  });

  it("ignores legacy account discovery history and performs zero idle HTTP requests", async () => {
    const key = "__omnicodexOracleServerApprovalV2:asdk_app_legacyidle";
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const requestClient = { safeGet: vi.fn(), request: vi.fn() };
    globals[key] = {
      module: {},
      requestClient,
      handled: {},
      inFlight: {},
      seen: { old: "head" },
      bootstrapQueue: [{ id: "old", signature: "head" }],
      initialized: false,
      historicalComplete: false,
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const run = new Function(
        `return ${oracleChatGptServerApprovalScanExpression("asdk_app_legacyidle", "OmniCodex")}`,
      ) as () => Promise<unknown>;
      await expect(run()).resolves.toMatchObject({
        examined: 0,
        followUpScanRequired: false,
        requestStats: {
          trigger: "idle",
          getCount: 0,
          postCount: 0,
          moduleInitializationCount: 0,
          rateLimitCount: 0,
          conversationIds: [],
          requests: [],
        },
      });
      await run();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(requestClient.safeGet).not.toHaveBeenCalled();
    } finally {
      delete globals[key];
      vi.unstubAllGlobals();
    }
  });

  it("resolves renamed native exports before initialization without calling an obsolete alias", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const connectorId = "asdk_app_requeststats";
    const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const requestClient = { safeGet: vi.fn(async () => ({ messages: [] })), request: vi.fn() };
    const runtime = {
      No: vi.fn(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'SendIfAvailable')");
      }),
      initRequest: vi.fn(),
      initSentinel: vi.fn(),
      getRequirements: vi.fn(),
      warmSentinel: vi.fn(),
      makeHeaders: vi.fn(),
      proofProvider: { getEnforcementToken: vi.fn() },
      turnstileProvider: { getEnforcementToken: vi.fn() },
      httpClient: requestClient,
    };
    const source = [
      "requestInit=e((()=>{Client=class{safeGet(){}},client=new Client({includeBusinessAgentPreviewSession:!0,baseUrl:base})}));",
      "function requirements(a,b,c){return cached(`finalized`,a,b,c)}",
      "function prepare(){return request(`/sentinel/chat-requirements/prepare`).then(async t=>Promise.all([proof.getEnforcementToken(t,{forceSync:!0}),turnstile.getEnforcementToken(t)]))}",
      "function sdkToken(flow){return window.SentinelSDK.token(flow)}",
      "function headers(r){return {[`OpenAI-Sentinel-Chat-Requirements-Token`]:r.token}}",
      "var sentinelInit=e((()=>{sdkUrl=`/sentinel/sdk.js`}));",
      "export{requestInit as initRequest,sentinelInit as initSentinel,requirements as getRequirements,sdkToken as warmSentinel,headers as makeHeaders,proof as proofProvider,turnstile as turnstileProvider,client as httpClient};",
    ].join("");
    const fetchMock = vi.fn(async (path: string) => ({
      ok: true,
      text: async () => (path === "/" ? "/cdn/assets/runtime.js" : source),
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", { getElementById: () => ({ textContent: "{}" }) });
    const expression = oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", [
      "target",
    ]).replace("await import(candidate)", "await loadModule(candidate)");
    const run = new Function("loadModule", `return ${expression}`) as (
      loadModule: () => Promise<unknown>,
    ) => Promise<unknown>;
    try {
      await expect(run(async () => runtime)).resolves.toMatchObject({
        requestStats: {
          scanStartedAtUnixMs: 1_000_000,
          trigger: "queued_request",
          getCount: 3,
          postCount: 0,
          moduleInitializationCount: 2,
          rateLimitCount: 0,
          conversationIds: ["target"],
          requests: [
            { method: "GET", path: "/", operation: "runtime_initialization" },
            { method: "GET", path: "/cdn/assets/runtime.js", operation: "runtime_initialization" },
            {
              method: "GET",
              path: "/conversations/target",
              operation: "approval_scan",
              conversationId: "target",
            },
          ],
        },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(requestClient.safeGet).toHaveBeenCalledOnce();
      expect(runtime.No).not.toHaveBeenCalled();
      expect(runtime.initRequest).toHaveBeenCalledOnce();
      expect(runtime.initSentinel).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(run(async () => runtime)).resolves.toMatchObject({
        requestStats: {
          getCount: 1,
          postCount: 0,
          moduleInitializationCount: 0,
          rateLimitCount: 0,
        },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(requestClient.safeGet).toHaveBeenCalledTimes(2);
      expect(runtime.No).not.toHaveBeenCalled();
      expect(runtime.initRequest).toHaveBeenCalledOnce();
      expect(runtime.initSentinel).toHaveBeenCalledOnce();
    } finally {
      delete globals[key];
      vi.useRealTimers();
    }
  });

  it("coalesces concurrent-work wake signals instead of bypassing the account request cadence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const key = "__omnicodexOracleServerApprovalV2:asdk_app_pacedwake";
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const requestClient = { safeGet: vi.fn(async () => ({ items: [] })), request: vi.fn() };
    globals[key] = {
      module: {},
      requestClient,
      seen: {},
      handled: {},
      inFlight: {},
      initialized: true,
      historicalComplete: true,
      bootstrapQueue: [],
      nextHistoricalRecoveryAt: Date.now() + 120_000,
    };
    try {
      const run = new Function(
        `return ${oracleChatGptServerApprovalScanExpression("asdk_app_pacedwake", "OmniCodex", [
          "conversation",
        ])}`,
      ) as () => Promise<unknown>;
      await run();
      for (let index = 0; index < 50; index += 1) await run();
      expect(requestClient.safeGet).toHaveBeenCalledOnce();
      expect(requestClient.safeGet).toHaveBeenCalledWith(
        "/conversations/conversation",
        expect.objectContaining({ disableAutomaticRetry: true }),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await run();
      expect(requestClient.safeGet).toHaveBeenCalledTimes(2);
    } finally {
      delete globals[key];
      vi.useRealTimers();
    }
  });

  it("paces distinct queued conversations and retains later wakes without bursting GETs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const connectorId = "asdk_app_pacedqueue";
    const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const requestClient = {
      safeGet: vi.fn(async (_path: string) => ({ messages: [{ id: "settled", end_turn: true }] })),
      request: vi.fn(),
    };
    globals[key] = { module: {}, requestClient, handled: {}, inFlight: {} };
    const scan = (ids: string[] = []) =>
      (
        new Function(
          `return ${oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", ids)}`,
        ) as () => Promise<unknown>
      )();
    try {
      await expect(scan(["a", "b", "c"])).resolves.toMatchObject({
        examined: 1,
        discovered: 3,
        followUpScanRequired: true,
        requestStats: {
          trigger: "queued_request",
          getCount: 1,
          postCount: 0,
          conversationIds: ["a"],
          requests: [
            {
              method: "GET",
              path: "/conversations/a",
              operation: "approval_scan",
              conversationId: "a",
              trigger: "queued_request",
              queueRevision: expect.any(String),
            },
          ],
        },
      });
      expect(requestClient.safeGet.mock.calls.map((call) => call[0])).toEqual(["/conversations/a"]);
      await expect(scan(["a", "b", "c"])).resolves.toMatchObject({
        requestStats: { getCount: 0, postCount: 0, conversationIds: [], requests: [] },
      });
      expect(requestClient.safeGet).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(scan()).resolves.toMatchObject({
        requestStats: {
          trigger: "recovery",
          getCount: 1,
          conversationIds: ["b"],
          requests: [
            { conversationId: "b", trigger: "recovery", queueRevision: expect.any(String) },
          ],
        },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await scan();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(scan()).resolves.toMatchObject({ followUpScanRequired: false });
      expect(requestClient.safeGet.mock.calls.map((call) => call[0])).toEqual([
        "/conversations/a",
        "/conversations/b",
        "/conversations/c",
        "/conversations/a",
      ]);
      expect(requestClient.request).not.toHaveBeenCalled();
    } finally {
      delete globals[key];
      vi.useRealTimers();
    }
  });

  it("retires confirmed deleted conversations without losing uncertain receipts or retrying after reload", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const connectorId = "asdk_app_deletedqueue";
    const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const submission = { conversationId: "deleted", clientMessageId: "unconfirmed" };
    const requestClient = {
      safeGet: vi.fn(async (path: string) => {
        if (path.endsWith("/deleted"))
          throw Object.assign(new Error("Conversation has been deleted. Start a new chat."), {
            status: 404,
          });
        return { messages: [{ id: "settled", end_turn: true }] };
      }),
      request: vi.fn(),
    };
    globals[key] = { module: {}, requestClient, inFlight: { uncertain: submission } };
    const scan = (ids: string[] = []) =>
      (
        new Function(
          `return ${oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", ids)}`,
        ) as () => Promise<unknown>
      )();
    try {
      await expect(scan(["deleted", "healthy"])).resolves.toMatchObject({
        errors: [{ conversationId: "deleted", status: 404, operation: "conversation_read" }],
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(scan()).resolves.toMatchObject({ followUpScanRequired: false });
      const durable = JSON.parse(localStorage.getItem(key) ?? "{}");
      expect(durable.inFlight.uncertain).toEqual(submission);
      expect(durable.pendingConversations).toEqual({});
      globals[key] = { ...durable, module: {}, requestClient };
      for (let index = 0; index < 3; index += 1) {
        await vi.advanceTimersByTimeAsync(5_000);
        await scan();
      }
      expect(requestClient.safeGet.mock.calls.map(([path]) => path)).toEqual([
        "/conversations/deleted",
        "/conversations/healthy",
      ]);
      // Fresh exact activity may inspect again; timer recovery may not.
      await scan(["deleted"]);
      expect(requestClient.safeGet).toHaveBeenCalledTimes(3);
      expect(requestClient.request).not.toHaveBeenCalled();
    } finally {
      delete globals[key];
      vi.useRealTimers();
    }
  });

  it("gives durable unconfirmed readbacks a queue turn despite continuous new conversations", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const connectorId = "asdk_app_readbackfairness";
    const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const submission = {
      conversationId: "a",
      clientMessageId: "client",
      targetMessageId: "target",
      pendingMessageId: "pending",
      action: "always_allow",
    };
    const requestClient = {
      safeGet: vi.fn(async (_path: string) => ({ messages: [{ id: "settled", end_turn: true }] })),
      request: vi.fn(),
    };
    globals[key] = {
      module: {},
      requestClient,
      handled: {},
      inFlight: { confirmation: submission },
    };
    const scan = (id: string) =>
      (
        new Function(
          `return ${oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", [id])}`,
        ) as () => Promise<unknown>
      )();
    try {
      for (const id of ["b", "c", "d", "e"]) {
        await expect(scan(id)).resolves.toMatchObject({ followUpScanRequired: true });
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(requestClient.safeGet.mock.calls.map((call) => call[0])).toEqual([
        "/conversations/b",
        "/conversations/a",
        "/conversations/c",
        "/conversations/a",
      ]);
      const durable = JSON.parse(localStorage.getItem(key) ?? "{}");
      expect(durable.inFlight.confirmation).toEqual(submission);
      expect(Object.keys(durable.pendingConversations)).toEqual(["d", "e", "a"]);
      expect(requestClient.request).not.toHaveBeenCalled();
    } finally {
      delete globals[key];
      vi.useRealTimers();
    }
  });

  it("honors Retry-After without inflating it through local exponential backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const key = "__omnicodexOracleServerApprovalV2:asdk_app_bodylimit";
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const requestClient = {
      safeGet: vi.fn(async (path: string) => {
        if (path === "/conversations")
          return { items: [{ id: "new-conversation", current_node: "new" }] };
        throw {
          status: 429,
          message: "slow down",
          headers: new Headers({
            "Retry-After": "600",
            "x-request-id": "request-429",
            "set-cookie": "secret",
            authorization: "secret",
          }),
        };
      }),
      request: vi.fn(),
    };
    globals[key] = {
      module: {},
      requestClient,
      seen: {},
      handled: {},
      inFlight: {},
      initialized: true,
      historicalComplete: true,
      bootstrapQueue: [],
      nextHistoricalRecoveryAt: Date.now() + 120_000,
    };
    try {
      const run = new Function(
        `return ${oracleChatGptServerApprovalScanExpression("asdk_app_bodylimit", "OmniCodex", [
          "new-conversation",
        ])}`,
      ) as () => Promise<{
        nextScanAtUnixMs: number;
        rateLimit: { status: number; operation: string };
        requestStats: { requests: Array<{ queueRevision: string }> };
      }>;
      const resume = new Function(
        `return ${oracleChatGptServerApprovalScanExpression("asdk_app_bodylimit", "OmniCodex")}`,
      ) as typeof run;
      const first = await run();
      expect(first).toMatchObject({
        requestStats: {
          getCount: 1,
          postCount: 0,
          rateLimitCount: 1,
          conversationIds: ["new-conversation"],
        },
      });
      expect(first.nextScanAtUnixMs).toBe(1_600_000);
      expect(first.rateLimit).toEqual({
        status: 429,
        operation: "conversation_read",
        observedAtUnixMs: 1_000_000,
        retryAtUnixMs: 1_600_000,
        serverRetryAtUnixMs: 1_600_000,
        localBackoffMs: 30_000,
        statusEvidence: "http_status",
        backoffSource: "server_retry_after",
        responseHeaders: { "retry-after": "600", "x-request-id": "request-429" },
      });
      const cooldown = await resume();
      expect(cooldown.rateLimit).toEqual(first.rateLimit);
      expect(cooldown).toMatchObject({
        requestStats: {
          getCount: 0,
          postCount: 0,
          rateLimitCount: 0,
          requests: [],
        },
      });
      expect(requestClient.safeGet).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(600_001);
      const second = await resume();
      expect(second).toMatchObject({
        requestStats: {
          getCount: 1,
          rateLimitCount: 1,
          requests: [
            {
              method: "GET",
              path: "/conversations/new-conversation",
              operation: "approval_scan",
              conversationId: "new-conversation",
              trigger: "recovery",
              queueRevision: first.requestStats.requests[0]?.queueRevision,
            },
          ],
        },
      });
      expect(second.nextScanAtUnixMs).toBe(Date.now() + 600_000);
      expect(second.rateLimit).toMatchObject({
        observedAtUnixMs: Date.now(),
        localBackoffMs: 30_000,
        backoffSource: "server_retry_after",
        serverRetryAtUnixMs: Date.now() + 600_000,
      });
      expect(requestClient.safeGet).toHaveBeenCalledTimes(2);
    } finally {
      delete globals[key];
      vi.useRealTimers();
    }
  });

  it("backs off a Goal completion current-turn read after HTTP 429", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const connectorId = "asdk_app_recoverylimit";
    const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const requestClient = {
      safeGet: vi.fn(async () => {
        throw { status: 429, message: "Too many requests" };
      }),
      request: vi.fn(),
    };
    globals[key] = { module: {}, requestClient, handled: {}, inFlight: {} };
    const scan = () =>
      new Function(
        `return ${oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", ["conversation"], [], { goalCompletionReceipts: ["conversation"] })}`,
      )();
    try {
      const first = await scan();
      expect(first).toMatchObject({
        outcome: "partial",
        requestStats: { getCount: 1, rateLimitCount: 1 },
        rateLimit: { status: 429, operation: "conversation_read" },
      });
      expect(requestClient.safeGet).toHaveBeenCalledWith("/conversations/conversation", {
        parameters: { query: { include_has_versions: true, num_turns: 1 } },
        disableAutomaticRetry: true,
      });
      expect((await scan()).requestStats.getCount).toBe(0);
      expect(requestClient.safeGet).toHaveBeenCalledOnce();
      expect(requestClient.request).not.toHaveBeenCalled();
    } finally {
      delete globals[key];
      vi.useRealTimers();
    }
  });
  it("paces automatic retries without escalating intermittent 429 into long account lockouts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const connectorId = "asdk_app_intermittentlimit";
    const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const limited = { status: 429, message: "Too many requests" };
    const requestClient = {
      safeGet: vi
        .fn()
        .mockRejectedValueOnce(limited)
        .mockResolvedValueOnce({ messages: [] })
        .mockRejectedValueOnce(limited)
        .mockResolvedValue({ messages: [] }),
      request: vi.fn(),
    };
    globals[key] = { module: {}, requestClient, handled: {}, inFlight: {} };
    const run = new Function(
      `return ${oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", ["conversation"])}`,
    ) as () => Promise<{ nextScanAtUnixMs: number; rateLimit?: { localBackoffMs: number } }>;
    try {
      expect((await run()).rateLimit?.localBackoffMs).toBe(30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await run()).rateLimit?.localBackoffMs).toBe(30_000);
      await vi.advanceTimersByTimeAsync(5_000);
      const repeated = await run();
      expect(repeated.rateLimit?.localBackoffMs).toBe(30_000);
      expect(repeated.nextScanAtUnixMs).toBe(Date.now() + 30_000);
      await run();
      expect(requestClient.safeGet).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await run()).rateLimit?.localBackoffMs).toBe(30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await run()).rateLimit).toBeUndefined();
    } finally {
      delete globals[key];
      vi.useRealTimers();
    }
  });

  it.each([
    {
      operation: "conversation_read",
      adaptiveRetry: true,
      serverRetryAtUnixMs: undefined,
    },
    {
      operation: "shared_account_cooldown",
      adaptiveRetry: undefined,
      serverRetryAtUnixMs: 2_800_000,
    },
  ])(
    "retires persisted legacy local cooldown state for $operation",
    async ({ operation, adaptiveRetry, serverRetryAtUnixMs }) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      const connectorId = `asdk_app_legacy${operation.replaceAll("_", "")}`;
      const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
      const globals = globalThis as typeof globalThis & Record<string, unknown>;
      const state = {
        module: {},
        requestClient: { safeGet: vi.fn(), request: vi.fn() },
        handled: {},
        inFlight: {},
        lastScanAt: 0,
        backoffUntil: 2_800_000,
        backoffMs: 1_800_000,
        lastRateLimit: {
          status: 429,
          operation,
          observedAtUnixMs: 1_000_000,
          retryAtUnixMs: 2_800_000,
          localBackoffMs: 1_800_000,
          statusEvidence: "http_status",
          backoffSource: "local_backoff",
          responseHeaders: {},
          ...(adaptiveRetry === undefined ? {} : { adaptiveRetry }),
          ...(serverRetryAtUnixMs === undefined ? {} : { serverRetryAtUnixMs }),
        },
      };
      globals[key] = state;
      try {
        await new Function(
          `return ${oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex")}`,
        )();
        expect(state.backoffUntil).toBe(1_030_000);
        expect(state.backoffMs).toBe(30_000);
        expect(state.lastRateLimit).toMatchObject({
          retryAtUnixMs: 1_030_000,
          localBackoffMs: 30_000,
          backoffSource: "local_backoff",
        });
        expect(state.lastRateLimit).not.toHaveProperty("adaptiveRetry");
        expect(state.lastRateLimit).not.toHaveProperty("serverRetryAtUnixMs");
      } finally {
        delete globals[key];
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { header: "900", wait: 900_000, serverWait: 900_000 },
    { header: undefined, wait: 30_000, serverWait: undefined },
    { header: "invalid", wait: 30_000, serverWait: undefined },
    { header: " 12.5 ", wait: 30_000, serverWait: 12_500 },
    { header: new Date(2_200_000).toUTCString(), wait: 1_200_000, serverWait: 1_200_000 },
  ])(
    "preserves the runtime and distinguishes server cooldown from local backoff for $header",
    async ({ header, wait, serverWait }) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      const connectorId = "asdk_app_bootstraplimit";
      const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
      const globals = globalThis as typeof globalThis & Record<string, unknown>;
      const fetchMock = vi.fn(
        async () =>
          new Response("Too many requests", {
            status: 429,
            headers: header === undefined ? {} : { "Retry-After": header },
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      try {
        const run = new Function(
          `return ${oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", [
            "conversation",
          ])}`,
        ) as () => Promise<unknown>;
        const first = await run();
        expect(first).toMatchObject({
          outcome: "partial",
          nextScanAtUnixMs: 1_000_000 + wait,
          rateLimit: {
            status: 429,
            operation: "runtime_initialization",
            observedAtUnixMs: 1_000_000,
            localBackoffMs: 30_000,
            statusEvidence: "http_status",
            backoffSource:
              serverWait !== undefined && serverWait >= 30_000
                ? "server_retry_after"
                : "local_backoff",
          },
        });
        const diagnostic = (first as { rateLimit: Record<string, unknown> }).rateLimit;
        expect(diagnostic.serverRetryAtUnixMs).toBe(
          serverWait === undefined ? undefined : 1_000_000 + serverWait,
        );
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(run()).resolves.toMatchObject({
          nextScanAtUnixMs: 1_000_000 + wait,
          rateLimit: diagnostic,
        });
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(globals[key]).toBeDefined();
      } finally {
        delete globals[key];
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    },
  );

  it("submits one approval when overlapping scans finish preparation together", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const connectorId = "asdk_app_overlapping";
    const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let firstEntered!: () => void;
    let secondEntered!: () => void;
    const firstPreparing = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const secondPreparing = new Promise<void>((resolve) => {
      secondEntered = resolve;
    });
    let preparations = 0;
    let committedMessage: unknown;
    const requestClient = {
      safeGet: vi.fn(async () => ({
        current_node: "pending",
        messages: [
          { id: "target", metadata: { connector_name: "OmniCodex" } },
          {
            id: "pending",
            metadata: {
              jit_plugin_data: {
                from_server: {
                  type: "confirm_action",
                  body: {
                    actions: [
                      {
                        type: "always_allow",
                        always_allow: {
                          type: "always_allow",
                          target_message_id: "target",
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
          ...(committedMessage ? [committedMessage] : []),
        ],
      })),
      request: vi.fn(async () => ({ status: 200 })),
    };
    const state = {
      module: {
        Eo: async () => {
          preparations += 1;
          if (preparations === 1) firstEntered();
          if (preparations === 2) secondEntered();
          await preparation;
          return {};
        },
        Fo: async () => undefined,
        Ao: () => ({}),
        Uo: { getEnforcementToken: async () => "proof" },
        zo: { getEnforcementToken: async () => "turnstile" },
      },
      requestClient,
      handled: {},
      inFlight: {},
      drains: new Set(),
    };
    globals[key] = state;
    try {
      const run = new Function(
        `return ${oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", ["conversation"])}`,
      ) as () => Promise<{ receipts: unknown[] }>;
      const first = run();
      await firstPreparing;
      // A slow preparation outlives the normal scan cadence. Both scans have
      // read the same pending node before either commits its submission identity.
      await vi.advanceTimersByTimeAsync(6_000);
      const second = run();
      await secondPreparing;
      releasePreparation();
      const results = await Promise.all([first, second]);
      expect(results.every((result) => result.receipts.length === 0)).toBe(true);
      expect(requestClient.request).toHaveBeenCalledOnce();
      expect(Object.keys(state.inFlight)).toHaveLength(1);
      const submitted = requestClient.request.mock.calls[0] as unknown as [
        string,
        string,
        { requestBody: { messages: unknown[] } },
      ];
      committedMessage = submitted[2].requestBody.messages.at(-1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await run()).receipts).toHaveLength(1);
      expect(requestClient.request).toHaveBeenCalledOnce();
      expect(state.inFlight).toEqual({});
    } finally {
      releasePreparation();
      delete globals[key];
      vi.useRealTimers();
    }
  });

  it("retains a rejected approval for retry without treating HTTP 429 as an accepted submission", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const connectorId = "asdk_app_postlimit";
    const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    let committedMessage: unknown;
    const requestClient = {
      safeGet: vi.fn(async () => ({
        current_node: "pending",
        messages: [
          { id: "target", metadata: { connector_name: "OmniCodex" } },
          {
            id: "pending",
            metadata: {
              jit_plugin_data: {
                from_server: {
                  type: "confirm_action",
                  body: {
                    actions: [
                      {
                        type: "always_allow",
                        always_allow: {
                          type: "always_allow",
                          target_message_id: "target",
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
          ...(committedMessage ? [committedMessage] : []),
        ],
      })),
      request: vi
        .fn()
        .mockResolvedValueOnce(
          new Response("Too many requests", {
            status: 429,
            headers: { "Retry-After": "600", "x-request-id": "rejected-approval" },
          }),
        )
        .mockImplementationOnce(async (_method, _path, options) => {
          committedMessage = options.requestBody.messages.at(-1);
          return { status: 200 };
        }),
    };
    const state = {
      module: {
        Eo: async () => ({}),
        Fo: async () => undefined,
        Ao: () => ({}),
        Uo: { getEnforcementToken: async () => "proof" },
        zo: { getEnforcementToken: async () => "turnstile" },
      },
      requestClient,
      handled: {},
      inFlight: {},
      drains: new Set(),
    };
    globals[key] = state;
    try {
      const run = new Function(
        `return ${oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", ["conversation"])}`,
      ) as () => Promise<{ receipts: unknown[] }>;
      const first = await run();
      expect(first).toMatchObject({
        outcome: "partial",
        receipts: [],
        followUpScanRequired: true,
        nextScanAtUnixMs: 1_600_000,
        rateLimit: {
          status: 429,
          statusEvidence: "http_status",
          serverRetryAtUnixMs: 1_600_000,
          responseHeaders: { "retry-after": "600", "x-request-id": "rejected-approval" },
        },
      });
      expect(state.inFlight).toEqual({});
      expect(requestClient.safeGet).toHaveBeenCalledTimes(2);
      await run();
      expect(requestClient.request).toHaveBeenCalledOnce();
      expect(requestClient.safeGet).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(600_001);
      expect((await run()).receipts).toHaveLength(1);
      expect(requestClient.request).toHaveBeenCalledTimes(2);
      expect(state.inFlight).toEqual({});
    } finally {
      delete globals[key];
      vi.useRealTimers();
    }
  });

  it.each([403, 408, 502])(
    "reports raw HTTP %s without inventing acceptance or duplicating an uncertain submission",
    async (status) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      const connectorId = "asdk_app_httpfailure";
      const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
      const globals = globalThis as typeof globalThis & Record<string, unknown>;
      let committed = false;
      let clientMessage: unknown;
      const requestClient = {
        safeGet: vi.fn(async () => ({
          current_node: "pending",
          messages: [
            { id: "target", metadata: { connector_name: "OmniCodex" } },
            {
              id: "pending",
              metadata: {
                jit_plugin_data: {
                  from_server: {
                    type: "confirm_action",
                    body: {
                      actions: [
                        {
                          type: "always_allow",
                          always_allow: {
                            type: "always_allow",
                            target_message_id: "target",
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
            ...(committed && clientMessage ? [clientMessage] : []),
          ],
        })),
        request: vi.fn(async (_method, _path, options) => {
          clientMessage = options.requestBody.messages.at(-1);
          if (committed) return { status: 200 };
          return new Response("Upstream failure", {
            status,
            headers: { "x-request-id": "failed-post", "set-cookie": "private" },
          });
        }),
      };
      const state = {
        module: {
          Eo: async () => ({}),
          Fo: async () => undefined,
          Ao: () => ({}),
          Uo: { getEnforcementToken: async () => "proof" },
          zo: { getEnforcementToken: async () => "turnstile" },
        },
        requestClient,
        handled: {},
        inFlight: {},
        drains: new Set(),
      };
      globals[key] = state;
      try {
        const run = new Function(
          `return ${oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", ["conversation"])}`,
        ) as () => Promise<{ receipts: unknown[]; errors: unknown[] }>;
        const first = await run();
        expect(first).toMatchObject({
          outcome: "partial",
          receipts: [],
          followUpScanRequired: true,
          errors: [
            {
              conversationId: "conversation",
              error: `Error:chatgpt_approval_http_${status}`,
              status,
              operation: "approval_submission",
              observedAtUnixMs: 1_000_000,
              responseHeaders: { "x-request-id": "failed-post" },
            },
          ],
        });
        expect(requestClient.safeGet).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(first)).not.toContain("private");
        const uncertain = status === 408 || status >= 500;
        expect(Object.keys(state.inFlight)).toHaveLength(uncertain ? 1 : 0);
        if (uncertain) {
          await vi.advanceTimersByTimeAsync(5_000);
          const waiting = await run();
          expect(waiting).toMatchObject({ outcome: "partial", receipts: [], errors: first.errors });
          expect(requestClient.request).toHaveBeenCalledOnce();
        }
        committed = true;
        await vi.advanceTimersByTimeAsync(5_000);
        expect((await run()).receipts).toHaveLength(1);
        expect(requestClient.request).toHaveBeenCalledOnce();
        expect(state.inFlight).toEqual({});
      } finally {
        delete globals[key];
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { responseMode: "accepted", nativeReply: false },
    { responseMode: "response_lost", nativeReply: false },
    { responseMode: "accepted", nativeReply: true },
    { responseMode: "response_lost", nativeReply: true },
  ])(
    "preserves native approval continuation and delayed receipt ($responseMode, self-targeted=$nativeReply)",
    async ({ responseMode, nativeReply }) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      const connectorId = "asdk_app_delayedreceipt";
      const key = `__omnicodexOracleServerApprovalV2:${connectorId}`;
      const globals = globalThis as typeof globalThis & Record<string, unknown>;
      const persistedState = new Map<string, string>();
      vi.stubGlobal("localStorage", {
        getItem: (name: string) => persistedState.get(name) ?? null,
        setItem: (name: string, value: string) => persistedState.set(name, value),
      });
      let committed = false;
      let clientMessage: unknown;
      const targetMessageId = nativeReply ? "pending" : "target";
      const pending = {
        id: "pending",
        author: { name: "api_tool.call_tool", role: "tool" },
        metadata: {
          working_turn_id: "original-pro-turn",
          connector_name: "OmniCodex",
          jit_plugin_data: {
            from_server: {
              type: "confirm_action",
              body: {
                ...(nativeReply ? { codex_mcp_elicitation: { kind: "mcpToolCall" } } : {}),
                actions: [
                  {
                    type: "always_allow",
                    always_allow: {
                      type: "always_allow",
                      target_message_id: targetMessageId,
                    },
                  },
                ],
              },
            },
          },
        },
      };
      const requestClient = {
        safeGet: vi.fn(async (path: string) =>
          path === "/conversations"
            ? { items: [{ id: "conversation", current_node: "pending" }] }
            : {
                id: "conversation",
                current_node: "pending",
                default_model_slug: "gpt-5-pro",
                gizmo_id: "original-gizmo",
                messages: [
                  {
                    id: "target",
                    author: { role: "tool" },
                    metadata: { connector_name: "OmniCodex" },
                  },
                  { id: "intermediate-tool-result", author: { role: "tool" } },
                  pending,
                  ...(committed && clientMessage !== undefined ? [clientMessage] : []),
                ],
              },
        ),
        request: vi.fn(
          async (
            _method: string,
            _path: string,
            options: { requestBody: { messages: unknown[]; parent_message_id: string } },
          ) => {
            expect(options.requestBody.parent_message_id).toBe(
              nativeReply ? "intermediate-tool-result" : "pending",
            );
            expect(options.requestBody.messages).toHaveLength(nativeReply ? 2 : 1);
            if (nativeReply) expect(options.requestBody.messages[0]).toEqual(pending);
            clientMessage = options.requestBody.messages.at(-1);
            expect(clientMessage).toMatchObject({
              metadata: {
                ...(nativeReply ? { working_turn_id: "original-pro-turn" } : {}),
                gizmo_id: "original-gizmo",
                jit_plugin_data: {
                  from_client: { type: "always_allow", target_message_id: targetMessageId },
                },
              },
            });
            if (!nativeReply) expect(clientMessage).not.toHaveProperty("metadata.working_turn_id");
            const intent = Object.values(
              (globals[key] as { inFlight: Record<string, unknown> }).inFlight,
            );
            expect(intent).toHaveLength(1);
            expect(intent[0]).toMatchObject({
              clientMessageId: (clientMessage as { id: string }).id,
            });
            expect(Object.values(JSON.parse(persistedState.get(key) ?? "{}").inFlight)).toEqual(
              intent,
            );
            if (responseMode === "response_lost") throw new TypeError("Failed to fetch");
            return { status: 200 };
          },
        ),
      };
      globals[key] = {
        module: {
          Eo: async () => ({}),
          Fo: async () => undefined,
          Ao: () => ({}),
          Uo: { getEnforcementToken: async () => "proof" },
          zo: { getEnforcementToken: async () => "turnstile" },
        },
        requestClient,
        seen: {},
        handled: {},
        inFlight: {},
        initialized: true,
        historicalComplete: true,
        bootstrapQueue: [],
        nextHistoricalRecoveryAt: Date.now() + 120_000,
        drains: new Set(),
      };
      try {
        const run = new Function(
          `return ${oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex", [
            "conversation",
          ])}`,
        ) as () => Promise<{ followUpScanRequired: boolean; receipts: unknown[] }>;
        const initial = await run();
        expect(initial).toMatchObject({
          requestStats: {
            trigger: "queued_request",
            getCount: responseMode === "accepted" ? 3 : 2,
            postCount: 1,
            moduleInitializationCount: 0,
            rateLimitCount: 0,
            conversationIds: ["conversation"],
          },
        });
        expect(initial.followUpScanRequired).toBe(true);
        expect(initial.receipts).toEqual([]);
        // Initial body, pre-dispatch branch check, one readback; no account index.
        expect(requestClient.safeGet).toHaveBeenCalledTimes(responseMode === "accepted" ? 3 : 2);
        expect(requestClient.safeGet).toHaveBeenNthCalledWith(2, "/conversations/conversation", {
          parameters: { query: { include_has_versions: true, num_turns: 1 } },
          disableAutomaticRetry: true,
        });
        expect(requestClient.safeGet).toHaveBeenNthCalledWith(1, "/conversations/conversation", {
          parameters: { query: { include_has_versions: true, num_turns: 1 } },
          disableAutomaticRetry: true,
        });
        expect(requestClient.request).toHaveBeenCalledOnce();
        if (responseMode === "response_lost") {
          const previousRuntime = globals[key] as { module: unknown };
          globals[key] = {
            ...JSON.parse(persistedState.get(key) ?? "{}"),
            module: previousRuntime.module,
            requestClient,
            drains: new Set(),
          };
          expect(initial).toMatchObject({
            outcome: "partial",
            errors: [{ error: "TypeError:Failed to fetch", submissionState: "unknown" }],
          });
          await vi.advanceTimersByTimeAsync(5_000);
          expect(await run()).toMatchObject({ outcome: "partial", receipts: [] });
          expect(requestClient.request).toHaveBeenCalledOnce();
        }
        committed = true;
        await vi.advanceTimersByTimeAsync(5_000);
        const resume = new Function(
          `return ${oracleChatGptServerApprovalScanExpression(connectorId, "OmniCodex")}`,
        ) as () => Promise<{
          followUpScanRequired: boolean;
          receipts: Array<{ clientMessageId: string }>;
        }>;
        const recovered = await resume();
        expect(recovered).toMatchObject({
          requestStats: {
            trigger: "recovery",
            getCount: 1,
            postCount: 0,
            conversationIds: ["conversation"],
          },
        });
        expect(recovered.receipts).toHaveLength(1);
        if (responseMode === "response_lost") {
          expect(recovered.receipts[0]).not.toHaveProperty("responseStatus");
        }
        expect(recovered.followUpScanRequired).toBe(false);
        expect(requestClient.request).toHaveBeenCalledOnce();
        expect(requestClient.safeGet).toHaveBeenCalledTimes(4);
        // The Oracle readback can commit before its CDP response reaches the
        // daemon. Re-adopting that renderer must recover the same receipt,
        // without resubmitting approval or reading the account again.
        const previousRuntime = globals[key] as { module: unknown };
        globals[key] = {
          ...JSON.parse(persistedState.get(key) ?? "{}"),
          module: previousRuntime.module,
          requestClient,
          drains: new Set(),
        };
        expect((await resume()).receipts).toEqual(recovered.receipts);
        expect(requestClient.request).toHaveBeenCalledOnce();
        expect(requestClient.safeGet).toHaveBeenCalledTimes(4);
        const acknowledge = new Function(
          `return ${oracleChatGptServerApprovalScanExpression(
            connectorId,
            "OmniCodex",
            [],
            recovered.receipts.map((receipt) => receipt.clientMessageId),
          )}`,
        ) as typeof resume;
        expect((await acknowledge()).receipts).toEqual([]);
        expect((await acknowledge()).receipts).toEqual([]);
        expect((await resume()).receipts).toEqual([]);
        expect(requestClient.request).toHaveBeenCalledOnce();
        expect(requestClient.safeGet).toHaveBeenCalledTimes(4);
      } finally {
        delete globals[key];
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    },
  );

  it.each([false, true])(
    "refreshes an invalidated owned authentication once, persistent401=%s",
    async (persistent401) => {
      const connectorId = "asdk_app_omnicodex";
      const conversationId = "550e8400-e29b-41d4-a716-446655440000";
      const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
      let refreshed = false;
      const heldId = "550e8400-e29b-41d4-a716-446655440001";
      let heldEntered = false;
      let releaseHeld!: () => void;
      const heldReply = new Promise<void>((resolve) => {
        releaseHeld = resolve;
      });
      const command = vi.fn(async (method: string, params: unknown) => {
        if (method === "Page.navigate") {
          refreshed = true;
          return {};
        }
        const expression = (params as { expression?: string }).expression;
        if (expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION)
          return { result: { value: true } };
        if (expression?.startsWith("(async function oracleChatGptServerApprovalScan")) {
          if (expression.includes(heldId)) {
            heldEntered = true;
            await heldReply;
          }
          const unauthorized = !refreshed || persistent401;
          return {
            result: {
              value: {
                outcome: unauthorized ? "partial" : "ok",
                examined: 1,
                discovered: 0,
                approvalsPending: 0,
                conversationUrls: [],
                receipts: [],
                errors: unauthorized
                  ? [
                      {
                        conversationId,
                        status: 401,
                        operation: "goal_observation",
                        error:
                          "RequestError:Encountered invalidated oauth token for user, failing request",
                      },
                    ]
                  : [],
              },
            },
          };
        }
        throw new Error(`unexpected ${method}`);
      });
      const close = vi.fn();
      const client = new OracleChatGptServerApprovalClient({
        connectorId,
        connectorName: "OmniCodex",
        cdpEndpoint: "http://127.0.0.1:19222",
        transport: {
          adoptOrOpenOwnedApprovalRuntimeTarget: vi.fn().mockResolvedValue({
            id: "owned-runtime",
            type: "page",
            url: oracleChatGptApprovalRuntimeUrl(connectorId),
          }),
          closeOwnedTarget: vi.fn(),
        } as never,
        connectSession: vi.fn().mockResolvedValue({ command, close } as never),
      });
      const signal = new AbortController().signal;
      const held = client.observeGoalConversation(`https://chatgpt.com/c/${heldId}`, signal);
      await vi.waitFor(() => expect(heldEntered).toBe(true));
      const first = await client.observeGoalConversation(conversationUrl, signal);
      expect(first.errors[0]?.status).toBe(401);
      expect(command.mock.calls.filter(([method]) => method === "Page.navigate")).toHaveLength(0);
      const next = client.observeGoalConversation(conversationUrl, signal);
      await Promise.resolve();
      expect(command.mock.calls.filter(([method]) => method === "Page.navigate")).toHaveLength(0);
      releaseHeld();
      await held;
      const second = await next;
      expect(second.outcome).toBe(persistent401 ? "partial" : "ok");
      await client.observeGoalConversation(conversationUrl, signal);
      expect(command.mock.calls.filter(([method]) => method === "Page.navigate")).toHaveLength(1);
      expect(command).toHaveBeenCalledWith(
        "Page.navigate",
        { url: oracleChatGptApprovalRuntimeUrl(connectorId) },
        signal,
        60_000,
      );
      await client.stop();
    },
  );

  it("does not reload an adopted exact approval runtime", async () => {
    const connectorId = "asdk_app_omnicodex";
    const connectorName = "OmniCodex";
    const target = {
      id: "adopted-runtime",
      type: "page",
      url: oracleChatGptApprovalRuntimeUrl(connectorId),
      webSocketDebuggerUrl: "ws://127.0.0.1:19222/devtools/page/adopted-runtime",
    } as const;
    const command = vi.fn(async (method: string, params: unknown) => {
      const expression = (params as { expression?: string }).expression;
      if (expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION) {
        return { result: { value: true } };
      }
      if (
        withoutTelemetry(expression) ===
        oracleChatGptServerApprovalScanExpression(connectorId, connectorName)
      ) {
        return {
          result: {
            value: {
              outcome: "ok",
              examined: 0,
              discovered: 0,
              approvalsPending: 0,
              conversationUrls: [],
              receipts: [],
              errors: [],
            },
          },
        };
      }
      throw new Error(`unexpected ${method}`);
    });
    const client = new OracleChatGptServerApprovalClient({
      connectorId,
      connectorName,
      cdpEndpoint: "http://127.0.0.1:19222",
      transport: {
        adoptOrOpenOwnedApprovalRuntimeTarget: vi.fn().mockResolvedValue(target),
        closeOwnedTarget: vi.fn(),
      } as never,
      connectSession: vi.fn().mockResolvedValue({ command, close: vi.fn() } as never),
    });

    await expect(client.scan(new AbortController().signal)).resolves.toMatchObject({
      outcome: "ok",
    });
    expect(command.mock.calls.some(([method]) => method === "Page.navigate")).toBe(false);
    await client.stop();
  });
});
