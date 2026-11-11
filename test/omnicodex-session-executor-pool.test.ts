import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { BrowserNativeExecutor } from "../src/application/browser-native-executor.js";
import {
  createDisposableNativeAppServerContext,
  type OmniCodexSessionNativeRuntime,
} from "../src/application/disposable-native-app-server-context.js";
import { NativeToolExecutor } from "../src/application/native-tool-catalog.js";
import {
  OMNICODEX_DURABLE_NATIVE_CONTEXT_IDLE_MS,
  OmniCodexSessionExecutorPool,
  type OmniCodexSessionResponsesRuntime,
} from "../src/application/omnicodex-gateway-service.js";
import type { McpSessionExecutorContext } from "../src/infrastructure/mcp/streamable-http-gateway.js";

const context = (correlationId: string): McpSessionExecutorContext => ({
  identity: {
    issuer: "https://issuer.example",
    subject: `subject-${correlationId}`,
    clientId: "client",
    resource: "https://omnicodex.example/mcp/full",
  },
  authorizationBinding: `binding-${correlationId}`,
  correlationId,
});

const workSessionContext = (
  correlationId: string,
  authorizationBinding: string,
  resolveWorkSessionBinding: () => string | undefined,
): McpSessionExecutorContext => ({
  identity: {
    issuer: "https://issuer.example",
    subject: "durable-owner",
    clientId: `client-${correlationId}`,
    resource: "https://omnicodex.example/mcp/full",
  },
  authorizationBinding,
  correlationId,
  resolveWorkSessionBinding,
});

const nativeExecutor = (): NativeToolExecutor =>
  new NativeToolExecutor({
    request: async <T>(): Promise<T> => {
      throw new Error("native executor was not expected to run");
    },
  });

