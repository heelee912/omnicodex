import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeCandidate } from "../src/domain/runtime.js";
import {
  DurableCodexAppServerRegistry,
  type OwnedCodexAppServerDaemonIdentity,
  ownedCodexAppServerRegistryDirectory,
  type WindowsProcessIdentityReader,
} from "../src/infrastructure/runtime/owned-codex-app-server-registry.js";
import type {
  OwnedHiddenChildProcess,
  RecoveredWindowsProcessIdentity,
} from "../src/infrastructure/windows/hidden-child-process.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DurableCodexAppServerRegistry", () => {
  it("persists an exact secret-free child identity and removes it only after confirmed close", async () => {
    const dataDirectory = await makeTemporaryDirectory();
    const observed = processIdentity();
    const reader = new SequenceIdentityReader([observed, observed]);
    const registry = new DurableCodexAppServerRegistry({
      dataDirectory,
      daemon,
      processIdentityReader: reader,
      now: () => 2_000,
    });

    const registration = await registry.register({
      child: ownedChild(),
      candidate,
      launchArgs: ["app-server", "--stdio", "-c", "secret_token=must-not-persist"],
    });

    const raw = await readFile(registration.path, "utf8");
    expect(raw).toContain('"kind":"codex_app_server"');
    expect(raw).toContain(`"pid":${observed.pid}`);
    expect(raw).toContain('"commandLineSha256"');
    expect(raw).toContain('"launchShapeSha256"');
    expect(raw).not.toContain("must-not-persist");
    expect(raw).not.toContain(observed.commandLine);
    expect(registration.record.parentPid).toBe(daemon.pid);

    const firstRelease = registration.releaseAfterConfirmedExit();
    const concurrentRelease = registration.releaseAfterConfirmedExit();
    expect(concurrentRelease).toBe(firstRelease);
    await Promise.all([firstRelease, concurrentRelease]);
    await registration.releaseAfterConfirmedExit();
    await expect(access(registration.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when the spawned process is not an exact child of the daemon", async () => {
    const dataDirectory = await makeTemporaryDirectory();
    const reader = new SequenceIdentityReader([
      { ...processIdentity(), parentPid: daemon.pid + 1 },
    ]);
    const registry = new DurableCodexAppServerRegistry({
      dataDirectory,
      daemon,
      processIdentityReader: reader,
    });

    await expect(
      registry.register({ child: ownedChild(), candidate, launchArgs: ["app-server", "--stdio"] }),
    ).rejects.toThrow("unexpected parent");
  });

  it("retries a transient Windows process-observation failure without weakening identity checks", async () => {
    const dataDirectory = await makeTemporaryDirectory();
    const observed = processIdentity();
    const reader = new SequenceIdentityReader([
      new Error("transient CIM timeout"),
      observed,
      observed,
    ]);
    const sleep = vi.fn(async () => undefined);
    const registry = new DurableCodexAppServerRegistry({
      dataDirectory,
      daemon,
      processIdentityReader: reader,
      inspectionAttempts: 3,
      inspectionRetryDelayMs: 25,
      sleep,
    });

    const registration = await registry.register({
      child: ownedChild(),
      candidate,
      launchArgs: ["app-server", "--stdio"],
    });

    expect(registration.record.pid).toBe(observed.pid);
    expect(sleep).toHaveBeenCalledWith(25);
    await registration.releaseAfterConfirmedExit();
  });

  it("waits through a delayed Windows process appearance before exact registration", async () => {
    const dataDirectory = await makeTemporaryDirectory();
    const observed = processIdentity();
    const reader = new SequenceIdentityReader([
      undefined,
      undefined,
      undefined,
      undefined,
      observed,
      observed,
    ]);
    const sleep = vi.fn(async () => undefined);
    const registry = new DurableCodexAppServerRegistry({
      dataDirectory,
      daemon,
      processIdentityReader: reader,
      inspectionRetryDelayMs: 25,
      sleep,
    });

    const registration = await registry.register({
      child: ownedChild(),
      candidate,
      launchArgs: ["app-server", "--stdio"],
    });

    expect(registration.record.pid).toBe(observed.pid);
    expect(sleep.mock.calls).toEqual([[25], [50], [75], [100]]);
    await registration.releaseAfterConfirmedExit();
  });
  it("fences a PID reuse that occurs while the record is committed", async () => {
    const dataDirectory = await makeTemporaryDirectory();
    const observed = processIdentity();
    const reader = new SequenceIdentityReader([
      observed,
      { ...observed, startedAtIso: "2026-08-27T00:00:01.0000000Z" },
    ]);
    const registry = new DurableCodexAppServerRegistry({
      dataDirectory,
      daemon,
      processIdentityReader: reader,
    });

    await expect(
      registry.register({ child: ownedChild(), candidate, launchArgs: ["app-server", "--stdio"] }),
    ).rejects.toThrow("identity changed during registration");
    const directory = ownedCodexAppServerRegistryDirectory(dataDirectory, daemon);
    await expect(
      access(join(directory, `${observed.pid}-child-nonce-1234567890.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

class SequenceIdentityReader implements WindowsProcessIdentityReader {
  readonly #values: Array<RecoveredWindowsProcessIdentity | Error | undefined>;

  constructor(values: Array<RecoveredWindowsProcessIdentity | Error | undefined>) {
    this.#values = values;
  }

  async inspectWindowsProcess(): Promise<RecoveredWindowsProcessIdentity | undefined> {
    const value = this.#values.shift();
    if (value instanceof Error) throw value;
    return value;
  }
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
    commandLine:
      '"C:\\Program Files\\Codex\\codex.exe" app-server --stdio -c secret_token=must-not-persist',
    startedAtIso: "2026-08-27T00:00:00.0000000Z",
  };
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-owned-app-server-"));
  temporaryDirectories.push(directory);
  return directory;
}
