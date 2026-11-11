import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatAccountRequestCoordinator } from "../src/application/chat-account-request-coordinator.js";
import { OracleChatGptServerApprovalClient } from "../src/infrastructure/chatgpt/oracle-chatgpt-server-approval-client.js";
import {
  ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION,
  ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION,
  oracleChatGptApprovalRuntimeUrl,
  oracleChatGptServerApprovalScanExpression,
} from "../src/infrastructure/chatgpt/oracle-chatgpt-server-approval-script.js";

const connector = "asdk_app_recoveryadmission";
const key = `__omnicodexOracleServerApprovalV2:${connector}`;
const globals = globalThis as typeof globalThis & Record<string, unknown>;

describe("Goal startup recovery admission", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (name: string) => saved.get(name) ?? null,
      setItem: (name: string, value: string) => saved.set(name, value),
    });
  });
  afterEach(() => {
    delete globals[key];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const scan = (ids: string[], recovery = false) =>
    new Function(
      `return ${oracleChatGptServerApprovalScanExpression(
        connector,
        "OmniCodex",
        ids,
        [],
        recovery ? { recoveryConversationIds: ids } : undefined,
      )}`,
    )() as Promise<unknown>;

  it("keeps a confirmed deletion across restart recovery but allows fresh exact activity", async () => {
    const safeGet = vi.fn(async () => {
      throw Object.assign(new Error("Conversation has been deleted. Start a new chat."), {
        status: 404,
      });
    });
    const requestClient = { safeGet, request: vi.fn() };
    globals[key] = { module: {}, requestClient, handled: {}, inFlight: {} };
    await scan(["deleted"]);
    expect(safeGet).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
    expect(saved.deletedConversations.deleted.status).toBe(404);
    globals[key] = { ...saved, module: {}, requestClient };
    for (let reconnect = 0; reconnect < 3; reconnect++) {
      await vi.advanceTimersByTimeAsync(5_000);
      await scan(["deleted"], true);
    }
    expect(safeGet).toHaveBeenCalledTimes(1);
    await scan(["deleted"]);
    expect(safeGet).toHaveBeenCalledTimes(2);
    expect(requestClient.request).not.toHaveBeenCalled();
  });

  it("does not reset an already pending Goal recovery revision or read deadline", async () => {
    const requestClient = { safeGet: vi.fn(), request: vi.fn() };
    globals[key] = {
      module: {},
      requestClient,
      handled: {},
      inFlight: {},
      pendingConversations: { pending: true },
      pendingConversationRevisions: { pending: "original-revision" },
      activeConversationRecovery: {
        pending: { awaitingGoalCompletion: true, nextReadAt: 2_000_000, attempts: 4 },
      },
    };
    await scan(["pending"], true);
    const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
    expect(saved.pendingConversationRevisions.pending).toBe("original-revision");
    expect(saved.activeConversationRecovery.pending).toEqual({
      awaitingGoalCompletion: true,
      nextReadAt: 2_000_000,
      attempts: 4,
    });
    expect(requestClient.safeGet).not.toHaveBeenCalled();
  });

  it("prunes paused Goal recovery while preserving active Goals and uncertain approvals", async () => {
    const safeGet = vi.fn();
    const uncertain = { conversationId: "uncertain", clientMessageId: "client" };
    globals[key] = {
      module: {},
      requestClient: { safeGet, request: vi.fn() },
      handled: {},
      inFlight: { submission: uncertain },
      lastScanAt: 999_000,
      pendingConversations: { paused: true, active: true, uncertain: false },
      pendingConversationRevisions: {
        paused: "paused-revision",
        active: "active-revision",
        uncertain: "uncertain-revision",
      },
      activeConversationRecovery: {
        paused: { awaitingGoalCompletion: true, nextReadAt: 0 },
        active: { awaitingGoalCompletion: true, nextReadAt: 2_000_000 },
        uncertain: { awaitingGoalCompletion: true, nextReadAt: 0 },
      },
      goalBodyRecovery: { paused: { body: true }, active: { body: true } },
    };
    await new Function(
      `return ${oracleChatGptServerApprovalScanExpression(connector, "OmniCodex", [], [], {
        activeGoalConversationIds: ["active"],
      })}`,
    )();
    const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
    expect(saved.activeConversationRecovery).toEqual({
      active: { awaitingGoalCompletion: true, nextReadAt: 2_000_000 },
    });
    expect(saved.pendingConversations).toEqual({ active: true, uncertain: false });
    expect(saved.pendingConversationRevisions).toEqual({
      active: "active-revision",
      uncertain: "uncertain-revision",
    });
    expect(saved.inFlight.submission).toEqual(uncertain);
    expect(safeGet).not.toHaveBeenCalled();
  });

  it("retires stale deleted-conversation queue state without discarding uncertain submissions", async () => {
    const safeGet = vi.fn();
    const submission = { conversationId: "deleted", clientMessageId: "uncertain" };
    globals[key] = {
      module: {},
      requestClient: { safeGet },
      handled: {},
      inFlight: { original: submission },
      deletedConversations: { deleted: { status: 404 } },
      pendingConversations: { deleted: true },
      pendingConversationRevisions: { deleted: "old" },
      activeConversationRecovery: { deleted: { awaitingGoalCompletion: true, nextReadAt: 0 } },
    };
    const result = await scan([]);
    expect(result).toMatchObject({ followUpScanRequired: false, examined: 0 });
    const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
    expect(saved.pendingConversations).toEqual({});
    expect(saved.activeConversationRecovery).toEqual({});
    expect(saved.inFlight.original).toEqual(submission);
    expect(safeGet).not.toHaveBeenCalled();
  });

  it("does not resurrect a deletion from a delayed final notification", async () => {
    const safeGet = vi.fn();
    globals[key] = {
      module: {},
      requestClient: { safeGet, request: vi.fn() },
      handled: {},
      inFlight: {},
      deletedConversations: { deleted: { status: 404 } },
    };
    await new Function(
      `return ${oracleChatGptServerApprovalScanExpression(connector, "OmniCodex", ["deleted"], [], {
        goalCompletionReceipts: ["deleted"],
        goalCompletionFinalIds: { deleted: ["late-final"] },
      })}`,
    )();
    const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
    expect(saved.deletedConversations.deleted.status).toBe(404);
    expect(saved.pendingConversations).toEqual({});
    expect(saved.activeConversationRecovery).toEqual({});
    expect(safeGet).not.toHaveBeenCalled();
  });

  it("admits an exact approval even when the same wake includes deleted Goal recovery", async () => {
    const safeGet = vi.fn(async () => ({ messages: [] }));
    globals[key] = {
      module: {},
      requestClient: { safeGet, request: vi.fn() },
      handled: {},
      inFlight: {},
      deletedConversations: { revived: { status: 404 } },
    };
    await new Function(
      `return ${oracleChatGptServerApprovalScanExpression(connector, "OmniCodex", ["revived"], [], {
        recoveryConversationIds: ["revived"],
        expectedApprovals: [
          { conversationId: "revived", pendingMessageId: "approval", targetMessageIds: ["tool"] },
        ],
      })}`,
    )();
    expect(safeGet).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
    expect(saved.deletedConversations).toEqual({});
    expect(saved.expectedApprovals.revived.approval).toEqual(["tool"]);
  });

  it("restores the active Goal allowlist without reading it until fresh activity arrives", async () => {
    const url = "https://chatgpt.com/c/550e8400-e29b-41d4-a716-446655440000";
    const expressions: string[] = [];
    const client = new OracleChatGptServerApprovalClient({
      connectorId: connector,
      connectorName: "OmniCodex",
      cdpEndpoint: "http://127.0.0.1:9222",
      conversationEvents: {
        ensureConnected: vi.fn(async () => true),
        stop: vi.fn(async () => {}),
      },
      recoverGoalConversations: async () => [url],
      transport: {
        adoptOrOpenOwnedApprovalRuntimeTarget: async () => ({
          id: "runtime",
          url: oracleChatGptApprovalRuntimeUrl(connector),
        }),
      } as never,
      connectSession: async () =>
        ({
          close: vi.fn(),
          command: async (_method: string, params: { expression: string }) => {
            if (params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION)
              return { result: { value: true } };
            expressions.push(params.expression);
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
          },
        }) as never,
    });
    const signal = new AbortController().signal;
    await client.scan(signal);
    const withoutTelemetry = (value: string) =>
      value.replace(/"telemetryId":"[a-f0-9-]+",?/g, "").replace(/,\{\}\)$/, ")");
    const initialExpression = expressions[0];
    if (initialExpression === undefined) throw new Error("initial scan expression missing");
    expect(withoutTelemetry(initialExpression)).toContain(
      '"activeGoalConversationIds":["550e8400-e29b-41d4-a716-446655440000"]',
    );
    expect(withoutTelemetry(initialExpression)).not.toContain('"recoveryConversationIds"');
    client.requestScan(url);
    await client.scan(signal);
    const activityExpression = expressions[1];
    if (activityExpression === undefined) throw new Error("activity scan expression missing");
    expect(withoutTelemetry(activityExpression)).toBe(
      oracleChatGptServerApprovalScanExpression(
        connector,
        "OmniCodex",
        ["550e8400-e29b-41d4-a716-446655440000"],
        [],
        {
          activeGoalConversationIds: ["550e8400-e29b-41d4-a716-446655440000"],
        },
      ),
    );
    await client.stop();
  });

  function eventFailureFixture(coordinator: ChatAccountRequestCoordinator) {
    const urls = ["https://chatgpt.com/c/known-a", "https://chatgpt.com/c/known-b"];
    let account = "chatgpt:A:U";
    let connected = false;
    let current = {
      id: "final",
      authorRole: "assistant",
      status: "finished_successfully",
      channel: "final",
      endTurn: true,
    };
    const exactReads: string[] = [];
    const onGoals = vi.fn(async () => {});
    const checkpoint = {
      goalId: "550e8400-e29b-41d4-a716-446655440000",
      revision: 1,
      settledMessageId: "prior",
    };
    const reserve = vi.fn((id: string, interval: number) =>
      coordinator.reserveBackgroundRequest(id, interval),
    );
    const client = new OracleChatGptServerApprovalClient({
      connectorId: connector,
      connectorName: "OmniCodex",
      cdpEndpoint: "http://127.0.0.1:9222",
      conversationEvents: {
        ensureConnected: async () => {
          if (!connected) throw new Error("ORACLE_NATIVE_CONVERSATIONS_SUBSCRIPTION_NOT_READY");
          return false;
        },
        stop: async () => {},
      },
      accountCooldown: {
        read: (id) => coordinator.readCooldown(id),
        observe: (id, value) => coordinator.observeCooldown(id, value),
        reserveBackgroundRequest: reserve,
      },
      recoverGoalConversations: async () => [...urls, "https://chatgpt.com/c/without-checkpoint"],
      captureGoalCheckpoints: async () =>
        urls.map((conversationUrl) => ({ conversationUrl, checkpoint })),
      onGoalConversations: onGoals,
      transport: {
        adoptOrOpenOwnedApprovalRuntimeTarget: async () => ({
          id: "runtime",
          url: oracleChatGptApprovalRuntimeUrl(connector),
        }),
      } as never,
      connectSession: async () =>
        ({
          close: vi.fn(),
          command: async (_method: string, { expression }: { expression: string }) => {
            if (expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION)
              return { result: { value: true } };
            if (expression === ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION)
              return { result: { value: account } };
            const url = urls.find(
              (url) =>
                expression ===
                oracleChatGptServerApprovalScanExpression(
                  connector,
                  "OmniCodex",
                  [url.split("/").at(-1) as string],
                  [],
                  { observeGoalsOnly: true },
                ),
            );
            if (url !== undefined) exactReads.push(url);
            return {
              result: {
                value: {
                  outcome: "ok",
                  examined: url ? 1 : 0,
                  discovered: 0,
                  approvalsPending: 0,
                  receipts: [],
                  conversationUrls: [],
                  errors: [],
                  ...(url
                    ? { goalConversations: [{ conversationUrl: url, goals: [], current }] }
                    : {}),
                },
              },
            };
          },
        }) as never,
    });
    return {
      client,
      urls,
      exactReads,
      onGoals,
      reserve,
      checkpoint,
      connect: () => {
        connected = true;
      },
      setAccount: (value: string) => {
        account = value;
      },
      stream: () => {
        current = { ...current, status: "in_progress", channel: "analysis", endTurn: false };
      },
    };
  }

  it("recovers one checkpointed Goal per account interval when final events are lost and stops when events recover", async () => {
    const coordinator = new ChatAccountRequestCoordinator();
    const first = eventFailureFixture(coordinator);
    const second = eventFailureFixture(coordinator);
    const signal = new AbortController().signal;
    try {
      await first.client.scan(signal);
      await second.client.scan(signal);
      expect(first.exactReads).toEqual([first.urls[0]]);
      expect(second.exactReads).toEqual([]);
      expect(first.onGoals).toHaveBeenCalledWith([
        expect.objectContaining({
          conversationUrl: first.urls[0],
          checkpoint: first.checkpoint,
          source: { kind: "web", accountSourceId: "chatgpt:A:U" },
          current: expect.objectContaining({ id: "final", endTurn: true }),
        }),
      ]);
      for (let count = 0; count < 20; count++) await first.client.scan(signal);
      expect(first.exactReads).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(120_000);
      first.stream();
      await first.client.scan(signal);
      expect(first.exactReads).toEqual(first.urls);
      expect(first.onGoals).toHaveBeenLastCalledWith([
        expect.objectContaining({
          current: expect.objectContaining({
            status: "in_progress",
            channel: "analysis",
            endTurn: false,
          }),
        }),
      ]);
      first.connect();
      await vi.advanceTimersByTimeAsync(120_000);
      await first.client.scan(signal);
      expect(first.exactReads).toHaveLength(2);
    } finally {
      await Promise.all([first.client.stop(), second.client.stop()]);
    }
  });

  it("does not use a previous account's background slot after login changes", async () => {
    const f = eventFailureFixture(new ChatAccountRequestCoordinator());
    f.reserve.mockImplementation(async () => {
      f.setAccount("chatgpt:B:U");
      return { admitted: true, retryAtUnixMs: Date.now() + 120_000 };
    });
    try {
      await expect(f.client.scan(new AbortController().signal)).rejects.toThrow(
        "ORACLE_CHATGPT_ACCOUNT_SOURCE_CHANGED",
      );
      expect(f.exactReads).toEqual([]);
      expect(f.onGoals).not.toHaveBeenCalled();
    } finally {
      await f.client.stop();
    }
  });

  function nativeRecoveryFixture(
    coordinator: ChatAccountRequestCoordinator,
    connectorId = "asdk_app_nativerecovery",
    withReservation = true,
  ) {
    let account = "chatgpt:A:U";
    let beforeRecovery: (() => Promise<boolean>) | undefined;
    const recover = vi.fn();
    const reserve = vi.fn((id: string, interval: number) =>
      coordinator.reserveBackgroundRequest(id, interval),
    );
    const client = new OracleChatGptServerApprovalClient({
      connectorId,
      connectorName: "OmniCodex",
      cdpEndpoint: "http://127.0.0.1:9222",
      accountCooldown: {
        read: (id) => coordinator.readCooldown(id),
        observe: (id, value) => coordinator.observeCooldown(id, value),
        ...(withReservation ? { reserveBackgroundRequest: reserve } : {}),
      },
      conversationEvents: {
        ensureConnected: async (_onConversation, _signal, beforeNativeRecovery) => {
          beforeRecovery = beforeNativeRecovery;
          return false;
        },
        stop: async () => {},
      },
      transport: {
        adoptOrOpenOwnedApprovalRuntimeTarget: async () => ({
          id: "auth-runtime",
          url: oracleChatGptApprovalRuntimeUrl(connectorId),
        }),
      } as never,
      connectSession: async () =>
        ({
          close: vi.fn(),
          command: async (_method: string, { expression }: { expression: string }) => ({
            result: {
              value:
                expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION
                  ? true
                  : expression === ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION
                    ? account
                    : {
                        outcome: "ok",
                        examined: 0,
                        discovered: 0,
                        approvalsPending: 0,
                        receipts: [],
                        conversationUrls: [],
                        errors: [],
                      },
            },
          }),
        }) as never,
    });
    return {
      client,
      reserve,
      recover,
      setAccount: (value: string) => {
        account = value;
      },
      attempt: async () => {
        const admitted = await beforeRecovery?.();
        if (admitted) recover();
        return admitted;
      },
    };
  }

  it("shares native recovery admission across connectors and suppresses hot probes for 120 seconds", async () => {
    const coordinator = new ChatAccountRequestCoordinator();
    const first = nativeRecoveryFixture(coordinator, "asdk_app_nativefirst");
    const second = nativeRecoveryFixture(coordinator, "asdk_app_nativesecond");
    const signal = new AbortController().signal;
    try {
      await Promise.all([first.client.scan(signal), second.client.scan(signal)]);
      const admitted = await Promise.all([first.attempt(), second.attempt()]);
      expect(admitted.filter(Boolean)).toHaveLength(1);
      expect(first.reserve).toHaveBeenCalledExactlyOnceWith("chatgpt:A:U", 120_000);
      expect(second.reserve).toHaveBeenCalledExactlyOnceWith("chatgpt:A:U", 120_000);
      await vi.advanceTimersByTimeAsync(119_999);
      for (let i = 0; i < 10; i++) {
        expect(await first.attempt()).toBe(false);
        expect(await second.attempt()).toBe(false);
      }
      expect(first.reserve).toHaveBeenCalledOnce();
      expect(second.reserve).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect((await Promise.all([first.attempt(), second.attempt()])).filter(Boolean)).toHaveLength(
        1,
      );
      expect(first.recover.mock.calls.length + second.recover.mock.calls.length).toBe(2);
    } finally {
      await Promise.all([first.client.stop(), second.client.stop()]);
    }
  });

  it("does not admit native recovery without a shared reservation or during account cooldown", async () => {
    const coordinator = new ChatAccountRequestCoordinator();
    const unavailable = nativeRecoveryFixture(coordinator, "asdk_app_noreservation", false);
    const limited = nativeRecoveryFixture(coordinator);
    const signal = new AbortController().signal;
    try {
      await Promise.all([unavailable.client.scan(signal), limited.client.scan(signal)]);
      await coordinator.observeCooldown("chatgpt:A:U", {
        observedAtUnixMs: Date.now(),
        retryAtUnixMs: Date.now() + 300_000,
      });
      expect(await unavailable.attempt()).toBe(false);
      expect(await limited.attempt()).toBe(false);
      expect(unavailable.reserve).not.toHaveBeenCalled();
      expect(limited.reserve).not.toHaveBeenCalled();
      expect(unavailable.recover).not.toHaveBeenCalled();
      expect(limited.recover).not.toHaveBeenCalled();
    } finally {
      await Promise.all([unavailable.client.stop(), limited.client.stop()]);
    }
  });

  it.each(["account change", "abort"])(
    "does not admit native recovery after %s while the shared reservation is pending",
    async (change) => {
      const f = nativeRecoveryFixture(new ChatAccountRequestCoordinator());
      const controller = new AbortController();
      let admit!: (value: { admitted: boolean; retryAtUnixMs: number }) => void;
      f.reserve.mockImplementation(
        () =>
          new Promise((resolve) => {
            admit = resolve;
          }),
      );
      try {
        await f.client.scan(controller.signal);
        const pending = f.attempt();
        await vi.waitFor(() => expect(f.reserve).toHaveBeenCalledOnce());
        expect(await f.attempt()).toBe(false);
        expect(f.reserve).toHaveBeenCalledOnce();
        let outcome: Promise<unknown>;
        if (change === "account change") {
          f.setAccount("chatgpt:B:V");
          outcome = expect(pending).resolves.toBe(false);
        } else {
          controller.abort(new Error("cancel native recovery"));
          outcome = expect(pending).rejects.toThrow("cancel native recovery");
        }
        admit({ admitted: true, retryAtUnixMs: Date.now() + 120_000 });
        await outcome;
        expect(f.recover).not.toHaveBeenCalled();
      } finally {
        await f.client.stop();
      }
    },
  );
});
