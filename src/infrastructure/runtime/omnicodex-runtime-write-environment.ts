import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, rename, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export type OmniCodexRuntimeOwnerProcessStatus = "alive" | "absent" | "unknown";

export interface OmniCodexRuntimeWriteEnvironmentSweepResult {
  readonly retiredStaleGenerations: number;
  readonly removedRetiredGenerations: number;
}

const scheduledRuntimeSweeps = new Map<string, Promise<void>>();

export interface OmniCodexRuntimeWriteEnvironmentOptions {
  readonly dataDirectory: string;
  readonly instanceId: string;
}

export interface OmniCodexRuntimeOwnerIdentity {
  readonly pid: number;
  readonly startedAtUnixMs: number;
  readonly instanceNonce: string;
}

export function omniCodexRuntimeInstanceId(owner: OmniCodexRuntimeOwnerIdentity): string {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    throw new Error("OmniCodex runtime owner pid is invalid");
  }
  if (!Number.isSafeInteger(owner.startedAtUnixMs) || owner.startedAtUnixMs <= 0) {
    throw new Error("OmniCodex runtime owner start time is invalid");
  }
  const nonce = owner.instanceNonce.trim();
  if (!/^[A-Za-z0-9_-]{12,}$/u.test(nonce)) {
    throw new Error("OmniCodex runtime owner nonce is invalid");
  }
  return `${owner.pid}-${owner.startedAtUnixMs}-${nonce.slice(0, 12)}`;
}

/**
 * Creates one writable state root for an OmniCodex-owned Codex child.
 * CODEX_HOME deliberately remains untouched so existing tasks and installed
 * capabilities stay read-visible. CODEX_SQLITE_HOME also remains untouched:
 * the installed runtime keeps live task and tool state there, so an empty
 * private database breaks native parity. Only process-local temporary files
 * are redirected. Full rollout tracing is disabled because it copies the
 * entire accumulated image history on every call.
 */
export async function prepareOmniCodexRuntimeWriteEnvironment(
  options: OmniCodexRuntimeWriteEnvironmentOptions,
): Promise<NodeJS.ProcessEnv> {
  const root = omniCodexRuntimeWriteRoot(options);
  const runtimeRoot = join(resolve(options.dataDirectory), "runtime");
  const engineGenerationsRoot = join(resolve(options.dataDirectory), "engine-generations");
  const temp = join(root, "temp");
  await Promise.all(
    [root, temp, engineGenerationsRoot].map((directory) => mkdir(directory, { recursive: true })),
  );
  // Retired generations never overlap this instance id. Sweep them outside
  // the activation path so a Windows filter driver or a just-closing child
  // cannot hold the lifecycle lock while files become delete-shareable. The
  // sweep is process-wide single-flight and deletes serially: hundreds of Web
  // sessions must not turn one stale-runtime cleanup into an I/O storm.
  scheduleRuntimeWriteEnvironmentSweep(runtimeRoot, options.instanceId);

  return {
    OMNICODEX_RUNTIME_ROOT: root,
    OMNICODEX_ENGINE_GENERATIONS_ROOT: engineGenerationsRoot,
    // An empty string still enables the native writer in cwd. Undefined must
    // override an inherited value so Node omits this variable from the child.
    CODEX_ROLLOUT_TRACE_ROOT: undefined,
    TEMP: temp,
    TMP: temp,
  };
}

/**
 * Removes only the exact process-owned scratch root after every child using it
 * has stopped. Tool results remain durable in their normal stores; this root
 * contains temporary files only. Pinned engine generations are stored outside
 * the process-owned scratch root and survive daemon restarts.
 */
export async function removeOmniCodexRuntimeWriteEnvironment(
  options: OmniCodexRuntimeWriteEnvironmentOptions,
): Promise<void> {
  const runtimeRoot = join(resolve(options.dataDirectory), "runtime");
  const root = omniCodexRuntimeWriteRoot(options);
  const retirementRoot = join(runtimeRoot, ".retired");
  await mkdir(retirementRoot, { recursive: true });
  const retired = join(retirementRoot, randomUUID());
  try {
    // Renaming the exact generation is the ownership fence: future launches
    // receive a new instance root immediately. Bounded removal completes here
    // so graceful shutdown does not leave an empty retirement directory.
    await rename(root, retired);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    if (isTransientRuntimeCleanupError(error)) {
      // Some Windows handles deny renaming their parent while they are still
      // closing. The generation id is never reused, so leaving this exact root
      // in place cannot collide with the next daemon. Retry its bounded
      // removal just as with an atomically retired root.
      await removeRetiredRuntimeWriteEnvironment(root);
      await removeRetirementRootIfEmpty(retirementRoot);
      return;
    }
    throw error;
  }
  await removeRetiredRuntimeWriteEnvironment(retired);
  await removeRetirementRootIfEmpty(retirementRoot);
}

