import type {
  OmniCodexConfig,
  OmniCodexDaemonState,
} from "../infrastructure/config/omnicodex-config-store.js";
import type { OmniCodexOperationalActivity } from "../infrastructure/operations/operational-log.js";
import type { OracleRemoteCdpTunnelStatus } from "../infrastructure/windows/oracle-remote-cdp-tunnel-supervisor.js";
import type { OracleApprovalPopupWatcherStatus } from "./oracle-approval-popup-watcher.js";

export interface OracleDaemonRuntimeStatus {
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly cdpTransport: "disabled" | "direct" | "remote_tunnel";
  readonly cdpTransportReady: boolean;
  readonly approvalMirrorReady: boolean;
  readonly approvalWatcher: OracleApprovalPopupWatcherStatus;
  readonly remoteTunnel?: Pick<OracleRemoteCdpTunnelStatus, "ownership" | "pid">;
  readonly activity?: OmniCodexOperationalActivity;
  readonly bindings?: Readonly<Record<string, OracleDaemonRuntimeStatus>>;
}

/** A selected client must not inherit a peer's readiness or transport status. */
export function oracleClientRuntimeStatus(
  runtime: OracleDaemonRuntimeStatus | undefined,
  clientBinding: string,
): OracleDaemonRuntimeStatus | undefined {
  return runtime?.bindings?.[clientBinding];
}

export function oracleDaemonRuntimeStatus(input: {
  readonly enabled: boolean;
  readonly remoteTunnelConfigured: boolean;
  readonly remoteTunnelStatus?: OracleRemoteCdpTunnelStatus;
  readonly approvalMirrorReady: boolean;
  readonly approvalAutomationEnabled?: boolean;
  readonly approvalWatcher?: OracleApprovalPopupWatcherStatus;
  readonly activity?: OmniCodexOperationalActivity;
}): OracleDaemonRuntimeStatus {
  const approvalAutomationEnabled = input.approvalAutomationEnabled !== false;
  const approvalWatcher = input.approvalWatcher ?? {
    state: "stopped",
    consecutiveFailures: 0,
    watchedTargets: 0,
  };
  const cdpTransport = !input.enabled
    ? "disabled"
    : input.remoteTunnelConfigured
      ? "remote_tunnel"
      : "direct";
  const cdpTransportReady =
    input.enabled &&
    (input.remoteTunnelConfigured
      ? input.remoteTunnelStatus !== undefined
      : !approvalAutomationEnabled ||
        (approvalWatcher.lastSuccessfulScanAt !== undefined &&
          approvalWatcher.state !== "stopped"));
  return {
    enabled: input.enabled,
    ready:
      input.enabled &&
      cdpTransportReady &&
      input.approvalMirrorReady &&
      (!approvalAutomationEnabled || approvalWatcher.state === "ready"),
    cdpTransport,
    cdpTransportReady,
    approvalMirrorReady: input.approvalMirrorReady,
    approvalWatcher,
    ...(input.activity === undefined ? {} : { activity: input.activity }),
    ...(input.remoteTunnelStatus === undefined
      ? {}
      : {
          remoteTunnel: {
            ownership: input.remoteTunnelStatus.ownership,
            ...(input.remoteTunnelStatus.pid === undefined
              ? {}
              : { pid: input.remoteTunnelStatus.pid }),
          },
        }),
  };
}

/**
 * Verify both ownership and the current public route. A live tunnel process or
 * a persisted successful start does not prove that ChatGPT can still reach it.
 */
export async function oraclePublicMcpReady(
  config: OmniCodexConfig,
  state: OmniCodexDaemonState | undefined,
  options: { readonly fetch?: typeof fetch; readonly signal?: AbortSignal } = {},
): Promise<boolean> {
  if (
    state === undefined ||
    (state.lifecycle !== "ready" && state.lifecycle !== "starting") ||
    state.address === undefined ||
    state.address.fullPath !== config.gateway.fullPath
  ) {
    return false;
  }
  // Registry reconciliation may temporarily report starting while the bound
  // gateway continues to serve. Its public reachability is a separate fact.
  const tunnel = config.tunnel;
  if (tunnel === undefined) return config.oracle?.enabled !== true;
  if (
    tunnel.kind !== "direct" &&
    (state.tunnel?.kind !== tunnel.kind ||
      state.tunnel.publicUrl !== tunnel.publicUrl ||
      !Number.isInteger(state.tunnel.pid) ||
      state.tunnel.pid <= 0)
  ) {
    return false;
  }
  try {
    const resource = new URL(config.gateway.fullPath, tunnel.publicUrl).href;
    const response = await (options.fetch ?? fetch)(
      new URL(`/.well-known/oauth-protected-resource${config.gateway.fullPath}`, tunnel.publicUrl),
      {
        redirect: "error",
        cache: "no-store",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (!response.ok) return false;
    const metadata = (await response.json()) as Record<string, unknown>;
    return (
      metadata.resource === resource &&
      Array.isArray(metadata.authorization_servers) &&
      metadata.authorization_servers.includes(config.auth.issuer)
    );
  } catch {
    return false;
  }
}
