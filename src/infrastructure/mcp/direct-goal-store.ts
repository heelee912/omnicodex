import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { normalizeChatGptConversationUrl } from "../chatgpt/chatgpt-conversation-route.js";
import type { OracleGoalConversation } from "../chatgpt/oracle-goal-conversation.js";
import { omniCodexDataDirectory } from "../config/omnicodex-config-store.js";
import { canonicalJson } from "../safety/canonical-json.js";

const SCHEMA_VERSION = 2;
const DEFAULT_LEASE_MS = 5 * 60_000;
const MAX_COMPLETED_AUTOMATIC_STEPS = 64;

export type DirectGoalStepMode = "successful_call" | "mutation_and_readback";
export type DirectGoalState = "active" | "paused" | "completed" | "blocked";
export type DirectGoalStepState = "pending" | "claimed" | "awaiting_readback" | "completed";
export type DirectGoalExecutionRole = "work" | "readback";
export type DirectGoalReservationState = "prepared" | "dispatched" | "outcome_unknown";
export type DirectGoalTerminalOutcome = "succeeded" | "tool_error" | "failed";

export interface DirectGoalStepInput {
  readonly id: string;
  readonly description: string;
  readonly mode: DirectGoalStepMode;
  /** Suggested tools retained as progress context, not an execution allowlist. */
  readonly allowedToolNames?: readonly string[];
}

export interface DirectGoalCreateInput {
  readonly authorizationBinding: string;
  readonly idempotencyKey?: string;
  readonly objective: string;
  readonly steps?: readonly DirectGoalStepInput[];
}

export interface DirectGoalManagementSelector {
  readonly goalId?: string;
  readonly conversationUrl?: string;
}

export interface DirectGoalManagementTarget {
  readonly authorizationBinding: string;
  readonly goalId: string;
}

export interface DirectGoalClaimInput {
  readonly authorizationBinding: string;
  readonly goalId: string;
  readonly claimantBinding: string;
  readonly leaseMs?: number;
}

export interface DirectGoalExecutionReceiptInput {
  readonly authorizationBinding: string;
  readonly claimantBinding: string;
  readonly goalId: string;
  readonly stepId: string;
  /** Legacy client-carried claim proof. New native calls use claimTokenDigest server-side. */
  readonly claimToken?: string;
  /** Internal only: digest recovered from the owner/work-session-bound pending claim. */
  readonly claimTokenDigest?: string;
  readonly role: DirectGoalExecutionRole;
  readonly operationId: string;
  readonly toolName: string;
  readonly targetIdentity: string;
  readonly resourceDigest: string;
  readonly resultDigest: string;
  readonly stateEffect: "none" | "read" | "mutate";
  readonly modelEffect: "none" | "model" | "unknown";
  readonly outcome: DirectGoalTerminalOutcome;
  readonly provesOperationId?: string;
}

export type DirectGoalExecutionAuthorizationInput = Omit<
  DirectGoalExecutionReceiptInput,
  "resultDigest" | "outcome"
>;

export type DirectGoalExecutionReservationInput = DirectGoalExecutionAuthorizationInput;
export type DirectGoalExecutionFinalizeInput = DirectGoalExecutionReceiptInput;

export interface DirectGoalExecutionReservationView {
  readonly operationId: string;
  readonly state: DirectGoalReservationState | "finalized";
  readonly disposition: "created" | "joined" | "updated" | "recovery_required" | "finalized";
  readonly preparedAtUnixMs: number;
  readonly dispatchedAtUnixMs?: number;
  readonly outcomeUnknownAtUnixMs?: number;
}

export interface DirectGoalCompletionInput {
  readonly authorizationBinding: string;
  readonly goalId: string;
  readonly objective?: string;
}

export interface DirectGoalUpdateInput extends DirectGoalCompletionInput {
  readonly status?: "active" | "paused" | "complete" | "blocked";
  readonly reason?: string;
}

export interface DirectGoalDeleteInput {
  readonly authorizationBinding: string;
  readonly goalId: string;
}

export interface DirectGoalDeleteView {
  readonly goalId: string;
  readonly deleted: true;
  readonly deletedAtUnixMs: number;
}

export interface DirectGoalConversationLifecycleInput {
  readonly conversationUrl: string;
  /** Exact verified ChatGPT principal that owns the conversation. */
  readonly accountSourceId: string;
}

export interface DirectGoalStoreOptions {
  readonly dataDirectory?: string;
  readonly snapshotPath?: string;
  readonly nowUnixMs?: () => number;
  readonly randomUUID?: () => string;
  readonly randomBytes?: (size: number) => Buffer;
}

export interface DirectGoalReceiptView {
  readonly operationId: string;
  readonly role: DirectGoalExecutionRole;
  readonly toolName: string;
  readonly targetIdentity: string;
  readonly resourceDigest: string;
  readonly resultDigest: string;
  readonly stateEffect: "none" | "read" | "mutate";
  readonly recordedAtUnixMs: number;
  readonly provesOperationId?: string;
}

export interface DirectGoalReservationView {
  readonly operationId: string;
  readonly role: DirectGoalExecutionRole;
  readonly toolName: string;
  readonly targetIdentity: string;
  readonly resourceDigest: string;
  readonly stateEffect: "none" | "read" | "mutate";
  readonly modelEffect: "none" | "model" | "unknown";
  readonly state: DirectGoalReservationState;
  readonly preparedAtUnixMs: number;
  readonly dispatchedAtUnixMs?: number;
  readonly outcomeUnknownAtUnixMs?: number;
  readonly provesOperationId?: string;
}

export interface DirectGoalStepView {
  readonly id: string;
  readonly description: string;
  readonly mode: DirectGoalStepMode;
  readonly allowedToolNames: readonly string[];
  readonly state: DirectGoalStepState;
  readonly claimExpiresAtUnixMs?: number;
  readonly reservation?: DirectGoalReservationView;
  readonly receipts: readonly DirectGoalReceiptView[];
}

export interface DirectGoalView {
  readonly id: string;
  readonly objective: string;
  readonly executionMode?: "dynamic";
  readonly state: DirectGoalState;
  readonly revision: number;
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
  readonly completedAtUnixMs?: number;
  readonly blockedAtUnixMs?: number;
  readonly blockedReason?: string;
  readonly steps: readonly DirectGoalStepView[];
  readonly continuation?: DirectGoalContinuation;
}

/** Chat On Steroids' per-conversation draft/send/ack transaction, in the existing Goal record. */
export interface DirectGoalContinuation {
  readonly enabled: true;
  readonly connectorId?: string;
  readonly conversationUrl?: string;
  readonly bindingMessageId?: string;
  readonly accountSourceId?: string;
  readonly settledMessageId?: string;
  readonly settledTransport?: "desktop";
  /** Durable response identities shared by every observer of this conversation. */
  readonly observedFinalMessageIds?: readonly string[];
  readonly settledAncestorMessageIds?: readonly string[];
  /** Exact unresolved final candidates; retained across restart until native readback resolves order. */
  readonly pendingFinalMessageIds?: readonly string[];
  readonly draft?: {
    readonly token: string;
    readonly afterMessageId: string;
    readonly state: "ready" | "prepared" | "dispatching" | "sent" | "cancelled";
    /** The selected Goal request persisted without a model turn while the native task was idle. */
    readonly resumeIdleUserTurn?: boolean;
    /** A tool-producing assistant turn stopped without a final response after the native task became idle. */
    readonly resumeIdleIncompleteTurn?: boolean;
    readonly transport?: "desktop";
    readonly nativeReceipt?: DirectGoalNativeSendReceipt;
  };
}

/** The actual correlated native host response, not a guessed Chat message identity. */
export interface DirectGoalNativeSendReceipt {
  readonly operationId: string;
  readonly threadId: string;
  readonly accountSourceId: string;
  readonly kind: "native_host_acknowledged" | "native_message_prepared";
  readonly clientUserMessageId?: string;
  readonly nativeMessages?: Record<string, unknown>;
  readonly prompt?: string;
  readonly dispatchState?: "prepared" | "dispatching";
}

export interface DirectGoalContinuationWork {
  readonly goalId: string;
  readonly connectorId?: string;
  readonly conversationUrl: string;
  readonly accountSourceId?: string;
  /** Recent durable Web work-session digests that executed this Goal. */
  readonly workSessionBindingSha256s?: readonly string[];
  readonly draft: NonNullable<DirectGoalContinuation["draft"]>;
}

export interface DirectGoalClaimView {
  readonly goal: DirectGoalView;
  readonly step: DirectGoalStepView;
  readonly claimToken: string;
  readonly claimExpiresAtUnixMs: number;
}

/** Inputs used to associate the next eligible native call with a pending Goal claim. */
export interface DirectGoalPendingExecutionInput {
  readonly authorizationBinding: string;
  readonly claimantBinding: string;
  readonly toolName: string;
  readonly resourceDigest: string;
  readonly stateEffect: "none" | "read" | "mutate";
  readonly modelEffect: "none" | "model" | "unknown";
  /** Recover only this already-dispatched operation; never claim new work. */
  readonly operationId?: string;
  /** Set false while checking explicit claims before native replay acquisition. */
  readonly includeDynamic?: boolean;
}

/** Private server-side Goal context. It is never copied into a native tool schema. */
export interface DirectGoalPendingExecutionContext {
  readonly goalId: string;
  readonly stepId: string;
  readonly claimTokenDigest: string;
  readonly role: DirectGoalExecutionRole;
  readonly provesOperationId?: string;
}

/** Server-owned proof target for a dispatched dynamic mutation whose native result was lost. */
export interface DirectGoalUnknownExecutionReadbackInput {
  readonly authorizationBinding: string;
  readonly claimantBinding: string;
  readonly resourceDigest: string;
  readonly stateEffect: "read";
  readonly modelEffect: "none";
}

export interface DirectGoalUnknownExecutionReadbackContext {
  readonly goalId: string;
  readonly stepId: string;
  readonly operationId: string;
  readonly resourceDigest: string;
}

export interface DirectGoalUnknownExecutionReadbackFinalizeInput
  extends DirectGoalUnknownExecutionReadbackInput {
  readonly context: DirectGoalUnknownExecutionReadbackContext;
  readonly proofOperationId: string;
  readonly proofToolName: string;
  readonly proofTargetIdentity: string;
  readonly proofResultDigest: string;
}

export interface DirectGoalUnknownExecutionReadbackView {
  readonly goal: DirectGoalView;
  readonly recoveredOperationId: string;
  readonly proofOperationId: string;
}

interface StoredReceipt extends DirectGoalReceiptView {
  readonly executionBindingDigest: string;
}

interface StoredClaim {
  readonly claimantDigest: string;
  readonly tokenDigest: string;
  readonly expiresAtUnixMs: number;
}

interface StoredReservation {
  readonly operationId: string;
  readonly executionBindingDigest: string;
  readonly claimantDigest: string;
  readonly claimTokenDigest: string;
  readonly role: DirectGoalExecutionRole;
  readonly toolName: string;
  readonly targetIdentity: string;
  readonly resourceDigest: string;
  readonly stateEffect: "none" | "read" | "mutate";
  readonly modelEffect: "none" | "model" | "unknown";
  readonly state: DirectGoalReservationState;
  readonly preparedAtUnixMs: number;
  readonly dispatchedAtUnixMs?: number;
  readonly outcomeUnknownAtUnixMs?: number;
  readonly provesOperationId?: string;
}

interface StoredOperationBinding {
  readonly operationId: string;
  readonly executionBindingDigest: string;
  readonly boundAtUnixMs: number;
}

interface StoredStep {
  readonly id: string;
  /** Native execution record, independent of the optional reference steps. */
  readonly automatic?: true;
  readonly description: string;
  readonly mode: DirectGoalStepMode;
  readonly allowedToolNames: readonly string[];
  readonly state: DirectGoalStepState;
  readonly claim?: StoredClaim;
  readonly reservation?: StoredReservation;
  readonly operationBindings: readonly StoredOperationBinding[];
  readonly receipts: readonly StoredReceipt[];
}

interface StoredGoal {
  readonly id: string;
  readonly ownerDigest: string;
  readonly idempotencyDigest: string;
  readonly objective: string;
  readonly executionMode?: "dynamic";
  readonly state: DirectGoalState;
  readonly revision: number;
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
  readonly completedAtUnixMs?: number;
  readonly blockedAtUnixMs?: number;
  readonly blockedReason?: string;
  readonly steps: readonly StoredStep[];
  readonly continuation?: DirectGoalContinuation;
}

interface StoredGoalDeletion {
  readonly goalId: string;
  readonly ownerDigest: string;
  readonly deletedAtUnixMs: number;
}

interface SnapshotPayload {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly revision: number;
  readonly goals: readonly StoredGoal[];
  readonly deletions?: readonly StoredGoalDeletion[];
}

interface StoredSnapshot extends SnapshotPayload {
  readonly checksum: string;
}

interface DirectGoalCoreConfiguration {
  readonly snapshotPath: string;
  readonly nowUnixMs: () => number;
  readonly randomUUID: () => string;
  readonly randomBytes: (size: number) => Buffer;
}

interface CoreRegistryEntry {
  readonly snapshotPath: string;
  readonly promise: Promise<DirectGoalCore>;
}

const PROCESS_CORES_SYMBOL = Symbol.for("@heelee912/omnicodex/direct-goal-cores/v2");
const processCores = processCoreRegistry();

/**
 * Owner-bound, restart-durable evidence ledger for goals executed by the Web
 * GPT itself. It never invokes a model or sends work to another Codex thread.
 * A mutating step remains incomplete until a later direct read on the same
 * normalized resource is recorded as an authoritative readback.
 */
export class DirectGoalStore {
  readonly #core: DirectGoalCore;

  private constructor(core: DirectGoalCore) {
    this.#core = core;
  }

  static async open(options: DirectGoalStoreOptions = {}): Promise<DirectGoalStore> {
    const configuration = configurationFrom(options);
    const key = processPathKey(configuration.snapshotPath);
    const existing = processCores.get(key);
    if (existing !== undefined) {
      if (existing.snapshotPath !== configuration.snapshotPath) {
        throw new Error("Direct Goal store path configuration changed");
      }
      return new DirectGoalStore(await existing.promise);
    }
    const promise = DirectGoalCore.open(configuration);
    const entry = { snapshotPath: configuration.snapshotPath, promise };
    processCores.set(key, entry);
    try {
      return new DirectGoalStore(await promise);
    } catch (error) {
      if (processCores.get(key) === entry) processCores.delete(key);
      throw error;
    }
  }

  static inMemory(options: Omit<DirectGoalStoreOptions, "dataDirectory" | "snapshotPath"> = {}) {
    return new DirectGoalStore(
      DirectGoalCore.inMemory({
        snapshotPath: "memory://direct-goals",
        nowUnixMs: options.nowUnixMs ?? Date.now,
        randomUUID: options.randomUUID ?? randomUUID,
        randomBytes: options.randomBytes ?? randomBytes,
      }),
    );
  }

  async create(input: DirectGoalCreateInput): Promise<DirectGoalView> {
    return this.#core.create(input);
  }

  async get(authorizationBinding: string, goalId?: string): Promise<DirectGoalView | undefined> {
    return this.#core.get(authorizationBinding, goalId);
  }

  async list(
    authorizationBindings: readonly string[],
    states?: readonly DirectGoalState[],
  ): Promise<readonly DirectGoalView[]> {
    return this.#core.list(authorizationBindings, states);
  }

  async resolveManagementTarget(
    authorizationBindings: readonly string[],
    selector: DirectGoalManagementSelector,
  ): Promise<DirectGoalManagementTarget | undefined> {
    return this.#core.resolveManagementTarget(authorizationBindings, selector);
  }

  async claimNext(input: DirectGoalClaimInput): Promise<DirectGoalClaimView | undefined> {
    return this.#core.claimNext(input);
  }

  async resolvePendingExecution(
    input: DirectGoalPendingExecutionInput,
  ): Promise<DirectGoalPendingExecutionContext | undefined> {
    return this.#core.resolvePendingExecution(input);
  }

  /** Selects one exact dispatched dynamic mutation for a later authoritative read. */
  async resolveUnknownExecutionReadback(
    input: DirectGoalUnknownExecutionReadbackInput,
  ): Promise<DirectGoalUnknownExecutionReadbackContext | undefined> {
    return this.#core.resolveUnknownExecutionReadback(input);
  }

  /** Commits a successful authoritative read in place of an unavailable native result. */
  async finalizeUnknownExecutionReadback(
    input: DirectGoalUnknownExecutionReadbackFinalizeInput,
  ): Promise<DirectGoalUnknownExecutionReadbackView | undefined> {
    return this.#core.finalizeUnknownExecutionReadback(input);
  }

  /** Atomically persists the exact claim/native-operation binding before dispatch. */
  async beginExecution(
    input: DirectGoalExecutionReservationInput,
  ): Promise<DirectGoalExecutionReservationView> {
    try {
      return await this.#core.beginExecution(input);
    } catch (error) {
      await this.#core.discardUnreservedDynamicClaim(input);
      throw error;
    }
  }

