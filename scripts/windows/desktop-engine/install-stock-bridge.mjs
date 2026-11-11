import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const mode = process.argv[2];
if (process.platform !== "win32" || !["--stage", "--activate"].includes(mode)) {
  throw new Error("Usage on Windows: node install-stock-bridge.mjs --stage|--activate");
}
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const dataDirectory = join(
  process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
  "OmniCodex",
);
const installDirectory = join(dataDirectory, "bin");
const launcherPath = join(installDirectory, "OmniCodexDesktopEngine.exe");
const launcherSourceHashPath = join(installDirectory, "OmniCodexDesktopEngine.source-sha256");
const bridgePath = join(installDirectory, "stock-app-server-stdio.mjs");
const backupPath = join(installDirectory, "stock-bridge-environment-backup.json");
const rustSource = join(scriptDirectory, "stock-app-server-launcher.rs");
const bridgeSource = join(scriptDirectory, "stock-app-server-stdio.mjs");
const stockExecutableSource = join(scriptDirectory, "stock-codex-executable.mjs");
const distribution = resolve(scriptDirectory, "..", "..", "..", "dist");
const rustc = join(homedir(), ".cargo", "bin", "rustc.exe");
const registry = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
const icacls = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");

await mkdir(installDirectory, { recursive: true });
const sharedDirectory = join(
  process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  "shared-app-server",
);
if (!(await stat(sharedDirectory).catch(() => undefined))) {
  await mkdir(sharedDirectory, { recursive: true });
  const account = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  await execFileAsync(
    icacls,
    [sharedDirectory, "/inheritance:r", "/grant:r", `${account}:(OI)(CI)(F)`],
    {
      windowsHide: true,
      timeout: 5000,
    },
  );
}
const stagedLauncher = join(installDirectory, `OmniCodexDesktopEngine-${randomUUID()}.exe`);
try {
  const currentLauncher = await stat(launcherPath).catch(() => undefined);
  const launcherSourceHash = createHash("sha256")
    .update(await readFile(rustSource))
    .digest("hex");
  const installedSourceHash = await readFile(launcherSourceHashPath, "utf8").catch(() => "");
  if (currentLauncher === undefined || installedSourceHash.trim() !== launcherSourceHash) {
    await execFileAsync(
      rustc,
      [
        "--edition",
        "2021",
        "-C",
        "opt-level=z",
        "-C",
        "panic=abort",
        rustSource,
        "-o",
        stagedLauncher,
      ],
      {
        windowsHide: true,
        timeout: 45_000,
      },
    );
    await rename(stagedLauncher, launcherPath);
    await writeFile(launcherSourceHashPath, launcherSourceHash);
  }
  const stagedScript = `${bridgePath}.${randomUUID()}.tmp`;
  await copyFile(bridgeSource, stagedScript);
  await copyFile(stockExecutableSource, join(installDirectory, "stock-codex-executable.mjs"));
  const sourceHash = createHash("sha256")
    .update(await readFile(bridgeSource))
    .digest("hex");
  const stagedHash = createHash("sha256")
    .update(await readFile(stagedScript))
    .digest("hex");
  if (sourceHash !== stagedHash) throw new Error("Staged bridge script differs from source");
  for (const relativePath of [
    "application/policy-documentation-service.js",
    "application/protected-documentation-response.js",
    "domain/protected-policy-document.js",
    "infrastructure/safety/protected-policy-library.js",
    "infrastructure/runtime/stdio-app-server-router.js",
  ]) {
    const destination = join(installDirectory, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(distribution, relativePath), destination);
  }
  await rename(stagedScript, bridgePath);
  const version = (
    await execFileAsync(launcherPath, ["--version"], {
      windowsHide: true,
      timeout: 10_000,
    })
  ).stdout.trim();
  if (!/^codex-cli \d/u.test(version))
    throw new Error(`Stock engine version check failed: ${version}`);

  let previousValue;
  try {
    const queried = await execFileAsync(
      registry,
      ["query", "HKCU\\Environment", "/v", "CODEX_CLI_PATH"],
      {
        windowsHide: true,
        timeout: 5000,
      },
    );
    previousValue = /^\s*CODEX_CLI_PATH\s+REG_\w+\s+(.+)$/gmu.exec(queried.stdout)?.[1]?.trim();
  } catch (error) {
    if (error?.code !== 1) throw error;
  }
  if (mode === "--activate") {
    if (
      previousValue &&
      resolve(previousValue).toLowerCase() !== resolve(launcherPath).toLowerCase() &&
      !resolve(previousValue)
        .toLowerCase()
        .startsWith(`${resolve(dataDirectory, "engine-generations").toLowerCase()}\\`)
    ) {
      throw new Error(`CODEX_CLI_PATH belongs to another installation: ${previousValue}`);
    }
    if (!(await stat(backupPath).catch(() => undefined))) {
      await writeFile(
        backupPath,
        JSON.stringify({ schemaVersion: 1, previousValue: previousValue ?? null }),
        { flag: "wx" },
      );
    }
    await execFileAsync(
      registry,
      [
        "add",
        "HKCU\\Environment",
        "/v",
        "CODEX_CLI_PATH",
        "/t",
        "REG_SZ",
        "/d",
        launcherPath,
        "/f",
      ],
      {
        windowsHide: true,
        timeout: 5000,
      },
    );
    await execFileAsync(launcherPath, ["--broadcast-environment"], {
      windowsHide: true,
      timeout: 7000,
    });
  }
  console.log(
    JSON.stringify({
      status: mode === "--activate" ? "activated" : "staged",
      launcherPath,
      bridgePath,
      stockVersion: version,
      restartRequired: mode === "--activate",
    }),
  );
} finally {
  await rm(stagedLauncher, { force: true }).catch(() => undefined);
}
