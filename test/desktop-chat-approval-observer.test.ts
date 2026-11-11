import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DesktopChatApprovalObserver,
  selectDesktopApprovalControl,
} from "../src/application/desktop-chat-approval-observer.js";
import {
  BoundedCdpSession,
  CdpChatGptApprovalSurface,
  ChatGptLoopbackCdpTransport,
} from "../src/infrastructure/chatgpt/chatgpt-cdp-transport.js";
import type { DesktopChatObservedEvent } from "../src/infrastructure/windows/desktop-chat-event-source.js";

const connectorId = "asdk_app_omnicodex";
const accountSourceId = "chatgpt:account:user";
const approvalEvent = (
  connector = connectorId,
  pendingMessageId = "pending-approval",
): DesktopChatObservedEvent => ({
  source: {
    endpoint: "http://127.0.0.1:11594",
    processId: 1234,
    startedAtIso: "2026-09-08T00:00:00.000Z",
  },
  targetId: "desktop-target",
  conversationUrl: "https://chatgpt.com/c/approval-test",
  notification: {
    type: "conversation-update",
    payload: {
      conversation_id: "approval-test",
      update_content: {
        messages: [
          {
            id: pendingMessageId,
            metadata: {
              jit_plugin_data: {
                from_server: {
                  type: "confirm_action",
                  body: {
                    connector_id: connector,
                    actions: [{ allow: { target_message_id: "tool-result" } }],
                  },
                },
              },
            },
          },
        ],
      },
    },
  },
});

