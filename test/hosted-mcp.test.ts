import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// Native ESM imports keep the shipped dependency-free .mjs runtime under test.
const runtime = new URL("../scripts/connectors/hosted-mcp/", import.meta.url);
const { loadConfig } = await import(new URL("config.mjs", runtime).href);
const { HostedConnectorClient, parseRpcResponse, selectConnectorTools } = await import(
  new URL("hosted-connector.mjs", runtime).href
);
const { createOAuthAttempt } = await import(new URL("oauth-login.mjs", runtime).href);
const {
  credentialFromTokens,
  credentialProvider,
  protectSecret,
  readCredential,
  requestTokens,
  saveCredential,
} = await import(new URL("oauth-credential.mjs", runtime).href);
const { prepareState, stateFile, withCredentialLock } = await import(
  new URL("state.mjs", runtime).href
);
const { createAudit, redactAudit } = await import(new URL("audit.mjs", runtime).href);
const { createStdioSession } = await import(new URL("stdio.mjs", runtime).href);

const env = {
  OMNICODEX_HOSTED_OAUTH_CLIENT_ID: "synthetic-public-client",
  OMNICODEX_HOSTED_OAUTH_AUTHORIZATION_URL: "https://identity.example.invalid/authorize",
  OMNICODEX_HOSTED_OAUTH_TOKEN_URL: "https://identity.example.invalid/token",
  OMNICODEX_HOSTED_OAUTH_CALLBACK_URL: "http://127.0.0.1:37681/oauth/callback",
  OMNICODEX_HOSTED_OAUTH_SCOPES: "openid offline_access api.connectors.read api.connectors.invoke",
  OMNICODEX_HOSTED_WORKSPACE_ID: "synthetic-workspace",
  OMNICODEX_HOSTED_CONNECTOR_ID: "synthetic-connector",
  OMNICODEX_HOSTED_LINK_ID: "synthetic-link",
  OMNICODEX_HOSTED_MCP_ENDPOINT: "https://resource.example.invalid/mcp",
};
const config = loadConfig(env);
const identityName = "codex__omnicodex__session_identity";
const jwt = (workspace = config.workspaceId, exp = Math.floor(Date.now() / 1000) + 3600) =>
  `e30.${Buffer.from(JSON.stringify({ exp, "https://api.openai.com/auth": { chatgpt_account_id: workspace } })).toString("base64url")}.synthetic`;
const tokens = () => ({
  access_token: jwt(),
  refresh_token: "synthetic-refresh-token",
  expires_in: 3600,
});
const remoteTool = (
  name: string,
  connectorId = config.connectorId,
  linkId = config.linkId,
  remoteName = `synthetic.${name}`,
) => ({
  name: remoteName,
  inputSchema: { type: "object", properties: {} },
  _meta: {
    connector_id: connectorId,
    link_id: linkId,
    _codex_apps: { resource_uri: `/${connectorId}/${linkId}/${name}` },
  },
});
const catalog = { tools: [remoteTool(identityName), remoteTool("synthetic_action")] };
const context = {
  structuredContent: {
    workSessionBinding: "synthetic-binding",
    continuationToken: "synthetic-continuation",
  },
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function stateFixture() {
  const home = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "hosted-mcp-test-"));
  directories.push(home);
  const options = {
    home,
    env: { LOCALAPPDATA: home, OMNICODEX_HOSTED_STATE_DIR: join(home, "state") },
  };
  return { home, options, state: await prepareState(config, options) };
}

