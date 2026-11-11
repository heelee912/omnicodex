import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CdpTarget } from "../infrastructure/chatgpt/chatgpt-cdp-transport.js";
import { normalizeChatGptConversationUrl } from "../infrastructure/chatgpt/chatgpt-conversation-route.js";
import {
  ensureExactOracleConversationTarget,
  type OracleConversationTargetRecoveryResult,
} from "../infrastructure/chatgpt/oracle-conversation-target-recovery.js";
import type { OracleApprovalRunScope } from "./oracle-active-run-registry.js";

export const ORACLE_APPROVAL_MIRROR_OWNERSHIP_MARKER = "omnicodex-approval-mirror-v1";

export interface OracleConversationApprovalMirrorOptions {
  readonly cdpEndpoint: string;
  readonly lifecycle?: OracleMirrorLifecycle;
  /** Legacy fallback only; production source-independent discovery always supplies an exact URL. */
  readonly readChromeUserTabs?: () => Promise<unknown>;
  readonly fetch?: typeof globalThis.fetch;
  readonly recoverTarget?: (
    endpoint: string,
    conversationUrl: string,
    ownershipMarker: string,
    signal?: AbortSignal,
  ) => Promise<OracleConversationTargetRecoveryResult>;
  readonly closeTarget?: (
    endpoint: string,
    targetId: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  /** Wait until a freshly created mirror has a live execution context. */
  readonly ensureTargetReady?: (target: CdpTarget) => Promise<void>;
}

export interface OracleConversationApprovalMirrorSnapshot {
  readonly conversationUrls: readonly string[];
  readonly reclaimedTargetCount: number;
  readonly reclaimFailureCount: number;
  readonly targets: readonly {
    readonly targetId: string;
    readonly conversationUrl: string;
    readonly owned: boolean;
  }[];
}

interface MirroredTarget {
  readonly targetId: string;
  readonly conversationUrl: string;
  readonly owned: boolean;
  readonly origin: "exact" | "fallback";
}

/** One browser's target leases; connector approval state remains outside this registry. */
export class OracleMirrorLifecycle {
  readonly conversationTails = new Map<string, Promise<void>>();
  readonly recoveryFlights = new Map<string, Promise<OracleConversationApprovalMirrorSnapshot>>();
  readonly #targets = new Map<
    string,
    { users: Set<symbol>; state: "open" | "closing" | "closed" }
  >();
  readonly endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = new URL(endpoint).href;
  }

  acquire(targetId: string, consumer: symbol): boolean {
    const entry = this.#targets.get(targetId);
    if (entry !== undefined && entry.state !== "open") return false;
    if (entry === undefined)
      this.#targets.set(targetId, { users: new Set([consumer]), state: "open" });
    else entry.users.add(consumer);
    return true;
  }

  beginClose(targetId: string, consumer: symbol, replacingFailedTarget = false): boolean {
    const entry = this.#targets.get(targetId);
    if (entry !== undefined) {
      if (entry.state !== "open") return false;
      entry.users.delete(consumer);
      if (entry.users.size > 0 && !replacingFailedTarget) return false;
      entry.state = "closing";
    } else this.#targets.set(targetId, { users: new Set(), state: "closing" });
    return true;
  }

  finishClose(targetId: string, consumer: symbol, succeeded: boolean): void {
    const entry = this.#targets.get(targetId);
    if (entry === undefined) return;
    entry.state = succeeded ? "closed" : "open";
    if (!succeeded) entry.users.add(consumer);
    else {
      entry.users.clear();
    }
  }
}

/**
 * Makes ordinary Loop-hosted ChatGPT conversations visible to the isolated
 * Oracle approval watcher without moving browser automation onto Windows.
 *
 * The local side performs one read-only tab inventory only when a protected
 * file result is about to be delivered. It never reads page DOM, takes a
 * screenshot, clicks, or polls Chrome. The Oracle browser receives at most one
 * idempotent mirror per exact conversation URL; the approval watcher remains
 * the sole DOM and activation owner on OCI.
 */
