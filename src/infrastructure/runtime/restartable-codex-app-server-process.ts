import type { RuntimeCandidate } from "../../domain/runtime.js";
import {
  type CodexAppServerIdentity,
  CodexAppServerProcess,
  type CodexAppServerProcessOptions,
} from "./codex-app-server-process.js";
import type { JsonlRpcRequestOptions, JsonObject } from "./jsonl-rpc-client.js";

export interface CodexAppServerProcessHandle {
  readonly client: RestartableAppServerRpcClient;
  readonly identity: CodexAppServerIdentity;
  stop(): Promise<void>;
}

interface OwnedAppServerGeneration {
  readonly client: AppServerRpcTransport;
  readonly identity: CodexAppServerIdentity;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface AppServerRpcTransport {
  request<T>(
    method: string,
    params: unknown,
    timeoutOrOptions?: number | JsonlRpcRequestOptions,
  ): Promise<T>;
  subscribeNotifications(listener: (message: JsonObject) => void): () => void;
}

export interface RestartableCodexAppServerProcessOptions
  extends Omit<CodexAppServerProcessOptions, "onUnexpectedExit"> {
  /** Called after a replacement transport is live. It must not close the replacement on failure. */
  readonly onGenerationReplaced?: (
    process: CodexAppServerProcessHandle,
    generation: number,
  ) => Promise<void> | void;
  readonly onRecoveryDiagnostic?: (message: JsonObject) => void;
  /** The underlying transport actually disconnected, rather than merely exceeding an RPC deadline. */
  readonly onDisconnected?: (error: Error) => void;
  /** Optional operator policy. Omitted uses a bounded backoff and retries until explicit stop. */
  readonly recoveryDelayMs?: number;
  /** Selects the App Server transport; the gateway uses the Desktop-owned pipe. */
  readonly processFactory?: (
    candidate: RuntimeCandidate,
    options: CodexAppServerProcessOptions,
  ) => OwnedAppServerGeneration;
}

interface RpcTarget {
  readonly client: AppServerRpcTransport;
  readonly generation: number;
}

/**
 * A stable App Server client identity whose transport may be replaced in place.
 * Existing MCP servers and executors keep this object across pipe reconnects.
 */
export class RestartableAppServerRpcClient {
  readonly #listeners = new Set<(message: JsonObject) => void>();
  readonly #readyWaiters = new Set<{
    readonly resolve: (target: RpcTarget) => void;
    readonly reject: (error: Error) => void;
  }>();
  readonly #onTransportFailure: (client: AppServerRpcTransport, error: Error) => void;
  #target: RpcTarget | undefined;
  #unsubscribe: (() => void) | undefined;
  #closedError: Error | undefined;

  constructor(onTransportFailure: (client: AppServerRpcTransport, error: Error) => void) {
    this.#onTransportFailure = onTransportFailure;
  }

  request<T>(
    method: string,
    params: unknown,
    timeoutOrOptions?: number | JsonlRpcRequestOptions,
  ): Promise<T> {
    const options = normalizeRequestBoundary(timeoutOrOptions);
    return this.#request<T>(method, params, options);
  }

