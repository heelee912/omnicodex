import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { uptime } from "node:os";
import { dirname, join } from "node:path";
import {
  type OmniCodexDaemonState,
  omniCodexStatePath,
  readOmniCodexDaemonState,
} from "../infrastructure/config/omnicodex-config-store.js";
import { HiddenChildProcessBoundary } from "../infrastructure/windows/hidden-child-process.js";

export type ProcessStatus = "alive" | "absent" | "unknown";

export type UnreachableDaemonStateAssessment =
  | { readonly status: "definitely_stale"; readonly reason: "previous_boot" | "process_absent" }
  | { readonly status: "unverifiable"; readonly reason: "process_alive" | "process_unknown" };

export interface DaemonStateProbe {
  readonly nowUnixMs?: number;
  readonly uptimeSeconds?: number;
  readonly processStatus?: ProcessStatus;
}

export interface StaleStateQuarantineResult {
  readonly quarantined: boolean;
  readonly assessment: UnreachableDaemonStateAssessment;
  readonly quarantinePath?: string;
  readonly stateChanged?: boolean;
}

export interface StoppedStateRetirementResult {
  readonly retired: boolean;
  readonly retirementPath?: string;
  readonly stateChanged?: boolean;
}

const BOOT_TIME_TOLERANCE_MS = 60_000;
const LIFECYCLE_LOCK_WAIT_INTERVAL_MS = 50;
const PROCESS_START_TIME_TOLERANCE_MS = 5_000;

/**
 * Classifies only a daemon whose authenticated control channel already failed.
 * A state from before this Windows boot, or a current-boot state whose PID is
 * positively absent, is safe to quarantine. A live or unverifiable PID stays
 * fail-closed so PID reuse can never replace an unrelated process.
 */
export function assessUnreachableDaemonState(
  state: OmniCodexDaemonState,
  probe: DaemonStateProbe = {},
): UnreachableDaemonStateAssessment {
  const nowUnixMs = probe.nowUnixMs ?? Date.now();
  const uptimeSeconds = probe.uptimeSeconds ?? uptime();
  const bootedAtUnixMs = nowUnixMs - uptimeSeconds * 1_000;
  if (state.startedAtUnixMs < bootedAtUnixMs - BOOT_TIME_TOLERANCE_MS) {
    return { status: "definitely_stale", reason: "previous_boot" };
  }
  const processStatus = probe.processStatus ?? "unknown";
  if (processStatus === "absent") {
    return { status: "definitely_stale", reason: "process_absent" };
  }
  return {
    status: "unverifiable",
    reason: processStatus === "alive" ? "process_alive" : "process_unknown",
  };
}

export async function quarantineStaleDaemonState(
  expected: OmniCodexDaemonState,
  options: { readonly path?: string; readonly probe?: DaemonStateProbe } = {},
): Promise<StaleStateQuarantineResult> {
  const assessment = assessUnreachableDaemonState(expected, {
    ...options.probe,
    processStatus: options.probe?.processStatus ?? probeProcessStatus(expected.pid),
  });
  if (assessment.status !== "definitely_stale") return { quarantined: false, assessment };

  const path = options.path ?? omniCodexStatePath();
  const current = await readOmniCodexDaemonState(path);
  if (current === undefined || !sameDaemonIdentity(current, expected)) {
    return { quarantined: false, assessment, stateChanged: true };
  }
  const quarantinePath = join(
    dirname(path),
    `state.stale.${expected.startedAtUnixMs}.${randomUUID()}.json`,
  );
  await rename(path, quarantinePath);
  return { quarantined: true, assessment, quarantinePath };
}

/** Read-only PID existence probe. Signal 0 never terminates or alters the target process. */
export function probeProcessStatus(
  pid: number,
  signal: (pid: number, signal: 0) => boolean = process.kill,
): ProcessStatus {
  try {
    signal(pid, 0);
    return "alive";
  } catch (error) {
    return errorCode(error) === "ESRCH" ? "absent" : "unknown";
  }
}

/**
 * Retires only the exact state written by a daemon after it entered its
 * authenticated graceful-stop sequence and closed its control channel.
 */
export async function retireStoppedDaemonState(
  expected: OmniCodexDaemonState,
  options: { readonly path?: string } = {},
): Promise<StoppedStateRetirementResult> {
  if (expected.lifecycle !== "stopping") return { retired: false };
  const path = options.path ?? omniCodexStatePath();
  const current = await readOmniCodexDaemonState(path);
  if (current === undefined || !sameDaemonIdentity(current, expected)) {
    return { retired: false, stateChanged: true };
  }
  if (current.lifecycle !== "stopping") return { retired: false, stateChanged: true };
  const retirementPath = join(
    dirname(path),
    `state.stopped.${expected.startedAtUnixMs}.${randomUUID()}.json`,
  );
  await rename(path, retirementPath);
  return { retired: true, retirementPath };
}