function harness(replies: unknown[], auth = credentialFromTokens(config, tokens())) {
  const calls: {
    url: string;
    options: RequestInit;
    request: { id: number; method: string; params: Record<string, unknown> };
  }[] = [];
  const fetcher = vi.fn(async (url: string, options: RequestInit) => {
    const request = JSON.parse(String(options.body));
    calls.push({ url, options, request });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (reply instanceof Response) return reply;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: reply }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  return {
    calls,
    fetcher,
    client: new HostedConnectorClient({ config, credential: async () => auth, fetcher }),
  };
}

function callback(attempt: { authorizationUrl: string }, changes: Record<string, string> = {}) {
  const authorize = new URL(attempt.authorizationUrl);
  const url = new URL(config.callbackUrl);
  url.search = new URLSearchParams({
    state: authorize.searchParams.get("state") ?? "",
    code: "synthetic-code",
    ...changes,
  }).toString();
  return { method: "GET", host: url.host, url: `${url.pathname}${url.search}` };
}

describe("portable hosted configuration", () => {
  it("has no default app, resource or account, and binds every registration field", () => {
    expect(() => loadConfig({})).toThrow(/YOUR|your/);
    for (const key of Object.keys(env)) {
      expect(() => loadConfig({ ...env, [key]: "" })).toThrow();
      const replacement =
        key.endsWith("URL") || key.endsWith("ENDPOINT")
          ? key.endsWith("CALLBACK_URL")
            ? "http://127.0.0.1:37682/other"
            : "https://other.example.invalid/path"
          : key.endsWith("SCOPES")
            ? `${env.OMNICODEX_HOSTED_OAUTH_SCOPES} profile`
            : "another-registration";
      expect(loadConfig({ ...env, [key]: replacement }).binding).not.toBe(config.binding);
    }
    expect(loadConfig({ ...env, OMNICODEX_HOSTED_LOG: "1" }).binding).toBe(config.binding);
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => new HostedConnectorClient({ config: { ...config }, credential: vi.fn() })).toThrow(
      /validated/,
    );
  });

  it("rejects unsafe endpoints, callbacks, scopes and header/path identifiers", () => {
    for (const value of [
      "http://identity.example.invalid/token",
      "https://user:pass@identity.example.invalid/token",
      "https://identity.example.invalid/token?q=secret",
      "https://identity.example.invalid/token#secret",
      "bad-url",
      "https://identity.example.invalid/token\npath",
    ]) {
      expect(() => loadConfig({ ...env, OMNICODEX_HOSTED_OAUTH_TOKEN_URL: value })).toThrow();
    }
    for (const value of [
      "http://localhost:37681/oauth/callback",
      "http://0.0.0.0:37681/oauth/callback",
      "https://127.0.0.1:37681/oauth/callback",
      "http://127.0.0.1/oauth/callback",
      "http://127.0.0.1:37681/oauth/callback?q=x",
      "http://127.0.0.1:37681/../oauth/callback",
    ]) {
      expect(() => loadConfig({ ...env, OMNICODEX_HOSTED_OAUTH_CALLBACK_URL: value })).toThrow();
    }
    expect(() => loadConfig({ ...env, OMNICODEX_HOSTED_WORKSPACE_ID: "bad\r\nHeader" })).toThrow();
    expect(() => loadConfig({ ...env, OMNICODEX_HOSTED_LINK_ID: "../wrong" })).toThrow();
    expect(() => loadConfig({ ...env, OMNICODEX_HOSTED_OAUTH_SCOPES: "openid" })).toThrow();
    expect(() => loadConfig({ ...env, OMNICODEX_HOSTED_LOG: "yes" })).toThrow();
  });
});

