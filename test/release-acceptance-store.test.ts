import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateOmniCodexAcceptance } from "../src/application/release-acceptance.js";
import { ReleaseAcceptanceStore } from "../src/infrastructure/release/release-acceptance-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ReleaseAcceptanceStore", () => {
  it("atomically records hash-only same-build actual evidence", async () => {
    const root = await temporaryDirectory();
    const evidencePath = join(root, "release-acceptance.json");
    const artifactPath = join(root, "runtime-probe.json");
    await writeFile(artifactPath, '{"ok":true}\n', "utf8");
    const store = new ReleaseAcceptanceStore(evidencePath, () => new Date("2026-08-21T01:02:03Z"));
    await store.record({
      gate: "installed_runtime_discovery",
      sourceCommit: "a".repeat(40),
      packageVersion: "1.2.3",
      packageSha256: "b".repeat(64),
      artifacts: [{ kind: "runtime_probe", path: artifactPath }],
    });
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    expect(JSON.stringify(evidence)).not.toContain(artifactPath);
    expect(evidence.gates.installed_runtime_discovery).toMatchObject({
      mode: "actual",
      passed: true,
      packageVersion: "1.2.3",
      completedAt: "2026-08-21T01:02:03.000Z",
      artifacts: [{ kind: "runtime_probe", sizeBytes: 12 }],
    });
  });

  it("rejects cross-build mutation and different replacement evidence", async () => {
    const root = await temporaryDirectory();
    const evidencePath = join(root, "release-acceptance.json");
    const first = join(root, "first.txt");
    const second = join(root, "second.txt");
    await Promise.all([writeFile(first, "first", "utf8"), writeFile(second, "second", "utf8")]);
    const store = new ReleaseAcceptanceStore(evidencePath);
    const base = {
      gate: "static_quality",
      sourceCommit: "a".repeat(40),
      packageVersion: "1.2.3",
      packageSha256: "b".repeat(64),
    } as const;
    await store.record({ ...base, artifacts: [{ kind: "check", path: first }] });
    await expect(
      store.record({ ...base, artifacts: [{ kind: "check", path: second }] }),
    ).rejects.toThrow("immutable evidence");
    await expect(
      store.record({
        ...base,
        sourceCommit: "c".repeat(40),
        artifacts: [{ kind: "check", path: first }],
      }),
    ).rejects.toThrow("different build");
  });

  it("makes package-version mismatches fail acceptance identity", async () => {
    const evidence = {
      schemaVersion: 1,
      repository: "heelee912/omnicodex",
      sourceCommit: "a".repeat(40),
      package: {
        name: "@heelee912/omnicodex",
        version: "1.2.3",
        sha256: "b".repeat(64),
      },
      gates: {
        repository_history: {
          mode: "actual",
          passed: true,
          sourceCommit: "a".repeat(40),
          packageVersion: "9.9.9",
          packageSha256: "b".repeat(64),
          completedAt: "2026-08-21T00:00:00Z",
          artifacts: [{ kind: "git", sizeBytes: 1, sha256: "d".repeat(64) }],
        },
      },
    };
    expect(evaluateOmniCodexAcceptance(evidence, { stage: "candidate" }).gates[0]?.reason).toBe(
      "identity_mismatch",
    );
  });

  it("fails closed when another writer owns the evidence lock", async () => {
    const root = await temporaryDirectory();
    const evidencePath = join(root, "release-acceptance.json");
    const artifactPath = join(root, "check.txt");
    await Promise.all([
      writeFile(`${evidencePath}.lock`, "owned", "utf8"),
      writeFile(artifactPath, "actual-result", "utf8"),
    ]);
    const store = new ReleaseAcceptanceStore(evidencePath);
    await expect(
      store.record({
        gate: "static_quality",
        sourceCommit: "a".repeat(40),
        packageVersion: "1.2.3",
        packageSha256: "b".repeat(64),
        artifacts: [{ kind: "check", path: artifactPath }],
      }),
    ).rejects.toThrow("owns the evidence lock");
  });

  it("rejects manual and previous-boot receipts for the autostart reboot gate", async () => {
    const root = await temporaryDirectory();
    const evidencePath = join(root, "release-acceptance.json");
    const receiptPath = join(root, "autostart.jsonl");
    const now = Date.parse("2026-08-21T02:00:00.000Z");
    const bootedAtUnixMs = now - 30 * 60_000;
    const store = new ReleaseAcceptanceStore(
      evidencePath,
      () => new Date(now),
      () => 30 * 60,
    );
    const input = {
      gate: "autostart_reboot",
      sourceCommit: "a".repeat(40),
      packageVersion: "1.2.3",
      packageSha256: "b".repeat(64),
      artifacts: [{ kind: "autostart_reboot_receipt", path: receiptPath }],
    } as const;
    await writeFile(
      receiptPath,
      `${JSON.stringify(autostartReceipt({ source: "manual-test", bootedAtUnixMs }))}\n`,
      "utf8",
    );
    await expect(store.preview(input)).rejects.toThrow("successful Scheduled Task launch");

    await writeFile(
      receiptPath,
      `${JSON.stringify(
        autostartReceipt({ source: "scheduled-task", bootedAtUnixMs: bootedAtUnixMs - 60_000 }),
      )}\n`,
      "utf8",
    );
    await expect(store.preview(input)).rejects.toThrow("previous boot");
  });

  it("accepts only a current-boot same-build Scheduled Task receipt", async () => {
    const root = await temporaryDirectory();
    const evidencePath = join(root, "release-acceptance.json");
    const receiptPath = join(root, "autostart.jsonl");
    const now = Date.parse("2026-08-21T02:00:00.000Z");
    const bootedAtUnixMs = now - 30 * 60_000;
    await writeFile(
      receiptPath,
      [
        JSON.stringify(autostartReceipt({ source: "manual-test", bootedAtUnixMs })),
        JSON.stringify(autostartReceipt({ source: "scheduled-task", bootedAtUnixMs })),
        "",
      ].join("\n"),
      "utf8",
    );
    const store = new ReleaseAcceptanceStore(
      evidencePath,
      () => new Date(now),
      () => 30 * 60,
    );
    const evidence = await store.preview({
      gate: "autostart_reboot",
      sourceCommit: "a".repeat(40),
      packageVersion: "1.2.3",
      packageSha256: "b".repeat(64),
      artifacts: [{ kind: "autostart_reboot_receipt", path: receiptPath }],
    });
    expect(evidence.gates).toHaveProperty("autostart_reboot");

    await writeFile(
      receiptPath,
      `${JSON.stringify(
        autostartReceipt({
          source: "scheduled-task",
          bootedAtUnixMs,
          pointerActivatedAtUnixMs: bootedAtUnixMs + 60_000,
        }),
      )}\n`,
      "utf8",
    );
    await expect(
      store.preview({
        gate: "autostart_reboot",
        sourceCommit: "a".repeat(40),
        packageVersion: "1.2.3",
        packageSha256: "b".repeat(64),
        artifacts: [{ kind: "autostart_reboot_receipt", path: receiptPath }],
      }),
    ).rejects.toThrow("timestamps are inconsistent");
  });

  it("rejects hash-only external evidence that lacks the exact live receipt contract", async () => {
    const root = await temporaryDirectory();
    const artifactPath = join(root, "web.json");
    await writeFile(artifactPath, '{"ok":true}\n', "utf8");
    const store = new ReleaseAcceptanceStore(join(root, "release-acceptance.json"));
    await expect(
      store.preview({
        gate: "web_chatgpt_pro_full",
        sourceCommit: "a".repeat(40),
        packageVersion: "1.2.3",
        packageSha256: "b".repeat(64),
        artifacts: [{ kind: "web_chatgpt_pro_full_receipt", path: artifactPath }],
      }),
    ).rejects.toThrow("exact build");
  });

  it("accepts an attributable Web Pro native trace without fixing its model or tool plan", async () => {
    const root = await temporaryDirectory();
    const receiptPath = join(root, "web-pro-direct.json");
    const common = releaseIdentity();
    const receipt = webChatgptProReceipt(common);
    receipt.model = "future-pro-model";
    receipt.power = 42;
    const evidence = recordValue(receipt.directWorkEvidence);
    const actor = recordValue(evidence.actor);
    actor.model = "future-pro-model";
    actor.power = 42;
    evidence.steps = [directWorkStep(receipt, 3), directWorkStep(receipt, 0)];
    directWorkStep(receipt, 0).toolName = "future__native__tool";
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
    const store = new ReleaseAcceptanceStore(join(root, "release-acceptance.json"));
    const result = await store.preview({
      gate: "web_chatgpt_pro_full",
      ...common,
      artifacts: [{ kind: "web_chatgpt_pro_full_receipt", path: receiptPath }],
    });
    expect(result.gates).toHaveProperty("web_chatgpt_pro_full");
  });

  it("rejects legacy Web Pro booleans without attributable direct-work evidence", async () => {
    const root = await temporaryDirectory();
    const receiptPath = join(root, "web-pro-legacy.json");
    const common = releaseIdentity();
    const receipt = webChatgptProReceipt(common);
    delete receipt.directWorkEvidence;
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
    const store = new ReleaseAcceptanceStore(join(root, "release-acceptance.json"));
    await expect(
      store.preview({
        gate: "web_chatgpt_pro_full",
        ...common,
        artifacts: [{ kind: "web_chatgpt_pro_full_receipt", path: receiptPath }],
      }),
    ).rejects.toThrow("structured attributable direct-work evidence");
  });

  it("rejects structured delegation or model-proxy ownership without classifying tool names", async () => {
    const root = await temporaryDirectory();
    const common = releaseIdentity();
    const cases: readonly {
      readonly name: string;
      readonly error: string;
      readonly mutate: (receipt: Record<string, unknown>) => void;
    }[] = [
      {
        name: "delegated",
        error: "non-delegated and zero-model",
        mutate: (receipt) => {
          recordValue(receipt.directWorkEvidence).delegated = true;
        },
      },
      {
        name: "other-model-owner",
        error: "executed directly by Web ChatGPT Pro with zero model use",
        mutate: (receipt) => {
          const step = directWorkStep(receipt, 3);
          step.executionOwner = "codex_model";
          step.modelEffect = true;
          step.modelUsage = 1;
        },
      },
    ];

    for (const testCase of cases) {
      const receipt = webChatgptProReceipt(common);
      testCase.mutate(receipt);
      const receiptPath = join(root, `${testCase.name}.json`);
      await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
      const store = new ReleaseAcceptanceStore(
        join(root, `${testCase.name}-release-acceptance.json`),
      );
      await expect(
        store.preview({
          gate: "web_chatgpt_pro_full",
          ...common,
          artifacts: [{ kind: "web_chatgpt_pro_full_receipt", path: receiptPath }],
        }),
      ).rejects.toThrow(testCase.error);
    }
  });

  it("rejects cross-run and duplicate-call Web Pro traces", async () => {
    const root = await temporaryDirectory();
    const common = releaseIdentity();
    const cases: readonly {
      readonly name: string;
      readonly error: string;
      readonly mutate: (receipt: Record<string, unknown>) => void;
    }[] = [
      {
        name: "cross-run-step",
        error: "same Web ChatGPT Pro run",
        mutate: (receipt) => {
          directWorkStep(receipt, 2).actorRunId = "different-pro-run";
        },
      },
      {
        name: "duplicate-call-id",
        error: "distinct call identities",
        mutate: (receipt) => {
          directWorkStep(receipt, 4).callId = directWorkStep(receipt, 3).callId;
        },
      },
    ];

    for (const testCase of cases) {
      const receipt = webChatgptProReceipt(common);
      testCase.mutate(receipt);
      const receiptPath = join(root, `${testCase.name}.json`);
      await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
      const store = new ReleaseAcceptanceStore(
        join(root, `${testCase.name}-release-acceptance.json`),
      );
      await expect(
        store.preview({
          gate: "web_chatgpt_pro_full",
          ...common,
          artifacts: [{ kind: "web_chatgpt_pro_full_receipt", path: receiptPath }],
        }),
      ).rejects.toThrow(testCase.error);
    }
  });

  it("keeps public registry proof out of the prepublish package candidate gate", async () => {
    const root = await temporaryDirectory();
    const receiptPath = join(root, "package.json");
    const common = {
      sourceCommit: "a".repeat(40),
      packageVersion: "1.2.3",
      packageSha256: "b".repeat(64),
    } as const;
    await writeFile(
      receiptPath,
      `${JSON.stringify({
        event: "package_update_rollback_succeeded",
        ...common,
        registryIntegrity: true,
        provenance: true,
        publicArtifact: true,
        sbom: true,
        shadowProbe: true,
        admissionDrained: true,
        atomicSwitch: true,
        rollbackObserved: true,
        protectedCodexFilesUnchanged: true,
      })}\n`,
      "utf8",
    );
    const store = new ReleaseAcceptanceStore(join(root, "release-acceptance.json"));
    await expect(
      store.preview({
        gate: "package_update_rollback",
        ...common,
        artifacts: [{ kind: "package_update_rollback_receipt", path: receiptPath }],
      }),
    ).rejects.toThrow("staged-candidate");
  });

  it("rejects the legacy GUI boolean receipt without attributable capability calls", async () => {
    const root = await temporaryDirectory();
    const receiptPath = join(root, "legacy-gui.json");
    const common = releaseIdentity();
    await writeFile(
      receiptPath,
      `${JSON.stringify({
        event: "gui_e2e_succeeded",
        ...common,
        browser: true,
        chrome: true,
        computerUse: true,
        codexAppContinuity: true,
        protectedCodexFilesUnchanged: true,
      })}\n`,
      "utf8",
    );
    const store = new ReleaseAcceptanceStore(join(root, "release-acceptance.json"));
    await expect(
      store.preview({
        gate: "gui_e2e",
        ...common,
        artifacts: [{ kind: "gui_e2e_receipt", path: receiptPath }],
      }),
    ).rejects.toThrow("structured capability evidence");
  });

  it("accepts structured GUI evidence including an empty read-only ADB inventory", async () => {
    const root = await temporaryDirectory();
    const receiptPath = join(root, "gui.json");
    const common = releaseIdentity();
    const receipt = guiE2eReceipt(common);
    const evidence = recordValue(receipt.capabilityEvidence);
    const adb = recordValue(evidence.adb);
    adb.connectedDeviceCount = 0;
    delete adb.connectedDeviceIdentifiersSha256;
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
    const store = new ReleaseAcceptanceStore(join(root, "release-acceptance.json"));
    const result = await store.preview({
      gate: "gui_e2e",
      ...common,
      artifacts: [{ kind: "gui_e2e_receipt", path: receiptPath }],
    });
    expect(result.gates).toHaveProperty("gui_e2e");
  });

  it("rejects incomplete or internally inconsistent GUI capability evidence", async () => {
    const root = await temporaryDirectory();
    const common = releaseIdentity();
    const cases: readonly {
      readonly name: string;
      readonly error: string;
      readonly mutate: (receipt: Record<string, unknown>) => void;
    }[] = [
      {
        name: "same-browser-surface",
        error: "Chrome proof",
        mutate: (receipt) => {
          const evidence = recordValue(receipt.capabilityEvidence);
          recordValue(evidence.chrome).surface = "iab";
        },
      },
      {
        name: "sentinel-digest-mismatch",
        error: "sentinel file write/read digest",
        mutate: (receipt) => {
          const evidence = recordValue(receipt.capabilityEvidence);
          recordValue(evidence.sentinelFile).contentSha256 = "f".repeat(64);
        },
      },
      {
        name: "foreground-terminal",
        error: "hidden shell-free",
        mutate: (receipt) => {
          const evidence = recordValue(receipt.capabilityEvidence);
          recordValue(evidence.hiddenTerminal).windowsHide = false;
        },
      },
      {
        name: "connected-adb-without-device-readback",
        error: "connected ADB devices",
        mutate: (receipt) => {
          const evidence = recordValue(receipt.capabilityEvidence);
          delete recordValue(evidence.adb).connectedDeviceIdentifiersSha256;
        },
      },
      {
        name: "unbounded-godot",
        error: "bounded read-only probe",
        mutate: (receipt) => {
          const evidence = recordValue(receipt.capabilityEvidence);
          recordValue(evidence.godot).timeoutMs = 120_001;
        },
      },
      {
        name: "changed-codex-instance",
        error: "changed continuity identity",
        mutate: (receipt) => {
          const evidence = recordValue(receipt.capabilityEvidence);
          const continuity = recordValue(evidence.localCodexContinuity);
          recordValue(continuity.during).appInstanceId = "different-app-instance";
        },
      },
      {
        name: "reused-codex-continuity-call",
        error: "continuity phases require distinct calls",
        mutate: (receipt) => {
          const evidence = recordValue(receipt.capabilityEvidence);
          const continuity = recordValue(evidence.localCodexContinuity);
          recordValue(continuity.during).callId = recordValue(continuity.before).callId;
        },
      },
      {
        name: "changed-protected-files",
        error: "protected-file proof",
        mutate: (receipt) => {
          const evidence = recordValue(receipt.capabilityEvidence);
          recordValue(evidence.localCodexContinuity).protectedFilesAfterSha256 = "f".repeat(64);
        },
      },
    ];

    for (const testCase of cases) {
      const receipt = guiE2eReceipt(common);
      testCase.mutate(receipt);
      const receiptPath = join(root, `${testCase.name}.json`);
      await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
      const store = new ReleaseAcceptanceStore(join(root, `${testCase.name}-acceptance.json`));
      await expect(
        store.preview({
          gate: "gui_e2e",
          ...common,
          artifacts: [{ kind: "gui_e2e_receipt", path: receiptPath }],
        }),
      ).rejects.toThrow(testCase.error);
    }
  });

  it("validates every security-sensitive candidate receipt before hashing it", async () => {
    const root = await temporaryDirectory();
    const sourceCommit = "a".repeat(40);
    const packageVersion = "1.2.3";
    const packageSha256 = "b".repeat(64);
    const common = { sourceCommit, packageVersion, packageSha256 };
    const cases = [
      {
        gate: "ordinary_zero_model",
        kind: "ordinary_zero_model_receipt",
        receipt: {
          event: "ordinary_zero_model_succeeded",
          ...common,
          providerRequestCount: 0,
          modelUsage: 0,
          nativeToolCalls: 1,
        },
      },
      {
        gate: "auth0_dcr_pkce",
        kind: "auth0_dcr_pkce_receipt",
        receipt: {
          event: "auth0_dcr_pkce_succeeded",
          ...common,
          publicClient: true,
          pkceMethod: "S256",
          codeExchange: true,
          refresh: true,
          offlineAccess: true,
          resource: "https://example.test/mcp/full",
        },
      },
      {
        gate: "ngrok_external",
        kind: "ngrok_external_receipt",
        receipt: {
          event: "ngrok_external_succeeded",
          ...common,
          tlsVerified: true,
          protectedMetadata: true,
          authenticatedMcp: true,
          resource: "https://example.test/mcp/full",
        },
      },
      {
        gate: "official_inspector",
        kind: "official_inspector_receipt",
        receipt: {
          event: "official_inspector_succeeded",
          ...common,
          officialClient: true,
          initialize: true,
          listPaging: true,
          call: true,
          progress: true,
          cancellation: true,
          resources: true,
          localSurface: true,
          externalSurface: true,
        },
      },
      {
        gate: "web_chatgpt_pro_full",
        kind: "web_chatgpt_pro_full_receipt",
        receipt: webChatgptProReceipt(common),
      },
      {
        gate: "oracle_consent_receipts",
        kind: "oracle_consent_receipts",
        receipt: {
          event: "oracle_consent_verified",
          ...common,
          freshLiveVerification: "verified",
          connect: true,
          alwaysAllow: true,
          connectorId: "connector",
          runId: "run",
          correlationId: "correlation",
          resource: "https://example.test/mcp/full",
          surface: "/mcp/full",
        },
      },
      {
        gate: "runtime_switch_rollback",
        kind: "runtime_switch_rollback_receipt",
        receipt: {
          event: "runtime_switch_rollback_succeeded",
          ...common,
          distinctInstalledCandidate: true,
          shadowProbe: true,
          admissionDrained: true,
          atomicSwitch: true,
          rollbackObserved: true,
          protectedCodexFilesUnchanged: true,
        },
      },
      {
        gate: "package_update_rollback",
        kind: "package_update_rollback_receipt",
        receipt: {
          event: "package_update_rollback_succeeded",
          ...common,
          candidateArtifact: true,
          candidateIntegrity: true,
          sbom: true,
          shadowProbe: true,
          admissionDrained: true,
          atomicSwitch: true,
          rollbackObserved: true,
          protectedCodexFilesUnchanged: true,
        },
      },
      {
        gate: "gui_e2e",
        kind: "gui_e2e_receipt",
        receipt: guiE2eReceipt(common),
      },
    ] as const;
    for (const [index, testCase] of cases.entries()) {
      const artifactPath = join(root, `${index}.json`);
      await writeFile(artifactPath, `${JSON.stringify(testCase.receipt)}\n`, "utf8");
      const store = new ReleaseAcceptanceStore(join(root, `${index}-acceptance.json`));
      const result = await store.preview({
        gate: testCase.gate,
        sourceCommit,
        packageVersion,
        packageSha256,
        artifacts: [{ kind: testCase.kind, path: artifactPath }],
      });
      expect(result.gates).toHaveProperty(testCase.gate);
    }
  });
});

