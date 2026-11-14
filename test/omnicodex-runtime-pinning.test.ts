import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { EngineBuildFollower } from "../src/application/engine-build-follower.js";
import type { RuntimeCandidate } from "../src/domain/runtime.js";
import type { StreamableHttpGatewayOptions } from "../src/infrastructure/mcp/streamable-http-gateway.js";

const harness = vi.hoisted(() => ({
  candidates: [] as Array<{ role: string; candidate: RuntimeCandidate }>,
  starts: [] as RuntimeCandidate[],
  gatewayOptions: undefined as StreamableHttpGatewayOptions | undefined,
  follower: undefined as EngineBuildFollower | undefined,
  desktopPath: undefined as string | undefined,
  nativeCalls: 0,
  nativeFailure: undefined as Error | undefined,
}));

// Exercise the real Windows snapshot/selection path on every test platform.
vi.mock("../src/infrastructure/runtime/codex-runtime-snapshot.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../src/infrastructure/runtime/codex-runtime-snapshot.js")
    >();
  return {
    ...original,
    snapshotManagedCodexRuntime: (candidate: RuntimeCandidate, root: string) =>
      original.snapshotManagedCodexRuntime(candidate, root, "win32"),
  };
});

vi.mock("../src/application/engine-build-follower.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/application/engine-build-follower.js")>();
  return {
    ...original,
    EngineBuildFollower: class extends original.EngineBuildFollower {
      constructor(...args: ConstructorParameters<typeof original.EngineBuildFollower>) {
        super(...args);
        harness.follower = this;
      }
    },
  };
});
vi.mock("../src/infrastructure/windows/desktop-engine-build-reader.js", () => ({
  DesktopEngineBuildReader: class {
    async readExecutablePath() {
      return harness.desktopPath;
    }
  },
}));
vi.mock("../src/infrastructure/windows/desktop-engine-refresh-runner.js", () => ({
  DesktopEngineRefreshRunner: class {
    async refresh() {
      return undefined;
    }
  },
}));

// No actual Codex, Desktop pipe, HTTP listener, or device is used in these tests.
vi.mock("../src/infrastructure/runtime/codex-app-server-process.js", () => ({
  CodexAppServerProcess: class {
    constructor(readonly candidate: RuntimeCandidate) {
      harness.candidates.push({ role: "app-server", candidate });
    }
    readonly client = {
      request: async () => ({ data: [], nextCursor: null }),
      subscribeNotifications: () => () => undefined,
    };
    readonly identity = {};
    async start() {
      const { readFile } = await import("node:fs/promises");
      const { dirname, join } = await import("node:path");
      await readFile(join(dirname(this.candidate.executablePath), "codex-code-mode-host.exe"));
      harness.starts.push(this.candidate);
    }
    async stop() {}
  },
}));
vi.mock("../src/infrastructure/runtime/codex-app-server-connection.js", async () => {
  const { CodexAppServerProcess } = await import(
    "../src/infrastructure/runtime/codex-app-server-process.js"
  );
  return { CodexAppServerConnection: CodexAppServerProcess };
});
vi.mock("../src/infrastructure/runtime/codex-detached-thread-client.js", () => ({
  CodexDetachedThreadClient: class {
    constructor(candidate: RuntimeCandidate) {
      harness.candidates.push({ role: "detached", candidate });
    }
    async dispose() {}
  },
}));
vi.mock("../src/infrastructure/runtime/codex-schema-bundle-loader.js", () => ({
  CodexSchemaBundleLoader: class {
    constructor(candidate: RuntimeCandidate) {
      harness.candidates.push({ role: "schema", candidate });
    }
    async loadClientRequestSchema() {
      return { properties: { method: { const: "thread/list" }, params: { type: "object" } } };
    }
  },
}));
vi.mock("../src/infrastructure/windows/codex-desktop-ipc-client.js", () => ({
  CodexDesktopIpcClient: class {
    dispose() {}
  },
}));
vi.mock("../src/application/codex-app-host-tool-executor.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CodexAppHostToolExecutor: class {
    readonly tools = [];
    async prepareToolsRefresh() {
      return [];
    }
    commitToolsRefresh() {}
    descriptor() {
      return {};
    }
    async callRequiredNative() {
      return { structuredContent: { pinnedThreads: [], threads: [] } };
    }
  },
}));
vi.mock("../src/application/native-tool-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  NativeToolCatalog: class {
    readonly snapshot = { tools: [] };
    async prepareRefresh() {
      return this.snapshot;
    }
    commitRefresh() {}
  },
  NativeToolExecutor: class {
    async callInContext() {
      harness.nativeCalls += 1;
      if (harness.nativeFailure !== undefined) throw harness.nativeFailure;
      return { ok: true };
    }
    async retireOwnedExecutionThread() {}
    clearOwnedExecutionThreadAfterProcessStop() {}
  },
}));
vi.mock("../src/application/browser-native-executor.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  BrowserNativeExecutor: class {
    async close() {}
  },
}));
vi.mock("../src/application/code-mode-native-tool-surface.js", () => ({
  CodeModeNativeToolSurface: class {
    readonly dynamicToolSpecs = [];
    readonly nativeToolNames = [];
  },
}));
vi.mock("../src/application/responses-runtime-executor.js", () => ({
  OMNICODEX_LOOPBACK_PROVIDER_ID: "omnicodex_loopback",
  ResponsesRuntimeExecutor: class {
    readonly snapshot = { tools: [], requestCount: 0 };
    async prepare() {
      return { configOverrides: [], env: {}, onNotification: () => undefined };
    }
    async start() {}
    async callNested() {
      return { ok: true };
    }
    async stop() {}
  },
}));
vi.mock("../src/application/omnicodex-bridge-reconciler.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/application/omnicodex-bridge-reconciler.js")>();
  return {
    ...original,
    OmniCodexBridgeReconciler: class {
      constructor(
        private readonly options: ConstructorParameters<
          typeof original.OmniCodexBridgeReconciler
        >[0],
      ) {
        harness.candidates.push({ role: "bridge", candidate: options.candidate });
      }
      async reconcile() {
        const bootstrap = this.options.bootstrapFactory?.();
        await bootstrap?.start();
        await bootstrap?.stop();
        return {
          threadId: "bridge",
          registryDigest: original.omniCodexBridgeRegistryDigest(
            original.OMNICODEX_BRIDGE_CONTEXT_TOOLS,
          ),
          disposition: "current",
        };
      }
    },
  };
});
vi.mock("../src/infrastructure/mcp/streamable-http-gateway.js", () => ({
  StreamableHttpGateway: class {
    constructor(options: StreamableHttpGatewayOptions) {
      harness.gatewayOptions = options;
    }
    readonly runtimeStatus = { admission: "open", activeMcpRequests: 0, activeModelTurns: 0 };
    readonly address = { host: "127.0.0.1", port: 1, path: "/mcp", fullPath: "/mcp/full" };
    async start() {
      return this.address;
    }
    async stop() {}
    beginDrain() {
      return this.runtimeStatus;
    }
    async awaitDrained() {}
    resumeAdmission() {
      return this.runtimeStatus;
    }
    observedChatGptConversationIds() {
      return [];
    }
    async refreshTools() {}
  },
}));

