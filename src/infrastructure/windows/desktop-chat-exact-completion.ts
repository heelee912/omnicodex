import { normalizeChatGptConversationUrl } from "../chatgpt/chatgpt-conversation-route.js";
import type { DesktopChatPrincipal } from "../chatgpt/desktop-chat-api-client.js";
import {
  type DesktopChatCompletionCandidate,
  type DesktopChatCompletionVerification,
  desktopChatAccountSourceId,
} from "./desktop-chat-completion.js";
import {
  type DesktopGoalBindingReaderInput,
  type DesktopGoalSnapshot,
  readDesktopGoalSnapshot,
} from "./desktop-goal-binding-reader.js";

export interface DesktopExactCompletionInput extends DesktopGoalBindingReaderInput {
  readonly readPrincipal: (signal: AbortSignal) => Promise<DesktopChatPrincipal>;
  readonly hasConversationSource: (
    accountSourceId: string,
    conversationId: string,
  ) => Promise<boolean>;
}

type SnapshotReader = typeof readDesktopGoalSnapshot;

/** Exact Desktop Chat response, without the Codex thread-summary namespace. */
export async function readDesktopExactCompletion(
  input: DesktopExactCompletionInput,
  selection: { readonly candidate?: DesktopChatCompletionCandidate; readonly anchor?: string },
  signal: AbortSignal,
  readSnapshot: SnapshotReader = readDesktopGoalSnapshot,
): Promise<DesktopChatCompletionVerification> {
  signal.throwIfAborted();
  const url = normalizeChatGptConversationUrl(input.conversationUrl);
  if (
    !url ||
    (selection.candidate &&
      normalizeChatGptConversationUrl(selection.candidate.conversationUrl) !== url)
  )
    throw new Error("DESKTOP_CHAT_COMPLETION_INVALID");
  const principal = await input.readPrincipal(signal);
  const accountSourceId = desktopChatAccountSourceId(principal);
  if (accountSourceId !== input.accountSourceId) return { outcome: "account_changed" };
  if (
    !(await input.hasConversationSource(
      accountSourceId,
      url.slice("https://chatgpt.com/c/".length),
    ))
  )
    return { outcome: "conversation_source_mismatch" };
  const snapshot = await readSnapshot(input, signal);
  if (desktopChatAccountSourceId(await input.readPrincipal(signal)) !== accountSourceId)
    return { outcome: "account_changed" };
  signal.throwIfAborted();
  return projectDesktopExactCompletion(snapshot, input.conversationUrl, selection, principal);
}

/** Caller verifies principal before/after the snapshot and checks catalog identity. */
export function projectDesktopExactCompletion(
  snapshot: DesktopGoalSnapshot,
  conversationUrl: string,
  selection: { readonly candidate?: DesktopChatCompletionCandidate; readonly anchor?: string },
  principal: DesktopChatPrincipal,
): DesktopChatCompletionVerification {
  const url = normalizeChatGptConversationUrl(conversationUrl);
  if (
    !url ||
    (selection.candidate &&
      normalizeChatGptConversationUrl(selection.candidate.conversationUrl) !== url)
  )
    throw new Error("DESKTOP_CHAT_COMPLETION_INVALID");
  const accountSourceId = desktopChatAccountSourceId(principal);
  if (
    snapshot.observation.conversationUrl !== url ||
    snapshot.observation.source?.accountSourceId !== accountSourceId
  )
    return { outcome: "conversation_source_mismatch" };
  assertNoCurrentFailure(snapshot);
  const current = snapshot.observation.current;
  if (
    current?.authorRole !== "assistant" ||
    current.status !== "finished_successfully" ||
    current.channel !== "final" ||
    current.endTurn !== true
  )
    return { outcome: "awaiting_transcript", readbackOutcome: "generating" };
  if (selection.candidate) {
    if (current.id !== selection.candidate.finalMessageId)
      return { outcome: "awaiting_transcript", readbackOutcome: "superseded" };
  } else if (
    !selection.anchor ||
    current.id === selection.anchor ||
    !current.ancestorMessageIds?.includes(selection.anchor)
  ) {
    return { outcome: "awaiting_transcript", readbackOutcome: "anchor_not_visible" };
  }
  return {
    outcome: "verified",
    principal,
    accountSourceId,
    completion: { ...selection.candidate, conversationUrl: url, finalMessageId: current.id },
    ...(current.ancestorMessageIds === undefined
      ? {}
      : { ancestorMessageIds: current.ancestorMessageIds }),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function assertNoCurrentFailure(snapshot: DesktopGoalSnapshot): void {
  const raw = record(snapshot.raw);
  const mapping = record(raw?.mapping);
  const node =
    typeof raw?.current_node === "string" ? record(mapping?.[raw.current_node]) : undefined;
  const message = record(node?.message);
  const status = record(raw?.status)?.type ?? raw?.status;
  const failed =
    status === "systemError" ||
    message?.status === "finished_with_error" ||
    message?.status === "error";
  const error = raw?.error ?? message?.error;
  if (failed || error != null) {
    throw new Error(
      `DIRECT_GOAL_DESKTOP_CONVERSATION_FAILED:${String(message?.status ?? status ?? "error")}${error == null ? "" : `:${typeof error === "string" ? error : JSON.stringify(error)}`}`,
      { cause: snapshot.raw },
    );
  }
}
