import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalJson } from "../safety/canonical-json.js";
import {
  HiddenChildProcessBoundary,
  type RecoveredWindowsProcessIdentity,
} from "../windows/hidden-child-process.js";

const SCHEMA_VERSION = 1;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_LEASE_DURATION_MS = 20_000;
const DEFAULT_RETRY_DELAY_MS = 25;
const DEFAULT_MUTEX_BOOTSTRAP_GRACE_MS = 2_000;

// The Node REPL lane is a cross-process execution mutex, not persistent user
// state.  An unknown operation must still remain unknown for an exact retry,
// but once its owning process is gone it must not permanently fence every
// later, independently identified Code Mode operation.  Any lease that also
// names a persistent resource (file, workspace, thread, browser surface, ...)
// continues to fail closed through the normal resource fence.
const OPERATION_SCOPED_UNKNOWN_RESOURCE_DIGESTS = new Set([digest("0:lane:node_repl")]);

export interface DurableNativeResourceLeaseDaemonIdentity {
  readonly pid: number;
  readonly instanceNonce: string;
  readonly startedAtUnixMs: number;
}

export interface DurableNativeResourceProcessIdentityReader {
  inspectWindowsProcess(pid: number): Promise<RecoveredWindowsProcessIdentity | undefined>;
}

export interface DurableNativeResourceLeaseCoordinatorOptions {
  readonly dataDirectory: string;
  readonly daemon: DurableNativeResourceLeaseDaemonIdentity;
  readonly snapshotPath?: string;
  readonly processIdentityReader?: DurableNativeResourceProcessIdentityReader;
  readonly now?: () => number;
  readonly nonce?: () => string;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly heartbeatIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly acquireTimeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly mutexBootstrapGraceMs?: number;
  readonly maxCompletions?: number;
}

export interface DurableNativeResourceLeaseRequest {
  readonly operationId: string;
  readonly ownerId: string;
  readonly sessionId: string;
  readonly fingerprint: string;
  /** Canonical scheduler keys. Only their SHA-256 digests are persisted. */
  readonly resourceKeys: readonly string[];
  readonly signal?: AbortSignal;
}

export type DurableNativeResourceLeaseTerminal =
  | "settled"
  | "abandoned_before_dispatch"
  | "outcome_unknown";

export interface DurableNativeResourceLease {
  readonly operationId: string;
  readonly generation: number;
  readonly resourceDigests: readonly string[];
  markDispatched(): Promise<void>;
  abandonBeforeDispatch(): Promise<void>;
  settle(): Promise<void>;
  markOutcomeUnknown(reason?: string): Promise<void>;
}

export type DurableNativeResourceLeaseAcquisition =
  | { readonly kind: "acquired"; readonly lease: DurableNativeResourceLease }
  | {
      readonly kind: "join";
      readonly operationId: string;
      readonly completion: Promise<DurableNativeResourceLeaseTerminal>;
    }
  | { readonly kind: "settled"; readonly operationId: string }
  | { readonly kind: "outcome_unknown"; readonly operationId: string };

export interface DurableNativeResourceLeaseCoordinatorLike {
  acquire(input: DurableNativeResourceLeaseRequest): Promise<DurableNativeResourceLeaseAcquisition>;
  interruptOwnedOperations(reason?: string): Promise<number>;
  recoverUnknown?(
    operationId: string,
    proveSettled: (lease: DurableNativeResourceLeaseView) => Promise<boolean>,
  ): Promise<boolean>;
  recoverUnknownResources?(
    resourceKeys: readonly string[],
    proveSettled: (lease: DurableNativeResourceLeaseView) => Promise<boolean>,
  ): Promise<number>;
}

export interface DurableNativeResourceLeaseView {
  readonly operationDigest: string;
  readonly fingerprintDigest: string;
  readonly resourceDigests: readonly string[];
  readonly generation: number;
  readonly state: "prepared" | "dispatched" | "outcome_unknown";
  readonly owner: PersistedCoordinatorOwner;
  readonly acquiredAtUnixMs: number;
  readonly heartbeatAtUnixMs: number;
  readonly expiresAtUnixMs: number;
  readonly dispatchedAtUnixMs?: number;
  readonly outcomeUnknownAtUnixMs?: number;
}

export class DurableNativeResourceBusyError extends Error {
  readonly code = "NATIVE_RESOURCE_BUSY";

  constructor(message = "Native resource is held by another durable operation") {
    super(message);
    this.name = "DurableNativeResourceBusyError";
  }
}

export class DurableNativeResourceOutcomeUnknownError extends Error {
  readonly code = "NATIVE_RESOURCE_OUTCOME_UNKNOWN";

  constructor(message = "Native resource is fenced by an operation with an unknown outcome") {
    super(message);
    this.name = "DurableNativeResourceOutcomeUnknownError";
  }
}

export class DurableNativeOperationConflictError extends Error {
  readonly code = "NATIVE_OPERATION_ID_CONFLICT";

  constructor() {
    super("Native operationId was already bound to a different operation");
    this.name = "DurableNativeOperationConflictError";
  }
}

export class DurableNativeResourceLeaseLostError extends Error {
  readonly code = "NATIVE_RESOURCE_LEASE_LOST";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DurableNativeResourceLeaseLostError";
  }
}

export class DurableNativeResourceSnapshotError extends Error {
  readonly code = "NATIVE_RESOURCE_SNAPSHOT_INVALID";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DurableNativeResourceSnapshotError";
  }
}

export interface PersistedCoordinatorOwner {
  readonly pid: number;
  readonly instanceNonce: string;
  readonly daemonStartedAtUnixMs: number;
  readonly processStartedAtIso: string;
}

interface PersistedLease {
  readonly operationDigest: string;
  readonly fingerprintDigest: string;
  readonly ownerIdDigest: string;
  readonly sessionIdDigest: string;
  readonly resourceDigests: readonly string[];
  readonly generation: number;
  readonly owner: PersistedCoordinatorOwner;
  readonly state: "prepared" | "dispatched" | "outcome_unknown";
  readonly acquiredAtUnixMs: number;
  readonly heartbeatAtUnixMs: number;
  readonly expiresAtUnixMs: number;
  readonly dispatchedAtUnixMs?: number;
  readonly outcomeUnknownAtUnixMs?: number;
  readonly unknownReason?: "shutdown_deadline" | "owner_lost" | "lease_lost";
}

