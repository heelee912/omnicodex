import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { ChatGptAppApprovalAdapter } from "../src/infrastructure/chatgpt/chatgpt-app-approval-adapter.js";
import { DESKTOP_EXACT_CONVERSATION_READER } from "../src/infrastructure/windows/desktop-chat-api-reader.js";
import {
  DESKTOP_NATIVE_SEND_LIFECYCLE_SOURCE,
  DESKTOP_NATIVE_SEND_SOURCE,
} from "../src/infrastructure/windows/desktop-chat-native-sender.js";

class ManualSocket implements CdpWebSocketLike {
  readyState = 1;
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  listeners = new Map<string, ((e: { data?: unknown }) => void)[]>();
  addEventListener(t: "open" | "message" | "error" | "close", l: (e: { data?: unknown }) => void) {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), l]);
    if (t === "open") queueMicrotask(() => l({}));
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closeCalls.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
    for (const l of this.listeners.get("close") ?? []) l({});
  }
  emit(data: string) {
    for (const l of this.listeners.get("message") ?? []) l({ data });
  }
}
const connectedSession = async (
  socket: ManualSocket,
  options: Partial<Pick<CdpSessionOptions, "timeoutMs" | "maxFrameBytes">> = {},
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
  CdpProtocolError,
  type CdpSessionOptions,
  type CdpWebSocketLike,
  CHATGPT_APP_SETTINGS_URL,
  CHATGPT_OPEN_PLUGINS_SETTINGS_EXPRESSION,
  CHATGPT_OPEN_PLUGINS_SETTINGS_FUNCTION,
  CHATGPT_SETTINGS_CONTROL_CLICK_FUNCTION,
  CHATGPT_SETTINGS_CONTROL_SNAPSHOT_FUNCTION,
  CHATGPT_SETTINGS_DOCUMENT_EXPRESSION,
  ChatGptLoopbackCdpTransport,
  callFunctionAndReleaseObject,
  chatGptAppSettingsUrl,
  connectActivatedOwnedSettingsSession,
  DEFAULT_CDP_COMMAND_LIVENESS_TIMEOUT_MS,
  DEFAULT_CDP_CONTROL_LIVENESS_TIMEOUT_MS,
  DESKTOP_CHAT_SELECTED_CONVERSATION_EXPRESSION,
  isOwnedTargetActivationAdvisoryFailure,
  ORACLE_APPROVAL_CONTROL_POINT_FUNCTION,
  ORACLE_APPROVAL_CONTROL_SNAPSHOT_EXPRESSION,
  ORACLE_APPROVAL_OWNER_CLAIM_EXPRESSION,
} from "../src/infrastructure/chatgpt/chatgpt-cdp-transport.js";
import {
  ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION,
  ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION,
  oracleChatGptApprovalRuntimeUrl,
  oracleChatGptServerApprovalScanExpression,
} from "../src/infrastructure/chatgpt/oracle-chatgpt-server-approval-script.js";

