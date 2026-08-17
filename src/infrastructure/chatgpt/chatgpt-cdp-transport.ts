import { createHash, randomUUID } from "node:crypto";
import {
  assertExplicitLoopbackCdpEndpoint,
  type ChatGptApprovalBinding,
  type ChatGptApprovalSnapshot,
  type ChatGptApprovalSurface,
} from "./chatgpt-app-approval-adapter.js";

export interface CdpTarget {
  readonly id: string;
  readonly type?: string;
  readonly parentId?: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}
export interface CdpTransportOptions {
  readonly endpoint: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}
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
  readonly timeoutMs?: number;
  readonly maxPending?: number;
  readonly maxFrameBytes?: number;
}
const ALLOWED_METHODS = new Set([
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "DOM.enable",
  "DOM.getDocument",
  "DOM.querySelector",
  "DOM.getAttributes",
  "DOM.getOuterHTML",
  "DOM.resolveNode",
  "Runtime.enable",
  "Runtime.callFunctionOn",
]);

/** Attach-only CDP transport. It has no navigation, evaluate, browser, profile, or process API. */
export class ChatGptLoopbackCdpTransport {
  readonly #base: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeout: number;
  readonly #max: number;
  constructor(options: CdpTransportOptions) {
    this.#base = assertExplicitLoopbackCdpEndpoint(options.endpoint);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = options.timeoutMs ?? 5_000;
    this.#max = options.maxResponseBytes ?? 1_000_000;
    if (this.#timeout < 1 || this.#max < 1) throw new Error("Invalid CDP bounds");
  }
  async preflight(
    signal?: AbortSignal,
    targetId?: string,
  ): Promise<{ browser: string; target: CdpTarget }> {
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
      .filter(isAllowedTarget)
      .filter((target) => (targetId === undefined ? true : target.id === targetId));
    if (allowed.length !== 1) throw new Error("CHATGPT_TARGET_MISSING_OR_AMBIGUOUS");
    return { browser: version.Browser, target: allowed[0] as CdpTarget };
  }
  async listChatGptTargets(
    signal?: AbortSignal,
    connectorId?: string,
  ): Promise<readonly CdpTarget[]> {
    const targets = await this.#json("/json/list", signal);
    if (!Array.isArray(targets)) throw new Error("CDP target list invalid");
    const pages = targets.filter(isAllowedTarget);
    if (connectorId === undefined) return pages;
    const parents = new Set(
      targets
        .filter((target): target is CdpTarget => isExactConnectorFrame(target, connectorId))
        .map((target) => target.parentId as string),
    );
    return pages.filter((target) => parents.has(target.id));
  }
  assertAllowedCommand(method: string, params: unknown): void {
    if (!ALLOWED_METHODS.has(method)) throw new Error(`CDP method forbidden: ${method}`);
    if (method === "Runtime.callFunctionOn") {
      const call = params as {
        functionDeclaration?: unknown;
        objectId?: unknown;
        returnByValue?: unknown;
        awaitPromise?: unknown;
      };
      if (
        call.functionDeclaration !== "function(){this.click()}" ||
        typeof call.objectId !== "string" ||
        call.objectId.length === 0 ||
        call.returnByValue !== true ||
        call.awaitPromise !== false
      )
        throw new Error("Only bounded element click is allowed");
    }
  }
  async #json(path: string, signal?: AbortSignal): Promise<Record<string, unknown> | unknown[]> {
    const response = await this.#fetch(new URL(path, this.#base), {
      redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(this.#timeout), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw new Error(`CDP preflight HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > this.#max) throw new Error("CDP response exceeds size limit");
    return JSON.parse(text) as Record<string, unknown> | unknown[];
  }
}

export class BoundedCdpSession {
  readonly sessionIdentity: string;
  readonly #socket: CdpWebSocketLike;
  readonly #transport: ChatGptLoopbackCdpTransport;
  readonly #timeout: number;
  readonly #maxPending: number;
  readonly #maxFrame: number;
  #id = 0;
  #closed = false;
  readonly #pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      abort?: () => void;
    }
  >();
  private constructor(
    socket: CdpWebSocketLike,
    transport: ChatGptLoopbackCdpTransport,
    options: CdpSessionOptions,
    target: CdpTarget,
  ) {
    this.#socket = socket;
    this.#transport = transport;
    this.#timeout = options.timeoutMs ?? 5_000;
    this.#maxPending = options.maxPending ?? 16;
    this.#maxFrame = options.maxFrameBytes ?? 1_000_000;
    this.sessionIdentity = createHash("sha256")
      .update(`${target.id}\0${target.url}\0${randomUUID()}`)
      .digest("hex");
    socket.addEventListener("message", (e) => this.#message(e.data));
    socket.addEventListener("close", () => this.#failAll(new Error("CDP_SESSION_CLOSED")));
    socket.addEventListener("error", () => this.#failAll(new Error("CDP_SESSION_ERROR")));
  }
  static async connect(
    transport: ChatGptLoopbackCdpTransport,
    options: CdpSessionOptions,
    signal?: AbortSignal,
  ): Promise<BoundedCdpSession> {
    const { target } = await transport.preflight(signal, options.targetId);
    const socket = options.factory(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close(1000, "open-timeout");
        reject(new Error("CDP websocket open timeout"));
      }, options.timeoutMs ?? 5_000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          socket.close(1000, "open-failed");
          reject(new Error("CDP websocket open failed"));
        },
        { once: true },
      );
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          socket.close(1000, "cancelled");
          reject(new Error("CDP websocket open cancelled"));
        },
        { once: true },
      );
    });
    return new BoundedCdpSession(socket, transport, options, target);
  }
  command(method: string, params: unknown = {}, signal?: AbortSignal): Promise<unknown> {
    this.#transport.assertAllowedCommand(method, params);
    if (this.#closed) return Promise.reject(new Error("CDP session closed"));
    if (this.#pending.size >= this.#maxPending)
      return Promise.reject(new Error("CDP pending limit exceeded"));
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        const error = new Error("CDP command timeout");
        reject(error);
        this.close();
      }, this.#timeout);
      const abort =
        signal === undefined
          ? undefined
          : () => {
              clearTimeout(timer);
              this.#pending.delete(id);
              reject(new Error("CDP command cancelled"));
            };
      if (abort !== undefined) signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, { resolve, reject, timer, ...(abort === undefined ? {} : { abort }) });
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
    if (typeof data !== "string" || Buffer.byteLength(data) > this.#maxFrame) {
      this.close();
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      this.close();
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.close();
      return;
    }
    const message = value as {
      id?: unknown;
      method?: unknown;
      result?: unknown;
      error?: { message?: unknown };
    };
    if (message.id === undefined) {
      if (
        typeof message.method === "string" &&
        (message.method.startsWith("Accessibility.") || message.method.startsWith("DOM."))
      )
        return;
      this.close();
      return;
    }
    if (typeof message.id !== "number" || !Number.isInteger(message.id)) {
      this.close();
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      this.close();
      return;
    }
    if ((message.result === undefined) === (message.error === undefined)) {
      this.close();
      return;
    }
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined)
      pending.reject(
        new Error(
          typeof message.error.message === "string" ? message.error.message : "CDP command failed",
        ),
      );
    else pending.resolve(message.result);
  }
  #failAll(error: Error): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export class CdpChatGptApprovalSurface implements ChatGptApprovalSurface {
  readonly #session: BoundedCdpSession;
  readonly #binding: ChatGptApprovalBinding;
  readonly #resultName: string;
  readonly #requiredAccessibleText: readonly string[];
  readonly #refs = new Map<string, number>();
  #revision = "";
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
  async snapshot(signal?: AbortSignal): Promise<ChatGptApprovalSnapshot> {
    await this.#session.command("Accessibility.enable", {}, signal);
    const result = (await this.#session.command("Accessibility.getFullAXTree", {}, signal)) as {
      nodes?: unknown;
    };
    if (!Array.isArray(result.nodes)) throw new Error("CDP accessibility tree invalid");
    this.#refs.clear();
    const nodes = [] as { ref: string; role: string; name: string }[];
    for (const raw of result.nodes) {
      if (typeof raw !== "object" || raw === null) continue;
      const node = raw as {
        nodeId?: unknown;
        backendDOMNodeId?: unknown;
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
      this.#refs.set(node.nodeId, node.backendDOMNodeId);
      nodes.push({ ref: node.nodeId, role: node.role.value, name: node.name.value });
    }
    this.#revision = createHash("sha256").update(JSON.stringify(nodes)).digest("hex");
    const names = new Set(
      nodes
        .filter((n) => n.role.toLowerCase() === "button")
        .map((n) => n.name.trim().toLocaleLowerCase()),
    );
    const accessibleText = nodes
      .map((node) => node.name)
      .join("\n")
      .toLocaleLowerCase();
    if (
      !this.#requiredAccessibleText.every((marker) =>
        accessibleText.includes(marker.toLocaleLowerCase()),
      )
    )
      throw new Error("CHATGPT_TARGET_BINDING_MISMATCH");
    const connected = !names.has("connect") && !names.has("연결");
    const alwaysAllowed = connected && !names.has("always allow") && !names.has("항상 허용");
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
    const backendNodeId = this.#refs.get(ref);
    if (backendNodeId === undefined) throw new Error("STALE_DOM_NODE");
    const resolved = (await this.#session.command(
      "DOM.resolveNode",
      { backendNodeId },
      signal,
    )) as { object?: { objectId?: unknown } };
    if (typeof resolved.object?.objectId !== "string")
      throw new Error("DOM node resolution failed");
    await this.#session.command(
      "Runtime.callFunctionOn",
      {
        objectId: resolved.object.objectId,
        functionDeclaration: "function(){this.click()}",
        returnByValue: true,
        awaitPromise: false,
      },
      signal,
    );
  }
}
function isAllowedTarget(value: unknown): value is CdpTarget {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.id !== "string" ||
    typeof v.url !== "string" ||
    typeof v.webSocketDebuggerUrl !== "string"
  )
    return false;
  const url = new URL(v.url);
  const ws = new URL(v.webSocketDebuggerUrl);
  return (
    url.protocol === "https:" &&
    url.hostname === "chatgpt.com" &&
    url.port === "" &&
    (ws.protocol === "ws:" || ws.protocol === "wss:") &&
    ["127.0.0.1", "localhost", "[::1]"].includes(ws.hostname)
  );
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
