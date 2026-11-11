import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  HiddenChildProcessBoundary,
  type OwnedHiddenChildProcess,
  type RecoveredWindowsProcessIdentity,
} from "./hidden-child-process.js";

export interface OracleBrowserLaunchSpec {
  readonly chromeExecutablePath: string;
  readonly profilePath: string;
}

export interface OracleBrowserLaunchSpecOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly pathExists?: (path: string) => boolean;
}

export interface OracleBrowserSupervisorOptions {
  readonly cdpEndpoint: string;
  readonly chromeExecutablePath: string;
  readonly profilePath: string;
  readonly startupTimeoutMs?: number;
  readonly probeIntervalMs?: number;
  readonly childProcesses?: HiddenChildProcessBoundary;
  readonly probe?: (
    versionEndpoint: URL,
    options?: { readonly timeoutMs?: number },
  ) => Promise<boolean>;
  readonly now?: () => number;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly onUnexpectedExit?: (error: Error) => Promise<void> | void;
}

export type OracleBrowserStatus =
  | {
      readonly ownership: "external";
      readonly cdpEndpoint: string;
      readonly versionEndpoint: string;
      readonly executablePath: string;
      readonly profilePath: string;
    }
  | {
      readonly ownership: "owned";
      readonly cdpEndpoint: string;
      readonly versionEndpoint: string;
      readonly pid: number;
      readonly executablePath: string;
      readonly profilePath: string;
    };

/**
 * Resolves the one dedicated, logged-in Oracle transport profile without ever
 * falling back to the user's normal Chrome profile. Explicit environment
 * overrides are intended for managed installations and tests.
 */