import { OmniCodexGatewayService } from "../src/application/omnicodex-gateway-service.js";

const roots: string[] = [];
const services: OmniCodexGatewayService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
  harness.candidates.length = 0;
  harness.starts.length = 0;
  harness.gatewayOptions = undefined;
  harness.follower = undefined;
  harness.desktopPath = undefined;
  harness.nativeCalls = 0;
  harness.nativeFailure = undefined;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omnicodex-runtime-pinning-"));
  roots.push(root);
  vi.stubEnv("OMNICODEX_DATA_DIR", join(root, "data"));
  const old = await installed(root, "old");
  const updated = await installed(root, "updated");
  return { root, old, updated };
}

async function installed(root: string, build: string): Promise<RuntimeCandidate> {
  const directory = join(root, build);
  await mkdir(directory);
  for (const name of [
    "codex.exe",
    "codex-code-mode-host.exe",
    "codex-command-runner.exe",
    "codex-windows-sandbox-setup.exe",
  ]) {
    await writeFile(join(directory, name), `${build}:${name}`);
  }
  return {
    executablePath: join(directory, "codex.exe"),
    canonicalPath: join(directory, "codex.exe"),
    source: "managed_install",
    buildSha256: createHash("sha256").update(`${build}:codex.exe`).digest("hex"),
  };
}

function serviceFor(candidates: readonly RuntimeCandidate[]) {
  const service = new OmniCodexGatewayService({
    authorize: () => ({ ok: false, status: 401 }),
    discovery: { discover: async () => ({ candidates, warnings: [] }) },
    appToolsClientFactory: () => ({
      listTools: async () => [],
      callTool: async () => ({ success: true, contentItems: [] }),
      close() {},
    }),
    modelMetadataSource: {
      read: async () => ({ rawModel: {}, modelDigest: "m".repeat(64), cachePath: "unused" }),
    },
    runtimeEnvironment: async () => ({
      CODEX_HOME: join(process.env.OMNICODEX_DATA_DIR ?? "", "home"),
    }),
    observeRuntime: async () => undefined,
    runtimeObservationMs: 0,
  });
  services.push(service);
  return service;
}

