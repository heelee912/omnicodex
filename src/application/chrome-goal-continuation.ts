import { randomUUID } from "node:crypto";
import { normalizeChatGptConversationUrl } from "../infrastructure/chatgpt/chatgpt-conversation-route.js";
import type { DirectGoalContinuationWork } from "../infrastructure/mcp/direct-goal-store.js";
import type { BrowserNativeExecutor } from "./browser-native-executor.js";

export const GOAL_CONTINUATION_PROMPT =
  "[Goal 자동 진행]\n사용자가 활성화한 Goal의 자동 재개입니다. 현재 Goal과 진행 기록을 확인하고, 필요한 파일·브라우저·앱 도구를 사용해 미완료 작업을 직접 계속 수행하세요. 등록 도구는 직접 action 또는 functions.exec의 tools 객체 중 현재 제공되는 정상 호출 경로로 사용하세요. ALL_TOOLS는 같은 등록 도구의 이름과 기능을 찾는 카탈로그입니다. 도구 호출이 실패하면 실제 원인을 확인하고 가능한 복구를 수행한 뒤 다시 시도하세요. 목표를 달성했다면 완료 처리하세요.";

export function goalContinuationPrompt(goalId: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(goalId))
    throw new Error("DIRECT_GOAL_CONTINUATION_ID_INVALID");
  return `${GOAL_CONTINUATION_PROMPT}\n\nGoal ID: ${goalId}`;
}

export function isGoalContinuationPrompt(value: string): boolean {
  return (
    value === GOAL_CONTINUATION_PROMPT ||
    new RegExp(
      `^${escapeRegExp(GOAL_CONTINUATION_PROMPT)}\\n\\nGoal ID: [a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$`,
      "i",
    ).test(value)
  );
}

export interface ChromeGoalContinuationTarget extends DirectGoalContinuationWork {
  readonly operation: "inspect" | "send";
  /** A previous native result proved insertion stopped before any send click. */
  readonly resumePreparedDraft?: boolean;
}

export async function continueChromeGoal(
  executor: Pick<BrowserNativeExecutor, "beginActivity" | "call" | "finishActivity">,
  target: ChromeGoalContinuationTarget,
  signal?: AbortSignal,
): Promise<unknown> {
  const activity = `goal-${target.operation}:${randomUUID()}`;
  const context = { callerSessionId: `goal-ui:${target.conversationUrl}` };
  await executor.beginActivity(activity, context);
  try {
    return await executor.call(
      {
        operation: "exec",
        surface: "chrome",
        code: chromeGoalContinuationCode(target),
      },
      { ...context, activityBinding: activity, ...(signal === undefined ? {} : { signal }) },
    );
  } finally {
    await executor.finishActivity(activity, context);
  }
}

