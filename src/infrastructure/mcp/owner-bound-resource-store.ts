import { createHash, randomBytes } from "node:crypto";
import type { HttpAuthorizationIdentity } from "./streamable-http-gateway.js";

export interface ProtectedResourceInput {
  readonly owner: HttpAuthorizationIdentity;
  readonly sessionId: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly ttlMs?: number;
}

export interface ProtectedResourceRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly expiresAtUnixMs: number;
}

export interface OwnerBoundResourceStoreOptions {
  readonly defaultTtlMs?: number;
  readonly maximumTtlMs?: number;
  readonly nowUnixMs?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
}

interface StoredResource extends ProtectedResourceRecord {
  readonly ownerBinding: string;
}

/** In-memory lifecycle and authorization boundary for remotely delivered results. */
export class OwnerBoundResourceStore {
  readonly #defaultTtlMs: number;
  readonly #maximumTtlMs: number;
  readonly #nowUnixMs: () => number;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #resources = new Map<string, StoredResource>();

  constructor(options: OwnerBoundResourceStoreOptions = {}) {
    this.#maximumTtlMs = options.maximumTtlMs ?? 10 * 60_000;
    this.#defaultTtlMs = options.defaultTtlMs ?? this.#maximumTtlMs;
    if (
      !Number.isSafeInteger(this.#maximumTtlMs) ||
      this.#maximumTtlMs <= 0 ||
      !Number.isSafeInteger(this.#defaultTtlMs) ||
      this.#defaultTtlMs <= 0 ||
      this.#defaultTtlMs > this.#maximumTtlMs
    ) {
      throw new Error("Protected resource TTL must be positive and at most ten minutes");
    }
    this.#nowUnixMs = options.nowUnixMs ?? Date.now;
    this.#randomBytes = options.randomBytes ?? randomBytes;
  }

  put(input: ProtectedResourceInput): ProtectedResourceRecord {
    const ttlMs = input.ttlMs ?? this.#defaultTtlMs;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > this.#maximumTtlMs) {
      throw new Error("Protected resource TTL exceeds the configured short lifetime");
    }
    if (!validSessionId(input.sessionId)) throw new Error("Protected resource session is invalid");
    if (!validMimeType(input.mimeType)) throw new Error("Protected resource MIME type is invalid");
    const bytes = Uint8Array.from(input.bytes);
    const id = this.#uniqueId();
    const stored: StoredResource = {
      id,
      ownerBinding: authorizationBinding(input.owner),
      sessionId: input.sessionId,
      mimeType: input.mimeType,
      bytes,
      digest: createHash("sha256").update(bytes).digest("base64url"),
      expiresAtUnixMs: this.#nowUnixMs() + ttlMs,
    };
    this.#resources.set(id, stored);
    return publicRecord(stored);
  }

  get(
    id: string,
    owner: HttpAuthorizationIdentity,
    sessionId: string,
  ): ProtectedResourceRecord | undefined {
    if (!validOpaqueResourceId(id) || !validSessionId(sessionId)) return undefined;
    const stored = this.#resources.get(id);
    if (stored === undefined) return undefined;
    if (stored.expiresAtUnixMs <= this.#nowUnixMs()) {
      this.#resources.delete(id);
      return undefined;
    }
    if (stored.ownerBinding !== authorizationBinding(owner) || stored.sessionId !== sessionId) {
      return undefined;
    }
    return publicRecord(stored);
  }

  deleteSession(sessionId: string): void {
    for (const [id, resource] of this.#resources) {
      if (resource.sessionId === sessionId) this.#resources.delete(id);
    }
  }

  clear(): void {
    this.#resources.clear();
  }

  #uniqueId(): string {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const id = this.#randomBytes(32).toString("base64url");
      if (validOpaqueResourceId(id) && !this.#resources.has(id)) return id;
    }
    throw new Error("Unable to allocate a protected resource identifier");
  }
}

export function authorizationBinding(identity: HttpAuthorizationIdentity): string {
  return [identity.issuer, identity.subject, identity.clientId, identity.resource].join("\0");
}

export function validOpaqueResourceId(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function publicRecord(resource: StoredResource): ProtectedResourceRecord {
  return {
    id: resource.id,
    sessionId: resource.sessionId,
    mimeType: resource.mimeType,
    bytes: Uint8Array.from(resource.bytes),
    digest: resource.digest,
    expiresAtUnixMs: resource.expiresAtUnixMs,
  };
}

function validSessionId(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function validMimeType(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !/[\r\n\0]/.test(value);
}
