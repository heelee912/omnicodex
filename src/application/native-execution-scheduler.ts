import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import { win32 as windowsPath } from "node:path";
import type {
  DurableNativeResourceLease,
  DurableNativeResourceLeaseCoordinatorLike,
} from "../infrastructure/runtime/durable-native-resource-lease-coordinator.js";
import { canonicalJson } from "../infrastructure/safety/canonical-json.js";

export interface NativeExecutionDescriptor {
  readonly nativeNamespace: string;
  readonly originalName: string;
  readonly source: string;
  /** Authoritative catalog classification when one is available. */
  readonly modelEffect?: "none" | "model" | "unknown";
  /** Authoritative catalog classification when one is available. */
  readonly stateEffect?: "none" | "read" | "mutate";
  /** Backward-compatible model classification exposed by some live catalogs. */
  readonly invokesModel?: boolean | null;
}

export interface NativeExecutionOrdering {
  readonly threadId?: string;
  readonly processId?: string;
  /** Long-lived terminal/browser/native session handle. */
  readonly sessionId?: string;
  /** Streaming execution cell handle, scoped by sessionId when both exist. */
  readonly cellId?: string;
  /** Explicit browser surface (for example chrome or in_app_browser). */
  readonly surface?: string;
  /** Exact downstream browser identity, distinct from a provider-facing tab id. */
  readonly browserId?: string;
  readonly tabId?: string;
  readonly windowId?: string;
  readonly deviceSerial?: string;
  readonly filePaths?: readonly string[];
  /** Explicit workspace-wide mutation scopes, never inferred from a command workdir. */
  readonly workspacePaths?: readonly string[];
  readonly projectPaths?: readonly string[];
  readonly scenePaths?: readonly string[];
}

export interface CanonicalNativeResourceKeyOptions {
  /** Deterministic base for relative paths when no workspace/project scope is present. */
  readonly basePath?: string;
}

export interface NativeExecutionIdentity {
  /** Stable authorization-owner identity. It is used only for admission and fairness. */
  readonly ownerId: string;
  /** Opaque MCP/local execution-session identity scoped to ownerId. */
  readonly sessionId: string;
}

export interface NativeExecutionRequest extends Partial<NativeExecutionIdentity> {
  /**
   * Stable native operation identity. Goal/idempotent callers must forward
   * their durable operationId; ordinary calls receive a generated identity.
   */
  readonly operationId?: string | undefined;
  readonly entry: NativeExecutionDescriptor;
  readonly ordering?: NativeExecutionOrdering | undefined;
  /** UTF-8 request-body bytes retained while the native execution is outstanding. */
  readonly requestBytes?: number | undefined;
  /** Absolute caller completion deadline. Omit together with timeoutMs to wait indefinitely. */
  readonly deadlineUnixMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  /** HTTP/client connection lifetime. It cancels only authoritative reads/no-state calls. */
  readonly transportDisconnectSignal?: AbortSignal | undefined;
  /** Runs after all resource lanes are owned and immediately before native I/O. */
  readonly beforeOperation?: ((signal?: AbortSignal) => Promise<void>) | undefined;
  /**
   * Successful authoritative reads can retire stale outcome-unknown resource
   * fences while the original mutation identity remains non-replayable.
   */
  readonly recoverUnknownResourcesWhen?: ((result: unknown) => boolean) | undefined;
}

export interface NativeExecutionRequestContext extends NativeExecutionIdentity {
  readonly requestBytes: number;
  /** Exact transport disconnect signal supplied by the authenticated gateway. */
  readonly transportDisconnectSignal?: AbortSignal | undefined;
}

export interface NativeExecutionSchedulerOptions {
  readonly shellConcurrency?: number | undefined;
  /** Optional caller policy. Omission leaves retained requests uncapped. */
  readonly globalMaxRequests?: number | undefined;
  /** Optional caller policy. Omission leaves retained request bytes uncapped. */
  readonly globalMaxRequestBytes?: number | undefined;
  /** Optional caller policy. Omission leaves per-session requests uncapped. */
  readonly sessionMaxRequests?: number | undefined;
  /** Optional caller policy. Omission leaves per-session request bytes uncapped. */
  readonly sessionMaxRequestBytes?: number | undefined;
  readonly overloadRetryAfterMs?: number | undefined;
  /** One daemon-wide coordinator shared by every runtime generation. */
  readonly resourceLeaseCoordinator?: DurableNativeResourceLeaseCoordinatorLike | undefined;
}

export class NativeExecutionOverloadedError extends Error {
  readonly code = "OVERLOADED";
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`OVERLOADED retryAfterMs=${retryAfterMs}`);
    this.name = "NativeExecutionOverloadedError";
    this.retryAfterMs = retryAfterMs;
  }
}

export type NativeExecutionTimeoutClass =
  | "catalog_read"
  | "shell_background"
  | "browser_ui"
  | "node_repl"
  | "explicit_model";

export interface NativeExecutionTimeoutResolution {
  readonly timeoutClass: NativeExecutionTimeoutClass;
  /** Exact caller-supplied completion timeout. Undefined means no completion deadline. */
  readonly timeoutMs: number | undefined;
  readonly callerSpecified: boolean;
}

export class NativeExecutionShutdownTimeoutError extends Error {
  readonly code = "NATIVE_EXECUTION_SHUTDOWN_TIMEOUT";

  constructor(timeoutMs: number, options?: ErrorOptions) {
    super(`Native execution scheduler did not become idle within ${timeoutMs}ms`, options);
    this.name = "NativeExecutionShutdownTimeoutError";
  }
}

export class NativeExecutionResultUnavailableError extends Error {
  readonly code = "NATIVE_EXECUTION_RESULT_UNAVAILABLE";

  constructor(operationId: string, state: "settled" | "joined" | "outcome_unknown") {
    super(`Native operation ${operationId} was not re-executed; ${state} result is unavailable`);
    this.name = "NativeExecutionResultUnavailableError";
  }
}

const DEFAULT_OVERLOAD_RETRY_AFTER_MS = 250;
const LOCAL_OWNER_ID = "local-codex";
const LOCAL_SESSION_ID = "local-native-tools";
const EXPLICIT_MODEL_NATIVE_NAMES = new Set([
  "create_thread",
  "handoff_thread",
  "review/start",
  "send_message_to_thread",
  "thread/compact/start",
  "thread/realtime/appendaudio",
  "thread/realtime/appendspeech",
  "thread/realtime/appendtext",
  "thread/realtime/start",
  "turn/start",
  "turn/steer",
]);

