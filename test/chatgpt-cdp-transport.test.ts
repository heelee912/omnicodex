import { describe, expect, it, vi } from "vitest";
import { ChatGptAppApprovalAdapter } from "../src/infrastructure/chatgpt/chatgpt-app-approval-adapter.js";

class ManualSocket implements CdpWebSocketLike {
  readyState = 1;
  sent: string[] = [];
  listeners = new Map<string, ((e: { data?: unknown }) => void)[]>();
  addEventListener(t: "open" | "message" | "error" | "close", l: (e: { data?: unknown }) => void) {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), l]);
    if (t === "open") queueMicrotask(() => l({}));
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    for (const l of this.listeners.get("close") ?? []) l({});
  }
  emit(data: string) {
    for (const l of this.listeners.get("message") ?? []) l({ data });
  }
}
const connectedSession = async (
  socket: ManualSocket,
  options: Partial<{ timeoutMs: number; maxFrameBytes: number }> = {},
) => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ Browser: "Chrome/152" })))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: "1",
            url: "https://chatgpt.com/c/1",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1",
          },
        ]),
      ),
    );
  return BoundedCdpSession.connect(
    new ChatGptLoopbackCdpTransport({ endpoint: "http://127.0.0.1:9222", fetch }),
    { factory: () => socket, ...options },
  );
};

import {
  BoundedCdpSession,
  CdpChatGptApprovalSurface,
  type CdpWebSocketLike,
  ChatGptLoopbackCdpTransport,
} from "../src/infrastructure/chatgpt/chatgpt-cdp-transport.js";