interface PersistedCompletion {
  readonly operationDigest: string;
  readonly fingerprintDigest: string;
  readonly generation: number;
  readonly settledAtUnixMs: number;
}

interface SnapshotPayload {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly revision: number;
  readonly nextGeneration: number;
  readonly leases: readonly PersistedLease[];
  readonly completions: readonly PersistedCompletion[];
}

interface StoredSnapshot extends SnapshotPayload {
  readonly checksum: string;
}

interface StoreMutexOwner {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly nonce: string;
  readonly owner: PersistedCoordinatorOwner;
  readonly acquiredAtUnixMs: number;
}

interface RuntimeOperation {
  readonly fingerprintDigest: string;
  readonly completion: Promise<DurableNativeResourceLeaseTerminal>;
  readonly resolve: (terminal: DurableNativeResourceLeaseTerminal) => void;
  lease?: DurableNativeResourceLeaseHandle;
}

interface ResolvedOptions {
  readonly snapshotPath: string;
  readonly lockPath: string;
  readonly owner: PersistedCoordinatorOwner;
  readonly processIdentityReader: DurableNativeResourceProcessIdentityReader;
  readonly now: () => number;
  readonly nonce: () => string;
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly heartbeatIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly acquireTimeoutMs: number | undefined;
  readonly retryDelayMs: number;
  readonly mutexBootstrapGraceMs: number;
  readonly maxCompletions: number | undefined;
}

interface SnapshotMutationResult<T> {
  readonly value: T;
  readonly snapshot?: SnapshotPayload;
}

type OwnerLiveness = "alive" | "dead" | "unknown";

type AcquisitionDecision =
  | { readonly kind: "acquired"; readonly lease: PersistedLease }
  | { readonly kind: "settled"; readonly operationId: string }
  | { readonly kind: "outcome_unknown"; readonly operationId: string }
  | { readonly kind: "resource_unknown" }
  | { readonly kind: "same_operation_live" }
  | { readonly kind: "wait" }
  | { readonly kind: "retry" };

type ExpiredLeaseRecovery =
  | { readonly kind: "recovered_pre_dispatch" }
  | { readonly kind: "outcome_unknown" };

/**
 * Cross-process durable arbitration for native resources. This coordinator is
 * intentionally below MCP Goal/idempotency policy: every native call uses it,
 * while higher layers decide whether a completed result may be replayed.
 *
 * It does not claim to coordinate Codex Desktop operations that bypass the
 * OmniCodex scheduler. Only calls admitted through OmniCodex share this lease.
 */
