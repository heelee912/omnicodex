import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OMNICODEX_BRIDGE_THREAD_TITLE } from "../src/application/app-server-thread-operation.js";
import {
  type OmniCodexBridgeBootstrap,
  OmniCodexBridgeReconciler,
  omniCodexBridgeRegistryDigest,
} from "../src/application/omnicodex-bridge-reconciler.js";
import type { RuntimeCandidate } from "../src/domain/runtime.js";

const candidate: RuntimeCandidate = {
  source: "managed_install",
  executablePath: "C:\\Codex\\codex.exe",
  canonicalPath: "C:\\Codex\\codex.exe",
  buildSha256: "a".repeat(64),
};

const dynamicTools = [
  {
    type: "namespace",
    name: "codex_app",
    tools: [
      {
        type: "function",
        name: "list_threads",
        description: "List threads",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  },
];

interface FakeThread {
  id: string;
  name: string;
  archived: boolean;
  status: "idle" | "active";
  path?: string;
  updatedAt?: number;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("OmniCodex Bridge reconciler", () => {
  it("computes one canonical digest independent of registry and object ordering", () => {
    const reordered = [
      {
        tools: [
          {
            inputSchema: { properties: {}, type: "object" },
            description: "List threads",
            name: "list_threads",
            type: "function",
          },
        ],
        name: "codex_app",
        type: "namespace",
      },
    ];

    expect(omniCodexBridgeRegistryDigest(dynamicTools)).toBe(
      omniCodexBridgeRegistryDigest(reordered),
    );
    expect(omniCodexBridgeRegistryDigest(dynamicTools)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("creates one staged Bridge, promotes it, atomically records it, and always stops bootstrap", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime([]);
    const reconciler = reconcilerFor(root, runtime.bootstrap);

    await expect(reconciler.reconcile()).resolves.toMatchObject({
      threadId: "created-1",
      disposition: "created",
    });

    expect(runtime.started).toBe(1);
    expect(runtime.stopped).toBe(1);
    expect(
      runtime.threads.filter(
        (thread) => !thread.archived && thread.name === OMNICODEX_BRIDGE_THREAD_TITLE,
      ),
    ).toEqual([expect.objectContaining({ id: "created-1" })]);
    const manifest = JSON.parse(
      await readFile(join(root, "bridge", "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      phase: "stable",
      activeThreadId: "created-1",
    });
    const inventoryCalls = runtime.calls.filter((call) => call.method === "thread/list");
    expect(inventoryCalls.length).toBeGreaterThan(0);
    for (const call of inventoryCalls) {
      expect(call.params.modelProviders).toEqual([]);
      expect(call.params.sourceKinds).toEqual(
        expect.arrayContaining(["cli", "vscode", "appServer", "exec"]),
      );
    }
  });

  it("does not impose an App Server request timeout and propagates one only when specified", async () => {
    const unboundedRoot = await temporaryDirectory();
    const unboundedRuntime = fakeRuntime([]);

    await reconcilerFor(unboundedRoot, unboundedRuntime.bootstrap).reconcile();

    expect(unboundedRuntime.calls.length).toBeGreaterThan(0);
    expect(unboundedRuntime.calls.every((call) => call.timeoutMs === undefined)).toBe(true);

    const boundedRoot = await temporaryDirectory();
    const boundedRuntime = fakeRuntime([]);
    await new OmniCodexBridgeReconciler({
      candidate,
      dynamicTools,
      dataDirectory: boundedRoot,
      cwd: "C:\\work",
      bootstrapFactory: () => boundedRuntime.bootstrap,
      requestTimeoutMs: 4_321,
    }).reconcile();

    expect(boundedRuntime.calls.length).toBeGreaterThan(0);
    expect(boundedRuntime.calls.every((call) => call.timeoutMs === 4_321)).toBe(true);
  });

  it("durably names a new empty thread before thread/list can discover it", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime([], { hideUntitledThreads: true });

    await expect(reconcilerFor(root, runtime.bootstrap).reconcile()).resolves.toMatchObject({
      threadId: "created-1",
      disposition: "created",
    });

    const startedAt = runtime.calls.findIndex((call) => call.method === "thread/start");
    const stagedAt = runtime.calls.findIndex(
      (call) =>
        call.method === "thread/name/set" &&
        String(call.params.name).startsWith("[OmniCodex] Bridge staging "),
    );
    const materializedAt = runtime.calls.findIndex(
      (call) => call.method === "thread/goal/set" && call.params.threadId === "created-1",
    );
    const visibleListAt = runtime.calls.findIndex(
      (call, index) => index > stagedAt && call.method === "thread/list",
    );
    expect(startedAt).toBeGreaterThanOrEqual(0);
    expect(materializedAt).toBeGreaterThan(startedAt);
    expect(stagedAt).toBeGreaterThan(materializedAt);
    expect(visibleListAt).toBeGreaterThan(stagedAt);
    expect(
      runtime.calls.some(
        (call) => call.method === "thread/read" && call.params.threadId === "created-1",
      ),
    ).toBe(false);
    const threadStart = runtime.calls[startedAt];
    expect(threadStart?.params).not.toHaveProperty("model");
    expect(threadStart?.params).not.toHaveProperty("modelProvider");
  });

  it("materializes an empty candidate before promoting one authoritative active Bridge", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime([], { hideUnmaterializedThreads: true });
    const materializations: Array<{ threadId: string; resumeRequired: boolean }> = [];
    const reconciler = new OmniCodexBridgeReconciler({
      candidate,
      dynamicTools,
      dataDirectory: root,
      cwd: "C:\\work",
      bootstrapFactory: () => runtime.bootstrap,
      materializeCandidate: async (client, threadId, resumeRequired) => {
        expect(client).toBe(runtime.bootstrap.client);
        materializations.push({ threadId, resumeRequired });
        runtime.materializeThread(threadId);
      },
    });

    await expect(reconciler.reconcile()).resolves.toMatchObject({
      threadId: "created-1",
      disposition: "created",
    });

    expect(materializations).toEqual([{ threadId: "created-1", resumeRequired: false }]);
    expect(
      runtime.threads.filter(
        (thread) => !thread.archived && thread.name === OMNICODEX_BRIDGE_THREAD_TITLE,
      ),
    ).toEqual([expect.objectContaining({ id: "created-1" })]);
    const manifest = JSON.parse(
      await readFile(join(root, "bridge", "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      phase: "stable",
      activeThreadId: "created-1",
    });
  });

  it("waits beyond the former inventory deadline when the caller did not specify one", async () => {
    vi.useFakeTimers();
    try {
      const root = await temporaryDirectory();
      const runtime = fakeRuntime([], { hideUnmaterializedThreads: true });
      let materializationStarted: (() => void) | undefined;
      const started = new Promise<void>((resolveStarted) => {
        materializationStarted = resolveStarted;
      });
      const reconciler = new OmniCodexBridgeReconciler({
        candidate,
        dynamicTools,
        dataDirectory: root,
        cwd: "C:\\work",
        bootstrapFactory: () => runtime.bootstrap,
        materializeCandidate: async (_client, threadId) => {
          materializationStarted?.();
          setTimeout(() => runtime.materializeThread(threadId), 16_000);
        },
      });

      const reconciliation = reconciler.reconcile();
      await started;
      await vi.advanceTimersByTimeAsync(16_100);

      await expect(reconciliation).resolves.toMatchObject({
        threadId: "created-1",
        disposition: "created",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("materializes the Bridge without starting a model turn", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime([], { hideUnmaterializedThreads: true });

    await expect(reconcilerFor(root, runtime.bootstrap).reconcile()).resolves.toMatchObject({
      threadId: "created-1",
      disposition: "created",
    });

    expect(runtime.calls).toContainEqual({
      method: "thread/goal/set",
      params: {
        threadId: "created-1",
        objective: "OmniCodex native bridge registry",
        status: "complete",
      },
    });
    expect(runtime.calls).toContainEqual({
      method: "thread/goal/clear",
      params: { threadId: "created-1" },
    });
    expect(runtime.calls.some((call) => call.method === "thread/inject_items")).toBe(false);
    expect(runtime.calls.some((call) => call.method === "turn/start")).toBe(false);
    expect(runtime.calls.some((call) => call.method === "thread/queue/add")).toBe(false);
  });

  it("returns a manifest-matched Bridge without creating or resuming it", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime([]);
    await reconcilerFor(root, runtime.bootstrap).reconcile();
    runtime.calls.length = 0;

    await expect(reconcilerFor(root, runtime.bootstrap).reconcile()).resolves.toMatchObject({
      threadId: "created-1",
      disposition: "current",
    });

    expect(runtime.calls.some((call) => call.method === "thread/start")).toBe(false);
    expect(runtime.calls.some((call) => call.method === "thread/resume")).toBe(false);
    expect(runtime.stopped).toBe(2);
  });

  it("defers stale replacement while the existing exact Bridge is active", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime([
      {
        id: "desktop-owned",
        name: OMNICODEX_BRIDGE_THREAD_TITLE,
        archived: false,
        status: "active",
      },
    ]);

    await expect(reconcilerFor(root, runtime.bootstrap).reconcile()).resolves.toMatchObject({
      threadId: "desktop-owned",
      disposition: "deferred_active_owner",
    });

    expect(runtime.calls.some((call) => call.method === "thread/archive")).toBe(false);
    expect(runtime.calls.some((call) => call.method === "thread/start")).toBe(false);
    expect(runtime.calls.some((call) => call.method === "thread/read")).toBe(false);
    expect(runtime.stopped).toBe(1);
  });

  it("reconstructs a lost manifest from the exact persisted registry without creating a Bridge", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "bridge-rollout.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: "existing",
          dynamic_tools: dynamicTools,
        },
      })}\n`,
    );
    const runtime = fakeRuntime([
      {
        id: "existing",
        name: OMNICODEX_BRIDGE_THREAD_TITLE,
        archived: false,
        status: "idle",
        path,
      },
    ]);

    await expect(reconcilerFor(root, runtime.bootstrap).reconcile()).resolves.toMatchObject({
      threadId: "existing",
      disposition: "current",
    });
    expect(runtime.calls.some((call) => call.method === "thread/start")).toBe(false);
    expect(runtime.calls.some((call) => call.method === "thread/archive")).toBe(false);
    expect(JSON.parse(await readFile(join(root, "bridge", "manifest.json"), "utf8"))).toMatchObject(
      {
        activeThreadId: "existing",
        desiredRegistryDigest: omniCodexBridgeRegistryDigest(dynamicTools),
      },
    );
  });

  it("reuses immutable registries when the catalog alternates instead of growing persisted tasks", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime([]);
    const alternateTools = [
      ...dynamicTools,
      {
        type: "function",
        name: "additional_tool",
        description: "Additional tool",
        inputSchema: { type: "object" },
      },
    ];
    const alternate = new OmniCodexBridgeReconciler({
      candidate,
      dynamicTools: alternateTools,
      dataDirectory: root,
      bootstrapFactory: () => runtime.bootstrap,
    });
    await reconcilerFor(root, runtime.bootstrap).reconcile();
    await alternate.reconcile();
    await expect(reconcilerFor(root, runtime.bootstrap).reconcile()).resolves.toMatchObject({
      threadId: "created-1",
      disposition: "replaced",
    });
    await expect(alternate.reconcile()).resolves.toMatchObject({
      threadId: "created-2",
      disposition: "replaced",
    });
    expect(runtime.calls.filter((call) => call.method === "thread/start")).toHaveLength(2);
    expect(
      runtime.calls.filter(
        (call) =>
          call.method === "thread/name/set" && call.params.name === OMNICODEX_BRIDGE_THREAD_TITLE,
      ),
    ).toHaveLength(2);
    expect(runtime.threads).toHaveLength(2);
    expect(runtime.threads.filter((thread) => !thread.archived)).toEqual([
      expect.objectContaining({ id: "created-2", name: OMNICODEX_BRIDGE_THREAD_TITLE }),
    ]);
  });

  it("rebuilds an older manifest registry index from archived rollouts instead of duplicating them", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "archived-registry.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({
        type: "session_meta",
        payload: { id: "archived-registry", dynamic_tools: dynamicTools },
      })}\n`,
    );
    await mkdir(join(root, "bridge"), { recursive: true });
    await writeFile(
      join(root, "bridge", "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        phase: "stable",
        desiredRegistryDigest: omniCodexBridgeRegistryDigest([]),
        activeThreadId: "current",
        updatedAtUnixMs: Date.now(),
      }),
    );
    const runtime = fakeRuntime([
      { id: "current", name: OMNICODEX_BRIDGE_THREAD_TITLE, archived: false, status: "idle" },
      {
        id: "archived-registry",
        name: OMNICODEX_BRIDGE_THREAD_TITLE,
        archived: true,
        status: "idle",
        path,
      },
      {
        id: "missing-rollout",
        name: OMNICODEX_BRIDGE_THREAD_TITLE,
        archived: true,
        status: "idle",
        path: join(root, "missing.jsonl"),
      },
    ]);
    await expect(reconcilerFor(root, runtime.bootstrap).reconcile()).resolves.toMatchObject({
      threadId: "archived-registry",
      disposition: "replaced",
    });
    expect(runtime.calls.some((call) => call.method === "thread/start")).toBe(false);
    const manifest = JSON.parse(await readFile(join(root, "bridge", "manifest.json"), "utf8"));
    expect(manifest.registryThreads).toMatchObject({
      [omniCodexBridgeRegistryDigest(dynamicTools)]: "archived-registry",
      [omniCodexBridgeRegistryDigest([])]: "current",
    });
  });

  it("compares omitted function defaults symmetrically without changing supplied definitions", async () => {
    const tool = { type: "function", name: "test", description: "Exact", inputSchema: {} };
    const explicit = { ...tool, deferLoading: false };
    expect(omniCodexBridgeRegistryDigest([tool])).toBe(omniCodexBridgeRegistryDigest([explicit]));
    expect(omniCodexBridgeRegistryDigest([{ type: "namespace", name: "n", tools: [tool] }])).toBe(
      omniCodexBridgeRegistryDigest([{ type: "namespace", name: "n", tools: [explicit] }]),
    );
    expect(tool).not.toHaveProperty("deferLoading");
    expect(omniCodexBridgeRegistryDigest([{ ...tool, deferLoading: true }])).not.toBe(
      omniCodexBridgeRegistryDigest([tool]),
    );
  });

  it("journals a candidate before materialization can be interrupted and recovers the same id", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime([], { hideUnmaterializedThreads: true });
    const reconciler = new OmniCodexBridgeReconciler({
      candidate,
      dynamicTools,
      dataDirectory: root,
      bootstrapFactory: () => runtime.bootstrap,
      materializeCandidate: async (_client, threadId) => {
        const manifest = JSON.parse(await readFile(join(root, "bridge", "manifest.json"), "utf8"));
        expect(manifest).toMatchObject({ phase: "candidate_started", candidateThreadId: threadId });
        throw new Error("interrupted materialization");
      },
    });
    await expect(reconciler.reconcile()).rejects.toThrow("interrupted materialization");
    await expect(reconcilerFor(root, runtime.bootstrap).reconcile()).resolves.toMatchObject({
      threadId: "created-1",
      disposition: "created",
    });
    expect(runtime.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
  });

  it("recognizes Codex's persisted omission of false deferLoading without changing tool metadata", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "bridge-rollout.jsonl");
    const functionTool = {
      type: "function",
      name: "exact_tool",
      description: "Full exact description",
      inputSchema: { type: "object", properties: { model: { description: "high, ultra" } } },
    };
    const desiredTools = [{ ...functionTool, deferLoading: false }];
    await writeFile(
      path,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: "existing",
          dynamic_tools: [functionTool],
        },
      })}\n`,
    );
    const runtime = fakeRuntime([
      {
        id: "existing",
        name: OMNICODEX_BRIDGE_THREAD_TITLE,
        archived: false,
        status: "idle",
        path,
      },
    ]);
    const reconciler = new OmniCodexBridgeReconciler({
      candidate,
      dynamicTools: desiredTools,
      dataDirectory: root,
      bootstrapFactory: () => runtime.bootstrap,
    });
    await expect(reconciler.reconcile()).resolves.toMatchObject({
      threadId: "existing",
      disposition: "current",
    });
    expect(runtime.calls.some((call) => call.method === "thread/start")).toBe(false);
    expect(desiredTools).toEqual([{ ...functionTool, deferLoading: false }]);
  });

  it("preserves changing model descriptions while reusing their two existing registries", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime([]);
    const registry = (efforts: string) =>
      ["create_thread", "send_message_to_thread"].map((name) => ({
        type: "function",
        name: `codex_app__${name}`,
        deferLoading: false,
        description: name,
        inputSchema: {
          type: "object",
          properties: {
            model: {
              type: "string",
              description: `gpt-5.6-luna; supported reasoning efforts: ${efforts}`,
            },
          },
        },
      }));
    const registryA = registry("low, medium, high, xhigh, max");
    const registryB = registry("low, medium, high, xhigh, max, ultra");
    for (const tools of [registryA, registryB, registryA, registryB, registryA, registryB]) {
      await new OmniCodexBridgeReconciler({
        candidate,
        dynamicTools: tools,
        dataDirectory: root,
        bootstrapFactory: () => runtime.bootstrap,
      }).reconcile();
    }
    const starts = runtime.calls.filter((call) => call.method === "thread/start");
    expect(starts).toHaveLength(2);
    expect(starts.map((call) => call.params.dynamicTools)).toEqual([registryA, registryB]);
    expect(runtime.threads.filter((thread) => !thread.archived)).toHaveLength(1);
  });

  it("defers reuse of an owned archived registry without creating another duplicate", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime([]);
    await reconcilerFor(root, runtime.bootstrap).reconcile();
    await new OmniCodexBridgeReconciler({
      candidate,
      dynamicTools: [],
      dataDirectory: root,
      bootstrapFactory: () => runtime.bootstrap,
    }).reconcile();
    const reconciler = reconcilerFor(root, runtime.bootstrap, {
      findThreadOwner: async (id) => (id === "created-1" ? "desktop-owner" : null),
    });
    await expect(reconciler.reconcile()).resolves.toMatchObject({
      threadId: "created-2",
      disposition: "deferred_active_owner",
    });
    expect(runtime.calls.filter((call) => call.method === "thread/start")).toHaveLength(2);
    expect(runtime.threads.find((thread) => thread.id === "created-1")?.archived).toBe(true);
  });

  it("archives only old unowned staging tasks after convergence and confirms the official lifecycle result", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime([]);
    await reconcilerFor(root, runtime.bootstrap).reconcile();
    const oldTime = (Date.now() - 2 * 24 * 60 * 60 * 1_000) / 1_000;
    const stage = (id: string, status: "idle" | "active", updatedAt?: number): FakeThread => ({
      id,
      name: `[OmniCodex] Bridge staging ${"c".repeat(32)} abcdef12`,
      archived: false,
      status,
      ...(updatedAt === undefined ? {} : { updatedAt }),
    });
    runtime.threads.push(
      stage("old", "idle", oldTime),
      stage("owned", "idle", oldTime),
      stage("active", "active", oldTime),
      stage("recent", "idle", Date.now() / 1_000),
      stage("unknown-age", "idle"),
    );
    const archivedIds: string[] = [];
    const reconciler = new OmniCodexBridgeReconciler({
      candidate,
      dynamicTools,
      dataDirectory: root,
      bootstrapFactory: () => runtime.bootstrap,
      ownerInspector: { findThreadOwner: async (id) => (id === "owned" ? "desktop" : null) },
      threadLifecycle: {
        setTitle: async () => {
          throw new Error("unexpected rename");
        },
        setArchived: async (id, archived) => {
          archivedIds.push(id);
          const thread = runtime.threads.find((entry) => entry.id === id);
          if (thread !== undefined) thread.archived = archived;
        },
      },
    });
    await expect(reconciler.reconcile()).resolves.toMatchObject({ disposition: "current" });
    expect(archivedIds).toEqual(["old"]);
    expect(runtime.threads.find((thread) => thread.id === "old")?.archived).toBe(true);
    expect(runtime.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
  });

  it("does not report stale stage cleanup as successful when the lifecycle acknowledgement did not archive it", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime([]);
    await reconcilerFor(root, runtime.bootstrap).reconcile();
    runtime.threads.push({
      id: "stale",
      name: `[OmniCodex] Bridge staging ${"d".repeat(32)} abcdef12`,
      archived: false,
      status: "idle",
      updatedAt: 1,
    });
    const reconciler = new OmniCodexBridgeReconciler({
      candidate,
      dynamicTools,
      dataDirectory: root,
      bootstrapFactory: () => runtime.bootstrap,
      threadLifecycle: { setTitle: async () => undefined, setArchived: async () => undefined },
    });
    await expect(reconciler.reconcile()).rejects.toThrow("not authoritatively confirmed: stale");
  });

  it("defers an idle Bridge that still has a Codex desktop owner", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime([
      {
        id: "desktop-idle",
        name: OMNICODEX_BRIDGE_THREAD_TITLE,
        archived: false,
        status: "idle",
      },
    ]);
    const ownerInspector = {
      findThreadOwner: async (threadId: string) =>
        threadId === "desktop-idle" ? "desktop-client-1" : null,
    };

    await expect(
      reconcilerFor(root, runtime.bootstrap, ownerInspector).reconcile(),
    ).resolves.toMatchObject({
      threadId: "desktop-idle",
      disposition: "deferred_active_owner",
    });

    expect(runtime.calls.some((call) => call.method === "thread/archive")).toBe(false);
    expect(runtime.calls.some((call) => call.method === "thread/name/set")).toBe(false);
    expect(runtime.calls.some((call) => call.method === "thread/start")).toBe(false);
  });

  it("propagates the caller timeout to ownership inspection", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime([
      {
        id: "desktop-idle",
        name: OMNICODEX_BRIDGE_THREAD_TITLE,
        archived: false,
        status: "idle",
      },
    ]);
    const inspectedOptions: unknown[] = [];
    const reconciler = new OmniCodexBridgeReconciler({
      candidate,
      dynamicTools,
      dataDirectory: root,
      cwd: "C:\\work",
      bootstrapFactory: () => runtime.bootstrap,
      requestTimeoutMs: 8_765,
      ownerInspector: {
        findThreadOwner: async (_threadId, options) => {
          inspectedOptions.push(options);
          return "desktop-client-1";
        },
      },
    });

    await expect(reconciler.reconcile()).resolves.toMatchObject({
      disposition: "deferred_active_owner",
    });
    expect(inspectedOptions).toEqual([{ hostId: "local", timeoutMs: 8_765 }]);
  });

  it("preserves an ownership inspection failure instead of converting it to an owner result", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime([
      {
        id: "desktop-idle",
        name: OMNICODEX_BRIDGE_THREAD_TITLE,
        archived: false,
        status: "idle",
      },
    ]);
    const inspectionFailure = Object.assign(new Error("owner inspection transport failed"), {
      code: "OWNER_INSPECTION_TRANSPORT_FAILED",
    });
    const reconciler = new OmniCodexBridgeReconciler({
      candidate,
      dynamicTools,
      dataDirectory: root,
      cwd: "C:\\work",
      bootstrapFactory: () => runtime.bootstrap,
      ownerInspector: {
        findThreadOwner: async () => {
          throw inspectionFailure;
        },
      },
    });

    await expect(reconciler.reconcile()).rejects.toBe(inspectionFailure);
    expect(runtime.calls.some((call) => call.method === "thread/archive")).toBe(false);
    expect(runtime.calls.some((call) => call.method === "thread/start")).toBe(false);
    expect(runtime.stopped).toBe(1);
  });

  it("fails closed before mutation when duplicate exact active Bridges already exist", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime([
      { id: "duplicate-1", name: OMNICODEX_BRIDGE_THREAD_TITLE, archived: false, status: "idle" },
      { id: "duplicate-2", name: OMNICODEX_BRIDGE_THREAD_TITLE, archived: false, status: "idle" },
    ]);

    await expect(reconcilerFor(root, runtime.bootstrap).reconcile()).rejects.toThrow(
      "Multiple exact active [OmniCodex] Bridge threads",
    );

    expect(runtime.calls.some((call) => call.method === "thread/start")).toBe(false);
    expect(runtime.calls.some((call) => call.method === "thread/archive")).toBe(false);
    expect(runtime.stopped).toBe(1);
  });

  it("restores the previous exact Bridge when candidate promotion fails", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime(
      [{ id: "old", name: OMNICODEX_BRIDGE_THREAD_TITLE, archived: false, status: "idle" }],
      { failCanonicalRename: true },
    );

    await expect(reconcilerFor(root, runtime.bootstrap).reconcile()).rejects.toThrow(
      "injected promotion failure",
    );

    expect(runtime.threads.find((thread) => thread.id === "old")).toMatchObject({
      name: OMNICODEX_BRIDGE_THREAD_TITLE,
      archived: false,
    });
    expect(
      runtime.threads.filter(
        (thread) => !thread.archived && thread.name === OMNICODEX_BRIDGE_THREAD_TITLE,
      ),
    ).toHaveLength(1);
    expect(runtime.stopped).toBe(1);
  });

  it("accepts authoritative commit readback instead of racing an unknown native outcome", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime(
      [{ id: "old", name: OMNICODEX_BRIDGE_THREAD_TITLE, archived: false, status: "idle" }],
      { unknownCanonicalRenameAfterCommit: true },
    );

    await expect(reconcilerFor(root, runtime.bootstrap).reconcile()).resolves.toMatchObject({
      threadId: "created-1",
      disposition: "replaced",
    });

    expect(runtime.threads.find((thread) => thread.id === "old")).toMatchObject({
      archived: true,
    });
    expect(runtime.threads.find((thread) => thread.id === "created-1")).toMatchObject({
      name: OMNICODEX_BRIDGE_THREAD_TITLE,
      archived: false,
    });
    expect(
      runtime.calls.filter(
        (call) => call.method === "thread/unarchive" && call.params.threadId === "old",
      ),
    ).toHaveLength(0);
    const manifest = JSON.parse(
      await readFile(join(root, "bridge", "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({ phase: "stable", activeThreadId: "created-1" });
  });

  it("walks every cursor page and preserves archived canonical tombstones as inert history", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime(
      [
        { id: "noise-active", name: "[OmniCodex] Other", archived: false, status: "idle" },
        { id: "old", name: OMNICODEX_BRIDGE_THREAD_TITLE, archived: false, status: "idle" },
        {
          id: "noise-archived-1",
          name: "[OmniCodex] Other archived 1",
          archived: true,
          status: "idle",
        },
        {
          id: "noise-archived-2",
          name: "[OmniCodex] Other archived 2",
          archived: true,
          status: "idle",
        },
        {
          id: "historical-archived-exact",
          name: OMNICODEX_BRIDGE_THREAD_TITLE,
          archived: true,
          status: "idle",
        },
      ],
      { pageSize: 1 },
    );

    await expect(reconcilerFor(root, runtime.bootstrap).reconcile()).resolves.toMatchObject({
      threadId: "created-1",
      disposition: "replaced",
    });

    expect(
      runtime.calls.filter(
        (call) => call.method === "thread/list" && call.params.archived === false,
      ).length,
    ).toBeGreaterThan(1);
    expect(
      runtime.calls.filter((call) => call.method === "thread/list" && call.params.archived === true)
        .length,
    ).toBeGreaterThan(1);
    expect(runtime.threads.find((thread) => thread.id === "old")).toMatchObject({ archived: true });
    expect(runtime.threads.find((thread) => thread.id === "old")?.name).toBe(
      OMNICODEX_BRIDGE_THREAD_TITLE,
    );
    expect(runtime.threads.find((thread) => thread.id === "historical-archived-exact")?.name).toBe(
      OMNICODEX_BRIDGE_THREAD_TITLE,
    );
    expect(
      runtime.threads.filter(
        (thread) => !thread.archived && thread.name === OMNICODEX_BRIDGE_THREAD_TITLE,
      ),
    ).toEqual([expect.objectContaining({ id: "created-1" })]);
  });

  it("uses the app-global lifecycle boundary for persisted Bridge mutations", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime([
      {
        id: "legacy-without-rollout",
        name: OMNICODEX_BRIDGE_THREAD_TITLE,
        archived: false,
        status: "idle",
      },
    ]);
    const lifecycleCalls: Array<Record<string, unknown>> = [];
    const reconciler = new OmniCodexBridgeReconciler({
      candidate,
      dynamicTools,
      dataDirectory: root,
      cwd: "C:\\work",
      bootstrapFactory: () => runtime.bootstrap,
      threadLifecycle: {
        setTitle: async (threadId, title) => {
          lifecycleCalls.push({ operation: "title", threadId, title });
          const thread = runtime.threads.find((item) => item.id === threadId);
          if (thread === undefined) throw new Error("missing lifecycle thread");
          thread.name = title;
        },
        setArchived: async (threadId, archived) => {
          lifecycleCalls.push({ operation: "archived", threadId, archived });
          const thread = runtime.threads.find((item) => item.id === threadId);
          if (thread === undefined) throw new Error("missing lifecycle thread");
          thread.archived = archived;
        },
      },
    });

    await expect(reconciler.reconcile()).resolves.toMatchObject({
      threadId: "created-1",
      disposition: "replaced",
    });
    expect(lifecycleCalls).toEqual(
      expect.arrayContaining([
        { operation: "archived", threadId: "legacy-without-rollout", archived: true },
      ]),
    );
    expect(
      runtime.calls.some(
        (call) =>
          call.method === "thread/name/set" &&
          call.params.threadId === "created-1" &&
          call.params.name === OMNICODEX_BRIDGE_THREAD_TITLE,
      ),
    ).toBe(true);
    expect(
      runtime.calls.some(
        (call) =>
          (call.method === "thread/archive" || call.method === "thread/unarchive") &&
          call.params.threadId === "legacy-without-rollout",
      ),
    ).toBe(false);
  });

  it("recovers the candidate id after its first staged-name write fails", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime([], { failStagedRenameOnce: true });

    await expect(reconcilerFor(root, runtime.bootstrap).reconcile()).rejects.toThrow(
      "injected staged-name failure",
    );
    const interruptedManifest = JSON.parse(
      await readFile(join(root, "bridge", "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(interruptedManifest).toMatchObject({
      phase: "candidate_started",
      candidateThreadId: "created-1",
    });

    const appServerNameCallsBeforeRecovery = runtime.calls.filter(
      (call) => call.method === "thread/name/set",
    ).length;
    const lifecycleTitles: string[] = [];
    const recovered = new OmniCodexBridgeReconciler({
      candidate,
      dynamicTools,
      dataDirectory: root,
      cwd: "C:\\work",
      bootstrapFactory: () => runtime.bootstrap,
      threadLifecycle: {
        setTitle: async (threadId, title) => {
          lifecycleTitles.push(title);
          const thread = runtime.threads.find((item) => item.id === threadId);
          if (thread === undefined) throw new Error("missing lifecycle thread");
          thread.name = title;
        },
        setArchived: async (threadId, archived) => {
          const thread = runtime.threads.find((item) => item.id === threadId);
          if (thread === undefined) throw new Error("missing lifecycle thread");
          thread.archived = archived;
        },
      },
    });

    await expect(recovered.reconcile()).resolves.toMatchObject({
      threadId: "created-1",
      disposition: "created",
    });
    expect(runtime.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    expect(runtime.calls.filter((call) => call.method === "thread/name/set")).toHaveLength(
      appServerNameCallsBeforeRecovery,
    );
    expect(lifecycleTitles).toEqual([
      expect.stringMatching(/^\[OmniCodex\] Bridge staging /),
      OMNICODEX_BRIDGE_THREAD_TITLE,
    ]);
  });

  it("does not advance a persisted promotion when app-global lifecycle fails", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime([
      {
        id: "legacy",
        name: OMNICODEX_BRIDGE_THREAD_TITLE,
        archived: false,
        status: "idle",
      },
    ]);
    const reconciler = new OmniCodexBridgeReconciler({
      candidate,
      dynamicTools,
      dataDirectory: root,
      cwd: "C:\\work",
      bootstrapFactory: () => runtime.bootstrap,
      threadLifecycle: {
        setTitle: async () => {
          throw new Error("native lifecycle rejected");
        },
        setArchived: async () => {
          throw new Error("native lifecycle rejected");
        },
      },
    });

    await expect(reconciler.reconcile()).rejects.toThrow("native lifecycle rejected");
    const manifest = JSON.parse(
      await readFile(join(root, "bridge", "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest.phase).not.toBe("stable");
    expect(runtime.threads.find((thread) => thread.id === "legacy")).toMatchObject({
      name: OMNICODEX_BRIDGE_THREAD_TITLE,
      archived: false,
    });
    expect(
      runtime.calls.some(
        (call) =>
          (call.method === "thread/archive" || call.method === "thread/name/set") &&
          call.params.threadId === "legacy",
      ),
    ).toBe(false);
  });

  it("replaces a pre-persistence candidate whose source rollout was never created", async () => {
    const root = await temporaryDirectory();
    const digest = omniCodexBridgeRegistryDigest(dynamicTools);
    await mkdir(join(root, "bridge"), { recursive: true });
    await writeFile(
      join(root, "bridge", "manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        phase: "candidate_started",
        desiredRegistryDigest: digest,
        candidateThreadId: "vanished-empty-candidate",
        candidateTitle: `[OmniCodex] Bridge staging ${digest.slice(0, 32)} vanished`,
        updatedAtUnixMs: Date.now(),
      })}\n`,
      "utf8",
    );
    const runtime = fakeRuntime([], {
      missingReadError:
        "invalid paginated history lineage for vanished-empty-candidate: missing source rollout",
    });

    await expect(reconcilerFor(root, runtime.bootstrap).reconcile()).resolves.toMatchObject({
      threadId: "created-1",
      disposition: "created",
    });
    expect(runtime.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
  });

  it("keeps an archived state-only tombstone while recovering an interrupted promotion", async () => {
    const root = await temporaryDirectory();
    const digest = omniCodexBridgeRegistryDigest(dynamicTools);
    const stagedName = `[OmniCodex] Bridge staging ${digest.slice(0, 32)} recover01`;
    await mkdir(join(root, "bridge"), { recursive: true });
    await writeFile(
      join(root, "bridge", "manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        phase: "old_archived",
        desiredRegistryDigest: digest,
        previousThreadId: "old-archived-exact",
        candidateThreadId: "staged-recovery",
        candidateTitle: stagedName,
        updatedAtUnixMs: Date.now(),
      })}\n`,
      "utf8",
    );
    const runtime = fakeRuntime([
      {
        id: "old-archived-exact",
        name: OMNICODEX_BRIDGE_THREAD_TITLE,
        archived: true,
        status: "idle",
      },
      {
        id: "staged-recovery",
        name: stagedName,
        archived: false,
        status: "idle",
      },
    ]);

    await expect(reconcilerFor(root, runtime.bootstrap).reconcile()).resolves.toMatchObject({
      threadId: "staged-recovery",
      disposition: "replaced",
    });
    expect(runtime.threads.find((thread) => thread.id === "old-archived-exact")).toMatchObject({
      archived: true,
      name: OMNICODEX_BRIDGE_THREAD_TITLE,
    });
    expect(
      runtime.threads.filter(
        (thread) => !thread.archived && thread.name === OMNICODEX_BRIDGE_THREAD_TITLE,
      ),
    ).toEqual([expect.objectContaining({ id: "staged-recovery" })]);
  });

  it("adopts a crash-left staged Bridge instead of creating a duplicate", async () => {
    const root = await temporaryDirectory();
    const digest = omniCodexBridgeRegistryDigest(dynamicTools);
    const runtime = fakeRuntime([
      {
        id: "staged-after-crash",
        name: `[OmniCodex] Bridge staging ${digest.slice(0, 32)} crash001`,
        archived: false,
        status: "idle",
      },
    ]);

    await expect(reconcilerFor(root, runtime.bootstrap).reconcile()).resolves.toMatchObject({
      threadId: "staged-after-crash",
      disposition: "created",
    });

    expect(runtime.calls.some((call) => call.method === "thread/start")).toBe(false);
    expect(
      runtime.threads.filter((thread) => thread.name === OMNICODEX_BRIDGE_THREAD_TITLE),
    ).toHaveLength(1);
  });

  it("serializes concurrent reconcilers across the process lock", async () => {
    const root = await temporaryDirectory();
    const runtime = fakeRuntime([], { startDelayMs: 75 });

    const results = await Promise.all([
      reconcilerFor(root, runtime.bootstrap).reconcile(),
      reconcilerFor(root, runtime.bootstrap).reconcile(),
    ]);

    expect(results.map((result) => result.threadId)).toEqual(["created-1", "created-1"]);
    expect(runtime.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    expect(runtime.maximumActiveBootstraps).toBe(1);
    expect(runtime.stopped).toBe(2);
  });

  it("recovers a dead process lock before reconciliation", async () => {
    const root = await temporaryDirectory();
    const lock = join(root, "bridge", "reconcile.lock");
    const nonce = "dead-owner";
    const holderDirectory = `holder-${createHash("sha256").update(nonce).digest("hex")}`;
    const renewedAtUnixMs = Date.now() - 300_000;
    await mkdir(join(lock, holderDirectory), { recursive: true });
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({
        schemaVersion: 1,
        nonce,
        fencingToken: 1,
        holderDirectory,
        acquiredAtUnixMs: renewedAtUnixMs,
      }),
      "utf8",
    );
    await writeFile(
      join(lock, holderDirectory, "heartbeat.json"),
      JSON.stringify({
        schemaVersion: 1,
        nonce,
        fencingToken: 1,
        renewedAtUnixMs,
      }),
      "utf8",
    );
    const runtime = fakeRuntime([]);

    await expect(reconcilerFor(root, runtime.bootstrap).reconcile()).resolves.toMatchObject({
      threadId: "created-1",
      disposition: "created",
    });
    expect(runtime.started).toBe(1);
    expect(runtime.stopped).toBe(1);
  });
});

function reconcilerFor(
  root: string,
  bootstrap: OmniCodexBridgeBootstrap,
  ownerInspector?: { findThreadOwner(threadId: string): Promise<string | null> },
): OmniCodexBridgeReconciler {
  return new OmniCodexBridgeReconciler({
    candidate,
    dynamicTools,
    dataDirectory: root,
    cwd: "C:\\work",
    bootstrapFactory: () => bootstrap,
    ...(ownerInspector === undefined ? {} : { ownerInspector }),
  });
}

function fakeRuntime(
  initial: FakeThread[],
  options: {
    failCanonicalRename?: boolean;
    failStagedRenameOnce?: boolean;
    hideUnmaterializedThreads?: boolean;
    hideUntitledThreads?: boolean;
    missingReadError?: string;
    pageSize?: number;
    startDelayMs?: number;
    unknownCanonicalRenameAfterCommit?: boolean;
  } = {},
): {
  bootstrap: OmniCodexBridgeBootstrap;
  threads: FakeThread[];
  calls: Array<{ method: string; params: Record<string, unknown>; timeoutMs?: number }>;
  readonly started: number;
  readonly stopped: number;
  readonly maximumActiveBootstraps: number;
  materializeThread(threadId: string): void;
} {
  const threads = initial.map((thread) => ({ ...thread }));
  const calls: Array<{ method: string; params: Record<string, unknown>; timeoutMs?: number }> = [];
  let started = 0;
  let stopped = 0;
  let activeBootstraps = 0;
  let maximumActiveBootstraps = 0;
  let nextId = 1;
  let stagedRenameFailuresRemaining = options.failStagedRenameOnce === true ? 1 : 0;
  const unmaterializedThreadIds = new Set<string>();
  const client = {
    request: async <T>(
      method: string,
      params: Record<string, unknown>,
      timeoutMs?: number,
    ): Promise<T> => {
      calls.push({ method, params, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
      if (method === "thread/list") {
        const archived = params.archived === true;
        const matching = threads.filter(
          (thread) =>
            thread.archived === archived &&
            (options.hideUnmaterializedThreads !== true ||
              !unmaterializedThreadIds.has(thread.id)) &&
            (options.hideUntitledThreads !== true || thread.name.length > 0),
        );
        const offset = typeof params.cursor === "string" ? Number(params.cursor) : 0;
        const pageSize = options.pageSize ?? 100;
        const data = matching.slice(offset, offset + pageSize);
        const nextOffset = offset + data.length;
        return {
          data: data.map((thread) => ({
            id: thread.id,
            name: thread.name,
            status: { type: thread.status },
            ...(thread.path === undefined ? {} : { path: thread.path }),
            ...(thread.updatedAt === undefined ? {} : { updatedAt: thread.updatedAt }),
          })),
          ...(nextOffset < matching.length ? { nextCursor: String(nextOffset) } : {}),
        } as T;
      }
      if (method === "thread/read") {
        const thread = threads.find((item) => item.id === params.threadId);
        if (thread === undefined)
          throw new Error(options.missingReadError ?? "missing fake thread");
        return {
          thread: {
            ...thread,
            status: { type: thread.status },
            turns: unmaterializedThreadIds.has(thread.id) ? [] : [{ id: "durable-turn" }],
          },
        } as T;
      }
      if (method === "thread/start") {
        const id = `created-${nextId}`;
        nextId += 1;
        threads.push({ id, name: "", archived: false, status: "idle" });
        unmaterializedThreadIds.add(id);
        return { thread: { id } } as T;
      }
      if (method === "thread/name/set") {
        const thread = threads.find((item) => item.id === params.threadId);
        if (thread === undefined) throw new Error("missing fake thread");
        if (
          typeof params.name === "string" &&
          params.name.startsWith("[OmniCodex] Bridge staging ") &&
          stagedRenameFailuresRemaining > 0
        ) {
          stagedRenameFailuresRemaining -= 1;
          throw new Error("injected staged-name failure");
        }
        if (
          params.name === OMNICODEX_BRIDGE_THREAD_TITLE &&
          thread.id.startsWith("created-") &&
          options.failCanonicalRename === true
        ) {
          throw new Error("injected promotion failure");
        }
        thread.name = String(params.name);
        if (
          params.name === OMNICODEX_BRIDGE_THREAD_TITLE &&
          thread.id.startsWith("created-") &&
          options.unknownCanonicalRenameAfterCommit === true
        ) {
          const error = new Error("injected native mutation has an unknown outcome") as Error & {
            dispatched: boolean;
          };
          error.name = "NativePipeTransportError";
          error.dispatched = true;
          throw error;
        }
        return { ok: true } as T;
      }
      if (method === "thread/goal/set") {
        const thread = threads.find((item) => item.id === params.threadId);
        if (thread === undefined) throw new Error("missing fake thread");
        unmaterializedThreadIds.delete(thread.id);
        return { ok: true } as T;
      }
      if (method === "thread/goal/clear") {
        const thread = threads.find((item) => item.id === params.threadId);
        if (thread === undefined) throw new Error("missing fake thread");
        return { ok: true } as T;
      }
      if (method === "thread/resume") {
        const thread = threads.find((item) => item.id === params.threadId);
        if (thread === undefined) throw new Error("missing fake thread");
        return { thread: { ...thread } } as T;
      }
      if (method === "thread/archive" || method === "thread/unarchive") {
        const thread = threads.find((item) => item.id === params.threadId);
        if (thread === undefined) throw new Error("missing fake thread");
        thread.archived = method === "thread/archive";
        return { ok: true } as T;
      }
      throw new Error(`unexpected fake App Server method ${method}`);
    },
  };
  const bootstrap: OmniCodexBridgeBootstrap = {
    client,
    start: async () => {
      started += 1;
      activeBootstraps += 1;
      maximumActiveBootstraps = Math.max(maximumActiveBootstraps, activeBootstraps);
      if (options.startDelayMs !== undefined) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, options.startDelayMs));
      }
    },
    stop: async () => {
      stopped += 1;
      activeBootstraps -= 1;
    },
  };
  return {
    bootstrap,
    threads,
    calls,
    get started() {
      return started;
    },
    get stopped() {
      return stopped;
    },
    get maximumActiveBootstraps() {
      return maximumActiveBootstraps;
    },
    materializeThread(threadId: string) {
      if (!threads.some((thread) => thread.id === threadId)) {
        throw new Error(`missing fake thread ${threadId}`);
      }
      unmaterializedThreadIds.delete(threadId);
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "omnicodex-bridge-test-"));
  temporaryDirectories.push(path);
  return path;
}
