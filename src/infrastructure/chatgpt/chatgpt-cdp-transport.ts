import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { isDesktopNativeSendExpression } from "../windows/desktop-chat-native-sender.js";
import { isDesktopGoalBindingReadExpression } from "../windows/desktop-goal-binding-reader.js";
import {
  assertExplicitLoopbackCdpEndpoint,
  type ChatGptAccessibleNode,
  type ChatGptApprovalBinding,
  type ChatGptApprovalSnapshot,
  type ChatGptApprovalSurface,
} from "./chatgpt-app-approval-adapter.js";
import { normalizeChatGptConversationUrl } from "./chatgpt-conversation-route.js";
import {
  isOracleChatGptApprovalRuntimeUrl,
  isOracleChatGptServerApprovalScanExpression,
  ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION,
  ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION,
  oracleChatGptApprovalRuntimeUrl,
} from "./oracle-chatgpt-server-approval-script.js";
import { isOracleGoalContinuationExpression } from "./oracle-goal-continuation.js";
import { isOracleNativeTurnSubscriptionExpression } from "./oracle-native-turn-subscription.js";

export interface CdpTarget {
  readonly id: string;
  readonly type?: string;
  readonly parentId?: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}
export interface ChatGptTargetInventory {
  readonly targets: readonly CdpTarget[];
  readonly connectorTargets: readonly CdpTarget[];
}
export interface CdpTransportOptions {
  readonly endpoint: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Allow exact Codex Desktop renderers and their ChatGPT webviews on the verified loopback port. */
  readonly allowDesktopAppTargets?: boolean;
  /**
   * Exact HTTPS authorization-server origins that a run-owned settings target
   * may visit during OAuth. The transport never reads DOM content while the
   * target is on one of these origins.
   */
  readonly oauthAuthorizationOrigins?: readonly string[];
}
export type OwnedSettingsTargetLocation =
  | {
      readonly kind: "chatgpt_settings";
      readonly target: CdpTarget;
    }
  | {
      readonly kind:
        | "owned_navigation_pending"
        | "oauth_authorization"
        | "chatgpt_oauth_callback"
        | "chatgpt_settings_return";
      readonly targetId: string;
      /** Sanitized route with OAuth query, fragment, and callback identity removed. */
      readonly route: string;
    };
export interface CdpWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void,
    options?: { once?: boolean },
  ): void;
}
export type CdpWebSocketFactory = (url: string) => CdpWebSocketLike;
export interface CdpSessionOptions {
  readonly factory: CdpWebSocketFactory;
  readonly targetId?: string;
  /**
   * Authoritative receipt from the immediately preceding /json/list or
   * /json/new call. Supplying it avoids a second global inventory read while
   * a newly-created renderer is navigating. The transport still validates the
   * exact ChatGPT origin and loopback WebSocket binding before use.
   */
  readonly target?: CdpTarget;
  /** null waits for the caller's AbortSignal without a session deadline. */
  readonly timeoutMs?: number | null;
  readonly maxPending?: number;
  /**
   * Optional caller-selected maximum UTF-8 bytes for one complete CDP
   * WebSocket text frame. Omission accepts every frame delivered by the
   * underlying WebSocket implementation.
   */
  readonly maxFrameBytes?: number;
}
/**
 * A loopback CDP control request is a health probe, not a user task. If the
 * browser/tunnel accepts the connection but never produces a response, keeping
 * the request pending forever prevents recovery and leaks run-owned targets.
 * Callers can select a different lease; omission uses this reconnectable
 * liveness lease and does not impose an overall workflow deadline.
 */
export const DEFAULT_CDP_CONTROL_LIVENESS_TIMEOUT_MS = 10_000;
/** Page creation may include renderer startup and is slower than inventory reads. */
export const DEFAULT_CDP_TARGET_CREATE_LIVENESS_TIMEOUT_MS = 60_000;
/** Bounded reconciliation window for an ambiguous /json/new response. */
export const DEFAULT_CDP_TARGET_RECEIPT_RECOVERY_TIMEOUT_MS = 60_000;
/**
 * Maximum silence for one CDP command when the caller did not select a lease.
 * This bounds a dead WebSocket only. Long-running workflows remain unbounded
 * and may continue on a freshly acquired session after a liveness failure.
 */
export const DEFAULT_CDP_COMMAND_LIVENESS_TIMEOUT_MS = 30_000;
/**
 * Legacy call sites explicitly pass this value. It now represents the largest
 * precisely expressible byte count instead of inventing a product-level CDP
 * frame ceiling. New call sites should omit maxFrameBytes for no caller cap.
 */
export const DEFAULT_CDP_FRAME_BUDGET_BYTES = Number.MAX_SAFE_INTEGER;
/** Largest valid explicit byte budget; transport/runtime limits remain authoritative. */
export const MAX_CDP_FRAME_BUDGET_BYTES = Number.MAX_SAFE_INTEGER;

/**
 * Returns the one Chat conversation selected in a Desktop renderer.  Approval
 * events are broadcast across Desktop windows, so their socket target is not
 * necessarily the renderer that owns the visible approval card.
 */
export const DESKTOP_CHAT_SELECTED_CONVERSATION_EXPRESSION = `(() => {
  const prefix = "chatgpt:conversation:";
  const selected = [...document.querySelectorAll("[data-sidebar-chatgpt-conversation-key]")]
    .filter((element) => element.querySelector('[aria-current="page"]') !== null)
    .map((element) => element.getAttribute("data-sidebar-chatgpt-conversation-key"))
    .filter((value) => typeof value === "string" && value.startsWith(prefix))
    .map((value) => value.slice(prefix.length))
    .filter((value) => /^[a-z0-9-]+$/iu.test(value));
  return selected.length === 1 ? selected[0] : null;
})()`;

/**
 * Oracle 0.17.1 installs `window.__oracleAppApprovalWatcher` for every leading
 * app mention and has no supported switch for disabling it. The browser-level
 * ownership guard installs this exact script before a newly-created page is
 * allowed to run. The marker remains for the lifetime of that page; the guard
 * itself is the liveness owner. The same bootstrap maintains a small,
 * mutation-driven approval index so the remote watcher does not repeatedly
 * traverse a long ChatGPT document.
 */
export const ORACLE_MATERIALIZATION_OPTIONS_LABEL = "file materialization options";
export const ORACLE_CONVERSATION_PERSISTENT_APPROVAL_LABEL =
  "allow omnicodex for this conversation";

export const ORACLE_APPROVAL_OWNER_CLAIM_EXPRESSION = `(() => {
  const key = "__oracleAppApprovalWatcher";
  const owner = "omnicodex-daemon/v1";
  const wanted = "omnicodex";
  const existing = window[key];
  if (existing?.owner === owner && existing?.wanted === wanted && existing?.version === 2 && existing?.implementation === 10 && existing?.timer) {
    return { owner, replacedOracleWatcher: false };
  }
  if (existing?.observer && typeof existing.observer.disconnect === 'function') {
    existing.observer.disconnect();
  }
  if (existing?.timer) {
    window.clearInterval(existing.timer);
    window.clearTimeout(existing.timer);
  }
  const state = {
    version: 2,
    implementation: 10,
    wanted,
    owner,
    events: Array.isArray(existing?.events) ? existing.events : [],
    reportedCount: Number.isFinite(existing?.reportedCount) ? existing.reportedCount : 0,
    timer: 0,
    observer: undefined,
    dirty: true,
    revision: 0,
    controls: [],
    elements: new Map(),
  };
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const scopeSelector = '[data-testid="tool-approval-card"],dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"],[class~="@container/approval-card"]';
  const text = (element) => {
    const ariaLabel = element.getAttribute?.('aria-label');
    if (ariaLabel) return ariaLabel.trim().replace(/\\s+/g, ' ');
    const copy = typeof element.cloneNode === 'function' ? element.cloneNode(true) : undefined;
    for (const hidden of copy?.querySelectorAll?.('kbd,[aria-hidden="true"]') || []) hidden.remove();
    return (copy?.textContent || element.innerText || element.textContent || '').trim().replace(/\\s+/g, ' ');
  };
  const isMaterializationScope = ${isFileMaterializationApprovalScopeText.toString()};
  const conversationApp = ${conversationApprovalAppName.toString()};
  const namesApp = ${approvalScopeNamesApp.toString()};
  const add = (element, name, scopeText) => {
    const ref = 'oa-' + state.controls.length;
    state.elements.set(ref, { element, name, scopeText });
    state.controls.push({ ref, role: 'button', name, visible: true, exactAppScope: true, scopeText });
  };
  state.scan = () => {
    state.dirty = false;
    state.revision += 1;
    state.controls = [];
    state.elements = new Map();
    const scopes = document.querySelectorAll(scopeSelector);
    const materializationScopes = [];
    for (const scope of scopes) {
      const buttons = Array.from(scope.querySelectorAll('button,[role="button"]')).filter(visible);
      if (!visible(scope) && buttons.length === 0) continue;
      const scopeText = text(scope);
      // This shared index only observes approval cards. The bound surface and
      // click function independently select the exact configured registration.
      const materialization = isMaterializationScope(scopeText);
      if (materialization) materializationScopes.push({ scope, scopeText });
      for (const element of scope.querySelectorAll('button,[role="button"]')) {
        if (!visible(element)) continue;
        const name = text(element);
        if (!name) continue;
        if (materialization && element.getAttribute('aria-haspopup') === 'menu' && conversationApp(name)) continue;
        add(element, name, scopeText);
      }
      if (materialization) {
        const allow = buttons.find((element) => /^(?:allow|허용하기)$/i.test(text(element)));
        const optionTriggers = buttons.filter((element) => {
          const accessibleName = text(element);
          return element !== allow &&
            (element.getAttribute('aria-haspopup') === 'menu' || element.hasAttribute('aria-expanded')) &&
            Boolean(conversationApp(accessibleName)) &&
            namesApp(scopeText, conversationApp(accessibleName));
        });
        if (optionTriggers.length === 1) {
          add(optionTriggers[0], "file materialization options", scopeText);
        }
      }
    }
    if (materializationScopes.length === 1) {
      const { scopeText } = materializationScopes[0];
      const persistent = new Set(['always allow', '항상 허용', 'allow omnicodex for this conversation']);
      const menuItems = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"],[role="menu"] [role="menuitemradio"],[role="menu"] button,[role="listbox"] [role="option"]'))
        .filter((element) => {
          const name = text(element);
          const app = conversationApp(name);
          return visible(element) && (app ? namesApp(scopeText, app) : persistent.has(name.toLowerCase()));
        });
      if (menuItems.length === 1) {
        const name = text(menuItems[0]);
        add(menuItems[0], conversationApp(name) ? 'allow omnicodex for this conversation' : name, scopeText);
      }
    }
  };
  state.read = () => {
    if (state.dirty) state.scan();
    return {
      revision: 'oracle-v2-' + state.revision,
      implementation: state.implementation,
      documentReady: document.readyState === 'complete' && document.getElementById('prompt-textarea') !== null,
      responseInProgress: Array.from(document.querySelectorAll('[data-testid="stop-button"],[data-testid="stop-streaming-button"],main[aria-busy="true"],[role="main"][aria-busy="true"]')).some(visible),
      controls: state.controls,
    };
  };
  const touchesApprovalSurface = (records) => records.some((record) => {
    const nodes = [record.target, ...record.addedNodes, ...record.removedNodes];
    return nodes.some((node) => {
      const element = node?.nodeType === 1 ? node : node?.parentElement;
      return Boolean(element?.matches?.(scopeSelector) ||
        element?.closest?.(scopeSelector) ||
        element?.querySelector?.(scopeSelector));
    });
  });
  if (typeof MutationObserver === 'function' && document) {
    state.observer = new MutationObserver((records) => {
      if (touchesApprovalSurface(records)) state.dirty = true;
    });
    state.observer.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-testid', 'role', 'aria-modal', 'aria-label', 'style', 'class', 'hidden', 'open'],
    });
  }
  state.timer = window.setInterval(() => {
    if (window[key] !== state) {
      window.clearInterval(state.timer);
    }
  }, 60000);
  window[key] = state;
  return { owner, replacedOracleWatcher: Boolean(existing?.timer && existing?.owner !== owner) };
})()`;

export const ORACLE_APPROVAL_CONTROL_SNAPSHOT_EXPRESSION =
  "(()=>{const s=window.__oracleAppApprovalWatcher;if(s?.owner!=='omnicodex-daemon/v1'||s?.version!==2||typeof s.read!=='function')throw new Error('approval owner unavailable');return s.read()})()";

export const CHATGPT_OPEN_PLUGINS_SETTINGS_FUNCTION =
  "function(){const w=this.defaultView;w.history.replaceState(null,'',w.location.pathname+w.location.search);w.location.hash='#settings/Plugins'}";
export const CHATGPT_OPEN_PLUGINS_SETTINGS_EXPRESSION =
  "(()=>{history.replaceState(null,'',location.pathname+location.search);location.hash='#settings/Plugins';return true})()";
export const CHATGPT_REPLAY_CURRENT_SETTINGS_HASH_EXPRESSION =
  "(()=>{const h=location.hash;if(!h.startsWith('#settings/Plugins'))throw new Error('settings hash missing');history.replaceState(null,'',location.pathname+location.search);location.hash=h;return true})()";