// A Codex in-app browser is owned by one exact desktop task.  Treat its
// explicit context identity as the same scheduling resource as ordinary
// thread-scoped native calls so two Web work sessions cannot concurrently
// drive the same renderer surface.
const NATIVE_THREAD_ID_KEYS = new Set(["threadid", "contextthreadid"]);
const NATIVE_PROCESS_ID_KEYS = new Set(["processid"]);
const NATIVE_SESSION_ID_KEYS = new Set(["sessionid"]);
const NATIVE_CELL_ID_KEYS = new Set(["cellid"]);
const NATIVE_SURFACE_KEYS = new Set(["surface", "browsersurface"]);
const NATIVE_BROWSER_ID_KEYS = new Set(["browserid"]);
const NATIVE_TAB_ID_KEYS = new Set(["tabid", "targettabid"]);
const NATIVE_WINDOW_ID_KEYS = new Set(["windowid", "windowhandle"]);
const NATIVE_DEVICE_SERIAL_KEYS = new Set(["deviceserial", "adbserial", "serial"]);
const NATIVE_FILE_PATH_KEYS = new Set([
  "path",
  "paths",
  "filepath",
  "filepaths",
  "sourcepath",
  "destinationpath",
  "targetpath",
  "oldpath",
  "newpath",
  "frompath",
  "topath",
  "directorypath",
  "rootpath",
  "workspacepath",
  "inputpath",
  "outputpath",
]);
const NATIVE_WORKSPACE_PATH_KEYS = new Set(["cwd", "workdir", "workingdir", "workingdirectory"]);
const NATIVE_PROJECT_PATH_KEYS = new Set(["projectpath", "projectdir", "projectdirectory"]);
const NATIVE_SCENE_PATH_KEYS = new Set(["scenepath"]);

/**
 * Derive resource ordering from exact native argument field names. Natural
 * language is ignored, except for the formal apply_patch grammar. A working
 * directory resolves relative paths; it does not declare an exclusive resource.
 */
