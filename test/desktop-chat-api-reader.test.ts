import { describe, expect, it, vi } from "vitest";
import { chatAccountRateLimitRetryAt } from "../src/application/chat-account-request-coordinator.js";
import {
  DESKTOP_EXACT_CONVERSATION_READER,
  readDesktopChatConversation,
} from "../src/infrastructure/windows/desktop-chat-api-reader.js";

const conversationUrl = "https://chatgpt.com/c/6aa0402d-d934-83ee-bc94-42b9da04cde3";
const querySource =
  "var CurrentClient,CurrentAtom,CurrentInit=x((()=>{CurrentAtom=om(Q,(e,{scope:t})=>({enabled:e!=null,queryFn:async({signal:n})=>{if(e==null)return null;let r=await timeout(n,t=>CurrentClient.safeGet(`/conversation/{conversation_id}`,{parameters:{path:{conversation_id:e}},signal:t}));return register(t,r),r},queryKey:[`chatgpt-conversation`,e],retry:!1}))}));export{CurrentClient as Api,CurrentInit as Setup}";

function renderer(get: (id: string, signal: AbortSignal) => Promise<unknown>) {
  const root = {};
  const fetch = vi.fn(async () => ({ ok: true, text: async () => querySource }));
  const initialize = vi.fn();
  const safeGet = vi.fn(
    (
      _route: string,
      input: {
        parameters: {
          path: { conversation_id: string };
          query: { include_has_versions: boolean; num_turns: number };
        };
        signal: AbortSignal;
      },
    ) => get(input.parameters.path.conversation_id, input.signal),
  );
  const importer = vi.fn(async () => ({
    Setup: initialize,
    Api: { safeGet },
  }));
  const evaluate = async (expression: string) => {
    const evaluateExpression = new Function(
      "globalThis",
      "document",
      "performance",
      "location",
      "fetch",
      "importer",
      `return (${expression.replaceAll("import(url.href)", "importer(url.href)")});`,
    );
    return evaluateExpression(
      root,
      { querySelectorAll: () => [{ src: "app://-/assets/current-other-hash.js" }] },
      { getEntriesByType: () => [] },
      { href: "app://-/index.html", host: "-" },
      fetch,
      importer,
    );
  };
  return { evaluate, fetch, importer, initialize, safeGet };
}

