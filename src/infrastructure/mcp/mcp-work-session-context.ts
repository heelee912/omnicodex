import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  normalizeChatGptConversationId,
  normalizeChatGptConversationUrl,
} from "../chatgpt/chatgpt-conversation-route.js";
import { canonicalJson } from "../safety/canonical-json.js";
import type { DurableWorkSessionBinding } from "./durable-work-session-store.js";

export interface McpRequestIdentityDigest {
  readonly name: string;
  readonly valueHmac: string;
}

export type McpCallerProvenance = "chatgpt_conversation" | "unattributed_mcp_client";

/** Privacy-safe shape of ChatGPT's request-scoped `openai/session` metadata. */
export type OpenAiSessionIdentityKind =
  | "absent"
  | "invalid"
  | "conversation_id"
  | "conversation_url"
  | "opaque";

/** Privacy-safe request identity carried with one exact MCP dispatch. */
export interface McpRequestAttribution {
  /** Compare an exact native request ID with this MCP request; never establishes Goal ownership. */
  readonly matchesNativeRequestId?: (candidate: unknown) => boolean;
  readonly principalBindingSha256: string;
  /**
   * Request-origin classification derived by the gateway from authenticated
   * transport metadata. It is never accepted from native tool arguments.
   */
  readonly callerProvenance?: McpCallerProvenance;
  readonly jsonRpcIdHmac?: string;
  readonly invocationIdSha256?: string;
  readonly transportIdentityDigests?: readonly McpRequestIdentityDigest[];
  /** SHA-256 of the validated ChatGPT conversation id; the raw id is never persisted. */
  readonly chatGptConversationIdSha256?: string;
  /**
   * Exact request-local ChatGPT conversation route. This value targets the
   * isolated Oracle approval browser and derives the privacy-safe digest above.
   * The raw value must never be persisted or written to operational logs.
   */
  readonly chatGptConversationUrl?: string;
}

export interface NativeRequestIdentityComparison {
  readonly outcome: "match" | "mismatch" | "no_active_request";
  readonly activeRequestCount: number;
  readonly nativeRequestCount: number;
  readonly matchedNativeRequestCount: number;
}

export function compareNativeRequestIdentities(
  attributions: Iterable<McpRequestAttribution>,
  candidates: readonly unknown[],
): NativeRequestIdentityComparison {
  const matchers = [...attributions].flatMap((value) =>
    value.matchesNativeRequestId === undefined ? [] : [value.matchesNativeRequestId],
  );
  const ids = [
    ...new Set(
      candidates.filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  ];
  const matchedNativeRequestCount = ids.filter((id) => matchers.some((match) => match(id))).length;
  return {
    outcome:
      matchers.length === 0
        ? "no_active_request"
        : matchedNativeRequestCount > 0
          ? "match"
          : "mismatch",
    activeRequestCount: matchers.length,
    nativeRequestCount: ids.length,
    matchedNativeRequestCount,
  };
}

/** Request-local comparison only. Session, account and user IDs are deliberately not candidates. */
export function nativeRequestIdentityMatcher(input: {
  readonly traceparent?: string;
  readonly requestIdHeader?: string | readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}): (candidate: unknown) => boolean {
  const identities = new Set<string>();
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const requestId = input.requestIdHeader;
  // Preserve exact spelling; multiple header values are not one request identity.
  if (typeof requestId === "string" && /^[!-~]+$/u.test(requestId) && !requestId.includes(","))
    identities.add(digest(requestId));
  const trace =
    input.traceparent === undefined
      ? undefined
      : /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}(?:-[!-~]+)?$/iu.exec(
          input.traceparent,
        )?.[1];
  if (trace !== undefined && !/^0{32}$/u.test(trace)) identities.add(digest(trace));
  for (const key of ["openai/requestId", "openai/toolInvocationId"]) {
    const value = input.metadata?.[key];
    if (typeof value === "string" && value.length > 0) identities.add(digest(value));
  }
  return (candidate) =>
    typeof candidate === "string" && candidate.length > 0 && identities.has(digest(candidate));
}

interface McpWorkSessionFrame {
  readonly binding?: DurableWorkSessionBinding;
  readonly attribution?: McpRequestAttribution;
}

