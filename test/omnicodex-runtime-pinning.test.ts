import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { EngineBuildFollower } from "../src/application/engine-build-follower.js";
import type { RuntimeCandidate } from "../src/domain/runtime.js";
import type { StreamableHttpGatewayOptions } from "../src/infrastructure/mcp/streamable-http-gateway.js";
import type { CodexDetachedThreadClient } from "../src/infrastructure/runtime/codex-detached-thread-client.js";

const harness = vi.hoisted(() => ({
  candidates: [] as Array<{ role: string; candidate: RuntimeCandidate }>,
  starts: [] as RuntimeCandidate[],
  connections: [] as RuntimeCandidate[],
  responseProcesses: [] as Array<{ stop(): Promise<void> }>,
  detached: undefined as CodexDetachedThreadClient | undefined,
  gatewayOptions: undefined as StreamableHttpGatewayOptions | undefined,
  follower: undefined as EngineBuildFollower | undefined,
  desktopRuntime: undefined as RuntimeCandidate | undefined,
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
      return harness.desktopRuntime?.executablePath;
    }
    async readAppServerProcesses() {
      const runtime = harness.desktopRuntime;
      return runtime === undefined
        ? []
        : [
            {
              pid: 200,
              parentPid: 100,
              name: "codex.exe",
              executablePath: runtime.executablePath,
              commandLine: `"${runtime.executablePath}" app-server --stdio`,
              startedAtIso: new Date(0).toISOString(),
            },
          ];
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

// Keep the real connection, locator path/version checks, and JSONL handshake.
// Only OS process/record discovery and the socket are replaced with test data.
vi.mock("../src/infrastructure/runtime/desktop-app-server-locator.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../src/infrastructure/runtime/desktop-app-server-locator.js")
    >();
  const instanceNonce = "e88ee61d-780e-48da-85a4-ae92f262f674";
  return {
    ...original,
    DesktopAppServerLocator: class extends original.DesktopAppServerLocator {
      constructor(options: ConstructorParameters<typeof original.DesktopAppServerLocator>[0]) {
        super({
          ...options,
          readDirectory: async () => [`desktop-app-server-200-${instanceNonce}.json`],
          readTextFile: async () =>
            JSON.stringify({
              schemaVersion: 1,
              pid: 200,
              pipeName: `\\\\.\\pipe\\codex-app-server-200-${instanceNonce}`,
              executablePath: harness.desktopRuntime?.executablePath,
              appServerVersion: harness.desktopRuntime?.productVersion,
              instanceNonce,
              startedAtUnixMs: 1,
            }),
        });
      }
    },
  };
});
vi.mock("node:net", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:net")>();
  const { Duplex } = await import("node:stream");
  return {
    ...original,
    connect: () => {
      const socket = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          const request = JSON.parse(chunk.toString()) as {
            id: number;
            method: string;
            params: { threadId?: string };
          };
          const result =
            request.method === "initialize"
              ? { codexHome: "test-home" }
              : request.method === "turn/start"
                ? { turn: { id: "detached-turn" } }
                : { data: [], nextCursor: null };
          socket.push(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
          if (request.method === "turn/start") {
            socket.push(
              `${JSON.stringify({
                method: "turn/completed",
                params: { threadId: request.params.threadId, turn: { id: "detached-turn" } },
              })}\n`,
            );
          }
          callback();
        },
      });
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
  };
});
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
      for (const name of runtimeFiles) {
        const content = await readFile(join(dirname(this.candidate.executablePath), name), "utf8");
        expect(content).toBe(`${this.candidate.productVersion}:${name}`);
      }
      harness.starts.push(this.candidate);
    }
    async stop() {}
  },
}));
vi.mock("../src/infrastructure/runtime/codex-app-server-connection.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../src/infrastructure/runtime/codex-app-server-connection.js")
    >();
  return {
    ...original,
    CodexAppServerConnection: class extends original.CodexAppServerConnection {
      constructor(...args: ConstructorParameters<typeof original.CodexAppServerConnection>) {
        super(...args);
        harness.candidates.push({ role: "desktop-connection", candidate: args[0] });
      }
      override async start() {
        await super.start();
        harness.connections.push(this.identity.candidate);
      }
    },
  };
});
vi.mock("../src/infrastructure/runtime/codex-detached-thread-client.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../src/infrastructure/runtime/codex-detached-thread-client.js")
    >();
  return {
    ...original,
    CodexDetachedThreadClient: class extends original.CodexDetachedThreadClient {
      constructor(...args: ConstructorParameters<typeof original.CodexDetachedThreadClient>) {
        super(args[0], { ...args[1], recoverQueue: false });
        harness.candidates.push({ role: "detached", candidate: args[0] });
        harness.detached = this;
      }
    },
  };
});
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
    async start(process: { stop(): Promise<void> }) {
      harness.responseProcesses.push(process);
    }
    async handleProcessExit() {}
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
  harness.connections.length = 0;
  harness.responseProcesses.length = 0;
  harness.detached = undefined;
  harness.gatewayOptions = undefined;
  harness.follower = undefined;
  harness.desktopRuntime = undefined;
  harness.nativeCalls = 0;
  harness.nativeFailure = undefined;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omnicodex-runtime-pinning-"));
  roots.push(root);
  vi.stubEnv("OMNICODEX_DATA_DIR", join(root, "data"));
  const old = await installed(root, "old");
  const updated = await installed(root, "updated");
  harness.desktopRuntime = old;
  return { root, old, updated };
}

