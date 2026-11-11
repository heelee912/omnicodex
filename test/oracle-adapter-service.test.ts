import { describe, expect, it, vi } from "vitest";
import { OracleAdapterService } from "../src/application/oracle-adapter-service.js";
import {
  getOracleClientBindings,
  loadOmniCodexConfig,
  type OmniCodexConfig,
  saveOmniCodexConfig,
  selectOracleClientConfig,
  withOracleClientBinding,
} from "../src/infrastructure/config/omnicodex-config-store.js";
import type { OmniCodexFullCatalogSnapshot } from "../src/infrastructure/mcp/omnicodex-mcp-server.js";
import { ChatGptActionCatalogRefreshVerifier } from "../src/infrastructure/operations/chatgpt-action-catalog-refresh-verifier.js";

const base: OmniCodexConfig = {
  schemaVersion: 1,
  projectRoot: "C:\\work",
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
};
const input = {
  connectorId: "connector-1",
  connectorName: "OmniCodex",
  runId: "run-1",
  resource: "https://owner.example/mcp/full",
  surface: "/mcp/full" as const,
  cdpEndpoint: "http://127.0.0.1:9222",
};
const catalogVerification = {
  timestamp: "2026-08-21T00:00:02.000Z",
  correlationId: "catalog-qualification",
  verificationSource: "post_click_mcp_catalog" as const,
  daemonPid: 4242,
  catalogRevision: "d".repeat(64),
  catalogToolCount: 573,
  catalogPageToolCounts: [573],
  catalogToolNamesSha256: "f".repeat(64),
  catalogContractSha256: "0".repeat(64),
  visibleActionToolCount: 573,
  visibleActionNamesSha256: "f".repeat(64),
  actionSchemaHash: "e".repeat(64),
  verifiedActionNames: [
    "codex_app__list_threads",
    "codex_app__read_thread",
    "codex_app__send_message_to_thread",
    "codex_app__wait_threads",
    "codex__functions__exec",
  ],
};
const liveCatalog: OmniCodexFullCatalogSnapshot = {
  catalogRevision: catalogVerification.catalogRevision,
  catalogToolCount: 605,
  catalogPageToolCounts: [605],
  catalogToolNames: ["full-tool"],
  catalogToolNamesSha256: "1".repeat(64),
  catalogIdentitySha256: "2".repeat(64),
  modelToolCount: 0,
  unknownModelEffectCount: 0,
  criticalToolProperties: "input",
  criticalToolRequired: "input",
  criticalToolDescriptionSha256: "3".repeat(64),
  criticalToolInputSchemaSha256: "4".repeat(64),
  chatGptActionToolCount: catalogVerification.catalogToolCount,
  chatGptActionToolNames: [...catalogVerification.verifiedActionNames].sort((left, right) =>
    left.localeCompare(right, "en"),
  ),
  chatGptActionToolNamesSha256: catalogVerification.catalogToolNamesSha256,
  chatGptActionContractSha256: catalogVerification.catalogContractSha256,
  chatGptCriticalToolName: "call_native_tool",
  chatGptCriticalToolProperties: "input,name",
  chatGptCriticalToolRequired: "",
  chatGptCriticalToolDescriptionSha256: "5".repeat(64),
  chatGptCriticalToolInputSchemaSha256: "6".repeat(64),
};
describe("OracleAdapterService", () => {
  it.each(["rebind", "disable", "newer-receipt"] as const)(
    "does not overwrite a concurrent %s after action-refresh validation but before persistence",
    async (change) => {
      let config = withOracleClientBinding(base, "web", {
        enabled: true,
        ...input,
        freshLiveVerification: "pending",
      });
      config = withOracleClientBinding(config, "desktop", {
        enabled: true,
        ...input,
        connectorId: "desktop-original",
        freshLiveVerification: "pending",
      });
      const webBefore = getOracleClientBindings(config.oracle).web;
      let reads = 0;
      let concurrentState: OmniCodexConfig | undefined;
      const save = vi.fn(async (next: OmniCodexConfig) => {
        config = structuredClone(next);
      });
      const service = new OracleAdapterService({
        clientBinding: "desktop",
        load: async () => {
          const snapshot = structuredClone(config);
          reads += 1;
          if (reads === 2) {
            const binding = getOracleClientBindings(config.oracle).desktop;
            if (binding === undefined) throw new Error("Test desktop binding missing");
            config = withOracleClientBinding(config, "desktop", {
              ...binding,
              ...(change === "rebind" ? { connectorId: "desktop-replacement" } : {}),
              ...(change === "disable" ? { enabled: false } : {}),
              ...(change === "newer-receipt"
                ? { lastActionCatalogVerification: catalogVerification }
                : {}),
            });
            concurrentState = structuredClone(config);
          }
          return snapshot;
        },
        save,
      });
      const verify = vi
        .spyOn(ChatGptActionCatalogRefreshVerifier.prototype, "verifyControlPlane")
        .mockResolvedValue(actionRefreshResult());
      try {
        await expect(service.refreshActionsControlPlane({} as never)).rejects.toThrow(
          "ORACLE_BINDING_CHANGED_BEFORE_PERSIST",
        );
      } finally {
        verify.mockRestore();
      }
      expect(save).not.toHaveBeenCalled();
      expect(config).toEqual(concurrentState);
      expect(getOracleClientBindings(config.oracle).web).toEqual(webBefore);
    },
  );

  it("merges independent CLI processes into the same persisted client-binding set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnicodex-client-bindings-"));
    const configPath = join(directory, "config.json");
    const moduleUrl = new URL("../src/application/oracle-adapter-service.ts", import.meta.url).href;
    const script = `import { OracleAdapterService } from ${JSON.stringify(moduleUrl)};
      const service = new OracleAdapterService({configPath: process.argv[1], clientBinding: process.argv[2]});
      await service.setup({...${JSON.stringify(input)}, connectorId: process.argv[3], actionVersionId: process.argv[4]}, true);`;
    try {
      await saveOmniCodexConfig(base, configPath);
      await Promise.all([
        promisify(execFile)(process.execPath, [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          script,
          configPath,
          "web",
          "host-web",
          "web-v1",
        ]),
        promisify(execFile)(process.execPath, [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          script,
          configPath,
          "desktop",
          "host-desktop",
          "desktop-v2",
        ]),
      ]);
      const config = await loadOmniCodexConfig(configPath);
      expect(config.oracle?.connectorId).toBe("host-web");
      expect(getOracleClientBindings(config.oracle).web).toMatchObject({
        connectorId: "host-web",
        actionVersionId: "web-v1",
      });
      expect(getOracleClientBindings(config.oracle).desktop).toMatchObject({
        connectorId: "host-desktop",
        actionVersionId: "desktop-v2",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refreshes concurrent clients using their own IDs and persists separate catalog receipts", async () => {
    let config = withOracleClientBinding(base, "web", {
      enabled: true,
      ...input,
      actionVersionId: "web-version",
      freshLiveVerification: "pending",
    });
    config = withOracleClientBinding(config, "desktop", {
      enabled: true,
      ...input,
      connectorId: "desktop-id",
      actionVersionId: "desktop-version",
      freshLiveVerification: "pending",
    });
    const ports = {
      load: async () => structuredClone(config),
      save: async (next: OmniCodexConfig) => {
        await Promise.resolve();
        config = structuredClone(next);
      },
    };
    const web = new OracleAdapterService(ports);
    const desktop = new OracleAdapterService({ ...ports, clientBinding: "desktop" });
    const seen: string[] = [];
    const verify = vi
      .spyOn(ChatGptActionCatalogRefreshVerifier.prototype, "verifyControlPlane")
      .mockImplementation(async (_client, binding) => {
        seen.push(binding.appConnectorId);
        const result = actionRefreshResult();
        return {
          ...result,
          stateHash: (binding.appConnectorId === "desktop-id" ? "a" : "b").repeat(64),
          operationalEvidence: {
            ...result.operationalEvidence,
            catalogRevision: (binding.appConnectorId === "desktop-id" ? "8" : "9").repeat(64),
          },
        };
      });
    try {
      await Promise.all([
        web.refreshActionsControlPlane({} as never, { correlationId: "web-refresh" }),
        desktop.refreshActionsControlPlane({} as never, { correlationId: "desktop-refresh" }),
      ]);
    } finally {
      verify.mockRestore();
    }
    expect(seen.sort()).toEqual([input.connectorId, "desktop-id"].sort());
    const bindings = getOracleClientBindings(config.oracle);
    expect(bindings.web).toMatchObject({
      connectorId: input.connectorId,
      actionVersionId: "web-version",
      freshLiveVerification: "verified",
      lastActionCatalogVerification: {
        correlationId: "web-refresh",
        catalogRevision: "9".repeat(64),
      },
    });
    expect(bindings.desktop).toMatchObject({
      connectorId: "desktop-id",
      actionVersionId: "desktop-version",
      freshLiveVerification: "verified",
      lastActionCatalogVerification: {
        correlationId: "desktop-refresh",
        catalogRevision: "8".repeat(64),
      },
    });
    await desktop.setup(
      { ...input, connectorId: "desktop-id", actionVersionId: "desktop-next-version" },
      true,
    );
    expect(getOracleClientBindings(config.oracle).web).toEqual(bindings.web);
    expect(getOracleClientBindings(config.oracle).desktop?.freshLiveVerification).toBe("pending");
    expect(
      getOracleClientBindings(config.oracle).desktop?.lastActionCatalogVerification,
    ).toBeUndefined();
  });

  it("keeps simultaneous host-issued Web and desktop bindings independent during setup and disable", async () => {
    let config = structuredClone(base);
    const ports = {
      load: async () => structuredClone(config),
      save: async (next: OmniCodexConfig) => {
        await Promise.resolve();
        config = structuredClone(next);
      },
    };
    const web = new OracleAdapterService(ports);
    const desktop = new OracleAdapterService({ ...ports, clientBinding: "desktop" });
    await Promise.all([
      web.setup({ ...input, actionVersionId: "host-web-v1" }, true),
      desktop.setup(
        { ...input, connectorId: "host-desktop-id", actionVersionId: "host-desktop-v7" },
        true,
      ),
    ]);
    const beforeWeb = structuredClone(getOracleClientBindings(config.oracle).web);
    expect(config.oracle?.connectorId).toBe(input.connectorId);
    expect(getOracleClientBindings(config.oracle).desktop).toMatchObject({
      connectorId: "host-desktop-id",
      actionVersionId: "host-desktop-v7",
      freshLiveVerification: "pending",
    });
    await desktop.setup({ ...input, connectorId: "host-desktop-id" }, true);
    expect(getOracleClientBindings(config.oracle).desktop?.actionVersionId).toBe("host-desktop-v7");
    await desktop.disable(true);
    expect(getOracleClientBindings(config.oracle).web).toEqual(beforeWeb);
    expect((await desktop.status()).enabled).toBe(false);
    expect((await web.status()).enabled).toBe(true);
  });

  it("does not borrow Web verification to qualify a desktop registration or stale endpoint", async () => {
    const qualified = {
      enabled: true,
      ...input,
      freshLiveVerification: "verified" as const,
      lastStateVerification: {
        timestamp: "2026-08-21T00:00:01.000Z",
        correlationId: "web-proof",
        connected: true as const,
        fullAccess: true as const,
        stateHash: "c".repeat(64),
      },
      lastActionCatalogVerification: catalogVerification,
    };
    let config = withOracleClientBinding(base, "web", qualified);
    const webBefore = structuredClone(getOracleClientBindings(config.oracle).web);
    const ports = {
      load: async () => structuredClone(config),
      save: async (next: OmniCodexConfig) => {
        config = next;
      },
    };
    const desktop = new OracleAdapterService({ ...ports, clientBinding: "desktop" });
    await desktop.setup({ ...input, connectorId: "desktop-issued" }, true);
    expect(await desktop.status(liveCatalog)).toMatchObject({
      clientBinding: "desktop",
      complete: false,
      catalogActivated: false,
    });
    expect(getOracleClientBindings(config.oracle).web).toEqual(webBefore);
    config = withOracleClientBinding(config, "desktop", {
      ...qualified,
      connectorId: "desktop-issued",
      endpoint: "https://obsolete.example/mcp/full",
    });
    expect(await desktop.status(liveCatalog)).toMatchObject({
      bindingEndpointCurrent: false,
      complete: false,
    });
    expect(selectOracleClientConfig(config, "web").oracle?.connectorId).toBe(input.connectorId);
  });

  it("accepts registration display names while rejecting missing identity and non-full surfaces", async () => {
    const service = new OracleAdapterService({ load: async () => structuredClone(base) });
    await expect(service.setup({ ...input, connectorName: "omnicodex2" })).resolves.toMatchObject({
      oracle: { connectorName: "omnicodex2" },
    });
    for (const field of ["connectorId", "connectorName", "runId"]) {
      await expect(service.setup({ ...input, [field]: " " })).rejects.toThrow(
        "Exact Oracle binding values are required",
      );
    }
    await expect(
      service.setup({ ...input, surface: "/mcp" as unknown as "/mcp/full" }),
    ).rejects.toThrow("full-access surface");
    await expect(
      service.setup({ ...input, resource: "https://owner.example/mcp" }),
    ).rejects.toThrow("/mcp/full");
    await expect(
      service.setup({ ...input, endpoint: "https://owner.example/mcp" }),
    ).rejects.toThrow("/mcp/full");
  });

  it("persists a renamed parallel registration through the real configuration store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnicodex-named-registration-"));
    const configPath = join(directory, "config.json");
    const original = withOracleClientBinding(base, "web", {
      enabled: true,
      ...input,
      freshLiveVerification: "pending",
    });
    try {
      await saveOmniCodexConfig(original, configPath);
      const service = new OracleAdapterService({ clientBinding: "parallel", configPath });
      await service.setup(
        { ...input, connectorId: "asdk_app_parallel", connectorName: "omnicodex2" },
        true,
      );
      const persisted = getOracleClientBindings((await loadOmniCodexConfig(configPath)).oracle);
      expect(persisted.parallel).toMatchObject({
        connectorId: "asdk_app_parallel",
        connectorName: "omnicodex2",
        resource: input.resource,
      });
      expect(persisted.web).toEqual(getOracleClientBindings(original.oracle).web);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stores tunnel identity without an endpoint and keeps readiness distinct from configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnicodex-tunnel-registration-"));
    const configPath = join(directory, "config.json");
    const original = withOracleClientBinding(base, "web", {
      enabled: true,
      ...input,
      freshLiveVerification: "pending",
    });
    const registration = {
      kind: "secure_mcp_tunnel" as const,
      tunnelId: "tunnel_testregistration",
    };
    try {
      await saveOmniCodexConfig(original, configPath);
      const service = new OracleAdapterService({ clientBinding: "parallel", configPath });
      await service.setup({ ...input, connectorName: "omnicodex2", registration }, true);
      const persisted = getOracleClientBindings((await loadOmniCodexConfig(configPath)).oracle);
      expect(persisted.parallel?.registration).toEqual(registration);
      expect(persisted.parallel).not.toHaveProperty("endpoint");
      expect(persisted.web).toEqual(getOracleClientBindings(original.oracle).web);
      expect(await service.status()).toMatchObject({
        bindingEndpointCurrent: null,
        bindingResourceCurrent: true,
        configurationReady: true,
        tunnelLiveReadiness: "unverified",
        complete: false,
      });
      await expect(
        service.setup({ ...input, registration, endpoint: input.resource }),
      ).rejects.toThrow("omit endpoint");
      await expect(
        service.setup({ ...input, registration: { ...registration, tunnelId: " " } }),
      ).rejects.toThrow("Invalid Oracle tunnel registration");
      await service.setup({ ...input }, true);
      const http = getOracleClientBindings((await loadOmniCodexConfig(configPath)).oracle).parallel;
      expect(http?.endpoint).toBe(input.resource);
      expect(http).not.toHaveProperty("registration");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not treat verified action catalog evidence as tunnel live readiness", async () => {
    let config: OmniCodexConfig = {
      ...base,
      oracle: {
        enabled: true,
        ...input,
        registration: { kind: "secure_mcp_tunnel", tunnelId: "tunnel_original" },
        freshLiveVerification: "verified",
        lastStateVerification: {
          timestamp: "2026-08-21T00:00:01.000Z",
          correlationId: "catalog-qualification",
          connected: true,
          fullAccess: true,
          stateHash: "c".repeat(64),
        },
        lastActionCatalogVerification: catalogVerification,
      },
    };
    const service = new OracleAdapterService({
      load: async () => structuredClone(config),
      save: async (next) => {
        config = next;
      },
    });
    expect(await service.status()).toMatchObject({
      catalogActivated: true,
      complete: false,
      tunnelLiveReadiness: "unverified",
    });
    await service.setup(
      { ...input, registration: { kind: "secure_mcp_tunnel", tunnelId: "tunnel_original" } },
      true,
    );
    expect(config.oracle?.freshLiveVerification).toBe("verified");
    await service.setup(
      { ...input, registration: { kind: "secure_mcp_tunnel", tunnelId: "tunnel_changed" } },
      true,
    );
    expect(config.oracle?.freshLiveVerification).toBe("pending");
    expect(config.oracle?.lastActionCatalogVerification).toBeUndefined();
  });

  it("persists only the exact Oracle binding fields", async () => {
    let config = structuredClone(base);
    const service = new OracleAdapterService({
      load: async () => structuredClone(config),
      save: async (next) => {
        config = structuredClone(next);
      },
    });

    await service.setup({ ...input, execute: true } as typeof input, true);

    expect(getOracleClientBindings(config.oracle).web).toEqual({
      enabled: true,
      ...input,
      endpoint: input.resource,
      freshLiveVerification: "pending",
    });
    expect(config.oracle).not.toHaveProperty("execute");
  });

  it("preserves the remote CDP tunnel when the connector binding changes", async () => {
    const remoteCdpTunnel = {
      sshHost: "203.0.113.10",
      sshPort: 22,
      sshUser: "ubuntu",
      identityFile: "C:\\keys\\omnicodex.pem",
      remoteCdpPort: 19222,
    };
    let config: OmniCodexConfig = {
      ...base,
      oracle: {
        enabled: true,
        ...input,
        connectorId: "old-connector",
        remoteCdpTunnel,
        freshLiveVerification: "verified",
        lastReceipts: [],
      },
    };
    const service = new OracleAdapterService({
      load: async () => structuredClone(config),
      save: async (next) => {
        config = structuredClone(next);
      },
    });

    await service.setup({ ...input, connectorId: "new-connector" }, true);

    expect(config.oracle).toMatchObject({
      connectorId: "new-connector",
      remoteCdpTunnel,
      freshLiveVerification: "pending",
    });
    expect(config.oracle?.lastReceipts).toBeUndefined();
  });

  it("requires an explicit transport for a second endpoint and preserves the first binding", async () => {
    const remoteCdpTunnel = {
      sshHost: "oracle.example",
      sshPort: 22,
      sshUser: "ubuntu",
      identityFile: "C:\\keys\\oracle.pem",
      remoteCdpPort: 19222,
    };
    let config: OmniCodexConfig = {
      ...base,
      oracle: { enabled: true, ...input, remoteCdpTunnel, freshLiveVerification: "verified" },
    };
    const service = new OracleAdapterService({
      clientBinding: "second",
      load: async () => structuredClone(config),
      save: async (next) => {
        config = structuredClone(next);
      },
    });
    const second = {
      ...input,
      connectorId: "second-connector",
      cdpEndpoint: "http://127.0.0.1:29223",
    };
    await expect(service.setup(second, true)).rejects.toThrow("ORACLE_CDP_TRANSPORT_REQUIRED");
    expect(getOracleClientBindings(config.oracle).second).toBeUndefined();
    await service.setup(
      { ...second, remoteCdpTunnel: { ...remoteCdpTunnel, remoteCdpPort: 19223 } },
      true,
    );
    const bindings = getOracleClientBindings(config.oracle);
    expect(bindings.web?.remoteCdpTunnel).toEqual(remoteCdpTunnel);
    expect(bindings.second?.remoteCdpTunnel?.remoteCdpPort).toBe(19223);
    expect(bindings.second?.cdpEndpoint).toBe(second.cdpEndpoint);
  });

  it("shares an existing remote transport only when the new binding uses the same endpoint", async () => {
    const remoteCdpTunnel = {
      sshHost: "oracle.example",
      sshPort: 22,
      sshUser: "ubuntu",
      identityFile: "C:\\keys\\oracle.pem",
      remoteCdpPort: 19222,
    };
    let config: OmniCodexConfig = {
      ...base,
      oracle: { enabled: true, ...input, remoteCdpTunnel, freshLiveVerification: "verified" },
    };
    const service = new OracleAdapterService({
      clientBinding: "desktop",
      load: async () => structuredClone(config),
      save: async (next) => {
        config = structuredClone(next);
      },
    });
    await service.setup({ ...input, connectorId: "desktop-connector" }, true);
    expect(getOracleClientBindings(config.oracle).desktop?.remoteCdpTunnel).toEqual(
      remoteCdpTunnel,
    );
  });

  it("explicit direct CDP removes the remote tunnel and its old verification", async () => {
    const remoteCdpTunnel = {
      sshHost: "oracle.example",
      sshPort: 22,
      sshUser: "ubuntu",
      identityFile: "C:\\keys\\oracle.pem",
      remoteCdpPort: 19222,
    };
    let config: OmniCodexConfig = {
      ...base,
      oracle: {
        enabled: true,
        ...input,
        remoteCdpTunnel,
        freshLiveVerification: "verified",
        lastReceipts: [],
      },
    };
    const service = new OracleAdapterService({
      load: async () => structuredClone(config),
      save: async (next) => {
        config = structuredClone(next);
      },
    });
    await service.setup({ ...input, remoteCdpTunnel: null }, true);
    expect(config.oracle?.remoteCdpTunnel).toBeUndefined();
    expect(config.oracle?.freshLiveVerification).toBe("pending");
    expect(config.oracle?.lastReceipts).toBeUndefined();
  });

  it("invalidates verification when only the remote browser port changes", async () => {
    const remoteCdpTunnel = {
      sshHost: "oracle.example",
      sshPort: 22,
      sshUser: "ubuntu",
      identityFile: "C:\\keys\\oracle.pem",
      remoteCdpPort: 19222,
    };
    let config: OmniCodexConfig = {
      ...base,
      oracle: {
        enabled: true,
        ...input,
        remoteCdpTunnel,
        freshLiveVerification: "verified",
        lastReceipts: [],
      },
    };
    const service = new OracleAdapterService({
      load: async () => structuredClone(config),
      save: async (next) => {
        config = structuredClone(next);
      },
    });
    await service.setup(
      { ...input, remoteCdpTunnel: { ...remoteCdpTunnel, remoteCdpPort: 19223 } },
      true,
    );
    expect(config.oracle?.freshLiveVerification).toBe("pending");
    expect(config.oracle?.lastReceipts).toBeUndefined();
    expect(config.oracle?.remoteCdpTunnel?.remoteCdpPort).toBe(19223);
  });

  it("defaults setup to dry-run, persists atomically through the config port, and reads status", async () => {
    let config = structuredClone(base);
    const save = vi.fn(async (value: OmniCodexConfig) => {
      config = structuredClone(value);
    });
    const service = new OracleAdapterService({ load: async () => structuredClone(config), save });
    expect((await service.setup(input)).executed).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect((await service.setup(input, true)).executed).toBe(true);
    expect(await service.status()).toMatchObject({
      enabled: true,
      complete: false,
      cdpEndpointValid: true,
      freshLiveVerification: "pending",
      catalogActivated: false,
      lastReceipts: [],
    });
  });
  it("preserves real click receipts when only the run correlation changes", async () => {
    const receipts = (["connect", "always_allow"] as const).map((action, index) => ({
      timestamp: "2026-08-21T00:00:00.000Z",
      action,
      consentStrength: index === 0 ? ("connection" as const) : ("full_access" as const),
      evidenceSource: "settings_reconcile" as const,
      correlationId: "prior-run",
      beforeStateHash: "a".repeat(64),
      afterStateHash: "b".repeat(64),
    }));
    let config: OmniCodexConfig = {
      ...base,
      oracle: {
        enabled: true,
        ...input,
        freshLiveVerification: "verified",
        lastReceipts: receipts,
        lastStateVerification: {
          timestamp: "2026-08-21T00:00:01.000Z",
          correlationId: "prior-run",
          connected: true,
          fullAccess: true,
          stateHash: "c".repeat(64),
        },
        lastActionCatalogVerification: catalogVerification,
      },
    };
    const service = new OracleAdapterService({
      load: async () => structuredClone(config),
      save: async (next) => {
        config = structuredClone(next);
      },
    });

    await service.setup({ ...input, runId: "next-run" }, true);

    expect(config.oracle).toMatchObject({
      runId: "next-run",
      freshLiveVerification: "verified",
      lastReceipts: receipts,
      lastActionCatalogVerification: catalogVerification,
    });
    expect(config.oracle?.lastStateVerification?.stateHash).toBe("c".repeat(64));
  });

  it("accepts a tool result after the exact connector was already fully qualified", async () => {
    let config: OmniCodexConfig = {
      ...base,
      oracle: {
        enabled: true,
        ...input,
        freshLiveVerification: "verified",
        lastActionCatalogVerification: catalogVerification,
        lastReceipts: (["connect", "always_allow"] as const).map((action, index) => ({
          timestamp: "2026-08-21T00:00:00.000Z",
          action,
          consentStrength: index === 0 ? ("connection" as const) : ("full_access" as const),
          evidenceSource: "settings_reconcile" as const,
          correlationId: "settings-qualification",
          beforeStateHash: "a".repeat(64),
          afterStateHash: "b".repeat(64),
        })),
      },
    };
    const service = new OracleAdapterService({
      load: async () => structuredClone(config),
      save: async (next) => {
        config = structuredClone(next);
      },
    });
    const result = await service.test(
      {
        snapshot: async () => ({
          appConnectorId: input.connectorId,
          appName: input.connectorName,
          oracleRunId: "fresh-run",
          sessionId: "fresh-run",
          correlationId: "fresh-run",
          mcpServerResource: input.resource,
          mcpSurface: input.surface,
          domRevision: "result",
          connected: true,
          alwaysAllowed: true,
          toolResultPresent: true,
          nodes: [],
        }),
        activate: async () => {
          throw new Error("no consent control expected after full qualification");
        },
      },
      true,
      { runId: "fresh-run", sessionId: "fresh-run", correlationId: "fresh-run" },
    );
    expect(result).toEqual({ state: "tool_result", receipts: [] });
    expect(config.oracle?.freshLiveVerification).toBe("verified");
  });
  it("marks the connector verified only after persisting exact post-click catalog evidence", async () => {
    let config: OmniCodexConfig = {
      ...base,
      oracle: {
        enabled: true,
        ...input,
        freshLiveVerification: "pending",
      },
    };
    const service = new OracleAdapterService({
      load: async () => structuredClone(config),
      save: async (next) => {
        config = structuredClone(next);
      },
    });
    const refreshResult = actionRefreshResult();
    const verify = vi
      .spyOn(ChatGptActionCatalogRefreshVerifier.prototype, "verify")
      .mockResolvedValue(refreshResult);

    await expect(
      service.refreshActions({} as never, { correlationId: "refresh-corr" }),
    ).resolves.toBe(refreshResult);

    expect(verify).toHaveBeenCalledOnce();
    expect(config.oracle).toMatchObject({
      freshLiveVerification: "verified",
      lastStateVerification: {
        correlationId: "refresh-corr",
        connected: true,
        fullAccess: true,
        stateHash: "f".repeat(64),
      },
      lastActionCatalogVerification: {
        correlationId: "refresh-corr",
        verificationSource: "post_click_mcp_catalog",
        daemonPid: 4242,
        catalogRevision: "d".repeat(64),
        catalogToolCount: 573,
        catalogPageToolCounts: [573],
        catalogToolNamesSha256: "f".repeat(64),
        visibleActionToolCount: 573,
        visibleActionNamesSha256: "f".repeat(64),
        actionSchemaHash: "e".repeat(64),
        verifiedActionNames: catalogVerification.verifiedActionNames,
      },
    });
    await expect(service.status()).resolves.toMatchObject({
      complete: true,
      freshLiveVerification: "verified",
      catalogActivated: true,
    });
  });
  it("does not report a stored action snapshot as active for a changed live catalog", async () => {
    const config: OmniCodexConfig = {
      ...base,
      oracle: {
        enabled: true,
        ...input,
        freshLiveVerification: "verified",
        lastStateVerification: {
          timestamp: "2026-08-21T00:00:01.000Z",
          correlationId: "catalog-qualification",
          connected: true,
          fullAccess: true,
          stateHash: "c".repeat(64),
        },
        lastActionCatalogVerification: catalogVerification,
      },
    };
    const service = new OracleAdapterService({ load: async () => structuredClone(config) });

    await expect(service.status(liveCatalog)).resolves.toMatchObject({
      complete: true,
      catalogActivated: true,
      storedCatalogActivated: true,
      freshLiveVerification: "verified",
    });
    await expect(
      service.status({
        ...liveCatalog,
        catalogRevision: "9".repeat(64),
        catalogToolCount: liveCatalog.catalogToolCount + 1,
        catalogToolNames: [...liveCatalog.catalogToolNames, "new_dynamic_native_tool"],
        catalogToolNamesSha256: "8".repeat(64),
        catalogIdentitySha256: "7".repeat(64),
      }),
    ).resolves.toMatchObject({
      complete: true,
      catalogActivated: true,
      storedCatalogActivated: true,
      freshLiveVerification: "verified",
      liveCatalogRevision: "9".repeat(64),
    });
    await expect(
      service.status({
        ...liveCatalog,
        catalogRevision: "8".repeat(64),
        chatGptActionToolCount: liveCatalog.chatGptActionToolCount - 1,
      }),
    ).resolves.toMatchObject({
      complete: false,
      catalogActivated: false,
      storedCatalogActivated: true,
      freshLiveVerification: "pending",
      liveCatalogRevision: "8".repeat(64),
      liveActionToolCount: liveCatalog.chatGptActionToolCount - 1,
    });
  });
  it("dry-run validates the exact candidate without clicking", async () => {
    let config: OmniCodexConfig = {
      ...base,
      oracle: { enabled: true, ...input, freshLiveVerification: "pending" },
    };
    const activate = vi.fn();
    const service = new OracleAdapterService({
      load: async () => config,
      save: async (c) => {
        config = c;
      },
    });
    const result = await service.test(
      {
        snapshot: async () => ({
          ...{
            appConnectorId: input.connectorId,
            appName: input.connectorName,
            oracleRunId: input.runId,
            sessionId: "session",
            correlationId: "corr",
            mcpServerResource: input.resource,
            mcpSurface: input.surface,
          },
          domRevision: "d",
          connected: false,
          alwaysAllowed: false,
          toolResultPresent: false,
          nodes: [{ ref: "x", role: "button", name: "Connect", exactAppScope: true }],
        }),
        activate,
      },
      false,
      { sessionId: "session", correlationId: "corr" },
    );
    expect(result.state).toBe("dry_run");
    expect(activate).not.toHaveBeenCalled();
  });
  it("persists the bounded Connect and Always allow receipt set", async () => {
    let config: OmniCodexConfig = {
      ...base,
      oracle: { enabled: true, ...input, freshLiveVerification: "pending" },
    };
    let step = 0;
    const binding = {
      appConnectorId: input.connectorId,
      appName: input.connectorName,
      oracleRunId: input.runId,
      sessionId: "session",
      correlationId: "corr",
      mcpServerResource: input.resource,
      mcpSurface: input.surface,
    };
    const service = new OracleAdapterService({
      load: async () => structuredClone(config),
      save: async (next) => {
        config = structuredClone(next);
      },
    });
    await service.test(
      {
        snapshot: async () => ({
          ...binding,
          domRevision: `d${step}`,
          connected: step > 0,
          alwaysAllowed: step > 1,
          toolResultPresent: step > 1,
          nodes:
            step === 0
              ? [{ ref: "connect", role: "button", name: "Connect", exactAppScope: true }]
              : step === 1
                ? [
                    {
                      ref: "always",
                      role: "button",
                      name: "Always allow",
                      exactAppScope: true,
                    },
                  ]
                : [],
        }),
        activate: async () => {
          step += 1;
          if (step === 2 && config.gateway !== undefined) {
            config = { ...config, gateway: { ...config.gateway, port: 9999 } };
          }
        },
      },
      true,
      { sessionId: "session", correlationId: "corr" },
    );
    expect(config.oracle?.freshLiveVerification).toBe("pending");
    expect(config.oracle?.lastReceipts?.map((receipt) => receipt.action)).toEqual([
      "connect",
      "always_allow",
    ]);
    expect(config.oracle?.lastReceipts?.map((receipt) => receipt.consentStrength)).toEqual([
      "connection",
      "persistent",
    ]);
    expect(config.gateway?.port).toBe(9999);
  });
  it("rejects consent receipts correlated to a different browser session", async () => {
    let config: OmniCodexConfig = {
      ...base,
      oracle: {
        enabled: true,
        ...input,
        freshLiveVerification: "pending",
        lastReceipts: (["connect", "always_allow"] as const).map((action, index) => ({
          timestamp: "2026-08-21T00:00:00.000Z",
          action,
          consentStrength: index === 0 ? ("connection" as const) : ("full_access" as const),
          evidenceSource: "settings_reconcile" as const,
          correlationId: "different-run",
          beforeStateHash: "a".repeat(64),
          afterStateHash: "b".repeat(64),
        })),
      },
    };
    const service = new OracleAdapterService({
      load: async () => structuredClone(config),
      save: async (next) => {
        config = structuredClone(next);
      },
    });
    await expect(
      service.test(
        {
          snapshot: async () => ({
            appConnectorId: input.connectorId,
            appName: input.connectorName,
            oracleRunId: input.runId,
            sessionId: "session",
            correlationId: "exact-run",
            mcpServerResource: input.resource,
            mcpSurface: input.surface,
            domRevision: "result",
            connected: true,
            alwaysAllowed: true,
            toolResultPresent: true,
            nodes: [],
          }),
          activate: async () => {
            throw new Error("no consent control expected");
          },
        },
        true,
        { sessionId: "session", correlationId: "exact-run" },
      ),
    ).rejects.toThrow("ORACLE_REQUIRED_CONSENT_SEQUENCE_NOT_OBSERVED");
    expect(config.oracle?.freshLiveVerification).toBe("pending");
  });
  it("fails closed if the exact Oracle binding changes during the watch", async () => {
    let config: OmniCodexConfig = {
      ...base,
      oracle: { enabled: true, ...input, freshLiveVerification: "pending" },
    };
    let step = 0;
    const binding = {
      appConnectorId: input.connectorId,
      appName: input.connectorName,
      oracleRunId: input.runId,
      sessionId: "session",
      correlationId: "corr",
      mcpServerResource: input.resource,
      mcpSurface: input.surface,
    };
    const service = new OracleAdapterService({
      load: async () => structuredClone(config),
      save: async (next) => {
        config = structuredClone(next);
      },
    });
    await expect(
      service.test(
        {
          snapshot: async () => ({
            ...binding,
            domRevision: `d${step}`,
            connected: step > 0,
            alwaysAllowed: step > 1,
            toolResultPresent: step > 1,
            nodes:
              step === 0
                ? [{ ref: "connect", role: "button", name: "Connect", exactAppScope: true }]
                : step === 1
                  ? [
                      {
                        ref: "always",
                        role: "button",
                        name: "Always allow",
                        exactAppScope: true,
                      },
                    ]
                  : [],
          }),
          activate: async () => {
            step += 1;
            if (step === 2 && config.oracle !== undefined) {
              config = { ...config, oracle: { ...config.oracle, runId: "replacement-run" } };
            }
          },
        },
        true,
        { sessionId: "session", correlationId: "corr" },
      ),
    ).rejects.toThrow("ORACLE_BINDING_CHANGED_DURING_WATCH");
    expect(config.oracle?.runId).toBe("replacement-run");
    expect(config.oracle?.freshLiveVerification).toBe("pending");
  });
  it.each([
    {
      label: "Connect only",
      node: { ref: "connect", role: "button", name: "Connect", exactAppScope: true },
      connectedAfter: true,
      alwaysAllowedAfter: true,
    },
    {
      label: "Always allow only",
      node: { ref: "always", role: "button", name: "Always allow", exactAppScope: true },
      connectedAfter: true,
      alwaysAllowedAfter: true,
    },
  ])(
    "does not claim full verification from $label",
    async ({ node, connectedAfter, alwaysAllowedAfter }) => {
      let config: OmniCodexConfig = {
        ...base,
        oracle: { enabled: true, ...input, freshLiveVerification: "pending" },
      };
      let activated = false;
      const binding = {
        appConnectorId: input.connectorId,
        appName: input.connectorName,
        oracleRunId: input.runId,
        sessionId: "session",
        correlationId: "corr",
        mcpServerResource: input.resource,
        mcpSurface: input.surface,
      };
      const service = new OracleAdapterService({
        load: async () => structuredClone(config),
        save: async (next) => {
          config = structuredClone(next);
        },
      });

      await expect(
        service.test(
          {
            snapshot: async () => ({
              ...binding,
              domRevision: activated ? "after" : "before",
              connected: activated ? connectedAfter : node.name !== "Connect",
              alwaysAllowed: activated ? alwaysAllowedAfter : false,
              toolResultPresent: activated,
              nodes: activated ? [] : [node],
            }),
            activate: async () => {
              activated = true;
            },
          },
          true,
          { sessionId: "session", correlationId: "corr" },
        ),
      ).rejects.toThrow("ORACLE_REQUIRED_CONSENT_SEQUENCE_NOT_OBSERVED");
      expect(config.oracle?.freshLiveVerification).toBe("pending");
      expect(config.oracle?.lastReceipts).toBeUndefined();
    },
  );
  it("does not claim full verification from a low-risk-only persistent choice", async () => {
    let config: OmniCodexConfig = {
      ...base,
      oracle: { enabled: true, ...input, freshLiveVerification: "pending" },
    };
    let activated = false;
    const binding = {
      appConnectorId: input.connectorId,
      appName: input.connectorName,
      oracleRunId: input.runId,
      sessionId: "session",
      correlationId: "corr",
      mcpServerResource: input.resource,
      mcpSurface: input.surface,
    };
    const service = new OracleAdapterService({
      load: async () => structuredClone(config),
      save: async (next) => {
        config = structuredClone(next);
      },
    });
    await expect(
      service.test(
        {
          snapshot: async () => ({
            ...binding,
            domRevision: activated ? "after" : "before",
            connected: activated,
            alwaysAllowed: activated,
            toolResultPresent: activated,
            nodes: activated
              ? []
              : [
                  {
                    ref: "low",
                    role: "button",
                    name: "저위험 액션 허용",
                    exactAppScope: true,
                  },
                ],
          }),
          activate: async () => {
            activated = true;
          },
        },
        true,
        { sessionId: "session", correlationId: "corr" },
      ),
    ).rejects.toThrow("CONSENT_CONTROL_MISSING");
    expect(config.oracle?.freshLiveVerification).toBe("pending");
  });
  it("disable mutates only the adapter flag and preserves its binding and all other config", async () => {
    let config: OmniCodexConfig = {
      ...base,
      oracle: { enabled: true, ...input, freshLiveVerification: "pending" },
    };
    const before = structuredClone(config);
    const service = new OracleAdapterService({
      load: async () => structuredClone(config),
      save: async (c) => {
        config = structuredClone(c);
      },
    });
    await service.disable(true);
    expect(getOracleClientBindings(config.oracle).web).toEqual({
      ...before.oracle,
      endpoint: input.resource,
      enabled: false,
    });
    expect({ ...config, oracle: undefined }).toEqual({ ...before, oracle: undefined });
  });
});

