import { createHash, randomUUID } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { canonicalJson } from "../infrastructure/safety/canonical-json.js";
import { toolForCatalogConvergence } from "./native-tool-convergence.js";
import { omniCodexServerIdentity } from "./native-tool-server-identity.js";

export interface AppServerRpcRequestOptions {
  /** Exact caller-supplied completion timeout. Omit to wait indefinitely. */
  readonly timeoutMs?: number;
  /** Exact caller-supplied absolute completion deadline. */
  readonly deadlineUnixMs?: number;
  /** Exact caller cancellation boundary. */
  readonly signal?: AbortSignal;
  /**
   * Keep a dispatched request pending until its authoritative transport
   * settlement. Mutations use this so a cancelled caller cannot release its
   * scheduler lane while the App Server outcome is still ambiguous.
   */
  readonly awaitResponseAfterCancellation?: boolean;
}

export interface AppServerRpcClient {
  request<T>(
    method: string,
    params: unknown,
    timeoutOrOptions?: number | AppServerRpcRequestOptions,
  ): Promise<T>;
  /** Subscribe to metadata/results emitted by this owned App Server connection. */
  subscribeNotifications?(listener: (message: Record<string, unknown>) => void): () => void;
}

export interface NativeToolDescriptor {
  readonly exposedName: string;
  readonly server: string;
  readonly originalName: string;
  readonly tool: Tool;
  /** Exact upstream descriptor before MCP naming, schema, or routing projection. */
  readonly nativeTool?: Readonly<Record<string, unknown>>;
  /** True only when this tool carries this deployment's exact identity marker. */
  readonly selfReferential?: boolean;
}

export interface NativeToolCatalogSnapshot {
  readonly refreshedAtUnixMs: number;
  readonly servers: readonly string[];
  readonly tools: readonly NativeToolDescriptor[];
  /** Exact upstream inventory failures; these do not fabricate callable tools. */
  readonly serverErrors?: readonly NativeToolServerError[];
}

export interface NativeToolServerError {
  readonly server: string;
  readonly toolsError: string;
}

export interface NativeToolCatalogOptions {
  readonly reservedNames?: readonly string[];
  readonly maxPages?: number;
  readonly pageSize?: number;
  /** Stable marker advertised by this exact OmniCodex deployment. */
  readonly selfServerIdentity?: string;
  /** Exact configured MCP server name used when the host strips tool metadata. */
  readonly selfServerName?: string;
}

export interface NativeToolCatalogRefreshOptions {
  /** Cancels catalog discovery without publishing a partially observed pass. */
  readonly signal?: AbortSignal;
}

export type NativeToolCatalogIncompatibilityStage =
  | "response"
  | "response.data"
  | "response.nextCursor"
  | "server"
  | "server.name"
  | "server.tools"
  | "rawTool"
  | "rawTool.name";

export interface NativeToolCatalogRawShape {
  readonly kind:
    | "array"
    | "bigint"
    | "boolean"
    | "function"
    | "null"
    | "number"
    | "object"
    | "string"
    | "symbol"
    | "undefined";
  readonly length?: number;
  readonly keys?: readonly string[];
  readonly fields?: Readonly<Record<string, NativeToolCatalogRawShape["kind"]>>;
}

export interface NativeToolCatalogIncompatibilityDetails {
  readonly stage: NativeToolCatalogIncompatibilityStage;
  /** One-based page number within the failed full-catalog pass. */
  readonly page: number;
  readonly cursor?: string;
  readonly serverIndex?: number;
  readonly serverName?: string;
  readonly toolIndex?: number;
  readonly toolKey?: string;
  readonly rawShape: NativeToolCatalogRawShape;
}

/** A lossless inventory refresh cannot interpret the App Server's advertised shape. */
export class NativeToolCatalogIncompatibilityError extends Error {
  readonly code = "NATIVE_TOOL_CATALOG_INCOMPATIBLE";
  readonly details: NativeToolCatalogIncompatibilityDetails;

  constructor(details: NativeToolCatalogIncompatibilityDetails) {
    const provenance = [
      `page=${details.page}`,
      ...(details.cursor === undefined ? [] : [`cursor=${details.cursor}`]),
      ...(details.serverIndex === undefined ? [] : [`serverIndex=${details.serverIndex}`]),
      ...(details.serverName === undefined ? [] : [`server=${details.serverName}`]),
      ...(details.toolIndex === undefined ? [] : [`toolIndex=${details.toolIndex}`]),
      ...(details.toolKey === undefined ? [] : [`tool=${details.toolKey}`]),
    ].join(", ");
    super(`Native MCP catalog is incompatible at ${details.stage} (${provenance})`);
    this.name = "NativeToolCatalogIncompatibilityError";
    this.details = details;
  }
}

