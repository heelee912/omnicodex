import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { omniCodexDataDirectory } from "../config/omnicodex-config-store.js";
import { canonicalJson } from "../safety/canonical-json.js";

const SCHEMA_VERSION = 1;
export const WORK_SESSION_RELATED_TASK_META_KEY = "io.modelcontextprotocol/related-task";
export const WORK_SESSION_CONTINUATION_META_KEY = "omnicodex/continuation-token";
/**
 * ChatGPT's documented, anonymized conversation identity. This value is a
 * correlation key only; OAuth remains the authorization boundary and the raw
 * value is never persisted.
 */
export const WORK_SESSION_OPENAI_SESSION_META_KEY = "openai/session";
// Compaction is lossless maintenance, not a retention boundary. Work-session
// identity, bindings, and tombstones otherwise remain durable unless an
// operator explicitly supplies a retention policy.
const DEFAULT_JOURNAL_COMPACTION_ENTRIES = 256;

export type WorkSessionBindingSource =
  | "openai_session"
  | "related_task"
  | "continuation_token"
  | "transport_session"
  | "issued";

export interface DurableWorkSessionBindInput {
  /** Stable authenticated owner boundary, normally authorizationBinding(identity). */
  readonly authorizationBinding: string;
  /** Current MCP transport correlation. It is HMAC-bound and is never persisted raw. */
  readonly transportSessionId: string;
  /** The request params `_meta` object, not the complete JSON-RPC envelope. */
  readonly requestMeta?: Readonly<Record<string, unknown>>;
  /** Explicit equivalent of `_meta["omnicodex/continuation-token"]`. */
  readonly continuationToken?: string;
}

export interface DurableWorkSessionBinding {
  /** Stable owner-and-conversation-scoped identity for schedulers, Direct Goal, and direct jobs. */
  readonly workSessionBinding: string;
  /** Use this exact value for both DirectGoal.claimantBinding and direct-job owner binding. */
  readonly directGoalClaimantBinding: string;
  readonly directJobOwnerBinding: string;
  /** Opaque server-issued fallback when related-task metadata is unavailable. */
  readonly continuationToken: string;
  readonly source: WorkSessionBindingSource;
  readonly created: boolean;
  readonly journalCursor: string;
  readonly expiresAtUnixMs?: number;
}

export interface DurableWorkSessionResumeInput {
  readonly authorizationBinding: string;
  readonly workSessionBinding: string;
  readonly afterJournalCursor?: string;
}

export interface DurableWorkSessionResumePoint {
  readonly workSessionBinding: string;
  readonly directGoalClaimantBinding: string;
  readonly directJobOwnerBinding: string;
  readonly continuationToken: string;
  readonly journalCursor: string;
  readonly changedSinceCursor: boolean;
  readonly cursorWasCompacted: boolean;
  readonly expiresAtUnixMs?: number;
}

export interface DurableWorkSessionStoreOptions {
  readonly dataDirectory?: string;
  readonly snapshotPath?: string;
  readonly journalPath?: string;
  readonly hmacKeyPath?: string;
  /** Test/integration override. Production should use the durable key file. */
  readonly hmacKey?: Uint8Array;
  /** Optional retention policies. Omitted values never expire or prune durable identity state. */
  readonly sessionTtlMs?: number;
  readonly tombstoneTtlMs?: number;
  readonly maxSessions?: number;
  readonly maxTombstones?: number;
  readonly maxTransportBindings?: number;
  /** Lossless snapshot-compaction threshold; this is not a journal-history retention limit. */
  readonly maxJournalEntries?: number;
  /** Optional persistence policy. Omission defers only to the filesystem/runtime capacity. */
  readonly maxPersistenceBytes?: number;
  readonly nowUnixMs?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
}

export class WorkSessionConflictError extends Error {
  readonly code = "WORK_SESSION_BINDING_CONFLICT";

  constructor() {
    super(
      "The MCP transport, related task, and continuation token do not identify one work session",
    );
    this.name = "WorkSessionConflictError";
  }
}

export class WorkSessionAuthorizationError extends Error {
  readonly code = "WORK_SESSION_OWNER_MISMATCH";

  constructor() {
    super("The work-session identity belongs to a different authenticated owner");
    this.name = "WorkSessionAuthorizationError";
  }
}

export class WorkSessionExpiredError extends Error {
  readonly code = "WORK_SESSION_EXPIRED";

  constructor() {
    super("The work-session continuation has expired");
    this.name = "WorkSessionExpiredError";
  }
}

export class WorkSessionNotFoundError extends Error {
  readonly code = "WORK_SESSION_NOT_FOUND";

  constructor() {
    super("The work-session continuation is not known");
    this.name = "WorkSessionNotFoundError";
  }
}

export class WorkSessionCapacityError extends Error {
  readonly code = "WORK_SESSION_CAPACITY_EXHAUSTED";

  constructor() {
    super("The durable work-session capacity is exhausted");
    this.name = "WorkSessionCapacityError";
  }
}

export class WorkSessionPersistenceError extends Error {
  readonly code = "WORK_SESSION_PERSISTENCE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "WorkSessionPersistenceError";
  }
}

interface StoredTransportBinding {
  readonly digest: string;
  readonly boundAtUnixMs: number;
}

interface StoredWorkSession {
  readonly internalId: string;
  readonly ownerDigest: string;
  readonly relatedTaskDigest?: string;
  readonly tokenDigest: string;
  readonly workSessionBinding: string;
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
  readonly expiresAtUnixMs?: number;
  readonly transportBindings: readonly StoredTransportBinding[];
}

interface StoredTombstone {
  readonly tokenDigest: string;
  readonly ownerDigest: string;
  readonly expiredAtUnixMs: number;
  readonly retainUntilUnixMs?: number;
}

interface SnapshotPayload {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly revision: number;
  readonly sessions: readonly StoredWorkSession[];
  readonly tombstones: readonly StoredTombstone[];
}

interface StoredSnapshot extends SnapshotPayload {
  readonly checksum: string;
}

interface JournalPayload {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly previousRevision: number;
  readonly revision: number;
  readonly sessionUpserts: readonly StoredWorkSession[];
  readonly sessionDeletes: readonly string[];
  readonly tombstoneUpserts: readonly StoredTombstone[];
  readonly tombstoneDeletes: readonly string[];
}

interface StoredJournalEntry extends JournalPayload {
  readonly checksum: string;
}

interface LoadedState {
  readonly revision: number;
  readonly compactedRevision: number;
  readonly journalEntries: number;
  readonly sessions: Map<string, StoredWorkSession>;
  readonly tombstones: Map<string, StoredTombstone>;
}

