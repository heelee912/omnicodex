import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { RuntimeCandidate } from "../../domain/runtime.js";

const WINDOWS_RUNTIME_FILES = [
  "codex.exe",
  "codex-code-mode-host.exe",
  "codex-command-runner.exe",
  "codex-windows-sandbox-setup.exe",
] as const;

/** A package-local failure proven before any native request can be dispatched. */
export class CodexRuntimePackageError extends Error {
  constructor(
    readonly code:
      | "CODEX_RUNTIME_PACKAGE_INCOMPLETE"
      | "CODEX_RUNTIME_PACKAGE_CHANGED"
      | "CODEX_RUNTIME_PACKAGE_UNSUPPORTED_ENTRY",
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "CodexRuntimePackageError";
  }
}

/** Pin one complete copy of each installed generation before an updater removes its sidecars. */
export async function snapshotManagedCodexRuntime(
  candidate: RuntimeCandidate,
  ownedRoot: string,
  platform: NodeJS.Platform = process.platform,
): Promise<RuntimeCandidate> {
  if (platform !== "win32" || candidate.source !== "managed_install") return candidate;
  const source = dirname(candidate.canonicalPath);
  for (const name of WINDOWS_RUNTIME_FILES) {
    const path = join(source, name);
    if (!(await lstat(path).catch(() => undefined))?.isFile()) {
      throw new CodexRuntimePackageError("CODEX_RUNTIME_PACKAGE_INCOMPLETE", path);
    }
  }
  const hashes = await packageHashes(source);
  if (hashes.get("codex.exe") !== candidate.buildSha256) {
    throw new CodexRuntimePackageError(
      "CODEX_RUNTIME_PACKAGE_CHANGED",
      "executable differs from discovery",
    );
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
    throw new CodexRuntimePackageError(
      "CODEX_RUNTIME_PACKAGE_CHANGED",
      "staged generation contents differ",
    );
  }
  if ((await stat(generationRoot).catch(() => undefined))?.isDirectory()) {
    await assertPackageUnchanged(source, destination, hashes);
  } else {
    const pendingRoot = await mkdtemp(join(ownedRoot, ".codex-"));
    try {
      const pendingPackage = join(pendingRoot, "package");
      await mkdir(pendingPackage);
      for (const name of hashes.keys()) {
        await packageRead(() => copyFile(join(source, name), join(pendingPackage, name)), source);
      }
      await assertPackageUnchanged(source, pendingPackage, hashes);
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
  const executablePath = join(destination, "codex.exe");
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
      throw new CodexRuntimePackageError("CODEX_RUNTIME_PACKAGE_CHANGED", root);
    }
  }
}

async function packageHashes(root: string): Promise<Map<string, string>> {
  return packageRead(async () => {
    const hashes = new Map<string, string>();
    for (const entry of await readdir(root, { withFileTypes: true })) {
      // Copy only the installed executable set and native DLL dependencies.
      // Never walk CODEX_HOME or copy auth/config/profile files beside a binary.
      if (
        !WINDOWS_RUNTIME_FILES.some((name) => name === entry.name) &&
        !entry.name.toLowerCase().endsWith(".dll")
      )
        continue;
      const path = join(root, entry.name);
      if (!entry.isFile()) {
        throw new CodexRuntimePackageError("CODEX_RUNTIME_PACKAGE_UNSUPPORTED_ENTRY", path);
      }
      hashes.set(entry.name, await digest(path));
    }
    for (const name of WINDOWS_RUNTIME_FILES) {
      if (!hashes.has(name)) {
        throw new CodexRuntimePackageError("CODEX_RUNTIME_PACKAGE_INCOMPLETE", join(root, name));
      }
    }
    return hashes;
  }, root);
}

async function packageRead<T>(read: () => Promise<T>, root: string): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CodexRuntimePackageError("CODEX_RUNTIME_PACKAGE_CHANGED", root);
    }
    throw error;
  }
}

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
