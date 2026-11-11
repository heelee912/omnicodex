import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Dirent } from "node:fs";
import { link, mkdir, open, opendir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type {
  EventId,
  EventStore,
  StreamId,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { omniCodexDataDirectory } from "../config/omnicodex-config-store.js";
import { canonicalJson } from "../safety/canonical-json.js";

const SCHEMA_VERSION = 1;
const LOCATOR_SCHEMA_VERSION = 1;
const LOCATOR_DIRECTORY = "transport-locators";
const MAX_LOCATOR_BYTES = 4_096;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface DurableMcpEventSnapshotCompactionResult {
  readonly snapshotCount: number;
  readonly compressedSnapshotCount: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}

export interface DurableMcpEventSessionBinding {
  /** Stable authenticated principal/tenant boundary. Never persisted verbatim. */
  readonly ownerBinding: string;
  /** Exact public MCP surface, for example `full` or `readonly`. */
  readonly surface: string;
  /** Stable Web conversation/work-session binding. Never persisted verbatim. */
  readonly workSessionBinding: string;
  /** MCP-Session-Id (or equivalent opaque transport identity). */
  readonly transportSessionId: string;
}

export interface DurableMcpEventStoreOptions extends DurableMcpEventSessionBinding {
  readonly dataDirectory?: string;
  readonly snapshotPath?: string;
  readonly journalPath?: string;
  readonly hmacKeyPath?: string;
  /** Test/integration override. Production should use the durable key file. */
  readonly hmacKey?: Uint8Array;
  /** Optional caller-selected history retention count. Omitted means no count cutoff. */
  readonly maxEvents?: number;
  /** Optional caller-selected limit for one JSON-RPC event frame, never aggregate history. */
  readonly maxEventBytes?: number;
  /** Optional caller-selected bound for each snapshot/journal file. */
  readonly maxPersistenceBytes?: number;
  readonly eventTtlMs?: number;
  readonly sessionTtlMs?: number;
  readonly tombstoneTtlMs?: number;
  readonly maxTombstones?: number;
  readonly nowUnixMs?: () => number;
}

export interface DurableMcpEventTransportRehydrateOptions {
  readonly ownerBinding: string;
  readonly surface: string;
  readonly transportSessionId: string;
  readonly dataDirectory?: string;
  readonly hmacKeyPath?: string;
  /** Test/integration override. Production should use the durable key file. */
  readonly hmacKey?: Uint8Array;
  /** Optional caller-selected history retention count. Omitted means no count cutoff. */
  readonly maxEvents?: number;
  /** Optional caller-selected limit for one JSON-RPC event frame, never aggregate history. */
  readonly maxEventBytes?: number;
  /** Optional caller-selected bound for each snapshot/journal file. */
  readonly maxPersistenceBytes?: number;
  readonly eventTtlMs?: number;
  readonly sessionTtlMs?: number;
  readonly tombstoneTtlMs?: number;
  readonly maxTombstones?: number;
  /** Optional caller-selected bound for legacy restart-time snapshot discovery. */
  readonly maxSessionFilesToScan?: number;
  /** Explicit upgrade-only fallback for snapshots created before locator indexes. */
  readonly allowLegacyMigrationScan?: boolean;
  readonly nowUnixMs?: () => number;
}

/**
 * Narrow capability returned for an unknown-session GET with Last-Event-ID.
 * It intentionally omits storeEvent/tombstoneSession and must never be placed
 * in the POST/native-tool session path.
 */
export interface DurableMcpEventReplaySession {
  readonly opaqueSessionId: string;
  getSessionMetadata(): Promise<DurableMcpEventSessionMetadata>;
  lookupEventState(eventId: EventId): Promise<DurableMcpEventLookupState>;
  getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined>;
  replayEventsAfter(
    lastEventId: EventId,
    options: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId>;
}

export interface DurableMcpEventSessionMetadata {
  /** Server-issued identity safe to use as an in-memory lookup key. */
  readonly opaqueSessionId: string;
  readonly ownerDigest: string;
  readonly surfaceDigest: string;
  readonly workSessionDigest: string;
  readonly transportSessionDigest: string;
  readonly bindingDigest: string;
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
  readonly expiresAtUnixMs?: number;
  readonly revision: number;
  readonly nextSequence: number;
  readonly retainedEventCount: number;
  readonly retainedEventBytes: number;
  readonly earliestEventId?: EventId;
  readonly latestEventId?: EventId;
}

export interface DurableMcpBufferedEvent {
  readonly id: EventId;
  readonly streamId: StreamId;
  readonly message: JSONRPCMessage;
  readonly storedAtUnixMs: number;
}

export type DurableMcpEventLookupState = "active" | "expired" | "unknown";

export class DurableMcpEventSessionNotFoundError extends Error {
  readonly code = "MCP_EVENT_SESSION_NOT_FOUND";

  constructor() {
    super("The durable MCP transport session is not known");
    this.name = "DurableMcpEventSessionNotFoundError";
  }
}

export class DurableMcpEventSessionBindingError extends Error {
  readonly code = "MCP_EVENT_SESSION_BINDING_MISMATCH";

  constructor() {
    super("The durable MCP transport session belongs to a different security boundary");
    this.name = "DurableMcpEventSessionBindingError";
  }
}

export class DurableMcpEventSessionAmbiguousError extends Error {
  readonly code = "MCP_EVENT_SESSION_AMBIGUOUS";

  constructor() {
    super("More than one durable MCP session matches the authenticated transport boundary");
    this.name = "DurableMcpEventSessionAmbiguousError";
  }
}

export class DurableMcpEventSessionExpiredError extends Error {
  readonly code = "MCP_EVENT_SESSION_EXPIRED";

  constructor() {
    super("The durable MCP transport session has expired");
    this.name = "DurableMcpEventSessionExpiredError";
  }
}

export class DurableMcpEventHistoryError extends Error {
  readonly code: "MCP_EVENT_HISTORY_EXPIRED" | "MCP_EVENT_HISTORY_UNKNOWN";

  constructor(code: "MCP_EVENT_HISTORY_EXPIRED" | "MCP_EVENT_HISTORY_UNKNOWN") {
    super(code === "MCP_EVENT_HISTORY_EXPIRED" ? "EVENT_HISTORY_EXPIRED" : "EVENT_HISTORY_UNKNOWN");
    this.name = "DurableMcpEventHistoryError";
    this.code = code;
  }
}

export class DurableMcpEventPersistenceError extends Error {
  readonly code = "MCP_EVENT_PERSISTENCE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "DurableMcpEventPersistenceError";
  }
}

interface StoredBinding {
  readonly opaqueSessionId: string;
  readonly ownerDigest: string;
  readonly surfaceDigest: string;
  readonly workSessionDigest: string;
  readonly transportSessionDigest: string;
  readonly bindingDigest: string;
}

interface StoredSessionMetadata extends StoredBinding {
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
  readonly expiresAtUnixMs?: number;
  readonly tombstonedAtUnixMs?: number;
}

interface StoredEvent {
  readonly id: EventId;
  readonly streamId: StreamId;
  readonly message: JSONRPCMessage;
  readonly storedAtUnixMs: number;
  readonly bytes: number;
}

interface StoredTombstone {
  readonly id: EventId;
  readonly removedAtUnixMs: number;
  readonly retainUntilUnixMs?: number;
  readonly reason: "count" | "bytes" | "ttl" | "session";
}

interface SnapshotPayload {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly revision: number;
  readonly sequence: number;
  readonly metadata: StoredSessionMetadata;
  readonly events: readonly StoredEvent[];
  readonly tombstones: readonly StoredTombstone[];
}

interface StoredSnapshot extends SnapshotPayload {
  readonly checksum: string;
}

interface StoredJournalRecord {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly previousRevision: number;
  readonly state: SnapshotPayload;
  readonly checksum: string;
}

interface TransportLocatorPayload {
  readonly schemaVersion: typeof LOCATOR_SCHEMA_VERSION;
  readonly locatorDigest: string;
  readonly ownerDigest: string;
  readonly surfaceDigest: string;
  readonly transportSessionDigest: string;
  readonly opaqueSessionId: string;
  readonly snapshotFileName: string;
}

interface StoredTransportLocator extends TransportLocatorPayload {
  readonly checksum: string;
}

interface ResolvedConfiguration {
  readonly dataDirectory: string;
  readonly snapshotPath: string;
  readonly journalPath: string;
  readonly locatorPath: string;
  readonly locatorDigest: string;
  readonly hmacKeyPath: string;
  readonly hmacKey: Buffer;
  readonly binding: StoredBinding;
  readonly maxEvents: number | undefined;
  /** Optional caller-selected bound for one serialized JSON-RPC event, not aggregate history. */
  readonly maxEventBytes: number | undefined;
  readonly maxPersistenceBytes: number | undefined;
  readonly eventTtlMs: number | undefined;
  readonly sessionTtlMs: number | undefined;
  readonly tombstoneTtlMs: number | undefined;
  readonly maxTombstones: number | undefined;
  readonly nowUnixMs: () => number;
}

interface TransportScanConfiguration {
  readonly dataDirectory: string;
  readonly hmacKeyPath: string;
  readonly hmacKey: Buffer;
  readonly ownerDigest: string;
  readonly surfaceDigest: string;
  readonly transportSessionDigest: string;
  readonly locatorPath: string;
  readonly locatorDigest: string;
  readonly maxEvents: number | undefined;
  readonly maxEventBytes: number | undefined;
  readonly maxPersistenceBytes: number | undefined;
  readonly eventTtlMs: number | undefined;
  readonly sessionTtlMs: number | undefined;
  readonly tombstoneTtlMs: number | undefined;
  readonly maxTombstones: number | undefined;
  readonly maxSessionFilesToScan: number | undefined;
  readonly allowLegacyMigrationScan: boolean;
  readonly nowUnixMs: () => number;
}

const EMPTY_STORED_BINDING: StoredBinding = {
  opaqueSessionId: `omes1_${"A".repeat(43)}`,
  ownerDigest: "A".repeat(43),
  surfaceDigest: "A".repeat(43),
  workSessionDigest: "A".repeat(43),
  transportSessionDigest: "A".repeat(43),
  bindingDigest: "A".repeat(43),
};

/**
 * Restart-durable MCP EventStore bound to one authenticated transport session.
 *
 * Root wiring: construct one instance per accepted MCP transport using the
 * authenticated owner, selected public surface, DurableWorkSession binding,
 * and MCP-Session-Id. Use `rehydrate` (rather than `open`) when lazily restoring
 * an already-issued transport after a daemon/runtime restart. The returned
 * instance can be passed directly to StreamableHTTPServerTransport.eventStore.
 */
export class DurableMcpEventStore implements EventStore {
  readonly #core: DurableMcpEventStoreCore;

  private constructor(core: DurableMcpEventStoreCore) {
    this.#core = core;
  }

  /** Opens an existing bound session or creates it when absent. */
  static async open(options: DurableMcpEventStoreOptions): Promise<DurableMcpEventStore> {
    return DurableMcpEventStore.#open(options, true);
  }

  /** Reopens an existing session; unknown and expired sessions fail closed. */
  static async rehydrate(options: DurableMcpEventStoreOptions): Promise<DurableMcpEventStore> {
    return DurableMcpEventStore.#open(options, false);
  }

  /**
   * Finds an old transport after a daemon restart without requiring the raw
   * work-session binding, which is not present on Last-Event-ID GET requests.
   *
   * This is exclusively a GET SSE replay capability. It authenticates the
   * owner, selected surface, and opaque transport ID through an authenticated
   * O(1) locator. A bounded global scan is available only when explicitly
   * enabled to migrate pre-index snapshots. The returned object cannot store
   * events or execute POST/native tool requests.
   */
  static async rehydrateByTransport(
    options: DurableMcpEventTransportRehydrateOptions,
  ): Promise<DurableMcpEventReplaySession> {
    const scan = await resolveTransportScanConfiguration(options);
    let locator: StoredTransportLocator | undefined;
    try {
      locator = await loadTransportLocator(scan);
    } catch (error) {
      if (!(error instanceof DurableMcpEventPersistenceError) || !scan.allowLegacyMigrationScan) {
        throw error;
      }
    }
    if (locator !== undefined) {
      try {
        return await replaySessionFromLocator(scan, locator);
      } catch (error) {
        if (error instanceof DurableMcpEventSessionExpiredError) throw error;
        if (
          !(error instanceof DurableMcpEventPersistenceError) &&
          !(error instanceof DurableMcpEventSessionNotFoundError)
        ) {
          throw error;
        }
        if (!scan.allowLegacyMigrationScan) throw error;
      }
    }
    if (!scan.allowLegacyMigrationScan) throw new DurableMcpEventSessionNotFoundError();

    const candidates = await readSessionDirectory(scan.dataDirectory, scan.maxSessionFilesToScan);
    const matches: {
      readonly state: SnapshotPayload;
      readonly configuration: ResolvedConfiguration;
    }[] = [];
    for (const candidate of candidates) {
      try {
        const snapshotPath = resolve(join(scan.dataDirectory, candidate.name));
        const provisional = configurationForScannedSession(
          scan,
          snapshotPath,
          EMPTY_STORED_BINDING,
        );
        const state = await loadStateReadOnly(provisional);
        if (state === undefined) continue;
        assertStoredBindingIntegrity(state.metadata, scan.hmacKey);
        if (`${state.metadata.opaqueSessionId}.snapshot.json` !== candidate.name) {
          throw new DurableMcpEventPersistenceError(
            "Durable MCP session snapshot filename does not match its authenticated identity",
          );
        }
        if (
          constantTimeTextEqual(state.metadata.ownerDigest, scan.ownerDigest) &&
          constantTimeTextEqual(state.metadata.surfaceDigest, scan.surfaceDigest) &&
          constantTimeTextEqual(state.metadata.transportSessionDigest, scan.transportSessionDigest)
        ) {
          matches.push({
            state,
            configuration: configurationForScannedSession(scan, snapshotPath, state.metadata),
          });
        }
      } catch (error) {
        // One damaged legacy snapshot cannot block migration of an unrelated
        // authenticated transport. Its filename remains inert and unindexed.
        if (!(error instanceof DurableMcpEventPersistenceError)) throw error;
      }
    }
    if (matches.length === 0) throw new DurableMcpEventSessionNotFoundError();
    if (matches.length !== 1) throw new DurableMcpEventSessionAmbiguousError();
    const match = matches[0];
    if (match === undefined) throw new DurableMcpEventSessionNotFoundError();
    await replaceTransportLocator(match.configuration, match.state.metadata);
    const core = await DurableMcpEventStoreCore.open(match.configuration, false);
    return new DurableMcpEventReplayView(core);
  }

  /**
   * Read-only lookup for lazy gateway session reconstruction. All four binding
   * inputs are required, so knowledge of an opaque transport ID alone cannot
   * enumerate or resume a session.
   */
  static async lookupSessionMetadata(
    options: DurableMcpEventStoreOptions,
  ): Promise<DurableMcpEventSessionMetadata | undefined> {
    const configuration = await resolveConfiguration(options, false);
    if (configuration === undefined) return undefined;
    try {
      const core = await DurableMcpEventStoreCore.open(configuration, false);
      return core.getSessionMetadata();
    } catch (error) {
      if (error instanceof DurableMcpEventSessionNotFoundError) return undefined;
      throw error;
    }
  }

  static async #open(
    options: DurableMcpEventStoreOptions,
    createIfMissing: boolean,
  ): Promise<DurableMcpEventStore> {
    const configuration = await resolveConfiguration(options, createIfMissing);
    if (configuration === undefined) throw new DurableMcpEventSessionNotFoundError();
    const core = await DurableMcpEventStoreCore.open(configuration, createIfMissing);
    return new DurableMcpEventStore(core);
  }

  get opaqueSessionId(): string {
    return this.#core.opaqueSessionId;
  }

  async getSessionMetadata(): Promise<DurableMcpEventSessionMetadata> {
    return this.#core.getSessionMetadata();
  }

  async lookupEventState(eventId: EventId): Promise<DurableMcpEventLookupState> {
    return this.#core.lookupEventState(eventId);
  }

  async tombstoneSession(): Promise<void> {
    await this.#core.tombstoneSession();
  }

  /**
   * Atomically adopts pre-binding initialize events while preserving the event
   * IDs already delivered to the MCP client. Intended only for the gateway's
   * one-time transition from its bounded bootstrap store.
   */
  async adoptBufferedEvents(events: readonly DurableMcpBufferedEvent[]): Promise<void> {
    await this.#core.adoptBufferedEvents(events);
  }

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    return this.#core.storeEvent(streamId, message);
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return this.#core.getStreamIdForEventId(eventId);
  }

  async replayEventsAfter(
    lastEventId: EventId,
    options: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    return this.#core.replayEventsAfter(lastEventId, options);
  }
}