interface McpServerStatus {
  readonly name: string;
  readonly tools: Readonly<Record<string, unknown>>;
  readonly toolsError?: string;
}

interface LocatedMcpServerStatus {
  readonly status: McpServerStatus;
  readonly page: number;
  readonly cursor?: string;
  readonly serverIndex: number;
}

interface NativeToolCatalogPass {
  readonly digest: string;
  readonly servers: readonly string[];
  readonly tools: readonly NativeToolDescriptor[];
  readonly serverErrors: readonly NativeToolServerError[];
}

/** Reads the actual downstream MCP inventory advertised by the installed App Server. */
export class NativeToolCatalog {
  readonly #client: AppServerRpcClient;
  readonly #reservedNames: ReadonlySet<string>;
  readonly #maxPages: number | undefined;
  readonly #pageSize: number;
  readonly #selfServerIdentity: string | undefined;
  readonly #selfServerName: string | undefined;
  #snapshot: NativeToolCatalogSnapshot = {
    refreshedAtUnixMs: 0,
    servers: [],
    tools: [],
  };
  readonly #prepareFlights = new Map<string | undefined, Promise<NativeToolCatalogSnapshot>>();
  readonly #refreshFlights = new Map<string | undefined, Promise<NativeToolCatalogSnapshot>>();
  readonly #stablePassDigests = new Map<string | undefined, string>();

  constructor(client: AppServerRpcClient, options: NativeToolCatalogOptions = {}) {
    this.#client = client;
    this.#reservedNames = new Set(options.reservedNames ?? []);
    this.#maxPages = optionalPositiveInteger(options.maxPages, "page count");
    this.#pageSize = positiveInteger(options.pageSize ?? 1_000, "page size");
    this.#selfServerIdentity = options.selfServerIdentity;
    this.#selfServerName = options.selfServerName?.trim().toLocaleLowerCase();
  }

  get snapshot(): NativeToolCatalogSnapshot {
    return this.#snapshot;
  }

  refresh(
    threadId?: string,
    options: NativeToolCatalogRefreshOptions = {},
  ): Promise<NativeToolCatalogSnapshot> {
    const existing = this.#refreshFlights.get(threadId);
    if (existing !== undefined) return existing;
    let refresh!: Promise<NativeToolCatalogSnapshot>;
    refresh = this.prepareRefresh(threadId, options)
      .then((snapshot) => {
        this.commitRefresh(snapshot);
        return snapshot;
      })
      .finally(() => {
        if (this.#refreshFlights.get(threadId) === refresh) {
          this.#refreshFlights.delete(threadId);
        }
      });
    this.#refreshFlights.set(threadId, refresh);
    return refresh;
  }

  /** Discover one stable generation without changing the currently published snapshot. */
  prepareRefresh(
    threadId?: string,
    options: NativeToolCatalogRefreshOptions = {},
  ): Promise<NativeToolCatalogSnapshot> {
    const existing = this.#prepareFlights.get(threadId);
    if (existing !== undefined) {
      return existing;
    }

    const discovery = this.#discoverStable(threadId, options.signal);
    const refresh = discovery.finally(() => {
      if (this.#prepareFlights.get(threadId) === refresh) {
        this.#prepareFlights.delete(threadId);
      }
    });
    this.#prepareFlights.set(threadId, refresh);
    return refresh;
  }

  /** Publish a previously prepared snapshot synchronously. */
  commitRefresh(snapshot: NativeToolCatalogSnapshot): void {
    this.#snapshot = snapshot;
  }

  async #discoverStable(
    threadId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<NativeToolCatalogSnapshot> {
    let previousDigest = this.#stablePassDigests.get(threadId);
    while (true) {
      throwIfAborted(signal);
      const current = await this.#discoverPass(threadId, signal);
      throwIfAborted(signal);
      if (previousDigest === current.digest) {
        this.#stablePassDigests.set(threadId, current.digest);
        const snapshot: NativeToolCatalogSnapshot = {
          refreshedAtUnixMs: Date.now(),
          servers: current.servers,
          tools: current.tools,
          serverErrors: current.serverErrors,
        };
        return snapshot;
      }
      previousDigest = current.digest;
    }
  }

  async #discoverPass(
    threadId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<NativeToolCatalogPass> {
    const statuses: LocatedMcpServerStatus[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let page = 0;
    while (true) {
      throwIfAborted(signal);
      if (this.#maxPages !== undefined && page >= this.#maxPages) {
        throw new Error("Native MCP catalog exceeded the caller page limit");
      }
      page += 1;
      const params = {
        detail: "full",
        limit: this.#pageSize,
        ...(cursor === undefined ? {} : { cursor }),
        ...(threadId === undefined ? {} : { threadId }),
      };
      const response = await this.#client.request<unknown>(
        "mcpServerStatus/list",
        params,
        signal === undefined ? undefined : { signal },
      );
      throwIfAborted(signal);
      if (!isObject(response)) {
        throw incompatibility("response", page, cursor, response);
      }
      if (!Array.isArray(response.data)) {
        throw incompatibility("response.data", page, cursor, response.data);
      }
      for (const [serverIndex, item] of response.data.entries()) {
        if (!isObject(item)) {
          throw incompatibility("server", page, cursor, item, { serverIndex });
        }
        if (typeof item.name !== "string" || item.name.length === 0) {
          throw incompatibility("server.name", page, cursor, item.name, { serverIndex });
        }
        if (!isObject(item.tools)) {
          throw incompatibility("server.tools", page, cursor, item.tools, {
            serverIndex,
            serverName: item.name,
          });
        }
        statuses.push({
          status: {
            name: item.name,
            tools: item.tools,
            ...(typeof item.toolsError === "string" && item.toolsError.length > 0
              ? { toolsError: item.toolsError }
              : {}),
          },
          page,
          ...(cursor === undefined ? {} : { cursor }),
          serverIndex,
        });
      }
      const rawNext = response.nextCursor;
      if (
        rawNext !== undefined &&
        rawNext !== null &&
        (typeof rawNext !== "string" || rawNext.length === 0)
      ) {
        throw incompatibility("response.nextCursor", page, cursor, rawNext);
      }
      const next = typeof rawNext === "string" ? rawNext : undefined;
      if (next === undefined) {
        break;
      }
      if (seenCursors.has(next)) {
        throw new Error("Native MCP catalog repeated a pagination cursor");
      }
      seenCursors.add(next);
      cursor = next;
    }

    const serverNames = statuses
      .map(({ status }) => status.name)
      .sort((left, right) => left.localeCompare(right));
    const rawTools: Array<{
      readonly server: string;
      readonly originalName: string;
      readonly tool: Tool;
      readonly nativeTool: Record<string, unknown>;
    }> = [];
    for (const located of statuses) {
      const server = located.status.name;
      const entries = Object.entries(located.status.tools);
      for (const [toolIndex, [originalName, rawTool]] of entries.entries()) {
        if (!isObject(rawTool)) {
          throw incompatibility("rawTool", located.page, located.cursor, rawTool, {
            serverIndex: located.serverIndex,
            serverName: server,
            toolIndex,
            toolKey: originalName,
          });
        }
        if (
          rawTool.name !== undefined &&
          (typeof rawTool.name !== "string" || rawTool.name.length === 0)
        ) {
          throw incompatibility("rawTool.name", located.page, located.cursor, rawTool.name, {
            serverIndex: located.serverIndex,
            serverName: server,
            toolIndex,
            toolKey: originalName,
          });
        }
        const tool = normalizeTool(rawTool, originalName);
        const nativeName = typeof rawTool.name === "string" ? rawTool.name : originalName;
        rawTools.push({
          server,
          originalName: nativeName,
          tool,
          nativeTool: structuredClone(rawTool),
        });
      }
    }

    const counts = new Map<string, number>();
    for (const item of rawTools) {
      counts.set(item.originalName, (counts.get(item.originalName) ?? 0) + 1);
    }
    const tools = rawTools
      .sort(
        (left, right) =>
          left.server.localeCompare(right.server) ||
          left.originalName.localeCompare(right.originalName),
      )
      .map((item) => {
        const canPreserve =
          !isGenericReplToolName(item.originalName) &&
          counts.get(item.originalName) === 1 &&
          isMcpToolName(item.originalName) &&
          !this.#reservedNames.has(item.originalName);
        const exposedName = canPreserve
          ? item.originalName
          : namespacedToolName(item.server, item.originalName);
        return {
          exposedName,
          server: item.server,
          originalName: item.originalName,
          nativeTool: item.nativeTool,
          tool: withOmniMetadata(item.tool, {
            exposedName,
            server: item.server,
            originalName: item.originalName,
          }),
          ...((this.#selfServerIdentity !== undefined &&
            omniCodexServerIdentity(item.tool) === this.#selfServerIdentity) ||
          (this.#selfServerName !== undefined &&
            (item.server.trim().toLocaleLowerCase() === this.#selfServerName ||
              item.originalName.trim().toLocaleLowerCase().startsWith(`${this.#selfServerName}.`)))
            ? { selfReferential: true }
            : {}),
        };
      });

    const pass = {
      servers: [...new Set(serverNames)],
      tools,
      serverErrors: statuses
        .flatMap(({ status }) =>
          status.toolsError === undefined
            ? []
            : [{ server: status.name, toolsError: status.toolsError }],
        )
        .sort((left, right) => left.server.localeCompare(right.server)),
    };
    return {
      ...pass,
      // Failure messages, icons and optional plugin provenance may vary between
      // reads without a change to the callable tool contract.
      digest: createHash("sha256")
        .update(
          canonicalJson({ servers: pass.servers, tools: pass.tools.map(catalogConvergenceTool) }),
          "utf8",
        )
        .digest("hex"),
    };
  }
}

