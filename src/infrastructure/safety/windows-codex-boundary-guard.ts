import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  actionLedgerBlockers,
  type CodexSystemObservation,
  type DesktopProcessObservation,
  type PackageObservation,
  type ProtectedFileObservation,
} from "../../domain/non-interference.js";
import {
  HiddenChildProcessBoundary,
  type OwnedHiddenChildProcess,
} from "../windows/hidden-child-process.js";
import type { HashChainedActionLedger } from "./hash-chained-action-ledger.js";
import { observeProtectedFile } from "./protected-file-snapshot.js";

export interface CodexBoundarySnapshot {
  readonly observation: CodexSystemObservation;
  readonly actionLedger?: {
    readonly headSequence: number;
    readonly headHash: string;
  };
}

export interface CodexBoundaryGuard {
  capture(): Promise<CodexBoundarySnapshot>;
  assertUnchanged(baseline: CodexBoundarySnapshot): Promise<CodexBoundarySnapshot>;
}

export interface WindowsCodexBoundaryGuardOptions {
  readonly protectedTargets?: readonly { readonly logicalName: string; readonly path: string }[];
  readonly inspectWindows?: () => Promise<WindowsCodexInspection>;
  readonly readAuthState?: () => Promise<CodexSystemObservation["loginContinuity"]>;
  readonly childProcesses?: HiddenChildProcessBoundary;
  readonly systemRoot?: string;
  readonly timeoutMs?: number;
  readonly actionLedger?: HashChainedActionLedger;
}

export interface WindowsCodexInspection {
  readonly desktopProcesses: readonly DesktopProcessObservation[];
  readonly installedPackage?: PackageObservation;
  readonly appUsability: CodexSystemObservation["appUsability"];
}

interface RawWindowsInspection {
  readonly processes?: readonly {
    readonly processId?: unknown;
    readonly creationDate?: unknown;
    readonly executablePath?: unknown;
    readonly responding?: unknown;
  }[];
  readonly package?: {
    readonly packageFamilyName?: unknown;
    readonly fullName?: unknown;
    readonly version?: unknown;
    readonly installLocation?: unknown;
  } | null;
}

/**
 * Captures only read-only Codex desktop boundaries. The fixed PowerShell probe
 * runs through the central hidden child boundary and never reads command-line
 * arguments, environment secrets, or desktop window contents.
 */
export class WindowsCodexBoundaryGuard implements CodexBoundaryGuard {
  readonly #targets: readonly { readonly logicalName: string; readonly path: string }[];
  readonly #inspectWindows: () => Promise<WindowsCodexInspection>;
  readonly #readAuthState: () => Promise<CodexSystemObservation["loginContinuity"]>;
  readonly #actionLedger: HashChainedActionLedger | undefined;

