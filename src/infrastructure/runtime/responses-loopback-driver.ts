import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { canonicalJson } from "../safety/canonical-json.js";
import type { CodexModelMetadataSnapshot } from "./codex-model-metadata-source.js";

const CODEX_TOOL_UPSTREAM_BASE_URL = "https://chatgpt.com/backend-api/codex";
const EXEC_WAIT_YIELD_MS = 30_000;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;
const NATIVE_TOOL_PATHS = new Set([
  "/v1/alpha/search",
  "/v1/images/generations",
  "/v1/images/edits",
]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const NATIVE_TOOL_REQUEST_HEADER_DENYLIST = new Set([
  ...HOP_BY_HOP_HEADERS,
  "authorization",
  "content-length",
  "cookie",
  "host",
  "x-omnicodex-loopback-key",
  "x-openai-actor-authorization",
]);
const NATIVE_TOOL_RESPONSE_HEADER_DENYLIST = new Set([
  ...HOP_BY_HOP_HEADERS,
  "content-length",
  "set-cookie",
]);

export type ResponsesToolKind =
  | "function"
  | "custom"
  | "freeform"
  | "tool_search"
  | "namespace"
  | "unknown";

export interface ResponsesNativeToolSpec {
  readonly type: string;
  readonly name?: string;
  readonly description?: string;
  readonly [key: string]: unknown;
}

export interface ResponsesToolCatalogSnapshot {
  readonly refreshedAtUnixMs: number;
  readonly tools: readonly ResponsesNativeToolSpec[];
  readonly nestedTools?: readonly ResponsesNestedToolMetadata[];
  readonly requestCount: number;
}

export interface ResponsesNestedToolMetadata {
  readonly name: string;
  readonly nativeNamespace?: string;
  readonly nativeName?: string;
  readonly description?: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

export interface ResponsesSelectedToolCall {
  readonly kind: Exclude<ResponsesToolKind, "namespace">;
  readonly name: string;
  readonly namespace?: string;
  readonly arguments: unknown;
}

export interface ResponsesToolCallOptions {
  /**
   * Internal adapter scripts may ask the driver to consume a yielded exec cell
   * to completion. Public/native calls leave this false so `functions.exec`
   * returns the same continuation handle Codex receives and the caller decides
   * whether and how to invoke `functions.wait`.
   */
  readonly awaitYieldedExec?: boolean;
  readonly preserveYieldedTurn?: boolean;
}

export type ResponsesToolExecutionStatus = "succeeded" | "failed";

export interface ResponsesCorrelatedToolOutput {
  readonly callId: string;
  readonly outputType: string;
  readonly output: unknown;
  readonly rawItem: Readonly<Record<string, unknown>>;
  readonly rawItems?: readonly Readonly<Record<string, unknown>>[];
  readonly yieldedCellId?: string;
  readonly turnRetained?: boolean;
}

export interface ResponsesToolExecutionResult extends ResponsesCorrelatedToolOutput {
  readonly executionStatus: ResponsesToolExecutionStatus;
}

interface ExecNotificationState {
  readonly callId: string;
  readonly name: string;
  readonly observed: Map<string, number>;
}

interface ActiveToolCall {
  readonly selection: ResponsesSelectedToolCall;
  readonly callId: string;
  readonly executionNonce: string;
  readonly completion: Promise<ResponsesCorrelatedToolOutput>;
  readonly awaitYieldedExec: boolean;
  readonly preserveYieldedTurn: boolean;
  readonly continuationTranscript: Record<string, unknown>[];
  readonly execNotifications: ExecNotificationState | undefined;
  phase: "prepared" | "emitted" | "waiting";
  waitCallId?: string;
  outerYieldItem?: Readonly<Record<string, unknown>>;
  resolve(value: ResponsesCorrelatedToolOutput): void;
  reject(error: Error): void;
}

export interface ResponsesLoopbackDriverOptions {
  /** Exact installed descriptor; absence makes `/models` explicitly unavailable. */
  readonly modelMetadata?: CodexModelMetadataSnapshot;
  /** Injectable only so relay behavior can be tested without an external request. */
  readonly fetchImpl?: typeof fetch;
  readonly binding?: LoopbackServerBinding;
  readonly maxNativeToolRequestBytes?: number;
  readonly maxNativeToolResponseBytes?: number;
  readonly searchTimeoutMs?: number;
  readonly imageTimeoutMs?: number;
}

export interface LoopbackServerBinding {
  readonly host: "127.0.0.1";
  listen(server: Server): Promise<number>;
}

class Ipv4LoopbackServerBinding implements LoopbackServerBinding {
  readonly host = "127.0.0.1" as const;

  listen(server: Server): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const onError = (error: Error) => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        const address = server.address();
        if (typeof address === "object" && address !== null) {
          resolve(address.port);
          return;
        }
        reject(new Error("Responses loopback driver did not receive a TCP address"));
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, this.host);
    });
  }
}

class LoopbackHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/**
 * A loopback-only Responses endpoint for the isolated executor App Server.
 * It never performs inference: it captures the runtime's actual tool specs and
 * echoes one tool call already selected by the remote MCP client.
 */
export class ResponsesLoopbackDriver {
  readonly #binding: LoopbackServerBinding;
  readonly #fetchImpl: typeof fetch;
  readonly #maxNativeToolRequestBytes: number | undefined;
  readonly #maxNativeToolResponseBytes: number | undefined;
  readonly #searchTimeoutMs: number | undefined;
  readonly #imageTimeoutMs: number | undefined;
  readonly #modelMetadata: CodexModelMetadataSnapshot | undefined;
  readonly #apiKey = randomBytes(32).toString("base64url");
  readonly #catalogByIdentity = new Map<string, ResponsesNativeToolSpec>();
  readonly #relayControllersByServer = new Map<Server, Set<AbortController>>();
  readonly #activeRequestCounts = new Map<Server, number>();
  readonly #drainWaiters = new Set<() => void>();
  readonly #failedTransportServers = new WeakSet<Server>();
  #server: Server | undefined;
  #port: number | undefined;
  #stopPromise: Promise<void> | undefined;
  #stopping = false;
  #requestCount = 0;
  #activeCall: ActiveToolCall | undefined;
  readonly #liveCells = new Set<string>();
  readonly #cellNotifications = new Map<string, ExecNotificationState>();
  #retainedResponse:
    | { response: ServerResponse; body: Record<string, unknown>; release(): void }
    | undefined;