function catalogConvergenceTool(descriptor: NativeToolDescriptor): Record<string, unknown> {
  return {
    ...descriptor,
    tool: toolForCatalogConvergence(descriptor.tool),
    ...(descriptor.nativeTool === undefined
      ? {}
      : { nativeTool: toolForCatalogConvergence(descriptor.nativeTool) }),
  };
}

export interface NativeToolExecutorOptions {
  readonly threadId?: string;
  readonly cwd?: string;
  readonly ensureThread?: () => Promise<string>;
  /** The registered local Work executor; browser access still checks Work settings. */
  readonly resolveWorkExecutorId?: () => Promise<string>;
  /** The active Computer Use plugin server, with the same registered Work executor. */
  readonly resolveCuaServerConfig?: (
    workExecutorId: string,
  ) => Promise<Record<string, unknown> | undefined>;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly threadSource?: string;
  readonly workspaceKind?: string;
}

export interface NativeToolProgressEvent {
  readonly nativeMethod: "item/mcpToolCall/progress";
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly message: string;
  readonly sequence: number;
}

/** Calls an App Server MCP tool directly, creating an ephemeral context only when needed. */
export class NativeToolExecutor {
  readonly #client: AppServerRpcClient;
  readonly #options: NativeToolExecutorOptions;
  #ephemeralThreadId: string | undefined;
  #ephemeralThreadPromise: Promise<string> | undefined;
  #threadWorkExecutorId: string | undefined;
  #defaultThreadTail: Promise<void> = Promise.resolve();

