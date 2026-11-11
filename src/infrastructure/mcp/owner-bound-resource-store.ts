import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { BigIntStats, Dirent, ReadStream } from "node:fs";
import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { omniCodexDataDirectory } from "../config/omnicodex-config-store.js";
import type { HttpAuthorizationIdentity } from "./streamable-http-gateway.js";

const RESOURCE_SCHEMA_VERSION = 1;
const MANIFEST_FILE = "manifest.json";
const PAYLOAD_FILE = "payload.bin";
const MAX_MANIFEST_BYTES = 64 * 1024;
const PAYLOAD_LOOKUP_MANIFEST_CONCURRENCY = 32;

export interface ProtectedResourceInput {
  readonly owner: HttpAuthorizationIdentity;
  readonly sessionId: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  /** Optional caller-selected retention. Omit it to retain until explicit deletion. */
  readonly ttlMs?: number;
}

export interface ProtectedResourceFileInput {
  readonly owner: HttpAuthorizationIdentity;
  readonly sessionId: string;
  readonly mimeType: string;
  readonly path: string;
  /** Optional caller-selected retention. Omit it to retain until explicit deletion. */
  readonly ttlMs?: number;
}

export interface ProtectedResourceDescriptor {
  readonly id: string;
  readonly sessionId: string;
  readonly mimeType: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly createdAtUnixMs: number;
  readonly expiresAtUnixMs?: number;
}

export interface ProtectedResourceRecord extends ProtectedResourceDescriptor {
  readonly bytes: Uint8Array;
}

export interface ProtectedResourceSlice extends ProtectedResourceDescriptor {
  readonly bytes: Uint8Array;
  readonly start: number;
  readonly endInclusive: number;
}

/**
 * An already-authorized, integrity-checked stream over one protected result.
 *
 * The file handle is opened before the store's serialization lane is released,
 * so later cleanup cannot redirect this lease to a different payload. Consumers
 * must drain or destroy `stream`; it owns and closes that handle.
 */
export interface ProtectedResourceReadStream extends ProtectedResourceDescriptor {
  readonly stream: ReadStream;
  readonly start: number;
  readonly endInclusive: number;
}

export interface OwnerBoundResourceStoreOptions {
  /** Stable spool root. Defaults to the OmniCodex application data directory. */
  readonly dataDirectory?: string;
  /** Explicit default retention policy. Omit it to disable automatic expiry. */
  readonly defaultTtlMs?: number;
  /** Optional upper bound for caller-selected retention. */
  readonly maximumTtlMs?: number;
  /** Optional admission bound. Existing resources are never evicted to satisfy it. */
  readonly maximumEntries?: number;
  /** Optional admission bound. Existing resources are never evicted to satisfy it. */
  readonly maximumTotalBytes?: number;
  readonly nowUnixMs?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
}

export interface ProtectedResourceStoreUsage {
  readonly entryCount: number;
  readonly totalBytes: number;
}

export interface ProtectedResourceDeduplicationResult {
  readonly entryCount: number;
  readonly duplicatePayloadsLinked: number;
  readonly physicalBytesSaved: number;
}

export interface ProtectedResourceUserDeletionAuthorization {
  /** A server generation, restart, age, or disk-pressure heuristic is never deletion authority. */
  readonly reason: "user_requested";
}

export class ProtectedResourceCapacityError extends Error {
  readonly code = "PROTECTED_RESOURCE_CAPACITY_EXCEEDED";

  constructor(message: string) {
    super(message);
    this.name = "ProtectedResourceCapacityError";
  }
}

interface StoredResourceManifest {
  readonly schemaVersion: typeof RESOURCE_SCHEMA_VERSION;
  readonly id: string;
  readonly ownerBindingDigest: string;
  readonly sessionId: string;
  readonly mimeType: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly createdAtUnixMs: number;
  readonly expiresAtUnixMs?: number;
}

/**
 * Durable, owner-bound spool for remotely delivered results.
 *
 * A resource directory becomes visible only after its payload and manifest have
 * both been written and atomically renamed into place. Transport/session
 * shutdown never deletes it. Automatic expiry and capacity bounds are applied
 * only when the embedding caller explicitly configures them.
 */
