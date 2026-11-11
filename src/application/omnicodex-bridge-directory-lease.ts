import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

const LEASE_SCHEMA_VERSION = 1;
const DEFAULT_STALE_AFTER_MS = 120_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 50;
const WINDOWS_ATOMIC_RENAME_RETRY_MS = 1_000;

export const OMNICODEX_BRIDGE_DIRECTORY_LEASE_LOST =
  "OMNICODEX_BRIDGE_DIRECTORY_LEASE_LOST" as const;

export class OmniCodexBridgeDirectoryLeaseLostError extends Error {
  readonly code = OMNICODEX_BRIDGE_DIRECTORY_LEASE_LOST;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OmniCodexBridgeDirectoryLeaseLostError";
  }
}

export interface OmniCodexBridgeHeartbeatRegistration {
  cancel(): void;
  unref?(): void;
}

export interface OmniCodexBridgeHeartbeatScheduler {
  schedule(
    heartbeat: () => Promise<void>,
    intervalMs: number,
  ): OmniCodexBridgeHeartbeatRegistration;
}

export interface OmniCodexBridgeDirectoryLeaseOptions {
  readonly now?: () => number;
  readonly nonce?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly heartbeatScheduler?: OmniCodexBridgeHeartbeatScheduler;
  readonly staleAfterMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly waitTimeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly operationWaitMs?: number;
}

/**
 * An exclusive, renewable directory lease. The monotonically increasing
 * fencing token can be included in durable mutations that support fencing;
 * `assertOwned` is the fail-closed ownership check for mutations that do not.
 */
export interface OmniCodexBridgeDirectoryLease {
  readonly path: string;
  readonly nonce: string;
  readonly fencingToken: number;
  readonly acquiredAtUnixMs: number;
  readonly lost: boolean;
  readonly loss: OmniCodexBridgeDirectoryLeaseLostError | undefined;
  renew(): Promise<void>;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

interface ResolvedLeaseOptions {
  readonly now: () => number;
  readonly nonce: () => string;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly heartbeatScheduler: OmniCodexBridgeHeartbeatScheduler;
  readonly staleAfterMs: number;
  readonly heartbeatIntervalMs: number;
  readonly waitTimeoutMs: number | undefined;
  readonly retryDelayMs: number;
  readonly operationWaitMs: number | undefined;
}

interface LeaseOwner {
  readonly schemaVersion: 1;
  readonly nonce: string;
  readonly fencingToken: number;
  readonly holderDirectory: string;
  readonly acquiredAtUnixMs: number;
}

interface LeaseHeartbeat {
  readonly schemaVersion: 1;
  readonly nonce: string;
  readonly fencingToken: number;
  readonly renewedAtUnixMs: number;
}

interface LeaseFenceState {
  readonly schemaVersion: 1;
  readonly lastIssued: number;
}

interface OperationOwner {
  readonly schemaVersion: 1;
  readonly nonce: string;
  readonly acquiredAtUnixMs: number;
}

interface OperationLease {
  readonly nonce: string;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

interface LeaseSnapshot {
  readonly owner: LeaseOwner | undefined;
  readonly heartbeat: LeaseHeartbeat | undefined;
  readonly renewedAtUnixMs: number;
}

export async function acquireOmniCodexBridgeDirectoryLease(
  lockPath: string,
  options: OmniCodexBridgeDirectoryLeaseOptions = {},
): Promise<OmniCodexBridgeDirectoryLease> {
  const config = resolveLeaseOptions(options);
  const absolute = resolve(lockPath);
  const parent = dirname(absolute);
  await mkdir(parent, { recursive: true });
  const deadline =
    config.waitTimeoutMs === undefined ? undefined : config.now() + config.waitTimeoutMs;

  while (true) {
    try {
      await mkdir(absolute);
      return await initializeLease(absolute, config);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      await recoverStaleLease(absolute, config);
      if (deadline !== undefined && config.now() >= deadline) {
        throw new Error("Timed out waiting for the OmniCodex Bridge directory lease");
      }
      await config.sleep(config.retryDelayMs);
    }
  }
}

async function initializeLease(
  lockPath: string,
  config: ResolvedLeaseOptions,
): Promise<OmniCodexBridgeDirectoryLease> {
  const nonce = config.nonce();
  if (nonce.length === 0) throw new Error("Bridge directory lease nonce must not be empty");
  const acquiredAtUnixMs = config.now();
  const holderDirectory = `holder-${createHash("sha256").update(nonce).digest("hex")}`;
  const holderPath = join(lockPath, holderDirectory);

  try {
    await mkdir(holderPath);
    const fencingToken = await issueFencingToken(lockPath);
    const owner: LeaseOwner = {
      schemaVersion: LEASE_SCHEMA_VERSION,
      nonce,
      fencingToken,
      holderDirectory,
      acquiredAtUnixMs,
    };
    await atomicJsonWrite(join(holderPath, "heartbeat.json"), {
      schemaVersion: LEASE_SCHEMA_VERSION,
      nonce,
      fencingToken,
      renewedAtUnixMs: acquiredAtUnixMs,
    } satisfies LeaseHeartbeat);
    await atomicJsonWrite(join(lockPath, "owner.json"), owner);
    return new DirectoryLease(lockPath, owner, config);
  } catch (error) {
    await removeLeaseDirectoryIfUnclaimed(lockPath, nonce).catch(() => undefined);
    throw error;
  }
}

class DirectoryLease implements OmniCodexBridgeDirectoryLease {
  readonly path: string;
  readonly nonce: string;
  readonly fencingToken: number;
  readonly acquiredAtUnixMs: number;
  readonly #owner: LeaseOwner;
  readonly #config: ResolvedLeaseOptions;
  readonly #heartbeat: OmniCodexBridgeHeartbeatRegistration;
  #released = false;
  #loss: OmniCodexBridgeDirectoryLeaseLostError | undefined;
  #renewal: Promise<void> | undefined;