/** Adapted from Chat On Steroids' settle/send/ack flow. Native browser operations own the UI. */
export function chromeGoalContinuationCode(target: ChromeGoalContinuationTarget): string {
  const conversationUrl = normalizeChatGptConversationUrl(target.conversationUrl);
  if (
    conversationUrl === undefined ||
    !/^[A-Za-z0-9_:-]{1,128}$/.test(target.draft.afterMessageId) ||
    !["inspect", "send"].includes(target.operation)
  )
    throw new Error("DIRECT_GOAL_CHROME_TARGET_INVALID");
  return `
const target = ${JSON.stringify({ conversationUrl, afterMessageId: target.draft.afterMessageId, operation: target.operation, prompt: goalContinuationPrompt(target.goalId), resumePreparedDraft: target.resumePreparedDraft === true })};
const done = outcome => JSON.stringify({ outcome });
const normalize = value => { try { const url = new URL(value); return url.origin + url.pathname; } catch { return undefined; } };
const candidates = (await browser.user.openTabs()).filter(tab => normalize(tab.url) === target.conversationUrl);
if (candidates.length !== 1) return done(candidates.length ? "conversation_ambiguous" : "conversation_not_open");
let tab;
let temporary = false;
try {
  tab = await browser.user.claimTab(candidates[0]);
} catch (error) {
  if (!/^Tab [0-9]+ is already part of browser session [A-Za-z0-9-]+$/.test(String(error?.message ?? error))) throw error;
  // Another native browser session owns the visible tab. Use an independent
  // view of this exact conversation; never take over or mutate its draft.
  tab = await browser.tabs.new();
  temporary = true;
}
try {
if (temporary) await tab.goto(target.conversationUrl);
if (normalize(await tab.url()) !== target.conversationUrl) return done("conversation_changed");
const inspect = () => tab.playwright.evaluate(({afterMessageId, prompt}) => {
  const visible = element => element.getClientRects().length > 0;
  const messages = [...document.querySelectorAll("[data-message-id]")].filter(visible);
  const index = messages.findIndex(element => element.getAttribute("data-message-id") === afterMessageId);
  const user = index < 0 ? undefined : messages.slice(index + 1).find(element => element.getAttribute("data-message-author-role") === "user");
  const composer = document.querySelector("#prompt-textarea");
  const form = composer?.closest("form");
  const busy = [...document.querySelectorAll('button[data-testid="stop-button"], button[data-testid="composer-stop-button"]')].some(visible);
  const draft = composer?.tagName === "TEXTAREA" || composer?.tagName === "INPUT"
    ? composer.value : composer?.textContent ?? "";
  const attachments = !form || [...form.querySelectorAll('input[type="file"]')].some(input => input.files?.length > 0) ||
    [...form.querySelectorAll("button")].some(button => /remove.*(?:file|attachment)|(?:파일|첨부).*삭제/i.test(button.getAttribute("aria-label") ?? ""));
  const userContent = user?.querySelector('[data-testid="collapsible-user-message-content"]') ?? user;
  const sent = !!userContent && (userContent.textContent ?? "").trim() === prompt;
  return { sent, advanced: !!user || index >= 0 && messages.at(-1)?.getAttribute("data-message-id") !== afterMessageId,
    present: index >= 0, text: index < 0 ? "" : messages[index].textContent,
    composer: !!composer && visible(composer), draft, attachments, busy };
}, target);
let first = await inspect();
// A newly navigated view may hydrate its transcript after goto resolves.
// Wait only for this exact anchor, and never activate the composer while busy.
for (let attempt = 0; temporary && (!first.present || !first.composer || first.attachments) && !first.sent && attempt < 10; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 500));
  if (normalize(await tab.url()) !== target.conversationUrl) return done("conversation_changed");
  first = await inspect();
}
// Text already present before this activation is another input, not a receipt
// for this dispatch. It may have been entered manually or by another caller.
if (first.sent) return done("superseded");
if (first.advanced) return done("superseded");
if (!first.present) return done("anchor_not_visible");
const prepared = target.resumePreparedDraft && first.draft.trim() === target.prompt;
if (!first.composer || first.attachments || first.draft.trim() && !prepared) return done("draft_preserved");
if (first.busy) return done("generating");
let stable = false;
for (let attempt = 0; attempt < (temporary ? 10 : 1); attempt++) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  if (normalize(await tab.url()) !== target.conversationUrl) return done("conversation_changed");
  const settled = await inspect();
  if (JSON.stringify(first) === JSON.stringify(settled)) { stable = true; break; }
  if (!temporary) return done("not_settled");
  if (settled.sent) return done("superseded");
  if (settled.advanced) return done("superseded");
  if (settled.busy) return done("generating");
  if (settled.draft !== first.draft) return done("draft_preserved");
  first = settled;
}
if (!stable) return done("not_settled");
if (!first.present) return done("anchor_not_visible");
if (!first.composer || first.attachments) return done("draft_preserved");
if (target.operation === "inspect") return done("ready");
if (normalize(await tab.url()) !== target.conversationUrl) return done("conversation_changed");
if (!prepared) await tab.playwright.locator("#prompt-textarea").fill(target.prompt);
const inserted = await inspect();
if (inserted.advanced || inserted.busy || inserted.attachments || inserted.draft.trim() !== target.prompt) return done("inserted_not_sent");
// A contenteditable DOM update can precede the host composer's input handling.
// Keep the same draft stable before its one permitted send activation.
await new Promise(resolve => setTimeout(resolve, 1000));
const inputSettled = await inspect();
if (JSON.stringify(inserted) !== JSON.stringify(inputSettled)) return done("inserted_not_sent");
if (normalize(await tab.url()) !== target.conversationUrl) return done("inserted_not_sent");
const send = tab.playwright.getByTestId("send-button");
if (!await send.isVisible() || !await send.isEnabled()) return done("inserted_not_sent");
// Verify the current send control, then use native focused keyboard activation.
// Pointer activation has returned successfully without submitting in this host.
const sendState = await tab.ax.get("state", { disableDiffing: true });
const sendElements = [...sendState.matchAll(/^\\s*(\\d+) button\\b[^\\r\\n]*\\bID: composer-submit-button(?:,|\\s*$)/gm)];
if (sendElements.length !== 1) return done("inserted_not_sent");
const beforeClick = await inspect();
if (beforeClick.advanced || beforeClick.busy || beforeClick.attachments || beforeClick.draft.trim() !== target.prompt)
  return done("inserted_not_sent");
if (normalize(await tab.url()) !== target.conversationUrl) return done("inserted_not_sent");
await send.press("Enter");
// Retain this browser activity through asynchronous UI acknowledgement. These
// are reads only: an absent acknowledgement never authorizes a second activation.
for (let attempt = 0; attempt < 3; attempt++) {
  if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 500));
  if (normalize(await tab.url()) !== target.conversationUrl) return done("send_unconfirmed");
  const confirmed = await inspect();
  if (confirmed.sent) return done("sent");
  if (confirmed.advanced) return done("superseded");
}
return done("send_unconfirmed");
} finally {
  if (temporary) await tab.close();
}
`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
