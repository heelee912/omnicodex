import { createHash } from "node:crypto";
import { assertExplicitLoopbackCdpEndpoint } from "./chatgpt-app-approval-adapter.js";

const CHATGPT_ORIGIN = "https://chatgpt.com";
const CONNECTOR_SETTINGS_SKU = "CONNECTOR_SETTING";
const BROWSER_COMMAND_LIVENESS_MS = 30_000;

/** HTTP failure without response bodies, cookies or access tokens. */
export class ChatGptControlPlaneHttpError extends Error {
  readonly status: number;
  readonly operation: string;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly retryAtUnixMs?: number;

  constructor(operation: string, response: Response, now = Date.now()) {
    super(`${operation}:${response.status}`);
    this.name = "ChatGptControlPlaneHttpError";
    this.status = response.status;
    this.operation = operation;
    const headers: Record<string, string> = {};
    for (const name of [
      "retry-after",
      "x-request-id",
      "x-ratelimit-limit-requests",
      "x-ratelimit-remaining-requests",
      "x-ratelimit-reset-requests",
      "x-ratelimit-limit-tokens",
      "x-ratelimit-remaining-tokens",
      "x-ratelimit-reset-tokens",
    ]) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    this.responseHeaders = headers;
    const retryAfter = headers["retry-after"]?.trim();
    if (retryAfter !== undefined && retryAfter !== "") {
      const deadline = /^\d+(?:\.\d+)?$/u.test(retryAfter)
        ? now + Math.ceil(Number(retryAfter) * 1_000)
        : Date.parse(retryAfter);
      if (Number.isSafeInteger(deadline) && deadline >= 0) {
        this.retryAtUnixMs = Math.max(now, deadline);
      }
    }
  }
}

async function requireSuccessfulResponse(response: Response, operation: string): Promise<void> {
  if (response.ok) return;
  const error = new ChatGptControlPlaneHttpError(operation, response);
  await response.body?.cancel().catch(() => undefined);
  throw error;
}

export interface ChatGptControlPlaneSchemaReadback {
  readonly toolName: string;
  readonly inputProperties: readonly string[];
  readonly requiredInputProperties: readonly string[];
}

export interface ChatGptActionCatalogReadback {
  readonly linkId: string;
  readonly actionCount: number;
  readonly actionNames: readonly string[];
  readonly actionNamesSha256: string;
  readonly actionSchemas: readonly ChatGptControlPlaneSchemaReadback[];
  readonly actionMetadata?: readonly {
    readonly toolName: string;
    readonly isReadOnly?: boolean;
    readonly isDestructive?: boolean;
    readonly isOpenWorld?: boolean;
    readonly isConsequential?: boolean;
  }[];
}

export interface ChatGptActionCatalogControlReceipt extends ChatGptActionCatalogReadback {
  /** Hash-only receipt for the completed refresh response; no credential is retained. */
  readonly refreshReceiptSha256: string;
}

interface BrowserAuthMaterial {
  readonly cookieHeader: string;
  readonly userAgent: string;
}

export interface ChatGptActionCatalogControlClientOptions {
  readonly cdpEndpoint: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Injectable only so the credential boundary can be tested without a real browser. */
  readonly readBrowserAuth?: (signal?: AbortSignal) => Promise<BrowserAuthMaterial>;
}

/**
 * Refreshes the installed ChatGPT app action catalog through the same
 * authenticated control-plane contract as the official settings UI. It reads
 * browser credentials only in memory, never creates a page target, and returns
 * a credential-free authoritative readback.
 */
export class ChatGptActionCatalogControlClient {
  readonly #endpoint: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #readBrowserAuth: (signal?: AbortSignal) => Promise<BrowserAuthMaterial>;

