import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  ResponsesNativeToolSpec,
  ResponsesSelectedToolCall,
  ResponsesToolCatalogSnapshot,
  ResponsesToolExecutionResult,
  ResponsesToolKind,
} from "../infrastructure/runtime/responses-loopback-driver.js";

export interface ResponsesCatalogSource {
  readonly snapshot: ResponsesToolCatalogSnapshot;
}

export interface ResponsesExecutionSource {
  call(selection: ResponsesSelectedToolCall): Promise<ResponsesToolExecutionResult>;
  callNested?(name: string, argumentsValue: unknown, freeform: boolean): Promise<unknown>;
  callMcp?(server: string, tool: string, argumentsValue: unknown): Promise<unknown>;
}

export type ResponsesExecutionMode = "responses_call" | "functions_exec_nested";

export interface ResponsesNativeToolDescriptor {
  readonly exposedName: string;
  readonly nativeName: string;
  readonly nativeNamespace: string | undefined;
  readonly kind: Exclude<ResponsesToolKind, "namespace">;
  readonly executionMode: ResponsesExecutionMode;
  readonly modelEffect: "none" | "model" | "unknown";
  readonly invokesModel: boolean | null;
  readonly nativeSpec: ResponsesNativeToolSpec;
  readonly tool: Tool;
}

export interface ResponsesNativeToolCatalogSnapshot {
  readonly refreshedAtUnixMs: number;
  readonly sourceRequestCount: number;
  readonly tools: readonly ResponsesNativeToolDescriptor[];
}

export interface ResponsesNativeToolCatalogOptions {
  readonly reservedNames?: readonly string[];
}

/** Flattens the exact Responses tool specs emitted by the installed runtime. */
export class ResponsesNativeToolCatalog {
  readonly #source: ResponsesCatalogSource;
  readonly #reservedNames: ReadonlySet<string>;
  #snapshot: ResponsesNativeToolCatalogSnapshot = {
    refreshedAtUnixMs: 0,
    sourceRequestCount: 0,
    tools: [],
  };

  constructor(source: ResponsesCatalogSource, options: ResponsesNativeToolCatalogOptions = {}) {
    this.#source = source;
    this.#reservedNames = new Set(options.reservedNames ?? []);
  }

  get snapshot(): ResponsesNativeToolCatalogSnapshot {
    return this.#snapshot;
  }

  async refresh(): Promise<ResponsesNativeToolCatalogSnapshot> {
    const source = this.#source.snapshot;
    const entries = flattenSpecs(source.tools, source.nestedTools ?? []);
    const nameCounts = new Map<string, number>();
    for (const entry of entries) {
      nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
    }
    const exposedNames = allocateExposedToolNames(entries, nameCounts, this.#reservedNames);
    const tools = entries
      .map((entry, index) => {
        const exposedName = exposedNames[index];
        if (exposedName === undefined) throw new Error("Responses tool name allocation failed");
        const kind = classifyKind(entry.spec);
        const modelEffect = modelEffectFor(kind, entry.namespace, entry.name, entry.spec);
        const invokesModel = modelEffect === "model" ? true : modelEffect === "none" ? false : null;
        const tool = toMcpTool(entry.spec, {
          exposedName,
          nativeName: entry.name,
          nativeNamespace: entry.namespace,
          kind,
          executionMode: entry.executionMode,
          modelEffect,
          invokesModel,
          ...(entry.namespaceSpec === undefined ? {} : { namespaceSpec: entry.namespaceSpec }),
        });
        return {
          exposedName,
          nativeName: entry.name,
          nativeNamespace: entry.namespace,
          kind,
          executionMode: entry.executionMode,
          modelEffect,
          invokesModel,
          nativeSpec: structuredClone(entry.spec),
          tool,
        } satisfies ResponsesNativeToolDescriptor;
      })
      .sort((left, right) => left.exposedName.localeCompare(right.exposedName, "en"));
    this.#snapshot = {
      refreshedAtUnixMs: Date.now(),
      sourceRequestCount: source.requestCount,
      tools,
    };
    return this.#snapshot;
  }
}

