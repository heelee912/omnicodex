import { assertExplicitLoopbackCdpEndpoint } from "./chatgpt-app-approval-adapter.js";
import type { CdpTarget } from "./chatgpt-cdp-transport.js";
import { normalizeChatGptConversationUrl } from "./chatgpt-conversation-route.js";

export interface OracleConversationTargetRecoveryOptions {
  readonly endpoint: string;
  readonly conversationUrl: string;
  /** Optional stable owner marker used only for an automation-owned mirror tab. */
  readonly ownershipMarker?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}

export interface OracleConversationTargetRecoveryResult {
  readonly target: CdpTarget;
  readonly resolution: "existing" | "created" | "ambiguous_create_recovered";
  /** True only when the target carries the caller's exact ownership marker. */
  readonly callerOwned?: true;
}

/**
 * Finds or opens the one durable ChatGPT conversation bound to an Oracle run.
 *
 * Target creation is an ambiguous mutation: Chrome can create the page and
 * then close the HTTP response before the caller receives its target id.  A
 * failed PUT is therefore never replayed.  The target list is read again and
 * the conversation URL is used as the idempotency key.
 */
export async function ensureExactOracleConversationTarget(
  options: OracleConversationTargetRecoveryOptions,
): Promise<OracleConversationTargetRecoveryResult> {
  const endpoint = assertExplicitLoopbackCdpEndpoint(options.endpoint);
  const conversationUrl = exactConversationUrl(options.conversationUrl);
  if (conversationUrl === undefined) {
    throw new Error("Oracle recovery requires an exact ChatGPT conversation URL");
  }
  const fetch = options.fetch ?? globalThis.fetch;
  const ownershipMarker = normalizedOwnershipMarker(options.ownershipMarker);
  const existing = await exactTargets(endpoint, conversationUrl, fetch, options.signal);
  if (existing.length > 0) {
    const owned = existing.find((target) => targetHasOwnershipMarker(target, ownershipMarker));
    if (owned !== undefined) {
      return { target: owned, resolution: "existing", callerOwned: true };
    }
    if (ownershipMarker === undefined) {
      return { target: existing[0] as CdpTarget, resolution: "existing" };
    }
  }

  try {
    const creationUrl = new URL(conversationUrl);
    if (ownershipMarker !== undefined) {
      creationUrl.searchParams.set("omnicodex_oracle_mirror", ownershipMarker);
    }
    const created = await requestJson(
      new URL(`/json/new?${encodeURIComponent(creationUrl.toString())}`, endpoint),
      fetch,
      "PUT",
      options.signal,
    );
    if (
      isCdpTarget(created) &&
      created.type === "page" &&
      exactConversationUrl(created.url) === conversationUrl
    ) {
      return {
        target: created,
        resolution: "created",
        ...(ownershipMarker === undefined ? {} : { callerOwned: true }),
      };
    }
    throw new Error("Oracle recovery target creation returned an invalid target");
  } catch (createError) {
    const recovered = await exactTargets(endpoint, conversationUrl, fetch, options.signal);
    const target =
      ownershipMarker === undefined
        ? recovered[0]
        : recovered.find((candidate) => targetHasOwnershipMarker(candidate, ownershipMarker));
    if (target !== undefined) {
      return {
        target,
        resolution: "ambiguous_create_recovered",
        ...(targetHasOwnershipMarker(target, ownershipMarker) ? { callerOwned: true } : {}),
      };
    }
    throw createError;
  }
}

function normalizedOwnershipMarker(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,96}$/u.test(value)) {
    throw new Error("Oracle recovery ownership marker is invalid");
  }
  return value;
}

function targetHasOwnershipMarker(target: CdpTarget, ownershipMarker: string | undefined): boolean {
  if (ownershipMarker === undefined) return false;
  try {
    return new URL(target.url).searchParams.get("omnicodex_oracle_mirror") === ownershipMarker;
  } catch {
    return false;
  }
}

async function exactTargets(
  endpoint: URL,
  conversationUrl: string,
  fetch: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<CdpTarget[]> {
  const value = await requestJson(new URL("/json/list", endpoint), fetch, "GET", signal);
  if (!Array.isArray(value)) throw new Error("Oracle recovery CDP target list is invalid");
  return value
    .filter(isCdpTarget)
    .filter(
      (target) => target.type === "page" && exactConversationUrl(target.url) === conversationUrl,
    )
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
}

async function requestJson(
  url: URL,
  fetch: typeof globalThis.fetch,
  method: "GET" | "PUT",
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const response = await fetch(url, {
    method,
    redirect: "manual",
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    throw new Error(`Oracle recovery CDP ${method} failed with HTTP ${String(response.status)}`);
  }
  return response.json() as Promise<unknown>;
}

function exactConversationUrl(value: unknown): string | undefined {
  return normalizeChatGptConversationUrl(value);
}

function isCdpTarget(value: unknown): value is CdpTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return (
    typeof target.id === "string" &&
    target.id.length > 0 &&
    typeof target.url === "string" &&
    typeof target.webSocketDebuggerUrl === "string" &&
    target.webSocketDebuggerUrl.length > 0 &&
    (target.type === undefined || typeof target.type === "string")
  );
}
