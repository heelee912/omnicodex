import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RUNTIME_FILES = [
  "codex.exe",
  "codex-code-mode-host.exe",
  "codex-command-runner.exe",
  "codex-windows-sandbox-setup.exe",
];
const GENERATION_PREFIX = "desktop-runtime-";
const MANIFEST = "desktop-runtime.json";
const READY = "desktop-ready";

function defaultManagedRoot() {
  return join(
    process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
    "OpenAI",
    "Codex",
    "bin",
  );
}

/** Selection never stages an update (CLI and auxiliary clients use this too). */
export async function findStockExecutable({
  managedRoot = defaultManagedRoot(),
  readVersion = readStockVersion,
} = {}) {
  const entries = await readdir(managedRoot, { withFileTypes: true });
  const available = [];
  for (const entry of entries) {
    // Pending copies are never executable candidates, even if codex.exe was copied first.
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const directory = join(managedRoot, entry.name);
    let path = join(directory, "codex.exe");
    try {
      let manifest;
      if (entry.name.startsWith(GENERATION_PREFIX)) {
        manifest = await verifyGeneration(directory);
        if ((await readFile(join(directory, READY), "utf8")) !== manifest.digest) continue;
        path = join(directory, "runtime", "codex.exe");
      }
      const metadata = await assertRegular(path);
      const version = await readVersion(path);
      versionParts(version);
      if (manifest && version !== manifest.version) continue;
      available.push({ path, version, modifiedAt: metadata.mtimeMs });
    } catch {
      // An incomplete, inactive or corrupt generation is not a fallback executable.
    }
  }
  const latest = available.sort(
    (left, right) =>
      compareStockVersions(right.version, left.version) || right.modifiedAt - left.modifiedAt,
  )[0];
  if (!latest) throw new Error("No usable Codex Desktop executable was found");
  return assertExecutable(latest.path);
}

export async function readStockVersion(executable) {
  const output = await execFileAsync(executable, ["--version"], {
    windowsHide: true,
    timeout: 5000,
  });
  const version = /^codex-cli ([0-9][a-z0-9.+-]*)$/iu.exec(output.stdout.trim())?.[1];
  versionParts(version);
  return version;
}

function versionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z0-9]+(?:[.-][a-z0-9]+)*))?(?:\+[a-z0-9.-]+)?$/iu.exec(
    version ?? "",
  );
  if (!match) throw new Error(`Codex executable has no valid version: ${version}`);
  return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split(".") };
}

export function compareStockVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numericX = /^\d+$/u.test(x);
    const numericY = /^\d+$/u.test(y);
    if (numericX && numericY) {
      if (BigInt(x) !== BigInt(y)) return BigInt(x) > BigInt(y) ? 1 : -1;
      continue;
    }
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
/** Both legacy flat generations and isolated whole-runtime generations share this root. */
export function stockManagedRoot(executable) {
  const directory = win32.dirname(win32.normalize(executable));
  const parent = win32.dirname(directory);
  return win32.basename(directory).toLowerCase() === "runtime" &&
    win32.basename(parent).toLowerCase().startsWith(GENERATION_PREFIX)
    ? win32.dirname(parent)
    : parent;
}