async function session() {
  const executors = await harness.gatewayOptions?.createSessionExecutors?.({
    identity: { issuer: "test", subject: "test", clientId: "test", resource: "test" },
    authorizationBinding: "owner",
    correlationId: "work-session",
    resolveWorkSessionBinding: () => "durable-work-session",
  });
  if (executors === undefined) throw new Error("Missing session factory");
  return executors;
}

it("pins every owned runtime before start and retains the physical follower/switch identity", async () => {
  const { root, old, updated } = await fixture();
  const service = serviceFor([old, updated]);
  harness.desktopPath = old.executablePath;
  expect((await service.start()).candidate).toBe(old);
  const pinned = harness.starts[0];
  expect(pinned?.executablePath).toContain(join(root, "data", "engine-generations"));
  expect(pinned?.executablePath).not.toBe(old.executablePath);
  expect(harness.candidates.map(({ role }) => role)).toEqual(
    expect.arrayContaining(["detached", "app-server", "schema", "bridge"]),
  );
  for (const { candidate } of harness.candidates) expect(candidate).toBe(pinned);
  expect(await harness.follower?.followOnce()).toBe(false);
  expect(await harness.follower?.followOnce()).toBe(false);
  await expect(service.switchRuntime(old.canonicalPath)).rejects.toThrow("already active");

  // A natural Desktop update is followed once, not repeatedly to the cache path.
  harness.desktopPath = updated.executablePath;
  expect(await harness.follower?.followOnce()).toBe(true);
  expect(service.status.candidate).toBe(updated);
  const startsAfterSwitch = harness.starts.length;
  expect(await harness.follower?.followOnce()).toBe(false);
  expect(await harness.follower?.followOnce()).toBe(false);
  expect(harness.starts).toHaveLength(startsAfterSwitch);
});

it.each(["old", "updated"] as const)(
  "skips an incomplete %s build before any spawn and uses only the complete discovered package",
  async (missing) => {
    const { old, updated } = await fixture();
    const incomplete = missing === "old" ? old : updated;
    const complete = missing === "old" ? updated : old;
    await unlink(join(dirname(incomplete.executablePath), "codex-code-mode-host.exe"));
    const service = serviceFor([incomplete, complete]);
    expect((await service.start()).candidate).toBe(complete);
    for (const { candidate } of harness.candidates) {
      expect(candidate.buildSha256).toBe(complete.buildSha256);
      expect(
        await readFile(join(dirname(candidate.executablePath), "codex-code-mode-host.exe"), "utf8"),
      ).toBe(`${missing === "old" ? "updated" : "old"}:codex-code-mode-host.exe`);
    }
    expect(harness.starts.length).toBeGreaterThan(0);
  },
);

it("fails closed when no discovered package is complete, even with complementary sidecars", async () => {
  const { old, updated } = await fixture();
  await unlink(join(dirname(old.executablePath), "codex-code-mode-host.exe"));
  await unlink(join(dirname(updated.executablePath), "codex-command-runner.exe"));
  await expect(serviceFor([old, updated]).start()).rejects.toThrow(
    "CODEX_RUNTIME_PACKAGE_INCOMPLETE",
  );
  expect(harness.starts).toEqual([]);
  expect(harness.candidates).toEqual([]);
});

it("keeps lazy work-session App Server and Responses contexts pinned after source removal", async () => {
  const { old } = await fixture();
  const service = serviceFor([old]);
  await service.start();
  const pinned = harness.starts[0];
  await rm(dirname(old.executablePath), { recursive: true });
  const executors = await session();
  await expect(executors.nativeToolExecutor?.callInContext("test", "tool", {})).resolves.toEqual({
    ok: true,
  });
  await expect(executors.responsesToolExecutor?.callNested("exec", {}, false)).resolves.toEqual({
    ok: true,
  });
  await service.readThreadInventory();
  expect(harness.starts.length).toBeGreaterThan(3);
  for (const { candidate } of harness.candidates) expect(candidate).toBe(pinned);
  await executors.close?.();
});

it("never replays an ambiguous native call on a fallback build", async () => {
  const { old, updated } = await fixture();
  await serviceFor([old, updated]).start();
  const executors = await session();
  harness.nativeFailure = new Error("JSONL App Server stream ended");
  await expect(executors.nativeToolExecutor?.callInContext("test", "tool", {})).rejects.toThrow(
    "stream ended",
  );
  expect(harness.nativeCalls).toBe(1);
  expect(
    harness.candidates.every(({ candidate }) => candidate.buildSha256 === old.buildSha256),
  ).toBe(true);
  await executors.close?.();
});