export class OracleConversationApprovalMirror {
  readonly #options: OracleConversationApprovalMirrorOptions;
  readonly #lifecycle: OracleMirrorLifecycle;
  readonly #consumer = Symbol("oracle-mirror-consumer");
  readonly #targetsById = new Map<string, MirroredTarget>();
  readonly #prepareFlights = new Map<string, Promise<OracleConversationApprovalMirrorSnapshot>>();
  readonly #recoveryFlights = new Map<string, Promise<OracleConversationApprovalMirrorSnapshot>>();
  readonly #releaseFlights = new Map<string, Promise<void>>();
  readonly #conversationTails: Map<string, Promise<void>>;

  constructor(options: OracleConversationApprovalMirrorOptions) {
    this.#options = options;
    this.#lifecycle = options.lifecycle ?? new OracleMirrorLifecycle(options.cdpEndpoint);
    if (this.#lifecycle.endpoint !== new URL(options.cdpEndpoint).href)
      throw new Error("ORACLE_APPROVAL_MIRROR_LIFECYCLE_ENDPOINT_MISMATCH");
    this.#conversationTails = this.#lifecycle.conversationTails;
  }

  prepareForProtectedResult(
    conversationUrl?: string,
    signal?: AbortSignal,
  ): Promise<OracleConversationApprovalMirrorSnapshot> {
    const exact =
      conversationUrl === undefined ? undefined : normalizedConversationUrl(conversationUrl);
    if (conversationUrl !== undefined && exact === undefined) {
      return Promise.reject(new Error("ORACLE_APPROVAL_MIRROR_INVALID_CONVERSATION_URL"));
    }
    const flightKey = exact ?? "loop-inventory-fallback";
    const current = this.#prepareFlights.get(flightKey);
    if (current !== undefined) return current;
    const flight = (
      exact === undefined
        ? this.#prepareFromLoopInventory(signal)
        : this.#serializeConversation(exact, () => this.#prepareExact(exact, signal), signal)
    ).finally(() => {
      if (this.#prepareFlights.get(flightKey) === flight) this.#prepareFlights.delete(flightKey);
    });
    this.#prepareFlights.set(flightKey, flight);
    return flight;
  }

  activeRunForTarget(target: CdpTarget): OracleApprovalRunScope | undefined {
    let mirrored = this.#targetsById.get(target.id);
    if (
      mirrored === undefined &&
      targetHasOwnershipMarker(target, ORACLE_APPROVAL_MIRROR_OWNERSHIP_MARKER)
    ) {
      const conversationUrl = normalizedConversationUrl(target.url);
      if (conversationUrl !== undefined) {
        // The target inventory is authoritative across daemon restarts. The
        // exact marker is written only on automation-owned Oracle mirrors, so
        // reconstructing this in-memory lease cannot adopt a user or foreign
        // page. Without this, a graceful OmniCodex restart leaves a valid
        // mirror visible but permanently unwatched until another protected
        // result happens to recreate it.
        mirrored = {
          targetId: target.id,
          conversationUrl,
          owned: true,
          origin: "exact",
        };
        this.#targetsById.set(target.id, mirrored);
      }
    }
    if (
      mirrored === undefined ||
      normalizedConversationUrl(target.url) !== mirrored.conversationUrl
    ) {
      return undefined;
    }
    if (mirrored.owned && !this.#lifecycle.acquire(target.id, this.#consumer)) return undefined;
    const identity = mirrorIdentity(mirrored.conversationUrl);
    return {
      oracleRunId: `mirror-${identity}`,
      sessionId: `mirror-${identity}`,
      correlationId: `mirror-${identity}`,
      targetId: mirrored.targetId,
      conversationUrl: mirrored.conversationUrl,
      controllerPid: process.pid,
    };
  }

  /**
   * Replaces only an exact automation-owned mirror whose renderer has failed
   * repeated liveness probes. The canonical conversation URL remains the
   * idempotency key; user tabs and unmarked Oracle tabs are never eligible.
   */
  recoverUnresponsiveOwnedTarget(
    target: CdpTarget,
    signal?: AbortSignal,
  ): Promise<OracleConversationApprovalMirrorSnapshot> {
    const conversationUrl = normalizedConversationUrl(target.url);
    if (
      conversationUrl === undefined ||
      !targetHasOwnershipMarker(target, ORACLE_APPROVAL_MIRROR_OWNERSHIP_MARKER)
    ) {
      return Promise.reject(new Error("ORACLE_APPROVAL_MIRROR_RECOVERY_TARGET_NOT_OWNED"));
    }
    const current = this.#recoveryFlights.get(target.id);
    if (current !== undefined) return current;
    let shared = this.#lifecycle.recoveryFlights.get(target.id);
    if (shared === undefined) {
      shared = this.#serializeConversation(
        conversationUrl,
        async () => {
          await this.#closeAndAwaitTarget(target.id, signal, true);
          this.#targetsById.delete(target.id);
          signal?.throwIfAborted();
          return this.#prepareExact(conversationUrl, signal);
        },
        signal,
      );
      this.#lifecycle.recoveryFlights.set(target.id, shared);
      const sharedFlight = shared;
      const clear = () => {
        if (this.#lifecycle.recoveryFlights.get(target.id) === sharedFlight)
          this.#lifecycle.recoveryFlights.delete(target.id);
      };
      void shared.then(clear, clear);
    }
    const recovery = shared
      .then((snapshot) => {
        this.#targetsById.delete(target.id);
        for (const replacement of snapshot.targets) {
          this.#targetsById.set(replacement.targetId, { ...replacement, origin: "exact" });
          if (replacement.owned) this.#lifecycle.acquire(replacement.targetId, this.#consumer);
        }
        return snapshot;
      })
      .finally(() => {
        if (this.#recoveryFlights.get(target.id) === recovery) {
          this.#recoveryFlights.delete(target.id);
        }
      });
    this.#recoveryFlights.set(target.id, recovery);
    return recovery;
  }

  /**
   * Releases a renderer only after the approval watcher has observed the same
   * empty mutation-index revision twice. The exact URL marker is the ownership
   * boundary: ordinary Oracle pages and every user Chrome tab are ineligible.
   */
  releaseStableIdleOwnedTarget(target: CdpTarget, signal?: AbortSignal): Promise<void> {
    const conversationUrl = normalizedConversationUrl(target.url);
    if (
      conversationUrl === undefined ||
      !targetHasOwnershipMarker(target, ORACLE_APPROVAL_MIRROR_OWNERSHIP_MARKER)
    ) {
      return Promise.reject(new Error("ORACLE_APPROVAL_MIRROR_RELEASE_TARGET_NOT_OWNED"));
    }
    const current = this.#releaseFlights.get(target.id);
    if (current !== undefined) return current;
    const release = this.#serializeConversation(
      conversationUrl,
      async () => {
        const tracked = this.#targetsById.get(target.id);
        if (
          tracked !== undefined &&
          (!tracked.owned || tracked.conversationUrl !== conversationUrl)
        ) {
          throw new Error("ORACLE_APPROVAL_MIRROR_RELEASE_TARGET_NOT_OWNED");
        }
        await this.#closeAndAwaitTarget(target.id, signal);
        this.#targetsById.delete(target.id);
      },
      signal,
    ).finally(() => {
      if (this.#releaseFlights.get(target.id) === release) {
        this.#releaseFlights.delete(target.id);
      }
    });
    this.#releaseFlights.set(target.id, release);
    return release;
  }

  async #prepareFromLoopInventory(
    signal?: AbortSignal,
  ): Promise<OracleConversationApprovalMirrorSnapshot> {
    if (this.#options.readChromeUserTabs === undefined) {
      throw new Error("ORACLE_APPROVAL_MIRROR_EXACT_CONVERSATION_REQUIRED");
    }
    const inventory = await this.#options.readChromeUserTabs();
    const conversationUrl = singleConversationUrlFromChromeInventory(inventory);
    const prepared = await this.#serializeConversation(
      conversationUrl,
      () => this.#prepareExact(conversationUrl, signal, "fallback"),
      signal,
    );
    const stale = await this.#reclaimFallbackOutside(new Set([conversationUrl]));
    return {
      conversationUrls: [conversationUrl],
      reclaimedTargetCount: prepared.reclaimedTargetCount + stale.reclaimedTargetCount,
      reclaimFailureCount: prepared.reclaimFailureCount + stale.reclaimFailureCount,
      targets: prepared.targets,
    };
  }

