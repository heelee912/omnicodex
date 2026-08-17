export type VerificationState = "SAFE" | "BASELINE_INVALIDATED" | "BLOCKED";

export type ProtectedFileStatus = "present" | "missing" | "unverifiable";

export interface ProtectedFileObservation {
  readonly logicalName: string;
  readonly canonicalPath: string;
  readonly status: ProtectedFileStatus;
  readonly sizeBytes?: string;
  readonly modifiedAtUnixMs?: number;
  readonly fileIdentity?: string;
  readonly sha256?: string;
  readonly errorCode?: string;
}

export interface DesktopProcessObservation {
  readonly pid: number;
  readonly startedAtUnixMs?: number;
  readonly executableFingerprint?: string;
  readonly packageIdentity?: string;
}

export interface PackageObservation {
  readonly packageFamilyName: string;
  readonly fullName: string;
  readonly version: string;
  readonly installLocationFingerprint: string;
}

export type LoginContinuity = "authenticated" | "unauthenticated" | "unknown";
export type AppUsability = "usable" | "unusable" | "unknown";

export interface CodexSystemObservation {
  readonly observedAtUnixMs: number;
  readonly protectedFiles: readonly ProtectedFileObservation[];
  readonly desktopProcesses: readonly DesktopProcessObservation[];
  readonly installedPackage?: PackageObservation;
  readonly loginContinuity: LoginContinuity;
  readonly appUsability: AppUsability;
}

export type ActionKind =
  | "child_process"
  | "process_signal"
  | "protected_path_access"
  | "shared_task_mutation"
  | "network_request";

export type ActionEffect = "read" | "write" | "start" | "signal" | "mutate" | "send";
export type ActionPhase = "intent" | "completed" | "failed";

export interface PersistentMutationGrant {
  readonly kind: "explicit_persistent_request";
  readonly grantFingerprint: string;
  readonly requestFingerprint: string;
}

export interface ActionRecord {
  readonly sequence: number;
  readonly timestampUnixMs: number;
  readonly operationId: string;
  readonly kind: ActionKind;
  readonly effect: ActionEffect;
  readonly phase: ActionPhase;
  readonly targetClass: string;
  readonly targetFingerprint: string;
  readonly authorization?: PersistentMutationGrant;
  readonly outcomeCode?: string;
}

export interface ActionLedgerView {
  readonly integrity: "valid" | "invalid";
  readonly headSequence: number;
  readonly headHash: string;
  readonly anchorSequence?: number;
  readonly anchorHash?: string;
  readonly records: readonly ActionRecord[];
  readonly integrityError?: string;
}

export interface GuardBaseline {
  readonly id: string;
  readonly observation: CodexSystemObservation;
  readonly ledgerHeadSequence: number;
  readonly ledgerHeadHash: string;
}

export interface GuardReason {
  readonly code:
    | "ACTION_LEDGER_INVALID"
    | "ACTION_UNFINISHED"
    | "APP_USABILITY_LOST"
    | "DESKTOP_PROCESS_CHANGED"
    | "LOGIN_CONTINUITY_LOST"
    | "OMNICODEX_DESKTOP_CONTROL"
    | "OMNICODEX_PROTECTED_WRITE"
    | "PACKAGE_CHANGED"
    | "PROTECTED_FILE_CHANGED"
    | "PROTECTED_FILE_UNVERIFIABLE"
    | "UNAUTHORIZED_SHARED_TASK_MUTATION";
  readonly detail: string;
}

export interface GuardAssessment {
  readonly state: VerificationState;
  readonly reasons: readonly GuardReason[];
  readonly canRenewBaseline: boolean;
}

function sortedProtectedFiles(
  files: readonly ProtectedFileObservation[],
): readonly ProtectedFileObservation[] {
  return [...files].sort((left, right) => {
    const logical = left.logicalName.localeCompare(right.logicalName);
    return logical !== 0 ? logical : left.canonicalPath.localeCompare(right.canonicalPath);
  });
}

function sortedProcesses(
  processes: readonly DesktopProcessObservation[],
): readonly DesktopProcessObservation[] {
  return [...processes].sort((left, right) => {
    if (left.pid !== right.pid) {
      return left.pid - right.pid;
    }
    return (left.startedAtUnixMs ?? -1) - (right.startedAtUnixMs ?? -1);
  });
}

