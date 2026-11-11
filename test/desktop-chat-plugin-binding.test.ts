import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  desktopChatAccountConnectorIds,
  desktopChatCatalogConnectorIds,
  selectDesktopGoalConnectorId,
} from "../src/infrastructure/windows/desktop-chat-plugin-binding.js";

const catalog = (accountId: string, entries: unknown[]) => ({
  "electron-persisted-atom-state": {
    "mcp-extension-sidebar-catalog": { accountId, catalog: entries },
  },
});

describe("desktop Chat account connector binding", () => {
  it("reads a newly registered connector on the next local catalog read", async () => {
    const home = await mkdtemp(join(tmpdir(), "omnicodex-catalog-"));
    const path = join(home, ".codex-global-state.json");
    try {
      await writeFile(path, JSON.stringify(catalog("current", [])));
      expect(await desktopChatAccountConnectorIds(home, "current")).toEqual([]);
      await writeFile(
        path,
        JSON.stringify(
          catalog("current", [
            {
              tools: [
                {
                  name: "new_connection.omnicodex__goal_create",
                  _meta: { connector_id: "asdk_app_new" },
                },
              ],
            },
          ]),
        ),
      );
      expect(await desktopChatAccountConnectorIds(home, "current")).toEqual(["asdk_app_new"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it("uses the current account's remote OmniCodex connector", () => {
    const state = catalog("account-current", [
      {
        tools: [
          {
            name: "omnicodex.codex__app_server__thread_read",
            _meta: { connector_id: "asdk_app_current" },
          },
          {
            name: "another_app.read",
            _meta: { connector_id: "asdk_app_other" },
          },
        ],
      },
    ]);

    expect(desktopChatCatalogConnectorIds(state, "account-current")).toEqual(["asdk_app_current"]);
  });

  it("deduplicates connector ids across the complete tool catalog", () => {
    const state = catalog("account-current", [
      {
        tools: [
          { name: "omnicodex.first", _meta: { connector_id: "asdk_app_current" } },
          { name: "omnicodex.second", _meta: { connector_id: "asdk_app_current" } },
        ],
      },
    ]);

    expect(desktopChatCatalogConnectorIds(state, "account-current")).toEqual(["asdk_app_current"]);
  });

  it("discovers parallel and renamed registrations from their native OmniCodex tools", () => {
    const state = catalog("account-current", [
      {
        tools: [
          { name: "omnicodex.first", _meta: { connector_id: "asdk_app_original" } },
          {
            name: "alternate_connection.omnicodex__goal_create",
            _meta: { connector_id: "asdk_app_new" },
          },
          {
            name: "alternate_connection.codex__omnicodex__read_protected_result",
            _meta: { connector_id: "asdk_app_new" },
          },
          { name: "unrelated.codex_app__list_threads", _meta: { connector_id: "asdk_app_other" } },
        ],
      },
    ]);
    expect(desktopChatCatalogConnectorIds(state, "account-current")).toEqual([
      "asdk_app_new",
      "asdk_app_original",
    ]);
    expect(() => desktopChatCatalogConnectorIds(state, "other-account")).toThrow(
      "DESKTOP_CHAT_ACCOUNT_CATALOG_CHANGED",
    );
  });

  it("rejects a catalog retained from another signed-in account", () => {
    const state = catalog("account-old", [
      {
        tools: [{ name: "omnicodex.read", _meta: { connector_id: "asdk_app_old" } }],
      },
    ]);

    expect(() => desktopChatCatalogConnectorIds(state, "account-current")).toThrow(
      "DESKTOP_CHAT_ACCOUNT_CATALOG_CHANGED",
    );
  });

  it("returns no connector when OmniCodex is absent from the current account", () => {
    const state = catalog("account-current", [
      {
        tools: [{ name: "another_app.read", _meta: { connector_id: "asdk_app_other" } }],
      },
    ]);

    expect(desktopChatCatalogConnectorIds(state, "account-current")).toEqual([]);
  });

  it("keeps a Goal's verified connector when parallel OmniCodex registrations are present", () => {
    expect(
      selectDesktopGoalConnectorId(["asdk_app_new", "asdk_app_original"], "asdk_app_original"),
    ).toBe("asdk_app_original");
    expect(() => selectDesktopGoalConnectorId(["asdk_app_new"], "asdk_app_original")).toThrow(
      "DESKTOP_GOAL_CONNECTOR_SELECTION_CHANGED",
    );
  });

  it("requires one current connector when the Goal has no verified connector", () => {
    expect(selectDesktopGoalConnectorId(["asdk_app_only"])).toBe("asdk_app_only");
    expect(() => selectDesktopGoalConnectorId([])).toThrow(
      "DESKTOP_GOAL_CONNECTOR_SELECTION_UNAVAILABLE",
    );
    expect(() => selectDesktopGoalConnectorId(["asdk_app_one", "asdk_app_two"])).toThrow(
      "DESKTOP_GOAL_CONNECTOR_SELECTION_UNAVAILABLE",
    );
  });
});