  async #reclaimFallbackOutside(currentUrls: ReadonlySet<string>): Promise<{
    readonly reclaimedTargetCount: number;
    readonly reclaimFailureCount: number;
  }> {
    let reclaimedTargetCount = 0;
    let reclaimFailureCount = 0;
    for (const [targetId, target] of this.#targetsById) {
      if (target.origin !== "fallback" || currentUrls.has(target.conversationUrl)) continue;
      if (!target.owned) {
        this.#targetsById.delete(targetId);
        continue;
      }
      try {
        await this.#closeAndAwaitTarget(targetId);
        this.#targetsById.delete(targetId);
        reclaimedTargetCount += 1;
      } catch {
        reclaimFailureCount += 1;
      }
    }
    return { reclaimedTargetCount, reclaimFailureCount };
  }

  async #prepareExact(
    conversationUrl: string,
    signal?: AbortSignal,
    origin: MirroredTarget["origin"] = "exact",
  ): Promise<OracleConversationApprovalMirrorSnapshot> {
    signal?.throwIfAborted();
    const conversationUrls = [conversationUrl] as const;
    let reclaimedTargetCount = 0;
    let reclaimFailureCount = 0;
    const recover =
      this.#options.recoverTarget ??
      ((endpoint: string, conversationUrl: string, ownershipMarker: string, signal?: AbortSignal) =>
        ensureExactOracleConversationTarget({
          endpoint,
          conversationUrl,
          ownershipMarker,
          ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
          ...(signal === undefined ? {} : { signal }),
        }));
    const result = await recover(
      this.#options.cdpEndpoint,
      conversationUrl,
      ORACLE_APPROVAL_MIRROR_OWNERSHIP_MARKER,
      signal,
    );
    const previous = this.#targetsById.get(result.target.id);
    const mirrored: MirroredTarget = {
      targetId: result.target.id,
      conversationUrl,
      owned: result.callerOwned === true,
      origin: previous?.origin === "exact" || origin === "exact" ? "exact" : "fallback",
    };
    for (const [targetId, target] of this.#targetsById) {
      if (target.conversationUrl !== conversationUrl || targetId === mirrored.targetId) continue;
      if (!target.owned) {
        this.#targetsById.delete(targetId);
        continue;
      }
      try {
        await this.#closeAndAwaitTarget(targetId, signal);
        this.#targetsById.delete(targetId);
        reclaimedTargetCount += 1;
      } catch {
        signal?.throwIfAborted();
        reclaimFailureCount += 1;
      }
    }
    this.#targetsById.set(mirrored.targetId, mirrored);
    await this.#options.ensureTargetReady?.(result.target);
    if (mirrored.owned && !this.#lifecycle.acquire(mirrored.targetId, this.#consumer))
      throw new Error("ORACLE_APPROVAL_MIRROR_TARGET_CLOSING");
    return {
      conversationUrls,
      reclaimedTargetCount,
      reclaimFailureCount,
      targets: [publicMirroredTarget(mirrored)],
    };
  }

  async #closeAndAwaitTarget(
    targetId: string,
    signal?: AbortSignal,
    replacingFailedTarget = false,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (!this.#lifecycle.beginClose(targetId, this.#consumer, replacingFailedTarget)) return;
    let succeeded = false;
    try {
      if (this.#options.closeTarget !== undefined) {
        // Injected closers are required to resolve only after their target is no
        // longer discoverable.  This keeps unit tests and alternate transports
        // deterministic without issuing an unexpected second network request.
        if (signal === undefined)
          await this.#options.closeTarget(this.#options.cdpEndpoint, targetId);
        else await this.#options.closeTarget(this.#options.cdpEndpoint, targetId, signal);
        succeeded = true;
        return;
      }
      await closeOracleTarget(this.#options.cdpEndpoint, targetId, this.#options.fetch, signal);
      succeeded = true;
    } finally {
      this.#lifecycle.finishClose(targetId, this.#consumer, succeeded);
    }
  }

  #serializeConversation<T>(
    conversationUrl: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    // Preparing, replacing and releasing the same mirror share one queue.
    // Different conversations remain independent, and a failed operation must
    // not poison later attempts or hide its error from its original caller.
    const run = (this.#conversationTails.get(conversationUrl) ?? Promise.resolve()).then(() => {
      signal?.throwIfAborted();
      return operation();
    });
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#conversationTails.set(conversationUrl, settled);
    void settled.then(() => {
      if (this.#conversationTails.get(conversationUrl) === settled) {
        this.#conversationTails.delete(conversationUrl);
      }
    });
    return run;
  }
}

