import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";

interface RolloutItemRef {
  readonly offset: number;
  readonly byteLength: number;
}

interface RolloutIndexState {
  readonly fileIdentity: string;
  readonly itemsByTurn: Map<string, RolloutItemRef[]>;
  scannedBytes: number;
  activeTurnId: string | undefined;
  refresh: Promise<void> | undefined;
}

export interface CodexRolloutItemPageInput {
  readonly rolloutPath: string;
  readonly turnId: string;
  readonly offset?: number;
  /** Caller-selected count. Omission returns every remaining item. */
  readonly limit?: number;
  /** Explicit transport byte window. Omission imposes no byte limit. */
  readonly maxBytes?: number;
}

export interface CodexRolloutItemPage {
  readonly items: readonly unknown[];
  readonly page: {
    readonly order: "source_order";
    readonly source: "rollout_jsonl";
    readonly limit: number | null;
    readonly callerSelectedLimit: boolean;
    readonly offset: number;
    readonly totalItems: number;
    readonly returnedItems: number;
    readonly returnedBytes: number;
    readonly omittedItems: number;
    readonly selection: "all" | "transport_window" | "caller_window";
    readonly previousItemOffset: number | null;
    readonly nextItemOffset: number | null;
  };
}

export interface CodexRolloutItemPagerLike {
  readTurnPage(input: CodexRolloutItemPageInput): Promise<CodexRolloutItemPage>;
}

/**
 * Reads one logical Codex turn without asking App Server to hydrate every
 * persisted item into one JSON-RPC response. Installed Windows builds expose
 * thread/items/list in their schema but can still return -32601 at runtime, so
 * the append-only rollout is the authoritative lossless paging source.
 */
export class CodexRolloutItemPager implements CodexRolloutItemPagerLike {
  readonly #indexes = new Map<string, RolloutIndexState>();

  async readTurnPage(input: CodexRolloutItemPageInput): Promise<CodexRolloutItemPage> {
    const offset = nonNegativeInteger(input.offset ?? 0, "rollout item offset");
    const callerLimit =
      input.limit === undefined ? undefined : positiveInteger(input.limit, "rollout item limit");
    const transportByteLimit =
      input.maxBytes === undefined
        ? undefined
        : positiveInteger(input.maxBytes, "rollout item byte window");
    const state = await this.#refreshIndex(input.rolloutPath);
    const refs = state.itemsByTurn.get(input.turnId) ?? [];
    if (offset > refs.length) {
      throw new RangeError(`rollout item offset ${String(offset)} exceeds ${String(refs.length)}`);
    }

    const maximumItems = callerLimit ?? Number.POSITIVE_INFINITY;
    const maximumBytes = transportByteLimit ?? Number.POSITIVE_INFINITY;
    const selected: RolloutItemRef[] = [];
    let selectedBytes = 0;
    for (let index = offset; index < refs.length && selected.length < maximumItems; index += 1) {
      const ref = refs[index];
      if (ref === undefined) break;
      if (selected.length > 0 && selectedBytes + ref.byteLength > maximumBytes) break;
      selected.push(ref);
      selectedBytes += ref.byteLength;
    }

    const items = await readPayloads(input.rolloutPath, selected);
    const end = offset + selected.length;
    return {
      items,
      page: {
        order: "source_order",
        source: "rollout_jsonl",
        limit: callerLimit ?? null,
        callerSelectedLimit: callerLimit !== undefined,
        offset,
        totalItems: refs.length,
        returnedItems: items.length,
        returnedBytes: selectedBytes,
        omittedItems: refs.length - items.length,
        selection:
          callerLimit !== undefined
            ? "caller_window"
            : transportByteLimit !== undefined
              ? "transport_window"
              : "all",
        previousItemOffset:
          offset === 0 ? null : Math.max(0, offset - (callerLimit ?? refs.length)),
        nextItemOffset: end < refs.length ? end : null,
      },
    };
  }

  async #refreshIndex(path: string): Promise<RolloutIndexState> {
    const file = await stat(path);
    if (!file.isFile()) throw new Error("Codex rollout path is not a file");
    const fileIdentity = `${String(file.dev)}:${String(file.ino)}:${String(file.birthtimeMs)}`;
    let state = this.#indexes.get(path);
    if (
      state === undefined ||
      state.fileIdentity !== fileIdentity ||
      file.size < state.scannedBytes
    ) {
      state = {
        fileIdentity,
        itemsByTurn: new Map(),
        scannedBytes: 0,
        activeTurnId: undefined,
        refresh: undefined,
      };
      this.#indexes.set(path, state);
    }
    if (state.refresh !== undefined) await state.refresh;
    if (state.scannedBytes >= file.size) return state;

