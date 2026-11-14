import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, terminateMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  terminateMock: vi.fn(),
}));
vi.mock("../src/infrastructure/windows/hidden-child-process.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  spawnHidden: spawnMock,
  terminateOwnedHiddenChild: terminateMock,
}));

import {
  ensureConfiguredOmniCodex2Tunnel,
  superviseConfiguredOmniCodex2Tunnel,
} from "../src/cli.js";
import type { OmniCodexDaemonState } from "../src/infrastructure/config/omnicodex-config-store.js";

const scriptPath = fileURLToPath(
  new URL("../scripts/windows/start-omnicodex2-tunnel.ps1", import.meta.url),
);
const powershellExecutable = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
let root: string;
let dataDirectory: string;
let profilePath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "omnicodex2-autostart-"));
  dataDirectory = join(root, "data");
  profilePath = join(root, "roaming", "tunnel-client", "omnicodex2.yaml");
  await mkdir(join(root, "roaming", "tunnel-client"), { recursive: true });
  await mkdir(join(dataDirectory, "tunnel-client-private"), { recursive: true });
  await mkdir(join(root, "fake-codex"), { recursive: true });
  await writeFile(join(root, "fake-codex", "codex.cmd"), "@exit /b 0\r\n");
  vi.stubEnv("APPDATA", join(root, "roaming"));
  vi.stubEnv("LOCALAPPDATA", join(root, "local"));
  vi.stubEnv("OMNICODEX_DATA_DIR", dataDirectory);
});

afterEach(async () => {
  spawnMock.mockReset();
  terminateMock.mockReset();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("configured omnicodex2 scheduled startup", () => {
  it("initializes supervisor state before direct CLI command parsing", async () => {
    const source = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
    const parse = source.indexOf("await program.parseAsync(process.argv)");
    expect(parse).toBeGreaterThan(source.indexOf("const OMNICODEX2_TUNNEL_CHECK_INTERVAL_MS"));
    expect(parse).toBeGreaterThan(source.indexOf("let omniCodex2TunnelFlight"));
    expect(parse).toBeGreaterThan(source.indexOf("let lastOmniCodex2TunnelFailure"));
  });

  it("skips a machine without an existing omnicodex2 profile", async () => {
    await ensureConfiguredOmniCodex2Tunnel();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("starts the packaged script once with the idempotent option and existing key reference", async () => {
    await writeFile(profilePath, "{}");
    mockChildExit(0);
    await ensureConfiguredOmniCodex2Tunnel();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      powershellExecutable,
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-ProfileDirectory",
        join(root, "roaming", "tunnel-client"),
        "-EnsureRunning",
      ],
      expect.objectContaining({
        env: expect.objectContaining({ OMNICODEX_DATA_DIR: dataDirectory }),
        stdio: ["ignore", "ignore", "ignore"],
      }),
    );
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(packageJson.files).toContain("scripts/windows/start-omnicodex2-tunnel.ps1");
  });

  it("uses the existing MSIX backing profile when the scheduled task cannot see the roaming profile", async () => {
    const packagedDirectory = await writePackagedProfile();
    mockChildExit(0);
    await ensureConfiguredOmniCodex2Tunnel();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[1]).toContain(packagedDirectory);
    await expect(readFile(profilePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(packagedDirectory, "omnicodex2.yaml"), "utf8")).toBe("{}");
  });

  it("prefers the existing ordinary profile when both AppData views contain a profile", async () => {
    const packagedDirectory = await writePackagedProfile();
    await writeFile(profilePath, "{}");
    mockChildExit(0);
    await ensureConfiguredOmniCodex2Tunnel();
    expect(spawnMock.mock.calls[0]?.[1]).toContain(join(root, "roaming", "tunnel-client"));
    expect(spawnMock.mock.calls[0]?.[1]).not.toContain(packagedDirectory);
  });

  it("records only a bounded reason code, never child output or credentials", async () => {
    await writeFile(profilePath, "{}");
    mockChildExit(1, "secret-runtime-key Authorization: Bearer secret-token");
    await expect(ensureConfiguredOmniCodex2Tunnel()).resolves.toBeUndefined();
    const contents = await readFile(join(dataDirectory, "operations.jsonl"), "utf8");
    const entry = JSON.parse(contents);
    expect(entry.event).toBe("external_tunnel_start_failed");
    expect(entry.details).toEqual({
      alias: "omnicodex2",
      source: "scheduled-task",
      reasonCode: "COMMAND_FAILED",
    });
    expect(contents).not.toContain("secret-");
    await ensureConfiguredOmniCodex2Tunnel();
    expect(
      (await readFile(join(dataDirectory, "operations.jsonl"), "utf8")).trim().split("\n"),
    ).toHaveLength(1);
    const cliSource = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
    const supervisor = cliSource.slice(
      cliSource.indexOf("async function superviseScheduledTaskDaemon("),
      cliSource.indexOf("interface DaemonControlResponse"),
    );
    expect(supervisor).toContain("await superviseConfiguredOmniCodex2Tunnel(state);");
  });

  it("records a spawn error without ending daemon supervision", async () => {
    await writeFile(profilePath, "{}");
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("spawn powershell.exe ENOENT")));
      return child;
    });
    await expect(ensureConfiguredOmniCodex2Tunnel()).resolves.toBeUndefined();
    const entry = JSON.parse(await readFile(join(dataDirectory, "operations.jsonl"), "utf8"));
    expect(entry.details.reasonCode).toBe("START_FAILED");
  });
});

