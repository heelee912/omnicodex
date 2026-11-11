import { describe, expect, it } from "vitest";
import {
  createBridgeThreadLifecycle,
  createCodexAppToolsContextResolver,
} from "../src/application/omnicodex-gateway-service.js";

describe("Codex app-global tools context", () => {
  it("archives a local state-only Bridge without failed cross-host lookup and propagates native failures", async () => {
    const calls: Record<string, unknown>[] = [];
    const lifecycle = createBridgeThreadLifecycle({
      callRequiredNative: async (_name, args) => {
        if (args.hostId !== "local")
          throw new Error("Could not determine whether Codex thread exists");
        if (args.threadId === "failed") throw new Error("native archive failed");
        calls.push(args);
        return { threadId: args.threadId, archived: args.archived };
      },
    });
    await expect(lifecycle.setArchived("missing-rollout", true)).resolves.toBeUndefined();
    expect(calls).toEqual([{ threadId: "missing-rollout", archived: true, hostId: "local" }]);
    await expect(lifecycle.setArchived("failed", true)).rejects.toThrow("native archive failed");
  });
  it("uses the renderer's native acceptance instead of desktop writer ownership", async () => {
    const accepted = new Set(["current-codex-thread"]);
    const nativeChecks: Array<{ threadId: string; timeoutMs: number | undefined }> = [];
    let lists = 0;
    let now = 1_000;
    const resolveContext = createCodexAppToolsContextResolver(
      {
        request: async <T>(method: string): Promise<T> => {
          if (method !== "thread/list") throw new Error(`unexpected ${method}`);
          lists += 1;
          return {
            data: [{ id: "recent-rejected" }, { id: "recent-accepted" }],
            nextCursor: null,
          } as T;
        },
      },
      {
        callTool: async (params, options) => {
          nativeChecks.push({
            threadId: params.threadId,
            timeoutMs: options?.timeoutMs,
          });
          return { success: accepted.has(params.threadId), contentItems: [] };
        },
      },
      {
        initialPreferredThreadId: "current-codex-thread",
        now: () => now,
        validationTtlMs: 5_000,
      },
    );

    await expect(resolveContext()).resolves.toBe("current-codex-thread");
    expect(lists).toBe(0);
    expect(nativeChecks).toEqual([expect.objectContaining({ threadId: "current-codex-thread" })]);

    // A recently validated context is shared across callers without another
    // renderer round-trip.
    await expect(resolveContext()).resolves.toBe("current-codex-thread");
    expect(nativeChecks).toHaveLength(1);

    accepted.clear();
    accepted.add("recent-accepted");
    now += 5_001;
    await expect(resolveContext()).resolves.toBe("recent-accepted");
    expect(lists).toBe(1);
    expect(nativeChecks.map((check) => check.threadId)).toEqual(
      expect.arrayContaining(["current-codex-thread", "recent-rejected", "recent-accepted"]),
    );
    expect(nativeChecks.every((check) => check.timeoutMs === undefined)).toBe(true);
  });

  it("single-flights concurrent discovery and stops after the first accepted batch", async () => {
    let lists = 0;
    let checks = 0;
    const resolveContext = createCodexAppToolsContextResolver(
      {
        request: async <T>(): Promise<T> => {
          lists += 1;
          return {
            data: [{ id: "accepted" }, { id: "not-needed-after-batch" }],
            nextCursor: null,
          } as T;
        },
      },
      {
        callTool: async (params) => {
          checks += 1;
          await Promise.resolve();
          return { success: params.threadId === "accepted", contentItems: [] };
        },
      },
      { initialPreferredThreadId: "rejected" },
    );

    await expect(
      Promise.all([resolveContext(), resolveContext(), resolveContext()]),
    ).resolves.toEqual(["accepted", "accepted", "accepted"]);
    expect(lists).toBe(1);
    expect(checks).toBe(3);
  });

  it("never coalesces concurrent explicit callers onto another thread context", async () => {
    const calls: string[] = [];
    const resolveContext = createCodexAppToolsContextResolver(
      {
        request: async <T>(): Promise<T> => {
          throw new Error("fallback inventory must not be needed");
        },
      },
      {
        callTool: async (params) => {
          calls.push(params.threadId);
          if (params.threadId === "slower-a") {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          return { success: true, contentItems: [] };
        },
      },
    );

    await expect(
      Promise.all([resolveContext("slower-a"), resolveContext("faster-b")]),
    ).resolves.toEqual(["slower-a", "faster-b"]);
    expect(calls).toEqual(expect.arrayContaining(["slower-a", "faster-b"]));
  });

  it("uses a late-bound Bridge context before re-entering App Server discovery", async () => {
    const checked: string[] = [];
    let bridgeThreadId: string | undefined;
    const resolveContext = createCodexAppToolsContextResolver(
      {
        request: async <T>(): Promise<T> => {
          throw new Error("reentrant App Server discovery must not run");
        },
      },
      {
        callTool: async (params) => {
          checked.push(params.threadId);
          return { success: params.threadId === bridgeThreadId, contentItems: [] };
        },
      },
      { fallbackThreadId: () => bridgeThreadId },
    );

    bridgeThreadId = "omnicodex-bridge";
    await expect(resolveContext("ephemeral-model-free-thread")).resolves.toBe("omnicodex-bridge");
    expect(checked).toEqual(["ephemeral-model-free-thread", "omnicodex-bridge"]);
  });

  it("never selects an excluded target thread as the native calling context", async () => {
    const checked: string[] = [];
    const resolveContext = createCodexAppToolsContextResolver(
      {
        request: async <T>(): Promise<T> =>
          ({
            data: [{ id: "target-thread" }, { id: "source-thread" }],
            nextCursor: null,
          }) as T,
      },
      {
        callTool: async (params) => {
          checked.push(params.threadId);
          return { success: true, contentItems: [] };
        },
      },
      { initialPreferredThreadId: "target-thread" },
    );

    await expect(resolveContext(undefined, ["target-thread"])).resolves.toBe("source-thread");
    expect(checked).toEqual(["source-thread"]);
  });

  it("propagates one caller boundary through native probes and App Server discovery", async () => {
    const controller = new AbortController();
    const nativeOptions: unknown[] = [];
    const appServerOptions: unknown[] = [];
    const now = 1_000;
    const deadlineUnixMs = 1_400;
    const resolveContext = createCodexAppToolsContextResolver(
      {
        request: async <T>(_method: string, _params: unknown, options?: unknown): Promise<T> => {
          appServerOptions.push(options);
          return { data: [{ id: "accepted" }], nextCursor: null } as T;
        },
      },
      {
        callTool: async (params, options) => {
          nativeOptions.push(options);
          return { success: params.threadId === "accepted", contentItems: [] };
        },
      },
      { now: () => now },
    );

    await expect(
      resolveContext("rejected", [], {
        deadlineUnixMs,
        signal: controller.signal,
        timeoutMs: 500,
      }),
    ).resolves.toBe("accepted");

    expect(nativeOptions).toEqual([
      {
        deadlineUnixMs,
        signal: controller.signal,
        timeoutMs: 400,
      },
      {
        deadlineUnixMs,
        signal: controller.signal,
        timeoutMs: 400,
      },
    ]);
    expect(appServerOptions).toEqual([
      {
        deadlineUnixMs,
        signal: controller.signal,
        timeoutMs: 400,
      },
    ]);
  });

  it("paginates beyond the former forty-candidate adapter cap", async () => {
    const checked: string[] = [];
    const cursors: Array<string | undefined> = [];
    const resolveContext = createCodexAppToolsContextResolver(
      {
        request: async <T>(_method: string, params: unknown): Promise<T> => {
          const cursor =
            typeof params === "object" && params !== null && "cursor" in params
              ? String((params as { cursor?: unknown }).cursor)
              : undefined;
          cursors.push(cursor);
          return (
            cursor === undefined
              ? {
                  data: Array.from({ length: 40 }, (_, index) => ({ id: `rejected-${index}` })),
                  nextCursor: "page-2",
                }
              : { data: [{ id: "accepted-after-former-cap" }], nextCursor: null }
          ) as T;
        },
      },
      {
        callTool: async (params) => {
          checked.push(params.threadId);
          return {
            success: params.threadId === "accepted-after-former-cap",
            contentItems: [],
          };
        },
      },
    );

    await expect(resolveContext()).resolves.toBe("accepted-after-former-cap");
    expect(cursors).toEqual([undefined, "page-2"]);
    expect(checked).toContain("accepted-after-former-cap");
  });

  it("propagates native transport failures instead of misreporting every context as rejected", async () => {
    const resolveContext = createCodexAppToolsContextResolver(
      {
        request: async <T>(): Promise<T> => ({ data: [] }) as T,
      },
      {
        callTool: async () => {
          const error = new Error("native tools pipe unavailable");
          Object.assign(error, { code: "PIPE_UNAVAILABLE" });
          throw error;
        },
      },
      { initialPreferredThreadId: "candidate" },
    );

    await expect(resolveContext()).rejects.toMatchObject({
      code: "PIPE_UNAVAILABLE",
      message: "native tools pipe unavailable",
    });
  });
});
