import { describe, expect, it, vi } from "vitest";
import { ChatAccountRequestCoordinator } from "../src/application/chat-account-request-coordinator.js";
import {
  OracleActionCatalogAutoRefreshCoordinator,
  OracleClientBindingsActionCatalogAutoRefreshCoordinator,
  oracleActionCatalogMatchesBaseline,
  oracleActionCatalogTransportsReady,
  readStableOracleActionCatalogBaseline,
} from "../src/application/oracle-action-catalog-auto-refresh.js";
import { ChatGptControlPlaneHttpError } from "../src/infrastructure/chatgpt/chatgpt-action-catalog-control-client.js";
import {
  getOracleClientBindings,
  type OmniCodexConfig,
  withOracleClientBinding,
} from "../src/infrastructure/config/omnicodex-config-store.js";
import type { OmniCodexFullCatalogSnapshot } from "../src/infrastructure/mcp/omnicodex-mcp-server.js";

const names = ["call_native_tool", "codex__omnicodex__session_identity"];
const baseline: OmniCodexFullCatalogSnapshot = {
  catalogRevision: "a".repeat(64),
  catalogToolCount: 700,
  catalogPageToolCounts: [700],
  catalogToolNames: ["full-tool"],
  catalogToolNamesSha256: "b".repeat(64),
  catalogIdentitySha256: "c".repeat(64),
  modelToolCount: 0,
  unknownModelEffectCount: 0,
  criticalToolProperties: "input",
  criticalToolRequired: "input",
  criticalToolDescriptionSha256: "d".repeat(64),
  criticalToolInputSchemaSha256: "e".repeat(64),
  chatGptActionToolCount: names.length,
  chatGptActionToolNames: names,
  chatGptActionToolNamesSha256: "f".repeat(64),
  chatGptActionContractSha256: "0".repeat(64),
  chatGptCriticalToolName: "call_native_tool",
  chatGptCriticalToolProperties:
    "arguments,expectedCatalogRevision,input,name,ordering,payload,query,timeoutMs,toolId",
  chatGptCriticalToolRequired: "",
  chatGptCriticalToolDescriptionSha256: "1".repeat(64),
  chatGptCriticalToolInputSchemaSha256: "2".repeat(64),
};

