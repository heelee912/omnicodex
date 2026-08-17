import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface AppServerRpcClient {
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
}

export interface NativeToolDescriptor {
  readonly exposedName: string;
  readonly server: string;
  readonly originalName: string;
  readonly tool: Tool;
}

export interface NativeToolCatalogSnapshot {
  readonly refreshedAtUnixMs: number;
  readonly servers: readonly string[];
  readonly tools: readonly NativeToolDescriptor[];
}

export interface NativeToolCatalogOptions {
  readonly reservedNames?: readonly string[];
  readonly maxPages?: number;
  readonly pageSize?: number;
}

interface McpStatusPage {
  readonly data?: unknown;
  readonly nextCursor?: unknown;
}

interface McpServerStatus {
  readonly name?: unknown;
  readonly tools?: unknown;
}

/** Reads the actual downstream MCP inventory advertised by the installed App Server. */
export class NativeToolCatalog {
  readonly #client: AppServerRpcClient;
  readonly #reservedNames: ReadonlySet<string>;
  readonly #maxPages: number;
  readonly #pageSize: number;
  #snapshot: NativeToolCatalogSnapshot = {
    refreshedAtUnixMs: 0,
    servers: [],
    tools: [],
  };

  constructor(client: AppServerRpcClient, options: NativeToolCatalogOptions = {}) {
    this.#client = client;
    this.#reservedNames = new Set(options.reservedNames ?? []);
    this.#maxPages = options.maxPages ?? 100;
    this.#pageSize = options.pageSize ?? 1_000;
  }

  get snapshot(): NativeToolCatalogSnapshot {
    return this.#snapshot;
  }

  async refresh(threadId?: string): Promise<NativeToolCatalogSnapshot> {
    const statuses: McpServerStatus[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < this.#maxPages; page += 1) {
      const params = {
        detail: "full",
        limit: this.#pageSize,
        ...(cursor === undefined ? {} : { cursor }),
        ...(threadId === undefined ? {} : { threadId }),
      };
      const response = await this.#client.request<McpStatusPage>("mcpServerStatus/list", params);
      const data = Array.isArray(response.data) ? response.data : [];
      for (const item of data) {
        if (isObject(item)) {
          statuses.push(item as McpServerStatus);
        }
      }
      const next = typeof response.nextCursor === "string" ? response.nextCursor : undefined;
      if (next === undefined || next === cursor) {
        break;
      }
      cursor = next;
    }

    const serverNames = statuses
      .map((status) => (typeof status.name === "string" ? status.name : undefined))
      .filter((name): name is string => name !== undefined)
      .sort((left, right) => left.localeCompare(right));
    const rawTools: Array<{
      readonly server: string;
      readonly originalName: string;
      readonly tool: Tool;
    }> = [];
    for (const status of statuses) {
      const server = typeof status.name === "string" ? status.name : "unknown";
      if (!isObject(status.tools)) {
        continue;
      }
      for (const [originalName, rawTool] of Object.entries(status.tools)) {
        if (!isObject(rawTool)) {
          continue;
        }
        const tool = normalizeTool(rawTool, originalName);
        const nativeName = typeof rawTool.name === "string" ? rawTool.name : originalName;
        rawTools.push({ server, originalName: nativeName, tool });
      }
    }

    const counts = new Map<string, number>();
    for (const item of rawTools) {
      counts.set(item.originalName, (counts.get(item.originalName) ?? 0) + 1);
    }
    const tools = rawTools
      .sort(
        (left, right) =>
          left.server.localeCompare(right.server) ||
          left.originalName.localeCompare(right.originalName),
      )
      .map((item) => {
        const canPreserve =
          counts.get(item.originalName) === 1 &&
          isMcpToolName(item.originalName) &&
          !this.#reservedNames.has(item.originalName);
        const exposedName = canPreserve
          ? item.originalName
          : namespacedToolName(item.server, item.originalName);
        return {
          exposedName,
          server: item.server,
          originalName: item.originalName,
          tool: withOmniMetadata(item.tool, {
            exposedName,
            server: item.server,
            originalName: item.originalName,
          }),
        };
      });

    this.#snapshot = {
      refreshedAtUnixMs: Date.now(),
      servers: [...new Set(serverNames)],
      tools,
    };
    return this.#snapshot;
  }
}

export interface NativeToolExecutorOptions {
  readonly threadId?: string;
  readonly cwd?: string;
  readonly ensureThread?: () => Promise<string>;
}

/** Calls an App Server MCP tool directly, creating an ephemeral context only when needed. */
export class NativeToolExecutor {
  readonly #client: AppServerRpcClient;
  readonly #options: NativeToolExecutorOptions;
  #ephemeralThreadId: string | undefined;

  constructor(client: AppServerRpcClient, options: NativeToolExecutorOptions = {}) {
    this.#client = client;
    this.#options = options;
  }