export const CHATGPT_SETTINGS_DOCUMENT_EXPRESSION = "document";
export const CHATGPT_SETTINGS_CONTROL_SNAPSHOT_FUNCTION = `function(){
  const settingsModals = Array.from(this.querySelectorAll('[data-testid="modal-settings"]'));
  const root = settingsModals.find((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }) || this;
  const selector = 'button,[role="button"],[role="radio"],input[type="radio"],input[type="checkbox"],[role="checkbox"],[role="switch"],[role="menuitem"],a[href]';
  const controls = [];
  const references = [];
  for (const element of root.querySelectorAll(selector)) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') continue;
    const name = (element.innerText || element.getAttribute('aria-label') || element.textContent || '').trim().replace(/\\s+/g, ' ');
    if (!name) continue;
    const ref = 'oc-' + controls.length;
    references.push({ element, ref });
    let role = element.getAttribute('role') || element.tagName.toLowerCase();
    if (element instanceof HTMLButtonElement) role = 'button';
    if (element instanceof HTMLAnchorElement) role = 'link';
    if (element instanceof HTMLInputElement && element.type === 'radio') role = 'radio';
    if (element instanceof HTMLInputElement && element.type === 'checkbox') role = 'checkbox';
    const ariaChecked = element.getAttribute('aria-checked');
    const checked = element instanceof HTMLInputElement && (element.type === 'radio' || element.type === 'checkbox')
      ? element.checked
      : ariaChecked === 'true' ? true : ariaChecked === 'false' ? false : undefined;
    const href = element instanceof HTMLAnchorElement ? element.href : undefined;
    controls.push({ ref, role, name, ...(checked === undefined ? {} : { checked }), ...(href ? { href } : {}) });
  }
  // Server URLs can be plain text rather than clickable controls. Preserve
  // only visible URL tokens, not the whole action catalog or conversation text.
  const document = root.ownerDocument || root;
  const walker = document.createTreeWalker(root, 4);
  const urls = new Set();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue || '';
    if (!text.includes('https://') && !text.includes('http://')) continue;
    const parent = node.parentElement;
    if (!parent || parent.closest('script,style,template,a[href]')) continue;
    const rect = parent.getBoundingClientRect();
    const style = getComputedStyle(parent);
    if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') continue;
    for (const word of text.trim().split(/\\s+/u)) {
      if (!word.startsWith('https://') && !word.startsWith('http://')) continue;
      try {
        const url = new URL(word);
        if (url.protocol === 'https:' || url.protocol === 'http:') urls.add(word);
      } catch {}
    }
  }
  for (const url of urls) controls.push({ ref: 'oc-' + controls.length, role: 'StaticText', name: url });
  // Finish layout reads before updating references so each control does not
  // force a new style/layout calculation after the previous attribute write.
  for (const stale of this.querySelectorAll('[data-omnicodex-control-ref]')) {
    stale.removeAttribute('data-omnicodex-control-ref');
  }
  for (const { element, ref } of references) element.setAttribute('data-omnicodex-control-ref', ref);
  return controls;
}`;
export const CHATGPT_SETTINGS_CONTROL_CLICK_FUNCTION = `function(ref){
  if (typeof ref !== 'string' || !/^oc-\\d+$/.test(ref)) throw new Error('invalid control ref');
  const matches = Array.from(this.querySelectorAll('[data-omnicodex-control-ref]')).filter(
    (element) => element.getAttribute('data-omnicodex-control-ref') === ref,
  );
  if (matches.length !== 1) throw new Error('stale or ambiguous control ref');
  matches[0].click();
  return true;
}`;

export const ORACLE_APPROVAL_CONTROL_POINT_FUNCTION = `function(ref, expectedRevision, expectedAppName){
  if (typeof expectedAppName !== 'string' || !expectedAppName.trim()) throw new Error('approval app required');
  const namesApp = ${approvalScopeNamesApp.toString()};
  if (typeof ref !== 'string' || !/^oa-\\d+$/.test(ref)) throw new Error('invalid approval ref');
  if (typeof expectedRevision !== 'string' || !/^oracle-v2-\\d+$/.test(expectedRevision)) throw new Error('invalid approval revision');
  const state = this.defaultView?.__oracleAppApprovalWatcher;
  if (state?.owner !== 'omnicodex-daemon/v1' || state?.version !== 2 || typeof state.read !== 'function') throw new Error('approval owner unavailable');
  const current = state.read();
  if (current.revision !== expectedRevision) throw new Error('stale approval revision');
  const entry = state.elements?.get(ref);
  const element = entry?.element || entry;
  if (!element || !element.isConnected) throw new Error('stale or ambiguous approval ref');
  const scopeSelector = '[data-testid="tool-approval-card"],dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"],[class~="@container/approval-card"]';
  let scope = element.closest(scopeSelector);
  const recordedScopeText = typeof entry?.scopeText === 'string' ? entry.scopeText : '';
  const currentScopes = Array.from(this.querySelectorAll(scopeSelector)).filter((candidate) => {
    const value = (candidate.innerText || candidate.textContent || '').trim().replace(/\\s+/g, ' ');
    const isMaterializationScope = ${isFileMaterializationApprovalScopeText.toString()};
    return namesApp(value, expectedAppName) && isMaterializationScope(value);
  });
  const name = (typeof entry?.name === 'string' ? entry.name : (element.innerText || element.getAttribute('aria-label') || element.textContent || '')).trim().replace(/\\s+/g, ' ').toLowerCase();
  const persistentMenuItem = (name === 'always allow' || name === '항상 허용' || name === 'allow omnicodex for this conversation') && Boolean(element.closest('[role="menu"],[role="listbox"]'));
  if (!scope && persistentMenuItem && currentScopes.length === 1) scope = currentScopes[0];
  const scopeText = scope ? (scope.innerText || scope.textContent || '').trim().replace(/\\s+/g, ' ') : recordedScopeText;
  const allowed = new Set(['connect','연결','always allow','항상 허용','allow omnicodex for this conversation','allow low-risk actions','저위험 액션 허용','allow all actions','모든 액션 허용','모두 허용','allow once','이번만 허용','한 번만 허용','allow','허용','허용하기','confirm','확인','file materialization options']);
  const materializationOptions = name === 'file materialization options' &&
    (element.getAttribute('aria-haspopup') === 'menu' || element.hasAttribute('aria-expanded')) &&
    currentScopes.length === 1;
  if (!scope || !namesApp(scopeText, expectedAppName) || !allowed.has(name) || (name === 'file materialization options' && !materializationOptions)) throw new Error('approval scope changed');
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') throw new Error('approval control hidden');
  element.click();
  return true;
}`;

const ORACLE_APPROVAL_CONTROL_LABELS = new Set([
  "connect",
  "연결",
  "always allow",
  "항상 허용",
  "allow low-risk actions",
  "저위험 액션 허용",
  "allow all actions",
  "모든 액션 허용",
  "모두 허용",
  "allow once",
  "이번만 허용",
  "한 번만 허용",
  "allow",
  "허용",
  "허용하기",
  "confirm",
  "확인",
]);
const XPATH_ASCII_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const XPATH_ASCII_LOWER = "abcdefghijklmnopqrstuvwxyz";

function oracleApprovalLabelXPathPredicate(): string {
  return [...ORACLE_APPROVAL_CONTROL_LABELS]
    .map(
      (label) =>
        `(translate(normalize-space(.), '${XPATH_ASCII_UPPER}', '${XPATH_ASCII_LOWER}')='${label}' or translate(normalize-space(@aria-label), '${XPATH_ASCII_UPPER}', '${XPATH_ASCII_LOWER}')='${label}')`,
    )
    .join(" or ");
}

function oracleApprovalScopeXPath(): string {
  return `//*[(self::dialog or @data-testid='tool-approval-card' or @role='dialog' or @role='alertdialog' or @aria-modal='true' or contains(concat(' ', normalize-space(@class), ' '), ' @container/approval-card ')) and .//button[${oracleApprovalLabelXPathPredicate()}]]`;
}

function oracleApprovalButtonXPath(): string {
  return `//*[(self::button or @role='button') and (${oracleApprovalLabelXPathPredicate()}) and ancestor::*[(self::dialog or @data-testid='tool-approval-card' or @role='dialog' or @role='alertdialog' or @aria-modal='true' or contains(concat(' ', normalize-space(@class), ' '), ' @container/approval-card '))]]`;
}

function oracleFileMaterializationScopeXPath(): string {
  return `//*[(self::dialog or @data-testid='tool-approval-card' or @role='dialog' or @role='alertdialog' or @aria-modal='true' or contains(concat(' ', normalize-space(@class), ' '), ' @container/approval-card ')) and ((contains(normalize-space(.), '파일 생성을 허용할까요?') and contains(normalize-space(.), '파일 첨부')) or (contains(translate(normalize-space(.), '${XPATH_ASCII_UPPER}', '${XPATH_ASCII_LOWER}'), 'allow file materialization?') and contains(translate(normalize-space(.), '${XPATH_ASCII_UPPER}', '${XPATH_ASCII_LOWER}'), 'file attachment')))]`;
}

function oracleMaterializationMenuTriggerXPath(): string {
  return `${oracleFileMaterializationScopeXPath()}//*[self::button or @role='button'][@aria-haspopup='menu' or @aria-expanded]`;
}

function oraclePersistentMaterializationMenuItemXPath(): string {
  const predicate = ["always allow", "항상 허용", ORACLE_CONVERSATION_PERSISTENT_APPROVAL_LABEL]
    .map(
      (label) =>
        `(translate(normalize-space(.), '${XPATH_ASCII_UPPER}', '${XPATH_ASCII_LOWER}')='${label}' or translate(normalize-space(@aria-label), '${XPATH_ASCII_UPPER}', '${XPATH_ASCII_LOWER}')='${label}')`,
    )
    .join(" or ");
  const conversationLabel = `starts-with(translate(normalize-space(.), '${XPATH_ASCII_UPPER}', '${XPATH_ASCII_LOWER}'), 'allow ') and contains(translate(normalize-space(.), '${XPATH_ASCII_UPPER}', '${XPATH_ASCII_LOWER}'), ' for this conversation')`;
  return `//*[(self::button or @role='menuitem' or @role='menuitemradio' or @role='option') and (${predicate} or (${conversationLabel})) and ancestor::*[@role='menu' or @role='listbox']]`;
}

function isExactOracleApprovalSearch(query: string): boolean {
  return (
    query === oracleApprovalScopeXPath() ||
    query === oracleApprovalButtonXPath() ||
    query === oracleFileMaterializationScopeXPath() ||
    query === oracleMaterializationMenuTriggerXPath() ||
    query === oraclePersistentMaterializationMenuItemXPath()
  );
}

type ResolvedCdpSessionOptions = Omit<CdpSessionOptions, "timeoutMs"> & {
  readonly timeoutMs: number | undefined;
};
const ALLOWED_METHODS = new Set([
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "Accessibility.queryAXTree",
  "DOM.enable",
  "DOM.getDocument",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.performSearch",
  "DOM.getSearchResults",
  "DOM.discardSearchResults",
  "DOM.getAttributes",
  "DOM.getOuterHTML",
  "DOM.getBoxModel",
  "DOM.resolveNode",
  "Network.enable",
  "Network.disable",
  "Page.getNavigationHistory",
  "Page.navigate",
  "Runtime.enable",
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Runtime.releaseObject",
]);
export const CHATGPT_APP_SETTINGS_URL = "https://chatgpt.com/plugins";

/**
 * Current ChatGPT plugin management opens an installed developer plugin on its
 * public detail route and overlays the exact settings detail with a hash.  The
 * former root `#settings/Plugins` index no longer renders installed entries,
 * so waiting there can never discover the connector.
 */
export function chatGptAppSettingsUrl(connectorId: string): string {
  if (!/^asdk_app_[a-z0-9]+$/iu.test(connectorId)) {
    throw new Error("CHATGPT_CONNECTOR_ID_INVALID");
  }
  const pluginSegment = `plugin_${connectorId}`;
  return `https://chatgpt.com/plugins/${pluginSegment}#settings/Plugins/${pluginSegment}`;
}

/**
 * Loopback-only CDP transport. Conversation sessions remain attach-only. The
 * only target lifecycle it exposes is an exact ChatGPT settings utility target
 * that this instance created and can therefore close without touching a user
 * tab, profile, browser process, or foreign target.
 */