export function omniCodexRuntimeWriteRoot(
  options: OmniCodexRuntimeWriteEnvironmentOptions,
): string {
  const instanceId = options.instanceId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(instanceId)) {
    throw new Error("OmniCodex runtime instance id is invalid");
  }
  return join(resolve(options.dataDirectory), "runtime", instanceId);
}

/**
 * Reclaims only scratch generations whose encoded owner PID is authoritatively
 * absent. A live or unprobeable owner is preserved. Direct generations are
 * first renamed below `.retired`, which is the ownership fence used by normal
 * graceful shutdown, and retired directories are then deleted one at a time.
 */
export async function sweepOmniCodexRuntimeWriteEnvironments(options: {
  readonly runtimeRoot: string;
  readonly currentInstanceId?: string;
  readonly probeOwnerProcess?: (pid: number) => OmniCodexRuntimeOwnerProcessStatus;
}): Promise<OmniCodexRuntimeWriteEnvironmentSweepResult> {
  const runtimeRoot = resolve(options.runtimeRoot);
  const retirementRoot = join(runtimeRoot, ".retired");
  const probeOwnerProcess = options.probeOwnerProcess ?? probeRuntimeOwnerProcess;
  let retiredStaleGenerations = 0;
  await mkdir(retirementRoot, { recursive: true });

  let runtimeEntries: Dirent<string>[];
  try {
    runtimeEntries = await readdir(runtimeRoot, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { retiredStaleGenerations: 0, removedRetiredGenerations: 0 };
    }
    throw error;
  }
  for (const entry of runtimeEntries) {
    if (
      !entry.isDirectory() ||
      entry.name === ".retired" ||
      entry.name === options.currentInstanceId
    ) {
      continue;
    }
    const ownerPid = runtimeOwnerPid(entry.name);
    if (ownerPid === undefined || probeOwnerProcess(ownerPid) !== "absent") continue;
    try {
      await rename(join(runtimeRoot, entry.name), join(retirementRoot, randomUUID()));
      retiredStaleGenerations += 1;
    } catch (error) {
      // A concurrent graceful shutdown/sweep may already have fenced this
      // exact generation. Windows may also keep a just-dead generation busy;
      // leave it for the next single-flight pass rather than widening scope.
      if (errorCode(error) !== "ENOENT" && !isTransientRuntimeCleanupError(error)) throw error;
    }
  }

  let entries: Dirent<string>[];
  try {
    entries = await readdir(retirementRoot, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { retiredStaleGenerations, removedRetiredGenerations: 0 };
    }
    throw error;
  }
  let removedRetiredGenerations = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !isUuid(entry.name)) continue;
    if (await removeRetiredRuntimeWriteEnvironment(join(retirementRoot, entry.name))) {
      removedRetiredGenerations += 1;
    }
  }
  await removeRetirementRootIfEmpty(retirementRoot);
  return { retiredStaleGenerations, removedRetiredGenerations };
}

async function removeRetiredRuntimeWriteEnvironment(path: string): Promise<boolean> {
  return rm(path, {
    force: true,
    recursive: true,
    // Keep each background sweep bounded. A later launch retries any directory
    // that is still held by Windows; activation never waits on these retries.
    maxRetries: 3,
    retryDelay: 100,
  }).then(
    () => true,
    () => false,
  );
}

async function removeRetirementRootIfEmpty(path: string): Promise<void> {
  await rmdir(path).catch((error) => {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EPERM" || code === "EBUSY") return;
    throw error;
  });
}

function scheduleRuntimeWriteEnvironmentSweep(
  runtimeRoot: string,
  currentInstanceId: string,
): void {
  const key = resolve(runtimeRoot).toLocaleLowerCase("en-US");
  if (scheduledRuntimeSweeps.has(key)) return;
  const sweep = sweepOmniCodexRuntimeWriteEnvironments({
    runtimeRoot,
    currentInstanceId,
  })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      if (scheduledRuntimeSweeps.get(key) === sweep) scheduledRuntimeSweeps.delete(key);
    });
  scheduledRuntimeSweeps.set(key, sweep);
}

function runtimeOwnerPid(instanceId: string): number | undefined {
  const match = /^(\d+)-(\d+)-[A-Za-z0-9_-]{12}$/u.exec(instanceId);
  if (match === null) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function probeRuntimeOwnerProcess(pid: number): OmniCodexRuntimeOwnerProcessStatus {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return errorCode(error) === "ESRCH" ? "absent" : "unknown";
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function isTransientRuntimeCleanupError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
}
