import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  callDirectJobTool,
  type DirectJobDispatchAdapter,
  DirectJobManager,
  directJobTools,
} from "../src/infrastructure/mcp/direct-job-mcp-tools.js";
import { DirectJobStore } from "../src/infrastructure/mcp/direct-job-store.js";

const context = {
  authorizationBinding: "authorized-owner-1",
  workSessionBinding: "durable-work-session-1",
  directJobOwnerBinding: "durable-direct-job-owner-1",
  directGoalClaimantBinding: "durable-goal-claimant-1",
  callerSessionId: "mcp-session-correlation-1",
};

describe("DirectJobManager", () => {
  it("keeps native work alive across a caller reconnect and persists its result", async () => {
    const store = DirectJobStore.inMemory();
    const manager = new DirectJobManager(store);
    const pending = deferred<CallToolResult>();
    const adapter: DirectJobDispatchAdapter = {
      validate: vi.fn(() => targetContract("reconnect")),
      dispatch: vi.fn(async (request) => {
        await request.beforeNativeDispatch();
        return { status: "succeeded" as const, result: await pending.promise };
      }),
    };
    const started = await manager.start(startArguments("durable-job-start-0001"), context, adapter);

    await eventually(async () => {
      expect(await manager.get(accessArguments(started.job.jobId), context)).toMatchObject({
        status: "running",
      });
    });
    pending.resolve({
      content: [{ type: "text", text: "BACKGROUND_NATIVE_RESULT" }],
      structuredContent: { completed: true },
    });
    await manager.waitForCallerIdle(context.callerSessionId);

    const reconnected = await manager.get(accessArguments(started.job.jobId), context);
    expect(reconnected).toMatchObject({
      status: "succeeded",
      result: { structuredContent: { completed: true } },
    });
    expect(adapter.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: started.job.operationId,
        callerSessionId: context.callerSessionId,
        toolName: "codex__app_server__command_exec",
      }),
    );
  });

  it("preserves the complete multiline native error and result without diagnostic sampling", async () => {
    const manager = new DirectJobManager(DirectJobStore.inMemory());
    const diagnostic = `NATIVE_ERROR_BEGIN\n${"x".repeat(9_000)}\nNATIVE_ERROR_END`;
    const adapter: DirectJobDispatchAdapter = {
      validate: vi.fn(() => targetContract("complete-error")),
      dispatch: vi.fn(async (request) => {
        await request.beforeNativeDispatch();
        return {
          status: "failed" as const,
          result: {
            isError: true,
            content: [{ type: "text" as const, text: diagnostic }],
            structuredContent: { diagnostic },
          },
        };
      }),
    };
    const started = await manager.start(
      startArguments("durable-complete-error-0001"),
      context,
      adapter,
    );
    await manager.waitForCallerIdle(context.callerSessionId);

    const completed = await manager.get(accessArguments(started.job.jobId), context);
    expect(completed?.status).toBe("failed");
    expect(completed?.error?.message).toBe(diagnostic);
    expect(completed?.result?.content[0]).toEqual({ type: "text", text: diagnostic });
    expect(completed?.result?.structuredContent).toEqual({ diagnostic });
  });

  it("gracefully drains completed caller work before its deadline", async () => {
    const manager = new DirectJobManager(DirectJobStore.inMemory());
    const adapter: DirectJobDispatchAdapter = {
      validate: vi.fn(() => targetContract("graceful-drain")),
      dispatch: vi.fn(async (request) => {
        await request.beforeNativeDispatch();
        return {
          status: "succeeded" as const,
          result: { content: [{ type: "text" as const, text: "finished" }] },
        };
      }),
    };
    const started = await manager.start(
      startArguments("bounded-drain-idle-0001"),
      context,
      adapter,
    );

    await expect(
      manager.drainCaller(context.callerSessionId, 1_000, {
        code: "RUNTIME_DRAIN_TIMEOUT",
        message: "Native drain deadline elapsed",
      }),
    ).resolves.toEqual({ outcome: "idle" });
    expect(await manager.get(accessArguments(started.job.jobId), context)).toMatchObject({
      status: "succeeded",
    });
  });

  it("bounds a stalled caller drain and durably fences dispatched work", async () => {
    const manager = new DirectJobManager(DirectJobStore.inMemory());
    const adapter: DirectJobDispatchAdapter = {
      validate: vi.fn(() => targetContract("stalled-drain")),
      dispatch: vi.fn(async (request) => {
        await request.beforeNativeDispatch();
        return new Promise<never>(() => undefined);
      }),
    };
    const started = await manager.start(
      startArguments("bounded-drain-running-01"),
      context,
      adapter,
    );
    await eventually(async () => {
      expect(await manager.get(accessArguments(started.job.jobId), context)).toMatchObject({
        status: "running",
      });
    });

    await expect(
      manager.drainCaller(context.callerSessionId, 5, {
        code: "RUNTIME_DRAIN_TIMEOUT",
        message: "Native drain deadline elapsed",
      }),
    ).resolves.toEqual({ outcome: "fenced" });
    expect(await manager.get(accessArguments(started.job.jobId), context)).toMatchObject({
      status: "outcome_unknown",
      error: { code: "RUNTIME_DRAIN_TIMEOUT" },
    });
  });

  it("atomically fences the get-queued to mark-running interleave before dispatch", async () => {
    const store = DirectJobStore.inMemory();
    const manager = new DirectJobManager(store);
    const queuedRead = deferred<void>();
    const releaseQueuedRead = deferred<void>();
    const originalGet = store.get.bind(store);
    let blocked = false;
    vi.spyOn(store, "get").mockImplementation(async (input) => {
      const value = await originalGet(input);
      if (!blocked && value?.status === "queued") {
        blocked = true;
        queuedRead.resolve(undefined);
        await releaseQueuedRead.promise;
      }
      return value;
    });
    let nativeCalls = 0;
    const adapter: DirectJobDispatchAdapter = {
      validate: vi.fn(() => targetContract("queued-fence")),
      dispatch: vi.fn(async (request) => {
        await request.beforeNativeDispatch();
        nativeCalls += 1;
        return {
          status: "succeeded" as const,
          result: { content: [{ type: "text" as const, text: "must-not-dispatch" }] },
        };
      }),
    };
    const started = await manager.start(
      startArguments("bounded-drain-queued-0001"),
      context,
      adapter,
    );
    await queuedRead.promise;

    await expect(
      manager.drainCaller(context.callerSessionId, 5, {
        code: "RUNTIME_DRAIN_TIMEOUT",
        message: "Native drain deadline elapsed",
      }),
    ).resolves.toEqual({ outcome: "fenced" });
    expect(await manager.get(accessArguments(started.job.jobId), context)).toMatchObject({
      status: "cancelled",
      error: { code: "RUNTIME_DRAIN_TIMEOUT" },
    });

    releaseQueuedRead.resolve(undefined);
    await manager.waitForCallerIdle(context.callerSessionId);
    expect(nativeCalls).toBe(0);
  });

  it("validates caller drain deadlines before changing active work", async () => {
    const manager = new DirectJobManager(DirectJobStore.inMemory());
    const error = { code: "RUNTIME_DRAIN_TIMEOUT", message: "deadline" };
    await expect(manager.drainCaller(context.callerSessionId, 0, error)).rejects.toThrow(
      "timeoutMs must be a positive safe integer",
    );
    await expect(manager.drainCaller(context.callerSessionId, 300_001, error)).resolves.toEqual({
      outcome: "idle",
    });
    const adapter: DirectJobDispatchAdapter = {
      validate: vi.fn(() => targetContract("long-drain")),
      dispatch: vi.fn(() => {
        throw new Error("unused");
      }),
    };
    await expect(manager.drainAdapter(adapter, 300_001, error)).resolves.toEqual({
      outcome: "idle",
    });
  });

  it("elects one background dispatch for concurrent idempotent starts", async () => {
    const manager = new DirectJobManager(DirectJobStore.inMemory());
    const pending = deferred<CallToolResult>();
    const adapter: DirectJobDispatchAdapter = {
      validate: vi.fn(() => targetContract("concurrent")),
      dispatch: vi.fn(async (request) => {
        await request.beforeNativeDispatch();
        return { status: "succeeded" as const, result: await pending.promise };
      }),
    };
    const input = startArguments("durable-job-start-0002");
    const starts = await Promise.all(
      Array.from({ length: 20 }, async () => manager.start(input, context, adapter)),
    );
    expect(starts.filter((start) => start.disposition === "created")).toHaveLength(1);
    expect(new Set(starts.map((start) => start.job.jobId)).size).toBe(1);
    await eventually(async () => expect(adapter.dispatch).toHaveBeenCalledTimes(1));
    pending.resolve({ content: [{ type: "text", text: "done" }] });
    await manager.waitForCallerIdle(context.callerSessionId);
  });

  it("returns a persisted terminal retry before a rolled-over runtime catalog rejects it", async () => {
    const manager = new DirectJobManager(DirectJobStore.inMemory());
    const acceptedAdapter: DirectJobDispatchAdapter = {
      validate: vi.fn(() => targetContract("old-runtime")),
      dispatch: vi.fn(async (request) => {
        await request.beforeNativeDispatch();
        return {
          status: "succeeded" as const,
          result: {
            content: [{ type: "text" as const, text: "persisted-runtime-result" }],
            structuredContent: { runtimeGeneration: "old" },
          },
        };
      }),
    };
    const input = startArguments("catalog-rollover-retry-0001");
    const created = await manager.start(input, context, acceptedAdapter);
    await manager.waitForCallerIdle(context.callerSessionId);
    expect(await manager.get(accessArguments(created.job.jobId), context)).toMatchObject({
      status: "succeeded",
      result: { structuredContent: { runtimeGeneration: "old" } },
    });

    const rolledOverAdapter: DirectJobDispatchAdapter = {
      validate: vi.fn(() => {
        throw new Error("target no longer exists in current runtime catalog");
      }),
      dispatch: vi.fn(),
    };
    const retried = await manager.start(input, context, rolledOverAdapter);

    expect(retried).toMatchObject({
      disposition: "existing",
      job: {
        jobId: created.job.jobId,
        status: "succeeded",
        result: { structuredContent: { runtimeGeneration: "old" } },
      },
    });
    expect(rolledOverAdapter.validate).not.toHaveBeenCalled();
    expect(rolledOverAdapter.dispatch).not.toHaveBeenCalled();
  });

  it("aborts a running native operation but waits for authoritative acknowledgement", async () => {
    const manager = new DirectJobManager(DirectJobStore.inMemory());
    const adapter: DirectJobDispatchAdapter = {
      validate: vi.fn(() => targetContract("cancel-running")),
      dispatch: vi.fn(async (request) => {
        await request.beforeNativeDispatch();
        return new Promise<Awaited<ReturnType<DirectJobDispatchAdapter["dispatch"]>>>((resolve) => {
          request.signal.addEventListener(
            "abort",
            () => resolve({ status: "cancelled", message: "native abort acknowledged" }),
            { once: true },
          );
        });
      }),
    };
    const started = await manager.start(startArguments("durable-job-start-0003"), context, adapter);
    await eventually(async () => {
      expect(await manager.get(accessArguments(started.job.jobId), context)).toMatchObject({
        status: "running",
      });
    });
    const cancel = await manager.cancel(accessArguments(started.job.jobId), context);
    expect(cancel).toMatchObject({
      disposition: "cancellation_requested",
      job: { status: "running" },
    });
    await manager.waitForCallerIdle(context.callerSessionId);
    expect(await manager.get(accessArguments(started.job.jobId), context)).toMatchObject({
      status: "cancelled",
      error: { message: "native abort acknowledged" },
    });
  });

  it("fails closed as outcome_unknown when a dispatched adapter throws", async () => {
    const manager = new DirectJobManager(DirectJobStore.inMemory());
    const adapter: DirectJobDispatchAdapter = {
      validate: vi.fn(() => targetContract("exception-after-send")),
      dispatch: vi.fn(async (request) => {
        await request.beforeNativeDispatch();
        throw new Error("pipe disappeared after send");
      }),
    };
    const started = await manager.start(startArguments("durable-job-start-0004"), context, adapter);
    await manager.waitForCallerIdle(context.callerSessionId);
    expect(await manager.get(accessArguments(started.job.jobId), context)).toMatchObject({
      status: "outcome_unknown",
      error: { code: "DIRECT_JOB_DISPATCH_EXCEPTION" },
    });
  });

  it("preserves complete Error and non-Error rejection structures in durable job readback", async () => {
    const manager = new DirectJobManager(DirectJobStore.inMemory());
    const rpcError = {
      code: -32_041,
      message: "upstream unavailable",
      data: { requestId: "request-full-error", nativePayload: { sequence: [3, 1, 4, 1, 5] } },
    };
    const nativeError = new Error("native transport failed", {
      cause: { name: "SocketError", message: "pipe closed", data: { phase: "response" } },
    });
    Object.assign(nativeError, {
      code: "NATIVE_TRANSPORT_FAILURE",
      data: { stdout: ["first", "second", "third"], stderr: "complete stderr" },
      rpcError,
      retry: { retryable: true, retryAfterMs: 4_321, attempt: 3 },
      structured: { protocol: "jsonrpc", complete: true },
      nativePayload: { structured: { complete: true } },
    });
    const errorAdapter: DirectJobDispatchAdapter = {
      validate: () => targetContract("structured-error"),
      dispatch: async (request) => {
        await request.beforeNativeDispatch();
        throw nativeError;
      },
    };
    const errorJob = await manager.start(
      startArguments("structured-error-rejection-0001"),
      context,
      errorAdapter,
    );
    await manager.waitForCallerIdle(context.callerSessionId);
    expect(await manager.get(accessArguments(errorJob.job.jobId), context)).toMatchObject({
      status: "outcome_unknown",
      error: {
        code: "NATIVE_TRANSPORT_FAILURE",
        message: "native transport failed",
        details: {
          name: "Error",
          message: "native transport failed",
          code: "NATIVE_TRANSPORT_FAILURE",
          data: { stdout: ["first", "second", "third"], stderr: "complete stderr" },
          rpcError,
          retry: { retryable: true, retryAfterMs: 4_321, attempt: 3 },
          structured: { protocol: "jsonrpc", complete: true },
          nativePayload: { structured: { complete: true } },
          cause: {
            name: "SocketError",
            message: "pipe closed",
            data: { phase: "response" },
          },
        },
      },
    });

    const rejection = {
      code: "NON_ERROR_REJECTION",
      message: "plain structured rejection",
      data: { ordered: ["alpha", "beta", "gamma"] },
      rpcError: { code: -32_099, message: "plain RPC failure", data: { full: true } },
      retry: { retryable: false, reason: "terminal" },
      cause: { code: "LOW_LEVEL_REJECTION", message: "native payload rejected" },
    };
    const nonErrorAdapter: DirectJobDispatchAdapter = {
      validate: () => targetContract("structured-non-error"),
      dispatch: async (request) => {
        await request.beforeNativeDispatch();
        throw rejection;
      },
    };
    const nonErrorJob = await manager.start(
      startArguments("structured-non-error-rejection-0001"),
      context,
      nonErrorAdapter,
    );
    await manager.waitForCallerIdle(context.callerSessionId);
    const publicRead = await callDirectJobTool(
      manager,
      nonErrorAdapter,
      "omnicodex__job_get",
      accessArguments(nonErrorJob.job.jobId),
      context,
    );
    expect(publicRead.structuredContent).toMatchObject({
      status: "outcome_unknown",
      error: {
        code: "NON_ERROR_REJECTION",
        message: "plain structured rejection",
        details: { value: rejection },
      },
    });
  });

  it("enforces owner, conversation, and work-session isolation through MCP helpers", async () => {
    const manager = new DirectJobManager(DirectJobStore.inMemory());
    const adapter: DirectJobDispatchAdapter = {
      validate: vi.fn(() => targetContract("isolation")),
      dispatch: vi.fn(async (request) => {
        await request.beforeNativeDispatch();
        return {
          status: "succeeded" as const,
          result: { content: [{ type: "text" as const, text: "ok" }] },
        };
      }),
    };
    const startResult = await callDirectJobTool(
      manager,
      adapter,
      "omnicodex__job_start",
      startArguments("durable-job-start-0005"),
      context,
    );
    const started = JSON.parse(
      startResult.content[0]?.type === "text" ? startResult.content[0].text : "",
    ) as {
      job: { jobId: string };
    };
    await manager.waitForCallerIdle(context.callerSessionId);

    const wrongOwner = await callDirectJobTool(
      manager,
      adapter,
      "omnicodex__job_get",
      accessArguments(started.job.jobId),
      { ...context, authorizationBinding: "different-owner" },
    );
    expect(wrongOwner).toMatchObject({ isError: true });
    const wrongWork = await callDirectJobTool(
      manager,
      adapter,
      "omnicodex__job_get",
      accessArguments(started.job.jobId),
      { ...context, workSessionBinding: "different-work" },
    );
    expect(wrongWork).toMatchObject({ isError: true });
  });

  it("executes every validated target including messaging, Goal controls, and exec", async () => {
    const manager = new DirectJobManager(DirectJobStore.inMemory());
    const adapter: DirectJobDispatchAdapter = {
      validate: vi.fn(() => ({ ...targetContract("all-targets"), modelEffect: "model" as const })),
      dispatch: vi.fn(async (request) => {
        await request.beforeNativeDispatch();
        return { status: "succeeded" as const, result: { content: [] } };
      }),
    };
    const targets = [
      "omnicodex__job_start",
      "omnicodex__goal_create",
      "codex_app__send_message_to_thread",
      "codex_app__create_thread",
      "codex__functions__exec",
      "functions.exec",
    ];
    for (const [index, toolName] of targets.entries()) {
      const started = await manager.start(
        { ...startArguments(`allowed-target-0001-${index}`), toolName },
        context,
        adapter,
      );
      await manager.waitForCallerIdle(context.callerSessionId);
      expect(await manager.get({ jobId: started.job.jobId }, context)).toMatchObject({
        status: "succeeded",
      });
    }
    expect(adapter.dispatch).toHaveBeenCalledTimes(targets.length);
  });

  it("fails a changed pinned catalog contract before native dispatch", async () => {
    const manager = new DirectJobManager(DirectJobStore.inMemory());
    const adapter: DirectJobDispatchAdapter = {
      validate: vi.fn(() => targetContract("catalog-v1")),
      dispatch: vi.fn(async () => ({
        status: "failed" as const,
        code: "DIRECT_JOB_CATALOG_CHANGED",
        result: {
          isError: true,
          content: [{ type: "text" as const, text: "DIRECT_JOB_CATALOG_CHANGED" }],
        },
      })),
    };
    const started = await manager.start(
      startArguments("catalog-changed-before-dispatch-0001"),
      context,
      adapter,
    );
    await manager.waitForCallerIdle(context.callerSessionId);

    expect(adapter.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ targetContract: targetContract("catalog-v1") }),
    );
    expect(await manager.get(accessArguments(started.job.jobId), context)).toMatchObject({
      status: "failed",
      error: { code: "DIRECT_JOB_CATALOG_CHANGED" },
    });
    expect(await manager.get(accessArguments(started.job.jobId), context)).not.toHaveProperty(
      "startedAtUnixMs",
    );
  });

  it("publishes four full-surface owner-bound controls with explicit schemas", () => {
    const tools = directJobTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "omnicodex__job_start",
      "omnicodex__job_get",
      "omnicodex__job_list",
      "omnicodex__job_cancel",
    ]);
    expect(tools[0]?.inputSchema).toMatchObject({
      required: ["idempotencyKey", "toolName", "arguments"],
      additionalProperties: false,
    });
    expect(JSON.stringify(tools)).not.toContain("conversationId");
    expect(JSON.stringify(tools)).not.toContain("workSessionId");
    expect(JSON.stringify(tools)).not.toContain("send_message_to_thread");
    expect(JSON.stringify(tools)).not.toContain("another model");
  });
});

function startArguments(idempotencyKey: string) {
  return {
    idempotencyKey,
    toolName: "codex__app_server__command_exec",
    arguments: { command: ["godot", "--headless"] },
  };
}

function accessArguments(jobId: string) {
  return { jobId };
}

function targetContract(identity: string) {
  return {
    catalogRevision: "a".repeat(64),
    targetIdentity: `test\0${identity}`,
    targetContractDigest: "b".repeat(64),
    modelEffect: "none" as const,
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function eventually(assertion: () => Promise<void> | void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  throw lastError;
}