/** Called under the Desktop startup lock, only after the old instance has exited. */
export async function prepareDesktopRuntime(
  selectedExecutable,
  desktop,
  {
    managedRoot = defaultManagedRoot(),
    inspectPackage = inspectDesktopPackage,
    readVersion = readStockVersion,
    verifySignatures = verifyRuntimeSignatures,
    copy = copyFile,
  } = {},
) {
  const identity = await inspectPackage(desktop);
  assertPackageIdentity(identity, desktop);
  const source = join(identity.installLocation, "app", "resources");
  await assertDirectory(identity.installLocation);
  await assertDirectory(join(identity.installLocation, "app"));
  await assertDirectory(source);
  const before = await runtimeHashes(source);
  // Authenticate before executing even --version. DLLs are package-provenanced and hashed.
  await verifySignatures(RUNTIME_FILES.map((name) => join(source, name)));
  const version = await readVersion(join(source, "codex.exe"));
  const selectedVersion = await readVersion(selectedExecutable);
  const comparison = compareStockVersions(version, selectedVersion);
  await assertDirectory(managedRoot);
  if (!samePath(stockManagedRoot(resolve(selectedExecutable)), resolve(managedRoot))) {
    throw new Error("Selected Codex executable is outside the managed runtime root");
  }
  if (comparison < 0) {
    throw new Error("Running Desktop package is older than the selected managed Codex runtime");
  }
  if (comparison === 0) {
    const selectedHashes = await runtimeHashes(
      win32.dirname(win32.normalize(selectedExecutable)),
    ).catch(() => undefined);
    if (selectedHashes !== undefined && JSON.stringify(selectedHashes) === JSON.stringify(before)) {
      await assertUnchangedSource();
      return { executable: selectedExecutable, activate: async () => undefined };
    }
  }
  const payload = { schemaVersion: 1, packageFullName: identity.fullName, version, files: before };
  const manifest = { ...payload, digest: digest(payload) };
  const entries = await readdir(managedRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(GENERATION_PREFIX)) continue;
    const directory = join(managedRoot, entry.name);
    const stored = await readFile(join(directory, MANIFEST), "utf8").catch(() => undefined);
    if (stored === undefined) continue;
    let candidate;
    try {
      candidate = JSON.parse(stored);
    } catch {
      continue;
    }
    if (candidate.digest !== manifest.digest) continue;
    try {
      await verifyGeneration(directory, manifest);
    } catch {
      // Preserve the corrupt generation for diagnosis; a fresh signed AppX copy
      // can still be published without reusing or deleting those bytes.
      continue;
    }
    await assertUnchangedSource();
    return prepared(directory);
  }

  const pending = await mkdtemp(join(managedRoot, ".desktop-runtime-"));
  // Keep the payload nested even after publication: Gateway's independent flat-root
  // discovery must follow the live Desktop path, not switch before Desktop starts it.
  const staged = join(pending, "runtime");
  const directory = join(
    managedRoot,
    `${GENERATION_PREFIX}${manifest.digest.slice(0, 16)}-${randomUUID()}`,
  );
  try {
    await mkdir(staged);
    for (const name of Object.keys(before)) {
      await copy(join(source, name), join(staged, name), constants.COPYFILE_EXCL);
    }
    await writeFile(join(pending, MANIFEST), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    await verifyGeneration(pending, manifest);
    if ((await readVersion(join(staged, "codex.exe"))) !== version) {
      throw new Error("Staged Codex version differs from Desktop package");
    }
    await assertUnchangedSource();
    // Same-volume rename publishes the entire runtime, never individual binaries.
    await rename(pending, directory);
    return prepared(directory);
  } finally {
    await rm(pending, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }

  async function assertUnchangedSource() {
    if (JSON.stringify(await runtimeHashes(source)) !== JSON.stringify(before)) {
      throw new Error("Desktop runtime source changed during staging");
    }
    const current = await inspectPackage(desktop);
    assertPackageIdentity(current, desktop);
    if (
      current.fullName !== identity.fullName ||
      !samePath(current.installLocation, identity.installLocation)
    ) {
      throw new Error("Desktop package changed during staging");
    }
  }

  function prepared(directory) {
    return {
      executable: join(directory, "runtime", "codex.exe"),
      // The stock selector also waits for successful Desktop initialization.
      // Failed launches leave a complete, inactive generation that can be reused.
      activate: async () => {
        await verifyGeneration(directory, manifest);
        const ready = join(directory, READY);
        const existing = await readFile(ready, "utf8").catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        if (existing !== undefined) {
          if (existing !== manifest.digest)
            throw new Error("Invalid Desktop runtime readiness marker");
          return;
        }
        const temporary = join(managedRoot, `.desktop-ready-${randomUUID()}`);
        try {
          await writeFile(temporary, manifest.digest, { flag: "wx", mode: 0o600 });
          await rename(temporary, ready);
        } finally {
          await rm(temporary, { force: true });
        }
      },
    };
  }
}

function assertPackageIdentity(identity, desktop) {
  if (
    identity?.name !== "OpenAI.Codex" ||
    identity.signatureKind !== "Store" ||
    identity.status !== "Ok" ||
    !/^OpenAI\.Codex_[^\\/]+$/u.test(identity.fullName ?? "") ||
    typeof identity.installLocation !== "string" ||
    identity.pid !== desktop?.pid ||
    !Number.isSafeInteger(desktop?.pid) ||
    desktop.pid <= 0 ||
    !Number.isFinite(desktop.startedAtUnixMs) ||
    identity.startedAtUnixMs !== desktop.startedAtUnixMs ||
    typeof desktop.executablePath !== "string" ||
    !samePath(identity.executablePath ?? "", desktop.executablePath) ||
    !samePath(join(identity.installLocation, "app", "ChatGPT.exe"), desktop.executablePath)
  ) {
    throw new Error("Running Desktop does not match a trusted registered AppX package");
  }
}

/** OS package registration, matched to the exact owner PID/path/start time, not a directory scan. */
export async function inspectDesktopPackage(desktop) {
  if (!Number.isSafeInteger(desktop?.pid) || desktop.pid <= 0) {
    throw new Error("Desktop owner PID is unavailable");
  }
  const { stdout } = await powershell(String.raw`
$ErrorActionPreference = 'Stop'
$owner = Get-CimInstance Win32_Process -Filter 'ProcessId = ${desktop.pid}'
if (!$owner -or $owner.Name -ine 'ChatGPT.exe' -or !$owner.ExecutablePath -or !$owner.CreationDate) { throw 'Desktop owner is unavailable' }
$packages = @(Get-AppxPackage -Name OpenAI.Codex | Where-Object {
  $_.Name -ceq 'OpenAI.Codex' -and $_.SignatureKind -eq 'Store' -and $_.Status -eq 'Ok' -and
  [String]::Equals((Join-Path $_.InstallLocation 'app\ChatGPT.exe'), $owner.ExecutablePath, [StringComparison]::OrdinalIgnoreCase)
})
if ($packages.Count -ne 1) { throw 'Desktop owner has no unique trusted AppX registration' }
$package = $packages[0]
[pscustomobject]@{
  name = $package.Name
  fullName = $package.PackageFullName
  installLocation = $package.InstallLocation
  signatureKind = [string]$package.SignatureKind
  status = [string]$package.Status
  pid = [int]$owner.ProcessId
  executablePath = $owner.ExecutablePath
  startedAtUnixMs = ([DateTimeOffset]$owner.CreationDate).ToUnixTimeMilliseconds()
} | ConvertTo-Json -Compress
`);
  return JSON.parse(stdout);
}

async function verifyRuntimeSignatures(paths) {
  const encoded = Buffer.from(JSON.stringify(paths)).toString("base64");
  await powershell(`
$ErrorActionPreference = 'Stop'
$paths = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$signers = @($paths | ForEach-Object {
  $signature = Get-AuthenticodeSignature -LiteralPath $_
  if ($signature.Status -ne 'Valid' -or !$signature.SignerCertificate) { throw 'Invalid Desktop runtime signature' }
  $signature.SignerCertificate.Thumbprint
} | Select-Object -Unique)
if ($signers.Count -ne 1) { throw 'Desktop runtime executable signers do not match' }
`);
}

function powershell(script) {
  if (process.platform !== "win32" || !process.env.SystemRoot) {
    throw new Error("Trusted Desktop runtime inspection requires Windows");
  }
  return execFileAsync(
    join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 },
  );
}

