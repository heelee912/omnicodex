import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadOmniCodexConfig,
  loadOptionalOmniCodexConfig,
  mergeGatewayInitialization,
  type OmniCodexConfig,
  omniCodexDataDirectory,
  readOmniCodexDaemonState,
  saveOmniCodexConfig,
  writeOmniCodexDaemonState,
} from "../src/infrastructure/config/omnicodex-config-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("OmniCodex config store", () => {
  it("round-trips isolated config and daemon state without using LOCALAPPDATA", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = join(directory, "config.json");
    const statePath = join(directory, "state.json");
    const config = validConfig();

    expect(omniCodexDataDirectory({ LOCALAPPDATA: "ignored", OMNICODEX_DATA_DIR: directory })).toBe(
      directory,
    );

    await saveOmniCodexConfig(config, configPath);
    await expect(loadOmniCodexConfig(configPath)).resolves.toEqual(config);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(config);

    const state = {
      schemaVersion: 1 as const,
      lifecycle: "ready" as const,
      pid: 4242,
      instanceNonce: "n".repeat(43),
      startedAtUnixMs: 1,
      updatedAtUnixMs: 2,
      controlPipe: "test-pipe",
      controlToken: "a".repeat(43),
    };
    await writeOmniCodexDaemonState(state, statePath);
    await expect(readOmniCodexDaemonState(statePath)).resolves.toEqual(state);
  });

  it("treats only a missing config as optional and rejects malformed state", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = join(directory, "config.json");
    await expect(loadOptionalOmniCodexConfig(configPath)).resolves.toBeUndefined();

    await writeFile(configPath, "{not-json", "utf8");
    await expect(loadOptionalOmniCodexConfig(configPath)).rejects.toBeInstanceOf(SyntaxError);
  });

  it("fails closed for a non-loopback bind or missing owner subject", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = join(directory, "config.json");

    await expect(
      saveOmniCodexConfig(
        {
          ...validConfig(),
          gateway: { ...validConfig().gateway, host: "0.0.0.0" as "127.0.0.1" },
        },
        configPath,
      ),
    ).rejects.toThrow("127.0.0.1");

    await expect(
      saveOmniCodexConfig(
        {
          ...validConfig(),
          auth: { ...validConfig().auth, allowedSubjects: [] },
        },
        configPath,
      ),
    ).rejects.toThrow("allowed subject");
  });

  it("promotes companion config without losing the Oracle binding", () => {
    const oracle = {
      enabled: true,
      connectorId: "asdk_app_exact",
      connectorName: "OmniCodex",
      runId: "run-exact",
      resource: "https://owner.example/mcp",
      surface: "/mcp" as const,
      cdpEndpoint: "http://127.0.0.1:9222",
      freshLiveVerification: "pending" as const,
    };
    const companion: OmniCodexConfig = {
      schemaVersion: 1,
      companionOnly: true,
      projectRoot: "C:\\work",
      gateway: {
        host: "127.0.0.1",
        port: 8787,
        path: "/mcp",
        fullPath: "/mcp/full",
        allowedOrigins: [],
      },
      auth: { issuer: "", audience: "", requiredScopes: [], allowedSubjects: [] },
      oracle,
    };

    expect(mergeGatewayInitialization(validConfig(), companion)).toEqual({
      ...validConfig(),
      oracle,
    });
  });

  it("preserves tunnel and opaque auth references during gateway reinitialization", () => {
    const existing: OmniCodexConfig = {
      ...validConfig(),
      auth: {
        ...validConfig().auth,
        managementCredentialRef: "wincred:OmniCodex/Auth0/current",
        previousManagementCredentialRef: "wincred:OmniCodex/Auth0/previous",
      },
      tunnel: { kind: "direct", publicUrl: "https://omnicodex.example" },
    };

    expect(mergeGatewayInitialization(validConfig(), existing)).toEqual(existing);
  });

  it("requires a stable tunnel origin that matches the OAuth resource", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = join(directory, "config.json");
    const withTunnel: OmniCodexConfig = {
      ...validConfig(),
      auth: {
        ...validConfig().auth,
        resource: "https://owner.ngrok.app/mcp",
      },
      tunnel: {
        kind: "ngrok",
        executablePath: "C:\\tools\\ngrok.exe",
        publicUrl: "https://owner.ngrok.app",
        credentialRef: "dpapi:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    };
    await saveOmniCodexConfig(withTunnel, configPath);
    await expect(loadOmniCodexConfig(configPath)).resolves.toEqual(withTunnel);

    await expect(
      saveOmniCodexConfig(
        {
          ...withTunnel,
          tunnel: {
            kind: "ngrok",
            executablePath: "C:\\tools\\ngrok.exe",
            publicUrl: "https://other.ngrok.app",
            credentialRef: "dpapi:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          },
        },
        configPath,
      ),
    ).rejects.toThrow("must match");

    await expect(
      saveOmniCodexConfig(
        {
          ...withTunnel,
          tunnel: {
            kind: "ngrok",
            executablePath: "C:\\tools\\ngrok.exe",
            publicUrl: "https://owner.ngrok.app",
            credentialRef: "wincred:legacy",
          },
        },
        configPath,
      ),
    ).rejects.toThrow("CurrentUser DPAPI");
  });

  it.each(["cloudflare", "tailscale"] as const)(
    "accepts %s with an opaque credential reference but no credential material",
    async (kind) => {
      const directory = await makeTemporaryDirectory();
      const configPath = join(directory, "config.json");
      const config: OmniCodexConfig = {
        ...validConfig(),
        auth: { ...validConfig().auth, resource: "https://owner.example/mcp" },
        tunnel: {
          kind,
          executablePath: `C:\\tools\\${kind}.exe`,
          publicUrl: "https://owner.example",
          credentialRef: `wincred:OmniCodex/${kind}`,
        },
      };
      await saveOmniCodexConfig(config, configPath);
      const persisted = await readFile(configPath, "utf8");
      expect(persisted).toContain(`wincred:OmniCodex/${kind}`);
      expect(persisted).not.toContain("token=");
      await expect(loadOmniCodexConfig(configPath)).resolves.toEqual(config);
    },
  );

  it("accepts direct HTTPS ingress without an executable or secret", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = join(directory, "config.json");
    const config: OmniCodexConfig = {
      ...validConfig(),
      auth: { ...validConfig().auth, resource: "https://owner.example/mcp" },
      tunnel: { kind: "direct", publicUrl: "https://owner.example" },
    };
    await saveOmniCodexConfig(config, configPath);
    await expect(loadOmniCodexConfig(configPath)).resolves.toEqual(config);
  });

  it("rejects stale or forged daemon state", async () => {
    const directory = await makeTemporaryDirectory();
    const statePath = join(directory, "state.json");
    await expect(
      writeOmniCodexDaemonState(
        {
          schemaVersion: 1,
          lifecycle: "ready",
          pid: 4242,
          instanceNonce: "short",
          startedAtUnixMs: 1,
          updatedAtUnixMs: 2,
          controlPipe: "test-pipe",
          controlToken: "a".repeat(43),
        },
        statePath,
      ),
    ).rejects.toThrow("Invalid OmniCodex daemon state");
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

function validConfig(): OmniCodexConfig {
  return {
    schemaVersion: 1,
    projectRoot: "C:\\work",
    gateway: {
      host: "127.0.0.1",
      port: 8787,
      path: "/mcp",
      fullPath: "/mcp/full",
      allowedOrigins: ["https://chatgpt.com"],
    },
    auth: {
      issuer: "https://owner.example/",
      audience: "https://omnicodex.example/",
      resource: "https://omnicodex.example/",
      requiredScopes: ["omnicodex:full"],
      allowedSubjects: ["auth0|owner"],
      jwksUri: "https://owner.example/.well-known/jwks.json",
    },
  };
}
