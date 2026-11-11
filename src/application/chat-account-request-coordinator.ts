import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class ChatAccountRateLimitError extends Error {
  readonly status = 429;
  constructor(
    readonly retryAtUnixMs: number,
    readonly nativeError: unknown,
  ) {
    super(`CHAT_ACCOUNT_RATE_LIMITED: retry at ${new Date(retryAtUnixMs).toISOString()}`, {
      cause: nativeError,
    });
  }
}
type Account = {
  tail: Promise<void>;
  retryAt: number;
  serverRetryAt: number;
  backgroundNextAt: number;
  failures: number;
  recovering: boolean;
  foregroundWaiters: number;
  nextAt: number;
  generation: number;
  observedAt: number;
  error?: unknown;
};

export interface ChatAccountCooldownSnapshot {
  readonly observedAtUnixMs: number;
  readonly retryAtUnixMs: number;
  /** Present only when the service supplied an explicit retry deadline. */
  readonly serverRetryAtUnixMs?: number;
}

export interface ChatAccountBackgroundReservation {
  readonly admitted: boolean;
  readonly retryAtUnixMs: number;
}
type Flight = {
  promise: Promise<unknown>;
  abort: AbortController;
  subscribers: number;
  settled: boolean;
};

/** Shared native Chat request boundary. No automatic replay, account scans or completed-result cache. */
export class ChatAccountRequestCoordinator {
  readonly #accounts = new Map<string, Account>();
  #loaded: Promise<void> | undefined;
  #writes: Promise<void> = Promise.resolve();
  constructor(
    private readonly options: {
      now?: () => number;
      spacingMs?: number;
      statePath?: string;
      recoveryProbeGuardMs?: number;
    } = {},
  ) {}
  #now(): number {
    return this.options.now?.() ?? Date.now();
  }

  #account(accountId: string): Account {
    const key = createHash("sha256").update(accountId).digest("hex");
    let state = this.#accounts.get(key);
    if (state === undefined) {
      state = {
        tail: Promise.resolve(),
        retryAt: 0,
        serverRetryAt: 0,
        backgroundNextAt: 0,
        failures: 0,
        recovering: false,
        foregroundWaiters: 0,
        nextAt: 0,
        generation: 0,
        observedAt: -1,
      };
      this.#accounts.set(key, state);
    }
    return state;
  }

  async readCooldown(accountId: string): Promise<ChatAccountCooldownSnapshot | undefined> {
    this.#loaded ??= this.#load();
    await this.#loaded;
    const state = this.#account(accountId);
    return state.retryAt > this.#now()
      ? {
          observedAtUnixMs: Math.max(0, state.observedAt),
          retryAtUnixMs: state.retryAt,
          ...(state.serverRetryAt > this.#now()
            ? { serverRetryAtUnixMs: state.serverRetryAt }
            : {}),
        }
      : undefined;
  }

  async observeCooldown(accountId: string, snapshot: ChatAccountCooldownSnapshot): Promise<void> {
    if (
      ![snapshot.observedAtUnixMs, snapshot.retryAtUnixMs].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ) ||
      snapshot.retryAtUnixMs < snapshot.observedAtUnixMs ||
      (snapshot.serverRetryAtUnixMs !== undefined &&
        (!Number.isSafeInteger(snapshot.serverRetryAtUnixMs) ||
          snapshot.serverRetryAtUnixMs < snapshot.observedAtUnixMs ||
          snapshot.serverRetryAtUnixMs > snapshot.retryAtUnixMs))
    )
      throw new Error("CHAT_ACCOUNT_COOLDOWN_SNAPSHOT_INVALID");
    this.#loaded ??= this.#load();
    await this.#loaded;
    const state = this.#account(accountId);
    if (
      snapshot.observedAtUnixMs < state.observedAt ||
      (snapshot.observedAtUnixMs === state.observedAt &&
        (state.failures === 0 ||
          state.retryAt <= this.#now() ||
          (snapshot.retryAtUnixMs <= state.retryAt &&
            (snapshot.serverRetryAtUnixMs ?? 0) <= state.serverRetryAt)))
    )
      return;
    const previousFailures = state.failures;
    const newNativeRejection = snapshot.observedAtUnixMs > state.observedAt;
    state.observedAt = snapshot.observedAtUnixMs;
    state.generation++;
    const localRetryAt =
      snapshot.serverRetryAtUnixMs === undefined && newNativeRejection
        ? snapshot.observedAtUnixMs + localRateLimitBackoffMs(previousFailures)
        : 0;
    state.retryAt = Math.max(state.retryAt, snapshot.retryAtUnixMs, localRetryAt);
    state.serverRetryAt = Math.max(state.serverRetryAt, snapshot.serverRetryAtUnixMs ?? 0);
    // Oracle reports the browser request's native 429 as a durable snapshot.
    // A newer observation is another rejection and advances the account-wide
    // fallback. Replaying the same observation may extend its exact deadline,
    // but must not advance the streak twice.
    state.failures = newNativeRejection ? previousFailures + 1 : Math.max(previousFailures, 1);
    state.recovering = true;
    await this.#save();
  }

  /** Reserves one account-wide slot for low-priority background recovery. */
  async reserveBackgroundRequest(
    accountId: string,
    minimumIntervalMs: number,
  ): Promise<ChatAccountBackgroundReservation> {
    if (!Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs <= 0)
      throw new Error("CHAT_ACCOUNT_BACKGROUND_INTERVAL_INVALID");
    this.#loaded ??= this.#load();
    await this.#loaded;
    const state = this.#account(accountId);
    const now = this.#now();
    const retryAtUnixMs = Math.max(state.retryAt, state.backgroundNextAt);
    // A user-directed exact read has already joined this account's queue. Let
    // it claim the next provider-safe slot instead of letting recurring
    // background recovery perpetually win the boundary race.
    if (state.foregroundWaiters > 0)
      return {
        admitted: false,
        retryAtUnixMs: Math.max(retryAtUnixMs, now + minimumIntervalMs),
      };
    if (retryAtUnixMs > now) return { admitted: false, retryAtUnixMs };
    state.backgroundNextAt = now + minimumIntervalMs;
    await this.#save();
    return { admitted: true, retryAtUnixMs: state.backgroundNextAt };
  }

  /**
   * Waits for and atomically claims the next account-wide provider-safe slot.
   * Background recovery yields while this reservation is pending.
   */
  async reserveForegroundRequest(
    accountId: string,
    minimumIntervalMs: number,
    signal?: AbortSignal,
  ): Promise<ChatAccountBackgroundReservation> {
    if (!Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs <= 0)
      throw new Error("CHAT_ACCOUNT_BACKGROUND_INTERVAL_INVALID");
    signal?.throwIfAborted();
    this.#loaded ??= this.#load();
    await this.#loaded;
    const state = this.#account(accountId);
    const boundary = signal ?? new AbortController().signal;
    state.foregroundWaiters += 1;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const now = this.#now();
        const retryAtUnixMs = Math.max(state.retryAt, state.backgroundNextAt);
        if (retryAtUnixMs > now) {
          await delay(retryAtUnixMs - now, boundary);
          continue;
        }
        state.backgroundNextAt = now + minimumIntervalMs;
        await this.#save();
        return { admitted: true, retryAtUnixMs: state.backgroundNextAt };
      }
    } finally {
      state.foregroundWaiters -= 1;
    }
  }

  /** Serializes the first foreground or Oracle read after an account cooldown. */
  async reserveRecoveryRequest(
    accountId: string,
    minimumIntervalMs: number,
  ): Promise<ChatAccountBackgroundReservation> {
    if (!Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs <= 0)
      throw new Error("CHAT_ACCOUNT_BACKGROUND_INTERVAL_INVALID");
    this.#loaded ??= this.#load();
    await this.#loaded;
    const state = this.#account(accountId);
    const now = this.#now();
    // Recovery is still background work. If a user-directed Goal or exact
    // read is already waiting, do not let a recovery wakeup renew the shared
    // interval before that foreground caller can claim it.
    if (state.foregroundWaiters > 0)
      return {
        admitted: false,
        retryAtUnixMs: Math.max(this.#requestNotBefore(state), now + minimumIntervalMs),
      };
    if (!state.recovering) return { admitted: true, retryAtUnixMs: now };
    const retryAtUnixMs = this.#requestNotBefore(state);
    if (retryAtUnixMs > now) return { admitted: false, retryAtUnixMs };
    state.backgroundNextAt = now + minimumIntervalMs;
    await this.#save();
    return { admitted: true, retryAtUnixMs: state.backgroundNextAt };
  }

  run<T>(
    accountId: string,
    perform: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    cooldownMode: "wait" | "report" = "wait",
  ): Promise<T> {
    signal?.throwIfAborted();
    const state = this.#account(accountId);
    const flight: Flight = {
      promise: Promise.resolve(),
      abort: new AbortController(),
      subscribers: 0,
      settled: false,
    };
    const previous = state.tail;
    let releaseRequest!: () => void;
    const requestReleased = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    state.tail = previous.catch(() => undefined).then(() => requestReleased);
    const promise = previous.then(async () => {
      try {
        this.#loaded ??= this.#load();
        await this.#loaded;
        flight.abort.signal.throwIfAborted();
        await this.#waitForCooldown(state, flight.abort.signal, cooldownMode);
        await delay(Math.max(0, state.nextAt - this.#now()), flight.abort.signal);
        flight.abort.signal.throwIfAborted();
        await this.#waitForCooldown(state, flight.abort.signal, cooldownMode);
        const recovery = state.recovering;
        const recoveryProbeGuardMs = this.options.recoveryProbeGuardMs ?? 0;
        if (recovery && recoveryProbeGuardMs > 0) {
          state.backgroundNextAt = Math.max(
            state.backgroundNextAt,
            this.#now() + recoveryProbeGuardMs,
          );
          await this.#save();
        }
        state.nextAt = this.#now() + (this.options.spacingMs ?? 0);
        const generation = state.generation;
        // Keep one native request in flight per account. Start spacing alone
        // still accumulates outstanding requests when a response stalls.
        // Caller cancellation must not release this slot before native I/O
        // settles, even when the provider does not honor its abort signal.
        try {
          const result = await perform(flight.abort.signal);
          const limit = rateLimit(result, this.#now());
          if (limit !== undefined) await this.#limited(state, result, limit);
          else if (state.failures > 0 && state.generation === generation) {
            const resetFailureStreak = this.#now() - state.observedAt >= 5 * 60_000;
            state.retryAt = 0;
            state.serverRetryAt = 0;
            state.recovering = false;
            if (resetFailureStreak) state.failures = 0;
            state.error = undefined;
            await this.#save();
          }
          return result;
        } catch (error) {
          const limit = rateLimit(error, this.#now());
          if (limit !== undefined) await this.#limited(state, error, limit);
          throw error;
        }
      } finally {
        // Loading, cooldown and spacing can all fail before native I/O starts.
        // None may strand the account queue after a cancelled observation.
        releaseRequest();
      }
    });
    flight.promise = promise;
    void promise.then(
      () => finish(),
      () => finish(),
    );
    const finish = () => {
      flight.settled = true;
    };
    return this.#subscribe(flight, signal) as Promise<T>;
  }

  async #limited(state: Account, error: unknown, detectedRetryAt: number): Promise<void> {
    const now = this.#now();
    const serverRetryAt = explicitServerRetryAt(error, now);
    const retryAt =
      serverRetryAt ??
      (detectedRetryAt > now ? detectedRetryAt : now + localRateLimitBackoffMs(state.failures));
    state.observedAt = Math.max(state.observedAt, now);
    state.generation++;
    state.failures++;
    state.recovering = true;
    state.retryAt = Math.max(retryAt, state.retryAt);
    state.serverRetryAt = Math.max(state.serverRetryAt, serverRetryAt ?? 0);
    state.error = error;
    await this.#save();
  }

  async #waitForCooldown(
    state: Account,
    signal: AbortSignal,
    mode: "wait" | "report",
  ): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const retryAt = this.#requestNotBefore(state);
      const remaining = retryAt - this.#now();
      if (remaining <= 0) return;
      if (mode === "report") throw new ChatAccountRateLimitError(retryAt, state.error);
      await delay(remaining, signal);
    }
  }

  #requestNotBefore(state: Account): number {
    return Math.max(state.retryAt, state.recovering ? state.backgroundNextAt : 0);
  }

  async #load(): Promise<void> {
    if (!this.options.statePath) return;
    let saved: unknown;
    try {
      saved = JSON.parse(await readFile(this.options.statePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const snapshot = saved as {
      version: number;
      accounts: Record<
        string,
        {
          retryAt: number;
          serverRetryAt?: number;
          backgroundNextAt?: number;
          failures: number;
          observedAt?: number;
        }
      >;
    };
    if (
      ![1, 2, 3, 4].includes(snapshot.version) ||
      !snapshot.accounts ||
      typeof snapshot.accounts !== "object"
    )
      throw new Error("CHAT_ACCOUNT_COOLDOWN_STATE_INVALID");
    const migrationRequired = snapshot.version < 4;
    for (const [key, row] of Object.entries(snapshot.accounts)) {
      if (
        !/^[a-f0-9]{64}$/.test(key) ||
        !Number.isSafeInteger(row.retryAt) ||
        row.retryAt < 0 ||
        !Number.isSafeInteger(row.failures) ||
        row.failures < 0 ||
        (snapshot.version >= 2 &&
          (!Number.isSafeInteger(row.observedAt) || (row.observedAt ?? -1) < 0)) ||
        (snapshot.version >= 3 &&
          (!Number.isSafeInteger(row.serverRetryAt) ||
            (row.serverRetryAt ?? -1) < 0 ||
            (row.serverRetryAt ?? 0) > row.retryAt)) ||
        (snapshot.version >= 4 &&
          (!Number.isSafeInteger(row.backgroundNextAt) || (row.backgroundNextAt ?? -1) < 0))
      )
        throw new Error("CHAT_ACCOUNT_COOLDOWN_STATE_INVALID");
      const state = this.#accounts.get(key) ?? {
        tail: Promise.resolve(),
        retryAt: 0,
        serverRetryAt: 0,
        backgroundNextAt: 0,
        failures: 0,
        recovering: false,
        foregroundWaiters: 0,
        nextAt: 0,
        generation: 0,
        observedAt: -1,
      };
      state.retryAt = Math.max(state.retryAt, row.retryAt);
      // V1/V2 preserved the wait but did not distinguish a local fallback
      // from a service-provided retry deadline.
      state.serverRetryAt = Math.max(
        state.serverRetryAt,
        snapshot.version >= 3 ? (row.serverRetryAt ?? 0) : 0,
      );
      state.backgroundNextAt = Math.max(
        state.backgroundNextAt,
        snapshot.version >= 4 ? (row.backgroundNextAt ?? 0) : 0,
      );
      state.failures = Math.max(state.failures, row.failures);
      state.recovering = state.recovering || row.failures > 0;
      state.generation = Math.max(state.generation, row.failures);
      // V1 has no observation timestamp. Zero preserves its actual deadline
      // without inventing a recent rejection on migration.
      state.observedAt = Math.max(
        state.observedAt,
        snapshot.version === 1 ? 0 : (row.observedAt ?? 0),
      );
      this.#accounts.set(key, state);
    }
    if (migrationRequired) await this.#save();
  }
  async #save(): Promise<void> {
    const path = this.options.statePath;
    if (!path) return;
    const snapshot = JSON.stringify({
      version: 4,
      accounts: Object.fromEntries(
        [...this.#accounts]
          .filter(([, row]) => row.observedAt >= 0 || row.backgroundNextAt > 0)
          .map(([key, row]) => [
            key,
            {
              retryAt: row.retryAt,
              serverRetryAt: row.serverRetryAt,
              backgroundNextAt: row.backgroundNextAt,
              failures: row.failures,
              observedAt: Math.max(0, row.observedAt),
            },
          ]),
      ),
    });
    const write = this.#writes.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
    this.#writes = write;
    await write;
  }
  #subscribe(flight: Flight, signal?: AbortSignal): Promise<unknown> {
    flight.subscribers++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error: boolean, value: unknown) => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", abort);
        flight.subscribers--;
        if (!flight.settled && flight.subscribers === 0) flight.abort.abort();
        if (error) reject(value);
        else resolve(value);
      };
      const abort = () => finish(true, signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      void flight.promise.then(
        (value) => finish(false, value),
        (error) => finish(true, error),
      );
      if (signal?.aborted) abort();
    });
  }
}

