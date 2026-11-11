import { randomUUID } from "node:crypto";
import { normalizeChatGptConversationUrl } from "../chatgpt/chatgpt-conversation-route.js";
import type { DesktopChatRendererEvaluate } from "./desktop-chat-api-reader.js";

export interface DesktopNativePreparedMessage {
  readonly operationId: string;
  readonly conversationUrl: string;
  readonly accountSourceId: string;
  readonly clientUserMessageId: string;
  readonly prompt: string;
  readonly nativeMessages: Record<string, unknown>;
}

export interface DesktopNativeSendContext {
  readonly evaluate: DesktopChatRendererEvaluate;
  readonly readAccountSourceId: (signal: AbortSignal) => Promise<string>;
}

export async function sendDesktopChatNativeMessage(
  input: {
    readonly operationId: string;
    readonly conversationUrl: string;
    readonly accountSourceId: string;
    readonly prompt: string;
  },
  context: DesktopNativeSendContext,
  signal: AbortSignal,
  beforeDispatch?: () => Promise<void>,
): Promise<{
  readonly threadId: string;
  readonly clientUserMessageId: string;
  readonly accepted: true;
}> {
  const prepared = await prepareDesktopChatNativeSend(input, context, signal);
  await beforeDispatch?.();
  signal.throwIfAborted();
  const result = await dispatchDesktopChatNativeSend(prepared, context, signal);
  if (!result.accepted) throw new Error("DESKTOP_NATIVE_SEND_REJECTED");
  return { ...result, accepted: true };
}

/** The renderer creates the ordinary native message; this function never invents its ID. */
export async function prepareDesktopChatNativeSend(
  input: {
    readonly operationId: string;
    readonly conversationUrl: string;
    readonly accountSourceId: string;
    readonly prompt: string;
  },
  context: DesktopNativeSendContext,
  signal: AbortSignal,
): Promise<DesktopNativePreparedMessage> {
  const url = normalizeChatGptConversationUrl(input.conversationUrl);
  if (!url || !input.operationId || !input.prompt.trim())
    throw new Error("DESKTOP_NATIVE_SEND_INPUT_INVALID");
  await verifyAccount(input.accountSourceId, context, signal);
  const result = await evaluateNative(
    {
      operation: "prepare",
      conversationId: url.slice("https://chatgpt.com/c/".length),
      prompt: input.prompt,
    },
    context,
    signal,
  );
  await verifyAccount(input.accountSourceId, context, signal);
  const nativeMessages = record(result);
  const message = record(nativeMessages?.message);
  if (
    !nativeMessages ||
    record(message?.author)?.role !== "user" ||
    typeof message?.id !== "string" ||
    !message.id
  )
    throw new Error("DESKTOP_NATIVE_SEND_MESSAGE_INVALID");
  return { ...input, conversationUrl: url, clientUserMessageId: message.id, nativeMessages };
}

/** Call only after the exact prepared object and dispatch claim have been durably stored. */
export async function dispatchDesktopChatNativeSend(
  prepared: DesktopNativePreparedMessage,
  context: DesktopNativeSendContext,
  signal: AbortSignal,
): Promise<{
  readonly threadId: string;
  readonly clientUserMessageId: string;
  readonly accepted: boolean;
}> {
  const url = normalizeChatGptConversationUrl(prepared.conversationUrl);
  if (!url || record(prepared.nativeMessages.message)?.id !== prepared.clientUserMessageId)
    throw new Error("DESKTOP_NATIVE_SEND_MESSAGE_INVALID");
  try {
    await verifyAccount(prepared.accountSourceId, context, signal);
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      nativeDispatchNotStarted: true,
    });
  }
  const threadId = url.slice("https://chatgpt.com/c/".length);
  const accepted = await evaluateNative(
    {
      operation: "dispatch",
      conversationId: threadId,
      prompt: prepared.prompt,
      nativeMessages: prepared.nativeMessages,
    },
    context,
    signal,
  );
  await verifyAccount(prepared.accountSourceId, context, signal);
  if (typeof accepted !== "boolean") throw new Error("DESKTOP_NATIVE_SEND_RESPONSE_INVALID");
  return { threadId, clientUserMessageId: prepared.clientUserMessageId, accepted };
}

