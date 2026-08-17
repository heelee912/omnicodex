import { appendFile, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { omniCodexDataDirectory } from "../config/omnicodex-config-store.js";

export type OmniCodexOperationalEvent =
  | "daemon_starting"
  | "daemon_ready"
  | "daemon_stopping"
  | "daemon_stopped"
  | "daemon_failed"
  | "oracle_adapter_ready"
  | "oracle_adapter_failed_closed"
  | "authorization_failed";

export interface OmniCodexOperationalLogEntry {
  readonly timestamp: string;
  readonly event: OmniCodexOperationalEvent;
  readonly pid: number;
  readonly details?: Record<string, string | number | boolean | null>;
}

export interface OmniCodexOperationalLogOptions {
  readonly path?: string;
  readonly maxBytes?: number;
}

/** A small metadata-only rotating log. Tool arguments and results are never accepted. */
export class OmniCodexOperationalLog {
  readonly #path: string;
  readonly #maxBytes: number;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: OmniCodexOperationalLogOptions = {}) {
    this.#path = resolve(options.path ?? join(omniCodexDataDirectory(), "operations.jsonl"));
    this.#maxBytes = options.maxBytes ?? 1_048_576;
  }

  get path(): string {
    return this.#path;
  }

  append(
    event: OmniCodexOperationalEvent,
    details?: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    const entry: OmniCodexOperationalLogEntry = {
      timestamp: new Date().toISOString(),
      event,
      pid: process.pid,
      ...(details === undefined ? {} : { details: sanitizeDetails(details) }),
    };
    const operation = this.#tail.then(async () => {
      await this.#rotateIfNeeded();
      await appendFile(this.#path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  async read(limit = 100): Promise<readonly OmniCodexOperationalLogEntry[]> {
    const bounded = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") return [];
      throw error;
    }
    return text
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .slice(-bounded)
      .flatMap((line) => {
        try {
          const value: unknown = JSON.parse(line);
          return isLogEntry(value) ? [value] : [];
        } catch {
          return [];
        }
      });
  }

  async #rotateIfNeeded(): Promise<void> {
    let size: number;
    try {
      size = (await stat(this.#path)).size;
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") return;
      throw error;
    }
    if (size < this.#maxBytes) return;
    const rotated = `${this.#path}.1`;
    await rm(rotated, { force: true });
    await rename(this.#path, rotated);
  }
}

function sanitizeDetails(
  details: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(details)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) continue;
    result[key] = typeof value === "string" ? value.slice(0, 2_048) : value;
  }
  return result;
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