describe("ChatGptLoopbackCdpTransport", () => {
  it("preflights Chrome and selects only exact ChatGPT origin", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ Browser: "Chrome/152" })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: "1",
              url: "https://chatgpt.com/c/1",
              webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1",
            },
            {
              id: "2",
              url: "https://evil.example",
              webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/2",
            },
          ]),
        ),
      );
    expect(
      (
        await new ChatGptLoopbackCdpTransport({
          endpoint: "http://127.0.0.1:9222",
          fetch,
        }).preflight()
      ).target.id,
    ).toBe("1");
  });
  it("rejects arbitrary evaluation and navigation", () => {
    const cdp = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch: vi.fn(),
    });
    expect(() => cdp.assertAllowedCommand("Runtime.evaluate", {})).toThrow(/forbidden/);
    expect(() => cdp.assertAllowedCommand("Page.navigate", {})).toThrow(/forbidden/);
  });
  it("allows only bounded DOM element click", () => {
    const cdp = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch: vi.fn(),
    });
    expect(() =>
      cdp.assertAllowedCommand("Runtime.callFunctionOn", {
        functionDeclaration: "function(){fetch('x')}",
      }),
    ).toThrow(/bounded/);
    expect(() =>
      cdp.assertAllowedCommand("Runtime.callFunctionOn", {
        objectId: "o",
        functionDeclaration: "function(){this.click()}",
        returnByValue: true,
        awaitPromise: false,
      }),
    ).not.toThrow();
  });

  it("frames a complete Connect -> Always allow -> tool result flow", async () => {
    class FakeSocket implements CdpWebSocketLike {
      readyState = 1;
      listeners = new Map<string, ((e: { data?: unknown }) => void)[]>();
      state = 0;
      addEventListener(
        t: "open" | "message" | "error" | "close",
        l: (e: { data?: unknown }) => void,
      ) {
        this.listeners.set(t, [...(this.listeners.get(t) ?? []), l]);
        if (t === "open") queueMicrotask(() => l({}));
      }
      close() {
        this.listeners.get("close")?.forEach((l) => {
          l({});
        });
      }
      send(data: string) {
        const request = JSON.parse(data) as { id: number; method: string };
        let result: unknown = {};
        if (request.method === "Accessibility.getFullAXTree") {
          const label =
            this.state === 0
              ? "Connect"
              : this.state === 1
                ? "Always allow"
                : "OmniCodex tool result";
          result = {
            nodes: [
              {
                nodeId: "context-app",
                backendDOMNodeId: 1,
                role: { value: "text" },
                name: { value: "OmniCodex" },
              },
              {
                nodeId: "context-run",
                backendDOMNodeId: 2,
                role: { value: "text" },
                name: { value: "r" },
              },
              {
                nodeId: `n${this.state}`,
                backendDOMNodeId: 10 + this.state,
                role: { value: this.state === 2 ? "status" : "button" },
                name: { value: label },
              },
            ],
          };
        } else if (request.method === "DOM.resolveNode")
          result = { object: { objectId: `o${this.state}` } };
        else if (request.method === "Runtime.callFunctionOn") this.state++;
        queueMicrotask(() =>
          this.listeners.get("message")?.forEach((l) => {
            l({ data: JSON.stringify({ id: request.id, result }) });
          }),
        );
      }
    }
    const socket = new FakeSocket();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ Browser: "Chrome/152" })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: "1",
              url: "https://chatgpt.com/c/1",
              webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1",
            },
          ]),
        ),
      );
    const transport = new ChatGptLoopbackCdpTransport({ endpoint: "http://127.0.0.1:9222", fetch });
    const session = await BoundedCdpSession.connect(transport, { factory: () => socket });
    const binding = {
      appConnectorId: "c",
      appName: "OmniCodex",
      oracleRunId: "r",
      sessionId: "s",
      correlationId: "x",
      mcpServerResource: "https://mcp.example/mcp",
      mcpSurface: "/mcp/full",
    };
    const result = await new ChatGptAppApprovalAdapter(binding).watch(
      new CdpChatGptApprovalSurface(session, binding, "OmniCodex tool result", [
        binding.appName,
        binding.oracleRunId,
      ]),
      { sleep: async () => {} },
    );
    expect(result.receipts.map((r) => r.action)).toEqual(["connect", "always_allow"]);
    expect(socket.state).toBe(2);
    session.close();
  });
  it("selects an explicitly bound ChatGPT target when multiple conversations exist", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ Browser: "Chrome/152" })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: "old",
              url: "https://chatgpt.com/c/old",
              webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/old",
            },
            {
              id: "current",
              url: "https://chatgpt.com/c/current",
              webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/current",
            },
            {
              id: "blank",
              url: "about:blank",
              webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/blank",
            },
          ]),
        ),
      );
    const selected = await new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch,
    }).preflight(undefined, "current");
    expect(selected.target.id).toBe("current");
  });
  it("binds a page through the exact connector iframe parent", async () => {
    const connectorId = "asdk_app_exact";
    const fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: "wrong-page",
            type: "page",
            url: "https://chatgpt.com/c/wrong",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/wrong",
          },
          {
            id: "right-page",
            type: "page",
            url: "https://chatgpt.com/c/right",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/right",
          },
          {
            id: "frame",
            type: "iframe",
            parentId: "right-page",
            url: `https://${connectorId}.web-sandbox.oaiusercontent.com/`,
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/frame",
          },
        ]),
      ),
    );
    const targets = await new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch,
    }).listChatGptTargets(undefined, connectorId);
    expect(targets.map((target) => target.id)).toEqual(["right-page"]);
  });
  it("fails closed when the exact Oracle run marker is absent from the page", async () => {
    class ContextSocket extends ManualSocket {
      override send(data: string) {
        super.send(data);
        const request = JSON.parse(data) as { id: number; method: string };
        const result =
          request.method === "Accessibility.getFullAXTree"
            ? {
                nodes: [
                  {
                    nodeId: "app",
                    backendDOMNodeId: 1,
                    role: { value: "text" },
                    name: { value: "OmniCodex" },
                  },
                  {
                    nodeId: "consent",
                    backendDOMNodeId: 2,
                    role: { value: "button" },
                    name: { value: "Always allow" },
                  },
                ],
              }
            : {};
        queueMicrotask(() => this.emit(JSON.stringify({ id: request.id, result })));
      }
    }
    const socket = new ContextSocket();
    const session = await connectedSession(socket);
    const binding = {
      appConnectorId: "connector",
      appName: "OmniCodex",
      oracleRunId: "exact-run-id",
      sessionId: "session",
      correlationId: "correlation",
      mcpServerResource: "https://mcp.example/mcp",
      mcpSurface: "/mcp",
    };

    await expect(
      new CdpChatGptApprovalSurface(session, binding, "TASK_OUTCOME: EXECUTED").snapshot(),
    ).rejects.toThrow("CHATGPT_TARGET_BINDING_MISMATCH");
    session.close();
  });
  it("bounds timeout, cancellation, and incoming frames", async () => {
    const timed = await connectedSession(new ManualSocket(), { timeoutMs: 5 });
    await expect(timed.command("DOM.getDocument", {})).rejects.toThrow(/timeout/);
    const cancelled = await connectedSession(new ManualSocket());
    const controller = new AbortController();
    const pending = cancelled.command("DOM.getDocument", {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    const socket = new ManualSocket();
    const oversized = await connectedSession(socket, { maxFrameBytes: 8 });
    const request = oversized.command("DOM.getDocument", {});
    socket.emit("123456789");
    await expect(request).rejects.toThrow(/CLOSED/);
  });
  it("closes on unexpected or duplicate response ids", async () => {
    const socket = new ManualSocket();
    const session = await connectedSession(socket);
    const pending = session.command("DOM.getDocument", {});
    socket.emit(JSON.stringify({ id: 999, result: {} }));
    await expect(pending).rejects.toThrow(/CLOSED/);
  });
});