export class ChatGptLoopbackCdpTransport {
  readonly #base: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeout: number | undefined;
  readonly #max: number | undefined;
  readonly #allowDesktopAppTargets: boolean;
  readonly #attachedTargetReceipts = new Map<string, CdpTarget>();
  readonly #ownedTargets = new Map<
    string,
    {
      readonly webSocketDebuggerUrl: string;
      readonly connectorId: string;
      readonly connectorName?: string;
      readonly purpose: "settings" | "approval_runtime";
      readonly creationMarker: string;
      readonly receipt: CdpTarget;
    }
  >();
  readonly #oauthAuthorizationOrigins: ReadonlySet<string>;
  constructor(options: CdpTransportOptions) {
    this.#base = assertExplicitLoopbackCdpEndpoint(options.endpoint);
    // Undici's pooled fetch connections can be reset by a long-lived OpenSSH
    // local forward even while a fresh TCP request succeeds. CDP control
    // endpoints are tiny loopback requests, so use one non-pooled connection
    // per request. Tests and specialized callers can still inject fetch.
    this.#fetch = options.fetch ?? freshLoopbackHttpFetch;
    this.#timeout = optionalPositiveSafeInteger(options.timeoutMs, "CDP_TIMEOUT");
    this.#max = optionalPositiveSafeInteger(options.maxResponseBytes, "CDP_MAX_RESPONSE_BYTES");
    this.#allowDesktopAppTargets = options.allowDesktopAppTargets === true;
    this.#oauthAuthorizationOrigins = new Set(
      (options.oauthAuthorizationOrigins ?? []).map(exactOAuthAuthorizationOrigin),
    );
  }
  async preflight(
    signal?: AbortSignal,
    targetId?: string,
    targetReceipt?: CdpTarget,
  ): Promise<{ browser: string; target: CdpTarget }> {
    if (targetReceipt !== undefined) {
      if (!this.#isAllowedTarget(targetReceipt)) {
        throw new Error("CHATGPT_TARGET_RECEIPT_INVALID");
      }
      if (targetId !== undefined && targetReceipt.id !== targetId) {
        throw new Error("CHATGPT_TARGET_RECEIPT_ID_MISMATCH");
      }
      const websocket = new URL(targetReceipt.webSocketDebuggerUrl);
      if (
        websocket.port !== this.#base.port ||
        websocket.pathname !== `/devtools/page/${targetReceipt.id}` ||
        websocket.search !== "" ||
        websocket.hash !== ""
      ) {
        throw new Error("CHATGPT_TARGET_RECEIPT_BINDING_INVALID");
      }
      this.#attachedTargetReceipts.set(targetReceipt.id, targetReceipt);
      return { browser: "Chrome/target-receipt", target: targetReceipt };
    }
    if (targetId !== undefined) {
      const owned = this.#ownedTargets.get(targetId);
      if (owned !== undefined) {
        // /json/new is Chrome's authoritative creation receipt and is retained
        // only for targets created by this transport. Attaching with that exact
        // WebSocket URL avoids a redundant global inventory read while the new
        // settings renderer is consuming the small Oracle host.
        return { browser: "Chrome/owned-target-receipt", target: owned.receipt };
      }
    }
    const version = await this.#json("/json/version", signal);
    if (
      Array.isArray(version) ||
      typeof version.Browser !== "string" ||
      !version.Browser.includes("Chrome")
    )
      throw new Error("CDP browser/version preflight failed");
    const targets = await this.#json("/json/list", signal);
    if (!Array.isArray(targets)) throw new Error("CDP target list invalid");
    const allowed = targets
      .filter((target): target is CdpTarget => this.#isAllowedTarget(target))
      .filter((target) => (targetId === undefined ? true : target.id === targetId));
    if (allowed.length !== 1) throw new Error("CHATGPT_TARGET_MISSING_OR_AMBIGUOUS");
    const target = allowed[0] as CdpTarget;
    this.#attachedTargetReceipts.set(target.id, target);
    return { browser: version.Browser, target };
  }
  #isAllowedTarget(value: unknown): value is CdpTarget {
    return (
      isAllowedTarget(value) || (this.#allowDesktopAppTargets && isExactDesktopAppTarget(value))
    );
  }
  async listChatGptTargets(
    signal?: AbortSignal,
    connectorId?: string,
  ): Promise<readonly CdpTarget[]> {
    const inventory = await this.listChatGptTargetInventory(signal, connectorId);
    return connectorId === undefined ? inventory.targets : inventory.connectorTargets;
  }
  /**
   * Reads Chrome's target inventory once and derives both sets from the same
   * point-in-time snapshot. The approval watcher must not issue duplicate
   * concurrent /json/list requests every polling interval.
   */
  async listChatGptTargetInventory(
    signal: AbortSignal | undefined,
    connectorId?: string,
  ): Promise<ChatGptTargetInventory> {
    const targets = await this.#json("/json/list", signal);
    if (!Array.isArray(targets)) throw new Error("CDP target list invalid");
    const pages = targets.filter((target): target is CdpTarget => this.#isAllowedTarget(target));
    const parents = new Set(
      connectorId === undefined
        ? []
        : targets
            .filter((target): target is CdpTarget => isExactConnectorFrame(target, connectorId))
            .map((target) => target.parentId as string),
    );
    return {
      targets: pages,
      connectorTargets: pages.filter((target) => parents.has(target.id)),
    };
  }
  /**
   * Reclaims settings-only pages left by an interrupted Oracle reconciliation.
   * The Oracle Chrome profile is dedicated to approval automation, but its
   * signed-in conversation pages still belong to the user and are never
   * candidates here. Only the exact plugin index or this connector's exact
   * settings-detail route can be closed.
   */
  async closeOrphanedSettingsTargets(
    connectorId: string,
    signal?: AbortSignal,
    preserveTargetIds: readonly string[] = [],
  ): Promise<readonly string[]> {
    if (!/^asdk_app_[a-z0-9]+$/i.test(connectorId)) {
      throw new Error("CHATGPT_CONNECTOR_ID_INVALID");
    }
    const listed = await this.#json("/json/list", signal);
    if (!Array.isArray(listed)) throw new Error("CDP target list invalid");
    const preserved = new Set(preserveTargetIds);
    const orphaned = listed.filter(
      (target): target is CdpTarget =>
        isStructurallyBoundedTarget(target) &&
        target.type !== "iframe" &&
        !preserved.has(target.id) &&
        (isExactOracleSettingsUtilityRoute(target.url, connectorId) ||
          isExactOrphanedCreationMarkerRoute(target.url)),
    );
    for (const target of orphaned) {
      await this.#request(`/json/close/${encodeURIComponent(target.id)}`, signal, "PUT");
      const deadline = Date.now() + DEFAULT_CDP_CONTROL_LIVENESS_TIMEOUT_MS;
      for (;;) {
        const remaining = await this.#json("/json/list", signal);
        if (!Array.isArray(remaining)) throw new Error("CDP target list invalid");
        if (!remaining.some((candidate) => isTargetId(candidate, target.id))) break;
        if (Date.now() >= deadline) {
          throw new Error(`CHATGPT_ORPHANED_SETTINGS_TARGET_CLOSE_TIMEOUT:${target.id}`);
        }
        await boundedDelay(50, signal);
      }
    }
    return orphaned.map((target) => target.id);
  }
  async openOwnedSettingsTarget(connectorId: string, signal?: AbortSignal): Promise<CdpTarget> {
    return this.#openOwnedUtilityTarget(connectorId, "settings", undefined, signal);
  }

  async closeOrphanedApprovalRuntimeTargets(
    connectorId: string,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    if (!/^asdk_app_[a-z0-9]+$/i.test(connectorId)) {
      throw new Error("CHATGPT_CONNECTOR_ID_INVALID");
    }
    const listed = await this.#json("/json/list", signal);
    if (!Array.isArray(listed)) throw new Error("CDP target list invalid");
    const orphaned = listed.filter(
      (target): target is CdpTarget =>
        isStructurallyBoundedTarget(target) &&
        target.type !== "iframe" &&
        isOracleChatGptApprovalRuntimeUrl(target.url, connectorId),
    );
    for (const target of orphaned) {
      await this.#request(`/json/close/${encodeURIComponent(target.id)}`, signal, "PUT");
    }
    return orphaned.map((target) => target.id);
  }

  async openOwnedApprovalRuntimeTarget(
    connectorId: string,
    connectorName: string,
    signal?: AbortSignal,
  ): Promise<CdpTarget> {
    if (connectorName.trim().length === 0 || connectorName.length > 200) {
      throw new Error("CHATGPT_CONNECTOR_NAME_INVALID");
    }
    return this.#openOwnedUtilityTarget(connectorId, "approval_runtime", connectorName, signal);
  }

  /**
   * Re-adopts the single exact Oracle approval runtime across daemon handoffs.
   * The route is connector-bound and exists only in the isolated Oracle
   * browser. Keeping this one long-lived page preserves its loaded ChatGPT
   * request contract and account watermark instead of creating an approval
   * blind spot on every local restart. Duplicate exact runtimes are reclaimed
   * before the survivor is admitted as owned by this transport instance.
   */
  async adoptOrOpenOwnedApprovalRuntimeTarget(
    connectorId: string,
    connectorName: string,
    signal?: AbortSignal,
  ): Promise<CdpTarget> {
    if (!/^asdk_app_[a-z0-9]+$/i.test(connectorId)) {
      throw new Error("CHATGPT_CONNECTOR_ID_INVALID");
    }
    if (connectorName.trim().length === 0 || connectorName.length > 200) {
      throw new Error("CHATGPT_CONNECTOR_NAME_INVALID");
    }
    const listed = await this.#json("/json/list", signal);
    if (!Array.isArray(listed)) throw new Error("CDP target list invalid");
    const exact = listed
      .filter(
        (target): target is CdpTarget =>
          isStructurallyBoundedTarget(target) &&
          target.type !== "iframe" &&
          isOracleChatGptApprovalRuntimeUrl(target.url, connectorId),
      )
      .sort((left, right) => left.id.localeCompare(right.id, "en"));
    const survivor = exact[0];
    if (survivor === undefined) {
      return this.openOwnedApprovalRuntimeTarget(connectorId, connectorName, signal);
    }
    for (const duplicate of exact.slice(1)) {
      await this.#request(`/json/close/${encodeURIComponent(duplicate.id)}`, signal, "PUT");
    }
    this.#ownedTargets.set(survivor.id, {
      webSocketDebuggerUrl: survivor.webSocketDebuggerUrl,
      connectorId,
      connectorName,
      purpose: "approval_runtime",
      creationMarker: randomUUID(),
      receipt: survivor,
    });
    return survivor;
  }

  async #openOwnedUtilityTarget(
    connectorId: string,
    purpose: "settings" | "approval_runtime",
    connectorName: string | undefined,
    signal?: AbortSignal,
  ): Promise<CdpTarget> {
    if (!/^asdk_app_[a-z0-9]+$/i.test(connectorId)) {
      throw new Error("CHATGPT_CONNECTOR_ID_INVALID");
    }
    // Chrome's HTTP /json/new endpoint does not return until its initial
    // navigation has started. Loading chatgpt.com in that control request can
    // therefore pin the only small Oracle browser for a minute and strand
    // several renderer processes. Create an exact, marker-owned about:blank
    // page first. The reconciler then navigates this same target over its page
    // WebSocket, where progress and liveness are independently observable.
    const creationMarker = randomUUID();
    const requested = ownedCreationMarkerUrl(creationMarker);
    let created: Record<string, unknown> | unknown[];
    try {
      created = await this.#json(
        `/json/new?${encodeURIComponent(requested.toString())}`,
        signal,
        "PUT",
        this.#timeout ?? DEFAULT_CDP_TARGET_CREATE_LIVENESS_TIMEOUT_MS,
      );
    } catch (error) {
      const recovered = await this.#recoverAmbiguousCreatedTarget(creationMarker).catch(
        () => undefined,
      );
      if (recovered === undefined) throw error;
      this.#ownedTargets.set(recovered.id, {
        webSocketDebuggerUrl: recovered.webSocketDebuggerUrl,
        connectorId,
        ...(connectorName === undefined ? {} : { connectorName }),
        purpose,
        creationMarker,
        receipt: recovered,
      });
      if (signal?.aborted === true) {
        await this.closeOwnedTarget(recovered.id).catch(() => undefined);
        throw error;
      }
      return recovered;
    }
    if (
      Array.isArray(created) ||
      !isStructurallyBoundedTarget(created) ||
      (!isExactOwnedCreationMarkerTarget(created, creationMarker) &&
        exactOwnedNavigationPendingRoute(created.url) === undefined)
    ) {
      throw new Error("CHATGPT_UTILITY_TARGET_CREATE_INVALID");
    }
    this.#ownedTargets.set(created.id, {
      webSocketDebuggerUrl: created.webSocketDebuggerUrl,
      connectorId,
      ...(connectorName === undefined ? {} : { connectorName }),
      purpose,
      creationMarker,
      receipt: created,
    });
    // Chrome's /json/new response is the ownership receipt. The live target
    // can transiently report an empty URL even when that receipt contains the
    // requested route. Return the exact owned target immediately; the attached
    // settings surface performs a fixed Page.navigate only if the live route
    // is still pending. Waiting here used to consume the whole caller deadline
    // and then reuse the aborted signal for cleanup, leaking an empty tab.
    return created;
  }
  async getOwnedTarget(targetId: string, signal?: AbortSignal): Promise<CdpTarget> {
    const target = await this.#exactOwnedTarget(targetId, signal);
    if (isExactChatGptTarget(target)) return target;
    if (parseHttpsTargetUrl(target.url) === undefined) {
      // A newly created page can briefly report an empty URL. Preserve the
      // bounded startup retry without treating a real foreign origin as absent.
      throw new Error("CHATGPT_UTILITY_TARGET_MISSING_OR_AMBIGUOUS");
    }
    throw new Error("CHATGPT_UTILITY_TARGET_ORIGIN_MISMATCH");
  }
  /**
   * `/json/new` can publish a target before it has an active page agent when
   * Chrome runs with `--no-startup-window`. Explicit activation is the native
   * DevTools lifecycle step; it keeps the same ownership receipt and renderer.
   */
  async activateOwnedTarget(
    targetId: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<void> {
    if (!this.#ownedTargets.has(targetId)) throw new Error("CHATGPT_UTILITY_TARGET_NOT_OWNED");
    await this.#request(`/json/activate/${encodeURIComponent(targetId)}`, signal, "PUT", timeoutMs);
  }
  /**
   * Classifies the exact run-owned settings page across its bounded OAuth
   * lifecycle. Only the ChatGPT settings route, ChatGPT's exact OAuth callback
   * routes, its exact bare-root post-callback transition, and explicitly
   * configured authorization-server origins are valid.
   */
  async getOwnedSettingsTarget(
    targetId: string,
    signal?: AbortSignal,
  ): Promise<OwnedSettingsTargetLocation> {
    const target = await this.#exactOwnedTarget(targetId, signal);
    return this.classifyOwnedSettingsLocation(targetId, target.url);
  }

  /** Classify only the current URL reported by the exact owned CDP socket. */
  classifyOwnedSettingsLocation(targetId: string, currentUrl: string): OwnedSettingsTargetLocation {
    const ownership = this.#ownedTargets.get(targetId);
    const connectorId = ownership?.connectorId;
    if (connectorId === undefined || ownership === undefined) {
      throw new Error("CHATGPT_UTILITY_TARGET_NOT_OWNED");
    }
    const target: CdpTarget = { ...ownership.receipt, url: currentUrl };
    const pendingRoute = exactOwnedNavigationPendingRoute(target.url);
    if (pendingRoute !== undefined) {
      return { kind: "owned_navigation_pending", targetId, route: pendingRoute };
    }
    if (isExactOwnedCreationMarkerTarget(target, ownership.creationMarker)) {
      return {
        kind: "owned_navigation_pending",
        targetId,
        route: "about:blank?omnicodex_target",
      };
    }
    const url = parseHttpsTargetUrl(target.url);
    if (url === undefined) {
      throw new Error(
        `CHATGPT_UTILITY_TARGET_LOCATION_INVALID:${sanitizedTargetLocationEvidence(target.url)}`,
      );
    }
    // Accept the legacy marker only while reclaiming a target created by an
    // older OmniCodex build. New targets use the lightweight about:blank URL.
    if (isExactLegacyOwnedCreationMarkerRoute(url, ownership.creationMarker)) {
      return {
        kind: "owned_navigation_pending",
        targetId,
        route: "https://chatgpt.com/plugins?omnicodex_target",
      };
    }
    const settingsPendingRoute = exactOwnedSettingsNavigationPendingRoute(url, connectorId);
    if (settingsPendingRoute !== undefined) {
      return {
        kind: "owned_navigation_pending",
        targetId,
        route: settingsPendingRoute,
      };
    }
    if (isChatGptSettingsRoute(url, connectorId)) return { kind: "chatgpt_settings", target };
    if (isChatGptOAuthCallbackRoute(url)) {
      return {
        kind: "chatgpt_oauth_callback",
        targetId,
        route: `${url.origin}${sanitizedChatGptOAuthCallbackPath(url.pathname)}`,
      };
    }
    if (isExactChatGptSettingsReturnRoute(url)) {
      return { kind: "chatgpt_settings_return", targetId, route: "https://chatgpt.com/" };
    }
    if (this.#oauthAuthorizationOrigins.has(url.origin)) {
      return { kind: "oauth_authorization", targetId, route: `${url.origin}/` };
    }
    if (url.origin === "https://chatgpt.com") {
      throw new Error("CHATGPT_UTILITY_TARGET_ROUTE_MISMATCH");
    }
    throw new Error("CHATGPT_UTILITY_TARGET_ORIGIN_MISMATCH");
  }

  async closeOwnedTarget(targetId: string, signal?: AbortSignal): Promise<void> {
    if (!this.#ownedTargets.has(targetId)) throw new Error("CHATGPT_UTILITY_TARGET_NOT_OWNED");
    try {
      await this.#request(`/json/close/${encodeURIComponent(targetId)}`, signal, "PUT");
      const deadline = Date.now() + DEFAULT_CDP_CONTROL_LIVENESS_TIMEOUT_MS;
      for (;;) {
        const targets = await this.#json("/json/list", signal);
        if (!Array.isArray(targets)) throw new Error("CDP target list invalid");
        if (!targets.some((target) => isTargetId(target, targetId))) return;
        if (Date.now() >= deadline)
          throw new Error(`CHATGPT_UTILITY_TARGET_CLOSE_TIMEOUT:${targetId}`);
        await boundedDelay(50, signal);
      }
    } finally {
      this.#ownedTargets.delete(targetId);
    }
  }
  assertAllowedCommand(method: string, params: unknown, targetId?: string): void {
    if (!ALLOWED_METHODS.has(method)) throw new Error(`CDP method forbidden: ${method}`);
    if (
      (method === "Network.enable" || method === "Network.disable") &&
      (!isPlainRecord(params) || Object.keys(params).length !== 0)
    ) {
      throw new Error("Passive CDP network observation requires empty parameters");
    }
    if (method === "Runtime.releaseObject") {
      if (
        !isPlainRecord(params) ||
        Object.keys(params).length !== 1 ||
        typeof params.objectId !== "string" ||
        params.objectId.length === 0
      ) {
        throw new Error("Exact CDP remote object identity required for release");
      }
    }
    if (method === "Accessibility.queryAXTree") {
      const query = params as { nodeId?: unknown; role?: unknown };
      const controlRoles = new Set(["button", "radio", "checkbox", "switch", "menuitem", "link"]);
      if (
        !isPlainRecord(query) ||
        Object.keys(query).length !== 2 ||
        !Number.isSafeInteger(query.nodeId) ||
        Number(query.nodeId) < 1 ||
        !controlRoles.has(String(query.role)) ||
        (query.role !== "button" && (targetId === undefined || !this.#ownedTargets.has(targetId)))
      ) {
        throw new Error("Only a bounded accessibility control query is allowed");
      }
    }
    if (method === "Page.navigate") {
      const navigation = params as { url?: unknown };
      const ownership = targetId === undefined ? undefined : this.#ownedTargets.get(targetId);
      const connectorId = ownership?.connectorId;
      const settingsNavigation =
        ownership?.purpose === "settings" &&
        (navigation.url === CHATGPT_APP_SETTINGS_URL ||
          navigation.url === chatGptAppSettingsUrl(connectorId as string));
      const approvalRuntimeNavigation =
        ownership?.purpose === "approval_runtime" &&
        navigation.url === oracleChatGptApprovalRuntimeUrl(connectorId as string);
      const desktopChatNavigation =
        this.#allowDesktopAppTargets &&
        targetId !== undefined &&
        typeof navigation.url === "string" &&
        /^https:\/\/chatgpt\.com\/c\/[a-z0-9-]+$/iu.test(navigation.url);
      if (
        targetId === undefined ||
        !isPlainRecord(navigation) ||
        Object.keys(navigation).length !== 1 ||
        (!settingsNavigation && !approvalRuntimeNavigation && !desktopChatNavigation)
      ) {
        throw new Error(
          "Page navigation forbidden except on an exact owned settings target, approval runtime target, or Desktop Chat webview",
        );
      }
    }
    if (method === "Page.getNavigationHistory") {
      if (
        targetId === undefined ||
        !this.#ownedTargets.has(targetId) ||
        !isPlainRecord(params) ||
        Object.keys(params).length !== 0
      ) {
        throw new Error("Navigation history is allowed only for an exact owned settings target");
      }
    }
    if (method === "DOM.performSearch") {
      const search = params as { query?: unknown; includeUserAgentShadowDOM?: unknown };
      if (
        typeof search.query !== "string" ||
        !isExactOracleApprovalSearch(search.query) ||
        search.includeUserAgentShadowDOM !== true
      ) {
        throw new Error("Only exact OmniCodex approval XPath search is allowed");
      }
    }
    if (method === "DOM.getSearchResults") {
      const result = params as { searchId?: unknown; fromIndex?: unknown; toIndex?: unknown };
      if (
        typeof result.searchId !== "string" ||
        result.searchId.length === 0 ||
        result.fromIndex !== 0 ||
        !Number.isSafeInteger(result.toIndex) ||
        Number(result.toIndex) < 1
      ) {
        throw new Error("Exact DOM search result range required");
      }
    }
    if (method === "DOM.discardSearchResults") {
      const result = params as { searchId?: unknown };
      if (typeof result.searchId !== "string" || result.searchId.length === 0) {
        throw new Error("Exact DOM search identity required");
      }
    }
    if (method === "DOM.getBoxModel") {
      const node = params as { nodeId?: unknown; backendNodeId?: unknown };
      if (
        !(
          (typeof node.nodeId === "number" && node.nodeId > 0) ||
          (typeof node.backendNodeId === "number" && node.backendNodeId > 0)
        )
      ) {
        throw new Error("Exact DOM node identity required for box model");
      }
    }
    if (method === "DOM.querySelectorAll") {
      const query = params as { nodeId?: unknown; selector?: unknown };
      if (
        !isPlainRecord(query) ||
        Object.keys(query).length !== 2 ||
        !Number.isSafeInteger(query.nodeId) ||
        Number(query.nodeId) < 1 ||
        query.selector !== 'button,[role="button"]'
      ) {
        throw new Error("Exact approval scope and button selector required");
      }
    }
    if (method === "DOM.getOuterHTML") {
      const node = params as { nodeId?: unknown };
      if (
        !isPlainRecord(node) ||
        Object.keys(node).length !== 1 ||
        !Number.isSafeInteger(node.nodeId) ||
        Number(node.nodeId) < 1
      ) {
        throw new Error("Exact DOM node identity required for outer HTML");
      }
    }
    if (method === "DOM.enable") {
      if (!isPlainRecord(params) || Object.keys(params).length !== 0) {
        throw new Error("DOM.enable accepts no caller parameters");
      }
    }
    if (method === "Runtime.callFunctionOn") {
      const call = params as {
        functionDeclaration?: unknown;
        objectId?: unknown;
        returnByValue?: unknown;
        awaitPromise?: unknown;
        arguments?: unknown;
      };
      const settingsSnapshot =
        call.functionDeclaration === CHATGPT_SETTINGS_CONTROL_SNAPSHOT_FUNCTION &&
        targetId !== undefined &&
        this.#ownedTargets.has(targetId) &&
        call.arguments === undefined;
      const settingsClick =
        call.functionDeclaration === CHATGPT_SETTINGS_CONTROL_CLICK_FUNCTION &&
        targetId !== undefined &&
        this.#ownedTargets.has(targetId) &&
        Array.isArray(call.arguments) &&
        call.arguments.length === 1 &&
        isPlainRecord(call.arguments[0]) &&
        Object.keys(call.arguments[0]).length === 1 &&
        typeof call.arguments[0].value === "string" &&
        /^oc-\d+$/u.test(call.arguments[0].value);
      const oracleApprovalPoint =
        call.functionDeclaration === ORACLE_APPROVAL_CONTROL_POINT_FUNCTION &&
        Array.isArray(call.arguments) &&
        call.arguments.length === 3 &&
        isPlainRecord(call.arguments[0]) &&
        Object.keys(call.arguments[0]).length === 1 &&
        typeof call.arguments[0].value === "string" &&
        /^oa-\d+$/u.test(call.arguments[0].value) &&
        isPlainRecord(call.arguments[1]) &&
        Object.keys(call.arguments[1]).length === 1 &&
        typeof call.arguments[1].value === "string" &&
        /^oracle-v2-\d+$/u.test(call.arguments[1].value) &&
        isPlainRecord(call.arguments[2]) &&
        Object.keys(call.arguments[2]).length === 1 &&
        typeof call.arguments[2].value === "string" &&
        call.arguments[2].value.trim().length > 0;
      if (
        (!["function(){this.click()}", CHATGPT_OPEN_PLUGINS_SETTINGS_FUNCTION].includes(
          String(call.functionDeclaration),
        ) &&
          !settingsSnapshot &&
          !settingsClick &&
          !oracleApprovalPoint) ||
        typeof call.objectId !== "string" ||
        call.objectId.length === 0 ||
        call.returnByValue !== true ||
        call.awaitPromise !== false
      )
        throw new Error("Only bounded approval element inspection or click is allowed");
    }
    if (method === "Runtime.evaluate") {
      const evaluation = params as {
        expression?: unknown;
        returnByValue?: unknown;
        awaitPromise?: unknown;
      };
      const approvalOwnerClaim = evaluation.expression === ORACLE_APPROVAL_OWNER_CLAIM_EXPRESSION;
      const approvalSnapshot =
        evaluation.expression === ORACLE_APPROVAL_CONTROL_SNAPSHOT_EXPRESSION;
      const ownedSettingsTransition =
        (evaluation.expression === CHATGPT_OPEN_PLUGINS_SETTINGS_EXPRESSION ||
          evaluation.expression === CHATGPT_REPLAY_CURRENT_SETTINGS_HASH_EXPRESSION) &&
        targetId !== undefined &&
        this.#ownedTargets.has(targetId);
      const ownedSettingsDocument =
        evaluation.expression === CHATGPT_SETTINGS_DOCUMENT_EXPRESSION &&
        targetId !== undefined &&
        this.#ownedTargets.has(targetId);
      const approvalDocument =
        evaluation.expression === CHATGPT_SETTINGS_DOCUMENT_EXPRESSION && targetId !== undefined;
      const documentObject = ownedSettingsDocument || approvalDocument;
      const ownedApprovalRuntime =
        targetId === undefined ? undefined : this.#ownedTargets.get(targetId);
      const approvalRuntimeReady =
        (evaluation.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION ||
          evaluation.expression === ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION) &&
        ownedApprovalRuntime?.purpose === "approval_runtime";
      const approvalRuntimeScan =
        ownedApprovalRuntime?.purpose === "approval_runtime" &&
        ownedApprovalRuntime.connectorName !== undefined &&
        isOracleChatGptServerApprovalScanExpression(
          evaluation.expression,
          ownedApprovalRuntime.connectorId,
          ownedApprovalRuntime.connectorName,
        );
      const nativeTurnSubscription =
        targetId !== undefined && isOracleNativeTurnSubscriptionExpression(evaluation.expression);
      const desktopSelectedConversation =
        this.#allowDesktopAppTargets &&
        targetId !== undefined &&
        evaluation.expression === DESKTOP_CHAT_SELECTED_CONVERSATION_EXPRESSION;
      const desktopGoalBindingRead =
        this.#allowDesktopAppTargets &&
        targetId !== undefined &&
        isDesktopGoalBindingReadExpression(evaluation.expression);
      const desktopTarget =
        targetId === undefined ? undefined : this.#attachedTargetReceipts.get(targetId);
      const desktopNativeSend =
        this.#allowDesktopAppTargets &&
        desktopTarget?.type === "page" &&
        desktopTarget.url.startsWith("app:") &&
        isExactDesktopAppTarget(desktopTarget) &&
        isDesktopNativeSendExpression(evaluation.expression);
      const goalContinuation =
        ownedApprovalRuntime?.purpose === "approval_runtime" &&
        isOracleGoalContinuationExpression(evaluation.expression, ownedApprovalRuntime.connectorId);
      const expectedReturnByValue =
        approvalRuntimeReady ||
        approvalRuntimeScan ||
        nativeTurnSubscription ||
        desktopGoalBindingRead ||
        desktopNativeSend ||
        goalContinuation ||
        desktopSelectedConversation
          ? true
          : !(documentObject && !approvalSnapshot);
      const expectedAwaitPromise =
        approvalRuntimeScan ||
        nativeTurnSubscription ||
        goalContinuation ||
        desktopGoalBindingRead ||
        desktopNativeSend;
      if (
        !isPlainRecord(evaluation) ||
        Object.keys(evaluation).length !== 3 ||
        (!approvalOwnerClaim &&
          !approvalSnapshot &&
          !ownedSettingsTransition &&
          !documentObject &&
          !approvalRuntimeReady &&
          !approvalRuntimeScan &&
          !goalContinuation &&
          !desktopSelectedConversation &&
          !desktopGoalBindingRead &&
          !desktopNativeSend &&
          !nativeTurnSubscription) ||
        evaluation.returnByValue !== expectedReturnByValue ||
        evaluation.awaitPromise !== expectedAwaitPromise
      ) {
        throw new Error("Runtime evaluation forbidden except for fixed Oracle operations");
      }
    }
  }
  async #json(
    path: string,
    signal?: AbortSignal,
    method: "GET" | "PUT" = "GET",
    timeoutMs?: number,
  ): Promise<Record<string, unknown> | unknown[]> {
    const text = await this.#request(path, signal, method, timeoutMs);
    try {
      return JSON.parse(text) as Record<string, unknown> | unknown[];
    } catch (error) {
      throw new CdpFrameError("CDP_HTTP_JSON_INVALID", text, error);
    }
  }
  async #exactOwnedTarget(targetId: string, signal?: AbortSignal): Promise<CdpTarget> {
    const owned = this.#ownedTargets.get(targetId);
    if (owned === undefined) throw new Error("CHATGPT_UTILITY_TARGET_NOT_OWNED");
    const targets = await this.#json("/json/list", signal);
    if (!Array.isArray(targets)) throw new Error("CDP target list invalid");
    const matches = targets.filter((target) => isTargetId(target, targetId));
    if (matches.length !== 1) throw new Error("CHATGPT_UTILITY_TARGET_MISSING_OR_AMBIGUOUS");
    const target = matches[0];
    if (!isStructurallyBoundedTarget(target)) {
      throw new Error("CHATGPT_UTILITY_TARGET_IDENTITY_INVALID");
    }
    if (target.webSocketDebuggerUrl !== owned.webSocketDebuggerUrl) {
      throw new Error("CHATGPT_UTILITY_TARGET_IDENTITY_CHANGED");
    }
    return target;
  }
  async #recoverAmbiguousCreatedTarget(creationMarker: string): Promise<CdpTarget | undefined> {
    const deadline = Date.now() + DEFAULT_CDP_TARGET_RECEIPT_RECOVERY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const targets = await this.#json("/json/list");
        if (!Array.isArray(targets)) throw new Error("CDP target list invalid");
        const matches = targets.filter(
          (target): target is CdpTarget =>
            isStructurallyBoundedTarget(target) &&
            target.type !== "iframe" &&
            isExactOwnedCreationMarkerTarget(target, creationMarker),
        );
        if (matches.length > 1) throw new Error("CHATGPT_UTILITY_TARGET_CREATE_AMBIGUOUS");
        if (matches.length === 1) return matches[0];
      } catch (error) {
        if (error instanceof Error && error.message === "CHATGPT_UTILITY_TARGET_CREATE_AMBIGUOUS") {
          throw error;
        }
      }
      await boundedDelay(250);
    }
    return undefined;
  }
  async #request(
    path: string,
    signal?: AbortSignal,
    method: "GET" | "PUT" = "GET",
    timeoutMs?: number,
  ): Promise<string> {
    const deadline = optionalAbortDeadline(
      timeoutMs ?? this.#timeout ?? DEFAULT_CDP_CONTROL_LIVENESS_TIMEOUT_MS,
      `CDP request timeout:${method}:${path.split("?")[0] ?? path}`,
    );
    try {
      const requestSignal = combineAbortSignals(signal, deadline?.signal);
      const response = await this.#fetch(new URL(path, this.#base), {
        method,
        redirect: "error",
        ...(requestSignal === undefined ? {} : { signal: requestSignal }),
      });
      const text = await response.text();
      if (this.#max !== undefined && Buffer.byteLength(text) > this.#max) {
        throw new CdpFrameError("CDP_HTTP_RESPONSE_OVERSIZED", text);
      }
      if (!response.ok) {
        throw new CdpHttpResponseError(path, response.status, response.statusText, text);
      }
      return text;
    } finally {
      deadline?.cancel();
    }
  }
}

