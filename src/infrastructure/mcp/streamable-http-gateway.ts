import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppServerMethodCatalog } from "../../application/app-server-method-catalog.js";
import type { CodexHostToolAdapter } from "../../application/codex-host-tool-adapter.js";
import type { AppServerRpcClient } from "../../application/native-tool-catalog.js";
import type {
  ResponsesNativeToolCatalog,
  ResponsesNativeToolExecutor,
} from "../../application/responses-native-tool-catalog.js";
import { createOmniCodexMcpServer, type OmniCodexMcpServerHandle } from "./omnicodex-mcp-server.js";
import {
  authorizationBinding,
  OwnerBoundResourceStore,
  validOpaqueResourceId,
} from "./owner-bound-resource-store.js";
import { protectOversizedResult } from "./protected-result-mapper.js";

// Keep this explicit and aligned with the stable versions supported by the
// pinned MCP SDK. The newest stable version is preferred by modern clients;
// older versions remain available through normal initialize negotiation.
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;
const DEFAULT_MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const RESOURCE_PATH_PREFIX = "/resources/";
const ALLOWED_CORS_HEADERS = new Set([
  "authorization",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
]);

export interface HttpAuthorizationIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly clientId: string;
  readonly resource: string;
}

export interface HttpAuthorizationDecision {
  readonly ok: boolean;
  readonly authInfo?: AuthInfo;
  readonly identity?: HttpAuthorizationIdentity;
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly message?: string;
}

export interface StreamableHttpGatewayOptions {
  readonly appServer: AppServerRpcClient;
  readonly appServerMethodCatalog?: AppServerMethodCatalog;
  readonly responsesToolCatalog?: ResponsesNativeToolCatalog;
  readonly responsesToolExecutor?: ResponsesNativeToolExecutor;
  readonly hostToolAdapter?: CodexHostToolAdapter;
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  readonly fullPath?: string;
  readonly authorize: (
    request: IncomingMessage,
  ) => Promise<HttpAuthorizationDecision> | HttpAuthorizationDecision;
  readonly allowedOrigins?: readonly string[];
  readonly allowedHosts?: readonly string[];
  readonly protectedResourceMetadata?: Record<string, unknown>;
  readonly resourceStore?: OwnerBoundResourceStore;
  readonly maxRequestBodyBytes?: number;
}

export interface StreamableHttpGatewayAddress {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly fullPath: string;
}

interface Session {
  readonly transport: StreamableHTTPServerTransport;
  readonly mcp: OmniCodexMcpServerHandle;
  readonly surface: "compat" | "full";
  readonly authorizationBinding: string;
}

interface NormalizedOptions extends StreamableHttpGatewayOptions {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly fullPath: string;
  readonly allowedOrigins: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly maxRequestBodyBytes: number;
}

/**
 * Loopback-bound Streamable HTTP MCP gateway. Authentication completes before
 * session lookup and the tunnel remains a separate process boundary.
 */