  constructor(options: ResponsesLoopbackDriverOptions = {}) {
    this.#binding = options.binding ?? new Ipv4LoopbackServerBinding();
    if (this.#binding.host !== "127.0.0.1") {
      throw new Error("Responses loopback driver must bind to 127.0.0.1");
    }
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#maxNativeToolRequestBytes = optionalPositiveInteger(
      options.maxNativeToolRequestBytes,
      "maxNativeToolRequestBytes",
    );
    this.#maxNativeToolResponseBytes = optionalPositiveInteger(
      options.maxNativeToolResponseBytes,
      "maxNativeToolResponseBytes",
    );
    this.#searchTimeoutMs = optionalPositiveInteger(options.searchTimeoutMs, "searchTimeoutMs");
    this.#imageTimeoutMs = optionalPositiveInteger(options.imageTimeoutMs, "imageTimeoutMs");
    this.#modelMetadata = options.modelMetadata;
  }

  get apiKey(): string {
    return this.#apiKey;
  }

  get baseUrl(): string {
    if (this.#port === undefined) {
      throw new Error("Responses loopback driver has not been started");
    }
    return `http://${this.#binding.host}:${this.#port}/v1`;
  }

  get snapshot(): ResponsesToolCatalogSnapshot {
    return {
      refreshedAtUnixMs: Date.now(),
      tools: [...this.#catalogByIdentity.values()].map((tool) => structuredClone(tool)),
      requestCount: this.#requestCount,
    };
  }

  async start(): Promise<void> {
    if (this.#server !== undefined) {
      throw new Error("Responses loopback driver is already started");
    }
    this.#catalogByIdentity.clear();
    this.#requestCount = 0;
    this.#stopping = false;
    const server = createServer((request, response) => {
      const admittedBeforeDrain = !this.#stopping;
      this.#activeRequestCounts.set(server, (this.#activeRequestCounts.get(server) ?? 0) + 1);
      const operation = this.#handle(server, request, response, admittedBeforeDrain).catch(
        (error: unknown) => {
          writeLoopbackError(response, error);
        },
      );
      void operation.then(
        () => this.#finishRequest(server),
        () => this.#finishRequest(server),
      );
    });
    this.#activeRequestCounts.set(server, 0);
    this.#server = server;
    try {
      this.#port = await this.#binding.listen(server);
    } catch (error) {
      this.#server = undefined;
      this.#port = undefined;
      this.#activeRequestCounts.delete(server);
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      throw error;
    }
  }

  stop(timeoutMs?: number): Promise<void> {
    const explicitTimeoutMs = optionalPositiveInteger(timeoutMs, "stop timeoutMs");
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    const server = this.#server;
    if (server === undefined) return Promise.resolve();
    const stopPromise = this.#stopServer(server, explicitTimeoutMs).finally(() => {
      if (this.#stopPromise === stopPromise) this.#stopPromise = undefined;
    });
    this.#stopPromise = stopPromise;
    return stopPromise;
  }

  /** The upstream App Server is gone, so its unfinished loopback requests cannot complete. */
  stopAfterTransportFailure(error: Error): Promise<void> {
    if (this.#server !== undefined) this.#forceStop(this.#server, error);
    return this.stop();
  }

  async #stopServer(server: Server, timeoutMs: number | undefined): Promise<void> {
    this.#stopping = true;
    let deadlineError: Error | undefined;
    const forceState = { forced: false };
    const cancelDeadline =
      timeoutMs === undefined
        ? undefined
        : scheduleLongTimeout(timeoutMs, () => {
            forceState.forced = true;
            deadlineError = new Error(
              `Responses loopback driver stop timed out after ${timeoutMs}ms`,
            );
            this.#forceStop(server, deadlineError);
          });
    try {
      if (
        !forceState.forced &&
        !this.#failedTransportServers.has(server) &&
        !this.#isDrained(server)
      ) {
        await this.#waitForDrain(server, forceState);
      }
      await closeHttpServer(server);
      if (this.#server === server) {
        this.#server = undefined;
        this.#port = undefined;
        this.#catalogByIdentity.clear();
      }
      this.#activeRequestCounts.delete(server);
      this.#relayControllersByServer.delete(server);
      this.#failedTransportServers.delete(server);
      this.#stopping = false;
      if (deadlineError !== undefined) throw deadlineError;
    } catch (error) {
      if (this.#server === server) this.#stopping = false;
      throw error;
    } finally {
      cancelDeadline?.();
    }
  }

  #forceStop(server: Server, error: Error): void {
    this.#failedTransportServers.add(server);
    this.cancelActiveToolCall(error);
    for (const controller of this.#relayControllersByServer.get(server) ?? []) {
      controller.abort(error);
    }
    this.#relayControllersByServer.delete(server);
    server.closeAllConnections();
    this.#notifyDrainWaiters();
  }

  #waitForDrain(server: Server, forceState: { readonly forced: boolean }): Promise<void> {
    if (forceState.forced || this.#failedTransportServers.has(server) || this.#isDrained(server)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const check = () => {
        if (
          !forceState.forced &&
          !this.#failedTransportServers.has(server) &&
          !this.#isDrained(server)
        ) {
          return;
        }
        this.#drainWaiters.delete(check);
        resolve();
      };
      this.#drainWaiters.add(check);
      check();
    });
  }

  #isDrained(server: Server): boolean {
    return (
      this.#activeCall === undefined &&
      (this.#relayControllersByServer.get(server)?.size ?? 0) === 0 &&
      (this.#activeRequestCounts.get(server) ?? 0) === 0
    );
  }

  #finishRequest(server: Server): void {
    const count = this.#activeRequestCounts.get(server);
    if (count !== undefined) {
      if (count <= 1) {
        if (this.#server === server) this.#activeRequestCounts.set(server, 0);
        else this.#activeRequestCounts.delete(server);
      } else {
        this.#activeRequestCounts.set(server, count - 1);
      }
    }
    this.#notifyDrainWaiters();
  }

  #notifyDrainWaiters(): void {
    for (const waiter of [...this.#drainWaiters]) waiter();
  }

  prepareToolCall(
    selection: ResponsesSelectedToolCall,
    options: ResponsesToolCallOptions = {},
  ): {
    readonly callId: string;
    readonly executionNonce: string;
    readonly completion: Promise<ResponsesCorrelatedToolOutput>;
  } {
    if (this.#server === undefined || this.#port === undefined) {
      throw new Error("Responses loopback driver is not started");
    }
    if (this.#stopping) {
      throw new Error("Responses loopback driver is draining");
    }
    if (this.#activeCall !== undefined) {
      throw new Error("Responses loopback driver already has an active tool call");
    }
    const callId = `call_omnicodex_${randomUUID()}`;
    const executionNonce = `omnicodex-exec-${randomUUID()}`;
    let resolveCompletion!: (value: ResponsesCorrelatedToolOutput) => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<ResponsesCorrelatedToolOutput>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    this.#activeCall = {
      selection,
      callId,
      executionNonce,
      completion,
      awaitYieldedExec: options.awaitYieldedExec === true,
      preserveYieldedTurn: options.preserveYieldedTurn === true,
      continuationTranscript: [],
      execNotifications: isFunctionsExecSelection(selection)
        ? { callId, name: selection.name, observed: new Map() }
        : isFunctionsWaitSelection(selection) &&
            isObject(selection.arguments) &&
            typeof selection.arguments.cell_id === "string"
          ? this.#cellNotifications.get(selection.arguments.cell_id)
          : undefined,
      phase: "prepared",
      resolve: resolveCompletion,
      reject: rejectCompletion,
    };
    const retained = this.#retainedResponse;
    if (retained !== undefined) {
      this.#retainedResponse = undefined;
      this.#activeCall.phase = "emitted";
      void this.#writeToolCall(retained.response, retained.body, selection, callId)
        .catch((error: unknown) => this.cancelActiveToolCall(toError(error)))
        .finally(retained.release);
    }
    return { callId, executionNonce, completion };
  }

  cancelActiveToolCall(error: Error): void {
    const active = this.#activeCall;
    this.#activeCall = undefined;
    active?.reject(error);
    this.#liveCells.clear();
    this.#cellNotifications.clear();
    const retained = this.#retainedResponse;
    this.#retainedResponse = undefined;
    if (retained !== undefined) {
      writeLoopbackError(retained.response, error);
      retained.release();
    }
    this.#notifyDrainWaiters();
  }

  async #handle(
    server: Server,
    request: IncomingMessage,
    response: ServerResponse,
    admittedBeforeDrain: boolean,
  ): Promise<void> {
    this.#assertCurrentServer(server);
    if (!this.#isAuthorized(request)) {
      throw new LoopbackHttpError(401, "LOOPBACK_UNAUTHORIZED", "Loopback secret was invalid");
    }
    const url = new URL(request.url ?? "/", this.baseUrl);
    if (!admittedBeforeDrain && this.#activeCall === undefined) {
      throw new LoopbackHttpError(
        503,
        "LOOPBACK_DRAINING",
        "Responses loopback driver is draining",
      );
    }
    if (NATIVE_TOOL_PATHS.has(url.pathname)) {
      if (request.method !== "POST") {
        throw new LoopbackHttpError(
          405,
          "NATIVE_TOOL_METHOD_NOT_ALLOWED",
          "Native tool relay accepts POST only",
        );
      }
      if (url.search.length > 0) {
        throw new LoopbackHttpError(
          400,
          "NATIVE_TOOL_QUERY_REJECTED",
          "Native tool relay does not accept query parameters",
        );
      }
      await this.#relayNativeTool(server, request, response, url.pathname);
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      if (this.#modelMetadata === undefined) {
        throw new LoopbackHttpError(
          503,
          "CODEX_MODEL_METADATA_UNAVAILABLE",
          "Exact installed Codex model metadata is unavailable",
        );
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [this.#modelMetadata.rawModel] }));
      return;
    }
    if (url.pathname !== "/v1/responses") {
      throw new LoopbackHttpError(404, "LOOPBACK_PATH_NOT_ALLOWED", "Loopback path is not allowed");
    }
    if (request.method !== "POST") {
      throw new LoopbackHttpError(
        405,
        "RESPONSES_METHOD_NOT_ALLOWED",
        "Loopback Responses protocol accepts POST only",
      );
    }
    if (!isJsonContentType(firstHeaderValue(request.headers["content-type"]))) {
      throw new LoopbackHttpError(
        415,
        "RESPONSES_CONTENT_TYPE_REJECTED",
        "Loopback Responses protocol requires application/json",
      );
    }

    const body = await readJsonBody(request);
    this.#assertCurrentServer(server);
    this.#requestCount += 1;
    this.#captureTools(body);
    const active = this.#activeCall;
    if (active !== undefined) {
      if (active.phase === "prepared") {
        if (!containsExactString(body.input, active.executionNonce)) {
          throw this.#failActiveProtocol(
            active,
            "RESPONSES_EXECUTION_NONCE_MISMATCH",
            "Loopback Responses request did not contain the active execution nonce",
          );
        }
        if (findAnyCallOutput(body, active.callId) !== undefined) {
          throw this.#failActiveProtocol(
            active,
            "RESPONSES_TOOL_OUTPUT_BEFORE_CALL",
            "Loopback Responses returned tool output before the selected call was emitted",
          );
        }
        active.phase = "emitted";
        await this.#writeToolCall(response, body, active.selection, active.callId);
        return;
      }

      const pendingCallId = active.phase === "waiting" ? active.waitCallId : active.callId;
      if (pendingCallId === undefined) {
        throw this.#failActiveProtocol(
          active,
          "RESPONSES_WAIT_CALL_STATE_INVALID",
          "Loopback Responses lost the active functions.wait call id",
        );
      }
      const outputs = findCallOutputs(body, pendingCallId);
      const expectedType =
        active.phase === "waiting"
          ? "function_call_output"
          : expectedOutputType(active.selection.kind);
      const correlatedOutput =
        active.phase === "emitted" && isFunctionsExecSelection(active.selection)
          ? functionsExecTerminalOutput(outputs, expectedType, active.selection.name)
          : outputs.length === 1 && outputs[0]?.type === expectedType
            ? outputs[0]
            : undefined;
      if (correlatedOutput === undefined) {
        throw this.#failActiveProtocol(
          active,
          "RESPONSES_TOOL_OUTPUT_MISMATCH",
          `Loopback Responses expected exactly one terminal ${expectedType} for the selected call`,
        );
      }
      active.continuationTranscript.push(
        ...freshCallOutputs(body, outputs, active.execNotifications),
      );
      const output = outputValue(correlatedOutput);
      const yieldedCellId =
        isFunctionsExecSelection(active.selection) || isFunctionsWaitSelection(active.selection)
          ? yieldedExecCellId(output)
          : undefined;
      if (yieldedCellId !== undefined) {
        if (!active.awaitYieldedExec) {
          this.#activeCall = undefined;
          this.#notifyDrainWaiters();
          const retained = active.preserveYieldedTurn;
          if (retained) {
            this.#liveCells.add(yieldedCellId);
            if (active.execNotifications !== undefined)
              this.#cellNotifications.set(yieldedCellId, active.execNotifications);
          }
          const resumed = retained ? this.#retainResponse(response, body) : undefined;
          active.resolve({
            callId: active.callId,
            outputType: expectedOutputType(active.selection.kind),
            output,
            rawItem: correlatedOutput,
            rawItems: active.continuationTranscript,
            yieldedCellId,
            ...(retained ? { turnRetained: true } : {}),
          });
          if (resumed !== undefined) await resumed;
          else await this.#writeAssistantCompletion(response, body);
          return;
        }
        if (active.phase === "emitted") {
          active.outerYieldItem = correlatedOutput;
        }
        active.phase = "waiting";
        const waitCallId = `call_omnicodex_wait_${randomUUID()}`;
        active.waitCallId = waitCallId;
        await this.#writeToolCall(
          response,
          body,
          {
            kind: "function",
            namespace: "functions",
            name: "wait",
            arguments: {
              cell_id: yieldedCellId,
              yield_time_ms: EXEC_WAIT_YIELD_MS,
            },
          },
          waitCallId,
        );
        return;
      }
      this.#activeCall = undefined;
      this.#notifyDrainWaiters();
      if (isFunctionsWaitSelection(active.selection) && isObject(active.selection.arguments)) {
        const cellId = active.selection.arguments.cell_id;
        if (typeof cellId === "string") {
          this.#liveCells.delete(cellId);
          this.#cellNotifications.delete(cellId);
        }
      }
      const retainTurn = active.preserveYieldedTurn && this.#liveCells.size > 0;
      const resumed = retainTurn ? this.#retainResponse(response, body) : undefined;
      const outerOutputType = expectedOutputType(active.selection.kind);
      active.resolve({
        callId: active.callId,
        outputType: outerOutputType,
        output,
        rawItem:
          active.outerYieldItem === undefined
            ? correlatedOutput
            : {
                ...active.outerYieldItem,
                type: outerOutputType,
                call_id: active.callId,
                output,
              },
        rawItems: active.continuationTranscript,
        ...(retainTurn ? { turnRetained: true } : {}),
      });
      if (resumed !== undefined) await resumed;
      else await this.#writeAssistantCompletion(response, body);
      return;
    }
    await this.#writeAssistantCompletion(response, body);
  }

  #retainResponse(response: ServerResponse, body: Record<string, unknown>): Promise<void> {
    return new Promise<void>((release) => {
      this.#retainedResponse = { response, body, release };
    });
  }

  #failActiveProtocol(active: ActiveToolCall, code: string, message: string): LoopbackHttpError {
    if (this.#activeCall === active) {
      this.#activeCall = undefined;
      this.#notifyDrainWaiters();
    }
    const error = new LoopbackHttpError(409, code, message);
    active.reject(error);
    return error;
  }

  resetCatalog(): void {
    if (this.#activeCall !== undefined) {
      throw new Error("Responses loopback catalog cannot reset during an active tool call");
    }
    this.#catalogByIdentity.clear();
  }

  async #relayNativeTool(
    server: Server,
    request: IncomingMessage,
    response: ServerResponse,
    localPath: string,
  ): Promise<void> {
    const secretHeader = firstHeaderValue(request.headers["x-omnicodex-loopback-key"]);
    if (!safeEqual(secretHeader, this.#apiKey) || !hasUpstreamAuthorization(request)) {
      throw new LoopbackHttpError(
        401,
        "NATIVE_TOOL_UPSTREAM_AUTH_UNAVAILABLE",
        "Native tool upstream authorization was unavailable",
      );
    }
    const contentType = firstHeaderValue(request.headers["content-type"]);
    if (!isAllowedNativeRequestContentType(localPath, contentType)) {
      throw new LoopbackHttpError(
        415,
        "NATIVE_TOOL_CONTENT_TYPE_REJECTED",
        "Native tool request content type was not allowed",
        { path: localPath },
      );
    }

    const body = await readBody(
      request,
      this.#maxNativeToolRequestBytes,
      "Native tool request",
      413,
      "NATIVE_TOOL_REQUEST_TOO_LARGE",
    );
    this.#assertCurrentServer(server);
    const headers = nativeToolUpstreamHeaders(request);
    const upstreamPath = localPath.slice("/v1".length);
    const upstreamUrl = `${CODEX_TOOL_UPSTREAM_BASE_URL}${upstreamPath}`;
    this.#requestCount += 1;

    const relayController = new AbortController();
    const relayControllers = this.#relayControllersByServer.get(server) ?? new Set();
    relayControllers.add(relayController);
    this.#relayControllersByServer.set(server, relayControllers);
    let timedOut = false;
    const configuredTimeout = localPath.includes("/images/")
      ? this.#imageTimeoutMs
      : this.#searchTimeoutMs;
    const cancelTimeout =
      configuredTimeout === undefined
        ? undefined
        : scheduleLongTimeout(configuredTimeout, () => {
            timedOut = true;
            relayController.abort(new Error("Native tool upstream timed out"));
          });
    const abortForDisconnect = () => {
      if (!response.writableEnded) {
        relayController.abort(new Error("Native tool relay client disconnected"));
      }
    };
    request.once("aborted", abortForDisconnect);
    response.once("close", abortForDisconnect);
    const cleanupRelay = () => {
      cancelTimeout?.();
      request.removeListener("aborted", abortForDisconnect);
      response.removeListener("close", abortForDisconnect);
      relayControllers.delete(relayController);
      if (relayControllers.size === 0) this.#relayControllersByServer.delete(server);
      this.#notifyDrainWaiters();
    };

    let upstream: Response;
    try {
      upstream = await this.#fetchImpl(upstreamUrl, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: relayController.signal,
      });
    } catch (error) {
      cleanupRelay();
      if (request.aborted || response.destroyed) return;
      if (timedOut) {
        throw new LoopbackHttpError(
          504,
          "NATIVE_TOOL_UPSTREAM_TIMEOUT",
          "Native tool upstream timed out",
        );
      }
      throw new LoopbackHttpError(
        502,
        "NATIVE_TOOL_UPSTREAM_UNAVAILABLE",
        "Native tool upstream was unavailable",
        { cause: errorDetails(error) },
      );
    }

    try {
      if (this.#server !== server) {
        await upstream.body?.cancel().catch(() => undefined);
        return;
      }
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel().catch(() => undefined);
        throw new LoopbackHttpError(
          502,
          "NATIVE_TOOL_UPSTREAM_REDIRECT_BLOCKED",
          "Native tool upstream redirect was blocked",
          { upstreamStatus: upstream.status },
        );
      }
      try {
        assertContentLengthWithinLimit(
          upstream.headers.get("content-length"),
          this.#maxNativeToolResponseBytes,
          "NATIVE_TOOL_RESPONSE_TOO_LARGE",
        );
      } catch (error) {
        await upstream.body?.cancel().catch(() => undefined);
        throw error;
      }
      // The fixed ChatGPT native-tool endpoints return an HTTP application
      // response, not executable browser content.  Its media type is part of
      // that native contract: problem+json, plain-text diagnostics, future
      // vendor types, and binary tool results must cross the loopback boundary
      // unchanged instead of being replaced with a local 502.  Redirects and
      // unsafe response headers remain independently blocked above/below.
      response.writeHead(
        upstream.status,
        upstream.statusText,
        nativeToolDownstreamHeaders(upstream.headers),
      );
      await streamFetchResponseBody(upstream, response, this.#maxNativeToolResponseBytes);
    } finally {
      cleanupRelay();
    }
  }

  #captureTools(body: Record<string, unknown>): void {
    const candidates: unknown[] = [];
    if (Array.isArray(body.tools)) {
      candidates.push(...body.tools);
    }
    if (Array.isArray(body.input)) {
      for (const item of body.input) {
        if (isObject(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
          candidates.push(...item.tools);
        }
        if (isObject(item) && item.type === "tool_search_output" && Array.isArray(item.tools)) {
          candidates.push(...item.tools);
        }
      }
    }
    for (const candidate of candidates) {
      if (!isObject(candidate) || typeof candidate.type !== "string") {
        continue;
      }
      const tool = candidate as ResponsesNativeToolSpec;
      const identity = `${tool.type}\u0000${typeof tool.name === "string" ? tool.name : ""}\u0000${canonicalJson(tool)}`;
      this.#catalogByIdentity.set(identity, structuredClone(tool));
    }
  }

  async #writeToolCall(
    response: ServerResponse,
    body: Record<string, unknown>,
    selection: ResponsesSelectedToolCall,
    callId: string,
  ): Promise<void> {
    const responseId = `resp_omnicodex_${randomUUID()}`;
    const itemId = `${selection.kind === "tool_search" ? "tsc" : selection.kind === "custom" || selection.kind === "freeform" ? "ctc" : "fc"}_${randomUUID()}`;
    const item = selectedCallItem(selection, callId, itemId, "in_progress");
    const completedItem = selectedCallItem(selection, callId, itemId, "completed");
    const snapshot = responseSnapshot(responseId, body, "completed", [completedItem]);
    const events: Array<[string, Record<string, unknown>]> = [
      ["response.created", { response: responseSnapshot(responseId, body, "in_progress", []) }],
      ["response.output_item.added", { output_index: 0, item }],
    ];
    if (selection.kind === "custom" || selection.kind === "freeform") {
      const input = customInput(selection.arguments);
      events.push([
        "response.custom_tool_call_input.delta",
        { item_id: itemId, output_index: 0, delta: input },
      ]);
      events.push([
        "response.custom_tool_call_input.done",
        { item_id: itemId, output_index: 0, input },
      ]);
    } else if (selection.kind !== "tool_search") {
      const argumentsText = functionArguments(selection.arguments, selection.kind === "unknown");
      events.push([
        "response.function_call_arguments.delta",
        { item_id: itemId, output_index: 0, delta: argumentsText },
      ]);
      events.push([
        "response.function_call_arguments.done",
        {
          item_id: itemId,
          output_index: 0,
          arguments: argumentsText,
        },
      ]);
    }
    events.push(
      ["response.output_item.done", { output_index: 0, item: completedItem }],
      ["response.completed", { response: snapshot }],
    );
    await writeSse(response, events);
  }

  async #writeAssistantCompletion(
    response: ServerResponse,
    body: Record<string, unknown>,
  ): Promise<void> {
    const responseId = `resp_omnicodex_${randomUUID()}`;
    const itemId = `msg_omnicodex_${randomUUID()}`;
    const text = "OMNICODEX_LOOPBACK_COMPLETE";
    const addedItem = {
      type: "message",
      id: itemId,
      status: "in_progress",
      role: "assistant",
      content: [],
    };
    const part = { type: "output_text", text, annotations: [] };
    const completedItem = {
      type: "message",
      id: itemId,
      status: "completed",
      role: "assistant",
      content: [part],
    };
    await writeSse(response, [
      ["response.created", { response: responseSnapshot(responseId, body, "in_progress", []) }],
      ["response.output_item.added", { output_index: 0, item: addedItem }],
      [
        "response.content_part.added",
        { item_id: itemId, output_index: 0, content_index: 0, part: { ...part, text: "" } },
      ],
      [
        "response.output_text.delta",
        { item_id: itemId, output_index: 0, content_index: 0, delta: text },
      ],
      ["response.output_text.done", { item_id: itemId, output_index: 0, content_index: 0, text }],
      ["response.content_part.done", { item_id: itemId, output_index: 0, content_index: 0, part }],
      ["response.output_item.done", { output_index: 0, item: completedItem }],
      [
        "response.completed",
        { response: responseSnapshot(responseId, body, "completed", [completedItem]) },
      ],
    ]);
  }

  #isAuthorized(request: IncomingMessage): boolean {
    const secretHeader = request.headers["x-omnicodex-loopback-key"];
    const actual =
      secretHeader === undefined
        ? firstHeaderValue(request.headers.authorization)
        : firstHeaderValue(secretHeader);
    const expected = secretHeader === undefined ? `Bearer ${this.#apiKey}` : this.#apiKey;
    return safeEqual(actual, expected);
  }

  #assertCurrentServer(server: Server): void {
    if (this.#server !== server) {
      throw new LoopbackHttpError(
        503,
        "LOOPBACK_SERVER_RETIRED",
        "Responses loopback server generation was retired",
      );
    }
  }
}

