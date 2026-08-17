import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  errors,
  type FlattenedJWSInput,
  type JWK,
  type JWSHeaderParameters,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";
import type {
  HttpAuthorizationDecision,
  HttpAuthorizationIdentity,
} from "../mcp/streamable-http-gateway.js";

export interface JwksDocument {
  readonly keys: readonly JWK[];
}

export type JwksDocumentProvider = () => Promise<JwksDocument>;

export interface JwtBearerAuthorizerOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly resource?: string;
  readonly requiredScopes?: readonly string[];
  readonly allowedSubjects: readonly string[];
  readonly allowedClientIds?: readonly string[];
  readonly jwksUri?: string;
  readonly keySet?: JWTVerifyGetKey;
  readonly jwksProvider?: JwksDocumentProvider;
  readonly fetch?: typeof fetch;
  readonly jwksCacheTtlMs?: number;
  readonly clockToleranceSeconds?: number;
  readonly now?: () => Date;
  /** @deprecated Prefer authenticationFailureBurst. */
  readonly failureLimit?: number;
  /** @deprecated Prefer authenticationFailureRefillPerMinute. */
  readonly failureWindowMs?: number;
  readonly authenticationFailureBurst?: number;
  readonly authenticationFailureRefillPerMinute?: number;
  readonly ownerFailureBurst?: number;
  readonly ownerFailureRefillPerMinute?: number;
}

interface TokenBucket {
  tokens: number;
  refilledAtUnixMs: number;
}

/** Fail-closed Auth0/OIDC bearer-token verifier for the MCP boundary. */
export class JwtBearerAuthorizer {
  readonly #options: JwtBearerAuthorizerOptions;
  readonly #keySet: JWTVerifyGetKey;
  readonly #issuer: string;
  readonly #audience: string;
  readonly #resource: string | undefined;
  readonly #ownerIdentities: ReadonlySet<string>;
  readonly #authenticationFailures = new Map<string, TokenBucket>();
  readonly #ownerFailures = new Map<string, TokenBucket>();

  constructor(options: JwtBearerAuthorizerOptions) {
    if (options.allowedSubjects.length === 0) {
      throw new Error("JwtBearerAuthorizer requires at least one allowed subject");
    }
    this.#issuer = exactIssuer(options.issuer);
    this.#audience = exactHttpsResource(options.audience, "JWT audience");
    this.#resource =
      options.resource === undefined
        ? undefined
        : exactHttpsResource(options.resource, "OAuth resource");
    if (this.#resource !== undefined && this.#audience !== this.#resource) {
      throw new Error("The Auth0 audience and OAuth resource must have a one-to-one exact binding");
    }
    const clockToleranceSeconds = options.clockToleranceSeconds ?? 60;
    if (
      !Number.isFinite(clockToleranceSeconds) ||
      clockToleranceSeconds < 0 ||
      clockToleranceSeconds > 60
    ) {
      throw new Error("JWT clock tolerance must be between 0 and 60 seconds");
    }
    this.#options = options;
    this.#ownerIdentities = new Set(
      options.allowedSubjects.map((subject) =>
        ownerIdentity(this.#issuer, requiredSubject(subject)),
      ),
    );
    this.#keySet = options.keySet ?? this.#createCachedKeySet(options);
  }

  async authorize(request: IncomingMessage): Promise<HttpAuthorizationDecision> {
    const address = request.socket.remoteAddress ?? "unknown";
    if (this.#isLimited(this.#authenticationFailures, address, this.#authenticationRate())) {
      return rateLimited();
    }

    const authorization = request.headers.authorization;
    if (typeof authorization !== "string") {
      return this.#authenticationFailed(address);
    }
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization);
    const token = match?.[1];
    if (token === undefined) {
      return this.#authenticationFailed(address);
    }

