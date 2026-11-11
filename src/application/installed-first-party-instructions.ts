import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

export interface InstalledFirstPartyAssetRequest {
  readonly codexHome: string;
  readonly plugins: readonly string[];
  readonly relativePath: readonly string[];
  readonly signal?: AbortSignal;
}

class InstalledFirstPartyAssetMissingError extends Error {}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Resolves the same installed first-party plugin assets that Codex Desktop
 * exposes to the local agent. Backup directories are intentionally excluded:
 * only direct plugin/version children participate in active selection.
 */
export async function locateInstalledFirstPartyAsset(
  request: InstalledFirstPartyAssetRequest,
): Promise<string> {
  throwIfAborted(request.signal);
  const bundledRoot = join(request.codexHome, "plugins", "cache", "openai-bundled");
  const candidates: Array<{ path: string; modifiedAt: number; active: boolean }> = [];
  const pluginNames = new Set(request.plugins.filter((plugin) => plugin !== "*"));
  if (request.plugins.includes("*")) {
    let entries: Dirent[];
    try {
      entries = await readdir(bundledRoot, { withFileTypes: true });
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || /^plugin-backup-/iu.test(entry.name)) continue;
      pluginNames.add(entry.name);
    }
  }
  for (const plugin of pluginNames) {
    throwIfAborted(request.signal);
    const pluginRoot = join(bundledRoot, plugin);
    // Desktop's installation pointer is authoritative when present. A file
    // removed in that version must not be resurrected from an older cache.
    let activeRoot: string | undefined;
    try {
      activeRoot = await realpath(join(pluginRoot, "latest"));
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
    if (activeRoot !== undefined) {
      const candidate = join(activeRoot, ...request.relativePath);
      try {
        candidates.push({
          path: candidate,
          modifiedAt: (await stat(candidate)).mtimeMs,
          active: true,
        });
      } catch (error) {
        if (!isMissingPath(error)) throw error;
      }
      continue;
    }
    let versions: string[];
    try {
      versions = (await readdir(pluginRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      continue;
    }
    for (const version of versions) {
      throwIfAborted(request.signal);
      const candidate = join(pluginRoot, version, ...request.relativePath);
      try {
        candidates.push({
          path: candidate,
          modifiedAt: (await stat(candidate)).mtimeMs,
          active: false,
        });
      } catch (error) {
        if (!isMissingPath(error)) throw error;
        // Ignore incomplete or retired plugin versions.
      }
    }
  }
  candidates.sort(
    (left, right) =>
      Number(right.active) - Number(left.active) ||
      right.modifiedAt - left.modifiedAt ||
      right.path.localeCompare(left.path, "en"),
  );
  const selected = candidates[0]?.path;
  if (selected === undefined) {
    throw new InstalledFirstPartyAssetMissingError(
      `Installed first-party plugin asset is missing: ${request.relativePath.join("/")}`,
    );
  }
  throwIfAborted(request.signal);
  return selected;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Operation was aborted");
}
