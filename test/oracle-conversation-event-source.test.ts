import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CdpWebSocketLike,
  ChatGptLoopbackCdpTransport,
} from "../src/infrastructure/chatgpt/chatgpt-cdp-transport.js";
import {
  OracleConversationEventSource,
  oracleConversationTurnWasStopped,
  oracleConversationUrlsFromCdpEvent,
  oracleNotificationRequiresConnectorRead,
} from "../src/infrastructure/chatgpt/oracle-conversation-event-source.js";
import { oracleNativeHomeRecoveryExpression } from "../src/infrastructure/chatgpt/oracle-native-turn-subscription.js";

const conversationId = "550e8400-e29b-41d4-a716-446655440000";
const frame = (payload: unknown) =>
  JSON.stringify({
    method: "Network.webSocketFrameReceived",
    params: { response: { opcode: 1, payloadData: JSON.stringify(payload) } },
  });
const update = {
  type: "conversation-update",
  payload: {
    conversation_id: conversationId,
    update_type: "changed",
    update_content: { private: "not exported" },
  },
};

describe("oracleConversationTurnWasStopped", () => {
  it.each([
    { error: { code: "user_cancelled" } },
    { error: { status: "interrupted" } },
    { error: { message: "Turn was stopped by the user" } },
    { error: "Client canceled the turn" },
  ])("recognizes an explicit user/client stop: %j", (payload) => {
    expect(oracleConversationTurnWasStopped({ type: "conversation-turn-error", payload })).toBe(
      true,
    );
  });

  it.each([
    { error: { code: "network_error", message: "Connection closed", status: 503 } },
    { error: { code: "rate_limit_exceeded", status: 429 } },
    { error: { code: "upstream_unavailable" } },
    { error: { message: "The request timed out" } },
  ])("does not pause a Goal for a recoverable failure: %j", (payload) => {
    expect(oracleConversationTurnWasStopped({ type: "conversation-turn-error", payload })).toBe(
      false,
    );
  });

  it("ignores successful turn notifications", () => {
    expect(
      oracleConversationTurnWasStopped({
        type: "conversation-turn-complete",
        payload: { status: "stopped" },
      }),
    ).toBe(false);
  });
});

