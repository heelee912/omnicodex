import { readdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import type { OmniCodexDaemonState } from "../config/omnicodex-config-store.js";
import {
  type OwnedCodexAppServerDaemonIdentity,
  type OwnedCodexAppServerRecord,
  ownedCodexAppServerRecordFileName,
  ownedCodexAppServerRegistryDirectory,
  readOwnedCodexAppServerRecord,
  recordMatchesDaemon,
  recordMatchesObservedProcess,
  removeExactRecord,
} from "../runtime/owned-codex-app-server-registry.js";
import {
  HiddenChildProcessBoundary,
  type RecoveredWindowsProcessIdentity,
} from "./hidden-child-process.js";

export interface RecoveredWindowsProcessBoundary {
  inspectWindowsProcess(
    pid: number,
    options?: { readonly expectedProcessName?: string },
  ): Promise<RecoveredWindowsProcessIdentity | undefined>;
  terminateExactRecoveredWindowsProcess(
    expected: RecoveredWindowsProcessIdentity,
  ): Promise<"terminated" | "absent" | "changed">;
}

export interface WindowsStaleCodexAppServerReclaimerOptions {
  readonly dataDirectory: string;
  readonly boundary?: RecoveredWindowsProcessBoundary;
  readonly naturalExitWaitMs?: number;
  readonly pollIntervalMs?: number;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

export interface StaleCodexAppServerReclaimResult {
  readonly status: "absent" | "reclaimed";
  readonly observedCount: number;
  readonly naturallyExitedCount: number;
  readonly terminatedCount: number;
}

/**
 * Recovers only App Server roots durably registered to one exact stale daemon.
 * It first gives stdio EOF a short chance to stop each child naturally, then
 * uses the central Windows identity boundary to terminate unchanged survivors.
 */
export class WindowsStaleCodexAppServerReclaimer {
  readonly #dataDirectory: string;
  readonly #boundary: RecoveredWindowsProcessBoundary;
  readonly #naturalExitWaitMs: number;
  readonly #pollIntervalMs: number;
  readonly #delay: (milliseconds: number) => Promise<void>;

  constructor(options: WindowsStaleCodexAppServerReclaimerOptions) {
    this.#dataDirectory = options.dataDirectory;
    this.#boundary = options.boundary ?? new HiddenChildProcessBoundary();
    this.#naturalExitWaitMs = boundedMilliseconds(
      options.naturalExitWaitMs,
      1_500,
      "naturalExitWaitMs",
    );
    this.#pollIntervalMs = boundedMilliseconds(options.pollIntervalMs, 100, "pollIntervalMs");
    this.#delay =
      options.delay ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async reclaim(state: OmniCodexDaemonState): Promise<StaleCodexAppServerReclaimResult> {
    const daemon = daemonIdentity(state);
    const directory = ownedCodexAppServerRegistryDirectory(this.#dataDirectory, daemon);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return emptyResult();
      throw error;
    }
    const recordNames = names.filter((name) => name.endsWith(".json"));
    const unexpected = names.filter((name) => !name.endsWith(".json"));
    if (unexpected.length > 0) {
      throw new Error("OWNED_CODEX_APP_SERVER_REGISTRY_AMBIGUOUS:unexpected registry entry");
    }
    const records = await Promise.all(
      recordNames.map(async (name) => {
        const path = join(directory, name);
        const record = await readOwnedCodexAppServerRecord(path);
        if (!recordMatchesDaemon(record, daemon)) {
          throw new Error("OWNED_CODEX_APP_SERVER_REGISTRY_AMBIGUOUS:daemon identity mismatch");
        }
        if (ownedCodexAppServerRecordFileName(record) !== name) {
          throw new Error("OWNED_CODEX_APP_SERVER_REGISTRY_AMBIGUOUS:file identity mismatch");
        }
        return { path, record };
      }),
    );
    if (records.length === 0) {
      await removeEmptyDirectory(directory);
      return emptyResult();
    }

    const pending = new Map(records.map((entry) => [entry.record.processNonce, entry]));
    let naturallyExitedCount = 0;
    const deadline = Date.now() + this.#naturalExitWaitMs;
    do {
      for (const [nonce, entry] of pending) {
        const observed = await this.#boundary.inspectWindowsProcess(entry.record.pid, {
          expectedProcessName: entry.record.processName,
        });
        if (observed === undefined) {
          await removeExactRecord(entry.path, entry.record);
          pending.delete(nonce);
          naturallyExitedCount += 1;
          continue;
        }
        assertExactRecordIdentity(entry.record, observed);
      }
      if (pending.size === 0 || Date.now() >= deadline) break;
      await this.#delay(Math.min(this.#pollIntervalMs, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);

    let terminatedCount = 0;
    for (const [nonce, entry] of pending) {
      const observed = await this.#boundary.inspectWindowsProcess(entry.record.pid, {
        expectedProcessName: entry.record.processName,
      });
      if (observed === undefined) {
        await removeExactRecord(entry.path, entry.record);
        pending.delete(nonce);
        naturallyExitedCount += 1;
        continue;
      }
      assertExactRecordIdentity(entry.record, observed);
      const outcome = await this.#boundary.terminateExactRecoveredWindowsProcess(observed);
      if (outcome === "changed") {
        throw new Error("OWNED_CODEX_APP_SERVER_IDENTITY_CHANGED:termination fence");
      }
      const after = await this.#boundary.inspectWindowsProcess(entry.record.pid, {
        expectedProcessName: entry.record.processName,
      });
      if (after !== undefined) {
        throw new Error("OWNED_CODEX_APP_SERVER_TERMINATION_UNCONFIRMED:process remains");
      }
      await removeExactRecord(entry.path, entry.record);
      pending.delete(nonce);
      if (outcome === "terminated") terminatedCount += 1;
      else naturallyExitedCount += 1;
    }
    await removeEmptyDirectory(directory);
    return {
      status: terminatedCount > 0 ? "reclaimed" : "absent",
      observedCount: records.length,
      naturallyExitedCount,
      terminatedCount,
    };
  }
}

function assertExactRecordIdentity(
  record: OwnedCodexAppServerRecord,
  observed: RecoveredWindowsProcessIdentity,
): void {
  if (!recordMatchesObservedProcess(record, observed)) {
    throw new Error("OWNED_CODEX_APP_SERVER_IDENTITY_CHANGED:refusing termination");
  }
}

function daemonIdentity(state: OmniCodexDaemonState): OwnedCodexAppServerDaemonIdentity {
  return {
    pid: state.pid,
    instanceNonce: state.instanceNonce,
    startedAtUnixMs: state.startedAtUnixMs,
  };
}

function emptyResult(): StaleCodexAppServerReclaimResult {
  return {
    status: "absent",
    observedCount: 0,
    naturallyExitedCount: 0,
    terminatedCount: 0,
  };
}

async function removeEmptyDirectory(directory: string): Promise<void> {
  await rmdir(directory).catch((error) => {
    if (errorCode(error) !== "ENOTEMPTY" && errorCode(error) !== "ENOENT") throw error;
  });
}

function boundedMilliseconds(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0 || result > 30_000) {
    throw new Error(`${name} must be between 0 and 30000 milliseconds`);
  }
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}