  subscribeNotifications(listener: (message: JsonObject) => void): () => void {
    if (this.#closedError !== undefined) throw this.#closedError;
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  install(client: AppServerRpcTransport, generation: number): void {
    if (this.#closedError !== undefined) return;
    this.#unsubscribe?.();
    this.#target = { client, generation };
    this.#unsubscribe = client.subscribeNotifications((message) => {
      for (const listener of this.#listeners) listener(message);
    });
    for (const waiter of this.#readyWaiters) waiter.resolve(this.#target);
    this.#readyWaiters.clear();
  }

  detach(client: AppServerRpcTransport): void {
    if (this.#target?.client !== client) return;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#target = undefined;
  }

  close(error = new Error("Restartable Codex App Server client is closed")): void {
    if (this.#closedError !== undefined) return;
    this.#closedError = error;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#target = undefined;
    for (const waiter of this.#readyWaiters) waiter.reject(error);
    this.#readyWaiters.clear();
  }

  async #request<T>(method: string, params: unknown, options: JsonlRpcRequestOptions): Promise<T> {
    for (;;) {
      const target = await this.#waitForTarget(method, options);
      try {
        return await target.client.request<T>(method, params, options);
      } catch (error) {
        const failure = toError(error);
        if (!isRecoverableGenerationFailure(failure)) throw failure;
        this.#onTransportFailure(target.client, failure);
        if (!isIdempotentAppServerRead(method)) throw failure;
        const current = this.#target;
        if (current?.client === target.client && current.generation === target.generation) {
          this.detach(target.client);
        }
      }
    }
  }

  async #waitForTarget(method: string, options: JsonlRpcRequestOptions): Promise<RpcTarget> {
    if (this.#closedError !== undefined) throw this.#closedError;
    if (options.signal?.aborted === true) throw abortError(options.signal);
    if (options.deadlineUnixMs !== undefined && options.deadlineUnixMs <= Date.now()) {
      throw deadlineError(method, options.deadlineUnixMs);
    }
    if (this.#target !== undefined) return this.#target;
    return new Promise<RpcTarget>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = {
        resolve: (target: RpcTarget) => settle(() => resolve(target)),
        reject: (error: Error) => settle(() => reject(error)),
      };
      const settle = (operation: () => void) => {
        if (settled) return;
        settled = true;
        this.#readyWaiters.delete(waiter);
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        operation();
      };
      const onAbort = () => waiter.reject(abortError(options.signal));
      this.#readyWaiters.add(waiter);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.deadlineUnixMs !== undefined) {
        timer = setTimeout(
          () => waiter.reject(deadlineError(method, options.deadlineUnixMs as number)),
          Math.max(0, options.deadlineUnixMs - Date.now()),
        );
        timer.unref?.();
      }
      if (this.#closedError !== undefined) waiter.reject(this.#closedError);
      else if (this.#target !== undefined) waiter.resolve(this.#target);
    });
  }
}

/**
 * Keeps one logical primary App Server connection alive across transport failures.
 * The public gateway, MCP transports, SSE history, and Web work-session binding
 * remain resident while the Desktop-owned pipe reconnects.
 */
export class RestartableCodexAppServerProcess implements CodexAppServerProcessHandle {
  readonly #candidate: RuntimeCandidate;
  readonly #options: RestartableCodexAppServerProcessOptions;
  readonly #processFactory: NonNullable<RestartableCodexAppServerProcessOptions["processFactory"]>;
  readonly #lifecycle = new AbortController();
  readonly #client: RestartableAppServerRpcClient;
  readonly #installedClients = new WeakMap<OwnedAppServerGeneration, AppServerRpcTransport>();
  readonly #ownedGenerations = new Set<OwnedAppServerGeneration>();
  readonly #retirements = new Map<OwnedAppServerGeneration, Promise<void>>();
  #current: OwnedAppServerGeneration | undefined;
  #lastIdentity: CodexAppServerIdentity | undefined;
  #generation = 0;
  #startPromise: Promise<void> | undefined;
  #recoveryPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;

  constructor(candidate: RuntimeCandidate, options: RestartableCodexAppServerProcessOptions = {}) {
    this.#candidate = candidate;
    this.#options = options;
    this.#processFactory =
      options.processFactory ??
      ((runtime, processOptions) => new CodexAppServerProcess(runtime, processOptions));
    this.#client = new RestartableAppServerRpcClient((client, error) => {
      this.#startRecoveryForClient(client, error);
    });
  }

  get client(): RestartableAppServerRpcClient {
    return this.#client;
  }

  get identity(): CodexAppServerIdentity {
    const identity = this.#current?.identity ?? this.#lastIdentity;
    if (identity === undefined) {
      return {
        candidate: this.#candidate,
        pid: undefined,
        correlationId: "pending",
        ownershipNonce: undefined,
        spawnedAtUnixMs: undefined,
      };
    }
    return identity;
  }

  start(): Promise<void> {
    if (this.#lifecycle.signal.aborted) {
      return Promise.reject(new Error("Restartable Codex App Server process is stopped"));
    }
    if (this.#recoveryPromise !== undefined) return this.#recoveryPromise;
    if (this.#startPromise !== undefined) return this.#startPromise;
    if (this.#current !== undefined) return Promise.resolve();
    this.#startPromise ??= (async () => {
      for (const generation of this.#ownedGenerations) await this.#retireGeneration(generation);
      await this.#startGeneration(false);
    })().finally(() => {
      this.#startPromise = undefined;
    });
    return this.#startPromise;
  }

  stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    this.#lifecycle.abort(new Error("Restartable Codex App Server process is stopping"));
    this.#client.close();
    const operation = (async () => {
      const results = await Promise.allSettled(
        [...this.#ownedGenerations].map((generation) => this.#retireGeneration(generation)),
      );
      await this.#recoveryPromise?.catch(() => undefined);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [toError(result.reason)] : [],
      );
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "Codex App Server generations did not stop cleanly");
      }
    })().finally(() => {
      if (this.#stopPromise === operation) this.#stopPromise = undefined;
    });
    this.#stopPromise = operation;
    return operation;
  }

  #createGeneration(): OwnedAppServerGeneration {
    let generation!: OwnedAppServerGeneration;
    generation = this.#processFactory(this.#candidate, {
      ...baseProcessOptions(this.#options),
      onUnexpectedExit: (error) => this.#startRecovery(generation, error, true),
    });
    this.#ownedGenerations.add(generation);
    return generation;
  }

  #retireGeneration(generation: OwnedAppServerGeneration): Promise<void> {
    if (!this.#ownedGenerations.has(generation)) return Promise.resolve();
    const pending = this.#retirements.get(generation);
    if (pending !== undefined) return pending;
    const operation = Promise.resolve()
      .then(() => generation.stop())
      .then(() => {
        this.#ownedGenerations.delete(generation);
        if (this.#current === generation) this.#current = undefined;
      })
      .finally(() => this.#retirements.delete(generation));
    this.#retirements.set(generation, operation);
    return operation;
  }

  async #startGeneration(replacement: boolean): Promise<void> {
    throwIfStopped(this.#lifecycle.signal);
    const process = this.#createGeneration();
    this.#current = process;
    let installed = false;
    try {
      await process.start();
      throwIfStopped(this.#lifecycle.signal);
      this.#generation += 1;
      this.#lastIdentity = process.identity;
      const generationClient = process.client;
      this.#installedClients.set(process, generationClient);
      this.#client.install(generationClient, this.#generation);
      installed = true;
      if (replacement) {
        try {
          await this.#options.onGenerationReplaced?.(this, this.#generation);
        } catch (error) {
          this.#diagnostic("omnicodex/runtime/replacementBindingRefreshFailed", error);
        }
      }
    } catch (error) {
      if (this.#current === process) this.#current = undefined;
      const installedClient = this.#installedClients.get(process);
      if (installed && installedClient !== undefined) this.#client.detach(installedClient);
      try {
        await this.#retireGeneration(process);
      } catch (cleanupError) {
        throw new AggregateError(
          [toError(error), toError(cleanupError)],
          "Codex App Server generation startup and cleanup failed",
        );
      }
      throw error;
    }
  }

  #startRecoveryForClient(client: AppServerRpcTransport, error: Error): void {
    const current = this.#current;
    if (
      current === undefined ||
      (this.#installedClients.get(current) ?? availableProcessClient(current)) !== client
    ) {
      return;
    }
    this.#startRecovery(current, error);
  }

  #startRecovery(process: OwnedAppServerGeneration, error: Error, disconnected = false): void {
    if (this.#lifecycle.signal.aborted || this.#current !== process) return;
    // A child can exit during start(), before CodexAppServerProcess has
    // installed its JSONL client.  Reading `process.client` in that state
    // throws by design.  There is no transport to detach in that generation;
    // recovery still owns and replaces the failed child.
    const failedClient = this.#installedClients.get(process) ?? availableProcessClient(process);
    if (failedClient !== undefined) this.#client.detach(failedClient);
    this.#current = undefined;
    this.#diagnostic("omnicodex/runtime/internalGenerationExited", error);
    if (disconnected || isTransportTermination(error)) {
      try {
        this.#options.onDisconnected?.(error);
      } catch (callbackError) {
        this.#diagnostic("omnicodex/runtime/disconnectionCallbackFailed", callbackError);
      }
    }
    if (this.#recoveryPromise !== undefined) return;
    this.#recoveryPromise = this.#recover().finally(() => {
      this.#recoveryPromise = undefined;
    });
  }

  async #recover(): Promise<void> {
    let attempt = 0;
    while (!this.#lifecycle.signal.aborted) {
      attempt += 1;
      try {
        // A failed stop retains exact ownership. Do not overlap generations
        // until the old child and any failed replacement have actually exited.
        for (const generation of this.#ownedGenerations) {
          try {
            await this.#retireGeneration(generation);
          } catch (error) {
            this.#diagnostic("omnicodex/runtime/retiredGenerationCleanupFailed", error);
            throw error;
          }
        }
        await this.#startGeneration(true);
        this.#options.onRecoveryDiagnostic?.({
          method: "omnicodex/runtime/internalGenerationRecovered",
          params: { attempt, generation: this.#generation },
        });
        return;
      } catch (error) {
        if (this.#lifecycle.signal.aborted) return;
        this.#diagnostic("omnicodex/runtime/internalGenerationRecoveryFailed", error, attempt);
        await abortableDelay(
          recoveryDelay(attempt, this.#options.recoveryDelayMs),
          this.#lifecycle.signal,
        ).catch(() => undefined);
      }
    }
  }

  #diagnostic(method: string, error: unknown, attempt?: number): void {
    this.#options.onRecoveryDiagnostic?.({
      method,
      params: {
        ...(attempt === undefined ? {} : { attempt }),
        message: toError(error).message,
      },
    });
  }
}

function availableProcessClient(
  process: OwnedAppServerGeneration,
): AppServerRpcTransport | undefined {
  try {
    return process.client;
  } catch {
    return undefined;
  }
}

function baseProcessOptions(
  options: RestartableCodexAppServerProcessOptions,
): CodexAppServerProcessOptions {
  const {
    onGenerationReplaced: _onGenerationReplaced,
    onRecoveryDiagnostic: _onRecoveryDiagnostic,
    onDisconnected: _onDisconnected,
    recoveryDelayMs: _recoveryDelayMs,
    processFactory: _processFactory,
    ...processOptions
  } = options;
  return processOptions;
}

function normalizeRequestBoundary(
  value: number | JsonlRpcRequestOptions | undefined,
): JsonlRpcRequestOptions {
  if (value === undefined) return {};
  if (typeof value === "number") return { deadlineUnixMs: Date.now() + value };
  const timeoutDeadline = value.timeoutMs === undefined ? undefined : Date.now() + value.timeoutMs;
  const deadlineUnixMs =
    timeoutDeadline === undefined
      ? value.deadlineUnixMs
      : value.deadlineUnixMs === undefined
        ? timeoutDeadline
        : Math.min(timeoutDeadline, value.deadlineUnixMs);
  return {
    ...(deadlineUnixMs === undefined ? {} : { deadlineUnixMs }),
    ...(value.signal === undefined ? {} : { signal: value.signal }),
    ...(value.awaitResponseAfterCancellation === true
      ? { awaitResponseAfterCancellation: true }
      : {}),
  };
}

function isIdempotentAppServerRead(method: string): boolean {
  return new Set([
    "account/read",
    "app/list",
    "config/read",
    "experimentalFeature/list",
    "mcpServerStatus/list",
    "model/list",
    "skills/list",
    "thread/list",
    "thread/read",
    "thread/turns/list",
  ]).has(method);
}

export function isTransportTermination(error: Error): boolean {
  return (
    /client is closed|client closed|stream ended|app server exited|write after a stream was destroyed|EPIPE|ECONNRESET/i.test(
      error.message,
    ) || Reflect.get(error, "code") === "ERR_STREAM_DESTROYED"
  );
}

export function isRecoverableGenerationFailure(error: Error): boolean {
  return (
    isTransportTermination(error) || Reflect.get(error, "code") === "JSONL_RPC_DEADLINE_EXCEEDED"
  );
}

function recoveryDelay(attempt: number, configured: number | undefined): number {
  if (configured !== undefined) {
    if (!Number.isSafeInteger(configured) || configured < 0) {
      throw new TypeError("App Server recoveryDelayMs must be a non-negative safe integer");
    }
    return configured;
  }
  return Math.min(30_000, 250 * 2 ** Math.min(attempt - 1, 7));
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const settle = (operation: () => void) => {
      signal.removeEventListener("abort", onAbort);
      operation();
    };
    const timer = setTimeout(() => settle(resolve), milliseconds);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      settle(() => reject(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfStopped(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("App Server recovery stopped");
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  const error = new Error(
    reason instanceof Error ? reason.message : String(reason ?? "Request cancelled"),
    {
      cause: reason,
    },
  );
  error.name = "AbortError";
  return error;
}

function deadlineError(method: string, deadlineUnixMs: number): Error {
  const error = new Error(`App Server request timed out: ${method}`);
  error.name = "JsonlRpcRequestTimeoutError";
  Object.assign(error, { code: "JSONL_RPC_DEADLINE_EXCEEDED", deadlineUnixMs, method });
  return error;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
