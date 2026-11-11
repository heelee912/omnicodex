import { createHash, randomUUID } from "node:crypto";
import type { BrowserNativeCallContext, BrowserNativeExecutor } from "./browser-native-executor.js";

export type BrowserActivityLifecycleExecutor = Pick<
  BrowserNativeExecutor,
  "beginActivity" | "finishActivity"
> &
  Partial<Pick<BrowserNativeExecutor, "finishCurrentActivity">>;

export interface BrowserActivityLifecycleCoordinator {
  /**
   * Validate the coordinator's lifecycle for every authenticated tool call.
   * Request/task metadata alone must not end a browser-owning model turn.
   */
  observeActivityBoundary(context: BrowserNativeCallContext): Promise<void>;
  coordinate(
    executor: BrowserActivityLifecycleExecutor,
    context: BrowserNativeCallContext,
  ): Promise<BrowserNativeCallContext>;
  /** Hold the activity while a queued or executing browser call owns it. */
  runWithActivity?<T>(
    executor: BrowserActivityLifecycleExecutor,
    context: BrowserNativeCallContext,
    operation: (context: BrowserNativeCallContext) => Promise<T>,
  ): Promise<T>;
  /** Explicit owner-scoped Stop; unlike transport close this is a real ending. */
  finishCurrentActivity?(
    executor: BrowserActivityLifecycleExecutor,
    context: BrowserNativeCallContext,
    scheduleCleanup?: (cleanup: () => Promise<void>) => Promise<void>,
  ): Promise<void>;
  close(options?: { readonly preserveActivities?: boolean }): Promise<void>;
}

export interface ChatGptBrowserActivityCoordinatorOptions {
  /**
   * Exact current task status for only the requested conversations. Missing
   * or failed reads must be returned as unknown, never as idle.
   */
  readonly readActiveConversationIds: (
    signal?: AbortSignal,
    requiredConversationIds?: readonly string[],
  ) => Promise<readonly string[] | BrowserConversationActivityObservation>;
  /** Pending activities only; one bounded observation is in flight at a time. */
  readonly observationIntervalMs?: number;
  readonly onDiagnostic?: (event: Readonly<Record<string, unknown>>) => void;
}

export interface BrowserConversationActivityObservation {
  readonly activeConversationIds: readonly string[];
  /** Unknown is not idle and cannot authorize cleanup. */
  readonly unknownConversationIds: readonly string[];
}

interface BrowserActivityRecord {
  readonly key: string;
  conversationId?: string;
  readonly activityBinding: string;
  executor: BrowserActivityLifecycleExecutor;
  readonly context: Omit<BrowserNativeCallContext, "activityBinding">;
  revision: number;
  callsInFlight: number;
  idleObservations: number;
  lastObserved: number;
  retiring?: boolean;
  restorePending?: boolean;
  drain?: Promise<void>;
  resolveDrain?: () => void;
}

const CHATGPT_CONVERSATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Retires native ownership only after exact idle observations and no browser calls. */
export class ChatGptBrowserActivityCoordinator implements BrowserActivityLifecycleCoordinator {
  readonly #options: Required<
    Pick<ChatGptBrowserActivityCoordinatorOptions, "readActiveConversationIds">
  > &
    Omit<ChatGptBrowserActivityCoordinatorOptions, "readActiveConversationIds">;
  readonly #records = new Map<string, BrowserActivityRecord>();
  readonly #operations = new Map<string, Promise<void>>();
  readonly #callSettlements = new Set<Promise<void>>();
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #observationTimer: ReturnType<typeof setTimeout> | undefined;
  #observationFlight: Promise<void> | undefined;
  #observationController: AbortController | undefined;
  #observationFailures = 0;
  #observationSequence = 0;