function hasUpstreamAuthorization(request: IncomingMessage): boolean {
  const authorization = firstHeaderValue(request.headers.authorization);
  if (/^Bearer\s+\S+$/i.test(authorization)) {
    return true;
  }
  return firstHeaderValue(request.headers["x-openai-actor-authorization"]).length > 0;
}

function nativeToolUpstreamHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (isNativeContextHeader(name) && value !== undefined) {
      headers.set(name, firstHeaderValue(value));
    }
  }
  const authorization = firstHeaderValue(request.headers.authorization);
  const actorAuthorization = firstHeaderValue(request.headers["x-openai-actor-authorization"]);
  if (/^Bearer\s+\S+$/i.test(authorization)) {
    headers.set("authorization", authorization);
  } else if (actorAuthorization.length > 0) {
    headers.set("x-openai-actor-authorization", actorAuthorization);
  }
  const accountId = firstHeaderValue(request.headers["chatgpt-account-id"]);
  if (accountId.length > 0) {
    headers.set("chatgpt-account-id", accountId);
  }
  return headers;
}

function isNativeContextHeader(name: string): boolean {
  if (NATIVE_TOOL_REQUEST_HEADER_DENYLIST.has(name)) return false;
  return (
    name === "accept" ||
    name === "accept-language" ||
    name === "content-type" ||
    name === "originator" ||
    name.startsWith("openai-") ||
    name.startsWith("x-client-") ||
    name.startsWith("x-codex-") ||
    name.startsWith("x-openai-")
  );
}

function nativeToolDownstreamHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    if (!NATIVE_TOOL_RESPONSE_HEADER_DENYLIST.has(name)) result[name] = value;
  }
  return result;
}

function isAllowedNativeRequestContentType(path: string, value: string): boolean {
  const mediaType = normalizedMediaType(value);
  if (path === "/v1/images/edits") {
    return mediaType === "application/json" || mediaType === "multipart/form-data";
  }
  return mediaType === "application/json";
}

function isJsonContentType(value: string): boolean {
  return normalizedMediaType(value) === "application/json";
}

function normalizedMediaType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function assertContentLengthWithinLimit(
  contentLengthValue: string | null,
  limitBytes: number | undefined,
  code: string,
): void {
  if (limitBytes === undefined) return;
  if (contentLengthValue === null) return;
  const contentLength = Number(contentLengthValue);
  if (Number.isSafeInteger(contentLength) && contentLength >= 0 && contentLength <= limitBytes) {
    return;
  }
  throw new LoopbackHttpError(
    502,
    code,
    "Native tool upstream response exceeded the configured size limit",
    { limitBytes },
  );
}

function firstHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function selectedCallItem(
  selection: ResponsesSelectedToolCall,
  callId: string,
  itemId: string,
  status: "in_progress" | "completed",
): Record<string, unknown> {
  if (selection.kind === "custom" || selection.kind === "freeform") {
    return {
      type: "custom_tool_call",
      id: itemId,
      call_id: callId,
      name: selection.name,
      input: customInput(selection.arguments),
      status,
    };
  }
  if (selection.kind === "tool_search") {
    return {
      type: "tool_search_call",
      id: itemId,
      call_id: callId,
      execution: "client",
      arguments: isObject(selection.arguments) ? selection.arguments : {},
      status,
    };
  }
  return {
    type: "function_call",
    id: itemId,
    call_id: callId,
    name: selection.name,
    arguments: functionArguments(selection.arguments, selection.kind === "unknown"),
    status,
    ...(selection.namespace === undefined ? {} : { namespace: selection.namespace }),
  };
}

