import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { RuntimeCandidate } from "../../domain/runtime.js";
import { canonicalJson } from "../safety/canonical-json.js";
import type {
  OwnedHiddenChildProcess,
  RecoveredWindowsProcessIdentity,
} from "../windows/hidden-child-process.js";
import { HiddenChildProcessBoundary } from "../windows/hidden-child-process.js";

export interface OwnedCodexAppServerDaemonIdentity {
  readonly pid: number;
  readonly instanceNonce: string;
  readonly startedAtUnixMs: number;
}

export interface OwnedCodexAppServerRecord {
  readonly schemaVersion: 1;
  readonly kind: "codex_app_server";
  readonly daemonPid: number;
  readonly daemonInstanceNonce: string;
  readonly daemonStartedAtUnixMs: number;
  readonly pid: number;
  readonly parentPid: number;
  readonly processNonce: string;
  readonly spawnedAtUnixMs: number;
  readonly executablePath: string;
  readonly processName: string;
  readonly processStartedAtIso: string;
  /** SHA-256 of the observed command line. The command itself may contain sensitive overrides. */
  readonly commandLineSha256: string;
  /** SHA-256 of the requested executable and argument vector; raw arguments are never persisted. */
  readonly launchShapeSha256: string;
  readonly candidateBuildSha256: string;
  readonly registeredAtUnixMs: number;
}

export interface CodexAppServerRegistration {
  readonly record: OwnedCodexAppServerRecord;
  readonly path: string;
  /** Called only after the exact child handle emitted `close`. Idempotent. */
  releaseAfterConfirmedExit(): Promise<void>;
}

export interface CodexAppServerOwnershipRegistry {
  register(input: {
    readonly child: OwnedHiddenChildProcess;
    readonly candidate: RuntimeCandidate;
    readonly launchArgs: readonly string[];
  }): Promise<CodexAppServerRegistration>;
}

export interface WindowsProcessIdentityReader {
  inspectWindowsProcess(pid: number): Promise<RecoveredWindowsProcessIdentity | undefined>;
}

export interface DurableCodexAppServerRegistryOptions {
  readonly dataDirectory: string;
  readonly daemon: OwnedCodexAppServerDaemonIdentity;
  readonly processIdentityReader?: WindowsProcessIdentityReader;
  readonly now?: () => number;
  /** Windows CIM can lag a just-created process or briefly time out under load. */
  readonly inspectionAttempts?: number;
  readonly inspectionRetryDelayMs?: number;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

/**
 * Persists one secret-free identity record per OmniCodex-owned App Server.
 * Per-process files avoid a shared JSON read/modify/write race when detached
 * workers and Bridge reconciliation start concurrently.
 */
export class DurableCodexAppServerRegistry implements CodexAppServerOwnershipRegistry {
  readonly #dataDirectory: string;
  readonly #daemon: OwnedCodexAppServerDaemonIdentity;
  readonly #processIdentityReader: WindowsProcessIdentityReader;
  readonly #now: () => number;
  readonly #inspectionAttempts: number;
  readonly #inspectionRetryDelayMs: number;
  readonly #sleep: (delayMs: number) => Promise<void>;