/** Release this session's temporary inspector handle without retrying an already committed click. */
export async function callFunctionAndReleaseObject(
  session: BoundedCdpSession,
  params: Record<string, unknown> & { readonly objectId: string },
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    return await session.command("Runtime.callFunctionOn", params, signal);
  } finally {
    try {
      await session.command("Runtime.releaseObject", { objectId: params.objectId }, signal);
    } catch {
      // Disconnecting this inspector session also releases its handles. Do not
      // convert a successful mutation into a failure that invites a duplicate.
      session.close();
    }
  }
}

export class BoundedCdpSession {
  readonly sessionIdentity: string;
  readonly targetId: string;
  readonly #socket: CdpWebSocketLike;
  readonly #transport: ChatGptLoopbackCdpTransport;
  readonly #timeout: number | undefined;
  readonly #maxPending: number | undefined;
  readonly #maxFrame: number | undefined;
  #id = 0;
  #closed = false;
  readonly #cancelledReplies = new Set<number>();
  readonly #pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      method: string;
      cancelTimeout?: () => void;
      abort?: () => void;
      signal?: AbortSignal;
    }
  >();
  private constructor(
    socket: CdpWebSocketLike,
    transport: ChatGptLoopbackCdpTransport,
    options: ResolvedCdpSessionOptions,
    target: CdpTarget,
  ) {
    this.#socket = socket;
    this.#transport = transport;
    this.#timeout = options.timeoutMs;
    this.#maxPending = options.maxPending;
    this.#maxFrame = options.maxFrameBytes;
    this.targetId = target.id;
    this.sessionIdentity = createHash("sha256")
      .update(`${target.id}\0${target.url}\0${randomUUID()}`)
      .digest("hex");
    socket.addEventListener("message", (event) => this.#message(event.data));
    socket.addEventListener("close", (event) =>
      this.#failAll(new CdpFrameError("CDP_SESSION_CLOSED", event.data)),
    );
    socket.addEventListener("error", (event) =>
      this.#failAll(new CdpFrameError("CDP_SESSION_ERROR", event.data)),
    );
  }
  static async connect(
    transport: ChatGptLoopbackCdpTransport,
    options: CdpSessionOptions,
    signal?: AbortSignal,
  ): Promise<BoundedCdpSession> {
    const maxFrameBytes = resolveCdpFrameBudget(options.maxFrameBytes);
    const timeoutMs =
      options.timeoutMs === null
        ? undefined
        : (optionalPositiveSafeInteger(options.timeoutMs, "CDP_TIMEOUT") ??
          DEFAULT_CDP_COMMAND_LIVENESS_TIMEOUT_MS);
    const maxPending = optionalPositiveSafeInteger(options.maxPending, "CDP_MAX_PENDING");
    const { target } = await transport.preflight(signal, options.targetId, options.target);
    const socket = options.factory(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let cancelTimeout: (() => void) | undefined;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        cancelTimeout?.();
        signal?.removeEventListener("abort", onAbort);
        action();
      };
      cancelTimeout = optionalDeadline(timeoutMs, () => {
        finish(() => {
          socket.close(1000, "open-timeout");
          reject(new Error("CDP websocket open timeout"));
        });
      });
      const onAbort = () => {
        finish(() => {
          socket.close(1000, "cancelled");
          reject(errorWithCause("CDP websocket open cancelled", signal?.reason));
        });
      };
      socket.addEventListener(
        "open",
        () => {
          finish(resolve);
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          finish(() => {
            socket.close(1000, "open-failed");
            reject(new Error("CDP websocket open failed"));
          });
        },
        { once: true },
      );
      if (signal?.aborted === true) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    return new BoundedCdpSession(
      socket,
      transport,
      {
        ...options,
        timeoutMs,
        ...(maxPending === undefined ? {} : { maxPending }),
        ...(maxFrameBytes === undefined ? {} : { maxFrameBytes }),
      },
      target,
    );
  }
  get isClosed(): boolean {
    return this.#closed;
  }

  command(
    method: string,
    params: unknown = {},
    signal?: AbortSignal,
    timeoutMs?: number | null,
  ): Promise<unknown> {
    this.#transport.assertAllowedCommand(method, params, this.targetId);
    const commandTimeoutMs =
      timeoutMs === null
        ? undefined
        : (optionalPositiveSafeInteger(timeoutMs, "CDP_COMMAND_TIMEOUT") ?? this.#timeout);
    if (this.#closed) return Promise.reject(new Error("CDP session closed"));
    if (signal?.aborted === true) {
      return Promise.reject(errorWithCause(`CDP command cancelled:${method}`, signal.reason));
    }
    if (this.#maxPending !== undefined && this.#pending.size >= this.#maxPending)
      return Promise.reject(new Error("CDP pending limit exceeded"));
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const cancelTimeout = optionalDeadline(commandTimeoutMs, () => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        // A deadline ends only this caller's wait, not Chrome's command.
        // Preserve other commands and consume this command's eventual reply.
        this.#cancelledReplies.add(id);
        this.#releasePending(pending);
        const error = new Error(`CDP command timeout:${method}`);
        pending.reject(error);
      });
      const abort =
        signal === undefined
          ? undefined
          : () => {
              const pending = this.#pending.get(id);
              if (pending === undefined) return;
              this.#pending.delete(id);
              // Cancelling the local wait does not cancel Chrome's command.
              // Its eventual reply must not disconnect unrelated live work.
              this.#cancelledReplies.add(id);
              this.#releasePending(pending);
              pending.reject(errorWithCause(`CDP command cancelled:${method}`, signal.reason));
            };
      this.#pending.set(id, {
        resolve,
        reject,
        method,
        ...(cancelTimeout === undefined ? {} : { cancelTimeout }),
        ...(abort === undefined || signal === undefined ? {} : { abort, signal }),
      });
      if (abort !== undefined) signal?.addEventListener("abort", abort, { once: true });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.close(1000, "done");
    this.#failAll(new Error("CDP session closed"));
  }
  #message(data: unknown): void {
    if (typeof data !== "string") {
      const error = new CdpFrameError("CDP_FRAME_TYPE_INVALID", data);
      this.#failAll(error);
      this.#socket.close(1000, "invalid-frame");
      return;
    }
    if (this.#maxFrame !== undefined && Buffer.byteLength(data) > this.#maxFrame) {
      const frameBytes = Buffer.byteLength(data);
      const pendingMethods = [...new Set([...this.#pending.values()].map(({ method }) => method))]
        .sort()
        .join(",");
      const error = new CdpFrameError(
        `CDP_FRAME_OVERSIZED:received=${frameBytes}:maximum=${this.#maxFrame}:pending=${pendingMethods || "none"}`,
        data,
      );
      this.#failAll(error);
      this.#socket.close(1000, "oversized-frame");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch (error) {
      this.#failAll(new CdpFrameError("CDP_FRAME_JSON_INVALID", data, error));
      this.#socket.close(1000, "invalid-frame");
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.#failAll(new CdpFrameError("CDP_FRAME_SHAPE_INVALID", value));
      this.#socket.close(1000, "invalid-frame");
      return;
    }
    const message = value as {
      id?: unknown;
      method?: unknown;
      params?: unknown;
      result?: unknown;
      error?: { message?: unknown };
    };
    if (message.id === undefined) {
      // CDP notifications are independent of command replies. Runtime.enable
      // emits executionContextCreated before its reply; treating that event as
      // a broken response disconnects a healthy browser and fails pending work.
      if (
        typeof message.method === "string" &&
        /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/u.test(message.method) &&
        message.result === undefined &&
        message.error === undefined &&
        (message.params === undefined || isPlainRecord(message.params))
      )
        return;
      const unexpected = new CdpFrameError(
        `CDP_UNEXPECTED_EVENT:${typeof message.method === "string" ? message.method : "invalid"}`,
        value,
      );
      this.#socket.close(1000, "unexpected-event");
      this.#failAll(unexpected);
      return;
    }
    if (typeof message.id !== "number" || !Number.isInteger(message.id)) {
      this.#failAll(new CdpFrameError("CDP_RESPONSE_ID_INVALID", value));
      this.#socket.close(1000, "invalid-frame");
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      if (this.#cancelledReplies.delete(message.id)) return;
      this.#failAll(new CdpFrameError("CDP_RESPONSE_ID_UNEXPECTED", value));
      this.#socket.close(1000, "unexpected-response");
      return;
    }
    if ((message.result === undefined) === (message.error === undefined)) {
      this.#failAll(new CdpFrameError("CDP_RESPONSE_RESULT_INVALID", value));
      this.#socket.close(1000, "invalid-frame");
      return;
    }
    this.#pending.delete(message.id);
    this.#releasePending(pending);
    if (message.error !== undefined)
      pending.reject(new CdpProtocolError(pending.method, message.error));
    else pending.resolve(message.result);
  }
  #failAll(error: Error): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      this.#releasePending(pending);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#cancelledReplies.clear();
  }
  #releasePending(pending: {
    readonly cancelTimeout?: () => void;
    readonly abort?: () => void;
    readonly signal?: AbortSignal;
  }): void {
    pending.cancelTimeout?.();
    if (pending.abort !== undefined) pending.signal?.removeEventListener("abort", pending.abort);
  }
}