class DurableMcpEventReplayView implements DurableMcpEventReplaySession {
  readonly #core: DurableMcpEventStoreCore;

  constructor(core: DurableMcpEventStoreCore) {
    this.#core = core;
  }

  get opaqueSessionId(): string {
    return this.#core.opaqueSessionId;
  }

  async getSessionMetadata(): Promise<DurableMcpEventSessionMetadata> {
    return this.#core.getSessionMetadata();
  }

  async lookupEventState(eventId: EventId): Promise<DurableMcpEventLookupState> {
    return this.#core.lookupEventState(eventId);
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return this.#core.getStreamIdForEventId(eventId);
  }

  async replayEventsAfter(
    lastEventId: EventId,
    options: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    return this.#core.replayEventsAfter(lastEventId, options);
  }
}

class DurableMcpEventStoreCore {
  readonly #configuration: ResolvedConfiguration;
  #state: SnapshotPayload;
  #operation: Promise<unknown> = Promise.resolve();

  private constructor(configuration: ResolvedConfiguration, state: SnapshotPayload) {
    this.#configuration = configuration;
    this.#state = state;
  }

  static async open(
    configuration: ResolvedConfiguration,
    createIfMissing: boolean,
  ): Promise<DurableMcpEventStoreCore> {
    let state = await loadState(configuration);
    let created = false;
    if (state === undefined) {
      if (!createIfMissing) throw new DurableMcpEventSessionNotFoundError();
      const now = checkedTimestamp(configuration.nowUnixMs());
      state = {
        schemaVersion: SCHEMA_VERSION,
        revision: 0,
        sequence: 0,
        metadata: {
          ...configuration.binding,
          createdAtUnixMs: now,
          updatedAtUnixMs: now,
          ...(configuration.sessionTtlMs === undefined
            ? {}
            : { expiresAtUnixMs: checkedFutureTimestamp(now, configuration.sessionTtlMs) }),
        },
        events: [],
        tombstones: [],
      };
      await writeSnapshot(configuration, state);
      await atomicWrite(configuration.journalPath, "", configuration.maxPersistenceBytes);
      created = true;
    } else {
      assertExactBinding(state.metadata, configuration.binding);
    }
    const core = new DurableMcpEventStoreCore(configuration, state);
    const now = checkedTimestamp(configuration.nowUnixMs());
    if (state.metadata.tombstonedAtUnixMs !== undefined) {
      await garbageCollectSessionFiles(configuration);
      throw new DurableMcpEventSessionExpiredError();
    }
    if (
      configuration.sessionTtlMs !== undefined &&
      state.metadata.expiresAtUnixMs !== undefined &&
      state.metadata.expiresAtUnixMs <= now
    ) {
      await core.#expireSession(now);
      throw new DurableMcpEventSessionExpiredError();
    }
    try {
      await ensureTransportLocator(configuration, state.metadata);
    } catch (error) {
      if (created) await removeSessionPayloadFiles(configuration);
      throw error;
    }
    return core;
  }

