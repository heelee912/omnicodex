import { randomUUID } from "node:crypto";
import { normalizeChatGptConversationUrl } from "../infrastructure/chatgpt/chatgpt-conversation-route.js";
import type { BrowserNativeExecutor } from "./browser-native-executor.js";

export interface ApprovedConversationSyncTarget {
  readonly conversationUrl: string;
  readonly pendingMessageId: string;
  readonly userMessageId?: string;
}

export async function synchronizeApprovedChromeConversation(
  executor: Pick<BrowserNativeExecutor, "beginActivity" | "call" | "finishActivity">,
  target: ApprovedConversationSyncTarget,
  signal?: AbortSignal,
): Promise<unknown> {
  const code = chromeApprovedConversationSyncCode(target);
  // The native tracker replays completed turn IDs from its rollout. A retry
  // must never reuse a completed turn, even for the same approval receipt.
  const activity = `approval-ui:${randomUUID()}`;
  const context = { callerSessionId: `approval-ui:${target.conversationUrl}` };
  await executor.beginActivity(activity, context);
  try {
    return await executor.call(
      {
        operation: "exec",
        surface: "chrome",
        title: "Synchronize approved Chat conversation",
        code,
      },
      { ...context, activityBinding: activity, ...(signal === undefined ? {} : { signal }) },
    );
  } finally {
    // Native turn completion releases claimed user tabs and leaves them open.
    await executor.finishActivity(activity, context);
  }
}

/** One native Chrome readback after a durable server approval, never an approval actuator. */
export function chromeApprovedConversationSyncCode(target: ApprovedConversationSyncTarget): string {
  const conversationUrl = normalizeChatGptConversationUrl(target.conversationUrl);
  if (
    conversationUrl === undefined ||
    !/^[a-zA-Z0-9_-]+$/u.test(target.pendingMessageId) ||
    target.pendingMessageId.length > 128 ||
    (target.userMessageId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/u.test(target.userMessageId))
  ) {
    throw new Error("Exact approved conversation and message required for Chrome synchronization");
  }
  return `
const target = ${JSON.stringify({ ...target, conversationUrl })};
const done = (outcome, candidateCount) => JSON.stringify({ outcome, ...(candidateCount === undefined ? {} : { candidateCount }) });
const normalize = (value) => {
  try { const url = new URL(value); return url.origin + url.pathname; } catch { return undefined; }
};
const candidates = (await browser.user.openTabs()).filter(tab => normalize(tab.url) === target.conversationUrl);
if (candidates.length !== 1) return done(candidates.length ? "conversation_ambiguous" : "conversation_not_open", candidates.length);
const tab = await browser.user.claimTab(candidates[0]);
if (normalize(await tab.url()) !== target.conversationUrl) return done("conversation_changed");
const snapshot = await tab.playwright.evaluate(({pendingMessageId, userMessageId}) => {
  const visible = element => element.getClientRects().length > 0;
  const messages = [...document.querySelectorAll("[data-message-id]")].filter(visible);
  const pending = messages.find(element => element.getAttribute("data-message-id") === pendingMessageId);
  const approvalPattern = /Allow file materialization\\?|파일 생성을 허용할까요\\?/;
  const approvalHeading = [...document.querySelectorAll("h2")].find(element => visible(element) && approvalPattern.test(element.textContent ?? ""));
  const user = messages.find(element => element.getAttribute("data-message-id") === userMessageId && element.getAttribute("data-message-author-role") === "user");
  const composer = document.querySelector("#prompt-textarea");
  const form = composer?.closest("form");
  return {
    responding: !!document.querySelector('[data-testid="stop-button"]'),
    pendingIsLatest: !!pending && messages.at(-1) === pending || !!user && messages.at(-1) === user,
    approvalVisible: !!approvalHeading || !!pending && approvalPattern.test(pending.textContent ?? ""),
    composerPresent: !!composer && visible(composer),
    draft: composer?.tagName === "TEXTAREA" || composer?.tagName === "INPUT"
      ? composer.value : composer?.textContent ?? "",
    composerHasAttachments: !form || [...form.querySelectorAll('input[type="file"]')].some(input => input.files?.length > 0) ||
      [...form.querySelectorAll("button")].some(button => /remove.*(?:file|attachment)|(?:파일|첨부).*삭제/i.test(button.getAttribute("aria-label") ?? ""))
  };
}, target);
if (snapshot.responding) return done("response_in_progress");
if (!snapshot.approvalVisible) return done("approval_not_visible");
if (!snapshot.pendingIsLatest) return done("approval_identity_unresolved");
if (!snapshot.composerPresent || snapshot.draft.trim() || snapshot.composerHasAttachments) return done("draft_preserved");
if (normalize(await tab.url()) !== target.conversationUrl) return done("conversation_changed");
// Approval can resume the model while the stale card is still visible.
// Recheck immediately before navigation, including responses started during readback.
if (await tab.playwright.evaluate(() => !!document.querySelector('[data-testid="stop-button"]')))
  return done("response_in_progress");
await tab.reload();
return done("refreshed", 1);
`;
}
