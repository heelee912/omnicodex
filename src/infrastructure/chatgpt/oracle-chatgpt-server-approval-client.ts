import { randomUUID } from "node:crypto";
import type { ChromeGoalContinuationTarget } from "../../application/chrome-goal-continuation.js";
import {
  BoundedCdpSession,
  type CdpWebSocketLike,
  ChatGptLoopbackCdpTransport,
  DEFAULT_CDP_FRAME_BUDGET_BYTES,
} from "./chatgpt-cdp-transport.js";
import { normalizeChatGptConversationUrl } from "./chatgpt-conversation-route.js";
import {
  isOracleChatGptApprovalRuntimeUrl,
  ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION,
  ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION,
  ORACLE_RATE_LIMIT_RESPONSE_HEADERS,
  type OracleExpectedApproval,
  type OracleMessageStructureObservationOptions,
  oracleChatGptApprovalRuntimeUrl,
  oracleChatGptServerApprovalScanExpression,
} from "./oracle-chatgpt-server-approval-script.js";
import {
  type OracleApprovalEventTarget,
  type OracleConversationEvents,
  type OracleConversationNotification,
  oracleConversationUrlsFromCdpEvent,
  oracleNotificationRequiresConnectorRead,
} from "./oracle-conversation-event-source.js";
import { oracleGoalContinuationExpression } from "./oracle-goal-continuation.js";
import {
  type OracleGoalConversation,
  parseOracleGoalConversation,
} from "./oracle-goal-conversation.js";

const ORACLE_SERVER_APPROVAL_COMMAND_LIVENESS_MS = 60_000;
const ORACLE_SERVER_APPROVAL_SESSION_LIVENESS_MS = 5_000;
const ORACLE_SERVER_APPROVAL_SCAN_LIVENESS_MS = 180_000;
const ORACLE_SERVER_APPROVAL_MIN_RECOVERY_SCAN_MS = 5_000;
/** One low-priority historical Goal read per verified account every two minutes. */
const ORACLE_BACKGROUND_RECOVERY_ACCOUNT_INTERVAL_MS = 120_000;

export class OracleApprovalTelemetryError extends Error {
  constructor(
    error: unknown,
    readonly telemetry: Pick<OracleServerApprovalScanResult, "requestStats" | "rateLimit">,
  ) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
  }
}

export interface OracleServerApprovalReceipt {
  readonly conversationId: string;
  readonly conversationUrl: string;
  readonly pendingMessageId: string;
  readonly userMessageId?: string;
  readonly clientMessageId: string;
  readonly targetMessageId: string;
  readonly action: "allow" | "always_allow";
  readonly rememberAnswer: boolean;
  /** Omitted when only persisted readback survived a lost submission response. */
  readonly responseStatus?: number;
}

export interface OracleMessageStructureObservation {
  readonly previousPage?: {
    readonly messageCount: number;
    readonly hasPreviousPage: boolean;
    readonly cursorAdvanced: boolean;
  };
  readonly branchStructure?: {
    readonly currentNode: string | null;
    readonly chain: readonly {
      nodeId: string;
      messageId: string | null;
      authorRole: string | null;
      parent: string | null;
      parentPresent: boolean;
    }[];
    readonly termination: "root" | "missing_node" | "cycle" | "invalid_parent";
    readonly stoppedAt: string | null;
    readonly goalNodes: readonly {
      messageId: string;
      nodeIds: readonly string[];
      onCurrentBranch: boolean;
      shapes: readonly {
        authorRole: string | null;
        authorName: string | null;
        status: string | null;
        contentKeys: readonly string[];
        textType: string;
        textLength: number;
        jsonValid: boolean;
        decodedType: string;
        nestedDecodedKeys: readonly string[];
        decodedKeys: readonly string[];
        acceptedGoal: boolean;
      }[];
    }[];
    readonly pluralParents: readonly {
      messageId: string | null;
      parentId: string | null;
      metadataParentId: string | null;
    }[];
  };
  readonly conversationId: string;
  readonly conversationKeys?: readonly string[];
  readonly pageInfo?: Readonly<Record<string, string | number | boolean | null>>;
  readonly goalConversation?: OracleGoalConversation;
  readonly currentNode?: string;
  /** Values observed on exactly current_node; not a completion verdict. */
  readonly currentMessage?: {
    readonly id: string;
    readonly authorRole?: string;
    readonly status?: string;
    readonly endTurn?: boolean | null;
    readonly channel?: string | null;
    readonly isComplete?: boolean;
    readonly workingTurnId?: string;
    readonly turnExchangeId?: string;
  };
  readonly messages: readonly {
    readonly id: string | null;
    readonly authorRole: string | null;
    readonly authorName: string | null;
    /** Exact host-recorded Goal action output; still requires a matching durable server Goal. */
    readonly goalResult?: {
      readonly toolName: string;
      readonly goalId: string;
      readonly state: "active" | "completed";
      readonly revision: number;
      readonly createdAtUnixMs: number;
    };
    readonly contentType: string | null;
    readonly referencesConnector?: boolean;
    /** Exact native Goal route for diagnosing registration selection; never a binding proof. */
    readonly invokedGoalResourceUri?: string;
    readonly topLevelKeys: readonly string[];
    readonly metadataKeys: readonly string[];
    readonly containers: readonly { readonly path: string; readonly keys: readonly string[] }[];
    readonly resourceLinks: readonly {
      readonly path: string;
      readonly keys: readonly string[];
      readonly uriType: string;
    }[];
    /** Candidates only: the server must still verify owner and stored session attribution. */
    readonly canonicalResources?: readonly { readonly path: string; readonly resourceId: string }[];
  }[];
}

export interface OracleApprovalRequestStats {
  readonly scanStartedAtUnixMs: number;
  readonly trigger: "idle" | "queued_request" | "recovery" | "observation";
  readonly getCount: number;
  readonly postCount: number;
  readonly moduleInitializationCount: number;
  readonly rateLimitCount: number;
  readonly conversationIds: readonly string[];
  readonly requests: readonly {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly operation: string;
    readonly conversationId?: string;
    readonly trigger?: "idle" | "queued_request" | "recovery" | "observation";
    readonly queueRevision?: string;
    readonly messageCount?: number;
    readonly userMessageCount?: number;
    readonly connectorReferenced?: boolean;
  }[];
}

export interface OracleServerApprovalScanResult {
  readonly goalConversations?: readonly OracleGoalConversation[];
  readonly requestStats?: OracleApprovalRequestStats;
  readonly outcome: "ok" | "partial";
  readonly examined: number;
  readonly discovered: number;
  readonly approvalsPending: number;
  /** Explicit read-only diagnostics; never an authoritative caller attestation. */
  readonly messageStructureObservation?: OracleMessageStructureObservation;
  /** A submitted approval still requires authoritative conversation readback. */
  readonly followUpScanRequired?: boolean;
  readonly nextScanAtUnixMs?: number;
  readonly rateLimit?: {
    readonly accountSourceId?: string;
    readonly status: 429;
    readonly operation: string;
    readonly retryAtUnixMs: number;
    readonly observedAtUnixMs?: number;
    readonly serverRetryAtUnixMs?: number;
    readonly localBackoffMs?: number;
    readonly statusEvidence?: "http_status" | "error_text";
    readonly backoffSource?: "server_retry_after" | "local_backoff";
    readonly responseHeaders?: Readonly<Record<string, string>>;
  };
  /** Changed conversations that used this exact connector, regardless of turn origin. */
  readonly conversationUrls: readonly string[];
  readonly receipts: readonly OracleServerApprovalReceipt[];
  readonly errors: readonly {
    readonly conversationId: string;
    readonly error: string;
    readonly status?: number;
    readonly submissionState?: "unknown" | "rejected";
    readonly operation?: string;
    readonly observedAtUnixMs?: number;
    readonly responseHeaders?: Readonly<Record<string, string>>;
  }[];
}

export interface OracleServerApprovalClient {
  /** Native frames from an already-owned exact conversation inspector. */
  observeConversationFrame?(conversationUrl: string, data: unknown): void;
  /** Queue one exact conversation. Unattributed activity never scans the account. */
  requestScan?(conversationUrl?: string): void;
  /** Call only after the consumer durably records each authoritative receipt. */
  acknowledgeReceipts?(receipts: readonly OracleServerApprovalReceipt[]): void;
  scan(signal: AbortSignal): Promise<OracleServerApprovalScanResult>;
  stop(): Promise<void>;
}

export interface OracleChatGptServerApprovalClientOptions {
  readonly onAccountSourceVerified?: (accountSourceId: string) => void;
  readonly accountCooldown?: {
    read(accountSourceId: string): Promise<
      | {
          observedAtUnixMs: number;
          retryAtUnixMs: number;
          serverRetryAtUnixMs?: number;
        }
      | undefined
    >;
    observe(
      accountSourceId: string,
      snapshot: {
        observedAtUnixMs: number;
        retryAtUnixMs: number;
        serverRetryAtUnixMs?: number;
      },
    ): Promise<void>;
    reserveBackgroundRequest?(
      accountSourceId: string,
      minimumIntervalMs: number,
    ): Promise<{ admitted: boolean; retryAtUnixMs: number }>;
    reserveRecoveryRequest?(
      accountSourceId: string,
      minimumIntervalMs: number,
    ): Promise<{ admitted: boolean; retryAtUnixMs: number }>;
    reserveForegroundRequest?(
      accountSourceId: string,
      minimumIntervalMs: number,
      signal?: AbortSignal,
    ): Promise<{ admitted: boolean; retryAtUnixMs: number }>;
    reserveGoalContinuationRequest?(
      accountSourceId: string,
      minimumIntervalMs: number,
      signal?: AbortSignal,
    ): Promise<{ admitted: boolean; retryAtUnixMs: number }>;
  };
  readonly onGoalConversations?: (observations: readonly OracleGoalConversation[]) => Promise<void>;
  /** Authoritative 404 cleanup for the exact verified account and conversation. */
  readonly onConversationDeleted?: (
    conversationUrl: string,
    accountSourceId: string,
  ) => Promise<void>;
  /** Exact previously verified active Goal conversations; never an account inventory. */
  readonly recoverGoalConversations?: (accountSourceId?: string) => Promise<readonly string[]>;
  readonly captureGoalCheckpoints?: (accountSourceId?: string) => Promise<
    readonly {
      conversationUrl: string;
      checkpoint: NonNullable<OracleGoalConversation["checkpoint"]>;
    }[]
  >;
  /** Local durable state only. A true result permits reads nominated by turn-end events. */
  readonly hasUnboundGoal?: () => Promise<boolean>;
  readonly connectorId: string;
  readonly connectorName: string;
  readonly cdpEndpoint: string;
  readonly conversationEvents?: OracleConversationEvents;
  /** Exact native turn activity, independent of connector-specific approval work. */
  readonly onConversationActivity?: (url: string, state: "active" | "idle") => void;
  readonly onConversationEvent?: (
    url: string,
    approvals: readonly OracleApprovalEventTarget[],
  ) => void;
  readonly transport?: ChatGptLoopbackCdpTransport;
  readonly connectSession?: (
    transport: ChatGptLoopbackCdpTransport,
    targetId: string,
    signal: AbortSignal,
    onTelemetry?: (data: unknown) => void,
  ) => Promise<BoundedCdpSession>;
}

/**
 * Request-attributed Oracle approval path. Exact conversations and durable
 * unconfirmed submissions share the same processing regardless of origin.
 * Opaque sessions are never expanded through account-wide enumeration.
 */