function responseSnapshot(
  id: string,
  body: Record<string, unknown>,
  status: "in_progress" | "completed",
  output: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1_000),
    status,
    model: typeof body.model === "string" ? body.model : "omnicodex-loopback",
    output,
    usage: null,
  };
}

async function writeSse(
  response: ServerResponse,
  events: readonly (readonly [string, Record<string, unknown>])[],
): Promise<void> {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
  });
  let sequence = 0;
  for (const [name, data] of events) {
    await writeServerChunk(
      response,
      `event: ${name}\ndata: ${JSON.stringify({ type: name, sequence_number: sequence, ...data })}\n\n`,
    );
    sequence += 1;
  }
  if (!response.destroyed) response.end("data: [DONE]\n\n");
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(request, undefined, "Responses request");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new LoopbackHttpError(
      400,
      "RESPONSES_JSON_INVALID",
      "Loopback Responses request contained invalid JSON",
    );
  }
  if (!isObject(parsed)) {
    throw new LoopbackHttpError(
      400,
      "RESPONSES_BODY_INVALID",
      "Loopback Responses request body must be an object",
    );
  }
  return parsed;
}

async function readBody(
  request: IncomingMessage,
  limitBytes: number | undefined,
  label: string,
  status = 413,
  code = "LOOPBACK_REQUEST_TOO_LARGE",
): Promise<Buffer> {
  const declaredLength = Number(firstHeaderValue(request.headers["content-length"]));
  if (limitBytes !== undefined && Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    throw new LoopbackHttpError(status, code, `${label} exceeded the configured size limit`, {
      limitBytes,
    });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (limitBytes !== undefined && size > limitBytes) {
      throw new LoopbackHttpError(status, code, `${label} exceeded the configured size limit`, {
        limitBytes,
      });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function streamFetchResponseBody(
  upstream: Response,
  response: ServerResponse,
  limitBytes: number | undefined,
): Promise<void> {
  if (upstream.body === null) {
    response.end();
    return;
  }
  const reader = upstream.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (limitBytes !== undefined && size > limitBytes) {
        await reader.cancel();
        throw new LoopbackHttpError(
          502,
          "NATIVE_TOOL_RESPONSE_TOO_LARGE",
          "Native tool response exceeded the configured size limit",
          { limitBytes },
        );
      }
      await writeServerChunk(response, Buffer.from(value));
    }
    if (!response.destroyed) response.end();
  } finally {
    reader.releaseLock();
  }
}

async function writeServerChunk(response: ServerResponse, chunk: string | Buffer): Promise<void> {
  if (response.destroyed) throw new Error("Loopback response closed during streaming");
  if (response.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.removeListener("drain", onDrain);
      response.removeListener("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Loopback response closed during backpressure wait"));
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
  });
}