export function nativeExecutionOrderingFromArguments(value: unknown): NativeExecutionOrdering {
  let threadId: string | undefined;
  let processId: string | undefined;
  let sessionId: string | undefined;
  let cellId: string | undefined;
  let surface: string | undefined;
  let browserId: string | undefined;
  let tabId: string | undefined;
  let windowId: string | undefined;
  let deviceSerial: string | undefined;
  const filePaths: string[] = [];
  const workspacePaths: string[] = [];
  const projectPaths: string[] = [];
  const scenePaths: string[] = [];
  const patchBodies: string[] = [];
  const visited = new Set<object>();

  const addStrings = (target: string[], candidate: unknown): void => {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      target.push(candidate.trim());
      return;
    }
    if (!Array.isArray(candidate)) return;
    for (const item of candidate) {
      if (typeof item === "string" && item.trim().length > 0) target.push(item.trim());
    }
  };

  const scalarIdentity = (candidate: unknown): string | undefined => {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
    return undefined;
  };

  const visit = (candidate: unknown, parentKey?: string): void => {
    if (candidate === null || typeof candidate !== "object" || visited.has(candidate)) return;
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, parentKey);
      return;
    }
    const record = candidate as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) {
      const normalizedKey = key.replaceAll("_", "").replaceAll("-", "").toLowerCase();
      if (threadId === undefined && NATIVE_THREAD_ID_KEYS.has(normalizedKey)) {
        threadId = scalarIdentity(item);
      }
      if (processId === undefined && NATIVE_PROCESS_ID_KEYS.has(normalizedKey)) {
        processId = scalarIdentity(item);
      }
      if (sessionId === undefined && NATIVE_SESSION_ID_KEYS.has(normalizedKey)) {
        sessionId = scalarIdentity(item);
      }
      if (cellId === undefined && NATIVE_CELL_ID_KEYS.has(normalizedKey)) {
        cellId = scalarIdentity(item);
      }
      if (surface === undefined && NATIVE_SURFACE_KEYS.has(normalizedKey)) {
        surface = scalarIdentity(item);
      }
      if (browserId === undefined && NATIVE_BROWSER_ID_KEYS.has(normalizedKey)) {
        browserId = scalarIdentity(item);
      }
      if (tabId === undefined && NATIVE_TAB_ID_KEYS.has(normalizedKey))
        tabId = scalarIdentity(item);
      if (windowId === undefined && NATIVE_WINDOW_ID_KEYS.has(normalizedKey)) {
        windowId = scalarIdentity(item);
      }
      if (
        windowId === undefined &&
        (parentKey === "window" || parentKey === "browserwindow") &&
        (normalizedKey === "id" || normalizedKey === "handle")
      ) {
        windowId = scalarIdentity(item);
      }
      if (deviceSerial === undefined && NATIVE_DEVICE_SERIAL_KEYS.has(normalizedKey)) {
        deviceSerial = scalarIdentity(item);
      }
      if (NATIVE_FILE_PATH_KEYS.has(normalizedKey)) addStrings(filePaths, item);
      if (NATIVE_WORKSPACE_PATH_KEYS.has(normalizedKey)) addStrings(workspacePaths, item);
      if (NATIVE_PROJECT_PATH_KEYS.has(normalizedKey)) addStrings(projectPaths, item);
      if (NATIVE_SCENE_PATH_KEYS.has(normalizedKey)) addStrings(scenePaths, item);
      if (
        normalizedKey === "input" &&
        typeof item === "string" &&
        /^\s*\*\*\* Begin Patch(?:\r?\n|$)/.test(item)
      ) {
        patchBodies.push(item);
      }
    }
    for (const [key, item] of Object.entries(record)) {
      visit(item, key.replaceAll("_", "").replaceAll("-", "").toLowerCase());
    }
  };

  if (typeof value === "string" && /^\s*\*\*\* Begin Patch(?:\r?\n|$)/.test(value)) {
    patchBodies.push(value);
  } else {
    visit(value);
  }
  const workingDirectory = workspacePaths[0] ?? process.cwd();
  const resourceBase =
    projectPaths[0] === undefined
      ? workingDirectory
      : resolveWindowsPath(projectPaths[0], workingDirectory);
  for (const body of patchBodies) {
    for (const patchPath of applyPatchPaths(body)) {
      filePaths.push(resolveWindowsPath(patchPath, workingDirectory));
    }
  }

  return {
    ...(threadId === undefined ? {} : { threadId }),
    ...(processId === undefined ? {} : { processId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(cellId === undefined ? {} : { cellId }),
    ...(surface === undefined ? {} : { surface }),
    ...(browserId === undefined ? {} : { browserId }),
    ...(tabId === undefined ? {} : { tabId }),
    ...(windowId === undefined ? {} : { windowId }),
    ...(deviceSerial === undefined ? {} : { deviceSerial }),
    ...(filePaths.length === 0
      ? {}
      : {
          filePaths: [...new Set(filePaths.map((path) => resolveWindowsPath(path, resourceBase)))],
        }),
    ...(projectPaths.length === 0
      ? {}
      : {
          projectPaths: [
            ...new Set(projectPaths.map((path) => resolveWindowsPath(path, workingDirectory))),
          ],
        }),
    ...(scenePaths.length === 0
      ? {}
      : {
          scenePaths: [
            ...new Set(scenePaths.map((path) => resolveWindowsPath(path, resourceBase))),
          ],
        }),
  };
}

export function mergeNativeExecutionOrdering(
  inferred: NativeExecutionOrdering,
  explicit?: NativeExecutionOrdering,
): NativeExecutionOrdering {
  const filePaths = [...new Set([...(inferred.filePaths ?? []), ...(explicit?.filePaths ?? [])])];
  const workspacePaths = [
    ...new Set([...(inferred.workspacePaths ?? []), ...(explicit?.workspacePaths ?? [])]),
  ];
  const projectPaths = [
    ...new Set([...(inferred.projectPaths ?? []), ...(explicit?.projectPaths ?? [])]),
  ];
  const scenePaths = [
    ...new Set([...(inferred.scenePaths ?? []), ...(explicit?.scenePaths ?? [])]),
  ];
  // Caller-supplied ordering metadata is authoritative. A nested native
  // argument may describe the same resource, but it must never replace the
  // lock identity established at the dispatch boundary.
  const threadId = explicit?.threadId ?? inferred.threadId;
  const processId = explicit?.processId ?? inferred.processId;
  const sessionId = explicit?.sessionId ?? inferred.sessionId;
  const cellId = explicit?.cellId ?? inferred.cellId;
  const surface = explicit?.surface ?? inferred.surface;
  const browserId = explicit?.browserId ?? inferred.browserId;
  const tabId = explicit?.tabId ?? inferred.tabId;
  const windowId = explicit?.windowId ?? inferred.windowId;
  const deviceSerial = explicit?.deviceSerial ?? inferred.deviceSerial;
  return {
    ...(threadId === undefined ? {} : { threadId }),
    ...(processId === undefined ? {} : { processId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(cellId === undefined ? {} : { cellId }),
    ...(surface === undefined ? {} : { surface }),
    ...(browserId === undefined ? {} : { browserId }),
    ...(tabId === undefined ? {} : { tabId }),
    ...(windowId === undefined ? {} : { windowId }),
    ...(deviceSerial === undefined ? {} : { deviceSerial }),
    ...(filePaths.length === 0 ? {} : { filePaths }),
    ...(workspacePaths.length === 0 ? {} : { workspacePaths }),
    ...(projectPaths.length === 0 ? {} : { projectPaths }),
    ...(scenePaths.length === 0 ? {} : { scenePaths }),
  };
}

/**
 * Classify one native descriptor and preserve the caller's exact completion
 * boundary. OmniCodex never invents a completion deadline or caps one chosen
 * by the caller. Catalog effects take precedence over stable native identities;
 * the identity rules cover direct browser/host calls without registry metadata.
 */
export function resolveNativeExecutionTimeout(
  entry: NativeExecutionDescriptor,
  callerTimeoutMs?: number,
): NativeExecutionTimeoutResolution {
  const timeoutClass = nativeExecutionTimeoutClass(entry);
  if (callerTimeoutMs === undefined) {
    return {
      timeoutClass,
      timeoutMs: undefined,
      callerSpecified: false,
    };
  }
  const requestedTimeoutMs = positiveInteger(callerTimeoutMs, "Native caller timeout");
  return {
    timeoutClass,
    timeoutMs: requestedTimeoutMs,
    callerSpecified: true,
  };
}

/**
 * Runtime-wide bounded scheduler. Every MCP session and the local Code Mode
 * surface share the same admission counters and resource lanes.
 */
export class NativeExecutionScheduler {
  readonly #shell: FairSemaphore;
  /**
   * Chrome/Computer Use and raw Node REPL share one native runtime inside a
   * work session, not one execution cell across every Web conversation.
   */
  readonly #nativeLanes = new KeyedSequencer();
  readonly #keys = new KeyedSequencer();
  readonly #admission: BoundedAdmission;
  readonly #requestContext = new AsyncLocalStorage<NativeExecutionRequestContext>();
  readonly #resourceLeaseCoordinator: DurableNativeResourceLeaseCoordinatorLike | undefined;
  readonly #forcedShutdown = new AbortController();
  readonly #operations = new Map<
    string,
    { readonly fingerprint: string; readonly completion: Promise<unknown> }
  >();
  #closing = false;
  #shutdownPromise: Promise<void> | undefined;

  constructor(options: NativeExecutionSchedulerOptions = {}) {
    const detectedCpuCount = availableParallelism();
    this.#shell = new FairSemaphore(
      positiveInteger(
        options.shellConcurrency ?? Math.max(1, Math.min(32, detectedCpuCount)),
        "Shell concurrency",
      ),
    );
    this.#resourceLeaseCoordinator = options.resourceLeaseCoordinator;
    this.#admission = new BoundedAdmission({
      globalMaxRequests: optionalPositiveInteger(options.globalMaxRequests, "Global request limit"),
      globalMaxRequestBytes: optionalPositiveInteger(
        options.globalMaxRequestBytes,
        "Global request byte limit",
      ),
      sessionMaxRequests: optionalPositiveInteger(
        options.sessionMaxRequests,
        "Session request limit",
      ),
      sessionMaxRequestBytes: optionalPositiveInteger(
        options.sessionMaxRequestBytes,
        "Session request byte limit",
      ),
      overloadRetryAfterMs: positiveInteger(
        options.overloadRetryAfterMs ?? DEFAULT_OVERLOAD_RETRY_AFTER_MS,
        "Overload retry delay",
      ),
    });
  }

  /** Bind authenticated transport metadata to every scheduler call in one MCP request. */
  withRequestContext<T>(
    context: NativeExecutionRequestContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#requestContext.run(validateRequestContext(context), operation);
  }

  /**
   * Returns a facade forwarding to this exact scheduler. A gateway can give
   * each MCP server this facade without creating independent resource lanes.
   */
  contextualView(): NativeExecutionScheduler {
    return new ContextualNativeExecutionScheduler(this, (request) =>
      this.#withCurrentContext(request),
    );
  }

  async run<T>(
    request: NativeExecutionRequest,
    operation: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const effectiveRequest = this.#withCurrentContext(request);
    if (this.#closing) throw new Error("Native execution scheduler is shutting down");
    const transportDisconnectSignal = transportDisconnectCancelsOperation(effectiveRequest.entry)
      ? effectiveRequest.transportDisconnectSignal
      : undefined;
    if (effectiveRequest.signal?.aborted || transportDisconnectSignal?.aborted) throw abortError();
    const timeout = resolveNativeExecutionTimeout(
      effectiveRequest.entry,
      effectiveRequest.timeoutMs,
    );
    const identity = executionIdentity(effectiveRequest);
    const timeoutMs = timeout.timeoutMs;
    const completionBoundary = resolveCallerCompletionBoundary(
      timeoutMs,
      effectiveRequest.deadlineUnixMs,
    );
    const boundary = acquisitionBoundary(
      completionBoundary.deadlineUnixMs,
      combineAbortSignals(
        combineAbortSignals(effectiveRequest.signal, transportDisconnectSignal),
        this.#forcedShutdown.signal,
      ),
    );
    const operationId = validIdentity(effectiveRequest.operationId, randomUUID());
    const lane = executionLane(effectiveRequest.entry);
    const resourceKeys = durableNativeResourceKeys(
      effectiveRequest.entry,
      effectiveRequest.ordering ?? {},
      lane,
      identity,
      operationId,
    );
    const fingerprint = createHash("sha256")
      .update(
        canonicalJson({
          ownerId: identity.ownerId,
          sessionId: identity.sessionId,
          entry: effectiveRequest.entry,
          resourceKeys,
        }),
        "utf8",
      )
      .digest("hex");
    const existing = this.#operations.get(operationId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        boundary.clear();
        throw new Error("Native operationId is already bound to another scheduler request");
      }
      try {
        return (await withCancellation(existing.completion, boundary.signal)) as T;
      } catch (error) {
        if (boundary.timedOut()) throw completionBoundaryError(completionBoundary);
        throw error;
      } finally {
        boundary.clear();
      }
    }

    const completion = this.#runNewOperation(
      effectiveRequest,
      operation,
      identity,
      lane,
      operationId,
      fingerprint,
      resourceKeys,
      boundary.signal,
    );
    const record = { fingerprint, completion };
    this.#operations.set(operationId, record);
    void completion
      .finally(() => {
        if (this.#operations.get(operationId) === record) this.#operations.delete(operationId);
      })
      .catch(() => undefined);
    try {
      return await withCancellation(completion, boundary.signal);
    } catch (error) {
      if (boundary.timedOut()) {
        throw completionBoundaryError(completionBoundary);
      }
      throw error;
    } finally {
      boundary.clear();
    }
  }

  /**
   * Permanently closes admission, waits for authoritative native settlement,
   * and records still-running durable leases as unknown only at a caller-supplied deadline.
   */
  shutdown(timeoutMs?: number): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    this.#closing = true;
    const explicitTimeoutMs = optionalPositiveInteger(
      timeoutMs,
      "Native scheduler shutdown timeout",
    );
    const operation = this.#shutdown(explicitTimeoutMs);
    this.#shutdownPromise = operation;
    return operation;
  }

  async #shutdown(timeoutMs: number | undefined): Promise<void> {
    const active = [...this.#operations.values()].map((operation) => operation.completion);
    if (active.length === 0) return;
    if (timeoutMs === undefined) {
      await Promise.allSettled(active);
      return;
    }
    const settled = await settleAllBefore(active, timeoutMs);
    if (settled) return;
    this.#forcedShutdown.abort(new Error("Native scheduler shutdown deadline expired"));
    let interruptError: unknown;
    try {
      await this.#resourceLeaseCoordinator?.interruptOwnedOperations("shutdown_deadline");
    } catch (error) {
      interruptError = error;
    }
    // Reaching an operator-selected deadline is the instruction to fence
    // ambiguous mutations, cancel all in-process waiters, and let the owning
    // runtime retire its exact child processes. That completed policy is not
    // itself a shutdown failure. Only failure to install the durable fence is.
    if (interruptError !== undefined) {
      throw new NativeExecutionShutdownTimeoutError(timeoutMs, { cause: interruptError });
    }
  }

  async #runNewOperation<T>(
    effectiveRequest: NativeExecutionRequest,
    operation: (signal?: AbortSignal) => Promise<T>,
    identity: NativeExecutionIdentity,
    lane: Lane,
    operationId: string,
    fingerprint: string,
    resourceKeys: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const admission = this.#admission.admit(identity, effectiveRequest.requestBytes ?? 0);
    let releaseKey: (() => void) | undefined;
    const releaseLanes: Array<() => void> = [];
    let durableLease: DurableNativeResourceLease | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const releaseLane of releaseLanes.splice(0).reverse()) releaseLane();
      releaseKey?.();
      admission.release();
    };
    try {
      // The native backends already provide snapshot semantics for reads.
      // Serializing every reader behind the same resource key lets one slow or
      // disconnected reader head-of-line block every other caller. Preserve
      // exclusive ordering for mutations and unknown live contracts only.
      releaseKey = requiresExclusiveResourceLock(effectiveRequest.entry)
        ? await this.#keys.acquire(resourceKeys, signal, identity)
        : () => undefined;
      // Durable outcome-unknown fences exist to prevent an ambiguous mutation
      // from being repeated after process loss. Pure reads and no-state calls
      // cannot leave external state ambiguous, so persisting their lease would
      // only turn a crashed reader into a permanent denial of future reads.
      if (
        this.#resourceLeaseCoordinator !== undefined &&
        requiresDurableMutationLease(effectiveRequest.entry)
      ) {
        const acquired = await this.#resourceLeaseCoordinator.acquire({
          operationId,
          ownerId: identity.ownerId,
          sessionId: identity.sessionId,
          fingerprint,
          resourceKeys,
          ...(signal === undefined ? {} : { signal }),
        });
        if (acquired.kind === "join") {
          const terminal = await acquired.completion;
          throw new NativeExecutionResultUnavailableError(
            operationId,
            terminal === "outcome_unknown" ? "outcome_unknown" : "joined",
          );
        }
        if (acquired.kind === "settled") {
          throw new NativeExecutionResultUnavailableError(operationId, "settled");
        }
        if (acquired.kind === "outcome_unknown") {
          throw new NativeExecutionResultUnavailableError(operationId, "outcome_unknown");
        }
        durableLease = acquired.lease;
      }
      // Keep the native lane exclusive. The extension-backed Chrome surface is
      // one physical runtime shared by Web conversations, so its calls also
      // acquire one app-global lane. Other native UI surfaces retain their
      // per-session lanes.
      if (lane === "ui" || lane === "node_repl") {
        releaseLanes.push(
          await this.#nativeLanes.acquire(nativeLaneKeys(lane, identity), signal, identity),
        );
      } else if (lane === "shell") {
        releaseLanes.push(await this.#shell.acquire(signal, identity));
      }
      let dispatchAttempted = false;
      try {
        if (effectiveRequest.beforeOperation !== undefined) {
          await effectiveRequest.beforeOperation(signal);
        }
        dispatchAttempted = true;
        await durableLease?.markDispatched();
      } catch (error) {
        if (dispatchAttempted) {
          await durableLease?.markOutcomeUnknown("lease_lost").catch(() => undefined);
        } else {
          await durableLease?.abandonBeforeDispatch().catch(() => undefined);
        }
        throw error;
      }
      try {
        // Caller cancellation can return early, but this lifecycle waits for
        // the actual native promise and owns both durable and in-process release.
        const result = await operation(signal);
        if (
          effectiveRequest.entry.stateEffect === "read" &&
          effectiveRequest.recoverUnknownResourcesWhen?.(result) === true
        ) {
          await this.#resourceLeaseCoordinator?.recoverUnknownResources?.(
            resourceKeys,
            async (lease) => lease.state === "outcome_unknown",
          );
        }
        return result;
      } finally {
        try {
          await durableLease?.settle();
        } finally {
          release();
        }
      }
    } catch (error) {
      if (durableLease !== undefined && !released) {
        await durableLease.abandonBeforeDispatch().catch(() => undefined);
      }
      release();
      throw error;
    }
  }

  #withCurrentContext(request: NativeExecutionRequest): NativeExecutionRequest {
    const context = this.#requestContext.getStore();
    return {
      ...request,
      // Transport-authenticated context is authoritative whenever present;
      // downstream code cannot self-select a cheaper admission identity or
      // under-report the retained HTTP body size.
      ownerId: context?.ownerId ?? request.ownerId ?? LOCAL_OWNER_ID,
      sessionId: context?.sessionId ?? request.sessionId ?? LOCAL_SESSION_ID,
      requestBytes: context?.requestBytes ?? request.requestBytes ?? 0,
      // A transport disconnect is authoritative cancellation only for reads
      // and no-state calls. Mutations continue to settlement so reconnects can
      // read/replay the result without duplicating an ambiguous side effect.
      ...(context?.transportDisconnectSignal === undefined
        ? request.transportDisconnectSignal === undefined
          ? {}
          : { transportDisconnectSignal: request.transportDisconnectSignal }
        : { transportDisconnectSignal: context.transportDisconnectSignal }),
      // Explicit MCP/tool cancellation remains attached independently.
      signal: request.signal,
    };
  }
}

