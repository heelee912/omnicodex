import { createHash } from "node:crypto";
import {
  BoundedCdpSession,
  type CdpTarget,
  type CdpWebSocketFactory,
  ChatGptLoopbackCdpTransport,
} from "./chatgpt-cdp-transport.js";
import {
  normalizeChatGptConversationId,
  normalizeChatGptConversationUrl,
} from "./chatgpt-conversation-route.js";
import {
  oracleNativeHomeRecoveryExpression,
  oracleNativeTurnSubscriptionExpression,
} from "./oracle-native-turn-subscription.js";

const EVENT_STREAM_RECONNECT_BACKOFF_MS = 15_000;
const EVENT_STREAM_CDP_LIVENESS_TIMEOUT_MS = 5_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Extract only identities from the actual ChatGPT user PubSub notification. */
export interface OracleConversationNotification {
  readonly type: "conversation-update" | "conversation-turn-complete" | "conversation-turn-error";
  readonly payload: unknown;
}

export interface OracleApprovalEventTarget {
  readonly pendingMessageId: string;
  readonly targetMessageIds: readonly string[];
}

/**
 * Recognize only an explicit user/client stop outcome. Transport, upstream,
 * timeout, and rate-limit failures must leave an active Goal eligible to retry.
 */
export function oracleConversationTurnWasStopped(
  notification: OracleConversationNotification,
): boolean {
  if (notification.type !== "conversation-turn-error") return false;
  const payload = record(notification.payload);
  const error = record(payload?.error);
  const normalized = (value: unknown): string | undefined =>
    typeof value === "string"
      ? value
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, "_")
          .replace(/^_+|_+$/gu, "")
      : undefined;
  const explicitStates = new Set([
    "cancelled",
    "canceled",
    "interrupted",
    "stopped",
    "user_cancelled",
    "user_canceled",
    "user_interrupted",
    "user_stopped",
    "client_cancelled",
    "client_canceled",
    "turn_cancelled",
    "turn_canceled",
    "turn_interrupted",
    "turn_stopped",
  ]);
  for (const value of [
    payload?.code,
    payload?.error_code,
    payload?.status,
    error?.code,
    error?.error_code,
    error?.status,
    error?.type,
  ]) {
    const state = normalized(value);
    if (state !== undefined && explicitStates.has(state)) return true;
  }
  const message = [
    payload?.message,
    typeof payload?.error === "string" ? payload.error : undefined,
    error?.message,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return /\b(?:user|client)\s+(?:cancelled|canceled|interrupted|stopped|aborted)\b|\b(?:cancelled|canceled|interrupted|stopped|aborted)\s+by\s+(?:the\s+)?user\b/iu.test(
    message,
  );
}