interface StoreConfiguration {
  readonly snapshotPath: string;
  readonly journalPath: string;
  readonly hmacKeyPath: string;
  readonly suppliedHmacKey?: Buffer;
  readonly sessionTtlMs: number | undefined;
  readonly tombstoneTtlMs: number | undefined;
  readonly maxSessions: number | undefined;
  readonly maxTombstones: number | undefined;
  readonly maxTransportBindings: number | undefined;
  readonly journalCompactionEntries: number;
  readonly maxPersistenceBytes: number | undefined;
  readonly nowUnixMs: () => number;
  readonly randomBytes: (size: number) => Buffer;
}

interface ProcessStoreEntry {
  readonly fingerprint: string;
  readonly promise: Promise<DurableWorkSessionCore>;
}

const PROCESS_STORES_SYMBOL = Symbol.for("@heelee912/omnicodex/durable-work-session-stores/v1");
const processStores = processStoreRegistry();

/**
 * Durable identity boundary between authenticated Web conversations and native work.
 * It performs no model call and creates no worker chat. Persisted state contains only
 * keyed digests and server-generated opaque identifiers, never raw conversation IDs.
 */
export class DurableWorkSessionStore {
  readonly #core: DurableWorkSessionCore;

  private constructor(core: DurableWorkSessionCore) {
    this.#core = core;
  }

  static async open(
    options: DurableWorkSessionStoreOptions = {},
  ): Promise<DurableWorkSessionStore> {
    const configuration = configurationFrom(options);
    const registryKey = processPathKey(configuration.snapshotPath);
    const fingerprint = configurationFingerprint(configuration);
    const existing = processStores.get(registryKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error("Durable work-session store is already open with different options");
      }
      return new DurableWorkSessionStore(await existing.promise);
    }

    const promise = DurableWorkSessionCore.open(configuration);
    const entry = { fingerprint, promise };
    processStores.set(registryKey, entry);
    try {
      return new DurableWorkSessionStore(await promise);
    } catch (error) {
      if (processStores.get(registryKey) === entry) processStores.delete(registryKey);
      throw error;
    }
  }

  bind(input: DurableWorkSessionBindInput): Promise<DurableWorkSessionBinding> {
    return this.#core.bind(input);
  }

  resume(input: DurableWorkSessionResumeInput): Promise<DurableWorkSessionResumePoint> {
    return this.#core.resume(input);
  }

  listOwnedWorkSessionBindings(authorizationBinding: string): Promise<readonly string[]> {
    return this.#core.listOwnedWorkSessionBindings(authorizationBinding);
  }

  get snapshotPath(): string {
    return this.#core.snapshotPath;
  }

  get journalPath(): string {
    return this.#core.journalPath;
  }
}

class DurableWorkSessionCore {
  readonly #configuration: StoreConfiguration;
  readonly #hmacKey: Buffer;
  #sessions: Map<string, StoredWorkSession>;
  #tombstones: Map<string, StoredTombstone>;
  #revision: number;
  #compactedRevision: number;
  #journalEntries: number;
  #tail: Promise<void> = Promise.resolve();

  private constructor(configuration: StoreConfiguration, hmacKey: Buffer, loaded: LoadedState) {
    this.#configuration = configuration;
    this.#hmacKey = hmacKey;
    this.#sessions = loaded.sessions;
    this.#tombstones = loaded.tombstones;
    this.#revision = loaded.revision;
    this.#compactedRevision = loaded.compactedRevision;
    this.#journalEntries = loaded.journalEntries;
  }

  static async open(configuration: StoreConfiguration): Promise<DurableWorkSessionCore> {
    const hmacKey =
      configuration.suppliedHmacKey === undefined
        ? await loadOrCreateHmacKey(configuration.hmacKeyPath, configuration.randomBytes)
        : Buffer.from(configuration.suppliedHmacKey);
    let loaded = await loadState(configuration, hmacKey);
    assertState(configuration, hmacKey, loaded.sessions, loaded.tombstones);
    if (loaded.journalEntries >= configuration.journalCompactionEntries) {
      await writeSnapshot(
        configuration.snapshotPath,
        loaded.revision,
        loaded.sessions,
        loaded.tombstones,
        hmacKey,
        configuration.maxPersistenceBytes,
      );
      await replaceWithEmptyFile(configuration.journalPath, configuration.maxPersistenceBytes);
      loaded = {
        ...loaded,
        compactedRevision: loaded.revision,
        journalEntries: 0,
      };
    }
    return new DurableWorkSessionCore(configuration, hmacKey, loaded);
  }

  get snapshotPath(): string {
    return this.#configuration.snapshotPath;
  }

  get journalPath(): string {
    return this.#configuration.journalPath;
  }

