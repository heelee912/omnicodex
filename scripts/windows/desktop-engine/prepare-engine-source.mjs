import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [repositoryArgument, targetTag, manifestArgument, buildRootArgument] = process.argv.slice(2);
if (
  !repositoryArgument ||
  !/^rust-v[0-9][a-z0-9.+-]*$/iu.test(targetTag ?? "") ||
  !manifestArgument ||
  !buildRootArgument ||
  process.argv.length !== 6
) {
  throw new Error(
    "Usage: node prepare-engine-source.mjs <official-source-repository> <rust-tag> <patch-series.json> <build-root>",
  );
}

const repository = resolve(repositoryArgument);
const manifestPath = resolve(manifestArgument);
const buildRoot = resolve(buildRootArgument);
const applyScript = fileURLToPath(new URL("./apply-patch-series.mjs", import.meta.url));

function git(...args) {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

if (resolve(git("rev-parse", "--show-toplevel")) !== repository) {
  throw new Error("Official source repository must be the Git worktree root");
}
const origin = git("remote", "get-url", "origin").replace(/\/$/u, "");
if (origin !== "https://github.com/openai/codex.git") {
  throw new Error("Engine source origin is not the official Codex repository");
}
const targetCommit = git("rev-parse", `${targetTag}^{commit}`).toLowerCase();
if (!/^[a-f0-9]{40}$/u.test(targetCommit)) {
  throw new Error("Engine source tag did not resolve to a commit");
}

const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
if (manifest?.schemaVersion !== 1 || typeof manifest.codexCliVersion !== "string") {
  throw new Error("Engine patch series manifest is invalid");
}
const generatedLockFile = "codex-rs/Cargo.lock";
if (
  manifest.excludedGeneratedFiles !== undefined &&
  JSON.stringify(manifest.excludedGeneratedFiles) !== JSON.stringify([generatedLockFile])
) {
  throw new Error("Engine patch series has an unsupported generated file");
}
const patchSeriesSha256 = createHash("sha256").update(manifestBytes).digest("hex");
const buildName = `b-${randomUUID().slice(0, 8)}`;
if (basename(buildName) !== buildName) throw new Error("Engine build name is invalid");
const checkout = join(buildRoot, buildName);
if (process.platform === "win32") {
  const longestSourcePath = Math.max(
    ...git("ls-tree", "-r", "--name-only", targetTag)
      .split(/\r?\n/u)
      .map((path) => path.length),
  );
  if (checkout.length + 1 + longestSourcePath > 240) {
    throw new Error(
      "Engine build root is too long for Windows source paths; use a short root such as C:\\e",
    );
  }
}
await mkdir(buildRoot, { recursive: true });
git("worktree", "add", "--detach", checkout, targetTag);

try {
  const applyArguments = [applyScript, checkout, manifestPath];
  if (targetCommit !== manifest.upstreamCommit?.toLowerCase()) applyArguments.push("--forward");
  const application = JSON.parse(
    execFileSync(process.execPath, applyArguments, {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  if (application.mode !== "applied" || application.targetCommit !== targetCommit) {
    throw new Error("Engine source patch application was not verified");
  }
  if (
    !Array.isArray(application.changedPaths) ||
    application.changedPaths.length !== application.changedFiles
  ) {
    throw new Error("Engine source patch file list was not verified");
  }
  let lockFileChanged = false;
  if (manifest.excludedGeneratedFiles !== undefined) {
    const lockPath = join(checkout, generatedLockFile);
    const originalLock = await readFile(lockPath);
    const rustup = join(homedir(), ".cargo", "bin", "rustup.exe");
    const cargo = execFileSync(rustup, ["which", "cargo"], {
      cwd: join(checkout, "codex-rs"),
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    // Release tags can have stale local workspace versions in Cargo.lock.
    // Cargo updates those entries while preserving locked registry dependencies.
    execFileSync(cargo, ["update", "--workspace"], {
      cwd: join(checkout, "codex-rs"),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    lockFileChanged = !originalLock.equals(await readFile(lockPath));
  }
  const verifiedPaths = [
    ...application.changedPaths,
    ...(lockFileChanged ? [generatedLockFile] : []),
  ];
  const changedPaths = await Promise.all(
    verifiedPaths.map(async (path) => ({
      path,
      sha256: createHash("sha256")
        .update(await readFile(join(checkout, path)))
        .digest("hex"),
    })),
  );

  const marker = {
    schemaVersion: 1,
    targetTag,
    targetCommit,
    patchSeriesSha256,
    patchBaseCommit: application.patchBaseCommit,
    changedFiles: verifiedPaths.length,
    changedPaths,
    sourceDiffSha256: createHash("sha256")
      .update(git("-C", checkout, "diff", "--binary", "--full-index", "HEAD"))
      .digest("hex"),
    createdAtUtc: new Date().toISOString(),
  };
  await writeFile(
    join(checkout, "engine-source-prepared.json"),
    `${JSON.stringify(marker, null, 2)}\n`,
    {
      flag: "wx",
    },
  );
  console.log(JSON.stringify({ checkout, ...marker }));
} catch (error) {
  const actualRoot = await realpath(buildRoot);
  const actualCheckout = await realpath(checkout);
  if (relative(actualRoot, actualCheckout) !== buildName) {
    throw new AggregateError([error], "Engine worktree cleanup path is outside its build root");
  }
  try {
    git("worktree", "remove", "--force", checkout);
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], "Engine source preparation and cleanup failed");
  }
  throw error;
}