async function verifyAccount(
  expected: string,
  context: DesktopNativeSendContext,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if ((await context.readAccountSourceId(signal)) !== expected)
    throw new Error("DESKTOP_CHAT_ACCOUNT_CHANGED");
  signal.throwIfAborted();
}

async function evaluateNative(
  input: Record<string, unknown>,
  context: DesktopNativeSendContext,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted)
    throw Object.assign(
      signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)),
      { nativeDispatchNotStarted: true },
    );
  const attemptId = randomUUID();
  let cancellation: Promise<unknown> | undefined;
  const cancel = () => {
    cancellation ??= context.evaluate(
      nativeSendLifecycleExpression(attemptId, "cancel"),
      new AbortController().signal,
    );
    void cancellation.catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) {
      cancel();
      signal.throwIfAborted();
    }
    const result = record(
      await context.evaluate(
        `(${DESKTOP_NATIVE_SEND_SOURCE})(${JSON.stringify({ ...input, attemptId })})`,
        signal,
      ),
    );
    signal.throwIfAborted();
    if (result?.ok === true) return result.value;
    const error = record(result?.error);
    throw Object.assign(
      new Error(
        typeof error?.message === "string" ? error.message : "DESKTOP_NATIVE_SEND_RESPONSE_INVALID",
      ),
      error,
    );
  } catch (error) {
    if (signal.aborted) {
      cancel();
      const status = record(await cancellation?.catch(() => undefined));
      const reason =
        signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
      if (status?.started === false) Object.assign(reason, { nativeDispatchNotStarted: true });
      throw reason;
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    await cancellation?.catch(() => undefined);
    await context
      .evaluate(nativeSendLifecycleExpression(attemptId, "release"), new AbortController().signal)
      .catch(() => undefined);
  }
}

function nativeSendLifecycleExpression(attemptId: string, action: "cancel" | "release"): string {
  return `(${DESKTOP_NATIVE_SEND_LIFECYCLE_SOURCE})(${JSON.stringify({ attemptId, action })})`;
}

export const DESKTOP_NATIVE_SEND_LIFECYCLE_SOURCE = `function desktopNativeSendLifecycle(input) {
  const registry = globalThis.__omnicodexDesktopNativeSendOperations ??= new Map();
  let state = registry.get(input.attemptId);
  if (input.action === "cancel") {
    if (!state) { state = { cancelled: true, started: false, settled: false }; registry.set(input.attemptId, state); }
    state.cancelled = true;
    return { started: state.started, settled: state.settled };
  }
  if (state?.settled) registry.delete(input.attemptId);
  else if (state) state.releaseWhenSettled = true;
  return { released: true };
}`;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function isDesktopNativeSendExpression(value: unknown): boolean {
  const lifecyclePrefix = `(${DESKTOP_NATIVE_SEND_LIFECYCLE_SOURCE})(`;
  if (typeof value === "string" && value.startsWith(lifecyclePrefix) && value.endsWith(")")) {
    try {
      const data = record(JSON.parse(value.slice(lifecyclePrefix.length, -1)));
      return (
        !!data &&
        typeof data.attemptId === "string" &&
        /^[a-f0-9-]{36}$/.test(data.attemptId) &&
        (data.action === "cancel" || data.action === "release") &&
        Object.keys(data).length === 2 &&
        value === `${lifecyclePrefix}${JSON.stringify(data)})`
      );
    } catch {
      return false;
    }
  }
  const prefix = `(${DESKTOP_NATIVE_SEND_SOURCE})(`;
  if (typeof value !== "string" || !value.startsWith(prefix) || !value.endsWith(")")) return false;
  try {
    const data = record(JSON.parse(value.slice(prefix.length, -1)));
    if (
      !data ||
      typeof data.conversationId !== "string" ||
      typeof data.prompt !== "string" ||
      !normalizeChatGptConversationUrl(`https://chatgpt.com/c/${data.conversationId}`)
    )
      return false;
    if (data.operation !== "prepare" && data.operation !== "dispatch") return false;
    if (typeof data.attemptId !== "string" || !/^[a-f0-9-]{36}$/.test(data.attemptId)) return false;
    if (data.operation === "dispatch" && !record(record(data.nativeMessages)?.message))
      return false;
    return value === `${prefix}${JSON.stringify(data)})`;
  } catch {
    return false;
  }
}