  constructor(client: AppServerRpcClient, options: NativeToolExecutorOptions = {}) {
    this.#client = client;
    this.#options = options;
  }

  /** Stable identity for state that follows this executor across transport wrappers. */
  executionContextIdentity(): object {
    return this;
  }

  async call(
    server: string,
    tool: string,
    argumentsValue: unknown,
    threadId = this.#options.threadId,
    onProgress?: (event: NativeToolProgressEvent) => Promise<void> | void,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (threadId !== undefined) {
      return this.#callOnThread(
        server,
        tool,
        argumentsValue,
        threadId,
        onProgress,
        threadId,
        undefined,
        signal,
      );
    }
    return this.#runOnDefaultThread(async () => {
      return this.#callOnOwnedEphemeralThread(
        server,
        tool,
        argumentsValue,
        onProgress,
        undefined,
        undefined,
        signal,
      );
    }, signal);
  }

  /**
   * Runs a native tool on the executor-owned ephemeral thread while presenting
   * a separate Codex UI session identity to session-scoped native services.
   * This keeps the desktop thread writer single-owned and still lets services
   * such as the in-app browser resolve their UI-backed surface.
   */
  async callInContext(
    server: string,
    tool: string,
    argumentsValue: unknown,
    contextThreadId?: string,
    onProgress?: (event: NativeToolProgressEvent) => Promise<void> | void,
    contextTurnId?: string,
    signal?: AbortSignal,
    contextSessionId?: string,
  ): Promise<unknown> {
    return this.#runOnDefaultThread(async () => {
      return this.#callOnOwnedEphemeralThread(
        server,
        tool,
        argumentsValue,
        onProgress,
        contextThreadId,
        contextTurnId,
        signal,
        contextSessionId,
      );
    }, signal);
  }

  /**
   * Immediately retires only the in-memory execution thread created by this
   * executor. User and UI threads supplied to call/callInContext are never
   * touched. A later call transparently creates a fresh ephemeral thread.
   */
  async retireOwnedExecutionThread(): Promise<void> {
    if (this.#options.ensureThread !== undefined) return;
    await this.#runOnDefaultThread(async () => {
      const threadId = this.#ephemeralThreadId;
      if (threadId === undefined) return;
      try {
        await this.#client.request(
          "thread/delete",
          { threadId },
          { awaitResponseAfterCancellation: true },
        );
      } catch (error) {
        if (isMissingOwnedExecutionThread(error, threadId)) {
          this.#forgetOwnedExecutionThread(threadId);
          return;
        }
        if (!isNonDeletableEphemeralThread(error, threadId)) throw error;

        // Current App Server versions intentionally reject thread/delete for
        // ephemeral threads.  Clearing the cached id before that rejection
        // orphaned the live MCP runtime and caused every later call to spawn a
        // second node_repl/plugin tree.  Unsubscribe is the supported lifecycle
        // path: the same loaded thread remains reusable and App Server unloads
        // it after its own idle period.  Only forget the id when App Server
        // authoritatively reports that the thread is already unloaded.
        const response = await this.#client.request<unknown>(
          "thread/unsubscribe",
          { threadId },
          { awaitResponseAfterCancellation: true },
        );
        if (
          isObject(response) &&
          response.status === "notLoaded" &&
          this.#ephemeralThreadId === threadId
        ) {
          this.#forgetOwnedExecutionThread(threadId);
        }
        return;
      }
      this.#forgetOwnedExecutionThread(threadId);
    });
  }

  /**
   * Forgets only the process-local ephemeral thread identity after the owner has
   * authoritatively stopped the App Server process that contained it.  This is
   * deliberately synchronous and performs no RPC: once the process has exited,
   * attempting thread/delete or thread/unsubscribe against its closed transport
   * cannot add evidence and can only delay disposal.
   */
  clearOwnedExecutionThreadAfterProcessStop(): void {
    if (this.#options.ensureThread !== undefined) return;
    this.#ephemeralThreadId = undefined;
    this.#ephemeralThreadPromise = undefined;
    this.#threadWorkExecutorId = undefined;
  }

  #forgetOwnedExecutionThread(threadId: string): void {
    if (this.#ephemeralThreadId !== threadId) return;
    this.#ephemeralThreadId = undefined;
    this.#threadWorkExecutorId = undefined;
  }

  async #callOnOwnedEphemeralThread(
    server: string,
    tool: string,
    argumentsValue: unknown,
    onProgress?: (event: NativeToolProgressEvent) => Promise<void> | void,
    contextThreadId?: string,
    contextTurnId?: string,
    signal?: AbortSignal,
    contextSessionId?: string,
  ): Promise<unknown> {
    const executionThreadId = await this.#ensureEphemeralThread(signal);
    try {
      return await this.#callOnThread(
        server,
        tool,
        argumentsValue,
        executionThreadId,
        onProgress,
        contextThreadId ?? executionThreadId,
        contextTurnId,
        signal,
        this.#options.ensureThread === undefined,
        contextSessionId,
      );
    } catch (error) {
      // Restartable App Server transports can reconnect after their process
      // exits while this executor still holds the old process-local ephemeral
      // thread id. A matching `thread not found` rejects before the native tool
      // is dispatched, so replacing only that owned execution context is safe
      // for both reads and mutations and cannot duplicate a completed action.
      if (!isMissingOwnedExecutionThread(error, executionThreadId)) throw error;
      this.#forgetOwnedExecutionThread(executionThreadId);
      const replacementThreadId = await this.#ensureEphemeralThread(signal);
      return this.#callOnThread(
        server,
        tool,
        argumentsValue,
        replacementThreadId,
        onProgress,
        contextThreadId ?? replacementThreadId,
        contextTurnId,
        signal,
        this.#options.ensureThread === undefined,
        contextSessionId,
      );
    }
  }

  async #callOnThread(
    server: string,
    tool: string,
    argumentsValue: unknown,
    threadId: string,
    onProgress?: (event: NativeToolProgressEvent) => Promise<void> | void,
    contextThreadId = threadId,
    contextTurnId?: string,
    signal?: AbortSignal,
    ownedExecutionThread = false,
    contextSessionId = contextThreadId,
  ): Promise<unknown> {
    throwIfAborted(signal);
    const turnId = contextTurnId ?? randomUUID();
    const turnStartedAtUnixMs = Date.now();
    let sequence = 0;
    let progressTail = Promise.resolve();
    const unsubscribe =
      onProgress === undefined || this.#client.subscribeNotifications === undefined
        ? undefined
        : this.#client.subscribeNotifications((notification) => {
            if (notification.method !== "item/mcpToolCall/progress") return;
            const params = isObject(notification.params) ? notification.params : {};
            if (params.threadId !== threadId) return;
            if (
              typeof params.turnId !== "string" ||
              typeof params.itemId !== "string" ||
              typeof params.message !== "string"
            ) {
              return;
            }
            sequence += 1;
            const event: NativeToolProgressEvent = {
              nativeMethod: "item/mcpToolCall/progress",
              threadId,
              turnId: params.turnId,
              itemId: params.itemId,
              message: params.message,
              sequence,
            };
            progressTail = progressTail
              .then(() => onProgress(event))
              .then(() => undefined)
              .catch(() => undefined);
          });
    try {
      const request = this.#client.request("mcpServer/tool/call", {
        _meta: {
          "x-codex-turn-metadata": {
            auto_review_enabled: false,
            ...(this.#options.model?.trim() ? { model: this.#options.model.trim() } : {}),
            node_repl_auto_review_required: false,
            node_repl_disabled: false,
            ...(this.#options.reasoningEffort?.trim()
              ? { reasoning_effort: this.#options.reasoningEffort.trim() }
              : {}),
            sandbox: "none",
            sandbox_mode: "danger-full-access",
            // Browser Use keys mutable attachment/selection state by
            // session_id, while thread_id remains the live Codex UI host.
            // Most native tools use the same value for both; browser callers
            // may supply a stable work-session id without impersonating or
            // taking a writer lock on the host task.
            session_id: contextSessionId,
            thread_id: contextThreadId,
            thread_source: this.#options.threadSource ?? "user",
            turn_id: turnId,
            turn_started_at_unix_ms: turnStartedAtUnixMs,
            workspace_kind: this.#options.workspaceKind ?? "project",
          },
        },
        server,
        threadId,
        tool,
        arguments: argumentsValue,
      });
      // App Server does not expose a standalone cancellation method for this
      // request. An executor-owned ephemeral thread is the cancellation unit:
      // deleting it terminates its full MCP stack and gives an authoritative
      // acknowledgement before the scheduler lane is released. Never apply
      // this to a caller- or UI-owned Codex thread.
      const result = ownedExecutionThread
        ? await this.#awaitOwnedThreadCall(request, threadId, signal)
        : await request;
      await progressTail;
      throwIfAborted(signal);
      return result;
    } finally {
      unsubscribe?.();
    }
  }

  async #awaitOwnedThreadCall<T>(
    request: Promise<T>,
    threadId: string,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal === undefined) return request;

    let abortObserved = signal.aborted;
    let cancellationPromise: Promise<never> | undefined;
    const cancel = (): Promise<never> => {
      abortObserved = true;
      cancellationPromise ??= (async () => {
        try {
          await this.#client.request(
            "thread/delete",
            { threadId },
            { awaitResponseAfterCancellation: true },
          );
          if (this.#ephemeralThreadId === threadId) this.#ephemeralThreadId = undefined;
        } catch (error) {
          if (isMissingOwnedExecutionThread(error, threadId)) {
            if (this.#ephemeralThreadId === threadId) this.#ephemeralThreadId = undefined;
          } else if (isNonDeletableEphemeralThread(error, threadId)) {
            try {
              await this.#client.request(
                "thread/unsubscribe",
                { threadId },
                { awaitResponseAfterCancellation: true },
              );
              // A cancelled call can leave work running on an unsubscribed
              // ephemeral thread. Do not reuse that execution context even
              // though normal retirement intentionally keeps it reusable.
              if (this.#ephemeralThreadId === threadId) this.#ephemeralThreadId = undefined;
            } catch (unsubscribeError) {
              const cancellationError = cancellationReason(signal);
              throw new AggregateError(
                [cancellationError, unsubscribeError],
                `Failed to retire cancelled native execution thread ${threadId}`,
              );
            }
          } else {
            const cancellationError = cancellationReason(signal);
            throw new AggregateError(
              [cancellationError, error],
              `Failed to retire cancelled native execution thread ${threadId}`,
            );
          }
        }
        throw cancellationReason(signal);
      })();
      return cancellationPromise;
    };
    let rejectCancellation: (error: unknown) => void = () => undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const beginCancellation = () => {
      void cancel().catch(rejectCancellation);
    };
    if (signal.aborted) beginCancellation();
    else signal.addEventListener("abort", beginCancellation, { once: true });
    try {
      const result = await Promise.race([request, cancellation]);
      if (abortObserved || signal.aborted) return await cancel();
      return result;
    } catch (error) {
      if (abortObserved || signal.aborted) return await cancel();
      throw error;
    } finally {
      signal.removeEventListener("abort", beginCancellation);
    }
  }

  async #runOnDefaultThread<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.#defaultThreadTail;
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#defaultThreadTail = previous.then(
      () => current,
      () => current,
    );
    try {
      await waitForPredecessor(previous, signal);
      throwIfAborted(signal);
      const result = await operation();
      throwIfAborted(signal);
      return result;
    } finally {
      release?.();
    }
  }

  async #ensureEphemeralThread(signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    if (this.#options.ensureThread !== undefined) {
      if (this.#ephemeralThreadId !== undefined) return this.#ephemeralThreadId;
      this.#ephemeralThreadId = await this.#options.ensureThread();
      return this.#ephemeralThreadId;
    }
    const workExecutorId = await this.#options.resolveWorkExecutorId?.();
    throwIfAborted(signal);
    if (this.#ephemeralThreadId !== undefined && this.#threadWorkExecutorId === workExecutorId) {
      return this.#ephemeralThreadId;
    }
    if (this.#ephemeralThreadId !== undefined) {
      const previousThreadId = this.#ephemeralThreadId;
      await this.#client.request("thread/unsubscribe", { threadId: previousThreadId });
      this.#forgetOwnedExecutionThread(previousThreadId);
    }
    this.#ephemeralThreadPromise ??= (async () => {
      const cuaServerConfig =
        workExecutorId === undefined
          ? undefined
          : await this.#options.resolveCuaServerConfig?.(workExecutorId);
      throwIfAborted(signal);
      return this.#client.request<unknown>(
        "thread/start",
        {
          approvalPolicy: "never",
          cwd: this.#options.cwd ?? null,
          ephemeral: true,
          sandbox: "danger-full-access",
          config: {
            thread_unload_delay_secs: 0,
            ...(workExecutorId === undefined
              ? {}
              : {
                  "mcp_servers.node_repl.env.BROWSER_USE_ACCESS_EXECUTOR_ID": workExecutorId,
                }),
            ...(cuaServerConfig === undefined ? {} : { "mcp_servers.cua_repl": cuaServerConfig }),
          },
        },
        signal === undefined ? undefined : { signal, awaitResponseAfterCancellation: true },
      );
    })()
      .then((response) => {
        const thread =
          isObject(response) && isObject(response.thread) ? response.thread : undefined;
        const threadId = thread?.id;
        if (typeof threadId !== "string" || threadId.length === 0) {
          throw new Error("Codex App Server did not return an ephemeral thread id");
        }
        this.#ephemeralThreadId = threadId;
        this.#threadWorkExecutorId = workExecutorId;
        return threadId;
      })
      .finally(() => {
        this.#ephemeralThreadPromise = undefined;
      });
    const threadId = await this.#ephemeralThreadPromise;
    throwIfAborted(signal);
    return threadId;
  }
}

