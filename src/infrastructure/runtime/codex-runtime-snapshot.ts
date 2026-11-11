import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { RuntimeCandidate } from "../../domain/runtime.js";

const WINDOWS_RUNTIME_FILES = [
  "codex.exe",
  "codex-code-mode-host.exe",
  "codex-command-runner.exe",
  "codex-windows-sandbox-setup.exe",
] as const;

/** Pin one complete copy of each installed generation before an updater removes its sidecars. */
export async function snapshotManagedCodexRuntime(
  candidate: RuntimeCandidate,
  ownedRoot: string,
  platform: NodeJS.Platform = process.platform,
): Promise<RuntimeCandidate> {
  if (platform !== "win32" || candidate.source !== "managed_install") return candidate;
  const source = dirname(candidate.executablePath);
  const hashes = await packageHashes(source);
  for (const name of WINDOWS_RUNTIME_FILES) {
    const path = join(source, name);
    if (!(await stat(path).catch(() => undefined))?.isFile()) {
      throw new Error(`CODEX_RUNTIME_PACKAGE_INCOMPLETE: ${path}`);
    }
  }
  if (hashes.get("codex.exe") !== candidate.buildSha256) {
    throw new Error("CODEX_RUNTIME_PACKAGE_CHANGED: executable differs from discovery");
  }
  await mkdir(ownedRoot, { recursive: true });
  const generation = createHash("sha256")
    .update(JSON.stringify([...hashes].sort(([left], [right]) => left.localeCompare(right))))
    .digest("hex");
  const generationRoot = join(ownedRoot, `codex-${generation}`);
  const destination = join(generationRoot, "package");
  const ownedPrefix = `${resolve(ownedRoot).toLowerCase()}${sep}`;
  if (
    resolve(source).toLowerCase().startsWith(ownedPrefix) &&
    resolve(source).toLowerCase() !== resolve(destination).toLowerCase()
  ) {
    throw new Error("CODEX_RUNTIME_PACKAGE_CHANGED: staged generation contents differ");
  }
  if ((await stat(generationRoot).catch(() => undefined))?.isDirectory()) {
    await assertPackageUnchanged(source, destination, hashes);
  } else {
    const pendingRoot = await mkdtemp(join(ownedRoot, ".codex-"));
    try {
      await cp(source, join(pendingRoot, "package"), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await assertPackageUnchanged(source, join(pendingRoot, "package"), hashes);
      try {
        await rename(pendingRoot, generationRoot);
      } catch (error) {
        // Another preparation may have published this generation first.
        if (!(await stat(generationRoot).catch(() => undefined))?.isDirectory()) throw error;
        await assertPackageUnchanged(source, destination, hashes);
      }
    } finally {
      await rm(pendingRoot, { recursive: true, force: true });
    }
  }
  const executablePath = join(destination, basename(candidate.executablePath));
  return { ...candidate, executablePath, canonicalPath: executablePath };
}

async function assertPackageUnchanged(
  source: string,
  destination: string,
  expected: ReadonlyMap<string, string>,
): Promise<void> {
  for (const root of [destination, source]) {
    const actual = await packageHashes(root);
    if (
      actual.size !== expected.size ||
      [...expected].some(([name, hash]) => actual.get(name) !== hash)
    ) {
      throw new Error(`CODEX_RUNTIME_PACKAGE_CHANGED: ${root}`);
    }
  }
}

async function packageHashes(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        hashes.set(relative(root, path).replaceAll("\\", "/"), await digest(path));
      } else {
        throw new Error(`CODEX_RUNTIME_PACKAGE_UNSUPPORTED_ENTRY: ${path}`);
      }
    }
  }
  await walk(root);
  return hashes;
}

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