describe("exact hosted target and no replay", () => {
  it("selects exact metadata, not a display label, and rejects ambiguous remote routes", () => {
    const selected = selectConnectorTools(config, [
      remoteTool("unrelated", "another-connector"),
      ...catalog.tools,
    ]);
    expect([...selected.keys()]).toEqual([identityName, "synthetic_action"]);
    expect(() =>
      selectConnectorTools(config, [
        remoteTool("synthetic_action", config.connectorId, "another-link"),
      ]),
    ).toThrow(/link changed/);
    const forged = remoteTool("synthetic_action");
    forged._meta._codex_apps.resource_uri = "/another-connector/synthetic-link/synthetic_action";
    expect(() => selectConnectorTools(config, [forged])).toThrow(/link changed/);
    expect(() => selectConnectorTools(config, [remoteTool("../escape")])).toThrow(/invalid/);
    expect(() => selectConnectorTools(config, [remoteTool("same"), remoteTool("same")])).toThrow(
      /duplicate/,
    );
    expect(() =>
      selectConnectorTools(config, [
        remoteTool("one"),
        remoteTool("two", "another-connector", "another-link", "synthetic.one"),
      ]),
    ).toThrow(/duplicate/);
    expect(() => selectConnectorTools(config, [])).toThrow(/exact configured/);
  });

  it("parses JSON/SSE with exact RPC identity and redacts untrusted errors", () => {
    const response = JSON.stringify({ jsonrpc: "2.0", id: 8, result: { ok: true } });
    expect(parseRpcResponse(response, 8, "application/json")).toEqual({ ok: true });
    const sse = `: ping\r\n\r\ndata: {"jsonrpc":"2.0","method":"notify"}\r\n\r\ndata: {"jsonrpc":"2.0","id":8,\r\ndata: "result":{"ok":true}}\r\n\r\ndata: [DONE]\r\n\r\n`;
    expect(parseRpcResponse(sse, 8, "text/event-stream")).toEqual({ ok: true });
    expect(() => parseRpcResponse(response, 9, "application/json")).toThrow(/request ID/);
    expect(() =>
      parseRpcResponse(`data: ${response}\n\ndata: ${response}\n\n`, 8, "text/event-stream"),
    ).toThrow(/uniquely/);
    expect(() => parseRpcResponse("sensitive-upstream-payload", 8, "application/json")).toThrow(
      "Hosted MCP returned malformed JSON/SSE.",
    );
    expect(() =>
      parseRpcResponse(
        '{"jsonrpc":"2.0","id":8,"error":{"message":"synthetic-secret"}}',
        8,
        "application/json",
      ),
    ).toThrow("Hosted MCP returned an RPC error. The call was not retried.");
  });

  it("uses only the configured endpoint/workspace, opaque routes and continuation context", async () => {
    const { client, calls } = harness([catalog, context, { content: [] }, { content: [] }]);
    await client.listTools();
    await client.callTool("synthetic_action", { synthetic: true });
    await client.callTool("synthetic_action", {});
    expect(calls).toHaveLength(4);
    expect(
      calls.every((call) => call.url === config.endpoint && call.options.redirect === "error"),
    ).toBe(true);
    expect(calls[2]?.options.headers).toMatchObject({ "ChatGPT-Account-Id": config.workspaceId });
    expect(calls[2]?.request.params).toEqual({
      name: "synthetic.synthetic_action",
      arguments: { synthetic: true },
      _meta: { "omnicodex/continuation-token": "synthetic-continuation" },
    });
    expect(calls[3]?.request.params._meta).toEqual(calls[2]?.request.params._meta);
  });

  it("negotiates the supported protocol and sends initialized notification without a request ID", async () => {
    const { client, calls } = harness([
      { protocolVersion: "2025-03-26" },
      new Response(null, { status: 202 }),
    ]);
    await client.initialize();
    expect(calls.map((call) => call.request.method)).toEqual([
      "initialize",
      "notifications/initialized",
    ]);
    expect(calls[1]?.request).not.toHaveProperty("id");
  });

  it("rejects unknown tools and wrong OAuth bindings before any execution", async () => {
    const good = harness([catalog]);
    await good.client.listTools();
    await expect(good.client.callTool("not_registered", {})).rejects.toThrow(/Unknown tool/);
    await expect(good.client.callTool("synthetic_action", [])).rejects.toThrow(/invalid arguments/);
    expect(good.calls).toHaveLength(1);
    for (const change of [
      { accountId: "another-workspace" },
      { binding: "another-registration" },
      { expiresAt: 0 },
      { refreshPending: true },
    ]) {
      const bad = harness([], { ...credentialFromTokens(config, tokens()), ...change });
      await expect(bad.client.initialize()).rejects.toThrow(/credential/);
      expect(bad.calls).toHaveLength(0);
    }
  });

  it.each([
    new Response("synthetic-private-body", { status: 401 }),
    new Response("synthetic-private-body", { status: 503 }),
    new Error("synthetic-secret"),
    new DOMException("synthetic-secret", "AbortError"),
  ])("never retries a failed or cancelled tool execution", async (failure) => {
    const { client, calls } = harness([catalog, context, failure]);
    await client.listTools();
    await expect(client.callTool("synthetic_action", {})).rejects.toThrow(/retried|retry/);
    expect(calls).toHaveLength(3);
    expect(
      calls.filter((call) => call.request.params.name === "synthetic.synthetic_action"),
    ).toHaveLength(1);
  });

  it("retains failed identity setup and blocks changed catalogs/sessions", async () => {
    const failedIdentity = harness([catalog, new Error("synthetic-private")]);
    await failedIdentity.client.listTools();
    await expect(failedIdentity.client.callTool("synthetic_action", {})).rejects.toThrow();
    await expect(failedIdentity.client.callTool("synthetic_action", {})).rejects.toThrow();
    expect(failedIdentity.calls).toHaveLength(2);
    const changed = harness([
      catalog,
      {
        tools: [
          remoteTool(identityName),
          remoteTool("synthetic_action", config.connectorId, config.linkId, "changed.route"),
        ],
      },
    ]);
    await changed.client.listTools();
    await expect(changed.client.listTools()).rejects.toThrow(/routes changed/);
    await expect(changed.client.callTool("synthetic_action", {})).rejects.toThrow(
      /previously failed/,
    );
    expect(changed.calls).toHaveLength(2);
    const first = new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: catalog }), {
      headers: { "mcp-session-id": "synthetic-session-one" },
    });
    const second = new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: context }), {
      headers: { "mcp-session-id": "synthetic-session-two" },
    });
    const session = harness([first, second]);
    await session.client.listTools();
    await expect(session.client.callTool("synthetic_action", {})).rejects.toThrow(
      /session identity/,
    );
    await expect(session.client.initialize()).rejects.toThrow(/verification failed/);
    expect(session.calls).toHaveLength(2);
  });

  it("paginates the catalog, blocks repeated cursors and honors pre-cancellation", async () => {
    const good = harness([
      { tools: [remoteTool("one")], nextCursor: "synthetic-cursor" },
      { tools: [remoteTool("two")] },
    ]);
    expect((await good.client.listTools()).tools).toHaveLength(2);
    expect(good.calls[1]?.request.params).toEqual({ cursor: "synthetic-cursor" });
    const repeated = harness([
      { tools: [], nextCursor: "repeat" },
      { tools: [], nextCursor: "repeat" },
    ]);
    await expect(repeated.client.listTools()).rejects.toThrow(/repeated cursor/);
    const cancelled = harness([]);
    await expect(cancelled.client.initialize(AbortSignal.abort())).rejects.toThrow();
    expect(cancelled.calls).toHaveLength(0);
  });
});