export class ResponsesNativeToolExecutor {
  readonly #source: ResponsesExecutionSource;

  constructor(source: ResponsesExecutionSource) {
    this.#source = source;
  }

  async call(descriptor: ResponsesNativeToolDescriptor, argumentsValue: unknown): Promise<unknown> {
    const nativeArguments = modelCheckedArguments(descriptor, argumentsValue);
    if (descriptor.executionMode === "functions_exec_nested") {
      if (this.#source.callNested === undefined) {
        throw new Error("Codex functions.exec nested-tool bridge is unavailable");
      }
      return this.#source.callNested(
        descriptor.nativeName,
        nativeArguments,
        descriptor.kind === "freeform" || descriptor.kind === "custom",
      );
    }
    const result = await this.#source.call({
      kind: descriptor.kind,
      name: descriptor.nativeName,
      ...(descriptor.nativeNamespace === undefined
        ? {}
        : { namespace: descriptor.nativeNamespace }),
      arguments: nativeArguments,
    });
    const content = nativeResultContent(result.output);
    return {
      output: result.output,
      outputType: result.outputType,
      callId: result.callId,
      rawItem: result.rawItem,
      ...(content === undefined
        ? {}
        : {
            content,
            structuredContent: {
              output: result.output,
              outputType: result.outputType,
              callId: result.callId,
              rawItem: result.rawItem,
            },
          }),
      _meta: {
        omnicodex: {
          source: "codex_responses_runtime",
          execution: "model_free_loopback",
          nativeName: descriptor.nativeName,
          nativeNamespace: descriptor.nativeNamespace,
          kind: descriptor.kind,
          executionMode: descriptor.executionMode,
          invokesModel: descriptor.invokesModel,
        },
      },
    };
  }

  async callNested(name: string, argumentsValue: unknown, freeform = false): Promise<unknown> {
    if (this.#source.callNested === undefined) {
      throw new Error("Codex functions.exec nested-tool bridge is unavailable");
    }
    return this.#source.callNested(name, argumentsValue, freeform);
  }

  async callMcp(server: string, tool: string, argumentsValue: unknown): Promise<unknown> {
    if (this.#source.callMcp === undefined) {
      throw new Error("Codex downstream MCP Responses bridge is unavailable");
    }
    return this.#source.callMcp(server, tool, argumentsValue);
  }
}

function nativeResultContent(output: unknown): Record<string, unknown>[] | undefined {
  if (typeof output === "string") return [{ type: "text", text: output }];
  const candidates = Array.isArray(output)
    ? output
    : isObject(output) && Array.isArray(output.content)
      ? output.content
      : [output];
  const content = candidates.flatMap(nativeContentBlock);
  return content.length === 0 ? undefined : content;
}

function nativeContentBlock(value: unknown): Record<string, unknown>[] {
  if (!isObject(value)) return [];
  if (value.type === "text" && typeof value.text === "string") {
    return [{ ...value, type: "text", text: value.text }];
  }
  if (
    (value.type === "input_text" || value.type === "output_text") &&
    typeof value.text === "string"
  ) {
    return [{ type: "text", text: value.text }];
  }
  if (
    value.type === "image" &&
    typeof value.data === "string" &&
    typeof value.mimeType === "string"
  ) {
    return [{ ...value, type: "image", data: value.data, mimeType: value.mimeType }];
  }
  if (
    value.type === "audio" &&
    typeof value.data === "string" &&
    typeof value.mimeType === "string"
  ) {
    return [{ ...value, type: "audio", data: value.data, mimeType: value.mimeType }];
  }
  if (
    (value.type === "input_image" || value.type === "generated_image") &&
    typeof value.image_url === "string"
  ) {
    const image = dataUrlImage(value.image_url);
    return image === undefined ? [] : [image];
  }
  if (value.type === "image_generation_call" && typeof value.result === "string") {
    return [{ type: "image", data: value.result, mimeType: "image/png" }];
  }
  if (value.type === "resource" && isObject(value.resource)) {
    return [{ ...value, type: "resource", resource: value.resource }];
  }
  if (
    value.type === "resource_link" &&
    typeof value.name === "string" &&
    typeof value.uri === "string"
  ) {
    return [{ ...value, type: "resource_link", name: value.name, uri: value.uri }];
  }
  return [];
}