export const DESKTOP_NATIVE_SEND_SOURCE = String.raw`async function desktopNativeSend(input) {
  const registry = globalThis.__omnicodexDesktopNativeSendOperations ??= new Map();
  let state = registry.get(input.attemptId);
  if (!state) { state = { cancelled: false, started: false, settled: false }; registry.set(input.attemptId, state); }
  const checkCancellation = () => {
    if (state.cancelled) throw Object.assign(new Error("The operation was aborted"), { name: "AbortError", nativeDispatchNotStarted: !state.started });
  };
  try {
    checkCancellation();
    const signature = desktopNativeSend.toString();
    const cached = globalThis.__omnicodexDesktopNativeSender;
    let discovery = cached?.signature === signature ? cached.promise : undefined;
    if (!discovery) {
      discovery = (async () => {
        const candidates = new Set([
          ...Array.from(document.querySelectorAll('script[src],link[rel="modulepreload"][href]'), node => node.src || node.href),
          ...performance.getEntriesByType("resource").map(entry => entry.name),
        ]);
        for (const candidate of candidates) {
          let url;
          try { url = new URL(candidate, location.href); } catch { continue; }
          if (url.protocol !== "app:" || url.host !== location.host || !url.pathname.endsWith(".js")) continue;
          const response = await fetch(url.href);
          if (!response.ok) throw new Error("DESKTOP_NATIVE_SEND_MODULE_HTTP_" + response.status);
          const source = await response.text();
          const start = /async function ([\w$]+)\(([\w$]+),\{conversationId:([\w$]+),messageMetadata:[\w$]+,parentMessageId:[\w$]+,prompt:[\w$]+\}\)\{/.exec(source);
          if (!start) continue;
          const end = source.indexOf("return!0}", start.index);
          if (end < 0) continue;
          const body = source.slice(start.index, end + "return!0}".length);
          const sender = /await ([\w$]+)\([^,]+,\{conversationId:/.exec(body)?.[1];
          const activity = /,([\w$]+)=([\w$]+)\([^)]*\.get\(/.exec(body)?.[2];
          const hints = /systemHints:[\w$]+\.get\(([\w$]+),/.exec(body)?.[1];
          const initializer = /^var ([\w$]+)=/.exec(source.slice(end + "return!0}".length))?.[1];
          const scopeName = /([\w$]+)=[\w$]+\(\x60AppScope\x60\)/.exec(source)?.[1];
          const registryKey = source.search(/queryKey:\[\x60chatgpt-system-hints\x60,\x60plugins\x60\]/);
          const registryName = registryKey < 0 ? undefined : [...source.slice(0, registryKey).matchAll(/([\w$]+)=[\w$]+\([\w$]+,\(\{get:[\w$]+,scope:[\w$]+\}\)=>\{/g)].at(-1)?.[1];
          if (!sender || !activity || !hints || !initializer || !scopeName || !body.includes("finally{")) continue;
          const senderStart = source.indexOf("async function " + sender + "(");
          if (senderStart < 0) continue;
          const factory = /\?\?([\w$]+)\(\{attachments:/.exec(source.slice(senderStart))?.[1];
          if (!factory) continue;
          const exports = source.slice(source.lastIndexOf("export{"));
          const exported = symbol => {
            const escaped = symbol.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
            return new RegExp("(?:[,{])" + escaped + " as ([\\w$]+)(?=[,}])").exec(exports)?.[1];
          };
          const names = [...new Set([...body.matchAll(/\.(?:get|set)\(([\w$]+),/g)].map(match => match[1]).concat(activity, sender))];
          if (!registryName) continue;
          const required = [...names, hints, factory, scopeName, initializer, registryName];
          if (required.some(name => !exported(name))) continue;
          const module = await import(url.href);
          module[exported(initializer)]();
          const bindings = Object.fromEntries(required.map(name => [name, module[exported(name)]]));
          if (typeof bindings[sender] !== "function" || typeof bindings[factory] !== "function") continue;
          return { body, names, bindings, sender, factory, hints, registry: bindings[registryName], scopeToken: bindings[scopeName] };
        }
        throw new Error("DESKTOP_NATIVE_SEND_CONTRACT_NOT_FOUND");
      })();
      globalThis.__omnicodexDesktopNativeSender = { signature, promise: discovery };
      void discovery.catch(() => { if (globalThis.__omnicodexDesktopNativeSender?.promise === discovery) delete globalThis.__omnicodexDesktopNativeSender; });
    }
    const native = await discovery;
    checkCancellation();
    const nodes = new Map();
    const fibers = [];
    for (const element of document.querySelectorAll("*")) {
      for (const key of Object.keys(element)) {
        if (key.startsWith("__reactFiber$") || key.startsWith("__reactContainer$")) fibers.push(element[key]);
      }
    }
    const visited = new Set();
    while (fibers.length) {
      const fiber = fibers.pop();
      if (!fiber || typeof fiber !== "object" || visited.has(fiber)) continue;
      visited.add(fiber);
      fibers.push(fiber.child, fiber.sibling, fiber.return, fiber.current);
      const hooks = new Set();
      for (let hook = fiber.memoizedState; hook && typeof hook === "object" && !hooks.has(hook); hook = hook.next) {
        hooks.add(hook);
        const value = hook.memoizedState?.current;
        if (value?.scope === native.scopeToken && value.chain?.get(native.scopeToken.id) === value.node && typeof value.get === "function" && typeof value.set === "function") nodes.set(value.node, value);
      }
    }
    if (nodes.size !== 1) throw new Error("DESKTOP_NATIVE_SEND_SCOPE_UNAVAILABLE");
    const scope = [...nodes.values()][0];
    if (input.operation === "prepare") {
      checkCancellation();
      state.started = true;
      const value = native.bindings[native.factory]({ prompt: input.prompt, systemHints: scope.get(native.bindings[native.hints], input.conversationId) });
      return { ok: true, value };
    }
    if (input.operation !== "dispatch") throw new Error("DESKTOP_NATIVE_SEND_OPERATION_INVALID");
    await scope.query.getOrFetch(native.registry);
    checkCancellation();
    const invoke = new Function(...native.names, "return (" + native.body + ");")(...native.names.map(name => name === native.sender
      ? (scope, options) => native.bindings[native.sender](scope, { ...options, userCompletionMessages: input.nativeMessages })
      : native.bindings[name]));
    checkCancellation();
    state.started = true;
    return { ok: true, value: await invoke(scope, { conversationId: input.conversationId, prompt: input.prompt }) };
  } catch (error) {
    const details = { message: error instanceof Error ? error.message : String(error) };
    if (!state.started) details.nativeDispatchNotStarted = true;
    for (const key of ["name", "status", "statusCode", "errorCode", "responseStatus", "errorKind", "retryAtMs", "retryAtUnixMs", "detail", "code", "can_retry", "conversation_id", "nativeDispatchNotStarted"]) if (error?.[key] !== undefined) details[key] = error[key];
    // Runtime.evaluate cannot serialize a Headers instance. Preserve only the
    // native status and Retry-After needed by the shared account coordinator.
    const retryAfter = headers => {
      if (typeof headers?.get === "function") return headers.get("retry-after");
      return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
    };
    const header = retryAfter(error?.response?.headers) ?? retryAfter(error?.headers);
    if (typeof header === "string" || typeof header === "number") details.headers = { "retry-after": String(header) };
    if (error?.response?.status !== undefined) details.response = { status: error.response.status };
    return { ok: false, error: details };
  } finally {
    state.settled = true;
    if (state.releaseWhenSettled) registry.delete(input.attemptId);
  }
}`;