  /** Marks the durable reservation ambiguous before invoking native I/O. */
  async markExecutionDispatched(
    input: DirectGoalExecutionReservationInput,
  ): Promise<DirectGoalExecutionReservationView> {
    return this.#core.markExecutionDispatched(input);
  }

  /** Releases only an exact still-prepared reservation when native I/O never started. */
  async abortBeforeDispatch(input: DirectGoalExecutionReservationInput): Promise<DirectGoalView> {
    return this.#core.abortBeforeDispatch(input);
  }

  /** Retains an exact reservation when the native outcome cannot be established. */
  async markExecutionOutcomeUnknown(
    input: DirectGoalExecutionReservationInput,
  ): Promise<DirectGoalExecutionReservationView> {
    return this.#core.markExecutionOutcomeUnknown(input);
  }

  /** Commits success evidence or releases an exact terminal failure reservation. */
  async finalizeExecution(input: DirectGoalExecutionFinalizeInput): Promise<DirectGoalView> {
    return this.#core.finalizeExecution(input);
  }

  async complete(input: DirectGoalCompletionInput): Promise<DirectGoalView> {
    return this.#core.complete(input);
  }

  async updateStatus(input: DirectGoalUpdateInput): Promise<DirectGoalView> {
    return this.#core.updateStatus(input);
  }

  async delete(input: DirectGoalDeleteInput): Promise<DirectGoalDeleteView> {
    return this.#core.delete(input);
  }

  /** Host-only lifecycle transition for an exact user-stopped Chat conversation. */
  pauseConversation(
    input: DirectGoalConversationLifecycleInput,
  ): Promise<readonly DirectGoalView[]> {
    return this.#core.pauseConversation(input);
  }

  /** Host-only cleanup after an authoritative deleted-conversation response. */
  deleteConversation(
    input: DirectGoalConversationLifecycleInput,
  ): Promise<readonly DirectGoalDeleteView[]> {
    return this.#core.deleteConversation(input);
  }

  observeConversation(observation: OracleGoalConversation): Promise<void> {
    return this.#core.observeConversation(observation);
  }

  observeBoundDesktopFinal(
    observation: Pick<OracleGoalConversation, "conversationUrl" | "current"> & {
      readonly source: NonNullable<OracleGoalConversation["source"]>;
    },
  ): Promise<void> {
    return this.#core.observeBoundDesktopFinal(observation);
  }

  pendingContinuations(): Promise<readonly DirectGoalContinuationWork[]> {
    return this.#core.pendingContinuations();
  }

  recordNativeContinuationReceipt(
    work: DirectGoalContinuationWork,
    receipt: DirectGoalNativeSendReceipt,
  ): Promise<boolean> {
    return this.#core.recordNativeContinuationReceipt(work, receipt);
  }

  continuationConversationUrls(
    accountSourceId?: string,
    connectorId?: string,
  ): Promise<readonly string[]> {
    return this.#core.continuationConversationUrls(accountSourceId, connectorId);
  }

  continuationCheckpoints(
    accountSourceId?: string,
    connectorId?: string,
  ): Promise<
    readonly {
      conversationUrl: string;
      checkpoint: NonNullable<OracleGoalConversation["checkpoint"]>;
    }[]
  > {
    return this.#core.continuationCheckpoints(accountSourceId, connectorId);
  }

  hasUnboundContinuation(options: { readonly activeOnly?: boolean } = {}): Promise<boolean> {
    return this.#core.hasUnboundContinuation(options);
  }

  hasObservedGoalCandidate(
    results: OracleGoalConversation["goals"],
    options: { readonly unboundOnly?: boolean } = {},
  ): Promise<boolean> {
    return this.#core.hasObservedGoalCandidate(results, options);
  }

  transitionContinuation(
    work: DirectGoalContinuationWork,
    state: "dispatching" | "ready" | "prepared" | "sent" | "cancelled",
  ): Promise<boolean> {
    return this.#core.transitionContinuation(work, state);
  }

  canDispatchContinuation(work: DirectGoalContinuationWork): Promise<boolean> {
    return this.#core.canDispatchContinuation(work);
  }
}

class DirectGoalCore {
  readonly #configuration: DirectGoalCoreConfiguration;
  readonly #durable: boolean;
  #snapshot: SnapshotPayload;
  #tail: Promise<void> = Promise.resolve();

  private constructor(
    configuration: DirectGoalCoreConfiguration,
    durable: boolean,
    snapshot: SnapshotPayload,
  ) {
    this.#configuration = configuration;
    this.#durable = durable;
    this.#snapshot = snapshot;
  }

  static async open(configuration: DirectGoalCoreConfiguration): Promise<DirectGoalCore> {
    const loaded = await readSnapshot(configuration.snapshotPath);
    const compacted = compactSnapshotAutomaticSteps(loaded);
    if (compacted !== loaded) await writeSnapshot(configuration.snapshotPath, compacted);
    return new DirectGoalCore(configuration, true, compacted);
  }

  static inMemory(configuration: DirectGoalCoreConfiguration): DirectGoalCore {
    return new DirectGoalCore(configuration, false, emptySnapshot());
  }

