import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppServerRpcClient } from "../../application/native-tool-catalog.js";

type CuaServerSource =
  | { readonly kind: "configured"; readonly server: Record<string, unknown> }
  | { readonly kind: "plugin"; readonly path: string }
  | { readonly kind: "disabled" };

export interface CuaPluginServerReaderOptions {
  readonly codexHome?: string;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
  readonly readText?: (path: string) => Promise<string>;
}

/** Reads the active native Computer Use server without copying its versioned configuration. */
export class CuaPluginServerReader {
  readonly #client: Pick<AppServerRpcClient, "request">;
  readonly #codexHome: string;
  readonly #now: () => number;
  readonly #cacheTtlMs: number;
  readonly #readText: (path: string) => Promise<string>;
  #cached: { readonly source: CuaServerSource; readonly observedAt: number } | undefined;
  #pending: Promise<CuaServerSource> | undefined;

  constructor(
    client: Pick<AppServerRpcClient, "request">,
    options: CuaPluginServerReaderOptions = {},
  ) {
    this.#client = client;
    this.#codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    this.#now = options.now ?? Date.now;
    this.#cacheTtlMs = options.cacheTtlMs ?? 30_000;
    this.#readText = options.readText ?? ((path) => readFile(path, "utf8"));
  }

  async read(workExecutorId: string): Promise<Record<string, unknown> | undefined> {
    let source = await this.#source();
    if (source.kind === "disabled") return undefined;
    let server: Record<string, unknown>;
    if (source.kind === "configured") {
      server = source.server;
    } else {
      try {
        server = await this.#readPluginServer(source.path);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        this.#cached = undefined;
        const previousPath = source.path;
        source = await this.#source();
        if (source.kind === "disabled") return undefined;
        if (source.kind === "plugin" && source.path === previousPath) throw error;
        server =
          source.kind === "configured" ? source.server : await this.#readPluginServer(source.path);
      }
    }
    const environment = server.env;
    if (environment !== undefined && !isRecord(environment)) {
      throw new Error("The Computer Use MCP server has an invalid environment configuration");
    }
    return {
      ...server,
      env: { ...environment, BROWSER_USE_ACCESS_EXECUTOR_ID: workExecutorId },
    };
  }

  async #source(): Promise<CuaServerSource> {
    const result = await this.#client.request<unknown>("config/read", { includeLayers: false });
    if (!isRecord(result) || !isRecord(result.config)) {
      throw new Error("The Desktop MCP server configuration is unavailable");
    }
    const servers = isRecord(result.config.mcp_servers) ? result.config.mcp_servers : {};
    if (servers.cua_repl !== undefined) {
      if (!isRecord(servers.cua_repl))
        throw new Error("Invalid configured Computer Use MCP server");
      return servers.cua_repl.enabled === false
        ? { kind: "disabled" }
        : { kind: "configured", server: servers.cua_repl };
    }
    const plugins = isRecord(result.config.plugins) ? result.config.plugins : {};
    const pluginSettings = plugins["unified-computer-use@openai-bundled"];
    if (isRecord(pluginSettings) && pluginSettings.enabled === false) return { kind: "disabled" };

    if (this.#cached !== undefined && this.#now() - this.#cached.observedAt < this.#cacheTtlMs) {
      return this.#cached.source;
    }
    this.#pending ??= this.#loadSource()
      .then((source) => {
        this.#cached = source.kind === "disabled" ? undefined : { source, observedAt: this.#now() };
        return source;
      })
      .finally(() => {
        this.#pending = undefined;
      });
    return this.#pending;
  }

  async #loadSource(): Promise<CuaServerSource> {
    const plugins = await this.#client.request<unknown>("plugin/list", {});
    if (!isRecord(plugins) || !Array.isArray(plugins.marketplaces)) {
      throw new Error("The Desktop plugin inventory is unavailable");
    }
    const marketplace = plugins.marketplaces.find(
      (entry: unknown) => isRecord(entry) && entry.name === "openai-bundled",
    );
    if (!isRecord(marketplace) || !Array.isArray(marketplace.plugins)) return { kind: "disabled" };
    const plugin = marketplace.plugins.find(
      (entry: unknown) => isRecord(entry) && entry.name === "unified-computer-use",
    );
    if (!isRecord(plugin) || plugin.installed !== true || plugin.enabled !== true) {
      return { kind: "disabled" };
    }
    const version = plugin.localVersion;
    if (typeof version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(version)) {
      throw new Error("The installed Computer Use plugin version is unavailable");
    }
    return {
      kind: "plugin",
      path: join(
        this.#codexHome,
        "plugins",
        "cache",
        "openai-bundled",
        "unified-computer-use",
        version,
        ".mcp.json",
      ),
    };
  }

  async #readPluginServer(path: string): Promise<Record<string, unknown>> {
    const document: unknown = JSON.parse(await this.#readText(path));
    const servers = isRecord(document) && isRecord(document.mcpServers) ? document.mcpServers : {};
    if (!isRecord(servers.cua_repl)) throw new Error("The Computer Use plugin has no MCP server");
    return servers.cua_repl;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