    let verified: { readonly payload: JWTPayload };
    try {
      const header = decodeProtectedHeader(token);
      if (
        header.alg !== "RS256" ||
        typeof header.kid !== "string" ||
        header.kid.length === 0 ||
        (header.crit !== undefined && header.crit.length > 0)
      ) {
        return this.#authenticationFailed(address);
      }
      verified = await jwtVerify(token, this.#keySet, {
        algorithms: ["RS256"],
        issuer: this.#issuer,
        audience: this.#audience,
        requiredClaims: ["sub", "exp"],
        clockTolerance: this.#options.clockToleranceSeconds ?? 60,
        ...(this.#options.now === undefined ? {} : { currentDate: this.#options.now() }),
      });
    } catch {
      return this.#authenticationFailed(address);
    }

    const subject = verified.payload.sub;
    if (typeof subject !== "string" || subject.length === 0) {
      return this.#authenticationFailed(address);
    }
    if (!validIssuedAt(verified.payload.iat, this.#options.now?.() ?? new Date(), this.#options)) {
      return this.#authenticationFailed(address);
    }

    const scopes = extractScopes(verified.payload.scope);
    const clientId = clientIdentifier(verified.payload.azp, verified.payload.client_id, subject);
    if (clientId === undefined) {
      return this.#authenticationFailed(address);
    }
    if (
      this.#options.allowedClientIds !== undefined &&
      !this.#options.allowedClientIds.includes(clientId)
    ) {
      return this.#authorizationFailed(address);
    }
    for (const required of this.#options.requiredScopes ?? []) {
      if (!scopes.includes(required)) {
        return this.#authorizationFailed(address);
      }
    }
    if (this.#resource !== undefined && verified.payload.resource !== this.#resource) {
      return this.#authorizationFailed(address);
    }

    const identity: HttpAuthorizationIdentity = {
      issuer: this.#issuer,
      subject,
      clientId,
      resource: this.#resource ?? this.#audience,
    };
    if (!this.#ownerIdentities.has(ownerIdentity(identity.issuer, identity.subject))) {
      const digest = createHash("sha256")
        .update(ownerIdentity(identity.issuer, identity.subject), "utf8")
        .digest("base64url");
      const rate = this.#ownerRate();
      if (this.#isLimited(this.#ownerFailures, digest, rate)) return rateLimited();
      this.#consume(this.#ownerFailures, digest, rate);
      return this.#authorizationFailed(address);
    }

    const authInfo: AuthInfo = {
      token,
      clientId,
      scopes,
      expiresAt: verified.payload.exp as number,
      resource: new URL(identity.resource),
      extra: { issuer: identity.issuer, subject: identity.subject },
    };
    return { ok: true, authInfo, identity };
  }

  #createCachedKeySet(options: JwtBearerAuthorizerOptions): JWTVerifyGetKey {
    const provider =
      options.jwksProvider ??
      remoteJwksProvider(
        exactJwksUrl(options.jwksUri ?? new URL(".well-known/jwks.json", this.#issuer).href),
        options.fetch ?? fetch,
      );
    const cache = new RotatingJwksCache(
      provider,
      options.jwksCacheTtlMs ?? 10 * 60_000,
      () => this.#options.now?.().getTime() ?? Date.now(),
    );
    return (header, token) => cache.resolve(header, token);
  }

  #authenticationFailed(address: string): HttpAuthorizationDecision {
    this.#consume(this.#authenticationFailures, address, this.#authenticationRate());
    return unauthorized(401);
  }

  #authorizationFailed(address: string): HttpAuthorizationDecision {
    this.#consume(this.#authenticationFailures, address, this.#authenticationRate());
    return unauthorized(403);
  }

  #authenticationRate(): BucketRate {
    const burst = this.#options.authenticationFailureBurst ?? this.#options.failureLimit ?? 20;
    const refillPerMinute =
      this.#options.authenticationFailureRefillPerMinute ??
      (this.#options.failureWindowMs === undefined
        ? 10
        : burst / (this.#options.failureWindowMs / 60_000));
    return { burst, refillPerMinute };
  }

  #ownerRate(): BucketRate {
    return {
      burst: this.#options.ownerFailureBurst ?? 10,
      refillPerMinute: this.#options.ownerFailureRefillPerMinute ?? 5,
    };
  }