  constructor(options: ChatGptBrowserActivityCoordinatorOptions) {
    const observationIntervalMs = options.observationIntervalMs ?? 30_000;
    if (!Number.isSafeInteger(observationIntervalMs) || observationIntervalMs <= 0) {
      throw new TypeError("Browser activity observation interval must be a positive safe integer");
    }
    this.#options = { ...options, observationIntervalMs };
  }

  async observeActivityBoundary(context: BrowserNativeCallContext): Promise<void> {
    if (this.#closed) throw new Error("Browser activity coordinator is closed");
    // Invocation metadata identifies requests and durable MCP tasks, not
    // browser sessions. Exact task completion is observed separately.
    const conversationId = normalizedConversationId(context.chatGptConversationId);
    if (conversationId === undefined) return;
    const key = browserActivityRecordKey(conversationId, lifecycleContext(context));
    await this.#enqueue(key, async () => {
      const record = this.#records.get(key);
      if (record === undefined) return;
      if (record.conversationId !== undefined && record.conversationId !== conversationId) {
        throw Object.assign(new Error("Browser work-session conversation identity conflicts"), {
          code: "BROWSER_ACTIVITY_CONVERSATION_MISMATCH",
        });
      }
      record.conversationId = conversationId;
      record.revision += 1;
      record.idleObservations = 0;
    });
    this.#scheduleObservation();
  }

  async coordinate(
    executor: BrowserActivityLifecycleExecutor,
    context: BrowserNativeCallContext,
  ): Promise<BrowserNativeCallContext> {
    return this.#coordinate(executor, context, false);
  }

  async runWithActivity<T>(
    executor: BrowserActivityLifecycleExecutor,
    context: BrowserNativeCallContext,
    operation: (context: BrowserNativeCallContext) => Promise<T>,
  ): Promise<T> {
    let settled!: () => void;
    const settlement = new Promise<void>((resolve) => {
      settled = resolve;
    });
    this.#callSettlements.add(settlement);
    try {
      return await this.#runWithActivity(executor, context, operation);
    } finally {
      this.#callSettlements.delete(settlement);
      settled();
    }
  }

  async #runWithActivity<T>(
    executor: BrowserActivityLifecycleExecutor,
    context: BrowserNativeCallContext,
    operation: (context: BrowserNativeCallContext) => Promise<T>,
  ): Promise<T> {
    const coordinated = await this.#coordinate(executor, context, true);
    try {
      return await operation(coordinated);
    } finally {
      const key = browserActivityRecordKey(
        normalizedConversationId(context.chatGptConversationId),
        lifecycleContext(context),
      );
      await this.#enqueue(key, async () => {
        const record = this.#records.get(key);
        if (record === undefined || record.activityBinding !== coordinated.activityBinding) return;
        record.callsInFlight -= 1;
        if (record.callsInFlight === 0) record.resolveDrain?.();
        record.revision += 1;
        record.idleObservations = 0;
      });
      this.#scheduleObservation();
    }
  }

  async #coordinate(
    executor: BrowserActivityLifecycleExecutor,
    context: BrowserNativeCallContext,
    reserveCall: boolean,
  ): Promise<BrowserNativeCallContext> {
    if (this.#closed) throw new Error("Browser activity coordinator is closed");
    const conversationId = normalizedConversationId(context.chatGptConversationId);
    if (!canCoordinateChatGptActivity(context, conversationId)) {
      // A generic MCP caller has no authoritative ChatGPT task identity. Do
      // not guess a model turn from transport/request ids or apply a timer.
      return withoutExactConversationId(context);
    }
    const stableContext = lifecycleContext(context);
    const key = browserActivityRecordKey(conversationId, stableContext);
    if (this.#records.get(key)?.retiring === true) throw new Error("BROWSER_ACTIVITY_RETIRING");
    const activityBinding = await this.#enqueue(key, async () => {
      if (this.#closed) throw new Error("Browser activity coordinator is closed");
      const existing = this.#records.get(key);
      if (existing !== undefined) {
        if (existing.retiring === true) throw new Error("BROWSER_ACTIVITY_RETIRING");
        if (
          conversationId !== undefined &&
          existing.conversationId !== undefined &&
          existing.conversationId !== conversationId
        ) {
          throw Object.assign(new Error("Browser work-session conversation identity conflicts"), {
            code: "BROWSER_ACTIVITY_CONVERSATION_MISMATCH",
          });
        }
        await executor.beginActivity(existing.activityBinding, {
          ...stableContext,
          continueExistingActivity: true,
        });
        // HTTP reconnection creates a new handle around the same durable
        // work-session lease. Object identity is not a model-turn boundary.
        // Keep the previous owner reachable until adoption has succeeded.
        existing.executor = executor;
        // Exact provider attribution can arrive after opaque requests. Adopt
        // it on the existing owner/work-session activity, not a second record
        // that would leave the original browser lifecycle unobservable.
        if (conversationId !== undefined) existing.conversationId = conversationId;
        existing.revision += 1;
        existing.idleObservations = 0;
        if (reserveCall) existing.callsInFlight += 1;
        return existing.activityBinding;
      }
      const created: BrowserActivityRecord = {
        key,
        ...(conversationId === undefined ? {} : { conversationId }),
        activityBinding: `turn:chatgpt:${randomUUID()}`,
        executor,
        context: stableContext,
        revision: 0,
        callsInFlight: reserveCall ? 1 : 0,
        idleObservations: 0,
        lastObserved: 0,
      };
      await executor.beginActivity(created.activityBinding, {
        ...stableContext,
        continueExistingActivity: true,
      });
      this.#records.set(key, created);
      return created.activityBinding;
    });
    this.#scheduleObservation();
    return {
      ...withoutExactConversationId(context),
      activityBinding,
      continueExistingActivity: true,
    };
  }

  async finishCurrentActivity(
    executor: BrowserActivityLifecycleExecutor,
    context: BrowserNativeCallContext,
    scheduleCleanup: (cleanup: () => Promise<void>) => Promise<void> = (cleanup) => cleanup(),
  ): Promise<void> {
    if (this.#closed) throw new Error("Browser activity coordinator is closed");
    const conversationId = normalizedConversationId(context.chatGptConversationId);
    const stableContext = lifecycleContext(context);
    const key = browserActivityRecordKey(conversationId, stableContext);
    const record = await this.#enqueue(key, async () => {
      const current = this.#records.get(key);
      if (current === undefined) {
        // A replacement daemon may receive Stop before its first browser call.
        // Reject admission without holding this queue while waiting for a
        // scheduler lane: CodeMode may already own that lane and be about to
        // register its activity. It must be able to reject and release the lane.
        const restored: BrowserActivityRecord = {
          key,
          activityBinding: `turn:chatgpt:${randomUUID()}`,
          executor,
          context: stableContext,
          revision: 0,
          callsInFlight: 0,
          idleObservations: 0,
          lastObserved: 0,
          retiring: true,
          restorePending: true,
        };
        this.#records.set(key, restored);
        return restored;
      }
      if (
        conversationId !== undefined &&
        current.conversationId !== undefined &&
        current.conversationId !== conversationId
      ) {
        throw new Error("BROWSER_ACTIVITY_CONVERSATION_MISMATCH");
      }
      current.retiring = true;
      if (current.callsInFlight > 0 && current.drain === undefined) {
        current.drain = new Promise<void>((resolve) => {
          current.resolveDrain = resolve;
        });
      }
      return current;
    });
    await record.drain;
    // Reserve native scheduler resources only after admitted calls settle.
    // A queued call may hold an activity reservation while awaiting that same lock.
    await scheduleCleanup(() => this.#enqueue(key, () => this.#retireRecord(record)));
  }

  async close(options: { readonly preserveActivities?: boolean } = {}): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    if (this.#observationTimer !== undefined) clearTimeout(this.#observationTimer);
    this.#observationTimer = undefined;
    this.#observationController?.abort();
    const operation = (async () => {
      await this.#observationFlight;
      await Promise.all([...this.#operations.values()]);
      // Stopping the transport/observer does not complete a remote model
      // turn. The replacement executor adopts its durable browser activity.
      if (options.preserveActivities === true) {
        this.#records.clear();
        return;
      }
      // A real shutdown must not detach tabs while an already-admitted tool
      // still owns them. The caller's cancellation settles that tool first;
      // elapsed time alone never authorizes native browser cleanup.
      await Promise.all([...this.#callSettlements]);
      const results = await Promise.allSettled(
        [...this.#records.values()].map((record) =>
          this.#enqueue(record.key, () => this.#retireRecord(record)),
        ),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "Browser activity cleanup remains pending");
      }
    })();
    const settled = operation.finally(() => {
      if (this.#closePromise === settled) this.#closePromise = undefined;
    });
    this.#closePromise = settled;
    return settled;
  }

  async #retireRecord(record: BrowserActivityRecord): Promise<void> {
    if (this.#records.get(record.key) !== record) return;
    if (record.restorePending === true)
      await record.executor.finishCurrentActivity?.(record.context);
    else await settleRecord(record, this.#options.onDiagnostic);
    if (this.#records.get(record.key) === record) this.#records.delete(record.key);
  }

  #scheduleObservation(): void {
    if (
      this.#closed ||
      this.#observationTimer !== undefined ||
      this.#observationFlight !== undefined ||
      ![...this.#records.values()].some((record) => record.conversationId !== undefined)
    )
      return;
    const delay = Math.min(
      (this.#options.observationIntervalMs ?? 30_000) * 2 ** this.#observationFailures,
      300_000,
    );
    this.#observationTimer = setTimeout(() => {
      this.#observationTimer = undefined;
      const flight = this.#observeCompletion().finally(() => {
        if (this.#observationFlight === flight) this.#observationFlight = undefined;
        this.#scheduleObservation();
      });
      this.#observationFlight = flight;
    }, delay);
    this.#observationTimer.unref?.();
  }

  async #observeCompletion(): Promise<void> {
    const candidates = [...this.#records.values()]
      .filter((record) => record.conversationId !== undefined && record.callsInFlight === 0)
      .sort((left, right) => left.lastObserved - right.lastObserved)
      .slice(0, 8)
      .map((record) => ({ record, revision: record.revision }));
    if (candidates.length === 0 || this.#closed) return;
    const controller = new AbortController();
    this.#observationController = controller;
    try {
      const ids = [
        ...new Set(
          candidates.flatMap(({ record }) =>
            record.conversationId === undefined ? [] : [record.conversationId],
          ),
        ),
      ];
      const result = await this.#options.readActiveConversationIds(controller.signal, ids);
      if (this.#closed || controller.signal.aborted) return;
      const observation: BrowserConversationActivityObservation = Array.isArray(result)
        ? { activeConversationIds: result, unknownConversationIds: [] }
        : (result as BrowserConversationActivityObservation);
      const active = new Set(observation.activeConversationIds);
      const unknown = new Set(observation.unknownConversationIds);
      this.#observationFailures = ids.every((id) => unknown.has(id))
        ? Math.min(this.#observationFailures + 1, 8)
        : 0;
      // Serial settlement keeps cleanup hooks bounded as well as observations.
      for (const { record, revision } of candidates) {
        await this.#enqueue(record.key, async () => {
          if (this.#closed || this.#records.get(record.key) !== record) return;
          record.lastObserved = ++this.#observationSequence;
          if (record.revision !== revision || record.callsInFlight !== 0) return;
          const id = record.conversationId;
          if (id === undefined) return;
          if (active.has(id) || unknown.has(id)) {
            record.idleObservations = 0;
            return;
          }
          record.idleObservations += 1;
          // A single stale inventory must not retire a newly submitted reply.
          if (record.idleObservations >= 2) await this.#retireRecord(record);
        });
      }
    } catch (error) {
      if (this.#closed || controller.signal.aborted) return;
      this.#observationFailures = Math.min(this.#observationFailures + 1, 8);
      for (const { record } of candidates) record.idleObservations = 0;
      this.#options.onDiagnostic?.({
        method: "omnicodex/browserActivityObservationFailed",
        params: { message: toError(error).message },
      });
    } finally {
      if (this.#observationController === controller) this.#observationController = undefined;
    }
  }

  #enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#operations.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.#operations.get(key) === settled) this.#operations.delete(key);
      });
    this.#operations.set(key, settled);
    return result;
  }
}

function lifecycleContext(
  context: BrowserNativeCallContext,
): Omit<BrowserNativeCallContext, "activityBinding"> {
  return {
    ...(context.contextThreadId === undefined ? {} : { contextThreadId: context.contextThreadId }),
    ...(context.ownerBinding === undefined ? {} : { ownerBinding: context.ownerBinding }),
    ...(context.workSessionBinding === undefined
      ? {}
      : { workSessionBinding: context.workSessionBinding }),
    ...(context.callerSessionId === undefined ? {} : { callerSessionId: context.callerSessionId }),
    ...(context.callerProvenance === undefined
      ? {}
      : { callerProvenance: context.callerProvenance }),
    ...(context.chatGptConversationIdSha256 === undefined
      ? {}
      : { chatGptConversationIdSha256: context.chatGptConversationIdSha256 }),
    ...(context.callerActivityBinding === undefined
      ? {}
      : { callerActivityBinding: context.callerActivityBinding }),
    ...(context.callerActivityBindingKind === undefined
      ? {}
      : { callerActivityBindingKind: context.callerActivityBindingKind }),
  };
}

function withoutExactConversationId(context: BrowserNativeCallContext): BrowserNativeCallContext {
  const { chatGptConversationId: _chatGptConversationId, ...safe } = context;
  return safe;
}

function browserActivityRecordKey(
  conversationId: string | undefined,
  context: Omit<BrowserNativeCallContext, "activityBinding">,
): string {
  const stableSession = context.workSessionBinding ?? context.callerSessionId;
  return createHash("sha256")
    .update(
      JSON.stringify([
        context.ownerBinding && stableSession
          ? "authenticated-work-session"
          : (conversationId ?? "opaque-chatgpt-session"),
        context.ownerBinding ?? null,
        stableSession ?? null,
        context.contextThreadId ?? null,
      ]),
      "utf8",
    )
    .digest("hex");
}

function canCoordinateChatGptActivity(
  context: BrowserNativeCallContext,
  conversationId: string | undefined,
): boolean {
  if (conversationId !== undefined) return true;
  return (
    context.callerProvenance === "chatgpt_conversation" &&
    typeof context.ownerBinding === "string" &&
    context.ownerBinding.length > 0 &&
    ((typeof context.workSessionBinding === "string" && context.workSessionBinding.length > 0) ||
      (typeof context.callerSessionId === "string" && context.callerSessionId.length > 0))
  );
}

function normalizedConversationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLocaleLowerCase("en-US");
  return CHATGPT_CONVERSATION_ID.test(normalized) ? normalized : undefined;
}

async function settleRecord(
  record: BrowserActivityRecord,
  onDiagnostic: ChatGptBrowserActivityCoordinatorOptions["onDiagnostic"],
): Promise<void> {
  try {
    await record.executor.finishActivity(record.activityBinding, record.context);
  } catch (error) {
    onDiagnostic?.({
      method: "omnicodex/browserActivityCleanupFailed",
      params: {
        ...(record.conversationId === undefined
          ? { conversationIdentity: "opaque_openai_session" }
          : {
              conversationIdSha256: createHash("sha256")
                .update(record.conversationId, "utf8")
                .digest("hex"),
            }),
        message: toError(error).message,
      },
    });
    throw error;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
