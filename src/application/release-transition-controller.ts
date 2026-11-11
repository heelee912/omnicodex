export interface StagedOmniCodexRelease {
  readonly version: string;
  readonly releasePath: string;
  readonly integrity: string;
  readonly sourceCommit: string;
  readonly provenanceAvailable: boolean;
  readonly sbomDigest: string;
  readonly packageDigest: string;
}

export interface HealthyOmniCodexRelease {
  readonly version: string;
  readonly releasePath: string;
  readonly stateSnapshotId: string;
  readonly sourceCommit?: string;
  readonly integrity?: string;
  readonly packageDigest?: string;
}

export interface ReleaseSource {
  stage(version: string): Promise<StagedOmniCodexRelease>;
  discard(staged: StagedOmniCodexRelease): Promise<void>;
}

export interface ReleaseValidator {
  verifyPackageIdentity(staged: StagedOmniCodexRelease): Promise<void>;
  verifyRegistryIntegrity(staged: StagedOmniCodexRelease): Promise<void>;
  verifySignatureAndProvenance(staged: StagedOmniCodexRelease): Promise<void>;
  verifySbomAssociation(staged: StagedOmniCodexRelease): Promise<void>;
  runSelfChecks(staged: StagedOmniCodexRelease): Promise<void>;
  dryRunStateMigration(staged: StagedOmniCodexRelease): Promise<void>;
  runGuardSelfTest(staged: StagedOmniCodexRelease): Promise<void>;
  runProtocolContractTests(staged: StagedOmniCodexRelease): Promise<void>;
  runShadowRuntimeProbe(staged: StagedOmniCodexRelease): Promise<void>;
}

export interface ReleaseStateSnapshots {
  captureFor(staged: StagedOmniCodexRelease): Promise<string>;
  restore(snapshotId: string): Promise<void>;
  assertCompatible(snapshotId: string, release: HealthyOmniCodexRelease): Promise<void>;
}

export interface ReleaseAdmissionDrain {
  begin(): Promise<void>;
  awaitDrained(): Promise<void>;
  resume(): Promise<void>;
}

export interface AtomicReleasePointer {
  current(): Promise<HealthyOmniCodexRelease | undefined>;
  switchTo(
    releasePath: string,
    stateSnapshotId: string,
    rollbackStateSnapshotId: string,
  ): Promise<void>;
  markHealthy(release: HealthyOmniCodexRelease): Promise<void>;
  retainedHealthy(): Promise<readonly HealthyOmniCodexRelease[]>;
  retainAtLeastTwoPrior(activePath: string): Promise<void>;
}

export interface ReleaseObservation {
  observe(releasePath: string): Promise<void>;
}

export interface ReleaseTransitionControllerOptions {
  readonly source: ReleaseSource;
  readonly validator: ReleaseValidator;
  readonly snapshots: ReleaseStateSnapshots;
  readonly drain: ReleaseAdmissionDrain;
  readonly pointer: AtomicReleasePointer;
  readonly observation: ReleaseObservation;
}

export interface ReleaseTransitionResult {
  readonly operation: "update" | "rollback";
  readonly active: HealthyOmniCodexRelease;
  readonly previous?: HealthyOmniCodexRelease;
}

/**
 * Coordinates package changes without ever replacing the active release in
 * place. Candidate validation happens before admission closes. A switched
 * candidate remains rollback-capable through the observation window, with the
 * exact previous pointer and state snapshot restored on failure.
 */
export class ReleaseTransitionController {
  readonly #source: ReleaseSource;
  readonly #validator: ReleaseValidator;
  readonly #snapshots: ReleaseStateSnapshots;
  readonly #drain: ReleaseAdmissionDrain;
  readonly #pointer: AtomicReleasePointer;
  readonly #observation: ReleaseObservation;

  constructor(options: ReleaseTransitionControllerOptions) {
    this.#source = options.source;
    this.#validator = options.validator;
    this.#snapshots = options.snapshots;
    this.#drain = options.drain;
    this.#pointer = options.pointer;
    this.#observation = options.observation;
  }

