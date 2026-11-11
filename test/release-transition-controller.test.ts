import { describe, expect, it } from "vitest";
import {
  type HealthyOmniCodexRelease,
  ReleaseTransitionController,
  type StagedOmniCodexRelease,
} from "../src/application/release-transition-controller.js";

const staged: StagedOmniCodexRelease = {
  version: "1.2.3",
  releasePath: "C:\\OmniCodex\\releases\\1.2.3",
  integrity: "sha512-candidate",
  sourceCommit: "1".repeat(40),
  provenanceAvailable: true,
  sbomDigest: "sha256-sbom",
  packageDigest: "2".repeat(64),
};

const oldRelease: HealthyOmniCodexRelease = {
  version: "1.2.2",
  releasePath: "C:\\OmniCodex\\releases\\1.2.2",
  stateSnapshotId: "state-122",
};

describe("ReleaseTransitionController", () => {
  it("validates every package gate before drain and switches atomically", async () => {
    const events: string[] = [];
    const controller = fixture(events);

    await expect(controller.update("1.2.3")).resolves.toMatchObject({
      operation: "update",
      active: { version: "1.2.3", stateSnapshotId: "state-123" },
      previous: { ...oldRelease, stateSnapshotId: "state-123" },
    });

    expect(events).toEqual([
      "current",
      "stage:1.2.3",
      "identity",
      "integrity",
      "provenance",
      "sbom",
      "self-check",
      "migration-dry-run",
      "guard-self-test",
      "protocol-contract",
      "shadow-runtime",
      "snapshot",
      `healthy:${oldRelease.releasePath}`,
      "drain-begin",
      "drain-wait",
      `switch:${staged.releasePath}:state-123:state-123`,
      `observe:${staged.releasePath}`,
      `healthy:${staged.releasePath}`,
      `retain:${staged.releasePath}`,
      "drain-resume",
    ]);
  });

  it("does not drain or switch when a supply-chain gate fails", async () => {
    const events: string[] = [];
    const controller = fixture(events, { failAt: "provenance" });

    await expect(controller.update("1.2.3")).rejects.toThrow("provenance failed");
    expect(events).toEqual([
      "current",
      "stage:1.2.3",
      "identity",
      "integrity",
      "provenance",
      `discard:${staged.releasePath}`,
    ]);
  });

  it("rejects the active version before staging another package", async () => {
    const events: string[] = [];
    const controller = fixture(events);
    await expect(controller.update(oldRelease.version)).rejects.toThrow("already active");
    expect(events).toEqual(["current"]);
  });

  it("restores the exact previous pointer and state after observation failure", async () => {
    const events: string[] = [];
    const controller = fixture(events, { failAt: "observe" });

    await expect(controller.update("1.2.3")).rejects.toThrow("observe failed");
    expect(events.slice(-4)).toEqual([
      `observe:${staged.releasePath}`,
      `switch:${oldRelease.releasePath}:state-123:state-123`,
      "drain-resume",
      `discard:${staged.releasePath}`,
    ]);
  });

  it("rolls back to a retained healthy release and reverts a failed rollback observation", async () => {
    const events: string[] = [];
    const target: HealthyOmniCodexRelease = {
      version: "1.2.1",
      releasePath: "C:\\OmniCodex\\releases\\1.2.1",
      stateSnapshotId: "state-121",
    };
    const controller = fixture(events, { retained: [oldRelease, target], failAt: "observe" });

    await expect(controller.rollback("1.2.1")).rejects.toThrow("observe failed");
    expect(events).toContain(`compatible:${target.stateSnapshotId}:${target.releasePath}`);
    expect(events.slice(-2)).toEqual([
      `switch:${oldRelease.releasePath}:${oldRelease.stateSnapshotId}:${target.stateSnapshotId}`,
      "drain-resume",
    ]);
  });
});

function fixture(
  events: string[],
  options: {
    readonly failAt?: string;
    readonly retained?: readonly HealthyOmniCodexRelease[];
  } = {},
): ReleaseTransitionController {
  const step = async (name: string) => {
    events.push(name);
    if (options.failAt === name) throw new Error(`${name} failed`);
  };
  return new ReleaseTransitionController({
    source: {
      stage: async (version) => {
        events.push(`stage:${version}`);
        return staged;
      },
      discard: async (candidate) => void events.push(`discard:${candidate.releasePath}`),
    },
    validator: {
      verifyPackageIdentity: async () => step("identity"),
      verifyRegistryIntegrity: async () => step("integrity"),
      verifySignatureAndProvenance: async () => step("provenance"),
      verifySbomAssociation: async () => step("sbom"),
      runSelfChecks: async () => step("self-check"),
      dryRunStateMigration: async () => step("migration-dry-run"),
      runGuardSelfTest: async () => step("guard-self-test"),
      runProtocolContractTests: async () => step("protocol-contract"),
      runShadowRuntimeProbe: async () => step("shadow-runtime"),
    },
    snapshots: {
      captureFor: async () => {
        events.push("snapshot");
        return "state-123";
      },
      restore: async (snapshotId) => void events.push(`restore:${snapshotId}`),
      assertCompatible: async (snapshotId, release) =>
        void events.push(`compatible:${snapshotId}:${release.releasePath}`),
    },
    drain: {
      begin: async () => void events.push("drain-begin"),
      awaitDrained: async () => void events.push("drain-wait"),
      resume: async () => void events.push("drain-resume"),
    },
    pointer: {
      current: async () => {
        events.push("current");
        return oldRelease;
      },
      switchTo: async (releasePath, snapshotId, rollbackSnapshotId) =>
        void events.push(`switch:${releasePath}:${snapshotId}:${rollbackSnapshotId}`),
      markHealthy: async (release) => void events.push(`healthy:${release.releasePath}`),
      retainedHealthy: async () => options.retained ?? [oldRelease],
      retainAtLeastTwoPrior: async (activePath) => void events.push(`retain:${activePath}`),
    },
    observation: {
      observe: async (releasePath) => {
        events.push(`observe:${releasePath}`);
        if (options.failAt === "observe") throw new Error("observe failed");
      },
    },
  });
}
