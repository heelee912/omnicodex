import { assertConfig } from "./config.mjs";

export class ConnectorError extends Error {
  constructor(message, code = -32000) {
    super(message);
    this.code = code;
  }
}

export function parseRpcResponse(raw, id, contentType) {
  let messages;
  try {
    if (contentType.includes("text/event-stream")) {
      messages = raw
        .replace(/\r\n/g, "\n")
        .split("\n\n")
        .flatMap((event) => {
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          return data && data !== "[DONE]" ? [JSON.parse(data)] : [];
        });
    } else {
      messages = raw.trim() ? [JSON.parse(raw)] : [];
    }
  } catch {
    throw new ConnectorError("Hosted MCP returned malformed JSON/SSE.");
  }
  const matches = messages.filter((value) => value && value.jsonrpc === "2.0" && value.id === id);
  if (matches.length !== 1)
    throw new ConnectorError("Hosted MCP response did not uniquely match the request ID.");
  const message = matches[0];
  if (Object.hasOwn(message, "error"))
    throw new ConnectorError("Hosted MCP returned an RPC error. The call was not retried.");
  if (!message.result || typeof message.result !== "object" || Array.isArray(message.result)) {
    throw new ConnectorError("Hosted MCP response has no valid result.");
  }
  return message.result;
}

export function selectConnectorTools(config, tools) {
  assertConfig(config);
  const prefix = `/${config.connectorId}/${config.linkId}/`;
  const selected = new Map();
  const counts = new Map();
  for (const tool of tools) {
    if (typeof tool?.name === "string") counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  }
  for (const tool of tools) {
    if (tool?._meta?.connector_id !== config.connectorId) continue;
    const uri = tool._meta?._codex_apps?.resource_uri;
    if (
      tool._meta?.link_id !== config.linkId ||
      typeof uri !== "string" ||
      !uri.startsWith(prefix)
    ) {
      throw new ConnectorError(
        "The configured connector link changed; verify your own registration.",
      );
    }
    const name = uri.slice(prefix.length);
    if (
      !/^[A-Za-z0-9_.-]{1,256}$/.test(name) ||
      selected.has(name) ||
      typeof tool.name !== "string" ||
      !tool.name ||
      counts.get(tool.name) !== 1
    ) {
      throw new ConnectorError("Hosted MCP returned an invalid or duplicate tool identity.");
    }
    selected.set(name, { remoteName: tool.name, exposed: { ...tool, name } });
  }
  if (!selected.size)
    throw new ConnectorError(
      "This OAuth workspace cannot see the exact configured connector/link.",
    );
  return selected;
}

export class HostedConnectorClient {
  #nextId = 0;
  #tools;
  #catalogPromise;
  #contextPromise;
  #sessionId;
  #invalidCatalog = false;
  #config;

  constructor({ config, credential, fetcher = fetch, audit = () => {}, timeoutMs = 300_000 }) {
    assertConfig(config);
    if (
      !config?.binding ||
      typeof credential !== "function" ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0
    ) {
      throw new ConnectorError("A validated registration and credential provider are required.");
    }
    this.#config = config;
    this.credential = credential;
    this.fetcher = fetcher;
    this.audit = audit;
    this.timeoutMs = timeoutMs;
  }

