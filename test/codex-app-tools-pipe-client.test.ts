import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODEX_APP_TOOLS_SHARED_READINESS_ERROR_CODE,
  CodexAppToolsPipeClient,
  CodexAppToolsSharedReadinessError,
  codexAppToolsPipeEndpoint,
  decodeCodexAppToolResult,
} from "../src/infrastructure/windows/codex-app-tools-pipe-client.js";

interface HostRequest {
  readonly id: number;
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

interface TestHost {
  readonly endpoint: string;
  readonly requests: HostRequest[];
  readonly connectionCount: () => number;
  close(): Promise<void>;
}

describe("CodexAppToolsPipeClient", () => {
  it.each(["codex", "chatgpt"] as const)(
    "sends callerSource %s on readiness and actual calls",
    async (source) => {
      const stale = await startHost("wire-stale", async () => undefined);
      const live = await startHost("wire-current", async (request) => {
        if (request.method === "tools/list") return toolsListResponse(request.id);
        if (request.method === "tools/call") {
          if (request.params?.callerSource !== source) {
            return {
              id: request.id,
              jsonrpc: "2.0",
              error: { code: -32602, message: "Invalid app tool request" },
            };
          }
          return toolResultResponse(request.id, { ok: true });
        }
        return undefined;
      });
      const client = new CodexAppToolsPipeClient({
        discoverEndpoints: async () => [stale.endpoint, live.endpoint],
      });
      try {
        await expect(
          client.callTool(
            {
              ...toolCall("wire-call", {}),
              ...(source === "chatgpt" ? { callerSource: source } : {}),
            },
            { timeoutMs: 1000 },
          ),
        ).resolves.toEqual(nativeToolResult({ ok: true }));
        expect(
          live.requests.filter((r) => r.method === "tools/call").map((r) => r.params?.callerSource),
        ).toEqual([source, source]);
      } finally {
        client.close();
        await Promise.all([stale.close(), live.close()]);
      }
    },
  );

  it("reports a rejected wire contract instead of waiting forever on silent endpoints", async () => {
    const stale = await startHost("invalid-stale", async () => undefined);
    const live = await startHost("invalid-current", async (request) =>
      request.method === "tools/list"
        ? toolsListResponse(request.id)
        : {
            id: request.id,
            jsonrpc: "2.0",
            error: { code: -32602, message: "Invalid app tool request" },
          },
    );
    const client = new CodexAppToolsPipeClient({
      discoverEndpoints: async () => [stale.endpoint, live.endpoint],
    });
    try {
      await expect(
        client.callTool(toolCall("invalid-wire", {}), { timeoutMs: 1000 }),
      ).rejects.toThrow("Invalid app tool request");
      expect(live.requests.filter((r) => r.method === "tools/list")).toHaveLength(1);
      expect(live.requests.some((r) => r.params?.callId === "invalid-wire")).toBe(false);
    } finally {
      client.close();
      await Promise.all([stale.close(), live.close()]);
    }
  });

  it("discovers app-global and browser-use pipe names", () => {
    const id = "0c7df24e-6d5a-4d3c-8ca5-553eefb56578";
    expect(codexAppToolsPipeEndpoint(`codex-app-tools-${id}`)).toBe(
      `\\\\.\\pipe\\codex-app-tools-${id}`,
    );
    expect(codexAppToolsPipeEndpoint(`codex-browser-use-${id}`)).toBe(
      `\\\\.\\pipe\\codex-browser-use-${id}`,
    );
    expect(codexAppToolsPipeEndpoint(`codex-browser-use\\${id}`)).toBe(
      `\\\\.\\pipe\\codex-browser-use\\${id}`,
    );
    expect(codexAppToolsPipeEndpoint("codex-ipc")).toBeUndefined();
  });

  it("preserves native text while exposing a single JSON object as structured content", () => {
    expect(
      decodeCodexAppToolResult({
        success: true,
        contentItems: [{ type: "inputText", text: '{"threads":[{"id":"thread-1"}]}' }],
      }),
    ).toEqual({
      content: [{ type: "text", text: '{"threads":[{"id":"thread-1"}]}' }],
      structuredContent: { threads: [{ id: "thread-1" }] },
      isError: false,
    });
    expect(
      decodeCodexAppToolResult({
        success: false,
        contentItems: [{ type: "inputText", text: '{"error":"denied"}' }],
      }),
    ).not.toHaveProperty("structuredContent");
  });

  it("selects by capability, multiplexes out-of-order calls, and coalesces a callId", async () => {
    const wrong = await startHost("a-wrong", async (request) => ({
      id: request.id,
      jsonrpc: "2.0",
      error: { code: -1, message: "No handler registered for method: tools/list" },
    }));
    let callCount = 0;
    const right = await startHost("b-right", async (request) => {
      if (request.method === "tools/list") return toolsListResponse(request.id);
      if (request.method === "tools/call") {
        if (String(request.params?.callId).startsWith("omnicodex-native-readiness-")) {
          return toolResultResponse(request.id, { ready: true });
        }
        callCount += 1;
        const args = request.params?.arguments as Record<string, unknown>;
        if (args.order === "first") await delay(15);
        return toolResultResponse(request.id, { order: args.order });
      }
      return undefined;
    });
    const client = new CodexAppToolsPipeClient({
      discoverEndpoints: async () => [right.endpoint, wrong.endpoint],
    });
    try {
      await expect(client.listTools()).resolves.toEqual([
        expect.objectContaining({ namespace: "codex_app", name: "list_projects" }),
      ]);
      const first = client.callTool(toolCall("call-first", { order: "first" }));
      const second = client.callTool(toolCall("call-second", { order: "second" }));
      const duplicate = client.callTool(toolCall("call-second", { order: "second" }));
      await expect(Promise.all([first, second, duplicate])).resolves.toEqual([
        nativeToolResult({ order: "first" }),
        nativeToolResult({ order: "second" }),
        nativeToolResult({ order: "second" }),
      ]);
      expect(callCount).toBe(2);
      expect(right.connectionCount()).toBe(2);
      expect(right.requests.filter((request) => request.method === "tools/list")).toHaveLength(2);
    } finally {
      client.close();
      await Promise.all([right.close(), wrong.close()]);
    }
  });

  it("probes stale and live app-global endpoints in parallel", async () => {
    const stale = await startHost("a-stale-parallel", async () => undefined);
    const live = await startHost("b-live-parallel", async (request) =>
      request.method === "tools/list" ? toolsListResponse(request.id) : undefined,
    );
    const client = new CodexAppToolsPipeClient({
      discoverEndpoints: async () => [stale.endpoint, live.endpoint],
    });
    try {
      await expect(
        Promise.race([
          client.listTools({ timeoutMs: 800 }),
          delay(300).then(() => {
            throw new Error("live endpoint was blocked behind a stale endpoint");
          }),
        ]),
      ).resolves.toEqual([
        expect.objectContaining({ namespace: "codex_app", name: "list_projects" }),
      ]);
      expect(stale.requests.filter((request) => request.method === "tools/list")).toHaveLength(1);
      expect(live.requests.filter((request) => request.method === "tools/list")).toHaveLength(1);
    } finally {
      client.close();
      await Promise.all([stale.close(), live.close()]);
    }
  });

  it("selects a renderer that executes native calls instead of trusting catalog readiness", async () => {
    const stale = await startHost("a-catalog-only", async (request) => {
      if (request.method === "tools/list") return toolsListResponse(request.id);
      return undefined;
    });
    const live = await startHost("b-call-ready", async (request) => {
      if (request.method === "tools/list") return toolsListResponse(request.id);
      if (request.method === "tools/call") {
        if (String(request.params?.callId).startsWith("omnicodex-native-readiness-")) {
          return toolResultResponse(request.id, { ready: true });
        }
        return toolResultResponse(request.id, { threads: ["native-thread"] });
      }
      return undefined;
    });
    const client = new CodexAppToolsPipeClient({
      discoverEndpoints: async () => [stale.endpoint, live.endpoint],
    });
    try {
      await expect(
        Promise.race([
          client.callTool({ ...toolCall("read-thread", {}), tool: "read_thread" }),
          delay(300).then(() => {
            throw new Error("catalog-only endpoint blocked the native read");
          }),
        ]),
      ).resolves.toEqual(nativeToolResult({ threads: ["native-thread"] }));
      expect(
        stale.requests.filter(
          (request) => request.method === "tools/call" && request.params?.callId === "read-thread",
        ),
      ).toHaveLength(0);
      expect(
        live.requests.filter(
          (request) => request.method === "tools/call" && request.params?.callId === "read-thread",
        ),
      ).toHaveLength(1);
    } finally {
      client.close();
      await Promise.all([stale.close(), live.close()]);
    }
  });

  it("cancels abandoned discovery without selecting a late stale endpoint", async () => {
    let releaseStale!: () => void;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    let observeStale!: () => void;
    const staleObserved = new Promise<void>((resolve) => {
      observeStale = resolve;
    });
    const stale = await startHost("abandoned-stale", async (request) => {
      if (request.method !== "tools/list") return undefined;
      observeStale();
      await staleGate;
      return toolsListResponse(request.id);
    });
    const live = await startHost("replacement-live", async (request) =>
      request.method === "tools/list" ? toolsListResponse(request.id) : undefined,
    );
    let endpoints: readonly string[] = [stale.endpoint];
    const client = new CodexAppToolsPipeClient({
      discoverEndpoints: async () => endpoints,
    });
    try {
      const controller = new AbortController();
      const abandoned = client.listTools({ signal: controller.signal, timeoutMs: 800 });
      await staleObserved;
      controller.abort(new Error("caller abandoned discovery"));
      await expect(abandoned).rejects.toThrow("caller abandoned discovery");

      endpoints = [live.endpoint];
      releaseStale();
      await delay(20);
      await expect(client.listTools({ timeoutMs: 800 })).resolves.toEqual([
        expect.objectContaining({ namespace: "codex_app", name: "list_projects" }),
      ]);
      expect(live.requests.filter((request) => request.method === "tools/list")).toHaveLength(1);
    } finally {
      releaseStale();
      client.close();
      await Promise.all([stale.close(), live.close()]);
    }
  });

  it("keeps a cancelled mutation correlated through terminal settlement and preserves large frames", async () => {
    let observeCall!: () => void;
    const callObserved = new Promise<void>((resolve) => {
      observeCall = resolve;
    });
    let releaseCall!: () => void;
    const callGate = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    const host = await startHost("cancel", async (request) => {
      if (request.method === "tools/list") return toolsListResponse(request.id);
      if (request.method === "tools/call") {
        if (request.params?.callId === "cancelled-call") {
          observeCall();
          await callGate;
          return toolResultResponse(request.id, { terminal: true });
        }
        const callArguments = request.params?.arguments as Record<string, unknown> | undefined;
        const blob = callArguments?.blob;
        return toolResultResponse(request.id, { echo: typeof blob === "string" ? blob : "" });
      }
      return undefined;
    });
    const client = new CodexAppToolsPipeClient({
      discoverEndpoints: async () => [host.endpoint],
    });
    try {
      const controller = new AbortController();
      const completion = client.callTool(
        { ...toolCall("cancelled-call", {}), tool: "set_thread_title" },
        {
          signal: controller.signal,
        },
      );
      await callObserved;
      controller.abort(new Error("cancel requested"));
      await eventually(() => host.requests.some((request) => request.method === "tools/cancel"));
      let settled = false;
      void completion.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await delay(20);
      expect(settled).toBe(false);
      const call = host.requests.find((request) => request.method === "tools/call");
      const cancel = host.requests.find((request) => request.method === "tools/cancel");
      expect(cancel).toEqual({ id: call?.id, jsonrpc: "2.0", method: "tools/cancel" });
      releaseCall();
      await expect(completion).rejects.toThrow("cancel requested");

      const largeBlob = "x".repeat(8 * 1024 * 1024 + 1);
      const largeResult = await client.callTool(toolCall("large-call", { blob: largeBlob }));
      expect(largeResult.success).toBe(true);
      expect(largeResult.contentItems[0]?.text?.length).toBeGreaterThan(8 * 1024 * 1024);
      expect(largeResult.contentItems[0]?.text?.endsWith('"}')).toBe(true);
      expect(
        host.requests.filter(
          (request) => request.method === "tools/call" && request.params?.callId === "large-call",
        ),
      ).toHaveLength(1);
    } finally {
      releaseCall();
      client.close();
      await host.close();
    }
  });

  it("retains more than 1024 completed correlations indefinitely by default", async () => {
    let now = 1_000;
    let callCount = 0;
    const host = await startHost("unbounded-replays", async (request) => {
      if (request.method === "tools/list") return toolsListResponse(request.id);
      if (request.method === "tools/call") {
        callCount += 1;
        return toolResultResponse(request.id, { callId: request.params?.callId });
      }
      return undefined;
    });
    const client = new CodexAppToolsPipeClient({
      discoverEndpoints: async () => [host.endpoint],
      now: () => now,
    });
    try {
      const calls = Array.from({ length: 1_025 }, (_, index) =>
        client.callTool(toolCall(`default-retained-${index}`, {})),
      );
      await expect(Promise.all(calls)).resolves.toHaveLength(1_025);
      now += 365 * 24 * 60 * 60_000;
      await expect(client.callTool(toolCall("default-retained-0", {}))).resolves.toEqual(
        nativeToolResult({ callId: "default-retained-0" }),
      );
      expect(callCount).toBe(1_025);
    } finally {
      client.close();
      await host.close();
    }
  });

  it("fails malformed responses as unknown outcomes and reconnects for the next call", async () => {
    let malformed = true;
    const host = await startHost("reconnect", async (request, socket) => {
      if (request.method === "tools/list") return toolsListResponse(request.id);
      if (request.method === "tools/call" && malformed) {
        malformed = false;
        socket.write(frame(Buffer.from("not-json", "utf8")));
        return undefined;
      }
      if (request.method === "tools/call")
        return toolResultResponse(request.id, { recovered: true });
      return undefined;
    });
    const client = new CodexAppToolsPipeClient({
      discoverEndpoints: async () => [host.endpoint],
    });
    try {
      const malformedCall = { ...toolCall("malformed-call", {}), tool: "set_thread_title" };
      await expect(client.callTool(malformedCall)).rejects.toThrow("unknown outcome");
      await expect(client.callTool(malformedCall)).rejects.toThrow("unknown outcome");
      expect(
        host.requests.filter(
          (request) =>
            request.method === "tools/call" && request.params?.callId === "malformed-call",
        ),
      ).toHaveLength(1);
      await expect(client.callTool(toolCall("reconnected-call", {}))).resolves.toEqual(
        nativeToolResult({ recovered: true }),
      );
      expect(host.connectionCount()).toBe(2);
    } finally {
      client.close();
      await host.close();
    }
  });

  it("rejects reuse of one callId with different arguments without a second dispatch", async () => {
    const host = await startHost("identity", async (request) => {
      if (request.method === "tools/list") return toolsListResponse(request.id);
      if (request.method === "tools/call") return toolResultResponse(request.id, { ok: true });
      return undefined;
    });
    const client = new CodexAppToolsPipeClient({
      discoverEndpoints: async () => [host.endpoint],
    });
    try {
      await client.callTool(toolCall("stable-call", { value: 1 }));
      await expect(client.callTool(toolCall("stable-call", { value: 2 }))).rejects.toThrow(
        "reused with different input",
      );
      expect(host.requests.filter((request) => request.method === "tools/call")).toHaveLength(1);
    } finally {
      client.close();
      await host.close();
    }
  });

  it("fails closed at replay capacity without evicting or redispatching in-flight calls", async () => {
    let releaseCalls!: () => void;
    const callGate = new Promise<void>((resolve) => {
      releaseCalls = resolve;
    });
    const host = await startHost("replay-capacity", async (request) => {
      if (request.method === "tools/list") return toolsListResponse(request.id);
      if (request.method === "tools/call") {
        await callGate;
        return toolResultResponse(request.id, { ok: true });
      }
      return undefined;
    });
    const client = new CodexAppToolsPipeClient({
      discoverEndpoints: async () => [host.endpoint],
      maxReplayEntries: 1_024,
    });
    try {
      const retained = Array.from({ length: 1_024 }, (_, index) =>
        client.callTool(toolCall(`retained-${index}`, {})),
      );
      await eventually(
        () => host.requests.filter((request) => request.method === "tools/call").length === 1_024,
      );

      const duplicate = client.callTool(toolCall("retained-0", {}));
      await expect(client.callTool(toolCall("over-capacity", {}))).rejects.toThrow(
        "replay capacity is exhausted",
      );
      expect(
        host.requests.filter(
          (request) => request.method === "tools/call" && request.params?.callId === "retained-0",
        ),
      ).toHaveLength(1);
      expect(
        host.requests.filter(
          (request) =>
            request.method === "tools/call" && request.params?.callId === "over-capacity",
        ),
      ).toHaveLength(0);

      releaseCalls();
      await expect(Promise.all([...retained, duplicate])).resolves.toHaveLength(1_025);
    } finally {
      releaseCalls();
      client.close();
      await host.close();
    }
  });

  it("refreshes the live catalog after the bounded cache interval", async () => {
    let now = 1_000;
    let revision = 1;
    const host = await startHost("catalog-refresh", async (request) => {
      if (request.method !== "tools/list") return undefined;
      return {
        id: request.id,
        jsonrpc: "2.0",
        result: {
          tools: [
            {
              namespace: "codex_app",
              name: "list_projects",
              description: `revision-${revision}`,
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      };
    });
    const client = new CodexAppToolsPipeClient({
      discoverEndpoints: async () => [host.endpoint],
      catalogTtlMs: 100,
      now: () => now,
    });
    try {
      expect((await client.listTools())[0]?.description).toBe("revision-1");
      revision = 2;
      expect((await client.listTools())[0]?.description).toBe("revision-1");
      now += 101;
      expect((await client.listTools())[0]?.description).toBe("revision-2");
      expect(host.requests.filter((request) => request.method === "tools/list")).toHaveLength(2);
    } finally {
      client.close();
      await host.close();
    }
  });

  it("refreshes the live catalog on every later call unless a cache TTL is explicit", async () => {
    let revision = 1;
    const host = await startHost("catalog-no-default-cache", async (request) => {
      if (request.method !== "tools/list") return undefined;
      return {
        id: request.id,
        jsonrpc: "2.0",
        result: {
          tools: [
            {
              namespace: "codex_app",
              name: "list_projects",
              description: `revision-${revision}`,
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      };
    });
    const client = new CodexAppToolsPipeClient({
      discoverEndpoints: async () => [host.endpoint],
    });
    try {
      expect((await client.listTools())[0]?.description).toBe("revision-1");
      revision = 2;
      expect((await client.listTools())[0]?.description).toBe("revision-2");
      expect(host.requests.filter((request) => request.method === "tools/list")).toHaveLength(2);
    } finally {
      client.close();
      await host.close();
    }
  });

  it("waits within the discovery deadline for a late app-global pipe", async () => {
    const host = await startHost("late-readiness", async (request) =>
      request.method === "tools/list" ? toolsListResponse(request.id) : undefined,
    );
    let discoveryAttempts = 0;
    const client = new CodexAppToolsPipeClient({
      discoverEndpoints: async () => {
        discoveryAttempts += 1;
        return discoveryAttempts < 3 ? [] : [host.endpoint];
      },
      connectTimeoutMs: 100,
    });
    try {
      await expect(client.listTools({ timeoutMs: 800 })).resolves.toEqual([
        expect.objectContaining({ namespace: "codex_app", name: "list_projects" }),
      ]);
      expect(discoveryAttempts).toBeGreaterThanOrEqual(3);
    } finally {
      client.close();
      await host.close();
    }
  });

  it("rediscovers a rotated endpoint after an ambiguous read-only catalog request", async () => {
    let now = 1_000;
    let endpoints: readonly string[] = [];
    let oldListCount = 0;
    const live = await startHost("rotated-live", async (request) => {
      if (request.method !== "tools/list") return undefined;
      return toolsListResponse(request.id, "live-catalog");
    });
    const old = await startHost("rotated-old", async (request, socket) => {
      if (request.method !== "tools/list") return undefined;
      oldListCount += 1;
      if (oldListCount === 1) return toolsListResponse(request.id, "old-catalog");
      endpoints = [live.endpoint];
      socket.destroy();
      return undefined;
    });
    endpoints = [old.endpoint];
    const client = new CodexAppToolsPipeClient({
      discoverEndpoints: async () => endpoints,
      connectTimeoutMs: 100,
      catalogTtlMs: 100,
      now: () => now,
    });
    try {
      expect((await client.listTools({ timeoutMs: 800 }))[0]?.description).toBe("old-catalog");
      now += 101;
      expect((await client.listTools({ timeoutMs: 800 }))[0]?.description).toBe("live-catalog");
      expect(old.requests.filter((request) => request.method === "tools/list")).toHaveLength(2);
      expect(live.requests.filter((request) => request.method === "tools/list")).toHaveLength(1);
    } finally {
      client.close();
      await Promise.all([old.close(), live.close()]);
    }
  });

  it("returns a stable typed error when shared Desktop readiness remains unavailable", async () => {
    const client = new CodexAppToolsPipeClient({
      discoverEndpoints: async () => [],
      connectTimeoutMs: 20,
    });
    try {
      const failure = await client.listTools({ timeoutMs: 50 }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CodexAppToolsSharedReadinessError);
      expect(failure).toMatchObject({ code: CODEX_APP_TOOLS_SHARED_READINESS_ERROR_CODE });
    } finally {
      client.close();
    }
  });

  it("uses only an explicit caller deadline and accepts timeouts beyond the JS timer range", async () => {
    const host = await startHost("caller-deadline", async (request) => {
      if (request.method === "tools/list") return toolsListResponse(request.id);
      if (request.method === "tools/call") {
        await delay(20);
        return toolResultResponse(request.id, { completed: true });
      }
      return undefined;
    });
    const client = new CodexAppToolsPipeClient({
      discoverEndpoints: async () => [host.endpoint],
    });
    try {
      await expect(client.callTool(toolCall("no-default-deadline", {}))).resolves.toEqual(
        nativeToolResult({ completed: true }),
      );
      await expect(
        client.callTool(toolCall("long-caller-deadline", {}), { timeoutMs: 3_000_000_000 }),
      ).resolves.toEqual(nativeToolResult({ completed: true }));
    } finally {
      client.close();
      await host.close();
    }
  });

  it("stops an explicitly bounded read-only call without replaying its dispatched frame", async () => {
    const host = await startHost("read-deadline", async (request) => {
      if (request.method === "tools/list") return toolsListResponse(request.id);
      return undefined;
    });
    const client = new CodexAppToolsPipeClient({
      discoverEndpoints: async () => [host.endpoint],
    });
    try {
      const call = toolCall("bounded-native-read", {});
      await expect(client.callTool(call, { timeoutMs: 30 })).rejects.toThrow("deadline exceeded");
      await eventually(() => host.requests.some((request) => request.method === "tools/cancel"));
      await expect(client.callTool(call)).rejects.toThrow("deadline exceeded");
      expect(
        host.requests.filter(
          (request) =>
            request.method === "tools/call" && request.params?.callId === "bounded-native-read",
        ),
      ).toHaveLength(1);
    } finally {
      client.close();
      await host.close();
    }
  });

  it("honors an absolute caller deadline while waiting for shared Desktop readiness", async () => {
    const client = new CodexAppToolsPipeClient({
      discoverEndpoints: async () => [],
      connectTimeoutMs: 20,
    });
    try {
      const failure = await client
        .listTools({ deadlineUnixMs: Date.now() + 30 })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CodexAppToolsSharedReadinessError);
      expect(failure).toMatchObject({ code: CODEX_APP_TOOLS_SHARED_READINESS_ERROR_CODE });
    } finally {
      client.close();
    }
  });

  it("preserves the complete JSON-RPC error returned by the native app-tools host", async () => {
    const tail = "END_OF_NATIVE_PIPE_ERROR";
    const message = `${"e".repeat(20_000)}${tail}`;
    const rpcError = {
      code: -32_000,
      message,
      data: {
        stderr: `${"diagnostic".repeat(20_000)}${tail}`,
        events: [{ sequence: 1 }, { sequence: 2 }],
      },
      extension: { retryable: false, nativeStatus: "failed" },
    };
    const host = await startHost("full-error", async (request) => {
      if (request.method === "tools/list") return toolsListResponse(request.id);
      if (request.method === "tools/call") {
        return { id: request.id, jsonrpc: "2.0", error: rpcError };
      }
      return undefined;
    });
    const client = new CodexAppToolsPipeClient({
      discoverEndpoints: async () => [host.endpoint],
    });
    try {
      const failure = await client
        .callTool(toolCall("full-native-error", {}))
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(tail);
      expect((failure as Error).message.length).toBeGreaterThan(20_000);
      expect(failure).toMatchObject({
        code: rpcError.code,
        data: rpcError.data,
        rpcError,
        cause: rpcError,
      });
    } finally {
      client.close();
      await host.close();
    }
  });
});

async function startHost(
  label: string,
  handler: (request: HostRequest, socket: Socket) => Promise<Record<string, unknown> | undefined>,
): Promise<TestHost> {
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\omnicodex-app-tools-${label}-${randomUUID()}`
      : join(tmpdir(), `omnicodex-app-tools-${label}-${randomUUID()}.sock`);
  const requests: HostRequest[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE(0);
        if (buffer.length < size + 4) return;
        const request = JSON.parse(buffer.subarray(4, size + 4).toString("utf8")) as HostRequest;
        buffer = buffer.subarray(size + 4);
        requests.push(request);
        void handler(request, socket).then((response) => {
          if (response !== undefined && !socket.destroyed) {
            socket.write(frame(Buffer.from(JSON.stringify(response), "utf8")));
          }
        });
      }
    });
  });
  await listen(server, endpoint);
  return {
    endpoint,
    requests,
    connectionCount: () => connections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      if (process.platform !== "win32") await rm(endpoint, { force: true });
    },
  };
}

function toolsListResponse(id: number, description = "List projects"): Record<string, unknown> {
  return {
    id,
    jsonrpc: "2.0",
    result: {
      tools: [
        {
          namespace: "codex_app",
          name: "list_projects",
          description,
          inputSchema: { type: "object", additionalProperties: false, properties: {} },
        },
      ],
    },
  };
}

function toolResultResponse(id: number, value: unknown): Record<string, unknown> {
  return { id, jsonrpc: "2.0", result: nativeToolResult(value) };
}

function nativeToolResult(value: unknown) {
  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
  };
}

function toolCall(callId: string, argumentsValue: Record<string, unknown>) {
  return {
    arguments: argumentsValue,
    callId,
    namespace: "codex_app",
    threadId: "desktop-owned-thread",
    tool: "list_projects",
    turnId: `turn-${callId}`,
  };
}

function frame(payload: Buffer): Buffer {
  const value = Buffer.allocUnsafe(payload.length + 4);
  value.writeUInt32LE(payload.length, 0);
  payload.copy(value, 4);
  return value;
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not observed");
    await delay(5);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
