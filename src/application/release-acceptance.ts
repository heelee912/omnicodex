export const candidateAcceptanceGateNames = [
  "repository_history",
  "static_quality",
  "guard_non_interference",
  "installed_runtime_discovery",
  "native_catalog_complete",
  "ordinary_zero_model",
  "scheduler_transport",
  "auth0_dcr_pkce",
  "ngrok_external",
  "official_inspector",
  "web_chatgpt_pro_full",
  "oracle_consent_receipts",
  "autostart_reboot",
  "runtime_switch_rollback",
  "package_update_rollback",
  "gui_e2e",
  "ci_same_commit",
  "documentation_same_commit",
] as const;

export const releasedAcceptanceGateNames = [
  ...candidateAcceptanceGateNames,
  "npm_provenance",
  "github_release",
  "public_install_smoke",
] as const;

export type OmniCodexAcceptanceStage = "candidate" | "released";

export interface OmniCodexAcceptanceExpectation {
  readonly stage: OmniCodexAcceptanceStage;
  readonly sourceCommit?: string;
  readonly packageVersion?: string;
  readonly packageSha256?: string;
}

export interface OmniCodexAcceptanceGateResult {
  readonly name: string;
  readonly passed: boolean;
  readonly reason?:
    | "missing"
    | "not_actual"
    | "not_passed"
    | "identity_mismatch"
    | "invalid_timestamp"
    | "missing_artifact";
}

export interface OmniCodexAcceptanceReadiness {
  readonly ready: boolean;
  readonly stage: OmniCodexAcceptanceStage;
  readonly sourceCommit?: string;
  readonly packageVersion?: string;
  readonly packageSha256?: string;
  readonly gates: readonly OmniCodexAcceptanceGateResult[];
}

/**
 * Verifies release evidence without inferring success from tests, old runs, or
 * another package. Every required gate must be an actual run bound to the same
 * source commit and package digest, with at least one hashed artifact.
 */
export function evaluateOmniCodexAcceptance(
  value: unknown,
  expectation: OmniCodexAcceptanceExpectation,
): OmniCodexAcceptanceReadiness {
  const evidence = isObject(value) ? value : undefined;
  const sourceCommit = validCommit(evidence?.sourceCommit);
  const packageValue = isObject(evidence?.package) ? evidence.package : undefined;
  const packageVersion = validVersion(packageValue?.version);
  const packageSha256 = validSha256(packageValue?.sha256);
  const identityValid =
    evidence?.schemaVersion === 1 &&
    evidence?.repository === "heelee912/omnicodex" &&
    packageValue?.name === "@heelee912/omnicodex" &&
    sourceCommit !== undefined &&
    packageVersion !== undefined &&
    packageSha256 !== undefined &&
    (expectation.sourceCommit === undefined || sourceCommit === expectation.sourceCommit) &&
    (expectation.packageVersion === undefined || packageVersion === expectation.packageVersion) &&
    (expectation.packageSha256 === undefined || packageSha256 === expectation.packageSha256);
  const rawGates = isObject(evidence?.gates) ? evidence.gates : {};
  const required =
    expectation.stage === "released" ? releasedAcceptanceGateNames : candidateAcceptanceGateNames;
  const gates = required.map((name): OmniCodexAcceptanceGateResult => {
    const gate = isObject(rawGates[name]) ? rawGates[name] : undefined;
    if (gate === undefined) return { name, passed: false, reason: "missing" };
    if (
      !identityValid ||
      gate.sourceCommit !== sourceCommit ||
      gate.packageVersion !== packageVersion ||
      gate.packageSha256 !== packageSha256
    ) {
      return { name, passed: false, reason: "identity_mismatch" };
    }
    if (gate.mode !== "actual") return { name, passed: false, reason: "not_actual" };
    if (gate.passed !== true) return { name, passed: false, reason: "not_passed" };
    if (!validTimestamp(gate.completedAt)) {
      return { name, passed: false, reason: "invalid_timestamp" };
    }
    if (!validArtifacts(gate.artifacts)) {
      return { name, passed: false, reason: "missing_artifact" };
    }
    return { name, passed: true };
  });
  return {
    ready: identityValid && gates.every((gate) => gate.passed),
    stage: expectation.stage,
    ...(sourceCommit === undefined ? {} : { sourceCommit }),
    ...(packageVersion === undefined ? {} : { packageVersion }),
    ...(packageSha256 === undefined ? {} : { packageSha256 }),
    gates,
  };
}

function validArtifacts(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (artifact) =>
        isObject(artifact) &&
        typeof artifact.kind === "string" &&
        /^[a-z0-9_-]{1,64}$/.test(artifact.kind) &&
        Number.isSafeInteger(artifact.sizeBytes) &&
        (artifact.sizeBytes as number) > 0 &&
        validSha256(artifact.sha256) !== undefined,
    )
  );
}

function validCommit(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value) ? value : undefined;
}

function validVersion(value: unknown): string | undefined {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
    ? value
    : undefined;
}

function validSha256(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

function validTimestamp(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
