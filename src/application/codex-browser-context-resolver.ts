import { APP_SERVER_THREAD_INVENTORY_SOURCE_KINDS } from "./app-server-thread-inventory.js";
import type {
  BrowserNativeContextBoundary,
  BrowserNativeContextRequest,
} from "./browser-native-executor.js";
import type { AppServerRpcClient } from "./native-tool-catalog.js";

export interface CodexDesktopThreadOwnerResolver {
  findThreadOwner(
    threadId: string,
    options?: {
      readonly hostId?: string;
      readonly timeoutMs?: number;
      readonly deadlineUnixMs?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<string | null>;
}

export interface CodexBrowserContextResolverOptions {
  /** Preferred live task for app-global Chrome/list hosting only, never IAB identity. */
  readonly initialPreferredThreadId?: string;
  readonly now?: () => number;
  readonly validationTtlMs?: number;
  readonly threadListTimeoutMs?: number;
  readonly ownerProbeTimeoutMs?: number;
  readonly maxCandidates?: number;
  readonly probeBatchSize?: number;
}

const DEFAULT_PROBE_BATCH_SIZE = 8;
const DEFAULT_PAGE_LIMIT = 100;

interface CachedContext {
  readonly identity: string;
  readonly threadId: string;
  readonly validatedAtUnixMs: number;
}

/**
 * Resolves a live Codex desktop task that can host the first-party browser
 * client. Chrome/extension/list calls retain recency-based app-global hosting.
 * IAB calls are different: only the exact task supplied by the authenticated
 * request is ownership-verified, and no inventory fallback is permitted.
 */
export function createCodexBrowserContextResolver(
  appServer: Pick<AppServerRpcClient, "request">,
  desktop: CodexDesktopThreadOwnerResolver,
  options: CodexBrowserContextResolverOptions = {},
): (
  request?: BrowserNativeContextRequest,
  boundary?: BrowserNativeContextBoundary,
) => Promise<string | undefined> {
  const now = options.now ?? Date.now;
  const validationTtlMs =
    optionalNonNegativeInteger(options.validationTtlMs, "validationTtlMs") ?? 0;
  const threadListTimeoutMs = optionalPositiveInteger(
    options.threadListTimeoutMs,
    "threadListTimeoutMs",
  );
  const ownerProbeTimeoutMs = optionalPositiveInteger(
    options.ownerProbeTimeoutMs,
    "ownerProbeTimeoutMs",
  );
  const maxCandidates = optionalPositiveInteger(options.maxCandidates, "maxCandidates");
  const probeBatchSize = positiveInteger(
    options.probeBatchSize ?? DEFAULT_PROBE_BATCH_SIZE,
    "probeBatchSize",
  );
  const initialPreferredThreadId = nonEmptyString(options.initialPreferredThreadId);
  let globalCache: CachedContext | undefined;
  const exactCache = new Map<string, CachedContext>();
  let globalFlight: Promise<string | undefined> | undefined;
  const exactFlights = new Map<string, Promise<string | undefined>>();

  const hasDesktopOwner = async (
    threadId: string,
    boundary: BrowserNativeContextBoundary = {},
  ): Promise<boolean> => {
    assertContextBoundaryActive(boundary, now);
    const owner = await desktop.findThreadOwner(threadId, {
      hostId: "local",
      ...(ownerProbeTimeoutMs === undefined ? {} : { timeoutMs: ownerProbeTimeoutMs }),
      ...(boundary.deadlineUnixMs === undefined ? {} : { deadlineUnixMs: boundary.deadlineUnixMs }),
      ...(boundary.signal === undefined ? {} : { signal: boundary.signal }),
    });
    assertContextBoundaryActive(boundary, now);
    return owner !== null;
  };

  const resolveExactOnce = async (
    request: BrowserNativeContextRequest,
    threadId: string,
    boundary: BrowserNativeContextBoundary,
  ): Promise<string | undefined> => {
    const identity = exactContextIdentity(request, threadId);
    if (!(await hasDesktopOwner(threadId, boundary))) {
      exactCache.delete(identity);
      return undefined;
    }
    if (validationTtlMs > 0) {
      exactCache.set(identity, { identity, threadId, validatedAtUnixMs: now() });
    }
    return threadId;
  };

  const resolveExact = async (
    request: BrowserNativeContextRequest,
    threadId: string,
    boundary: BrowserNativeContextBoundary,
  ): Promise<string | undefined> => {
    assertContextBoundaryActive(boundary, now);
    const identity = exactContextIdentity(request, threadId);
    const cached = exactCache.get(identity);
    if (cached !== undefined && now() - cached.validatedAtUnixMs < validationTtlMs) {
      return cached.threadId;
    }
    // A bounded caller must retain its exact signal/deadline all the way into
    // IPC. Do not attach it to another caller's physical ownership probe.
    if (hasContextBoundary(boundary)) {
      return resolveExactOnce(request, threadId, boundary);
    }
    const existingFlight = exactFlights.get(identity);
    if (existingFlight !== undefined) return existingFlight;
    const promise = resolveExactOnce(request, threadId, {}).finally(() => {
      if (exactFlights.get(identity) === promise) exactFlights.delete(identity);
    });
    exactFlights.set(identity, promise);
    return promise;
  };

  const resolveGlobalOnce = async (
    callerBoundary: BrowserNativeContextBoundary,
  ): Promise<string | undefined> => {
    assertContextBoundaryActive(callerBoundary, now);
    const discoveryDeadline = minimumDefined(
      callerBoundary.deadlineUnixMs,
      threadListTimeoutMs === undefined ? undefined : deadlineAfter(now(), threadListTimeoutMs),
    );
    const boundary: BrowserNativeContextBoundary = {
      ...(callerBoundary.signal === undefined ? {} : { signal: callerBoundary.signal }),
      ...(discoveryDeadline === undefined ? {} : { deadlineUnixMs: discoveryDeadline }),
    };
    const priority = uniqueStrings([globalCache?.threadId, initialPreferredThreadId]);
    for (const threadId of priority) {
      if (await hasDesktopOwner(threadId, boundary)) {
        globalCache = {
          identity: "app-global-browser-host",
          threadId,
          validatedAtUnixMs: now(),
        };
        return threadId;
      }
    }

    const prioritySet = new Set(priority);
    const observedThreadIds = new Set(priority);
    const observedCursors = new Set<string>();
    let cursor: string | undefined;
    let inspectedCandidates = 0;
    while (true) {
      assertContextBoundaryActive(boundary, now);
      if (maxCandidates !== undefined && inspectedCandidates >= maxCandidates) return undefined;
      const remainingCandidates =
        maxCandidates === undefined ? DEFAULT_PAGE_LIMIT : maxCandidates - inspectedCandidates;
      const page = await appServer.request<unknown>(
        "thread/list",
        {
          archived: false,
          limit: Math.min(DEFAULT_PAGE_LIMIT, remainingCandidates),
          modelProviders: [],
          sourceKinds: [...APP_SERVER_THREAD_INVENTORY_SOURCE_KINDS],
          sortDirection: "desc",
          sortKey: "recency_at",
          useStateDbOnly: true,
          ...(cursor === undefined ? {} : { cursor }),
        },
        hasContextBoundary(boundary) ? boundary : undefined,
      );
      assertContextBoundaryActive(boundary, now);
      if (!isObject(page) || !Array.isArray(page.data)) {
        throw new Error("Codex App Server did not return threads for browser context discovery");
      }
      const candidates = uniqueStrings(
        page.data.flatMap((value) => {
          if (!isObject(value)) return [];
          const threadId = nonEmptyString(value.id);
          if (
            threadId === undefined ||
            prioritySet.has(threadId) ||
            observedThreadIds.has(threadId)
          ) {
            return [];
          }
          observedThreadIds.add(threadId);
          return [threadId];
        }),
      );
      const allowedCandidates =
        maxCandidates === undefined
          ? candidates
          : candidates.slice(0, maxCandidates - inspectedCandidates);
      inspectedCandidates += allowedCandidates.length;
      for (let offset = 0; offset < allowedCandidates.length; offset += probeBatchSize) {
        const batch = allowedCandidates.slice(offset, offset + probeBatchSize);
        const owners = await Promise.all(
          batch.map((threadId) => hasDesktopOwner(threadId, boundary)),
        );
        const firstOwnedIndex = owners.findIndex(Boolean);
        if (firstOwnedIndex < 0) continue;
        const selected = batch[firstOwnedIndex];
        if (selected === undefined) continue;
        globalCache = {
          identity: "app-global-browser-host",
          threadId: selected,
          validatedAtUnixMs: now(),
        };
        return selected;
      }
      const nextCursor = nonEmptyString(page.nextCursor);
      if (nextCursor === undefined) break;
      if (observedCursors.has(nextCursor)) {
        throw new Error("Codex App Server repeated a browser context discovery cursor");
      }
      observedCursors.add(nextCursor);
      cursor = nextCursor;
    }

    globalCache = undefined;
    return undefined;
  };

  const resolveGlobal = (boundary: BrowserNativeContextBoundary): Promise<string | undefined> => {
    assertContextBoundaryActive(boundary, now);
    if (globalCache !== undefined && now() - globalCache.validatedAtUnixMs < validationTtlMs) {
      return Promise.resolve(globalCache.threadId);
    }
    // See resolveExact: a bounded caller's IPC/App Server operations must not
    // inherit another waiter's cancellation or deadline.
    if (hasContextBoundary(boundary)) return resolveGlobalOnce(boundary);
    if (globalFlight !== undefined) return globalFlight;
    const promise = resolveGlobalOnce({}).finally(() => {
      if (globalFlight === promise) globalFlight = undefined;
    });
    globalFlight = promise;
    return promise;
  };

  return async (request, boundary = {}) => {
    if (!isIabRequest(request)) return resolveGlobal(boundary);
    const threadId = nonEmptyString(request.contextThreadId);
    if (threadId === undefined) {
      assertContextBoundaryActive(boundary, now);
      return undefined;
    }
    return resolveExact(request, threadId, boundary);
  };
}

function isIabRequest(
  request: BrowserNativeContextRequest | undefined,
): request is BrowserNativeContextRequest & {
  readonly surface: "iab";
} {
  return (
    request !== undefined && request.operation !== "list_surfaces" && request.surface === "iab"
  );
}

function exactContextIdentity(request: BrowserNativeContextRequest, threadId: string): string {
  return JSON.stringify([
    threadId,
    request.ownerBinding ?? null,
    request.workSessionBinding ?? request.callerSessionId ?? null,
  ]);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function optionalPositiveInteger(value: number | undefined, name: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, name);
}

function optionalNonNegativeInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.flatMap((value) => (value === undefined ? [] : [value])))];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function hasContextBoundary(boundary: BrowserNativeContextBoundary): boolean {
  return boundary.signal !== undefined || boundary.deadlineUnixMs !== undefined;
}

function assertContextBoundaryActive(
  boundary: BrowserNativeContextBoundary,
  now: () => number,
): void {
  if (boundary.signal?.aborted === true) {
    throw boundary.signal.reason instanceof Error
      ? boundary.signal.reason
      : new Error("Codex browser context discovery was aborted");
  }
  if (boundary.deadlineUnixMs !== undefined) {
    if (!Number.isSafeInteger(boundary.deadlineUnixMs) || boundary.deadlineUnixMs < 1) {
      throw new TypeError("Codex browser context deadline must be a positive safe integer");
    }
    if (boundary.deadlineUnixMs <= now()) {
      throw new Error("Codex browser context discovery deadline exceeded");
    }
  }
}

function deadlineAfter(nowUnixMs: number, durationMs: number): number {
  return durationMs > Number.MAX_SAFE_INTEGER - nowUnixMs
    ? Number.MAX_SAFE_INTEGER
    : nowUnixMs + durationMs;
}

function minimumDefined(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return Math.min(first, second);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
