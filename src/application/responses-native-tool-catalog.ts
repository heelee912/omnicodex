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
  call(
    selection: ResponsesSelectedToolCall,
    signal?: AbortSignal,
  ): Promise<ResponsesToolExecutionResult>;
  callNested?(
    name: string,
    argumentsValue: unknown,
    freeform: boolean,
    signal?: AbortSignal,
  ): Promise<unknown>;
  callMcp?(
    server: string,
    tool: string,
    argumentsValue: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
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
  /** Exact OmniCodex deployment identity to remove from recursively discovered Responses tools. */
  readonly selfServerIdentity?: string;
  /** Exact MCP server label used when Responses omits tool metadata from nested descriptors. */
  readonly selfServerName?: string;
}

export interface ResponsesCatalogIncompatibilityDetails {
  readonly source: "codex_responses_runtime";
  readonly variant: "tool" | "namespace_inner" | "functions_exec_nested";
  readonly index?: number;
  readonly nestedIndex?: number;
  readonly location: string;
  readonly rawShape: unknown;
}

/** The installed Responses runtime advertised a tool shape that cannot be called losslessly. */
export class ResponsesCatalogIncompatibilityError extends Error {
  readonly code = "RESPONSES_CATALOG_INCOMPATIBLE";
  readonly details: ResponsesCatalogIncompatibilityDetails;

  constructor(reason: string, details: ResponsesCatalogIncompatibilityDetails) {
    super(`${reason} at ${details.location}`);
    this.name = "ResponsesCatalogIncompatibilityError";
    this.details = details;
  }
}

/** Flattens the exact Responses tool specs emitted by the installed runtime. */
export class ResponsesNativeToolCatalog {
  readonly #source: ResponsesCatalogSource;
  readonly #reservedNames: ReadonlySet<string>;
  readonly #selfServerIdentity: string | undefined;
  readonly #selfServerName: string | undefined;
  #snapshot: ResponsesNativeToolCatalogSnapshot = {
    refreshedAtUnixMs: 0,
    sourceRequestCount: 0,
    tools: [],
  };

  constructor(source: ResponsesCatalogSource, options: ResponsesNativeToolCatalogOptions = {}) {
    this.#source = source;
    this.#reservedNames = new Set(options.reservedNames ?? []);
    this.#selfServerIdentity = options.selfServerIdentity;
    this.#selfServerName = options.selfServerName?.trim().toLocaleLowerCase();
  }

  get snapshot(): ResponsesNativeToolCatalogSnapshot {
    return this.#snapshot;
  }

  async prepareRefresh(): Promise<ResponsesNativeToolCatalogSnapshot> {
    const source = this.#source.snapshot;
    if (!Array.isArray(source.tools)) {
      throw responsesIncompatibility(
        "Responses tool catalog is not an array",
        { variant: "tool", location: "tools" },
        source.tools,
      );
    }
    if (source.nestedTools !== undefined && !Array.isArray(source.nestedTools)) {
      throw responsesIncompatibility(
        "functions.exec nested-tool catalog is not an array",
        { variant: "functions_exec_nested", location: "nestedTools" },
        source.nestedTools,
      );
    }
    const entries = flattenSpecs(source.tools, source.nestedTools ?? []).filter(
      (entry) => !this.#isSelfReferential(entry) && !requiresPersistentThread(entry),
    );
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
    return {
      refreshedAtUnixMs: Date.now(),
      sourceRequestCount: source.requestCount,
      tools,
    };
  }

  commitRefresh(snapshot: ResponsesNativeToolCatalogSnapshot): void {
    this.#snapshot = snapshot;
  }

  async refresh(): Promise<ResponsesNativeToolCatalogSnapshot> {
    const snapshot = await this.prepareRefresh();
    this.commitRefresh(snapshot);
    return snapshot;
  }

  #isSelfReferential(entry: FlatSpec): boolean {
    if (
      this.#selfServerIdentity !== undefined &&
      responsesSpecServerIdentity(entry.spec) === this.#selfServerIdentity
    ) {
      return true;
    }
    const self = this.#selfServerName;
    if (self === undefined || self.length === 0) return false;
    const namespace = entry.namespace?.trim().toLocaleLowerCase();
    const name = entry.name.trim().toLocaleLowerCase();
    return namespace === self || name.startsWith(`${self}.`);
  }
}