describe("Desktop exact conversation reader", () => {
  it.each(["response", "headers"])(
    "preserves native Retry-After from %s through renderer serialization",
    async (location) => {
      const error = Object.assign(
        new Error('{"detail":"Too many requests"}'),
        location === "response"
          ? {
              response: {
                status: 429,
                headers: new Headers({ "retry-after": "120", "x-private": "not-forwarded" }),
              },
            }
          : { status: 429, headers: { "Retry-After": "120", "x-private": "not-forwarded" } },
      );
      const get = vi.fn(async () => {
        throw error;
      });
      const runtime = renderer(get);
      const evaluate = async (expression: string) =>
        JSON.parse(JSON.stringify(await runtime.evaluate(expression)));
      const result = await readDesktopChatConversation(
        { conversationUrl, evaluate },
        new AbortController().signal,
      ).catch((value) => value);
      expect(result).toBeInstanceOf(Error);
      const nativeError = result as Error & {
        headers: Record<string, string>;
        response?: { status: number };
      };
      expect(nativeError.message).toBe(error.message);
      expect(nativeError.headers).toEqual({ "retry-after": "120" });
      if (location === "response") expect(nativeError.response).toEqual({ status: 429 });
      expect(chatAccountRateLimitRetryAt(result, 1_000_000)).toBe(1_120_000);
      expect(get).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves the native absolute retry deadline through renderer serialization", async () => {
    const runtime = renderer(async () => {
      throw Object.assign(new Error('{"detail":"Too many requests"}'), {
        status: 429,
        retryAtUnixMs: 1_120_000,
      });
    });
    const evaluate = async (expression: string) =>
      JSON.parse(JSON.stringify(await runtime.evaluate(expression)));
    const result = await readDesktopChatConversation(
      { conversationUrl, evaluate },
      new AbortController().signal,
    ).catch((value) => value);
    expect(result).toMatchObject({
      message: '{"detail":"Too many requests"}',
      status: 429,
      retryAtUnixMs: 1_120_000,
    });
    expect(chatAccountRateLimitRetryAt(result, 1_000_000)).toBe(1_120_000);
  });

  it("requests only the current native turn and preserves its mapping", async () => {
    const raw = {
      current_node: "tool",
      mapping: {
        tool: {
          parent: "prior",
          message: {
            id: "tool",
            metadata: {
              invoked_resource: { resource_uri: "/connector/link_a/omnicodex__goal_create" },
            },
            content: { text: '{"id":"goal","revision":2}' },
            extra: "preserved",
          },
        },
      },
    };
    const get = vi.fn(async (_id: string, _signal: AbortSignal) => raw);
    const runtime = renderer(get);
    const result = await readDesktopChatConversation(
      { conversationUrl, evaluate: runtime.evaluate },
      new AbortController().signal,
    );
    expect(result).toBe(raw);
    expect(get.mock.calls[0]?.[0]).toBe(conversationUrl.split("/").at(-1));
    expect(runtime.safeGet).toHaveBeenCalledWith(
      "/conversation/{conversation_id}",
      expect.objectContaining({
        parameters: {
          path: { conversation_id: conversationUrl.split("/").at(-1) },
          query: { include_has_versions: true, num_turns: 1 },
        },
      }),
    );
    expect(runtime.initialize).toHaveBeenCalledTimes(1);
  });

  it("discovers the current native ChatGPT query client by route and query-key contract", async () => {
    const get = vi.fn(async () => ({ current_node: "current", mapping: {} }));
    const runtime = renderer(get);
    await expect(
      readDesktopChatConversation(
        { conversationUrl, evaluate: runtime.evaluate },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ current_node: "current", mapping: {} });
    expect(get).toHaveBeenCalledWith(conversationUrl.split("/").at(-1), expect.any(AbortSignal));
    expect(runtime.initialize).toHaveBeenCalledTimes(1);
    expect(runtime.fetch).toHaveBeenCalledTimes(1);
    expect(runtime.importer).toHaveBeenCalledTimes(1);
  });

  it("reuses the discovered service but never caches conversation responses", async () => {
    const get = vi.fn(async () => ({ revision: get.mock.calls.length }));
    const runtime = renderer(get);
    const input = { conversationUrl, evaluate: runtime.evaluate };
    expect(await readDesktopChatConversation(input, new AbortController().signal)).toEqual({
      revision: 1,
    });
    expect(await readDesktopChatConversation(input, new AbortController().signal)).toEqual({
      revision: 2,
    });
    expect(runtime.fetch).toHaveBeenCalledTimes(1);
    expect(runtime.importer).toHaveBeenCalledTimes(1);
  });

  it("returns native error and retry fields without retrying the HTTP operation", async () => {
    const get = vi.fn(async () => {
      throw Object.assign(new Error("Too many requests"), {
        status: 429,
        retryAtMs: 12345,
        errorCode: "rate_limit",
        responseStatus: 429,
      });
    });
    const runtime = renderer(get);
    await expect(
      readDesktopChatConversation(
        { conversationUrl, evaluate: runtime.evaluate },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      message: "Too many requests",
      status: 429,
      retryAtMs: 12345,
      errorCode: "rate_limit",
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("preserves structured terminal conversation error fields", async () => {
    const details = {
      code: "conversation_deleted",
      can_retry: false,
      conversation_id: conversationUrl.split("/").at(-1),
      detail: { original: "deleted" },
    };
    const runtime = renderer(async () => {
      throw Object.assign(new Error("native deleted"), details);
    });
    await expect(
      readDesktopChatConversation(
        { conversationUrl, evaluate: runtime.evaluate },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ message: "native deleted", ...details });
  });

  it("propagates cancellation to the existing native service signal", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let nativeSignal: AbortSignal | undefined;
    const runtime = renderer(async (_id, signal) => {
      nativeSignal = signal;
      started();
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    });
    const controller = new AbortController();
    const running = readDesktopChatConversation(
      { conversationUrl, evaluate: runtime.evaluate },
      controller.signal,
    );
    await ready;
    controller.abort(new Error("caller cancelled"));
    await expect(running).rejects.toThrow("caller cancelled");
    expect(nativeSignal?.aborted).toBe(true);
  });

  it("does not evaluate invalid targets or already-cancelled requests", async () => {
    const evaluate = vi.fn();
    await expect(
      readDesktopChatConversation(
        { conversationUrl: "https://example.com", evaluate },
        new AbortController().signal,
      ),
    ).rejects.toThrow("DESKTOP_CHAT_CONVERSATION_INVALID");
    const controller = new AbortController();
    controller.abort();
    await expect(
      readDesktopChatConversation({ conversationUrl, evaluate }, controller.signal),
    ).rejects.toThrow();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("contains no fixed installed asset or export alias", () => {
    expect(DESKTOP_EXACT_CONVERSATION_READER).not.toContain("f87238153a19");
    expect(DESKTOP_EXACT_CONVERSATION_READER).not.toContain("Qvt");
    expect(DESKTOP_EXACT_CONVERSATION_READER).not.toContain("backend-api");
  });
});
