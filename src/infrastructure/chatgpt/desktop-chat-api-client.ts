import { createHash } from "node:crypto";

type NativeRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export interface DesktopChatPrincipal {
  readonly accountId: string;
  readonly userId: string;
}

/** Uses the same getAuthStatus contract as the installed desktop fetch client. */
export class DesktopChatApiClient {
  constructor(
    private readonly request: NativeRequest,
    private readonly fetchRequest: typeof fetch = fetch,
  ) {}

  /** Reads only principal metadata through the native auth contract; no HTTP request or token export. */
  async readPrincipal(signal: AbortSignal): Promise<DesktopChatPrincipal> {
    const auth = await this.#authentication(signal);
    return desktopChatPrincipal(auth.authToken);
  }

  async #authentication(signal: AbortSignal): Promise<{ authToken: string }> {
    signal.throwIfAborted();
    const authentication = await this.request("getAuthStatus", {
      includeToken: true,
      refreshToken: false,
    });
    signal.throwIfAborted();
    const auth = record(authentication);
    if (
      (auth?.authMethod !== "chatgpt" && auth?.authMethod !== "chatgptAuthTokens") ||
      typeof auth.authToken !== "string"
    )
      throw new Error("DESKTOP_CHAT_AUTH_UNAVAILABLE");
    return { authToken: auth.authToken };
  }

  async userEventEndpoint(signal: AbortSignal): Promise<{
    principal: DesktopChatPrincipal;
    websocketUrl: string;
  }> {
    const auth = await this.#authentication(signal);
    const principal = desktopChatPrincipal(auth.authToken);
    const response = await this.fetchRequest("https://chatgpt.com/backend-api/celsius/ws/user", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${auth.authToken}`,
        "ChatGPT-Account-ID": principal.accountId,
      },
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      const contentType = response.headers.get("content-type");
      const diagnostic: Record<string, unknown> = {
        contentType,
        mitigation: response.headers.get("cf-mitigated"),
        server: response.headers.get("server"),
      };
      if (contentType?.includes("application/json")) {
        const body = record(await response.json());
        const error = record(body?.error);
        diagnostic.code = error?.code ?? body?.code;
        diagnostic.message =
          typeof error?.message === "string"
            ? error.message.slice(0, 500)
            : typeof body?.detail === "string"
              ? body.detail.slice(0, 500)
              : undefined;
      }
      throw new Error(
        `DESKTOP_CHAT_EVENT_ENDPOINT_HTTP_${response.status}:${JSON.stringify(diagnostic)}`,
      );
    }
    const payload = record(await response.json());
    if (typeof payload?.websocket_url !== "string")
      throw new Error("DESKTOP_CHAT_EVENT_ENDPOINT_INVALID");
    const url = new URL(payload.websocket_url);
    if (
      url.protocol !== "wss:" ||
      url.username ||
      url.password ||
      !["chatgpt.com", "openai.com"].some(
        (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
      )
    )
      throw new Error("DESKTOP_CHAT_EVENT_ORIGIN_INVALID");
    return { principal, websocketUrl: url.href };
  }
}

export function desktopChatPrincipal(token: string): DesktopChatPrincipal {
  try {
    const encoded = token.split(".")[1];
    if (!encoded) throw new Error("missing claims");
    const payload = record(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    const auth = record(payload?.["https://api.openai.com/auth"]);
    const accountId = auth?.chatgpt_account_id ?? auth?.account_id;
    const userId = auth?.user_id ?? auth?.chatgpt_user_id;
    if (typeof accountId !== "string" || !accountId || typeof userId !== "string" || !userId)
      throw new Error("missing principal");
    return { accountId, userId };
  } catch {
    throw new Error("DESKTOP_CHAT_AUTH_PRINCIPAL_INVALID");
  }
}

export interface DesktopChatEventConnectionStatus {
  readonly accountScopeSha256: string;
  readonly subscribedTopics: readonly string[];
}

/** Checks the real subscription acknowledgements, returning no bearer or socket URL. */
export async function inspectDesktopChatEventConnection(
  client: DesktopChatApiClient,
  signal: AbortSignal,
): Promise<DesktopChatEventConnectionStatus> {
  const { principal, websocketUrl } = await client.userEventEndpoint(signal);
  signal.throwIfAborted();
  const socket = new WebSocket(websocketUrl);
  try {
    const subscribedTopics = await new Promise<string[]>((resolve, reject) => {
      const topics = new Set<string>();
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      socket.addEventListener(
        "open",
        () => {
          socket.send(
            JSON.stringify([
              {
                id: 1,
                command: { type: "connect", presence: { type: "presence", state: "background" } },
              },
              { id: 2, command: { type: "subscribe", topic_id: "conversations" } },
              { id: 3, command: { type: "subscribe", topic_id: "alder-conversations" } },
            ]),
          );
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => reject(new Error("DESKTOP_CHAT_EVENT_SOCKET_FAILED")),
        { once: true },
      );
      socket.addEventListener(
        "close",
        () => {
          signal.removeEventListener("abort", onAbort);
          if (topics.size !== 2)
            reject(new Error("DESKTOP_CHAT_EVENT_SOCKET_CLOSED_BEFORE_SUBSCRIPTION"));
        },
        { once: true },
      );
      socket.addEventListener("message", (event) => {
        let frames: unknown;
        try {
          frames = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (!Array.isArray(frames)) return;
        for (const frame of frames) {
          const envelope = record(frame);
          const reply = record(envelope?.reply);
          if (reply?.type !== "subscribe") continue;
          const expected =
            envelope?.id === 2
              ? "conversations"
              : envelope?.id === 3
                ? "alder-conversations"
                : undefined;
          if (expected !== undefined && reply.topic_id === expected) topics.add(expected);
        }
        if (topics.size === 2) {
          signal.removeEventListener("abort", onAbort);
          resolve([...topics]);
        }
      });
    });
    return {
      accountScopeSha256: createHash("sha256").update(JSON.stringify(principal)).digest("hex"),
      subscribedTopics,
    };
  } finally {
    socket.close();
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