function equivalentRecord(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function unfinishedOperations(records: readonly ActionRecord[]): readonly ActionRecord[] {
  const lastByOperation = new Map<string, ActionRecord>();
  for (const record of records) {
    lastByOperation.set(record.operationId, record);
  }
  return [...lastByOperation.values()].filter((record) => record.phase === "intent");
}

function actionViolations(records: readonly ActionRecord[]): GuardReason[] {
  const reasons: GuardReason[] = [];

  for (const record of records) {
    if (record.phase !== "intent") {
      continue;
    }

    if (
      (record.kind === "process_signal" || record.kind === "child_process") &&
      record.targetClass === "codex_desktop"
    ) {
      reasons.push({
        code: "OMNICODEX_DESKTOP_CONTROL",
        detail: `operation ${record.operationId} attempted ${record.effect} on the Codex desktop`,
      });
    }

    if (record.kind === "protected_path_access" && record.effect !== "read") {
      reasons.push({
        code: "OMNICODEX_PROTECTED_WRITE",
        detail: `operation ${record.operationId} attempted ${record.effect} on a protected path`,
      });
    }

    if (
      record.kind === "shared_task_mutation" &&
      record.effect === "mutate" &&
      record.authorization?.kind !== "explicit_persistent_request"
    ) {
      reasons.push({
        code: "UNAUTHORIZED_SHARED_TASK_MUTATION",
        detail: `operation ${record.operationId} has no explicit persistent-request grant`,
      });
    }
  }

  return reasons;
}

export function actionLedgerBlockers(records: readonly ActionRecord[]): readonly GuardReason[] {
  const reasons = actionViolations(records);
  for (const unfinished of unfinishedOperations(records)) {
    reasons.push({
      code: "ACTION_UNFINISHED",
      detail: `operation ${unfinished.operationId} has an intent without a terminal record`,
    });
  }
  return reasons;
}

export function assessNonInterference(
  baseline: GuardBaseline,
  current: CodexSystemObservation,
  ledger: ActionLedgerView,
): GuardAssessment {
  const blockingReasons: GuardReason[] = [];
  const invalidationReasons: GuardReason[] = [];

  if (
    ledger.integrity !== "valid" ||
    ledger.headSequence < baseline.ledgerHeadSequence ||
    ledger.anchorSequence !== baseline.ledgerHeadSequence ||
    ledger.anchorHash !== baseline.ledgerHeadHash
  ) {
    blockingReasons.push({
      code: "ACTION_LEDGER_INVALID",
      detail: ledger.integrityError ?? "ledger head is inconsistent with the baseline",
    });
  }

  blockingReasons.push(...actionLedgerBlockers(ledger.records));

  const baselineFiles = sortedProtectedFiles(baseline.observation.protectedFiles);
  const currentFiles = sortedProtectedFiles(current.protectedFiles);

  for (const file of currentFiles) {
    if (file.status === "unverifiable") {
      blockingReasons.push({
        code: "PROTECTED_FILE_UNVERIFIABLE",
        detail: `${file.logicalName} could not be verified (${file.errorCode ?? "unknown error"})`,
      });
    }
  }

  if (!equivalentRecord(baselineFiles, currentFiles)) {
    invalidationReasons.push({
      code: "PROTECTED_FILE_CHANGED",
      detail: "one or more protected file identities, metadata values, or hashes changed",
    });
  }

  if (
    !equivalentRecord(
      sortedProcesses(baseline.observation.desktopProcesses),
      sortedProcesses(current.desktopProcesses),
    )
  ) {
    invalidationReasons.push({
      code: "DESKTOP_PROCESS_CHANGED",
      detail: "the observed Codex desktop process set changed",
    });
  }

  if (!equivalentRecord(baseline.observation.installedPackage, current.installedPackage)) {
    invalidationReasons.push({
      code: "PACKAGE_CHANGED",
      detail: "the installed Codex package identity changed",
    });
  }

  if (
    baseline.observation.loginContinuity === "authenticated" &&
    current.loginContinuity !== "authenticated"
  ) {
    blockingReasons.push({
      code: "LOGIN_CONTINUITY_LOST",
      detail: `login continuity changed from authenticated to ${current.loginContinuity}`,
    });
  }

  if (baseline.observation.appUsability === "usable" && current.appUsability !== "usable") {
    blockingReasons.push({
      code: "APP_USABILITY_LOST",
      detail: `app usability changed from usable to ${current.appUsability}`,
    });
  }

  if (blockingReasons.length > 0) {
    return {
      state: "BLOCKED",
      reasons: [...blockingReasons, ...invalidationReasons],
      canRenewBaseline: false,
    };
  }

  if (invalidationReasons.length > 0) {
    return {
      state: "BASELINE_INVALIDATED",
      reasons: invalidationReasons,
      canRenewBaseline:
        current.loginContinuity === "authenticated" && current.appUsability === "usable",
    };
  }

  return {
    state: "SAFE",
    reasons: [],
    canRenewBaseline: false,
  };
}