function requiresDurableMutationLease(entry: NativeExecutionDescriptor): boolean {
  // Unknown live tools remain conservative until the authoritative catalog
  // classifies them. Only explicit read/no-state contracts bypass mutation
  // recovery fencing.
  return entry.stateEffect !== "read" && entry.stateEffect !== "none";
}

function transportDisconnectCancelsOperation(entry: NativeExecutionDescriptor): boolean {
  return entry.stateEffect === "read" || entry.stateEffect === "none";
}

function requiresExclusiveResourceLock(entry: NativeExecutionDescriptor): boolean {
  return entry.stateEffect !== "read" && entry.stateEffect !== "none";
}

class ContextualNativeExecutionScheduler extends NativeExecutionScheduler {
  readonly #delegate: NativeExecutionScheduler;
  readonly #enrich: (request: NativeExecutionRequest) => NativeExecutionRequest;

  constructor(
    delegate: NativeExecutionScheduler,
    enrich: (request: NativeExecutionRequest) => NativeExecutionRequest,
  ) {
    super();
    this.#delegate = delegate;
    this.#enrich = enrich;
  }

  override run<T>(
    request: NativeExecutionRequest,
    operation: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.#delegate.run(this.#enrich(request), operation);
  }

  override withRequestContext<T>(
    context: NativeExecutionRequestContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#delegate.withRequestContext(context, operation);
  }

