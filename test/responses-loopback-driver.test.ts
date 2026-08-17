import { describe, expect, it } from "vitest";
import { ResponsesLoopbackDriver } from "../src/infrastructure/runtime/responses-loopback-driver.js";

interface FetchCall {
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
  readonly method: string | undefined;
  readonly redirect: "error" | "follow" | "manual" | undefined;
  readonly signal: AbortSignal | null | undefined;
}

describe("ResponsesLoopbackDriver", () => {
  it("uses a process-specific secret and emits every selected tool form without inference", async () => {
    const driver = new ResponsesLoopbackDriver();
    const otherDriver = new ResponsesLoopbackDriver();
    expect(driver.apiKey).not.toBe(otherDriver.apiKey);
    expect(driver.apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      () =>
        new ResponsesLoopbackDriver({
          binding: { host: "0.0.0.0", listen: async () => 1 } as never,
        }),
    ).toThrow("must bind to 127.0.0.1");

    await driver.start();
    try {
      const unauthorized = await fetch(`${driver.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(unauthorized.status).toBe(401);
      await expect(errorCode(unauthorized)).resolves.toBe("LOOPBACK_UNAUTHORIZED");

      const functionStream = await selectAndRead(driver, {
        kind: "function",
        name: "shell_command",
        arguments: {},
      });
      expect(functionStream).toContain("event: response.function_call_arguments.delta");
      expect(functionStream).toContain('"delta":"{}"');
      expect(functionStream).toContain("event: response.function_call_arguments.done");
      expect(functionStream).toContain('"arguments":"{}"');

      const customStream = await selectAndRead(driver, {
        kind: "custom",
        name: "exec",
        arguments: 'text("ok")',
      });
      expect(customStream).toContain("event: response.custom_tool_call_input.delta");
      expect(customStream).toContain('"delta":"text(\\"ok\\")"');

      const freeformStream = await selectAndRead(driver, {
        kind: "freeform",
        name: "apply_patch",
        arguments: 'line 1\n{"not":"parsed"}\n한글',
      });
      expect(freeformStream).toContain("response.custom_tool_call_input.done");
      expect(freeformStream).toContain("한글");

      const searchStream = await selectAndRead(driver, {
        kind: "tool_search",
        name: "tool_search",
        arguments: { query: "calendar", limit: 20 },
      });
      expect(searchStream).toContain('"type":"tool_search_call"');
      expect(searchStream).toContain('"execution":"client"');

      const namespaceStream = await selectAndRead(driver, {
        kind: "function",
        namespace: "web",
        name: "run",
        arguments: { search_query: [{ q: "native web" }] },
      });
      expect(namespaceStream).toContain('"namespace":"web"');
      expect(namespaceStream).toContain('"name":"run"');

      const unknownStream = await selectAndRead(driver, {
        kind: "unknown",
        name: "future_native",
        arguments: null,
      });
      expect(unknownStream).toContain('"arguments":"null"');
    } finally {
      await driver.stop();
    }
  });

  it("relays only the three fixed native endpoints with minimal headers", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(fetchCall(input, init));
      return new Response(JSON.stringify({ output: "native-result" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "must-not-leak=1",
          "x-request-id": "request_123",
        },
      });
    };
    const driver = new ResponsesLoopbackDriver({ fetchImpl });
    await driver.start();
    try {
      for (const [localPath, upstreamPath] of [
        ["alpha/search", "alpha/search"],
        ["images/generations", "images/generations"],
        ["images/edits", "images/edits"],
      ] as const) {
        const response = await fetch(`${driver.baseUrl}/${localPath}`, {
          method: "POST",
          headers: nativeHeaders(driver, {
            "x-openai-actor-authorization": "must-not-win-over-bearer",
            "x-untrusted-local-header": "must-not-forward",
          }),
          body: JSON.stringify({ prompt: "safe" }),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-request-id")).toBe("request_123");
        expect(response.headers.get("set-cookie")).toBeNull();
        await expect(response.json()).resolves.toEqual({ output: "native-result" });
        const call = calls.at(-1);
        expect(call?.url).toBe(`https://chatgpt.com/backend-api/codex/${upstreamPath}`);
        expect(call?.method).toBe("POST");
        expect(call?.redirect).toBe("manual");
        expect(call?.signal).toBeInstanceOf(AbortSignal);
        expect(call?.headers.get("authorization")).toBe("Bearer real-chatgpt-token");
        expect(call?.headers.get("chatgpt-account-id")).toBe("account_123");
        expect(call?.headers.get("x-openai-actor-authorization")).toBeNull();
        expect(call?.headers.get("x-omnicodex-loopback-key")).toBeNull();
        expect(call?.headers.get("x-untrusted-local-header")).toBeNull();
        expect(call?.headers.get("user-agent")).toBeNull();
        expect(call?.body).toBe('{"prompt":"safe"}');
      }

      const noUpstreamAuth = await fetch(`${driver.baseUrl}/alpha/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-omnicodex-loopback-key": driver.apiKey,
        },
        body: "{}",
      });
      expect(noUpstreamAuth.status).toBe(401);
      await expect(errorCode(noUpstreamAuth)).resolves.toBe(
        "NATIVE_TOOL_UPSTREAM_AUTH_UNAVAILABLE",
      );

      for (const path of ["files", "chat/completions", "models/gpt-5.6-sol"]) {
        const rejected = await fetch(`${driver.baseUrl}/${path}`, {
          method: "POST",
          headers: nativeHeaders(driver),
          body: "{}",
        });
        expect(rejected.status).toBe(404);
        await expect(errorCode(rejected)).resolves.toBe("LOOPBACK_PATH_NOT_ALLOWED");
      }
      expect(calls).toHaveLength(3);
      expect(calls.every((call) => !call.url.includes("responses"))).toBe(true);
    } finally {
      await driver.stop();
    }
  });

  it("fails closed for method, media type, size, redirect, upstream errors, and timeout", async () => {
    let mode: "redirect" | "oversize" | "html" | "upstream-error" | "timeout" = "redirect";
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(fetchCall(input, init));
      switch (mode) {
        case "redirect":
          return new Response(null, {
            status: 302,
            headers: { location: "https://evil.example/steal" },
          });
        case "oversize":
          return new Response("{}", {
            headers: { "content-length": "1000", "content-type": "application/json" },
          });
        case "html":
          return new Response("<html>login</html>", {
            headers: { "content-type": "text/html" },
          });
        case "upstream-error":
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        case "timeout":
          return await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) reject(signal.reason);
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
      }
    };
    const driver = new ResponsesLoopbackDriver({
      fetchImpl,
      maxNativeToolRequestBytes: 32,
      maxNativeToolResponseBytes: 128,
      searchTimeoutMs: 10,
    });
    await driver.start();
    try {
      const methodRejected = await fetch(`${driver.baseUrl}/alpha/search`, {
        method: "GET",
        headers: nativeHeaders(driver),
      });
      expect(methodRejected.status).toBe(405);
      await expect(errorCode(methodRejected)).resolves.toBe("NATIVE_TOOL_METHOD_NOT_ALLOWED");

      const queryRejected = await fetch(`${driver.baseUrl}/alpha/search?redirect=evil`, {
        method: "POST",
        headers: nativeHeaders(driver),
        body: "{}",
      });
      expect(queryRejected.status).toBe(400);
      await expect(errorCode(queryRejected)).resolves.toBe("NATIVE_TOOL_QUERY_REJECTED");

      const mediaRejected = await fetch(`${driver.baseUrl}/alpha/search`, {
        method: "POST",
        headers: nativeHeaders(driver, { "content-type": "text/plain" }),
        body: "{}",
      });
      expect(mediaRejected.status).toBe(415);
      await expect(errorCode(mediaRejected)).resolves.toBe("NATIVE_TOOL_CONTENT_TYPE_REJECTED");

      const requestTooLarge = await fetch(`${driver.baseUrl}/alpha/search`, {
        method: "POST",
        headers: nativeHeaders(driver),
        body: JSON.stringify({ payload: "x".repeat(100) }),
      });
      expect(requestTooLarge.status).toBe(413);
      await expect(errorCode(requestTooLarge)).resolves.toBe("NATIVE_TOOL_REQUEST_TOO_LARGE");
      expect(calls).toHaveLength(0);

      const redirect = await nativeSearch(driver);
      expect(redirect.status).toBe(502);
      await expect(errorCode(redirect)).resolves.toBe("NATIVE_TOOL_UPSTREAM_REDIRECT_BLOCKED");

      mode = "oversize";
      const oversize = await nativeSearch(driver);
      expect(oversize.status).toBe(502);
      await expect(errorCode(oversize)).resolves.toBe("NATIVE_TOOL_RESPONSE_TOO_LARGE");

      mode = "html";
      const html = await nativeSearch(driver);
      expect(html.status).toBe(502);
      await expect(errorCode(html)).resolves.toBe("NATIVE_TOOL_UPSTREAM_CONTENT_TYPE_REJECTED");

      mode = "upstream-error";
      const upstreamError = await nativeSearch(driver);
      expect(upstreamError.status).toBe(429);
      await expect(upstreamError.json()).resolves.toMatchObject({
        error: {
          code: "NATIVE_TOOL_UPSTREAM_ERROR",
          message: "rate limited",
          upstreamStatus: 429,
        },
      });

      mode = "timeout";
      const timeout = await nativeSearch(driver);
      expect(timeout.status).toBe(504);
      await expect(errorCode(timeout)).resolves.toBe("NATIVE_TOOL_UPSTREAM_TIMEOUT");
      expect(calls).toHaveLength(5);
    } finally {
      await driver.stop();
    }
  });

  it("aborts an in-flight native upstream request when the loopback driver stops", async () => {
    let forwardedSignal: AbortSignal | null | undefined;
    let signalObserved!: () => void;
    const observed = new Promise<void>((resolve) => {
      signalObserved = resolve;
    });
    const fetchImpl: typeof fetch = async (_input, init) => {
      forwardedSignal = init?.signal;
      signalObserved();
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const driver = new ResponsesLoopbackDriver({ fetchImpl });
    await driver.start();
    const pending = nativeSearch(driver);
    await observed;
    const stopped = driver.stop();
    const response = await pending;
    await stopped;

    expect(forwardedSignal?.aborted).toBe(true);
    expect(response.status).toBe(502);
    await expect(errorCode(response)).resolves.toBe("NATIVE_TOOL_UPSTREAM_UNAVAILABLE");
  });

  it("streams an allowed upstream SSE response in order within the response cap", async () => {
    const chunks = Array.from({ length: 128 }, (_, index) => `data: ${index}\n\n`);
    const fetchImpl: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const driver = new ResponsesLoopbackDriver({
      fetchImpl,
      maxNativeToolResponseBytes: 64 * 1024,
    });
    await driver.start();
    try {
      const response = await nativeSearch(driver);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      await expect(response.text()).resolves.toBe(chunks.join(""));
    } finally {
      await driver.stop();
    }
  });

  it("round-trips a selected web__run call and media/resource output with zero model fetches", async () => {
    const upstreamCalls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      upstreamCalls.push(fetchCall(input, init));
      return new Response(JSON.stringify({ results: [{ title: "Native result" }] }), {
        headers: { "content-type": "application/json" },
      });
    };
    const driver = new ResponsesLoopbackDriver({ fetchImpl });
    await driver.start();
    try {
      const active = driver.prepareToolCall({
        kind: "function",
        namespace: "web",
        name: "run",
        arguments: { search_query: [{ q: "native search" }] },
      });
      const selected = await postResponses(driver, { model: "loopback", input: [], tools: [] });
      const selectedText = await selected.text();
      expect(selectedText).toContain('"namespace":"web"');
      expect(selectedText).toContain('"name":"run"');

      const nativeResult = await nativeSearch(driver);
      await expect(nativeResult.json()).resolves.toEqual({
        results: [{ title: "Native result" }],
      });

      const output = [
        { type: "image_generation_call", result: "aW1hZ2U=" },
        {
          type: "resource",
          resource: { uri: "omnicodex://image/result", mimeType: "image/png", blob: "aW1hZ2U=" },
        },
      ];
      const completed = await postResponses(driver, {
        model: "loopback",
        input: [{ type: "function_call_output", call_id: active.callId, output }],
        tools: [],
      });
      expect(completed.status).toBe(200);
      await completed.text();
      await expect(active.completion).resolves.toMatchObject({ output });

      const modelPath = await fetch(`${driver.baseUrl}/chat/completions`, {
        method: "POST",
        headers: nativeHeaders(driver),
        body: "{}",
      });
      expect(modelPath.status).toBe(404);
      expect(upstreamCalls).toHaveLength(1);
      expect(upstreamCalls[0]?.url).toBe("https://chatgpt.com/backend-api/codex/alpha/search");
      expect(
        upstreamCalls.some((call) => /responses|chat\/completions|models/.test(call.url)),
      ).toBe(false);
    } finally {
      await driver.stop();
    }
  });
});

async function selectAndRead(
  driver: ResponsesLoopbackDriver,
  selection: Parameters<ResponsesLoopbackDriver["prepareToolCall"]>[0],
): Promise<string> {
  const active = driver.prepareToolCall(selection);
  void active.completion.catch(() => undefined);
  const response = await postResponses(driver, {
    model: "gpt-5.6-sol",
    input: [],
    tools: [],
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  driver.cancelActiveToolCall(new Error("test call completed at stream boundary"));
  return text;
}

function postResponses(
  driver: ResponsesLoopbackDriver,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${driver.baseUrl}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-omnicodex-loopback-key": driver.apiKey,
    },
    body: JSON.stringify(body),
  });
}

function nativeSearch(driver: ResponsesLoopbackDriver): Promise<Response> {
  return fetch(`${driver.baseUrl}/alpha/search`, {
    method: "POST",
    headers: nativeHeaders(driver),
    body: '{"query":"safe"}',
  });
}

function nativeHeaders(
  driver: ResponsesLoopbackDriver,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    authorization: "Bearer real-chatgpt-token",
    "chatgpt-account-id": "account_123",
    "content-type": "application/json",
    "x-omnicodex-loopback-key": driver.apiKey,
    ...overrides,
  };
}

function fetchCall(input: string | URL | Request, init: RequestInit | undefined): FetchCall {
  return {
    url: String(input),
    headers: new Headers(init?.headers),
    body: Buffer.from(init?.body as Buffer).toString("utf8"),
    method: init?.method,
    redirect: init?.redirect,
    signal: init?.signal,
  };
}

async function errorCode(response: Response): Promise<unknown> {
  const value: unknown = await response.json();
  return objectValue(objectValue(value).error).code;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