const OWNED_PAGE_ACTIVATION_PROBE_LIVENESS_MS = 3_000;

export interface ActivatedOwnedSettingsSession {
  readonly session: BoundedCdpSession;
  /** Socket-local receipt consumed by the settings surface before another probe. */
  readonly initialNavigationHistory: unknown;
}

/**
 * Chrome can publish `/json/new` and accept its page WebSocket before the
 * renderer behind that target is active. Probe on disposable inspector
 * sessions and reconnect the same owned target; never recreate or substitute
 * a page merely because that short-lived DevTools agent is not ready yet.
 */
export async function connectActivatedOwnedSettingsSession(
  transport: ChatGptLoopbackCdpTransport,
  options: CdpSessionOptions & { readonly targetId: string },
  signal?: AbortSignal,
): Promise<ActivatedOwnedSettingsSession> {
  try {
    await transport.activateOwnedTarget(
      options.targetId,
      signal,
      OWNED_PAGE_ACTIVATION_PROBE_LIVENESS_MS,
    );
  } catch (error) {
    // Some remote Chrome builds accept the target WebSocket while their
    // foreground-activation HTTP endpoint never completes. Activation is an
    // optimization for --no-startup-window, not an ownership or readiness
    // receipt. Continue only for this bounded advisory timeout; the disposable
    // Page-domain probe below remains the authoritative readiness check.
    if (signal?.aborted === true || !isOwnedTargetActivationAdvisoryFailure(error)) throw error;
  }
  for (;;) {
    signal?.throwIfAborted();
    let session: BoundedCdpSession | undefined;
    try {
      session = await BoundedCdpSession.connect(transport, options, signal);
      const initialNavigationHistory = await session.command(
        "Page.getNavigationHistory",
        {},
        signal,
        OWNED_PAGE_ACTIVATION_PROBE_LIVENESS_MS,
      );
      return { session, initialNavigationHistory };
    } catch (error) {
      session?.close();
      if (!isOwnedPageActivationPending(error) || signal?.aborted === true) throw error;
      await boundedDelay(250, signal);
    }
  }
}