  get opaqueSessionId(): string {
    return this.#configuration.binding.opaqueSessionId;
  }

  async getSessionMetadata(): Promise<DurableMcpEventSessionMetadata> {
    return this.#exclusive(async () => {
      await this.#prepareActiveState(false);
      return metadataView(this.#state);
    });
  }

  async lookupEventState(eventId: EventId): Promise<DurableMcpEventLookupState> {
    return this.#exclusive(async () => {
      await this.#prepareActiveState(false);
      if (this.#state.events.some((event) => event.id === eventId)) return "active";
      if (this.#state.tombstones.some((tombstone) => tombstone.id === eventId)) return "expired";
      return "unknown";
    });
  }

  async tombstoneSession(): Promise<void> {
    await this.#exclusive(async () => {
      if (this.#state.metadata.tombstonedAtUnixMs !== undefined) {
        await garbageCollectSessionFiles(this.#configuration);
        return;
      }
      const now = checkedTimestamp(this.#configuration.nowUnixMs());
      const tombstones = [...this.#state.tombstones];
      for (const event of this.#state.events) {
        tombstones.push(this.#eventTombstone(event.id, now, "session"));
      }
      const next = this.#nextState({
        metadata: { ...this.#state.metadata, updatedAtUnixMs: now, tombstonedAtUnixMs: now },
        events: [],
        tombstones: this.#boundedTombstones(tombstones, now),
      });
      await this.#commit(next);
      await garbageCollectSessionFiles(this.#configuration);
    });
  }

  async adoptBufferedEvents(input: readonly DurableMcpBufferedEvent[]): Promise<void> {
    if (input.length === 0) return;
    const normalized = input.map((event) => {
      const id = requiredOpaqueText(event.id, "eventId", 256);
      const streamId = requiredOpaqueText(event.streamId, "streamId", 4_096);
      validateJsonRpcMessage(event.message);
      const bytes = Buffer.byteLength(canonicalJson(event.message), "utf8");
      if (
        this.#configuration.maxEventBytes !== undefined &&
        bytes > this.#configuration.maxEventBytes
      ) {
        throw new RangeError("MCP event exceeds the durable event byte bound");
      }
      return {
        id,
        streamId,
        message: event.message,
        storedAtUnixMs: checkedTimestamp(event.storedAtUnixMs),
        bytes,
      };
    });
    if (hasDuplicates(normalized.map((event) => event.id))) {
      throw new DurableMcpEventPersistenceError("Buffered MCP events contain duplicate IDs");
    }
    await this.#exclusive(async () => {
      await this.#prepareActiveState(false);
      const now = checkedTimestamp(this.#configuration.nowUnixMs());
      const events = [...this.#state.events];
      for (const event of normalized) {
        if (event.storedAtUnixMs > now) {
          throw new DurableMcpEventPersistenceError(
            "Buffered MCP event timestamp is later than the durable clock",
          );
        }
        if (
          this.#configuration.eventTtlMs !== undefined &&
          event.storedAtUnixMs <= now - this.#configuration.eventTtlMs
        ) {
          continue;
        }
        const existing = events.find((candidate) => candidate.id === event.id);
        if (existing !== undefined) {
          if (
            existing.streamId !== event.streamId ||
            existing.storedAtUnixMs !== event.storedAtUnixMs ||
            canonicalJson(existing.message) !== canonicalJson(event.message)
          ) {
            throw new DurableMcpEventPersistenceError(
              "Buffered MCP event ID is already bound to different content",
            );
          }
          continue;
        }
        if (this.#state.tombstones.some((tombstone) => tombstone.id === event.id)) {
          throw new DurableMcpEventPersistenceError("Buffered MCP event ID was already tombstoned");
        }
        events.push(event);
      }
      const bounded = this.#boundEvents(events, [...this.#state.tombstones], now);
      await this.#commit(
        this.#nextState({
          metadata: refreshedSessionMetadata(
            this.#state.metadata,
            now,
            this.#configuration.sessionTtlMs,
          ),
          events: bounded.events,
          tombstones: bounded.tombstones,
        }),
      );
    });
  }

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const normalizedStreamId = requiredOpaqueText(streamId, "streamId", 4_096);
    validateJsonRpcMessage(message);
    const bytes = Buffer.byteLength(canonicalJson(message), "utf8");
    if (
      this.#configuration.maxEventBytes !== undefined &&
      bytes > this.#configuration.maxEventBytes
    ) {
      throw new RangeError("MCP event exceeds the durable event byte bound");
    }
    return this.#exclusive(async () => {
      await this.#prepareActiveState(false);
      const now = checkedTimestamp(this.#configuration.nowUnixMs());
      const sequence = checkedSequence(this.#state.sequence + 1);
      const id = eventIdFor(
        this.#configuration.hmacKey,
        this.#state.metadata.bindingDigest,
        sequence,
      );
      const events = [
        ...this.#state.events,
        { id, streamId: normalizedStreamId, message, storedAtUnixMs: now, bytes },
      ];
      const bounded = this.#boundEvents(events, [...this.#state.tombstones], now);
      const next = this.#nextState({
        sequence,
        metadata: refreshedSessionMetadata(
          this.#state.metadata,
          now,
          this.#configuration.sessionTtlMs,
        ),
        events: bounded.events,
        tombstones: bounded.tombstones,
      });
      await this.#commit(next);
      return id;
    });
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    requiredOpaqueText(eventId, "eventId", 256);
    return this.#exclusive(async () => {
      await this.#prepareActiveState(false);
      return this.#state.events.find((event) => event.id === eventId)?.streamId;
    });
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    requiredOpaqueText(lastEventId, "lastEventId", 256);
    const replay = await this.#exclusive(async () => {
      await this.#prepareActiveState(true);
      const eventIndex = this.#state.events.findIndex((event) => event.id === lastEventId);
      if (eventIndex < 0) {
        const expired = this.#state.tombstones.some((item) => item.id === lastEventId);
        throw new DurableMcpEventHistoryError(
          expired ? "MCP_EVENT_HISTORY_EXPIRED" : "MCP_EVENT_HISTORY_UNKNOWN",
        );
      }
      const anchor = this.#state.events[eventIndex];
      if (anchor === undefined) throw new DurableMcpEventHistoryError("MCP_EVENT_HISTORY_UNKNOWN");
      return {
        streamId: anchor.streamId,
        events: this.#state.events
          .slice(eventIndex + 1)
          .filter((event) => event.streamId === anchor.streamId)
          .map((event) => ({ id: event.id, message: event.message })),
      };
    });
    for (const event of replay.events) await send(event.id, event.message);
    return replay.streamId;
  }

  async #prepareActiveState(extendSession: boolean): Promise<void> {
    const now = checkedTimestamp(this.#configuration.nowUnixMs());
    if (this.#state.metadata.tombstonedAtUnixMs !== undefined) {
      await garbageCollectSessionFiles(this.#configuration);
      throw new DurableMcpEventSessionExpiredError();
    }
    if (
      this.#configuration.sessionTtlMs !== undefined &&
      this.#state.metadata.expiresAtUnixMs !== undefined &&
      this.#state.metadata.expiresAtUnixMs <= now
    ) {
      await this.#expireSession(now);
      throw new DurableMcpEventSessionExpiredError();
    }
    const events: StoredEvent[] = [];
    const tombstones = [...this.#state.tombstones];
    for (const event of this.#state.events) {
      if (
        this.#configuration.eventTtlMs !== undefined &&
        event.storedAtUnixMs <= now - this.#configuration.eventTtlMs
      ) {
        tombstones.push(this.#eventTombstone(event.id, now, "ttl"));
      } else {
        events.push(event);
      }
    }
    const boundedTombstones = this.#boundedTombstones(tombstones, now);
    const pruned = events.length !== this.#state.events.length;
    const tombstonesChanged =
      canonicalJson(boundedTombstones) !== canonicalJson(this.#state.tombstones);
    if (!pruned && !tombstonesChanged && !extendSession) return;
    const metadata = extendSession
      ? refreshedSessionMetadata(this.#state.metadata, now, this.#configuration.sessionTtlMs)
      : this.#state.metadata;
    await this.#commit(this.#nextState({ metadata, events, tombstones: boundedTombstones }));
  }

  async #expireSession(now: number): Promise<void> {
    const tombstones = [...this.#state.tombstones];
    for (const event of this.#state.events) {
      tombstones.push(this.#eventTombstone(event.id, now, "session"));
    }
    await this.#commit(
      this.#nextState({
        metadata: { ...this.#state.metadata, updatedAtUnixMs: now, tombstonedAtUnixMs: now },
        events: [],
        tombstones: this.#boundedTombstones(tombstones, now),
      }),
    );
    await garbageCollectSessionFiles(this.#configuration);
  }

  #boundEvents(
    inputEvents: StoredEvent[],
    inputTombstones: StoredTombstone[],
    now: number,
  ): { readonly events: readonly StoredEvent[]; readonly tombstones: readonly StoredTombstone[] } {
    const events = [...inputEvents];
    const tombstones = [...inputTombstones];
    while (
      this.#configuration.maxEvents !== undefined &&
      events.length > this.#configuration.maxEvents
    ) {
      const removed = events.shift();
      if (removed === undefined) break;
      tombstones.push(this.#eventTombstone(removed.id, now, "count"));
    }
    return { events, tombstones: this.#boundedTombstones(tombstones, now) };
  }

  #boundedTombstones(input: readonly StoredTombstone[], now: number): readonly StoredTombstone[] {
    const byId = new Map<EventId, StoredTombstone>();
    for (const tombstone of input) {
      if (
        this.#configuration.tombstoneTtlMs === undefined ||
        tombstone.retainUntilUnixMs === undefined ||
        tombstone.retainUntilUnixMs > now
      ) {
        byId.set(tombstone.id, tombstone);
      }
    }
    const ordered = [...byId.values()].sort(
      (left, right) => left.removedAtUnixMs - right.removedAtUnixMs,
    );
    return this.#configuration.maxTombstones === undefined
      ? ordered
      : ordered.slice(-this.#configuration.maxTombstones);
  }

  #eventTombstone(id: EventId, now: number, reason: StoredTombstone["reason"]): StoredTombstone {
    return {
      id,
      removedAtUnixMs: now,
      ...(this.#configuration.tombstoneTtlMs === undefined
        ? {}
        : {
            retainUntilUnixMs: checkedFutureTimestamp(now, this.#configuration.tombstoneTtlMs),
          }),
      reason,
    };
  }

  #nextState(
    changes: Partial<Omit<SnapshotPayload, "schemaVersion" | "revision">>,
  ): SnapshotPayload {
    return {
      schemaVersion: SCHEMA_VERSION,
      revision: checkedRevision(this.#state.revision + 1),
      sequence: changes.sequence ?? this.#state.sequence,
      metadata: changes.metadata ?? this.#state.metadata,
      events: changes.events ?? this.#state.events,
      tombstones: changes.tombstones ?? this.#state.tombstones,
    };
  }

  async #commit(next: SnapshotPayload): Promise<void> {
    const journal: StoredJournalRecord = {
      schemaVersion: SCHEMA_VERSION,
      previousRevision: this.#state.revision,
      state: next,
      checksum: persistenceChecksum(this.#configuration.hmacKey, "journal", {
        schemaVersion: SCHEMA_VERSION,
        previousRevision: this.#state.revision,
        state: next,
      }),
    };
    await atomicWrite(
      this.#configuration.journalPath,
      `${canonicalJson(journal)}\n`,
      this.#configuration.maxPersistenceBytes,
    );
    await writeSnapshot(this.#configuration, next);
    await atomicWrite(this.#configuration.journalPath, "", this.#configuration.maxPersistenceBytes);
    this.#state = next;
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.#operation.then(operation, operation);
    this.#operation = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }
}

async function resolveTransportScanConfiguration(
  options: DurableMcpEventTransportRehydrateOptions,
): Promise<TransportScanConfiguration> {
  const dataDirectory = resolve(
    options.dataDirectory ?? join(omniCodexDataDirectory(), "durable-mcp-events"),
  );
  const hmacKeyPath = resolve(options.hmacKeyPath ?? join(dataDirectory, "hmac.key"));
  const hmacKey =
    options.hmacKey === undefined
      ? await loadHmacKey(hmacKeyPath, false)
      : validatedHmacKey(options.hmacKey);
  if (hmacKey === undefined) throw new DurableMcpEventSessionNotFoundError();
  const ownerBinding = requiredOwnerBinding(options.ownerBinding);
  const surface = requiredOpaqueText(options.surface, "surface", 256);
  const transportSessionId = requiredOpaqueText(
    options.transportSessionId,
    "transportSessionId",
    4_096,
  );
  const ownerDigest = keyedDigest(hmacKey, "owner", ownerBinding);
  const surfaceDigest = keyedDigest(hmacKey, "surface", surface);
  const transportSessionDigest = keyedDigest(hmacKey, "transport-session", transportSessionId);
  const locatorDigest = transportLocatorDigest(
    hmacKey,
    ownerDigest,
    surfaceDigest,
    transportSessionDigest,
  );
  return {
    dataDirectory,
    hmacKeyPath,
    hmacKey,
    ownerDigest,
    surfaceDigest,
    transportSessionDigest,
    locatorPath: locatorPathFor(dataDirectory, locatorDigest),
    locatorDigest,
    maxEvents: optionalPositiveInteger(options.maxEvents, "maxEvents"),
    maxEventBytes: optionalPositiveInteger(options.maxEventBytes, "maxEventBytes"),
    maxPersistenceBytes: optionalPositiveInteger(
      options.maxPersistenceBytes,
      "maxPersistenceBytes",
    ),
    eventTtlMs: optionalPositiveInteger(options.eventTtlMs, "eventTtlMs"),
    sessionTtlMs: optionalPositiveInteger(options.sessionTtlMs, "sessionTtlMs"),
    tombstoneTtlMs: optionalPositiveInteger(options.tombstoneTtlMs, "tombstoneTtlMs"),
    maxTombstones: optionalPositiveInteger(options.maxTombstones, "maxTombstones"),
    maxSessionFilesToScan: optionalPositiveInteger(
      options.maxSessionFilesToScan,
      "maxSessionFilesToScan",
    ),
    allowLegacyMigrationScan: options.allowLegacyMigrationScan === true,
    nowUnixMs: options.nowUnixMs ?? Date.now,
  };
}

function configurationForScannedSession(
  scan: TransportScanConfiguration,
  snapshotPath: string,
  binding: StoredBinding,
): ResolvedConfiguration {
  return {
    dataDirectory: scan.dataDirectory,
    snapshotPath,
    journalPath: `${snapshotPath}.journal`,
    locatorPath: scan.locatorPath,
    locatorDigest: scan.locatorDigest,
    hmacKeyPath: scan.hmacKeyPath,
    hmacKey: scan.hmacKey,
    binding,
    maxEvents: scan.maxEvents,
    maxEventBytes: scan.maxEventBytes,
    maxPersistenceBytes: scan.maxPersistenceBytes,
    eventTtlMs: scan.eventTtlMs,
    sessionTtlMs: scan.sessionTtlMs,
    tombstoneTtlMs: scan.tombstoneTtlMs,
    maxTombstones: scan.maxTombstones,
    nowUnixMs: scan.nowUnixMs,
  };
}

async function replaySessionFromLocator(
  scan: TransportScanConfiguration,
  locator: StoredTransportLocator,
): Promise<DurableMcpEventReplaySession> {
  const snapshotPath = localSnapshotPath(scan.dataDirectory, locator.snapshotFileName);
  const provisional = configurationForScannedSession(scan, snapshotPath, EMPTY_STORED_BINDING);
  const state = await loadStateReadOnly(provisional);
  if (state === undefined) {
    await removeLocatorFile(scan.locatorPath);
    throw new DurableMcpEventSessionNotFoundError();
  }
  assertStoredBindingIntegrity(state.metadata, scan.hmacKey);
  assertLocatorTarget(locator, state.metadata, scan);
  const configuration = configurationForScannedSession(scan, snapshotPath, state.metadata);
  const core = await DurableMcpEventStoreCore.open(configuration, false);
  return new DurableMcpEventReplayView(core);
}

async function loadTransportLocator(
  scan: TransportScanConfiguration,
): Promise<StoredTransportLocator | undefined> {
  const locator = await readTransportLocator(scan.locatorPath, scan.hmacKey);
  if (locator === undefined) return undefined;
  if (
    !constantTimeTextEqual(locator.locatorDigest, scan.locatorDigest) ||
    !constantTimeTextEqual(locator.ownerDigest, scan.ownerDigest) ||
    !constantTimeTextEqual(locator.surfaceDigest, scan.surfaceDigest) ||
    !constantTimeTextEqual(locator.transportSessionDigest, scan.transportSessionDigest)
  ) {
    throw new DurableMcpEventPersistenceError(
      "Durable MCP transport locator does not match its lookup boundary",
    );
  }
  return locator;
}

async function ensureTransportLocator(
  configuration: ResolvedConfiguration,
  metadata: StoredSessionMetadata,
): Promise<void> {
  const payload = transportLocatorPayload(configuration, metadata);
  if (payload === undefined) return;
  const stored = await readTransportLocator(configuration.locatorPath, configuration.hmacKey);
  if (stored !== undefined) {
    assertSameTransportLocator(stored, payload);
    return;
  }
  const locator = storedTransportLocator(configuration.hmacKey, payload);
  try {
    await atomicCreate(configuration.locatorPath, `${canonicalJson(locator)}\n`, MAX_LOCATOR_BYTES);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const raced = await readTransportLocator(configuration.locatorPath, configuration.hmacKey);
    if (raced === undefined) {
      throw new DurableMcpEventPersistenceError(
        "Durable MCP transport locator creation raced without an index",
      );
    }
    assertSameTransportLocator(raced, payload);
  }
}

async function replaceTransportLocator(
  configuration: ResolvedConfiguration,
  metadata: StoredSessionMetadata,
): Promise<void> {
  const payload = transportLocatorPayload(configuration, metadata);
  if (payload === undefined) return;
  const locator = storedTransportLocator(configuration.hmacKey, payload);
  await atomicWrite(configuration.locatorPath, `${canonicalJson(locator)}\n`, MAX_LOCATOR_BYTES);
}

function transportLocatorPayload(
  configuration: ResolvedConfiguration,
  metadata: StoredSessionMetadata,
): TransportLocatorPayload | undefined {
  if (dirname(configuration.snapshotPath) !== configuration.dataDirectory) return undefined;
  assertExactBinding(metadata, configuration.binding);
  return {
    schemaVersion: LOCATOR_SCHEMA_VERSION,
    locatorDigest: configuration.locatorDigest,
    ownerDigest: metadata.ownerDigest,
    surfaceDigest: metadata.surfaceDigest,
    transportSessionDigest: metadata.transportSessionDigest,
    opaqueSessionId: metadata.opaqueSessionId,
    snapshotFileName: basename(configuration.snapshotPath),
  };
}

function storedTransportLocator(
  hmacKey: Buffer,
  payload: TransportLocatorPayload,
): StoredTransportLocator {
  return {
    ...payload,
    checksum: persistenceChecksum(hmacKey, "locator", payload),
  };
}

async function readTransportLocator(
  path: string,
  hmacKey: Buffer,
): Promise<StoredTransportLocator | undefined> {
  const raw = await readBoundedFile(path, MAX_LOCATOR_BYTES);
  if (raw === undefined) return undefined;
  const value = parseJson(raw, "Durable MCP transport locator is not valid JSON");
  const locator = parseTransportLocator(value);
  const expected = persistenceChecksum(hmacKey, "locator", locator);
  if (!constantTimeTextEqual(locator.checksum, expected)) {
    throw new DurableMcpEventPersistenceError("Durable MCP transport locator checksum mismatch");
  }
  return locator;
}

function parseTransportLocator(value: unknown): StoredTransportLocator {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "locatorDigest",
      "ownerDigest",
      "surfaceDigest",
      "transportSessionDigest",
      "opaqueSessionId",
      "snapshotFileName",
      "checksum",
    ]) ||
    value.schemaVersion !== LOCATOR_SCHEMA_VERSION ||
    !validDigest(value.locatorDigest) ||
    !validDigest(value.ownerDigest) ||
    !validDigest(value.surfaceDigest) ||
    !validDigest(value.transportSessionDigest) ||
    typeof value.opaqueSessionId !== "string" ||
    !/^omes1_[A-Za-z0-9_-]{43}$/.test(value.opaqueSessionId) ||
    typeof value.snapshotFileName !== "string" ||
    !validLocalFileName(value.snapshotFileName) ||
    typeof value.checksum !== "string" ||
    !validDigest(value.checksum)
  ) {
    throw new DurableMcpEventPersistenceError("Durable MCP transport locator is invalid");
  }
  return {
    schemaVersion: LOCATOR_SCHEMA_VERSION,
    locatorDigest: value.locatorDigest,
    ownerDigest: value.ownerDigest,
    surfaceDigest: value.surfaceDigest,
    transportSessionDigest: value.transportSessionDigest,
    opaqueSessionId: value.opaqueSessionId,
    snapshotFileName: value.snapshotFileName,
    checksum: value.checksum,
  };
}

function assertSameTransportLocator(
  actual: StoredTransportLocator,
  expected: TransportLocatorPayload,
): void {
  if (
    !constantTimeTextEqual(actual.locatorDigest, expected.locatorDigest) ||
    !constantTimeTextEqual(actual.ownerDigest, expected.ownerDigest) ||
    !constantTimeTextEqual(actual.surfaceDigest, expected.surfaceDigest) ||
    !constantTimeTextEqual(actual.transportSessionDigest, expected.transportSessionDigest) ||
    !constantTimeTextEqual(actual.opaqueSessionId, expected.opaqueSessionId) ||
    actual.snapshotFileName !== expected.snapshotFileName
  ) {
    throw new DurableMcpEventSessionAmbiguousError();
  }
}

function assertLocatorTarget(
  locator: StoredTransportLocator,
  metadata: StoredSessionMetadata,
  scan: TransportScanConfiguration,
): void {
  if (
    !constantTimeTextEqual(locator.opaqueSessionId, metadata.opaqueSessionId) ||
    !constantTimeTextEqual(locator.ownerDigest, metadata.ownerDigest) ||
    !constantTimeTextEqual(locator.surfaceDigest, metadata.surfaceDigest) ||
    !constantTimeTextEqual(locator.transportSessionDigest, metadata.transportSessionDigest) ||
    !constantTimeTextEqual(metadata.ownerDigest, scan.ownerDigest) ||
    !constantTimeTextEqual(metadata.surfaceDigest, scan.surfaceDigest) ||
    !constantTimeTextEqual(metadata.transportSessionDigest, scan.transportSessionDigest)
  ) {
    throw new DurableMcpEventPersistenceError(
      "Durable MCP transport locator target does not match its authenticated snapshot",
    );
  }
}

function validLocalFileName(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 255 &&
    value !== "." &&
    value !== ".." &&
    basename(value) === value &&
    !/[\0\r\n]/.test(value)
  );
}

function localSnapshotPath(dataDirectory: string, snapshotFileName: string): string {
  if (!validLocalFileName(snapshotFileName)) {
    throw new DurableMcpEventPersistenceError(
      "Durable MCP transport locator snapshot filename is invalid",
    );
  }
  const snapshotPath = resolve(join(dataDirectory, snapshotFileName));
  if (dirname(snapshotPath) !== dataDirectory) {
    throw new DurableMcpEventPersistenceError(
      "Durable MCP transport locator snapshot escapes its data directory",
    );
  }
  return snapshotPath;
}

async function garbageCollectSessionFiles(configuration: ResolvedConfiguration): Promise<void> {
  try {
    const locator = await readTransportLocator(configuration.locatorPath, configuration.hmacKey);
    if (
      locator === undefined ||
      constantTimeTextEqual(locator.opaqueSessionId, configuration.binding.opaqueSessionId)
    ) {
      await removeLocatorFile(configuration.locatorPath);
    }
  } catch (error) {
    if (!(error instanceof DurableMcpEventPersistenceError)) throw error;
    await removeLocatorFile(configuration.locatorPath);
  }
  await removeSessionPayloadFiles(configuration);
}

async function removeSessionPayloadFiles(configuration: ResolvedConfiguration): Promise<void> {
  await rm(configuration.journalPath, { force: true });
  await rm(configuration.snapshotPath, { force: true });
}

async function removeLocatorFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

async function readSessionDirectory(
  path: string,
  maxSessionFiles: number | undefined,
): Promise<Dirent[]> {
  let directory: Awaited<ReturnType<typeof opendir>>;
  try {
    directory = await opendir(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const snapshots: Dirent[] = [];
  try {
    for await (const entry of directory) {
      if (entry.isFile() && /^omes1_[A-Za-z0-9_-]{43}\.snapshot\.json$/.test(entry.name)) {
        snapshots.push(entry);
        if (maxSessionFiles !== undefined && snapshots.length > maxSessionFiles) {
          throw new DurableMcpEventPersistenceError(
            "Durable MCP session discovery exceeds its bounded scan limit",
          );
        }
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return snapshots.sort((left, right) => left.name.localeCompare(right.name, "en"));
}

async function resolveConfiguration(
  options: DurableMcpEventStoreOptions,
  createKey: boolean,
): Promise<ResolvedConfiguration | undefined> {
  const dataDirectory = resolve(
    options.dataDirectory ?? join(omniCodexDataDirectory(), "durable-mcp-events"),
  );
  const hmacKeyPath = resolve(options.hmacKeyPath ?? join(dataDirectory, "hmac.key"));
  const hmacKey =
    options.hmacKey === undefined
      ? await loadHmacKey(hmacKeyPath, createKey)
      : validatedHmacKey(options.hmacKey);
  if (hmacKey === undefined) return undefined;
  const rawBinding = {
    ownerBinding: requiredOwnerBinding(options.ownerBinding),
    surface: requiredOpaqueText(options.surface, "surface", 256),
    workSessionBinding: requiredOpaqueText(options.workSessionBinding, "workSessionBinding", 4_096),
    transportSessionId: requiredOpaqueText(options.transportSessionId, "transportSessionId", 4_096),
  };
  const ownerDigest = keyedDigest(hmacKey, "owner", rawBinding.ownerBinding);
  const surfaceDigest = keyedDigest(hmacKey, "surface", rawBinding.surface);
  const workSessionDigest = keyedDigest(hmacKey, "work-session", rawBinding.workSessionBinding);
  const transportSessionDigest = keyedDigest(
    hmacKey,
    "transport-session",
    rawBinding.transportSessionId,
  );
  const bindingDigest = keyedDigest(
    hmacKey,
    "binding",
    lengthPrefixed(ownerDigest, surfaceDigest, workSessionDigest, transportSessionDigest),
  );
  const binding: StoredBinding = {
    opaqueSessionId: `omes1_${keyedDigest(hmacKey, "opaque-session", bindingDigest)}`,
    ownerDigest,
    surfaceDigest,
    workSessionDigest,
    transportSessionDigest,
    bindingDigest,
  };
  const locatorDigest = transportLocatorDigest(
    hmacKey,
    ownerDigest,
    surfaceDigest,
    transportSessionDigest,
  );
  const snapshotPath = resolve(
    options.snapshotPath ?? join(dataDirectory, `${binding.opaqueSessionId}.snapshot.json`),
  );
  return {
    dataDirectory,
    snapshotPath,
    journalPath: resolve(options.journalPath ?? `${snapshotPath}.journal`),
    locatorPath: locatorPathFor(dataDirectory, locatorDigest),
    locatorDigest,
    hmacKeyPath,
    hmacKey,
    binding,
    maxEvents: optionalPositiveInteger(options.maxEvents, "maxEvents"),
    maxEventBytes: optionalPositiveInteger(options.maxEventBytes, "maxEventBytes"),
    maxPersistenceBytes: optionalPositiveInteger(
      options.maxPersistenceBytes,
      "maxPersistenceBytes",
    ),
    eventTtlMs: optionalPositiveInteger(options.eventTtlMs, "eventTtlMs"),
    sessionTtlMs: optionalPositiveInteger(options.sessionTtlMs, "sessionTtlMs"),
    tombstoneTtlMs: optionalPositiveInteger(options.tombstoneTtlMs, "tombstoneTtlMs"),
    maxTombstones: optionalPositiveInteger(options.maxTombstones, "maxTombstones"),
    nowUnixMs: options.nowUnixMs ?? Date.now,
  };
}

async function loadState(
  configuration: ResolvedConfiguration,
): Promise<SnapshotPayload | undefined> {
  const snapshot = await loadSnapshot(configuration);
  const journal = await loadJournal(configuration);
  if (snapshot === undefined) {
    if (journal !== undefined) {
      if (journal.previousRevision !== 0 || journal.state.revision !== 1) {
        throw new DurableMcpEventPersistenceError("MCP event journal has no valid snapshot base");
      }
      await writeSnapshot(configuration, journal.state);
      await atomicWrite(configuration.journalPath, "", configuration.maxPersistenceBytes);
      return journal.state;
    }
    return undefined;
  }
  if (journal === undefined) return snapshot;
  if (journal.state.revision <= snapshot.revision) {
    await atomicWrite(configuration.journalPath, "", configuration.maxPersistenceBytes);
    return snapshot;
  }
  if (
    journal.previousRevision !== snapshot.revision ||
    journal.state.revision !== snapshot.revision + 1
  ) {
    throw new DurableMcpEventPersistenceError("MCP event journal revision is not contiguous");
  }
  await writeSnapshot(configuration, journal.state);
  await atomicWrite(configuration.journalPath, "", configuration.maxPersistenceBytes);
  return journal.state;
}

/** Resolves a crash journal without mutating any candidate during directory discovery. */
async function loadStateReadOnly(
  configuration: ResolvedConfiguration,
): Promise<SnapshotPayload | undefined> {
  const snapshot = await loadSnapshot(configuration);
  const journal = await loadJournal(configuration);
  if (snapshot === undefined) {
    if (journal === undefined) return undefined;
    if (journal.previousRevision !== 0 || journal.state.revision !== 1) {
      throw new DurableMcpEventPersistenceError("MCP event journal has no valid snapshot base");
    }
    return journal.state;
  }
  if (journal === undefined || journal.state.revision <= snapshot.revision) return snapshot;
  if (
    journal.previousRevision !== snapshot.revision ||
    journal.state.revision !== snapshot.revision + 1
  ) {
    throw new DurableMcpEventPersistenceError("MCP event journal revision is not contiguous");
  }
  return journal.state;
}

async function loadSnapshot(
  configuration: ResolvedConfiguration,
): Promise<SnapshotPayload | undefined> {
  const raw = await readSnapshotFile(configuration.snapshotPath, configuration.maxPersistenceBytes);
  if (raw === undefined) return undefined;
  const value = parseJson(raw, "MCP event snapshot is not valid JSON");
  const snapshot = parseSnapshot(value, configuration);
  const expected = persistenceChecksum(configuration.hmacKey, "snapshot", snapshot);
  if (!constantTimeTextEqual(snapshot.checksum, expected)) {
    throw new DurableMcpEventPersistenceError("MCP event snapshot checksum mismatch");
  }
  return snapshot;
}

async function loadJournal(
  configuration: ResolvedConfiguration,
): Promise<StoredJournalRecord | undefined> {
  const raw = await readBoundedFile(configuration.journalPath, configuration.maxPersistenceBytes);
  if (raw === undefined || raw.length === 0) return undefined;
  if (!raw.endsWith("\n") || raw.slice(0, -1).includes("\n")) {
    throw new DurableMcpEventPersistenceError(
      "MCP event journal is incomplete or has extra records",
    );
  }
  const value = parseJson(raw, "MCP event journal is not valid JSON");
  const journal = parseJournal(value, configuration);
  const expected = persistenceChecksum(configuration.hmacKey, "journal", journal);
  if (!constantTimeTextEqual(journal.checksum, expected)) {
    throw new DurableMcpEventPersistenceError("MCP event journal checksum mismatch");
  }
  return journal;
}

function parseSnapshot(value: unknown, configuration: ResolvedConfiguration): StoredSnapshot {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "revision",
      "sequence",
      "metadata",
      "events",
      "tombstones",
      "checksum",
    ])
  )
    throw new DurableMcpEventPersistenceError("MCP event snapshot envelope is invalid");
  const payload = parsePayload(value, configuration);
  if (typeof value.checksum !== "string" || !validDigest(value.checksum)) {
    throw new DurableMcpEventPersistenceError("MCP event snapshot checksum is invalid");
  }
  return { ...payload, checksum: value.checksum };
}

function parseJournal(value: unknown, configuration: ResolvedConfiguration): StoredJournalRecord {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["schemaVersion", "previousRevision", "state", "checksum"]) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    !validRevision(value.previousRevision) ||
    !isRecord(value.state) ||
    typeof value.checksum !== "string" ||
    !validDigest(value.checksum)
  )
    throw new DurableMcpEventPersistenceError("MCP event journal envelope is invalid");
  return {
    schemaVersion: SCHEMA_VERSION,
    previousRevision: value.previousRevision,
    state: parsePayload(value.state, configuration),
    checksum: value.checksum,
  };
}

function parsePayload(
  value: Record<string, unknown>,
  configuration: ResolvedConfiguration,
): SnapshotPayload {
  if (
    value.schemaVersion !== SCHEMA_VERSION ||
    !validRevision(value.revision) ||
    !validRevision(value.sequence) ||
    !isRecord(value.metadata) ||
    !Array.isArray(value.events) ||
    (configuration.maxEvents !== undefined && value.events.length > configuration.maxEvents) ||
    !Array.isArray(value.tombstones) ||
    (configuration.maxTombstones !== undefined &&
      value.tombstones.length > configuration.maxTombstones)
  )
    throw new DurableMcpEventPersistenceError("MCP event state is invalid");
  const metadata = parseMetadata(value.metadata);
  const events = value.events.map((event) => parseEvent(event, configuration.maxEventBytes));
  const tombstones = value.tombstones.map(parseTombstone);
  if (
    hasDuplicates(events.map((event) => event.id)) ||
    hasDuplicates(tombstones.map((item) => item.id))
  ) {
    throw new DurableMcpEventPersistenceError("MCP event state contains duplicate event IDs");
  }
  if (events.some((event) => tombstones.some((item) => item.id === event.id))) {
    throw new DurableMcpEventPersistenceError("MCP event is both active and tombstoned");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: value.revision,
    sequence: value.sequence,
    metadata,
    events,
    tombstones,
  };
}

function parseMetadata(value: Record<string, unknown>): StoredSessionMetadata {
  const allowed = [
    "opaqueSessionId",
    "ownerDigest",
    "surfaceDigest",
    "workSessionDigest",
    "transportSessionDigest",
    "bindingDigest",
    "createdAtUnixMs",
    "updatedAtUnixMs",
    ...(value.expiresAtUnixMs === undefined ? [] : ["expiresAtUnixMs"]),
    ...(value.tombstonedAtUnixMs === undefined ? [] : ["tombstonedAtUnixMs"]),
  ];
  if (
    !hasOnlyKeys(value, allowed) ||
    typeof value.opaqueSessionId !== "string" ||
    !/^omes1_[A-Za-z0-9_-]{43}$/.test(value.opaqueSessionId) ||
    !validDigest(value.ownerDigest) ||
    !validDigest(value.surfaceDigest) ||
    !validDigest(value.workSessionDigest) ||
    !validDigest(value.transportSessionDigest) ||
    !validDigest(value.bindingDigest) ||
    !validTimestamp(value.createdAtUnixMs) ||
    !validTimestamp(value.updatedAtUnixMs) ||
    (value.expiresAtUnixMs !== undefined && !validTimestamp(value.expiresAtUnixMs)) ||
    (value.tombstonedAtUnixMs !== undefined && !validTimestamp(value.tombstonedAtUnixMs))
  )
    throw new DurableMcpEventPersistenceError("MCP event session metadata is invalid");
  return {
    opaqueSessionId: value.opaqueSessionId,
    ownerDigest: value.ownerDigest,
    surfaceDigest: value.surfaceDigest,
    workSessionDigest: value.workSessionDigest,
    transportSessionDigest: value.transportSessionDigest,
    bindingDigest: value.bindingDigest,
    createdAtUnixMs: value.createdAtUnixMs,
    updatedAtUnixMs: value.updatedAtUnixMs,
    ...(value.expiresAtUnixMs === undefined ? {} : { expiresAtUnixMs: value.expiresAtUnixMs }),
    ...(value.tombstonedAtUnixMs === undefined
      ? {}
      : { tombstonedAtUnixMs: value.tombstonedAtUnixMs }),
  };
}

function parseEvent(value: unknown, maxEventBytes: number | undefined): StoredEvent {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "streamId", "message", "storedAtUnixMs", "bytes"]) ||
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    value.id.length > 256 ||
    /[\0\r\n]/.test(value.id) ||
    typeof value.streamId !== "string" ||
    value.streamId.length < 1 ||
    value.streamId.length > 4_096 ||
    !validTimestamp(value.storedAtUnixMs) ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 1 ||
    !isRecord(value.message)
  )
    throw new DurableMcpEventPersistenceError("MCP event record is invalid");
  validateJsonRpcMessage(value.message);
  const actualBytes = Buffer.byteLength(canonicalJson(value.message), "utf8");
  if (actualBytes !== value.bytes) {
    throw new DurableMcpEventPersistenceError("MCP event byte accounting is invalid");
  }
  if (maxEventBytes !== undefined && actualBytes > maxEventBytes) {
    throw new DurableMcpEventPersistenceError("MCP event exceeds its configured frame byte bound");
  }
  return {
    id: value.id,
    streamId: value.streamId,
    message: value.message,
    storedAtUnixMs: value.storedAtUnixMs,
    bytes: value.bytes,
  };
}