  async request(method, params, signal, notification = false) {
    if (this.#invalidCatalog)
      throw new ConnectorError("Hosted target verification failed. Start a new connection.");
    const config = this.#config;
    const auth = await this.credential();
    if (
      auth.accountId !== config.workspaceId ||
      auth.binding !== config.binding ||
      typeof auth.accessToken !== "string" ||
      !auth.accessToken ||
      !/^[\x21-\x7e]+$/.test(auth.accessToken) ||
      auth.refreshPending ||
      !Number.isFinite(auth.expiresAt) ||
      auth.expiresAt <= Date.now()
    ) {
      throw new ConnectorError(
        "The OAuth credential does not match the configured workspace/registration or is expired.",
      );
    }
    signal?.throwIfAborted();
    const id = ++this.#nextId;
    const started = Date.now();
    const headers = {
      Authorization: `Bearer ${auth.accessToken}`,
      "ChatGPT-Account-Id": config.workspaceId,
      "X-OpenAI-Product-Sku": "codex",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
      ...(this.#sessionId ? { "Mcp-Session-Id": this.#sessionId } : {}),
    };
    let response;
    let result;
    try {
      response = await this.fetcher(config.endpoint, {
        method: "POST",
        headers,
        redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]),
        body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ConnectorError(
          `Hosted MCP returned HTTP ${response.status}. No alternate route or retry was used.`,
        );
      }
      const nextSessionId = response.headers.get("mcp-session-id");
      if (nextSessionId) {
        if (
          !/^[\x21-\x7e]{1,512}$/.test(nextSessionId) ||
          (this.#sessionId && nextSessionId !== this.#sessionId)
        ) {
          this.#invalidCatalog = true;
          throw new ConnectorError(
            "Hosted MCP changed or returned an invalid session identity. Start a new connection.",
          );
        }
        this.#sessionId = nextSessionId;
      }
      if (notification) {
        await response.body?.cancel();
        result = {};
      } else {
        result = parseRpcResponse(
          await response.text(),
          id,
          response.headers.get("content-type") || "",
        );
      }
    } catch (error) {
      this.audit({
        event: "request",
        method,
        outcome: "failed",
        status: response?.status,
        elapsedMs: Date.now() - started,
      });
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(
        "Hosted MCP transport stopped or failed. Execution may have continued; the call was not retried.",
      );
    }
    this.audit({
      event: "request",
      method,
      outcome: result.isError ? "tool_error" : "ok",
      elapsedMs: Date.now() - started,
    });
    return result;
  }

  async initialize(signal) {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "omnicodex-hosted-mcp", version: "0.1.0" },
      },
      signal,
    );
    if (result.protocolVersion !== "2025-03-26")
      throw new ConnectorError("Hosted MCP negotiated an unsupported protocol version.");
    await this.request("notifications/initialized", {}, signal, true);
  }

  async #loadTools(signal) {
    const tools = [];
    const cursors = new Set();
    let cursor;
    do {
      const result = await this.request("tools/list", cursor ? { cursor } : {}, signal);
      if (!Array.isArray(result.tools))
        throw new ConnectorError("Hosted MCP returned an invalid catalog.");
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (cursor !== undefined && (typeof cursor !== "string" || !cursor || cursors.has(cursor))) {
        throw new ConnectorError("Hosted MCP catalog returned an invalid or repeated cursor.");
      }
      if (cursor) cursors.add(cursor);
      if (tools.length > 20_000 || cursors.size > 200)
        throw new ConnectorError("Hosted MCP catalog exceeded safety limits.");
    } while (cursor);
    const selected = selectConnectorTools(this.#config, tools);
    if (
      this.#tools &&
      (selected.size !== this.#tools.size ||
        [...selected].some(
          ([name, value]) => this.#tools.get(name)?.remoteName !== value.remoteName,
        ))
    ) {
      throw new ConnectorError(
        "Hosted MCP tool routes changed. Start a new connection after verifying registration.",
      );
    }
    this.#tools = selected;
    this.audit({ event: "catalog", toolCount: selected.size });
    return { tools: [...selected.values()].map((tool) => tool.exposed) };
  }

  async listTools(signal) {
    if (this.#invalidCatalog)
      throw new ConnectorError("Catalog verification previously failed. Start a new connection.");
    this.#catalogPromise ??= this.#loadTools(signal)
      .catch((error) => {
        this.#invalidCatalog = true;
        throw error;
      })
      .finally(() => {
        this.#catalogPromise = undefined;
      });
    return this.#catalogPromise;
  }

  async #sessionContext(signal) {
    // A rejected identity attempt is deliberately retained: no implicit new work session/replay.
    this.#contextPromise ??= (async () => {
      const identity = this.#tools.get("codex__omnicodex__session_identity");
      if (!identity) throw new ConnectorError("The connector has no session identity tool.");
      const result = await this.request(
        "tools/call",
        { name: identity.remoteName, arguments: {} },
        signal,
      );
      const context = result.structuredContent;
      if (
        result.isError ||
        typeof context?.continuationToken !== "string" ||
        !context.continuationToken ||
        typeof context?.workSessionBinding !== "string" ||
        !context.workSessionBinding
      ) {
        throw new ConnectorError("The connector did not establish an isolated work session.");
      }
      return {
        continuationToken: context.continuationToken,
        workSessionBinding: context.workSessionBinding,
      };
    })();
    return this.#contextPromise;
  }

  async callTool(name, args, signal) {
    if (this.#invalidCatalog)
      throw new ConnectorError("Catalog verification previously failed. Start a new connection.");
    if (!this.#tools) await this.listTools(signal);
    const tool = this.#tools.get(name);
    if (
      !tool ||
      (args !== undefined && (!args || typeof args !== "object" || Array.isArray(args)))
    ) {
      throw new ConnectorError(
        "Unknown tool or invalid arguments for the configured connector.",
        -32602,
      );
    }
    const context = await this.#sessionContext(signal);
    // A catalog refresh may have failed while session identity was in flight.
    if (this.#invalidCatalog)
      throw new ConnectorError("Catalog verification failed during session establishment.");
    return this.request(
      "tools/call",
      {
        name: tool.remoteName,
        arguments: args ?? {},
        _meta: { "omnicodex/continuation-token": context.continuationToken },
      },
      signal,
    );
  }
}
