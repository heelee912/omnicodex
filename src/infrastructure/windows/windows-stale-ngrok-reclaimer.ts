import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { OmniCodexDaemonState } from "../config/omnicodex-config-store.js";
import { HiddenChildProcessBoundary } from "./hidden-child-process.js";

export interface WindowsProcessObservation {
  readonly pid: number;
  readonly parentPid: number;
  readonly name: string;
  readonly executablePath: string;
  readonly commandLine: string;
  readonly startedAtIso: string;
}

export interface StaleNgrokReclaimRequest {
  readonly daemonState: OmniCodexDaemonState;
  readonly executablePath: string;
  readonly publicUrl: string;
}

export interface StaleNgrokReclaimResult {
  readonly status: "not_recorded" | "already_absent" | "reclaimed";
  readonly pid?: number;
}

export interface WindowsStaleNgrokReclaimerOptions {
  readonly inspectProcess?: (pid: number) => Promise<WindowsProcessObservation | undefined>;
  readonly terminateExactProcess?: (
    process: WindowsProcessObservation,
  ) => Promise<"terminated" | "absent" | "changed">;
  readonly readRuntimeConfig?: (path: string) => Promise<string>;
  readonly removeRuntimeConfig?: (path: string) => Promise<void>;
  readonly temporaryDirectory?: string;
  readonly childProcesses?: HiddenChildProcessBoundary;
  readonly systemRoot?: string;
  readonly timeoutMs?: number;
}

/**
 * Reclaims only an ngrok process whose persisted daemon relationship and live
 * Windows identity all match. Any uncertainty is fail-closed: a reused PID or
 * foreign process is never signalled.
 */
export class WindowsStaleNgrokReclaimer {
  readonly #inspectProcess: (pid: number) => Promise<WindowsProcessObservation | undefined>;
  readonly #terminateExactProcess: (
    process: WindowsProcessObservation,
  ) => Promise<"terminated" | "absent" | "changed">;
  readonly #readRuntimeConfig: (path: string) => Promise<string>;
  readonly #removeRuntimeConfig: (path: string) => Promise<void>;
  readonly #temporaryDirectory: string;

  constructor(options: WindowsStaleNgrokReclaimerOptions = {}) {
    const childProcesses = options.childProcesses ?? new HiddenChildProcessBoundary();
    const boundaryOptions = {
      ...(options.systemRoot === undefined ? {} : { systemRoot: options.systemRoot }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    };
    this.#inspectProcess =
      options.inspectProcess ??
      ((pid) => childProcesses.inspectWindowsProcess(pid, boundaryOptions));
    this.#terminateExactProcess =
      options.terminateExactProcess ??
      ((process) => childProcesses.terminateExactRecoveredWindowsProcess(process, boundaryOptions));
    this.#readRuntimeConfig = options.readRuntimeConfig ?? ((path) => readFile(path, "utf8"));
    this.#removeRuntimeConfig =
      options.removeRuntimeConfig ??
      ((path) => rm(dirname(path), { recursive: true, force: true }));
    this.#temporaryDirectory = resolve(options.temporaryDirectory ?? tmpdir());
  }

  async reclaim(request: StaleNgrokReclaimRequest): Promise<StaleNgrokReclaimResult> {
    const tunnelPid = request.daemonState.tunnelOwnership?.pid ?? request.daemonState.tunnel?.pid;
    if (
      tunnelPid === undefined ||
      (request.daemonState.tunnel?.kind !== "ngrok" &&
        request.daemonState.tunnelOwnership?.kind !== "ngrok")
    ) {
      return { status: "not_recorded" };
    }
    const observed = await this.#inspectProcess(tunnelPid);
    if (observed === undefined) {
      const configPath = durableOwnershipConfigPath(request, this.#temporaryDirectory);
      if (configPath !== undefined) {
        const config = await this.#readRuntimeConfig(configPath).catch((error: unknown) => {
          if (errorCode(error) === "ENOENT") return undefined;
          throw error;
        });
        if (config !== undefined && config !== 'version: "2"\nweb_addr: false\n') {
          throw new Error("STALE_NGROK_IDENTITY_UNVERIFIABLE:runtime config");
        }
        if (config !== undefined) await this.#removeRuntimeConfig(configPath);
      }
      return { status: "already_absent", pid: tunnelPid };
    }

    const configPath = validateExactOwnedNgrokProcess(observed, request, this.#temporaryDirectory);
    const config = await this.#readRuntimeConfig(configPath).catch(() => undefined);
    if (config !== 'version: "2"\nweb_addr: false\n') {
      throw new Error("STALE_NGROK_IDENTITY_UNVERIFIABLE:runtime config");
    }

    const terminated = await this.#terminateExactProcess(observed);
    if (terminated === "changed") {
      throw new Error("STALE_NGROK_IDENTITY_CHANGED:refusing signal");
    }
    await this.#removeRuntimeConfig(configPath);
    return {
      status: terminated === "terminated" ? "reclaimed" : "already_absent",
      pid: tunnelPid,
    };
  }
}

function durableOwnershipConfigPath(
  request: StaleNgrokReclaimRequest,
  temporaryDirectory: string,
): string | undefined {
  const state = request.daemonState;
  const ownership = state.tunnelOwnership;
  if (ownership === undefined) return undefined;
  const targetUrl = `http://127.0.0.1:${String(state.address?.port ?? 0)}`;
  if (
    ownership.kind !== "ngrok" ||
    ownership.pid !== (state.tunnel?.pid ?? ownership.pid) ||
    ownership.parentPid !== state.pid ||
    normalizeWindowsPath(ownership.executablePath) !==
      normalizeWindowsPath(request.executablePath) ||
    ownership.targetUrl !== targetUrl ||
    ownership.publicUrl !== request.publicUrl
  ) {
    throw new Error("STALE_NGROK_IDENTITY_MISMATCH:durable ownership");
  }
  assertOwnedRuntimeConfigPath(ownership.configPath, temporaryDirectory);
  return ownership.configPath;
}