  override contextualView(): NativeExecutionScheduler {
    return this;
  }

  override shutdown(timeoutMs?: number): Promise<void> {
    return this.#delegate.shutdown(timeoutMs);
  }
}

type Lane = "parallel" | "shell" | "ui" | "node_repl";

function nativeExecutionTimeoutClass(
  entry: NativeExecutionDescriptor,
): NativeExecutionTimeoutClass {
  const identity = descriptorIdentity(entry);
  const originalName = entry.originalName.toLowerCase();
  const compactIdentity = identity.replace(/[^a-z0-9]+/g, "");
  if (
    entry.modelEffect === "model" ||
    entry.invokesModel === true ||
    isExplicitModelName(originalName)
  ) {
    return "explicit_model";
  }
  if (/computer.?use|chrome|browser/.test(identity)) return "browser_ui";
  if (
    /node.?repl/.test(identity) ||
    (entry.source.toLowerCase() === "codex_responses_runtime" &&
      entry.nativeNamespace.toLowerCase() === "functions" &&
      originalName === "exec")
  ) {
    return "node_repl";
  }
  if (entry.stateEffect === "read" || entry.stateEffect === "none") {
    return "catalog_read";
  }
  if (isCatalogReadName(originalName)) return "catalog_read";
  if (
    /(?:^|[/_.-])(?:shell|terminal)(?:$|[/_.-])/.test(identity) ||
    compactIdentity.includes("execcommand") ||
    compactIdentity.includes("shellcommand") ||
    compactIdentity.includes("writestdin") ||
    compactIdentity.includes("processstart") ||
    compactIdentity.includes("startprocess") ||
    compactIdentity.includes("spawnprocess") ||
    compactIdentity.includes("launchprocess") ||
    compactIdentity.includes("backgroundstart")
  ) {
    return "shell_background";
  }
  return "catalog_read";
}