async function runtimeHashes(directory) {
  await assertDirectory(directory);
  const names = [
    ...RUNTIME_FILES,
    ...(await readdir(directory)).filter((name) => /\.dll$/iu.test(name)),
  ].sort();
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    throw new Error("Duplicate Desktop runtime filenames");
  }
  const files = {};
  for (const name of names) {
    const path = join(directory, name);
    await assertRegular(path);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    files[name] = hash.digest("hex");
  }
  return files;
}

async function verifyGeneration(directory, expected) {
  await assertDirectory(directory);
  await assertRegular(join(directory, MANIFEST));
  const manifest = JSON.parse(await readFile(join(directory, MANIFEST), "utf8"));
  const { schemaVersion, packageFullName, version, files } = manifest;
  const names = Object.keys(files ?? {});
  if (
    schemaVersion !== 1 ||
    !/^OpenAI\.Codex_[^\\/]+$/u.test(packageFullName ?? "") ||
    !RUNTIME_FILES.every((name) => names.includes(name)) ||
    names.some((name) => !RUNTIME_FILES.includes(name) && !/^[a-z0-9_.-]+\.dll$/iu.test(name)) ||
    Object.values(files).some((hash) => !/^[a-f0-9]{64}$/u.test(hash)) ||
    manifest.digest !== digest({ schemaVersion, packageFullName, version, files }) ||
    (expected && manifest.digest !== expected.digest)
  ) {
    throw new Error("Invalid Desktop runtime manifest");
  }
  versionParts(version);
  const entries = await readdir(directory);
  for (const name of entries) {
    if (!["runtime", MANIFEST, READY].includes(name))
      throw new Error("Unexpected Desktop runtime file");
    if (name !== "runtime") await assertRegular(join(directory, name));
  }
  const runtime = join(directory, "runtime");
  const binaries = await readdir(runtime);
  if (binaries.length !== names.length || binaries.some((name) => !names.includes(name))) {
    throw new Error("Unexpected or missing Desktop runtime binary");
  }
  if (JSON.stringify(await runtimeHashes(runtime)) !== JSON.stringify(files)) {
    throw new Error("Desktop runtime hashes do not match the complete generation");
  }
  return manifest;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function samePath(left, right) {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

async function assertRegular(path) {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !samePath(await realpath(path), resolve(path))
  ) {
    throw new Error(`Codex runtime path is not a regular non-symlink file: ${path}`);
  }
  return metadata;
}

async function assertDirectory(path) {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !samePath(await realpath(path), resolve(path))
  ) {
    throw new Error(`Codex runtime directory is not a regular non-symlink directory: ${path}`);
  }
}

async function assertExecutable(path) {
  const absolute = resolve(path);
  await assertRegular(absolute);
  if (samePath(absolute, process.execPath)) {
    throw new Error("Codex executable selection resolves to the OmniCodex bridge");
  }
  return absolute;
}
