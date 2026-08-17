import type { StreamableHttpGatewayAddress } from "../mcp/streamable-http-gateway.js";
import {
  HiddenChildProcessBoundary,
  type OwnedHiddenChildProcess,
} from "../windows/hidden-child-process.js";

export type ExternalTunnelKind = "cloudflare" | "tailscale";
export interface ReconnectPolicy {
  readonly maximumRestarts: number;
  readonly delayMs: number;
}
export interface ExternalTunnelSupervisorOptions {
  readonly kind: ExternalTunnelKind;
  readonly executablePath: string;
  readonly publicUrl: string;
  readonly startupTimeoutMs?: number;
  readonly probeIntervalMs?: number;
  readonly reconnectPolicy?: ReconnectPolicy;
  readonly childProcesses?: HiddenChildProcessBoundary;
  readonly probe?: (url: URL) => Promise<boolean>;
  readonly now?: () => number;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

export class ExternalTunnelSupervisor {
  readonly #options: ExternalTunnelSupervisorOptions;
  readonly #childProcesses: HiddenChildProcessBoundary;
  #child: OwnedHiddenChildProcess | undefined;
  #status:
    | { readonly kind: ExternalTunnelKind; readonly publicUrl: string; readonly pid: number }
    | undefined;

  constructor(options: ExternalTunnelSupervisorOptions) {
    this.#options = { ...options, publicUrl: exactHttpsOrigin(options.publicUrl) };
    this.#childProcesses = options.childProcesses ?? new HiddenChildProcessBoundary();
    const policy = options.reconnectPolicy ?? { maximumRestarts: 3, delayMs: 1_000 };
    if (
      !Number.isSafeInteger(policy.maximumRestarts) ||
      policy.maximumRestarts < 0 ||
      policy.maximumRestarts > 10
    )
      throw new Error("Invalid tunnel reconnect limit");
  }

  get status() {
    return this.#status;
  }

  async start(address: StreamableHttpGatewayAddress) {
    if (address.host !== "127.0.0.1") throw new Error("Tunnel target must be loopback-only");
    if (this.#child !== undefined) throw new Error("Tunnel is already starting");
    const target = `http://127.0.0.1:${address.port}`;
    const args =
      this.#options.kind === "cloudflare"
        ? ["tunnel", "--no-autoupdate", "--url", target]
        : ["funnel", "--bg=false", target];
    const child = this.#childProcesses.spawnHidden(this.#options.executablePath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    this.#child = child;
    const pid = child.pid;
    if (pid === undefined) {
      await this.stop();
      throw new Error("Tunnel child has no pid");
    }
    const readiness = new URL(
      `/.well-known/oauth-protected-resource${address.path}`,
      this.#options.publicUrl,
    );
    const now = this.#options.now ?? Date.now;
    const pause =
      this.#options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = now() + (this.#options.startupTimeoutMs ?? 30_000);
    while (now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        await this.stop();
        throw new Error(`${this.#options.kind} exited before readiness`);
      }
      if (await (this.#options.probe ?? defaultProbe)(readiness).catch(() => false)) {
        const status = {
          kind: this.#options.kind,
          publicUrl: this.#options.publicUrl,
          pid,
        };
        this.#status = status;
        return status;
      }
      await pause(this.#options.probeIntervalMs ?? 250);
    }
    await this.stop();
    throw new Error(`${this.#options.kind} readiness timed out`);
  }

  async stop(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    this.#status = undefined;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    this.#childProcesses.terminateOwnedHiddenChild(child);
  }
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
  )
    throw new Error("Tunnel public URL must be an exact credential-free HTTPS origin");
  return url.origin;
}

async function defaultProbe(url: URL): Promise<boolean> {
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  return response.status === 200;
}
