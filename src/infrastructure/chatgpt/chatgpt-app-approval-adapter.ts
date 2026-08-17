import { createHash } from "node:crypto";
export type ConsentAction = "connect" | "always_allow";
export type SelectorClass = "accessible-role-name" | "bounded-selector-fallback";
export interface ChatGptAccessibleNode {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly selectorClass?: SelectorClass;
  readonly destructive?: boolean;
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
const NAMES: Record<ConsentAction, ReadonlySet<string>> = {
  connect: new Set(["connect", "연결"]),
  always_allow: new Set(["always allow", "항상 허용"]),
};
const FORBIDDEN =
  /delete|remove|disconnect|삭제|제거|연결 해제|allow once|이번만 허용|confirm|확인/i;

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
    const timeout = options.timeoutMs ?? 30_000,
      interval = options.pollIntervalMs ?? 250,
      retries = options.maxRetries ?? 1;
    if (timeout < 1 || interval < 10 || retries < 0) throw new Error("Invalid watcher bounds");
    const now = options.now ?? (() => new Date()),
      sleep = options.sleep ?? delay,
      deadline = now().getTime() + timeout,
      receipts: ConsentActionReceipt[] = [];
    let attempts = 0;
    while (now().getTime() <= deadline) {
      options.signal?.throwIfAborted();
      const before = await surface.snapshot(options.signal);
      this.#assertBound(before);
      if (before.toolResultPresent) return { state: "tool_result", receipts };
      const action = this.#visibleAction(before);
      if (action === undefined) {
        if (!before.connected) this.#target(before, "connect");
        if (!before.alwaysAllowed) this.#target(before, "always_allow");
        await sleep(interval, options.signal);
        continue;
      }
      const target = this.#target(before, action);
      if (options.dryRun === true) return { state: "dry_run", receipts };
      try {
        await surface.activate(target.ref, before.domRevision, options.signal);
        const after = await surface.snapshot(options.signal);
        this.#assertBound(after);
        if (after.domRevision === before.domRevision) throw new Error("STALE_DOM");
        if (this.#visibleAction(after) === action) throw new Error("CONSENT_STATE_NOT_CONFIRMED");
        receipts.push({
          timestamp: now().toISOString(),
          action,
          ...this.#binding,
          selectorClass: target.selectorClass ?? "accessible-role-name",
          beforeStateHash: stateHash(before),
          afterStateHash: stateHash(after),
        });
        attempts = 0;
      } catch (error) {
        if (++attempts > retries) throw error;
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
    const matches = snapshot.nodes.filter(
      (n) =>
        n.role.toLowerCase() === "button" &&
        NAMES[action].has(n.name.trim().toLocaleLowerCase()) &&
        n.destructive !== true &&
        !FORBIDDEN.test(n.name),
    );
    if (matches.length !== 1)
      throw new Error(`CONSENT_CONTROL_${matches.length ? "AMBIGUOUS" : "MISSING"}`);
    return matches[0] as ChatGptAccessibleNode;
  }
  #visibleAction(snapshot: ChatGptApprovalSnapshot): ConsentAction | undefined {
    for (const action of ["always_allow", "connect"] as const) {
      const matches = snapshot.nodes.filter(
        (node) =>
          node.role.toLocaleLowerCase() === "button" &&
          NAMES[action].has(node.name.trim().toLocaleLowerCase()) &&
          node.destructive !== true &&
          !FORBIDDEN.test(node.name),
      );
      if (matches.length > 1) throw new Error(`CONSENT_CONTROL_AMBIGUOUS`);
      if (matches.length === 1) return action;
    }
    return undefined;
  }
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
    nodes: s.nodes.map(({ role, name, selectorClass, destructive }) => ({
      role,
      name,
      selectorClass,
      destructive,
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