  constructor(options: ChatGptActionCatalogControlClientOptions) {
    this.#endpoint = assertExplicitLoopbackCdpEndpoint(options.cdpEndpoint);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#readBrowserAuth =
      options.readBrowserAuth ??
      ((signal) => readBrowserAuthFromCdp(this.#endpoint, this.#fetch, signal));
  }

  async refresh(
    connectorId: string,
    criticalActionNames: readonly string[],
    signal?: AbortSignal,
  ): Promise<ChatGptActionCatalogControlReceipt> {
    const result = await this.#read(connectorId, criticalActionNames, true, signal);
    if (result.refreshReceiptSha256 === undefined)
      throw new Error("CHATGPT_ACTION_REFRESH_RECEIPT_MISSING");
    return { ...result, refreshReceiptSha256: result.refreshReceiptSha256 };
  }

  /** Read the installed snapshot without refreshing actions or changing the link. */
  async inspect(
    connectorId: string,
    criticalActionNames: readonly string[],
    signal?: AbortSignal,
  ): Promise<ChatGptActionCatalogReadback> {
    return this.#read(connectorId, criticalActionNames, false, signal);
  }

  async #read(
    connectorId: string,
    criticalActionNames: readonly string[],
    refresh: boolean,
    signal?: AbortSignal,
  ): Promise<ChatGptActionCatalogReadback & { readonly refreshReceiptSha256?: string }> {
    if (!/^asdk_app_[a-z0-9]+$/iu.test(connectorId)) {
      throw new Error("CHATGPT_CONNECTOR_ID_INVALID");
    }
    const criticalNames = canonicalNames(criticalActionNames);
    const browserAuth = await this.#readBrowserAuth(signal);
    if (browserAuth.cookieHeader.trim() === "" || browserAuth.userAgent.trim() === "") {
      throw new Error("CHATGPT_BROWSER_AUTH_MATERIAL_UNAVAILABLE");
    }

    const sessionResponse = await this.#fetch(`${CHATGPT_ORIGIN}/api/auth/session`, {
      headers: {
        Cookie: browserAuth.cookieHeader,
        "User-Agent": browserAuth.userAgent,
      },
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
    await requireSuccessfulResponse(sessionResponse, "CHATGPT_BROWSER_SESSION_UNAVAILABLE");
    const session = await readJsonRecord(sessionResponse, "CHATGPT_SESSION_RESPONSE_INVALID");
    const accessToken = typeof session.accessToken === "string" ? session.accessToken : undefined;
    const accountId = chatGptAccountId(session);
    if (accessToken === undefined || accessToken === "" || accountId === undefined) {
      throw new Error(`CHATGPT_BROWSER_SESSION_UNAVAILABLE:${sessionResponse.status}`);
    }

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-Id": accountId,
      "OAI-Product-Sku": CONNECTOR_SETTINGS_SKU,
      "User-Agent": browserAuth.userAgent,
      Origin: CHATGPT_ORIGIN,
      Referer: `${CHATGPT_ORIGIN}/plugins`,
    };
    const linksPath = "/backend-api/aip/connectors/links/list_accessible";
    const linksResponse = await this.#fetch(`${CHATGPT_ORIGIN}${linksPath}`, {
      method: "POST",
      headers: controlPlaneHeaders(headers, linksPath, true),
      body: JSON.stringify({ principals: [], link_refresh_strategy: "NONE" }),
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
    await requireSuccessfulResponse(linksResponse, "CHATGPT_ACCESSIBLE_LINKS_FAILED");
    const linksPayload = await readJsonRecord(
      linksResponse,
      "CHATGPT_ACCESSIBLE_LINKS_RESPONSE_INVALID",
    );
    const matchingLinks = arrayValue(linksPayload.links).filter(
      (link): link is Record<string, unknown> =>
        isRecord(link) && link.connector_id === connectorId && typeof link.id === "string",
    );
    if (matchingLinks.length !== 1) {
      throw new Error(`CHATGPT_CONNECTOR_LINK_MISSING_OR_AMBIGUOUS:${matchingLinks.length}`);
    }
    const linkId = matchingLinks[0]?.id;
    if (typeof linkId !== "string" || linkId === "") {
      throw new Error("CHATGPT_CONNECTOR_LINK_INVALID");
    }

    let refreshReceiptSha256: string | undefined;
    if (refresh) {
      const refreshPath = "/backend-api/aip/connectors/mcp/refresh_actions";
      const refreshResponse = await this.#fetch(`${CHATGPT_ORIGIN}${refreshPath}`, {
        method: "POST",
        headers: controlPlaneHeaders(headers, refreshPath, true),
        body: JSON.stringify({ link_id: linkId }),
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      });
      await requireSuccessfulResponse(refreshResponse, "CHATGPT_ACTION_REFRESH_FAILED");
      const refreshText = await refreshResponse.text();
      refreshReceiptSha256 = createHash("sha256")
        .update(`${refreshResponse.status}\0${refreshText}`, "utf8")
        .digest("hex");
    }

    const actionsPath = `/backend-api/aip/connectors/${encodeURIComponent(connectorId)}/actions`;
    const actionsResponse = await this.#fetch(`${CHATGPT_ORIGIN}${actionsPath}`, {
      headers: controlPlaneHeaders(headers, actionsPath),
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
    await requireSuccessfulResponse(actionsResponse, "CHATGPT_ACTION_CATALOG_READBACK_FAILED");
    const actionsPayload = await readJsonRecord(
      actionsResponse,
      "CHATGPT_ACTION_CATALOG_RESPONSE_INVALID",
    );
    const actionRecords = arrayValue(actionsPayload.actions).filter(isRecord);
    const names = actionRecords.map((action) => action.name).filter(isNonEmptyString);
    const actionNames = canonicalNames(names);
    if (actionRecords.length < 1 || actionNames.length !== actionRecords.length) {
      throw new Error("CHATGPT_ACTION_CATALOG_NAMES_INVALID_OR_DUPLICATED");
    }
    const actionSchemas = criticalNames.map((toolName) => {
      const matches = actionRecords.filter((action) => action.name === toolName);
      if (matches.length !== 1) {
        throw new Error(`CHATGPT_CRITICAL_ACTION_MISSING_OR_AMBIGUOUS:${toolName}`);
      }
      const schema = readInputSchema(matches[0]);
      if (schema === undefined) {
        throw new Error(`CHATGPT_CRITICAL_ACTION_SCHEMA_INVALID:${toolName}`);
      }
      return { toolName, ...schema };
    });

    return {
      linkId,
      actionCount: actionNames.length,
      actionNames,
      actionNamesSha256: sha256Json(actionNames),
      actionSchemas,
      actionMetadata: criticalNames.map((toolName) => {
        const action = actionRecords.find((candidate) => candidate.name === toolName);
        return {
          toolName,
          ...(typeof action?.is_read_only === "boolean" ? { isReadOnly: action.is_read_only } : {}),
          ...(typeof action?.is_destructive === "boolean"
            ? { isDestructive: action.is_destructive }
            : {}),
          ...(typeof action?.is_open_world === "boolean"
            ? { isOpenWorld: action.is_open_world }
            : {}),
          ...(typeof action?.is_consequential === "boolean"
            ? { isConsequential: action.is_consequential }
            : {}),
        };
      }),
      ...(refreshReceiptSha256 === undefined ? {} : { refreshReceiptSha256 }),
    };
  }
}

