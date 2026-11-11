import type { ChatGptApprovalBinding } from "../infrastructure/chatgpt/chatgpt-app-approval-adapter.js";
import {
  BoundedCdpSession,
  CdpChatGptApprovalSurface,
  type CdpWebSocketLike,
  ChatGptLoopbackCdpTransport,
  DEFAULT_CDP_FRAME_BUDGET_BYTES,
  DESKTOP_CHAT_SELECTED_CONVERSATION_EXPRESSION,
} from "../infrastructure/chatgpt/chatgpt-cdp-transport.js";
import { normalizeChatGptConversationUrl } from "../infrastructure/chatgpt/chatgpt-conversation-route.js";
import {
  type OracleApprovalEventTarget,
  type OracleConversationNotification,
  oracleNotificationRequiresConnectorRead,
} from "../infrastructure/chatgpt/oracle-conversation-event-source.js";
import type { DesktopChatObservedEvent } from "../infrastructure/windows/desktop-chat-event-source.js";
import {
  ORACLE_POTENTIAL_APPROVAL_LABELS,
  type OracleApprovalStrength,
  selectApprovalControl,
} from "./oracle-approval-popup-watcher.js";

export interface DesktopChatApprovalActivation {
  readonly label: string;
  readonly strength: OracleApprovalStrength;
  readonly targetId: string;
}

export interface DesktopChatApprovalObserverEvent {
  readonly outcome: "activated" | "failed";
  readonly accountSourceId?: string;
  readonly targetId: string;
  readonly conversationUrl: string;
  readonly pendingMessageId?: string;
  readonly label?: string;
  readonly strength?: OracleApprovalStrength;
  readonly error?: string;
}

type Scope = { readonly accountSourceId: string; readonly connectorIds: readonly string[] };
type ActivationInput = {
  readonly event: DesktopChatObservedEvent;
  readonly accountSourceId: string;
  readonly connectorId: string;
  readonly approval: OracleApprovalEventTarget;
  readonly refreshConversationSurface?: boolean;
  readonly onControlReady?: () => void;
};

export interface DesktopChatResourceApprovalInput {
  readonly endpoint: string;
  readonly correlationId: string;
  readonly chatGptConversationUrl?: string;
}

/** Activates only an exact OmniCodex approval announced by the same Desktop Chat target. */
export class DesktopChatApprovalObserver {
  readonly #abort = new AbortController();
  readonly #completed = new Set<string>();
  readonly #flights = new Map<string, Promise<void>>();
  readonly #events = new Map<string, Promise<void>>();
  readonly #resourceWaits = new Map<
    string,
    {
      receiptKey: string;
      controller: AbortController;
      dispatching: boolean;
    }
  >();

  constructor(
    private readonly options: {
      readonly readScope: (signal: AbortSignal) => Promise<Scope>;
      readonly report: (event: DesktopChatApprovalObserverEvent) => Promise<void> | void;
      readonly activate?: (
        input: ActivationInput,
        signal: AbortSignal,
      ) => Promise<DesktopChatApprovalActivation>;
    },
  ) {}