/** Notifications keep the originating exec call id even after functions.wait.
 * Retained requests replay history, so count occurrences rather than dropping
 * distinct, identical notifications from the same transcript.
 */
function freshCallOutputs(
  body: Record<string, unknown>,
  outputs: readonly Record<string, unknown>[],
  state: ExecNotificationState | undefined,
): Record<string, unknown>[] {
  if (state === undefined || !Array.isArray(body.input))
    return outputs.map((item) => structuredClone(item));
  const occurrences = new Map<string, number>();
  const fresh: Record<string, unknown>[] = [];
  for (const item of body.input) {
    if (!isObject(item)) continue;
    if (
      item.call_id === state.callId &&
      item.type === "custom_tool_call_output" &&
      item.name === state.name
    ) {
      const key = JSON.stringify(item);
      const count = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, count);
      if (count <= (state.observed.get(key) ?? 0)) continue;
      fresh.push(structuredClone(item));
    } else if (outputs.includes(item)) fresh.push(structuredClone(item));
  }
  for (const [key, count] of occurrences)
    state.observed.set(key, Math.max(count, state.observed.get(key) ?? 0));
  return fresh;
}

function findAnyCallOutput(
  body: Record<string, unknown>,
  callId: string,
): Record<string, unknown> | undefined {
  return findCallOutputs(body, callId)[0];
}