export function validateExactOwnedNgrokProcess(
  observed: WindowsProcessObservation,
  request: StaleNgrokReclaimRequest,
  temporaryDirectory: string,
): string {
  const state = request.daemonState;
  const expectedPid = state.tunnelOwnership?.pid ?? state.tunnel?.pid;
  if (
    expectedPid === undefined ||
    observed.pid !== expectedPid ||
    observed.parentPid !== state.pid ||
    observed.name.toLocaleLowerCase("en-US") !== "ngrok.exe" ||
    normalizeWindowsPath(observed.executablePath) !== normalizeWindowsPath(request.executablePath)
  ) {
    throw new Error("STALE_NGROK_IDENTITY_MISMATCH:process");
  }
  const startedAtUnixMs = Date.parse(observed.startedAtIso);
  if (
    !Number.isFinite(startedAtUnixMs) ||
    startedAtUnixMs < state.startedAtUnixMs - 5_000 ||
    startedAtUnixMs > Date.now() + 5_000
  ) {
    throw new Error("STALE_NGROK_IDENTITY_MISMATCH:creation time");
  }
  const ownership = state.tunnelOwnership;
  if (
    ownership !== undefined &&
    (ownership.pid !== observed.pid ||
      ownership.parentPid !== state.pid ||
      normalizeWindowsPath(ownership.executablePath) !==
        normalizeWindowsPath(request.executablePath) ||
      Math.abs(ownership.spawnedAtUnixMs - startedAtUnixMs) > 5_000 ||
      ownership.publicUrl !== request.publicUrl)
  ) {
    throw new Error("STALE_NGROK_IDENTITY_MISMATCH:durable ownership");
  }

  const argumentsList = parseWindowsCommandLine(observed.commandLine);
  if (argumentsList.length !== 9) {
    throw new Error("STALE_NGROK_IDENTITY_MISMATCH:argument count");
  }
  const configPath = argumentsList[6] ?? "";
  const publicHostname = stablePublicHostname(request.publicUrl);
  const targetUrl = `http://127.0.0.1:${String(state.address?.port ?? 0)}`;
  const expected = [
    request.executablePath,
    "http",
    ownership?.targetUrl ?? targetUrl,
    "--domain",
    publicHostname,
    "--config",
    ownership?.configPath ?? configPath,
    "--log=stdout",
    "--log-format=json",
  ];
  if (
    argumentsList.some((value, index) =>
      index === 0
        ? normalizeWindowsPath(value) !== normalizeWindowsPath(expected[index] ?? "")
        : value !== expected[index],
    )
  ) {
    throw new Error("STALE_NGROK_IDENTITY_MISMATCH:command line");
  }
  assertOwnedRuntimeConfigPath(configPath, temporaryDirectory);
  return configPath;
}

export function parseWindowsCommandLine(value: string): readonly string[] {
  if (/\r|\n|\0/u.test(value)) throw new Error("Windows command line contains control bytes");
  const result: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /\s/u.test(value[index] ?? "")) index += 1;
    if (index >= value.length) break;
    let argument = "";
    let quoted = false;
    while (index < value.length) {
      const character = value[index] ?? "";
      if (!quoted && /\s/u.test(character)) break;
      if (character === "\\") {
        let slashCount = 0;
        while (value[index + slashCount] === "\\") slashCount += 1;
        const next = value[index + slashCount];
        if (next === '"') {
          argument += "\\".repeat(Math.floor(slashCount / 2));
          if (slashCount % 2 === 0) quoted = !quoted;
          else argument += '"';
          index += slashCount + 1;
          continue;
        }
        argument += "\\".repeat(slashCount);
        index += slashCount;
        continue;
      }
      if (character === '"') {
        quoted = !quoted;
        index += 1;
        continue;
      }
      argument += character;
      index += 1;
    }
    if (quoted) throw new Error("Windows command line has an unterminated quote");
    result.push(argument);
    while (index < value.length && /\s/u.test(value[index] ?? "")) index += 1;
  }
  return result;
}

function assertOwnedRuntimeConfigPath(path: string, temporaryDirectory: string): void {
  if (!isAbsolute(path) || basename(path).toLocaleLowerCase("en-US") !== "ngrok.yml") {
    throw new Error("STALE_NGROK_IDENTITY_MISMATCH:config path");
  }
  const directory = resolve(dirname(path));
  const relativeDirectory = relative(resolve(temporaryDirectory), directory);
  if (
    relativeDirectory === "" ||
    relativeDirectory.startsWith("..") ||
    isAbsolute(relativeDirectory) ||
    !/^omnicodex-ngrok-[A-Za-z0-9_-]+$/u.test(basename(directory))
  ) {
    throw new Error("STALE_NGROK_IDENTITY_MISMATCH:config ownership");
  }
}

function stablePublicHostname(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("STALE_NGROK_IDENTITY_MISMATCH:public URL");
  }
  return url.hostname;
}

function normalizeWindowsPath(value: string): string {
  return resolve(value).replaceAll("/", "\\").toLocaleLowerCase("en-US");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