export function resolveOracleBrowserLaunchSpec(
  options: OracleBrowserLaunchSpecOptions = {},
): OracleBrowserLaunchSpec {
  const environment = options.environment ?? process.env;
  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  const pathExists = options.pathExists ?? existsSync;
  const explicitExecutable = nonEmptyString(environment.OMNICODEX_ORACLE_CHROME_PATH);
  const candidates =
    explicitExecutable === undefined
      ? [
          environment.PROGRAMFILES === undefined
            ? undefined
            : join(environment.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
          environment["PROGRAMFILES(X86)"] === undefined
            ? undefined
            : join(
                environment["PROGRAMFILES(X86)"],
                "Google",
                "Chrome",
                "Application",
                "chrome.exe",
              ),
          environment.LOCALAPPDATA === undefined
            ? undefined
            : join(environment.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
        ]
      : [explicitExecutable];
  const executable = candidates
    .filter((candidate): candidate is string => candidate !== undefined)
    .map((candidate) => resolve(candidate))
    .find(pathExists);
  if (executable === undefined) {
    throw new Error("Oracle browser requires an installed Google Chrome executable");
  }

  const profilePath = resolve(
    nonEmptyString(environment.OMNICODEX_ORACLE_BROWSER_PROFILE) ??
      join(homeDirectory, ".browser-agent", "browser-profile"),
  );
  if (!pathExists(profilePath)) {
    throw new Error("Oracle browser requires the dedicated logged-in browser-agent profile");
  }
  return { chromeExecutablePath: executable, profilePath };
}

/**
 * Reuses an already-running loopback CDP browser or owns exactly one isolated
 * non-headless Chrome child. External browsers are observed but never stopped.
 */
export class OracleBrowserSupervisor {
  readonly #cdpEndpoint: URL;
  readonly #chromeExecutablePath: string;
  readonly #profilePath: string;
  readonly #startupTimeoutMs: number | undefined;
  readonly #probeIntervalMs: number;
  readonly #childProcesses: HiddenChildProcessBoundary;
  readonly #probe: (
    versionEndpoint: URL,
    options?: { readonly timeoutMs?: number },
  ) => Promise<boolean>;
  readonly #now: () => number;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #onUnexpectedExit: ((error: Error) => Promise<void> | void) | undefined;
  #child: OwnedHiddenChildProcess | undefined;
  #status: OracleBrowserStatus | undefined;
  #stopping = false;

  constructor(options: OracleBrowserSupervisorOptions) {
    this.#cdpEndpoint = exactLoopbackCdpEndpoint(options.cdpEndpoint);
    if (options.chromeExecutablePath.length === 0) {
      throw new Error("Chrome executable path must not be empty");
    }
    if (options.profilePath.length === 0) {
      throw new Error("Oracle browser profile path must not be empty");
    }
    this.#chromeExecutablePath = options.chromeExecutablePath;
    this.#profilePath = options.profilePath;
    this.#startupTimeoutMs = optionalPositiveMilliseconds(
      options.startupTimeoutMs,
      "startupTimeoutMs",
    );
    this.#probeIntervalMs = positiveMilliseconds(options.probeIntervalMs ?? 100, "probeIntervalMs");
    this.#childProcesses = options.childProcesses ?? new HiddenChildProcessBoundary();
    this.#probe =
      options.probe ??
      ((versionEndpoint, probeOptions) =>
        probeCdpVersion(
          versionEndpoint,
          this.#chromeExecutablePath,
          this.#profilePath,
          this.#childProcesses,
          probeOptions?.timeoutMs,
        ));
    this.#now = options.now ?? Date.now;
    this.#delay =
      options.delay ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#onUnexpectedExit = options.onUnexpectedExit;
  }

  get status(): OracleBrowserStatus | undefined {
    return this.#status;
  }

  /** Performs the full identity, target-list, and browser-CDP responsiveness probe. */
  async isHealthy(timeoutMs?: number): Promise<boolean> {
    return this.#isReachable(
      cdpVersionEndpoint(this.#cdpEndpoint),
      optionalPositiveMilliseconds(timeoutMs, "timeoutMs"),
    );
  }

  async start(): Promise<OracleBrowserStatus> {
    this.#stopping = false;
    if (this.#status !== undefined) return this.#status;
    if (this.#child !== undefined) throw new Error("Oracle browser is already starting");

    const versionEndpoint = cdpVersionEndpoint(this.#cdpEndpoint);
    if (await this.#isReachable(versionEndpoint)) {
      const status: OracleBrowserStatus = {
        ownership: "external",
        cdpEndpoint: this.#cdpEndpoint.origin,
        versionEndpoint: versionEndpoint.href,
        executablePath: this.#chromeExecutablePath,
        profilePath: this.#profilePath,
      };
      this.#status = status;
      return status;
    }

    const child = this.#childProcesses.spawnHidden(
      this.#chromeExecutablePath,
      chromeArguments(this.#cdpEndpoint, this.#profilePath),
      {
        env: process.env,
        stdio: "ignore",
      },
    );
    this.#child = child;
    let launchError: Error | undefined;
    child.once("error", (error) => {
      launchError = error;
    });
    child.once("close", () => {
      if (this.#child !== child) return;
      const unexpected = this.#status?.ownership === "owned" && !this.#stopping;
      this.#child = undefined;
      if (this.#status?.ownership === "owned") this.#status = undefined;
      if (unexpected) {
        void Promise.resolve(
          this.#onUnexpectedExit?.(new Error("Owned Oracle browser exited unexpectedly")),
        ).catch(() => undefined);
      }
    });

    const pid = child.pid;
    if (pid === undefined) {
      this.#terminateOwned(child);
      throw new Error("Oracle browser child has no process id");
    }

    try {
      const startupStartedAt = this.#now();
      const remainingStartupMs = (): number | undefined =>
        this.#startupTimeoutMs === undefined
          ? undefined
          : Math.max(0, this.#startupTimeoutMs - Math.max(0, this.#now() - startupStartedAt));
      while (true) {
        if (launchError !== undefined) throw launchError;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error("Oracle browser exited before CDP readiness");
        }
        const probeTimeoutMs = remainingStartupMs();
        const reachable = await this.#isReachable(
          versionEndpoint,
          probeTimeoutMs === undefined ? undefined : Math.max(1, probeTimeoutMs),
        );
        if (launchError !== undefined) throw launchError;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error("Oracle browser exited before CDP readiness");
        }
        if (reachable) {
          const status: OracleBrowserStatus = {
            ownership: "owned",
            cdpEndpoint: this.#cdpEndpoint.origin,
            versionEndpoint: versionEndpoint.href,
            pid,
            executablePath: this.#chromeExecutablePath,
            profilePath: this.#profilePath,
          };
          this.#status = status;
          return status;
        }
        const remainingMs = remainingStartupMs();
        if (remainingMs === 0) break;
        await this.#delay(
          remainingMs === undefined
            ? this.#probeIntervalMs
            : Math.min(this.#probeIntervalMs, remainingMs),
        );
      }
    } catch (error) {
      this.#terminateOwned(child);
      throw error;
    }

    this.#terminateOwned(child);
    throw new Error("Oracle browser CDP readiness timed out");
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#status = undefined;
    const child = this.#child;
    if (child === undefined) return;
    this.#terminateOwned(child);
  }

  /** Restarts only the exact Chrome child spawned by this supervisor. */
  async restart(): Promise<OracleBrowserStatus> {
    const status = this.#status;
    if (status?.ownership === "external") {
      this.#status = undefined;
      if (await this.#isReachable(cdpVersionEndpoint(this.#cdpEndpoint))) return this.start();
      // The observed listener has disappeared. Nothing foreign remains to stop;
      // start one isolated, dedicated-profile Chrome owned by this supervisor.
      return this.start();
    }
    const child = this.#child;
    if (child === undefined) {
      this.#status = undefined;
      return this.start();
    }
    this.#stopping = true;
    this.#status = undefined;
    if (!this.#childProcesses.terminateOwnedHiddenChild(child, "SIGTERM")) {
      this.#stopping = false;
      throw new Error("Oracle browser restart lost owned child identity");
    }
    if (!(await this.#waitForOwnedExit(child, 3_000))) {
      this.#childProcesses.terminateOwnedHiddenChild(child, "SIGKILL");
      if (!(await this.#waitForOwnedExit(child, 2_000))) {
        this.#stopping = false;
        throw new Error("Owned Oracle browser did not exit during bounded restart");
      }
    }
    if (this.#child === child) this.#child = undefined;
    this.#stopping = false;
    return this.start();
  }

  async #isReachable(versionEndpoint: URL, timeoutMs?: number): Promise<boolean> {
    return this.#probe(versionEndpoint, timeoutMs === undefined ? undefined : { timeoutMs }).catch(
      () => false,
    );
  }

  async #waitForOwnedExit(child: OwnedHiddenChildProcess, timeoutMs: number): Promise<boolean> {
    const deadline = this.#now() + timeoutMs;
    while (child.exitCode === null && child.signalCode === null && this.#now() < deadline) {
      await this.#delay(Math.min(50, deadline - this.#now()));
    }
    return child.exitCode !== null || child.signalCode !== null;
  }

  #terminateOwned(child: OwnedHiddenChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) {
      if (this.#child === child) this.#child = undefined;
      return;
    }
    const signaled = this.#childProcesses.terminateOwnedHiddenChild(child, "SIGTERM");
    if (signaled && this.#child === child) this.#child = undefined;
  }
}

function chromeArguments(cdpEndpoint: URL, profilePath: string): readonly string[] {
  const debuggingAddress = cdpEndpoint.hostname === "[::1]" ? "::1" : cdpEndpoint.hostname;
  return [
    `--remote-debugging-address=${debuggingAddress}`,
    `--remote-debugging-port=${cdpEndpoint.port}`,
    `--user-data-dir=${profilePath}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    "--window-position=-32000,-32000",
    "--window-size=1280,800",
    "--new-window",
    "about:blank",
  ];
}

function exactLoopbackCdpEndpoint(value: string): URL {
  const endpoint = new URL(value);
  const host = endpoint.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  const port = Number(endpoint.port);
  if (
    endpoint.protocol !== "http:" ||
    !loopback ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("CDP endpoint must be an exact credential-free loopback HTTP origin with port");
  }
  return endpoint;
}

function cdpVersionEndpoint(cdpEndpoint: URL): URL {
  return new URL("/json/version", cdpEndpoint);
}

async function probeCdpVersion(
  versionEndpoint: URL,
  executablePath: string,
  profilePath: string,
  childProcesses: HiddenChildProcessBoundary,
  timeoutMs?: number,
): Promise<boolean> {
  const deadline = timeoutMs === undefined ? undefined : BigInt(Date.now()) + BigInt(timeoutMs);
  const scheduled = scheduleOptionalAbort(timeoutMs);
  try {
    const versionResponse = await fetch(versionEndpoint, {
      method: "GET",
      redirect: "manual",
      ...(scheduled === undefined ? {} : { signal: scheduled.signal }),
    });
    if (versionResponse.status !== 200) return false;
    const payload = (await versionResponse.json().catch(() => undefined)) as unknown;
    const remaining = remainingMilliseconds(deadline);
    if (remaining === 0) return false;
    const listener = await childProcesses
      .inspectWindowsLoopbackTcpListener(
        Number(versionEndpoint.port),
        remaining === undefined ? {} : { timeoutMs: remaining },
      )
      .catch(() => undefined);
    if (
      !matchesOracleBrowserProcess(payload, listener, executablePath, profilePath, versionEndpoint)
    ) {
      return false;
    }
    const targetResponse = await fetch(new URL("/json/list", versionEndpoint), {
      method: "GET",
      redirect: "manual",
      ...(scheduled === undefined ? {} : { signal: scheduled.signal }),
    });
    if (targetResponse.status !== 200) return false;
    const targets = (await targetResponse.json().catch(() => undefined)) as unknown;
    if (!Array.isArray(targets)) return false;
    const browserWebSocketUrl = browserWebSocketDebuggerUrl(payload);
    return (
      browserWebSocketUrl !== undefined &&
      (await probeBrowserTargetEnumeration(browserWebSocketUrl, scheduled?.signal))
    );
  } finally {
    scheduled?.cancel();
  }
}

async function probeBrowserTargetEnumeration(
  webSocketUrl: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    if (signal?.aborted === true) {
      resolveProbe(false);
      return;
    }
    const socket = new WebSocket(webSocketUrl);
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      socket.close(1000, "health-probe-complete");
      resolveProbe(value);
    };
    const onAbort = () => finish(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener(
      "open",
      () => socket.send(JSON.stringify({ id: 1, method: "Target.getTargets", params: {} })),
      { once: true },
    );
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        const value: unknown = JSON.parse(event.data);
        if (
          typeof value === "object" &&
          value !== null &&
          "id" in value &&
          value.id === 1 &&
          "result" in value &&
          typeof value.result === "object" &&
          value.result !== null &&
          "targetInfos" in value.result &&
          Array.isArray(value.result.targetInfos)
        ) {
          finish(true);
        }
      } catch {
        finish(false);
      }
    });
    socket.addEventListener("error", () => finish(false), { once: true });
    socket.addEventListener("close", () => finish(false), { once: true });
  });
}

function browserWebSocketDebuggerUrl(payload: unknown): string | undefined {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("webSocketDebuggerUrl" in payload) ||
    typeof payload.webSocketDebuggerUrl !== "string"
  ) {
    return undefined;
  }
  try {
    const url = new URL(payload.webSocketDebuggerUrl);
    const host = url.hostname.toLocaleLowerCase("en-US");
    return url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(host)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function matchesOracleBrowserProcess(
  payload: unknown,
  listener: RecoveredWindowsProcessIdentity | undefined,
  executablePath: string,
  profilePath: string,
  versionEndpoint: URL,
): boolean {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("Browser" in payload) ||
    typeof payload.Browser !== "string" ||
    !payload.Browser.startsWith("Chrome/") ||
    !("webSocketDebuggerUrl" in payload) ||
    typeof payload.webSocketDebuggerUrl !== "string" ||
    listener === undefined
  ) {
    return false;
  }
  if (
    resolve(listener.executablePath).toLocaleLowerCase("en-US") !==
    resolve(executablePath).toLocaleLowerCase("en-US")
  ) {
    return false;
  }
  if (
    !commandLineHasExactSwitch(
      listener.commandLine,
      "remote-debugging-port",
      versionEndpoint.port,
    ) ||
    !commandLineHasExactSwitch(listener.commandLine, "user-data-dir", resolve(profilePath))
  ) {
    return false;
  }
  try {
    const socket = new URL(payload.webSocketDebuggerUrl);
    return socket.protocol === "ws:" && socket.port === versionEndpoint.port;
  } catch {
    return false;
  }
}

function commandLineHasExactSwitch(commandLine: string, name: string, value: string): boolean {
  const escapedName = escapeRegExp(name);
  const escapedValue = escapeRegExp(value);
  return new RegExp(
    `(?:^|\\s)(?:"--${escapedName}=${escapedValue}"|--${escapedName}="${escapedValue}"|--${escapedName}=${escapedValue})(?=\\s|$)`,
    "iu",
  ).test(commandLine);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function positiveMilliseconds(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function optionalPositiveMilliseconds(value: number | undefined, name: string): number | undefined {
  return value === undefined ? undefined : positiveMilliseconds(value, name);
}

function remainingMilliseconds(deadline: bigint | undefined): number | undefined {
  if (deadline === undefined) return undefined;
  const remaining = deadline - BigInt(Date.now());
  if (remaining <= 0n) return 0;
  return Number(
    remaining > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : remaining,
  );
}

function scheduleOptionalAbort(
  timeoutMs: number | undefined,
): { readonly signal: AbortSignal; readonly cancel: () => void } | undefined {
  if (timeoutMs === undefined) return undefined;
  const controller = new AbortController();
  const deadline = BigInt(Date.now()) + BigInt(timeoutMs);
  const maximumTimerDelayMs = 2_147_483_647n;
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  const arm = (): void => {
    if (cancelled) return;
    const remaining = deadline - BigInt(Date.now());
    if (remaining <= 0n) {
      controller.abort(new Error("Oracle browser probe reached the caller deadline"));
      return;
    }
    timer = setTimeout(
      arm,
      Number(remaining > maximumTimerDelayMs ? maximumTimerDelayMs : remaining),
    );
    timer.unref?.();
  };
  arm();
  return {
    signal: controller.signal,
    cancel: () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function nonEmptyString(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value.trim();
}
