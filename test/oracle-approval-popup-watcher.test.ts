import { afterEach, describe, expect, it, vi } from "vitest";
import type { OracleApprovalRunScope } from "../src/application/oracle-active-run-registry.js";
import {
  type OracleApprovalPopupEvent,
  OracleApprovalPopupWatcher,
  type OracleApprovalPopupWatcherOptions,
  oracleApprovalWatcherEventRequiresTunnelRecovery,
  oracleApprovalWatcherRequiresTunnelRecovery,
  selectApprovalControl,
} from "../src/application/oracle-approval-popup-watcher.js";
import {
  type BoundedCdpSession,
  type CdpTarget,
  ORACLE_APPROVAL_CONTROL_POINT_FUNCTION,
  ORACLE_APPROVAL_CONTROL_SNAPSHOT_EXPRESSION,
} from "../src/infrastructure/chatgpt/chatgpt-cdp-transport.js";
import { OracleApprovalTelemetryError } from "../src/infrastructure/chatgpt/oracle-chatgpt-server-approval-client.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("selectApprovalControl", () => {
  it("recycles the tunnel only for transport failures, not one renderer failure", () => {
    expect(oracleApprovalWatcherRequiresTunnelRecovery("fetch failed")).toBe(true);
    expect(
      oracleApprovalWatcherRequiresTunnelRecovery(
        "ORACLE_SERVER_APPROVAL_SESSION_FAILED:CDP_CONNECTION_LOST",
      ),
    ).toBe(false);
    expect(
      oracleApprovalWatcherRequiresTunnelRecovery(
        "ORACLE_SERVER_APPROVAL_PARTIAL:RequestError:Too many requests",
      ),
    ).toBe(false);
    expect(
      oracleApprovalWatcherRequiresTunnelRecovery(
        "ORACLE_SERVER_APPROVAL_EVALUATION_EXCEPTION:RequestError:Failed to fetch",
      ),
    ).toBe(false);
    expect(oracleApprovalWatcherRequiresTunnelRecovery("CDP request timeout:GET:/json/list")).toBe(
      false,
    );
    expect(
      oracleApprovalWatcherRequiresTunnelRecovery("CDP request timeout:GET:/json/version"),
    ).toBe(false);
    expect(
      oracleApprovalWatcherRequiresTunnelRecovery(
        "ORACLE_APPROVAL_TARGET_SCAN_FAILED:CDP command timeout:DOM.performSearch",
      ),
    ).toBe(false);
    expect(
      oracleApprovalWatcherRequiresTunnelRecovery(
        "ORACLE_APPROVAL_ACTIVATION_FAILED:CDP command timeout:Input.dispatchMouseEvent",
      ),
    ).toBe(false);
    expect(
      oracleApprovalWatcherRequiresTunnelRecovery("CDP command timeout:Runtime.evaluate"),
    ).toBe(false);
    expect(
      oracleApprovalWatcherRequiresTunnelRecovery("The operation was aborted due to timeout"),
    ).toBe(false);
    expect(oracleApprovalWatcherRequiresTunnelRecovery("CDP session closed")).toBe(true);
  });

  it("never recycles the shared tunnel for a target-local renderer failure", () => {
    expect(
      oracleApprovalWatcherEventRequiresTunnelRecovery({
        targetId: "renderer-target",
        error: "CDP session closed",
      }),
    ).toBe(false);
    expect(oracleApprovalWatcherEventRequiresTunnelRecovery({ error: "CDP session closed" })).toBe(
      true,
    );
    expect(
      oracleApprovalWatcherEventRequiresTunnelRecovery({
        error: "CDP command timeout:Runtime.evaluate",
      }),
    ).toBe(false);
  });

  it("selects Always allow ahead of Connect without accepting Allow once", () => {
    const selected = selectApprovalControl([
      node("connect", "Connect", true),
      node("always", "Always allow", true),
      node("once", "Allow once", true),
    ]);
    expect(selected).toMatchObject({ node: { ref: "always" }, strength: "persistent" });
  });

  it("ignores buttons outside the exact OmniCodex app scope", () => {
    expect(selectApprovalControl([node("foreign", "Always allow", false)])).toBeUndefined();
  });

  it("fails closed when two equally strong controls are visible", () => {
    expect(
      selectApprovalControl([node("one", "Always allow", true), node("two", "항상 허용", true)]),
    ).toBeUndefined();
  });

  it("accepts the requested action within its exact approval scope", () => {
    expect(
      selectApprovalControl([
        {
          ...node("confirm", "Confirm", true),
          scopeText: "OmniCodex needs approval to create the two requested files",
        },
      ]),
    ).toMatchObject({ node: { ref: "confirm" }, strength: "affirmative_once" });
    expect(
      selectApprovalControl([
        {
          ...node("delete", "Confirm", true),
          scopeText: "Confirm permission to delete the existing files",
        },
      ]),
    ).toMatchObject({ node: { ref: "delete" }, strength: "affirmative_once" });
    expect(selectApprovalControl([node("contextless", "Confirm", true)])).toBeUndefined();
  });

  it("accepts the live Korean file-materialization popup contract", () => {
    expect(
      selectApprovalControl([
        {
          ...node("materialize", "허용하기", true),
          scopeText:
            "OmniCodex 파일 생성을 허용할까요? ChatGPT가 OmniCodex에서 반환된 1개의 파일 첨부를 실제로 생성하려면 승인이 필요합니다. 이는 외부 URL에서 파일 콘텐츠를 다운로드하는 작업을 포함할 수 있습니다.",
        },
      ]),
    ).toMatchObject({ node: { ref: "materialize" }, strength: "affirmative_once" });
    expect(
      selectApprovalControl([
        {
          ...node("once", "한 번만 허용", true),
          scopeText:
            "OmniCodex 파일 생성을 허용할까요? ChatGPT가 OmniCodex에서 반환된 1개의 파일 첨부를 실제로 생성하려면 승인이 필요합니다.",
        },
      ]),
    ).toMatchObject({ node: { ref: "once" }, strength: "affirmative_once" });
  });

  it("opens the exact file-materialization options before accepting the one-shot action", () => {
    const scopeText =
      "OmniCodex 파일 생성을 허용할까요? ChatGPT가 OmniCodex에서 반환된 1개의 파일 첨부를 실제로 생성하려면 승인이 필요합니다.";
    expect(
      selectApprovalControl([
        { ...node("allow", "허용하기", true), scopeText },
        { ...node("options", "file materialization options", true), scopeText },
      ]),
    ).toMatchObject({ node: { ref: "options" }, strength: "materialization_options" });
  });

  it("selects the persistent menu item after opening materialization options", () => {
    const scopeText =
      "OmniCodex Allow file materialization? ChatGPT needs your approval to materialize 1 file attachment returned by OmniCodex.";
    expect(
      selectApprovalControl([
        { ...node("allow", "Allow", true), scopeText },
        { ...node("always", "Always allow", true), scopeText },
      ]),
    ).toMatchObject({ node: { ref: "always" }, strength: "persistent" });
  });

  it("accepts ChatGPT's observed conversation-scoped persistent menu item", () => {
    const scopeText =
      "OmniCodex 파일 생성을 허용할까요? ChatGPT가 OmniCodex에서 반환된 1개의 파일 첨부를 실제로 생성하려면 승인이 필요합니다.";
    expect(
      selectApprovalControl([
        {
          ...node("persistent", "Allow OmniCodex for this conversation", true),
          scopeText,
        },
      ]),
    ).toMatchObject({ node: { ref: "persistent" }, strength: "persistent" });
  });

  it("accepts persistent consent for the exact app without a verb blacklist", () => {
    expect(
      selectApprovalControl([
        {
          ...node("delete", "Always allow", true),
          scopeText: "OmniCodex requests permission to delete the existing files",
        },
      ]),
    ).toMatchObject({ node: { ref: "delete" }, strength: "persistent" });
  });

  it("approves an exact OmniCodex popup without an active Oracle run", async () => {
    const session = new ApprovalSession({
      scopeName: "OmniCodex needs approval to create the requested files",
      buttonName: "Allow all actions",
    });
    const events = await runWatcher(session);

    expect(session.activationCount).toBe(1);
    expect(events.filter((event) => event.type === "activated")).toEqual([
      {
        type: "activated",
        targetId: TARGET.id,
        conversationUrl: TARGET.url,
        label: "Allow all actions",
        strength: "full_access",
      },
    ]);
    expect(session.commandMethods).not.toContain("DOM.performSearch");
    expect(session.commandMethods).not.toContain("Input.dispatchMouseEvent");
    expect(session.commandMethods).toContain("Runtime.evaluate");
    expect(session.commandMethods).toContain("Runtime.callFunctionOn");
    expect(session.commandMethods).not.toContain("Accessibility.queryAXTree");
  });

  it("exposes live readiness only after a successful scan and stops authoritatively", async () => {
    vi.useFakeTimers();
    const session = new ApprovalSession({
      scopeName: "OmniCodex connected",
      buttonName: "No approval",
    });
    const transport = {
      listChatGptTargetInventory: vi.fn().mockResolvedValue({
        targets: [TARGET],
        connectorTargets: [TARGET],
      }),
    };
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 250,
      transport: transport as never,
      connectSession: async () => session as unknown as BoundedCdpSession,
    });

    expect(watcher.status.state).toBe("stopped");
    watcher.start();
    expect(watcher.status.state).toBe("starting");
    await vi.advanceTimersByTimeAsync(1);
    expect(watcher.status).toMatchObject({ state: "ready", consecutiveFailures: 0 });
    expect(watcher.status.lastSuccessfulScanAt).toBeTypeOf("string");
    await watcher.stop();
    expect(watcher.status.state).toBe("stopped");
  });

  it("approves account conversations before the rendered-DOM fallback and stops that owner", async () => {
    vi.useFakeTimers();
    const serverApprovalClient = {
      acknowledgeReceipts: vi.fn(),
      scan: vi.fn().mockResolvedValue({
        outcome: "ok",
        examined: 1,
        discovered: 1,
        approvalsPending: 1,
        conversationUrls: ["https://chatgpt.com/c/mobile-origin-conversation"],
        errors: [],
        receipts: [
          {
            conversationId: "mobile-origin-conversation",
            conversationUrl: "https://chatgpt.com/c/mobile-origin-conversation",
            pendingMessageId: "pending",
            clientMessageId: "client",
            targetMessageId: "target",
            action: "allow",
            rememberAnswer: true,
            responseStatus: 200,
          },
        ],
      }),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const events: OracleApprovalPopupEvent[] = [];
    const ensureConversationTarget = vi.fn().mockResolvedValue(undefined);
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 250,
      recoveryScanIntervalMs: 5_000,
      serverApprovalClient,
      ensureConversationTarget,
      transport: {
        listChatGptTargetInventory: vi.fn().mockResolvedValue({
          targets: [],
          connectorTargets: [],
        }),
      } as never,
      onEvent: (event) => {
        events.push(event);
      },
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toContainEqual({
      type: "activated",
      conversationUrl: "https://chatgpt.com/c/mobile-origin-conversation",
      label: "Allow OmniCodex for this conversation",
      strength: "persistent",
      receipt: {
        conversationId: "mobile-origin-conversation",
        conversationUrl: "https://chatgpt.com/c/mobile-origin-conversation",
        pendingMessageId: "pending",
        clientMessageId: "client",
        targetMessageId: "target",
        action: "allow",
        rememberAnswer: true,
        responseStatus: 200,
      },
    });
    expect(serverApprovalClient.acknowledgeReceipts).toHaveBeenCalledOnce();
    expect(ensureConversationTarget).toHaveBeenCalledWith(
      "https://chatgpt.com/c/mobile-origin-conversation",
      expect.any(AbortSignal),
    );
    await watcher.stop();
    expect(serverApprovalClient.stop).toHaveBeenCalledOnce();
  });

  it("does not discover or activate file approvals through idle DOM timers", async () => {
    vi.useFakeTimers();
    const session = new ApprovalSession({
      scopeName: "OmniCodex 파일 생성을 허용할까요? 반환된 파일 첨부",
      buttonName: "file materialization options",
    });
    const serverApprovalClient = {
      requestScan: vi.fn(),
      scan: vi.fn().mockResolvedValue({
        outcome: "ok",
        examined: 0,
        discovered: 0,
        approvalsPending: 0,
        conversationUrls: [],
        errors: [],
        receipts: [],
      }),
      stop: vi.fn(),
    };
    const events: OracleApprovalPopupEvent[] = [];
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 250,
      serverApprovalClient,
      transport: {
        listChatGptTargetInventory: vi.fn().mockResolvedValue({
          targets: [TARGET],
          connectorTargets: [TARGET],
        }),
      } as never,
      connectSession: async () => session as unknown as BoundedCdpSession,
      onEvent: (event) => {
        events.push(event);
      },
    });
    try {
      watcher.start();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(serverApprovalClient.requestScan).not.toHaveBeenCalled();
      expect(session.activationAttempts).toBe(0);
      expect(events.filter((event) => event.type === "activated")).toEqual([]);
    } finally {
      await watcher.stop();
    }
  });

  it.each(["mirror", "inventory"])(
    "delivers server receipts while the %s DOM operation remains in flight",
    async (stage) => {
      vi.useFakeTimers();
      const receipt = {
        conversationId: "slow-dom",
        conversationUrl: "https://chatgpt.com/c/slow-dom",
        pendingMessageId: "pending",
        clientMessageId: "client",
        targetMessageId: "target",
        action: "allow" as const,
        rememberAnswer: false,
      };
      let acknowledged = false;
      let scanCount = 0;
      let settled = false;
      let rejectDom!: (reason: Error) => void;
      const slowDom = vi.fn(
        (signal: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            rejectDom = reject;
            signal.addEventListener(
              "abort",
              () => {
                settled = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      );
      const events: OracleApprovalPopupEvent[] = [];
      const ack = vi.fn(() => {
        acknowledged = true;
      });
      const watcher = new OracleApprovalPopupWatcher({
        connectorId: "connector",
        connectorName: "OmniCodex",
        resource: "https://example.test/mcp/full",
        surface: "/mcp/full",
        cdpEndpoint: "http://127.0.0.1:9222",
        pollIntervalMs: 250,
        serverApprovalClient: {
          scan: vi.fn(async () => ({
            outcome: "ok" as const,
            examined: 0,
            discovered: 0,
            approvalsPending: 0,
            errors: [],
            conversationUrls: [receipt.conversationUrl],
            receipts: ++scanCount > 1 && !acknowledged ? [receipt] : [],
          })),
          acknowledgeReceipts: ack,
          stop: vi.fn(async () => {}),
        },
        ensureConversationTarget:
          stage === "mirror" ? async (_url, signal) => slowDom(signal) : async () => {},
        transport: {
          listChatGptTargetInventory: async (signal: AbortSignal) => {
            if (stage === "inventory") await slowDom(signal);
            return { targets: [], connectorTargets: [] };
          },
        } as never,
        onEvent: (event) => {
          events.push(event);
        },
      });
      try {
        watcher.start();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(settled).toBe(false);
        expect(slowDom).toHaveBeenCalledTimes(1);
        expect(scanCount).toBeGreaterThan(1);
        expect(ack).toHaveBeenCalledExactlyOnceWith([receipt]);
        expect(events.filter((event) => event.type === "activated")).toHaveLength(1);
        rejectDom(new Error("CDP request timeout:GET:/json/list"));
        await vi.advanceTimersByTimeAsync(1);
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "watcher_error",
            error: "CDP request timeout:GET:/json/list",
          }),
        );
        expect(watcher.status).toMatchObject({ state: "degraded", consecutiveFailures: 1 });
      } finally {
        await watcher.stop();
      }
      expect(settled).toBe(true);
    },
  );

  it.each(["busy", "error", "cancel"])(
    "retains the durable receipt after %s UI synchronization without blocking other approvals",
    async (outcome) => {
      vi.useFakeTimers();
      const receipt: NonNullable<OracleApprovalPopupEvent["receipt"]> = {
        conversationId: "receipt-conversation",
        conversationUrl: "https://chatgpt.com/c/receipt-conversation",
        pendingMessageId: "pending",
        clientMessageId: "client",
        targetMessageId: "target",
        action: "allow" as const,
        rememberAnswer: false,
        responseStatus: 200,
      };
      const other = { ...receipt, conversationId: "other", clientMessageId: "other-client" };
      const pending = new Set([receipt, other]);
      const events: OracleApprovalPopupEvent[] = [];
      const acknowledgeReceipts = vi.fn((receipts: (typeof receipt)[]) => {
        for (const entry of receipts) pending.delete(entry);
      });
      const requestScan = vi.fn();
      let release!: (complete: boolean) => void;
      let fail!: (error: Error) => void;
      let attemptSignal: AbortSignal | undefined;
      const synchronizeApprovalReceipt = vi.fn((entry: typeof receipt, signal: AbortSignal) => {
        if (entry === other) return Promise.resolve(true);
        attemptSignal = signal;
        return new Promise<boolean>((resolve, reject) => {
          release = resolve;
          fail = reject;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      });
      let scanCount = 0;
      const options: OracleApprovalPopupWatcherOptions = {
        connectorId: "connector",
        connectorName: "OmniCodex",
        resource: "https://example.test/mcp/full",
        surface: "/mcp/full",
        cdpEndpoint: "http://127.0.0.1:9222",
        pollIntervalMs: 250,
        serverApprovalClient: {
          scan: vi.fn(async () => ({
            outcome: "ok" as const,
            examined: 0,
            discovered: 0,
            approvalsPending: 0,
            conversationUrls: [],
            errors: [],
            receipts: ++scanCount % 4 === 1 ? [...pending] : [],
          })),
          acknowledgeReceipts,
          requestScan,
          stop: vi.fn(async () => {}),
        },
        transport: {
          listChatGptTargetInventory: vi.fn(async () => ({ targets: [], connectorTargets: [] })),
        } as never,
        onEvent: (event: OracleApprovalPopupEvent) => {
          events.push(event);
        },
        synchronizeApprovalReceipt,
      };
      let watcher = new OracleApprovalPopupWatcher(options);
      try {
        watcher.start();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(synchronizeApprovalReceipt).toHaveBeenCalledTimes(2);
        expect(acknowledgeReceipts).toHaveBeenCalledExactlyOnceWith([other]);
        expect(events.filter((event) => event.type === "activated")).toHaveLength(2);
        if (outcome === "cancel") {
          await watcher.stop();
          expect(attemptSignal?.aborted).toBe(true);
          expect(pending.has(receipt)).toBe(true);
          // A fresh watcher recovers the actual unacknowledged outbox entry.
          watcher = new OracleApprovalPopupWatcher({
            ...options,
            synchronizeApprovalReceipt: vi.fn(async () => true),
          });
          watcher.start();
          await vi.advanceTimersByTimeAsync(1_000);
        } else {
          if (outcome === "error") fail(new Error("Tab already part of another browser session"));
          else release(false);
          await vi.advanceTimersByTimeAsync(14_999);
          expect(synchronizeApprovalReceipt).toHaveBeenCalledTimes(2);
          expect(pending.has(receipt)).toBe(true);
          await vi.advanceTimersByTimeAsync(1_001);
          expect(synchronizeApprovalReceipt).toHaveBeenCalledTimes(3);
          release(false);
          await vi.advanceTimersByTimeAsync(29_999);
          expect(synchronizeApprovalReceipt).toHaveBeenCalledTimes(3);
          await vi.advanceTimersByTimeAsync(1_001);
          expect(synchronizeApprovalReceipt).toHaveBeenCalledTimes(4);
          release(true);
          await vi.advanceTimersByTimeAsync(1);
          expect(events.filter((event) => event.type === "activated")).toHaveLength(2);
          expect(events.filter((event) => event.type === "receipt_sync_failed")).toHaveLength(
            outcome === "error" ? 1 : 0,
          );
          expect(events.filter((event) => event.type === "watcher_error")).toHaveLength(0);
        }
        expect(acknowledgeReceipts).toHaveBeenCalledTimes(2);
        expect(acknowledgeReceipts).toHaveBeenLastCalledWith([receipt]);
        expect(pending.size).toBe(0);
        expect(requestScan).not.toHaveBeenCalled();
      } finally {
        await watcher.stop();
      }
    },
  );

  it.each(["sync", "async"])(
    "replays a receipt after %s sink failure without reapproving or recycling the tunnel",
    async (failureMode) => {
      vi.useFakeTimers();
      const receipt = {
        conversationId: "receipt-conversation",
        conversationUrl: "https://chatgpt.com/c/receipt-conversation",
        pendingMessageId: "pending",
        clientMessageId: "client",
        targetMessageId: "target",
        action: "allow" as const,
        rememberAnswer: false,
        responseStatus: 200,
      };
      const durableRecords: OracleApprovalPopupEvent[] = [];
      const errors: OracleApprovalPopupEvent[] = [];
      let acknowledged = false;
      let sinkAttempts = 0;
      const acknowledgeReceipts = vi.fn((receipts) => {
        expect(durableRecords.map((event) => event.receipt)).toEqual(receipts);
        acknowledged = true;
      });
      const requestScan = vi.fn();
      const scan = vi.fn(async () => ({
        outcome: "ok" as const,
        examined: 0,
        discovered: 0,
        approvalsPending: 0,
        conversationUrls: [],
        errors: [],
        receipts: acknowledged ? [] : [receipt],
      }));
      const watcher = new OracleApprovalPopupWatcher({
        connectorId: "connector",
        connectorName: "OmniCodex",
        resource: "https://example.test/mcp/full",
        surface: "/mcp/full",
        cdpEndpoint: "http://127.0.0.1:9222",
        pollIntervalMs: 250,
        serverApprovalClient: {
          scan,
          requestScan,
          acknowledgeReceipts,
          stop: vi.fn(async () => {}),
        },
        transport: {
          listChatGptTargetInventory: vi.fn(async () => ({ targets: [], connectorTargets: [] })),
        } as never,
        onEvent: (event): void | Promise<void> => {
          if (event.type !== "activated") {
            errors.push(event);
            return;
          }
          sinkAttempts += 1;
          if (sinkAttempts === 1) {
            if (failureMode === "sync") throw new Error("disk full");
            return Promise.reject(new Error("disk full"));
          }
          durableRecords.push(event);
        },
      });
      watcher.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(acknowledgeReceipts).not.toHaveBeenCalled();
      expect(watcher.status.lastError).toBe("ORACLE_SERVER_APPROVAL_RECEIPT_PERSIST_FAILED");
      expect(
        errors
          .filter((event) => event.type === "watcher_error")
          .every((event) => !oracleApprovalWatcherEventRequiresTunnelRecovery(event)),
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(250);
      expect(acknowledgeReceipts).toHaveBeenCalledExactlyOnceWith([receipt]);
      expect(durableRecords).toEqual([
        expect.objectContaining({ receipt, strength: "affirmative_once" }),
      ]);
      expect(watcher.status.state).toBe("ready");
      await vi.advanceTimersByTimeAsync(500);
      expect(durableRecords).toHaveLength(1);
      expect(requestScan).not.toHaveBeenCalled();
      await watcher.stop();
    },
  );

  it.each([true, false])(
    "targets the exact conversation with serverScan=%s without duplicating admitted-request lookups",
    async (serverScan) => {
      vi.useFakeTimers();
      const conversationUrl = "https://chatgpt.com/c/exact-result-conversation";
      const serverApprovalClient = {
        requestScan: vi.fn(),
        scan: vi.fn().mockResolvedValue({
          outcome: "ok",
          examined: 0,
          discovered: 0,
          approvalsPending: 0,
          conversationUrls: [],
          errors: [],
          receipts: [],
        }),
        stop: vi.fn().mockResolvedValue(undefined),
      };
      const ensureConversationTarget = vi.fn().mockResolvedValue(undefined);
      const listChatGptTargetInventory = vi.fn().mockResolvedValue({
        targets: [],
        connectorTargets: [],
      });
      const watcher = new OracleApprovalPopupWatcher({
        connectorId: "connector",
        connectorName: "OmniCodex",
        resource: "https://example.test/mcp/full",
        surface: "/mcp/full",
        cdpEndpoint: "http://127.0.0.1:9222",
        pollIntervalMs: 250,
        serverApprovalClient,
        ensureConversationTarget,
        transport: { listChatGptTargetInventory } as never,
      });

      watcher.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(ensureConversationTarget).not.toHaveBeenCalled();

      watcher.wake(conversationUrl, { serverScan });
      if (serverScan)
        expect(serverApprovalClient.requestScan).toHaveBeenCalledWith(conversationUrl);
      else expect(serverApprovalClient.requestScan).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      expect(ensureConversationTarget).toHaveBeenCalledOnce();
      expect(ensureConversationTarget).toHaveBeenCalledWith(
        conversationUrl,
        expect.any(AbortSignal),
      );

      if (!serverScan) {
        const inventoryReads = listChatGptTargetInventory.mock.calls.length;
        for (let index = 0; index < 25; index += 1) {
          watcher.wake(conversationUrl, { serverScan: false });
          watcher.wake(undefined, { serverScan: false });
          await vi.advanceTimersByTimeAsync(250);
        }
        expect(listChatGptTargetInventory.mock.calls.length - inventoryReads).toBeLessThanOrEqual(
          2,
        );
        expect(serverApprovalClient.requestScan).not.toHaveBeenCalled();
        expect(ensureConversationTarget).toHaveBeenCalledOnce();
        // A later genuine confirmation wake is still admitted immediately.
        watcher.wake(conversationUrl);
        expect(serverApprovalClient.requestScan).toHaveBeenCalledExactlyOnceWith(conversationUrl);
      }

      watcher.wake();
      expect(serverApprovalClient.requestScan).toHaveBeenCalledOnce();

      await watcher.stop();
    },
  );

  it("preserves timeout telemetry once without hiding the original failure", async () => {
    vi.useFakeTimers();
    const events: OracleApprovalPopupEvent[] = [];
    const requestStats = {
      scanStartedAtUnixMs: Date.now(),
      trigger: "idle" as const,
      getCount: 2,
      postCount: 0,
      moduleInitializationCount: 0,
      rateLimitCount: 1,
      conversationIds: [],
      requests: [],
    };
    const rateLimit = {
      status: 429 as const,
      operation: "conversation_read",
      retryAtUnixMs: Date.now() + 300_000,
      observedAtUnixMs: Date.now(),
    };
    const failure = new OracleApprovalTelemetryError(
      new Error("CDP command timeout:Runtime.evaluate"),
      { requestStats, rateLimit },
    );
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 250,
      serverApprovalClient: { scan: vi.fn().mockRejectedValue(failure), stop: vi.fn() },
      onEvent: (event) => {
        events.push(event);
      },
      transport: {} as never,
    });
    watcher.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.filter((event) => event.type === "server_requests_observed")).toEqual([
      { type: "server_requests_observed", requestStats },
    ]);
    expect(events.filter((event) => event.type === "rate_limited")).toEqual([
      { type: "rate_limited", rateLimit },
    ]);
    expect(watcher.status.lastError).toBe("CDP command timeout:Runtime.evaluate");
    await watcher.stop();
  });

  it("keeps the DOM watcher ready and preserves diagnostics during targeted rate-limit backoff", async () => {
    vi.useFakeTimers();
    const events: OracleApprovalPopupEvent[] = [];
    const rateLimit = {
      status: 429 as const,
      operation: "conversation_read",
      retryAtUnixMs: Date.now() + 300_000,
      observedAtUnixMs: Date.now(),
      localBackoffMs: 300_000,
      statusEvidence: "http_status" as const,
      backoffSource: "local_backoff" as const,
      responseHeaders: { "x-request-id": "one-network-failure" },
    };
    const serverApprovalClient = {
      scan: vi.fn().mockResolvedValue({
        outcome: "partial",
        examined: 0,
        discovered: 0,
        approvalsPending: 0,
        conversationUrls: [],
        receipts: [],
        errors: [{ conversationId: "account", error: "rate_limited_backoff" }],
        rateLimit,
      }),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 250,
      serverApprovalClient,
      onEvent: (event) => {
        events.push(event);
      },
      transport: {
        listChatGptTargetInventory: vi.fn().mockResolvedValue({
          targets: [],
          connectorTargets: [],
        }),
      } as never,
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(watcher.status).toMatchObject({ state: "degraded", consecutiveFailures: 0 });
    expect(watcher.status.lastError).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(watcher.status).toMatchObject({ state: "degraded", consecutiveFailures: 0 });
    expect(watcher.status.serverRateLimit).toEqual(rateLimit);
    expect(events.filter((event) => event.type === "rate_limited")).toEqual([
      { type: "rate_limited", rateLimit },
    ]);
    await watcher.stop();
  });

  it("does not reannounce expired recovery history as a new 429 after watcher restart", async () => {
    vi.useFakeTimers();
    const events: OracleApprovalPopupEvent[] = [];
    const historical = {
      status: 429 as const,
      operation: "conversation_read",
      observedAtUnixMs: Date.now() - 7_200_000,
      retryAtUnixMs: Date.now() - 3_600_000,
    };
    const scanResult = {
      outcome: "ok" as const,
      examined: 1,
      discovered: 1,
      approvalsPending: 0,
      conversationUrls: [],
      receipts: [],
      errors: [],
      rateLimit: historical,
    };
    const serverApprovalClient = {
      scan: vi.fn().mockResolvedValue(scanResult),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 250,
      serverApprovalClient,
      onEvent: (event) => {
        events.push(event);
      },
      transport: {
        listChatGptTargetInventory: vi.fn().mockResolvedValue({
          targets: [],
          connectorTargets: [],
        }),
      } as never,
    });
    watcher.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(watcher.status).toMatchObject({
      state: "ready",
      consecutiveFailures: 0,
    });
    expect(watcher.status.serverRateLimit).toBeUndefined();
    expect(scanResult.rateLimit).toEqual(historical);
    expect(events.filter((event) => event.type === "rate_limited")).toEqual([]);
    const current = {
      ...historical,
      observedAtUnixMs: Date.now(),
      retryAtUnixMs: Date.now() + 300_000,
    };
    serverApprovalClient.scan.mockResolvedValue({ ...scanResult, rateLimit: current });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events.filter((event) => event.type === "rate_limited")).toEqual([
      { type: "rate_limited", rateLimit: current },
    ]);
    expect(watcher.status.serverRateLimit).toEqual(current);
    await watcher.stop();
  });

  it.each([502, undefined, "read-network" as const])(
    "reports one response failure (%s) while preserving the DOM watcher and its diagnostics",
    async (status) => {
      vi.useFakeTimers();
      const events: OracleApprovalPopupEvent[] = [];
      const failure = {
        conversationId: "conversation",
        error:
          status === "read-network"
            ? "TypeError:Failed to fetch"
            : "Error:chatgpt_approval_http_502",
        ...(status === undefined
          ? { submissionState: "unknown" as const }
          : status === "read-network"
            ? {}
            : { status }),
        operation: status === "read-network" ? "conversation_read" : "approval_submission",
        observedAtUnixMs: Date.now(),
        responseHeaders: { "x-request-id": "one-upstream-response" },
      };
      const serverApprovalClient = {
        scan: vi.fn().mockResolvedValue({
          outcome: "partial",
          examined: 1,
          discovered: 0,
          approvalsPending: 1,
          conversationUrls: [],
          receipts: [],
          errors: [failure],
        }),
        stop: vi.fn().mockResolvedValue(undefined),
      };
      const watcher = new OracleApprovalPopupWatcher({
        connectorId: "connector",
        connectorName: "OmniCodex",
        resource: "https://example.test/mcp/full",
        surface: "/mcp/full",
        cdpEndpoint: "http://127.0.0.1:9222",
        pollIntervalMs: 250,
        serverApprovalClient,
        onEvent: (event) => {
          events.push(event);
        },
        transport: {
          listChatGptTargetInventory: vi
            .fn()
            .mockResolvedValue({ targets: [], connectorTargets: [] }),
        } as never,
      });
      watcher.start();
      try {
        await vi.advanceTimersByTimeAsync(1_000);
        expect(watcher.status).toMatchObject({
          state: "ready",
          consecutiveFailures: 0,
          serverErrors: [failure],
        });
        expect(events.filter((event) => event.type === "server_response_error")).toEqual([
          { type: "server_response_error", serverError: failure },
        ]);
        expect(events.some((event) => event.type === "watcher_unhealthy")).toBe(false);
        serverApprovalClient.scan.mockResolvedValue({
          outcome: "ok",
          examined: 0,
          discovered: 0,
          approvalsPending: 0,
          conversationUrls: [],
          receipts: [],
          errors: [],
        });
        await vi.advanceTimersByTimeAsync(500);
        expect(watcher.status.serverErrors).toBeUndefined();
      } finally {
        await watcher.stop();
      }
    },
  );

  it("does not launch DOM discovery to mask a transient server fetch failure", async () => {
    vi.useFakeTimers();
    const events: OracleApprovalPopupEvent[] = [];
    const serverApprovalClient = {
      scan: vi
        .fn()
        .mockRejectedValue(
          new Error("ORACLE_SERVER_APPROVAL_EVALUATION_EXCEPTION:RequestError:Failed to fetch"),
        ),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const transport = {
      listChatGptTargetInventory: vi.fn().mockResolvedValue({
        targets: [],
        connectorTargets: [],
      }),
    };
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 250,
      serverApprovalClient,
      transport: transport as never,
      onEvent: (event) => {
        events.push(event);
      },
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(watcher.status).toMatchObject({ state: "starting", consecutiveFailures: 0 });
    expect(watcher.status.lastError).toBeUndefined();
    expect(transport.listChatGptTargetInventory).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "watcher_error")).toEqual([]);
    expect(events.filter((event) => event.type === "watcher_unhealthy")).toEqual([]);
    await watcher.stop();
  });

  it("keeps the watcher ready while the independent event stream reacquires after a CDP timeout", async () => {
    vi.useFakeTimers();
    const failure = {
      conversationId: "account",
      operation: "conversation_event_stream",
      error: "CDP command timeout:Runtime.evaluate",
      observedAtUnixMs: Date.now(),
    };
    const events: OracleApprovalPopupEvent[] = [];
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 250,
      serverApprovalClient: {
        scan: vi.fn().mockResolvedValue({
          outcome: "partial",
          examined: 0,
          discovered: 0,
          approvalsPending: 0,
          conversationUrls: [],
          receipts: [],
          errors: [failure],
        }),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      transport: {
        listChatGptTargetInventory: vi
          .fn()
          .mockResolvedValue({ targets: [], connectorTargets: [] }),
      } as never,
      onEvent: (event) => {
        events.push(event);
      },
    });

    watcher.start();
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(watcher.status).toMatchObject({
        state: "ready",
        consecutiveFailures: 0,
        serverErrors: [failure],
      });
      expect(events.filter((event) => event.type === "server_response_error")).toEqual([
        { type: "server_response_error", serverError: failure },
      ]);
      expect(events.some((event) => event.type === "watcher_error")).toBe(false);
    } finally {
      await watcher.stop();
    }
  });

  it.each([undefined, 401, 403])(
    "reports a non-transient partial account scan (%s) as degraded",
    async (status) => {
      vi.useFakeTimers();
      const serverApprovalClient = {
        scan: vi.fn().mockResolvedValue({
          outcome: "partial",
          examined: 0,
          discovered: 0,
          approvalsPending: 0,
          conversationUrls: [],
          receipts: [],
          errors: [
            {
              conversationId: "account",
              error:
                status === undefined ? "conversation_read_failed" : "TypeError:Failed to fetch",
              ...(status === undefined ? {} : { status }),
            },
          ],
        }),
        stop: vi.fn().mockResolvedValue(undefined),
      };
      const watcher = new OracleApprovalPopupWatcher({
        connectorId: "connector",
        connectorName: "OmniCodex",
        resource: "https://example.test/mcp/full",
        surface: "/mcp/full",
        cdpEndpoint: "http://127.0.0.1:9222",
        pollIntervalMs: 250,
        serverApprovalClient,
        transport: {
          listChatGptTargetInventory: vi.fn().mockResolvedValue({
            targets: [],
            connectorTargets: [],
          }),
        } as never,
      });

      watcher.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(watcher.status).toMatchObject({ state: "degraded", consecutiveFailures: 1 });
      expect(watcher.status.lastError).toContain(
        status === undefined
          ? "conversation_read_failed"
          : `ORACLE_SERVER_APPROVAL_HTTP_${status}:TypeError:Failed to fetch`,
      );
      await watcher.stop();
    },
  );

  it("does not approve a matching control owned by another app", async () => {
    const session = new ApprovalSession({
      scopeName: "AnotherApp needs approval to create files",
      buttonName: "Always allow",
      includeUnscopedOmniCodexMarker: true,
    });
    const events = await runWatcher(session);

    expect(session.activationCount).toBe(0);
    expect(events.some((event) => event.type === "activated")).toBe(false);
  });

  it("does not attach to a non-run page without the exact connector iframe", async () => {
    const session = new ApprovalSession({
      scopeName: "OmniCodex needs approval to create the requested files",
      buttonName: "Always allow",
    });
    const events = await runWatcher(session, { exactConnectorTarget: false });

    expect(session.activationCount).toBe(0);
    expect(session.closeCount).toBe(0);
    expect(events.some((event) => event.type === "activated")).toBe(false);
  });

  it("recovers an owned approval mirror after the daemon restarts", async () => {
    vi.useFakeTimers();
    const target: CdpTarget = {
      ...TARGET,
      url: `${TARGET.url}?omnicodex_oracle_mirror=omnicodex-approval-mirror-v1`,
    };
    const session = new ApprovalSession({
      scopeName: "OmniCodex needs approval to create the requested file",
      buttonName: "Allow",
    });
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 250,
      transport: {
        listChatGptTargetInventory: vi.fn().mockResolvedValue({
          targets: [target],
          connectorTargets: [],
        }),
      } as never,
      connectSession: async () => session as unknown as BoundedCdpSession,
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(1);
    await watcher.stop();
    expect(session.activationCount).toBe(1);
  });

  it("approves the exact OmniCodex request without filtering its action verb", async () => {
    const session = new ApprovalSession({
      scopeName: "OmniCodex requests permission to delete the existing files",
      buttonName: "Always allow",
    });
    const events = await runWatcher(session);

    expect(session.activationCount).toBe(1);
    expect(events.some((event) => event.type === "activated")).toBe(true);
  });

  it("preserves the active-run binding and event identity", async () => {
    const session = new ApprovalSession({
      scopeName: "OmniCodex needs approval to download the requested file",
      buttonName: "Confirm",
    });
    const activeRun: OracleApprovalRunScope = {
      oracleRunId: "oracle-run-1",
      sessionId: "session-1",
      correlationId: "correlation-1",
      targetId: TARGET.id,
      conversationUrl: "https://chatgpt.com/c/active-run",
      controllerPid: 12_345,
    };
    const events = await runWatcher(session, { activeRun, exactConnectorTarget: false });

    expect(session.activationCount).toBe(1);
    expect(events.filter((event) => event.type === "activated")).toEqual([
      {
        type: "activated",
        targetId: TARGET.id,
        oracleRunId: activeRun.oracleRunId,
        conversationUrl: activeRun.conversationUrl,
        label: "Confirm",
        strength: "affirmative_once",
      },
    ]);
  });

  it("prioritizes the exact active run instead of scanning stale connector conversations", async () => {
    vi.useFakeTimers();
    const activeTarget: CdpTarget = {
      ...TARGET,
      id: "active-target",
      url: "https://chatgpt.com/c/active-run",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/active-target",
    };
    const staleTarget: CdpTarget = {
      ...TARGET,
      id: "stale-target",
      url: "https://chatgpt.com/c/stale-connector",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/stale-target",
    };
    const activeRun: OracleApprovalRunScope = {
      oracleRunId: "oracle-run-active",
      sessionId: "session-active",
      correlationId: "correlation-active",
      targetId: activeTarget.id,
      conversationUrl: activeTarget.url,
      controllerPid: 12_345,
    };
    const connected: string[] = [];
    const session = new ApprovalSession({
      scopeName: "OmniCodex needs approval to create the requested file",
      buttonName: "Allow",
    });
    const transport = {
      listChatGptTargetInventory: vi.fn().mockResolvedValue({
        targets: [staleTarget, activeTarget],
        connectorTargets: [staleTarget],
      }),
    };
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 250,
      transport: transport as never,
      connectSession: async (_transport, target) => {
        connected.push(target.id);
        return session as unknown as BoundedCdpSession;
      },
      resolveActiveRun: async (target) => (target.id === activeTarget.id ? activeRun : undefined),
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(1);
    await watcher.stop();

    expect(connected).toEqual([activeTarget.id]);
    expect(session.activationCount).toBe(1);
  });

  it("does not crawl idle connector conversations on every hot poll", async () => {
    vi.useFakeTimers();
    const session = new ApprovalSession({
      scopeName: "OmniCodex connected",
      buttonName: "No approval",
    });
    const transport = {
      listChatGptTargetInventory: vi.fn().mockResolvedValue({
        targets: [TARGET],
        connectorTargets: [TARGET],
      }),
    };
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 250,
      recoveryScanIntervalMs: 1_000,
      transport: transport as never,
      connectSession: async () => session as unknown as BoundedCdpSession,
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(1_600);
    await watcher.stop();

    expect(session.commandMethods.filter((method) => method === "Runtime.evaluate")).toHaveLength(
      2,
    );
    expect(transport.listChatGptTargetInventory).toHaveBeenCalledTimes(2);
    expect(session.closeCount).toBe(1);
  });

  it("uses the idle cadence for an approval-free active mirror and wakes for a new run", async () => {
    vi.useFakeTimers();
    const session = new ApprovalSession({
      scopeName: "OmniCodex connected",
      buttonName: "No approval",
    });
    let runId = "mirror-first";
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 250,
      recoveryScanIntervalMs: 1_000,
      transport: {
        listChatGptTargetInventory: vi.fn().mockResolvedValue({
          targets: [TARGET],
          connectorTargets: [TARGET],
        }),
      } as never,
      connectSession: async () => session as unknown as BoundedCdpSession,
      resolveActiveRun: async () => ({
        oracleRunId: runId,
        sessionId: runId,
        correlationId: runId,
        targetId: TARGET.id,
        conversationUrl: TARGET.url,
        controllerPid: 12_345,
      }),
    });
    const scanCount = () =>
      session.commandMethods.filter((method) => method === "Runtime.evaluate").length;

    watcher.start();
    const ready = watcher.waitUntilConversationReady(TARGET.url);
    await vi.advanceTimersByTimeAsync(100);
    await expect(ready).resolves.toBeUndefined();
    const firstSuccessfulScan = watcher.status.lastSuccessfulScanAt;
    await vi.advanceTimersByTimeAsync(500);
    expect(scanCount()).toBe(1);
    expect(watcher.status.lastSuccessfulScanAt).toBe(firstSuccessfulScan);

    runId = "next-run";
    watcher.wake();
    await vi.advanceTimersByTimeAsync(250);
    expect(scanCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(scanCount()).toBe(3);
    expect(session.closeCount).toBe(0);
    await watcher.stop();
    expect(session.closeCount).toBe(1);
  });

  it("backs off a failing active target instead of hammering it every poll", async () => {
    vi.useFakeTimers();
    const activeRun: OracleApprovalRunScope = {
      oracleRunId: "oracle-run-active",
      sessionId: "session-active",
      correlationId: "correlation-active",
      targetId: TARGET.id,
      conversationUrl: TARGET.url,
      controllerPid: 12_345,
    };
    const sessions: Array<{ command: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> =
      [];
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 250,
      transport: {
        listChatGptTargetInventory: vi.fn().mockResolvedValue({
          targets: [TARGET],
          connectorTargets: [TARGET],
        }),
      } as never,
      connectSession: async () => {
        const session = {
          command: vi.fn().mockRejectedValue(new Error("CDP command timeout:Runtime.evaluate")),
          close: vi.fn(),
        };
        sessions.push(session);
        return session as unknown as BoundedCdpSession;
      },
      resolveActiveRun: async () => activeRun,
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(4_900);
    expect(sessions).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(sessions).toHaveLength(2);
    await watcher.stop();
  });

  it("replaces an owned mirror after repeated renderer failures", async () => {
    vi.useFakeTimers();
    const ownedMirror: CdpTarget = {
      ...TARGET,
      url: `${TARGET.url}?omnicodex_oracle_mirror=omnicodex-approval-mirror-v1`,
    };
    const recoverUnresponsiveOwnedMirror = vi.fn(async () => undefined);
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 250,
      recoveryScanIntervalMs: 250,
      transport: {
        listChatGptTargetInventory: vi.fn().mockResolvedValue({
          targets: [ownedMirror],
          connectorTargets: [],
        }),
      } as never,
      connectSession: async () =>
        ({
          command: vi.fn().mockRejectedValue(new Error("CDP command timeout:Runtime.evaluate")),
          close: vi.fn(),
        }) as unknown as BoundedCdpSession,
      recoverUnresponsiveOwnedMirror,
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(5_500);
    await watcher.stop();

    expect(recoverUnresponsiveOwnedMirror).toHaveBeenCalledOnce();
    expect(recoverUnresponsiveOwnedMirror).toHaveBeenCalledWith(
      ownedMirror,
      expect.any(AbortSignal),
    );
  });

  it("retains a loading mirror and releases it only after two ready empty observations", async () => {
    vi.useFakeTimers();
    const ownedMirror: CdpTarget = {
      ...TARGET,
      url: `${TARGET.url}?omnicodex_oracle_mirror=omnicodex-approval-mirror-v1`,
    };
    const session = new ApprovalSession({
      scopeName: "OmniCodex connected",
      buttonName: "No approval",
    });
    let released = false;
    const releaseStableIdleOwnedMirror = vi.fn(async () => {
      released = true;
    });
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 250,
      recoveryScanIntervalMs: 1_000,
      transport: {
        listChatGptTargetInventory: vi.fn().mockImplementation(async () => ({
          targets: released ? [] : [ownedMirror],
          connectorTargets: [],
        })),
      } as never,
      connectSession: async () => session as unknown as BoundedCdpSession,
      releaseStableIdleOwnedMirror,
    });

    watcher.start();
    session.documentReady = false;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(releaseStableIdleOwnedMirror).not.toHaveBeenCalled();
    session.documentReady = true;
    session.responseInProgress = true;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(releaseStableIdleOwnedMirror).not.toHaveBeenCalled();
    session.responseInProgress = false;
    await vi.advanceTimersByTimeAsync(900);
    expect(releaseStableIdleOwnedMirror).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_350);
    expect(releaseStableIdleOwnedMirror).toHaveBeenCalledOnce();
    expect(releaseStableIdleOwnedMirror).toHaveBeenCalledWith(ownedMirror, expect.any(AbortSignal));
    expect(session.closeCount).toBe(1);
    await watcher.stop();
  });

  it("retains an owned mirror throughout a source-independent active conversation lease", async () => {
    vi.useFakeTimers();
    const conversationUrl = "https://chatgpt.com/c/active-oracle-conversation";
    const ownedMirror: CdpTarget = {
      ...TARGET,
      url: `${conversationUrl}?omnicodex_oracle_mirror=omnicodex-approval-mirror-v1`,
    };
    const activeRun: OracleApprovalRunScope = {
      oracleRunId: "active-oracle-run",
      sessionId: "active-oracle-session",
      correlationId: "active-oracle-correlation",
      targetId: ownedMirror.id,
      conversationUrl,
      controllerPid: 12_345,
    };
    const session = new ApprovalSession({
      scopeName: "OmniCodex connected",
      buttonName: "No approval",
    });
    let serverActivity = true;
    let emitNativeFrame: ((data: unknown) => void) | undefined;
    let released = false;
    const releaseStableIdleOwnedMirror = vi.fn(async () => {
      released = true;
    });
    const serverApprovalClient = {
      observeConversationFrame: vi.fn(),
      scan: vi.fn(async () => ({
        outcome: "ok" as const,
        examined: 0,
        discovered: serverActivity ? 1 : 0,
        approvalsPending: 0,
        conversationUrls: serverActivity ? [conversationUrl] : [],
        errors: [],
        receipts: [],
      })),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 250,
      recoveryScanIntervalMs: 250,
      conversationActivityLeaseMs: 1_000,
      serverApprovalClient,
      ensureConversationTarget: vi.fn().mockResolvedValue(undefined),
      transport: {
        listChatGptTargetInventory: vi.fn().mockImplementation(async () => ({
          targets: released ? [] : [ownedMirror],
          connectorTargets: [],
        })),
      } as never,
      connectSession: async (_transport, _target, _signal, onNativeFrame) => {
        emitNativeFrame = onNativeFrame;
        return session as unknown as BoundedCdpSession;
      },
      resolveActiveRun: async () => activeRun,
      releaseStableIdleOwnedMirror,
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(900);
    expect(session.commandMethods.filter((method) => method === "Network.enable")).toHaveLength(1);
    emitNativeFrame?.("native conversation frame");
    expect(serverApprovalClient.observeConversationFrame).toHaveBeenCalledExactlyOnceWith(
      ownedMirror.url,
      "native conversation frame",
    );
    expect(releaseStableIdleOwnedMirror).not.toHaveBeenCalled();

    serverActivity = false;
    await vi.advanceTimersByTimeAsync(700);
    expect(releaseStableIdleOwnedMirror).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(releaseStableIdleOwnedMirror).toHaveBeenCalledOnce();
    expect(session.closeCount).toBe(1);
    await watcher.stop();
    emitNativeFrame?.("late frame after stop");
    expect(serverApprovalClient.observeConversationFrame).toHaveBeenCalledTimes(1);
  });

  it.each(["connect", "Network.enable", "snapshot"])(
    "retries an exact mirror after %s fails without a second conversation event",
    async (failureAt) => {
      vi.useFakeTimers();
      const conversationUrl = "https://chatgpt.com/c/retry-exact-mirror";
      const target = {
        ...TARGET,
        url: `${conversationUrl}?omnicodex_oracle_mirror=omnicodex-approval-mirror-v1`,
      };
      const session = new ApprovalSession({
        scopeName: "OmniCodex connected",
        buttonName: "No approval",
      });
      const connectSession = vi.fn(async () => {
        if (connectSession.mock.calls.length === 1) {
          if (failureAt === "connect") throw new Error("CDP websocket open failed");
          return {
            command: async (method: string, params: Record<string, unknown>) => {
              if (
                method === failureAt ||
                (failureAt === "snapshot" && method !== "Network.enable")
              ) {
                throw new Error(`CDP command timeout:${failureAt}`);
              }
              return session.command(method, params);
            },
            close: vi.fn(),
          } as unknown as BoundedCdpSession;
        }
        return session as unknown as BoundedCdpSession;
      });
      const inventory = vi.fn(async () => ({ targets: [target], connectorTargets: [] }));
      const scan = vi.fn(async () => ({
        outcome: "ok" as const,
        examined: 0,
        discovered: 0,
        approvalsPending: 0,
        conversationUrls: scan.mock.calls.length === 1 ? [conversationUrl] : [],
        errors: [],
        receipts: [],
      }));
      const watcher = new OracleApprovalPopupWatcher({
        connectorId: "connector",
        connectorName: "OmniCodex",
        resource: "https://example.test/mcp/full",
        surface: "/mcp/full",
        cdpEndpoint: "http://127.0.0.1:9222",
        pollIntervalMs: 250,
        recoveryScanIntervalMs: 1_000,
        serverApprovalClient: {
          scan,
          observeConversationFrame: vi.fn(),
          stop: vi.fn().mockResolvedValue(undefined),
        },
        transport: { listChatGptTargetInventory: inventory } as never,
        ensureConversationTarget: vi.fn().mockResolvedValue(undefined),
        connectSession,
      });
      watcher.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(connectSession).toHaveBeenCalledTimes(1);
      expect(watcher.status.lastError).toContain(
        failureAt === "connect" ? "open failed" : failureAt,
      );
      await vi.advanceTimersByTimeAsync(4_500);
      expect(connectSession).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(connectSession).toHaveBeenCalledTimes(2);
      expect(watcher.status.watchedTargets).toBe(1);
      expect(watcher.status.lastError).toBeUndefined();
      const callsAfterRecovery = inventory.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(connectSession).toHaveBeenCalledTimes(2);
      expect(inventory).toHaveBeenCalledTimes(callsAfterRecovery);
      await watcher.stop();
    },
  );

  it("keeps the earliest active mirror when more than 2048 other conversations wake", async () => {
    vi.useFakeTimers();
    const conversationUrl = "https://chatgpt.com/c/earliest-active-conversation";
    const ownedMirror: CdpTarget = {
      ...TARGET,
      url: `${conversationUrl}?omnicodex_oracle_mirror=omnicodex-approval-mirror-v1`,
    };
    const session = new ApprovalSession({
      scopeName: "OmniCodex connected",
      buttonName: "No approval",
    });
    let released = false;
    const releaseStableIdleOwnedMirror = vi.fn(async () => {
      released = true;
    });
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 250,
      recoveryScanIntervalMs: 250,
      conversationActivityLeaseMs: 1_000,
      transport: {
        listChatGptTargetInventory: vi.fn().mockImplementation(async () => ({
          targets: released ? [] : [ownedMirror],
          connectorTargets: [],
        })),
      } as never,
      connectSession: async () => session as unknown as BoundedCdpSession,
      releaseStableIdleOwnedMirror,
    });
    watcher.wake(conversationUrl);
    for (let index = 0; index < 2_049; index += 1) {
      watcher.wake(`https://chatgpt.com/c/other-active-conversation-${index}`);
    }
    watcher.start();
    await vi.advanceTimersByTimeAsync(750);
    expect(releaseStableIdleOwnedMirror).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(releaseStableIdleOwnedMirror).toHaveBeenCalledExactlyOnceWith(
      ownedMirror,
      expect.any(AbortSignal),
    );
    await watcher.stop();
  });

  it("never releases a user or foreign page even when its empty owner revision is stable", async () => {
    vi.useFakeTimers();
    const session = new ApprovalSession({
      scopeName: "OmniCodex connected",
      buttonName: "No approval",
    });
    const releaseStableIdleOwnedMirror = vi.fn(async () => undefined);
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 250,
      recoveryScanIntervalMs: 1_000,
      transport: {
        listChatGptTargetInventory: vi.fn().mockResolvedValue({
          targets: [TARGET],
          connectorTargets: [TARGET],
        }),
      } as never,
      connectSession: async () => session as unknown as BoundedCdpSession,
      releaseStableIdleOwnedMirror,
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(2_200);
    expect(releaseStableIdleOwnedMirror).not.toHaveBeenCalled();
    await watcher.stop();
  });

  it("does not activate the same DOM revision twice", async () => {
    const session = new ApprovalSession({
      scopeName: "OmniCodex needs approval to create the requested files",
      buttonName: "Always allow",
    });
    const events = await runWatcher(session, { elapsedMs: 300 });

    expect(session.activationCount).toBe(1);
    expect(events.filter((event) => event.type === "activated")).toHaveLength(1);
  });

  it("retries the same approval revision after a transient activation failure", async () => {
    const session = new ApprovalSession({
      scopeName: "OmniCodex needs approval to create the requested files",
      buttonName: "Always allow",
      activationFailures: 1,
    });
    const events = await runWatcher(session, { elapsedMs: 5_600 });

    expect(session.activationAttempts).toBe(2);
    expect(session.activationCount).toBe(1);
    expect(events.filter((event) => event.type === "activated")).toHaveLength(1);
  });

  it("reports one error per continuous CDP outage instead of flooding every poll", async () => {
    vi.useFakeTimers();
    const events: Array<{ type: string; error?: string }> = [];
    const transport = {
      listChatGptTargetInventory: vi.fn().mockRejectedValue(new Error("fetch failed")),
    };
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 100,
      transport: transport as never,
      onEvent: (event) => {
        events.push(event);
      },
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(10_100);
    await watcher.stop();

    expect(transport.listChatGptTargetInventory).toHaveBeenCalledTimes(3);
    expect(events.filter((event) => event.type === "watcher_error")).toEqual([
      { type: "watcher_error", error: "fetch failed" },
    ]);
    expect(events.filter((event) => event.type === "watcher_unhealthy")).toEqual([
      { type: "watcher_unhealthy", error: "fetch failed" },
    ]);
  });

  it("does not report a CDP cancellation caused by watcher shutdown", async () => {
    vi.useFakeTimers();
    const events: OracleApprovalPopupEvent[] = [];
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 250,
      transport: {
        listChatGptTargetInventory: vi.fn().mockResolvedValue({
          targets: [TARGET],
          connectorTargets: [TARGET],
        }),
      } as never,
      connectSession: async () =>
        ({
          command: vi.fn(
            (_method, _params, signal: AbortSignal) =>
              new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
          ),
          close: vi.fn(),
        }) as unknown as BoundedCdpSession,
      onEvent: (event) => {
        events.push(event);
      },
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(1);
    const stopped = watcher.stop();
    await vi.runAllTimersAsync();
    await stopped;

    expect(events.filter((event) => event.type === "watcher_error")).toEqual([]);
  });

  it("recovers a later socket failure without recycling a merely slow browser", async () => {
    vi.useFakeTimers();
    const events: OracleApprovalPopupEvent[] = [];
    let failure: string | undefined = "CDP request timeout:GET:/json/list";
    const transport = {
      listChatGptTargetInventory: vi.fn(async () => {
        if (failure !== undefined) throw new Error(failure);
        return { targets: [], connectorTargets: [] };
      }),
    };
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      transport: transport as never,
      pollIntervalMs: 250,
      onEvent: (event) => {
        events.push(event);
      },
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(1);
    watcher.wake();
    await vi.advanceTimersByTimeAsync(250);
    watcher.wake();
    await vi.advanceTimersByTimeAsync(250);
    expect(watcher.status.state).toBe("unhealthy");
    expect(events.filter((event) => event.type === "watcher_unhealthy")).toEqual([
      { type: "watcher_unhealthy", error: failure },
    ]);
    expect(oracleApprovalWatcherRequiresTunnelRecovery(failure)).toBe(false);

    failure = "fetch failed";
    watcher.wake();
    await vi.advanceTimersByTimeAsync(250);
    expect(events.filter((event) => event.type === "watcher_unhealthy")).toEqual([
      { type: "watcher_unhealthy", error: "CDP request timeout:GET:/json/list" },
      { type: "watcher_unhealthy", error: failure },
    ]);
    expect(oracleApprovalWatcherRequiresTunnelRecovery(failure)).toBe(true);

    failure = undefined;
    watcher.wake();
    await vi.advanceTimersByTimeAsync(250);
    expect(watcher.status).toMatchObject({ state: "ready", consecutiveFailures: 0 });
    await watcher.stop();
  });

  it("keeps the watcher ready when one stale target fails and another exact target scans", async () => {
    vi.useFakeTimers();
    const events: OracleApprovalPopupEvent[] = [];
    const staleTarget: CdpTarget = {
      ...TARGET,
      id: "stale-target",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/stale-target",
    };
    const healthyTarget: CdpTarget = {
      ...TARGET,
      id: "healthy-target",
      url: "https://chatgpt.com/c/healthy-conversation",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/healthy-target",
    };
    const staleSession = {
      command: vi.fn().mockRejectedValue(new Error("CDP command timeout:DOM.enable")),
      close: vi.fn(),
    };
    const healthySession = new ApprovalSession({
      scopeName: "OmniCodex connected",
      buttonName: "No approval",
    });
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 250,
      transport: {
        listChatGptTargetInventory: vi.fn().mockResolvedValue({
          targets: [staleTarget, healthyTarget],
          connectorTargets: [staleTarget, healthyTarget],
        }),
      } as never,
      connectSession: async (_transport, target) =>
        (target.id === staleTarget.id
          ? staleSession
          : healthySession) as unknown as BoundedCdpSession,
      onEvent: (event) => {
        events.push(event);
      },
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(1);

    expect(watcher.status).toMatchObject({
      state: "ready",
      consecutiveFailures: 0,
      watchedTargets: 1,
    });
    expect(staleSession.close).toHaveBeenCalledTimes(1);
    expect(healthySession.closeCount).toBe(0);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(staleSession.close).toHaveBeenCalledTimes(2);
    expect(
      events.filter((event) => event.type === "watcher_error" && event.targetId === staleTarget.id),
    ).toHaveLength(1);
    expect(watcher.status).toMatchObject({ state: "ready", consecutiveFailures: 0 });
    await watcher.stop();
  });

  it("preserves failed-target backoff across repeated activity wakes", async () => {
    vi.useFakeTimers();
    const session = {
      command: vi.fn().mockRejectedValue(new Error("CDP command timeout:DOM.enable")),
      close: vi.fn(),
    };
    const connectSession = vi.fn(async () => session as unknown as BoundedCdpSession);
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 250,
      recoveryScanIntervalMs: 250,
      transport: {
        listChatGptTargetInventory: vi.fn().mockResolvedValue({
          targets: [TARGET],
          connectorTargets: [TARGET],
        }),
      } as never,
      connectSession,
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(connectSession).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 16; index += 1) {
      watcher.wake(index % 2 === 0 ? TARGET.url : undefined);
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(connectSession).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(connectSession).toHaveBeenCalledTimes(2);
    await watcher.stop();
  });

  it("does not report ready when every exact target session is failing", async () => {
    vi.useFakeTimers();
    const session = {
      command: vi.fn().mockRejectedValue(new Error("CDP command timeout:Runtime.evaluate")),
      close: vi.fn(),
    };
    const transport = {
      listChatGptTargetInventory: vi.fn().mockResolvedValue({
        targets: [TARGET],
        connectorTargets: [TARGET],
      }),
    };
    const watcher = new OracleApprovalPopupWatcher({
      connectorId: "connector",
      connectorName: "OmniCodex",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:9222",
      pollIntervalMs: 250,
      unhealthyFailureThreshold: 2,
      transport: transport as never,
      connectSession: async () => session as unknown as BoundedCdpSession,
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(watcher.status).toMatchObject({
      state: "unhealthy",
      watchedTargets: 0,
      lastError: "ORACLE_APPROVAL_TARGET_SCAN_FAILED:CDP command timeout:Runtime.evaluate",
    });
    expect(watcher.status.consecutiveFailures).toBeGreaterThanOrEqual(2);
    await watcher.stop();
  });
});

