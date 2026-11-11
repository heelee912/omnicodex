import {
  type ChatGptAccessibleNode,
  type ChatGptApprovalBinding,
  type ConsentStrength,
  supportedConsentControlStrength,
} from "../infrastructure/chatgpt/chatgpt-app-approval-adapter.js";
import {
  BoundedCdpSession,
  CdpChatGptApprovalSurface,
  type CdpTarget,
  type CdpWebSocketLike,
  ChatGptLoopbackCdpTransport,
  DEFAULT_CDP_FRAME_BUDGET_BYTES,
  ORACLE_CONVERSATION_PERSISTENT_APPROVAL_LABEL,
  ORACLE_MATERIALIZATION_OPTIONS_LABEL,
} from "../infrastructure/chatgpt/chatgpt-cdp-transport.js";
import { normalizeChatGptConversationUrl } from "../infrastructure/chatgpt/chatgpt-conversation-route.js";
import {
  OracleApprovalTelemetryError,
  type OracleServerApprovalClient,
  type OracleServerApprovalScanResult,
} from "../infrastructure/chatgpt/oracle-chatgpt-server-approval-client.js";
import type { OracleApprovalRunScope } from "./oracle-active-run-registry.js";
import { ORACLE_APPROVAL_MIRROR_OWNERSHIP_MARKER } from "./oracle-conversation-approval-mirror.js";

export type OracleApprovalStrength =
  | ConsentStrength
  | "materialization_options"
  | "affirmative_once";

export const ORACLE_POTENTIAL_APPROVAL_LABELS = new Set([
  "connect",
  "연결",
  "always allow",
  "항상 허용",
  ORACLE_CONVERSATION_PERSISTENT_APPROVAL_LABEL,
  "allow low-risk actions",
  "저위험 액션 허용",
  "allow all actions",
  "모든 액션 허용",
  "모두 허용",
  "allow once",
  "이번만 허용",
  "한 번만 허용",
  "allow",
  "허용",
  "허용하기",
  "confirm",
  "확인",
  ORACLE_MATERIALIZATION_OPTIONS_LABEL,
]);

const AFFIRMATIVE_ONCE_LABELS = new Set([
  "allow once",
  "이번만 허용",
  "한 번만 허용",
  "allow",
  "허용",
  "허용하기",
  "confirm",
  "확인",
]);

const APPROVAL_CONTEXT =
  /\b(?:allow|approval|permission|confirm|create files?|download|tool|action)\b|허용|승인|권한|확인|파일 생성|다운로드|도구|액션/iu;
/**
 * One approval target is a continuously polled UI liveness boundary, not a
 * workflow deadline. A renderer that cannot answer one exact CDP command in
 * sixty seconds is isolated and reacquired while healthy targets continue.
 * The free OCI micro shape can spend tens of seconds in CPU steal while its
 * renderer remains healthy; a shorter lease repeatedly destroys that renderer's
 * CDP session and is slower than waiting for the exact command to settle.
 */
const ORACLE_APPROVAL_TARGET_LIVENESS_TIMEOUT_MS = 60_000;

export interface OracleApprovalPopupWatcherOptions {
  readonly connectorId: string;
  readonly connectorName: string;
  readonly resource: string;
  readonly surface: string;
  readonly cdpEndpoint: string;
  readonly pollIntervalMs?: number;
  /**
   * Idle recovery scans look for a visible OmniCodex approval left behind by
   * an interrupted run. They are intentionally slower than a live-run scan:
   * crawling every historical connector conversation on the hot poll cadence
   * keeps otherwise idle ChatGPT renderers busy and can make the real approval
   * renderer stop answering CDP altogether.
   */
  readonly recoveryScanIntervalMs?: number;
  /**
   * Keep an exact Oracle-owned conversation mirror alive while its ChatGPT
   * turn is advancing through native tool results. Account discovery refreshes
   * this lease from every client surface; it is not a workflow timeout.
   */
  readonly conversationActivityLeaseMs?: number;
  readonly unhealthyFailureThreshold?: number;
  readonly resolveActiveRun?: (
    target: CdpTarget,
    signal: AbortSignal,
  ) => Promise<OracleApprovalRunScope | undefined>;
  readonly recoverUnresponsiveOwnedMirror?: (
    target: CdpTarget,
    signal: AbortSignal,
  ) => Promise<void>;
  /** Closes only an OmniCodex-owned mirror after a stable empty DOM readback. */
  readonly releaseStableIdleOwnedMirror?: (target: CdpTarget, signal: AbortSignal) => Promise<void>;
  readonly onEvent?: (event: OracleApprovalPopupEvent) => Promise<void> | void;
  readonly transport?: ChatGptLoopbackCdpTransport;
  readonly connectSession?: (
    transport: ChatGptLoopbackCdpTransport,
    target: CdpTarget,
    signal: AbortSignal,
    onNativeFrame?: (data: unknown) => void,
  ) => Promise<BoundedCdpSession>;
  /**
   * Account-conversation watcher owned by Oracle. This is the primary path:
   * it sees a pending OmniCodex approval regardless of which client submitted
   * the turn. Rendered-DOM scanning remains a fallback for settings surfaces.
   */
  readonly serverApprovalClient?: OracleServerApprovalClient;
  /** Keep the existing durable receipt until the client UI is synchronized. */
  readonly synchronizeApprovalReceipt?: (
    receipt: OracleServerApprovalScanResult["receipts"][number],
    signal: AbortSignal,
  ) => Promise<boolean>;
  /** Opens one exact changed OmniCodex conversation in the isolated Oracle browser. */
  readonly ensureConversationTarget?: (
    conversationUrl: string,
    signal: AbortSignal,
  ) => Promise<void>;
}

export interface OracleApprovalPopupEvent {
  readonly type:
    | "watcher_started"
    | "activated"
    | "receipt_sync_failed"
    | "target_recovered"
    | "target_released"
    | "rate_limited"
    | "server_response_error"
    | "server_requests_observed"
    | "watcher_error"
    | "watcher_unhealthy"
    | "watcher_stopped";
  readonly targetId?: string;
  readonly oracleRunId?: string;
  readonly conversationUrl?: string;
  readonly label?: string;
  readonly strength?: OracleApprovalStrength;
  readonly error?: string;
  readonly rateLimit?: OracleServerApprovalScanResult["rateLimit"];
  readonly serverError?: OracleServerApprovalScanResult["errors"][number];
  readonly requestStats?: OracleServerApprovalScanResult["requestStats"];
  /** Authoritative approval result; acknowledge only after its sink commits. */
  readonly receipt?: OracleServerApprovalScanResult["receipts"][number];
}

