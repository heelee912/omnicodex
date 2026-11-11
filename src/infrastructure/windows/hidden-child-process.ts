import { type ChildProcess, execFileSync, type SpawnOptions, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ActionEffect, ActionKind, ActionRecord } from "../../domain/non-interference.js";
import { canonicalJson } from "../safety/canonical-json.js";

export type HiddenSpawnOptions = Omit<SpawnOptions, "shell" | "windowsHide">;

const ownedHiddenChildBrand: unique symbol = Symbol("omnicodex.owned-hidden-child");

export interface HiddenChildOwnership {
  readonly nonce: string;
  readonly executable: string;
  readonly spawnedAtUnixMs: number;
  readonly pid?: number;
}

export interface RecoveredWindowsProcessIdentity {
  readonly pid: number;
  readonly parentPid: number;
  readonly name: string;
  readonly executablePath: string;
  readonly commandLine: string;
  readonly startedAtIso: string;
}

export interface WindowsProcessBoundaryOptions {
  readonly systemRoot?: string;
  readonly timeoutMs?: number;
}

/**
 * A child returned by the one permitted spawn boundary. The native `kill`
 * method is intentionally hidden so callers must pass the exact handle back
 * through the ownership-checking termination boundary.
 */
export type OwnedHiddenChildProcess = Omit<ChildProcess, "kill"> & {
  readonly ownership: HiddenChildOwnership;
  readonly [ownedHiddenChildBrand]: true;
};

export type HiddenSpawnImplementation = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

interface OwnershipRecord {
  readonly metadata: HiddenChildOwnership;
  active: boolean;
}

interface StoredActionRecord extends ActionRecord {
  readonly previousHash: string;
  readonly entryHash: string;
}

interface SynchronousActionOperation {
  complete(outcomeCode: string): void;
  fail(outcomeCode: string): void;
}

const genesisHash = "0".repeat(64);
let defaultActionRecorder: SynchronousHashChainedActionRecorder | undefined;
let defaultActionRecorderPath: string | undefined;

/** Configures the per-process durable action ledger without creating it until a child is launched. */
export function configureDefaultHiddenChildActionLedger(filePath: string): string {
  const absolute = resolve(filePath);
  if (defaultActionRecorderPath !== undefined && defaultActionRecorderPath !== absolute) {
    throw new Error("Hidden child action ledger is already configured for this process");
  }
  defaultActionRecorderPath ??= absolute;
  return absolute;
}

function configuredDefaultActionRecorder(): SynchronousHashChainedActionRecorder | undefined {
  if (defaultActionRecorderPath === undefined) return undefined;
  defaultActionRecorder ??= new SynchronousHashChainedActionRecorder(defaultActionRecorderPath);
  return defaultActionRecorder;
}

/**
 * Binds child creation and termination to one in-memory ownership registry.
 * Unknown, copied, closed, or identity-mismatched handles fail closed.
 */
export class HiddenChildProcessBoundary {
  readonly #owned = new WeakMap<ChildProcess, OwnershipRecord>();
  readonly #spawn: HiddenSpawnImplementation;
  readonly #actionRecorder: SynchronousHashChainedActionRecorder | undefined;

  constructor(
    spawnImplementation: HiddenSpawnImplementation = (executable, args, options) =>
      spawn(executable, [...args], options),
    actionLedgerFile?: string,
  ) {
    this.#spawn = spawnImplementation;
    this.#actionRecorder =
      actionLedgerFile === undefined
        ? undefined
        : new SynchronousHashChainedActionRecorder(resolve(actionLedgerFile));
  }

