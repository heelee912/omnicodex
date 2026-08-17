import type { IncomingMessage } from "node:http";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  type JwksDocument,
  JwtBearerAuthorizer,
} from "../src/infrastructure/auth/jwt-bearer-authorizer.js";

const issuer = "https://tenant.example/";
const resource = "https://api.example/mcp";
const now = new Date("2026-08-17T00:00:00.000Z");

function request(authorization?: string, remoteAddress = "127.0.0.1"): IncomingMessage {
  return {
    headers: authorization === undefined ? {} : { authorization },
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

describe("JwtBearerAuthorizer", () => {
  it("verifies the exact issuer, audience/resource, scope, client, owner, and time claims", async () => {
    const key = await signingKey("owner-key");
    const authorizer = authorizerFor([key.jwk]);
    const token = await sign(key.privateKey, "owner-key");

    const result = await authorizer.authorize(request(`Bearer ${token}`));

    expect(result).toMatchObject({
      ok: true,
      identity: {
        issuer,
        subject: "auth0|owner",
        clientId: "client-id",
        resource,
      },
      authInfo: {
        clientId: "client-id",
        scopes: ["omnicodex:full", "profile"],
        resource: new URL(resource),
      },
    });
  });

  it("fails closed for missing, malformed, wrong, expired, future, and tampered credentials", async () => {
    const key = await signingKey("owner-key");
    const unknown = await signingKey("unknown-key");
    const authorizer = authorizerFor([key.jwk]);
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const cases: Array<{ readonly token?: string; readonly status: 401 | 403 }> = [
      { status: 401 },
      { token: "not-a-jwt", status: 401 },
      {
        token: await sign(key.privateKey, "owner-key", { issuer: "https://wrong.example/" }),
        status: 401,
      },
      {
        token: await sign(key.privateKey, "owner-key", { audience: "https://other.example/mcp" }),
        status: 401,
      },
      { token: await sign(key.privateKey, "owner-key", { scope: "profile" }), status: 403 },
      {
        token: await sign(key.privateKey, "owner-key", { subject: "auth0|other" }),
        status: 403,
      },
      {
        token: await sign(key.privateKey, "owner-key", { expirationTime: nowSeconds - 61 }),
        status: 401,
      },
      {
        token: await sign(key.privateKey, "owner-key", { notBefore: nowSeconds + 61 }),
        status: 401,
      },
      {
        token: await sign(key.privateKey, "owner-key", { issuedAt: nowSeconds + 61 }),
        status: 401,
      },
      {
        token: await sign(key.privateKey, "owner-key", { resource: "https://wrong.example" }),
        status: 403,
      },
      { token: tamper(await sign(key.privateKey, "owner-key")), status: 401 },
      { token: await sign(unknown.privateKey, "unknown-key"), status: 401 },
    ];

    for (const testCase of cases) {
      const authorization = testCase.token === undefined ? undefined : `Bearer ${testCase.token}`;
      await expect(authorizer.authorize(request(authorization))).resolves.toMatchObject({
        ok: false,
        status: testCase.status,
        message: "Unauthorized",
      });
    }
  });

  it("refreshes once for an unknown kid, accepts overlap, and retires the old key at cache expiry", async () => {
    const first = await signingKey("first");
    const second = await signingKey("second");
    const documents: JwksDocument[] = [
      { keys: [first.jwk] },
      { keys: [second.jwk] },
      { keys: [second.jwk] },
      { keys: [second.jwk] },
    ];
    let fetches = 0;
    let nowUnixMs = now.getTime();
    const authorizer = new JwtBearerAuthorizer({
      issuer,
      audience: resource,
      resource,
      requiredScopes: ["omnicodex:full"],
      allowedSubjects: ["auth0|owner"],
      jwksCacheTtlMs: 1_000,
      now: () => new Date(nowUnixMs),
      jwksProvider: async () =>
        documents[Math.min(fetches++, documents.length - 1)] as JwksDocument,
    });

    await expect(
      authorizer.authorize(request(`Bearer ${await sign(first.privateKey, "first")}`)),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      authorizer.authorize(request(`Bearer ${await sign(second.privateKey, "second")}`)),
    ).resolves.toMatchObject({ ok: true });
    expect(fetches).toBe(2);

    await expect(
      authorizer.authorize(request(`Bearer ${await sign(first.privateKey, "first")}`)),
    ).resolves.toMatchObject({ ok: true });

    nowUnixMs += 1_001;
    await expect(
      authorizer.authorize(request(`Bearer ${await sign(first.privateKey, "first")}`)),
    ).resolves.toMatchObject({ ok: false, status: 401 });
    expect(fetches).toBe(4);
  });

  it("uses failure token buckets only for unauthenticated or unauthorized requests", async () => {
    const key = await signingKey("owner-key");
    const authorizer = new JwtBearerAuthorizer({
      issuer,
      audience: resource,
      resource,
      allowedSubjects: ["auth0|owner"],
      keySet: async () => key.publicKey,
      failureLimit: 2,
      failureWindowMs: 60_000,
      now: () => now,
    });
    await authorizer.authorize(request("Bearer bad"));
    await authorizer.authorize(request("Bearer bad"));
    await expect(authorizer.authorize(request("Bearer bad"))).resolves.toMatchObject({
      ok: false,
      status: 429,
    });

    const validToken = await sign(key.privateKey, "owner-key");
    for (let index = 0; index < 25; index += 1) {
      await expect(
        authorizer.authorize(request(`Bearer ${validToken}`, `127.0.0.${index + 2}`)),
      ).resolves.toMatchObject({ ok: true });
    }
  });
});

function authorizerFor(keys: readonly JWK[]): JwtBearerAuthorizer {
  return new JwtBearerAuthorizer({
    issuer,
    audience: resource,
    resource,
    requiredScopes: ["omnicodex:full"],
    allowedSubjects: ["auth0|owner"],
    allowedClientIds: ["client-id"],
    jwksProvider: async () => ({ keys }),
    now: () => now,
  });
}

async function signingKey(kid: string): Promise<{
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  readonly jwk: JWK;
}> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  return {
    privateKey,
    publicKey,
    jwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" },
  };
}

interface SignOverrides {
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string;
  readonly scope?: string;
  readonly resource?: string;
  readonly expirationTime?: number;
  readonly notBefore?: number;
  readonly issuedAt?: number;
}

async function sign(
  privateKey: CryptoKey,
  kid: string,
  overrides: SignOverrides = {},
): Promise<string> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  let token = new SignJWT({
    scope: overrides.scope ?? "omnicodex:full profile",
    resource: overrides.resource ?? resource,
    azp: "client-id",
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? resource)
    .setSubject(overrides.subject ?? "auth0|owner")
    .setIssuedAt(overrides.issuedAt ?? nowSeconds)
    .setExpirationTime(overrides.expirationTime ?? nowSeconds + 300);
  if (overrides.notBefore !== undefined) token = token.setNotBefore(overrides.notBefore);
  return token.sign(privateKey);
}

function tamper(token: string): string {
  const parts = token.split(".");
  const payload = parts[1] as string;
  parts[1] = `${payload[0] === "A" ? "B" : "A"}${payload.slice(1)}`;
  return parts.join(".");
}