export class OracleChatGptServerApprovalClient implements OracleServerApprovalClient {
  readonly #options: OracleChatGptServerApprovalClientOptions;
  readonly #transport: ChatGptLoopbackCdpTransport;
  readonly #connectSession: NonNullable<OracleChatGptServerApprovalClientOptions["connectSession"]>;
  #session: BoundedCdpSession | undefined;
  #runtimeUsers = 0;
  #runtimeIdleWaiters = new Set<() => void>();
  #authenticationRefreshRequired = false;
  #authenticationRefreshAttempted = false;
  #authenticationRefresh: Promise<void> | undefined;
  readonly #requestTelemetry = new Map<
    string,
    Pick<OracleServerApprovalScanResult, "requestStats" | "rateLimit">
  >();
  #initializing: Promise<BoundedCdpSession> | undefined;
  #observationRevision = 0;
  readonly #goalObservationReads = new Map<
    string,
    {
      session: BoundedCdpSession;
      controller: AbortController;
      promise: Promise<OracleServerApprovalScanResult>;
      consumers: number;
    }
  >();
  #goalObservationNextScanAtUnixMs = 0;
  // One local runtime-state read restores unconfirmed submissions after restart.
  // With no pending work, the script issues no HTTP requests and goes idle.
  #scanRequested = true;
  readonly #requestedConversationIds = new Set<string>();
  readonly #recoveryConversationIds = new Set<string>();
  readonly #expectedApprovals = new Map<string, OracleExpectedApproval>();
  readonly #attemptedApprovalIds = new Set<string>();
  readonly #goalConversationUrls = new Set<string>();
  readonly #goalCandidateConversationUrls = new Set<string>();
  readonly #unboundGoalTurnEnds = new Set<string>();
  readonly #goalCompletionReceipts = new Set<string>();
  readonly #goalCompletionFinalIds = new Map<string, Set<string>>();
  readonly #nativeTurnAnchors = new Map<string, { turnId: string; messageIds: string[] }>();
  readonly #goalCompletionTurns = new Map<
    string,
    Array<{ turnId: string; messageIds: string[] }>
  >();
  readonly #goalFinalNotifications = new Map<string, Set<string>>();
  readonly #causalReadbackConversationIds = new Set<string>();
  readonly #acknowledgedReceiptIds = new Set<string>();
  #nextFollowUpScanAtUnixMs = 0;
  #nextAllowedScanAtUnixMs = 0;
  #rateLimit: OracleServerApprovalScanResult["rateLimit"];
  #transportFailures = 0;
  #accountSourceId: string | undefined;
  #notifiedAccountSourceId: string | undefined;
  #goalRecoveryPending = false;
  #goalRecoveryGeneration = 0;
  #eventFailure: { cause: unknown; observedAtUnixMs: number } | undefined;
  #nextNativeRecoveryAtUnixMs = 0;
  #nextEventRecoveryAtUnixMs = 0;
  #lastEventRecoveryUrl: string | undefined;

  get accountSourceId(): string | undefined {
    return this.#accountSourceId;
  }

  constructor(options: OracleChatGptServerApprovalClientOptions) {
    this.#options = options;
    this.#transport =
      options.transport ??
      new ChatGptLoopbackCdpTransport({
        endpoint: options.cdpEndpoint,
        timeoutMs: ORACLE_SERVER_APPROVAL_COMMAND_LIVENESS_MS,
      });
    this.#connectSession = options.connectSession ?? connectOwnedApprovalSession;
  }

  requestScan(conversationUrl?: string): void {
    this.#observationRevision += 1;
    const canonical = normalizeChatGptConversationUrl(conversationUrl);
    if (canonical === undefined) return;
    const id = new URL(canonical).pathname.slice(3);
    this.#recoveryConversationIds.delete(id);
    this.#requestedConversationIds.add(id);
    this.#scanRequested = true;
  }

  acknowledgeReceipts(receipts: readonly OracleServerApprovalReceipt[]): void {
    for (const receipt of receipts) this.#acknowledgedReceiptIds.add(receipt.clientMessageId);
    if (receipts.length > 0) this.#scanRequested = true;
  }

  observeConversationFrame(conversationUrl: string, data: unknown): void {
    const canonical = normalizeChatGptConversationUrl(conversationUrl);
    if (canonical === undefined) return;
    oracleConversationUrlsFromCdpEvent(data, (url, notification) => {
      if (url === canonical) this.#observeNotification(url, notification);
    });
  }

