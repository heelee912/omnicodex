import { describe, expect, it, vi } from "vitest";
import { OracleAdapterService } from "../src/application/oracle-adapter-service.js";
import type { OmniCodexConfig } from "../src/infrastructure/config/omnicodex-config-store.js";

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
  resource: "https://owner.example/mcp",
  surface: "/mcp/full" as const,
  cdpEndpoint: "http://127.0.0.1:9222",
};
describe("OracleAdapterService", () => {
  it("persists only the exact Oracle binding fields", async () => {
    let config = structuredClone(base);
    const service = new OracleAdapterService({
      load: async () => structuredClone(config),
      save: async (next) => {
        config = structuredClone(next);
      },
    });

    await service.setup({ ...input, execute: true } as typeof input, true);

    expect(config.oracle).toEqual({
      enabled: true,
      ...input,
      freshLiveVerification: "pending",
    });
    expect(config.oracle).not.toHaveProperty("execute");
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
      complete: true,
      cdpEndpointValid: true,
      freshLiveVerification: "pending",
      lastReceipts: [],
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
          nodes: [{ ref: "x", role: "button", name: "Connect" }],
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
              ? [{ ref: "connect", role: "button", name: "Connect" }]
              : step === 1
                ? [{ ref: "always", role: "button", name: "Always allow" }]
                : [],
        }),
        activate: async () => {
          step += 1;
        },
      },
      true,
      { sessionId: "session", correlationId: "corr" },
    );
    expect(config.oracle?.freshLiveVerification).toBe("verified");
    expect(config.oracle?.lastReceipts?.map((receipt) => receipt.action)).toEqual([
      "connect",
      "always_allow",
    ]);
  });
  it.each([
    {
      label: "Connect only",
      node: { ref: "connect", role: "button", name: "Connect" },
      connectedAfter: true,
      alwaysAllowedAfter: true,
    },
    {
      label: "Always allow only",
      node: { ref: "always", role: "button", name: "Always allow" },
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
    expect(config.oracle).toEqual({ ...before.oracle, enabled: false });
    expect({ ...config, oracle: undefined }).toEqual({ ...before, oracle: undefined });
  });
});