  spawnHidden(
    executable: string,
    args: readonly string[],
    options: HiddenSpawnOptions = {},
  ): OwnedHiddenChildProcess {
    const recorder = this.#actionRecorder ?? configuredDefaultActionRecorder();
    const action = recorder?.begin({
      kind: "child_process",
      effect: "start",
      targetClass: childTargetClass(executable),
      targetFingerprint: executableFingerprint(executable),
    });
    let child: ChildProcess;
    try {
      child = this.#spawn(executable, args, {
        ...options,
        shell: false,
        windowsHide: true,
      });
      action?.complete(child.pid === undefined ? "SPAWNED_WITHOUT_PID" : "SPAWNED");
    } catch (error) {
      action?.fail("SPAWN_FAILED");
      throw error;
    }
    const metadata = Object.freeze({
      nonce: randomUUID(),
      executable,
      spawnedAtUnixMs: Date.now(),
      ...(child.pid === undefined ? {} : { pid: child.pid }),
    }) satisfies HiddenChildOwnership;
    const record: OwnershipRecord = { metadata, active: true };
    Object.defineProperties(child, {
      ownership: { configurable: false, enumerable: false, value: metadata, writable: false },
      [ownedHiddenChildBrand]: {
        configurable: false,
        enumerable: false,
        value: true,
        writable: false,
      },
    });
    this.#owned.set(child, record);
    child.once("close", () => {
      record.active = false;
    });
    return child as unknown as OwnedHiddenChildProcess;
  }

  terminateOwnedHiddenChild(
    child: OwnedHiddenChildProcess,
    signal: NodeJS.Signals | number = "SIGTERM",
  ): boolean {
    const nativeChild = child as unknown as ChildProcess;
    const record = this.#owned.get(nativeChild);
    if (
      record === undefined ||
      !record.active ||
      child.ownership !== record.metadata ||
      record.metadata.pid === undefined ||
      nativeChild.pid !== record.metadata.pid ||
      nativeChild.exitCode !== null ||
      nativeChild.signalCode !== null
    ) {
      return false;
    }
    const recorder = this.#actionRecorder ?? configuredDefaultActionRecorder();
    const action = recorder?.begin({
      kind: "process_signal",
      effect: "signal",
      targetClass: "omnicodex_owned_child",
      targetFingerprint: createHash("sha256").update(record.metadata.nonce, "utf8").digest("hex"),
    });
    try {
      const signaled = nativeChild.kill(signal);
      if (signaled) action?.complete("SIGNAL_SENT");
      else action?.fail("SIGNAL_REJECTED");
      return signaled;
    } catch (error) {
      action?.fail("SIGNAL_FAILED");
      throw error;
    }
  }

  async inspectWindowsProcess(
    pid: number,
    options: WindowsProcessBoundaryOptions = {},
  ): Promise<RecoveredWindowsProcessIdentity | undefined> {
    const result = await this.#runWindowsProcessCommand(
      windowsProcessInspectionScript,
      { pid },
      options,
    );
    if (!isObject(result) || (result.status !== "absent" && result.status !== "observed")) {
      throw new Error("OWNED_PROCESS_BOUNDARY_UNVERIFIABLE:inspection shape");
    }
    if (result.status === "absent") return undefined;
    const processRecord = result.process;
    if (
      !isObject(processRecord) ||
      !Number.isInteger(processRecord.pid) ||
      !Number.isInteger(processRecord.parentPid) ||
      typeof processRecord.name !== "string" ||
      typeof processRecord.executablePath !== "string" ||
      typeof processRecord.commandLine !== "string" ||
      typeof processRecord.startedAtIso !== "string"
    ) {
      throw new Error("OWNED_PROCESS_BOUNDARY_UNVERIFIABLE:process shape");
    }
    return processRecord as unknown as RecoveredWindowsProcessIdentity;
  }

  async inspectWindowsProcessesByName(
    name: string,
    options: WindowsProcessBoundaryOptions = {},
  ): Promise<readonly RecoveredWindowsProcessIdentity[]> {
    return this.inspectWindowsProcessesByNames([name], options);
  }

  async inspectWindowsProcessesByNames(
    names: readonly string[],
    options: WindowsProcessBoundaryOptions = {},
  ): Promise<readonly RecoveredWindowsProcessIdentity[]> {
    if (
      names.length === 0 ||
      names.length > 8 ||
      names.some((name) => !/^[a-z0-9._-]+$/iu.test(name))
    ) {
      throw new Error("OWNED_PROCESS_BOUNDARY_UNVERIFIABLE:process name");
    }
    const result = await this.#runWindowsProcessCommand(
      windowsNamedProcessInspectionScript,
      { names: [...new Set(names)] },
      options,
    );
    if (!isObject(result) || result.status !== "observed" || !Array.isArray(result.processes)) {
      throw new Error("OWNED_PROCESS_BOUNDARY_UNVERIFIABLE:process list shape");
    }
    return result.processes.map((processRecord) => {
      if (
        !isObject(processRecord) ||
        !Number.isInteger(processRecord.pid) ||
        !Number.isInteger(processRecord.parentPid) ||
        typeof processRecord.name !== "string" ||
        typeof processRecord.executablePath !== "string" ||
        typeof processRecord.commandLine !== "string" ||
        typeof processRecord.startedAtIso !== "string"
      ) {
        throw new Error("OWNED_PROCESS_BOUNDARY_UNVERIFIABLE:process list entry shape");
      }
      return processRecord as unknown as RecoveredWindowsProcessIdentity;
    });
  }

  async inspectWindowsLoopbackTcpListener(
    port: number,
    options: WindowsProcessBoundaryOptions = {},
  ): Promise<RecoveredWindowsProcessIdentity | undefined> {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error("OWNED_PROCESS_BOUNDARY_UNVERIFIABLE:listener port");
    }
    const result = await this.#runWindowsProcessCommand(
      windowsLoopbackListenerInspectionScript,
      { port },
      options,
    );
    if (!isObject(result) || (result.status !== "absent" && result.status !== "observed")) {
      throw new Error("OWNED_PROCESS_BOUNDARY_UNVERIFIABLE:listener shape");
    }
    if (result.status === "absent") return undefined;
    const processRecord = result.process;
    if (
      !isObject(processRecord) ||
      !Number.isInteger(processRecord.pid) ||
      !Number.isInteger(processRecord.parentPid) ||
      typeof processRecord.name !== "string" ||
      typeof processRecord.executablePath !== "string" ||
      typeof processRecord.commandLine !== "string" ||
      typeof processRecord.startedAtIso !== "string"
    ) {
      throw new Error("OWNED_PROCESS_BOUNDARY_UNVERIFIABLE:listener process shape");
    }
    return processRecord as unknown as RecoveredWindowsProcessIdentity;
  }

  async terminateExactRecoveredWindowsProcess(
    expected: RecoveredWindowsProcessIdentity,
    options: WindowsProcessBoundaryOptions = {},
  ): Promise<"terminated" | "absent" | "changed"> {
    const recorder = this.#actionRecorder ?? configuredDefaultActionRecorder();
    const action = recorder?.begin({
      kind: "process_signal",
      effect: "signal",
      targetClass: "omnicodex_owned_child",
      targetFingerprint: createHash("sha256").update(canonicalJson(expected), "utf8").digest("hex"),
    });
    try {
      const result = await this.#runWindowsProcessCommand(
        windowsProcessTerminationScript,
        expected,
        options,
      );
      if (
        !isObject(result) ||
        (result.status !== "terminated" &&
          result.status !== "absent" &&
          result.status !== "changed")
      ) {
        throw new Error("OWNED_PROCESS_BOUNDARY_UNVERIFIABLE:termination shape");
      }
      if (result.status === "changed") action?.fail("RECOVERED_IDENTITY_CHANGED");
      else action?.complete(result.status === "terminated" ? "SIGNAL_SENT" : "ALREADY_ABSENT");
      return result.status;
    } catch (error) {
      action?.fail("RECOVERED_SIGNAL_FAILED");
      throw error;
    }
  }

  async #runWindowsProcessCommand(
    script: string,
    input: unknown,
    options: WindowsProcessBoundaryOptions,
  ): Promise<unknown> {
    if (process.platform !== "win32") {
      throw new Error("OWNED_PROCESS_BOUNDARY_UNVERIFIABLE:Windows required");
    }
    const systemRoot = options.systemRoot ?? process.env.SystemRoot;
    if (systemRoot === undefined || systemRoot.length === 0) {
      throw new Error("OWNED_PROCESS_BOUNDARY_UNVERIFIABLE:SystemRoot");
    }
    const timeoutMs = optionalPositiveSafeInteger(options.timeoutMs, "timeoutMs");
    const executable = join(
      resolve(systemRoot),
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = this.spawnHidden(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        encoded,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
        },
      },
    );
    if (child.stdin === null) throw new Error("OWNED_PROCESS_BOUNDARY_UNVERIFIABLE:stdin");
    child.stdin.end(JSON.stringify(input), "utf8");
    return collectHiddenJson(this, child, timeoutMs);
  }
}