  constructor(options: WindowsCodexBoundaryGuardOptions = {}) {
    const userHome = homedir();
    this.#targets = options.protectedTargets ?? [
      { logicalName: "codex-auth", path: join(userHome, ".codex", "auth.json") },
      { logicalName: "codex-config", path: join(userHome, ".codex", "config.toml") },
    ];
    const childProcesses = options.childProcesses ?? new HiddenChildProcessBoundary();
    this.#inspectWindows =
      options.inspectWindows ??
      (() =>
        inspectWindowsCodexBoundary(
          childProcesses,
          options.systemRoot ?? process.env.SystemRoot,
          options.timeoutMs,
        ));
    this.#readAuthState = options.readAuthState ?? (() => readCodexLoginContinuity(this.#targets));
    this.#actionLedger = options.actionLedger;
  }

  async capture(): Promise<CodexBoundarySnapshot> {
    await this.#actionLedger?.initialize();
    const [protectedFiles, windows, loginContinuity] = await Promise.all([
      Promise.all(this.#targets.map((target) => this.#observeProtectedTarget(target))),
      this.#inspectWindows(),
      this.#readLoginContinuity(),
    ]);
    const unverifiable = protectedFiles.filter((file) => file.status === "unverifiable");
    if (unverifiable.length > 0) {
      throw new Error(
        `CODEX_BOUNDARY_UNVERIFIABLE:${unverifiable.map((file) => file.logicalName).join(",")}`,
      );
    }
    const ledger = await this.#actionLedger?.readHead();
    if (ledger !== undefined) {
      if (ledger.integrity !== "valid") {
        throw new Error(`CODEX_ACTION_LEDGER_INVALID:${ledger.integrityError ?? "unknown"}`);
      }
      const blockers = actionLedgerBlockers(ledger.records);
      if (blockers.length > 0) {
        throw new Error(`CODEX_ACTION_LEDGER_BLOCKED:${blockers[0]?.code ?? "unknown"}`);
      }
    }
    return {
      observation: {
        observedAtUnixMs: Date.now(),
        protectedFiles: sortProtectedFiles(protectedFiles),
        desktopProcesses: sortDesktopProcesses(windows.desktopProcesses),
        ...(windows.installedPackage === undefined
          ? {}
          : { installedPackage: windows.installedPackage }),
        loginContinuity,
        appUsability: windows.appUsability,
      },
      ...(ledger === undefined
        ? {}
        : { actionLedger: { headSequence: ledger.headSequence, headHash: ledger.headHash } }),
    };
  }

  async assertUnchanged(baseline: CodexBoundarySnapshot): Promise<CodexBoundarySnapshot> {
    const current = await this.capture();
    if (!preservesCodexContinuity(baseline.observation, current.observation)) {
      throw new Error("CODEX_BOUNDARY_CHANGED:protected Codex state changed during runtime start");
    }
    if (baseline.actionLedger !== undefined && this.#actionLedger !== undefined) {
      const actions = await this.#actionLedger.readAfter(baseline.actionLedger.headSequence);
      if (
        actions.integrity !== "valid" ||
        actions.anchorSequence !== baseline.actionLedger.headSequence ||
        actions.anchorHash !== baseline.actionLedger.headHash
      ) {
        throw new Error("CODEX_ACTION_LEDGER_INVALID:baseline anchor changed");
      }
      const blockers = actionLedgerBlockers(actions.records);
      if (blockers.length > 0) {
        throw new Error(`CODEX_ACTION_LEDGER_BLOCKED:${blockers[0]?.code ?? "unknown"}`);
      }
    }
    return current;
  }

  async #observeProtectedTarget(target: {
    readonly logicalName: string;
    readonly path: string;
  }): Promise<ProtectedFileObservation> {
    const operation = await this.#actionLedger?.begin({
      kind: "protected_path_access",
      effect: "read",
      targetClass: target.logicalName,
      targetFingerprint: pathFingerprint(target.path),
    });
    try {
      const observation = await observeProtectedFile(target);
      await operation?.complete({ outcomeCode: observation.status.toUpperCase() });
      return observation;
    } catch (error) {
      await operation?.fail({ outcomeCode: "READ_FAILED" });
      throw error;
    }
  }

  async #readLoginContinuity(): Promise<CodexSystemObservation["loginContinuity"]> {
    const authTarget = this.#targets.find((target) => target.logicalName === "codex-auth");
    const operation = await this.#actionLedger?.begin({
      kind: "protected_path_access",
      effect: "read",
      targetClass: "codex-auth-login-continuity",
      targetFingerprint: pathFingerprint(authTarget?.path ?? "codex-auth-unavailable"),
    });
    try {
      const result = await this.#readAuthState();
      await operation?.complete({ outcomeCode: result.toUpperCase() });
      return result;
    } catch (error) {
      await operation?.fail({ outcomeCode: "READ_FAILED" });
      throw error;
    }
  }
}

function pathFingerprint(path: string): string {
  return createHash("sha256")
    .update(resolve(path).toLocaleLowerCase("en-US"), "utf8")
    .digest("hex");
}

async function readCodexLoginContinuity(
  targets: readonly { readonly logicalName: string; readonly path: string }[],
): Promise<CodexSystemObservation["loginContinuity"]> {
  const authPath = targets.find((target) => target.logicalName === "codex-auth")?.path;
  if (authPath === undefined) return "unknown";
  let value: unknown;
  try {
    value = JSON.parse(await readFile(authPath, "utf8"));
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "unauthenticated" : "unknown";
  }
  if (!isObject(value) || !isObject(value.tokens)) return "unknown";
  return typeof value.tokens.refresh_token === "string" &&
    value.tokens.refresh_token.length >= 16 &&
    typeof value.tokens.account_id === "string" &&
    value.tokens.account_id.length > 0
    ? "authenticated"
    : "unknown";
}

