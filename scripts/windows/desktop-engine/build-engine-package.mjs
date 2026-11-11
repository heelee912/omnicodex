import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  memoryPressureExitCode,
  minimumVirtualMb,
  readAvailableVirtualMb,
} from "./engine-build-capacity.mjs";
import {
  EngineBuildMemoryPressure,
  runCargoWithMemoryGuard,
} from "./run-cargo-with-memory-guard.mjs";

const [checkoutArgument, manifestArgument, targetArgument, packageArgument, ...flags] =
  process.argv.slice(2);
if (
  !checkoutArgument ||
  !manifestArgument ||
  !targetArgument ||
  !packageArgument ||
  flags.length > 1 ||
  (flags.length === 1 && flags[0] !== "--check")
) {
  throw new Error(
    "Usage: node build-engine-package.mjs <prepared-checkout> <patch-series.json> <cargo-target-directory> <package-directory> [--check]",
  );
}
if (process.platform !== "win32") throw new Error("Desktop engine packages require Windows");

const checkout = resolve(checkoutArgument);
const manifestPath = resolve(manifestArgument);
const targetDirectory = resolve(targetArgument);
const packageDirectory = resolve(packageArgument);
const cargoWorkspace = join(checkout, "codex-rs");
const marker = JSON.parse(await readFile(join(checkout, "engine-source-prepared.json"), "utf8"));
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));

