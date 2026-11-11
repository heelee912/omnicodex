import type { StreamableHttpGatewayAddress } from "../mcp/streamable-http-gateway.js";
import {
  HiddenChildProcessBoundary,
  type OwnedHiddenChildProcess,
} from "../windows/hidden-child-process.js";

export type ExternalTunnelKind = "cloudflare" | "tailscale" | "oracle_ssh";

export interface ReconnectPolicy {
  readonly maximumRestarts: number;
  readonly delayMs: number;
}

export interface ExternalTunnelStatus {
  readonly kind: ExternalTunnelKind;
  readonly publicUrl: string;
  readonly pid: number;
}

interface ExternalTunnelSupervisorCommonOptions {
  readonly executablePath: string;
  readonly publicUrl: string;
  readonly startupTimeoutMs?: number;
  readonly probeIntervalMs?: number;
  readonly gracefulStopTimeoutMs?: number;
  readonly forceStopTimeoutMs?: number;
  readonly reconnectPolicy?: ReconnectPolicy;
  readonly childProcesses?: HiddenChildProcessBoundary;
  readonly probe?: (url: URL, signal?: AbortSignal) => Promise<boolean>;
  readonly now?: () => number;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly onUnexpectedExit?: (error: Error) => Promise<void> | void;
  readonly onRecovered?: (status: ExternalTunnelStatus) => Promise<void> | void;
}

export type ExternalTunnelSupervisorOptions = ExternalTunnelSupervisorCommonOptions &
  (
    | { readonly kind: "cloudflare" }
    | { readonly kind: "tailscale" }
    | {
        readonly kind: "oracle_ssh";
        readonly sshHost: string;
        readonly sshPort: number;
        readonly sshUser: string;
        readonly identityFile: string;
        readonly remotePort: number;
      }
  );

/**
 * Owns one external tunnel child at a time. Lifecycle mutations are serialized,
 * while the generation and abort signal invalidate in-flight readiness before a
 * queued stop/restart has to wait for it. Only the exact owned child handle is
 * ever signalled.
 */
export class ExternalTunnelSupervisor {
  readonly #options: Required<
    Pick<
      ExternalTunnelSupervisorOptions,
      | "startupTimeoutMs"
      | "probeIntervalMs"
      | "gracefulStopTimeoutMs"
      | "forceStopTimeoutMs"
      | "reconnectPolicy"
      | "childProcesses"
      | "probe"
      | "now"
      | "delay"
    >
  > &
    ExternalTunnelSupervisorOptions;
  #child: OwnedHiddenChildProcess | undefined;
  #status: ExternalTunnelStatus | undefined;
  #activeTargetUrl: string | undefined;
  #desiredTargetUrl: string | undefined;
  #activeGeneration = 0;
  #generation = 0;
  #stopping = false;
  #terminationRetained = false;
  #readinessAbort: AbortController | undefined;
  #lifecycleQueue: Promise<void> = Promise.resolve();
  #startRequest:
    | {
        readonly targetUrl: string;
        readonly generation: number;
        readonly promise: Promise<ExternalTunnelStatus>;
      }
    | undefined;
  #recoveryRequest:
    | {
        readonly targetUrl: string;
        readonly generation: number;
        readonly promise: Promise<ExternalTunnelStatus>;
      }
    | undefined;

