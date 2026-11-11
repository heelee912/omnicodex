import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, isAbsolute } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  type BrotliOptions,
  createBrotliCompress,
  createGzip,
  constants as zlibConstants,
} from "node:zlib";
import { getRequestListener } from "@hono/node-server";
import { toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  EventId,
  EventStore,
  StreamId,
  WebStandardStreamableHTTPServerTransportOptions,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type {
  CallToolResult,
  JSONRPCMessage,
  MessageExtraInfo,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createMcpHandler,
  isLegacyRequest,
  type AuthInfo as ModernAuthInfo,
} from "@modelcontextprotocol/server";
import type { AppServerMethodCatalog } from "../../application/app-server-method-catalog.js";
import type { BrowserActivityLifecycleCoordinator } from "../../application/chatgpt-browser-activity-coordinator.js";
import type { CodexAppHostToolExecutor } from "../../application/codex-app-host-tool-executor.js";
import type { CodexThreadMessageClient } from "../../application/codex-thread-message-client.js";
import { NativeExecutionScheduler } from "../../application/native-execution-scheduler.js";
import type {
  AppServerRpcClient,
  NativeToolCatalog,
  NativeToolExecutor,
} from "../../application/native-tool-catalog.js";
import type {
  ResponsesNativeToolCatalog,
  ResponsesNativeToolExecutor,
} from "../../application/responses-native-tool-catalog.js";
import type { DurableNativeResourceLeaseCoordinatorLike } from "../runtime/durable-native-resource-lease-coordinator.js";
import { errorMessage, structuredErrorDetails } from "../runtime/structured-error-details.js";
import { canonicalJson } from "../safety/canonical-json.js";
import { DirectGoalStore } from "./direct-goal-store.js";
import type { DirectJobDispatchAdapter, DirectJobManager } from "./direct-job-mcp-tools.js";
import type { DirectScheduleManager } from "./direct-schedule-mcp-tools.js";
import {
  type DurableMcpEventReplaySession,
  DurableMcpEventSessionAmbiguousError,
  type DurableMcpEventSessionBinding,
  DurableMcpEventSessionBindingError,
  DurableMcpEventSessionExpiredError,
  DurableMcpEventSessionNotFoundError,
  type DurableMcpEventStore,
} from "./durable-mcp-event-store.js";
import type {
  DurableWorkSessionBinding,
  DurableWorkSessionStore,
} from "./durable-work-session-store.js";
import { LegacyMutationCoordinator } from "./legacy-mutation-coordinator.js";
import {
  callerProvenanceFromRequestMeta,
  chatGptConversationUrlFromRequestMeta,
  compareNativeRequestIdentities,
  type McpRequestAttribution,
  type McpRequestIdentityDigest,
  McpWorkSessionContext,
  nativeRequestIdentityMatcher,
  type OpenAiSessionIdentityKind,
  openAiSessionIdentityKindFromRequestMeta,
  workSessionRequestBinding,
  workSessionRequestIncludesToolCall,
  workSessionRequestMeta,
} from "./mcp-work-session-context.js";
import { MutationReplayStore } from "./mutation-replay-store.js";
import {
  type BrowserNativeToolExecutor,
  createOmniCodexMcpServer,
  type DirectJobWorkSessionBinding,
  type McpMutationReplayObservation,
  type McpProgressObservation,
  type McpReadInvocationObservation,
  type McpRequestAttributionObservation,
  type McpResultDeliveryObservation,
  type McpToolCatalogObservation,
  type MutationIdentityInputPresence,
  mutationIdentityInputPresence,
  type NativeToolExecutionObservation,
  OMNICODEX_ACTIVITY_RESOURCE_URI,
  type OmniCodexFullCatalogSnapshot,
  type OmniCodexMcpServerHandle,
  OmniCodexNativeToolRegistryCatalog,
  type ProtectedResultReadChunk,
  type ProtectedResultReadRequest,
} from "./omnicodex-mcp-server.js";
import {
  authorizationBinding,
  durablePrincipalBinding,
  OwnerBoundResourceStore,
  validOpaqueResourceId,
} from "./owner-bound-resource-store.js";
import { protectOversizedResult } from "./protected-result-mapper.js";
import { ReadInvocationCoordinator } from "./read-invocation-coordinator.js";

/**
 * The upstream Node adapter opportunistically buffers a small Web ReadableStream
 * and rewrites it as Content-Length. That is useful for ordinary responses but
 * turns a finite MCP SSE result into a proxy-sensitive close race. Preserve the
 * SDK's Web-standard protocol implementation and only force SSE bodies through
 * the adapter's streaming branch.
 */
class StreamableHTTPServerTransport {
  readonly #transport: WebStandardStreamableHTTPServerTransport;

  constructor(options: WebStandardStreamableHTTPServerTransportOptions = {}) {
    this.#transport = new WebStandardStreamableHTTPServerTransport(options);
  }

  get sessionId(): string | undefined {
    return this.#transport.sessionId;
  }

  set onclose(handler: (() => void) | undefined) {
    if (handler === undefined) delete this.#transport.onclose;
    else this.#transport.onclose = handler;
  }

  get onclose(): (() => void) | undefined {
    return this.#transport.onclose;
  }

  set onerror(handler: ((error: Error) => void) | undefined) {
    if (handler === undefined) delete this.#transport.onerror;
    else this.#transport.onerror = handler;
  }

  get onerror(): ((error: Error) => void) | undefined {
    return this.#transport.onerror;
  }

  set onmessage(handler:
    | ((message: JSONRPCMessage, extra?: MessageExtraInfo) => void)
    | undefined,) {
    if (handler === undefined) delete this.#transport.onmessage;
    else this.#transport.onmessage = handler;
  }

  get onmessage(): ((message: JSONRPCMessage, extra?: MessageExtraInfo) => void) | undefined {
    return this.#transport.onmessage;
  }

  start(): Promise<void> {
    return this.#transport.start();
  }

  close(): Promise<void> {
    return this.#transport.close();
  }

  send(
    message: JSONRPCMessage,
    options?: { readonly relatedRequestId?: RequestId },
  ): Promise<void> {
    return this.#transport.send(message, options);
  }

  async handleRequest(
    request: IncomingMessage & { auth?: AuthInfo },
    response: ServerResponse,
    parsedBody?: unknown,
  ): Promise<void> {
    const authInfo = request.auth;
    const handler = getRequestListener(
      async (webRequest) =>
        unbufferedMcpSseResponse(
          await this.#transport.handleRequest(webRequest, {
            ...(authInfo === undefined ? {} : { authInfo }),
            ...(parsedBody === undefined ? {} : { parsedBody }),
          }),
        ),
      { overrideGlobalObjects: false },
    );
    await handler(request, response);
  }

  closeSSEStream(requestId: RequestId): void {
    this.#transport.closeSSEStream(requestId);
  }

  closeStandaloneSSEStream(): void {
    this.#transport.closeStandaloneSSEStream();
  }
}

