import { describe, expect, it, vi } from "vitest";
import { signalDesktopRuntimeDisconnection } from "../src/application/desktop-runtime-disconnection.js";
import {
  OmniCodexBridgeThreadContext,
  OmniCodexCatalogConvergence,
  OmniCodexGatewayService,
  type OmniCodexPreparedRuntime,
  type OmniCodexPrepareRuntimeOptions,
  type OmniCodexRuntimeGateway,
  resolveChatGptConversationActivity,
} from "../src/application/omnicodex-gateway-service.js";
import type { RuntimeCandidate } from "../src/domain/runtime.js";
import {
  type DirectJobDispatchAdapter,
  DirectJobManager,
} from "../src/infrastructure/mcp/direct-job-mcp-tools.js";
import { DirectJobStore } from "../src/infrastructure/mcp/direct-job-store.js";
import { DirectScheduleManager } from "../src/infrastructure/mcp/direct-schedule-mcp-tools.js";
import { DirectScheduleStore } from "../src/infrastructure/mcp/direct-schedule-store.js";
import { CodexAppToolsSharedReadinessError } from "../src/infrastructure/windows/codex-app-tools-pipe-client.js";

const oldCandidate: RuntimeCandidate = {
  executablePath: "C:\\Codex\\old\\codex.exe",
  canonicalPath: "C:\\Codex\\old\\codex.exe",
  source: "managed_install",
  buildSha256: "1".repeat(64),
};
const newCandidate: RuntimeCandidate = {
  executablePath: "C:\\Codex\\new\\codex.exe",
  canonicalPath: "C:\\Codex\\new\\codex.exe",
  source: "path",
  buildSha256: "2".repeat(64),
};