describe("Desktop Chat approval observer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("waits for the exact guest and approval beyond the former count and lifetime limits", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const close = vi.fn();
    const inventory = vi
      .spyOn(ChatGptLoopbackCdpTransport.prototype, "listChatGptTargets")
      .mockImplementation(async () =>
        Date.now() - started < 3_000
          ? []
          : [
              {
                id: "exact-guest",
                type: "other",
                url: approvalEvent().conversationUrl,
                webSocketDebuggerUrl: "ws://127.0.0.1/exact-guest",
              },
            ],
      );
    vi.spyOn(BoundedCdpSession, "connect").mockResolvedValue({
      close,
    } as unknown as BoundedCdpSession);
    vi.spyOn(CdpChatGptApprovalSurface.prototype, "claimApprovalOwnership").mockResolvedValue(true);
    vi.spyOn(CdpChatGptApprovalSurface.prototype, "approvalControlSnapshot").mockImplementation(
      async () => ({
        domRevision: "exact-revision",
        nodes:
          Date.now() - started < 35_000
            ? []
            : [
                {
                  ref: "allow",
                  role: "button",
                  name: "허용하기",
                  exactAppScope: true,
                  scopeText: "OmniCodex 파일 생성을 허용할까요? 파일 첨부",
                },
              ],
      }),
    );
    const activate = vi
      .spyOn(CdpChatGptApprovalSurface.prototype, "activate")
      .mockResolvedValue(undefined);
    const report = vi.fn();
    const observer = new DesktopChatApprovalObserver({
      readScope: async () => ({ accountSourceId, connectorIds: [connectorId] }),
      report,
    });
    const accepted = observer.accept(approvalEvent());
    await vi.advanceTimersByTimeAsync(34_000);
    expect(report).not.toHaveBeenCalled();
    const inventoryCalls = inventory.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_100);
    await accepted;
    expect(activate).toHaveBeenCalledExactlyOnceWith(
      "allow",
      "exact-revision",
      expect.any(AbortSignal),
    );
    expect(report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "activated" }),
    );
    expect(inventory).toHaveBeenCalledTimes(inventoryCalls);
    expect(close).toHaveBeenCalledOnce();
    await observer.stop();
  });

  it("cancels exact guest discovery through the parent signal without a synthetic expiry", async () => {
    vi.useFakeTimers();
    const inventory = vi
      .spyOn(ChatGptLoopbackCdpTransport.prototype, "listChatGptTargets")
      .mockResolvedValue([]);
    const report = vi.fn();
    const observer = new DesktopChatApprovalObserver({
      readScope: async () => ({ accountSourceId, connectorIds: [connectorId] }),
      report,
    });
    const accepted = observer.accept(approvalEvent());
    await vi.advanceTimersByTimeAsync(35_000);
    expect(report).not.toHaveBeenCalled();
    await observer.stop();
    await accepted;
    const calls = inventory.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(inventory).toHaveBeenCalledTimes(calls);
    expect(report).not.toHaveBeenCalled();
  });

  it("does not delay a different Chat while one approval is waiting for its card", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const activate = vi.fn(async (input) => {
      if (input.approval.pendingMessageId === "slow") await waiting;
      return { label: "Allow", strength: "affirmative_once" as const, targetId: "renderer" };
    });
    const observer = new DesktopChatApprovalObserver({
      readScope: async () => ({ accountSourceId, connectorIds: [connectorId] }),
      activate,
      report: vi.fn(async () => {}),
    });
    const slow = observer.accept(approvalEvent(connectorId, "slow"));
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    const other = approvalEvent(connectorId, "other");
    const fast = observer.accept({ ...other, conversationUrl: "https://chatgpt.com/c/other-chat" });
    try {
      await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(2));
      await fast;
    } finally {
      release();
      await slow;
      await observer.stop();
    }
  });

  it("keeps distinct approvals on one Chat serialized", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const activate = vi.fn(async (input) => {
      if (input.approval.pendingMessageId === "first") await waiting;
      return { label: "Allow", strength: "affirmative_once" as const, targetId: "renderer" };
    });
    const observer = new DesktopChatApprovalObserver({
      readScope: async () => ({ accountSourceId, connectorIds: [connectorId] }),
      activate,
      report: vi.fn(async () => {}),
    });
    const first = observer.accept(approvalEvent(connectorId, "first"));
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    const second = observer.accept(approvalEvent(connectorId, "second"));
    await Promise.resolve();
    expect(activate).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(activate).toHaveBeenCalledTimes(2);
    await observer.stop();
  });

  it("uses the direct Allow button when the materialization menu would replace the App guest", () => {
    const control = selectDesktopApprovalControl([
      {
        ref: "allow",
        role: "button",
        name: "허용하기",
        exactAppScope: true,
        scopeText: "OmniCodex 파일 생성을 허용할까요? 파일 첨부",
      },
      {
        ref: "options",
        role: "button",
        name: "file materialization options",
        exactAppScope: true,
        scopeText: "OmniCodex 파일 생성을 허용할까요? 파일 첨부",
      },
    ]);

    expect(control).toMatchObject({ node: { ref: "allow" }, strength: "affirmative_once" });
  });

  it("activates one exact event once and verifies the account again after the click", async () => {
    const readScope = vi.fn(async () => ({ accountSourceId, connectorIds: [connectorId] }));
    const activate = vi.fn(async () => ({
      label: "Allow OmniCodex for this conversation",
      strength: "persistent" as const,
      targetId: "approval-renderer",
    }));
    const report = vi.fn(async () => {});
    const observer = new DesktopChatApprovalObserver({ readScope, activate, report });
    const event = approvalEvent();

    await observer.accept(event);
    await observer.accept(event);

    expect(activate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        event,
        accountSourceId,
        connectorId,
        approval: { pendingMessageId: "pending-approval", targetMessageIds: ["tool-result"] },
      }),
      expect.any(AbortSignal),
    );
    expect(readScope).toHaveBeenCalledTimes(3);
    expect(report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        outcome: "activated",
        targetId: "approval-renderer",
        pendingMessageId: "pending-approval",
        strength: "persistent",
      }),
    );
    await observer.stop();
  });

  it("deduplicates one broadcast approval across Desktop renderer targets", async () => {
    const activate = vi.fn(async () => ({
      label: "한 번만 허용",
      strength: "affirmative_once" as const,
      targetId: "selected-chat-renderer",
    }));
    const report = vi.fn(async () => {});
    const observer = new DesktopChatApprovalObserver({
      readScope: vi.fn(async () => ({ accountSourceId, connectorIds: [connectorId] })),
      activate,
      report,
    });

    await observer.accept(approvalEvent());
    await observer.accept({ ...approvalEvent(), targetId: "broadcast-renderer" });

    expect(activate).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ targetId: "selected-chat-renderer", outcome: "activated" }),
    );
    await observer.stop();
  });

  it("refreshes an exact App Chat surface once when a resource result needs approval", async () => {
    const activate = vi.fn(async () => ({
      label: "허용하기",
      strength: "affirmative_once" as const,
      targetId: "desktop-chat-guest",
    }));
    const report = vi.fn(async () => {});
    const observer = new DesktopChatApprovalObserver({
      readScope: vi.fn(async () => ({ accountSourceId, connectorIds: [connectorId] })),
      activate,
      report,
    });
    const input = {
      endpoint: "http://127.0.0.1:11594",
      correlationId: "resource-result-1",
      chatGptConversationUrl: "https://chatgpt.com/c/approval-test",
    };

    await observer.acceptResourceDelivery(input);
    await observer.acceptResourceDelivery(input);

    expect(activate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        accountSourceId,
        connectorId,
        refreshConversationSurface: true,
        event: expect.objectContaining({
          conversationUrl: input.chatGptConversationUrl,
          targetId: "resource-delivery",
        }),
        approval: { pendingMessageId: input.correlationId, targetMessageIds: [] },
      }),
      expect.any(AbortSignal),
    );
    expect(report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "activated", targetId: "desktop-chat-guest" }),
    );
    await observer.stop();
  });

  it("reports a resource approval scope failure once before activation", async () => {
    const activate = vi.fn();
    const report = vi.fn();
    const observer = new DesktopChatApprovalObserver({
      readScope: async () => {
        throw new Error("DESKTOP_CHAT_ACCOUNT_CHANGED");
      },
      activate,
      report,
    });
    const input = {
      endpoint: "http://127.0.0.1:11594",
      correlationId: "resource-scope-failure",
      chatGptConversationUrl: "https://chatgpt.com/c/approval-test",
    };
    await observer.acceptResourceDelivery(input);
    expect(activate).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledExactlyOnceWith({
      outcome: "failed",
      targetId: "resource-delivery",
      conversationUrl: input.chatGptConversationUrl,
      pendingMessageId: input.correlationId,
      error: "Error: DESKTOP_CHAT_ACCOUNT_CHANGED",
    });
    await observer.stop();
  });

  it("reports a resource activation failure only once", async () => {
    const report = vi.fn();
    const observer = new DesktopChatApprovalObserver({
      readScope: async () => ({ accountSourceId, connectorIds: [connectorId] }),
      activate: async () => {
        throw new Error("DESKTOP_APPROVAL_ACCOUNT_CHANGED");
      },
      report,
    });
    await observer.acceptResourceDelivery({
      endpoint: "http://127.0.0.1:11594",
      correlationId: "resource-activation-failure",
      chatGptConversationUrl: "https://chatgpt.com/c/approval-test",
    });
    expect(report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        outcome: "failed",
        accountSourceId,
        error: "Error: DESKTOP_APPROVAL_ACCOUNT_CHANGED",
      }),
    );
    await observer.stop();
  });

  it("ignores unrelated connector approvals without opening a Desktop control session", async () => {
    const activate = vi.fn();
    const report = vi.fn();
    const observer = new DesktopChatApprovalObserver({
      readScope: vi.fn(async () => ({ accountSourceId, connectorIds: [connectorId] })),
      activate,
      report,
    });

    await observer.accept(approvalEvent("asdk_app_other"));

    expect(activate).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    await observer.stop();
  });

  it.each(["resource", "native"])(
    "yields an absent resource card to the next exact %s request without claiming approval",
    async (kind) => {
      const report = vi.fn();
      let waitingSignal: AbortSignal | undefined;
      const activate = vi.fn(async (input, signal: AbortSignal) => {
        if (input.approval.pendingMessageId === "absent") {
          waitingSignal = signal;
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        input.onControlReady?.();
        return { label: "Allow", strength: "affirmative_once" as const, targetId: "exact-guest" };
      });
      const observer = new DesktopChatApprovalObserver({
        readScope: async () => ({ accountSourceId, connectorIds: [connectorId] }),
        activate,
        report,
      });
      const input = {
        endpoint: "http://127.0.0.1:11594",
        chatGptConversationUrl: approvalEvent().conversationUrl,
      };
      const absent = observer.acceptResourceDelivery({ ...input, correlationId: "absent" });
      await vi.waitFor(() => expect(waitingSignal).toBeDefined());
      await observer.acceptResourceDelivery({
        ...input,
        chatGptConversationUrl: "https://chatgpt.com/c/independent",
        correlationId: "independent",
      });
      expect(waitingSignal?.aborted).toBe(false);
      if (kind === "resource")
        await observer.acceptResourceDelivery({ ...input, correlationId: "next" });
      else await observer.accept(approvalEvent(connectorId, "next"));
      await absent;
      expect(waitingSignal?.aborted).toBe(true);
      expect(report.mock.calls.filter(([event]) => event.pendingMessageId === "absent")).toEqual([
        [
          expect.objectContaining({
            outcome: "failed",
            error: expect.stringContaining("DESKTOP_APPROVAL_WAIT_"),
          }),
        ],
      ]);
      expect(
        report.mock.calls
          .filter(([event]) => event.outcome === "activated")
          .map(([event]) => event.pendingMessageId),
      ).toEqual(["independent", "next"]);
      await observer.stop();
    },
  );

  it("queues distinct resource receipts for one conversation without losing or duplicating them", async () => {
    const releases: Array<() => void> = [];
    const activate = vi.fn(
      async (_input: { approval: { pendingMessageId: string }; onControlReady?: () => void }) => {
        _input.onControlReady?.();
        await new Promise<void>((resolve) => releases.push(resolve));
        return {
          label: "허용하기",
          strength: "affirmative_once" as const,
          targetId: "desktop-chat-guest",
        };
      },
    );
    const observer = new DesktopChatApprovalObserver({
      readScope: async () => ({ accountSourceId, connectorIds: [connectorId] }),
      activate,
      report: vi.fn(),
    });
    const input = {
      endpoint: "http://127.0.0.1:11594",
      chatGptConversationUrl: "https://chatgpt.com/c/approval-test",
    };
    const first = observer.acceptResourceDelivery({ ...input, correlationId: "first" });
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    const second = observer.acceptResourceDelivery({ ...input, correlationId: "second" });
    const duplicate = observer.acceptResourceDelivery({ ...input, correlationId: "second" });
    const third = observer.acceptResourceDelivery({ ...input, correlationId: "third" });
    await Promise.resolve();
    expect(activate).toHaveBeenCalledTimes(1);
    releases[0]?.();
    await first;
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(2));
    releases[1]?.();
    await Promise.all([second, duplicate]);
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(3));
    releases[2]?.();
    await third;
    expect(activate.mock.calls.map(([value]) => value.approval.pendingMessageId)).toEqual([
      "first",
      "second",
      "third",
    ]);
    await observer.stop();
  });

  it("does not acknowledge activation if the signed-in account changes during it", async () => {
    const readScope = vi
      .fn()
      .mockResolvedValueOnce({ accountSourceId, connectorIds: [connectorId] })
      .mockResolvedValueOnce({
        accountSourceId: "chatgpt:other:user",
        connectorIds: [connectorId],
      });
    const report = vi.fn(async () => {});
    const observer = new DesktopChatApprovalObserver({
      readScope,
      activate: vi.fn(async () => ({
        label: "한 번만 허용",
        strength: "affirmative_once" as const,
        targetId: "desktop-target",
      })),
      report,
    });

    await observer.accept(approvalEvent());

    expect(report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        outcome: "failed",
        error: "Error: DESKTOP_APPROVAL_ACCOUNT_CHANGED",
      }),
    );
    await observer.stop();
  });
});
