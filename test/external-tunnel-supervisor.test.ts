import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ExternalTunnelSupervisor } from "../src/infrastructure/tunnel/external-tunnel-supervisor.js";
import { HiddenChildProcessBoundary } from "../src/infrastructure/windows/hidden-child-process.js";

describe("ExternalTunnelSupervisor", () => {
  it.each([
    ["cloudflare", ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:48765"]],
    ["tailscale", ["funnel", "--bg=false", "--yes", "--https", "443", "http://127.0.0.1:48765"]],
  ] as const)(
    "launches %s with exact secret-free hidden argv and owned stop",
    async (kind, expectedArgs) => {
      const child = new FakeChild();
      let spawn: { args: readonly string[]; options: Record<string, unknown> } | undefined;
      const boundary = new HiddenChildProcessBoundary((_executable, args, options) => {
        spawn = { args, options: options as Record<string, unknown> };
        return child as never;
      });
      const supervisor = new ExternalTunnelSupervisor({
        kind,
        executablePath: `${kind}.exe`,
        publicUrl: "https://owner.example",
        childProcesses: boundary,
        probe: async (url) => url.pathname.endsWith("/mcp"),
      });
      await expect(
        supervisor.start({ host: "127.0.0.1", port: 48765, path: "/mcp", fullPath: "/mcp/full" }),
      ).resolves.toMatchObject({ kind, pid: 4242 });
      expect(spawn?.args).toEqual(expectedArgs);
      expect(spawn?.options).toMatchObject({ shell: false, windowsHide: true });
      expect(JSON.stringify(spawn)).not.toMatch(/token|secret|credential/i);
      await supervisor.stop();
      expect(child.killed).toBe(true);
    },
  );

  it("binds Tailscale to the exact configured HTTPS port instead of overwriting port 443", async () => {
    const child = new FakeChild();
    let args: readonly string[] = [];
    const boundary = new HiddenChildProcessBoundary((_executable, childArgs) => {
      args = childArgs;
      return child as never;
    });
    const supervisor = new ExternalTunnelSupervisor({
      kind: "tailscale",
      executablePath: "tailscale.exe",
      publicUrl: "https://pc.example.ts.net:8443",
      childProcesses: boundary,
      probe: async () => true,
    });

    await supervisor.start({
      host: "127.0.0.1",
      port: 48765,
      path: "/mcp",
      fullPath: "/mcp/full",
    });

    expect(args).toEqual([
      "funnel",
      "--bg=false",
      "--yes",
      "--https",
      "8443",
      "http://127.0.0.1:48765",
    ]);
    await supervisor.stop();
  });

  it("owns a secret-free reverse SSH backhaul with exact loopback-only forwarding", async () => {
    const child = new FakeChild();
    let spawn: { args: readonly string[]; options: Record<string, unknown> } | undefined;
    const boundary = new HiddenChildProcessBoundary((_executable, args, options) => {
      spawn = { args, options: options as Record<string, unknown> };
      return child as never;
    });
    const supervisor = new ExternalTunnelSupervisor({
      kind: "oracle_ssh",
      executablePath: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
      publicUrl: "https://203.0.113.10",
      sshHost: "203.0.113.10",
      sshPort: 22,
      sshUser: "omnicodex-backhaul",
      identityFile: "C:\\owner\\oracle-backhaul-ed25519",
      remotePort: 18766,
      childProcesses: boundary,
      probe: async () => true,
    });

    await supervisor.start({
      host: "127.0.0.1",
      port: 7113,
      path: "/mcp",
      fullPath: "/mcp/full",
    });

    expect(spawn?.args).toEqual([
      "-N",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "StrictHostKeyChecking=yes",
      "-p",
      "22",
      "-i",
      "C:\\owner\\oracle-backhaul-ed25519",
      "-R",
      "127.0.0.1:18766:127.0.0.1:7113",
      "omnicodex-backhaul@203.0.113.10",
    ]);
    expect(spawn?.options).toMatchObject({ shell: false, windowsHide: true });
    await supervisor.stop();
  });

  it("keeps recovering an Oracle backhaul after initial startup is temporarily unavailable", async () => {
    const first = new FakeChild(4201);
    const recovered = new FakeChild(4202);
    const children = [first, recovered];
    let clock = 0;
    let probes = 0;
    const boundary = new HiddenChildProcessBoundary(() => {
      const child = children.shift();
      if (child === undefined) throw new Error("unexpected extra tunnel spawn");
      return child as never;
    });
    const supervisor = new ExternalTunnelSupervisor({
      kind: "oracle_ssh",
      executablePath: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
      publicUrl: "https://203.0.113.10",
      sshHost: "203.0.113.10",
      sshPort: 22,
      sshUser: "omnicodex-backhaul",
      identityFile: "C:\\owner\\oracle-backhaul-ed25519",
      remotePort: 18766,
      childProcesses: boundary,
      startupTimeoutMs: 1,
      probeIntervalMs: 1,
      reconnectPolicy: { maximumRestarts: 0, delayMs: 1 },
      now: () => clock,
      delay: async (milliseconds) => {
        clock += milliseconds;
      },
      probe: async () => {
        probes += 1;
        return probes > 1;
      },
    });
    const address = {
      host: "127.0.0.1" as const,
      port: 7113,
      path: "/mcp",
      fullPath: "/mcp/full",
    };

    await expect(supervisor.start(address)).rejects.toThrow("readiness timed out");
    await eventually(() => supervisor.status?.pid === 4202);
    expect(first.signals).toEqual(["SIGTERM"]);
    expect(supervisor.status).toMatchObject({ kind: "oracle_ssh", pid: 4202 });
    await supervisor.stop();
  });

  it("uses a bounded readiness timeout and stops only its owned handle", async () => {
    const child = new FakeChild();
    const boundary = new HiddenChildProcessBoundary(() => child as never);
    let clock = 0;
    const supervisor = new ExternalTunnelSupervisor({
      kind: "cloudflare",
      executablePath: "cloudflared.exe",
      publicUrl: "https://owner.example",
      childProcesses: boundary,
      probe: async () => false,
      startupTimeoutMs: 2,
      now: () => clock,
      delay: async () => {
        clock += 1;
      },
      probeIntervalMs: 1,
    });
    await expect(
      supervisor.start({ host: "127.0.0.1", port: 1, path: "/mcp", fullPath: "/mcp/full" }),
    ).rejects.toThrow("readiness timed out");
    expect(child.killed).toBe(true);
  });

  it("coalesces concurrent starts for the same target", async () => {
    const child = new FakeChild();
    let spawns = 0;
    const boundary = new HiddenChildProcessBoundary(() => {
      spawns += 1;
      return child as never;
    });
    const supervisor = new ExternalTunnelSupervisor({
      kind: "cloudflare",
      executablePath: "cloudflared.exe",
      publicUrl: "https://owner.example",
      childProcesses: boundary,
      probe: async () => true,
    });
    const address = {
      host: "127.0.0.1" as const,
      port: 48765,
      path: "/mcp",
      fullPath: "/mcp/full",
    };

    const first = supervisor.start(address);
    const second = supervisor.start(address);
    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(spawns).toBe(1);
    await supervisor.stop();
  });

  it("aborts in-flight readiness and cannot publish a late probe result after stop", async () => {
    const child = new FakeChild();
    let probeStarted = false;
    let releaseProbe: ((ready: boolean) => void) | undefined;
    const pendingProbe = new Promise<boolean>((resolveProbe) => {
      releaseProbe = resolveProbe;
    });
    const boundary = new HiddenChildProcessBoundary(() => child as never);
    const supervisor = new ExternalTunnelSupervisor({
      kind: "cloudflare",
      executablePath: "cloudflared.exe",
      publicUrl: "https://owner.example",
      childProcesses: boundary,
      probe: async () => {
        probeStarted = true;
        return pendingProbe;
      },
    });
    const address = {
      host: "127.0.0.1" as const,
      port: 48765,
      path: "/mcp",
      fullPath: "/mcp/full",
    };

    const starting = supervisor.start(address);
    await eventually(() => probeStarted);
    const stopping = supervisor.stop();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    await expect(stopping).resolves.toBeUndefined();
    releaseProbe?.(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(supervisor.status).toBeUndefined();
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("clears stale status and reconnects an exited ready child with bounded backoff", async () => {
    const first = new FakeChild(4201);
    const second = new FakeChild(4202);
    const children = [first, second];
    const delays: number[] = [];
    const exits: Error[] = [];
    const recoveredPids: number[] = [];
    const boundary = new HiddenChildProcessBoundary(() => {
      const child = children.shift();
      if (child === undefined) throw new Error("unexpected extra tunnel spawn");
      return child as never;
    });
    const supervisor = new ExternalTunnelSupervisor({
      kind: "cloudflare",
      executablePath: "cloudflared.exe",
      publicUrl: "https://owner.example",
      childProcesses: boundary,
      probe: async () => true,
      reconnectPolicy: { maximumRestarts: 2, delayMs: 25 },
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
      onUnexpectedExit: (error) => {
        exits.push(error);
      },
      onRecovered: (status) => {
        recoveredPids.push(status.pid);
      },
    });
    const address = {
      host: "127.0.0.1" as const,
      port: 48765,
      path: "/mcp",
      fullPath: "/mcp/full",
    };

    await expect(supervisor.start(address)).resolves.toMatchObject({ pid: 4201 });
    first.exitCode = 1;
    first.emit("close", 1, null);
    expect(supervisor.status).toBeUndefined();
    await expect(supervisor.start(address)).resolves.toMatchObject({ pid: 4202 });
    expect(delays).toEqual([25]);
    expect(exits).toHaveLength(1);
    expect(recoveredPids).toEqual([4202]);
    await supervisor.stop();
  });

  it("stops reconnecting at the configured limit and leaves no stale status", async () => {
    const first = new FakeChild(4201);
    const firstRetry = new FakeChild(4202);
    const secondRetry = new FakeChild(4203);
    const children = [first, firstRetry, secondRetry];
    let probes = 0;
    let clock = 0;
    const delays: number[] = [];
    const boundary = new HiddenChildProcessBoundary(() => {
      const child = children.shift();
      if (child === undefined) throw new Error("unexpected extra tunnel spawn");
      return child as never;
    });
    const supervisor = new ExternalTunnelSupervisor({
      kind: "cloudflare",
      executablePath: "cloudflared.exe",
      publicUrl: "https://owner.example",
      childProcesses: boundary,
      probe: async () => {
        probes += 1;
        return probes === 1;
      },
      startupTimeoutMs: 1,
      probeIntervalMs: 1,
      reconnectPolicy: { maximumRestarts: 2, delayMs: 5 },
      now: () => clock,
      delay: async (milliseconds) => {
        delays.push(milliseconds);
        clock += milliseconds;
      },
    });
    const address = {
      host: "127.0.0.1" as const,
      port: 48765,
      path: "/mcp",
      fullPath: "/mcp/full",
    };

    await expect(supervisor.start(address)).resolves.toMatchObject({ pid: 4201 });
    first.exitCode = 1;
    first.emit("close", 1, null);
    await expect(supervisor.start(address)).rejects.toThrow("reconnect attempts exhausted");
    expect(children).toHaveLength(0);
    expect(delays).toEqual([5, 1, 10, 1]);
    expect(firstRetry.signals).toEqual(["SIGTERM"]);
    expect(secondRetry.signals).toEqual(["SIGTERM"]);
    expect(supervisor.status).toBeUndefined();
  });

  it("serializes restart and ignores a replaced child's late exit", async () => {
    const first = new FakeChild(4201);
    const second = new FakeChild(4202);
    const children = [first, second];
    const boundary = new HiddenChildProcessBoundary(() => {
      const child = children.shift();
      if (child === undefined) throw new Error("unexpected extra tunnel spawn");
      return child as never;
    });
    const supervisor = new ExternalTunnelSupervisor({
      kind: "cloudflare",
      executablePath: "cloudflared.exe",
      publicUrl: "https://owner.example",
      childProcesses: boundary,
      probe: async () => true,
    });
    const address = {
      host: "127.0.0.1" as const,
      port: 48765,
      path: "/mcp",
      fullPath: "/mcp/full",
    };

    await expect(supervisor.start(address)).resolves.toMatchObject({ pid: 4201 });
    await expect(supervisor.restart(address)).resolves.toMatchObject({ pid: 4202 });
    first.emit("close", null, "SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));
    expect(supervisor.status).toMatchObject({ pid: 4202 });
    expect(first.signals).toEqual(["SIGTERM"]);
    await supervisor.stop();
  });

  it("retains an unkillable owned child without spawning a replacement", async () => {
    const child = new FakeChild(4201, { exitOnSignal: null });
    let spawns = 0;
    const boundary = new HiddenChildProcessBoundary(() => {
      spawns += 1;
      return child as never;
    });
    const supervisor = new ExternalTunnelSupervisor({
      kind: "cloudflare",
      executablePath: "cloudflared.exe",
      publicUrl: "https://owner.example",
      childProcesses: boundary,
      probe: async () => true,
      gracefulStopTimeoutMs: 1,
      forceStopTimeoutMs: 1,
    });
    const address = {
      host: "127.0.0.1" as const,
      port: 48765,
      path: "/mcp",
      fullPath: "/mcp/full",
    };

    const status = await supervisor.start(address);
    await expect(supervisor.stop()).rejects.toThrow("ownership retained");
    expect(supervisor.status).toEqual(status);
    await expect(supervisor.start(address)).rejects.toThrow("owned child is retained");
    expect(spawns).toBe(1);
    child.exitCode = 0;
    child.emit("close", 0, null);
    expect(supervisor.status).toBeUndefined();
    await expect(supervisor.stop()).resolves.toBeUndefined();
  });
});

class FakeChild extends EventEmitter {
  readonly pid: number;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly signals: Array<NodeJS.Signals | number> = [];
  readonly #exitOnSignal: NodeJS.Signals | number | null;

  constructor(
    pid = 4242,
    options: { readonly exitOnSignal?: NodeJS.Signals | number | null } = {},
  ) {
    super();
    this.pid = pid;
    this.#exitOnSignal = options.exitOnSignal === undefined ? "SIGTERM" : options.exitOnSignal;
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.killed = true;
    this.signals.push(signal);
    if (signal === this.#exitOnSignal) {
      this.signalCode = typeof signal === "string" ? signal : "SIGTERM";
      queueMicrotask(() => this.emit("close", null, signal));
    }
    return true;
  }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}
