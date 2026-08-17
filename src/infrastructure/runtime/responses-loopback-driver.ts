import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const CODEX_TOOL_UPSTREAM_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_MAX_NATIVE_TOOL_REQUEST_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_NATIVE_TOOL_RESPONSE_BYTES = 128 * 1024 * 1024;
const DEFAULT_SEARCH_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_IMAGE_TIMEOUT_MS = 10 * 60_000;
const NATIVE_TOOL_PATHS = new Set([
  "/v1/alpha/search",
  "/v1/images/generations",
  "/v1/images/edits",
]);
const NATIVE_TOOL_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "openai-beta",
  "originator",
  "x-client-request-id",
  "x-codex-image-turn-id",
  "x-codex-turn-metadata",
]);
const NATIVE_TOOL_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-type",
  "openai-processing-ms",
  "retry-after",
  "x-request-id",
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
  readonly description: string;
}

export interface ResponsesSelectedToolCall {
  readonly kind: Exclude<ResponsesToolKind, "namespace">;
  readonly name: string;
  readonly namespace?: string;
  readonly arguments: unknown;
}

export interface ResponsesToolExecutionResult {
  readonly callId: string;
  readonly outputType: string;
  readonly output: unknown;
  readonly rawItem: Readonly<Record<string, unknown>>;
}

interface ActiveToolCall {
  readonly selection: ResponsesSelectedToolCall;
  readonly callId: string;
  readonly completion: Promise<ResponsesToolExecutionResult>;
  resolve(value: ResponsesToolExecutionResult): void;
  reject(error: Error): void;
}

export interface ResponsesLoopbackDriverOptions {
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
  readonly #maxNativeToolRequestBytes: number;
  readonly #maxNativeToolResponseBytes: number;
  readonly #searchTimeoutMs: number;
  readonly #imageTimeoutMs: number;
  readonly #apiKey = randomBytes(32).toString("base64url");
  readonly #catalogByIdentity = new Map<string, ResponsesNativeToolSpec>();
  readonly #relayControllers = new Set<AbortController>();
  #server: Server | undefined;
  #port: number | undefined;
  #requestCount = 0;
  #activeCall: ActiveToolCall | undefined;

