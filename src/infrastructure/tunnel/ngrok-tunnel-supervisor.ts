import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamableHttpGatewayAddress } from "../mcp/streamable-http-gateway.js";
import {
  HiddenChildProcessBoundary,
  type OwnedHiddenChildProcess,
} from "../windows/hidden-child-process.js";
import type { ReadableSecretReferenceStore } from "../windows/windows-dpapi-secret-store.js";

export interface NgrokTunnelSupervisorOptions {
  readonly executablePath: string;
  readonly publicUrl: string;
  readonly expectedResource: string;
  readonly credentialRef?: string;
  readonly secretStore?: ReadableSecretReferenceStore;
  readonly startupTimeoutMs?: number;
  readonly probeIntervalMs?: number;
  readonly gracefulStopTimeoutMs?: number;
  readonly forceStopTimeoutMs?: number;
  readonly probe?: (url: URL, expectedResource: string, signal?: AbortSignal) => Promise<boolean>;
  readonly childProcesses?: HiddenChildProcessBoundary;
  readonly onUnexpectedExit?: (error: Error) => void;
  readonly onSpawned?: (ownership: NgrokProcessOwnership) => Promise<void> | void;
  readonly onStopped?: () => Promise<void> | void;
}

export interface NgrokProcessOwnership {
  readonly kind: "ngrok";
  readonly pid: number;
  readonly parentPid: number;
  readonly processNonce: string;
  readonly executablePath: string;
  readonly spawnedAtUnixMs: number;
  readonly targetUrl: string;
  readonly publicUrl: string;
  readonly configPath: string;
}

export interface NgrokTunnelStatus {
  readonly kind: "ngrok";
  readonly publicUrl: string;
  readonly targetUrl: string;
  readonly pid: number;
}

export class NgrokPublicEndpointUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NgrokPublicEndpointUnavailableError";
  }
}

/**
 * Owns exactly one ngrok child. A credential reference is resolved from the
 * CurrentUser DPAPI store only at spawn time and passed through ngrok's
 * documented environment variable, never through argv, logs, or state.
 */
export class NgrokTunnelSupervisor {
  readonly #options: Required<
    Pick<
      NgrokTunnelSupervisorOptions,
      | "startupTimeoutMs"
      | "probeIntervalMs"
      | "gracefulStopTimeoutMs"
      | "forceStopTimeoutMs"
      | "probe"
      | "childProcesses"
    >
  > &
    NgrokTunnelSupervisorOptions;
  #child: OwnedHiddenChildProcess | undefined;
  #status: NgrokTunnelStatus | undefined;
  #temporaryConfigDirectory: string | undefined;
  #diagnostic = "";
  #stdoutBuffer = "";
  #ownedTunnelReady = false;
  #stopping = false;
  #terminationRetained = false;
  #generation = 0;
  #activeGeneration = 0;
  #desiredTargetUrl: string | undefined;
  #readinessAbort: AbortController | undefined;
  #lifecycleQueue: Promise<void> = Promise.resolve();
  #startRequest:
    | {
        readonly targetUrl: string;
        readonly generation: number;
        readonly promise: Promise<NgrokTunnelStatus>;
      }
    | undefined;