    const refresh = scanRollout(path, state, file.size).finally(() => {
      if (state?.refresh === refresh) state.refresh = undefined;
    });
    state.refresh = refresh;
    await refresh;
    return state;
  }
}

async function scanRollout(
  path: string,
  state: RolloutIndexState,
  snapshotBytes: number,
): Promise<void> {
  let parts: Buffer[] = [];
  let partBytes = 0;
  let carryOffset = state.scannedBytes;
  const stream = createReadStream(path, {
    start: state.scannedBytes,
    end: snapshotBytes - 1,
    highWaterMark: 1024 * 1024,
  });
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let chunkOffset = 0;
    let newline = chunk.indexOf(0x0a);
    while (newline >= 0) {
      const tail = chunk.subarray(chunkOffset, newline);
      const record =
        parts.length === 0 ? tail : Buffer.concat([...parts, tail], partBytes + tail.length);
      const line = record.at(-1) === 0x0d ? record.subarray(0, -1) : record;
      indexLine(state, line, carryOffset);
      carryOffset += record.length + 1;
      // Commit each complete line only after successful parsing. A later
      // malformed record must not cause earlier items to be indexed twice.
      state.scannedBytes = carryOffset;
      parts = [];
      partBytes = 0;
      chunkOffset = newline + 1;
      newline = chunk.indexOf(0x0a, chunkOffset);
    }
    if (chunkOffset < chunk.length) {
      const tail = chunk.subarray(chunkOffset);
      parts.push(tail);
      partBytes += tail.length;
    }
  }
  // Rollout writers terminate committed records with a newline. Retain an
  // incomplete tail for the next append instead of indexing a torn record.
  state.scannedBytes = carryOffset;
}

function indexLine(state: RolloutIndexState, line: Buffer, offset: number): void {
  if (line.length === 0) return;
  // JSON field order and header length are not part of the rollout contract.
  // Decode the complete record rather than guessing its type/turn from a
  // fixed prefix. Retain only byte references, not the decoded output body.
  const record = JSON.parse(line.toString("utf8")) as {
    readonly type?: string;
    readonly payload?: { readonly type?: string; readonly turn_id?: string };
  } | null;
  const outerType = record?.type;
  if (outerType === "response_item") {
    if (state.activeTurnId === undefined) return;
    const refs = state.itemsByTurn.get(state.activeTurnId) ?? [];
    refs.push({ offset, byteLength: line.length });
    state.itemsByTurn.set(state.activeTurnId, refs);
    return;
  }

  const payloadType = record?.payload?.type;
  const turnId = typeof record?.payload?.turn_id === "string" ? record.payload.turn_id : undefined;
  if (outerType === "event_msg" && payloadType === "task_started") {
    state.activeTurnId = turnId;
    return;
  }
  if (outerType === "turn_context") {
    state.activeTurnId = turnId ?? state.activeTurnId;
    return;
  }
  if (
    outerType === "event_msg" &&
    (payloadType === "task_complete" || payloadType === "turn_aborted")
  ) {
    const completedTurnId = turnId;
    if (completedTurnId === undefined || completedTurnId === state.activeTurnId) {
      state.activeTurnId = undefined;
    }
  }
}

async function readPayloads(path: string, refs: readonly RolloutItemRef[]): Promise<unknown[]> {
  if (refs.length === 0) return [];
  const handle = await open(path, "r");
  try {
    const payloads: unknown[] = [];
    for (const ref of refs) {
      const bytes = Buffer.allocUnsafe(ref.byteLength);
      let totalBytesRead = 0;
      while (totalBytesRead < ref.byteLength) {
        const { bytesRead } = await handle.read(
          bytes,
          totalBytesRead,
          ref.byteLength - totalBytesRead,
          ref.offset + totalBytesRead,
        );
        if (bytesRead === 0) {
          throw new Error("Codex rollout changed while an item page was being read");
        }
        totalBytesRead += bytesRead;
      }
      const record = JSON.parse(bytes.toString("utf8")) as { readonly payload?: unknown };
      payloads.push(record.payload);
    }
    return payloads;
  } finally {
    await handle.close();
  }
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${name} must be non-negative`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  return value;
}