// Codex binds these goal tools to the calling thread and refuses them on an
// ephemeral one ("Goal tools require a persistent thread."). Every Responses
// call runs on the loopback executor's ephemeral thread, so advertising them
// only offers a call that always fails; persistent goals stay reachable through
// omnicodex__goal_* and the App Server thread/goal methods.
const PERSISTENT_THREAD_GOAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "create_goal",
  "get_goal",
  "update_goal",
]);

function requiresPersistentThread(entry: FlatSpec): boolean {
  return (
    (entry.namespace === undefined || entry.namespace.length === 0) &&
    PERSISTENT_THREAD_GOAL_TOOL_NAMES.has(entry.name)
  );
}

function responsesSpecServerIdentity(spec: ResponsesNativeToolSpec): string | undefined {
  const metadata = isObject(spec._meta) ? spec._meta : {};
  const omniCodex = isObject(metadata.omnicodex) ? metadata.omnicodex : {};
  const identity = omniCodex.serverIdentity;
  return typeof identity === "string" && /^[a-f0-9]{64}$/u.test(identity) ? identity : undefined;
}

export class ResponsesNativeToolExecutor {
  readonly #source: ResponsesExecutionSource;

  constructor(source: ResponsesExecutionSource) {
    this.#source = source;
  }

  async call(
    descriptor: ResponsesNativeToolDescriptor,
    argumentsValue: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const nativeArguments = unwrapPublicArguments(descriptor, argumentsValue);
    const result = await this.#source.call(
      {
        kind: descriptor.kind,
        name: descriptor.nativeName,
        ...(descriptor.nativeNamespace === undefined
          ? {}
          : { namespace: descriptor.nativeNamespace }),
        arguments: nativeArguments,
      },
      signal,
    );
    const content = nativeExecutionContent(result);
    const nativeFailure = nativeResultIsError(result.output);
    const metadata = {
      omnicodex: {
        source: "codex_responses_runtime",
        execution: "model_free_loopback",
        nativeName: descriptor.nativeName,
        nativeNamespace: descriptor.nativeNamespace,
        kind: descriptor.kind,
        executionMode: descriptor.executionMode,
        executionStatus: result.executionStatus,
        invokesModel: descriptor.invokesModel,
      },
    };
    if (content?.some((item) => item.type === "image" || item.type === "audio")) {
      // The Responses envelope is an execution transcript, not additional
      // model input. Repeating output/rawItem/rawItems serializes the same
      // image up to seven times, including base64 in model-visible JSON.
      // Keep native content and native structured data; the runtime trace
      // already retains the exact execution envelope for diagnostics.
      const nativeOutput =
        typeof result.output === "string" ? parseNativeJsonOutput(result.output) : result.output;
      return {
        content,
        ...(isObject(nativeOutput) && isObject(nativeOutput.structuredContent)
          ? { structuredContent: nativeOutput.structuredContent }
          : {}),
        ...(result.executionStatus === "failed" || nativeFailure ? { isError: true } : {}),
        _meta: {
          ...(isObject(nativeOutput) && isObject(nativeOutput._meta) ? nativeOutput._meta : {}),
          ...metadata,
        },
      };
    }
    const continuation = {
      callId: result.callId,
      outputType: result.outputType,
      executionStatus: result.executionStatus,
      ...(result.yieldedCellId === undefined ? {} : { yieldedCellId: result.yieldedCellId }),
    };
    if (content !== undefined) {
      // Same reason as the media branch: output, rawItem and rawItems are the
      // execution transcript, and repeating them beside content sent each
      // text result about seven times. Content already carries the output and
      // exec notifications in order; keep native structured data, or else only
      // the continuation fields a caller needs for functions.wait.
      const nativeOutput =
        typeof result.output === "string" ? parseNativeJsonOutput(result.output) : result.output;
      const nativeStructured =
        isObject(nativeOutput) && isObject(nativeOutput.structuredContent)
          ? nativeOutput.structuredContent
          : undefined;
      // A status-only structuredContent hides actual text from clients that
      // prefer the structured result. Keep continuation in _meta, except when
      // functions.wait needs an explicit yielded cell handle.
      const structuredContent =
        nativeStructured === undefined
          ? result.yieldedCellId === undefined
            ? undefined
            : continuation
          : {
              ...nativeStructured,
              ...(result.yieldedCellId === undefined || "yieldedCellId" in nativeStructured
                ? {}
                : { yieldedCellId: result.yieldedCellId }),
            };
      return {
        content,
        ...(structuredContent === undefined ? {} : { structuredContent }),
        ...(result.executionStatus === "failed" || nativeFailure ? { isError: true } : {}),
        _meta: {
          ...(isObject(nativeOutput) && isObject(nativeOutput._meta) ? nativeOutput._meta : {}),
          omnicodex: { ...metadata.omnicodex, continuation },
        },
      };
    }
    // Output that MCP content cannot represent stays a structured value.
    return {
      output: result.output,
      ...continuation,
      rawItem: result.rawItem,
      ...(result.rawItems === undefined ? {} : { rawItems: result.rawItems }),
      // Transport delivery success does not turn a native MCP tool failure
      // into success. Preserve its flag for both object and JSON wire output.
      ...(result.executionStatus === "failed" || nativeFailure ? { isError: true } : {}),
      _meta: metadata,
    };
  }

  async callNested(
    name: string,
    argumentsValue: unknown,
    freeform = false,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#source.callNested === undefined) {
      throw new Error("Codex functions.exec nested-tool bridge is unavailable");
    }
    return this.#source.callNested(name, argumentsValue, freeform, signal);
  }

  async callMcp(
    server: string,
    tool: string,
    argumentsValue: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#source.callMcp === undefined) {
      throw new Error("Codex downstream MCP Responses bridge is unavailable");
    }
    return this.#source.callMcp(server, tool, argumentsValue, signal);
  }
}