function collectHiddenJson(
  boundary: HiddenChildProcessBoundary,
  child: OwnedHiddenChildProcess,
  timeoutMs: number | undefined,
): Promise<unknown> {
  return new Promise((resolveResult, rejectResult) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cancelTimeout();
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      if (error !== undefined) {
        if (!Object.hasOwn(error, "stdout")) Object.assign(error, { stdout });
        if (!Object.hasOwn(error, "stderr")) Object.assign(error, { stderr });
        rejectResult(error);
      } else {
        try {
          resolveResult(JSON.parse(stdout));
        } catch (cause) {
          rejectResult(
            boundaryError(
              "OWNED_PROCESS_BOUNDARY_UNVERIFIABLE:invalid JSON",
              {
                stdout,
                stderr,
              },
              cause,
            ),
          );
        }
      }
    };
    const cancelTimeout = scheduleOptionalTimeout(timeoutMs, () => {
      const signaled = boundary.terminateOwnedHiddenChild(child);
      finish(
        boundaryError("OWNED_PROCESS_BOUNDARY_UNVERIFIABLE:timeout", {
          timeoutMs,
          terminationSignalSent: signaled,
        }),
      );
    });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (!settled) stdout += stdoutDecoder.write(asBuffer(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (!settled) stderr += stderrDecoder.write(asBuffer(chunk));
    });
    child.once("error", (cause) => {
      finish(boundaryError("OWNED_PROCESS_BOUNDARY_UNVERIFIABLE:probe start", {}, cause));
    });
    child.once("close", (code, signal) => {
      if (code !== 0) {
        finish(
          boundaryError("OWNED_PROCESS_BOUNDARY_UNVERIFIABLE:probe failure", {
            exitCode: code,
            signal,
          }),
        );
      } else finish();
    });
  });
}

