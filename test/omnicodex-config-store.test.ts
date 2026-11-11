import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  daemonControlPipe,
  getOracleClientBindings,
  getOracleRuntimeBinding,
  loadOmniCodexConfig,
  loadOptionalOmniCodexConfig,
  mergeGatewayInitialization,
  type OmniCodexConfig,
  omniCodexDataDirectory,
  readOmniCodexDaemonState,
  saveOmniCodexConfig,
  selectOracleClientConfig,
  withOracleClientBinding,
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
  it("preserves a registration display name without weakening identity or URL validation", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = join(directory, "config.json");
    const binding = {
      enabled: true,
      connectorId: "asdk_app_registration",
      connectorName: "omnicodex2",
      runId: "registration-run",
      resource: "https://owner.example/mcp/full",
      endpoint: "https://registration.example/mcp/full",
      surface: "/mcp/full" as const,
      cdpEndpoint: "http://127.0.0.1:9222",
      freshLiveVerification: "pending" as const,
    };
    const config = withOracleClientBinding(validConfig(), "parallel", binding);
    await saveOmniCodexConfig(config, configPath);
    const recovered = await loadOmniCodexConfig(configPath);
    expect(getOracleClientBindings(recovered.oracle).parallel).toEqual(binding);
    for (const invalid of [
      { connectorName: " " },
      { connectorId: " " },
      { resource: "http://owner.example/mcp/full" },
      { endpoint: "https://user:password@registration.example/mcp/full" },
    ]) {
      await expect(
        saveOmniCodexConfig(
          withOracleClientBinding(validConfig(), "parallel", { ...binding, ...invalid }),
          configPath,
        ),
      ).rejects.toThrow();
    }
    expect(await loadOmniCodexConfig(configPath)).toEqual(recovered);
  });

  it("migrates a persisted singleton to Web without inventing a verified desktop binding", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = join(directory, "config.json");
    const legacy = {
      ...validConfig(),
      oracle: {
        enabled: true,
        connectorId: "host-web-id",
        connectorName: "OmniCodex",
        runId: "web-run",
        resource: "https://owner.example/mcp/full",
        surface: "/mcp/full" as const,
        cdpEndpoint: "http://127.0.0.1:9222",
        freshLiveVerification: "pending" as const,
      },
    };
    await writeFile(configPath, JSON.stringify(legacy), "utf8");
    const migrated = await loadOmniCodexConfig(configPath);
    expect(getOracleClientBindings(migrated.oracle).web).toEqual({
      ...legacy.oracle,
      endpoint: legacy.oracle.resource,
    });
    expect(selectOracleClientConfig(migrated, "desktop").oracle).toBeUndefined();
    const withDesktop = withOracleClientBinding(migrated, "desktop", {
      ...legacy.oracle,
      connectorId: "host-desktop-id",
      endpoint: legacy.oracle.resource,
      actionVersionId: "host-issued-v2",
    });
    await saveOmniCodexConfig(withDesktop, configPath);
    const readback = await loadOmniCodexConfig(configPath);
    expect(readback).toEqual(withDesktop);
    expect(readback.oracle?.connectorId).toBe("host-web-id");
    expect(getOracleClientBindings(readback.oracle).desktop?.connectorId).toBe("host-desktop-id");
  });

  it("preserves endpoint-free tunnel registrations and rejects malformed or conflicting identities", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = join(directory, "config.json");
    const binding = {
      enabled: true,
      connectorId: "host-tunnel-id",
      connectorName: "omnicodex2",
      runId: "tunnel-run",
      resource: "https://owner.example/mcp/full",
      surface: "/mcp/full" as const,
      cdpEndpoint: "http://127.0.0.1:9222",
      freshLiveVerification: "pending" as const,
      registration: { kind: "secure_mcp_tunnel" as const, tunnelId: "tunnel_testregistration" },
    };
    const config = withOracleClientBinding(validConfig(), "tunnel", binding);
    await saveOmniCodexConfig(config, configPath);
    const loaded = await loadOmniCodexConfig(configPath);
    expect(loaded.oracle).not.toHaveProperty("endpoint");
    expect(getOracleClientBindings(loaded.oracle).tunnel).toEqual(binding);
    for (const registration of [
      { kind: "secure_mcp_tunnel", tunnelId: "" },
      { kind: "secure_mcp_tunnel", tunnelId: "https://example.com" },
      { kind: "http", tunnelId: "tunnel_test" },
      { kind: "secure_mcp_tunnel", tunnelId: "tunnel_test", endpoint: binding.resource },
    ]) {
      await expect(
        saveOmniCodexConfig(
          { ...validConfig(), oracle: { ...binding, registration } } as unknown as OmniCodexConfig,
          configPath,
        ),
      ).rejects.toThrow("Invalid Oracle tunnel registration");
    }
    await expect(
      saveOmniCodexConfig(
        { ...validConfig(), oracle: { ...binding, endpoint: binding.resource } },
        configPath,
      ),
    ).rejects.toThrow("omit endpoint");
  });

  it("preserves a desktop-first installation when Web is later registered", () => {
    const desktop = {
      enabled: true,
      connectorId: "desktop-id",
      connectorName: "OmniCodex",
      runId: "desktop-run",
      resource: "https://owner.example/mcp/full",
      surface: "/mcp/full" as const,
      cdpEndpoint: "http://127.0.0.1:9222",
      freshLiveVerification: "pending" as const,
    };
    const initial = withOracleClientBinding(validConfig(), "desktop", desktop);
    expect(selectOracleClientConfig(initial, "web").oracle).toBeUndefined();
    const next = withOracleClientBinding(initial, "web", { ...desktop, connectorId: "web-id" });
    expect(next.oracle?.primaryClientBinding).toBe("web");
    expect(getOracleClientBindings(next.oracle).desktop).toEqual({
      ...desktop,
      endpoint: desktop.resource,
    });
    expect(selectOracleClientConfig(next, "web").oracle?.connectorId).toBe("web-id");
  });

  it("keeps the shared runtime active when only the desktop registration is enabled", () => {
    const binding = {
      enabled: true,
      connectorId: "web-id",
      connectorName: "OmniCodex",
      runId: "run",
      resource: "https://owner.example/mcp/full",
      surface: "/mcp/full" as const,
      cdpEndpoint: "http://127.0.0.1:9222",
      freshLiveVerification: "pending" as const,
    };
    const initial = withOracleClientBinding(
      withOracleClientBinding(validConfig(), "web", { ...binding, enabled: false }),
      "desktop",
      { ...binding, connectorId: "desktop-id" },
    );
    expect(getOracleRuntimeBinding(initial.oracle)?.connectorId).toBe("desktop-id");
    expect(initial.oracle?.connectorId).toBe("web-id");
    expect(initial.oracle?.enabled).toBe(false);
    const enabledWeb = withOracleClientBinding(initial, "web", binding);
    expect(getOracleRuntimeBinding(enabledWeb.oracle)?.connectorId).toBe("web-id");
    const disabled = withOracleClientBinding(initial, "desktop", { ...binding, enabled: false });
    expect(getOracleRuntimeBinding(disabled.oracle)).toBeUndefined();
    expect(getOracleRuntimeBinding(undefined)).toBeUndefined();
  });

  it("updates service resources across bindings without replacing host-issued IDs", () => {
    const resource = "https://old.example/mcp/full";
    const binding = {
      enabled: true,
      connectorId: "web-issued",
      connectorName: "OmniCodex",
      runId: "run",
      resource,
      surface: "/mcp/full" as const,
      cdpEndpoint: "http://127.0.0.1:9222",
      freshLiveVerification: "pending" as const,
    };
    const current = withOracleClientBinding(
      withOracleClientBinding(validConfig(), "web", binding),
      "desktop",
      { ...binding, connectorId: "desktop-issued", actionVersionId: "desktop-v2" },
    );
    const newResource = "https://new.example/mcp/full";
    const next = mergeGatewayInitialization(
      {
        ...validConfig(),
        auth: { ...validConfig().auth, audience: newResource, resource: newResource },
      },
      current,
    );
    expect(getOracleClientBindings(next.oracle).web).toMatchObject({
      connectorId: "web-issued",
      endpoint: newResource,
      resource: newResource,
    });
    expect(getOracleClientBindings(next.oracle).desktop).toMatchObject({
      connectorId: "desktop-issued",
      actionVersionId: "desktop-v2",
      endpoint: newResource,
      resource: newResource,
    });
  });

  it("uses the current Windows known folder only when no data directory is supplied", () => {
    let queries = 0;
    const redirected = "D:\\redirected-owner\\local-data";
    const knownFolder = () => {
      queries += 1;
      return redirected;
    };
    expect(omniCodexDataDirectory({}, knownFolder)).toBe(join(redirected, "OmniCodex"));
    expect(queries).toBe(1);
    expect(omniCodexDataDirectory({ LOCALAPPDATA: "E:\\explicit-local" }, knownFolder)).toBe(
      join("E:\\explicit-local", "OmniCodex"),
    );
    expect(omniCodexDataDirectory({ OMNICODEX_DATA_DIR: tmpdir() }, knownFolder)).toBe(tmpdir());
    expect(queries).toBe(1);
    expect(() =>
      omniCodexDataDirectory({}, () => {
        throw new Error("known folder query failed");
      }),
    ).toThrow("known folder query failed");
  });

  it("isolates authenticated daemon control pipes by data directory", () => {
    const common = { LOCALAPPDATA: "C:\\ignored", USERDOMAIN: "PC", USERNAME: "Owner" };
    const first = daemonControlPipe({ ...common, OMNICODEX_DATA_DIR: "C:\\state\\one" });
    const second = daemonControlPipe({ ...common, OMNICODEX_DATA_DIR: "C:\\state\\two" });
    expect(first).not.toBe(second);
    expect(daemonControlPipe({ ...common, OMNICODEX_DATA_DIR: "C:\\state\\one" })).toBe(first);
  });

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

  it("rejects empty names and non-full Oracle surfaces", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = join(directory, "config.json");
    const oracle = {
      enabled: true,
      connectorId: "asdk_app_exact",
      connectorName: "OmniCodex",
      runId: "run-exact",
      resource: "https://owner.example/mcp/full",
      surface: "/mcp/full" as const,
      cdpEndpoint: "http://127.0.0.1:9222",
      freshLiveVerification: "pending" as const,
    };

    await expect(
      saveOmniCodexConfig(
        { ...validConfig(), oracle: { ...oracle, connectorName: " " } },
        configPath,
      ),
    ).rejects.toThrow("Oracle adapter config");
    await expect(
      saveOmniCodexConfig(
        {
          ...validConfig(),
          oracle: { ...oracle, surface: "/mcp" } as unknown as typeof oracle,
        },
        configPath,
      ),
    ).rejects.toThrow("Oracle adapter config");
    await expect(
      saveOmniCodexConfig(
        { ...validConfig(), oracle: { ...oracle, resource: "https://owner.example/mcp" } },
        configPath,
      ),
    ).rejects.toThrow("Oracle resource");
  });

  it("downgrades legacy connection-only verification until an exact action catalog is proven", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = join(directory, "config.json");
    const legacy: OmniCodexConfig = {
      ...validConfig(),
      oracle: {
        enabled: true,
        connectorId: "asdk_app_exact",
        connectorName: "OmniCodex",
        runId: "legacy-run",
        resource: "https://owner.example/mcp/full",
        surface: "/mcp/full",
        cdpEndpoint: "http://127.0.0.1:9222",
        freshLiveVerification: "verified",
        lastStateVerification: {
          timestamp: "2026-08-21T00:00:00.000Z",
          correlationId: "legacy-run",
          connected: true,
          fullAccess: true,
          stateHash: "a".repeat(64),
        },
      },
    };
    await writeFile(configPath, JSON.stringify(legacy), "utf8");
    const loaded = await loadOmniCodexConfig(configPath);
    expect(loaded.oracle?.freshLiveVerification).toBe("pending");
    expect(loaded.oracle?.lastStateVerification).toEqual(legacy.oracle?.lastStateVerification);
    expect(loaded.oracle?.lastActionCatalogVerification).toBeUndefined();
  });

  it("downgrades a legacy count-only catalog record while retaining it for diagnostics", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = join(directory, "config.json");
    const legacy: OmniCodexConfig = {
      ...validConfig(),
      oracle: {
        enabled: true,
        connectorId: "asdk_app_exact",
        connectorName: "OmniCodex",
        runId: "legacy-catalog-run",
        resource: "https://owner.example/mcp/full",
        surface: "/mcp/full",
        cdpEndpoint: "http://127.0.0.1:9222",
        freshLiveVerification: "verified",
        lastActionCatalogVerification: {
          timestamp: "2026-08-21T00:00:00.000Z",
          correlationId: "legacy-catalog-run",
          verificationSource: "post_click_mcp_catalog",
          daemonPid: 4242,
          catalogRevision: "b".repeat(64),
          catalogToolCount: 573,
          catalogPageToolCounts: [573],
          actionSchemaHash: "c".repeat(64),
          verifiedActionNames: ["codex__functions__exec"],
        },
      },
    };
    await writeFile(configPath, JSON.stringify(legacy), "utf8");

    const loaded = await loadOmniCodexConfig(configPath);

    expect(loaded.oracle?.freshLiveVerification).toBe("pending");
    expect(loaded.oracle?.lastActionCatalogVerification).toEqual(
      legacy.oracle?.lastActionCatalogVerification,
    );
  });

  it("promotes companion config without losing the Oracle binding", () => {
    const oracle = {
      enabled: true,
      connectorId: "asdk_app_exact",
      connectorName: "OmniCodex",
      runId: "run-exact",
      resource: "https://owner.example/mcp/full",
      surface: "/mcp/full" as const,
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

    expect(mergeGatewayInitialization(validConfig(), companion)).toEqual(
      withOracleClientBinding(validConfig(), "web", oracle),
    );
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

  it("does not create HTTP endpoints for primary or parallel secure tunnel registrations on reinitialization", () => {
    const resource = "https://old.example/mcp/full";
    const registration = { kind: "secure_mcp_tunnel" as const, tunnelId: "tunnel_example" };
    const binding = {
      enabled: true,
      connectorId: "asdk_app_tunnel",
      connectorName: "Tunnel",
      runId: "run-tunnel",
      resource,
      registration,
      surface: "/mcp/full" as const,
      cdpEndpoint: "http://127.0.0.1:9222",
      freshLiveVerification: "verified" as const,
    };
    const { registration: _registration, ...httpBinding } = binding;
    const existing: OmniCodexConfig = {
      ...validConfig(),
      oracle: {
        ...binding,
        primaryClientBinding: "tunnel",
        clientBindings: {
          tunnel: binding,
          http: {
            ...httpBinding,
            connectorId: "asdk_app_http",
            endpoint: resource,
          },
        },
      },
    };
    const nextResource = "https://new.example/mcp/full";
    const merged = mergeGatewayInitialization(
      {
        ...validConfig(),
        auth: { ...validConfig().auth, resource: nextResource, audience: nextResource },
      },
      existing,
    );
    const bindings = getOracleClientBindings(merged.oracle);
    expect(merged.oracle?.endpoint).toBeUndefined();
    expect(bindings.tunnel?.endpoint).toBeUndefined();
    expect(bindings.tunnel).toMatchObject({
      registration,
      resource: nextResource,
      freshLiveVerification: "pending",
    });
    expect(bindings.http?.endpoint).toBe(nextResource);
  });

  it("atomically migrates tunnel and Oracle bindings with the protected resource", () => {
    const previousResource = "https://old-omnicodex.example/mcp/full";
    const nextResource = "https://mcp.example/mcp/full";
    const existing: OmniCodexConfig = {
      ...validConfig(),
      auth: {
        ...validConfig().auth,
        audience: previousResource,
        resource: previousResource,
      },
      tunnel: {
        kind: "oracle_ssh",
        executablePath: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
        publicUrl: "https://old-omnicodex.example",
        sshHost: "203.0.113.11",
        sshPort: 22,
        sshUser: "omnicodex-backhaul",
        identityFile: "C:\\keys\\backhaul",
        remotePort: 18766,
      },
      oracle: {
        enabled: true,
        connectorId: "asdk_app_exact",
        connectorName: "OmniCodex",
        runId: "run-exact",
        resource: previousResource,
        surface: "/mcp/full",
        cdpEndpoint: "http://127.0.0.1:9222",
        freshLiveVerification: "pending",
      },
    };
    const next: OmniCodexConfig = {
      ...validConfig(),
      auth: {
        ...validConfig().auth,
        audience: nextResource,
        resource: nextResource,
      },
    };

    expect(mergeGatewayInitialization(next, existing)).toMatchObject({
      auth: { audience: nextResource, resource: nextResource },
      tunnel: {
        kind: "oracle_ssh",
        publicUrl: "https://mcp.example",
        sshHost: "203.0.113.11",
      },
      oracle: { resource: nextResource, connectorId: "asdk_app_exact" },
    });
  });

  it("preserves and validates the explicit training runtime mode", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = join(directory, "config.json");
    const existing: OmniCodexConfig = { ...validConfig(), runtimeMode: "training" };
    const merged = mergeGatewayInitialization(validConfig(), existing);
    expect(merged.runtimeMode).toBe("training");
    await saveOmniCodexConfig(merged, configPath);
    expect((await loadOmniCodexConfig(configPath)).runtimeMode).toBe("training");
    await expect(
      saveOmniCodexConfig(
        { ...merged, runtimeMode: "unsafe" } as unknown as OmniCodexConfig,
        configPath,
      ),
    ).rejects.toThrow("runtime mode");
  });

  it("preserves only an opaque DPAPI internal-integrity reference across reinitialization", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = join(directory, "config.json");
    const integrityMasterKeyRef = `dpapi:v1:${"I".repeat(43)}`;
    const existing: OmniCodexConfig = {
      ...validConfig(),
      internal: { integrityMasterKeyRef },
    };

    const merged = mergeGatewayInitialization(validConfig(), existing);
    expect(merged.internal).toEqual({ integrityMasterKeyRef });
    await saveOmniCodexConfig(merged, configPath);
    expect(JSON.parse(await readFile(configPath, "utf8")).internal).toEqual({
      integrityMasterKeyRef,
    });
    await expect(
      saveOmniCodexConfig(
        {
          ...merged,
          internal: { integrityMasterKeyRef: "plain-text-master-key" },
        },
        configPath,
      ),
    ).rejects.toThrow("internal integrity-key reference");
    await expect(
      saveOmniCodexConfig(
        {
          ...merged,
          internal: {
            integrityMasterKeyRef,
            masterKey: "must-never-be-accepted",
          } as unknown as NonNullable<OmniCodexConfig["internal"]>,
        },
        configPath,
      ),
    ).rejects.toThrow("internal integrity-key reference");
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

  it("accepts only an absolute, dedicated Oracle SSH backhaul", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = join(directory, "config.json");
    const config: OmniCodexConfig = {
      ...validConfig(),
      auth: {
        ...validConfig().auth,
        audience: "https://203.0.113.10/mcp/full",
        resource: "https://203.0.113.10/mcp/full",
      },
      tunnel: {
        kind: "oracle_ssh",
        executablePath: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
        publicUrl: "https://203.0.113.10",
        sshHost: "203.0.113.10",
        sshPort: 22,
        sshUser: "omnicodex-backhaul",
        identityFile: "C:\\owner\\oracle-backhaul-ed25519",
        remotePort: 18766,
      },
    };
    await saveOmniCodexConfig(config, configPath);
    await expect(loadOmniCodexConfig(configPath)).resolves.toEqual(config);
    await expect(
      saveOmniCodexConfig(
        {
          ...config,
          tunnel: { ...config.tunnel, identityFile: "shared.pem" },
        } as OmniCodexConfig,
        configPath,
      ),
    ).rejects.toThrow("identity file");
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
