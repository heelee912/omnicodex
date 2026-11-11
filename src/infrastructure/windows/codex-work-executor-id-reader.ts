import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  HiddenChildProcessBoundary,
  type OwnedHiddenChildProcess,
} from "./hidden-child-process.js";

interface WorkExecutorProcess {
  readonly pid: number;
  readonly environmentId: string;
}

export interface CodexWorkExecutorIdReaderOptions {
  readonly inspect?: () => Promise<readonly WorkExecutorProcess[]>;
  readonly now?: () => number;
  readonly isAlive?: (pid: number) => boolean;
  readonly cacheTtlMs?: number;
}

/** Reads the identity of Desktop's already registered local Work executor. */
export class CodexWorkExecutorIdReader {
  readonly #inspect: () => Promise<readonly WorkExecutorProcess[]>;
  readonly #now: () => number;
  readonly #isAlive: (pid: number) => boolean;
  readonly #cacheTtlMs: number;
  #cached: (WorkExecutorProcess & { readonly observedAt: number }) | undefined;
  #inspection: Promise<string> | undefined;

  constructor(options: CodexWorkExecutorIdReaderOptions = {}) {
    this.#inspect = options.inspect ?? inspectRegisteredWorkExecutors;
    this.#now = options.now ?? Date.now;
    this.#isAlive = options.isAlive ?? isProcessAlive;
    this.#cacheTtlMs = options.cacheTtlMs ?? 30_000;
  }

  async read(): Promise<string> {
    const cached = this.#cached;
    if (
      cached !== undefined &&
      this.#now() - cached.observedAt < this.#cacheTtlMs &&
      this.#isAlive(cached.pid)
    ) {
      return cached.environmentId;
    }
    this.#inspection ??= this.#inspect()
      .then((processes) => {
        const identities = [...new Set(processes.map((process) => process.environmentId))];
        if (identities.length === 0) throw new Error("CODEX_WORK_EXECUTOR_UNAVAILABLE");
        if (identities.length !== 1) throw new Error("CODEX_WORK_EXECUTOR_AMBIGUOUS");
        const process = processes.find((item) => item.environmentId === identities[0]);
        if (process === undefined) throw new Error("CODEX_WORK_EXECUTOR_UNAVAILABLE");
        this.#cached = { ...process, observedAt: this.#now() };
        return process.environmentId;
      })
      .finally(() => {
        this.#inspection = undefined;
      });
    return this.#inspection;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const inspectWorkExecutorsScript = String.raw`
var service = GetObject('winmgmts:');
var processes = new Enumerator(service.ExecQuery('SELECT Name,ProcessId,CommandLine FROM Win32_Process'));
for (; !processes.atEnd(); processes.moveNext()) {
  var process = processes.item();
  if (String(process.Name || '').toLowerCase() != 'codex.exe') continue;
  var commandLine = String(process.CommandLine || '');
  if (!/(?:^|\s)exec-server(?:\s|$)/.test(commandLine)) continue;
  var identity = /--environment-id\s+([^\s"]+)/.exec(commandLine);
  if (identity) WScript.Echo(String(process.ProcessId) + '\t' + identity[1]);
}
`;

async function inspectRegisteredWorkExecutors(): Promise<readonly WorkExecutorProcess[]> {
  if (process.platform !== "win32") throw new Error("CODEX_WORK_EXECUTOR_WINDOWS_REQUIRED");
  const scriptPath = join(tmpdir(), `omnicodex-work-executor-${randomUUID()}.js`);
  await writeFile(scriptPath, inspectWorkExecutorsScript, { encoding: "utf8", flag: "wx" });
  try {
    const systemRoot = process.env.SystemRoot;
    if (systemRoot === undefined) throw new Error("CODEX_WORK_EXECUTOR_SYSTEM_ROOT_UNAVAILABLE");
    const cscript = join(resolve(systemRoot), "System32", "cscript.exe");
    const boundary = new HiddenChildProcessBoundary();
    const child = boundary.spawnHidden(cscript, ["//Nologo", scriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseWorkExecutorProcesses(await readHiddenProcessOutput(child, boundary));
  } finally {
    await unlink(scriptPath);
  }
}

function readHiddenProcessOutput(
  child: OwnedHiddenChildProcess,
  boundary: HiddenChildProcessBoundary,
): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      boundary.terminateOwnedHiddenChild(child);
    }, 10_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 32_768) boundary.terminateOwnedHiddenChild(child);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectOutput(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut || stdout.length > 32_768 || code !== 0 || stderr.length > 0) {
        rejectOutput(new Error("CODEX_WORK_EXECUTOR_INSPECTION_FAILED"));
      } else {
        resolveOutput(stdout);
      }
    });
  });
}

function parseWorkExecutorProcesses(output: string): readonly WorkExecutorProcess[] {
  return output
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\t([A-Za-z0-9_-]{8,256})$/u.exec(line);
      if (match === null) throw new Error("CODEX_WORK_EXECUTOR_INSPECTION_INVALID");
      return { pid: Number(match[1]), environmentId: match[2] as string };
    });
}