async function inspectWindowsCodexBoundary(
  childProcesses: HiddenChildProcessBoundary,
  systemRoot: string | undefined,
  timeoutMs: number | undefined,
): Promise<WindowsCodexInspection> {
  if (process.platform !== "win32") {
    return { desktopProcesses: [], appUsability: "unknown" };
  }
  if (systemRoot === undefined || systemRoot.length === 0) {
    throw new Error("CODEX_BOUNDARY_UNVERIFIABLE:SystemRoot");
  }
  const executable = join(
    resolve(systemRoot),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const encodedScript = Buffer.from(windowsInspectionScript, "utf16le").toString("base64");
  const child = childProcesses.spawnHidden(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      encodedScript,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
      },
    },
  );
  const raw = await collectInspection(childProcesses, child, timeoutMs);
  return parseWindowsInspection(raw);
}

function collectInspection(
  childProcesses: HiddenChildProcessBoundary,
  child: OwnedHiddenChildProcess,
  timeoutMs: number | undefined,
): Promise<unknown> {
  return new Promise((resolveInspection, rejectInspection) => {
    let settled = false;
    let stdout = "";
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cancelTimeout();
      if (error !== undefined) rejectInspection(error);
      else {
        try {
          resolveInspection(JSON.parse(stdout));
        } catch {
          rejectInspection(new Error("CODEX_BOUNDARY_UNVERIFIABLE:invalid inspection JSON"));
        }
      }
    };
    const cancelTimeout = scheduleOptionalTimeout(timeoutMs, () => {
      childProcesses.terminateOwnedHiddenChild(child);
      finish(new Error("CODEX_BOUNDARY_UNVERIFIABLE:inspection timeout"));
    });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.once("error", () => finish(new Error("CODEX_BOUNDARY_UNVERIFIABLE:probe start")));
    child.once("close", (code) => {
      if (code !== 0) finish(new Error("CODEX_BOUNDARY_UNVERIFIABLE:probe failure"));
      else finish();
    });
  });
}

function scheduleOptionalTimeout(timeoutMs: number | undefined, expire: () => void): () => void {
  if (timeoutMs === undefined) return () => undefined;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("CODEX_BOUNDARY_UNVERIFIABLE:invalid inspection timeout");
  }
  const deadline = BigInt(Date.now()) + BigInt(timeoutMs);
  const maximumTimerDelayMs = 2_147_483_647n;
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  const arm = (): void => {
    if (cancelled) return;
    const remainingMs = deadline - BigInt(Date.now());
    if (remainingMs <= 0n) {
      expire();
      return;
    }
    timer = setTimeout(
      arm,
      Number(remainingMs > maximumTimerDelayMs ? maximumTimerDelayMs : remainingMs),
    );
  };
  arm();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

function parseWindowsInspection(value: unknown): WindowsCodexInspection {
  if (!isObject(value)) throw new Error("CODEX_BOUNDARY_UNVERIFIABLE:inspection shape");
  const raw = value as RawWindowsInspection;
  const rawProcesses = raw.processes ?? [];
  if (!Array.isArray(rawProcesses)) {
    throw new Error("CODEX_BOUNDARY_UNVERIFIABLE:process shape");
  }
  const packageObservation = parsePackage(raw.package);
  const desktopProcesses = rawProcesses.map((item) => {
    if (
      !isObject(item) ||
      typeof item.processId !== "number" ||
      !Number.isSafeInteger(item.processId) ||
      item.processId <= 0 ||
      typeof item.executablePath !== "string" ||
      item.executablePath.length === 0
    ) {
      throw new Error("CODEX_BOUNDARY_UNVERIFIABLE:process record");
    }
    const startedAtUnixMs =
      typeof item.creationDate === "string" ? Date.parse(item.creationDate) : Number.NaN;
    return {
      pid: item.processId,
      ...(Number.isFinite(startedAtUnixMs) ? { startedAtUnixMs } : {}),
      executableFingerprint: sha256(normalizeWindowsPath(item.executablePath)),
      ...(packageObservation === undefined
        ? {}
        : { packageIdentity: packageObservation.packageFamilyName }),
    } satisfies DesktopProcessObservation;
  });
  const responding = rawProcesses.map((item) => item.responding);
  const appUsability =
    responding.length === 0
      ? "unknown"
      : responding.every((value) => value === true)
        ? "usable"
        : "unusable";
  return {
    desktopProcesses: sortDesktopProcesses(desktopProcesses),
    ...(packageObservation === undefined ? {} : { installedPackage: packageObservation }),
    appUsability,
  };
}

