import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { NgrokTunnelSupervisor } from "../src/infrastructure/tunnel/ngrok-tunnel-supervisor.js";
import { HiddenChildProcessBoundary } from "../src/infrastructure/windows/hidden-child-process.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
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
    const spawns: Array<{ executable: string; args: readonly string[] }> = [];
    const probes: string[] = [];
    const childProcesses = new HiddenChildProcessBoundary((executable, args) => {
      spawns.push({ executable, args });
      return child as never;
    });
    const tunnel = new NgrokTunnelSupervisor({
      executablePath,
      publicUrl: "https://owner.ngrok.app",
      expectedResource: "https://owner.ngrok.app/mcp",
      childProcesses,
      probe: async (url, expectedResource) => {
        probes.push(url.href);
        expect(expectedResource).toBe("https://owner.ngrok.app/mcp");
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
        args: [
          "http",
          "http://127.0.0.1:48765",
          "--url",
          "https://owner.ngrok.app",
          "--log=stdout",
          "--log-format=json",
        ],
      },
    ]);
    expect(probes).toEqual(["https://owner.ngrok.app/.well-known/oauth-protected-resource/mcp"]);

    await tunnel.stop();
    expect(child.killed).toBe(true);
    expect(tunnel.status).toBeUndefined();
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
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
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