interface ChromeConversationTabCandidate {
  readonly conversationUrl: string;
  readonly attached: boolean;
  readonly foreground: boolean;
  readonly recency?: number;
}

/**
 * Selects one authoritative Loop conversation without multiplying Oracle tabs.
 * The installed Chrome contract exposes attachment, foreground, and recency
 * metadata on each visible user tab.  If none of those signals identifies one
 * tab uniquely, failing closed is safer than mirroring every open conversation
 * and making every renderer participate in one approval request.
 */
export function singleConversationUrlFromChromeInventory(value: unknown): string {
  const candidates = conversationTabCandidates(value);
  if (candidates.length === 0) {
    throw new Error(
      "ORACLE_APPROVAL_MIRROR_NO_LOOP_CONVERSATIONS: first-party Chrome returned no exact ChatGPT conversation URL",
    );
  }
  const [onlyCandidate] = candidates;
  if (candidates.length === 1 && onlyCandidate !== undefined) return onlyCandidate.conversationUrl;

  const attached = candidates.filter((candidate) => candidate.attached);
  const attachmentPool = attached.length > 0 ? attached : candidates;
  const [onlyAttached] = attachmentPool;
  if (attachmentPool.length === 1 && onlyAttached !== undefined) {
    return onlyAttached.conversationUrl;
  }

  const foreground = attachmentPool.filter((candidate) => candidate.foreground);
  const foregroundPool = foreground.length > 0 ? foreground : attachmentPool;
  const [onlyForeground] = foregroundPool;
  if (foregroundPool.length === 1 && onlyForeground !== undefined) {
    return onlyForeground.conversationUrl;
  }

  const withRecency = foregroundPool.filter(
    (candidate): candidate is ChromeConversationTabCandidate & { readonly recency: number } =>
      candidate.recency !== undefined,
  );
  if (withRecency.length > 0) {
    const newest = Math.max(...withRecency.map((candidate) => candidate.recency));
    const newestCandidates = withRecency.filter((candidate) => candidate.recency === newest);
    const [onlyNewest] = newestCandidates;
    if (newestCandidates.length === 1 && onlyNewest !== undefined) {
      return onlyNewest.conversationUrl;
    }
  }

  throw new Error(
    `ORACLE_APPROVAL_MIRROR_AMBIGUOUS_LOOP_CONVERSATION: first-party Chrome returned ${String(candidates.length)} exact ChatGPT conversation URLs without one uniquely attached, foreground, or most-recent tab`,
  );
}

