import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { HttpAuthorizationDecision } from "../mcp/streamable-http-gateway.js";

const LOCAL_DAEMON_ISSUER = "urn:omnicodex:local-daemon";

export interface LocalDaemonOwnerAuthorizationOptions {
  readonly request: IncomingMessage;
  readonly expectedToken: string;
  readonly resource: string;
}

/**
 * Authenticate the same Windows user that owns the long-lived daemon without
 * minting a second OAuth client or starting a second App Server. The token is
 * stored only in the user-owned daemon state and is accepted only from a
 * loopback socket. A non-match falls through to the normal public JWT
 * authorizer so this path cannot weaken remote Web ChatGPT authentication.
 */
export function authorizeLocalDaemonOwner(
  options: LocalDaemonOwnerAuthorizationOptions,
): HttpAuthorizationDecision | undefined {
  if (!isLoopbackAddress(options.request.socket.remoteAddress)) return undefined;
  const authorization = options.request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return undefined;
  }
  const suppliedToken = authorization.slice("Bearer ".length);
  if (!tokensEqual(suppliedToken, options.expectedToken)) return undefined;

  return {
    ok: true,
    identity: {
      issuer: LOCAL_DAEMON_ISSUER,
      subject: "local-owner",
      clientId: "omnicodex-cli",
      resource: options.resource,
      executorLifecycle: "transport",
    },
    authInfo: {
      token: suppliedToken,
      clientId: "omnicodex-cli",
      scopes: ["omnicodex:full"],
      resource: new URL(options.resource),
      extra: { issuer: LOCAL_DAEMON_ISSUER, subject: "local-owner" },
    },
  };
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function tokensEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
