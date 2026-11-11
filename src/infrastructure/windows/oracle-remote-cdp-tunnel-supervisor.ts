import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { freshLoopbackHttpFetch } from "../chatgpt/chatgpt-cdp-transport.js";
import type { OmniCodexOracleConfig } from "../config/omnicodex-config-store.js";
import {
  HiddenChildProcessBoundary,
  type OwnedHiddenChildProcess,
} from "./hidden-child-process.js";

export interface OracleRemoteCdpTunnelSupervisorOptions {
  readonly cdpEndpoint: string;
  readonly remote: NonNullable<OmniCodexOracleConfig["remoteCdpTunnel"]>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly pathExists?: (path: string) => boolean;
  readonly startupTimeoutMs?: number;
  readonly probeIntervalMs?: number;
  readonly childProcesses?: HiddenChildProcessBoundary;
  readonly probe?: (versionEndpoint: URL) => Promise<boolean>;
  readonly probeForward?: (endpoint: URL) => Promise<boolean>;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly onUnexpectedExit?: (error: Error) => Promise<void> | void;
}

export interface OracleRemoteCdpTunnelStatus {
  readonly ownership: "external" | "owned";
  readonly cdpEndpoint: string;
  readonly versionEndpoint: string;
  readonly sshHost: string;
  readonly remoteCdpPort: number;
  readonly pid?: number;
}

/**
 * Maintains only an encrypted loopback TCP forward to the Oracle browser.
 * It never launches Chrome, enumerates browser targets, enables Accessibility,
 * or polls DOM state on the Windows host.
 */
export class OracleRemoteCdpTunnelSupervisor {
  readonly #cdpEndpoint: URL;
  readonly #remote: NonNullable<OmniCodexOracleConfig["remoteCdpTunnel"]>;
  readonly #sshExecutable: string;
  readonly #startupTimeoutMs: number;
  readonly #probeIntervalMs: number;
  readonly #childProcesses: HiddenChildProcessBoundary;
  readonly #probe: (versionEndpoint: URL) => Promise<boolean>;
  readonly #probeForward: (endpoint: URL) => Promise<boolean>;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #onUnexpectedExit: ((error: Error) => Promise<void> | void) | undefined;
  #child: OwnedHiddenChildProcess | undefined;
  #status: OracleRemoteCdpTunnelStatus | undefined;
  #stopping = false;

