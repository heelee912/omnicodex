import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { CdpTarget } from "../infrastructure/chatgpt/chatgpt-cdp-transport.js";
import { normalizeChatGptConversationUrl } from "../infrastructure/chatgpt/chatgpt-conversation-route.js";

const ORACLE_SESSION_ID = /^[a-z0-9][a-z0-9-]{2,95}$/u;

type OracleProcessAliveProbe = (pid: number) => boolean | Promise<boolean>;

export interface OracleApprovalRunScope {
  readonly oracleRunId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly targetId: string;
  readonly conversationUrl: string;
  readonly controllerPid: number;
}

export interface OracleActiveRunSnapshot {
  readonly active: readonly OracleApprovalRunScope[];
  readonly staleRunIds: readonly string[];
}

export interface OracleActiveRunRegistryOptions {
  readonly sessionRoot?: string;
  readonly refreshIntervalMs?: number;
  readonly now?: () => number;
  readonly isProcessAlive?: OracleProcessAliveProbe;
}

/**
 * Reads Oracle's durable session metadata without taking ownership of Oracle's files.
 * A `running` string alone is not authority: the exact CDP target, conversation URL,
 * submitted prompt, and live controller process must all agree.
 */
export class OracleActiveRunRegistry {
  readonly #sessionRoot: string;
  readonly #refreshIntervalMs: number;
  readonly #now: () => number;
  readonly #isProcessAlive: OracleProcessAliveProbe;
  #expiresAt = 0;
  #cached: OracleActiveRunSnapshot = { active: [], staleRunIds: [] };
  #refresh: Promise<OracleActiveRunSnapshot> | undefined;

  constructor(options: OracleActiveRunRegistryOptions = {}) {
    this.#sessionRoot = resolve(options.sessionRoot ?? join(homedir(), ".oracle", "sessions"));
    this.#refreshIntervalMs = boundedRefreshInterval(options.refreshIntervalMs ?? 1_000);
    this.#now = options.now ?? Date.now;
    this.#isProcessAlive = options.isProcessAlive ?? processIsAlive;
  }

  async snapshot(): Promise<OracleActiveRunSnapshot> {
    const now = this.#now();
    if (now < this.#expiresAt) return this.#cached;
    if (this.#refresh !== undefined) return this.#refresh;
    const refresh = this.#readSnapshot().then((snapshot) => {
      this.#cached = snapshot;
      this.#expiresAt = this.#now() + this.#refreshIntervalMs;
      return snapshot;
    });
    this.#refresh = refresh;
    try {
      return await refresh;
    } finally {
      if (this.#refresh === refresh) this.#refresh = undefined;
    }
  }

  async activeRunForTarget(target: CdpTarget): Promise<OracleApprovalRunScope | undefined> {
    const snapshot = await this.snapshot();
    const matches = snapshot.active.filter(
      (run) =>
        run.targetId === target.id && run.conversationUrl === normalizedConversationUrl(target.url),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  async hasActiveRun(): Promise<boolean> {
    return (await this.snapshot()).active.length > 0;
  }

  async #readSnapshot(): Promise<OracleActiveRunSnapshot> {
    let directories: Dirent[];
    try {
      directories = await readdir(this.#sessionRoot, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { active: [], staleRunIds: [] };
      throw error;
    }
    const candidates = directories.filter(
      (entry) => entry.isDirectory() && ORACLE_SESSION_ID.test(entry.name),
    );
    const records = await Promise.all(
      candidates.map(async (entry) => {
        try {
          const value: unknown = JSON.parse(
            await readFile(join(this.#sessionRoot, entry.name, "meta.json"), "utf8"),
          );
          return await parseRunningSession(value, this.#isProcessAlive);
        } catch (error) {
          if (isNodeError(error, "ENOENT")) return undefined;
          if (error instanceof SyntaxError) return undefined;
          // One corrupt or concurrently disappearing Oracle record must not poison
          // approval discovery for every other live run.
          return undefined;
        }
      }),
    );
    const active: OracleApprovalRunScope[] = [];
    const staleRunIds: string[] = [];
    for (const record of records) {
      if (record === undefined) continue;
      if (record.kind === "active") active.push(record.run);
      else staleRunIds.push(record.runId);
    }
    active.sort((left, right) => left.oracleRunId.localeCompare(right.oracleRunId, "en"));
    staleRunIds.sort((left, right) => left.localeCompare(right, "en"));
    return { active, staleRunIds };
  }
}

async function parseRunningSession(
  value: unknown,
  isProcessAlive: OracleProcessAliveProbe,
): Promise<
  | { readonly kind: "active"; readonly run: OracleApprovalRunScope }
  | {
      readonly kind: "stale";
      readonly runId: string;
    }
  | undefined
> {
  if (!isObject(value) || value.status !== "running" || typeof value.id !== "string") {
    return undefined;
  }
  if (!ORACLE_SESSION_ID.test(value.id)) return undefined;
  const browser = objectValue(value.browser);
  const runtime = objectValue(browser.runtime);
  const targetId = nonEmptyString(runtime.chromeTargetId);
  const conversationUrl = normalizedConversationUrl(runtime.tabUrl);
  const controllerPid = runtime.controllerPid;
  if (
    runtime.promptSubmitted !== true ||
    targetId === undefined ||
    conversationUrl === undefined ||
    !Number.isSafeInteger(controllerPid) ||
    Number(controllerPid) < 1
  ) {
    return undefined;
  }
  if (!(await isProcessAlive(Number(controllerPid)))) return { kind: "stale", runId: value.id };
  return {
    kind: "active",
    run: {
      oracleRunId: value.id,
      sessionId: value.id,
      correlationId: value.id,
      targetId,
      conversationUrl,
      controllerPid: Number(controllerPid),
    },
  };
}

function normalizedConversationUrl(value: unknown): string | undefined {
  return normalizeChatGptConversationUrl(value);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    // Signal 0 performs an in-process existence/permission probe. In particular,
    // do not spawn PowerShell/Get-CimInstance once per durable record every second.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error, "EPERM")) return true;
    return false;
  }
}

function boundedRefreshInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 30_000) {
    throw new Error("Oracle active-run refresh interval must be between 100 and 30000ms");
  }
  return value;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value && value.code === code;
}