function controlPlaneHeaders(
  baseHeaders: Readonly<Record<string, string>>,
  path: string,
  contentType = false,
): Record<string, string> {
  return {
    ...baseHeaders,
    ...(contentType ? { "Content-Type": "application/json" } : {}),
    "X-OpenAI-Target-Path": path,
    "X-OpenAI-Target-Route": path,
  };
}

async function readBrowserAuthFromCdp(
  endpoint: URL,
  fetch: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<BrowserAuthMaterial> {
  let versionResponse: Response;
  try {
    versionResponse = await fetch(new URL("/json/version", endpoint), {
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted === true) throw error;
    throw new Error("CDP_BROWSER_VERSION_UNAVAILABLE", { cause: error });
  }
  const version = await readJsonRecord(versionResponse, "CDP_BROWSER_VERSION_INVALID");
  const browser = version.Browser;
  const userAgent = version["User-Agent"];
  const webSocketDebuggerUrl = version.webSocketDebuggerUrl;
  if (
    !versionResponse.ok ||
    typeof browser !== "string" ||
    !browser.includes("Chrome") ||
    typeof userAgent !== "string" ||
    typeof webSocketDebuggerUrl !== "string"
  ) {
    throw new Error("CDP_BROWSER_VERSION_INVALID");
  }
  const cookies = await readBrowserCookies(webSocketDebuggerUrl, signal);
  const chatGptCookies = cookies.filter((cookie) => {
    const domain = typeof cookie.domain === "string" ? cookie.domain.toLocaleLowerCase() : "";
    return domain === "chatgpt.com" || domain.endsWith(".chatgpt.com");
  });
  const cookieHeader = chatGptCookies
    .filter((cookie) => typeof cookie.name === "string" && typeof cookie.value === "string")
    .map((cookie) => `${cookie.name as string}=${cookie.value as string}`)
    .join("; ");
  if (cookieHeader === "") throw new Error("CHATGPT_BROWSER_COOKIES_UNAVAILABLE");
  return { cookieHeader, userAgent };
}

async function readBrowserCookies(
  webSocketDebuggerUrl: string,
  signal?: AbortSignal,
): Promise<readonly Record<string, unknown>[]> {
  const socket = new WebSocket(webSocketDebuggerUrl);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await new Promise<unknown>((resolve, reject) => {
    let opened = false;
    const finish = (action: () => void) => {
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => finish(() => reject(signal?.reason ?? new Error("CDP cancelled")));
    timeout = setTimeout(
      () => finish(() => reject(new Error("CDP_BROWSER_COMMAND_LIVENESS_TIMEOUT"))),
      BROWSER_COMMAND_LIVENESS_MS,
    );
    socket.addEventListener(
      "open",
      () => {
        opened = true;
        socket.send(JSON.stringify({ id: 1, method: "Storage.getCookies", params: {} }));
      },
      { once: true },
    );
    socket.addEventListener("message", (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        finish(() => reject(new Error("CDP_BROWSER_RESPONSE_INVALID")));
        return;
      }
      if (!isRecord(message) || message.id !== 1) return;
      if (isRecord(message.error)) {
        finish(() => reject(new Error("CDP_BROWSER_COOKIE_READ_FAILED")));
        return;
      }
      finish(() => resolve(message.result));
    });
    socket.addEventListener(
      "error",
      () =>
        finish(() =>
          reject(new Error(opened ? "CDP_BROWSER_SESSION_ERROR" : "CDP_BROWSER_OPEN_FAILED")),
        ),
      { once: true },
    );
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  }).finally(() => socket.close(1000, "complete"));
  if (!isRecord(result)) throw new Error("CDP_BROWSER_COOKIE_RESPONSE_INVALID");
  return arrayValue(result.cookies).filter(isRecord);
}

function chatGptAccountId(session: Record<string, unknown>): string | undefined {
  for (const owner of [session.account, session.user]) {
    if (!isRecord(owner)) continue;
    for (const key of ["id", "account_id"]) {
      const value = owner[key];
      if (isNonEmptyString(value)) return value;
    }
  }
  return undefined;
}

function readInputSchema(
  action: Record<string, unknown> | undefined,
): Omit<ChatGptControlPlaneSchemaReadback, "toolName"> | undefined {
  if (action === undefined) return undefined;
  const functionRecord = isRecord(action.function) ? action.function : undefined;
  const candidates = [
    action.input_schema,
    action.inputSchema,
    action.input_schema_json,
    action.params,
    action.parameters,
    action.schema,
    action.tool_schema,
    functionRecord?.parameters,
  ].map(decodeSchemaCandidate);
  const schema = candidates.find(
    (candidate) => isRecord(candidate) && isRecord(candidate.properties),
  );
  if (!isRecord(schema) || !isRecord(schema.properties)) return undefined;
  const required = arrayValue(schema.required).filter(isNonEmptyString);
  return {
    inputProperties: canonicalNames(Object.keys(schema.properties)),
    requiredInputProperties: canonicalNames(required),
  };
}

function decodeSchemaCandidate(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const decoded: unknown = JSON.parse(value);
    if (!isRecord(decoded)) return decoded;
    return decoded.inputSchema ?? decoded.input_schema ?? decoded.parameters ?? decoded;
  } catch {
    return undefined;
  }
}

async function readJsonRecord(
  response: Response,
  errorCode: string,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(errorCode);
  }
  if (!isRecord(value)) throw new Error(errorCode);
  return value;
}

function canonicalNames(names: readonly string[]): readonly string[] {
  return [...new Set(names)].sort((left, right) => left.localeCompare(right, "en"));
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