  constructor(options: OracleRemoteCdpTunnelSupervisorOptions) {
    this.#cdpEndpoint = exactLoopbackEndpoint(options.cdpEndpoint);
    this.#remote = options.remote;
    const systemRoot = options.environment?.SystemRoot ?? process.env.SystemRoot;
    if (systemRoot === undefined || systemRoot.length === 0) {
      throw new Error("Oracle remote CDP tunnel requires SystemRoot");
    }
    this.#sshExecutable = resolve(join(systemRoot, "System32", "OpenSSH", "ssh.exe"));
    const pathExists = options.pathExists ?? existsSync;
    if (!pathExists(this.#sshExecutable)) {
      throw new Error("Oracle remote CDP tunnel requires Windows OpenSSH");
    }
    if (!pathExists(this.#remote.identityFile)) {
      throw new Error("Oracle remote CDP tunnel identity file is unavailable");
    }
    // A newly established Windows OpenSSH forward can reset its first CDP
    // channel while the next channel succeeds. Keep the same owned forward
    // long enough for a full fresh-connection probe instead of cycling ssh.exe
    // faster than the forwarded endpoint can recover.
    this.#startupTimeoutMs = positiveMilliseconds(options.startupTimeoutMs ?? 60_000);
    this.#probeIntervalMs = positiveMilliseconds(options.probeIntervalMs ?? 250);
    this.#childProcesses = options.childProcesses ?? new HiddenChildProcessBoundary();
    this.#probe = options.probe ?? probeCdpVersion;
    this.#probeForward = options.probeForward ?? probeLoopbackForward;
    this.#delay =
      options.delay ??
      ((milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)));
    this.#onUnexpectedExit = options.onUnexpectedExit;
  }

  get status(): OracleRemoteCdpTunnelStatus | undefined {
    return this.#status;
  }

  async start(): Promise<OracleRemoteCdpTunnelStatus> {
    this.#stopping = false;
    if (this.#status !== undefined) return this.#status;
    const versionEndpoint = new URL("/json/version", this.#cdpEndpoint);
    if (await this.#probe(versionEndpoint).catch(() => false)) {
      this.#status = this.#statusValue("external", versionEndpoint);
      return this.#status;
    }
    const child = this.#childProcesses.spawnHidden(
      this.#sshExecutable,
      sshArguments(this.#cdpEndpoint, this.#remote),
      { stdio: ["ignore", "ignore", "pipe"], env: process.env },
    );
    this.#child = child;
    let launchError: Error | undefined;
    const stderr = new BoundedSshDiagnostic(this.#remote.identityFile);
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.append(chunk));
    child.once("error", (error) => {
      launchError = tunnelError(
        "ORACLE_REMOTE_CDP_SSH_START_FAILED",
        "SSH process failed to start",
        stderr.value,
        error,
      );
    });
    child.once("close", (code, signal) => {
      if (this.#child !== child) return;
      const unexpected = this.#status?.ownership === "owned" && !this.#stopping;
      if (!unexpected && !this.#stopping && this.#status === undefined) {
        launchError = tunnelError(
          "ORACLE_REMOTE_CDP_SSH_EXITED",
          `SSH forward exited before readiness (code=${String(code)}, signal=${String(signal)})`,
          stderr.value,
        );
      }
      this.#child = undefined;
      if (this.#status?.ownership === "owned") this.#status = undefined;
      if (unexpected) {
        void Promise.resolve(
          this.#onUnexpectedExit?.(new Error("Owned Oracle remote CDP tunnel exited")),
        ).catch(() => undefined);
      }
    });
    if (child.pid === undefined) {
      this.#terminate(child);
      throw new Error("Oracle remote CDP tunnel child has no process id");
    }
    const deadline = Date.now() + this.#startupTimeoutMs;
    while (Date.now() < deadline) {
      if (launchError !== undefined) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw tunnelError(
          "ORACLE_REMOTE_CDP_SSH_EXITED",
          `SSH forward exited before readiness (code=${String(child.exitCode)}, signal=${String(child.signalCode)})`,
          stderr.value,
        );
      }
      if (await this.#probe(versionEndpoint).catch(() => false)) {
        this.#status = this.#statusValue("owned", versionEndpoint, child.pid);
        return this.#status;
      }
      await this.#delay(Math.min(this.#probeIntervalMs, Math.max(1, deadline - Date.now())));
    }
    const forwardReady = await this.#probeForward(this.#cdpEndpoint).catch(() => false);
    this.#terminate(child);
    if (forwardReady) {
      throw tunnelError(
        "ORACLE_REMOTE_CDP_UNAVAILABLE",
        "SSH forward is listening, but the remote Oracle CDP endpoint did not return /json/version",
        stderr.value,
      );
    }
    throw tunnelError(
      "ORACLE_REMOTE_CDP_SSH_UNAVAILABLE",
      "SSH forward did not become reachable before the startup deadline",
      stderr.value,
    );
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#status = undefined;
    const child = this.#child;
    if (child !== undefined) this.#terminate(child);
  }

  #statusValue(
    ownership: "external" | "owned",
    versionEndpoint: URL,
    pid?: number,
  ): OracleRemoteCdpTunnelStatus {
    return {
      ownership,
      cdpEndpoint: this.#cdpEndpoint.origin,
      versionEndpoint: versionEndpoint.href,
      sshHost: this.#remote.sshHost,
      remoteCdpPort: this.#remote.remoteCdpPort,
      ...(pid === undefined ? {} : { pid }),
    };
  }

  #terminate(child: OwnedHiddenChildProcess): void {
    if (child.exitCode === null && child.signalCode === null) {
      this.#childProcesses.terminateOwnedHiddenChild(child, "SIGTERM");
    }
    if (this.#child === child) this.#child = undefined;
  }
}

function sshArguments(
  endpoint: URL,
  remote: NonNullable<OmniCodexOracleConfig["remoteCdpTunnel"]>,
): readonly string[] {
  const localPort = Number(endpoint.port);
  return [
    "-N",
    "-T",
    "-i",
    remote.identityFile,
    // Windows OpenSSH 9.5 can authenticate and report a ready local listener
    // while a long-lived direct-tcpip channel opened with an explicit default
    // `-p 22` never forwards response bytes.  Omitting the redundant option
    // restores the exact same host/port through OpenSSH's default. Preserve an
    // explicit port only when the configured endpoint is genuinely non-default.
    ...(remote.sshPort === 22 ? [] : ["-p", String(remote.sshPort)]),
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ConnectionAttempts=1",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-L",
    `127.0.0.1:${String(localPort)}:127.0.0.1:${String(remote.remoteCdpPort)}`,
    `${remote.sshUser}@${remote.sshHost}`,
  ];
}

function exactLoopbackEndpoint(value: string): URL {
  const endpoint = new URL(value);
  const port = Number(endpoint.port);
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    endpoint.pathname !== "/" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.username !== "" ||
    endpoint.password !== ""
  ) {
    throw new Error("Oracle remote CDP tunnel requires an exact loopback endpoint");
  }
  return endpoint;
}

async function probeCdpVersion(versionEndpoint: URL): Promise<boolean> {
  // A pooled Undici connection can remain half-open across an OpenSSH local
  // forward restart and make every readiness probe fail even though a fresh
  // TCP connection succeeds. Readiness must use the same non-pooled loopback
  // transport as the CDP controller.
  const response = await freshLoopbackHttpFetch(versionEndpoint, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return false;
  const value: unknown = await response.json();
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).webSocketDebuggerUrl === "string"
  );
}

function probeLoopbackForward(endpoint: URL): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = connect({
      host: endpoint.hostname === "localhost" ? "127.0.0.1" : endpoint.hostname,
      port: Number(endpoint.port),
    });
    let settled = false;
    const settle = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(result);
    };
    socket.setTimeout(1_000, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

class BoundedSshDiagnostic {
  readonly #identityFile: string;
  readonly #decoder = new StringDecoder("utf8");
  #text = "";

  constructor(identityFile: string) {
    this.#identityFile = identityFile;
  }

  append(chunk: Buffer | string): void {
    this.#text += typeof chunk === "string" ? chunk : this.#decoder.write(Buffer.from(chunk));
    if (this.#text.length > 8_192) this.#text = this.#text.slice(-8_192);
  }

  get value(): string | undefined {
    const normalized = this.#text
      .replaceAll(this.#identityFile, "<identity-file>")
      .replace(/\s+/gu, " ")
      .trim();
    return normalized.length === 0 ? undefined : normalized.slice(-2_048);
  }
}

function tunnelError(code: string, message: string, diagnostic?: string, cause?: unknown): Error {
  return new Error(
    `${code}: ${message}${diagnostic === undefined ? "" : `; ssh=${diagnostic}`}`,
    cause === undefined ? undefined : { cause },
  );
}

function positiveMilliseconds(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Oracle remote CDP tunnel intervals must be positive integers");
  }
  return value;
}
