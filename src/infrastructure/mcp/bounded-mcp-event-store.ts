import { randomBytes } from "node:crypto";
import type {
  EventId,
  EventStore,
  StreamId,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export interface BoundedMcpEventStoreOptions {
  readonly maxEvents?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly nonce?: string;
}

interface StoredEvent {
  readonly id: EventId;
  readonly streamId: StreamId;
  readonly message: JSONRPCMessage;
  readonly storedAtUnixMs: number;
}

/** Session-local resumable SSE history with monotonic opaque event IDs. */
export class BoundedMcpEventStore implements EventStore {
  readonly #maxEvents: number | undefined;
  readonly #ttlMs: number | undefined;
  readonly #now: () => number;
  readonly #nonce: string;
  readonly #events: StoredEvent[] = [];
  readonly #byId = new Map<EventId, StoredEvent>();
  #sequence = 0;

  constructor(options: BoundedMcpEventStoreOptions = {}) {
    this.#maxEvents = optionalPositiveInteger(options.maxEvents, "maxEvents");
    this.#ttlMs = optionalPositiveInteger(options.ttlMs, "ttlMs");
    this.#now = options.now ?? Date.now;
    this.#nonce = options.nonce ?? randomBytes(16).toString("base64url");
  }

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    this.#prune();
    this.#sequence += 1;
    const id = `${this.#nonce}.${this.#sequence.toString(36)}`;
    const event = { id, streamId, message, storedAtUnixMs: this.#now() };
    this.#events.push(event);
    this.#byId.set(id, event);
    while (this.#maxEvents !== undefined && this.#events.length > this.#maxEvents) {
      this.#removeFirst();
    }
    return id;
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    this.#prune();
    return this.#byId.get(eventId)?.streamId;
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    this.#prune();
    const last = this.#byId.get(lastEventId);
    if (last === undefined) throw new Error("EVENT_HISTORY_EXPIRED");
    const index = this.#events.findIndex((event) => event.id === lastEventId);
    if (index < 0) throw new Error("EVENT_HISTORY_EXPIRED");
    for (const event of this.#events.slice(index + 1)) {
      if (event.streamId === last.streamId) await send(event.id, event.message);
    }
    return last.streamId;
  }

  #prune(): void {
    if (this.#ttlMs === undefined) return;
    const cutoff = this.#now() - this.#ttlMs;
    while ((this.#events[0]?.storedAtUnixMs ?? Number.POSITIVE_INFINITY) < cutoff) {
      this.#removeFirst();
    }
  }

  #removeFirst(): void {
    const removed = this.#events.shift();
    if (removed !== undefined) this.#byId.delete(removed.id);
  }
}

function optionalPositiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