export function isOwnedTargetActivationAdvisoryFailure(error: unknown): boolean {
  return (
    error instanceof Error && error.message.startsWith("CDP request timeout:PUT:/json/activate/")
  );
}

export function isOwnedPageActivationPending(error: unknown): boolean {
  return (
    (error instanceof CdpProtocolError &&
      error.code === -32000 &&
      error.message === "Page.getNavigationHistory: Not attached to an active page") ||
    (error instanceof Error &&
      (error.message === "CDP command timeout:Page.getNavigationHistory" ||
        error.message === "CDP websocket open timeout"))
  );
}

function resolveCdpFrameBudget(configured: number | undefined): number | undefined {
  return optionalPositiveSafeInteger(configured, "CDP_FRAME_BUDGET");
}

export class CdpProtocolError extends Error {
  readonly code: unknown;
  readonly data: unknown;
  readonly payload: unknown;

  constructor(method: string, payload: unknown) {
    const record = isPlainRecord(payload) ? payload : undefined;
    const detail = typeof record?.message === "string" ? record.message : "CDP command failed";
    super(`${method}: ${detail}`, { cause: payload });
    this.name = "CdpProtocolError";
    this.code = record?.code;
    this.data = record?.data;
    this.payload = payload;
  }
}

export class CdpFrameError extends Error {
  readonly payload: unknown;

  constructor(message: string, payload: unknown, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CdpFrameError";
    this.payload = payload;
  }
}

class CdpHttpResponseError extends Error {
  readonly path: string;
  readonly status: number;
  readonly statusText: string;
  readonly payload: string;

  constructor(path: string, status: number, statusText: string, payload: string) {
    super(`CDP preflight HTTP ${String(status)}${statusText === "" ? "" : ` ${statusText}`}`, {
      cause: { path, status, statusText, payload },
    });
    this.name = "CdpHttpResponseError";
    this.path = path;
    this.status = status;
    this.statusText = statusText;
    this.payload = payload;
  }
}

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