const runtimeFiles = [
  "codex.exe",
  "codex-code-mode-host.exe",
  "codex-command-runner.exe",
  "codex-windows-sandbox-setup.exe",
  "runtime-dependency.dll",
];

async function installed(root: string, build: string): Promise<RuntimeCandidate> {
  const directory = join(
    root,
    "LocalAppData",
    "OpenAI",
    "Codex",
    "bin",
    build === "old" ? "9e1da79431da526b" : "123456789abcdef0",
  );
  await mkdir(directory, { recursive: true });
  for (const name of runtimeFiles) {
    await writeFile(join(directory, name), `${build}:${name}`);
  }
  await writeFile(join(directory, "auth.json"), "must not copy credentials");
  await writeFile(join(directory, "config.toml"), "must not copy configuration");
  return {
    executablePath: join(directory, "codex.exe"),
    canonicalPath: join(directory, "codex.exe"),
    source: "managed_install",
    buildSha256: createHash("sha256").update(`${build}:codex.exe`).digest("hex"),
    productVersion: build,
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

it("connects to the physical Desktop build while pinning owned processes and follower identity", async () => {
  const { root, old, updated } = await fixture();
  const service = serviceFor([old, updated]);
  expect((await service.start()).candidate).toBe(old);
  const pinned = harness.starts[0];
  expect(pinned?.executablePath).toContain(join(root, "data", "engine-generations"));
  expect(pinned?.executablePath).not.toBe(old.executablePath);
  expect(harness.candidates.map(({ role }) => role)).toEqual(
    expect.arrayContaining(["detached", "desktop-connection", "app-server", "schema", "bridge"]),
  );
  for (const { role, candidate } of harness.candidates) {
    expect(candidate).toBe(role === "app-server" || role === "schema" ? pinned : old);
  }
  expect(harness.connections.length).toBeGreaterThanOrEqual(2);
  expect(harness.connections.every((candidate) => candidate === old)).toBe(true);
  expect((await readdir(dirname(pinned?.executablePath ?? ""))).sort()).toEqual(
    [...runtimeFiles].sort(),
  );
  expect(await harness.follower?.followOnce()).toBe(false);
  expect(await harness.follower?.followOnce()).toBe(false);
  await expect(service.switchRuntime(old.canonicalPath)).rejects.toThrow("already active");

  // A natural Desktop update is followed once, not repeatedly to the cache path.
  harness.desktopRuntime = updated;
  expect(await harness.follower?.followOnce()).toBe(true);
  expect(service.status.candidate).toBe(updated);
  const updatedPinned = harness.starts.at(-1);
  expect(updatedPinned?.executablePath).not.toBe(updated.executablePath);
  expect(updatedPinned?.buildSha256).toBe(updated.buildSha256);
  expect(harness.connections.at(-1)).toBe(updated);
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
    harness.desktopRuntime = complete;
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

it("keeps lazy Desktop transports physical and owned Responses pinned after source removal", async () => {
  const { old } = await fixture();
  const service = serviceFor([old]);
  await service.start();
  const pinned = harness.starts[0];
  await rm(dirname(old.executablePath), { recursive: true });
  // Retire the eager shared generation so the lazy Responses lease must spawn
  // another complete owned process without consulting the removed source.
  await harness.responseProcesses[0]?.stop();
  const executors = await session();
  await expect(executors.nativeToolExecutor?.callInContext("test", "tool", {})).resolves.toEqual({
    ok: true,
  });
  await expect(executors.responsesToolExecutor?.callNested("exec", {}, false)).resolves.toEqual({
    ok: true,
  });
  await service.readThreadInventory();
  await expect(
    harness.detached?.sendFollowUpMessage("inactive-thread", "test"),
  ).resolves.toMatchObject({ disposition: "started" });
  expect(harness.starts).toHaveLength(2);
  expect(harness.connections.length).toBeGreaterThanOrEqual(5);
  for (const { role, candidate } of harness.candidates) {
    expect(candidate).toBe(role === "app-server" || role === "schema" ? pinned : old);
  }
  expect(harness.connections.every((candidate) => candidate === old)).toBe(true);
  await executors.close?.();
});

it("rejects a different physical Desktop build before spawning any owned process", async () => {
  const { old, updated } = await fixture();
  harness.desktopRuntime = updated;
  await expect(serviceFor([old]).start()).rejects.toThrow(
    "executable differs from the selected engine",
  );
  expect(harness.connections).toEqual([]);
  expect(harness.starts).toEqual([]);
});

it("rejects a mismatched Desktop version even when the executable path matches", async () => {
  const { old } = await fixture();
  harness.desktopRuntime = { ...old, productVersion: "different-build" };
  await expect(serviceFor([old]).start()).rejects.toThrow(
    "version differs from the selected engine",
  );
  expect(harness.connections).toEqual([]);
  expect(harness.starts).toEqual([]);
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
