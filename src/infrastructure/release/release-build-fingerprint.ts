import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const FINGERPRINT_VERSION = "omnicodex-release-build-v1";

export interface OmniCodexReleaseIdentity {
  readonly releasePath?: string;
  readonly releaseFingerprint?: string;
}

/**
 * Hashes the executable release, rather than source-control or documentation
 * state. A normal restart can therefore be idempotent while a rebuilt runtime
 * is still activated without relying on timestamps or a mutable global flag.
 */
export async function computeOmniCodexReleaseFingerprint(releasePath: string): Promise<string> {
  const root = resolve(releasePath);
  const files = await executableReleaseFiles(root);
  if (files.length === 0) {
    throw new Error(`OmniCodex release has no executable dist files: ${root}`);
  }
  const hash = createHash("sha256");
  hash.update(FINGERPRINT_VERSION, "utf8");
  for (const absolutePath of files) {
    const relativePath = relative(root, absolutePath).replaceAll("\\", "/");
    const bytes = await readFile(absolutePath);
    hash.update(`\0${Buffer.byteLength(relativePath, "utf8")}:`, "utf8");
    hash.update(relativePath, "utf8");
    hash.update(`\0${bytes.byteLength}:`, "utf8");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function isSameOmniCodexReleaseBuild(
  running: OmniCodexReleaseIdentity,
  targetReleasePath: string,
  targetFingerprint: string,
): boolean {
  if (
    running.releasePath === undefined ||
    running.releaseFingerprint === undefined ||
    !/^[a-f0-9]{64}$/u.test(targetFingerprint)
  ) {
    return false;
  }
  const runningPath = comparablePath(running.releasePath);
  const targetPath = comparablePath(targetReleasePath);
  return runningPath === targetPath && running.releaseFingerprint === targetFingerprint;
}

async function executableReleaseFiles(root: string): Promise<string[]> {
  const candidates: string[] = [];
  for (const name of ["package.json", "package-lock.json"]) {
    const path = join(root, name);
    const state = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (state?.isFile() === true) candidates.push(path);
  }
  await collectExecutableFiles(join(root, "dist"), candidates);
  return candidates.sort((left, right) =>
    relative(root, left).localeCompare(relative(root, right), "en"),
  );
}

async function collectExecutableFiles(directory: string, output: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`OmniCodex executable release cannot contain a symbolic link: ${path}`);
    }
    if (entry.isDirectory()) {
      await collectExecutableFiles(path, output);
      continue;
    }
    if (!entry.isFile() || !isRuntimeArtifact(entry.name)) continue;
    output.push(path);
  }
}

function isRuntimeArtifact(name: string): boolean {
  return !name.endsWith(".map") && !name.endsWith(".d.ts") && !name.endsWith(".d.ts.map");
}

function comparablePath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute;
}