function unbufferedMcpSseResponse(response: Response): Response {
  if (
    response.body === null ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Transfer-Encoding", "chunked");
  headers.set("X-Accel-Buffering", "no");
  headers.set("Cache-Control", "no-cache, no-transform");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Keep the sessionful 2025-era transport list explicit. The 2026 era is
// served by the official per-request handler and never enters this legacy
// initialize negotiation.
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;
const MAX_FETCH_SAFE_EPHEMERAL_BIND_ATTEMPTS = 16;
const STANDALONE_SSE_KEEPALIVE_INTERVAL_MS = 15_000;
/**
 * A local operator that exits without DELETE leaves a transport-scoped session
 * whose native runtime (App Server, node_repl and their children) is never
 * retired. Each such session holds hundreds of MB of commit, so an abandoned
 * one is retired after this idle time.
 */
export const LOCAL_TRANSPORT_SESSION_IDLE_MS = 10 * 60_000;
const LOCAL_TRANSPORT_SESSION_SWEEP_MAX_MS = 60_000;
const RESOURCE_PATH_PREFIX = "/resources/";
// A protected result is lossless and has no aggregate size ceiling, but each
// Web-visible tool result becomes part of the ChatGPT conversation DOM. Read
// at most this many source bytes, then shrink the decoded prefix until the
// structured chunk itself fits the ordinary inline-result budget. JSON
// escaping can otherwise make a 64 KiB source prefix exceed that budget and
// recursively protect the retrieval result. `nextOffset` still walks the
// complete UTF-8 payload without omission.
const PROTECTED_RESULT_CHUNK_BYTES = 64 * 1024;
const MAX_PROTECTED_RESULT_CHUNK_SERIALIZED_BYTES = 60 * 1024;
const RESOURCE_COMPRESSION_MINIMUM_BYTES = 16 * 1024;
const TRANSPORT_IDENTITY_HEADERS = new Set([
  "idempotency-key",
  "last-event-id",
  "mcp-session-id",
  "openai-request-id",
  "traceparent",
  "x-correlation-id",
  "x-idempotency-key",
  "x-openai-call-id",
  "x-openai-request-id",
  "x-openai-tool-call-id",
  "x-openai-trace-id",
  "x-openai-transaction-id",
  "x-request-id",
]);
const ALLOWED_CORS_HEADERS = new Set([
  "authorization",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
  ...TRANSPORT_IDENTITY_HEADERS,
]);

export interface HttpAuthorizationIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly clientId: string;
  readonly resource: string;
  /**
   * Local one-shot operators do not own a reconnectable Web conversation.
   * Their mutable native executors must retire with the MCP transport so a
   * completed diagnostic call cannot keep Browser Use resources attached.
   */
  readonly executorLifecycle?: "transport" | "durable-work-session";
}

export interface HttpAuthorizationDecision {
  readonly ok: boolean;
  readonly authInfo?: AuthInfo;
  readonly identity?: HttpAuthorizationIdentity;
  readonly status?: number;
  /** Metadata-only reason code. Never contains bearer-token or claim values. */
  readonly failureCode?: string;
  /** Standard JWT claim name only (for example `aud` or `exp`). */
  readonly failureClaim?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly message?: string;
}

export interface StreamableHttpGatewayOptions {
  readonly appServer: AppServerRpcClient;
  /** Shared live downstream catalog used by Code Mode and every MCP session. */
  readonly nativeToolCatalog?: NativeToolCatalog;
  readonly nativeToolExecutor?: NativeToolExecutor;
  readonly appServerMethodCatalog?: AppServerMethodCatalog;
  readonly responsesToolCatalog?: ResponsesNativeToolCatalog;
  readonly responsesToolExecutor?: ResponsesNativeToolExecutor;
  /** Creates mutable executor state for one authenticated MCP session. */
  readonly createSessionExecutors?: (
    context: McpSessionExecutorContext,
  ) => Promise<McpSessionExecutors> | McpSessionExecutors;
  readonly browserNativeExecutor?: BrowserNativeToolExecutor;
  /** Runtime-wide authoritative Browser Use turn lifecycle. */
  readonly browserActivityCoordinator?: BrowserActivityLifecycleCoordinator;
  readonly codexAppHostToolExecutor?: CodexAppHostToolExecutor;
  readonly desktopIpcClient?: CodexThreadMessageClient;
  /** Runtime-wide coordinator shared with Code Mode and every MCP session. */
  readonly scheduler?: NativeExecutionScheduler;
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  readonly fullPath?: string;
  /** Public ChatGPT action-catalog registration budget; omitted for complete local catalogs. */
  readonly actionCatalogByteBudget?: number;
  readonly authorize: (
    request: IncomingMessage,
  ) => Promise<HttpAuthorizationDecision> | HttpAuthorizationDecision;
  readonly allowedOrigins?: readonly string[];
  readonly allowedHosts?: readonly string[];
  /** Stable public HTTPS origin used in OAuth challenges behind a reverse proxy. */
  readonly publicMetadataOrigin?: string;
  readonly protectedResourceMetadata?: Record<string, unknown>;
  /** Optional same-origin OAuth metadata facade for clients that reject cross-origin discovery. */
  readonly authorizationServerMetadata?: Record<string, unknown>;
  /** Exact stable identity advertised by this public MCP deployment. */
  readonly serverIdentity?: string;
  readonly resourceStore?: OwnerBoundResourceStore;
  /** Gateway-wide, restart-durable direct-work Goal and evidence store. */
  readonly directGoalStore?: DirectGoalStore;
  /** Daemon-wide durable native fence reconciled by successful Goal readback. */
  readonly nativeResourceLeaseCoordinator?: DurableNativeResourceLeaseCoordinatorLike;
  /** Gateway-wide, restart-durable native direct-job coordinator. */
  readonly directJobManager?: DirectJobManager;
  /** Daemon-wide exact-native schedule coordinator. */
  readonly directScheduleManager?: DirectScheduleManager;
  /** Runtime-generation dispatcher whose lifetime is independent of MCP transports. */
  readonly directJobDispatchAdapter?: DirectJobDispatchAdapter;
  /** Resolves a stable owner-and-Web-conversation identity for every request. */
  readonly durableWorkSessionStore?: DurableWorkSessionStore;
  /**
   * Production durable SSE history. When omitted, the bounded in-memory store
   * remains available for tests and explicitly non-durable deployments only.
   */
  readonly durableMcpEventStoreFactory?: DurableMcpEventStoreFactory;
  readonly mutationReplayStore?: MutationReplayStore;
  readonly legacyMutationCoordinator?: LegacyMutationCoordinator;
  /** Runtime-generation coordinator shared by every authenticated MCP transport. */
  readonly readInvocationCoordinator?: ReadInvocationCoordinator;
  /** Optional caller-selected single-request frame limit. Omitted means no logical total cap. */
  readonly maxRequestBodyBytes?: number;
  /**
   * Caller-selected hard ceiling for graceful request, native execution,
   * session, and listener shutdown. Omitted means lossless unbounded drain.
   */
  readonly shutdownHardTimeoutMs?: number;
  /**
   * Idle time after which a transport-scoped local operator session is retired
   * when its client disappeared without DELETE. Web conversation sessions are
   * never affected. Defaults to LOCAL_TRANSPORT_SESSION_IDLE_MS.
   */
  readonly localTransportSessionIdleMs?: number;
  /** Metadata-only MCP request observer. Tool arguments, results, tokens, and session IDs are excluded. */
  readonly observeMcpRequest?: (
    observation: StreamableHttpGatewayRequestObservation,
  ) => Promise<void> | void;
  /**
   * Request-local exact ChatGPT route used only for immediate Oracle targeting.
   * Implementations must not persist or log the raw conversation URL.
   */
  readonly prepareChatGptConversationRequest?: (input: {
    readonly surface: "compat" | "full";
    readonly chatGptConversationUrl: string;
  }) => Promise<void> | void;
  /** Metadata-only observer for OAuth discovery diagnostics; never includes headers or tokens. */
  readonly observeAuthorizationServerMetadataRequest?: (
    observation: AuthorizationServerMetadataRequestObservation,
  ) => Promise<void> | void;
  /** Metadata-only native execution observer. Arguments, results, tokens, and session IDs are excluded. */
  readonly observeNativeToolExecution?: (
    observation: NativeToolExecutionObservation,
  ) => Promise<void> | void;
  readonly prepareProtectedResultDelivery?: (input: {
    readonly surface: "compat" | "full";
    readonly mcpToolName: string;
    readonly chatGptConversationUrl?: string;
    readonly correlationId?: string;
  }) => Promise<void> | void;
  readonly observeProgress?: (observation: McpProgressObservation) => Promise<void> | void;
  readonly observeResultDelivery?: (
    observation: McpResultDeliveryObservation,
  ) => Promise<void> | void;
  readonly observeMutationReplay?: (
    observation: McpMutationReplayObservation,
  ) => Promise<void> | void;
  readonly observeReadInvocation?: (
    observation: McpReadInvocationObservation,
  ) => Promise<void> | void;
  readonly observeToolCatalog?: (observation: McpToolCatalogObservation) => Promise<void> | void;
}

export interface DurableMcpEventStoreFactory {
  open(binding: DurableMcpEventSessionBinding): Promise<DurableMcpEventStore>;
  /** GET + Last-Event-ID only; this return value must never rehydrate POST state. */
  rehydrateByTransport(binding: {
    readonly ownerBinding: string;
    readonly surface: "compat" | "full";
    readonly transportSessionId: string;
  }): Promise<DurableMcpEventReplaySession>;
}

export interface McpSessionExecutorContext {
  readonly identity: HttpAuthorizationIdentity;
  readonly authorizationBinding: string;
  /** Opaque server-generated session correlation, never a bearer token. */
  readonly correlationId: string;
  /**
   * Resolves the durable Web-conversation binding after request metadata has
   * been validated. It remains stable after the originating transport closes
   * so transport-independent direct work can retain its exact native lease.
   */
  readonly resolveWorkSessionBinding?: () => string | undefined;
}

export interface McpSessionExecutors {
  readonly nativeToolExecutor?: NativeToolExecutor;
  /** Mutable first-party browser state bound to this exact Web work session. */
  readonly browserNativeExecutor?: BrowserNativeToolExecutor;
  readonly responsesToolExecutor?: ResponsesNativeToolExecutor;
  readonly close?: () => Promise<void> | void;
}

export interface StreamableHttpGatewayRequestObservation {
  readonly invocationIdentityInputs?: MutationIdentityInputPresence;
  readonly responseEndedAtUnixMs?: number;
  readonly responseTermination?: "finish" | "close_before_finish";
  readonly requestAbortedAtUnixMs?: number;
  readonly correlationId?: string;
  readonly principalBindingSha256?: string;
  readonly workSessionBindingSha256?: string;
  readonly invocationIdSha256?: string;
  readonly callerProvenance?: McpRequestAttribution["callerProvenance"];
  readonly openAiSessionIdentityKind?: OpenAiSessionIdentityKind;
  readonly chatGptConversationIdSha256?: string;
  readonly httpMethod: "GET" | "POST" | "DELETE" | "unknown";
  readonly surface: "compat" | "full";
  readonly rpcMethod?: string;
  /** Credential-free MCP UI resource identity; never a file or download URL. */
  readonly uiResourceUri?: string;
  readonly sessionHeaderPresent: boolean;
  readonly protocolVersion?: string;
  /** Process-keyed HMAC of the typed JSON-RPC id; never the raw id. */
  readonly jsonRpcIdHmac?: string;
  /** Allowlisted transport/request metadata names with keyed HMAC values only. */
  readonly transportIdentityDigests?: readonly TransportIdentityDigest[];
  readonly status: number;
  readonly outcome: string;
}

export interface AuthorizationServerMetadataRequestObservation {
  readonly httpMethod: "GET" | "unknown";
  readonly path: string;
  readonly status: 200 | 405;
}

export type TransportIdentityDigest = McpRequestIdentityDigest;

export interface StreamableHttpGatewayAddress {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly fullPath: string;
}

interface McpExecutionScope {
  /** Exact value returned by the transport's sessionIdGenerator. */
  readonly transportSessionId: string;
  readonly mcp: OmniCodexMcpServerHandle;
  readonly surface: "compat" | "full";
  /** Live transport identity, including the OAuth client registration. */
  readonly authorizationBinding: string;
  /** Stable durable-state principal, excluding the rotatable OAuth clientId. */
  readonly durablePrincipalBinding: string;
  readonly correlationId: string;
  readonly workSessionContext: McpWorkSessionContext;
  /** Request attribution survives SDK dispatch outside AsyncLocalStorage. */
  readonly requestAttributions: Map<string, McpRequestAttribution>;
  readonly bindExecutorWorkSession: (workSessionBinding: string) => void;
  readonly closeExecutors: (deadlineUnixMs?: number) => Promise<void>;
}

interface Session extends McpExecutionScope {
  readonly transport: StreamableHTTPServerTransport;
  readonly eventStore: DeferredDurableMcpEventStore;
  terminationPromise?: Promise<void>;
  standaloneSseGeneration: number;
  standaloneSsePrimaryGeneration?: number;
  readonly standaloneSseLeases: Map<number, StandaloneSseLease>;
  /** Every live HTTP response the SDK may currently write to for this session. */
  readonly activeResponses: Set<ServerResponse>;
  /** Finite POST responses; unlike standalone SSE, these prove an invocation is still in flight. */
  readonly activeFiniteResponses: Set<ServerResponse>;
  /** Stable ChatGPT conversation binding for causally superseded one-shot transports. */
  openAiWorkSessionBinding?: string;
  /** Local operator session whose executors live only as long as this transport. */
  readonly transportScopedExecutors: boolean;
  /** Last time a response for this session started or ended. */
  lastActivityUnixMs: number;
}

interface StandaloneSseLease {
  readonly generation: number;
  readonly delivery: "sdk" | "passive";
  readonly streamId: string;
  readonly response: ServerResponse;
  readonly closed: Promise<void>;
  readonly release: () => void;
  active: boolean;
  keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  keepaliveWritePending: boolean;
}

/**
 * Buffers metadata-free initialize events, then atomically adopts them into
 * the owner/work-session-bound durable store before the first bound call.
 */
export interface DeferredDurableMcpEventStoreOptions {
  readonly maxEvents?: number;
  readonly ttlMs?: number;
  readonly nowUnixMs?: () => number;
  readonly nonce?: string;
}

export class DeferredDurableMcpEventStore implements EventStore {
  readonly #buffered: {
    readonly id: EventId;
    readonly streamId: StreamId;
    readonly message: JSONRPCMessage;
    readonly storedAtUnixMs: number;
  }[] = [];
  readonly #maxEvents: number | undefined;
  readonly #ttlMs: number | undefined;
  readonly #nowUnixMs: () => number;
  readonly #nonce: string;
  #sequence = 0;
  #durable: DurableMcpEventStore | undefined;
  #binding: string | undefined;
  #terminated = false;
  #operation: Promise<unknown> = Promise.resolve();

  constructor(options: DeferredDurableMcpEventStoreOptions = {}) {
    this.#maxEvents = optionalRetentionBound(options.maxEvents, "maxEvents");
    this.#ttlMs = optionalRetentionBound(options.ttlMs, "ttlMs");
    this.#nowUnixMs = options.nowUnixMs ?? Date.now;
    this.#nonce = options.nonce ?? randomBytes(16).toString("base64url");
  }

  async bind(
    factory: DurableMcpEventStoreFactory,
    binding: DurableMcpEventSessionBinding,
  ): Promise<void> {
    await this.#exclusive(async () => {
      if (this.#terminated) throw new Error("MCP_EVENT_SESSION_TERMINATED");
      if (this.#binding !== undefined && this.#binding !== binding.workSessionBinding) {
        throw new Error("MCP_EVENT_WORK_SESSION_CONFLICT");
      }
      if (this.#durable !== undefined) return;
      this.#prune();
      const durable = await factory.open(binding);
      await durable.adoptBufferedEvents(this.#buffered);
      this.#durable = durable;
      this.#binding = binding.workSessionBinding;
      this.#buffered.length = 0;
    });
  }

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    return this.#exclusive(async () => {
      if (this.#terminated) throw new Error("MCP_EVENT_SESSION_TERMINATED");
      if (this.#durable !== undefined) return this.#durable.storeEvent(streamId, message);
      this.#prune();
      this.#sequence += 1;
      const id = `${this.#nonce}.${this.#sequence.toString(36)}`;
      this.#buffered.push({
        id,
        streamId,
        message,
        storedAtUnixMs: this.#nowUnixMs(),
      });
      while (this.#maxEvents !== undefined && this.#buffered.length > this.#maxEvents) {
        this.#buffered.shift();
      }
      return id;
    });
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return this.#exclusive(async () => {
      if (this.#terminated) return undefined;
      if (this.#durable !== undefined) return this.#durable.getStreamIdForEventId(eventId);
      this.#prune();
      return this.#buffered.find((event) => event.id === eventId)?.streamId;
    });
  }

  async replayEventsAfter(
    lastEventId: EventId,
    options: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    return this.#exclusive(async () => {
      if (this.#terminated) throw new Error("EVENT_HISTORY_EXPIRED");
      if (this.#durable !== undefined) {
        return this.#durable.replayEventsAfter(lastEventId, options);
      }
      this.#prune();
      const index = this.#buffered.findIndex((event) => event.id === lastEventId);
      if (index < 0) throw new Error("EVENT_HISTORY_EXPIRED");
      const anchor = this.#buffered[index];
      if (anchor === undefined) throw new Error("EVENT_HISTORY_EXPIRED");
      for (const event of this.#buffered.slice(index + 1)) {
        if (event.streamId === anchor.streamId) await options.send(event.id, event.message);
      }
      return anchor.streamId;
    });
  }

  /**
   * Permanently closes this transport's replay history. The operation shares
   * the bind/store serialization lane so a concurrent late bind cannot adopt
   * bootstrap events after DELETE has discarded them.
   */
  async tombstoneSession(): Promise<void> {
    await this.#exclusive(async () => {
      this.#terminated = true;
      this.#buffered.length = 0;
      await this.#durable?.tombstoneSession();
    });
  }

  #prune(): void {
    if (this.#ttlMs === undefined) return;
    const cutoff = this.#nowUnixMs() - this.#ttlMs;
    while ((this.#buffered[0]?.storedAtUnixMs ?? Number.POSITIVE_INFINITY) < cutoff) {
      this.#buffered.shift();
    }
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.#operation.then(operation, operation);
    this.#operation = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }
}

function optionalRetentionBound(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

interface NormalizedOptions
  extends Omit<StreamableHttpGatewayOptions, "maxRequestBodyBytes" | "shutdownHardTimeoutMs"> {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly fullPath: string;
  readonly allowedOrigins: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly maxRequestBodyBytes: number | undefined;
  readonly shutdownHardTimeoutMs: number | undefined;
}

export interface StreamableHttpGatewayRuntimeStatus {
  readonly admission: "open" | "draining";
  readonly activeMcpRequests: number;
  readonly activeModelTurns: number;
}

interface DrainWaiter {
  readonly resolve: () => void;
  readonly cancelDeadline?: () => void;
}

interface ActiveMcpRequestTracking {
  modelTurn: boolean;
}

interface MutableMcpRequestTrace {
  invocationIdentityInputs?: MutationIdentityInputPresence;
  correlationId: string | undefined;
  principalBindingSha256: string | undefined;
  workSessionBindingSha256: string | undefined;
  chatGptConversationIdSha256: string | undefined;
  openAiSessionIdentityKind: OpenAiSessionIdentityKind | undefined;
  rpcMethod: string | undefined;
  uiResourceUri: string | undefined;
  jsonRpcIdHmac: string | undefined;
  /** Retained only for an exact JSON-RPC error response; never emitted to telemetry. */
  responseId: string | number | null;
  invocationIdSha256: string | undefined;
  requestMetaDigests: readonly TransportIdentityDigest[];
  outcome: string;
}

/**
 * Loopback-bound Streamable HTTP MCP gateway. Authentication completes before
 * session lookup and the tunnel remains a separate process boundary.
 */
export class StreamableHttpGateway {
  readonly #options: NormalizedOptions;
  readonly #metadata:
    | {
        readonly compat: Record<string, unknown>;
        readonly full: Record<string, unknown>;
      }
    | undefined;
  readonly #resourceStore: OwnerBoundResourceStore;
  readonly #directGoalStore: DirectGoalStore;
  readonly #directJobManager: DirectJobManager | undefined;
  readonly #directScheduleManager: DirectScheduleManager | undefined;
  readonly #directJobDispatchAdapter: DirectJobDispatchAdapter | undefined;
  readonly #durableWorkSessionStore: DurableWorkSessionStore | undefined;
  readonly #mutationReplayStore: MutationReplayStore;
  readonly #legacyMutationCoordinator: LegacyMutationCoordinator;
  readonly #readInvocationCoordinator: ReadInvocationCoordinator;
  readonly #nativeToolRegistryCatalog: OmniCodexNativeToolRegistryCatalog | undefined;
  readonly #nativeExecutionScheduler: NativeExecutionScheduler;
  readonly #transportIdentityHmacKey = randomBytes(32);
  readonly #activeNativeRequestAttributions = new Set<McpRequestAttribution>();
  readonly #sessions = new Map<string, Session>();
  /**
   * ChatGPT currently opens a fresh Streamable HTTP transport for each tool
   * call while retaining the same documented `openai/session` identity. Keep
   * parallel live calls, but retire completed predecessor transports when a
   * later call proves the conversation has advanced.
   */
  readonly #openAiWorkSessionTransports = new Map<string, Set<Session>>();
  // Observation outlives individual HTTP transports, including stateless calls.
  // Runtime transitions resolve live conversation activity from this signal.
  readonly #observedOpenAiWorkSessions = new Set<string>();
  /**
   * Raw ChatGPT conversation ids are retained only in this process so a
   * planned runtime transition can avoid interrupting a Web turn between two
   * finite MCP calls. They are never persisted or emitted to telemetry.
   */
  readonly #observedChatGptConversationIds = new Set<string>();
  /** Sessions detached from transport lookup but not yet cleanly retired. */
  readonly #retiringSessions = new Set<Session>();
  /** Exact dispatchers owned by this runtime generation, retained across disconnects. */
  readonly #runtimeDirectJobAdapters = new Set<DirectJobDispatchAdapter>();
  /** Request-local execution scopes backing the SDK's stateless 2026 wire handler. */
  readonly #modernMcpScopes = new WeakMap<Request, McpExecutionScope>();
  #modernMcpHandler: ReturnType<typeof createMcpHandler> | undefined;
  readonly #terminatingSessions = new Map<
    string,
    {
      readonly ownerBinding: string;
      readonly surface: "compat" | "full";
      readonly promise: Promise<void>;
    }
  >();
  readonly #drainWaiters = new Set<DrainWaiter>();
  #server: Server | undefined;
  #address: StreamableHttpGatewayAddress | undefined;
  #stopPromise: Promise<void> | undefined;
  #shutdownCompleted = false;
  #idleLocalSessionSweep: ReturnType<typeof setInterval> | undefined;
  #admission: "open" | "draining" = "open";
  #activeMcpRequests = 0;
  #activeModelTurns = 0;

  constructor(options: StreamableHttpGatewayOptions) {
    const host = options.host ?? "127.0.0.1";
    if (host !== "127.0.0.1") {
      throw new Error("OmniCodex MCP must bind to 127.0.0.1 only");
    }
    const path = exactEndpointPath(options.path ?? "/mcp", "MCP path");
    const fullPath = exactEndpointPath(
      options.fullPath ?? `${path.replace(/\/$/, "")}/full`,
      "full MCP path",
    );
    if (path === fullPath) throw new Error("MCP paths must be distinct");
    const maxRequestBodyBytes = options.maxRequestBodyBytes;
    if (
      maxRequestBodyBytes !== undefined &&
      (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes <= 0)
    ) {
      throw new Error("MCP request body limit must be a positive integer");
    }
    const shutdownHardTimeoutMs = options.shutdownHardTimeoutMs;
    if (
      shutdownHardTimeoutMs !== undefined &&
      (!Number.isSafeInteger(shutdownHardTimeoutMs) || shutdownHardTimeoutMs <= 0)
    ) {
      throw new Error("Shutdown hard timeout must be a positive integer");
    }
    const allowedOrigins = (options.allowedOrigins ?? []).map(exactOrigin);
    if (allowedOrigins.includes("*")) throw new Error("Wildcard CORS origins are forbidden");
    const publicMetadataOrigin =
      options.publicMetadataOrigin === undefined
        ? undefined
        : exactPublicMetadataOrigin(options.publicMetadataOrigin);
    const metadata = normalizeProtectedResourceMetadata(options.protectedResourceMetadata);
    const authorizationServerMetadata = normalizeAuthorizationServerMetadata(
      options.authorizationServerMetadata,
    );
    this.#metadata =
      metadata === undefined
        ? undefined
        : {
            compat: metadataForResourcePath(metadata, path),
            full: metadataForResourcePath(metadata, fullPath),
          };
    this.#options = {
      ...options,
      host,
      port: options.port ?? 0,
      path,
      fullPath,
      allowedOrigins,
      allowedHosts: (options.allowedHosts ?? []).map(exactHost),
      ...(publicMetadataOrigin === undefined ? {} : { publicMetadataOrigin }),
      ...(authorizationServerMetadata === undefined ? {} : { authorizationServerMetadata }),
      maxRequestBodyBytes,
      shutdownHardTimeoutMs,
    };
    this.#resourceStore = options.resourceStore ?? new OwnerBoundResourceStore();
    this.#directGoalStore = options.directGoalStore ?? DirectGoalStore.inMemory();
    this.#directJobManager = options.directJobManager;
    this.#directScheduleManager = options.directScheduleManager;
    this.#directJobDispatchAdapter = options.directJobDispatchAdapter;
    if (this.#directJobDispatchAdapter !== undefined) {
      this.#runtimeDirectJobAdapters.add(this.#directJobDispatchAdapter);
    }
    this.#durableWorkSessionStore = options.durableWorkSessionStore;
    if (this.#directJobManager !== undefined && this.#durableWorkSessionStore === undefined) {
      throw new Error("Direct jobs require the durable Web work-session store");
    }
    if (
      this.#directScheduleManager !== undefined &&
      (this.#directJobManager === undefined ||
        this.#durableWorkSessionStore === undefined ||
        this.#directJobDispatchAdapter === undefined)
    ) {
      throw new Error(
        "Direct schedules require direct jobs, durable work sessions, and a runtime-owned dispatcher",
      );
    }
    if (
      options.durableMcpEventStoreFactory !== undefined &&
      this.#durableWorkSessionStore === undefined
    ) {
      throw new Error("Durable MCP events require the durable Web work-session store");
    }
    this.#nativeExecutionScheduler = options.scheduler ?? new NativeExecutionScheduler();
    this.#mutationReplayStore = options.mutationReplayStore ?? MutationReplayStore.inMemory();
    this.#legacyMutationCoordinator =
      options.legacyMutationCoordinator ?? LegacyMutationCoordinator.inMemory();
    this.#readInvocationCoordinator =
      options.readInvocationCoordinator ?? new ReadInvocationCoordinator();
    this.#nativeToolRegistryCatalog =
      options.codexAppHostToolExecutor === undefined
        ? undefined
        : new OmniCodexNativeToolRegistryCatalog({
            appServer: options.appServer,
            ...(options.nativeToolCatalog === undefined
              ? {}
              : { nativeToolCatalog: options.nativeToolCatalog }),
            codexAppHostToolExecutor: options.codexAppHostToolExecutor,
            ...(options.appServerMethodCatalog === undefined
              ? {}
              : { appServerMethodCatalog: options.appServerMethodCatalog }),
            ...(options.responsesToolCatalog === undefined
              ? {}
              : { responsesToolCatalog: options.responsesToolCatalog }),
            ...(options.browserNativeExecutor === undefined
              ? {}
              : { browserNativeExecutor: options.browserNativeExecutor }),
            mutationReplayStore: this.#mutationReplayStore,
            directGoalStore: this.#directGoalStore,
            ...(this.#directJobManager === undefined
              ? {}
              : { directJobManager: this.#directJobManager }),
            ...(this.#directScheduleManager === undefined
              ? {}
              : { directScheduleManager: this.#directScheduleManager }),
            ...(options.actionCatalogByteBudget === undefined
              ? {}
              : { actionCatalogByteBudget: options.actionCatalogByteBudget }),
          });
    this.#modernMcpHandler = this.#createModernMcpHandler();
  }

  #createModernMcpHandler(): ReturnType<typeof createMcpHandler> {
    return createMcpHandler(
      ({ requestInfo }) => {
        const scope =
          requestInfo === undefined ? undefined : this.#modernMcpScopes.get(requestInfo);
        if (scope === undefined) {
          throw new Error("MODERN_MCP_REQUEST_SCOPE_UNAVAILABLE");
        }
        return scope.mcp.server;
      },
      { legacy: "stateless", responseMode: "auto", keepAliveMs: 0 },
    );
  }

  get address(): StreamableHttpGatewayAddress | undefined {
    return this.#address;
  }

  get runtimeStatus(): StreamableHttpGatewayRuntimeStatus {
    return {
      admission: this.#admission,
      activeMcpRequests: this.#activeMcpRequests,
      activeModelTurns: this.#activeModelTurns,
    };
  }

  observedChatGptConversationIds(): readonly string[] {
    return [...this.#observedChatGptConversationIds];
  }

  observedOpenAiWorkSessionCount(): number {
    return this.#observedOpenAiWorkSessions.size;
  }

  beginDrain(): StreamableHttpGatewayRuntimeStatus {
    this.#admission = "draining";
    if (this.#directJobManager !== undefined) {
      for (const adapter of this.#runtimeDirectJobAdapters) {
        this.#directJobManager.beginAdapterDrain(adapter);
      }
    }
    return this.runtimeStatus;
  }

  resumeAdmission(): StreamableHttpGatewayRuntimeStatus {
    if (this.#directJobManager !== undefined) {
      for (const adapter of this.#runtimeDirectJobAdapters) {
        this.#directJobManager.resumeAdapterAdmission(adapter);
      }
    }
    this.#admission = "open";
    return this.runtimeStatus;
  }

  async awaitDrained(timeoutMs: number): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Drain timeout must be a positive integer");
    }
    const deadlineUnixMs = deadlineAfter(timeoutMs, "Drain timeout");
    await this.#awaitActiveMcpRequests(deadlineUnixMs, () => {
      const activeNonModelRequests = this.#activeMcpRequests - this.#activeModelTurns;
      return new Error(
        `MCP drain timed out with ${activeNonModelRequests} non-model and ${this.#activeModelTurns} model request(s)`,
      );
    });
  }

  async #awaitActiveMcpRequests(
    deadlineUnixMs?: number,
    timeoutError: () => Error = () =>
      new Error("Active MCP requests exceeded the gateway shutdown deadline"),
  ): Promise<void> {
    if (this.#activeMcpRequests === 0) return;
    if (deadlineUnixMs !== undefined && deadlineUnixMs <= Date.now()) throw timeoutError();
    await new Promise<void>((resolve, reject) => {
      let waiter: DrainWaiter;
      const cancelDeadline =
        deadlineUnixMs === undefined
          ? undefined
          : scheduleDeadline(deadlineUnixMs, () => {
              this.#drainWaiters.delete(waiter);
              reject(timeoutError());
            });
      waiter = {
        resolve,
        ...(cancelDeadline === undefined ? {} : { cancelDeadline }),
      };
      this.#drainWaiters.add(waiter);
      if (this.#activeMcpRequests === 0) {
        this.#drainWaiters.delete(waiter);
        cancelDeadline?.();
        resolve();
      }
    });
  }

  compareNativeRequestIds(candidates: readonly unknown[]) {
    return compareNativeRequestIdentities(this.#activeNativeRequestAttributions, candidates);
  }

  async start(): Promise<StreamableHttpGatewayAddress> {
    if (this.#server !== undefined) return this.#address as StreamableHttpGatewayAddress;
    this.#modernMcpHandler ??= this.#createModernMcpHandler();
    const requestedPort = this.#options.port;
    const bindAttempts =
      requestedPort === 0
        ? MAX_FETCH_SAFE_EPHEMERAL_BIND_ATTEMPTS
        : 1 + MAX_FETCH_SAFE_EPHEMERAL_BIND_ATTEMPTS;
    let useEphemeralFallback = requestedPort === 0;
    for (let attempt = 0; attempt < bindAttempts; attempt += 1) {
      const server = createServer((request, response) => {
        void this.#handle(request, response).catch(() => {
          if (response.destroyed || response.writableEnded) return;
          if (response.headersSent) {
            response.destroy();
            return;
          }
          response.statusCode = 500;
          response.end("Internal Server Error");
        });
      });
      const bindPort = useEphemeralFallback ? 0 : requestedPort;
      try {
        await listenHttpServer(server, bindPort, this.#options.host);
      } catch (error) {
        if (!useEphemeralFallback && recoverableLoopbackBindError(error)) {
          useEphemeralFallback = true;
          continue;
        }
        throw error;
      }
      const address = server.address();
      if (address === null || typeof address === "string") {
        await closeHttpServer(server);
        throw new Error("OmniCodex MCP gateway did not receive a TCP address");
      }
      if (bindPort === 0 && fetchBlocksPort(address.port)) {
        await closeHttpServer(server);
        continue;
      }
      this.#server = server;
      this.#address = {
        host: this.#options.host,
        port: address.port,
        path: this.#options.path,
        fullPath: this.#options.fullPath,
      };
      this.#shutdownCompleted = false;
      this.#startIdleLocalSessionSweep();
      return this.#address;
    }
    throw new Error("OmniCodex MCP gateway could not bind a fetch-safe ephemeral port");
  }

  stop(hardTimeoutMs = this.#options.shutdownHardTimeoutMs): Promise<void> {
    if (
      hardTimeoutMs !== undefined &&
      (!Number.isSafeInteger(hardTimeoutMs) || hardTimeoutMs <= 0)
    ) {
      return Promise.reject(new Error("Shutdown hard timeout must be a positive integer"));
    }
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    const server = this.#server;
    if (server === undefined && this.#shutdownCompleted) return Promise.resolve();
    if (
      server === undefined &&
      this.#retiringSessions.size === 0 &&
      (this.#admission === "open" || this.#runtimeDirectJobAdapters.size === 0)
    ) {
      return Promise.resolve();
    }
    const stopPromise = this.#stopServer(server, hardTimeoutMs).finally(() => {
      if (this.#stopPromise === stopPromise) this.#stopPromise = undefined;
    });
    this.#stopPromise = stopPromise;
    return stopPromise;
  }

  async #stopServer(server: Server | undefined, hardTimeoutMs?: number): Promise<void> {
    this.#stopIdleLocalSessionSweep();
    this.beginDrain();
    const deadlineUnixMs =
      hardTimeoutMs === undefined
        ? undefined
        : deadlineAfter(hardTimeoutMs, "Shutdown hard timeout");
    const gracefulDrainDeadlineUnixMs =
      deadlineUnixMs === undefined
        ? undefined
        : shutdownDrainDeadline(deadlineUnixMs, hardTimeoutMs as number);
    // Stop accepting new TCP connections before waiting for any session-level
    // cleanup. Only a caller-selected deadline may force existing connections.
    const httpClose =
      server === undefined ? Promise.resolve() : closeHttpServer(server, deadlineUnixMs);
    const sessions = [...this.#sessions.entries()];
    for (const [sessionId, session] of sessions) {
      this.#sessions.delete(sessionId);
      this.#retiringSessions.add(session);
    }
    // Protected results are durable owner-owned artifacts. Runtime shutdown must
    // not invalidate links that the remote client has not fetched yet.

    const errors: Error[] = [];
    let adaptersDrained = true;
    const activeDrainPromise =
      this.#activeMcpRequests === 0
        ? undefined
        : this.#awaitActiveMcpRequests(gracefulDrainDeadlineUnixMs).catch(
            async (_gracefulDrainError: unknown) => {
              // Reserve the end of the caller-selected shutdown window for
              // cancellation and owned-resource cleanup. Otherwise one Web
              // request can consume the entire deadline, leaving no time for
              // response-close cancellation, protocol close, or executor close.
              for (const [, session] of sessions) {
                for (const response of session.activeResponses) response.destroy();
              }
              server?.closeAllConnections();
              try {
                await this.#awaitActiveMcpRequests(deadlineUnixMs);
              } catch (error) {
                errors.push(asError(error));
              }
            },
          );
    const adapterDrainPromise =
      this.#directJobManager === undefined || this.#runtimeDirectJobAdapters.size === 0
        ? undefined
        : this.#drainRuntimeDirectJobs(deadlineUnixMs).then(
            () => true,
            (error: unknown) => {
              errors.push(asError(error));
              return false;
            },
          );
    if (activeDrainPromise !== undefined) await activeDrainPromise;
    const modernHandler = this.#modernMcpHandler;
    const modernProtocolClose =
      modernHandler === undefined
        ? undefined
        : settleBeforeDeadline(modernHandler.close(), deadlineUnixMs).then((outcome) => {
            if (!outcome.settled) {
              throw new Error("Modern MCP handler close exceeded its shutdown deadline");
            }
          });
    if (modernHandler !== undefined && this.#modernMcpHandler === modernHandler) {
      this.#modernMcpHandler = undefined;
    }
    const retiring = [...this.#retiringSessions];
    for (const session of retiring) this.#closePassiveStandaloneSseLeases(session);
    const protocolCloses = new Map(
      retiring.map((session) => [session, this.#beginSessionProtocolClose(session)] as const),
    );
    if (adapterDrainPromise !== undefined) adaptersDrained = await adapterDrainPromise;
    if (!adaptersDrained && errors.length === 0) {
      errors.push(
        new Error("Direct native jobs did not establish a terminal fence before shutdown"),
      );
    }

    if (adaptersDrained) {
      const cleanupResults = await Promise.allSettled([
        ...retiring.map(async (session) => {
          await this.#closeSession(
            session,
            protocolCloses.get(session) as Promise<readonly PromiseSettledResult<void>[]>,
            deadlineUnixMs,
          );
          this.#retiringSessions.delete(session);
        }),
        ...(modernProtocolClose === undefined ? [] : [modernProtocolClose]),
      ]);
      for (const result of cleanupResults) {
        if (result.status === "rejected") errors.push(asError(result.reason));
      }
    } else if (modernProtocolClose !== undefined) {
      try {
        await modernProtocolClose;
      } catch (error) {
        errors.push(asError(error));
      }
    }

    // closeHttpServer owns its own force-close deadline. Wrapping it in a
    // second timer at the same deadline creates a false timeout race.
    const httpResult = await httpClose.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (!httpResult.ok) {
      errors.push(asError(httpResult.error));
    }
    if (httpResult.ok && server !== undefined && this.#server === server) {
      this.#server = undefined;
      this.#address = undefined;
    }
    if (errors.length === 0) this.#shutdownCompleted = true;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "OmniCodex gateway shutdown encountered cleanup errors");
    }
  }

  async #drainRuntimeDirectJobs(deadlineUnixMs?: number): Promise<void> {
    if (this.#directJobManager === undefined || this.#runtimeDirectJobAdapters.size === 0) return;
    const manager = this.#directJobManager;
    await Promise.all(
      [...this.#runtimeDirectJobAdapters].map(async (adapter) => {
        if (deadlineUnixMs === undefined) {
          await manager.waitForAdapterIdle(adapter);
          return;
        }
        const timeoutError = {
          code: "DIRECT_JOB_RUNTIME_DRAIN_TIMEOUT",
          message:
            "The retiring exact native runtime did not return an authoritative result before its drain deadline",
        };
        const remainingMs = deadlineUnixMs - Date.now();
        if (remainingMs <= 0) {
          await manager.fenceAdapterOutcomeUnknown(adapter, timeoutError);
          return;
        }
        await manager.drainAdapter(adapter, remainingMs, timeoutError);
      }),
    );
  }

  #beginSessionProtocolClose(session: Session): Promise<readonly PromiseSettledResult<void>[]> {
    return Promise.allSettled([
      invokeClose(() => session.mcp.server.close()),
      invokeClose(() => session.transport.close()),
    ]);
  }

  async #closeSession(
    session: Session,
    protocolClose: Promise<readonly PromiseSettledResult<void>[]>,
    deadlineUnixMs?: number,
  ): Promise<void> {
    const [executorResult, protocolResult] = await Promise.all([
      session.closeExecutors(deadlineUnixMs).then(
        () => ({ settled: true as const, value: undefined }),
        (error: unknown) => ({ settled: true as const, error: asError(error) }),
      ),
      settleBeforeDeadline(protocolClose, deadlineUnixMs),
    ]);
    const results = protocolResult.settled ? protocolResult.value : [];
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [asError(result.reason)] : [],
    );
    if ("error" in executorResult) errors.push(executorResult.error);
    if (!protocolResult.settled) {
      errors.push(new Error("MCP protocol close exceeded its shutdown deadline"));
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "OmniCodex MCP session did not close cleanly");
    }
  }

  async refreshTools(): Promise<void> {
    const previousRevision = this.#nativeToolRegistryCatalog?.current?.revision;
    const sessions = [...this.#sessions.values()];
    if (sessions.length === 0) {
      await this.#nativeToolRegistryCatalog?.refresh();
    } else {
      await Promise.all(sessions.map((session) => session.mcp.refresh()));
    }
    const refreshed = this.#nativeToolRegistryCatalog?.current;
    if (
      previousRevision !== undefined &&
      refreshed !== undefined &&
      refreshed.revision !== previousRevision
    ) {
      this.#modernMcpHandler?.notify.toolsChanged();
    }
  }

  async readFullCatalogSnapshot(): Promise<OmniCodexFullCatalogSnapshot> {
    if (this.#nativeToolRegistryCatalog === undefined) {
      throw new Error("LIVE_LOCAL_HOST_TOOL_CATALOG_UNAVAILABLE");
    }
    return this.#nativeToolRegistryCatalog.inspectFullCatalog();
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.#setSecurityHeaders(response);
    const url = requestUrl(request);
    if (url === undefined || url.search.length > 0) {
      sendText(response, 400, "Invalid request target");
      return;
    }
    if (!this.#validHost(request)) {
      sendText(response, 421, "Misdirected Request");
      return;
    }
    if (!this.#applyCors(request, response)) {
      sendText(response, 403, "Forbidden");
      return;
    }

    if (request.method === "OPTIONS") {
      if (!this.#validPreflight(request, url.pathname)) {
        sendText(response, 403, "Forbidden");
        return;
      }
      response.statusCode = 204;
      response.end();
      return;
    }

    if (isMetadataPath(url.pathname, this.#options.path, this.#options.fullPath)) {
      this.#serveMetadata(request, response, url.pathname);
      return;
    }

    if (
      isAuthorizationServerMetadataPath(
        url.pathname,
        this.#options.authorizationServerMetadata,
        this.#metadata?.full,
      )
    ) {
      const status = request.method === "GET" ? 200 : 405;
      void Promise.resolve(
        this.#options.observeAuthorizationServerMetadataRequest?.({
          httpMethod: request.method === "GET" ? "GET" : "unknown",
          path: url.pathname,
          status,
        }),
      ).catch(() => undefined);
      this.#serveAuthorizationServerMetadata(request, response);
      return;
    }

    const resourceId = resourceIdFromPath(url.pathname);
    const surface =
      url.pathname === this.#options.path
        ? "compat"
        : url.pathname === this.#options.fullPath
          ? "full"
          : undefined;
    if (resourceId === undefined && surface === undefined) {
      sendText(response, 404, "Not Found");
      return;
    }

    const authorization = await this.#authorize(request);
    if (!authorization.ok) {
      this.#sendAuthorizationFailure(request, response, authorization, surface);
      return;
    }
    if (authorization.identity === undefined || authorization.authInfo === undefined) {
      sendText(response, 500, "Authorization identity unavailable");
      return;
    }

    if (surface !== undefined && !this.#identityMatchesSurface(authorization.identity, surface)) {
      this.#sendAuthorizationFailure(
        request,
        response,
        {
          ok: false,
          status: 403,
          failureCode: "resource_audience_mismatch",
          failureClaim: "aud",
          message: "Unauthorized",
        },
        surface,
      );
      return;
    }

    if (resourceId !== undefined) {
      await this.#serveResource(request, response, resourceId, authorization.identity);
      return;
    }
    await this.#serveMcp(request, response, surface as "compat" | "full", {
      ...authorization,
      authInfo: authorization.authInfo,
      identity: authorization.identity,
    });
  }

  async #serveMcp(
    request: IncomingMessage,
    response: ServerResponse,
    surface: "compat" | "full",
    authorization: HttpAuthorizationDecision & {
      readonly authInfo: AuthInfo;
      readonly identity: HttpAuthorizationIdentity;
    },
  ): Promise<void> {
    const trace: MutableMcpRequestTrace = {
      correlationId: undefined,
      principalBindingSha256: undefined,
      workSessionBindingSha256: undefined,
      chatGptConversationIdSha256: undefined,
      openAiSessionIdentityKind: undefined,
      rpcMethod: undefined,
      uiResourceUri: undefined,
      jsonRpcIdHmac: undefined,
      responseId: null,
      invocationIdSha256: undefined,
      requestMetaDigests: [],
      outcome: "gateway_entry",
    };
    this.#observeMcpResponse(request, response, surface, trace);
    if (!isMcpMethod(request.method)) {
      trace.outcome = "method_rejected";
      response.setHeader("Allow", "GET, POST, DELETE");
      sendText(response, 405, "Method Not Allowed");
      return;
    }
    if (!validProtocolHeader(request)) {
      trace.outcome = "protocol_version_rejected";
      sendProtocolError(response, null, "Unsupported MCP protocol version");
      return;
    }
    const admission = validateHttpAdmission(request);
    if (admission !== undefined) {
      trace.outcome = "http_admission_rejected";
      sendText(response, admission.status, admission.message);
      return;
    }

    if (
      this.#admission === "draining" &&
      request.method !== "DELETE" &&
      request.method !== "POST"
    ) {
      trace.outcome = "runtime_draining";
      response.setHeader("Retry-After", "1");
      response.setHeader("Cache-Control", "no-store");
      sendText(response, 503, "Runtime draining");
      return;
    }

    const tracksActiveWork = request.method === "POST";
    const activeRequest: ActiveMcpRequestTracking | undefined = tracksActiveWork
      ? { modelTurn: false }
      : undefined;
    if (activeRequest !== undefined) this.#activeMcpRequests += 1;
    try {
      const handling = this.#serveAdmittedMcp(
        request,
        response,
        surface,
        authorization,
        trace,
        activeRequest,
      );
      if (activeRequest === undefined) {
        await handling;
      } else {
        // A finite MCP POST is no longer an active HTTP request once its
        // response has finished (or the caller has disconnected). Some SDK
        // transport versions can keep handleRequest() pending after emitting
        // the terminal response, which must not pin runtime drain forever.
        // Native work cannot produce a successful terminal tool result before
        // it has settled, and caller-disconnected native work remains owned by
        // the execution scheduler rather than this HTTP admission counter.
        await awaitFiniteMcpPostSettlement(response, handling);
      }
    } catch (error) {
      if (!response.destroyed && !response.headersSent && !response.writableEnded) {
        trace.outcome = "mcp_transport_or_persistence_failed";
        sendStructuredMcpError(response, trace.responseId, -32000, error, 500);
        return;
      }
      throw error;
    } finally {
      if (activeRequest !== undefined) {
        this.#activeMcpRequests -= 1;
        if (activeRequest.modelTurn) this.#activeModelTurns -= 1;
        this.#resolveDrainWaitersIfIdle();
      }
    }
  }

  async #serveAdmittedMcp(
    request: IncomingMessage,
    response: ServerResponse,
    surface: "compat" | "full",
    authorization: HttpAuthorizationDecision & {
      readonly authInfo: AuthInfo;
      readonly identity: HttpAuthorizationIdentity;
    },
    trace: MutableMcpRequestTrace,
    activeRequest?: ActiveMcpRequestTracking,
  ): Promise<void> {
    let parsedBody: unknown;
    let requestBytes = 0;
    if (request.method === "POST") {
      const parsed = await readJsonBody(request, this.#options.maxRequestBodyBytes);
      if (!parsed.ok) {
        trace.outcome = parsed.status === 400 ? "json_body_rejected" : "body_too_large";
        if (parsed.status === 400) sendProtocolError(response, null, parsed.message);
        else sendText(response, parsed.status, parsed.message);
        return;
      }
      parsedBody = parsed.value;
      trace.responseId = requestId(parsed.value);
      requestBytes = parsed.byteLength;
      trace.rpcMethod = safeJsonRpcMethod(parsed.value);
      trace.uiResourceUri = safeUiResourceUri(parsed.value);
      if (this.#admission === "draining" && !canServeWhileDraining(parsed.value)) {
        trace.outcome = "runtime_draining";
        response.setHeader("Retry-After", "1");
        response.setHeader("Cache-Control", "no-store");
        sendText(response, 503, "Runtime draining");
        return;
      }
      trace.jsonRpcIdHmac = safeJsonRpcIdDigest(parsed.value, this.#transportIdentityHmacKey);
      trace.invocationIdSha256 = safeToolInvocationIdDigest(parsed.value);
      if (isObject(parsed.value) && isObject(parsed.value.params)) {
        trace.invocationIdentityInputs = mutationIdentityInputPresence(
          isObject(parsed.value.params.arguments) ? parsed.value.params.arguments : {},
          parsed.value.params._meta,
        );
      }
      trace.requestMetaDigests = safeRequestMetaDigests(
        parsed.value,
        this.#transportIdentityHmacKey,
      );
      if (activeRequest !== undefined) {
        await this.#classifyActiveRequest(request, parsed.value, activeRequest);
      }
      const webRequest = await toWebRequest(
        request as unknown as Parameters<typeof toWebRequest>[0],
        parsed.value,
      );
      const legacyRequest = await isLegacyRequest(webRequest, parsed.value);
      if (!legacyRequest || isDirectStatelessLegacyRequest(request, parsed.value)) {
        await this.#serveModernMcp(
          request,
          response,
          surface,
          authorization,
          trace,
          parsed.value,
          requestBytes,
          legacyRequest ? "legacy_stateless" : "modern",
        );
        return;
      }
      const initialization = initializationVersion(parsed.value);
      if (
        initialization !== undefined &&
        !SUPPORTED_PROTOCOL_VERSIONS.some((version) => version === initialization)
      ) {
        trace.outcome = "initialize_version_rejected";
        sendProtocolError(response, requestId(parsed.value), "Unsupported MCP protocol version");
        return;
      }
    }

    const identityBinding = authorizationBinding(authorization.identity);
    const principalBinding = durablePrincipalBinding(authorization.identity);
    trace.principalBindingSha256 = sha256Metadata(principalBinding);
    const executionOwnerId = trace.principalBindingSha256;
    const sessionId = headerValue(request.headers["mcp-session-id"]);
    let session = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
    if (session !== undefined) trace.correlationId = session.correlationId;
    if (session !== undefined && session.authorizationBinding !== identityBinding) {
      trace.outcome = "session_identity_rejected";
      sendText(response, 404, "Session invalid");
      return;
    }
    if (session !== undefined && session.surface !== surface) {
      trace.outcome = "session_surface_rejected";
      sendText(response, 404, "Session invalid");
      return;
    }
    if (
      session === undefined &&
      request.method === "GET" &&
      sessionId !== undefined &&
      this.#options.durableMcpEventStoreFactory !== undefined
    ) {
      const termination = this.#terminatingSessions.get(sessionId);
      if (termination !== undefined) {
        if (termination.ownerBinding !== identityBinding || termination.surface !== surface) {
          trace.outcome = "durable_replay_session_rejected";
          sendText(response, 404, "Session invalid");
          return;
        }
        try {
          await termination.promise;
        } catch {
          // A failed tombstone must fail closed instead of reopening replay.
          trace.outcome = "durable_replay_session_rejected";
          sendText(response, 404, "Session invalid");
          return;
        }
      }
      const lastEventId = headerValue(request.headers["last-event-id"]);
      if (lastEventId === undefined || lastEventId.length > 256) {
        trace.outcome = "session_missing_or_invalid";
        sendText(response, 404, "Session invalid");
        return;
      }
      attachAuthInfo(request, authorization.authInfo);
      try {
        const replay = await this.#options.durableMcpEventStoreFactory.rehydrateByTransport({
          ownerBinding: identityBinding,
          surface,
          transportSessionId: sessionId,
        });
        if ((await replay.getStreamIdForEventId(lastEventId)) === undefined) {
          trace.outcome = "event_history_expired";
          sendMcpError(response, null, -32016, "EVENT_HISTORY_EXPIRED");
          return;
        }
        trace.outcome = "durable_event_replay";
        await this.#serveRehydratedReplay(response, replay, sessionId, lastEventId);
        return;
      } catch (error) {
        if (isRejectedDurableReplaySession(error)) {
          trace.outcome = "durable_replay_session_rejected";
          sendText(response, 404, "Session invalid");
          return;
        }
        trace.outcome = "durable_replay_failed";
        sendStructuredMcpError(response, null, -32018, error, 500);
        return;
      }
    }
    if (session === undefined && (request.method !== "POST" || sessionId !== undefined)) {
      trace.outcome = "session_missing_or_invalid";
      sendText(response, 404, "Session invalid");
      return;
    }

    attachAuthInfo(request, authorization.authInfo);
    if (session === undefined) {
      const initializedSession = await this.#newSession(surface, authorization.identity);
      session = initializedSession;
      trace.correlationId = initializedSession.correlationId;
      trace.outcome = "new_session_transport";
      const workSession = await this.#bindWorkSession(
        initializedSession,
        initializedSession.durablePrincipalBinding,
        identityBinding,
        request,
        parsedBody,
        response,
      );
      if (workSession === null) {
        await initializedSession.mcp.server.close().catch(() => undefined);
        await initializedSession.transport.close().catch(() => undefined);
        await initializedSession.closeExecutors().catch(() => undefined);
        return;
      }
      trace.workSessionBindingSha256 =
        workSession === undefined ? undefined : sha256Metadata(workSession.workSessionBinding);
      this.#trackSessionResponse(initializedSession, request, response);
      await this.#registerOpenAiWorkSessionTransport(initializedSession, workSession);
      prepareMcpPostResponse(request, response);
      await this.#nativeExecutionScheduler.withRequestContext(
        {
          ownerId: executionOwnerId,
          sessionId: workSession?.workSessionBinding ?? initializedSession.correlationId,
          requestBytes,
        },
        () =>
          this.#withWorkSession(
            initializedSession,
            workSession,
            request,
            response,
            trace,
            parsedBody,
            () => initializedSession.transport.handleRequest(request, response, parsedBody),
          ),
      );
      if (initializedSession.transport.sessionId === undefined && response.writableEnded) {
        await initializedSession.mcp.server.close().catch(() => undefined);
        await initializedSession.transport.close().catch(() => undefined);
        await initializedSession.closeExecutors().catch(() => undefined);
      }
      return;
    }
    trace.outcome = "existing_session_transport";
    const workSession = await this.#bindWorkSession(
      session,
      session.durablePrincipalBinding,
      identityBinding,
      request,
      parsedBody,
      response,
    );
    if (workSession === null) return;
    trace.workSessionBindingSha256 =
      workSession === undefined ? undefined : sha256Metadata(workSession.workSessionBinding);
    this.#trackSessionResponse(session, request, response);
    await this.#registerOpenAiWorkSessionTransport(session, workSession);
    await this.#nativeExecutionScheduler.withRequestContext(
      {
        ownerId: executionOwnerId,
        sessionId: workSession?.workSessionBinding ?? session.correlationId,
        requestBytes,
      },
      () =>
        this.#withWorkSession(
          session,
          workSession,
          request,
          response,
          trace,
          parsedBody,
          async () => {
            if (request.method === "GET") {
              const lastEventId = headerValue(request.headers["last-event-id"]);
              if (lastEventId !== undefined) {
                if (
                  lastEventId.length > 256 ||
                  (await session.eventStore.getStreamIdForEventId(lastEventId)) === undefined
                ) {
                  trace.outcome = "event_history_expired";
                  sendMcpError(response, null, -32016, "EVENT_HISTORY_EXPIRED");
                  return;
                }
                await this.#serveResumedStandaloneSse(response, session, lastEventId);
                return;
              }
              await this.#serveStandaloneSse(request, response, session);
              return;
            }
            prepareMcpPostResponse(request, response);
            await session.transport.handleRequest(request, response, parsedBody);
          },
        ),
    );
  }

  async #serveModernMcp(
    request: IncomingMessage,
    response: ServerResponse,
    surface: "compat" | "full",
    authorization: HttpAuthorizationDecision & {
      readonly authInfo: AuthInfo;
      readonly identity: HttpAuthorizationIdentity;
    },
    trace: MutableMcpRequestTrace,
    parsedBody: unknown,
    requestBytes: number,
    transportMode: "modern" | "legacy_stateless",
  ): Promise<void> {
    const identityBinding = authorizationBinding(authorization.identity);
    const principalBinding = durablePrincipalBinding(authorization.identity);
    const scope = await this.#createMcpExecutionScope(surface, authorization.identity);
    trace.correlationId = scope.correlationId;
    trace.principalBindingSha256 = sha256Metadata(principalBinding);
    trace.outcome =
      transportMode === "modern"
        ? "modern_per_request_transport"
        : "legacy_stateless_per_request_transport";
    let workSession: DurableWorkSessionBinding | undefined;
    try {
      const bound = await this.#bindWorkSession(
        scope,
        principalBinding,
        identityBinding,
        request,
        parsedBody,
        response,
      );
      if (bound === null) return;
      workSession = bound;
      trace.workSessionBindingSha256 =
        workSession === undefined ? undefined : sha256Metadata(workSession.workSessionBinding);
      const modernNodeHandler = toNodeHandler({
        fetch: async (webRequest, handlerOptions) => {
          this.#modernMcpScopes.set(webRequest, scope);
          try {
            const modernMcpHandler = this.#modernMcpHandler;
            if (modernMcpHandler === undefined) {
              throw new Error("MODERN_MCP_HANDLER_UNAVAILABLE");
            }
            return await modernMcpHandler.fetch(webRequest, {
              ...handlerOptions,
              authInfo: authorization.authInfo as unknown as ModernAuthInfo,
              parsedBody,
            });
          } finally {
            this.#modernMcpScopes.delete(webRequest);
          }
        },
      });
      const connectionBoundary = transportDisconnectBoundary(request, response);
      try {
        await this.#nativeExecutionScheduler.withRequestContext(
          {
            ownerId: trace.principalBindingSha256,
            sessionId: workSession?.workSessionBinding ?? scope.correlationId,
            requestBytes,
            transportDisconnectSignal: connectionBoundary.signal,
          },
          () =>
            this.#withWorkSession(scope, workSession, request, response, trace, parsedBody, () =>
              modernNodeHandler(
                request as unknown as Parameters<typeof modernNodeHandler>[0],
                response as unknown as Parameters<typeof modernNodeHandler>[1],
                parsedBody,
              ),
            ),
        );
      } finally {
        connectionBoundary.clear();
      }
    } finally {
      await scope.closeExecutors().catch(() => undefined);
    }
  }

  async #bindWorkSession(
    session: McpExecutionScope,
    principalBinding: string,
    transportBinding: string,
    request: IncomingMessage,
    parsedBody: unknown,
    response: ServerResponse,
  ): Promise<DurableWorkSessionBinding | undefined | null> {
    const store = this.#durableWorkSessionStore;
    if (store === undefined) return undefined;
    try {
      const requestMeta = workSessionRequestMeta(parsedBody);
      const requested = workSessionRequestBinding(parsedBody);
      // Do not manufacture a conversation during metadata-free initialize or
      // notifications. ChatGPT may provide related-task only on the first
      // tools/call; delaying creation lets a new transport rejoin that durable
      // conversation instead of conflicting with an empty provisional one.
      if (requestMeta === undefined && !workSessionRequestIncludesToolCall(parsedBody)) {
        return undefined;
      }
      const resumed =
        requested?.workSessionBinding === undefined
          ? undefined
          : await store.resume({
              authorizationBinding: principalBinding,
              workSessionBinding: requested.workSessionBinding,
            });
      if (
        resumed !== undefined &&
        requested?.continuationToken !== undefined &&
        requested.continuationToken !== resumed.continuationToken
      ) {
        throw new TypeError("Explicit work-session binding and continuation token conflict");
      }
      const continuationToken = resumed?.continuationToken ?? requested?.continuationToken;
      const legacySession = "transport" in session ? (session as Session) : undefined;
      const effectiveTransportSessionId =
        legacySession?.transport.sessionId ?? session.transportSessionId;
      const binding = await store.bind({
        authorizationBinding: principalBinding,
        transportSessionId: workSessionTransportIdentity(request, effectiveTransportSessionId),
        ...(continuationToken === undefined ? {} : { continuationToken }),
        ...(requestMeta === undefined ? {} : { requestMeta }),
      });
      session.bindExecutorWorkSession(binding.workSessionBinding);
      const eventStoreFactory = this.#options.durableMcpEventStoreFactory;
      if (eventStoreFactory !== undefined && legacySession !== undefined) {
        await legacySession.eventStore.bind(eventStoreFactory, {
          ownerBinding: transportBinding,
          surface: session.surface,
          workSessionBinding: binding.workSessionBinding,
          transportSessionId: effectiveTransportSessionId,
        });
      }
      return binding;
    } catch (error) {
      const failure = workSessionFailure(error);
      if (failure === "WORK_SESSION_OWNER_MISMATCH") {
        sendMcpError(response, requestId(parsedBody), -32017, failure);
        return null;
      }
      sendStructuredMcpError(response, requestId(parsedBody), -32017, error, 400);
      return null;
    }
  }

  async #withWorkSession<T>(
    session: McpExecutionScope,
    binding: DurableWorkSessionBinding | undefined,
    request: IncomingMessage,
    response: ServerResponse,
    trace: MutableMcpRequestTrace,
    parsedBody: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    const baseAttribution = requestAttribution(
      request,
      trace,
      session.durablePrincipalBinding,
      this.#transportIdentityHmacKey,
    );
    const requestMeta = workSessionRequestMeta(parsedBody);
    trace.openAiSessionIdentityKind = openAiSessionIdentityKindFromRequestMeta(requestMeta);
    if (binding?.source === "openai_session") {
      this.#observedOpenAiWorkSessions.add(binding.workSessionBinding);
    }
    const chatGptConversationUrl = chatGptConversationUrlFromRequestMeta(requestMeta);
    if (chatGptConversationUrl !== undefined) {
      const conversationId = chatGptConversationUrl.slice(
        chatGptConversationUrl.lastIndexOf("/") + 1,
      );
      if (conversationId.length > 0) {
        this.#observedChatGptConversationIds.add(conversationId);
        trace.chatGptConversationIdSha256 = sha256Metadata(conversationId);
      }
      try {
        const preparation = this.#options.prepareChatGptConversationRequest?.({
          surface: session.surface,
          chatGptConversationUrl,
        });
        void Promise.resolve(preparation).catch(() => undefined);
      } catch {
        // Exact Oracle targeting is independent request orchestration. It must
        // never delay or reject the authoritative MCP call.
      }
    }
    const traceparent = headerValue(request.headers.traceparent);
    const requestIds = request.rawHeaders.flatMap((name, index, headers) =>
      index % 2 === 0 && name.toLowerCase() === "x-request-id"
        ? [headers[index + 1] as string]
        : [],
    );
    const attribution: McpRequestAttribution = {
      ...baseAttribution,
      matchesNativeRequestId: nativeRequestIdentityMatcher({
        ...(traceparent === undefined ? {} : { traceparent }),
        ...(requestIds.length === 1 ? { requestIdHeader: requestIds[0] } : {}),
        ...(requestMeta === undefined ? {} : { metadata: requestMeta }),
      }),
      callerProvenance: callerProvenanceFromRequestMeta(requestMeta),
      ...(trace.chatGptConversationIdSha256 === undefined
        ? {}
        : { chatGptConversationIdSha256: trace.chatGptConversationIdSha256 }),
      ...(chatGptConversationUrl === undefined ? {} : { chatGptConversationUrl }),
    };
    const requestKey = mcpRequestIdKey(trace.responseId);
    if (parsedToolCall(parsedBody) !== undefined)
      this.#activeNativeRequestAttributions.add(attribution);
    const releaseAttribution = (): void => {
      this.#activeNativeRequestAttributions.delete(attribution);
      if (requestKey !== "" && session.requestAttributions.get(requestKey) === attribution) {
        session.requestAttributions.delete(requestKey);
      }
    };
    if (requestKey !== "") {
      session.requestAttributions.set(requestKey, attribution);
    }
    response.once("finish", releaseAttribution);
    response.once("close", releaseAttribution);
    try {
      return await session.workSessionContext.runRequest(binding, attribution, operation);
    } catch (error) {
      releaseAttribution();
      throw error;
    }
  }

  #trackSessionResponse(
    session: Session,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    if (response.destroyed || response.writableEnded) return;
    session.lastActivityUnixMs = Date.now();
    session.activeResponses.add(response);
    if (request.method !== "GET") session.activeFiniteResponses.add(response);
    const release = () => {
      session.activeResponses.delete(response);
      session.activeFiniteResponses.delete(response);
      session.lastActivityUnixMs = Date.now();
    };
    response.once("close", release);
    response.once("finish", release);
  }

  async #registerOpenAiWorkSessionTransport(
    session: Session,
    binding: DurableWorkSessionBinding | undefined,
  ): Promise<void> {
    if (binding?.source !== "openai_session") return;
    const workSessionBinding = binding.workSessionBinding;
    if (
      session.openAiWorkSessionBinding !== undefined &&
      session.openAiWorkSessionBinding !== workSessionBinding
    ) {
      throw Object.assign(new Error("WORK_SESSION_BINDING_CONFLICT"), {
        code: "WORK_SESSION_BINDING_CONFLICT",
      });
    }
    session.openAiWorkSessionBinding = workSessionBinding;
    const transports = this.#openAiWorkSessionTransports.get(workSessionBinding) ?? new Set();
    transports.add(session);
    this.#openAiWorkSessionTransports.set(workSessionBinding, transports);

    const superseded = [...transports].filter(
      (candidate) =>
        candidate !== session &&
        candidate.activeFiniteResponses.size === 0 &&
        candidate.terminationPromise === undefined,
    );
    if (superseded.length === 0) return;

    // Cleanup is best effort relative to the new real tool call. A stale
    // predecessor must never make the current call fail, while a failed
    // termination remains in #retiringSessions as a fail-closed shutdown
    // barrier instead of being reported as successfully retired.
    await Promise.allSettled(
      superseded.map((candidate) => this.#retireSupersededOpenAiTransport(candidate)),
    );
  }

  #startIdleLocalSessionSweep(): void {
    if (this.#idleLocalSessionSweep !== undefined) return;
    const idleMs = this.#options.localTransportSessionIdleMs ?? LOCAL_TRANSPORT_SESSION_IDLE_MS;
    const sweep = setInterval(
      () => this.#retireIdleLocalTransportSessions(idleMs),
      Math.min(idleMs, LOCAL_TRANSPORT_SESSION_SWEEP_MAX_MS),
    );
    sweep.unref();
    this.#idleLocalSessionSweep = sweep;
  }

  #stopIdleLocalSessionSweep(): void {
    if (this.#idleLocalSessionSweep === undefined) return;
    clearInterval(this.#idleLocalSessionSweep);
    this.#idleLocalSessionSweep = undefined;
  }

  #retireIdleLocalTransportSessions(idleMs: number): void {
    const now = Date.now();
    for (const session of this.#sessions.values()) {
      // Only local operators; a Web conversation reconnects its transport per call.
      if (!session.transportScopedExecutors) continue;
      if (session.terminationPromise !== undefined) continue;
      if (session.activeResponses.size > 0 || session.standaloneSseLeases.size > 0) continue;
      if (now - session.lastActivityUnixMs < idleMs) continue;
      // A failed retirement stays in #retiringSessions as the fail-closed barrier.
      void this.#retireTransportSession(
        session,
        "Idle local MCP session did not retire cleanly",
      ).catch(() => undefined);
    }
  }

  #retireSupersededOpenAiTransport(session: Session): Promise<void> {
    return this.#retireTransportSession(
      session,
      "Superseded ChatGPT MCP transport did not retire cleanly",
    );
  }

  async #retireTransportSession(session: Session, failureMessage: string): Promise<void> {
    const sessionId = session.transport.sessionId ?? session.transportSessionId;
    const termination = this.#terminateSession(sessionId, session);
    const protocolClose = this.#beginSessionProtocolClose(session);
    const [terminationResult, protocolResults] = await Promise.all([
      termination.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error: asError(error) }),
      ),
      protocolClose,
    ]);
    const errors = protocolResults.flatMap((result) =>
      result.status === "rejected" ? [asError(result.reason)] : [],
    );
    if (!terminationResult.ok) errors.unshift(terminationResult.error);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, failureMessage);
    }
  }

  #forgetOpenAiWorkSessionTransport(session: Session): void {
    const workSessionBinding = session.openAiWorkSessionBinding;
    if (workSessionBinding === undefined) return;
    const transports = this.#openAiWorkSessionTransports.get(workSessionBinding);
    transports?.delete(session);
    if (transports?.size === 0) this.#openAiWorkSessionTransports.delete(workSessionBinding);
  }

  async #awaitSessionResponseBackpressure(session: Session): Promise<void> {
    await Promise.all(
      [...session.activeResponses].map((response) => awaitServerResponseWritable(response)),
    );
  }

  async #serveStandaloneSse(
    request: IncomingMessage,
    response: ServerResponse,
    session: Session,
  ): Promise<void> {
    response.setHeader("X-Accel-Buffering", "no");
    const primaryGeneration = session.standaloneSsePrimaryGeneration;
    const primaryLease =
      primaryGeneration === undefined
        ? undefined
        : session.standaloneSseLeases.get(primaryGeneration);
    if (primaryLease?.active === true) {
      await this.#servePassiveStandaloneSse(response, session);
      return;
    }

    const lease = this.#createStandaloneSseLease(session, response, "sdk");
    session.standaloneSsePrimaryGeneration = lease.generation;

    const handling = session.transport.handleRequest(request, response);
    await waitForResponseHeadersOrCompletion(response, handling);
    if (isStandaloneSseResponse(response)) {
      this.#startStandaloneSseKeepalive(lease);
    } else {
      this.#releaseStandaloneSseLease(lease);
    }
    await handling;
  }

  async #servePassiveStandaloneSse(response: ServerResponse, session: Session): Promise<void> {
    const lease = this.#createStandaloneSseLease(session, response, "passive");
    this.#openStandaloneSseResponse(response, session);
    this.#startStandaloneSseKeepalive(lease);
    await lease.closed;
  }

  async #serveResumedStandaloneSse(
    response: ServerResponse,
    session: Session,
    lastEventId: string,
  ): Promise<void> {
    response.setHeader("X-Accel-Buffering", "no");
    const lease = this.#createStandaloneSseLease(session, response, "passive");
    this.#openStandaloneSseResponse(response, session);
    await session.eventStore.replayEventsAfter(lastEventId, {
      send: async (eventId, message) => {
        if (!lease.active || response.destroyed || response.writableEnded) return;
        if (!(await this.#writeStandaloneSseMessage(response, eventId, message))) lease.release();
      },
    });
    this.#startStandaloneSseKeepalive(lease);
    await lease.closed;
  }

  /** Historical GET replay only. It never creates an MCP protocol session. */
  async #serveRehydratedReplay(
    response: ServerResponse,
    replay: DurableMcpEventReplaySession,
    transportSessionId: string,
    lastEventId: string,
  ): Promise<void> {
    response.statusCode = 200;
    response.setHeader("X-Accel-Buffering", "no");
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "close");
    response.setHeader("MCP-Session-Id", transportSessionId);
    response.flushHeaders();
    await replay.replayEventsAfter(lastEventId, {
      send: async (eventId, message) => {
        if (response.destroyed || response.writableEnded) return;
        await this.#writeStandaloneSseMessage(response, eventId, message);
      },
    });
    if (!response.destroyed && !response.writableEnded) response.end();
  }

  #openStandaloneSseResponse(response: ServerResponse, session: Session): void {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    const sessionId = session.transport.sessionId;
    if (sessionId !== undefined) response.setHeader("MCP-Session-Id", sessionId);
    response.flushHeaders();
  }

  #createStandaloneSseLease(
    session: Session,
    response: ServerResponse,
    delivery: "sdk" | "passive",
  ): StandaloneSseLease {
    let resolveClosed!: () => void;
    session.standaloneSseGeneration += 1;
    let lease!: StandaloneSseLease;
    const release = () => {
      if (!lease.active) return;
      lease.active = false;
      if (lease.keepaliveTimer !== undefined) clearInterval(lease.keepaliveTimer);
      session.standaloneSseLeases.delete(lease.generation);
      if (session.standaloneSsePrimaryGeneration === lease.generation) {
        delete session.standaloneSsePrimaryGeneration;
      }
      resolveClosed();
    };
    lease = {
      generation: session.standaloneSseGeneration,
      delivery,
      streamId: `_GET_stream.${session.standaloneSseGeneration.toString(36)}`,
      response,
      closed: new Promise<void>((resolve) => {
        resolveClosed = resolve;
      }),
      release,
      active: true,
      keepaliveTimer: undefined,
      keepaliveWritePending: false,
    };
    response.once("close", release);
    response.once("finish", release);
    session.standaloneSseLeases.set(lease.generation, lease);
    return lease;
  }

  #releaseStandaloneSseLease(lease: StandaloneSseLease): void {
    lease.release();
  }

  #startStandaloneSseKeepalive(lease: StandaloneSseLease): void {
    if (lease.keepaliveTimer !== undefined || !lease.active) return;
    const timer = setInterval(() => {
      const { response } = lease;
      if (
        !lease.active ||
        lease.keepaliveWritePending ||
        response.destroyed ||
        response.writableEnded
      )
        return;
      lease.keepaliveWritePending = true;
      void writeServerResponseWithBackpressure(response, ": keepalive\n\n")
        .then((written) => {
          if (!written) lease.release();
        })
        .catch(() => lease.release())
        .finally(() => {
          lease.keepaliveWritePending = false;
        });
    }, STANDALONE_SSE_KEEPALIVE_INTERVAL_MS);
    timer.unref();
    lease.keepaliveTimer = timer;
  }

  #closePassiveStandaloneSseLeases(session: Session): void {
    for (const lease of session.standaloneSseLeases.values()) {
      if (lease.delivery !== "passive") continue;
      if (!lease.response.destroyed && !lease.response.writableEnded) lease.response.end();
      lease.release();
    }
  }

  async #sendStandaloneMessageToPassive(
    session: Session,
    message: JSONRPCMessage,
  ): Promise<boolean> {
    if (session.standaloneSsePrimaryGeneration !== undefined) return false;
    const lease = [...session.standaloneSseLeases.values()].find(
      (candidate) => candidate.delivery === "passive" && candidate.active,
    );
    if (lease === undefined) return false;
    const eventId = await session.eventStore.storeEvent(lease.streamId, message);
    if (!lease.active || lease.response.destroyed || lease.response.writableEnded) return false;
    try {
      const written = await this.#writeStandaloneSseMessage(lease.response, eventId, message);
      if (!written) lease.release();
      return written;
    } catch {
      lease.release();
      return false;
    }
  }

  #writeStandaloneSseMessage(
    response: ServerResponse,
    eventId: string,
    message: JSONRPCMessage,
  ): Promise<boolean> {
    return writeServerResponseWithBackpressure(
      response,
      `event: message\nid: ${eventId}\ndata: ${JSON.stringify(message)}\n\n`,
    );
  }

  #observeMcpResponse(
    request: IncomingMessage,
    response: ServerResponse,
    surface: "compat" | "full",
    trace: MutableMcpRequestTrace,
  ): void {
    const observer = this.#options.observeMcpRequest;
    if (observer === undefined) return;
    let observed = false;
    let requestAbortedAtUnixMs: number | undefined;
    const onRequestAborted = (): void => {
      requestAbortedAtUnixMs ??= Date.now();
    };
    request.once("aborted", onRequestAborted);
    const observe = (
      status: number,
      fallbackOutcome: string,
      responseTermination: "finish" | "close_before_finish",
    ) => {
      if (observed) return;
      observed = true;
      request.off("aborted", onRequestAborted);
      const responseEndedAtUnixMs = Date.now();
      const protocolVersion = safeProtocolVersion(
        headerValue(request.headers["mcp-protocol-version"]),
      );
      const transportIdentityDigests = [
        ...safeHeaderIdentityDigests(request, this.#transportIdentityHmacKey),
        ...trace.requestMetaDigests,
      ];
      const callerProvenance = callerProvenanceFromIdentityDigests(transportIdentityDigests);
      void Promise.resolve(
        observer({
          responseEndedAtUnixMs,
          responseTermination,
          ...(requestAbortedAtUnixMs === undefined ? {} : { requestAbortedAtUnixMs }),
          ...(trace.invocationIdentityInputs === undefined
            ? {}
            : { invocationIdentityInputs: trace.invocationIdentityInputs }),
          ...(trace.correlationId === undefined ? {} : { correlationId: trace.correlationId }),
          ...(trace.principalBindingSha256 === undefined
            ? {}
            : { principalBindingSha256: trace.principalBindingSha256 }),
          ...(trace.workSessionBindingSha256 === undefined
            ? {}
            : { workSessionBindingSha256: trace.workSessionBindingSha256 }),
          ...(trace.chatGptConversationIdSha256 === undefined
            ? {}
            : { chatGptConversationIdSha256: trace.chatGptConversationIdSha256 }),
          ...(trace.invocationIdSha256 === undefined
            ? {}
            : { invocationIdSha256: trace.invocationIdSha256 }),
          ...(callerProvenance === undefined ? {} : { callerProvenance }),
          ...(trace.openAiSessionIdentityKind === undefined
            ? {}
            : { openAiSessionIdentityKind: trace.openAiSessionIdentityKind }),
          httpMethod: isMcpMethod(request.method) ? request.method : "unknown",
          surface,
          ...(trace.rpcMethod === undefined ? {} : { rpcMethod: trace.rpcMethod }),
          ...(trace.uiResourceUri === undefined ? {} : { uiResourceUri: trace.uiResourceUri }),
          sessionHeaderPresent: headerValue(request.headers["mcp-session-id"]) !== undefined,
          ...(protocolVersion === undefined ? {} : { protocolVersion }),
          ...(trace.jsonRpcIdHmac === undefined ? {} : { jsonRpcIdHmac: trace.jsonRpcIdHmac }),
          ...(transportIdentityDigests.length === 0 ? {} : { transportIdentityDigests }),
          status,
          outcome: trace.outcome === "gateway_entry" ? fallbackOutcome : trace.outcome,
        }),
      ).catch(() => undefined);
    };
    response.once("finish", () => observe(response.statusCode, "response_finished", "finish"));
    response.once("close", () => {
      if (!response.writableEnded) observe(0, "connection_closed", "close_before_finish");
    });
  }

  async #classifyActiveRequest(
    request: IncomingMessage,
    parsedBody: unknown,
    activeRequest: ActiveMcpRequestTracking,
  ): Promise<void> {
    const call = parsedToolCall(parsedBody);
    if (call === undefined) return;
    const sessionId = headerValue(request.headers["mcp-session-id"]);
    const session = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
    if (session === undefined) return;
    const classification = await session.mcp
      .classifyToolCall(call.name, call.arguments)
      .catch(() => "unknown" as const);
    if (classification !== "model") return;
    activeRequest.modelTurn = true;
    this.#activeModelTurns += 1;
  }

  #resolveDrainWaitersIfIdle(): void {
    if (this.#activeMcpRequests !== 0) return;
    for (const waiter of this.#drainWaiters) {
      this.#drainWaiters.delete(waiter);
      waiter.cancelDeadline?.();
      waiter.resolve();
    }
  }

  async #createMcpExecutionScope(
    surface: "compat" | "full",
    identity: HttpAuthorizationIdentity,
  ): Promise<McpExecutionScope> {
    const correlationId = randomBytes(16).toString("hex");
    const ownerBinding = authorizationBinding(identity);
    const principalBinding = durablePrincipalBinding(identity);
    const workSessionContext = new McpWorkSessionContext();
    const requestAttributions = new Map<string, McpRequestAttribution>();
    let executorWorkSessionBinding: string | undefined;
    const bindExecutorWorkSession = (workSessionBinding: string): void => {
      if (
        executorWorkSessionBinding !== undefined &&
        executorWorkSessionBinding !== workSessionBinding
      ) {
        throw Object.assign(new Error("WORK_SESSION_BINDING_CONFLICT"), {
          code: "WORK_SESSION_BINDING_CONFLICT",
        });
      }
      executorWorkSessionBinding = workSessionBinding;
    };
    const executorBundle =
      this.#options.createSessionExecutors === undefined
        ? {
            ...(this.#options.nativeToolExecutor === undefined
              ? {}
              : { nativeToolExecutor: this.#options.nativeToolExecutor }),
            ...(this.#options.responsesToolExecutor === undefined
              ? {}
              : { responsesToolExecutor: this.#options.responsesToolExecutor }),
          }
        : await this.#options.createSessionExecutors({
            identity,
            authorizationBinding: principalBinding,
            correlationId,
            ...(this.#durableWorkSessionStore === undefined ||
            identity.executorLifecycle === "transport"
              ? {}
              : {
                  resolveWorkSessionBinding: () =>
                    workSessionContext.current()?.workSessionBinding ?? executorWorkSessionBinding,
                }),
          });
    const closeNativeExecutors = onceAsync(executorBundle.close);
    const closeExecutors = async (deadlineUnixMs?: number): Promise<void> => {
      const outcome = await settleBeforeDeadline(closeNativeExecutors(), deadlineUnixMs);
      if (!outcome.settled) {
        throw new Error("MCP session-owned executor close exceeded its shutdown deadline");
      }
    };
    const transportSessionId = randomBytes(32).toString("base64url");
    let mcp: OmniCodexMcpServerHandle;
    try {
      mcp = createOmniCodexMcpServer({
        appServer: this.#options.appServer,
        ...(this.#options.serverIdentity === undefined
          ? {}
          : { serverIdentity: this.#options.serverIdentity }),
        ...(this.#nativeToolRegistryCatalog === undefined
          ? {}
          : { nativeToolRegistryCatalog: this.#nativeToolRegistryCatalog }),
        ...(executorBundle.nativeToolExecutor === undefined
          ? {}
          : { nativeToolExecutor: executorBundle.nativeToolExecutor }),
        ...(this.#options.appServerMethodCatalog === undefined
          ? {}
          : { appServerMethodCatalog: this.#options.appServerMethodCatalog }),
        ...(this.#options.responsesToolCatalog === undefined
          ? {}
          : { responsesToolCatalog: this.#options.responsesToolCatalog }),
        ...(executorBundle.responsesToolExecutor === undefined
          ? {}
          : { responsesToolExecutor: executorBundle.responsesToolExecutor }),
        ...(executorBundle.browserNativeExecutor === undefined &&
        this.#options.browserNativeExecutor === undefined
          ? {}
          : {
              browserNativeExecutor:
                executorBundle.browserNativeExecutor ?? this.#options.browserNativeExecutor,
            }),
        ...(this.#options.browserActivityCoordinator === undefined
          ? {}
          : { browserActivityCoordinator: this.#options.browserActivityCoordinator }),
        ...(this.#options.codexAppHostToolExecutor === undefined
          ? {}
          : { codexAppHostToolExecutor: this.#options.codexAppHostToolExecutor }),
        ...(this.#options.desktopIpcClient === undefined
          ? {}
          : { desktopIpcClient: this.#options.desktopIpcClient }),
        ...(this.#options.observeNativeToolExecution === undefined
          ? {}
          : {
              observeNativeToolExecution: (observation: NativeToolExecutionObservation) => {
                return this.#options.observeNativeToolExecution?.(
                  attributedObservation(
                    observation,
                    workSessionContext,
                    principalBinding,
                    executorWorkSessionBinding,
                  ),
                );
              },
            }),
        ...(this.#options.prepareProtectedResultDelivery === undefined
          ? {}
          : {
              prepareProtectedResultDelivery: this.#options.prepareProtectedResultDelivery,
            }),
        ...(this.#options.observeProgress === undefined
          ? {}
          : {
              observeProgress: (observation: McpProgressObservation) =>
                this.#options.observeProgress?.(
                  attributedObservation(
                    observation,
                    workSessionContext,
                    principalBinding,
                    executorWorkSessionBinding,
                  ),
                ),
            }),
        ...(this.#options.observeResultDelivery === undefined
          ? {}
          : {
              observeResultDelivery: (observation: McpResultDeliveryObservation) =>
                this.#options.observeResultDelivery?.(
                  attributedResultObservation(
                    observation,
                    workSessionContext,
                    principalBinding,
                    executorWorkSessionBinding,
                  ),
                ),
            }),
        ...(this.#options.observeMutationReplay === undefined
          ? {}
          : {
              observeMutationReplay: (observation: McpMutationReplayObservation) =>
                this.#options.observeMutationReplay?.(
                  attributedObservation(
                    observation,
                    workSessionContext,
                    principalBinding,
                    executorWorkSessionBinding,
                  ),
                ),
            }),
        ...(this.#options.observeReadInvocation === undefined
          ? {}
          : {
              observeReadInvocation: (observation: McpReadInvocationObservation) => {
                return this.#options.observeReadInvocation?.(
                  attributedObservation(
                    observation,
                    workSessionContext,
                    principalBinding,
                    executorWorkSessionBinding,
                  ),
                );
              },
            }),
        ...(this.#options.observeToolCatalog === undefined
          ? {}
          : {
              observeToolCatalog: (observation: McpToolCatalogObservation) =>
                this.#options.observeToolCatalog?.(
                  attributedObservation(
                    observation,
                    workSessionContext,
                    principalBinding,
                    executorWorkSessionBinding,
                  ),
                ),
            }),
        protectResult: (result, context) =>
          this.#protectResult(
            result,
            protectedResultSessionAttribution(
              workSessionContext.current()?.workSessionBinding,
              context.sessionId,
            ),
            identity,
            context.workSession,
          ),
        readProtectedResult: (input) => {
          const sessionAttribution = protectedResultSessionAttribution(
            workSessionContext.current()?.workSessionBinding,
            transportSessionId,
          );
          if (sessionAttribution === undefined) {
            throw new Error("PROTECTED_RESULT_SESSION_UNAVAILABLE");
          }
          return this.#readProtectedResult(input, sessionAttribution, identity);
        },
        readLinkedResource: async (uri) => {
          let parsed: URL;
          try {
            parsed = new URL(uri);
          } catch {
            return undefined;
          }
          // Resolve only links issued by this resource origin. Never fetch an
          // arbitrary URL or accept credentials/query aliases as file identity.
          if (
            parsed.origin !== new URL(identity.resource).origin ||
            parsed.username !== "" ||
            parsed.password !== "" ||
            parsed.search !== "" ||
            parsed.hash !== "" ||
            parsed.href !== uri
          )
            return undefined;
          const resourceId = resourceIdFromPath(parsed.pathname);
          if (resourceId === undefined) return undefined;
          // As with the authenticated HTTP GET, resource ownership survives
          // transport/client registration rotation, but never principal changes.
          const resource = await this.#resourceStore.get(resourceId, identity);
          if (resource === undefined) return undefined;
          return {
            contents: [
              {
                uri,
                mimeType: resource.mimeType,
                blob: Buffer.from(resource.bytes).toString("base64"),
              },
            ],
          };
        },
        materializeLocalFile: (path, context) => {
          const sessionAttribution = protectedResultSessionAttribution(
            workSessionContext.current()?.workSessionBinding,
            context.sessionId ?? transportSessionId,
          );
          if (sessionAttribution === undefined) {
            throw new Error("LOCAL_FILE_ATTACHMENT_SESSION_UNAVAILABLE");
          }
          return this.#materializeLocalFile(path, sessionAttribution, identity);
        },
        mutationReplayStore: this.#mutationReplayStore,
        directGoalStore: this.#directGoalStore,
        ...(this.#options.nativeResourceLeaseCoordinator === undefined
          ? {}
          : { nativeResourceLeaseCoordinator: this.#options.nativeResourceLeaseCoordinator }),
        ...(this.#directJobManager === undefined
          ? {}
          : { directJobManager: this.#directJobManager }),
        ...(this.#directScheduleManager === undefined
          ? {}
          : { directScheduleManager: this.#directScheduleManager }),
        ...(this.#directJobDispatchAdapter === undefined
          ? {}
          : { directJobDispatchAdapter: this.#directJobDispatchAdapter }),
        ...(this.#durableWorkSessionStore === undefined
          ? {}
          : {
              resolveDurableWorkSessionBinding: () => {
                const binding = workSessionContext.current();
                if (binding === undefined) throw new Error("WORK_SESSION_CONTEXT_UNAVAILABLE");
                return binding;
              },
              listAuthorizedGoalWorkSessionBindings: async () => {
                const store = this.#durableWorkSessionStore;
                if (store === undefined) throw new Error("DURABLE_WORK_SESSION_UNAVAILABLE");
                return store.listOwnedWorkSessionBindings(principalBinding);
              },
            }),
        resolveRequestAttribution: (requestId) =>
          requestAttributions.get(mcpRequestIdKey(requestId)) ??
          soleRequestAttribution(requestAttributions) ??
          workSessionContext.currentAttribution(),
        legacyMutationCoordinator: this.#legacyMutationCoordinator,
        readInvocationCoordinator: this.#readInvocationCoordinator,
        scheduler: this.#nativeExecutionScheduler.contextualView(),
        authorizationBinding: principalBinding,
        correlationId,
        surface,
        ...(this.#options.actionCatalogByteBudget === undefined
          ? {}
          : { actionCatalogByteBudget: this.#options.actionCatalogByteBudget }),
      });
      this.#runtimeDirectJobAdapters.add(mcp.directJobDispatchAdapter);
      if (this.#admission === "draining") {
        this.#directJobManager?.beginAdapterDrain(mcp.directJobDispatchAdapter);
      }
    } catch (error) {
      await closeExecutors().catch(() => undefined);
      throw error;
    }
    return {
      transportSessionId,
      mcp,
      surface,
      authorizationBinding: ownerBinding,
      durablePrincipalBinding: principalBinding,
      correlationId,
      workSessionContext,
      requestAttributions,
      bindExecutorWorkSession,
      closeExecutors,
    };
  }

  async #newSession(
    surface: "compat" | "full",
    identity: HttpAuthorizationIdentity,
  ): Promise<Session> {
    let session: Session;
    const scope = await this.#createMcpExecutionScope(surface, identity);
    const eventStore = new DeferredDurableMcpEventStore();
    const transport = new StreamableHTTPServerTransport({
      // OmniCodex owns standalone SSE heartbeats; suppress SDK duplicate frames.
      keepAliveMs: 0,
      sessionIdGenerator: () => scope.transportSessionId,
      // Preserve Streamable HTTP event identity, cancellation, and durable
      // replay semantics for every POST result. The gateway marks these
      // finite SSE responses as non-bufferable before the SDK writes headers.
      enableJsonResponse: false,
      eventStore,
      onsessioninitialized: (id) => {
        this.#sessions.set(id, session);
      },
      onsessionclosed: (id) => this.#terminateSession(id, session),
    });
    session = {
      ...scope,
      transport,
      eventStore,
      standaloneSseGeneration: 0,
      standaloneSseLeases: new Map(),
      activeResponses: new Set(),
      activeFiniteResponses: new Set(),
      transportScopedExecutors: identity.executorLifecycle === "transport",
      lastActivityUnixMs: Date.now(),
    };
    const sdkSend = transport.send.bind(transport);
    let sendTail = Promise.resolve();
    transport.send = (message, options) => {
      const sent = sendTail.then(async () => {
        if (
          options?.relatedRequestId === undefined &&
          "method" in message &&
          (await this.#sendStandaloneMessageToPassive(session, message))
        ) {
          return;
        }
        await sdkSend(message, options);
        await this.#awaitSessionResponseBackpressure(session);
      });
      sendTail = sent.catch(() => undefined);
      return sent;
    };
    transport.onerror = (error) => {
      scope.mcp.server.onerror?.(error);
    };
    try {
      await scope.mcp.server.connect(
        transport as unknown as Parameters<typeof scope.mcp.server.connect>[0],
      );
      return session;
    } catch (error) {
      await scope.closeExecutors().catch(() => undefined);
      throw error;
    }
  }

  #terminateSession(sessionId: string, session: Session): Promise<void> {
    const existing = this.#terminatingSessions.get(sessionId);
    if (existing !== undefined) return existing.promise;

    const promise = (async () => {
      this.#retiringSessions.add(session);
      this.#closePassiveStandaloneSseLeases(session);
      if (this.#sessions.get(sessionId) === session) this.#sessions.delete(sessionId);
      const results = await Promise.allSettled([
        session.eventStore.tombstoneSession(),
        session.closeExecutors(),
      ]);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [asError(result.reason)] : [],
      );
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "OmniCodex MCP session termination failed");
      }
      this.#forgetOpenAiWorkSessionTransport(session);
      this.#retiringSessions.delete(session);
    })();
    session.terminationPromise = promise;
    this.#terminatingSessions.set(sessionId, {
      ownerBinding: session.authorizationBinding,
      surface: session.surface,
      promise,
    });
    void promise.then(
      () => {
        if (this.#terminatingSessions.get(sessionId)?.promise === promise) {
          this.#terminatingSessions.delete(sessionId);
        }
      },
      // Preserve a rejected termination as a fail-closed replay barrier.
      () => undefined,
    );
    return promise;
  }

  async #protectResult(
    result: CallToolResult,
    sessionId: string | undefined,
    identity: HttpAuthorizationIdentity,
    workSession:
      | Pick<DirectJobWorkSessionBinding, "workSessionBinding" | "continuationToken">
      | undefined,
  ): Promise<CallToolResult> {
    if (sessionId === undefined) return result;
    return await protectOversizedResult(
      result,
      {
        owner: identity,
        sessionId,
        ...(workSession === undefined ? {} : { retrievalSession: workSession }),
      },
      this.#resourceStore,
    );
  }

  async #readProtectedResult(
    request: ProtectedResultReadRequest,
    sessionId: string,
    identity: HttpAuthorizationIdentity,
  ): Promise<ProtectedResultReadChunk> {
    const descriptor = await this.#resourceStore.getMetadata(request.resourceId, identity);
    if (
      descriptor === undefined ||
      descriptor.sessionId !== sessionId ||
      (request.expectedDigest !== undefined && request.expectedDigest !== descriptor.digest)
    ) {
      throw new Error("PROTECTED_RESULT_UNAVAILABLE");
    }
    if (request.offset > descriptor.byteLength) {
      throw new RangeError("Protected result offset exceeds the complete result length");
    }
    const requestedEndExclusive = Math.min(
      descriptor.byteLength,
      request.offset + PROTECTED_RESULT_CHUNK_BYTES,
    );
    const slice = await this.#resourceStore.readRange(
      request.resourceId,
      identity,
      request.offset,
      requestedEndExclusive - 1,
    );
    if (
      slice === undefined ||
      slice.sessionId !== sessionId ||
      slice.digest !== descriptor.digest ||
      slice.byteLength !== descriptor.byteLength ||
      slice.mimeType !== descriptor.mimeType
    ) {
      throw new Error("PROTECTED_RESULT_UNAVAILABLE");
    }
    let candidateBytes = slice.bytes;
    for (;;) {
      const decoded =
        candidateBytes.byteLength === 0
          ? { text: "", byteLength: 0 }
          : decodeCompleteUtf8Prefix(candidateBytes);
      const endOffset = request.offset + decoded.byteLength;
      const chunk = {
        schemaVersion: 1 as const,
        resourceId: descriptor.id,
        mimeType: descriptor.mimeType,
        digest: descriptor.digest,
        digestAlgorithm: "sha-256" as const,
        byteLength: descriptor.byteLength,
        offset: request.offset,
        endOffset,
        nextOffset: endOffset === descriptor.byteLength ? null : endOffset,
        chunk: decoded.text,
        snapshotIntegrity: "verified" as const,
        deliveryState:
          endOffset === descriptor.byteLength ? ("end_of_snapshot" as const) : ("partial" as const),
      } satisfies ProtectedResultReadChunk;
      if (
        Buffer.byteLength(JSON.stringify(chunk), "utf8") <=
        MAX_PROTECTED_RESULT_CHUNK_SERIALIZED_BYTES
      ) {
        return chunk;
      }
      const nextByteLength = Math.floor((decoded.byteLength * 3) / 4);
      if (nextByteLength < 4 || nextByteLength >= decoded.byteLength) {
        throw new Error("PROTECTED_RESULT_CHUNK_INLINE_BUDGET_UNSATISFIABLE");
      }
      candidateBytes = slice.bytes.subarray(0, nextByteLength);
    }
  }

  async #materializeLocalFile(
    path: string,
    sessionId: string,
    identity: HttpAuthorizationIdentity,
  ): Promise<CallToolResult> {
    if (!isAbsolute(path)) throw new Error("LOCAL_FILE_ATTACHMENT_PATH_NOT_ABSOLUTE");
    const fileName = basename(path);
    if (fileName.length === 0) throw new Error("LOCAL_FILE_ATTACHMENT_NAME_UNAVAILABLE");
    const mimeType = localFileMimeType(path);
    const descriptor = await this.#resourceStore.putFile({
      owner: identity,
      sessionId,
      mimeType,
      path,
    });
    const origin = new URL(identity.resource).origin;
    const uri = new URL(`${RESOURCE_PATH_PREFIX}${descriptor.id}`, origin).href;
    const structuredContent = {
      fileName,
      mimeType,
      byteLength: descriptor.byteLength,
      digest: descriptor.digest,
      digestAlgorithm: "sha-256" as const,
    };
    return {
      content: [
        {
          type: "resource_link",
          name: fileName,
          title: fileName,
          uri,
          mimeType,
          size: descriptor.byteLength,
          description: "Local file attachment",
          _meta: {
            omnicodex: {
              ownerBound: true,
              digest: descriptor.digest,
              digestAlgorithm: "sha-256",
              byteLength: descriptor.byteLength,
            },
          },
        },
      ],
      structuredContent,
    };
  }

  async #serveResource(
    request: IncomingMessage,
    response: ServerResponse,
    resourceId: string,
    identity: HttpAuthorizationIdentity,
  ): Promise<void> {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      sendText(response, 405, "Method Not Allowed");
      return;
    }
    // ChatGPT may fetch a resource after closing the short-lived MCP tool
    // transport that produced it. Keep the file bound to the exact durable
    // issuer/subject/resource principal and opaque URL, rather than to the
    // OAuth client registration or transport session that may rotate.
    const descriptor = await this.#resourceStore.getMetadata(resourceId, identity);
    if (descriptor === undefined) {
      sendText(response, 404, "Resource unavailable");
      return;
    }
    const requestedRange = parseResourceByteRange(
      singleHeader(request.headers.range),
      descriptor.byteLength,
    );
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("ETag", `"sha256-${descriptor.digest}"`);
    if (requestedRange === null) {
      response.setHeader("Content-Range", `bytes */${String(descriptor.byteLength)}`);
      sendText(response, 416, "Range Not Satisfiable");
      return;
    }
    if (requestedRange === undefined) {
      const resource = await this.#resourceStore.openReadStream(resourceId, identity);
      if (resource === undefined) {
        sendText(response, 404, "Resource unavailable");
        return;
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", resource.mimeType);
      const contentEncoding = preferredResourceContentEncoding(
        request.headers["accept-encoding"],
        resource.mimeType,
        resource.byteLength,
      );
      if (contentEncoding === undefined) {
        response.setHeader("Content-Length", String(resource.byteLength));
        await pipeline(resource.stream, response);
        return;
      }
      appendVaryHeader(response, "Accept-Encoding");
      response.setHeader("Content-Encoding", contentEncoding);
      response.setHeader("ETag", `"sha256-${descriptor.digest}-${contentEncoding}"`);
      await pipeline(resource.stream, resourceCompressor(contentEncoding), response);
      return;
    }
    const resource = await this.#resourceStore.openReadStream(resourceId, identity, requestedRange);
    if (resource === undefined) {
      sendText(response, 404, "Resource unavailable");
      return;
    }
    response.statusCode = 206;
    response.setHeader("Content-Type", resource.mimeType);
    response.setHeader("Content-Length", String(resource.endInclusive - resource.start + 1));
    response.setHeader(
      "Content-Range",
      `bytes ${String(resource.start)}-${String(resource.endInclusive)}/${String(resource.byteLength)}`,
    );
    await pipeline(resource.stream, response);
  }

  #serveMetadata(request: IncomingMessage, response: ServerResponse, path: string): void {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      sendText(response, 405, "Method Not Allowed");
      return;
    }
    const metadata = this.#metadataForPath(path);
    if (metadata === undefined) {
      sendText(response, 404, "Not Found");
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify(metadata));
  }

  async #authorize(request: IncomingMessage): Promise<HttpAuthorizationDecision> {
    try {
      return await this.#options.authorize(request);
    } catch {
      return { ok: false, status: 401, message: "Unauthorized" };
    }
  }

  #sendAuthorizationFailure(
    request: IncomingMessage,
    response: ServerResponse,
    authorization: HttpAuthorizationDecision,
    surface: "compat" | "full" | undefined,
  ): void {
    response.statusCode = authorization.status ?? 401;
    for (const [name, value] of Object.entries(authorization.headers ?? {})) {
      if (safeAuthorizationResponseHeader(name)) response.setHeader(name, value);
    }
    const resourceMetadata = this.#resourceMetadataUrl(surface, request);
    if (
      resourceMetadata !== undefined &&
      (response.statusCode === 401 || response.statusCode === 403)
    ) {
      const existing = response.getHeader("WWW-Authenticate");
      const challenge =
        typeof existing === "string" && existing.trim().length > 0 ? existing.trim() : "Bearer";
      const error = response.statusCode === 403 ? "insufficient_scope" : "invalid_token";
      const errorDescription =
        authorization.failureCode === "authorization_header_missing"
          ? "Missing Authorization header"
          : response.statusCode === 403
            ? "Required authorization scope was not granted"
            : "Access token is invalid";
      const scope = surface === undefined ? undefined : this.#requiredScopeChallenge(surface);
      response.setHeader(
        "WWW-Authenticate",
        challenge +
          (/^Bearer$/i.test(challenge) ? " " : ", ") +
          [
            `error="${error}"`,
            `error_description="${errorDescription}"`,
            ...(scope === undefined ? [] : [`scope="${scope}"`]),
            `resource_metadata="${resourceMetadata}"`,
          ].join(", "),
      );
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ error, error_description: errorDescription }));
      return;
    }
    response.end("Unauthorized");
  }

  #resourceMetadataUrl(
    surface: "compat" | "full" | undefined,
    request: IncomingMessage,
  ): string | undefined {
    if (surface === undefined) return undefined;
    const metadata = this.#metadata?.[surface];
    const resource = metadataOrigin(metadata);
    if (resource === undefined) return undefined;
    const address = this.#address;
    // Direct loopback clients discover this server through its own origin.
    // This changes the document location, not its resource audience or issuer.
    const localAuthority = address === undefined ? undefined : `${address.host}:${address.port}`;
    const directLocal =
      localAuthority !== undefined &&
      singleHeader(request.headers.host) === localAuthority &&
      request.headers.forwarded === undefined &&
      request.headers["x-forwarded-host"] === undefined;
    return new URL(
      protectedResourceMetadataPath(resource.pathname),
      directLocal
        ? `http://${localAuthority}`
        : (this.#options.publicMetadataOrigin ?? resource.origin),
    ).href;
  }

  #metadataForPath(path: string): Record<string, unknown> | undefined {
    // ChatGPT's custom-plugin registration probe currently requests the RFC
    // 9728 origin-level fallback before it has followed a resource-specific
    // WWW-Authenticate challenge.  Advertise the canonical full surface there
    // while retaining the more specific per-surface metadata URLs below.
    if (path === PROTECTED_RESOURCE_METADATA_ROOT) return this.#metadata?.full;
    if (path === protectedResourceMetadataPath(this.#options.path)) return this.#metadata?.compat;
    if (path === protectedResourceMetadataPath(this.#options.fullPath)) return this.#metadata?.full;
    return undefined;
  }

  #serveAuthorizationServerMetadata(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      sendText(response, 405, "Method Not Allowed");
      return;
    }
    const configured = this.#options.authorizationServerMetadata;
    const protectedResource = this.#metadata?.full;
    const advertised = protectedResource?.authorization_servers;
    if (
      configured === undefined &&
      (!Array.isArray(advertised) || typeof advertised[0] !== "string")
    ) {
      sendText(response, 404, "Not Found");
      return;
    }
    const issuer = `${String(Array.isArray(advertised) ? advertised[0] : "").replace(/\/+$/u, "")}/`;
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    // Registration clients may negatively cache a missing discovery variant.
    // This endpoint is tiny and registration is rare, so always revalidate it.
    response.setHeader("Cache-Control", "no-store");
    response.end(
      JSON.stringify(
        configured ?? {
          issuer,
          authorization_endpoint: new URL("authorize", issuer).href,
          token_endpoint: new URL("oauth/token", issuer).href,
          registration_endpoint: new URL("oidc/register", issuer).href,
          jwks_uri: new URL(".well-known/jwks.json", issuer).href,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: [
            "none",
            "client_secret_basic",
            "client_secret_post",
          ],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: [
            "openid",
            "profile",
            "email",
            ...new Set(
              Array.isArray(protectedResource?.scopes_supported)
                ? protectedResource.scopes_supported.filter(
                    (scope): scope is string => typeof scope === "string",
                  )
                : [],
            ),
          ],
        },
      ),
    );
  }

  #requiredScopeChallenge(surface: "compat" | "full"): string | undefined {
    const scopes = this.#metadata?.[surface].scopes_supported;
    if (!Array.isArray(scopes)) return undefined;
    const required = scopes.filter(
      (scope): scope is string => typeof scope === "string" && scope !== "offline_access",
    );
    return required.length === 0 ? undefined : required.join(" ");
  }

  #identityMatchesSurface(
    identity: HttpAuthorizationIdentity,
    surface: "compat" | "full",
  ): boolean {
    return this.#metadata?.[surface].resource === identity.resource;
  }

  #setSecurityHeaders(response: ServerResponse): void {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
  }

  #applyCors(request: IncomingMessage, response: ServerResponse): boolean {
    const origin = singleHeader(request.headers.origin);
    if (origin === null) return false;
    if (origin === undefined) return true;
    if (!this.#options.allowedOrigins.includes(origin)) return false;
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Headers", [...ALLOWED_CORS_HEADERS].join(", "));
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    response.setHeader(
      "Access-Control-Expose-Headers",
      "MCP-Session-Id, MCP-Protocol-Version, WWW-Authenticate",
    );
    return true;
  }

  #validHost(request: IncomingMessage): boolean {
    const host = singleHeader(request.headers.host);
    if (host === undefined || host === null) return false;
    const address = this.#address;
    const localHost = address === undefined ? undefined : `${address.host}:${address.port}`;
    const metadataHost = metadataOrigin(this.#metadata?.compat)?.host;
    return [localHost, metadataHost, ...this.#options.allowedHosts]
      .filter((candidate): candidate is string => candidate !== undefined)
      .some((candidate) => candidate.toLowerCase() === host.toLowerCase());
  }

  #validPreflight(request: IncomingMessage, path: string): boolean {
    const origin = singleHeader(request.headers.origin);
    if (origin === undefined || origin === null) return false;
    const requestedMethod = singleHeader(request.headers["access-control-request-method"]);
    if (
      requestedMethod === undefined ||
      requestedMethod === null ||
      !isMcpMethod(requestedMethod)
    ) {
      return false;
    }
    const requestedHeaders = singleHeader(request.headers["access-control-request-headers"]);
    if (requestedHeaders !== undefined && requestedHeaders !== null) {
      for (const header of requestedHeaders.split(",")) {
        if (!ALLOWED_CORS_HEADERS.has(header.trim().toLowerCase())) return false;
      }
    }
    return (
      path === this.#options.path ||
      path === this.#options.fullPath ||
      isMetadataPath(path, this.#options.path, this.#options.fullPath) ||
      resourceIdFromPath(path) !== undefined
    );
  }
}