function parseTombstone(value: unknown): StoredTombstone {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "removedAtUnixMs",
      ...(value.retainUntilUnixMs === undefined ? [] : ["retainUntilUnixMs"]),
      "reason",
    ]) ||
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    value.id.length > 256 ||
    /[\0\r\n]/.test(value.id) ||
    !validTimestamp(value.removedAtUnixMs) ||
    (value.retainUntilUnixMs !== undefined && !validTimestamp(value.retainUntilUnixMs)) ||
    !["count", "bytes", "ttl", "session"].includes(String(value.reason))
  )
    throw new DurableMcpEventPersistenceError("MCP event tombstone is invalid");
  return {
    id: value.id,
    removedAtUnixMs: value.removedAtUnixMs,
    ...(value.retainUntilUnixMs === undefined
      ? {}
      : { retainUntilUnixMs: value.retainUntilUnixMs }),
    reason: value.reason as StoredTombstone["reason"],
  };
}

function metadataView(state: SnapshotPayload): DurableMcpEventSessionMetadata {
  const bytes = state.events.reduce((total, event) => total + event.bytes, 0);
  const earliest = state.events[0];
  const latest = state.events.at(-1);
  return {
    opaqueSessionId: state.metadata.opaqueSessionId,
    ownerDigest: state.metadata.ownerDigest,
    surfaceDigest: state.metadata.surfaceDigest,
    workSessionDigest: state.metadata.workSessionDigest,
    transportSessionDigest: state.metadata.transportSessionDigest,
    bindingDigest: state.metadata.bindingDigest,
    createdAtUnixMs: state.metadata.createdAtUnixMs,
    updatedAtUnixMs: state.metadata.updatedAtUnixMs,
    ...(state.metadata.expiresAtUnixMs === undefined
      ? {}
      : { expiresAtUnixMs: state.metadata.expiresAtUnixMs }),
    revision: state.revision,
    nextSequence: state.sequence + 1,
    retainedEventCount: state.events.length,
    retainedEventBytes: bytes,
    ...(earliest === undefined ? {} : { earliestEventId: earliest.id }),
    ...(latest === undefined ? {} : { latestEventId: latest.id }),
  };
}