export interface OracleApprovalPopupWatcherStatus {
  readonly state: "stopped" | "starting" | "ready" | "degraded" | "unhealthy";
  readonly consecutiveFailures: number;
  readonly watchedTargets: number;
  readonly lastSuccessfulScanAt?: string;
  readonly lastError?: string;
  readonly serverRateLimit?: OracleServerApprovalScanResult["rateLimit"];
  readonly serverErrors?: OracleServerApprovalScanResult["errors"];
  readonly lastRequestStats?: OracleServerApprovalScanResult["requestStats"];
}

/**
 * Page-renderer failures are target-local and the watcher already reacquires
 * those sessions. An inventory response timeout can also be a busy remote
 * browser, not a broken SSH forward. Preserve the forward and the watcher's
 * unhealthy state while fresh requests retry. Actual socket failures and SSH
 * keepalive/process exit still trigger transport recovery.
 */
export function oracleApprovalWatcherRequiresTunnelRecovery(error: string | undefined): boolean {
  if (error === undefined) return true;
  return !(
    error.startsWith("CDP request timeout:") ||
    error.startsWith("CDP command timeout:") ||
    /operation was aborted due to timeout/iu.test(error) ||
    error.startsWith("ORACLE_SERVER_APPROVAL_") ||
    error.startsWith("ORACLE_APPROVAL_TARGET_SCAN_FAILED:") ||
    error.startsWith("ORACLE_APPROVAL_ACTIVATION_FAILED:")
  );
}

/**
 * A target-bound renderer/session failure is recovered by the watcher's
 * per-target reacquisition path. Recycling the shared SSH/CDP transport for
 * that failure interrupts every other approval target and creates a reconnect
 * storm under concurrent Pro use. Only unattributed transport failures may
 * retire the shared tunnel.
 */
export function oracleApprovalWatcherEventRequiresTunnelRecovery(
  event: Pick<OracleApprovalPopupEvent, "targetId" | "error">,
): boolean {
  return event.targetId === undefined && oracleApprovalWatcherRequiresTunnelRecovery(event.error);
}

interface WatchedTarget {
  readonly target: CdpTarget;
  readonly session: BoundedCdpSession;
  readonly ownerSurface: CdpChatGptApprovalSurface;
  activeSurface?: CdpChatGptApprovalSurface;
  activeRunId?: string;
  activeConversationUrl?: string;
  approvalSurfaceReady?: boolean;
  nextApprovalScanAtUnixMs?: number;
  emptyOwnerRevision?: string;
  emptyOwnerObservationCount?: number;
}

interface TargetRetryState {
  readonly consecutiveFailures: number;
  readonly retryAfterUnixMs: number;
  readonly error: Error;
}

/**
 * Approval-only watcher for the user's already-running ChatGPT browser.
 * It never submits a prompt, invokes a model, creates a tab, or owns a browser process.
 */
export class OracleApprovalPopupWatcher {
  readonly #options: OracleApprovalPopupWatcherOptions;
  readonly #transport: ChatGptLoopbackCdpTransport;
  readonly #connectSession: NonNullable<OracleApprovalPopupWatcherOptions["connectSession"]>;
  readonly #resolveActiveRun: NonNullable<OracleApprovalPopupWatcherOptions["resolveActiveRun"]>;
  readonly #targets = new Map<string, WatchedTarget>();
  #lastRequestStats: OracleServerApprovalScanResult["requestStats"];
  readonly #reportedTargetErrors = new Map<string, string>();
  readonly #targetRetries = new Map<string, TargetRetryState>();
  readonly #recoveredMirrorTargetIds = new Set<string>();
  readonly #activatedRevisions = new Set<string>();
  readonly #receiptSync = new Map<
    string,
    {
      attempts: number;
      retryAt: number;
      acknowledged: boolean;
      flight?: Promise<void> | undefined;
    }
  >();
  readonly #pendingConversationTargets = new Set<string>();
  readonly #conversationActivityUntil = new Map<string, number>();
  readonly #failedTargets = new Map<string, CdpTarget>();
  readonly #unhealthyFailureThreshold: number;
  readonly #pollIntervalMs: number;
  readonly #recoveryScanIntervalMs: number;
  readonly #conversationActivityLeaseMs: number;
  #abort: AbortController | undefined;
  #loop: Promise<void> | undefined;
  #domScan: Promise<void> | undefined;
  #domFailures = 0;
  #domError: string | undefined;
  #consecutiveFailures = 0;
  #lastSuccessfulScanAt: string | undefined;
  #lastError: string | undefined;
  #nextRecoveryScanAtUnixMs = 0;
  #nextInventoryScanAtUnixMs = 0;
  #serverRateLimit: OracleServerApprovalScanResult["rateLimit"];
  #reportedRateLimitUntil = 0;
  #serverErrors: OracleServerApprovalScanResult["errors"] = [];
  readonly #reportedServerErrors = new Map<string, number>();