  constructor(options: DurableCodexAppServerRegistryOptions) {
    assertDaemonIdentity(options.daemon);
    this.#dataDirectory = resolve(options.dataDirectory);
    this.#daemon = options.daemon;
    this.#processIdentityReader = options.processIdentityReader ?? new HiddenChildProcessBoundary();
    this.#now = options.now ?? Date.now;
    this.#inspectionAttempts = options.inspectionAttempts ?? 10;
    this.#inspectionRetryDelayMs = options.inspectionRetryDelayMs ?? 50;
    this.#sleep =
      options.sleep ??
      ((delayMs) => new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs)));
    if (!Number.isSafeInteger(this.#inspectionAttempts) || this.#inspectionAttempts < 1) {
      throw new Error("Owned App Server inspection attempts are invalid");
    }
    if (!Number.isSafeInteger(this.#inspectionRetryDelayMs) || this.#inspectionRetryDelayMs < 0) {
      throw new Error("Owned App Server inspection retry delay is invalid");
    }
  }

  async register(input: {
    readonly child: OwnedHiddenChildProcess;
    readonly candidate: RuntimeCandidate;
    readonly launchArgs: readonly string[];
  }): Promise<CodexAppServerRegistration> {
    const pid = input.child.ownership.pid;
    if (pid === undefined || pid <= 0) {
      throw new Error("OWNED_CODEX_APP_SERVER_REGISTRY_UNVERIFIABLE:missing pid");
    }
    const observed = await this.#inspectWindowsProcessWithRetry(pid);
    if (observed === undefined) {
      throw new Error("OWNED_CODEX_APP_SERVER_REGISTRY_UNVERIFIABLE:process absent");
    }
    assertSpawnIdentity(observed, this.#daemon.pid, input.candidate.executablePath);
    const record: OwnedCodexAppServerRecord = {
      schemaVersion: 1,
      kind: "codex_app_server",
      daemonPid: this.#daemon.pid,
      daemonInstanceNonce: this.#daemon.instanceNonce,
      daemonStartedAtUnixMs: this.#daemon.startedAtUnixMs,
      pid,
      parentPid: observed.parentPid,
      processNonce: input.child.ownership.nonce,
      spawnedAtUnixMs: input.child.ownership.spawnedAtUnixMs,
      executablePath: observed.executablePath,
      processName: observed.name,
      processStartedAtIso: observed.startedAtIso,
      commandLineSha256: sha256(observed.commandLine),
      launchShapeSha256: sha256(
        canonicalJson({
          executablePath: resolve(input.candidate.executablePath),
          args: input.launchArgs,
        }),
      ),
      candidateBuildSha256: input.candidate.buildSha256,
      registeredAtUnixMs: this.#now(),
    };
    const directory = ownedCodexAppServerRegistryDirectory(this.#dataDirectory, this.#daemon);
    const path = join(directory, `${record.pid}-${record.processNonce}.json`);
    await atomicJsonWrite(path, record);
    let released = false;
    let releaseInFlight: Promise<void> | undefined;
    const releaseAfterConfirmedExit = (): Promise<void> => {
      if (released) return Promise.resolve();
      if (releaseInFlight !== undefined) return releaseInFlight;
      let operation!: Promise<void>;
      operation = (async () => {
        await removeExactRecord(path, record);
        released = true;
        // The exact per-process record is the ownership invariant. Removing
        // its now-empty parent directory is housekeeping and must not turn a
        // confirmed child exit into a false runtime-cleanup failure on Windows.
        await rmdir(directory).catch(() => undefined);
      })().finally(() => {
        if (releaseInFlight === operation) releaseInFlight = undefined;
      });
      releaseInFlight = operation;
      return operation;
    };
    // This listener is installed by the registry itself so even a caller that
    // fails between durable registration and receiving the return value cannot
    // strand a record after the exact child handle confirms exit.
    input.child.once("close", () => {
      void releaseAfterConfirmedExit().catch(() => undefined);
    });

    // Fence the write against a child that exited or a PID that was reused
    // while the durable record was being created.
    const confirmed = await this.#inspectWindowsProcessWithRetry(pid);
    if (confirmed === undefined || !recordMatchesObservedProcess(record, confirmed)) {
      await releaseAfterConfirmedExit();
      throw new Error(
        confirmed === undefined
          ? "OWNED_CODEX_APP_SERVER_REGISTRY_UNVERIFIABLE:process exited during registration"
          : "OWNED_CODEX_APP_SERVER_REGISTRY_UNVERIFIABLE:process identity changed during registration",
      );
    }

    return {
      record,
      path,
      releaseAfterConfirmedExit,
    };
  }

  async #inspectWindowsProcessWithRetry(
    pid: number,
  ): Promise<RecoveredWindowsProcessIdentity | undefined> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#inspectionAttempts; attempt += 1) {
      try {
        const observed = await this.#processIdentityReader.inspectWindowsProcess(pid);
        if (observed !== undefined) return observed;
        lastError = undefined;
      } catch (error) {
        lastError = error;
      }
      if (attempt < this.#inspectionAttempts && this.#inspectionRetryDelayMs > 0) {
        await this.#sleep(this.#inspectionRetryDelayMs * attempt);
      }
    }
    if (lastError !== undefined) throw lastError;
    return undefined;
  }
}

export function ownedCodexAppServerRegistryDirectory(
  dataDirectory: string,
  daemon: OwnedCodexAppServerDaemonIdentity,
): string {
  assertDaemonIdentity(daemon);
  const identityDigest = sha256(
    canonicalJson({
      pid: daemon.pid,
      instanceNonce: daemon.instanceNonce,
      startedAtUnixMs: daemon.startedAtUnixMs,
    }),
  ).slice(0, 32);
  return join(resolve(dataDirectory), "owned-app-servers", `${daemon.pid}-${identityDigest}`);
}

export async function readOwnedCodexAppServerRecord(
  path: string,
): Promise<OwnedCodexAppServerRecord> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error("OWNED_CODEX_APP_SERVER_REGISTRY_INVALID:unreadable record", { cause: error });
  }
  if (!isOwnedCodexAppServerRecord(value)) {
    throw new Error("OWNED_CODEX_APP_SERVER_REGISTRY_INVALID:record shape");
  }
  return value;
}