export function conversationUrlsFromChromeInventory(value: unknown): ReadonlySet<string> {
  const urls = new Set<string>();
  const visited = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      const exact = normalizedConversationUrl(candidate);
      if (exact !== undefined) urls.add(exact);
      for (const match of candidate.matchAll(
        /https:\/\/chatgpt\.com\/c\/(?:[A-Za-z][A-Za-z0-9_-]{0,31}:)?[0-9A-Fa-f-]+/gu,
      )) {
        const embedded = normalizedConversationUrl(match[0]);
        if (embedded !== undefined) urls.add(embedded);
      }
      const trimmed = candidate.trim();
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          visit(JSON.parse(trimmed) as unknown);
        } catch {
          // A node_repl display string may look like JSON while being truncated.
        }
      }
      return;
    }
    if (typeof candidate !== "object" || candidate === null) return;
    if (visited.has(candidate)) return;
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    for (const item of Object.values(candidate as Record<string, unknown>)) visit(item);
  };
  visit(value);
  return urls;
}

function conversationTabCandidates(value: unknown): ChromeConversationTabCandidate[] {
  const candidates = new Map<string, ChromeConversationTabCandidate>();
  const visited = new Set<object>();
  const add = (candidate: ChromeConversationTabCandidate): void => {
    const previous = candidates.get(candidate.conversationUrl);
    candidates.set(candidate.conversationUrl, {
      conversationUrl: candidate.conversationUrl,
      attached: candidate.attached || previous?.attached === true,
      foreground: candidate.foreground || previous?.foreground === true,
      ...((candidate.recency ?? previous?.recency) === undefined
        ? {}
        : { recency: Math.max(candidate.recency ?? -Infinity, previous?.recency ?? -Infinity) }),
    });
  };
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      const exact = normalizedConversationUrl(candidate);
      if (exact !== undefined) {
        add({ conversationUrl: exact, attached: false, foreground: false });
      }
      const trimmed = candidate.trim();
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          visit(JSON.parse(trimmed) as unknown);
        } catch {
          // node_repl may return a truncated object display; embedded URLs are
          // still recovered by conversationUrlsFromChromeInventory below.
        }
      }
      return;
    }
    if (typeof candidate !== "object" || candidate === null) return;
    if (visited.has(candidate)) return;
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const record = candidate as Record<string, unknown>;
    const conversationUrl = normalizedConversationUrl(record.url);
    if (conversationUrl !== undefined) {
      add({
        conversationUrl,
        attached: record.attachedToThisSession === true,
        foreground: ["active", "focused", "highlighted", "selected"].some(
          (key) => record[key] === true,
        ),
        ...optionalTabRecency(record),
      });
    }
    for (const item of Object.values(record)) visit(item);
  };
  visit(value);
  for (const conversationUrl of conversationUrlsFromChromeInventory(value)) {
    if (!candidates.has(conversationUrl)) {
      add({ conversationUrl, attached: false, foreground: false });
    }
  }
  return [...candidates.values()].sort((left, right) =>
    left.conversationUrl.localeCompare(right.conversationUrl, "en"),
  );
}