export class StreamableHttpGateway {
  readonly #options: NormalizedOptions;
  readonly #metadata: Record<string, unknown> | undefined;
  readonly #resourceStore: OwnerBoundResourceStore;
  readonly #sessions = new Map<string, Session>();
  #server: Server | undefined;
  #address: StreamableHttpGatewayAddress | undefined;

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
    const maxRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
    if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes <= 0) {
      throw new Error("MCP request body limit must be a positive integer");
    }
    const allowedOrigins = (options.allowedOrigins ?? []).map(exactOrigin);
    if (allowedOrigins.includes("*")) throw new Error("Wildcard CORS origins are forbidden");
    this.#metadata = normalizeProtectedResourceMetadata(options.protectedResourceMetadata);
    this.#options = {
      ...options,
      host,
      port: options.port ?? 0,
      path,
      fullPath,
      allowedOrigins,
      allowedHosts: (options.allowedHosts ?? []).map(exactHost),
      maxRequestBodyBytes,
    };
    this.#resourceStore = options.resourceStore ?? new OwnerBoundResourceStore();
  }

  get address(): StreamableHttpGatewayAddress | undefined {
    return this.#address;
  }

  async start(): Promise<StreamableHttpGatewayAddress> {
    if (this.#server !== undefined) return this.#address as StreamableHttpGatewayAddress;
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch(() => {
        if (response.writableEnded) return;
        response.statusCode = 500;
        response.end("Internal Server Error");
      });
    });
    this.#server = server;
    await new Promise<void>((resolveStart, rejectStart) => {
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
      server.listen(this.#options.port, this.#options.host);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      await this.stop();
      throw new Error("OmniCodex MCP gateway did not receive a TCP address");
    }
    this.#address = {
      host: this.#options.host,
      port: address.port,
      path: this.#options.path,
      fullPath: this.#options.fullPath,
    };
    return this.#address;
  }

  async stop(): Promise<void> {
    for (const [sessionId, session] of this.#sessions) {
      this.#sessions.delete(sessionId);
      this.#resourceStore.deleteSession(sessionId);
      await session.mcp.server.close().catch(() => undefined);
      await session.transport.close().catch(() => undefined);
    }
    this.#resourceStore.clear();
    const server = this.#server;
    this.#server = undefined;
    this.#address = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolveStop) => server.close(() => resolveStop()));
    }
  }

  async refreshTools(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((session) => session.mcp.refresh()));
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
      this.#serveMetadata(request, response);
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
      this.#sendAuthorizationFailure(response, authorization, surface);
      return;
    }
    if (authorization.identity === undefined || authorization.authInfo === undefined) {
      sendText(response, 500, "Authorization identity unavailable");
      return;
    }

    if (resourceId !== undefined) {
      this.#serveResource(request, response, resourceId, authorization.identity);
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
    if (!isMcpMethod(request.method)) {
      response.setHeader("Allow", "GET, POST, DELETE");
      sendText(response, 405, "Method Not Allowed");
      return;
    }
    if (!validProtocolHeader(request)) {
      sendProtocolError(response, null, "Unsupported MCP protocol version");
      return;
    }
    const admission = validateHttpAdmission(request);
    if (admission !== undefined) {
      sendText(response, admission.status, admission.message);
      return;
    }

    let parsedBody: unknown;
    if (request.method === "POST") {
      const parsed = await readJsonBody(request, this.#options.maxRequestBodyBytes);
      if (!parsed.ok) {
        if (parsed.status === 400) sendProtocolError(response, null, parsed.message);
        else sendText(response, parsed.status, parsed.message);
        return;
      }
      parsedBody = parsed.value;
      const initialization = initializationVersion(parsed.value);
      if (
        initialization !== undefined &&
        !SUPPORTED_PROTOCOL_VERSIONS.some((version) => version === initialization)
      ) {
        sendProtocolError(response, requestId(parsed.value), "Unsupported MCP protocol version");
        return;
      }
    }

    const identityBinding = authorizationBinding(authorization.identity);
    const sessionId = headerValue(request.headers["mcp-session-id"]);
    let session = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
    if (session !== undefined && session.authorizationBinding !== identityBinding) {
      sendText(response, 404, "Session invalid");
      return;
    }
    if (session !== undefined && session.surface !== surface) {
      sendText(response, 404, "Session invalid");
      return;
    }
    if (session === undefined && (request.method !== "POST" || sessionId !== undefined)) {
      sendText(response, 404, "Session invalid");
      return;
    }

    attachAuthInfo(request, authorization.authInfo);
    if (session === undefined) {
      session = await this.#newSession(surface, authorization.identity);
      await session.transport.handleRequest(request, response, parsedBody);
      if (session.transport.sessionId === undefined && response.writableEnded) {
        await session.mcp.server.close().catch(() => undefined);
        await session.transport.close().catch(() => undefined);
      }
      return;
    }
    await session.transport.handleRequest(request, response, parsedBody);
  }

  async #newSession(
    surface: "compat" | "full",
    identity: HttpAuthorizationIdentity,
  ): Promise<Session> {
    let session: Session;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomBytes(32).toString("base64url"),
      enableJsonResponse: false,
      onsessioninitialized: (id) => {
        this.#sessions.set(id, session);
      },
      onsessionclosed: (id) => {
        this.#sessions.delete(id);
        this.#resourceStore.deleteSession(id);
      },
    });
    const mcp = createOmniCodexMcpServer({
      appServer: this.#options.appServer,
      ...(this.#options.appServerMethodCatalog === undefined
        ? {}
        : { appServerMethodCatalog: this.#options.appServerMethodCatalog }),
      ...(this.#options.responsesToolCatalog === undefined
        ? {}
        : { responsesToolCatalog: this.#options.responsesToolCatalog }),
      ...(this.#options.responsesToolExecutor === undefined
        ? {}
        : { responsesToolExecutor: this.#options.responsesToolExecutor }),
      ...(this.#options.hostToolAdapter === undefined
        ? {}
        : { hostToolAdapter: this.#options.hostToolAdapter }),
      protectResult: (result, context) => this.#protectResult(result, context.sessionId, identity),
      surface,
    });
    session = {
      transport,
      mcp,
      surface,
      authorizationBinding: authorizationBinding(identity),
    };
    transport.onerror = (error) => {
      mcp.server.onerror?.(error);
    };
    await mcp.server.connect(transport as unknown as Parameters<typeof mcp.server.connect>[0]);
    return session;
  }

  #protectResult(
    result: CallToolResult,
    sessionId: string | undefined,
    identity: HttpAuthorizationIdentity,
  ): CallToolResult {
    const publicOrigin = metadataOrigin(this.#metadata);
    if (sessionId === undefined || publicOrigin === undefined) return result;
    return protectOversizedResult(
      result,
      { owner: identity, sessionId, publicOrigin: publicOrigin.origin },
      this.#resourceStore,
    );
  }

  #serveResource(
    request: IncomingMessage,
    response: ServerResponse,
    resourceId: string,
    identity: HttpAuthorizationIdentity,
  ): void {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      sendText(response, 405, "Method Not Allowed");
      return;
    }
    const sessionId = headerValue(request.headers["mcp-session-id"]);
    const session = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
    if (
      sessionId === undefined ||
      session === undefined ||
      session.authorizationBinding !== authorizationBinding(identity)
    ) {
      sendText(response, 404, "Resource unavailable");
      return;
    }
    const resource = this.#resourceStore.get(resourceId, identity, sessionId);
    if (resource === undefined) {
      sendText(response, 404, "Resource unavailable");
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", resource.mimeType);
    response.setHeader("Content-Length", String(resource.bytes.byteLength));
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("ETag", `"sha256-${resource.digest}"`);
    response.end(resource.bytes);
  }

  #serveMetadata(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      sendText(response, 405, "Method Not Allowed");
      return;
    }
    if (this.#metadata === undefined) {
      sendText(response, 404, "Not Found");
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "public, max-age=300");
    response.end(JSON.stringify(this.#metadata));
  }

  async #authorize(request: IncomingMessage): Promise<HttpAuthorizationDecision> {
    try {
      return await this.#options.authorize(request);
    } catch {
      return { ok: false, status: 401, message: "Unauthorized" };
    }
  }

  #sendAuthorizationFailure(
    response: ServerResponse,
    authorization: HttpAuthorizationDecision,
    surface: "compat" | "full" | undefined,
  ): void {
    response.statusCode = authorization.status ?? 401;
    for (const [name, value] of Object.entries(authorization.headers ?? {})) {
      if (safeAuthorizationResponseHeader(name)) response.setHeader(name, value);
    }
    const resourceMetadata = this.#resourceMetadataUrl(surface);
    if (resourceMetadata !== undefined && response.statusCode === 401) {
      const existing = response.getHeader("WWW-Authenticate");
      const challenge = typeof existing === "string" && existing.length > 0 ? existing : "Bearer";
      if (!challenge.includes("resource_metadata=")) {
        response.setHeader(
          "WWW-Authenticate",
          `${challenge}, resource_metadata="${resourceMetadata}"`,
        );
      }
    }
    response.end("Unauthorized");
  }

  #resourceMetadataUrl(surface: "compat" | "full" | undefined): string | undefined {
    const origin = metadataOrigin(this.#metadata);
    if (origin === undefined) return undefined;
    const endpoint =
      surface === "full" ? this.#options.fullPath : surface === "compat" ? this.#options.path : "";
    return new URL(`/.well-known/oauth-protected-resource${endpoint}`, origin).href;
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
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID",
    );
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
    const metadataHost = metadataOrigin(this.#metadata)?.host;
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
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: 400 | 413; readonly message: string };

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<JsonBodyResult> {
  const contentLength = headerValue(request.headers["content-length"]);
  if (contentLength !== undefined && /^\d+$/.test(contentLength)) {
    const statedLength = Number(contentLength);
    if (!Number.isSafeInteger(statedLength) || statedLength > maxBytes) {
      request.resume();
      return { ok: false, status: 413, message: "Payload Too Large" };
    }
  }
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    byteLength += bytes.byteLength;
    if (byteLength > maxBytes) {
      request.resume();
      return { ok: false, status: 413, message: "Payload Too Large" };
    }
    chunks.push(bytes);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks, byteLength).toString("utf8")) };
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

function requestId(value: unknown): string | number | null {
  if (!isObject(value)) return null;
  return typeof value.id === "string" || typeof value.id === "number" ? value.id : null;
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
        data: { supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS] },
      },
    }),
  );
}