export interface McpRequestedWorkSession {
  readonly workSessionBinding?: string;
  readonly continuationToken?: string;
}

/**
 * Request-local durable conversation identity shared by the HTTP gateway and
 * the MCP server handling that exact request. A transport can process
 * concurrent calls without leaking one Web conversation into another.
 */
export class McpWorkSessionContext {
  readonly #storage = new AsyncLocalStorage<McpWorkSessionFrame>();

  run<T>(binding: DurableWorkSessionBinding, operation: () => Promise<T>): Promise<T> {
    return this.#storage.run({ binding }, operation);
  }

  runRequest<T>(
    binding: DurableWorkSessionBinding | undefined,
    attribution: McpRequestAttribution,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#storage.run(
      {
        ...(binding === undefined ? {} : { binding }),
        attribution: immutableAttribution(attribution),
      },
      operation,
    );
  }

  current(): DurableWorkSessionBinding | undefined {
    return this.#storage.getStore()?.binding;
  }

  currentAttribution(): McpRequestAttribution | undefined {
    return this.#storage.getStore()?.attribution;
  }
}

/** Extract only the MCP request `_meta` object needed for work-session binding. */
export function workSessionRequestMeta(
  jsonRpcMessage: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const messages = Array.isArray(jsonRpcMessage) ? jsonRpcMessage : [jsonRpcMessage];
  const calls = messages.filter(isToolCall);
  if (calls.length === 0) return undefined;
  const candidates = calls.map(requestMeta);
  const bindingSignatures = candidates.map(workSessionBindingSignature);
  const concreteSignatures = bindingSignatures.filter(
    (signature): signature is string => signature !== undefined,
  );
  if (
    new Set(concreteSignatures).size > 1 ||
    (concreteSignatures.length > 0 &&
      bindingSignatures.some((signature) => signature === undefined))
  ) {
    throw new TypeError("MCP batch contains conflicting work-session metadata");
  }
  return candidates.find((meta) => meta !== undefined);
}

export function workSessionRequestIncludesToolCall(jsonRpcMessage: unknown): boolean {
  const messages = Array.isArray(jsonRpcMessage) ? jsonRpcMessage : [jsonRpcMessage];
  return messages.some(isToolCall);
}

/**
 * Resolve an exact ChatGPT conversation route only when `openai/session` is
 * either the canonical conversation URL or its current opaque conversation id.
 * Opaque/anonymized session identities deliberately do not become URLs.
 */
export function chatGptConversationUrlFromRequestMeta(
  meta: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const session = meta?.["openai/session"];
  if (typeof session !== "string") return undefined;
  const trimmed = session.trim();
  const conversationId = normalizeChatGptConversationId(trimmed);
  return conversationId === undefined
    ? normalizeChatGptConversationUrl(trimmed)
    : `https://chatgpt.com/c/${conversationId}`;
}

/**
 * Report whether ChatGPT supplied an exact conversation route or an opaque
 * session identity without ever retaining or emitting the raw metadata value.
 */
export function openAiSessionIdentityKindFromRequestMeta(
  meta: Readonly<Record<string, unknown>> | undefined,
): OpenAiSessionIdentityKind {
  const session = meta?.["openai/session"];
  if (session === undefined) return "absent";
  if (typeof session !== "string") return "invalid";
  const trimmed = session.trim();
  if (trimmed.length === 0) return "invalid";
  if (normalizeChatGptConversationId(trimmed) !== undefined) return "conversation_id";
  if (normalizeChatGptConversationUrl(trimmed) !== undefined) return "conversation_url";
  return "opaque";
}

/**
 * Classify only a request that carries ChatGPT's conversation-session
 * metadata as a ChatGPT conversation call. This does not persist the session
 * value and does not treat a generic MCP client as a Web Pro participant.
 */
export function callerProvenanceFromRequestMeta(
  meta: Readonly<Record<string, unknown>> | undefined,
): McpCallerProvenance {
  const session = meta?.["openai/session"];
  return typeof session === "string" && session.trim().length > 0
    ? "chatgpt_conversation"
    : "unattributed_mcp_client";
}

