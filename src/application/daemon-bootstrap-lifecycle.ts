import type { OmniCodexDaemonState } from "../infrastructure/config/omnicodex-config-store.js";
import type { OmniCodexGatewayLifecycle } from "./omnicodex-gateway-service.js";

/**
 * A ready native gateway is only one part of daemon readiness. During initial
 * bootstrap the configured tunnel and approval watcher still have to settle,
 * so the externally persisted lifecycle must remain `starting` until the
 * daemon explicitly opens this gate.
 */
export function daemonLifecycleForGatewayStatus(
  status: OmniCodexGatewayLifecycle,
  bootstrapComplete: boolean,
): OmniCodexDaemonState["lifecycle"] {
  if (!bootstrapComplete) return "starting";
  if (status === "stopped") return "stopping";
  // Catalog convergence runs behind an already-serving gateway and retains
  // the last complete native catalog until the replacement is published.
  // Exposing that hot refresh as daemon `starting` makes clients retry a
  // healthy call and can amplify one catalog change into a request storm.
  if (status === "converging") return "ready";
  return status === "recovering" ? "starting" : status;
}