function dataUrlImage(value: string): Record<string, unknown> | undefined {
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=_-]+)$/.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  return { type: "image", mimeType: match[1], data: match[2] };
}

interface FlatSpec {
  readonly namespace: string | undefined;
  readonly name: string;
  readonly spec: ResponsesNativeToolSpec;
  readonly executionMode: ResponsesExecutionMode;
  readonly namespaceSpec?: ResponsesNativeToolSpec;
}

function flattenSpecs(
  specs: readonly ResponsesNativeToolSpec[],
  nestedTools: readonly { readonly name: string; readonly description: string }[],
): FlatSpec[] {
  const result: FlatSpec[] = [];
  for (const spec of specs) {
    if (spec.type === "namespace" && typeof spec.name === "string" && Array.isArray(spec.tools)) {
      for (const inner of spec.tools) {
        if (!isObject(inner)) {
          continue;
        }
        const name = callableName(inner);
        if (name === undefined) {
          continue;
        }
        result.push({
          namespace: spec.name,
          name,
          executionMode: "responses_call",
          namespaceSpec: spec,
          spec: {
            ...inner,
            type: typeof inner.type === "string" ? inner.type : "unknown",
          },
        });
      }
      continue;
    }
    const name = callableName(spec);
    if (name !== undefined) {
      result.push({ namespace: undefined, name, spec, executionMode: "responses_call" });
    }
  }
  for (const nested of nestedTools) {
    const freeform = isFreeformDescription(nested.name, nested.description);
    result.push({
      namespace: undefined,
      name: nested.name,
      executionMode: "functions_exec_nested",
      spec: {
        type: freeform ? "freeform" : "function",
        name: nested.name,
        description: nested.description,
        ...(freeform ? {} : { parameters: { type: "object", additionalProperties: true } }),
      },
    });
  }
  return result;
}

function callableName(spec: Record<string, unknown>): string | undefined {
  if (typeof spec.name === "string" && spec.name.length > 0) {
    return spec.name;
  }
  return spec.type === "tool_search" ? "tool_search" : undefined;
}

function classifyKind(spec: ResponsesNativeToolSpec): Exclude<ResponsesToolKind, "namespace"> {
  switch (spec.type) {
    case "function":
      return "function";
    case "custom":
      return "custom";
    case "freeform":
      return "freeform";
    case "tool_search":
      return "tool_search";
    default:
      return "unknown";
  }
}

