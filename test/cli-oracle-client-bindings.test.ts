import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  getOracleClientBindings,
  loadOmniCodexConfig,
  saveOmniCodexConfig,
} from "../src/infrastructure/config/omnicodex-config-store.js";

it("routes CLI setup, status and disable to one client without replacing its peer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-cli-bindings-"));
  const configPath = join(directory, "config.json");
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const run = async (...args: string[]) => {
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", cli, ...args], {
      env: { ...process.env, OMNICODEX_DATA_DIR: directory },
      windowsHide: true,
    });
    return JSON.parse(result.stdout);
  };
  try {
    await saveOmniCodexConfig(
      {
        schemaVersion: 1,
        projectRoot: directory,
        gateway: {
          host: "127.0.0.1",
          port: 8787,
          path: "/mcp",
          fullPath: "/mcp/full",
          allowedOrigins: [],
        },
        auth: {
          issuer: "https://issuer.example/",
          audience: "https://owner.example",
          requiredScopes: ["omnicodex:full"],
          allowedSubjects: ["owner"],
        },
      },
      configPath,
    );
    await Promise.all(
      ["web", "desktop"].map((key) =>
        run(
          "oracle",
          "setup",
          "--client-binding",
          key,
          "--connector-id",
          `asdk_app_${key}`,
          "--connector-name",
          "OmniCodex",
          "--run-id",
          `run-${key}`,
          "--resource",
          "https://owner.example/mcp/full",
          "--surface",
          "/mcp/full",
          "--cdp-endpoint",
          "http://127.0.0.1:9222",
          "--action-version-id",
          `${key}-version`,
          "--execute",
          "--json",
        ),
      ),
    );
    const desktop = await run("oracle", "status", "--client-binding", "desktop", "--json");
    expect(desktop).toMatchObject({
      clientBinding: "desktop",
      enabled: true,
      daemonLive: false,
      config: { connectorId: "asdk_app_desktop", actionVersionId: "desktop-version" },
    });
    await run("oracle", "disable", "--client-binding", "desktop", "--execute", "--json");
    const bindings = getOracleClientBindings((await loadOmniCodexConfig(configPath)).oracle);
    expect(bindings.desktop).toMatchObject({ enabled: false, connectorId: "asdk_app_desktop" });
    expect(bindings.web).toMatchObject({ enabled: true, connectorId: "asdk_app_web" });

    const setup = (key: string, port: string, ...transport: string[]) =>
      run(
        "oracle",
        "setup",
        "--client-binding",
        key,
        "--connector-id",
        `asdk_app_${key}`,
        "--connector-name",
        "OmniCodex",
        "--run-id",
        `run-${key}`,
        "--resource",
        "https://owner.example/mcp/full",
        "--surface",
        "/mcp/full",
        "--cdp-endpoint",
        `http://127.0.0.1:${port}`,
        ...transport,
        "--execute",
        "--json",
      );
    const remoteArgs = [
      "--ssh-host",
      "oracle.example",
      "--ssh-user",
      "ubuntu",
      "--identity-file",
      join(directory, "existing-key.pem"),
    ];
    // This config-only command does not connect to SSH or read the key file.
    await setup("web", "9222", ...remoteArgs, "--remote-cdp-port", "19222");
    await expect(setup("second", "29223")).rejects.toThrow("ORACLE_CDP_TRANSPORT_REQUIRED");
    await expect(setup("second", "29223", "--ssh-host", "oracle.example")).rejects.toThrow(
      "Remote CDP requires",
    );
    await expect(
      setup("second", "29223", "--direct-cdp", ...remoteArgs, "--remote-cdp-port", "19223"),
    ).rejects.toThrow("--direct-cdp cannot be combined");
    await setup(
      "second",
      "29223",
      ...remoteArgs,
      "--ssh-port",
      "2222",
      "--remote-cdp-port",
      "19223",
    );
    let current = getOracleClientBindings((await loadOmniCodexConfig(configPath)).oracle);
    expect(current.web?.remoteCdpTunnel?.remoteCdpPort).toBe(19222);
    await setup("tunnel", "9222", "--secure-mcp-tunnel-id", "tunnel_testregistration");
    const tunnelConfig = getOracleClientBindings((await loadOmniCodexConfig(configPath)).oracle);
    expect(tunnelConfig.tunnel).toMatchObject({
      registration: { kind: "secure_mcp_tunnel", tunnelId: "tunnel_testregistration" },
    });
    expect(tunnelConfig.tunnel?.endpoint).toBeUndefined();
    expect(tunnelConfig.web?.remoteCdpTunnel?.remoteCdpPort).toBe(19222);
    await expect(
      setup(
        "invalid-tunnel",
        "9222",
        "--secure-mcp-tunnel-id",
        "tunnel_testregistration",
        "--endpoint",
        "https://owner.example/mcp/full",
      ),
    ).rejects.toThrow("--secure-mcp-tunnel-id cannot be combined with --endpoint");
    expect(current.second?.remoteCdpTunnel).toMatchObject({ sshPort: 2222, remoteCdpPort: 19223 });
    expect(current.second?.cdpEndpoint).toBe("http://127.0.0.1:29223");
    await setup("second", "29223", "--direct-cdp");
    current = getOracleClientBindings((await loadOmniCodexConfig(configPath)).oracle);
    expect(current.second?.remoteCdpTunnel).toBeUndefined();
    expect(current.web?.remoteCdpTunnel?.remoteCdpPort).toBe(19222);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