  constructor(options: ResponsesLoopbackDriverOptions = {}) {
    this.#binding = options.binding ?? new Ipv4LoopbackServerBinding();
    if (this.#binding.host !== "127.0.0.1") {
      throw new Error("Responses loopback driver must bind to 127.0.0.1");
    }
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#maxNativeToolRequestBytes = positiveInteger(
      options.maxNativeToolRequestBytes,
      DEFAULT_MAX_NATIVE_TOOL_REQUEST_BYTES,
      "maxNativeToolRequestBytes",
    );
    this.#maxNativeToolResponseBytes = positiveInteger(
      options.maxNativeToolResponseBytes,
      DEFAULT_MAX_NATIVE_TOOL_RESPONSE_BYTES,
      "maxNativeToolResponseBytes",
    );
    this.#searchTimeoutMs = positiveInteger(
      options.searchTimeoutMs,
      DEFAULT_SEARCH_TIMEOUT_MS,
      "searchTimeoutMs",
    );
    this.#imageTimeoutMs = positiveInteger(
      options.imageTimeoutMs,
      DEFAULT_IMAGE_TIMEOUT_MS,
      "imageTimeoutMs",
    );
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
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        writeLoopbackError(response, error);
      });
    });
    this.#server = server;
    this.#port = await this.#binding.listen(server);
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#port = undefined;
    const active = this.#activeCall;
    this.#activeCall = undefined;
    active?.reject(new Error("Responses loopback driver stopped during a tool call"));
    for (const controller of this.#relayControllers) {
      controller.abort(new Error("Responses loopback driver stopped"));
    }
    this.#relayControllers.clear();
    if (server === undefined) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  prepareToolCall(selection: ResponsesSelectedToolCall): {
    readonly callId: string;
    readonly completion: Promise<ResponsesToolExecutionResult>;
  } {
    if (this.#activeCall !== undefined) {
      throw new Error("Responses loopback driver already has an active tool call");
    }
    const callId = `call_omnicodex_${randomUUID()}`;
    let resolveCompletion!: (value: ResponsesToolExecutionResult) => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<ResponsesToolExecutionResult>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    this.#activeCall = {
      selection,
      callId,
      completion,
      resolve: resolveCompletion,
      reject: rejectCompletion,
    };
    return { callId, completion };
  }

  cancelActiveToolCall(error: Error): void {
    const active = this.#activeCall;
    this.#activeCall = undefined;
    active?.reject(error);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.#isAuthorized(request)) {
      throw new LoopbackHttpError(401, "LOOPBACK_UNAUTHORIZED", "Loopback secret was invalid");
    }
    const url = new URL(request.url ?? "/", this.baseUrl);
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
      await this.#relayNativeTool(request, response, url.pathname);
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          models: [
            {
              slug: "gpt-5.6-sol",
              display_name: "GPT-5.6-Sol (OmniCodex loopback)",
              description: "Model-free native tool execution driver.",
              prefer_websockets: false,
              shell_type: "shell_command",
              visibility: "list",
              supported_in_api: true,
              context_window: 372000,
              base_instructions: "Execute only the tool call selected by the OmniCodex client.",
              default_reasoning_level: "low",
              supported_reasoning_levels: [
                { effort: "low", description: "No inference is performed." },
              ],
              support_verbosity: true,
              default_verbosity: "low",
              truncation_policy: { mode: "tokens", limit: 10_000 },
              tool_mode: "code_mode_only",
              multi_agent_version: "v2",
              use_responses_lite: false,
              include_skills_usage_instructions: false,
              include_plugin_usage_instructions: true,
              include_apps_usage_instructions: true,
              auto_review_model_override: null,
              apply_patch_tool_type: "freeform",
              web_search_tool_type: "text_and_image",
              supports_search_tool: true,
              supports_parallel_tool_calls: false,
              supports_image_detail_original: true,
              input_modalities: ["text", "image"],
              max_context_window: 372000,
              auto_compact_token_limit: null,
              comp_hash: "omnicodex-loopback-v1",
              default_reasoning_summary: "none",
              experimental_supported_tools: [],
              priority: 1,
            },
          ],
        }),
      );
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
    this.#requestCount += 1;
    this.#captureTools(body);
    const active = this.#activeCall;
    const correlatedOutput = active === undefined ? undefined : findCallOutput(body, active.callId);
    if (active !== undefined && correlatedOutput !== undefined) {
      this.#activeCall = undefined;
      active.resolve({
        callId: active.callId,
        outputType: String(correlatedOutput.type ?? "unknown"),
        output: outputValue(correlatedOutput),
        rawItem: correlatedOutput,
      });
      await this.#writeAssistantCompletion(response, body);
      return;
    }
    if (active !== undefined) {
      await this.#writeSelectedToolCall(response, body, active);
      return;
    }
    await this.#writeAssistantCompletion(response, body);
  }

  async #relayNativeTool(
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
    const headers = nativeToolUpstreamHeaders(request);
    const upstreamPath = localPath.slice("/v1".length);
    const upstreamUrl = `${CODEX_TOOL_UPSTREAM_BASE_URL}${upstreamPath}`;
    this.#requestCount += 1;

    const relayController = new AbortController();
    this.#relayControllers.add(relayController);
    let timedOut = false;
    const timeout = setTimeout(
      () => {
        timedOut = true;
        relayController.abort(new Error("Native tool upstream timed out"));
      },
      localPath.includes("/images/") ? this.#imageTimeoutMs : this.#searchTimeoutMs,
    );
    const abortForDisconnect = () => {
      if (!response.writableEnded) {
        relayController.abort(new Error("Native tool relay client disconnected"));
      }
    };
    request.once("aborted", abortForDisconnect);
    response.once("close", abortForDisconnect);
    const cleanupRelay = () => {
      clearTimeout(timeout);
      request.removeListener("aborted", abortForDisconnect);
      response.removeListener("close", abortForDisconnect);
      this.#relayControllers.delete(relayController);
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
        { cause: safeErrorName(error) },
      );
    }

    try {
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel().catch(() => undefined);
        throw new LoopbackHttpError(
          502,
          "NATIVE_TOOL_UPSTREAM_REDIRECT_BLOCKED",
          "Native tool upstream redirect was blocked",
          { upstreamStatus: upstream.status },
        );
      }
      const upstreamContentType = upstream.headers.get("content-type") ?? "";
      if (!isAllowedNativeResponseContentType(localPath, upstreamContentType)) {
        await upstream.body?.cancel().catch(() => undefined);
        throw new LoopbackHttpError(
          502,
          "NATIVE_TOOL_UPSTREAM_CONTENT_TYPE_REJECTED",
          "Native tool upstream response content type was not allowed",
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
      if (!upstream.ok) {
        const errorBody = await readFetchResponseBody(
          upstream,
          Math.min(this.#maxNativeToolResponseBytes, 64 * 1024),
          "Native tool error response",
        );
        throw new LoopbackHttpError(
          mappedUpstreamErrorStatus(upstream.status),
          "NATIVE_TOOL_UPSTREAM_ERROR",
          upstreamErrorMessage(errorBody, upstream.status),
          { upstreamStatus: upstream.status },
        );
      }

      response.writeHead(upstream.status, nativeToolDownstreamHeaders(upstream.headers));
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
      const identity = `${tool.type}\u0000${typeof tool.name === "string" ? tool.name : stableJson(tool)}`;
      this.#catalogByIdentity.set(identity, structuredClone(tool));
    }
  }

  async #writeSelectedToolCall(
    response: ServerResponse,
    body: Record<string, unknown>,
    active: ActiveToolCall,
  ): Promise<void> {
    const responseId = `resp_omnicodex_${randomUUID()}`;
    const itemId = `${active.selection.kind === "tool_search" ? "tsc" : active.selection.kind === "custom" || active.selection.kind === "freeform" ? "ctc" : "fc"}_${randomUUID()}`;
    const item = selectedCallItem(active.selection, active.callId, itemId, "in_progress");
    const completedItem = selectedCallItem(active.selection, active.callId, itemId, "completed");
    const snapshot = responseSnapshot(responseId, body, "completed", [completedItem]);
    const events: Array<[string, Record<string, unknown>]> = [
      ["response.created", { response: responseSnapshot(responseId, body, "in_progress", []) }],
      ["response.output_item.added", { output_index: 0, item }],
    ];
    if (active.selection.kind === "custom" || active.selection.kind === "freeform") {
      const input = customInput(active.selection.arguments);
      events.push([
        "response.custom_tool_call_input.delta",
        { item_id: itemId, output_index: 0, delta: input },
      ]);
      events.push([
        "response.custom_tool_call_input.done",
        { item_id: itemId, output_index: 0, input },
      ]);
    } else if (active.selection.kind !== "tool_search") {
      const argumentsText = functionArguments(
        active.selection.arguments,
        active.selection.kind === "unknown",
      );
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
    if (NATIVE_TOOL_REQUEST_HEADERS.has(name) && value !== undefined) {
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
  if (accountId.length > 0 && accountId.length <= 512) {
    headers.set("chatgpt-account-id", accountId);
  }
  return headers;
}

function nativeToolDownstreamHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    if (NATIVE_TOOL_RESPONSE_HEADERS.has(name)) result[name] = value;
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

function isAllowedNativeResponseContentType(path: string, value: string): boolean {
  const mediaType = normalizedMediaType(value);
  if (mediaType === "application/json" || mediaType === "text/event-stream") return true;
  return path.startsWith("/v1/images/") && mediaType.startsWith("image/");
}

function isJsonContentType(value: string): boolean {
  return normalizedMediaType(value) === "application/json";
}

function normalizedMediaType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function assertContentLengthWithinLimit(
  contentLengthValue: string | null,
  limitBytes: number,
  code: string,
): void {
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

function mappedUpstreamErrorStatus(status: number): number {
  if (status === 408 || status === 429) return status;
  return status >= 500 ? 502 : 424;
}

function upstreamErrorMessage(body: Buffer, status: number): string {
  const text = body.toString("utf8");
  try {
    const parsed: unknown = JSON.parse(text);
    if (isObject(parsed) && isObject(parsed.error) && typeof parsed.error.message === "string") {
      return parsed.error.message.slice(0, 1_000);
    }
  } catch {
    // A bounded generic message avoids reflecting an HTML or binary error body.
  }
  return `Native tool upstream returned status ${status}`;
}

function safeErrorName(value: unknown): string {
  return value instanceof Error && value.name.length > 0 ? value.name.slice(0, 100) : "Error";
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
  const body = await readBody(request, 64 * 1024 * 1024, "Responses request");
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
  limitBytes: number,
  label: string,
  status = 413,
  code = "LOOPBACK_REQUEST_TOO_LARGE",
): Promise<Buffer> {
  const declaredLength = Number(firstHeaderValue(request.headers["content-length"]));
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    throw new LoopbackHttpError(status, code, `${label} exceeded the configured size limit`, {
      limitBytes,
    });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limitBytes) {
      throw new LoopbackHttpError(status, code, `${label} exceeded the configured size limit`, {
        limitBytes,
      });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readFetchResponseBody(
  response: Response,
  limitBytes: number,
  label: string,
): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > limitBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new LoopbackHttpError(
      502,
      "NATIVE_TOOL_RESPONSE_TOO_LARGE",
      `${label} exceeded the configured size limit`,
      { limitBytes },
    );
  }
  if (response.body === null) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const buffer = Buffer.from(value);
      size += buffer.length;
      if (size > limitBytes) {
        await reader.cancel();
        throw new LoopbackHttpError(
          502,
          "NATIVE_TOOL_RESPONSE_TOO_LARGE",
          `${label} exceeded the configured size limit`,
          { limitBytes },
        );
      }
      chunks.push(buffer);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function streamFetchResponseBody(
  upstream: Response,
  response: ServerResponse,
  limitBytes: number,
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
      if (size > limitBytes) {
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

function findCallOutput(
  body: Record<string, unknown>,
  callId: string,
): Record<string, unknown> | undefined {
  if (!Array.isArray(body.input)) {
    return undefined;
  }
  return body.input.find(
    (item): item is Record<string, unknown> =>
      isObject(item) &&
      item.call_id === callId &&
      (item.type === "function_call_output" ||
        item.type === "custom_tool_call_output" ||
        item.type === "tool_search_output"),
  );
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
      : new LoopbackHttpError(500, "LOOPBACK_INTERNAL_ERROR", "Loopback request failed");
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

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return selected;
}
