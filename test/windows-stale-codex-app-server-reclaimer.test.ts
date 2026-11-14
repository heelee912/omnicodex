import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeCandidate } from "../src/domain/runtime.js";
import type { OmniCodexDaemonState } from "../src/infrastructure/config/omnicodex-config-store.js";
import {
  DurableCodexAppServerRegistry,
  type OwnedCodexAppServerDaemonIdentity,
  type WindowsProcessIdentityReader,
} from "../src/infrastructure/runtime/owned-codex-app-server-registry.js";
import type {
  OwnedHiddenChildProcess,
  RecoveredWindowsProcessIdentity,
} from "../src/infrastructure/windows/hidden-child-process.js";
import {
  type RecoveredWindowsProcessBoundary,
  WindowsStaleCodexAppServerReclaimer,
} from "../src/infrastructure/windows/windows-stale-codex-app-server-reclaimer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("WindowsStaleCodexAppServerReclaimer", () => {
  it("waits for EOF then terminates only an unchanged registered survivor", async () => {
    const fixture = await createRecord();
    const boundary = new SequenceBoundary([fixture.observed, fixture.observed, undefined]);
    const result = await new WindowsStaleCodexAppServerReclaimer({
      dataDirectory: fixture.dataDirectory,
      boundary,
      naturalExitWaitMs: 0,
    }).reclaim(daemonState());

    expect(result).toEqual({
      status: "reclaimed",
      observedCount: 1,
      naturallyExitedCount: 0,
      terminatedCount: 1,
    });
    expect(boundary.terminated).toEqual([fixture.observed]);
    await expect(access(fixture.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a registry record only after the process is confirmed absent", async () => {
    const fixture = await createRecord();
    const boundary = new SequenceBoundary([undefined]);
    const result = await new WindowsStaleCodexAppServerReclaimer({
      dataDirectory: fixture.dataDirectory,
      boundary,
      naturalExitWaitMs: 0,
    }).reclaim(daemonState());

    expect(result).toEqual({
      status: "absent",
      observedCount: 1,
      naturallyExitedCount: 1,
      terminatedCount: 0,
    });
    expect(boundary.terminated).toHaveLength(0);
    expect(boundary.expectedNames).toEqual(["codex.exe"]);
    await expect(access(fixture.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on PID reuse and preserves the evidence record", async () => {
    const fixture = await createRecord();
    const boundary = new SequenceBoundary([
      { ...fixture.observed, commandLine: `${fixture.observed.commandLine} --reused` },
    ]);
    await expect(
      new WindowsStaleCodexAppServerReclaimer({
        dataDirectory: fixture.dataDirectory,
        boundary,
        naturalExitWaitMs: 0,
      }).reclaim(daemonState()),
    ).rejects.toThrow("IDENTITY_CHANGED");
    expect(boundary.terminated).toHaveLength(0);
    await expect(access(fixture.path)).resolves.toBeUndefined();
  });
});

class SequenceBoundary implements RecoveredWindowsProcessBoundary {
  readonly #values: Array<RecoveredWindowsProcessIdentity | undefined>;
  readonly terminated: RecoveredWindowsProcessIdentity[] = [];
  readonly expectedNames: string[] = [];

  constructor(values: Array<RecoveredWindowsProcessIdentity | undefined>) {
    this.#values = values;
  }

  async inspectWindowsProcess(
    _pid: number,
    options?: { readonly expectedProcessName?: string },
  ): Promise<RecoveredWindowsProcessIdentity | undefined> {
    this.expectedNames.push(options?.expectedProcessName ?? "");
    return this.#values.shift();
  }

  async terminateExactRecoveredWindowsProcess(
    expected: RecoveredWindowsProcessIdentity,
  ): Promise<"terminated"> {
    this.terminated.push(expected);
    return "terminated";
  }
}

class ConstantIdentityReader implements WindowsProcessIdentityReader {
  readonly #identity: RecoveredWindowsProcessIdentity;

  constructor(identity: RecoveredWindowsProcessIdentity) {
    this.#identity = identity;
  }

  async inspectWindowsProcess(): Promise<RecoveredWindowsProcessIdentity> {
    return this.#identity;
  }
}

async function createRecord(): Promise<{
  readonly dataDirectory: string;
  readonly path: string;
  readonly observed: RecoveredWindowsProcessIdentity;
}> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-reclaim-app-server-"));
  temporaryDirectories.push(dataDirectory);
  const observed = processIdentity();
  const registry = new DurableCodexAppServerRegistry({
    dataDirectory,
    daemon,
    processIdentityReader: new ConstantIdentityReader(observed),
  });
  const registration = await registry.register({
    child: ownedChild(),
    candidate,
    launchArgs: ["app-server", "--stdio"],
  });
  return { dataDirectory, path: registration.path, observed };
}

const daemon: OwnedCodexAppServerDaemonIdentity = {
  pid: 4242,
  instanceNonce: "daemon-instance-nonce-1234567890",
  startedAtUnixMs: 1_000,
};

const candidate: RuntimeCandidate = {
  executablePath: "C:\\Program Files\\Codex\\codex.exe",
  canonicalPath: "C:\\Program Files\\Codex\\codex.exe",
  source: "managed_install",
  buildSha256: "a".repeat(64),
};

function daemonState(): OmniCodexDaemonState {
  return {
    schemaVersion: 1,
    lifecycle: "ready",
    pid: daemon.pid,
    instanceNonce: daemon.instanceNonce,
    startedAtUnixMs: daemon.startedAtUnixMs,
    updatedAtUnixMs: 2_000,
    controlPipe: "test-pipe",
    controlToken: "t".repeat(43),
  };
}

function ownedChild(): OwnedHiddenChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: 5151 as number | undefined,
    ownership: Object.freeze({
      pid: 5151,
      nonce: "child-nonce-1234567890",
      executable: candidate.executablePath,
      spawnedAtUnixMs: 1_500,
    }),
  }) as unknown as OwnedHiddenChildProcess;
}

function processIdentity(): RecoveredWindowsProcessIdentity {
  return {
    pid: 5151,
    parentPid: daemon.pid,
    name: "codex.exe",
    executablePath: candidate.executablePath,
    commandLine: '"C:\\Program Files\\Codex\\codex.exe" app-server --stdio',
    startedAtIso: "2026-08-27T00:00:00.0000000Z",
  };
}