function optionalPositiveSafeInteger(value: number | undefined, code: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${code}_INVALID:configured=${String(value)}`);
  }
  return value;
}

function optionalDeadline(
  timeoutMs: number | undefined,
  action: () => void,
): (() => void) | undefined {
  if (timeoutMs === undefined) return undefined;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remainingMs = timeoutMs;
  const schedule = (): void => {
    if (cancelled) return;
    const delayMs = Math.min(remainingMs, MAX_NODE_TIMER_DELAY_MS);
    timer = setTimeout(() => {
      remainingMs -= delayMs;
      if (remainingMs === 0) {
        action();
        return;
      }
      schedule();
    }, delayMs);
  };
  schedule();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

function optionalAbortDeadline(
  timeoutMs: number | undefined,
  message: string,
): { readonly signal: AbortSignal; readonly cancel: () => void } | undefined {
  if (timeoutMs === undefined) return undefined;
  const controller = new AbortController();
  const cancel = optionalDeadline(timeoutMs, () => controller.abort(new Error(message)));
  if (cancel === undefined) throw new Error("CDP_TIMEOUT_STATE_INVALID");
  return { signal: controller.signal, cancel };
}

export const freshLoopbackHttpFetch: typeof globalThis.fetch = (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (init?.body !== undefined && init.body !== null) {
    return Promise.reject(new Error("CDP loopback control requests do not accept a body"));
  }
  return new Promise<Response>((resolve, reject) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const request = httpRequest(
      url,
      {
        method,
        agent: false,
        headers: input instanceof Request ? Object.fromEntries(input.headers.entries()) : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.once("aborted", () =>
          finish(() => reject(new Error("CDP loopback HTTP response aborted"))),
        );
        response.once("error", (error) => finish(() => reject(error)));
        response.once("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
              for (const entry of value) headers.append(name, entry);
            } else {
              headers.set(name, String(value));
            }
          }
          finish(() =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode ?? 500,
                statusText: response.statusMessage ?? "",
                headers,
              }),
            ),
          );
        });
      },
    );
    const onAbort = (): void => {
      const reason =
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("CDP loopback HTTP request cancelled", { cause: signal?.reason });
      request.destroy(reason);
      finish(() => reject(reason));
    };
    request.once("error", (error) => {
      const failure =
        signal?.aborted === true && signal.reason instanceof Error ? signal.reason : error;
      finish(() => reject(failure));
    });
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    request.end();
  });
};

function combineAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return AbortSignal.any([first, second]);
}

function errorWithCause(message: string, cause: unknown): Error {
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

export class CdpChatGptApprovalSurface implements ChatGptApprovalSurface {
  readonly #session: BoundedCdpSession;
  readonly #binding: ChatGptApprovalBinding;
  readonly #resultName: string;
  readonly #requiredAccessibleText: readonly string[];
  readonly #refs = new Map<
    string,
    | { readonly backendNodeId: number }
    | { readonly nodeId: number }
    | { readonly approvalRef: string }
    | {
        readonly approvalDomNodeId: number;
        readonly approvalScopeNodeId?: number;
        readonly approvalExternalMenu?: boolean;
      }
  >();
  #revision = "";
  #approvalDomRevision = 0;
  #accessibilityEnabled = false;
  constructor(
    session: BoundedCdpSession,
    binding: ChatGptApprovalBinding,
    resultAccessibleName: string,
    requiredAccessibleText: readonly string[] = [binding.appName, binding.oracleRunId],
  ) {
    if (resultAccessibleName.trim() === "") throw new Error("tool result accessible name required");
    this.#session = session;
    this.#binding = binding;
    this.#resultName = resultAccessibleName;
    this.#requiredAccessibleText = requiredAccessibleText
      .map((value) => value.trim())
      .filter(Boolean);
    if (this.#requiredAccessibleText.length === 0)
      throw new Error("accessible target binding required");
  }
  async claimApprovalOwnership(signal?: AbortSignal): Promise<boolean> {
    if (!this.#binding.appConnectorId.trim() || !this.#binding.appName.trim()) {
      throw new Error("Oracle approval registration binding required");
    }
    const result = (await this.#session.command(
      "Runtime.evaluate",
      {
        expression: ORACLE_APPROVAL_OWNER_CLAIM_EXPRESSION,
        returnByValue: true,
        awaitPromise: false,
      },
      signal,
    )) as { result?: { value?: unknown } };
    const value = result.result?.value;
    if (!isPlainRecord(value) || value.owner !== "omnicodex-daemon/v1") {
      throw new Error("ORACLE_APPROVAL_OWNER_CLAIM_FAILED");
    }
    return value.replacedOracleWatcher === true;
  }
  async approvalControlSnapshot(
    supportedLabels: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<{
    readonly domRevision: string;
    readonly nodes: readonly ChatGptAccessibleNode[];
    readonly documentReady?: boolean;
    readonly responseInProgress?: boolean;
  }> {
    if (!this.#binding.appConnectorId.trim() || !this.#binding.appName.trim()) {
      throw new Error("Oracle approval registration binding required");
    }
    const labels = [...supportedLabels]
      .map((label) => label.trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right, "en"));
    if (labels.length === 0) return { domRevision: "", nodes: [] };
    const supported = new Set(labels.map((label) => label.toLocaleLowerCase()));
    this.#refs.clear();
    const nodes: ChatGptAccessibleNode[] = [];
    // The owner index is mutation-driven and bounded to visible OmniCodex
    // approval cards. Reading it avoids a whole-document XPath walk through a
    // long ChatGPT conversation on every poll. If the renderer main world is
    // genuinely unavailable, the exact DOM-domain search below remains the
    // renderer-independent recovery path.
    try {
      let snapshot = await this.#readApprovalControlSnapshot(signal);
      if (!isOracleApprovalControlSnapshot(snapshot)) {
        // A newly-created mirror can attach after the browser-wide new-document
        // hook but before that hook has installed the owner in the current
        // execution context. Re-establish the same daemon owner in-place and
        // retry this exact read instead of crawling the complete document.
        await this.claimApprovalOwnership(signal);
        snapshot = await this.#readApprovalControlSnapshot(signal);
      }
      if (isOracleApprovalControlSnapshot(snapshot)) {
        for (const value of snapshot.controls) {
          if (
            !isPlainRecord(value) ||
            typeof value.ref !== "string" ||
            !/^oa-\d+$/u.test(value.ref) ||
            typeof value.name !== "string" ||
            !supported.has(value.name.trim().toLocaleLowerCase()) ||
            value.role !== "button" ||
            value.visible !== true ||
            value.exactAppScope !== true ||
            typeof value.scopeText !== "string" ||
            !approvalScopeNamesApp(value.scopeText, this.#binding.appName)
          )
            continue;
          const ref = value.ref;
          this.#refs.set(ref, { approvalRef: ref });
          nodes.push({
            ref,
            role: "button",
            name: value.name.trim(),
            exactAppScope: true,
            scopeText: value.scopeText,
            selectorClass: "accessible-role-name",
          });
        }
        this.#revision = snapshot.revision;
        return {
          domRevision: this.#revision,
          nodes,
          documentReady: snapshot.documentReady,
          responseInProgress: snapshot.responseInProgress,
        };
      }
    } catch (error) {
      if (signal?.aborted === true) throw error;
    }
    this.#refs.clear();
    return this.#readApprovalControlSnapshotViaDom(supported, signal);
  }

  /**
   * A busy ChatGPT renderer can stop servicing main-world JavaScript while the
   * browser process and DOM agent remain responsive.  Approval must not depend
   * on that renderer queue: the bounded XPath below is evaluated by CDP's DOM
   * domain, names only the OmniCodex modal, and returns only allow controls.
   */
  async #readApprovalControlSnapshotViaDom(
    supported: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<{ readonly domRevision: string; readonly nodes: readonly ChatGptAccessibleNode[] }> {
    await this.#session.command("DOM.enable", {}, signal);
    const scopeNodeIds = await this.#findApprovalDomNodes(oracleApprovalScopeXPath(), signal);
    const buttonScopes = new Map<number, { nodeId: number; text: string }>();
    const materializationScopes: { nodeId: number; text: string }[] = [];
    for (const nodeId of scopeNodeIds) {
      const markup = (await this.#session.command("DOM.getOuterHTML", { nodeId }, signal)) as {
        outerHTML?: unknown;
      };
      if (typeof markup.outerHTML !== "string") continue;
      const scopeText = approvalMarkupText(markup.outerHTML);
      if (isFileMaterializationApprovalScopeText(scopeText)) {
        materializationScopes.push({ nodeId, text: scopeText });
      }
      if (scopeText !== "" && approvalScopeNamesApp(scopeText, this.#binding.appName)) {
        const descendants = (await this.#session.command(
          "DOM.querySelectorAll",
          {
            nodeId,
            selector: 'button,[role="button"]',
          },
          signal,
        )) as { nodeIds?: number[] };
        for (const buttonId of descendants.nodeIds ?? []) {
          const previous = buttonScopes.get(buttonId);
          if (!previous || previous.text.length > scopeText.length) {
            buttonScopes.set(buttonId, { nodeId, text: scopeText });
          }
        }
      }
    }
    const buttonNodeIds = await this.#findApprovalDomNodes(oracleApprovalButtonXPath(), signal);
    this.#refs.clear();
    const nodes: ChatGptAccessibleNode[] = [];
    for (const nodeId of buttonNodeIds) {
      const [attributes, markup, box] = await Promise.all([
        this.#session.command("DOM.getAttributes", { nodeId }, signal) as Promise<{
          attributes?: unknown;
        }>,
        this.#session.command("DOM.getOuterHTML", { nodeId }, signal) as Promise<{
          outerHTML?: unknown;
        }>,
        this.#session.command("DOM.getBoxModel", { nodeId }, signal) as Promise<{
          model?: { content?: unknown };
        }>,
      ]);
      if (!hasVisibleCdpBox(box.model?.content)) continue;
      const name = approvalControlName(attributes.attributes, markup.outerHTML);
      if (name === undefined || !supported.has(name.toLocaleLowerCase())) continue;
      const scope = buttonScopes.get(nodeId);
      if (scope === undefined) continue;
      const scopeText = scope.text;
      const ref = `od-${nodes.length}`;
      this.#refs.set(ref, { approvalDomNodeId: nodeId, approvalScopeNodeId: scope.nodeId });
      nodes.push({
        ref,
        role: "button",
        name,
        exactAppScope: true,
        scopeText,
        selectorClass: "accessible-role-name",
      });
    }
    if (
      materializationScopes.length === 1 &&
      approvalScopeNamesApp(materializationScopes[0]?.text ?? "", this.#binding.appName)
    ) {
      const scope = materializationScopes[0] as { nodeId: number; text: string };
      const scopeText = scope.text;
      const triggerNodeIds = await this.#findApprovalDomNodes(
        oracleMaterializationMenuTriggerXPath(),
        signal,
      );
      const visibleTriggerNodeIds: number[] = [];
      for (const nodeId of triggerNodeIds) {
        if (buttonScopes.get(nodeId)?.nodeId !== scope.nodeId) continue;
        const [attributes, markup, box] = await Promise.all([
          this.#session.command("DOM.getAttributes", { nodeId }, signal) as Promise<{
            attributes?: unknown;
          }>,
          this.#session.command("DOM.getOuterHTML", { nodeId }, signal) as Promise<{
            outerHTML?: unknown;
          }>,
          this.#session.command("DOM.getBoxModel", { nodeId }, signal) as Promise<{
            model?: { content?: unknown };
          }>,
        ]);
        const name = approvalControlName(
          attributes.attributes,
          markup.outerHTML,
        )?.toLocaleLowerCase();
        if (
          hasVisibleCdpBox(box.model?.content) &&
          !new Set(["allow", "허용하기", "reject", "거절하기"]).has(name ?? "")
        ) {
          visibleTriggerNodeIds.push(nodeId);
        }
      }
      if (
        visibleTriggerNodeIds.length === 1 &&
        supported.has(ORACLE_MATERIALIZATION_OPTIONS_LABEL)
      ) {
        const ref = `od-${nodes.length}`;
        this.#refs.set(ref, {
          approvalDomNodeId: visibleTriggerNodeIds[0] as number,
          approvalScopeNodeId: scope.nodeId,
        });
        nodes.push({
          ref,
          role: "button",
          name: ORACLE_MATERIALIZATION_OPTIONS_LABEL,
          exactAppScope: true,
          scopeText,
          selectorClass: "accessible-role-name",
        });
      }
      const persistentNodeIds = await this.#findApprovalDomNodes(
        oraclePersistentMaterializationMenuItemXPath(),
        signal,
      );
      for (const nodeId of persistentNodeIds) {
        const [attributes, markup, box] = await Promise.all([
          this.#session.command("DOM.getAttributes", { nodeId }, signal) as Promise<{
            attributes?: unknown;
          }>,
          this.#session.command("DOM.getOuterHTML", { nodeId }, signal) as Promise<{
            outerHTML?: unknown;
          }>,
          this.#session.command("DOM.getBoxModel", { nodeId }, signal) as Promise<{
            model?: { content?: unknown };
          }>,
        ]);
        if (!hasVisibleCdpBox(box.model?.content)) continue;
        const rawName = approvalControlName(attributes.attributes, markup.outerHTML);
        if (rawName === undefined) continue;
        const menuApp = conversationApprovalAppName(rawName);
        if (
          menuApp !== undefined &&
          menuApp.toLocaleLowerCase() !==
            this.#binding.appName.trim().replace(/\s+/gu, " ").toLocaleLowerCase()
        )
          continue;
        const name = menuApp ? ORACLE_CONVERSATION_PERSISTENT_APPROVAL_LABEL : rawName;
        if (!supported.has(name.toLocaleLowerCase())) continue;
        const ref = `od-${nodes.length}`;
        this.#refs.set(ref, {
          approvalDomNodeId: nodeId,
          approvalScopeNodeId: scope.nodeId,
          approvalExternalMenu: true,
        });
        nodes.push({
          ref,
          role: "button",
          name,
          exactAppScope: true,
          scopeText,
          selectorClass: "accessible-role-name",
        });
      }
    }
    this.#approvalDomRevision += 1;
    this.#revision = `oracle-dom-${this.#approvalDomRevision}`;
    return { domRevision: this.#revision, nodes };
  }

  async #findApprovalDomNodes(query: string, signal?: AbortSignal): Promise<readonly number[]> {
    const search = (await this.#session.command(
      "DOM.performSearch",
      { query, includeUserAgentShadowDOM: true },
      signal,
    )) as { searchId?: unknown; resultCount?: unknown };
    if (
      typeof search.searchId !== "string" ||
      search.searchId.length === 0 ||
      !Number.isSafeInteger(search.resultCount) ||
      Number(search.resultCount) < 0
    ) {
      throw new Error("CDP approval DOM search invalid");
    }
    const searchId = search.searchId;
    const resultCount = Number(search.resultCount);
    try {
      if (resultCount === 0) return [];
      const results = (await this.#session.command(
        "DOM.getSearchResults",
        { searchId, fromIndex: 0, toIndex: resultCount },
        signal,
      )) as { nodeIds?: unknown };
      if (!Array.isArray(results.nodeIds)) {
        throw new Error("CDP approval DOM result invalid");
      }
      return results.nodeIds
        .filter((nodeId) => Number.isSafeInteger(nodeId) && Number(nodeId) > 0)
        .map(Number);
    } finally {
      await this.#session.command("DOM.discardSearchResults", { searchId }, signal);
    }
  }
  async #readApprovalControlSnapshot(signal?: AbortSignal): Promise<unknown> {
    const inspected = (await this.#session.command(
      "Runtime.evaluate",
      {
        expression: ORACLE_APPROVAL_CONTROL_SNAPSHOT_EXPRESSION,
        returnByValue: true,
        awaitPromise: false,
      },
      signal,
    )) as { result?: { value?: unknown } };
    return inspected.result?.value;
  }
  async hasPotentialApprovalControl(
    supportedLabels: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return (await this.approvalControlSnapshot(supportedLabels, signal)).nodes.length > 0;
  }
  async snapshot(signal?: AbortSignal): Promise<ChatGptApprovalSnapshot> {
    await this.#ensureAccessibility(signal);
    const result = (await this.#session.command("Accessibility.getFullAXTree", {}, signal)) as {
      nodes?: unknown;
    };
    if (!Array.isArray(result.nodes)) throw new Error("CDP accessibility tree invalid");
    this.#refs.clear();
    const records = [] as Array<{
      ref: string;
      role: string;
      name: string;
      parentId?: string;
      childIds: readonly string[];
    }>;
    for (const raw of result.nodes) {
      if (typeof raw !== "object" || raw === null) continue;
      const node = raw as {
        nodeId?: unknown;
        backendDOMNodeId?: unknown;
        parentId?: unknown;
        childIds?: unknown;
        role?: { value?: unknown };
        name?: { value?: unknown };
      };
      if (
        typeof node.nodeId !== "string" ||
        typeof node.backendDOMNodeId !== "number" ||
        typeof node.role?.value !== "string" ||
        typeof node.name?.value !== "string"
      )
        continue;
      this.#refs.set(node.nodeId, { backendNodeId: node.backendDOMNodeId });
      records.push({
        ref: node.nodeId,
        role: node.role.value,
        name: node.name.value,
        ...(typeof node.parentId === "string" ? { parentId: node.parentId } : {}),
        childIds: Array.isArray(node.childIds)
          ? node.childIds.filter((value): value is string => typeof value === "string")
          : [],
      });
    }
    const byId = new Map(records.map((node) => [node.ref, node]));
    const scopeTextCache = new Map<string, string>();
    const nodes = records.map((node) => {
      const scopeText = exactAppScopeText(node, byId, this.#binding.appName, scopeTextCache);
      return {
        ref: node.ref,
        role: node.role,
        name: node.name,
        exactAppScope: scopeText !== undefined,
        ...(scopeText === undefined ? {} : { scopeText }),
      };
    });
    this.#revision = createHash("sha256").update(JSON.stringify(nodes)).digest("hex");
    const names = new Set(
      nodes
        .filter((n) => n.exactAppScope && n.role.toLowerCase() === "button")
        .map((n) => n.name.trim().toLocaleLowerCase()),
    );
    const accessibleText = nodes
      .map((node) => node.name)
      .join("\n")
      .toLocaleLowerCase();
    const scopedAccessibleText = nodes
      .filter((node) => node.exactAppScope)
      .map((node) => node.name)
      .join("\n")
      .toLocaleLowerCase();
    if (
      !this.#requiredAccessibleText.every((marker) =>
        accessibleText.includes(marker.toLocaleLowerCase()),
      )
    )
      throw new Error("CHATGPT_TARGET_BINDING_MISMATCH");
    const appName = this.#binding.appName.toLocaleLowerCase();
    const combinedConnectionSheet =
      (scopedAccessibleText.includes("allow chatgpt to use") &&
        scopedAccessibleText.includes(appName)) ||
      (scopedAccessibleText.includes("chatgpt가") &&
        scopedAccessibleText.includes(appName) &&
        scopedAccessibleText.includes("사용하도록 허용"));
    const connected = !names.has("connect") && !names.has("연결") && !combinedConnectionSheet;
    const persistentControlVisible = [
      "always allow",
      "항상 허용",
      "allow low-risk actions",
      "저위험 액션 허용",
      "allow all actions",
      "모든 액션 허용",
      "모두 허용",
    ].some((name) => names.has(name));
    const alwaysAllowed = connected && !persistentControlVisible;
    return {
      ...this.#binding,
      domRevision: this.#revision,
      connected,
      alwaysAllowed,
      toolResultPresent: nodes.some((n) => n.name === this.#resultName),
      nodes,
    };
  }
  async activate(ref: string, expectedDomRevision: string, signal?: AbortSignal): Promise<void> {
    if (expectedDomRevision !== this.#revision) throw new Error("STALE_DOM");
    const locator = this.#refs.get(ref);
    if (locator === undefined) throw new Error("STALE_DOM_NODE");
    if ("approvalRef" in locator) {
      const documentObjectId = await this.#approvalDocumentObjectId(signal);
      const prepared = (await this.#session.command(
        "Runtime.callFunctionOn",
        {
          objectId: documentObjectId,
          functionDeclaration: ORACLE_APPROVAL_CONTROL_POINT_FUNCTION,
          returnByValue: true,
          awaitPromise: false,
          arguments: [
            { value: locator.approvalRef },
            { value: expectedDomRevision },
            { value: this.#binding.appName },
          ],
        },
        signal,
      )) as { result?: { value?: unknown } };
      if (prepared.result?.value !== true) throw new Error("STALE_DOM_NODE");
      try {
        return;
      } finally {
        try {
          await this.#session.command(
            "Runtime.releaseObject",
            { objectId: documentObjectId },
            signal,
          );
        } catch {
          // The trusted click can replace the Electron guest immediately.
          // Closing that guest releases its document handle.
        }
      }
    }
    if ("approvalDomNodeId" in locator) {
      if (locator.approvalScopeNodeId !== undefined) {
        const [markup, descendants] = (await Promise.all([
          this.#session.command(
            "DOM.getOuterHTML",
            { nodeId: locator.approvalScopeNodeId },
            signal,
          ),
          this.#session.command(
            "DOM.querySelectorAll",
            {
              nodeId: locator.approvalScopeNodeId,
              selector: 'button,[role="button"]',
            },
            signal,
          ),
        ])) as [{ outerHTML?: string }, { nodeIds?: number[] }];
        if (
          !approvalScopeNamesApp(
            approvalMarkupText(markup.outerHTML ?? ""),
            this.#binding.appName,
          ) ||
          (!locator.approvalExternalMenu &&
            !descendants.nodeIds?.includes(locator.approvalDomNodeId))
        ) {
          throw new Error("STALE_DOM_NODE");
        }
        if (locator.approvalExternalMenu) {
          const currentScopes = await this.#findApprovalDomNodes(
            oracleFileMaterializationScopeXPath(),
            signal,
          );
          if (currentScopes.length !== 1 || currentScopes[0] !== locator.approvalScopeNodeId)
            throw new Error("STALE_DOM_NODE");
          const [attributes, controlMarkup] = (await Promise.all([
            this.#session.command(
              "DOM.getAttributes",
              { nodeId: locator.approvalDomNodeId },
              signal,
            ),
            this.#session.command(
              "DOM.getOuterHTML",
              { nodeId: locator.approvalDomNodeId },
              signal,
            ),
          ])) as [{ attributes?: unknown }, { outerHTML?: unknown }];
          const name = approvalControlName(attributes.attributes, controlMarkup.outerHTML) ?? "";
          const menuApp = conversationApprovalAppName(name);
          if (
            menuApp
              ? menuApp.toLocaleLowerCase() !==
                this.#binding.appName.trim().replace(/\s+/gu, " ").toLocaleLowerCase()
              : !["always allow", "항상 허용"].includes(name.toLocaleLowerCase())
          )
            throw new Error("STALE_DOM_NODE");
        }
      }
      const resolved = (await this.#session.command(
        "DOM.resolveNode",
        { nodeId: locator.approvalDomNodeId },
        signal,
      )) as { object?: { objectId?: unknown } };
      if (typeof resolved.object?.objectId !== "string")
        throw new Error("DOM node resolution failed");
      await callFunctionAndReleaseObject(
        this.#session,
        {
          objectId: resolved.object.objectId,
          functionDeclaration: "function(){this.click()}",
          returnByValue: true,
          awaitPromise: false,
        },
        signal,
      );
      return;
    }
    const resolved = (await this.#session.command("DOM.resolveNode", locator, signal)) as {
      object?: { objectId?: unknown };
    };
    if (typeof resolved.object?.objectId !== "string")
      throw new Error("DOM node resolution failed");
    await callFunctionAndReleaseObject(
      this.#session,
      {
        objectId: resolved.object.objectId,
        functionDeclaration: "function(){this.click()}",
        returnByValue: true,
        awaitPromise: false,
      },
      signal,
    );
  }
  async #ensureAccessibility(signal?: AbortSignal): Promise<void> {
    if (this.#accessibilityEnabled) return;
    await this.#session.command("Accessibility.enable", {}, signal);
    this.#accessibilityEnabled = true;
  }
  async #approvalDocumentObjectId(signal?: AbortSignal): Promise<string> {
    const documentResult = (await this.#session.command(
      "Runtime.evaluate",
      {
        expression: CHATGPT_SETTINGS_DOCUMENT_EXPRESSION,
        returnByValue: false,
        awaitPromise: false,
      },
      signal,
    )) as { result?: { objectId?: unknown } };
    if (typeof documentResult.result?.objectId !== "string") {
      throw new Error("CDP approval document unavailable");
    }
    return documentResult.result.objectId;
  }
}