function optionalTabRecency(record: Readonly<Record<string, unknown>>): {
  readonly recency?: number;
} {
  for (const key of ["lastAccessed", "lastAccessedAt", "lastActiveAt", "updatedAt", "recency"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return { recency: value };
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return { recency: parsed };
    }
  }
  return {};
}

function publicMirroredTarget(
  target: MirroredTarget,
): OracleConversationApprovalMirrorSnapshot["targets"][number] {
  return {
    targetId: target.targetId,
    conversationUrl: target.conversationUrl,
    owned: target.owned,
  };
}

async function closeOracleTarget(
  endpoint: string,
  targetId: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<void> {
  const base = new URL(endpoint);
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) {
    throw new Error("Oracle approval mirror CDP endpoint must be explicit loopback HTTP");
  }
  const response = await fetchImplementation(
    new URL(`/json/close/${encodeURIComponent(targetId)}`, base),
    {
      method: "PUT",
      redirect: "manual",
      ...(signal === undefined ? {} : { signal }),
    },
  );
  if (!response.ok) {
    throw new Error(`Oracle approval mirror close failed with HTTP ${String(response.status)}`);
  }
  // Chrome acknowledges /json/close before the target necessarily disappears
  // from /json/list.  Creating the replacement immediately can therefore
  // rediscover and reuse the dying target, leaving the browser with no mirror
  // once that asynchronous close completes.  Observe absence before recovery.
  const deadline = Date.now() + 15_000;
  while (true) {
    signal?.throwIfAborted();
    const inventoryResponse = await fetchImplementation(new URL("/json/list", base), {
      method: "GET",
      redirect: "manual",
      ...(signal === undefined ? {} : { signal }),
    });
    if (!inventoryResponse.ok) {
      throw new Error(
        `Oracle approval mirror close verification failed with HTTP ${String(inventoryResponse.status)}`,
      );
    }
    const inventory = (await inventoryResponse.json()) as unknown;
    if (!Array.isArray(inventory)) {
      throw new Error("Oracle approval mirror close verification returned an invalid target list");
    }
    if (!inventory.some((candidate) => isTargetWithId(candidate, targetId))) return;
    if (Date.now() >= deadline) {
      throw new Error("Oracle approval mirror target did not close before recovery");
    }
    await delay(100, undefined, { signal });
  }
}

function isTargetWithId(value: unknown, targetId: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).id === targetId
  );
}

function normalizedConversationUrl(value: unknown): string | undefined {
  return normalizeChatGptConversationUrl(value);
}

function targetHasOwnershipMarker(target: CdpTarget, expected: string): boolean {
  try {
    return new URL(target.url).searchParams.get("omnicodex_oracle_mirror") === expected;
  } catch {
    return false;
  }
}

function mirrorIdentity(conversationUrl: string): string {
  return createHash("sha256").update(conversationUrl, "utf8").digest("hex").slice(0, 24);
}