function autostartReceipt(input: {
  readonly source: "manual-test" | "scheduled-task";
  readonly bootedAtUnixMs: number;
  readonly pointerActivatedAtUnixMs?: number;
}): Record<string, unknown> {
  return {
    timestamp: "2026-08-21T01:31:00.000Z",
    startedAt: "2026-08-21T01:30:30.000Z",
    source: input.source,
    bootedAtUnixMs: input.bootedAtUnixMs,
    event: "autostart_succeeded",
    attempts: 1,
    exitCode: 0,
    pointerVersion: "1.2.3",
    pointerSourceCommit: "a".repeat(40),
    pointerActivatedAtUnixMs: input.pointerActivatedAtUnixMs ?? 123,
  };
}

function releaseIdentity(): {
  readonly sourceCommit: string;
  readonly packageVersion: string;
  readonly packageSha256: string;
} {
  return {
    sourceCommit: "a".repeat(40),
    packageVersion: "1.2.3",
    packageSha256: "b".repeat(64),
  };
}

function webChatgptProReceipt(identity: {
  readonly sourceCommit: string;
  readonly packageVersion: string;
  readonly packageSha256: string;
}): Record<string, unknown> {
  const actorRunId = "web-pro-run-1";
  const correlationId = "web-pro-correlation-1";
  const projectTargetSha256 = "1".repeat(64);
  const beforeSha256 = "2".repeat(64);
  const afterSha256 = "3".repeat(64);
  const effectId = "project-write-effect-1";
  const step = (input: {
    readonly sequence: number;
    readonly phase: string;
    readonly toolName: string;
    readonly stateEffect: "read" | "write" | "execute";
    readonly callId: string;
    readonly targetSha256: string;
    readonly authoritativeReadbackSha256: string;
    readonly extras?: Readonly<Record<string, unknown>>;
  }): Record<string, unknown> => ({
    sequence: input.sequence,
    phase: input.phase,
    toolName: input.toolName,
    route: "/mcp/full",
    callId: input.callId,
    correlationId,
    actorRunId,
    executionOwner: "web_chatgpt_pro",
    modelEffect: false,
    providerRequestCount: 0,
    modelUsage: 0,
    stateEffect: input.stateEffect,
    outcome: "succeeded",
    targetSha256: input.targetSha256,
    authoritativeReadbackSha256: input.authoritativeReadbackSha256,
    ...input.extras,
  });
  return {
    event: "web_chatgpt_pro_full_succeeded",
    ...identity,
    model: "gpt-5.6-sol",
    power: 5,
    registration: true,
    auth0Completed: true,
    dcrPkce: true,
    stableTools: true,
    fullSurface: true,
    ordinaryRead: true,
    ordinaryWrite: true,
    ordinaryProviderRequestCount: 0,
    ordinaryModelUsage: 0,
    streamingProgress: true,
    mediaOrProtectedResource: true,
    explicitModelCall: true,
    explicitModelUsage: 1,
    persistentTaskCreated: 1,
    missingScopeDenied: true,
    unapprovedSubjectDenied: true,
    codexAppContinuity: true,
    taskOutcome: "executed",
    resource: "https://example.test/mcp/full",
    directWorkEvidence: {
      schemaVersion: 1,
      actor: {
        kind: "web_chatgpt_pro",
        model: "gpt-5.6-sol",
        power: 5,
        conversationIdSha256: "4".repeat(64),
        mcpSessionIdSha256: "5".repeat(64),
        connectorId: "omnicodex-connector",
        runId: actorRunId,
      },
      delegated: false,
      providerRequestCount: 0,
      modelUsage: 0,
      modelInvocationCount: 0,
      correlationId,
      steps: [
        step({
          sequence: 1,
          phase: "context_read",
          toolName: "codex_app__read_thread",
          stateEffect: "read",
          callId: "web-pro-context-read-1",
          targetSha256: "6".repeat(64),
          authoritativeReadbackSha256: "7".repeat(64),
        }),
        step({
          sequence: 2,
          phase: "project_read",
          toolName: "codex__app_server__fs_readFile",
          stateEffect: "read",
          callId: "web-pro-project-read-1",
          targetSha256: projectTargetSha256,
          authoritativeReadbackSha256: beforeSha256,
        }),
        step({
          sequence: 3,
          phase: "project_write",
          toolName: "apply_patch",
          stateEffect: "write",
          callId: "web-pro-project-write-1",
          targetSha256: projectTargetSha256,
          authoritativeReadbackSha256: afterSha256,
          extras: { beforeSha256, afterSha256, effectId },
        }),
        step({
          sequence: 4,
          phase: "test_exec",
          toolName: "codex__app_server__command_exec",
          stateEffect: "execute",
          callId: "web-pro-test-exec-1",
          targetSha256: projectTargetSha256,
          authoritativeReadbackSha256: "8".repeat(64),
          extras: {
            inputEffectId: effectId,
            testedContentSha256: afterSha256,
            exitCode: 0,
          },
        }),
        step({
          sequence: 5,
          phase: "project_readback",
          toolName: "codex__app_server__fs_readFile",
          stateEffect: "read",
          callId: "web-pro-project-readback-1",
          targetSha256: projectTargetSha256,
          authoritativeReadbackSha256: afterSha256,
          extras: { verifiesEffectId: effectId },
        }),
      ],
    },
  };
}

