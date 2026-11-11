import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AppServerMethodDescriptor } from "./app-server-method-catalog.js";
import type { NativeToolDescriptor } from "./native-tool-catalog.js";
import type { ResponsesNativeToolDescriptor } from "./responses-native-tool-catalog.js";

export type NativeToolKind =
  | "app_server"
  | "function"
  | "custom"
  | "freeform"
  | "tool_search"
  | "namespace"
  | "mcp"
  | "app"
  | "connector"
  | "plugin"
  | "host"
  | "unknown";

export type NativeToolModelEffect = "none" | "model" | "unknown";
export type NativeToolStateEffect = "none" | "read" | "mutate";

interface RegistryEntryBase {
  readonly exposedName: string;
  readonly catalogExposedName: string;
  readonly originalName: string;
  readonly nativeNamespace: string;
  readonly kind: NativeToolKind;
  readonly origin: string;
  readonly source: string;
  readonly identity: string;
  readonly toolId: string;
  readonly modelEffect: NativeToolModelEffect;
  readonly invokesModel: boolean | null;
  readonly stateEffect: NativeToolStateEffect;
  readonly tool: Tool;
}

export type NativeToolRegistryEntry =
  | (RegistryEntryBase & {
      readonly route: "app_server";
      readonly descriptor: AppServerMethodDescriptor;
    })
  | (RegistryEntryBase & {
      readonly route: "responses";
      readonly descriptor: ResponsesNativeToolDescriptor;
    })
  | (RegistryEntryBase & {
      readonly route: "downstream";
      readonly descriptor: NativeToolDescriptor;
    });

export interface NativeToolRegistrySnapshot {
  readonly revision: string;
  readonly entries: readonly NativeToolRegistryEntry[];
  readonly tools: readonly Tool[];
}

export interface NativeToolRegistryInput {
  readonly reservedNames?: readonly string[];
  readonly appServerMethods?: readonly AppServerMethodDescriptor[];
  readonly responsesTools?: readonly ResponsesNativeToolDescriptor[];
  readonly downstreamTools?: readonly NativeToolDescriptor[];
}

interface ExpandedCandidate {
  readonly route: NativeToolRegistryEntry["route"];
  readonly descriptor:
    | AppServerMethodDescriptor
    | ResponsesNativeToolDescriptor
    | NativeToolDescriptor;
  readonly catalogExposedName: string;
  readonly originalName: string;
  readonly nativeNamespace: string;
  readonly kind: NativeToolKind;
  readonly origin: string;
  readonly source: string;
  readonly identity: string;
  readonly toolId: string;
  readonly modelEffect: NativeToolModelEffect;
  readonly invokesModel: boolean | null;
  readonly stateEffect: NativeToolStateEffect;
  readonly tool: Tool;
}

/** Combines every discovered native catalog into the one authoritative MCP surface. */
export function buildNativeToolRegistry(
  input: NativeToolRegistryInput,
): NativeToolRegistrySnapshot {
  const candidates = uniqueCandidates(candidatesFrom(input)).sort((left, right) =>
    left.identity.localeCompare(right.identity, "en"),
  );
  const reserved = new Set(input.reservedNames ?? []);

  const used = new Set<string>();
  const entriesWithoutRevision = candidates.map((candidate) => {
    const surfaceName = nativeSurfaceName(candidate);
    const canPreserveNativeName =
      isMcpToolName(surfaceName) && !reserved.has(surfaceName) && !used.has(surfaceName);
    const baseName = canPreserveNativeName ? surfaceName : normalizedToolName(candidate);
    const exposedName = allocateName(baseName, candidate.identity, reserved, used);
    used.add(exposedName);
    return {
      ...candidate,
      exposedName,
      tool: registryTool(candidate, exposedName, exposedName !== candidate.originalName),
    } as NativeToolRegistryEntry;
  });
  entriesWithoutRevision.sort(compareEntries);

  const revision = createHash("sha256")
    .update(
      canonicalJson(
        entriesWithoutRevision.map((entry) => ({
          identity: entry.identity,
          ...catalogContract(entry),
        })),
      ),
      "utf8",
    )
    .digest("hex");
  const entries = entriesWithoutRevision.map(
    (entry) =>
      ({
        ...entry,
        tool: withCatalogRevision(entry.tool, revision),
      }) as NativeToolRegistryEntry,
  );
  return {
    revision,
    entries,
    tools: entries.map((entry) => entry.tool),
  };
}

