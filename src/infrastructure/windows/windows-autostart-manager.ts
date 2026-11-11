import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { uptime } from "node:os";
import { dirname, join, resolve } from "node:path";
import { omniCodexDataDirectory } from "../config/omnicodex-config-store.js";
import { spawnHidden } from "./hidden-child-process.js";

export interface HiddenCommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface HiddenCommandRunner {
  run(executable: string, args: readonly string[], input?: string): Promise<HiddenCommandResult>;
}

export interface WindowsAutostartManagerOptions {
  readonly nodeExecutable: string;
  readonly launcherScript: string;
  readonly dataDirectory?: string;
  readonly taskName?: string;
  readonly windowsDirectory?: string;
  readonly runner?: HiddenCommandRunner;
  readonly nowUnixMs?: () => number;
  readonly uptimeSeconds?: () => number;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

export interface WindowsAutostartStatus {
  readonly enabled: boolean;
  readonly taskName: string;
  readonly launcherPath: string;
  readonly mechanism: "scheduled-task" | "legacy-hkcu-run" | null;
  readonly legacyRunRegistration: boolean;
  readonly actionVerified: boolean;
  readonly launcherVerified: boolean;
  readonly rebootVerifiedForCurrentBoot: boolean;
  readonly lastLaunch?: WindowsAutostartLaunchReceipt;
}

export interface WindowsAutostartLaunchReceipt {
  readonly event: "autostart_succeeded" | "autostart_failed";
  readonly timestamp: string;
  readonly startedAt: string;
  readonly source: "scheduled-task" | "manual-test" | "interactive";
  readonly bootedAtUnixMs: number;
  readonly attempts: number;
  readonly exitCode: number | null;
  readonly pointerVersion: string;
  readonly pointerActivatedAtUnixMs: number;
}

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_SUBKEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE_NAME = "OmniCodexGateway";
const WATCHDOG_INTERVAL = "PT5M";
const RESTART_INTERVAL = "PT1M";
const RESTART_COUNT = 3;
const TASK_EXECUTION_TIME_LIMIT = "PT0S";
type ScheduledTaskOperation = "query" | "instances" | "create" | "delete" | "run" | "restore";

/** Registers the exact per-user Scheduled Task through a console-free WScript launcher. */
export class WindowsAutostartManager {
  readonly #nodeExecutable: string;
  readonly #launcherScript: string;
  readonly #dataDirectory: string;
  readonly #taskName: string;
  readonly #powershellExecutable: string;
  readonly #wscriptExecutable: string;
  readonly #regExecutable: string;
  readonly #runner: HiddenCommandRunner;
  readonly #nowUnixMs: () => number;
  readonly #uptimeSeconds: () => number;
  readonly #delay: (milliseconds: number) => Promise<void>;

  constructor(options: WindowsAutostartManagerOptions) {
    const windowsDirectory = resolve(
      options.windowsDirectory ?? process.env.WINDIR ?? "C:\\Windows",
    );
    this.#nodeExecutable = resolve(options.nodeExecutable);
    this.#launcherScript = resolve(options.launcherScript);
    this.#dataDirectory = resolve(options.dataDirectory ?? omniCodexDataDirectory());
    this.#taskName = options.taskName ?? "\\OmniCodex\\Gateway";
    this.#powershellExecutable = join(
      windowsDirectory,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    this.#wscriptExecutable = join(windowsDirectory, "System32", "wscript.exe");
    this.#regExecutable = join(windowsDirectory, "System32", "reg.exe");
    this.#runner = options.runner ?? new SpawnHiddenCommandRunner();
    this.#nowUnixMs = options.nowUnixMs ?? Date.now;
    this.#uptimeSeconds = options.uptimeSeconds ?? uptime;
    this.#delay =
      options.delay ??
      ((milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)));
  }

