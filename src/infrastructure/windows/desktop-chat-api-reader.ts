import { randomUUID } from "node:crypto";
import { normalizeChatGptConversationUrl } from "../chatgpt/chatgpt-conversation-route.js";

/** Runs Runtime.evaluate with awaitPromise/returnByValue in the existing Desktop renderer. */
export type DesktopChatRendererEvaluate = (
  expression: string,
  signal: AbortSignal,
) => Promise<unknown>;

/** One exact native Chat read. The caller owns the renderer and account verification. */
export async function readDesktopChatConversation(
  input: { readonly conversationUrl: string; readonly evaluate: DesktopChatRendererEvaluate },
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const url = normalizeChatGptConversationUrl(input.conversationUrl);
  if (!url) throw new Error("DESKTOP_CHAT_CONVERSATION_INVALID");
  const id = url.slice("https://chatgpt.com/c/".length);
  const operation = randomUUID();
  let cancellation: Promise<unknown> | undefined;
  const cancel = () => {
    cancellation ??= input.evaluate(
      `(() => { const r = globalThis.__omnicodexDesktopExactReadOperations ??= new Map(); const c = r.get(${JSON.stringify(operation)}); if (c) c.abort(); else r.set(${JSON.stringify(operation)}, { signal: { aborted: true } }); })()`,
      new AbortController().signal,
    );
    // The caller's abort remains primary; cleanup errors must not become unhandled rejections.
    void cancellation.catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) {
      cancel();
      signal.throwIfAborted();
    }
    const result = (await input.evaluate(
      `(${DESKTOP_EXACT_CONVERSATION_READER})(${JSON.stringify(id)}, ${JSON.stringify(operation)})`,
      signal,
    )) as { ok?: boolean; value?: unknown; error?: Record<string, unknown> } | null;
    signal.throwIfAborted();
    if (result?.ok === true) return result.value;
    if (result?.ok === false && typeof result.error?.message === "string") {
      throw Object.assign(new Error(result.error.message), result.error);
    }
    throw new Error("DESKTOP_CHAT_EXACT_READ_RESULT_INVALID");
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** Installed source contract, not a bundle name or minifier alias. */
export const DESKTOP_EXACT_CONVERSATION_READER = String.raw`async function readExactConversation(id, operation) {
  const root = globalThis;
  const operations = root.__omnicodexDesktopExactReadOperations ??= new Map();
  if (operations.get(operation)?.signal.aborted) {
    operations.delete(operation);
    return { ok: false, error: { name: "AbortError", message: "The operation was aborted" } };
  }
  const controller = new AbortController();
  operations.set(operation, controller);
  try {
    let discovery = root.__omnicodexDesktopExactReadService;
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
          if (!response.ok) throw new Error("DESKTOP_CHAT_MODULE_SOURCE_HTTP_" + response.status);
          const source = await response.text();
          const exports = source.slice(source.lastIndexOf("export{"));
          const exported = symbol => {
            const escaped = symbol.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
            return new RegExp("(?:[,{])" + escaped + " as ([\\w$]+)(?=[,}])").exec(exports)?.[1];
          };

          // Current Desktop releases expose the same ChatGPT conversation fetch
          // client used by the native query atom. Discover both symbols from the
          // route and query-key contract so asset hashes and minifier aliases may
          // change without breaking exact reads.
          const requests = [...source.matchAll(/([\w$]+)\.safeGet\((?:\x60|["'])\/conversation\/\{conversation_id\}(?:\x60|["']),\{parameters:\{path:\{conversation_id:([\w$]+)\}\},signal:([\w$]+)\}\)/g)];
          for (const request of requests) {
            const requestIndex = request.index ?? 0;
            const context = source.slice(Math.max(0, requestIndex - 1500), requestIndex + 1500);
            const quote = String.fromCharCode(96);
            if (!context.includes("queryKey:[" + quote + "chatgpt-conversation" + quote + "," + request[2] + "]")) continue;
            const prefix = source.slice(0, requestIndex);
            const initializer = [...prefix.matchAll(/([\w$]+)=[\w$]+\(\(\(\)=>\{/g)].at(-1)?.[1];
            const clientExport = exported(request[1]);
            const initializeExport = initializer && exported(initializer);
            if (!clientExport || !initializeExport) continue;
            const module = await import(url.href);
            if (typeof module[initializeExport] !== "function") continue;
            module[initializeExport]();
            const client = module[clientExport];
            if (typeof client?.safeGet !== "function") continue;
            return {
              get: (conversationId, signal) => client.safeGet("/conversation/{conversation_id}", {
                parameters: {
                  path: { conversation_id: conversationId },
                  query: { include_has_versions: true, num_turns: 1 },
                },
                signal,
              }),
            };
          }
        }
        throw new Error("DESKTOP_CHAT_EXACT_READER_NOT_FOUND");
      })();
      root.__omnicodexDesktopExactReadService = discovery;
      void discovery.catch(() => {
        if (root.__omnicodexDesktopExactReadService === discovery) delete root.__omnicodexDesktopExactReadService;
      });
    }
    const service = await discovery;
    controller.signal.throwIfAborted();
    const value = await service.get(id, controller.signal);
    controller.signal.throwIfAborted();
    return { ok: true, value };
  } catch (error) {
    const details = { message: error instanceof Error ? error.message : String(error) };
    for (const key of ["name", "status", "errorCode", "responseStatus", "errorKind", "retryAtMs", "retryAtUnixMs", "detail", "code", "can_retry", "conversation_id"]) {
      if (error?.[key] !== undefined) details[key] = error[key];
    }
    // Headers instances lose their entries across Runtime.evaluate returnByValue.
    // Preserve the native retry deadline explicitly in a serializable response.
    const retryAfter = headers => {
      if (typeof headers?.get === "function") return headers.get("retry-after");
      const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === "retry-after");
      return entry?.[1];
    };
    const header = retryAfter(error?.response?.headers) ?? retryAfter(error?.headers);
    if (typeof header === "string" || typeof header === "number") {
      details.headers = { "retry-after": String(header) };
    }
    if (error?.response?.status !== undefined) details.response = { status: error.response.status };
    return { ok: false, error: details };
  } finally {
    operations.delete(operation);
  }
}`;