function catalogContract(entry: ExpandedCandidate): Record<string, unknown> {
  return {
    tool: entry.tool,
    ...("nativeTool" in entry.descriptor && entry.descriptor.nativeTool !== undefined
      ? { nativeTool: entry.descriptor.nativeTool }
      : {}),
  };
}

function uniqueCandidates(candidates: readonly ExpandedCandidate[]): ExpandedCandidate[] {
  const byIdentity = new Map<string, ExpandedCandidate>();
  for (const candidate of candidates) {
    const previous = byIdentity.get(candidate.identity);
    if (previous === undefined) {
      byIdentity.set(candidate.identity, candidate);
      continue;
    }
    if (canonicalJson(catalogContract(previous)) !== canonicalJson(catalogContract(candidate))) {
      throw new Error(`Conflicting native descriptors for ${candidate.identity}`);
    }
  }
  return [...byIdentity.values()];
}

function candidatesFrom(input: NativeToolRegistryInput): ExpandedCandidate[] {
  const candidates: ExpandedCandidate[] = [];
  for (const descriptor of input.appServerMethods ?? []) {
    candidates.push(
      candidate({
        route: "app_server",
        descriptor,
        catalogExposedName: descriptor.exposedName,
        originalName: descriptor.method,
        nativeNamespace: "app_server",
        kind: "app_server",
        origin: "codex_app_server_schema",
        source: "codex_app_server_schema",
        modelEffect: descriptor.invokesModel ? "model" : "none",
        invokesModel: descriptor.invokesModel,
        stateEffect: descriptor.stateEffect,
        tool: descriptor.tool,
      }),
    );
  }
  for (const descriptor of input.responsesTools ?? []) {
    candidates.push(
      candidate({
        route: "responses",
        descriptor,
        catalogExposedName: descriptor.exposedName,
        originalName: descriptor.nativeName,
        nativeNamespace: descriptor.nativeNamespace ?? "",
        kind: descriptor.kind,
        origin: "codex_responses_runtime",
        source: "codex_responses_runtime",
        modelEffect: descriptor.modelEffect,
        invokesModel: descriptor.invokesModel,
        stateEffect: responsesStateEffect(descriptor),
        tool: descriptor.tool,
      }),
    );
  }
  for (const descriptor of input.downstreamTools ?? []) {
    // Exclude only a tool carrying this deployment's exact public identity.
    // Display names are user-controlled and cannot establish recursion.
    if (descriptor.selfReferential === true) continue;
    const kind = metadataKind(descriptor.tool) ?? "mcp";
    const origin = metadataString(descriptor.tool, "origin") ?? descriptor.server;
    const modelEffect = metadataModelEffect(descriptor.tool) ?? "none";
    const stateEffect = downstreamStateEffect(descriptor);
    candidates.push(
      candidate({
        route: "downstream",
        descriptor,
        catalogExposedName: descriptor.exposedName,
        originalName: descriptor.originalName,
        nativeNamespace: descriptor.server,
        kind,
        origin,
        source: "codex_app_server_mcp",
        modelEffect,
        invokesModel: modelEffect === "model" ? true : modelEffect === "none" ? false : null,
        stateEffect,
        tool: descriptor.tool,
      }),
    );
  }
  return candidates;
}

function downstreamStateEffect(descriptor: NativeToolDescriptor): NativeToolStateEffect {
  // The persistent JavaScript REPLs are execution containers, not read
  // operations. Their code can perform process, filesystem, browser, and UI
  // work even when an installed renderer describes the wrapper itself as
  // read-only.
  if (isNativeExecutionContainer(descriptor.server, descriptor.originalName)) {
    return "mutate";
  }

  return (
    metadataStateEffect(descriptor.tool) ??
    (descriptor.tool.annotations?.readOnlyHint === true ? "read" : "mutate")
  );
}

