import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { OwnerBoundResourceStore } from "../src/infrastructure/mcp/owner-bound-resource-store.js";
import {
  type HttpAuthorizationDecision,
  type HttpAuthorizationIdentity,
  StreamableHttpGateway,
} from "../src/infrastructure/mcp/streamable-http-gateway.js";

const metadata = {
  resource: "https://owner.example/native",
  authorization_servers: ["https://owner.us.auth0.com/"],
  scopes_supported: ["omnicodex:full"],
  bearer_methods_supported: ["header"],
};

describe("StreamableHttpGateway", () => {
  it("enforces loopback bind and exact protected-resource/CORS configuration", () => {
    const appServer = fakeAppServer().appServer;
    expect(
      () =>
        new StreamableHttpGateway({
          appServer,
          host: "0.0.0.0",
          authorize: () => authorization("owner"),
        }),
    ).toThrow("127.0.0.1");
    expect(
      () =>
        new StreamableHttpGateway({
          appServer,
          allowedOrigins: ["*"],
          authorize: () => authorization("owner"),
        }),
    ).toThrow();
    expect(
      () =>
        new StreamableHttpGateway({
          appServer,
          protectedResourceMetadata: {
            ...metadata,
            bearer_methods_supported: ["query"],
          },
          authorize: () => authorization("owner"),
        }),
    ).toThrow("headers only");
  });

  it("rejects credential, origin, host, query-token, media, body, and protocol violations", async () => {
    const fixture = fakeAppServer();
    const gateway = gatewayFor(fixture.appServer);
    const address = await gateway.start();
    const url = `http://${address.host}:${address.port}${address.path}`;
    try {
      const unauthorized = await mcpPost(url, {}, undefined);
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("www-authenticate")).toBe(
        'Bearer realm="OmniCodex", resource_metadata="https://owner.example/.well-known/oauth-protected-resource/native"',
      );

      for (const metadataPath of [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/native",
        "/.well-known/oauth-protected-resource/native/full",
      ]) {
        const response = await fetch(`http://${address.host}:${address.port}${metadataPath}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        await expect(response.json()).resolves.toMatchObject(metadata);
      }

      const queryToken = await mcpPost(`${url}?access_token=secret`, {}, "owner");
      expect(queryToken.status).toBe(400);
      const unknownOrigin = await mcpPost(url, {}, "owner", {
        Origin: "https://evil.example",
      });
      expect(unknownOrigin.status).toBe(403);
      expect(unknownOrigin.headers.get("access-control-allow-origin")).toBeNull();
      const unknownHost = await mcpPost(url, {}, "owner", { Host: "evil.example" });
      expect([400, 421]).toContain(unknownHost.status);

      const unsupportedMedia = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: "Bearer owner",
          Accept: "application/json, text/event-stream",
          "Content-Type": "text/plain",
        },
        body: "{}",
      });
      expect(unsupportedMedia.status).toBe(415);
      const oversized = await mcpPost(url, { value: "x".repeat(2 * 1024 * 1024) }, "owner");
      expect(oversized.status).toBe(413);

      const unsupportedVersion = await mcpPost(url, initializeRequest("2099-01-01"), "owner");
      expect(unsupportedVersion.status).toBe(400);
      await expect(unsupportedVersion.json()).resolves.toMatchObject({
        error: {
          code: -32600,
          data: {
            supportedProtocolVersions: [
              "2025-11-25",
              "2025-06-18",
              "2025-03-26",
              "2024-11-05",
              "2024-10-07",
            ],
          },
        },
      });
      expect(fixture.calls).toEqual([]);
    } finally {
      await gateway.stop();
    }
  });

  it("supports owner-bound compat/full initialize, list, call, notification, cancellation, and session close", async () => {
    const fixture = fakeAppServer();
    let nowUnixMs = Date.now();
    const resourceStore = new OwnerBoundResourceStore({
      defaultTtlMs: 1_000,
      maximumTtlMs: 10 * 60_000,
      nowUnixMs: () => nowUnixMs,
    });
    const gateway = gatewayFor(fixture.appServer, { resourceStore });
    const address = await gateway.start();
    const compatUrl = `http://${address.host}:${address.port}${address.path}`;
    const fullUrl = `http://${address.host}:${address.port}${address.fullPath}`;
    const compat = new TestMcpClient(compatUrl, "owner");
    const full = new TestMcpClient(fullUrl, "owner");
    try {
      await compat.connect();
      expect(compat.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const compatTools = await compat.request("tools/list", {});
      expect(toolNames(compatTools)).toEqual([
        "search_native_tools",
        "call_native_tool",
        "app_server_rpc",
      ]);

      await full.connect();
      expect(full.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const fullTools = await full.request("tools/list", {});
      expect(toolNames(fullTools)).toEqual(["large", "ping", "slow"]);
      await expect(
        full.request("tools/call", { name: "ping", arguments: {} }),
      ).resolves.toMatchObject({ content: [{ type: "text", text: "pong" }] });

      const wrongOwner = await mcpPost(
        fullUrl,
        { jsonrpc: "2.0", id: 99, method: "tools/list", params: {} },
        "other",
        { "MCP-Session-Id": full.sessionId as string, "MCP-Protocol-Version": "2025-06-18" },
      );
      expect(wrongOwner.status).toBe(404);

      const toolListChanged = full.waitForNotification("notifications/tools/list_changed");
      fixture.catalogRevision = 2;
      await gateway.refreshTools();
      await expect(toolListChanged).resolves.toMatchObject({
        method: "notifications/tools/list_changed",
      });
      const changedTools = await full.request("tools/list", {});
      expect(toolNames(changedTools)).toContain("second_revision");

      const slowRequest = full.requestWithId(50, "tools/call", {
        name: "slow",
        arguments: {},
      });
      await fixture.slowStarted;
      await full.notify("notifications/cancelled", { requestId: 50, reason: "test cancellation" });
      fixture.releaseSlow();
      void slowRequest.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(full.hasPendingRequest(50)).toBe(true);
      await expect(full.request("tools/list", {})).resolves.toBeDefined();

      const large = await full.request("tools/call", { name: "large", arguments: {} });
      const link = resourceLink(large);
      expect(link.uri).toMatch(/^https:\/\/owner\.example\/resources\/[A-Za-z0-9_-]{43}$/);
      const localResourceUrl = `${new URL(fullUrl).origin}${new URL(link.uri).pathname}`;
      expect((await fetch(localResourceUrl)).status).toBe(401);
      expect((await resourceFetch(localResourceUrl, "owner")).status).toBe(404);
      expect(
        (await resourceFetch(localResourceUrl, "other", full.sessionId as string)).status,
      ).toBe(404);
      const delivered = await resourceFetch(localResourceUrl, "owner", full.sessionId as string);
      expect(delivered.status).toBe(200);
      expect(delivered.headers.get("cache-control")).toBe("private, no-store");
      expect((await delivered.text()).length).toBe(256 * 1024 + 1);
      const traversal = await resourceFetch(
        `${new URL(fullUrl).origin}/resources/..%2Fsecret`,
        "owner",
        full.sessionId as string,
      );
      expect(traversal.status).toBe(404);
      nowUnixMs += 1_001;
      expect(
        (await resourceFetch(localResourceUrl, "owner", full.sessionId as string)).status,
      ).toBe(404);

      const closedSessionId = full.sessionId as string;
      await full.terminateSession();
      const afterClose = await mcpPost(
        fullUrl,
        { jsonrpc: "2.0", id: 100, method: "tools/list", params: {} },
        "owner",
        { "MCP-Session-Id": closedSessionId, "MCP-Protocol-Version": "2025-06-18" },
      );
      expect(afterClose.status).toBe(404);
    } finally {
      fixture.releaseSlow();
      await compat.close();
      await full.close();
      await gateway.stop();
    }
  });
});

function gatewayFor(
  appServer: ReturnType<typeof fakeAppServer>["appServer"],
  options: { readonly resourceStore?: OwnerBoundResourceStore } = {},
): StreamableHttpGateway {
  return new StreamableHttpGateway({
    appServer,
    path: "/native",
    fullPath: "/native/full",
    allowedOrigins: ["https://client.example"],
    protectedResourceMetadata: metadata,
    ...(options.resourceStore === undefined ? {} : { resourceStore: options.resourceStore }),
    authorize: (request) => {
      if (request.headers.authorization === "Bearer owner") return authorization("owner");
      if (request.headers.authorization === "Bearer other") return authorization("other");
      return {
        ok: false,
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="OmniCodex"' },
        message: "Unauthorized",
      };
    },
  });
}

function authorization(subject: "owner" | "other"): HttpAuthorizationDecision {
  const identity: HttpAuthorizationIdentity = {
    issuer: "https://owner.us.auth0.com/",
    subject: `auth0|${subject}`,
    clientId: "client-id",
    resource: metadata.resource,
  };
  return {
    ok: true,
    identity,
    authInfo: {
      token: `fake-${subject}-access-token`,
      clientId: identity.clientId,
      scopes: ["omnicodex:full"],
      resource: new URL(identity.resource),
      extra: { issuer: identity.issuer, subject: identity.subject },
    },
  };
}

function fakeAppServer() {
  const calls: string[] = [];
  let resolveSlowStarted: (() => void) | undefined;
  let releaseSlowCall: (() => void) | undefined;
  const slowStarted = new Promise<void>((resolve) => {
    resolveSlowStarted = resolve;
  });
  const slowResult = new Promise<void>((resolve) => {
    releaseSlowCall = resolve;
  });
  const fixture = {
    calls,
    catalogRevision: 1,
    slowStarted,
    releaseSlow: () => releaseSlowCall?.(),
    appServer: {
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push(method);
        if (method === "mcpServerStatus/list") {
          const tools: Record<string, unknown> = {
            ping: { name: "ping", inputSchema: { type: "object" } },
            slow: { name: "slow", inputSchema: { type: "object" } },
            large: { name: "large", inputSchema: { type: "object" } },
          };
          if (fixture.catalogRevision > 1) {
            tools.second_revision = {
              name: "second_revision",
              inputSchema: { type: "object" },
            };
          }
          return { data: [{ name: "demo", tools }], nextCursor: null } as T;
        }
        if (method === "thread/start") {
          return { thread: { id: "urn:uuid:ephemeral" } } as T;
        }
        if (method === "mcpServer/tool/call") {
          const tool = isObject(params) ? params.tool : undefined;
          if (tool === "ping") return { content: [{ type: "text", text: "pong" }] } as T;
          if (tool === "large") {
            return { content: [{ type: "text", text: "x".repeat(256 * 1024 + 1) }] } as T;
          }
          if (tool === "slow") {
            resolveSlowStarted?.();
            await slowResult;
            return { content: [{ type: "text", text: "late" }] } as T;
          }
          return { content: [{ type: "text", text: "second" }] } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    },
  };
  return fixture;
}

class TestMcpClient {
  readonly #transport: StreamableHTTPClientTransport;
  readonly #pending = new Map<
    number,
    { readonly resolve: (value: unknown) => void; readonly reject: (reason: unknown) => void }
  >();
  readonly #notificationWaiters = new Map<string, (message: Record<string, unknown>) => void>();
  #nextId = 1;

  constructor(url: string, accessToken: string) {
    this.#transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    this.#transport.onmessage = (message) => this.#onMessage(message);
  }

  get sessionId(): string | undefined {
    return this.#transport.sessionId;
  }

  async connect(): Promise<void> {
    await this.#transport.start();
    await this.requestWithId(
      0,
      "initialize",
      (initializeRequest("2025-06-18") as { params: Record<string, unknown> }).params,
    );
    this.#transport.setProtocolVersion("2025-06-18");
    await this.notify("notifications/initialized", {});
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.requestWithId(this.#nextId++, method, params);
  }

  async requestWithId(
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    try {
      await this.#transport.send({ jsonrpc: "2.0", id, method, params } as JSONRPCMessage);
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
    return response;
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.#transport.send({ jsonrpc: "2.0", method, params } as JSONRPCMessage);
  }

  waitForNotification(method: string): Promise<Record<string, unknown>> {
    const notification = new Promise<Record<string, unknown>>((resolve) => {
      this.#notificationWaiters.set(method, resolve);
    });
    return Promise.race([
      notification,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Notification timeout: ${method}`)), 5_000),
      ),
    ]);
  }

  async terminateSession(): Promise<void> {
    await this.#transport.terminateSession();
  }

  hasPendingRequest(id: number): boolean {
    return this.#pending.has(id);
  }

  async close(): Promise<void> {
    await this.#transport.close();
  }

  #onMessage(message: JSONRPCMessage): void {
    if (!("id" in message) || (typeof message.id !== "number" && typeof message.id !== "string")) {
      if ("method" in message && typeof message.method === "string") {
        const waiter = this.#notificationWaiters.get(message.method);
        if (waiter !== undefined) {
          this.#notificationWaiters.delete(message.method);
          waiter(message as Record<string, unknown>);
        }
      }
      return;
    }
    const numericId = Number(message.id);
    const pending = this.#pending.get(numericId);
    if (pending === undefined) return;
    this.#pending.delete(numericId);
    if ("error" in message) pending.reject(message.error);
    else if ("result" in message) pending.resolve(message.result);
  }
}

async function mcpPost(
  url: string,
  body: unknown,
  accessToken: string | undefined,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  const value = JSON.stringify(body);
  return fetch(url, {
    method: "POST",
    headers: {
      ...(accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` }),
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...headers,
    },
    body: value,
  });
}

function initializeRequest(protocolVersion: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: { tools: { listChanged: true } },
      clientInfo: { name: "fake-owner-client", version: "1.0.0" },
    },
  };
}

async function resourceFetch(
  url: string,
  accessToken: string,
  sessionId?: string,
): Promise<Response> {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(sessionId === undefined ? {} : { "MCP-Session-Id": sessionId }),
    },
  });
}

function toolNames(value: unknown): string[] {
  if (!isObject(value) || !Array.isArray(value.tools)) throw new Error("Missing tools result");
  return value.tools.map((tool) =>
    isObject(tool) && typeof tool.name === "string" ? tool.name : "",
  );
}

function resourceLink(value: unknown): { readonly uri: string } {
  if (!isObject(value) || !Array.isArray(value.content)) throw new Error("Missing content result");
  const link = value.content.find(
    (item) => isObject(item) && item.type === "resource_link" && typeof item.uri === "string",
  );
  if (!isObject(link) || typeof link.uri !== "string") throw new Error("Missing resource link");
  return { uri: link.uri };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
