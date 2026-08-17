import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OmniCodexGatewayService } from "../dist/application/omnicodex-gateway-service.js";
import { observeProtectedFile } from "../dist/infrastructure/safety/protected-file-snapshot.js";

const resource = "http://127.0.0.1/omnicodex-gateway-smoke";
const service = new OmniCodexGatewayService({
  cwd: process.cwd(),
  authorize: () => ({
    ok: true,
    identity: {
      issuer: "urn:omnicodex:gateway-smoke",
      subject: "local-owner",
      clientId: "gateway-smoke",
      resource,
    },
    authInfo: {
      token: "local-gateway-smoke",
      clientId: "gateway-smoke",
      scopes: ["omnicodex:full"],
      resource: new URL(resource),
      extra: { issuer: "urn:omnicodex:gateway-smoke", subject: "local-owner" },
    },
  }),
});
let transport;
let client;
let stopped = false;
const protectedTargets = [
  { logicalName: "codex_config", path: join(homedir(), ".codex", "config.toml") },
  { logicalName: "codex_auth", path: join(homedir(), ".codex", "auth.json") },
  {
    logicalName: "codex_chrome_hosts",
    path: join(homedir(), ".codex", "chrome-native-hosts-v2.json"),
  },
];
const before = await Promise.all(protectedTargets.map(observeProtectedFile));

try {
  const status = await service.start();
  if (status.address === undefined) throw new Error("Gateway did not return an address");
  const endpoint = new URL(
    `http://${status.address.host}:${status.address.port}${status.address.fullPath}`,
  );
  transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: "Bearer local-gateway-smoke" } },
  });
  client = new Client({ name: "omnicodex-real-smoke", version: "1.0.0" });
  await client.connect(transport);
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  const names = new Set(tools.map((tool) => tool.name));
  const required = [
    "codex_app__list_threads",
    "codex_app__load_workspace_dependencies",
    "codex.computer_use.list_apps",
    "shell_command",
  ];
  for (const name of required) {
    if (!names.has(name)) throw new Error(`Missing required real tool ${name}`);
  }
  const modelTool = tools.find(
    (tool) =>
      tool._meta?.omnicodex?.nativeName === "spawn_agent" &&
      tool._meta?.omnicodex?.modelEffect === "model",
  );
  const modelRequired = Array.isArray(modelTool?.inputSchema.required)
    ? modelTool.inputSchema.required
    : [];
  if (!modelRequired.includes("invokesModel")) {
    throw new Error("Model-backed collaboration tool is missing its explicit acknowledgement");
  }
  const dependencies = await client.callTool({
    name: "codex_app__load_workspace_dependencies",
    arguments: {},
  });
  if (dependencies.isError === true) throw new Error("Workspace dependency call failed");
  const computerUseApps = await client.callTool({
    name: "codex.computer_use.list_apps",
    arguments: {},
  });
  if (computerUseApps.isError === true) {
    const errorText = computerUseApps.content
      ?.filter((item) => item.type === "text")
      .map((item) => item.text)
      .join(" ");
    throw new Error(`Computer Use list_apps failed${errorText ? `: ${errorText}` : ""}`);
  }
  const browserInventory = await client.callTool({
    name: "codex.browser.exec",
    arguments: {
      title: "OmniCodex read-only browser inventory smoke",
      timeout_ms: 30_000,
      code: "console.log(JSON.stringify(await agent.browsers.list()))",
    },
  });
  if (browserInventory.isError === true) {
    const errorText = browserInventory.content
      ?.filter((item) => item.type === "text")
      .map((item) => item.text)
      .join(" ");
    throw new Error(`Browser inventory failed${errorText ? `: ${errorText}` : ""}`);
  }
  const threads = await client.callTool({
    name: "codex_app__list_threads",
    arguments: { limit: 1 },
  });
  if (threads.isError === true) throw new Error("Local App Server thread listing failed");
  await client.close();
  client = undefined;
  await transport.close();
  transport = undefined;
  await service.stop();
  stopped = true;
  const after = await Promise.all(protectedTargets.map(observeProtectedFile));
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("A protected Codex configuration file changed during the real gateway flow");
  }

  process.stdout.write(
    `${JSON.stringify({
      lifecycle: status.lifecycle,
      toolCount: tools.length,
      appServerMethodCount: status.appServerMethodCount,
      downstreamToolCount: status.downstreamToolCount,
      responsesToolCount: status.responsesToolCount,
      hostToolCount: status.hostToolCount,
      workspaceDependenciesReached: true,
      browserInventoryReached: true,
      computerUseListAppsReached: true,
      realThreadListReached: true,
      collaborationModelGate: true,
      surfacePresence: {
        applyPatch: names.has("apply_patch"),
        viewImage: names.has("view_image"),
        browserExecutor: names.has("codex.browser.exec"),
        computerUse: names.has("codex.computer_use.list_apps"),
        webSearch: names.has("web__run"),
        imageGeneration: names.has("image_gen__imagegen"),
      },
      relatedSurfaceNames: [...names]
        .filter((name) => /browser|chrome|computer|image|search|web/i.test(name))
        .sort(),
      protectedCodexFilesUnchanged: true,
    })}\n`,
  );
} finally {
  await client?.close().catch(() => undefined);
  await transport?.close().catch(() => undefined);
  if (!stopped) await service.stop();
}