function executionLane(entry: NativeExecutionDescriptor): Lane {
  const identity = descriptorIdentity(entry);
  // CUA js/reset/Stop share a persistent kernel just like the native Node REPL.
  // They must not overlap browser work in the same authenticated work session.
  if (isCuaReplLifecycleTool(entry)) return "node_repl";
  if (/computer.?use|chrome|browser/.test(identity)) return "ui";
  // The Responses `functions.exec` runtime is an orchestration container, not
  // the privileged persistent Node REPL used by browser/Computer Use. Its
  // nested tools re-enter this scheduler and must acquire their own exact
  // lanes. Taking the Node REPL lane here makes every nested browser call wait
  // on its own parent forever.
  if (isFunctionsExecOrchestrator(entry)) return "parallel";
  if (
    /node.?repl/.test(identity) ||
    (entry.source.toLowerCase() === "codex_responses_runtime" &&
      entry.nativeNamespace.toLowerCase() === "functions" &&
      entry.originalName.toLowerCase() === "exec")
  ) {
    return "node_repl";
  }
  if (/shell|terminal|exec_command|shell_command/.test(identity)) return "shell";
  return "parallel";
}

function isCuaReplLifecycleTool(entry: NativeExecutionDescriptor): boolean {
  const namespace = entry.nativeNamespace.toLowerCase();
  const name = entry.originalName.toLowerCase();
  return (
    (/^(?:mcp__)?cua_repl$/u.test(namespace) && /^(?:js|js_reset|turn_ended)$/u.test(name)) ||
    /^(?:codex__)?(?:mcp__)?cua_repl__(?:js|js_reset|turn_ended)$/u.test(name)
  );
}

function isFunctionsExecOrchestrator(entry: NativeExecutionDescriptor): boolean {
  return (
    entry.source.toLowerCase() === "codex_responses_runtime" &&
    entry.nativeNamespace.toLowerCase() === "functions" &&
    entry.originalName.toLowerCase() === "exec"
  );
}

function durableNativeResourceKeys(
  entry: NativeExecutionDescriptor,
  ordering: NativeExecutionOrdering,
  lane: Lane,
  identity: NativeExecutionIdentity,
  operationId: string,
): readonly string[] {
  const nativeScope = nativeExecutionScope(identity);
  const canonical = canonicalNativeResourceKeys(ordering).filter(
    // The surface selector is represented by the per-session lane below.
    // Keep explicit tab/window identities global so only callers targeting
    // the same browser resource serialize across conversations.
    (key) => lane !== "ui" || !key.startsWith("4:surface:"),
  );
  if (lane === "ui") {
    if (isComputerUseDesktopMutation(entry)) {
      // Browser Use drives independent CDP sessions and tabs, but Computer
      // Use ultimately shares one physical Windows pointer and keyboard.
      // Serialize only those mutating desktop-input calls globally; reads and
      // browser DOM/CDP calls retain per-conversation concurrency.
      canonical.push("0:lane:desktop-input");
    }
    // Explicit tab/window keys remain global. Every other UI runtime is
    // scoped to its authenticated conversation.
    canonical.push(`0:lane:node_repl:${nativeScope}`, `0:lane:ui:${nativeScope}`);
  } else if (lane === "node_repl") {
    canonical.push(`0:lane:node_repl:${nativeScope}`);
  }
  // A tool name is not a shared resource. Keep keyless operations durable
  // without serializing independent calls of that tool. Exact retries retain
  // the same operation key and remain subject to the durable operation claim.
  if (canonical.length === 0) {
    canonical.push(`9:operation:${createHash("sha256").update(operationId).digest("hex")}`);
  }
  return [...new Set(canonical)].sort();
}

function isComputerUseDesktopMutation(entry: NativeExecutionDescriptor): boolean {
  return (
    entry.stateEffect !== "read" &&
    entry.stateEffect !== "none" &&
    /computer.?use/u.test(descriptorIdentity(entry))
  );
}

function nativeLaneKeys(
  lane: Extract<Lane, "ui" | "node_repl">,
  identity: NativeExecutionIdentity,
): readonly string[] {
  const scope = nativeExecutionScope(identity);
  if (lane !== "ui") return [`0:node_repl:${scope}`];
  return [`1:node_repl:${scope}`, `2:ui:${scope}`];
}

function nativeExecutionScope(identity: NativeExecutionIdentity): string {
  return createHash("sha256")
    .update(`${identity.ownerId}\0${identity.sessionId}`, "utf8")
    .digest("hex");
}

function descriptorIdentity(entry: NativeExecutionDescriptor): string {
  return `${entry.nativeNamespace}/${entry.originalName}/${entry.source}`.toLowerCase();
}

function isExplicitModelName(originalName: string): boolean {
  return EXPLICIT_MODEL_NATIVE_NAMES.has(originalName);
}

function isCatalogReadName(originalName: string): boolean {
  return originalName
    .split(/[^a-z0-9]+/)
    .some((segment) =>
      /^(?:capture|find|get|inspect|list|load|read|search|status|view|wait)/.test(segment),
    );
}

/**
 * One canonical resource identity contract shared by scheduler locking and
 * durable Direct Goal evidence. Returned keys can contain native opaque ids
 * and therefore must be hashed before persistence.
 */
export function canonicalNativeResourceKeys(
  ordering: NativeExecutionOrdering,
  options: CanonicalNativeResourceKeyOptions = {},
): readonly string[] {
  const basePath = canonicalWindowsPath(options.basePath ?? process.cwd());
  const workspacePaths = canonicalPathSet(ordering.workspacePaths, basePath);
  const projectPaths = canonicalPathSet(ordering.projectPaths, workspacePaths[0] ?? basePath);
  const resourceBase = projectPaths[0] ?? workspacePaths[0] ?? basePath;
  const identityValue = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const normalized = value.trim();
    if (normalized.length === 0 || /[\0\r\n]/u.test(normalized)) return undefined;
    return normalized;
  };
  const identity = (prefix: string, value: string | undefined, lower = false): string[] => {
    const normalized = identityValue(value);
    if (normalized === undefined) return [];
    return [`${prefix}:${lower ? normalized.toLocaleLowerCase("en-US") : normalized}`];
  };
  const browserId = identityValue(ordering.browserId);
  const tabId = identityValue(ordering.tabId);
  const browserTarget =
    tabId === undefined
      ? browserId === undefined
        ? []
        : [`4:browser:${browserId}`]
      : browserId === undefined
        ? [`4:tab:${tabId}`]
        : [`4:browser-tab:${canonicalJson([browserId, tabId])}`];
  return [
    ...workspacePaths.map((path) => `0:workspace:${path}`),
    ...projectPaths.map((path) => `0:project:${path}`),
    ...identity("1:thread", ordering.threadId),
    ...identity("2:process", ordering.processId),
    ...identity("2:session", ordering.sessionId),
    ...identity("2:cell", ordering.cellId),
    ...identity("2:device", ordering.deviceSerial),
    ...canonicalPathSet(ordering.filePaths, resourceBase).map((path) => `3:file:${path}`),
    ...canonicalPathSet(ordering.scenePaths, resourceBase).map((path) => `3:scene:${path}`),
    ...identity("4:surface", ordering.surface, true),
    ...browserTarget,
    ...identity("4:window", ordering.windowId),
  ]
    .filter((key, index, keys) => keys.indexOf(key) === index)
    .sort();
}

