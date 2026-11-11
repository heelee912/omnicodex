import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  oracleClientRuntimeStatus,
  oracleDaemonRuntimeStatus,
  oraclePublicMcpReady,
} from "../src/application/oracle-runtime-status.js";
import type {
  OmniCodexConfig,
  OmniCodexDaemonState,
} from "../src/infrastructure/config/omnicodex-config-store.js";

describe("oracleDaemonRuntimeStatus", () => {
  it("reports training ready without starting an approval watcher", () => {
    expect(
      oracleDaemonRuntimeStatus({
        enabled: true,
        remoteTunnelConfigured: false,
        approvalMirrorReady: true,
        approvalAutomationEnabled: false,
      }),
    ).toMatchObject({
      ready: true,
      cdpTransportReady: true,
      approvalWatcher: { state: "stopped" },
    });
  });

  it("keeps a ready client independent of a starting peer", () => {
    const web = oracleDaemonRuntimeStatus({
      enabled: true,
      remoteTunnelConfigured: false,
      approvalMirrorReady: true,
      approvalWatcher: {
        state: "ready",
        consecutiveFailures: 0,
        watchedTargets: 1,
        lastSuccessfulScanAt: "2026-09-08T02:44:39.796Z",
      },
    });
    const second = oracleDaemonRuntimeStatus({
      enabled: true,
      remoteTunnelConfigured: false,
      approvalMirrorReady: true,
      approvalWatcher: { state: "starting", consecutiveFailures: 0, watchedTargets: 0 },
    });
    const runtime = { ...web, ready: false, bindings: { web, second } };
    expect(oracleClientRuntimeStatus(runtime, "web")).toBe(web);
    expect(oracleClientRuntimeStatus(runtime, "web")?.ready).toBe(true);
    expect(oracleClientRuntimeStatus(runtime, "second")?.ready).toBe(false);
    expect(oracleClientRuntimeStatus(runtime, "absent")).toBeUndefined();
    expect(oracleClientRuntimeStatus({ ...web, bindings: {} }, "second")).toBeUndefined();
    expect(oracleClientRuntimeStatus(undefined, "web")).toBeUndefined();
  });

  it("reads CLI live runtime status during catalog reconciliation", async () => {
    const cli = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
    const start = cli.indexOf("const daemonLive =");
    const end = cli.indexOf("const [runtime, liveCatalog]", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const ownershipCheck = cli.slice(start, end);
    expect(ownershipCheck).toContain("daemonOwnershipIsLive(daemonState)");
    expect(ownershipCheck).not.toContain("lifecycle");
  });

  it("does not report ready from persisted qualification when the live watcher is absent", () => {
    expect(
      oracleDaemonRuntimeStatus({
        enabled: true,
        remoteTunnelConfigured: true,
        approvalMirrorReady: true,
        remoteTunnelStatus: {
          ownership: "owned",
          cdpEndpoint: "http://127.0.0.1:19222",
          versionEndpoint: "http://127.0.0.1:19222/json/version",
          sshHost: "oracle.example",
          remoteCdpPort: 9222,
          pid: 1234,
        },
      }),
    ).toMatchObject({
      ready: false,
      cdpTransport: "remote_tunnel",
      cdpTransportReady: true,
      approvalWatcher: { state: "stopped" },
    });
  });

  it("reports ready only when the current watcher has completed a successful scan", () => {
    expect(
      oracleDaemonRuntimeStatus({
        enabled: true,
        remoteTunnelConfigured: false,
        approvalMirrorReady: true,
        approvalWatcher: {
          state: "ready",
          consecutiveFailures: 0,
          watchedTargets: 1,
          lastSuccessfulScanAt: "2026-09-02T00:00:00.000Z",
        },
      }),
    ).toMatchObject({
      ready: true,
      cdpTransport: "direct",
      cdpTransportReady: true,
    });
  });
});

describe("oraclePublicMcpReady", () => {
  const config = {
    schemaVersion: 1,
    projectRoot: "C:\\work",
    gateway: {
      host: "127.0.0.1",
      port: 5412,
      path: "/mcp",
      fullPath: "/mcp/full",
      allowedOrigins: [],
    },
    auth: {
      issuer: "https://issuer.example/",
      audience: "https://owner.example/mcp/full",
      requiredScopes: ["omnicodex:full"],
      allowedSubjects: ["owner"],
    },
    tunnel: {
      kind: "ngrok",
      executablePath: "C:\\bin\\ngrok.exe",
      publicUrl: "https://owner.example",
      credentialRef: "dpapi:v1:example",
    },
  } satisfies OmniCodexConfig;
  const state = {
    schemaVersion: 1,
    lifecycle: "ready",
    pid: 42,
    instanceNonce: "instance",
    startedAtUnixMs: 1,
    updatedAtUnixMs: 2,
    controlPipe: "pipe",
    controlToken: "x".repeat(32),
    address: { host: "127.0.0.1", port: 5412, path: "/mcp", fullPath: "/mcp/full" },
  } satisfies OmniCodexDaemonState;

  const reachable = {
    fetch: (async () =>
      Response.json({
        resource: "https://owner.example/mcp/full",
        authorization_servers: [config.auth.issuer],
      })) as typeof fetch,
  };
  const liveState = {
    ...state,
    tunnel: { kind: "ngrok" as const, publicUrl: "https://owner.example", pid: 43 },
  };

  it("rejects a healthy local daemon when its managed public tunnel is absent", async () => {
    await expect(oraclePublicMcpReady(config, state, reachable)).resolves.toBe(false);
  });

  it("accepts only the exact configured managed public tunnel and public resource", async () => {
    await expect(oraclePublicMcpReady(config, liveState, reachable)).resolves.toBe(true);
    await expect(
      oraclePublicMcpReady(
        config,
        {
          ...state,
          tunnel: { kind: "ngrok", publicUrl: "https://different.example", pid: 43 },
        },
        reachable,
      ),
    ).resolves.toBe(false);
  });

  it("does not treat a persisted live tunnel PID as current public reachability", async () => {
    await expect(
      oraclePublicMcpReady(config, liveState, {
        fetch: (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch,
      }),
    ).resolves.toBe(false);
  });

  it("probes a serving gateway during catalog reconciliation but not a stopped daemon", async () => {
    await expect(
      oraclePublicMcpReady(config, { ...liveState, lifecycle: "starting" }, reachable),
    ).resolves.toBe(true);
    await expect(
      oraclePublicMcpReady(config, { ...liveState, lifecycle: "stopping" }, reachable),
    ).resolves.toBe(false);
    await expect(
      oraclePublicMcpReady(config, { ...state, lifecycle: "starting" }, reachable),
    ).resolves.toBe(false);
  });

  it("rejects a successful HTTP response for another MCP resource", async () => {
    await expect(
      oraclePublicMcpReady(config, liveState, {
        fetch: (async () =>
          Response.json({
            resource: "https://another.example/mcp/full",
            authorization_servers: [config.auth.issuer],
          })) as typeof fetch,
      }),
    ).resolves.toBe(false);
  });

  it("propagates the caller's status deadline and does not follow a redirect", async () => {
    const signal = new AbortController().signal;
    await expect(
      oraclePublicMcpReady(config, liveState, {
        signal,
        fetch: (async (url, init) => {
          expect(String(url)).toBe(
            "https://owner.example/.well-known/oauth-protected-resource/mcp/full",
          );
          expect(init).toMatchObject({ signal, redirect: "error", cache: "no-store" });
          return new Response(null, { status: 502 });
        }) as typeof fetch,
      }),
    ).resolves.toBe(false);
  });
});