export function oracleConversationUrlsFromCdpEvent(
  data: unknown,
  onNotification?: (url: string, notification: OracleConversationNotification) => void,
  options?: { readonly includeProgressRequestIdentity?: boolean },
): readonly string[] {
  if (typeof data !== "string") return [];
  try {
    const event = JSON.parse(data);
    if (
      event?.method !== "Network.webSocketFrameReceived" ||
      event.params?.response?.opcode !== 1 ||
      typeof event.params.response.payloadData !== "string"
    )
      return [];
    const frames = JSON.parse(event.params.response.payloadData);
    const urls = new Set<string>();
    const notifications = (Array.isArray(frames) ? frames : [frames]).flatMap((frame) => {
      // Native Topic.subscribe() replays recovered catchups through the same
      // message handler. They are reply payloads, not live message envelopes.
      if (
        typeof frame?.id === "number" &&
        frame.reply?.type === "subscribe" &&
        frame.reply.recovered === true &&
        Array.isArray(frame.reply.catchups)
      ) {
        return frame.reply.catchups.map(
          (catchup: { payload?: unknown } | null) => catchup?.payload,
        );
      }
      return [frame?.type === "message" ? frame.payload : frame];
    });
    for (const notification of notifications.flatMap(nativeConversationNotifications)) {
      if (
        notification?.type !== "conversation-update" &&
        notification?.type !== "conversation-turn-complete" &&
        notification?.type !== "conversation-turn-error"
      )
        continue;
      const ordinaryProgress =
        notification.type === "conversation-update" &&
        isOrdinaryGenerationProgress(notification.payload);
      if (ordinaryProgress && !options?.includeProgressRequestIdentity) continue;
      const payload = notification.payload;
      if (typeof payload !== "object" || payload === null) continue;
      const id = normalizeChatGptConversationId(
        (payload as { conversation_id?: unknown }).conversation_id,
      );
      if (id === undefined) continue;
      const url = normalizeChatGptConversationUrl(`https://chatgpt.com/c/${id}`);
      if (url !== undefined) {
        if (ordinaryProgress) {
          const messages =
            (
              payload as {
                update_content?: { messages?: Array<{ metadata?: { request_id?: unknown } }> };
              }
            ).update_content?.messages ?? [];
          const ids = [
            ...new Set(
              messages.flatMap((message) =>
                typeof message.metadata?.request_id === "string" &&
                message.metadata.request_id.length > 0
                  ? [message.metadata.request_id]
                  : [],
              ),
            ),
          ];
          if (ids.length > 0)
            onNotification?.(url, {
              type: "conversation-update",
              payload: {
                conversation_id: id,
                update_type: "request-identity",
                update_content: {
                  messages: ids.map((request_id) => ({ metadata: { request_id } })),
                },
              },
            });
          continue;
        }
        urls.add(url);
        onNotification?.(url, notification);
      }
    }
    return [...urls];
  } catch {
    return [];
  }
}

/** The current turn topic carries the native SSE records inside encoded_item. */
function nativeConversationNotifications(notification: unknown): OracleConversationNotification[] {
  if (typeof notification !== "object" || notification === null) return [];
  const envelope = notification as { type?: unknown; payload?: unknown };
  if (envelope.type !== "conversation-turn-stream") {
    return envelope.type === "conversation-update" || envelope.type === "conversation-turn-complete"
      ? [envelope as OracleConversationNotification]
      : [];
  }
  if (typeof envelope.payload !== "object" || envelope.payload === null) return [];
  const stream = envelope.payload as {
    type?: unknown;
    conversation_id?: unknown;
    encoded_item?: unknown;
    turn_id?: unknown;
  };
  const conversationId = normalizeChatGptConversationId(stream.conversation_id);
  if (stream.type === "done" && conversationId !== undefined) {
    return [
      {
        type: "conversation-turn-complete",
        payload: {
          conversation_id: conversationId,
          ...(typeof stream.turn_id === "string" ? { turn_id: stream.turn_id } : {}),
        },
      },
    ];
  }
  if (
    stream.type !== "stream-item" ||
    conversationId === undefined ||
    typeof stream.encoded_item !== "string"
  )
    return [];
  const notifications: OracleConversationNotification[] = [];
  for (const record of stream.encoded_item.split(/\r?\n\r?\n/u)) {
    const data = record
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");
    let decoded: unknown;
    try {
      decoded = JSON.parse(data);
    } catch {
      continue;
    }
    if (typeof decoded !== "object" || decoded === null) continue;
    const event = decoded as {
      conversation_id?: unknown;
      message?: unknown;
      error?: unknown;
      error_code?: unknown;
      status?: unknown;
    };
    if (event.error != null || event.error_code != null) {
      // Error records can omit their inner conversation id; the subscribed
      // turn envelope still identifies them. Reject conflicting identities.
      if (
        event.conversation_id != null &&
        normalizeChatGptConversationId(event.conversation_id) !== conversationId
      )
        continue;
      const detail =
        typeof event.error === "object" && event.error !== null && !Array.isArray(event.error)
          ? (event.error as Record<string, unknown>)
          : undefined;
      const code = detail?.code ?? event.error_code;
      const message =
        detail?.message ?? (typeof event.error === "string" ? event.error : undefined);
      const status = detail?.status ?? event.status;
      notifications.push({
        type: "conversation-turn-error",
        payload: {
          conversation_id: conversationId,
          ...(typeof stream.turn_id === "string" ? { turn_id: stream.turn_id } : {}),
          error: {
            ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
            ...(typeof message === "string" ? { message } : {}),
            ...(typeof status === "string" || typeof status === "number" ? { status } : {}),
          },
        },
      });
      continue;
    }
    if (
      normalizeChatGptConversationId(event.conversation_id) !== conversationId ||
      typeof event.message !== "object" ||
      event.message === null ||
      Array.isArray(event.message)
    )
      continue;
    notifications.push({
      type: "conversation-update",
      payload: {
        conversation_id: conversationId,
        ...(typeof stream.turn_id === "string" ? { turn_id: stream.turn_id } : {}),
        update_type: "add-messages",
        update_content: { messages: [event.message] },
      },
    });
  }
  return notifications;
}