function nativeExecutionContent(
  result: ResponsesToolExecutionResult,
): Record<string, unknown>[] | undefined {
  const content = nativeResultContent(result.output);
  // functions.exec notify emits separate native outputs, not part of the
  // terminal output. Keep them model-visible as well as in the raw transcript.
  const notifications = result.rawItems?.filter(
    (item) => item.type === "custom_tool_call_output" && item.name === "exec",
  );
  if (notifications === undefined || notifications.length === 0) return content;
  return [
    ...notifications.flatMap((item) => nativeResultContent(item.output) ?? []),
    ...(content ?? []),
  ];
}

function nativeResultIsError(value: unknown): boolean {
  const decoded = typeof value === "string" ? parseNativeJsonOutput(value) : value;
  return isObject(decoded) && decoded.isError === true;
}

function nativeResultContent(output: unknown): Record<string, unknown>[] | undefined {
  if (typeof output === "string") {
    const decoded = parseNativeJsonOutput(output);
    if (decoded !== undefined) {
      const decodedContent = nativeResultContent(decoded);
      if (decodedContent !== undefined) return decodedContent;
    }
    return [{ type: "text", text: output }];
  }
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
  if (typeof value.image_url === "string") {
    const image = dataUrlImage(value.image_url);
    return image === undefined
      ? []
      : [
          {
            ...image,
            ...(value.detail === undefined ? {} : { detail: value.detail }),
            // MCP image schemas strip unknown top-level fields. Carry the
            // native original-resolution request through the supported hint.
            ...(value.detail === "original"
              ? {
                  _meta: {
                    ...(isObject(value._meta) ? value._meta : {}),
                    "codex/imageDetail": "original",
                  },
                }
              : isObject(value._meta)
                ? { _meta: value._meta }
                : {}),
          },
        ];
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

/**
 * Function-call outputs from the installed Responses runtime are commonly
 * JSON strings even when the native tool returned typed image/resource
 * content. Decode only complete JSON objects/arrays and fall back to the exact
 * original text when the decoded value has no representable MCP content.
 */
function parseNativeJsonOutput(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isObject(parsed) || Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function dataUrlImage(value: string): Record<string, unknown> | undefined {
  const match = /^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=_-]+)$/.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  const mimeType = match[1].startsWith("image/") ? match[1] : inferredImageMimeType(match[2]);
  return mimeType === undefined ? undefined : { type: "image", mimeType, data: match[2] };
}

function inferredImageMimeType(base64: string): string | undefined {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  } catch {
    return undefined;
  }
  if (hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (hasBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (asciiPrefix(bytes, "GIF87a") || asciiPrefix(bytes, "GIF89a")) return "image/gif";
  if (asciiPrefix(bytes, "RIFF") && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (asciiPrefix(bytes, "BM")) return "image/bmp";
  if (hasBytes(bytes, [0x49, 0x49, 0x2a, 0x00]) || hasBytes(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return "image/tiff";
  }
  const textPrefix = bytes.subarray(0, Math.min(bytes.length, 512)).toString("utf8").trimStart();
  if (textPrefix.startsWith("<svg") || /^<\?xml[^>]*>\s*<svg\b/u.test(textPrefix)) {
    return "image/svg+xml";
  }
  return undefined;
}

function hasBytes(value: Buffer, expected: readonly number[]): boolean {
  return expected.every((byte, index) => value[index] === byte);
}

function asciiPrefix(value: Buffer, expected: string): boolean {
  return value.subarray(0, expected.length).toString("ascii") === expected;
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
  nestedTools: readonly {
    readonly name: string;
    readonly description: string;
    readonly inputSchema?: Readonly<Record<string, unknown>>;
  }[],
): FlatSpec[] {
  const result: FlatSpec[] = [];
  for (const [toolIndex, rawSpec] of specs.entries()) {
    const location = `tools[${String(toolIndex)}]`;
    const spec = normalizeResponsesSpec(rawSpec, {
      variant: "tool",
      index: toolIndex,
      location,
    });
    if (spec.type === "namespace") {
      if (typeof spec.name !== "string" || spec.name.length === 0) {
        throw responsesIncompatibility(
          "Responses namespace has no callable name",
          { variant: "tool", index: toolIndex, location: `${location}.name` },
          spec.name,
        );
      }
      if (!Array.isArray(spec.tools)) {
        throw responsesIncompatibility(
          "Responses namespace tools are not an array",
          { variant: "tool", index: toolIndex, location: `${location}.tools` },
          spec.tools,
        );
      }
      for (const [nestedIndex, rawInner] of spec.tools.entries()) {
        const innerLocation = `${location}.tools[${String(nestedIndex)}]`;
        const inner = normalizeResponsesSpec(rawInner, {
          variant: "namespace_inner",
          index: toolIndex,
          nestedIndex,
          location: innerLocation,
        });
        if (inner.type === "namespace") {
          throw responsesIncompatibility(
            "Nested Responses namespaces cannot be represented by the native one-level selector",
            {
              variant: "namespace_inner",
              index: toolIndex,
              nestedIndex,
              location: innerLocation,
            },
            inner,
          );
        }
        const name = requireCallableName(inner, {
          variant: "namespace_inner",
          index: toolIndex,
          nestedIndex,
          location: innerLocation,
        });
        result.push({
          namespace: spec.name,
          name,
          executionMode: "responses_call",
          namespaceSpec: spec,
          spec: inner,
        });
      }
      continue;
    }
    const name = requireCallableName(spec, {
      variant: "tool",
      index: toolIndex,
      location,
    });
    result.push({ namespace: undefined, name, spec, executionMode: "responses_call" });
  }
  for (const [nestedIndex, rawNested] of nestedTools.entries()) {
    const location = `nestedTools[${String(nestedIndex)}]`;
    if (!isObject(rawNested)) {
      throw responsesIncompatibility(
        "functions.exec nested-tool metadata is not an object",
        { variant: "functions_exec_nested", index: nestedIndex, location },
        rawNested,
      );
    }
    if (typeof rawNested.name !== "string" || rawNested.name.length === 0) {
      throw responsesIncompatibility(
        "functions.exec nested-tool metadata has no callable name",
        {
          variant: "functions_exec_nested",
          index: nestedIndex,
          location: `${location}.name`,
        },
        rawNested.name,
      );
    }
    if (rawNested.description !== undefined && typeof rawNested.description !== "string") {
      throw responsesIncompatibility(
        "functions.exec nested-tool description is not a string",
        {
          variant: "functions_exec_nested",
          index: nestedIndex,
          location: `${location}.description`,
        },
        rawNested.description,
      );
    }
    if (rawNested.inputSchema !== undefined && !isJsonSchema(rawNested.inputSchema)) {
      throw responsesIncompatibility(
        "functions.exec nested-tool input schema is not JSON Schema",
        {
          variant: "functions_exec_nested",
          index: nestedIndex,
          location: `${location}.inputSchema`,
        },
        rawNested.inputSchema,
      );
    }
    const name = rawNested.name;
    const description = typeof rawNested.description === "string" ? rawNested.description : "";
    const freeform = isFreeformDescription(name, description);
    result.push({
      namespace: undefined,
      name,
      executionMode: "responses_call",
      spec: {
        ...rawNested,
        type: freeform ? "freeform" : "function",
        name,
        ...(description.length === 0 ? {} : { description }),
        ...(freeform
          ? {}
          : {
              parameters: rawNested.inputSchema ?? {
                type: "object",
                additionalProperties: true,
              },
            }),
      },
    });
  }
  return result;
}

interface ResponsesShapeLocation {
  readonly variant: ResponsesCatalogIncompatibilityDetails["variant"];
  readonly index?: number;
  readonly nestedIndex?: number;
  readonly location: string;
}

function normalizeResponsesSpec(
  value: unknown,
  context: ResponsesShapeLocation,
): ResponsesNativeToolSpec {
  if (!isObject(value)) {
    throw responsesIncompatibility("Responses tool spec is not an object", context, value);
  }
  if (value.type === undefined) {
    if (typeof value.name === "string" && value.name.length > 0) {
      return value as ResponsesNativeToolSpec;
    }
    throw responsesIncompatibility(
      "Responses tool spec has neither a type nor a callable name",
      context,
      value,
    );
  }
  if (typeof value.type !== "string" || value.type.length === 0) {
    throw responsesIncompatibility(
      "Responses tool type is not a non-empty string",
      { ...context, location: `${context.location}.type` },
      value.type,
    );
  }
  return value as ResponsesNativeToolSpec;
}

function requireCallableName(
  spec: ResponsesNativeToolSpec,
  context: ResponsesShapeLocation,
): string {
  const name = callableName(spec);
  if (name !== undefined) return name;
  throw responsesIncompatibility("Responses tool spec has no callable name", context, spec);
}

function responsesIncompatibility(
  reason: string,
  context: ResponsesShapeLocation,
  value: unknown,
): ResponsesCatalogIncompatibilityError {
  return new ResponsesCatalogIncompatibilityError(reason, {
    source: "codex_responses_runtime",
    ...context,
    rawShape: rawShape(value),
  });
}

function callableName(spec: Record<string, unknown>): string | undefined {
  if (typeof spec.name === "string" && spec.name.length > 0) {
    return spec.name;
  }
  if (typeof spec.type !== "string" || spec.type.length === 0) return undefined;
  return spec.type === "function" || spec.type === "custom" || spec.type === "freeform"
    ? undefined
    : spec.type;
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
  const digest = createHash("sha256").update(`${namespace}\n${entry.name}`, "utf8").digest("hex");
  return `${base.slice(0, 62)}__${digest}`;
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
    for (let ordinal = 1n; ; ordinal += 1n) {
      const suffix = createHash("sha256")
        .update(`${identity}\n${ordinal.toString(10)}`, "utf8")
        .digest("hex");
      const candidate = `${base.slice(0, 62)}__${suffix}`;
      if (!used.has(candidate) && !reservedNames.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
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
  const existingMeta = isObject(spec._meta) ? spec._meta : {};
  const existingOmniMeta = isObject(existingMeta.omnicodex) ? existingMeta.omnicodex : {};
  const description = typeof spec.description === "string" ? spec.description : undefined;
  const outputSchema = isJsonSchema(spec.outputSchema) ? spec.outputSchema : undefined;
  return {
    name: identity.exposedName,
    ...(typeof spec.title === "string" ? { title: spec.title } : {}),
    ...(description === undefined ? {} : { description }),
    inputSchema: schema.inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(isObject(spec.annotations) ? { annotations: spec.annotations } : {}),
    ...(isObject(spec.execution) ? { execution: spec.execution } : {}),
    ...(Array.isArray(spec.icons) ? { icons: structuredClone(spec.icons) } : {}),
    _meta: {
      ...existingMeta,
      omnicodex: {
        ...existingOmniMeta,
        ...(Object.keys(existingOmniMeta).length === 0
          ? {}
          : { nativeOmnicodex: structuredClone(existingOmniMeta) }),
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
  if (name === "run_natural_task") return "model";
  return kind === "unknown" ? "unknown" : "none";
}

interface PublicInputSchema {
  readonly inputSchema: boolean | Record<string, unknown>;
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
    if (isJsonSchema(candidate)) {
      return { inputSchema: candidate };
    }
    return {
      inputSchema: {
        type: "object",
        properties: { payload: true, contentType: { type: "string" } },
        required: ["payload"],
        additionalProperties: false,
      },
      inputSchemaTransform: "mcp_unknown_payload_wrapper",
      validationError: invalidSchemaReason(candidate),
    };
  }
  if (kind === "tool_search") {
    if (isJsonSchema(candidate)) {
      return { inputSchema: candidate };
    }
    return {
      inputSchema: {
        type: "object",
        additionalProperties: true,
      },
      inputSchemaTransform: "mcp_open_object_fallback",
      validationError: invalidSchemaReason(candidate),
    };
  }
  if (isJsonSchema(candidate)) {
    return { inputSchema: candidate };
  }
  return {
    inputSchema: {
      type: "object",
      additionalProperties: true,
    },
    inputSchemaTransform: "mcp_open_object_fallback",
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
    const candidate = descriptor.nativeSpec.parameters ?? descriptor.nativeSpec.inputSchema;
    if (isJsonSchema(candidate)) {
      return value;
    }
    if (!isObject(value) || !Object.hasOwn(value, "payload")) {
      throw new Error(`${descriptor.exposedName} requires payload`);
    }
    return value.payload;
  }
  return value;
}

function isJsonSchema(value: unknown): value is boolean | Record<string, unknown> {
  return typeof value === "boolean" || isObject(value);
}

function invalidSchemaReason(value: unknown): string {
  if (value === undefined) return "Native input schema was absent";
  return "Native input schema was not a JSON Schema object or boolean";
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

function rawShape(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null) return { kind: "null" };
  if (Array.isArray(value)) {
    if (seen.has(value)) return { kind: "array", circular: true };
    seen.add(value);
    return {
      kind: "array",
      length: value.length,
      items: value.map((item) => rawShape(item, seen)),
    };
  }
  if (isObject(value)) {
    if (seen.has(value)) return { kind: "object", circular: true };
    seen.add(value);
    return {
      kind: "object",
      fields: Object.fromEntries(
        Object.keys(value)
          .sort((left, right) => left.localeCompare(right, "en"))
          .map((key) => [key, rawShape(value[key], seen)]),
      ),
    };
  }
  return { kind: typeof value };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