function isMissingOwnedExecutionThread(error: unknown, threadId: string): boolean {
  return (
    error instanceof Error &&
    error.message.toLocaleLowerCase().includes(`thread not found: ${threadId}`.toLocaleLowerCase())
  );
}

function isNonDeletableEphemeralThread(error: unknown, threadId: string): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLocaleLowerCase();
  return (
    message.includes("thread is not persisted and cannot be deleted") &&
    message.includes(threadId.toLocaleLowerCase())
  );
}

export interface AppServerRpcOptions {
  readonly invokesModel?: boolean;
}

export function assertAppServerModelPolicy(
  method: string,
  options: AppServerRpcOptions = {},
): void {
  if (modelMethods.has(method) && options.invokesModel !== true) {
    throw new Error(`App Server method ${method} requires invokesModel=true`);
  }
}

export function isModelInvokingAppServerMethod(method: string): boolean {
  return modelMethods.has(method);
}

const modelMethods = new Set([
  "review/start",
  "thread/compact/start",
  "thread/realtime/start",
  "thread/realtime/appendAudio",
  "thread/realtime/appendText",
  "thread/realtime/appendSpeech",
  "turn/start",
  "turn/steer",
]);

function normalizeTool(rawTool: Record<string, unknown>, fallbackName: string): Tool {
  const originalInputSchema = rawTool.inputSchema;
  const validInputSchema = isJsonSchema(originalInputSchema);
  const inputSchema = validInputSchema
    ? structuredClone(originalInputSchema)
    : { type: "object", additionalProperties: true };
  const originalOutputSchema = rawTool.outputSchema;
  const outputSchema = isJsonSchema(originalOutputSchema)
    ? structuredClone(originalOutputSchema)
    : undefined;
  const name = typeof rawTool.name === "string" ? rawTool.name : fallbackName;
  const nativeTool = structuredClone(rawTool);
  if (originalOutputSchema !== undefined && outputSchema === undefined) {
    delete nativeTool.outputSchema;
  }
  const existingMeta = isObject(rawTool._meta) ? rawTool._meta : {};
  const existingOmniMeta = isObject(existingMeta.omnicodex) ? existingMeta.omnicodex : {};
  const tool = {
    ...nativeTool,
    name,
    inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    _meta: {
      ...existingMeta,
      omnicodex: {
        ...existingOmniMeta,
        ...(Object.keys(existingOmniMeta).length === 0
          ? {}
          : { nativeOmnicodex: structuredClone(existingOmniMeta) }),
        ...(!validInputSchema
          ? {
              originalInputSchema: originalInputSchema ?? null,
              inputSchemaTransform: "mcp_open_object_fallback",
              inputSchemaValidationError: invalidSchemaReason(originalInputSchema),
            }
          : {}),
        ...(originalOutputSchema !== undefined && outputSchema === undefined
          ? { originalOutputSchema, outputSchemaTransform: "omitted_invalid_json_schema" }
          : {}),
      },
    },
  };
  return tool as unknown as Tool;
}

