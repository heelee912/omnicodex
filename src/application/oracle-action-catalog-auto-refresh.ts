import { ChatGptControlPlaneHttpError } from "../infrastructure/chatgpt/chatgpt-action-catalog-control-client.js";
import type { OmniCodexConfig } from "../infrastructure/config/omnicodex-config-store.js";
import {
  getOracleClientBindings,
  hasExactActionCatalogContractParity,
  selectOracleClientConfig,
} from "../infrastructure/config/omnicodex-config-store.js";
import type { OmniCodexFullCatalogSnapshot } from "../infrastructure/mcp/omnicodex-mcp-server.js";

export type OracleActionCatalogAutoRefreshResult =
  | {
      readonly state:
        | "endpoint_unavailable"
        | "disabled"
        | "explicit_refresh_required"
        | "state_verification_required"
        | "already_attempted";
      readonly catalogRevision?: string;
    }
  | {
      readonly state: "current" | "refreshed";
      readonly catalogRevision: string;
    };

export interface OracleActionCatalogAutoRefreshOptions {
  readonly loadConfig: () => Promise<OmniCodexConfig>;
  readonly readCatalog: () => Promise<OmniCodexFullCatalogSnapshot>;
  /**
   * Executes the authoritative page-free control-plane Refresh flow directly.
   * Errors retain their HTTP metadata; no settings renderer or child process
   * is launched and the user's local Chrome profile is not attached.
   */
  readonly refresh: (catalogRevision: string) => Promise<void>;
  readonly now?: () => number;
  readonly rateLimitBaseCooldownMs?: number;
}

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 60 * 60_000;
const DEFAULT_CATALOG_SETTLE_DELAY_MS = 250;
const DEFAULT_CATALOG_SETTLE_MAX_READS = 5;

export interface StableOracleActionCatalogBaselineOptions {
  readonly read: () => Promise<OmniCodexFullCatalogSnapshot>;
  readonly signal?: AbortSignal;
  readonly settleDelayMs?: number;
  readonly maxReads?: number;
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Returns only after the eager action surface is identical in two consecutive
 * live reads. Native tools can finish registering after gateway admission
 * opens; publishing that intermediate contract makes every Oracle binding
 * stale again as soon as registration converges.
 */
export async function readStableOracleActionCatalogBaseline(
  options: StableOracleActionCatalogBaselineOptions,
): Promise<OmniCodexFullCatalogSnapshot> {
  const maxReads = Math.max(2, options.maxReads ?? DEFAULT_CATALOG_SETTLE_MAX_READS);
  const settleDelayMs = Math.max(0, options.settleDelayMs ?? DEFAULT_CATALOG_SETTLE_DELAY_MS);
  const wait = options.wait ?? waitForCatalogSettle;
  let previous: OmniCodexFullCatalogSnapshot | undefined;

  for (let readIndex = 0; readIndex < maxReads; readIndex += 1) {
    if (options.signal?.aborted === true) throw options.signal.reason;
    const current = await options.read();
    if (previous !== undefined && sameOracleActionCatalogSurface(previous, current)) return current;
    previous = current;
    if (readIndex + 1 < maxReads) await wait(settleDelayMs, options.signal);
  }

  throw new Error("ORACLE_ACTION_CATALOG_BASELINE_UNSTABLE");
}

export function oracleActionCatalogTransportsReady(input: {
  readonly enabled: boolean;
  readonly publicTunnel:
    | {
        readonly kind: "ngrok" | "cloudflare" | "tailscale" | "oracle_ssh" | "direct";
        readonly publicUrl: string;
      }
    | undefined;
  readonly runningPublicTunnel:
    | {
        readonly kind: "ngrok" | "cloudflare" | "tailscale" | "oracle_ssh";
        readonly publicUrl: string;
      }
    | undefined;
  readonly remoteCdpConfigured: boolean;
  readonly remoteCdpReady: boolean;
  readonly directCdpReady: boolean;
}): boolean {
  if (!input.enabled || input.publicTunnel === undefined) return false;
  const publicReady =
    input.publicTunnel.kind === "direct" ||
    (input.runningPublicTunnel?.kind === input.publicTunnel.kind &&
      input.runningPublicTunnel.publicUrl === input.publicTunnel.publicUrl);
  const cdpReady = input.remoteCdpConfigured ? input.remoteCdpReady : input.directCdpReady;
  return publicReady && cdpReady;
}

/**
 * Revision-keyed, single-flight bridge between the live MCP catalog and the
 * action snapshot persisted by ChatGPT. A failed revision is attempted again
 * after the Oracle CDP transport reports a new ready epoch, an explicit refresh,
 * or a rate-limit cooldown expires and another normal synchronization event
 * arrives. A revision change still causes a fresh comparison, but does not
 * require a settings refresh when the exact ChatGPT action surface is unchanged.
 */
export class OracleActionCatalogAutoRefreshCoordinator {
  readonly #options: OracleActionCatalogAutoRefreshOptions;
  #endpointReady = false;
  #stopping = false;
  #inFlight: Promise<OracleActionCatalogAutoRefreshResult> | undefined;
  #attemptedRevision: string | undefined;
  #verifiedRevision: string | undefined;
  #rateLimitCooldownUntil = 0;
  #rateLimitFailures = 0;
  #rateLimitObservedAt = 0;

