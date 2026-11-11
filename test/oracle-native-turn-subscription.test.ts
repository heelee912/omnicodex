import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { ChatGptLoopbackCdpTransport } from "../src/infrastructure/chatgpt/chatgpt-cdp-transport.js";
import {
  oracleConversationUrlsFromCdpEvent,
  oracleNativeTurnTopics,
} from "../src/infrastructure/chatgpt/oracle-conversation-event-source.js";
import {
  isOracleNativeTurnSubscriptionExpression,
  oracleNativeHomeRecoveryExpression,
  oracleNativeTurnRecoveryExpression,
  oracleNativeTurnSubscriptionExpression,
} from "../src/infrastructure/chatgpt/oracle-native-turn-subscription.js";

describe("native turn subscription", () => {
  const topicId = "conversation-turn-00000000-0000-4000-8000-000000000001";

  it("returns the renderer clock from before native subscribe awaits", async () => {
    let now = 100;
    const topic = {
      state: 0,
      onMessage: vi.fn(() => vi.fn()),
      subscribe: vi.fn(async () => {
        now = 200;
      }),
    };
    const context = {
      Date: { now: () => now },
      __omnicodexNativeTurnSubscriptions: {
        topics: new Map(),
        client: {
          isTransportOpen: true,
          getTopic: () => topic,
          ws: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
        },
      },
    };
    await expect(
      runInNewContext(oracleNativeTurnSubscriptionExpression(), context),
    ).resolves.toMatchObject({
      state: "listening",
      subscriptionStartedAtUnixMs: 100,
    });
    expect(now).toBe(200);
  });

  it("reloads only an exhausted hidden empty home without modifying the native client", async () => {
    const reload = vi.fn();
    const client = {
      isTransportOpen: false,
      init: vi.fn(),
      connect: vi.fn(),
      ws: { readyState: 3, retryCount: 5, _options: { maxRetries: 5 }, _connectLock: true },
    };
    const context = {
      location: { origin: "https://chatgpt.com", pathname: "/", reload },
      document: { visibilityState: "hidden", querySelector: vi.fn(() => null as unknown) },
      __omnicodexNativeTurnSubscriptions: { recoveryClient: client },
    };
    expect(await runInNewContext(oracleNativeHomeRecoveryExpression(false), context)).toMatchObject(
      {
        state: "eligible",
      },
    );
    expect(reload).not.toHaveBeenCalled();
    expect(await runInNewContext(oracleNativeHomeRecoveryExpression(true), context)).toEqual({
      state: "reloading",
    });
    expect(reload).toHaveBeenCalledOnce();
    reload.mockClear();
    for (const change of [
      () => {
        context.location.pathname = "/c/existing-conversation";
      },
      () => {
        context.location.pathname = "/";
        context.document.visibilityState = "visible";
      },
      () => {
        context.document.visibilityState = "hidden";
        context.document.querySelector.mockReturnValue({ textContent: "draft" });
      },
      () => {
        context.document.querySelector.mockReturnValue(null);
        client.ws.retryCount = 4;
      },
      () => {
        client.ws.retryCount = 5;
        client.ws._connectLock = false;
      },
      () => {
        client.ws._connectLock = true;
        client.isTransportOpen = true;
      },
    ]) {
      change();
      expect(await runInNewContext(oracleNativeHomeRecoveryExpression(true), context)).toEqual({
        state: "ineligible",
      });
    }
    expect(reload).not.toHaveBeenCalled();
    expect(client.init).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();
    expect(isOracleNativeTurnSubscriptionExpression(oracleNativeHomeRecoveryExpression(true))).toBe(
      true,
    );
    expect(
      isOracleNativeTurnSubscriptionExpression(oracleNativeHomeRecoveryExpression(false)),
    ).toBe(true);
  });

  it("reacquires a replaced native client after disconnect without fetching cached assets", async () => {
    const asset = "https://chatgpt.com/cdn/assets/native-current.js";
    const oldRelease = vi.fn();
    const oldControlRelease = vi.fn();
    const oldClient = { isTransportOpen: false, getTopic: vi.fn() };
    const conversations = {
      state: 0,
      subscribe: vi.fn(async () => {}),
      onMessage: vi.fn(() => vi.fn()),
    };
    const replacement = {
      isTransportOpen: true,
      getTopic: vi.fn(() => conversations),
      ws: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    };
    const fetch = vi.fn();
    const importer = vi.fn(async () => ({ getClient: () => replacement }));
    const context = {
      __omnicodexNativeTurnSubscriptions: {
        client: oldClient,
        topics: new Map(),
        releaseHandoff: oldRelease,
        releaseControl: oldControlRelease,
        assetExports: new Map([[asset, "getClient"]]),
      },
      document: { querySelectorAll: () => [{ href: asset }] },
      fetch,
      importer,
    };
    const expression = oracleNativeTurnSubscriptionExpression().replace(
      "await import(path)",
      "await importer(path)",
    );
    await expect(runInNewContext(expression, context)).resolves.toMatchObject({
      state: "listening",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(oldClient.getTopic).not.toHaveBeenCalled();
    expect(oldRelease).toHaveBeenCalledOnce();
    expect(oldControlRelease).toHaveBeenCalledOnce();
    expect(conversations.subscribe).toHaveBeenCalledOnce();
  });

  it("moves the control listener to the replacement socket and releases the original socket", async () => {
    const topic = { state: 0, onMessage: vi.fn(() => vi.fn()), subscribe: vi.fn(async () => {}) };
    const firstSocket = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const secondSocket = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const client = { isTransportOpen: true, ws: firstSocket, getTopic: () => topic };
    const context = { __omnicodexNativeTurnSubscriptions: { client, topics: new Map() } };
    await runInNewContext(oracleNativeTurnSubscriptionExpression(), context);
    client.ws = secondSocket;
    await runInNewContext(oracleNativeTurnSubscriptionExpression(), context);
    expect(firstSocket.removeEventListener).toHaveBeenCalledWith("message", expect.any(Function));
    expect(firstSocket.removeEventListener).toHaveBeenCalledWith("close", expect.any(Function));
    expect(secondSocket.addEventListener).toHaveBeenCalledWith("message", expect.any(Function));
    await runInNewContext(oracleNativeTurnSubscriptionExpression(null), context);
    expect(secondSocket.removeEventListener).toHaveBeenCalledWith("message", expect.any(Function));
    expect(secondSocket.removeEventListener).toHaveBeenCalledWith("close", expect.any(Function));
  });

  it("reports a native socket close even while the CDP inspector remains open", async () => {
    const listeners = new Map<string, () => void>();
    const error = vi.fn();
    const context = {
      console: { error },
      __omnicodexNativeTurnSubscriptions: {
        topics: new Map(),
        client: {
          isTransportOpen: true,
          getTopic: () => ({ state: 0, onMessage: () => () => {}, subscribe: async () => {} }),
          ws: {
            addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
            removeEventListener: (type: string) => listeners.delete(type),
          },
        },
      },
    };
    await runInNewContext(oracleNativeTurnSubscriptionExpression(), context);
    listeners.get("close")?.();
    expect(error).toHaveBeenCalledWith(
      "ORACLE_NATIVE_TURN_SUBSCRIPTION_FAILED",
      "ORACLE_NATIVE_PUBSUB_TRANSPORT_NOT_OPEN",
    );
    await runInNewContext(oracleNativeTurnSubscriptionExpression(null), context);
    expect(listeners.size).toBe(0);
  });

  it.each([0, 2])(
    "subscribes the shared conversations topic from native state %s without releasing UI ownership",
    async (initialState) => {
      const send = vi.fn();
      const topic = {
        state: initialState,
        onMessage: vi.fn(() => vi.fn()),
        unsubscribe: vi.fn(),
        subscribe: vi.fn(async () => {
          if (topic.state === 0) return;
          send();
          topic.state = 0;
        }),
      };
      const client = {
        isTransportOpen: true,
        getTopic: vi.fn(() => topic),
        ws: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
      };
      const context = { __omnicodexNativeTurnSubscriptions: { client, topics: new Map() } };
      for (let i = 0; i < 2; i++)
        expect(await runInNewContext(oracleNativeTurnSubscriptionExpression(), context)).toEqual({
          state: "listening",
          transportOpen: true,
          conversationsTopicState: 0,
          subscriptionStartedAtUnixMs: expect.any(Number),
        });
      expect(send).toHaveBeenCalledTimes(initialState === 0 ? 0 : 1);
      expect(topic.onMessage).toHaveBeenCalledOnce();
      await runInNewContext(oracleNativeTurnSubscriptionExpression(null), context);
      expect(topic.unsubscribe).not.toHaveBeenCalled();
    },
  );

  it.each(["reject", "pending", "disconnected"])(
    "does not report listening when conversations subscribe is %s",
    async (failure) => {
      const topic = {
        state: failure === "disconnected" ? 0 : 1,
        onMessage: vi.fn(() => vi.fn()),
        subscribe: vi.fn(async () => {
          if (failure === "reject") throw new Error("native subscribe rejected");
        }),
      };
      const client = {
        isTransportOpen: failure !== "disconnected",
        getTopic: vi.fn(() => topic),
        ws: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
      };
      const asset = "https://chatgpt.com/cdn/assets/native-current.js";
      const context = {
        __omnicodexNativeTurnSubscriptions: {
          client,
          topics: new Map(),
          assetExports: new Map([[asset, "getClient"]]),
        },
        document: { querySelectorAll: () => [{ href: asset }] },
        importer: async () => ({ getClient: () => client }),
      };
      await expect(
        runInNewContext(
          oracleNativeTurnSubscriptionExpression().replace(
            "await import(path)",
            "await importer(path)",
          ),
          context,
        ),
      ).rejects.toThrow(
        failure === "reject"
          ? "native subscribe rejected"
          : failure === "disconnected"
            ? "ORACLE_NATIVE_PUBSUB_TRANSPORT_NOT_OPEN"
            : "ORACLE_NATIVE_CONVERSATIONS_SUBSCRIPTION_NOT_READY",
      );
    },
  );

  it("discovers retained entry modules after navigation removes their preload links", async () => {
    const fetch = vi.fn(async (_path: string) => ({ ok: true, text: async () => "export{}" }));
    const context = {
      __reactRouterManifest: {
        entry: {
          module: "/cdn/assets/entry-current.js",
          imports: [
            "/cdn/assets/shared-current.js",
            "https://chatgpt.com/cdn/assets/shared-current.js",
            "https://unrelated.example/module.js",
            "/backend-api/conversations",
          ],
        },
      },
      document: {
        querySelectorAll: () => [{ href: "https://chatgpt.com/cdn/assets/route-current.js" }],
      },
      fetch,
    };
    const expression = oracleNativeTurnSubscriptionExpression();
    await expect(runInNewContext(expression, context)).rejects.toThrow(
      "ORACLE_NATIVE_PUBSUB_CLIENT_MISSING",
    );
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "https://chatgpt.com/cdn/assets/entry-current.js",
      "https://chatgpt.com/cdn/assets/shared-current.js",
      "https://chatgpt.com/cdn/assets/route-current.js",
    ]);
    await expect(runInNewContext(expression, context)).rejects.toThrow(
      "ORACLE_NATIVE_PUBSUB_CLIENT_MISSING",
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not refetch unchanged assets after missing-client retries but discovers new assets", async () => {
    const paths = ["https://chatgpt.com/cdn/assets/old-hash.js"];
    const fetch = vi.fn(async () => ({ ok: true, text: async () => "export{}" }));
    const context = {
      document: { querySelectorAll: () => paths.map((href) => ({ href })) },
      fetch,
    };
    const expression = oracleNativeTurnSubscriptionExpression();
    await expect(runInNewContext(expression, context)).rejects.toThrow(
      "ORACLE_NATIVE_PUBSUB_CLIENT_MISSING",
    );
    await expect(runInNewContext(expression, context)).rejects.toThrow(
      "ORACLE_NATIVE_PUBSUB_CLIENT_MISSING",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    paths.push("https://chatgpt.com/cdn/assets/new-hash.js");
    await expect(runInNewContext(expression, context)).rejects.toThrow(
      "ORACLE_NATIVE_PUBSUB_CLIENT_MISSING",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith(paths[1]);
  });

  it("does not cache an unsuccessful asset response as a missing client", async () => {
    let now = Date.UTC(2026, 8, 9);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValue({ ok: true, text: async () => "export{}" });
    const context = {
      Date: { now: () => now, parse: Date.parse },
      document: {
        querySelectorAll: () => [{ href: "https://chatgpt.com/cdn/assets/current-hash.js" }],
      },
      fetch,
    };
    const expression = oracleNativeTurnSubscriptionExpression();
    await expect(runInNewContext(expression, context)).rejects.toThrow(
      "ORACLE_PUBSUB_ASSET_HTTP_429",
    );
    now += 30_000;
    await expect(runInNewContext(expression, context)).rejects.toThrow(
      "ORACLE_NATIVE_PUBSUB_CLIENT_MISSING",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("replays only a known turn on the existing connection and exposes expired history", async () => {
    const sendCommand = vi.fn(async () => ({
      type: "subscribe",
      topic_id: topicId,
      recovered: false,
      catchups: [],
    }));
    const expression = oracleNativeTurnRecoveryExpression(topicId);
    const context = {
      __omnicodexNativeTurnSubscriptions: { client: { isTransportOpen: true, sendCommand } },
    };
    expect(isOracleNativeTurnSubscriptionExpression(expression)).toBe(true);
    expect(isOracleNativeTurnSubscriptionExpression(`${expression};anything()`)).toBe(false);
    expect(() => oracleNativeTurnRecoveryExpression("conversations")).toThrow();
    expect(await runInNewContext(expression, context)).toMatchObject({
      state: "history_unavailable",
      recovered: false,
      catchupCount: 0,
    });
    expect(sendCommand).toHaveBeenCalledExactlyOnceWith({
      type: "subscribe",
      topic_id: topicId,
      offset: "0",
    });
  });

  it("only accepts the exact fixed operation and a turn topic", () => {
    const expression = oracleNativeTurnSubscriptionExpression(topicId);
    expect(isOracleNativeTurnSubscriptionExpression(expression)).toBe(true);
    expect(
      isOracleNativeTurnSubscriptionExpression(`${expression};fetch('/backend-api/conversations')`),
    ).toBe(false);
    expect(() => oracleNativeTurnSubscriptionExpression("conversations")).toThrow();
    const transport = new ChatGptLoopbackCdpTransport({ endpoint: "http://127.0.0.1:9222" });
    expect(() =>
      transport.assertAllowedCommand(
        "Runtime.evaluate",
        {
          expression,
          returnByValue: true,
          awaitPromise: true,
        },
        "home-renderer",
      ),
    ).not.toThrow();
    expect(() =>
      transport.assertAllowedCommand(
        "Runtime.evaluate",
        {
          expression: expression.replace("includeAllHistory: true", "includeAllHistory: false"),
          returnByValue: true,
          awaitPromise: true,
        },
        "home-renderer",
      ),
    ).toThrow();
  });

  it("uses the existing client, coalesces a topic and releases only its own completed subscription", async () => {
    let onMessage: (event: unknown) => void = () => {};
    const release = vi.fn();
    const topic = {
      state: 2,
      offset: "17",
      topicId,
      onMessage: vi.fn((callback) => {
        onMessage = callback;
        return release;
      }),
      onSubscribe: vi.fn(() => vi.fn()),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(),
    };
    const client = { getTopic: vi.fn(() => topic) };
    const fetch = vi.fn();
    const context = { __omnicodexNativeTurnSubscriptions: { client, topics: new Map() }, fetch };
    const expression = oracleNativeTurnSubscriptionExpression(topicId);
    await runInNewContext(expression, context);
    await runInNewContext(expression, context);
    expect(fetch).not.toHaveBeenCalled();
    expect(topic.subscribe).toHaveBeenCalledExactlyOnceWith({ includeAllHistory: true });
    onMessage({ type: "conversation-turn-stream", payload: { type: "done" } });
    expect(topic.unsubscribe).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(context.__omnicodexNativeTurnSubscriptions.topics.size).toBe(0);
  });

  it("takes topics from stream handoffs only and preserves authoritative turn completion", () => {
    const notification = {
      type: "conversation-update" as const,
      payload: {
        update_type: "stream-handoff",
        update_content: {
          options: [
            { type: "subscribe_ws_topic", topic_id: topicId },
            { type: "subscribe_ws_topic", topic_id: topicId },
            { type: "subscribe_ws_topic", topic_id: "conversations" },
          ],
        },
      },
    };
    expect(oracleNativeTurnTopics(notification)).toEqual([topicId]);
    expect(
      oracleNativeTurnTopics({
        ...notification,
        payload: { update_type: "add-messages", messages: [notification] },
      }),
    ).toEqual([]);
    const observed = vi.fn();
    const id = "00000000-0000-4000-8000-000000000002";
    oracleConversationUrlsFromCdpEvent(
      JSON.stringify({
        method: "Network.webSocketFrameReceived",
        params: {
          response: {
            opcode: 1,
            payloadData: JSON.stringify({
              type: "message",
              payload: {
                type: "conversation-turn-stream",
                payload: { type: "done", conversation_id: id, turn_id: "native-turn" },
              },
            }),
          },
        },
      }),
      observed,
    );
    expect(observed).toHaveBeenCalledExactlyOnceWith(`https://chatgpt.com/c/${id}`, {
      type: "conversation-turn-complete",
      payload: { conversation_id: id, turn_id: "native-turn" },
    });
  });

  it("subscribes automatically on a native handoff without a conversation lookup or second client", async () => {
    let handoff: (event: unknown) => void = () => {};
    const stopHandoff = vi.fn();
    const turn = {
      state: 2,
      offset: "1",
      topicId,
      onMessage: vi.fn(() => vi.fn()),
      onSubscribe: vi.fn(() => vi.fn()),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(),
    };
    const conversations = {
      state: 0,
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(),
      onMessage: vi.fn((callback) => {
        handoff = callback;
        return stopHandoff;
      }),
    };
    const client = {
      isTransportOpen: true,
      ws: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
      getTopic: vi.fn((id) => (id === "conversations" ? conversations : turn)),
    };
    const context = {
      __omnicodexNativeTurnSubscriptions: { client, topics: new Map() },
      fetch: vi.fn(),
      console: { error: vi.fn() },
    };
    await runInNewContext(oracleNativeTurnSubscriptionExpression(), context);
    await runInNewContext(oracleNativeTurnSubscriptionExpression(), context);
    expect(conversations.onMessage).toHaveBeenCalledOnce();
    expect(client.ws.addEventListener).toHaveBeenCalledTimes(2);
    expect(client.ws.addEventListener).toHaveBeenCalledWith("close", expect.any(Function));
    const event = {
      type: "conversation-update",
      payload: {
        update_type: "stream-handoff",
        update_content: {
          options: [
            { type: "subscribe_ws_topic", topic_id: topicId },
            { type: "subscribe_ws_topic", topic_id: "conversations" },
          ],
        },
      },
    };
    handoff(event);
    handoff(event);
    await Promise.resolve();
    expect(turn.subscribe).toHaveBeenCalledExactlyOnceWith({ includeAllHistory: true });
    expect(context.fetch).not.toHaveBeenCalled();
    await runInNewContext(oracleNativeTurnSubscriptionExpression(null), context);
    expect(stopHandoff).toHaveBeenCalledOnce();
    expect(conversations.unsubscribe).not.toHaveBeenCalled();
    expect(turn.unsubscribe).toHaveBeenCalledOnce();
    expect(client.ws.removeEventListener).toHaveBeenCalledTimes(2);
  });

  it("accepts the native unbatched early handoff on the existing socket only", async () => {
    const turn = {
      state: 2,
      offset: "1",
      topicId,
      onMessage: vi.fn(() => vi.fn()),
      onSubscribe: vi.fn(() => vi.fn()),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(),
    };
    const ws = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const client = {
      isTransportOpen: true,
      ws,
      getTopic: vi.fn((id) =>
        id === "conversations"
          ? { state: 0, subscribe: vi.fn(async () => {}), onMessage: vi.fn(() => vi.fn()) }
          : turn,
      ),
    };
    const context = { __omnicodexNativeTurnSubscriptions: { client, topics: new Map() } };
    await runInNewContext(oracleNativeTurnSubscriptionExpression(), context);
    const receive = ws.addEventListener.mock.calls[0]?.[1];
    const payload = {
      conversation_id: "00000000-0000-4000-8000-000000000002",
      turn_exchange_id: topicId.slice("conversation-turn-".length),
      topic_id: topicId,
    };
    receive({
      data: JSON.stringify({
        type: "conversation-turn-handoff-control",
        payload: { ...payload, topic_id: "conversations" },
      }),
    });
    expect(turn.subscribe).not.toHaveBeenCalled();
    receive({ data: JSON.stringify({ type: "conversation-turn-handoff-control", payload }) });
    await Promise.resolve();
    expect(turn.subscribe).toHaveBeenCalledExactlyOnceWith({ includeAllHistory: true });
    await runInNewContext(oracleNativeTurnSubscriptionExpression(null), context);
    expect(ws.removeEventListener).toHaveBeenCalledWith("message", receive);
    expect(ws.removeEventListener).toHaveBeenCalledWith("close", expect.any(Function));
    expect(ws.removeEventListener).toHaveBeenCalledTimes(2);
  });
});

const FROZEN_HOME_DIAGNOSTIC =
  '(async function oracleRecoverNativeHome(reload) {\n  if (location.origin !== "https://chatgpt.com" || location.pathname !== "/" ||\n      document.visibilityState !== "hidden") return { state: "ineligible" };\n  const composer = document.querySelector(\'#prompt-textarea\');\n  if ((composer?.value ?? composer?.textContent ?? "").trim() ||\n      document.querySelector(\'[data-testid="stop-button"]\')) return { state: "ineligible" };\n  const state = globalThis.__omnicodexNativeTurnSubscriptions;\n  const client = state?.recoveryClient ?? state?.client;\n  const socket = client?.ws;\n  const maximum = socket?._options?.maxRetries;\n  if (client?.isTransportOpen !== false || socket?.readyState !== 3 ||\n      !Number.isFinite(maximum) || maximum < 1 || socket.retryCount < maximum ||\n      socket._connectLock !== true) return { state: "ineligible" };\n  if (!reload) return { state: "eligible" };\n  location.reload();\n  return { state: "reloading" };\n})(false)';
const FROZEN_HOME_RELOAD =
  '(async function oracleRecoverNativeHome(reload) {\n  if (location.origin !== "https://chatgpt.com" || location.pathname !== "/" ||\n      document.visibilityState !== "hidden") return { state: "ineligible" };\n  const composer = document.querySelector(\'#prompt-textarea\');\n  if ((composer?.value ?? composer?.textContent ?? "").trim() ||\n      document.querySelector(\'[data-testid="stop-button"]\')) return { state: "ineligible" };\n  const state = globalThis.__omnicodexNativeTurnSubscriptions;\n  const client = state?.recoveryClient ?? state?.client;\n  const socket = client?.ws;\n  const maximum = socket?._options?.maxRetries;\n  if (client?.isTransportOpen !== false || socket?.readyState !== 3 ||\n      !Number.isFinite(maximum) || maximum < 1 || socket.retryCount < maximum ||\n      socket._connectLock !== true) return { state: "ineligible" };\n  if (!reload) return { state: "eligible" };\n  location.reload();\n  return { state: "reloading" };\n})(true)';

describe("fixed home recovery primitive diagnostics", () => {
  function context(values: Record<string, unknown> = {}) {
    const value = (name: string, fallback: unknown) =>
      Object.hasOwn(values, name) ? values[name] : fallback;
    const reload = vi.fn();
    const client = {
      isTransportOpen: value("transport", false),
      init: vi.fn(),
      connect: vi.fn(),
      sendCommand: vi.fn(),
      ws: {
        readyState: value("readyState", 3),
        retryCount: value("retries", 5),
        _options: { maxRetries: value("maximum", 5) },
        _connectLock: value("locked", true),
      },
    };
    const realm = {
      location: {
        origin: value("origin", "https://chatgpt.com"),
        pathname: value("pathname", "/"),
        reload,
      },
      document: {
        visibilityState: value("visibility", "hidden"),
        querySelector: vi.fn((_selector: string): unknown => null),
      },
      __omnicodexNativeTurnSubscriptions: { recoveryClient: client },
      fetch: vi.fn(),
    };
    return { realm, client, reload };
  }

  it("keeps the real reload expression byte-for-byte identical to the running baseline", () => {
    expect(oracleNativeHomeRecoveryExpression(true)).toBe(FROZEN_HOME_RELOAD);
  });

  it("returns only booleans and finite numbers alongside the original eligible result", async () => {
    const f = context();
    const result = await runInNewContext(oracleNativeHomeRecoveryExpression(false), f.realm);
    expect(result).toEqual({
      state: "eligible",
      diagnostics: {
        observed: true,
        hidden: true,
        clientPresent: true,
        transportOpenKnown: true,
        transportOpen: false,
        socketPresent: true,
        socketReadyStateKnown: true,
        socketReadyState: 3,
        maxRetriesKnown: true,
        maxRetries: 5,
        retryCountKnown: true,
        retryCount: 5,
        connectLocked: true,
      },
    });
    expect(
      Object.values(result.diagnostics).every(
        (v) => typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)),
      ),
    ).toBe(true);
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.client.init).not.toHaveBeenCalled();
    expect(f.client.connect).not.toHaveBeenCalled();
    expect(f.client.sendCommand).not.toHaveBeenCalled();
    expect(f.realm.fetch).not.toHaveBeenCalled();
  });

  it("preserves all eligibility decisions across 288 existing guard condition combinations", async () => {
    let checked = 0;
    for (const visibility of ["hidden", "visible"])
      for (const transport of [false, true, undefined])
        for (const readyState of [0, 3])
          for (const maximum of [1, 5, NaN, undefined])
            for (const retries of [0, 5, undefined])
              for (const locked of [false, true]) {
                const values = { visibility, transport, readyState, maximum, retries, locked };
                const baseline = context(values),
                  proposed = context(values);
                const expected = await runInNewContext(FROZEN_HOME_DIAGNOSTIC, baseline.realm);
                const observed = await runInNewContext(
                  oracleNativeHomeRecoveryExpression(false),
                  proposed.realm,
                );
                expect(observed.state).toBe(expected.state);
                expect(proposed.reload).not.toHaveBeenCalled();
                checked++;
              }
    expect(checked).toBe(288);
  });

  it("distinguishes missing or non-finite counters from a genuine zero without changing the guard", async () => {
    const f = context({ maximum: Infinity, retries: NaN, readyState: undefined });
    const result = await runInNewContext(oracleNativeHomeRecoveryExpression(false), f.realm);
    expect(result).toMatchObject({
      state: "ineligible",
      diagnostics: {
        observed: true,
        socketReadyStateKnown: false,
        socketReadyState: 0,
        maxRetriesKnown: false,
        maxRetries: 0,
        retryCountKnown: false,
        retryCount: 0,
      },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("does not expose or access credentials, message content or native methods", async () => {
    const f = context();
    const sensitive = vi.fn(() => {
      throw new Error("sensitive access forbidden");
    });
    Object.defineProperty(f.client, "credentials", { get: sensitive });
    Object.defineProperty(f.client.ws, "url", { get: sensitive });
    Object.defineProperty(f.realm, "localStorage", { get: sensitive });
    f.realm.document.querySelector.mockImplementation((selector: string) =>
      selector === "#prompt-textarea" ? { value: "synthetic-private-draft" } : null,
    );
    const result = await runInNewContext(oracleNativeHomeRecoveryExpression(false), f.realm);
    expect(result.state).toBe("ineligible");
    expect(JSON.stringify(result)).not.toContain("synthetic-private-draft");
    expect(sensitive).not.toHaveBeenCalled();
    expect(f.realm.fetch).not.toHaveBeenCalled();
    expect(f.client.sendCommand).not.toHaveBeenCalled();
    expect(f.client.init).not.toHaveBeenCalled();
    expect(f.client.connect).not.toHaveBeenCalled();
    expect(f.reload).not.toHaveBeenCalled();
  });

  it("keeps the original verdict when additional observation throws", async () => {
    const f = context({ transport: true });
    Object.defineProperty(f.client.ws, "_connectLock", {
      get: () => {
        throw new Error("diagnostic getter failed");
      },
    });
    const result = await runInNewContext(oracleNativeHomeRecoveryExpression(false), f.realm);
    expect(result).toEqual({ state: "ineligible", diagnostics: { observed: false } });
    expect(f.reload).not.toHaveBeenCalled();
  });

  it("keeps page, draft and stop-button guards, plus the exact fixed-expression admission", async () => {
    for (const values of [{ origin: "https://synthetic.example" }, { pathname: "/c/synthetic" }]) {
      const f = context(values);
      expect(
        (await runInNewContext(oracleNativeHomeRecoveryExpression(false), f.realm)).state,
      ).toBe("ineligible");
    }
    const f = context();
    f.realm.document.querySelector.mockReturnValue({} as never);
    expect((await runInNewContext(oracleNativeHomeRecoveryExpression(false), f.realm)).state).toBe(
      "ineligible",
    );
    const expression = oracleNativeHomeRecoveryExpression(false);
    expect(isOracleNativeTurnSubscriptionExpression(expression)).toBe(true);
    expect(isOracleNativeTurnSubscriptionExpression(FROZEN_HOME_RELOAD)).toBe(true);
    expect(isOracleNativeTurnSubscriptionExpression(`${expression}; fetch('/synthetic')`)).toBe(
      false,
    );
    expect(
      isOracleNativeTurnSubscriptionExpression(
        expression.replace("observed: true", "observed: false"),
      ),
    ).toBe(false);
  });
});