function scheduleOptionalTimeout(timeoutMs: number | undefined, onTimeout: () => void): () => void {
  if (timeoutMs === undefined) return () => undefined;
  const maximumTimerDelayMs = 2_147_483_647n;
  const deadline = BigInt(Date.now()) + BigInt(timeoutMs);
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    const remaining = deadline - BigInt(Date.now());
    if (remaining <= 0n) {
      onTimeout();
      return;
    }
    const delay = Number(remaining > maximumTimerDelayMs ? maximumTimerDelayMs : remaining);
    timer = setTimeout(schedule, delay);
  };
  schedule();
  return () => {
    if (timer !== undefined) clearTimeout(timer);
  };
}

function boundaryError(message: string, details: Record<string, unknown>, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), details);
}

function asBuffer(value: Buffer | string): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

function optionalPositiveSafeInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

const windowsProcessInspectionScript = [
  "$ErrorActionPreference = 'Stop'",
  "$request = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "$targetPid = [int]$request.pid",
  '$cim = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid" -ErrorAction SilentlyContinue',
  "if ($null -eq $cim) {",
  '  [Console]::Out.Write(\'{"status":"absent"}\')',
  "  exit 0",
  "}",
  "$live = Get-Process -Id $targetPid -ErrorAction Stop",
  "$path = if ([string]::IsNullOrWhiteSpace($live.Path)) { [string]$cim.ExecutablePath } else { [string]$live.Path }",
  "$record = [pscustomobject]@{",
  "  status = 'observed'",
  "  process = [pscustomobject]@{",
  "    pid = [int]$cim.ProcessId",
  "    parentPid = [int]$cim.ParentProcessId",
  "    name = [string]$cim.Name",
  "    executablePath = $path",
  "    commandLine = [string]$cim.CommandLine",
  "    startedAtIso = $live.StartTime.ToUniversalTime().ToString('o')",
  "  }",
  "}",
  "[Console]::Out.Write(($record | ConvertTo-Json -Compress -Depth 4))",
  "",
].join("\r\n");

const windowsLoopbackListenerInspectionScript = [
  "$ErrorActionPreference = 'Stop'",
  "$request = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "$targetPort = [int]$request.port",
  "$listener = Get-CimInstance -Namespace ROOT/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter \"LocalPort = $targetPort AND State = 2\" -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1') } | Select-Object -First 1",
  "if ($null -eq $listener) {",
  '  [Console]::Out.Write(\'{"status":"absent"}\')',
  "  exit 0",
  "}",
  "$targetPid = [int]$listener.OwningProcess",
  '$cim = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid" -ErrorAction Stop',
  "$live = Get-Process -Id $targetPid -ErrorAction Stop",
  "$path = if ([string]::IsNullOrWhiteSpace($live.Path)) { [string]$cim.ExecutablePath } else { [string]$live.Path }",
  "$record = [pscustomobject]@{",
  "  status = 'observed'",
  "  process = [pscustomobject]@{",
  "    pid = [int]$cim.ProcessId",
  "    parentPid = [int]$cim.ParentProcessId",
  "    name = [string]$cim.Name",
  "    executablePath = $path",
  "    commandLine = [string]$cim.CommandLine",
  "    startedAtIso = $live.StartTime.ToUniversalTime().ToString('o')",
  "  }",
  "}",
  "[Console]::Out.Write(($record | ConvertTo-Json -Compress -Depth 4))",
  "",
].join("\r\n");