function actionRefreshResult() {
  return {
    state: "refreshed" as const,
    connected: true as const,
    fullAccess: true as const,
    resourceMatched: true as const,
    connectorMatched: true as const,
    stateHash: "f".repeat(64),
    actionSchemaHash: "e".repeat(64),
    verifiedSchemas: [],
    verifiedActionNames: catalogVerification.verifiedActionNames,
    actionSnapshotEvidence: {
      source: "chatgpt_ui" as const,
      state: "persisted" as const,
      targetId: "asdk-target",
      refreshedFromDomRevision: "dom-before",
      persistedDomRevision: "dom-after",
      visibleActionToolCount: 573,
      visibleActionNamesSha256: "f".repeat(64),
      verifiedActionNames: catalogVerification.verifiedActionNames,
      completedSteps: ["review", "enable", "apply", "save"] as const,
    },
    verificationSource: "post_click_mcp_catalog" as const,
    operationalEvidence: {
      source: "post_click_mcp_catalog" as const,
      daemonPid: 4242,
      correlationId: "refresh-corr",
      catalogRevision: "d".repeat(64),
      catalogToolCount: 573,
      catalogPageToolCounts: [573],
      catalogToolNamesSha256: "f".repeat(64),
      actionContractSha256: "0".repeat(64),
      criticalToolInputSchemaSha256: "a".repeat(64),
      criticalToolDescriptionSha256: "b".repeat(64),
      expectedLocalInputSchemaSha256: "a".repeat(64),
    },
  };
}

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