  bind(input: DurableWorkSessionBindInput): Promise<DurableWorkSessionBinding> {
    return this.#serialized(async () => {
      const authorizationBinding = requiredAuthorizationBinding(input.authorizationBinding);
      const transportSessionId = requiredOpaqueText(input.transportSessionId, "transportSessionId");
      const now = checkedTimestamp(this.#configuration.nowUnixMs());
      const ownerDigest = keyedDigest(this.#hmacKey, "owner", authorizationBinding);
      const transportDigest = keyedDigest(this.#hmacKey, "transport", transportSessionId);
      const conversationIdentity = conversationIdentityFrom(input.requestMeta);
      const relatedTaskDigest =
        conversationIdentity === undefined
          ? undefined
          : keyedDigest(
              this.#hmacKey,
              "related-task",
              lengthPrefixed(ownerDigest, canonicalConversationIdentity(conversationIdentity)),
            );
      const continuationToken = continuationTokenFrom(input);

      let nextSessions = new Map(this.#sessions);
      let nextTombstones = new Map(this.#tombstones);
      ({ sessions: nextSessions, tombstones: nextTombstones } = this.#prunedState(
        now,
        nextSessions,
        nextTombstones,
      ));
      // Expiry is itself durable. In particular, an expired-token error must not
      // roll the tombstone back merely because no new binding is returned.
      await this.#commit(nextSessions, nextTombstones);
      nextSessions = new Map(this.#sessions);
      nextTombstones = new Map(this.#tombstones);

      const transportSessions = [...nextSessions.values()].filter((session) =>
        session.transportBindings.some((binding) => binding.digest === transportDigest),
      );
      if (transportSessions.some((session) => session.ownerDigest !== ownerDigest)) {
        throw new WorkSessionAuthorizationError();
      }

      const tokenSession =
        continuationToken === undefined
          ? undefined
          : this.#sessionForContinuation(
              continuationToken,
              ownerDigest,
              nextSessions,
              nextTombstones,
            );
      const relatedSession =
        relatedTaskDigest === undefined
          ? undefined
          : findSession(
              nextSessions,
              (session) =>
                session.ownerDigest === ownerDigest &&
                session.relatedTaskDigest === relatedTaskDigest,
            );

      // A transport (or upstream trace) can carry multiple conversations. Explicit
      // identities must agree with one another; transport correlation is only a
      // fallback when it identifies an unambiguous conversation.
      const candidates = [tokenSession, relatedSession].filter(
        (session): session is StoredWorkSession => session !== undefined,
      );
      if (new Set(candidates.map((session) => session.internalId)).size > 1) {
        throw new WorkSessionConflictError();
      }

      let session = candidates[0];
      if (session === undefined) {
        if (relatedTaskDigest === undefined) {
          if (transportSessions.length > 1) throw new WorkSessionConflictError();
          session = transportSessions[0];
        } else if (
          transportSessions.length === 1 &&
          transportSessions[0]?.relatedTaskDigest === undefined
        ) {
          session = transportSessions[0];
        }
      }
      let created = false;
      if (session === undefined) {
        if (continuationToken !== undefined) throw new WorkSessionNotFoundError();
        if (
          this.#configuration.maxSessions !== undefined &&
          nextSessions.size >= this.#configuration.maxSessions
        ) {
          throw new WorkSessionCapacityError();
        }
        session = this.#newSession(ownerDigest, relatedTaskDigest, now);
        created = true;
      }
      if (session.ownerDigest !== ownerDigest) throw new WorkSessionAuthorizationError();
      if (
        relatedTaskDigest !== undefined &&
        session.relatedTaskDigest !== undefined &&
        session.relatedTaskDigest !== relatedTaskDigest
      ) {
        throw new WorkSessionConflictError();
      }

      const transportBindings = bindTransport(
        session.transportBindings,
        transportDigest,
        now,
        this.#configuration.maxTransportBindings,
      );
      const { expiresAtUnixMs: _previousExpiry, ...sessionWithoutExpiry } = session;
      const updated: StoredWorkSession = {
        ...sessionWithoutExpiry,
        ...(session.relatedTaskDigest === undefined && relatedTaskDigest !== undefined
          ? { relatedTaskDigest }
          : {}),
        updatedAtUnixMs: Math.max(session.updatedAtUnixMs, now),
        ...(this.#configuration.sessionTtlMs === undefined
          ? {}
          : {
              expiresAtUnixMs: checkedFutureTimestamp(now, this.#configuration.sessionTtlMs),
            }),
        transportBindings,
      };
      nextSessions.set(updated.internalId, updated);
      await this.#commit(nextSessions, nextTombstones);

      const source: WorkSessionBindingSource =
        conversationIdentity?.kind === "openai_session"
          ? "openai_session"
          : relatedTaskDigest !== undefined
            ? "related_task"
            : tokenSession !== undefined
              ? "continuation_token"
              : created
                ? "issued"
                : "transport_session";
      return this.#publicBinding(updated, source, created);
    });
  }

  listOwnedWorkSessionBindings(authorizationBinding: string): Promise<readonly string[]> {
    return this.#serialized(async () => {
      const ownerDigest = keyedDigest(
        this.#hmacKey,
        "owner",
        requiredAuthorizationBinding(authorizationBinding),
      );
      const now = checkedTimestamp(this.#configuration.nowUnixMs());
      const bindings: string[] = [];
      for (const session of this.#sessions.values()) {
        if (session.ownerDigest !== ownerDigest) continue;
        const expiresAtUnixMs = sessionExpiryUnixMs(session, this.#configuration.sessionTtlMs);
        if (expiresAtUnixMs !== undefined && expiresAtUnixMs <= now) continue;
        bindings.push(session.workSessionBinding);
      }
      return bindings;
    });
  }

  resume(input: DurableWorkSessionResumeInput): Promise<DurableWorkSessionResumePoint> {
    return this.#serialized(async () => {
      const authorizationBinding = requiredAuthorizationBinding(input.authorizationBinding);
      const workSessionBinding = requiredWorkSessionBinding(input.workSessionBinding);
      const now = checkedTimestamp(this.#configuration.nowUnixMs());
      const ownerDigest = keyedDigest(this.#hmacKey, "owner", authorizationBinding);
      const session = findSession(
        this.#sessions,
        (candidate) => candidate.workSessionBinding === workSessionBinding,
      );
      if (session === undefined) throw new WorkSessionNotFoundError();
      if (session.ownerDigest !== ownerDigest) throw new WorkSessionAuthorizationError();
      const expiresAtUnixMs = sessionExpiryUnixMs(session, this.#configuration.sessionTtlMs);
      if (expiresAtUnixMs !== undefined && expiresAtUnixMs <= now) {
        throw new WorkSessionExpiredError();
      }

      let cursorRevision: number | undefined;
      if (input.afterJournalCursor !== undefined) {
        cursorRevision = parseAndVerifyCursor(
          this.#hmacKey,
          session.internalId,
          input.afterJournalCursor,
        );
        if (cursorRevision > this.#revision) throw new WorkSessionConflictError();
      }
      const stable = session.workSessionBinding;
      return {
        workSessionBinding: stable,
        directGoalClaimantBinding: stable,
        directJobOwnerBinding: stable,
        continuationToken: continuationTokenFor(this.#hmacKey, session.internalId),
        journalCursor: journalCursorFor(this.#hmacKey, session.internalId, this.#revision),
        changedSinceCursor: cursorRevision === undefined || cursorRevision < this.#revision,
        cursorWasCompacted:
          cursorRevision !== undefined && cursorRevision <= this.#compactedRevision,
        ...(expiresAtUnixMs === undefined ? {} : { expiresAtUnixMs }),
      };
    });
  }

  #sessionForContinuation(
    token: string,
    ownerDigest: string,
    sessions: ReadonlyMap<string, StoredWorkSession>,
    tombstones: ReadonlyMap<string, StoredTombstone>,
  ): StoredWorkSession | undefined {
    requiredContinuationToken(token);
    const tokenDigest = keyedDigest(this.#hmacKey, "token-index", token);
    const session = findSession(sessions, (candidate) => candidate.tokenDigest === tokenDigest);
    if (session !== undefined) {
      if (session.ownerDigest !== ownerDigest) throw new WorkSessionAuthorizationError();
      if (!constantTimeTextEqual(token, continuationTokenFor(this.#hmacKey, session.internalId))) {
        throw new WorkSessionAuthorizationError();
      }
      return session;
    }
    const tombstone = tombstones.get(tokenDigest);
    if (tombstone !== undefined) {
      if (tombstone.ownerDigest !== ownerDigest) throw new WorkSessionAuthorizationError();
      throw new WorkSessionExpiredError();
    }
    throw new WorkSessionNotFoundError();
  }

  #newSession(
    ownerDigest: string,
    relatedTaskDigest: string | undefined,
    now: number,
  ): StoredWorkSession {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const internalId = this.#configuration.randomBytes(32).toString("base64url");
      if (!validOpaqueDigest(internalId) || this.#sessions.has(internalId)) continue;
      const workSessionBinding = workSessionBindingFor(this.#hmacKey, ownerDigest, internalId);
      const token = continuationTokenFor(this.#hmacKey, internalId);
      return {
        internalId,
        ownerDigest,
        ...(relatedTaskDigest === undefined ? {} : { relatedTaskDigest }),
        tokenDigest: keyedDigest(this.#hmacKey, "token-index", token),
        workSessionBinding,
        createdAtUnixMs: now,
        updatedAtUnixMs: now,
        ...(this.#configuration.sessionTtlMs === undefined
          ? {}
          : {
              expiresAtUnixMs: checkedFutureTimestamp(now, this.#configuration.sessionTtlMs),
            }),
        transportBindings: [],
      };
    }
    throw new WorkSessionCapacityError();
  }

  #prunedState(
    now: number,
    sessions: Map<string, StoredWorkSession>,
    tombstones: Map<string, StoredTombstone>,
  ): { sessions: Map<string, StoredWorkSession>; tombstones: Map<string, StoredTombstone> } {
    if (this.#configuration.sessionTtlMs !== undefined) {
      for (const [internalId, session] of sessions) {
        const expiresAtUnixMs = sessionExpiryUnixMs(session, this.#configuration.sessionTtlMs);
        if (expiresAtUnixMs === undefined || expiresAtUnixMs > now) continue;
        sessions.delete(internalId);
        tombstones.set(session.tokenDigest, {
          tokenDigest: session.tokenDigest,
          ownerDigest: session.ownerDigest,
          expiredAtUnixMs: now,
          ...(this.#configuration.tombstoneTtlMs === undefined
            ? {}
            : {
                retainUntilUnixMs: checkedFutureTimestamp(now, this.#configuration.tombstoneTtlMs),
              }),
        });
      }
    }
    if (this.#configuration.tombstoneTtlMs !== undefined) {
      for (const [tokenDigest, tombstone] of tombstones) {
        const retainUntilUnixMs = tombstoneRetentionUnixMs(
          tombstone,
          this.#configuration.tombstoneTtlMs,
        );
        if (retainUntilUnixMs !== undefined && retainUntilUnixMs <= now) {
          tombstones.delete(tokenDigest);
        }
      }
    }
    if (
      this.#configuration.maxTombstones !== undefined &&
      tombstones.size > this.#configuration.maxTombstones
    ) {
      const oldest = [...tombstones.values()].sort(
        (left, right) =>
          left.expiredAtUnixMs - right.expiredAtUnixMs ||
          left.tokenDigest.localeCompare(right.tokenDigest, "en"),
      );
      for (const tombstone of oldest.slice(
        0,
        tombstones.size - this.#configuration.maxTombstones,
      )) {
        tombstones.delete(tombstone.tokenDigest);
      }
    }
    return { sessions, tombstones };
  }

  async #commit(
    sessions: Map<string, StoredWorkSession>,
    tombstones: Map<string, StoredTombstone>,
  ): Promise<void> {
    assertState(this.#configuration, this.#hmacKey, sessions, tombstones);
    const payload = journalDelta(
      this.#revision,
      this.#sessions,
      sessions,
      this.#tombstones,
      tombstones,
    );
    if (
      payload.sessionUpserts.length === 0 &&
      payload.sessionDeletes.length === 0 &&
      payload.tombstoneUpserts.length === 0 &&
      payload.tombstoneDeletes.length === 0
    ) {
      return;
    }
    await appendJournal(
      this.#configuration.journalPath,
      payload,
      this.#hmacKey,
      this.#configuration.maxPersistenceBytes,
    );
    this.#sessions = sessions;
    this.#tombstones = tombstones;
    this.#revision = payload.revision;
    this.#journalEntries += 1;
    if (this.#journalEntries >= this.#configuration.journalCompactionEntries) {
      await writeSnapshot(
        this.#configuration.snapshotPath,
        this.#revision,
        this.#sessions,
        this.#tombstones,
        this.#hmacKey,
        this.#configuration.maxPersistenceBytes,
      );
      await replaceWithEmptyFile(
        this.#configuration.journalPath,
        this.#configuration.maxPersistenceBytes,
      );
      this.#compactedRevision = this.#revision;
      this.#journalEntries = 0;
    }
  }

  #publicBinding(
    session: StoredWorkSession,
    source: WorkSessionBindingSource,
    created: boolean,
  ): DurableWorkSessionBinding {
    const stable = session.workSessionBinding;
    const expiresAtUnixMs = sessionExpiryUnixMs(session, this.#configuration.sessionTtlMs);
    return {
      workSessionBinding: stable,
      directGoalClaimantBinding: stable,
      directJobOwnerBinding: stable,
      continuationToken: continuationTokenFor(this.#hmacKey, session.internalId),
      source,
      created,
      journalCursor: journalCursorFor(this.#hmacKey, session.internalId, this.#revision),
      ...(expiresAtUnixMs === undefined ? {} : { expiresAtUnixMs }),
    };
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const scheduled = this.#tail.then(operation, operation);
    this.#tail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }
}

function configurationFrom(options: DurableWorkSessionStoreOptions): StoreConfiguration {
  const dataDirectory = resolve(options.dataDirectory ?? omniCodexDataDirectory());
  const stateDirectory = join(dataDirectory, "state");
  const snapshotPath = resolve(
    options.snapshotPath ?? join(stateDirectory, "durable-work-sessions-v1.json"),
  );
  const suppliedHmacKey =
    options.hmacKey === undefined ? undefined : validatedHmacKey(options.hmacKey);
  return {
    snapshotPath,
    journalPath: resolve(options.journalPath ?? `${snapshotPath}.journal`),
    hmacKeyPath: resolve(options.hmacKeyPath ?? join(stateDirectory, "work-session-hmac-v1.key")),
    ...(suppliedHmacKey === undefined ? {} : { suppliedHmacKey }),
    sessionTtlMs: optionalPositiveInteger(options.sessionTtlMs, "sessionTtlMs"),
    tombstoneTtlMs: optionalPositiveInteger(options.tombstoneTtlMs, "tombstoneTtlMs"),
    maxSessions: optionalPositiveInteger(options.maxSessions, "maxSessions"),
    maxTombstones: optionalPositiveInteger(options.maxTombstones, "maxTombstones"),
    maxTransportBindings: optionalPositiveInteger(
      options.maxTransportBindings,
      "maxTransportBindings",
    ),
    journalCompactionEntries:
      optionalPositiveInteger(options.maxJournalEntries, "maxJournalEntries") ??
      DEFAULT_JOURNAL_COMPACTION_ENTRIES,
    maxPersistenceBytes: optionalPositiveInteger(
      options.maxPersistenceBytes,
      "maxPersistenceBytes",
    ),
    nowUnixMs: options.nowUnixMs ?? Date.now,
    randomBytes: options.randomBytes ?? randomBytes,
  };
}

function configurationFingerprint(configuration: StoreConfiguration): string {
  return canonicalJson({
    snapshotPath: processPathKey(configuration.snapshotPath),
    journalPath: processPathKey(configuration.journalPath),
    hmacKeyPath: processPathKey(configuration.hmacKeyPath),
    suppliedHmacKey:
      configuration.suppliedHmacKey === undefined
        ? null
        : keyedDigest(configuration.suppliedHmacKey, "configuration", "hmac-key"),
    sessionTtlMs: configuration.sessionTtlMs,
    tombstoneTtlMs: configuration.tombstoneTtlMs,
    maxSessions: configuration.maxSessions,
    maxTombstones: configuration.maxTombstones,
    maxTransportBindings: configuration.maxTransportBindings,
    journalCompactionEntries: configuration.journalCompactionEntries,
    maxPersistenceBytes: configuration.maxPersistenceBytes,
  });
}

function journalDelta(
  previousRevision: number,
  currentSessions: ReadonlyMap<string, StoredWorkSession>,
  nextSessions: ReadonlyMap<string, StoredWorkSession>,
  currentTombstones: ReadonlyMap<string, StoredTombstone>,
  nextTombstones: ReadonlyMap<string, StoredTombstone>,
): JournalPayload {
  const sessionUpserts = changedValues(currentSessions, nextSessions);
  const sessionDeletes = deletedKeys(currentSessions, nextSessions);
  const tombstoneUpserts = changedValues(currentTombstones, nextTombstones);
  const tombstoneDeletes = deletedKeys(currentTombstones, nextTombstones);
  return {
    schemaVersion: SCHEMA_VERSION,
    previousRevision,
    revision: checkedRevision(previousRevision + 1),
    sessionUpserts,
    sessionDeletes,
    tombstoneUpserts,
    tombstoneDeletes,
  };
}

function changedValues<T>(current: ReadonlyMap<string, T>, next: ReadonlyMap<string, T>): T[] {
  return [...next.entries()]
    .filter(([key, value]) => {
      const previous = current.get(key);
      return previous === undefined || canonicalJson(previous) !== canonicalJson(value);
    })
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([, value]) => value);
}

function deletedKeys<T>(current: ReadonlyMap<string, T>, next: ReadonlyMap<string, T>): string[] {
  return [...current.keys()]
    .filter((key) => !next.has(key))
    .sort((left, right) => left.localeCompare(right, "en"));
}

async function loadState(configuration: StoreConfiguration, hmacKey: Buffer): Promise<LoadedState> {
  const snapshot = await loadSnapshot(configuration, hmacKey);
  const sessions = new Map(snapshot.sessions.map((session) => [session.internalId, session]));
  const tombstones = new Map(
    snapshot.tombstones.map((tombstone) => [tombstone.tokenDigest, tombstone]),
  );
  const journal = await loadJournal(configuration, hmacKey);
  let revision = snapshot.revision;
  for (const entry of journal) {
    if (entry.revision <= revision) continue;
    if (entry.previousRevision !== revision || entry.revision !== revision + 1) {
      throw new WorkSessionPersistenceError("Work-session journal revisions are not contiguous");
    }
    applyJournalEntry(sessions, tombstones, entry);
    revision = entry.revision;
  }
  return {
    revision,
    compactedRevision: snapshot.revision,
    journalEntries: journal.length,
    sessions,
    tombstones,
  };
}

async function loadSnapshot(
  configuration: StoreConfiguration,
  hmacKey: Buffer,
): Promise<SnapshotPayload> {
  const raw = await readBoundedFile(configuration.snapshotPath, configuration.maxPersistenceBytes);
  if (raw === undefined) {
    return { schemaVersion: SCHEMA_VERSION, revision: 0, sessions: [], tombstones: [] };
  }
  const parsed = parseJson(raw, "Work-session snapshot is not valid JSON");
  const snapshot = parseSnapshot(parsed, configuration);
  const expected = persistenceChecksum(hmacKey, "snapshot", snapshot);
  if (!constantTimeTextEqual(snapshot.checksum, expected)) {
    throw new WorkSessionPersistenceError("Work-session snapshot checksum mismatch");
  }
  return snapshot;
}

async function loadJournal(
  configuration: StoreConfiguration,
  hmacKey: Buffer,
): Promise<StoredJournalEntry[]> {
  const raw = await readBoundedFile(configuration.journalPath, configuration.maxPersistenceBytes);
  if (raw === undefined || raw.length === 0) return [];
  if (!raw.endsWith("\n")) {
    throw new WorkSessionPersistenceError("Work-session journal has an incomplete record");
  }
  const lines = raw.split("\n").filter((line) => line.length > 0);
  return lines.map((line, index) => {
    const parsed = parseJson(line, `Work-session journal record ${index + 1} is not valid JSON`);
    const entry = parseJournalEntry(parsed, configuration);
    const expected = persistenceChecksum(hmacKey, "journal", entry);
    if (!constantTimeTextEqual(entry.checksum, expected)) {
      throw new WorkSessionPersistenceError(
        `Work-session journal record ${index + 1} checksum mismatch`,
      );
    }
    return entry;
  });
}

function parseSnapshot(value: unknown, configuration: StoreConfiguration): StoredSnapshot {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["schemaVersion", "revision", "sessions", "tombstones", "checksum"]) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    !validRevision(value.revision) ||
    !Array.isArray(value.sessions) ||
    (configuration.maxSessions !== undefined &&
      value.sessions.length > configuration.maxSessions) ||
    !Array.isArray(value.tombstones) ||
    (configuration.maxTombstones !== undefined &&
      value.tombstones.length > configuration.maxTombstones) ||
    typeof value.checksum !== "string" ||
    !validOpaqueDigest(value.checksum)
  ) {
    throw new WorkSessionPersistenceError("Work-session snapshot envelope is invalid");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: value.revision,
    sessions: value.sessions.map((item) => parseSession(item, configuration)),
    tombstones: value.tombstones.map(parseTombstone),
    checksum: value.checksum,
  };
}

function parseJournalEntry(value: unknown, configuration: StoreConfiguration): StoredJournalEntry {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "previousRevision",
      "revision",
      "sessionUpserts",
      "sessionDeletes",
      "tombstoneUpserts",
      "tombstoneDeletes",
      "checksum",
    ]) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    !validRevision(value.previousRevision) ||
    !validRevision(value.revision) ||
    value.revision !== value.previousRevision + 1 ||
    !Array.isArray(value.sessionUpserts) ||
    !Array.isArray(value.sessionDeletes) ||
    !Array.isArray(value.tombstoneUpserts) ||
    !Array.isArray(value.tombstoneDeletes) ||
    typeof value.checksum !== "string" ||
    !validOpaqueDigest(value.checksum)
  ) {
    throw new WorkSessionPersistenceError("Work-session journal envelope is invalid");
  }
  const sessionUpserts = value.sessionUpserts.map((item) => parseSession(item, configuration));
  const sessionDeletes = value.sessionDeletes.map(requiredInternalId);
  const tombstoneUpserts = value.tombstoneUpserts.map(parseTombstone);
  const tombstoneDeletes = value.tombstoneDeletes.map(requiredOpaqueDigest);
  if (
    hasDuplicates(sessionUpserts.map((item) => item.internalId)) ||
    hasDuplicates(sessionDeletes) ||
    hasDuplicates(tombstoneUpserts.map((item) => item.tokenDigest)) ||
    hasDuplicates(tombstoneDeletes)
  ) {
    throw new WorkSessionPersistenceError("Work-session journal contains duplicate identities");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    previousRevision: value.previousRevision,
    revision: value.revision,
    sessionUpserts,
    sessionDeletes,
    tombstoneUpserts,
    tombstoneDeletes,
    checksum: value.checksum,
  };
}

function parseSession(value: unknown, configuration: StoreConfiguration): StoredWorkSession {
  if (!isRecord(value)) throw new WorkSessionPersistenceError("Work-session record is invalid");
  const allowed = [
    "internalId",
    "ownerDigest",
    "tokenDigest",
    "workSessionBinding",
    "createdAtUnixMs",
    "updatedAtUnixMs",
    ...(value.expiresAtUnixMs === undefined ? [] : ["expiresAtUnixMs"]),
    "transportBindings",
    ...(value.relatedTaskDigest === undefined ? [] : ["relatedTaskDigest"]),
  ];
  if (
    !hasOnlyKeys(value, allowed) ||
    !validOpaqueDigest(value.internalId) ||
    !validOpaqueDigest(value.ownerDigest) ||
    (value.relatedTaskDigest !== undefined && !validOpaqueDigest(value.relatedTaskDigest)) ||
    !validOpaqueDigest(value.tokenDigest) ||
    typeof value.workSessionBinding !== "string" ||
    !/^wsb1_[A-Za-z0-9_-]{43}$/.test(value.workSessionBinding) ||
    !validTimestamp(value.createdAtUnixMs) ||
    !validTimestamp(value.updatedAtUnixMs) ||
    (value.expiresAtUnixMs !== undefined && !validTimestamp(value.expiresAtUnixMs)) ||
    value.updatedAtUnixMs < value.createdAtUnixMs ||
    (value.expiresAtUnixMs !== undefined && value.expiresAtUnixMs <= value.updatedAtUnixMs) ||
    !Array.isArray(value.transportBindings) ||
    (configuration.maxTransportBindings !== undefined &&
      value.transportBindings.length > configuration.maxTransportBindings)
  ) {
    throw new WorkSessionPersistenceError("Work-session record is invalid");
  }
  const transportBindings = value.transportBindings.map(parseTransportBinding);
  if (hasDuplicates(transportBindings.map((binding) => binding.digest))) {
    throw new WorkSessionPersistenceError("Work-session transport bindings are duplicated");
  }
  return {
    internalId: value.internalId,
    ownerDigest: value.ownerDigest,
    ...(value.relatedTaskDigest === undefined
      ? {}
      : { relatedTaskDigest: value.relatedTaskDigest }),
    tokenDigest: value.tokenDigest,
    workSessionBinding: value.workSessionBinding,
    createdAtUnixMs: value.createdAtUnixMs,
    updatedAtUnixMs: value.updatedAtUnixMs,
    ...(value.expiresAtUnixMs === undefined ? {} : { expiresAtUnixMs: value.expiresAtUnixMs }),
    transportBindings,
  };
}

function parseTransportBinding(value: unknown): StoredTransportBinding {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["digest", "boundAtUnixMs"]) ||
    !validOpaqueDigest(value.digest) ||
    !validTimestamp(value.boundAtUnixMs)
  ) {
    throw new WorkSessionPersistenceError("Work-session transport binding is invalid");
  }
  return { digest: value.digest, boundAtUnixMs: value.boundAtUnixMs };
}

function parseTombstone(value: unknown): StoredTombstone {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "tokenDigest",
      "ownerDigest",
      "expiredAtUnixMs",
      ...(value.retainUntilUnixMs === undefined ? [] : ["retainUntilUnixMs"]),
    ]) ||
    !validOpaqueDigest(value.tokenDigest) ||
    !validOpaqueDigest(value.ownerDigest) ||
    !validTimestamp(value.expiredAtUnixMs) ||
    (value.retainUntilUnixMs !== undefined && !validTimestamp(value.retainUntilUnixMs)) ||
    (value.retainUntilUnixMs !== undefined && value.retainUntilUnixMs <= value.expiredAtUnixMs)
  ) {
    throw new WorkSessionPersistenceError("Work-session tombstone is invalid");
  }
  return {
    tokenDigest: value.tokenDigest,
    ownerDigest: value.ownerDigest,
    expiredAtUnixMs: value.expiredAtUnixMs,
    ...(value.retainUntilUnixMs === undefined
      ? {}
      : { retainUntilUnixMs: value.retainUntilUnixMs }),
  };
}

function applyJournalEntry(
  sessions: Map<string, StoredWorkSession>,
  tombstones: Map<string, StoredTombstone>,
  entry: JournalPayload,
): void {
  for (const internalId of entry.sessionDeletes) sessions.delete(internalId);
  for (const session of entry.sessionUpserts) sessions.set(session.internalId, session);
  for (const tokenDigest of entry.tombstoneDeletes) tombstones.delete(tokenDigest);
  for (const tombstone of entry.tombstoneUpserts) {
    tombstones.set(tombstone.tokenDigest, tombstone);
  }
}

function assertState(
  configuration: StoreConfiguration,
  hmacKey: Buffer,
  sessions: ReadonlyMap<string, StoredWorkSession>,
  tombstones: ReadonlyMap<string, StoredTombstone>,
): void {
  if (
    (configuration.maxSessions !== undefined && sessions.size > configuration.maxSessions) ||
    (configuration.maxTombstones !== undefined && tombstones.size > configuration.maxTombstones)
  ) {
    throw new WorkSessionPersistenceError("Work-session state exceeds configured bounds");
  }
  const ownerTasks = new Set<string>();
  const tokens = new Set<string>();
  const workBindings = new Set<string>();
  const transportOwners = new Map<string, string>();
  for (const [internalId, session] of sessions) {
    if (internalId !== session.internalId) {
      throw new WorkSessionPersistenceError("Work-session map identity mismatch");
    }
    if (
      session.workSessionBinding !==
      workSessionBindingFor(hmacKey, session.ownerDigest, session.internalId)
    ) {
      throw new WorkSessionPersistenceError("Work-session binding authentication failed");
    }
    const token = continuationTokenFor(hmacKey, session.internalId);
    if (session.tokenDigest !== keyedDigest(hmacKey, "token-index", token)) {
      throw new WorkSessionPersistenceError("Work-session continuation authentication failed");
    }
    if (tokens.has(session.tokenDigest) || workBindings.has(session.workSessionBinding)) {
      throw new WorkSessionPersistenceError("Work-session identities are duplicated");
    }
    tokens.add(session.tokenDigest);
    workBindings.add(session.workSessionBinding);
    if (session.relatedTaskDigest !== undefined) {
      const ownerTask = `${session.ownerDigest}:${session.relatedTaskDigest}`;
      if (ownerTasks.has(ownerTask)) {
        throw new WorkSessionPersistenceError("Related task is bound to multiple work sessions");
      }
      ownerTasks.add(ownerTask);
    }
    for (const binding of session.transportBindings) {
      const transportOwner = transportOwners.get(binding.digest);
      if (transportOwner !== undefined && transportOwner !== session.ownerDigest) {
        throw new WorkSessionPersistenceError("MCP transport is bound to multiple owners");
      }
      transportOwners.set(binding.digest, session.ownerDigest);
    }
  }
  for (const [tokenDigest, tombstone] of tombstones) {
    if (tokenDigest !== tombstone.tokenDigest || tokens.has(tokenDigest)) {
      throw new WorkSessionPersistenceError("Work-session tombstone identity is invalid");
    }
  }
}

async function appendJournal(
  path: string,
  payload: JournalPayload,
  hmacKey: Buffer,
  maxBytes: number | undefined,
): Promise<void> {
  const entry: StoredJournalEntry = {
    ...payload,
    checksum: persistenceChecksum(hmacKey, "journal", payload),
  };
  const line = `${canonicalJson(entry)}\n`;
  if (maxBytes !== undefined) {
    const existing = await readBoundedFile(path, maxBytes);
    if (Buffer.byteLength(existing ?? "", "utf8") + Buffer.byteLength(line, "utf8") > maxBytes) {
      throw new WorkSessionPersistenceError("Work-session journal exceeds its byte bound");
    }
  }
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeSnapshot(
  path: string,
  revision: number,
  sessions: ReadonlyMap<string, StoredWorkSession>,
  tombstones: ReadonlyMap<string, StoredTombstone>,
  hmacKey: Buffer,
  maxBytes: number | undefined,
): Promise<void> {
  const payload: SnapshotPayload = {
    schemaVersion: SCHEMA_VERSION,
    revision,
    sessions: [...sessions.values()].sort((left, right) =>
      left.internalId.localeCompare(right.internalId, "en"),
    ),
    tombstones: [...tombstones.values()].sort((left, right) =>
      left.tokenDigest.localeCompare(right.tokenDigest, "en"),
    ),
  };
  const snapshot: StoredSnapshot = {
    ...payload,
    checksum: persistenceChecksum(hmacKey, "snapshot", payload),
  };
  await atomicWrite(path, `${canonicalJson(snapshot)}\n`, maxBytes);
}

async function replaceWithEmptyFile(path: string, maxBytes: number | undefined): Promise<void> {
  await atomicWrite(path, "", maxBytes);
}

async function atomicWrite(
  path: string,
  content: string,
  maxBytes: number | undefined,
): Promise<void> {
  if (maxBytes !== undefined && Buffer.byteLength(content, "utf8") > maxBytes) {
    throw new WorkSessionPersistenceError("Work-session persistence exceeds its byte bound");
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function loadOrCreateHmacKey(
  path: string,
  random: (size: number) => Buffer,
): Promise<Buffer> {
  const existing = await readBoundedFile(path, 128);
  if (existing !== undefined) return parseHmacKey(existing);
  await mkdir(dirname(path), { recursive: true });
  const key = validatedHmacKey(random(32));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${key.toString("base64url")}\n`, "utf8");
    await handle.sync();
    await handle.close();
    return key;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (getErrorCode(error) !== "EEXIST") throw error;
    const raced = await readBoundedFile(path, 128);
    if (raced === undefined) {
      throw new WorkSessionPersistenceError("Work-session HMAC key creation raced without a key");
    }
    return parseHmacKey(raced);
  }
}

function parseHmacKey(raw: string): Buffer {
  const encoded = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new WorkSessionPersistenceError("Work-session HMAC key is invalid");
  }
  return validatedHmacKey(Buffer.from(encoded, "base64url"));
}

async function readBoundedFile(
  path: string,
  maxBytes: number | undefined,
): Promise<string | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (maxBytes !== undefined && bytes.length > maxBytes) {
    throw new WorkSessionPersistenceError("Work-session persistence exceeds its byte bound");
  }
  return bytes.toString("utf8");
}

interface WorkSessionConversationIdentity {
  readonly kind: "openai_session" | "related_task";
  readonly id: string;
}

function conversationIdentityFrom(
  meta: Readonly<Record<string, unknown>> | undefined,
): WorkSessionConversationIdentity | undefined {
  if (meta === undefined) return undefined;

  const openAiSessionDescriptor = Object.getOwnPropertyDescriptor(
    meta,
    WORK_SESSION_OPENAI_SESSION_META_KEY,
  );
  if (openAiSessionDescriptor !== undefined) {
    if (!("value" in openAiSessionDescriptor)) {
      throw new TypeError("OpenAI session metadata must be a plain data value");
    }
    return {
      kind: "openai_session",
      id: requiredOpaqueText(openAiSessionDescriptor.value, "openai/session"),
    };
  }

  if (!Object.hasOwn(meta, WORK_SESSION_RELATED_TASK_META_KEY)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(meta, WORK_SESSION_RELATED_TASK_META_KEY);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError("Related-task metadata must be a plain data value");
  }
  const related = descriptor.value;
  if (!isRecord(related)) throw new TypeError("Related-task metadata is invalid");
  const taskDescriptor = Object.getOwnPropertyDescriptor(related, "taskId");
  if (taskDescriptor === undefined || !("value" in taskDescriptor)) {
    throw new TypeError("Related-task metadata is invalid");
  }
  return {
    kind: "related_task",
    id: requiredOpaqueText(taskDescriptor.value, "related taskId"),
  };
}

function continuationTokenFrom(input: DurableWorkSessionBindInput): string | undefined {
  const metaTokenDescriptor =
    input.requestMeta === undefined
      ? undefined
      : Object.getOwnPropertyDescriptor(input.requestMeta, WORK_SESSION_CONTINUATION_META_KEY);
  if (metaTokenDescriptor !== undefined && !("value" in metaTokenDescriptor)) {
    throw new TypeError("Work-session continuation metadata is invalid");
  }
  const metaToken = metaTokenDescriptor?.value;
  if (metaToken !== undefined && typeof metaToken !== "string") {
    throw new TypeError("Work-session continuation metadata is invalid");
  }
  if (
    input.continuationToken !== undefined &&
    metaToken !== undefined &&
    input.continuationToken !== metaToken
  ) {
    throw new WorkSessionConflictError();
  }
  const token = input.continuationToken ?? metaToken;
  return token === undefined ? undefined : requiredContinuationToken(token);
}

function canonicalConversationIdentity(identity: WorkSessionConversationIdentity): string {
  return canonicalJson(identity);
}

function bindTransport(
  current: readonly StoredTransportBinding[],
  digest: string,
  now: number,
  maximum: number | undefined,
): readonly StoredTransportBinding[] {
  const next = current.filter((binding) => binding.digest !== digest);
  next.push({ digest, boundAtUnixMs: now });
  next.sort(
    (left, right) =>
      left.boundAtUnixMs - right.boundAtUnixMs || left.digest.localeCompare(right.digest, "en"),
  );
  return maximum === undefined ? next : next.slice(Math.max(0, next.length - maximum));
}

function sessionExpiryUnixMs(
  session: StoredWorkSession,
  sessionTtlMs: number | undefined,
): number | undefined {
  if (sessionTtlMs === undefined) return undefined;
  return session.expiresAtUnixMs ?? checkedFutureTimestamp(session.updatedAtUnixMs, sessionTtlMs);
}

function tombstoneRetentionUnixMs(
  tombstone: StoredTombstone,
  tombstoneTtlMs: number | undefined,
): number | undefined {
  if (tombstoneTtlMs === undefined) return undefined;
  return (
    tombstone.retainUntilUnixMs ?? checkedFutureTimestamp(tombstone.expiredAtUnixMs, tombstoneTtlMs)
  );
}

function findSession(
  sessions: ReadonlyMap<string, StoredWorkSession>,
  predicate: (session: StoredWorkSession) => boolean,
): StoredWorkSession | undefined {
  for (const session of sessions.values()) {
    if (predicate(session)) return session;
  }
  return undefined;
}

function workSessionBindingFor(hmacKey: Buffer, ownerDigest: string, internalId: string): string {
  return `wsb1_${keyedDigest(hmacKey, "work-session", lengthPrefixed(ownerDigest, internalId))}`;
}

function continuationTokenFor(hmacKey: Buffer, internalId: string): string {
  return `wct1_${keyedDigest(hmacKey, "continuation", internalId)}`;
}

function journalCursorFor(hmacKey: Buffer, internalId: string, revision: number): string {
  return `wsc1_${revision.toString(36)}_${keyedDigest(
    hmacKey,
    "journal-cursor",
    lengthPrefixed(internalId, String(revision)),
  )}`;
}

function parseAndVerifyCursor(hmacKey: Buffer, internalId: string, cursor: string): number {
  const match = /^wsc1_([0-9a-z]+)_([A-Za-z0-9_-]{43})$/.exec(cursor);
  if (match === null) throw new WorkSessionConflictError();
  const encodedRevision = match[1];
  if (encodedRevision === undefined) throw new WorkSessionConflictError();
  const revision = Number.parseInt(encodedRevision, 36);
  if (!validRevision(revision)) throw new WorkSessionConflictError();
  if (!constantTimeTextEqual(cursor, journalCursorFor(hmacKey, internalId, revision))) {
    throw new WorkSessionConflictError();
  }
  return revision;
}

function persistenceChecksum(
  hmacKey: Buffer,
  domain: "snapshot" | "journal",
  value: SnapshotPayload | JournalPayload | StoredSnapshot | StoredJournalEntry,
): string {
  const record = value as unknown as Record<string, unknown>;
  const { checksum: _checksum, ...payload } = record;
  return keyedDigest(hmacKey, `persistence:${domain}`, canonicalJson(payload));
}

function keyedDigest(key: Uint8Array, domain: string, value: string): string {
  return createHmac("sha256", key)
    .update(`omnicodex-work-session-v1:${domain}\0`, "utf8")
    .update(value, "utf8")
    .digest("base64url");
}

function lengthPrefixed(...values: readonly string[]): string {
  return values.map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`).join("|");
}

function requiredOpaqueText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1 || /[\0\r\n]/.test(value)) {
    throw new TypeError(`${name} is not a valid opaque value`);
  }
  return value;
}

function requiredAuthorizationBinding(value: unknown): string {
  if (typeof value !== "string" || value.length < 7 || /[\r\n]/.test(value)) {
    throw new TypeError("authorizationBinding is invalid");
  }
  const segments = value.split("\0");
  if (segments.length !== 4 || segments.some((segment) => segment.length === 0)) {
    throw new TypeError("authorizationBinding must contain four non-empty identity segments");
  }
  return value;
}

function requiredContinuationToken(value: string): string {
  if (!/^wct1_[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new TypeError("Work-session continuation token is invalid");
  }
  return value;
}

function requiredWorkSessionBinding(value: string): string {
  if (!/^wsb1_[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new TypeError("Work-session binding is invalid");
  }
  return value;
}

function requiredInternalId(value: unknown): string {
  if (!validOpaqueDigest(value)) {
    throw new WorkSessionPersistenceError("Work-session internal identity is invalid");
  }
  return value;
}

function requiredOpaqueDigest(value: unknown): string {
  if (!validOpaqueDigest(value)) {
    throw new WorkSessionPersistenceError("Work-session digest is invalid");
  }
  return value;
}

function validatedHmacKey(value: Uint8Array): Buffer {
  const key = Buffer.from(value);
  if (key.length < 32 || key.length > 64) {
    throw new RangeError("Work-session HMAC key must contain between 32 and 64 bytes");
  }
  return key;
}

function checkedTimestamp(value: number): number {
  if (!validTimestamp(value)) throw new RangeError("Work-session clock returned an invalid time");
  return value;
}

function checkedFutureTimestamp(now: number, durationMs: number): number {
  const value = now + durationMs;
  if (!validTimestamp(value) || value <= now) {
    throw new RangeError("Work-session expiry exceeds the supported timestamp range");
  }
  return value;
}

function checkedRevision(value: number): number {
  if (!validRevision(value)) {
    throw new WorkSessionPersistenceError("Work-session revision space is exhausted");
  }
  return value;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validOpaqueDigest(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function optionalPositiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function parseJson(raw: string, message: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new WorkSessionPersistenceError(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function processPathKey(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function processStoreRegistry(): Map<string, ProcessStoreEntry> {
  const scope = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = scope[PROCESS_STORES_SYMBOL];
  if (existing !== undefined) {
    if (!(existing instanceof Map)) {
      throw new Error("Global durable work-session registry has an incompatible value");
    }
    return existing as Map<string, ProcessStoreEntry>;
  }
  const registry = new Map<string, ProcessStoreEntry>();
  Object.defineProperty(scope, PROCESS_STORES_SYMBOL, {
    value: registry,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return registry;
}

function getErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}
