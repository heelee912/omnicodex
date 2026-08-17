import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface WorkspaceDependencyPaths {
  readonly bundleVersion: string;
  readonly runtimeRoot: string;
  readonly manifestPath: string;
  readonly gitExecutable: string;
  readonly nodeExecutable: string;
  readonly nodePackages: string;
  readonly pnpmExecutable: string;
  readonly pythonExecutable: string;
  readonly pythonPackages: string;
  readonly overrideBinaries: string;
  readonly fallbackBinaries: string;
}

export interface WorkspaceDependencyLocatorOptions {
  readonly runtimeRoot?: string;
}

/** Locates the desktop app's current workspace bundle without changing it. */
export class WorkspaceDependencyLocator {
  readonly #runtimeRoot: string;

  constructor(options: WorkspaceDependencyLocatorOptions = {}) {
    this.#runtimeRoot = resolve(
      options.runtimeRoot ?? join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime"),
    );
  }

  async locate(): Promise<WorkspaceDependencyPaths> {
    const dependencies = join(this.#runtimeRoot, "dependencies");
    const manifestPath = join(this.#runtimeRoot, "runtime.json");
    const manifest = parseManifest(JSON.parse(await readFile(manifestPath, "utf8")));
    const result: WorkspaceDependencyPaths = {
      bundleVersion: manifest.bundleVersion,
      runtimeRoot: this.#runtimeRoot,
      manifestPath,
      gitExecutable: join(dependencies, "native", "git", "cmd", "git.exe"),
      nodeExecutable: join(dependencies, "node", "bin", "node.exe"),
      nodePackages: join(dependencies, "node", "node_modules"),
      pnpmExecutable: join(dependencies, "bin", "fallback", "pnpm.cmd"),
      pythonExecutable: join(dependencies, "python", "python.exe"),
      pythonPackages: join(dependencies, "python"),
      overrideBinaries: join(dependencies, "bin", "override"),
      fallbackBinaries: join(dependencies, "bin", "fallback"),
    };
    await Promise.all(
      Object.entries(result).flatMap(([key, path]) =>
        key === "bundleVersion" ? [] : [access(path)],
      ),
    );
    return result;
  }
}

function parseManifest(value: unknown): { readonly bundleVersion: string } {
  if (
    !isObject(value) ||
    typeof value.bundleVersion !== "string" ||
    value.bundleVersion.length === 0
  ) {
    throw new Error("Installed Codex workspace runtime manifest is invalid");
  }
  return { bundleVersion: value.bundleVersion };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