describe("ChatGptLoopbackCdpTransport", () => {
  it.each([
    "Runtime.executionContextCreated",
    "Page.frameNavigated",
    "Network.webSocketFrameReceived",
  ])("preserves an outstanding command when Chrome emits %s", async (method) => {
    const socket = new ManualSocket();
    const session = await connectedSession(socket);
    const pending = session.command("DOM.getDocument", {});
    socket.emit(JSON.stringify({ method, params: {} }));
    socket.emit(JSON.stringify({ id: 1, result: { root: { nodeId: 1 } } }));
    await expect(pending).resolves.toEqual({ root: { nodeId: 1 } });
    expect(socket.closeCalls).toEqual([]);
    session.close();
  });

  it("permits passive network observation without enabling request interception", () => {
    const transport = new ChatGptLoopbackCdpTransport({ endpoint: "http://127.0.0.1:9222" });
    expect(() => transport.assertAllowedCommand("Network.enable", {})).not.toThrow();
    expect(() => transport.assertAllowedCommand("Network.disable", {})).not.toThrow();
    expect(() =>
      transport.assertAllowedCommand("Network.enable", { maxPostDataSize: 1000 }),
    ).toThrow();
    expect(() => transport.assertAllowedCommand("Network.setRequestInterception", {})).toThrow();
    expect(() => transport.assertAllowedCommand("Fetch.enable", {})).toThrow();
  });

  it("connects from an authoritative target receipt without a racing inventory read", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.reject(new Error("unexpected inventory read")),
    );
    const transport = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch,
    });
    const socket = new ManualSocket();
    const target = {
      id: "receipt-target",
      type: "page",
      url: "https://chatgpt.com/c/receipt-conversation",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/receipt-target",
    } as const;

    const session = await BoundedCdpSession.connect(transport, {
      factory: () => socket,
      targetId: target.id,
      target,
    });

    expect(session.targetId).toBe(target.id);
    expect(fetch).not.toHaveBeenCalled();
    session.close();
  });

  it.each([false, true])(
    "releases a temporary object after inspection failure=%s",
    async (fail) => {
      const failure = new Error("inspection failed");
      const command = vi.fn(async (method: string) => {
        if (method === "Runtime.callFunctionOn" && fail) throw failure;
        return { value: true };
      });
      const close = vi.fn();
      const session = { command, close } as unknown as BoundedCdpSession;
      const result = callFunctionAndReleaseObject(session, { objectId: "temporary" });
      if (fail) await expect(result).rejects.toBe(failure);
      else await expect(result).resolves.toEqual({ value: true });
      expect(command).toHaveBeenLastCalledWith(
        "Runtime.releaseObject",
        { objectId: "temporary" },
        undefined,
      );
      expect(close).not.toHaveBeenCalled();
    },
  );

  it("closes only the inspector on cleanup failure without losing a committed click result", async () => {
    const command = vi.fn(async (method: string) => {
      if (method === "Runtime.releaseObject") throw new Error("context gone after click");
      return { value: true };
    });
    const close = vi.fn();
    await expect(
      callFunctionAndReleaseObject({ command, close } as unknown as BoundedCdpSession, {
        objectId: "clicked",
      }),
    ).resolves.toEqual({ value: true });
    expect(close).toHaveBeenCalledOnce();
    expect(
      command.mock.calls.filter(([method]) => method === "Runtime.callFunctionOn"),
    ).toHaveLength(1);
  });

  it("permits exact inspector object cleanup but not arbitrary Runtime commands", () => {
    const transport = new ChatGptLoopbackCdpTransport({ endpoint: "http://127.0.0.1:9222" });
    expect(() =>
      transport.assertAllowedCommand("Runtime.releaseObject", { objectId: "temporary" }),
    ).not.toThrow();
    expect(() => transport.assertAllowedCommand("Runtime.releaseObject", { objectId: "" })).toThrow(
      /identity/,
    );
    expect(() =>
      transport.assertAllowedCommand("Runtime.releaseObject", {
        objectId: "temporary",
        expression: "x",
      }),
    ).toThrow(/identity/);
  });
  it("reclaims only exact orphaned Oracle settings utility targets", async () => {
    const connectorId = "asdk_app_exact";
    const plugin = `plugin_${connectorId}`;
    let targets = [
      {
        id: "bare-index",
        type: "page",
        url: "https://chatgpt.com/plugins",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/bare-index",
      },
      {
        id: "exact-detail",
        type: "page",
        url: `https://chatgpt.com/plugins/${plugin}#settings/Plugins/${plugin}`,
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/exact-detail",
      },
      {
        id: "lightweight-marker",
        type: "page",
        url: "about:blank?omnicodex_target=39bbc917-eb36-437e-9a66-937e310ae7d2",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/lightweight-marker",
      },
      {
        id: "legacy-marker",
        type: "page",
        url: "https://chatgpt.com/plugins?omnicodex_target=1c4804bb-124e-47e2-a009-b30c0e3c968d",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/legacy-marker",
      },
      {
        id: "foreign-blank",
        type: "page",
        url: "about:blank",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/foreign-blank",
      },
      {
        id: "user-chat",
        type: "page",
        url: "https://chatgpt.com/c/keep-user-chat",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/user-chat",
      },
      {
        id: "foreign-detail",
        type: "page",
        url: "https://chatgpt.com/plugins/plugin_asdk_app_other#settings/Plugins/plugin_asdk_app_other",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/foreign-detail",
      },
    ];
    const closed: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/json/list") return new Response(JSON.stringify(targets));
      if (url.pathname.startsWith("/json/close/") && init?.method === "PUT") {
        const targetId = url.pathname.slice("/json/close/".length);
        closed.push(targetId);
        targets = targets.filter((target) => target.id !== targetId);
        return new Response("Target is closing");
      }
      throw new Error(`unexpected ${url}`);
    });
    const transport = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(transport.closeOrphanedSettingsTargets(connectorId)).resolves.toEqual([
      "bare-index",
      "exact-detail",
      "lightweight-marker",
      "legacy-marker",
    ]);
    expect(closed).toEqual(["bare-index", "exact-detail", "lightweight-marker", "legacy-marker"]);
  });
  it("preserves a replacement settings target while reclaiming older utility pages", async () => {
    const connectorId = "asdk_app_exact";
    const replacement = {
      id: "replacement",
      type: "page",
      url: "about:blank?omnicodex_target=4f4eb16e-68d5-4f10-b944-abbb1c9ec9bc",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/replacement",
    };
    let targets = [
      replacement,
      {
        id: "stale",
        type: "page",
        url: "https://chatgpt.com/plugins",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/stale",
      },
    ];
    const closed: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/json/list") return new Response(JSON.stringify(targets));
      if (url.pathname.startsWith("/json/close/") && init?.method === "PUT") {
        const targetId = url.pathname.slice("/json/close/".length);
        closed.push(targetId);
        targets = targets.filter((target) => target.id !== targetId);
        return new Response("Target is closing");
      }
      throw new Error(`unexpected ${url}`);
    });
    const transport = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(
      transport.closeOrphanedSettingsTargets(connectorId, undefined, [replacement.id]),
    ).resolves.toEqual(["stale"]);
    expect(closed).toEqual(["stale"]);
    expect(targets).toContainEqual(replacement);
  });
  it("uses fresh loopback HTTP connections for the default CDP transport", async () => {
    const target = {
      id: "fresh-http",
      type: "page",
      url: "https://chatgpt.com/c/fresh-http",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/fresh-http",
    };
    const server = createServer((request, response) => {
      response.setHeader("connection", "close");
      response.setHeader("content-type", "application/json");
      response.end(
        request.url === "/json/version"
          ? JSON.stringify({ Browser: "Chrome/152" })
          : JSON.stringify([target]),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("test server unavailable");
      await expect(
        new ChatGptLoopbackCdpTransport({
          endpoint: `http://127.0.0.1:${String(address.port)}`,
        }).preflight(),
      ).resolves.toMatchObject({ target });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });
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
  it("attaches to an exact Desktop app renderer only when that local mode is explicit", async () => {
    const appTarget = {
      id: "desktop-app",
      type: "page",
      url: "app://-/index.html?initialRoute=%2Flocal%2Ftask",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/desktop-app",
    };
    const responses = () =>
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ Browser: "Chrome/152" })))
        .mockResolvedValueOnce(new Response(JSON.stringify([appTarget])));
    await expect(
      new ChatGptLoopbackCdpTransport({
        endpoint: "http://127.0.0.1:9222",
        fetch: responses(),
      }).preflight(undefined, appTarget.id),
    ).rejects.toThrow("CHATGPT_TARGET_MISSING_OR_AMBIGUOUS");
    await expect(
      new ChatGptLoopbackCdpTransport({
        endpoint: "http://127.0.0.1:9222",
        fetch: responses(),
        allowDesktopAppTargets: true,
      }).preflight(undefined, appTarget.id),
    ).resolves.toMatchObject({ target: appTarget });
  });
  it("allows the fixed selected-conversation read only in explicit Desktop mode", () => {
    const parameters = {
      expression: DESKTOP_CHAT_SELECTED_CONVERSATION_EXPRESSION,
      returnByValue: true,
      awaitPromise: false,
    };
    expect(() =>
      new ChatGptLoopbackCdpTransport({
        endpoint: "http://127.0.0.1:9222",
        allowDesktopAppTargets: true,
      }).assertAllowedCommand("Runtime.evaluate", parameters, "desktop-app"),
    ).not.toThrow();
    expect(() =>
      new ChatGptLoopbackCdpTransport({
        endpoint: "http://127.0.0.1:9222",
      }).assertAllowedCommand("Runtime.evaluate", parameters, "desktop-app"),
    ).toThrow("Runtime evaluation forbidden except for fixed Oracle operations");
  });
  it("admits an exact child ChatGPT webview and its exact conversation navigation in Desktop mode", async () => {
    const webview = {
      id: "desktop-chat-webview",
      type: "webview",
      parentId: "desktop-parent",
      url: "https://chatgpt.com/?source=codex-embedded-checkout#pricing",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/desktop-chat-webview",
    };
    const responses = () =>
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ Browser: "Chrome/152" })))
        .mockResolvedValueOnce(new Response(JSON.stringify([webview])));
    const transport = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch: responses(),
      allowDesktopAppTargets: true,
    });

    await expect(transport.preflight(undefined, webview.id)).resolves.toMatchObject({
      target: webview,
    });
    expect(() =>
      transport.assertAllowedCommand(
        "Page.navigate",
        { url: "https://chatgpt.com/c/6a9ee06d-9948-83e8-a027-2b6611693dc2" },
        webview.id,
      ),
    ).not.toThrow();
  });

  it("admits a Desktop guest reported as other on an exact conversation or the exact resumable home", async () => {
    const guest = {
      id: "desktop-chat-guest",
      type: "other",
      title: "Desktop Chat",
      url: "https://chatgpt.com/c/conversation-123",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/desktop-chat-guest",
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ Browser: "Chrome/140" })))
      .mockResolvedValueOnce(new Response(JSON.stringify([guest])));
    const transport = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      allowDesktopAppTargets: true,
      fetch,
    });

    await expect(transport.preflight(undefined, guest.id)).resolves.toMatchObject({
      target: guest,
    });

    const home = {
      ...guest,
      id: "desktop-chat-home-guest",
      url: "https://chatgpt.com/",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/desktop-chat-home-guest",
    };
    const homeFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ Browser: "Chrome/140" })))
      .mockResolvedValueOnce(new Response(JSON.stringify([home])));
    await expect(
      new ChatGptLoopbackCdpTransport({
        endpoint: "http://127.0.0.1:9222",
        allowDesktopAppTargets: true,
        fetch: homeFetch,
      }).preflight(undefined, home.id),
    ).resolves.toMatchObject({ target: home });
  });
  it("derives the connector target set from one point-in-time inventory read", async () => {
    const connectorId = "asdk_app_exact";
    const page = {
      id: "page",
      type: "page",
      url: "https://chatgpt.com/c/exact",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/page",
    };
    const frame = {
      id: "frame",
      type: "iframe",
      parentId: page.id,
      url: `https://${connectorId}.web-sandbox.oaiusercontent.com/`,
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/frame",
    };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([page, frame])));
    const inventory = await new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch,
    }).listChatGptTargetInventory(undefined, connectorId);

    expect(inventory).toEqual({ targets: [page], connectorTargets: [page] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("ends a silent loopback control request with the default liveness lease", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      });
      const pending = new ChatGptLoopbackCdpTransport({
        endpoint: "http://127.0.0.1:9222",
        fetch: fetch as typeof globalThis.fetch,
      }).preflight();

      const rejection = expect(pending).rejects.toThrow("CDP request timeout");
      await vi.advanceTimersByTimeAsync(DEFAULT_CDP_CONTROL_LIVENESS_TIMEOUT_MS);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
  it("recovers the exact created target after an ambiguous /json/new timeout", async () => {
    let requestedTargetUrl: string | undefined;
    const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/json/new") {
        requestedTargetUrl = decodeURIComponent(url.search.slice(1));
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      }
      if (url.pathname === "/json/list") {
        if (requestedTargetUrl === undefined) throw new Error("missing creation marker");
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                id: "recovered-target",
                type: "page",
                url: requestedTargetUrl,
                webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/recovered-target",
              },
            ]),
          ),
        );
      }
      throw new Error(`unexpected ${url}`);
    });
    const transport = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      timeoutMs: 5,
      fetch: fetch as typeof globalThis.fetch,
    });

    const target = await transport.openOwnedSettingsTarget("asdk_app_exact");

    expect(target.id).toBe("recovered-target");
    expect(target.url.startsWith("about:blank?omnicodex_target=")).toBe(true);
    expect(new URL(target.url).searchParams.get("omnicodex_target")).toMatch(/^[0-9a-f-]{36}$/);
    await expect(transport.getOwnedSettingsTarget(target.id)).resolves.toMatchObject({
      kind: "owned_navigation_pending",
      targetId: target.id,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("accepts a large loopback CDP response unless the caller selects a cap", async () => {
    const largeVersion = JSON.stringify({
      Browser: "Chrome/152",
      diagnostic: "x".repeat(1_000_001),
    });
    const target = {
      id: "large-response",
      url: "https://chatgpt.com/c/large-response",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/large-response",
    };
    const uncapped = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch: vi
        .fn()
        .mockResolvedValueOnce(new Response(largeVersion))
        .mockResolvedValueOnce(new Response(JSON.stringify([target]))),
    });
    await expect(uncapped.preflight()).resolves.toMatchObject({ target });

    const capped = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      maxResponseBytes: 1_000,
      fetch: vi.fn().mockResolvedValueOnce(new Response(largeVersion)),
    });
    await expect(capped.preflight()).rejects.toMatchObject({
      message: "CDP_HTTP_RESPONSE_OVERSIZED",
      payload: largeVersion,
    });
  });
  it("ignores CDP targets with empty or malformed URLs", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ Browser: "Chrome/152" })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: "empty-url",
              url: "",
              webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/empty-url",
            },
            {
              id: "bad-websocket",
              url: "https://chatgpt.com/c/bad-websocket",
              webSocketDebuggerUrl: "",
            },
            {
              id: "valid",
              url: "https://chatgpt.com/c/valid",
              webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/valid",
            },
          ]),
        ),
      );

    const selected = await new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch,
    }).preflight();

    expect(selected.target.id).toBe("valid");
  });
  it("attaches to an exact owned settings target during its transient empty-URL navigation", async () => {
    const settingsTarget = {
      id: "owned",
      type: "page",
      url: "https://chatgpt.com/#settings/Plugins",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/owned",
    };
    let createdTarget = settingsTarget;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/json/new") {
        createdTarget = { ...settingsTarget, url: decodeURIComponent(url.search.slice(1)) };
        return new Response(JSON.stringify(createdTarget));
      }
      if (url.pathname === "/json/version") {
        return new Response(JSON.stringify({ Browser: "Chrome/152" }));
      }
      if (url.pathname === "/json/list") {
        return new Response(JSON.stringify([{ ...settingsTarget, url: "" }]));
      }
      throw new Error(`unexpected ${url}`);
    });
    const transport = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch: fetch as typeof globalThis.fetch,
    });

    await transport.openOwnedSettingsTarget("asdk_app_exact");
    await expect(transport.preflight(undefined, "owned")).resolves.toMatchObject({
      browser: "Chrome/owned-target-receipt",
      target: { id: "owned", url: createdTarget.url },
    });
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/json/new",
    ]);
    expect(
      transport.classifyOwnedSettingsLocation("owned", chatGptAppSettingsUrl("asdk_app_exact")),
    ).toMatchObject({ kind: "chatgpt_settings", target: { id: "owned" } });
  });
  it("reconnects the same owned settings target until its Page domain is active", async () => {
    const settingsTarget = {
      id: "owned",
      type: "page",
      url: CHATGPT_APP_SETTINGS_URL,
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/owned",
    };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/json/new") {
        return new Response(
          JSON.stringify({ ...settingsTarget, url: decodeURIComponent(url.search.slice(1)) }),
        );
      }
      if (url.pathname === "/json/activate/owned") return new Response("Target activated");
      throw new Error(`unexpected ${url}`);
    });
    const transport = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch,
    });
    await transport.openOwnedSettingsTarget("asdk_app_exact");
    const sockets: ManualSocket[] = [];
    const factory = vi.fn(() => {
      const socket = new ManualSocket();
      const probeIndex = sockets.length;
      socket.send = (data: string) => {
        socket.sent.push(data);
        const request = JSON.parse(data) as { id: number };
        if (probeIndex < 2) {
          queueMicrotask(() =>
            socket.emit(
              JSON.stringify(
                probeIndex === 0
                  ? {
                      id: request.id,
                      error: { code: -32000, message: "Not attached to an active page" },
                    }
                  : { id: request.id, result: { currentIndex: 0, entries: [] } },
              ),
            ),
          );
        }
      };
      sockets.push(socket);
      return socket;
    });

    const activated = await connectActivatedOwnedSettingsSession(transport, {
      factory,
      targetId: settingsTarget.id,
    });

    expect(factory).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/json/new",
      "/json/activate/owned",
    ]);
    expect(sockets[0]?.closeCalls).toHaveLength(1);
    expect(sockets[1]?.closeCalls).toHaveLength(0);
    expect(activated.initialNavigationHistory).toEqual({ currentIndex: 0, entries: [] });
    activated.session.close();
  });
  it("uses the Page-domain probe when remote foreground activation times out", async () => {
    const settingsTarget = {
      id: "owned",
      type: "page",
      url: CHATGPT_APP_SETTINGS_URL,
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/owned",
    };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/json/new") {
        return new Response(
          JSON.stringify({ ...settingsTarget, url: decodeURIComponent(url.search.slice(1)) }),
        );
      }
      throw new Error(`unexpected ${url}`);
    });
    const transport = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch,
    });
    await transport.openOwnedSettingsTarget("asdk_app_exact");
    vi.spyOn(transport, "activateOwnedTarget").mockRejectedValueOnce(
      new Error("CDP request timeout:PUT:/json/activate/owned"),
    );
    const socket = new ManualSocket();
    socket.send = (data: string) => {
      socket.sent.push(data);
      const request = JSON.parse(data) as { id: number };
      queueMicrotask(() =>
        socket.emit(JSON.stringify({ id: request.id, result: { currentIndex: 0, entries: [] } })),
      );
    };

    const activated = await connectActivatedOwnedSettingsSession(transport, {
      factory: () => socket,
      targetId: settingsTarget.id,
    });

    expect(activated.initialNavigationHistory).toEqual({ currentIndex: 0, entries: [] });
    activated.session.close();
  });
  it("classifies only bounded activate-endpoint timeouts as advisory", () => {
    expect(
      isOwnedTargetActivationAdvisoryFailure(
        new Error("CDP request timeout:PUT:/json/activate/owned"),
      ),
    ).toBe(true);
    expect(
      isOwnedTargetActivationAdvisoryFailure(new Error("CDP request timeout:GET:/json/list")),
    ).toBe(false);
  });
  it("allows fixed navigation only for the exact owned settings target", async () => {
    const settingsUrl = chatGptAppSettingsUrl("asdk_app_exact");
    const target = {
      id: "owned",
      type: "page",
      url: settingsUrl,
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/owned",
    };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/json/new") {
        return new Response(
          JSON.stringify({ ...target, url: decodeURIComponent(url.search.slice(1)) }),
        );
      }
      throw new Error(`unexpected ${url}`);
    });
    const cdp = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch: fetch as typeof globalThis.fetch,
    });
    expect(() => cdp.assertAllowedCommand("Runtime.evaluate", {})).toThrow(/forbidden/);
    expect(() => cdp.assertAllowedCommand("Page.navigate", { url: settingsUrl })).toThrow(
      /owned settings target/,
    );
    await cdp.openOwnedSettingsTarget("asdk_app_exact");
    expect(() =>
      cdp.assertAllowedCommand("Page.navigate", { url: settingsUrl }, "owned"),
    ).not.toThrow();
    expect(() =>
      cdp.assertAllowedCommand("Page.navigate", { url: CHATGPT_APP_SETTINGS_URL }, "owned"),
    ).not.toThrow();
    expect(() =>
      cdp.assertAllowedCommand(
        "Runtime.evaluate",
        {
          expression: CHATGPT_OPEN_PLUGINS_SETTINGS_EXPRESSION,
          returnByValue: true,
          awaitPromise: false,
        },
        "owned",
      ),
    ).not.toThrow();
    expect(() =>
      cdp.assertAllowedCommand("Runtime.evaluate", {
        expression: ORACLE_APPROVAL_CONTROL_SNAPSHOT_EXPRESSION,
        returnByValue: true,
        awaitPromise: false,
      }),
    ).not.toThrow();
    expect(() =>
      cdp.assertAllowedCommand("Runtime.callFunctionOn", {
        objectId: "document-object",
        functionDeclaration: ORACLE_APPROVAL_CONTROL_POINT_FUNCTION,
        arguments: [{ value: "oa-0" }, { value: "oracle-v2-7" }, { value: "OmniCodex" }],
        returnByValue: true,
        awaitPromise: false,
      }),
    ).not.toThrow();
    expect(() => cdp.assertAllowedCommand("Input.insertText", { text: "message" })).toThrow(
      /forbidden/,
    );
    expect(() =>
      cdp.assertAllowedCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter" }),
    ).toThrow(/forbidden/);
    expect(() =>
      cdp.assertAllowedCommand(
        "Runtime.evaluate",
        {
          expression: CHATGPT_SETTINGS_DOCUMENT_EXPRESSION,
          returnByValue: false,
          awaitPromise: false,
        },
        "owned",
      ),
    ).not.toThrow();
    expect(() =>
      cdp.assertAllowedCommand(
        "Runtime.callFunctionOn",
        {
          objectId: "document-object",
          functionDeclaration: CHATGPT_SETTINGS_CONTROL_SNAPSHOT_FUNCTION,
          returnByValue: true,
          awaitPromise: false,
        },
        "owned",
      ),
    ).not.toThrow();
    expect(() =>
      cdp.assertAllowedCommand(
        "Runtime.callFunctionOn",
        {
          objectId: "document-object",
          functionDeclaration: CHATGPT_SETTINGS_CONTROL_CLICK_FUNCTION,
          arguments: [{ value: "oc-0" }],
          returnByValue: true,
          awaitPromise: false,
        },
        "owned",
      ),
    ).not.toThrow();
    expect(() =>
      cdp.assertAllowedCommand(
        "Runtime.callFunctionOn",
        {
          objectId: "document-object",
          functionDeclaration: CHATGPT_SETTINGS_CONTROL_CLICK_FUNCTION,
          arguments: [{ value: "not-owned" }],
          returnByValue: true,
          awaitPromise: false,
        },
        "owned",
      ),
    ).toThrow(/bounded/);
    expect(() =>
      cdp.assertAllowedCommand("Page.navigate", { url: "https://example.com" }, "owned"),
    ).toThrow(/owned settings target/);
    expect(() => cdp.assertAllowedCommand("Page.getNavigationHistory", {}, "owned")).not.toThrow();
    expect(() => cdp.assertAllowedCommand("Page.getNavigationHistory", {})).toThrow(/exact owned/);
    expect(() =>
      cdp.assertAllowedCommand(
        "Accessibility.queryAXTree",
        { nodeId: 7, role: "checkbox" },
        "owned",
      ),
    ).not.toThrow();
    expect(() =>
      cdp.assertAllowedCommand("Accessibility.queryAXTree", { nodeId: 7, role: "checkbox" }),
    ).toThrow(/bounded accessibility control/);
  });

  it("allows only the fixed server-approval program on its exact owned runtime target", async () => {
    const connectorId = "asdk_app_exact";
    const connectorName = "OmniCodex";
    const target = {
      id: "approval-runtime",
      type: "page",
      url: "about:blank?omnicodex_target=00000000-0000-4000-8000-000000000001",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/approval-runtime",
    };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/json/new") {
        return new Response(
          JSON.stringify({ ...target, url: decodeURIComponent(url.search.slice(1)) }),
        );
      }
      throw new Error(`unexpected ${url}`);
    });
    const transport = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch: fetch as typeof globalThis.fetch,
    });
    await transport.openOwnedApprovalRuntimeTarget(connectorId, connectorName);
    const principalRead = {
      expression: ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION,
      returnByValue: true,
      awaitPromise: false,
    };
    expect(() =>
      transport.assertAllowedCommand("Runtime.evaluate", principalRead, target.id),
    ).not.toThrow();
    expect(() =>
      transport.assertAllowedCommand("Runtime.evaluate", principalRead, "another-target"),
    ).toThrow();
    expect(() =>
      transport.assertAllowedCommand(
        "Page.navigate",
        { url: oracleChatGptApprovalRuntimeUrl(connectorId) },
        target.id,
      ),
    ).not.toThrow();
    expect(() =>
      transport.assertAllowedCommand(
        "Runtime.evaluate",
        {
          expression: ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION,
          returnByValue: true,
          awaitPromise: false,
        },
        target.id,
      ),
    ).not.toThrow();
    expect(() =>
      transport.assertAllowedCommand(
        "Runtime.evaluate",
        {
          expression: oracleChatGptServerApprovalScanExpression(connectorId, connectorName),
          returnByValue: true,
          awaitPromise: true,
        },
        target.id,
      ),
    ).not.toThrow();
    expect(() =>
      transport.assertAllowedCommand(
        "Runtime.evaluate",
        {
          expression: `${oracleChatGptServerApprovalScanExpression(connectorId, connectorName)} `,
          returnByValue: true,
          awaitPromise: true,
        },
        target.id,
      ),
    ).toThrow(/fixed Oracle operations/);
  });
  it("adopts one exact approval runtime and reclaims only exact duplicates", async () => {
    const connectorId = "asdk_app_exact";
    const connectorName = "OmniCodex";
    const first = {
      id: "approval-a",
      type: "page",
      url: oracleChatGptApprovalRuntimeUrl(connectorId),
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/approval-a",
    };
    const duplicate = {
      ...first,
      id: "approval-b",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/approval-b",
    };
    const unrelated = {
      ...first,
      id: "user-page",
      url: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789012",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/user-page",
    };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/json/list") {
        return new Response(JSON.stringify([duplicate, unrelated, first]));
      }
      if (url.pathname === "/json/close/approval-b") return new Response("{}", { status: 200 });
      throw new Error(`unexpected ${url}`);
    });
    const transport = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(
      transport.adoptOrOpenOwnedApprovalRuntimeTarget(connectorId, connectorName),
    ).resolves.toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(() =>
      transport.assertAllowedCommand(
        "Runtime.evaluate",
        {
          expression: oracleChatGptServerApprovalScanExpression(connectorId, connectorName),
          returnByValue: true,
          awaitPromise: true,
        },
        first.id,
      ),
    ).not.toThrow();
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
    expect(() =>
      cdp.assertAllowedCommand("Runtime.callFunctionOn", {
        objectId: "document-object",
        functionDeclaration: CHATGPT_OPEN_PLUGINS_SETTINGS_FUNCTION,
        returnByValue: true,
        awaitPromise: false,
      }),
    ).not.toThrow();
  });

  it("uses the indexed app-scoped control and dispatches one trusted approval click", async () => {
    class ApprovalButtonSocket extends ManualSocket {
      readonly methods: string[] = [];
      override send(data: string) {
        super.send(data);
        const request = JSON.parse(data) as {
          id: number;
          method: string;
          params?: Record<string, unknown>;
        };
        this.methods.push(request.method);
        const result =
          request.method === "Runtime.evaluate" &&
          request.params?.expression === ORACLE_APPROVAL_CONTROL_SNAPSHOT_EXPRESSION
            ? {
                result: {
                  value: {
                    revision: "oracle-v2-1",
                    implementation: 10,
                    responseInProgress: false,
                    documentReady: true,
                    controls: [
                      {
                        ref: "oa-0",
                        role: "button",
                        name: "Always allow",
                        visible: true,
                        exactAppScope: true,
                        scopeText: "OmniCodex needs approval",
                      },
                    ],
                  },
                },
              }
            : request.method === "Runtime.evaluate" &&
                request.params?.expression === CHATGPT_SETTINGS_DOCUMENT_EXPRESSION
              ? { result: { objectId: "approval-document" } }
              : request.method === "Runtime.callFunctionOn" &&
                  request.params?.functionDeclaration === ORACLE_APPROVAL_CONTROL_POINT_FUNCTION
                ? { result: { value: true } }
                : {};
        queueMicrotask(() => this.emit(JSON.stringify({ id: request.id, result })));
      }
    }
    const socket = new ApprovalButtonSocket();
    const session = await connectedSession(socket);
    const binding = {
      appConnectorId: "connector",
      appName: "OmniCodex",
      oracleRunId: "exact-run-id",
      sessionId: "session",
      correlationId: "correlation",
      mcpServerResource: "https://mcp.example/mcp",
      mcpSurface: "/mcp/full",
    };

    const surface = new CdpChatGptApprovalSurface(session, binding, "Native tool result ready");
    const snapshot = await surface.approvalControlSnapshot(new Set(["always allow"]));
    expect(snapshot.nodes).toEqual([
      expect.objectContaining({ ref: "oa-0", name: "Always allow", exactAppScope: true }),
    ]);
    await surface.activate("oa-0", snapshot.domRevision);
    const scan = socket.sent
      .map((entry) => JSON.parse(entry) as { method: string; params?: unknown })
      .find(
        (entry) =>
          entry.method === "Runtime.evaluate" &&
          (entry.params as { expression?: unknown } | undefined)?.expression ===
            ORACLE_APPROVAL_CONTROL_SNAPSHOT_EXPRESSION,
      );
    expect(scan).toBeDefined();
    expect(socket.sent.some((entry) => JSON.parse(entry).method === "DOM.performSearch")).toBe(
      false,
    );
    expect(socket.methods).not.toContain("Input.dispatchMouseEvent");
    expect(
      socket.sent.some(
        (entry) =>
          (JSON.parse(entry) as { params?: { functionDeclaration?: string } }).params
            ?.functionDeclaration === "function(){this.click()}",
      ),
    ).toBe(false);
    session.close();
  });

  it.each(["OmniCodex", "omnicodex2", "Work tools"])(
    "falls back to the browser DOM agent for %s when the indexed renderer snapshot fails",
    async (appName) => {
      class RendererStalledApprovalSocket extends ManualSocket {
        readonly methods: string[] = [];
        scopeName = appName;
        override send(data: string) {
          super.send(data);
          const request = JSON.parse(data) as {
            id: number;
            method: string;
            params?: Record<string, unknown>;
          };
          this.methods.push(request.method);
          if (request.method === "Runtime.evaluate") {
            queueMicrotask(() =>
              this.emit(
                JSON.stringify({
                  id: request.id,
                  error: { message: "CDP command timeout:Runtime.evaluate" },
                }),
              ),
            );
            return;
          }
          const result = (() => {
            if (request.method === "DOM.performSearch") {
              return {
                searchId: String(request.params?.query).includes(".//button")
                  ? "approval-scope-search"
                  : "approval-button-search",
                resultCount: String(request.params?.query).includes(".//button") ? 1 : 2,
              };
            }
            if (request.method === "DOM.getSearchResults") {
              return {
                nodeIds: request.params?.searchId === "approval-scope-search" ? [41] : [42, 43],
              };
            }
            if (request.method === "DOM.getAttributes")
              return { attributes: ["aria-label", "허용하기"] };
            if (request.method === "DOM.querySelectorAll") return { nodeIds: [42] };
            if (request.method === "DOM.getOuterHTML") {
              if (request.params?.nodeId === 41) {
                return {
                  outerHTML: `<div role="dialog">${this.scopeName} 파일 생성을 허용할까요?<button>허용하기</button></div>`,
                };
              }
              return { outerHTML: '<button aria-label="허용하기">허용하기</button>' };
            }
            if (request.method === "DOM.getBoxModel") {
              return { model: { content: [100, 200, 180, 200, 180, 240, 100, 240] } };
            }
            if (request.method === "DOM.resolveNode") {
              return { object: { objectId: "approval-button" } };
            }
            return {};
          })();
          queueMicrotask(() => this.emit(JSON.stringify({ id: request.id, result })));
        }
      }
      const socket = new RendererStalledApprovalSocket();
      const session = await connectedSession(socket);
      const surface = new CdpChatGptApprovalSurface(
        session,
        {
          appConnectorId: "connector",
          appName,
          oracleRunId: "exact-run-id",
          sessionId: "session",
          correlationId: "correlation",
          mcpServerResource: "https://mcp.example/mcp",
          mcpSurface: "/mcp/full",
        },
        "Native tool result ready",
      );

      const snapshot = await surface.approvalControlSnapshot(new Set(["허용하기"]));
      expect(snapshot).toMatchObject({
        domRevision: "oracle-dom-1",
        nodes: [{ ref: "od-0", name: "허용하기", exactAppScope: true }],
      });
      expect(snapshot.nodes).toHaveLength(1);
      await surface.activate("od-0", snapshot.domRevision);
      expect(socket.methods).toEqual(
        expect.arrayContaining([
          "DOM.performSearch",
          "DOM.getSearchResults",
          "DOM.getBoxModel",
          "DOM.resolveNode",
          "DOM.discardSearchResults",
        ]),
      );
      expect(socket.methods).not.toContain("Input.dispatchMouseEvent");
      expect(socket.methods).toContain("Runtime.evaluate");
      expect(socket.methods).toContain("Runtime.callFunctionOn");
      socket.scopeName = `${appName}Other`;
      const clicksBefore = socket.methods.filter(
        (method) => method === "Runtime.callFunctionOn",
      ).length;
      await expect(surface.activate("od-0", snapshot.domRevision)).rejects.toThrow(
        "STALE_DOM_NODE",
      );
      expect(socket.methods.filter((method) => method === "Runtime.callFunctionOn")).toHaveLength(
        clicksBefore,
      );
      session.close();
    },
  );

  it("reinstalls the approval owner and retries an uninitialized mirror snapshot", async () => {
    class RecoveringApprovalSocket extends ManualSocket {
      snapshotReads = 0;
      ownerClaims = 0;
      override send(data: string) {
        super.send(data);
        const request = JSON.parse(data) as {
          id: number;
          method: string;
          params?: { expression?: string };
        };
        let result: unknown = {};
        if (
          request.method === "Runtime.evaluate" &&
          request.params?.expression === ORACLE_APPROVAL_CONTROL_SNAPSHOT_EXPRESSION
        ) {
          this.snapshotReads += 1;
          result =
            this.snapshotReads === 1
              ? { result: { value: undefined } }
              : {
                  result: {
                    value: {
                      revision: "oracle-v2-2",
                      implementation: 10,
                      responseInProgress: false,
                      documentReady: true,
                      controls: [
                        {
                          ref: "oa-0",
                          role: "button",
                          name: "Allow",
                          visible: true,
                          exactAppScope: true,
                          scopeText: "OmniCodex needs approval to create one file",
                        },
                      ],
                    },
                  },
                };
        } else if (
          request.method === "Runtime.evaluate" &&
          request.params?.expression === ORACLE_APPROVAL_OWNER_CLAIM_EXPRESSION
        ) {
          this.ownerClaims += 1;
          result = {
            result: {
              value: { owner: "omnicodex-daemon/v1", replacedOracleWatcher: false },
            },
          };
        }
        queueMicrotask(() => this.emit(JSON.stringify({ id: request.id, result })));
      }
    }
    const socket = new RecoveringApprovalSocket();
    const session = await connectedSession(socket);
    const surface = new CdpChatGptApprovalSurface(
      session,
      {
        appConnectorId: "connector",
        appName: "OmniCodex",
        oracleRunId: "exact-run-id",
        sessionId: "session",
        correlationId: "correlation",
        mcpServerResource: "https://mcp.example/mcp",
        mcpSurface: "/mcp/full",
      },
      "Native tool result ready",
    );

    await expect(surface.hasPotentialApprovalControl(new Set(["allow"]))).resolves.toBe(true);
    expect(socket.snapshotReads).toBe(2);
    expect(socket.ownerClaims).toBe(1);
    session.close();
  });

  it("inspects an exact approval popup without indexing its accessibility tree", async () => {
    class ApprovalPopupSocket extends ManualSocket {
      readonly methods: string[] = [];
      override send(data: string) {
        super.send(data);
        const request = JSON.parse(data) as {
          id: number;
          method: string;
        };
        this.methods.push(request.method);
        const result =
          request.method === "Runtime.evaluate"
            ? {
                result: {
                  value: {
                    revision: "oracle-v2-1",
                    implementation: 10,
                    responseInProgress: false,
                    documentReady: true,
                    controls: [
                      {
                        ref: "oa-0",
                        role: "button",
                        name: "Always allow",
                        visible: true,
                        exactAppScope: true,
                        scopeText: "Allow ChatGPT to use OmniCodex?",
                      },
                    ],
                  },
                },
              }
            : {};
        queueMicrotask(() => this.emit(JSON.stringify({ id: request.id, result })));
      }
    }
    const socket = new ApprovalPopupSocket();
    const session = await connectedSession(socket);
    const binding = {
      appConnectorId: "connector",
      appName: "OmniCodex",
      oracleRunId: "exact-run-id",
      sessionId: "session",
      correlationId: "correlation",
      mcpServerResource: "https://mcp.example/mcp",
      mcpSurface: "/mcp/full",
    };

    await expect(
      new CdpChatGptApprovalSurface(
        session,
        binding,
        "Native tool result ready",
      ).approvalControlSnapshot(new Set(["always allow"])),
    ).resolves.toMatchObject({
      nodes: [
        {
          ref: "oa-0",
          name: "Always allow",
          exactAppScope: true,
          scopeText: "Allow ChatGPT to use OmniCodex?",
          selectorClass: "accessible-role-name",
        },
      ],
    });
    expect(socket.methods).toContain("Runtime.evaluate");
    expect(socket.methods).not.toContain("Runtime.callFunctionOn");
    expect(socket.methods).not.toContain("DOM.performSearch");
    expect(socket.methods).not.toContain("Accessibility.queryAXTree");
    session.close();
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
                nodeId: "scope",
                backendDOMNodeId: 0,
                role: { value: "dialog" },
                name: { value: "OmniCodex approval r" },
                childIds: ["context-app", "context-run", `n${this.state}`],
              },
              {
                nodeId: "context-app",
                backendDOMNodeId: 1,
                parentId: "scope",
                role: { value: "text" },
                name: { value: "OmniCodex" },
              },
              {
                nodeId: "context-run",
                backendDOMNodeId: 2,
                parentId: "scope",
                role: { value: "text" },
                name: { value: "r" },
              },
              {
                nodeId: `n${this.state}`,
                backendDOMNodeId: 10 + this.state,
                parentId: "scope",
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
      new CdpChatGptApprovalSurface(session, binding, "Native tool result ready").snapshot(),
    ).rejects.toThrow("CHATGPT_TARGET_BINDING_MISMATCH");
    session.close();
  });
  it("recognizes the current combined app connection and full-access consent sheet", async () => {
    class CurrentRiskSocket extends ManualSocket {
      override send(data: string) {
        super.send(data);
        const request = JSON.parse(data) as { id: number; method: string };
        const result =
          request.method === "Accessibility.getFullAXTree"
            ? {
                nodes: [
                  {
                    nodeId: "scope",
                    backendDOMNodeId: 1,
                    role: { value: "dialog" },
                    name: { value: "Allow ChatGPT to use OmniCodex? exact-run-id" },
                    childIds: ["full"],
                  },
                  {
                    nodeId: "full",
                    backendDOMNodeId: 2,
                    parentId: "scope",
                    role: { value: "button" },
                    name: { value: "Allow all actions" },
                  },
                ],
              }
            : {};
        queueMicrotask(() => this.emit(JSON.stringify({ id: request.id, result })));
      }
    }
    const socket = new CurrentRiskSocket();
    const session = await connectedSession(socket);
    const binding = {
      appConnectorId: "connector",
      appName: "OmniCodex",
      oracleRunId: "exact-run-id",
      sessionId: "session",
      correlationId: "correlation",
      mcpServerResource: "https://mcp.example/mcp",
      mcpSurface: "/mcp/full",
    };
    const snapshot = await new CdpChatGptApprovalSurface(
      session,
      binding,
      "Native tool result ready",
    ).snapshot();
    expect(snapshot).toMatchObject({ connected: false, alwaysAllowed: false });
    session.close();
  });
  it("does not scope a matching approval label from an unrelated dialog", async () => {
    class UnrelatedDialogSocket extends ManualSocket {
      override send(data: string) {
        super.send(data);
        const request = JSON.parse(data) as { id: number; method: string };
        const result =
          request.method === "Accessibility.getFullAXTree"
            ? {
                nodes: [
                  {
                    nodeId: "app-scope",
                    backendDOMNodeId: 1,
                    role: { value: "dialog" },
                    name: { value: "OmniCodex exact-run-id" },
                  },
                  {
                    nodeId: "other-scope",
                    backendDOMNodeId: 2,
                    role: { value: "dialog" },
                    name: { value: "Another application" },
                    childIds: ["other-allow"],
                  },
                  {
                    nodeId: "other-allow",
                    backendDOMNodeId: 3,
                    parentId: "other-scope",
                    role: { value: "button" },
                    name: { value: "Always allow" },
                  },
                ],
              }
            : {};
        queueMicrotask(() => this.emit(JSON.stringify({ id: request.id, result })));
      }
    }
    const socket = new UnrelatedDialogSocket();
    const session = await connectedSession(socket);
    const binding = {
      appConnectorId: "connector",
      appName: "OmniCodex",
      oracleRunId: "exact-run-id",
      sessionId: "session",
      correlationId: "correlation",
      mcpServerResource: "https://mcp.example/mcp",
      mcpSurface: "/mcp/full",
    };
    const snapshot = await new CdpChatGptApprovalSurface(
      session,
      binding,
      "Native tool result ready",
    ).snapshot();
    expect(snapshot).toMatchObject({ connected: true, alwaysAllowed: true });
    expect(snapshot.nodes.find((node) => node.ref === "other-allow")?.exactAppScope).toBe(false);
    session.close();
  });
  it("keeps the complete app subtree beyond the former node and 8192-character cutoffs", async () => {
    const fillerNodes = Array.from({ length: 300 }, (_, index) => ({
      nodeId: `filler-${String(index)}`,
      backendDOMNodeId: index + 2,
      parentId: "scope",
      role: { value: "text" },
      name: { value: `filler-${String(index)}-${"x".repeat(40)}` },
    }));
    const terminalMarker = {
      nodeId: "terminal-marker",
      backendDOMNodeId: 400,
      parentId: "scope",
      role: { value: "text" },
      name: { value: "OmniCodex exact-run-id" },
    };
    const allow = {
      nodeId: "allow",
      backendDOMNodeId: 401,
      parentId: "scope",
      role: { value: "button" },
      name: { value: "Always allow" },
    };
    const scope = {
      nodeId: "scope",
      backendDOMNodeId: 1,
      role: { value: "dialog" },
      name: { value: "approval scope" },
      childIds: [...fillerNodes.map((node) => node.nodeId), terminalMarker.nodeId, allow.nodeId],
    };
    class LargeScopeSocket extends ManualSocket {
      override send(data: string) {
        super.send(data);
        const request = JSON.parse(data) as { id: number; method: string };
        const result =
          request.method === "Accessibility.getFullAXTree"
            ? { nodes: [scope, ...fillerNodes, terminalMarker, allow] }
            : {};
        queueMicrotask(() => this.emit(JSON.stringify({ id: request.id, result })));
      }
    }
    const socket = new LargeScopeSocket();
    const session = await connectedSession(socket);
    const binding = {
      appConnectorId: "connector",
      appName: "OmniCodex",
      oracleRunId: "exact-run-id",
      sessionId: "session",
      correlationId: "correlation",
      mcpServerResource: "https://mcp.example/mcp",
      mcpSurface: "/mcp/full",
    };

    const snapshot = await new CdpChatGptApprovalSurface(
      session,
      binding,
      "Native tool result ready",
    ).snapshot();
    const allowNode = snapshot.nodes.find((node) => node.ref === "allow");
    expect(allowNode?.exactAppScope).toBe(true);
    expect(allowNode?.scopeText?.length).toBeGreaterThan(8_192);
    expect(allowNode?.scopeText).toContain("OmniCodex exact-run-id");
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
    const firstController = new AbortController();
    const first = oversized.command("DOM.getDocument", {}, firstController.signal);
    const second = oversized.command("Accessibility.getFullAXTree", {});
    const firstRejection = expect(first).rejects.toThrow(
      "CDP_FRAME_OVERSIZED:received=9:maximum=8:pending=Accessibility.getFullAXTree,DOM.getDocument",
    );
    const secondRejection = expect(second).rejects.toThrow(
      "CDP_FRAME_OVERSIZED:received=9:maximum=8:pending=Accessibility.getFullAXTree,DOM.getDocument",
    );
    socket.emit("123456789");
    await Promise.all([firstRejection, secondRejection]);
    firstController.abort();
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "oversized-frame" }]);
    await expect(oversized.command("DOM.getDocument", {})).rejects.toThrow("CDP session closed");
  });
  it("waits without the former implicit five-second command timeout", async () => {
    const socket = new ManualSocket();
    const session = await connectedSession(socket);
    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = session.command("DOM.getDocument", {});
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await vi.advanceTimersByTimeAsync(5_001);
      expect(settled).toBe(false);
      socket.emit(JSON.stringify({ id: 1, result: { complete: true } }));
      await expect(pending).resolves.toEqual({ complete: true });
    } finally {
      vi.useRealTimers();
      session.close();
    }
  });
  it.each(["session", "command"] as const)(
    "allows an explicit no-deadline %s and preserves parent cancellation",
    async (mode) => {
      const socket = new ManualSocket();
      const session = await connectedSession(socket, mode === "session" ? { timeoutMs: null } : {});
      const controller = new AbortController();
      vi.useFakeTimers();
      try {
        const pending = session.command(
          "DOM.getDocument",
          {},
          controller.signal,
          mode === "command" ? null : undefined,
        );
        const rejection = expect(pending).rejects.toThrow("CDP command cancelled:DOM.getDocument");
        await vi.advanceTimersByTimeAsync(120_000);
        expect(socket.closeCalls).toEqual([]);
        controller.abort(new Error("parent cancelled"));
        await rejection;
        socket.emit(JSON.stringify({ id: 1, result: { late: true } }));
        expect(socket.closeCalls).toEqual([]);
      } finally {
        vi.useRealTimers();
        session.close();
      }
    },
  );
  it("admits native send only on the preflight-bound Desktop app page", async () => {
    const transport = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      allowDesktopAppTargets: true,
    });
    const attemptId = "12345678-1234-4234-8234-123456789012";
    const expression = `(${DESKTOP_NATIVE_SEND_SOURCE})(${JSON.stringify({ operation: "prepare", conversationId: "conversation-1", prompt: "continue", attemptId })})`;
    const params = { expression, awaitPromise: true, returnByValue: true };
    expect(() => transport.assertAllowedCommand("Runtime.evaluate", params, "desktop")).toThrow();
    await transport.preflight(undefined, "desktop", {
      id: "desktop",
      type: "page",
      url: "app://-/index.html",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/desktop",
    });
    expect(() =>
      transport.assertAllowedCommand("Runtime.evaluate", params, "desktop"),
    ).not.toThrow();
    for (const change of [
      { awaitPromise: false },
      { returnByValue: false },
      { expression: `${expression};fetch('/other')` },
    ])
      expect(() =>
        transport.assertAllowedCommand("Runtime.evaluate", { ...params, ...change }, "desktop"),
      ).toThrow();
    await transport.preflight(undefined, "web", {
      id: "web",
      type: "page",
      url: "https://chatgpt.com/c/conversation-1",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/web",
    });
    expect(() => transport.assertAllowedCommand("Runtime.evaluate", params, "web")).toThrow();
    for (const action of ["cancel", "release"]) {
      const lifecycle = {
        expression: `(${DESKTOP_NATIVE_SEND_LIFECYCLE_SOURCE})(${JSON.stringify({ attemptId, action })})`,
        awaitPromise: true,
        returnByValue: true,
      };
      expect(() =>
        transport.assertAllowedCommand("Runtime.evaluate", lifecycle, "desktop"),
      ).not.toThrow();
      expect(() => transport.assertAllowedCommand("Runtime.evaluate", lifecycle, "web")).toThrow();
    }
    const plain = new ChatGptLoopbackCdpTransport({ endpoint: "http://127.0.0.1:9222" });
    expect(() => plain.assertAllowedCommand("Runtime.evaluate", params, "desktop")).toThrow();
  });

  it("admits only the exact Desktop reader and cancellation templates", () => {
    const transport = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      allowDesktopAppTargets: true,
    });
    const plain = new ChatGptLoopbackCdpTransport({ endpoint: "http://127.0.0.1:9222" });
    const token = "12345678-1234-4234-8234-123456789012";
    const reader = `(${DESKTOP_EXACT_CONVERSATION_READER})("conversation-1", "${token}")`;
    const cancel = `(() => { const r = globalThis.__omnicodexDesktopExactReadOperations ??= new Map(); const c = r.get("${token}"); if (c) c.abort(); else r.set("${token}", { signal: { aborted: true } }); })()`;
    for (const expression of [reader, cancel]) {
      const params = { expression, awaitPromise: true, returnByValue: true };
      expect(() =>
        transport.assertAllowedCommand("Runtime.evaluate", params, "desktop"),
      ).not.toThrow();
      expect(() => plain.assertAllowedCommand("Runtime.evaluate", params, "desktop")).toThrow();
      expect(() => transport.assertAllowedCommand("Runtime.evaluate", params)).toThrow();
      expect(() =>
        transport.assertAllowedCommand(
          "Runtime.evaluate",
          { ...params, expression: `${expression};fetch('/other')` },
          "desktop",
        ),
      ).toThrow();
      expect(() =>
        transport.assertAllowedCommand(
          "Runtime.evaluate",
          { ...params, awaitPromise: false },
          "desktop",
        ),
      ).toThrow();
    }
  });
  it("rejects a silent command at the default liveness lease without closing the session", async () => {
    const socket = new ManualSocket();
    const session = await connectedSession(socket);
    vi.useFakeTimers();
    try {
      const pending = session.command("DOM.getDocument", {});
      const rejection = expect(pending).rejects.toThrow("CDP command timeout:DOM.getDocument");
      await vi.advanceTimersByTimeAsync(DEFAULT_CDP_COMMAND_LIVENESS_TIMEOUT_MS);
      await rejection;
      expect(socket.closeCalls).toEqual([]);
    } finally {
      vi.useRealTimers();
      session.close();
    }
  });
  it("does not impose the former sixteen-command pending limit", async () => {
    const socket = new ManualSocket();
    const session = await connectedSession(socket);
    const pending = Array.from({ length: 32 }, () => session.command("DOM.getDocument", {}));
    for (let id = 1; id <= pending.length; id += 1) {
      socket.emit(JSON.stringify({ id, result: { id } }));
    }
    await expect(Promise.all(pending)).resolves.toEqual(
      Array.from({ length: 32 }, (_, index) => ({ id: index + 1 })),
    );
    session.close();
  });
  it("preserves the complete CDP error code, message, data, cause, and payload", async () => {
    const socket = new ManualSocket();
    const session = await connectedSession(socket);
    const pending = session.command("DOM.getDocument", {});
    const payload = {
      code: -32_001,
      message: `native failure\n${"diagnostic".repeat(1_000)}`,
      data: { retryable: false, nested: [1, 2, 3] },
    };
    socket.emit(JSON.stringify({ id: 1, error: payload }));

    const error = await pending.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(CdpProtocolError);
    expect(error).toMatchObject({
      message: `DOM.getDocument: ${payload.message}`,
      code: payload.code,
      data: payload.data,
      payload,
      cause: payload,
    });
    session.close();
  });
  it("accepts a catalog frame above the former 64 MiB default when no cap is requested", async () => {
    const observedFrameBytes = 64 * 1024 * 1024 + 1;
    const socket = new ManualSocket();
    const session = await connectedSession(socket, { timeoutMs: 30_000 });
    const pending = session.command("DOM.getDocument", {});
    const emptyFrame = JSON.stringify({ id: 1, result: { payload: "" } });
    const frame = JSON.stringify({
      id: 1,
      result: { payload: "x".repeat(observedFrameBytes - Buffer.byteLength(emptyFrame)) },
    });
    expect(Buffer.byteLength(frame)).toBe(observedFrameBytes);

    socket.emit(frame);
    const result = (await pending) as { payload: string };
    expect(result.payload.length).toBe(observedFrameBytes - Buffer.byteLength(emptyFrame));
    expect(socket.closeCalls).toEqual([]);
    session.close();
  });
  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid CDP frame budget %s before opening a connection",
    async (maxFrameBytes) => {
      const fetch = vi.fn();
      const factory = vi.fn();
      const transport = new ChatGptLoopbackCdpTransport({
        endpoint: "http://127.0.0.1:9222",
        fetch,
      });

      await expect(
        BoundedCdpSession.connect(transport, { factory, maxFrameBytes }),
      ).rejects.toThrow("CDP_FRAME_BUDGET_INVALID");
      expect(fetch).not.toHaveBeenCalled();
      expect(factory).not.toHaveBeenCalled();
    },
  );
  it("accepts a response exactly at a configured frame boundary", async () => {
    const socket = new ManualSocket();
    const exactFrame = JSON.stringify({ id: 1, result: {} });
    const session = await connectedSession(socket, {
      maxFrameBytes: Buffer.byteLength(exactFrame),
    });
    const pending = session.command("DOM.getDocument", {});
    socket.emit(exactFrame);
    await expect(pending).resolves.toEqual({});
    expect(socket.closeCalls).toEqual([]);
    session.close();
  });
  it("closes on unexpected or duplicate response ids", async () => {
    const socket = new ManualSocket();
    const session = await connectedSession(socket);
    const pending = session.command("DOM.getDocument", {});
    socket.emit(JSON.stringify({ id: 999, result: {} }));
    await expect(pending).rejects.toThrow("CDP_RESPONSE_ID_UNEXPECTED");
  });
  it("keeps live commands connected when a cancelled command replies late", async () => {
    const socket = new ManualSocket();
    const session = await connectedSession(socket);
    const controller = new AbortController();
    const cancelled = session.command("DOM.getDocument", {}, controller.signal);
    const cancellation = expect(cancelled).rejects.toThrow("CDP command cancelled:DOM.getDocument");
    const ongoing = session.command("DOM.getDocument", {});
    controller.abort();
    await cancellation;
    socket.emit(JSON.stringify({ id: 1, result: { cancelledCallerResult: true } }));
    expect(socket.closeCalls).toEqual([]);
    socket.emit(JSON.stringify({ id: 2, result: { current: true } }));
    await expect(ongoing).resolves.toEqual({ current: true });
    // Only the one expected late reply is tolerated, not a duplicate.
    const next = session.command("DOM.getDocument", {});
    socket.emit(JSON.stringify({ id: 1, result: {} }));
    await expect(next).rejects.toThrow("CDP_RESPONSE_ID_UNEXPECTED");
  });
  it("isolates a command timeout, ignores its late reply once, and never replays it", async () => {
    const socket = new ManualSocket();
    const session = await connectedSession(socket);
    vi.useFakeTimers();
    try {
      const timed = session.command("DOM.getDocument", {}, undefined, 5);
      const rejection = expect(timed).rejects.toThrow("CDP command timeout:DOM.getDocument");
      const ongoing = session.command("DOM.getDocument", {}, undefined, 100);
      await vi.advanceTimersByTimeAsync(5);
      await rejection;
      expect(session.isClosed).toBe(false);
      expect(socket.closeCalls).toEqual([]);
      expect(socket.sent).toHaveLength(2);
      socket.emit(JSON.stringify({ id: 1, result: { late: true } }));
      socket.emit(JSON.stringify({ id: 2, result: { ongoing: true } }));
      await expect(ongoing).resolves.toEqual({ ongoing: true });
      const subsequent = session.command("DOM.getDocument", {});
      socket.emit(JSON.stringify({ id: 3, result: { subsequent: true } }));
      await expect(subsequent).resolves.toEqual({ subsequent: true });
      expect(socket.sent.map((message) => JSON.parse(message).id)).toEqual([1, 2, 3]);
      expect(socket.closeCalls).toEqual([]);
      // The tombstone admits one late response, not arbitrary duplicate ids.
      const duplicateWitness = session.command("DOM.getDocument", {});
      socket.emit(JSON.stringify({ id: 1, result: {} }));
      await expect(duplicateWitness).rejects.toThrow("CDP_RESPONSE_ID_UNEXPECTED");
      expect(session.isClosed).toBe(true);
    } finally {
      session.close();
      vi.useRealTimers();
    }
  });
  it.each(["close", "error"] as const)(
    "exposes terminal socket %s without replaying pending work",
    async (event) => {
      const socket = new ManualSocket();
      const session = await connectedSession(socket);
      expect(session.isClosed).toBe(false);
      const pending = session.command("DOM.getDocument", {});
      const rejection = expect(pending).rejects.toThrow(
        event === "close" ? "CDP_SESSION_CLOSED" : "CDP_SESSION_ERROR",
      );
      for (const listener of socket.listeners.get(event) ?? []) listener({});
      await rejection;
      expect(session.isClosed).toBe(true);
      await expect(session.command("DOM.getDocument", {})).rejects.toThrow("CDP session closed");
      expect(socket.sent).toHaveLength(1);
    },
  );
});
