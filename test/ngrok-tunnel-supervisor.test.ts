import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NgrokTunnelSupervisor } from "../src/infrastructure/tunnel/ngrok-tunnel-supervisor.js";
import { HiddenChildProcessBoundary } from "../src/infrastructure/windows/hidden-child-process.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("NgrokTunnelSupervisor", () => {
  it("starts one owned hidden child and proves the public protected-resource route", async () => {
    const executablePath = await fakeExecutable();
    const child = new FakeChild();
    const spawns: Array<{ executable: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> =
      [];
    const probes: string[] = [];
    const childProcesses = new HiddenChildProcessBoundary((executable, args, options) => {
      spawns.push({ executable, args, env: options.env as NodeJS.ProcessEnv });
      emitReady(child, "https://owner.ngrok.app");
      return child as never;
    });
    const tunnel = new NgrokTunnelSupervisor({
      executablePath,
      publicUrl: "https://owner.ngrok.app",
      expectedResource: "https://owner.ngrok.app/mcp/full",
      credentialRef: "dpapi:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      secretStore: {
        put: async () => "unused",
        remove: async () => undefined,
        get: async () => "ngrok-authtoken-kept-out-of-arguments",
      },
      childProcesses,
      probe: async (url, expectedResource) => {
        probes.push(url.href);
        expect(expectedResource).toBe("https://owner.ngrok.app/mcp/full");
        return true;
      },
    });

    await expect(
      tunnel.start({ host: "127.0.0.1", port: 48765, path: "/mcp", fullPath: "/mcp/full" }),
    ).resolves.toEqual({
      kind: "ngrok",
      publicUrl: "https://owner.ngrok.app",
      targetUrl: "http://127.0.0.1:48765",
      pid: 4242,
    });
    expect(spawns).toEqual([
      {
        executable: executablePath,
        args: expect.arrayContaining([
          "http",
          "http://127.0.0.1:48765",
          "--url",
          "https://owner.ngrok.app",
          "--config",
          "--log=stdout",
          "--log-format=json",
        ]),
        env: expect.objectContaining({ NGROK_AUTHTOKEN: "ngrok-authtoken-kept-out-of-arguments" }),
      },
    ]);
    const configFlag = spawns[0]?.args.indexOf("--config") ?? -1;
    const runtimeConfigPath = spawns[0]?.args[configFlag + 1];
    expect(configFlag).toBeGreaterThan(0);
    expect(runtimeConfigPath).toBeTypeOf("string");
    expect(await readFile(runtimeConfigPath as string, "utf8")).toBe(
      'version: "2"\nweb_addr: false\n',
    );
    expect(JSON.stringify(spawns[0]?.args)).not.toContain("ngrok-authtoken-kept-out-of-arguments");
    expect(probes).toEqual([
      "https://owner.ngrok.app/.well-known/oauth-protected-resource/mcp/full",
    ]);

    await tunnel.stop();
    expect(child.killed).toBe(true);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(tunnel.status).toBeUndefined();
    await expect(access(runtimeConfigPath as string)).rejects.toThrow();
  });

  it("fails immediately with the authoritative ngrok bandwidth rejection", async () => {
    const executablePath = await fakeExecutable();
    const child = new FakeChild();
    const childProcesses = new HiddenChildProcessBoundary(() => {
      emitReady(child, "https://owner.ngrok.app");
      return child as never;
    });
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          "<html><noscript>This ngrok account has reached its network bandwidth limit for the month.</noscript></html>",
          { status: 403, headers: { "content-type": "text/html" } },
        ),
    );
    const tunnel = new NgrokTunnelSupervisor({
      executablePath,
      publicUrl: "https://owner.ngrok.app",
      expectedResource: "https://owner.ngrok.app/mcp/full",
      startupTimeoutMs: 5_000,
      probeIntervalMs: 1,
      childProcesses,
    });

    await expect(
      tunnel.start({ host: "127.0.0.1", port: 48765, path: "/mcp", fullPath: "/mcp/full" }),
    ).rejects.toThrow("account network bandwidth limit reached (HTTP 403)");
    expect(child.killed).toBe(true);
  });

  it("rejects non-origin and credential-bearing public URLs", async () => {
    expect(
      () =>
        new NgrokTunnelSupervisor({
          executablePath: "ngrok.exe",
          publicUrl: "https://owner.ngrok.app/path",
          expectedResource: "https://owner.ngrok.app/mcp",
        }),
    ).toThrow("HTTPS origin");
    expect(
      () =>
        new NgrokTunnelSupervisor({
          executablePath: "ngrok.exe",
          publicUrl: "https://token@owner.ngrok.app",
          expectedResource: "https://owner.ngrok.app/mcp",
        }),
    ).toThrow("HTTPS origin");
    expect(
      () =>
        new NgrokTunnelSupervisor({
          executablePath: "ngrok.exe",
          publicUrl: "https://owner.ngrok.app:8443",
          expectedResource: "https://owner.ngrok.app:8443/mcp",
        }),
    ).toThrow("HTTPS origin");
  });

  it("parses a complete readiness record larger than the former internal buffer", async () => {
    const executablePath = await fakeExecutable();
    const child = new FakeChild();
    const childProcesses = new HiddenChildProcessBoundary(() => {
      queueMicrotask(() => {
        child.stdout.write(
          `${JSON.stringify({
            padding: "메타데이터.".repeat(10_000),
            lvl: "info",
            msg: "started tunnel",
            url: "https://owner.ngrok.app",
          })}\n`,
        );
      });
      return child as never;
    });
    const tunnel = new NgrokTunnelSupervisor({
      executablePath,
      publicUrl: "https://owner.ngrok.app",
      expectedResource: "https://owner.ngrok.app/mcp/full",
      childProcesses,
      probe: async () => true,
    });

    await expect(
      tunnel.start({ host: "127.0.0.1", port: 48765, path: "/mcp", fullPath: "/mcp/full" }),
    ).resolves.toMatchObject({ publicUrl: "https://owner.ngrok.app" });
    await tunnel.stop();
  });

  it("fails when the owned process exits and redacts its diagnostic", async () => {
    const executablePath = await fakeExecutable();
    const child = new FakeChild();
    const childProcesses = new HiddenChildProcessBoundary(() => {
      queueMicrotask(() => {
        child.stderr.write("token=super-secret-value");
        child.exitCode = 1;
        child.emit("close", 1, null);
      });
      return child as never;
    });
    const tunnel = new NgrokTunnelSupervisor({
      executablePath,
      publicUrl: "https://owner.ngrok.app",
      expectedResource: "https://owner.ngrok.app/mcp",
      probeIntervalMs: 1,
      childProcesses,
      probe: async () => false,
    });

    const error = await tunnel
      .start({ host: "127.0.0.1", port: 48765, path: "/mcp", fullPath: "/mcp/full" })
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("token=[redacted]");
    expect((error as Error).message).not.toContain("super-secret-value");
  });

  it("does not treat another process serving the public URL as this child's readiness", async () => {
    const executablePath = await fakeExecutable();
    const child = new FakeChild();
    const childProcesses = new HiddenChildProcessBoundary(() => {
      queueMicrotask(() => {
        child.stderr.write("ERR_NGROK_334 endpoint is already online\n");
        child.exitCode = 1;
        child.emit("close", 1, null);
      });
      return child as never;
    });
    const tunnel = new NgrokTunnelSupervisor({
      executablePath,
      publicUrl: "https://owner.ngrok.app",
      expectedResource: "https://owner.ngrok.app/mcp/full",
      probeIntervalMs: 1,
      childProcesses,
      probe: async () => true,
    });

    await expect(
      tunnel.start({ host: "127.0.0.1", port: 48765, path: "/mcp", fullPath: "/mcp/full" }),
    ).rejects.toThrow("ERR_NGROK_334");
    expect(tunnel.status).toBeUndefined();
  });

  it("reports one unexpected exit after readiness and can replace the owned child", async () => {
    const executablePath = await fakeExecutable();
    const first = new FakeChild();
    const second = new FakeChild();
    const children = [first, second];
    const exits: Error[] = [];
    const childProcesses = new HiddenChildProcessBoundary(() => {
      const child = children.shift();
      if (child === undefined) throw new Error("unexpected extra ngrok spawn");
      emitReady(child, "https://owner.ngrok.app");
      return child as never;
    });
    const tunnel = new NgrokTunnelSupervisor({
      executablePath,
      publicUrl: "https://owner.ngrok.app",
      expectedResource: "https://owner.ngrok.app/mcp/full",
      childProcesses,
      probe: async () => true,
      onUnexpectedExit: (error) => exits.push(error),
    });
    const address = {
      host: "127.0.0.1" as const,
      port: 48765,
      path: "/mcp",
      fullPath: "/mcp/full",
    };

    await expect(tunnel.start(address)).resolves.toMatchObject({ pid: first.pid });
    first.exitCode = 1;
    first.emit("close", 1, null);
    expect(tunnel.status).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(exits).toHaveLength(1);
    expect(exits[0]?.message).toContain("exited after readiness");

    await expect(tunnel.restart(address)).resolves.toMatchObject({ pid: second.pid });
    await tunnel.stop();
    expect(second.killed).toBe(true);
  });

  it("durably exposes child identity before readiness and clears it only after exit", async () => {
    const executablePath = await fakeExecutable();
    const child = new FakeChild();
    const events: string[] = [];
    const childProcesses = new HiddenChildProcessBoundary(() => {
      queueMicrotask(() => {
        events.push("ready-log");
        child.stdout.write(
          `${JSON.stringify({ lvl: "info", msg: "started tunnel", url: "https://owner.ngrok.app" })}\n`,
        );
      });
      return child as never;
    });
    const tunnel = new NgrokTunnelSupervisor({
      executablePath,
      publicUrl: "https://owner.ngrok.app",
      expectedResource: "https://owner.ngrok.app/mcp/full",
      childProcesses,
      probe: async () => true,
      onSpawned: async (ownership) => {
        events.push("ownership-persisted");
        expect(ownership).toMatchObject({
          kind: "ngrok",
          pid: child.pid,
          parentPid: process.pid,
          executablePath,
          targetUrl: "http://127.0.0.1:48765",
          publicUrl: "https://owner.ngrok.app",
        });
      },
      onStopped: async () => {
        events.push("ownership-cleared");
      },
    });

    await tunnel.start({
      host: "127.0.0.1",
      port: 48765,
      path: "/mcp",
      fullPath: "/mcp/full",
    });
    expect(events.indexOf("ownership-persisted")).toBeLessThan(events.indexOf("ready-log"));
    await tunnel.stop();
    expect(events.at(-1)).toBe("ownership-cleared");
  });

  it("force-terminates only the owned child when graceful shutdown hangs", async () => {
    const executablePath = await fakeExecutable();
    const child = new FakeChild({ exitOnSignal: "SIGKILL" });
    const childProcesses = new HiddenChildProcessBoundary(() => {
      emitReady(child, "https://owner.ngrok.app");
      return child as never;
    });
    const tunnel = new NgrokTunnelSupervisor({
      executablePath,
      publicUrl: "https://owner.ngrok.app",
      expectedResource: "https://owner.ngrok.app/mcp/full",
      gracefulStopTimeoutMs: 1,
      forceStopTimeoutMs: 1,
      childProcesses,
      probe: async () => true,
    });

    await tunnel.start({ host: "127.0.0.1", port: 48765, path: "/mcp", fullPath: "/mcp/full" });
    await expect(tunnel.stop()).resolves.toBeUndefined();

    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(tunnel.status).toBeUndefined();
  });

  it("retains the owned child and status when even force termination hangs", async () => {
    const executablePath = await fakeExecutable();
    const child = new FakeChild({ exitOnSignal: null });
    const childProcesses = new HiddenChildProcessBoundary(() => {
      emitReady(child, "https://owner.ngrok.app");
      return child as never;
    });
    const tunnel = new NgrokTunnelSupervisor({
      executablePath,
      publicUrl: "https://owner.ngrok.app",
      expectedResource: "https://owner.ngrok.app/mcp/full",
      gracefulStopTimeoutMs: 1,
      forceStopTimeoutMs: 1,
      childProcesses,
      probe: async () => true,
    });
    const address = {
      host: "127.0.0.1" as const,
      port: 48765,
      path: "/mcp",
      fullPath: "/mcp/full",
    };
    const started = await tunnel.start(address);

    await expect(tunnel.stop()).rejects.toThrow(
      "did not exit after SIGTERM and SIGKILL; ownership retained",
    );
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(tunnel.status).toEqual(started);
    await expect(tunnel.restart(address)).rejects.toThrow("ownership retained");
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"]);

    child.exitCode = 0;
    child.emit("close", 0, null);
    expect(tunnel.status).toBeUndefined();
    await expect(tunnel.stop()).resolves.toBeUndefined();
    expect(tunnel.status).toBeUndefined();
  });

  it("coalesces concurrent starts for the same target into one owned child", async () => {
    const executablePath = await fakeExecutable();
    const child = new FakeChild();
    let spawns = 0;
    const childProcesses = new HiddenChildProcessBoundary(() => {
      spawns += 1;
      emitReady(child, "https://owner.ngrok.app");
      return child as never;
    });
    const tunnel = new NgrokTunnelSupervisor({
      executablePath,
      publicUrl: "https://owner.ngrok.app",
      expectedResource: "https://owner.ngrok.app/mcp/full",
      childProcesses,
      probe: async () => true,
    });
    const address = {
      host: "127.0.0.1" as const,
      port: 48765,
      path: "/mcp",
      fullPath: "/mcp/full",
    };

    const first = tunnel.start(address);
    const second = tunnel.start(address);
    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(spawns).toBe(1);
    await tunnel.stop();
  });

  it("aborts in-flight readiness before stop waits and ignores its late success", async () => {
    const executablePath = await fakeExecutable();
    const child = new FakeChild();
    let markProbeStarted: (() => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      markProbeStarted = resolveStarted;
    });
    let releaseProbe: ((ready: boolean) => void) | undefined;
    const pendingProbe = new Promise<boolean>((resolveProbe) => {
      releaseProbe = resolveProbe;
    });
    const childProcesses = new HiddenChildProcessBoundary(() => {
      emitReady(child, "https://owner.ngrok.app");
      return child as never;
    });
    const tunnel = new NgrokTunnelSupervisor({
      executablePath,
      publicUrl: "https://owner.ngrok.app",
      expectedResource: "https://owner.ngrok.app/mcp/full",
      childProcesses,
      probe: async () => {
        markProbeStarted?.();
        return pendingProbe;
      },
    });
    const address = {
      host: "127.0.0.1" as const,
      port: 48765,
      path: "/mcp",
      fullPath: "/mcp/full",
    };

    const starting = tunnel.start(address);
    await probeStarted;
    const stopping = tunnel.stop();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    await expect(stopping).resolves.toBeUndefined();
    releaseProbe?.(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(tunnel.status).toBeUndefined();
    expect(child.signals).toEqual(["SIGTERM"]);
  });
});

class FakeChild extends EventEmitter {
  readonly pid = 4242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly signals: Array<NodeJS.Signals | number> = [];
  readonly #exitOnSignal: NodeJS.Signals | number | null;

  constructor(options: { readonly exitOnSignal?: NodeJS.Signals | number | null } = {}) {
    super();
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

async function fakeExecutable(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-ngrok-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "ngrok.exe");
  await writeFile(path, "fixture", "utf8");
  return path;
}

function emitReady(child: FakeChild, url: string): void {
  queueMicrotask(() => {
    child.stdout.write(`${JSON.stringify({ lvl: "info", msg: "started tunnel", url })}\n`);
  });
}
