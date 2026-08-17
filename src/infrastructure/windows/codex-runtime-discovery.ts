import type { Dirent, Stats } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { delimiter, join, normalize, resolve } from "node:path";
import type {
  RuntimeCandidate,
  RuntimeCandidateSource,
  RuntimeDiscoveryReport,
} from "../../domain/runtime.js";

export interface RuntimeDiscoveryOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  /** Optional explicit path. It is intentionally considered last. */
  readonly explicitPath?: string;
  readonly readProductVersion?: (executablePath: string) => Promise<string | undefined>;
  readonly fileSystem?: Partial<RuntimeDiscoveryFileSystem>;
}

export interface RuntimeDiscoveryFileSystem {
  readonly access: typeof access;
  readonly readdir: typeof readdir;
  readonly realpath: typeof realpath;
  readonly stat: typeof stat;
}

const defaultFileSystem: RuntimeDiscoveryFileSystem = {
  access,
  readdir,
  realpath,
  stat,
};

/**
 * Finds the installed Codex executable without starting it.
 *
 * The order is a contract: the app-managed installation wins over Windows
 * app shims/PATH, and an explicitly configured path is a last-resort escape
 * hatch. Every returned candidate is canonicalized and de-duplicated.
 */
export class CodexRuntimeDiscovery {
  readonly #platform: NodeJS.Platform;
  readonly #env: NodeJS.ProcessEnv;
  readonly #explicitPath: string | undefined;
  readonly #readProductVersion: (executablePath: string) => Promise<string | undefined>;
  readonly #fs: RuntimeDiscoveryFileSystem;

  constructor(options: RuntimeDiscoveryOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#env = options.env ?? process.env;
    this.#explicitPath = options.explicitPath;
    this.#readProductVersion = options.readProductVersion ?? (async () => undefined);
    this.#fs = { ...defaultFileSystem, ...options.fileSystem };
  }

  async discover(): Promise<RuntimeDiscoveryReport> {
    const warnings: string[] = [];
    const candidates: RuntimeCandidate[] = [];
    const seen = new Set<string>();

    const add = async (executablePath: string, source: RuntimeCandidateSource): Promise<void> => {
      const candidate = await this.#candidate(executablePath, source);
      if (candidate === undefined) {
        return;
      }
      const key = normalize(candidate.canonicalPath).toLowerCase();
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      candidates.push(candidate);
    };

    const localAppData = this.#env.LOCALAPPDATA;
    if (localAppData !== undefined && localAppData.length > 0) {
      const managedRoot = join(localAppData, "OpenAI", "Codex", "bin");
      const managed = await this.#managedExecutables(managedRoot, warnings);
      const managedCandidates: RuntimeCandidate[] = [];
      for (const executablePath of managed) {
        const candidate = await this.#candidate(executablePath, "managed_install");
        if (candidate !== undefined) {
          managedCandidates.push(candidate);
        }
      }
      managedCandidates.sort(compareManagedCandidates);
      for (const candidate of managedCandidates) {
        const key = normalize(candidate.canonicalPath).toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push(candidate);
        }
      }
    } else {
      warnings.push("LOCALAPPDATA is unavailable; managed Codex installation was not scanned");
    }

    const windowsApps = this.#windowsAppsPath();
    if (windowsApps !== undefined) {
      await add(windowsApps, "windows_apps");
    }

    for (const pathEntry of this.#env.PATH?.split(delimiter) ?? []) {
      if (pathEntry.trim().length === 0) {
        continue;
      }
      await add(join(pathEntry, this.#platform === "win32" ? "codex.exe" : "codex"), "path");
    }

    if (this.#explicitPath !== undefined && this.#explicitPath.trim().length > 0) {
      await add(this.#explicitPath, "explicit");
    }

    if (candidates.length === 0) {
      warnings.push("No installed Codex executable was found");
    }

    return {
      platform: this.#platform,
      candidates,
      warnings,
    };
  }

  async #managedExecutables(root: string, warnings: string[]): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await this.#fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        warnings.push(
          `Managed Codex installation could not be scanned (${getErrorCode(error) ?? "unknown"})`,
        );
      }
      return [];
    }

    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, this.#platform === "win32" ? "codex.exe" : "codex"));
  }

  #windowsAppsPath(): string | undefined {
    if (this.#platform !== "win32") {
      return undefined;
    }
    const localAppData = this.#env.LOCALAPPDATA;
    if (localAppData === undefined || localAppData.length === 0) {
      return undefined;
    }
    return join(localAppData, "Microsoft", "WindowsApps", "codex.exe");
  }

  async #candidate(
    executablePath: string,
    source: RuntimeCandidateSource,
  ): Promise<RuntimeCandidate | undefined> {
    const requestedPath = resolve(executablePath);
    let metadata: Stats;
    try {
      metadata = await this.#fs.stat(requestedPath);
      await this.#fs.access(requestedPath);
    } catch {
      return undefined;
    }
    if (!metadata.isFile()) {
      return undefined;
    }

    let canonicalPath = requestedPath;
    try {
      canonicalPath = await this.#fs.realpath(requestedPath);
    } catch {
      // The file was readable above; retaining the normalized path is safer
      // than dropping a usable candidate when a filesystem cannot realpath it.
    }
    const productVersion = await this.#readProductVersion(requestedPath);
    return {
      executablePath: requestedPath,
      canonicalPath,
      source,
      ...(productVersion === undefined ? {} : { productVersion }),
      modifiedAtUnixMs: metadata.mtimeMs,
    };
  }
}

function compareManagedCandidates(left: RuntimeCandidate, right: RuntimeCandidate): number {
  const version = compareVersions(left.productVersion, right.productVersion);
  if (version !== 0) {
    return version;
  }
  const modified = (right.modifiedAtUnixMs ?? -1) - (left.modifiedAtUnixMs ?? -1);
  if (modified !== 0) {
    return modified;
  }
  return left.canonicalPath.localeCompare(right.canonicalPath, "en", { sensitivity: "base" });
}

function compareVersions(left: string | undefined, right: string | undefined): number {
  if (left === undefined && right === undefined) {
    return 0;
  }
  if (left === undefined) {
    return 1;
  }
  if (right === undefined) {
    return -1;
  }
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (leftParts !== undefined && rightParts !== undefined) {
    for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
      const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
      if (difference !== 0) {
        return difference;
      }
    }
    return 0;
  }
  return right.localeCompare(left, "en", { numeric: true, sensitivity: "base" });
}

function parseVersion(value: string): number[] | undefined {
  const match = value.match(/\d+(?:\.\d+)+/);
  return match?.[0].split(".").map((part) => Number(part));
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