function parsePackage(value: RawWindowsInspection["package"]): PackageObservation | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !isObject(value) ||
    typeof value.packageFamilyName !== "string" ||
    value.packageFamilyName.length === 0 ||
    typeof value.fullName !== "string" ||
    value.fullName.length === 0 ||
    typeof value.version !== "string" ||
    value.version.length === 0 ||
    typeof value.installLocation !== "string" ||
    value.installLocation.length === 0
  ) {
    throw new Error("CODEX_BOUNDARY_UNVERIFIABLE:package record");
  }
  return {
    packageFamilyName: value.packageFamilyName,
    fullName: value.fullName,
    version: value.version,
    installLocationFingerprint: sha256(normalizeWindowsPath(value.installLocation)),
  };
}

function preservesCodexContinuity(
  baseline: CodexSystemObservation,
  current: CodexSystemObservation,
): boolean {
  if (baseline.loginContinuity !== current.loginContinuity) return false;
  if (baseline.appUsability === "usable" && current.appUsability === "unusable") return false;
  if (baseline.desktopProcesses.length > 0 && current.desktopProcesses.length === 0) return false;
  const baselinePackage = baseline.installedPackage;
  const currentPackage = current.installedPackage;
  if ((baselinePackage === undefined) !== (currentPackage === undefined)) return false;
  if (baselinePackage !== undefined && currentPackage !== undefined) {
    if (baselinePackage.packageFamilyName !== currentPackage.packageFamilyName) return false;
    if (baselinePackage.installLocationFingerprint !== currentPackage.installLocationFingerprint) {
      return false;
    }
  }
  return true;
}

function sortProtectedFiles(
  values: readonly ProtectedFileObservation[],
): readonly ProtectedFileObservation[] {
  return [...values].sort(
    (left, right) =>
      left.logicalName.localeCompare(right.logicalName, "en-US") ||
      left.canonicalPath.localeCompare(right.canonicalPath, "en-US"),
  );
}

function sortDesktopProcesses(
  values: readonly DesktopProcessObservation[],
): readonly DesktopProcessObservation[] {
  return [...values].sort(
    (left, right) =>
      left.pid - right.pid || (left.startedAtUnixMs ?? 0) - (right.startedAtUnixMs ?? 0),
  );
}

function normalizeWindowsPath(value: string): string {
  return resolve(value).replaceAll("/", "\\").toLocaleLowerCase("en-US");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const windowsInspectionScript = `
$ErrorActionPreference = 'Stop'
$package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue |
  Sort-Object Version -Descending |
  Select-Object -First 1
$installLocation = if ($null -eq $package) { $null } else { [string]$package.InstallLocation }
$processes = @()
if (-not [string]::IsNullOrWhiteSpace($installLocation)) {
  $processes = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" |
    Where-Object {
      -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
      $_.ExecutablePath.StartsWith($installLocation, [StringComparison]::OrdinalIgnoreCase) -and
      ($_.CommandLine -notmatch '(?i)(^|\\s)--type=')
    } |
    ForEach-Object {
      $live = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
      [pscustomobject]@{
        processId = [int]$_.ProcessId
        creationDate = if ($null -eq $_.CreationDate) { $null } else { ([datetime]$_.CreationDate).ToUniversalTime().ToString('o') }
        executablePath = [string]$_.ExecutablePath
        responding = if ($null -eq $live) { $false } else { [bool]$live.Responding }
      }
    })
}
$packageRecord = if ($null -eq $package) {
  $null
} else {
  [pscustomobject]@{
    packageFamilyName = [string]$package.PackageFamilyName
    fullName = [string]$package.PackageFullName
    version = [string]$package.Version
    installLocation = [string]$package.InstallLocation
  }
}
[Console]::Out.Write(([pscustomobject]@{
  processes = $processes
  package = $packageRecord
} | ConvertTo-Json -Compress -Depth 5))
`;
