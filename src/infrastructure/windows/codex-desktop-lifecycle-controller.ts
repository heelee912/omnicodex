import { join, resolve } from "node:path";
import {
  HiddenChildProcessBoundary,
  type OwnedHiddenChildProcess,
} from "./hidden-child-process.js";

export interface CodexDesktopLifecycleBoundary {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly deadlineUnixMs?: number;
}

export interface CodexDesktopProcessStatus {
  readonly pid: number;
  readonly responding: boolean;
  readonly startedAtIso?: string;
}

export interface CodexDesktopStatus {
  readonly installed: boolean;
  readonly running: boolean;
  readonly responding: boolean;
  readonly nativeToolsReady: boolean;
  readonly packageFamilyName?: string;
  readonly packageFullName?: string;
  readonly version?: string;
  readonly processes: readonly CodexDesktopProcessStatus[];
}

export interface CodexDesktopLifecycleResult {
  readonly disposition: "already_running" | "launched" | "restarted";
  readonly before: CodexDesktopStatus;
  readonly after: CodexDesktopStatus;
}

export interface CodexDesktopLifecycleControllerLike {
  status(boundary?: CodexDesktopLifecycleBoundary): Promise<CodexDesktopStatus>;
  ensureRunning(boundary?: CodexDesktopLifecycleBoundary): Promise<CodexDesktopLifecycleResult>;
  restart(boundary?: CodexDesktopLifecycleBoundary): Promise<CodexDesktopLifecycleResult>;
}

interface InstalledCodexDesktop {
  readonly packageFamilyName: string;
  readonly packageFullName: string;
  readonly version: string;
  readonly installLocation: string;
  readonly appUserModelId: string;
  readonly processes: readonly CodexDesktopProcessStatus[];
}

export interface CodexDesktopLifecycleControllerOptions {
  /** Enable the loopback-only passive Chat event transport on operator launches. */
  readonly enableChatEvents?: boolean;
  readonly childProcesses?: HiddenChildProcessBoundary;
  readonly systemRoot?: string;
  readonly inspect?: (
    boundary: CodexDesktopLifecycleBoundary,
  ) => Promise<InstalledCodexDesktop | undefined>;
  readonly requestGracefulClose?: (
    installed: InstalledCodexDesktop,
    boundary: CodexDesktopLifecycleBoundary,
  ) => Promise<void>;
  readonly requestLaunch?: (
    installed: InstalledCodexDesktop,
    boundary: CodexDesktopLifecycleBoundary,
  ) => Promise<void>;
  readonly nativeToolsReady?: (boundary: CodexDesktopLifecycleBoundary) => Promise<boolean>;
}

/**
 * Owns the Codex Desktop lifecycle outside the Desktop-owned Computer Use pipe.
 * A remote caller can therefore complete a restart without destroying the
 * only relaunch channel. Login/configuration files are never read or written.
 */
export class CodexDesktopLifecycleController implements CodexDesktopLifecycleControllerLike {
  readonly #childProcesses: HiddenChildProcessBoundary;
  readonly #systemRoot: string | undefined;
  readonly #inspectOverride: CodexDesktopLifecycleControllerOptions["inspect"];
  readonly #closeOverride: CodexDesktopLifecycleControllerOptions["requestGracefulClose"];
  readonly #launchOverride: CodexDesktopLifecycleControllerOptions["requestLaunch"];
  readonly #nativeToolsReady: CodexDesktopLifecycleControllerOptions["nativeToolsReady"];
  readonly #enableChatEvents: boolean;
  #transitionTail: Promise<void> = Promise.resolve();

  constructor(options: CodexDesktopLifecycleControllerOptions = {}) {
    this.#childProcesses = options.childProcesses ?? new HiddenChildProcessBoundary();
    this.#systemRoot = options.systemRoot ?? process.env.SystemRoot;
    this.#inspectOverride = options.inspect;
    this.#closeOverride = options.requestGracefulClose;
    this.#launchOverride = options.requestLaunch;
    this.#nativeToolsReady = options.nativeToolsReady;
    this.#enableChatEvents = options.enableChatEvents ?? false;
  }

  async status(boundary: CodexDesktopLifecycleBoundary = {}): Promise<CodexDesktopStatus> {
    const normalized = normalizeBoundary(boundary);
    const installed = await this.#inspect(normalized);
    if (installed === undefined) return absentStatus();
    const responding =
      installed.processes.length > 0 && installed.processes.every((process) => process.responding);
    let nativeToolsReady = false;
    if (responding && this.#nativeToolsReady !== undefined) {
      try {
        nativeToolsReady = await this.#nativeToolsReady(normalized);
      } catch (error) {
        if (normalized.signal?.aborted || boundaryExpired(normalized)) throw error;
      }
    }
    return publicStatus(installed, nativeToolsReady);
  }