  create(input: DirectGoalCreateInput): Promise<DirectGoalView> {
    const validated = validateCreateInput(input);
    return this.#mutate((snapshot) => {
      const ownerDigest = digest(validated.authorizationBinding);
      const active = snapshot.goals.filter(
        (goal) => goal.ownerDigest === ownerDigest && goal.state === "active",
      );
      if (validated.idempotencyKey === undefined && active.length > 0) {
        if (active.length !== 1) throw new Error("DIRECT_GOAL_CURRENT_AMBIGUOUS");
        const current = active[0] as StoredGoal;
        if (
          current.objective === validated.objective &&
          current.executionMode === "dynamic" &&
          validated.steps === undefined
        ) {
          return { snapshot, value: publicGoal(current) };
        }
        throw new Error("DIRECT_GOAL_ALREADY_ACTIVE");
      }
      const idempotencyDigest = digest(
        validated.idempotencyKey ?? this.#configuration.randomUUID(),
      );
      const existing = snapshot.goals.find(
        (goal) => goal.ownerDigest === ownerDigest && goal.idempotencyDigest === idempotencyDigest,
      );
      if (existing !== undefined) {
        if (
          existing.objective !== validated.objective ||
          (existing.executionMode === "dynamic") !== (validated.steps === undefined) ||
          (validated.steps !== undefined &&
            canonicalJson(existing.steps.filter((step) => !step.automatic).map(stepDefinition)) !==
              canonicalJson(validated.steps.map(stepDefinition)))
        ) {
          throw new Error("DIRECT_GOAL_IDEMPOTENCY_CONFLICT");
        }
        return { snapshot, value: publicGoal(existing) };
      }
      if (
        snapshot.goals.some((goal) => goal.ownerDigest === ownerDigest && goal.state === "active")
      ) {
        throw new Error("DIRECT_GOAL_ALREADY_ACTIVE");
      }
      const now = this.#now();
      const goal: StoredGoal = {
        id: this.#configuration.randomUUID(),
        ownerDigest,
        idempotencyDigest,
        objective: validated.objective,
        ...(validated.steps === undefined ? { executionMode: "dynamic" as const } : {}),
        state: "active",
        revision: 1,
        createdAtUnixMs: now,
        updatedAtUnixMs: now,
        continuation: { enabled: true },
        steps: (validated.steps ?? []).map((step) => ({
          id: step.id,
          description: step.description,
          mode: step.mode,
          allowedToolNames: [...(step.allowedToolNames ?? [])],
          state: "pending" as const,
          operationBindings: [],
          receipts: [],
        })),
      };
      const goals = [...snapshot.goals, goal];
      return {
        snapshot: { ...snapshot, revision: snapshot.revision + 1, goals },
        value: publicGoal(goal),
      };
    });
  }

  get(authorizationBinding: string, goalId?: string): Promise<DirectGoalView | undefined> {
    const ownerDigest = digest(requiredAuthorizationBinding(authorizationBinding));
    const id = goalId === undefined ? undefined : requiredIdentifier(goalId, "goalId");
    return this.#read(() => {
      const owned = this.#snapshot.goals.filter(
        (candidate) => candidate.ownerDigest === ownerDigest,
      );
      const active =
        id === undefined ? owned.filter((candidate) => candidate.state === "active") : [];
      // Older stores may contain multiple unfinished Goals. Do not silently
      // choose an objective or discard it during recovery; explicit IDs still work.
      if (active.length > 1) throw new Error("DIRECT_GOAL_CURRENT_AMBIGUOUS");
      const goal =
        id === undefined
          ? (active[0] ?? owned.at(-1))
          : owned.find((candidate) => candidate.id === id);
      return goal === undefined ? undefined : publicGoal(expireClaims(goal, this.#now()));
    });
  }

  list(
    authorizationBindings: readonly string[],
    states?: readonly DirectGoalState[],
  ): Promise<readonly DirectGoalView[]> {
    const owners = new Set(
      authorizationBindings.map((binding) => digest(requiredAuthorizationBinding(binding))),
    );
    const selectedStates = states === undefined ? undefined : new Set(states);
    if (
      selectedStates !== undefined &&
      [...selectedStates].some(
        (state) =>
          state !== "active" && state !== "paused" && state !== "completed" && state !== "blocked",
      )
    )
      throw new Error("DIRECT_GOAL_STATUS_INVALID");
    return this.#read(() =>
      this.#snapshot.goals
        .filter(
          (goal) =>
            owners.has(goal.ownerDigest) &&
            (selectedStates === undefined || selectedStates.has(goal.state)),
        )
        .sort(
          (left, right) =>
            right.updatedAtUnixMs - left.updatedAtUnixMs || left.id.localeCompare(right.id),
        )
        .map((goal) => publicGoal(expireClaims(goal, this.#now()))),
    );
  }

  resolveManagementTarget(
    authorizationBindings: readonly string[],
    selector: DirectGoalManagementSelector,
  ): Promise<DirectGoalManagementTarget | undefined> {
    const id =
      selector.goalId === undefined ? undefined : requiredIdentifier(selector.goalId, "goalId");
    const url =
      selector.conversationUrl === undefined
        ? undefined
        : normalizeChatGptConversationUrl(selector.conversationUrl);
    if (selector.conversationUrl !== undefined && url === undefined)
      throw new Error("DIRECT_GOAL_CONVERSATION_INVALID");
    if (id === undefined && url === undefined)
      throw new Error("DIRECT_GOAL_MANAGEMENT_TARGET_REQUIRED");
    const bindings = new Map(
      authorizationBindings.map((binding) => [
        digest(requiredAuthorizationBinding(binding)),
        binding,
      ]),
    );
    return this.#read(() => {
      const candidates = this.#snapshot.goals.filter(
        (goal) =>
          bindings.has(goal.ownerDigest) &&
          (id === undefined || goal.id === id) &&
          (url === undefined ||
            normalizeChatGptConversationUrl(goal.continuation?.conversationUrl) === url),
      );
      if (id !== undefined && url === undefined && candidates.length === 0) {
        const deleted = (this.#snapshot.deletions ?? []).filter(
          (entry) => entry.goalId === id && bindings.has(entry.ownerDigest),
        );
        if (deleted.length > 1) throw new Error("DIRECT_GOAL_MANAGEMENT_TARGET_AMBIGUOUS");
        const entry = deleted[0];
        return entry === undefined
          ? undefined
          : { authorizationBinding: bindings.get(entry.ownerDigest) as string, goalId: id };
      }
      if (new Set(candidates.map((goal) => goal.ownerDigest)).size > 1)
        throw new Error("DIRECT_GOAL_MANAGEMENT_TARGET_AMBIGUOUS");
      const active = candidates.filter((goal) => goal.state === "active");
      if (id === undefined && active.length > 1)
        throw new Error("DIRECT_GOAL_MANAGEMENT_TARGET_AMBIGUOUS");
      const selected = id === undefined ? (active[0] ?? candidates.at(-1)) : candidates[0];
      return selected === undefined
        ? undefined
        : {
            authorizationBinding: bindings.get(selected.ownerDigest) as string,
            goalId: selected.id,
          };
    });
  }

  /** Called only by the connector-owned host observer, never exposed as an MCP mutation. */
  observeConversation(observation: OracleGoalConversation): Promise<void> {
    return this.#observeConversation(observation, false);
  }

  /** A verified native final may advance an already bound Goal without inventing a new tool result. */
  observeBoundDesktopFinal(
    observation: Pick<OracleGoalConversation, "conversationUrl" | "current"> & {
      readonly source: NonNullable<OracleGoalConversation["source"]>;
    },
  ): Promise<void> {
    return this.#observeConversation({ ...observation, goals: [] }, true);
  }

  async #observeConversation(
    observation: OracleGoalConversation,
    alreadyBound: boolean,
  ): Promise<void> {
    const conversationUrl = normalizeChatGptConversationUrl(observation.conversationUrl);
    if (conversationUrl === undefined) throw new Error("DIRECT_GOAL_CONVERSATION_INVALID");
    if (
      observation.source !== undefined &&
      ((observation.source.kind !== "desktop" && observation.source.kind !== "web") ||
        !/^chatgpt:[^:]+:[^:]+$/.test(observation.source.accountSourceId))
    )
      throw new Error("DIRECT_GOAL_ACCOUNT_SOURCE_INVALID");
    let awaitingReadback = false;
    await this.#mutate((snapshot) => {
      const matchedCandidates = snapshot.goals.filter(
        (goal) =>
          goal.continuation?.enabled === true &&
          (alreadyBound || observation.checkpoint?.goalId === goal.id
            ? goal.state === "active" &&
              goal.continuation.conversationUrl === conversationUrl &&
              goal.continuation.bindingMessageId !== undefined
            : observation.goals.some((result) => matchesObservedGoal(goal, result))),
      );
      const requestedCurrent =
        observation.requestedGoalId === undefined
          ? undefined
          : matchedCandidates.find(
              (goal) => goal.id === observation.requestedGoalId && goal.state === "active",
            );
      // A verified user message can disambiguate older active Goal creations
      // retained on the same native branch. Bind only that active Goal and
      // same-owner stopped history; unrelated owners remain untouched.
      const candidates =
        requestedCurrent === undefined
          ? matchedCandidates
          : matchedCandidates.filter(
              (goal) =>
                goal.id === requestedCurrent.id ||
                (goal.state !== "active" && goal.ownerDigest === requestedCurrent.ownerDigest),
            );
      const active = candidates.filter((goal) => goal.state === "active");
      const ownerCount = new Set(candidates.map((goal) => goal.ownerDigest)).size;
      if (active.length > 1 || (active.length > 0 && ownerCount > 1))
        throw new Error("DIRECT_GOAL_CONVERSATION_AMBIGUOUS");
      const current = active[0];
      let observedSnapshot = snapshot;
      const bindings = new Map<string, DirectGoalContinuation>();
      for (const candidate of candidates) {
        const previous = candidate.continuation as DirectGoalContinuation;
        if (
          observation.source !== undefined &&
          previous.accountSourceId !== undefined &&
          observation.source.accountSourceId !== previous.accountSourceId
        )
          throw new Error("DIRECT_GOAL_ACCOUNT_SOURCE_MISMATCH");
        if (previous.conversationUrl !== undefined && previous.conversationUrl !== conversationUrl)
          throw new Error("DIRECT_GOAL_CONVERSATION_MISMATCH");
        if (
          snapshot.goals.some(
            (goal) =>
              goal.id !== candidate.id &&
              goal.id !== current?.id &&
              goal.state === "active" &&
              goal.continuation?.conversationUrl === conversationUrl,
          )
        )
          throw new Error("DIRECT_GOAL_CONVERSATION_ALREADY_BOUND");
        const origin = observation.goals.find((result) => matchesObservedGoal(candidate, result));
        const provenance = observation.goals.find(
          (result) =>
            matchesObservedGoal(candidate, result) &&
            result.messageId === (previous.bindingMessageId ?? origin?.messageId),
        );
        const connectorId =
          observation.source?.kind === "web" ? provenance?.connectorId : undefined;
        if (connectorId !== undefined && !/^asdk_app_[a-z0-9]+$/i.test(connectorId))
          throw new Error("DIRECT_GOAL_CONNECTOR_INVALID");
        if (
          connectorId !== undefined &&
          previous.connectorId !== undefined &&
          previous.connectorId !== connectorId
        )
          throw new Error("DIRECT_GOAL_CONNECTOR_MISMATCH");
        const binding: DirectGoalContinuation = {
          ...previous,
          ...(connectorId === undefined ? {} : { connectorId }),
          conversationUrl,
          ...(observation.source === undefined
            ? {}
            : { accountSourceId: observation.source.accountSourceId }),
          bindingMessageId:
            previous.bindingMessageId ??
            requiredIdentifier(origin?.messageId as string, "goal origin message"),
        };
        bindings.set(candidate.id, binding);
        // Historical creation results bind stopped Goals without observing finals
        // or preventing the current active Goal from processing this transcript.
        if (candidate.state !== "active")
          observedSnapshot = replaceGoal(observedSnapshot, snapshot.goals.indexOf(candidate), {
            ...candidate,
            continuation: binding,
            revision: candidate.revision + 1,
            updatedAtUnixMs: this.#now(),
          });
      }
      if (current === undefined) return { snapshot: observedSnapshot, value: undefined };
      const continuation = current.continuation as DirectGoalContinuation;
      let next = bindings.get(current.id) as DirectGoalContinuation;
      const turn = observation.current;
      const observedFinals = new Set(next.observedFinalMessageIds ?? []);
      if (next.settledMessageId !== undefined) observedFinals.add(next.settledMessageId);
      if (next.draft !== undefined) observedFinals.add(next.draft.afterMessageId);
      const ancestors = turn?.ancestorMessageIds;
      if (
        ancestors !== undefined &&
        (!Array.isArray(ancestors) ||
          ancestors.some((id) => typeof id !== "string" || !id || id === turn?.id) ||
          new Set(ancestors).size !== ancestors.length)
      )
        throw new Error("DIRECT_GOAL_ANCESTRY_INVALID");
      const checkpoint = next.settledMessageId ?? next.draft?.afterMessageId;
      const revisionMatches =
        observation.checkpoint === undefined ||
        (observation.checkpoint.goalId === current.id &&
          observation.checkpoint.revision === current.revision &&
          observation.checkpoint.settledMessageId === continuation.settledMessageId);
      const knownAncestor =
        turn !== undefined && next.settledAncestorMessageIds?.includes(turn.id) === true;
      // Editing a ChatGPT message can replace the native branch and remove the
      // former continuation checkpoint from its ancestry. A user can
      // deliberately keep the same Goal on that new branch by naming its id.
      // Accept that branch reset only when the current projection also carries
      // an exact, locally matching Goal result; a bare id mention or a desktop
      // final readback cannot bypass the causal checkpoint.
      const explicitlyReselectedCurrentGoal =
        observation.requestedGoalId === current.id &&
        observation.goals.some((result) => matchesObservedGoal(current, result));
      // Once a conversation is bound to one active Goal, its locally captured
      // checkpoint keeps ordinary follow-up messages on that Goal even when
      // the user does not repeat the Goal UUID in every message.
      const continuesCurrentGoal =
        observation.requestedGoalId === current.id || observation.checkpoint?.goalId === current.id;
      const followsCheckpoint =
        revisionMatches &&
        (checkpoint === undefined ||
          ancestors?.includes(checkpoint) === true ||
          explicitlyReselectedCurrentGoal);
      const final =
        turn?.authorRole === "assistant" &&
        turn.status === "finished_successfully" &&
        turn.endTurn === true &&
        (turn.channel === undefined || turn.channel === "final");
      if (final && !observedFinals.has(turn.id) && !knownAncestor && !followsCheckpoint) {
        awaitingReadback = true;
        next = {
          ...next,
          pendingFinalMessageIds: [...new Set([...(next.pendingFinalMessageIds ?? []), turn.id])],
        };
      }
      // A successful final response is a turn boundary, never Goal completion.
      // Uncertain or still-running native operations must resolve before waking Pro.
      if (
        turn?.authorRole === "assistant" &&
        turn.status === "finished_successfully" &&
        turn.endTurn === true &&
        (turn.channel === undefined || turn.channel === "final") &&
        !observedFinals.has(turn.id) &&
        !knownAncestor &&
        followsCheckpoint
      ) {
        observedFinals.add(turn.id);
        const {
          settledTransport: _oldSettledTransport,
          pendingFinalMessageIds: _pendingFinals,
          settledAncestorMessageIds: _oldAncestors,
          ...previous
        } = next;
        next = {
          ...previous,
          settledMessageId: turn.id,
          ...(ancestors === undefined ? {} : { settledAncestorMessageIds: [...ancestors] }),
          ...(observation.source?.kind === "desktop"
            ? { settledTransport: "desktop" as const }
            : {}),
          observedFinalMessageIds: [...observedFinals],
        };
        if (next.draft?.state !== "dispatching")
          next = {
            ...next,
            draft: {
              token: this.#configuration.randomUUID(),
              afterMessageId: turn.id,
              state: "ready",
              ...(observation.source?.kind === "desktop" ? { transport: "desktop" as const } : {}),
            },
          };
      }
      // A submitted Goal-selection message can persist without starting a
      // model turn. Only the independently verified native idle status permits
      // the controller to append its recovery prompt; an active task never
      // creates this draft.
      if (
        observation.nativeTaskStatus === "idle" &&
        continuesCurrentGoal &&
        turn?.authorRole === "user" &&
        turn.status === "finished_successfully" &&
        !observedFinals.has(turn.id) &&
        !knownAncestor &&
        followsCheckpoint
      ) {
        next = {
          ...next,
          draft: {
            token: this.#configuration.randomUUID(),
            afterMessageId: turn.id,
            state: "ready",
            resumeIdleUserTurn: true,
          },
        };
      }
      // A Web response can finish its tool work and leave a successful
      // assistant analysis/tool node as the native branch head without ever
      // writing a final response. Treat it as running until the independently
      // observed local task is idle; the foreground settle window is applied
      // before the daemon supplies that idle status.
      if (
        observation.source?.kind === "web" &&
        observation.nativeTaskStatus === "idle" &&
        continuesCurrentGoal &&
        turn?.authorRole === "assistant" &&
        turn.status === "finished_successfully" &&
        turn.endTurn !== true &&
        !observedFinals.has(turn.id) &&
        !knownAncestor &&
        followsCheckpoint
      ) {
        next = {
          ...next,
          draft: {
            token: this.#configuration.randomUUID(),
            afterMessageId: turn.id,
            state: "ready",
            resumeIdleIncompleteTurn: true,
          },
        };
      }
      // A fresh read of the same verified head resolves a delayed candidate
      // without advancing or replacing the existing dispatch identity.
      if (
        final &&
        turn.id === checkpoint &&
        revisionMatches &&
        ancestors !== undefined &&
        next.pendingFinalMessageIds !== undefined
      ) {
        const { pendingFinalMessageIds: _pendingFinals, ...resolved } = next;
        next = { ...resolved, settledAncestorMessageIds: [...ancestors] };
      }
      awaitingReadback = next.pendingFinalMessageIds !== undefined;
      if (canonicalJson(next) === canonicalJson(continuation))
        return { snapshot: observedSnapshot, value: undefined };
      const updated = {
        ...current,
        continuation: next,
        revision: current.revision + 1,
        updatedAtUnixMs: this.#now(),
      };
      return {
        snapshot: replaceGoal(observedSnapshot, snapshot.goals.indexOf(current), updated),
        value: undefined,
      };
    });
    if (awaitingReadback) throw new Error("DIRECT_GOAL_CAUSAL_READBACK_REQUIRED");
  }

  continuationConversationUrls(
    accountSourceId?: string,
    connectorId?: string,
  ): Promise<readonly string[]> {
    return this.#read(() => [
      ...new Set(
        this.#snapshot.goals.flatMap((goal) =>
          goal.state === "active" &&
          goal.continuation?.enabled === true &&
          goal.continuation.draft?.state !== "cancelled" &&
          (accountSourceId === undefined ||
            goal.continuation.accountSourceId === undefined ||
            goal.continuation.accountSourceId === accountSourceId) &&
          (connectorId === undefined ||
            goal.continuation.connectorId === undefined ||
            goal.continuation.connectorId === connectorId) &&
          goal.continuation.conversationUrl !== undefined
            ? [goal.continuation.conversationUrl]
            : [],
        ),
      ),
    ]);
  }

  continuationCheckpoints(
    accountSourceId?: string,
    connectorId?: string,
  ): Promise<
    readonly {
      conversationUrl: string;
      checkpoint: NonNullable<OracleGoalConversation["checkpoint"]>;
    }[]
  > {
    return this.#read(() =>
      this.#snapshot.goals.flatMap((goal) => {
        const continuation = goal.continuation;
        return goal.state === "active" &&
          continuation?.conversationUrl !== undefined &&
          (accountSourceId === undefined ||
            continuation.accountSourceId === undefined ||
            continuation.accountSourceId === accountSourceId) &&
          continuation.bindingMessageId !== undefined &&
          (connectorId === undefined || continuation.connectorId === connectorId)
          ? [
              {
                conversationUrl: continuation.conversationUrl,
                checkpoint: {
                  goalId: goal.id,
                  revision: goal.revision,
                  ...(continuation.settledMessageId === undefined
                    ? {}
                    : { settledMessageId: continuation.settledMessageId }),
                },
              },
            ]
          : [];
      }),
    );
  }

  hasUnboundContinuation(_options: { readonly activeOnly?: boolean } = {}): Promise<boolean> {
    return this.#read(() =>
      this.#snapshot.goals.some(
        (goal) =>
          goal.state === "active" &&
          goal.continuation?.enabled === true &&
          goal.continuation.conversationUrl === undefined,
      ),
    );
  }

  hasObservedGoalCandidate(
    results: OracleGoalConversation["goals"],
    options: { readonly unboundOnly?: boolean } = {},
  ): Promise<boolean> {
    return this.#read(() =>
      this.#snapshot.goals.some(
        (goal) =>
          goal.state === "active" &&
          goal.continuation?.enabled === true &&
          (!options.unboundOnly || goal.continuation.bindingMessageId === undefined) &&
          results.some((result) => matchesObservedGoal(goal, result)),
      ),
    );
  }

  pendingContinuations(): Promise<readonly DirectGoalContinuationWork[]> {
    return this.#read(() =>
      this.#snapshot.goals
        .slice()
        .sort(
          (left, right) =>
            right.updatedAtUnixMs - left.updatedAtUnixMs || right.id.localeCompare(left.id, "en"),
        )
        .flatMap((goal) => {
          const continuation = goal.continuation;
          const draft = continuation?.draft;
          const workSessionBindingSha256s = [
            ...new Set(
              goal.steps
                .slice(-64)
                .flatMap((step) => [
                  ...(step.claim === undefined ? [] : [step.claim.claimantDigest]),
                  ...(step.reservation === undefined ? [] : [step.reservation.claimantDigest]),
                ]),
            ),
          ];
          return goal.state === "active" &&
            continuation?.conversationUrl !== undefined &&
            draft !== undefined &&
            (continuation.pendingFinalMessageIds === undefined || draft.state === "dispatching") &&
            (draft.state === "ready" || draft.state === "prepared" || draft.state === "dispatching")
            ? [
                {
                  goalId: goal.id,
                  conversationUrl: continuation.conversationUrl,
                  ...(workSessionBindingSha256s.length === 0 ? {} : { workSessionBindingSha256s }),
                  ...(continuation.connectorId === undefined
                    ? {}
                    : { connectorId: continuation.connectorId }),
                  ...(continuation.accountSourceId === undefined
                    ? {}
                    : { accountSourceId: continuation.accountSourceId }),
                  draft: {
                    ...draft,
                    ...(draft.nativeReceipt === undefined
                      ? {}
                      : { nativeReceipt: { ...draft.nativeReceipt } }),
                  },
                },
              ]
            : [];
        }),
    );
  }

  canDispatchContinuation(work: DirectGoalContinuationWork): Promise<boolean> {
    return this.#read(() => {
      const goal = this.#snapshot.goals.find((item) => item.id === work.goalId);
      const continuation = goal?.continuation;
      const draft = continuation?.draft;
      return (
        goal?.state === "active" &&
        continuation?.conversationUrl === work.conversationUrl &&
        continuation?.accountSourceId === work.accountSourceId &&
        continuation?.pendingFinalMessageIds === undefined &&
        draft?.token === work.draft.token &&
        draft?.afterMessageId === work.draft.afterMessageId &&
        draft?.state === "dispatching" &&
        draft?.nativeReceipt === undefined
      );
    });
  }

  transitionContinuation(
    work: DirectGoalContinuationWork,
    state: "dispatching" | "ready" | "prepared" | "sent" | "cancelled",
  ): Promise<boolean> {
    return this.#mutate((snapshot) => {
      const index = snapshot.goals.findIndex(
        (goal) =>
          goal.id === work.goalId && goal.continuation?.conversationUrl === work.conversationUrl,
      );
      const goal = snapshot.goals[index];
      const continuation = goal?.continuation;
      const draft = continuation?.draft;
      if (
        goal === undefined ||
        (goal.state !== "active" && (draft?.state !== "dispatching" || state === "dispatching")) ||
        continuation === undefined ||
        draft === undefined ||
        draft.token !== work.draft.token ||
        draft.state !== work.draft.state
      )
        return { snapshot, value: false };
      if (
        (state === "dispatching" && continuation.pendingFinalMessageIds !== undefined) ||
        (state === "dispatching" && draft.state !== "ready" && draft.state !== "prepared") ||
        ((state === "ready" || state === "prepared") && draft.state !== "dispatching")
      )
        return { snapshot, value: false };
      if (state === draft.state) return { snapshot, value: true };
      const next = {
        ...goal,
        continuation: {
          ...continuation,
          draft:
            // A newer completion can arrive while this dispatch is unresolved.
            // Once its outcome is known, retain that completion for every
            // resolution, including a superseded/rejected older send. Its ID
            // is already deduplicated, so waiting for another event loses it.
            state !== "dispatching" &&
            continuation.settledMessageId !== undefined &&
            continuation.settledMessageId !== draft.afterMessageId
              ? {
                  token: this.#configuration.randomUUID(),
                  afterMessageId: continuation.settledMessageId,
                  state: "ready" as const,
                  ...(continuation.settledTransport === undefined
                    ? {}
                    : { transport: continuation.settledTransport }),
                }
              : { ...draft, state },
        },
        revision: goal.revision + 1,
        updatedAtUnixMs: this.#now(),
      };
      return { snapshot: replaceGoal(snapshot, index, next), value: true };
    });
  }

  recordNativeContinuationReceipt(
    work: DirectGoalContinuationWork,
    receipt: DirectGoalNativeSendReceipt,
  ): Promise<boolean> {
    return this.#mutate((snapshot) => {
      const index = snapshot.goals.findIndex((goal) => goal.id === work.goalId);
      const goal = snapshot.goals[index];
      const continuation = goal?.continuation;
      const draft = continuation?.draft;
      if (
        goal === undefined ||
        continuation === undefined ||
        draft === undefined ||
        continuation.conversationUrl !== work.conversationUrl ||
        continuation.accountSourceId !== work.accountSourceId ||
        draft.token !== work.draft.token ||
        draft.state !== "dispatching" ||
        draft.transport !== "desktop"
      )
        return { snapshot, value: false };
      assertNativeContinuationReceipt(
        receipt,
        draft.token,
        continuation.conversationUrl,
        continuation.accountSourceId,
      );
      if (draft.nativeReceipt !== undefined) {
        const previous = draft.nativeReceipt;
        if (
          previous.kind === "native_message_prepared" &&
          receipt.kind === "native_message_prepared" &&
          previous.dispatchState !== receipt.dispatchState &&
          canonicalJson({ ...previous, dispatchState: receipt.dispatchState }) ===
            canonicalJson(receipt)
        ) {
          return {
            snapshot: replaceGoal(snapshot, index, {
              ...goal,
              revision: goal.revision + 1,
              updatedAtUnixMs: this.#now(),
              continuation: { ...continuation, draft: { ...draft, nativeReceipt: { ...receipt } } },
            }),
            value: true,
          };
        }
        if (canonicalJson(draft.nativeReceipt) !== canonicalJson(receipt))
          throw new Error("DIRECT_GOAL_NATIVE_RECEIPT_CONFLICT");
        if (receipt.kind === "native_message_prepared" && receipt.dispatchState === "dispatching")
          return { snapshot, value: false };
        return { snapshot, value: true };
      }
      return {
        snapshot: replaceGoal(snapshot, index, {
          ...goal,
          revision: goal.revision + 1,
          updatedAtUnixMs: this.#now(),
          continuation: { ...continuation, draft: { ...draft, nativeReceipt: { ...receipt } } },
        }),
        value: true,
      };
    });
  }

  claimNext(input: DirectGoalClaimInput): Promise<DirectGoalClaimView | undefined> {
    const ownerDigest = digest(requiredAuthorizationBinding(input.authorizationBinding));
    const claimantDigest = digest(requiredText(input.claimantBinding, "claimantBinding"));
    const goalId = requiredIdentifier(input.goalId, "goalId");
    const leaseMs = boundedLease(input.leaseMs);
    return this.#mutate((snapshot) => {
      const now = this.#now();
      const liveClaims = pendingClaimsForClaimant(snapshot, ownerDigest, claimantDigest, now);
      if (liveClaims.length > 0) {
        const renewable = liveClaims.find(
          ({ goal, step }) =>
            goal.id === goalId &&
            step.state === "awaiting_readback" &&
            step.reservation === undefined,
        );
        if (liveClaims.length !== 1 || renewable === undefined) {
          throw new Error("DIRECT_GOAL_CLAIMANT_ALREADY_HAS_PENDING_STEP");
        }
        const index = goalIndex(snapshot, ownerDigest, goalId);
        const current = expireClaims(snapshot.goals[index] as StoredGoal, now);
        const stepIndex = current.steps.findIndex((step) => step.id === renewable.step.id);
        if (stepIndex < 0) throw new Error("DIRECT_GOAL_STEP_NOT_FOUND");
        const step = current.steps[stepIndex] as StoredStep;
        const claimToken = this.#configuration.randomBytes(32).toString("base64url");
        const expiresAtUnixMs = checkedDeadline(now, leaseMs, "Direct Goal claim lease");
        const renewed: StoredStep = {
          ...step,
          claim: {
            claimantDigest,
            tokenDigest: digest(claimToken),
            expiresAtUnixMs,
          },
        };
        const next = updateGoal(current, now, replaceAt(current.steps, stepIndex, renewed));
        return {
          snapshot: replaceGoal(snapshot, index, next),
          value: {
            goal: publicGoal(next),
            step: publicStep(renewed),
            claimToken,
            claimExpiresAtUnixMs: expiresAtUnixMs,
          },
        };
      }
      const index = goalIndex(snapshot, ownerDigest, goalId);
      const current = expireClaims(snapshot.goals[index] as StoredGoal, now);
      if (current.state !== "active") return { snapshot, value: undefined };
      const stepIndex = current.steps.findIndex(
        (step) =>
          !step.automatic &&
          (step.state === "pending" ||
            (step.state === "awaiting_readback" && step.claim === undefined)),
      );
      if (stepIndex < 0) return { snapshot, value: undefined };
      const step = current.steps[stepIndex] as StoredStep;
      const claimToken = this.#configuration.randomBytes(32).toString("base64url");
      const expiresAtUnixMs = checkedDeadline(now, leaseMs, "Direct Goal claim lease");
      const claimed: StoredStep = {
        ...step,
        state: step.state === "awaiting_readback" ? "awaiting_readback" : "claimed",
        claim: {
          claimantDigest,
          tokenDigest: digest(claimToken),
          expiresAtUnixMs,
        },
      };
      const next = updateGoal(current, now, replaceAt(current.steps, stepIndex, claimed));
      const nextSnapshot = replaceGoal(snapshot, index, next);
      return {
        snapshot: nextSnapshot,
        value: {
          goal: publicGoal(next),
          step: publicStep(claimed),
          claimToken,
          claimExpiresAtUnixMs: expiresAtUnixMs,
        },
      };
    });
  }

  /** Resolve only an eligible claim belonging to this exact owner/work-session claimant. */
  async resolveUnknownExecutionReadback(
    input: DirectGoalUnknownExecutionReadbackInput,
  ): Promise<DirectGoalUnknownExecutionReadbackContext | undefined> {
    assertUnknownExecutionReadbackInput(input);
    const ownerDigest = digest(requiredAuthorizationBinding(input.authorizationBinding));
    const claimantDigest = digest(requiredText(input.claimantBinding, "claimantBinding"));
    const resourceDigest = requiredDigest(input.resourceDigest, "resourceDigest");
    return this.#read(() => {
      const candidates: DirectGoalUnknownExecutionReadbackContext[] = [];
      for (const goal of this.#snapshot.goals) {
        if (goal.ownerDigest !== ownerDigest || goal.state !== "active") continue;
        for (const step of goal.steps) {
          const reservation = step.reservation;
          if (
            step.automatic !== true ||
            step.mode !== "successful_call" ||
            step.state !== "claimed" ||
            reservation === undefined ||
            reservation.role !== "work" ||
            reservation.state === "prepared" ||
            reservation.stateEffect !== "mutate" ||
            reservation.claimantDigest !== claimantDigest ||
            reservation.resourceDigest !== resourceDigest
          ) {
            continue;
          }
          candidates.push({
            goalId: goal.id,
            stepId: step.id,
            operationId: reservation.operationId,
            resourceDigest,
          });
        }
      }
      if (candidates.length > 1) {
        throw new Error("DIRECT_GOAL_UNKNOWN_EXECUTION_READBACK_AMBIGUOUS");
      }
      return candidates[0];
    });
  }

  async finalizeUnknownExecutionReadback(
    input: DirectGoalUnknownExecutionReadbackFinalizeInput,
  ): Promise<DirectGoalUnknownExecutionReadbackView | undefined> {
    assertUnknownExecutionReadbackInput(input);
    const ownerDigest = digest(requiredAuthorizationBinding(input.authorizationBinding));
    const claimantDigest = digest(requiredText(input.claimantBinding, "claimantBinding"));
    const resourceDigest = requiredDigest(input.resourceDigest, "resourceDigest");
    const goalId = requiredIdentifier(input.context.goalId, "goalId");
    const stepId = requiredIdentifier(input.context.stepId, "stepId");
    const recoveredOperationId = requiredIdentifier(input.context.operationId, "operationId");
    const contextResourceDigest = requiredDigest(
      input.context.resourceDigest,
      "context.resourceDigest",
    );
    const proofOperationId = requiredIdentifier(input.proofOperationId, "proofOperationId");
    const proofToolName = requiredIdentifier(input.proofToolName, "proofToolName");
    const proofTargetIdentity = requiredOpaqueIdentity(
      input.proofTargetIdentity,
      "proofTargetIdentity",
    );
    const proofResultDigest = requiredDigest(input.proofResultDigest, "proofResultDigest");
    if (contextResourceDigest !== resourceDigest || proofOperationId === recoveredOperationId) {
      throw new Error("DIRECT_GOAL_UNKNOWN_EXECUTION_READBACK_CONTEXT_INVALID");
    }
    return this.#mutate((snapshot) => {
      if (findOwnerOperation(snapshot, ownerDigest, proofOperationId) !== undefined) {
        throw new Error("DIRECT_GOAL_OPERATION_ID_CONFLICT");
      }
      const existing = findOwnerOperation(snapshot, ownerDigest, recoveredOperationId);
      if (existing?.kind !== "reservation") return { snapshot, value: undefined };
      const goal = snapshot.goals[existing.goalIndex] as StoredGoal;
      const step = goal.steps[existing.stepIndex] as StoredStep;
      const reservation = existing.reservation;
      if (
        goal.id !== goalId ||
        goal.state !== "active" ||
        step.id !== stepId ||
        step.automatic !== true ||
        step.mode !== "successful_call" ||
        step.state !== "claimed" ||
        reservation.role !== "work" ||
        reservation.state === "prepared" ||
        reservation.stateEffect !== "mutate" ||
        reservation.claimantDigest !== claimantDigest ||
        reservation.resourceDigest !== resourceDigest
      ) {
        throw new Error("DIRECT_GOAL_UNKNOWN_EXECUTION_READBACK_STALE");
      }
      const now = this.#now();
      const proofBindingDigest = executionBindingDigestFromParts({
        ownerDigest,
        claimantDigest,
        claimTokenDigest: reservation.claimTokenDigest,
        goalId,
        stepId,
        operationId: proofOperationId,
        role: "work",
        toolName: proofToolName,
        targetIdentity: proofTargetIdentity,
        resourceDigest,
        stateEffect: "read",
        modelEffect: "none",
      });
      const proofBinding: StoredOperationBinding = {
        operationId: proofOperationId,
        executionBindingDigest: proofBindingDigest,
        boundAtUnixMs: now,
      };
      const proofReceipt: StoredReceipt = {
        operationId: proofOperationId,
        role: "work",
        toolName: proofToolName,
        targetIdentity: proofTargetIdentity,
        resourceDigest,
        resultDigest: proofResultDigest,
        stateEffect: "read",
        executionBindingDigest: proofBindingDigest,
        recordedAtUnixMs: now,
      };
      const recoveredStep = applyReceipt(
        { ...step, operationBindings: [...step.operationBindings, proofBinding] },
        proofReceipt,
      );
      const next = updateGoal(goal, now, replaceAt(goal.steps, existing.stepIndex, recoveredStep));
      return {
        snapshot: replaceGoal(snapshot, existing.goalIndex, next),
        value: {
          goal: publicGoal(next),
          recoveredOperationId,
          proofOperationId,
        },
      };
    });
  }

  async resolvePendingExecution(
    input: DirectGoalPendingExecutionInput,
  ): Promise<DirectGoalPendingExecutionContext | undefined> {
    const ownerDigest = digest(requiredAuthorizationBinding(input.authorizationBinding));
    const claimantDigest = digest(requiredText(input.claimantBinding, "claimantBinding"));
    const toolName = requiredIdentifier(input.toolName, "toolName");
    const resourceDigest = requiredDigest(input.resourceDigest, "resourceDigest");
    const stateEffect = input.stateEffect;
    const modelEffect = input.modelEffect;
    const operationId =
      input.operationId === undefined
        ? undefined
        : requiredIdentifier(input.operationId, "operationId");
    if (operationId === undefined && input.includeDynamic !== false) {
      const dynamic = await this.#mutate<DirectGoalPendingExecutionContext | undefined>(
        (snapshot) => {
          const owned = snapshot.goals.filter(
            (goal) => goal.ownerDigest === ownerDigest && goal.state === "active",
          );
          if (owned.length > 1) throw new Error("DIRECT_GOAL_CURRENT_AMBIGUOUS");
          const current = owned[0];
          if (current === undefined) {
            return { snapshot, value: undefined };
          }
          const now = this.#now();
          const goal = expireClaims(current, now);
          const reusable = goal.steps.findIndex(
            (step) =>
              (step.automatic === true || goal.executionMode === "dynamic") &&
              step.state === "pending" &&
              step.reservation === undefined &&
              step.claim === undefined,
          );
          const tokenDigest = digest(this.#configuration.randomBytes(32).toString("base64url"));
          const step: StoredStep = {
            ...(reusable < 0
              ? { id: this.#configuration.randomUUID(), operationBindings: [], receipts: [] }
              : (goal.steps[reusable] as StoredStep)),
            automatic: true,
            description: toolName,
            mode: "successful_call",
            allowedToolNames: [],
            state: "claimed",
            claim: {
              claimantDigest,
              tokenDigest,
              expiresAtUnixMs: checkedDeadline(now, DEFAULT_LEASE_MS, "Direct Goal claim lease"),
            },
          };
          const next = updateGoal(
            goal,
            now,
            reusable < 0 ? [...goal.steps, step] : replaceAt(goal.steps, reusable, step),
          );
          return {
            snapshot: replaceGoal(snapshot, goalIndex(snapshot, ownerDigest, goal.id), next),
            value: {
              goalId: goal.id,
              stepId: step.id,
              claimTokenDigest: tokenDigest,
              role: "work",
            },
          };
        },
      );
      if (dynamic !== undefined) return dynamic;
    }
    return this.#read(() => {
      if (operationId !== undefined) {
        const existing = findOwnerOperation(this.#snapshot, ownerDigest, operationId);
        if (existing?.kind !== "reservation") return undefined;
        const reservation = existing.reservation;
        const goal = this.#snapshot.goals[existing.goalIndex] as StoredGoal;
        if (
          reservation.state === "prepared" ||
          reservation.claimantDigest !== claimantDigest ||
          reservation.toolName !== toolName ||
          reservation.resourceDigest !== resourceDigest ||
          reservation.stateEffect !== stateEffect ||
          reservation.modelEffect !== modelEffect
        )
          return undefined;
        return {
          goalId: goal.id,
          stepId: (goal.steps[existing.stepIndex] as StoredStep).id,
          claimTokenDigest: reservation.claimTokenDigest,
          role: reservation.role,
          ...(reservation.provesOperationId === undefined
            ? {}
            : { provesOperationId: reservation.provesOperationId }),
        };
      }
      // Reference-step claims never select or restrict an ordinary native call.
      // Replay acquisition happens before allocating its own execution record.
      return undefined;
    });
  }

  async discardUnreservedDynamicClaim(input: DirectGoalExecutionReservationInput): Promise<void> {
    const validated = validateExecutionAuthorizationInput(input);
    const ownerDigest = digest(validated.authorizationBinding);
    const claimantDigest = digest(validated.claimantBinding);
    await this.#mutate((snapshot) => {
      const index = snapshot.goals.findIndex(
        (goal) => goal.id === validated.goalId && goal.ownerDigest === ownerDigest,
      );
      const goal = snapshot.goals[index];
      if (goal === undefined) return { snapshot, value: undefined };
      const step = goal.steps.find((candidate) => candidate.id === validated.stepId);
      // Only this caller's never-reserved allocation can be rolled back. Keep
      // successful receipts, failed attempts and every ambiguous operation fence.
      if (
        (step?.automatic !== true && goal.executionMode !== "dynamic") ||
        step?.claim?.claimantDigest !== claimantDigest ||
        step.claim.tokenDigest !== validated.claimTokenDigest ||
        step.reservation !== undefined ||
        step.operationBindings.length !== 0 ||
        step.receipts.length !== 0
      )
        return { snapshot, value: undefined };
      const next = updateGoal(
        goal,
        this.#now(),
        goal.steps.filter((candidate) => candidate.id !== step.id),
      );
      return { snapshot: replaceGoal(snapshot, index, next), value: undefined };
    });
  }

  beginExecution(
    input: DirectGoalExecutionReservationInput,
  ): Promise<DirectGoalExecutionReservationView> {
    const validated = validateExecutionAuthorizationInput(input);
    const ownerDigest = digest(validated.authorizationBinding);
    const claimantDigest = digest(validated.claimantBinding);
    const claimTokenDigest = validated.claimTokenDigest;
    const executionBindingDigest = executionBindingDigestFrom(
      ownerDigest,
      claimantDigest,
      claimTokenDigest,
      validated,
    );
    return this.#mutate((snapshot) => {
      const existing = findOwnerOperation(snapshot, ownerDigest, validated.operationId);
      if (existing !== undefined) {
        if (existing.executionBindingDigest !== executionBindingDigest) {
          throw new Error("DIRECT_GOAL_OPERATION_ID_CONFLICT");
        }
        if (existing.kind === "receipt") {
          return {
            snapshot,
            value: publicExecutionReservation(existing.receipt, "finalized"),
          };
        }
        if (existing.kind === "reservation") {
          return {
            snapshot,
            value: publicExecutionReservation(
              existing.reservation,
              existing.reservation.state === "prepared" ? "joined" : "recovery_required",
            ),
          };
        }
      }
      const index = existing?.goalIndex ?? goalIndex(snapshot, ownerDigest, validated.goalId);
      const now = this.#now();
      const current = expireClaims(snapshot.goals[index] as StoredGoal, now);
      const stepIndex = current.steps.findIndex((step) => step.id === validated.stepId);
      if (stepIndex < 0) throw new Error("DIRECT_GOAL_STEP_NOT_FOUND");
      const step = current.steps[stepIndex] as StoredStep;
      if (current.state !== "active" && !step.automatic)
        throw new Error(
          current.state === "blocked" ? "DIRECT_GOAL_NOT_ACTIVE" : "DIRECT_GOAL_ALREADY_COMPLETED",
        );
      if (step.reservation !== undefined) {
        throw new Error("DIRECT_GOAL_STEP_EXECUTION_RESERVED");
      }
      assertExecutionAdmitted(step, claimantDigest, validated, now);
      const reservation: StoredReservation = {
        operationId: validated.operationId,
        executionBindingDigest,
        claimantDigest,
        claimTokenDigest,
        role: validated.role,
        toolName: validated.toolName,
        targetIdentity: validated.targetIdentity,
        resourceDigest: validated.resourceDigest,
        stateEffect: validated.stateEffect,
        modelEffect: validated.modelEffect,
        state: "prepared",
        preparedAtUnixMs: now,
        ...(validated.provesOperationId === undefined
          ? {}
          : { provesOperationId: validated.provesOperationId }),
      };
      const reservedStep = {
        ...step,
        reservation,
        operationBindings:
          existing?.kind === "binding"
            ? step.operationBindings
            : [
                ...step.operationBindings,
                {
                  operationId: validated.operationId,
                  executionBindingDigest,
                  boundAtUnixMs: now,
                },
              ],
      };
      const next = updateGoal(current, now, replaceAt(current.steps, stepIndex, reservedStep));
      return {
        snapshot: replaceGoal(snapshot, index, next),
        value: publicExecutionReservation(reservation, "created"),
      };
    });
  }

  markExecutionDispatched(
    input: DirectGoalExecutionReservationInput,
  ): Promise<DirectGoalExecutionReservationView> {
    return this.#mutateReservation(input, (reservation, _step, now) => {
      if (reservation.state !== "prepared") {
        return { reservation, value: publicExecutionReservation(reservation, "recovery_required") };
      }
      const dispatched: StoredReservation = {
        ...reservation,
        state: "dispatched",
        dispatchedAtUnixMs: now,
      };
      return { reservation: dispatched, value: publicExecutionReservation(dispatched, "updated") };
    });
  }

  abortBeforeDispatch(input: DirectGoalExecutionReservationInput): Promise<DirectGoalView> {
    return this.#mutateReservation(input, (reservation, step, now, goal) => {
      if (reservation.state !== "prepared") {
        throw new Error("DIRECT_GOAL_EXECUTION_MAY_HAVE_DISPATCHED");
      }
      return {
        reservation: undefined,
        step:
          step.automatic || goal.executionMode === "dynamic"
            ? releaseClaim(step)
            : releaseClaimIfExpired(step, now),
        value: undefined,
      };
    }).then(async () => {
      const goal = await this.get(input.authorizationBinding, input.goalId);
      if (goal === undefined) throw new Error("DIRECT_GOAL_NOT_FOUND");
      return goal;
    });
  }

  markExecutionOutcomeUnknown(
    input: DirectGoalExecutionReservationInput,
  ): Promise<DirectGoalExecutionReservationView> {
    return this.#mutateReservation(input, (reservation, _step, now) => {
      if (reservation.state === "prepared") {
        throw new Error("DIRECT_GOAL_EXECUTION_NOT_DISPATCHED");
      }
      const unknown: StoredReservation = {
        ...reservation,
        state: "outcome_unknown",
        outcomeUnknownAtUnixMs: reservation.outcomeUnknownAtUnixMs ?? now,
      };
      return { reservation: unknown, value: publicExecutionReservation(unknown, "updated") };
    });
  }

  finalizeExecution(input: DirectGoalExecutionFinalizeInput): Promise<DirectGoalView> {
    const validated = validateReceiptInput(input);
    const ownerDigest = digest(validated.authorizationBinding);
    const claimantDigest = digest(validated.claimantBinding);
    const claimTokenDigest = validated.claimTokenDigest;
    const bindingDigest = executionBindingDigestFrom(
      ownerDigest,
      claimantDigest,
      claimTokenDigest,
      validated,
    );
    return this.#mutate((snapshot) => {
      const existing = findOwnerOperation(snapshot, ownerDigest, validated.operationId);
      if (existing?.kind === "receipt") {
        if (existing.executionBindingDigest !== bindingDigest) {
          throw new Error("DIRECT_GOAL_OPERATION_ID_CONFLICT");
        }
        const expected = receiptFrom(validated, existing.receipt.recordedAtUnixMs, bindingDigest);
        if (canonicalJson(existing.receipt) !== canonicalJson(expected)) {
          throw new Error("DIRECT_GOAL_OPERATION_ID_CONFLICT");
        }
        const goal = snapshot.goals[existing.goalIndex] as StoredGoal;
        return { snapshot, value: publicGoal(goal) };
      }
      if (
        existing === undefined ||
        existing.kind !== "reservation" ||
        existing.executionBindingDigest !== bindingDigest
      ) {
        throw new Error(
          existing === undefined
            ? "DIRECT_GOAL_EXECUTION_NOT_RESERVED"
            : existing.executionBindingDigest !== bindingDigest
              ? "DIRECT_GOAL_OPERATION_ID_CONFLICT"
              : "DIRECT_GOAL_EXECUTION_NOT_RESERVED",
        );
      }
      const current = snapshot.goals[existing.goalIndex] as StoredGoal;
      const step = current.steps[existing.stepIndex] as StoredStep;
      const reservation = existing.reservation;
      if (reservation.state === "prepared") {
        throw new Error("DIRECT_GOAL_EXECUTION_NOT_DISPATCHED");
      }
      const now = this.#now();
      let nextStep: StoredStep;
      if (validated.outcome === "succeeded") {
        nextStep = applyReceipt(step, receiptFrom(validated, now, bindingDigest));
      } else {
        const { reservation: _reservation, ...withoutReservation } = step;
        if (step.automatic || current.executionMode === "dynamic") {
          const { claim: _claim, ...withoutClaim } = withoutReservation;
          nextStep = { ...withoutClaim, state: "pending" };
        } else nextStep = releaseClaimIfExpired(withoutReservation, now);
      }
      const next = updateGoal(
        current,
        now,
        compactAutomaticSteps(replaceAt(current.steps, existing.stepIndex, nextStep)),
      );
      return { snapshot: replaceGoal(snapshot, existing.goalIndex, next), value: publicGoal(next) };
    });
  }

  #mutateReservation<T>(
    input: DirectGoalExecutionReservationInput,
    mutate: (
      reservation: StoredReservation,
      step: StoredStep,
      now: number,
      goal: StoredGoal,
    ) => {
      readonly reservation: StoredReservation | undefined;
      readonly step?: StoredStep;
      readonly value: T;
    },
  ): Promise<T> {
    const validated = validateExecutionAuthorizationInput(input);
    const ownerDigest = digest(validated.authorizationBinding);
    const claimantDigest = digest(validated.claimantBinding);
    const bindingDigest = executionBindingDigestFrom(
      ownerDigest,
      claimantDigest,
      validated.claimTokenDigest,
      validated,
    );
    return this.#mutate((snapshot) => {
      const existing = findOwnerOperation(snapshot, ownerDigest, validated.operationId);
      if (existing === undefined || existing.kind !== "reservation") {
        throw new Error("DIRECT_GOAL_EXECUTION_NOT_RESERVED");
      }
      if (existing.executionBindingDigest !== bindingDigest) {
        throw new Error("DIRECT_GOAL_OPERATION_ID_CONFLICT");
      }
      const current = snapshot.goals[existing.goalIndex] as StoredGoal;
      const step = current.steps[existing.stepIndex] as StoredStep;
      const now = this.#now();
      const result = mutate(existing.reservation, step, now, current);
      const baseStep = result.step ?? step;
      const nextStep =
        result.reservation === undefined
          ? omitReservation(baseStep)
          : { ...baseStep, reservation: result.reservation };
      const next = updateGoal(current, now, replaceAt(current.steps, existing.stepIndex, nextStep));
      return {
        snapshot: replaceGoal(snapshot, existing.goalIndex, next),
        value: result.value,
      };
    });
  }

  updateStatus(input: DirectGoalUpdateInput): Promise<DirectGoalView> {
    const status = input.status;
    const objective =
      input.objective === undefined ? undefined : requiredText(input.objective, "objective");
    if (status === undefined && objective === undefined)
      throw new Error("DIRECT_GOAL_UPDATE_EMPTY");
    if (status === "complete")
      return this.complete({
        authorizationBinding: input.authorizationBinding,
        goalId: input.goalId,
        ...(objective === undefined ? {} : { objective }),
      });
    if (status !== undefined && status !== "active" && status !== "paused" && status !== "blocked")
      throw new Error("DIRECT_GOAL_STATUS_INVALID");
    const ownerDigest = digest(requiredAuthorizationBinding(input.authorizationBinding));
    const goalId = requiredIdentifier(input.goalId, "goalId");
    const reason =
      status === "blocked" ? requiredText(input.reason as string, "reason") : undefined;
    return this.#mutate((snapshot) => {
      const index = goalIndex(snapshot, ownerDigest, goalId);
      const current = snapshot.goals[index] as StoredGoal;
      const objectiveChanged = objective !== undefined && objective !== current.objective;
      if (status === undefined) {
        if (!objectiveChanged) return { snapshot, value: publicGoal(current) };
        const now = this.#now();
        const next: StoredGoal = {
          ...current,
          objective,
          revision: current.revision + 1,
          updatedAtUnixMs: now,
        };
        return { snapshot: replaceGoal(snapshot, index, next), value: publicGoal(next) };
      }
      const statusChanged = current.state !== status || current.blockedReason !== reason;
      if (!statusChanged && !objectiveChanged) return { snapshot, value: publicGoal(current) };
      if (
        status === "active" &&
        snapshot.goals.some(
          (goal) =>
            goal.id !== current.id && goal.ownerDigest === ownerDigest && goal.state === "active",
        )
      )
        throw new Error("DIRECT_GOAL_ALREADY_ACTIVE");
      const now = this.#now();
      const {
        blockedAtUnixMs: _blockedAt,
        blockedReason: _blockedReason,
        completedAtUnixMs: _completedAt,
        ...base
      } = current;
      const next: StoredGoal = {
        ...base,
        objective: objective ?? current.objective,
        state: status,
        revision: current.revision + 1,
        updatedAtUnixMs: now,
        ...(reason === undefined ? {} : { blockedAtUnixMs: now, blockedReason: reason }),
        // State changes stop continuation, not already reserved native work.
        steps: current.steps.map((step) => {
          if (step.automatic || step.reservation !== undefined) return step;
          const { claim: _claim, ...unclaimed } = step;
          return { ...unclaimed, state: step.state === "claimed" ? "pending" : step.state };
        }),
      };
      return { snapshot: replaceGoal(snapshot, index, next), value: publicGoal(next) };
    });
  }

  delete(input: DirectGoalDeleteInput): Promise<DirectGoalDeleteView> {
    const ownerDigest = digest(requiredAuthorizationBinding(input.authorizationBinding));
    const goalId = requiredIdentifier(input.goalId, "goalId");
    return this.#mutate((snapshot) => {
      const previous = (snapshot.deletions ?? []).find(
        (deletion) => deletion.ownerDigest === ownerDigest && deletion.goalId === goalId,
      );
      if (previous !== undefined) {
        return {
          snapshot,
          value: {
            goalId: previous.goalId,
            deleted: true as const,
            deletedAtUnixMs: previous.deletedAtUnixMs,
          },
        };
      }
      const index = goalIndex(snapshot, ownerDigest, goalId);
      const deletedAtUnixMs = this.#now();
      return {
        snapshot: {
          ...snapshot,
          revision: snapshot.revision + 1,
          goals: snapshot.goals.filter((_, candidateIndex) => candidateIndex !== index),
          deletions: [...(snapshot.deletions ?? []), { goalId, ownerDigest, deletedAtUnixMs }],
        },
        value: { goalId, deleted: true as const, deletedAtUnixMs },
      };
    });
  }

  pauseConversation(
    input: DirectGoalConversationLifecycleInput,
  ): Promise<readonly DirectGoalView[]> {
    const { conversationUrl, accountSourceId } = requiredConversationLifecycle(input);
    return this.#mutate((snapshot) => {
      const now = this.#now();
      const paused: DirectGoalView[] = [];
      const goals = snapshot.goals.map((goal) => {
        if (
          goal.state !== "active" ||
          goal.continuation?.conversationUrl !== conversationUrl ||
          goal.continuation.accountSourceId !== accountSourceId
        )
          return goal;
        const next: StoredGoal = {
          ...goal,
          state: "paused",
          revision: goal.revision + 1,
          updatedAtUnixMs: now,
          steps: goal.steps.map((step) => {
            if (step.automatic || step.reservation !== undefined) return step;
            const { claim: _claim, ...unclaimed } = step;
            return { ...unclaimed, state: step.state === "claimed" ? "pending" : step.state };
          }),
        };
        paused.push(publicGoal(next));
        return next;
      });
      return {
        snapshot:
          paused.length === 0 ? snapshot : { ...snapshot, revision: snapshot.revision + 1, goals },
        value: paused,
      };
    });
  }

  deleteConversation(
    input: DirectGoalConversationLifecycleInput,
  ): Promise<readonly DirectGoalDeleteView[]> {
    const { conversationUrl, accountSourceId } = requiredConversationLifecycle(input);
    return this.#mutate((snapshot) => {
      const matches = snapshot.goals.filter(
        (goal) =>
          goal.continuation?.conversationUrl === conversationUrl &&
          goal.continuation.accountSourceId === accountSourceId,
      );
      if (matches.length === 0) return { snapshot, value: [] };
      const deletedAtUnixMs = this.#now();
      const deletions = [
        ...(snapshot.deletions ?? []),
        ...matches
          .filter(
            (goal) =>
              !(snapshot.deletions ?? []).some(
                (entry) => entry.goalId === goal.id && entry.ownerDigest === goal.ownerDigest,
              ),
          )
          .map((goal) => ({ goalId: goal.id, ownerDigest: goal.ownerDigest, deletedAtUnixMs })),
      ];
      return {
        snapshot: {
          ...snapshot,
          revision: snapshot.revision + 1,
          goals: snapshot.goals.filter((goal) => !matches.includes(goal)),
          deletions,
        },
        value: matches.map((goal) => ({
          goalId: goal.id,
          deleted: true as const,
          deletedAtUnixMs,
        })),
      };
    });
  }

  complete(input: DirectGoalCompletionInput): Promise<DirectGoalView> {
    const ownerDigest = digest(requiredAuthorizationBinding(input.authorizationBinding));
    const goalId = requiredIdentifier(input.goalId, "goalId");
    const objective =
      input.objective === undefined ? undefined : requiredText(input.objective, "objective");
    return this.#mutate((snapshot) => {
      const index = goalIndex(snapshot, ownerDigest, goalId);
      const current = expireClaims(snapshot.goals[index] as StoredGoal, this.#now());
      if (current.state === "completed") {
        if (objective === undefined || objective === current.objective)
          return { snapshot, value: publicGoal(current) };
        const now = this.#now();
        const revised = {
          ...current,
          objective,
          revision: current.revision + 1,
          updatedAtUnixMs: now,
        };
        return { snapshot: replaceGoal(snapshot, index, revised), value: publicGoal(revised) };
      }
      const unfinished = current.steps.filter(
        (step) => !step.automatic && step.state !== "completed",
      );
      if (unfinished.length > 0) {
        const counts = {
          pending: unfinished.filter((step) => step.state === "pending").length,
          claimed: unfinished.filter((step) => step.state === "claimed").length,
          awaitingReadback: unfinished.filter((step) => step.state === "awaiting_readback").length,
        };
        throw new Error(
          `DIRECT_GOAL_HAS_UNFINISHED_STEPS: pending=${counts.pending}, claimed=${counts.claimed}, awaiting_readback=${counts.awaitingReadback}`,
        );
      }
      const now = this.#now();
      const { blockedAtUnixMs: _blockedAt, blockedReason: _blockedReason, ...base } = current;
      const completed: StoredGoal = {
        ...base,
        objective: objective ?? current.objective,
        state: "completed",
        revision: current.revision + 1,
        updatedAtUnixMs: now,
        completedAtUnixMs: now,
        steps: current.steps.map((step) => {
          if (step.automatic || step.reservation !== undefined) return step;
          const { claim: _claim, ...unclaimed } = step;
          return { ...unclaimed, state: step.state === "claimed" ? "pending" : step.state };
        }),
      };
      return {
        snapshot: replaceGoal(snapshot, index, completed),
        value: publicGoal(completed),
      };
    });
  }

  #read<T>(operation: () => T): Promise<T> {
    return this.#tail.then(operation, operation);
  }

  #mutate<T>(
    operation: (snapshot: SnapshotPayload) => {
      readonly snapshot: SnapshotPayload;
      readonly value: T;
    },
  ): Promise<T> {
    const run = this.#tail.then(async () => {
      const outcome = operation(this.#snapshot);
      if (outcome.snapshot !== this.#snapshot) {
        if (this.#durable) {
          await writeSnapshot(this.#configuration.snapshotPath, outcome.snapshot);
        }
        this.#snapshot = outcome.snapshot;
      }
      return outcome.value;
    });
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #now(): number {
    const value = this.#configuration.nowUnixMs();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Direct Goal clock returned an invalid time");
    }
    return value;
  }
}

