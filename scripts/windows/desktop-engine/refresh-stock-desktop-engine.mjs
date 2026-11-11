import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { findStockExecutable, readStockVersion } from "./stock-codex-executable.mjs";

const execFileAsync = promisify(execFile);
const mode = process.argv[2];
if (
  process.platform !== "win32" ||
  !["--check", "--apply"].includes(mode) ||
  process.argv.length !== 3
) {
  throw new Error("Usage on Windows: node refresh-desktop-engine.mjs --check|--apply");
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const stockExecutable = await findStockExecutable();
const stockVersion = await readStockVersion(stockExecutable);
const launcher = resolve(
  process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
  "OmniCodex",
  "bin",
  "OmniCodexDesktopEngine.exe",
);
const bridge = join(dirname(launcher), "stock-app-server-stdio.mjs");
const stockSelector = join(dirname(launcher), "stock-codex-executable.mjs");
const distribution = resolve(scriptDirectory, "..", "..", "..", "dist");
const installedFiles = [
  [join(scriptDirectory, "stock-app-server-stdio.mjs"), bridge],
  [join(scriptDirectory, "stock-codex-executable.mjs"), stockSelector],
  ...[
    "application/policy-documentation-service.js",
    "application/protected-documentation-response.js",
    "domain/protected-policy-document.js",
    "infrastructure/safety/protected-policy-library.js",
    "infrastructure/runtime/stdio-app-server-router.js",
  ].map((relativePath) => [
    join(distribution, relativePath),
    join(dirname(launcher), relativePath),
  ]),
];
const ready = await Promise.all(
  installedFiles.map(([source, target]) => sameFileBytes(source, target)),
);
const launcherHash = createHash("sha256")
  .update(await readFile(join(scriptDirectory, "stock-app-server-launcher.rs")))
  .digest("hex");
const installedLauncherHash = await readFile(
  join(dirname(launcher), "OmniCodexDesktopEngine.source-sha256"),
  "utf8",
).catch(() => "");
const currentOverride = await readEnvironmentOverride();
const active =
  (await existsFile(launcher)) &&
  ready.every(Boolean) &&
  installedLauncherHash.trim() === launcherHash &&
  sameWindowsPath(currentOverride, launcher);

if (mode === "--check") {
  console.log(
    JSON.stringify({
      status: active ? "current" : "update_needed",
      stockVersion,
      activeExecutablePath: active ? stockExecutable : undefined,
      runtime: "stock_stdio_bridge",
    }),
  );
} else if (active) {
  console.log(
    JSON.stringify({
      status: "current",
      stockVersion,
      activeExecutablePath: stockExecutable,
      runtime: "stock_stdio_bridge",
    }),
  );
} else {
  const missingSources = [];
  for (const [source] of installedFiles) {
    if (!(await existsFile(source))) missingSources.push(source);
  }
  if (missingSources.length > 0) {
    throw new Error(`Desktop runtime files are missing: ${missingSources.join(", ")}`);
  }
  const installation = await execFileAsync(
    process.execPath,
    [join(scriptDirectory, "install-stock-bridge.mjs"), "--activate"],
    { windowsHide: true, timeout: 90_000 },
  );
  const result = JSON.parse(installation.stdout);
  if (result.status !== "activated" || !sameWindowsPath(result.launcherPath, launcher)) {
    throw new Error("The stable OmniCodex runtime was not activated");
  }
  console.log(
    JSON.stringify({
      status: "installed",
      stockVersion,
      activeExecutablePath: stockExecutable,
      runtime: "stock_stdio_bridge",
      restartRequired: true,
    }),
  );
}

async function readEnvironmentOverride() {
  const registry = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
  try {
    const queried = await execFileAsync(
      registry,
      ["query", "HKCU\\Environment", "/v", "CODEX_CLI_PATH"],
      { windowsHide: true, timeout: 5000 },
    );
    return /^\s*CODEX_CLI_PATH\s+REG_\w+\s+(.+)$/gmu.exec(queried.stdout)?.[1]?.trim();
  } catch (error) {
    if (error?.code === 1) return undefined;
    throw error;
  }
}

async function existsFile(path) {
  return (await stat(path).catch(() => undefined))?.isFile() === true;
}

async function sameFileBytes(source, target) {
  const [sourceBytes, targetBytes] = await Promise.all([
    readFile(source).catch(() => undefined),
    readFile(target).catch(() => undefined),
  ]);
  return sourceBytes !== undefined && targetBytes !== undefined && sourceBytes.equals(targetBytes);
}

function sameWindowsPath(left, right) {
  return (
    typeof left === "string" &&
    win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()
  );
}