function refreshedSessionMetadata(
  metadata: StoredSessionMetadata,
  now: number,
  sessionTtlMs: number | undefined,
): StoredSessionMetadata {
  const { expiresAtUnixMs: _previousExpiry, ...withoutExpiry } = metadata;
  return {
    ...withoutExpiry,
    updatedAtUnixMs: now,
    ...(sessionTtlMs === undefined
      ? {}
      : { expiresAtUnixMs: checkedFutureTimestamp(now, sessionTtlMs) }),
  };
}

function assertExactBinding(actual: StoredBinding, expected: StoredBinding): void {
  const fields: (keyof StoredBinding)[] = [
    "opaqueSessionId",
    "ownerDigest",
    "surfaceDigest",
    "workSessionDigest",
    "transportSessionDigest",
    "bindingDigest",
  ];
  if (fields.some((field) => !constantTimeTextEqual(actual[field], expected[field]))) {
    throw new DurableMcpEventSessionBindingError();
  }
}

function assertStoredBindingIntegrity(binding: StoredBinding, hmacKey: Buffer): void {
  const expectedBindingDigest = keyedDigest(
    hmacKey,
    "binding",
    lengthPrefixed(
      binding.ownerDigest,
      binding.surfaceDigest,
      binding.workSessionDigest,
      binding.transportSessionDigest,
    ),
  );
  const expectedOpaqueSessionId = `omes1_${keyedDigest(
    hmacKey,
    "opaque-session",
    expectedBindingDigest,
  )}`;
  if (
    !constantTimeTextEqual(binding.bindingDigest, expectedBindingDigest) ||
    !constantTimeTextEqual(binding.opaqueSessionId, expectedOpaqueSessionId)
  ) {
    throw new DurableMcpEventPersistenceError(
      "Durable MCP session binding digest is internally inconsistent",
    );
  }
}