  constructor(options: ExternalTunnelSupervisorOptions) {
    const policy = options.reconnectPolicy ?? { maximumRestarts: 3, delayMs: 1_000 };
    if (
      !Number.isSafeInteger(policy.maximumRestarts) ||
      policy.maximumRestarts < 0 ||
      policy.maximumRestarts > 10
    ) {
      throw new Error("Invalid tunnel reconnect limit");
    }
    if (!Number.isSafeInteger(policy.delayMs) || policy.delayMs < 0 || policy.delayMs > 60_000) {
      throw new Error("Invalid tunnel reconnect delay");
    }
    this.#options = {
      ...options,
      publicUrl: exactHttpsOrigin(options.publicUrl),
      startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
      probeIntervalMs: options.probeIntervalMs ?? 250,
      gracefulStopTimeoutMs: options.gracefulStopTimeoutMs ?? 5_000,
      forceStopTimeoutMs: options.forceStopTimeoutMs ?? 5_000,
      reconnectPolicy: policy,
      childProcesses: options.childProcesses ?? new HiddenChildProcessBoundary(),
      probe: options.probe ?? defaultProbe,
      now: options.now ?? Date.now,
      delay: options.delay ?? delay,
    };
  }

  get status(): ExternalTunnelStatus | undefined {
    return this.#status;
  }

  start(address: StreamableHttpGatewayAddress): Promise<ExternalTunnelStatus> {
    let targetUrl: string;
    try {
      targetUrl = targetUrlFor(address);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#status !== undefined && !this.#stopping) {
      return this.#activeTargetUrl === targetUrl
        ? Promise.resolve(this.#status)
        : Promise.reject(new Error("Tunnel is already running for another target"));
    }
    if (
      this.#startRequest !== undefined &&
      this.#startRequest.generation === this.#generation &&
      this.#desiredTargetUrl === this.#startRequest.targetUrl
    ) {
      return this.#startRequest.targetUrl === targetUrl
        ? this.#startRequest.promise
        : Promise.reject(new Error("Tunnel is already starting for another target"));
    }
    if (
      this.#recoveryRequest !== undefined &&
      this.#recoveryRequest.generation === this.#generation &&
      this.#desiredTargetUrl === this.#recoveryRequest.targetUrl
    ) {
      return this.#recoveryRequest.targetUrl === targetUrl
        ? this.#recoveryRequest.promise
        : Promise.reject(new Error("Tunnel is reconnecting to another target"));
    }
    if (this.#child !== undefined && (!this.#stopping || this.#terminationRetained)) {
      return Promise.reject(
        new Error("Tunnel owned child is retained; stop it before starting another tunnel"),
      );
    }

    const generation = ++this.#generation;
    this.#desiredTargetUrl = targetUrl;
    this.#readinessAbort?.abort();
    const promise = this.#enqueueLifecycle(() => this.#startImpl(address, targetUrl, generation));
    this.#startRequest = { targetUrl, generation, promise };
    this.#clearStartRequestWhenSettled(promise, generation);
    return promise;
  }

  stop(): Promise<void> {
    ++this.#generation;
    this.#stopping = true;
    this.#desiredTargetUrl = undefined;
    this.#readinessAbort?.abort();
    return this.#enqueueLifecycle(() => this.#stopImpl());
  }

  restart(address: StreamableHttpGatewayAddress): Promise<ExternalTunnelStatus> {
    let targetUrl: string;
    try {
      targetUrl = targetUrlFor(address);
    } catch (error) {
      return Promise.reject(error);
    }
    const generation = ++this.#generation;
    this.#stopping = true;
    this.#desiredTargetUrl = targetUrl;
    this.#readinessAbort?.abort();
    const promise = this.#enqueueLifecycle(async () => {
      await this.#stopImpl();
      return this.#startImpl(address, targetUrl, generation);
    });
    this.#startRequest = { targetUrl, generation, promise };
    this.#clearStartRequestWhenSettled(promise, generation);
    return promise;
  }

  async #startImpl(
    address: StreamableHttpGatewayAddress,
    targetUrl: string,
    generation: number,
  ): Promise<ExternalTunnelStatus> {
    this.#assertCurrentGeneration(generation, targetUrl);
    if (this.#child !== undefined) {
      throw new Error("Tunnel owned child is retained; stop it before starting another tunnel");
    }
    this.#stopping = false;
    this.#terminationRetained = false;
    const controller = new AbortController();
    this.#readinessAbort = controller;
    this.#activeGeneration = generation;
    try {
      return await this.#startAttempt(address, targetUrl, generation, controller.signal);
    } catch (error) {
      if (generation === this.#generation && this.#child === undefined) {
        if (this.#options.kind === "oracle_ssh" && !isLifecycleSuperseded(error)) {
          this.#scheduleReconnect(address, targetUrl, generation, toError(error));
        } else {
          this.#desiredTargetUrl = undefined;
          this.#activeGeneration = 0;
        }
      }
      throw error;
    } finally {
      if (this.#readinessAbort === controller) this.#readinessAbort = undefined;
    }
  }

  async #startAttempt(
    address: StreamableHttpGatewayAddress,
    targetUrl: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<ExternalTunnelStatus> {
    this.#assertCurrentGeneration(generation, targetUrl, signal);
    const args = tunnelArguments(this.#options, address, targetUrl);
    const child = this.#options.childProcesses.spawnHidden(this.#options.executablePath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    this.#child = child;
    this.#observeExit(child, address, targetUrl, generation);
    const childExit = watchChildExit(
      child,
      () => new Error(`${this.#options.kind} exited before readiness`),
    );
    const pid = child.pid;
    if (pid === undefined) {
      childExit.dispose();
      await this.#cleanupFailedAttempt(child);
      throw new Error("Tunnel child has no pid");
    }

    const readiness = new URL(
      `/.well-known/oauth-protected-resource${address.path}`,
      this.#options.publicUrl,
    );
    const deadline = this.#options.now() + this.#options.startupTimeoutMs;
    try {
      while (this.#options.now() < deadline) {
        this.#assertCurrentGeneration(generation, targetUrl, signal);
        if (hasExited(child)) {
          throw new Error(`${this.#options.kind} exited before readiness`);
        }
        if (
          await abortable(
            Promise.race([
              this.#options.probe(readiness, signal).catch(() => false),
              childExit.promise,
            ]),
            signal,
          )
        ) {
          this.#assertCurrentGeneration(generation, targetUrl, signal);
          const status: ExternalTunnelStatus = {
            kind: this.#options.kind,
            publicUrl: this.#options.publicUrl,
            pid,
          };
          this.#activeTargetUrl = targetUrl;
          this.#status = status;
          return status;
        }
        await abortable(
          Promise.race([this.#pause(this.#options.probeIntervalMs, signal), childExit.promise]),
          signal,
        );
      }
      throw new Error(`${this.#options.kind} readiness timed out`);
    } catch (error) {
      await this.#cleanupFailedAttempt(child, childExit.hasEnded());
      throw error;
    } finally {
      childExit.dispose();
    }
  }

  #observeExit(
    child: OwnedHiddenChildProcess,
    address: StreamableHttpGatewayAddress,
    targetUrl: string,
    generation: number,
  ): void {
    let observed = false;
    const onExit = () => {
      if (observed) return;
      observed = true;
      if (this.#child !== child || this.#activeGeneration !== generation) {
        return;
      }

      const shouldReconnect =
        !this.#stopping &&
        generation === this.#generation &&
        this.#status !== undefined &&
        this.#desiredTargetUrl === targetUrl;
      const error = new Error(`${this.#options.kind} exited after readiness`);
      this.#child = undefined;
      this.#status = undefined;
      this.#activeTargetUrl = undefined;
      this.#terminationRetained = false;
      if (!shouldReconnect) return;
      this.#scheduleReconnect(address, targetUrl, generation, error);
      void Promise.resolve(this.#options.onUnexpectedExit?.(error)).catch(() => undefined);
    };
    child.once("close", onExit);
    child.once("error", onExit);
  }

  #scheduleReconnect(
    address: StreamableHttpGatewayAddress,
    targetUrl: string,
    generation: number,
    exitError: Error,
  ): void {
    if (this.#recoveryRequest?.generation === generation) return;
    const promise = this.#enqueueLifecycle(() =>
      this.#recover(address, targetUrl, generation, exitError),
    );
    this.#recoveryRequest = { targetUrl, generation, promise };
    void promise.then(
      () => {
        if (this.#recoveryRequest?.generation === generation) this.#recoveryRequest = undefined;
      },
      () => {
        if (this.#recoveryRequest?.generation === generation) this.#recoveryRequest = undefined;
      },
    );
    // Exit recovery is autonomous. Keep the scheduled promise observed while
    // still returning that same promise to a concurrent start() caller.
    void promise.catch(() => undefined);
  }

  async #recover(
    address: StreamableHttpGatewayAddress,
    targetUrl: string,
    generation: number,
    exitError: Error,
  ): Promise<ExternalTunnelStatus> {
    let lastError: unknown = exitError;
    for (
      let attempt = 0;
      this.#options.kind === "oracle_ssh" ||
      attempt < this.#options.reconnectPolicy.maximumRestarts;
      attempt += 1
    ) {
      this.#assertCurrentGeneration(generation, targetUrl);
      const controller = new AbortController();
      this.#readinessAbort = controller;
      try {
        const backoffMs = Math.min(
          30_000,
          this.#options.reconnectPolicy.delayMs * 2 ** Math.min(attempt, 15),
        );
        await this.#pause(backoffMs, controller.signal);
        this.#assertCurrentGeneration(generation, targetUrl, controller.signal);
        const recovered = await this.#startAttempt(
          address,
          targetUrl,
          generation,
          controller.signal,
        );
        await Promise.resolve(this.#options.onRecovered?.(recovered)).catch(() => undefined);
        return recovered;
      } catch (error) {
        lastError = error;
        if (isLifecycleSuperseded(error) || this.#child !== undefined) throw error;
      } finally {
        if (this.#readinessAbort === controller) this.#readinessAbort = undefined;
      }
    }

    if (generation === this.#generation) {
      this.#desiredTargetUrl = undefined;
      this.#activeGeneration = 0;
    }
    throw new Error(
      `${this.#options.kind} reconnect attempts exhausted: ${errorMessage(lastError)}`,
    );
  }

  async #cleanupFailedAttempt(child: OwnedHiddenChildProcess, observedExit = false): Promise<void> {
    if (!observedExit && !hasExited(child)) {
      this.#options.childProcesses.terminateOwnedHiddenChild(child, "SIGTERM");
      const gracefullyClosed = await waitForExit(child, this.#options.gracefulStopTimeoutMs);
      if (!gracefullyClosed) {
        this.#options.childProcesses.terminateOwnedHiddenChild(child, "SIGKILL");
        const forciblyClosed = await waitForExit(child, this.#options.forceStopTimeoutMs);
        if (!forciblyClosed) {
          this.#terminationRetained = true;
          throw new Error(
            `owned ${this.#options.kind} process ${String(child.pid)} did not exit after SIGTERM and SIGKILL; ownership retained`,
          );
        }
      }
    }
    if (this.#child === child) this.#child = undefined;
    if (this.#status?.pid === child.pid) this.#status = undefined;
    if (this.#activeTargetUrl !== undefined && this.#status === undefined) {
      this.#activeTargetUrl = undefined;
    }
    this.#terminationRetained = false;
  }

  async #stopImpl(): Promise<void> {
    const child = this.#child;
    if (child !== undefined && !hasExited(child)) {
      this.#options.childProcesses.terminateOwnedHiddenChild(child, "SIGTERM");
      const gracefullyClosed = await waitForExit(child, this.#options.gracefulStopTimeoutMs);
      if (!gracefullyClosed) {
        this.#options.childProcesses.terminateOwnedHiddenChild(child, "SIGKILL");
        const forciblyClosed = await waitForExit(child, this.#options.forceStopTimeoutMs);
        if (!forciblyClosed) {
          this.#terminationRetained = true;
          throw new Error(
            `owned ${this.#options.kind} process ${String(child.pid)} did not exit after SIGTERM and SIGKILL; ownership retained`,
          );
        }
      }
    }
    if (this.#child === child) this.#child = undefined;
    this.#status = undefined;
    this.#activeTargetUrl = undefined;
    this.#activeGeneration = 0;
    this.#terminationRetained = false;
  }

  #assertCurrentGeneration(generation: number, targetUrl: string, signal?: AbortSignal): void {
    if (
      signal?.aborted === true ||
      generation !== this.#generation ||
      this.#desiredTargetUrl !== targetUrl
    ) {
      throw lifecycleSupersededError(this.#options.kind);
    }
  }

  #pause(milliseconds: number, signal: AbortSignal): Promise<void> {
    return this.#options.delay === delay
      ? delay(milliseconds, signal)
      : abortable(this.#options.delay(milliseconds), signal);
  }

  #clearStartRequestWhenSettled(promise: Promise<ExternalTunnelStatus>, generation: number): void {
    void promise.then(
      () => {
        if (this.#startRequest?.generation === generation) this.#startRequest = undefined;
      },
      () => {
        if (this.#startRequest?.generation === generation) this.#startRequest = undefined;
      },
    );
  }

  #enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#lifecycleQueue.then(operation, operation);
    this.#lifecycleQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function tunnelArguments(
  options: ExternalTunnelSupervisorOptions,
  address: StreamableHttpGatewayAddress,
  targetUrl: string,
): string[] {
  if (options.kind === "cloudflare") {
    return ["tunnel", "--no-autoupdate", "--url", targetUrl];
  }
  if (options.kind === "tailscale") {
    return [
      "funnel",
      "--bg=false",
      "--yes",
      "--https",
      tailscaleHttpsPort(options.publicUrl),
      targetUrl,
    ];
  }
  return [
    "-N",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "StrictHostKeyChecking=yes",
    "-p",
    String(options.sshPort),
    "-i",
    options.identityFile,
    "-R",
    `127.0.0.1:${String(options.remotePort)}:127.0.0.1:${String(address.port)}`,
    `${options.sshUser}@${options.sshHost}`,
  ];
}

function tailscaleHttpsPort(publicUrl: string): string {
  const parsed = new URL(publicUrl);
  if (parsed.protocol !== "https:") throw new Error("Tailscale public URL must use HTTPS");
  return parsed.port === "" ? "443" : parsed.port;
}

function targetUrlFor(address: StreamableHttpGatewayAddress): string {
  if (address.host !== "127.0.0.1") throw new Error("Tunnel target must be loopback-only");
  return `http://127.0.0.1:${address.port}`;
}

function exactHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Tunnel public URL must be an exact credential-free HTTPS origin");
  }
  return url.origin;
}

async function defaultProbe(url: URL, parentSignal?: AbortSignal): Promise<boolean> {
  const timeoutSignal = AbortSignal.timeout(5_000);
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal:
      parentSignal === undefined ? timeoutSignal : AbortSignal.any([parentSignal, timeoutSignal]),
  });
  return response.status === 200;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(lifecycleSupersededError("external"));
  return new Promise((resolveDelay, rejectDelay) => {
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(lifecycleSupersededError("external"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(lifecycleSupersededError("external"));
  return new Promise<T>((resolveOperation, rejectOperation) => {
    let settled = false;
    const finish = (result: { readonly value: T } | { readonly error: unknown }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if ("error" in result) rejectOperation(result.error);
      else resolveOperation(result.value);
    };
    const onAbort = () => finish({ error: lifecycleSupersededError("external") });
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => finish({ value }),
      (error: unknown) => finish({ error }),
    );
  });
}

function lifecycleSupersededError(kind: string): Error {
  const error = new Error(`${kind} tunnel lifecycle operation was superseded`);
  error.name = "AbortError";
  return error;
}

function isLifecycleSuperseded(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function watchChildExit(
  child: OwnedHiddenChildProcess,
  errorFactory: () => Error,
): {
  readonly promise: Promise<never>;
  readonly hasEnded: () => boolean;
  readonly dispose: () => void;
} {
  let rejectExit: ((error: Error) => void) | undefined;
  let ended = false;
  const promise = new Promise<never>((_resolveExit, rejectPromise) => {
    rejectExit = rejectPromise;
  });
  const onExit = () => {
    ended = true;
    rejectExit?.(errorFactory());
  };
  child.once("close", onExit);
  child.once("error", onExit);
  return {
    promise,
    hasEnded: () => ended,
    dispose: () => {
      child.off("close", onExit);
      child.off("error", onExit);
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function hasExited(child: OwnedHiddenChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(
  child: OwnedHiddenChildProcess,
  timeoutMilliseconds: number,
): Promise<boolean> {
  if (hasExited(child)) return true;
  return new Promise((resolveExit) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      child.off("close", onClose);
      resolveExit(exited);
    };
    const onClose = () => finish(true);
    child.once("close", onClose);
    if (hasExited(child)) {
      finish(true);
      return;
    }
    timer = setTimeout(() => finish(hasExited(child)), timeoutMilliseconds);
  });
}
