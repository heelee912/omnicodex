import { describe, expect, it } from "vitest";
import type { BrowserNativeContextRequest } from "../src/application/browser-native-executor.js";
import { createCodexBrowserContextResolver } from "../src/application/codex-browser-context-resolver.js";

describe("Codex browser context resolver", () => {
  it("verifies only the exact requested desktop-owned IAB task without inventory scanning", async () => {
    const appServerCalls: string[] = [];
    const ownerCalls: string[] = [];
    const resolveContext = createCodexBrowserContextResolver(
      {
        request: async <T>(method: string): Promise<T> => {
          appServerCalls.push(method);
          return { data: [{ id: "unrelated-recent-task" }] } as T;
        },
      },
      {
        findThreadOwner: async (threadId, options) => {
          ownerCalls.push(threadId);
          expect(options).toEqual({ hostId: "local" });
          return threadId === "desktop-current" ? "desktop-window" : null;
        },
      },
    );

    await expect(resolveContext(iabRequest("desktop-current"))).resolves.toBe("desktop-current");
    expect(ownerCalls).toEqual(["desktop-current"]);
    expect(appServerCalls).toEqual([]);
  });

  it.each(["documentation", "inspect", "list_tabs", "list_user_tabs"] as const)(
    "uses the exact desktop task for IAB %s",
    async (operation) => {
      const appServerCalls: string[] = [];
      const ownerCalls: string[] = [];
      const resolveContext = createCodexBrowserContextResolver(
        {
          request: async <T>(method: string): Promise<T> => {
            appServerCalls.push(method);
            return { data: [{ id: "other-owned" }] } as T;
          },
        },
        {
          findThreadOwner: async (threadId) => {
            ownerCalls.push(threadId);
            return threadId === "not-owned" ? null : "desktop-window";
          },
        },
        { initialPreferredThreadId: "other-owned" },
      );

      await expect(
        resolveContext({ operation, surface: "iab", contextThreadId: "desktop-current" }),
      ).resolves.toBe("desktop-current");
      await expect(
        resolveContext({ operation, surface: "iab", contextThreadId: "not-owned" }),
      ).resolves.toBeUndefined();
      expect(ownerCalls).toEqual(["desktop-current", "not-owned"]);
      expect(appServerCalls).toEqual([]);
    },
  );

  it("does not fall back when an IAB request omits its exact task", async () => {
    const appServerCalls: string[] = [];
    const ownerCalls: string[] = [];
    const resolveContext = createCodexBrowserContextResolver(
      {
        request: async <T>(method: string): Promise<T> => {
          appServerCalls.push(method);
          return { data: [{ id: "recent-desktop-owned" }] } as T;
        },
      },
      {
        findThreadOwner: async (threadId) => {
          ownerCalls.push(threadId);
          return "desktop-window";
        },
      },
      { initialPreferredThreadId: "legacy-preferred-task" },
    );

    await expect(resolveContext({ operation: "exec", surface: "iab" })).resolves.toBeUndefined();
    expect(ownerCalls).toEqual([]);
    expect(appServerCalls).toEqual([]);
  });

  it("does not substitute another desktop-owned task when the exact requested IAB task is not owned", async () => {
    const appServerCalls: string[] = [];
    const ownerCalls: string[] = [];
    const resolveContext = createCodexBrowserContextResolver(
      {
        request: async <T>(method: string): Promise<T> => {
          appServerCalls.push(method);
          return { data: [{ id: "desktop-owned-but-not-requested" }] } as T;
        },
      },
      {
        findThreadOwner: async (threadId) => {
          ownerCalls.push(threadId);
          return threadId === "desktop-owned-but-not-requested" ? "desktop-window" : null;
        },
      },
    );

    await expect(resolveContext(iabRequest("requested-not-owned"))).resolves.toBeUndefined();
    expect(ownerCalls).toEqual(["requested-not-owned"]);
    expect(appServerCalls).toEqual([]);
  });

  it("retains recency-based live desktop hosting for app-global Chrome and surface listing", async () => {
    const ownerCalls: string[] = [];
    let listCalls = 0;
    const resolveContext = createCodexBrowserContextResolver(
      {
        request: async <T>(method: string, params: unknown, timeoutMs?: number): Promise<T> => {
          listCalls += 1;
          expect(method).toBe("thread/list");
          expect(params).toMatchObject({
            archived: false,
            limit: 100,
            modelProviders: [],
            sortDirection: "desc",
            sortKey: "recency_at",
            useStateDbOnly: true,
          });
          expect(timeoutMs).toBeUndefined();
          return {
            data: [{ id: "recent-unloaded" }, { id: "desktop-owned" }, { id: "older-owned" }],
          } as T;
        },
      },
      {
        findThreadOwner: async (threadId) => {
          ownerCalls.push(threadId);
          return threadId === "desktop-owned" || threadId === "older-owned"
            ? `owner-${threadId}`
            : null;
        },
      },
    );

    await expect(resolveContext({ operation: "list_surfaces" })).resolves.toBe("desktop-owned");
    await expect(resolveContext({ operation: "exec", surface: "chrome" })).resolves.toBe(
      "desktop-owned",
    );
    expect(listCalls).toBe(1);
    expect(ownerCalls).toEqual([
      "recent-unloaded",
      "desktop-owned",
      "older-owned",
      "desktop-owned",
    ]);
  });

  it("paginates past the former fifty-task discovery cap without a caller limit", async () => {
    const ownerCalls: string[] = [];
    const listCursors: Array<string | undefined> = [];
    const firstPage = Array.from({ length: 50 }, (_, index) => ({ id: `task-${index}` }));
    const resolveContext = createCodexBrowserContextResolver(
      {
        request: async <T>(_method: string, params: unknown): Promise<T> => {
          const cursor =
            typeof params === "object" && params !== null && "cursor" in params
              ? String((params as { cursor?: unknown }).cursor)
              : undefined;
          listCursors.push(cursor);
          return (
            cursor === undefined
              ? { data: firstPage, nextCursor: "page-2" }
              : { data: [{ id: "task-50" }, { id: "desktop-owned-after-cap" }] }
          ) as T;
        },
      },
      {
        findThreadOwner: async (threadId) => {
          ownerCalls.push(threadId);
          return threadId === "desktop-owned-after-cap" ? "desktop-window" : null;
        },
      },
    );

    await expect(resolveContext({ operation: "list_surfaces" })).resolves.toBe(
      "desktop-owned-after-cap",
    );
    expect(listCursors).toEqual([undefined, "page-2"]);
    expect(ownerCalls).toContain("task-50");
    expect(ownerCalls).toContain("desktop-owned-after-cap");
  });

  it("partitions exact IAB validation cache by owner and durable work session", async () => {
    let now = 1_000;
    const ownerCalls: string[] = [];
    const resolveContext = createCodexBrowserContextResolver(
      { request: async <T>(): Promise<T> => ({ data: [] }) as T },
      {
        findThreadOwner: async (threadId) => {
          ownerCalls.push(threadId);
          return "desktop-window";
        },
      },
      { now: () => now, validationTtlMs: 5_000 },
    );
    const first = iabRequest("thread-a", "owner-a", "work-a");

    await expect(resolveContext(first)).resolves.toBe("thread-a");
    now += 4_999;
    await expect(resolveContext(first)).resolves.toBe("thread-a");
    await expect(resolveContext(iabRequest("thread-a", "owner-b", "work-a"))).resolves.toBe(
      "thread-a",
    );
    await expect(resolveContext(iabRequest("thread-a", "owner-b", "work-b"))).resolves.toBe(
      "thread-a",
    );
    // Another caller's validation must not evict this still-valid identity.
    await expect(resolveContext(first)).resolves.toBe("thread-a");

    expect(ownerCalls).toEqual(["thread-a", "thread-a", "thread-a"]);
  });

  it("single-flights concurrent ownership probes for the same exact bound IAB identity", async () => {
    let releaseOwner: (() => void) | undefined;
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    let ownerCalls = 0;
    const resolveContext = createCodexBrowserContextResolver(
      { request: async <T>(): Promise<T> => ({ data: [] }) as T },
      {
        findThreadOwner: async () => {
          ownerCalls += 1;
          await ownerGate;
          return "desktop-window";
        },
      },
    );
    const request = iabRequest("desktop-owned", "owner-a", "work-a");
    const first = resolveContext(request);
    const second = resolveContext(request);
    releaseOwner?.();

    await expect(Promise.all([first, second])).resolves.toEqual(["desktop-owned", "desktop-owned"]);
    expect(ownerCalls).toBe(1);
  });

  it("propagates the exact caller signal and absolute deadline to IAB desktop ownership discovery", async () => {
    const controller = new AbortController();
    const deadlineUnixMs = Date.now() + 60_000;
    let observedOptions:
      | {
          readonly hostId?: string;
          readonly timeoutMs?: number;
          readonly deadlineUnixMs?: number;
          readonly signal?: AbortSignal;
        }
      | undefined;
    const resolveContext = createCodexBrowserContextResolver(
      { request: async <T>(): Promise<T> => ({ data: [] }) as T },
      {
        findThreadOwner: async (_threadId, options) => {
          observedOptions = options;
          return new Promise<string | null>((_resolve, reject) => {
            const signal = options?.signal;
            if (signal?.aborted === true) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      },
    );

    const pending = resolveContext(iabRequest("desktop-owned"), {
      signal: controller.signal,
      deadlineUnixMs,
    });
    expect(observedOptions).toEqual({
      hostId: "local",
      deadlineUnixMs,
      signal: controller.signal,
    });
    const reason = new Error("caller stopped IAB discovery");
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("propagates the caller boundary through every app-global inventory page request", async () => {
    const controller = new AbortController();
    const deadlineUnixMs = Date.now() + 60_000;
    const observedBoundaries: unknown[] = [];
    const resolveContext = createCodexBrowserContextResolver(
      {
        request: async <T>(_method: string, _params: unknown, boundary?: unknown): Promise<T> => {
          observedBoundaries.push(boundary);
          return { data: [], nextCursor: null } as T;
        },
      },
      { findThreadOwner: async () => null },
    );

    await expect(
      resolveContext(
        { operation: "exec", surface: "chrome" },
        { signal: controller.signal, deadlineUnixMs },
      ),
    ).resolves.toBeUndefined();
    expect(observedBoundaries).toEqual([{ signal: controller.signal, deadlineUnixMs }]);
  });
});

function iabRequest(
  contextThreadId: string,
  ownerBinding = "owner-binding",
  workSessionBinding = "work-session-binding",
): BrowserNativeContextRequest {
  return {
    operation: "exec",
    surface: "iab",
    contextThreadId,
    ownerBinding,
    workSessionBinding,
  };
}