describe("OmniCodex session executor pool", () => {
  it("closes durable session contexts after their Desktop app-server exits", async () => {
    let serverExited = false;
    let connectionStops = 0;
    const pool = new OmniCodexSessionExecutorPool({
      createNativeRuntime: (_context, signal) =>
        createDisposableNativeAppServerContext(
          {
            candidate: {
              executablePath: "C:\\Codex\\codex.exe",
              canonicalPath: "C:\\Codex\\codex.exe",
              source: "managed_install",
              buildSha256: "a".repeat(64),
            },
            processFactory: () => ({
              client: {
                request: async <T>(method: string): Promise<T> => {
                  if (method === "thread/start") return { thread: { id: "owned" } } as T;
                  if (method === "thread/delete" && serverExited) {
                    throw new Error("JSONL App Server stream ended");
                  }
                  return { content: [] } as T;
                },
              },
              start: async () => undefined,
              stop: async () => {
                connectionStops += 1;
              },
              hasAppServerExited: () => serverExited,
            }),
          },
          signal,
        ),
      createResponsesRuntime: async () => immediateRuntime(),
    });
    const session = pool.createSessionExecutors(
      workSessionContext("dead-desktop", "principal", () => "durable-session"),
    );
    await session.nativeToolExecutor?.call("server", "tool", {});
    serverExited = true;

    await expect(pool.close({ preserveBrowserActivities: true })).resolves.toBeUndefined();
    expect(connectionStops).toBe(1);
  });

  it("serializes calls without evicting state when a second work session runs", async () => {
    const firstCall = deferred<void>();
    let created = 0;
    let active = 0;
    let maximum = 0;
    const pool = new OmniCodexSessionExecutorPool({
      responsesCallConcurrency: 1,
      createNativeToolExecutor: nativeExecutor,
      createResponsesRuntime: async () => {
        const generation = ++created;
        let count = 0;
        return {
          ...immediateRuntime(),
          callNested: async () => {
            active += 1;
            maximum = Math.max(maximum, active);
            if (generation === 1 && count === 0) await firstCall.promise;
            active -= 1;
            return `${generation}:${++count}`;
          },
        };
      },
    });
    const a = pool.createSessionExecutors(context("A"));
    const b = pool.createSessionExecutors(context("B"));
    const first = a.responsesToolExecutor?.callNested("tool", {}, false);
    await waitFor(() => active === 1);
    const second = b.responsesToolExecutor?.callNested("tool", {}, false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(created).toBe(1);
    firstCall.resolve();
    await expect(first).resolves.toBe("1:1");
    await expect(second).resolves.toBe("2:1");
    await expect(a.responsesToolExecutor?.callNested("tool", {}, false)).resolves.toBe("1:2");
    expect(created).toBe(2);
    expect(maximum).toBe(1);
    await pool.close();
  });

  it("allows twelve independent sessions concurrently without a global call cap", async () => {
    const blocked = deferred<void>();
    let active = 0;
    let maximum = 0;
    const pool = new OmniCodexSessionExecutorPool({
      createNativeToolExecutor: nativeExecutor,
      createResponsesRuntime: async () => ({
        ...immediateRuntime(),
        callNested: async () => {
          active += 1;
          maximum = Math.max(maximum, active);
          await blocked.promise;
          active -= 1;
          return "done";
        },
      }),
    });
    const sessions = Array.from({ length: 12 }, (_, index) =>
      pool.createSessionExecutors(context(`session-${index}`)),
    );
    const calls = sessions.map((session) =>
      session.responsesToolExecutor?.callNested("tool", {}, false),
    );
    try {
      await waitFor(() => active === 12);
      expect(maximum).toBe(12);
    } finally {
      blocked.resolve();
    }
    await expect(Promise.all(calls)).resolves.toEqual(Array(12).fill("done"));
    await pool.close();
  });

  it("cancels a queued call before allocating another execution context", async () => {
    const block = deferred<void>();
    let created = 0;
    const pool = new OmniCodexSessionExecutorPool({
      responsesCallConcurrency: 1,
      createNativeToolExecutor: nativeExecutor,
      createResponsesRuntime: async () => {
        created += 1;
        return {
          ...immediateRuntime(),
          callNested: async () => {
            await block.promise;
            return "done";
          },
        };
      },
    });
    const a = pool.createSessionExecutors(context("A"));
    const b = pool.createSessionExecutors(context("B"));
    const first = a.responsesToolExecutor?.callNested("tool", {}, false);
    await waitFor(() => created === 1);
    const cancel = new AbortController();
    const second = b.responsesToolExecutor?.callNested("tool", {}, false, cancel.signal);
    cancel.abort(new Error("caller canceled"));
    await expect(second).rejects.toThrow("caller canceled");
    expect(created).toBe(1);
    block.resolve();
    await first;
    await pool.close();
  });

  it("waits for Responses idle retirement before accepting a new call", async () => {
    const stopped = deferred<void>();
    let generations = 0;
    const events: string[] = [];
    const pool = new OmniCodexSessionExecutorPool({
      responsesRuntimeIdleMs: 5,
      createNativeToolExecutor: nativeExecutor,
      createResponsesRuntime: async () => {
        const generation = ++generations;
        return {
          ...immediateRuntime(),
          callNested: async () => {
            events.push(`call:${generation}`);
            return generation;
          },
          close: async () => {
            events.push(`stop:${generation}`);
            if (generation === 1) await stopped.promise;
          },
        };
      },
    });
    const session = pool.createSessionExecutors(context("responses-retirement"));
    await session.responsesToolExecutor?.callNested("tool", {}, false);
    await waitFor(() => events.includes("stop:1"));
    const next = session.responsesToolExecutor?.callNested("tool", {}, false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["call:1", "stop:1"]);
    stopped.resolve();
    await expect(next).resolves.toBe(2);
    expect(events).toEqual(["call:1", "stop:1", "call:2"]);
    await pool.close();
  });

  it.each([false, true])(
    "retires a failed Responses generation without replay, close initially fails=%s",
    async (failClose) => {
      const failure = Object.assign(new Error("Responses RPC deadline"), {
        code: "JSONL_RPC_DEADLINE_EXCEEDED",
      });
      let generations = 0;
      let closes = 0;
      const calls: number[] = [];
      const pool = new OmniCodexSessionExecutorPool({
        maxActiveResponsesRuntimes: 1,
        createNativeToolExecutor: nativeExecutor,
        createResponsesRuntime: async () => {
          const generation = ++generations;
          return {
            ...immediateRuntime(),
            callNested: async () => {
              calls.push(generation);
              if (generation === 1) throw failure;
              return "recovered";
            },
            close: async () => {
              closes += 1;
              if (failClose && closes === 1) throw new Error("child stop failed");
            },
          };
        },
      });
      const session = pool.createSessionExecutors(context("responses-failed"));
      const failed = session.responsesToolExecutor?.callNested("mutate", {}, false);
      if (failClose)
        await expect(failed).rejects.toThrow("Failed Responses runtime did not stop cleanly");
      else await expect(failed).rejects.toBe(failure);
      expect(calls).toEqual([1]);
      await expect(session.responsesToolExecutor?.callNested("read", {}, false)).resolves.toBe(
        "recovered",
      );
      expect(calls).toEqual([1, 2]);
      expect(generations).toBe(2);
      await pool.close();
    },
  );

  it("wires native idle retirement and a single shared Responses transport into production", async () => {
    expect(OMNICODEX_DURABLE_NATIVE_CONTEXT_IDLE_MS).toBe(60_000);
    const serviceSource = await readFile(
      new URL("../src/application/omnicodex-gateway-service.ts", import.meta.url),
      "utf8",
    );

    expect(serviceSource).toContain(
      "nativeContextIdleMs: OMNICODEX_DURABLE_NATIVE_CONTEXT_IDLE_MS,",
    );
    expect(serviceSource).not.toContain("OMNICODEX_DURABLE_RESPONSES_RUNTIME_IDLE_MS");
    expect(serviceSource).toMatch(/new SharedResponsesAppServer\(\s*candidate,/);
    expect(serviceSource).toContain(
      "(runtime, processOptions) => new CodexAppServerProcess(runtime, processOptions)",
    );
    expect(serviceSource).toContain("model_provider=");
    expect(serviceSource).toContain("...(this.#options.sessionResponsesRuntimeLimit === undefined");
    expect(serviceSource).not.toContain("OMNICODEX_DURABLE_RESPONSES_RUNTIME_LIMIT");
  });

  it("keeps native and Responses children fully lazy", async () => {
    let nativeExecutors = 0;
    let responsesRuntimes = 0;
    const pool = new OmniCodexSessionExecutorPool({
      createNativeToolExecutor: () => {
        nativeExecutors += 1;
        return nativeExecutor();
      },
      createResponsesRuntime: async () => {
        responsesRuntimes += 1;
        return immediateRuntime();
      },
    });

    const first = pool.createSessionExecutors(context("first"));
    const second = pool.createSessionExecutors(context("second"));

    expect(nativeExecutors).toBe(0);
    expect(first.nativeToolExecutor).not.toBe(second.nativeToolExecutor);
    expect(responsesRuntimes).toBe(0);
    expect(pool.activeResponsesRuntimeCount).toBe(0);

    await first.close?.();
    await second.close?.();
    await pool.close();
    expect(responsesRuntimes).toBe(0);
  });

  it("isolates browser execution by Web work session and reuses it after reconnect", async () => {
    let browserExecutors = 0;
    const finishedActivities: string[] = [];
    const pool = new OmniCodexSessionExecutorPool({
      createNativeToolExecutor: nativeExecutor,
      createBrowserNativeExecutor: () =>
        new RecordingBrowserNativeExecutor(`browser-${++browserExecutors}`, (activityBinding) =>
          finishedActivities.push(activityBinding),
        ),
      createResponsesRuntime: async () => immediateRuntime(),
    });
    const firstBinding = () => "browser-work-session-a";
    const first = pool.createSessionExecutors(
      workSessionContext("first-browser-transport", "principal-a", firstBinding),
    );
    const reconnected = pool.createSessionExecutors(
      workSessionContext("second-browser-transport", "principal-a", firstBinding),
    );
    const other = pool.createSessionExecutors(
      workSessionContext("other-browser-transport", "principal-a", () => "browser-work-session-b"),
    );

    await expect(first.browserNativeExecutor?.call({})).resolves.toBe("browser-1");
    await expect(reconnected.browserNativeExecutor?.call({})).resolves.toBe("browser-1");
    await expect(other.browserNativeExecutor?.call({})).resolves.toBe("browser-2");
    await first.browserNativeExecutor?.finishActivity?.("turn:first");
    await other.browserNativeExecutor?.finishActivity?.("turn:other");
    expect(browserExecutors).toBe(2);
    expect(finishedActivities).toEqual(["turn:first", "turn:other"]);

    await pool.close();
  });

  it("does not impose the former eight-runtime or idle-expiry defaults", async () => {
    let creates = 0;
    let closes = 0;
    const pool = new OmniCodexSessionExecutorPool({
      createNativeToolExecutor: nativeExecutor,
      createResponsesRuntime: async () => {
        creates += 1;
        return {
          ...immediateRuntime(),
          close: async () => {
            closes += 1;
          },
        };
      },
    });
    const sessions = Array.from({ length: 12 }, (_, index) =>
      pool.createSessionExecutors(context(`unbounded-${index}`)),
    );

    await expect(
      Promise.all(
        sessions.map((session) => session.responsesToolExecutor?.callNested("tool", {}, false)),
      ),
    ).resolves.toEqual(Array.from({ length: 12 }, () => "result"));
    expect(creates).toBe(12);
    expect(pool.activeResponsesRuntimeCount).toBe(12);
    expect(closes).toBe(0);

    await Promise.all(sessions.map((session) => session.close?.()));
    await pool.close();
    expect(closes).toBe(12);
  });

  it("retries a failed child close without forgetting its handle or capacity ownership", async () => {
    let closes = 0;
    let retirements = 0;
    const pool = new OmniCodexSessionExecutorPool({
      createNativeToolExecutor: () => new RetiringNativeToolExecutor(() => retirements++),
      createResponsesRuntime: async () => ({
        ...immediateRuntime(),
        close: async () => {
          if (++closes === 1) throw new Error("child close failed");
        },
      }),
    });
    const session = pool.createSessionExecutors(context("retry-child-close"));
    await session.responsesToolExecutor?.callNested("tool", {}, false);
    await expect(pool.close()).rejects.toThrow("child close failed");
    expect(pool.activeResponsesRuntimeCount).toBe(1);
    expect(retirements).toBe(0);

    await Promise.all([pool.close(), pool.close()]);
    expect(closes).toBe(2);
    expect(retirements).toBe(0);
    expect(pool.activeResponsesRuntimeCount).toBe(0);
    await pool.close();
    expect(closes).toBe(2);
  });

  it("propagates service replacement without aborting browser activities", async () => {
    const received: unknown[] = [];
    let retirements = 0;
    class PreservedBrowser extends RecordingBrowserNativeExecutor {
      override async close(options?: { readonly preserveActivities?: boolean }): Promise<void> {
        received.push(options);
      }
    }
    const pool = new OmniCodexSessionExecutorPool({
      createNativeToolExecutor: () => new RetiringNativeToolExecutor(() => retirements++),
      createBrowserNativeExecutor: () => new PreservedBrowser("browser"),
      createResponsesRuntime: async () => immediateRuntime(),
    });
    pool.createSessionExecutors(context("preserve-browser"));
    await pool.close({ preserveBrowserActivities: true });
    expect(received).toEqual([{ preserveActivities: true }]);
    expect(retirements).toBe(0);
  });

  it("retains a session after failed browser retirement so pool close can retry it", async () => {
    let browserCloses = 0;
    let runtimeCloses = 0;
    let retirements = 0;
    class FailingRetirementBrowser extends RecordingBrowserNativeExecutor {
      override async close(): Promise<void> {
        if (++browserCloses === 1) throw new Error("browser retirement failed");
      }
    }
    const pool = new OmniCodexSessionExecutorPool({
      createNativeToolExecutor: () => new RetiringNativeToolExecutor(() => retirements++),
      createBrowserNativeExecutor: () => new FailingRetirementBrowser("browser"),
      createResponsesRuntime: async () => ({
        ...immediateRuntime(),
        close: async () => {
          runtimeCloses++;
        },
      }),
    });
    const session = pool.createSessionExecutors(context("retry-browser-retirement"));
    await session.responsesToolExecutor?.callNested("tool", {}, false);
    await expect(session.close?.()).rejects.toThrow("browser retirement failed");
    expect(retirements).toBe(0);

    await Promise.all([pool.close(), pool.close()]);
    expect(browserCloses).toBe(2);
    expect(runtimeCloses).toBe(1);
    expect(retirements).toBe(0);
  });

  it("retains a late-created child when shutdown has started and its close fails", async () => {
    const creation = deferred<OmniCodexSessionResponsesRuntime>();
    let started = false;
    let canClose = false;
    let retirements = 0;
    const pool = new OmniCodexSessionExecutorPool({
      createNativeToolExecutor: () => new RetiringNativeToolExecutor(() => retirements++),
      createResponsesRuntime: async () => {
        started = true;
        return creation.promise;
      },
    });
    const session = pool.createSessionExecutors(context("late-child-close"));
    const call = session.responsesToolExecutor?.callNested("tool", {}, false);
    const callError = call?.catch((error: unknown) => error);
    await waitFor(() => started);
    const closing = pool.close();
    const closeError = closing.catch((error: unknown) => error);
    creation.resolve({
      ...immediateRuntime(),
      close: async () => {
        if (!canClose) throw new Error("late child close failed");
      },
    });
    await expect(callError).resolves.toBeInstanceOf(Error);
    await expect(closeError).resolves.toMatchObject({ message: "late child close failed" });
    expect(pool.activeResponsesRuntimeCount).toBe(1);
    expect(retirements).toBe(0);

    canClose = true;
    await pool.close();
    expect(pool.activeResponsesRuntimeCount).toBe(0);
    expect(retirements).toBe(0);
  });

  it("shares one mutable lease across concurrent and reconnecting transports for the same Web conversation", async () => {
    let nativeExecutors = 0;
    let responsesRuntimes = 0;
    let responsesRuntimeCloses = 0;
    const pool = new OmniCodexSessionExecutorPool({
      createNativeToolExecutor: () => {
        nativeExecutors += 1;
        return new RecordingNativeToolExecutor(`native-${nativeExecutors}`);
      },
      createResponsesRuntime: async (sessionContext) => {
        responsesRuntimes += 1;
        return {
          call: async () => {
            throw new Error("unexpected direct call");
          },
          callNested: async () => `responses-${sessionContext.correlationId}`,
          close: async () => {
            responsesRuntimeCloses += 1;
          },
        };
      },
    });
    const binding = () => "work-session-a";
    const first = pool.createSessionExecutors(
      workSessionContext("first-transport", "principal-a", binding),
    );
    const concurrent = pool.createSessionExecutors(
      workSessionContext("concurrent-transport", "principal-a", binding),
    );

    expect(nativeExecutors).toBe(0);
    await expect(first.nativeToolExecutor?.call("server", "tool", {})).resolves.toBe("native-1");
    await expect(concurrent.nativeToolExecutor?.call("server", "tool", {})).resolves.toBe(
      "native-1",
    );
    expect(first.nativeToolExecutor?.executionContextIdentity()).toBe(
      concurrent.nativeToolExecutor?.executionContextIdentity(),
    );
    await expect(first.responsesToolExecutor?.callNested("tool", {}, false)).resolves.toBe(
      "responses-first-transport",
    );
    await expect(concurrent.responsesToolExecutor?.callNested("tool", {}, false)).resolves.toBe(
      "responses-first-transport",
    );
    expect(nativeExecutors).toBe(1);
    expect(responsesRuntimes).toBe(1);

    await first.close?.();
    await expect(first.nativeToolExecutor?.call("server", "tool", {})).resolves.toBe("native-1");
    const reconnected = pool.createSessionExecutors(
      workSessionContext("reconnected-transport", "principal-a", binding),
    );
    await expect(reconnected.nativeToolExecutor?.call("server", "tool", {})).resolves.toBe(
      "native-1",
    );
    expect(reconnected.nativeToolExecutor?.executionContextIdentity()).toBe(
      first.nativeToolExecutor?.executionContextIdentity(),
    );

    await Promise.all([concurrent.close?.(), reconnected.close?.()]);
    await pool.close();
    expect(nativeExecutors).toBe(1);
    expect(responsesRuntimeCloses).toBe(1);
  });

  it("isolates leases when either the durable principal or Web conversation changes", async () => {
    let nativeExecutors = 0;
    const pool = new OmniCodexSessionExecutorPool({
      createNativeToolExecutor: () => {
        nativeExecutors += 1;
        return new RecordingNativeToolExecutor(`native-${nativeExecutors}`);
      },
      createResponsesRuntime: async () => immediateRuntime(),
    });
    const first = pool.createSessionExecutors(
      workSessionContext("first", "principal-a", () => "work-session-a"),
    );
    const differentConversation = pool.createSessionExecutors(
      workSessionContext("second", "principal-a", () => "work-session-b"),
    );
    const differentPrincipal = pool.createSessionExecutors(
      workSessionContext("third", "principal-b", () => "work-session-a"),
    );

    await expect(first.nativeToolExecutor?.call("server", "tool", {})).resolves.toBe("native-1");
    await expect(
      differentConversation.nativeToolExecutor?.call("server", "tool", {}),
    ).resolves.toBe("native-2");
    await expect(differentPrincipal.nativeToolExecutor?.call("server", "tool", {})).resolves.toBe(
      "native-3",
    );
    expect(nativeExecutors).toBe(3);

    await Promise.all([
      first.close?.(),
      differentConversation.close?.(),
      differentPrincipal.close?.(),
    ]);
    await pool.close();
  });

  it("aborts an in-flight session runtime creation before waiting for its close", async () => {
    let creationSignal: AbortSignal | undefined;
    const creationStarted = deferred<void>();
    const pool = new OmniCodexSessionExecutorPool({
      createNativeToolExecutor: nativeExecutor,
      createResponsesRuntime: async (_sessionContext, _nativeToolExecutor, signal) => {
        creationSignal = signal;
        creationStarted.resolve();
        return new Promise<OmniCodexSessionResponsesRuntime>((_resolve, reject) => {
          const rejectAborted = () =>
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error("session creation aborted"),
            );
          if (signal.aborted) rejectAborted();
          else signal.addEventListener("abort", rejectAborted, { once: true });
        });
      },
    });
    const session = pool.createSessionExecutors(context("creating"));
    const call = session.responsesToolExecutor?.callNested("tool", {}, false);
    await creationStarted.promise;

    await session.close?.();
    expect(creationSignal?.aborted).toBe(true);
    await expect(call).rejects.toThrow("OmniCodex MCP session executor is closed");
    expect(pool.activeResponsesRuntimeCount).toBe(0);
    await pool.close();
  });

  it("never exceeds the configured Responses child limit and evicts only an idle session", async () => {
    const calls = new Map<string, Deferred<unknown>>();
    let liveRuntimes = 0;
    let maximumLiveRuntimes = 0;
    let createdRuntimes = 0;
    const pool = new OmniCodexSessionExecutorPool({
      maxActiveResponsesRuntimes: 2,
      responsesRuntimeIdleMs: 60_000,
      createNativeToolExecutor: nativeExecutor,
      createResponsesRuntime: async (sessionContext) => {
        createdRuntimes += 1;
        liveRuntimes += 1;
        maximumLiveRuntimes = Math.max(maximumLiveRuntimes, liveRuntimes);
        let closed = false;
        return {
          call: async () => {
            throw new Error("unexpected direct call");
          },
          callNested: async () => {
            const pending = deferred<unknown>();
            calls.set(sessionContext.correlationId, pending);
            return pending.promise;
          },
          close: async () => {
            if (closed) return;
            closed = true;
            liveRuntimes -= 1;
          },
        } satisfies OmniCodexSessionResponsesRuntime;
      },
    });
    const first = pool.createSessionExecutors(context("first"));
    const second = pool.createSessionExecutors(context("second"));
    const third = pool.createSessionExecutors(context("third"));

    const firstCall = first.responsesToolExecutor?.callNested("tool", {}, false);
    const secondCall = second.responsesToolExecutor?.callNested("tool", {}, false);
    await waitFor(() => calls.size === 2);
    const thirdCall = third.responsesToolExecutor?.callNested("tool", {}, false);
    await Promise.resolve();

    expect(createdRuntimes).toBe(2);
    expect(maximumLiveRuntimes).toBe(2);
    calls.get("first")?.resolve("first-result");
    await expect(firstCall).resolves.toBe("first-result");
    await waitFor(() => calls.has("third"));

    expect(createdRuntimes).toBe(3);
    expect(liveRuntimes).toBe(2);
    expect(maximumLiveRuntimes).toBe(2);
    calls.get("second")?.resolve("second-result");
    calls.get("third")?.resolve("third-result");
    await expect(secondCall).resolves.toBe("second-result");
    await expect(thirdCall).resolves.toBe("third-result");

    await Promise.all([first.close?.(), second.close?.(), third.close?.()]);
    await pool.close();
    expect(liveRuntimes).toBe(0);
  });

  it("stops an active session runtime once so transport close cancels its lower call", async () => {
    const activeCall = deferred<unknown>();
    let closes = 0;
    let callStarted = false;
    const pool = new OmniCodexSessionExecutorPool({
      createNativeToolExecutor: nativeExecutor,
      createResponsesRuntime: async () => ({
        call: async () => {
          throw new Error("unexpected direct call");
        },
        callNested: async () => {
          callStarted = true;
          return activeCall.promise;
        },
        close: async () => {
          closes += 1;
          activeCall.reject(new Error("session runtime closed"));
        },
      }),
    });
    const session = pool.createSessionExecutors(context("cancel"));
    const call = session.responsesToolExecutor?.callNested("tool", {}, false);
    const observedCall = call?.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await waitFor(() => pool.activeResponsesRuntimeCount === 1 && callStarted);

    await session.close?.();
    await session.close?.();
    await expect(observedCall).resolves.toMatchObject({
      ok: false,
      error: expect.objectContaining({ message: "session runtime closed" }),
    });
    expect(closes).toBe(1);
    expect(pool.activeResponsesRuntimeCount).toBe(0);
    await pool.close();
  });

  it("removes a canceled capacity waiter and never creates its runtime late", async () => {
    const firstCall = deferred<unknown>();
    const created: string[] = [];
    const pool = new OmniCodexSessionExecutorPool({
      maxActiveResponsesRuntimes: 1,
      createNativeToolExecutor: nativeExecutor,
      createResponsesRuntime: async (sessionContext) => {
        created.push(sessionContext.correlationId);
        return {
          call: async () => {
            throw new Error("unexpected direct call");
          },
          callNested: async () =>
            sessionContext.correlationId === "capacity-first"
              ? firstCall.promise
              : `${sessionContext.correlationId}-result`,
          close: async () => undefined,
        };
      },
    });
    const first = pool.createSessionExecutors(context("capacity-first"));
    const waiting = pool.createSessionExecutors(context("capacity-waiting"));
    const active = first.responsesToolExecutor?.callNested("tool", {}, false);
    await waitFor(() => pool.activeResponsesRuntimeCount === 1);
    const controller = new AbortController();
    const canceled = waiting.responsesToolExecutor?.callNested(
      "tool",
      {},
      false,
      controller.signal,
    );
    await Promise.resolve();

    controller.abort(new Error("capacity caller canceled"));
    await expect(canceled).rejects.toThrow("capacity caller canceled");
    expect(created).toEqual(["capacity-first"]);

    firstCall.resolve("first-result");
    await expect(active).resolves.toBe("first-result");
    await expect(waiting.responsesToolExecutor?.callNested("tool", {}, false)).resolves.toBe(
      "capacity-waiting-result",
    );
    expect(created).toEqual(["capacity-first", "capacity-waiting"]);

    await Promise.all([first.close?.(), waiting.close?.()]);
    await pool.close();
  });

  it("reclaims an idle Responses child without closing the MCP session", async () => {
    let creates = 0;
    let closes = 0;
    const pool = new OmniCodexSessionExecutorPool({
      responsesRuntimeIdleMs: 10,
      createNativeToolExecutor: nativeExecutor,
      createResponsesRuntime: async () => {
        creates += 1;
        const runtime = immediateRuntime();
        return {
          ...runtime,
          close: async () => {
            closes += 1;
          },
        };
      },
    });
    const session = pool.createSessionExecutors(context("idle"));

    await expect(session.responsesToolExecutor?.callNested("tool", {}, false)).resolves.toBe(
      "result",
    );
    await waitFor(() => closes === 1);
    expect(pool.activeResponsesRuntimeCount).toBe(0);

    await expect(session.responsesToolExecutor?.callNested("tool", {}, false)).resolves.toBe(
      "result",
    );
    expect(creates).toBe(2);
    await session.close?.();
    await pool.close();
    expect(closes).toBe(2);
  });

  it("retires an idle native execution context without forgetting its Web conversation lease", async () => {
    let retires = 0;
    const pool = new OmniCodexSessionExecutorPool({
      nativeContextIdleMs: 10,
      createNativeToolExecutor: () => new RetiringNativeToolExecutor(() => (retires += 1)),
      createResponsesRuntime: async () => immediateRuntime(),
    });
    const binding = () => "durable-web-conversation";
    const session = pool.createSessionExecutors(
      workSessionContext("native-idle", "principal", binding),
    );

    await expect(session.nativeToolExecutor?.call("server", "tool", {})).resolves.toBe("native");
    await waitFor(() => retires === 1);
    await expect(session.nativeToolExecutor?.call("server", "tool", {})).resolves.toBe("native");
    await waitFor(() => retires === 2);

    await pool.close();
    expect(retires).toBe(2);
  });

  it("routes transport direct native calls through idle retirement", async () => {
    let retires = 0;
    const pool = new OmniCodexSessionExecutorPool({
      nativeContextIdleMs: 10,
      createNativeToolExecutor: () => new RetiringNativeToolExecutor(() => (retires += 1)),
      createResponsesRuntime: async () => immediateRuntime(),
    });
    const session = pool.createSessionExecutors(context("transport-native-idle"));

    await expect(session.nativeToolExecutor?.call("server", "tool", {})).resolves.toBe("native");
    await waitFor(() => retires === 1);
    await expect(session.nativeToolExecutor?.call("server", "tool", {})).resolves.toBe("native");
    await waitFor(() => retires === 2);

    await pool.close();
    expect(retires).toBe(2);
  });

  it.each([
    ["transport", () => context("browser-native-idle-transport")],
    [
      "durable Web work session",
      () =>
        workSessionContext(
          "browser-native-idle-durable",
          "principal",
          () => "durable-browser-native-idle",
        ),
    ],
  ])("routes %s Browser native calls through idle retirement", async (_kind, createContext) => {
    let browserExecutors = 0;
    let retires = 0;
    const pool = new OmniCodexSessionExecutorPool({
      nativeContextIdleMs: 10,
      createNativeToolExecutor: () => new RetiringNativeToolExecutor(() => (retires += 1)),
      createBrowserNativeExecutor: (_context, executor) => {
        browserExecutors += 1;
        return new NativeCallingBrowserNativeExecutor(executor);
      },
      createResponsesRuntime: async () => immediateRuntime(),
    });
    const session = pool.createSessionExecutors(createContext());
    const browser = session.browserNativeExecutor;

    await expect(browser?.call({})).resolves.toBe("native");
    await waitFor(() => retires === 1);
    await expect(browser?.call({})).resolves.toBe("native");
    await waitFor(() => retires === 2);
    expect(session.browserNativeExecutor).toBe(browser);
    expect(browserExecutors).toBe(1);

    await pool.close();
    expect(retires).toBe(2);
  });

  it.each([
    ["keeps", undefined, 0],
    ["retires", 40, 1],
  ] as const)(
    "%s an idle native context whose browser activity never closes when the pending bound is %s",
    async (_verb, pendingBoundMs, expectedRetires) => {
      let retires = 0;
      const pool = new OmniCodexSessionExecutorPool({
        nativeContextIdleMs: 10,
        ...(pendingBoundMs === undefined
          ? {}
          : { nativeContextPendingActivityMaxIdleMs: pendingBoundMs }),
        createNativeToolExecutor: () => new RetiringNativeToolExecutor(() => (retires += 1)),
        createBrowserNativeExecutor: (_context, executor) =>
          new PendingActivityBrowserNativeExecutor(executor),
        createResponsesRuntime: async () => immediateRuntime(),
      });
      const session = pool.createSessionExecutors(
        workSessionContext("pending-activity", "principal", () => "durable-pending-activity"),
      );

      pendingActivityCloses.length = 0;
      // A Web turn ended after this call without closing its browser activity.
      await expect(session.browserNativeExecutor?.call({})).resolves.toBe("native");
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(retires).toBe(expectedRetires);
      // Retirement hands the open activity over instead of aborting it.
      expect(pendingActivityCloses).toEqual(
        expectedRetires === 0 ? [] : [{ preserveActivities: true }],
      );

      await pool.close();
    },
  );

  it("never retires a native context while its browser call is still running past the bound", async () => {
    const running = deferred<unknown>();
    let closes = 0;
    const pool = new OmniCodexSessionExecutorPool({
      nativeContextIdleMs: 10,
      nativeContextPendingActivityMaxIdleMs: 30,
      createNativeRuntime: async () => ({
        nativeToolExecutor: new ScriptedNativeToolExecutor(() => running.promise),
        close: async () => {
          closes += 1;
        },
      }),
      createBrowserNativeExecutor: (_context, executor) =>
        new PendingActivityBrowserNativeExecutor(executor),
      createResponsesRuntime: async () => immediateRuntime(),
    });
    const session = pool.createSessionExecutors(
      workSessionContext("running-browser", "principal", () => "durable-running-browser"),
    );

    // Real browser work in progress: the call outlives the pending-activity bound.
    const call = session.browserNativeExecutor?.call({});
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closes).toBe(0);

    running.resolve("done");
    await expect(call).resolves.toBe("done");
    await waitFor(() => closes === 1);
    await pool.close();
  });

  it("keeps a live turn's context between calls and reclaims it once the turn is abandoned", async () => {
    let closes = 0;
    const pool = new OmniCodexSessionExecutorPool({
      nativeContextIdleMs: 10,
      nativeContextPendingActivityMaxIdleMs: 200,
      createNativeRuntime: async () => ({
        nativeToolExecutor: new ScriptedNativeToolExecutor(async () => "native"),
        close: async () => {
          closes += 1;
        },
      }),
      createBrowserNativeExecutor: (_context, executor) =>
        new PendingActivityBrowserNativeExecutor(executor),
      createResponsesRuntime: async () => immediateRuntime(),
    });
    const session = pool.createSessionExecutors(
      workSessionContext("live-turn", "principal", () => "durable-live-turn"),
    );

    await expect(session.browserNativeExecutor?.call({})).resolves.toBe("native");
    // A reasoning gap shorter than the bound keeps the CUA state resident.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(closes).toBe(0);
    await expect(session.browserNativeExecutor?.call({})).resolves.toBe("native");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(closes).toBe(0);

    // No further call: the turn ended with its activity left open.
    await waitFor(() => closes === 1);
    await pool.close();
  });

  it("does not close the native context for a call that starts during the activity handover", async () => {
    const handover = deferred<void>();
    const secondCall = deferred<unknown>();
    let handoverStarted = false;
    let calls = 0;
    let closes = 0;
    const pool = new OmniCodexSessionExecutorPool({
      nativeContextIdleMs: 10,
      nativeContextPendingActivityMaxIdleMs: 30,
      createNativeRuntime: async () => ({
        nativeToolExecutor: new ScriptedNativeToolExecutor(async () => {
          calls += 1;
          return calls === 2 ? secondCall.promise : "native";
        }),
        close: async () => {
          closes += 1;
        },
      }),
      createBrowserNativeExecutor: (_context, executor) =>
        new (class extends PendingActivityBrowserNativeExecutor {
          override async close(options: { readonly preserveActivities?: boolean } = {}) {
            if (options.preserveActivities === true) {
              handoverStarted = true;
              await handover.promise;
            }
            return super.close(options);
          }
        })(executor),
      createResponsesRuntime: async () => immediateRuntime(),
    });
    const session = pool.createSessionExecutors(
      workSessionContext("handover-race", "principal", () => "durable-handover-race"),
    );

    await expect(session.browserNativeExecutor?.call({})).resolves.toBe("native");
    await waitFor(() => handoverStarted);
    // A new call arrives while the previous executor is still handing over.
    const running = session.nativeToolExecutor?.call("server", "tool", {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    handover.resolve();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(closes).toBe(0);

    secondCall.resolve("second");
    await expect(running).resolves.toBe("second");
    await waitFor(() => closes === 1);
    await pool.close();
  });

  it("does not retire a durable native context with only a Responses idle timeout", async () => {
    let retires = 0;
    const pool = new OmniCodexSessionExecutorPool({
      responsesRuntimeIdleMs: 10,
      createNativeToolExecutor: () => new RetiringNativeToolExecutor(() => (retires += 1)),
      createResponsesRuntime: async () => immediateRuntime(),
    });
    const session = pool.createSessionExecutors(
      workSessionContext("native-durable", "principal", () => "durable-web-conversation"),
    );

    await expect(session.nativeToolExecutor?.call("server", "tool", {})).resolves.toBe("native");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(retires).toBe(0);

    await pool.close();
    expect(retires).toBe(1);
  });

  it("waits for idle process retirement before dispatching on a fresh generation", async () => {
    const firstStop = deferred<void>();
    const events: string[] = [];
    let generations = 0;
    const pool = new OmniCodexSessionExecutorPool({
      nativeContextIdleMs: 5,
      createNativeRuntime: async () => {
        const generation = ++generations;
        events.push(`create:${generation}`);
        return {
          nativeToolExecutor: new ScriptedNativeToolExecutor(async () => {
            events.push(`call:${generation}`);
            return `generation-${generation}`;
          }),
          close: async () => {
            events.push(`stop:${generation}:start`);
            if (generation === 1) await firstStop.promise;
            events.push(`stop:${generation}:end`);
          },
        };
      },
      createResponsesRuntime: async () => immediateRuntime(),
    });
    const session = pool.createSessionExecutors(context("native-idle-race"));

    await expect(session.nativeToolExecutor?.call("server", "tool", {})).resolves.toBe(
      "generation-1",
    );
    await waitFor(() => events.includes("stop:1:start"));
    const secondCall = session.nativeToolExecutor?.call("server", "tool", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).not.toContain("call:2");
    expect(generations).toBe(1);

    firstStop.resolve();
    await expect(secondCall).resolves.toBe("generation-2");
    expect(events.indexOf("stop:1:end")).toBeLessThan(events.indexOf("create:2"));
    await session.close?.();
    await pool.close();
  });

  it("hard-stops a cancelled native process before settling and never replays the call", async () => {
    const firstCall = deferred<unknown>();
    const firstStop = deferred<void>();
    const events: string[] = [];
    let generations = 0;
    const pool = new OmniCodexSessionExecutorPool({
      createNativeRuntime: async () => {
        const generation = ++generations;
        return {
          nativeToolExecutor: new ScriptedNativeToolExecutor(async () => {
            events.push(`call:${generation}`);
            return generation === 1 ? firstCall.promise : `generation-${generation}`;
          }),
          close: async () => {
            events.push(`stop:${generation}:start`);
            if (generation === 1) await firstStop.promise;
            events.push(`stop:${generation}:end`);
          },
        };
      },
      createResponsesRuntime: async () => immediateRuntime(),
    });
    const session = pool.createSessionExecutors(context("native-cancel"));
    const cancellation = new AbortController();
    const call = session.nativeToolExecutor?.call(
      "server",
      "mutation",
      {},
      undefined,
      undefined,
      cancellation.signal,
    );
    let settled = false;
    void call
      ?.finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    await waitFor(() => events.includes("call:1"));

    cancellation.abort(new Error("caller cancelled"));
    await waitFor(() => events.includes("stop:1:start"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(events.filter((event) => event === "call:1")).toHaveLength(1);
    expect(generations).toBe(1);

    firstStop.resolve();
    await expect(call).rejects.toThrow("caller cancelled");
    expect(events.at(-1)).toBe("stop:1:end");
    await expect(session.nativeToolExecutor?.call("server", "read", {})).resolves.toBe(
      "generation-2",
    );
    expect(events.filter((event) => event === "call:1")).toHaveLength(1);
    await session.close?.();
    await pool.close();
  });

  it.each([
    Object.assign(new Error("App Server request timed out: tools/call"), {
      code: "JSONL_RPC_DEADLINE_EXCEEDED",
    }),
    new Error("Codex App Server exited (code=1, signal=null)"),
    Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
  ])("retires a failed native transport without replaying its mutation: %s", async (failure) => {
    const stopped = deferred<void>();
    const events: string[] = [];
    let generations = 0;
    const pool = new OmniCodexSessionExecutorPool({
      createNativeRuntime: async () => {
        const generation = ++generations;
        return {
          nativeToolExecutor: new ScriptedNativeToolExecutor(async () => {
            events.push(`call:${generation}`);
            if (generation === 1) throw failure;
            return "recovered";
          }),
          close: async () => {
            events.push(`stop:${generation}`);
            if (generation === 1) await stopped.promise;
          },
        };
      },
      createResponsesRuntime: async () => immediateRuntime(),
    });
    const session = pool.createSessionExecutors(context("native-transport-failure"));
    const failed = session.nativeToolExecutor?.call("server", "mutation", {});
    const observedFailure = failed?.catch((error: unknown) => error);
    await waitFor(() => events.includes("stop:1"));
    const next = session.nativeToolExecutor?.call("server", "read", {});
    await Promise.resolve();
    expect(generations).toBe(1);
    stopped.resolve();
    await expect(observedFailure).resolves.toBe(failure);
    await expect(next).resolves.toBe("recovered");
    expect(events).toEqual(["call:1", "stop:1", "call:2"]);
    await pool.close();
  });

  it("keeps a failed transport retirement reachable and never reuses the poisoned process", async () => {
    let generations = 0;
    let stops = 0;
    const failure = Object.assign(new Error("RPC deadline"), {
      code: "JSONL_RPC_DEADLINE_EXCEEDED",
    });
    const pool = new OmniCodexSessionExecutorPool({
      createNativeRuntime: async () => {
        generations += 1;
        return {
          nativeToolExecutor: new ScriptedNativeToolExecutor(async () => {
            throw failure;
          }),
          close: async () => {
            stops += 1;
            if (stops <= 2) throw new Error("native stop failed");
          },
        };
      },
      createResponsesRuntime: async () => immediateRuntime(),
    });
    const session = pool.createSessionExecutors(context("native-transport-stop-failure"));
    await expect(session.nativeToolExecutor?.call("server", "mutation", {})).rejects.toMatchObject({
      message: "Failed native runtime did not stop cleanly",
      errors: [failure, expect.objectContaining({ message: "native stop failed" })],
    });
    await expect(session.nativeToolExecutor?.call("server", "read", {})).rejects.toThrow(
      "native stop failed",
    );
    expect(generations).toBe(1);
    await pool.close();
    expect(stops).toBe(3);
  });

  it("does not retire a healthy process for a tool validation failure", async () => {
    let calls = 0;
    let stops = 0;
    const pool = new OmniCodexSessionExecutorPool({
      createNativeRuntime: async () => ({
        nativeToolExecutor: new ScriptedNativeToolExecutor(async () => {
          if (++calls === 1) throw new Error("Invalid browser selector");
          return "valid";
        }),
        close: async () => {
          stops += 1;
        },
      }),
      createResponsesRuntime: async () => immediateRuntime(),
    });
    const session = pool.createSessionExecutors(context("native-validation-failure"));
    await expect(session.nativeToolExecutor?.call("server", "tool", {})).rejects.toThrow(
      "Invalid browser selector",
    );
    await expect(session.nativeToolExecutor?.call("server", "tool", {})).resolves.toBe("valid");
    expect(stops).toBe(0);
    await pool.close();
  });

  it("waits for startup-abort cleanup before rejecting the first native call", async () => {
    const stopped = deferred<void>();
    const events: string[] = [];
    const pool = new OmniCodexSessionExecutorPool({
      createNativeRuntime: async (_context, signal) =>
        new Promise<OmniCodexSessionNativeRuntime>((_resolve, reject) => {
          const abort = () => {
            events.push("stop:start");
            void stopped.promise.then(() => {
              events.push("stop:end");
              reject(signal.reason);
            });
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }),
      createResponsesRuntime: async () => immediateRuntime(),
    });
    const session = pool.createSessionExecutors(context("native-start-cancel"));
    const cancellation = new AbortController();
    const call = session.nativeToolExecutor?.call(
      "server",
      "tool",
      {},
      undefined,
      undefined,
      cancellation.signal,
    );
    let settled = false;
    void call
      ?.finally(() => {
        settled = true;
      })
      .catch(() => undefined);

    cancellation.abort(new Error("startup cancelled"));
    await waitFor(() => events.includes("stop:start"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    stopped.resolve();
    await expect(call).rejects.toThrow("startup cancelled");
    expect(events).toEqual(["stop:start", "stop:end"]);
    await session.close?.();
    await pool.close();
  });

  it("coalesces concurrent first use into one native runtime generation", async () => {
    const creation = deferred<OmniCodexSessionNativeRuntime>();
    let creations = 0;
    let calls = 0;
    const pool = new OmniCodexSessionExecutorPool({
      createNativeRuntime: async () => {
        creations += 1;
        return creation.promise;
      },
      createResponsesRuntime: async () => immediateRuntime(),
    });
    const session = pool.createSessionExecutors(context("native-coalesced-start"));
    const first = session.nativeToolExecutor?.call("server", "first", {});
    const second = session.nativeToolExecutor?.call("server", "second", {});
    await waitFor(() => creations === 1);
    creation.resolve({
      nativeToolExecutor: new ScriptedNativeToolExecutor(async () => ++calls),
      close: async () => undefined,
    });

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(creations).toBe(1);
    await session.close?.();
    await pool.close();
  });

  it("allows the Browser close hook to release native state before stopping its process", async () => {
    const events: string[] = [];
    class ReleasingBrowser extends BrowserNativeExecutor {
      readonly #executor: NativeToolExecutor;

      constructor(executor: NativeToolExecutor) {
        super(executor);
        this.#executor = executor;
      }

      override async close(): Promise<void> {
        events.push("browser:release:start");
        await this.#executor.callInContext("node_repl", "turn_ended", {});
        events.push("browser:release:end");
      }
    }
    const pool = new OmniCodexSessionExecutorPool({
      createNativeRuntime: async () => ({
        nativeToolExecutor: new ScriptedNativeToolExecutor(async () => {
          events.push("native:release");
          return {};
        }),
        close: async () => {
          events.push("native:stop");
        },
      }),
      createBrowserNativeExecutor: (_context, executor) => new ReleasingBrowser(executor),
      createResponsesRuntime: async () => immediateRuntime(),
    });
    const session = pool.createSessionExecutors(context("browser-close-release"));

    await session.close?.();
    expect(events).toEqual([
      "browser:release:start",
      "native:release",
      "browser:release:end",
      "native:stop",
    ]);
    await pool.close();
  });

  it("retains a failed native stop and retries the exact runtime on close", async () => {
    let creations = 0;
    let stops = 0;
    const pool = new OmniCodexSessionExecutorPool({
      createNativeRuntime: async () => {
        creations += 1;
        return {
          nativeToolExecutor: new ScriptedNativeToolExecutor(async () => "native"),
          close: async () => {
            stops += 1;
            if (stops === 1) throw new Error("native stop failed");
          },
        };
      },
      createResponsesRuntime: async () => immediateRuntime(),
    });
    const session = pool.createSessionExecutors(context("native-stop-retry"));
    await session.nativeToolExecutor?.call("server", "tool", {});

    await expect(session.close?.()).rejects.toThrow("native stop failed");
    expect(creations).toBe(1);
    await session.close?.();
    expect(stops).toBe(2);
    expect(creations).toBe(1);
    await pool.close();
  });
});

function immediateRuntime(): OmniCodexSessionResponsesRuntime {
  return {
    call: async () => {
      throw new Error("unexpected direct call");
    },
    callNested: async () => "result",
    close: async () => undefined,
  };
}

class RecordingNativeToolExecutor extends NativeToolExecutor {
  readonly #result: string;

  constructor(result: string) {
    super({
      request: async <T>(): Promise<T> => {
        throw new Error("recording executor does not call App Server RPC directly");
      },
    });
    this.#result = result;
  }

  override async call(..._args: Parameters<NativeToolExecutor["call"]>): Promise<unknown> {
    return this.#result;
  }

  override async callInContext(
    ..._args: Parameters<NativeToolExecutor["callInContext"]>
  ): Promise<unknown> {
    return this.#result;
  }
}

class RecordingBrowserNativeExecutor extends BrowserNativeExecutor {
  readonly #result: string;
  readonly #onFinish: ((activityBinding: string) => void) | undefined;

  constructor(result: string, onFinish?: (activityBinding: string) => void) {
    super({
      callInContext: async () => {
        throw new Error("recording browser executor does not call a native tool");
      },
    });
    this.#result = result;
    this.#onFinish = onFinish;
  }

  override async call(): Promise<unknown> {
    return this.#result;
  }

  override async finishActivity(activityBinding: string): Promise<void> {
    this.#onFinish?.(activityBinding);
  }
}

class NativeCallingBrowserNativeExecutor extends BrowserNativeExecutor {
  readonly #nativeExecutor: NativeToolExecutor;

  constructor(nativeExecutor: NativeToolExecutor) {
    super(nativeExecutor);
    this.#nativeExecutor = nativeExecutor;
  }

  override call(): Promise<unknown> {
    return this.#nativeExecutor.callInContext("browser", "call", {});
  }
}

const pendingActivityCloses: Array<{ readonly preserveActivities?: boolean }> = [];

class PendingActivityBrowserNativeExecutor extends NativeCallingBrowserNativeExecutor {
  override get hasPendingActivities(): boolean {
    return true;
  }

  override close(options: { readonly preserveActivities?: boolean } = {}): Promise<void> {
    pendingActivityCloses.push(options);
    return super.close(options);
  }
}

class RetiringNativeToolExecutor extends RecordingNativeToolExecutor {
  readonly #onRetire: () => void;

  constructor(onRetire: () => void) {
    super("native");
    this.#onRetire = onRetire;
  }

  override async retireOwnedExecutionThread(): Promise<void> {
    this.#onRetire();
  }
}

class ScriptedNativeToolExecutor extends NativeToolExecutor {
  readonly #call: () => Promise<unknown>;

  constructor(call: () => Promise<unknown>) {
    super({
      request: async <T>(): Promise<T> => {
        throw new Error("scripted executor does not call App Server RPC directly");
      },
    });
    this.#call = call;
  }

  override call(..._args: Parameters<NativeToolExecutor["call"]>): Promise<unknown> {
    return this.#call();
  }

  override callInContext(
    ..._args: Parameters<NativeToolExecutor["callInContext"]>
  ): Promise<unknown> {
    return this.#call();
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