function withOmniMetadata(
  tool: Tool,
  metadata: {
    readonly exposedName: string;
    readonly server: string;
    readonly originalName: string;
  },
): Tool {
  return {
    ...tool,
    name: metadata.exposedName,
    _meta: {
      ...(isObject(tool._meta) ? tool._meta : {}),
      omnicodex: {
        ...(isObject(tool._meta) && isObject(tool._meta.omnicodex) ? tool._meta.omnicodex : {}),
        source: "codex_app_server_mcp",
        server: metadata.server,
        originalName: metadata.originalName,
        exposedName: metadata.exposedName,
      },
    },
  } as Tool;
}

function isJsonSchema(value: unknown): value is boolean | Record<string, unknown> {
  return typeof value === "boolean" || isObject(value);
}

function invalidSchemaReason(value: unknown): string {
  if (value === undefined) return "Native input schema was absent";
  return "Native input schema was not a JSON Schema object or boolean";
}

function incompatibility(
  stage: NativeToolCatalogIncompatibilityStage,
  page: number,
  cursor: string | undefined,
  rawValue: unknown,
  provenance: Omit<
    NativeToolCatalogIncompatibilityDetails,
    "cursor" | "page" | "rawShape" | "stage"
  > = {},
): NativeToolCatalogIncompatibilityError {
  return new NativeToolCatalogIncompatibilityError({
    stage,
    page,
    ...(cursor === undefined ? {} : { cursor }),
    ...provenance,
    rawShape: describeRawShape(rawValue),
  });
}