function matchesObservedGoal(
  goal: StoredGoal,
  result: OracleGoalConversation["goals"][number],
): boolean {
  return (
    result.goalId === goal.id &&
    result.createdAtUnixMs === goal.createdAtUnixMs &&
    result.revision <= goal.revision &&
    (goal.continuation?.conversationUrl === undefined
      ? result.toolName === "omnicodex__goal_create"
      : goal.state === "active")
  );
}

function applyReceipt(step: StoredStep, receipt: StoredReceipt): StoredStep {
  const { claim: _claim, reservation: _reservation, ...withoutClaim } = step;
  if (receipt.role === "work") {
    if (step.state === "awaiting_readback") {
      throw new Error("DIRECT_GOAL_STEP_ALREADY_AWAITING_READBACK");
    }
    if (step.mode === "mutation_and_readback" && receipt.stateEffect !== "mutate") {
      throw new Error("DIRECT_GOAL_STEP_REQUIRES_MUTATION");
    }
    if (step.mode === "mutation_and_readback") {
      return {
        ...withoutClaim,
        state: "awaiting_readback",
        ...(step.claim === undefined ? {} : { claim: step.claim }),
        receipts: [...step.receipts, receipt],
      };
    }
    return { ...withoutClaim, state: "completed", receipts: [...step.receipts, receipt] };
  }
  if (step.mode !== "mutation_and_readback" || step.state !== "awaiting_readback") {
    throw new Error("DIRECT_GOAL_READBACK_NOT_EXPECTED");
  }
  if (receipt.stateEffect !== "read") throw new Error("DIRECT_GOAL_READBACK_MUST_BE_READ_ONLY");
  const work = step.receipts.find(
    (candidate) => candidate.role === "work" && candidate.operationId === receipt.provesOperationId,
  );
  if (work === undefined) throw new Error("DIRECT_GOAL_WORK_RECEIPT_NOT_FOUND");
  if (work.resourceDigest !== receipt.resourceDigest) {
    throw new Error("DIRECT_GOAL_READBACK_RESOURCE_MISMATCH");
  }
  return {
    ...withoutClaim,
    state: "completed",
    receipts: [...step.receipts, receipt],
  };
}

