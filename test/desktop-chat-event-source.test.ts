import { describe, expect, it, vi } from "vitest";
import type { CdpWebSocketLike } from "../src/infrastructure/chatgpt/chatgpt-cdp-transport.js";
import { oracleConversationUrlsFromCdpEvent } from "../src/infrastructure/chatgpt/oracle-conversation-event-source.js";
import { DesktopChatEventSource } from "../src/infrastructure/windows/desktop-chat-event-source.js";

class Socket implements CdpWebSocketLike {
  readyState = 1;
  listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  sent: unknown[] = [];
  close = vi.fn(() => {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  });
  constructor(readonly acknowledge = true) {}
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    if (type === "open") queueMicrotask(() => listener({}));
  }
  emit(type: string, data?: string) {
    for (const listener of this.listeners.get(type) ?? [])
      listener(data === undefined ? {} : { data });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
    if (this.acknowledge) queueMicrotask(() => this.emit("message", '{"id":1,"result":{}}'));
  }
}

const identity = {
  endpoint: "http://127.0.0.1:29341",
  processId: 9904,
  startedAtIso: "2026-09-06T19:06:08.924Z",
};
const target = (id: string) => ({
  id,
  type: "page",
  url: "app://-/index.html",
  webSocketDebuggerUrl: `ws://127.0.0.1:29341/devtools/page/${id}`,
});
const id = "6a9d8c74-a448-83e8-843e-41e6ac46f1bf";
const notification = {
  type: "conversation-turn-complete",
  payload: { conversation_id: id },
};
const frame = JSON.stringify({
  method: "Network.webSocketFrameReceived",
  params: {
    response: { opcode: 1, payloadData: JSON.stringify(notification) },
  },
});

function setup(targets: unknown[] = [target("main"), target("secondary")], acknowledge = true) {
  const sockets: Socket[] = [];
  const discover = vi.fn(async () => identity);
  const fetchRequest = vi.fn(async () => new Response(JSON.stringify(targets)));
  const source = new DesktopChatEventSource({
    discover,
    fetch: fetchRequest,
    factory: () => {
      const socket = new Socket(acknowledge);
      sockets.push(socket);
      return socket;
    },
  });
  return { source, sockets, discover, fetchRequest };
}

