import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AppServerMethodDescriptor } from "./app-server-method-catalog.js";
import type { CodexHostToolDescriptor } from "./codex-host-tool-adapter.js";
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
      readonly route: "host";
      readonly descriptor: CodexHostToolDescriptor;
    })
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
  readonly hostTools?: readonly CodexHostToolDescriptor[];
  readonly appServerMethods?: readonly AppServerMethodDescriptor[];
  readonly responsesTools?: readonly ResponsesNativeToolDescriptor[];
  readonly downstreamTools?: readonly NativeToolDescriptor[];
}

interface ExpandedCandidate {
  readonly route: NativeToolRegistryEntry["route"];
  readonly descriptor:
    | CodexHostToolDescriptor
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
  const nativeNameCounts = new Map<string, number>();
  for (const candidate of candidates) {
    nativeNameCounts.set(
      candidate.originalName,
      (nativeNameCounts.get(candidate.originalName) ?? 0) + 1,
    );
  }

  const used = new Set<string>();
  const entriesWithoutRevision = candidates.map((candidate) => {
    const canPreserveNativeName =
      isMcpToolName(candidate.originalName) &&
      !candidate.originalName.startsWith("codex__") &&
      !reserved.has(candidate.originalName) &&
      nativeNameCounts.get(candidate.originalName) === 1;
    const baseName = canPreserveNativeName ? candidate.originalName : normalizedToolName(candidate);
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
        entriesWithoutRevision.map((entry) => ({ identity: entry.identity, tool: entry.tool })),
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

function uniqueCandidates(candidates: readonly ExpandedCandidate[]): ExpandedCandidate[] {
  const byIdentity = new Map<string, ExpandedCandidate>();
  for (const candidate of candidates) {
    const previous = byIdentity.get(candidate.identity);
    if (previous === undefined) {
      byIdentity.set(candidate.identity, candidate);
      continue;
    }
    if (canonicalJson(previous.tool) !== canonicalJson(candidate.tool)) {
      throw new Error(`Conflicting native descriptors for ${candidate.identity}`);
    }
  }
  return [...byIdentity.values()];
}

function candidatesFrom(input: NativeToolRegistryInput): ExpandedCandidate[] {
  const candidates: ExpandedCandidate[] = [];
  for (const descriptor of input.hostTools ?? []) {
    candidates.push(
      candidate({
        route: "host",
        descriptor,
        catalogExposedName: descriptor.name,
        originalName: descriptor.name,
        nativeNamespace: "host",
        kind: "host",
        origin: "codex_host_adapter",
        source: "codex_host_adapter",
        modelEffect: descriptor.invokesModel ? "model" : "none",
        invokesModel: descriptor.invokesModel,
        stateEffect: hostStateEffect(descriptor.name),
        tool: descriptor.tool,
      }),
    );
  }
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
        stateEffect: appServerStateEffect(descriptor.method),
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
        stateEffect: "mutate",
        tool: descriptor.tool,
      }),
    );
  }
  for (const descriptor of input.downstreamTools ?? []) {
    const kind = metadataKind(descriptor.tool) ?? "mcp";
    const origin = metadataString(descriptor.tool, "origin") ?? descriptor.server;
    const modelEffect = metadataModelEffect(descriptor.tool) ?? "none";
    const stateEffect = metadataStateEffect(descriptor.tool) ?? "mutate";
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
  const readOnly = candidate.stateEffect !== "mutate";
  return {
    ...candidate.tool,
    name: exposedName,
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
        stateEffect: candidate.stateEffect,
        readOnly,
        destructive: !readOnly,
        retryClass: readOnly ? "read_once" : "never",
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
  let namespaceSegment = encodedSegment(candidate.nativeNamespace);
  let nameSegment = encodedSegment(candidate.originalName);
  let normalized = `codex__${namespaceSegment}__${nameSegment}`;
  if (normalized.length <= 128) return normalized;

  nameSegment = `h_${digest(candidate.identity).slice(0, 24)}`;
  normalized = `codex__${namespaceSegment}__${nameSegment}`;
  if (normalized.length <= 128) return normalized;

  namespaceSegment = `h_${digest(`${candidate.origin}\0${candidate.nativeNamespace}`).slice(0, 24)}`;
  return `codex__${namespaceSegment}__${nameSegment}`;
}

function allocateName(
  base: string,
  identity: string,
  reserved: ReadonlySet<string>,
  used: ReadonlySet<string>,
): string {
  if (!reserved.has(base) && !used.has(base)) return base;
  const suffix = `__h_${digest(identity).slice(0, 12)}`;
  let candidate = `${base.slice(0, 128 - suffix.length)}${suffix}`;
  if (!reserved.has(candidate) && !used.has(candidate)) return candidate;
  for (let ordinal = 2; ordinal < 10_000; ordinal += 1) {
    const ordinalSuffix = `__h_${digest(`${identity}\0${ordinal}`).slice(0, 12)}`;
    candidate = `${base.slice(0, 128 - ordinalSuffix.length)}${ordinalSuffix}`;
    if (!reserved.has(candidate) && !used.has(candidate)) return candidate;
  }
  throw new Error(`Unable to allocate a unique MCP name for ${identity}`);
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
    case "host":
      return "downstream_direct";
  }
}

function hostStateEffect(name: string): NativeToolStateEffect {
  return /(?:list|read|load|wait)/i.test(name) ? "read" : "mutate";
}

function appServerStateEffect(method: string): NativeToolStateEffect {
  return /(?:^|\/)(?:get|list|read|status)(?:$|\/)/i.test(method) ? "read" : "mutate";
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

function encodedSegment(value: string): string {
  return `b32_${base32(Buffer.from(value, "utf8"))}`;
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