function receiptFrom(
  input: ReturnType<typeof validateReceiptInput>,
  recordedAtUnixMs: number,
  executionBindingDigest: string,
): StoredReceipt {
  return {
    operationId: input.operationId,
    role: input.role,
    toolName: input.toolName,
    targetIdentity: input.targetIdentity,
    resourceDigest: input.resourceDigest,
    resultDigest: input.resultDigest,
    stateEffect: input.stateEffect,
    executionBindingDigest,
    recordedAtUnixMs,
    ...(input.provesOperationId === undefined
      ? {}
      : { provesOperationId: input.provesOperationId }),
  };
}

function executionBindingDigestFrom(
  ownerDigest: string,
  claimantDigest: string,
  claimTokenDigest: string,
  input: ReturnType<typeof validateExecutionAuthorizationInput>,
): string {
  return executionBindingDigestFromParts({
    ownerDigest,
    claimantDigest,
    claimTokenDigest,
    goalId: input.goalId,
    stepId: input.stepId,
    operationId: input.operationId,
    role: input.role,
    toolName: input.toolName,
    targetIdentity: input.targetIdentity,
    resourceDigest: input.resourceDigest,
    stateEffect: input.stateEffect,
    modelEffect: input.modelEffect,
    ...(input.provesOperationId === undefined
      ? {}
      : { provesOperationId: input.provesOperationId }),
  });
}

