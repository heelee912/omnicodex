import { describe, expect, it } from "vitest";
import type {
  ActionLedgerView,
  ActionRecord,
  CodexSystemObservation,
  GuardBaseline,
} from "../src/domain/non-interference.js";
import { assessNonInterference } from "../src/domain/non-interference.js";

const genesisHash = "0".repeat(64);

function observation(overrides: Partial<CodexSystemObservation> = {}): CodexSystemObservation {
  return {
    observedAtUnixMs: 1,
    protectedFiles: [
      {
        logicalName: "auth",
        canonicalPath: "C:\\Users\\Owner\\.codex\\auth.json",
        status: "present",
        sizeBytes: "20",
        modifiedAtUnixMs: 100,
        fileIdentity: "1:2",
        sha256: "a".repeat(64),
      },
      {
        logicalName: "config",
        canonicalPath: "C:\\Users\\Owner\\.codex\\config.toml",
        status: "present",
        sizeBytes: "30",
        modifiedAtUnixMs: 101,
        fileIdentity: "1:3",
        sha256: "b".repeat(64),
      },
    ],
    desktopProcesses: [
      {
        pid: 100,
        startedAtUnixMs: 50,
        executableFingerprint: "exe-a",
        packageIdentity: "OpenAI.Codex_1",
      },
    ],
    installedPackage: {
      packageFamilyName: "OpenAI.Codex",
      fullName: "OpenAI.Codex_1",
      version: "1.0.0",
      installLocationFingerprint: "location-a",
    },
    loginContinuity: "authenticated",
    appUsability: "usable",
    ...overrides,
  };
}

function baseline(): GuardBaseline {
  return {
    id: "baseline-1",
    observation: observation(),
    ledgerHeadSequence: 0,
    ledgerHeadHash: genesisHash,
  };
}

function ledger(records: readonly ActionRecord[] = []): ActionLedgerView {
  return {
    integrity: "valid",
    headSequence: records.at(-1)?.sequence ?? 0,
    headHash: records.length === 0 ? genesisHash : "c".repeat(64),
    anchorSequence: 0,
    anchorHash: genesisHash,
    records,
  };
}

function action(
  sequence: number,
  phase: ActionRecord["phase"],
  overrides: Partial<ActionRecord> = {},
): ActionRecord {
  return {
    sequence,
    timestampUnixMs: sequence,
    operationId: "operation-1",
    kind: "child_process",
    effect: "start",
    phase,
    targetClass: "codex_runtime_child",
    targetFingerprint: "runtime-a",
    ...overrides,
  };
}

