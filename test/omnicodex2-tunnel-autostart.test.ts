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

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("../src/infrastructure/windows/hidden-child-process.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  spawnHidden: spawnMock,
}));

import { ensureConfiguredOmniCodex2Tunnel } from "../src/cli.js";

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
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("configured omnicodex2 scheduled startup", () => {
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
        stdio: ["ignore", "ignore", "pipe"],
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

  it("records the actual failure while allowing daemon supervision to continue", async () => {
    await writeFile(profilePath, "{}");
    mockChildExit(1, "Required runtime file is missing: tunnel-client.exe");
    await expect(ensureConfiguredOmniCodex2Tunnel()).resolves.toBeUndefined();
    const entry = JSON.parse(await readFile(join(dataDirectory, "operations.jsonl"), "utf8"));
    expect(entry.event).toBe("external_tunnel_start_failed");
    expect(entry.details).toEqual({
      alias: "omnicodex2",
      source: "scheduled-task",
      error:
        "omnicodex2 tunnel startup failed (exit 1, signal null): Required runtime file is missing: tunnel-client.exe",
    });
    const cliSource = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
    const supervisor = cliSource.slice(
      cliSource.indexOf("async function superviseScheduledTaskDaemon("),
    );
    expect(supervisor.indexOf("await ensureConfiguredOmniCodex2Tunnel();")).toBeLessThan(
      supervisor.indexOf("await waitForExactDaemonProcessExit(state);"),
    );
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
    expect(entry.details.error).toBe("spawn powershell.exe ENOENT");
  });
});

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
