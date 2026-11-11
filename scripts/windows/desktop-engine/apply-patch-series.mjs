import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const [checkoutArgument, manifestArgument, ...flags] = process.argv.slice(2);
if (
  !checkoutArgument ||
  !manifestArgument ||
  flags.some((flag) => flag !== "--check" && flag !== "--forward") ||
  new Set(flags).size !== flags.length
) {
  throw new Error(
    "Usage: node apply-patch-series.mjs <source-checkout> <patch-series.json> [--check] [--forward]",
  );
}
const checkOnly = flags.includes("--check");
const allowForward = flags.includes("--forward");

const checkout = resolve(checkoutArgument);
const manifestPath = resolve(manifestArgument);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (
  manifest?.schemaVersion !== 1 ||
  !/^[a-f0-9]{40}$/iu.test(manifest.upstreamCommit) ||
  !Array.isArray(manifest.patches) ||
  manifest.patches.length === 0
) {
  throw new Error("Engine patch series manifest is invalid");
}

function git(...args) {
  return execFileSync("git", args, {
    cwd: checkout,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

if (resolve(git("rev-parse", "--show-toplevel")) !== checkout) {
  throw new Error("Engine source checkout must be the Git worktree root");
}
const sourceCommit = git("rev-parse", "HEAD").toLowerCase();
const patchBaseCommit = manifest.upstreamCommit.toLowerCase();
if (manifest.upstreamTag !== undefined) {
  if (
    typeof manifest.upstreamTag !== "string" ||
    !/^rust-v[0-9][a-z0-9.+-]*$/iu.test(manifest.upstreamTag)
  ) {
    throw new Error("Engine patch source tag is invalid");
  }
  const taggedCommit = git("rev-parse", `${manifest.upstreamTag}^{commit}`).toLowerCase();
  if (taggedCommit !== patchBaseCommit) {
    throw new Error("Engine patch source tag differs from patch series base");
  }
}
if (sourceCommit !== patchBaseCommit) {
  if (!allowForward) throw new Error("Engine source commit differs from patch series base");
  try {
    git("merge-base", "--is-ancestor", patchBaseCommit, sourceCommit);
  } catch {
    throw new Error("Engine source commit is not a descendant of patch series base");
  }
}

const patchBuffers = [];
const changedPaths = new Set();
for (const patch of manifest.patches) {
  if (
    typeof patch?.file !== "string" ||
    basename(patch.file) !== patch.file ||
    !patch.file.endsWith(".patch") ||
    !/^[a-f0-9]{64}$/iu.test(patch.sha256) ||
    !Number.isSafeInteger(patch.files) ||
    patch.files < 1
  ) {
    throw new Error("Engine patch entry is invalid");
  }
  const bytes = await readFile(join(dirname(manifestPath), patch.file));
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== patch.sha256.toLowerCase()) {
    throw new Error(`Engine patch hash differs: ${patch.file}`);
  }
  const paths = [...bytes.toString("utf8").matchAll(/^diff --git a\/(.+) b\/\1$/gmu)].map(
    (match) => match[1],
  );
  if (
    paths.length !== patch.files ||
    paths.some(
      (path) =>
        !path.startsWith("codex-rs/") ||
        path.split("/").includes("..") ||
        path === "codex-rs/Cargo.lock" ||
        changedPaths.has(path),
    )
  ) {
    throw new Error(`Engine patch file list is invalid: ${patch.file}`);
  }
  for (const path of paths) changedPaths.add(path);
  patchBuffers.push(bytes);
}

const combinedPath = join(tmpdir(), `omnicodex-engine-patches-${randomUUID()}.patch`);
await writeFile(combinedPath, Buffer.concat(patchBuffers), { flag: "wx" });
try {
  if (checkOnly) {
    git("diff", "--cached", "--quiet");
    git("apply", "--cached", "--check", combinedPath);
  } else {
    if (git("status", "--porcelain", "--untracked-files=all").length > 0) {
      throw new Error("Engine source checkout must be clean before patch application");
    }
    git("apply", "--check", combinedPath);
    git("apply", combinedPath);
  }
  console.log(
    JSON.stringify({
      patchBaseCommit,
      targetCommit: sourceCommit,
      patchCount: manifest.patches.length,
      changedFiles: changedPaths.size,
      changedPaths: [...changedPaths].sort(),
      mode: checkOnly ? "checked" : "applied",
    }),
  );
} finally {
  await unlink(combinedPath);
}
