import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assessUnreachableDaemonState,
  probeProcessStatus,
  quarantineStaleDaemonState,
  retireStoppedDaemonState,
  withDaemonLifecycleLock,
} from "../src/application/daemon-state-recovery.js";
import {
  type OmniCodexDaemonState,
  writeOmniCodexDaemonState,
} from "../src/infrastructure/config/omnicodex-config-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("daemon state recovery", () => {
  it("classifies an unreachable daemon from the previous boot as definitely stale", () => {
    expect(
      assessUnreachableDaemonState(daemonState({ startedAtUnixMs: 1_000 }), {
        nowUnixMs: 1_000_000,
        uptimeSeconds: 100,
        processStatus: "alive",
      }),
    ).toEqual({ status: "definitely_stale", reason: "previous_boot" });
  });

  it("classifies a proven-absent current-boot PID as stale but keeps live/unknown PIDs closed", () => {
    const state = daemonState({ startedAtUnixMs: 950_000 });
    const clock = { nowUnixMs: 1_000_000, uptimeSeconds: 100 } as const;
    expect(assessUnreachableDaemonState(state, { ...clock, processStatus: "absent" })).toEqual({
      status: "definitely_stale",
      reason: "process_absent",
    });
    expect(assessUnreachableDaemonState(state, { ...clock, processStatus: "alive" })).toEqual({
      status: "unverifiable",
      reason: "process_alive",
    });
    expect(assessUnreachableDaemonState(state, { ...clock, processStatus: "unknown" })).toEqual({
      status: "unverifiable",
      reason: "process_unknown",
    });
  });

  it("probes PID existence without sending a mutating signal", () => {
    const observed: Array<{ pid: number; signal: number }> = [];
    expect(
      probeProcessStatus(4242, (pid, signal) => {
        observed.push({ pid, signal });
        return true;
      }),
    ).toBe("alive");
    expect(observed).toEqual([{ pid: 4242, signal: 0 }]);

    expect(
      probeProcessStatus(4243, () => {
        throw Object.assign(new Error("missing"), { code: "ESRCH" });
      }),
    ).toBe("absent");
    expect(
      probeProcessStatus(4244, () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      }),
    ).toBe("unknown");
  });

  it("quarantines only the exact stale daemon identity", async () => {
    const directory = await makeTemporaryDirectory();
    const statePath = join(directory, "state.json");
    const stale = daemonState({ startedAtUnixMs: 1_000 });
    await writeOmniCodexDaemonState(stale, statePath);

    const result = await quarantineStaleDaemonState(stale, {
      path: statePath,
      probe: { nowUnixMs: 1_000_000, uptimeSeconds: 100, processStatus: "alive" },
    });
    expect(result.quarantined).toBe(true);
    expect(result.assessment).toEqual({ status: "definitely_stale", reason: "previous_boot" });
    expect(await readFile(result.quarantinePath as string, "utf8")).toContain(stale.instanceNonce);

    const replacement = daemonState({ instanceNonce: "r".repeat(43) });
    await writeOmniCodexDaemonState(replacement, statePath);
    const mismatched = await quarantineStaleDaemonState(stale, {
      path: statePath,
      probe: { nowUnixMs: 1_000_000, uptimeSeconds: 100, processStatus: "absent" },
    });
    expect(mismatched).toMatchObject({ quarantined: false, stateChanged: true });
    expect(await readFile(statePath, "utf8")).toContain(replacement.instanceNonce);
  });

  it("retires only the exact graceful-stop state", async () => {
    const directory = await makeTemporaryDirectory();
    const statePath = join(directory, "state.json");
    const stopping = daemonState({ lifecycle: "stopping" });
    await writeOmniCodexDaemonState(stopping, statePath);

    const result = await retireStoppedDaemonState(stopping, { path: statePath });
    expect(result.retired).toBe(true);
    expect(await readFile(result.retirementPath as string, "utf8")).toContain(
      stopping.instanceNonce,
    );

    await writeOmniCodexDaemonState(stopping, statePath);
    const wrong = daemonState({ lifecycle: "stopping", instanceNonce: "x".repeat(43) });
    await expect(retireStoppedDaemonState(wrong, { path: statePath })).resolves.toMatchObject({
      retired: false,
      stateChanged: true,
    });
    await writeOmniCodexDaemonState(daemonState(), statePath);
    await expect(retireStoppedDaemonState(daemonState(), { path: statePath })).resolves.toEqual({
      retired: false,
    });
  });

  it("serializes lifecycle mutation and recovers a previous-boot lock", async () => {
    const directory = await makeTemporaryDirectory();
    const statePath = join(directory, "state.json");
    const lockPath = `${statePath}.lifecycle.lock`;
    await writeFile(
      lockPath,
      `${JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce: "old", createdAtUnixMs: 1 })}\n`,
      "utf8",
    );

    await expect(withDaemonLifecycleLock(async () => "recovered", { statePath })).resolves.toBe(
      "recovered",
    );
    expect((await readdir(directory)).some((name) => name.includes("lifecycle.lock.stale"))).toBe(
      true,
    );

    let release: (() => void) | undefined;
    const held = withDaemonLifecycleLock(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      { statePath },
    );
    await waitUntil(() => release !== undefined);
    await expect(
      withDaemonLifecycleLock(async () => undefined, { statePath, retryCount: 0 }),
    ).rejects.toThrow("already in progress");
    release?.();
    await held;
  });

  it("waits without stealing a valid live lifecycle lock and enters after release", async () => {
    const directory = await makeTemporaryDirectory();
    const statePath = join(directory, "state.json");
    let release: (() => void) | undefined;
    const held = withDaemonLifecycleLock(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      { statePath },
    );
    await waitUntil(() => release !== undefined);

    let entered = false;
    const waiting = withDaemonLifecycleLock(
      async () => {
        entered = true;
        return "acquired";
      },
      { statePath, retryCount: 0, waitOnContention: true },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 75));
    expect(entered).toBe(false);

    release?.();
    await held;
    await expect(waiting).resolves.toBe("acquired");
    expect(entered).toBe(true);
  });

  it("recovers a same-boot lifecycle lock only when its owner process is absent", async () => {
    const directory = await makeTemporaryDirectory();
    const statePath = join(directory, "state.json");
    const lockPath = `${statePath}.lifecycle.lock`;
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 4242,
        nonce: "terminated-owner",
        createdAtUnixMs: Date.now(),
      })}\n`,
      "utf8",
    );

    await expect(
      withDaemonLifecycleLock(async () => "recovered", {
        statePath,
        ownerProcessStatus: "absent",
      }),
    ).resolves.toBe("recovered");
    expect((await readdir(directory)).some((name) => name.includes("lifecycle.lock.stale"))).toBe(
      true,
    );
  });

  it("recovers a same-boot lifecycle lock after its PID was reused", async () => {
    const directory = await makeTemporaryDirectory();
    const statePath = join(directory, "state.json");
    const lockPath = `${statePath}.lifecycle.lock`;
    const createdAtUnixMs = Date.now() - 60_000;
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 4242,
        nonce: "terminated-owner-with-reused-pid",
        createdAtUnixMs,
      })}\n`,
      "utf8",
    );

    await expect(
      withDaemonLifecycleLock(async () => "recovered", {
        statePath,
        ownerProcessStatus: "alive",
        probeOwnerProcessStartedAtUnixMs: async () => createdAtUnixMs + 30_000,
      }),
    ).resolves.toBe("recovered");
    expect((await readdir(directory)).some((name) => name.includes("lifecycle.lock.stale"))).toBe(
      true,
    );
  });

  it("does not wait forever or steal an invalid lifecycle lock record", async () => {
    const directory = await makeTemporaryDirectory();
    const statePath = join(directory, "state.json");
    await writeFile(`${statePath}.lifecycle.lock`, "not-json\n", "utf8");

    await expect(
      withDaemonLifecycleLock(async () => undefined, {
        statePath,
        waitOnContention: true,
      }),
    ).rejects.toThrow("already in progress");
  });

  it.each(["alive", "unknown"] as const)(
    "does not steal an expired lifecycle lock from an %s owner",
    async (ownerProcessStatus) => {
      const directory = await makeTemporaryDirectory();
      const statePath = join(directory, "state.json");
      const lockPath = `${statePath}.lifecycle.lock`;
      await writeFile(
        lockPath,
        `${JSON.stringify({
          schemaVersion: 1,
          pid: 4242,
          nonce: "reused-pid",
          createdAtUnixMs: Date.now() - 6 * 60 * 1_000,
        })}\n`,
        "utf8",
      );

      await expect(
        withDaemonLifecycleLock(async () => "recovered", {
          statePath,
          ownerProcessStatus,
          probeOwnerProcessStartedAtUnixMs: async () => undefined,
          retryCount: 0,
        }),
      ).rejects.toThrow("already in progress");
      expect((await readdir(directory)).some((name) => name.includes("lifecycle.lock.stale"))).toBe(
        false,
      );
    },
  );
});

function daemonState(overrides: Partial<OmniCodexDaemonState> = {}): OmniCodexDaemonState {
  return {
    schemaVersion: 1,
    lifecycle: "ready",
    pid: 4242,
    instanceNonce: "n".repeat(43),
    startedAtUnixMs: 950_000,
    updatedAtUnixMs: 960_000,
    controlPipe: "test-pipe",
    controlToken: "t".repeat(43),
    ...overrides,
  };
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-daemon-state-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached");
}
