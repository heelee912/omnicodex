import { describe, expect, it, vi } from "vitest";
import {
  ChatGptActionCatalogControlClient,
  ChatGptControlPlaneHttpError,
} from "../src/infrastructure/chatgpt/chatgpt-action-catalog-control-client.js";

describe("ChatGptActionCatalogControlClient", () => {
  it("inspects the current snapshot without a refresh and preserves missing flags", async () => {
    const connectorId = "asdk_app_123abc";
    const requests: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/api/auth/session"))
        return jsonResponse({ accessToken: "secret-token", account: { id: "acct-1" } });
      if (url.endsWith("/links/list_accessible"))
        return jsonResponse({ links: [{ id: "link-1", connector_id: connectorId }] });
      if (url.endsWith(`/connectors/${connectorId}/actions`))
        return jsonResponse({
          actions: [
            {
              name: "read_file",
              params: { type: "object", properties: { path: {} }, required: ["path"] },
              is_read_only: true,
              is_destructive: false,
              is_open_world: false,
              is_consequential: false,
            },
            {
              name: "router",
              params: { type: "object", properties: {} },
              is_read_only: null,
              is_destructive: "false",
              secret: "secret-payload",
            },
          ],
        });
      throw new Error("Unexpected mutation during inspection");
    });
    const client = new ChatGptActionCatalogControlClient({
      cdpEndpoint: "http://127.0.0.1:19222",
      fetch,
      readBrowserAuth: async () => ({ cookieHeader: "session=secret", userAgent: "Chrome/Test" }),
    });
    const result = await client.inspect(connectorId, ["read_file", "router"]);
    expect(requests).toHaveLength(3);
    expect(requests.some((url) => url.endsWith("/mcp/refresh_actions"))).toBe(false);
    expect(result).not.toHaveProperty("refreshReceiptSha256");
    expect(result.actionMetadata).toEqual([
      {
        toolName: "read_file",
        isReadOnly: true,
        isDestructive: false,
        isOpenWorld: false,
        isConsequential: false,
      },
      { toolName: "router" },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("stops a read-only inspection at an actual 429 without a refresh or retry", async () => {
    const fetch = vi.fn(
      async () => new Response(null, { status: 429, headers: { "Retry-After": "90" } }),
    );
    const client = new ChatGptActionCatalogControlClient({
      cdpEndpoint: "http://127.0.0.1:19222",
      fetch,
      readBrowserAuth: async () => ({ cookieHeader: "session=secret", userAgent: "Chrome/Test" }),
    });
    await expect(client.inspect("asdk_app_123abc", [])).rejects.toMatchObject({ status: 429 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1, 2, 3])(
    "preserves an HTML 429 at request stage %s without continuing",
    async (stage) => {
      const connectorId = "asdk_app_123abc";
      const responses = [
        () => jsonResponse({ accessToken: "secret-token", account: { id: "acct-1" } }),
        () => jsonResponse({ links: [{ id: "link-1", connector_id: connectorId }] }),
        () => jsonResponse({}),
        () => jsonResponse({ actions: [] }),
      ];
      const rejected = new Response("<html>Too many requests secret-body</html>", {
        status: 429,
        headers: {
          "Retry-After": "7200",
          "x-ratelimit-remaining-requests": "0",
          "x-request-id": "request-1",
          "Set-Cookie": "secret-cookie",
        },
      });
      let index = 0;
      const fetch = vi.fn(async () => {
        const request = index++;
        if (request === stage) return rejected;
        const response = responses[request];
        if (response === undefined) throw new Error("unexpected extra request");
        return response();
      });
      const client = new ChatGptActionCatalogControlClient({
        cdpEndpoint: "http://127.0.0.1:19222",
        fetch,
        readBrowserAuth: async () => ({ cookieHeader: "session=secret", userAgent: "Chrome/Test" }),
      });
      const before = Date.now();
      const error = await client.refresh(connectorId, []).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(ChatGptControlPlaneHttpError);
      expect(error).toMatchObject({
        status: 429,
        responseHeaders: {
          "retry-after": "7200",
          "x-ratelimit-remaining-requests": "0",
          "x-request-id": "request-1",
        },
      });
      expect((error as ChatGptControlPlaneHttpError).retryAtUnixMs).toBeGreaterThanOrEqual(
        before + 7_200_000,
      );
      expect(JSON.stringify(error)).not.toContain("secret");
      expect(fetch).toHaveBeenCalledTimes(stage + 1);
      expect(rejected.body?.locked).toBe(false);
    },
  );

  it("preserves an HTTP-date Retry-After without inventing a deadline for malformed values", () => {
    const date = "Sat, 05 Sep 2026 01:00:00 GMT";
    const error = new ChatGptControlPlaneHttpError(
      "read",
      new Response(null, {
        status: 429,
        headers: { "Retry-After": date },
      }),
      Date.parse("2026-09-05T00:00:00Z"),
    );
    expect(error.retryAtUnixMs).toBe(Date.parse(date));
    const malformed = new ChatGptControlPlaneHttpError(
      "read",
      new Response(null, {
        status: 429,
        headers: { "Retry-After": "later" },
      }),
    );
    expect(malformed.retryAtUnixMs).toBeUndefined();
  });

  it("uses the official account-bound refresh contract and returns no browser credential", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const connectorId = "asdk_app_123abc";
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.endsWith("/api/auth/session")) {
        return jsonResponse({ accessToken: "secret-access-token", account: { id: "acct-1" } });
      }
      if (url.endsWith("/links/list_accessible")) {
        return jsonResponse({ links: [{ id: "link-1", connector_id: connectorId }] });
      }
      if (url.endsWith("/mcp/refresh_actions")) {
        return jsonResponse({ actions: [] });
      }
      if (url.endsWith(`/connectors/${connectorId}/actions`)) {
        return jsonResponse({
          actions: [
            {
              name: "search_native_tools",
              input_schema: JSON.stringify({
                type: "object",
                properties: { query: {}, cursor: {} },
                required: [],
              }),
            },
            { name: "codex__app_server__fs_writeFile" },
            { name: "codex__app_server__command_exec" },
          ],
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const client = new ChatGptActionCatalogControlClient({
      cdpEndpoint: "http://127.0.0.1:19222",
      fetch: fetch as typeof globalThis.fetch,
      readBrowserAuth: async () => ({
        cookieHeader: "session=secret-browser-cookie",
        userAgent: "Chrome/Test",
      }),
    });

    const receipt = await client.refresh(connectorId, ["search_native_tools"]);

    expect(receipt.actionNames).toEqual([
      "codex__app_server__command_exec",
      "codex__app_server__fs_writeFile",
      "search_native_tools",
    ]);
    expect(receipt.actionSchemas).toEqual([
      {
        toolName: "search_native_tools",
        inputProperties: ["cursor", "query"],
        requiredInputProperties: [],
      },
    ]);
    expect(JSON.stringify(receipt)).not.toContain("secret-access-token");
    expect(JSON.stringify(receipt)).not.toContain("secret-browser-cookie");
    const refreshRequest = requests.find(({ url }) => url.endsWith("/mcp/refresh_actions"));
    expect(refreshRequest?.init).toMatchObject({
      method: "POST",
      body: JSON.stringify({ link_id: "link-1" }),
    });
    expect(new Headers(refreshRequest?.init?.headers).get("ChatGPT-Account-Id")).toBe("acct-1");
    expect(new Headers(refreshRequest?.init?.headers).get("OAI-Product-Sku")).toBe(
      "CONNECTOR_SETTING",
    );
    const linksRequest = requests.find(({ url }) => url.endsWith("/links/list_accessible"));
    expect(linksRequest?.init?.body).toBe(
      JSON.stringify({ principals: [], link_refresh_strategy: "NONE" }),
    );
    const actionsRequest = requests.find(({ url }) =>
      url.endsWith(`/connectors/${connectorId}/actions`),
    );
    for (const request of [linksRequest, refreshRequest, actionsRequest]) {
      const requestUrl = new URL(request?.url ?? "https://chatgpt.com/");
      const requestHeaders = new Headers(request?.init?.headers);
      expect(requestHeaders.get("ChatGPT-Account-Id")).toBe("acct-1");
      expect(requestHeaders.get("X-OpenAI-Target-Path")).toBe(requestUrl.pathname);
      expect(requestHeaders.get("X-OpenAI-Target-Route")).toBe(requestUrl.pathname);
    }
  });

  it("reads the current ChatGPT control-plane params schema", async () => {
    const connectorId = "asdk_app_123abc";
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/auth/session")) {
        return jsonResponse({ accessToken: "token", account: { id: "acct-1" } });
      }
      if (url.endsWith("/links/list_accessible")) {
        return jsonResponse({ links: [{ id: "link-1", connector_id: connectorId }] });
      }
      if (url.endsWith("/mcp/refresh_actions")) return jsonResponse({ actions: [] });
      if (url.endsWith(`/connectors/${connectorId}/actions`)) {
        return jsonResponse({
          actions: [
            {
              name: "search_native_tools",
              params: {
                type: "object",
                properties: { query: {}, cursor: {}, limit: {} },
                required: ["query"],
                additionalProperties: false,
              },
            },
          ],
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const client = new ChatGptActionCatalogControlClient({
      cdpEndpoint: "http://127.0.0.1:19222",
      fetch: fetch as typeof globalThis.fetch,
      readBrowserAuth: async () => ({ cookieHeader: "session=cookie", userAgent: "Chrome/Test" }),
    });

    const receipt = await client.refresh(connectorId, ["search_native_tools"]);

    expect(receipt.actionSchemas).toEqual([
      {
        toolName: "search_native_tools",
        inputProperties: ["cursor", "limit", "query"],
        requiredInputProperties: ["query"],
      },
    ]);
  });

  it("fails closed when more than one account link matches the connector", async () => {
    const connectorId = "asdk_app_123abc";
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/auth/session")) {
        return jsonResponse({ accessToken: "token", account: { id: "acct-1" } });
      }
      return jsonResponse({
        links: [
          { id: "link-1", connector_id: connectorId },
          { id: "link-2", connector_id: connectorId },
        ],
      });
    });
    const client = new ChatGptActionCatalogControlClient({
      cdpEndpoint: "http://127.0.0.1:19222",
      fetch: fetch as typeof globalThis.fetch,
      readBrowserAuth: async () => ({ cookieHeader: "session=cookie", userAgent: "Chrome/Test" }),
    });

    await expect(client.refresh(connectorId, ["search_native_tools"])).rejects.toThrow(
      "CHATGPT_CONNECTOR_LINK_MISSING_OR_AMBIGUOUS:2",
    );
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