  get launcherPath(): string {
    return join(this.#dataDirectory, "autostart.vbs");
  }

  async status(): Promise<WindowsAutostartStatus> {
    const legacyRun = await this.#legacyRunRegistration();
    if (legacyRun === "foreign") {
      throw new Error(
        "Refusing an OmniCodex Run value whose action is not the owned hidden launcher",
      );
    }
    const taskResult = await this.#scheduledTask("query");
    if (taskResult.code !== 0 && taskResult.code !== 1) {
      throw commandError("query", taskResult);
    }
    if (taskResult.code === 0) {
      if (
        !scheduledTaskActionMatches(taskResult.stdout, this.#wscriptExecutable, this.launcherPath)
      ) {
        throw new Error("Refusing an OmniCodex task whose action is not the owned hidden launcher");
      }
      await this.#verifyLauncher();
      return this.#status(
        scheduledTaskEnabled(taskResult.stdout),
        "scheduled-task",
        legacyRun === "owned",
        await this.lastLaunch(),
      );
    }
    if (legacyRun === "owned") {
      await this.#verifyLauncher();
      return this.#status(true, "legacy-hkcu-run", true, await this.lastLaunch());
    }
    return this.#status(false, null, false, await this.lastLaunch());
  }

  #status(
    enabled: boolean,
    mechanism: WindowsAutostartStatus["mechanism"],
    legacyRunRegistration: boolean,
    lastLaunch?: WindowsAutostartLaunchReceipt,
  ): WindowsAutostartStatus {
    const currentBootedAtUnixMs = this.#nowUnixMs() - Math.floor(this.#uptimeSeconds() * 1_000);
    const rebootVerifiedForCurrentBoot =
      lastLaunch?.event === "autostart_succeeded" &&
      lastLaunch.exitCode === 0 &&
      lastLaunch?.source === "scheduled-task" &&
      Math.abs(lastLaunch.bootedAtUnixMs - currentBootedAtUnixMs) <= 10_000 &&
      lastLaunch.pointerActivatedAtUnixMs <= lastLaunch.bootedAtUnixMs + 10_000 &&
      Date.parse(lastLaunch.startedAt) >= lastLaunch.bootedAtUnixMs;
    return {
      enabled,
      taskName: this.#taskName,
      launcherPath: this.launcherPath,
      mechanism,
      legacyRunRegistration,
      actionVerified: mechanism !== null,
      launcherVerified: mechanism !== null,
      rebootVerifiedForCurrentBoot,
      ...(lastLaunch === undefined ? {} : { lastLaunch }),
    };
  }

