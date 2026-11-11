export interface ChatGptForegroundActivityObservation {
  readonly callerProvenance?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly chatGptConversationIdSha256?: string | undefined;
  readonly workSessionBindingSha256?: string | undefined;
  readonly phase: "started" | "native" | "completed";
}

export type ChatGptForegroundRequestCompletion = Omit<
  ChatGptForegroundActivityObservation,
  "phase"
>;

export interface ChatGptForegroundActivityQuery {
  readonly chatGptConversationIdSha256?: string | undefined;
  readonly workSessionBindingSha256s?: readonly string[] | undefined;
}

export interface ChatGptForegroundActivitySnapshot {
  readonly active: boolean;
  readonly activeCallCount: number;
  readonly stage: ChatGptForegroundActivityStage;
  readonly quietUntilUnixMs?: number | undefined;
}

export interface ChatGptForegroundActivityTrackerOptions {
  readonly quietPeriodMs?: number;
  readonly now?: () => number;
}

export type ChatGptForegroundActivityStage = "active" | "settling" | "idle";

interface TrackedCall {
  readonly scopes: Set<string>;
}

interface ScopeState {
  readonly activeCorrelationIds: Set<string>;
  quietUntilUnixMs: number;
}

/**
 * Keeps Goal continuation away from a live Web turn in the same conversation.
 * Independent Web conversations retain independent admission and settle windows.
 */
export class ChatGptForegroundActivityTracker {
  readonly #calls = new Map<string, TrackedCall>();
  readonly #scopes = new Map<string, ScopeState>();
  readonly #quietPeriodMs: number;
  readonly #now: () => number;
  readonly #startupQuietUntilUnixMs: number;

  constructor(options: ChatGptForegroundActivityTrackerOptions = {}) {
    this.#quietPeriodMs = nonNegativeSafeInteger(
      options.quietPeriodMs ?? 180_000,
      "ChatGPT foreground quiet period",
    );
    this.#now = options.now ?? Date.now;
    this.#startupQuietUntilUnixMs = this.#now() + this.#quietPeriodMs;
  }

  observe(observation: ChatGptForegroundActivityObservation): void {
    if (observation.callerProvenance !== "chatgpt_conversation") return;
    const correlationId = observation.correlationId;
    if (correlationId === undefined || correlationId.length === 0) return;
    if (observation.phase === "completed") {
      this.complete(observation);
      return;
    }
    if (observation.phase === "native") {
      this.attribute(observation);
      return;
    }
    const call = this.#calls.get(correlationId) ?? { scopes: new Set<string>() };
    this.#calls.set(correlationId, call);
    const scopes = activityScopeKeys(observation);
    if (scopes.length === 0) scopes.push(`request:${correlationId}`);
    this.#attach(correlationId, call, scopes);
  }

  /** Adds request identity learned after the progress-start event. */
  attribute(observation: ChatGptForegroundRequestCompletion): void {
    if (observation.callerProvenance !== "chatgpt_conversation") return;
    const correlationId = observation.correlationId;
    if (correlationId === undefined || correlationId.length === 0) return;
    const call = this.#calls.get(correlationId);
    if (call === undefined) return;
    this.#attach(correlationId, call, activityScopeKeys(observation));
  }

  /** HTTP response completion is authoritative when a progress-complete event was lost. */
  complete(observation: ChatGptForegroundRequestCompletion): void {
    if (observation.callerProvenance !== "chatgpt_conversation") return;
    const correlationId = observation.correlationId;
    if (correlationId === undefined || correlationId.length === 0) return;
    const call = this.#calls.get(correlationId) ?? { scopes: new Set<string>() };
    this.#attach(correlationId, call, activityScopeKeys(observation));
    if (call.scopes.size === 0) return;
    this.#calls.delete(correlationId);
    const quietUntilUnixMs = this.#now() + this.#quietPeriodMs;
    for (const scope of call.scopes) {
      const state = this.#scope(scope);
      state.activeCorrelationIds.delete(correlationId);
      state.quietUntilUnixMs = Math.max(state.quietUntilUnixMs, quietUntilUnixMs);
    }
  }

  snapshot(query: ChatGptForegroundActivityQuery): ChatGptForegroundActivitySnapshot {
    const keys = activityScopeKeys(query);
    const states = keys.map((key) => this.#scope(key));
    const activeIds = new Set(states.flatMap((state) => [...state.activeCorrelationIds]));
    const now = this.#now();
    const quietUntilUnixMs = states.reduce(
      (latest, state) => Math.max(latest, state.quietUntilUnixMs),
      0,
    );
    const stage: ChatGptForegroundActivityStage =
      activeIds.size > 0 ? "active" : now < quietUntilUnixMs ? "settling" : "idle";
    return {
      active: stage !== "idle",
      activeCallCount: activeIds.size,
      stage,
      ...(stage === "settling" ? { quietUntilUnixMs } : {}),
    };
  }

  #attach(correlationId: string, call: TrackedCall, scopes: readonly string[]): void {
    for (const scope of scopes) {
      if (call.scopes.has(scope)) continue;
      call.scopes.add(scope);
      this.#scope(scope).activeCorrelationIds.add(correlationId);
    }
  }

  #scope(key: string): ScopeState {
    let state = this.#scopes.get(key);
    if (state === undefined) {
      state = {
        activeCorrelationIds: new Set<string>(),
        quietUntilUnixMs: this.#startupQuietUntilUnixMs,
      };
      this.#scopes.set(key, state);
    }
    return state;
  }
}

function activityScopeKeys(input: {
  readonly chatGptConversationIdSha256?: string | undefined;
  readonly workSessionBindingSha256?: string | undefined;
  readonly workSessionBindingSha256s?: readonly string[] | undefined;
}): string[] {
  const keys: string[] = [];
  if (validDigest(input.chatGptConversationIdSha256)) {
    keys.push(`conversation:${input.chatGptConversationIdSha256}`);
  }
  for (const digest of [
    ...(input.workSessionBindingSha256 === undefined ? [] : [input.workSessionBindingSha256]),
    ...(input.workSessionBindingSha256s ?? []),
  ]) {
    if (validDigest(digest)) keys.push(`work-session:${digest}`);
  }
  return [...new Set(keys)];
}

function validDigest(value: string | undefined): value is string {
  return value !== undefined && /^[a-f0-9]{64}$/u.test(value);
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}