  constructor(options: NgrokTunnelSupervisorOptions) {
    const publicUrl = stableHttpsOrigin(options.publicUrl);
    this.#options = {
      ...options,
      publicUrl: publicUrl.href.replace(/\/$/, ""),
      startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
      probeIntervalMs: options.probeIntervalMs ?? 250,
      gracefulStopTimeoutMs: options.gracefulStopTimeoutMs ?? 5_000,
      forceStopTimeoutMs: options.forceStopTimeoutMs ?? 5_000,
      probe: options.probe ?? probePublicEndpoint,
      childProcesses: options.childProcesses ?? new HiddenChildProcessBoundary(),
    };
  }

  get status(): NgrokTunnelStatus | undefined {
    return this.#status;
  }

  start(address: StreamableHttpGatewayAddress): Promise<NgrokTunnelStatus> {
    if (address.host !== "127.0.0.1") {
      return Promise.reject(new Error("ngrok may only forward to the OmniCodex loopback gateway"));
    }
    const targetUrl = `http://127.0.0.1:${address.port}`;
    if (this.#status !== undefined && !this.#stopping) {
      return this.#status.targetUrl === targetUrl
        ? Promise.resolve(this.#status)
        : Promise.reject(new Error("ngrok tunnel is already running for another target"));
    }
    if (
      this.#startRequest !== undefined &&
      this.#startRequest.generation === this.#generation &&
      this.#desiredTargetUrl === this.#startRequest.targetUrl
    ) {
      return this.#startRequest.targetUrl === targetUrl
        ? this.#startRequest.promise
        : Promise.reject(new Error("ngrok tunnel is already starting for another target"));
    }
    if (this.#child !== undefined && (!this.#stopping || this.#terminationRetained)) {
      return Promise.reject(
        new Error("ngrok owned child is retained; stop it before starting another tunnel"),
      );
    }
    const generation = ++this.#generation;
    this.#desiredTargetUrl = targetUrl;
    this.#readinessAbort?.abort();
    const promise = this.#enqueueLifecycle(() => this.#runStart(address, generation, targetUrl));
    this.#startRequest = { targetUrl, generation, promise };
    void promise.then(
      () => {
        if (this.#startRequest?.generation === generation) this.#startRequest = undefined;
      },
      () => {
        if (this.#startRequest?.generation === generation) this.#startRequest = undefined;
      },
    );
    return promise;
  }

  async #startImpl(
    address: StreamableHttpGatewayAddress,
    generation: number,
    targetUrl: string,
  ): Promise<NgrokTunnelStatus> {
    this.#assertCurrentGeneration(generation, targetUrl);
    if (this.#child !== undefined) {
      throw new Error("ngrok owned child is retained; stop it before starting another tunnel");
    }
    this.#stopping = false;
    this.#terminationRetained = false;
    this.#diagnostic = "";
    this.#stdoutBuffer = "";
    this.#ownedTunnelReady = false;
    const readinessAbort = new AbortController();
    this.#readinessAbort = readinessAbort;
    this.#activeGeneration = generation;
    await access(this.#options.executablePath);
    this.#assertCurrentGeneration(generation, targetUrl, readinessAbort.signal);
    const expectedResource = new URL(this.#options.expectedResource);
    const publicOrigin = new URL(this.#options.publicUrl).origin;
    if (
      expectedResource.origin !== publicOrigin ||
      ![address.path, address.fullPath].includes(expectedResource.pathname)
    ) {
      throw new Error("ngrok expected resource must match an OmniCodex gateway surface");
    }
    const readinessUrl = new URL(
      `/.well-known/oauth-protected-resource${normalizeMcpPath(expectedResource.pathname)}`,
      this.#options.publicUrl,
    );
    const environment = await this.#ngrokEnvironment();
    const publicHostname = new URL(this.#options.publicUrl).hostname;
    const runtimeConfig = await this.#createRuntimeConfig();
    const configPath = runtimeConfig.path;
    let child: OwnedHiddenChildProcess;
    try {
      child = this.#options.childProcesses.spawnHidden(
        this.#options.executablePath,
        [
          "http",
          targetUrl,
          "--url",
          `https://${publicHostname}`,
          "--config",
          configPath,
          "--log=stdout",
          "--log-format=json",
        ],
        { stdio: ["ignore", "pipe", "pipe"], env: environment },
      );
    } catch (error) {
      await this.#removeRuntimeConfig(runtimeConfig.directory);
      throw error;
    }
    this.#child = child;
    child.once("error", () => undefined);
    this.#capture(child.stdout, true, child, generation);
    this.#capture(child.stderr, false, child, generation);
    this.#observeUnexpectedExit(child, generation, runtimeConfig.directory);
    const pid = child.pid;
    if (pid === undefined) {
      await this.#cleanupFailedStart(child, runtimeConfig.directory);
      throw new Error("ngrok did not receive a process id");
    }

    try {
      await this.#options.onSpawned?.({
        kind: "ngrok",
        pid,
        parentPid: process.pid,
        processNonce: child.ownership.nonce,
        executablePath: child.ownership.executable,
        spawnedAtUnixMs: child.ownership.spawnedAtUnixMs,
        targetUrl,
        publicUrl: this.#options.publicUrl,
        configPath,
      });
      await this.#waitUntilReady(child, readinessUrl, generation, readinessAbort.signal);
      this.#assertCurrentGeneration(generation, targetUrl, readinessAbort.signal);
      const status: NgrokTunnelStatus = {
        kind: "ngrok",
        publicUrl: this.#options.publicUrl,
        targetUrl,
        pid,
      };
      this.#status = status;
      return status;
    } catch (error) {
      await this.#cleanupFailedStart(child, runtimeConfig.directory);
      throw error;
    } finally {
      if (this.#readinessAbort === readinessAbort) this.#readinessAbort = undefined;
    }
  }

  async #runStart(
    address: StreamableHttpGatewayAddress,
    generation: number,
    targetUrl: string,
  ): Promise<NgrokTunnelStatus> {
    try {
      return await this.#startImpl(address, generation, targetUrl);
    } catch (error) {
      if (this.#activeGeneration === generation) {
        this.#readinessAbort?.abort();
        this.#readinessAbort = undefined;
      }
      if (generation === this.#generation && this.#child === undefined) {
        this.#desiredTargetUrl = undefined;
        this.#activeGeneration = 0;
      }
      throw error;
    }
  }

  async #ngrokEnvironment(): Promise<NodeJS.ProcessEnv> {
    const reference = this.#options.credentialRef;
    if (reference === undefined) return { ...process.env };
    if (this.#options.secretStore === undefined)
      throw new Error("ngrok credential reference has no secret store");
    const authtoken = await this.#options.secretStore.get(reference);
    return { ...process.env, NGROK_AUTHTOKEN: authtoken };
  }

  stop(): Promise<void> {
    ++this.#generation;
    this.#stopping = true;
    this.#desiredTargetUrl = undefined;
    this.#readinessAbort?.abort();
    return this.#enqueueLifecycle(() => this.#stopImpl());
  }

  async #stopImpl(): Promise<void> {
    const child = this.#child;
    const configDirectory = this.#temporaryConfigDirectory;
    if (child !== undefined && !hasExited(child)) {
      this.#options.childProcesses.terminateOwnedHiddenChild(child, "SIGTERM");
      const gracefullyClosed = await waitForExit(child, this.#options.gracefulStopTimeoutMs);
      if (!gracefullyClosed) {
        this.#options.childProcesses.terminateOwnedHiddenChild(child, "SIGKILL");
        const forciblyClosed = await waitForExit(child, this.#options.forceStopTimeoutMs);
        if (!forciblyClosed) {
          this.#terminationRetained = true;
          throw new Error(
            `owned ngrok process ${String(child.pid)} did not exit after SIGTERM and SIGKILL; ownership retained`,
          );
        }
      }
    }
    if (this.#child === child) this.#child = undefined;
    this.#status = undefined;
    this.#activeGeneration = 0;
    this.#terminationRetained = false;
    await this.#removeRuntimeConfig(configDirectory);
    if (child !== undefined || configDirectory !== undefined) await this.#options.onStopped?.();
  }

  restart(address: StreamableHttpGatewayAddress): Promise<NgrokTunnelStatus> {
    if (address.host !== "127.0.0.1") {
      return Promise.reject(new Error("ngrok may only forward to the OmniCodex loopback gateway"));
    }
    const targetUrl = `http://127.0.0.1:${address.port}`;
    const generation = ++this.#generation;
    this.#stopping = true;
    this.#desiredTargetUrl = targetUrl;
    this.#readinessAbort?.abort();
    const promise = this.#enqueueLifecycle(async () => {
      await this.#stopImpl();
      return this.#runStart(address, generation, targetUrl);
    });
    this.#startRequest = { targetUrl, generation, promise };
    void promise.then(
      () => {
        if (this.#startRequest?.generation === generation) this.#startRequest = undefined;
      },
      () => {
        if (this.#startRequest?.generation === generation) this.#startRequest = undefined;
      },
    );
    return promise;
  }

  async #createRuntimeConfig(): Promise<{ readonly directory: string; readonly path: string }> {
    const directory = await mkdtemp(join(tmpdir(), "omnicodex-ngrok-"));
    const path = join(directory, "ngrok.yml");
    try {
      await writeFile(path, 'version: "2"\nweb_addr: false\n', {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      this.#temporaryConfigDirectory = directory;
      return { directory, path };
    } catch (error) {
      await rm(directory, { force: true, recursive: true }).catch(() => undefined);
      throw error;
    }
  }

  async #removeRuntimeConfig(expectedDirectory?: string): Promise<void> {
    const directory = expectedDirectory ?? this.#temporaryConfigDirectory;
    if (directory !== undefined && this.#temporaryConfigDirectory === directory) {
      this.#temporaryConfigDirectory = undefined;
    }
    if (directory !== undefined) await rm(directory, { force: true, recursive: true });
  }

  async #waitUntilReady(
    child: OwnedHiddenChildProcess,
    readinessUrl: URL,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.#options.startupTimeoutMs;
    const childExit = watchChildExit(
      child,
      () => new Error(`ngrok exited before readiness${diagnosticSuffix(this.#diagnostic)}`),
    );
    try {
      while (Date.now() < deadline) {
        this.#assertCurrentGeneration(generation, this.#desiredTargetUrl, signal);
        if (hasExited(child)) {
          throw new Error(`ngrok exited before readiness${diagnosticSuffix(this.#diagnostic)}`);
        }
        if (
          this.#ownedTunnelReady &&
          (await abortable(
            Promise.race([
              this.#options
                .probe(readinessUrl, this.#options.expectedResource, signal)
                .catch((error: unknown) => {
                  if (error instanceof NgrokPublicEndpointUnavailableError) throw error;
                  return false;
                }),
              childExit.promise,
            ]),
            signal,
          ))
        ) {
          return;
        }
        await abortable(
          Promise.race([delay(this.#options.probeIntervalMs, signal), childExit.promise]),
          signal,
        );
      }
      throw new Error(`ngrok readiness timed out${diagnosticSuffix(this.#diagnostic)}`);
    } finally {
      childExit.dispose();
    }
  }

  #capture(
    stream: NodeJS.ReadableStream | null,
    inspectReadiness: boolean,
    child: OwnedHiddenChildProcess,
    generation: number,
  ): void {
    stream?.on("data", (chunk: Buffer | string) => {
      if (this.#child !== child || this.#activeGeneration !== generation) return;
      const text = chunk.toString();
      if (inspectReadiness && !this.#ownedTunnelReady) {
        this.#stdoutBuffer += text;
        let newline = this.#stdoutBuffer.indexOf("\n");
        while (newline >= 0) {
          const line = this.#stdoutBuffer.slice(0, newline).trim();
          this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
          if (isOwnedTunnelReadyLog(line, this.#options.publicUrl)) {
            this.#ownedTunnelReady = true;
            this.#stdoutBuffer = "";
            break;
          }
          newline = this.#stdoutBuffer.indexOf("\n");
        }
      }
      this.#diagnostic += redactDiagnostic(text);
    });
  }

  #observeUnexpectedExit(
    child: OwnedHiddenChildProcess,
    generation: number,
    configDirectory: string,
  ): void {
    let observed = false;
    const report = () => {
      if (observed) return;
      if (
        this.#terminationRetained &&
        this.#child === child &&
        this.#activeGeneration === generation
      ) {
        observed = true;
        ++this.#generation;
        this.#desiredTargetUrl = undefined;
        this.#child = undefined;
        this.#status = undefined;
        this.#activeGeneration = 0;
        this.#terminationRetained = false;
        void this.#enqueueLifecycle(async () => {
          await this.#removeRuntimeConfig(configDirectory);
          await this.#options.onStopped?.();
        }).catch(() => undefined);
        return;
      }
      if (
        this.#stopping ||
        this.#child !== child ||
        this.#activeGeneration !== generation ||
        this.#status === undefined
      )
        return;
      observed = true;
      const error = new Error(`ngrok exited after readiness${diagnosticSuffix(this.#diagnostic)}`);
      ++this.#generation;
      this.#desiredTargetUrl = undefined;
      this.#child = undefined;
      this.#status = undefined;
      this.#activeGeneration = 0;
      void this.#enqueueLifecycle(async () => {
        await this.#removeRuntimeConfig(configDirectory);
        await this.#options.onStopped?.();
      }).catch(() => undefined);
      void Promise.resolve(this.#options.onUnexpectedExit?.(error)).catch(() => undefined);
    };
    child.once("close", report);
    child.once("error", report);
  }

  async #cleanupFailedStart(
    child: OwnedHiddenChildProcess,
    configDirectory: string,
  ): Promise<void> {
    if (!hasExited(child)) {
      this.#options.childProcesses.terminateOwnedHiddenChild(child, "SIGTERM");
      const gracefullyClosed = await waitForExit(child, this.#options.gracefulStopTimeoutMs);
      if (!gracefullyClosed) {
        this.#options.childProcesses.terminateOwnedHiddenChild(child, "SIGKILL");
        const forciblyClosed = await waitForExit(child, this.#options.forceStopTimeoutMs);
        if (!forciblyClosed) {
          this.#terminationRetained = true;
          throw new Error(
            `owned ngrok process ${String(child.pid)} did not exit after SIGTERM and SIGKILL; ownership retained`,
          );
        }
      }
    }
    if (this.#child === child) this.#child = undefined;
    if (this.#activeGeneration !== 0) this.#activeGeneration = 0;
    this.#status = undefined;
    this.#terminationRetained = false;
    await this.#removeRuntimeConfig(configDirectory);
    await this.#options.onStopped?.();
  }

  #assertCurrentGeneration(
    generation: number,
    targetUrl: string | undefined,
    signal?: AbortSignal,
  ): void {
    if (
      signal?.aborted === true ||
      generation !== this.#generation ||
      targetUrl === undefined ||
      this.#desiredTargetUrl !== targetUrl
    ) {
      throw lifecycleSupersededError("ngrok");
    }
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

async function probePublicEndpoint(
  url: URL,
  expectedResource: string,
  parentSignal?: AbortSignal,
): Promise<boolean> {
  const timeoutSignal = AbortSignal.timeout(5_000);
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal:
      parentSignal === undefined ? timeoutSignal : AbortSignal.any([parentSignal, timeoutSignal]),
  });
  const body = await response.text();
  if (
    response.status === 403 &&
    body.toLocaleLowerCase("en-US").includes("reached its network bandwidth limit")
  ) {
    throw new NgrokPublicEndpointUnavailableError(
      "ngrok public endpoint rejected readiness: account network bandwidth limit reached (HTTP 403)",
    );
  }
  if (response.status !== 200) return false;
  if (body.length > 65_536) return false;
  let metadata: unknown;
  try {
    metadata = JSON.parse(body);
  } catch {
    return false;
  }
  return isObject(metadata) && metadata.resource === expectedResource;
}

function stableHttpsOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ngrok public URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("ngrok public URL must be a credential-free HTTPS origin");
  }
  return url;
}

function normalizeMcpPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function isOwnedTunnelReadyLog(line: string, expectedPublicUrl: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return false;
  }
  if (!isObject(value) || typeof value.url !== "string") return false;
  const message = typeof value.msg === "string" ? value.msg.toLocaleLowerCase("en-US") : "";
  if (!message.includes("started tunnel") && !message.includes("tunnel started")) return false;
  try {
    return new URL(value.url).origin === new URL(expectedPublicUrl).origin;
  } catch {
    return false;
  }
}

function redactDiagnostic(value: string): string {
  return value
    .replaceAll(/((?:token|secret|authorization|password))["'=:\s]+[^\s,"'}]+/gi, "$1=[redacted]")
    .replaceAll(/(?:ngrok_[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{32,})/g, "[redacted]");
}

function diagnosticSuffix(value: string): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized.length === 0 ? "" : `: ${normalized}`;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(lifecycleSupersededError("ngrok"));
  return new Promise((resolveDelay, rejectDelay) => {
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(lifecycleSupersededError("ngrok"));
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
  if (signal.aborted) return Promise.reject(lifecycleSupersededError("ngrok"));
  return new Promise<T>((resolveOperation, rejectOperation) => {
    let settled = false;
    const finish = (result: { readonly value: T } | { readonly error: unknown }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if ("error" in result) rejectOperation(result.error);
      else resolveOperation(result.value);
    };
    const onAbort = () => finish({ error: lifecycleSupersededError("ngrok") });
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

function watchChildExit(
  child: OwnedHiddenChildProcess,
  errorFactory: () => Error,
): { readonly promise: Promise<never>; readonly dispose: () => void } {
  let rejectExit: ((error: Error) => void) | undefined;
  const promise = new Promise<never>((_resolveExit, rejectPromise) => {
    rejectExit = rejectPromise;
  });
  const onExit = () => rejectExit?.(errorFactory());
  child.once("close", onExit);
  child.once("error", onExit);
  return {
    promise,
    dispose: () => {
      child.off("close", onExit);
      child.off("error", onExit);
    },
  };
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
