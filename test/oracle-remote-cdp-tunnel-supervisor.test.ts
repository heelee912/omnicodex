import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { HiddenChildProcessBoundary } from "../src/infrastructure/windows/hidden-child-process.js";
import { OracleRemoteCdpTunnelSupervisor } from "../src/infrastructure/windows/oracle-remote-cdp-tunnel-supervisor.js";

describe("OracleRemoteCdpTunnelSupervisor", () => {
  it("starts only a hidden SSH forward and never launches a local browser", async () => {
    const child = new FakeChild(7421);
    const spawns: Array<{ executable: string; args: readonly string[]; options: unknown }> = [];
    const boundary = new HiddenChildProcessBoundary((executable, args, options) => {
      spawns.push({ executable, args, options });
      return child as never;
    });
    let probes = 0;
    const supervisor = new OracleRemoteCdpTunnelSupervisor({
      cdpEndpoint: "http://127.0.0.1:19222",
      remote: {
        sshHost: "203.0.113.10",
        sshPort: 22,
        sshUser: "ubuntu",
        identityFile: "C:\\Users\\ExampleUser\\.ssh\\oracle.pem",
        remoteCdpPort: 19222,
      },
      environment: { SystemRoot: "C:\\Windows" },
      pathExists: () => true,
      childProcesses: boundary,
      startupTimeoutMs: 1_000,
      probeIntervalMs: 1,
      delay: async () => undefined,
      probe: async () => ++probes >= 2,
    });

    await expect(supervisor.start()).resolves.toMatchObject({
      ownership: "owned",
      cdpEndpoint: "http://127.0.0.1:19222",
      sshHost: "203.0.113.10",
      remoteCdpPort: 19222,
      pid: 7421,
    });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.executable).toBe("C:\\Windows\\System32\\OpenSSH\\ssh.exe");
    expect(spawns[0]?.args).toContain("127.0.0.1:19222:127.0.0.1:19222");
    expect(spawns[0]?.args).toContain("ubuntu@203.0.113.10");
    expect(spawns[0]?.args).toContain("ConnectTimeout=15");
    expect(spawns[0]?.args).toContain("ConnectionAttempts=1");
    expect(spawns[0]?.args).not.toContain("-p");
    expect(spawns[0]?.args.join(" ").toLowerCase()).not.toContain("chrome");
    expect(spawns[0]?.options).toMatchObject({
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });

    await supervisor.stop();
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("preserves an explicitly configured non-default SSH port", async () => {
    const child = new FakeChild(7424);
    const spawns: Array<{ args: readonly string[] }> = [];
    const boundary = new HiddenChildProcessBoundary((_executable, args) => {
      spawns.push({ args });
      return child as never;
    });
    let probes = 0;
    const supervisor = new OracleRemoteCdpTunnelSupervisor({
      cdpEndpoint: "http://127.0.0.1:19222",
      remote: {
        sshHost: "oracle.example",
        sshPort: 2222,
        sshUser: "ubuntu",
        identityFile: "C:\\id.pem",
        remoteCdpPort: 19222,
      },
      environment: { SystemRoot: "C:\\Windows" },
      pathExists: () => true,
      childProcesses: boundary,
      probeIntervalMs: 1,
      delay: async () => undefined,
      probe: async () => ++probes >= 2,
    });

    await supervisor.start();
    const portIndex = spawns[0]?.args.indexOf("-p") ?? -1;
    expect(portIndex).toBeGreaterThanOrEqual(0);
    expect(spawns[0]?.args[portIndex + 1]).toBe("2222");
    await supervisor.stop();
  });

  it("distinguishes a live SSH forward from an unavailable remote CDP", async () => {
    const child = new FakeChild(7422);
    const boundary = new HiddenChildProcessBoundary(() => child as never);
    const supervisor = new OracleRemoteCdpTunnelSupervisor({
      cdpEndpoint: "http://127.0.0.1:19222",
      remote: {
        sshHost: "oracle.example",
        sshPort: 22,
        sshUser: "ubuntu",
        identityFile: "C:\\id.pem",
        remoteCdpPort: 19222,
      },
      environment: { SystemRoot: "C:\\Windows" },
      pathExists: () => true,
      childProcesses: boundary,
      startupTimeoutMs: 1,
      probeIntervalMs: 1,
      delay: async () => undefined,
      probe: async () => false,
      probeForward: async () => true,
    });

    await expect(supervisor.start()).rejects.toThrow(
      "ORACLE_REMOTE_CDP_UNAVAILABLE: SSH forward is listening",
    );
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("reports the SSH boundary when no local forward becomes reachable", async () => {
    const child = new FakeChild(7423);
    const boundary = new HiddenChildProcessBoundary(() => child as never);
    const supervisor = new OracleRemoteCdpTunnelSupervisor({
      cdpEndpoint: "http://127.0.0.1:19222",
      remote: {
        sshHost: "oracle.example",
        sshPort: 22,
        sshUser: "ubuntu",
        identityFile: "C:\\id.pem",
        remoteCdpPort: 19222,
      },
      environment: { SystemRoot: "C:\\Windows" },
      pathExists: () => true,
      childProcesses: boundary,
      startupTimeoutMs: 1,
      probeIntervalMs: 1,
      delay: async () => undefined,
      probe: async () => false,
      probeForward: async () => false,
    });

    await expect(supervisor.start()).rejects.toThrow(
      "ORACLE_REMOTE_CDP_SSH_UNAVAILABLE: SSH forward did not become reachable",
    );
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("reuses a healthy forward without spawning a process", async () => {
    const spawns: unknown[] = [];
    const boundary = new HiddenChildProcessBoundary((...args) => {
      spawns.push(args);
      throw new Error("must not spawn");
    });
    const supervisor = new OracleRemoteCdpTunnelSupervisor({
      cdpEndpoint: "http://127.0.0.1:19222",
      remote: {
        sshHost: "oracle.example",
        sshPort: 22,
        sshUser: "ubuntu",
        identityFile: "C:\\id.pem",
        remoteCdpPort: 19222,
      },
      environment: { SystemRoot: "C:\\Windows" },
      pathExists: () => true,
      childProcesses: boundary,
      probe: async () => true,
    });

    await expect(supervisor.start()).resolves.toMatchObject({ ownership: "external" });
    expect(spawns).toHaveLength(0);
  });
});

class FakeChild extends EventEmitter {
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: Array<NodeJS.Signals | number> = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }
}
