import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CuaPluginServerReader } from "../src/infrastructure/runtime/cua-plugin-server-reader.js";

function inventory(version: string, enabled = true): unknown {
  return {
    marketplaces: [
      {
        name: "openai-bundled",
        plugins: [
          { name: "unified-computer-use", installed: true, enabled, localVersion: version },
        ],
      },
    ],
  };
}

describe("CuaPluginServerReader", () => {
  it("preserves the installed server and passes the registered executor to each session", async () => {
    let inventoryCalls = 0;
    let reads = 0;
    let now = 0;
    let version = "26.1";
    const paths: string[] = [];
    const reader = new CuaPluginServerReader(
      {
        request: async <T>(method: string): Promise<T> => {
          if (method === "config/read") return { config: { mcp_servers: {} } } as T;
          inventoryCalls += 1;
          return inventory(version) as T;
        },
      },
      {
        codexHome: "test-home",
        now: () => now,
        cacheTtlMs: 30,
        readText: async (path) => {
          paths.push(path);
          reads += 1;
          return JSON.stringify({
            mcpServers: {
              cua_repl: { command: "node", args: ["native.mjs"], env: { PIPE: `pipe-${reads}` } },
            },
          });
        },
      },
    );

    expect(await reader.read("work-a")).toEqual({
      command: "node",
      args: ["native.mjs"],
      env: { PIPE: "pipe-1", BROWSER_USE_ACCESS_EXECUTOR_ID: "work-a" },
    });
    expect((await reader.read("work-b"))?.env).toEqual({
      PIPE: "pipe-2",
      BROWSER_USE_ACCESS_EXECUTOR_ID: "work-b",
    });
    expect(inventoryCalls).toBe(1);
    version = "26.2";
    now = 31;
    await reader.read("work-c");
    expect(inventoryCalls).toBe(2);
    expect(paths[2]).toBe(
      join(
        "test-home",
        "plugins",
        "cache",
        "openai-bundled",
        "unified-computer-use",
        "26.2",
        ".mcp.json",
      ),
    );
  });

  it("honors the configured server and never re-enables a disabled server", async () => {
    let configured: unknown = {
      command: "custom-native",
      env: { KEEP: "original" },
    };
    const methods: string[] = [];
    const reader = new CuaPluginServerReader(
      {
        request: async <T>(method: string): Promise<T> => {
          methods.push(method);
          return { config: { mcp_servers: { cua_repl: configured } } } as T;
        },
      },
      { cacheTtlMs: 0 },
    );

    expect(await reader.read("work-id")).toEqual({
      command: "custom-native",
      env: { KEEP: "original", BROWSER_USE_ACCESS_EXECUTOR_ID: "work-id" },
    });
    configured = { enabled: false };
    expect(await reader.read("work-id")).toBeUndefined();
    expect(methods).toEqual(["config/read", "config/read"]);
  });

  it("does not load a disabled plugin or accept an invalid version path", async () => {
    let enabled = false;
    const reader = new CuaPluginServerReader(
      {
        request: async <T>(method: string): Promise<T> =>
          (method === "config/read"
            ? { config: { mcp_servers: {} } }
            : inventory("../bad", enabled)) as T,
      },
      {
        cacheTtlMs: 0,
        readText: async () => {
          throw new Error("unexpected read");
        },
      },
    );
    expect(await reader.read("work-id")).toBeUndefined();
    enabled = true;
    await expect(reader.read("work-id")).rejects.toThrow("plugin version is unavailable");
  });

  it("finds the updated plugin if the cached version disappears", async () => {
    let inventories = 0;
    const reader = new CuaPluginServerReader(
      {
        request: async <T>(method: string): Promise<T> => {
          if (method === "config/read") return { config: {} } as T;
          inventories += 1;
          return inventory(inventories === 1 ? "old" : "new") as T;
        },
      },
      {
        readText: async (path) => {
          if (path.includes(`${join("old", ".mcp.json")}`)) {
            throw Object.assign(new Error("old plugin removed"), { code: "ENOENT" });
          }
          return JSON.stringify({ mcpServers: { cua_repl: { command: "new-cua" } } });
        },
      },
    );
    expect(await reader.read("work-id")).toEqual({
      command: "new-cua",
      env: { BROWSER_USE_ACCESS_EXECUTOR_ID: "work-id" },
    });
    expect(inventories).toBe(2);
  });

  it("honors plugin setting changes without waiting for the inventory cache", async () => {
    let enabled = true;
    let inventories = 0;
    const reader = new CuaPluginServerReader(
      {
        request: async <T>(method: string): Promise<T> => {
          if (method === "config/read") {
            return {
              config: { plugins: { "unified-computer-use@openai-bundled": { enabled } } },
            } as T;
          }
          inventories += 1;
          return inventory("26.1") as T;
        },
      },
      { readText: async () => JSON.stringify({ mcpServers: { cua_repl: { command: "cua" } } }) },
    );
    expect(await reader.read("work-id")).toBeDefined();
    enabled = false;
    expect(await reader.read("work-id")).toBeUndefined();
    enabled = true;
    expect(await reader.read("work-id")).toBeDefined();
    expect(inventories).toBe(1);
  });
});
