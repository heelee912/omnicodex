import { afterEach, expect, it, vi } from "vitest";
import {
  DesktopChatApiClient,
  desktopChatPrincipal,
  inspectDesktopChatEventConnection,
} from "../src/infrastructure/chatgpt/desktop-chat-api-client.js";

const token = (accountId: string, userId: string) =>
  `header.${Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId, user_id: userId },
    }),
  ).toString("base64url")}.test-signature`;

afterEach(() => vi.unstubAllGlobals());

it("reads current principal metadata without an HTTP request or exposing authentication material", async () => {
  const secret = token("first", "user-one");
  const request = vi
    .fn()
    .mockResolvedValueOnce({ authMethod: "chatgpt", authToken: secret })
    .mockResolvedValueOnce({ authMethod: "chatgpt", authToken: token("second", "user-two") });
  const fetchRequest = vi.fn<typeof fetch>();
  const client = new DesktopChatApiClient(request, fetchRequest);
  const signal = new AbortController().signal;
  const first = await client.readPrincipal(signal);
  expect(first).toEqual({ accountId: "first", userId: "user-one" });
  expect(JSON.stringify(first)).not.toContain(secret);
  expect(await client.readPrincipal(signal)).toEqual({ accountId: "second", userId: "user-two" });
  expect(fetchRequest).not.toHaveBeenCalled();
});

it("does not return a principal when its caller is cancelled during the native read", async () => {
  const abort = new AbortController();
  const client = new DesktopChatApiClient(async () => {
    abort.abort(new Error("cancelled"));
    return { authMethod: "chatgpt", authToken: token("account", "user") };
  });
  await expect(client.readPrincipal(abort.signal)).rejects.toThrow("cancelled");
});

it("uses the current native account for each connection instead of caching another account", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ authMethod: "chatgpt", authToken: token("first", "user-one") })
    .mockResolvedValueOnce({
      authMethod: "chatgptAuthTokens",
      authToken: token("second", "user-two"),
    });
  const fetchRequest = vi.fn<typeof fetch>(async () =>
    Response.json({ websocket_url: "wss://ws.chatgpt.com/ws/test" }),
  );
  const client = new DesktopChatApiClient(request, fetchRequest);
  const signal = new AbortController().signal;
  expect((await client.userEventEndpoint(signal)).principal.accountId).toBe("first");
  expect((await client.userEventEndpoint(signal)).principal.accountId).toBe("second");
  expect(request.mock.calls).toEqual([
    ["getAuthStatus", { includeToken: true, refreshToken: false }],
    ["getAuthStatus", { includeToken: true, refreshToken: false }],
  ]);
  expect(fetchRequest.mock.calls[1]?.[1]).toMatchObject({
    headers: { "ChatGPT-Account-ID": "second" },
    redirect: "error",
    signal,
  });
});

it("does not send an API-key login or unknown principal to the Chat endpoint", async () => {
  const fetchRequest = vi.fn<typeof fetch>();
  const client = new DesktopChatApiClient(
    async () => ({ authMethod: "apikey", authToken: "private" }),
    fetchRequest,
  );
  await expect(client.userEventEndpoint(new AbortController().signal)).rejects.toThrow(
    "DESKTOP_CHAT_AUTH_UNAVAILABLE",
  );
  expect(fetchRequest).not.toHaveBeenCalled();
  expect(() => desktopChatPrincipal("private")).toThrow("DESKTOP_CHAT_AUTH_PRINCIPAL_INVALID");
});

it("reports the actual HTTP error without copying credentials or response content", async () => {
  const client = new DesktopChatApiClient(
    async () => ({ authMethod: "chatgpt", authToken: token("account", "user") }),
    vi.fn<typeof fetch>(async () => new Response("sensitive response", { status: 403 })),
  );
  await expect(client.userEventEndpoint(new AbortController().signal)).rejects.toThrow(
    "DESKTOP_CHAT_EVENT_ENDPOINT_HTTP_403",
  );
});

it("requires the two real subscription acknowledgements and returns no socket URL or token", async () => {
  const sent: unknown[] = [];
  const close = vi.fn();
  class Socket extends EventTarget {
    constructor(_url: string) {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(value: string) {
      sent.push(JSON.parse(value));
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify([
              { id: 2, reply: { type: "subscribe", topic_id: "conversations", recovered: false } },
              {
                id: 3,
                reply: { type: "subscribe", topic_id: "alder-conversations", recovered: false },
              },
            ]),
          }),
        ),
      );
    }
    close() {
      close();
      this.dispatchEvent(new Event("close"));
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const secret = token("account", "user");
  const client = new DesktopChatApiClient(
    async () => ({ authMethod: "chatgpt", authToken: secret }),
    vi.fn<typeof fetch>(async () =>
      Response.json({ websocket_url: "wss://ws.chatgpt.com/ws/test?token=private" }),
    ),
  );
  const result = await inspectDesktopChatEventConnection(client, new AbortController().signal);
  expect(result.subscribedTopics).toEqual(["conversations", "alder-conversations"]);
  expect(result.accountScopeSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(JSON.stringify(result)).not.toMatch(/private|account"|user"|websocketUrl/);
  expect(sent).toEqual([
    [
      { id: 1, command: { type: "connect", presence: { type: "presence", state: "background" } } },
      { id: 2, command: { type: "subscribe", topic_id: "conversations" } },
      { id: 3, command: { type: "subscribe", topic_id: "alder-conversations" } },
    ],
  ]);
  expect(close).toHaveBeenCalledOnce();
});