export class DurableNativeResourceLeaseCoordinator
  implements DurableNativeResourceLeaseCoordinatorLike
{
  readonly #options: ResolvedOptions;
  readonly #runtimeOperations = new Map<string, RuntimeOperation>();

  private constructor(options: ResolvedOptions) {
    this.#options = options;
  }

  static async open(
    options: DurableNativeResourceLeaseCoordinatorOptions,
  ): Promise<DurableNativeResourceLeaseCoordinator> {
    assertDaemonIdentity(options.daemon);
    const processIdentityReader = options.processIdentityReader ?? new HiddenChildProcessBoundary();
    const observed = await processIdentityReader.inspectWindowsProcess(options.daemon.pid);
    if (observed === undefined || observed.pid !== options.daemon.pid) {
      throw new Error("NATIVE_RESOURCE_COORDINATOR_UNVERIFIABLE:daemon process is absent");
    }
    const snapshotPath = resolve(
      options.snapshotPath ??
        join(resolve(options.dataDirectory), "native-resource-leases", "snapshot.json"),
    );
    const resolved: ResolvedOptions = {
      snapshotPath,
      lockPath: `${snapshotPath}.lock`,
      owner: {
        pid: options.daemon.pid,
        instanceNonce: options.daemon.instanceNonce,
        daemonStartedAtUnixMs: options.daemon.startedAtUnixMs,
        processStartedAtIso: observed.startedAtIso,
      },
      processIdentityReader,
      now: options.now ?? Date.now,
      nonce: options.nonce ?? randomUUID,
      sleep: options.sleep ?? abortableDelay,
      heartbeatIntervalMs: positiveInteger(
        options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
        "Native resource heartbeat interval",
      ),
      leaseDurationMs: positiveInteger(
        options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
        "Native resource lease duration",
      ),
      acquireTimeoutMs: optionalPositiveInteger(
        options.acquireTimeoutMs,
        "Native resource acquire timeout",
      ),
      retryDelayMs: positiveInteger(
        options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
        "Native resource retry delay",
      ),
      mutexBootstrapGraceMs: positiveInteger(
        options.mutexBootstrapGraceMs ?? DEFAULT_MUTEX_BOOTSTRAP_GRACE_MS,
        "Native resource mutex bootstrap grace",
      ),
      maxCompletions: optionalPositiveInteger(
        options.maxCompletions,
        "Native resource completion limit",
      ),
    };
    if (resolved.leaseDurationMs <= resolved.heartbeatIntervalMs * 2) {
      throw new Error("Native resource lease duration must exceed two heartbeat intervals");
    }
    await mkdir(dirname(snapshotPath), { recursive: true });
    const coordinator = new DurableNativeResourceLeaseCoordinator(resolved);
    await coordinator.#recoverExpiredOwners();
    return coordinator;
  }

  async acquire(
    input: DurableNativeResourceLeaseRequest,
  ): Promise<DurableNativeResourceLeaseAcquisition> {
    const normalized = normalizeRequest(input);
    const existingRuntime = this.#runtimeOperations.get(normalized.operationDigest);
    if (existingRuntime !== undefined) {
      if (existingRuntime.fingerprintDigest !== normalized.fingerprintDigest) {
        throw new DurableNativeOperationConflictError();
      }
      return {
        kind: "join",
        operationId: normalized.operationId,
        completion: existingRuntime.completion,
      };
    }

    const deadline = optionalDeadline(this.#options.now(), this.#options.acquireTimeoutMs);
    while (true) {
      if (input.signal?.aborted) throw abortError();
      const decision = await this.#mutateSnapshot<AcquisitionDecision>(async (snapshot) => {
        const liveness = new Map<string, Promise<OwnerLiveness>>();
        const sameCompletion = snapshot.completions.find(
          (item) => item.operationDigest === normalized.operationDigest,
        );
        if (sameCompletion !== undefined) {
          if (sameCompletion.fingerprintDigest !== normalized.fingerprintDigest) {
            throw new DurableNativeOperationConflictError();
          }
          return {
            value: { kind: "settled" as const, operationId: normalized.operationId },
          };
        }

        const sameLease = snapshot.leases.find(
          (item) => item.operationDigest === normalized.operationDigest,
        );
        if (sameLease !== undefined) {
          if (sameLease.fingerprintDigest !== normalized.fingerprintDigest) {
            throw new DurableNativeOperationConflictError();
          }
          if (sameLease.state === "outcome_unknown") {
            return {
              value: { kind: "outcome_unknown" as const, operationId: normalized.operationId },
            };
          }
          const recovered = await this.#recoverExpiredLease(snapshot, sameLease, liveness);
          if (recovered?.value.kind === "outcome_unknown") {
            return {
              value: { kind: "outcome_unknown", operationId: normalized.operationId },
              ...(recovered.snapshot === undefined ? {} : { snapshot: recovered.snapshot }),
            };
          }
          if (recovered?.value.kind === "recovered_pre_dispatch") {
            return {
              value: { kind: "retry" },
              ...(recovered.snapshot === undefined ? {} : { snapshot: recovered.snapshot }),
            };
          }
          // A process-local join was checked before taking the store mutex. An
          // exact live record here belongs to another coordinator/process and
          // cannot supply this caller with a trustworthy result value.
          return { value: { kind: "same_operation_live" as const } };
        }

        let current = snapshot;
        for (const conflict of snapshot.leases.filter((lease) =>
          intersects(lease.resourceDigests, normalized.resourceDigests),
        )) {
          if (conflict.state === "outcome_unknown") {
            if (!blocksDifferentOperationOnUnknownOutcome(conflict)) continue;
            return { value: { kind: "resource_unknown" as const } };
          }
          const recovered = await this.#recoverExpiredLease(current, conflict, liveness);
          if (recovered?.snapshot !== undefined) current = recovered.snapshot;
          if (recovered?.value.kind === "outcome_unknown") {
            if (!blocksDifferentOperationOnUnknownOutcome(conflict)) continue;
            return { value: { kind: "resource_unknown" as const }, snapshot: current };
          }
          if (recovered?.value.kind === "recovered_pre_dispatch") continue;
          return {
            value: { kind: "wait" as const },
            ...(current === snapshot ? {} : { snapshot: current }),
          };
        }

        const now = this.#options.now();
        const generation = current.nextGeneration;
        const lease: PersistedLease = {
          operationDigest: normalized.operationDigest,
          fingerprintDigest: normalized.fingerprintDigest,
          ownerIdDigest: normalized.ownerIdDigest,
          sessionIdDigest: normalized.sessionIdDigest,
          resourceDigests: normalized.resourceDigests,
          generation,
          owner: this.#options.owner,
          state: "prepared",
          acquiredAtUnixMs: now,
          heartbeatAtUnixMs: now,
          expiresAtUnixMs: now + this.#options.leaseDurationMs,
        };
        const next = {
          ...current,
          nextGeneration: generation + 1,
          leases: [...current.leases, lease],
        } satisfies SnapshotPayload;
        return { value: { kind: "acquired" as const, lease }, snapshot: next };
      }, input.signal);

      if (decision.kind === "settled" || decision.kind === "outcome_unknown") return decision;
      if (decision.kind === "resource_unknown") {
        throw new DurableNativeResourceOutcomeUnknownError();
      }
      if (decision.kind === "same_operation_live") {
        throw new DurableNativeResourceBusyError(
          "Native operation is live in another coordinator and cannot be joined after restart",
        );
      }
      if (decision.kind === "acquired") {
        const runtime = deferredRuntimeOperation(normalized.fingerprintDigest);
        this.#runtimeOperations.set(normalized.operationDigest, runtime);
        const handle = new DurableNativeResourceLeaseHandle(
          this,
          normalized.operationId,
          normalized.operationDigest,
          normalized.fingerprintDigest,
          decision.lease,
          runtime,
          this.#options.heartbeatIntervalMs,
        );
        runtime.lease = handle;
        handle.startHeartbeat();
        return { kind: "acquired", lease: handle };
      }
      if (deadline !== undefined && this.#options.now() >= deadline) {
        throw new DurableNativeResourceBusyError();
      }
      await this.#options.sleep(this.#options.retryDelayMs, input.signal);
    }
  }

  async interruptOwnedOperations(reason = "shutdown_deadline"): Promise<number> {
    const unknownReason = normalizeUnknownReason(reason);
    const changed = await this.#mutateSnapshot(async (snapshot) => {
      const now = this.#options.now();
      let count = 0;
      const retained: PersistedLease[] = [];
      for (const lease of snapshot.leases) {
        if (!sameOwner(lease.owner, this.#options.owner)) {
          retained.push(lease);
          continue;
        }
        count += 1;
        if (lease.state === "prepared") continue;
        retained.push({
          ...lease,
          state: "outcome_unknown",
          outcomeUnknownAtUnixMs: lease.outcomeUnknownAtUnixMs ?? now,
          unknownReason,
        });
      }
      return {
        value: count,
        ...(count === 0 ? {} : { snapshot: { ...snapshot, leases: retained } }),
      };
    });

    for (const [operationDigest, runtime] of this.#runtimeOperations) {
      const lease = runtime.lease;
      if (lease === undefined) continue;
      await lease.stopHeartbeatAndDrain();
      if (lease.dispatched) {
        lease.noteUnknown();
        runtime.resolve("outcome_unknown");
      } else {
        runtime.resolve("abandoned_before_dispatch");
      }
      this.#runtimeOperations.delete(operationDigest);
    }
    return changed;
  }

  async recoverUnknown(
    operationId: string,
    proveSettled: (lease: DurableNativeResourceLeaseView) => Promise<boolean>,
  ): Promise<boolean> {
    const operationDigest = digest(requiredOpaque(operationId, "operationId"));
    const observed = await this.#readSnapshot((snapshot) =>
      snapshot.leases.find(
        (lease) => lease.operationDigest === operationDigest && lease.state === "outcome_unknown",
      ),
    );
    if (observed === undefined) return false;
    if (!(await proveSettled(publicLease(observed)))) return false;
    return this.#mutateSnapshot(async (snapshot) => {
      const current = snapshot.leases.find(
        (lease) => lease.operationDigest === operationDigest && lease.state === "outcome_unknown",
      );
      if (current === undefined || current.generation !== observed.generation) {
        return { value: false };
      }
      return {
        value: true,
        snapshot: completeLease(
          snapshot,
          current,
          this.#options.now(),
          this.#options.maxCompletions,
        ),
      };
    });
  }

  /**
   * Reconciles outcome-unknown leases for an authoritatively read-back native
   * resource when the original opaque operation id is no longer available.
   * The caller must prove every matching generation settled before its fence
   * is released; a failed proof leaves the snapshot unchanged.
   */
  async recoverUnknownResources(
    resourceKeys: readonly string[],
    proveSettled: (lease: DurableNativeResourceLeaseView) => Promise<boolean>,
  ): Promise<number> {
    const resourceDigests = [
      ...new Set(resourceKeys.map((key) => digest(requiredOpaque(key, "resourceKey")))),
    ];
    if (resourceDigests.length === 0) return 0;
    const observed = await this.#readSnapshot((snapshot) =>
      snapshot.leases.filter(
        (lease) =>
          lease.state === "outcome_unknown" &&
          lease.resourceDigests.some((candidate) => resourceDigests.includes(candidate)),
      ),
    );
    const proven: PersistedLease[] = [];
    for (const lease of observed) {
      if (await proveSettled(publicLease(lease))) proven.push(lease);
    }
    if (proven.length === 0) return 0;
    return this.#mutateSnapshot(async (snapshot) => {
      let current = snapshot;
      let count = 0;
      for (const observedLease of proven) {
        const lease = current.leases.find(
          (candidate) =>
            candidate.operationDigest === observedLease.operationDigest &&
            candidate.generation === observedLease.generation &&
            candidate.state === "outcome_unknown",
        );
        if (lease === undefined) continue;
        current = completeLease(current, lease, this.#options.now(), this.#options.maxCompletions);
        count += 1;
      }
      return {
        value: count,
        ...(count === 0 ? {} : { snapshot: current }),
      };
    });
  }

  async snapshot(): Promise<{
    readonly revision: number;
    readonly leases: readonly DurableNativeResourceLeaseView[];
    readonly completionCount: number;
  }> {
    return this.#readSnapshot((snapshot) => ({
      revision: snapshot.revision,
      leases: snapshot.leases.map(publicLease),
      completionCount: snapshot.completions.length,
    }));
  }

  async transition(
    operationDigest: string,
    generation: number,
    transition: "heartbeat" | "dispatched" | "settled" | "abandoned" | "unknown",
    reason?: string,
  ): Promise<void> {
    await this.#mutateSnapshot(async (snapshot) => {
      const lease = snapshot.leases.find(
        (item) => item.operationDigest === operationDigest && item.generation === generation,
      );
      if (transition === "settled") {
        if (lease === undefined) {
          const completed = snapshot.completions.some(
            (item) => item.operationDigest === operationDigest && item.generation === generation,
          );
          if (completed) return { value: undefined };
          throw new DurableNativeResourceLeaseLostError("Native resource lease disappeared");
        }
        if (!sameOwner(lease.owner, this.#options.owner)) throw leaseLost();
        return {
          value: undefined,
          snapshot: completeLease(
            snapshot,
            lease,
            this.#options.now(),
            this.#options.maxCompletions,
          ),
        };
      }
      if (lease === undefined || !sameOwner(lease.owner, this.#options.owner)) throw leaseLost();
      const now = this.#options.now();
      if (transition === "abandoned") {
        if (lease.state !== "prepared") {
          throw new DurableNativeResourceLeaseLostError(
            "Dispatched native resource lease cannot be abandoned",
          );
        }
        return {
          value: undefined,
          snapshot: {
            ...snapshot,
            leases: snapshot.leases.filter((item) => item !== lease),
          },
        };
      }
      if (transition === "heartbeat") {
        if (lease.state === "outcome_unknown") throw leaseLost();
        return {
          value: undefined,
          snapshot: replaceLease(snapshot, lease, {
            ...lease,
            heartbeatAtUnixMs: now,
            expiresAtUnixMs: now + this.#options.leaseDurationMs,
          }),
        };
      }
      if (transition === "dispatched") {
        if (lease.state === "dispatched") return { value: undefined };
        if (lease.state !== "prepared") throw leaseLost();
        return {
          value: undefined,
          snapshot: replaceLease(snapshot, lease, {
            ...lease,
            state: "dispatched",
            dispatchedAtUnixMs: now,
            heartbeatAtUnixMs: now,
            expiresAtUnixMs: now + this.#options.leaseDurationMs,
          }),
        };
      }
      if (lease.state === "outcome_unknown") return { value: undefined };
      if (lease.state !== "dispatched") {
        throw new DurableNativeResourceLeaseLostError(
          "Only a dispatched native resource lease can become outcome-unknown",
        );
      }
      return {
        value: undefined,
        snapshot: replaceLease(snapshot, lease, {
          ...lease,
          state: "outcome_unknown",
          outcomeUnknownAtUnixMs: now,
          unknownReason: normalizeUnknownReason(reason),
        }),
      };
    });
  }

  /**
   * Rolls back the durable dispatch marker only while the scheduler still
   * knows that the native callback has not been invoked. This closes the
   * atomic-write/readback ambiguity without pretending an external side
   * effect may have happened.
   */
  async abandonBeforeNativeInvocation(operationDigest: string, generation: number): Promise<void> {
    await this.#mutateSnapshot(async (snapshot) => {
      const lease = snapshot.leases.find(
        (item) => item.operationDigest === operationDigest && item.generation === generation,
      );
      if (lease === undefined) return { value: undefined };
      if (!sameOwner(lease.owner, this.#options.owner) || lease.state === "outcome_unknown") {
        throw leaseLost();
      }
      return {
        value: undefined,
        snapshot: {
          ...snapshot,
          leases: snapshot.leases.filter((item) => item !== lease),
        },
      };
    });
  }

  finishRuntime(operationDigest: string, terminal: DurableNativeResourceLeaseTerminal): void {
    const runtime = this.#runtimeOperations.get(operationDigest);
    if (runtime === undefined) return;
    runtime.resolve(terminal);
    this.#runtimeOperations.delete(operationDigest);
  }

  async #recoverExpiredOwners(): Promise<void> {
    await this.#mutateSnapshot(async (snapshot) => {
      let current = snapshot;
      const liveness = new Map<string, Promise<OwnerLiveness>>();
      for (const lease of snapshot.leases) {
        const recovered = await this.#recoverExpiredLease(current, lease, liveness);
        if (recovered?.snapshot !== undefined) current = recovered.snapshot;
      }
      return { value: undefined, ...(current === snapshot ? {} : { snapshot: current }) };
    });
  }

  async #recoverExpiredLease(
    snapshot: SnapshotPayload,
    lease: PersistedLease,
    liveness?: Map<string, Promise<OwnerLiveness>>,
  ): Promise<SnapshotMutationResult<ExpiredLeaseRecovery> | undefined> {
    if (lease.state === "outcome_unknown" || lease.expiresAtUnixMs > this.#options.now()) {
      return undefined;
    }
    const ownerLiveness = await this.#ownerLiveness(lease.owner, liveness);
    if (ownerLiveness !== "dead") return undefined;
    if (lease.state === "prepared") {
      return {
        value: { kind: "recovered_pre_dispatch" },
        snapshot: {
          ...snapshot,
          leases: snapshot.leases.filter(
            (item) =>
              !(
                item.operationDigest === lease.operationDigest &&
                item.generation === lease.generation
              ),
          ),
        },
      };
    }
    const now = this.#options.now();
    const unknown: PersistedLease = {
      ...lease,
      state: "outcome_unknown",
      outcomeUnknownAtUnixMs: now,
      unknownReason: "owner_lost",
    };
    return {
      value: { kind: "outcome_unknown" },
      snapshot: replaceLease(snapshot, lease, unknown),
    };
  }

  async #ownerLiveness(
    owner: PersistedCoordinatorOwner,
    cache?: Map<string, Promise<OwnerLiveness>>,
  ): Promise<OwnerLiveness> {
    if (sameOwner(owner, this.#options.owner)) return "alive";
    const key = `${owner.pid}\0${owner.processStartedAtIso}`;
    const existing = cache?.get(key);
    if (existing !== undefined) return existing;
    const inspection = (async (): Promise<OwnerLiveness> => {
      try {
        const observed = await this.#options.processIdentityReader.inspectWindowsProcess(owner.pid);
        if (observed === undefined) return "dead";
        return observed.startedAtIso === owner.processStartedAtIso ? "alive" : "dead";
      } catch {
        return "unknown";
      }
    })();
    cache?.set(key, inspection);
    return inspection;
  }

  async #readSnapshot<T>(select: (snapshot: SnapshotPayload) => T): Promise<T> {
    return this.#mutateSnapshot(async (snapshot) => ({ value: select(snapshot) }));
  }

  async #mutateSnapshot<T>(
    mutate: (snapshot: SnapshotPayload) => Promise<SnapshotMutationResult<T>>,
    signal?: AbortSignal,
  ): Promise<T> {
    const mutex = await this.#acquireMutex(signal);
    try {
      const storedSnapshot = await readSnapshot(this.#options.snapshotPath);
      const snapshot = trimCompletions(storedSnapshot, this.#options.maxCompletions);
      const result = await mutate(snapshot);
      const nextSnapshot = result.snapshot ?? (snapshot === storedSnapshot ? undefined : snapshot);
      if (nextSnapshot !== undefined) {
        await writeSnapshot(this.#options.snapshotPath, {
          ...nextSnapshot,
          revision: storedSnapshot.revision + 1,
        });
      }
      await mutex.assertOwned();
      return result.value;
    } finally {
      await mutex.release();
    }
  }

  async #acquireMutex(signal?: AbortSignal): Promise<StoreMutexLease> {
    const deadline = optionalDeadline(this.#options.now(), this.#options.acquireTimeoutMs);
    await mkdir(dirname(this.#options.lockPath), { recursive: true });
    while (true) {
      if (signal?.aborted) throw abortError();
      const nonce = this.#options.nonce();
      try {
        await mkdir(this.#options.lockPath);
        const owner: StoreMutexOwner = {
          schemaVersion: SCHEMA_VERSION,
          nonce,
          owner: this.#options.owner,
          acquiredAtUnixMs: this.#options.now(),
        };
        await atomicJsonWrite(join(this.#options.lockPath, "owner.json"), owner);
        return new StoreMutexLease(this.#options.lockPath, owner, this.#options.nonce);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          await this.#removeAbandonedBootstrapMutex().catch(() => undefined);
          throw error;
        }
      }
      await this.#recoverDeadMutexOwner();
      if (deadline !== undefined && this.#options.now() >= deadline) {
        throw new DurableNativeResourceBusyError("Timed out waiting for native lease store mutex");
      }
      await this.#options.sleep(this.#options.retryDelayMs, signal);
    }
  }

  async #removeAbandonedBootstrapMutex(): Promise<void> {
    const metadata = await stat(this.#options.lockPath).catch(() => undefined);
    if (
      metadata === undefined ||
      this.#options.now() - metadata.mtimeMs < this.#options.mutexBootstrapGraceMs
    )
      return;
    try {
      await rmdir(this.#options.lockPath);
      return;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
    }
    // A process can die after creating the mutex directory but before the
    // atomic owner.json rename. In that state only an orphaned *.tmp file is
    // present, so rmdir can never succeed and every later daemon waits
    // forever. Quarantine the stable, ownerless directory atomically before
    // removing it. If owner.json appeared during the race, preserve a live or
    // unverifiable owner by restoring the directory.
    const quarantine = `${this.#options.lockPath}.bootstrap.${this.#options.nonce()}`;
    try {
      await renameWithWindowsRetry(this.#options.lockPath, quarantine);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    const racedOwner = await readMutexOwner(quarantine).catch(() => undefined);
    if (racedOwner !== undefined && (await this.#ownerLiveness(racedOwner.owner)) !== "dead") {
      await renameWithWindowsRetry(quarantine, this.#options.lockPath);
      return;
    }
    await rm(quarantine, { recursive: true, force: true });
  }

  async #recoverDeadMutexOwner(): Promise<void> {
    const owner = await readMutexOwner(this.#options.lockPath).catch(() => undefined);
    if (owner === undefined) {
      await this.#removeAbandonedBootstrapMutex();
      return;
    }
    if ((await this.#ownerLiveness(owner.owner)) !== "dead") return;
    const confirmed = await readMutexOwner(this.#options.lockPath).catch(() => undefined);
    if (confirmed === undefined || canonicalJson(confirmed) !== canonicalJson(owner)) return;
    const quarantine = `${this.#options.lockPath}.dead.${this.#options.nonce()}`;
    try {
      await renameWithWindowsRetry(this.#options.lockPath, quarantine);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    await rm(quarantine, { recursive: true, force: true });
  }
}

class DurableNativeResourceLeaseHandle implements DurableNativeResourceLease {
  readonly operationId: string;
  readonly generation: number;
  readonly resourceDigests: readonly string[];
  readonly #coordinator: DurableNativeResourceLeaseCoordinator;
  readonly #operationDigest: string;
  readonly #runtime: RuntimeOperation;
  readonly #heartbeatIntervalMs: number;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #heartbeatInFlight: Promise<void> | undefined;
  #terminal = false;
  #dispatched = false;
  #unknown = false;

  constructor(
    coordinator: DurableNativeResourceLeaseCoordinator,
    operationId: string,
    operationDigest: string,
    _fingerprintDigest: string,
    lease: PersistedLease,
    runtime: RuntimeOperation,
    heartbeatIntervalMs: number,
  ) {
    this.#coordinator = coordinator;
    this.operationId = operationId;
    this.#operationDigest = operationDigest;
    this.generation = lease.generation;
    this.resourceDigests = lease.resourceDigests;
    this.#runtime = runtime;
    this.#heartbeatIntervalMs = heartbeatIntervalMs;
  }

  get dispatched(): boolean {
    return this.#dispatched;
  }

  startHeartbeat(): void {
    if (this.#heartbeat !== undefined || this.#terminal) return;
    this.#heartbeat = setInterval(() => {
      if (this.#heartbeatInFlight !== undefined) return;
      const heartbeat = this.#coordinator
        .transition(this.#operationDigest, this.generation, "heartbeat")
        .catch(async () => {
          this.stopHeartbeat();
          if (!this.#terminal && this.#dispatched) {
            this.#unknown = true;
            await this.#coordinator
              .transition(this.#operationDigest, this.generation, "unknown", "lease_lost")
              .catch(() => undefined);
          }
        })
        .finally(() => {
          if (this.#heartbeatInFlight === heartbeat) this.#heartbeatInFlight = undefined;
        });
      this.#heartbeatInFlight = heartbeat;
    }, this.#heartbeatIntervalMs);
    this.#heartbeat.unref?.();
  }

  stopHeartbeat(): void {
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }

  async stopHeartbeatAndDrain(): Promise<void> {
    this.stopHeartbeat();
    await this.#heartbeatInFlight;
  }

  noteUnknown(): void {
    this.#unknown = true;
  }

  async markDispatched(): Promise<void> {
    this.#assertActive();
    try {
      await this.#coordinator.transition(this.#operationDigest, this.generation, "dispatched");
      this.#dispatched = true;
    } catch (error) {
      this.#terminal = true;
      await this.stopHeartbeatAndDrain();
      try {
        await this.#coordinator.abandonBeforeNativeInvocation(
          this.#operationDigest,
          this.generation,
        );
        this.#coordinator.finishRuntime(this.#operationDigest, "abandoned_before_dispatch");
      } catch (cleanupError) {
        this.#unknown = true;
        this.#coordinator.finishRuntime(this.#operationDigest, "outcome_unknown");
        throw new AggregateError(
          [error, cleanupError],
          "Native dispatch marker failed and could not be rolled back safely",
        );
      }
      throw error;
    }
  }

  async abandonBeforeDispatch(): Promise<void> {
    if (this.#terminal) return;
    if (this.#dispatched) {
      throw new DurableNativeResourceLeaseLostError(
        "Dispatched native resource lease cannot be abandoned",
      );
    }
    this.#terminal = true;
    await this.stopHeartbeatAndDrain();
    await this.#coordinator.transition(this.#operationDigest, this.generation, "abandoned");
    this.#coordinator.finishRuntime(this.#operationDigest, "abandoned_before_dispatch");
  }

  async settle(): Promise<void> {
    if (this.#terminal) return;
    this.#terminal = true;
    await this.stopHeartbeatAndDrain();
    try {
      await this.#coordinator.transition(this.#operationDigest, this.generation, "settled");
      this.#coordinator.finishRuntime(this.#operationDigest, "settled");
    } catch (error) {
      this.#unknown = true;
      await this.#coordinator
        .transition(this.#operationDigest, this.generation, "unknown", "lease_lost")
        .catch(() => undefined);
      this.#coordinator.finishRuntime(this.#operationDigest, "outcome_unknown");
      throw error;
    }
  }

  async markOutcomeUnknown(reason = "shutdown_deadline"): Promise<void> {
    if (this.#terminal || this.#unknown) return;
    this.#unknown = true;
    await this.stopHeartbeatAndDrain();
    if (!this.#dispatched) {
      this.#unknown = false;
      await this.abandonBeforeDispatch();
      return;
    }
    await this.#coordinator.transition(this.#operationDigest, this.generation, "unknown", reason);
    this.#runtime.resolve("outcome_unknown");
  }

  #assertActive(): void {
    if (this.#terminal || this.#unknown) throw leaseLost();
  }
}

class StoreMutexLease {
  readonly #path: string;
  readonly #owner: StoreMutexOwner;
  readonly #nonce: () => string;
  #released = false;

  constructor(path: string, owner: StoreMutexOwner, nonce: () => string) {
    this.#path = path;
    this.#owner = owner;
    this.#nonce = nonce;
  }

  async assertOwned(): Promise<void> {
    const current = await readMutexOwner(this.#path);
    if (canonicalJson(current) !== canonicalJson(this.#owner)) {
      throw new DurableNativeResourceLeaseLostError("Native lease store mutex was lost");
    }
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    const current = await readMutexOwner(this.#path).catch(() => undefined);
    if (current === undefined || canonicalJson(current) !== canonicalJson(this.#owner)) return;
    const quarantine = `${this.#path}.released.${this.#nonce()}`;
    try {
      await renameWithWindowsRetry(this.#path, quarantine);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    await rm(quarantine, { recursive: true, force: true });
  }
}

function normalizeRequest(input: DurableNativeResourceLeaseRequest) {
  const operationId = requiredOpaque(input.operationId, "operationId");
  const fingerprint = requiredOpaque(input.fingerprint, "fingerprint");
  const ownerId = requiredOpaque(input.ownerId, "ownerId");
  const sessionId = requiredOpaque(input.sessionId, "sessionId");
  const resourceDigests = [
    ...new Set(input.resourceKeys.map((key) => digest(requiredOpaque(key, "resourceKey")))),
  ].sort();
  return {
    operationId,
    operationDigest: digest(operationId),
    fingerprintDigest: digest(fingerprint),
    ownerIdDigest: digest(ownerId),
    sessionIdDigest: digest(sessionId),
    resourceDigests,
  };
}

function deferredRuntimeOperation(fingerprintDigest: string): RuntimeOperation {
  let settled = false;
  let resolvePromise!: (terminal: DurableNativeResourceLeaseTerminal) => void;
  const completion = new Promise<DurableNativeResourceLeaseTerminal>((resolveCompletion) => {
    resolvePromise = resolveCompletion;
  });
  return {
    fingerprintDigest,
    completion,
    resolve: (terminal) => {
      if (settled) return;
      settled = true;
      resolvePromise(terminal);
    },
  };
}

function replaceLease(
  snapshot: SnapshotPayload,
  expected: PersistedLease,
  replacement: PersistedLease,
): SnapshotPayload {
  return {
    ...snapshot,
    leases: snapshot.leases.map((item) =>
      item.operationDigest === expected.operationDigest && item.generation === expected.generation
        ? replacement
        : item,
    ),
  };
}

function completeLease(
  snapshot: SnapshotPayload,
  lease: PersistedLease,
  now: number,
  maxCompletions: number | undefined,
): SnapshotPayload {
  const completion: PersistedCompletion = {
    operationDigest: lease.operationDigest,
    fingerprintDigest: lease.fingerprintDigest,
    generation: lease.generation,
    settledAtUnixMs: now,
  };
  const completions = [...snapshot.completions, completion].sort(
    (left, right) => left.settledAtUnixMs - right.settledAtUnixMs,
  );
  return {
    ...snapshot,
    leases: snapshot.leases.filter(
      (item) =>
        !(item.operationDigest === lease.operationDigest && item.generation === lease.generation),
    ),
    completions: maxCompletions === undefined ? completions : completions.slice(-maxCompletions),
  };
}

function trimCompletions(
  snapshot: SnapshotPayload,
  maxCompletions: number | undefined,
): SnapshotPayload {
  if (maxCompletions === undefined || snapshot.completions.length <= maxCompletions) {
    return snapshot;
  }
  return {
    ...snapshot,
    completions: snapshot.completions.slice(-maxCompletions),
  };
}

function publicLease(lease: PersistedLease): DurableNativeResourceLeaseView {
  return {
    operationDigest: lease.operationDigest,
    fingerprintDigest: lease.fingerprintDigest,
    resourceDigests: lease.resourceDigests,
    generation: lease.generation,
    state: lease.state,
    owner: lease.owner,
    acquiredAtUnixMs: lease.acquiredAtUnixMs,
    heartbeatAtUnixMs: lease.heartbeatAtUnixMs,
    expiresAtUnixMs: lease.expiresAtUnixMs,
    ...(lease.dispatchedAtUnixMs === undefined
      ? {}
      : { dispatchedAtUnixMs: lease.dispatchedAtUnixMs }),
    ...(lease.outcomeUnknownAtUnixMs === undefined
      ? {}
      : { outcomeUnknownAtUnixMs: lease.outcomeUnknownAtUnixMs }),
  };
}

async function readSnapshot(path: string): Promise<SnapshotPayload> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return {
        schemaVersion: SCHEMA_VERSION,
        revision: 0,
        nextGeneration: 1,
        leases: [],
        completions: [],
      };
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new DurableNativeResourceSnapshotError("Native resource snapshot is not JSON", {
      cause: error,
    });
  }
  if (!isStoredSnapshot(value)) {
    throw new DurableNativeResourceSnapshotError("Native resource snapshot shape is invalid");
  }
  const { checksum, ...payload } = value;
  if (digest(canonicalJson(payload)) !== checksum) {
    throw new DurableNativeResourceSnapshotError("Native resource snapshot checksum mismatch");
  }
  validateSnapshot(payload);
  return payload;
}

async function writeSnapshot(path: string, payload: SnapshotPayload): Promise<void> {
  validateSnapshot(payload);
  await atomicJsonWrite(path, {
    ...payload,
    checksum: digest(canonicalJson(payload)),
  } satisfies StoredSnapshot);
}

async function readMutexOwner(lockPath: string): Promise<StoreMutexOwner> {
  const value: unknown = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
  if (!isObject(value) || value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error("Native lease store mutex owner is invalid");
  }
  requiredOpaque(value.nonce, "mutex.nonce");
  validatePersistedOwner(value.owner);
  if (!nonNegativeInteger(value.acquiredAtUnixMs)) {
    throw new Error("Native lease store mutex timestamp is invalid");
  }
  return value as unknown as StoreMutexOwner;
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${canonicalJson(value)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await renameWithWindowsRetry(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
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
      await abortableDelay(10 * (attempt + 1));
    }
  }
}

function validateSnapshot(snapshot: SnapshotPayload): void {
  if (
    snapshot.schemaVersion !== SCHEMA_VERSION ||
    !nonNegativeInteger(snapshot.revision) ||
    !positiveIntegerValue(snapshot.nextGeneration) ||
    !Array.isArray(snapshot.leases) ||
    !Array.isArray(snapshot.completions)
  ) {
    throw new DurableNativeResourceSnapshotError("Native resource snapshot metadata is invalid");
  }
  const operations = new Set<string>();
  const generations = new Set<number>();
  for (const lease of snapshot.leases) {
    validateLease(lease);
    if (operations.has(lease.operationDigest) || generations.has(lease.generation)) {
      throw new DurableNativeResourceSnapshotError(
        "Native resource snapshot contains duplicate active identities",
      );
    }
    operations.add(lease.operationDigest);
    generations.add(lease.generation);
  }
  for (const completion of snapshot.completions) {
    if (
      !sha256Value(completion.operationDigest) ||
      !sha256Value(completion.fingerprintDigest) ||
      !positiveIntegerValue(completion.generation) ||
      !nonNegativeInteger(completion.settledAtUnixMs) ||
      operations.has(completion.operationDigest) ||
      generations.has(completion.generation)
    ) {
      throw new DurableNativeResourceSnapshotError(
        "Native resource snapshot completion is invalid",
      );
    }
    operations.add(completion.operationDigest);
    generations.add(completion.generation);
  }
  if ([...generations].some((generation) => generation >= snapshot.nextGeneration)) {
    throw new DurableNativeResourceSnapshotError("Native resource generation fence is invalid");
  }
}

function validateLease(lease: PersistedLease): void {
  validatePersistedOwner(lease.owner);
  if (
    !sha256Value(lease.operationDigest) ||
    !sha256Value(lease.fingerprintDigest) ||
    !sha256Value(lease.ownerIdDigest) ||
    !sha256Value(lease.sessionIdDigest) ||
    !Array.isArray(lease.resourceDigests) ||
    lease.resourceDigests.some((value) => !sha256Value(value)) ||
    new Set(lease.resourceDigests).size !== lease.resourceDigests.length ||
    !positiveIntegerValue(lease.generation) ||
    !["prepared", "dispatched", "outcome_unknown"].includes(lease.state) ||
    !nonNegativeInteger(lease.acquiredAtUnixMs) ||
    !nonNegativeInteger(lease.heartbeatAtUnixMs) ||
    !nonNegativeInteger(lease.expiresAtUnixMs) ||
    lease.heartbeatAtUnixMs < lease.acquiredAtUnixMs ||
    lease.expiresAtUnixMs < lease.heartbeatAtUnixMs
  ) {
    throw new DurableNativeResourceSnapshotError("Native resource lease is invalid");
  }
  if (lease.state === "prepared" && lease.dispatchedAtUnixMs !== undefined) {
    throw new DurableNativeResourceSnapshotError("Prepared native lease has a dispatch timestamp");
  }
  if (lease.state !== "prepared" && !nonNegativeInteger(lease.dispatchedAtUnixMs)) {
    throw new DurableNativeResourceSnapshotError("Dispatched native lease lacks a timestamp");
  }
  if (lease.state === "outcome_unknown" && !nonNegativeInteger(lease.outcomeUnknownAtUnixMs)) {
    throw new DurableNativeResourceSnapshotError("Unknown native lease lacks a timestamp");
  }
}

function validatePersistedOwner(value: unknown): asserts value is PersistedCoordinatorOwner {
  if (
    !isObject(value) ||
    !positiveIntegerValue(value.pid) ||
    typeof value.instanceNonce !== "string" ||
    value.instanceNonce.length < 16 ||
    !positiveIntegerValue(value.daemonStartedAtUnixMs) ||
    typeof value.processStartedAtIso !== "string" ||
    Number.isNaN(Date.parse(value.processStartedAtIso))
  ) {
    throw new Error("Native resource coordinator owner is invalid");
  }
}

function isStoredSnapshot(value: unknown): value is StoredSnapshot {
  return isObject(value) && sha256Value(value.checksum);
}

function sameOwner(left: PersistedCoordinatorOwner, right: PersistedCoordinatorOwner): boolean {
  return (
    left.pid === right.pid &&
    left.instanceNonce === right.instanceNonce &&
    left.daemonStartedAtUnixMs === right.daemonStartedAtUnixMs &&
    left.processStartedAtIso === right.processStartedAtIso
  );
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const smaller = left.length <= right.length ? new Set(left) : new Set(right);
  const larger = left.length <= right.length ? right : left;
  return larger.some((value) => smaller.has(value));
}

function blocksDifferentOperationOnUnknownOutcome(lease: PersistedLease): boolean {
  return lease.resourceDigests.some(
    (resourceDigest) => !OPERATION_SCOPED_UNKNOWN_RESOURCE_DIGESTS.has(resourceDigest),
  );
}

function normalizeUnknownReason(
  value: string | undefined,
): "shutdown_deadline" | "owner_lost" | "lease_lost" {
  return value === "owner_lost" || value === "lease_lost" ? value : "shutdown_deadline";
}

function assertDaemonIdentity(identity: DurableNativeResourceLeaseDaemonIdentity): void {
  if (!positiveIntegerValue(identity.pid)) throw new Error("Native lease daemon PID is invalid");
  if (identity.instanceNonce.length < 16) throw new Error("Native lease daemon nonce is invalid");
  if (!positiveIntegerValue(identity.startedAtUnixMs)) {
    throw new Error("Native lease daemon start time is invalid");
  }
}

function requiredOpaque(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || /[\0\r\n]/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Value(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be positive`);
  return value;
}

function optionalPositiveInteger(value: number | undefined, label: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, label);
}

function optionalDeadline(now: number, timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (timeoutMs > Number.MAX_SAFE_INTEGER - now) {
    throw new TypeError("Native resource acquire timeout exceeds the timestamp range");
  }
  return now + timeoutMs;
}

function positiveIntegerValue(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

function leaseLost(): DurableNativeResourceLeaseLostError {
  return new DurableNativeResourceLeaseLostError("Native resource lease is no longer owned");
}

function abortError(): Error {
  const error = new Error("Native resource lease acquisition cancelled");
  error.name = "AbortError";
  return error;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolveDelay, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolveDelay();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
