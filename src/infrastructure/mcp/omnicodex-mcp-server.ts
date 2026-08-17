import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type AppServerMethodCatalog,
  AppServerMethodExecutor,
} from "../../application/app-server-method-catalog.js";
import type { CodexHostToolAdapter } from "../../application/codex-host-tool-adapter.js";
import {
  type NativeExecutionOrdering,
  NativeExecutionScheduler,
} from "../../application/native-execution-scheduler.js";
import {
  type AppServerRpcClient,
  assertAppServerModelPolicy,
  isModelInvokingAppServerMethod,
  NativeToolCatalog,
  NativeToolExecutor,
} from "../../application/native-tool-catalog.js";
import {
  buildNativeToolRegistry,
  type NativeToolRegistryEntry,
  type NativeToolRegistrySnapshot,
} from "../../application/native-tool-registry.js";
import type {
  ResponsesNativeToolCatalog,
  ResponsesNativeToolExecutor,
} from "../../application/responses-native-tool-catalog.js";

export interface OmniCodexMcpServerOptions {
  readonly appServer: AppServerRpcClient;
  readonly appServerMethodCatalog?: AppServerMethodCatalog;
  readonly appServerMethodExecutor?: AppServerMethodExecutor;
  readonly nativeToolCatalog?: NativeToolCatalog;
  readonly nativeToolExecutor?: NativeToolExecutor;
  readonly responsesToolCatalog?: ResponsesNativeToolCatalog;
  readonly responsesToolExecutor?: ResponsesNativeToolExecutor;
  readonly hostToolAdapter?: CodexHostToolAdapter;
  readonly scheduler?: NativeExecutionScheduler;
  readonly serverName?: string;
  readonly serverVersion?: string;
  readonly surface?: "compat" | "full";
  readonly protectResult?: (
    result: CallToolResult,
    context: { readonly sessionId?: string },
  ) => Promise<CallToolResult> | CallToolResult;
}

export interface OmniCodexMcpServerHandle {
  readonly server: Server;
  readonly catalog: NativeToolCatalog;
  readonly executor: NativeToolExecutor;
  readonly appServerMethodCatalog: AppServerMethodCatalog | undefined;
  readonly appServerMethodExecutor: AppServerMethodExecutor;
  readonly responsesToolCatalog: ResponsesNativeToolCatalog | undefined;
  readonly responsesToolExecutor: ResponsesNativeToolExecutor | undefined;
  readonly hostToolAdapter: CodexHostToolAdapter | undefined;
  readonly scheduler: NativeExecutionScheduler;
  refresh(): Promise<void>;
}

const genericToolNames = ["search_native_tools", "call_native_tool", "app_server_rpc"] as const;

const FULL_LIST_PAGE_SIZE = 100;

/**
 * Creates the stable and dynamic MCP surfaces over an App Server JSON-RPC
 * client. The low-level Server API is used so downstream JSON Schemas remain
 * untouched instead of being reduced to a Zod subset.
 */
