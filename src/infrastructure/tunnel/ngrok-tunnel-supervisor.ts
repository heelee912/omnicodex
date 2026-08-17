import { access } from "node:fs/promises";
import type { StreamableHttpGatewayAddress } from "../mcp/streamable-http-gateway.js";
import {
  HiddenChildProcessBoundary,
  type OwnedHiddenChildProcess,
} from "../windows/hidden-child-process.js";

export interface NgrokTunnelSupervisorOptions {
  readonly executablePath: string;
  readonly publicUrl: string;
  readonly expectedResource: string;
  readonly startupTimeoutMs?: number;
  readonly probeIntervalMs?: number;
  readonly probe?: (url: URL, expectedResource: string) => Promise<boolean>;
  readonly childProcesses?: HiddenChildProcessBoundary;
}

export interface NgrokTunnelStatus {
  readonly kind: "ngrok";
  readonly publicUrl: string;
  readonly targetUrl: string;
  readonly pid: number;
}

/**
 * Owns exactly one ngrok child. Credentials stay in ngrok's protected user
 * configuration; OmniCodex never places them in arguments, logs, or state.
 */
export class NgrokTunnelSupervisor {
  readonly #options: Required<
    Pick<
      NgrokTunnelSupervisorOptions,
      "startupTimeoutMs" | "probeIntervalMs" | "probe" | "childProcesses"
    >
  > &
    NgrokTunnelSupervisorOptions;
  #child: OwnedHiddenChildProcess | undefined;
  #status: NgrokTunnelStatus | undefined;
  #diagnostic = "";

  constructor(options: NgrokTunnelSupervisorOptions) {
    const publicUrl = stableHttpsOrigin(options.publicUrl);
    this.#options = {
      ...options,
      publicUrl: publicUrl.href.replace(/\/$/, ""),
      startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
      probeIntervalMs: options.probeIntervalMs ?? 250,
      probe: options.probe ?? probePublicEndpoint,
      childProcesses: options.childProcesses ?? new HiddenChildProcessBoundary(),
    };
  }

  get status(): NgrokTunnelStatus | undefined {
    return this.#status;
  }

  async start(address: StreamableHttpGatewayAddress): Promise<NgrokTunnelStatus> {
    if (this.#status !== undefined) return this.#status;
    if (this.#child !== undefined) throw new Error("ngrok tunnel is already starting");
    if (address.host !== "127.0.0.1") {
      throw new Error("ngrok may only forward to the OmniCodex loopback gateway");
    }
    await access(this.#options.executablePath);
    const targetUrl = `http://127.0.0.1:${address.port}`;
    const readinessUrl = new URL(
      `/.well-known/oauth-protected-resource${normalizeMcpPath(address.path)}`,
      this.#options.publicUrl,
    );
    const child = this.#options.childProcesses.spawnHidden(
      this.#options.executablePath,
      ["http", targetUrl, "--url", this.#options.publicUrl, "--log=stdout", "--log-format=json"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    this.#child = child;
    child.once("error", () => undefined);
    this.#capture(child.stdout);
    this.#capture(child.stderr);
    const pid = child.pid;
    if (pid === undefined) {
      await this.stop();
      throw new Error("ngrok did not receive a process id");
    }

    try {
      await this.#waitUntilReady(child, readinessUrl);
      const status: NgrokTunnelStatus = {
        kind: "ngrok",
        publicUrl: this.#options.publicUrl,
        targetUrl,
        pid,
      };
      this.#status = status;
      return status;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    this.#status = undefined;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
    this.#options.childProcesses.terminateOwnedHiddenChild(child);
    await Promise.race([closed, delay(5_000)]);
  }

  async #waitUntilReady(child: OwnedHiddenChildProcess, readinessUrl: URL): Promise<void> {
    const deadline = Date.now() + this.#options.startupTimeoutMs;
    let exited = false;
    child.once("close", () => {
      exited = true;
    });
    child.once("error", () => {
      exited = true;
    });
    while (Date.now() < deadline) {
      if (exited || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`ngrok exited before readiness${diagnosticSuffix(this.#diagnostic)}`);
      }
      if (
        await this.#options.probe(readinessUrl, this.#options.expectedResource).catch(() => false)
      )
        return;
      await delay(this.#options.probeIntervalMs);
    }
    throw new Error(`ngrok readiness timed out${diagnosticSuffix(this.#diagnostic)}`);
  }

  #capture(stream: NodeJS.ReadableStream | null): void {
    stream?.on("data", (chunk: Buffer | string) => {
      if (this.#diagnostic.length >= 8_192) return;
      const remaining = 8_192 - this.#diagnostic.length;
      this.#diagnostic += redactDiagnostic(chunk.toString().slice(0, remaining));
    });
  }
}

async function probePublicEndpoint(url: URL, expectedResource: string): Promise<boolean> {
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== 200) return false;
  const body = await response.text();
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

function redactDiagnostic(value: string): string {
  return value
    .replaceAll(/((?:token|secret|authorization|password))["'=:\s]+[^\s,"'}]+/gi, "$1=[redacted]")
    .replaceAll(/(?:ngrok_[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{32,})/g, "[redacted]");
}

function diagnosticSuffix(value: string): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim().slice(-1_024);
  return normalized.length === 0 ? "" : `: ${normalized}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