function parsedToolCall(
  value: unknown,
): { readonly name: string; readonly arguments: Record<string, unknown> } | undefined {
  if (!isObject(value) || value.method !== "tools/call" || !isObject(value.params)) {
    return undefined;
  }
  if (typeof value.params.name !== "string") return undefined;
  return {
    name: value.params.name,
    arguments: isObject(value.params.arguments) ? value.params.arguments : {},
  };
}

/**
 * ChatGPT can send a complete request as one authenticated POST without first
 * opening a transport session.  Keep initialize/session lifecycle traffic on
 * the durable 2025 transport, but serve an id-bearing direct request through
 * the SDK's official stateless compatibility path.  This preserves the
 * conversation metadata carried in params._meta while avoiding an invented
 * initialize handshake or a client retry.
 */
function isDirectStatelessLegacyRequest(request: IncomingMessage, value: unknown): boolean {
  if (request.method !== "POST" || headerValue(request.headers["mcp-session-id"]) !== undefined) {
    return false;
  }
  if (!isObject(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
    return false;
  }
  if (value.method === "initialize" || value.method.startsWith("notifications/")) return false;
  return typeof value.id === "string" || typeof value.id === "number";
}

function validateHttpAdmission(
  request: IncomingMessage,
): { readonly status: number; readonly message: string } | undefined {
  if (request.method === "POST") {
    const contentType = headerValue(request.headers["content-type"]);
    if (contentType === undefined || contentType.split(";", 1)[0]?.trim() !== "application/json") {
      return { status: 415, message: "Unsupported Media Type" };
    }
    const accept = mediaTypes(headerValue(request.headers.accept));
    if (!accept.has("application/json") || !accept.has("text/event-stream")) {
      return { status: 406, message: "Not Acceptable" };
    }
  }
  if (request.method === "GET") {
    const accept = mediaTypes(headerValue(request.headers.accept));
    if (!accept.has("text/event-stream")) return { status: 406, message: "Not Acceptable" };
  }
  return undefined;
}

type JsonBodyResult =
  | { readonly ok: true; readonly value: unknown; readonly byteLength: number }
  | { readonly ok: false; readonly status: 400 | 413; readonly message: string };

async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number | undefined,
): Promise<JsonBodyResult> {
  const contentLength = headerValue(request.headers["content-length"]);
  if (contentLength !== undefined && /^\d+$/.test(contentLength)) {
    const statedLength = Number(contentLength);
    if (
      !Number.isSafeInteger(statedLength) ||
      (maxBytes !== undefined && statedLength > maxBytes)
    ) {
      request.resume();
      return { ok: false, status: 413, message: "Payload Too Large" };
    }
  }
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    byteLength += bytes.byteLength;
    if (maxBytes !== undefined && byteLength > maxBytes) {
      request.resume();
      return { ok: false, status: 413, message: "Payload Too Large" };
    }
    chunks.push(bytes);
  }
  try {
    return {
      ok: true,
      value: JSON.parse(Buffer.concat(chunks, byteLength).toString("utf8")),
      byteLength,
    };
  } catch {
    return { ok: false, status: 400, message: "Invalid JSON-RPC body" };
  }
}