function exposedToolName(
  entry: FlatSpec,
  counts: ReadonlyMap<string, number>,
  reservedNames: ReadonlySet<string>,
): string {
  const canPreserve =
    entry.namespace === undefined &&
    counts.get(entry.name) === 1 &&
    isMcpToolName(entry.name) &&
    !reservedNames.has(entry.name);
  if (canPreserve) {
    return entry.name;
  }
  const namespace = entry.namespace ?? "responses";
  const base = `codex__${sanitize(namespace)}__${sanitize(entry.name)}`;
  if (base.length <= 128 && !reservedNames.has(base)) {
    return base;
  }
  const digest = createHash("sha256")
    .update(`${namespace}\n${entry.name}`, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `${base.slice(0, 113)}__${digest}`;
}

function allocateExposedToolNames(
  entries: readonly FlatSpec[],
  counts: ReadonlyMap<string, number>,
  reservedNames: ReadonlySet<string>,
): string[] {
  const bases = entries.map((entry) => exposedToolName(entry, counts, reservedNames));
  const baseCounts = new Map<string, number>();
  for (const base of bases) baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  const used = new Set<string>();
  return entries.map((entry, index) => {
    const base = bases[index] ?? "codex__responses__unknown";
    if (baseCounts.get(base) === 1 && !used.has(base) && !reservedNames.has(base)) {
      used.add(base);
      return base;
    }
    const identity = `${entry.namespace ?? "root"}\n${entry.name}\n${entry.executionMode}\n${stableJson(entry.spec)}`;
    for (let ordinal = 1; ordinal < 10_000; ordinal += 1) {
      const suffix = createHash("sha256")
        .update(`${identity}\n${ordinal}`, "utf8")
        .digest("hex")
        .slice(0, 12);
      const candidate = `${base.slice(0, 113)}__${suffix}`;
      if (!used.has(candidate) && !reservedNames.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
    throw new Error(`Unable to allocate a unique Responses tool name for ${identity}`);
  });
}

function toMcpTool(
  spec: ResponsesNativeToolSpec,
  identity: {
    readonly exposedName: string;
    readonly nativeName: string;
    readonly nativeNamespace: string | undefined;
    readonly kind: Exclude<ResponsesToolKind, "namespace">;
    readonly executionMode: ResponsesExecutionMode;
    readonly modelEffect: "none" | "model" | "unknown";
    readonly invokesModel: boolean | null;
    readonly namespaceSpec?: ResponsesNativeToolSpec;
  },
): Tool {
  const schema = inputSchemaFor(spec, identity.kind);
  const baseInputSchema = schema.inputSchema;
  const inputSchema = identity.invokesModel
    ? requireModelAcknowledgement(baseInputSchema)
    : baseInputSchema;
  const existingMeta = isObject(spec._meta) ? spec._meta : {};
  const existingOmniMeta = isObject(existingMeta.omnicodex) ? existingMeta.omnicodex : {};
  return {
    name: identity.exposedName,
    ...(typeof spec.description === "string" ? { description: spec.description } : {}),
    inputSchema,
    _meta: {
      ...existingMeta,
      omnicodex: {
        ...existingOmniMeta,
        source: "codex_responses_runtime",
        execution:
          identity.executionMode === "responses_call" ? "model_free_loopback" : "functions.exec",
        nativeName: identity.nativeName,
        nativeNamespace: identity.nativeNamespace,
        kind: identity.kind,
        modelEffect: identity.modelEffect,
        invokesModel: identity.invokesModel,
        originalSpec: structuredClone(spec),
        ...(identity.namespaceSpec === undefined
          ? {}
          : { originalNamespaceSpec: structuredClone(identity.namespaceSpec) }),
        ...(schema.inputSchemaTransform === undefined
          ? {}
          : { inputSchemaTransform: schema.inputSchemaTransform }),
        ...(schema.validationError === undefined
          ? {}
          : { inputSchemaValidationError: schema.validationError }),
      },
    },
  } as unknown as Tool;
}

function modelEffectFor(
  kind: Exclude<ResponsesToolKind, "namespace">,
  namespace: string | undefined,
  name: string,
  spec: ResponsesNativeToolSpec,
): "none" | "model" | "unknown" {
  const metadata = isObject(spec._meta) ? spec._meta : {};
  const omnicodex = isObject(metadata.omnicodex) ? metadata.omnicodex : {};
  if (
    omnicodex.modelEffect === "none" ||
    omnicodex.modelEffect === "model" ||
    omnicodex.modelEffect === "unknown"
  ) {
    return omnicodex.modelEffect;
  }
  if (namespace === "collaboration" && (name === "spawn_agent" || name === "followup_task")) {
    return "model";
  }
  return kind === "unknown" ? "unknown" : "none";
}

function modelCheckedArguments(
  descriptor: ResponsesNativeToolDescriptor,
  argumentsValue: unknown,
): unknown {
  if (descriptor.modelEffect === "unknown") {
    throw new Error(`Responses tool ${descriptor.exposedName} has unknown model effect`);
  }
  let result = argumentsValue;
  if (descriptor.modelEffect === "model") {
    if (!isObject(argumentsValue) || argumentsValue.invokesModel !== true) {
      throw new Error(`Responses tool ${descriptor.exposedName} requires invokesModel=true`);
    }
    const acknowledged = { ...argumentsValue };
    delete acknowledged.invokesModel;
    result = acknowledged;
  }
  return unwrapPublicArguments(descriptor, result);
}

function requireModelAcknowledgement(
  schema: Record<string, unknown> & { type: "object" },
): Record<string, unknown> & { type: "object" } {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  return {
    ...schema,
    properties: {
      ...properties,
      invokesModel: { type: "boolean", const: true },
    },
    required: [...new Set([...required, "invokesModel"])],
  };
}

interface PublicInputSchema {
  readonly inputSchema: Record<string, unknown> & { type: "object" };
  readonly inputSchemaTransform?: string;
  readonly validationError?: string;
}

function inputSchemaFor(
  spec: ResponsesNativeToolSpec,
  kind: Exclude<ResponsesToolKind, "namespace">,
): PublicInputSchema {
  if (kind === "custom" || kind === "freeform") {
    return {
      inputSchema: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
        additionalProperties: false,
      },
      inputSchemaTransform: "mcp_freeform_input_wrapper",
    };
  }
  const candidate = spec.parameters ?? spec.inputSchema;
  if (kind === "unknown") {
    return {
      inputSchema: {
        type: "object",
        properties: { payload: true, contentType: { type: "string" } },
        required: ["payload"],
        additionalProperties: false,
      },
      inputSchemaTransform: "mcp_unknown_payload_wrapper",
      ...(candidate === undefined
        ? {}
        : { validationError: "Unknown native tool kinds use the fixed payload wrapper" }),
    };
  }
  if (kind === "tool_search") {
    if (isValidObjectSchema(candidate)) {
      return { inputSchema: candidate };
    }
    return {
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      inputSchemaTransform: "mcp_tool_search_fallback",
      validationError: invalidSchemaReason(candidate),
    };
  }
  if (isValidObjectSchema(candidate)) {
    return { inputSchema: candidate };
  }
  return {
    inputSchema: {
      type: "object",
      properties: {
        arguments: { type: "object", additionalProperties: true },
      },
      required: ["arguments"],
      additionalProperties: false,
    },
    inputSchemaTransform: "mcp_arguments_wrapper",
    validationError: invalidSchemaReason(candidate),
  };
}

function unwrapPublicArguments(descriptor: ResponsesNativeToolDescriptor, value: unknown): unknown {
  if (descriptor.kind === "custom" || descriptor.kind === "freeform") {
    if (!isObject(value) || typeof value.input !== "string") {
      throw new Error(`${descriptor.exposedName} requires a string input`);
    }
    return value.input;
  }
  if (descriptor.kind === "unknown") {
    if (!isObject(value) || !Object.hasOwn(value, "payload")) {
      throw new Error(`${descriptor.exposedName} requires payload`);
    }
    return value.payload;
  }
  const candidate = descriptor.nativeSpec.parameters ?? descriptor.nativeSpec.inputSchema;
  if (descriptor.kind === "function" && !isValidObjectSchema(candidate)) {
    if (!isObject(value) || !isObject(value.arguments)) {
      throw new Error(`${descriptor.exposedName} requires object arguments`);
    }
    return value.arguments;
  }
  return value;
}

function isValidObjectSchema(
  value: unknown,
): value is Record<string, unknown> & { type: "object" } {
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

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_") || "unknown";
}

function isFreeformDescription(name: string, description: string): boolean {
  if (/\bFREEFORM\b/i.test(description)) {
    return true;
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}\\(input:\\s*string\\)`).test(description);
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