async function writeSnapshot(
  configuration: ResolvedConfiguration,
  payload: SnapshotPayload,
): Promise<void> {
  const snapshot: StoredSnapshot = {
    ...payload,
    checksum: persistenceChecksum(configuration.hmacKey, "snapshot", payload),
  };
  const plain = Buffer.from(`${canonicalJson(snapshot)}\n`, "utf8");
  if (
    configuration.maxPersistenceBytes !== undefined &&
    plain.byteLength > configuration.maxPersistenceBytes
  ) {
    throw new DurableMcpEventPersistenceError("MCP event persistence exceeds its byte bound");
  }
  const compressed = await gzipAsync(plain);
  await atomicWriteBytes(configuration.snapshotPath, compressed);
}

async function atomicWrite(
  path: string,
  content: string,
  maxBytes: number | undefined,
): Promise<void> {
  if (maxBytes !== undefined && Buffer.byteLength(content, "utf8") > maxBytes) {
    throw new DurableMcpEventPersistenceError("MCP event persistence exceeds its byte bound");
  }
  await atomicWriteBytes(path, Buffer.from(content, "utf8"));
}

async function atomicWriteBytes(path: string, content: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content);
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

async function atomicCreate(path: string, content: string, maxBytes: number): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    throw new DurableMcpEventPersistenceError("MCP event persistence exceeds its byte bound");
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
    // A hard-link publishes the fully synced immutable locator atomically and
    // refuses to replace a concurrently-created boundary mapping.
    await link(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function loadHmacKey(path: string, create: boolean): Promise<Buffer | undefined> {
  const existing = await readBoundedFile(path, 128);
  if (existing !== undefined) return parseHmacKey(existing);
  if (!create) return undefined;
  await mkdir(dirname(path), { recursive: true });
  const key = randomBytes(32);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${key.toString("base64url")}\n`, "utf8");
    await handle.sync();
    await handle.close();
    return key;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (errorCode(error) !== "EEXIST") throw error;
    const raced = await readBoundedFile(path, 128);
    if (raced === undefined) {
      throw new DurableMcpEventPersistenceError("MCP event HMAC key creation raced without a key");
    }
    return parseHmacKey(raced);
  }
}

function parseHmacKey(raw: string): Buffer {
  const encoded = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new DurableMcpEventPersistenceError("MCP event HMAC key is invalid");
  }
  return validatedHmacKey(Buffer.from(encoded, "base64url"));
}

async function readBoundedFile(
  path: string,
  maxBytes: number | undefined,
): Promise<string | undefined> {
  try {
    const value = await readFile(path);
    if (maxBytes !== undefined && value.length > maxBytes) {
      throw new DurableMcpEventPersistenceError("MCP event persistence exceeds its byte bound");
    }
    return value.toString("utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function readSnapshotFile(
  path: string,
  maxBytes: number | undefined,
): Promise<string | undefined> {
  let stored: Buffer;
  try {
    stored = await readFile(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  const plain = isGzip(stored)
    ? await gunzipAsync(
        stored,
        maxBytes === undefined ? undefined : { maxOutputLength: maxBytes },
      ).catch((error: unknown) => {
        throw new DurableMcpEventPersistenceError(
          `MCP event snapshot compression is invalid: ${errorMessage(error)}`,
        );
      })
    : stored;
  if (maxBytes !== undefined && plain.byteLength > maxBytes) {
    throw new DurableMcpEventPersistenceError("MCP event persistence exceeds its byte bound");
  }
  return plain.toString("utf8");
}

/**
 * One-time, lossless maintenance for pre-compression snapshots. Filenames,
 * authenticated payloads, locators, event ordering, and replay semantics stay
 * unchanged; only the physical encoding becomes gzip. Call while the owning
 * gateway is stopped so no snapshot writer can race the atomic replacement.
 */
export async function compactDurableMcpEventSnapshots(options: {
  readonly dataDirectory?: string;
  readonly hmacKey: Uint8Array;
  readonly maxPersistenceBytes?: number;
}): Promise<DurableMcpEventSnapshotCompactionResult> {
  const dataDirectory = resolve(
    options.dataDirectory ?? join(omniCodexDataDirectory(), "durable-mcp-events"),
  );
  const hmacKey = validatedHmacKey(options.hmacKey);
  const maxPersistenceBytes = optionalPositiveInteger(
    options.maxPersistenceBytes,
    "maxPersistenceBytes",
  );
  const entries = await readSessionDirectory(dataDirectory, undefined);
  let snapshotCount = 0;
  let compressedSnapshotCount = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;
  for (const entry of entries) {
    const snapshotPath = resolve(join(dataDirectory, entry.name));
    const stored = await readFile(snapshotPath);
    snapshotCount += 1;
    bytesBefore = checkedByteSum(bytesBefore, stored.byteLength);
    if (isGzip(stored)) {
      bytesAfter = checkedByteSum(bytesAfter, stored.byteLength);
      continue;
    }
    const configuration: ResolvedConfiguration = {
      dataDirectory,
      snapshotPath,
      journalPath: `${snapshotPath}.journal`,
      locatorPath: join(dataDirectory, LOCATOR_DIRECTORY, "maintenance-unused"),
      locatorDigest: "A".repeat(43),
      hmacKeyPath: join(dataDirectory, "maintenance-unused.key"),
      hmacKey,
      binding: EMPTY_STORED_BINDING,
      maxEvents: undefined,
      maxEventBytes: undefined,
      maxPersistenceBytes,
      eventTtlMs: undefined,
      sessionTtlMs: undefined,
      tombstoneTtlMs: undefined,
      maxTombstones: undefined,
      nowUnixMs: Date.now,
    };
    const payload = await loadSnapshot(configuration);
    if (payload === undefined) continue;
    await writeSnapshot(configuration, payload);
    const replaced = await readFile(snapshotPath);
    compressedSnapshotCount += 1;
    bytesAfter = checkedByteSum(bytesAfter, replaced.byteLength);
  }
  return { snapshotCount, compressedSnapshotCount, bytesBefore, bytesAfter };
}

function isGzip(value: Uint8Array): boolean {
  return value.byteLength >= 2 && value[0] === 0x1f && value[1] === 0x8b;
}

function checkedByteSum(total: number, additional: number): number {
  const next = total + additional;
  if (!Number.isSafeInteger(next)) {
    throw new DurableMcpEventPersistenceError("MCP event persistence size is out of range");
  }
  return next;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function persistenceChecksum(
  key: Buffer,
  domain: "snapshot" | "journal" | "locator",
  value: unknown,
): string {
  if (!isRecord(value)) throw new DurableMcpEventPersistenceError("MCP event envelope is invalid");
  const { checksum: _checksum, ...payload } = value;
  return keyedDigest(key, `persistence:${domain}`, canonicalJson(payload));
}

function keyedDigest(key: Uint8Array, domain: string, value: string): string {
  return createHmac("sha256", key)
    .update(`omnicodex-durable-mcp-events-v1:${domain}\0`, "utf8")
    .update(value, "utf8")
    .digest("base64url");
}

function transportLocatorDigest(
  key: Buffer,
  ownerDigest: string,
  surfaceDigest: string,
  transportSessionDigest: string,
): string {
  return keyedDigest(
    key,
    "transport-locator",
    lengthPrefixed(ownerDigest, surfaceDigest, transportSessionDigest),
  );
}

function locatorPathFor(dataDirectory: string, locatorDigest: string): string {
  return resolve(join(dataDirectory, LOCATOR_DIRECTORY, `omel1_${locatorDigest}.json`));
}

function eventIdFor(key: Buffer, bindingDigest: string, sequence: number): EventId {
  return `omev1_${sequence.toString(36)}_${keyedDigest(
    key,
    "event-id",
    lengthPrefixed(bindingDigest, String(sequence)),
  )}`;
}

function lengthPrefixed(...values: readonly string[]): string {
  return values.map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`).join("|");
}