/**
 * Read an explicit server-issued work-session handle from tool arguments.
 *
 * ChatGPT does not preserve MCP transport ids across every Apps invocation,
 * and result `_meta` is not guaranteed to be copied into the next request.
 * The public session-identity tool therefore returns a copy-safe handle that a
 * client may echo either in `_omnicodexSession` or, for already-installed
 * clients, through the two legacy top-level fields. The gateway validates the
 * handle against the authenticated owner before binding it to the new
 * transport; this function never trusts the value by itself.
 */
export function workSessionRequestBinding(
  jsonRpcMessage: unknown,
): McpRequestedWorkSession | undefined {
  const messages = Array.isArray(jsonRpcMessage) ? jsonRpcMessage : [jsonRpcMessage];
  const calls = messages.filter(isToolCall);
  if (calls.length === 0) return undefined;
  const candidates = calls.map(requestWorkSessionBinding);
  const concrete = candidates.filter(
    (candidate): candidate is McpRequestedWorkSession => candidate !== undefined,
  );
  const signatures = concrete.map((candidate) => canonicalJson(candidate));
  if (
    new Set(signatures).size > 1 ||
    (concrete.length > 0 && concrete.length !== candidates.length)
  ) {
    throw new TypeError("MCP batch contains conflicting explicit work-session bindings");
  }
  return concrete[0];
}

function immutableAttribution(attribution: McpRequestAttribution): McpRequestAttribution {
  const transportIdentityDigests = attribution.transportIdentityDigests?.map((identity) => ({
    name: identity.name,
    valueHmac: identity.valueHmac,
  }));
  return Object.freeze({
    ...attribution,
    ...(transportIdentityDigests === undefined
      ? {}
      : { transportIdentityDigests: Object.freeze(transportIdentityDigests) }),
  });
}

function isToolCall(value: unknown): boolean {
  return isObject(value) && value.method === "tools/call";
}

function requestMeta(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isObject(value) || !isObject(value.params)) return undefined;
  const meta = value.params._meta;
  return isObject(meta) ? meta : undefined;
}

function requestWorkSessionBinding(value: unknown): McpRequestedWorkSession | undefined {
  if (!isObject(value) || !isObject(value.params) || !isObject(value.params.arguments)) {
    return undefined;
  }
  const args = value.params.arguments;
  const nested = isObject(args._omnicodexSession) ? args._omnicodexSession : undefined;
  const nestedBinding = optionalNonEmptyText(nested?.workSessionBinding);
  const flatBinding = optionalNonEmptyText(args.workSessionBinding);
  const nestedToken = optionalNonEmptyText(nested?.continuationToken);
  const flatToken = optionalNonEmptyText(args.continuationToken);
  if (
    (nestedBinding !== undefined && flatBinding !== undefined && nestedBinding !== flatBinding) ||
    (nestedToken !== undefined && flatToken !== undefined && nestedToken !== flatToken)
  ) {
    throw new TypeError("MCP tool call contains conflicting explicit work-session bindings");
  }
  const workSessionBinding = nestedBinding ?? flatBinding;
  const continuationToken = nestedToken ?? flatToken;
  return workSessionBinding === undefined && continuationToken === undefined
    ? undefined
    : {
        ...(workSessionBinding === undefined ? {} : { workSessionBinding }),
        ...(continuationToken === undefined ? {} : { continuationToken }),
      };
}

function optionalNonEmptyText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Explicit work-session values must be non-empty strings");
  }
  return value;
}

function workSessionBindingSignature(
  meta: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (meta === undefined) return undefined;
  const binding: Record<string, unknown> = {};
  const openAiSessionKey = "openai/session";
  if (Object.hasOwn(meta, openAiSessionKey)) {
    binding[openAiSessionKey] = meta[openAiSessionKey];
  }
  const relatedTaskKey = "io.modelcontextprotocol/related-task";
  if (!Object.hasOwn(binding, openAiSessionKey) && Object.hasOwn(meta, relatedTaskKey)) {
    const relatedTask = meta[relatedTaskKey];
    binding[relatedTaskKey] =
      isObject(relatedTask) && Object.hasOwn(relatedTask, "taskId")
        ? { taskId: relatedTask.taskId }
        : relatedTask;
  }
  const continuationKey = "omnicodex/continuation-token";
  if (Object.hasOwn(meta, continuationKey)) {
    binding[continuationKey] = meta[continuationKey];
  }
  return Object.keys(binding).length === 0 ? undefined : canonicalJson(binding);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