describe("OmniCodex runtime switch", () => {
  it("accepts an exact idle task whose latest persisted turn has only the user message", async () => {
    const activity = await resolveChatGptConversationActivity(
      {
        structuredContent: {
          pinnedThreads: [],
          threads: [{ id: "web-conversation", kind: "chatgpt", status: "idle" }],
        },
      },
      ["web-conversation"],
      async () => ({
        thread: { id: "web-conversation", kind: "chatgpt", status: "idle" },
        page: { order: "newest_first" },
        turns: [
          {
            items: [{ type: "userMessage", text: "resume" }],
            error: null,
          },
        ],
      }),
    );

    expect(activity).toMatchObject({
      threads: [{ id: "web-conversation", kind: "chatgpt", status: "idle" }],
    });
  });

  it("tracks the authoritative Bridge thread across initial and hot reconciliation", () => {
    const context = new OmniCodexBridgeThreadContext();
    expect(context.currentThreadId).toBeUndefined();

    const initial = {
      threadId: "bridge-initial",
      registryDigest: "registry-a",
      disposition: "current" as const,
    };
    expect(context.accept(initial)).toBe(initial);
    expect(context.currentThreadId).toBe("bridge-initial");

    context.accept({
      threadId: "bridge-hot-reconciled",
      registryDigest: "registry-b",
      disposition: "replaced",
    });
    expect(context.currentThreadId).toBe("bridge-hot-reconciled");
    expect(() =>
      context.accept({
        threadId: " ",
        registryDigest: "registry-c",
        disposition: "created",
      }),
    ).toThrow("did not return a canonical thread id");
    expect(context.currentThreadId).toBe("bridge-hot-reconciled");
  });

  it("rebuilds a fully cleaned owned runtime after one transient startup-readiness failure", async () => {
    const events: string[] = [];
    let prepareAttempts = 0;
    const service = makeStartupRecoveryService(events, async () => {
      prepareAttempts += 1;
      const name = `attempt-${prepareAttempts}`;
      events.push(`${name}:prepare`);
      const runtime = fakeRuntime(name, oldCandidate, events);
      if (prepareAttempts !== 1) return runtime;
      return {
        ...runtime,
        directProbe: async () => {
          events.push(`${name}:probe`);
          throw new Error("App Server request timed out: thread/list");
        },
      };
    });

    await expect(service.start()).resolves.toMatchObject({
      lifecycle: "ready",
      candidate: oldCandidate,
    });
    expect(prepareAttempts).toBe(2);
    expect(events).toEqual([
      "attempt-1:prepare",
      "attempt-1:probe",
      "attempt-1:gateway-stop",
      "attempt-1:children-stop",
      "boundary:verify",
      "attempt-2:prepare",
      "attempt-2:probe",
      "boundary:verify",
      "attempt-2:gateway-start",
      "boundary:verify",
    ]);
  });

  it("retries shared Desktop pipe readiness on the highest-priority runtime only", async () => {
    const events: string[] = [];
    const preparedCandidates: RuntimeCandidate[] = [];
    let latestAttempts = 0;
    const service = makeStartupRecoveryService(
      events,
      async (candidate) => {
        preparedCandidates.push(candidate);
        if (candidate === oldCandidate) {
          throw new Error("older runtime must not be selected for shared Desktop readiness");
        }
        latestAttempts += 1;
        if (latestAttempts === 1) {
          throw new CodexAppToolsSharedReadinessError(
            "Codex Desktop app-global tools pipe is rotating",
          );
        }
        return fakeRuntime("latest-ready", newCandidate, events);
      },
      async () => undefined,
      [newCandidate, oldCandidate],
    );

    await expect(service.start()).resolves.toMatchObject({
      lifecycle: "ready",
      candidate: newCandidate,
    });
    expect(preparedCandidates).toEqual([newCandidate, newCandidate]);
  });

  it("honors a caller-bounded shared-readiness window without trying an older runtime", async () => {
    const events: string[] = [];
    const preparedCandidates: RuntimeCandidate[] = [];
    const service = makeStartupRecoveryService(
      events,
      async (candidate) => {
        preparedCandidates.push(candidate);
        if (candidate === oldCandidate) return fakeRuntime("forbidden-old", oldCandidate, events);
        throw new CodexAppToolsSharedReadinessError(
          "Codex Desktop app-global tools pipe remains unavailable",
        );
      },
      async () => undefined,
      [newCandidate, oldCandidate],
      { startupReadinessMaxPasses: 2 },
    );

    await expect(service.start()).rejects.toThrow("startup pass 2/2");
    expect(preparedCandidates).toEqual([newCandidate, newCandidate]);
    expect(service.status).toMatchObject({ lifecycle: "failed" });
  });

  it("falls back only for a candidate-specific App Server protocol incompatibility", async () => {
    const events: string[] = [];
    const preparedCandidates: RuntimeCandidate[] = [];
    const service = makeStartupRecoveryService(
      events,
      async (candidate) => {
        preparedCandidates.push(candidate);
        if (candidate === newCandidate) {
          throw new Error("Unsupported Codex App Server protocol version");
        }
        return fakeRuntime("compatible-old", oldCandidate, events);
      },
      async () => undefined,
      [newCandidate, oldCandidate],
    );

    await expect(service.start()).resolves.toMatchObject({
      lifecycle: "ready",
      candidate: oldCandidate,
    });
    expect(preparedCandidates).toEqual([newCandidate, oldCandidate]);
  });

  it("falls back when the highest-priority executable cannot be spawned", async () => {
    const events: string[] = [];
    const preparedCandidates: RuntimeCandidate[] = [];
    const service = makeStartupRecoveryService(
      events,
      async (candidate) => {
        preparedCandidates.push(candidate);
        if (candidate === newCandidate) {
          throw Object.assign(new Error("spawn C:\\Codex\\new\\codex.exe ENOENT"), {
            code: "ENOENT",
            syscall: "spawn C:\\Codex\\new\\codex.exe",
          });
        }
        return fakeRuntime("spawn-fallback", oldCandidate, events);
      },
      async () => undefined,
      [newCandidate, oldCandidate],
    );

    await expect(service.start()).resolves.toMatchObject({
      lifecycle: "ready",
      candidate: oldCandidate,
    });
    expect(preparedCandidates).toEqual([newCandidate, oldCandidate]);
  });

  it("falls back when one candidate generates an incompatible App Server schema", async () => {
    const events: string[] = [];
    const preparedCandidates: RuntimeCandidate[] = [];
    const service = makeStartupRecoveryService(
      events,
      async (candidate) => {
        preparedCandidates.push(candidate);
        if (candidate === newCandidate) {
          throw new Error(
            "Codex App Server schema generation failed (code=2, signal=null): unknown option",
          );
        }
        return fakeRuntime("schema-fallback", oldCandidate, events);
      },
      async () => undefined,
      [newCandidate, oldCandidate],
    );

    await expect(service.start()).resolves.toMatchObject({
      lifecycle: "ready",
      candidate: oldCandidate,
    });
    expect(preparedCandidates).toEqual([newCandidate, oldCandidate]);
  });

  it("does not downgrade for an unclassified common startup failure", async () => {
    const events: string[] = [];
    const preparedCandidates: RuntimeCandidate[] = [];
    const service = makeStartupRecoveryService(
      events,
      async (candidate) => {
        preparedCandidates.push(candidate);
        if (candidate === newCandidate) throw new Error("shared durable store is unavailable");
        return fakeRuntime("forbidden-common-fallback", oldCandidate, events);
      },
      async () => undefined,
      [newCandidate, oldCandidate],
    );

    await expect(service.start()).rejects.toThrow("shared durable store is unavailable");
    expect(preparedCandidates).toEqual([newCandidate]);
  });

  it("does not retry a non-transient startup failure", async () => {
    const events: string[] = [];
    let prepareAttempts = 0;
    const service = makeStartupRecoveryService(events, async () => {
      prepareAttempts += 1;
      const runtime = fakeRuntime("non-transient", oldCandidate, events);
      return {
        ...runtime,
        directProbe: async () => {
          events.push("non-transient:probe");
          throw new Error("Unsupported Codex App Server protocol version");
        },
      };
    });

    await expect(service.start()).rejects.toThrow("Unsupported Codex App Server protocol version");
    expect(prepareAttempts).toBe(1);
    expect(events).toEqual([
      "non-transient:probe",
      "non-transient:gateway-stop",
      "non-transient:children-stop",
      "boundary:verify",
    ]);
    expect(service.status).toMatchObject({ lifecycle: "failed" });
  });

  it("stops at a caller-supplied pass limit when readiness remains transiently unavailable", async () => {
    const events: string[] = [];
    let prepareAttempts = 0;
    const service = makeStartupRecoveryService(
      events,
      async () => {
        prepareAttempts += 1;
        const name = `persistent-transient-${prepareAttempts}`;
        const runtime = fakeRuntime(name, oldCandidate, events);
        return {
          ...runtime,
          directProbe: async () => {
            events.push(`${name}:probe`);
            throw new Error("JSONL App Server stream ended");
          },
        };
      },
      async () => undefined,
      [oldCandidate],
      { startupReadinessMaxPasses: 2 },
    );

    await expect(service.start()).rejects.toThrow("startup pass 2/2");
    expect(prepareAttempts).toBe(2);
    expect(events.filter((event) => event.endsWith(":children-stop"))).toHaveLength(2);
    expect(service.status).toMatchObject({ lifecycle: "failed" });
  });

  it("does not impose the former two-pass limit on transient readiness", async () => {
    const events: string[] = [];
    let prepareAttempts = 0;
    const service = makeStartupRecoveryService(events, async () => {
      prepareAttempts += 1;
      const name = `unbounded-transient-${prepareAttempts}`;
      const runtime = fakeRuntime(name, oldCandidate, events);
      if (prepareAttempts >= 3) return runtime;
      return {
        ...runtime,
        directProbe: async () => {
          events.push(`${name}:probe`);
          throw new Error("JSONL App Server stream ended");
        },
      };
    });

    await expect(service.start()).resolves.toMatchObject({
      lifecycle: "ready",
      candidate: oldCandidate,
    });
    expect(prepareAttempts).toBe(3);
    await service.stop();
  });

  it("does not retry when cleanup of a transiently failed owned runtime fails", async () => {
    const events: string[] = [];
    let prepareAttempts = 0;
    const service = makeStartupRecoveryService(events, async () => {
      prepareAttempts += 1;
      const runtime = fakeRuntime("cleanup-failure", oldCandidate, events);
      return {
        ...runtime,
        directProbe: async () => {
          events.push("cleanup-failure:probe");
          throw new Error("Codex functions.exec returned no parseable JSON result");
        },
        stopChildren: async () => {
          events.push("cleanup-failure:children-stop");
          throw new Error("owned child retained its process handle");
        },
      };
    });

    await expect(service.start()).rejects.toThrow(
      "Runtime start failed and the owned candidate did not stop cleanly",
    );
    expect(prepareAttempts).toBe(1);
    expect(events).toEqual([
      "cleanup-failure:probe",
      "cleanup-failure:gateway-stop",
      "cleanup-failure:children-stop",
    ]);
    expect(service.status).toMatchObject({ lifecycle: "failed" });
  });

  it("does not retry a non-interference boundary violation", async () => {
    const events: string[] = [];
    let prepareAttempts = 0;
    const service = makeStartupRecoveryService(
      events,
      async () => {
        prepareAttempts += 1;
        return fakeRuntime("boundary-failure", oldCandidate, events);
      },
      async () => {
        throw new Error("CODEX_BOUNDARY_CHANGED");
      },
    );

    await expect(service.start()).rejects.toThrow("CODEX_BOUNDARY_CHANGED");
    expect(prepareAttempts).toBe(1);
    expect(events).toEqual([
      "boundary-failure:probe",
      "boundary:verify",
      "boundary-failure:gateway-stop",
      "boundary-failure:children-stop",
      "boundary:verify",
    ]);
    expect(service.status).toMatchObject({ lifecycle: "failed" });
  });

  it("closes admission, drains accepted work, then stops exact-owned runtime resources", async () => {
    const events: string[] = [];
    const service = makeService(
      new Map([[oldCandidate.canonicalPath, fakeRuntime("old", oldCandidate, events)]]),
      events,
      async () => undefined,
      [oldCandidate],
    );

    await service.start();
    events.length = 0;
    await expect(service.stop()).resolves.toMatchObject({ lifecycle: "stopped" });

    expect(events).toEqual([
      "old:drain",
      "old:await-drained",
      "old:gateway-stop",
      "old:children-stop",
    ]);
  });

  it("waits past the former implicit thirty-second shutdown cutoff for accepted work", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const runtime = fakeRuntime("old", oldCandidate, events);
    const gateway = runtime.gateway as FakeGateway;
    let releaseAccepted!: () => void;
    const accepted = new Promise<void>((resolve) => {
      releaseAccepted = resolve;
    });
    gateway.setDrainCompletion(accepted);
    const service = makeService(
      new Map([[oldCandidate.canonicalPath, runtime]]),
      events,
      async () => undefined,
      [oldCandidate],
    );
    try {
      await service.start();
      events.length = 0;
      let stopped = false;
      const stopping = service.stop().finally(() => {
        stopped = true;
      });

      await vi.advanceTimersByTimeAsync(30_001);
      expect(stopped).toBe(false);
      expect(gateway.runtimeStatus).toMatchObject({
        admission: "draining",
        activeMcpRequests: 1,
      });
      expect(events).toEqual(["old:drain", "old:await-drained"]);

      releaseAccepted();
      await expect(stopping).resolves.toMatchObject({ lifecycle: "stopped" });
      expect(gateway.stopTimeouts).toEqual([undefined]);
    } finally {
      releaseAccepted();
      vi.useRealTimers();
      await service.stop().catch(() => undefined);
    }
  });

  it("retains a runtime after an explicit shutdown drain deadline until late work settles", async () => {
    const events: string[] = [];
    const runtime = fakeRuntime("old", oldCandidate, events);
    const gateway = runtime.gateway as FakeGateway;
    let releaseAccepted!: () => void;
    const accepted = new Promise<void>((resolve) => {
      releaseAccepted = resolve;
    });
    gateway.setDrainCompletion(accepted);
    const service = makeService(
      new Map([[oldCandidate.canonicalPath, runtime]]),
      events,
      async () => undefined,
      [oldCandidate],
      undefined,
      { shutdownDrainTimeoutMs: 10, shutdownPhaseTimeoutMs: 100 },
    );
    try {
      await service.start();
      events.length = 0;
      await expect(service.stop()).rejects.toThrow("did not stop cleanly");
      expect(events).toEqual(["old:drain", "old:await-drained"]);
      expect(gateway.stopTimeouts).toEqual([]);
      expect(gateway.runtimeStatus).toMatchObject({
        admission: "draining",
        activeMcpRequests: 1,
      });

      releaseAccepted();
      await accepted;
      await expect(service.stop()).resolves.toMatchObject({ lifecycle: "stopped" });
      expect(events).toEqual([
        "old:drain",
        "old:await-drained",
        "old:await-drained",
        "old:gateway-stop",
        "old:children-stop",
      ]);
    } finally {
      releaseAccepted();
      await service.stop().catch(() => undefined);
    }
  });

  it("accepts explicit lifecycle deadlines above the former five-minute ceiling", async () => {
    const events: string[] = [];
    const runtime = fakeRuntime("old", oldCandidate, events);
    const gateway = runtime.gateway as FakeGateway;
    const service = makeService(
      new Map([[oldCandidate.canonicalPath, runtime]]),
      events,
      async () => undefined,
      [oldCandidate],
      undefined,
      { shutdownDrainTimeoutMs: 300_001, shutdownPhaseTimeoutMs: 300_002 },
    );

    await service.start();
    await expect(service.stop()).resolves.toMatchObject({ lifecycle: "stopped" });
    expect(gateway.stopTimeouts).toEqual([300_002]);
  });

  it("propagates the operator shutdown deadline through listener and child cleanup", async () => {
    const events: string[] = [];
    const runtime = fakeRuntime("old", oldCandidate, events);
    const gateway = runtime.gateway as FakeGateway;
    const service = makeService(
      new Map([[oldCandidate.canonicalPath, runtime]]),
      events,
      async () => undefined,
      [oldCandidate],
    );

    await service.start();
    await expect(service.stop(123_456)).resolves.toMatchObject({ lifecycle: "stopped" });
    expect(gateway.stopTimeouts).toEqual([123_456]);
  });

  it("restores admission after an explicit rolling drain deadline and keeps late work alive", async () => {
    const events: string[] = [];
    const runtimes = runtimeFixtures(events);
    const oldRuntime = runtimes.get(oldCandidate.canonicalPath);
    if (oldRuntime === undefined) throw new Error("missing old runtime fixture");
    const oldGateway = oldRuntime.gateway as FakeGateway;
    let releaseAccepted!: () => void;
    let lateSettled = false;
    const accepted = new Promise<void>((resolve) => {
      releaseAccepted = resolve;
    }).then(() => {
      lateSettled = true;
    });
    oldGateway.setDrainCompletion(accepted);
    const service = makeService(runtimes, events, async () => undefined);
    try {
      await service.start();
      events.length = 0;
      await expect(service.switchRuntime(newCandidate.canonicalPath, 10)).rejects.toThrow(
        "Runtime drain deadline expired",
      );
      expect(service.status).toMatchObject({ lifecycle: "ready", candidate: oldCandidate });
      expect(oldGateway.runtimeStatus).toMatchObject({
        admission: "open",
        activeMcpRequests: 1,
      });
      expect(events).not.toContain("old:gateway-stop");

      releaseAccepted();
      await accepted;
      expect(lateSettled).toBe(true);
    } finally {
      releaseAccepted();
      await service.stop().catch(() => undefined);
    }
  });

  it("invalidates a pending start and cleans its late exact-owned runtime without publishing it", async () => {
    const events: string[] = [];
    let releasePrepared!: (runtime: OmniCodexPreparedRuntime) => void;
    let enteredPrepare!: () => void;
    const prepared = new Promise<OmniCodexPreparedRuntime>((resolvePrepared) => {
      releasePrepared = resolvePrepared;
    });
    const preparing = new Promise<void>((resolvePreparing) => {
      enteredPrepare = resolvePreparing;
    });
    const service = new OmniCodexGatewayService({
      authorize: () => ({ ok: false, status: 401 }),
      discovery: {
        discover: async () => ({ candidates: [oldCandidate], warnings: [] }),
      },
      prepareRuntime: async () => {
        enteredPrepare();
        return prepared;
      },
      shutdownDrainTimeoutMs: 100,
      shutdownPhaseTimeoutMs: 100,
    });

    const starting = service.start();
    await preparing;
    const stopping = service.stop();
    releasePrepared(fakeRuntime("late", oldCandidate, events));

    await expect(starting).rejects.toThrow("invalidated by shutdown");
    await expect(stopping).resolves.toMatchObject({ lifecycle: "stopped" });
    expect(events).toEqual([
      "late:drain",
      "late:await-drained",
      "late:gateway-stop",
      "late:children-stop",
    ]);
    expect(events).not.toContain("late:gateway-start");
  });

  it("aborts active runtime preparation so partial owned resources can clean before stop", async () => {
    const events: string[] = [];
    let enteredPrepare!: () => void;
    const preparing = new Promise<void>((resolvePreparing) => {
      enteredPrepare = resolvePreparing;
    });
    let preparationSignal: AbortSignal | undefined;
    const service = new OmniCodexGatewayService({
      authorize: () => ({ ok: false, status: 401 }),
      discovery: {
        discover: async () => ({ candidates: [oldCandidate], warnings: [] }),
      },
      prepareRuntime: async (_candidate, options) => {
        preparationSignal = options?.signal;
        if (preparationSignal === undefined) {
          throw new Error("runtime preparation signal was omitted");
        }
        events.push("partial:started");
        enteredPrepare();
        try {
          await new Promise<never>((_resolve, reject) => {
            const rejectFromAbort = () =>
              reject(
                preparationSignal?.reason instanceof Error
                  ? preparationSignal.reason
                  : new Error("runtime preparation was aborted"),
              );
            if (preparationSignal?.aborted === true) rejectFromAbort();
            else preparationSignal?.addEventListener("abort", rejectFromAbort, { once: true });
          });
        } finally {
          events.push("partial:children-stop");
        }
        throw new Error("aborted runtime preparation unexpectedly continued");
      },
    });

    const starting = service.start();
    await preparing;
    const stopping = service.stop();

    await expect(starting).rejects.toThrow("invalidated by shutdown");
    await expect(stopping).resolves.toMatchObject({ lifecycle: "stopped" });
    expect(preparationSignal?.aborted).toBe(true);
    expect(events).toEqual(["partial:started", "partial:children-stop"]);
  });

  it("bounds a transition that never returns and records terminal cleanup failure", async () => {
    let enteredPrepare!: () => void;
    const preparing = new Promise<void>((resolvePreparing) => {
      enteredPrepare = resolvePreparing;
    });
    const neverPrepared = new Promise<OmniCodexPreparedRuntime>(() => undefined);
    const service = new OmniCodexGatewayService({
      authorize: () => ({ ok: false, status: 401 }),
      discovery: {
        discover: async () => ({ candidates: [oldCandidate], warnings: [] }),
      },
      prepareRuntime: async () => {
        enteredPrepare();
        return neverPrepared;
      },
      shutdownDrainTimeoutMs: 10,
      shutdownPhaseTimeoutMs: 10,
    });

    void service.start().catch(() => undefined);
    await preparing;
    await expect(service.stop()).rejects.toThrow("did not stop cleanly");
    expect(service.status).toMatchObject({
      lifecycle: "failed",
      lastError: expect.stringContaining("transition"),
    });
  });

  it("reports a deferred Bridge as converging and only becomes ready after readback", async () => {
    const events: string[] = [];
    let current = false;
    let publish: (() => Promise<void> | void) | undefined;
    const runtime: OmniCodexPreparedRuntime = {
      ...fakeRuntime("old", oldCandidate, events),
      get bridgeDisposition() {
        return current ? "replaced" : "deferred_active_owner";
      },
      get bridgeRegistryCurrent() {
        return current;
      },
      startConvergenceMonitor: (listener) => {
        publish = listener;
      },
    };
    const service = makeService(
      new Map([[oldCandidate.canonicalPath, runtime]]),
      events,
      async () => undefined,
      [oldCandidate],
    );

    await expect(service.start()).resolves.toMatchObject({
      lifecycle: "converging",
      bridgeRegistryCurrent: false,
      bridgeDisposition: "deferred_active_owner",
    });
    current = true;
    await publish?.();
    expect(service.status).toMatchObject({
      lifecycle: "ready",
      bridgeRegistryCurrent: true,
      bridgeDisposition: "replaced",
    });
  });

  it("retries a deferred owner and converges without restarting the gateway", async () => {
    let reconcileCalls = 0;
    const generation = {
      codeModeCatalogDigest: "code-mode-a",
      bridgeRegistryDigest: "bridge-a",
    };
    const convergence = new OmniCodexCatalogConvergence({
      intervalMs: 10,
      initialBridge: {
        threadId: "bridge-old",
        registryDigest: "bridge-a",
        disposition: "deferred_active_owner",
      },
      initialGeneration: generation,
      refreshCatalog: async () => generation,
      refreshMcpSessions: async () => undefined,
      reconcileBridge: async () => {
        reconcileCalls += 1;
        return {
          threadId: reconcileCalls === 1 ? "bridge-old" : "bridge-new",
          registryDigest: "bridge-a",
          disposition: reconcileCalls === 1 ? "deferred_active_owner" : "replaced",
        };
      },
    });
    const converged = new Promise<void>((resolveConverged) => {
      convergence.start(() => {
        if (convergence.snapshot.bridgeRegistryCurrent) resolveConverged();
      });
    });
    await expect(
      Promise.race([
        converged,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("automatic convergence timed out")), 500),
        ),
      ]),
    ).resolves.toBeUndefined();
    expect(convergence.snapshot).toMatchObject({
      bridgeRegistryCurrent: true,
      bridgeDisposition: "replaced",
      bridgeThreadId: "bridge-new",
    });
    expect(reconcileCalls).toBe(2);
    await convergence.stop();
  });

  it("keeps a changed catalog fail-closed until MCP notification and Bridge replacement both succeed", async () => {
    let generation = {
      codeModeCatalogDigest: "code-mode-a",
      bridgeRegistryDigest: "bridge-a",
    };
    let propagationAttempts = 0;
    let reconcileCalls = 0;
    const convergence = new OmniCodexCatalogConvergence({
      intervalMs: 10,
      initialBridge: {
        threadId: "bridge-a",
        registryDigest: "bridge-a",
        disposition: "current",
      },
      initialGeneration: generation,
      refreshCatalog: async () => generation,
      refreshMcpSessions: async () => {
        propagationAttempts += 1;
        if (propagationAttempts === 1) throw new Error("notification transport unavailable");
      },
      reconcileBridge: async () => {
        reconcileCalls += 1;
        return {
          threadId: "bridge-b",
          registryDigest: "bridge-b",
          disposition: "replaced",
        };
      },
    });
    generation = {
      codeModeCatalogDigest: "code-mode-b",
      bridgeRegistryDigest: "bridge-b",
    };

    await expect(convergence.refreshNow()).resolves.toMatchObject({
      bridgeRegistryCurrent: false,
      bridgeConvergenceError: "notification transport unavailable",
    });
    await expect(convergence.refreshNow()).resolves.toMatchObject({
      bridgeRegistryCurrent: true,
      bridgeDisposition: "replaced",
      bridgeThreadId: "bridge-b",
    });
    expect(propagationAttempts).toBe(2);
    expect(reconcileCalls).toBe(1);
    await convergence.stop();
  });

  it("propagates a changed tool catalog without replacing the context-only Bridge", async () => {
    let generation = {
      codeModeCatalogDigest: "code-mode-a",
      bridgeRegistryDigest: "bridge-context",
    };
    let propagationAttempts = 0;
    let reconcileCalls = 0;
    const convergence = new OmniCodexCatalogConvergence({
      intervalMs: 10,
      initialBridge: {
        threadId: "bridge-context-thread",
        registryDigest: "bridge-context",
        disposition: "current",
      },
      initialGeneration: generation,
      refreshCatalog: async () => generation,
      refreshMcpSessions: async () => {
        propagationAttempts += 1;
      },
      reconcileBridge: async () => {
        reconcileCalls += 1;
        return {
          threadId: "unexpected-replacement",
          registryDigest: "bridge-context",
          disposition: "replaced",
        };
      },
    });
    generation = { codeModeCatalogDigest: "code-mode-b", bridgeRegistryDigest: "bridge-context" };

    await expect(convergence.refreshNow()).resolves.toMatchObject({
      bridgeRegistryCurrent: true,
      bridgeThreadId: "bridge-context-thread",
    });
    expect(propagationAttempts).toBe(1);
    expect(reconcileCalls).toBe(0);
    await convergence.stop();
  });

  it.each([
    ["catalog refresh", { failCatalog: true, failPropagation: false }],
    ["MCP propagation", { failCatalog: false, failPropagation: true }],
  ])(
    "keeps an authoritative Bridge reconcile pending when %s fails before the Bridge step",
    async (_stage, { failCatalog, failPropagation }) => {
      let generation = {
        codeModeCatalogDigest: "code-mode-a",
        bridgeRegistryDigest: "bridge-context",
      };
      let catalogFailures = failCatalog ? 1 : 0;
      let propagationFailures = failPropagation ? 1 : 0;
      let reconcileCalls = 0;
      const convergence = new OmniCodexCatalogConvergence({
        intervalMs: 10,
        initialBridge: {
          threadId: "bridge-context-thread",
          registryDigest: "bridge-context",
          disposition: "current",
        },
        initialGeneration: generation,
        refreshCatalog: async () => {
          if (catalogFailures > 0) {
            catalogFailures -= 1;
            throw new Error("catalog unavailable");
          }
          return generation;
        },
        refreshMcpSessions: async () => {
          if (propagationFailures > 0) {
            propagationFailures -= 1;
            throw new Error("notification transport unavailable");
          }
        },
        reconcileBridge: async () => {
          reconcileCalls += 1;
          return {
            threadId: "bridge-context-thread",
            registryDigest: "bridge-context",
            disposition: "current",
          };
        },
      });
      if (failPropagation) {
        generation = {
          codeModeCatalogDigest: "code-mode-b",
          bridgeRegistryDigest: "bridge-context",
        };
      }

      await expect(convergence.reconcileNow()).resolves.toMatchObject({
        bridgeRegistryCurrent: false,
      });
      expect(reconcileCalls).toBe(0);
      await expect(convergence.refreshNow()).resolves.toMatchObject({
        bridgeRegistryCurrent: true,
      });
      expect(reconcileCalls).toBe(1);
      await convergence.stop();
    },
  );

  it("authoritatively reconciles the Bridge even when the cached snapshot says it is current", async () => {
    let reconcileCalls = 0;
    const generation = {
      codeModeCatalogDigest: "code-mode-a",
      bridgeRegistryDigest: "bridge-a",
    };
    const convergence = new OmniCodexCatalogConvergence({
      intervalMs: 10,
      initialBridge: {
        threadId: "bridge-a",
        registryDigest: "bridge-a",
        disposition: "current",
      },
      initialGeneration: generation,
      refreshCatalog: async () => generation,
      refreshMcpSessions: async () => undefined,
      reconcileBridge: async () => {
        reconcileCalls += 1;
        return {
          threadId: "bridge-a",
          registryDigest: "bridge-a",
          disposition: "current",
        };
      },
    });

    expect(convergence.snapshot.bridgeRegistryCurrent).toBe(true);
    await expect(convergence.reconcileNow()).resolves.toMatchObject({
      bridgeRegistryCurrent: true,
      bridgeThreadId: "bridge-a",
    });
    expect(reconcileCalls).toBe(1);
    await convergence.stop();
  });

  it("drains a dead runtime and rebuilds the same native gateway", async () => {
    const events: string[] = [];
    const lifecycles: string[] = [];
    const runtimes = runtimeFixtures(events);
    const service = makeService(
      runtimes,
      events,
      async () => undefined,
      [oldCandidate],
      (status) => {
        lifecycles.push(status.lifecycle);
      },
    );

    await service.start();
    events.length = 0;
    lifecycles.length = 0;

    await expect(service.recoverRuntime(1_000)).resolves.toMatchObject({
      lifecycle: "ready",
      candidate: oldCandidate,
    });
    expect(events).toEqual([
      "old:drain",
      "old:await-drained",
      "old:gateway-stop",
      "old:children-stop",
      "old:prepare",
      "old:probe",
      "boundary:verify",
      "old:gateway-start",
      "boundary:verify",
    ]);
    expect(lifecycles).toEqual(["recovering", "starting", "ready"]);
  });

  it("rediscovers the new Desktop engine after its active connection is lost", async () => {
    const events: string[] = [];
    const runtimes = runtimeFixtures(events);
    let selected = oldCandidate;
    const service = makeService(runtimes, events, async () => undefined, undefined, undefined, {
      discovery: { discover: async () => ({ candidates: [selected], warnings: [] }) },
    });
    await service.start();
    selected = newCandidate;
    let recovery!: Promise<unknown>;
    signalDesktopRuntimeDisconnection(new Error("Desktop connection lost"), {
      isActive: true,
      retireResponses: async () => {
        events.push("responses:disconnected");
      },
      retireConnection: async () => {
        events.push("connection:disconnected");
      },
      notifyOwner: () => {
        recovery = service.recoverRuntime(1_000);
      },
    });
    await expect(recovery).resolves.toMatchObject({ lifecycle: "ready", candidate: newCandidate });
    expect(events).toContain("responses:disconnected");
    expect(events).toContain("connection:disconnected");
    expect(events).toContain("new:prepare");
    await service.stop(1_000);
  });

  it("shadow probes, drains, switches, observes, and retires the old runtime", async () => {
    const events: string[] = [];
    const lifecycles: string[] = [];
    const runtimes = runtimeFixtures(events);
    const service = makeService(
      runtimes,
      events,
      async () => {
        events.push("new:observe");
      },
      undefined,
      (status) => {
        lifecycles.push(status.lifecycle);
      },
    );

    await service.start();
    events.length = 0;
    await expect(service.switchRuntime(newCandidate.canonicalPath, 1_000)).resolves.toMatchObject({
      lifecycle: "ready",
      candidate: newCandidate,
    });
    expect(events).toEqual([
      "new:prepare",
      "new:probe",
      "boundary:verify",
      "old:drain",
      "old:await-drained",
      "old:gateway-stop",
      "new:gateway-start",
      "boundary:verify",
      "new:observe",
      "boundary:verify",
      "old:children-stop",
    ]);
    expect(lifecycles).toEqual([
      "starting",
      "ready",
      "shadow_starting",
      "draining",
      "switching",
      "observing",
      "retiring_previous",
      "ready",
    ]);
  });

  it("retries transient previous-runtime cleanup without rolling back the committed candidate", async () => {
    const events: string[] = [];
    let cleanupAttempts = 0;
    const oldRuntime = {
      ...fakeRuntime("old", oldCandidate, events),
      stopChildren: async () => {
        events.push("old:children-stop");
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw new Error("transient Windows record lock");
      },
    };
    const service = makeService(
      new Map([
        [oldCandidate.canonicalPath, oldRuntime],
        [newCandidate.canonicalPath, fakeRuntime("new", newCandidate, events)],
      ]),
      events,
      async () => {
        events.push("new:observe");
      },
    );

    await service.start();
    events.length = 0;
    await expect(service.switchRuntime(newCandidate.canonicalPath, 1_000)).resolves.toMatchObject({
      lifecycle: "ready",
      candidate: newCandidate,
    });
    expect(events.filter((event) => event === "old:children-stop")).toHaveLength(2);
    expect(events).not.toContain("new:gateway-stop");
    expect(events).not.toContain("old:gateway-start");
  });

  it("keeps the committed candidate active when previous-runtime cleanup remains pending", async () => {
    const events: string[] = [];
    let cleanupAttempts = 0;
    const oldRuntime = {
      ...fakeRuntime("old", oldCandidate, events),
      stopChildren: async () => {
        events.push("old:children-stop");
        cleanupAttempts += 1;
        if (cleanupAttempts <= 3) throw new Error("persistent Windows record lock");
      },
    };
    const service = makeService(
      new Map([
        [oldCandidate.canonicalPath, oldRuntime],
        [newCandidate.canonicalPath, fakeRuntime("new", newCandidate, events)],
      ]),
      events,
      async () => {
        events.push("new:observe");
      },
    );

    await service.start();
    events.length = 0;
    await expect(service.switchRuntime(newCandidate.canonicalPath, 1_000)).rejects.toThrow(
      "Runtime switch committed, but previous runtime cleanup failed",
    );
    expect(service.status).toMatchObject({ lifecycle: "cleanup_pending", candidate: newCandidate });
    expect(events.filter((event) => event === "old:children-stop")).toHaveLength(3);
    expect(events).not.toContain("new:gateway-stop");
    expect(events).not.toContain("old:gateway-start");

    await expect(service.stop()).resolves.toMatchObject({ lifecycle: "stopped" });
    expect(events).toContain("new:gateway-stop");
    expect(events.filter((event) => event === "old:children-stop")).toHaveLength(4);
  });

  it("bounds a hung previous-runtime retirement and keeps the committed listener admitted", async () => {
    const events: string[] = [];
    let releaseCleanup!: () => void;
    const cleanupPending = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const oldRuntime = {
      ...fakeRuntime("old", oldCandidate, events),
      stopChildren: () => {
        events.push("old:children-stop");
        return cleanupPending;
      },
    };
    const newRuntime = fakeRuntime("new", newCandidate, events);
    const service = makeService(
      new Map([
        [oldCandidate.canonicalPath, oldRuntime],
        [newCandidate.canonicalPath, newRuntime],
      ]),
      events,
      async () => undefined,
      undefined,
      undefined,
      { shutdownPhaseTimeoutMs: 25 },
    );

    try {
      await service.start();
      events.length = 0;
      await expect(
        Promise.race([
          service.switchRuntime(newCandidate.canonicalPath, 100),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("runtime retirement remained unbounded")), 500),
          ),
        ]),
      ).rejects.toThrow("Runtime switch committed, but previous runtime cleanup failed");
      expect(service.status).toMatchObject({
        lifecycle: "cleanup_pending",
        candidate: newCandidate,
      });
      expect(newRuntime.gateway.runtimeStatus.admission).toBe("open");
      expect(events.filter((event) => event === "old:children-stop")).toHaveLength(1);
    } finally {
      releaseCleanup();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await service.stop().catch(() => undefined);
    }
  });

  it("never rolls back after old-runtime retirement when ready-status publication fails", async () => {
    const events: string[] = [];
    const runtimes = runtimeFixtures(events);
    const service = makeService(
      runtimes,
      events,
      async () => {
        events.push("new:observe");
      },
      undefined,
      async (status) => {
        if (status.lifecycle === "ready" && status.candidate === newCandidate) {
          throw new Error("state publication unavailable");
        }
      },
    );

    await service.start();
    events.length = 0;
    await expect(service.switchRuntime(newCandidate.canonicalPath, 1_000)).rejects.toThrow(
      "Runtime switch committed, but ready status publication failed",
    );
    expect(service.status).toMatchObject({ lifecycle: "cleanup_pending", candidate: newCandidate });
    expect(events).not.toContain("new:gateway-stop");
    expect(events).not.toContain("old:gateway-start");
  });

  it("rolls the listener and runtime back when observation fails", async () => {
    const events: string[] = [];
    const runtimes = runtimeFixtures(events);
    const service = makeService(runtimes, events, async () => {
      events.push("new:observe");
      throw new Error("candidate unhealthy");
    });

    await service.start();
    events.length = 0;
    await expect(service.switchRuntime(newCandidate.canonicalPath, 1_000)).rejects.toThrow(
      "candidate unhealthy",
    );
    expect(service.status).toMatchObject({ lifecycle: "ready", candidate: oldCandidate });
    expect(events).toEqual([
      "new:prepare",
      "new:probe",
      "boundary:verify",
      "old:drain",
      "old:await-drained",
      "old:gateway-stop",
      "new:gateway-start",
      "boundary:verify",
      "new:observe",
      "new:gateway-stop",
      "new:children-stop",
      "old:gateway-start",
      "old:probe",
      "old:resume",
    ]);
  });

  it("defers Bridge mutation until observation and restores the authoritative old digest on failure", async () => {
    const events: string[] = [];
    let canonicalDigest = "registry-old";
    let shadowOptions: OmniCodexPrepareRuntimeOptions | undefined;
    const oldRuntime: OmniCodexPreparedRuntime = {
      ...fakeRuntime("old", oldCandidate, events),
      bridgeRegistryDigest: "registry-old",
      promoteBridge: async () => {
        events.push("old:bridge-promote");
        canonicalDigest = "registry-old";
        return {
          bridgeThreadId: "bridge-old",
          bridgeDisposition: "current",
          bridgeRegistryCurrent: true,
        };
      },
    };
    const newRuntime: OmniCodexPreparedRuntime = {
      ...fakeRuntime("new", newCandidate, events),
      bridgeRegistryDigest: "registry-new",
      promoteBridge: async () => {
        events.push("new:bridge-promote");
        canonicalDigest = "registry-new";
        throw new Error("candidate Bridge promotion readback failed");
      },
    };
    const service = makeService(
      new Map([
        [oldCandidate.canonicalPath, oldRuntime],
        [newCandidate.canonicalPath, newRuntime],
      ]),
      events,
      async () => {
        events.push("new:observe");
        expect(canonicalDigest).toBe("registry-old");
      },
      undefined,
      undefined,
      {
        prepareRuntime: async (candidate, options) => {
          const name = candidate === oldCandidate ? "old" : "new";
          events.push(`${name}:prepare`);
          if (candidate === newCandidate) shadowOptions = options;
          return candidate === oldCandidate ? oldRuntime : newRuntime;
        },
      },
    );

    await service.start();
    events.length = 0;
    await expect(service.switchRuntime(newCandidate.canonicalPath, 1_000)).rejects.toThrow(
      "candidate Bridge promotion readback failed",
    );

    expect(shadowOptions).toMatchObject({
      deferBridgeReconciliation: true,
      initialBridge: {
        threadId: "bridge-old",
        registryDigest: "registry-old",
        disposition: "current",
      },
    });
    expect(events.indexOf("new:observe")).toBeLessThan(events.indexOf("new:bridge-promote"));
    expect(events.indexOf("new:bridge-promote")).toBeLessThan(events.indexOf("old:bridge-promote"));
    expect(canonicalDigest).toBe("registry-old");
    expect(service.status).toMatchObject({ lifecycle: "ready", candidate: oldCandidate });
  });

  it("restarts a partially closed listener, proves it, and reopens direct work after rollback", async () => {
    const events: string[] = [];
    const jobs = new DirectJobManager(DirectJobStore.inMemory());
    const oldAdapter: DirectJobDispatchAdapter = {
      validate: vi.fn(async () => fakeTargetContract("old")),
      dispatch: vi.fn(async (request) => {
        await request.beforeNativeDispatch();
        return {
          status: "succeeded" as const,
          result: { content: [{ type: "text" as const, text: "ROLLBACK_NATIVE_OK" }] },
        };
      }),
    };
    const oldRuntime = fakeRuntime("old", oldCandidate, events, oldAdapter);
    const oldGateway = oldRuntime.gateway as FakeGateway;
    oldGateway.setAdapterAdmissionHooks(
      () => jobs.beginAdapterDrain(oldAdapter),
      () => jobs.resumeAdapterAdmission(oldAdapter),
    );
    const newRuntime = fakeRuntime("new", newCandidate, events, scheduleAdapter());
    const service = makeService(
      new Map([
        [oldCandidate.canonicalPath, oldRuntime],
        [newCandidate.canonicalPath, newRuntime],
      ]),
      events,
      async () => undefined,
      undefined,
      undefined,
      { directJobManager: jobs },
    );
    const context = {
      authorizationBinding: "owner-binding",
      callerSessionId: "rollback-session",
      workSessionBinding: "rollback-work-session",
      directGoalClaimantBinding: "rollback-goal",
      directJobOwnerBinding: "rollback-job-owner",
    } as const;
    const scheduleContext = {
      ...context,
      directScheduleOwnerBinding: "rollback-schedule-owner",
    } as const;
    const scheduleStore = DirectScheduleStore.inMemory({
      integrityKey: Buffer.alloc(32, 79),
      nowUnixMs: () => 1_000,
    });
    const schedules = new DirectScheduleManager(scheduleStore, jobs);

    try {
      await service.start();
      events.length = 0;
      oldGateway.failNextStopAfterListenerClose(new Error("listener closed before cleanup failed"));
      await expect(service.switchRuntime(newCandidate.canonicalPath, 50)).rejects.toThrow(
        "listener closed before cleanup failed",
      );
      expect(service.status).toMatchObject({ lifecycle: "ready", candidate: oldCandidate });
      expect(events).toEqual(
        expect.arrayContaining([
          "old:gateway-stop",
          "old:gateway-start",
          "old:probe",
          "old:resume",
        ]),
      );
      expect(
        oldGateway.stopTimeouts.some(
          (timeout) => timeout !== undefined && timeout > 0 && timeout <= 50,
        ),
      ).toBe(true);

      const manual = await jobs.start(
        {
          idempotencyKey: "rollback-direct-job-0001",
          toolName: "mcp__demo__ping",
          arguments: {},
        },
        context,
        oldAdapter,
      );
      await jobs.waitForAdapterIdle(oldAdapter);
      await expect(jobs.get({ jobId: manual.job.jobId }, context)).resolves.toMatchObject({
        status: "succeeded",
      });

      const created = await schedules.create(
        {
          idempotencyKey: "rollback-schedule-create-0001",
          timezone: "Asia/Seoul",
          rrule: "FREQ=MINUTELY;INTERVAL=5",
          startAtUnixMs: 61_000,
          toolName: "mcp__demo__ping",
          arguments: {},
        },
        scheduleContext,
        oldAdapter,
      );
      await schedules.trigger(
        {
          scheduleId: created.schedule.scheduleId,
          idempotencyKey: "rollback-schedule-trigger-0001",
        },
        scheduleContext,
        oldAdapter,
      );
      await schedules.shutdown({ drainTimeoutMs: 1_000, fenceTimeoutMs: 1_000 });
      await expect(
        schedules.runs(
          { scheduleId: created.schedule.scheduleId, statuses: ["succeeded"] },
          scheduleContext,
        ),
      ).resolves.toMatchObject({ runs: [expect.objectContaining({ status: "succeeded" })] });
    } finally {
      await schedules.shutdown({ drainTimeoutMs: 1_000, fenceTimeoutMs: 1_000 });
      await service.stop().catch(() => undefined);
    }
  });

  it("moves exact-native schedule polling with the runtime and restores it on rollback", async () => {
    const events: string[] = [];
    const oldAdapter = scheduleAdapter();
    const newAdapter = scheduleAdapter();
    const adapterNames = new Map<DirectJobDispatchAdapter, string>([
      [oldAdapter, "old"],
      [newAdapter, "new"],
    ]);
    const polling = vi
      .spyOn(DirectScheduleManager.prototype, "startPolling")
      .mockImplementation((adapter) => {
        events.push(`${adapterNames.get(adapter)}:schedule-start`);
      });
    const shutdown = vi
      .spyOn(DirectScheduleManager.prototype, "shutdown")
      .mockImplementation(async () => {
        events.push("schedule-stop");
      });
    const runtimes = new Map([
      [oldCandidate.canonicalPath, fakeRuntime("old", oldCandidate, events, oldAdapter)],
      [newCandidate.canonicalPath, fakeRuntime("new", newCandidate, events, newAdapter)],
    ]);
    const jobs = new DirectJobManager(DirectJobStore.inMemory());
    const service = makeService(
      runtimes,
      events,
      async () => {
        events.push("new:observe");
        throw new Error("candidate unhealthy");
      },
      undefined,
      undefined,
      {
        directJobManager: jobs,
        directScheduleStore: DirectScheduleStore.inMemory({
          integrityKey: Buffer.alloc(32, 59),
        }),
      },
    );
    try {
      await service.start();
      await expect(service.switchRuntime(newCandidate.canonicalPath, 1_000)).rejects.toThrow(
        "candidate unhealthy",
      );
      await expect(service.stop()).resolves.toMatchObject({ lifecycle: "stopped" });
      expect(events.filter((event) => event.includes("schedule"))).toEqual([
        "old:schedule-start",
        "schedule-stop",
        "new:schedule-start",
        "schedule-stop",
        "old:schedule-start",
        "schedule-stop",
      ]);
    } finally {
      polling.mockRestore();
      shutdown.mockRestore();
      await service.stop();
    }
  });

  it("accepts a new package generation when the executable hash is unchanged", async () => {
    const events: string[] = [];
    const sameBuildCandidate: RuntimeCandidate = {
      ...newCandidate,
      buildSha256: oldCandidate.buildSha256,
    };
    const runtimes = new Map([
      [oldCandidate.canonicalPath, fakeRuntime("old", oldCandidate, events)],
      [sameBuildCandidate.canonicalPath, fakeRuntime("same", sameBuildCandidate, events)],
    ]);
    const service = makeService(runtimes, events, async () => undefined, [
      oldCandidate,
      sameBuildCandidate,
    ]);

    await service.start();
    events.length = 0;
    await expect(
      service.switchRuntime(sameBuildCandidate.canonicalPath, 1_000),
    ).resolves.toMatchObject({
      lifecycle: "ready",
      candidate: sameBuildCandidate,
    });
    await service.stop();
  });

  it("reads task inventory from the active owned runtime and reports its canonical Bridge", async () => {
    const events: string[] = [];
    const runtime = {
      ...fakeRuntime("old", oldCandidate, events),
      readThreadInventory: async () => ({
        active: [{ id: "task-active", name: "Active", cwd: "C:\\active" }],
        archived: [{ id: "task-archived", name: "Archived", cwd: "C:\\archived" }],
      }),
    };
    const service = makeService(
      new Map([[oldCandidate.canonicalPath, runtime]]),
      events,
      async () => undefined,
      [oldCandidate],
    );

    await service.start();
    await expect(service.readThreadInventory()).resolves.toEqual({
      active: [{ id: "task-active", name: "Active", cwd: "C:\\active" }],
      archived: [{ id: "task-archived", name: "Archived", cwd: "C:\\archived" }],
      canonicalBridgeThreadId: "bridge-old",
    });
    await service.stop();
  });

  it("keeps MCP admission open while an observed Web conversation is still active", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const runtime = fakeRuntime("old", oldCandidate, events);
    const gateway = runtime.gateway as FakeGateway;
    gateway.setObservedChatGptConversationIds(["web-conversation"]);
    const statuses = ["active", "idle", "idle", "idle"] as const;
    let observation = 0;
    const activity = vi.fn(async () => ({
      structuredContent: {
        pinnedThreads: [],
        threads: [
          {
            id: "web-conversation",
            kind: "chatgpt",
            status: statuses[Math.min(observation++, statuses.length - 1)],
          },
          { id: "local-task", kind: "codex", status: "active" },
          { id: "unrelated-web", kind: "chatgpt", status: "active" },
        ],
      },
    }));
    const guardedRuntime = { ...runtime, readInteractiveThreadActivity: activity };
    const service = makeService(
      new Map([[oldCandidate.canonicalPath, guardedRuntime]]),
      events,
      async () => undefined,
      [oldCandidate],
    );
    try {
      await service.start();
      events.length = 0;
      let settled = false;
      const draining = service.beginDrainWhenInteractiveIdle().then((result) => {
        settled = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(499);
      expect(settled).toBe(false);
      expect(gateway.runtimeStatus.admission).toBe("open");

      await vi.advanceTimersByTimeAsync(1);
      await expect(draining).resolves.toMatchObject({ admission: "draining" });
      expect(gateway.runtimeStatus.admission).toBe("draining");
      expect(activity).toHaveBeenCalledTimes(4);
      expect(events).toEqual(["old:drain"]);
    } finally {
      vi.useRealTimers();
      await service.stop().catch(() => undefined);
    }
  });

  it("paces another account's exact activity without counting throttled reads as idle", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const runtime = fakeRuntime("old", oldCandidate, events);
    const gateway = runtime.gateway as FakeGateway;
    gateway.setObservedChatGptConversationIds(["other-account-web"]);
    let calls = 0;
    const probe = vi.fn(
      async (signal: AbortSignal, _locallyTrackedConversationIds?: readonly string[]) => {
        signal.throwIfAborted();
        calls += 1;
        return {
          observedConversationIds: ["other-account-web"],
          activeConversationIds: calls === 2 ? ["other-account-web"] : [],
          ...(calls === 1 || calls === 3 ? { nextScanAtUnixMs: Date.now() + 5000 } : {}),
        };
      },
    );
    const localRead = vi.fn(async () => {
      throw new Error("wrong account reader");
    });
    const service = makeService(
      new Map([
        [oldCandidate.canonicalPath, { ...runtime, readInteractiveThreadActivity: localRead }],
      ]),
      events,
      async () => undefined,
      [oldCandidate],
      undefined,
      { createInteractiveActivityProbe: () => probe },
    );
    try {
      await service.start();
      let settled = false;
      const draining = service.beginDrainWhenInteractiveIdle(20000).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(4999);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(probe.mock.calls[0]?.[1]).toEqual(["other-account-web"]);
      expect(settled).toBe(false);
      expect(gateway.runtimeStatus.admission).toBe("open");
      await vi.advanceTimersByTimeAsync(5250);
      expect(settled).toBe(false);
      expect(gateway.runtimeStatus.admission).toBe("open");
      await vi.advanceTimersByTimeAsync(251);
      await expect(draining).resolves.toMatchObject({ admission: "draining" });
      expect(probe).toHaveBeenCalledTimes(6);
      expect(localRead).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await service.stop().catch(() => undefined);
    }
  });

  it("allows an exact activity pass beyond 30 seconds within the restart deadline", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("caller deadline")), ms);
      return controller.signal;
    });
    const events: string[] = [];
    const runtime = fakeRuntime("old", oldCandidate, events);
    let calls = 0;
    const probe = vi.fn(async (signal: AbortSignal) => {
      if (++calls === 1) await new Promise((resolve) => setTimeout(resolve, 45_000));
      signal.throwIfAborted();
      return { observedConversationIds: [], activeConversationIds: [] };
    });
    const service = makeService(
      new Map([[oldCandidate.canonicalPath, runtime]]),
      events,
      async () => undefined,
      [oldCandidate],
      undefined,
      { createInteractiveActivityProbe: () => probe },
    );
    try {
      await service.start();
      const draining = service.beginDrainWhenInteractiveIdle(120_000);
      await vi.advanceTimersByTimeAsync(45_500);
      await expect(draining).resolves.toMatchObject({ admission: "draining" });
      expect(timeout.mock.calls[0]?.[0]).toBe(120_000);
      expect(probe.mock.calls[0]?.[0].aborted).toBe(false);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
      await service.stop().catch(() => undefined);
    }
  });

  it("cancels an in-flight exact activity probe at the caller deadline", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("caller deadline")), ms);
      return controller.signal;
    });
    const events: string[] = [];
    const runtime = fakeRuntime("old", oldCandidate, events);
    const probe = vi.fn(
      (signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const service = makeService(
      new Map([[oldCandidate.canonicalPath, runtime]]),
      events,
      async () => undefined,
      [oldCandidate],
      undefined,
      { createInteractiveActivityProbe: () => probe },
    );
    try {
      await service.start();
      const draining = expect(service.beginDrainWhenInteractiveIdle(1000)).rejects.toThrow(
        "caller deadline",
      );
      await vi.advanceTimersByTimeAsync(1000);
      await draining;
      expect(probe.mock.calls[0]?.[0].aborted).toBe(true);
      expect(runtime.gateway.runtimeStatus.admission).toBe("open");
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
      await service.stop().catch(() => undefined);
    }
  });

  it("keeps the restart deadline while another account is throttled", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const runtime = fakeRuntime("old", oldCandidate, events);
    const probe = vi.fn(async () => ({
      observedConversationIds: ["other-account-web"],
      activeConversationIds: [],
      nextScanAtUnixMs: Date.now() + 5000,
    }));
    const service = makeService(
      new Map([[oldCandidate.canonicalPath, runtime]]),
      events,
      async () => undefined,
      [oldCandidate],
      undefined,
      { createInteractiveActivityProbe: () => probe },
    );
    try {
      await service.start();
      const draining = expect(service.beginDrainWhenInteractiveIdle(1000)).rejects.toThrow(
        "Interactive Web conversations did not become idle before the deadline",
      );
      await vi.advanceTimersByTimeAsync(1000);
      await draining;
      expect(probe).toHaveBeenCalledTimes(1);
      expect(runtime.gateway.runtimeStatus.admission).toBe("open");
    } finally {
      vi.useRealTimers();
      await service.stop().catch(() => undefined);
    }
  });

  it("reopens admission before waiting for a provider-paced final idle check", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const runtime = fakeRuntime("old", oldCandidate, events);
    const gateway = runtime.gateway as FakeGateway;
    let calls = 0;
    const probe = vi.fn(async () => {
      calls += 1;
      return {
        observedConversationIds: ["other-account-web"],
        activeConversationIds: [],
        ...(calls === 3 ? { nextScanAtUnixMs: Date.now() + 5000 } : {}),
      };
    });
    const service = makeService(
      new Map([[oldCandidate.canonicalPath, runtime]]),
      events,
      async () => undefined,
      [oldCandidate],
      undefined,
      { createInteractiveActivityProbe: () => probe },
    );
    try {
      await service.start();
      events.length = 0;
      let settled = false;
      const draining = service.beginDrainWhenInteractiveIdle().then((result) => {
        settled = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(250);
      expect(probe).toHaveBeenCalledTimes(3);
      expect(gateway.runtimeStatus.admission).toBe("open");
      expect(events).toEqual(["old:drain", "old:resume"]);
      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);
      expect(gateway.runtimeStatus.admission).toBe("open");
      await vi.advanceTimersByTimeAsync(251);
      await expect(draining).resolves.toMatchObject({ admission: "draining" });
      expect(probe).toHaveBeenCalledTimes(6);
      expect(events).toEqual(["old:drain", "old:resume", "old:drain"]);
    } finally {
      vi.useRealTimers();
      await service.stop().catch(() => undefined);
    }
  });

  it("reopens admission when the drain control client disconnects during the final check", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const runtime = fakeRuntime("old", oldCandidate, events);
    const gateway = runtime.gateway as FakeGateway;
    let calls = 0;
    const probe = vi.fn(async (signal: AbortSignal) => {
      calls += 1;
      if (calls < 3) {
        return {
          observedConversationIds: ["other-account-web"],
          activeConversationIds: [],
        };
      }
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const service = makeService(
      new Map([[oldCandidate.canonicalPath, runtime]]),
      events,
      async () => undefined,
      [oldCandidate],
      undefined,
      { createInteractiveActivityProbe: () => probe },
    );
    const controller = new AbortController();
    try {
      await service.start();
      events.length = 0;
      const draining = service.beginDrainWhenInteractiveIdle(undefined, controller.signal);
      await vi.advanceTimersByTimeAsync(250);
      expect(probe).toHaveBeenCalledTimes(3);
      expect(gateway.runtimeStatus.admission).toBe("draining");
      controller.abort(new Error("DAEMON_CONTROL_CLIENT_DISCONNECTED"));
      await expect(draining).rejects.toThrow("DAEMON_CONTROL_CLIENT_DISCONNECTED");
      expect(gateway.runtimeStatus.admission).toBe("open");
      expect(events).toEqual(["old:drain", "old:resume"]);
    } finally {
      vi.useRealTimers();
      await service.stop().catch(() => undefined);
    }
  });

  it("resolves a conversation outside the recent inventory through the exact native reader", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const runtime = fakeRuntime("old", oldCandidate, events);
    const gateway = runtime.gateway as FakeGateway;
    gateway.setObservedChatGptConversationIds(["web-conversation"]);
    let reads = 0;
    const readConversation = vi.fn(async (threadId: string, _timeoutMs?: number) => ({
      structuredContent: {
        thread: { id: threadId, kind: "chatgpt" },
        status: { status: reads++ === 0 ? "active" : "idle" },
      },
    }));
    const service = makeService(
      new Map([
        [
          oldCandidate.canonicalPath,
          {
            ...runtime,
            readInteractiveConversationActivity: readConversation,
          },
        ],
      ]),
      events,
      async () => undefined,
      [oldCandidate],
    );
    try {
      await service.start();
      events.length = 0;
      let settled = false;
      const draining = service.beginDrainWhenInteractiveIdle().then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(499);
      expect(settled).toBe(false);
      expect(gateway.runtimeStatus.admission).toBe("open");
      await vi.advanceTimersByTimeAsync(1);
      await expect(draining).resolves.toMatchObject({ admission: "draining" });
      expect(readConversation.mock.calls).toEqual(
        Array.from({ length: 4 }, () => ["web-conversation", 30_000]),
      );
      expect(events).toEqual(["old:drain"]);
    } finally {
      vi.useRealTimers();
      await service.stop().catch(() => undefined);
    }
  });

  it.each(["wrong-identity", "historical-turn-only", "error-result"])(
    "does not retire a runtime on an inconclusive exact native read: %s",
    async (reason) => {
      const events: string[] = [];
      const runtime = fakeRuntime("old", oldCandidate, events);
      const gateway = runtime.gateway as FakeGateway;
      gateway.setObservedChatGptConversationIds(["web-conversation"]);
      const service = makeService(
        new Map([
          [
            oldCandidate.canonicalPath,
            {
              ...runtime,
              readInteractiveConversationActivity: async () => ({
                ...(reason === "error-result" ? { isError: true } : {}),
                thread: {
                  id: reason === "wrong-identity" ? "other-conversation" : "web-conversation",
                  kind: "chatgpt",
                },
                ...(reason === "historical-turn-only" ? {} : { status: "idle" }),
                turns: [{ status: "completed" }],
              }),
            },
          ],
        ]),
        events,
        async () => undefined,
        [oldCandidate],
      );
      try {
        await service.start();
        events.length = 0;
        await expect(service.beginDrainWhenInteractiveIdle()).rejects.toThrow(
          "LIVE_CODEX_APP_THREAD_ACTIVITY_UNAVAILABLE",
        );
        expect(gateway.runtimeStatus.admission).toBe("open");
        expect(events).toEqual([]);
      } finally {
        await service.stop().catch(() => undefined);
      }
    },
  );

  it.each(["missing", "unknown-status", "error-result"])(
    "preserves admission when observed Web activity is unconfirmed: %s",
    async (reason) => {
      const events: string[] = [];
      const runtime = fakeRuntime("old", oldCandidate, events);
      const gateway = runtime.gateway as FakeGateway;
      gateway.setObservedChatGptConversationIds(["web-conversation"]);
      const activity = vi.fn(async () => ({
        ...(reason === "error-result" ? { isError: true } : {}),
        structuredContent: {
          pinnedThreads: [],
          threads:
            reason === "missing"
              ? []
              : [
                  {
                    id: "web-conversation",
                    kind: "chatgpt",
                    status: reason === "unknown-status" ? "reconnecting" : "idle",
                  },
                ],
        },
      }));
      const service = makeService(
        new Map([
          [oldCandidate.canonicalPath, { ...runtime, readInteractiveThreadActivity: activity }],
        ]),
        events,
        async () => undefined,
        [oldCandidate],
      );
      try {
        await service.start();
        events.length = 0;
        await expect(service.beginDrainWhenInteractiveIdle(1000)).rejects.toThrow(
          "LIVE_CODEX_APP_THREAD_ACTIVITY_UNAVAILABLE",
        );
        expect(gateway.runtimeStatus.admission).toBe("open");
        expect(events).toEqual([]);
      } finally {
        await service.stop().catch(() => undefined);
      }
    },
  );

  it("bounds each unbounded interactive probe and reopens admission when the final idle check fails", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const runtime = fakeRuntime("old", oldCandidate, events);
    const gateway = runtime.gateway as FakeGateway;
    gateway.setObservedChatGptConversationIds(["web-conversation"]);
    let observation = 0;
    const activity = vi.fn(async (_timeoutMs?: number) => {
      observation += 1;
      if (observation === 3) throw new Error("interactive activity probe timed out");
      return {
        structuredContent: {
          pinnedThreads: [],
          threads: [{ id: "web-conversation", kind: "chatgpt", status: "idle" }],
        },
      };
    });
    const guardedRuntime = { ...runtime, readInteractiveThreadActivity: activity };
    const service = makeService(
      new Map([[oldCandidate.canonicalPath, guardedRuntime]]),
      events,
      async () => undefined,
      [oldCandidate],
    );
    try {
      await service.start();
      events.length = 0;
      const draining = service.beginDrainWhenInteractiveIdle();
      const rejection = expect(draining).rejects.toThrow("interactive activity probe timed out");

      await vi.advanceTimersByTimeAsync(500);
      await rejection;
      expect(activity.mock.calls).toEqual([[30_000], [30_000], [30_000]]);
      expect(gateway.runtimeStatus.admission).toBe("open");
      expect(events).toEqual(["old:drain", "old:resume"]);
    } finally {
      vi.useRealTimers();
      await service.stop().catch(() => undefined);
    }
  });

  it("uses Codex Desktop task state without claiming Chrome tabs for an opaque session", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const runtime = fakeRuntime("old", oldCandidate, events);
    const gateway = runtime.gateway as FakeGateway;
    gateway.setObservedOpenAiWorkSessionCount(1);
    const statuses = ["active", "idle", "idle", "idle"] as const;
    let observation = 0;
    const taskActivity = vi.fn(async () => ({
      structuredContent: {
        pinnedThreads: [],
        threads: [
          {
            id: "opaque-web-conversation",
            kind: "chatgpt",
            status: statuses[Math.min(observation++, statuses.length - 1)],
          },
        ],
      },
    }));
    const guardedRuntime = {
      ...runtime,
      readInteractiveThreadActivity: taskActivity,
    };
    const service = makeService(
      new Map([[oldCandidate.canonicalPath, guardedRuntime]]),
      events,
      async () => undefined,
      [oldCandidate],
    );
    try {
      await service.start();
      events.length = 0;
      let settled = false;
      const draining = service.beginDrainWhenInteractiveIdle().then((result) => {
        settled = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(499);
      expect(settled).toBe(false);
      expect(gateway.runtimeStatus.admission).toBe("open");

      await vi.advanceTimersByTimeAsync(1);
      await expect(draining).resolves.toMatchObject({ admission: "draining" });
      expect(gateway.runtimeStatus.admission).toBe("draining");
      expect(taskActivity).toHaveBeenCalledTimes(4);
      expect(events).toEqual(["old:drain"]);
    } finally {
      vi.useRealTimers();
      await service.stop().catch(() => undefined);
    }
  });
});