  constructor(options: OracleApprovalPopupWatcherOptions) {
    this.#options = options;
    this.#transport =
      options.transport ??
      new ChatGptLoopbackCdpTransport({
        endpoint: options.cdpEndpoint,
        timeoutMs: ORACLE_APPROVAL_TARGET_LIVENESS_TIMEOUT_MS,
      });
    this.#connectSession = options.connectSession ?? connectBoundedSession;
    this.#resolveActiveRun = options.resolveActiveRun ?? (async () => undefined);
    this.#unhealthyFailureThreshold = Math.max(
      2,
      Math.min(20, options.unhealthyFailureThreshold ?? 3),
    );
    this.#pollIntervalMs = Math.max(250, Math.min(5_000, options.pollIntervalMs ?? 500));
    this.#recoveryScanIntervalMs = Math.max(
      250,
      Math.min(60_000, options.recoveryScanIntervalMs ?? 5_000),
    );
    this.#conversationActivityLeaseMs = Math.max(
      1_000,
      Math.min(300_000, options.conversationActivityLeaseMs ?? 30_000),
    );
  }

  get status(): OracleApprovalPopupWatcherStatus {
    const lastError = this.#lastError ?? this.#domError;
    const rateLimited =
      this.#serverRateLimit !== undefined && this.#serverRateLimit.retryAtUnixMs > Date.now();
    const state =
      this.#loop === undefined
        ? "stopped"
        : Math.max(this.#consecutiveFailures, this.#domFailures) >= this.#unhealthyFailureThreshold
          ? "unhealthy"
          : this.#consecutiveFailures > 0 || this.#domFailures > 0 || rateLimited
            ? "degraded"
            : this.#lastSuccessfulScanAt === undefined
              ? "starting"
              : "ready";
    return {
      state,
      consecutiveFailures: Math.max(this.#consecutiveFailures, this.#domFailures),
      watchedTargets: this.#targets.size,
      ...(this.#lastSuccessfulScanAt === undefined
        ? {}
        : { lastSuccessfulScanAt: this.#lastSuccessfulScanAt }),
      ...(lastError === undefined ? {} : { lastError }),
      ...(this.#serverErrors.length === 0 ? {} : { serverErrors: this.#serverErrors }),
      ...(rateLimited ? { serverRateLimit: this.#serverRateLimit } : {}),
      ...(this.#lastRequestStats === undefined ? {} : { lastRequestStats: this.#lastRequestStats }),
    };
  }

  start(): void {
    if (this.#loop !== undefined) return;
    this.#consecutiveFailures = 0;
    this.#domFailures = 0;
    this.#domError = undefined;
    this.#lastSuccessfulScanAt = undefined;
    this.#lastError = undefined;
    this.#nextRecoveryScanAtUnixMs = 0;
    this.#nextInventoryScanAtUnixMs = 0;
    const abort = new AbortController();
    this.#abort = abort;
    this.#loop = this.#run(abort.signal).finally(async () => {
      await this.#domScan;
      this.#closeTargets();
      await Promise.allSettled([...this.#receiptSync.values()].map((state) => state.flight));
      this.#receiptSync.clear();
      await this.#options.serverApprovalClient?.stop().catch(() => undefined);
      this.#loop = undefined;
      this.#abort = undefined;
    });
  }

  async stop(): Promise<void> {
    this.#abort?.abort(new Error("Oracle approval watcher stopped"));
    await this.#loop?.catch(() => undefined);
  }

  /** Wakes the exact request target without tearing down any live inspector session. */
  wake(conversationUrl?: string, options: { readonly serverScan?: boolean } = {}): void {
    if (options.serverScan === false && conversationUrl === undefined) return;
    // Exact request attribution queues only that conversation. An opaque MCP
    // session cannot be expanded into a guessed URL or an account-wide scan.
    if (conversationUrl !== undefined) {
      const canonicalConversationUrl = normalizeChatGptConversationUrl(conversationUrl);
      if (canonicalConversationUrl === undefined) return;
      const alreadyActive =
        (this.#conversationActivityUntil.get(canonicalConversationUrl) ?? 0) > Date.now();
      if (options.serverScan !== false) {
        this.#options.serverApprovalClient?.requestScan?.(canonicalConversationUrl);
      }
      if (!alreadyActive || options.serverScan !== false) {
        this.#pendingConversationTargets.add(canonicalConversationUrl);
      }
      this.#conversationActivityUntil.set(
        canonicalConversationUrl,
        Date.now() + this.#conversationActivityLeaseMs,
      );
      pruneExpiredConversationActivity(this.#conversationActivityUntil, Date.now());
      // An admitted MCP request is already executing. Keep its existing mirror
      // alive, without turning every request/result callback into another
      // account read or target inventory. Pending confirmations arrive through
      // the independent conversation event stream or durable recovery queue.
      if (options.serverScan === false && alreadyActive) return;
    }
    this.#nextInventoryScanAtUnixMs = 0;
    for (const watched of this.#targets.values()) {
      if (
        conversationUrl !== undefined &&
        watched.activeConversationUrl !== undefined &&
        watched.activeConversationUrl !== conversationUrl
      ) {
        continue;
      }
      delete watched.nextApprovalScanAtUnixMs;
    }
    // New activity wakes healthy targets without cancelling failed-target backoff.
  }

  /**
   * Waits for the persistent watcher itself to own and successfully inspect
   * the mirrored conversation. A second inspector session would race this
   * owner and can make a small remote Chrome reject both sockets.
   */
  async waitUntilConversationReady(conversationUrl: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    this.wake(conversationUrl);
    while (Date.now() < deadline) {
      if (
        [...this.#targets.values()].some(
          (watched) =>
            watched.activeConversationUrl === conversationUrl &&
            watched.approvalSurfaceReady === true,
        )
      ) {
        return;
      }
      if (this.#loop === undefined) throw new Error("ORACLE_APPROVAL_WATCHER_NOT_RUNNING");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("ORACLE_APPROVAL_WATCHER_PREARM_TIMEOUT");
  }

  async #run(signal: AbortSignal): Promise<void> {
    await this.#event({ type: "watcher_started" });
    const interval = this.#pollIntervalMs;
    let reportedError: string | undefined;
    let reportedUnhealthyError: string | undefined;
    while (!signal.aborted) {
      try {
        const completed = await this.#scan(signal);
        if (completed) {
          this.#consecutiveFailures = 0;
          this.#lastSuccessfulScanAt = new Date().toISOString();
          this.#lastError = undefined;
          reportedError = undefined;
          reportedUnhealthyError = undefined;
        }
      } catch (error) {
        if (signal.aborted) break;
        const message = toError(error).message;
        // Account API throttling is not a broken CDP tunnel. Keep one stable
        // Oracle session (and its in-page backoff clock) instead of recycling
        // the tunnel and immediately creating another rate-limit burst.
        this.#consecutiveFailures = oracleServerApprovalRateLimited(message)
          ? 1
          : this.#consecutiveFailures + 1;
        this.#lastError = message;
        if (message !== reportedError) {
          reportedError = message;
          await this.#event({ type: "watcher_error", error: message });
        }
        if (
          this.#consecutiveFailures >= this.#unhealthyFailureThreshold &&
          message !== reportedUnhealthyError
        ) {
          reportedUnhealthyError = message;
          await this.#event({ type: "watcher_unhealthy", error: message });
        }
      }
      await delay(interval, signal).catch(() => undefined);
    }
    await this.#event({ type: "watcher_stopped" });
  }

  async #scan(signal: AbortSignal): Promise<boolean> {
    pruneExpiredConversationActivity(this.#conversationActivityUntil, Date.now());
    let serverScanCompleted = false;
    const serverApprovalClient = this.#options.serverApprovalClient;
    if (serverApprovalClient !== undefined) {
      try {
        const result = await serverApprovalClient.scan(signal);
        if (
          result.requestStats !== undefined &&
          result.requestStats.getCount +
            result.requestStats.postCount +
            result.requestStats.moduleInitializationCount +
            result.requestStats.rateLimitCount >
            0
        ) {
          this.#lastRequestStats = result.requestStats;
          await this.#event({
            type: "server_requests_observed",
            requestStats: result.requestStats,
          });
        }
        serverScanCompleted = true;
        this.#serverRateLimit = result.rateLimit;
        this.#serverErrors = result.errors;
        for (const serverError of result.errors) {
          if (serverError.observedAtUnixMs === undefined) continue;
          if (
            this.#reportedServerErrors.get(serverError.conversationId) ===
            serverError.observedAtUnixMs
          )
            continue;
          this.#reportedServerErrors.set(serverError.conversationId, serverError.observedAtUnixMs);
          await this.#event({ type: "server_response_error", serverError });
        }
        if (
          result.rateLimit !== undefined &&
          // Recovery keeps the previous 429 as history. A new watcher must
          // not announce that expired history as a fresh active restriction.
          result.rateLimit.retryAtUnixMs > Date.now() &&
          result.rateLimit.retryAtUnixMs > this.#reportedRateLimitUntil
        ) {
          this.#reportedRateLimitUntil = result.rateLimit.retryAtUnixMs;
          await this.#event({ type: "rate_limited", rateLimit: result.rateLimit });
        }
        // Open the exact DOM mirror without requeuing the just-completed
        // server read; feeding results back into wake would create a poll loop.
        for (const conversationUrl of result.conversationUrls) {
          this.#pendingConversationTargets.add(conversationUrl);
          this.#conversationActivityUntil.set(
            conversationUrl,
            Date.now() + this.#conversationActivityLeaseMs,
          );
        }
        const receiptIds = new Set(result.receipts.map((receipt) => receipt.clientMessageId));
        for (const [id, state] of this.#receiptSync) {
          if (
            state.acknowledged &&
            !receiptIds.has(id) &&
            state.flight === undefined &&
            result.requestStats !== undefined
          )
            this.#receiptSync.delete(id);
        }
        for (const receipt of result.receipts) {
          this.#reportedServerErrors.delete(receipt.conversationId);
          if (this.#receiptSync.has(receipt.clientMessageId)) {
            this.#synchronizeReceipt(receipt, signal);
            continue;
          }
          const recorded = await this.#event({
            type: "activated",
            conversationUrl: receipt.conversationUrl,
            label: "Allow OmniCodex for this conversation",
            strength:
              receipt.rememberAnswer || receipt.action === "always_allow"
                ? "persistent"
                : "affirmative_once",
            receipt,
          });
          if (!recorded) {
            // The client replays its durable outbox. A logging failure must
            // neither erase this receipt nor repeat the approval mutation.
            throw new Error("ORACLE_SERVER_APPROVAL_RECEIPT_PERSIST_FAILED");
          }
          if (this.#options.synchronizeApprovalReceipt === undefined) {
            serverApprovalClient.acknowledgeReceipts?.([receipt]);
          } else {
            this.#receiptSync.set(receipt.clientMessageId, {
              attempts: 0,
              retryAt: 0,
              acknowledged: false,
            });
            this.#synchronizeReceipt(receipt, signal);
          }
        }
        const blockingServerError = result.errors.find(
          ({ error, status, submissionState }) =>
            submissionState !== "unknown" &&
            status !== 408 &&
            status !== 429 &&
            !(status !== undefined && status >= 500) &&
            (status !== undefined ||
              !oracleServerApprovalTransient(`ORACLE_SERVER_APPROVAL_PARTIAL:${error}`)),
        );
        if (blockingServerError !== undefined) {
          const boundary =
            blockingServerError.status === undefined
              ? "ORACLE_SERVER_APPROVAL_PARTIAL"
              : `ORACLE_SERVER_APPROVAL_HTTP_${blockingServerError.status}`;
          throw new Error(`${boundary}:${blockingServerError.error}`);
        }
      } catch (error) {
        if (error instanceof OracleApprovalTelemetryError) {
          if (
            error.telemetry.requestStats !== undefined &&
            JSON.stringify(error.telemetry.requestStats) !== JSON.stringify(this.#lastRequestStats)
          ) {
            this.#lastRequestStats = error.telemetry.requestStats;
            await this.#event({
              type: "server_requests_observed",
              requestStats: error.telemetry.requestStats,
            });
          }
          if (
            error.telemetry.rateLimit !== undefined &&
            error.telemetry.rateLimit.retryAtUnixMs > Date.now() &&
            error.telemetry.rateLimit.retryAtUnixMs > this.#reportedRateLimitUntil
          ) {
            this.#reportedRateLimitUntil = error.telemetry.rateLimit.retryAtUnixMs;
            this.#serverRateLimit = error.telemetry.rateLimit;
            await this.#event({ type: "rate_limited", rateLimit: error.telemetry.rateLimit });
          }
        }
        if (!oracleServerApprovalTransient(toError(error).message)) throw error;
        // The exact-conversation client reacquires its own in-page session.
        // A transient fetch failure must not interrupt mirror cleanup or
        // recycle a healthy SSH/CDP tunnel.
      }
    }
    if (serverApprovalClient !== undefined) {
      // Renderer work follows exact targets returned by an event/receipt read;
      // an idle timer must not discover work by scanning conversation tabs.
      if (
        this.#pendingConversationTargets.size > 0 ||
        this.#failedTargets.size > 0 ||
        [...this.#targets.values()].some((watched) => isOwnedApprovalMirrorTarget(watched.target))
      )
        this.#startDomScan(signal);
      return serverScanCompleted;
    }
    return this.#scanDom(signal);
  }

  #startDomScan(signal: AbortSignal): void {
    if (this.#domScan !== undefined || signal.aborted) return;
    const flight = this.#scanDom(signal)
      .then(
        async (completed) => {
          if (completed) {
            this.#domFailures = 0;
            this.#domError = undefined;
            this.#lastSuccessfulScanAt = new Date().toISOString();
          }
        },
        async (error) => {
          if (signal.aborted) return;
          const message = toError(error).message;
          this.#domFailures += 1;
          if (message !== this.#domError)
            await this.#event({ type: "watcher_error", error: message });
          this.#domError = message;
          if (this.#domFailures === this.#unhealthyFailureThreshold) {
            await this.#event({ type: "watcher_unhealthy", error: message });
          }
        },
      )
      .finally(() => {
        if (this.#domScan === flight) this.#domScan = undefined;
      });
    this.#domScan = flight;
  }

  async #scanDom(signal: AbortSignal): Promise<boolean> {
    const serverApprovalClient = this.#options.serverApprovalClient;
    const cleanupTargets =
      serverApprovalClient === undefined
        ? []
        : [
            ...new Map([
              ...[...this.#targets.values()].map(({ target }) => [target.id, target] as const),
              ...this.#failedTargets,
            ]).values(),
          ].filter(isOwnedApprovalMirrorTarget);
    const queuedTargets = [...this.#pendingConversationTargets];
    const requestedTargets =
      serverApprovalClient === undefined
        ? undefined
        : new Set([
            ...queuedTargets,
            ...cleanupTargets
              .map((target) => normalizeChatGptConversationUrl(target.url))
              .filter((url): url is string => url !== undefined),
          ]);
    if (
      requestedTargets !== undefined &&
      (requestedTargets.size === 0 || Date.now() < this.#nextInventoryScanAtUnixMs)
    )
      return false;
    // One DOM flight may wait for a slow renderer; exact server receipt reads
    // continue independently with their existing pacing and durable queue.
    if (this.#options.ensureConversationTarget !== undefined) {
      for (const conversationUrl of this.#pendingConversationTargets) {
        await this.#options.ensureConversationTarget(conversationUrl, signal);
        this.#pendingConversationTargets.delete(conversationUrl);
      }
    }
    const inventoryStartedAt = Date.now();
    if (inventoryStartedAt < this.#nextInventoryScanAtUnixMs) return false;
    // Assume the idle cadence until an approval control is actually observed.
    // This prevents a live but approval-free renderer from forcing a complete
    // /json/list inventory on every hot loop tick.
    this.#nextInventoryScanAtUnixMs = inventoryStartedAt + this.#recoveryScanIntervalMs;
    const targetErrors: Error[] = [];
    const activationErrors: Error[] = [];
    let attemptedTargetScans = 0;
    let successfulTargetScans = 0;
    const failedTargetRetryDue = [...this.#failedTargets.keys()].some(
      (targetId) => Date.now() >= (this.#targetRetries.get(targetId)?.retryAfterUnixMs ?? 0),
    );
    const inventory =
      serverApprovalClient !== undefined && queuedTargets.length === 0 && !failedTargetRetryDue
        ? { targets: cleanupTargets, connectorTargets: [] }
        : await this.#transport.listChatGptTargetInventory(signal, this.#options.connectorId);
    const { connectorTargets } = inventory;
    const targets =
      requestedTargets === undefined
        ? inventory.targets
        : inventory.targets.filter((target) => {
            const url = normalizeChatGptConversationUrl(target.url);
            return url !== undefined && requestedTargets.has(url);
          });
    const inventoryTargetIds = new Set(targets.map((target) => target.id));
    for (const [targetId, target] of this.#failedTargets) {
      if (inventoryTargetIds.has(targetId)) continue;
      this.#failedTargets.delete(targetId);
      this.#targetRetries.delete(targetId);
      this.#reportedTargetErrors.delete(targetId);
      // The exact failed mirror may have disappeared during recovery. Retain
      // its conversation work for normal reacquisition, not an account scan.
      const url = normalizeChatGptConversationUrl(target.url);
      if (url !== undefined) this.#pendingConversationTargets.add(url);
    }
    for (const targetId of this.#recoveredMirrorTargetIds) {
      if (!inventoryTargetIds.has(targetId)) this.#recoveredMirrorTargetIds.delete(targetId);
    }
    const connectorTargetIds = new Set(connectorTargets.map((target) => target.id));
    const resolved: Array<{
      readonly target: CdpTarget;
      readonly activeRun?: OracleApprovalRunScope;
    }> = [];
    for (const target of targets) {
      try {
        const activeRun = await this.#resolveActiveRun(target, signal);
        resolved.push({ target, ...(activeRun === undefined ? {} : { activeRun }) });
      } catch (error) {
        if (signal.aborted) return false;
        attemptedTargetScans += 1;
        await this.#targetError(target, error);
        targetErrors.push(toError(error));
        const watched = this.#targets.get(target.id);
        watched?.session.close();
        this.#targets.delete(target.id);
      }
    }
    // A live Oracle run is the authoritative target. While any such run exists,
    // do not crawl every older ChatGPT conversation that still retains an
    // OmniCodex iframe; large histories make those accessibility trees costly
    // and can starve the one approval that is actually blocking execution.
    const active = resolved.filter((candidate) => candidate.activeRun !== undefined);
    const recoverable = resolved.filter(
      (candidate) =>
        !this.#recoveredMirrorTargetIds.has(candidate.target.id) &&
        (connectorTargetIds.has(candidate.target.id) ||
          isOwnedApprovalMirrorTarget(candidate.target)),
    );
    const now = Date.now();
    const recoveryDue = active.length === 0 && now >= this.#nextRecoveryScanAtUnixMs;
    if (recoveryDue) this.#nextRecoveryScanAtUnixMs = now + this.#recoveryScanIntervalMs;
    const candidates = active.length > 0 ? active : recoveryDue ? recoverable : [];
    // Retain live recovery sessions between the slower recovery ticks. Closing
    // and reconnecting them on every hot tick would recreate the very CDP churn
    // that the slower cadence is intended to remove.
    const retained = active.length > 0 ? active : recoverable;
    const currentIds = new Set(retained.map(({ target }) => target.id));
    for (const [targetId, watched] of this.#targets) {
      if (currentIds.has(targetId)) continue;
      watched.session.close();
      this.#targets.delete(targetId);
    }
    for (const targetId of this.#targetRetries.keys()) {
      if (currentIds.has(targetId)) continue;
      this.#targetRetries.delete(targetId);
      this.#reportedTargetErrors.delete(targetId);
    }
    // A deliberately skipped idle-recovery tick is neither success nor
    // failure. Preserve the last authoritative scan state until the next real
    // target scan instead of clearing a degraded/unhealthy result merely
    // because the hot loop woke up between recovery intervals.
    if (active.length === 0 && !recoveryDue) return false;
    await Promise.all(
      candidates.map(async ({ target, activeRun }) => {
        if (signal.aborted) return;
        const deferred = this.#targetRetries.get(target.id);
        if (deferred !== undefined && Date.now() < deferred.retryAfterUnixMs) {
          targetErrors.push(deferred.error);
          return;
        }
        let watched = this.#targets.get(target.id);
        // Mirrors keep a stable active-run identity after an approval ends.
        // An empty approval surface must therefore use the idle cadence even
        // while that identity remains registered. Keep its session and inspect
        // new runs immediately; do not close tabs or drop pending work.
        if (
          watched?.activeRunId === activeRun?.oracleRunId &&
          Date.now() < (watched?.nextApprovalScanAtUnixMs ?? 0)
        ) {
          return;
        }
        attemptedTargetScans += 1;
        if (watched === undefined) {
          try {
            const observeFrame = serverApprovalClient?.observeConversationFrame;
            const session = await this.#connectSession(
              this.#transport,
              target,
              signal,
              observeFrame === undefined
                ? undefined
                : (data) => {
                    if (!signal.aborted) observeFrame.call(serverApprovalClient, target.url, data);
                  },
            );
            if (observeFrame !== undefined) {
              try {
                // The existing exact mirror owns the conversation subscription;
                // the home renderer only supplies user-level notifications.
                await session.command("Network.enable", {}, signal);
              } catch (error) {
                session.close();
                throw error;
              }
            }
            watched = {
              session,
              target,
              ownerSurface: this.#surface(session, this.#fallbackBinding(target)),
            };
            this.#targets.set(target.id, watched);
          } catch (error) {
            if (signal.aborted) return;
            const failure = this.#recordTargetFailure(target, error);
            await this.#targetError(target, failure);
            await this.#recoverOwnedMirrorIfNeeded(target, signal);
            targetErrors.push(failure);
            return;
          }
        }
        try {
          let approvalSurface = watched.ownerSurface;
          if (activeRun !== undefined) {
            if (
              watched.activeRunId !== activeRun.oracleRunId ||
              watched.activeSurface === undefined
            ) {
              watched.activeRunId = activeRun.oracleRunId;
              watched.activeConversationUrl = activeRun.conversationUrl;
              watched.approvalSurfaceReady = false;
              watched.activeSurface = this.#surface(watched.session, this.#binding(activeRun));
            }
            approvalSurface = watched.activeSurface;
          }
          const snapshot = await approvalSurface.approvalControlSnapshot(
            ORACLE_POTENTIAL_APPROVAL_LABELS,
            signal,
          );
          if (activeRun !== undefined) watched.approvalSurfaceReady = true;
          this.#targetRetries.delete(target.id);
          this.#failedTargets.delete(target.id);
          const control = selectApprovalControl(snapshot.nodes);
          if (control === undefined) {
            const stableOwnerRevision =
              snapshot.documentReady === true &&
              snapshot.responseInProgress === false &&
              /^oracle-v2-\d+$/u.test(snapshot.domRevision);
            if (stableOwnerRevision) {
              watched.emptyOwnerObservationCount =
                watched.emptyOwnerRevision === snapshot.domRevision
                  ? (watched.emptyOwnerObservationCount ?? 0) + 1
                  : 1;
              watched.emptyOwnerRevision = snapshot.domRevision;
            } else {
              delete watched.emptyOwnerRevision;
              delete watched.emptyOwnerObservationCount;
            }
            if (
              stableOwnerRevision &&
              (watched.emptyOwnerObservationCount ?? 0) >= 2 &&
              !this.#hasActiveConversationLease(target, watched, activeRun) &&
              isOwnedApprovalMirrorTarget(target) &&
              this.#options.releaseStableIdleOwnedMirror !== undefined
            ) {
              await this.#options.releaseStableIdleOwnedMirror(target, signal);
              watched.session.close();
              this.#targets.delete(target.id);
              this.#targetRetries.delete(target.id);
              this.#reportedTargetErrors.delete(target.id);
              this.#recoveredMirrorTargetIds.delete(target.id);
              const releasedConversationUrl =
                normalizeChatGptConversationUrl(activeRun?.conversationUrl) ??
                normalizeChatGptConversationUrl(watched.activeConversationUrl) ??
                normalizeChatGptConversationUrl(target.url);
              if (releasedConversationUrl !== undefined) {
                this.#conversationActivityUntil.delete(releasedConversationUrl);
              }
              successfulTargetScans += 1;
              await this.#event({
                type: "target_released",
                targetId: target.id,
                conversationUrl: activeRun?.conversationUrl ?? target.url,
              });
              return;
            }
            watched.nextApprovalScanAtUnixMs = Date.now() + this.#recoveryScanIntervalMs;
            this.#reportedTargetErrors.delete(target.id);
            successfulTargetScans += 1;
            return;
          }
          delete watched.emptyOwnerRevision;
          delete watched.emptyOwnerObservationCount;
          this.#nextInventoryScanAtUnixMs = Date.now() + this.#pollIntervalMs;
          delete watched.nextApprovalScanAtUnixMs;
          if (serverApprovalClient !== undefined) {
            // Native conversation-update events own file approvals. DOM timer
            // observations must neither discover approval work nor activate it.
            successfulTargetScans += 1;
            return;
          }
          const activationKey = `${target.id}\0${snapshot.domRevision}\0${control.node.ref}`;
          if (this.#activatedRevisions.has(activationKey)) {
            this.#reportedTargetErrors.delete(target.id);
            successfulTargetScans += 1;
            return;
          }
          try {
            await approvalSurface.activate(control.node.ref, snapshot.domRevision, signal);
          } catch (error) {
            if (signal.aborted) return;
            const failure = toError(error);
            await this.#targetError(target, failure);
            activationErrors.push(failure);
            watched.session.close();
            this.#targets.delete(target.id);
            return;
          }
          // A transient CDP failure must not turn a still-visible approval into a
          // permanently skipped one. Remember the revision only after the click
          // has been acknowledged; the next scan can then recover an interrupted
          // activation while still suppressing duplicate successful clicks.
          this.#activatedRevisions.add(activationKey);
          trimSet(this.#activatedRevisions, 1_024);
          this.#reportedTargetErrors.delete(target.id);
          successfulTargetScans += 1;
          await this.#event({
            type: "activated",
            targetId: target.id,
            ...(activeRun === undefined ? {} : { oracleRunId: activeRun.oracleRunId }),
            conversationUrl: activeRun?.conversationUrl ?? target.url,
            label: control.node.name,
            strength: control.strength,
          });
        } catch (error) {
          if (signal.aborted) return;
          const failure = this.#recordTargetFailure(target, error);
          await this.#targetError(target, failure);
          await this.#recoverOwnedMirrorIfNeeded(target, signal);
          targetErrors.push(failure);
          watched.session.close();
          this.#targets.delete(target.id);
        }
      }),
    );
    if (activationErrors.length > 0) {
      throw new Error(
        `ORACLE_APPROVAL_ACTIVATION_FAILED:${activationErrors[0]?.message ?? "unknown"}`,
      );
    }
    if (targetErrors.length > 0 && successfulTargetScans === 0) {
      if (attemptedTargetScans === 0) return false;
      throw new Error(
        `ORACLE_APPROVAL_TARGET_SCAN_FAILED:${targetErrors[0]?.message ?? "unknown"}`,
      );
    }
    if (attemptedTargetScans === 0 && candidates.length > 0) return false;
    return true;
  }

  #fallbackBinding(target: CdpTarget): ChatGptApprovalBinding {
    const watcherId = `approval-watcher-${target.id}`;
    return {
      appConnectorId: this.#options.connectorId,
      appName: this.#options.connectorName,
      oracleRunId: watcherId,
      sessionId: watcherId,
      correlationId: watcherId,
      mcpServerResource: this.#options.resource,
      mcpSurface: this.#options.surface,
    };
  }

  #binding(activeRun: OracleApprovalRunScope): ChatGptApprovalBinding {
    return {
      appConnectorId: this.#options.connectorId,
      appName: this.#options.connectorName,
      oracleRunId: activeRun.oracleRunId,
      sessionId: activeRun.sessionId,
      correlationId: activeRun.correlationId,
      mcpServerResource: this.#options.resource,
      mcpSurface: this.#options.surface,
    };
  }

  #surface(session: BoundedCdpSession, binding: ChatGptApprovalBinding): CdpChatGptApprovalSurface {
    return new CdpChatGptApprovalSurface(
      session,
      binding,
      "__OMNICODEX_APPROVAL_WATCHER_NO_RESULT__",
      [this.#options.connectorName],
    );
  }

  #hasActiveConversationLease(
    target: CdpTarget,
    watched: WatchedTarget,
    activeRun: OracleApprovalRunScope | undefined,
  ): boolean {
    const conversationUrl =
      normalizeChatGptConversationUrl(activeRun?.conversationUrl) ??
      normalizeChatGptConversationUrl(watched.activeConversationUrl) ??
      normalizeChatGptConversationUrl(target.url);
    if (conversationUrl === undefined) return false;
    const activeUntil = this.#conversationActivityUntil.get(conversationUrl) ?? 0;
    if (activeUntil > Date.now()) return true;
    this.#conversationActivityUntil.delete(conversationUrl);
    return false;
  }

  async #targetError(target: CdpTarget, error: unknown): Promise<void> {
    const message = toError(error).message;
    if (this.#reportedTargetErrors.get(target.id) === message) return;
    this.#reportedTargetErrors.set(target.id, message);
    await this.#event({
      type: "watcher_error",
      targetId: target.id,
      error: message,
    });
  }

  #recordTargetFailure(target: CdpTarget, error: unknown): Error {
    const targetId = target.id;
    if (isOwnedApprovalMirrorTarget(target)) this.#failedTargets.set(targetId, target);
    const normalized = toError(error);
    const previous = this.#targetRetries.get(targetId);
    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
    const retryDelayMs = Math.min(60_000, 5_000 * 2 ** Math.min(4, consecutiveFailures - 1));
    this.#targetRetries.set(targetId, {
      consecutiveFailures,
      retryAfterUnixMs: Date.now() + retryDelayMs,
      error: normalized,
    });
    return normalized;
  }

  async #recoverOwnedMirrorIfNeeded(target: CdpTarget, signal: AbortSignal): Promise<void> {
    const retry = this.#targetRetries.get(target.id);
    if (
      retry === undefined ||
      retry.consecutiveFailures < 2 ||
      this.#recoveredMirrorTargetIds.has(target.id) ||
      !isOwnedApprovalMirrorTarget(target) ||
      this.#options.recoverUnresponsiveOwnedMirror === undefined
    ) {
      return;
    }
    try {
      await this.#options.recoverUnresponsiveOwnedMirror(target, signal);
      this.#failedTargets.delete(target.id);
      const url = normalizeChatGptConversationUrl(target.url);
      if (url !== undefined) this.#pendingConversationTargets.add(url);
      this.#recoveredMirrorTargetIds.add(target.id);
      this.#targetRetries.delete(target.id);
      this.#reportedTargetErrors.delete(target.id);
      await this.#event({
        type: "target_recovered",
        targetId: target.id,
        conversationUrl: target.url,
      });
    } catch (error) {
      await this.#targetError(
        target,
        new Error(`ORACLE_APPROVAL_MIRROR_RECOVERY_FAILED:${toError(error).message}`),
      );
    }
  }

  #closeTargets(): void {
    for (const watched of this.#targets.values()) watched.session.close();
    this.#targets.clear();
    this.#failedTargets.clear();
    this.#reportedTargetErrors.clear();
    this.#targetRetries.clear();
    this.#recoveredMirrorTargetIds.clear();
    this.#pendingConversationTargets.clear();
    this.#conversationActivityUntil.clear();
  }

  #synchronizeReceipt(
    receipt: OracleServerApprovalScanResult["receipts"][number],
    signal: AbortSignal,
  ): void {
    const synchronize = this.#options.synchronizeApprovalReceipt;
    const state = this.#receiptSync.get(receipt.clientMessageId);
    if (
      !synchronize ||
      !state ||
      signal.aborted ||
      state.acknowledged ||
      state.flight !== undefined ||
      Date.now() < state.retryAt
    )
      return;
    // This independent flight never blocks other approvals or resubmits one.
    // Unacknowledged receipts remain in the server's durable outbox on restart.
    state.flight = Promise.resolve().then(async () => {
      try {
        const complete = await synchronize(receipt, signal);
        if (signal.aborted) return;
        if (complete) {
          this.#options.serverApprovalClient?.acknowledgeReceipts?.([receipt]);
          state.acknowledged = true;
        }
      } catch (error) {
        if (!signal.aborted)
          await this.#event({
            type: "receipt_sync_failed",
            receipt,
            conversationUrl: receipt.conversationUrl,
            error: toError(error).message,
          });
      } finally {
        state.attempts = Math.min(state.attempts + 1, 4);
        state.retryAt = Date.now() + Math.min(120_000, 15_000 * 2 ** (state.attempts - 1));
        state.flight = undefined;
      }
    });
  }

  async #event(event: OracleApprovalPopupEvent): Promise<boolean> {
    if (this.#options.onEvent === undefined) return false;
    try {
      await this.#options.onEvent(event);
      return true;
    } catch {
      return false;
    }
  }
}