function git(...args) {
  return execFileSync("git", args, {
    cwd: checkout,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

if (resolve(git("rev-parse", "--show-toplevel")) !== checkout) {
  throw new Error("Prepared engine source must be a Git worktree root");
}
if (
  marker?.schemaVersion !== 1 ||
  !/^[a-f0-9]{40}$/u.test(marker.targetCommit) ||
  !/^[a-f0-9]{64}$/u.test(marker.patchSeriesSha256) ||
  !/^[a-f0-9]{64}$/u.test(marker.sourceDiffSha256) ||
  !Number.isSafeInteger(marker.changedFiles) ||
  !Array.isArray(marker.changedPaths) ||
  marker.changedPaths.length !== marker.changedFiles ||
  marker.changedPaths.some(
    (entry) =>
      typeof entry?.path !== "string" ||
      !entry.path.startsWith("codex-rs/") ||
      entry.path.split("/").includes("..") ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256),
  ) ||
  manifest?.schemaVersion !== 1 ||
  !/^rust-v[0-9][a-z0-9.+-]*$/iu.test(marker.targetTag) ||
  typeof manifest.codexCliVersion !== "string"
) {
  throw new Error("Prepared engine source or patch manifest is invalid");
}
if (git("rev-parse", "HEAD").toLowerCase() !== marker.targetCommit) {
  throw new Error("Prepared engine source commit changed");
}
if (createHash("sha256").update(manifestBytes).digest("hex") !== marker.patchSeriesSha256) {
  throw new Error("Prepared engine patch manifest changed");
}
if (
  createHash("sha256")
    .update(git("diff", "--binary", "--full-index", "HEAD"))
    .digest("hex") !== marker.sourceDiffSha256
) {
  throw new Error("Prepared engine source diff changed");
}
const trackedChanges = git("diff", "--name-only", "HEAD").split(/\r?\n/u).filter(Boolean);
const untracked = git("ls-files", "--others", "--exclude-standard").split(/\r?\n/u).filter(Boolean);
if (!untracked.includes("engine-source-prepared.json")) {
  throw new Error("Prepared engine source marker is not an untracked file");
}
const actualPaths = [
  ...trackedChanges,
  ...untracked.filter((path) => path !== "engine-source-prepared.json"),
].sort();
const expectedPaths = marker.changedPaths.map((entry) => entry.path).sort();
if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
  throw new Error("Prepared engine changed file paths differ");
}
for (const entry of marker.changedPaths) {
  if ((await sha256(join(checkout, entry.path))) !== entry.sha256) {
    throw new Error(`Prepared engine source file differs: ${entry.path}`);
  }
}
if (
  manifest.upstreamTag !== `rust-v${manifest.codexCliVersion}` ||
  marker.patchBaseCommit !== manifest.upstreamCommit?.toLowerCase()
) {
  throw new Error("Prepared engine patch base differs from patch manifest");
}
const targetCliVersion = marker.targetTag.slice("rust-v".length);
git("diff", "--check");

const rustup = join(homedir(), ".cargo", "bin", "rustup.exe");
const cargo = execFileSync(rustup, ["which", "cargo"], {
  cwd: cargoWorkspace,
  encoding: "utf8",
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
}).trim();
if (!(await stat(cargo)).isFile()) throw new Error("Rust toolchain cargo.exe is unavailable");
const rustc = join(dirname(cargo), "rustc.exe");
if (!(await stat(rustc)).isFile()) throw new Error("Rust toolchain rustc.exe is unavailable");
if (targetDirectory.length > 120) throw new Error("Cargo target directory is too long for Windows");

const availableVirtualMb = readAvailableVirtualMb();
if (flags[0] === "--check") {
  console.log(
    JSON.stringify({
      checkout,
      cargo,
      targetDirectory,
      packageDirectory,
      codexCliVersion: targetCliVersion,
      availableVirtualMb,
      minimumVirtualMb,
      canBuild: availableVirtualMb >= minimumVirtualMb,
    }),
  );
  process.exit(0);
}
if (availableVirtualMb < minimumVirtualMb) {
  console.error(
    `Engine release build deferred: ${availableVirtualMb} MB free virtual memory; ${minimumVirtualMb} MB required`,
  );
  process.exit(memoryPressureExitCode);
}

await mkdir(targetDirectory, { recursive: true });
try {
  await runCargoWithMemoryGuard(
    cargo,
    [
      "build",
      "--release",
      "--locked",
      "-j1",
      // Keep the large core crate below the desktop's available memory without changing other crates.
      "--config",
      "profile.release.package.codex-core.opt-level=2",
      "-p",
      "codex-cli",
      "-p",
      "codex-code-mode-host",
      "-p",
      "codex-windows-sandbox",
      "--bin",
      "codex",
      "--bin",
      "codex-code-mode-host",
      "--bin",
      "codex-command-runner",
      "--bin",
      "codex-windows-sandbox-setup",
    ],
    {
      cwd: cargoWorkspace,
      env: {
        ...process.env,
        CARGO_TARGET_DIR: targetDirectory,
        RUSTC: rustc,
        CARGO_PROFILE_RELEASE_LTO: "false",
        CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16",
        // This package ships executables without PDB files; avoid generating unused debug data.
        CARGO_PROFILE_RELEASE_DEBUG: "0",
      },
    },
  );
} catch (error) {
  if (!(error instanceof EngineBuildMemoryPressure)) throw error;
  console.error(error.message);
  process.exit(memoryPressureExitCode);
}

const binaryNames = [
  "codex.exe",
  "codex-code-mode-host.exe",
  "codex-command-runner.exe",
  "codex-windows-sandbox-setup.exe",
];
const releaseDirectory = join(targetDirectory, "release");
const builtVersion = execFileSync(join(releaseDirectory, "codex.exe"), ["--version"], {
  encoding: "utf8",
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
}).trim();
if (builtVersion !== `codex-cli ${targetCliVersion}`) {
  throw new Error(`Built engine version differs from Desktop target: ${builtVersion}`);
}

const packageParent = dirname(packageDirectory);
await mkdir(packageParent, { recursive: true });
if (await stat(packageDirectory).catch(() => undefined)) {
  throw new Error("Engine package destination already exists");
}
const pending = await mkdtemp(join(packageParent, ".engine-package-"));
try {
  const hashes = {};
  for (const name of binaryNames) {
    const original = join(releaseDirectory, name);
    const staged = join(pending, name);
    if (!(await stat(original)).isFile()) throw new Error(`Built engine file is missing: ${name}`);
    await copyFile(original, staged);
    const originalHash = await sha256(original);
    const stagedHash = await sha256(staged);
    if (originalHash !== stagedHash) throw new Error(`Staged engine file differs: ${name}`);
    hashes[name] = stagedHash;
  }
  await rename(pending, packageDirectory);
  console.log(JSON.stringify({ packageDirectory, codexCliVersion: targetCliVersion, hashes }));
} catch (error) {
  if (await stat(pending).catch(() => undefined)) {
    try {
      const actualParent = await realpath(packageParent);
      const actualPending = await realpath(pending);
      if (relative(actualParent, actualPending) !== basename(pending)) {
        throw new Error("Engine package cleanup path is outside its package root");
      }
      await rm(pending, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Engine package build and cleanup failed");
    }
  }
  throw error;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
