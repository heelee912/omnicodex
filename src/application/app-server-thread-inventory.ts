import type { AppServerRpcClient } from "./native-tool-catalog.js";

const DEFAULT_PAGE_LIMIT = 100;

/**
 * App Server otherwise applies interactive-source and current-provider defaults.
 * Supplying the complete protocol enum plus an empty provider filter is what
 * makes this an inventory rather than a recent-interactive-task view.
 */
export const APP_SERVER_THREAD_INVENTORY_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
] as const;

export type AppServerThreadRecord = Readonly<Record<string, unknown>>;

export interface AppServerThreadInventory {
  readonly active: readonly AppServerThreadRecord[];
  readonly archived: readonly AppServerThreadRecord[];
}

export interface AppServerThreadInventoryOptions {
  readonly pageLimit?: number;
  readonly maxPages?: number;
  readonly deadlineMs?: number;
  readonly now?: () => number;
}

/**
 * Probes the owned App Server through its state database. A plain recent-task
 * listing may hydrate rollout lineage, so one malformed paginated history can
 * otherwise prevent the entire OmniCodex runtime from starting.
 */
export async function probeAppServerThreadInventory(client: AppServerRpcClient): Promise<void> {
  const response = await client.request<unknown>("thread/list", {
    limit: 1,
    archived: false,
    useStateDbOnly: true,
    sortKey: "updated_at",
    sortDirection: "desc",
    modelProviders: [],
    sourceKinds: [...APP_SERVER_THREAD_INVENTORY_SOURCE_KINDS],
  });
  if (!isObject(response) || !Array.isArray(response.data)) {
    throw new Error("App Server thread/list returned an invalid readiness page");
  }
}

/**
 * Reads every active and archived task from one already-owned App Server.
 * This helper is deliberately task-title agnostic; callers may identify their
 * own control task after receiving the complete authoritative inventory.
 */
export async function readAppServerThreadInventory(
  client: AppServerRpcClient,
  options: AppServerThreadInventoryOptions = {},
): Promise<AppServerThreadInventory> {
  const pageLimit = positiveInteger(options.pageLimit ?? DEFAULT_PAGE_LIMIT, "page limit");
  const maxPages = optionalPositiveInteger(options.maxPages, "page count");
  const deadlineMs = optionalPositiveInteger(options.deadlineMs, "deadline");
  const now = options.now ?? Date.now;
  const deadline = deadlineMs === undefined ? undefined : now() + deadlineMs;
  const [active, archived] = await Promise.all([
    readInventoryPartition(client, false, {
      pageLimit,
      ...(maxPages === undefined ? {} : { maxPages }),
      ...(deadline === undefined ? {} : { deadline }),
      now,
    }),
    readInventoryPartition(client, true, {
      pageLimit,
      ...(maxPages === undefined ? {} : { maxPages }),
      ...(deadline === undefined ? {} : { deadline }),
      now,
    }),
  ]);
  return { active, archived };
}

interface InventoryPartitionOptions {
  readonly pageLimit: number;
  readonly maxPages?: number;
  readonly deadline?: number;
  readonly now: () => number;
}

async function readInventoryPartition(
  client: AppServerRpcClient,
  archived: boolean,
  options: InventoryPartitionOptions,
): Promise<AppServerThreadRecord[]> {
  const threads: AppServerThreadRecord[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let page = 0;
  while (true) {
    if (options.maxPages !== undefined && page >= options.maxPages) {
      throw new Error(
        `App Server ${partitionName(archived)} thread inventory exceeded the caller page limit`,
      );
    }
    page += 1;
    const remainingMs =
      options.deadline === undefined ? undefined : options.deadline - options.now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      throw new Error(`App Server ${partitionName(archived)} thread inventory deadline exceeded`);
    }
    const response = await client.request<unknown>(
      "thread/list",
      {
        limit: options.pageLimit,
        archived,
        useStateDbOnly: true,
        sortKey: "updated_at",
        sortDirection: "desc",
        modelProviders: [],
        sourceKinds: [...APP_SERVER_THREAD_INVENTORY_SOURCE_KINDS],
        ...(cursor === undefined ? {} : { cursor }),
      },
      remainingMs,
    );
    if (!isObject(response) || !Array.isArray(response.data)) {
      throw new Error("App Server thread/list returned an invalid inventory page");
    }
    threads.push(...response.data.filter(isObject).map((thread) => ({ ...thread, archived })));
    const nextCursor =
      typeof response.nextCursor === "string" && response.nextCursor.length > 0
        ? response.nextCursor
        : undefined;
    if (nextCursor === undefined) return threads;
    if (seenCursors.has(nextCursor)) {
      throw new Error(`App Server repeated ${partitionName(archived)} thread inventory cursor`);
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

function partitionName(archived: boolean): "active" | "archived" {
  return archived ? "archived" : "active";
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`App Server thread inventory ${label} must be a positive integer`);
  }
  return value;
}

function optionalPositiveInteger(value: number | undefined, label: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, label);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