  async call(
    server: string,
    tool: string,
    argumentsValue: unknown,
    threadId = this.#options.threadId,
  ): Promise<unknown> {
    const selectedThreadId = threadId ?? (await this.#ensureEphemeralThread());
    return this.#client.request("mcpServer/tool/call", {
      server,
      threadId: selectedThreadId,
      tool,
      arguments: argumentsValue,
    });
  }

  async #ensureEphemeralThread(): Promise<string> {
    if (this.#ephemeralThreadId !== undefined) {
      return this.#ephemeralThreadId;
    }
    if (this.#options.ensureThread !== undefined) {
      this.#ephemeralThreadId = await this.#options.ensureThread();
      return this.#ephemeralThreadId;
    }
    const response = await this.#client.request<unknown>("thread/start", {
      approvalPolicy: "never",
      cwd: this.#options.cwd ?? null,
      ephemeral: true,
      model: null,
      modelProvider: null,
      sandbox: "danger-full-access",
    });
    const threadId =
      isObject(response) && isObject(response.thread) ? response.thread.id : undefined;
    if (typeof threadId !== "string" || threadId.length === 0) {
      throw new Error("Codex App Server did not return an ephemeral thread id");
    }
    this.#ephemeralThreadId = threadId;
    return threadId;
  }
}

export interface AppServerRpcOptions {
  readonly invokesModel?: boolean;
}

export function assertAppServerModelPolicy(
  method: string,
  options: AppServerRpcOptions = {},
): void {
  if (modelMethods.has(method) && options.invokesModel !== true) {
    throw new Error(`App Server method ${method} requires invokesModel=true`);
  }
}

export function isModelInvokingAppServerMethod(method: string): boolean {
  return modelMethods.has(method);
}

const modelMethods = new Set([
  "review/start",
  "thread/compact/start",
  "thread/realtime/start",
  "thread/realtime/appendAudio",
  "thread/realtime/appendText",
  "thread/realtime/appendSpeech",
  "turn/start",
  "turn/steer",
]);

function normalizeTool(rawTool: Record<string, unknown>, fallbackName: string): Tool {
  const originalInputSchema = rawTool.inputSchema;
  const validInputSchema = isMcpObjectSchema(originalInputSchema);
  const inputSchema = normalizeMcpInputSchema(originalInputSchema);
  const originalOutputSchema = rawTool.outputSchema;
  const outputSchema = isMcpObjectSchema(originalOutputSchema) ? originalOutputSchema : undefined;
  const name = typeof rawTool.name === "string" ? rawTool.name : fallbackName;
  const existingMeta = isObject(rawTool._meta) ? rawTool._meta : {};
  const existingOmniMeta = isObject(existingMeta.omnicodex) ? existingMeta.omnicodex : {};
  const tool = {
    name,
    inputSchema,
    ...(typeof rawTool.title === "string" ? { title: rawTool.title } : {}),
    ...(typeof rawTool.description === "string" ? { description: rawTool.description } : {}),
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(isObject(rawTool.annotations) ? { annotations: rawTool.annotations } : {}),
    ...(isObject(rawTool.execution) ? { execution: rawTool.execution } : {}),
    _meta: {
      ...existingMeta,
      omnicodex: {
        ...existingOmniMeta,
        ...(Object.keys(existingOmniMeta).length === 0
          ? {}
          : { nativeOmnicodex: structuredClone(existingOmniMeta) }),
        ...(!validInputSchema
          ? {
              originalInputSchema: originalInputSchema ?? null,
              inputSchemaTransform: "mcp_arguments_wrapper",
              inputSchemaValidationError: invalidSchemaReason(originalInputSchema),
            }
          : {}),
        ...(originalOutputSchema !== undefined && outputSchema === undefined
          ? { originalOutputSchema, outputSchemaTransform: "omitted_invalid_mcp_object_schema" }
          : {}),
      },
    },
  };
  return tool as unknown as Tool;
}

function withOmniMetadata(
  tool: Tool,
  metadata: {
    readonly exposedName: string;
    readonly server: string;
    readonly originalName: string;
  },
): Tool {
  return {
    ...tool,
    name: metadata.exposedName,
    _meta: {
      ...(isObject(tool._meta) ? tool._meta : {}),
      omnicodex: {
        ...(isObject(tool._meta) && isObject(tool._meta.omnicodex) ? tool._meta.omnicodex : {}),
        source: "codex_app_server_mcp",
        server: metadata.server,
        originalName: metadata.originalName,
        exposedName: metadata.exposedName,
      },
    },
  } as Tool;
}

function normalizeMcpInputSchema(value: unknown): Record<string, unknown> & { type: "object" } {
  if (isMcpObjectSchema(value)) {
    return value;
  }
  return {
    type: "object",
    properties: {
      arguments: { type: "object", additionalProperties: true },
    },
    required: ["arguments"],
    additionalProperties: false,
  };
}

function isMcpObjectSchema(value: unknown): value is Record<string, unknown> & { type: "object" } {
  if (!isObject(value) || value.type !== "object") return false;
  if (value.properties !== undefined && !isObject(value.properties)) return false;
  if (
    value.required !== undefined &&
    (!Array.isArray(value.required) || value.required.some((item) => typeof item !== "string"))
  ) {
    return false;
  }
  return true;
}

function invalidSchemaReason(value: unknown): string {
  if (value === undefined) return "Native input schema was absent";
  if (!isObject(value)) return "Native input schema was not a JSON object schema";
  if (value.type !== "object") return 'Native input schema type was not "object"';
  return "Native input schema was invalid";
}

function isMcpToolName(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_.-]+$/.test(value);
}

function namespacedToolName(server: string, tool: string): string {
  const base = `codex__${sanitize(server)}__${sanitize(tool)}`;
  if (base.length <= 128) {
    return base;
  }
  const digest = createHash("sha256")
    .update(`${server}\n${tool}`, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `${base.slice(0, 115)}__${digest}`;
}

function sanitize(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.-]+/g, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