function executionBindingDigestFromParts(value: {
  readonly ownerDigest: string;
  readonly claimantDigest: string;
  readonly claimTokenDigest: string;
  readonly goalId: string;
  readonly stepId: string;
  readonly operationId: string;
  readonly role: DirectGoalExecutionRole;
  readonly toolName: string;
  readonly targetIdentity: string;
  readonly resourceDigest: string;
  readonly stateEffect: "none" | "read" | "mutate";
  readonly modelEffect: "none" | "model" | "unknown";
  readonly provesOperationId?: string;
}): string {
  return digest(canonicalJson(value));
}

type OwnerOperation =
  | {
      readonly kind: "reservation";
      readonly goalIndex: number;
      readonly stepIndex: number;
      readonly executionBindingDigest: string;
      readonly reservation: StoredReservation;
    }
  | {
      readonly kind: "receipt";
      readonly goalIndex: number;
      readonly stepIndex: number;
      readonly executionBindingDigest: string;
      readonly receipt: StoredReceipt;
    }
  | {
      readonly kind: "binding";
      readonly goalIndex: number;
      readonly stepIndex: number;
      readonly executionBindingDigest: string;
      readonly binding: StoredOperationBinding;
    };

function findOwnerOperation(
  snapshot: SnapshotPayload,
  ownerDigest: string,
  operationId: string,
): OwnerOperation | undefined {
  let found: OwnerOperation | undefined;
  for (let goalIndex = 0; goalIndex < snapshot.goals.length; goalIndex += 1) {
    const goal = snapshot.goals[goalIndex] as StoredGoal;
    if (goal.ownerDigest !== ownerDigest) continue;
    for (let stepIndex = 0; stepIndex < goal.steps.length; stepIndex += 1) {
      const step = goal.steps[stepIndex] as StoredStep;
      const candidate: OwnerOperation | undefined =
        step.reservation?.operationId === operationId
          ? {
              kind: "reservation" as const,
              goalIndex,
              stepIndex,
              executionBindingDigest: step.reservation.executionBindingDigest,
              reservation: step.reservation,
            }
          : (() => {
              const receipt = step.receipts.find((item) => item.operationId === operationId);
              if (receipt !== undefined) {
                return {
                  kind: "receipt" as const,
                  goalIndex,
                  stepIndex,
                  executionBindingDigest: receipt.executionBindingDigest,
                  receipt,
                };
              }
              const binding = step.operationBindings.find(
                (item) => item.operationId === operationId,
              );
              return binding === undefined
                ? undefined
                : {
                    kind: "binding" as const,
                    goalIndex,
                    stepIndex,
                    executionBindingDigest: binding.executionBindingDigest,
                    binding,
                  };
            })();
      if (candidate === undefined) continue;
      if (found !== undefined) throw new Error("DIRECT_GOAL_OPERATION_ID_CONFLICT");
      found = candidate;
    }
  }
  return found;
}

function publicExecutionReservation(
  value: StoredReservation | StoredReceipt,
  disposition: DirectGoalExecutionReservationView["disposition"],
): DirectGoalExecutionReservationView {
  if ("recordedAtUnixMs" in value) {
    return {
      operationId: value.operationId,
      state: "finalized",
      disposition,
      preparedAtUnixMs: value.recordedAtUnixMs,
    };
  }
  return {
    operationId: value.operationId,
    state: value.state,
    disposition,
    preparedAtUnixMs: value.preparedAtUnixMs,
    ...(value.dispatchedAtUnixMs === undefined
      ? {}
      : { dispatchedAtUnixMs: value.dispatchedAtUnixMs }),
    ...(value.outcomeUnknownAtUnixMs === undefined
      ? {}
      : { outcomeUnknownAtUnixMs: value.outcomeUnknownAtUnixMs }),
  };
}

function omitReservation(step: StoredStep): StoredStep {
  const { reservation: _reservation, ...withoutReservation } = step;
  return withoutReservation;
}

function releaseClaimIfExpired(step: StoredStep, now: number): StoredStep {
  const withoutReservation = omitReservation(step);
  if (withoutReservation.claim === undefined || withoutReservation.claim.expiresAtUnixMs > now) {
    return withoutReservation;
  }
  return releaseClaim(withoutReservation);
}

function releaseClaim(step: StoredStep): StoredStep {
  const { claim: _claim, ...withoutClaim } = omitReservation(step);
  return {
    ...withoutClaim,
    state: step.state === "awaiting_readback" ? "awaiting_readback" : "pending",
  };
}

function assertClaim(
  step: StoredStep,
  claimantDigest: string,
  claimTokenDigest: string,
  now: number,
): void {
  if (
    step.claim === undefined ||
    (!step.automatic && step.claim.expiresAtUnixMs <= now) ||
    step.claim.claimantDigest !== claimantDigest ||
    step.claim.tokenDigest !== claimTokenDigest
  ) {
    throw new Error("DIRECT_GOAL_CLAIM_INVALID_OR_EXPIRED");
  }
}

function assertExecutionAdmitted(
  step: StoredStep,
  claimantDigest: string,
  input: ReturnType<typeof validateExecutionAuthorizationInput>,
  now: number,
): void {
  assertClaim(step, claimantDigest, input.claimTokenDigest, now);
  if (input.role === "work") {
    if (step.state === "awaiting_readback") {
      throw new Error("DIRECT_GOAL_STEP_ALREADY_AWAITING_READBACK");
    }
    if (step.mode === "mutation_and_readback" && input.stateEffect !== "mutate") {
      throw new Error("DIRECT_GOAL_STEP_REQUIRES_MUTATION");
    }
    return;
  }
  if (step.mode !== "mutation_and_readback" || step.state !== "awaiting_readback") {
    throw new Error("DIRECT_GOAL_READBACK_NOT_EXPECTED");
  }
  if (input.stateEffect !== "read") throw new Error("DIRECT_GOAL_READBACK_MUST_BE_READ_ONLY");
  if (input.modelEffect !== "none") {
    throw new Error("DIRECT_GOAL_READBACK_REQUIRES_NON_MODEL_EVIDENCE");
  }
  const work = step.receipts.find(
    (candidate) => candidate.role === "work" && candidate.operationId === input.provesOperationId,
  );
  if (work === undefined) throw new Error("DIRECT_GOAL_WORK_RECEIPT_NOT_FOUND");
  if (work.resourceDigest !== input.resourceDigest) {
    throw new Error("DIRECT_GOAL_READBACK_RESOURCE_MISMATCH");
  }
}

function expireClaims(goal: StoredGoal, now: number): StoredGoal {
  let changed = false;
  const steps = goal.steps.map((step) => {
    if (step.automatic || step.reservation !== undefined) return step;
    if (step.claim === undefined || step.claim.expiresAtUnixMs > now) return step;
    changed = true;
    const { claim: _claim, ...withoutClaim } = step;
    return {
      ...withoutClaim,
      state: step.state === "awaiting_readback" ? "awaiting_readback" : "pending",
    } satisfies StoredStep;
  });
  return changed ? { ...goal, steps } : goal;
}

interface PendingStoredClaim {
  readonly goal: StoredGoal;
  readonly step: StoredStep & { readonly claim: StoredClaim };
}

function pendingClaimsForClaimant(
  snapshot: SnapshotPayload,
  ownerDigest: string,
  claimantDigest: string,
  now: number,
): readonly PendingStoredClaim[] {
  const matches: PendingStoredClaim[] = [];
  for (const rawGoal of snapshot.goals) {
    if (rawGoal.ownerDigest !== ownerDigest || rawGoal.state !== "active") continue;
    const goal = expireClaims(rawGoal, now);
    for (const rawStep of goal.steps) {
      if (
        !rawStep.automatic &&
        rawStep.claim !== undefined &&
        rawStep.claim.expiresAtUnixMs > now &&
        rawStep.claim.claimantDigest === claimantDigest
      ) {
        matches.push({ goal, step: rawStep as StoredStep & { readonly claim: StoredClaim } });
      }
    }
  }
  return matches;
}

function updateGoal(goal: StoredGoal, now: number, steps: readonly StoredStep[]): StoredGoal {
  return {
    ...goal,
    revision: goal.revision + 1,
    updatedAtUnixMs: now,
    steps,
  };
}

function compactAutomaticSteps(steps: readonly StoredStep[]): readonly StoredStep[] {
  let excess =
    steps.filter((step) => step.automatic === true && step.state === "completed").length -
    MAX_COMPLETED_AUTOMATIC_STEPS;
  if (excess <= 0) return steps;
  return steps.filter((step) => {
    if (excess <= 0 || step.automatic !== true || step.state !== "completed") return true;
    excess -= 1;
    return false;
  });
}

function compactSnapshotAutomaticSteps(snapshot: SnapshotPayload): SnapshotPayload {
  let changed = false;
  const goals = snapshot.goals.map((goal) => {
    const steps = compactAutomaticSteps(goal.steps);
    if (steps === goal.steps) return goal;
    changed = true;
    return { ...goal, steps };
  });
  if (!changed) return snapshot;
  const revision = snapshot.revision + 1;
  if (!Number.isSafeInteger(revision)) throw new Error("Direct Goal revision space is exhausted");
  return { ...snapshot, revision, goals };
}

function replaceGoal(snapshot: SnapshotPayload, index: number, goal: StoredGoal): SnapshotPayload {
  return {
    ...snapshot,
    revision: snapshot.revision + 1,
    goals: replaceAt(snapshot.goals, index, goal),
  };
}

function goalIndex(snapshot: SnapshotPayload, ownerDigest: string, goalId: string): number {
  const index = snapshot.goals.findIndex(
    (goal) => goal.id === goalId && goal.ownerDigest === ownerDigest,
  );
  if (index < 0) throw new Error("DIRECT_GOAL_NOT_FOUND");
  return index;
}

function validateCreateInput(input: DirectGoalCreateInput): DirectGoalCreateInput {
  const authorizationBinding = requiredAuthorizationBinding(input.authorizationBinding);
  const idempotencyKey =
    input.idempotencyKey === undefined
      ? undefined
      : requiredText(input.idempotencyKey, "idempotencyKey", 128);
  if (
    idempotencyKey !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u.test(idempotencyKey)
  ) {
    throw new Error("Direct Goal idempotencyKey must be a stable UUID-like identifier");
  }
  const objective = requiredText(input.objective, "objective");
  if (input.steps === undefined || (Array.isArray(input.steps) && input.steps.length === 0))
    return {
      authorizationBinding,
      objective,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    };
  if (!Array.isArray(input.steps)) {
    throw new Error("Direct Goal steps must be an array");
  }
  const ids = new Set<string>();
  const steps = input.steps.map((step) => {
    const id = requiredIdentifier(step.id, "step.id");
    if (ids.has(id)) throw new Error(`Duplicate Direct Goal step id: ${id}`);
    ids.add(id);
    if (step.mode !== "successful_call" && step.mode !== "mutation_and_readback") {
      throw new Error(`Invalid Direct Goal step mode: ${String(step.mode)}`);
    }
    const allowedToolNames = [...new Set<string>(step.allowedToolNames ?? [])].map((name) =>
      requiredIdentifier(name, "allowedToolNames"),
    );
    return {
      id,
      description: requiredText(step.description, "step.description"),
      mode: step.mode,
      allowedToolNames,
    };
  });
  return {
    authorizationBinding,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    objective,
    steps,
  };
}

function requiredConversationLifecycle(
  input: DirectGoalConversationLifecycleInput,
): DirectGoalConversationLifecycleInput {
  const conversationUrl = normalizeChatGptConversationUrl(input.conversationUrl);
  if (conversationUrl === undefined) throw new Error("DIRECT_GOAL_CONVERSATION_INVALID");
  if (!/^chatgpt:[^:]+:[^:]+$/u.test(input.accountSourceId))
    throw new Error("DIRECT_GOAL_ACCOUNT_SOURCE_INVALID");
  return { conversationUrl, accountSourceId: input.accountSourceId };
}

function validateReceiptInput(input: DirectGoalExecutionReceiptInput) {
  const authorization = validateExecutionAuthorizationInput(input);
  if (
    input.outcome !== "succeeded" &&
    input.outcome !== "tool_error" &&
    input.outcome !== "failed"
  ) {
    throw new Error("Invalid Direct Goal execution outcome");
  }
  return {
    ...authorization,
    operationId: requiredIdentifier(input.operationId, "operationId"),
    resultDigest: requiredDigest(input.resultDigest, "resultDigest"),
    outcome: input.outcome,
  };
}

function validateExecutionAuthorizationInput(input: DirectGoalExecutionAuthorizationInput) {
  const role = input.role;
  if (role !== "work" && role !== "readback") throw new Error("Invalid Direct Goal receipt role");
  const provesOperationId =
    input.provesOperationId === undefined
      ? undefined
      : requiredIdentifier(input.provesOperationId, "provesOperationId");
  if ((role === "readback") !== (provesOperationId !== undefined)) {
    throw new Error("Direct Goal readback must identify the work operation it proves");
  }
  if (
    input.stateEffect !== "none" &&
    input.stateEffect !== "read" &&
    input.stateEffect !== "mutate"
  ) {
    throw new Error("Invalid Direct Goal state effect");
  }
  if (
    input.modelEffect !== "none" &&
    input.modelEffect !== "model" &&
    input.modelEffect !== "unknown"
  ) {
    throw new Error("Invalid Direct Goal model effect");
  }
  const suppliedClaimToken = input.claimToken !== undefined;
  const suppliedClaimTokenDigest = input.claimTokenDigest !== undefined;
  if (suppliedClaimToken === suppliedClaimTokenDigest) {
    throw new Error("Direct Goal execution requires exactly one claim binding");
  }
  const claimTokenDigest =
    input.claimToken === undefined
      ? requiredDigest(input.claimTokenDigest as string, "claimTokenDigest")
      : digest(requiredOpaqueToken(input.claimToken, "claimToken"));
  return {
    authorizationBinding: requiredAuthorizationBinding(input.authorizationBinding),
    claimantBinding: requiredText(input.claimantBinding, "claimantBinding"),
    goalId: requiredIdentifier(input.goalId, "goalId"),
    stepId: requiredIdentifier(input.stepId, "stepId"),
    claimTokenDigest,
    operationId: requiredIdentifier(input.operationId, "operationId"),
    role,
    toolName: requiredIdentifier(input.toolName, "toolName"),
    targetIdentity: requiredOpaqueIdentity(input.targetIdentity, "targetIdentity"),
    resourceDigest: requiredDigest(input.resourceDigest, "resourceDigest"),
    stateEffect: input.stateEffect,
    modelEffect: input.modelEffect,
    ...(provesOperationId === undefined ? {} : { provesOperationId }),
  };
}

function publicGoal(goal: StoredGoal): DirectGoalView {
  return {
    id: goal.id,
    objective: goal.objective,
    ...(goal.executionMode === undefined ? {} : { executionMode: goal.executionMode }),
    state: goal.state,
    revision: goal.revision,
    createdAtUnixMs: goal.createdAtUnixMs,
    updatedAtUnixMs: goal.updatedAtUnixMs,
    ...(goal.completedAtUnixMs === undefined ? {} : { completedAtUnixMs: goal.completedAtUnixMs }),
    ...(goal.blockedAtUnixMs === undefined ? {} : { blockedAtUnixMs: goal.blockedAtUnixMs }),
    ...(goal.blockedReason === undefined ? {} : { blockedReason: goal.blockedReason }),
    steps: goal.steps.map(publicStep),
    ...(goal.continuation === undefined
      ? {}
      : { continuation: structuredClone(goal.continuation) }),
  };
}