function validProtocolHeader(request: IncomingMessage): boolean {
  const version = singleHeader(request.headers["mcp-protocol-version"]);
  return (
    version !== null &&
    (version === undefined ||
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
  exactAuthorizationServer(metadata.authorization_servers[0]);
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
    authorization_servers: [...metadata.authorization_servers],
    scopes_supported: [...metadata.scopes_supported],
    bearer_methods_supported: ["header"],
  };
}

function exactAuthorizationServer(value: string): void {
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
}

function metadataOrigin(metadata: Record<string, unknown> | undefined): URL | undefined {
  return typeof metadata?.resource === "string" ? new URL(metadata.resource) : undefined;
}

function isMetadataPath(path: string, mcpPath: string, fullPath: string): boolean {
  return (
    path === "/.well-known/oauth-protected-resource" ||
    path === protectedResourceMetadataPath(mcpPath) ||
    path === protectedResourceMetadataPath(fullPath)
  );
}

function protectedResourceMetadataPath(mcpPath: string): string {
  return `/.well-known/oauth-protected-resource${mcpPath}`;
}

function resourceIdFromPath(path: string): string | undefined {
  if (!path.startsWith(RESOURCE_PATH_PREFIX)) return undefined;
  const id = path.slice(RESOURCE_PATH_PREFIX.length);
  return validOpaqueResourceId(id) ? id : undefined;
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

function sendText(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