/** Examine native metadata only; message text is never parsed or returned. */
export function oracleNotificationRequiresConnectorRead(
  notification: OracleConversationNotification | undefined,
  connectorId: string,
  connectorName: string,
  onApproval?: (target: OracleApprovalEventTarget) => void,
  onGoalResult?: () => void,
): boolean {
  if (notification?.type !== "conversation-update") return false;
  const objects: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const object = value as Record<string, unknown>;
    objects.push(object);
    for (const [key, child] of Object.entries(object))
      if (key !== "content" && key !== "text") visit(child);
  };
  visit(notification.payload);
  const exactConnector = (value: unknown): boolean => {
    if (typeof value === "string")
      return (
        value === connectorId || value === connectorName || value.startsWith(`/${connectorId}/`)
      );
    if (Array.isArray(value)) return value.some(exactConnector);
    return typeof value === "object" && value !== null && Object.values(value).some(exactConnector);
  };
  let requiresRead = false;
  for (const message of objects) {
    const metadata = message.metadata as Record<string, unknown> | undefined;
    if (typeof metadata !== "object" || metadata === null) continue;
    const jit = metadata.jit_plugin_data as
      | { from_server?: { type?: unknown; body?: unknown } }
      | undefined;
    if (typeof message.id === "string" && jit?.from_server?.type === "confirm_action") {
      const body = jit.from_server.body as { actions?: unknown } | undefined;
      const actions = Array.isArray(body?.actions) ? body.actions : [];
      const offered = actions.flatMap((action) => [
        action?.allow,
        action?.always_allow,
        ...(Array.isArray(action?.split_action_options)
          ? action.split_action_options.map((option: { action?: unknown }) => option?.action)
          : []),
      ]);
      const targets = offered.flatMap((action) =>
        typeof action?.target_message_id === "string" ? [action.target_message_id] : [],
      );
      if (
        targets.length > 0 &&
        (exactConnector(body) ||
          objects.some(
            (target) =>
              targets.includes(target.id) &&
              exactConnector({
                author: target.author,
                metadata: target.metadata,
                recipient: target.recipient,
              }),
          ))
      ) {
        requiresRead = true;
        onApproval?.({
          pendingMessageId: message.id,
          targetMessageIds: [...new Set<string>(targets)],
        });
      }
    }
    const author = message.author as { role?: unknown; name?: unknown } | undefined;
    const resource = (metadata.invoked_resource as { resource_uri?: unknown } | undefined)
      ?.resource_uri;
    if (
      author?.role === "tool" &&
      author.name === "api_tool.call_tool" &&
      typeof resource === "string" &&
      resource.startsWith(`/${connectorId}/`) &&
      /\/omnicodex__goal_(?:create|get|claim_next_step|complete|update)$/.test(resource)
    ) {
      requiresRead = true;
      onGoalResult?.();
    }
  }
  return requiresRead;
}

function isOrdinaryGenerationProgress(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const update = payload as { update_type?: unknown; update_content?: { messages?: unknown } };
  if (update.update_type !== "add-messages") return false;
  const messages = update.update_content?.messages;
  return (
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.every((candidate) => {
      if (typeof candidate !== "object" || candidate === null) return false;
      const message = candidate as { status?: unknown; metadata?: unknown };
      const metadata = message.metadata;
      return (
        message.status === "in_progress" &&
        typeof metadata === "object" &&
        metadata !== null &&
        !Array.isArray(metadata) &&
        !Object.hasOwn(metadata, "jit_plugin_data") &&
        (metadata as { message_type?: unknown }).message_type === "next"
      );
    })
  );
}