function publicStep(step: StoredStep): DirectGoalStepView {
  return {
    id: step.id,
    description: step.description,
    mode: step.mode,
    allowedToolNames: [...step.allowedToolNames],
    state: step.state,
    ...(step.claim === undefined || step.automatic
      ? {}
      : { claimExpiresAtUnixMs: step.claim.expiresAtUnixMs }),
    ...(step.reservation === undefined
      ? {}
      : {
          reservation: {
            operationId: step.reservation.operationId,
            role: step.reservation.role,
            toolName: step.reservation.toolName,
            targetIdentity: step.reservation.targetIdentity,
            resourceDigest: step.reservation.resourceDigest,
            stateEffect: step.reservation.stateEffect,
            modelEffect: step.reservation.modelEffect,
            state: step.reservation.state,
            preparedAtUnixMs: step.reservation.preparedAtUnixMs,
            ...(step.reservation.dispatchedAtUnixMs === undefined
              ? {}
              : { dispatchedAtUnixMs: step.reservation.dispatchedAtUnixMs }),
            ...(step.reservation.outcomeUnknownAtUnixMs === undefined
              ? {}
              : { outcomeUnknownAtUnixMs: step.reservation.outcomeUnknownAtUnixMs }),
            ...(step.reservation.provesOperationId === undefined
              ? {}
              : { provesOperationId: step.reservation.provesOperationId }),
          },
        }),
    receipts: step.receipts.map((receipt) => ({
      operationId: receipt.operationId,
      role: receipt.role,
      toolName: receipt.toolName,
      targetIdentity: receipt.targetIdentity,
      resourceDigest: receipt.resourceDigest,
      resultDigest: receipt.resultDigest,
      stateEffect: receipt.stateEffect,
      recordedAtUnixMs: receipt.recordedAtUnixMs,
      ...(receipt.provesOperationId === undefined
        ? {}
        : { provesOperationId: receipt.provesOperationId }),
    })),
  };
}

function stepDefinition(step: {
  readonly id: string;
  readonly description: string;
  readonly mode: DirectGoalStepMode;
  readonly allowedToolNames?: readonly string[];
}) {
  return {
    id: step.id,
    description: step.description,
    mode: step.mode,
    allowedToolNames: [...(step.allowedToolNames ?? [])],
  };
}

function boundedLease(value: number | undefined): number {
  const lease = value ?? DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(lease) || lease <= 0) {
    throw new Error("Direct Goal lease must be a positive safe integer in milliseconds");
  }
  return lease;
}

function requiredText(value: string, name: string, maximum?: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const text = value.trim();
  if (text.length === 0 || (maximum !== undefined && text.length > maximum) || /\0/u.test(text)) {
    throw new Error(
      maximum === undefined
        ? `${name} must be a non-empty string without NUL characters`
        : `${name} must contain between 1 and ${maximum} characters`,
    );
  }
  return text;
}

function requiredAuthorizationBinding(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("authorizationBinding is invalid");
  }
  const segments = value.split("\0");
  if (
    segments.length !== 4 ||
    segments.some((segment) => segment.length === 0 || /[\r\n]/u.test(segment))
  ) {
    throw new Error("authorizationBinding must contain four non-empty identity segments");
  }
  return value;
}

function assertUnknownExecutionReadbackInput(input: DirectGoalUnknownExecutionReadbackInput): void {
  if (input.stateEffect !== "read" || input.modelEffect !== "none") {
    throw new Error("DIRECT_GOAL_UNKNOWN_EXECUTION_READBACK_REQUIRES_NON_MODEL_READ");
  }
}

function requiredOpaqueIdentity(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/u.test(value)) {
    throw new Error(`${name} must be a non-empty single-line identity`);
  }
  return value;
}

function requiredIdentifier(value: string, name: string): string {
  const text = requiredText(value, name, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(text)) {
    throw new Error(`${name} is not a valid stable identifier`);
  }
  return text;
}

function requiredOpaqueToken(value: string, name: string): string {
  const token = requiredText(value, name, 256);
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) throw new Error(`${name} is invalid`);
  return token;
}

function requiredDigest(value: string, name: string): string {
  const digestValue = requiredText(value, name, 64);
  if (!/^[a-f0-9]{64}$/u.test(digestValue)) throw new Error(`${name} must be SHA-256 hex`);
  return digestValue;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function replaceAt<T>(values: readonly T[], index: number, value: T): readonly T[] {
  return values.map((candidate, candidateIndex) => (candidateIndex === index ? value : candidate));
}

function configurationFrom(options: DirectGoalStoreOptions): DirectGoalCoreConfiguration {
  const snapshotPath = resolve(
    options.snapshotPath ??
      join(options.dataDirectory ?? omniCodexDataDirectory(), "direct-goals-v2.json"),
  );
  return {
    snapshotPath,
    nowUnixMs: options.nowUnixMs ?? Date.now,
    randomUUID: options.randomUUID ?? randomUUID,
    randomBytes: options.randomBytes ?? randomBytes,
  };
}

function emptySnapshot(): SnapshotPayload {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, goals: [], deletions: [] };
}

async function readSnapshot(path: string): Promise<SnapshotPayload> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isObject(parsed)) throw new Error("Direct Goal snapshot is not an object");
    assertExactKeys(
      parsed,
      ["schemaVersion", "revision", "goals", "checksum"],
      ["deletions"],
      "snapshot",
    );
    const { checksum, ...payload } = parsed;
    if (typeof checksum !== "string" || checksum !== snapshotChecksum(payload)) {
      throw new Error("Direct Goal snapshot checksum is invalid");
    }
    return validateSnapshot(payload);
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return emptySnapshot();
    throw error;
  }
}

function validateSnapshot(value: unknown): SnapshotPayload {
  if (!isObject(value) || value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error("Unsupported Direct Goal snapshot version");
  }
  assertExactKeys(value, ["schemaVersion", "revision", "goals"], ["deletions"], "snapshot");
  requiredNonNegativeInteger(value.revision, "snapshot.revision");
  if (!Array.isArray(value.goals)) {
    throw new Error("Direct Goal snapshot goals are invalid");
  }
  const goalIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  const ownerOperations = new Set<string>();
  for (const raw of value.goals) {
    const goal = validateStoredGoal(raw, ownerOperations);
    const goalKey = `${goal.ownerDigest}\0${goal.id}`;
    const idempotencyKey = `${goal.ownerDigest}\0${goal.idempotencyDigest}`;
    if (goalIds.has(goalKey)) throw new Error("Direct Goal snapshot contains duplicate goal ids");
    if (idempotencyKeys.has(idempotencyKey)) {
      throw new Error("Direct Goal snapshot contains duplicate idempotency identities");
    }
    goalIds.add(goalKey);
    idempotencyKeys.add(idempotencyKey);
  }
  if (value.deletions !== undefined && !Array.isArray(value.deletions)) {
    throw new Error("Direct Goal snapshot deletions are invalid");
  }
  const deletionKeys = new Set<string>();
  for (const raw of value.deletions ?? []) {
    const deletion = validateStoredGoalDeletion(raw);
    const key = `${deletion.ownerDigest}\0${deletion.goalId}`;
    if (deletionKeys.has(key)) {
      throw new Error("Direct Goal snapshot contains duplicate deletions");
    }
    if (goalIds.has(key)) {
      throw new Error("Direct Goal snapshot contains a live and deleted Goal with the same id");
    }
    deletionKeys.add(key);
  }
  return value as unknown as SnapshotPayload;
}

function validateStoredGoalDeletion(value: unknown): StoredGoalDeletion {
  if (!isObject(value)) throw new Error("Direct Goal deletion record is invalid");
  assertExactKeys(value, ["goalId", "ownerDigest", "deletedAtUnixMs"], [], "goal deletion");
  return {
    goalId: requiredUnknownIdentifier(value.goalId, "goal deletion.goalId"),
    ownerDigest: requiredUnknownDigest(value.ownerDigest, "goal deletion.ownerDigest"),
    deletedAtUnixMs: requiredNonNegativeInteger(
      value.deletedAtUnixMs,
      "goal deletion.deletedAtUnixMs",
    ),
  };
}

function validateStoredGoal(value: unknown, ownerOperations: Set<string>): StoredGoal {
  if (!isObject(value)) throw new Error("Direct Goal record is invalid");
  assertExactKeys(
    value,
    [
      "id",
      "ownerDigest",
      "idempotencyDigest",
      "objective",
      "state",
      "revision",
      "createdAtUnixMs",
      "updatedAtUnixMs",
      "steps",
    ],
    ["completedAtUnixMs", "blockedAtUnixMs", "blockedReason", "continuation", "executionMode"],
    "goal",
  );
  const id = requiredUnknownIdentifier(value.id, "goal.id");
  const ownerDigest = requiredUnknownDigest(value.ownerDigest, "goal.ownerDigest");
  requiredUnknownDigest(value.idempotencyDigest, "goal.idempotencyDigest");
  requiredUnknownText(value.objective, "goal.objective");
  if (value.executionMode !== undefined && value.executionMode !== "dynamic")
    throw new Error("Direct Goal execution mode is invalid");
  if (
    value.state !== "active" &&
    value.state !== "paused" &&
    value.state !== "completed" &&
    value.state !== "blocked"
  ) {
    throw new Error("Direct Goal state is invalid");
  }
  requiredPositiveInteger(value.revision, "goal.revision");
  const createdAt = requiredNonNegativeInteger(value.createdAtUnixMs, "goal.createdAtUnixMs");
  const updatedAt = requiredNonNegativeInteger(value.updatedAtUnixMs, "goal.updatedAtUnixMs");
  if (value.continuation !== undefined) {
    const continuation = value.continuation;
    if (!isObject(continuation) || continuation.enabled !== true)
      throw new Error("Direct Goal continuation is invalid");
    assertExactKeys(
      continuation,
      ["enabled"],
      [
        "conversationUrl",
        "bindingMessageId",
        "connectorId",
        "accountSourceId",
        "settledMessageId",
        "settledTransport",
        "observedFinalMessageIds",
        "settledAncestorMessageIds",
        "pendingFinalMessageIds",
        "draft",
      ],
      "goal.continuation",
    );
    if (
      continuation.conversationUrl !== undefined &&
      normalizeChatGptConversationUrl(continuation.conversationUrl as string) !==
        continuation.conversationUrl
    )
      throw new Error("Direct Goal continuation conversation is invalid");
    if (
      continuation.connectorId !== undefined &&
      (typeof continuation.connectorId !== "string" ||
        !/^asdk_app_[a-z0-9]+$/i.test(continuation.connectorId))
    )
      throw new Error("Direct Goal connector is invalid");
    if (continuation.bindingMessageId !== undefined)
      requiredUnknownIdentifier(
        continuation.bindingMessageId,
        "goal.continuation.bindingMessageId",
      );
    if (
      continuation.accountSourceId !== undefined &&
      (typeof continuation.accountSourceId !== "string" ||
        !/^chatgpt:[^:]+:[^:]+$/.test(continuation.accountSourceId))
    )
      throw new Error("Direct Goal account source is invalid");
    if (
      continuation.settledTransport !== undefined &&
      (continuation.settledTransport !== "desktop" || continuation.accountSourceId === undefined)
    )
      throw new Error("Direct Goal settled transport is invalid");
    if (continuation.settledMessageId !== undefined)
      requiredUnknownIdentifier(
        continuation.settledMessageId,
        "goal.continuation.settledMessageId",
      );
    for (const field of [
      "observedFinalMessageIds",
      "settledAncestorMessageIds",
      "pendingFinalMessageIds",
    ] as const) {
      if (continuation[field] === undefined) continue;
      if (!Array.isArray(continuation[field]))
        throw new Error("Direct Goal observed final messages are invalid");
      for (const id of continuation[field])
        requiredUnknownIdentifier(id, `goal.continuation.${field}`);
      if (new Set(continuation[field]).size !== continuation[field].length)
        throw new Error("Direct Goal observed final messages are duplicated");
    }
    if (continuation.draft !== undefined) {
      const draft = continuation.draft;
      if (!isObject(draft) || continuation.conversationUrl === undefined)
        throw new Error("Direct Goal continuation draft is invalid");
      assertExactKeys(
        draft,
        ["token", "afterMessageId", "state"],
        ["resumeIdleUserTurn", "resumeIdleIncompleteTurn", "transport", "nativeReceipt"],
        "goal.continuation.draft",
      );
      if (draft.resumeIdleUserTurn !== undefined && typeof draft.resumeIdleUserTurn !== "boolean")
        throw new Error("Direct Goal idle-user recovery marker is invalid");
      if (
        draft.resumeIdleIncompleteTurn !== undefined &&
        typeof draft.resumeIdleIncompleteTurn !== "boolean"
      )
        throw new Error("Direct Goal idle-incomplete recovery marker is invalid");
      if (
        draft.transport !== undefined &&
        (draft.transport !== "desktop" || continuation.accountSourceId === undefined)
      )
        throw new Error("Direct Goal draft transport is invalid");
      requiredUnknownIdentifier(draft.token, "goal.continuation.draft.token");
      if (draft.nativeReceipt !== undefined) {
        if (draft.transport !== "desktop") throw new Error("DIRECT_GOAL_NATIVE_RECEIPT_INVALID");
        assertNativeContinuationReceipt(
          draft.nativeReceipt,
          draft.token as string,
          continuation.conversationUrl as string,
          continuation.accountSourceId as string | undefined,
        );
      }
      requiredUnknownIdentifier(draft.afterMessageId, "goal.continuation.draft.afterMessageId");
      if (
        !["ready", "prepared", "dispatching", "sent", "cancelled"].includes(draft.state as string)
      )
        throw new Error("Direct Goal continuation draft state is invalid");
    }
  }
  if (updatedAt < createdAt) throw new Error("Direct Goal timestamps are inconsistent");
  if (value.state === "blocked") {
    const blockedAt = requiredNonNegativeInteger(value.blockedAtUnixMs, "goal.blockedAtUnixMs");
    requiredUnknownText(value.blockedReason, "goal.blockedReason");
    if (blockedAt < createdAt || blockedAt > updatedAt)
      throw new Error("Direct Goal blocked timestamp is inconsistent");
  } else if (value.blockedAtUnixMs !== undefined || value.blockedReason !== undefined) {
    throw new Error("Non-blocked Direct Goal cannot have blocked metadata");
  }
  if (value.state === "completed") {
    const completedAt = requiredNonNegativeInteger(
      value.completedAtUnixMs,
      "goal.completedAtUnixMs",
    );
    if (completedAt < createdAt || completedAt > updatedAt) {
      throw new Error("Direct Goal completion timestamp is inconsistent");
    }
  } else if (value.completedAtUnixMs !== undefined) {
    throw new Error("Active Direct Goal cannot have completedAtUnixMs");
  }
  if (
    !Array.isArray(value.steps) ||
    (value.steps.length === 0 && value.executionMode !== "dynamic")
  ) {
    throw new Error("Direct Goal steps are invalid");
  }
  const stepIds = new Set<string>();
  for (const raw of value.steps) {
    const step = validateStoredStep(raw, {
      goalId: id,
      ownerDigest,
      goalState: value.state,
      createdAt,
      updatedAt,
    });
    if (stepIds.has(step.id)) throw new Error("Direct Goal contains duplicate step ids");
    stepIds.add(step.id);
    for (const binding of step.operationBindings) {
      const key = `${ownerDigest}\0${binding.operationId}`;
      if (ownerOperations.has(key)) throw new Error("Direct Goal contains duplicate operation ids");
      ownerOperations.add(key);
    }
  }
  return value as unknown as StoredGoal;
}

function validateStoredStep(
  value: unknown,
  goal: {
    readonly goalId: string;
    readonly ownerDigest: string;
    readonly goalState: DirectGoalState;
    readonly createdAt: number;
    readonly updatedAt: number;
  },
): StoredStep {
  if (!isObject(value)) throw new Error("Direct Goal step is invalid");
  assertExactKeys(
    value,
    ["id", "description", "mode", "allowedToolNames", "state", "operationBindings", "receipts"],
    ["claim", "reservation", "automatic"],
    "goal.step",
  );
  const id = requiredUnknownIdentifier(value.id, "goal.step.id");
  if (value.automatic !== undefined && value.automatic !== true) {
    throw new Error("Direct Goal automatic record is invalid");
  }
  if (
    value.automatic &&
    (value.mode !== "successful_call" ||
      !Array.isArray(value.allowedToolNames) ||
      value.allowedToolNames.length !== 0)
  ) {
    throw new Error("Direct Goal automatic record must preserve the native tool range");
  }
  requiredUnknownText(value.description, "goal.step.description");
  if (value.mode !== "successful_call" && value.mode !== "mutation_and_readback") {
    throw new Error("Direct Goal step mode is invalid");
  }
  if (
    value.state !== "pending" &&
    value.state !== "claimed" &&
    value.state !== "awaiting_readback" &&
    value.state !== "completed"
  ) {
    throw new Error("Direct Goal step state is invalid");
  }
  if (!Array.isArray(value.allowedToolNames)) {
    throw new Error("Direct Goal allowed tools are invalid");
  }
  const allowedToolNames = value.allowedToolNames.map((name) =>
    requiredUnknownIdentifier(name, "goal.step.allowedToolNames"),
  );
  if (new Set(allowedToolNames).size !== allowedToolNames.length) {
    throw new Error("Direct Goal allowed tools are invalid");
  }
  const claim = value.claim === undefined ? undefined : validateStoredClaim(value.claim);
  if (!Array.isArray(value.receipts) || value.receipts.length > 2) {
    throw new Error("Direct Goal receipts are invalid");
  }
  const receipts = value.receipts.map((receipt) =>
    validateStoredReceipt(receipt, goal.createdAt, goal.updatedAt),
  );
  if (new Set(receipts.map((receipt) => receipt.operationId)).size !== receipts.length) {
    throw new Error("Direct Goal step contains duplicate receipt operation ids");
  }
  if (!Array.isArray(value.operationBindings)) {
    throw new Error("Direct Goal operation bindings are invalid");
  }
  const operationBindings = value.operationBindings.map((binding) =>
    validateStoredOperationBinding(binding, goal.createdAt, goal.updatedAt),
  );
  if (
    new Set(operationBindings.map((binding) => binding.operationId)).size !==
    operationBindings.length
  ) {
    throw new Error("Direct Goal step contains duplicate operation bindings");
  }
  for (const receipt of receipts) {
    const binding = operationBindings.find(
      (candidate) => candidate.operationId === receipt.operationId,
    );
    if (
      binding === undefined ||
      binding.executionBindingDigest !== receipt.executionBindingDigest
    ) {
      throw new Error("Direct Goal receipt is missing its immutable operation binding");
    }
  }
  validateStepReceiptSequence(value.mode, value.state, receipts);
  const reservation =
    value.reservation === undefined
      ? undefined
      : validateStoredReservation(value.reservation, {
          ...goal,
          stepId: id,
          stepState: value.state,
          claim,
          allowedToolNames,
          receipts,
          operationBindings,
        });
  if (value.state === "pending" && (claim !== undefined || reservation !== undefined)) {
    throw new Error("Pending Direct Goal step cannot contain a claim or reservation");
  }
  if (value.state === "claimed" && claim === undefined) {
    throw new Error("Claimed Direct Goal step is missing its claim");
  }
  if (value.state === "completed" && (claim !== undefined || reservation !== undefined)) {
    throw new Error("Completed Direct Goal step cannot contain a claim or reservation");
  }
  if (reservation !== undefined && claim === undefined) {
    throw new Error("Direct Goal reservation is missing its claim binding");
  }
  return value as unknown as StoredStep;
}