const windowsNamedProcessInspectionScript = [
  "$ErrorActionPreference = 'Stop'",
  "$request = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "$targetNames = @($request.names)",
  "if ($targetNames.Count -lt 1 -or $targetNames.Count -gt 8) { throw 'Invalid process name count' }",
  "foreach ($targetName in $targetNames) { if ([string]$targetName -notmatch '^[a-zA-Z0-9._-]+$') { throw 'Invalid process name' } }",
  '$filter = (@($targetNames | ForEach-Object { "Name = \'$([string]$_)\'" })) -join " OR "',
  "$records = @()",
  "$cims = @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction SilentlyContinue)",
  "foreach ($cim in $cims) {",
  "  try {",
  "    $targetPid = [int]$cim.ProcessId",
  "    $live = Get-Process -Id $targetPid -ErrorAction Stop",
  "    $path = if ([string]::IsNullOrWhiteSpace($live.Path)) { [string]$cim.ExecutablePath } else { [string]$live.Path }",
  "    $records += [pscustomobject]@{",
  "      pid = [int]$cim.ProcessId",
  "      parentPid = [int]$cim.ParentProcessId",
  "      name = [string]$cim.Name",
  "      executablePath = $path",
  "      commandLine = [string]$cim.CommandLine",
  "      startedAtIso = $live.StartTime.ToUniversalTime().ToString('o')",
  "    }",
  "  } catch {",
  "    # The process exited between the CIM snapshot and identity readback.",
  "  }",
  "}",
  "$result = [pscustomobject]@{ status = 'observed'; processes = @($records) }",
  "[Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 4))",
  "",
].join("\r\n");

const windowsProcessTerminationScript = [
  "$ErrorActionPreference = 'Stop'",
  "$expected = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "$targetPid = [int]$expected.pid",
  '$cim = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid" -ErrorAction SilentlyContinue',
  "if ($null -eq $cim) {",
  '  [Console]::Out.Write(\'{"status":"absent"}\')',
  "  exit 0",
  "}",
  "$live = Get-Process -Id $targetPid -ErrorAction Stop",
  "$path = if ([string]::IsNullOrWhiteSpace($live.Path)) { [string]$cim.ExecutablePath } else { [string]$live.Path }",
  "$startedAtIso = $live.StartTime.ToUniversalTime().ToString('o')",
  "$same = (",
  "  [int]$cim.ProcessId -eq [int]$expected.pid -and",
  "  [int]$cim.ParentProcessId -eq [int]$expected.parentPid -and",
  "  [string]$cim.Name -ceq [string]$expected.name -and",
  "  $path -ceq [string]$expected.executablePath -and",
  "  [string]$cim.CommandLine -ceq [string]$expected.commandLine -and",
  "  $startedAtIso -ceq [string]$expected.startedAtIso",
  ")",
  "if (-not $same) {",
  '  [Console]::Out.Write(\'{"status":"changed"}\')',
  "  exit 0",
  "}",
  "$live.Kill()",
  "if (-not $live.WaitForExit(10000)) { throw 'Exact recovered process did not exit' }",
  '[Console]::Out.Write(\'{"status":"terminated"}\')',
  "",
].join("\r\n");

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class SynchronousHashChainedActionRecorder {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
    mkdirSync(dirname(this.filePath), { recursive: true });
    const handle = openSync(this.filePath, "a", 0o600);
    closeSync(handle);
    this.#readHead();
  }

  begin(input: {
    readonly kind: ActionKind;
    readonly effect: ActionEffect;
    readonly targetClass: string;
    readonly targetFingerprint: string;
  }): SynchronousActionOperation {
    const operationId = randomUUID();
    this.#append({ operationId, ...input, phase: "intent" });
    let terminal = false;
    const finish = (phase: "completed" | "failed", outcomeCode: string) => {
      if (terminal) throw new Error("Action ledger operation already has a terminal record");
      terminal = true;
      this.#append({ operationId, ...input, phase, outcomeCode });
    };
    return {
      complete: (outcomeCode) => finish("completed", outcomeCode),
      fail: (outcomeCode) => finish("failed", outcomeCode),
    };
  }

  #append(input: Omit<ActionRecord, "sequence" | "timestampUnixMs">): void {
    const head = this.#readHead();
    const record: ActionRecord = {
      sequence: head.sequence + 1,
      timestampUnixMs: Date.now(),
      ...input,
    };
    const entryHash = hashLedgerEntry(head.hash, record);
    const stored: StoredActionRecord = { ...record, previousHash: head.hash, entryHash };
    const handle = openSync(this.filePath, "a", 0o600);
    try {
      writeSync(handle, `${canonicalJson(stored)}\n`, undefined, "utf8");
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  }

  #readHead(): { readonly sequence: number; readonly hash: string } {
    if (!existsSync(this.filePath)) return { sequence: 0, hash: genesisHash };
    const raw = readFileSync(this.filePath, "utf8");
    if (raw === "") return { sequence: 0, hash: genesisHash };
    if (!raw.endsWith("\n")) throw new Error("Hidden child action ledger is unterminated");
    const lines = raw.slice(0, -1).split("\n");
    let sequence = 0;
    let hash = genesisHash;
    for (const line of lines) {
      const value: unknown = JSON.parse(line);
      if (!isStoredActionRecord(value))
        throw new Error("Hidden child action ledger shape is invalid");
      if (value.sequence !== sequence + 1 || value.previousHash !== hash) {
        throw new Error("Hidden child action ledger chain is invalid");
      }
      const { entryHash, previousHash, ...record } = value;
      if (entryHash !== hashLedgerEntry(previousHash, record)) {
        throw new Error("Hidden child action ledger hash is invalid");
      }
      sequence = value.sequence;
      hash = value.entryHash;
    }
    return { sequence, hash };
  }
}