function makeService(
  runtimes: ReadonlyMap<string, OmniCodexPreparedRuntime>,
  events: string[],
  observeRuntime: () => Promise<void>,
  candidates: readonly RuntimeCandidate[] | undefined = [oldCandidate, newCandidate],
  onStatusChange?: ConstructorParameters<typeof OmniCodexGatewayService>[0]["onStatusChange"],
  extraOptions: Partial<ConstructorParameters<typeof OmniCodexGatewayService>[0]> = {},
): OmniCodexGatewayService {
  return new OmniCodexGatewayService({
    authorize: () => ({ ok: false, status: 401 }),
    discovery: {
      discover: async () => ({
        candidates: candidates ?? [oldCandidate, newCandidate],
        warnings: [],
      }),
    },
    prepareRuntime: async (candidate) => {
      const name = candidate === oldCandidate ? "old" : "new";
      events.push(`${name}:prepare`);
      const runtime = runtimes.get(candidate.canonicalPath);
      if (runtime === undefined) throw new Error("missing runtime fixture");
      return runtime;
    },
    nonInterferenceBoundary: {
      capture: async () => ({
        observation: {
          observedAtUnixMs: 1,
          protectedFiles: [],
          desktopProcesses: [],
          loginContinuity: "authenticated",
          appUsability: "usable",
        },
      }),
      assertUnchanged: async (baseline) => {
        events.push("boundary:verify");
        return baseline;
      },
    },
    runtimeObservationMs: 0,
    observeRuntime,
    ...(onStatusChange === undefined ? {} : { onStatusChange }),
    ...extraOptions,
  });
}