  #isLimited(buckets: Map<string, TokenBucket>, key: string, rate: BucketRate): boolean {
    return this.#bucket(buckets, key, rate).tokens < 1;
  }

  #consume(buckets: Map<string, TokenBucket>, key: string, rate: BucketRate): void {
    const bucket = this.#bucket(buckets, key, rate);
    bucket.tokens = Math.max(0, bucket.tokens - 1);
  }

  #bucket(buckets: Map<string, TokenBucket>, key: string, rate: BucketRate): TokenBucket {
    const nowUnixMs = this.#options.now?.().getTime() ?? Date.now();
    const existing = buckets.get(key);
    if (existing === undefined) {
      const created = { tokens: rate.burst, refilledAtUnixMs: nowUnixMs };
      buckets.set(key, created);
      return created;
    }
    const elapsedMinutes = Math.max(0, nowUnixMs - existing.refilledAtUnixMs) / 60_000;
    existing.tokens = Math.min(rate.burst, existing.tokens + elapsedMinutes * rate.refillPerMinute);
    existing.refilledAtUnixMs = nowUnixMs;
    return existing;
  }
}

interface BucketRate {
  readonly burst: number;
  readonly refillPerMinute: number;
}

interface CachedKeySet {
  readonly resolve: ReturnType<typeof createLocalJWKSet>;
  readonly expiresAtUnixMs: number;
}

class RotatingJwksCache {
  readonly #provider: JwksDocumentProvider;
  readonly #ttlMs: number;
  readonly #nowUnixMs: () => number;
  #current: CachedKeySet | undefined;
  #overlap: CachedKeySet | undefined;
  #refresh: Promise<CachedKeySet> | undefined;

  constructor(provider: JwksDocumentProvider, ttlMs: number, nowUnixMs: () => number) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("JWKS cache TTL must be positive");
    this.#provider = provider;
    this.#ttlMs = ttlMs;
    this.#nowUnixMs = nowUnixMs;
  }

  async resolve(header?: JWSHeaderParameters, token?: FlattenedJWSInput): Promise<CryptoKey> {
    const now = this.#nowUnixMs();
    if (this.#current === undefined || this.#current.expiresAtUnixMs <= now) {
      await this.#refreshKeys(false);
    }
    try {
      return await this.#resolveKnown(header, token);
    } catch (error) {
      if (!(error instanceof errors.JWKSNoMatchingKey)) throw error;
      await this.#refreshKeys(true);
      return this.#resolveKnown(header, token);
    }
  }

  async #resolveKnown(header?: JWSHeaderParameters, token?: FlattenedJWSInput): Promise<CryptoKey> {
    const current = this.#current;
    if (current === undefined) throw new errors.JWKSNoMatchingKey();
    try {
      return await current.resolve(header, token);
    } catch (error) {
      const overlap = this.#overlap;
      if (
        !(error instanceof errors.JWKSNoMatchingKey) ||
        overlap === undefined ||
        overlap.expiresAtUnixMs <= this.#nowUnixMs()
      ) {
        throw error;
      }
      return overlap.resolve(header, token);
    }
  }

  async #refreshKeys(preserveCurrent: boolean): Promise<CachedKeySet> {
    if (this.#refresh !== undefined) return this.#refresh;
    this.#refresh = (async () => {
      const document = validateJwksDocument(await this.#provider());
      const next = {
        resolve: createLocalJWKSet({ keys: [...document.keys] }),
        expiresAtUnixMs: this.#nowUnixMs() + this.#ttlMs,
      };
      const current = this.#current;
      this.#overlap =
        preserveCurrent && current !== undefined && current.expiresAtUnixMs > this.#nowUnixMs()
          ? current
          : undefined;
      this.#current = next;
      return next;
    })();
    try {
      return await this.#refresh;
    } finally {
      this.#refresh = undefined;
    }
  }
}

