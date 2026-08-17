import { access, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ResponsesRuntimeExecutor } from "./responses-runtime-executor.js";

export interface BrowserNativeExecutorOptions {
  readonly codexHome?: string;
}

/** Uses the installed first-party browser client inside the privileged Codex Node runtime. */
export class BrowserNativeExecutor {
  readonly #responses: ResponsesRuntimeExecutor;
  readonly #codexHome: string;
  #clientPath: string | undefined;

  constructor(responses: ResponsesRuntimeExecutor, options: BrowserNativeExecutorOptions = {}) {
    this.#responses = responses;
    const userProfile = process.env.USERPROFILE;
    const codexHome = options.codexHome ?? process.env.CODEX_HOME;
    if (codexHome === undefined && userProfile === undefined) {
      throw new Error("CODEX_HOME and USERPROFILE are unavailable");
    }
    this.#codexHome = codexHome ?? join(userProfile as string, ".codex");
  }

  async call(argumentsValue: unknown): Promise<unknown> {
    if (!isObject(argumentsValue) || typeof argumentsValue.code !== "string") {
      throw new Error("codex.browser.exec requires a JavaScript code string");
    }
    const clientPath = await this.#locateClient();
    const bootstrap = [
      "if (globalThis.agent?.browsers == null) {",
      `  const { setupBrowserRuntime } = await import(${JSON.stringify(pathToFileURL(clientPath).href)});`,
      "  globalThis.agent = await setupBrowserRuntime();",
      "}",
      argumentsValue.code,
    ].join("\n");
    return this.#responses.callMcp("node_repl", "js", {
      code: bootstrap,
      ...(typeof argumentsValue.timeout_ms === "number"
        ? { timeout_ms: argumentsValue.timeout_ms }
        : {}),
      ...(typeof argumentsValue.title === "string" ? { title: argumentsValue.title } : {}),
    });
  }

  async #locateClient(): Promise<string> {
    if (this.#clientPath !== undefined) {
      return this.#clientPath;
    }
    const bundledRoot = join(this.#codexHome, "plugins", "cache", "openai-bundled");
    const candidates: Array<{ path: string; modifiedAt: number }> = [];
    for (const plugin of ["browser", "chrome", "chrome-internal", "chrome-dev"]) {
      const pluginRoot = join(bundledRoot, plugin);
      let versions: string[];
      try {
        versions = (await readdir(pluginRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const version of versions) {
        const candidate = join(pluginRoot, version, "scripts", "browser-client.mjs");
        try {
          await access(candidate);
          candidates.push({ path: candidate, modifiedAt: (await stat(candidate)).mtimeMs });
        } catch {
          // Ignore incomplete plugin versions.
        }
      }
    }
    candidates.sort(
      (left, right) =>
        right.modifiedAt - left.modifiedAt || right.path.localeCompare(left.path, "en"),
    );
    const selected = candidates[0]?.path;
    if (selected === undefined) {
      throw new Error("Installed Codex Browser plugin is missing scripts/browser-client.mjs");
    }
    this.#clientPath = selected;
    return selected;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