/** Windows paths are case/slash/trailing-separator equivalent for locking. */
export function canonicalWindowsPath(path: string, base?: string): string {
  const resolved = resolveWindowsPath(path, base);
  const normalized = windowsPath
    .normalize(resolved.replaceAll("/", "\\"))
    .toLocaleLowerCase("en-US");
  const root = windowsPath.parse(normalized).root;
  return normalized.length > root.length ? normalized.replace(/[\\]+$/u, "") : normalized;
}

function canonicalPathSet(paths: readonly string[] | undefined, base: string): string[] {
  if (paths === undefined) return [];
  return [
    ...new Set(
      paths.flatMap((path) => {
        if (typeof path !== "string" || path.trim().length === 0 || /\0/u.test(path)) return [];
        return [canonicalWindowsPath(path, base)];
      }),
    ),
  ].sort();
}

function resolveWindowsPath(path: string, base?: string): string {
  const trimmed = path.trim();
  if (windowsPath.isAbsolute(trimmed)) return windowsPath.normalize(trimmed);
  return windowsPath.resolve(base ?? process.cwd(), trimmed);
}

function applyPatchPaths(body: string): readonly string[] {
  const paths: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    const candidate = match?.[1] ?? move?.[1];
    if (candidate === undefined) continue;
    const trimmed = candidate.trim();
    if (trimmed.length > 0 && !/[\0\r\n]/.test(trimmed)) paths.push(trimmed);
  }
  return [...new Set(paths)];
}

class KeyedSequencer {
  readonly #locks = new Map<string, FairSemaphore>();

  async acquire(
    keys: readonly string[],
    signal: AbortSignal | undefined,
    identity: NativeExecutionIdentity,
  ): Promise<() => void> {
    const releases: Array<() => void> = [];
    try {
      for (const key of keys) {
        let lock = this.#locks.get(key);
        if (lock === undefined) {
          lock = new FairSemaphore(1, () => this.#locks.delete(key));
          this.#locks.set(key, lock);
        }
        releases.push(await lock.acquire(signal, identity));
      }
      return () => {
        for (const release of releases.reverse()) release();
      };
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }
  }
}

interface SemaphoreWaiter extends NativeExecutionIdentity {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal | undefined;
  abort?: () => void;
}

class FairSemaphore {
  readonly #limit: number;
  readonly #onIdle: (() => void) | undefined;
  #active = 0;
  readonly #queue: SemaphoreWaiter[] = [];
  #lastOwnerId: string | undefined;
  readonly #lastSessionByOwner = new Map<string, string>();

  constructor(limit: number, onIdle?: () => void) {
    this.#limit = positiveInteger(limit, "Semaphore limit");
    this.#onIdle = onIdle;
  }