export function createOmniCodexMcpServer(
  options: OmniCodexMcpServerOptions,
): OmniCodexMcpServerHandle {
  const catalog =
    options.nativeToolCatalog ??
    new NativeToolCatalog(options.appServer, { reservedNames: genericToolNames });
  const executor = options.nativeToolExecutor ?? new NativeToolExecutor(options.appServer);
  const appServerMethodCatalog = options.appServerMethodCatalog;
  const appServerMethodExecutor =
    options.appServerMethodExecutor ?? new AppServerMethodExecutor(options.appServer);
  const surface = options.surface ?? "full";
  const responsesToolCatalog = options.responsesToolCatalog;
  const responsesToolExecutor = options.responsesToolExecutor;
  const hostToolAdapter = options.hostToolAdapter;
  const scheduler = options.scheduler ?? new NativeExecutionScheduler();
  const server = new Server(
    {
      name: options.serverName ?? "omnicodex",
      version: options.serverVersion ?? "0.0.0-development",
    },
    {
      capabilities: { tools: { listChanged: true } },
      instructions:
        "OmniCodex exposes the installed Codex App Server and downstream MCP tools. Ordinary native tool calls do not invoke a Codex model. Set invokesModel=true only for explicit model-backed App Server methods.",
    },
  );
  let currentRegistry: NativeToolRegistrySnapshot | undefined;
  let refreshInFlight: Promise<NativeToolRegistrySnapshot> | undefined;

  const refreshRegistry = async (): Promise<NativeToolRegistrySnapshot> => {
    if (refreshInFlight !== undefined) return refreshInFlight;
    refreshInFlight = (async () => {
      const [snapshot, methodSnapshot, responsesSnapshot] = await Promise.all([
        catalog.refresh(),
        appServerMethodCatalog?.refresh(),
        responsesToolCatalog?.refresh(),
      ]);
      const next = buildNativeToolRegistry({
        reservedNames: genericToolNames,
        hostTools: hostToolAdapter?.tools ?? [],
        appServerMethods: methodSnapshot?.methods ?? [],
        responsesTools: responsesSnapshot?.tools ?? [],
        downstreamTools: snapshot.tools,
      });
      const changed = currentRegistry !== undefined && currentRegistry.revision !== next.revision;
      currentRegistry = next;
      if (changed && surface === "full") await server.sendToolListChanged();
      return next;
    })();
    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = undefined;
    }
  };

  const registryForCall = (): Promise<NativeToolRegistrySnapshot> =>
    currentRegistry === undefined ? refreshRegistry() : Promise.resolve(currentRegistry);

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const refreshed = await refreshRegistry();
    if (surface === "compat") return { tools: stableTools() } satisfies ListToolsResult;
    return fullToolPage(refreshed, request.params?.cursor);
  });

  const dispatchToolCall = async (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> => {
    try {
      if (surface === "compat") {
        const registry = await registryForCall();
        if (name === "search_native_tools") {
          return searchNativeTools(registry, args);
        }
        if (name === "call_native_tool") {
          return await callNativeTool(
            registry,
            executor,
            responsesToolExecutor,
            hostToolAdapter,
            appServerMethodExecutor,
            scheduler,
            args,
            signal,
          );
        }
        if (name === "app_server_rpc") {
          return await callAppServerRpc(options.appServer, registry, args);
        }
        return errorResult(`Unknown OmniCodex compatibility tool: ${name}`);
      }

      const entry = (await registryForCall()).entries.find((item) => item.exposedName === name);
      if (entry === undefined) return errorResult(`Unknown OmniCodex tool: ${name}`);
      return await callRegistryEntry(
        entry,
        args,
        executor,
        responsesToolExecutor,
        hostToolAdapter,
        appServerMethodExecutor,
        scheduler,
        undefined,
        undefined,
        signal,
      );
    } catch (error) {
      return errorResult(toError(error).message);
    }
  };

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const result = await dispatchToolCall(
      request.params.name,
      request.params.arguments ?? {},
      extra.signal,
    );
    if (options.protectResult === undefined) return result;
    return options.protectResult(result, {
      ...(extra.sessionId === undefined ? {} : { sessionId: extra.sessionId }),
    });
  });

  return {
    server,
    catalog,
    executor,
    appServerMethodCatalog,
    appServerMethodExecutor,
    responsesToolCatalog,
    responsesToolExecutor,
    hostToolAdapter,
    scheduler,
    refresh: async () => {
      await refreshRegistry();
    },
  };
}

