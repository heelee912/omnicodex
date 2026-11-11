import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  assertRequiredDirectWorkToolCatalog,
  OMNICODEX_REQUIRED_DIRECT_WORK_TOOLS,
} from "../src/cli.js";

function directWorkCatalog(): Tool[] {
  return OMNICODEX_REQUIRED_DIRECT_WORK_TOOLS.map(
    (expected) =>
      ({
        name: expected.name,
        description: `Direct ${expected.nativeName}`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }) as unknown as Tool,
  );
}

describe("CLI full native direct-work catalog acceptance", () => {
  it("requires file, command, the native Node REPL, and every Computer Use action", () => {
    const names = OMNICODEX_REQUIRED_DIRECT_WORK_TOOLS.map(({ name }) => name);
    expect(names).toEqual(
      expect.arrayContaining([
        "codex__app_server__fs_readFile",
        "codex__app_server__fs_writeFile",
        "codex__app_server__command_exec",
        "codex__node_repl__js",
        "codex__computer_use__list_apps",
        "codex__computer_use__list_windows",
        "codex__computer_use__get_window",
        "codex__computer_use__launch_app",
        "codex__computer_use__get_window_state",
        "codex__computer_use__click",
        "codex__computer_use__press_key",
        "codex__computer_use__type_text",
        "codex__computer_use__scroll",
        "codex__computer_use__set_value",
        "codex__computer_use__drag",
        "codex__computer_use__perform_secondary_action",
        "codex__computer_use__activate_window",
      ]),
    );
    expect(names).not.toContain("codex_app__send_message_to_thread");
    expect(() => assertRequiredDirectWorkToolCatalog(directWorkCatalog())).not.toThrow();
  });

  it("rejects a catalog missing any direct work action", () => {
    const catalog = directWorkCatalog();
    for (const { name } of OMNICODEX_REQUIRED_DIRECT_WORK_TOOLS) {
      expect(() =>
        assertRequiredDirectWorkToolCatalog(catalog.filter((tool) => tool.name !== name)),
      ).toThrow(`Installed runtime omitted the direct native work tool ${name}`);
    }
  });

  it("rejects a malformed direct work action schema", () => {
    const catalog = directWorkCatalog();
    const command = catalog.find((tool) => tool.name === "codex__app_server__command_exec") as Tool;
    command.inputSchema = { type: "string" } as unknown as Tool["inputSchema"];

    expect(() => assertRequiredDirectWorkToolCatalog(catalog)).toThrow(
      "Installed runtime omitted the direct native work tool codex__app_server__command_exec",
    );
  });
});