function findCallOutputs(body: Record<string, unknown>, callId: string): Record<string, unknown>[] {
  if (!Array.isArray(body.input)) return [];
  return body.input.filter(
    (item): item is Record<string, unknown> =>
      isObject(item) &&
      item.call_id === callId &&
      (item.type === "function_call_output" ||
        item.type === "custom_tool_call_output" ||
        item.type === "tool_search_output"),
  );
}

/**
 * `functions.exec` may append any number of `notify(...)` events to the same
 * Responses input as its one terminal result.  The runtime marks those
 * notifications with the custom-tool name, while the terminal output has no
 * `name` field.  Correlate the terminal item without treating valid progress
 * notifications as duplicate completion, and reject every other ambiguity.
 */
function functionsExecTerminalOutput(
  outputs: readonly Record<string, unknown>[],
  expectedType: string,
  selectedName: string,
): Record<string, unknown> | undefined {
  if (outputs.length === 0 || outputs.some((item) => item.type !== expectedType)) {
    return undefined;
  }
  const terminal = outputs.filter((item) => !("name" in item));
  if (terminal.length !== 1) return undefined;
  const notifications = outputs.filter((item) => "name" in item);
  if (notifications.some((item) => item.name !== selectedName)) return undefined;
  return terminal[0];
}