function isOracleApprovalControlSnapshot(value: unknown): value is {
  readonly revision: string;
  readonly controls: readonly unknown[];
  readonly documentReady: boolean;
  readonly responseInProgress: boolean;
} {
  return (
    isPlainRecord(value) &&
    typeof value.revision === "string" &&
    /^oracle-v2-\d+$/u.test(value.revision) &&
    value.implementation === 10 &&
    typeof value.documentReady === "boolean" &&
    typeof value.responseInProgress === "boolean" &&
    Array.isArray(value.controls)
  );
}

function approvalControlName(attributes: unknown, outerHTML: unknown): string | undefined {
  if (Array.isArray(attributes)) {
    for (let index = 0; index + 1 < attributes.length; index += 2) {
      if (
        String(attributes[index]).toLocaleLowerCase() === "aria-label" &&
        typeof attributes[index + 1] === "string"
      ) {
        const label = normalizeApprovalText(attributes[index + 1]);
        if (label !== "") return label;
      }
    }
  }
  if (typeof outerHTML !== "string") return undefined;
  const normalized = approvalMarkupText(outerHTML);
  return normalized === "" ? undefined : normalized;
}

function approvalMarkupText(outerHTML: string): string {
  return normalizeApprovalText(
    decodeApprovalHtml(
      outerHTML
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
        .replace(/<[^>]+>/gu, " "),
    ),
  );
}

export function isFileMaterializationApprovalScopeText(value: string): boolean {
  return (
    (value.includes("파일 생성을 허용할까요?") && value.includes("파일 첨부")) ||
    (/allow file materialization\?/iu.test(value) && /file attachments? returned by /iu.test(value))
  );
}

export function conversationApprovalAppName(value: string): string | undefined {
  return /^allow (.+) for this conversation$/iu.exec(value.trim().replace(/\s+/gu, " "))?.[1];
}

function normalizeApprovalText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function decodeApprovalHtml(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/giu, (match, decimal, hex, name) => {
    const codePoint =
      typeof decimal === "string"
        ? Number.parseInt(decimal, 10)
        : typeof hex === "string"
          ? Number.parseInt(hex, 16)
          : undefined;
    if (codePoint !== undefined && Number.isSafeInteger(codePoint) && codePoint >= 0) {
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return typeof name === "string" ? (named[name.toLocaleLowerCase()] ?? match) : match;
  });
}

function hasVisibleCdpBox(content: unknown): boolean {
  return cdpBoxCenter(content) !== undefined;
}

function cdpBoxCenter(content: unknown): { readonly x: number; readonly y: number } | undefined {
  if (
    !Array.isArray(content) ||
    content.length !== 8 ||
    !content.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  ) {
    return undefined;
  }
  const coordinates = content as [number, number, number, number, number, number, number, number];
  const width = Math.hypot(coordinates[2] - coordinates[0], coordinates[3] - coordinates[1]);
  const height = Math.hypot(coordinates[6] - coordinates[0], coordinates[7] - coordinates[1]);
  if (width <= 0 || height <= 0) return undefined;
  return {
    x: (coordinates[0] + coordinates[2] + coordinates[4] + coordinates[6]) / 4,
    y: (coordinates[1] + coordinates[3] + coordinates[5] + coordinates[7]) / 4,
  };
}

function isAllowedTarget(value: unknown): value is CdpTarget {
  if (!isStructurallyBoundedTarget(value)) return false;
  return isExactChatGptTarget(value);
}
function isExactDesktopAppTarget(value: unknown): value is CdpTarget {
  if (!isLocallyBoundCdpTarget(value)) return false;
  try {
    const url = new URL(value.url);
    if (value.type === "webview") {
      return (
        typeof value.parentId === "string" &&
        value.parentId.length > 0 &&
        exactOrigin(url) === "https://chatgpt.com"
      );
    }
    if (value.type === "other") {
      return (
        normalizeChatGptConversationUrl(value.url) !== undefined ||
        (url.href === "https://chatgpt.com/" &&
          url.username === "" &&
          url.password === "" &&
          url.search === "" &&
          url.hash === "")
      );
    }
    return (
      value.type === "page" &&
      url.protocol === "app:" &&
      url.hostname === "-" &&
      url.pathname === "/index.html" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}
function isExactChatGptTarget(value: CdpTarget): boolean {
  try {
    const url = new URL(value.url);
    return exactOrigin(url) === "https://chatgpt.com";
  } catch {
    return false;
  }
}
function isStructurallyBoundedTarget(value: unknown): value is CdpTarget {
  return isLocallyBoundCdpTarget(value) && (value.type === undefined || value.type === "page");
}
function isLocallyBoundCdpTarget(value: unknown): value is CdpTarget {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.id !== "string" ||
    v.id.length === 0 ||
    typeof v.url !== "string" ||
    typeof v.webSocketDebuggerUrl !== "string" ||
    (v.type !== undefined && !["page", "webview", "other"].includes(String(v.type)))
  ) {
    return false;
  }
  try {
    const ws = new URL(v.webSocketDebuggerUrl);
    return (
      (ws.protocol === "ws:" || ws.protocol === "wss:") &&
      ["127.0.0.1", "localhost", "[::1]"].includes(ws.hostname) &&
      ws.username === "" &&
      ws.password === ""
    );
  } catch {
    return false;
  }
}
function parseHttpsTargetUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}
function exactOwnedNavigationPendingRoute(value: string): "empty" | "about:blank" | undefined {
  if (value === "") return "empty";
  if (value === "about:blank") return "about:blank";
  return undefined;
}
function isExactOwnedCreationMarkerTarget(target: CdpTarget, creationMarker: string): boolean {
  if (target.url === ownedCreationMarkerUrl(creationMarker)) return true;
  const url = parseHttpsTargetUrl(target.url);
  return url !== undefined && isExactLegacyOwnedCreationMarkerRoute(url, creationMarker);
}
function ownedCreationMarkerUrl(creationMarker: string): string {
  return `about:blank?omnicodex_target=${encodeURIComponent(creationMarker)}`;
}
function isExactOrphanedCreationMarkerRoute(value: string): boolean {
  if (
    /^about:blank\?omnicodex_target=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    return true;
  }
  const url = parseHttpsTargetUrl(value);
  if (url === undefined) return false;
  const marker = url.searchParams.get("omnicodex_target");
  return marker !== null && isExactLegacyOwnedCreationMarkerRoute(url, marker);
}
function isExactLegacyOwnedCreationMarkerRoute(url: URL, creationMarker: string): boolean {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(creationMarker)
  ) {
    return false;
  }
  const entries = [...url.searchParams.entries()];
  return (
    exactOrigin(url) === "https://chatgpt.com" &&
    url.pathname === "/plugins" &&
    url.hash === "" &&
    entries.length === 1 &&
    entries[0]?.[0] === "omnicodex_target" &&
    entries[0]?.[1] === creationMarker
  );
}
function isExactOracleSettingsUtilityRoute(value: string, connectorId: string): boolean {
  const url = parseHttpsTargetUrl(value);
  if (url === undefined || exactOrigin(url) !== "https://chatgpt.com") return false;
  const pluginSegment = `plugin_${connectorId}`;
  const bareIndex = url.pathname === "/plugins" && url.search === "" && url.hash === "";
  const exactDetail =
    url.pathname === `/plugins/${pluginSegment}` &&
    url.search === "" &&
    url.hash === `#settings/Plugins/${pluginSegment}`;
  const legacyIndex = url.pathname === "/" && url.search === "" && url.hash === "#settings/Plugins";
  return bareIndex || exactDetail || legacyIndex;
}
function sanitizedTargetLocationEvidence(value: string): string {
  if (value === "") return "scheme=none:path=empty";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "scheme=invalid:path=invalid";
  }
  const scheme = url.protocol.slice(0, -1).toLocaleLowerCase() || "invalid";
  let path: string;
  switch (url.protocol.toLocaleLowerCase()) {
    case "about:":
      path = url.pathname === "blank" ? "blank-with-extra-state" : "other";
      break;
    case "chrome-error:":
      path = "error";
      break;
    case "chrome:":
      path = "internal";
      break;
    case "http:":
    case "https:":
      path = url.pathname === "/" ? "root" : "non-root";
      break;
    default:
      path = "redacted";
      break;
  }
  return `scheme=${scheme}:path=${path}`;
}
function exactOrigin(url: URL): string | undefined {
  return url.protocol === "https:" && url.username === "" && url.password === ""
    ? url.origin
    : undefined;
}
function exactOAuthAuthorizationOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OAuth authorization origin must be an exact credential-free HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.origin === "https://chatgpt.com"
  ) {
    throw new Error("OAuth authorization origin must be an exact credential-free HTTPS URL");
  }
  return url.origin;
}
function isChatGptSettingsRoute(url: URL, connectorId: string): boolean {
  if (
    exactOrigin(url) === "https://chatgpt.com" &&
    url.pathname === "/plugins" &&
    url.search === "" &&
    url.hash === ""
  ) {
    return true;
  }
  return sameSettingsRoute(url.toString(), connectorId);
}
function isChatGptOAuthCallbackRoute(url: URL): boolean {
  if (exactOrigin(url) !== "https://chatgpt.com" || url.hash !== "") return false;
  return (
    url.pathname === "/connector_platform_oauth_redirect" ||
    /^\/connector\/oauth\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
  );
}
function isExactChatGptSettingsReturnRoute(url: URL): boolean {
  return (
    exactOrigin(url) === "https://chatgpt.com" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === ""
  );
}
function sanitizedChatGptOAuthCallbackPath(pathname: string): string {
  return pathname === "/connector_platform_oauth_redirect" ? pathname : "/connector/oauth/";
}
function isTargetId(value: unknown, targetId: string): boolean {
  return typeof value === "object" && value !== null && (value as { id?: unknown }).id === targetId;
}
function exactOwnedSettingsNavigationPendingRoute(
  url: URL,
  connectorId: string,
): string | undefined {
  if (exactOrigin(url) !== "https://chatgpt.com" || url.search !== "") return undefined;
  const pathname = url.pathname.toLocaleLowerCase();
  const hash = url.hash.toLocaleLowerCase();
  if (pathname === "/" && (hash === "#settings" || hash === "#settings/")) {
    return "https://chatgpt.com/#settings";
  }
  const pluginSegment = `plugin_${connectorId.toLocaleLowerCase()}`;
  if (pathname === `/plugins/${pluginSegment}` && hash === "") {
    return `https://chatgpt.com/plugins/${pluginSegment}`;
  }
  return undefined;
}
function sameSettingsRoute(value: string, connectorId: string): boolean {
  try {
    const actual = new URL(value);
    const hash = actual.hash.toLocaleLowerCase();
    const normalizedConnectorId = connectorId.toLocaleLowerCase();
    const pluginSegment = `plugin_${normalizedConnectorId}`;
    return (
      actual.protocol === "https:" &&
      actual.hostname === "chatgpt.com" &&
      actual.port === "" &&
      actual.username === "" &&
      actual.password === "" &&
      actual.pathname.toLocaleLowerCase() === `/plugins/${pluginSegment}` &&
      actual.search === "" &&
      hash === `#settings/plugins/${pluginSegment}`
    );
  } catch {
    return false;
  }
}
function boundedDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(errorWithCause("CDP utility target operation cancelled", signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function isExactConnectorFrame(value: unknown, connectorId: string): value is CdpTarget {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Record<string, unknown>;
  if (
    target.type !== "iframe" ||
    typeof target.parentId !== "string" ||
    typeof target.url !== "string"
  )
    return false;
  try {
    const url = new URL(target.url);
    return (
      url.protocol === "https:" && url.hostname === `${connectorId}.web-sandbox.oaiusercontent.com`
    );
  } catch {
    return false;
  }
}

const APP_SCOPE_ROLES = new Set(["dialog", "alertdialog", "form", "group", "region"]);

export function approvalScopeNamesApp(text: string, appName: string): boolean {
  const expected = appName.trim().replace(/\s+/gu, " ");
  if (!expected) return false;
  const literal = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Keep Korean grammatical suffixes valid while separating registered names
  // such as OmniCodex and OmniCodex2. Names are literals, never regex input.
  return new RegExp(`(?<![A-Za-z0-9_])${literal}(?![A-Za-z0-9_])`, "iu").test(
    text.replace(/\s+/gu, " "),
  );
}

function exactAppScopeText(
  node: { readonly ref: string; readonly parentId?: string },
  byId: ReadonlyMap<
    string,
    {
      readonly ref: string;
      readonly role: string;
      readonly name: string;
      readonly parentId?: string;
      readonly childIds: readonly string[];
    }
  >,
  appName: string,
  scopeTextCache: Map<string, string>,
): string | undefined {
  const expected = appName.trim().toLocaleLowerCase();
  let scopeId: string | undefined = node.ref;
  const visited = new Set<string>();
  while (scopeId !== undefined) {
    if (visited.has(scopeId)) return undefined;
    visited.add(scopeId);
    const scope = byId.get(scopeId);
    if (scope === undefined) return undefined;
    if (APP_SCOPE_ROLES.has(scope.role.toLocaleLowerCase())) {
      let text = scopeTextCache.get(scope.ref);
      if (text === undefined) {
        text = subtreeText(scope.ref, byId);
        scopeTextCache.set(scope.ref, text);
      }
      if (approvalScopeNamesApp(text, expected)) return text;
    }
    scopeId = scope.parentId;
  }
  return undefined;
}

function subtreeText(
  rootId: string,
  byId: ReadonlyMap<string, { readonly name: string; readonly childIds: readonly string[] }>,
): string {
  const pending = [rootId];
  const visited = new Set<string>();
  const names: string[] = [];
  while (pending.length > 0) {
    const id = pending.shift();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    const current = byId.get(id);
    if (current === undefined) continue;
    if (current.name.trim().length > 0) names.push(current.name.trim());
    pending.push(...current.childIds);
  }
  return names.join("\n");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