function makeStartupRecoveryService(
  events: string[],
  prepareRuntime: (candidate: RuntimeCandidate) => Promise<OmniCodexPreparedRuntime>,
  verifyBoundary: () => Promise<void> = async () => undefined,
  candidates: readonly RuntimeCandidate[] = [oldCandidate],
  options: { readonly startupReadinessMaxPasses?: number } = {},
): OmniCodexGatewayService {
  return new OmniCodexGatewayService({
    authorize: () => ({ ok: false, status: 401 }),
    discovery: {
      discover: async () => ({ candidates, warnings: [] }),
    },
    prepareRuntime,
    nonInterferenceBoundary: {
      capture: async () => ({
        observation: {
          observedAtUnixMs: 1,
          protectedFiles: [],
          desktopProcesses: [],
          loginContinuity: "authenticated",
          appUsability: "usable",
        },
      }),
      assertUnchanged: async (baseline) => {
        events.push("boundary:verify");
        await verifyBoundary();
        return baseline;
      },
    },
    runtimeObservationMs: 0,
    ...options,
  });
}

function runtimeFixtures(events: string[]): ReadonlyMap<string, OmniCodexPreparedRuntime> {
  return new Map([
    [oldCandidate.canonicalPath, fakeRuntime("old", oldCandidate, events)],
    [newCandidate.canonicalPath, fakeRuntime("new", newCandidate, events)],
  ]);
}