function validateJwksDocument(document: JwksDocument): JwksDocument {
  if (!Array.isArray(document.keys) || document.keys.length === 0) {
    throw new Error("Auth0 JWKS did not contain signing keys");
  }
  const kids = new Set<string>();
  for (const key of document.keys) {
    if (
      key.kty !== "RSA" ||
      typeof key.kid !== "string" ||
      key.kid.length === 0 ||
      (key.alg !== undefined && key.alg !== "RS256") ||
      key.use === "enc" ||
      key.d !== undefined ||
      kids.has(key.kid)
    ) {
      throw new Error("Auth0 JWKS contained an invalid or duplicate RS256 signing key");
    }
    kids.add(key.kid);
  }
  return document;
}

function remoteJwksProvider(jwksUrl: URL, fetchImplementation: typeof fetch): JwksDocumentProvider {
  return async () => {
    const response = await fetchImplementation(jwksUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || response.status >= 300) {
      throw new Error(`Auth0 JWKS request failed (${response.status})`);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== undefined && contentType !== "application/json") {
      throw new Error("Auth0 JWKS response was not JSON");
    }
    const body = await readBoundedResponse(response, 1_048_576);
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      throw new Error("Auth0 JWKS response was invalid JSON");
    }
    if (!isObject(value) || !Array.isArray(value.keys)) {
      throw new Error("Auth0 JWKS response had an invalid shape");
    }
    return { keys: value.keys as JWK[] };
  };
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    byteLength += next.value.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Auth0 JWKS response was too large");
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks, byteLength).toString("utf8");
}

function extractScopes(scope: unknown): string[] {
  if (typeof scope !== "string") return [];
  return [...new Set(scope.split(" ").filter((item) => item.length > 0))];
}

function clientIdentifier(
  azp: unknown,
  clientIdClaim: unknown,
  fallback: string,
): string | undefined {
  if (azp !== undefined && (typeof azp !== "string" || !validClientId(azp))) return undefined;
  if (
    clientIdClaim !== undefined &&
    (typeof clientIdClaim !== "string" || !validClientId(clientIdClaim))
  ) {
    return undefined;
  }
  if (typeof azp === "string" && typeof clientIdClaim === "string" && azp !== clientIdClaim) {
    return undefined;
  }
  return typeof azp === "string"
    ? azp
    : typeof clientIdClaim === "string"
      ? clientIdClaim
      : fallback;
}

function validClientId(value: string): boolean {
  if (value.length < 1 || value.length > 512) return false;
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0) as number;
    return codePoint > 0x1f && codePoint !== 0x7f && !/\s/u.test(character);
  });
}

function validIssuedAt(iat: unknown, now: Date, options: JwtBearerAuthorizerOptions): boolean {
  if (iat === undefined) return true;
  if (typeof iat !== "number" || !Number.isFinite(iat)) return false;
  return iat <= Math.floor(now.getTime() / 1000) + (options.clockToleranceSeconds ?? 60);
}

function ownerIdentity(issuer: string, subject: string): string {
  return `${issuer}\0${subject}`;
}

function requiredSubject(subject: string): string {
  if (subject.length === 0 || subject.includes("\0")) throw new Error("Invalid owner subject");
  return subject;
}

function exactIssuer(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    !value.endsWith("/")
  ) {
    throw new Error("Auth0 issuer must be an exact credential-free HTTPS URL ending in slash");
  }
  return value;
}

function exactHttpsResource(value: string, label: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(`${label} must be a credential-free HTTPS URL`);
  }
  return value;
}

function exactJwksUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("Auth0 JWKS URI must be a credential-free HTTPS URL");
  }
  return url;
}

function unauthorized(status: 401 | 403): HttpAuthorizationDecision {
  return {
    ok: false,
    status,
    headers: { "WWW-Authenticate": 'Bearer realm="OmniCodex"' },
    message: "Unauthorized",
  };
}

function rateLimited(): HttpAuthorizationDecision {
  return {
    ok: false,
    status: 429,
    headers: { "Retry-After": "6" },
    message: "Unauthorized",
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
