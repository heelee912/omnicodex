import { describe, expect, it } from "vitest";
import {
  candidateAcceptanceGateNames,
  evaluateOmniCodexAcceptance,
  releasedAcceptanceGateNames,
} from "../src/application/release-acceptance.js";

const commit = "a".repeat(40);
const packageSha256 = "b".repeat(64);

describe("release acceptance", () => {
  it("refuses to infer candidate readiness from absent evidence", () => {
    const result = evaluateOmniCodexAcceptance(undefined, { stage: "candidate" });
    expect(result.ready).toBe(false);
    expect(result.gates).toHaveLength(candidateAcceptanceGateNames.length);
    expect(result.gates.every((gate) => gate.reason === "missing")).toBe(true);
  });

  it("requires every gate to be actual, same-commit, same-package evidence", () => {
    const evidence = fixture(candidateAcceptanceGateNames);
    evidence.gates.web_chatgpt_pro_full = {
      ...evidence.gates.web_chatgpt_pro_full,
      mode: "mock",
    };
    evidence.gates.oracle_consent_receipts = {
      ...evidence.gates.oracle_consent_receipts,
      packageSha256: "c".repeat(64),
    };
    const result = evaluateOmniCodexAcceptance(evidence, {
      stage: "candidate",
      sourceCommit: commit,
      packageVersion: "1.2.3",
      packageSha256,
    });
    expect(result.ready).toBe(false);
    expect(result.gates.find((gate) => gate.name === "web_chatgpt_pro_full")?.reason).toBe(
      "not_actual",
    );
    expect(result.gates.find((gate) => gate.name === "oracle_consent_receipts")?.reason).toBe(
      "identity_mismatch",
    );
  });

  it("separates a verified candidate from a released public artifact", () => {
    const candidate = fixture(candidateAcceptanceGateNames);
    expect(evaluateOmniCodexAcceptance(candidate, { stage: "candidate" }).ready).toBe(true);
    const released = evaluateOmniCodexAcceptance(candidate, { stage: "released" });
    expect(released.ready).toBe(false);
    expect(released.gates.filter((gate) => !gate.passed).map((gate) => gate.name)).toEqual([
      "npm_provenance",
      "github_release",
      "public_install_smoke",
    ]);
  });

  it("rejects a handcrafted artifact digest without the hashed byte size", () => {
    const evidence = fixture(candidateAcceptanceGateNames);
    const gate = evidence.gates.repository_history;
    if (gate === undefined) throw new Error("repository history fixture is missing");
    (evidence.gates as Record<string, Record<string, unknown>>).repository_history = {
      ...gate,
      artifacts: [{ kind: "receipt", sha256: "d".repeat(64) }],
    };
    const result = evaluateOmniCodexAcceptance(evidence, { stage: "candidate" });
    expect(result.ready).toBe(false);
    expect(result.gates[0]).toMatchObject({
      name: "repository_history",
      reason: "missing_artifact",
    });
  });

  it("accepts a released package only when all final gates are present", () => {
    expect(
      evaluateOmniCodexAcceptance(fixture(releasedAcceptanceGateNames), {
        stage: "released",
        sourceCommit: commit,
        packageSha256,
      }).ready,
    ).toBe(true);
  });
});

function fixture(gates: readonly string[]) {
  return {
    schemaVersion: 1,
    repository: "heelee912/omnicodex",
    sourceCommit: commit,
    package: {
      name: "@heelee912/omnicodex",
      version: "1.2.3",
      sha256: packageSha256,
    },
    gates: Object.fromEntries(
      gates.map((name) => [
        name,
        {
          mode: "actual",
          passed: true,
          sourceCommit: commit,
          packageVersion: "1.2.3",
          packageSha256,
          completedAt: "2026-08-21T00:00:00.000Z",
          artifacts: [{ kind: "receipt", sizeBytes: 1, sha256: "d".repeat(64) }],
        },
      ]),
    ) as Record<string, Record<string, unknown>>,
  };
}
