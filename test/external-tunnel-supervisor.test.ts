import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ExternalTunnelSupervisor } from "../src/infrastructure/tunnel/external-tunnel-supervisor.js";
import { HiddenChildProcessBoundary } from "../src/infrastructure/windows/hidden-child-process.js";

describe("ExternalTunnelSupervisor", () => {
  it.each([
    ["cloudflare", ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:48765"]],
    ["tailscale", ["funnel", "--bg=false", "http://127.0.0.1:48765"]],
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
});

class FakeChild extends EventEmitter {
  readonly pid = 4242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.signalCode = "SIGTERM";
    return true;
  }
}