describe("desktop passive Chat events", () => {
  it("preserves only request identity before the ordinary progress filter without extra requests", async () => {
    const { source, sockets, fetchRequest } = setup([target("main")]);
    const onEvent = vi.fn();
    await source.ensureConnected(onEvent, new AbortController().signal);
    const progress = JSON.stringify({
      method: "Network.webSocketFrameReceived",
      params: {
        response: {
          opcode: 1,
          payloadData: JSON.stringify({
            type: "conversation-update",
            payload: {
              conversation_id: id,
              update_type: "add-messages",
              update_content: {
                messages: [
                  {
                    id: "not-forwarded-message",
                    status: "in_progress",
                    author: { role: "assistant" },
                    content: { text: "private body must not be forwarded" },
                    metadata: {
                      message_type: "next",
                      request_id: "native-request-exact",
                      another_private_field: "not-forwarded",
                    },
                  },
                ],
              },
            },
          }),
        },
      },
    });
    const regularObserver = vi.fn();
    expect(oracleConversationUrlsFromCdpEvent(progress, regularObserver)).toEqual([]);
    expect(regularObserver).not.toHaveBeenCalled();
    sockets[0]?.emit("message", progress);
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({
      source: identity,
      targetId: "main",
      conversationUrl: `https://chatgpt.com/c/${id}`,
      notification: {
        type: "conversation-update",
        payload: {
          conversation_id: id,
          update_type: "request-identity",
          update_content: { messages: [{ metadata: { request_id: "native-request-exact" } }] },
        },
      },
    });
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain("private body");
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain("not-forwarded");
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    expect(sockets[0]?.sent).toEqual([{ id: 1, method: "Network.enable", params: {} }]);
    await source.stop();
  });
  it("attaches the app roots once, preserves identities and never evaluates or sends a Chat request", async () => {
    const { source, sockets, discover, fetchRequest } = setup([
      target("main"),
      target("secondary"),
      { ...target("embedded"), url: "https://chatgpt.com/" },
    ]);
    const onEvent = vi.fn();
    const signal = new AbortController().signal;
    expect(await source.ensureConnected(onEvent, signal)).toBe(true);
    expect(await source.ensureConnected(onEvent, signal)).toBe(false);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    for (const socket of sockets)
      expect(socket.sent).toEqual([{ id: 1, method: "Network.enable", params: {} }]);
    sockets[0]?.emit("message", frame);
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({
      source: identity,
      targetId: "main",
      conversationUrl: `https://chatgpt.com/c/${id}`,
      notification,
    });
    expect(source.status).toMatchObject({
      transport: "desktop_cdp",
      attachedTargetCount: 2,
      accountScopeVerified: false,
    });
    await source.stop();
    sockets[0]?.emit("message", frame);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(sockets.every((socket) => socket.close.mock.calls.length === 1)).toBe(true);
  });

  it("rediscovers after a target closes and discards events from the old generation", async () => {
    const { source, sockets, discover } = setup();
    const signal = new AbortController().signal;
    const onEvent = vi.fn();
    await source.ensureConnected(onEvent, signal);
    sockets[0]?.close();
    expect(source.status).toBeUndefined();
    expect(sockets[1]?.readyState).toBe(3);
    await source.ensureConnected(onEvent, signal);
    expect(discover).toHaveBeenCalledTimes(4);
    sockets[0]?.emit("message", frame);
    sockets[2]?.emit("message", frame);
    expect(onEvent).toHaveBeenCalledTimes(1);
    await source.stop();
  });

  it("rejects a substituted target endpoint and closes the already attached target", async () => {
    const { source, sockets } = setup([
      target("main"),
      {
        ...target("other"),
        webSocketDebuggerUrl: "ws://127.0.0.1:4444/devtools/page/other",
      },
    ]);
    await expect(source.ensureConnected(vi.fn(), new AbortController().signal)).rejects.toThrow(
      "TARGET_ORIGIN_INVALID",
    );
    expect(sockets[0]?.close).toHaveBeenCalledOnce();
    expect(source.status).toBeUndefined();
  });

  it("holds incoming events until the process generation is revalidated", async () => {
    const { source, discover, sockets } = setup([target("main")]);
    let validate!: (value: typeof identity) => void;
    discover.mockResolvedValueOnce(identity).mockImplementationOnce(
      () =>
        new Promise((resolveIdentity) => {
          validate = resolveIdentity;
        }),
    );
    const onEvent = vi.fn();
    const connecting = source.ensureConnected(onEvent, new AbortController().signal);
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    sockets[0]?.emit("message", frame);
    expect(onEvent).not.toHaveBeenCalled();
    validate(identity);
    await connecting;
    expect(onEvent).toHaveBeenCalledOnce();
    await source.stop();
  });

  it("rejects an app replacement during attachment without publishing observations", async () => {
    const { source, discover, sockets } = setup([target("main")]);
    discover.mockResolvedValueOnce(identity).mockImplementationOnce(async () => {
      sockets[0]?.emit("message", frame);
      return { ...identity, startedAtIso: "2026-09-07T00:00:00Z" };
    });
    const onEvent = vi.fn();
    await expect(source.ensureConnected(onEvent, new AbortController().signal)).rejects.toThrow(
      "PROCESS_CHANGED_DURING_CONNECT",
    );
    expect(onEvent).not.toHaveBeenCalled();
    expect(source.status).toBeUndefined();
    expect(sockets[0]?.close).toHaveBeenCalledOnce();
  });

  it("stops a pending connection without leaving its socket or a future observation alive", async () => {
    const { source, sockets } = setup([target("main")], false);
    const connecting = source.ensureConnected(vi.fn(), new AbortController().signal);
    const result = expect(connecting).rejects.toThrow("CONNECT_ABORTED");
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await source.stop();
    await result;
    expect(sockets[0]?.close).toHaveBeenCalledOnce();
    await expect(source.ensureConnected(vi.fn(), new AbortController().signal)).rejects.toThrow(
      "EVENTS_STOPPED",
    );
  });

  it("does not report readiness when the native Network command is rejected", async () => {
    const { source, sockets } = setup([target("main")], false);
    const connecting = source.ensureConnected(vi.fn(), new AbortController().signal);
    const result = expect(connecting).rejects.toThrow("NETWORK_ENABLE_FAILED");
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.emit("message", '{"id":1,"error":{"code":-32601}}');
    await result;
    expect(source.status).toBeUndefined();
    expect(sockets[0]?.close).toHaveBeenCalledOnce();
  });
});
