import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createAudit } from "./audit.mjs";
import { configPathArgument, loadInstalledConfig } from "./config-store.mjs";
import { ConnectorError, HostedConnectorClient } from "./hosted-connector.mjs";
import { credentialProvider, protectSecret } from "./oauth-credential.mjs";
import { prepareState } from "./state.mjs";

export function createStdioSession(client, send) {
  const pending = new Map();
  const seen = new Set();
  let initialization = "new";
  async function dispatch(message) {
    if (
      !message ||
      Array.isArray(message) ||
      message.jsonrpc !== "2.0" ||
      typeof message.method !== "string"
    ) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid MCP request." } });
      return;
    }
    if (!Object.hasOwn(message, "id")) {
      if (message.method === "notifications/cancelled")
        pending.get(message.params?.requestId)?.abort();
      return;
    }
    const id = message.id;
    if (
      (typeof id !== "string" && typeof id !== "number") ||
      (typeof id === "number" && !Number.isFinite(id))
    ) {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid MCP request ID." },
      });
      return;
    }
    if (seen.has(id) || seen.size >= 100_000) {
      send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32600,
          message: "Duplicate request ID or session request limit; no replay was sent.",
        },
      });
      return;
    }
    seen.add(id);
    const controller = new AbortController();
    pending.set(id, controller);
    try {
      let result;
      if (message.method === "initialize") {
        if (initialization !== "new")
          throw new ConnectorError(
            "Initialize cannot be replayed; start a new connection.",
            -32600,
          );
        initialization = "pending";
        await client.initialize(controller.signal);
        initialization = "ready";
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "omnicodex-hosted-mcp", version: "0.1.0" },
        };
      } else if (initialization !== "ready") {
        throw new ConnectorError("A successful MCP initialize is required.", -32002);
      } else if (message.method === "ping") result = {};
      else if (message.method === "tools/list") result = await client.listTools(controller.signal);
      else if (message.method === "tools/call")
        result = await client.callTool(
          message.params?.name,
          message.params?.arguments,
          controller.signal,
        );
      else throw new ConnectorError("MCP method not supported.", -32601);
      send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id,
        error: {
          code: error instanceof ConnectorError ? error.code : -32000,
          message:
            error instanceof ConnectorError
              ? error.message
              : "Hosted connector failed. Check configuration and dedicated OAuth state; no retry was sent.",
        },
      });
    } finally {
      pending.delete(id);
    }
  }
  return {
    dispatch,
    close() {
      for (const controller of pending.values()) controller.abort();
    },
  };
}

export async function runStdio(config) {
  config ??= await loadInstalledConfig({ configPath: configPathArgument() });
  await protectSecret("protect", "connector-protection-check");
  const state = await prepareState(config);
  const audit = createAudit(state, config.logging);
  const client = new HostedConnectorClient({
    config,
    credential: credentialProvider(config, state),
    audit,
  });
  const session = createStdioSession(client, (value) =>
    process.stdout.write(`${JSON.stringify(value)}\n`),
  );
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid MCP JSON line." } })}\n`,
      );
      return;
    }
    void session.dispatch(message);
  });
  input.on("close", () => {
    session.close();
    void audit.flush();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdio().catch(() => {
    process.stderr.write(
      "Hosted MCP startup failed. Run node scripts/connectors/hosted-mcp/setup.mjs first; use the same --config path and unset partial registration overrides. Check Windows DPAPI state; no fallback was used.\n",
    );
    process.exitCode = 1;
  });
}