export class OwnerBoundResourceStore {
  readonly #dataDirectory: string;
  readonly #defaultTtlMs: number | undefined;
  readonly #maximumTtlMs: number | undefined;
  readonly #maximumEntries: number | undefined;
  readonly #maximumTotalBytes: number | undefined;
  readonly #nowUnixMs: () => number;
  readonly #randomBytes: (size: number) => Buffer;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: OwnerBoundResourceStoreOptions = {}) {
    this.#dataDirectory = resolve(options.dataDirectory ?? defaultResourceDataDirectory());
    this.#defaultTtlMs = optionalPositiveInteger(options.defaultTtlMs, "Default resource TTL");
    this.#maximumTtlMs = optionalPositiveInteger(options.maximumTtlMs, "Maximum resource TTL");
    this.#maximumEntries = optionalPositiveInteger(
      options.maximumEntries,
      "Protected resource entry capacity",
    );
    this.#maximumTotalBytes = optionalPositiveInteger(
      options.maximumTotalBytes,
      "Protected resource byte capacity",
    );
    if (
      this.#defaultTtlMs !== undefined &&
      this.#maximumTtlMs !== undefined &&
      this.#defaultTtlMs > this.#maximumTtlMs
    ) {
      throw new Error("Default protected resource TTL exceeds its configured maximum");
    }
    this.#nowUnixMs = options.nowUnixMs ?? Date.now;
    this.#randomBytes = options.randomBytes ?? randomBytes;
  }

  put(input: ProtectedResourceInput): Promise<ProtectedResourceRecord> {
    return this.#exclusive(async () => {
      const ttlMs = input.ttlMs ?? this.#defaultTtlMs;
      if (ttlMs !== undefined) {
        optionalPositiveInteger(ttlMs, "Protected resource TTL");
        if (this.#maximumTtlMs !== undefined && ttlMs > this.#maximumTtlMs) {
          throw new Error("Protected resource TTL exceeds its configured maximum");
        }
      }
      if (!validSessionId(input.sessionId))
        throw new Error("Protected resource session is invalid");
      if (!validMimeType(input.mimeType))
        throw new Error("Protected resource MIME type is invalid");

      const bytes = Uint8Array.from(input.bytes);
      const usage = await this.#admissionUsage();
      if (this.#maximumEntries !== undefined && usage.entryCount >= this.#maximumEntries) {
        throw new ProtectedResourceCapacityError(
          `Protected resource entry capacity ${String(this.#maximumEntries)} is exhausted`,
        );
      }
      if (
        this.#maximumTotalBytes !== undefined &&
        bytes.byteLength > this.#maximumTotalBytes - usage.totalBytes
      ) {
        throw new ProtectedResourceCapacityError(
          `Protected resource needs ${String(bytes.byteLength)} bytes but only ${String(
            Math.max(0, this.#maximumTotalBytes - usage.totalBytes),
          )} configured bytes remain`,
        );
      }

      await mkdir(this.#dataDirectory, { recursive: true });
      const nowUnixMs = checkedTimestamp(this.#nowUnixMs());
      const digest = createHash("sha256").update(bytes).digest("base64url");
      const duplicatePayload = await this.#verifiedPayloadFor(digest, bytes.byteLength);
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const id = this.#randomBytes(32).toString("base64url");
        if (!validOpaqueResourceId(id)) continue;
        const stagingDirectory = join(
          this.#dataDirectory,
          `.staging-${id}-${this.#randomBytes(8).toString("hex")}`,
        );
        const resourceDirectory = this.#resourceDirectory(id);
        const manifest: StoredResourceManifest = {
          schemaVersion: RESOURCE_SCHEMA_VERSION,
          id,
          ownerBindingDigest: ownerDigest(input.owner),
          sessionId: input.sessionId,
          mimeType: input.mimeType,
          digest,
          byteLength: bytes.byteLength,
          createdAtUnixMs: nowUnixMs,
          ...(ttlMs === undefined ? {} : { expiresAtUnixMs: checkedDeadline(nowUnixMs, ttlMs) }),
        };
        try {
          await mkdir(stagingDirectory);
          const stagingPayload = join(stagingDirectory, PAYLOAD_FILE);
          if (!(await tryLinkPayload(duplicatePayload, stagingPayload))) {
            await writeFile(stagingPayload, bytes, { flag: "wx", mode: 0o600 });
          }
          await writeFile(join(stagingDirectory, MANIFEST_FILE), JSON.stringify(manifest), {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          });
          await rename(stagingDirectory, resourceDirectory);
          return { ...publicDescriptor(manifest), bytes: Uint8Array.from(bytes) };
        } catch (error) {
          await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
          if (await pathExists(resourceDirectory)) continue;
          throw error;
        }
      }
      throw new Error("Unable to allocate a protected resource identifier");
    });
  }

  /**
   * Snapshot one local file into the owner-bound spool without loading the
   * complete payload into the daemon heap. The staging copy is hashed before
   * its manifest is committed, so later source-file changes cannot alter the
   * materialized attachment.
   */
  putFile(input: ProtectedResourceFileInput): Promise<ProtectedResourceDescriptor> {
    return this.#exclusive(async () => {
      const ttlMs = input.ttlMs ?? this.#defaultTtlMs;
      if (ttlMs !== undefined) {
        optionalPositiveInteger(ttlMs, "Protected resource TTL");
        if (this.#maximumTtlMs !== undefined && ttlMs > this.#maximumTtlMs) {
          throw new Error("Protected resource TTL exceeds its configured maximum");
        }
      }
      if (!validSessionId(input.sessionId)) {
        throw new Error("Protected resource session is invalid");
      }
      if (!validMimeType(input.mimeType)) {
        throw new Error("Protected resource MIME type is invalid");
      }
      if (typeof input.path !== "string" || input.path.trim().length === 0) {
        throw new Error("Protected resource file path is invalid");
      }

      await mkdir(this.#dataDirectory, { recursive: true });
      const usage = await this.#admissionUsage();
      const nowUnixMs = checkedTimestamp(this.#nowUnixMs());
      const ownerBindingDigest = ownerDigest(input.owner);
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const id = this.#randomBytes(32).toString("base64url");
        if (!validOpaqueResourceId(id)) continue;
        const stagingDirectory = join(
          this.#dataDirectory,
          `.staging-${id}-${this.#randomBytes(8).toString("hex")}`,
        );
        const resourceDirectory = this.#resourceDirectory(id);
        try {
          await mkdir(stagingDirectory);
          const stagingPayload = join(stagingDirectory, PAYLOAD_FILE);
          await copyFile(input.path, stagingPayload, fsConstants.COPYFILE_EXCL);
          const payloadStat = await stat(stagingPayload);
          if (!payloadStat.isFile()) throw new Error("Protected resource source is not a file");
          const digest = await sha256File(stagingPayload);
          const existing = await this.#matchingFileSnapshot({
            ownerBindingDigest,
            sessionId: input.sessionId,
            mimeType: input.mimeType,
            digest,
            byteLength: payloadStat.size,
            nowUnixMs,
          });
          if (existing !== undefined) {
            await rm(stagingDirectory, { recursive: true, force: true });
            return publicDescriptor(existing);
          }
          if (this.#maximumEntries !== undefined && usage.entryCount >= this.#maximumEntries) {
            throw new ProtectedResourceCapacityError(
              `Protected resource entry capacity ${String(this.#maximumEntries)} is exhausted`,
            );
          }
          if (
            this.#maximumTotalBytes !== undefined &&
            payloadStat.size > this.#maximumTotalBytes - usage.totalBytes
          ) {
            throw new ProtectedResourceCapacityError(
              `Protected resource needs ${String(payloadStat.size)} bytes but only ${String(
                Math.max(0, this.#maximumTotalBytes - usage.totalBytes),
              )} configured bytes remain`,
            );
          }
          const manifest: StoredResourceManifest = {
            schemaVersion: RESOURCE_SCHEMA_VERSION,
            id,
            ownerBindingDigest,
            sessionId: input.sessionId,
            mimeType: input.mimeType,
            digest,
            byteLength: payloadStat.size,
            createdAtUnixMs: nowUnixMs,
            ...(ttlMs === undefined ? {} : { expiresAtUnixMs: checkedDeadline(nowUnixMs, ttlMs) }),
          };
          await writeFile(join(stagingDirectory, MANIFEST_FILE), JSON.stringify(manifest), {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          });
          await rename(stagingDirectory, resourceDirectory);
          return publicDescriptor(manifest);
        } catch (error) {
          await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
          if (await pathExists(resourceDirectory)) continue;
          throw error;
        }
      }
      throw new Error("Unable to allocate a protected resource identifier");
    });
  }

  getMetadata(
    id: string,
    owner: HttpAuthorizationIdentity,
  ): Promise<ProtectedResourceDescriptor | undefined> {
    return this.#exclusive(async () => {
      const manifest = await this.#authorizedManifest(id, owner, true);
      return manifest === undefined ? undefined : publicDescriptor(manifest);
    });
  }

  get(id: string, owner: HttpAuthorizationIdentity): Promise<ProtectedResourceRecord | undefined> {
    return this.#exclusive(async () => {
      const manifest = await this.#authorizedManifest(id, owner, true);
      if (manifest === undefined) return undefined;
      const bytes = await readFile(join(this.#resourceDirectory(id), PAYLOAD_FILE));
      assertPayloadIntegrity(bytes, manifest);
      return { ...publicDescriptor(manifest), bytes: Uint8Array.from(bytes) };
    });
  }

  /**
   * Opens a memory-bounded stream after checking the complete payload against
   * the manifest's length and digest. An optional range changes only the bytes
   * delivered; integrity is still established over the complete stored value.
   */
  openReadStream(
    id: string,
    owner: HttpAuthorizationIdentity,
    range?: { readonly start: number; readonly endInclusive: number },
  ): Promise<ProtectedResourceReadStream | undefined> {
    return this.#exclusive(async () => {
      const manifest = await this.#authorizedManifest(id, owner, true);
      if (manifest === undefined) return undefined;
      const start = range?.start ?? 0;
      const endInclusive = range?.endInclusive ?? manifest.byteLength - 1;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(endInclusive) ||
        start < 0 ||
        (manifest.byteLength === 0
          ? range !== undefined || endInclusive !== -1
          : endInclusive < start || endInclusive >= manifest.byteLength)
      ) {
        throw new RangeError("Protected resource byte range is invalid");
      }

      const handle = await open(join(this.#resourceDirectory(id), PAYLOAD_FILE), "r");
      try {
        await assertFileHandlePayloadIntegrity(handle, manifest);
        const stream = handle.createReadStream({
          autoClose: true,
          start,
          ...(manifest.byteLength === 0 ? {} : { end: endInclusive }),
        });
        return {
          ...publicDescriptor(manifest),
          stream,
          start,
          endInclusive,
        };
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    });
  }

  /** Capture a range from the same bounded pass that verifies the complete snapshot. */
  readRange(
    id: string,
    owner: HttpAuthorizationIdentity,
    start: number,
    endInclusive: number,
  ): Promise<ProtectedResourceSlice | undefined> {
    return this.#exclusive(async () => {
      const manifest = await this.#authorizedManifest(id, owner, true);
      if (manifest === undefined) return undefined;
      const emptyEndRange = start === manifest.byteLength && endInclusive === start - 1;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(endInclusive) ||
        start < 0 ||
        (!emptyEndRange && (endInclusive < start || endInclusive >= manifest.byteLength))
      ) {
        throw new RangeError("Protected resource byte range is invalid");
      }
      const length = endInclusive - start + 1;
      const payloadPath = join(this.#resourceDirectory(id), PAYLOAD_FILE);
      const handle = await open(payloadPath, "r");
      try {
        const metadata = await handle.stat({ bigint: true });
        if (!metadata.isFile() || metadata.size !== BigInt(manifest.byteLength)) {
          throw new Error("Protected resource payload size does not match its manifest");
        }
        const bytes = Buffer.allocUnsafe(length);
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, manifest.byteLength)));
        const digest = createHash("sha256");
        let position = 0;
        while (position < manifest.byteLength) {
          const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(buffer.byteLength, manifest.byteLength - position),
            position,
          );
          if (bytesRead === 0) throw new Error("Protected resource snapshot read was incomplete");
          digest.update(buffer.subarray(0, bytesRead));
          const copyStart = Math.max(start, position);
          const copyEnd = Math.min(endInclusive + 1, position + bytesRead);
          if (copyEnd > copyStart) {
            buffer.copy(bytes, copyStart - start, copyStart - position, copyEnd - position);
          }
          position += bytesRead;
        }
        // Re-reading the range after hashing would allow a different payload
        // to escape. Only the bytes captured by that hash pass can be returned.
        const afterRead = await handle.stat({ bigint: true });
        const currentPath = await stat(payloadPath, { bigint: true });
        if (
          !samePayloadSnapshot(metadata, afterRead) ||
          !samePayloadSnapshot(metadata, currentPath)
        ) {
          throw new Error("Protected resource snapshot changed during verification");
        }
        if (!safeDigestEqual(digest.digest("base64url"), manifest.digest)) {
          throw new Error("Protected resource payload digest does not match its manifest");
        }
        const currentManifest = await this.#authorizedManifest(id, owner, true);
        if (currentManifest === undefined) return undefined;
        if (!sameResourceManifest(manifest, currentManifest)) {
          throw new Error("Protected resource manifest changed during verification");
        }
        return {
          ...publicDescriptor(manifest),
          bytes: Uint8Array.from(bytes),
          start,
          endInclusive,
        };
      } finally {
        await handle.close();
      }
    });
  }

  /**
   * Deletes one result only after the authenticated consumer explicitly
   * acknowledges that it no longer needs the durable handle.
   */
  acknowledgeConsumed(id: string, owner: HttpAuthorizationIdentity): Promise<boolean> {
    return this.#exclusive(async () => {
      const manifest = await this.#authorizedManifest(id, owner, false);
      if (manifest === undefined) return false;
      await rm(this.#resourceDirectory(id), { recursive: true, force: true });
      return true;
    });
  }

  /** Explicit user-requested session deletion. Never call this for restart or generation cleanup. */
  deleteSession(
    sessionId: string,
    _authorization: ProtectedResourceUserDeletionAuthorization,
  ): Promise<void> {
    if (!validSessionId(sessionId)) return Promise.reject(new Error("Resource session is invalid"));
    return this.#exclusive(async () => {
      for (const id of await this.#resourceIds()) {
        const manifest = await this.#manifest(id);
        if (manifest?.sessionId === sessionId) {
          await rm(this.#resourceDirectory(id), { recursive: true, force: true });
        }
      }
    });
  }

  /** Explicit user-requested store deletion. Gateway shutdown deliberately does not call this. */
  clear(_authorization: ProtectedResourceUserDeletionAuthorization): Promise<void> {
    return this.#exclusive(async () => {
      await rm(this.#dataDirectory, { recursive: true, force: true });
    });
  }

  usage(): Promise<ProtectedResourceStoreUsage> {
    return this.#exclusive(() => this.#scanUsage(true));
  }

  /**
   * Replaces duplicate payload files with hard links to one verified canonical
   * payload. Every resource keeps its own owner/session manifest and opaque ID;
   * deleting one link cannot remove another result. No result, expiry, or
   * logical byte is discarded.
   */
  deduplicateExisting(): Promise<ProtectedResourceDeduplicationResult> {
    return this.#exclusive(async () => {
      const nowUnixMs = checkedTimestamp(this.#nowUnixMs());
      const groups = new Map<string, StoredResourceManifest[]>();
      let entryCount = 0;
      for (const id of await this.#resourceIds()) {
        const manifest = await this.#manifest(id);
        if (manifest === undefined) continue;
        if (expired(manifest, nowUnixMs)) {
          await rm(this.#resourceDirectory(id), { recursive: true, force: true });
          continue;
        }
        entryCount += 1;
        const key = `${manifest.digest}:${String(manifest.byteLength)}`;
        const group = groups.get(key);
        if (group === undefined) groups.set(key, [manifest]);
        else group.push(manifest);
      }

      let duplicatePayloadsLinked = 0;
      let physicalBytesSaved = 0;
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const canonical = await this.#firstVerifiedPayload(group);
        if (canonical === undefined) continue;
        for (const manifest of group) {
          const payload = join(this.#resourceDirectory(manifest.id), PAYLOAD_FILE);
          if (payload === canonical || (await samePhysicalFile(canonical, payload))) continue;
          if (!(await replaceWithHardLink(canonical, payload, this.#randomBytes))) continue;
          duplicatePayloadsLinked += 1;
          physicalBytesSaved += manifest.byteLength;
          if (!Number.isSafeInteger(physicalBytesSaved)) {
            throw new Error("Protected resource deduplication exceeds the safe integer range");
          }
        }
      }
      return { entryCount, duplicatePayloadsLinked, physicalBytesSaved };
    });
  }

  async #authorizedManifest(
    id: string,
    owner: HttpAuthorizationIdentity,
    sweepExpired: boolean,
  ): Promise<StoredResourceManifest | undefined> {
    if (!validOpaqueResourceId(id)) return undefined;
    const manifest = await this.#manifest(id);
    if (manifest === undefined) return undefined;
    if (sweepExpired && expired(manifest, checkedTimestamp(this.#nowUnixMs()))) {
      await rm(this.#resourceDirectory(id), { recursive: true, force: true });
      return undefined;
    }
    return safeDigestEqual(manifest.ownerBindingDigest, ownerDigest(owner)) ? manifest : undefined;
  }

  async #manifest(id: string): Promise<StoredResourceManifest | undefined> {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(this.#resourceDirectory(id), MANIFEST_FILE));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_MANIFEST_BYTES) {
      throw new Error("Protected resource manifest is outside its format bound");
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("Protected resource manifest is invalid JSON");
    }
    return parseManifest(value, id);
  }

  async #admissionUsage(): Promise<ProtectedResourceStoreUsage> {
    // Unlimited admission needs no store-wide accounting. Explicit usage and
    // authorized reads still enforce expiry; payload deduplication is unchanged.
    if (this.#maximumEntries === undefined && this.#maximumTotalBytes === undefined) {
      return { entryCount: 0, totalBytes: 0 };
    }
    return this.#scanUsage(true);
  }

  async #scanUsage(sweepExpired: boolean): Promise<ProtectedResourceStoreUsage> {
    let entryCount = 0;
    let totalBytes = 0;
    const nowUnixMs = checkedTimestamp(this.#nowUnixMs());
    for (const id of await this.#resourceIds()) {
      const manifest = await this.#manifest(id);
      if (manifest === undefined) continue;
      if (sweepExpired && expired(manifest, nowUnixMs)) {
        await rm(this.#resourceDirectory(id), { recursive: true, force: true });
        continue;
      }
      entryCount += 1;
      totalBytes += manifest.byteLength;
      if (!Number.isSafeInteger(totalBytes)) {
        throw new Error("Protected resource usage exceeds the safe integer range");
      }
    }
    return { entryCount, totalBytes };
  }

  async #verifiedPayloadFor(digest: string, byteLength: number): Promise<string | undefined> {
    const ids = await this.#resourceIds();
    for (let offset = 0; offset < ids.length; offset += PAYLOAD_LOOKUP_MANIFEST_CONCURRENCY) {
      // Read bounded batches so unrelated disk latency cannot accumulate once
      // per retained result before an error receipt is made available.
      const batch = ids.slice(offset, offset + PAYLOAD_LOOKUP_MANIFEST_CONCURRENCY);
      const manifests = await Promise.allSettled(batch.map((id) => this.#manifest(id)));
      for (const candidate of manifests) {
        // Preserve the original ordered failure and candidate-selection rules.
        if (candidate.status === "rejected") throw candidate.reason;
        const manifest = candidate.value;
        if (
          manifest === undefined ||
          manifest.digest !== digest ||
          manifest.byteLength !== byteLength
        ) {
          continue;
        }
        const payload = join(this.#resourceDirectory(manifest.id), PAYLOAD_FILE);
        const handle = await open(payload, "r").catch(() => undefined);
        if (handle === undefined) continue;
        try {
          await assertFileHandlePayloadIntegrity(handle, manifest);
          return payload;
        } catch {
          // A damaged older resource remains independently detectable on read;
          // it must not prevent a new exact result from being admitted.
        } finally {
          await handle.close().catch(() => undefined);
        }
      }
    }
    return undefined;
  }

  async #matchingFileSnapshot(input: {
    readonly ownerBindingDigest: string;
    readonly sessionId: string;
    readonly mimeType: string;
    readonly digest: string;
    readonly byteLength: number;
    readonly nowUnixMs: number;
  }): Promise<StoredResourceManifest | undefined> {
    for (const id of await this.#resourceIds()) {
      const manifest = await this.#manifest(id);
      if (manifest === undefined) continue;
      if (expired(manifest, input.nowUnixMs)) {
        await rm(this.#resourceDirectory(id), { recursive: true, force: true });
        continue;
      }
      if (
        !safeDigestEqual(manifest.ownerBindingDigest, input.ownerBindingDigest) ||
        manifest.sessionId !== input.sessionId ||
        manifest.mimeType !== input.mimeType ||
        manifest.digest !== input.digest ||
        manifest.byteLength !== input.byteLength
      ) {
        continue;
      }
      const payload = join(this.#resourceDirectory(id), PAYLOAD_FILE);
      const handle = await open(payload, "r").catch(() => undefined);
      if (handle === undefined) continue;
      try {
        await assertFileHandlePayloadIntegrity(handle, manifest);
        return manifest;
      } catch {
        // Do not reuse a damaged prior snapshot; the staged copy remains the
        // authoritative candidate for this invocation.
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
    return undefined;
  }

  async #firstVerifiedPayload(
    manifests: readonly StoredResourceManifest[],
  ): Promise<string | undefined> {
    for (const manifest of manifests) {
      const payload = join(this.#resourceDirectory(manifest.id), PAYLOAD_FILE);
      const handle = await open(payload, "r").catch(() => undefined);
      if (handle === undefined) continue;
      try {
        await assertFileHandlePayloadIntegrity(handle, manifest);
        return payload;
      } catch {
        // Try another copy bearing the same manifest digest.
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
    return undefined;
  }

  async #resourceIds(): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.#dataDirectory, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory() && validOpaqueResourceId(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, "en"));
  }

  #resourceDirectory(id: string): string {
    return join(this.#dataDirectory, id);
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function authorizationBinding(identity: HttpAuthorizationIdentity): string {
  return [identity.issuer, identity.subject, identity.clientId, identity.resource].join("\0");
}

/** Stable authenticated principal for durable user-owned state across OAuth client rotation. */
export function durablePrincipalBinding(identity: HttpAuthorizationIdentity): string {
  return [identity.issuer, identity.subject, "omnicodex-principal-v1", identity.resource].join(
    "\0",
  );
}

export function validOpaqueResourceId(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function defaultResourceDataDirectory(): string {
  try {
    return join(omniCodexDataDirectory(), "protected-results");
  } catch {
    return join(homedir(), ".omnicodex", "protected-results");
  }
}

function ownerDigest(identity: HttpAuthorizationIdentity): string {
  return createHash("sha256").update(durablePrincipalBinding(identity), "utf8").digest("hex");
}

function publicDescriptor(resource: StoredResourceManifest): ProtectedResourceDescriptor {
  return {
    id: resource.id,
    sessionId: resource.sessionId,
    mimeType: resource.mimeType,
    digest: resource.digest,
    byteLength: resource.byteLength,
    createdAtUnixMs: resource.createdAtUnixMs,
    ...(resource.expiresAtUnixMs === undefined
      ? {}
      : { expiresAtUnixMs: resource.expiresAtUnixMs }),
  };
}

function parseManifest(value: unknown, expectedId: string): StoredResourceManifest {
  if (!isRecord(value)) throw new Error("Protected resource manifest is invalid");
  const expiresAtUnixMs = value.expiresAtUnixMs;
  if (
    value.schemaVersion !== RESOURCE_SCHEMA_VERSION ||
    value.id !== expectedId ||
    typeof value.ownerBindingDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.ownerBindingDigest) ||
    typeof value.sessionId !== "string" ||
    !validSessionId(value.sessionId) ||
    typeof value.mimeType !== "string" ||
    !validMimeType(value.mimeType) ||
    typeof value.digest !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.digest) ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) < 0 ||
    !Number.isSafeInteger(value.createdAtUnixMs) ||
    (value.createdAtUnixMs as number) < 0 ||
    (expiresAtUnixMs !== undefined &&
      (!Number.isSafeInteger(expiresAtUnixMs) ||
        (expiresAtUnixMs as number) <= (value.createdAtUnixMs as number)))
  ) {
    throw new Error("Protected resource manifest is invalid");
  }
  return value as unknown as StoredResourceManifest;
}

function assertPayloadIntegrity(bytes: Uint8Array, manifest: StoredResourceManifest): void {
  if (bytes.byteLength !== manifest.byteLength) {
    throw new Error("Protected resource payload size does not match its manifest");
  }
  const digest = createHash("sha256").update(bytes).digest("base64url");
  if (!safeDigestEqual(digest, manifest.digest)) {
    throw new Error("Protected resource payload digest does not match its manifest");
  }
}

async function sha256File(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("Protected resource source is not a file");
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, metadata.size)));
    let position = 0;
    while (position < metadata.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, metadata.size - position),
        position,
      );
      if (bytesRead === 0) throw new Error("Protected resource file snapshot was incomplete");
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return digest.digest("base64url");
  } finally {
    await handle.close();
  }
}

async function assertFileHandlePayloadIntegrity(
  handle: Awaited<ReturnType<typeof open>>,
  manifest: StoredResourceManifest,
): Promise<void> {
  const metadata = await handle.stat();
  if (!metadata.isFile() || metadata.size !== manifest.byteLength) {
    throw new Error("Protected resource payload size does not match its manifest");
  }
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, manifest.byteLength)));
  let position = 0;
  while (position < manifest.byteLength) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.byteLength, manifest.byteLength - position),
      position,
    );
    if (bytesRead === 0) {
      throw new Error("Protected resource payload read was incomplete");
    }
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (!safeDigestEqual(digest.digest("base64url"), manifest.digest)) {
    throw new Error("Protected resource payload digest does not match its manifest");
  }
}

