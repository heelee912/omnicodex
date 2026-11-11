import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { authorizeLocalDaemonOwner } from "../src/infrastructure/auth/local-daemon-owner-authorizer.js";

const token = "local-owner-token-that-is-long-enough-for-the-daemon";
const resource = "https://omnicodex.example/mcp/full";

function request(remoteAddress: string, authorization?: string): IncomingMessage {
  return {
    headers: authorization === undefined ? {} : { authorization },
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

describe("authorizeLocalDaemonOwner", () => {
  it("accepts the exact daemon token from loopback", () => {
    const decision = authorizeLocalDaemonOwner({
      request: request("::ffff:127.0.0.1", `Bearer ${token}`),
      expectedToken: token,
      resource,
    });

    expect(decision).toMatchObject({
      ok: true,
      identity: {
        issuer: "urn:omnicodex:local-daemon",
        subject: "local-owner",
        clientId: "omnicodex-cli",
        resource,
        executorLifecycle: "transport",
      },
      authInfo: { scopes: ["omnicodex:full"] },
    });
  });

  it.each([
    ["remote address", request("203.0.113.7", `Bearer ${token}`), token],
    ["wrong token", request("127.0.0.1", "Bearer wrong-token"), token],
    ["missing token", request("::1"), token],
  ])("falls through for a %s mismatch", (_label, incoming, expectedToken) => {
    expect(
      authorizeLocalDaemonOwner({ request: incoming, expectedToken, resource }),
    ).toBeUndefined();
  });
});