export interface OracleConversationEventStatus {
  readonly connected: boolean;
  readonly targetIdSha256?: string;
  readonly cdpSessionSha256?: string;
  /** Frames received by the most recently selected CDP session. */
  readonly webSocketFramesReceived: number;
}

export interface OracleConversationEvents {
  status?(): OracleConversationEventStatus;
  /** An authoritative auth-runtime result; does not stop existing event delivery. */
  setAuthenticationFailure?(failure: Error | undefined): void;
  /** True only for the caller that establishes a new passive event connection. */
  ensureConnected(
    onConversation: (url: string, notification?: OracleConversationNotification) => void,
    signal: AbortSignal,
    beforeNativeRecovery?: () => Promise<boolean>,
  ): Promise<boolean>;
  stop(): Promise<void>;
}

/** Only a native stream handoff can nominate a turn topic for observation. */
export function oracleNativeTurnTopics(
  notification: OracleConversationNotification,
): readonly string[] {
  if (notification.type !== "conversation-update") return [];
  const payload = notification.payload as {
    update_type?: unknown;
    update_content?: { options?: unknown };
  } | null;
  if (payload?.update_type !== "stream-handoff" || !Array.isArray(payload.update_content?.options))
    return [];
  return [
    ...new Set(
      payload.update_content.options.flatMap((option) => {
        if (option?.type !== "subscribe_ws_topic" || typeof option.topic_id !== "string") return [];
        try {
          oracleNativeTurnSubscriptionExpression(option.topic_id);
          return [option.topic_id];
        } catch {
          return [];
        }
      }),
    ),
  ];
}

/**
 * Attach to one existing Oracle ChatGPT renderer's native user event stream.
 * Does not enumerate account conversations, create tabs, or submit a turn.
 * Native retry exhaustion can reload one existing idle home after account
 * admission. The approval client independently checks the exact connector and
 * current confirmation before submitting any action.
 */
export class OracleConversationEventSource implements OracleConversationEvents {
  readonly #transport: ChatGptLoopbackCdpTransport;
  readonly #factory: CdpWebSocketFactory;
  readonly #onTurnError:
    | ((url: string, notification: OracleConversationNotification) => void)
    | undefined;
  readonly #onRequestIdentity:
    | ((conversationUrl: string, requestIds: readonly string[]) => void)
    | undefined;
  #session: BoundedCdpSession | undefined;
  #targetIdSha256: string | undefined;
  #cdpSessionSha256: string | undefined;
  #webSocketFramesReceived = 0;
  #connecting: Promise<void> | undefined;
  #retryAt = 0;
  #failure: unknown;
  #stopped = false;
  #subscriptionError: Error | undefined;
  #authenticationFailure: Error | undefined;
  #preferredTargetId: string | undefined;
  readonly #homeRecoveryAttempts = new Set<string>();

  constructor(options: {
    readonly cdpEndpoint: string;
    readonly transport?: ChatGptLoopbackCdpTransport;
    readonly factory?: CdpWebSocketFactory;
    readonly onTurnError?: (url: string, notification: OracleConversationNotification) => void;
    readonly onRequestIdentity?: (conversationUrl: string, requestIds: readonly string[]) => void;
  }) {
    this.#transport =
      options.transport ??
      new ChatGptLoopbackCdpTransport({
        endpoint: options.cdpEndpoint,
        timeoutMs: EVENT_STREAM_CDP_LIVENESS_TIMEOUT_MS,
      });
    this.#factory = options.factory ?? ((url) => new WebSocket(url));
    this.#onTurnError = options.onTurnError;
    this.#onRequestIdentity = options.onRequestIdentity;
  }

  setAuthenticationFailure(failure: Error | undefined): void {
    if (this.#authenticationFailure !== undefined && failure === undefined) {
      // Authentication recovery is new evidence, not another failed renderer
      // lookup. Admit the existing subscription path immediately.
      this.#retryAt = 0;
      this.#failure = undefined;
    }
    this.#authenticationFailure = failure;
  }

