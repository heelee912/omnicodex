import {
  BoundedCdpSession,
  type CdpTarget,
  type CdpWebSocketLike,
  ChatGptLoopbackCdpTransport,
} from "../chatgpt/chatgpt-cdp-transport.js";
import { normalizeChatGptConversationUrl } from "../chatgpt/chatgpt-conversation-route.js";
import {
  ORACLE_GOAL_CONVERSATION_SOURCE,
  type OracleGoalConversation,
  parseOracleGoalConversation,
} from "../chatgpt/oracle-goal-conversation.js";
import {
  DESKTOP_EXACT_CONVERSATION_READER,
  readDesktopChatConversation,
} from "./desktop-chat-api-reader.js";

interface Scope {
  readonly accountSourceId: string;
  readonly connectorIds: readonly string[];
}

export interface DesktopGoalBindingReaderInput extends Scope {
  readonly endpoint: string;
  readonly conversationUrl: string;
  readonly readScope: (signal: AbortSignal) => Promise<Scope>;
}

type Session = Pick<BoundedCdpSession, "command" | "close">;
interface Connection {
  listTargets(signal: AbortSignal): Promise<readonly CdpTarget[]>;
  connect(target: CdpTarget, signal: AbortSignal): Promise<Session>;
}

const project = new Function(`return (${ORACLE_GOAL_CONVERSATION_SOURCE});`)() as (
  conversationId: string,
  raw: unknown,
  connectorId: string,
) => unknown;

/** Reads the exact native body locally, then applies the existing Goal projection unchanged. */
export async function readDesktopGoalBindings(
  input: DesktopGoalBindingReaderInput,
  signal: AbortSignal,
  connection?: Connection,
): Promise<OracleGoalConversation> {
  return (await readDesktopGoalSnapshot(input, signal, connection)).observation;
}

export interface DesktopGoalSnapshot {
  readonly raw: unknown;
  readonly observation: OracleGoalConversation;
}

/** Retains the exact response alongside the existing Goal projection. */
export async function readDesktopGoalSnapshot(
  input: DesktopGoalBindingReaderInput,
  signal: AbortSignal,
  connection?: Connection,
): Promise<DesktopGoalSnapshot> {
  signal.throwIfAborted();
  const url = normalizeChatGptConversationUrl(input.conversationUrl);
  if (!url) throw new Error("DESKTOP_CHAT_CONVERSATION_INVALID");
  const connectors = [...new Set(input.connectorIds)];
  if (!connectors.length) throw new Error("DESKTOP_GOAL_CONNECTOR_SELECTION_UNAVAILABLE");
  const assertScope = async () => {
    signal.throwIfAborted();
    const scope = await input.readScope(signal);
    signal.throwIfAborted();
    if (scope.accountSourceId !== input.accountSourceId)
      throw new Error("DESKTOP_CHAT_ACCOUNT_CHANGED");
    if (connectors.some((id) => !scope.connectorIds.includes(id)))
      throw new Error("DESKTOP_GOAL_CONNECTOR_SELECTION_CHANGED");
  };
  await assertScope();
  const transport = new ChatGptLoopbackCdpTransport({
    endpoint: input.endpoint,
    allowDesktopAppTargets: true,
  });
  const native = connection ?? {
    listTargets: (boundary: AbortSignal) => transport.listChatGptTargets(boundary),
    connect: (target: CdpTarget, boundary: AbortSignal) =>
      BoundedCdpSession.connect(
        transport,
        {
          target,
          targetId: target.id,
          timeoutMs: null,
          factory: (socketUrl) => new WebSocket(socketUrl) as unknown as CdpWebSocketLike,
        },
        boundary,
      ),
  };
  const target = (await native.listTargets(signal))
    .filter((item) => item.type === "page" && item.url === "app://-/index.html")
    .sort((left, right) => left.id.localeCompare(right.id, "en"))[0];
  if (!target) throw new Error("DESKTOP_CHAT_RENDERER_NOT_FOUND");
  const session = await native.connect(target, signal);
  try {
    const raw = await readDesktopChatConversation(
      {
        conversationUrl: url,
        evaluate: async (expression, boundary) => {
          const result = (await session.command(
            "Runtime.evaluate",
            {
              expression,
              awaitPromise: true,
              returnByValue: true,
            },
            boundary,
            null,
          )) as {
            exceptionDetails?: { text?: string; exception?: { description?: string } };
            result?: { value?: unknown };
          };
          if (result.exceptionDetails)
            throw new Error(
              result.exceptionDetails.exception?.description ??
                result.exceptionDetails.text ??
                "DESKTOP_CHAT_RENDERER_EVALUATION_FAILED",
            );
          return result.result?.value;
        },
      },
      signal,
    );
    await assertScope();
    const id = url.slice("https://chatgpt.com/c/".length);
    const rawId =
      raw && typeof raw === "object" && "conversation_id" in raw ? raw.conversation_id : undefined;
    if (rawId !== undefined && rawId !== id) throw new Error("DESKTOP_CHAT_CONVERSATION_CHANGED");
    const observations = connectors.map((connector) =>
      parseOracleGoalConversation(project(id, raw, connector)),
    );
    const first = observations[0] as OracleGoalConversation;
    const observation = parseOracleGoalConversation({
      ...first,
      source: { kind: "desktop", accountSourceId: input.accountSourceId },
      goals: [
        ...new Map(
          observations
            .flatMap((item) => item.goals)
            .map((goal) => [`${goal.messageId}\0${goal.goalId}\0${goal.revision}`, goal]),
        ).values(),
      ],
    });
    return { raw, observation };
  } catch (error) {
    // A terminal conversation result belongs to the account that performed
    // this exact read, not whichever account is selected afterwards.
    const deleted = exactDeletedDetails(error);
    if (
      error instanceof Error &&
      deleted?.conversation_id === url.slice("https://chatgpt.com/c/".length)
    ) {
      await assertScope();
      Object.assign(error, {
        code: "conversation_deleted",
        can_retry: false,
        conversation_id: deleted.conversation_id,
        accountSourceId: input.accountSourceId,
        conversationUrl: url,
      });
    }
    throw error;
  } finally {
    session.close();
  }
}