function fakeRuntime(
  name: string,
  candidate: RuntimeCandidate,
  events: string[],
  directJobDispatchAdapter?: DirectJobDispatchAdapter,
): OmniCodexPreparedRuntime {
  const gateway = new FakeGateway(name, events);
  return {
    candidate,
    gateway,
    appServerMethodCount: 1,
    downstreamToolCount: 1,
    responsesToolCount: 1,
    hostToolCount: 1,
    bridgeThreadId: `bridge-${name}`,
    bridgeDisposition: "current",
    bridgeRegistryCurrent: true,
    bridgeRegistryDigest: `registry-${name}`,
    promoteBridge: async () => ({
      bridgeThreadId: `bridge-${name}`,
      bridgeDisposition: "current",
      bridgeRegistryCurrent: true,
    }),
    ...(directJobDispatchAdapter === undefined ? {} : { directJobDispatchAdapter }),
    directProbe: async () => {
      events.push(`${name}:probe`);
    },
    readThreadInventory: async () => ({ active: [], archived: [] }),
    readInteractiveThreadActivity: async () => ({
      structuredContent: { pinnedThreads: [], threads: [] },
    }),
    readChromeUserTabs: async () => ({ tabs: [] }),
    stopChildren: async () => {
      events.push(`${name}:children-stop`);
    },
  };
}