  /** Reads the latest launcher settlement without invoking Task Scheduler. */
  async lastLaunch(): Promise<WindowsAutostartLaunchReceipt | undefined> {
    const path = join(this.#dataDirectory, "logs", "autostart-launcher.jsonl");
    const handle = await open(path, "r").catch((error: unknown) => {
      if (isObject(error) && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (handle === undefined) return undefined;
    let text: string;
    try {
      const { size } = await handle.stat();
      if (size === 0) return undefined;
      const length = Math.min(size, 64 * 1_024);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, size - length);
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    const line = text
      .split(/\r?\n/)
      .map((candidate) => candidate.trim())
      .filter((candidate) => candidate.length > 0)
      .at(-1);
    if (line === undefined) return undefined;
    const value: unknown = JSON.parse(line);
    if (isLegacyLaunchReceipt(value)) return undefined;
    if (
      !isObject(value) ||
      (value.event !== "autostart_succeeded" && value.event !== "autostart_failed") ||
      !validIsoTimestamp(value.timestamp) ||
      !validIsoTimestamp(value.startedAt) ||
      (value.source !== "scheduled-task" &&
        value.source !== "manual-test" &&
        value.source !== "interactive") ||
      typeof value.bootedAtUnixMs !== "number" ||
      !Number.isSafeInteger(value.bootedAtUnixMs) ||
      value.bootedAtUnixMs <= 0 ||
      typeof value.attempts !== "number" ||
      !Number.isSafeInteger(value.attempts) ||
      value.attempts <= 0 ||
      (value.exitCode !== null &&
        (typeof value.exitCode !== "number" || !Number.isSafeInteger(value.exitCode))) ||
      typeof value.pointerVersion !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.pointerVersion) ||
      typeof value.pointerActivatedAtUnixMs !== "number" ||
      !Number.isSafeInteger(value.pointerActivatedAtUnixMs)
    ) {
      throw new Error("Invalid autostart launch receipt");
    }
    return {
      event: value.event,
      timestamp: value.timestamp,
      startedAt: value.startedAt,
      source: value.source,
      bootedAtUnixMs: value.bootedAtUnixMs,
      attempts: value.attempts,
      exitCode: value.exitCode,
      pointerVersion: value.pointerVersion,
      pointerActivatedAtUnixMs: value.pointerActivatedAtUnixMs,
    };
  }

  async #verifyLauncher(): Promise<void> {
    const actual = await readFile(this.launcherPath, "utf8").catch(() => undefined);
    if (actual !== this.#launcherContents()) {
      throw new Error("OmniCodex autostart launcher bytes do not match the owned hidden action");
    }
  }

  /**
   * Refreshes only the generated VBS bytes after proving that an existing
   * registration points at this exact owned launcher path. The Node executable
   * can legitimately differ between the Codex bundled runtime and a normal
   * system CLI invocation; that must not turn a safe restart into an outage.
   * Scheduled Task settings and enabled state are deliberately left untouched.
   */
  async refreshOwnedLauncher(): Promise<boolean> {
    const legacyRun = await this.#legacyRunRegistration();
    if (legacyRun === "foreign") {
      throw new Error(
        "Refusing an OmniCodex Run value whose action is not the owned hidden launcher",
      );
    }
    const taskResult = await this.#scheduledTask("query");
    if (taskResult.code !== 0 && taskResult.code !== 1) {
      throw commandError("query", taskResult);
    }
    const scheduledTaskOwned =
      taskResult.code === 0 &&
      scheduledTaskOwnedActionMatches(
        taskResult.stdout,
        this.#wscriptExecutable,
        this.launcherPath,
      );
    if (taskResult.code === 0 && !scheduledTaskOwned) {
      throw new Error("Refusing an OmniCodex task whose action is not the owned hidden launcher");
    }
    if (!scheduledTaskOwned && legacyRun !== "owned") return false;
    await mkdir(dirname(this.launcherPath), { recursive: true });
    await restoreLauncher(this.launcherPath, this.#launcherContents());
    await this.#verifyLauncher();
    return true;
  }

  #launcherContents(): string {
    const command = quoteCommand([
      this.#nodeExecutable,
      this.#launcherScript,
      "start",
      "--non-interactive",
      "--json",
    ]);
    return [
      "Option Explicit",
      "If WScript.Arguments.Count <> 1 Then WScript.Quit 2",
      "Dim launchSource",
      "launchSource = LCase(WScript.Arguments(0))",
      'If launchSource <> "scheduled-task" And launchSource <> "manual-test" Then WScript.Quit 2',
      "Dim shell",
      "Dim exitCode",
      'Set shell = CreateObject("WScript.Shell")',
      'shell.Environment("PROCESS")("OMNICODEX_AUTOSTART_SOURCE") = launchSource',
      `exitCode = shell.Run(${vbsString(command)}, 0, True)`,
      "WScript.Quit exitCode",
      "",
    ].join("\r\n");
  }

  async enable(): Promise<WindowsAutostartStatus> {
    await Promise.all([
      access(this.#nodeExecutable),
      access(this.#launcherScript),
      access(this.#powershellExecutable),
      access(this.#wscriptExecutable),
      access(this.#regExecutable),
    ]);
    await mkdir(dirname(this.launcherPath), { recursive: true });
    const script = this.#launcherContents();
    const temporaryLauncher = `${this.launcherPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryLauncher, script, { encoding: "utf8", mode: 0o600 });
    let previousLauncher: string | undefined;
    let previousTaskXml: string | undefined;
    let taskAlreadyOwned = false;
    let launcherInstalled = false;
    let taskMutationAttempted = false;
    let migrationCommitted = false;
    try {
      previousLauncher = await readFile(this.launcherPath, "utf8").catch((error: unknown) => {
        if (isObject(error) && error.code === "ENOENT") return undefined;
        throw error;
      });
      const previousTask = await this.#scheduledTask("query");
      if (previousTask.code !== 0 && previousTask.code !== 1) {
        throw commandError("query", previousTask);
      }
      taskAlreadyOwned = previousTask.code === 0;
      if (
        taskAlreadyOwned &&
        !scheduledTaskOwnedActionMatches(
          previousTask.stdout,
          this.#wscriptExecutable,
          this.launcherPath,
        )
      ) {
        throw new Error("Refusing to replace a foreign OmniCodex Scheduled Task");
      }
      if (taskAlreadyOwned) previousTaskXml = previousTask.stdout;
      const legacyRun = await this.#legacyRunRegistration();
      if (legacyRun === "foreign") {
        throw new Error("Refusing to migrate a foreign OmniCodex Run value");
      }
      await rename(temporaryLauncher, this.launcherPath);
      launcherInstalled = true;
      taskMutationAttempted = true;
      const result = await this.#scheduledTask("create");
      if (result.code !== 0) {
        if (isAccessDenied(result)) {
          throw new Error(
            "Task Scheduler denied the exact per-user OmniCodex task; HKCU Run fallback is forbidden",
          );
        }
        throw commandError("enable", result);
      }
      const authoritative = await this.status();
      if (!authoritative.enabled || authoritative.mechanism !== "scheduled-task") {
        throw new Error("Scheduled Task did not read back the exact OmniCodex action");
      }
      if (legacyRun === "owned") {
        await this.#deleteOwnedLegacyRun();
        migrationCommitted = true;
      }
      const migrated = await this.status();
      if (migrated.mechanism !== "scheduled-task" || migrated.legacyRunRegistration) {
        throw new Error("OmniCodex autostart migration did not converge to the Scheduled Task");
      }
      return migrated;
    } catch (error) {
      if (migrationCommitted) throw error;
      const rollbackErrors: unknown[] = [];
      if (taskMutationAttempted) {
        const rollbackOperation = taskAlreadyOwned ? "restore" : "delete";
        const result = await this.#scheduledTask(rollbackOperation, previousTaskXml).catch(
          (rollbackError: unknown) => {
            rollbackErrors.push(rollbackError);
            return undefined;
          },
        );
        if (result !== undefined) {
          if (result.code !== 0 && !taskAlreadyOwned && result.code !== 1) {
            rollbackErrors.push(commandError("rollback", result));
          } else if (
            taskAlreadyOwned &&
            (result.code !== 0 ||
              (!scheduledTaskActionMatches(
                result.stdout,
                this.#wscriptExecutable,
                this.launcherPath,
              ) &&
                !scheduledTaskOwnedActionMatches(
                  result.stdout,
                  this.#wscriptExecutable,
                  this.launcherPath,
                )))
          ) {
            rollbackErrors.push(
              new Error("OmniCodex Scheduled Task rollback was not authoritative"),
            );
          }
        }
      }
      if (launcherInstalled) {
        await restoreLauncher(this.launcherPath, previousLauncher).catch(
          (rollbackError: unknown) => {
            rollbackErrors.push(rollbackError);
          },
        );
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], "OmniCodex autostart rollback failed");
      }
      throw error;
    } finally {
      await rm(temporaryLauncher, { force: true }).catch(() => undefined);
    }
  }

  async disable(): Promise<WindowsAutostartStatus> {
    const current = await this.status();
    if (!current.enabled && current.mechanism === null) return current;
    if (current.mechanism === "scheduled-task") {
      const result = await this.#scheduledTask("delete");
      if (result.code !== 0) throw commandError("disable", result);
    }
    if (current.legacyRunRegistration) await this.#deleteOwnedLegacyRun();
    const authoritative = await this.status();
    if (authoritative.enabled) throw new Error("OmniCodex autostart remained enabled after delete");
    return authoritative;
  }

  async test(): Promise<WindowsAutostartStatus> {
    const before = await this.status();
    if (
      !before.enabled ||
      before.mechanism !== "scheduled-task" ||
      before.legacyRunRegistration ||
      !before.actionVerified ||
      !before.launcherVerified
    ) {
      throw new Error("OmniCodex autostart is not enabled with an exact owned launcher");
    }
    const invokedAt = this.#nowUnixMs();
    const result = await this.#runner.run(this.#wscriptExecutable, [
      "//B",
      "//Nologo",
      this.launcherPath,
      "manual-test",
    ]);
    if (result.code !== 0) throw commandError("test", result);
    const deadline = invokedAt + 60_000;
    while (this.#nowUnixMs() <= deadline) {
      const latest = await this.lastLaunch();
      if (latest !== undefined && Date.parse(latest.startedAt) >= invokedAt) {
        if (
          latest.source !== "manual-test" ||
          latest.event !== "autostart_succeeded" ||
          latest.exitCode !== 0
        ) {
          throw new Error("OmniCodex autostart launcher reported a failed hidden start");
        }
        const authoritative = await this.status();
        if (authoritative.lastLaunch?.timestamp !== latest.timestamp) {
          throw new Error("Autostart launch receipt changed during authoritative readback");
        }
        return authoritative;
      }
      await this.#delay(250);
    }
    throw new Error("Timed out waiting for the hidden autostart launch receipt");
  }

  /** Starts the owned action through Task Scheduler so the daemon is not a Codex app descendant. */
  async launch(): Promise<WindowsAutostartStatus> {
    const current = await this.status();
    if (!current.enabled || current.mechanism !== "scheduled-task") {
      throw new Error("OmniCodex independent launch requires the owned Scheduled Task");
    }
    const result = await this.#scheduledTask("run");
    if (result.code !== 0) throw commandError("launch", result);
    return current;
  }

  /** Returns the exact owned Scheduled Task's live instance count. */
  async runningInstanceCount(): Promise<number> {
    const result = await this.#scheduledTask("instances");
    if (result.code !== 0) throw commandError("inspect running instances for", result);
    const value = Number(result.stdout.trim());
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Scheduled Task returned an invalid running-instance count");
    }
    return value;
  }

  async #legacyRunRegistration(): Promise<"absent" | "owned" | "foreign"> {
    const encoded = Buffer.from(registryRunQueryScript(), "utf16le").toString("base64");
    const result = await this.#runner.run(this.#powershellExecutable, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ]);
    if (result.code !== 0) throw commandError("query", result);
    const value: unknown = JSON.parse(result.stdout);
    if (!isObject(value) || (value.status !== "absent" && value.status !== "present")) {
      throw new Error("Invalid OmniCodex legacy Run query result");
    }
    if (value.status === "absent") return "absent";
    if (typeof value.value !== "string") {
      throw new Error("Invalid OmniCodex legacy Run value");
    }
    const action = value.value;
    return action !== undefined &&
      ownedLauncherActionMatches(action, this.#wscriptExecutable, this.launcherPath)
      ? "owned"
      : "foreign";
  }

  async #deleteOwnedLegacyRun(): Promise<void> {
    const legacyRun = await this.#legacyRunRegistration();
    if (legacyRun === "absent") return;
    if (legacyRun === "foreign")
      throw new Error("Refusing to delete a foreign OmniCodex Run value");
    const result = await this.#runner.run(this.#regExecutable, [
      "delete",
      RUN_KEY,
      "/v",
      RUN_VALUE_NAME,
      "/f",
    ]);
    if (result.code !== 0) throw commandError("disable", result);
  }

  async #scheduledTask(
    operation: ScheduledTaskOperation,
    previousXml?: string,
  ): Promise<HiddenCommandResult> {
    const encoded = Buffer.from(
      taskSchedulerScript(operation, this.#taskName, this.#wscriptExecutable, this.launcherPath),
      "utf16le",
    ).toString("base64");
    return this.#runner.run(
      this.#powershellExecutable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encoded,
      ],
      operation === "restore" ? previousXml : undefined,
    );
  }
}

async function restoreLauncher(path: string, previous: string | undefined): Promise<void> {
  if (previous === undefined) {
    await rm(path, { force: true });
    return;
  }
  const current = await readFile(path, "utf8").catch((error: unknown) => {
    if (isObject(error) && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (current === previous) return;
  const temporary = `${path}.${process.pid}.${randomUUID()}.restore`;
  try {
    await writeFile(temporary, previous, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // Task Scheduler can start the hidden VBS at the same instant that a
    // manual restart refreshes its Node path. Windows then transiently rejects
    // the atomic rename with EPERM/EACCES while wscript is reading the old
    // bytes. Retrying the same already-written temporary file preserves the
    // atomic replacement contract and must not make an otherwise successful
    // daemon restart fail.
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await rename(temporary, path);
        break;
      } catch (error) {
        if (!isTransientWindowsLauncherLock(error) || Date.now() >= deadline) throw error;
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isTransientWindowsLauncherLock(error: unknown): boolean {
  return (
    process.platform === "win32" &&
    isObject(error) &&
    (error.code === "EPERM" || error.code === "EACCES")
  );
}

function registryRunQueryScript(): string {
  return wrapTaskSchedulerScript([
    `$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${powerShellLiteral(RUN_SUBKEY)}, $false)`,
    "if ($null -eq $key) {",
    '  [Console]::Out.Write(\'{"status":"absent"}\')',
    "  exit 0",
    "}",
    "try {",
    `  if (-not ($key.GetValueNames() -contains ${powerShellLiteral(RUN_VALUE_NAME)})) {`,
    '    [Console]::Out.Write(\'{"status":"absent"}\')',
    "    exit 0",
    "  }",
    `  $value = [string]$key.GetValue(${powerShellLiteral(RUN_VALUE_NAME)}, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`,
    "  [Console]::Out.Write(([pscustomobject]@{ status = 'present'; value = $value } | ConvertTo-Json -Compress))",
    "  exit 0",
    "} finally {",
    "  $key.Dispose()",
    "}",
  ]);
}

class SpawnHiddenCommandRunner implements HiddenCommandRunner {
  async run(
    executable: string,
    args: readonly string[],
    input?: string,
  ): Promise<HiddenCommandResult> {
    const child = spawnHidden(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    if (input !== undefined) {
      if (child.stdin === null) throw new Error("Hidden command stdin is unavailable");
      child.stdin.end(input, "utf8");
    }
    const code = await new Promise<number | null>((resolveExit, rejectExit) => {
      let settled = false;
      const finish = (error: Error | undefined, exitCode: number | null = null) => {
        if (settled) return;
        settled = true;
        if (error === undefined) resolveExit(exitCode);
        else rejectExit(error);
      };
      child.once("error", (error) => finish(error));
      child.once("close", (exitCode) => finish(undefined, exitCode));
    });
    return { code, stdout, stderr };
  }
}

function taskSchedulerScript(
  operation: ScheduledTaskOperation,
  taskPath: string,
  wscriptExecutable: string,
  launcherPath: string,
): string {
  if (taskPath !== "\\OmniCodex\\Gateway") throw new Error("Unexpected autostart task path");
  const common = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$service = New-Object -ComObject 'Schedule.Service'",
    "$service.Connect()",
    "$folderPath = '\\OmniCodex'",
    "$taskName = 'Gateway'",
    "$notFound = -2147024894",
    "$pathNotFound = -2147024893",
  ];
  const findTask = [
    "try {",
    "  $folder = $service.GetFolder($folderPath)",
    "  $task = $folder.GetTask($taskName)",
    "} catch {",
    "  if ($_.Exception.HResult -eq $notFound -or $_.Exception.HResult -eq $pathNotFound) { exit 1 }",
    "  throw",
    "}",
  ];
  const validateOwner = [
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    "$identitySid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$principalIdentity = $task.Definition.Principal.UserId",
    "if ($principalIdentity -match '^S-') {",
    "  $principalSid = $principalIdentity",
    "} else {",
    "  $principalSid = ([System.Security.Principal.NTAccount]$principalIdentity).Translate([System.Security.Principal.SecurityIdentifier]).Value",
    "}",
    "if ($principalSid -ne $identitySid) { throw 'Scheduled Task principal is not the current user' }",
    "if ($task.Definition.Principal.LogonType -ne 3) { throw 'Scheduled Task logon type is not InteractiveToken' }",
    "if ($task.Definition.Principal.RunLevel -ne 0) { throw 'Scheduled Task is not least privilege' }",
    "if ($task.Definition.Triggers.Count -ne 2) { throw 'Scheduled Task does not have the exact logon and watchdog triggers' }",
    "$logonTrigger = $null",
    "$watchdogTrigger = $null",
    "for ($index = 1; $index -le $task.Definition.Triggers.Count; $index++) {",
    "  $candidate = $task.Definition.Triggers.Item($index)",
    "  if ($candidate.Type -eq 9) { if ($null -ne $logonTrigger) { throw 'Duplicate logon trigger' }; $logonTrigger = $candidate; continue }",
    "  if ($candidate.Type -eq 1) { if ($null -ne $watchdogTrigger) { throw 'Duplicate watchdog trigger' }; $watchdogTrigger = $candidate; continue }",
    "  throw 'Unexpected Scheduled Task trigger type'",
    "}",
    "if ($null -eq $logonTrigger -or $null -eq $watchdogTrigger) { throw 'Scheduled Task triggers are incomplete' }",
    `if ($watchdogTrigger.Repetition.Interval -ne '${WATCHDOG_INTERVAL}') { throw 'Scheduled Task watchdog interval is not five minutes' }`,
    "$triggerIdentity = $logonTrigger.UserId",
    "if ($triggerIdentity -match '^S-') {",
    "  $triggerSid = $triggerIdentity",
    "} else {",
    "  $triggerSid = ([System.Security.Principal.NTAccount]$triggerIdentity).Translate([System.Security.Principal.SecurityIdentifier]).Value",
    "}",
    "if ($triggerSid -ne $identitySid) { throw 'Scheduled Task trigger is not bound to the current user' }",
  ];
  if (operation === "query") {
    return wrapTaskSchedulerScript([
      ...common,
      ...findTask,
      ...validateOwner,
      "[Console]::Out.Write($task.Xml)",
      "exit 0",
    ]);
  }
  if (operation === "delete") {
    return wrapTaskSchedulerScript([
      ...common,
      ...findTask,
      ...validateOwner,
      "$folder.DeleteTask($taskName, 0)",
      "try { $null = $folder.GetTask($taskName); throw 'Scheduled Task remained after delete' } catch {",
      "  if ($_.Exception.HResult -ne $notFound -and $_.Exception.HResult -ne $pathNotFound) { throw }",
      "}",
      "exit 0",
    ]);
  }
  if (operation === "instances") {
    return wrapTaskSchedulerScript([
      ...common,
      ...findTask,
      ...validateOwner,
      "[Console]::Out.Write([string]$task.GetInstances(0).Count)",
      "exit 0",
    ]);
  }
  if (operation === "run") {
    return wrapTaskSchedulerScript([
      ...common,
      ...findTask,
      ...validateOwner,
      "if (-not $task.Enabled -or -not $task.Definition.Settings.Enabled) { throw 'Scheduled Task is disabled' }",
      "if (-not $logonTrigger.Enabled -or -not $watchdogTrigger.Enabled) { throw 'Scheduled Task trigger is disabled' }",
      "$null = $task.Run($null)",
      "exit 0",
    ]);
  }
  if (operation === "restore") {
    return wrapTaskSchedulerScript([
      ...common,
      "$folder = $service.GetFolder($folderPath)",
      "$xml = [Console]::In.ReadToEnd()",
      "if ([string]::IsNullOrWhiteSpace($xml)) { throw 'Previous Scheduled Task XML is missing' }",
      "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
      "$null = $folder.RegisterTask($taskName, $xml, 6, $identity, $null, 3, $null)",
      "$task = $folder.GetTask($taskName)",
      ...validateOwner,
      "[Console]::Out.Write($task.Xml)",
      "exit 0",
    ]);
  }
  const argumentsText = quoteCommand(["//B", "//Nologo", launcherPath, "scheduled-task"]);
  return wrapTaskSchedulerScript([
    ...common,
    "$root = $service.GetFolder('\\')",
    "try { $folder = $service.GetFolder($folderPath) } catch {",
    "  if ($_.Exception.HResult -ne $notFound -and $_.Exception.HResult -ne $pathNotFound) { throw }",
    "  $folder = $root.CreateFolder($folderPath)",
    "}",
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    "$definition = $service.NewTask(0)",
    "$definition.RegistrationInfo.Author = 'OmniCodex'",
    "$definition.RegistrationInfo.URI = '\\OmniCodex\\Gateway'",
    "$definition.Principal.UserId = $identity",
    "$definition.Principal.LogonType = 3",
    "$definition.Principal.RunLevel = 0",
    "$definition.Settings.Enabled = $true",
    "$definition.Settings.Hidden = $true",
    "$definition.Settings.StartWhenAvailable = $true",
    "$definition.Settings.DisallowStartIfOnBatteries = $false",
    "$definition.Settings.StopIfGoingOnBatteries = $false",
    "$definition.Settings.MultipleInstances = 2",
    `$definition.Settings.ExecutionTimeLimit = '${TASK_EXECUTION_TIME_LIMIT}'`,
    `$definition.Settings.RestartInterval = '${RESTART_INTERVAL}'`,
    `$definition.Settings.RestartCount = ${String(RESTART_COUNT)}`,
    "$trigger = $definition.Triggers.Create(9)",
    "$trigger.Enabled = $true",
    "$trigger.UserId = $identity",
    "$watchdog = $definition.Triggers.Create(1)",
    "$watchdog.Enabled = $true",
    "$watchdog.StartBoundary = (Get-Date).AddMinutes(5).ToString('s')",
    `$watchdog.Repetition.Interval = '${WATCHDOG_INTERVAL}'`,
    "$action = $definition.Actions.Create(0)",
    `$action.Path = ${powerShellLiteral(wscriptExecutable)}`,
    `$action.Arguments = ${powerShellLiteral(argumentsText)}`,
    `$action.WorkingDirectory = ${powerShellLiteral(dirname(launcherPath))}`,
    "$null = $folder.RegisterTaskDefinition($taskName, $definition, 6, $identity, $null, 3, $null)",
    "$task = $folder.GetTask($taskName)",
    ...validateOwner,
    "[Console]::Out.Write($task.Xml)",
    "exit 0",
  ]);
}

function wrapTaskSchedulerScript(lines: readonly string[]): string {
  return [
    "try {",
    ...lines.map((line) => `  ${line}`),
    "} catch {",
    "  [Console]::Error.Write($_.Exception.Message)",
    "  exit 2",
    "}",
    "",
  ].join("\r\n");
}

function powerShellLiteral(value: string): string {
  if (/\r|\n|\0/.test(value))
    throw new Error("Scheduled Task value contains forbidden control characters");
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteCommand(parts: readonly string[]): string {
  return parts.map(quoteWindowsArgument).join(" ");
}

function quoteWindowsArgument(value: string): string {
  if (/\r|\n/.test(value)) throw new Error("Autostart command arguments cannot contain newlines");
  return `"${value.replaceAll(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

function vbsString(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function commandError(operation: string, result: HiddenCommandResult): Error {
  const detail = (result.stderr || result.stdout).trim();
  return new Error(
    `Unable to ${operation} OmniCodex autostart (exit=${result.code ?? "null"})${detail.length === 0 ? "" : `: ${detail}`}`,
  );
}

function isAccessDenied(result: HiddenCommandResult): boolean {
  if (result.code !== 1) return false;
  const detail = `${result.stderr}\n${result.stdout}`.toLocaleLowerCase("en-US");
  return (
    detail.includes("access is denied") ||
    detail.includes("access denied") ||
    detail.includes("액세스가 거부되었습니다") ||
    detail.includes("拒绝访问") ||
    detail.includes("アクセスが拒否されました")
  );
}

function scheduledTaskActionMatches(
  xml: string,
  expectedExecutable: string,
  expectedLauncher: string,
): boolean {
  return (
    scheduledTaskOwnedActionMatches(xml, expectedExecutable, expectedLauncher) &&
    scheduledTaskDefinitionMatches(xml)
  );
}

function scheduledTaskOwnedActionMatches(
  xml: string,
  expectedExecutable: string,
  expectedLauncher: string,
): boolean {
  const command = xmlElement(xml, "Command");
  const argumentsText = xmlElement(xml, "Arguments");
  if (command === undefined || argumentsText === undefined) return false;
  return (
    normalizeWindowsPath(command) === normalizeWindowsPath(expectedExecutable) &&
    exactLauncherArguments(argumentsText, expectedLauncher)
  );
}

function scheduledTaskDefinitionMatches(xml: string): boolean {
  const userIds = [...xml.matchAll(/<UserId>([\s\S]*?)<\/UserId>/giu)].map((match) =>
    decodeXml((match[1] ?? "").trim()),
  );
  const runLevel = xmlElement(xml, "RunLevel");
  const timeTrigger = xmlSection(xml, "TimeTrigger");
  const restartOnFailure = xmlSection(xml, "RestartOnFailure");
  return (
    xmlElement(xml, "Author") === "OmniCodex" &&
    xmlElement(xml, "URI") === "\\OmniCodex\\Gateway" &&
    xmlElement(xml, "LogonType") === "InteractiveToken" &&
    (runLevel === undefined || runLevel === "LeastPrivilege") &&
    xmlElement(xml, "MultipleInstancesPolicy") === "IgnoreNew" &&
    xmlElement(xml, "StartWhenAvailable") === "true" &&
    xmlElement(xml, "DisallowStartIfOnBatteries") === "false" &&
    xmlElement(xml, "StopIfGoingOnBatteries") === "false" &&
    xmlElement(xml, "Hidden") === "true" &&
    xmlElement(xml, "ExecutionTimeLimit") === TASK_EXECUTION_TIME_LIMIT &&
    restartOnFailure !== undefined &&
    xmlElement(restartOnFailure, "Interval") === RESTART_INTERVAL &&
    xmlElement(restartOnFailure, "Count") === String(RESTART_COUNT) &&
    countXmlOpeningTag(xml, "LogonTrigger") === 1 &&
    countXmlOpeningTag(xml, "TimeTrigger") === 1 &&
    timeTrigger !== undefined &&
    xmlElement(timeTrigger, "Interval") === WATCHDOG_INTERVAL &&
    userIds.length >= 2 &&
    userIds.every((value) => value !== "")
  );
}

function scheduledTaskEnabled(xml: string): boolean {
  const settings = xmlSection(xml, "Settings");
  const logonTrigger = xmlSection(xml, "LogonTrigger");
  const timeTrigger = xmlSection(xml, "TimeTrigger");
  return (
    settings !== undefined &&
    logonTrigger !== undefined &&
    timeTrigger !== undefined &&
    xmlBooleanWithTrueDefault(settings, "Enabled") &&
    xmlBooleanWithTrueDefault(logonTrigger, "Enabled") &&
    xmlBooleanWithTrueDefault(timeTrigger, "Enabled")
  );
}

function xmlBooleanWithTrueDefault(xml: string, name: string): boolean {
  const value = xmlElement(xml, name);
  return value === undefined || value === "true";
}

function countXmlOpeningTag(xml: string, name: string): number {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>`, "giu"))].length;
}

function ownedLauncherActionMatches(
  action: string,
  expectedExecutable: string,
  expectedLauncher: string,
): boolean {
  const tokens = tokenizeFixedWindowsCommand(action);
  return (
    tokens.length === 4 &&
    normalizeWindowsPath(tokens[0] ?? "") === normalizeWindowsPath(expectedExecutable) &&
    (tokens[1] ?? "").toLocaleLowerCase("en-US") === "//b" &&
    (tokens[2] ?? "").toLocaleLowerCase("en-US") === "//nologo" &&
    normalizeWindowsPath(tokens[3] ?? "") === normalizeWindowsPath(expectedLauncher)
  );
}

function exactLauncherArguments(value: string, expectedLauncher: string): boolean {
  const tokens = tokenizeFixedWindowsCommand(value);
  return (
    tokens.length === 4 &&
    (tokens[0] ?? "").toLocaleLowerCase("en-US") === "//b" &&
    (tokens[1] ?? "").toLocaleLowerCase("en-US") === "//nologo" &&
    normalizeWindowsPath(tokens[2] ?? "") === normalizeWindowsPath(expectedLauncher) &&
    tokens[3] === "scheduled-task"
  );
}

function tokenizeFixedWindowsCommand(value: string): readonly string[] {
  if (/\r|\n|\0/.test(value)) return [];
  const tokens = value.match(/"[^"]*"|[^\s]+/g) ?? [];
  return tokens.map((token) =>
    token.length >= 2 && token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token,
  );
}

function xmlElement(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "iu").exec(xml)?.[1];
  return match === undefined ? undefined : decodeXml(match.trim());
}

function xmlSection(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "iu").exec(xml)?.[1];
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function normalizeWindowsPath(value: string): string {
  return resolve(value).replaceAll("/", "\\").toLocaleLowerCase("en-US");
}

function validIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isLegacyLaunchReceipt(value: unknown): boolean {
  return (
    isObject(value) &&
    value.source === undefined &&
    value.bootedAtUnixMs === undefined &&
    (value.event === "autostart_succeeded" || value.event === "autostart_failed") &&
    validIsoTimestamp(value.timestamp) &&
    validIsoTimestamp(value.startedAt) &&
    typeof value.attempts === "number" &&
    Number.isSafeInteger(value.attempts) &&
    value.attempts > 0 &&
    (value.exitCode === null ||
      (typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode))) &&
    typeof value.pointerVersion === "string" &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.pointerVersion) &&
    typeof value.pointerActivatedAtUnixMs === "number" &&
    Number.isSafeInteger(value.pointerActivatedAtUnixMs)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