describe("assessNonInterference", () => {
  it("allows an unchanged observation with a valid anchored ledger", () => {
    expect(assessNonInterference(baseline(), observation(), ledger())).toEqual({
      state: "SAFE",
      reasons: [],
      canRenewBaseline: false,
    });
  });

  it("invalidates rather than falsely blaming OmniCodex for an independent app restart", () => {
    const current = observation({
      observedAtUnixMs: 2,
      desktopProcesses: [
        {
          pid: 101,
          startedAtUnixMs: 200,
          executableFingerprint: "exe-a",
          packageIdentity: "OpenAI.Codex_1",
        },
      ],
    });

    const result = assessNonInterference(baseline(), current, ledger());
    expect(result.state).toBe("BASELINE_INVALIDATED");
    expect(result.canRenewBaseline).toBe(true);
    expect(result.reasons.map((reason) => reason.code)).toContain("DESKTOP_PROCESS_CHANGED");
  });

  it("invalidates on an externally changed protected file", () => {
    const [authFile, configFile] = observation().protectedFiles;
    if (!authFile || !configFile) {
      throw new Error("expected protected-file fixtures");
    }
    const current = observation({
      protectedFiles: [
        {
          ...authFile,
          modifiedAtUnixMs: 102,
          sha256: "d".repeat(64),
        },
        configFile,
      ],
    });

    const result = assessNonInterference(baseline(), current, ledger());
    expect(result.state).toBe("BASELINE_INVALIDATED");
    expect(result.reasons.map((reason) => reason.code)).toContain("PROTECTED_FILE_CHANGED");
  });

  it("blocks an OmniCodex signal directed at the desktop app", () => {
    const records = [
      action(1, "intent", {
        kind: "process_signal",
        effect: "signal",
        targetClass: "codex_desktop",
      }),
      action(2, "failed", {
        kind: "process_signal",
        effect: "signal",
        targetClass: "codex_desktop",
      }),
    ];

    const result = assessNonInterference(baseline(), observation(), ledger(records));
    expect(result.state).toBe("BLOCKED");
    expect(result.reasons.map((reason) => reason.code)).toContain("OMNICODEX_DESKTOP_CONTROL");
  });

  it("blocks any attempted protected-path write even when it failed", () => {
    const records = [
      action(1, "intent", {
        kind: "protected_path_access",
        effect: "write",
        targetClass: "codex_auth",
      }),
      action(2, "failed", {
        kind: "protected_path_access",
        effect: "write",
        targetClass: "codex_auth",
      }),
    ];

    const result = assessNonInterference(baseline(), observation(), ledger(records));
    expect(result.state).toBe("BLOCKED");
    expect(result.reasons.map((reason) => reason.code)).toContain("OMNICODEX_PROTECTED_WRITE");
  });

  it("blocks an unauthorized persistent task mutation", () => {
    const records = [
      action(1, "intent", {
        kind: "shared_task_mutation",
        effect: "mutate",
        targetClass: "codex_task",
      }),
      action(2, "completed", {
        kind: "shared_task_mutation",
        effect: "mutate",
        targetClass: "codex_task",
      }),
    ];

    const result = assessNonInterference(baseline(), observation(), ledger(records));
    expect(result.state).toBe("BLOCKED");
    expect(result.reasons.map((reason) => reason.code)).toContain(
      "UNAUTHORIZED_SHARED_TASK_MUTATION",
    );
  });

  it("accepts an explicitly granted persistent task mutation", () => {
    const authorization = {
      kind: "explicit_persistent_request" as const,
      grantFingerprint: "grant-a",
      requestFingerprint: "request-a",
    };
    const records = [
      action(1, "intent", {
        kind: "shared_task_mutation",
        effect: "mutate",
        targetClass: "codex_task",
        authorization,
      }),
      action(2, "completed", {
        kind: "shared_task_mutation",
        effect: "mutate",
        targetClass: "codex_task",
        authorization,
      }),
    ];

    expect(assessNonInterference(baseline(), observation(), ledger(records)).state).toBe("SAFE");
  });

  it("blocks an unfinished action after a crash", () => {
    const result = assessNonInterference(baseline(), observation(), ledger([action(1, "intent")]));
    expect(result.state).toBe("BLOCKED");
    expect(result.reasons.map((reason) => reason.code)).toContain("ACTION_UNFINISHED");
  });

  it("blocks an unverifiable protected file", () => {
    const configFile = observation().protectedFiles[1];
    if (!configFile) {
      throw new Error("expected config-file fixture");
    }
    const current = observation({
      protectedFiles: [
        {
          logicalName: "auth",
          canonicalPath: "C:\\Users\\Owner\\.codex\\auth.json",
          status: "unverifiable",
          errorCode: "EACCES",
        },
        configFile,
      ],
    });
    const result = assessNonInterference(baseline(), current, ledger());
    expect(result.state).toBe("BLOCKED");
    expect(result.reasons.map((reason) => reason.code)).toContain("PROTECTED_FILE_UNVERIFIABLE");
  });

  it("blocks lost login continuity and refuses baseline renewal", () => {
    const result = assessNonInterference(
      baseline(),
      observation({ loginContinuity: "unauthenticated" }),
      ledger(),
    );
    expect(result.state).toBe("BLOCKED");
    expect(result.canRenewBaseline).toBe(false);
    expect(result.reasons.map((reason) => reason.code)).toContain("LOGIN_CONTINUITY_LOST");
  });

  it("blocks a rewritten or truncated action-ledger prefix", () => {
    const result = assessNonInterference(baseline(), observation(), {
      integrity: "valid",
      headSequence: 1,
      headHash: "e".repeat(64),
      anchorSequence: 0,
      anchorHash: "f".repeat(64),
      records: [],
    });
    expect(result.state).toBe("BLOCKED");
    expect(result.reasons.map((reason) => reason.code)).toContain("ACTION_LEDGER_INVALID");
  });
});