function validateStoredOperationBinding(
  value: unknown,
  createdAt: number,
  updatedAt: number,
): StoredOperationBinding {
  if (!isObject(value)) throw new Error("Direct Goal operation binding is invalid");
  assertExactKeys(
    value,
    ["operationId", "executionBindingDigest", "boundAtUnixMs"],
    [],
    "goal.step.operationBinding",
  );
  requiredUnknownIdentifier(value.operationId, "goal.step.operationBinding.operationId");
  requiredUnknownDigest(
    value.executionBindingDigest,
    "goal.step.operationBinding.executionBindingDigest",
  );
  const boundAt = requiredNonNegativeInteger(
    value.boundAtUnixMs,
    "goal.step.operationBinding.boundAtUnixMs",
  );
  if (boundAt < createdAt || boundAt > updatedAt) {
    throw new Error("Direct Goal operation binding timestamp is inconsistent");
  }
  return value as unknown as StoredOperationBinding;
}

function validateStoredClaim(value: unknown): StoredClaim {
  if (!isObject(value)) throw new Error("Direct Goal claim is invalid");
  assertExactKeys(
    value,
    ["claimantDigest", "tokenDigest", "expiresAtUnixMs"],
    [],
    "goal.step.claim",
  );
  requiredUnknownDigest(value.claimantDigest, "goal.step.claim.claimantDigest");
  requiredUnknownDigest(value.tokenDigest, "goal.step.claim.tokenDigest");
  requiredNonNegativeInteger(value.expiresAtUnixMs, "goal.step.claim.expiresAtUnixMs");
  return value as unknown as StoredClaim;
}

function validateStoredReceipt(
  value: unknown,
  createdAt: number,
  updatedAt: number,
): StoredReceipt {
  if (!isObject(value)) throw new Error("Direct Goal receipt is invalid");
  assertExactKeys(
    value,
    [
      "operationId",
      "role",
      "toolName",
      "targetIdentity",
      "resourceDigest",
      "resultDigest",
      "stateEffect",
      "recordedAtUnixMs",
      "executionBindingDigest",
    ],
    ["provesOperationId"],
    "goal.step.receipt",
  );
  requiredUnknownIdentifier(value.operationId, "goal.step.receipt.operationId");
  if (value.role !== "work" && value.role !== "readback") {
    throw new Error("Direct Goal receipt role is invalid");
  }
  requiredUnknownIdentifier(value.toolName, "goal.step.receipt.toolName");
  requiredUnknownOpaqueIdentity(value.targetIdentity, "goal.step.receipt.targetIdentity");
  requiredUnknownDigest(value.resourceDigest, "goal.step.receipt.resourceDigest");
  requiredUnknownDigest(value.resultDigest, "goal.step.receipt.resultDigest");
  requiredUnknownDigest(value.executionBindingDigest, "goal.step.receipt.executionBindingDigest");
  if (
    value.stateEffect !== "none" &&
    value.stateEffect !== "read" &&
    value.stateEffect !== "mutate"
  ) {
    throw new Error("Direct Goal receipt state effect is invalid");
  }
  const recordedAt = requiredNonNegativeInteger(
    value.recordedAtUnixMs,
    "goal.step.receipt.recordedAtUnixMs",
  );
  if (recordedAt < createdAt || recordedAt > updatedAt) {
    throw new Error("Direct Goal receipt timestamp is inconsistent");
  }
  const proves =
    value.provesOperationId === undefined
      ? undefined
      : requiredUnknownIdentifier(value.provesOperationId, "goal.step.receipt.provesOperationId");
  if ((value.role === "readback") !== (proves !== undefined)) {
    throw new Error("Direct Goal receipt proof binding is invalid");
  }
  return value as unknown as StoredReceipt;
}

function validateStoredReservation(
  value: unknown,
  step: {
    readonly goalId: string;
    readonly ownerDigest: string;
    readonly goalState: DirectGoalState;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly stepId: string;
    readonly stepState: DirectGoalStepState;
    readonly claim: StoredClaim | undefined;
    readonly allowedToolNames: readonly string[];
    readonly receipts: readonly StoredReceipt[];
    readonly operationBindings: readonly StoredOperationBinding[];
  },
): StoredReservation {
  if (!isObject(value)) throw new Error("Direct Goal reservation is invalid");
  assertExactKeys(
    value,
    [
      "operationId",
      "executionBindingDigest",
      "claimantDigest",
      "claimTokenDigest",
      "role",
      "toolName",
      "targetIdentity",
      "resourceDigest",
      "stateEffect",
      "modelEffect",
      "state",
      "preparedAtUnixMs",
    ],
    ["dispatchedAtUnixMs", "outcomeUnknownAtUnixMs", "provesOperationId"],
    "goal.step.reservation",
  );
  const operationId = requiredUnknownIdentifier(
    value.operationId,
    "goal.step.reservation.operationId",
  );
  const claimantDigest = requiredUnknownDigest(
    value.claimantDigest,
    "goal.step.reservation.claimantDigest",
  );
  const claimTokenDigest = requiredUnknownDigest(
    value.claimTokenDigest,
    "goal.step.reservation.claimTokenDigest",
  );
  const executionBindingDigest = requiredUnknownDigest(
    value.executionBindingDigest,
    "goal.step.reservation.executionBindingDigest",
  );
  if (value.role !== "work" && value.role !== "readback") {
    throw new Error("Direct Goal reservation role is invalid");
  }
  const toolName = requiredUnknownIdentifier(value.toolName, "goal.step.reservation.toolName");
  const targetIdentity = requiredUnknownOpaqueIdentity(
    value.targetIdentity,
    "goal.step.reservation.targetIdentity",
  );
  const resourceDigest = requiredUnknownDigest(
    value.resourceDigest,
    "goal.step.reservation.resourceDigest",
  );
  if (
    value.stateEffect !== "none" &&
    value.stateEffect !== "read" &&
    value.stateEffect !== "mutate"
  ) {
    throw new Error("Direct Goal reservation state effect is invalid");
  }
  if (
    value.modelEffect !== "none" &&
    value.modelEffect !== "model" &&
    value.modelEffect !== "unknown"
  )
    throw new Error("Direct Goal reservation model effect is invalid");
  if (
    value.state !== "prepared" &&
    value.state !== "dispatched" &&
    value.state !== "outcome_unknown"
  ) {
    throw new Error("Direct Goal reservation state is invalid");
  }
  const preparedAt = requiredNonNegativeInteger(
    value.preparedAtUnixMs,
    "goal.step.reservation.preparedAtUnixMs",
  );
  const dispatchedAt = optionalNonNegativeInteger(
    value.dispatchedAtUnixMs,
    "goal.step.reservation.dispatchedAtUnixMs",
  );
  const unknownAt = optionalNonNegativeInteger(
    value.outcomeUnknownAtUnixMs,
    "goal.step.reservation.outcomeUnknownAtUnixMs",
  );
  if (preparedAt < step.createdAt || preparedAt > step.updatedAt) {
    throw new Error("Direct Goal reservation timestamp is inconsistent");
  }
  if (value.state === "prepared" && (dispatchedAt !== undefined || unknownAt !== undefined)) {
    throw new Error("Prepared Direct Goal reservation has dispatched timestamps");
  }
  if (value.state !== "prepared" && dispatchedAt === undefined) {
    throw new Error("Dispatched Direct Goal reservation is missing dispatchedAtUnixMs");
  }
  if (value.state === "outcome_unknown" && unknownAt === undefined) {
    throw new Error("Unknown Direct Goal reservation is missing outcomeUnknownAtUnixMs");
  }
  if (value.state !== "outcome_unknown" && unknownAt !== undefined) {
    throw new Error("Direct Goal reservation has an unexpected outcomeUnknownAtUnixMs");
  }
  if (
    (dispatchedAt !== undefined && (dispatchedAt < preparedAt || dispatchedAt > step.updatedAt)) ||
    (unknownAt !== undefined &&
      (unknownAt < (dispatchedAt ?? preparedAt) || unknownAt > step.updatedAt))
  ) {
    throw new Error("Direct Goal reservation timestamps are inconsistent");
  }
  if (
    step.claim === undefined ||
    step.claim.claimantDigest !== claimantDigest ||
    step.claim.tokenDigest !== claimTokenDigest
  ) {
    throw new Error("Direct Goal reservation claim binding is invalid");
  }
  const provesOperationId =
    value.provesOperationId === undefined
      ? undefined
      : requiredUnknownIdentifier(
          value.provesOperationId,
          "goal.step.reservation.provesOperationId",
        );
  if ((value.role === "readback") !== (provesOperationId !== undefined)) {
    throw new Error("Direct Goal reservation proof binding is invalid");
  }
  const operationBinding = step.operationBindings.find(
    (binding) => binding.operationId === operationId,
  );
  if (
    operationBinding === undefined ||
    operationBinding.executionBindingDigest !== executionBindingDigest
  ) {
    throw new Error("Direct Goal reservation is missing its immutable operation binding");
  }
  if (value.role === "work") {
    if (step.stepState === "awaiting_readback") {
      throw new Error("Direct Goal work reservation is inconsistent with step state");
    }
    if (step.stepState !== "claimed") {
      throw new Error("Direct Goal work reservation requires a claimed step");
    }
  } else {
    const work = step.receipts.find(
      (receipt) => receipt.role === "work" && receipt.operationId === provesOperationId,
    );
    if (
      step.stepState !== "awaiting_readback" ||
      value.stateEffect !== "read" ||
      value.modelEffect !== "none" ||
      work === undefined ||
      work.resourceDigest !== resourceDigest
    ) {
      throw new Error("Direct Goal readback reservation is inconsistent");
    }
  }
  const expectedBindingDigest = executionBindingDigestFromParts({
    ownerDigest: step.ownerDigest,
    claimantDigest,
    claimTokenDigest,
    goalId: step.goalId,
    stepId: step.stepId,
    operationId,
    role: value.role,
    toolName,
    targetIdentity,
    resourceDigest,
    stateEffect: value.stateEffect,
    modelEffect: value.modelEffect,
    ...(provesOperationId === undefined ? {} : { provesOperationId }),
  });
  if (executionBindingDigest !== expectedBindingDigest) {
    throw new Error("Direct Goal reservation execution binding is invalid");
  }
  return value as unknown as StoredReservation;
}

function validateStepReceiptSequence(
  mode: DirectGoalStepMode,
  state: DirectGoalStepState,
  receipts: readonly StoredReceipt[],
): void {
  const work = receipts.filter((receipt) => receipt.role === "work");
  const readback = receipts.filter((receipt) => receipt.role === "readback");
  if (work.length > 1 || readback.length > 1) {
    throw new Error("Direct Goal receipt sequence is invalid");
  }
  if (state === "pending" || state === "claimed") {
    if (receipts.length !== 0)
      throw new Error("Incomplete Direct Goal step has unexpected receipts");
    return;
  }
  if (work.length !== 1) throw new Error("Direct Goal step is missing its work receipt");
  if (mode === "successful_call") {
    if (state !== "completed" || readback.length !== 0 || receipts.length !== 1) {
      throw new Error("Successful-call Direct Goal receipt sequence is invalid");
    }
    return;
  }
  if (work[0]?.stateEffect !== "mutate") {
    throw new Error("Mutation Direct Goal work receipt is not mutating");
  }
  if (state === "awaiting_readback") {
    if (readback.length !== 0 || receipts.length !== 1) {
      throw new Error("Awaiting-readback Direct Goal receipt sequence is invalid");
    }
    return;
  }
  if (state !== "completed" || readback.length !== 1 || receipts.length !== 2) {
    throw new Error("Mutation Direct Goal receipt sequence is invalid");
  }
  const proof = readback[0] as StoredReceipt;
  const mutation = work[0] as StoredReceipt;
  if (
    proof.stateEffect !== "read" ||
    proof.provesOperationId !== mutation.operationId ||
    proof.resourceDigest !== mutation.resourceDigest ||
    proof.recordedAtUnixMs < mutation.recordedAtUnixMs
  ) {
    throw new Error("Mutation Direct Goal readback proof is invalid");
  }
}

async function writeSnapshot(path: string, payload: SnapshotPayload): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const snapshot: StoredSnapshot = { ...payload, checksum: snapshotChecksum(payload) };
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${canonicalJson(snapshot)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function snapshotChecksum(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

function processCoreRegistry(): Map<string, CoreRegistryEntry> {
  const globalObject = globalThis as typeof globalThis & {
    [PROCESS_CORES_SYMBOL]?: Map<string, CoreRegistryEntry>;
  };
  const existing = globalObject[PROCESS_CORES_SYMBOL];
  if (existing !== undefined) return existing;
  const created = new Map<string, CoreRegistryEntry>();
  globalObject[PROCESS_CORES_SYMBOL] = created;
  return created;
}

function processPathKey(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) {
    throw new Error(`${label} contains missing or unknown fields`);
  }
}

function requiredUnknownText(value: unknown, name: string, maximum?: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return requiredText(value, name, maximum);
}

function requiredUnknownIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return requiredIdentifier(value, name);
}

function requiredUnknownOpaqueIdentity(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return requiredOpaqueIdentity(value, name);
}

function checkedDeadline(nowUnixMs: number, durationMs: number, name: string): number {
  const deadline = nowUnixMs + durationMs;
  if (!Number.isSafeInteger(deadline)) throw new Error(`${name} exceeds epoch millisecond range`);
  return deadline;
}

function requiredUnknownDigest(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return requiredDigest(value, name);
}

function requiredNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function requiredPositiveInteger(value: unknown, name: string): number {
  const integer = requiredNonNegativeInteger(value, name);
  if (integer < 1) throw new Error(`${name} must be a positive safe integer`);
  return integer;
}

function assertNativeContinuationReceipt(
  value: unknown,
  token: string,
  conversationUrl: string,
  accountSourceId: string | undefined,
): asserts value is DirectGoalNativeSendReceipt {
  if (!isObject(value)) throw new Error("DIRECT_GOAL_NATIVE_RECEIPT_INVALID");
  assertExactKeys(
    value,
    ["kind", "operationId", "threadId", "accountSourceId"],
    ["clientUserMessageId", "nativeMessages", "prompt", "dispatchState"],
    "nativeReceipt",
  );
  if (
    (value.kind !== "native_host_acknowledged" && value.kind !== "native_message_prepared") ||
    value.operationId !== `goal-continuation:${token}` ||
    value.threadId !== conversationUrl.slice("https://chatgpt.com/c/".length) ||
    accountSourceId === undefined ||
    value.accountSourceId !== accountSourceId
  )
    throw new Error("DIRECT_GOAL_NATIVE_RECEIPT_INVALID");
  if (
    value.kind === "native_message_prepared" &&
    (typeof value.clientUserMessageId !== "string" ||
      !value.clientUserMessageId ||
      typeof value.prompt !== "string" ||
      !isObject(value.nativeMessages) ||
      !isObject(value.nativeMessages.message) ||
      value.nativeMessages.message.id !== value.clientUserMessageId ||
      !isObject(value.nativeMessages.message.author) ||
      value.nativeMessages.message.author.role !== "user" ||
      (value.dispatchState !== "prepared" && value.dispatchState !== "dispatching"))
  )
    throw new Error("DIRECT_GOAL_NATIVE_RECEIPT_INVALID");
}

function optionalNonNegativeInteger(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : requiredNonNegativeInteger(value, name);
}
