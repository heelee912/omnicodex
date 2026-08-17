import { randomUUID } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  spawnHidden,
  terminateOwnedHiddenChild,
} from "../infrastructure/windows/hidden-child-process.js";
import type { ResponsesRuntimeExecutor } from "./responses-runtime-executor.js";

export type ComputerUseMethod =
  | "list_apps"
  | "list_windows"
  | "get_window"
  | "launch_app"
  | "get_window_state"
  | "click"
  | "press_key"
  | "type_text"
  | "scroll"
  | "set_value"
  | "drag"
  | "perform_secondary_action"
  | "activate_window";

export interface ComputerUseNativeExecutorOptions {
  readonly skyEntryPath?: string;
  readonly programFiles?: string;
  readonly packageRoots?: () => Promise<readonly string[]>;
}

/** Executes the installed first-party @oai/sky API without a model turn. */
export class ComputerUseNativeExecutor {
  readonly #responses: ResponsesRuntimeExecutor;
  readonly #options: ComputerUseNativeExecutorOptions;
  #skyEntryPath: string | undefined;

  constructor(responses: ResponsesRuntimeExecutor, options: ComputerUseNativeExecutorOptions = {}) {
    this.#responses = responses;
    this.#options = options;
  }

  async call(method: ComputerUseMethod, argumentsValue: unknown): Promise<unknown> {
    if (!computerUseMethods.has(method)) throw new Error(`Unknown Computer Use method: ${method}`);
    const args = isObject(argumentsValue) ? argumentsValue : {};
    await this.#locateSkyEntry();
    const marker = `OMNICODEX_SKY_${randomUUID()}:`;
    const noInput = method === "list_apps" || method === "list_windows";
    const code = [
      "try {",
      '  const { sky: __omniSky } = await import("@oai/sky");',
      `  const __omniInput = ${jsonLiteral(args)};`,
      `  const __omniResult = await __omniSky[${JSON.stringify(method)}](${noInput ? "" : "__omniInput"});`,
      `  console.log(${JSON.stringify(marker)} + JSON.stringify({ ok: true, value: __omniResult ?? null }));`,
      "} catch (__omniError) {",
      "  const __omniMessage = String(__omniError?.message ?? __omniError).slice(0, 2000);",
      "  const __omniName = String(__omniError?.name ?? 'Error').slice(0, 100);",
      "  const __omniCode = typeof __omniError?.code === 'string' ? __omniError.code.slice(0, 100) : undefined;",
      `  console.log(${JSON.stringify(marker)} + JSON.stringify({ ok: false, error: { name: __omniName, message: __omniMessage, code: __omniCode } }));`,
      "}",
    ].join("\n");
    const result = await this.#responses.callMcp("node_repl", "js", {
      code,
      timeout_ms: 120_000,
      title: `Computer Use: ${method}`,
    });
    return parseMarker(result, marker);
  }

  async #locateSkyEntry(): Promise<string> {
    if (this.#skyEntryPath !== undefined) return this.#skyEntryPath;
    if (this.#options.skyEntryPath !== undefined) {
      const explicit = resolve(this.#options.skyEntryPath);
      await access(explicit);
      this.#skyEntryPath = explicit;
      return explicit;
    }
    const programFiles = resolve(
      this.#options.programFiles ?? process.env.ProgramFiles ?? "C:\\Program Files",
    );
    const windowsApps = join(programFiles, "WindowsApps");
    const registeredRoots = await (this.#options.packageRoots ?? registeredCodexPackageRoots)();
    const packageRoots = registeredRoots
      .map((root) => resolve(root))
      .filter((root) => isWithin(root, windowsApps) && rootName(root).startsWith("OpenAI.Codex_"));
    if (packageRoots.length === 0) {
      try {
        packageRoots.push(
          ...(await readdir(windowsApps, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && entry.name.startsWith("OpenAI.Codex_"))
            .map((entry) => join(windowsApps, entry.name)),
        );
      } catch {
        // Non-elevated processes normally cannot enumerate WindowsApps. The
        // registered package root above is the intended discovery path.
      }
    }
    packageRoots.sort((left, right) => right.localeCompare(left, "en"));
    for (const packageRoot of packageRoots) {
      const candidate = join(
        packageRoot,
        "app",
        "resources",
        "cua_node",
        "bin",
        "node_modules",
        "@oai",
        "sky",
        "dist",
        "project",
        "cua",
        "sky_js",
        "src",
        "index.js",
      );
      try {
        await access(candidate);
        this.#skyEntryPath = candidate;
        return candidate;
      } catch {
        // Try the next installed package without modifying any package files.
      }
    }
    throw new Error("Installed Codex Computer Use runtime @oai/sky was not found");
  }
}

async function registeredCodexPackageRoots(): Promise<readonly string[]> {
  if (process.platform !== "win32") return [];
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const regExecutable = join(systemRoot, "System32", "reg.exe");
  const registryKey =
    "HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages";
  const output = await collectHiddenOutput(regExecutable, [
    "query",
    registryKey,
    "/s",
    "/f",
    "OpenAI.Codex_",
  ]).catch(() => "");
  return [...output.matchAll(/^\s*PackageRootFolder\s+REG_[A-Z_]+\s+(.+)$/gim)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => value !== undefined && value.length > 0);
}

function collectHiddenOutput(executable: string, args: readonly string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawnHidden(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errorOutput = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolveOutput(output);
      else reject(error);
    };
    const timer = setTimeout(() => {
      terminateOwnedHiddenChild(child);
      finish(new Error("Codex package registry lookup timed out"));
    }, 10_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 1_000_000) {
        terminateOwnedHiddenChild(child);
        finish(new Error("Codex package registry output exceeded the safety limit"));
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      errorOutput = `${errorOutput}${chunk}`.slice(-4_096);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) =>
      code === 0
        ? finish()
        : finish(new Error(`Codex package registry lookup failed (${code}): ${errorOutput}`)),
    );
  });
}

function isWithin(candidate: string, parent: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path.length > 0 && !path.startsWith("..") && !isAbsolute(path);
}

function rootName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

export const computerUseMethods: ReadonlySet<ComputerUseMethod> = new Set([
  "list_apps",
  "list_windows",
  "get_window",
  "launch_app",
  "get_window_state",
  "click",
  "press_key",
  "type_text",
  "scroll",
  "set_value",
  "drag",
  "perform_secondary_action",
  "activate_window",
]);

function parseMarker(value: unknown, marker: string): unknown {
  for (const text of stringsIn(value)) {
    const index = text.indexOf(marker);
    if (index < 0) continue;
    const encoded = text.slice(index + marker.length).trim();
    let envelope: unknown;
    try {
      envelope = JSON.parse(encoded);
    } catch {
      throw new Error("Computer Use returned a truncated or invalid structured result");
    }
    if (!isObject(envelope) || typeof envelope.ok !== "boolean") {
      throw new Error("Computer Use returned an invalid result envelope");
    }
    if (envelope.ok) return envelope.value;
    const error = isObject(envelope.error) ? envelope.error : {};
    const name = typeof error.name === "string" ? error.name : "Error";
    const message = typeof error.message === "string" ? error.message : "unknown runtime error";
    const code = typeof error.code === "string" ? ` [${error.code}]` : "";
    throw new Error(`Computer Use ${name}${code}: ${message}`);
  }
  throw new Error("Computer Use returned no correlated structured result");
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (isObject(value)) return Object.values(value).flatMap(stringsIn);
  return [];
}

function jsonLiteral(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Computer Use arguments are not JSON-serializable");
  return serialized;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
