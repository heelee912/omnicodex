import { describe, expect, it } from "vitest";
import { NonInterferenceGuard } from "../src/application/non-interference-guard.js";
import type { ActionLedgerView, CodexSystemObservation } from "../src/domain/non-interference.js";

const genesisHash = "0".repeat(64);

function observed(pid: number): CodexSystemObservation {
  return {
    observedAtUnixMs: pid,
    protectedFiles: [
      {
        logicalName: "auth",
        canonicalPath: "C:\\auth.json",
        status: "present",
        sizeBytes: "1",
        modifiedAtUnixMs: 1,
        fileIdentity: "1:1",
        sha256: "a".repeat(64),
      },
    ],
    desktopProcesses: [{ pid }],
    loginContinuity: "authenticated",
    appUsability: "usable",
  };
}

describe("NonInterferenceGuard", () => {
  it("establishes, verifies, and explicitly renews an invalidated baseline", async () => {
    const observations = [observed(1), observed(2), observed(2)];
    const observer = {
      capture: async () => observations.shift() ?? observed(2),
    };
    const head: ActionLedgerView = {
      integrity: "valid",
      headSequence: 0,
      headHash: genesisHash,
      records: [],
    };
    const after: ActionLedgerView = {
      ...head,
      anchorSequence: 0,
      anchorHash: genesisHash,
    };
    const guard = new NonInterferenceGuard(observer, {
      readHead: async () => head,
      readAfter: async () => after,
    });

    const first = await guard.establishBaseline();
    const assessment = await guard.verify();
    expect(assessment.state).toBe("BASELINE_INVALIDATED");
    expect(assessment.canRenewBaseline).toBe(true);

    const renewed = await guard.renewBaseline({
      invalidatedBaselineId: first.id,
      assessment,
    });
    expect(renewed.id).not.toBe(first.id);
    expect(renewed.observation.desktopProcesses[0]?.pid).toBe(2);
  });

  it("refuses to establish a baseline while an action is unfinished", async () => {
    const guard = new NonInterferenceGuard(
      { capture: async () => observed(1) },
      {
        readHead: async () => ({
          integrity: "valid",
          headSequence: 1,
          headHash: "b".repeat(64),
          records: [
            {
              sequence: 1,
              timestampUnixMs: 1,
              operationId: "pending",
              kind: "child_process",
              effect: "start",
              phase: "intent",
              targetClass: "codex_runtime_child",
              targetFingerprint: "runtime-a",
            },
          ],
        }),
        readAfter: async () => {
          throw new Error("not used");
        },
      },
    );

    await expect(guard.establishBaseline()).rejects.toThrow(/ACTION_UNFINISHED/);
  });

  it("requires the renewal proof to refer to the active invalidated baseline", async () => {
    const observer = { capture: async () => observed(1) };
    const head: ActionLedgerView = {
      integrity: "valid",
      headSequence: 0,
      headHash: genesisHash,
      records: [],
    };
    const guard = new NonInterferenceGuard(observer, {
      readHead: async () => head,
      readAfter: async () => ({
        ...head,
        anchorSequence: 0,
        anchorHash: genesisHash,
      }),
    });
    await guard.establishBaseline();

    await expect(
      guard.renewBaseline({
        invalidatedBaselineId: "wrong",
        assessment: {
          state: "BASELINE_INVALIDATED",
          reasons: [],
          canRenewBaseline: true,
        },
      }),
    ).rejects.toThrow(/does not match/);
  });
});