function directWorkStep(receipt: Record<string, unknown>, index: number): Record<string, unknown> {
  const evidence = recordValue(receipt.directWorkEvidence);
  const steps = arrayValue(evidence.steps);
  return recordValue(steps[index]);
}

function guiE2eReceipt(identity: {
  readonly sourceCommit: string;
  readonly packageVersion: string;
  readonly packageSha256: string;
}): Record<string, unknown> {
  const sentinelDigest = "1".repeat(64);
  const terminalDigest = "2".repeat(64);
  const adbDigest = "3".repeat(64);
  const godotDigest = "4".repeat(64);
  const protectedFilesDigest = "5".repeat(64);
  const threadId = "019f5652-7f40-7db2-b19c-10eb4fbc919c";
  const appInstanceId = "codex-app-instance-1234";
  const continuityRoute = "codex-app-native";
  return {
    event: "gui_e2e_succeeded",
    ...identity,
    browser: true,
    chrome: true,
    computerUse: true,
    codexAppContinuity: true,
    protectedCodexFilesUnchanged: true,
    capabilityEvidence: {
      schemaVersion: 1,
      inAppBrowser: capabilityCall({
        toolName: "browser__control_in_app_browser",
        route: "/mcp/full",
        surface: "iab",
        callId: "call-iab-1",
        digest: "6".repeat(64),
      }),
      chrome: capabilityCall({
        toolName: "chrome__control_chrome",
        route: "/mcp/full",
        surface: "chrome",
        callId: "call-chrome-1",
        digest: "7".repeat(64),
      }),
      computerUse: {
        ...capabilityCall({
          toolName: "codex__computer_use__list_apps",
          route: "/mcp/full",
          surface: "computer_use",
          callId: "call-computer-use-1",
          digest: "8".repeat(64),
        }),
        readOnly: true,
      },
      sentinelFile: {
        pathSha256: "9".repeat(64),
        contentSha256: sentinelDigest,
        write: capabilityCall({
          toolName: "codex__app_server__fs_writeFile",
          route: "/mcp/full",
          surface: "filesystem",
          callId: "call-file-write-1",
          digest: sentinelDigest,
        }),
        read: capabilityCall({
          toolName: "codex__app_server__fs_readFile",
          route: "/mcp/full",
          surface: "filesystem",
          callId: "call-file-read-1",
          digest: sentinelDigest,
        }),
      },
      hiddenTerminal: {
        ...capabilityCall({
          toolName: "codex__app_server__command_exec",
          route: "/mcp/full",
          surface: "hidden_terminal",
          callId: "call-terminal-1",
          digest: terminalDigest,
        }),
        windowsHide: true,
        shell: false,
        exitCode: 0,
        stdoutSha256: terminalDigest,
      },
      adb: {
        ...capabilityCall({
          toolName: "codex__app_server__command_exec",
          route: "/mcp/full",
          surface: "adb",
          callId: "call-adb-1",
          digest: adbDigest,
        }),
        readOnly: true,
        probe: "devices-l",
        connectedDeviceCount: 1,
        transportStatesSha256: adbDigest,
        connectedDeviceIdentifiersSha256: "a".repeat(64),
      },
      godot: {
        ...capabilityCall({
          toolName: "codex__app_server__command_exec",
          route: "/mcp/full",
          surface: "godot",
          callId: "call-godot-1",
          digest: godotDigest,
        }),
        readOnly: true,
        bounded: true,
        timeoutMs: 30_000,
        exitCode: 0,
        probeSha256: godotDigest,
      },
      localCodexContinuity: {
        threadId,
        appInstanceId,
        route: continuityRoute,
        protectedFilesBeforeSha256: protectedFilesDigest,
        protectedFilesAfterSha256: protectedFilesDigest,
        before: continuityCall({
          phase: "before",
          callId: "call-codex-before-1",
          digest: "b".repeat(64),
          threadId,
          appInstanceId,
          route: continuityRoute,
        }),
        during: continuityCall({
          phase: "during",
          callId: "call-codex-during-1",
          digest: "c".repeat(64),
          threadId,
          appInstanceId,
          route: continuityRoute,
        }),
        after: continuityCall({
          phase: "after",
          callId: "call-codex-after-1",
          digest: "d".repeat(64),
          threadId,
          appInstanceId,
          route: continuityRoute,
        }),
      },
    },
  };
}

function capabilityCall(input: {
  readonly toolName: string;
  readonly route: string;
  readonly surface: string;
  readonly callId: string;
  readonly digest: string;
}): Record<string, unknown> {
  return {
    toolName: input.toolName,
    route: input.route,
    surface: input.surface,
    callId: input.callId,
    outcome: "succeeded",
    authoritativeReadbackSha256: input.digest,
  };
}

function continuityCall(input: {
  readonly phase: "before" | "during" | "after";
  readonly callId: string;
  readonly digest: string;
  readonly threadId: string;
  readonly appInstanceId: string;
  readonly route: string;
}): Record<string, unknown> {
  return {
    ...capabilityCall({
      toolName: "codex_app__read_thread",
      route: input.route,
      surface: "codex_app",
      callId: input.callId,
      digest: input.digest,
    }),
    phase: input.phase,
    threadId: input.threadId,
    appInstanceId: input.appInstanceId,
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected test fixture object");
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected test fixture array");
  return value;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-acceptance-store-"));
  temporaryDirectories.push(directory);
  return directory;
}
