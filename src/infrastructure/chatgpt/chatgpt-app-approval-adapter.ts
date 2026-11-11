import { createHash } from "node:crypto";
export type ConsentAction = "connect" | "always_allow";
export type ConsentStrength = "connection" | "low_risk" | "persistent" | "full_access";
export type SelectorClass = "accessible-role-name" | "bounded-selector-fallback";
export interface ChatGptAccessibleNode {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  /** Bounded text from the nearest exact-app approval container. */
  readonly scopeText?: string;
  readonly selectorClass?: SelectorClass;
  readonly destructive?: boolean;
  readonly exactAppScope: boolean;
}
export interface ChatGptApprovalBinding {
  readonly appConnectorId: string;
  readonly appName: string;
  readonly oracleRunId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly mcpServerResource: string;
  readonly mcpSurface: string;
}
export interface ChatGptApprovalSnapshot extends ChatGptApprovalBinding {
  readonly domRevision: string;
  readonly connected: boolean;
  readonly alwaysAllowed: boolean;
  readonly toolResultPresent: boolean;
  readonly nodes: readonly ChatGptAccessibleNode[];
}
export interface ChatGptApprovalSurface {
  snapshot(signal?: AbortSignal): Promise<ChatGptApprovalSnapshot>;
  activate(ref: string, expectedDomRevision: string, signal?: AbortSignal): Promise<void>;
}
export interface ConsentActionReceipt extends ChatGptApprovalBinding {
  readonly timestamp: string;
  readonly action: ConsentAction;
  readonly consentStrength: ConsentStrength;
  readonly evidenceSource: "settings_reconcile" | "conversation_watcher";
  readonly selectorClass: SelectorClass;
  readonly beforeStateHash: string;
  readonly afterStateHash: string;
}
export interface WatchOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxRetries?: number;
  readonly dryRun?: boolean;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
export interface ApprovalWatchResult {
  readonly state: "tool_result" | "dry_run";
  readonly receipts: readonly ConsentActionReceipt[];
}
const CONNECT_NAMES = new Set(["connect", "연결"]);
const PERSISTENT_NAMES = new Map<string, ConsentStrength>([
  ["allow low-risk actions", "low_risk"],
  ["저위험 액션 허용", "low_risk"],
  ["always allow", "persistent"],
  ["항상 허용", "persistent"],
  ["allow all actions", "full_access"],
  ["모든 액션 허용", "full_access"],
  ["모두 허용", "full_access"],
]);
const STRENGTH_ORDER: Record<ConsentStrength, number> = {
  connection: 0,
  low_risk: 0,
  full_access: 1,
  persistent: 2,
};

/** Shared discovery contract for the CLI target selector and the click engine. */
export function supportedConsentControlStrength(name: string): ConsentStrength | undefined {
  const label = name.trim().toLocaleLowerCase();
  if (CONNECT_NAMES.has(label)) return "connection";
  return PERSISTENT_NAMES.get(label);
}