  ensureRunning(
    boundary: CodexDesktopLifecycleBoundary = {},
  ): Promise<CodexDesktopLifecycleResult> {
    return this.#serialize(async () => {
      const normalized = normalizeBoundary(boundary);
      const installed = await this.#requireInstalled(normalized);
      const before = publicStatus(installed, false);
      if (installed.processes.length === 0) {
        await this.#requestLaunch(installed, normalized);
        const after = await this.#waitUntilReady(installed.packageFullName, normalized);
        return { disposition: "launched", before, after };
      }
      if (!installed.processes.every((process) => process.responding)) {
        throw new Error(
          "CODEX_DESKTOP_UNRESPONSIVE: use the atomic restart action; do not close the app with Computer Use",
        );
      }
      const after = await this.#waitUntilReady(installed.packageFullName, normalized);
      return { disposition: "already_running", before, after };
    });
  }

  restart(boundary: CodexDesktopLifecycleBoundary = {}): Promise<CodexDesktopLifecycleResult> {
    return this.#serialize(async () => {
      const normalized = normalizeBoundary(boundary);
      const installed = await this.#requireInstalled(normalized);
      const before = publicStatus(installed, false);
      if (installed.processes.length > 0) {
        await this.#requestGracefulClose(installed, normalized);
        await this.#waitUntilStopped(installed, normalized);
      }
      const current = await this.#requireInstalled(normalized);
      if (current.packageFullName !== installed.packageFullName) {
        throw new Error("CODEX_DESKTOP_PACKAGE_CHANGED_DURING_RESTART");
      }
      await this.#requestLaunch(current, normalized);
      const after = await this.#waitUntilReady(current.packageFullName, normalized);
      return {
        disposition: before.running ? "restarted" : "launched",
        before,
        after,
      };
    });
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#transitionTail;
    let release!: () => void;
    this.#transitionTail = new Promise<void>((resolveTransition) => {
      release = resolveTransition;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #requireInstalled(boundary: CodexDesktopLifecycleBoundary): Promise<InstalledCodexDesktop> {
    const installed = await this.#inspect(boundary);
    if (installed === undefined) throw new Error("CODEX_DESKTOP_NOT_INSTALLED");
    return installed;
  }

  #inspect(boundary: CodexDesktopLifecycleBoundary): Promise<InstalledCodexDesktop | undefined> {
    throwIfBoundaryElapsed(boundary);
    if (this.#inspectOverride !== undefined) return this.#inspectOverride(boundary);
    return this.#runPowerShellJson<unknown>(
      WINDOWS_CODEX_DESKTOP_INSPECTION_SCRIPT,
      {},
      boundary,
    ).then(parseInstalledCodexDesktop);
  }

  #requestGracefulClose(
    installed: InstalledCodexDesktop,
    boundary: CodexDesktopLifecycleBoundary,
  ): Promise<void> {
    throwIfBoundaryElapsed(boundary);
    if (this.#closeOverride !== undefined) return this.#closeOverride(installed, boundary);
    return this.#runPowerShellJson<{ requested: readonly number[]; rejected: readonly number[] }>(
      WINDOWS_CODEX_DESKTOP_CLOSE_SCRIPT,
      {
        packageFullName: installed.packageFullName,
        installLocation: installed.installLocation,
        processIds: installed.processes.map((process) => process.pid),
      },
      boundary,
    ).then((result) => {
      if (result.rejected.length > 0) {
        throw new Error(`CODEX_DESKTOP_GRACEFUL_CLOSE_REJECTED:${result.rejected.join(",")}`);
      }
    });
  }

  #requestLaunch(
    installed: InstalledCodexDesktop,
    boundary: CodexDesktopLifecycleBoundary,
  ): Promise<void> {
    throwIfBoundaryElapsed(boundary);
    if (this.#launchOverride !== undefined) return this.#launchOverride(installed, boundary);
    return this.#runPowerShellJson<{ requested: boolean }>(
      WINDOWS_CODEX_DESKTOP_LAUNCH_SCRIPT,
      {
        packageFullName: installed.packageFullName,
        appUserModelId: installed.appUserModelId,
        enableChatEvents: this.#enableChatEvents,
      },
      boundary,
    ).then((result) => {
      if (result.requested !== true) throw new Error("CODEX_DESKTOP_LAUNCH_REJECTED");
    });
  }

  async #waitUntilStopped(
    before: InstalledCodexDesktop,
    boundary: CodexDesktopLifecycleBoundary,
  ): Promise<void> {
    const expectedPids = new Set(before.processes.map((process) => process.pid));
    for (;;) {
      throwIfBoundaryElapsed(boundary);
      const current = await this.#inspect(boundary);
      if (
        current === undefined ||
        current.processes.every((process) => !expectedPids.has(process.pid))
      ) {
        return;
      }
      await cancellableDelay(200, boundary);
    }
  }

  async #waitUntilReady(
    packageFullName: string,
    boundary: CodexDesktopLifecycleBoundary,
  ): Promise<CodexDesktopStatus> {
    for (;;) {
      throwIfBoundaryElapsed(boundary);
      const current = await this.#requireInstalled(boundary);
      if (current.packageFullName !== packageFullName) {
        throw new Error("CODEX_DESKTOP_PACKAGE_CHANGED_DURING_START");
      }
      if (
        current.processes.length > 0 &&
        current.processes.every((process) => process.responding)
      ) {
        const nativeToolsReady =
          this.#nativeToolsReady === undefined
            ? true
            : await this.#nativeToolsReady(boundary).catch((error: unknown) => {
                if (boundary.signal?.aborted || boundaryExpired(boundary)) throw error;
                return false;
              });
        if (nativeToolsReady) return publicStatus(current, true);
      }
      await cancellableDelay(250, boundary);
    }
  }

  async #runPowerShellJson<T>(
    script: string,
    input: unknown,
    boundary: CodexDesktopLifecycleBoundary,
  ): Promise<T> {
    if (process.platform !== "win32") throw new Error("CODEX_DESKTOP_LIFECYCLE_WINDOWS_REQUIRED");
    if (this.#systemRoot === undefined || this.#systemRoot.length === 0) {
      throw new Error("CODEX_DESKTOP_LIFECYCLE_SYSTEMROOT_REQUIRED");
    }
    throwIfBoundaryElapsed(boundary);
    const executable = join(
      resolve(this.#systemRoot),
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const child = this.#childProcesses.spawnHidden(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        // A directly launched desktop inherits this helper's environment.
        // Preserve the operator environment (PATH, user profile, app data,
        // native runtime settings) rather than launching a crippled tool host.
        env:
          script === WINDOWS_CODEX_DESKTOP_LAUNCH_SCRIPT
            ? process.env
            : {
                SystemRoot: process.env.SystemRoot,
                WINDIR: process.env.WINDIR,
                TEMP: process.env.TEMP,
                TMP: process.env.TMP,
              },
      },
    );
    if (child.stdin === null) throw new Error("CODEX_DESKTOP_LIFECYCLE_STDIN_UNAVAILABLE");
    child.stdin.end(JSON.stringify(input), "utf8");
    return collectPowerShellJson<T>(this.#childProcesses, child, boundary);
  }
}

