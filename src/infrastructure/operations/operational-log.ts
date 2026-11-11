import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync } from "node:zlib";
import { omniCodexDataDirectory } from "../config/omnicodex-config-store.js";

export type OmniCodexOperationalEvent =
  | "goal_continuation"
  | "goal_continuation_failed"
  | "daemon_starting"
  | "daemon_ready"
  | "daemon_stopping"
  | "daemon_stopped"
  | "daemon_failed"
  | "daemon_request_cancellation_observed"
  | "runtime_switch_starting"
  | "runtime_switch_completed"
  | "runtime_switch_rolled_back"
  | "runtime_switch_committed_cleanup_pending"
  | "ngrok_tunnel_start_failed"
  | "ngrok_tunnel_recovery_started"
  | "ngrok_tunnel_recovery_attempt_failed"
  | "ngrok_tunnel_recovery_completed"
  | "ngrok_tunnel_recovery_exhausted"
  | "external_tunnel_start_failed"
  | "external_tunnel_unavailable"
  | "external_tunnel_recovered"
  | "stale_ngrok_reclaim_started"
  | "stale_ngrok_reclaim_completed"
  | "stale_ngrok_reclaim_refused"
  | "stale_codex_app_servers_reclaim_started"
  | "stale_codex_app_servers_reclaim_completed"
  | "stale_codex_app_servers_reclaim_refused"
  | "codex_runtime_recovery_started"
  | "codex_runtime_recovery_attempt_failed"
  | "codex_runtime_recovery_completed"
  | "codex_runtime_recovery_exhausted"
  | "release_candidate_admission_draining"
  | "oracle_adapter_ready"
  | "oracle_approval_owned_by_oracle_run"
  | "oracle_remote_cdp_tunnel_ready"
  | "oracle_remote_cdp_tunnel_failed"
  | "oracle_action_catalog_refreshed"
  | "oracle_action_catalog_refresh_failed"
  | "oracle_action_catalog_sync_failed"
  | "oracle_adapter_failed_closed"
  | "oracle_browser_recovery_started"
  | "oracle_browser_recovery_attempt_failed"
  | "oracle_browser_recovery_completed"
  | "oracle_browser_recovery_exhausted"
  | "oracle_approval_watcher_started"
  | "oracle_conversation_event_observed"
  | "oracle_conversation_turn_failed"
  | "desktop_conversation_turn_failed"
  | "oracle_approval_ownership_guard_ready"
  | "oracle_approval_ownership_guard_unhealthy"
  | "oracle_approval_activated"
  | "oracle_approval_chrome_synchronized"
  | "oracle_approval_chrome_sync_failed"
  | "desktop_chat_approval_activated"
  | "desktop_chat_approval_failed"
  | "oracle_approval_watcher_error"
  | "oracle_approval_rate_limited"
  | "oracle_approval_server_response_error"
  | "oracle_approval_requests_observed"
  | "oracle_approval_watcher_unhealthy"
  | "oracle_approval_watcher_stopped"
  | "oracle_approval_stale_runs_ignored"
  | "oracle_approval_conversations_mirrored"
  | "oracle_approval_conversation_mirror_failed"
  | "oracle_approval_conversation_mirror_recovered"
  | "oracle_approval_conversation_mirror_released"
  | "oracle_loop_chrome_file_approval"
  | "oracle_loop_chrome_file_approval_failed"
  | "authorization_failed"
  | "authorization_succeeded"
  | "oauth_discovery_observed"
  | "mcp_request_observed"
  | "mcp_tool_catalog_observed"
  | "native_tool_execution_observed"
  | "nested_tool_execution_observed"
  | "mutation_replay_observed"
  | "read_invocation_observed"
  | "mcp_progress_observed"
  | "mcp_result_delivered";

export interface OmniCodexOperationalLogEntry {
  readonly timestamp: string;
  readonly event: OmniCodexOperationalEvent;
  readonly pid: number;
  readonly details?: Record<string, string | number | boolean | null>;
}

export interface OmniCodexOperationalLogOptions {
  readonly path?: string;
  readonly maxBytes?: number;
  readonly compressArchivedSegments?: boolean;
}

export interface OmniCodexOperationalLogCursor {
  readonly offset: number;
  /** Opaque file identity used to preserve cursor continuity across rotation. */
  readonly segmentId?: string;
}

export interface OmniCodexOperationalLogBatch {
  readonly entries: readonly OmniCodexOperationalLogEntry[];
  readonly cursor: OmniCodexOperationalLogCursor;
}

export interface OmniCodexOperationalActivity {
  readonly scope: "current_log_writer";
  readonly pid: number;
  readonly since: string;
  readonly events: Partial<
    Record<
      OmniCodexOperationalEvent,
      {
        readonly count: number;
        readonly lastTimestamp: string;
        readonly lastDetails?: OmniCodexOperationalLogEntry["details"];
        readonly totals: Readonly<Record<string, number>>;
      }
    >
  >;
}