export function chatAccountRateLimitRetryAt(value: unknown, now = Date.now()): number | undefined {
  return rateLimit(value, now);
}

function nativeRateLimited(object: Record<string, unknown>): boolean {
  const response = object.response as Record<string, unknown> | undefined;
  return [object.status, object.statusCode, object.responseStatus, response?.status].includes(429);
}

function retryAfterDeadline(object: Record<string, unknown>, now: number): number {
  const response = object.response as Record<string, unknown> | undefined;
  const headers = response?.headers ?? object.headers;
  const retry =
    headers instanceof Headers
      ? headers.get("retry-after")
      : headers && typeof headers === "object"
        ? Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1]
        : undefined;
  const text = typeof retry === "string" || typeof retry === "number" ? String(retry).trim() : "";
  return !text
    ? NaN
    : /^\d+(?:\.\d+)?$/.test(text)
      ? now + Math.ceil(Number(text) * 1000)
      : Date.parse(text);
}

function explicitServerRetryAt(value: unknown, now: number): number | undefined {
  if (value instanceof ChatAccountRateLimitError || !value || typeof value !== "object")
    return undefined;
  const object = value as Record<string, unknown>;
  const snapshot =
    object.rateLimit && typeof object.rateLimit === "object"
      ? (object.rateLimit as Record<string, unknown>)
      : undefined;
  const deadlines = [
    Number.isSafeInteger(snapshot?.serverRetryAtUnixMs)
      ? (snapshot?.serverRetryAtUnixMs as number)
      : NaN,
    snapshot?.backoffSource === "server_retry_after" && Number.isSafeInteger(snapshot.retryAtUnixMs)
      ? (snapshot.retryAtUnixMs as number)
      : NaN,
    Number.isSafeInteger(object.serverRetryAtUnixMs) ? (object.serverRetryAtUnixMs as number) : NaN,
    nativeRateLimited(object) && Number.isSafeInteger(object.retryAtUnixMs)
      ? (object.retryAtUnixMs as number)
      : NaN,
    retryAfterDeadline(object, now),
  ].filter((deadline) => Number.isFinite(deadline) && deadline >= 0);
  return deadlines.length === 0 ? undefined : Math.max(now, ...deadlines);
}

