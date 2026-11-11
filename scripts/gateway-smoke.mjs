import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OmniCodexGatewayService } from "../dist/application/omnicodex-gateway-service.js";
import { observeProtectedFile } from "../dist/infrastructure/safety/protected-file-snapshot.js";

const protectedResourceMetadata = {
  resource: "https://gateway-smoke.invalid/mcp",
  authorization_servers: ["https://gateway-smoke.invalid/"],
  scopes_supported: ["omnicodex:full"],
  bearer_methods_supported: ["header"],
};
const isolatedCodexHome = await mkdtemp(join(tmpdir(), "omnicodex-runtime-probe-"));
const resolvedIsolatedCodexHome = resolve(isolatedCodexHome);
const relativeToSystemTemporary = relative(resolve(tmpdir()), resolvedIsolatedCodexHome);
if (
  relativeToSystemTemporary.length === 0 ||
  relativeToSystemTemporary.startsWith("..") ||
  isAbsolute(relativeToSystemTemporary) ||
  !resolvedIsolatedCodexHome.includes("omnicodex-runtime-probe-")
) {
  throw new Error("Refusing to use an unverified isolated Codex home");
}
const previousCodexHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = resolvedIsolatedCodexHome;
const service = new OmniCodexGatewayService({
  cwd: process.cwd(),
  protectedResourceMetadata,
  authorize: (request) => {
    const requestPath = new URL(request.url ?? "/mcp", protectedResourceMetadata.resource).pathname;
    const resource =
      requestPath === "/mcp/full"
        ? `${protectedResourceMetadata.resource}/full`
        : protectedResourceMetadata.resource;
    return {
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
    };
  },
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
    "codex__computer_use__list_apps",
    "shell_command",
  ];
  for (const name of required) {
    if (!names.has(name)) throw new Error(`Missing required real tool ${name}`);
  }
  const modelTool = tools.find((tool) => tool.name === "codex__collaboration__spawn_agent");
  if (
    modelTool?._meta?.omnicodex?.nativeName !== "spawn_agent" ||
    modelTool?._meta?.omnicodex?.nativeNamespace !== "collaboration" ||
    modelTool?._meta?.omnicodex?.modelEffect !== "model" ||
    modelTool?._meta?.omnicodex?.invokesModel !== true ||
    modelTool?._meta?.omnicodex?.stateEffect !== "mutate"
  ) {
    throw new Error("Public action catalog omitted native model and state-effect metadata");
  }
  const dependencies = await client.callTool({
    name: "codex_app__load_workspace_dependencies",
    arguments: {},
  });
  if (dependencies.isError === true) throw new Error("Workspace dependency call failed");
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
    const changed = before
      .filter((observation, index) => JSON.stringify(observation) !== JSON.stringify(after[index]))
      .map((observation) => observation.logicalName);
    throw new Error(
      `Protected Codex files changed during the real gateway flow: ${changed.join(",")}`,
    );
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
      browserInventoryAdvertised: names.has("browser__list_surfaces"),
      computerUseListAppsAdvertised: names.has("codex__computer_use__list_apps"),
      realThreadListReached: true,
      collaborationExecutionMetadataPreserved: true,
      surfacePresence: {
        applyPatch: names.has("apply_patch"),
        viewImage: names.has("view_image"),
        browserExecutor: names.has("browser__list_surfaces"),
        computerUse: names.has("codex__computer_use__list_apps"),
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
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  await rm(resolvedIsolatedCodexHome, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}