interface OperationalLogSegment {
  readonly path: string;
  readonly segmentId: string;
  readonly order: number;
  readonly compressed: boolean;
  readonly active: boolean;
}

const DEFAULT_SEGMENT_BYTES = 8 * 1024 * 1024;
const ARCHIVE_FILE_PATTERN = /^segment-(\d{13})-[a-f0-9]+--(s[a-z0-9-]+)\.jsonl(\.gz)?$/;

/** A metadata-only, losslessly segmented log. Tool arguments and results are never accepted. */
export class OmniCodexOperationalLog {
  readonly #path: string;
  readonly #maxBytes: number;
  readonly #compressArchivedSegments: boolean;
  readonly #archiveDirectory: string;
  #tail: Promise<void> = Promise.resolve();
  #maintenanceTail: Promise<void> = Promise.resolve();
  readonly #activitySince = new Date().toISOString();
  readonly #activity = new Map<
    OmniCodexOperationalEvent,
    {
      count: number;
      lastTimestamp: string;
      lastDetails?: OmniCodexOperationalLogEntry["details"];
      totals: Record<string, number>;
    }
  >();

  constructor(options: OmniCodexOperationalLogOptions = {}) {
    this.#path = resolve(options.path ?? join(omniCodexDataDirectory(), "operations.jsonl"));
    this.#maxBytes =
      explicitPositiveSafeInteger(options.maxBytes, "maxBytes") ?? DEFAULT_SEGMENT_BYTES;
    this.#compressArchivedSegments = options.compressArchivedSegments ?? true;
    this.#archiveDirectory = `${this.#path}.segments`;
  }

  get path(): string {
    return this.#path;
  }

