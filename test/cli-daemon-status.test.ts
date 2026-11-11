import { describe, expect, it, vi } from "vitest";
import { daemonStatusMessage, observeDaemonStatus } from "../src/cli.js";
import type { OmniCodexDaemonState } from "../src/infrastructure/config/omnicodex-config-store.js";

function daemonState(overrides: Partial<OmniCodexDaemonState> = {}): OmniCodexDaemonState {
  return {
    schemaVersion: 1,
    lifecycle: "ready",
    pid: 1234,
    instanceNonce: "status-test",
    startedAtUnixMs: Date.now(),
    updatedAtUnixMs: Date.now(),
    controlPipe: "test-only-pipe",
    controlToken: "test-only-token",
    ...overrides,
  };
}

describe("daemon status reporting", () => {
  it.each(["control request timed out", "control ownership mismatch", "connect EACCES"])(
    "does not report an existing process as stopped when %s",
    async (message) => {
      const observation = await observeDaemonStatus(daemonState(), {
        probeProcess: () => "alive",
        readControl: vi.fn().mockRejectedValue(new Error(message)),
      });

      expect(observation).toEqual({
        running: null,
        processStatus: "alive",
        controlStatus: "unreachable",
        lifecycle: "unresponsive",
        stale: false,
        reason: "process_alive",
        controlError: message,
      });
      expect(daemonStatusMessage(observation, 1234)).toContain("process 1234 exists");
      expect(daemonStatusMessage(observation, 1234)).toContain(message);
      expect(daemonStatusMessage(observation, 1234)).not.toContain("stopped");
    },
  );

  it("retains uncertainty when the process probe itself cannot verify existence", async () => {
    const observation = await observeDaemonStatus(daemonState(), {
      probeProcess: () => "unknown",
      readControl: vi.fn().mockRejectedValue(new Error("control request timed out")),
    });
    expect(observation).toMatchObject({
      running: null,
      processStatus: "unknown",
      lifecycle: "unknown",
      stale: false,
      reason: "process_unknown",
    });
    expect(daemonStatusMessage(observation, 1234)).toContain("could not be verified");
  });

  it("reports a proven-absent process as stopped without opening its stale control pipe", async () => {
    const readControl = vi.fn();
    const observation = await observeDaemonStatus(daemonState(), {
      probeProcess: () => "absent",
      readControl,
    });
    expect(observation).toMatchObject({
      running: false,
      controlStatus: "not_checked",
      lifecycle: "stopped",
      stale: true,
      reason: "process_absent",
    });
    expect(readControl).not.toHaveBeenCalled();
  });

  it("reports missing state as stopped without probing a process", async () => {
    const probeProcess = vi.fn();
    const readControl = vi.fn();
    const observation = await observeDaemonStatus(undefined, { probeProcess, readControl });
    expect(observation).toMatchObject({ running: false, reason: "no_state", stale: false });
    expect(daemonStatusMessage(observation)).toBe("OmniCodex is stopped.");
    expect(probeProcess).not.toHaveBeenCalled();
    expect(readControl).not.toHaveBeenCalled();
  });

  it("uses the authenticated control response lifecycle rather than the recorded state", async () => {
    const observation = await observeDaemonStatus(daemonState(), {
      probeProcess: () => "unknown",
      readControl: async () => ({ lifecycle: "stopping" }),
    });
    expect(observation).toMatchObject({
      running: true,
      controlStatus: "reachable",
      lifecycle: "stopping",
      stale: false,
    });
    expect(daemonStatusMessage(observation, 1234)).toBe("OmniCodex stopping (pid 1234)");
  });

  it("does not mistake a reused PID from a previous boot for the recorded daemon", async () => {
    const observation = await observeDaemonStatus(daemonState({ startedAtUnixMs: 1 }), {
      probeProcess: () => "alive",
      readControl: vi.fn().mockRejectedValue(new Error("control ownership mismatch")),
    });
    expect(observation).toMatchObject({
      running: false,
      lifecycle: "stopped",
      stale: true,
      reason: "previous_boot",
    });
  });
});
