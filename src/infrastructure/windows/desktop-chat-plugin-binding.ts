import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CONNECTOR_ID = /^asdk_app_[a-z0-9]+$/i;

/** Reads the remote OmniCodex connector bound to the desktop app's current ChatGPT account. */
export async function desktopChatAccountConnectorIds(
  codexHome: string,
  expectedAccountId: string,
): Promise<readonly string[]> {
  if (!expectedAccountId) throw new Error("DESKTOP_CHAT_ACCOUNT_INVALID");
  const raw = await readFile(join(codexHome, ".codex-global-state.json"), "utf8");
  return desktopChatCatalogConnectorIds(JSON.parse(raw), expectedAccountId);
}

export function desktopChatCatalogConnectorIds(
  state: unknown,
  expectedAccountId: string,
): readonly string[] {
  const root = record(state);
  const atoms = record(root?.["electron-persisted-atom-state"]);
  const sidebar = record(atoms?.["mcp-extension-sidebar-catalog"]);
  if (sidebar?.accountId !== expectedAccountId) {
    throw new Error("DESKTOP_CHAT_ACCOUNT_CATALOG_CHANGED");
  }
  if (!Array.isArray(sidebar.catalog)) throw new Error("DESKTOP_CHAT_APP_CATALOG_INVALID");

  const ids = new Set<string>();
  for (const server of sidebar.catalog) {
    const tools = record(server)?.tools;
    if (!Array.isArray(tools)) continue;
    for (const candidate of tools) {
      const tool = record(candidate);
      if (typeof tool?.name !== "string") continue;
      // Chat assigns the registration's display name as its namespace. A
      // renamed registration still exposes the same native OmniCodex tools.
      const nativeName = tool.name.slice(tool.name.indexOf(".") + 1);
      if (
        !tool.name.startsWith("omnicodex.") &&
        !nativeName.startsWith("omnicodex__") &&
        !nativeName.startsWith("codex__omnicodex__")
      )
        continue;
      const connectorId = record(tool._meta)?.connector_id;
      if (typeof connectorId === "string" && CONNECTOR_ID.test(connectorId)) ids.add(connectorId);
    }
  }
  return [...ids].sort();
}

/**
 * Chooses the exact connector already verified when a Goal was bound. Parallel
 * OmniCodex registrations are valid and must not make that existing binding
 * ambiguous. A Goal without recorded provenance still requires a single
 * unambiguous current registration.
 */
export function selectDesktopGoalConnectorId(
  currentConnectorIds: readonly string[],
  boundConnectorId?: string,
): string {
  if (boundConnectorId !== undefined) {
    if (!currentConnectorIds.includes(boundConnectorId))
      throw new Error("DESKTOP_GOAL_CONNECTOR_SELECTION_CHANGED");
    return boundConnectorId;
  }
  if (currentConnectorIds.length !== 1)
    throw new Error("DESKTOP_GOAL_CONNECTOR_SELECTION_UNAVAILABLE");
  return currentConnectorIds[0] as string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
