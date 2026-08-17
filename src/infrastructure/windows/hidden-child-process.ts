import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export type HiddenSpawnOptions = Omit<SpawnOptions, "shell" | "windowsHide">;

const ownedHiddenChildBrand: unique symbol = Symbol("omnicodex.owned-hidden-child");

export interface HiddenChildOwnership {
  readonly nonce: string;
  readonly executable: string;
  readonly spawnedAtUnixMs: number;
  readonly pid?: number;
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

/**
 * Binds child creation and termination to one in-memory ownership registry.
 * Unknown, copied, closed, or identity-mismatched handles fail closed.
 */
export class HiddenChildProcessBoundary {
  readonly #owned = new WeakMap<ChildProcess, OwnershipRecord>();
  readonly #spawn: HiddenSpawnImplementation;

  constructor(
    spawnImplementation: HiddenSpawnImplementation = (executable, args, options) =>
      spawn(executable, [...args], options),
  ) {
    this.#spawn = spawnImplementation;
  }

  spawnHidden(
    executable: string,
    args: readonly string[],
    options: HiddenSpawnOptions = {},
  ): OwnedHiddenChildProcess {
    const child = this.#spawn(executable, args, {
      ...options,
      shell: false,
      windowsHide: true,
    });
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
    return nativeChild.kill(signal);
  }
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

/** Returns false without signaling when the handle cannot be proven owned. */
export function terminateOwnedHiddenChild(
  child: OwnedHiddenChildProcess,
  signal: NodeJS.Signals | number = "SIGTERM",
): boolean {
  return defaultBoundary.terminateOwnedHiddenChild(child, signal);
}