  constructor(path: string, owner: LeaseOwner, config: ResolvedLeaseOptions) {
    this.path = path;
    this.nonce = owner.nonce;
    this.fencingToken = owner.fencingToken;
    this.acquiredAtUnixMs = owner.acquiredAtUnixMs;
    this.#owner = owner;
    this.#config = config;
    this.#heartbeat = config.heartbeatScheduler.schedule(async () => {
      try {
        await this.renew();
      } catch {
        // `renew` records the first loss reason. Timer callbacks must never
        // become unhandled rejections.
      }
    }, config.heartbeatIntervalMs);
    this.#heartbeat.unref?.();
  }

  get lost(): boolean {
    return this.#loss !== undefined;
  }

  get loss(): OmniCodexBridgeDirectoryLeaseLostError | undefined {
    return this.#loss;
  }

  async renew(): Promise<void> {
    this.#throwIfUnavailable();
    if (this.#renewal !== undefined) return this.#renewal;
    const renewal = this.#renewOnce();
    this.#renewal = renewal;
    try {
      await renewal;
    } finally {
      if (this.#renewal === renewal) this.#renewal = undefined;
    }
  }

  async assertOwned(): Promise<void> {
    await this.renew();
    this.#throwIfUnavailable();
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    this.#heartbeat.cancel();
    await this.#renewal?.catch(() => undefined);

    const operation = await acquireOperationLease(this.path, this.#config).catch(() => undefined);
    if (operation === undefined) return;
    let quarantine: string | undefined;
    try {
      const owner = await readLeaseOwner(this.path).catch(() => undefined);
      if (!sameOwner(owner, this.#owner)) return;
      quarantine = siblingPath(this.path, `released.${this.nonce}.${this.#config.nonce()}`);
      await rename(this.path, quarantine);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    } finally {
      // Once the lease directory has been renamed, the operation gate moves
      // with it. Releasing against the original path could target a successor.
      if (quarantine === undefined) await operation.release();
    }
    if (quarantine !== undefined) {
      await rm(quarantine, { recursive: true, force: true });
    }
  }

  async #renewOnce(): Promise<void> {
    let operation: OperationLease | undefined;
    try {
      operation = await acquireOperationLease(this.path, this.#config);
      const before = await readLeaseOwner(this.path);
      if (!sameOwner(before, this.#owner)) {
        throw new Error("Bridge directory lease owner changed");
      }
      const fence = await readFenceState(siblingPath(this.path, "fence.json"));
      if (fence.lastIssued !== this.fencingToken) {
        throw new Error("Bridge directory lease was superseded by a newer fencing token");
      }
      const heartbeatPath = join(this.path, this.#owner.holderDirectory, "heartbeat.json");
      await atomicJsonWrite(heartbeatPath, {
        schemaVersion: LEASE_SCHEMA_VERSION,
        nonce: this.nonce,
        fencingToken: this.fencingToken,
        renewedAtUnixMs: this.#config.now(),
      } satisfies LeaseHeartbeat);
      const after = await readLeaseOwner(this.path);
      if (!sameOwner(after, this.#owner)) {
        throw new Error("Bridge directory lease owner changed during heartbeat");
      }
      const heartbeat = await readLeaseHeartbeat(this.path, after);
      if (!sameHeartbeatOwner(heartbeat, this.#owner)) {
        throw new Error("Bridge directory lease heartbeat readback did not match its owner");
      }
      await operation.assertOwned();
    } catch (error) {
      throw this.#markLost("OmniCodex Bridge directory lease was lost", error);
    } finally {
      await operation?.release().catch(() => undefined);
    }
  }

  #markLost(message: string, cause: unknown): OmniCodexBridgeDirectoryLeaseLostError {
    if (this.#loss === undefined) {
      this.#loss = new OmniCodexBridgeDirectoryLeaseLostError(message, { cause });
      this.#heartbeat.cancel();
    }
    return this.#loss;
  }

  #throwIfUnavailable(): void {
    if (this.#loss !== undefined) throw this.#loss;
    if (this.#released) {
      throw new OmniCodexBridgeDirectoryLeaseLostError(
        "OmniCodex Bridge directory lease has already been released",
      );
    }
  }
}

async function recoverStaleLease(lockPath: string, config: ResolvedLeaseOptions): Promise<boolean> {
  const initial = await readLeaseSnapshot(lockPath, config.now());
  if (!isStale(initial.renewedAtUnixMs, config)) return false;

  const operation = await tryAcquireOperationLease(lockPath, config);
  if (operation !== undefined) {
    let quarantine: string | undefined;
    try {
      const confirmed = await readLeaseSnapshot(lockPath, config.now());
      if (!isStale(confirmed.renewedAtUnixMs, config)) return false;
      if (!sameSnapshotOwner(initial.owner, confirmed.owner)) return false;
      quarantine = siblingPath(lockPath, `stale.${config.nonce()}`);
      await rename(lockPath, quarantine);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    } finally {
      if (quarantine === undefined) await operation.release();
    }
    if (quarantine !== undefined) {
      await rm(quarantine, { recursive: true, force: true });
      return true;
    }
    return false;
  }

  // A crashed process can leave the operation gate behind. It is safe to
  // quarantine only when both the owner lease and the operation gate are stale.
  const gateRenewedAt = await operationGateTimestamp(lockPath, config.now());
  if (!isStale(gateRenewedAt, config)) return false;
  const confirmed = await readLeaseSnapshot(lockPath, config.now());
  if (!isStale(confirmed.renewedAtUnixMs, config)) return false;
  if (!sameSnapshotOwner(initial.owner, confirmed.owner)) return false;

  const quarantine = siblingPath(lockPath, `stale-gate.${config.nonce()}`);
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

async function issueFencingToken(lockPath: string): Promise<number> {
  const fencePath = siblingPath(lockPath, "fence.json");
  const previous = await readFenceState(fencePath).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  });
  const next = (previous?.lastIssued ?? 0) + 1;
  if (!Number.isSafeInteger(next) || next <= 0) {
    throw new Error("OmniCodex Bridge directory lease fencing token overflow");
  }
  await atomicJsonWrite(fencePath, {
    schemaVersion: LEASE_SCHEMA_VERSION,
    lastIssued: next,
  } satisfies LeaseFenceState);
  return next;
}

async function acquireOperationLease(
  lockPath: string,
  config: ResolvedLeaseOptions,
): Promise<OperationLease> {
  const deadline =
    config.operationWaitMs === undefined ? undefined : config.now() + config.operationWaitMs;
  while (true) {
    const operation = await tryAcquireOperationLease(lockPath, config);
    if (operation !== undefined) return operation;
    if (deadline !== undefined && config.now() >= deadline) {
      throw new Error("Timed out waiting for the Bridge directory lease operation gate");
    }
    await config.sleep(
      config.operationWaitMs === undefined
        ? config.retryDelayMs
        : Math.min(config.retryDelayMs, config.operationWaitMs),
    );
  }
}

async function tryAcquireOperationLease(
  lockPath: string,
  config: ResolvedLeaseOptions,
): Promise<OperationLease | undefined> {
  const gatePath = join(lockPath, ".operation");
  const nonce = config.nonce();
  const ownerPath = operationOwnerPath(gatePath, nonce);
  try {
    await mkdir(gatePath);
  } catch (error) {
    if (errorCode(error) === "EEXIST" || errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  const owner: OperationOwner = {
    schemaVersion: LEASE_SCHEMA_VERSION,
    nonce,
    acquiredAtUnixMs: config.now(),
  };
  try {
    await atomicJsonWrite(ownerPath, owner);
  } catch (error) {
    await removeOperationGateIfOwned(gatePath, nonce).catch(() => undefined);
    throw error;
  }
  let released = false;
  return {
    nonce,
    assertOwned: async () => {
      const current = await readOperationOwnerFile(ownerPath);
      if (current.nonce !== nonce) {
        throw new Error("Bridge directory lease operation gate was lost");
      }
    },
    release: async () => {
      if (released) return;
      released = true;
      await removeOperationGateIfOwned(gatePath, nonce);
    },
  };
}

async function removeOperationGateIfOwned(gatePath: string, nonce: string): Promise<void> {
  const ownerPath = operationOwnerPath(gatePath, nonce);
  const owner = await readOperationOwnerFile(ownerPath).catch(() => undefined);
  if (owner?.nonce !== nonce) return;
  await rm(ownerPath, { force: true });
  await rmdir(gatePath).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTEMPTY") throw error;
  });
}

async function removeLeaseDirectoryIfUnclaimed(lockPath: string, nonce: string): Promise<void> {
  const holderDirectory = `holder-${createHash("sha256").update(nonce).digest("hex")}`;
  const holder = await stat(join(lockPath, holderDirectory)).catch(() => undefined);
  if (holder === undefined) return;
  const owner = await readLeaseOwner(lockPath).catch(() => undefined);
  if (owner !== undefined && owner.nonce !== nonce) return;
  const quarantine = siblingPath(lockPath, `failed.${nonce}`);
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  await rm(quarantine, { recursive: true, force: true });
}

async function readLeaseSnapshot(lockPath: string, fallbackNow: number): Promise<LeaseSnapshot> {
  const owner = await readLeaseOwner(lockPath).catch(() => undefined);
  const heartbeat = owner
    ? await readLeaseHeartbeat(lockPath, owner).catch(() => undefined)
    : undefined;
  const heartbeatStat = owner
    ? await stat(join(lockPath, owner.holderDirectory, "heartbeat.json")).catch(() => undefined)
    : undefined;
  const ownerStat = await stat(join(lockPath, "owner.json")).catch(() => undefined);
  const lockStat = await stat(lockPath).catch(() => undefined);
  return {
    owner,
    heartbeat,
    renewedAtUnixMs:
      heartbeat?.renewedAtUnixMs ??
      heartbeatStat?.mtimeMs ??
      owner?.acquiredAtUnixMs ??
      ownerStat?.mtimeMs ??
      lockStat?.mtimeMs ??
      fallbackNow,
  };
}

async function operationGateTimestamp(lockPath: string, fallbackNow: number): Promise<number> {
  const gatePath = join(lockPath, ".operation");
  const ownerEntry = await findOperationOwnerEntry(gatePath).catch(() => undefined);
  const owner = ownerEntry
    ? await readOperationOwnerFile(join(gatePath, ownerEntry)).catch(() => undefined)
    : undefined;
  const ownerStat = ownerEntry
    ? await stat(join(gatePath, ownerEntry)).catch(() => undefined)
    : undefined;
  const gateStat = await stat(gatePath).catch(() => undefined);
  return owner?.acquiredAtUnixMs ?? ownerStat?.mtimeMs ?? gateStat?.mtimeMs ?? fallbackNow;
}

async function readLeaseOwner(lockPath: string): Promise<LeaseOwner> {
  const value: unknown = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
  if (
    !isObject(value) ||
    value.schemaVersion !== LEASE_SCHEMA_VERSION ||
    typeof value.nonce !== "string" ||
    value.nonce.length === 0 ||
    !isPositiveSafeInteger(value.fencingToken) ||
    typeof value.holderDirectory !== "string" ||
    !/^holder-[a-f0-9]{64}$/u.test(value.holderDirectory) ||
    !isFiniteTimestamp(value.acquiredAtUnixMs)
  ) {
    throw new Error("Invalid OmniCodex Bridge directory lease owner");
  }
  return value as unknown as LeaseOwner;
}

async function readLeaseHeartbeat(lockPath: string, owner: LeaseOwner): Promise<LeaseHeartbeat> {
  const value: unknown = JSON.parse(
    await readFile(join(lockPath, owner.holderDirectory, "heartbeat.json"), "utf8"),
  );
  if (
    !isObject(value) ||
    value.schemaVersion !== LEASE_SCHEMA_VERSION ||
    typeof value.nonce !== "string" ||
    !isPositiveSafeInteger(value.fencingToken) ||
    !isFiniteTimestamp(value.renewedAtUnixMs)
  ) {
    throw new Error("Invalid OmniCodex Bridge directory lease heartbeat");
  }
  return value as unknown as LeaseHeartbeat;
}

async function readFenceState(path: string): Promise<LeaseFenceState> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    !isObject(value) ||
    value.schemaVersion !== LEASE_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.lastIssued) ||
    (value.lastIssued as number) < 0
  ) {
    throw new Error("Invalid OmniCodex Bridge directory lease fence state");
  }
  return value as unknown as LeaseFenceState;
}

async function readOperationOwnerFile(path: string): Promise<OperationOwner> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    !isObject(value) ||
    value.schemaVersion !== LEASE_SCHEMA_VERSION ||
    typeof value.nonce !== "string" ||
    value.nonce.length === 0 ||
    !isFiniteTimestamp(value.acquiredAtUnixMs)
  ) {
    throw new Error("Invalid OmniCodex Bridge directory lease operation owner");
  }
  return value as unknown as OperationOwner;
}

async function findOperationOwnerEntry(gatePath: string): Promise<string | undefined> {
  const entries = (await readdir(gatePath))
    .filter((entry) => /^owner-[a-f0-9]{64}\.json$/u.test(entry))
    .sort();
  if (entries.length > 1) {
    throw new Error("Invalid OmniCodex Bridge directory lease operation gate");
  }
  return entries[0];
}

function operationOwnerPath(gatePath: string, nonce: string): string {
  const digest = createHash("sha256").update(nonce).digest("hex");
  return join(gatePath, `owner-${digest}.json`);
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  const absolute = resolve(path);
  const temporary = join(dirname(absolute), `.${basename(absolute)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await atomicRename(temporary, absolute);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function atomicRename(source: string, destination: string): Promise<void> {
  const deadline = Date.now() + WINDOWS_ATOMIC_RENAME_RETRY_MS;
  let retryDelayMs = 5;
  while (true) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (
        process.platform !== "win32" ||
        (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") ||
        Date.now() + retryDelayMs > deadline
      ) {
        throw error;
      }
      await defaultSleep(retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, 100);
    }
  }
}

function resolveLeaseOptions(options: OmniCodexBridgeDirectoryLeaseOptions): ResolvedLeaseOptions {
  const staleAfterMs = positiveDuration(options.staleAfterMs, DEFAULT_STALE_AFTER_MS, "stale");
  const heartbeatIntervalMs = positiveDuration(
    options.heartbeatIntervalMs,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
    "heartbeat interval",
  );
  if (heartbeatIntervalMs >= staleAfterMs) {
    throw new Error("Bridge directory lease heartbeat interval must be shorter than stale timeout");
  }
  return {
    now: options.now ?? Date.now,
    nonce: options.nonce ?? randomUUID,
    sleep: options.sleep ?? defaultSleep,
    heartbeatScheduler: options.heartbeatScheduler ?? defaultHeartbeatScheduler,
    staleAfterMs,
    heartbeatIntervalMs,
    waitTimeoutMs: optionalPositiveDuration(options.waitTimeoutMs, "wait timeout"),
    retryDelayMs: positiveDuration(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS, "retry delay"),
    operationWaitMs: optionalPositiveDuration(options.operationWaitMs, "operation wait"),
  };
}

const defaultHeartbeatScheduler: OmniCodexBridgeHeartbeatScheduler = {
  schedule: (heartbeat, intervalMs) => {
    const timer = setInterval(() => {
      void heartbeat();
    }, intervalMs);
    return {
      cancel: () => clearInterval(timer),
      unref: () => timer.unref(),
    };
  },
};

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function positiveDuration(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`Bridge directory lease ${name} must be a positive finite number`);
  }
  return resolved;
}

function optionalPositiveDuration(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Bridge directory lease ${name} must be a positive finite number`);
  }
  return value;
}

function isStale(renewedAtUnixMs: number, config: ResolvedLeaseOptions): boolean {
  return config.now() - renewedAtUnixMs >= config.staleAfterMs;
}

function sameOwner(actual: LeaseOwner | undefined, expected: LeaseOwner): boolean {
  return (
    actual?.nonce === expected.nonce &&
    actual.fencingToken === expected.fencingToken &&
    actual.holderDirectory === expected.holderDirectory
  );
}

function sameHeartbeatOwner(heartbeat: LeaseHeartbeat, owner: LeaseOwner): boolean {
  return heartbeat.nonce === owner.nonce && heartbeat.fencingToken === owner.fencingToken;
}

function sameSnapshotOwner(left: LeaseOwner | undefined, right: LeaseOwner | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return sameOwner(left, right);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function siblingPath(path: string, suffix: string): string {
  const parent = dirname(resolve(path));
  const sibling = join(parent, `${basename(path)}.${suffix}`);
  assertChildPath(parent, sibling);
  return sibling;
}

function assertChildPath(parent: string, child: string): void {
  const normalizedParent = `${resolve(parent)}${sep}`.toLocaleLowerCase("en-US");
  const normalizedChild = resolve(child).toLocaleLowerCase("en-US");
  if (!normalizedChild.startsWith(normalizedParent)) {
    throw new Error("Refusing to mutate a Bridge lease outside its parent directory");
  }
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