  /** Committed events from this writer only; no disk scan, HTTP request or timer. */
  get activity(): OmniCodexOperationalActivity {
    return {
      scope: "current_log_writer",
      pid: process.pid,
      since: this.#activitySince,
      events: Object.fromEntries(
        [...this.#activity].map(([event, activity]) => [
          event,
          {
            ...activity,
            ...(activity.lastDetails === undefined
              ? {}
              : { lastDetails: { ...activity.lastDetails } }),
            totals: { ...activity.totals },
          },
        ]),
      ),
    };
  }

  append(
    event: OmniCodexOperationalEvent,
    details?: Record<string, string | number | boolean | null>,
    options: { readonly durable?: boolean } = {},
  ): Promise<void> {
    const entry: OmniCodexOperationalLogEntry = {
      timestamp: new Date().toISOString(),
      event,
      pid: process.pid,
      ...(details === undefined ? {} : { details: sanitizeDetails(details) }),
    };
    const operation = this.#tail.then(async () => {
      const rotated = await this.#rotateIfNeeded();
      if (options.durable === true) {
        const file = await open(this.#path, "a", 0o600);
        try {
          await file.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
      } else {
        await appendFile(this.#path, `${JSON.stringify(entry)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      }
      const prior = this.#activity.get(event);
      const totals = { ...prior?.totals };
      for (const field of [
        "getCount",
        "postCount",
        "moduleInitializationCount",
        "rateLimitCount",
      ] as const) {
        const value = entry.details?.[field];
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
          totals[field] = (totals[field] ?? 0) + value;
        }
      }
      this.#activity.set(event, {
        count: (prior?.count ?? 0) + 1,
        lastTimestamp: entry.timestamp,
        ...(entry.details === undefined ? {} : { lastDetails: entry.details }),
        totals,
      });
      if (rotated !== undefined && this.#compressArchivedSegments) {
        this.#scheduleCompression(rotated);
      }
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  /** Wait for accepted appends and lossless archive compression to settle. */
  async flush(): Promise<void> {
    await this.#tail;
    await this.#maintenanceTail;
  }

  async read(limit?: number): Promise<readonly OmniCodexOperationalLogEntry[]> {
    const explicitLimit = explicitPositiveSafeInteger(limit, "limit");
    if (explicitLimit !== undefined) return this.#readTail(explicitLimit);
    const entries: OmniCodexOperationalLogEntry[] = [];
    for (const segment of await this.#orderedSegments()) {
      appendEntries(entries, parseEntries((await readSegmentBytes(segment)).toString("utf8")));
    }
    return entries;
  }

  /** Capture an append-only byte position without parsing historical entries. */
  async captureCursor(): Promise<OmniCodexOperationalLogCursor> {
    const segments = await this.#orderedSegments();
    const latest = segments.at(-1);
    if (latest === undefined) return { offset: 0 };
    return {
      offset: await segmentLength(latest),
      segmentId: latest.segmentId,
    };
  }

  /**
   * Read every complete JSONL record appended after a cursor. The cursor only
   * advances through the last newline, so a concurrently appended partial
   * record is recovered intact on the next call.
   */
  async readFrom(cursor: OmniCodexOperationalLogCursor): Promise<OmniCodexOperationalLogBatch> {
    if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0) {
      throw new Error("Operational log cursor offset must be a non-negative safe integer");
    }
    return this.#readFrom(cursor, true);
  }

  async #readFrom(
    cursor: OmniCodexOperationalLogCursor,
    retryCompressionRace: boolean,
  ): Promise<OmniCodexOperationalLogBatch> {
    let segments = await this.#orderedSegments();
    if (segments.length === 0) return { entries: [], cursor: { offset: 0 } };
    let segmentIndex = locateCursorSegment(segments, cursor, this.#path);
    if (segmentIndex < 0 && cursor.segmentId !== undefined) {
      // A rename may have occurred between directory and active-file snapshots.
      segments = await this.#orderedSegments();
      segmentIndex = locateCursorSegment(segments, cursor, this.#path);
    }
    if (segmentIndex < 0) {
      throw new Error(`Operational log cursor segment is unavailable: ${cursor.segmentId}`);
    }

    const entries: OmniCodexOperationalLogEntry[] = [];
    let nextCursor = cursor;
    for (let index = segmentIndex; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment === undefined) continue;
      let bytes: Buffer;
      try {
        bytes = await readSegmentBytes(segment);
      } catch (error) {
        if (retryCompressionRace && getErrorCode(error) === "ENOENT") {
          return this.#readFrom(cursor, false);
        }
        throw error;
      }
      const start = index === segmentIndex ? compatibleStart(cursor, segment, bytes.length) : 0;
      if (start === bytes.length) {
        nextCursor = { offset: start, segmentId: segment.segmentId };
        continue;
      }
      const unread = bytes.subarray(start);
      const lastNewline = unread.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        nextCursor = { offset: start, segmentId: segment.segmentId };
        break;
      }
      const consumed = unread.subarray(0, lastNewline + 1);
      appendEntries(entries, parseEntries(consumed.toString("utf8")));
      nextCursor = {
        offset: start + consumed.length,
        segmentId: segment.segmentId,
      };
    }
    return { entries, cursor: nextCursor };
  }

  async #readTail(limit: number): Promise<readonly OmniCodexOperationalLogEntry[]> {
    let entries: OmniCodexOperationalLogEntry[] = [];
    const segments = await this.#orderedSegments();
    for (let index = segments.length - 1; index >= 0 && entries.length < limit; index -= 1) {
      const segment = segments[index];
      if (segment === undefined) continue;
      const remaining = limit - entries.length;
      entries = (await readSegmentTail(segment, remaining)).concat(entries);
    }
    return entries.slice(-limit);
  }

  async #rotateIfNeeded(): Promise<string | undefined> {
    let size: number;
    try {
      size = (await stat(this.#path)).size;
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    if (size < this.#maxBytes) return undefined;
    await mkdir(this.#archiveDirectory, { recursive: true });
    // Two rotations can share one millisecond. Preserve append order even when
    // their file identities sort in the opposite lexical order on Windows.
    let archiveOrder = Date.now();
    for (const name of await readdir(this.#archiveDirectory)) {
      const match = ARCHIVE_FILE_PATTERN.exec(name);
      if (match?.[1] !== undefined) archiveOrder = Math.max(archiveOrder, Number(match[1]) + 1);
    }
    const currentStats = await stat(this.#path);
    const rotated = join(
      this.#archiveDirectory,
      `segment-${archiveOrder.toString().padStart(13, "0")}-${process.pid.toString(16)}--${fileIdentity(currentStats)}.jsonl`,
    );
    try {
      await rename(this.#path, rotated);
      return rotated;
    } catch (error) {
      if (getErrorCode(error) === "EBUSY" || getErrorCode(error) === "EPERM") {
        // A diagnostic reader can briefly hold the Windows file open. Preserve
        // availability and retry rotation on the next append instead of failing
        // the request that only tried to record metadata.
        return undefined;
      }
      throw error;
    }
  }

  async #orderedSegments(): Promise<readonly OperationalLogSegment[]> {
    const archived = new Map<string, OperationalLogSegment>();
    const legacy = `${this.#path}.1`;
    try {
      const legacyStats = await stat(legacy);
      archived.set(fileIdentity(legacyStats), {
        path: legacy,
        segmentId: fileIdentity(legacyStats),
        order: 0,
        compressed: false,
        active: false,
      });
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") throw error;
    }
    try {
      for (const name of await readdir(this.#archiveDirectory)) {
        const match = ARCHIVE_FILE_PATTERN.exec(name);
        if (match === null) continue;
        const order = Number(match[1]);
        const segmentId = match[2];
        if (segmentId === undefined || !Number.isSafeInteger(order)) continue;
        const candidate: OperationalLogSegment = {
          path: join(this.#archiveDirectory, name),
          segmentId,
          order,
          compressed: match[3] !== undefined,
          active: false,
        };
        const previous = archived.get(segmentId);
        if (previous === undefined || (candidate.compressed && !previous.compressed)) {
          archived.set(segmentId, candidate);
        }
      }
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") throw error;
    }
    const ordered = [...archived.values()].sort(
      (left, right) => left.order - right.order || left.path.localeCompare(right.path),
    );
    try {
      const activeStats = await stat(this.#path);
      ordered.push({
        path: this.#path,
        segmentId: fileIdentity(activeStats),
        order: Number.MAX_SAFE_INTEGER,
        compressed: false,
        active: true,
      });
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") throw error;
    }
    return ordered;
  }

  #scheduleCompression(path: string): void {
    const operation = this.#maintenanceTail.then(() => compressArchive(path));
    this.#maintenanceTail = operation.catch(() => undefined);
  }
}

function appendEntries(
  target: OmniCodexOperationalLogEntry[],
  source: readonly OmniCodexOperationalLogEntry[],
): void {
  // Array.push(...source) overflows V8's argument stack on long-lived logs.
  // Iteration preserves the complete ordered stream without imposing a cap.
  for (const entry of source) target.push(entry);
}

function locateCursorSegment(
  segments: readonly OperationalLogSegment[],
  cursor: OmniCodexOperationalLogCursor,
  activePath: string,
): number {
  if (cursor.segmentId !== undefined) {
    return segments.findIndex((segment) => segment.segmentId === cursor.segmentId);
  }
  const activeIndex = segments.findIndex((segment) => segment.path === activePath);
  return activeIndex >= 0 ? activeIndex : segments.length - 1;
}

function compatibleStart(
  cursor: OmniCodexOperationalLogCursor,
  segment: OperationalLogSegment,
  size: number,
): number {
  if (cursor.segmentId === undefined && cursor.offset > size && segment.active) return 0;
  if (cursor.offset > size) {
    throw new Error(
      `Operational log cursor offset exceeds segment length: ${cursor.offset} > ${size}`,
    );
  }
  return cursor.offset;
}

async function readSegmentBytes(segment: OperationalLogSegment): Promise<Buffer> {
  const bytes = await readFile(segment.path);
  return segment.compressed ? gunzipSync(bytes) : bytes;
}

async function segmentLength(segment: OperationalLogSegment): Promise<number> {
  if (!segment.compressed) return (await stat(segment.path)).size;
  return (await readSegmentBytes(segment)).length;
}

async function readSegmentTail(
  segment: OperationalLogSegment,
  limit: number,
): Promise<readonly OmniCodexOperationalLogEntry[]> {
  if (segment.compressed) {
    return parseEntries((await readSegmentBytes(segment)).toString("utf8")).slice(-limit);
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(segment.path, "r");
    const size = (await handle.stat()).size;
    const chunks: Buffer[] = [];
    let position = size;
    let newlineCount = 0;
    const chunkBytes = 64 * 1024;
    while (position > 0 && newlineCount <= limit) {
      const start = Math.max(0, position - chunkBytes);
      const bytes = Buffer.allocUnsafe(position - start);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
      const complete = bytes.subarray(0, bytesRead);
      for (const byte of complete) if (byte === 0x0a) newlineCount += 1;
      chunks.unshift(complete);
      position = start;
    }
    return parseEntries(Buffer.concat(chunks).toString("utf8")).slice(-limit);
  } finally {
    await handle?.close();
  }
}

async function compressArchive(path: string): Promise<void> {
  const compressed = `${path}.gz`;
  const temporary = `${compressed}.${process.pid}.${Date.now()}.tmp`;
  try {
    await pipeline(
      createReadStream(path),
      createGzip({ level: 6 }),
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    await rename(temporary, compressed);
    await rm(path, { force: true });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (getErrorCode(error) !== "ENOENT") throw error;
  }
}

function fileIdentity(value: {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
}): string {
  return `s${Math.trunc(value.dev).toString(36)}-${Math.trunc(value.ino).toString(36)}-${Math.trunc(value.birthtimeMs).toString(36)}`;
}

function parseEntries(text: string): OmniCodexOperationalLogEntry[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return isLogEntry(value) ? [value] : [];
      } catch {
        return [];
      }
    });
}

function sanitizeDetails(
  details: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  return { ...details };
}

function explicitPositiveSafeInteger(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Operational log ${field} must be a positive safe integer`);
  }
  return value;
}

function isLogEntry(value: unknown): value is OmniCodexOperationalLogEntry {
  return (
    isObject(value) &&
    typeof value.timestamp === "string" &&
    typeof value.event === "string" &&
    typeof value.pid === "number"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}