function publicStatus(
  installed: InstalledCodexDesktop,
  nativeToolsReady: boolean,
): CodexDesktopStatus {
  const processes = Object.freeze(
    installed.processes.map((process) => Object.freeze({ ...process })),
  );
  return Object.freeze({
    installed: true,
    running: processes.length > 0,
    responding: processes.length > 0 && processes.every((process) => process.responding),
    nativeToolsReady,
    packageFamilyName: installed.packageFamilyName,
    packageFullName: installed.packageFullName,
    version: installed.version,
    processes,
  });
}

function absentStatus(): CodexDesktopStatus {
  return Object.freeze({
    installed: false,
    running: false,
    responding: false,
    nativeToolsReady: false,
    processes: Object.freeze([]),
  });
}

function parseInstalledCodexDesktop(value: unknown): InstalledCodexDesktop | undefined {
  if (value === null || value === undefined) return undefined;
  if (!isObject(value)) throw new Error("CODEX_DESKTOP_LIFECYCLE_INVALID_INSPECTION");
  const required = [
    "packageFamilyName",
    "packageFullName",
    "version",
    "installLocation",
    "appUserModelId",
  ] as const;
  for (const key of required) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error(`CODEX_DESKTOP_LIFECYCLE_INVALID_${key}`);
    }
  }
  if (!Array.isArray(value.processes)) {
    throw new Error("CODEX_DESKTOP_LIFECYCLE_INVALID_PROCESSES");
  }
  const processes = value.processes.map((processValue) => {
    if (
      !isObject(processValue) ||
      !Number.isSafeInteger(processValue.pid) ||
      Number(processValue.pid) <= 0 ||
      typeof processValue.responding !== "boolean"
    ) {
      throw new Error("CODEX_DESKTOP_LIFECYCLE_INVALID_PROCESS");
    }
    return Object.freeze({
      pid: Number(processValue.pid),
      responding: processValue.responding,
      ...(typeof processValue.startedAtIso === "string"
        ? { startedAtIso: processValue.startedAtIso }
        : {}),
    });
  });
  return Object.freeze({
    packageFamilyName: value.packageFamilyName as string,
    packageFullName: value.packageFullName as string,
    version: value.version as string,
    installLocation: value.installLocation as string,
    appUserModelId: value.appUserModelId as string,
    processes: Object.freeze(processes),
  });
}