function validateJsonRpcMessage(value: unknown): asserts value is JSONRPCMessage {
  // MCP SDK 2025-11-25 resumability stores an empty priming event before the
  // first JSON-RPC response on a request stream.
  if (!isRecord(value) || (Object.keys(value).length > 0 && value.jsonrpc !== "2.0")) {
    throw new TypeError("message must be a JSON-RPC 2.0 object");
  }
}

function requiredOpaqueText(value: unknown, name: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    /[\0\r\n]/.test(value)
  )
    throw new TypeError(`${name} is not a valid opaque value`);
  return value;
}

function requiredOwnerBinding(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4_096 ||
    /[\r\n]/.test(value)
  ) {
    throw new TypeError("ownerBinding is not a valid authorization boundary");
  }
  return value;
}

function validatedHmacKey(value: Uint8Array): Buffer {
  const key = Buffer.from(value);
  if (key.length < 32 || key.length > 64) {
    throw new RangeError("MCP event HMAC key must contain between 32 and 64 bytes");
  }
  return key;
}

function optionalPositiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function checkedTimestamp(value: number): number {
  if (!validTimestamp(value)) throw new RangeError("MCP event clock returned an invalid time");
  return value;
}

function checkedFutureTimestamp(now: number, durationMs: number): number {
  const value = now + durationMs;
  if (!validTimestamp(value) || value <= now) {
    throw new RangeError("MCP event expiry exceeds the supported timestamp range");
  }
  return value;
}

function checkedRevision(value: number): number {
  if (!validRevision(value)) {
    throw new DurableMcpEventPersistenceError("MCP event revision space is exhausted");
  }
  return value;
}

function checkedSequence(value: number): number {
  if (!validRevision(value) || value < 1) {
    throw new DurableMcpEventPersistenceError("MCP event sequence space is exhausted");
  }
  return value;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function parseJson(raw: string, message: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new DurableMcpEventPersistenceError(message);
  }
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}