  accept(event: DesktopChatObservedEvent): Promise<void> {
    if (!notificationHasConfirmAction(event.notification)) return Promise.resolve();
    // Serialize actions only on the same conversation surface. An absent or
    // slow approval card must not hold up an independent Chat's approval.
    const key = `${event.source.endpoint}\0${event.conversationUrl}`;
    const accepted = (this.#events.get(key) ?? Promise.resolve()).then(() => this.#accept(event));
    const settled = accepted
      .catch(() => undefined)
      .finally(() => {
        if (this.#events.get(key) === settled) this.#events.delete(key);
      });
    this.#events.set(key, settled);
    return accepted;
  }

  acceptResourceDelivery(input: DesktopChatResourceApprovalInput): Promise<void> {
    return this.#acceptResourceDelivery(input);
  }

  async #acceptResourceDelivery(input: DesktopChatResourceApprovalInput): Promise<void> {
    this.#abort.signal.throwIfAborted();
    let scope: Scope | undefined;
    let connectorId: string;
    let urls: readonly string[];
    try {
      scope = await this.options.readScope(this.#abort.signal);
      const selected = [...new Set(scope.connectorIds)].sort((left, right) =>
        left.localeCompare(right, "en"),
      )[0];
      if (selected === undefined) return;
      connectorId = selected;
      urls =
        input.chatGptConversationUrl === undefined
          ? await resourceConversationUrls(input.endpoint, this.#abort.signal)
          : [input.chatGptConversationUrl];
    } catch (error) {
      if (this.#abort.signal.aborted) return;
      await this.options.report({
        outcome: "failed",
        ...(scope === undefined ? {} : { accountSourceId: scope.accountSourceId }),
        targetId: "resource-delivery",
        conversationUrl: input.chatGptConversationUrl ?? "",
        pendingMessageId: input.correlationId,
        error: String(error),
      });
      return;
    }
    for (const conversationUrl of urls) {
      const normalized = normalizeChatGptConversationUrl(conversationUrl);
      if (normalized === undefined) continue;
      const receiptKey = `resource-receipt:${scope.accountSourceId}:${input.correlationId}:${normalized}`;
      if (this.#completed.has(receiptKey)) continue;
      const flightKey = `resource-flight:${scope.accountSourceId}:${normalized}`;
      let existing = this.#flights.get(flightKey);
      while (existing !== undefined) {
        const waiting = this.#resourceWaits.get(flightKey);
        if (waiting && waiting.receiptKey !== receiptKey && !waiting.dispatching)
          waiting.controller.abort(new Error("DESKTOP_APPROVAL_WAIT_SUPERSEDED_BY_RESOURCE"));
        await existing;
        this.#abort.signal.throwIfAborted();
        existing = this.#flights.get(flightKey);
      }
      // A shared conversation flight serializes distinct receipts; it does
      // not acknowledge them. Only an exact completed receipt is a duplicate.
      if (this.#completed.has(receiptKey)) continue;
      const event: DesktopChatObservedEvent = {
        source: { endpoint: input.endpoint, processId: 0, startedAtIso: new Date().toISOString() },
        targetId: "resource-delivery",
        conversationUrl: normalized,
        notification: { type: "conversation-update", payload: null },
      };
      const waiting = { receiptKey, controller: new AbortController(), dispatching: false };
      this.#resourceWaits.set(flightKey, waiting);
      const activationInput: ActivationInput = {
        event,
        accountSourceId: scope.accountSourceId,
        connectorId,
        approval: { pendingMessageId: input.correlationId, targetMessageIds: [] },
        refreshConversationSurface: true,
        onControlReady: () => {
          waiting.dispatching = true;
        },
      };
      const flight = this.#activate(
        receiptKey,
        activationInput,
        AbortSignal.any([this.#abort.signal, waiting.controller.signal]),
      )
        .catch(async (error) => {
          if (this.#abort.signal.aborted) return;
          await this.options.report({
            outcome: "failed",
            accountSourceId: scope.accountSourceId,
            targetId: event.targetId,
            conversationUrl: normalized,
            pendingMessageId: input.correlationId,
            error: String(error),
          });
        })
        .finally(() => {
          this.#flights.delete(flightKey);
          this.#resourceWaits.delete(flightKey);
        });
      this.#flights.set(flightKey, flight);
      await flight;
    }
  }

  async #accept(event: DesktopChatObservedEvent): Promise<void> {
    this.#abort.signal.throwIfAborted();
    let scope: Scope | undefined;
    try {
      scope = await this.options.readScope(this.#abort.signal);
      const matches = new Map<string, ActivationInput>();
      for (const connectorId of new Set(scope.connectorIds)) {
        oracleNotificationRequiresConnectorRead(
          event.notification,
          connectorId,
          "OmniCodex",
          (approval) => {
            const key = activationKey(scope as Scope, event, connectorId, approval);
            matches.set(key, {
              event,
              accountSourceId: (scope as Scope).accountSourceId,
              connectorId,
              approval,
            });
          },
        );
      }
      for (const [key, input] of matches) {
        if (this.#completed.has(key)) continue;
        const resourceKey = `resource-flight:${scope.accountSourceId}:${event.conversationUrl}`;
        const waiting = this.#resourceWaits.get(resourceKey);
        if (waiting && !waiting.dispatching) {
          waiting.controller.abort(new Error("DESKTOP_APPROVAL_WAIT_REPLACED_BY_NATIVE_REQUEST"));
          await this.#flights.get(resourceKey);
        }
        const existing = this.#flights.get(key);
        if (existing !== undefined) {
          await existing;
          continue;
        }
        const flight = this.#activate(key, input).finally(() => this.#flights.delete(key));
        this.#flights.set(key, flight);
        await flight;
      }
    } catch (error) {
      if (this.#abort.signal.aborted) return;
      await this.options.report({
        outcome: "failed",
        ...(scope === undefined ? {} : { accountSourceId: scope.accountSourceId }),
        targetId: event.targetId,
        conversationUrl: event.conversationUrl,
        error: String(error),
      });
    }
  }

  async #activate(key: string, input: ActivationInput, signal = this.#abort.signal): Promise<void> {
    const activation = await (this.options.activate ?? activateDesktopApproval)(input, signal);
    const after = await this.options.readScope(this.#abort.signal);
    if (
      after.accountSourceId !== input.accountSourceId ||
      !after.connectorIds.includes(input.connectorId)
    ) {
      throw new Error("DESKTOP_APPROVAL_ACCOUNT_CHANGED");
    }
    this.#completed.add(key);
    trimSet(this.#completed, 2_048);
    await this.options.report({
      outcome: "activated",
      accountSourceId: input.accountSourceId,
      targetId: activation.targetId,
      conversationUrl: input.event.conversationUrl,
      pendingMessageId: input.approval.pendingMessageId,
      label: activation.label,
      strength: activation.strength,
    });
  }

  async stop(): Promise<void> {
    this.#abort.abort(new Error("Desktop Chat approval observer stopped"));
    await Promise.allSettled(this.#events.values());
    await Promise.allSettled(this.#flights.values());
  }
}

async function activateDesktopApproval(
  input: ActivationInput,
  outerSignal: AbortSignal,
): Promise<DesktopChatApprovalActivation> {
  const signal = outerSignal;
  const transport = new ChatGptLoopbackCdpTransport({
    endpoint: input.event.source.endpoint,
    allowDesktopAppTargets: true,
    timeoutMs: 10_000,
  });
  const conversationId = exactDesktopConversationId(input.event.conversationUrl);
  const binding: ChatGptApprovalBinding = {
    appConnectorId: input.connectorId,
    appName: "OmniCodex",
    oracleRunId: input.approval.pendingMessageId,
    sessionId: input.accountSourceId,
    correlationId: `${input.event.targetId}:${input.approval.pendingMessageId}`,
    mcpServerResource: "desktop-chat",
    mcpSurface: "desktop-chat",
  };
  const candidates: Array<{
    readonly targetId: string;
    readonly session: BoundedCdpSession;
    readonly surface: CdpChatGptApprovalSurface;
    readonly conversationSurface: boolean;
  }> = [];
  try {
    const inventory = await transport.listChatGptTargets(signal);
    const ordered = [...inventory].sort((left, right) => {
      if (left.id === input.event.targetId) return -1;
      if (right.id === input.event.targetId) return 1;
      return left.id.localeCompare(right.id, "en");
    });
    const selectedParentIds = new Set<string>();
    for (const target of ordered.filter(isDesktopAppPage)) {
      signal.throwIfAborted();
      let session: BoundedCdpSession | undefined;
      try {
        session = await BoundedCdpSession.connect(
          transport,
          {
            factory: (url) => new WebSocket(url) as unknown as CdpWebSocketLike,
            targetId: target.id,
            target,
            timeoutMs: 10_000,
            maxFrameBytes: DEFAULT_CDP_FRAME_BUDGET_BYTES,
          },
          signal,
        );
        const selected = await selectedDesktopConversationId(session, signal);
        if (selected !== conversationId) {
          session.close();
          continue;
        }
        selectedParentIds.add(target.id);
        const surface = new CdpChatGptApprovalSurface(
          session,
          { ...binding, correlationId: `${target.id}:${input.approval.pendingMessageId}` },
          "OmniCodex tool result",
          ["OmniCodex"],
        );
        await surface.claimApprovalOwnership(signal);
        candidates.push({ targetId: target.id, session, surface, conversationSurface: false });
      } catch (error) {
        session?.close();
        if (signal.aborted) throw error;
      }
    }
    const resumableHomeTargetId = uniqueDesktopChatHomeTargetId(
      ordered,
      input.event.conversationUrl,
    );
    for (const target of ordered.filter((candidate) =>
      isDesktopChatSurface(
        candidate,
        input.event.conversationUrl,
        selectedParentIds,
        resumableHomeTargetId,
      ),
    )) {
      signal.throwIfAborted();
      let session: BoundedCdpSession | undefined;
      try {
        session = await BoundedCdpSession.connect(
          transport,
          {
            factory: (url) => new WebSocket(url) as unknown as CdpWebSocketLike,
            targetId: target.id,
            target,
            timeoutMs: 10_000,
            maxFrameBytes: DEFAULT_CDP_FRAME_BUDGET_BYTES,
          },
          signal,
        );
        if (normalizeChatGptConversationUrl(target.url) !== input.event.conversationUrl) {
          await session.command("Page.navigate", { url: input.event.conversationUrl }, signal);
          await delay(1_000, signal);
        }
        const surface = new CdpChatGptApprovalSurface(
          session,
          { ...binding, correlationId: `${target.id}:${input.approval.pendingMessageId}` },
          "OmniCodex tool result",
          ["OmniCodex"],
        );
        await surface.claimApprovalOwnership(signal);
        candidates.push({ targetId: target.id, session, surface, conversationSurface: true });
      } catch (error) {
        session?.close();
        if (signal.aborted) throw error;
      }
    }
    // The approval card is rendered by the exact conversation guest. Electron
    // can replace or detach its parent App page while the guest remains usable;
    // retaining that parent as the first polling candidate turns a healthy
    // approval into a false "CDP session closed" failure. Once an exact guest
    // exists, use it as the authoritative renderer surface.
    if (candidates.some((candidate) => candidate.conversationSurface)) {
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const candidate = candidates[index];
        if (candidate?.conversationSurface !== false) continue;
        candidate.session.close();
        candidates.splice(index, 1);
      }
    }
    // Electron can publish the resource result a few milliseconds before the
    // corresponding guest appears in /json/list. Retry only the local CDP
    // inventory for the exact conversation; this performs no ChatGPT request
    // and never scans unrelated conversations.
    while (candidates.length === 0) {
      await delay(100, signal);
      const retryInventory = await transport.listChatGptTargets(signal);
      const resumableRetryTargetId = uniqueDesktopChatHomeTargetId(
        retryInventory,
        input.event.conversationUrl,
      );
      const exactGuests = retryInventory.filter((target) =>
        isDesktopChatSurface(
          target,
          input.event.conversationUrl,
          new Set<string>(),
          resumableRetryTargetId,
        ),
      );
      for (const target of exactGuests) {
        let session: BoundedCdpSession | undefined;
        try {
          session = await BoundedCdpSession.connect(
            transport,
            {
              factory: (url) => new WebSocket(url) as unknown as CdpWebSocketLike,
              targetId: target.id,
              target,
              timeoutMs: 10_000,
              maxFrameBytes: DEFAULT_CDP_FRAME_BUDGET_BYTES,
            },
            signal,
          );
          const surface = new CdpChatGptApprovalSurface(
            session,
            { ...binding, correlationId: `${target.id}:${input.approval.pendingMessageId}` },
            "OmniCodex tool result",
            ["OmniCodex"],
          );
          await surface.claimApprovalOwnership(signal);
          candidates.push({ targetId: target.id, session, surface, conversationSurface: true });
        } catch (error) {
          session?.close();
          if (signal.aborted) throw error;
        }
      }
    }
    let refreshPending = input.refreshConversationSurface === true;
    while (true) {
      signal.throwIfAborted();
      for (const candidate of [...candidates]) {
        try {
          const snapshot = await candidate.surface.approvalControlSnapshot(
            ORACLE_POTENTIAL_APPROVAL_LABELS,
            signal,
          );
          const control = selectDesktopApprovalControl(snapshot.nodes);
          if (control === undefined) continue;
          input.onControlReady?.();
          for (const other of candidates) {
            if (other !== candidate) other.session.close();
          }
          return await activateDesktopApprovalControl(candidate, snapshot, control, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          candidate.session.close();
          const index = candidates.indexOf(candidate);
          if (index >= 0) candidates.splice(index, 1);
          if (candidates.length === 0) throw error;
        }
      }
      if (refreshPending) {
        refreshPending = false;
        const surfaces = candidates.filter((candidate) => candidate.conversationSurface);
        for (const candidate of surfaces) {
          await candidate.session.command(
            "Page.navigate",
            { url: input.event.conversationUrl },
            signal,
          );
        }
        if (surfaces.length > 0) {
          await delay(1_000, signal);
          for (const candidate of surfaces) await candidate.surface.claimApprovalOwnership(signal);
        }
      }
      await delay(100, signal);
    }
  } finally {
    for (const candidate of candidates) candidate.session.close();
  }
}

async function resourceConversationUrls(
  endpoint: string,
  signal: AbortSignal,
): Promise<readonly string[]> {
  const transport = new ChatGptLoopbackCdpTransport({
    endpoint,
    allowDesktopAppTargets: true,
    timeoutMs: 10_000,
  });
  const targets = await transport.listChatGptTargets(signal);
  return [
    ...new Set(
      targets
        .filter((target) => target.type === "other")
        .map((target) => normalizeChatGptConversationUrl(target.url))
        .filter((url): url is string => url !== undefined),
    ),
  ];
}

async function activateDesktopApprovalControl(
  candidate: {
    readonly targetId: string;
    readonly surface: CdpChatGptApprovalSurface;
  },
  initialSnapshot: Awaited<ReturnType<CdpChatGptApprovalSurface["approvalControlSnapshot"]>>,
  initialControl: NonNullable<ReturnType<typeof selectApprovalControl>>,
  signal: AbortSignal,
): Promise<DesktopChatApprovalActivation> {
  let snapshot = initialSnapshot;
  let control: ReturnType<typeof selectApprovalControl> = initialControl;
  let activated: DesktopChatApprovalActivation | undefined;
  while (true) {
    signal.throwIfAborted();
    if (control === undefined) {
      if (activated !== undefined) return activated;
      await delay(100, signal);
      snapshot = await candidate.surface.approvalControlSnapshot(
        ORACLE_POTENTIAL_APPROVAL_LABELS,
        signal,
      );
      control = selectDesktopApprovalControl(snapshot.nodes);
      continue;
    }
    if (
      activated !== undefined &&
      (activated.strength !== "materialization_options" || control.strength !== "persistent")
    ) {
      throw new Error("DESKTOP_APPROVAL_CONTROL_DID_NOT_SETTLE");
    }
    await candidate.surface.activate(control.node.ref, snapshot.domRevision, signal);
    activated = {
      label: control.node.name,
      strength: control.strength,
      targetId: candidate.targetId,
    };
    if (activated.strength !== "materialization_options") {
      // activate() returns only after the exact revision-bound DOM action was
      // dispatched. Desktop may replace the guest immediately afterwards, so
      // attempting another read can turn a successful Allow into a false
      // "CDP session closed" failure. Conversation completion remains the
      // authoritative downstream readback.
      return activated;
    }
    while (true) {
      await delay(100, signal);
      const after = await candidate.surface.approvalControlSnapshot(
        ORACLE_POTENTIAL_APPROVAL_LABELS,
        signal,
      );
      const next = selectDesktopApprovalControl(after.nodes);
      if (next === undefined) return activated;
      if (
        next.node.ref !== control.node.ref ||
        next.strength !== control.strength ||
        after.domRevision !== snapshot.domRevision
      ) {
        snapshot = after;
        control = next;
        break;
      }
    }
  }
}

export function selectDesktopApprovalControl(
  nodes: Parameters<typeof selectApprovalControl>[0],
): ReturnType<typeof selectApprovalControl> {
  const preferred = selectApprovalControl(nodes);
  if (preferred?.strength !== "materialization_options") return preferred;
  // Opening the materialization dropdown can replace the Electron guest and
  // close its CDP session. The primary Allow button is the same exact card and
  // completes the pending request in one renderer-local action. A subsequent
  // card is handled by its own result event.
  return (
    selectApprovalControl(
      nodes.filter(
        (node) => node.name.trim().toLocaleLowerCase() !== "file materialization options",
      ),
    ) ?? preferred
  );
}

async function selectedDesktopConversationId(
  session: BoundedCdpSession,
  signal: AbortSignal,
): Promise<string | undefined> {
  const evaluated = (await session.command(
    "Runtime.evaluate",
    {
      expression: DESKTOP_CHAT_SELECTED_CONVERSATION_EXPRESSION,
      returnByValue: true,
      awaitPromise: false,
    },
    signal,
  )) as { result?: { value?: unknown } };
  const value = evaluated.result?.value;
  return typeof value === "string" && /^[a-z0-9-]+$/iu.test(value) ? value : undefined;
}

function exactDesktopConversationId(conversationUrl: string): string {
  const prefix = "https://chatgpt.com/c/";
  const id = conversationUrl.slice(prefix.length);
  if (conversationUrl !== `${prefix}${id}` || !/^[a-z0-9-]+$/iu.test(id)) {
    throw new Error("DESKTOP_APPROVAL_CONVERSATION_INVALID");
  }
  return id;
}

function isDesktopAppPage(target: { readonly type?: string; readonly url: string }): boolean {
  if (target.type !== "page") return false;
  try {
    const url = new URL(target.url);
    return url.protocol === "app:" && url.hostname === "-" && url.pathname === "/index.html";
  } catch {
    return false;
  }
}

function isDesktopChatSurface(
  target: {
    readonly id: string;
    readonly type?: string;
    readonly url: string;
    readonly parentId?: string;
  },
  conversationUrl: string,
  selectedParentIds: ReadonlySet<string>,
  resumableHomeTargetId?: string,
): boolean {
  try {
    const url = new URL(target.url);
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || url.port !== "") {
      return false;
    }
    if (target.type === "webview") {
      return typeof target.parentId === "string" && selectedParentIds.has(target.parentId);
    }
    // Electron changes a navigated guest from `webview` to `other` and drops
    // parentId. In that state the exact conversation URL is the durable
    // association supplied by the native confirm_action event.
    return (
      target.type === "other" &&
      (normalizeChatGptConversationUrl(target.url) === conversationUrl ||
        target.id === resumableHomeTargetId)
    );
  } catch {
    return false;
  }
}

function uniqueDesktopChatHomeTargetId(
  targets: readonly { readonly id: string; readonly type?: string; readonly url: string }[],
  conversationUrl: string,
): string | undefined {
  if (
    targets.some(
      (target) =>
        target.type === "other" && normalizeChatGptConversationUrl(target.url) === conversationUrl,
    )
  )
    return undefined;
  const home = targets.filter(
    (target) => target.type === "other" && target.url === "https://chatgpt.com/",
  );
  return home.length === 1 ? home[0]?.id : undefined;
}

function notificationHasConfirmAction(notification: OracleConversationNotification): boolean {
  if (notification.type !== "conversation-update") return false;
  let found = false;
  const visit = (value: unknown): void => {
    if (found) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const object = value as Record<string, unknown>;
    const metadata = object.metadata as Record<string, unknown> | undefined;
    const jit = metadata?.jit_plugin_data as { from_server?: { type?: unknown } } | undefined;
    if (jit?.from_server?.type === "confirm_action") {
      found = true;
      return;
    }
    for (const [name, child] of Object.entries(object))
      if (name !== "content" && name !== "text") visit(child);
  };
  visit(notification.payload);
  return found;
}

function activationKey(
  scope: Scope,
  event: DesktopChatObservedEvent,
  connectorId: string,
  approval: OracleApprovalEventTarget,
): string {
  return [
    scope.accountSourceId,
    event.source.processId,
    event.source.startedAtIso,
    event.conversationUrl,
    connectorId,
    approval.pendingMessageId,
    [...approval.targetMessageIds].sort().join(","),
  ].join("\0");
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    function done(): void {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", aborted);
      reject(signal.reason);
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function trimSet(values: Set<string>, limit: number): void {
  while (values.size > limit) {
    const first = values.values().next().value as string | undefined;
    if (first === undefined) return;
    values.delete(first);
  }
}