function oracleServerApprovalRateLimited(message: string): boolean {
  return (
    message.startsWith("ORACLE_SERVER_APPROVAL_PARTIAL:") &&
    /too many requests|rate_limited_backoff|rate.?limit|\b429\b/iu.test(message)
  );
}

function oracleServerApprovalTransient(message: string): boolean {
  if (oracleServerApprovalRateLimited(message)) return true;
  return (
    (message.startsWith("ORACLE_SERVER_APPROVAL_EVALUATION_EXCEPTION:") ||
      message.startsWith("ORACLE_SERVER_APPROVAL_PARTIAL:")) &&
    /CDP command timeout:|failed to fetch|network(?:error| request)?|load failed|temporar(?:y|ily)|\b(?:502|503|504)\b/iu.test(
      message,
    )
  );
}

export function selectApprovalControl(
  nodes: readonly ChatGptAccessibleNode[],
): { readonly node: ChatGptAccessibleNode; readonly strength: OracleApprovalStrength } | undefined {
  const candidates = nodes
    .filter((node) => node.exactAppScope && node.role.toLocaleLowerCase() === "button")
    .map((node) => {
      const strength =
        supportedConsentControlStrength(node.name) ??
        supportedConversationPersistentStrength(node) ??
        supportedMaterializationOptionsStrength(node) ??
        supportedAffirmativeOnceStrength(node);
      return strength === undefined ? undefined : { node, strength };
    })
    .filter(
      (
        candidate,
      ): candidate is {
        readonly node: ChatGptAccessibleNode;
        readonly strength: OracleApprovalStrength;
      } => candidate !== undefined,
    )
    .sort((left, right) => consentPriority(right.strength) - consentPriority(left.strength));
  if (candidates.length === 0) return undefined;
  const strongest = candidates[0] as (typeof candidates)[number];
  if (candidates.filter((candidate) => candidate.strength === strongest.strength).length !== 1) {
    return undefined;
  }
  return strongest;
}