function initializationVersion(
  value: unknown,
): (typeof SUPPORTED_PROTOCOL_VERSIONS)[number] | string | undefined {
  if (!isObject(value) || value.method !== "initialize" || !isObject(value.params))
    return undefined;
  return typeof value.params.protocolVersion === "string" ? value.params.protocolVersion : "";
}

function safeJsonRpcMethod(value: unknown): string | undefined {
  if (!isObject(value) || typeof value.method !== "string") return undefined;
  return /^[A-Za-z][A-Za-z0-9_/-]{0,127}$/.test(value.method) ? value.method : "unknown";
}

function canServeWhileDraining(value: unknown): boolean {
  if (!isObject(value)) return false;
  // These protocol operations and the historical status template use no
  // retiring native runtime. Saved ChatGPT results still need the template
  // while admitted work drains; rejecting it caches a broken iframe in the UI.
  switch (value.method) {
    case "initialize":
    case "notifications/initialized":
    case "resources/list":
    case "resources/templates/list":
      return true;
    case "resources/read":
      return isObject(value.params) && value.params.uri === OMNICODEX_ACTIVITY_RESOURCE_URI;
    default:
      return false;
  }
}

function safeUiResourceUri(value: unknown): string | undefined {
  if (!isObject(value) || value.method !== "resources/read" || !isObject(value.params)) {
    return undefined;
  }
  const uri = value.params.uri;
  if (typeof uri !== "string") return undefined;
  try {
    const parsed = new URL(uri);
    if (
      parsed.protocol !== "ui:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    )
      return undefined;
    return uri;
  } catch {
    return undefined;
  }
}

function safeJsonRpcIdDigest(value: unknown, hmacKey: Buffer): string | undefined {
  if (!isObject(value)) return undefined;
  const id = value.id;
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  return metadataDigest(hmacKey, "jsonrpc-id", `${typeof id}:${String(id)}`);
}

function safeToolInvocationIdDigest(value: unknown): string | undefined {
  const messages = Array.isArray(value) ? value : [value];
  const invocationIds = messages.flatMap((message) => {
    if (!isObject(message) || !isObject(message.params)) return [];
    const args = isObject(message.params.arguments) ? message.params.arguments : {};
    const meta = isObject(message.params._meta) ? message.params._meta : {};
    return [
      args.omnicodexInvocationId,
      meta["omnicodex/invocationId"],
      meta["openai/toolInvocationId"],
    ].filter((item): item is string => typeof item === "string" && item.length > 0);
  });
  const coherentInvocationIds = [...new Set(invocationIds)];
  if (coherentInvocationIds.length !== 1) return undefined;
  return createHash("sha256")
    .update(coherentInvocationIds[0] as string, "utf8")
    .digest("hex");
}

function requestAttribution(
  request: IncomingMessage,
  trace: MutableMcpRequestTrace,
  principalBinding: string,
  hmacKey: Buffer,
): McpRequestAttribution {
  const transportIdentityDigests = [
    ...safeHeaderIdentityDigests(request, hmacKey),
    ...trace.requestMetaDigests,
  ];
  return {
    principalBindingSha256: sha256Metadata(principalBinding),
    callerProvenance: callerProvenanceFromIdentityDigests(transportIdentityDigests),
    ...(trace.jsonRpcIdHmac === undefined ? {} : { jsonRpcIdHmac: trace.jsonRpcIdHmac }),
    ...(trace.invocationIdSha256 === undefined
      ? {}
      : { invocationIdSha256: trace.invocationIdSha256 }),
    ...(transportIdentityDigests.length === 0 ? {} : { transportIdentityDigests }),
  };
}

function callerProvenanceFromIdentityDigests(
  identities: readonly McpRequestIdentityDigest[],
): NonNullable<McpRequestAttribution["callerProvenance"]> {
  return identities.some(
    ({ name }) => name === "meta:openai/session" || /^meta:\d+:openai\/session$/u.test(name),
  )
    ? "chatgpt_conversation"
    : "unattributed_mcp_client";
}

function attributedObservation<T extends McpRequestAttributionObservation>(
  observation: T,
  context: McpWorkSessionContext,
  principalBinding: string,
  fallbackWorkSessionBinding: string | undefined,
): T {
  const request = context.currentAttribution();
  const workSessionBinding = context.current()?.workSessionBinding ?? fallbackWorkSessionBinding;
  return {
    ...observation,
    principalBindingSha256: request?.principalBindingSha256 ?? sha256Metadata(principalBinding),
    ...(request?.callerProvenance === undefined
      ? {}
      : { callerProvenance: request.callerProvenance }),
    ...(request?.jsonRpcIdHmac === undefined ? {} : { jsonRpcIdHmac: request.jsonRpcIdHmac }),
    ...(request?.invocationIdSha256 === undefined
      ? {}
      : { invocationIdSha256: request.invocationIdSha256 }),
    ...(request?.transportIdentityDigests === undefined
      ? {}
      : { transportIdentityDigests: request.transportIdentityDigests }),
    ...(request?.chatGptConversationIdSha256 === undefined
      ? {}
      : { chatGptConversationIdSha256: request.chatGptConversationIdSha256 }),
    ...(workSessionBinding === undefined
      ? {}
      : { workSessionBindingSha256: sha256Metadata(workSessionBinding) }),
  };
}

function attributedResultObservation(
  observation: McpResultDeliveryObservation,
  context: McpWorkSessionContext,
  principalBinding: string,
  fallbackWorkSessionBinding: string | undefined,
): McpResultDeliveryObservation {
  const attributed = attributedObservation(
    observation,
    context,
    principalBinding,
    fallbackWorkSessionBinding,
  );
  const chatGptConversationUrl = context.currentAttribution()?.chatGptConversationUrl;
  return {
    ...attributed,
    ...(chatGptConversationUrl === undefined ? {} : { chatGptConversationUrl }),
  };
}

function safeRequestMetaDigests(
  value: unknown,
  hmacKey: Buffer,
): readonly TransportIdentityDigest[] {
  const messages = Array.isArray(value) ? value : [value];
  const allowedKeys = new Set([
    "io.modelcontextprotocol/related-task",
    "omnicodex/continuation-token",
    "omnicodex/invocationId",
    "openai/organization",
    "openai/session",
    "openai/subject",
    "openai/toolInvocationId",
    "progressToken",
  ]);
  const result: TransportIdentityDigest[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (!isObject(message) || !isObject(message.params) || !isObject(message.params._meta)) {
      continue;
    }
    for (const key of Object.keys(message.params._meta).sort((left, right) =>
      left.localeCompare(right, "en"),
    )) {
      if (!allowedKeys.has(key)) continue;
      const item = message.params._meta[key];
      let serialized: string;
      try {
        serialized = canonicalJson(item);
      } catch {
        continue;
      }
      const name = messages.length === 1 ? `meta:${key}` : `meta:${messageIndex}:${key}`;
      result.push({
        name,
        valueHmac: metadataDigest(hmacKey, name, serialized),
      });
    }
  }
  return result;
}

function safeHeaderIdentityDigests(
  request: IncomingMessage,
  hmacKey: Buffer,
): readonly TransportIdentityDigest[] {
  const result: TransportIdentityDigest[] = [];
  for (const name of [...TRANSPORT_IDENTITY_HEADERS].sort((left, right) =>
    left.localeCompare(right, "en"),
  )) {
    const value = request.headers[name];
    if (value === undefined) continue;
    const normalized = Array.isArray(value) ? value.join("\u0000") : value;
    result.push({
      name: `header:${name}`,
      valueHmac: metadataDigest(hmacKey, `header:${name}`, normalized),
    });
    if (name === "traceparent") {
      const traceId = traceparentTraceId(normalized);
      if (traceId !== undefined) {
        result.push({
          name: "header:traceparent-trace-id",
          valueHmac: metadataDigest(hmacKey, "header:traceparent-trace-id", traceId),
        });
      }
    }
  }
  return result;
}

/**
 * OpenTelemetry retries create new spans but retain the logical trace id. Keep
 * only a process-keyed digest of that trace id so independently reconnected
 * MCP transports can identify one exact tool invocation without logging the
 * raw distributed-tracing value.
 */
function traceparentTraceId(value: string): string | undefined {
  const match = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}(?:-[!-~]+)?$/iu.exec(
    value.trim(),
  );
  const traceId = match?.[1]?.toLowerCase();
  return traceId === undefined || /^0{32}$/u.test(traceId) ? undefined : traceId;
}