function candidate(value: Omit<ExpandedCandidate, "identity" | "toolId">): ExpandedCandidate {
  const identity = [value.kind, value.origin, value.nativeNamespace, value.originalName].join("\0");
  return {
    ...value,
    identity,
    toolId: base32(createHash("sha256").update(identity, "utf8").digest()),
  };
}

function registryTool(
  candidate: ExpandedCandidate,
  exposedName: string,
  normalized: boolean,
): Tool {
  const meta = isObject(candidate.tool._meta) ? candidate.tool._meta : {};
  const omni = isObject(meta.omnicodex) ? meta.omnicodex : {};
  const annotationProjection = publicNativeToolAnnotations(
    candidate.tool,
    candidate.nativeNamespace,
    candidate.originalName,
    candidate.stateEffect,
  );
  return {
    ...candidate.tool,
    name: exposedName,
    ...(annotationProjection.annotations === undefined
      ? {}
      : { annotations: annotationProjection.annotations }),
    _meta: {
      ...meta,
      omnicodex: {
        ...omni,
        toolId: candidate.toolId,
        nativeName: candidate.originalName,
        nativeNamespace: candidate.nativeNamespace,
        kind: candidate.kind,
        origin: candidate.origin,
        route: publicRoute(candidate.route),
        modelEffect: candidate.modelEffect,
        invokesModel: candidate.invokesModel,
        availability: "available",
        source: candidate.source,
        originalName: candidate.originalName,
        catalogExposedName: candidate.catalogExposedName,
        exposedName,
        registryRevisionInput: candidate.identity,
        ...(normalized ? { nameCollisionResolved: true } : {}),
      },
    },
  } as Tool;
}

function withCatalogRevision(tool: Tool, revision: string): Tool {
  const meta = isObject(tool._meta) ? tool._meta : {};
  const omni = isObject(meta.omnicodex) ? meta.omnicodex : {};
  return {
    ...tool,
    _meta: {
      ...meta,
      omnicodex: { ...omni, catalogRevision: revision },
    },
  } as Tool;
}

function normalizedToolName(candidate: ExpandedCandidate): string {
  let namespaceSegment = toolNameSegment(candidate.nativeNamespace);
  let nameSegment = toolNameSegment(candidate.originalName);
  let normalized = `codex__${namespaceSegment}__${nameSegment}`;
  if (normalized.length <= 128) return normalized;

  nameSegment = `h_${digest(candidate.identity).slice(0, 24)}`;
  normalized = `codex__${namespaceSegment}__${nameSegment}`;
  if (normalized.length <= 128) return normalized;

  namespaceSegment = `h_${digest(`${candidate.origin}\0${candidate.nativeNamespace}`).slice(0, 24)}`;
  return `codex__${namespaceSegment}__${nameSegment}`;
}

function nativeSurfaceName(candidate: ExpandedCandidate): string {
  // App Server RPC method names contain `/`, which is not valid in an MCP tool
  // name. The schema catalog already assigns each method a stable, readable,
  // collision-safe MCP name (for example
  // `codex__app_server__fs_writeFile`). Preserve that concrete name instead of
  // replacing it with an opaque base32 identifier. This keeps the exact target
  // and its side effects visible to MCP clients and their approval layer.
  return candidate.catalogExposedName;
}

function allocateName(
  base: string,
  identity: string,
  reserved: ReadonlySet<string>,
  used: ReadonlySet<string>,
): string {
  if (!reserved.has(base) && !used.has(base)) return base;
  const suffix = `__h_${digest(identity)}`;
  let candidate = `${base.slice(0, 128 - suffix.length)}${suffix}`;
  if (!reserved.has(candidate) && !used.has(candidate)) return candidate;
  for (let ordinal = 2n; ; ordinal += 1n) {
    const ordinalSuffix = `__h_${digest(`${identity}\0${ordinal.toString(10)}`)}`;
    candidate = `${base.slice(0, 128 - ordinalSuffix.length)}${ordinalSuffix}`;
    if (!reserved.has(candidate) && !used.has(candidate)) return candidate;
  }
}