describe("isolated OAuth code + PKCE", () => {
  it("uses the recipient app, endpoint, callback, scopes, workspace and independent state", async () => {
    const exchange = vi.fn(
      async (_parameters: { code: string; verifier: string; redirectUri: string }) => {},
    );
    const attempt = createOAuthAttempt(config, exchange);
    const authorize = new URL(attempt.authorizationUrl);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(config.authorizationUrl);
    expect(authorize.searchParams.get("client_id")).toBe(config.clientId);
    expect(authorize.searchParams.get("allowed_workspace_id")).toBe(config.workspaceId);
    expect(authorize.searchParams.get("redirect_uri")).toBe(config.callbackUrl);
    expect(authorize.searchParams.get("scope")).toBe(config.scopes);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const another = new URL(createOAuthAttempt(config, exchange).authorizationUrl);
    expect(another.searchParams.get("state")).not.toBe(authorize.searchParams.get("state"));
    expect((await attempt.handle(callback(attempt))).success).toBe(true);
    const parameters = exchange.mock.calls[0]?.[0];
    expect(parameters?.code).toBe("synthetic-code");
    expect(parameters?.redirectUri).toBe(config.callbackUrl);
    expect(
      createHash("sha256")
        .update(parameters?.verifier ?? "")
        .digest("base64url"),
    ).toBe(authorize.searchParams.get("code_challenge"));
    expect((await attempt.handle(callback(attempt))).status).toBe(400);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("rejects wrong state including multibyte input, host, method, path and duplicate parameters", async () => {
    const exchange = vi.fn();
    const attempt = createOAuthAttempt(config, exchange);
    const good = callback(attempt);
    for (const bad of [
      callback(attempt, { state: "wrong" }),
      callback(attempt, { state: "é".repeat(43) }),
      { ...good, host: "localhost:37681" },
      { ...good, method: "POST" },
      { ...good, url: good.url.replace("/oauth/callback", "/wrong") },
      { ...good, url: `/other/..${good.url}` },
      { ...good, url: `${good.url}&state=duplicate` },
      { ...good, url: `${good.url}&code=duplicate` },
      { ...good, url: `http://${good.host}${good.url}` },
    ])
      expect((await attempt.handle(bad)).status).toBe(400);
    expect(exchange).not.toHaveBeenCalled();
    expect((await attempt.handle(good)).success).toBe(true);
  });

  it("consumes before awaiting and never replays denied or failed exchanges", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const exchange = vi.fn(async () => {
      await gate;
      throw new Error("synthetic-sensitive-upstream");
    });
    const attempt = createOAuthAttempt(config, exchange);
    const first = attempt.handle(callback(attempt));
    expect((await attempt.handle(callback(attempt))).status).toBe(400);
    release();
    expect(await first).toMatchObject({ complete: true, success: false });
    expect((await attempt.handle(callback(attempt))).status).toBe(400);
    expect(exchange).toHaveBeenCalledTimes(1);
    const denied = createOAuthAttempt(config, exchange);
    expect(await denied.handle(callback(denied, { error: "synthetic-denial" }))).toMatchObject({
      complete: true,
      success: false,
    });
    expect((await denied.handle(callback(denied))).status).toBe(400);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("rejects wrong workspace even with a matching id token, missing refresh and bad expiry", () => {
    expect(() =>
      credentialFromTokens(config, {
        ...tokens(),
        access_token: jwt("another-workspace"),
        id_token: jwt(),
      }),
    ).toThrow(/different workspace/);
    expect(() => credentialFromTokens(config, { access_token: jwt() })).toThrow(/credential/);
    expect(() => credentialFromTokens(config, { ...tokens(), expires_in: -1 })).toThrow(
      /expiration/,
    );
    expect(() =>
      credentialFromTokens(config, { ...tokens(), access_token: jwt(config.workspaceId, 1) }),
    ).toThrow(/expired/);
    expect(() => credentialFromTokens(config, { ...tokens(), access_token: "opaque" })).toThrow(
      /invalid access token/,
    );
    const previous = credentialFromTokens(config, tokens());
    expect(credentialFromTokens(config, { access_token: jwt() }, previous).refreshToken).toBe(
      previous.refreshToken,
    );
    expect(
      credentialFromTokens(config, { ...tokens(), expires_in: 100_000 }).expiresAt,
    ).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) * 1000 + 3600_000);
  });

  it("sends only to the configured token URL/client, with redirects disabled and no retry", async () => {
    const fetcher = vi.fn(
      async (_url: string, _options: RequestInit) => new Response(JSON.stringify(tokens())),
    );
    await requestTokens(
      config,
      { grant_type: "authorization_code", code: "synthetic-code" },
      fetcher,
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe(config.tokenUrl);
    const options = fetcher.mock.calls[0]?.[1];
    expect(options?.redirect).toBe("error");
    expect((options?.body as URLSearchParams | undefined)?.get("client_id")).toBe(config.clientId);
    const failed = vi.fn(async () => {
      throw new Error("synthetic-private-error");
    });
    await expect(requestTokens(config, {}, failed)).rejects.toThrow(
      "OAuth token request failed; it was not retried. Sign in again.",
    );
    expect(failed).toHaveBeenCalledTimes(1);
  });
});

describe("private per-user state and redacted optional audit", () => {
  it("keeps defaults outside source and separates registrations", async () => {
    const { home } = await stateFixture();
    const options = { home, env: { LOCALAPPDATA: home, XDG_STATE_HOME: home } };
    const first = await prepareState(config, options);
    const second = await prepareState(
      loadConfig({ ...env, OMNICODEX_HOSTED_OAUTH_CLIENT_ID: "another-client" }),
      options,
    );
    expect(first.directory).not.toBe(second.directory);
    expect(first.directory.startsWith(home)).toBe(true);
    expect(first.directory).not.toContain(fileURLToPath(runtime));
  });

  it("rejects a different registration and unmarked preexisting credential state", async () => {
    const { options, state } = await stateFixture();
    const credentialPath = join(state.directory, "oauth.dpapi");
    await writeFile(credentialPath, "synthetic-existing-credential");
    const another = loadConfig({ ...env, OMNICODEX_HOSTED_OAUTH_CLIENT_ID: "another-client" });
    await expect(prepareState(another, options)).rejects.toThrow(/different registration/);
    expect(await readFile(credentialPath, "utf8")).toBe("synthetic-existing-credential");
    await unlink(join(state.directory, "registration.binding"));
    await expect(prepareState(config, options)).rejects.toThrow(/Unmarked state directory/);
    expect(await readFile(credentialPath, "utf8")).toBe("synthetic-existing-credential");
  });

  it.runIf(process.platform === "win32")(
    "rejects a preexisting Windows state directory with inherited ACL",
    async () => {
      const { home, options } = await stateFixture();
      const shared = join(home, "shared-state");
      await mkdir(shared);
      await expect(
        prepareState(config, {
          ...options,
          env: { ...options.env, OMNICODEX_HOSTED_STATE_DIR: shared },
        }),
      ).rejects.toThrow(/ACL|private/);
    },
  );

  it("rejects source-relative, outside-user and symlink-aliased state before writing", async () => {
    const { home, options } = await stateFixture();
    const source = join(home, "synthetic-source");
    await mkdir(source);
    for (const directory of [
      "relative-state",
      join(source, "state"),
      home,
      join(home, "..", "outside-user"),
    ]) {
      await expect(
        prepareState(config, {
          ...options,
          sourceRoot: source,
          env: { ...options.env, OMNICODEX_HOSTED_STATE_DIR: directory },
        }),
      ).rejects.toThrow();
    }
    const alias = join(home, "source-alias");
    await symlink(source, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(
      prepareState(config, {
        ...options,
        sourceRoot: source,
        env: { ...options.env, OMNICODEX_HOSTED_STATE_DIR: join(alias, "state") },
      }),
    ).rejects.toThrow(/outside/);
    expect(await readdir(source)).toEqual([]);
  });

  it("rejects linked files and foreign paths and does not steal an existing lock", async () => {
    const { home, state } = await stateFixture();
    await expect(stateFile({ directory: home }, "oauth.dpapi")).rejects.toThrow(/Invalid/);
    await expect(stateFile(state, "../outside")).rejects.toThrow(/Invalid/);
    const outside = join(home, "unrelated-synthetic-file");
    await writeFile(outside, "synthetic-unchanged");
    await link(outside, join(state.directory, "oauth.dpapi"));
    await expect(stateFile(state, "oauth.dpapi")).rejects.toThrow(/not links/);
    expect(await readFile(outside, "utf8")).toBe("synthetic-unchanged");
    await withCredentialLock(state, async () => {
      await expect(withCredentialLock(state, vi.fn())).rejects.toThrow(/locked/);
      expect(await readdir(state.directory)).toContain("oauth.lock");
    });
    expect(await readdir(state.directory)).not.toContain("oauth.lock");
  });

  it("logs nothing by default and uses a strict redaction allowlist when enabled", async () => {
    const { state } = await stateFixture();
    const record = {
      event: "request",
      method: "tools/call",
      outcome: "ok",
      elapsedMs: 3,
      tool: "synthetic-private-tool",
      arguments: "synthetic-private-arguments",
      token: "synthetic-private-token",
      connectorId: "synthetic-private-id",
      path: "synthetic-private-path",
      response: "synthetic-private-response",
    };
    const disabled = createAudit(state);
    disabled(record);
    await disabled.flush();
    expect((await readdir(state.directory)).sort()).toEqual(["registration.binding"]);
    const audit = createAudit(state, true);
    audit(record);
    await audit.flush();
    const raw = await readFile(join(state.directory, "connection.log.jsonl"), "utf8");
    expect(raw).not.toContain("synthetic-private");
    expect(JSON.parse(raw)).toEqual({
      time: expect.any(String),
      event: "request",
      method: "tools/call",
      outcome: "ok",
      elapsedMs: 3,
    });
    expect(
      Object.keys(
        redactAudit({
          event: "synthetic-private",
          method: "synthetic-private",
          status: NaN,
          toolCount: -1,
        }),
      ),
    ).toEqual(["time"]);
  });
});

describe("DPAPI storage with exclusively synthetic credentials", () => {
  it("rejects unsupported protection operations without a plaintext fallback", async () => {
    await expect(protectSecret("invalid", "synthetic-secret")).rejects.toThrow(/DPAPI/);
  });

  it.skipIf(process.platform !== "win32")(
    "round trips ciphertext, fails closed on corruption and rejects another registration",
    async () => {
      const { state } = await stateFixture();
      const credential = credentialFromTokens(config, tokens());
      await saveCredential(config, state, credential);
      const path = join(state.directory, "oauth.dpapi");
      const ciphertext = await readFile(path, "utf8");
      expect(ciphertext).not.toContain(credential.accessToken);
      expect(ciphertext).not.toContain(credential.refreshToken);
      expect(await readCredential(config, state)).toEqual(credential);
      const changed = loadConfig({ ...env, OMNICODEX_HOSTED_LINK_ID: "another-link" });
      await expect(readCredential(changed, state)).rejects.toThrow(/registration/);
      await writeFile(path, "synthetic-invalid-ciphertext");
      await expect(readCredential(config, state)).rejects.toThrow(/unavailable/);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "single-flights refresh and saves rotation before returning it",
    async () => {
      const { state } = await stateFixture();
      await saveCredential(
        config,
        state,
        credentialFromTokens(config, { ...tokens(), expires_in: 1 }),
      );
      const fetcher = vi.fn(async (_url: string, options: { body: URLSearchParams }) => {
        expect(options.body.get("refresh_token")).toBe("synthetic-refresh-token");
        expect((await readCredential(config, state)).refreshPending).toBe(true);
        return new Response(
          JSON.stringify({ ...tokens(), refresh_token: "synthetic-rotated-refresh" }),
        );
      });
      const obtain = credentialProvider(config, state, { fetcher });
      const values = await Promise.all([obtain(), obtain(), obtain()]);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(values.every((value) => value.refreshToken === "synthetic-rotated-refresh")).toBe(
        true,
      );
      const second = credentialProvider(config, state, { fetcher });
      expect((await second()).refreshToken).toBe("synthetic-rotated-refresh");
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect((await readCredential(config, state)).refreshPending).toBe(false);
      expect((await readdir(state.directory)).sort()).toEqual([
        "oauth.dpapi",
        "registration.binding",
      ]);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "persists a no-replay barrier after uncertain refresh failure",
    async () => {
      const { state } = await stateFixture();
      await saveCredential(
        config,
        state,
        credentialFromTokens(config, { ...tokens(), expires_in: 1 }),
      );
      const fetcher = vi.fn(async () => {
        throw new Error("synthetic-transport-failure");
      });
      const obtain = credentialProvider(config, state, { fetcher });
      await expect(obtain()).rejects.toThrow(/not retried/);
      await expect(obtain()).rejects.toThrow(/uncertain outcome/);
      const anotherProcess = credentialProvider(config, state, { fetcher });
      await expect(anotherProcess()).rejects.toThrow(/uncertain outcome/);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect((await readCredential(config, state)).refreshPending).toBe(true);
      expect((await readdir(state.directory)).sort()).toEqual([
        "oauth.dpapi",
        "registration.binding",
      ]);
    },
  );
});

describe("stdio replay boundary and privacy", () => {
  it("cannot initialize or execute a duplicate request twice and sanitizes unexpected errors", async () => {
    const client = {
      initialize: vi.fn(async () => {}),
      listTools: vi.fn(async () => catalog),
      callTool: vi.fn(async () => {
        throw new Error("synthetic-sensitive-internal-error");
      }),
    };
    const send = vi.fn();
    const session = createStdioSession(client, send);
    await session.dispatch({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await session.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "synthetic_action" },
    });
    await session.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "synthetic_action" },
    });
    await session.dispatch({ jsonrpc: "2.0", id: 3, method: "initialize" });
    expect(client.initialize).toHaveBeenCalledTimes(1);
    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls)).not.toContain("synthetic-sensitive");
    expect(JSON.stringify(send.mock.calls)).toContain("no replay was sent");
    session.close();
  });

  it("propagates cancellation without dispatching notifications as calls", async () => {
    let aborted = false;
    const client = {
      initialize: vi.fn(async () => {}),
      callTool: vi.fn(
        async (_name: string, _args: unknown, signal: AbortSignal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            );
          }),
      ),
    };
    const session = createStdioSession(client, vi.fn());
    await session.dispatch({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const call = session.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "synthetic_action" },
    });
    await session.dispatch({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 2 },
    });
    await call;
    expect(aborted).toBe(true);
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });
});