function scheduleAdapter(): DirectJobDispatchAdapter {
  return {
    validate: vi.fn(async () => fakeTargetContract("schedule")),
    dispatch: vi.fn(async (request) => {
      await request.beforeNativeDispatch();
      return {
        status: "succeeded" as const,
        result: { content: [{ type: "text" as const, text: "scheduled" }] },
      };
    }),
  };
}

function fakeTargetContract(identity: string) {
  return {
    catalogRevision: "a".repeat(64),
    targetIdentity: `mcp__demo__${identity}`,
    targetContractDigest: "b".repeat(64),
    modelEffect: "none" as const,
  };
}

class FakeGateway implements OmniCodexRuntimeGateway {
  readonly #name: string;
  readonly #events: string[];
  readonly stopTimeouts: Array<number | undefined> = [];
  #admission: "open" | "draining" = "open";
  #address:
    | {
        readonly host: string;
        readonly port: number;
        readonly path: string;
        readonly fullPath: string;
      }
    | undefined;
  #nextStopError: Error | undefined;
  #beginDrainHook: (() => void) | undefined;
  #resumeHook: (() => void) | undefined;
  #activeMcpRequests = 0;
  #drainCompletion: Promise<void> | undefined;
  #observedChatGptConversationIds: readonly string[] = [];
  #observedOpenAiWorkSessionCount = 0;