describe("readStableOracleActionCatalogBaseline", () => {
  it("waits past an intermediate native action contract before returning the converged baseline", async () => {
    const intermediate = {
      ...baseline,
      catalogRevision: "3".repeat(64),
      chatGptActionContractSha256: "4".repeat(64),
    } satisfies OmniCodexFullCatalogSnapshot;
    const converged = {
      ...baseline,
      catalogRevision: "5".repeat(64),
    } satisfies OmniCodexFullCatalogSnapshot;
    const read = vi
      .fn<() => Promise<OmniCodexFullCatalogSnapshot>>()
      .mockResolvedValueOnce(intermediate)
      .mockResolvedValueOnce(converged)
      .mockResolvedValueOnce(converged);
    const wait = vi.fn(async () => undefined);

    await expect(
      readStableOracleActionCatalogBaseline({ read, wait, settleDelayMs: 250, maxReads: 5 }),
    ).resolves.toBe(converged);
    expect(read).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("does not publish a baseline when the eager action contract keeps changing", async () => {
    let readIndex = 0;
    const read = vi.fn(async () => ({
      ...baseline,
      catalogRevision: String(readIndex).repeat(64),
      chatGptActionContractSha256: String(++readIndex).repeat(64),
    }));

    await expect(
      readStableOracleActionCatalogBaseline({
        read,
        wait: async () => undefined,
        maxReads: 3,
      }),
    ).rejects.toThrow("ORACLE_ACTION_CATALOG_BASELINE_UNSTABLE");
    expect(read).toHaveBeenCalledTimes(3);
  });
});

function config(verified = false, stateVerified = verified): OmniCodexConfig {
  return {
    schemaVersion: 1,
    projectRoot: "C:\\OmniCodex",
    gateway: {
      host: "127.0.0.1",
      port: 7436,
      path: "/mcp",
      fullPath: "/mcp/full",
      allowedOrigins: ["https://chatgpt.com"],
    },
    auth: {
      issuer: "https://example.auth0.com/",
      audience: "https://example.test/mcp/full",
      requiredScopes: ["openid"],
      allowedSubjects: ["owner"],
    },
    oracle: {
      enabled: true,
      connectorId: "connector",
      connectorName: "OmniCodex",
      runId: "run",
      resource: "https://example.test/mcp/full",
      surface: "/mcp/full",
      cdpEndpoint: "http://127.0.0.1:19222",
      remoteCdpTunnel: {
        sshHost: "example.test",
        sshPort: 22,
        sshUser: "ubuntu",
        identityFile: "C:\\keys\\oracle.pem",
        remoteCdpPort: 19222,
      },
      freshLiveVerification: verified ? "verified" : "pending",
      ...(stateVerified
        ? {
            lastStateVerification: {
              timestamp: "2026-09-02T00:00:00.000Z",
              correlationId: "settings",
              resource: "https://example.test/mcp/full",
              connected: true as const,
              fullAccess: true as const,
              stateHash: "4".repeat(64),
            },
          }
        : {}),
      ...(verified
        ? {
            lastActionCatalogVerification: {
              timestamp: "2026-09-02T00:00:00.000Z",
              correlationId: "refresh",
              verificationSource: "post_click_mcp_catalog" as const,
              daemonPid: 42,
              catalogRevision: baseline.catalogRevision,
              catalogToolCount: baseline.chatGptActionToolCount,
              catalogPageToolCounts: [baseline.chatGptActionToolCount],
              catalogToolNamesSha256: baseline.chatGptActionToolNamesSha256,
              catalogContractSha256: baseline.chatGptActionContractSha256,
              visibleActionToolCount: baseline.chatGptActionToolCount,
              visibleActionNamesSha256: baseline.chatGptActionToolNamesSha256,
              actionSchemaHash: "3".repeat(64),
              verifiedActionNames: names,
            },
          }
        : {}),
    },
  };
}

function clientConfig(verified = false): OmniCodexConfig {
  const current = config(verified, true);
  if (current.oracle === undefined) throw new Error("Missing fixture binding");
  return withOracleClientBinding(current, "desktop", {
    ...current.oracle,
    connectorId: "desktop-host-id",
  });
}

describe("OracleClientBindingsActionCatalogAutoRefreshCoordinator", () => {
  it("does not reuse a previous tunnel registration's catalog attempt", async () => {
    let current = config(false, true);
    const original = current.oracle;
    if (!original) throw new Error("Missing fixture binding");
    current = withOracleClientBinding(current, "web", {
      ...original,
      registration: { kind: "secure_mcp_tunnel", tunnelId: "tunnel_original" },
    });
    const refresh = vi.fn(async () => {
      throw new Error("refresh failed");
    });
    const coordinator = new OracleClientBindingsActionCatalogAutoRefreshCoordinator({
      loadConfig: async () => current,
      readCatalog: async () => baseline,
      refresh,
    });
    await expect(coordinator.markEndpointReady()).rejects.toThrow(
      "Oracle client binding reconciliation failed",
    );
    await coordinator.synchronize("catalog_observed", baseline.catalogRevision);
    expect(refresh).toHaveBeenCalledTimes(1);
    current = withOracleClientBinding(current, "web", {
      ...original,
      registration: { kind: "secure_mcp_tunnel", tunnelId: "tunnel_replaced" },
    });
    await expect(
      coordinator.synchronize("catalog_observed", baseline.catalogRevision),
    ).rejects.toThrow("Oracle client binding reconciliation failed");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(getOracleClientBindings(current.oracle).web).not.toHaveProperty("endpoint");
    await coordinator.stop();
  });

  function manualFixture(beforeRefresh?: (key: string) => Promise<void>) {
    let current = clientConfig();
    const refresh = vi.fn(async (key: string) => {
      await beforeRefresh?.(key);
      const binding = getOracleClientBindings(current.oracle)[key];
      const verified = config(true).oracle;
      if (!binding || !verified) throw new Error("Missing binding");
      current = withOracleClientBinding(current, key, {
        ...verified,
        connectorId: binding.connectorId,
      });
    });
    const coordinator = new OracleClientBindingsActionCatalogAutoRefreshCoordinator({
      manualRefreshOnly: true,
      loadConfig: async () => current,
      readCatalog: async () => baseline,
      refresh,
    });
    return { coordinator, refresh };
  }

  it("refreshes only the explicitly selected binding", async () => {
    const { coordinator, refresh } = manualFixture();
    await coordinator.markEndpointReady();
    const result = await coordinator.synchronize("manual_refresh", undefined, "web");
    expect(Object.keys(result.bindings)).toEqual(["web"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith("web", baseline.catalogRevision);
    await coordinator.synchronize("runtime_ready", undefined, "desktop");
    expect(refresh).toHaveBeenCalledTimes(1);
    await coordinator.stop();
  });

  it("retries a failed explicitly selected binding without requiring a transport restart", async () => {
    let attempts = 0;
    const { coordinator, refresh } = manualFixture(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary 424");
    });
    await coordinator.markEndpointReady();

    await expect(coordinator.synchronize("manual_refresh", undefined, "web")).rejects.toThrow(
      "Oracle client binding reconciliation failed",
    );
    await expect(
      coordinator.synchronize("manual_refresh", undefined, "web"),
    ).resolves.toMatchObject({
      state: "refreshed",
      bindings: { web: { state: "refreshed" } },
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    await coordinator.stop();
  });

  it("rejects an unknown explicit binding without refreshing any registration", async () => {
    const { coordinator, refresh } = manualFixture();
    await coordinator.markEndpointReady();
    await expect(coordinator.synchronize("manual_refresh", undefined, "missing")).rejects.toThrow(
      "ORACLE_CATALOG_BINDING_NOT_READY:missing",
    );
    expect(refresh).not.toHaveBeenCalled();
    await coordinator.stop();
  });

  it("does not join a different binding's manual refresh receipt", async () => {
    let releaseWeb!: () => void;
    let webStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      webStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseWeb = resolve;
    });
    const { coordinator, refresh } = manualFixture(async (key) => {
      if (key === "web") {
        webStarted();
        await gate;
      }
    });
    await coordinator.markEndpointReady();
    const web = coordinator.synchronize("manual_refresh", undefined, "web");
    await started;
    const desktop = coordinator.synchronize("manual_refresh", undefined, "desktop");
    expect(refresh).toHaveBeenCalledTimes(1);
    releaseWeb();
    expect(Object.keys((await web).bindings)).toEqual(["web"]);
    expect(Object.keys((await desktop).bindings)).toEqual(["desktop"]);
    expect(refresh.mock.calls.map(([key]) => key)).toEqual(["web", "desktop"]);
    await coordinator.stop();
  });

  it("preserves installed registrations on background events and refreshes only on explicit request", async () => {
    let current = clientConfig();
    const loadConfig = vi.fn(async () => current);
    const readCatalog = vi.fn(async () => baseline);
    const refresh = vi.fn(async (key: string) => {
      const binding = getOracleClientBindings(current.oracle)[key];
      const verified = config(true).oracle;
      if (!binding || !verified) throw new Error("Missing binding");
      current = withOracleClientBinding(current, key, {
        ...verified,
        connectorId: binding.connectorId,
      });
    });
    const coordinator = new OracleClientBindingsActionCatalogAutoRefreshCoordinator({
      manualRefreshOnly: true,
      loadConfig,
      readCatalog,
      refresh,
    });
    await expect(coordinator.markEndpointReady()).resolves.toMatchObject({
      state: "explicit_refresh_required",
    });
    await coordinator.synchronize("catalog_observed", "new-catalog");
    await coordinator.synchronize("runtime_ready");
    coordinator.markEndpointUnavailable();
    await coordinator.markEndpointReady(true);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(readCatalog).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();

    await expect(coordinator.synchronize("manual_refresh")).resolves.toMatchObject({
      state: "refreshed",
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(new Set(refresh.mock.calls.map(([key]) => key))).toEqual(new Set(["web", "desktop"]));
    await coordinator.synchronize("catalog_observed", "another-catalog");
    await coordinator.markEndpointReady(true);
    expect(refresh).toHaveBeenCalledTimes(2);
    await coordinator.stop();
  });

  function accountFixture() {
    let now = 1_000;
    let current = clientConfig();
    const web = getOracleClientBindings(current.oracle).web;
    if (!web) throw new Error("Missing web");
    current = withOracleClientBinding(current, "web-peer", { ...web, connectorId: "web-peer" });
    const requests = new ChatAccountRequestCoordinator({ now: () => now, spacingMs: 0 });
    const verify = (key: string) => {
      const verified = config(true).oracle;
      const binding = getOracleClientBindings(current.oracle)[key];
      if (!verified || !binding) throw new Error("Missing binding");
      current = withOracleClientBinding(current, key, {
        ...verified,
        connectorId: binding.connectorId,
      });
    };
    const refresh = vi.fn(async (key: string) => {
      verify(key);
    });
    const observe = vi.fn(
      (account: string, snapshot: { observedAtUnixMs: number; retryAtUnixMs: number }) =>
        requests.observeCooldown(account, snapshot),
    );
    const coordinator = new OracleClientBindingsActionCatalogAutoRefreshCoordinator({
      loadConfig: async () => current,
      readCatalog: async () => baseline,
      refresh,
      now: () => now,
      accountSourceId: (key) => (key === "desktop" ? "chatgpt:B:U" : "chatgpt:A:U"),
      accountCooldown: { read: (account) => requests.readCooldown(account), observe },
    });
    return {
      coordinator,
      requests,
      refresh,
      observe,
      verify,
      setNow: (value: number) => {
        now = value;
      },
    };
  }

  it("runs an independent account while a same-account binding remains single-flight", async () => {
    const f = accountFixture();
    let finish!: () => void;
    f.refresh.mockImplementationOnce(async (key) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      f.verify(key);
    });
    const pending = f.coordinator.markEndpointReady();
    await vi.waitFor(() =>
      expect(f.refresh.mock.calls.map(([key]) => key)).toEqual(["web", "desktop"]),
    );
    expect(f.coordinator.synchronize("catalog_observed", baseline.catalogRevision)).toBe(pending);
    finish();
    const result = await pending;
    expect(f.refresh.mock.calls.map(([key]) => key)).toEqual(["web", "desktop", "web-peer"]);
    expect(result.bindings.desktop?.state).toBe("refreshed");
    await f.coordinator.stop();
  });

  it("shares one account's actual 429 deadline without blocking the other account", async () => {
    const f = accountFixture();
    const failure = new ChatGptControlPlaneHttpError(
      "refresh",
      new Response(null, { status: 429, headers: { "Retry-After": "7200" } }),
      1_000,
    );
    f.refresh.mockImplementationOnce(async () => {
      throw failure;
    });
    await expect(f.coordinator.markEndpointReady()).rejects.toBe(failure);
    expect(f.refresh.mock.calls.map(([key]) => key)).toEqual(["web", "desktop"]);
    expect(await f.requests.readCooldown("chatgpt:A:U")).toEqual({
      observedAtUnixMs: 1_000,
      retryAtUnixMs: 7_201_000,
    });
    expect(await f.requests.readCooldown("chatgpt:B:U")).toBeUndefined();
    f.coordinator.markEndpointUnavailable();
    await f.coordinator.markEndpointReady(true);
    expect(f.observe).toHaveBeenCalledTimes(1);
    expect(f.refresh).toHaveBeenCalledTimes(2);
    f.setNow(7_201_000);
    const result = await f.coordinator.synchronize("catalog_observed", baseline.catalogRevision);
    expect(result.bindings.web?.state).toBe("refreshed");
    expect(result.bindings["web-peer"]?.state).toBe("refreshed");
    await f.coordinator.stop();
  });

  it("honors a desktop-observed cooldown before refreshing that account's bindings", async () => {
    const f = accountFixture();
    await f.requests.observeCooldown("chatgpt:A:U", {
      observedAtUnixMs: 1_000,
      retryAtUnixMs: 20_000,
      serverRetryAtUnixMs: 20_000,
    });
    const first = await f.coordinator.markEndpointReady();
    expect(f.refresh.mock.calls.map(([key]) => key)).toEqual(["desktop"]);
    expect(first.bindings.web?.state).toBe("already_attempted");
    f.setNow(20_000);
    await f.coordinator.synchronize("runtime_ready");
    expect(f.refresh.mock.calls.map(([key]) => key)).toEqual(["desktop", "web", "web-peer"]);
    expect(f.observe).not.toHaveBeenCalled();
    await f.coordinator.stop();
  });

  it("does not treat an undiscovered principal as a separate account or bypass a known cooldown", async () => {
    let account: string | undefined;
    const requests = new ChatAccountRequestCoordinator({ now: () => 1_000, spacingMs: 0 });
    await requests.observeCooldown("chatgpt:A:U", {
      observedAtUnixMs: 1_000,
      retryAtUnixMs: 20_000,
    });
    const refresh = vi.fn();
    const coordinator = new OracleClientBindingsActionCatalogAutoRefreshCoordinator({
      loadConfig: async () => clientConfig(),
      readCatalog: async () => baseline,
      refresh,
      now: () => 1_000,
      accountSourceId: (key) => (key === "web" ? "chatgpt:A:U" : account),
      accountCooldown: {
        read: (id) => requests.readCooldown(id),
        observe: (id, snapshot) => requests.observeCooldown(id, snapshot),
      },
    });
    const first = await coordinator.markEndpointReady();
    expect(first.bindings.desktop?.state).toBe("state_verification_required");
    expect(refresh).not.toHaveBeenCalled();
    account = "chatgpt:A:U";
    const second = await coordinator.synchronize("runtime_ready");
    expect(second.bindings.desktop?.state).toBe("already_attempted");
    expect(refresh).not.toHaveBeenCalled();
    await coordinator.stop();
  });

  it("allows an explicitly selected unverified binding to establish control-plane state", async () => {
    let current = clientConfig();
    const refresh = vi.fn(async (key: string) => {
      const binding = getOracleClientBindings(current.oracle)[key];
      const verified = config(true).oracle;
      if (!binding || !verified) throw new Error("Missing binding");
      current = withOracleClientBinding(current, key, {
        ...verified,
        connectorId: binding.connectorId,
      });
    });
    const coordinator = new OracleClientBindingsActionCatalogAutoRefreshCoordinator({
      manualRefreshOnly: true,
      loadConfig: async () => current,
      readCatalog: async () => baseline,
      refresh,
      accountSourceId: (key) => (key === "web" ? "chatgpt:A:U" : undefined),
    });
    await coordinator.markEndpointReady();
    const result = await coordinator.synchronize("manual_refresh", undefined, "desktop");
    expect(result.bindings.desktop?.state).toBe("refreshed");
    expect(refresh).toHaveBeenCalledWith("desktop", baseline.catalogRevision);
    await coordinator.stop();
  });

  it("holds an explicit unverified binding behind a known account cooldown", async () => {
    const requests = new ChatAccountRequestCoordinator({ now: () => 1_000, spacingMs: 0 });
    await requests.observeCooldown("chatgpt:A:U", {
      observedAtUnixMs: 1_000,
      retryAtUnixMs: 20_000,
    });
    const refresh = vi.fn();
    const coordinator = new OracleClientBindingsActionCatalogAutoRefreshCoordinator({
      manualRefreshOnly: true,
      loadConfig: async () => clientConfig(),
      readCatalog: async () => baseline,
      refresh,
      now: () => 1_000,
      accountSourceId: (key) => (key === "web" ? "chatgpt:A:U" : undefined),
      accountCooldown: {
        read: (id) => requests.readCooldown(id),
        observe: (id, snapshot) => requests.observeCooldown(id, snapshot),
      },
    });
    await coordinator.markEndpointReady();
    const result = await coordinator.synchronize("manual_refresh", undefined, "desktop");
    expect(result.bindings.desktop?.state).toBe("already_attempted");
    expect(refresh).not.toHaveBeenCalled();
    await coordinator.stop();
  });

  it("retains a second transport recovery while the first recovery is still running", async () => {
    let current = config(false, true);
    const reject: Array<(error: Error) => void> = [];
    const refresh = vi.fn(async () => {
      if (reject.length < 2) return new Promise<void>((_resolve, fail) => reject.push(fail));
      current = config(true);
    });
    const coordinator = new OracleClientBindingsActionCatalogAutoRefreshCoordinator({
      loadConfig: async () => current,
      readCatalog: async () => baseline,
      refresh,
    });
    const firstFailure = expect(coordinator.markEndpointReady()).rejects.toThrow();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    coordinator.markEndpointUnavailable();
    const second = coordinator.markEndpointReady(true);
    const secondFailure = expect(second).rejects.toThrow();
    reject[0]?.(new Error("first transport lost"));
    await firstFailure;
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    coordinator.markEndpointUnavailable();
    const third = coordinator.markEndpointReady(true);
    expect(third).not.toBe(second);
    reject[1]?.(new Error("second transport lost"));
    await secondFailure;
    await expect(third).resolves.toMatchObject({ state: "refreshed" });
    expect(refresh).toHaveBeenCalledTimes(3);
    await coordinator.stop();
  });

  it.each([false, true])(
    "retains a recovered transport epoch during an in-flight failure (429=%s)",
    async (rateLimited) => {
      let current = clientConfig();
      let rejectFirst: ((error: Error) => void) | undefined;
      const pending = new Promise<void>((_resolve, reject) => {
        rejectFirst = reject;
      });
      let first = true;
      const refresh = vi.fn(async (key: string) => {
        if (first) {
          first = false;
          return pending;
        }
        const verified = config(true).oracle;
        const binding = getOracleClientBindings(current.oracle)[key];
        if (!verified || !binding) throw new Error("Missing fixture");
        current = withOracleClientBinding(current, key, {
          ...verified,
          connectorId: binding.connectorId,
        });
      });
      const coordinator = new OracleClientBindingsActionCatalogAutoRefreshCoordinator({
        loadConfig: async () => current,
        readCatalog: async () => baseline,
        refresh,
        now: () => 1_000,
      });
      const original = coordinator.markEndpointReady();
      const originalFailure = expect(original).rejects.toThrow();
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
      coordinator.markEndpointUnavailable();
      const recovered = coordinator.markEndpointReady(true);
      for (let index = 0; index < 20; index++)
        expect(coordinator.markEndpointReady(true)).toBe(recovered);
      rejectFirst?.(
        rateLimited
          ? new ChatGptControlPlaneHttpError(
              "refresh",
              new Response(null, { status: 429, headers: { "Retry-After": "7200" } }),
              1_000,
            )
          : new Error("old transport lost"),
      );
      await originalFailure;
      await expect(recovered).resolves.toMatchObject({
        state: rateLimited ? "already_attempted" : "refreshed",
      });
      expect(refresh.mock.calls.map(([key]) => key)).toEqual(
        rateLimited ? ["web"] : ["web", "desktop", "web"],
      );
      await coordinator.stop();
    },
  );

  it("continues independent bindings after a non-rate-limit failure while exposing that failure", async () => {
    let current = clientConfig();
    const failure = new Error("WEB_REFRESH_FAILED");
    const refresh = vi.fn(async (key: string) => {
      if (key === "web") throw failure;
      const verified = config(true).oracle;
      if (verified === undefined) throw new Error("Missing fixture");
      current = withOracleClientBinding(current, key, {
        ...verified,
        connectorId: "desktop-host-id",
      });
    });
    const coordinator = new OracleClientBindingsActionCatalogAutoRefreshCoordinator({
      loadConfig: async () => current,
      readCatalog: async () => baseline,
      refresh,
    });
    await expect(coordinator.markEndpointReady()).rejects.toMatchObject({
      errors: [expect.objectContaining({ cause: failure })],
    });
    expect(refresh.mock.calls.map(([key]) => key)).toEqual(["web", "desktop"]);
    expect(getOracleClientBindings(current.oracle).web?.freshLiveVerification).toBe("pending");
    expect(getOracleClientBindings(current.oracle).desktop?.freshLiveVerification).toBe("verified");
    await coordinator.stop();
  });

  it("shares a catalog-read 429 before any binding can start a refresh", async () => {
    let now = 1_000;
    const failure = new ChatGptControlPlaneHttpError(
      "catalog",
      new Response(null, {
        status: 429,
        headers: { "Retry-After": "7200" },
      }),
      now,
    );
    const readCatalog = vi.fn(async () => {
      throw failure;
    });
    const refresh = vi.fn();
    const coordinator = new OracleClientBindingsActionCatalogAutoRefreshCoordinator({
      loadConfig: async () => clientConfig(),
      readCatalog,
      refresh,
      now: () => now,
    });
    await expect(coordinator.markEndpointReady()).rejects.toBe(failure);
    now = 3_601_000;
    await expect(
      coordinator.synchronize("catalog_observed", baseline.catalogRevision),
    ).resolves.toMatchObject({ state: "already_attempted" });
    expect(readCatalog).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    await coordinator.stop();
  });

  it("coalesces events while refreshing both host bindings independently", async () => {
    let current = clientConfig();
    const active: string[] = [];
    const refresh = vi.fn(async (key: string) => {
      active.push(key);
      await Promise.resolve();
      const verified = config(true).oracle;
      const before = getOracleClientBindings(current.oracle)[key];
      if (verified === undefined || before === undefined) throw new Error("Missing fixture");
      current = withOracleClientBinding(current, key, {
        ...verified,
        connectorId: before.connectorId,
      });
      active.pop();
    });
    const coordinator = new OracleClientBindingsActionCatalogAutoRefreshCoordinator({
      loadConfig: async () => current,
      readCatalog: async () => baseline,
      refresh,
    });
    const first = coordinator.markEndpointReady();
    expect(coordinator.synchronize("catalog_observed", baseline.catalogRevision)).toBe(first);
    expect(coordinator.markEndpointReady()).toBe(first);
    const result = await first;
    expect(result.state).toBe("refreshed");
    expect(result.bindings.web?.state).toBe("refreshed");
    expect(result.bindings.desktop?.state).toBe("refreshed");
    expect(refresh.mock.calls.map(([key]) => key)).toEqual(["web", "desktop"]);
    expect(getOracleClientBindings(current.oracle).web?.connectorId).toBe("connector");
    expect(getOracleClientBindings(current.oracle).desktop?.connectorId).toBe("desktop-host-id");
    expect(active).toEqual([]);
    await coordinator.synchronize("catalog_observed", baseline.catalogRevision);
    expect(refresh).toHaveBeenCalledTimes(2);
    await coordinator.stop();
  });

  it("stops later bindings after account 429 and preserves Retry-After across ready events", async () => {
    let now = 1_000;
    let current = clientConfig();
    const error = new ChatGptControlPlaneHttpError(
      "refresh",
      new Response(null, {
        status: 429,
        headers: { "Retry-After": "7200" },
      }),
      now,
    );
    const refresh = vi.fn(async (key: string) => {
      if (now === 1_000) throw error;
      const verified = config(true).oracle;
      const before = getOracleClientBindings(current.oracle)[key];
      if (verified === undefined || before === undefined) throw new Error("Missing fixture");
      current = withOracleClientBinding(current, key, {
        ...verified,
        connectorId: before.connectorId,
      });
    });
    const loadConfig = vi.fn(async () => current);
    const readCatalog = vi.fn(async () => baseline);
    const coordinator = new OracleClientBindingsActionCatalogAutoRefreshCoordinator({
      loadConfig,
      readCatalog,
      refresh,
      now: () => now,
    });
    await expect(coordinator.markEndpointReady()).rejects.toBe(error);
    expect(refresh.mock.calls.map(([key]) => key)).toEqual(["web"]);
    const reads = [loadConfig.mock.calls.length, readCatalog.mock.calls.length];
    now = 3_601_000;
    coordinator.markEndpointUnavailable();
    for (let count = 0; count < 20; count += 1) {
      await expect(coordinator.markEndpointReady(true)).resolves.toMatchObject({
        state: "already_attempted",
      });
    }
    expect([loadConfig.mock.calls.length, readCatalog.mock.calls.length]).toEqual(reads);
    expect(refresh).toHaveBeenCalledOnce();
    now = 7_201_000;
    const result = await coordinator.synchronize("catalog_observed", baseline.catalogRevision);
    expect(result.bindings.web?.state).toBe("refreshed");
    expect(result.bindings.desktop?.state).toBe("refreshed");
    expect(refresh.mock.calls.map(([key]) => key)).toEqual(["web", "web", "desktop"]);
    await coordinator.stop();
  });

  it("invalidates only a changed registration and stops all future work on stop", async () => {
    let current = clientConfig(true);
    const refresh = vi.fn(async (key: string) => {
      const binding = getOracleClientBindings(current.oracle)[key];
      const verified = config(true).oracle;
      if (binding === undefined || verified === undefined) throw new Error("Missing fixture");
      current = withOracleClientBinding(current, key, {
        ...verified,
        connectorId: binding.connectorId,
      });
    });
    const coordinator = new OracleClientBindingsActionCatalogAutoRefreshCoordinator({
      loadConfig: async () => current,
      readCatalog: async () => baseline,
      refresh,
    });
    await coordinator.markEndpointReady();
    const changed = config(false, true).oracle;
    if (changed === undefined) throw new Error("Missing fixture");
    current = withOracleClientBinding(current, "desktop", {
      ...changed,
      connectorId: "new-desktop-issued",
    });
    await coordinator.synchronize("catalog_observed", baseline.catalogRevision);
    expect(refresh.mock.calls.map(([key]) => key)).toEqual(["desktop"]);
    await coordinator.stop();
    await expect(coordinator.markEndpointReady(true)).resolves.toMatchObject({
      state: "endpoint_unavailable",
    });
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("OracleActionCatalogAutoRefreshCoordinator", () => {
  it("honors a server Retry-After longer than the local maximum cooldown", async () => {
    let now = 1_000;
    let current = config(false, true);
    const error = new ChatGptControlPlaneHttpError(
      "refresh",
      new Response(null, {
        status: 429,
        headers: { "Retry-After": "7200" },
      }),
      now,
    );
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(error)
      .mockImplementationOnce(async () => {
        current = config(true);
      });
    const coordinator = new OracleActionCatalogAutoRefreshCoordinator({
      loadConfig: async () => current,
      readCatalog: async () => baseline,
      refresh,
      now: () => now,
    });
    await expect(coordinator.markEndpointReady()).rejects.toBe(error);
    now += 3_600_000;
    await expect(coordinator.markEndpointReady(true)).resolves.toMatchObject({
      state: "already_attempted",
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(error.retryAtUnixMs).toBe(7_201_000);
    now = 7_201_000;
    await expect(
      coordinator.synchronize("catalog_observed", baseline.catalogRevision),
    ).resolves.toMatchObject({ state: "refreshed" });
    expect(refresh).toHaveBeenCalledTimes(2);
    await coordinator.stop();
  });

  it("does not touch any browser until the isolated Oracle endpoint is ready", async () => {
    const refresh = vi.fn();
    const coordinator = new OracleActionCatalogAutoRefreshCoordinator({
      loadConfig: async () => config(),
      readCatalog: async () => baseline,
      refresh,
    });
    await expect(
      coordinator.synchronize("catalog_observed", baseline.catalogRevision),
    ).resolves.toEqual({
      state: "endpoint_unavailable",
      catalogRevision: baseline.catalogRevision,
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes one stale revision once and requires authoritative persisted readback", async () => {
    let current = config(false, true);
    const refresh = vi.fn(async () => {
      current = config(true);
    });
    const coordinator = new OracleActionCatalogAutoRefreshCoordinator({
      loadConfig: async () => current,
      readCatalog: async () => baseline,
      refresh,
    });
    await expect(coordinator.markEndpointReady()).resolves.toEqual({
      state: "refreshed",
      catalogRevision: baseline.catalogRevision,
    });
    await expect(
      coordinator.synchronize("catalog_observed", baseline.catalogRevision),
    ).resolves.toEqual({ state: "current", catalogRevision: baseline.catalogRevision });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("establishes an unverified registration through the page-free control-plane refresh", async () => {
    let current = config();
    const refresh = vi.fn(async () => {
      current = config(true);
    });
    const coordinator = new OracleActionCatalogAutoRefreshCoordinator({
      loadConfig: async () => current,
      readCatalog: async () => baseline,
      refresh,
    });

    await expect(coordinator.markEndpointReady()).resolves.toEqual({
      state: "refreshed",
      catalogRevision: baseline.catalogRevision,
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not refresh an action snapshot that already matches the live action contract", async () => {
    const refresh = vi.fn();
    const coordinator = new OracleActionCatalogAutoRefreshCoordinator({
      loadConfig: async () => config(true),
      readCatalog: async () => baseline,
      refresh,
    });
    await expect(coordinator.markEndpointReady()).resolves.toEqual({
      state: "current",
      catalogRevision: baseline.catalogRevision,
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(oracleActionCatalogMatchesBaseline(config(true), baseline)).toBe(true);
  });

  it("does not refresh when only the dynamic native registry revision changes", async () => {
    const changedRegistryRevision = {
      ...baseline,
      catalogRevision: "9".repeat(64),
      catalogToolCount: baseline.catalogToolCount + 1,
      catalogToolNames: [...baseline.catalogToolNames, "new_dynamic_native_tool"],
      catalogToolNamesSha256: "8".repeat(64),
      catalogIdentitySha256: "7".repeat(64),
    } satisfies OmniCodexFullCatalogSnapshot;
    const refresh = vi.fn();
    const coordinator = new OracleActionCatalogAutoRefreshCoordinator({
      loadConfig: async () => config(true),
      readCatalog: async () => changedRegistryRevision,
      refresh,
    });

    await expect(coordinator.markEndpointReady()).resolves.toEqual({
      state: "current",
      catalogRevision: changedRegistryRevision.catalogRevision,
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(oracleActionCatalogMatchesBaseline(config(true), changedRegistryRevision)).toBe(true);
  });

  it("refreshes when names stay equal but one eager action contract changes", async () => {
    const changedActionContract = {
      ...baseline,
      catalogRevision: "6".repeat(64),
      chatGptActionContractSha256: "7".repeat(64),
    } satisfies OmniCodexFullCatalogSnapshot;
    let current = config(true);
    const refresh = vi.fn(async () => {
      const oracle = current.oracle;
      const verification = oracle?.lastActionCatalogVerification;
      if (oracle === undefined || verification === undefined) {
        throw new Error("verified Oracle fixture is incomplete");
      }
      current = {
        ...current,
        oracle: {
          ...oracle,
          lastActionCatalogVerification: {
            ...verification,
            catalogRevision: changedActionContract.catalogRevision,
            catalogContractSha256: changedActionContract.chatGptActionContractSha256,
          },
        },
      };
    });
    const coordinator = new OracleActionCatalogAutoRefreshCoordinator({
      loadConfig: async () => current,
      readCatalog: async () => changedActionContract,
      refresh,
    });

    await expect(coordinator.markEndpointReady()).resolves.toEqual({
      state: "refreshed",
      catalogRevision: changedActionContract.catalogRevision,
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(oracleActionCatalogMatchesBaseline(current, changedActionContract)).toBe(true);
  });

  it("retries a failed revision only after a new Oracle transport-ready epoch", async () => {
    let current = config(false, true);
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("transport lost"))
      .mockImplementationOnce(async () => {
        current = config(true);
      });
    const coordinator = new OracleActionCatalogAutoRefreshCoordinator({
      loadConfig: async () => current,
      readCatalog: async () => baseline,
      refresh,
    });
    await expect(coordinator.markEndpointReady()).rejects.toThrow("transport lost");
    await expect(
      coordinator.synchronize("catalog_observed", baseline.catalogRevision),
    ).resolves.toEqual({ state: "already_attempted", catalogRevision: baseline.catalogRevision });
    coordinator.markEndpointUnavailable();
    await expect(coordinator.markEndpointReady(true)).resolves.toEqual({
      state: "refreshed",
      catalogRevision: baseline.catalogRevision,
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not retry a rate-limited revision on repeated transport-ready signals during cooldown", async () => {
    let current = config(false, true);
    let now = 1_000;
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("429 Too many requests"))
      .mockImplementationOnce(async () => {
        current = config(true);
      });
    const coordinator = new OracleActionCatalogAutoRefreshCoordinator({
      loadConfig: async () => current,
      readCatalog: async () => baseline,
      refresh,
      now: () => now,
      rateLimitBaseCooldownMs: 5_000,
    });

    await expect(coordinator.markEndpointReady()).rejects.toThrow("Too many requests");
    coordinator.markEndpointUnavailable();
    await expect(coordinator.markEndpointReady(true)).resolves.toEqual({
      state: "already_attempted",
      catalogRevision: baseline.catalogRevision,
    });
    await expect(coordinator.markEndpointReady(true)).resolves.toEqual({
      state: "already_attempted",
      catalogRevision: baseline.catalogRevision,
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    now += 5_001;
    await expect(coordinator.markEndpointReady(true)).resolves.toEqual({
      state: "refreshed",
      catalogRevision: baseline.catalogRevision,
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it.each(["catalog_observed", "runtime_ready"] as const)(
    "resumes a rate-limited revision on %s after cooldown without reconnecting",
    async (reason) => {
      let current = config(false, true);
      let now = 1_000;
      const refresh = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("429 Too many requests"))
        .mockImplementationOnce(async () => {
          current = config(true);
        });
      const coordinator = new OracleActionCatalogAutoRefreshCoordinator({
        loadConfig: async () => current,
        readCatalog: async () => baseline,
        refresh,
        now: () => now,
        rateLimitBaseCooldownMs: 5_000,
      });

      await expect(coordinator.markEndpointReady()).rejects.toThrow("Too many requests");
      now = 5_999;
      await expect(
        coordinator.synchronize(reason, baseline.catalogRevision),
      ).resolves.toMatchObject({
        state: "already_attempted",
      });
      expect(refresh).toHaveBeenCalledOnce();

      now = 6_000;
      const resumed = coordinator.synchronize(reason, baseline.catalogRevision);
      const concurrent = coordinator.synchronize(reason, baseline.catalogRevision);
      await expect(resumed).resolves.toEqual({
        state: "refreshed",
        catalogRevision: baseline.catalogRevision,
      });
      await expect(concurrent).resolves.toEqual({
        state: "refreshed",
        catalogRevision: baseline.catalogRevision,
      });
      await expect(
        coordinator.synchronize(reason, baseline.catalogRevision),
      ).resolves.toMatchObject({
        state: "current",
      });
      expect(refresh).toHaveBeenCalledTimes(2);
      await coordinator.stop();
    },
  );

  it("does not lose a transport-ready epoch that arrives while the stale refresh is in flight", async () => {
    let current = config(false, true);
    let rejectFirst: ((error: Error) => void) | undefined;
    const firstRefresh = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => firstRefresh)
      .mockImplementationOnce(async () => {
        current = config(true);
      });
    const coordinator = new OracleActionCatalogAutoRefreshCoordinator({
      loadConfig: async () => current,
      readCatalog: async () => baseline,
      refresh,
    });

    const failedEpoch = coordinator.markEndpointReady();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    coordinator.markEndpointUnavailable();
    const recoveredEpoch = coordinator.markEndpointReady(true);
    rejectFirst?.(new Error("old transport lost"));

    await expect(failedEpoch).rejects.toThrow("old transport lost");
    await expect(recoveredEpoch).resolves.toEqual({
      state: "refreshed",
      catalogRevision: baseline.catalogRevision,
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("cannot launch a late refresh after daemon shutdown begins", async () => {
    let releaseConfig: ((value: OmniCodexConfig) => void) | undefined;
    const pendingConfig = new Promise<OmniCodexConfig>((resolve) => {
      releaseConfig = resolve;
    });
    const refresh = vi.fn();
    const coordinator = new OracleActionCatalogAutoRefreshCoordinator({
      loadConfig: () => pendingConfig,
      readCatalog: async () => baseline,
      refresh,
    });
    const synchronize = coordinator.markEndpointReady();
    const stop = coordinator.stop();
    releaseConfig?.(config());
    await expect(synchronize).resolves.toEqual({ state: "endpoint_unavailable" });
    await stop;
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("oracleActionCatalogTransportsReady", () => {
  const ready = {
    enabled: true,
    publicTunnel: { kind: "ngrok" as const, publicUrl: "https://owner.example" },
    runningPublicTunnel: { kind: "ngrok" as const, publicUrl: "https://owner.example" },
    remoteCdpConfigured: true,
    remoteCdpReady: true,
    directCdpReady: false,
  };

  it("requires both the exact public MCP tunnel and the Oracle CDP transport", () => {
    expect(oracleActionCatalogTransportsReady(ready)).toBe(true);
    expect(oracleActionCatalogTransportsReady({ ...ready, runningPublicTunnel: undefined })).toBe(
      false,
    );
    expect(oracleActionCatalogTransportsReady({ ...ready, remoteCdpReady: false })).toBe(false);
    expect(
      oracleActionCatalogTransportsReady({
        ...ready,
        runningPublicTunnel: { kind: "ngrok", publicUrl: "https://stale.example" },
      }),
    ).toBe(false);
  });

  it("accepts an explicitly managed direct public ingress with a live direct CDP", () => {
    expect(
      oracleActionCatalogTransportsReady({
        ...ready,
        publicTunnel: { kind: "direct", publicUrl: "https://owner.example" },
        runningPublicTunnel: undefined,
        remoteCdpConfigured: false,
        remoteCdpReady: false,
        directCdpReady: true,
      }),
    ).toBe(true);
  });
});