async function connectBoundedSession(
  transport: ChatGptLoopbackCdpTransport,
  target: CdpTarget,
  signal: AbortSignal,
  onNativeFrame?: (data: unknown) => void,
): Promise<BoundedCdpSession> {
  return BoundedCdpSession.connect(
    transport,
    {
      factory: (url) => {
        const socket = new WebSocket(url);
        if (onNativeFrame !== undefined)
          socket.addEventListener("message", ({ data }) => onNativeFrame(data));
        return socket as unknown as CdpWebSocketLike;
      },
      targetId: target.id,
      target,
      timeoutMs: ORACLE_APPROVAL_TARGET_LIVENESS_TIMEOUT_MS,
      maxFrameBytes: DEFAULT_CDP_FRAME_BUDGET_BYTES,
    },
    signal,
  );
}

function consentPriority(value: OracleApprovalStrength): number {
  switch (value) {
    case "persistent":
      return 4;
    case "full_access":
      return 5;
    case "connection":
      return 3;
    case "materialization_options":
      return 3.5;
    case "low_risk":
      return 2;
    case "affirmative_once":
      return 1;
  }
}

function supportedMaterializationOptionsStrength(
  node: ChatGptAccessibleNode,
): "materialization_options" | undefined {
  if (node.name.trim().toLocaleLowerCase() !== ORACLE_MATERIALIZATION_OPTIONS_LABEL) {
    return undefined;
  }
  const context = node.scopeText?.trim() ?? "";
  return isFileMaterializationScope(context) ? "materialization_options" : undefined;
}