function childTargetClass(executable: string): string {
  const name = basename(executable).toLocaleLowerCase("en-US");
  if (name === "chatgpt.exe") return "codex_desktop";
  if (name === "codex.exe") return "omnicodex_owned_codex_runtime";
  return "omnicodex_owned_child";
}

function executableFingerprint(executable: string): string {
  return createHash("sha256")
    .update(resolve(executable).toLocaleLowerCase("en-US"), "utf8")
    .digest("hex");
}

function hashLedgerEntry(previousHash: string, record: ActionRecord): string {
  return createHash("sha256")
    .update(previousHash, "utf8")
    .update("\n", "utf8")
    .update(canonicalJson(record), "utf8")
    .digest("hex");
}

function isStoredActionRecord(value: unknown): value is StoredActionRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(record.sequence) &&
    typeof record.timestampUnixMs === "number" &&
    typeof record.operationId === "string" &&
    typeof record.kind === "string" &&
    typeof record.effect === "string" &&
    typeof record.phase === "string" &&
    typeof record.targetClass === "string" &&
    typeof record.targetFingerprint === "string" &&
    typeof record.previousHash === "string" &&
    typeof record.entryHash === "string"
  );
}

const defaultBoundary = new HiddenChildProcessBoundary();

/**
 * The only permitted child-process creation boundary in OmniCodex.
 * `windowsHide` prevents a console window and `shell: false` prevents an
 * intermediate cmd.exe/PowerShell process from being created.
 */
export function spawnHidden(
  executable: string,
  args: readonly string[],
  options: HiddenSpawnOptions = {},
): OwnedHiddenChildProcess {
  return defaultBoundary.spawnHidden(executable, args, options);
}

/** Runs a blocking Windows query through the same no-shell, hidden-window boundary. */
export function captureHiddenProcessOutputSync(
  executable: string,
  args: readonly string[],
): string {
  return execFileSync(executable, [...args], {
    windowsHide: true,
    shell: false,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Returns false without signaling when the handle cannot be proven owned. */
export function terminateOwnedHiddenChild(
  child: OwnedHiddenChildProcess,
  signal: NodeJS.Signals | number = "SIGTERM",
): boolean {
  return defaultBoundary.terminateOwnedHiddenChild(child, signal);
}

/** Reads exact Windows process identities without exposing a visible shell window. */
export function inspectWindowsProcessesByName(
  name: string,
  options: WindowsProcessBoundaryOptions = {},
): Promise<readonly RecoveredWindowsProcessIdentity[]> {
  return defaultBoundary.inspectWindowsProcessesByName(name, options);
}

/** Reads several process names with one hidden Windows inspection process. */
export function inspectWindowsProcessesByNames(
  names: readonly string[],
  options: WindowsProcessBoundaryOptions = {},
): Promise<readonly RecoveredWindowsProcessIdentity[]> {
  return defaultBoundary.inspectWindowsProcessesByNames(names, options);
}