function describeRawShape(value: unknown): NativeToolCatalogRawShape {
  if (value === null) return { kind: "null" };
  if (Array.isArray(value)) return { kind: "array", length: value.length };
  if (typeof value !== "object") return { kind: typeof value };
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((left, right) => left.localeCompare(right));
  return {
    kind: "object",
    keys,
    fields: Object.fromEntries(keys.map((key) => [key, rawKind(record[key])])),
  };
}

function rawKind(value: unknown): NativeToolCatalogRawShape["kind"] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Native MCP catalog ${label} must be a positive integer`);
  }
  return value;
}

function optionalPositiveInteger(value: number | undefined, label: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, label);
}

function isMcpToolName(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_.-]+$/.test(value);
}

function isGenericReplToolName(value: string): boolean {
  // Keep the public REPL identity stable when another REPL appears or disappears.
  return value === "js" || value === "js_reset" || value === "js_add_node_module_dir";
}

function namespacedToolName(server: string, tool: string): string {
  const base = `codex__${sanitize(server)}__${sanitize(tool)}`;
  if (base.length <= 128) {
    return base;
  }
  const digest = createHash("sha256").update(`${server}\n${tool}`, "utf8").digest("hex");
  return `${base.slice(0, 62)}__${digest}`;
}

function sanitize(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.-]+/g, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  const error = new Error("Native App Server tool call cancelled");
  error.name = "AbortError";
  throw error;
}

function cancellationReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("Native App Server tool call cancelled");
  error.name = "AbortError";
  return error;
}

function waitForPredecessor(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return previous.catch(() => undefined);
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = () =>
      finish(() => {
        try {
          throwIfAborted(signal);
        } catch (error) {
          reject(error);
        }
      });
    signal.addEventListener("abort", onAbort, { once: true });
    void previous.then(
      () => finish(resolve),
      () => finish(resolve),
    );
  });
}
