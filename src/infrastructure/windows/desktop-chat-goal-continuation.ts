import {
  ChatAccountRateLimitError,
  chatAccountRateLimitRetryAt,
} from "../../application/chat-account-request-coordinator.js";
import {
  type ChromeGoalContinuationTarget,
  goalContinuationPrompt,
  isGoalContinuationPrompt,
} from "../../application/chrome-goal-continuation.js";
import type { CodexAppHostToolExecutor } from "../../application/codex-app-host-tool-executor.js";
import { normalizeChatGptConversationUrl } from "../chatgpt/chatgpt-conversation-route.js";
import type { DirectGoalNativeSendReceipt } from "../mcp/direct-goal-store.js";
import type { DesktopNativePreparedMessage } from "./desktop-chat-native-sender.js";

type RecordValue = Record<string, unknown>;

export interface DesktopGoalNativeSender {
  prepare(
    prompt: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<DesktopNativePreparedMessage>;
  dispatch(
    prepared: DesktopNativePreparedMessage,
    signal?: AbortSignal,
  ): Promise<{ threadId: string; clientUserMessageId: string; accepted: boolean }>;
}

/** Uses the installed app's ordinary Chat host tools, preserving its model and account. */
export async function continueDesktopChatGoal(
  executor: Pick<CodexAppHostToolExecutor, "callRequiredNative">,
  target: ChromeGoalContinuationTarget,
  contextThreadId?: string,
  signal?: AbortSignal,
  verifyAccount?: (
    accountSourceId: string,
    conversationId: string,
    signal?: AbortSignal,
  ) => Promise<boolean>,
  recordReceipt?: (receipt: DirectGoalNativeSendReceipt) => Promise<boolean>,
  resolveConnectorId?: () => Promise<string>,
  canDispatch?: () => Promise<boolean>,
  readConversation?: (conversationId: string, signal?: AbortSignal) => Promise<unknown>,
  nativeSender?: DesktopGoalNativeSender,
): Promise<{ outcome: string; error?: string; cause?: unknown }> {
  const url = normalizeChatGptConversationUrl(target.conversationUrl);
  if (
    url === undefined ||
    !target.draft.afterMessageId ||
    !["inspect", "send"].includes(target.operation)
  )
    throw new Error("DIRECT_GOAL_DESKTOP_TARGET_INVALID");
  const threadId = url.slice("https://chatgpt.com/c/".length);
  let pendingReceipt = target.draft.nativeReceipt;
  if (pendingReceipt !== undefined) {
    const receipt = pendingReceipt;
    if (
      target.draft.transport !== "desktop" ||
      (receipt.kind !== "native_host_acknowledged" && receipt.kind !== "native_message_prepared") ||
      receipt.threadId !== threadId ||
      receipt.operationId !== `goal-continuation:${target.draft.token}` ||
      target.accountSourceId === undefined ||
      receipt.accountSourceId !== target.accountSourceId
    )
      throw new Error("DIRECT_GOAL_DESKTOP_SEND_RECEIPT_INVALID");
    // This is the saved result of this operation, independent of later user
    // messages or the app's currently selected account. It never sends again.
    if (receipt.kind === "native_host_acknowledged") return { outcome: "sent" };
  }
  if (
    target.draft.transport === "desktop" &&
    (target.accountSourceId === undefined || verifyAccount === undefined)
  )
    return { outcome: "account_binding_unverified" };
  const accountMatches = async () =>
    target.accountSourceId === undefined ||
    (await verifyAccount?.(target.accountSourceId, threadId, signal)) === true;
  const call = (tool: string, args: RecordValue) =>
    executor.callRequiredNative(`codex_app__${tool}`, args, {
      ...(contextThreadId === undefined ? {} : { callingThreadId: contextThreadId }),
      ...(signal === undefined ? {} : { signal }),
      // Retain the existing host pipe's replay identity across an uncertain
      // send. Reads must remain fresh and therefore have no fixed call id.
      ...(tool === "send_message_to_thread"
        ? { operationId: `goal-continuation:${target.draft.token}` }
        : {}),
    });
  const inspect = async () => {
    if (!(await accountMatches())) return "account_changed";
    if (readConversation === undefined)
      throw new Error("DIRECT_GOAL_DESKTOP_EXACT_READER_REQUIRED");
    {
      const data = projectDesktopChatGoalReadback(
        await readConversation(threadId, signal),
        threadId,
      );
      if (!(await accountMatches())) return "account_changed";
      if (pendingReceipt?.kind === "native_message_prepared") {
        const items = (data.turns as RecordValue[])
          .slice()
          .reverse()
          .flatMap((turn) => (Array.isArray(turn.items) ? turn.items.map(object) : []));
        const anchorAt = items.findIndex(
          (item) => item?.id === target.draft.afterMessageId && item.type === "agentMessage",
        );
        if (
          anchorAt >= 0 &&
          items
            .slice(anchorAt + 1)
            .some(
              (item) =>
                item?.type === "userMessage" && item.id === pendingReceipt?.clientUserMessageId,
            )
        )
          return "sent";
      }
      const outcome = inspectDesktopChatGoalReadback(data, threadId, target.draft.afterMessageId);
      if (
        outcome === "superseded" &&
        target.operation === "inspect" &&
        target.draft.state === "dispatching" &&
        hasCompletedSupersedingInput(data, target.draft.afterMessageId)
      )
        return "superseded_completed_input";
      return outcome;
    }
  };
  const dispatchPrepared = async (): Promise<{ outcome: string }> => {
    if (
      !nativeSender ||
      !recordReceipt ||
      pendingReceipt?.kind !== "native_message_prepared" ||
      pendingReceipt.dispatchState !== "prepared" ||
      !pendingReceipt.nativeMessages ||
      !pendingReceipt.clientUserMessageId ||
      pendingReceipt.prompt === undefined
    )
      return { outcome: "send_unconfirmed" };
    if (!(await accountMatches()) || (canDispatch !== undefined && !(await canDispatch())))
      return { outcome: "send_unconfirmed" };
    signal?.throwIfAborted();
    const dispatching: DirectGoalNativeSendReceipt = {
      ...pendingReceipt,
      dispatchState: "dispatching",
    };
    if (!(await recordReceipt(dispatching))) return { outcome: "send_unconfirmed" };
    pendingReceipt = dispatching;
    let response: Awaited<ReturnType<DesktopGoalNativeSender["dispatch"]>>;
    try {
      response = await nativeSender.dispatch(
        {
          operationId: dispatching.operationId,
          conversationUrl: url,
          accountSourceId: dispatching.accountSourceId,
          clientUserMessageId: dispatching.clientUserMessageId as string,
          prompt: dispatching.prompt as string,
          nativeMessages: dispatching.nativeMessages as RecordValue,
        },
        signal,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "nativeDispatchNotStarted" in error &&
        error.nativeDispatchNotStarted === true
      ) {
        pendingReceipt = { ...dispatching, dispatchState: "prepared" };
        await recordReceipt(pendingReceipt);
      }
      throw error;
    }
    if (
      response.threadId !== threadId ||
      response.clientUserMessageId !== dispatching.clientUserMessageId
    )
      throw new Error("DIRECT_GOAL_DESKTOP_SEND_RECEIPT_INVALID");
    if (!response.accepted) {
      pendingReceipt = { ...dispatching, dispatchState: "prepared" };
      await recordReceipt(pendingReceipt);
      return { outcome: "send_unconfirmed" };
    }
    return { outcome: (await inspect()) === "sent" ? "sent" : "send_unconfirmed" };
  };
  let before: string;
  try {
    signal?.throwIfAborted();
    before = await inspect();
  } catch (error) {
    // No sender has been entered. Any failed pre-send read must release this
    // attempt's claim, not leave a never-sent message as an uncertain dispatch.
    // Inspection of an older uncertain dispatch still preserves that claim.
    if (chatAccountRateLimitRetryAt(error) !== undefined)
      return { outcome: "rate_limited", error: String(error) };
    if (target.operation === "send" || signal?.aborted)
      return {
        outcome: "send_not_started",
        error: String(error),
        ...(error instanceof Error && error.cause !== undefined ? { cause: error.cause } : {}),
      };
    throw error;
  }
  // Retire an obsolete request only after a different input has a completed
  // reply on the verified current branch. This is not proof that the old send
  // succeeded or failed. It never replays that send and cannot interrupt work
  // still in progress. The store retains/promotes the newer final separately.
  if (before === "superseded_completed_input") return { outcome: "superseded" };
  if (before === "sent") return { outcome: "sent" };
  if (pendingReceipt?.kind === "native_message_prepared") {
    if (before === "ready" && pendingReceipt.dispatchState === "prepared")
      return dispatchPrepared();
    return { outcome: "send_unconfirmed" };
  }
  if (
    target.operation === "inspect" &&
    target.draft.state === "dispatching" &&
    before === "superseded"
  )
    return { outcome: "send_unconfirmed" };
  if (before !== "ready" || target.operation === "inspect") return { outcome: before };
  // The Goal store owns the durable dispatching transaction. A missing host
  // response is an uncertain dispatch, never permission to send another turn.
  if (target.draft.state !== "dispatching")
    throw new Error("DIRECT_GOAL_DESKTOP_DISPATCH_NOT_CLAIMED");
  let prompt = goalContinuationPrompt(target.goalId);
  try {
    signal?.throwIfAborted();
    if (resolveConnectorId !== undefined)
      prompt = desktopGoalContinuationPrompt(await resolveConnectorId(), target.goalId);
    if (!(await accountMatches())) return { outcome: "account_changed" };
    // Reads and connector selection can outlive a pause, completion or delete.
    // Revalidate the durable draft after those awaits, before entering sender.
    if (canDispatch !== undefined && !(await canDispatch())) return { outcome: "send_not_started" };
    signal?.throwIfAborted();
  } catch (error) {
    // Selection is resolved before entering the native sender. Preserve the
    // original error without leaving an unsent request in an uncertain claim.
    return { outcome: "send_not_started", error: String(error) };
  }
  let sent: unknown;
  if (nativeSender) {
    if (!recordReceipt || !target.accountSourceId)
      return { outcome: "send_not_started", error: "DIRECT_GOAL_DESKTOP_RECEIPT_STORE_REQUIRED" };
    const prepared = await nativeSender.prepare(
      prompt,
      `goal-continuation:${target.draft.token}`,
      signal,
    );
    if (
      prepared.operationId !== `goal-continuation:${target.draft.token}` ||
      prepared.conversationUrl !== url ||
      prepared.accountSourceId !== target.accountSourceId
    )
      throw new Error("DIRECT_GOAL_DESKTOP_SEND_RECEIPT_INVALID");
    pendingReceipt = {
      kind: "native_message_prepared",
      operationId: prepared.operationId,
      threadId,
      accountSourceId: prepared.accountSourceId,
      clientUserMessageId: prepared.clientUserMessageId,
      nativeMessages: prepared.nativeMessages,
      prompt: prepared.prompt,
      dispatchState: "prepared",
    };
    if (!(await recordReceipt(pendingReceipt))) return { outcome: "send_not_started" };
    return dispatchPrepared();
  }
  try {
    sent = await call("send_message_to_thread", { threadId, prompt });
  } catch (error) {
    // This typed error is produced before native dispatch by the shared
    // account boundary. An error after native dispatch remains uncertain.
    if (error instanceof ChatAccountRateLimitError)
      return { outcome: "rate_limited", error: String(error) };
    throw error;
  }
  const receipt = nativePayload(sent);
  if (receipt.threadId !== threadId) throw new Error("DIRECT_GOAL_DESKTOP_SEND_RECEIPT_INVALID");
  if (recordReceipt !== undefined && target.accountSourceId !== undefined) {
    if (!(await accountMatches())) return { outcome: "send_unconfirmed" };
    const stored = await recordReceipt({
      kind: "native_host_acknowledged",
      operationId: `goal-continuation:${target.draft.token}`,
      threadId,
      accountSourceId: target.accountSourceId,
    });
    return { outcome: stored ? "sent" : "send_unconfirmed" };
  }
  // The installed native sender returns only threadId, not its user-message
  // identity. A later matching prompt cannot prove which caller sent it.
  // Keep the durable dispatch claim until an identity-bearing receipt exists.
  await inspect();
  return { outcome: "send_unconfirmed" };
}

/** The installed Chat composer recognizes app:// mentions through tpi/UA.
 * Its native follow-up otherwise drops inherited connector/plugin hints.
 * Keep the agreed wording while selecting the actual installed app by link.
 * Web Chat may display this native app-link serialization literally.
 */
export function desktopGoalContinuationPrompt(connectorId: string, goalId: string): string {
  if (!/^asdk_app_[a-z0-9]+$/i.test(connectorId))
    throw new Error("DESKTOP_GOAL_CONNECTOR_ID_INVALID");
  const prompt = goalContinuationPrompt(goalId);
  const newline = prompt.indexOf("\n");
  const label = prompt.slice(0, newline).replaceAll("]", "\\]");
  return `[${label}](app://${connectorId})${prompt.slice(newline)}`;
}

/** Project only the exact service.get current parent chain, retaining every input text. */
export function projectDesktopChatGoalReadback(result: unknown, threadId: string): RecordValue {
  const data = nativePayload(result);
  if (data.conversation_id !== threadId && data.id !== threadId)
    return { thread: { id: data.conversation_id ?? data.id, kind: "chatgpt" } };
  const mapping = object(data.mapping);
  if (!mapping || typeof data.current_node !== "string")
    throw new Error("DIRECT_GOAL_DESKTOP_READBACK_INVALID");
  const messages: RecordValue[] = [];
  const visited = new Set<string>();
  const messageIds = new Set<string>();
  let nodeId: unknown = data.current_node;
  while (typeof nodeId === "string") {
    if (!nodeId || visited.has(nodeId)) throw new Error("DIRECT_GOAL_DESKTOP_BRANCH_INVALID");
    visited.add(nodeId);
    const node = object(mapping[nodeId]);
    if (!node || !Object.hasOwn(node, "parent"))
      throw new Error("DIRECT_GOAL_DESKTOP_BRANCH_INVALID");
    const message = object(node.message);
    if (message) {
      if (typeof message.id !== "string" || !message.id || messageIds.has(message.id))
        throw new Error("DIRECT_GOAL_DESKTOP_BRANCH_INVALID");
      messageIds.add(message.id);
      messages.push(message);
    }
    nodeId = node.parent;
    if (nodeId !== null && typeof nodeId !== "string")
      throw new Error("DIRECT_GOAL_DESKTOP_BRANCH_INVALID");
  }
  messages.reverse();
  let current = messages.at(-1);
  const status = object(data.status)?.type ?? data.status;
  const error = data.error ?? current?.error;
  if (
    status === "systemError" ||
    current?.status === "finished_with_error" ||
    current?.status === "error" ||
    error != null
  )
    throw new Error(
      `DIRECT_GOAL_DESKTOP_CONVERSATION_FAILED:${String(status === "systemError" ? status : (current?.status ?? status ?? "error"))}${error == null ? "" : `:${typeof error === "string" ? error : JSON.stringify(error)}`}`,
      { cause: result },
    );
  // The renderer can persist a trailing preamble after its same-turn final.
  const metadata = object(current?.metadata);
  if (
    metadata?.is_thinking_preamble_message === true &&
    typeof metadata.working_turn_id === "string" &&
    metadata.working_turn_id
  ) {
    const finals = messages.filter(
      (message) =>
        isFinal(message) &&
        object(message.metadata)?.working_turn_id === metadata.working_turn_id &&
        (metadata.turn_exchange_id === undefined ||
          object(message.metadata)?.turn_exchange_id === metadata.turn_exchange_id),
    );
    if (finals.length === 1) current = finals[0];
  }
  const currentIndex = current === undefined ? -1 : messages.indexOf(current);
  const completed =
    current !== undefined && isFinal(current) && status !== "active" && status !== "in_progress";
  const turns: RecordValue[] = [];
  for (const message of messages.slice(0, currentIndex + 1)) {
    const role = object(message.author)?.role;
    if (role === "user" || turns.length === 0) turns.push({ status: "in_progress", items: [] });
    const turn = turns.at(-1) as RecordValue;
    const items = turn.items as RecordValue[];
    const content = object(message.content);
    items.push(
      role === "user"
        ? {
            type: "userMessage",
            id: message.id,
            content: Array.isArray(content?.parts)
              ? content.parts
                  .filter((part): part is string => typeof part === "string")
                  .map((text) => ({ type: "text", text }))
              : typeof content?.text === "string"
                ? [{ type: "text", text: content.text }]
                : [],
          }
        : { type: isFinal(message) ? "agentMessage" : "chatMessage", id: message.id },
    );
    if (isFinal(message)) turn.status = "completed";
  }
  return {
    thread: { id: threadId, kind: "chatgpt", status: { type: completed ? "idle" : "active" } },
    turns: turns.reverse(),
    page: { order: "newest_first", hasMore: false },
  };
}

function isFinal(message: RecordValue): boolean {
  return (
    object(message.author)?.role === "assistant" &&
    message.status === "finished_successfully" &&
    message.end_turn === true &&
    message.channel === "final"
  );
}

/** A completed newer request makes the old wake-up obsolete without proving
 * its delivery. An identical continuation prompt is not a correlated receipt.
 * Missing identities, partial turns and active conversations remain uncertain.
 */
function hasCompletedSupersedingInput(data: RecordValue, anchor: string): boolean {
  if (object(object(data.thread)?.status)?.type !== "idle" || !Array.isArray(data.turns))
    return false;
  const newest = object(data.turns[0]);
  if (newest?.status !== "completed" || !Array.isArray(newest.items)) return false;
  const items = [...data.turns]
    .reverse()
    .flatMap((turn) =>
      Array.isArray(object(turn)?.items) ? (object(turn)?.items as unknown[]) : [],
    )
    .map(object);
  const current = items.at(-1);
  const anchorAt = items.findIndex((item) => item?.type === "agentMessage" && item.id === anchor);
  if (
    anchorAt < 0 ||
    current?.type !== "agentMessage" ||
    typeof current.id !== "string" ||
    !current.id ||
    current.id === anchor
  )
    return false;
  const inputs = items.slice(anchorAt + 1, -1).filter((item) => item?.type === "userMessage");
  const input = inputs.at(-1);
  if (
    typeof input?.id !== "string" ||
    !input.id ||
    input.id === anchor ||
    input.id === current.id ||
    items.filter((item) => item?.id === input.id).length !== 1 ||
    items.filter((item) => item?.id === current.id).length !== 1 ||
    items.filter((item) => item?.id === anchor).length !== 1 ||
    !newest.items.some((value) => object(value)?.id === input.id)
  )
    return false;
  const text = Array.isArray(input.content)
    ? input.content
        .map(object)
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part?.text as string)
        .join("\n")
        .trim()
    : "";
  const selectedApp = /\]\(app:\/\/(asdk_app_[a-z0-9]+)\)/i.exec(text)?.[1];
  const goalId = /(?:^|\n)Goal ID: ([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.exec(text)?.[1];
  const continuation =
    isGoalContinuationPrompt(text) ||
    (selectedApp !== undefined &&
      goalId !== undefined &&
      text === desktopGoalContinuationPrompt(selectedApp, goalId).trim());
  return text.length > 0 && !continuation;
}

/** One exact Chat readback after a native Chat completion event; never a catalog scan. */
export function inspectDesktopChatGoalReadback(
  result: unknown,
  threadId: string,
  afterMessageId: string,
): string {
  const data = nativePayload(result);
  const thread = object(data.thread);
  if (thread?.id !== threadId || thread.kind !== "chatgpt") return "conversation_changed";
  if (!Array.isArray(data.turns) || object(data.page)?.order !== "newest_first")
    throw new Error("DIRECT_GOAL_DESKTOP_READBACK_INVALID");
  assertDesktopChatNotFailed(data);
  const turns = [...data.turns].reverse().map(object);
  let anchored = false;
  let anchorCompleted = false;
  let advanced = false;
  for (const turn of turns) {
    if (!Array.isArray(turn?.items)) continue;
    for (const value of turn.items) {
      const item = object(value);
      if (item?.id === afterMessageId && item.type === "agentMessage") {
        anchored = true;
        anchorCompleted = turn.status === "completed";
        continue;
      }
      if (!anchored || item === undefined) continue;
      if (item.type === "userMessage") {
        return "superseded";
      }
      advanced = true;
    }
  }
  if (!anchored) return "anchor_not_visible";
  if (advanced) return "superseded";
  if (!anchorCompleted || object(thread.status)?.type !== "idle") return "generating";
  return "ready";
}

/** The installed native reader projects fTr(current_node, mapping): this is
 * the current parent chain, not arrival order or an unordered messages array.
 * Its agentMessage entries are completed assistant-message render items.
 */
export async function readDesktopChatBranchCompletion(
  read: (args: RecordValue) => Promise<unknown>,
  threadId: string,
  anchor: string | undefined,
  signal: AbortSignal,
): Promise<{ finalMessageId: string; ancestorMessageIds: string[] } | undefined> {
  let cursor: string | undefined;
  let head: RecordValue | undefined;
  const turns: unknown[] = [];
  const seen = new Set<string>();
  for (;;) {
    signal.throwIfAborted();
    const page = nativePayload(
      await read({ threadId, turnLimit: 2, includeOutputs: true, ...(cursor ? { cursor } : {}) }),
    );
    if (
      object(page.thread)?.id !== threadId ||
      object(page.thread)?.kind !== "chatgpt" ||
      object(page.page)?.order !== "newest_first" ||
      !Array.isArray(page.turns)
    )
      throw new Error("DIRECT_GOAL_DESKTOP_READBACK_INVALID");
    head ??= page;
    assertDesktopChatNotFailed(head);
    if (object(object(head.thread)?.status)?.type !== "idle") return undefined;
    turns.push(...page.turns);
    const items = [...turns]
      .reverse()
      .flatMap((turn) =>
        Array.isArray(object(turn)?.items) ? (object(turn)?.items as unknown[]) : [],
      )
      .map(object);
    const current = items.at(-1);
    if (current?.type !== "agentMessage" || typeof current.id !== "string" || current.id === anchor)
      return undefined;
    // With no prior verified anchor there is no evidence that an old cached
    // answer follows the nominated completion. Still perform the exact read.
    if (anchor === undefined) return undefined;
    const anchorAt = items.findIndex((item) => item?.id === anchor && item.type === "agentMessage");
    if (anchorAt >= 0) {
      const ancestors = items
        .slice(0, -1)
        .reverse()
        .flatMap((item) => (typeof item?.id === "string" ? [item.id] : []));
      if (new Set(ancestors).size !== ancestors.length || ancestors.includes(current.id))
        throw new Error("DIRECT_GOAL_DESKTOP_BRANCH_INVALID");
      return { finalMessageId: current.id, ancestorMessageIds: ancestors };
    }
    const next = object(page.page);
    if (next?.hasMore !== true) return undefined;
    if (typeof next.nextCursor !== "string" || !next.nextCursor || seen.has(next.nextCursor))
      throw new Error("DIRECT_GOAL_DESKTOP_CURSOR_INVALID");
    cursor = next.nextCursor;
    seen.add(cursor);
  }
}

function assertDesktopChatNotFailed(data: RecordValue): void {
  const status = object(object(data.thread)?.status);
  if (status?.type !== "systemError") return;
  const latestTurn = Array.isArray(data.turns) ? object(data.turns[0]) : undefined;
  const detail = status.error ?? latestTurn?.error;
  throw new Error(
    `DIRECT_GOAL_DESKTOP_CONVERSATION_FAILED:systemError${
      detail == null ? "" : `:${typeof detail === "string" ? detail : JSON.stringify(detail)}`
    }`,
    { cause: { status, error: detail } },
  );
}

function object(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function nativePayload(value: unknown): RecordValue {
  const result = object(value);
  if (result === undefined) throw new Error("DIRECT_GOAL_DESKTOP_READBACK_INVALID");
  if (result.isError === true) {
    const text = Array.isArray(result.content)
      ? result.content
          .map(object)
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part?.text as string)
          .join("\n")
      : "";
    // The controller reports String(error). Keep the native diagnostic visible
    // there as well as retaining the complete result in cause.
    const detail = text || JSON.stringify(result.structuredContent ?? result);
    throw new Error(`DIRECT_GOAL_DESKTOP_NATIVE_TOOL_FAILED:${detail}`, { cause: value });
  }
  if (result.structuredContent !== undefined) {
    if (object(result.structuredContent) === undefined)
      throw new Error("DIRECT_GOAL_DESKTOP_READBACK_INVALID");
    return nativePayload(result.structuredContent);
  }
  if (!Array.isArray(result.content)) return result;
  const texts = result.content.map(object).filter((entry) => entry?.type === "text");
  if (texts.length !== 1 || typeof texts[0]?.text !== "string")
    throw new Error("DIRECT_GOAL_DESKTOP_READBACK_INVALID");
  return nativePayload(JSON.parse(texts[0].text));
}
