import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { CodexAppHostToolExecutor } from "../src/application/codex-app-host-tool-executor.js";
import {
  beginDirectGoalExecution,
  directGoalOwnerBinding,
} from "../src/infrastructure/mcp/direct-goal-mcp-tools.js";
import { DirectGoalStore } from "../src/infrastructure/mcp/direct-goal-store.js";
import { DirectJobManager } from "../src/infrastructure/mcp/direct-job-mcp-tools.js";
import { DirectJobStore } from "../src/infrastructure/mcp/direct-job-store.js";
import { DirectScheduleManager } from "../src/infrastructure/mcp/direct-schedule-mcp-tools.js";
import { DirectScheduleStore } from "../src/infrastructure/mcp/direct-schedule-store.js";
import { MutationReplayStore } from "../src/infrastructure/mcp/mutation-replay-store.js";
import { createOmniCodexMcpServer } from "../src/infrastructure/mcp/omnicodex-mcp-server.js";

describe("OmniCodex durable direct jobs", () => {
  it("publishes job controls and executes an exact native tool after MCP disconnect", async () => {
    const pending = deferred<{
      success: boolean;
      contentItems: readonly [{ readonly type: "inputText"; readonly text: string }];
    }>();
    const nativeCalls: Array<{
      readonly tool: string;
      readonly operationId?: string;
      readonly threadId?: string;
    }> = [];
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected App Server request: ${method}`);
      },
    };
    const host = new CodexAppHostToolExecutor(appServer, {
      appToolsContextThreadId: () => "omnicodex-bridge-thread",
      appTools: {
        close: () => undefined,
        listTools: async () => [
          {
            namespace: "native_probe",
            name: "read_slow",
            description: "Read one slow native result.",
            inputSchema: {
              type: "object",
              properties: { marker: { type: "string" } },
              required: ["marker"],
              additionalProperties: false,
            },
          },
        ],
        callTool: async (params, _options) => {
          nativeCalls.push({
            tool: `${params.namespace}__${params.tool}`,
            ...(typeof params.callId === "string" ? { operationId: params.callId } : {}),
            ...(typeof params.threadId === "string" ? { threadId: params.threadId } : {}),
          });
          return pending.promise;
        },
      },
    });
    const jobManager = new DirectJobManager(DirectJobStore.inMemory());
    const workSession = {
      workSessionBinding: "stable-work-session-binding",
      directGoalClaimantBinding: "stable-goal-claimant-binding",
      directJobOwnerBinding: "stable-direct-job-owner-binding",
      continuationToken: "server-issued-continuation-token",
      journalCursor: "server-issued-journal-cursor",
    };
    const authorizationBinding = "issuer\0durable-owner\0omnicodex-principal-v1\0resource";
    const resolveWorkSession = vi.fn(() => workSession);
    const handle = createOmniCodexMcpServer({
      appServer,
      codexAppHostToolExecutor: host,
      directJobManager: jobManager,
      resolveDurableWorkSessionBinding: resolveWorkSession,
      mutationReplayStore: MutationReplayStore.inMemory(),
      authorizationBinding,
      correlationId: "first-mcp-correlation",
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "direct-job-e2e", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "omnicodex__job_start",
          "omnicodex__job_get",
          "omnicodex__job_list",
          "omnicodex__job_cancel",
        ]),
      );
      const jobStartTool = tools.tools.find((tool) => tool.name === "omnicodex__job_start");
      expect(jobStartTool?.inputSchema).toMatchObject({
        required: ["idempotencyKey", "toolName", "arguments"],
        additionalProperties: false,
      });
      expect(jobStartTool?.inputSchema.required ?? []).not.toContain("_omnicodexSession");

      const startResult = await client.callTool({
        name: "omnicodex__job_start",
        arguments: {
          idempotencyKey: "server-direct-job-e2e-0001",
          toolName: "native_probe__read_slow",
          arguments: { marker: "DIRECT_JOB_E2E" },
        },
      });
      expect(startResult.isError).not.toBe(true);
      expect(resolveWorkSession).toHaveBeenCalledTimes(1);
      expect(startResult._meta).toMatchObject({
        omnicodex: {
          workSessionBinding: workSession.workSessionBinding,
          continuationToken: workSession.continuationToken,
          journalCursor: workSession.journalCursor,
        },
      });
      const started = textJson(startResult) as {
        job: { jobId: string; operationId: string; status: string };
      };
      expect(started.job.status).toBe("queued");
      await eventually(async () => expect(nativeCalls).toHaveLength(1));

      // Closing the Web/MCP transport does not abort the server-owned job.
      await client.close();
      pending.resolve({
        success: true,
        contentItems: [{ type: "inputText", text: "DURABLE_NATIVE_RESULT" }],
      });
      await jobManager.waitForCallerIdle("first-mcp-correlation");

      expect(
        await jobManager.get(
          { jobId: started.job.jobId },
          {
            authorizationBinding,
            workSessionBinding: workSession.workSessionBinding,
            directJobOwnerBinding: workSession.directJobOwnerBinding,
          },
        ),
      ).toMatchObject({
        status: "succeeded",
        result: { content: [{ type: "text", text: "DURABLE_NATIVE_RESULT" }] },
      });
      expect(nativeCalls).toEqual([
        {
          tool: "native_probe__read_slow",
          operationId: started.job.operationId,
          threadId: "omnicodex-bridge-thread",
        },
      ]);
    } finally {
      await client.close().catch(() => undefined);
      await handle.server.close();
    }
  });

  it("retains exact IAB and server identity bindings after the MCP transport disconnects", async () => {
    const pending = deferred<{
      content: readonly [{ readonly type: "text"; readonly text: string }];
    }>();
    const browserCalls: Array<{ argumentsValue: unknown; context: unknown }> = [];
    const jobManager = new DirectJobManager(DirectJobStore.inMemory());
    const workSession = {
      workSessionBinding: "iab-durable-work-session",
      directGoalClaimantBinding: "iab-goal-claimant",
      directJobOwnerBinding: "iab-job-owner",
      continuationToken: "iab-continuation",
      journalCursor: "iab-journal",
    };
    const handle = createOmniCodexMcpServer({
      appServer: {
        request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T,
      },
      browserNativeExecutor: {
        call: (argumentsValue, context) => {
          browserCalls.push({ argumentsValue, context });
          return pending.promise;
        },
      },
      directJobManager: jobManager,
      resolveDurableWorkSessionBinding: () => workSession,
      mutationReplayStore: MutationReplayStore.inMemory(),
      authorizationBinding: "iab-authenticated-owner",
      correlationId: "iab-caller-session",
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "iab-direct-job", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const started = textJson(
        await client.callTool({
          name: "omnicodex__job_start",
          arguments: {
            idempotencyKey: "iab-direct-job-0001",
            toolName: "browser__control_in_app_browser",
            arguments: {
              code: "return await browser.tabs.list();",
              contextThreadId: "iab-desktop-task",
            },
          },
        }),
      ) as { job: { jobId: string } };
      await eventually(async () => expect(browserCalls).toHaveLength(1));
      await client.close();
      pending.resolve({ content: [{ type: "text", text: "iab-job-ok" }] });
      await jobManager.waitForCallerIdle("iab-caller-session");

      expect(browserCalls[0]?.argumentsValue).toEqual({
        operation: "list_tabs",
        surface: "iab",
        code: "return await browser.tabs.list();",
      });
      expect(browserCalls[0]?.context).toMatchObject({
        contextThreadId: "iab-desktop-task",
        ownerBinding: "iab-authenticated-owner",
        workSessionBinding: "iab-durable-work-session",
        signal: expect.any(AbortSignal),
      });
      expect(
        await jobManager.get(
          { jobId: started.job.jobId },
          {
            authorizationBinding: "iab-authenticated-owner",
            workSessionBinding: workSession.workSessionBinding,
            directJobOwnerBinding: workSession.directJobOwnerBinding,
          },
        ),
      ).toMatchObject({ status: "succeeded" });
    } finally {
      pending.resolve({ content: [{ type: "text", text: "iab-job-ok" }] });
      await client.close().catch(() => undefined);
      await handle.server.close();
    }
  });

  it("schedules native messages and runs model targets without a target blacklist", async () => {
    const nativeCall = vi.fn(async (_params: unknown) => ({
      success: true,
      contentItems: [{ type: "inputText" as const, text: "native-message-receipt" }],
    }));
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected method: ${method}`);
      },
    };
    const jobs = new DirectJobManager(DirectJobStore.inMemory());
    const schedules = new DirectScheduleManager(
      DirectScheduleStore.inMemory({ integrityKey: Buffer.alloc(32, 1), nowUnixMs: () => 1000 }),
      jobs,
    );
    const handle = createOmniCodexMcpServer({
      appServer,
      codexAppHostToolExecutor: new CodexAppHostToolExecutor(appServer, {
        appToolsContextThreadId: () => "bridge-thread",
        appTools: {
          close: () => undefined,
          listTools: async () => [
            {
              namespace: "codex_app",
              name: "send_message_to_thread",
              description: "Send a message to an existing task.",
              inputSchema: {
                type: "object",
                properties: { threadId: { type: "string" }, prompt: { type: "string" } },
                required: ["threadId", "prompt"],
                additionalProperties: false,
              },
            },
          ],
          callTool: nativeCall,
        },
      }),
      directJobManager: jobs,
      directScheduleManager: schedules,
      resolveDurableWorkSessionBinding: () => ({
        workSessionBinding: "work-session",
        directGoalClaimantBinding: "goal-claimant",
        directJobOwnerBinding: "job-owner",
        continuationToken: "continuation-token",
        journalCursor: "journal-cursor",
      }),
      mutationReplayStore: MutationReplayStore.inMemory(),
      authorizationBinding: "owner",
      correlationId: "session",
      surface: "full",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "scheduled-native-message", version: "1.0.0" });
    await handle.server.connect(st);
    await client.connect(ct);
    try {
      const args = {
        idempotencyKey: "scheduled-native-message-0001",
        timezone: "Asia/Seoul",
        rrule: "FREQ=MINUTELY",
        startAtUnixMs: 1000,
        toolName: "codex_app__send_message_to_thread",
        arguments: { threadId: "target-thread", prompt: "Requested follow-up" },
      };
      const created = await client.callTool({
        name: "omnicodex__schedule_create",
        arguments: args,
      });
      expect(created.isError, JSON.stringify(created)).not.toBe(true);
      await schedules.shutdown();
      expect(nativeCall).toHaveBeenCalledTimes(1);
      expect(nativeCall.mock.calls[0]?.[0]).toMatchObject({
        namespace: "codex_app",
        tool: "send_message_to_thread",
        arguments: args.arguments,
      });
      const repeated = await client.callTool({
        name: "omnicodex__schedule_create",
        arguments: args,
      });
      expect(repeated.isError).not.toBe(true);
      await schedules.shutdown();
      expect(nativeCall).toHaveBeenCalledTimes(1);
      const createdValue = textJson(created) as { schedule: { scheduleId: string } };
      const runs = await client.callTool({
        name: "omnicodex__schedule_runs",
        arguments: { scheduleId: createdValue.schedule.scheduleId },
      });
      expect(runs.isError).not.toBe(true);
      const entries = (textJson(runs) as { runs: Array<{ status: string }> }).runs;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ status: "succeeded" });
    } finally {
      await schedules.shutdown();
      await client.close();
      await handle.server.close();
    }
  });

  it("revalidates a pinned catalog contract at the scheduler boundary before native I/O", async () => {
    let schemaVersion = 1;
    const nativeCall = vi.fn();
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected App Server request: ${method}`);
      },
    };
    const host = new CodexAppHostToolExecutor(appServer, {
      appTools: {
        close: () => undefined,
        listTools: async () => [
          {
            namespace: "native_probe",
            name: "read_dynamic",
            description: "Read one dynamic native result.",
            inputSchema: {
              type: "object",
              properties:
                schemaVersion === 1
                  ? { marker: { type: "string" } }
                  : { marker: { type: "string" }, changed: { type: "boolean" } },
              required: ["marker"],
              additionalProperties: false,
            },
          },
        ],
        callTool: nativeCall,
      },
    });
    const jobManager = new DirectJobManager(DirectJobStore.inMemory());
    const handle = createOmniCodexMcpServer({
      appServer,
      codexAppHostToolExecutor: host,
      directJobManager: jobManager,
      resolveDurableWorkSessionBinding: () => ({
        workSessionBinding: "catalog-work-session",
        directGoalClaimantBinding: "catalog-goal-claimant",
        directJobOwnerBinding: "catalog-job-owner",
        continuationToken: "catalog-continuation",
        journalCursor: "catalog-journal",
      }),
      mutationReplayStore: MutationReplayStore.inMemory(),
      authorizationBinding: "catalog-owner",
      correlationId: "catalog-session",
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "catalog-pin-boundary", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    const dispatchEntered = deferred<void>();
    const releaseDispatch = deferred<void>();
    const baseAdapter = handle.directJobDispatchAdapter;
    const adapter = {
      validate: baseAdapter.validate.bind(baseAdapter),
      dispatch: async (request: Parameters<typeof baseAdapter.dispatch>[0]) => {
        dispatchEntered.resolve(undefined);
        await releaseDispatch.promise;
        return baseAdapter.dispatch(request);
      },
    };
    const context = {
      authorizationBinding: "catalog-owner",
      workSessionBinding: "catalog-work-session",
      directJobOwnerBinding: "catalog-job-owner",
      directGoalClaimantBinding: "catalog-goal-claimant",
      callerSessionId: "catalog-session",
    };
    try {
      const started = await jobManager.start(
        {
          idempotencyKey: "catalog-contract-boundary-0001",
          toolName: "native_probe__read_dynamic",
          arguments: { marker: "CATALOG_PIN" },
        },
        context,
        adapter,
      );
      await dispatchEntered.promise;

      schemaVersion = 2;
      await handle.refresh();
      releaseDispatch.resolve(undefined);
      await jobManager.waitForCallerIdle(context.callerSessionId);

      expect(nativeCall).not.toHaveBeenCalled();
      expect(await jobManager.get({ jobId: started.job.jobId }, context)).toMatchObject({
        status: "failed",
        error: { code: "DIRECT_JOB_CATALOG_CHANGED" },
      });
      expect(await jobManager.get({ jobId: started.job.jobId }, context)).not.toHaveProperty(
        "startedAtUnixMs",
      );
    } finally {
      releaseDispatch.resolve(undefined);
      await client.close().catch(() => undefined);
      await handle.server.close();
    }
  });

  it("resolves one durable binding per Goal request and uses its stable claimant", async () => {
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected App Server request: ${method}`);
      },
    };
    const directGoalStore = DirectGoalStore.inMemory();
    const workSession = {
      workSessionBinding: "durable-work-session",
      directGoalClaimantBinding: "durable-goal-claimant",
      directJobOwnerBinding: "durable-job-owner",
      continuationToken: "durable-continuation-token",
      journalCursor: "durable-journal-cursor",
    };
    const resolveWorkSession = vi.fn(() => workSession);
    const handle = createOmniCodexMcpServer({
      appServer,
      codexAppHostToolExecutor: new CodexAppHostToolExecutor(appServer, {
        appTools: { close: () => undefined, listTools: async () => [], callTool: vi.fn() },
      }),
      directGoalStore,
      resolveDurableWorkSessionBinding: resolveWorkSession,
      mutationReplayStore: MutationReplayStore.inMemory(),
      authorizationBinding: "issuer\0durable-owner\0client\0resource",
      correlationId: "ephemeral-mcp-correlation",
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "direct-goal-binding", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const created = textJson(
        await client.callTool({
          name: "omnicodex__goal_create",
          arguments: {
            idempotencyKey: "durable-goal-binding-0001",
            objective: "Prove stable claimant binding",
            steps: [{ id: "step-1", description: "Run one direct read", mode: "successful_call" }],
          },
        }),
      ) as { id: string };
      expect(resolveWorkSession).toHaveBeenCalledTimes(1);
      const claimed = textJson(
        await client.callTool({
          name: "omnicodex__goal_claim_next_step",
          arguments: { goalId: created.id },
        }),
      ) as { claimToken: string; step: { id: string } };
      expect(resolveWorkSession).toHaveBeenCalledTimes(2);

      await expect(
        beginDirectGoalExecution(directGoalStore, {
          authorizationBinding: directGoalOwnerBinding(
            "issuer\0durable-owner\0client\0resource",
            workSession.workSessionBinding,
          ),
          claimantBinding: workSession.directGoalClaimantBinding,
          context: {
            goalId: created.id,
            stepId: claimed.step.id,
            claimToken: claimed.claimToken,
            role: "work",
          },
          operationId: "1df15a4e-024e-4fd2-85ba-e40585c68dc1",
          toolName: "native_probe__read_state",
          targetIdentity: "native_probe/read_state",
          stateEffect: "read",
          modelEffect: "none",
          arguments: {},
        }),
      ).resolves.toMatchObject({ state: "prepared" });
    } finally {
      await client.close();
      await handle.server.close();
    }
  });
});

function textJson(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("content" in value)) {
    throw new Error("expected a tool result");
  }
  const content = (value as { readonly content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("expected tool result content");
  const first = content[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("type" in first) ||
    first.type !== "text" ||
    !("text" in first)
  ) {
    throw new Error("expected a text result");
  }
  return JSON.parse(String(first.text));
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