function expectedOutputType(
  kind: ResponsesSelectedToolCall["kind"],
): "custom_tool_call_output" | "function_call_output" | "tool_search_output" {
  if (kind === "custom" || kind === "freeform") return "custom_tool_call_output";
  if (kind === "tool_search") return "tool_search_output";
  return "function_call_output";
}

function isFunctionsExecSelection(selection: ResponsesSelectedToolCall): boolean {
  return (
    (selection.kind === "custom" || selection.kind === "freeform") &&
    selection.namespace === "functions" &&
    selection.name === "exec"
  );
}

function isFunctionsWaitSelection(selection: ResponsesSelectedToolCall): boolean {
  return (
    selection.kind === "function" &&
    selection.namespace === "functions" &&
    selection.name === "wait"
  );
}

function yieldedExecCellId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const match = /^\s*Script running with cell ID\s+([A-Za-z0-9][A-Za-z0-9._:-]*)(?:\s|$)/i.exec(
      value,
    );
    if (match?.[1] !== undefined) return match[1];
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return yieldedExecCellId(JSON.parse(trimmed));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  // Native exec emits a multipart content array after text/image output. Only
  // its first status header determines liveness, never a later tool's content.
  if (Array.isArray(value)) {
    const header = value[0];
    if (
      isObject(header) &&
      header.type === "input_text" &&
      typeof header.text === "string" &&
      /^\s*Script running with cell ID[^\r\n]+\r?\nWall time\b/i.test(header.text)
    ) {
      return yieldedExecCellId(header.text);
    }
  }
  return structuredYieldedCellId(value);
}

function structuredYieldedCellId(value: unknown): string | undefined {
  const pending: unknown[] = [value];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if ((typeof candidate !== "object" && typeof candidate !== "function") || candidate === null) {
      continue;
    }
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    if (isObject(candidate)) {
      const yielded = candidate.Yielded;
      if (isObject(yielded)) {
        const cellId = normalizedYieldedCellId(yielded.cell_id);
        if (cellId !== undefined) return cellId;
      }
    }
    const nested = Array.isArray(candidate) ? candidate : Object.values(candidate);
    for (let index = nested.length - 1; index >= 0; index -= 1) {
      pending.push(nested[index]);
    }
  }
  return undefined;
}

function normalizedYieldedCellId(value: unknown): string | undefined {
  const cellId =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : undefined;
  if (cellId === undefined || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(cellId)) {
    return undefined;
  }
  return cellId;
}

function containsExactString(value: unknown, expected: string): boolean {
  const pending: unknown[] = [value];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === expected) return true;
    if ((typeof candidate !== "object" && typeof candidate !== "function") || candidate === null) {
      continue;
    }
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    const nested = Array.isArray(candidate) ? candidate : Object.values(candidate);
    for (let index = nested.length - 1; index >= 0; index -= 1) {
      pending.push(nested[index]);
    }
  }
  return false;
}

function outputValue(value: Record<string, unknown>): unknown {
  if (Object.hasOwn(value, "output")) return value.output;
  if (Object.hasOwn(value, "tools")) return value.tools;
  return value;
}

function functionArguments(value: unknown, preserveOpaque = false): string {
  if (preserveOpaque) {
    return JSON.stringify(value === undefined ? {} : value);
  }
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify({ input: value });
    }
  }
  return JSON.stringify(value === undefined ? {} : value);
}

function customInput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (isObject(value) && typeof value.input === "string") {
    return value.input;
  }
  return stableJson(value);
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function writeLoopbackError(response: ServerResponse, value: unknown): void {
  if (response.destroyed) return;
  if (response.headersSent) {
    response.destroy(toError(value));
    return;
  }
  const error =
    value instanceof LoopbackHttpError
      ? value
      : new LoopbackHttpError(
          500,
          "LOOPBACK_INTERNAL_ERROR",
          value instanceof Error ? value.message : "Loopback request failed",
          { cause: errorDetails(value) },
        );
  response.writeHead(error.status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(
    JSON.stringify({
      error: {
        code: error.code,
        message: error.message,
        ...error.details,
      },
    }),
  );
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
    server.closeIdleConnections();
  });
}

function scheduleLongTimeout(timeoutMs: number, callback: () => void): () => void {
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const arm = () => {
    if (cancelled) return;
    const remainingMs = timeoutMs - (performance.now() - startedAt);
    if (remainingMs <= 0) {
      callback();
      return;
    }
    const delayMs = Math.min(Math.ceil(remainingMs), MAX_NODE_TIMER_DELAY_MS);
    timer = setTimeout(() => {
      arm();
    }, delayMs);
    timer.unref();
  };
  arm();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

function errorDetails(value: unknown, visited = new Set<object>()): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return value;
  }
  if (visited.has(value)) return { circular: true };
  visited.add(value);
  if (value instanceof Error) {
    const details: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      ...(value.stack === undefined ? {} : { stack: value.stack }),
      ...(value.cause === undefined ? {} : { cause: errorDetails(value.cause, visited) }),
    };
    for (const key of Object.keys(value)) {
      if (key in details) continue;
      details[key] = errorDetails((value as unknown as Record<string, unknown>)[key], visited);
    }
    return details;
  }
  if (Array.isArray(value)) return value.map((item) => errorDetails(item, visited));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, errorDetails(item, visited)]),
  );
}

function optionalPositiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}