/**
 * ChatGPT may open a fresh MCP transport for every tool call in one model turn.
 * OpenTelemetry span ids change per call, while the trace id remains stable for
 * that logical turn. Use the trace as the automatic work-session transport
 * identity so all native executors and browser bindings in the turn are shared.
 * The MCP runtime may also use the process-keyed trace digest to join identical
 * side-effect-free reads while they are in flight. It never applies that
 * transport inference to mutations or replays a completed transport read.
 */
function workSessionTransportIdentity(
  request: IncomingMessage,
  transportSessionId: string,
): string {
  const traceparent = headerValue(request.headers.traceparent);
  const traceId = traceparent === undefined ? undefined : traceparentTraceId(traceparent);
  return traceId === undefined ? transportSessionId : `otel-trace:${traceId}`;
}

function metadataDigest(hmacKey: Buffer, domain: string, value: string): string {
  return createHmac("sha256", hmacKey)
    .update(`${domain}\u0000${value}`, "utf8")
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

function sha256Metadata(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function protectedResultSessionAttribution(
  workSessionBinding: string | undefined,
  transportSessionId: string | undefined,
): string | undefined {
  if (workSessionBinding === undefined) return transportSessionId;
  return createHash("sha256")
    .update("omnicodex-protected-result-work-session\0", "utf8")
    .update(workSessionBinding, "utf8")
    .digest("base64url");
}

function decodeCompleteUtf8Prefix(bytes: Uint8Array): {
  readonly text: string;
  readonly byteLength: number;
} {
  const minimumEnd = Math.max(1, bytes.byteLength - 3);
  for (let end = bytes.byteLength; end >= minimumEnd; end -= 1) {
    try {
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)),
        byteLength: end,
      };
    } catch {
      // A transport chunk may end in the middle of one UTF-8 code point. The
      // returned nextOffset always advances only through a complete prefix.
    }
  }
  throw new Error("PROTECTED_RESULT_OFFSET_NOT_UTF8_BOUNDARY");
}