  async ensureConnected(
    onConversation: (url: string, notification?: OracleConversationNotification) => void,
    signal: AbortSignal,
    beforeNativeRecovery?: () => Promise<boolean>,
  ): Promise<boolean> {
    signal.throwIfAborted();
    if (this.#stopped) return false;
    if (this.#authenticationFailure !== undefined) throw this.#authenticationFailure;
    if (this.#subscriptionError !== undefined) {
      const error = this.#subscriptionError;
      this.#subscriptionError = undefined;
      // The inspector socket can survive a failed native topic subscription.
      // Reacquire it through the paced path instead of treating it as connected.
      const session = this.#session;
      this.#session = undefined;
      session?.close();
      this.#recordFailure(error);
      throw error;
    }
    if (this.#session !== undefined) return false;
    if (this.#connecting !== undefined) {
      await this.#connecting;
      return false;
    }
    if (Date.now() < this.#retryAt) throw this.#failure;
    const connecting = this.#connect(onConversation, signal, beforeNativeRecovery);
    this.#connecting = connecting;
    try {
      await connecting;
      if (this.#session === undefined && !this.#stopped) {
        throw this.#failure ?? new Error("ORACLE_SERVER_APPROVAL_EVENT_STREAM_CLOSED");
      }
      this.#failure = undefined;
      this.#retryAt = 0;
      return !this.#stopped;
    } catch (error) {
      if (!this.#stopped && (this.#failure !== error || this.#retryAt <= Date.now())) {
        this.#recordFailure(error);
      }
      throw error;
    } finally {
      this.#connecting = undefined;
    }
  }

  status(): OracleConversationEventStatus {
    return {
      connected: this.#session !== undefined && !this.#stopped,
      ...(this.#targetIdSha256 === undefined ? {} : { targetIdSha256: this.#targetIdSha256 }),
      ...(this.#cdpSessionSha256 === undefined ? {} : { cdpSessionSha256: this.#cdpSessionSha256 }),
      webSocketFramesReceived: this.#webSocketFramesReceived,
    };
  }

  #recordFailure(error: unknown): void {
    this.#failure = error;
    this.#retryAt = Date.now() + EVENT_STREAM_RECONNECT_BACKOFF_MS;
  }

  async #connect(
    onConversation: (url: string, notification?: OracleConversationNotification) => void,
    signal: AbortSignal,
    beforeNativeRecovery?: () => Promise<boolean>,
  ): Promise<void> {
    const targets = await this.#transport.listChatGptTargets(signal);
    const candidates = targets
      .filter((candidate) => {
        const url = new URL(candidate.url);
        return url.pathname === "/" || normalizeChatGptConversationUrl(candidate.url) !== undefined;
      })
      .sort(
        (a, b) =>
          Number(b.id === this.#preferredTargetId) - Number(a.id === this.#preferredTargetId) ||
          Number(normalizeChatGptConversationUrl(a.url) === undefined) -
            Number(normalizeChatGptConversationUrl(b.url) === undefined) ||
          a.id.localeCompare(b.id),
      );
    if (candidates.length === 0) {
      if (targets.some((candidate) => new URL(candidate.url).pathname === "/auth/error"))
        throw new Error("ORACLE_SERVER_APPROVAL_RUNTIME_AUTHENTICATION_REQUIRED");
      throw new Error("ORACLE_SERVER_APPROVAL_EVENT_RENDERER_MISSING");
    }
    let failure: unknown;
    for (const target of candidates) {
      try {
        await this.#connectTarget(target, onConversation, signal, beforeNativeRecovery);
        return;
      } catch (error) {
        if (signal.aborted || this.#stopped) throw error;
        if (error instanceof Error && error.message === "ORACLE_NATIVE_EVENT_RENDERER_RELOADING")
          throw error;
        failure = error;
      }
    }
    throw failure ?? new Error("ORACLE_SERVER_APPROVAL_EVENT_RENDERER_MISSING");
  }

  async #connectTarget(
    target: CdpTarget,
    onConversation: (url: string, notification?: OracleConversationNotification) => void,
    signal: AbortSignal,
    beforeNativeRecovery?: () => Promise<boolean>,
  ): Promise<void> {
    this.#targetIdSha256 = createHash("sha256").update(target.id).digest("hex");
    this.#cdpSessionSha256 = undefined;
    this.#webSocketFramesReceived = 0;
    let disconnected = false;
    let disconnectFailure: Error | undefined;
    let session: BoundedCdpSession | undefined;
    let subscriptionStartedAtUnixMs: number | undefined;
    let undatedConsoleFailure: Error | undefined;
    let latestDatedConsoleFailure: { timestamp: number; error: Error } | undefined;
    const connected = await BoundedCdpSession.connect(
      this.#transport,
      {
        target,
        targetId: target.id,
        factory: (url) => {
          const socket = this.#factory(url);
          const detach = (kind: "close" | "error", event: { data?: unknown }) => {
            if (disconnected) return;
            disconnected = true;
            disconnectFailure = eventStreamDisconnectFailure(kind, event);
            if (session !== undefined && this.#session === session) {
              this.#session = undefined;
              if (!this.#stopped) this.#recordFailure(disconnectFailure);
            }
          };
          socket.addEventListener("close", (event) => detach("close", event));
          socket.addEventListener("error", (event) => detach("error", event));
          socket.addEventListener("message", ({ data }) => {
            if (this.#stopped || disconnected) return;
            if (typeof data === "string") {
              try {
                const event = JSON.parse(data);
                if (event.method === "Network.webSocketFrameReceived")
                  this.#webSocketFramesReceived += 1;
                if (
                  event.method === "Runtime.consoleAPICalled" &&
                  event.params?.args?.[0]?.value === "ORACLE_NATIVE_TURN_SUBSCRIPTION_FAILED"
                ) {
                  const error = new Error(
                    String(event.params.args[1]?.value ?? "ORACLE_NATIVE_TURN_SUBSCRIPTION_FAILED"),
                  );
                  const timestamp: unknown = event.params.timestamp;
                  const dated =
                    typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= 0;
                  if (this.#session === session && session !== undefined) {
                    if (
                      !dated ||
                      subscriptionStartedAtUnixMs === undefined ||
                      timestamp >= subscriptionStartedAtUnixMs
                    )
                      this.#subscriptionError = error;
                  } else if (!dated) {
                    undatedConsoleFailure ??= error;
                  } else if (
                    latestDatedConsoleFailure === undefined ||
                    timestamp >= latestDatedConsoleFailure.timestamp
                  ) {
                    latestDatedConsoleFailure = { timestamp, error };
                  }
                }
              } catch {
                /* Non-JSON frames remain the decoder's responsibility. */
              }
            }
            oracleConversationUrlsFromCdpEvent(
              data,
              (url, notification) => {
                const payload = notification.payload as {
                  update_type?: string;
                  update_content?: { messages?: { metadata?: { request_id?: unknown } }[] };
                };
                if (this.#onRequestIdentity && Array.isArray(payload.update_content?.messages)) {
                  const ids = [
                    ...new Set(
                      payload.update_content.messages.flatMap((message) =>
                        typeof message.metadata?.request_id === "string" &&
                        message.metadata.request_id.length > 0
                          ? [message.metadata.request_id]
                          : [],
                      ),
                    ),
                  ];
                  if (ids.length) this.#onRequestIdentity(url, ids);
                }
                if (payload.update_type === "request-identity") return;
                if (notification.type === "conversation-turn-error")
                  this.#onTurnError?.(url, notification);
                onConversation(url, notification);
              },
              { includeProgressRequestIdentity: this.#onRequestIdentity !== undefined },
            );
          });
          return socket;
        },
      },
      signal,
    );
    session = connected;
    this.#cdpSessionSha256 = connected.sessionIdentity;
    try {
      await Promise.all([
        connected.command("Network.enable", {}, signal),
        connected.command("Runtime.enable", {}, signal),
      ]);
      const subscription = (await connected.command(
        "Runtime.evaluate",
        {
          expression: oracleNativeTurnSubscriptionExpression(),
          returnByValue: true,
          awaitPromise: true,
        },
        signal,
      )) as {
        exceptionDetails?: { text?: string; exception?: { description?: string } };
        result?: {
          value?: {
            state?: unknown;
            transportOpen?: unknown;
            conversationsTopicState?: unknown;
            subscriptionStartedAtUnixMs?: unknown;
          };
        };
      };
      if (subscription.exceptionDetails !== undefined)
        throw new Error(
          subscription.exceptionDetails.exception?.description ??
            subscription.exceptionDetails.text ??
            "ORACLE_NATIVE_TURN_SUBSCRIPTION_FAILED",
        );
      // Runtime.enable replays the renderer's console history. Compare dated
      // failures with the new subscription's renderer clock, never the host's
      // clock: remote CDP endpoints can have a different time offset. Missing
      // or malformed timestamps remain failures, as do errors from this attempt.
      const listening = subscription.result?.value;
      const startedAt = listening?.subscriptionStartedAtUnixMs;
      if (
        listening?.state === "listening" &&
        listening.transportOpen === true &&
        listening.conversationsTopicState === 0 &&
        typeof startedAt === "number" &&
        Number.isFinite(startedAt) &&
        startedAt >= 0
      )
        subscriptionStartedAtUnixMs = startedAt;
      if (undatedConsoleFailure !== undefined) throw undatedConsoleFailure;
      if (
        latestDatedConsoleFailure !== undefined &&
        (subscriptionStartedAtUnixMs === undefined ||
          latestDatedConsoleFailure.timestamp >= subscriptionStartedAtUnixMs)
      )
        throw latestDatedConsoleFailure.error;
      if (disconnected || this.#stopped)
        throw disconnectFailure ?? new Error("ORACLE_SERVER_APPROVAL_EVENT_STREAM_CLOSED");
      this.#session = connected;
      this.#preferredTargetId = target.id;
      this.#homeRecoveryAttempts.clear();
    } catch (error) {
      try {
        if (
          !signal.aborted &&
          !this.#stopped &&
          error instanceof Error &&
          error.message.includes("ORACLE_NATIVE_PUBSUB_TRANSPORT_NOT_OPEN") &&
          new URL(target.url).pathname === "/" &&
          !this.#homeRecoveryAttempts.has(target.id) &&
          beforeNativeRecovery !== undefined
        ) {
          const eligibility = (await connected.command(
            "Runtime.evaluate",
            {
              expression: oracleNativeHomeRecoveryExpression(false),
              returnByValue: true,
              awaitPromise: true,
            },
            signal,
          )) as { result?: { value?: { state?: string } } };
          if (eligibility.result?.value?.state === "eligible" && (await beforeNativeRecovery())) {
            signal.throwIfAborted();
            if (this.#stopped) throw error;
            // One attempt per outage; a successful subscription rearms recovery.
            this.#homeRecoveryAttempts.add(target.id);
            this.#preferredTargetId = target.id;
            await connected.command(
              "Runtime.evaluate",
              {
                expression: oracleNativeHomeRecoveryExpression(true),
                returnByValue: true,
                awaitPromise: true,
              },
              signal,
            );
            throw new Error("ORACLE_NATIVE_EVENT_RENDERER_RELOADING");
          }
        }
        throw disconnectFailure ?? error;
      } finally {
        connected.close();
      }
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#connecting?.catch(() => undefined);
    await this.#session
      ?.command("Runtime.evaluate", {
        expression: oracleNativeTurnSubscriptionExpression(null),
        returnByValue: true,
        awaitPromise: true,
      })
      .catch(() => undefined);
    // Closing only this inspector detaches its Network subscription. The
    // renderer and its first-party PubSub connection remain untouched.
    this.#session?.close();
    this.#session = undefined;
  }
}

function eventStreamDisconnectFailure(kind: "close" | "error", event: { data?: unknown }): Error {
  const details = event as {
    data?: unknown;
    error?: unknown;
    message?: string;
    code?: number;
    reason?: string;
  };
  if (details.error instanceof Error) return details.error;
  if (details.data instanceof Error) return details.data;
  const description = [details.message, details.code, details.reason]
    .filter((value) => value !== undefined && value !== "")
    .join(": ");
  return new Error(
    `ORACLE_SERVER_APPROVAL_EVENT_STREAM_${kind === "error" ? "ERROR" : "CLOSED"}${description ? `: ${description}` : ""}`,
    { cause: event },
  );
}