  #observeNotification(url: string, notification?: OracleConversationNotification): void {
    this.#observationRevision += 1;
    const payload = notification?.payload;
    const content = isRecord(payload) ? payload.update_content : undefined;
    const turnId =
      isRecord(payload) &&
      typeof payload.turn_id === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/u.test(payload.turn_id)
        ? payload.turn_id
        : undefined;
    if (
      turnId !== undefined &&
      notification?.type === "conversation-update" &&
      isRecord(content) &&
      Array.isArray(content.messages)
    ) {
      const previous = this.#nativeTurnAnchors.get(`${url}\0${turnId}`);
      const messageIds = content.messages
        .filter(
          (message) =>
            isRecord(message) &&
            typeof message.id === "string" &&
            /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/u.test(message.id),
        )
        .map((message) => String(message.id));
      this.#nativeTurnAnchors.set(`${url}\0${turnId}`, {
        turnId,
        messageIds: [
          ...new Set([...(previous?.turnId === turnId ? previous.messageIds : []), ...messageIds]),
        ],
      });
    }
    const finalIds =
      notification?.type === "conversation-update" &&
      isRecord(content) &&
      Array.isArray(content.messages) &&
      content.messages
        .filter(
          (message) =>
            isRecord(message) &&
            isRecord(message.author) &&
            message.author.role === "assistant" &&
            message.status === "finished_successfully" &&
            message.end_turn === true &&
            message.channel === "final" &&
            typeof message.id === "string",
        )
        .map((message) => String(message.id));
    const observedFinals = this.#goalFinalNotifications.get(url) ?? new Set<string>();
    const finalUpdate = finalIds !== false && finalIds.some((id) => !observedFinals.has(id));
    if (
      notification?.type === "conversation-turn-complete" ||
      notification?.type === "conversation-turn-error" ||
      finalUpdate
    )
      this.#options.onConversationActivity?.(url, "idle");
    else if (notification?.type === "conversation-update")
      this.#options.onConversationActivity?.(url, "active");
    const completedTurn =
      turnId !== undefined && (notification?.type === "conversation-turn-complete" || finalUpdate)
        ? {
            turnId,
            messageIds: [...(this.#nativeTurnAnchors.get(`${url}\0${turnId}`)?.messageIds ?? [])],
          }
        : undefined;
    const goalTurnComplete =
      (notification?.type === "conversation-turn-complete" || finalUpdate) &&
      (this.#goalConversationUrls.has(url) || this.#goalCandidateConversationUrls.has(url));
    if (
      (notification?.type === "conversation-turn-complete" || finalUpdate) &&
      !goalTurnComplete &&
      this.#options.hasUnboundGoal !== undefined
    )
      this.#unboundGoalTurnEnds.add(url);
    if (completedTurn !== undefined && (goalTurnComplete || this.#unboundGoalTurnEnds.has(url))) {
      const conversationId = new URL(url).pathname.slice(3);
      const turns = this.#goalCompletionTurns.get(conversationId) ?? [];
      const previous = turns.find((turn) => turn.turnId === completedTurn.turnId);
      if (previous)
        previous.messageIds = [...new Set([...previous.messageIds, ...completedTurn.messageIds])];
      else turns.push(completedTurn);
      this.#goalCompletionTurns.set(conversationId, turns);
      this.#nativeTurnAnchors.delete(`${url}\0${completedTurn.turnId}`);
    }
    if (notification?.type === "conversation-turn-complete" && turnId !== undefined)
      this.#nativeTurnAnchors.delete(`${url}\0${turnId}`);
    if (goalTurnComplete) {
      const conversationId = new URL(url).pathname.slice(3);
      this.#goalCompletionReceipts.add(conversationId);
      if (finalIds !== false) {
        const pending = this.#goalCompletionFinalIds.get(conversationId) ?? new Set<string>();
        for (const id of finalIds) if (!observedFinals.has(id)) pending.add(id);
        if (pending.size > 0) this.#goalCompletionFinalIds.set(conversationId, pending);
        for (const id of finalIds) observedFinals.add(id);
        this.#goalFinalNotifications.set(url, observedFinals);
      }
    }
    const approvals: OracleApprovalEventTarget[] = [];
    if (
      oracleNotificationRequiresConnectorRead(
        notification,
        this.#options.connectorId,
        this.#options.connectorName,
        (target) => {
          approvals.push(target);
          const conversationId = new URL(url).pathname.slice(3);
          this.#expectedApprovals.set(`${conversationId}:${target.pendingMessageId}`, {
            conversationId,
            ...target,
          });
        },
        // The native tool result identifies a candidate before its exact read
        // completes. Keep subsequent turn completion through that lookup race;
        // only the authoritative read below establishes an active Goal.
        () => this.#goalCandidateConversationUrls.add(url),
      ) ||
      goalTurnComplete
    ) {
      this.requestScan(url);
      this.#options.onConversationEvent?.(url, approvals);
    }
  }

  async continueGoal(
    target: ChromeGoalContinuationTarget,
    signal: AbortSignal,
  ): Promise<{
    outcome: string;
    error?: string;
    rateLimit?: OracleServerApprovalScanResult["rateLimit"];
  }> {
    return this.#withRuntime(signal, () => this.#continueGoal(target, signal));
  }

  async #continueGoal(
    target: ChromeGoalContinuationTarget,
    signal: AbortSignal,
  ): Promise<{
    outcome: string;
    error?: string;
    rateLimit?: OracleServerApprovalScanResult["rateLimit"];
  }> {
    if (
      this.#options.accountCooldown === undefined &&
      target.accountSourceId === undefined &&
      Date.now() < (this.#rateLimit?.retryAtUnixMs ?? 0)
    )
      return { outcome: "rate_limited", rateLimit: this.#rateLimit };
    // A persisted Goal binding already carries the verified ChatGPT account.
    // Queue its account slot before any CDP/account probe so a slow utility
    // renderer cannot leave the Goal invisible to the recovery scheduler while
    // ordinary completion polling repeatedly takes the same account budget.
    let reservedAccount: string | undefined;
    if (target.accountSourceId !== undefined) {
      const reservation = await this.#options.accountCooldown?.reserveGoalContinuationRequest?.(
        target.accountSourceId,
        ORACLE_BACKGROUND_RECOVERY_ACCOUNT_INTERVAL_MS,
        signal,
      );
      if (reservation !== undefined && !reservation.admitted) return { outcome: "rate_limited" };
      if (reservation !== undefined) reservedAccount = target.accountSourceId;
    }
    const session = await this.#readySession(signal);
    const account = await this.#readAccountCooldown(
      session,
      signal,
      target.accountSourceId !== undefined,
    );
    if (target.accountSourceId !== undefined && target.accountSourceId !== account)
      return { outcome: "account_source_mismatch" };
    if (Date.now() < (this.#rateLimit?.retryAtUnixMs ?? 0))
      return { outcome: "rate_limited", rateLimit: this.#rateLimit };
    if (account !== undefined && account !== reservedAccount) {
      const reservation = await this.#options.accountCooldown?.reserveGoalContinuationRequest?.(
        account,
        ORACLE_BACKGROUND_RECOVERY_ACCOUNT_INTERVAL_MS,
        signal,
      );
      if (reservation !== undefined && !reservation.admitted) return { outcome: "rate_limited" };
      if (
        reservation !== undefined &&
        (await this.#readAccountCooldown(session, signal, true)) !== account
      )
        return { outcome: "account_source_mismatch" };
    }
    this.#observationRevision += 1;
    const response = await session.command(
      "Runtime.evaluate",
      {
        expression: oracleGoalContinuationExpression(this.#options.connectorId, target),
        returnByValue: true,
        awaitPromise: true,
      },
      signal,
      ORACLE_SERVER_APPROVAL_COMMAND_LIVENESS_MS,
    );
    const result = runtimeEvaluationValue(response);
    if (!isRecord(result) || typeof result.outcome !== "string")
      throw new Error("ORACLE_GOAL_CONTINUATION_RESULT_INVALID");
    const limit = parseRateLimit(result.rateLimit);
    await this.#shareCooldown(account, limit);
    if (limit !== undefined && this.#isCurrentAccount(account)) {
      if (limit.retryAtUnixMs >= (this.#rateLimit?.retryAtUnixMs ?? 0)) this.#rateLimit = limit;
      this.#nextAllowedScanAtUnixMs = Math.max(this.#nextAllowedScanAtUnixMs, limit.retryAtUnixMs);
    }
    return {
      outcome: result.outcome,
      ...(typeof result.error === "string" ? { error: result.error } : {}),
      ...(limit === undefined ? {} : { rateLimit: limit }),
    };
  }

  /** Read one event-nominated Goal conversation without running the approval writer. */
  async observeGoalConversation(
    conversationUrl: string,
    signal: AbortSignal,
    options: { readonly publishObservation?: boolean } = {},
  ): Promise<OracleServerApprovalScanResult> {
    return this.#withRuntime(signal, () =>
      this.#observeGoalConversation(conversationUrl, signal, options),
    );
  }

  async #observeGoalConversation(
    conversationUrl: string,
    signal: AbortSignal,
    options: { readonly publishObservation?: boolean } = {},
  ): Promise<OracleServerApprovalScanResult> {
    const canonical = normalizeChatGptConversationUrl(conversationUrl);
    if (canonical === undefined) throw new Error("CHATGPT_CONVERSATION_ID_INVALID");
    if (Date.now() < this.#goalObservationNextScanAtUnixMs) {
      return {
        ...idleScanResult(),
        nextScanAtUnixMs: this.#goalObservationNextScanAtUnixMs,
        ...(this.#rateLimit === undefined ? {} : { rateLimit: this.#rateLimit }),
      };
    }
    // Explicit state reads honor request cooldowns, not a background sink's
    // causal-proof retry schedule stored in nextAllowedScanAtUnixMs.
    if (
      this.#options.accountCooldown === undefined &&
      Date.now() < (this.#rateLimit?.retryAtUnixMs ?? 0)
    ) {
      return {
        ...idleScanResult(),
        nextScanAtUnixMs: this.#rateLimit?.retryAtUnixMs ?? 0,
        ...(this.#rateLimit === undefined ? {} : { rateLimit: this.#rateLimit }),
      };
    }
    const session = await this.#readySession(signal);
    const account = await this.#readAccountCooldown(session, signal);
    if (Date.now() < (this.#rateLimit?.retryAtUnixMs ?? 0)) {
      return {
        ...idleScanResult(),
        nextScanAtUnixMs: this.#rateLimit?.retryAtUnixMs ?? 0,
        ...(this.#rateLimit === undefined ? {} : { rateLimit: this.#rateLimit }),
      };
    }
    // Share only overlapping exact reads with a verified principal. This is
    // not a terminal-state cache: every completed read is removed immediately.
    if (account === undefined)
      return this.#readGoalConversation(
        canonical,
        session,
        account,
        signal,
        options.publishObservation !== false,
      );
    const key = JSON.stringify([
      account,
      canonical,
      this.#observationRevision,
      this.#goalRecoveryGeneration,
      options.publishObservation !== false,
    ]);
    let read = this.#goalObservationReads.get(key);
    if (read?.session !== session || read.controller.signal.aborted) read = undefined;
    if (read === undefined) {
      const controller = new AbortController();
      const promise = (async () => {
        const publishObservation = options.publishObservation !== false;
        const reserve = publishObservation
          ? (this.#options.accountCooldown?.reserveForegroundRequest ??
            this.#options.accountCooldown?.reserveRecoveryRequest)
          : this.#options.accountCooldown?.reserveRecoveryRequest;
        const reservation = await reserve?.(
          account,
          ORACLE_BACKGROUND_RECOVERY_ACCOUNT_INTERVAL_MS,
          controller.signal,
        );
        if (reservation !== undefined && !reservation.admitted) {
          this.#goalObservationNextScanAtUnixMs = Math.max(
            this.#goalObservationNextScanAtUnixMs,
            reservation.retryAtUnixMs,
          );
          return {
            ...idleScanResult(),
            followUpScanRequired: true,
            nextScanAtUnixMs: reservation.retryAtUnixMs,
          };
        }
        if (
          reservation !== undefined &&
          (await this.#readAccountCooldown(session, controller.signal, true)) !== account
        )
          throw new Error("ORACLE_CHATGPT_ACCOUNT_SOURCE_CHANGED");
        return this.#readGoalConversation(
          canonical,
          session,
          account,
          controller.signal,
          publishObservation,
        );
      })();
      read = { session, controller, promise, consumers: 0 };
      this.#goalObservationReads.set(key, read);
      const registered = read;
      void promise
        .finally(() => {
          if (this.#goalObservationReads.get(key) === registered)
            this.#goalObservationReads.delete(key);
        })
        .catch(() => undefined);
    }
    read.consumers += 1;
    const shared = read;
    try {
      return structuredClone(await waitForGoalObservation(shared.promise, signal));
    } finally {
      shared.consumers -= 1;
      if (shared.consumers === 0) shared.controller.abort();
    }
  }

  async #readGoalConversation(
    canonical: string,
    session: BoundedCdpSession,
    account: string | undefined,
    signal: AbortSignal,
    publishObservation: boolean,
  ): Promise<OracleServerApprovalScanResult> {
    const response = await session.command(
      "Runtime.evaluate",
      {
        expression: oracleChatGptServerApprovalScanExpression(
          this.#options.connectorId,
          this.#options.connectorName,
          [new URL(canonical).pathname.slice(3)],
          [],
          { observeGoalsOnly: true },
        ),
        returnByValue: true,
        awaitPromise: true,
      },
      signal,
      ORACLE_SERVER_APPROVAL_SCAN_LIVENESS_MS,
    );
    const result = await this.#attributeGoalObservations(
      approvalScanResult(response),
      account,
      session,
      signal,
    );
    this.#goalObservationNextScanAtUnixMs = result.nextScanAtUnixMs ?? 0;
    await this.#shareCooldown(account, result.rateLimit);
    this.#rememberAccountCooldown(account, result);
    await this.#syncDeletedConversations(result, account);
    if (
      publishObservation &&
      result.goalConversations?.some((observation) => observation.goals.length > 0)
    ) {
      // Exact activity reads can be the first observation of a persisted Goal.
      // Feed their verified result to the same durable consumer as event scans.
      try {
        await this.#options.onGoalConversations?.(result.goalConversations);
        for (const observation of result.goalConversations)
          if (observation.goals.some((goal) => goal.state === "active"))
            this.#goalConversationUrls.add(observation.conversationUrl);
      } catch (error) {
        for (const observation of result.goalConversations)
          this.requestScan(observation.conversationUrl);
        throw error;
      }
    }
    return result;
  }

  /** Observe once through an already attached runtime. Never creates or initializes a page. */
  async observeMessageStructure(
    conversationUrl: string,
    signal: AbortSignal,
    options?: Omit<OracleMessageStructureObservationOptions, "observeMessageStructure">,
  ): Promise<OracleServerApprovalScanResult> {
    return this.#withRuntime(signal, () =>
      this.#observeMessageStructure(conversationUrl, signal, options),
    );
  }

  async #observeMessageStructure(
    conversationUrl: string,
    signal: AbortSignal,
    options?: Omit<OracleMessageStructureObservationOptions, "observeMessageStructure">,
  ): Promise<OracleServerApprovalScanResult> {
    const canonical = normalizeChatGptConversationUrl(conversationUrl);
    if (canonical === undefined) throw new Error("CHATGPT_CONVERSATION_ID_INVALID");
    const session = this.#session;
    if (session === undefined) throw new Error("ORACLE_OBSERVATION_RUNTIME_NOT_ATTACHED");
    const account = await this.#readAccountCooldown(session, signal);
    if (Date.now() < (this.#rateLimit?.retryAtUnixMs ?? 0)) {
      return {
        ...idleScanResult(),
        nextScanAtUnixMs: this.#nextAllowedScanAtUnixMs,
        ...(this.#rateLimit === undefined ? {} : { rateLimit: this.#rateLimit }),
      };
    }
    if (account !== undefined) {
      const reserve =
        this.#options.accountCooldown?.reserveForegroundRequest ??
        this.#options.accountCooldown?.reserveRecoveryRequest;
      const reservation = await reserve?.(
        account,
        ORACLE_BACKGROUND_RECOVERY_ACCOUNT_INTERVAL_MS,
        signal,
      );
      if (reservation !== undefined && !reservation.admitted)
        return {
          ...idleScanResult(),
          followUpScanRequired: true,
          nextScanAtUnixMs: reservation.retryAtUnixMs,
        };
      if (
        reservation !== undefined &&
        (await this.#readAccountCooldown(session, signal, true)) !== account
      )
        throw new Error("ORACLE_CHATGPT_ACCOUNT_SOURCE_CHANGED");
    }
    const response = await session.command(
      "Runtime.evaluate",
      {
        expression: oracleChatGptServerApprovalScanExpression(
          this.#options.connectorId,
          this.#options.connectorName,
          [new URL(canonical).pathname.slice(3)],
          [],
          { ...options, observeMessageStructure: true },
        ),
        returnByValue: true,
        awaitPromise: true,
      },
      signal,
      ORACLE_SERVER_APPROVAL_SCAN_LIVENESS_MS,
    );
    const result = approvalScanResult(response);
    await this.#shareCooldown(account, result.rateLimit);
    this.#rememberAccountCooldown(account, result);
    await this.#syncDeletedConversations(result, account);
    return result;
  }

  async scan(signal: AbortSignal): Promise<OracleServerApprovalScanResult> {
    return this.#withRuntime(signal, () => this.#scan(signal));
  }

  async #scan(signal: AbortSignal): Promise<OracleServerApprovalScanResult> {
    let eventFailure: { cause: unknown; observedAtUnixMs: number } | undefined;
    let goalRecoveryAttempted = false;
    let recoveredActiveGoalConversationIds: string[] | undefined;
    try {
      const connected = await this.#options.conversationEvents?.ensureConnected(
        (url, notification) => this.#observeNotification(url, notification),
        signal,
        () => this.#admitNativeEventRecovery(signal),
      );
      if (connected === true) {
        this.#goalRecoveryPending = true;
        this.#goalRecoveryGeneration += 1;
      }
      if (this.#goalRecoveryPending) {
        goalRecoveryAttempted = true;
        const account =
          this.#options.accountCooldown === undefined
            ? undefined
            : await this.#readAccountCooldown(await this.#readySession(signal), signal);
        const generation = this.#goalRecoveryGeneration;
        const urls = (await this.#options.recoverGoalConversations?.(account)) ?? [];
        if (
          account !== undefined &&
          (await this.#readAccountCooldown(await this.#readySession(signal), signal)) !== account
        )
          throw new Error("ORACLE_CHATGPT_ACCOUNT_SOURCE_CHANGED");
        // A newer reconnect/account change still needs its own exact recovery.
        // Do not acknowledge it with the result of an older asynchronous read.
        if (generation !== this.#goalRecoveryGeneration)
          throw new Error("ORACLE_GOAL_RECOVERY_SUPERSEDED");
        this.#goalConversationUrls.clear();
        for (const url of urls) {
          this.#goalConversationUrls.add(url);
        }
        recoveredActiveGoalConversationIds = [
          ...new Set(urls.map((url) => new URL(url).pathname.slice(3))),
        ];
        // Reconnection restores only the local subscription allowlist. Reading
        // every active Goal transcript here turned each socket reconnect into
        // a historical conversation crawl, including large Pro conversations.
        // Exact approval notifications and Goal-final events nominate the one
        // conversation that needs server readback through the normal paths.
        this.#goalRecoveryPending = false;
      }
      this.#eventFailure = undefined;
    } catch (error) {
      signal.throwIfAborted();
      // The event source rethrows the same failure while waiting to reconnect.
      // Preserve that observation instead of reporting each local scan as a
      // fresh network failure. A new attempt or a recovered stream resets it.
      if (this.#eventFailure === undefined || this.#eventFailure.cause !== error) {
        this.#eventFailure = { cause: error, observedAtUnixMs: Date.now() };
      }
      eventFailure = this.#eventFailure;
    }
    let result: OracleServerApprovalScanResult;
    try {
      result = await this.#scanPending(
        signal,
        recoveredActiveGoalConversationIds,
        goalRecoveryAttempted,
      );
      if (
        eventFailure !== undefined &&
        result.examined === 0 &&
        (result.requestStats?.getCount ?? 0) === 0 &&
        result.receipts.length === 0 &&
        !this.#scanRequested &&
        !result.followUpScanRequired
      )
        result = (await this.#recoverKnownGoalAfterEventFailure(signal)) ?? result;
    } catch (error) {
      if (signal.aborted) {
        if (error instanceof OracleApprovalTelemetryError) throw error;
        signal.throwIfAborted();
      }
      // Retain exact pending requests and the owned renderer, but do not let
      // the watcher's hot cadence repeatedly initialize/reconnect a failed
      // session. A successful scan resets this transport-only backoff.
      this.#transportFailures += 1;
      this.#nextAllowedScanAtUnixMs = Math.max(
        this.#nextAllowedScanAtUnixMs,
        Date.now() + Math.min(60_000, 5_000 * 2 ** Math.min(this.#transportFailures - 1, 4)),
      );
      // This failure belongs to the approval inspector, not the shared SSH
      // tunnel. Preserve its original cause while keeping daemon recovery
      // from destroying the owned renderer and resetting this cooldown.
      const failure = new Error(
        `ORACLE_SERVER_APPROVAL_SESSION_FAILED:${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
      if (error instanceof OracleApprovalTelemetryError)
        throw new OracleApprovalTelemetryError(failure, error.telemetry);
      throw failure;
    }
    if (eventFailure === undefined) return result;
    // Discovery failure must be visible without blocking explicitly attributed
    // approvals or durable receipt recovery that can still make progress.
    return {
      ...result,
      outcome: "partial",
      errors: [
        ...result.errors,
        {
          conversationId: "account",
          operation: "conversation_event_stream",
          error:
            eventFailure.cause instanceof Error
              ? eventFailure.cause.message
              : String(eventFailure.cause),
          observedAtUnixMs: eventFailure.observedAtUnixMs,
        },
      ],
    };
  }

  async #admitNativeEventRecovery(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const shared = this.#options.accountCooldown;
    if (
      shared?.reserveBackgroundRequest === undefined ||
      Date.now() < this.#nextNativeRecoveryAtUnixMs
    )
      return false;
    // Claim the local probe before awaiting authentication or account storage.
    this.#nextNativeRecoveryAtUnixMs = Date.now() + ORACLE_BACKGROUND_RECOVERY_ACCOUNT_INTERVAL_MS;
    const session = await this.#readySession(signal);
    const account = await this.#readAccountCooldown(session, signal, true);
    signal.throwIfAborted();
    if (account === undefined || Date.now() < (this.#rateLimit?.retryAtUnixMs ?? 0)) return false;
    const reservation = await shared.reserveBackgroundRequest(
      account,
      ORACLE_BACKGROUND_RECOVERY_ACCOUNT_INTERVAL_MS,
    );
    this.#nextNativeRecoveryAtUnixMs = Math.max(
      this.#nextNativeRecoveryAtUnixMs,
      reservation.retryAtUnixMs,
    );
    signal.throwIfAborted();
    if (!reservation.admitted) return false;
    const current = await this.#readAccountCooldown(session, signal, true);
    signal.throwIfAborted();
    return current === account && Date.now() >= (this.#rateLimit?.retryAtUnixMs ?? 0);
  }

  async #recoverKnownGoalAfterEventFailure(
    signal: AbortSignal,
  ): Promise<OracleServerApprovalScanResult | undefined> {
    const shared = this.#options.accountCooldown;
    if (
      shared?.reserveBackgroundRequest === undefined ||
      this.#options.recoverGoalConversations === undefined ||
      this.#options.captureGoalCheckpoints === undefined ||
      Date.now() < Math.max(this.#nextEventRecoveryAtUnixMs, this.#nextAllowedScanAtUnixMs)
    )
      return undefined;
    // A missing event cannot nominate a conversation. Use only the existing
    // account-bound active Goal checkpoint, with one shared background slot.
    // This deadline also prevents hot local probes while a read is in flight.
    this.#nextEventRecoveryAtUnixMs = Date.now() + ORACLE_BACKGROUND_RECOVERY_ACCOUNT_INTERVAL_MS;
    const session = await this.#readySession(signal);
    const account = await this.#readAccountCooldown(session, signal, true);
    if (account === undefined || Date.now() < (this.#rateLimit?.retryAtUnixMs ?? 0))
      return undefined;
    const checkpoints = new Map(
      (await this.#options.captureGoalCheckpoints(account)).map((entry) => [
        entry.conversationUrl,
        entry.checkpoint,
      ]),
    );
    const urls = [...new Set(await this.#options.recoverGoalConversations(account))]
      .filter((url) => normalizeChatGptConversationUrl(url) === url && checkpoints.has(url))
      .sort();
    const url = urls.find((candidate) => candidate > (this.#lastEventRecoveryUrl ?? "")) ?? urls[0];
    if (url === undefined) return undefined;
    const checkpoint = checkpoints.get(url);
    if (checkpoint === undefined) return undefined;
    const reservation = await shared.reserveBackgroundRequest(
      account,
      ORACLE_BACKGROUND_RECOVERY_ACCOUNT_INTERVAL_MS,
    );
    this.#nextEventRecoveryAtUnixMs = Math.max(
      this.#nextEventRecoveryAtUnixMs,
      reservation.retryAtUnixMs,
    );
    if (!reservation.admitted) return undefined;
    if ((await this.#readAccountCooldown(session, signal, true)) !== account)
      throw new Error("ORACLE_CHATGPT_ACCOUNT_SOURCE_CHANGED");
    this.#lastEventRecoveryUrl = url;
    const result = await this.#readGoalConversation(url, session, account, signal, false);
    const observations = result.goalConversations
      ?.filter((observation) => observation.conversationUrl === url)
      .map((observation) => ({ ...observation, checkpoint }));
    if (observations === undefined) return result;
    // Completion remains the existing consumer's causal decision. An active,
    // incomplete or absent current message is never promoted to a final here.
    await this.#options.onGoalConversations?.(observations);
    return { ...result, goalConversations: observations };
  }

  async #scanPending(
    signal: AbortSignal,
    recoveredActiveGoalConversationIds?: readonly string[],
    goalRecoveryAttempted = false,
  ): Promise<OracleServerApprovalScanResult> {
    const now = Date.now();
    // No account or renderer polling while there is no exact pending work.
    const hasWork =
      this.#scanRequested ||
      this.#unboundGoalTurnEnds.size > 0 ||
      (this.#nextFollowUpScanAtUnixMs > 0 && this.#nextFollowUpScanAtUnixMs <= now);
    const account =
      hasWork &&
      this.#options.accountCooldown !== undefined &&
      (this.#transportFailures === 0 || now >= this.#nextAllowedScanAtUnixMs)
        ? await this.#readAccountCooldown(await this.#readySession(signal), signal)
        : undefined;
    const freshApprovalAttempt =
      [...this.#expectedApprovals.keys()].some((key) => !this.#attemptedApprovalIds.has(key)) &&
      this.#rateLimit?.backoffSource === "local_backoff" &&
      !(Number(this.#rateLimit.serverRetryAtUnixMs) > now);
    if (now < this.#nextAllowedScanAtUnixMs && !freshApprovalAttempt) {
      return {
        ...idleScanResult(),
        nextScanAtUnixMs: this.#nextAllowedScanAtUnixMs,
        ...(this.#rateLimit === undefined ? {} : { rateLimit: this.#rateLimit }),
      };
    }
    if (this.#unboundGoalTurnEnds.size > 0) {
      const completedUrls = [...this.#unboundGoalTurnEnds];
      const unbound = await this.#options.hasUnboundGoal?.();
      for (const url of completedUrls) {
        this.#unboundGoalTurnEnds.delete(url);
        if (unbound !== true) {
          this.#goalCompletionTurns.delete(new URL(url).pathname.slice(3));
          continue;
        }
        // This is the exact native event's conversation, never an account
        // search. The Goal-only read cannot submit an approval and the store
        // binds only a matching durable Goal id, creation time and revision.
        this.#goalCompletionReceipts.add(new URL(url).pathname.slice(3));
        this.requestScan(url);
        this.#options.onConversationEvent?.(url, []);
      }
    }
    const followUpDue = this.#nextFollowUpScanAtUnixMs > 0 && this.#nextFollowUpScanAtUnixMs <= now;
    if (!this.#scanRequested && !followUpDue) return idleScanResult();
    this.#nextFollowUpScanAtUnixMs = 0;
    const session = await this.#readySession(signal);
    // Consume the request before dispatch. A wake that races this command sets
    // the flag again and is therefore preserved for the following scan.
    const causalId = this.#causalReadbackConversationIds.values().next().value;
    let activeGoalConversationIds =
      recoveredActiveGoalConversationIds === undefined
        ? undefined
        : [...recoveredActiveGoalConversationIds];
    if (
      causalId === undefined &&
      !goalRecoveryAttempted &&
      this.#options.recoverGoalConversations !== undefined
    ) {
      const activeGoalConversationUrls = await this.#options.recoverGoalConversations(account);
      this.#goalConversationUrls.clear();
      for (const url of activeGoalConversationUrls) this.#goalConversationUrls.add(url);
      activeGoalConversationIds = [
        ...new Set(activeGoalConversationUrls.map((url) => new URL(url).pathname.slice(3))),
      ];
    }
    const checkpoints = new Map(
      ((await this.#options.captureGoalCheckpoints?.(account)) ?? []).map((entry) => [
        entry.conversationUrl,
        entry.checkpoint,
      ]),
    );
    const conversationIds =
      causalId === undefined ? [...this.#requestedConversationIds] : [causalId];
    const expectedApprovals = causalId === undefined ? [...this.#expectedApprovals.values()] : [];
    const recoveryConversationIds =
      causalId === undefined
        ? conversationIds.filter((id) => this.#recoveryConversationIds.has(id))
        : [];
    const goalCompletionReceipts = causalId === undefined ? [...this.#goalCompletionReceipts] : [];
    const goalCompletionFinalIds = Object.fromEntries(
      goalCompletionReceipts.flatMap((id) => {
        const finals = this.#goalCompletionFinalIds.get(id);
        return finals?.size ? [[id, [...finals]]] : [];
      }),
    );
    const goalCompletionTurns = Object.fromEntries(
      goalCompletionReceipts.flatMap((id) => {
        const turns = this.#goalCompletionTurns.get(id);
        return turns === undefined ? [] : [[id, turns]];
      }),
    );
    const acknowledgedReceiptIds = causalId === undefined ? [...this.#acknowledgedReceiptIds] : [];
    const backgroundRecoveryOnly =
      causalId === undefined &&
      recoveryConversationIds.length > 0 &&
      expectedApprovals.length === 0 &&
      goalCompletionReceipts.length === 0;
    if (account !== undefined) {
      const reserve = backgroundRecoveryOnly
        ? this.#options.accountCooldown?.reserveBackgroundRequest
        : (this.#options.accountCooldown?.reserveForegroundRequest ??
          this.#options.accountCooldown?.reserveRecoveryRequest);
      const reservation = await reserve?.(
        account,
        ORACLE_BACKGROUND_RECOVERY_ACCOUNT_INTERVAL_MS,
        signal,
      );
      if (reservation === undefined) {
        // Older embedders without a reservation boundary retain their exact
        // existing request behavior.
      } else if (!reservation.admitted) {
        this.#nextFollowUpScanAtUnixMs = Math.max(
          this.#nextFollowUpScanAtUnixMs,
          reservation.retryAtUnixMs,
        );
        return {
          ...idleScanResult(),
          followUpScanRequired: true,
          nextScanAtUnixMs: reservation.retryAtUnixMs,
        };
      } else if ((await this.#readAccountCooldown(session, signal, true)) !== account) {
        // Admission can wait through a login change. The old account's slot
        // cannot authorize a request from the newly signed-in account.
        throw new Error("ORACLE_CHATGPT_ACCOUNT_SOURCE_CHANGED");
      }
    }
    for (const id of conversationIds) {
      this.#requestedConversationIds.delete(id);
      this.#recoveryConversationIds.delete(id);
    }
    if (causalId === undefined) {
      this.#expectedApprovals.clear();
      this.#goalCompletionReceipts.clear();
      this.#goalCompletionFinalIds.clear();
      this.#goalCompletionTurns.clear();
      this.#acknowledgedReceiptIds.clear();
    }
    this.#scanRequested = false;
    const telemetryId = randomUUID();
    this.#requestTelemetry.set(telemetryId, {});
    let runtimeReadbackSucceeded = false;
    try {
      // A writer may advance the conversation while an observer is in flight.
      this.#observationRevision += 1;
      // Restoring pending work after a failed call must not restore its one-time
      // right to bypass local pacing. A different native approval remains fresh.
      for (const target of expectedApprovals)
        this.#attemptedApprovalIds.add(`${target.conversationId}:${target.pendingMessageId}`);
      const response = await session.command(
        "Runtime.evaluate",
        {
          expression: oracleChatGptServerApprovalScanExpression(
            this.#options.connectorId,
            this.#options.connectorName,
            conversationIds,
            acknowledgedReceiptIds,
            {
              telemetryId,
              ...(causalId !== undefined
                ? { observeGoalsOnly: true }
                : {
                    ...(activeGoalConversationIds === undefined
                      ? {}
                      : { activeGoalConversationIds }),
                    ...(expectedApprovals.length === 0 ? {} : { expectedApprovals }),
                    ...(recoveryConversationIds.length === 0 ? {} : { recoveryConversationIds }),
                    ...(goalCompletionReceipts.length === 0 ? {} : { goalCompletionReceipts }),
                    ...(Object.keys(goalCompletionFinalIds).length === 0
                      ? {}
                      : { goalCompletionFinalIds }),
                    ...(Object.keys(goalCompletionTurns).length === 0
                      ? {}
                      : { goalCompletionTurns }),
                  }),
            },
          ),
          returnByValue: true,
          awaitPromise: true,
        },
        signal,
        ORACLE_SERVER_APPROVAL_SCAN_LIVENESS_MS,
      );
      let result = await this.#attributeGoalObservations(
        approvalScanResult(response),
        account,
        session,
        signal,
      );
      runtimeReadbackSucceeded = true;
      await this.#shareCooldown(account, result.rateLimit);
      if (result.goalConversations !== undefined)
        result = {
          ...result,
          goalConversations: result.goalConversations.map((observation) => {
            const checkpoint = checkpoints.get(observation.conversationUrl);
            return checkpoint === undefined ? observation : { ...observation, checkpoint };
          }),
        };
      this.#transportFailures = 0;
      this.#rememberAccountCooldown(account, result);
      await this.#syncDeletedConversations(result, account);
      if (result.goalConversations !== undefined) {
        for (const observation of result.goalConversations) {
          this.#goalCandidateConversationUrls.delete(observation.conversationUrl);
          const latest = new Map<string, OracleGoalConversation["goals"][number]>();
          for (const goal of observation.goals)
            if ((latest.get(goal.goalId)?.revision ?? -1) < goal.revision)
              latest.set(goal.goalId, goal);
          if (
            [...latest.values()].some((goal) => goal.state === "active") ||
            (latest.size === 0 && observation.checkpoint !== undefined)
          )
            this.#goalConversationUrls.add(observation.conversationUrl);
          else {
            this.#goalConversationUrls.delete(observation.conversationUrl);
            this.#goalFinalNotifications.delete(observation.conversationUrl);
          }
        }
        try {
          await this.#options.onGoalConversations?.(result.goalConversations);
          if (
            causalId !== undefined &&
            result.goalConversations.some(
              (o) => new URL(o.conversationUrl).pathname.slice(3) === causalId,
            )
          )
            this.#causalReadbackConversationIds.delete(causalId);
        } catch (error) {
          const unresolved = (failure: unknown): boolean =>
            failure instanceof AggregateError
              ? failure.errors.length > 0 && failure.errors.every(unresolved)
              : failure instanceof Error &&
                failure.message === "DIRECT_GOAL_CAUSAL_READBACK_REQUIRED";
          if (!unresolved(error)) throw error;
          // The socket succeeded. A missing causal proof is pending data, not
          // a disconnected transport. Re-read only these durable Goal URLs.
          for (const observation of result.goalConversations) {
            const id = new URL(observation.conversationUrl).pathname.slice(3);
            // Retry this exact pending observation, but a persistently missing
            // edge in one conversation must not starve the next causal read.
            this.#causalReadbackConversationIds.delete(id);
            this.#causalReadbackConversationIds.add(id);
            this.#requestedConversationIds.add(id);
          }
          result = {
            ...result,
            outcome: "partial",
            followUpScanRequired: true,
            nextScanAtUnixMs: Math.max(result.nextScanAtUnixMs ?? 0, Date.now() + 120_000),
            errors: [
              ...result.errors,
              ...result.goalConversations.map((observation) => ({
                conversationId: new URL(observation.conversationUrl).pathname.slice(3),
                operation: "goal_causal_readback",
                error: "DIRECT_GOAL_CAUSAL_READBACK_REQUIRED",
              })),
            ],
          };
          this.#nextAllowedScanAtUnixMs = result.nextScanAtUnixMs ?? 0;
        }
      }
      if (this.#causalReadbackConversationIds.size > 0)
        result = {
          ...result,
          followUpScanRequired: true,
          nextScanAtUnixMs: Math.max(result.nextScanAtUnixMs ?? 0, Date.now() + 120_000),
        };
      if (
        this.#requestedConversationIds.size > 0 ||
        this.#expectedApprovals.size > 0 ||
        this.#goalCompletionReceipts.size > 0 ||
        this.#acknowledgedReceiptIds.size > 0
      )
        this.#scanRequested = true;
      // An unacknowledged receipt remains work even if the approval itself is
      // already complete. A failed consumer sink must get another delivery.
      if (result.followUpScanRequired === true || result.receipts.length > 0) {
        this.#nextFollowUpScanAtUnixMs = Math.max(
          Date.now() + ORACLE_SERVER_APPROVAL_MIN_RECOVERY_SCAN_MS,
          result.nextScanAtUnixMs ?? 0,
        );
      }
      return result;
    } catch (error) {
      for (const id of recoveryConversationIds)
        if (!this.#requestedConversationIds.has(id)) this.#recoveryConversationIds.add(id);
      for (const id of conversationIds) this.#requestedConversationIds.add(id);
      for (const id of goalCompletionReceipts) this.#goalCompletionReceipts.add(id);
      for (const [id, turns] of Object.entries(goalCompletionTurns)) {
        const pending = this.#goalCompletionTurns.get(id) ?? [];
        for (const turn of turns) {
          const existing = pending.find((item) => item.turnId === turn.turnId);
          if (existing)
            existing.messageIds = [...new Set([...existing.messageIds, ...turn.messageIds])];
          else pending.push(turn);
        }
        this.#goalCompletionTurns.set(id, pending);
      }
      for (const [id, finals] of Object.entries(goalCompletionFinalIds)) {
        const pending = this.#goalCompletionFinalIds.get(id) ?? new Set<string>();
        for (const final of finals) pending.add(final);
        this.#goalCompletionFinalIds.set(id, pending);
      }
      for (const target of expectedApprovals) {
        const key = `${target.conversationId}:${target.pendingMessageId}`;
        if (!this.#expectedApprovals.has(key)) this.#expectedApprovals.set(key, target);
      }
      for (const id of acknowledgedReceiptIds) this.#acknowledgedReceiptIds.add(id);
      this.#scanRequested = true;
      // Local persistence/observation failures do not invalidate the shared
      // transport or justify interrupting a concurrently running Goal send.
      if (!runtimeReadbackSucceeded && session.isClosed && this.#session === session)
        this.#detachSession();
      const telemetry = this.#requestTelemetry.get(telemetryId);
      if (telemetry?.requestStats !== undefined)
        throw new OracleApprovalTelemetryError(error, telemetry);
      throw error;
    } finally {
      this.#requestTelemetry.delete(telemetryId);
    }
  }

  async #syncDeletedConversations(
    result: OracleServerApprovalScanResult,
    accountSourceId: string | undefined,
  ): Promise<void> {
    if (accountSourceId === undefined || this.#options.onConversationDeleted === undefined) return;
    const ids = [
      ...new Set(
        result.errors.flatMap((failure) =>
          failure.status === 404 &&
          failure.operation === "conversation_read" &&
          /conversation has been deleted/iu.test(failure.error)
            ? [failure.conversationId]
            : [],
        ),
      ),
    ];
    for (const id of ids) {
      const conversationUrl = normalizeChatGptConversationUrl(`https://chatgpt.com/c/${id}`);
      if (conversationUrl === undefined) continue;
      try {
        await this.#options.onConversationDeleted(conversationUrl, accountSourceId);
      } catch (error) {
        this.requestScan(conversationUrl);
        throw error;
      }
      this.#requestedConversationIds.delete(id);
      this.#recoveryConversationIds.delete(id);
      this.#goalCompletionReceipts.delete(id);
      this.#goalCompletionFinalIds.delete(id);
      this.#goalCompletionTurns.delete(id);
      this.#causalReadbackConversationIds.delete(id);
      this.#goalConversationUrls.delete(conversationUrl);
      this.#goalCandidateConversationUrls.delete(conversationUrl);
      this.#unboundGoalTurnEnds.delete(conversationUrl);
      this.#goalFinalNotifications.delete(conversationUrl);
      for (const key of this.#nativeTurnAnchors.keys())
        if (key.startsWith(`${conversationUrl}\0`)) this.#nativeTurnAnchors.delete(key);
    }
  }

  async stop(): Promise<void> {
    for (const read of this.#goalObservationReads.values()) read.controller.abort();
    this.#goalObservationReads.clear();
    await this.#options.conversationEvents?.stop();
    await this.#authenticationRefresh?.catch(() => undefined);
    await this.#initializing?.catch(() => undefined);
    // The exact connector-bound runtime is a persistent Oracle service page,
    // not a per-daemon scratch tab. Detach this client while leaving the page
    // for the next daemon to adopt with its loaded request contract intact.
    this.#detachSession();
  }

  async #readySession(signal: AbortSignal): Promise<BoundedCdpSession> {
    // A disconnected socket cannot serve another operation. Re-adopt the
    // existing runtime page; do not replay the operation that lost its reply.
    if (this.#session?.isClosed) this.#session = undefined;
    if (this.#session !== undefined) return this.#session;
    if (this.#initializing !== undefined) return this.#initializing;
    const initializing = this.#initialize(signal).finally(() => {
      if (this.#initializing === initializing) this.#initializing = undefined;
    });
    this.#initializing = initializing;
    return initializing;
  }

  async #withRuntime<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    // A 401 invalidates the adopted utility renderer's cached authentication.
    // Drain its readers/writer before navigating only that owned renderer.
    // Existing receipts remain durable; no rejected operation is replayed here.
    while (this.#authenticationRefreshRequired || this.#authenticationRefresh !== undefined) {
      signal.throwIfAborted();
      if (this.#runtimeUsers > 0) {
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            signal.removeEventListener("abort", aborted);
            this.#runtimeIdleWaiters.delete(done);
            resolve();
          };
          const aborted = () => {
            this.#runtimeIdleWaiters.delete(done);
            reject(signal.reason);
          };
          this.#runtimeIdleWaiters.add(done);
          signal.addEventListener("abort", aborted, { once: true });
        });
        continue;
      }
      if (this.#authenticationRefresh === undefined) {
        this.#authenticationRefreshRequired = false;
        this.#authenticationRefreshAttempted = true;
        const previousAccount = this.#accountSourceId;
        this.#detachSession();
        const refresh = this.#initialize(signal, true)
          .then(async (session) => {
            if (
              previousAccount !== undefined &&
              (await this.#readAccountCooldown(session, signal, true)) !== previousAccount
            )
              throw new Error("ORACLE_CHATGPT_ACCOUNT_SOURCE_CHANGED");
          })
          .finally(() => {
            if (this.#authenticationRefresh === refresh) this.#authenticationRefresh = undefined;
          });
        this.#authenticationRefresh = refresh;
      }
      await this.#authenticationRefresh;
    }
    signal.throwIfAborted();
    this.#runtimeUsers += 1;
    try {
      return await operation();
    } finally {
      this.#runtimeUsers -= 1;
      if (this.#runtimeUsers === 0) for (const done of this.#runtimeIdleWaiters) done();
    }
  }

  async #readAccountCooldown(
    session: BoundedCdpSession,
    signal: AbortSignal,
    verifyPrincipal = false,
  ): Promise<string | undefined> {
    const shared = this.#options.accountCooldown;
    if (!shared && !verifyPrincipal) return undefined;
    const response = await session.command(
      "Runtime.evaluate",
      {
        expression: ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION,
        returnByValue: true,
        awaitPromise: false,
      },
      signal,
    );
    const account = runtimeEvaluationValue(response);
    if (typeof account !== "string" || !/^chatgpt:[^:]+:[^:]+$/u.test(account))
      throw new Error("ORACLE_CHATGPT_ACCOUNT_PRINCIPAL_UNAVAILABLE");
    if (this.#accountSourceId !== undefined && this.#accountSourceId !== account) {
      this.#nativeTurnAnchors.clear();
      this.#goalCompletionTurns.clear();
      this.#observationRevision += 1;
      this.#rateLimit = undefined;
      this.#nextAllowedScanAtUnixMs = 0;
      this.#goalObservationNextScanAtUnixMs = 0;
      this.#goalRecoveryPending = true;
      this.#goalRecoveryGeneration += 1;
    }
    this.#accountSourceId = account;
    const cooldown = await shared?.read(account);
    // A previous account's slow disk read must not relatch or announce the
    // account after another operation has verified a newer principal.
    if (this.#accountSourceId !== account) return account;
    if (cooldown && cooldown.retryAtUnixMs > (this.#rateLimit?.retryAtUnixMs ?? 0)) {
      const serverRetryAtUnixMs =
        cooldown.serverRetryAtUnixMs !== undefined && cooldown.serverRetryAtUnixMs > Date.now()
          ? cooldown.serverRetryAtUnixMs
          : undefined;
      this.#rateLimit = {
        status: 429,
        operation: "shared_account_cooldown",
        accountSourceId: account,
        observedAtUnixMs: cooldown.observedAtUnixMs,
        retryAtUnixMs: cooldown.retryAtUnixMs,
        localBackoffMs: Math.max(0, cooldown.retryAtUnixMs - cooldown.observedAtUnixMs),
        statusEvidence: "http_status",
        backoffSource: serverRetryAtUnixMs === undefined ? "local_backoff" : "server_retry_after",
        ...(serverRetryAtUnixMs === undefined ? {} : { serverRetryAtUnixMs }),
      };
      this.#nextAllowedScanAtUnixMs = Math.max(
        this.#nextAllowedScanAtUnixMs,
        cooldown.retryAtUnixMs,
      );
    } else if (cooldown?.serverRetryAtUnixMs !== undefined && this.#rateLimit) {
      // Local pacing can outlast a server deadline. Keep both so a fresh
      // approval may skip local pacing only after the shared deadline expires.
      this.#rateLimit = {
        ...this.#rateLimit,
        serverRetryAtUnixMs: Math.max(
          this.#rateLimit.serverRetryAtUnixMs ?? 0,
          cooldown.serverRetryAtUnixMs,
        ),
      };
    }
    if (this.#notifiedAccountSourceId !== account) {
      this.#options.onAccountSourceVerified?.(account);
      this.#notifiedAccountSourceId = account;
    }
    return account;
  }

  async #attributeGoalObservations(
    result: OracleServerApprovalScanResult,
    account: string | undefined,
    session: BoundedCdpSession,
    signal: AbortSignal,
  ): Promise<OracleServerApprovalScanResult> {
    if (account === undefined || !result.goalConversations?.length) return result;
    // A login switch during the awaited read must not label another account's
    // transcript with the principal captured before that read.
    if ((await this.#readAccountCooldown(session, signal, true)) !== account)
      throw new Error("ORACLE_CHATGPT_ACCOUNT_SOURCE_CHANGED");
    return {
      ...result,
      goalConversations: result.goalConversations.map((observation) => ({
        ...observation,
        source: { kind: "web", accountSourceId: account },
      })),
    };
  }

  async #shareCooldown(
    account: string | undefined,
    limit: OracleServerApprovalScanResult["rateLimit"],
  ): Promise<void> {
    // Legacy renderer snapshots have no verified account attribution. Do not
    // attach them to whichever account happens to be signed in now.
    if (
      account !== undefined &&
      limit?.accountSourceId === account &&
      limit.observedAtUnixMs !== undefined &&
      (limit.serverRetryAtUnixMs !== undefined ||
        limit.backoffSource === "server_retry_after" ||
        // A real HTTP 429 without Retry-After still belongs to the verified
        // account, not just this connector's renderer. Reuse its existing
        // local deadline without relabeling it as a server-provided deadline.
        (limit.status === 429 &&
          limit.statusEvidence === "http_status" &&
          limit.backoffSource === "local_backoff" &&
          limit.localBackoffMs !== undefined) ||
        (limit.backoffSource !== "local_backoff" && limit.localBackoffMs === undefined))
    ) {
      const serverRetryAtUnixMs =
        limit.serverRetryAtUnixMs ??
        (limit.backoffSource === "server_retry_after" ? limit.retryAtUnixMs : undefined);
      await this.#options.accountCooldown?.observe(account, {
        observedAtUnixMs: limit.observedAtUnixMs,
        retryAtUnixMs: serverRetryAtUnixMs ?? limit.retryAtUnixMs,
        ...(serverRetryAtUnixMs === undefined ? {} : { serverRetryAtUnixMs }),
      });
    }
  }

  #isCurrentAccount(account: string | undefined): boolean {
    return this.#options.accountCooldown === undefined || account === this.#accountSourceId;
  }

  #rememberAccountCooldown(
    account: string | undefined,
    result: OracleServerApprovalScanResult,
  ): void {
    if (!this.#isCurrentAccount(account)) return;
    if (result.errors.some((error) => error.status === 401)) {
      if (!this.#authenticationRefreshAttempted) this.#authenticationRefreshRequired = true;
    } else if (result.outcome === "ok" && result.examined > 0) {
      this.#authenticationRefreshAttempted = false;
    }
    this.#nextAllowedScanAtUnixMs = Math.max(
      this.#nextAllowedScanAtUnixMs,
      result.nextScanAtUnixMs ?? 0,
    );
    if (result.rateLimit && result.rateLimit.retryAtUnixMs >= (this.#rateLimit?.retryAtUnixMs ?? 0))
      this.#rateLimit = result.rateLimit;
    else if (!result.rateLimit && Date.now() >= (this.#rateLimit?.retryAtUnixMs ?? 0))
      this.#rateLimit = undefined;
  }

  async #initialize(
    signal: AbortSignal,
    refreshAuthentication = false,
  ): Promise<BoundedCdpSession> {
    let target = await this.#transport.adoptOrOpenOwnedApprovalRuntimeTarget(
      this.#options.connectorId,
      this.#options.connectorName,
      signal,
    );
    const observeTelemetry = (data: unknown) => {
      try {
        const event = typeof data === "string" ? JSON.parse(data) : undefined;
        if (
          event?.method !== "Runtime.consoleAPICalled" ||
          event.params?.args?.[0]?.value !== "omnicodex-oracle-request-stats-v1"
        )
          return;
        const value = JSON.parse(event.params.args[1].value);
        const previous = this.#requestTelemetry.get(value.telemetryId);
        if (previous === undefined) return;
        const stats = approvalRequestStats(value.requestStats);
        // Whitelist the emitted fields again at the host boundary.
        const requestStats: OracleApprovalRequestStats = {
          scanStartedAtUnixMs: stats.scanStartedAtUnixMs,
          trigger: stats.trigger,
          getCount: stats.getCount,
          postCount: stats.postCount,
          moduleInitializationCount: stats.moduleInitializationCount,
          rateLimitCount: stats.rateLimitCount,
          conversationIds: [],
          requests: [],
        };
        const rawLimit = value.rateLimit;
        const operations = [
          "goal_observation",
          "message_structure_observation",
          "runtime_initialization",
          "conversation_read",
          "approval_submission",
          "approval_or_readback",
        ];
        const limit =
          rawLimit !== undefined && operations.includes(rawLimit.operation)
            ? parseRateLimit({
                status: 429,
                operation: rawLimit.operation,
                retryAtUnixMs: rawLimit.retryAtUnixMs,
                observedAtUnixMs: rawLimit.observedAtUnixMs,
                serverRetryAtUnixMs: rawLimit.serverRetryAtUnixMs,
                responseHeaders: { "retry-after": rawLimit.responseHeaders?.["retry-after"] },
              })
            : undefined;
        this.#requestTelemetry.set(value.telemetryId, {
          requestStats,
          ...((limit ?? previous.rateLimit) === undefined
            ? {}
            : { rateLimit: limit ?? previous.rateLimit }),
        });
      } catch {
        /* Ignore malformed or unrelated console events. */
      }
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let session: BoundedCdpSession | undefined;
      try {
        session = await this.#connectSession(this.#transport, target.id, signal, observeTelemetry);
        if (
          refreshAuthentication ||
          !isOracleChatGptApprovalRuntimeUrl(target.url, this.#options.connectorId)
        ) {
          await session.command(
            "Page.navigate",
            { url: oracleChatGptApprovalRuntimeUrl(this.#options.connectorId) },
            signal,
            ORACLE_SERVER_APPROVAL_COMMAND_LIVENESS_MS,
          );
        }
        for (;;) {
          const ready = await session.command(
            "Runtime.evaluate",
            {
              expression: ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION,
              returnByValue: true,
              awaitPromise: false,
            },
            signal,
          );
          const readiness = runtimeEvaluationValue(ready);
          if (readiness === true) {
            this.#options.conversationEvents?.setAuthenticationFailure?.(undefined);
            break;
          }
          if (
            readiness === "ORACLE_SERVER_APPROVAL_RUNTIME_AUTHENTICATION_REQUIRED" ||
            readiness === "ORACLE_SERVER_APPROVAL_RUNTIME_SESSION_DOCUMENT_INVALID"
          ) {
            const failure = new Error(readiness);
            if (readiness === "ORACLE_SERVER_APPROVAL_RUNTIME_AUTHENTICATION_REQUIRED")
              this.#options.conversationEvents?.setAuthenticationFailure?.(failure);
            throw failure;
          }
          await delay(100, signal);
        }
        this.#session = session;
        return session;
      } catch (error) {
        session?.close();
        this.#detachSession();
        if (attempt > 0 || !oracleApprovalRuntimeInitializationTransportFailure(error)) throw error;
        signal.throwIfAborted();
        // No approval operation has run yet. Replace only the exact hidden
        // connector runtime whose initialization transport stopped responding.
        await this.#transport.closeOwnedTarget(target.id, signal);
        target = await this.#transport.openOwnedApprovalRuntimeTarget(
          this.#options.connectorId,
          this.#options.connectorName,
          signal,
        );
      }
    }
    throw new Error("ORACLE_SERVER_APPROVAL_RUNTIME_INITIALIZATION_UNREACHABLE");
  }

  #detachSession(): void {
    // A transport failure does not prove the browser-side operation failed.
    // Keep its connector-owned page, pending receipts and Retry-After deadline
    // intact so reconnection adopts the same state instead of resubmitting.
    this.#session?.close();
    this.#session = undefined;
  }
}

function oracleApprovalRuntimeInitializationTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /CDP (?:command timeout:|session closed|websocket open (?:failed|timeout))/iu.test(
    message,
  );
}

async function connectOwnedApprovalSession(
  transport: ChatGptLoopbackCdpTransport,
  targetId: string,
  signal: AbortSignal,
  onTelemetry?: (data: unknown) => void,
): Promise<BoundedCdpSession> {
  const session = await BoundedCdpSession.connect(
    transport,
    {
      factory: (url) => {
        const socket = new WebSocket(url) as unknown as CdpWebSocketLike;
        socket.addEventListener("message", (event) => onTelemetry?.(event.data));
        return socket;
      },
      targetId,
      timeoutMs: ORACLE_SERVER_APPROVAL_SESSION_LIVENESS_MS,
      maxFrameBytes: DEFAULT_CDP_FRAME_BUDGET_BYTES,
    },
    signal,
  );
  try {
    await session.command("Runtime.enable", {}, signal, ORACLE_SERVER_APPROVAL_SESSION_LIVENESS_MS);
    return session;
  } catch (error) {
    session.close();
    throw error;
  }
}

function messageStructureObservation(value: unknown): OracleMessageStructureObservation {
  const invalid = (): never => {
    throw new Error("ORACLE_MESSAGE_STRUCTURE_RESULT_INVALID");
  };
  const textOrNull = (input: unknown): string | null =>
    input === null || typeof input === "string" ? input : invalid();
  const keys = (input: unknown): string[] =>
    Array.isArray(input) && input.every((entry) => typeof entry === "string") ? input : invalid();
  const container = (input: unknown): { path: string; keys: string[] } => {
    if (!isRecord(input) || typeof input.path !== "string") return invalid();
    return { path: input.path, keys: keys(input.keys) };
  };
  if (
    !isRecord(value) ||
    typeof value.conversationId !== "string" ||
    !Array.isArray(value.messages)
  ) {
    return invalid();
  }
  if (value.currentNode !== undefined && typeof value.currentNode !== "string") return invalid();
  let previousPage: OracleMessageStructureObservation["previousPage"];
  if (value.previousPage !== undefined) {
    const p = value.previousPage;
    if (
      !isRecord(p) ||
      !Number.isSafeInteger(p.messageCount) ||
      (p.messageCount as number) < 0 ||
      typeof p.hasPreviousPage !== "boolean" ||
      typeof p.cursorAdvanced !== "boolean"
    )
      return invalid();
    previousPage = {
      messageCount: p.messageCount as number,
      hasPreviousPage: p.hasPreviousPage,
      cursorAdvanced: p.cursorAdvanced,
    };
  }
  if (
    value.pageInfo !== undefined &&
    (!isRecord(value.pageInfo) ||
      Object.values(value.pageInfo).some(
        (entry) => entry !== null && !["string", "number", "boolean"].includes(typeof entry),
      ))
  )
    return invalid();
  let branchStructure: OracleMessageStructureObservation["branchStructure"];
  if (value.branchStructure !== undefined) {
    const b = value.branchStructure;
    if (
      !isRecord(b) ||
      !Array.isArray(b.chain) ||
      !Array.isArray(b.goalNodes) ||
      !Array.isArray(b.pluralParents) ||
      !["root", "missing_node", "cycle", "invalid_parent"].includes(String(b.termination))
    )
      return invalid();
    branchStructure = {
      currentNode: textOrNull(b.currentNode),
      stoppedAt: textOrNull(b.stoppedAt),
      termination: b.termination as NonNullable<
        OracleMessageStructureObservation["branchStructure"]
      >["termination"],
      chain: b.chain.map((node) => {
        if (
          !isRecord(node) ||
          typeof node.nodeId !== "string" ||
          typeof node.parentPresent !== "boolean"
        )
          return invalid();
        return {
          nodeId: node.nodeId,
          messageId: textOrNull(node.messageId),
          authorRole: textOrNull(node.authorRole),
          parent: textOrNull(node.parent),
          parentPresent: node.parentPresent,
        };
      }),
      goalNodes: b.goalNodes.map((node) => {
        if (
          !isRecord(node) ||
          typeof node.messageId !== "string" ||
          typeof node.onCurrentBranch !== "boolean" ||
          !Array.isArray(node.shapes)
        )
          return invalid();
        return {
          messageId: node.messageId,
          nodeIds: keys(node.nodeIds),
          onCurrentBranch: node.onCurrentBranch,
          shapes: node.shapes.map((shape) => {
            if (
              !isRecord(shape) ||
              typeof shape.textType !== "string" ||
              typeof shape.acceptedGoal !== "boolean" ||
              typeof shape.jsonValid !== "boolean" ||
              typeof shape.decodedType !== "string" ||
              !Number.isSafeInteger(shape.textLength) ||
              (shape.textLength as number) < 0
            )
              return invalid();
            return {
              authorRole: textOrNull(shape.authorRole),
              authorName: textOrNull(shape.authorName),
              status: textOrNull(shape.status),
              contentKeys: keys(shape.contentKeys),
              textType: shape.textType,
              textLength: shape.textLength as number,
              jsonValid: shape.jsonValid,
              decodedType: shape.decodedType,
              nestedDecodedKeys: keys(shape.nestedDecodedKeys),
              decodedKeys: keys(shape.decodedKeys),
              acceptedGoal: shape.acceptedGoal,
            };
          }),
        };
      }),
      pluralParents: b.pluralParents.map((node) => {
        if (!isRecord(node)) return invalid();
        return {
          messageId: textOrNull(node.messageId),
          parentId: textOrNull(node.parentId),
          metadataParentId: textOrNull(node.metadataParentId),
        };
      }),
    };
  }
  let currentMessage: OracleMessageStructureObservation["currentMessage"];
  if (value.currentMessage !== undefined) {
    const current = value.currentMessage;
    if (!isRecord(current) || typeof current.id !== "string" || current.id !== value.currentNode)
      return invalid();
    const optionalString = (key: string): string =>
      typeof current[key] === "string" ? current[key] : invalid();
    if (
      (current.endTurn !== undefined &&
        current.endTurn !== null &&
        typeof current.endTurn !== "boolean") ||
      (current.channel !== undefined &&
        current.channel !== null &&
        typeof current.channel !== "string") ||
      (current.isComplete !== undefined && typeof current.isComplete !== "boolean")
    )
      return invalid();
    currentMessage = {
      id: current.id,
      ...(current.authorRole === undefined ? {} : { authorRole: optionalString("authorRole") }),
      ...(current.status === undefined ? {} : { status: optionalString("status") }),
      ...(current.endTurn === undefined ? {} : { endTurn: current.endTurn }),
      ...(current.channel === undefined ? {} : { channel: current.channel }),
      ...(current.isComplete === undefined ? {} : { isComplete: current.isComplete }),
      ...(current.workingTurnId === undefined
        ? {}
        : { workingTurnId: optionalString("workingTurnId") }),
      ...(current.turnExchangeId === undefined
        ? {}
        : { turnExchangeId: optionalString("turnExchangeId") }),
    };
  }
  return {
    conversationId: value.conversationId,
    ...(previousPage === undefined ? {} : { previousPage }),
    ...(value.pageInfo === undefined
      ? {}
      : { pageInfo: value.pageInfo as Readonly<Record<string, string | number | boolean | null>> }),
    ...(branchStructure === undefined ? {} : { branchStructure }),
    ...(value.conversationKeys === undefined
      ? {}
      : { conversationKeys: keys(value.conversationKeys) }),
    ...(value.goalConversation === undefined
      ? {}
      : { goalConversation: parseOracleGoalConversation(value.goalConversation) }),
    ...(value.currentNode === undefined ? {} : { currentNode: value.currentNode }),
    ...(currentMessage === undefined ? {} : { currentMessage }),
    messages: value.messages.map((message) => {
      if (
        !isRecord(message) ||
        !Array.isArray(message.containers) ||
        !Array.isArray(message.resourceLinks)
      ) {
        return invalid();
      }
      return {
        id: textOrNull(message.id),
        authorRole: textOrNull(message.authorRole),
        authorName: textOrNull(message.authorName),
        ...(message.goalResult === undefined
          ? {}
          : {
              goalResult: (() => {
                const goal = message.goalResult;
                if (
                  message.authorRole !== "tool" ||
                  message.authorName !== "api_tool.call_tool" ||
                  !isRecord(goal) ||
                  typeof goal.toolName !== "string" ||
                  ![
                    "omnicodex__goal_create",
                    "omnicodex__goal_get",
                    "omnicodex__goal_claim_next_step",
                    "omnicodex__goal_complete",
                  ].includes(goal.toolName) ||
                  typeof goal.goalId !== "string" ||
                  !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(goal.goalId) ||
                  (goal.state !== "active" && goal.state !== "completed") ||
                  !isNonNegativeSafeInteger(goal.revision) ||
                  goal.revision < 1 ||
                  !isNonNegativeSafeInteger(goal.createdAtUnixMs)
                )
                  return invalid();
                return {
                  toolName: goal.toolName,
                  goalId: goal.goalId,
                  state: goal.state,
                  revision: goal.revision,
                  createdAtUnixMs: goal.createdAtUnixMs,
                };
              })(),
            }),
        contentType: textOrNull(message.contentType),
        ...(message.invokedGoalResourceUri === undefined
          ? {}
          : {
              invokedGoalResourceUri:
                typeof message.invokedGoalResourceUri === "string" &&
                /^\/[A-Za-z0-9_-]+\/link_[a-z0-9]+\/omnicodex__goal_(?:create|get|claim_next_step|complete|update)$/.test(
                  message.invokedGoalResourceUri,
                )
                  ? message.invokedGoalResourceUri
                  : invalid(),
            }),
        ...(message.referencesConnector === undefined
          ? {}
          : {
              referencesConnector:
                typeof message.referencesConnector === "boolean"
                  ? message.referencesConnector
                  : invalid(),
            }),
        topLevelKeys: keys(message.topLevelKeys),
        metadataKeys: keys(message.metadataKeys),
        containers: message.containers.map(container),
        resourceLinks: message.resourceLinks.map((resource) => {
          if (!isRecord(resource) || typeof resource.uriType !== "string") return invalid();
          return { ...container(resource), uriType: resource.uriType };
        }),
        ...(message.canonicalResources === undefined
          ? {}
          : {
              canonicalResources: (() => {
                if (!Array.isArray(message.canonicalResources)) return invalid();
                return message.canonicalResources.map((resource) => {
                  if (
                    !isRecord(resource) ||
                    typeof resource.path !== "string" ||
                    typeof resource.resourceId !== "string" ||
                    !/^[A-Za-z0-9_-]{43}$/.test(resource.resourceId) ||
                    !/^\$\["metadata"\]\[(?:"attachments"\]\[\d+\]\["download_url"|"invoked_resource"\]\["resource_uri")\]$/.test(
                      resource.path,
                    )
                  )
                    return invalid();
                  return { path: resource.path, resourceId: resource.resourceId };
                });
              })(),
            }),
      };
    }),
  };
}

function approvalScanResult(value: unknown): OracleServerApprovalScanResult {
  const evaluated = runtimeEvaluationValue(value);
  if (!isRecord(evaluated)) throw new Error("ORACLE_SERVER_APPROVAL_RESULT_INVALID");
  if (evaluated.outcome !== "ok" && evaluated.outcome !== "partial") {
    throw new Error("ORACLE_SERVER_APPROVAL_OUTCOME_INVALID");
  }
  const receipts = Array.isArray(evaluated.receipts)
    ? evaluated.receipts.map(approvalReceipt)
    : undefined;
  const conversationUrls = Array.isArray(evaluated.conversationUrls)
    ? evaluated.conversationUrls.map(exactConversationUrl)
    : undefined;
  const errors = Array.isArray(evaluated.errors)
    ? evaluated.errors.map((entry): OracleServerApprovalScanResult["errors"][number] => {
        if (
          !isRecord(entry) ||
          typeof entry.conversationId !== "string" ||
          typeof entry.error !== "string"
        ) {
          throw new Error("ORACLE_SERVER_APPROVAL_ERROR_INVALID");
        }
        return {
          conversationId: entry.conversationId,
          error: entry.error,
          ...(entry.submissionState === "unknown" || entry.submissionState === "rejected"
            ? { submissionState: entry.submissionState }
            : {}),
          ...(Number.isInteger(entry.status) &&
          Number(entry.status) >= 100 &&
          Number(entry.status) <= 599
            ? { status: entry.status as number }
            : {}),
          ...(typeof entry.operation === "string" ? { operation: entry.operation } : {}),
          ...(isNonNegativeSafeInteger(entry.observedAtUnixMs)
            ? { observedAtUnixMs: entry.observedAtUnixMs }
            : {}),
          ...(entry.responseHeaders === undefined
            ? {}
            : {
                responseHeaders: rateLimitDiagnostics(entry).responseHeaders ?? {},
              }),
        };
      })
    : undefined;
  if (
    receipts === undefined ||
    conversationUrls === undefined ||
    errors === undefined ||
    !isNonNegativeSafeInteger(evaluated.examined) ||
    !isNonNegativeSafeInteger(evaluated.discovered) ||
    !isNonNegativeSafeInteger(evaluated.approvalsPending)
  ) {
    throw new Error("ORACLE_SERVER_APPROVAL_RESULT_INVALID");
  }
  const nextScanAtUnixMs = evaluated.nextScanAtUnixMs;
  if (nextScanAtUnixMs !== undefined && !isNonNegativeSafeInteger(nextScanAtUnixMs)) {
    throw new Error("ORACLE_SERVER_APPROVAL_SCAN_TIME_INVALID");
  }
  const rateLimit = parseRateLimit(evaluated.rateLimit);
  return {
    outcome: evaluated.outcome,
    ...(evaluated.requestStats === undefined
      ? {}
      : { requestStats: approvalRequestStats(evaluated.requestStats) }),
    examined: evaluated.examined,
    discovered: evaluated.discovered,
    approvalsPending: evaluated.approvalsPending,
    ...(evaluated.goalConversations === undefined
      ? {}
      : {
          goalConversations: Array.isArray(evaluated.goalConversations)
            ? evaluated.goalConversations.map(parseOracleGoalConversation)
            : (() => {
                throw new Error("ORACLE_GOAL_CONVERSATIONS_INVALID");
              })(),
        }),
    ...(evaluated.messageStructureObservation === undefined
      ? {}
      : {
          messageStructureObservation: messageStructureObservation(
            evaluated.messageStructureObservation,
          ),
        }),
    followUpScanRequired: evaluated.followUpScanRequired === true,
    conversationUrls,
    receipts,
    errors,
    ...(nextScanAtUnixMs === undefined ? {} : { nextScanAtUnixMs }),
    ...(rateLimit === undefined ? {} : { rateLimit }),
  };
}

function parseRateLimit(value: unknown): OracleServerApprovalScanResult["rateLimit"] {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    value.status !== 429 ||
    typeof value.operation !== "string" ||
    !isNonNegativeSafeInteger(value.retryAtUnixMs)
  )
    throw new Error("ORACLE_SERVER_APPROVAL_RATE_LIMIT_INVALID");
  return {
    status: 429,
    operation: value.operation,
    retryAtUnixMs: value.retryAtUnixMs,
    ...(typeof value.accountSourceId === "string" &&
    /^chatgpt:[^:]+:[^:]+$/u.test(value.accountSourceId)
      ? { accountSourceId: value.accountSourceId }
      : {}),
    ...rateLimitDiagnostics(value),
  };
}

function approvalRequestStats(value: unknown): OracleApprovalRequestStats {
  if (
    !isRecord(value) ||
    !["idle", "queued_request", "recovery", "observation"].includes(String(value.trigger)) ||
    ![
      "scanStartedAtUnixMs",
      "getCount",
      "postCount",
      "moduleInitializationCount",
      "rateLimitCount",
    ].every((key) => isNonNegativeSafeInteger(value[key])) ||
    !Array.isArray(value.conversationIds) ||
    !value.conversationIds.every((id) => typeof id === "string") ||
    !Array.isArray(value.requests) ||
    !value.requests.every(
      (entry) =>
        isRecord(entry) &&
        (entry.method === "GET" || entry.method === "POST") &&
        typeof entry.path === "string" &&
        entry.path.startsWith("/") &&
        !/[?#]/u.test(entry.path) &&
        typeof entry.operation === "string" &&
        (entry.conversationId === undefined || typeof entry.conversationId === "string"),
    )
  )
    throw new Error("ORACLE_SERVER_APPROVAL_REQUEST_STATS_INVALID");
  return structuredClone(value) as unknown as OracleApprovalRequestStats;
}

function rateLimitDiagnostics(
  value: Record<string, unknown>,
): Partial<NonNullable<OracleServerApprovalScanResult["rateLimit"]>> {
  const responseHeaders: Record<string, string> = {};
  if (isRecord(value.responseHeaders)) {
    for (const name of ORACLE_RATE_LIMIT_RESPONSE_HEADERS) {
      const header = value.responseHeaders[name];
      if (typeof header === "string") responseHeaders[name] = header;
    }
  }
  return {
    ...(isNonNegativeSafeInteger(value.observedAtUnixMs)
      ? { observedAtUnixMs: value.observedAtUnixMs }
      : {}),
    ...(isNonNegativeSafeInteger(value.serverRetryAtUnixMs)
      ? { serverRetryAtUnixMs: value.serverRetryAtUnixMs }
      : {}),
    ...(isNonNegativeSafeInteger(value.localBackoffMs)
      ? { localBackoffMs: value.localBackoffMs }
      : {}),
    ...(value.statusEvidence === "http_status" || value.statusEvidence === "error_text"
      ? { statusEvidence: value.statusEvidence }
      : {}),
    ...(value.backoffSource === "server_retry_after" || value.backoffSource === "local_backoff"
      ? { backoffSource: value.backoffSource }
      : {}),
    ...(value.responseHeaders === undefined ? {} : { responseHeaders }),
  };
}

function idleScanResult(): OracleServerApprovalScanResult {
  return {
    outcome: "ok",
    examined: 0,
    discovered: 0,
    approvalsPending: 0,
    followUpScanRequired: false,
    conversationUrls: [],
    receipts: [],
    errors: [],
  };
}

function exactConversationUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("ORACLE_SERVER_CONVERSATION_URL_INVALID");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ORACLE_SERVER_CONVERSATION_URL_INVALID");
  }
  const normalized = normalizeChatGptConversationUrl(value);
  if (url.search !== "" || url.hash !== "" || normalized === undefined) {
    throw new Error("ORACLE_SERVER_CONVERSATION_URL_INVALID");
  }
  return normalized;
}

function approvalReceipt(value: unknown): OracleServerApprovalReceipt {
  if (
    !isRecord(value) ||
    typeof value.conversationId !== "string" ||
    typeof value.conversationUrl !== "string" ||
    typeof value.pendingMessageId !== "string" ||
    (value.userMessageId !== undefined &&
      (typeof value.userMessageId !== "string" || value.userMessageId.length === 0)) ||
    typeof value.clientMessageId !== "string" ||
    typeof value.targetMessageId !== "string" ||
    (value.action !== "allow" && value.action !== "always_allow") ||
    typeof value.rememberAnswer !== "boolean" ||
    (value.responseStatus !== undefined && !isNonNegativeSafeInteger(value.responseStatus))
  ) {
    throw new Error("ORACLE_SERVER_APPROVAL_RECEIPT_INVALID");
  }
  return {
    conversationId: value.conversationId,
    conversationUrl: value.conversationUrl,
    pendingMessageId: value.pendingMessageId,
    ...(value.userMessageId === undefined ? {} : { userMessageId: value.userMessageId as string }),
    clientMessageId: value.clientMessageId,
    targetMessageId: value.targetMessageId,
    action: value.action,
    rememberAnswer: value.rememberAnswer,
    ...(value.responseStatus === undefined
      ? {}
      : { responseStatus: value.responseStatus as number }),
  };
}

function runtimeEvaluationValue(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.result)) {
    throw new Error("ORACLE_SERVER_APPROVAL_EVALUATION_INVALID");
  }
  if (isRecord(value.exceptionDetails)) {
    const exception = isRecord(value.exceptionDetails.exception)
      ? value.exceptionDetails.exception
      : undefined;
    const detail = [value.exceptionDetails.text, exception?.description]
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .join(":")
      .slice(0, 500);
    throw new Error(
      `ORACLE_SERVER_APPROVAL_EVALUATION_EXCEPTION${detail === "" ? "" : `:${detail}`}`,
    );
  }
  return value.result.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function waitForGoalObservation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
