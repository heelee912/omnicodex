import type { AppServerRpcClient } from "./native-tool-catalog.js";

export const OMNICODEX_BRIDGE_THREAD_TITLE = "[OmniCodex] Bridge";

/** Applies the PRD persistence contract to the installed App Server thread/start method. */
export async function startAppServerThread(
  client: AppServerRpcClient,
  params: Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown> {
  if (Object.hasOwn(params, "path")) {
    throw new Error("Persistent thread path is runtime-owned and cannot be supplied");
  }
  const ephemeral = params.ephemeral === true;
  const title = normalizedPersistentTitle(params.title);
  const runtimeParams: Record<string, unknown> = { ...params, ephemeral };
  delete runtimeParams.title;
  const started = await client.request<unknown>("thread/start", runtimeParams, timeoutMs);
  const threadId = nestedString(started, "thread", "id");
  if (threadId === undefined) throw new Error("App Server did not return a thread id");
  if (ephemeral) {
    const path = nestedValue(started, "thread", "path");
    if (path !== null) throw new Error("Ephemeral thread did not return path: null");
    return { threadId, ephemeral: true, thread: started };
  }
  const named = await client.request("thread/name/set", { threadId, name: title }, timeoutMs);
  return { threadId, ephemeral: false, title, thread: started, named };
}

export function normalizedPersistentTitle(value: unknown): string {
  const fallback = new Date().toISOString();
  const raw = typeof value === "string" && value.trim().length > 0 ? value : fallback;
  const withoutPrefix = raw.trim().replace(/^\[OmniCodex\]\s*/i, "");
  return `[OmniCodex] ${withoutPrefix.replace(/\s+/g, " ").trim().slice(0, 80)}`;
}

function nestedString(value: unknown, objectKey: string, fieldKey: string): string | undefined {
  const nested = nestedValue(value, objectKey, fieldKey);
  return typeof nested === "string" && nested.length > 0 ? nested : undefined;
}

function nestedValue(value: unknown, objectKey: string, fieldKey: string): unknown {
  return isObject(value) && isObject(value[objectKey]) ? value[objectKey][fieldKey] : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