  acquire(
    signal?: AbortSignal,
    identity: NativeExecutionIdentity = {
      ownerId: LOCAL_OWNER_ID,
      sessionId: LOCAL_SESSION_ID,
    },
  ): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const waiter: SemaphoreWaiter = { ...identity, resolve, reject, signal };
      if (signal !== undefined) {
        waiter.abort = () => {
          const index = this.#queue.indexOf(waiter);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(abortError());
          this.#notifyIdle();
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.#queue.push(waiter);
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#active < this.#limit) {
      const waiter = this.#takeNextFairWaiter();
      if (waiter === undefined) break;
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      if (waiter.abort !== undefined) waiter.signal?.removeEventListener("abort", waiter.abort);
      this.#active += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.#active -= 1;
        this.#drain();
        this.#notifyIdle();
      });
    }
  }

  #takeNextFairWaiter(): SemaphoreWaiter | undefined {
    if (this.#queue.length === 0) return undefined;
    const owners = uniqueInOrder(this.#queue.map((waiter) => waiter.ownerId));
    const ownerId = nextAfter(owners, this.#lastOwnerId);
    const ownerWaiters = this.#queue.filter((waiter) => waiter.ownerId === ownerId);
    const sessions = uniqueInOrder(ownerWaiters.map((waiter) => waiter.sessionId));
    const sessionId = nextAfter(sessions, this.#lastSessionByOwner.get(ownerId));
    const index = this.#queue.findIndex(
      (waiter) => waiter.ownerId === ownerId && waiter.sessionId === sessionId,
    );
    const [waiter] = this.#queue.splice(index, 1);
    this.#lastOwnerId = ownerId;
    this.#lastSessionByOwner.set(ownerId, sessionId);
    return waiter;
  }

  #notifyIdle(): void {
    if (this.#active !== 0 || this.#queue.length !== 0) return;
    this.#lastOwnerId = undefined;
    this.#lastSessionByOwner.clear();
    this.#onIdle?.();
  }
}

interface BoundedAdmissionOptions {
  readonly globalMaxRequests: number | undefined;
  readonly globalMaxRequestBytes: number | undefined;
  readonly sessionMaxRequests: number | undefined;
  readonly sessionMaxRequestBytes: number | undefined;
  readonly overloadRetryAfterMs: number;
}

interface AdmissionUsage {
  requests: number;
  bytes: number;
}

class BoundedAdmission {
  readonly #options: BoundedAdmissionOptions;
  readonly #sessions = new Map<string, AdmissionUsage>();
  #globalRequests = 0;
  #globalBytes = 0;

  constructor(options: BoundedAdmissionOptions) {
    this.#options = options;
  }

  admit(identity: NativeExecutionIdentity, requestBytes: number): { release(): void } {
    const bytes = nonNegativeInteger(requestBytes, "Native request bytes");
    const key = `${identity.ownerId}\0${identity.sessionId}`;
    const session = this.#sessions.get(key) ?? { requests: 0, bytes: 0 };
    if (
      exceedsOptionalLimit(this.#globalRequests, 1, this.#options.globalMaxRequests) ||
      exceedsOptionalLimit(this.#globalBytes, bytes, this.#options.globalMaxRequestBytes) ||
      exceedsOptionalLimit(session.requests, 1, this.#options.sessionMaxRequests) ||
      exceedsOptionalLimit(session.bytes, bytes, this.#options.sessionMaxRequestBytes)
    ) {
      throw new NativeExecutionOverloadedError(this.#options.overloadRetryAfterMs);
    }
    this.#globalRequests += 1;
    this.#globalBytes += bytes;
    session.requests += 1;
    session.bytes += bytes;
    this.#sessions.set(key, session);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#globalRequests -= 1;
        this.#globalBytes -= bytes;
        session.requests -= 1;
        session.bytes -= bytes;
        if (session.requests === 0) this.#sessions.delete(key);
      },
    };
  }
}

function executionIdentity(request: NativeExecutionRequest): NativeExecutionIdentity {
  return {
    ownerId: validIdentity(request.ownerId, LOCAL_OWNER_ID),
    sessionId: validIdentity(request.sessionId, LOCAL_SESSION_ID),
  };
}

function validateRequestContext(
  context: NativeExecutionRequestContext,
): NativeExecutionRequestContext {
  return {
    ownerId: validIdentity(context.ownerId, LOCAL_OWNER_ID),
    sessionId: validIdentity(context.sessionId, LOCAL_SESSION_ID),
    requestBytes: nonNegativeInteger(context.requestBytes, "Native request bytes"),
    ...(context.transportDisconnectSignal === undefined
      ? {}
      : { transportDisconnectSignal: context.transportDisconnectSignal }),
  };
}

function validIdentity(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  if (value.length < 1 || value.length > 4_096 || /[\0\r\n]/.test(value)) {
    throw new TypeError("Native execution identity is invalid");
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be positive`);
  return value;
}

function optionalPositiveInteger(value: number | undefined, label: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, label);
}

function exceedsOptionalLimit(
  retained: number,
  incoming: number,
  limit: number | undefined,
): boolean {
  return limit !== undefined && retained + incoming > limit;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function nextAfter(values: readonly string[], previous: string | undefined): string {
  if (values.length === 0) throw new Error("Fair queue has no candidates");
  if (previous === undefined) return values[0] as string;
  const index = values.indexOf(previous);
  return values[index < 0 ? 0 : (index + 1) % values.length] as string;
}

async function withCancellation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw abortError();
  if (signal === undefined) return operation;
  let abortListener: (() => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(abortError());
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    return await Promise.race([operation, boundary]);
  } finally {
    if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
  }
}

function combineAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  const signals = [first, second].filter((value): value is AbortSignal => value !== undefined);
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

async function settleAllBefore(
  operations: readonly Promise<unknown>[],
  timeoutMs: number,
): Promise<boolean> {
  if (operations.length === 0) return true;
  const deadlineUnixMs = safeDeadlineAfter(Date.now(), timeoutMs);
  let cancelDeadline: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(operations).then(() => true),
      new Promise<false>((resolveTimeout) => {
        cancelDeadline = scheduleDeadline(deadlineUnixMs, () => resolveTimeout(false));
      }),
    ]);
  } finally {
    cancelDeadline?.();
  }
}

function acquisitionBoundary(
  deadlineUnixMs: number | undefined,
  signal?: AbortSignal,
): {
  readonly signal: AbortSignal | undefined;
  clear(): void;
  timedOut(): boolean;
} {
  if (deadlineUnixMs === undefined && signal === undefined) {
    return { signal: undefined, clear: () => undefined, timedOut: () => false };
  }
  const controller = new AbortController();
  let timeoutExpired = false;
  const abortFromCaller = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const cancelDeadline =
    deadlineUnixMs === undefined
      ? undefined
      : scheduleDeadline(deadlineUnixMs, () => {
          timeoutExpired = true;
          controller.abort();
        });
  return {
    signal: controller.signal,
    clear: () => {
      cancelDeadline?.();
      signal?.removeEventListener("abort", abortFromCaller);
    },
    timedOut: () => timeoutExpired && signal?.aborted !== true,
  };
}

interface CallerCompletionBoundary {
  readonly deadlineUnixMs: number | undefined;
  readonly kind: "none" | "timeout" | "deadline";
  readonly timeoutMs: number | undefined;
}

function resolveCallerCompletionBoundary(
  timeoutMs: number | undefined,
  deadlineUnixMs: number | undefined,
): CallerCompletionBoundary {
  const nowUnixMs = Date.now();
  const explicitDeadline =
    deadlineUnixMs === undefined
      ? undefined
      : positiveInteger(deadlineUnixMs, "Native caller deadlineUnixMs");
  const timeoutDeadline =
    timeoutMs === undefined ? undefined : safeDeadlineAfter(nowUnixMs, timeoutMs);
  if (explicitDeadline === undefined && timeoutDeadline === undefined) {
    return { deadlineUnixMs: undefined, kind: "none", timeoutMs: undefined };
  }
  if (
    explicitDeadline !== undefined &&
    (timeoutDeadline === undefined || explicitDeadline <= timeoutDeadline)
  ) {
    return { deadlineUnixMs: explicitDeadline, kind: "deadline", timeoutMs };
  }
  return { deadlineUnixMs: timeoutDeadline, kind: "timeout", timeoutMs };
}

function safeDeadlineAfter(nowUnixMs: number, timeoutMs: number): number {
  if (timeoutMs > Number.MAX_SAFE_INTEGER - nowUnixMs) {
    throw new TypeError("Native caller timeout exceeds the representable deadline range");
  }
  return nowUnixMs + timeoutMs;
}

function completionBoundaryError(boundary: CallerCompletionBoundary): Error {
  if (boundary.kind === "timeout" && boundary.timeoutMs !== undefined) {
    return new Error(
      `Native tool timed out after ${Math.max(1, Math.trunc(boundary.timeoutMs))}ms`,
    );
  }
  return new Error(`Native tool deadline exceeded at ${String(boundary.deadlineUnixMs)}`);
}

function scheduleDeadline(deadlineUnixMs: number, expire: () => void): () => void {
  const maximumTimerDelayMs = 2_147_483_647;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const arm = () => {
    if (cancelled) return;
    const remainingMs = deadlineUnixMs - Date.now();
    if (remainingMs <= 0) {
      expire();
      return;
    }
    timer = setTimeout(arm, Math.min(remainingMs, maximumTimerDelayMs));
    timer.unref?.();
  };
  arm();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

function abortError(): Error {
  const error = new Error("Native tool call cancelled");
  error.name = "AbortError";
  return error;
}
