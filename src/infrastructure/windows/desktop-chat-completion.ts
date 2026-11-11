import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeChatGptConversationUrl } from "../chatgpt/chatgpt-conversation-route.js";
import type { DesktopChatPrincipal } from "../chatgpt/desktop-chat-api-client.js";
import type { DesktopChatObservedEvent } from "./desktop-chat-event-source.js";
import { inspectDesktopChatGoalReadback } from "./desktop-chat-goal-continuation.js";

export interface DesktopChatCompletionCandidate {
  readonly conversationUrl: string;
  readonly finalMessageId: string;
  readonly streamTurnId?: string;
}

export type DesktopChatCompletionVerification =
  | {
      readonly outcome: "verified";
      readonly principal: DesktopChatPrincipal;
      readonly accountSourceId: string;
      readonly completion: DesktopChatCompletionCandidate;
      readonly ancestorMessageIds?: readonly string[];
    }
  | {
      readonly outcome: "account_changed" | "conversation_source_mismatch" | "awaiting_transcript";
      readonly readbackOutcome?: string;
    };

/** A bare completion or a channel=null end-turn message cannot nominate a final answer. */
export function desktopChatCompletionCandidates(
  event: DesktopChatObservedEvent,
): readonly DesktopChatCompletionCandidate[] {
  if (event.notification.type !== "conversation-update") return [];
  const url = normalizeChatGptConversationUrl(event.conversationUrl);
  const payload = object(event.notification.payload);
  if (!url || payload?.conversation_id !== url.slice("https://chatgpt.com/c/".length)) return [];
  const messages = object(payload.update_content)?.messages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((value) => {
    const message = object(value);
    if (
      typeof message?.id !== "string" ||
      !message.id ||
      object(message.author)?.role !== "assistant" ||
      message.status !== "finished_successfully" ||
      message.end_turn !== true ||
      message.channel !== "final"
    )
      return [];
    return [
      {
        conversationUrl: url,
        finalMessageId: message.id,
        ...(typeof payload.turn_id === "string" ? { streamTurnId: payload.turn_id } : {}),
      },
    ];
  });
}

/** Matches native auth, the exact account-scoped catalog entry, and a fresh native final read. */
export async function verifyDesktopChatCompletion(
  completion: DesktopChatCompletionCandidate,
  dependencies: {
    readonly readPrincipal: (signal: AbortSignal) => Promise<DesktopChatPrincipal>;
    readonly hasConversationSource: (
      accountSourceId: string,
      conversationId: string,
    ) => Promise<boolean>;
    readonly readThread: (conversationId: string, signal: AbortSignal) => Promise<unknown>;
  },
  signal: AbortSignal,
): Promise<DesktopChatCompletionVerification> {
  signal.throwIfAborted();
  const url = normalizeChatGptConversationUrl(completion.conversationUrl);
  if (!url || !completion.finalMessageId) throw new Error("DESKTOP_CHAT_COMPLETION_INVALID");
  const conversationId = url.slice("https://chatgpt.com/c/".length);
  const principal = await dependencies.readPrincipal(signal);
  const accountSourceId = desktopChatAccountSourceId(principal);
  if (!(await dependencies.hasConversationSource(accountSourceId, conversationId)))
    return { outcome: "conversation_source_mismatch" };
  signal.throwIfAborted();
  const transcript = await dependencies.readThread(conversationId, signal);
  const after = await dependencies.readPrincipal(signal);
  signal.throwIfAborted();
  if (desktopChatAccountSourceId(after) !== accountSourceId) return { outcome: "account_changed" };
  const readbackOutcome = inspectDesktopChatGoalReadback(
    transcript,
    conversationId,
    completion.finalMessageId,
  );
  if (readbackOutcome !== "ready") return { outcome: "awaiting_transcript", readbackOutcome };
  return { outcome: "verified", principal, accountSourceId, completion };
}

export function desktopChatAccountSourceId(principal: DesktopChatPrincipal): string {
  if (
    [principal.accountId, principal.userId].some(
      (value) => typeof value !== "string" || !value || value.includes(":"),
    )
  )
    throw new Error("DESKTOP_CHAT_ACCOUNT_SOURCE_INVALID");
  return `chatgpt:${principal.accountId}:${principal.userId}`;
}

/** Catalog identity lookup only; this database is never treated as a completion event source. */
export class DesktopChatConversationSources {
  readonly #path: string;
  constructor(codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")) {
    this.#path = join(codexHome, "sqlite", "codex-dev.db");
  }

  async hasConversationSource(accountSourceId: string, conversationId: string): Promise<boolean> {
    const database = new DatabaseSync(this.#path, { readOnly: true });
    try {
      const row = database
        .prepare(
          "SELECT 1 AS present FROM local_thread_catalog WHERE host_id = ? AND thread_id = ?",
        )
        .get(accountSourceId, conversationId);
      return row?.present === 1;
    } finally {
      database.close();
    }
  }

  async isChatConversation(conversationId: string): Promise<boolean> {
    const database = new DatabaseSync(this.#path, { readOnly: true });
    try {
      return (
        database
          .prepare(
            "SELECT 1 AS present FROM local_thread_catalog WHERE thread_id = ? AND host_id LIKE 'chatgpt:%' LIMIT 1",
          )
          .get(conversationId)?.present === 1
      );
    } finally {
      database.close();
    }
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