function stableTools(): Tool[] {
  return [
    {
      name: "search_native_tools",
      title: "Search Codex native tools",
      description: "Search the current installed Codex downstream MCP tool catalog.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Case-insensitive name, server, or description query.",
          },
          namespace: { type: "string" },
          kind: { type: "string" },
          modelEffect: { type: "string", enum: ["none", "model", "unknown"] },
          stateEffect: { type: "string", enum: ["none", "read", "mutate"] },
          limit: { type: "integer", minimum: 1, maximum: 200 },
          cursor: { type: "string" },
        },
        additionalProperties: false,
      },
      _meta: {
        omnicodex: {
          modelEffect: "none",
          invokesModel: false,
          stateEffect: "read",
          stable: true,
        },
      },
    } as Tool,
    {
      name: "call_native_tool",
      title: "Call a Codex native tool",
      description:
        "Call a model-free discovered native tool by its stable toolId or current public name.",
      inputSchema: {
        type: "object",
        oneOf: [
          { required: ["toolId"], not: { required: ["name"] } },
          { required: ["name"], not: { required: ["toolId"] } },
        ],
        properties: {
          toolId: { type: "string" },
          name: { type: "string", description: "Exposed name returned by search_native_tools." },
          arguments: { type: "object", additionalProperties: true },
          input: { type: "string" },
          payload: {},
          expectedCatalogRevision: { type: "string" },
          timeoutMs: { type: "integer", minimum: 1 },
          ordering: {
            type: "object",
            properties: {
              threadId: { type: "string" },
              processId: { type: "string" },
              filePaths: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      _meta: {
        omnicodex: {
          modelEffect: "none",
          invokesModel: false,
          stateEffect: "dynamic",
          stable: true,
        },
      },
    } as Tool,
    {
      name: "app_server_rpc",
      title: "Call Codex App Server JSON-RPC",
      description: "Call a method classified from the installed Codex App Server schema.",
      inputSchema: {
        type: "object",
        required: ["method"],
        properties: {
          method: { type: "string" },
          params: { type: "object", additionalProperties: true },
          allowModelInvocation: { type: "boolean", default: false },
          allowPersistentStateMutation: { type: "boolean", default: false },
          expectedCatalogRevision: { type: "string" },
          timeoutMs: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      _meta: {
        omnicodex: {
          modelEffect: "dynamic",
          invokesModel: null,
          stateEffect: "dynamic",
          stable: true,
        },
      },
    } as Tool,
  ];
}

function fullToolPage(
  registry: NativeToolRegistrySnapshot,
  cursor: string | undefined,
): ListToolsResult {
  const start = fullPageStart(registry, cursor);
  const tools = registry.tools.slice(start, start + FULL_LIST_PAGE_SIZE);
  const nextEntry = registry.entries[start + FULL_LIST_PAGE_SIZE - 1];
  const hasMore = start + tools.length < registry.tools.length;
  return {
    tools,
    ...(hasMore && nextEntry !== undefined
      ? { nextCursor: encodeCursor(registry.revision, nextEntry.toolId) }
      : {}),
  };
}

function fullPageStart(registry: NativeToolRegistrySnapshot, cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const decoded = decodeCursor(cursor);
  if (decoded.revision !== registry.revision) throw new Error("CATALOG_CHANGED");
  const index = registry.entries.findIndex((entry) => entry.toolId === decoded.lastToolId);
  if (index < 0) throw new Error("CATALOG_CHANGED");
  return index + 1;
}

function encodeCursor(revision: string, lastToolId: string): string {
  return Buffer.from(JSON.stringify({ surface: "full", revision, lastToolId }), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): { readonly revision: string; readonly lastToolId: string } {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("INVALID_CURSOR");
  }
  if (
    !isObject(value) ||
    value.surface !== "full" ||
    typeof value.revision !== "string" ||
    typeof value.lastToolId !== "string"
  ) {
    throw new Error("INVALID_CURSOR");
  }
  return { revision: value.revision, lastToolId: value.lastToolId };
}

function searchNativeTools(
  registry: NativeToolRegistrySnapshot,
  args: Record<string, unknown>,
): CallToolResult {
  const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
  const namespace = typeof args.namespace === "string" ? args.namespace : undefined;
  const kind = typeof args.kind === "string" ? args.kind : undefined;
  const modelEffect = typeof args.modelEffect === "string" ? args.modelEffect : undefined;
  const stateEffect = typeof args.stateEffect === "string" ? args.stateEffect : undefined;
  const limit =
    typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.max(1, Math.min(200, Math.trunc(args.limit)))
      : 50;
  const filtered = registry.entries.filter((entry) => {
    if (namespace !== undefined && entry.nativeNamespace !== namespace) return false;
    if (kind !== undefined && entry.kind !== kind) return false;
    if (modelEffect !== undefined && entry.modelEffect !== modelEffect) return false;
    if (stateEffect !== undefined && entry.stateEffect !== stateEffect) return false;
    if (query.length === 0) return true;
    const metadata = isObject(entry.tool._meta) ? entry.tool._meta.omnicodex : undefined;
    return [
      entry.exposedName,
      entry.catalogExposedName,
      entry.originalName,
      entry.source,
      entry.tool.title ?? "",
      entry.tool.description ?? "",
      isObject(metadata) ? JSON.stringify(metadata) : "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
  const filter = { query, namespace, kind, modelEffect, stateEffect };
  const start = searchPageStart(registry, filtered, args.cursor, filter);
  const page = filtered.slice(start, start + limit);
  const matches = page.map(registrySearchResult);
  const last = page.at(-1);
  const nextCursor =
    start + page.length < filtered.length && last !== undefined
      ? encodeSearchCursor(registry.revision, last.toolId, filter)
      : undefined;
  const structuredContent = {
    count: matches.length,
    tools: matches,
    catalogRevision: registry.revision,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function searchPageStart(
  registry: NativeToolRegistrySnapshot,
  entries: readonly NativeToolRegistryEntry[],
  cursorValue: unknown,
  filter: Record<string, unknown>,
): number {
  if (cursorValue === undefined) return 0;
  if (typeof cursorValue !== "string") throw new Error("INVALID_CURSOR");
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursorValue, "base64url").toString("utf8"));
  } catch {
    throw new Error("INVALID_CURSOR");
  }
  if (
    !isObject(decoded) ||
    decoded.surface !== "compat-search" ||
    decoded.revision !== registry.revision ||
    typeof decoded.lastToolId !== "string" ||
    JSON.stringify(decoded.filter) !== JSON.stringify(filter)
  ) {
    throw new Error("CATALOG_CHANGED");
  }
  const index = entries.findIndex((entry) => entry.toolId === decoded.lastToolId);
  if (index < 0) throw new Error("CATALOG_CHANGED");
  return index + 1;
}

function encodeSearchCursor(
  revision: string,
  lastToolId: string,
  filter: Record<string, unknown>,
): string {
  return Buffer.from(
    JSON.stringify({ surface: "compat-search", revision, lastToolId, filter }),
    "utf8",
  ).toString("base64url");
}

async function callNativeTool(
  registry: NativeToolRegistrySnapshot,
  executor: NativeToolExecutor,
  responsesToolExecutor: ResponsesNativeToolExecutor | undefined,
  hostToolAdapter: CodexHostToolAdapter | undefined,
  appServerMethodExecutor: AppServerMethodExecutor,
  scheduler: NativeExecutionScheduler,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const hasToolId = typeof args.toolId === "string" && args.toolId.length > 0;
  const hasName = typeof args.name === "string" && args.name.length > 0;
  if (hasToolId === hasName) {
    return errorResult("call_native_tool requires exactly one of toolId or name");
  }
  if (
    typeof args.expectedCatalogRevision === "string" &&
    args.expectedCatalogRevision !== registry.revision
  ) {
    return errorResult("CATALOG_CHANGED");
  }
  const entry = hasToolId
    ? registry.entries.find((item) => item.toolId === args.toolId)
    : registry.entries.find((item) => item.exposedName === args.name);
  if (entry === undefined) {
    return errorResult("Unknown generic native tool target");
  }
  if (entry.modelEffect === "model") {
    return errorResult(`Generic native calls cannot target model tool ${entry.exposedName}`);
  }
  if (entry.modelEffect === "unknown") {
    return errorResult(`Native tool ${entry.exposedName} has unknown model effect`);
  }
  const argumentsValue = genericArguments(entry, args);
  const ordering = isObject(args.ordering) ? args.ordering : {};
  const normalizedOrdering: NativeExecutionOrdering = {
    ...(typeof ordering.threadId === "string" ? { threadId: ordering.threadId } : {}),
    ...(typeof ordering.processId === "string" ? { processId: ordering.processId } : {}),
    ...(Array.isArray(ordering.filePaths)
      ? { filePaths: ordering.filePaths.filter((item): item is string => typeof item === "string") }
      : {}),
  };
  return callRegistryEntry(
    entry,
    argumentsValue,
    executor,
    responsesToolExecutor,
    hostToolAdapter,
    appServerMethodExecutor,
    scheduler,
    normalizedOrdering,
    typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
      ? Math.max(1, Math.trunc(args.timeoutMs))
      : undefined,
    signal,
  );
}

function genericArguments(entry: NativeToolRegistryEntry, args: Record<string, unknown>): unknown {
  if (
    entry.route === "responses" &&
    (entry.descriptor.kind === "custom" || entry.descriptor.kind === "freeform")
  ) {
    if (typeof args.input !== "string") throw new Error(`${entry.exposedName} requires input`);
    if (Object.hasOwn(args, "arguments") || Object.hasOwn(args, "payload")) {
      throw new Error(`${entry.exposedName} accepts only input`);
    }
    return { input: args.input };
  }
  if (entry.route === "responses" && entry.descriptor.kind === "unknown") {
    if (!Object.hasOwn(args, "payload")) throw new Error(`${entry.exposedName} requires payload`);
    if (Object.hasOwn(args, "arguments") || Object.hasOwn(args, "input")) {
      throw new Error(`${entry.exposedName} accepts only payload`);
    }
    return { payload: args.payload };
  }
  if (Object.hasOwn(args, "input") || Object.hasOwn(args, "payload")) {
    throw new Error(`${entry.exposedName} accepts arguments`);
  }
  const value = isObject(args.arguments) ? args.arguments : {};
  return usesArgumentsWrapper(entry) ? { arguments: value } : value;
}

function usesArgumentsWrapper(entry: NativeToolRegistryEntry): boolean {
  const metadata = isObject(entry.tool._meta) ? entry.tool._meta.omnicodex : undefined;
  return isObject(metadata) && metadata.inputSchemaTransform === "mcp_arguments_wrapper";
}

async function callRegistryEntry(
  entry: NativeToolRegistryEntry,
  argumentsValue: unknown,
  executor: NativeToolExecutor,
  responsesToolExecutor: ResponsesNativeToolExecutor | undefined,
  hostToolAdapter: CodexHostToolAdapter | undefined,
  appServerMethodExecutor: AppServerMethodExecutor,
  scheduler: NativeExecutionScheduler,
  ordering?: NativeExecutionOrdering,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  if (entry.modelEffect === "unknown") {
    throw new Error(`Native tool ${entry.exposedName} has unknown model effect`);
  }
  const result = await scheduler.run({ entry, ordering, timeoutMs, signal }, async () => {
    switch (entry.route) {
      case "host":
        if (hostToolAdapter === undefined)
          throw new Error("Codex host tool adapter is unavailable");
        return hostToolAdapter.call(
          entry.descriptor.name,
          isObject(argumentsValue) ? argumentsValue : {},
        );
      case "app_server":
        return appServerMethodExecutor.call(entry.descriptor, argumentsValue);
      case "responses":
        if (responsesToolExecutor === undefined)
          throw new Error("Responses native tool executor is unavailable");
        return responsesToolExecutor.call(entry.descriptor, argumentsValue);
      case "downstream":
        return callDownstreamTool(
          executor,
          entry.descriptor.server,
          entry.descriptor.originalName,
          downstreamArguments(entry, argumentsValue),
          ordering?.threadId,
        );
    }
  });
  return toCallToolResult(result, {
    tool: entry.exposedName,
    source: entry.source,
    originalName: entry.originalName,
    catalogExposedName: entry.catalogExposedName,
    route: entry.route,
  });
}

function downstreamArguments(
  entry: Extract<NativeToolRegistryEntry, { readonly route: "downstream" }>,
  argumentsValue: unknown,
): unknown {
  const metadata = isObject(entry.tool._meta) ? entry.tool._meta.omnicodex : undefined;
  if (isObject(metadata) && metadata.inputSchemaTransform === "mcp_arguments_wrapper") {
    if (!isObject(argumentsValue) || !isObject(argumentsValue.arguments)) {
      throw new Error(`${entry.exposedName} requires object arguments`);
    }
    return argumentsValue.arguments;
  }
  return argumentsValue;
}

function registrySearchResult(entry: NativeToolRegistryEntry): Record<string, unknown> {
  const result: Record<string, unknown> = {
    toolId: entry.toolId,
    source: entry.source,
    name: entry.exposedName,
    nativeName: entry.originalName,
    nativeNamespace: entry.nativeNamespace,
    kind: entry.kind,
    modelEffect: entry.modelEffect,
    invokesModel: entry.invokesModel,
    stateEffect: entry.stateEffect,
    route: objectValue(entry.tool._meta?.omnicodex).route,
    catalogRevision: objectValue(entry.tool._meta?.omnicodex).catalogRevision,
    catalogExposedName: entry.catalogExposedName,
    title: entry.tool.title,
    description: entry.tool.description,
    inputSchema: entry.tool.inputSchema,
  };
  if (entry.route === "downstream") result.server = entry.descriptor.server;
  if (entry.route === "app_server") result.server = "app-server";
  if (entry.route === "responses") {
    result.server = entry.descriptor.nativeNamespace ?? "responses";
  }
  return result;
}

async function callDownstreamTool(
  executor: NativeToolExecutor,
  server: string,
  tool: string,
  argumentsValue: unknown,
  threadId?: string,
): Promise<unknown> {
  return executor.call(server, tool, argumentsValue, threadId);
}

async function callAppServerRpc(
  appServer: AppServerRpcClient,
  registry: NativeToolRegistrySnapshot,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  if (typeof args.method !== "string" || args.method.length === 0) {
    return errorResult("app_server_rpc requires a non-empty method");
  }
  if (
    typeof args.expectedCatalogRevision === "string" &&
    args.expectedCatalogRevision !== registry.revision
  ) {
    return errorResult("CATALOG_CHANGED");
  }
  const entry = registry.entries.find(
    (item) => item.route === "app_server" && item.descriptor.method === args.method,
  );
  if (entry === undefined) {
    return errorResult(`App Server method ${args.method} has no catalog classification`);
  }
  if (entry.modelEffect === "unknown") {
    return errorResult(`App Server method ${args.method} has unknown model effect`);
  }
  const allowModelInvocation = args.allowModelInvocation === true;
  if (entry.modelEffect === "model" && !allowModelInvocation) {
    return errorResult("MODEL_INVOCATION_NOT_EXPLICIT");
  }
  if (entry.stateEffect === "mutate" && args.allowPersistentStateMutation !== true) {
    return errorResult("PERSISTENT_STATE_MUTATION_NOT_EXPLICIT");
  }
  assertAppServerModelPolicy(args.method, { invokesModel: allowModelInvocation });
  const timeoutMs =
    typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
      ? Math.max(1, Math.trunc(args.timeoutMs))
      : undefined;
  const result = await appServer.request(args.method, args.params ?? {}, timeoutMs);
  return toCallToolResult(result, {
    method: args.method,
    toolId: entry.toolId,
    catalogRevision: registry.revision,
    modelEffect: entry.modelEffect,
    invokesModel: allowModelInvocation,
    modelMethod: isModelInvokingAppServerMethod(args.method),
    stateEffect: entry.stateEffect,
  });
}

function toCallToolResult(value: unknown, metadata: Record<string, unknown>): CallToolResult {
  if (isObject(value) && Array.isArray(value.content)) {
    const valueMeta = isObject(value._meta) ? value._meta : {};
    const valueOmniMeta = isObject(valueMeta.omnicodex) ? valueMeta.omnicodex : {};
    return {
      content: value.content as CallToolResult["content"],
      ...(isObject(value.structuredContent) ? { structuredContent: value.structuredContent } : {}),
      ...(typeof value.isError === "boolean" ? { isError: value.isError } : {}),
      _meta: {
        ...valueMeta,
        omnicodex: { ...valueOmniMeta, ...metadata },
      },
    };
  }
  const text = stringify(value);
  return {
    content: [{ type: "text", text }],
    structuredContent: isObject(value) ? value : undefined,
    _meta: { omnicodex: metadata },
  };
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function stringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectValue(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