  constructor(options: OracleActionCatalogAutoRefreshOptions) {
    this.#options = options;
  }

  get rateLimitCooldownUntil(): number {
    return this.#rateLimitCooldownUntil;
  }

  get rateLimitSnapshot(): { observedAtUnixMs: number; retryAtUnixMs: number } {
    return {
      observedAtUnixMs: this.#rateLimitObservedAt,
      retryAtUnixMs: this.#rateLimitCooldownUntil,
    };
  }

  markEndpointUnavailable(): void {
    this.#endpointReady = false;
  }

  markEndpointReady(retryCurrentRevision = false): Promise<OracleActionCatalogAutoRefreshResult> {
    this.#endpointReady = true;
    if (this.#inFlight !== undefined && retryCurrentRevision) {
      const current = this.#inFlight;
      return current
        .catch(() => undefined)
        .then(() => {
          if (this.#stopping || !this.#endpointReady) {
            return { state: "endpoint_unavailable" } as const;
          }
          // The failed operation may have recorded the revision after this
          // ready signal arrived. Clear it only after that operation settles,
          // then run one authoritative readback for the new transport epoch.
          if (!this.#rateLimitCoolingDown()) this.#attemptedRevision = undefined;
          return this.synchronize("endpoint_ready");
        });
    }
    if (retryCurrentRevision && !this.#rateLimitCoolingDown()) {
      this.#attemptedRevision = undefined;
    }
    return this.synchronize("endpoint_ready");
  }

  synchronize(
    _reason: "endpoint_ready" | "catalog_observed" | "runtime_ready",
    observedRevision?: string,
  ): Promise<OracleActionCatalogAutoRefreshResult> {
    if (this.#stopping || !this.#endpointReady) {
      return Promise.resolve({
        state: "endpoint_unavailable",
        ...(observedRevision === undefined ? {} : { catalogRevision: observedRevision }),
      });
    }
    if (this.#rateLimitCoolingDown()) {
      const catalogRevision = observedRevision ?? this.#attemptedRevision;
      return Promise.resolve(
        catalogRevision === undefined
          ? { state: "already_attempted" }
          : { state: "already_attempted", catalogRevision },
      );
    }
    if (this.#rateLimitCooldownUntil > 0) {
      // Rate limiting is temporary, not a permanently failed catalog revision.
      // Consume its expired latch once; ordinary traffic can resume one shared
      // refresh without reconnecting or creating a background polling loop.
      this.#rateLimitCooldownUntil = 0;
      this.#attemptedRevision = undefined;
    }
    if (observedRevision !== undefined && observedRevision === this.#verifiedRevision) {
      return Promise.resolve({ state: "current", catalogRevision: observedRevision });
    }
    if (observedRevision !== undefined && observedRevision === this.#attemptedRevision) {
      return Promise.resolve({ state: "already_attempted", catalogRevision: observedRevision });
    }
    if (this.#inFlight !== undefined) return this.#inFlight;

    const operation = this.#synchronize()
      .catch((error) => {
        if (isRateLimitError(error)) {
          this.#rateLimitObservedAt = this.#now();
          this.#rateLimitFailures += 1;
          const base = this.#options.rateLimitBaseCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
          const cooldown = Math.min(
            MAX_RATE_LIMIT_COOLDOWN_MS,
            base * 2 ** Math.min(this.#rateLimitFailures - 1, 6),
          );
          this.#rateLimitCooldownUntil = Math.max(
            this.#rateLimitObservedAt + cooldown,
            error instanceof ChatGptControlPlaneHttpError ? (error.retryAtUnixMs ?? 0) : 0,
          );
        }
        throw error;
      })
      .finally(() => {
        if (this.#inFlight === operation) this.#inFlight = undefined;
      });
    this.#inFlight = operation;
    return operation;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#endpointReady = false;
    await this.#inFlight?.catch(() => undefined);
  }

  async #synchronize(): Promise<OracleActionCatalogAutoRefreshResult> {
    const config = await this.#options.loadConfig();
    if (this.#stopping || !this.#endpointReady) return { state: "endpoint_unavailable" };
    const oracle = config.oracle;
    // Automatic settings mutation belongs only to the isolated Oracle browser.
    // A legacy direct/local CDP endpoint must be migrated explicitly first.
    if (oracle?.enabled !== true || oracle.remoteCdpTunnel === undefined) {
      return { state: "disabled" };
    }

    const baseline = await this.#options.readCatalog();
    if (this.#stopping || !this.#endpointReady) {
      return { state: "endpoint_unavailable", catalogRevision: baseline.catalogRevision };
    }
    if (oracleActionCatalogMatchesBaseline(config, baseline)) {
      this.#verifiedRevision = baseline.catalogRevision;
      this.#attemptedRevision = baseline.catalogRevision;
      return { state: "current", catalogRevision: baseline.catalogRevision };
    }
    if (this.#attemptedRevision === baseline.catalogRevision) {
      return { state: "already_attempted", catalogRevision: baseline.catalogRevision };
    }

    this.#attemptedRevision = baseline.catalogRevision;
    if (this.#stopping || !this.#endpointReady) {
      return { state: "endpoint_unavailable", catalogRevision: baseline.catalogRevision };
    }
    await this.#options.refresh(baseline.catalogRevision);

    const [readbackConfig, readbackBaseline] = await Promise.all([
      this.#options.loadConfig(),
      this.#options.readCatalog(),
    ]);
    if (!oracleActionCatalogMatchesBaseline(readbackConfig, readbackBaseline)) {
      throw new Error("ORACLE_ACTION_CATALOG_AUTO_REFRESH_READBACK_FAILED");
    }
    this.#verifiedRevision = readbackBaseline.catalogRevision;
    this.#attemptedRevision = readbackBaseline.catalogRevision;
    this.#rateLimitFailures = 0;
    this.#rateLimitCooldownUntil = 0;
    return { state: "refreshed", catalogRevision: readbackBaseline.catalogRevision };
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #rateLimitCoolingDown(): boolean {
    return this.#now() < this.#rateLimitCooldownUntil;
  }
}

export interface OracleClientBindingsActionCatalogAutoRefreshOptions
  extends Omit<OracleActionCatalogAutoRefreshOptions, "refresh"> {
  /** Keep installed ChatGPT registrations unchanged until an explicit refresh. */
  readonly manualRefreshOnly?: boolean;
  readonly refresh: (clientBinding: string, catalogRevision: string) => Promise<void>;
  /** Verified runtime principal; neither connector IDs nor endpoint names are account identities. */
  readonly accountSourceId?: (clientBinding: string) => string | undefined;
  readonly accountCooldown?: {
    read(
      accountSourceId: string,
    ): Promise<{ observedAtUnixMs: number; retryAtUnixMs: number } | undefined>;
    observe(
      accountSourceId: string,
      snapshot: { observedAtUnixMs: number; retryAtUnixMs: number },
    ): Promise<void>;
  };
}

export type OracleClientBindingsActionCatalogAutoRefreshResult =
  OracleActionCatalogAutoRefreshResult & {
    readonly bindings: Readonly<Record<string, OracleActionCatalogAutoRefreshResult>>;
  };

/**
 * One normal synchronization event reconciles all registrations independently.
 * Bindings with the same verified account share ordered work and cooldown.
 * Unattributed legacy bindings remain one group; independent accounts proceed.
 */
export class OracleClientBindingsActionCatalogAutoRefreshCoordinator {
  readonly #options: OracleClientBindingsActionCatalogAutoRefreshOptions;
  readonly #clients = new Map<
    string,
    {
      identity: string;
      readyPending: boolean;
      coordinator: OracleActionCatalogAutoRefreshCoordinator;
    }
  >();
  #endpointReady = false;
  #stopping = false;
  #retryCurrentRevision = false;
  #endpointReadyPending = false;
  #rateLimitCooldownUntil = 0;
  readonly #accountCooldowns = new Map<string | undefined, number>();
  #inFlight: Promise<OracleClientBindingsActionCatalogAutoRefreshResult> | undefined;
  #inFlightBinding: string | undefined;
  #readyRecovery: Promise<OracleClientBindingsActionCatalogAutoRefreshResult> | undefined;
  #readyRecoverySource: Promise<OracleClientBindingsActionCatalogAutoRefreshResult> | undefined;

  constructor(options: OracleClientBindingsActionCatalogAutoRefreshOptions) {
    this.#options = options;
  }

  markEndpointUnavailable(): void {
    this.#endpointReady = false;
    for (const { coordinator } of this.#clients.values()) coordinator.markEndpointUnavailable();
  }

  markEndpointReady(
    retryCurrentRevision = false,
  ): Promise<OracleClientBindingsActionCatalogAutoRefreshResult> {
    this.#endpointReady = true;
    this.#endpointReadyPending = true;
    for (const entry of this.#clients.values()) entry.readyPending = true;
    this.#retryCurrentRevision ||= retryCurrentRevision;
    if (retryCurrentRevision && this.#inFlight !== undefined) {
      if (this.#readyRecovery !== undefined && this.#readyRecoverySource === this.#inFlight)
        return this.#readyRecovery;
      this.#readyRecoverySource = this.#inFlight;
      const recovery = this.#inFlight
        .catch(() => undefined)
        .then(() => this.synchronize("endpoint_ready"))
        .finally(() => {
          if (this.#readyRecovery === recovery) {
            this.#readyRecovery = undefined;
            this.#readyRecoverySource = undefined;
          }
        });
      this.#readyRecovery = recovery;
      return recovery;
    }
    return this.synchronize("endpoint_ready");
  }

  synchronize(
    reason: "endpoint_ready" | "catalog_observed" | "runtime_ready" | "manual_refresh",
    observedRevision?: string,
    clientBinding?: string,
  ): Promise<OracleClientBindingsActionCatalogAutoRefreshResult> {
    if (this.#stopping || !this.#endpointReady) {
      return Promise.resolve({
        state: "endpoint_unavailable",
        bindings: {},
        ...(observedRevision === undefined ? {} : { catalogRevision: observedRevision }),
      });
    }
    if (this.#options.manualRefreshOnly === true && reason !== "manual_refresh") {
      return Promise.resolve({
        state: "explicit_refresh_required",
        bindings: {},
        ...(observedRevision === undefined ? {} : { catalogRevision: observedRevision }),
      });
    }
    if ((this.#options.now?.() ?? Date.now()) < this.#rateLimitCooldownUntil) {
      return Promise.resolve({
        state: "already_attempted",
        bindings: {},
        ...(observedRevision === undefined ? {} : { catalogRevision: observedRevision }),
      });
    }
    const selectedBinding = reason === "manual_refresh" ? clientBinding : undefined;
    if (this.#inFlight !== undefined) {
      if (this.#inFlightBinding === selectedBinding) return this.#inFlight;
      // Different explicit targets must not receive another binding's receipt.
      // Keep the shared flight ordered, then reconcile the requested target.
      return this.#inFlight
        .catch(() => undefined)
        .then(() => this.synchronize(reason, observedRevision, clientBinding));
    }
    const operation = this.#synchronize(reason, observedRevision, selectedBinding).finally(() => {
      if (this.#inFlight === operation) this.#inFlight = undefined;
    });
    this.#inFlightBinding = selectedBinding;
    this.#inFlight = operation;
    return operation;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.markEndpointUnavailable();
    await Promise.all([...this.#clients.values()].map(({ coordinator }) => coordinator.stop()));
    await this.#inFlight?.catch(() => undefined);
    await this.#readyRecovery?.catch(() => undefined);
  }

  async #synchronize(
    reason: "endpoint_ready" | "catalog_observed" | "runtime_ready" | "manual_refresh",
    observedRevision?: string,
    clientBinding?: string,
  ): Promise<OracleClientBindingsActionCatalogAutoRefreshResult> {
    const config = await this.#options.loadConfig();
    const bindings = getOracleClientBindings(config.oracle);
    if (clientBinding !== undefined && !Object.hasOwn(bindings, clientBinding)) {
      throw new Error(`ORACLE_CATALOG_BINDING_NOT_READY:${clientBinding}`);
    }
    for (const [key, entry] of this.#clients) {
      if (!Object.hasOwn(bindings, key)) {
        await entry.coordinator.stop();
        this.#clients.delete(key);
      }
    }
    const retry = this.#retryCurrentRevision;
    this.#retryCurrentRevision = false;
    const markReady = this.#endpointReadyPending;
    this.#endpointReadyPending = false;
    const results: Record<string, OracleActionCatalogAutoRefreshResult> = {};
    const errors: Error[] = [];
    const groups = new Map<string | undefined, Array<[string, (typeof bindings)[string]]>>();
    const knownAccounts = new Set<string>();
    for (const entry of Object.entries(bindings)) {
      const account = this.#options.accountSourceId?.(entry[0]);
      if (account !== undefined && !/^chatgpt:[^:]+:[^:]+$/u.test(account))
        throw new Error("ORACLE_CATALOG_ACCOUNT_SOURCE_INVALID");
      if (account !== undefined) knownAccounts.add(account);
      if (clientBinding !== undefined && entry[0] !== clientBinding) continue;
      const explicitUnknownRefresh =
        reason === "manual_refresh" && clientBinding !== undefined && entry[0] === clientBinding;
      if (
        this.#options.accountSourceId !== undefined &&
        account === undefined &&
        !explicitUnknownRefresh
      ) {
        // An unverified runtime may be the same account as a verified one.
        // Await its existing principal discovery rather than treating it as
        // an independent account and bypassing that account's cooldown.
        results[entry[0]] = { state: "state_verification_required" };
        continue;
      }
      const group = groups.get(account) ?? [];
      group.push(entry);
      groups.set(account, group);
    }
    if (groups.has(undefined) && knownAccounts.size > 0) {
      const sharedCooldowns = await Promise.all(
        [...knownAccounts].map((account) => this.#options.accountCooldown?.read(account)),
      );
      const retryAtUnixMs = Math.max(
        ...[...knownAccounts].map((account) => this.#accountCooldowns.get(account) ?? 0),
        ...sharedCooldowns.map((snapshot) => snapshot?.retryAtUnixMs ?? 0),
      );
      if ((this.#options.now?.() ?? Date.now()) < retryAtUnixMs) {
        for (const [key] of groups.get(undefined) ?? []) {
          results[key] = {
            state: "already_attempted",
            ...(observedRevision === undefined ? {} : { catalogRevision: observedRevision }),
          };
        }
        groups.delete(undefined);
      }
    }
    const groupsSettled = await Promise.allSettled(
      [...groups].map(async ([account, entries]) => {
        for (const [key, binding] of entries) {
          if (this.#stopping || !this.#endpointReady) {
            results[key] = { state: "endpoint_unavailable" };
            continue;
          }
          const shared =
            account === undefined ? undefined : await this.#options.accountCooldown?.read(account);
          const cooldown = Math.max(
            this.#accountCooldowns.get(account) ?? 0,
            shared?.retryAtUnixMs ?? 0,
          );
          if ((this.#options.now?.() ?? Date.now()) < cooldown) {
            results[key] = {
              state: "already_attempted",
              ...(observedRevision === undefined ? {} : { catalogRevision: observedRevision }),
            };
            continue;
          }
          const identity = JSON.stringify([
            account,
            binding.enabled,
            binding.connectorId,
            binding.endpoint,
            binding.registration,
            binding.resource,
            binding.actionVersionId,
            binding.cdpEndpoint,
            binding.remoteCdpTunnel,
          ]);
          let entry = this.#clients.get(key);
          let created = false;
          if (entry === undefined || entry.identity !== identity) {
            await entry?.coordinator.stop();
            const coordinator = new OracleActionCatalogAutoRefreshCoordinator({
              ...this.#options,
              loadConfig: async () =>
                selectOracleClientConfig(await this.#options.loadConfig(), key),
              refresh: (revision) => this.#options.refresh(key, revision),
            });
            entry = { identity, coordinator, readyPending: true };
            this.#clients.set(key, entry);
            created = true;
          }
          try {
            if (this.#options.accountSourceId?.(key) !== account)
              throw new Error("ORACLE_CATALOG_ACCOUNT_SOURCE_CHANGED");
            const makeReady =
              created || entry.readyPending || markReady || reason === "endpoint_ready";
            entry.readyPending = false;
            if (reason === "manual_refresh") {
              results[key] = await entry.coordinator.markEndpointReady(true);
            } else if (makeReady) {
              results[key] = await entry.coordinator.markEndpointReady(retry);
            } else {
              results[key] = await entry.coordinator.synchronize(reason, observedRevision);
            }
          } catch (error) {
            if (isRateLimitError(error)) {
              const snapshot = entry.coordinator.rateLimitSnapshot;
              this.#accountCooldowns.set(
                account,
                Math.max(this.#accountCooldowns.get(account) ?? 0, snapshot.retryAtUnixMs),
              );
              if (account === undefined)
                this.#rateLimitCooldownUntil = Math.max(
                  this.#rateLimitCooldownUntil,
                  snapshot.retryAtUnixMs,
                );
              errors.push(error instanceof Error ? error : new Error(String(error)));
              if (account !== undefined)
                await this.#options.accountCooldown?.observe(account, snapshot);
              break;
            }
            errors.push(
              new Error(`Oracle client binding ${key} action refresh failed`, { cause: error }),
            );
          }
        }
      }),
    );
    for (const result of groupsSettled) {
      if (result.status === "rejected")
        errors.push(
          result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
        );
    }
    if (errors.length === 1 && isRateLimitError(errors[0])) throw errors[0];
    if (errors.length > 0)
      throw new AggregateError(errors, "Oracle client binding reconciliation failed");
    const values = Object.values(results);
    const incomplete = values.find(
      (result) => result.state !== "current" && result.state !== "refreshed",
    );
    const result = incomplete ??
      values.find((value) => value.state === "refreshed") ??
      values[0] ?? { state: "disabled" as const };
    return { ...result, bindings: results };
  }
}

export function oracleActionCatalogMatchesBaseline(
  config: OmniCodexConfig,
  baseline: OmniCodexFullCatalogSnapshot,
): boolean {
  const oracle = config.oracle;
  const verification = oracle?.lastActionCatalogVerification;
  if (
    oracle?.freshLiveVerification !== "verified" ||
    !hasExactActionCatalogContractParity(verification)
  ) {
    return false;
  }
  return (
    verification.catalogToolCount === baseline.chatGptActionToolCount &&
    sameNumbers(verification.catalogPageToolCounts, [baseline.chatGptActionToolCount]) &&
    verification.catalogToolNamesSha256 === baseline.chatGptActionToolNamesSha256 &&
    verification.catalogContractSha256 === baseline.chatGptActionContractSha256 &&
    sameStrings(
      [...verification.verifiedActionNames].sort((left, right) => left.localeCompare(right, "en")),
      baseline.chatGptActionToolNames,
    )
  );
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameOracleActionCatalogSurface(
  left: OmniCodexFullCatalogSnapshot,
  right: OmniCodexFullCatalogSnapshot,
): boolean {
  return (
    left.chatGptActionToolCount === right.chatGptActionToolCount &&
    left.chatGptActionToolNamesSha256 === right.chatGptActionToolNamesSha256 &&
    left.chatGptActionContractSha256 === right.chatGptActionContractSha256
  );
}

function waitForCatalogSettle(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRateLimitError(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || value === undefined || seen.has(value)) return false;
  seen.add(value);
  if (typeof value === "string") {
    return /(?:\b429\b|too many requests|rate[ _-]?limit(?:ed|ing)?)/iu.test(value);
  }
  if (value instanceof AggregateError) {
    return (
      isRateLimitError(value.message, seen) ||
      value.errors.some((error) => isRateLimitError(error, seen)) ||
      isRateLimitError(value.cause, seen)
    );
  }
  if (value instanceof Error) {
    return isRateLimitError(value.message, seen) || isRateLimitError(value.cause, seen);
  }
  if (typeof value === "object") {
    const record = value as {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    return (
      record.status === 429 ||
      record.statusCode === 429 ||
      record.code === 429 ||
      record.code === "429" ||
      isRateLimitError(record.cause, seen)
    );
  }
  return false;
}