function safeProtocolVersion(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "invalid";
}

function requestId(value: unknown): string | number | null {
  if (!isObject(value)) return null;
  return typeof value.id === "string" || typeof value.id === "number" ? value.id : null;
}

function mcpRequestIdKey(value: string | number | null | undefined): string {
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "number") return `number:${value}`;
  return "";
}

function soleRequestAttribution(
  attributions: ReadonlyMap<string, McpRequestAttribution>,
): McpRequestAttribution | undefined {
  if (attributions.size !== 1) return undefined;
  return attributions.values().next().value;
}

function prepareMcpPostResponse(request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== "POST" || response.headersSent) return;
  // Tool results are finite SSE responses. Tell reverse proxies to forward
  // each terminal frame immediately instead of waiting for a buffer threshold.
  response.setHeader("X-Accel-Buffering", "no");
  response.setHeader("Cache-Control", "no-cache");
}

function transportDisconnectBoundary(
  request: IncomingMessage,
  response: ServerResponse,
): { readonly signal: AbortSignal; readonly clear: () => void } {
  const controller = new AbortController();
  const abort = (): void => {
    if (response.writableEnded || controller.signal.aborted) return;
    controller.abort(new Error("MCP response connection closed"));
  };
  const clear = (): void => {
    request.off("aborted", abort);
    response.off("close", abort);
  };
  request.once("aborted", abort);
  response.once("close", abort);
  if (request.aborted || (response.destroyed && !response.writableEnded)) abort();
  return { signal: controller.signal, clear };
}