function publicRoute(
  route: NativeToolRegistryEntry["route"],
): "app_server_rpc" | "downstream_direct" | "loopback_responses" {
  switch (route) {
    case "app_server":
      return "app_server_rpc";
    case "responses":
      return "loopback_responses";
    case "downstream":
      return "downstream_direct";
  }
}

function responsesStateEffect(descriptor: ResponsesNativeToolDescriptor): NativeToolStateEffect {
  // `functions.exec` is an orchestration container. It cannot mutate native
  // state by itself; only the exact nested tools it awaits can do that, and
  // those calls are independently admitted, ordered, and durably fenced.
  // Treating the container as a mutation makes it retain an outer resource
  // lease while a nested Chrome/shell/file call tries to acquire that same
  // resource, deadlocking the model turn.
  if (
    descriptor.executionMode === "responses_call" &&
    descriptor.nativeNamespace?.toLowerCase() === "functions" &&
    descriptor.nativeName.toLowerCase() === "exec"
  ) {
    return "none";
  }
  if (isNativeExecutionContainer(descriptor.nativeNamespace, descriptor.nativeName)) {
    return "mutate";
  }
  if (descriptor.tool.annotations?.readOnlyHint === true) return "read";
  if (descriptor.tool.annotations?.readOnlyHint === false) return "mutate";
  return /(?:^|__)(?:list|read|load|get|wait|view|search)(?:_|$)/i.test(descriptor.nativeName)
    ? "read"
    : "mutate";
}

export function publicNativeToolAnnotations(
  _tool: Pick<Tool, "annotations">,
  _nativeNamespace: string | undefined,
  _originalName: string,
  _stateEffect: NativeToolStateEffect,
): {
  readonly annotations: Tool["annotations"] | undefined;
} {
  return {
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  };
}

/** Internal scheduling identity; never projected into native annotations. */
function isNativeExecutionContainer(
  nativeNamespace: string | undefined,
  originalName: string,
): boolean {
  const namespace = nativeNamespace?.trim().toLowerCase();
  const name = originalName.trim().toLowerCase().split("/").at(-1);
  if (namespace === "node_repl") {
    return name === "js" || name === "js_reset" || name === "js_add_node_module_dir";
  }
  return namespace === "cua_repl" && (name === "js" || name === "js_reset");
}

function metadataKind(tool: Tool): NativeToolKind | undefined {
  const value = metadataValue(tool, "kind");
  return typeof value === "string" && nativeToolKinds.has(value)
    ? (value as NativeToolKind)
    : undefined;
}

function metadataModelEffect(tool: Tool): NativeToolModelEffect | undefined {
  const value = metadataValue(tool, "modelEffect");
  return value === "none" || value === "model" || value === "unknown" ? value : undefined;
}

function metadataStateEffect(tool: Tool): NativeToolStateEffect | undefined {
  const value = metadataValue(tool, "stateEffect");
  return value === "none" || value === "read" || value === "mutate" ? value : undefined;
}

function metadataString(tool: Tool, key: string): string | undefined {
  const value = metadataValue(tool, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metadataValue(tool: Tool, key: string): unknown {
  const metadata = isObject(tool._meta) ? tool._meta.omnicodex : undefined;
  return isObject(metadata) ? metadata[key] : undefined;
}

const nativeToolKinds = new Set<string>([
  "app_server",
  "function",
  "custom",
  "freeform",
  "tool_search",
  "namespace",
  "mcp",
  "app",
  "connector",
  "plugin",
  "host",
  "unknown",
]);

function compareEntries(left: NativeToolRegistryEntry, right: NativeToolRegistryEntry): number {
  return (
    left.exposedName.localeCompare(right.exposedName, "en") ||
    left.toolId.localeCompare(right.toolId, "en")
  );
}

function toolNameSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_]+/gu, "_").replace(/^_+|_+$/gu, "") || "root";
}

function base32(value: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let buffer = 0;
  let result = "";
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) result += alphabet[(buffer << (5 - bits)) & 31];
  return result;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isObject(value)) {
    const fields = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort((left, right) => left.localeCompare(right, "en"))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${fields.join(",")}}`;
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}

function isMcpToolName(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