/** Serializes lifecycle mutations across autostart and interactive CLI calls. */
export async function withDaemonLifecycleLock<T>(
  operation: () => Promise<T>,
  options: {
    readonly statePath?: string;
    readonly retryCount?: number;
    readonly ownerProcessStatus?: ProcessStatus;
    /** Test seam for exact PID-reuse detection. Undefined means identity is unavailable. */
    readonly probeOwnerProcessStartedAtUnixMs?: (pid: number) => Promise<number | undefined>;
    /** Wait for a valid live owner to release the lock; never steals it or adds a deadline. */
    readonly waitOnContention?: boolean;
  } = {},
): Promise<T> {
  const statePath = options.statePath ?? omniCodexStatePath();
  const lockPath = `${statePath}.lifecycle.lock`;
  const owner = {
    schemaVersion: 1,
    pid: process.pid,
    nonce: randomUUID(),
    createdAtUnixMs: Date.now(),
    processStartedAtUnixMs: currentProcessStartedAtUnixMs(),
  } as const;
  const retries = options.retryCount ?? 2;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let attemptsRemaining = retries + 1;
  while (attemptsRemaining > 0) {
    attemptsRemaining -= 1;
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const contention = await inspectLifecycleLockContention(
        lockPath,
        options.ownerProcessStatus,
        options.probeOwnerProcessStartedAtUnixMs,
      );
      if (contention === "recovered") continue;
      if (contention === "held" && options.waitOnContention === true) {
        // Waiting is intentionally deadline-free. The exact live owner remains
        // authoritative and releases the lock through its normal finally path.
        attemptsRemaining += 1;
        await delay(LIFECYCLE_LOCK_WAIT_INTERVAL_MS);
        continue;
      }
      throw new Error("Another OmniCodex lifecycle operation is already in progress");
    }
  }
  if (handle === undefined) throw new Error("Could not acquire the OmniCodex lifecycle lock");
  let operationResult: T | undefined;
  let operationError: unknown;
  try {
    operationResult = await operation();
  } catch (error) {
    operationError = error;
  }
  await handle.close().catch(() => undefined);
  let cleanupError: unknown;
  try {
    const current: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (isObject(current) && current.nonce === owner.nonce) await unlink(lockPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") cleanupError = error;
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  return operationResult as T;
}

async function inspectLifecycleLockContention(
  lockPath: string,
  ownerProcessStatus?: ProcessStatus,
  probeOwnerProcessStartedAtUnixMs: (
    pid: number,
  ) => Promise<number | undefined> = probeProcessStartedAtUnixMs,
): Promise<"recovered" | "held" | "invalid"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "recovered" : "invalid";
  }
  if (
    !isObject(parsed) ||
    !Number.isInteger(parsed.pid) ||
    (parsed.pid as number) <= 0 ||
    typeof parsed.createdAtUnixMs !== "number" ||
    typeof parsed.nonce !== "string"
  ) {
    return "invalid";
  }
  const bootedAtUnixMs = Date.now() - uptime() * 1_000;
  const fromPreviousBoot = parsed.createdAtUnixMs < bootedAtUnixMs - BOOT_TIME_TOLERANCE_MS;
  const processStatus = ownerProcessStatus ?? probeProcessStatus(parsed.pid as number);
  // A lifecycle operation may legitimately hold this lock for the full model-turn
  // drain timeout. Wall-clock age cannot prove abandonment and must never let a
  // second process fence out a still-live or unverifiable owner.
  if (!fromPreviousBoot && processStatus !== "absent") {
    const observedProcessStartedAtUnixMs = await probeOwnerProcessStartedAtUnixMs(
      parsed.pid as number,
    );
    const recordedProcessStartedAtUnixMs =
      typeof parsed.processStartedAtUnixMs === "number" &&
      Number.isSafeInteger(parsed.processStartedAtUnixMs) &&
      parsed.processStartedAtUnixMs >= 0
        ? parsed.processStartedAtUnixMs
        : undefined;
    if (
      observedProcessStartedAtUnixMs === undefined ||
      (recordedProcessStartedAtUnixMs === undefined
        ? observedProcessStartedAtUnixMs <= parsed.createdAtUnixMs + PROCESS_START_TIME_TOLERANCE_MS
        : Math.abs(observedProcessStartedAtUnixMs - recordedProcessStartedAtUnixMs) <=
          PROCESS_START_TIME_TOLERANCE_MS)
    ) {
      return "held";
    }
  }
  const quarantinePath = `${lockPath}.stale.${parsed.createdAtUnixMs}.${randomUUID()}`;
  try {
    await rename(lockPath, quarantinePath);
    return "recovered";
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "recovered";
    return "invalid";
  }
}

function currentProcessStartedAtUnixMs(): number {
  return Math.max(0, Math.floor(Date.now() - process.uptime() * 1_000));
}

async function probeProcessStartedAtUnixMs(pid: number): Promise<number | undefined> {
  if (pid === process.pid) return currentProcessStartedAtUnixMs();
  if (process.platform !== "win32") return undefined;
  try {
    const observed = await new HiddenChildProcessBoundary().inspectWindowsProcess(pid, {
      timeoutMs: 5_000,
    });
    if (observed === undefined) return undefined;
    const startedAtUnixMs = Date.parse(observed.startedAtIso);
    return Number.isSafeInteger(startedAtUnixMs) && startedAtUnixMs >= 0
      ? startedAtUnixMs
      : undefined;
  } catch {
    return undefined;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function sameDaemonIdentity(left: OmniCodexDaemonState, right: OmniCodexDaemonState): boolean {
  return (
    left.pid === right.pid &&
    left.instanceNonce === right.instanceNonce &&
    left.startedAtUnixMs === right.startedAtUnixMs &&
    left.controlPipe === right.controlPipe &&
    left.controlToken === right.controlToken
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}
