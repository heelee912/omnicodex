import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { createReadStream } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, normalize, relative, resolve } from "node:path";
import type {
  RuntimeCandidate,
  RuntimeCandidateSource,
  RuntimeDiscoveryReport,
} from "../../domain/runtime.js";
import { omniCodexDataDirectory, windowsLocalAppData } from "../config/omnicodex-config-store.js";

export interface RuntimeDiscoveryOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly env?: NodeJS.ProcessEnv;
  /** Current account's Windows known folder; queried only when LOCALAPPDATA is absent. */
  readonly resolveLocalAppData?: () => string;
  /** Optional explicit path. It is intentionally considered last. */
  readonly explicitPath?: string;
  /** Live Desktop engine path, read again on each discovery after an app update. */
  readonly readDesktopExecutablePath?: () => Promise<string | undefined>;
  readonly readProductVersion?: (executablePath: string) => Promise<string | undefined>;
  readonly readBuildSha256?: (executablePath: string) => Promise<string | undefined>;
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
  readonly #arch: NodeJS.Architecture;
  readonly #env: NodeJS.ProcessEnv;
  readonly #resolveLocalAppData: () => string;
  readonly #explicitPath: string | undefined;
  readonly #readDesktopExecutablePath: (() => Promise<string | undefined>) | undefined;
  readonly #readProductVersion: (executablePath: string) => Promise<string | undefined>;
  readonly #readBuildSha256: (executablePath: string) => Promise<string | undefined>;
  readonly #fs: RuntimeDiscoveryFileSystem;

  constructor(options: RuntimeDiscoveryOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#arch = options.arch ?? process.arch;
    this.#env = options.env ?? process.env;
    this.#resolveLocalAppData = options.resolveLocalAppData ?? windowsLocalAppData;
    this.#explicitPath = options.explicitPath;
    this.#readDesktopExecutablePath = options.readDesktopExecutablePath;
    this.#readProductVersion = options.readProductVersion ?? (async () => undefined);
    this.#readBuildSha256 = options.readBuildSha256 ?? hashFileSha256;
    this.#fs = { ...defaultFileSystem, ...options.fileSystem };
  }

  async discover(desktopExecutablePath?: string): Promise<RuntimeDiscoveryReport> {
    const warnings: string[] = [];
    const candidates: RuntimeCandidate[] = [];
    const seenPaths = new Set<string>();
    const seenBuilds = new Set<string>();
    const buildHashes = new Map<string, Promise<string | undefined>>();

    const append = (candidate: RuntimeCandidate): void => {
      const pathKey = candidatePathKey(candidate);
      if (seenPaths.has(pathKey) || seenBuilds.has(candidate.buildSha256)) {
        return;
      }
      seenPaths.add(pathKey);
      seenBuilds.add(candidate.buildSha256);
      candidates.push(candidate);
    };

    const add = async (executablePath: string, source: RuntimeCandidateSource): Promise<void> => {
      const candidate = await this.#candidate(executablePath, source, buildHashes);
      if (candidate === undefined) {
        return;
      }
      append(candidate);
    };

    let localAppData = this.#env.LOCALAPPDATA;
    if ((localAppData === undefined || localAppData.length === 0) && this.#platform === "win32") {
      try {
        localAppData = this.#resolveLocalAppData();
      } catch (error) {
        warnings.push(
          `Windows LocalApplicationData lookup failed (${getErrorCode(error) ?? "unknown"})`,
        );
      }
    }
    if (
      this.#platform === "win32" &&
      (desktopExecutablePath !== undefined || this.#readDesktopExecutablePath !== undefined)
    ) {
      try {
        const currentDesktopPath =
          desktopExecutablePath ?? (await this.#readDesktopExecutablePath?.());
        if (currentDesktopPath !== undefined) {
          await add(currentDesktopPath, "managed_install");
        }
      } catch (error) {
        warnings.push(`Live Desktop engine lookup failed (${getErrorCode(error) ?? "unknown"})`);
      }
    }
    if (localAppData !== undefined && localAppData.length > 0) {
      const desktopEngine = desktopEngineOverride(
        this.#env.CODEX_CLI_PATH,
        omniCodexDataDirectory(this.#env, () => localAppData),
      );
      if (desktopEngine !== undefined) {
        await add(desktopEngine, "managed_install");
      }
      const managedRoot = join(localAppData, "OpenAI", "Codex", "bin");
      const managed = await this.#managedExecutables(managedRoot, warnings);
      const managedCandidates: RuntimeCandidate[] = [];
      for (const executablePath of managed) {
        const candidate = await this.#candidate(executablePath, "managed_install", buildHashes);
        if (candidate !== undefined) {
          managedCandidates.push(candidate);
        }
      }
      managedCandidates.sort(compareManagedCandidates);
      for (const candidate of managedCandidates) {
        append(candidate);
      }
    } else {
      warnings.push("LOCALAPPDATA is unavailable; managed Codex installation was not scanned");
    }

    const windowsApps = this.#windowsAppsPath(localAppData);
    if (windowsApps !== undefined) {
      await add(windowsApps, "windows_apps");
    }

    for (const pathEntry of this.#env.PATH?.split(delimiter) ?? []) {
      if (pathEntry.trim().length === 0) {
        continue;
      }
      await add(join(pathEntry, this.#platform === "win32" ? "codex.exe" : "codex"), "path");
      const npmRuntime = this.#windowsNpmRuntimePath(pathEntry);
      if (npmRuntime !== undefined) await add(npmRuntime, "path");
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

  #windowsAppsPath(localAppData: string | undefined): string | undefined {
    if (this.#platform !== "win32") {
      return undefined;
    }
    if (localAppData === undefined || localAppData.length === 0) {
      return undefined;
    }
    return join(localAppData, "Microsoft", "WindowsApps", "codex.exe");
  }

  #windowsNpmRuntimePath(pathEntry: string): string | undefined {
    if (this.#platform !== "win32") return undefined;
    const platformPackage =
      this.#arch === "x64"
        ? { packageName: "codex-win32-x64", target: "x86_64-pc-windows-msvc" }
        : this.#arch === "arm64"
          ? { packageName: "codex-win32-arm64", target: "aarch64-pc-windows-msvc" }
          : undefined;
    if (platformPackage === undefined) return undefined;
    return join(
      pathEntry,
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      platformPackage.packageName,
      "vendor",
      platformPackage.target,
      "bin",
      "codex.exe",
    );
  }

  async #candidate(
    executablePath: string,
    source: RuntimeCandidateSource,
    buildHashes: Map<string, Promise<string | undefined>>,
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
    const hashCacheKey = `${normalize(canonicalPath).toLowerCase()}\n${metadata.size}\n${metadata.mtimeMs}`;
    let hashPromise = buildHashes.get(hashCacheKey);
    if (hashPromise === undefined) {
      hashPromise = this.#readBuildSha256(requestedPath).catch(() => undefined);
      buildHashes.set(hashCacheKey, hashPromise);
    }
    const rawBuildSha256 = await hashPromise;
    const buildSha256 =
      rawBuildSha256 !== undefined && /^[a-f0-9]{64}$/i.test(rawBuildSha256)
        ? rawBuildSha256.toLowerCase()
        : undefined;
    const after = await this.#fs.stat(requestedPath).catch(() => undefined);
    if (
      after === undefined ||
      after.size !== metadata.size ||
      after.mtimeMs !== metadata.mtimeMs ||
      buildSha256 === undefined
    ) {
      return undefined;
    }
    return {
      executablePath: requestedPath,
      canonicalPath,
      source,
      ...(productVersion === undefined ? {} : { productVersion }),
      buildSha256,
      modifiedAtUnixMs: metadata.mtimeMs,
    };
  }
}

/** Limit the Desktop override to the generation store; runtime preparation verifies its files. */
function desktopEngineOverride(
  configuredPath: string | undefined,
  dataDirectory: string,
): string | undefined {
  if (configuredPath === undefined || !isAbsolute(configuredPath)) return undefined;
  const root = join(dataDirectory, "engine-generations");
  const path = resolve(configuredPath);
  const parts = relative(root, path).split(/[\\/]/u);
  return parts.length === 3 &&
    /^codex-[a-f0-9]{64}$/iu.test(parts[0] ?? "") &&
    parts[1]?.toLowerCase() === "package" &&
    parts[2]?.toLowerCase() === "codex.exe"
    ? path
    : undefined;
}

function candidatePathKey(candidate: RuntimeCandidate): string {
  return normalize(candidate.canonicalPath).toLowerCase();
}

function hashFileSha256(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", () => resolveHash(hash.digest("hex")));
  });
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