function sendProtocolError(
  response: ServerResponse,
  id: string | number | null,
  message: string,
): void {
  response.statusCode = 400;
  response.setHeader("Content-Type", "application/json");
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32600,
        message,
        data: {
          supportedProtocolVersions: [MODERN_PROTOCOL_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS],
        },
      },
    }),
  );
}

function sendMcpError(
  response: ServerResponse,
  id: string | number | null,
  code: number,
  message: string,
): void {
  response.statusCode = 400;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
}

function sendStructuredMcpError(
  response: ServerResponse,
  id: string | number | null,
  fallbackCode: number,
  error: unknown,
  status: number,
): void {
  const details = structuredErrorDetails(error);
  const code = jsonRpcErrorCode(error) ?? fallbackCode;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message: errorMessage(error),
        data: details,
      },
    }),
  );
}

function jsonRpcErrorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = Reflect.get(error, "code");
  if (Number.isSafeInteger(direct)) return direct as number;
  const rpcError = Reflect.get(error, "rpcError");
  if (typeof rpcError !== "object" || rpcError === null) return undefined;
  const nested = Reflect.get(rpcError, "code");
  return Number.isSafeInteger(nested) ? (nested as number) : undefined;
}

function workSessionFailure(error: unknown): string {
  if (typeof error !== "object" || error === null) return "WORK_SESSION_BINDING_FAILED";
  const code = Reflect.get(error, "code");
  return typeof code === "string" && /^WORK_SESSION_[A-Z_]+$/u.test(code)
    ? code
    : "WORK_SESSION_BINDING_FAILED";
}

function validProtocolHeader(request: IncomingMessage): boolean {
  const version = singleHeader(request.headers["mcp-protocol-version"]);
  return (
    version !== null &&
    (version === undefined ||
      version === MODERN_PROTOCOL_VERSION ||
      SUPPORTED_PROTOCOL_VERSIONS.some((supported) => supported === version))
  );
}

function normalizeProtectedResourceMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  if (typeof metadata.resource !== "string") {
    throw new Error("Protected-resource metadata requires an exact resource URI");
  }
  const resource = new URL(metadata.resource);
  if (
    resource.protocol !== "https:" ||
    resource.username.length > 0 ||
    resource.password.length > 0 ||
    resource.search.length > 0 ||
    resource.hash.length > 0
  ) {
    throw new Error("Protected OAuth resource must be a credential-free HTTPS URL");
  }
  if (
    !Array.isArray(metadata.authorization_servers) ||
    metadata.authorization_servers.length !== 1 ||
    typeof metadata.authorization_servers[0] !== "string"
  ) {
    throw new Error("Protected-resource metadata requires one Auth0 authorization server");
  }
  const authorizationServer = exactAuthorizationServer(metadata.authorization_servers[0]);
  if (
    !Array.isArray(metadata.scopes_supported) ||
    !metadata.scopes_supported.includes("omnicodex:full")
  ) {
    throw new Error("Protected-resource metadata must advertise omnicodex:full");
  }
  if (
    !Array.isArray(metadata.bearer_methods_supported) ||
    metadata.bearer_methods_supported.length !== 1 ||
    metadata.bearer_methods_supported[0] !== "header"
  ) {
    throw new Error("Protected-resource metadata permits bearer authorization headers only");
  }
  return {
    ...metadata,
    resource: metadata.resource,
    // RFC 9728 authorization-server identifiers are issuer identifiers, not
    // URL prefixes. Preserve Auth0's canonical trailing slash exactly so the
    // discovered metadata `issuer` compares byte-for-byte with this value.
    authorization_servers: [authorizationServer],
    scopes_supported: [...metadata.scopes_supported],
    bearer_methods_supported: ["header"],
  };
}

function normalizeAuthorizationServerMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  if (typeof metadata.issuer !== "string") {
    throw new Error("Authorization-server metadata requires an exact issuer");
  }
  exactAuthorizationServer(metadata.issuer);
  for (const field of [
    "authorization_endpoint",
    "token_endpoint",
    "registration_endpoint",
    "jwks_uri",
  ] as const) {
    const value = metadata[field];
    if (typeof value !== "string") {
      throw new Error(`Authorization-server metadata requires ${field}`);
    }
    exactCredentialFreeHttpsUrl(value, field);
  }
  if (
    !Array.isArray(metadata.code_challenge_methods_supported) ||
    !metadata.code_challenge_methods_supported.includes("S256")
  ) {
    throw new Error("Authorization-server metadata must advertise PKCE S256");
  }
  if (!Array.isArray(metadata.token_endpoint_auth_methods_supported)) {
    throw new Error("Authorization-server metadata requires token endpoint auth methods");
  }
  return {
    ...metadata,
    code_challenge_methods_supported: [...metadata.code_challenge_methods_supported],
    token_endpoint_auth_methods_supported: [...metadata.token_endpoint_auth_methods_supported],
    ...(Array.isArray(metadata.response_types_supported)
      ? { response_types_supported: [...metadata.response_types_supported] }
      : {}),
    ...(Array.isArray(metadata.grant_types_supported)
      ? { grant_types_supported: [...metadata.grant_types_supported] }
      : {}),
    ...(Array.isArray(metadata.scopes_supported)
      ? { scopes_supported: [...metadata.scopes_supported] }
      : {}),
  };
}

function exactCredentialFreeHttpsUrl(value: string, field: string): void {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(`${field} must be a credential-free HTTPS URL`);
  }
}

function exactAuthorizationServer(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    !value.endsWith("/")
  ) {
    throw new Error("Auth0 authorization server must be an exact HTTPS issuer ending in slash");
  }
  return value;
}

function metadataOrigin(metadata: Record<string, unknown> | undefined): URL | undefined {
  return typeof metadata?.resource === "string" ? new URL(metadata.resource) : undefined;
}

function metadataForResourcePath(
  metadata: Record<string, unknown>,
  resourcePath: string,
): Record<string, unknown> {
  const origin = metadataOrigin(metadata) as URL;
  return { ...metadata, resource: new URL(resourcePath, origin.origin).href };
}

function isMetadataPath(path: string, mcpPath: string, fullPath: string): boolean {
  return (
    path === PROTECTED_RESOURCE_METADATA_ROOT ||
    path === protectedResourceMetadataPath(mcpPath) ||
    path === protectedResourceMetadataPath(fullPath)
  );
}

const PROTECTED_RESOURCE_METADATA_ROOT = "/.well-known/oauth-protected-resource";
const AUTHORIZATION_SERVER_METADATA_ROOT = "/.well-known/oauth-authorization-server";
const OPENID_CONFIGURATION_ROOT = "/.well-known/openid-configuration";

function isAuthorizationServerMetadataPath(
  path: string,
  configured: Record<string, unknown> | undefined,
  protectedResource: Record<string, unknown> | undefined,
): boolean {
  const advertised = protectedResource?.authorization_servers;
  const issuer =
    typeof configured?.issuer === "string"
      ? configured.issuer
      : Array.isArray(advertised) && typeof advertised[0] === "string"
        ? advertised[0]
        : undefined;
  if (issuer === undefined) return false;
  const issuerPath = new URL(issuer).pathname.replace(/\/+$/u, "");
  return new Set([
    AUTHORIZATION_SERVER_METADATA_ROOT,
    OPENID_CONFIGURATION_ROOT,
    issuerPath,
    `${issuerPath}/`,
    `${AUTHORIZATION_SERVER_METADATA_ROOT}${issuerPath}`,
    `${AUTHORIZATION_SERVER_METADATA_ROOT}${issuerPath}/`,
    `${OPENID_CONFIGURATION_ROOT}${issuerPath}`,
    `${OPENID_CONFIGURATION_ROOT}${issuerPath}/`,
    `${issuerPath}${AUTHORIZATION_SERVER_METADATA_ROOT}`,
    `${issuerPath}${AUTHORIZATION_SERVER_METADATA_ROOT}/`,
    `${issuerPath}/${AUTHORIZATION_SERVER_METADATA_ROOT}`,
    `${issuerPath}/${AUTHORIZATION_SERVER_METADATA_ROOT}/`,
    `${issuerPath}${OPENID_CONFIGURATION_ROOT}`,
    `${issuerPath}${OPENID_CONFIGURATION_ROOT}/`,
    `${issuerPath}/${OPENID_CONFIGURATION_ROOT}`,
    `${issuerPath}/${OPENID_CONFIGURATION_ROOT}/`,
  ]).has(path);
}

function protectedResourceMetadataPath(mcpPath: string): string {
  return `${PROTECTED_RESOURCE_METADATA_ROOT}${mcpPath}`;
}

function resourceIdFromPath(path: string): string | undefined {
  if (!path.startsWith(RESOURCE_PATH_PREFIX)) return undefined;
  const id = path.slice(RESOURCE_PATH_PREFIX.length);
  return validOpaqueResourceId(id) ? id : undefined;
}

function localFileMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    case ".txt":
    case ".log":
      return "text/plain; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv; charset=utf-8";
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8";
    case ".zip":
      return "application/zip";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".glb":
      return "model/gltf-binary";
    case ".gltf":
      return "model/gltf+json";
    default:
      return "application/octet-stream";
  }
}

function requestUrl(request: IncomingMessage): URL | undefined {
  try {
    return new URL(request.url ?? "", "http://127.0.0.1");
  } catch {
    return undefined;
  }
}

function exactEndpointPath(value: string, label: string): string {
  if (!/^\/[A-Za-z0-9/_-]*[A-Za-z0-9_-]$/.test(value) || value.includes("//")) {
    throw new Error(`${label} must be an exact absolute path`);
  }
  return value;
}

function exactOrigin(value: string): string {
  const origin = new URL(value);
  if (
    (origin.protocol !== "https:" && origin.protocol !== "http:") ||
    origin.username.length > 0 ||
    origin.password.length > 0 ||
    origin.pathname !== "/" ||
    origin.search.length > 0 ||
    origin.hash.length > 0
  ) {
    throw new Error("CORS origins must be exact scheme, host, and port triples");
  }
  return origin.origin;
}

function exactHost(value: string): string {
  if (!/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(value)) throw new Error("Invalid allowed Host value");
  return value;
}

function exactPublicMetadataOrigin(value: string): string {
  const origin = new URL(value);
  if (
    origin.protocol !== "https:" ||
    origin.username.length > 0 ||
    origin.password.length > 0 ||
    origin.pathname !== "/" ||
    origin.search.length > 0 ||
    origin.hash.length > 0
  ) {
    throw new Error("Public metadata origin must be an exact HTTPS origin");
  }
  return origin.origin;
}

function mediaTypes(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.split(";", 1)[0]?.trim().toLowerCase())
      .filter((item): item is string => item !== undefined && item.length > 0),
  );
}

function isMcpMethod(method: string | undefined): method is "GET" | "POST" | "DELETE" {
  return method === "GET" || method === "POST" || method === "DELETE";
}

export async function awaitFiniteMcpPostSettlement(
  response: ServerResponse,
  handling: Promise<void>,
): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    void handling.catch(() => undefined);
    return;
  }

  let releaseListeners: () => void = () => undefined;
  const responseSettled = new Promise<{ readonly kind: "response" }>((resolve) => {
    const settle = () => resolve({ kind: "response" });
    const cleanup = () => {
      response.off("finish", onFinish);
      response.off("close", onClose);
    };
    const onFinish = () => {
      cleanup();
      settle();
    };
    const onClose = () => {
      cleanup();
      settle();
    };
    releaseListeners = cleanup;
    response.once("finish", onFinish);
    response.once("close", onClose);
    if (response.destroyed || response.writableEnded) onClose();
  });
  // A Streamable HTTP handler may resolve after it has handed an SSE response
  // to the transport while that finite POST is still delivering progress or
  // its terminal tool result. Handler resolution is therefore not an HTTP
  // completion signal. Releasing admission at that point lets lifecycle drain
  // report zero active calls and close live POST responses during restart.
  // Only the terminal response (finish/close) or an actual handler failure may
  // settle the admitted request.
  const handlingFailed = handling.then(
    () => new Promise<{ readonly kind: "failed"; readonly error: unknown }>(() => undefined),
    (error: unknown) => ({ kind: "failed" as const, error }),
  );
  const settled = await Promise.race([responseSettled, handlingFailed]);
  releaseListeners();
  if (settled.kind === "failed") throw settled.error;
  if (settled.kind === "response") void handling.catch(() => undefined);
}

function attachAuthInfo(request: IncomingMessage, authInfo: AuthInfo): void {
  (request as IncomingMessage & { auth?: AuthInfo }).auth = authInfo;
}

function safeAuthorizationResponseHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "www-authenticate" || lower === "retry-after";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function singleHeader(value: string | string[] | undefined): string | undefined | null {
  return Array.isArray(value) ? (value.length === 1 ? value[0] : null) : value;
}

type ResourceContentEncoding = "br" | "gzip";

function preferredResourceContentEncoding(
  header: string | string[] | undefined,
  mimeType: string,
  byteLength: number,
): ResourceContentEncoding | undefined {
  if (byteLength < RESOURCE_COMPRESSION_MINIMUM_BYTES || !compressibleMimeType(mimeType)) {
    return undefined;
  }
  const value = singleHeader(header);
  if (value === undefined || value === null) return undefined;
  const quality = new Map<string, number>();
  for (const item of value.split(",")) {
    const [rawCoding, ...parameters] = item.trim().toLowerCase().split(";");
    if (rawCoding === undefined || rawCoding.length === 0) continue;
    let weight = 1;
    const qualityParameter = parameters.find((parameter) => parameter.trim().startsWith("q="));
    if (qualityParameter !== undefined) {
      const parsed = Number(qualityParameter.trim().slice(2));
      weight = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
    }
    quality.set(rawCoding, Math.max(quality.get(rawCoding) ?? 0, weight));
  }
  const wildcard = quality.get("*") ?? 0;
  const candidates: ReadonlyArray<readonly [ResourceContentEncoding, number]> = [
    ["br", quality.get("br") ?? wildcard],
    ["gzip", quality.get("gzip") ?? wildcard],
  ];
  return candidates
    .filter((candidate) => candidate[1] > 0)
    .sort((left, right) => right[1] - left[1])[0]?.[0];
}

function compressibleMimeType(mimeType: string): boolean {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase();
  return (
    normalized?.startsWith("text/") === true ||
    normalized === "application/json" ||
    normalized === "application/ld+json" ||
    normalized === "application/javascript" ||
    normalized === "application/xml" ||
    normalized === "image/svg+xml" ||
    normalized === "model/gltf+json" ||
    normalized?.endsWith("+json") === true ||
    normalized?.endsWith("+xml") === true
  );
}

function resourceCompressor(contentEncoding: ResourceContentEncoding) {
  if (contentEncoding === "gzip") return createGzip({ level: 6 });
  const options: BrotliOptions = {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
  };
  return createBrotliCompress(options);
}

function appendVaryHeader(response: ServerResponse, name: string): void {
  const current = response.getHeader("Vary");
  const values = (Array.isArray(current) ? current : current === undefined ? [] : [String(current)])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (!values.some((value) => value.toLowerCase() === name.toLowerCase())) values.push(name);
  response.setHeader("Vary", values.join(", "));
}

interface ResourceByteRange {
  readonly start: number;
  readonly endInclusive: number;
}

/** `undefined` means no Range header and `null` means an unsatisfiable/invalid range. */
function parseResourceByteRange(
  value: string | undefined | null,
  byteLength: number,
): ResourceByteRange | undefined | null {
  if (value === undefined) return undefined;
  if (value === null || byteLength <= 0 || value.includes(",")) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (match === null) return null;
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText.length === 0 && endText.length === 0) return null;
  if (startText.length === 0) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    const deliveredLength = Math.min(suffixLength, byteLength);
    return { start: byteLength - deliveredLength, endInclusive: byteLength - 1 };
  }
  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start < 0 || start >= byteLength) return null;
  if (endText.length === 0) return { start, endInclusive: byteLength - 1 };
  const requestedEnd = Number(endText);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null;
  return { start, endInclusive: Math.min(requestedEnd, byteLength - 1) };
}

function sendText(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(message);
}

/**
 * Writes one response frame and does not resolve until Node's writable queue is
 * ready for the next frame. Close is a normal false result; socket errors retain
 * their native error object and reject the caller.
 */
export async function writeServerResponseWithBackpressure(
  response: ServerResponse,
  chunk: string | Uint8Array,
): Promise<boolean> {
  if (response.destroyed || response.writableEnded) return false;
  const accepted = response.write(chunk);
  if (!accepted) await awaitServerResponseWritable(response);
  return !response.destroyed && !response.writableEnded;
}

function awaitServerResponseWritable(response: ServerResponse): Promise<void> {
  if (response.destroyed || response.writableEnded || !response.writableNeedDrain) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
      response.off("finish", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("finish", onClose);
    response.once("error", onError);
    if (response.destroyed || response.writableEnded || !response.writableNeedDrain) {
      cleanup();
      resolve();
    }
  });
}

function listenHttpServer(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolveStart, rejectStart) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      rejectStart(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolveStart();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * A configured loopback port can become unavailable after a Windows reboot
 * when Hyper-V/WinNAT reserves a dynamic exclusion range. Runtime ownership
 * is established before this listener starts, so falling back here cannot
 * create a second OmniCodex daemon; it only keeps the owned daemon reachable.
 */
function recoverableLoopbackBindError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === "EACCES" || code === "EADDRINUSE";
}

/** Ports Fetch must reject even when the local OS selects one for an ephemeral listener. */
function fetchBlocksPort(port: number): boolean {
  return (
    [
      1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
      103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
      512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
      995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6697, 10080,
    ].includes(port) ||
    (port >= 6665 && port <= 6669)
  );
}

function closeHttpServer(server: Server, deadlineUnixMs?: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let cancelForceClose: (() => void) | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cancelForceClose?.();
      if (error === undefined || serverAlreadyStopped(error, server)) resolve();
      else reject(error);
    };
    if (deadlineUnixMs !== undefined) {
      cancelForceClose = scheduleDeadline(deadlineUnixMs, () => {
        try {
          server.closeAllConnections();
          // server.close() already removed the listener. A caller-selected
          // hard deadline may force connections that did not drain naturally.
          finish();
        } catch (error) {
          finish(asError(error));
        }
      });
    }
    try {
      server.close((error) => finish(error));
      server.closeIdleConnections();
    } catch (error) {
      finish(asError(error));
    }
  });
}

function shutdownDrainDeadline(deadlineUnixMs: number, hardTimeoutMs: number): number {
  const cleanupReserveMs = Math.min(5_000, Math.max(25, Math.floor(hardTimeoutMs / 5)));
  return Math.max(Date.now(), deadlineUnixMs - cleanupReserveMs);
}

function serverAlreadyStopped(error: Error, server: Server): boolean {
  return (
    !server.listening &&
    (error as Error & { readonly code?: string }).code === "ERR_SERVER_NOT_RUNNING"
  );
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function settleBeforeDeadline<T>(
  promise: Promise<T>,
  deadlineUnixMs?: number,
): Promise<{ readonly settled: true; readonly value: T } | { readonly settled: false }> {
  if (deadlineUnixMs === undefined) {
    return promise.then((value) => ({ settled: true as const, value }));
  }
  return new Promise((resolveSettlement, rejectSettlement) => {
    let settled = false;
    let cancelDeadline = (): void => undefined;
    const finish = (
      result: { readonly settled: true; readonly value: T } | { readonly settled: false },
    ) => {
      if (settled) return;
      settled = true;
      cancelDeadline();
      resolveSettlement(result);
    };
    void promise.then(
      (value) => finish({ settled: true, value }),
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cancelDeadline();
        rejectSettlement(error);
      },
    );
    cancelDeadline = scheduleDeadline(deadlineUnixMs, () => finish({ settled: false }));
  });
}

function deadlineAfter(timeoutMs: number, name: string): number {
  const nowUnixMs = Date.now();
  if (timeoutMs > Number.MAX_SAFE_INTEGER - nowUnixMs) {
    throw new RangeError(`${name} is too large to represent safely`);
  }
  return nowUnixMs + timeoutMs;
}

/**
 * Node clamps a setTimeout longer than 2^31-1 milliseconds to one millisecond.
 * Re-arming frames preserves the caller's exact absolute deadline instead.
 */
function scheduleDeadline(deadlineUnixMs: number, callback: () => void): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    if (cancelled) return;
    const remainingMs = deadlineUnixMs - Date.now();
    if (remainingMs <= 0) {
      queueMicrotask(() => {
        if (!cancelled) callback();
      });
      return;
    }
    timer = setTimeout(arm, Math.min(remainingMs, MAX_NODE_TIMER_DELAY_MS));
    timer.unref?.();
  };
  arm();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function onceAsync(close: (() => Promise<void> | void) | undefined): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    if (closing !== undefined) return closing;
    if (close === undefined) {
      closing = Promise.resolve();
      return closing;
    }
    // Invoke the retirement boundary synchronously so a gateway stop starts
    // every owned executor close in the same shutdown turn. Only completion is
    // asynchronous. Deferring invocation through Promise.then leaves a window
    // where the listener is closed but no child retirement has begun.
    let attempt: Promise<void>;
    try {
      attempt = Promise.resolve(close());
    } catch (error) {
      attempt = Promise.reject(error);
    }
    const current = attempt.catch((error: unknown) => {
      // An executor that failed to retire is still owned and must remain
      // retryable. Successful and in-flight closes remain single-flight.
      if (closing === current) closing = undefined;
      throw error;
    });
    closing = current;
    return current;
  };
}

function invokeClose(close: () => Promise<void> | void): Promise<void> {
  try {
    return Promise.resolve(close());
  } catch (error) {
    return Promise.reject(error);
  }
}

async function waitForResponseHeadersOrCompletion(
  response: ServerResponse,
  handling: Promise<void>,
): Promise<void> {
  let settled = false;
  void handling.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!settled && !response.headersSent && !response.destroyed && !response.writableEnded) {
    await nextEventLoopTurn();
  }
}

function isStandaloneSseResponse(response: ServerResponse): boolean {
  const contentType = response.getHeader("Content-Type");
  return (
    response.statusCode === 200 &&
    typeof contentType === "string" &&
    contentType.toLowerCase().includes("text/event-stream") &&
    !response.destroyed &&
    !response.writableEnded
  );
}

function isRejectedDurableReplaySession(error: unknown): boolean {
  return (
    error instanceof DurableMcpEventSessionNotFoundError ||
    error instanceof DurableMcpEventSessionExpiredError ||
    error instanceof DurableMcpEventSessionBindingError ||
    error instanceof DurableMcpEventSessionAmbiguousError
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