function normalizeBoundary(boundary: CodexDesktopLifecycleBoundary): CodexDesktopLifecycleBoundary {
  const timeoutMs = optionalPositiveInteger(boundary.timeoutMs, "timeoutMs");
  const explicitDeadline = optionalPositiveInteger(boundary.deadlineUnixMs, "deadlineUnixMs");
  const timeoutDeadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  const deadlineUnixMs =
    explicitDeadline === undefined
      ? timeoutDeadline
      : timeoutDeadline === undefined
        ? explicitDeadline
        : Math.min(explicitDeadline, timeoutDeadline);
  return {
    ...(boundary.signal === undefined ? {} : { signal: boundary.signal }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(deadlineUnixMs === undefined ? {} : { deadlineUnixMs }),
  };
}

function boundaryExpired(boundary: CodexDesktopLifecycleBoundary): boolean {
  return boundary.deadlineUnixMs !== undefined && Date.now() >= boundary.deadlineUnixMs;
}

function throwIfBoundaryElapsed(boundary: CodexDesktopLifecycleBoundary): void {
  if (boundary.signal?.aborted) throw abortReason(boundary.signal);
  if (boundaryExpired(boundary)) throw new Error("CODEX_DESKTOP_LIFECYCLE_DEADLINE_EXCEEDED");
}

function cancellableDelay(delayMs: number, boundary: CodexDesktopLifecycleBoundary): Promise<void> {
  throwIfBoundaryElapsed(boundary);
  const remaining =
    boundary.deadlineUnixMs === undefined
      ? delayMs
      : Math.min(delayMs, Math.max(1, boundary.deadlineUnixMs - Date.now()));
  return new Promise<void>((resolveDelay, rejectDelay) => {
    const signal = boundary.signal;
    const timer = setTimeout(finish, remaining);
    const abort = () => {
      clearTimeout(timer);
      rejectDelay(signal === undefined ? new Error("Aborted") : abortReason(signal));
    };
    function finish(): void {
      signal?.removeEventListener("abort", abort);
      try {
        throwIfBoundaryElapsed(boundary);
        resolveDelay();
      } catch (error) {
        rejectDelay(error);
      }
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function collectPowerShellJson<T>(
  boundaryOwner: HiddenChildProcessBoundary,
  child: OwnedHiddenChildProcess,
  boundary: CodexDesktopLifecycleBoundary,
): Promise<T> {
  return new Promise<T>((resolveResult, rejectResult) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    const signal = boundary.signal;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) {
        Object.assign(error, { stdout, stderr });
        rejectResult(error);
        return;
      }
      try {
        resolveResult(JSON.parse(stdout) as T);
      } catch (cause) {
        rejectResult(
          Object.assign(new Error("CODEX_DESKTOP_LIFECYCLE_INVALID_JSON", { cause }), {
            stdout,
            stderr,
          }),
        );
      }
    };
    const abort = () => {
      boundaryOwner.terminateOwnedHiddenChild(child);
      finish(signal === undefined ? new Error("Aborted") : abortReason(signal));
    };
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (!settled) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (!settled) stderr += chunk.toString();
    });
    child.once("error", (cause) =>
      finish(new Error("CODEX_DESKTOP_LIFECYCLE_HELPER_START_FAILED", { cause })),
    );
    child.once("close", (code, closeSignal) => {
      if (code === 0) finish();
      else
        finish(
          new Error(`CODEX_DESKTOP_LIFECYCLE_HELPER_FAILED:${String(code)}:${String(closeSignal)}`),
        );
    });
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (boundary.deadlineUnixMs !== undefined) {
      timer = setTimeout(abort, Math.max(1, boundary.deadlineUnixMs - Date.now()));
    }
  });
}

function optionalPositiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Aborted");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const WINDOWS_CODEX_DESKTOP_INSPECTION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue |
  Sort-Object Version -Descending |
  Select-Object -First 1