function supportedConversationPersistentStrength(
  node: ChatGptAccessibleNode,
): "persistent" | undefined {
  if (node.name.trim().toLocaleLowerCase() !== ORACLE_CONVERSATION_PERSISTENT_APPROVAL_LABEL) {
    return undefined;
  }
  const context = node.scopeText?.trim() ?? "";
  return isFileMaterializationScope(context) ? "persistent" : undefined;
}

function isFileMaterializationScope(value: string): boolean {
  return (
    (value.includes("파일 생성을 허용할까요?") &&
      value.includes("OmniCodex") &&
      value.includes("파일 첨부")) ||
    (/allow file materialization\?/iu.test(value) &&
      /file attachments? returned by OmniCodex/iu.test(value))
  );
}

function supportedAffirmativeOnceStrength(
  node: ChatGptAccessibleNode,
): "affirmative_once" | undefined {
  const label = node.name.trim().toLocaleLowerCase();
  const context = node.scopeText?.trim() ?? "";
  if (!AFFIRMATIVE_ONCE_LABELS.has(label) || context.length === 0) return undefined;
  if (!APPROVAL_CONTEXT.test(context)) return undefined;
  return "affirmative_once";
}

function trimSet(values: Set<string>, maximum: number): void {
  while (values.size > maximum) {
    const oldest = values.values().next().value;
    if (typeof oldest !== "string") return;
    values.delete(oldest);
  }
}

function pruneExpiredConversationActivity(values: Map<string, number>, now: number): void {
  for (const [conversationUrl, activeUntil] of values) {
    if (activeUntil <= now) values.delete(conversationUrl);
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        rejectDelay(signal.reason);
      },
      { once: true },
    );
  });
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isOwnedApprovalMirrorTarget(target: CdpTarget): boolean {
  try {
    const url = new URL(target.url);
    return (
      normalizeChatGptConversationUrl(target.url) !== undefined &&
      url.searchParams.get("omnicodex_oracle_mirror") === ORACLE_APPROVAL_MIRROR_OWNERSHIP_MARKER
    );
  } catch {
    return false;
  }
}