/** Exact-identity, fail-closed companion; it never launches, profiles, or kills Chrome. */
export class ChatGptAppApprovalAdapter {
  readonly #binding: ChatGptApprovalBinding;
  constructor(binding: ChatGptApprovalBinding) {
    for (const [key, value] of Object.entries(binding))
      if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} is required`);
    this.#binding = { ...binding };
  }
  async watch(
    surface: ChatGptApprovalSurface,
    options: WatchOptions = {},
  ): Promise<ApprovalWatchResult> {
    const timeout = options.timeoutMs,
      interval = options.pollIntervalMs ?? 250,
      retries = options.maxRetries;
    if (
      (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1)) ||
      interval < 10 ||
      (retries !== undefined && (!Number.isSafeInteger(retries) || retries < 0))
    ) {
      throw new Error("Invalid watcher bounds");
    }
    const now = options.now ?? (() => new Date()),
      sleep = options.sleep ?? delay,
      deadline = timeout === undefined ? Number.POSITIVE_INFINITY : now().getTime() + timeout,
      receipts: ConsentActionReceipt[] = [];
    let attempts = 0;
    while (now().getTime() <= deadline) {
      options.signal?.throwIfAborted();
      const before = await surface.snapshot(options.signal);
      this.#assertBound(before);
      if (before.toolResultPresent) {
        if (!before.connected || !before.alwaysAllowed) {
          throw new Error("CONSENT_FINAL_STATE_NOT_CONFIRMED");
        }
        return { state: "tool_result", receipts };
      }
      const match = this.#visibleTarget(before);
      if (match === undefined) {
        if (!before.connected) this.#target(before, "connect");
        if (!before.alwaysAllowed) this.#target(before, "always_allow");
        await sleep(interval, options.signal);
        continue;
      }
      const { action, target, consentStrength } = match;
      if (options.dryRun === true) return { state: "dry_run", receipts };
      try {
        await surface.activate(target.ref, before.domRevision, options.signal);
        const after = await surface.snapshot(options.signal);
        this.#assertBound(after);
        if (after.domRevision === before.domRevision) throw new Error("STALE_DOM");
        if (this.#visibleTarget(after)?.action === action)
          throw new Error("CONSENT_STATE_NOT_CONFIRMED");
        if (action === "connect" && !after.connected) {
          throw new Error("CONNECTION_STATE_NOT_CONFIRMED");
        }
        if (action === "always_allow" && (!after.connected || !after.alwaysAllowed)) {
          throw new Error("PERSISTENT_CONSENT_STATE_NOT_CONFIRMED");
        }
        const receiptBase = {
          timestamp: now().toISOString(),
          ...this.#binding,
          evidenceSource: "conversation_watcher" as const,
          selectorClass: target.selectorClass ?? "accessible-role-name",
          beforeStateHash: stateHash(before),
          afterStateHash: stateHash(after),
        } as const;
        receipts.push({
          ...receiptBase,
          action,
          consentStrength,
        });
        attempts = 0;
      } catch (error) {
        attempts += 1;
        if (retries !== undefined && attempts > retries) throw error;
        const remaining = deadline - now().getTime();
        if (remaining <= 0) break;
        await sleep(Math.min(interval, remaining), options.signal);
      }
    }
    throw new Error("CHATGPT_APPROVAL_TIMEOUT");
  }
  #assertBound(snapshot: ChatGptApprovalSnapshot): void {
    for (const key of Object.keys(this.#binding) as (keyof ChatGptApprovalBinding)[])
      if (snapshot[key] !== this.#binding[key])
        throw new Error(`STALE_OR_WRONG_${key.toUpperCase()}`);
  }
  #target(snapshot: ChatGptApprovalSnapshot, action: ConsentAction): ChatGptAccessibleNode {
    const match = this.#match(snapshot, action);
    if (match === undefined) throw new Error("CONSENT_CONTROL_MISSING");
    return match.target;
  }
  #visibleTarget(snapshot: ChatGptApprovalSnapshot): ConsentMatch | undefined {
    for (const action of ["always_allow", "connect"] as const) {
      const match = this.#match(snapshot, action);
      if (match !== undefined) return match;
    }
    return undefined;
  }
  #match(snapshot: ChatGptApprovalSnapshot, action: ConsentAction): ConsentMatch | undefined {
    const matches = snapshot.nodes
      .filter((node) => node.role.toLocaleLowerCase() === "button" && node.exactAppScope)
      .map((target): ConsentMatch | undefined => {
        const consentStrength = supportedConsentControlStrength(target.name);
        if (action === "connect" && consentStrength === "connection")
          return { action, target, consentStrength: "connection" };
        return action === "always_allow" &&
          (consentStrength === "persistent" || consentStrength === "full_access")
          ? { action, target, consentStrength }
          : undefined;
      })
      .filter((match): match is ConsentMatch => match !== undefined)
      .sort(
        (left, right) =>
          STRENGTH_ORDER[right.consentStrength] - STRENGTH_ORDER[left.consentStrength],
      );
    if (matches.length === 0) return undefined;
    const strongest = matches[0] as ConsentMatch;
    if (matches.filter((match) => match.consentStrength === strongest.consentStrength).length !== 1)
      throw new Error("CONSENT_CONTROL_AMBIGUOUS");
    return strongest;
  }
}
interface ConsentMatch {
  readonly action: ConsentAction;
  readonly target: ChatGptAccessibleNode;
  readonly consentStrength: ConsentStrength;
}
export function assertExplicitLoopbackCdpEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("CDP endpoint must be an explicitly configured HTTP loopback endpoint");
  if (url.port === "") throw new Error("CDP endpoint requires an explicit port");
  return url;
}
function stateHash(s: ChatGptApprovalSnapshot): string {
  const safe = {
    ...s,
    nodes: s.nodes.map(({ role, name, selectorClass, destructive, exactAppScope }) => ({
      role,
      name,
      selectorClass,
      destructive,
      exactAppScope,
    })),
  };
  return createHash("sha256").update(JSON.stringify(safe)).digest("hex");
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