function exactDeletedDetails(error: unknown): Record<string, unknown> | undefined {
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const parse = (value: unknown): Record<string, unknown> | undefined => {
    if (typeof value !== "string") return object(value);
    const start = value.indexOf("{");
    if (start < 0) return undefined;
    try {
      return object(JSON.parse(value.slice(start)));
    } catch {
      return undefined;
    }
  };
  const top = object(error);
  const message = parse(top?.message);
  for (const value of [top, parse(top?.detail), message, parse(message?.detail)]) {
    if (
      (value?.code === "conversation_deleted" || value?.errorCode === "conversation_deleted") &&
      value.can_retry === false &&
      typeof value.conversation_id === "string"
    )
      return value;
  }
  return undefined;
}

/** Transport recognition of the reader's exact generated expression, including cancellation. */
export function isDesktopGoalBindingReadExpression(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const prefix = `(${DESKTOP_EXACT_CONVERSATION_READER})(`;
  if (value.startsWith(prefix) && value.endsWith(")")) {
    try {
      const args = JSON.parse(`[${value.slice(prefix.length, -1)}]`);
      return (
        Array.isArray(args) &&
        args.length === 2 &&
        typeof args[0] === "string" &&
        typeof args[1] === "string" &&
        normalizeChatGptConversationUrl(`https://chatgpt.com/c/${args[0]}`) !== undefined &&
        /^[a-f0-9-]{36}$/.test(args[1]) &&
        value === `${prefix}${JSON.stringify(args[0])}, ${JSON.stringify(args[1])})`
      );
    } catch {
      return false;
    }
  }
  const token = /r\.get\(("[a-f0-9-]{36}")\)/.exec(value)?.[1];
  return (
    token !== undefined &&
    value ===
      `(() => { const r = globalThis.__omnicodexDesktopExactReadOperations ??= new Map(); const c = r.get(${token}); if (c) c.abort(); else r.set(${token}, { signal: { aborted: true } }); })()`
  );
}