function rateLimit(value: unknown, now: number, fallbackMs = 0): number | undefined {
  if (value instanceof ChatAccountRateLimitError) return value.retryAtUnixMs;
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  const snapshot =
    object.rateLimit && typeof object.rateLimit === "object"
      ? (object.rateLimit as Record<string, unknown>)
      : undefined;
  const text =
    value instanceof Error
      ? value.message
      : typeof object.message === "string"
        ? object.message
        : typeof object.detail === "string"
          ? object.detail
          : object.success === false || object.isError === true
            ? JSON.stringify(object.contentItems ?? object.content ?? object.error ?? "")
            : typeof object.error === "string"
              ? object.error
              : "";
  // Native tool/RPC boundaries may preserve the timestamp but not the local
  // Error prototype. Keep that exact deadline instead of retrying immediately.
  const encodedDeadline = text.match(
    /CHAT_ACCOUNT_RATE_LIMITED: retry at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)/,
  )?.[1];
  const parsedDeadline = encodedDeadline === undefined ? NaN : Date.parse(encodedDeadline);
  if (
    !nativeRateLimited(object) &&
    snapshot?.status !== 429 &&
    !Number.isFinite(parsedDeadline) &&
    !/Too many requests|\b429\b/i.test(text)
  )
    return undefined;
  const deadlines = [
    snapshot?.status === 429 &&
    Number.isSafeInteger(snapshot.retryAtUnixMs) &&
    (snapshot.retryAtUnixMs as number) >= 0
      ? (snapshot.retryAtUnixMs as number)
      : NaN,
    retryAfterDeadline(object, now),
    parsedDeadline,
    Number.isSafeInteger(object.retryAtUnixMs) && (object.retryAtUnixMs as number) >= 0
      ? (object.retryAtUnixMs as number)
      : NaN,
  ].filter(Number.isFinite);
  return deadlines.length > 0 ? Math.max(now, ...deadlines) : now + fallbackMs;
}

function localRateLimitBackoffMs(previousFailures: number): number {
  const exponent = Math.min(Math.max(0, previousFailures), 6);
  return Math.min(30 * 60_000, 30_000 * 2 ** exponent);
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