function node(ref: string, name: string, exactAppScope: boolean) {
  return { ref, name, role: "button", exactAppScope } as const;
}

const TARGET: CdpTarget = {
  id: "chatgpt-target",
  type: "page",
  url: "https://chatgpt.com/c/existing-conversation",
  webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/chatgpt-target",
};

interface ApprovalSessionFixture {
  readonly scopeName: string;
  readonly buttonName: string;
  readonly includeUnscopedOmniCodexMarker?: boolean;
  readonly activationFailures?: number;
}

class ApprovalSession {
  documentReady = true;
  responseInProgress = false;
  activationCount = 0;
  activationAttempts = 0;
  closeCount = 0;
  readonly commandMethods: string[] = [];
  readonly #fixture: ApprovalSessionFixture;
  #remainingActivationFailures: number;
  constructor(fixture: ApprovalSessionFixture) {
    this.#fixture = fixture;
    this.#remainingActivationFailures = fixture.activationFailures ?? 0;
  }

  async command(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commandMethods.push(method);
    switch (method) {
      case "Input.dispatchMouseEvent": {
        if (params?.type === "mouseReleased") {
          this.activationAttempts += 1;
          if (this.#remainingActivationFailures > 0) {
            this.#remainingActivationFailures -= 1;
            throw new Error("transient CDP activation failure");
          }
          this.activationCount += 1;
        }
        return {};
      }
      case "Accessibility.enable":
      case "DOM.enable":
      case "Network.enable":
        return {};
      case "DOM.performSearch":
        return {
          searchId: String(params?.query).includes(".//button")
            ? "approval-scope-search"
            : "approval-button-search",
          resultCount: this.#fixture.scopeName.toLocaleLowerCase().includes("omnicodex") ? 1 : 0,
        };
      case "DOM.getSearchResults":
        return { nodeIds: [params?.searchId === "approval-scope-search" ? 1 : 2] };
      case "DOM.getAttributes":
        return { attributes: ["aria-label", this.#fixture.buttonName] };
      case "DOM.discardSearchResults":
        return {};
      case "DOM.getOuterHTML":
        return Number(params?.nodeId) === 1
          ? {
              outerHTML: `<div role="dialog">${this.#fixture.scopeName}<button>${this.#fixture.buttonName}</button></div>`,
            }
          : { outerHTML: `<button>${this.#fixture.buttonName}</button>` };
      case "DOM.getBoxModel":
        return Number(params?.nodeId) === 1
          ? { model: { content: [0, 0, 500, 0, 500, 300, 0, 300] } }
          : { model: { content: [300, 200, 450, 200, 450, 250, 300, 250] } };
      case "DOM.getDocument":
        return { root: { nodeId: 1 } };
      case "Accessibility.queryAXTree":
        return {
          nodes: [
            {
              nodeId: "approval",
              backendDOMNodeId: 2,
              role: { value: "button" },
              name: { value: this.#fixture.buttonName },
            },
          ],
        };
      case "Accessibility.getFullAXTree":
        return { nodes: this.#accessibilityNodes() };
      case "DOM.resolveNode":
        return { object: { objectId: "approval-button" } };
      case "Runtime.evaluate": {
        if (params?.expression === ORACLE_APPROVAL_CONTROL_SNAPSHOT_EXPRESSION) {
          const exactAppScope = this.#fixture.scopeName.toLocaleLowerCase().includes("omnicodex");
          return {
            result: {
              value: {
                revision: "oracle-v2-1",
                implementation: 10,
                documentReady: this.documentReady,
                responseInProgress: this.responseInProgress,
                controls: exactAppScope
                  ? [
                      {
                        ref: "oa-0",
                        role: "button",
                        name: this.#fixture.buttonName,
                        visible: true,
                        exactAppScope: true,
                        scopeText: this.#fixture.scopeName,
                      },
                    ]
                  : [],
              },
            },
          };
        }
        return { result: { objectId: "approval-document" } };
      }
      case "Runtime.callFunctionOn": {
        if (params?.functionDeclaration === ORACLE_APPROVAL_CONTROL_POINT_FUNCTION) {
          this.activationAttempts += 1;
          if (this.#remainingActivationFailures > 0) {
            this.#remainingActivationFailures -= 1;
            throw new Error("transient CDP activation failure");
          }
          this.activationCount += 1;
          return { result: { value: true } };
        }
        if (params?.functionDeclaration === "function(){this.click()}") {
          this.activationAttempts += 1;
          if (this.#remainingActivationFailures > 0) {
            this.#remainingActivationFailures -= 1;
            throw new Error("transient CDP activation failure");
          }
          this.activationCount += 1;
          return { result: { value: true } };
        }
        const exactAppScope = this.#fixture.scopeName.toLocaleLowerCase().includes("omnicodex");
        return {
          result: {
            value: {
              name: this.#fixture.buttonName,
              visible: true,
              exactAppScope,
              scopeText: this.#fixture.scopeName,
            },
          },
        };
      }
      default:
        throw new Error(`Unexpected CDP method: ${method}`);
    }
  }

  close(): void {
    this.closeCount += 1;
  }

  #accessibilityNodes(): readonly unknown[] {
    const marker = this.#fixture.includeUnscopedOmniCodexMarker
      ? [
          {
            nodeId: "marker",
            backendDOMNodeId: 3,
            role: { value: "text" },
            name: { value: "OmniCodex" },
          },
        ]
      : [];
    return [
      ...marker,
      {
        nodeId: "scope",
        backendDOMNodeId: 1,
        role: { value: "dialog" },
        name: { value: this.#fixture.scopeName },
        childIds: ["approval"],
      },
      {
        nodeId: "approval",
        backendDOMNodeId: 2,
        parentId: "scope",
        role: { value: "button" },
        name: { value: this.#fixture.buttonName },
      },
    ];
  }
}

async function runWatcher(
  session: ApprovalSession,
  options: {
    readonly activeRun?: OracleApprovalRunScope;
    readonly exactConnectorTarget?: boolean;
    readonly elapsedMs?: number;
  } = {},
) {
  vi.useFakeTimers();
  const events: Array<{
    type: string;
    targetId?: string;
    oracleRunId?: string;
    conversationUrl?: string;
    label?: string;
    strength?: string;
  }> = [];
  const transport = {
    listChatGptTargetInventory: vi.fn().mockResolvedValue({
      targets: [TARGET],
      connectorTargets: options.exactConnectorTarget !== false ? [TARGET] : [],
    }),
  };
  const watcher = new OracleApprovalPopupWatcher({
    connectorId: "connector",
    connectorName: "OmniCodex",
    resource: "https://example.test/mcp/full",
    surface: "/mcp/full",
    cdpEndpoint: "http://127.0.0.1:9222",
    pollIntervalMs: 250,
    transport: transport as never,
    connectSession: async () => session as unknown as BoundedCdpSession,
    resolveActiveRun: async () => options.activeRun,
    onEvent: (event) => {
      events.push(event);
    },
  });

  watcher.start();
  let remainingMs = options.elapsedMs ?? 1;
  while (remainingMs > 0) {
    const stepMs = Math.min(50, remainingMs);
    await vi.advanceTimersByTimeAsync(stepMs);
    remainingMs -= stepMs;
  }
  await watcher.stop();
  return events;
}