class Socket implements CdpWebSocketLike {
  readyState = 1;
  sent: string[] = [];
  listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  close = vi.fn(() => {
    this.readyState = 3;
    for (const callback of this.listeners.get("close") ?? []) callback({});
  });
  addEventListener(type: string, callback: (event: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
    if (type === "open") queueMicrotask(() => callback({}));
  }
  send(data: string) {
    this.sent.push(data);
    queueMicrotask(() => this.emit(JSON.stringify({ id: JSON.parse(data).id, result: {} })));
  }
  emit(data: string) {
    for (const callback of this.listeners.get("message") ?? []) callback({ data });
  }
}

class CommandFailureSocket extends Socket {
  override send(data: string) {
    this.sent.push(data);
    const request = JSON.parse(data);
    queueMicrotask(() =>
      this.emit(
        JSON.stringify({
          id: request.id,
          ...(request.method === "Runtime.enable"
            ? { error: { message: "stale renderer" } }
            : { result: {} }),
        }),
      ),
    );
  }
}

describe("OracleConversationEventSource", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    { timestamp: 999, startedAt: 1_000, replay: true },
    { timestamp: 1_000, startedAt: 1_000, replay: false },
    { timestamp: 1_001, startedAt: 1_000, replay: false },
    { timestamp: undefined, startedAt: 1_000, replay: false },
    { timestamp: "999", startedAt: 1_000, replay: false },
    { timestamp: -1, startedAt: 1_000, replay: false },
    { timestamp: 999, startedAt: undefined, replay: false },
    { timestamp: 999, startedAt: "1000", replay: false },
    { timestamp: 999, startedAt: -1, replay: false },
    { timestamp: 999, startedAt: 1_000, transportOpen: false, replay: false },
    { timestamp: 999, startedAt: 1_000, topicState: 1, replay: false },
    { timestamp: 1_000, startedAt: 1_000, duringEvaluate: true, replay: false },
  ])(
    "separates Runtime.enable replay from current subscription failure: %j",
    async ({ timestamp, startedAt, transportOpen, topicState, duringEvaluate, replay }) => {
      const socket = new Socket();
      socket.send = (data) => {
        socket.sent.push(data);
        const request = JSON.parse(data);
        queueMicrotask(() => {
          if (request.method === (duringEvaluate ? "Runtime.evaluate" : "Runtime.enable"))
            socket.emit(
              JSON.stringify({
                method: "Runtime.consoleAPICalled",
                params: {
                  timestamp,
                  args: [
                    { value: "ORACLE_NATIVE_TURN_SUBSCRIPTION_FAILED" },
                    { value: "ORACLE_NATIVE_PUBSUB_TRANSPORT_NOT_OPEN" },
                  ],
                },
              }),
            );
          const result =
            request.method === "Runtime.evaluate"
              ? {
                  result: {
                    value: {
                      state: "listening",
                      transportOpen: transportOpen ?? true,
                      conversationsTopicState: topicState ?? 0,
                      subscriptionStartedAtUnixMs: startedAt,
                    },
                  },
                }
              : {};
          socket.emit(JSON.stringify({ id: request.id, result }));
        });
      };
      const source = new OracleConversationEventSource({
        cdpEndpoint: "http://127.0.0.1:9222",
        transport: new ChatGptLoopbackCdpTransport({
          endpoint: "http://127.0.0.1:9222",
          fetch: async () =>
            new Response(
              JSON.stringify([
                {
                  id: "home",
                  type: "page",
                  url: "https://chatgpt.com/",
                  webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/home",
                },
              ]),
            ),
        }),
        factory: () => socket,
      });
      const signal = new AbortController().signal;
      try {
        if (replay) {
          await expect(source.ensureConnected(vi.fn(), signal)).resolves.toBe(true);
          await expect(source.ensureConnected(vi.fn(), signal)).resolves.toBe(false);
          expect(source.status().connected).toBe(true);
          socket.emit(
            JSON.stringify({
              method: "Runtime.consoleAPICalled",
              params: {
                timestamp: 1_001,
                args: [
                  { value: "ORACLE_NATIVE_TURN_SUBSCRIPTION_FAILED" },
                  { value: "ORACLE_NATIVE_PUBSUB_TRANSPORT_NOT_OPEN" },
                ],
              },
            }),
          );
          await expect(source.ensureConnected(vi.fn(), signal)).rejects.toThrow(
            "TRANSPORT_NOT_OPEN",
          );
        } else {
          await expect(source.ensureConnected(vi.fn(), signal)).rejects.toThrow(
            "TRANSPORT_NOT_OPEN",
          );
        }
        expect(source.status().connected).toBe(false);
        expect(socket.close).toHaveBeenCalledOnce();
      } finally {
        await source.stop();
      }
    },
  );

  it.each([true, false])(
    "admits one exhausted home recovery, then prefers its real subscription (recovers=%s)",
    async (recovers) => {
      vi.useFakeTimers();
      const targets = [
        {
          id: "conversation",
          type: "page",
          url: `https://chatgpt.com/c/${conversationId}`,
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/conversation",
        },
        {
          id: "home",
          type: "page",
          url: "https://chatgpt.com/",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/home",
        },
      ];
      let reloads = 0;
      const selected: string[] = [];
      const inspect = vi.fn();
      const admit = vi.fn(async () => true);
      const source = new OracleConversationEventSource({
        cdpEndpoint: "http://127.0.0.1:9222",
        transport: new ChatGptLoopbackCdpTransport({
          endpoint: "http://127.0.0.1:9222",
          fetch: async () => new Response(JSON.stringify(targets)),
        }),
        factory: (url) => {
          selected.push(url);
          const socket = new Socket();
          socket.send = (data) => {
            const request = JSON.parse(data);
            let result: unknown = {};
            if (request.method === "Runtime.evaluate") {
              const expression = request.params.expression;
              if (expression === oracleNativeHomeRecoveryExpression(false)) {
                inspect(url);
                result = { result: { value: { state: "eligible" } } };
              } else if (expression === oracleNativeHomeRecoveryExpression(true)) {
                reloads += 1;
                result = { result: { value: { state: "reloading" } } };
              } else if (!(recovers && reloads && url.endsWith("/home"))) {
                result = { exceptionDetails: { text: "ORACLE_NATIVE_PUBSUB_TRANSPORT_NOT_OPEN" } };
              } else
                result = {
                  result: {
                    value: { state: "listening", transportOpen: true, conversationsTopicState: 0 },
                  },
                };
            }
            queueMicrotask(() => socket.emit(JSON.stringify({ id: request.id, result })));
          };
          return socket;
        },
      });
      const signal = new AbortController().signal;
      try {
        const attempts = await Promise.allSettled([
          source.ensureConnected(vi.fn(), signal, admit),
          source.ensureConnected(vi.fn(), signal, admit),
        ]);
        expect(attempts.every((attempt) => attempt.status === "rejected")).toBe(true);
        expect(reloads).toBe(1);
        expect(admit).toHaveBeenCalledOnce();
        expect(inspect).toHaveBeenCalledOnce();
        expect(inspect).toHaveBeenCalledWith(expect.stringContaining("/home"));
        expect(source.status().connected).toBe(false);
        await vi.advanceTimersByTimeAsync(15_000);
        const offset = selected.length;
        if (recovers) {
          await expect(source.ensureConnected(vi.fn(), signal, admit)).resolves.toBe(true);
          expect(selected.slice(offset)).toEqual([targets[1]?.webSocketDebuggerUrl]);
          expect(source.status().connected).toBe(true);
        } else {
          await expect(source.ensureConnected(vi.fn(), signal, admit)).rejects.toThrow(
            "TRANSPORT_NOT_OPEN",
          );
          expect(source.status().connected).toBe(false);
          await vi.advanceTimersByTimeAsync(120_000);
          await expect(source.ensureConnected(vi.fn(), signal, admit)).rejects.toThrow(
            "TRANSPORT_NOT_OPEN",
          );
        }
        expect(reloads).toBe(1);
        expect(admit).toHaveBeenCalledOnce();
      } finally {
        await source.stop();
      }
    },
  );

  it("suppresses known-unauthenticated renderer lookups and resumes immediately after auth recovery", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response("[]"));
    fetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify([
            {
              id: "home",
              type: "page",
              url: "https://chatgpt.com/",
              webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/home",
            },
          ]),
        ),
    );
    const socket = new Socket();
    const source = new OracleConversationEventSource({
      cdpEndpoint: "http://127.0.0.1:9222",
      transport: new ChatGptLoopbackCdpTransport({ endpoint: "http://127.0.0.1:9222", fetch }),
      factory: () => socket,
    });
    const callback = vi.fn();
    const signal = new AbortController().signal;
    try {
      await expect(source.ensureConnected(callback, signal)).rejects.toThrow(
        "EVENT_RENDERER_MISSING",
      );
      const failure = new Error("ORACLE_SERVER_APPROVAL_RUNTIME_AUTHENTICATION_REQUIRED");
      source.setAuthenticationFailure(failure);
      for (let index = 0; index < 20; index += 1)
        await expect(source.ensureConnected(callback, signal)).rejects.toBe(failure);
      expect(fetch).toHaveBeenCalledOnce();
      source.setAuthenticationFailure(undefined);
      // No advance of the event source's pre-existing 15-second retry deadline.
      await expect(source.ensureConnected(callback, signal)).resolves.toBe(true);
      source.setAuthenticationFailure(failure);
      socket.emit(frame(update));
      expect(callback).toHaveBeenCalledExactlyOnceWith(
        `https://chatgpt.com/c/${conversationId}`,
        update,
      );
      expect(socket.close).not.toHaveBeenCalled();
      source.setAuthenticationFailure(undefined);
      await expect(source.ensureConnected(callback, signal)).resolves.toBe(false);
    } finally {
      await source.stop();
    }
  });

  it.each(["/auth/error?error=undefined", "/api/auth/session"])(
    "reports the actual missing event page condition: %s",
    async (path) => {
      const factory = vi.fn(() => new Socket());
      const source = new OracleConversationEventSource({
        cdpEndpoint: "http://127.0.0.1:9222",
        transport: new ChatGptLoopbackCdpTransport({
          endpoint: "http://127.0.0.1:9222",
          fetch: async () =>
            new Response(
              JSON.stringify([
                {
                  id: "auth",
                  type: "page",
                  url: `https://chatgpt.com${path}`,
                  webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/auth",
                },
              ]),
            ),
        }),
        factory,
      });
      await expect(source.ensureConnected(vi.fn(), new AbortController().signal)).rejects.toThrow(
        path.startsWith("/auth/error")
          ? "ORACLE_SERVER_APPROVAL_RUNTIME_AUTHENTICATION_REQUIRED"
          : "ORACLE_SERVER_APPROVAL_EVENT_RENDERER_MISSING",
      );
      expect(factory).not.toHaveBeenCalled();
      await source.stop();
    },
  );

  it("reports only the selected target/session digests and current-session frame count", async () => {
    const socket = new Socket();
    const source = new OracleConversationEventSource({
      cdpEndpoint: "http://127.0.0.1:9222",
      transport: new ChatGptLoopbackCdpTransport({
        endpoint: "http://127.0.0.1:9222",
        fetch: async () =>
          new Response(
            JSON.stringify([
              {
                id: "private-target",
                type: "page",
                url: "https://chatgpt.com/",
                webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/private-target",
              },
            ]),
          ),
      }),
      factory: () => socket,
    });
    expect(source.status()).toEqual({ connected: false, webSocketFramesReceived: 0 });
    await source.ensureConnected(vi.fn(), new AbortController().signal);
    const connected = source.status();
    expect(connected).toEqual({
      connected: true,
      targetIdSha256: createHash("sha256").update("private-target").digest("hex"),
      cdpSessionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      webSocketFramesReceived: 0,
    });
    socket.emit(frame(update));
    socket.emit(frame({ unrelated: "private-payload" }));
    socket.emit(JSON.stringify({ method: "Runtime.consoleAPICalled", params: {} }));
    expect(source.status().webSocketFramesReceived).toBe(2);
    const exposed = JSON.stringify(source.status());
    expect(exposed).not.toContain("private-");
    expect(exposed).not.toContain("chatgpt.com");
    expect(exposed).not.toContain(conversationId);
    await source.stop();
    expect(source.status()).toEqual({ ...connected, connected: false, webSocketFramesReceived: 2 });
  });

  it("falls through to another ChatGPT renderer when the first target rejects CDP commands", async () => {
    const failed = new CommandFailureSocket();
    const connected = new Socket();
    const factory = vi.fn((url: string) => (url.endsWith("/first") ? failed : connected));
    const source = new OracleConversationEventSource({
      cdpEndpoint: "http://127.0.0.1:9222",
      transport: new ChatGptLoopbackCdpTransport({
        endpoint: "http://127.0.0.1:9222",
        fetch: async () =>
          new Response(
            JSON.stringify([
              {
                id: "first",
                type: "page",
                url: "https://chatgpt.com/",
                webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/first",
              },
              {
                id: "second",
                type: "page",
                url: "https://chatgpt.com/",
                webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/second",
              },
            ]),
          ),
      }),
      factory,
    });
    try {
      await expect(source.ensureConnected(vi.fn(), new AbortController().signal)).resolves.toBe(
        true,
      );
      expect(factory).toHaveBeenCalledTimes(2);
      expect(failed.close).toHaveBeenCalledOnce();
      expect(source.status()).toMatchObject({
        connected: true,
        targetIdSha256: createHash("sha256").update("second").digest("hex"),
      });
    } finally {
      await source.stop();
    }
  });

  it("prefers an existing conversation renderer over idle home renderers", async () => {
    const home = new CommandFailureSocket();
    const conversation = new Socket();
    const factory = vi.fn((url: string) => (url.endsWith("/conversation") ? conversation : home));
    const targetId = "conversation";
    const source = new OracleConversationEventSource({
      cdpEndpoint: "http://127.0.0.1:9222",
      transport: new ChatGptLoopbackCdpTransport({
        endpoint: "http://127.0.0.1:9222",
        fetch: async () =>
          new Response(
            JSON.stringify([
              {
                id: "home",
                type: "page",
                url: "https://chatgpt.com/",
                webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/home",
              },
              {
                id: targetId,
                type: "page",
                url: `https://chatgpt.com/c/${conversationId}`,
                webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/conversation",
              },
            ]),
          ),
      }),
      factory,
    });

    try {
      await expect(source.ensureConnected(vi.fn(), new AbortController().signal)).resolves.toBe(
        true,
      );
      expect(factory).toHaveBeenCalledExactlyOnceWith(
        "ws://127.0.0.1:9222/devtools/page/conversation",
      );
      expect(source.status()).toMatchObject({
        connected: true,
        targetIdSha256: createHash("sha256").update(targetId).digest("hex"),
      });
      expect(home.sent).toHaveLength(0);
    } finally {
      await source.stop();
    }
  });

  it("preserves turn errors without turning them into approvals or completed responses", () => {
    const error = {
      code: "network_error",
      message: "A network error occurred. Please check your connection and try again.",
      status: 429,
    };
    const notifications: unknown[] = [];
    const approvals = vi.fn();
    const goals = vi.fn();
    const urls = oracleConversationUrlsFromCdpEvent(
      frame({
        type: "conversation-turn-stream",
        payload: {
          type: "stream-item",
          conversation_id: conversationId,
          turn_id: "failed-turn",
          encoded_item: `data: ${JSON.stringify({ conversation_id: conversationId, error })}\n\n`,
        },
      }),
      (_url, notification) => {
        notifications.push(notification);
        expect(
          oracleNotificationRequiresConnectorRead(
            notification,
            "asdk_app_owned",
            "OmniCodex",
            approvals,
            goals,
          ),
        ).toBe(false);
      },
    );
    expect(urls).toEqual([`https://chatgpt.com/c/${conversationId}`]);
    expect(notifications).toEqual([
      {
        type: "conversation-turn-error",
        payload: { conversation_id: conversationId, turn_id: "failed-turn", error },
      },
    ]);
    expect(approvals).not.toHaveBeenCalled();
    expect(goals).not.toHaveBeenCalled();
  });

  it("recovers error catchups with the envelope identity and rejects conflicting inner identities", () => {
    const errorRecord = (body: unknown) => ({
      payload: {
        type: "conversation-turn-stream",
        payload: {
          type: "stream-item",
          conversation_id: conversationId,
          turn_id: "failed-turn",
          encoded_item: `data: ${JSON.stringify(body)}\n\n`,
        },
      },
    });
    const notifications: unknown[] = [];
    oracleConversationUrlsFromCdpEvent(
      frame({
        id: 3,
        reply: {
          type: "subscribe",
          recovered: true,
          catchups: [
            errorRecord({ error: "Connection closed", error_code: "network_error", status: 503 }),
            errorRecord({
              conversation_id: "660e8400-e29b-41d4-a716-446655440000",
              error: "Unrelated error",
            }),
            errorRecord({ error: null, error_code: "upstream_unavailable" }),
          ],
        },
      }),
      (_url, notification) => notifications.push(notification),
    );
    expect(notifications).toEqual([
      {
        type: "conversation-turn-error",
        payload: {
          conversation_id: conversationId,
          turn_id: "failed-turn",
          error: { code: "network_error", message: "Connection closed", status: 503 },
        },
      },
      {
        type: "conversation-turn-error",
        payload: {
          conversation_id: conversationId,
          turn_id: "failed-turn",
          error: { code: "upstream_unavailable" },
        },
      },
    ]);
  });

  it("preserves the desktop stream turn id separately from the final message id", () => {
    const turnId = "862d42d5-a60f-4b57-97d4-bee8445ade7e";
    const message = {
      id: "cca692b2-964a-47a8-8568-d72a9bcac2a5",
      author: { role: "assistant" },
      status: "finished_successfully",
      end_turn: true,
      channel: "final",
    };
    const notifications: unknown[] = [];
    const receive = (payload: unknown) =>
      oracleConversationUrlsFromCdpEvent(
        frame({ type: "message", payload: { type: "conversation-turn-stream", payload } }),
        (_url, notification) => notifications.push(notification),
      );
    receive({
      type: "stream-item",
      conversation_id: conversationId,
      turn_id: turnId,
      encoded_item: `data: ${JSON.stringify({ conversation_id: conversationId, message })}\n\n`,
    });
    receive({ type: "done", conversation_id: conversationId, turn_id: turnId });
    expect(notifications).toEqual([
      {
        type: "conversation-update",
        payload: {
          conversation_id: conversationId,
          turn_id: turnId,
          update_type: "add-messages",
          update_content: { messages: [message] },
        },
      },
      {
        type: "conversation-turn-complete",
        payload: { conversation_id: conversationId, turn_id: turnId },
      },
    ]);
    notifications.length = 0;
    receive({
      type: "stream-item",
      conversation_id: conversationId,
      turn_id: { invalid: "not an identifier" },
      encoded_item: `data: ${JSON.stringify({ conversation_id: conversationId, message })}\n\n`,
    });
    expect(notifications[0]).not.toHaveProperty("payload.turn_id");
  });

  it("reads an approval from the native conversation-turn-stream SSE envelope", () => {
    const message = {
      id: "pending-stream-approval",
      author: { role: "tool", name: "api_tool.call_tool" },
      status: "finished_successfully",
      metadata: {
        jit_plugin_data: {
          from_server: {
            type: "confirm_action",
            body: {
              connector_id: "asdk_app_owned",
              connector_name: "OmniCodex",
              actions: [{ allow: { target_message_id: "attachment-operation" } }],
            },
          },
        },
      },
    };
    const stream = (innerId: string, encodedItem: string) =>
      frame({
        type: "message",
        topic_id: "conversation-turn-current",
        payload: {
          type: "conversation-turn-stream",
          payload: {
            type: "stream-item",
            conversation_id: conversationId,
            turn_id: "current-turn",
            encoded_item: encodedItem.replace("INNER_ID", innerId),
          },
        },
      });
    const encoded = `data: ${JSON.stringify({ message, conversation_id: "INNER_ID", error: null, error_code: null })}\n\n`;
    const approvals: unknown[] = [];
    const notifications: unknown[] = [];
    expect(
      oracleConversationUrlsFromCdpEvent(stream(conversationId, encoded), (url, notification) => {
        notifications.push({ url, type: notification.type });
        expect(
          oracleNotificationRequiresConnectorRead(
            notification,
            "asdk_app_owned",
            "OmniCodex",
            (approval) => approvals.push(approval),
          ),
        ).toBe(true);
      }),
    ).toEqual([`https://chatgpt.com/c/${conversationId}`]);
    expect(notifications).toEqual([
      { url: `https://chatgpt.com/c/${conversationId}`, type: "conversation-update" },
    ]);
    expect(approvals).toEqual([
      { pendingMessageId: message.id, targetMessageIds: ["attachment-operation"] },
    ]);
    expect(
      oracleConversationUrlsFromCdpEvent(stream("660e8400-e29b-41d4-a716-446655440000", encoded)),
    ).toEqual([]);
    expect(oracleConversationUrlsFromCdpEvent(stream(conversationId, "data: [DONE]\n\n"))).toEqual(
      [],
    );
    expect(
      oracleConversationUrlsFromCdpEvent(
        stream(
          conversationId,
          `data: ${JSON.stringify({ conversation_id: "INNER_ID", type: "server_ste_metadata", metadata: message.metadata })}\n\n`,
        ),
      ),
    ).toEqual([]);
  });

  it("selects connector approvals and native Goal results without reading unrelated message text", () => {
    const approval = (connector: string) => ({
      type: "conversation-update" as const,
      payload: {
        update_content: {
          messages: [
            {
              id: "confirmation",
              metadata: {
                jit_plugin_data: {
                  from_server: {
                    type: "confirm_action",
                    body: {
                      connector_id: connector,
                      actions: [{ type: "allow", allow: { target_message_id: "operation" } }],
                    },
                  },
                },
              },
            },
          ],
        },
      },
    });
    expect(
      oracleNotificationRequiresConnectorRead(
        approval("asdk_app_owned"),
        "asdk_app_owned",
        "OmniCodex",
      ),
    ).toBe(true);
    expect(
      oracleNotificationRequiresConnectorRead(
        approval("asdk_app_other"),
        "asdk_app_owned",
        "OmniCodex",
      ),
    ).toBe(false);
    expect(
      oracleNotificationRequiresConnectorRead(
        {
          type: "conversation-update",
          payload: { messages: [{ content: approval("asdk_app_owned") }] },
        },
        "asdk_app_owned",
        "OmniCodex",
      ),
    ).toBe(false);
    expect(
      oracleNotificationRequiresConnectorRead(
        { type: "conversation-turn-complete", payload: {} },
        "asdk_app_owned",
        "OmniCodex",
      ),
    ).toBe(false);
    expect(
      oracleNotificationRequiresConnectorRead(
        {
          type: "conversation-update",
          payload: {
            messages: [
              {
                id: "goal-result",
                author: { role: "tool", name: "api_tool.call_tool" },
                metadata: {
                  invoked_resource: {
                    resource_uri: "/asdk_app_owned/link_owner/omnicodex__goal_create",
                  },
                },
              },
            ],
          },
        },
        "asdk_app_owned",
        "OmniCodex",
      ),
    ).toBe(true);
  });
  it("extracts only exact conversation-update identities from actual CDP framing", () => {
    expect(oracleConversationUrlsFromCdpEvent(frame([update, update]))).toEqual([
      `https://chatgpt.com/c/${conversationId}`,
    ]);
    expect(oracleConversationUrlsFromCdpEvent(frame({ ...update, type: "other-event" }))).toEqual(
      [],
    );
    expect(
      oracleConversationUrlsFromCdpEvent(
        frame({ ...update, payload: { conversation_id: "../../account" } }),
      ),
    ).toEqual([]);
    expect(oracleConversationUrlsFromCdpEvent("not-json")).toEqual([]);
    expect(
      oracleConversationUrlsFromCdpEvent(
        JSON.stringify({ method: "Network.requestWillBeSent", params: update }),
      ),
    ).toEqual([]);
  });

  it("unwraps the native PubSub message envelope before filtering or deduplicating updates", () => {
    const envelope = (payload: unknown) => ({
      type: "message",
      topic_id: "user-notifications",
      payload,
    });
    expect(oracleConversationUrlsFromCdpEvent(frame(envelope(update)))).toEqual([
      `https://chatgpt.com/c/${conversationId}`,
    ]);
    expect(oracleConversationUrlsFromCdpEvent(frame([envelope(update), update]))).toEqual([
      `https://chatgpt.com/c/${conversationId}`,
    ]);
    // Observed on the native socket: completion notifications carry the
    // exact conversation identity without an add-messages update body.
    const completed = {
      type: "conversation-turn-complete",
      payload: { conversation_id: conversationId },
      metadata: {},
    };
    expect(oracleConversationUrlsFromCdpEvent(frame(envelope(completed)))).toEqual([
      `https://chatgpt.com/c/${conversationId}`,
    ]);
    expect(
      oracleConversationUrlsFromCdpEvent(frame([envelope(completed), envelope(update)])),
    ).toEqual([`https://chatgpt.com/c/${conversationId}`]);
    const ordinaryProgress = {
      ...update,
      payload: {
        conversation_id: conversationId,
        update_type: "add-messages",
        update_content: {
          messages: [{ status: "in_progress", metadata: { message_type: "next" } }],
        },
      },
    };
    expect(oracleConversationUrlsFromCdpEvent(frame(envelope(ordinaryProgress)))).toEqual([]);
    for (const payload of [null, {}, { ...update, type: "other-event" }]) {
      expect(oracleConversationUrlsFromCdpEvent(frame(envelope(payload)))).toEqual([]);
    }
    expect(
      oracleConversationUrlsFromCdpEvent(frame({ type: "other-event", payload: update })),
    ).toEqual([]);
  });

  it("delivers recovered native subscription notifications through the same exact-approval filter", () => {
    const confirmation = {
      type: "conversation-update" as const,
      payload: {
        conversation_id: conversationId,
        update_type: "add-messages",
        update_content: {
          messages: [
            {
              id: "pending-confirmation",
              metadata: {
                jit_plugin_data: {
                  from_server: {
                    type: "confirm_action",
                    body: {
                      connector_id: "asdk_app_owned",
                      actions: [{ allow: { target_message_id: "native-operation" } }],
                    },
                  },
                },
              },
            },
          ],
        },
      },
    };
    const reply = {
      id: 7,
      reply: {
        type: "subscribe",
        topic_id: "user-notifications",
        recovered: true,
        catchups: [
          { offset: "71", payload: confirmation },
          {
            offset: "72",
            payload: {
              ...update,
              payload: {
                conversation_id: conversationId,
                update_type: "add-messages",
                update_content: {
                  messages: [{ status: "in_progress", metadata: { message_type: "next" } }],
                },
              },
            },
          },
          {
            offset: "73",
            payload: {
              type: "conversation-turn-complete",
              payload: { conversation_id: conversationId },
            },
          },
        ],
      },
    };
    const onApproval = vi.fn();
    const delivered: string[] = [];
    expect(
      oracleConversationUrlsFromCdpEvent(frame([reply]), (url, notification) => {
        delivered.push(notification.type);
        expect(url).toBe(`https://chatgpt.com/c/${conversationId}`);
        oracleNotificationRequiresConnectorRead(
          notification,
          "asdk_app_owned",
          "OmniCodex",
          onApproval,
        );
        expect(
          oracleNotificationRequiresConnectorRead(notification, "asdk_app_other", "Other"),
        ).toBe(false);
      }),
    ).toEqual([`https://chatgpt.com/c/${conversationId}`]);
    expect(delivered).toEqual(["conversation-update", "conversation-turn-complete"]);
    expect(onApproval).toHaveBeenCalledExactlyOnceWith({
      pendingMessageId: "pending-confirmation",
      targetMessageIds: ["native-operation"],
    });
    for (const invalid of [
      { ...reply.reply, recovered: false },
      { ...reply.reply, type: "unsubscribe" },
      { ...reply.reply, catchups: {} },
    ]) {
      expect(oracleConversationUrlsFromCdpEvent(frame({ id: 7, reply: invalid }))).toEqual([]);
    }
  });

  it("reports turn errors separately while preserving the existing notification callback", async () => {
    const socket = new Socket();
    const onTurnError = vi.fn();
    const onRequestIdentity = vi.fn();
    const source = new OracleConversationEventSource({
      cdpEndpoint: "http://127.0.0.1:9222",
      transport: new ChatGptLoopbackCdpTransport({
        endpoint: "http://127.0.0.1:9222",
        fetch: async () =>
          new Response(
            JSON.stringify([
              {
                id: "home",
                type: "page",
                url: "https://chatgpt.com/",
                webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/home",
              },
            ]),
          ),
      }),
      factory: () => socket,
      onTurnError,
      onRequestIdentity,
    });
    const onConversation = vi.fn();
    await source.ensureConnected(onConversation, new AbortController().signal);
    const sentBeforeProgress = socket.sent.length;
    const progress = {
      type: "conversation-update",
      payload: {
        conversation_id: conversationId,
        update_type: "add-messages",
        update_content: {
          messages: [
            {
              status: "in_progress",
              content: { text: "private body" },
              metadata: { message_type: "next", request_id: "Exact-ID" },
            },
            { status: "in_progress", metadata: { message_type: "next", request_id: "Exact-ID" } },
          ],
        },
      },
    };
    socket.emit(frame(progress));
    expect(onRequestIdentity).toHaveBeenCalledExactlyOnceWith(
      `https://chatgpt.com/c/${conversationId}`,
      ["Exact-ID"],
    );
    expect(onConversation).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(sentBeforeProgress);
    expect(JSON.stringify(onRequestIdentity.mock.calls)).not.toContain("private body");
    socket.emit(frame(update));
    expect(onTurnError).not.toHaveBeenCalled();
    socket.emit(
      frame({
        type: "conversation-turn-stream",
        payload: {
          type: "stream-item",
          conversation_id: conversationId,
          turn_id: "failed-turn",
          encoded_item: `data: ${JSON.stringify({ error: "Network error" })}\n\n`,
        },
      }),
    );
    const notification = {
      type: "conversation-turn-error",
      payload: {
        conversation_id: conversationId,
        turn_id: "failed-turn",
        error: { message: "Network error" },
      },
    };
    expect(onTurnError).toHaveBeenCalledExactlyOnceWith(
      `https://chatgpt.com/c/${conversationId}`,
      notification,
    );
    expect(onConversation).toHaveBeenLastCalledWith(
      `https://chatgpt.com/c/${conversationId}`,
      notification,
    );
    await source.stop();
  });

  it("shares one passive inspector, reacquires after disconnect, and never closes the browser tab", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify([
            {
              id: "home",
              type: "page",
              url: "https://chatgpt.com/",
              webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/home",
            },
          ]),
        ),
    );
    const sockets: Socket[] = [];
    const source = new OracleConversationEventSource({
      cdpEndpoint: "http://127.0.0.1:9222",
      transport: new ChatGptLoopbackCdpTransport({ endpoint: "http://127.0.0.1:9222", fetch }),
      factory: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket;
      },
    });
    const onConversation = vi.fn();
    const signal = new AbortController().signal;
    const connections = await Promise.all([
      source.ensureConnected(onConversation, signal),
      source.ensureConnected(onConversation, signal),
    ]);
    expect(connections).toEqual([true, false]);
    expect(await source.ensureConnected(onConversation, signal)).toBe(false);
    expect(sockets).toHaveLength(1);
    sockets[0]?.emit(frame(update));
    expect(onConversation).toHaveBeenCalledExactlyOnceWith(
      `https://chatgpt.com/c/${conversationId}`,
      update,
    );
    sockets[0]?.close();
    await expect(source.ensureConnected(onConversation, signal)).rejects.toThrow(
      "ORACLE_SERVER_APPROVAL_EVENT_STREAM_CLOSED",
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await source.ensureConnected(onConversation, signal)).toBe(true);
    expect(sockets).toHaveLength(2);
    sockets[1]?.emit(frame(update));
    expect(onConversation).toHaveBeenCalledTimes(2);
    await source.stop();
    sockets[1]?.emit(frame(update));
    expect(onConversation).toHaveBeenCalledTimes(2);
    expect(sockets.flatMap((socket) => socket.sent.map((s) => JSON.parse(s).method))).toEqual([
      "Network.enable",
      "Runtime.enable",
      "Runtime.evaluate",
      "Network.enable",
      "Runtime.enable",
      "Runtime.evaluate",
      "Runtime.evaluate",
    ]);
    expect(fetch.mock.calls.every(([url]) => String(url).endsWith("/json/list"))).toBe(true);
  });

  it("reacquires a failed native subscription instead of retaining a healthy-looking inspector", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify([
            {
              id: "home",
              type: "page",
              url: "https://chatgpt.com/",
              webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/home",
            },
          ]),
        ),
    );
    const sockets: Socket[] = [];
    const source = new OracleConversationEventSource({
      cdpEndpoint: "http://127.0.0.1:9222",
      transport: new ChatGptLoopbackCdpTransport({ endpoint: "http://127.0.0.1:9222", fetch }),
      factory: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket;
      },
    });
    const signal = new AbortController().signal;
    const onConversation = vi.fn();
    try {
      await source.ensureConnected(onConversation, signal);
      sockets[0]?.emit(
        JSON.stringify({
          method: "Runtime.consoleAPICalled",
          params: {
            args: [
              { value: "ORACLE_NATIVE_TURN_SUBSCRIPTION_FAILED" },
              { value: "ORACLE_NATIVE_PUBSUB_TRANSPORT_NOT_OPEN" },
            ],
          },
        }),
      );
      const failure = await source.ensureConnected(onConversation, signal).catch((error) => error);
      expect(failure).toMatchObject({ message: "ORACLE_NATIVE_PUBSUB_TRANSPORT_NOT_OPEN" });
      expect(source.status().connected).toBe(false);
      expect(sockets[0]?.close).toHaveBeenCalledOnce();
      for (let i = 0; i < 3; i++)
        await expect(source.ensureConnected(onConversation, signal)).rejects.toBe(failure);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(source.ensureConnected(onConversation, signal)).resolves.toBe(true);
      expect(sockets).toHaveLength(2);
      sockets[0]?.emit(frame(update));
      expect(onConversation).not.toHaveBeenCalled();
      sockets[1]?.emit(frame(update));
      expect(onConversation).toHaveBeenCalledOnce();
      expect(fetch.mock.calls.every(([url]) => String(url).endsWith("/json/list"))).toBe(true);
    } finally {
      await source.stop();
    }
  });

  it("skips only fully identified ordinary generation progress and preserves every uncertain or approval update", () => {
    const progress = {
      status: "in_progress",
      metadata: {
        message_type: "next",
        permissions: [{ type: "notification", status: "requested" }],
      },
    };
    const messagesUpdate = (messages: unknown, updateType = "add-messages") => ({
      ...update,
      payload: {
        conversation_id: conversationId,
        update_type: updateType,
        update_content: { messages },
      },
    });
    expect(oracleConversationUrlsFromCdpEvent(frame(messagesUpdate([progress, progress])))).toEqual(
      [],
    );
    const confirmation = {
      ...progress,
      metadata: {
        ...progress.metadata,
        jit_plugin_data: { from_server: { type: "confirm_action" } },
      },
    };
    for (const messages of [
      [progress, confirmation],
      [confirmation, progress],
      [progress, {}],
      [{ ...progress, metadata: { ...progress.metadata, jit_plugin_data: null } }],
      [{ ...progress, status: "finished_successfully" }],
      [{ ...progress, metadata: { message_type: "continue" } }],
      [{ status: "in_progress" }],
      [null],
      [],
      undefined,
    ]) {
      expect(oracleConversationUrlsFromCdpEvent(frame(messagesUpdate(messages)))).toEqual([
        `https://chatgpt.com/c/${conversationId}`,
      ]);
    }
    expect(
      oracleConversationUrlsFromCdpEvent(frame(messagesUpdate([progress], "replace-messages"))),
    ).toEqual([`https://chatgpt.com/c/${conversationId}`]);
    expect(
      oracleConversationUrlsFromCdpEvent(
        frame([messagesUpdate([progress]), messagesUpdate([confirmation])]),
      ),
    ).toEqual([`https://chatgpt.com/c/${conversationId}`]);
  });

  it("paces repeated connected-socket failures, preserves the first error, and ignores duplicate disconnect events", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify([
            {
              id: "home",
              type: "page",
              url: "https://chatgpt.com/",
              webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/home",
            },
          ]),
        ),
    );
    const sockets: Socket[] = [];
    const factory = vi.fn((_url: string) => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    });
    const source = new OracleConversationEventSource({
      cdpEndpoint: "http://127.0.0.1:9222",
      transport: new ChatGptLoopbackCdpTransport({ endpoint: "http://127.0.0.1:9222", fetch }),
      factory,
    });
    const signal = new AbortController().signal;
    const onConversation = vi.fn();
    try {
      await source.ensureConnected(onConversation, signal);
      for (let failureIndex = 0; failureIndex < 3; failureIndex += 1) {
        const socket = sockets.at(-1);
        if (socket === undefined) throw new Error("Expected an attached event socket");
        const failure = new Error(`native transport failed ${failureIndex}`);
        for (const listener of socket.listeners.get("error") ?? []) listener({ data: failure });
        const attempts = factory.mock.calls.length;
        for (let hotCall = 0; hotCall < 25; hotCall += 1) {
          await expect(source.ensureConnected(onConversation, signal)).rejects.toBe(failure);
        }
        expect(factory).toHaveBeenCalledTimes(attempts);
        expect(fetch).toHaveBeenCalledTimes(attempts);
        await vi.advanceTimersByTimeAsync(14_999);
        // A late duplicate close must neither erase the native error nor move
        // its existing retry deadline, so recovery still occurs at 15 seconds.
        socket.close();
        await expect(source.ensureConnected(onConversation, signal)).rejects.toBe(failure);
        await vi.advanceTimersByTimeAsync(1);
        await Promise.all([
          source.ensureConnected(onConversation, signal),
          source.ensureConnected(onConversation, signal),
        ]);
        expect(factory).toHaveBeenCalledTimes(attempts + 1);
      }
      sockets.at(-1)?.emit(frame(update));
      expect(onConversation).toHaveBeenCalledExactlyOnceWith(
        `https://chatgpt.com/c/${conversationId}`,
        update,
      );
      expect(
        factory.mock.calls.every(([url]) => url === "ws://127.0.0.1:9222/devtools/page/home"),
      ).toBe(true);
      await source.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      await source.ensureConnected(onConversation, signal);
      expect(factory).toHaveBeenCalledTimes(4);
      expect(
        sockets.flatMap((socket) => socket.sent.map((message) => JSON.parse(message).method)),
      ).toEqual([
        ...Array.from({ length: 4 }, () => [
          "Network.enable",
          "Runtime.enable",
          "Runtime.evaluate",
        ]).flat(),
        "Runtime.evaluate",
      ]);
    } finally {
      await source.stop();
    }
  });

  it("preserves namespaced conversation identity when extracting Oracle events", () => {
    const namespacedUpdate = {
      ...update,
      payload: { ...update.payload, conversation_id: `WEB:${conversationId}` },
    };
    expect(oracleConversationUrlsFromCdpEvent(frame(namespacedUpdate))).toEqual([
      `https://chatgpt.com/c/WEB:${conversationId}`,
    ]);
    expect(oracleConversationUrlsFromCdpEvent(frame([update, namespacedUpdate]))).toEqual([
      `https://chatgpt.com/c/${conversationId}`,
      `https://chatgpt.com/c/WEB:${conversationId}`,
    ]);
    for (const invalidId of [
      "WEB:../../account",
      "WEB:not-a-uuid",
      `WEB:${conversationId}:extra`,
    ]) {
      expect(
        oracleConversationUrlsFromCdpEvent(
          frame({ ...update, payload: { conversation_id: invalidId } }),
        ),
      ).toEqual([]);
    }
  });
});
