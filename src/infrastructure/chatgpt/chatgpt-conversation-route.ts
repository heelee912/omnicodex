const CHATGPT_CONVERSATION_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CHATGPT_CONVERSATION_ID = new RegExp(
  `^(?:([a-z][a-z0-9_-]{0,31}):)?(${CHATGPT_CONVERSATION_UUID})$`,
  "iu",
);

/**
 * Normalize the opaque id used by ChatGPT conversation routes.
 *
 * Older conversations use a bare UUID. Newer clients can namespace the same
 * UUID (observed in production as `WEB:<uuid>`). The namespace is part of the
 * identity and must not be discarded or lower-cased when constructing the
 * canonical route.
 */
export function normalizeChatGptConversationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = CHATGPT_CONVERSATION_ID.exec(value.trim());
  if (match === null) return undefined;
  const namespace = match[1];
  const uuid = (match[2] as string).toLowerCase();
  return namespace === undefined ? uuid : `${namespace.toUpperCase()}:${uuid}`;
}

/** Canonicalize one exact chatgpt.com conversation route and drop UI-only query/hash state. */
export function normalizeChatGptConversationUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com") return undefined;
    const path = /^\/(?:g\/[^/]+\/)?c\/([^/]+)\/?$/u.exec(url.pathname);
    if (path === null) return undefined;
    const conversationId = normalizeChatGptConversationId(path[1]);
    const opaqueId = path[1] as string;
    const canonicalId =
      conversationId ??
      (/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/u.test(opaqueId) ? opaqueId : undefined);
    return canonicalId === undefined ? undefined : `https://chatgpt.com/c/${canonicalId}`;
  } catch {
    return undefined;
  }
}
