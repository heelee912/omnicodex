import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HashChainedActionLedger } from "../src/infrastructure/safety/hash-chained-action-ledger.js";
import {
  WindowsCodexBoundaryGuard,
  type WindowsCodexInspection,
} from "../src/infrastructure/safety/windows-codex-boundary-guard.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("WindowsCodexBoundaryGuard", () => {
  it("accepts an unchanged authenticated Codex boundary", async () => {
    const fixture = await makeFixture();
    const guard = fixture.guard();
    const baseline = await guard.capture();

    expect(baseline.observation.loginContinuity).toBe("authenticated");
    expect(baseline.observation.appUsability).toBe("usable");
    await expect(guard.assertUnchanged(baseline)).resolves.toMatchObject({
      observation: { loginContinuity: "authenticated", appUsability: "usable" },
    });
  });

  it("allows normal Codex settings updates while login continuity is preserved", async () => {
    const fixture = await makeFixture();
    const guard = fixture.guard();
    const baseline = await guard.capture();
    await writeFile(fixture.configPath, "model = 'changed'\n", "utf8");

    await expect(guard.assertUnchanged(baseline)).resolves.toMatchObject({
      observation: { loginContinuity: "authenticated" },
    });
  });

  it("allows normal Codex process replacement while the app remains usable", async () => {
    const fixture = await makeFixture();
    const guard = fixture.guard();
    const baseline = await guard.capture();
    fixture.inspection = {
      ...fixture.inspection,
      desktopProcesses: [
        {
          pid: 78,
          startedAtUnixMs: 2,
          executableFingerprint: "desktop-fingerprint-next",
          packageIdentity: "OpenAI.Codex_test",
        },
      ],
    };

    await expect(guard.assertUnchanged(baseline)).resolves.toMatchObject({
      observation: { appUsability: "usable" },
    });
  });

  it("fails closed when the Codex app disappears", async () => {
    const fixture = await makeFixture();
    const guard = fixture.guard();
    const baseline = await guard.capture();
    fixture.inspection = {
      ...fixture.inspection,
      desktopProcesses: [],
      appUsability: "unknown",
    };

    await expect(guard.assertUnchanged(baseline)).rejects.toThrow("CODEX_BOUNDARY_CHANGED");
  });

  it("records protected reads and rejects any recorded Codex desktop control", async () => {
    const fixture = await makeFixture();
    const ledger = new HashChainedActionLedger(join(fixture.root, "actions.jsonl"));
    const guard = fixture.guard(ledger);
    const baseline = await guard.capture();
    expect(baseline.actionLedger?.headSequence).toBe(6);
    await guard.assertUnchanged(baseline);
    expect((await ledger.readHead()).headSequence).toBe(12);

    const forbidden = await ledger.begin({
      kind: "child_process",
      effect: "start",
      targetClass: "codex_desktop",
      targetFingerprint: "e".repeat(64),
    });
    await forbidden.complete({ outcomeCode: "SPAWNED" });
    await expect(guard.capture()).rejects.toThrow("CODEX_ACTION_LEDGER_BLOCKED");
  });
});

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "omnicodex-boundary-"));
  temporaryDirectories.push(root);
  const authPath = join(root, "auth.json");
  const configPath = join(root, "config.toml");
  await Promise.all([
    writeFile(
      authPath,
      `${JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { refresh_token: "r".repeat(32), account_id: "account" },
      })}\n`,
      "utf8",
    ),
    writeFile(configPath, "model = 'gpt-5.6-sol'\n", "utf8"),
  ]);
  const fixture: {
    readonly root: string;
    readonly authPath: string;
    readonly configPath: string;
    inspection: WindowsCodexInspection;
    guard(actionLedger?: HashChainedActionLedger): WindowsCodexBoundaryGuard;
  } = {
    root,
    authPath,
    configPath,
    inspection: {
      desktopProcesses: [
        {
          pid: 77,
          startedAtUnixMs: 1,
          executableFingerprint: "desktop-fingerprint",
          packageIdentity: "OpenAI.Codex_test",
        },
      ],
      installedPackage: {
        packageFamilyName: "OpenAI.Codex_test",
        fullName: "OpenAI.Codex_1.0.0.0_x64__test",
        version: "1.0.0.0",
        installLocationFingerprint: "package-fingerprint",
      },
      appUsability: "usable",
    },
    guard(actionLedger) {
      return new WindowsCodexBoundaryGuard({
        protectedTargets: [
          { logicalName: "codex-auth", path: authPath },
          { logicalName: "codex-config", path: configPath },
        ],
        inspectWindows: async () => fixture.inspection,
        ...(actionLedger === undefined ? {} : { actionLedger }),
      });
    },
  };
  return fixture;
}