  constructor(name: string, events: string[]) {
    this.#name = name;
    this.#events = events;
  }

  get runtimeStatus() {
    return {
      admission: this.#admission,
      activeMcpRequests: this.#activeMcpRequests,
      activeModelTurns: 0,
    } as const;
  }

  get address() {
    return this.#address;
  }

  failNextStopAfterListenerClose(error: Error): void {
    this.#nextStopError = error;
  }

  setAdapterAdmissionHooks(beginDrain: () => void, resume: () => void): void {
    this.#beginDrainHook = beginDrain;
    this.#resumeHook = resume;
  }

  setDrainCompletion(completion: Promise<void>): void {
    this.#activeMcpRequests = 1;
    this.#drainCompletion = completion.finally(() => {
      this.#activeMcpRequests = 0;
      this.#drainCompletion = undefined;
    });
  }

  setObservedChatGptConversationIds(ids: readonly string[]): void {
    this.#observedChatGptConversationIds = [...ids];
  }

  observedChatGptConversationIds(): readonly string[] {
    return this.#observedChatGptConversationIds;
  }

  setObservedOpenAiWorkSessionCount(count: number): void {
    this.#observedOpenAiWorkSessionCount = count;
  }

  observedOpenAiWorkSessionCount(): number {
    return this.#observedOpenAiWorkSessionCount;
  }

  async start() {
    this.#events.push(`${this.#name}:gateway-start`);
    this.#address = {
      host: "127.0.0.1",
      port: 48765,
      path: "/mcp",
      fullPath: "/mcp/full",
    };
    return this.#address;
  }

  async stop(hardTimeoutMs?: number) {
    this.#events.push(`${this.#name}:gateway-stop`);
    this.stopTimeouts.push(hardTimeoutMs);
    this.#address = undefined;
    const error = this.#nextStopError;
    this.#nextStopError = undefined;
    if (error !== undefined) throw error;
  }

  beginDrain() {
    this.#events.push(`${this.#name}:drain`);
    this.#beginDrainHook?.();
    this.#admission = "draining";
    return this.runtimeStatus;
  }

  async awaitDrained(_timeoutMs: number) {
    this.#events.push(`${this.#name}:await-drained`);
    await this.#drainCompletion;
  }

  resumeAdmission() {
    this.#events.push(`${this.#name}:resume`);
    this.#resumeHook?.();
    this.#admission = "open";
    return this.runtimeStatus;
  }
}