export function recordMatchesDaemon(
  record: OwnedCodexAppServerRecord,
  daemon: OwnedCodexAppServerDaemonIdentity,
): boolean {
  return (
    record.daemonPid === daemon.pid &&
    record.daemonInstanceNonce === daemon.instanceNonce &&
    record.daemonStartedAtUnixMs === daemon.startedAtUnixMs
  );
}

export function recordMatchesObservedProcess(
  record: OwnedCodexAppServerRecord,
  observed: RecoveredWindowsProcessIdentity,
): boolean {
  return (
    observed.pid === record.pid &&
    observed.parentPid === record.parentPid &&
    observed.name === record.processName &&
    sameWindowsPath(observed.executablePath, record.executablePath) &&
    observed.startedAtIso === record.processStartedAtIso &&
    sha256(observed.commandLine) === record.commandLineSha256
  );
}

export async function removeExactRecord(
  path: string,
  expected: OwnedCodexAppServerRecord,
): Promise<void> {
  let current: OwnedCodexAppServerRecord;
  try {
    current = await readOwnedCodexAppServerRecord(path);
  } catch (error) {
    if (errorCode((error as Error).cause) === "ENOENT") return;
    throw error;
  }
  if (canonicalJson(current) !== canonicalJson(expected)) {
    throw new Error("OWNED_CODEX_APP_SERVER_REGISTRY_CHANGED:refusing cleanup");
  }
  await unlinkWithWindowsRetry(path);
}

async function unlinkWithWindowsRetry(path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await unlink(path);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return;
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") ||
        attempt >= 5
      ) {
        throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10 * (attempt + 1)));
    }
  }
}

function assertSpawnIdentity(
  observed: RecoveredWindowsProcessIdentity,
  expectedParentPid: number,
  expectedExecutablePath: string,
): void {
  if (observed.parentPid !== expectedParentPid) {
    throw new Error("OWNED_CODEX_APP_SERVER_REGISTRY_UNVERIFIABLE:unexpected parent");
  }
  if (!sameWindowsPath(observed.executablePath, expectedExecutablePath)) {
    throw new Error("OWNED_CODEX_APP_SERVER_REGISTRY_UNVERIFIABLE:unexpected executable");
  }
}

function assertDaemonIdentity(identity: OwnedCodexAppServerDaemonIdentity): void {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) {
    throw new Error("Owned App Server daemon PID is invalid");
  }
  if (identity.instanceNonce.length < 16) {
    throw new Error("Owned App Server daemon nonce is invalid");
  }
  if (!Number.isSafeInteger(identity.startedAtUnixMs) || identity.startedAtUnixMs <= 0) {
    throw new Error("Owned App Server daemon start time is invalid");
  }
}

function isOwnedCodexAppServerRecord(value: unknown): value is OwnedCodexAppServerRecord {
  if (!isObject(value)) return false;
  return (
    value.schemaVersion === 1 &&
    value.kind === "codex_app_server" &&
    positiveInteger(value.daemonPid) &&
    typeof value.daemonInstanceNonce === "string" &&
    value.daemonInstanceNonce.length >= 16 &&
    positiveInteger(value.daemonStartedAtUnixMs) &&
    positiveInteger(value.pid) &&
    positiveInteger(value.parentPid) &&
    typeof value.processNonce === "string" &&
    value.processNonce.length >= 16 &&
    positiveInteger(value.spawnedAtUnixMs) &&
    typeof value.executablePath === "string" &&
    value.executablePath.length > 0 &&
    typeof value.processName === "string" &&
    value.processName.length > 0 &&
    typeof value.processStartedAtIso === "string" &&
    value.processStartedAtIso.length > 0 &&
    sha256Value(value.commandLineSha256) &&
    sha256Value(value.launchShapeSha256) &&
    sha256Value(value.candidateBuildSha256) &&
    positiveInteger(value.registeredAtUnixMs)
  );
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${canonicalJson(value)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await renameWithWindowsRetry(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function renameWithWindowsRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(errorCode(error) ?? "") ||
        attempt >= 5
      ) {
        throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10 * (attempt + 1)));
    }
  }
}

function sameWindowsPath(left: string, right: string): boolean {
  return resolve(left).toLocaleLowerCase("en-US") === resolve(right).toLocaleLowerCase("en-US");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Value(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

export function ownedCodexAppServerRecordFileName(record: OwnedCodexAppServerRecord): string {
  return `${record.pid}-${record.processNonce}.json`;
}
