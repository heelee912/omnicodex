import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const files = [
  "codex.exe",
  "codex-code-mode-host.exe",
  "codex-command-runner.exe",
  "codex-windows-sandbox-setup.exe",
];
const source = resolve(process.argv[2] ?? "");
const root = resolve(process.argv[3] ?? "");
const version = process.argv[4];
if (
  !process.argv[2] ||
  !process.argv[3] ||
  !/^codex-cli [0-9][a-z0-9.+-]*$/iu.test(version ?? "")
) {
  throw new Error("source package, generation root, and verified Codex version required");
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function packageHashes(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (
    entries.length !== files.length ||
    entries.some((entry) => !entry.isFile() || !files.includes(entry.name))
  ) {
    throw new Error(`Engine package has unexpected or missing files: ${directory}`);
  }
  return new Map(
    await Promise.all(files.map(async (name) => [name, await sha256(join(directory, name))])),
  );
}

async function matches(directory, expected) {
  const actual = await packageHashes(directory);
  return [...expected].every(([name, hash]) => actual.get(name) === hash);
}

const sourceHashes = new Map(
  await Promise.all(
    files.map(async (name) => {
      const path = join(source, name);
      if (!(await stat(path)).isFile()) throw new Error(`Required engine file is absent: ${path}`);
      return [name, await sha256(path)];
    }),
  ),
);
const generation = createHash("sha256")
  .update(JSON.stringify([...sourceHashes].sort(([left], [right]) => left.localeCompare(right))))
  .digest("hex");
const generationDirectory = join(root, `codex-${generation}`);
const packageDirectory = join(generationDirectory, "package");
await mkdir(root, { recursive: true });
if (!(await stat(generationDirectory).catch(() => undefined))) {
  const pending = await mkdtemp(join(root, ".codex-"));
  try {
    const stagedPackage = join(pending, "package");
    await mkdir(stagedPackage);
    await Promise.all(files.map((name) => copyFile(join(source, name), join(stagedPackage, name))));
    if (!(await matches(stagedPackage, sourceHashes)))
      throw new Error("Staged engine differs from source");
    await writeFile(
      join(pending, "engine-generation.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        generation,
        codexCliVersion: version.slice("codex-cli ".length),
        files: Object.fromEntries(sourceHashes),
        stagedAtUnixMs: Date.now(),
      })}\n`,
      "utf8",
    );
    try {
      await rename(pending, generationDirectory);
    } catch (error) {
      if (!(await stat(generationDirectory).catch(() => undefined))?.isDirectory()) throw error;
    }
  } finally {
    const beneathRoot = relative(root, pending);
    if (!beneathRoot.startsWith("..") && beneathRoot !== "" && !beneathRoot.includes("/..")) {
      await rm(pending, { recursive: true, force: true });
    }
  }
}
if (!(await matches(packageDirectory, sourceHashes)))
  throw new Error("Installed engine differs from source");
console.log(join(packageDirectory, "codex.exe"));