function expired(manifest: StoredResourceManifest, nowUnixMs: number): boolean {
  return manifest.expiresAtUnixMs !== undefined && manifest.expiresAtUnixMs <= nowUnixMs;
}

function safeDigestEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function samePayloadSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameResourceManifest(
  left: StoredResourceManifest,
  right: StoredResourceManifest,
): boolean {
  return (
    left.id === right.id &&
    left.ownerBindingDigest === right.ownerBindingDigest &&
    left.sessionId === right.sessionId &&
    left.digest === right.digest &&
    left.byteLength === right.byteLength &&
    left.mimeType === right.mimeType &&
    left.createdAtUnixMs === right.createdAtUnixMs &&
    left.expiresAtUnixMs === right.expiresAtUnixMs
  );
}

function optionalPositiveInteger(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function checkedTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Protected resource clock returned an invalid timestamp");
  }
  return value;
}

function checkedDeadline(nowUnixMs: number, ttlMs: number): number {
  const deadline = nowUnixMs + ttlMs;
  if (!Number.isSafeInteger(deadline)) throw new Error("Protected resource expiry is out of range");
  return deadline;
}

function validSessionId(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function validMimeType(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !/[\r\n\0]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function tryLinkPayload(source: string | undefined, destination: string): Promise<boolean> {
  if (source === undefined) return false;
  try {
    await link(source, destination);
    return true;
  } catch (error) {
    if (isHardLinkUnavailable(error)) return false;
    throw error;
  }
}

async function samePhysicalFile(left: string, right: string): Promise<boolean> {
  try {
    const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)]);
    return leftStat.dev === rightStat.dev && leftStat.ino !== 0 && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

async function replaceWithHardLink(
  canonical: string,
  payload: string,
  nonce: (size: number) => Buffer,
): Promise<boolean> {
  const temporary = `${payload}.link-${nonce(8).toString("hex")}`;
  const backup = `${payload}.replace-${nonce(8).toString("hex")}`;
  try {
    await link(canonical, temporary);
    await rename(payload, backup);
    try {
      await rename(temporary, payload);
    } catch (error) {
      await rename(backup, payload).catch(() => undefined);
      throw error;
    }
    await rm(backup, { force: true });
    return true;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (isHardLinkUnavailable(error) || isTransientReplaceError(error)) return false;
    throw error;
  }
}

function isHardLinkUnavailable(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === "EACCES" ||
    code === "EPERM" ||
    code === "EXDEV" ||
    code === "ENOSYS" ||
    code === "ENOTSUP"
  );
}

function isTransientReplaceError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EBUSY" || code === "ENOTEMPTY" || code === "ENOENT";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string"
    ? (error as { readonly code: string }).code
    : undefined;
}
