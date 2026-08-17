import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { omniCodexDataDirectory } from "../config/omnicodex-config-store.js";
import { spawnHidden } from "./hidden-child-process.js";

export interface HiddenCommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface HiddenCommandRunner {
  run(executable: string, args: readonly string[]): Promise<HiddenCommandResult>;
}

export interface WindowsAutostartManagerOptions {
  readonly nodeExecutable: string;
  readonly cliScript: string;
  readonly dataDirectory?: string;
  readonly taskName?: string;
  readonly windowsDirectory?: string;
  readonly runner?: HiddenCommandRunner;
}

export interface WindowsAutostartStatus {
  readonly enabled: boolean;
  readonly taskName: string;
  readonly launcherPath: string;
}

/** Registers a per-user logon task through a console-free WScript launcher. */
export class WindowsAutostartManager {
  readonly #nodeExecutable: string;
  readonly #cliScript: string;
  readonly #dataDirectory: string;
  readonly #taskName: string;
  readonly #schtasksExecutable: string;
  readonly #wscriptExecutable: string;
  readonly #runner: HiddenCommandRunner;

  constructor(options: WindowsAutostartManagerOptions) {
    const windowsDirectory = resolve(
      options.windowsDirectory ?? process.env.WINDIR ?? "C:\\Windows",
    );
    this.#nodeExecutable = resolve(options.nodeExecutable);
    this.#cliScript = resolve(options.cliScript);
    this.#dataDirectory = resolve(options.dataDirectory ?? omniCodexDataDirectory());
    this.#taskName = options.taskName ?? "\\OmniCodex\\Gateway";
    this.#schtasksExecutable = join(windowsDirectory, "System32", "schtasks.exe");
    this.#wscriptExecutable = join(windowsDirectory, "System32", "wscript.exe");
    this.#runner = options.runner ?? new SpawnHiddenCommandRunner();
  }

  get launcherPath(): string {
    return join(this.#dataDirectory, "autostart.vbs");
  }

  async status(): Promise<WindowsAutostartStatus> {
    const result = await this.#runner.run(this.#schtasksExecutable, [
      "/Query",
      "/TN",
      this.#taskName,
    ]);
    if (result.code !== 0 && result.code !== 1) {
      throw commandError("query", result);
    }
    return {
      enabled: result.code === 0,
      taskName: this.#taskName,
      launcherPath: this.launcherPath,
    };
  }

  async enable(): Promise<WindowsAutostartStatus> {
    await Promise.all([
      access(this.#nodeExecutable),
      access(this.#cliScript),
      access(this.#schtasksExecutable),
      access(this.#wscriptExecutable),
    ]);
    await mkdir(dirname(this.launcherPath), { recursive: true });
    const command = quoteCommand([this.#nodeExecutable, this.#cliScript, "start", "--json"]);
    const script = [
      "Option Explicit",
      `CreateObject("WScript.Shell").Run ${vbsString(command)}, 0, False`,
      "",
    ].join("\r\n");
    await writeFile(this.launcherPath, script, { encoding: "utf8", mode: 0o600 });
    const taskAction = quoteCommand([
      this.#wscriptExecutable,
      "//B",
      "//Nologo",
      this.launcherPath,
    ]);
    const result = await this.#runner.run(this.#schtasksExecutable, [
      "/Create",
      "/TN",
      this.#taskName,
      "/SC",
      "ONLOGON",
      "/RL",
      "LIMITED",
      "/TR",
      taskAction,
      "/F",
    ]);
    if (result.code !== 0) throw commandError("enable", result);
    return { enabled: true, taskName: this.#taskName, launcherPath: this.launcherPath };
  }

  async disable(): Promise<WindowsAutostartStatus> {
    const result = await this.#runner.run(this.#schtasksExecutable, [
      "/Delete",
      "/TN",
      this.#taskName,
      "/F",
    ]);
    if (result.code !== 0 && result.code !== 1) {
      throw commandError("disable", result);
    }
    return { enabled: false, taskName: this.#taskName, launcherPath: this.launcherPath };
  }
}

class SpawnHiddenCommandRunner implements HiddenCommandRunner {
  async run(executable: string, args: readonly string[]): Promise<HiddenCommandResult> {
    const child = spawnHidden(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (stdout.length < 65_536) stdout += chunk.toString().slice(0, 65_536 - stdout.length);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 65_536) stderr += chunk.toString().slice(0, 65_536 - stderr.length);
    });
    const code = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", resolveExit);
    });
    return { code, stdout, stderr };
  }
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
  const detail = (result.stderr || result.stdout).trim().slice(0, 2_048);
  return new Error(
    `Unable to ${operation} OmniCodex autostart (exit=${result.code ?? "null"})${detail.length === 0 ? "" : `: ${detail}`}`,
  );
}