if ($null -eq $package) {
  [Console]::Out.Write('null')
  exit 0
}
$installLocation = [string]$package.InstallLocation
$family = [string]$package.PackageFamilyName
$processes = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" |
  Where-Object {
    -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
    $_.ExecutablePath.StartsWith($installLocation, [StringComparison]::OrdinalIgnoreCase) -and
    ($_.CommandLine -notmatch '(?i)(^|\s)--type=')
  } |
  ForEach-Object {
    $live = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    [pscustomobject]@{
      pid = [int]$_.ProcessId
      responding = if ($null -eq $live) { $false } else { [bool]$live.Responding }
      startedAtIso = if ($null -eq $_.CreationDate) { $null } else { ([datetime]$_.CreationDate).ToUniversalTime().ToString('o') }
    }
  })
[Console]::Out.Write(([pscustomobject]@{
  packageFamilyName = $family
  packageFullName = [string]$package.PackageFullName
  version = [string]$package.Version
  installLocation = $installLocation
  appUserModelId = "$family!App"
  processes = $processes
} | ConvertTo-Json -Compress -Depth 5))
`;

const WINDOWS_CODEX_DESKTOP_CLOSE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$inputValue = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class OmniCodexDesktopShutdown {
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public uint pid; public System.Runtime.InteropServices.ComTypes.FILETIME start; }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint handle, uint flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint files, string[] names, uint applications, UniqueProcess[] processes, uint services, string[] serviceNames);
  [DllImport("rstrtmgr.dll")] static extern int RmShutdown(uint handle, uint flags, IntPtr callback);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
  public static int Close(uint pid, long start) {
    uint handle; int code=RmStartSession(out handle, 0, new StringBuilder(33));
    if(code!=0) return code;
    try {
      var process=new UniqueProcess { pid=pid, start=new System.Runtime.InteropServices.ComTypes.FILETIME { dwLowDateTime=(int)(start & 0xffffffff), dwHighDateTime=(int)(start >> 32) } };
      code=RmRegisterResources(handle,0,null,1,new[]{process},0,null);
      return code!=0 ? code : RmShutdown(handle,0,IntPtr.Zero);
    } finally { RmEndSession(handle); }
  }
}
'@
$package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop |
  Sort-Object Version -Descending |
  Select-Object -First 1
if ([string]$package.PackageFullName -ne [string]$inputValue.packageFullName -or
    [string]$package.InstallLocation -ne [string]$inputValue.installLocation) {
  throw 'Codex package identity changed before graceful close'
}
$expected = @($inputValue.processIds | ForEach-Object { [int]$_ })
$requested = @()
$rejected = @()
foreach ($pidValue in $expected) {
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
  if ($null -eq $cim) { continue }
  if (-not ([string]$cim.ExecutablePath).StartsWith([string]$package.InstallLocation, [StringComparison]::OrdinalIgnoreCase)) {
    $rejected += $pidValue
    continue
  }
  $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if ($null -eq $process) { continue }
  # Window close can leave Electron alive without a window. Ask Windows to end
  # this exact process (PID + creation time), without forced termination.
  $shutdownStatus = [OmniCodexDesktopShutdown]::Close([uint32]$pidValue, $process.StartTime.ToUniversalTime().ToFileTimeUtc())
  if ($shutdownStatus -ne 0) {
    $rejected += $pidValue
  } else {
    $requested += $pidValue
  }
}
[Console]::Out.Write(([pscustomobject]@{ requested = $requested; rejected = $rejected } |
  ConvertTo-Json -Compress -Depth 3))
`;

const WINDOWS_CODEX_DESKTOP_LAUNCH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$inputValue = [Console]::In.ReadToEnd() | ConvertFrom-Json
$package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop |
  Sort-Object Version -Descending |
  Select-Object -First 1
if ([string]$package.PackageFullName -ne [string]$inputValue.packageFullName) {
  throw 'Codex package identity changed before launch'
}
if ($inputValue.enableChatEvents -eq $true) {
  $packageRoot = [IO.Path]::GetFullPath([string]$package.InstallLocation)
  $executable = [IO.Path]::GetFullPath((Join-Path $packageRoot 'app\ChatGPT.exe'))
  if (-not $executable.StartsWith($packageRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
      -not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw 'CODEX_DESKTOP_PACKAGE_EXECUTABLE_INVALID'
  }
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally { $listener.Stop() }
  Start-Process -FilePath $executable -ArgumentList @("--remote-debugging-port=$port", '--remote-debugging-address=127.0.0.1') -WindowStyle Hidden
} else {
  $explorer = Join-Path $env:WINDIR 'explorer.exe'
  Start-Process -FilePath $explorer -ArgumentList @("shell:AppsFolder\$([string]$inputValue.appUserModelId)") -WindowStyle Hidden
}
[Console]::Out.Write('{"requested":true}')
`;