describe("exact-daemon tunnel maintenance", () => {
  it("rechecks the official idempotent path after port 5367 changes to 12595 on the same PID", async () => {
    vi.useFakeTimers();
    const fixture = supervisorFixture();
    const targets: number[] = [];
    fixture.dependencies.ensure.mockImplementation(async (options) => {
      if (await options?.canStart?.()) targets.push(fixture.current.address?.port ?? 0);
    });
    const supervision = superviseConfiguredOmniCodex2Tunnel(fixture.expected, fixture.dependencies);
    await vi.advanceTimersByTimeAsync(0);
    expect(targets).toEqual([5367]);
    fixture.current = {
      ...fixture.current,
      address: { ...fixture.expected.address, port: 12595 },
    };
    await vi.advanceTimersByTimeAsync(15_000);
    expect(targets).toEqual([5367, 12595]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(targets).toEqual([5367, 12595, 12595]);
    fixture.dependencies.probe.mockReturnValue("absent");
    await vi.advanceTimersByTimeAsync(250);
    await supervision;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(targets).toHaveLength(3);
  });

  it("never overlaps an in-flight check and cancels it when the exact daemon exits", async () => {
    vi.useFakeTimers();
    const fixture = supervisorFixture();
    let finish: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    fixture.dependencies.ensure.mockImplementation((options) => {
      signal = options?.signal;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const supervision = superviseConfiguredOmniCodex2Tunnel(fixture.expected, fixture.dependencies);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(fixture.dependencies.ensure).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    fixture.dependencies.probe.mockReturnValue("absent");
    await vi.advanceTimersByTimeAsync(250);
    await supervision;
    expect(signal?.aborted).toBe(true);
    finish?.();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.dependencies.ensure).toHaveBeenCalledTimes(1);
  });

  it("cancels stale-target work during a switch and waits for its completion before rechecking", async () => {
    vi.useFakeTimers();
    const fixture = supervisorFixture();
    let finish: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    fixture.dependencies.ensure.mockImplementationOnce((options) => {
      signal = options?.signal;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const supervision = superviseConfiguredOmniCodex2Tunnel(fixture.expected, fixture.dependencies);
    await vi.advanceTimersByTimeAsync(0);
    fixture.current = { ...fixture.current, lifecycle: "switching" };
    await vi.advanceTimersByTimeAsync(250);
    expect(signal?.aborted).toBe(true);
    fixture.current = {
      ...fixture.current,
      lifecycle: "ready",
      address: { ...fixture.expected.address, port: 12595 },
    };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.dependencies.ensure).toHaveBeenCalledTimes(1);
    finish?.();
    await vi.advanceTimersByTimeAsync(15_250);
    expect(fixture.dependencies.ensure).toHaveBeenCalledTimes(2);
    fixture.dependencies.probe.mockReturnValue("absent");
    await vi.advanceTimersByTimeAsync(250);
    await supervision;
  });

  it.each([
    { pid: 10133 },
    { instanceNonce: "replacement-nonce" },
    { startedAtUnixMs: 2000 },
    { controlToken: "replacement-control-token" },
  ])("refuses a mismatched exact daemon identity: %j", async (replacement) => {
    const fixture = supervisorFixture();
    fixture.current = { ...fixture.current, ...replacement };
    await superviseConfiguredOmniCodex2Tunnel(fixture.expected, fixture.dependencies);
    expect(fixture.dependencies.status).not.toHaveBeenCalled();
    expect(fixture.dependencies.ensure).not.toHaveBeenCalled();
  });

  it("does not rebind on a late ownership response after replacement", async () => {
    vi.useFakeTimers();
    const fixture = supervisorFixture();
    let finish: ((value: { lifecycle: OmniCodexDaemonState["lifecycle"] }) => void) | undefined;
    fixture.dependencies.status.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const supervision = superviseConfiguredOmniCodex2Tunnel(fixture.expected, fixture.dependencies);
    await vi.advanceTimersByTimeAsync(0);
    fixture.current = { ...fixture.current, instanceNonce: "replacement-nonce" };
    await vi.advanceTimersByTimeAsync(250);
    await supervision;
    finish?.({ lifecycle: "ready" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.dependencies.ensure).not.toHaveBeenCalled();
  });

  it("requires authenticated ready status, not just a ready state file", async () => {
    vi.useFakeTimers();
    const fixture = supervisorFixture();
    fixture.dependencies.status.mockRejectedValueOnce(new Error("ownership proof rejected"));
    fixture.dependencies.status.mockResolvedValueOnce({ lifecycle: "draining" });
    const supervision = superviseConfiguredOmniCodex2Tunnel(fixture.expected, fixture.dependencies);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fixture.dependencies.ensure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fixture.dependencies.ensure).toHaveBeenCalledTimes(1);
    fixture.dependencies.probe.mockReturnValue("absent");
    await vi.advanceTimersByTimeAsync(250);
    await supervision;
  });

  it("keeps task ownership through missing state but does no tunnel work without proof", async () => {
    vi.useFakeTimers();
    const fixture = supervisorFixture();
    fixture.dependencies.readState.mockResolvedValue(undefined);
    let exited = false;
    const supervision = superviseConfiguredOmniCodex2Tunnel(
      fixture.expected,
      fixture.dependencies,
    ).then(() => {
      exited = true;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(exited).toBe(false);
    expect(fixture.dependencies.status).not.toHaveBeenCalled();
    expect(fixture.dependencies.ensure).not.toHaveBeenCalled();
    fixture.dependencies.probe.mockReturnValue("absent");
    await vi.advanceTimersByTimeAsync(250);
    await supervision;
  });

  it("revalidates ownership immediately before spawning after profile discovery", async () => {
    await writeFile(profilePath, "{}");
    await ensureConfiguredOmniCodex2Tunnel({ canStart: async () => false });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("bounds a stuck command and retains serialization until its exact child closes", async () => {
    await writeFile(profilePath, "{}");
    vi.useFakeTimers();
    const child = new EventEmitter();
    spawnMock.mockReturnValue(child);
    terminateMock.mockReturnValue(false);
    const pending = ensureConfiguredOmniCodex2Tunnel();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    await ensureConfiguredOmniCodex2Tunnel();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(terminateMock).toHaveBeenCalledExactlyOnceWith(child);
    await ensureConfiguredOmniCodex2Tunnel();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    child.emit("close", null, "SIGTERM");
    await pending;
    const entry = JSON.parse(await readFile(join(dataDirectory, "operations.jsonl"), "utf8"));
    expect(entry.details.reasonCode).toBe("COMMAND_TIMEOUT");
    mockChildExit(0);
    await ensureConfiguredOmniCodex2Tunnel();
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("does not release a live command's guard on signal errors before close", async () => {
    await writeFile(profilePath, "{}");
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { pid: 4242 });
    spawnMock.mockReturnValue(child);
    terminateMock.mockImplementation(() => {
      child.emit("error", new Error("signal failed with secret diagnostic"));
      return false;
    });
    const pending = ensureConfiguredOmniCodex2Tunnel();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(30_000);
    child.emit("error", new Error("another signal error"));
    await ensureConfiguredOmniCodex2Tunnel();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    child.emit("close", null, "SIGTERM");
    await pending;
    expect(await readFile(join(dataDirectory, "operations.jsonl"), "utf8")).not.toContain("secret");
  });

  it("cancels only the owned command on stop, with no failure log or later reconnect", async () => {
    await writeFile(profilePath, "{}");
    vi.useFakeTimers();
    const child = new EventEmitter();
    const controller = new AbortController();
    spawnMock.mockReturnValue(child);
    terminateMock.mockImplementation((owned) => {
      expect(owned).toBe(child);
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    const pending = ensureConfiguredOmniCodex2Tunnel({ signal: controller.signal });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    await ensureConfiguredOmniCodex2Tunnel({ signal: controller.signal });
    expect(terminateMock).toHaveBeenCalledExactlyOnceWith(child);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await expect(readFile(join(dataDirectory, "operations.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

function supervisorFixture() {
  const expected: OmniCodexDaemonState & {
    address: NonNullable<OmniCodexDaemonState["address"]>;
  } = {
    schemaVersion: 1,
    lifecycle: "ready",
    pid: 10132,
    instanceNonce: "fixture-nonce",
    startedAtUnixMs: 1000,
    updatedAtUnixMs: 1000,
    controlPipe: "fixture-pipe",
    controlToken: "fixture-control-token",
    address: { host: "127.0.0.1", port: 5367, path: "/mcp", fullPath: "/mcp/full" },
  };
  const fixture = {
    expected,
    current: expected,
    dependencies: {
      readState: vi.fn<() => Promise<OmniCodexDaemonState | undefined>>(),
      probe: vi.fn<() => "alive" | "absent">().mockReturnValue("alive"),
      status: vi
        .fn<
          (
            _state: OmniCodexDaemonState,
            _signal: AbortSignal,
          ) => Promise<{ lifecycle: OmniCodexDaemonState["lifecycle"] }>
        >()
        .mockResolvedValue({ lifecycle: "ready" }),
      ensure: vi.fn<typeof ensureConfiguredOmniCodex2Tunnel>().mockResolvedValue(undefined),
    },
  };
  fixture.dependencies.readState.mockImplementation(async () => fixture.current);
  return fixture;
}

describe.runIf(process.platform === "win32")("PowerShell tunnel startup", () => {
  it("leaves the same healthy runtime untouched without even requesting OAuth metadata", async () => {
    const fixture = await prepareScriptFixture(12049, {});
    const result = await runScript(fixture);
    expect(JSON.parse(result.stdout).alreadyRunning).toBe(true);
    expect(await readCommands()).toEqual(["status"]);
  });

  it("reads an explicit existing profile directory without creating a default roaming profile", async () => {
    const fixture = await prepareScriptFixture(12049, {});
    const packagedDirectory = await writePackagedProfile();
    await writeFile(
      join(packagedDirectory, "omnicodex2.yaml"),
      await readFile(profilePath, "utf8"),
    );
    await rm(profilePath);
    const result = await runScript(fixture, packagedDirectory);
    expect(JSON.parse(result.stdout).alreadyRunning).toBe(true);
    expect(await readCommands()).toEqual(["status"]);
    await expect(readFile(profilePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { name: "stopped", status: { healthy: false, ready: false, process_running: false } },
    { name: "unready", status: { ready: false } },
    { name: "different tunnel", status: { tunnel_id: "tunnel_other" } },
    {
      name: "outdated local address",
      status: { process: { target_value: "http://127.0.0.1:1/mcp/full" } },
    },
  ])("reconnects a $name runtime using the existing file key", async ({ status }) => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          resource: "https://gateway.example/mcp/full",
          authorization_servers: ["https://issuer.example/"],
        }),
      );
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No local address");
      const fixture = await prepareScriptFixture(address.port, status);
      const result = await runScript(fixture);
      expect(JSON.parse(result.stdout).readyAtLaunch).toBe(true);
      expect(await readCommands()).toEqual(["status", "stop", "connect"]);
      const commandArgs = (await readFile(join(root, "command-args.jsonl"), "utf8"))
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as string[]);
      expect(commandArgs[0]).toEqual(["runtimes", "status", "omnicodex2", "--json"]);
      expect(commandArgs[1]).toEqual(["runtimes", "stop", "omnicodex2", "--json"]);
      expect(commandArgs[2]).toEqual(
        expect.arrayContaining(["--alias", "omnicodex2", "--tunnel-id", "tunnel_fixture"]),
      );
      expect(await readFile(join(root, "roaming", "tunnel-client", "unrelated.yaml"), "utf8")).toBe(
        "unrelated-profile-marker",
      );
      expect(
        await readFile(join(dataDirectory, "tunnel-client-private", "runtime.key"), "utf8"),
      ).toBe("fixture-private-key-content");
      const connectArgs = JSON.parse(
        await readFile(join(root, "connect-args.json"), "utf8"),
      ) as string[];
      expect(connectArgs).toContain(
        `file:${join(dataDirectory, "tunnel-client-private", "runtime.key")}`,
      );
      expect(connectArgs.join(" ")).not.toContain("fixture-private-key-content");
      expect(await readFile(join(root, "connect-path.txt"), "utf8")).not.toContain(
        join(root, "fake-codex"),
      );
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});

function mockChildExit(code: number, stderr = ""): void {
  spawnMock.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stderr: new PassThrough() });
    queueMicrotask(() => {
      child.stderr.write(stderr);
      child.emit("close", code, null);
    });
    return child;
  });
}

async function prepareScriptFixture(
  port: number,
  statusOverrides: Record<string, unknown>,
): Promise<string> {
  await writeFile(profilePath, JSON.stringify({ control_plane: { tunnel_id: "tunnel_fixture" } }));
  await writeFile(
    join(root, "roaming", "tunnel-client", "unrelated.yaml"),
    "unrelated-profile-marker",
  );
  await writeFile(
    join(dataDirectory, "tunnel-client-private", "runtime.key"),
    "fixture-private-key-content",
  );
  await writeFile(
    join(dataDirectory, "state.json"),
    JSON.stringify({
      lifecycle: "ready",
      address: { host: "127.0.0.1", port, fullPath: "/mcp/full" },
    }),
  );
  await writeFile(
    join(root, "status.json"),
    JSON.stringify({
      tunnel_id: "tunnel_fixture",
      healthy: true,
      ready: true,
      process_running: true,
      process: { target_value: `http://127.0.0.1:${port}/mcp/full` },
      ...statusOverrides,
    }),
  );
  const clientPath = join(root, "tunnel-client.ps1");
  await writeFile(
    clientPath,
    `$operation = $args[1]
Add-Content -LiteralPath (Join-Path $env:TUNNEL_TEST_ROOT 'commands.txt') -Value $operation
Add-Content -LiteralPath (Join-Path $env:TUNNEL_TEST_ROOT 'command-args.jsonl') -Value (ConvertTo-Json -Compress -InputObject @($args))
switch ($operation) {
    'status' { Get-Content -LiteralPath (Join-Path $env:TUNNEL_TEST_ROOT 'status.json') -Raw }
    'stop' { '{}' }
    'connect' {
        ConvertTo-Json -InputObject @($args) | Set-Content -LiteralPath (Join-Path $env:TUNNEL_TEST_ROOT 'connect-args.json')
        Set-Content -LiteralPath (Join-Path $env:TUNNEL_TEST_ROOT 'connect-path.txt') -Value $env:PATH
        '{"mode":"native","ready":true,"process":{}}'
    }
    default { throw "Unexpected operation: $operation" }
}
exit 0
`,
  );
  return clientPath;
}

async function writePackagedProfile(): Promise<string> {
  const directory = join(
    root,
    "local",
    "Packages",
    "OpenAI.Codex_2p2nqsd0c76g0",
    "LocalCache",
    "Roaming",
    "tunnel-client",
  );
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "omnicodex2.yaml"), "{}");
  return directory;
}

function runScript(clientPath: string, profileDirectory?: string) {
  return promisify(execFile)(
    powershellExecutable,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-TunnelClientPath",
      clientPath,
      ...(profileDirectory === undefined ? [] : ["-ProfileDirectory", profileDirectory]),
      "-EnsureRunning",
    ],
    {
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        TUNNEL_TEST_ROOT: root,
        PATH: `${join(root, "fake-codex")};${process.env.PATH ?? ""}`,
      },
    },
  );
}

async function readCommands(): Promise<string[]> {
  return (await readFile(join(root, "commands.txt"), "utf8")).trim().split(/\r?\n/u);
}
