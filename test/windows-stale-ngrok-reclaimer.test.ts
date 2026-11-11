import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OmniCodexDaemonState } from "../src/infrastructure/config/omnicodex-config-store.js";
import {
  parseWindowsCommandLine,
  type WindowsProcessObservation,
  WindowsStaleNgrokReclaimer,
} from "../src/infrastructure/windows/windows-stale-ngrok-reclaimer.js";

describe("WindowsStaleNgrokReclaimer", () => {
  it("reclaims one exact durable ngrok child and no other process", async () => {
    const fixture = makeFixture(true);
    const terminate = vi.fn(async () => "terminated" as const);
    const removeRuntimeConfig = vi.fn(async () => undefined);
    const reclaimer = new WindowsStaleNgrokReclaimer({
      inspectProcess: async () => fixture.observed,
      terminateExactProcess: terminate,
      readRuntimeConfig: async () => 'version: "2"\nweb_addr: false\n',
      removeRuntimeConfig,
      temporaryDirectory: fixture.temporaryDirectory,
    });

    await expect(reclaimer.reclaim(fixture.request)).resolves.toEqual({
      status: "reclaimed",
      pid: fixture.observed.pid,
    });
    expect(terminate).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledWith(fixture.observed);
    expect(removeRuntimeConfig).toHaveBeenCalledWith(
      fixture.request.daemonState.tunnelOwnership?.configPath,
    );
  });

  it.each([
    ["parent", { parentPid: 9999 }],
    ["executable", { executablePath: "C:\\foreign\\ngrok.exe" }],
    ["creation", { startedAtIso: "2000-01-01T00:00:00.000Z" }],
    ["arguments", { commandLine: '"C:\\foreign\\ngrok.exe" http bad' }],
  ])("refuses a %s identity mismatch without signalling", async (_label, difference) => {
    const fixture = makeFixture(true);
    const terminate = vi.fn(async () => "terminated" as const);
    const reclaimer = new WindowsStaleNgrokReclaimer({
      inspectProcess: async () => ({ ...fixture.observed, ...difference }),
      terminateExactProcess: terminate,
      readRuntimeConfig: async () => 'version: "2"\nweb_addr: false\n',
      temporaryDirectory: fixture.temporaryDirectory,
    });

    await expect(reclaimer.reclaim(fixture.request)).rejects.toThrow(
      /STALE_NGROK_IDENTITY_MISMATCH/u,
    );
    expect(terminate).not.toHaveBeenCalled();
  });

  it("supports a legacy ready state only after exact live command and config verification", async () => {
    const fixture = makeFixture(false);
    const terminate = vi.fn(async () => "terminated" as const);
    const reclaimer = new WindowsStaleNgrokReclaimer({
      inspectProcess: async () => fixture.observed,
      terminateExactProcess: terminate,
      readRuntimeConfig: async () => 'version: "2"\nweb_addr: false\n',
      temporaryDirectory: fixture.temporaryDirectory,
    });

    await expect(reclaimer.reclaim(fixture.request)).resolves.toMatchObject({
      status: "reclaimed",
    });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("cleans a durable crash-left runtime config when the recorded process is already absent", async () => {
    const fixture = makeFixture(true);
    const terminate = vi.fn(async () => "terminated" as const);
    const removeRuntimeConfig = vi.fn(async () => undefined);
    const reclaimer = new WindowsStaleNgrokReclaimer({
      inspectProcess: async () => undefined,
      terminateExactProcess: terminate,
      readRuntimeConfig: async () => 'version: "2"\nweb_addr: false\n',
      removeRuntimeConfig,
      temporaryDirectory: fixture.temporaryDirectory,
    });

    await expect(reclaimer.reclaim(fixture.request)).resolves.toEqual({
      status: "already_absent",
      pid: fixture.observed.pid,
    });
    expect(terminate).not.toHaveBeenCalled();
    expect(removeRuntimeConfig).toHaveBeenCalledWith(
      fixture.request.daemonState.tunnelOwnership?.configPath,
    );
  });

  it("fails closed if the process changes between inspection and termination", async () => {
    const fixture = makeFixture(true);
    const reclaimer = new WindowsStaleNgrokReclaimer({
      inspectProcess: async () => fixture.observed,
      terminateExactProcess: async () => "changed",
      readRuntimeConfig: async () => 'version: "2"\nweb_addr: false\n',
      temporaryDirectory: fixture.temporaryDirectory,
    });
    await expect(reclaimer.reclaim(fixture.request)).rejects.toThrow(
      "STALE_NGROK_IDENTITY_CHANGED",
    );
  });

  it("parses quoted Windows paths without weakening exact argument matching", () => {
    expect(
      parseWindowsCommandLine(
        '"C:\\Program Files\\ngrok.exe" http http://127.0.0.1:8787 --domain owner.example --config "C:\\Temp Root\\omnicodex-ngrok-Ab12\\ngrok.yml" --log=stdout --log-format=json',
      ),
    ).toEqual([
      "C:\\Program Files\\ngrok.exe",
      "http",
      "http://127.0.0.1:8787",
      "--domain",
      "owner.example",
      "--config",
      "C:\\Temp Root\\omnicodex-ngrok-Ab12\\ngrok.yml",
      "--log=stdout",
      "--log-format=json",
    ]);
  });
});

function makeFixture(withDurableOwnership: boolean): {
  readonly temporaryDirectory: string;
  readonly observed: WindowsProcessObservation;
  readonly request: {
    readonly daemonState: OmniCodexDaemonState;
    readonly executablePath: string;
    readonly publicUrl: string;
  };
} {
  const now = Date.now();
  const temporaryDirectory = join(process.cwd(), ".test-temp");
  const executablePath = join(process.cwd(), "Program Files", "ngrok.exe");
  const configPath = join(temporaryDirectory, "omnicodex-ngrok-Ab12", "ngrok.yml");
  const publicUrl = "https://owner.example";
  const targetUrl = "http://127.0.0.1:8787";
  const observed: WindowsProcessObservation = {
    pid: 52040,
    parentPid: 45240,
    name: "ngrok.exe",
    executablePath,
    commandLine: `"${executablePath}" http ${targetUrl} --domain owner.example --config "${configPath}" --log=stdout --log-format=json`,
    startedAtIso: new Date(now).toISOString(),
  };
  const daemonState: OmniCodexDaemonState = {
    schemaVersion: 1,
    lifecycle: "ready",
    pid: 45240,
    instanceNonce: "a".repeat(32),
    startedAtUnixMs: now - 1_000,
    updatedAtUnixMs: now + 1_000,
    controlPipe: "owned-control-pipe",
    controlToken: "b".repeat(32),
    address: { host: "127.0.0.1", port: 8787, path: "/mcp", fullPath: "/mcp/full" },
    tunnel: { kind: "ngrok", publicUrl, pid: observed.pid },
    ...(withDurableOwnership
      ? {
          tunnelOwnership: {
            kind: "ngrok" as const,
            pid: observed.pid,
            parentPid: daemonStateParentPid(),
            processNonce: "11111111-1111-4111-8111-111111111111",
            executablePath,
            spawnedAtUnixMs: now,
            targetUrl,
            publicUrl,
            configPath,
          },
        }
      : {}),
  };
  return {
    temporaryDirectory,
    observed,
    request: { daemonState, executablePath, publicUrl },
  };
}

function daemonStateParentPid(): number {
  return 45240;
}