  async update(version: string): Promise<ReleaseTransitionResult> {
    assertReleaseVersion(version);
    const previous = await this.#pointer.current();
    if (previous === undefined) throw new Error("No active OmniCodex release is recorded");
    if (previous.version === version) throw new Error("Requested release is already active");
    const staged = await this.#source.stage(version);
    if (staged.version !== version) {
      await this.#source.discard(staged).catch(() => undefined);
      throw new Error("Staged package version did not match the requested release");
    }
    let switched = false;
    let draining = false;
    let stateSnapshotId: string | undefined;
    let recoverablePrevious = previous;
    try {
      await this.#validate(staged);
      stateSnapshotId = await this.#snapshots.captureFor(staged);
      recoverablePrevious = { ...previous, stateSnapshotId };
      await this.#pointer.markHealthy(recoverablePrevious);
      await this.#drain.begin();
      draining = true;
      await this.#drain.awaitDrained();
      await this.#pointer.switchTo(
        staged.releasePath,
        stateSnapshotId,
        recoverablePrevious.stateSnapshotId,
      );
      switched = true;
      await this.#observation.observe(staged.releasePath);
      const active: HealthyOmniCodexRelease = {
        version: staged.version,
        releasePath: staged.releasePath,
        stateSnapshotId,
        sourceCommit: staged.sourceCommit,
        integrity: staged.integrity,
        packageDigest: staged.packageDigest,
      };
      await this.#pointer.markHealthy(active);
      await this.#pointer.retainAtLeastTwoPrior(active.releasePath);
      await this.#drain.resume();
      return {
        operation: "update",
        active,
        previous: recoverablePrevious,
      };
    } catch (error) {
      if (switched) {
        if (stateSnapshotId === undefined) {
          throw new Error("Switched release omitted its state snapshot identity", { cause: error });
        }
        await this.#pointer.switchTo(
          recoverablePrevious.releasePath,
          recoverablePrevious.stateSnapshotId,
          stateSnapshotId,
        );
      }
      if (draining) await this.#drain.resume().catch(() => undefined);
      await this.#source.discard(staged).catch(() => undefined);
      throw error;
    }
  }

  async rollback(version?: string): Promise<ReleaseTransitionResult> {
    const previous = await this.#pointer.current();
    if (previous === undefined) throw new Error("No active OmniCodex release is recorded");
    const retained = await this.#pointer.retainedHealthy();
    const target =
      version === undefined
        ? retained.find((release) => release.releasePath !== previous.releasePath)
        : retained.find((release) => release.version === version);
    if (target === undefined) throw new Error("No retained healthy rollback release matched");
    if (target.releasePath === previous.releasePath) {
      throw new Error("Rollback target is already active");
    }
    if (version !== undefined) assertReleaseVersion(version);
    await this.#snapshots.assertCompatible(target.stateSnapshotId, target);
    let switched = false;
    let draining = false;
    try {
      await this.#drain.begin();
      draining = true;
      await this.#drain.awaitDrained();
      await this.#pointer.switchTo(
        target.releasePath,
        target.stateSnapshotId,
        previous.stateSnapshotId,
      );
      switched = true;
      await this.#observation.observe(target.releasePath);
      await this.#pointer.markHealthy(target);
      await this.#pointer.retainAtLeastTwoPrior(target.releasePath);
      await this.#drain.resume();
      return { operation: "rollback", active: target, previous };
    } catch (error) {
      if (switched) {
        await this.#pointer.switchTo(
          previous.releasePath,
          previous.stateSnapshotId,
          target.stateSnapshotId,
        );
      }
      if (draining) await this.#drain.resume().catch(() => undefined);
      throw error;
    }
  }

  async #validate(staged: StagedOmniCodexRelease): Promise<void> {
    await this.#validator.verifyPackageIdentity(staged);
    await this.#validator.verifyRegistryIntegrity(staged);
    await this.#validator.verifySignatureAndProvenance(staged);
    await this.#validator.verifySbomAssociation(staged);
    await this.#validator.runSelfChecks(staged);
    await this.#validator.dryRunStateMigration(staged);
    await this.#validator.runGuardSelfTest(staged);
    await this.#validator.runProtocolContractTests(staged);
    await this.#validator.runShadowRuntimeProbe(staged);
  }
}

function assertReleaseVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Invalid OmniCodex release version");
  }
}
