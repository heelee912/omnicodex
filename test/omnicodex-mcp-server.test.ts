import { createHash } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type Tool, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { Ajv } from "ajv";
import { describe, expect, it, vi } from "vitest";
import { AppServerMethodCatalog } from "../src/application/app-server-method-catalog.js";
import type { BrowserNativeCallContext } from "../src/application/browser-native-executor.js";
import { ChatAccountRateLimitError } from "../src/application/chat-account-request-coordinator.js";
import { ChatGptBrowserActivityCoordinator } from "../src/application/chatgpt-browser-activity-coordinator.js";
import { CodexAppHostToolExecutor } from "../src/application/codex-app-host-tool-executor.js";
import { ComputerUseNativeResponseError } from "../src/application/computer-use-native-executor.js";
import {
  type NativeExecutionRequest,
  NativeExecutionScheduler,
  nativeExecutionOrderingFromArguments,
} from "../src/application/native-execution-scheduler.js";
import { NativeToolCatalog, NativeToolExecutor } from "../src/application/native-tool-catalog.js";
import {
  ResponsesNativeToolCatalog,
  ResponsesNativeToolExecutor,
} from "../src/application/responses-native-tool-catalog.js";
import {
  directGoalOwnerBinding,
  directGoalResourceDigest,
} from "../src/infrastructure/mcp/direct-goal-mcp-tools.js";
import { DirectGoalStore } from "../src/infrastructure/mcp/direct-goal-store.js";
import { DirectJobManager } from "../src/infrastructure/mcp/direct-job-mcp-tools.js";
import { DirectJobStore } from "../src/infrastructure/mcp/direct-job-store.js";
import {
  DirectScheduleManager,
  directScheduleToolNames,
} from "../src/infrastructure/mcp/direct-schedule-mcp-tools.js";
import { DirectScheduleStore } from "../src/infrastructure/mcp/direct-schedule-store.js";
import { LegacyMutationCoordinator } from "../src/infrastructure/mcp/legacy-mutation-coordinator.js";
import { MutationReplayStore } from "../src/infrastructure/mcp/mutation-replay-store.js";
import {
  browserNativeDiagnosticObservation,
  createOmniCodexMcpServer,
  directGoalResultWithInlineState,
  type McpMutationReplayObservation,
  type McpProgressObservation,
  type McpReadInvocationObservation,
  type McpResultDeliveryObservation,
  type McpToolCatalogObservation,
  materializableResourceLinkCount,
  type NativeToolExecutionObservation,
  nativeToolResultOutcome,
  OMNICODEX_ACTIVITY_RESOURCE_URI,
  OMNICODEX_ATTACH_LOCAL_FILE_TOOL,
  OMNICODEX_CHATGPT_ACTION_CATALOG_BYTE_BUDGET,
  OMNICODEX_FULL_CATALOG_PAGE_BYTE_BUDGET,
  OMNICODEX_FULL_CATALOG_PRIORITY,
  OMNICODEX_NATIVE_SEARCH_PAGE_BYTE_BUDGET,
  type OmniCodexMcpServerOptions,
  OmniCodexNativeToolRegistryCatalog,
} from "../src/infrastructure/mcp/omnicodex-mcp-server.js";
import { ReadInvocationCoordinator } from "../src/infrastructure/mcp/read-invocation-coordinator.js";
import type { DurableNativeResourceLeaseView } from "../src/infrastructure/runtime/durable-native-resource-lease-coordinator.js";
import { JsonlRpcError } from "../src/infrastructure/runtime/jsonl-rpc-client.js";
import type { ResponsesNativeToolSpec } from "../src/infrastructure/runtime/responses-loopback-driver.js";
import type { CodexAppNativeTool } from "../src/infrastructure/windows/codex-app-tools-pipe-client.js";

const ALL_FALSE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

describe("OmniCodex MCP server", () => {
  describe("bounded Browser activity Stop", () => {
    const toolName = "codex__omnicodex__browser_activity_stop";
    const ownerBinding = "stop-owner";
    const workSessionBinding = "stop-work";
    const activityContext: BrowserNativeCallContext = {
      ownerBinding,
      workSessionBinding,
      callerProvenance: "chatgpt_conversation",
    };
    const workSession = (binding = workSessionBinding) => ({
      workSessionBinding: binding,
      directGoalClaimantBinding: "stop-claimant",
      directJobOwnerBinding: "stop-job-owner",
      continuationToken: "stop-continuation",
      journalCursor: "stop-journal",
    });
    const stopRequest = (invocationId?: string) => ({
      name: toolName,
      arguments: {},
      ...(invocationId === undefined ? {} : { _meta: { "omnicodex/invocationId": invocationId } }),
    });
    const gate = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const connect = async (
      overrides: Partial<OmniCodexMcpServerOptions> = {},
      omitted: readonly (keyof OmniCodexMcpServerOptions)[] = [],
    ) => {
      const coordinator = new ChatGptBrowserActivityCoordinator({
        readActiveConversationIds: async () => ({
          activeConversationIds: [],
          unknownConversationIds: [],
        }),
        observationIntervalMs: 300_000,
      });
      const executor = {
        call: vi.fn(async () => ({ content: [] })),
        beginActivity: vi.fn(async (_binding: string, _context?: BrowserNativeCallContext) => {}),
        finishActivity: vi.fn(async (_binding: string, _context?: BrowserNativeCallContext) => {}),
        finishCurrentActivity: vi.fn(async (_context?: BrowserNativeCallContext) => {}),
      };
      const scheduler = new RecordingNativeExecutionScheduler();
      const observations: NativeToolExecutionObservation[] = [];
      const mutations: McpMutationReplayObservation[] = [];
      const mutationReplayStore = MutationReplayStore.inMemory();
      const legacyMutationCoordinator = LegacyMutationCoordinator.inMemory();
      const serverOptions: OmniCodexMcpServerOptions = {
        appServer: {
          request: async <T>(method: string): Promise<T> => {
            if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
            throw new Error(`Unexpected Stop fixture request: ${method}`);
          },
        },
        authorizationBinding: ownerBinding,
        mutationReplayStore,
        legacyMutationCoordinator,
        browserNativeExecutor: executor,
        browserActivityCoordinator: coordinator,
        scheduler,
        resolveDurableWorkSessionBinding: () => workSession(),
        observeNativeToolExecution: (event) => {
          observations.push(event);
        },
        observeMutationReplay: (event) => {
          mutations.push(event);
        },
        ...overrides,
      };
      for (const key of omitted) Reflect.deleteProperty(serverOptions, key);
      const handle = createOmniCodexMcpServer(serverOptions);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "bounded-browser-stop-fixture", version: "1" });
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      return {
        client,
        handle,
        coordinator,
        executor,
        scheduler,
        observations,
        mutations,
        mutationReplayStore,
        legacyMutationCoordinator,
        close: async () => {
          await client.close();
          await handle.server.close();
          await coordinator.close({ preserveActivities: true });
        },
      };
    };

    it.each([
      ["full", false],
      ["compat", false],
      ["full", true],
      ["compat", true],
    ] as const)(
      "advertises the empty non-model Stop in %s catalog/search (bounded=%s)",
      async (surface, bounded) => {
        const fixture = await connect({
          surface,
          ...(bounded
            ? { actionCatalogByteBudget: OMNICODEX_CHATGPT_ACTION_CATALOG_BYTE_BUDGET }
            : {}),
        });
        try {
          const tools = (await fixture.client.listTools()).tools;
          const stop = tools.find((tool) => tool.name === toolName);
          expect(tools.filter((tool) => tool.name === toolName)).toHaveLength(1);
          expect(stop?.inputSchema).toEqual({
            type: "object",
            properties: {},
            additionalProperties: false,
          });
          expect(stop?.annotations).toEqual(ALL_FALSE_ANNOTATIONS);
          expect(await fixture.handle.classifyToolCall(toolName, {})).toBe("non_model");
          const search = await fixture.client.callTool({
            name: "search_native_tools",
            arguments: { query: toolName, modelEffect: "none" },
          });
          expect(search.isError).not.toBe(true);
          expect(objectValue(search.structuredContent).tools).toEqual([
            expect.objectContaining({
              name: toolName,
              modelEffect: "none",
              invokesModel: false,
              route: "omnicodex_browser_activity",
              executeWith: toolName,
              executeArguments: {},
              nativeTool: expect.objectContaining({ inputSchema: stop?.inputSchema }),
            }),
          ]);
        } finally {
          await fixture.close();
        }
      },
    );

    it.each([
      [
        "owner",
        {},
        ["authorizationBinding", "mutationReplayStore", "legacyMutationCoordinator"],
        "AUTHENTICATED_OWNER_REQUIRED",
      ],
      ["Work resolver", {}, ["resolveDurableWorkSessionBinding"], "DURABLE_WORK_SESSION_REQUIRED"],
      [
        "empty Work binding",
        { resolveDurableWorkSessionBinding: () => workSession("") },
        [],
        "DURABLE_WORK_SESSION_REQUIRED",
      ],
      [
        "failed Work binding",
        {
          resolveDurableWorkSessionBinding: () => {
            throw new Error("fixture binding unavailable");
          },
        },
        [],
        "DURABLE_WORK_SESSION_UNAVAILABLE",
      ],
      ["executor", {}, ["browserNativeExecutor"], "LIFECYCLE_UNAVAILABLE"],
      ["coordinator", {}, ["browserActivityCoordinator"], "LIFECYCLE_UNAVAILABLE"],
      ["durable semantic fence", {}, ["legacyMutationCoordinator"], "DURABLE_FENCE_REQUIRED"],
      [
        "executor lifecycle methods",
        { browserNativeExecutor: { call: async () => ({ content: [] }) } },
        [],
        "LIFECYCLE_UNAVAILABLE",
      ],
      [
        "coordinator Stop method",
        {
          browserActivityCoordinator: {
            observeActivityBoundary: async () => {},
            coordinate: async (_executor, context) => context,
            close: async () => {},
          },
        },
        [],
        "LIFECYCLE_UNAVAILABLE",
      ],
    ] satisfies readonly [
      string,
      Partial<OmniCodexMcpServerOptions>,
      (keyof OmniCodexMcpServerOptions)[],
      string,
    ][])("rejects Stop without a server-owned %s", async (_name, overrides, omitted, code) => {
      const fixture = await connect(overrides, omitted);
      try {
        for (const id of [undefined, "stop-binding-validation-explicit"]) {
          const result = await fixture.client.callTool(stopRequest(id));
          expect(result.isError).toBe(true);
          expect(JSON.stringify(result.content)).toContain(code);
        }
        expect(fixture.scheduler.requests).toHaveLength(0);
        expect(fixture.executor.finishActivity).not.toHaveBeenCalled();
        expect(fixture.executor.finishCurrentActivity).not.toHaveBeenCalled();
      } finally {
        await fixture.close();
      }
    });

    it.each([
      "ownerBinding",
      "workSessionBinding",
      "sessionId",
      "contextThreadId",
      "contextTurnId",
      "tabId",
      "_omnicodexSession",
      "omnicodexInvocationId",
      "_omnicodexGoal",
    ])("rejects caller-supplied %s instead of selecting a target", async (key) => {
      const fixture = await connect();
      try {
        const result = await fixture.client.callTool({
          name: toolName,
          arguments: { [key]: "not-authoritative" },
        });
        expect(result.isError).toBe(true);
        expect(fixture.scheduler.requests).toHaveLength(0);
        expect(fixture.executor.finishActivity).not.toHaveBeenCalled();
        expect(fixture.executor.finishCurrentActivity).not.toHaveBeenCalled();
      } finally {
        await fixture.close();
      }
    });

    it("drains admitted calls before scheduling exact owner/Work cleanup and awaits its result", async () => {
      const fixture = await connect();
      const admitted = gate();
      const drain = gate();
      const cleanup = gate();
      const stopSpy = vi.spyOn(fixture.coordinator, "finishCurrentActivity");
      fixture.executor.finishActivity.mockImplementation(async () => cleanup.promise);
      let delivered = false;
      const active = fixture.coordinator.runWithActivity(
        fixture.executor,
        activityContext,
        async () => {
          admitted.resolve();
          await drain.promise;
        },
      );
      await admitted.promise;
      try {
        const stop = fixture.client.callTool({ name: toolName, arguments: {} }).then((result) => {
          delivered = true;
          return result;
        });
        await vi.waitFor(() => expect(stopSpy).toHaveBeenCalledOnce());
        expect(fixture.scheduler.requests).toHaveLength(0);
        drain.resolve();
        await active;
        await vi.waitFor(() => expect(fixture.executor.finishActivity).toHaveBeenCalledOnce());
        expect(delivered).toBe(false);
        expect(fixture.scheduler.requestFor("browser_activity_stop")).toMatchObject({
          ownerId: ownerBinding,
          sessionId: workSessionBinding,
          entry: { modelEffect: "none", stateEffect: "mutate" },
        });
        cleanup.resolve();
        const result = await stop;
        expect(result.isError).not.toBe(true);
        expect(result.content).toEqual([{ type: "text", text: "Browser activity stopped." }]);
        expect(fixture.observations).toContainEqual(
          expect.objectContaining({
            targetNativeName: "browser_activity_stop",
            modelEffect: "none",
            stateEffect: "mutate",
            outcome: "succeeded",
          }),
        );
        expect(fixture.mutations).toContainEqual(
          expect.objectContaining({ disposition: "dispatch" }),
        );
        expect(fixture.executor.call).not.toHaveBeenCalled();
      } finally {
        drain.resolve();
        cleanup.resolve();
        await active;
        await fixture.close();
      }
    });

    it("never joins another Work session's Stop or retires another owner's activity", async () => {
      const fixture = await connect();
      const otherSession = await connect({
        browserNativeExecutor: fixture.executor,
        browserActivityCoordinator: fixture.coordinator,
        scheduler: fixture.scheduler,
        mutationReplayStore: fixture.mutationReplayStore,
        legacyMutationCoordinator: fixture.legacyMutationCoordinator,
        resolveDurableWorkSessionBinding: () => workSession("other-work"),
      });
      const otherWork = { ...activityContext, workSessionBinding: "other-work" };
      const otherOwner = { ...activityContext, ownerBinding: "other-owner" };
      const cleanup = gate();
      fixture.executor.finishActivity.mockImplementation(async (_binding, context) => {
        if (context?.workSessionBinding === workSessionBinding) await cleanup.promise;
      });
      const firstActivity = await fixture.coordinator.coordinate(fixture.executor, activityContext);
      await fixture.coordinator.coordinate(fixture.executor, otherWork);
      const untouched = await fixture.coordinator.coordinate(fixture.executor, otherOwner);
      try {
        const first = fixture.client.callTool({ name: toolName, arguments: {} });
        await vi.waitFor(() => expect(fixture.executor.finishActivity).toHaveBeenCalledOnce());
        const second = await otherSession.client.callTool({ name: toolName, arguments: {} });
        expect(second.isError).not.toBe(true);
        expect(fixture.executor.finishActivity.mock.calls.map(([, context]) => context)).toEqual([
          expect.objectContaining({ ownerBinding, workSessionBinding }),
          expect.objectContaining({ ownerBinding, workSessionBinding: "other-work" }),
        ]);
        expect(
          (await fixture.coordinator.coordinate(fixture.executor, otherOwner)).activityBinding,
        ).toBe(untouched.activityBinding);
        cleanup.resolve();
        expect((await first).isError).not.toBe(true);
        expect(
          (await fixture.coordinator.coordinate(fixture.executor, activityContext)).activityBinding,
        ).not.toBe(firstActivity.activityBinding);
      } finally {
        cleanup.resolve();
        await otherSession.close();
        await fixture.close();
      }
    });

    it("retains failed lifecycle records and never automatically replays ambiguous Stop", async () => {
      const fixture = await connect();
      fixture.executor.finishActivity.mockRejectedValueOnce(new Error("fixture cleanup pending"));
      const original = await fixture.coordinator.coordinate(fixture.executor, activityContext);
      const reconnected = await connect({
        appServer: {
          request: async <T>(method: string): Promise<T> => {
            if (method !== "mcpServerStatus/list")
              throw new Error("Unexpected catalog fixture request");
            return {
              data: [
                {
                  name: "unrelated-catalog-change",
                  tools: {
                    inspect: { name: "inspect", inputSchema: { type: "object", properties: {} } },
                  },
                },
              ],
              nextCursor: null,
            } as T;
          },
        },
        browserNativeExecutor: fixture.executor,
        browserActivityCoordinator: fixture.coordinator,
        scheduler: fixture.scheduler,
        mutationReplayStore: fixture.mutationReplayStore,
        legacyMutationCoordinator: fixture.legacyMutationCoordinator,
      });
      try {
        const first = await fixture.client.callTool({ name: toolName, arguments: {} });
        expect(first.isError).toBe(true);
        expect(JSON.stringify(first.content)).toContain("MUTATION_OUTCOME_UNKNOWN");
        expect(JSON.stringify(first.content)).not.toContain("Browser activity stopped.");
        const before = (await fixture.client.listTools()).tools.find(
          (tool) => tool.name === toolName,
        );
        const after = (await reconnected.client.listTools()).tools.find(
          (tool) => tool.name === toolName,
        );
        expect(objectValue(after?._meta?.omnicodex).catalogRevision).not.toBe(
          objectValue(before?._meta?.omnicodex).catalogRevision,
        );
        const repeated = await reconnected.client.callTool({ name: toolName, arguments: {} });
        expect(repeated.isError).toBe(true);
        expect(JSON.stringify(repeated)).toContain("AMBIGUOUS_LEGACY_MUTATION_COHORT");
        const reclassified = await reconnected.client.callTool({
          name: toolName,
          arguments: {},
          _meta: { "omnicodex/invocationId": "83d93765-93df-4fca-95e4-000000000001" },
        });
        expect(reclassified.isError).toBe(true);
        expect(JSON.stringify(reclassified)).toContain("AMBIGUOUS_LEGACY_MUTATION_COHORT");
        expect(fixture.executor.finishActivity).toHaveBeenCalledOnce();
        await expect(
          fixture.coordinator.coordinate(fixture.executor, activityContext),
        ).rejects.toThrow("BROWSER_ACTIVITY_RETIRING");
        // Explicit lifecycle recovery remains possible; this is not a tool retry.
        await fixture.coordinator.finishCurrentActivity(
          fixture.executor,
          activityContext,
          (operation) =>
            fixture.scheduler.run(
              {
                ownerId: ownerBinding,
                sessionId: workSessionBinding,
                entry: {
                  nativeNamespace: "omnicodex",
                  originalName: "browser_activity_stop",
                  source: "omnicodex",
                  modelEffect: "none",
                  stateEffect: "mutate",
                },
              },
              operation,
            ),
        );
        expect(fixture.executor.finishActivity).toHaveBeenCalledTimes(2);
        expect(fixture.executor.finishActivity.mock.calls.map(([binding]) => binding)).toEqual([
          original.activityBinding,
          original.activityBinding,
        ]);
      } finally {
        await reconnected.close();
        await fixture.close();
      }
    });

    it.each(["legacy", "explicit"] as const)(
      "fences an unknown %s Stop across identities on the same and reconnected transports",
      async (mode) => {
        const fixture = await connect();
        const originalId = mode === "explicit" ? "stop-original-explicit" : undefined;
        fixture.executor.finishActivity.mockRejectedValueOnce(new Error("native outcome unknown"));
        await fixture.coordinator.coordinate(fixture.executor, activityContext);
        const reconnected = await connect({
          browserNativeExecutor: fixture.executor,
          browserActivityCoordinator: fixture.coordinator,
          scheduler: fixture.scheduler,
          mutationReplayStore: fixture.mutationReplayStore,
          legacyMutationCoordinator: fixture.legacyMutationCoordinator,
        });
        try {
          const original = await fixture.client.callTool(stopRequest(originalId));
          expect(original.isError).toBe(true);
          expect(JSON.stringify(original)).toContain("MUTATION_OUTCOME_UNKNOWN");
          if (originalId !== undefined) {
            const exact = await reconnected.client.callTool(stopRequest(originalId));
            expect(exact.isError).toBe(true);
            expect(JSON.stringify(exact)).toContain("MUTATION_OUTCOME_UNKNOWN");
          }
          for (const [index, client] of [fixture.client, reconnected.client].entries()) {
            for (const id of [undefined, `stop-new-explicit-${index}`]) {
              const repeated = await client.callTool(stopRequest(id));
              expect(repeated.isError).toBe(true);
              expect(JSON.stringify(repeated)).toContain("AMBIGUOUS_LEGACY_MUTATION_COHORT");
              expect(JSON.stringify(repeated.content)).not.toContain("Browser activity stopped.");
            }
          }
          expect(fixture.executor.finishActivity).toHaveBeenCalledOnce();
          expect(fixture.executor.finishCurrentActivity).not.toHaveBeenCalled();
          await expect(
            fixture.coordinator.coordinate(fixture.executor, activityContext),
          ).rejects.toThrow("BROWSER_ACTIVITY_RETIRING");
        } finally {
          await reconnected.close();
          await fixture.close();
        }
      },
    );

    it("keeps the durable semantic fence after loading persisted records with fresh runtime state", async () => {
      const directory = await mkdtemp(
        join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "browser-stop-fence-"),
      );
      const snapshotPath = join(directory, "original.json");
      const coordinator = await LegacyMutationCoordinator.open({ snapshotPath });
      const fixture = await connect({ legacyMutationCoordinator: coordinator });
      fixture.executor.finishActivity.mockRejectedValueOnce(new Error("native outcome unknown"));
      await fixture.coordinator.coordinate(fixture.executor, activityContext);
      try {
        expect(
          (await fixture.client.callTool(stopRequest("stop-before-replacement"))).isError,
        ).toBe(true);
        await coordinator.compact();
        const restoredPath = join(directory, "restored.json");
        await copyFile(snapshotPath, restoredPath);
        const restoredCoordinator = await LegacyMutationCoordinator.open({
          snapshotPath: restoredPath,
        });
        // A different snapshot path opens a fresh core from persisted bytes,
        // not the process-shared map, just like a replacement process would.
        const restored = await connect({ legacyMutationCoordinator: restoredCoordinator });
        try {
          for (const id of ["stop-after-replacement", undefined]) {
            const result = await restored.client.callTool(stopRequest(id));
            expect(result.isError).toBe(true);
            expect(JSON.stringify(result)).toContain("AMBIGUOUS_LEGACY_MUTATION_COHORT");
          }
          expect(restored.executor.finishActivity).not.toHaveBeenCalled();
          expect(restored.executor.finishCurrentActivity).not.toHaveBeenCalled();
          // A fence rejection before entry must not strand the restored placeholder.
          await expect(
            restored.coordinator.coordinate(restored.executor, activityContext),
          ).resolves.toBeDefined();
        } finally {
          await restored.close();
        }
      } finally {
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("partitions an unknown semantic Stop by authenticated owner and durable Work session", async () => {
      const fixture = await connect();
      fixture.executor.finishActivity.mockRejectedValueOnce(new Error("native outcome unknown"));
      await fixture.coordinator.coordinate(fixture.executor, activityContext);
      try {
        expect(
          (await fixture.client.callTool(stopRequest("stop-unknown-owner-work"))).isError,
        ).toBe(true);
        for (const scope of [
          { ownerBinding, workSessionBinding: "another-work" },
          { ownerBinding: "another-owner", workSessionBinding },
        ]) {
          const scoped = await connect({
            authorizationBinding: scope.ownerBinding,
            resolveDurableWorkSessionBinding: () => workSession(scope.workSessionBinding),
            browserNativeExecutor: fixture.executor,
            browserActivityCoordinator: fixture.coordinator,
            scheduler: fixture.scheduler,
            mutationReplayStore: fixture.mutationReplayStore,
            legacyMutationCoordinator: fixture.legacyMutationCoordinator,
          });
          try {
            await fixture.coordinator.coordinate(fixture.executor, {
              ...activityContext,
              ...scope,
            });
            expect(
              (
                await scoped.client.callTool(
                  stopRequest(`stop-${scope.ownerBinding}-${scope.workSessionBinding}`),
                )
              ).isError,
            ).not.toBe(true);
            expect(fixture.executor.finishActivity.mock.calls.at(-1)?.[1]).toMatchObject(scope);
          } finally {
            await scoped.close();
          }
        }
        expect(fixture.executor.finishActivity).toHaveBeenCalledTimes(3);
        await expect(
          fixture.coordinator.coordinate(fixture.executor, activityContext),
        ).rejects.toThrow("BROWSER_ACTIVITY_RETIRING");
      } finally {
        await fixture.close();
      }
    });

    it("admits a new Stop only after authoritative completion of the prior semantic cohort", async () => {
      const fixture = await connect();
      try {
        await fixture.coordinator.coordinate(fixture.executor, activityContext);
        expect((await fixture.client.callTool(stopRequest("stop-completed-one"))).isError).not.toBe(
          true,
        );
        expect((await fixture.client.callTool(stopRequest("stop-completed-one"))).isError).not.toBe(
          true,
        );
        expect(fixture.executor.finishActivity).toHaveBeenCalledOnce();
        await fixture.coordinator.coordinate(fixture.executor, activityContext);
        expect((await fixture.client.callTool(stopRequest("stop-completed-two"))).isError).not.toBe(
          true,
        );
        expect(fixture.executor.finishActivity).toHaveBeenCalledTimes(2);
      } finally {
        await fixture.close();
      }
    });

    it("reopens activity after proven scheduler pre-dispatch cancellation", async () => {
      const fixture = await connect();
      const original = await fixture.coordinator.coordinate(fixture.executor, activityContext);
      vi.spyOn(fixture.scheduler, "run").mockRejectedValueOnce(
        new Error("cancelled before dispatch"),
      );
      try {
        const cancelled = await fixture.client.callTool(
          stopRequest("stop-cancelled-before-dispatch"),
        );
        expect(cancelled.isError).toBe(true);
        expect(fixture.executor.finishActivity).not.toHaveBeenCalled();
        expect(
          (await fixture.coordinator.coordinate(fixture.executor, activityContext)).activityBinding,
        ).toBe(original.activityBinding);
        expect(
          (await fixture.client.callTool(stopRequest("stop-after-proven-cancellation"))).isError,
        ).not.toBe(true);
        expect(fixture.executor.finishActivity).toHaveBeenCalledOnce();
      } finally {
        await fixture.close();
      }
    });

    it("keeps cross-ID Stop fencing when cleanup succeeds but its explicit receipt commit fails", async () => {
      const fixture = await connect();
      const acquire = fixture.mutationReplayStore.acquire.bind(fixture.mutationReplayStore);
      vi.spyOn(fixture.mutationReplayStore, "acquire").mockImplementationOnce(async (identity) => {
        const acquisition = await acquire(identity);
        if (acquisition.kind === "execute")
          vi.spyOn(acquisition.execution, "complete").mockRejectedValueOnce(
            new Error("receipt commit failed"),
          );
        return acquisition;
      });
      try {
        await fixture.coordinator.coordinate(fixture.executor, activityContext);
        const first = await fixture.client.callTool(stopRequest("stop-uncommitted-receipt"));
        expect(first.isError).toBe(true);
        expect(JSON.stringify(first)).toContain("MUTATION_OUTCOME_UNKNOWN");
        expect(fixture.executor.finishActivity).toHaveBeenCalledOnce();
        await fixture.coordinator.coordinate(fixture.executor, activityContext);
        for (const id of ["stop-reminted-after-receipt-failure", undefined]) {
          const retry = await fixture.client.callTool(stopRequest(id));
          expect(retry.isError).toBe(true);
          expect(JSON.stringify(retry)).toContain("AMBIGUOUS_LEGACY_MUTATION_COHORT");
        }
        expect(fixture.executor.finishActivity).toHaveBeenCalledOnce();
      } finally {
        await fixture.close();
      }
    });

    it("releases a durable Stop cohort when cancellation proves cleanup never entered", async () => {
      const cancellation = new AbortController();
      cancellation.abort();
      const fixture = await connect({
        scheduler: new BoundarySignalScheduler(cancellation.signal),
      });
      const acquire = vi.spyOn(fixture.legacyMutationCoordinator, "acquire");
      const original = await fixture.coordinator.coordinate(fixture.executor, activityContext);
      try {
        const request = stopRequest("stop-cancelled-after-durable-admission");
        expect((await fixture.client.callTool(request)).isError).toBe(true);
        expect(acquire).toHaveBeenCalledOnce();
        expect(fixture.executor.finishActivity).not.toHaveBeenCalled();
        const semanticDigest = acquire.mock.calls[0]?.[0].semanticDigest;
        if (semanticDigest === undefined) throw new Error("Missing durable Stop cohort");
        expect(
          (
            await fixture.legacyMutationCoordinator.readStatus({
              authorizationBinding: ownerBinding,
              semanticDigest,
            })
          ).matches,
        ).toHaveLength(0);
        expect(
          (await fixture.coordinator.coordinate(fixture.executor, activityContext)).activityBinding,
        ).toBe(original.activityBinding);
        const reconnected = await connect({
          browserNativeExecutor: fixture.executor,
          browserActivityCoordinator: fixture.coordinator,
          mutationReplayStore: fixture.mutationReplayStore,
          legacyMutationCoordinator: fixture.legacyMutationCoordinator,
        });
        try {
          // Exact identity may retry when both durable coordinators know no I/O happened.
          expect((await reconnected.client.callTool(request)).isError).not.toBe(true);
          expect(fixture.executor.finishActivity).toHaveBeenCalledOnce();
        } finally {
          await reconnected.close();
        }
      } finally {
        await fixture.close();
      }
    });

    it("uses the durable executor cleanup path after coordinator replacement", async () => {
      const fixture = await connect();
      try {
        const result = await fixture.client.callTool({ name: toolName, arguments: {} });
        expect(result.isError).not.toBe(true);
        expect(fixture.executor.beginActivity).not.toHaveBeenCalled();
        expect(fixture.executor.finishActivity).not.toHaveBeenCalled();
        expect(fixture.executor.finishCurrentActivity).toHaveBeenCalledWith(
          expect.objectContaining({
            ownerBinding,
            workSessionBinding,
          }),
        );
      } finally {
        await fixture.close();
      }
    });
  });

  it.each(["direct", "generic"] as const)(
    "retains a bare explicit browser error across the %s MCP boundary",
    async (route) => {
      const native = {
        isError: true,
        success: false,
        error: { name: "SyntheticRefusal", message: "Synthetic safety-check refusal" },
      };
      const observations: NativeToolExecutionObservation[] = [];
      let nativeCalls = 0;
      const handle = createOmniCodexMcpServer({
        appServer: {
          request: async <T>(method: string): Promise<T> => {
            if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
            throw new Error("Unexpected fixture request");
          },
        },
        browserNativeExecutor: {
          call: async () => {
            nativeCalls += 1;
            return native;
          },
        },
        surface: "full",
        observeNativeToolExecution: (observation) => {
          observations.push(observation);
        },
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "explicit-error-fixture", version: "1" });
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        await client.listTools();
        const args = { operation: "exec", code: "return 'non-sensitive fixture';" };
        const result = await client.callTool(
          route === "direct"
            ? { name: "chrome__control_chrome", arguments: args }
            : {
                name: "call_native_tool",
                arguments: { name: "chrome__control_chrome", arguments: args },
              },
        );
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual(native);
        expect(nativeCalls).toBe(1);
        expect(observations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ outcome: "tool_error", errorClass: "native_error" }),
          ]),
        );
        expect(JSON.stringify(observations)).not.toContain("Synthetic safety-check refusal");
      } finally {
        await client.close();
        await handle.server.close();
      }
    },
  );

  it.each(["direct", "generic"] as const)(
    "observes %s browser execution without interpreting or replacing native results",
    async (route) => {
      const observations: NativeToolExecutionObservation[] = [];
      const nativeError = {
        content: [{ type: "text" as const, text: "private-native-error-sentinel" }],
        isError: true,
        structuredContent: {
          error: { code: "BROWSER_SELECTION_STALE", message: "private-native-error-sentinel" },
        },
      };
      const media = {
        content: [
          { type: "image" as const, data: "YWJj", mimeType: "image/png" },
          { type: "audio" as const, data: "YWJj", mimeType: "audio/wav" },
          { type: "resource_link" as const, name: "fixture", uri: "fixture://native" },
        ],
      };
      const unlistedError = {
        ...nativeError,
        structuredContent: {
          error: { code: "PRIVATE_CREDENTIAL_SENTINEL", name: "PRIVATE_ACCOUNT_SENTINEL" },
        },
      };
      const json = {
        content: [{ type: "text" as const, text: '{"value":"private-json-sentinel"}' }],
      };
      const renderedUndefined = { content: [{ type: "text" as const, text: "undefined" }] };
      let nativeResult: unknown;
      let rejectNative = false;
      let calls = 0;
      const appServer = {
        request: async <T>(method: string): Promise<T> => {
          if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
          throw new Error(`unexpected method ${method}`);
        },
      };
      const handle = createOmniCodexMcpServer({
        appServer,
        surface: "full",
        browserNativeExecutor: {
          call: async (_args, context) => {
            calls += 1;
            context?.observeExecutionStage?.("runtime_setup");
            context?.observeExecutionStage?.("native_dispatch");
            if (rejectNative) throw new Error("private-rejection-sentinel");
            context?.observeExecutionStage?.("native_returned");
            return nativeResult;
          },
        },
        observeNativeToolExecution: (observation) => {
          observations.push(observation);
          throw new Error("observer failure");
        },
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "browser-diagnostic-fixture", version: "1" });
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        await client.listTools();
        const call = () => {
          const args = { code: "await Promise.resolve();", title: "private-argument-sentinel" };
          return client.callTool(
            route === "direct"
              ? { name: "chrome__control_chrome", arguments: args }
              : {
                  name: "call_native_tool",
                  arguments: { name: "chrome__control_chrome", arguments: args },
                },
          );
        };
        for (const value of [
          undefined,
          renderedUndefined,
          json,
          media,
          nativeError,
          unlistedError,
        ]) {
          nativeResult = value;
          const result = await call();
          const isNativeError = value === nativeError || value === unlistedError;
          expect(result.isError === true).toBe(isNativeError);
          if (value !== undefined) expect(result.content).toEqual(value.content);
          if (isNativeError)
            expect(result.structuredContent).toEqual(
              (value as typeof nativeError | typeof unlistedError).structuredContent,
            );
          const receipt = observations.at(-1);
          expect(receipt).toMatchObject({
            targetRoute: "browser_native",
            browserExecutionStage: "native_returned",
            browserReturnValuePresence: "unknown",
            outcome: isNativeError ? "tool_error" : "succeeded",
          });
          expect(receipt?.browserDiagnosticErrorCode).toBe(
            value === nativeError ? "BROWSER_SELECTION_STALE" : undefined,
          );
        }
        rejectNative = true;
        expect((await call()).isError).toBe(true);
        expect(observations.at(-1)).toMatchObject({
          browserExecutionStage: "native_dispatch",
          browserReturnValuePresence: "unknown",
          outcome: "failed",
        });
        expect(calls).toBe(7);
        for (const marker of [
          "private-native-error-sentinel",
          "private-json-sentinel",
          "private-argument-sentinel",
          "private-rejection-sentinel",
          "YWJj",
          "PRIVATE_CREDENTIAL_SENTINEL",
          "PRIVATE_ACCOUNT_SENTINEL",
        ]) {
          expect(JSON.stringify(observations)).not.toContain(marker);
        }
      } finally {
        await client.close();
        await handle.server.close();
      }
    },
  );

  it("projects only fixed browser diagnostic values into the operational log", () => {
    const observation: NativeToolExecutionObservation = {
      surface: "full",
      mcpToolName: "chrome__control_chrome",
      operation: "native_call",
      targetRoute: "browser_native",
      outcome: "tool_error",
      errorCode: "PRIVATE_CREDENTIAL_SENTINEL",
    };
    Object.assign(observation, {
      browserExecutionStage: "private-stage-sentinel",
      browserReturnValuePresence: "private-return-sentinel",
      browserDiagnosticErrorCode: "PRIVATE_CREDENTIAL_SENTINEL",
      arguments: { password: "private-password-sentinel", otp: "private-otp-sentinel" },
      body: "private-body-sentinel",
    });
    expect(browserNativeDiagnosticObservation(observation)).toEqual({
      browserExecutionStage: "dispatch_pending",
      browserReturnValuePresence: "unknown",
    });
    expect(
      browserNativeDiagnosticObservation({
        ...observation,
        errorCode: "BROWSER_OUTCOME_UNKNOWN_REBOUND",
      }),
    ).toEqual({
      browserExecutionStage: "dispatch_pending",
      browserReturnValuePresence: "unknown",
      browserDiagnosticErrorCode: "BROWSER_OUTCOME_UNKNOWN_REBOUND",
    });
    expect(
      browserNativeDiagnosticObservation({ ...observation, targetRoute: "downstream" }),
    ).toEqual({});
  });

  it("reports a failed server only for exact previously published missing tool names", async () => {
    const toolName = "codex__cua_repl__js";
    let toolsError: string | undefined = "MCP startup failed: access denied (os error 5)";
    let present = true;
    let nativeCalls = 0;
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list")
          return {
            data: present
              ? [
                  {
                    name: "cua_repl",
                    tools:
                      toolsError === undefined
                        ? { js: { name: "js", inputSchema: { type: "object" } } }
                        : {},
                    toolsError,
                  },
                ]
              : [],
            nextCursor: null,
          } as T;
        if (method === "mcpServer/tool/call") {
          nativeCalls += 1;
          return { content: [{ type: "text", text: "native result" }] } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    const handle = createOmniCodexMcpServer({
      appServer,
      nativeToolExecutor: new NativeToolExecutor(appServer, { threadId: "native-context" }),
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "failed-native-server", version: "1" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await client.listTools();
      const call = () => client.callTool({ name: toolName, arguments: {} });
      expect(JSON.stringify(await call())).toContain("Unknown OmniCodex tool");
      toolsError = undefined;
      await handle.refresh();
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(toolName);
      expect((await call()).isError).not.toBe(true);
      toolsError = "MCP startup failed: 액세스가 거부되었습니다. (os error 5)";
      await handle.refresh();
      expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(toolName);
      for (const result of [
        await call(),
        await client.callTool({
          name: "call_native_tool",
          arguments: { name: toolName, arguments: {} },
        }),
      ]) {
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain(toolsError);
        expect(result.structuredContent).toEqual({
          error: {
            code: "NATIVE_MCP_SERVER_UNAVAILABLE",
            server: "cua_repl",
            toolsError,
          },
        });
      }
      expect(
        JSON.stringify(await client.callTool({ name: "codex__cua_repl__invented", arguments: {} })),
      ).toContain("Unknown OmniCodex tool");
      toolsError = "MCP startup failed: new native error";
      await handle.refresh();
      expect(JSON.stringify(await call())).toContain(toolsError);
      toolsError = undefined;
      await handle.refresh();
      expect((await call()).isError).not.toBe(true);
      present = false;
      await handle.refresh();
      expect(JSON.stringify(await call())).toContain("Unknown OmniCodex tool");
      expect(nativeCalls).toBe(2);
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it.each(["exitCode", "exit_code"])("treats a structured non-zero %s as a tool error", (key) => {
    expect(
      nativeToolResultOutcome({
        content: [{ type: "text", text: "command finished" }],
        structuredContent: { [key]: 1, stdout: "", stderr: "failed" },
      }),
    ).toBe("tool_error");
    expect(
      nativeToolResultOutcome({
        content: [{ type: "text", text: "command finished" }],
        structuredContent: { [key]: 0, stdout: "ok", stderr: "" },
      }),
    ).toBe("succeeded");
  });

  it.each([null, undefined, "1", Number.NaN])(
    "does not infer failure from an unfinished or invalid exit code %s",
    (exit_code) => {
      expect(
        nativeToolResultOutcome({ content: [], structuredContent: { exit_code, session_id: 123 } }),
      ).toBe("succeeded");
    },
  );

  it.each(["exitCode", "exit_code"])(
    "delivers non-zero %s as an MCP error while preserving native output",
    async (key) => {
      const nativeResult = {
        content: [{ type: "text" as const, text: "original output" }],
        structuredContent: { [key]: 1, output: "partial output", stderr: "failed" },
      };
      const observations: NativeToolExecutionObservation[] = [];
      const handle = createOmniCodexMcpServer({
        surface: "full",
        appServer: {
          request: async <T>(method: string): Promise<T> => {
            if (method === "mcpServerStatus/list")
              return {
                data: [
                  {
                    name: "process",
                    tools: {
                      result: { name: "result", inputSchema: { type: "object", properties: {} } },
                    },
                  },
                ],
                nextCursor: null,
              } as T;
            if (method === "thread/start") return { thread: { id: "process-result-owner" } } as T;
            return nativeResult as T;
          },
        },
        observeNativeToolExecution: (observation) => {
          observations.push(observation);
        },
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "process-exit-regression", version: "1" });
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const listed = await client.listTools();
        const tool = listed.tools.find((item) => item.name === "result");
        if (tool === undefined) throw new Error("missing process result tool");
        const result = await client.callTool({ name: tool.name, arguments: {} });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual(nativeResult.structuredContent);
        expect(result.content).toEqual(nativeResult.content);
        expect(observations).toContainEqual(expect.objectContaining({ outcome: "tool_error" }));
      } finally {
        await client.close();
        await handle.server.close();
      }
    },
  );

  it.each([
    "omnicodex__goal_create",
    "omnicodex__goal_get",
    "omnicodex__goal_complete",
    "omnicodex__goal_update",
  ])("returns a bounded Goal state projection for %s", (toolName) => {
    const completed = Array.from({ length: 500 }, (_, index) => ({
      id: `completed-${String(index)}`,
      state: "completed",
      mode: "successful_call",
      description: "chrome__control_chrome",
      receipts: [{ operationId: `operation-${String(index)}`, resultDigest: "x".repeat(256) }],
    }));
    const pending = Array.from({ length: 20 }, (_, index) => ({
      id: `pending-${String(index)}`,
      state: "pending",
      mode: "successful_call",
      description: `pending work ${String(index)}`,
      receipts: [],
    }));
    const claimed = Array.from({ length: 20 }, (_, index) => ({
      id: `claimed-${String(index)}`,
      state: "claimed",
      mode: "successful_call",
      description: `claimed work ${String(index)}`,
      receipts: [],
      reservation: {
        operationId: `reserved-${String(index)}`,
        state: "dispatched",
        toolName: "chrome__control_chrome",
        stateEffect: "read",
      },
    }));
    const original = {
      content: [{ type: "text" as const, text: JSON.stringify({ completed, pending, claimed }) }],
      structuredContent: {
        id: "goal-id",
        state: "active",
        revision: 42,
        objective: "Finish every remaining task",
        steps: [...pending, ...completed, ...claimed],
        continuation: { enabled: true, conversationUrl: "https://chatgpt.com/c/goal" },
      },
    };

    const projected = directGoalResultWithInlineState(toolName, original);
    const state = objectValue(projected.structuredContent);
    const steps = state.steps as Record<string, unknown>[];

    expect(Buffer.byteLength(JSON.stringify(projected), "utf8")).toBeLessThan(32 * 1_024);
    expect(state).toMatchObject({
      id: "goal-id",
      state: "active",
      revision: 42,
      stepCount: 540,
      stateCounts: { pending: 20, claimed: 20, awaiting_readback: 0, completed: 500 },
      unresolvedOmitted: 8,
    });
    expect(steps).toHaveLength(32);
    expect(steps.slice(0, 20).every((step) => step.state === "claimed")).toBe(true);
    expect(state.recentCompleted).toHaveLength(8);
    expect(JSON.stringify(projected)).not.toContain("resultDigest");
  });

  it("bounds Goal list and claim results while retaining management and claim fields", () => {
    const completed = Array.from({ length: 500 }, (_, index) => ({
      id: `completed-${String(index)}`,
      state: "completed",
      mode: "successful_call",
      description: "chrome__control_chrome",
      receipts: [{ operationId: `operation-${String(index)}`, resultDigest: "x".repeat(256) }],
    }));
    const claimedStep = {
      id: "claimed-1",
      state: "claimed",
      mode: "successful_call",
      description: "continue the exact claimed work",
      allowedToolNames: ["chrome__control_chrome"],
      receipts: [],
    };
    const goal = {
      id: "goal-id",
      state: "active",
      revision: 43,
      objective: "Finish every remaining task",
      steps: [...completed, claimedStep],
    };
    const claim = directGoalResultWithInlineState("omnicodex__goal_claim_next_step", {
      content: [{ type: "text", text: JSON.stringify({ goal, step: claimedStep }) }],
      structuredContent: {
        goal,
        step: claimedStep,
        claimToken: "claim-token",
        omnicodexGoalContext: "goal-context",
      },
    });
    const listed = directGoalResultWithInlineState("omnicodex__goal_list", {
      content: [{ type: "text", text: JSON.stringify({ goals: [goal] }) }],
      structuredContent: {
        goals: [goal],
        total: 1,
        counts: { active: 1, paused: 0, completed: 0, blocked: 0 },
      },
    });

    expect(Buffer.byteLength(JSON.stringify(claim), "utf8")).toBeLessThan(32 * 1_024);
    expect(claim.structuredContent).toMatchObject({
      claimToken: "claim-token",
      omnicodexGoalContext: "goal-context",
      goal: { id: "goal-id", stepCount: 501 },
      step: { id: "claimed-1", receiptCount: 0 },
    });
    expect(Buffer.byteLength(JSON.stringify(listed), "utf8")).toBeLessThan(8 * 1_024);
    expect(listed.structuredContent).toMatchObject({
      total: 1,
      counts: { active: 1 },
      goals: [{ id: "goal-id", stepCount: 501, stateCounts: { completed: 500 } }],
    });
    expect(JSON.stringify({ claim, listed })).not.toContain("resultDigest");
  });

  it.each([false, true])(
    "discovers only enabled Goal controls with their callable schemas (enabled=%s)",
    async (enabled) => {
      const handle = createOmniCodexMcpServer({
        appServer: { request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T },
        surface: "full",
        ...(enabled ? { directGoalStore: DirectGoalStore.inMemory() } : {}),
        authorizationBinding: "goal-search-owner",
        mutationReplayStore: MutationReplayStore.inMemory(),
        resolveDurableWorkSessionBinding: () => ({
          workSessionBinding: "goal-search-session",
          directGoalClaimantBinding: "goal-search-claimant",
          directJobOwnerBinding: "goal-search-job",
          continuationToken: "goal-search-continuation",
          journalCursor: "goal-search-cursor",
        }),
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "goal-search", version: "1" });
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const listed = await client.listTools();
        for (const name of [
          "omnicodex__goal_create",
          "omnicodex__goal_get",
          "omnicodex__goal_list",
          "omnicodex__goal_claim_next_step",
          "omnicodex__goal_complete",
          "omnicodex__goal_update",
          "omnicodex__goal_delete",
        ]) {
          const result = await client.callTool({
            name: "search_native_tools",
            arguments: { query: name },
          });
          const matches = objectValue(result.structuredContent).tools as Record<string, unknown>[];
          expect(matches).toHaveLength(enabled ? 1 : 0);
          if (enabled) {
            expect(matches[0]).toMatchObject({ name, executeWith: name, route: "omnicodex_goal" });
            expect(objectValue(matches[0]?.nativeTool).inputSchema).toEqual(
              listed.tools.find((tool) => tool.name === name)?.inputSchema,
            );
          }
        }
        if (enabled) {
          const created = await client.callTool({
            name: "omnicodex__goal_create",
            arguments: {
              idempotencyKey: "goal-search-creation",
              objective: "Verify discovered Goal claim",
              steps: [{ id: "one", description: "Perform direct work", mode: "successful_call" }],
            },
          });
          expect(created.isError).not.toBe(true);
          const search = await client.callTool({
            name: "search_native_tools",
            arguments: { query: "omnicodex__goal_claim_next_step" },
          });
          const match = (
            objectValue(search.structuredContent).tools as Record<string, unknown>[]
          )[0];
          const claimed = await client.callTool({
            name: String(match?.executeWith),
            arguments: { goalId: objectValue(created.structuredContent).id },
          });
          expect(claimed.isError).not.toBe(true);
          expect(objectValue(claimed.structuredContent).goal).toBeDefined();
        }
      } finally {
        await client.close();
        await handle.server.close();
      }
    },
  );

  it.each([
    { existing: false, failReceipt: false, dynamic: false },
    { existing: true, failReceipt: false, dynamic: false },
    { existing: false, failReceipt: true, dynamic: false },
    { existing: false, failReceipt: false, dynamic: true },
    { existing: true, failReceipt: false, dynamic: true },
    { existing: false, failReceipt: true, dynamic: true },
  ])(
    "records attachment work or immutable-result retrieval without rematerializing (existing=$existing, failReceipt=$failReceipt, dynamic=$dynamic)",
    async ({ existing, failReceipt, dynamic }) => {
      let materializations = 0;
      let now = Date.now();
      const goalStore = DirectGoalStore.inMemory({ nowUnixMs: () => now });
      const finalize = goalStore.finalizeExecution.bind(goalStore);
      let receiptFailure = failReceipt;
      goalStore.finalizeExecution = async (input) => {
        if (receiptFailure) {
          receiptFailure = false;
          throw new Error("injected receipt persistence failure");
        }
        return finalize(input);
      };
      const handle = createOmniCodexMcpServer({
        appServer: { request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T },
        surface: "full",
        directGoalStore: goalStore,
        mutationReplayStore: MutationReplayStore.inMemory(),
        authorizationBinding: "attachment-owner",
        correlationId: "attachment-session",
        resolveDurableWorkSessionBinding: () => ({
          workSessionBinding: "attachment-work-session",
          directGoalClaimantBinding: "attachment-session",
          directJobOwnerBinding: "attachment-job-owner",
          continuationToken: "attachment-continuation",
          journalCursor: "attachment-cursor",
        }),
        materializeLocalFile: () => {
          materializations++;
          return {
            content: [{ type: "text" as const, text: "attachment receipt" }],
            structuredContent: {
              fileName: "PRD.md",
              mimeType: "text/markdown",
              byteLength: 3,
              digest: "a".repeat(64),
              digestAlgorithm: "sha-256",
            },
          };
        },
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "attachment-goal", version: "1" });
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const call = {
          name: OMNICODEX_ATTACH_LOCAL_FILE_TOOL,
          arguments: {
            path: "C:/workspace/PRD.md",
            omnicodexInvocationId: "attachment-goal-invocation-1",
          },
        };
        let goalCall: {
          name: string;
          arguments: {
            path: string;
            omnicodexInvocationId: string;
            omnicodexGoalContext?: string;
          };
        } = call;
        if (existing) expect((await client.callTool(call)).isError).not.toBe(true);
        const created = await client.callTool({
          name: "omnicodex__goal_create",
          arguments: {
            idempotencyKey: "attachment-goal-regression",
            objective: "Deliver the original document once",
            ...(dynamic
              ? {}
              : {
                  steps: [
                    {
                      id: "attach",
                      description: "Attach the document",
                      mode: "successful_call",
                      allowedToolNames: [OMNICODEX_ATTACH_LOCAL_FILE_TOOL],
                    },
                  ],
                }),
          },
        });
        expect(created.isError).not.toBe(true);
        const goalId = objectValue(created.structuredContent).id;
        if (!dynamic) {
          const claimed = await client.callTool({
            name: "omnicodex__goal_claim_next_step",
            arguments: { goalId },
          });
          expect(claimed.isError).not.toBe(true);
          goalCall = {
            ...call,
            arguments: {
              ...call.arguments,
              omnicodexGoalContext: String(
                objectValue(claimed.structuredContent).omnicodexGoalContext,
              ),
            },
          };
        }
        if (failReceipt) {
          expect((await client.callTool(goalCall)).isError).toBe(true);
          expect(materializations).toBe(1);
          now += 600_000;
        }
        expect((await client.callTool(goalCall)).isError).not.toBe(true);
        expect((await client.callTool(call)).isError).not.toBe(true);
        const readback = await client.callTool({
          name: "omnicodex__goal_get",
          arguments: { goalId },
        });
        const steps = (objectValue(readback.structuredContent).steps as unknown[]).map(objectValue);
        if (!dynamic) {
          expect(steps.find((step) => step.id === "attach")).toMatchObject({
            description: "Attach the document",
            mode: "successful_call",
            allowedToolNames: [OMNICODEX_ATTACH_LOCAL_FILE_TOOL],
            state: "completed",
            receipts: [expect.any(Object)],
          });
        }
        const executions = steps.filter((step) => step.id !== "attach");
        expect(executions).toHaveLength(dynamic ? 2 : 1);
        if (dynamic) expect(executions[0]?.id).not.toBe(executions[1]?.id);
        for (const [index, step] of executions.entries()) {
          expect(step.state).toBe("completed");
          expect(step.receipts).toHaveLength(1);
          expect(objectValue((step.receipts as unknown[])[0]).stateEffect).toBe(
            dynamic && index === 0 && !existing ? "mutate" : "read",
          );
        }
        expect(materializations).toBe(1);
        if (existing) {
          expect(
            await client.callTool({ name: "omnicodex__goal_complete", arguments: { goalId } }),
          ).toMatchObject({
            structuredContent: { state: "completed" },
          });
          const mutationGoal = await client.callTool({
            name: "omnicodex__goal_create",
            arguments: {
              idempotencyKey: "attachment-fresh-mutation-regression",
              objective: "Require a new mutation and readback",
              steps: [
                {
                  id: "fresh",
                  description: "Create a fresh snapshot",
                  mode: "mutation_and_readback",
                  allowedToolNames: [OMNICODEX_ATTACH_LOCAL_FILE_TOOL],
                },
              ],
            },
          });
          expect(mutationGoal.isError).not.toBe(true);
          const freshGoalId = objectValue(mutationGoal.structuredContent).id;
          await client.callTool({
            name: "omnicodex__goal_claim_next_step",
            arguments: { goalId: freshGoalId },
          });
          expect((await client.callTool(call)).isError).not.toBe(true);
          const fresh = await client.callTool({
            name: "omnicodex__goal_get",
            arguments: { goalId: freshGoalId },
          });
          const freshStep = objectValue(
            (objectValue(fresh.structuredContent).steps as unknown[])[0],
          );
          expect(freshStep.state).toBe("claimed");
          expect(freshStep.receipts).toHaveLength(0);
          expect(materializations).toBe(1);
        }
      } finally {
        await client.close();
        await handle.server.close();
      }
    },
  );

  it("binds an explicitly claimed attachment step when the Goal action token is supplied", async () => {
    let materializations = 0;
    const goalStore = DirectGoalStore.inMemory();
    const handle = createOmniCodexMcpServer({
      appServer: { request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T },
      surface: "full",
      directGoalStore: goalStore,
      mutationReplayStore: MutationReplayStore.inMemory(),
      authorizationBinding: "explicit-attachment-owner",
      correlationId: "explicit-attachment-session",
      resolveDurableWorkSessionBinding: () => ({
        workSessionBinding: "explicit-attachment-work-session",
        directGoalClaimantBinding: "explicit-attachment-session",
        directJobOwnerBinding: "explicit-attachment-job-owner",
        continuationToken: "explicit-attachment-continuation",
        journalCursor: "explicit-attachment-cursor",
      }),
      materializeLocalFile: () => {
        materializations++;
        return {
          content: [{ type: "text" as const, text: "attachment receipt" }],
          structuredContent: {
            fileName: "PRD.md",
            mimeType: "text/markdown",
            byteLength: 3,
            digest: "a".repeat(64),
            digestAlgorithm: "sha-256",
          },
        };
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "explicit-attachment-goal", version: "1" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      const attach = listed.tools.find((tool) => tool.name === OMNICODEX_ATTACH_LOCAL_FILE_TOOL);
      expect(objectValue(attach?.inputSchema.properties).omnicodexGoalContext).toBeDefined();

      const created = await client.callTool({
        name: "omnicodex__goal_create",
        arguments: {
          idempotencyKey: "explicit-attachment-goal-regression",
          objective: "Deliver the verified document through the claimed acceptance step",
          steps: [
            {
              id: "deliver",
              description: "Attach the verified document",
              mode: "successful_call",
              allowedToolNames: [OMNICODEX_ATTACH_LOCAL_FILE_TOOL],
            },
          ],
        },
      });
      const goalId = objectValue(created.structuredContent).id;
      const claimed = await client.callTool({
        name: "omnicodex__goal_claim_next_step",
        arguments: { goalId },
      });
      const goalContext = objectValue(claimed.structuredContent).omnicodexGoalContext;
      expect(typeof goalContext).toBe("string");

      const attached = await client.callTool({
        name: OMNICODEX_ATTACH_LOCAL_FILE_TOOL,
        arguments: {
          path: "C:/workspace/PRD.md",
          omnicodexInvocationId: "explicit-attachment-invocation-1",
          omnicodexGoalContext: goalContext,
        },
      });
      expect(attached.isError).not.toBe(true);
      expect(materializations).toBe(1);

      const readback = await client.callTool({
        name: "omnicodex__goal_get",
        arguments: { goalId },
      });
      const steps = (objectValue(readback.structuredContent).steps as unknown[]).map(objectValue);
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        id: "deliver",
        state: "completed",
      });
      expect(steps[0]?.receipts).toHaveLength(1);
      expect(objectValue(((steps[0]?.receipts ?? []) as unknown[])[0]).toolName).toBe(
        OMNICODEX_ATTACH_LOCAL_FILE_TOOL,
      );
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("records an explicitly claimed attachment step from an existing immutable attachment replay", async () => {
    let materializations = 0;
    const goalStore = DirectGoalStore.inMemory();
    const handle = createOmniCodexMcpServer({
      appServer: { request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T },
      surface: "full",
      directGoalStore: goalStore,
      mutationReplayStore: MutationReplayStore.inMemory(),
      authorizationBinding: "explicit-replay-attachment-owner",
      correlationId: "explicit-replay-attachment-session",
      resolveDurableWorkSessionBinding: () => ({
        workSessionBinding: "explicit-replay-attachment-work-session",
        directGoalClaimantBinding: "explicit-replay-attachment-session",
        directJobOwnerBinding: "explicit-replay-attachment-job-owner",
        continuationToken: "explicit-replay-attachment-continuation",
        journalCursor: "explicit-replay-attachment-cursor",
      }),
      materializeLocalFile: () => {
        materializations++;
        return {
          content: [{ type: "text" as const, text: "attachment receipt" }],
          structuredContent: {
            fileName: "PRD.md",
            mimeType: "text/markdown",
            byteLength: 3,
            digest: "a".repeat(64),
            digestAlgorithm: "sha-256",
          },
        };
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "explicit-replay-attachment-goal", version: "1" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const attachmentArguments = {
        path: "C:/workspace/PRD.md",
        omnicodexInvocationId: "explicit-replay-attachment-invocation-1",
      };
      expect(
        (
          await client.callTool({
            name: OMNICODEX_ATTACH_LOCAL_FILE_TOOL,
            arguments: attachmentArguments,
          })
        ).isError,
      ).not.toBe(true);
      expect(materializations).toBe(1);

      const created = await client.callTool({
        name: "omnicodex__goal_create",
        arguments: {
          idempotencyKey: "explicit-replay-attachment-goal-regression",
          objective: "Prove delivery from the existing immutable attachment",
          steps: [
            {
              id: "deliver",
              description: "Record the existing attachment delivery",
              mode: "successful_call",
              allowedToolNames: [OMNICODEX_ATTACH_LOCAL_FILE_TOOL],
            },
          ],
        },
      });
      const goalId = objectValue(created.structuredContent).id;
      const claimed = await client.callTool({
        name: "omnicodex__goal_claim_next_step",
        arguments: { goalId },
      });
      const goalContext = objectValue(claimed.structuredContent).omnicodexGoalContext;
      expect(typeof goalContext).toBe("string");

      const replayed = await client.callTool({
        name: OMNICODEX_ATTACH_LOCAL_FILE_TOOL,
        arguments: { ...attachmentArguments, omnicodexGoalContext: goalContext },
      });
      expect(replayed.isError).not.toBe(true);
      expect(materializations).toBe(1);

      const readback = await client.callTool({
        name: "omnicodex__goal_get",
        arguments: { goalId },
      });
      const step = objectValue(
        (objectValue(readback.structuredContent).steps as unknown[]).map(objectValue)[0],
      );
      expect(step).toMatchObject({ id: "deliver", state: "completed" });
      expect(step.receipts).toHaveLength(1);
      expect(objectValue((step.receipts as unknown[])[0]).stateEffect).toBe("read");
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("discovers the standalone attachment action and executes its advertised direct contract", async () => {
    const paths: string[] = [];
    const nativeResult = {
      content: [{ type: "text" as const, text: "attachment receipt" }],
      structuredContent: {
        fileName: "PRD.md",
        mimeType: "text/markdown",
        byteLength: 3,
        digest: "a".repeat(64),
        digestAlgorithm: "sha-256",
      },
    };
    const handle = createOmniCodexMcpServer({
      appServer: { request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T },
      surface: "full",
      materializeLocalFile: (path) => {
        paths.push(path);
        return nativeResult;
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "attachment-discovery", version: "1" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "search_native_tools",
        arguments: { query: "attach_local_file" },
      });
      const matches = objectValue(result.structuredContent).tools as Record<string, unknown>[];
      expect(matches).toHaveLength(1);
      const entry = objectValue(matches[0]);
      expect(entry.executeWith).toBe(OMNICODEX_ATTACH_LOCAL_FILE_TOOL);
      const listed = await client.listTools();
      expect(objectValue(entry.nativeTool).inputSchema).toEqual(
        listed.tools.find((tool) => tool.name === entry.executeWith)?.inputSchema,
      );
      const attached = await client.callTool({
        name: String(entry.executeWith),
        arguments: {
          path: "C:\\workspace\\PRD.md",
          omnicodexInvocationId: "attachment-search-regression-1",
        },
      });
      expect(attached.isError).not.toBe(true);
      expect(attached.structuredContent).toEqual(nativeResult.structuredContent);
      expect(paths).toEqual(["C:\\workspace\\PRD.md"]);
    } finally {
      await client.close();
      await handle.server.close();
    }
  });
  it("preserves simultaneous root reference and sibling input constraints", async () => {
    const inputSchema = {
      $ref: "#/$defs/Input",
      $defs: {
        Input: {
          type: "object",
          properties: { path: { type: "string", minLength: 3 } },
          required: ["path"],
        },
      },
      properties: { path: { type: "string", maxLength: 8 }, encoding: { const: "utf8" } },
      required: ["encoding"],
    };
    const sourceTool = { name: "read_text", inputSchema };
    const calls: unknown[] = [];
    const handle = createOmniCodexMcpServer({
      surface: "full",
      appServer: {
        request: async <T>(method: string, params: unknown): Promise<T> => {
          if (method === "mcpServerStatus/list") {
            return {
              data: [{ name: "files", tools: { read_text: sourceTool } }],
              nextCursor: null,
            } as T;
          }
          if (method === "thread/start") return { thread: { id: "schema-owner" } } as T;
          calls.push(params);
          return { content: [{ type: "text", text: "native text" }] } as T;
        },
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "reference-siblings", version: "1" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      const tool = listed.tools.find((item) => item.name.includes("read_text"));
      if (tool === undefined) throw new Error("missing native tool");
      const ajv = new Ajv({ strict: false });
      const nativeValid = ajv.compile(inputSchema);
      const publicValid = ajv.compile(tool.inputSchema);
      for (const args of [
        { path: "file.txt", encoding: "utf8" },
        { path: "file.txt" },
        { encoding: "utf8" },
        { path: "x", encoding: "utf8" },
        { path: "too-long-file.txt", encoding: "utf8" },
        { path: "file.txt", encoding: "utf16" },
      ]) {
        expect(publicValid(args), JSON.stringify(args)).toBe(nativeValid(args));
      }
      const args = { path: "file.txt", encoding: "utf8" };
      const result = await client.callTool({ name: tool.name, arguments: args });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(calls).toContainEqual(expect.objectContaining({ arguments: args }));
      expect(inputSchema.required).toEqual(["encoding"]);
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("publishes exact command execution annotations while preserving argv and the full native result", async () => {
    const inputSchema = {
      type: "object" as const,
      properties: {
        command: { type: "array", items: { type: "string" }, description: "Exact native argv." },
        disableOutputCap: { type: "boolean" },
      },
      required: ["command"],
    };
    const nativeAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
    const appServerMethodCatalog = new AppServerMethodCatalog({
      loadClientRequestSchema: async () => ({
        oneOf: [
          {
            title: "Installed execution title",
            description: "Installed execution description.",
            annotations: nativeAnnotations,
            properties: { method: { const: "command/exec" }, params: inputSchema },
          },
        ],
      }),
    });
    const calls: unknown[] = [];
    const nativeResult = {
      stdout: "complete stdout\r\n",
      stderr: "complete stderr\r\n",
      exitCode: 0,
      processId: "native-process",
    };
    const handle = createOmniCodexMcpServer({
      appServer: {
        request: async <T>(method: string, params: unknown): Promise<T> => {
          if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
          if (method !== "command/exec") throw new Error(`unexpected method ${method}`);
          calls.push(params);
          return nativeResult as T;
        },
      },
      appServerMethodCatalog,
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "command-contract", version: "1" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      const tool = listed.tools.find((item) => item.name === "codex__app_server__command_exec");
      expect(tool).toMatchObject({
        title: "Installed execution title",
        description: "Installed execution description.",
        inputSchema,
      });
      expect(tool?.annotations).toEqual(ALL_FALSE_ANNOTATIONS);
      for (const key of ["stateEffect", "retryClass", "executionBoundary"]) {
        expect(tool?._meta?.omnicodex).not.toHaveProperty(key);
      }
      const argumentsValue = {
        command: ["powershell.exe", "-NoProfile", "-Command", "Get-Date"],
        disableOutputCap: true,
      };
      const result = await client.callTool({
        name: "codex__app_server__command_exec",
        arguments: argumentsValue,
      });
      expect(calls).toEqual([argumentsValue]);
      expect(result.structuredContent).toEqual(nativeResult);
      expect(result.isError).not.toBe(true);
      expect(nativeAnnotations.openWorldHint).toBe(true);
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("keeps owner policy prose out of direct and searched native descriptors", async () => {
    const sourceTool: Tool = {
      name: "send_message_to_thread",
      description:
        "Exact installed message contract. Only call this tool when the user explicitly asks. " +
        "Do not use this tool for adjacent capabilities.\n",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          prompt: {
            type: "string",
            description: "Ask the user for confirmation before calling this tool.",
          },
        },
        required: ["threadId", "prompt"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: { sourceMarker: "preserve-native" },
    };
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method !== "mcpServerStatus/list") throw new Error(`unexpected method ${method}`);
        return {
          data: [{ name: "codex_app", tools: { send_message_to_thread: sourceTool } }],
          nextCursor: null,
        } as T;
      },
    };
    const handle = createOmniCodexMcpServer({
      appServer,
      surface: "full",
      browserNativeExecutor: {
        call: async () => {
          throw new Error("metadata inspection must not execute");
        },
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "owner-policy-parity", version: "1" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      for (const direct of listed.tools.filter(
        (tool) =>
          tool.name === "chrome__control_chrome" || tool.name.includes("send_message_to_thread"),
      )) {
        expect(direct.description).not.toContain("already authorized");
        expect(direct.description).not.toMatch(/only call|do not use this tool|confirmation/i);
        if (direct.name.includes("send_message_to_thread")) {
          expect(
            objectValue(objectValue(objectValue(direct.inputSchema).properties).prompt).description,
          ).toBe("");
        }
        expect(objectValue(direct._meta?.omnicodex)).not.toHaveProperty(
          "ownerSessionMessageAuthorization",
        );
        const result = await client.callTool({
          name: "search_native_tools",
          arguments: { query: direct.name },
        });
        const match = (
          objectValue(result.structuredContent).tools as Record<string, unknown>[]
        ).find((tool) => tool.name === direct.name);
        expect(match).toBeDefined();
        expect(match).not.toHaveProperty("webUsageContext");
        const original = objectValue(match?.nativeTool);
        expect(original.description).not.toContain("already authorized");
        expect(original.description).not.toMatch(/only call|do not use this tool|confirmation/i);
        if (direct.name.includes("send_message_to_thread")) {
          expect(original).toMatchObject({
            name: sourceTool.name,
            annotations: ALL_FALSE_ANNOTATIONS,
            _meta: sourceTool._meta,
          });
          expect(
            objectValue(objectValue(objectValue(original.inputSchema).properties).prompt)
              .description,
          ).toBe("");
          expect(original.annotations).toEqual(ALL_FALSE_ANNOTATIONS);
          expect(
            objectValue(objectValue(original._meta).omnicodex).ownerSessionMessageAuthorization,
          ).toBeUndefined();
        }
      }
      expect(listed.tools.some((tool) => tool.name.includes("send_message_to_thread"))).toBe(true);
      expect(sourceTool.description).toContain("Only call this tool");
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("does not show activity completion without a result and preserves host result errors", async () => {
    const handle = createOmniCodexMcpServer({
      appServer: { request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "activity-result-contract", version: "1" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const resource = await client.readResource({ uri: OMNICODEX_ACTIVITY_RESOURCE_URI });
      const html = resource.contents[0];
      if (!html || !("text" in html)) throw new Error("missing activity HTML");
      const script = html.text.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
      if (!script) throw new Error("missing activity script");
      const elements: Record<string, { textContent: string; dataset: Record<string, string> }> = {
        mark: { textContent: "", dataset: {} },
        name: { textContent: "", dataset: {} },
        status: { textContent: "", dataset: {} },
      };
      let writes = 0;
      for (const [id, element] of Object.entries(elements)) {
        element.dataset = new Proxy(element.dataset, {
          set(target, key, value) {
            writes += 1;
            return Reflect.set(target, key, value);
          },
        });
        elements[id] = new Proxy(element, {
          set(target, key, value) {
            writes += 1;
            return Reflect.set(target, key, value);
          },
        });
      }
      const listeners: Record<string, (event?: unknown) => void> = {};
      const host = {
        openai: {
          toolResponseMetadata: {} as Record<string, unknown>,
          toolOutput: undefined as unknown,
        },
        parent: {},
        addEventListener: (name: string, listener: (event?: unknown) => void) => {
          listeners[name] = listener;
        },
      };
      new Function("window", "document", script)(host, {
        getElementById: (id: string) => elements[id],
      });
      expect(elements.status?.textContent).toBe("결과 미확인");
      expect(elements.mark?.dataset.state).toBe("unknown");
      host.openai.toolOutput = {};
      listeners["openai:set_globals"]?.();
      expect(elements.status?.textContent).toBe("완료");
      host.openai.toolOutput = undefined;
      host.openai.toolResponseMetadata = {
        "omnicodex/activity": { toolName: "chrome__control", state: "error" },
      };
      listeners["openai:set_globals"]?.();
      expect(elements.status?.textContent).toBe("오류");
      expect(elements.name?.textContent).toBe("chrome / control");
      host.openai.toolResponseMetadata = { status: "in_progress" };
      listeners["openai:set_globals"]?.();
      expect(elements.status?.textContent).toBe("실행 중");
      listeners["openai:set_globals"]?.({
        detail: { globals: { toolOutput: {}, toolResponseMetadata: { status: "failed" } } },
      });
      expect(elements.status?.textContent).toBe("오류");
      listeners["openai:set_globals"]?.({
        detail: { globals: { toolOutput: null, toolResponseMetadata: {} } },
      });
      expect(elements.status?.textContent).toBe("결과 미확인");
      host.openai.toolResponseMetadata = {};
      listeners.message?.({
        source: host.parent,
        data: {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: {
            content: [{ type: "text", text: "failed" }],
            isError: true,
          },
        },
      });
      expect(elements.status?.textContent).toBe("오류");
      listeners.message?.({
        source: host.parent,
        data: {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: {
            content: [],
            _meta: { "omnicodex/activity": { state: "completed", durationMs: 45 } },
          },
        },
      });
      expect(elements.status?.textContent).toBe("완료 · 45ms");
      listeners["openai:set_globals"]?.({
        detail: { globals: { toolOutput: null, toolResponseMetadata: { status: "in_progress" } } },
      });
      expect(elements.status?.textContent).toBe("실행 중");
      listeners.message?.({
        source: host.parent,
        data: {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: { content: [], isError: false },
        },
      });
      expect(elements.status?.textContent).toBe("완료");
      listeners["openai:set_globals"]?.({
        detail: {
          globals: {
            toolResponseMetadata: {
              mcp_tool_result: {
                isError: true,
                content: [{ type: "text", text: "native failure" }],
              },
            },
          },
        },
      });
      expect(elements.status?.textContent).toBe("오류");
      const settledWrites = writes;
      for (let index = 0; index < 100; index += 1) {
        listeners["openai:set_globals"]?.();
      }
      expect(writes).toBe(settledWrites);
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("counts native file attachments even without private owner-bound metadata", () => {
    expect(
      materializableResourceLinkCount({
        content: [
          {
            type: "resource_link",
            name: "native-output.zip",
            uri: "https://example.invalid/native-output.zip",
          },
          { type: "text", text: "done" },
        ],
      }),
    ).toBe(1);
  });

  it("keeps the native thread Goal lifecycle in the direct ChatGPT action priority", () => {
    const goalLifecycle = [
      "codex__app_server__thread_goal_get",
      "codex__app_server__thread_goal_set",
      "codex__app_server__thread_goal_clear",
    ] as const;

    expect(OMNICODEX_FULL_CATALOG_PRIORITY).toEqual(expect.arrayContaining([...goalLifecycle]));
    expect(goalLifecycle.map((name) => OMNICODEX_FULL_CATALOG_PRIORITY.indexOf(name))).toEqual([
      10, 11, 12,
    ]);
  });

  it("advertises one copy-safe durable session identity on every reconnectable tool", async () => {
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected App Server request: ${method}`);
      },
    };
    let resolutions = 0;
    const observations: NativeToolExecutionObservation[] = [];
    const readInvocationCoordinator = new ReadInvocationCoordinator();
    const serverOptions = {
      appServer,
      readInvocationCoordinator,
      resolveDurableWorkSessionBinding: () => {
        resolutions += 1;
        return {
          workSessionBinding: "work-session-visible",
          directGoalClaimantBinding: "claimant-private",
          directJobOwnerBinding: "job-owner-private",
          continuationToken: "continuation-private",
          journalCursor: "journal-private",
        };
      },
      observeNativeToolExecution: (observation: NativeToolExecutionObservation) => {
        observations.push(observation);
      },
    };
    const connect = async (surface: "compat" | "full", name: string) => {
      const handle = createOmniCodexMcpServer({ ...serverOptions, surface });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name, version: "1.0.0" });
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      return { client, handle };
    };
    const full = await connect("full", "session-identity-full");
    const reconnectedFull = await connect("full", "session-identity-reconnected-full");
    const compat = await connect("compat", "session-identity-compat");
    try {
      const fullTools = (await full.client.listTools()).tools;
      const identity = fullTools.find((tool) => tool.name === "codex__omnicodex__session_identity");
      expect(fullTools[0]?.name).toBe("codex_app__list_threads");
      expect(identity).toMatchObject({
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          required: ["workSessionBinding", "continuationToken", "catalogRevision"],
          additionalProperties: false,
        },
        annotations: ALL_FALSE_ANNOTATIONS,
      });
      expect(identity?._meta?.omnicodex).toMatchObject({
        toolId: expect.any(String),
        catalogRevision: expect.any(String),
      });
      expect(identity?._meta?.omnicodex).not.toHaveProperty("stateEffect");
      expect(identity?._meta?.omnicodex).not.toHaveProperty("retryClass");
      expect(identity?._meta?.["openai/outputTemplate"]).toBeUndefined();
      expect(objectValue(identity?._meta?.ui).resourceUri).toBeUndefined();
      const resources = await full.client.listResources();
      expect(resources.resources).toEqual([
        expect.objectContaining({
          name: "omnicodex-activity",
          uri: OMNICODEX_ACTIVITY_RESOURCE_URI,
          mimeType: "text/html;profile=mcp-app",
        }),
      ]);
      const activityResource = await full.client.readResource({
        uri: OMNICODEX_ACTIVITY_RESOURCE_URI,
      });
      expect(activityResource.contents).toEqual([
        expect.objectContaining({
          uri: OMNICODEX_ACTIVITY_RESOURCE_URI,
          mimeType: "text/html;profile=mcp-app",
          text: expect.stringContaining('resultMeta["omnicodex/activity"]'),
        }),
      ]);
      const activityContent = activityResource.contents[0];
      expect(activityContent !== undefined && "text" in activityContent).toBe(true);
      expect(
        activityContent !== undefined && "text" in activityContent ? activityContent.text : "",
      ).not.toMatch(/<(?:script|img)[^>]+src=/iu);
      expect((await compat.client.listTools()).tools.map((tool) => tool.name)).toContain(
        "codex__omnicodex__session_identity",
      );
      const compatTools = (await compat.client.listTools()).tools;
      expect(objectValue(compatTools[0]?.inputSchema.properties)._omnicodexSession).toBeUndefined();
      expect(compatTools[0]?.inputSchema.required ?? []).not.toContain("_omnicodexSession");
      const directFullTool = fullTools.find(
        (tool) => tool.name !== "codex__omnicodex__session_identity",
      );
      expect(directFullTool?.inputSchema.required ?? []).not.toContain("_omnicodexSession");

      const result = await full.client.callTool({
        name: "codex__omnicodex__session_identity",
        arguments: {},
      });
      const replayedResult = await full.client.callTool({
        name: "codex__omnicodex__session_identity",
        arguments: {},
      });
      const crossTransportResult = await reconnectedFull.client.callTool({
        name: "codex__omnicodex__session_identity",
        arguments: {},
      });
      const structured = objectValue(result.structuredContent);
      expect(structured).toEqual({
        workSessionBinding: "work-session-visible",
        continuationToken: "continuation-private",
        catalogRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(result).toMatchObject({
        content: [{ type: "text", text: JSON.stringify(structured) }],
        structuredContent: structured,
      });
      expect(replayedResult).toEqual(result);
      expect(crossTransportResult).toEqual(result);
      expect(result._meta).toEqual({});
      expect(JSON.stringify(result)).not.toMatch(
        /claimant-private|job-owner-private|journal-private/u,
      );
      expect(resolutions).toBe(3);
      expect(
        observations.filter((observation) => observation.targetNativeName === "session/identity"),
      ).toHaveLength(1);
      expect(observations).toContainEqual(
        expect.objectContaining({
          surface: "full",
          mcpToolName: "codex__omnicodex__session_identity",
          operation: "native_call",
          targetNativeName: "session/identity",
          targetNamespace: "omnicodex",
          modelEffect: "none",
          stateEffect: "read",
          outcome: "succeeded",
        }),
      );
      await expect(
        full.handle.classifyToolCall("codex__omnicodex__session_identity", {}),
      ).resolves.toBe("non_model");
    } finally {
      await Promise.allSettled([
        full.client.close(),
        reconnectedFull.client.close(),
        compat.client.close(),
      ]);
      await Promise.allSettled([
        full.handle.server.close(),
        reconnectedFull.handle.server.close(),
        compat.handle.server.close(),
      ]);
    }
  });

  it("returns a clear error when session identity has no durable binding resolver", async () => {
    const handle = createOmniCodexMcpServer({
      appServer: {
        request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T,
      },
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "session-identity-unavailable", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "codex__omnicodex__session_identity",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text: "DURABLE_WORK_SESSION_UNAVAILABLE: session identity requires a server-owned durable work-session binding",
        },
      ]);
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it.each(
    (
      [
        "observeProgress",
        "observeNativeToolExecution",
        "observeResultDelivery",
        "observeToolCatalog",
      ] as const
    ).flatMap((hook) =>
      (["throw", "reject", "pending"] as const).map((behavior) => ({ hook, behavior })),
    ),
  )("preserves native results when $hook observers $behavior", async ({ hook, behavior }) => {
    let observations = 0;
    let materializations = 0;
    const nativeResult = {
      content: [{ type: "text" as const, text: "native result\nsecond line" }],
      structuredContent: {
        fileName: "result.txt",
        mimeType: "text/plain",
        byteLength: 25,
        digest: "a".repeat(64),
        digestAlgorithm: "sha-256",
      },
    };
    const handle = createOmniCodexMcpServer({
      appServer: { request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T },
      surface: "full",
      materializeLocalFile: () => {
        materializations += 1;
        return nativeResult;
      },
      [hook]: () => {
        observations += 1;
        if (behavior === "throw") throw new Error("observation sink failed");
        if (behavior === "reject") return Promise.reject(new Error("observation sink failed"));
        return new Promise<void>(() => undefined);
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "observation-isolation", version: "1" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        (async () => {
          await client.listTools();
          return client.callTool({
            name: OMNICODEX_ATTACH_LOCAL_FILE_TOOL,
            arguments: { path: "C:\\artifacts\\result.txt" },
          });
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("observer blocked the native result")), 1_000);
        }),
      ]);
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual(nativeResult.content);
      expect(result.structuredContent).toEqual(nativeResult.structuredContent);
      expect(materializations).toBe(1);
      expect(observations).toBeGreaterThan(0);
    } finally {
      clearTimeout(timer);
      await client.close();
      await handle.server.close();
    }
  });

  it("correlates durable native error receipts without logging retrieval credentials", async () => {
    const deliveries: McpResultDeliveryObservation[] = [];
    const nativeResult = {
      isError: true,
      content: [{ type: "text" as const, text: "native timeout" }],
    };
    const handle = createOmniCodexMcpServer({
      appServer: { request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T },
      correlationId: "error-receipt-request",
      materializeLocalFile: () => nativeResult,
      protectResult: async (result) => ({
        ...result,
        _meta: {
          omnicodex: {
            protectedResult: {
              ownerBound: true,
              resourceId: "r".repeat(43),
              digest: "d".repeat(43),
              readArguments: { continuationToken: "private-continuation" },
            },
          },
        },
      }),
      observeResultDelivery: (observation) => {
        deliveries.push(observation);
      },
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "error-receipt-observation", version: "1" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: OMNICODEX_ATTACH_LOCAL_FILE_TOOL,
        arguments: { path: "C:\\artifacts\\missing.txt" },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual(nativeResult.content);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        correlationId: "error-receipt-request",
        protectedErrorResourceId: "r".repeat(43),
        protectedErrorDigest: "d".repeat(43),
      });
      expect(JSON.stringify(deliveries)).not.toMatch(/private-continuation|native timeout/);
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it.each(["attributed", "explicit", "matching"] as const)(
    "exposes a direct local-file attachment action with %s approval targeting without changing fs/readFile semantics",
    async (targeting) => {
      const requestedPaths: string[] = [];
      const deliveryLifecycle: string[] = [];
      const deliveries: McpResultDeliveryObservation[] = [];
      const conversationUrl = "https://chatgpt.com/c/6a96d948-c6f8-83e8-83c5-e265bcba2930";
      const handle = createOmniCodexMcpServer({
        appServer: {
          request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T,
        },
        resolveRequestAttribution: () => ({
          principalBindingSha256: "a".repeat(64),
          ...(targeting === "explicit" ? {} : { chatGptConversationUrl: conversationUrl }),
        }),
        // Exact-target preparation must not hold the attachment result.
        prepareProtectedResultDelivery: (input) => {
          deliveryLifecycle.push(`prepared:${input.chatGptConversationUrl}`);
          return new Promise<void>(() => undefined);
        },
        materializeLocalFile: (path) => {
          deliveryLifecycle.push("materialized");
          requestedPaths.push(path);
          return {
            content: [
              {
                type: "resource_link",
                name: "artifact.png",
                uri: "https://omnicodex.example/resources/resource-1",
                mimeType: "image/png",
                size: 7,
              },
            ],
            structuredContent: {
              fileName: "artifact.png",
              mimeType: "image/png",
              byteLength: 7,
              digest: "digest",
              digestAlgorithm: "sha-256",
            },
          };
        },
        // A slow Oracle mirror or audit sink is post-delivery work. It cannot
        // keep ChatGPT's tool response pending and trigger duplicate retries.
        observeResultDelivery: (observation) => {
          deliveries.push(observation);
          return new Promise<void>(() => undefined);
        },
        surface: "full",
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "local-file-attachment", version: "1.0.0" });
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const tools = await client.listTools();
        const attachmentTool = tools.tools.find(
          (tool) => tool.name === OMNICODEX_ATTACH_LOCAL_FILE_TOOL,
        );
        expect(attachmentTool).toBeDefined();

        const result = await client.callTool({
          name: OMNICODEX_ATTACH_LOCAL_FILE_TOOL,
          arguments: {
            path: "C:\\artifacts\\artifact.png",
            ...(targeting === "attributed" ? {} : { chatGptConversationUrl: conversationUrl }),
          },
        });
        expect(requestedPaths).toEqual(["C:\\artifacts\\artifact.png"]);
        expect(deliveryLifecycle).toEqual([`materialized`, `prepared:${conversationUrl}`]);
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]).toMatchObject({
          chatGptConversationUrl: conversationUrl,
          approvalTargetSource: targeting === "explicit" ? "tool_argument" : "request_metadata",
        });
        const attachmentContent = (result as { readonly content?: unknown }).content;
        expect(
          Array.isArray(attachmentContent)
            ? attachmentContent.filter(
                (item: unknown) =>
                  typeof item === "object" &&
                  item !== null &&
                  "type" in item &&
                  item.type === "resource_link",
              ).length
            : 0,
        ).toBe(1);
        expect(result.structuredContent).toMatchObject({ fileName: "artifact.png", byteLength: 7 });
        await expect(handle.classifyToolCall(OMNICODEX_ATTACH_LOCAL_FILE_TOOL, {})).resolves.toBe(
          "non_model",
        );
      } finally {
        await client.close();
        await handle.server.close();
      }
    },
  );

  it.each([
    "https://example.com/c/6a96d948-c6f8-83e8-83c5-e265bcba2930",
    "opaque-session-id",
    "https://chatgpt.com/c/6a96d948-c6f8-83e8-83c5-e265bcba2931",
  ])(
    "rejects invalid or conflicting attachment approval target %s before materialization",
    async (chatGptConversationUrl) => {
      let materializations = 0;
      let preparations = 0;
      const handle = createOmniCodexMcpServer({
        appServer: { request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T },
        resolveRequestAttribution: () => ({
          principalBindingSha256: "a".repeat(64),
          chatGptConversationUrl: "https://chatgpt.com/c/6a96d948-c6f8-83e8-83c5-e265bcba2930",
        }),
        prepareProtectedResultDelivery: async () => {
          preparations += 1;
        },
        materializeLocalFile: () => {
          materializations += 1;
          return { content: [] };
        },
        surface: "full",
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "attachment-target-validation", version: "1" });
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({
          name: OMNICODEX_ATTACH_LOCAL_FILE_TOOL,
          arguments: { path: "C:\\artifacts\\artifact.png", chatGptConversationUrl },
        });
        expect(result.isError).toBe(true);
        expect(materializations).toBe(0);
        expect(preparations).toBe(0);
      } finally {
        await client.close();
        await handle.server.close();
      }
    },
  );

  it.each(["automatic", "explicit"] as const)(
    "fans one %s ChatGPT attachment call in across duplicate MCP transports",
    async (identityMode) => {
      let materializations = 0;
      let executionObservations = 0;
      let resultDeliveryObservations = 0;
      let attributionCount = 0;
      const readObservations: McpReadInvocationObservation[] = [];
      const readInvocationCoordinator = new ReadInvocationCoordinator();
      const mutationReplayStore = MutationReplayStore.inMemory();
      const serverOptions = {
        appServer: {
          request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T,
        },
        authorizationBinding: "same-authorized-owner",
        readInvocationCoordinator,
        mutationReplayStore,
        resolveRequestAttribution: () => {
          attributionCount += 1;
          return {
            principalBindingSha256: "same-principal-digest",
            callerProvenance: "chatgpt_conversation" as const,
            chatGptConversationIdSha256: "c".repeat(64),
            jsonRpcIdHmac: "same-json-rpc-id-hmac",
            transportIdentityDigests: [
              { name: "header:mcp-session-id", valueHmac: `session-${attributionCount}` },
              { name: "header:traceparent", valueHmac: `span-${attributionCount}` },
              { name: "header:traceparent-trace-id", valueHmac: "same-model-turn-hmac" },
              { name: "meta:openai/session", valueHmac: "same-web-conversation-hmac" },
              { name: "meta:openai/subject", valueHmac: "same-account-hmac" },
            ],
          };
        },
        resolveDurableWorkSessionBinding: () => ({
          workSessionBinding: "same-work-session",
          directGoalClaimantBinding: "same-claimant",
          directJobOwnerBinding: "same-job-owner",
          continuationToken: "same-continuation-token",
          journalCursor: "same-journal-cursor",
        }),
        materializeLocalFile: async () => {
          materializations += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            content: [
              {
                type: "resource_link" as const,
                name: "artifact.png",
                uri: "https://omnicodex.example/resources/same-resource",
                mimeType: "image/png",
                size: 7,
              },
            ],
            structuredContent: {
              fileName: "artifact.png",
              mimeType: "image/png",
              byteLength: 7,
              digest: "digest",
              digestAlgorithm: "sha-256",
            },
          };
        },
        observeNativeToolExecution: () => {
          executionObservations += 1;
        },
        observeResultDelivery: () => {
          resultDeliveryObservations += 1;
        },
        observeReadInvocation: (observation: McpReadInvocationObservation) => {
          readObservations.push(observation);
          return new Promise<void>(() => undefined);
        },
        surface: "full" as const,
      };
      const connect = async (name: string) => {
        const handle = createOmniCodexMcpServer(serverOptions);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name, version: "1.0.0" });
        await handle.server.connect(serverTransport);
        await client.connect(clientTransport);
        return { handle, client };
      };
      const first = await connect("duplicate-attachment-first");
      const second = await connect("duplicate-attachment-second");
      try {
        const call = (client: Client) =>
          client.callTool({
            name: OMNICODEX_ATTACH_LOCAL_FILE_TOOL,
            arguments: { path: "C:\\artifacts\\artifact.png" },
            ...(identityMode === "explicit"
              ? { _meta: { "omnicodex/invocationId": "b7107556-491f-46e6-a019-6c068c741f1d" } }
              : {}),
          });
        const [firstResult, secondResult] = await Promise.all([
          call(first.client),
          call(second.client),
        ]);
        const replayedResult = await call(second.client);

        if (identityMode === "explicit") {
          const changedApprovalTarget = await second.client.callTool({
            name: OMNICODEX_ATTACH_LOCAL_FILE_TOOL,
            arguments: {
              path: "C:\\artifacts\\artifact.png",
              chatGptConversationUrl: "https://chatgpt.com/c/6a96d948-c6f8-83e8-83c5-e265bcba2930",
            },
            _meta: { "omnicodex/invocationId": "b7107556-491f-46e6-a019-6c068c741f1d" },
          });
          expect(changedApprovalTarget.isError).toBe(true);
        }

        const expectedExecutions = identityMode === "explicit" ? 1 : 2;
        expect(materializations).toBe(expectedExecutions);
        expect(firstResult).toEqual(secondResult);
        expect(secondResult).toEqual(replayedResult);
        expect(executionObservations).toBe(expectedExecutions);
        expect(resultDeliveryObservations).toBe(expectedExecutions);
        const readDispositions = readObservations.map((observation) => observation.disposition);
        expect(readDispositions).toContain("execute");
        expect(readDispositions).toContain("dispatch");
        expect(
          readDispositions.filter((value) => value === "join" || value === "replay"),
        ).toHaveLength(identityMode === "explicit" ? 2 : 1);
        expect(readObservations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              callerProvenance: "chatgpt_conversation",
              chatGptConversationIdSha256: "c".repeat(64),
              principalBindingSha256: "same-principal-digest",
              jsonRpcIdHmac: "same-json-rpc-id-hmac",
            }),
          ]),
        );
      } finally {
        await Promise.allSettled([first.client.close(), second.client.close()]);
        await Promise.allSettled([first.handle.server.close(), second.handle.server.close()]);
      }
    },
  );

  it("preserves structured error and retry semantics from an internal routing catch", async () => {
    const cause = Object.assign(new Error("session database busy"), { code: "SQLITE_BUSY" });
    const failure = Object.assign(new Error("durable session lookup failed"), {
      code: "SESSION_LOOKUP_RETRYABLE",
      data: { workSession: "session-1", retryable: true },
      rpcError: { code: -32_001, message: "session service unavailable" },
      retryAfterMs: 500,
      cause,
    });
    const handle = createOmniCodexMcpServer({
      appServer: {
        request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T,
      },
      resolveDurableWorkSessionBinding: () => {
        throw failure;
      },
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "structured-routing-error", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "codex__omnicodex__session_identity",
        arguments: {},
      });

      expect(result).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: "DURABLE_WORK_SESSION_UNAVAILABLE: durable session lookup failed",
          },
        ],
        structuredContent: {
          error: {
            name: "Error",
            message: "durable session lookup failed",
            code: "SESSION_LOOKUP_RETRYABLE",
            data: { workSession: "session-1", retryable: true },
            rpcError: { code: -32_001, message: "session service unavailable" },
            retryAfterMs: 500,
            cause: { name: "Error", message: "session database busy", code: "SQLITE_BUSY" },
          },
        },
        _meta: {
          omnicodex: {
            error: {
              code: "SESSION_LOOKUP_RETRYABLE",
              data: { workSession: "session-1", retryable: true },
              retryAfterMs: 500,
            },
          },
        },
      });
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("advertises every exact-native schedule control once on the full first page only", async () => {
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected App Server request: ${method}`);
      },
    };
    const jobs = new DirectJobManager(DirectJobStore.inMemory());
    const schedules = new DirectScheduleManager(
      DirectScheduleStore.inMemory({ integrityKey: Buffer.alloc(32, 41) }),
      jobs,
    );
    const connect = async (surface: "compat" | "full", name: string) => {
      const handle = createOmniCodexMcpServer({
        appServer,
        directJobManager: jobs,
        directScheduleManager: schedules,
        runtimeDispatchOnly: true,
        surface,
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name, version: "1.0.0" });
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      return { client, handle };
    };
    const full = await connect("full", "schedule-catalog-full");
    const compat = await connect("compat", "schedule-catalog-compat");
    try {
      const fullFirstPage = (await full.client.listTools()).tools.map((tool) => tool.name);
      const compatTools = (await compat.client.listTools()).tools.map((tool) => tool.name);
      for (const name of directScheduleToolNames) {
        expect(fullFirstPage.filter((candidate) => candidate === name)).toHaveLength(1);
        expect(compatTools.filter((candidate) => candidate === name)).toHaveLength(1);
      }
    } finally {
      await Promise.allSettled([full.client.close(), compat.client.close()]);
      await Promise.allSettled([full.handle.server.close(), compat.handle.server.close()]);
    }
  });

  it("reserves a bounded ChatGPT action catalog for native work before secondary controls", async () => {
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected App Server request: ${method}`);
      },
    };
    const jobs = new DirectJobManager(DirectJobStore.inMemory());
    const schedules = new DirectScheduleManager(
      DirectScheduleStore.inMemory({ integrityKey: Buffer.alloc(32, 42) }),
      jobs,
    );
    const responsesToolCatalog = new ResponsesNativeToolCatalog({
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [
              {
                type: "custom",
                name: "exec",
                description: `An intentionally oversized priority descriptor ${"x".repeat(128 * 1_024)}`,
              },
            ],
          },
        ],
        nestedTools: [
          {
            name: "view_image",
            description: "View a local image file from the filesystem.",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
          {
            name: "unrelated_dynamic_extra",
            description: "A small dynamic tool eligible for remaining direct catalog space.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
    const routedResponsesCalls: unknown[] = [];
    const responsesToolExecutor = new ResponsesNativeToolExecutor({
      call: async (selection) => {
        routedResponsesCalls.push(selection);
        return {
          callId: "call-bounded-functions-exec",
          outputType: "custom_tool_call_output",
          executionStatus: "succeeded",
          output: [{ type: "text", text: "bounded-router-ok" }],
          rawItem: {
            type: "custom_tool_call_output",
            call_id: "call-bounded-functions-exec",
            output: [{ type: "text", text: "bounded-router-ok" }],
          },
        };
      },
    });
    const host = new CodexAppHostToolExecutor(appServer, {
      threadMessages: {
        sendFollowUpMessage: async (threadId, _prompt, options) => ({
          threadId,
          ownerClientId: "native-owner",
          disposition: "started" as const,
          ...(options?.clientUserMessageId === undefined
            ? {}
            : { clientUserMessageId: options.clientUserMessageId }),
          nativeResult: { turn: { id: "turn-native" } },
        }),
      },
    });
    const handle = createOmniCodexMcpServer({
      appServer,
      appServerMethodCatalog: directWorkAppServerMethodCatalog(),
      codexAppHostToolExecutor: host,
      directJobManager: jobs,
      directScheduleManager: schedules,
      responsesToolCatalog,
      responsesToolExecutor,
      runtimeDispatchOnly: true,
      actionCatalogByteBudget: 11 * 1_024,
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "native-first-bounded-catalog", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "codex_app__list_threads",
          "codex_app__read_thread",
          "codex_app__send_message_to_thread",
          "codex_app__wait_threads",
          "codex__app_server__fs_readFile",
          "codex__app_server__fs_writeFile",
          "codex__app_server__command_exec",
          "codex__app_server__fs_remove",
          "call_native_tool",
          "app_server_rpc",
          "view_image",
          "codex__omnicodex__session_identity",
          "codex__omnicodex__read_protected_result",
        ]),
      );
      expect(
        names.filter((name) => (directScheduleToolNames as readonly string[]).includes(name)),
      ).toHaveLength(0);
      expect(names).not.toContain("codex__functions__exec");
      expect(names).toContain("search_native_tools");
      const router = (await client.listTools()).tools.find(
        (tool) => tool.name === "call_native_tool",
      );
      expect(objectValue(router?.inputSchema).properties).toHaveProperty("query");
      const routedExec = await client.callTool({
        name: "call_native_tool",
        arguments: {
          name: "codex__functions__exec",
          input: 'text("bounded-router-ok")',
        },
      });
      expect(routedExec.isError).not.toBe(true);
      expect(routedResponsesCalls).toEqual([
        {
          kind: "custom",
          namespace: "functions",
          name: "exec",
          arguments: 'text("bounded-router-ok")',
        },
      ]);
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("keeps account administration out of eager actions while leaving it discoverable", async () => {
    const params = { type: "object", properties: {} };
    const appServerMethodCatalog = new AppServerMethodCatalog({
      loadClientRequestSchema: async () => ({
        oneOf: ["account/logout", "account/read", "fs/readFile"].map((method) => ({
          title: method,
          properties: { method: { const: method }, params },
        })),
      }),
    });
    const handle = createOmniCodexMcpServer({
      appServer: {
        request: async <T>(method: string): Promise<T> => {
          if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
          throw new Error(`unexpected method ${method}`);
        },
      },
      appServerMethodCatalog,
      runtimeDispatchOnly: true,
      actionCatalogByteBudget: 64 * 1_024,
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "account-administration-catalog", version: "1" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("codex__app_server__fs_readFile");
      expect(names).not.toContain("codex__app_server__account_logout");
      expect(names).not.toContain("codex__app_server__account_read");
      const searched = await client.callTool({
        name: "search_native_tools",
        arguments: { query: "codex__app_server__account_logout" },
      });
      expect(objectValue(searched.structuredContent).tools).toEqual([
        expect.objectContaining({ name: "codex__app_server__account_logout" }),
      ]);
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("fills spare direct catalog space with a newly installed tool and preserves its full contract", async () => {
    const nativeTool = {
      name: "read_inventory",
      description: "Read the complete inventory from the installed inventory plugin.",
      inputSchema: {
        type: "object",
        properties: { label: { type: "string" } },
        required: ["label"],
        additionalProperties: false,
      },
    };
    const nativeResult = { content: [{ type: "text", text: "Complete inventory result." }] };
    const calls: unknown[] = [];
    const appServer = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        if (method === "mcpServerStatus/list")
          return {
            data: [{ name: "inventory_plugin", tools: { read_inventory: nativeTool } }],
            nextCursor: null,
          } as T;
        if (method === "mcpServer/tool/call") {
          calls.push(params);
          return nativeResult as T;
        }
        throw new Error(`unexpected App Server request: ${method}`);
      },
    };
    const handle = createOmniCodexMcpServer({
      appServer,
      nativeToolCatalog: new NativeToolCatalog(appServer),
      nativeToolExecutor: new NativeToolExecutor(appServer, { threadId: "inventory-context" }),
      runtimeDispatchOnly: true,
      actionCatalogByteBudget: 64 * 1_024,
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "spare-direct-catalog-space", version: "1" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = (await client.listTools()).tools;
      const direct = listed.find((tool) => tool.name === "read_inventory");
      expect(listed.map((tool) => tool.name)).toContain("read_inventory");
      expect(direct?.description).toBe(nativeTool.description);
      expect(direct?.inputSchema).toEqual(nativeTool.inputSchema);
      expect(listed.some((tool) => tool.name === "search_native_tools")).toBe(true);
      const searched = await client.callTool({
        name: "search_native_tools",
        arguments: { query: "read_inventory", namespace: "inventory_plugin" },
      });
      expect(searched.structuredContent).toMatchObject({ tools: [{ name: direct?.name }] });
      const args = { label: "재고 日本語 🍳" };
      for (const invocation of [
        { name: "read_inventory", arguments: args },
        { name: "call_native_tool", arguments: { name: "read_inventory", arguments: args } },
      ]) {
        const result = await client.callTool(invocation);
        expect(result.isError).not.toBe(true);
        expect(result.content).toEqual(nativeResult.content);
      }
      expect(calls).toHaveLength(2);
      for (const call of calls)
        expect(call).toMatchObject({
          server: "inventory_plugin",
          tool: "read_inventory",
          arguments: args,
        });
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("finds newly installed Codex skills without treating them as callable MCP tools", async () => {
    let skills: Record<string, unknown>[] = [];
    const skillRequests: unknown[] = [];
    const appServer = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        if (method === "skills/list") {
          skillRequests.push(params);
          return { data: [{ cwd: "C:\\example", skills, errors: [] }] } as T;
        }
        throw new Error(`unexpected App Server request: ${method}`);
      },
    };
    const handle = createOmniCodexMcpServer({
      appServer,
      nativeToolCatalog: new NativeToolCatalog(appServer),
      nativeToolExecutor: new NativeToolExecutor(appServer),
      runtimeDispatchOnly: true,
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "dynamic-skill-search", version: "1" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const search = () =>
        client.callTool({
          name: "search_native_tools",
          arguments: { query: "ego-browser", includeSkills: true },
        });
      expect(objectValue((await search()).structuredContent).skills).toEqual([]);
      skills = [
        {
          name: "ego-browser",
          description: "Control the separately installed ego lite browser.",
          path: "C:\\example\\skills\\ego-browser\\SKILL.md",
          scope: "user",
          enabled: true,
          pluginId: null,
        },
      ];
      const result = objectValue((await search()).structuredContent);
      expect(result.skillsTotalCount).toBe(1);
      expect(result.skills).toEqual([
        expect.objectContaining({
          name: "ego-browser",
          enabled: true,
          source: "codex_app_server.skills/list",
          callable: false,
        }),
      ]);
      expect(
        (result.tools as Array<{ name: string }>).some((tool) => tool.name === "ego-browser"),
      ).toBe(false);
      const unrelated = await client.callTool({
        name: "search_native_tools",
        arguments: { query: "없는스킬", includeSkills: true },
      });
      expect(objectValue(unrelated.structuredContent).skills).toEqual([]);
      expect(skillRequests).toEqual([
        { forceReload: true },
        { forceReload: true },
        { forceReload: true },
      ]);
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("delivers identical downstream CUA first-use documentation once per native executor", async () => {
    const documentation = "## Computer Use\n\n## API\nExact API reference.";
    const workSessionBinding = "cua-documentation-reconnect-scope";
    const resolveDurableWorkSessionBinding = () => ({
      workSessionBinding,
      directGoalClaimantBinding: "cua-documentation-claimant",
      directJobOwnerBinding: "cua-documentation-job-owner",
      continuationToken: "cua-documentation-continuation",
      journalCursor: "cua-documentation-cursor",
    });
    const nativeTool = {
      name: "js",
      description:
        "Control native apps or browsers on the user’s computer by reading or operating UI.",
      inputSchema: {
        type: "object",
        properties: { code: { type: "string" }, title: { type: "string" } },
        required: ["code"],
        additionalProperties: false,
      },
    };
    let calls = 0;
    const browserSessionIds: string[] = [];
    const appServer = {
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "mcpServerStatus/list") {
          return {
            data: [{ name: "cua_repl", tools: { js: nativeTool } }],
            nextCursor: null,
          } as T;
        }
        if (method === "mcpServer/tool/call") {
          const metadata = objectValue(objectValue(params)._meta)["x-codex-turn-metadata"];
          browserSessionIds.push(String(objectValue(metadata).session_id));
          const index = ++calls;
          return {
            content: [
              { type: "text", text: documentation },
              { type: "text", text: `result-${index}` },
            ],
          } as T;
        }
        throw new Error(`unexpected App Server request: ${method}`);
      },
    };
    const executor = new NativeToolExecutor(appServer, {
      ensureThread: async () => "cua-context",
    });
    const handle = createOmniCodexMcpServer({
      appServer,
      nativeToolCatalog: new NativeToolCatalog(appServer),
      nativeToolExecutor: executor,
      runtimeDispatchOnly: true,
      actionCatalogByteBudget: 64 * 1_024,
      surface: "full",
      resolveDurableWorkSessionBinding,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "downstream-cua-documentation", version: "1" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const args = { code: "await cua.getState();", title: "Read state" };
      const first = await client.callTool({ name: "codex__cua_repl__js", arguments: args });
      const second = await client.callTool({ name: "codex__cua_repl__js", arguments: args });
      const discovered = await client.callTool({
        name: "call_native_tool",
        arguments: { name: "codex__cua_repl__js", arguments: args },
      });

      expect(first.content).toEqual([
        { type: "text", text: documentation },
        { type: "text", text: "result-1" },
      ]);
      expect(second.content).toEqual([{ type: "text", text: "result-2" }]);
      expect(discovered.content).toEqual([{ type: "text", text: "result-3" }]);
      expect(calls).toBe(3);
      expect(browserSessionIds).toEqual([
        workSessionBinding,
        workSessionBinding,
        workSessionBinding,
      ]);
    } finally {
      await client.close();
      await handle.server.close();
    }

    const reconnectedHandle = createOmniCodexMcpServer({
      appServer,
      nativeToolCatalog: new NativeToolCatalog(appServer),
      nativeToolExecutor: new NativeToolExecutor(appServer, {
        ensureThread: async () => "cua-reconnected",
      }),
      runtimeDispatchOnly: true,
      actionCatalogByteBudget: 64 * 1_024,
      surface: "full",
      resolveDurableWorkSessionBinding,
    });
    const [reconnectedClientTransport, reconnectedServerTransport] =
      InMemoryTransport.createLinkedPair();
    const reconnectedClient = new Client({ name: "downstream-cua-reconnected", version: "1" });
    await reconnectedHandle.server.connect(reconnectedServerTransport);
    await reconnectedClient.connect(reconnectedClientTransport);
    try {
      const result = await reconnectedClient.callTool({
        name: "codex__cua_repl__js",
        arguments: { code: "await cua.getState();", title: "Read state after reconnect" },
      });
      expect(result.content).toEqual([{ type: "text", text: "result-4" }]);
      expect(calls).toBe(4);
      expect(browserSessionIds).toEqual([
        workSessionBinding,
        workSessionBinding,
        workSessionBinding,
        workSessionBinding,
      ]);
    } finally {
      await reconnectedClient.close();
      await reconnectedHandle.server.close();
    }
  });

  it("advertises a lone native Node REPL and dispatches direct and discovered calls identically", async () => {
    const nativeTool = {
      name: "js",
      description: "Execute JavaScript in the persistent Node REPL.",
      inputSchema: {
        type: "object",
        properties: { code: { type: "string" }, title: { type: "string" } },
        required: ["code"],
        additionalProperties: false,
      },
    };
    const calls: unknown[] = [];
    const nativeResult = { content: [{ type: "text", text: "Complete native result." }] };
    const appServer = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        if (method === "mcpServerStatus/list") {
          return {
            data: [{ name: "node_repl", tools: { js: nativeTool } }],
            nextCursor: null,
          } as T;
        }
        if (method === "mcpServer/tool/call") {
          calls.push(params);
          return nativeResult as T;
        }
        throw new Error(`unexpected App Server request: ${method}`);
      },
    };
    const handle = createOmniCodexMcpServer({
      appServer,
      nativeToolCatalog: new NativeToolCatalog(appServer),
      nativeToolExecutor: new NativeToolExecutor(appServer, { threadId: "native-repl-context" }),
      runtimeDispatchOnly: true,
      actionCatalogByteBudget: 64 * 1_024,
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "single-native-repl", version: "1" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = (await client.listTools()).tools;
      const direct = listed.find((tool) => tool.name === "codex__node_repl__js");
      expect(direct?.description).toBe(nativeTool.description);
      expect(direct?.inputSchema).toEqual(nativeTool.inputSchema);
      const searched = await client.callTool({
        name: "search_native_tools",
        arguments: { query: "js", namespace: "node_repl" },
      });
      expect(searched.isError).not.toBe(true);
      expect(searched.structuredContent).toMatchObject({
        tools: [
          {
            name: "codex__node_repl__js",
            nativeName: "js",
            nativeNamespace: "node_repl",
            executeWith: "codex__node_repl__js",
          },
        ],
      });
      const args = { code: "console.log('native');", title: "Read native output" };
      for (const invocation of [
        { name: "codex__node_repl__js", arguments: args },
        { name: "call_native_tool", arguments: { name: "codex__node_repl__js", arguments: args } },
      ]) {
        const result = await client.callTool(invocation);
        expect(result.isError).not.toBe(true);
        expect(result.content).toEqual(nativeResult.content);
      }
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call).toMatchObject({ server: "node_repl", tool: "js", arguments: args });
      }
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("keeps browser adapters eager when the installed native CUA contract is unavailable", async () => {
    const nativeTool = {
      name: "js",
      description: "Execute JavaScript in a persistent node_repl with browser-client.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string" },
          timeout_ms: { type: "integer", minimum: 1, default: 30_000 },
          title: { type: "string" },
        },
        required: ["code"],
        additionalProperties: false,
      },
    };
    const appServer = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        if (method === "mcpServerStatus/list") {
          return {
            data: [{ name: "node_repl", tools: { js: nativeTool } }],
            nextCursor: null,
          } as T;
        }
        if (method === "mcpServer/tool/call") {
          return {
            content: [{ type: "text", text: JSON.stringify(params) }],
          } as T;
        }
        throw new Error(`unexpected App Server request: ${method}`);
      },
    };
    const handle = createOmniCodexMcpServer({
      appServer,
      nativeToolCatalog: new NativeToolCatalog(appServer),
      nativeToolExecutor: new NativeToolExecutor(appServer, {
        threadId: "native-browser-context",
      }),
      browserNativeExecutor: { call: async () => ({ content: [] }) },
      runtimeDispatchOnly: true,
      actionCatalogByteBudget: 64 * 1_024,
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "native-browser-action", version: "1" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("codex__node_repl__js");
      expect(names).toEqual(
        expect.arrayContaining([
          "browser__list_surfaces",
          "chrome__list_user_tabs",
          "chrome__control_chrome",
          "browser__control_in_app_browser",
        ]),
      );

      const searched = await client.callTool({
        name: "search_native_tools",
        arguments: { query: "chrome__control_chrome" },
      });
      expect(searched.isError).not.toBe(true);
      expect(objectValue(searched.structuredContent).tools).toEqual([
        expect.objectContaining({
          name: "chrome__control_chrome",
          executeWith: "chrome__control_chrome",
        }),
      ]);
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("exposes installed native CUA and Node actions with exact contracts and complete results", async () => {
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected App Server request: ${method}`);
      },
    };
    const description = "Control browsers using the installed persistent native CUA session.";
    const parameters = {
      type: "object",
      properties: { code: { type: "string" }, title: { type: "string" } },
      required: ["code"],
      additionalProperties: false,
    };
    const responsesToolCatalog = new ResponsesNativeToolCatalog({
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: ["cua_repl", "mcp__cua_repl", "node_repl"].map((name) => ({
          type: "namespace",
          name,
          tools: [
            {
              type: "function",
              name: "js",
              description,
              parameters,
              _meta: { nativeContract: "unchanged" },
            },
            {
              type: "function",
              name: "js_reset",
              description: "Reset the persistent session.",
              parameters: { type: "object", properties: {} },
            },
          ],
        })),
        nestedTools: [],
      },
    });
    const calls: unknown[] = [];
    const text = `start:${"native browser output\n".repeat(2_000)}:end`;
    const responsesToolExecutor = new ResponsesNativeToolExecutor({
      call: async (selection) => {
        calls.push(selection);
        return {
          callId: "native-cua-call",
          outputType: "function_call_output",
          executionStatus: "succeeded",
          output: [{ type: "text", text }],
          rawItem: {
            type: "function_call_output",
            call_id: "native-cua-call",
            output: [{ type: "text", text }],
          },
        };
      },
    });
    const recoverUnknownResources = vi.fn(
      async (
        _resourceKeys: readonly string[],
        _proveSettled: (lease: DurableNativeResourceLeaseView) => Promise<boolean>,
      ) => 1,
    );
    const scheduler = new NativeExecutionScheduler({
      resourceLeaseCoordinator: {
        acquire: async () => {
          throw new Error("the exact CUA inventory probe must not acquire a mutation lease");
        },
        interruptOwnedOperations: async () => 0,
        recoverUnknownResources,
      },
    });
    const handle = createOmniCodexMcpServer({
      appServer,
      responsesToolCatalog,
      responsesToolExecutor,
      browserNativeExecutor: { call: async () => ({ content: [] }) },
      scheduler,
      runtimeDispatchOnly: true,
      actionCatalogByteBudget: 64 * 1_024,
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "native-cua-eager", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = (await client.listTools()).tools;
      expect(listed.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "codex__cua_repl__js",
          "codex__cua_repl__js_reset",
          "codex__node_repl__js",
          "codex__node_repl__js_reset",
        ]),
      );
      // Purpose-named browser actions stay eager beside CUA; only the
      // alternate CUA projection is left to the complete catalog.
      expect(listed.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "browser__list_surfaces",
          "chrome__list_user_tabs",
          "chrome__control_chrome",
          "browser__control_in_app_browser",
        ]),
      );
      expect(listed.map((tool) => tool.name)).not.toContain("codex__mcp__cua_repl__js");
      expect(listed.map((tool) => tool.name)).not.toContain("codex__mcp__cua_repl__js_reset");
      const nativeCua = listed.find((tool) => tool.name === "codex__cua_repl__js");
      expect(nativeCua?.description).toBe(description);
      expect(nativeCua?.inputSchema).toEqual(parameters);
      expect(nativeCua?._meta?.nativeContract).toBe("unchanged");
      const search = await client.callTool({
        name: "search_native_tools",
        arguments: { query: "codex__cua_repl__js" },
      });
      const matches = objectValue(search.structuredContent).tools;
      const match = Array.isArray(matches) ? objectValue(matches[0]) : {};
      expect(match.executeWith).toBe("codex__cua_repl__js");
      expect(match.executeArguments).toMatchObject({
        code: "Supply code matching executionInputSchema.",
      });
      expect(match.executionInputSchema).toEqual(nativeCua?.inputSchema);
      const args = { code: "await cua.getState();", title: "Read current state" };
      const result = await client.callTool({ name: "codex__cua_repl__js", arguments: args });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{ type: "text", text }]);
      expect(calls).toEqual([
        { kind: "function", namespace: "cua_repl", name: "js", arguments: args },
      ]);
      expect(recoverUnknownResources).toHaveBeenCalledOnce();
      expect(recoverUnknownResources.mock.calls[0]?.[0]).toEqual(
        expect.arrayContaining([expect.stringContaining("0:lane:node_repl:")]),
      );
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("passes the scheduler boundary signal into the live Codex app tool pipe", async () => {
    const boundary = new AbortController();
    const receivedSignals: Array<AbortSignal | undefined> = [];
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected App Server request: ${method}`);
      },
    };
    const host = new CodexAppHostToolExecutor(appServer, {
      appToolsContextThreadId: () => "app-visible-thread",
      appTools: {
        close: () => undefined,
        listTools: async () => [
          {
            namespace: "native_probe",
            name: "read_state",
            description: "Read native state.",
            inputSchema: {
              type: "object",
              properties: { timeoutMs: { type: "integer", minimum: 1 } },
              additionalProperties: false,
            },
          },
        ],
        callTool: async (_params, options) => {
          receivedSignals.push(options?.signal);
          return {
            success: true,
            contentItems: [{ type: "inputText", text: '{"ok":true}' }],
          };
        },
      },
    });
    const scheduler = new BoundarySignalScheduler(boundary.signal);
    const handle = createOmniCodexMcpServer({
      appServer,
      codexAppHostToolExecutor: host,
      scheduler,
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "boundary-signal-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "native_probe__read_state",
        arguments: { timeoutMs: 1 },
      });
      expect(result.isError).not.toBe(true);
      expect(receivedSignals).toEqual([boundary.signal]);
      expect(scheduler.requests).toHaveLength(1);
      expect(scheduler.requests[0]).not.toHaveProperty("timeoutMs");
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("publishes Computer Use as a direct first-class tool and dispatches it without a model", async () => {
    const computerUseCalls: Array<{
      method: string;
      args: unknown;
      callerSessionId: string | undefined;
    }> = [];
    const executions: unknown[] = [];
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected App Server request: ${method}`);
      },
    };
    const host = new CodexAppHostToolExecutor(appServer, {
      computerUse: {
        call: async (method, args, _threadId, _turnId, _signal, _operationId, callerSessionId) => {
          computerUseCalls.push({ method, args, callerSessionId });
          return [{ id: "app-1" }];
        },
      },
    });
    const handle = createOmniCodexMcpServer({
      appServer,
      codexAppHostToolExecutor: host,
      correlationId: "web-pro-computer-use-session",
      resolveDurableWorkSessionBinding: () => ({
        workSessionBinding: "durable-computer-use-session",
        directGoalClaimantBinding: "durable-computer-use-session",
        directJobOwnerBinding: "durable-computer-use-session",
        continuationToken: "computer-use-continuation",
        journalCursor: "computer-use-cursor",
      }),
      surface: "full",
      observeNativeToolExecution: (observation) => {
        executions.push(observation);
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "computer-use-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(
      listed.tools.find((tool) => tool.name === "codex__computer_use__list_apps"),
    ).toMatchObject({
      name: "codex__computer_use__list_apps",
      inputSchema: { type: "object", additionalProperties: false },
      annotations: ALL_FALSE_ANNOTATIONS,
    });
    expect(
      listed.tools.find((tool) => tool.name === "codex__computer_use__list_apps")?._meta?.omnicodex,
    ).toMatchObject({ toolId: expect.any(String), catalogRevision: expect.any(String) });
    expect(
      listed.tools.find((tool) => tool.name === "codex__computer_use__list_apps")?._meta?.omnicodex,
    ).not.toHaveProperty("stateEffect");
    expect(
      listed.tools.find((tool) => tool.name === "codex__computer_use__get_window_state")
        ?.inputSchema,
    ).toMatchObject({
      required: ["window"],
      properties: {
        include_screenshot: { type: "boolean" },
        include_text: { type: "boolean" },
      },
    });
    expect(
      listed.tools.find((tool) => tool.name === "codex__computer_use__get_window_state")
        ?.inputSchema,
    ).not.toHaveProperty("anyOf");
    expect(
      listed.tools.find((tool) => tool.name === "codex__computer_use__click")?.inputSchema,
    ).toMatchObject({
      required: ["window"],
    });
    expect(
      listed.tools.find((tool) => tool.name === "codex__computer_use__scroll")?.inputSchema,
    ).toMatchObject({
      required: ["window", "scrollX", "scrollY", "x", "y"],
    });
    expect(
      listed.tools.find((tool) => tool.name === "codex__computer_use__drag")?.inputSchema,
    ).toMatchObject({
      required: ["window", "from_x", "from_y", "to_x", "to_y"],
    });
    const result = await client.callTool({
      name: "codex__computer_use__list_apps",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: '[{"id":"app-1"}]' }]);
    expect(computerUseCalls).toEqual([
      {
        method: "list_apps",
        args: {},
        callerSessionId: "durable-computer-use-session",
      },
    ]);
    expect(executions).toEqual([
      expect.objectContaining({
        mcpToolName: "codex__computer_use__list_apps",
        targetNativeName: "codex.computer_use.list_apps",
        targetNamespace: "codex.computer_use",
        targetRoute: "computer_use_native",
        modelEffect: "none",
        outcome: "succeeded",
      }),
    ]);

    await client.close();
    await handle.server.close();
  });

  it("reports the exact canonical production identity by default", async () => {
    const appServer = {
      request: async <T>(method: string, _params: unknown): Promise<T> => {
        if (method === "mcpServerStatus/list") {
          return { data: [], nextCursor: null } as T;
        }
        throw new Error("unexpected App Server request");
      },
    };
    const handle = createOmniCodexMcpServer({
      appServer,
      desktopIpcClient: {
        sendFollowUpMessage: async () => {
          throw new Error("identity test must not send a thread message");
        },
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    expect(client.getServerVersion()?.name).toBe("OmniCodex");
    expect(client.getInstructions()).toBeUndefined();
    const listed = await client.listTools();
    const send = listed.tools.find((tool) => tool.name === "codex_app__send_message_to_thread");
    const list = listed.tools.find((tool) => tool.name === "codex_app__list_threads");
    const read = listed.tools.find((tool) => tool.name === "codex_app__read_thread");
    const attach = listed.tools.find((tool) => tool.name === OMNICODEX_ATTACH_LOCAL_FILE_TOOL);
    expect(send?.description).toContain("targets Codex tasks");
    expect(send?.description).toContain("Omit model and thinking");
    expect(send?.description).toContain("does not author or relay Web conversation messages");
    expect(send?.description).not.toContain("already authorized");
    expect(send?._meta?.omnicodex).not.toHaveProperty("ownerSessionMessageAuthorization");
    expect(list?.description).toContain("Find or list Codex threads and chats");
    expect(list?.description).not.toContain("use the returned thread only as context");
    expect(read?.description).toContain("Omitted caller limits return every turn");
    expect(read?.annotations).toEqual(ALL_FALSE_ANNOTATIONS);
    expect(attach?.description).toBe(
      "Creates a downloadable attachment from an existing absolute local file and returns its resource_link.",
    );
    expect(attach?.inputSchema.properties?.omnicodexInvocationId).toMatchObject({
      description:
        "Stable idempotency key for this attachment operation. Reuse it when retrying the same operation.",
    });
    expect(attach?.inputSchema.properties?.chatGptConversationUrl).toMatchObject({
      description: "Exact URL of the current ChatGPT conversation when available.",
    });
    for (const tool of listed.tools) {
      expect(tool._meta?.["openai/outputTemplate"]).toBeUndefined();
      expect(objectValue(tool._meta?.ui).resourceUri).toBeUndefined();
      expect(tool._meta?.["openai/toolInvocation/invoking"]).toBeUndefined();
      expect(tool._meta?.["openai/toolInvocation/invoked"]).toBeUndefined();
      expect(Object.keys(objectValue(tool._meta?.omnicodex))).toEqual(
        expect.arrayContaining(["toolId", "catalogRevision"]),
      );
      expect(
        Object.keys(objectValue(tool._meta?.omnicodex)).every((key) =>
          ["toolId", "catalogRevision"].includes(key),
        ),
      ).toBe(true);
    }
    expect(list?.description).not.toContain("use codex_app__send_message_to_thread");
    expect(read?.description).not.toContain("use codex_app__send_message_to_thread");
    expect(list?.description).not.toContain("Use this direct action only");

    await client.close();
    await handle.server.close();
  });

  it("classifies explicit App Server model turns for bounded release draining", async () => {
    const appServer = {
      request: async <T>(method: string, _params: unknown): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected method ${method}`);
      },
    };
    const handle = createOmniCodexMcpServer({ appServer });

    await expect(handle.classifyToolCall("app_server_rpc", { method: "turn/start" })).resolves.toBe(
      "model",
    );
    await expect(
      handle.classifyToolCall("app_server_rpc", { method: "account/rateLimits/read" }),
    ).resolves.toBe("non_model");
    await expect(handle.classifyToolCall("missing", {})).resolves.toBe("unknown");
  });

  it("lists only discovered tools on the full surface and routes a native call", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const listeners = new Set<(message: Record<string, unknown>) => void>();
    const appServer = {
      subscribeNotifications: (listener: (message: Record<string, unknown>) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      request: async <T>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "mcpServerStatus/list") {
          return {
            data: [
              {
                name: "demo",
                tools: {
                  "demo.echo": {
                    name: "demo.echo",
                    description: "Echo a value",
                    inputSchema: {
                      type: "object",
                      properties: { value: { type: "string" } },
                      required: ["value"],
                    },
                  },
                },
              },
            ],
            nextCursor: null,
          } as T;
        }
        if (method === "thread/start") {
          return { thread: { id: "urn:uuid:ephemeral" } } as T;
        }
        if (method === "mcpServer/tool/call") {
          for (const listener of listeners) {
            listener({
              method: "item/mcpToolCall/progress",
              params: {
                threadId: "urn:uuid:ephemeral",
                turnId: "turn-native",
                itemId: "item-native",
                message: "native 20%",
              },
            });
            listener({
              method: "item/mcpToolCall/progress",
              params: {
                threadId: "urn:uuid:ephemeral",
                turnId: "turn-native",
                itemId: "item-native",
                message: "native 80%",
              },
            });
          }
          return { content: [{ type: "text", text: "echoed" }] } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    const handle = createOmniCodexMcpServer({ appServer });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    expect(client.getInstructions()).toBeUndefined();
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["codex_app__list_threads", "demo.echo"]),
    );
    const demoTool = listed.tools.find((tool) => tool.name === "demo.echo");
    expect(demoTool?._meta?.omnicodex).toMatchObject({
      toolId: expect.any(String),
      catalogRevision: expect.any(String),
    });
    expect(demoTool?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        value: { type: "string" },
      },
      required: ["value"],
    });
    const progress: unknown[] = [];
    const result = await client.callTool(
      {
        name: "demo.echo",
        arguments: { value: "hello" },
      },
      undefined,
      { onprogress: (value) => progress.push(value) },
    );
    expect(result.content).toEqual([{ type: "text", text: "echoed" }]);
    expect(progress).toEqual([
      { progress: 0, message: "Native call started" },
      { progress: 1, message: "native 20%" },
      { progress: 2, message: "native 80%" },
      { progress: 3, total: 3, message: "Native call completed" },
    ]);
    expect(calls.map((call) => call.method)).toEqual([
      "mcpServerStatus/list",
      "mcpServerStatus/list",
      "thread/start",
      "mcpServer/tool/call",
    ]);

    await client.close();
    await handle.server.close();
  });

  it("publishes native presentation and execution metadata without leaking it into dispatch", async () => {
    const nativeCalls: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
    const observations: NativeToolExecutionObservation[] = [];
    const privateDeclaration = `\n\nShared MCP Types:\nA private runtime-only type catalog.\n\nexec tool declaration:\n\`\`\`ts\ndeclare const tools: { read_thread(args: { threadId: string }): Promise<unknown>; };\n\`\`\``;
    const readSchema = {
      type: "object",
      title: "Read thread input",
      description: "Exact native read-thread arguments.",
      properties: {
        threadId: {
          type: "string",
          title: "Thread id",
          description: "Exact Codex thread id.",
          examples: ["thread-1"],
        },
      },
      required: ["threadId"],
      additionalProperties: false,
    };
    const liveTools: CodexAppNativeTool[] = [
      {
        namespace: "codex_app",
        name: "read_thread",
        description: `${"Read one existing Codex thread without opening it. ".repeat(40)}${privateDeclaration}`,
        inputSchema: readSchema,
        _meta: {
          "openai/toolInvocation/invoking": "Reading thread",
          "openai/outputTemplate": "ui://native/thread-view.html",
          ui: { resourceUri: "ui://native/thread-view.html", nativeOption: "preserved" },
          omnicodex: {
            connector: { duplicate: true },
            originalSpec: { private: "source descriptor" },
            source: "private-source",
          },
        },
      },
      {
        namespace: "codex_app",
        name: "send_message_to_thread",
        description: `Send one follow-up prompt to an existing Codex thread.${privateDeclaration}`,
        inputSchema: {
          type: "object",
          properties: {
            threadId: { type: "string" },
            prompt: { type: "string" },
          },
          required: ["threadId", "prompt"],
          additionalProperties: false,
        },
        _meta: {
          "openai/toolInvocation/invoking": "Sending follow-up",
          omnicodex: {
            connector: "duplicate-private-connector",
            originalSpec: { private: "source descriptor" },
          },
        },
      },
    ];
    const appTools = {
      close: () => undefined,
      listTools: async () => liveTools,
      callTool: async (params: { tool: string; arguments: Record<string, unknown> }) => {
        nativeCalls.push({ tool: params.tool, arguments: params.arguments });
        return {
          success: true,
          contentItems: [
            {
              type: "inputText" as const,
              text: JSON.stringify({ tool: params.tool, arguments: params.arguments }),
            },
          ],
        };
      },
    };
    const appServer = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        if (method === "thread/list") {
          if (objectValue(params).sectionId === "01984de2-8f74-7c91-a3b2-5c5e937cf318") {
            return { data: [], nextCursor: null } as T;
          }
          return {
            data: [{ id: "thread-1", cwd: "C:\\workspace", status: { type: "notLoaded" } }],
            nextCursor: null,
          } as T;
        }
        if (method === "thread/read") {
          return {
            thread: {
              id: "thread-1",
              cwd: "C:\\workspace",
              status: { type: "notLoaded" },
            },
          } as T;
        }
        if (method === "thread/turns/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected method ${method}`);
      },
    };
    const host = new CodexAppHostToolExecutor(appServer, {
      appTools,
      appToolsContextThreadId: () => "bridge-thread",
    });
    const handle = createOmniCodexMcpServer({
      appServer,
      codexAppHostToolExecutor: host,
      surface: "full",
      observeNativeToolExecution: (observation) => {
        observations.push(observation);
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "compact-catalog-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const read = listed.tools.find((tool) => tool.name === "codex_app__read_thread");
    const send = listed.tools.find((tool) => tool.name === "codex_app__send_message_to_thread");
    expect(read).toBeDefined();
    expect(send).toBeDefined();
    expect(send?.description).toContain("exec tool declaration");
    expect(send?.description).toContain("Shared MCP Types");
    const readMetadata = objectValue(read?._meta?.omnicodex);
    expect(readMetadata).toMatchObject({
      toolId: expect.any(String),
      catalogRevision: expect.any(String),
    });
    expect(objectValue(read?.inputSchema).properties).toMatchObject({
      threadId: { type: "string" },
      cursor: { type: "string" },
      turnLimit: { type: "integer", minimum: 1 },
      itemOffset: { type: "integer", minimum: 0 },
    });
    expect(read?.description).toBe(liveTools[0]?.description);
    expect(read?._meta).toMatchObject({
      "openai/toolInvocation/invoking": "Reading thread",
      "openai/outputTemplate": "ui://native/thread-view.html",
      ui: { resourceUri: "ui://native/thread-view.html", nativeOption: "preserved" },
    });
    expect(send?._meta).toMatchObject({
      "openai/toolInvocation/invoking": "Sending follow-up",
    });
    expect([...String(read?._meta?.["openai/toolInvocation/invoked"])].length).toBeLessThanOrEqual(
      64,
    );
    expect(read?._meta?.omnicodex).toBeDefined();

    const readResult = await client.callTool({
      name: "codex_app__read_thread",
      arguments: { threadId: "thread-1" },
    });
    const sendResult = await client.callTool({
      name: "codex_app__send_message_to_thread",
      arguments: { threadId: "thread-1", prompt: "Continue the existing work." },
    });
    expect(readResult.isError).not.toBe(true);
    expect(readResult.structuredContent).toMatchObject({
      schemaVersion: 1,
      thread: { id: "thread-1", cwd: "C:\\workspace" },
      page: { nextCursor: null, returnedTurns: 0 },
      turns: [],
    });
    expect(sendResult.isError).not.toBe(true);
    expect(nativeCalls).toEqual([
      {
        tool: "send_message_to_thread",
        arguments: { threadId: "thread-1", prompt: "Continue the existing work." },
      },
    ]);
    const sendObservation = observations.find(
      (observation) => observation.targetNativeName === "codex_app/send_message_to_thread",
    );
    expect(sendObservation).toMatchObject({
      messageTransmissionRequested: true,
      modelOverride: "omitted",
      reasoningOverride: "omitted",
      outcome: "succeeded",
    });
    expect(sendObservation?.requestArgumentsSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(sendObservation?.targetThreadIdSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(sendObservation?.messagePromptSha256).toMatch(/^[a-f0-9]{64}$/u);

    await client.close();
    await handle.server.close();
  });

  it("preserves object output schemas and losslessly envelopes non-object native outputs", async () => {
    const exactObjectOutputSchema = {
      type: "object",
      title: "Exact native object output",
      properties: {
        status: { type: "string", enum: ["ok"] },
        details: {
          type: "object",
          properties: { count: { type: "integer", minimum: 0 } },
          required: ["count"],
          additionalProperties: false,
        },
      },
      required: ["status", "details"],
      additionalProperties: false,
    };
    const unionOutputSchema = {
      anyOf: [{ type: "string" }, false, { type: "array", items: true }],
    };
    const outputs: Record<string, unknown> = {
      exact_object_output: { status: "ok", details: { count: 2 } },
      scalar_output: "scalar-ok",
      union_output: [1, { nested: true }],
      anything_output: null,
    };
    const liveTools: CodexAppNativeTool[] = [
      {
        namespace: "codex_app",
        name: "exact_object_output",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: exactObjectOutputSchema,
      },
      {
        namespace: "codex_app",
        name: "scalar_output",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: { type: "string", minLength: 1 },
      },
      {
        namespace: "codex_app",
        name: "union_output",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: unionOutputSchema,
      },
      {
        namespace: "codex_app",
        name: "anything_output",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: true,
      },
    ];
    const appTools = {
      close: () => undefined,
      listTools: async () => liveTools,
      callTool: async (params: { tool: string }) => ({
        success: true,
        contentItems: [
          {
            type: "inputText" as const,
            text: JSON.stringify(outputs[params.tool]),
          },
        ],
      }),
    };
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected method ${method}`);
      },
    };
    const host = new CodexAppHostToolExecutor(appServer, {
      appTools,
      appToolsContextThreadId: () => "bridge-thread",
    });
    const handle = createOmniCodexMcpServer({
      appServer,
      codexAppHostToolExecutor: host,
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "native-output-schema-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const listedByName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    expect(listedByName.get("codex_app__exact_object_output")?.outputSchema).toEqual(
      exactObjectOutputSchema,
    );
    expect(listedByName.get("codex_app__scalar_output")?.outputSchema).toEqual({
      type: "object",
      properties: { value: { type: "string", minLength: 1 } },
      required: ["value"],
      additionalProperties: false,
    });
    expect(listedByName.get("codex_app__union_output")?.outputSchema).toEqual({
      type: "object",
      properties: {
        value: {
          anyOf: [{ type: "string" }, { not: {} }, { type: "array", items: {} }],
        },
      },
      required: ["value"],
      additionalProperties: false,
    });
    expect(listedByName.get("codex_app__anything_output")?.outputSchema).toEqual({
      type: "object",
      properties: { value: {} },
      required: ["value"],
      additionalProperties: false,
    });

    const exactObjectResult = await client.callTool({
      name: "codex_app__exact_object_output",
      arguments: {},
    });
    const scalarResult = await client.callTool({
      name: "codex_app__scalar_output",
      arguments: {},
    });
    const unionResult = await client.callTool({
      name: "codex_app__union_output",
      arguments: {},
    });
    const anythingResult = await client.callTool({
      name: "codex_app__anything_output",
      arguments: {},
    });
    expect(exactObjectResult.structuredContent).toEqual(outputs.exact_object_output);
    expect(scalarResult.structuredContent).toEqual({ value: outputs.scalar_output });
    expect(unionResult.structuredContent).toEqual({ value: outputs.union_output });
    expect(anythingResult.structuredContent).toEqual({ value: null });

    await client.close();
    await handle.server.close();
  });

  it("forwards a model-backed RPC without adding OmniCodex acknowledgement fields", async () => {
    const appServer = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        if (method === "mcpServerStatus/list") {
          return { data: [], nextCursor: null } as T;
        }
        if (method === "turn/start")
          return (
            (params as { large?: boolean })?.large === true
              ? { payload: "x".repeat(65 * 1024) }
              : { turn: { id: "turn-native" } }
          ) as T;
        throw new Error(`unexpected method ${method}`);
      },
    };
    const appServerMethodCatalog = new AppServerMethodCatalog({
      loadClientRequestSchema: async () => ({
        oneOf: [
          {
            properties: {
              method: { enum: ["turn/start"] },
              params: { type: "object", additionalProperties: true },
            },
          },
        ],
      }),
    });
    const handle = createOmniCodexMcpServer({
      appServer,
      appServerMethodCatalog,
      surface: "compat",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "app_server_rpc",
      arguments: {
        method: "turn/start",
        params: {},
        allowModelInvocation: true,
        allowPersistentStateMutation: true,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ turn: { id: "turn-native" } });
    expect(result).toMatchObject({
      content: [
        {
          type: "text",
          text: JSON.stringify({ turn: { id: "turn-native" } }),
        },
      ],
    });

    const large = await client.callTool({
      name: "app_server_rpc",
      arguments: {
        method: "turn/start",
        params: { large: true },
        allowModelInvocation: true,
        allowPersistentStateMutation: true,
      },
    });
    expect(large.structuredContent).toEqual({ payload: "x".repeat(65 * 1024) });
    expect(large.content).toEqual([
      { type: "text", text: expect.stringMatching(/^OMNICODEX_STRUCTURED_RESULT_V1:/u) },
    ]);

    await client.close();
    await handle.server.close();
  });

  it("durably replays an authoritative App Server rejection as a known failure", async () => {
    const rpcError = {
      code: -32_600,
      message: "custom outputBytesCap is not supported with windows sandbox",
      data: { method: "fs/writeFile", retryable: false },
    };
    let writeRequests = 0;
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        if (method === "fs/writeFile") {
          writeRequests += 1;
          throw new JsonlRpcError(rpcError);
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    const handle = createOmniCodexMcpServer({
      appServer,
      appServerMethodCatalog: directWorkAppServerMethodCatalog(),
      surface: "full",
      mutationReplayStore: MutationReplayStore.inMemory(),
      legacyMutationCoordinator: LegacyMutationCoordinator.inMemory(),
      authorizationBinding: "https://issuer.example\0owner-subject\0client\0omnicodex",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "known-rpc-failure", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const request = {
        name: "codex__app_server__fs_writeFile",
        arguments: {
          path: "C:\\workspace\\known-failure.txt",
          content: "unchanged",
          omnicodexInvocationId: "known-app-server-rejection-20260902",
        },
      };
      const first = await client.callTool(request);
      const replay = await client.callTool(request);

      expect(first.isError).toBe(true);
      expect(first.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining(rpcError.message),
        },
      ]);
      expect(JSON.stringify(first)).not.toContain("MUTATION_OUTCOME_UNKNOWN");
      expect(first.structuredContent).toMatchObject({
        error: {
          name: "JsonlRpcError",
          code: rpcError.code,
          data: rpcError.data,
        },
      });
      expect(replay).toEqual(first);
      expect(writeRequests).toBe(1);
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it.each([false, true])(
    "records account recovery pacing before a Chat message dispatch (explicit=%s)",
    async (explicit) => {
      const appServer = {
        request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T,
      };
      const appTools = {
        close: () => undefined,
        listTools: async (): Promise<readonly CodexAppNativeTool[]> => [
          {
            namespace: "codex_app",
            name: "send_message_to_thread",
            description: "Send a follow-up message.",
            inputSchema: {
              type: "object",
              properties: {
                prompt: { type: "string" },
                threadId: { type: "string" },
              },
              required: ["prompt", "threadId"],
            },
          },
        ],
        callTool: vi.fn(async () => ({ success: true, contentItems: [] })),
      };
      const host = new CodexAppHostToolExecutor(appServer, {
        appTools,
        appToolsContextThreadId: () => "calling-thread",
        coordinateNativeChatRequest: async () => {
          throw new ChatAccountRateLimitError(1_800_000, undefined);
        },
      });
      await host.refreshTools();
      const handle = createOmniCodexMcpServer({
        appServer,
        codexAppHostToolExecutor: host,
        surface: "full",
        mutationReplayStore: MutationReplayStore.inMemory(),
        legacyMutationCoordinator: LegacyMutationCoordinator.inMemory(),
        authorizationBinding: "account-recovery-owner",
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "account-recovery", version: "1" });
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({
          name: "codex_app__send_message_to_thread",
          arguments: {
            threadId: "target-thread",
            prompt: "continue",
            ...(explicit
              ? { omnicodexInvocationId: "account-recovery-pre-dispatch-20260913" }
              : {}),
          },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain("MUTATION_NOT_DISPATCHED");
        expect(JSON.stringify(result)).not.toContain("MUTATION_OUTCOME_UNKNOWN");
        expect(appTools.callTool).not.toHaveBeenCalled();
      } finally {
        await client.close();
        await handle.server.close();
      }
    },
  );

  it.each([false, true])(
    "records a correlated Computer Use failure without an unknown cohort (explicit=%s)",
    async (explicit) => {
      const coordinator = LegacyMutationCoordinator.inMemory();
      const replayStore = MutationReplayStore.inMemory();
      let calls = 0;
      const appServer = {
        request: async <T>(method: string): Promise<T> => {
          if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
          throw new Error(`unexpected method ${method}`);
        },
      };
      const host = new CodexAppHostToolExecutor(appServer, {
        computerUse: {
          call: async () => {
            calls += 1;
            const error = new ComputerUseNativeResponseError("unknown screenshotId screenshot-0");
            Object.assign(error, { name: "Error", code: "INVALID_ARGUMENT" });
            throw error;
          },
        },
      });
      const open = async () => {
        const handle = createOmniCodexMcpServer({
          appServer,
          codexAppHostToolExecutor: host,
          surface: "full",
          mutationReplayStore: replayStore,
          legacyMutationCoordinator: coordinator,
          authorizationBinding: "cu-known-result-owner",
        });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "cu-known-result", version: "1" });
        await handle.server.connect(st);
        await client.connect(ct);
        return { client, handle };
      };
      const request = {
        name: "codex__computer_use__click",
        arguments: {
          window: { app: "notepad.exe", id: 10 },
          screenshotId: "screenshot-0",
          x: 20,
          y: 20,
          ...(explicit ? { omnicodexInvocationId: "cu-known-result-1" } : {}),
        },
      };
      const first = await open();
      try {
        const result = await first.client.callTool(request);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { code: "INVALID_ARGUMENT", message: "unknown screenshotId screenshot-0" },
        });
        expect(JSON.stringify(result)).not.toContain("MUTATION_OUTCOME_UNKNOWN");
      } finally {
        await first.client.close();
        await first.handle.server.close();
      }
      const second = await open();
      try {
        const result = await second.client.callTool(request);
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toMatch(
          /MUTATION_OUTCOME_UNKNOWN|AMBIGUOUS_LEGACY_MUTATION_COHORT/,
        );
        expect(calls).toBe(explicit ? 1 : 2);
      } finally {
        await second.client.close();
        await second.handle.server.close();
      }
    },
  );

  it("keeps App Server RPC request and response semantics unchanged", async () => {
    const listeners = new Set<(message: Record<string, unknown>) => void>();
    const calls: Array<{ method: string; params: unknown }> = [];
    const rpcOptions: unknown[] = [];
    const appServer = {
      subscribeNotifications: (listener: (message: Record<string, unknown>) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      request: async <T>(method: string, params: unknown, options?: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        if (method === "thread/start") {
          rpcOptions.push(options);
          return { thread: { id: "thread-generic" } } as T;
        }
        if (method === "turn/start") {
          rpcOptions.push(options);
          return { turn: { id: "turn-generic" } } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    const appServerMethodCatalog = new AppServerMethodCatalog({
      loadClientRequestSchema: async () => ({
        oneOf: [
          {
            properties: {
              method: { enum: ["thread/start"] },
              params: { type: "object", additionalProperties: true },
            },
          },
          {
            properties: {
              method: { enum: ["turn/start"] },
              params: { type: "object", additionalProperties: true },
            },
          },
        ],
      }),
    });
    const handle = createOmniCodexMcpServer({
      appServer,
      appServerMethodCatalog,
      surface: "compat",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    const created = await client.callTool({
      name: "app_server_rpc",
      arguments: {
        method: "thread/start",
        params: { ephemeral: false },
        timeoutMs: 3_000_000_000,
        allowPersistentStateMutation: true,
      },
    });
    expect(created.structuredContent).toEqual({ thread: { id: "thread-generic" } });
    expect(calls.some((call) => call.method === "turn/start")).toBe(false);

    const turned = await client.callTool({
      name: "app_server_rpc",
      arguments: {
        method: "turn/start",
        params: { threadId: "thread-generic", input: [{ type: "text", text: "hello" }] },
        allowModelInvocation: true,
        allowPersistentStateMutation: true,
      },
    });
    expect(turned.structuredContent).toEqual({ turn: { id: "turn-generic" } });
    expect(listeners.size).toBe(0);
    expect(calls).toEqual([
      { method: "mcpServerStatus/list", params: { detail: "full", limit: 1000 } },
      { method: "mcpServerStatus/list", params: { detail: "full", limit: 1000 } },
      { method: "thread/start", params: { ephemeral: false } },
      {
        method: "turn/start",
        params: { threadId: "thread-generic", input: [{ type: "text", text: "hello" }] },
      },
    ]);
    expect(rpcOptions).toEqual([
      {
        timeoutMs: 3_000_000_000,
        signal: expect.any(AbortSignal),
        awaitResponseAfterCancellation: true,
      },
      {
        signal: expect.any(AbortSignal),
        awaitResponseAfterCancellation: true,
      },
    ]);

    await client.close();
    await handle.server.close();
  });

  it("lists and directly calls methods generated by the installed App Server schema", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const directOptions: unknown[] = [];
    const appServer = {
      request: async <T>(method: string, params: unknown, options?: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "mcpServerStatus/list") {
          return { data: [], nextCursor: null } as T;
        }
        if (method === "fs/readFile") {
          directOptions.push(options);
          return { data: "native" } as T;
        }
        if (method === "thread/list") {
          return { data: [], nextCursor: null } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    const appServerMethodCatalog = new AppServerMethodCatalog({
      loadClientRequestSchema: async () => ({
        definitions: {
          FsReadFileParams: {
            type: "object",
            properties: { path: { type: "string" }, anything: true, denied: false },
            required: ["path"],
          },
          ThreadListParams: {
            type: "object",
            properties: { limit: { type: "integer" } },
          },
        },
        oneOf: [
          {
            title: "Fs/readFileRequest",
            description: "Read a local file directly through the installed Codex App Server.",
            properties: {
              method: { enum: ["fs/readFile"] },
              params: { $ref: "#/definitions/FsReadFileParams" },
            },
          },
          {
            title: "Thread/listRequest",
            properties: {
              method: { enum: ["thread/list"] },
              params: { $ref: "#/definitions/ThreadListParams" },
            },
          },
        ],
      }),
    });
    const handle = createOmniCodexMcpServer({ appServer, appServerMethodCatalog });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const nativeMethod = listed.tools.find(
      (tool) => tool.name === "codex__app_server__fs_readFile",
    );
    if (nativeMethod === undefined) throw new Error("missing App Server method tool");
    expect(nativeMethod.title).toBe("Fs/readFileRequest");
    expect(nativeMethod.description).toBe(
      "Read a local file directly through the installed Codex App Server.",
    );
    expect(nativeMethod.description).not.toContain("preflight");
    expect(nativeMethod.description).not.toContain("Do not use this action");
    expect(nativeMethod.annotations).toEqual(ALL_FALSE_ANNOTATIONS);
    expect(nativeMethod.inputSchema).toMatchObject({
      type: "object",
      properties: { path: { type: "string" }, anything: {}, denied: { not: {} } },
      required: ["path"],
      definitions: {
        FsReadFileParams: {
          properties: { anything: {}, denied: { not: {} } },
        },
      },
    });
    expect(nativeMethod.inputSchema).not.toHaveProperty("$ref");
    expect(nativeMethod._meta?.omnicodex).toMatchObject({
      toolId: expect.any(String),
      catalogRevision: expect.any(String),
    });
    const rawThreadList = listed.tools.find(
      (tool) => tool.name === "codex__app_server__thread_list",
    );
    expect(rawThreadList?.title).toBe("Thread/listRequest");
    expect(rawThreadList?.description).toBeUndefined();
    const result = await client.callTool({
      name: nativeMethod.name,
      arguments: { path: "C:\\workspace\\file.txt" },
    });
    expect(result.structuredContent).toEqual({ data: "native" });
    expect(calls).toContainEqual({
      method: "fs/readFile",
      params: { path: "C:\\workspace\\file.txt" },
    });
    expect(directOptions).toEqual([{ signal: expect.any(AbortSignal) }]);

    await client.close();
    await handle.server.close();
  });

  it.each([
    { label: "undefined", value: undefined, content: [{ type: "text", text: "undefined" }] },
    {
      label: "literal undefined text",
      value: "undefined",
      content: [{ type: "text", text: "undefined" }],
    },
    { label: "null", value: null, content: [{ type: "text", text: "null" }] },
    { label: "empty text", value: "", content: [{ type: "text", text: "" }] },
    { label: "empty content", value: { content: [] }, content: [] },
    {
      label: "undefined violating declared output schema",
      value: undefined,
      outputSchema: true,
      content: [
        {
          type: "text",
          text: "NATIVE_TOOL_OUTPUT_SCHEMA_VIOLATION: Native tool returned undefined despite declaring a JSON output schema",
        },
      ],
    },
    {
      label: "native error",
      value: { isError: true, content: [{ type: "text", text: "Exact native failure" }] },
      content: [{ type: "text", text: "Exact native failure" }],
    },
  ])("delivers $label nested results without synthesizing a security failure", async (scenario) => {
    const { value, content } = scenario;
    const outputSchema = "outputSchema" in scenario ? scenario.outputSchema : undefined;
    const appServer = {
      request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T,
    };
    const responsesToolCatalog = new ResponsesNativeToolCatalog({
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [
          { type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] },
        ],
        nestedTools: [
          {
            name: "native_probe",
            inputSchema: { type: "object", properties: {} },
            ...(outputSchema === undefined ? {} : { outputSchema }),
          },
        ],
      },
    });
    // This is the MCP normalization boundary test. Current catalog entries call
    // executor.call directly; inject raw native edge values at that boundary.
    // The real Responses envelope conversion is covered by its executor suite.
    const legacyNestedCall = vi.fn(async () => {
      throw new Error("legacy nested hook must not run");
    });
    const responsesToolExecutor = new ResponsesNativeToolExecutor({
      call: async () => {
        throw new Error("normalization fixture must use the injected executor boundary");
      },
      callNested: legacyNestedCall,
    });
    const nativeReturn = vi.spyOn(responsesToolExecutor, "call").mockResolvedValue(value);
    const handle = createOmniCodexMcpServer({
      appServer,
      responsesToolCatalog,
      responsesToolExecutor,
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "native-empty-result", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      for (const request of [
        { name: "native_probe", arguments: {} },
        { name: "call_native_tool", arguments: { name: "native_probe", arguments: {} } },
      ]) {
        const result = await client.callTool(request);
        expect(result.content).toEqual(content);
        if (outputSchema !== undefined) {
          expect(result.structuredContent).toMatchObject({
            error: { nativeReturnType: "undefined", outputSchema },
          });
        } else if (value === undefined) {
          expect(result._meta).toMatchObject({ omnicodex: { nativeReturnType: "undefined" } });
        } else {
          expect(result._meta).not.toHaveProperty("omnicodex.nativeReturnType");
        }
        expect(result.isError === true).toBe(
          outputSchema !== undefined ||
            (typeof value === "object" &&
              value !== null &&
              "isError" in value &&
              value.isError === true),
        );
      }
      expect(nativeReturn).toHaveBeenCalledTimes(2);
      for (const [descriptor, argumentsValue, signal] of nativeReturn.mock.calls) {
        expect(descriptor).toMatchObject({
          exposedName: "native_probe",
          executionMode: "responses_call",
        });
        expect(argumentsValue).toEqual({});
        expect(signal).toBeInstanceOf(AbortSignal);
      }
      expect(legacyNestedCall).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("advertises exec and every nested native action as first-class full-surface tools", async () => {
    const selected: unknown[] = [];
    const nested: unknown[] = [];
    const legacyNestedCall = vi.fn(async () => {
      throw new Error("legacy nested hook must not run");
    });
    const catalogObservations: unknown[] = [];
    let executionStatus: "succeeded" | "failed" = "succeeded";
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") {
          return { data: [], nextCursor: null } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    const responsesSource = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [{ type: "custom", name: "exec", description: "Execute native host tools" }],
          },
        ],
        nestedTools: [
          {
            name: "native_probe",
            description: "Probe an internal native capability.",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
        ],
      },
    };
    const responsesToolCatalog = new ResponsesNativeToolCatalog(responsesSource);
    const responsesToolExecutor = new ResponsesNativeToolExecutor({
      call: async (selection) => {
        if (selection.name === "native_probe") {
          const argumentsValue = selection.arguments;
          nested.push({ name: selection.name, argumentsValue, freeform: false });
          if (
            typeof argumentsValue === "object" &&
            argumentsValue !== null &&
            "value" in argumentsValue &&
            argumentsValue.value === "throw-structured"
          ) {
            const cause = Object.assign(new Error("nested cause"), { code: "CAUSE_CODE" });
            throw Object.assign(new Error("structured native failure", { cause }), {
              code: -32_041,
              data: { retryable: true, cursor: "resume-here" },
              rpcError: { code: -32_041, message: "RPC failed", data: { full: true } },
            });
          }
          return {
            callId: "probe-native",
            outputType: "function_call_output",
            executionStatus: "succeeded",
            output: { content: [{ type: "text", text: "probe-ok" }] },
            rawItem: {
              type: "function_call_output",
              call_id: "probe-native",
              output: { content: [{ type: "text", text: "probe-ok" }] },
            },
          };
        }
        selected.push(selection);
        return {
          callId: "call-native",
          outputType: "custom_tool_call_output",
          executionStatus,
          output: [{ type: "input_text", text: "native-ok" }],
          rawItem: {
            type: "custom_tool_call_output",
            call_id: "call-native",
            output: [{ type: "input_text", text: "native-ok" }],
          },
        };
      },
      callNested: legacyNestedCall,
    });
    const handle = createOmniCodexMcpServer({
      appServer,
      responsesToolCatalog,
      responsesToolExecutor,
      surface: "full",
      desktopIpcClient: {
        sendFollowUpMessage: async () => {
          throw new Error("catalog test must not send a thread message");
        },
      },
      observeToolCatalog: (observation) => {
        catalogObservations.push(observation);
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "responses-test-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "codex_app__send_message_to_thread",
        "codex__functions__exec",
        "native_probe",
      ]),
    );
    expect(listed.nextCursor).toBeUndefined();
    const repeated = await client.listTools();
    expect(repeated.tools).toEqual(listed.tools);
    expect(repeated.nextCursor).toBeUndefined();
    expect(catalogObservations).toEqual([
      expect.objectContaining({
        surface: "full",
        cursorPresent: false,
        toolCount: listed.tools.length,
        criticalToolCount: 1,
        criticalToolProperties: "input",
        criticalToolRequired: "input",
      }),
      expect.objectContaining({
        surface: "full",
        cursorPresent: false,
        toolCount: listed.tools.length,
        criticalToolCount: 1,
        criticalToolProperties: "input",
        criticalToolRequired: "input",
      }),
    ]);
    const nativeCustom = listed.tools.find((tool) => tool.name === "codex__functions__exec");
    if (nativeCustom === undefined) throw new Error("missing custom native tool");
    const internalExec = responsesToolCatalog.snapshot.tools.find(
      (tool) => tool.exposedName === "codex__functions__exec",
    );
    expect(internalExec).toBeDefined();
    expect(nativeCustom.name).toBe(internalExec?.tool.name);
    expect(nativeCustom.inputSchema).toEqual(internalExec?.tool.inputSchema);
    expect(nativeCustom.description).toBe("Execute native host tools");
    expect(responsesToolCatalog.snapshot.tools.map((tool) => tool.exposedName)).toContain(
      "native_probe",
    );
    expect(listed.tools.map((tool) => tool.name)).toContain("native_probe");
    expect(nativeCustom.description).toContain("native host tools");
    expect(nativeCustom.description).not.toContain("chrome__control_chrome");
    expect(nativeCustom.description).not.toContain("browser__control_in_app_browser");
    expect(nativeCustom.description).not.toContain("Playwright");
    expect(nativeCustom.description).not.toContain("entries from ALL_TOOLS directly");
    expect(nativeCustom.title).toBeUndefined();
    expect(nativeCustom.description).not.toContain("Use this direct action only");
    expect(nativeCustom.description).not.toContain("If another Codex action is also needed");
    const result = await client.callTool({
      name: nativeCustom.name,
      arguments: { input: 'text("native-ok")' },
    });
    expect(result.isError).not.toBe(true);
    executionStatus = "failed";
    const failed = await client.callTool({
      name: nativeCustom.name,
      arguments: { input: 'throw new Error("failed")' },
    });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toBeUndefined();
    expect(failed.content).toEqual([{ type: "text", text: "native-ok" }]);
    expect(failed._meta).toMatchObject({ omnicodex: { executionStatus: "failed" } });
    const internalProbe = await client.callTool({
      name: "native_probe",
      arguments: { value: "still-routable" },
    });
    expect(internalProbe.content).toEqual([{ type: "text", text: "probe-ok" }]);
    const structuredFailure = await client.callTool({
      name: "native_probe",
      arguments: { value: "throw-structured" },
    });
    expect(structuredFailure).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "structured native failure" }],
      structuredContent: {
        error: {
          name: "Error",
          message: "structured native failure",
          code: -32_041,
          data: { retryable: true, cursor: "resume-here" },
          rpcError: { code: -32_041, message: "RPC failed", data: { full: true } },
          cause: { name: "Error", message: "nested cause", code: "CAUSE_CODE" },
        },
      },
      _meta: {
        omnicodex: {
          error: {
            code: -32_041,
            data: { retryable: true, cursor: "resume-here" },
          },
        },
      },
    });
    expect(nested).toEqual([
      {
        name: "native_probe",
        argumentsValue: { value: "still-routable" },
        freeform: false,
      },
      {
        name: "native_probe",
        argumentsValue: { value: "throw-structured" },
        freeform: false,
      },
    ]);
    expect(legacyNestedCall).not.toHaveBeenCalled();
    expect(selected).toEqual([
      {
        kind: "custom",
        name: "exec",
        namespace: "functions",
        arguments: 'text("native-ok")',
      },
      {
        kind: "custom",
        name: "exec",
        namespace: "functions",
        arguments: 'throw new Error("failed")',
      },
    ]);

    await client.close();
    await handle.server.close();
  });

  it("uses one collision-free registry for full listing and generic reachability", async () => {
    const calls: unknown[] = [];
    let executionThreadStarts = 0;
    const appServer = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        if (method === "mcpServerStatus/list") {
          return {
            data: [
              {
                name: "demo",
                tools: {
                  shared: {
                    name: "shared",
                    annotations: { readOnlyHint: true },
                    inputSchema: {
                      type: "object",
                      properties: { downstream: { type: "boolean" } },
                      required: ["downstream"],
                    },
                  },
                },
              },
            ],
            nextCursor: null,
          } as T;
        }
        if (method === "thread/start") {
          executionThreadStarts += 1;
          return { thread: { id: "direct-thread" } } as T;
        }
        if (method === "mcpServer/tool/call") {
          const value = objectValue(params);
          calls.push({
            route: "downstream",
            server: value.server,
            tool: value.tool,
            args: value.arguments,
          });
          return { content: [{ type: "text", text: "downstream-ok" }] } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    const responsesSource = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [
          {
            type: "function",
            name: "shared",
            parameters: {
              type: "object",
              properties: { response: { type: "string" } },
              required: ["response"],
            },
          },
        ],
      },
      call: async (selection: unknown) => {
        calls.push({ route: "responses", selection });
        return {
          callId: "call-r",
          outputType: "function_call_output",
          executionStatus: "succeeded" as const,
          output: "r",
          rawItem: {},
        };
      },
      callMcp: async (server: string, tool: string, args: unknown) => {
        throw new Error(`Responses bridge must not call ${server}/${tool}: ${String(args)}`);
      },
    };
    const responsesToolCatalog = new ResponsesNativeToolCatalog(responsesSource);
    const responsesToolExecutor = new ResponsesNativeToolExecutor(responsesSource);
    const handle = createOmniCodexMcpServer({
      appServer,
      responsesToolCatalog,
      responsesToolExecutor,
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "registry-test-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const shared = listed.tools.filter((tool) =>
      ["shared", "codex__demo__shared"].includes(tool.name),
    );
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map((tool) => tool.name)).size).toBe(2);
    expect(shared.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["shared", "codex__demo__shared"]),
    );
    const responses = shared.find((tool) => tool.name === "shared");
    const downstream = shared.find((tool) => tool.name === "codex__demo__shared");
    if (responses === undefined || downstream === undefined) throw new Error("missing aliases");
    expect(responses.inputSchema).toMatchObject({
      type: "object",
      properties: {
        response: { type: "string" },
      },
      required: ["response"],
    });
    expect(downstream.inputSchema).toMatchObject({
      type: "object",
      properties: {
        downstream: { type: "boolean" },
      },
      required: ["downstream"],
    });

    expect(listed.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["search_native_tools", "call_native_tool", "app_server_rpc"]),
    );
    expect(listed.tools.map((tool) => tool.name)).not.toContain("call_native_read_tool");
    await client.close();
    await handle.server.close();

    const executionObservations: unknown[] = [];
    const compatHandle = createOmniCodexMcpServer({
      appServer,
      responsesToolCatalog: new ResponsesNativeToolCatalog(responsesSource),
      responsesToolExecutor,
      surface: "compat",
      observeNativeToolExecution: (observation) => {
        executionObservations.push(observation);
      },
    });
    const [compatClientTransport, compatServerTransport] = InMemoryTransport.createLinkedPair();
    const compatClient = new Client({ name: "generic-registry-client", version: "1.0.0" });
    await compatHandle.server.connect(compatServerTransport);
    await compatClient.connect(compatClientTransport);
    await compatClient.listTools();
    const searched = await compatClient.callTool({
      name: "search_native_tools",
      arguments: { query: "shared" },
    });
    const searchedTools = objectValue(searched.structuredContent).tools;
    expect(
      Array.isArray(searchedTools) ? searchedTools.map((item) => objectValue(item).name) : [],
    ).toEqual(expect.arrayContaining([responses.name, downstream.name]));
    const searchResults = Array.isArray(searchedTools)
      ? searchedTools.map((item) => objectValue(item))
      : [];
    expect(searchResults.every((item) => typeof item.toolId === "string")).toBe(true);
    const responsesCall = await compatClient.callTool({
      name: "call_native_tool",
      arguments: {
        name: responses.name,
        arguments: { response: "ok" },
      },
    });
    expect(responsesCall.isError).not.toBe(true);
    await compatClient.callTool({
      name: "call_native_tool",
      arguments: {
        toolId: objectValue(searchResults.find((item) => item.name === downstream.name)).toolId,
        arguments: { downstream: true },
        ordering: { threadId: "ordering-metadata-only" },
      },
    });
    expect(calls).toEqual([
      {
        route: "responses",
        selection: { kind: "function", name: "shared", arguments: { response: "ok" } },
      },
      { route: "downstream", server: "demo", tool: "shared", args: { downstream: true } },
    ]);
    expect(executionThreadStarts).toBe(1);
    expect(executionObservations).toEqual([
      expect.objectContaining({
        surface: "compat",
        mcpToolName: "search_native_tools",
        operation: "search",
        resultContentTypes: "text",
        resultSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        outcome: "succeeded",
      }),
      expect.objectContaining({
        surface: "compat",
        mcpToolName: "call_native_tool",
        operation: "native_call",
        targetNativeName: "shared",
        targetNamespace: "",
        targetRoute: "responses",
        modelEffect: "none",
        stateEffect: "mutate",
        outcome: "succeeded",
      }),
      expect.objectContaining({
        surface: "compat",
        mcpToolName: "call_native_tool",
        operation: "native_call",
        targetNativeName: "shared",
        targetNamespace: "demo",
        targetRoute: "downstream",
        modelEffect: "none",
        outcome: "succeeded",
      }),
    ]);
    expect(JSON.stringify(executionObservations)).not.toContain('downstream":true');
    expect(JSON.stringify(executionObservations)).not.toContain('response":"ok');
    expect(
      executionObservations.every((observation) => {
        const resultSha256 = objectValue(observation).resultSha256;
        return typeof resultSha256 === "string" && /^[a-f0-9]{64}$/u.test(resultSha256);
      }),
    ).toBe(true);

    await compatClient.close();
    await compatHandle.server.close();
  });

  it("correlates exact native resources across transports without observing raw arguments", async () => {
    const threadId = "thread-private-correlation-target";
    const path = "C:\\private\\workspace\\correlation-target.txt";
    const privateResult = "private-native-result-must-not-be-observed";
    const appServerCalls: Array<{ method: string; params: unknown }> = [];
    const appServer = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        appServerCalls.push({ method, params });
        if (method === "mcpServerStatus/list") {
          return { data: [], nextCursor: null } as T;
        }
        if (method === "thread/read") {
          return {
            thread: { id: threadId, cwd: "C:\\private\\workspace", status: { type: "idle" } },
          } as T;
        }
        if (method === "thread/turns/list") {
          return { data: [], nextCursor: null } as T;
        }
        if (method === "fs/getMetadata") {
          return { kind: "file", privateResult } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    const appServerMethodCatalog = new AppServerMethodCatalog({
      loadClientRequestSchema: async () => ({
        definitions: {
          FsGetMetadataParams: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
        oneOf: [requestSchema("Fs/getMetadataRequest", "fs/getMetadata", "FsGetMetadataParams")],
      }),
    });
    const observations: NativeToolExecutionObservation[] = [];
    const sharedReadInvocationId = "cross-transport-read-20260828-0001";
    const connections: Array<{
      client: Client;
      handle: ReturnType<typeof createOmniCodexMcpServer>;
    }> = [];
    const connect = async (correlationId: string) => {
      const handle = createOmniCodexMcpServer({
        appServer,
        appServerMethodCatalog,
        surface: "full",
        correlationId,
        observeNativeToolExecution: (observation) => {
          observations.push(observation);
        },
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: correlationId, version: "1.0.0" });
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      connections.push({ client, handle });
      return client;
    };
    const first = await connect("web-transport-a");
    const second = await connect("web-transport-b");
    const legacy = await connect("web-transport-without-invocation-id");
    try {
      const listed = await first.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["codex_app__read_thread", "codex__app_server__fs_getMetadata"]),
      );
      for (const [client, suffix] of [
        [first, "a"],
        [second, "b"],
      ] as const) {
        await client.callTool({
          name: "codex_app__read_thread",
          arguments: {
            threadId,
            turnLimit: 1,
            omnicodexInvocationId: sharedReadInvocationId,
          },
        });
        await client.callTool({
          name: "codex__app_server__fs_getMetadata",
          arguments: {
            path,
            omnicodexInvocationId: `transport-${suffix}-metadata-20260828`,
          },
        });
      }
      const compatibleRead = await legacy.callTool({
        name: "codex_app__read_thread",
        arguments: { threadId, turnLimit: 1 },
      });
      expect(compatibleRead.isError).not.toBe(true);

      const observed = (correlationId: string, mcpToolName: string) => {
        const observation = observations.find(
          (candidate) =>
            candidate.correlationId === correlationId && candidate.mcpToolName === mcpToolName,
        );
        if (observation === undefined) {
          throw new Error(`missing ${mcpToolName} observation for ${correlationId}`);
        }
        return observation;
      };
      const firstRead = observed("web-transport-a", "codex_app__read_thread");
      const secondRead = observed("web-transport-b", "codex_app__read_thread");
      const firstMetadata = observed("web-transport-a", "codex__app_server__fs_getMetadata");
      const secondMetadata = observed("web-transport-b", "codex__app_server__fs_getMetadata");
      const legacyRead = observed("web-transport-without-invocation-id", "codex_app__read_thread");
      const expectedReadDigest = directGoalResourceDigest(
        nativeExecutionOrderingFromArguments({ threadId }),
        "unused-read-fallback",
      );
      const expectedMetadataDigest = directGoalResourceDigest(
        nativeExecutionOrderingFromArguments({ path }),
        "unused-metadata-fallback",
      );

      expect(firstRead).toMatchObject({
        modelEffect: "none",
        stateEffect: "read",
        outcome: "succeeded",
        resourceDigestSha256: expectedReadDigest,
      });
      expect(secondRead.resourceDigestSha256).toBe(expectedReadDigest);
      const expectedInvocationDigest = createHash("sha256")
        .update(sharedReadInvocationId, "utf8")
        .digest("hex");
      expect(firstRead.invocationIdSha256).toBe(expectedInvocationDigest);
      expect(secondRead.invocationIdSha256).toBe(expectedInvocationDigest);
      expect(legacyRead.invocationIdSha256).toBeUndefined();
      expect(firstMetadata).toMatchObject({
        modelEffect: "none",
        stateEffect: "read",
        outcome: "succeeded",
        resourceDigestSha256: expectedMetadataDigest,
      });
      expect(secondMetadata.resourceDigestSha256).toBe(expectedMetadataDigest);
      expect(expectedReadDigest).not.toBe(expectedMetadataDigest);
      expect(expectedReadDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(expectedMetadataDigest).toMatch(/^[a-f0-9]{64}$/u);

      expect(appServerCalls.some((call) => call.method === "turn/start")).toBe(false);
      expect(JSON.stringify(appServerCalls)).not.toContain("omnicodexInvocationId");
      const serializedObservations = JSON.stringify(observations);
      expect(serializedObservations).not.toContain(threadId);
      expect(serializedObservations).not.toContain(path);
      expect(serializedObservations).not.toContain(privateResult);
      expect(serializedObservations).not.toContain(sharedReadInvocationId);
      expect(serializedObservations).not.toContain("transport-b-metadata-20260828");
    } finally {
      for (const connection of connections.reverse()) {
        await connection.client.close();
        await connection.handle.server.close();
      }
    }
  });

  it("keeps compat listing stable while generic calls reach collision-resolved tools", async () => {
    const selected: unknown[] = [];
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected method ${method}`);
      },
    };
    const source = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [
          {
            type: "custom",
            name: "native_custom",
            description: "Custom native call",
          },
        ],
      },
      call: async (selection: unknown) => {
        selected.push(selection);
        return {
          callId: "custom",
          outputType: "custom_tool_call_output",
          executionStatus: "succeeded" as const,
          output: "ok",
          rawItem: {},
        };
      },
    };
    const responsesToolCatalog = new ResponsesNativeToolCatalog(source);
    const handle = createOmniCodexMcpServer({
      appServer,
      responsesToolCatalog,
      responsesToolExecutor: new ResponsesNativeToolExecutor(source),
      surface: "compat",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "compat-registry-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    const advertisedTools = (await client.listTools()).tools;
    expect(advertisedTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "search_native_tools",
        "call_native_tool",
        "app_server_rpc",
        "native_custom",
      ]),
    );
    const searchDescriptor = advertisedTools.find((tool) => tool.name === "search_native_tools");
    const searchProperties = objectValue(searchDescriptor?.outputSchema?.properties);
    const matchProperties = objectValue(
      objectValue(objectValue(searchProperties.tools).items).properties,
    );
    expect(objectValue(matchProperties.executeWith).description).toContain(
      "Exact callable action name",
    );
    expect(objectValue(matchProperties.executeWith).description).not.toContain(
      "discovered action itself",
    );
    const search = await client.callTool({
      name: "search_native_tools",
      arguments: { query: "native_custom" },
    });
    const tools = objectValue(search.structuredContent).tools;
    const firstMatch = Array.isArray(tools) ? objectValue(tools[0]) : {};
    const name = firstMatch.name;
    if (typeof name !== "string") throw new Error("generic search did not return a name");
    expect(firstMatch.executeWith).toBe("call_native_tool");
    expect(firstMatch.executeArguments).toMatchObject({
      name,
      input: "Supply the exact freeform string here.",
    });
    await client.callTool({
      name: "call_native_tool",
      arguments: { name, input: "payload" },
    });
    expect(selected).toEqual([{ kind: "custom", name: "native_custom", arguments: "payload" }]);

    await client.close();
    await handle.server.close();
  });

  it("finds directly callable OmniCodex control tools through native search", async () => {
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected method ${method}`);
      },
    };
    const handle = createOmniCodexMcpServer({ appServer, surface: "compat" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "control-search-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      for (const name of [
        "codex__omnicodex__read_protected_result",
        "codex__omnicodex__session_identity",
        "codex__omnicodex__attach_local_file",
        "search_native_tools",
        "call_native_tool",
        "app_server_rpc",
      ]) {
        const result = await client.callTool({
          name: "search_native_tools",
          arguments: { query: name },
        });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(objectValue(result.structuredContent).tools).toEqual([
          expect.objectContaining({ name, executeWith: name }),
        ]);
      }
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("executes an oversized native action atomically through the stable router", async () => {
    const selected: unknown[] = [];
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected method ${method}`);
      },
    };
    const source = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [
          {
            type: "custom",
            name: "oversized_native_custom",
            description: `Oversized native descriptor ${"x".repeat(96 * 1_024)}`,
          },
        ],
      },
      call: async (selection: unknown) => {
        selected.push(selection);
        return {
          callId: "oversized-custom",
          outputType: "custom_tool_call_output",
          executionStatus: "succeeded" as const,
          output: "routed-ok",
          rawItem: {},
        };
      },
    };
    const responsesToolCatalog = new ResponsesNativeToolCatalog(source);
    const handle = createOmniCodexMcpServer({
      appServer,
      responsesToolCatalog,
      responsesToolExecutor: new ResponsesNativeToolExecutor(source),
      actionCatalogByteBudget: 64 * 1_024,
      resolveDurableWorkSessionBinding: () => ({
        workSessionBinding: "bounded-action-session",
        directGoalClaimantBinding: "bounded-action-claimant",
        directJobOwnerBinding: "bounded-action-owner",
        continuationToken: "bounded-action-continuation",
        journalCursor: "bounded-action-journal",
      }),
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bounded-action-catalog-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools();
      expect(listed.nextCursor).toBeUndefined();
      expect(listed.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["call_native_tool", "app_server_rpc"]),
      );
      expect(listed.tools.map((tool) => tool.name)).toContain("search_native_tools");
      expect(listed.tools.map((tool) => tool.name)).toContain("codex__omnicodex__session_identity");
      expect(listed.tools.map((tool) => tool.name)).not.toContain("oversized_native_custom");

      const identity = await client.callTool({
        name: "codex__omnicodex__session_identity",
        arguments: {},
      });
      expect(identity.isError).not.toBe(true);
      expect(identity.structuredContent).toMatchObject({
        workSessionBinding: "bounded-action-session",
        continuationToken: "bounded-action-continuation",
      });

      const search = await client.callTool({
        name: "search_native_tools",
        arguments: { query: "oversized_native_custom" },
      });
      expect(search.isError).not.toBe(true);
      const matches = objectValue(search.structuredContent).tools;
      expect(Array.isArray(matches)).toBe(true);
      const match = objectValue((matches as unknown[])[0]);
      expect(match.nativeTool).toEqual({
        ...source.snapshot.tools[0],
        annotations: ALL_FALSE_ANNOTATIONS,
      });
      expect(match.executeWith).toBe("call_native_tool");
      expect(match.executeArguments).toMatchObject({ name: "oversized_native_custom" });
      expect(selected).toEqual([]);

      const result = await client.callTool({
        name: String(match.executeWith),
        arguments: { ...objectValue(match.executeArguments), input: "payload" },
      });
      expect(result.isError).not.toBe(true);
      expect(selected).toEqual([
        { kind: "custom", name: "oversized_native_custom", arguments: "payload" },
      ]);
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("recovers an exact unknown Chrome mutation only after a fixed successful inspection", async () => {
    const directGoalStore = DirectGoalStore.inMemory();
    const browserCalls: Record<string, unknown>[] = [];
    const recoverUnknown = vi.fn(async (_operationId: string, _proveSettled: unknown) => true);
    const handle = createOmniCodexMcpServer({
      appServer: {
        request: async <T>(method: string): Promise<T> => {
          if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
          throw new Error(`unexpected method ${method}`);
        },
      },
      browserNativeExecutor: {
        call: async (argumentsValue: unknown) => {
          const args = objectValue(argumentsValue);
          browserCalls.push(args);
          if (args.operation === "exec") throw new Error("native browser owner disappeared");
          return { content: [{ type: "text", text: "fresh exact tab state" }] };
        },
      },
      directGoalStore,
      nativeResourceLeaseCoordinator: {
        acquire: async () => {
          throw new Error("MCP server must not acquire the scheduler-owned lease directly");
        },
        interruptOwnedOperations: async () => 0,
        recoverUnknown,
      },
      mutationReplayStore: MutationReplayStore.inMemory(),
      legacyMutationCoordinator: LegacyMutationCoordinator.inMemory(),
      authorizationBinding: "issuer\0owner\0client\0browser-recovery",
      resolveDurableWorkSessionBinding: () => ({
        workSessionBinding: "browser-recovery-work-session",
        directGoalClaimantBinding: "browser-recovery-claimant",
        directJobOwnerBinding: "browser-recovery-job-owner",
        continuationToken: "browser-recovery-continuation",
        journalCursor: "browser-recovery-cursor",
      }),
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "browser-recovery-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const created = await client.callTool({
        name: "omnicodex__goal_create",
        arguments: { objective: "Recover the exact browser operation without replay." },
      });
      const goalId = String(objectValue(created.structuredContent).id);
      const mutation = await client.callTool({
        name: "chrome__control_chrome",
        arguments: {
          operation: "exec",
          code: "return await state.tab.click();",
          target_tab_id: "tab-verified",
          omnicodexInvocationId: "unknown-browser-mutation",
        },
      });
      expect(mutation.isError).toBe(true);
      expect(mutation.content).toEqual([
        { type: "text", text: expect.stringContaining("MUTATION_OUTCOME_UNKNOWN") },
      ]);
      expect(browserCalls).toHaveLength(1);

      const inspection = await client.callTool({
        name: "chrome__control_chrome",
        arguments: {
          operation: "inspect",
          target_tab_id: "tab-verified",
          code: "return 'must not determine execution semantics'",
          omnicodexInvocationId: "browser-readback-proof",
        },
      });
      expect(inspection.isError).not.toBe(true);
      expect(browserCalls).toEqual([
        {
          operation: "exec",
          code: "return await state.tab.click();",
          target_tab_id: "tab-verified",
          surface: "chrome",
        },
        {
          operation: "inspect",
          target_tab_id: "tab-verified",
          code: "return 'must not determine execution semantics'",
          surface: "chrome",
        },
      ]);
      expect(recoverUnknown).toHaveBeenCalledTimes(1);
      expect(recoverUnknown.mock.calls[0]?.[0]).toEqual(expect.any(String));

      const readback = await client.callTool({
        name: "omnicodex__goal_get",
        arguments: { goalId },
      });
      const steps = objectValue(readback.structuredContent).steps as unknown[];
      expect(steps).toEqual([
        expect.objectContaining({
          state: "completed",
          receipts: [
            expect.objectContaining({
              toolName: "chrome__control_chrome",
              stateEffect: "read",
            }),
          ],
        }),
      ]);
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("advertises actual Chrome and in-app browser as direct first-party browser tools", async () => {
    const browserCalls: unknown[] = [];
    const browserContexts: unknown[] = [];
    const begunBrowserActivities: unknown[] = [];
    const nativeObservations: NativeToolExecutionObservation[] = [];
    const catalogObservations: McpToolCatalogObservation[] = [];
    const progressObservations: McpProgressObservation[] = [];
    const resultDeliveryObservations: McpResultDeliveryObservation[] = [];
    const chatGptConversationIdSha256 = "a".repeat(64);
    const chatGptConversationId = "6a92f0cc-f400-83e8-807b-7e4806de7f4b";
    let requestAttributionCount = 0;
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected method ${method}`);
      },
    };
    const handle = createOmniCodexMcpServer({
      appServer,
      browserNativeExecutor: {
        beginActivity: async (activityBinding: string, context?: unknown) => {
          begunBrowserActivities.push({ activityBinding, context });
        },
        finishActivity: async () => undefined,
        call: async (argumentsValue: unknown, context?: unknown) => {
          expect(progressObservations.at(-1)).toMatchObject({
            phase: "started",
            mcpArgumentsSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          });
          browserCalls.push(argumentsValue);
          browserContexts.push(context);
          return { content: [{ type: "text", text: "browser-ok" }] };
        },
      },
      browserActivityCoordinator: {
        observeActivityBoundary: async () => undefined,
        coordinate: async (executor, context) => {
          const { chatGptConversationId: _exactConversationId, ...safeContext } = context;
          const activityBinding = "turn:coordinated-chatgpt-activity";
          await executor.beginActivity(activityBinding, {
            ...safeContext,
            continueExistingActivity: true,
          });
          return {
            ...safeContext,
            activityBinding,
            continueExistingActivity: true,
          };
        },
        close: async () => undefined,
      },
      resolveRequestAttribution: () => {
        requestAttributionCount += 1;
        return {
          principalBindingSha256: "principal-browser-owner",
          callerProvenance: "chatgpt_conversation" as const,
          chatGptConversationIdSha256,
          chatGptConversationUrl: `https://chatgpt.com/c/${chatGptConversationId}`,
          jsonRpcIdHmac: "browser-json-rpc-id-hmac",
          transportIdentityDigests: [
            {
              name: "meta:io.modelcontextprotocol/related-task",
              valueHmac: "browser-related-task-hmac",
            },
            {
              name: "header:traceparent-trace-id",
              valueHmac: `per-call-trace-${requestAttributionCount}`,
            },
          ],
        };
      },
      observeNativeToolExecution: (observation) => {
        nativeObservations.push(observation);
      },
      observeToolCatalog: (observation) => {
        catalogObservations.push(observation);
      },
      observeProgress: (observation) => {
        progressObservations.push(observation);
      },
      observeResultDelivery: (observation) => {
        resultDeliveryObservations.push(observation);
      },
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "browser-native-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "browser__list_surfaces",
        "chrome__list_user_tabs",
        "chrome__control_chrome",
        "browser__control_in_app_browser",
      ]),
    );
    expect(catalogObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: "full",
          principalBindingSha256: "principal-browser-owner",
          callerProvenance: "chatgpt_conversation",
          chatGptConversationIdSha256,
          jsonRpcIdHmac: "browser-json-rpc-id-hmac",
        }),
      ]),
    );
    const listedChrome = listed.tools.find((tool) => tool.name === "chrome__control_chrome");
    const listedIab = listed.tools.find((tool) => tool.name === "browser__control_in_app_browser");
    const listedChromeTabs = listed.tools.find((tool) => tool.name === "chrome__list_user_tabs");
    expect(listedChromeTabs?.description).toContain("profile-wide native tab inventory");
    expect(listedChromeTabs?.description).toContain(
      "does not prove that the group is visible in the current foreground window",
    );
    expect(listedChromeTabs?.description).toContain("read or operate a selected tab");
    expect(listedChrome?.description).toContain(
      "Reads and interacts with the installed extension-backed signed-in Chrome profile",
    );
    expect(listedChrome?.description).toContain(
      "does not require its conversation tab to be open in Chrome",
    );
    expect(listedChrome?._meta?.omnicodex).not.toHaveProperty("ownerSessionMessageAuthorization");
    expect(listedIab?._meta?.omnicodex).not.toHaveProperty("ownerSessionMessageAuthorization");
    const searchedChromeTabs = await client.callTool({
      name: "search_native_tools",
      arguments: { query: "chrome__list_user_tabs" },
    });
    const searchedBrowserTools = objectValue(searchedChromeTabs.structuredContent).tools;
    const searchedChromeTabsDescriptor = Array.isArray(searchedBrowserTools)
      ? searchedBrowserTools
          .map((value) => objectValue(value))
          .find((value) => value.name === "chrome__list_user_tabs")
      : undefined;
    expect(objectValue(searchedChromeTabsDescriptor?.nativeTool).description).toBe(
      listedChromeTabs?.description,
    );
    for (const tool of [listedChrome, listedIab]) {
      const codeDescription = objectValue(
        objectValue(objectValue(tool?.inputSchema).properties).code,
      ).description;
      expect(
        objectValue(objectValue(objectValue(tool?.inputSchema).properties).operation).enum,
      ).toEqual(expect.arrayContaining(["documentation"]));
      expect(tool?.description).toContain("operation=documentation");
      expect(tool?.description).toContain("requested browser action");
      expect(tool?.description).not.toContain("complete persistent");
      expect(tool?.description).not.toContain("Never");
      expect(tool?.description).not.toContain("OmniCodex execution contract");
      expect(codeDescription).toContain("selected browser binding");
      expect(codeDescription).toContain("live API reference");
      expect(codeDescription).not.toContain("source-conversation label");
      expect(codeDescription).not.toContain("committed-turn readback");
    }
    expect(listedChrome?.description).toContain("signed-in Chrome profile");
    expect(listedIab?.description).toContain("Codex task's in-app browser");
    expect(listedChrome?.description).not.toContain("source conversation");
    expect(listedChrome?._meta?.omnicodex).toMatchObject({
      toolId: expect.any(String),
      catalogRevision: expect.any(String),
    });
    expect(listedChrome?._meta?.omnicodex).not.toHaveProperty("stateEffect");
    expect(listedIab?._meta?.omnicodex).toMatchObject({
      toolId: expect.any(String),
      catalogRevision: expect.any(String),
    });
    expect(listedIab?._meta?.omnicodex).not.toHaveProperty("stateEffect");
    expect(listedChrome?.inputSchema.required).toEqual(["operation"]);
    expect(listedIab?.inputSchema.required).toEqual(["operation", "contextThreadId"]);
    expect(listedIab?.inputSchema.oneOf).toBeUndefined();
    expect(
      objectValue(objectValue(listedIab?.inputSchema).properties).contextThreadId,
    ).toMatchObject({ type: "string", minLength: 1 });
    expect(
      objectValue(objectValue(listedChrome?.inputSchema).properties).contextThreadId,
    ).toBeUndefined();
    const missingIabContext = await client.callTool({
      name: "browser__control_in_app_browser",
      arguments: { operation: "exec", code: "return await browser.tabs.list();" },
    });
    expect(missingIabContext.isError).toBe(true);
    expect(missingIabContext.content).toEqual([
      { type: "text", text: expect.stringContaining("IAB_CONTEXT_THREAD_ID_REQUIRED") },
    ]);
    expect(browserCalls).toEqual([]);
    await client.callTool({ name: "browser__list_surfaces", arguments: {} });
    await client.callTool({
      name: "chrome__list_user_tabs",
      arguments: { timeout_ms: 9_000, title: "visible tabs" },
    });
    await client.callTool({
      name: "chrome__control_chrome",
      arguments: { operation: "list_user_tabs", timeout_ms: 10_000 },
    });
    const chromeResult = await client.callTool({
      name: "chrome__control_chrome",
      arguments: { operation: "exec", code: "return await browser.user.openTabs();" },
    });
    await client.callTool({
      name: "browser__control_in_app_browser",
      arguments: {
        operation: "exec",
        code: "return await browser.tabs.list();",
        contextThreadId: "iab-desktop-task",
      },
    });

    expect(browserCalls).toEqual([
      { operation: "list_surfaces" },
      {
        operation: "list_user_tabs",
        surface: "chrome",
        timeout_ms: 9_000,
        title: "visible tabs",
      },
      {
        operation: "list_user_tabs",
        surface: "chrome",
        timeout_ms: 10_000,
      },
      {
        operation: "exec",
        surface: "chrome",
        code: "return await browser.user.openTabs();",
      },
      {
        operation: "exec",
        surface: "iab",
        code: "return await browser.tabs.list();",
      },
    ]);
    expect(browserContexts[4]).toMatchObject({
      contextThreadId: "iab-desktop-task",
      activityBinding: "turn:coordinated-chatgpt-activity",
      signal: expect.any(AbortSignal),
    });
    expect(browserContexts[3]).toMatchObject({
      activityBinding: "turn:coordinated-chatgpt-activity",
      callerProvenance: "chatgpt_conversation",
      chatGptConversationIdSha256,
      callerActivityBinding: "related-task:browser-related-task-hmac",
      callerActivityBindingKind: "related_task",
      signal: expect.any(AbortSignal),
    });
    expect(objectValue(objectValue(chromeResult._meta).omnicodex)).toMatchObject({
      chatGptConversationIdSha256,
    });
    expect(nativeObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mcpToolName: "chrome__control_chrome",
          principalBindingSha256: "principal-browser-owner",
          callerProvenance: "chatgpt_conversation",
          chatGptConversationIdSha256,
          jsonRpcIdHmac: "browser-json-rpc-id-hmac",
          transportIdentityDigests: expect.arrayContaining([
            expect.objectContaining({ name: "header:traceparent-trace-id" }),
          ]),
          outcome: "succeeded",
        }),
      ]),
    );
    expect(progressObservations.length).toBeGreaterThan(0);
    expect(progressObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mcpToolName: "chrome__control_chrome",
          phase: "started",
          mcpArgumentsSha256: createHash("sha256")
            .update(
              JSON.stringify({
                present: true,
                value: { code: "return await browser.user.openTabs();", operation: "exec" },
              }),
            )
            .digest("hex"),
          principalBindingSha256: "principal-browser-owner",
          callerProvenance: "chatgpt_conversation",
          chatGptConversationIdSha256,
          jsonRpcIdHmac: "browser-json-rpc-id-hmac",
        }),
        expect.objectContaining({
          mcpToolName: "chrome__control_chrome",
          phase: "completed",
          principalBindingSha256: "principal-browser-owner",
          callerProvenance: "chatgpt_conversation",
          chatGptConversationIdSha256,
          jsonRpcIdHmac: "browser-json-rpc-id-hmac",
        }),
      ]),
    );
    expect(resultDeliveryObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mcpToolName: "chrome__control_chrome",
          principalBindingSha256: "principal-browser-owner",
          callerProvenance: "chatgpt_conversation",
          chatGptConversationIdSha256,
          jsonRpcIdHmac: "browser-json-rpc-id-hmac",
          deliveredByteLength: expect.any(Number),
          nativeBrowserPreviewDetached: false,
        }),
      ]),
    );
    expect(begunBrowserActivities).toHaveLength(browserCalls.length);
    expect(begunBrowserActivities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activityBinding: "turn:coordinated-chatgpt-activity",
          context: expect.objectContaining({
            continueExistingActivity: true,
          }),
        }),
      ]),
    );
    await expect(handle.classifyToolCall("chrome__control_chrome", {})).resolves.toBe("non_model");

    await client.close();
    await handle.server.close();
  });

  it("recovers exact Chrome conversation attribution from the active Goal work session", async () => {
    const authorizationBinding = "issuer\0owner\0client\0goal-browser-attribution";
    const workSessionBinding = "goal-browser-attribution-session";
    const conversationId = "6aa03fe0-567c-83e8-bc89-abe1c2d0593d";
    const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
    const conversationIdSha256 = createHash("sha256").update(conversationId, "utf8").digest("hex");
    const goalStore = DirectGoalStore.inMemory();
    const goalOwnerBinding = directGoalOwnerBinding(authorizationBinding, workSessionBinding);
    const goal = await goalStore.create({
      authorizationBinding: goalOwnerBinding,
      objective: "Continue the exact travel conversation in its Chrome window",
    });
    await goalStore.observeConversation({
      conversationUrl,
      goals: [
        {
          messageId: `goal-${goal.id}`,
          toolName: "omnicodex__goal_create",
          goalId: goal.id,
          state: goal.state,
          revision: goal.revision,
          createdAtUnixMs: goal.createdAtUnixMs,
        },
      ],
    });
    const listGoals = vi.spyOn(goalStore, "list");
    const coordinatedContexts: Record<string, unknown>[] = [];
    const browserContexts: Record<string, unknown>[] = [];
    let browserActivityHeld = false;
    const recoverUnknownResources = vi.fn(
      async (
        _resourceKeys: readonly string[],
        _proveSettled: (lease: DurableNativeResourceLeaseView) => Promise<boolean>,
      ) => 1,
    );
    const scheduler = new NativeExecutionScheduler({
      resourceLeaseCoordinator: {
        acquire: async () => {
          throw new Error("read-only browser inventory must not acquire a mutation lease");
        },
        interruptOwnedOperations: async () => 0,
        recoverUnknownResources,
      },
    });
    const handle = createOmniCodexMcpServer({
      appServer: {
        request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T,
      },
      browserNativeExecutor: {
        beginActivity: async () => undefined,
        finishActivity: async () => undefined,
        call: async (_argumentsValue, context) => {
          expect(browserActivityHeld).toBe(true);
          browserContexts.push(objectValue(context));
          return { content: [{ type: "text" as const, text: "chrome-ok" }] };
        },
      },
      browserActivityCoordinator: {
        observeActivityBoundary: async () => undefined,
        coordinate: async (_executor, context) => context,
        runWithActivity: async (_executor, context, operation) => {
          coordinatedContexts.push(objectValue(context));
          const { chatGptConversationId: _conversationId, ...safeContext } = context;
          browserActivityHeld = true;
          try {
            return await operation(safeContext);
          } finally {
            browserActivityHeld = false;
          }
        },
        close: async () => undefined,
      },
      directGoalStore: goalStore,
      scheduler,
      mutationReplayStore: MutationReplayStore.inMemory(),
      authorizationBinding,
      resolveDurableWorkSessionBinding: () => ({
        workSessionBinding,
        directGoalClaimantBinding: "goal-browser-attribution-claimant",
        directJobOwnerBinding: "goal-browser-attribution-job-owner",
        continuationToken: "goal-browser-attribution-continuation",
        journalCursor: "goal-browser-attribution-cursor",
      }),
      resolveRequestAttribution: () => ({
        principalBindingSha256: "goal-browser-principal",
        callerProvenance: "chatgpt_conversation",
        jsonRpcIdHmac: "goal-browser-json-rpc-id",
        transportIdentityDigests: [
          {
            name: "meta:io.modelcontextprotocol/related-task",
            valueHmac: "opaque-related-task",
          },
        ],
      }),
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "goal-browser-attribution-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "chrome__list_user_tabs",
        arguments: {},
      });

      expect(result.isError).not.toBe(true);
      expect(listGoals).toHaveBeenCalledWith([goalOwnerBinding], ["active"]);
      expect(coordinatedContexts).toEqual([
        expect.objectContaining({
          callerProvenance: "chatgpt_conversation",
          ownerBinding: authorizationBinding,
          workSessionBinding,
          chatGptConversationId: conversationId,
          chatGptConversationIdSha256: conversationIdSha256,
        }),
      ]);
      expect(browserContexts).toEqual([
        expect.objectContaining({
          callerProvenance: "chatgpt_conversation",
          ownerBinding: authorizationBinding,
          workSessionBinding,
          chatGptConversationIdSha256: conversationIdSha256,
          signal: expect.any(AbortSignal),
        }),
      ]);
      expect(browserContexts[0]).not.toHaveProperty("chatGptConversationId");
      expect(browserActivityHeld).toBe(false);
      expect(recoverUnknownResources).toHaveBeenCalledOnce();
      expect(recoverUnknownResources.mock.calls[0]?.[0]).toEqual(
        expect.arrayContaining([expect.stringContaining("lane:ui")]),
      );
      expect(objectValue(objectValue(result._meta).omnicodex)).toMatchObject({
        chatGptConversationIdSha256: conversationIdSha256,
      });
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("binds remote IAB execution to server-derived owner and durable work session", async () => {
    const calls: Array<{ argumentsValue: unknown; context: unknown }> = [];
    const handle = createOmniCodexMcpServer({
      appServer: {
        request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T,
      },
      browserNativeExecutor: {
        call: async (argumentsValue, context) => {
          calls.push({ argumentsValue, context });
          return { content: [{ type: "text" as const, text: "iab-ok" }] };
        },
      },
      surface: "full",
      correlationId: "transport-browser-session",
      authorizationBinding: "authoritative-owner-binding",
      mutationReplayStore: MutationReplayStore.inMemory(),
      resolveDurableWorkSessionBinding: () => ({
        workSessionBinding: "authoritative-work-session",
        directGoalClaimantBinding: "authoritative-work-session",
        directJobOwnerBinding: "authoritative-work-session",
        continuationToken: "continuation-token",
        journalCursor: "journal-cursor",
      }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "browser-identity-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "browser__control_in_app_browser",
        arguments: {
          code: "return await browser.tabs.list();",
          contextThreadId: "desktop-owned-task",
          ownerBinding: "spoofed-owner",
          workSessionBinding: "spoofed-work-session",
          omnicodexInvocationId: "iab-owner-bound-call",
        },
      });
      expect(result.isError).not.toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.argumentsValue).toEqual({
        operation: "list_tabs",
        surface: "iab",
        code: "return await browser.tabs.list();",
      });
      expect(calls[0]?.context).toMatchObject({
        contextThreadId: "desktop-owned-task",
        ownerBinding: "authoritative-owner-binding",
        workSessionBinding: "authoritative-work-session",
        callerSessionId: "transport-browser-session",
        operationId: expect.any(String),
        signal: expect.any(AbortSignal),
      });
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("returns the advertised Chrome action directly and keeps the router as a fallback", async () => {
    const browserCalls: unknown[] = [];
    const browserContexts: unknown[] = [];
    const appServer = {
      request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T,
    };
    const handle = createOmniCodexMcpServer({
      appServer,
      browserNativeExecutor: {
        call: async (argumentsValue: unknown, context?: unknown) => {
          browserCalls.push(argumentsValue);
          browserContexts.push(context);
          return { content: [{ type: "text", text: "chrome-ok" }] };
        },
      },
      surface: "compat",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "compat-browser-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "search_native_tools",
        "call_native_tool",
        "app_server_rpc",
        "chrome__control_chrome",
      ]),
    );
    const search = await client.callTool({
      name: "search_native_tools",
      arguments: { query: "chrome__control_chrome" },
    });
    const matches = objectValue(search.structuredContent).tools;
    const chrome = Array.isArray(matches) ? objectValue(matches[0]) : {};
    expect(chrome).toMatchObject({
      name: "chrome__control_chrome",
      nativeName: "chrome/control",
      route: "browser_native",
      executeWith: "call_native_tool",
      executeArguments: {
        name: "chrome__control_chrome",
        arguments: "Supply target arguments matching nativeTool.inputSchema here.",
      },
    });
    expect(objectValue(chrome.nativeTool).description).not.toContain(
      "OmniCodex execution contract",
    );
    const direct = await client.callTool({
      name: "chrome__control_chrome",
      arguments: { operation: "exec", code: "return await browser.tabs.list();" },
    });
    expect(direct.isError).not.toBe(true);
    const routed = await client.callTool({
      name: "call_native_tool",
      arguments: {
        toolId: chrome.toolId,
        expectedCatalogRevision: chrome.catalogRevision,
        arguments: { code: "return await browser.tabs.list();" },
      },
    });
    expect(routed.isError).not.toBe(true);
    const iabSearch = await client.callTool({
      name: "search_native_tools",
      arguments: { query: "browser__control_in_app_browser" },
    });
    const iabMatches = objectValue(iabSearch.structuredContent).tools;
    const iab = Array.isArray(iabMatches) ? objectValue(iabMatches[0]) : {};
    expect(objectValue(objectValue(iab.nativeTool).inputSchema).required).toEqual([
      "operation",
      "contextThreadId",
    ]);
    const routedIab = await client.callTool({
      name: "call_native_tool",
      arguments: {
        toolId: iab.toolId,
        expectedCatalogRevision: iab.catalogRevision,
        arguments: {
          code: "return await browser.tabs.list();",
          contextThreadId: "compat-iab-task",
        },
      },
    });
    expect(routedIab.isError).not.toBe(true);
    expect(browserCalls).toEqual([
      {
        operation: "exec",
        surface: "chrome",
        code: "return await browser.tabs.list();",
      },
      {
        operation: "list_tabs",
        surface: "chrome",
        code: "return await browser.tabs.list();",
      },
      {
        operation: "list_tabs",
        surface: "iab",
        code: "return await browser.tabs.list();",
      },
    ]);
    expect(browserContexts[2]).toMatchObject({
      contextThreadId: "compat-iab-task",
      signal: expect.any(AbortSignal),
    });

    await client.close();
    await handle.server.close();
  });

  it("never loops stable Codex host tools through a nested Responses model call", async () => {
    const nestedCalls: Array<{ name: string; args: unknown }> = [];
    const appServer = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        if (method === "thread/list") {
          if (
            (params as Record<string, unknown>).sectionId === "01984de2-8f74-7c91-a3b2-5c5e937cf318"
          ) {
            return { data: [], nextCursor: null } as T;
          }
          return {
            data: [{ id: "target-1", cwd: "C:\\workspace", status: { type: "notLoaded" } }],
            nextCursor: null,
          } as T;
        }
        if (method === "thread/read") {
          return {
            thread: {
              id: "target-1",
              cwd: "C:\\workspace",
              status: { type: "notLoaded" },
            },
          } as T;
        }
        if (method === "thread/turns/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected method ${method}`);
      },
    };
    const source = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [],
        nestedTools: [
          {
            name: "codex_app__list_threads",
            description: "List Codex threads across the local host and connected remote hosts.",
          },
          {
            name: "codex_app__read_thread",
            description:
              "Read recent status and turn summaries for one Codex thread without opening it.",
          },
          {
            name: "codex_app__send_message_to_thread",
            description: "Send a follow-up prompt to an existing Codex thread in the background.",
          },
        ],
      },
      call: async () => {
        throw new Error("direct Codex host tools must use functions.exec nested dispatch");
      },
      callNested: async (name: string, args: unknown) => {
        nestedCalls.push({ name, args });
        return name === "codex_app__send_message_to_thread"
          ? { threadId: "target-1", status: "queued" }
          : { native: name };
      },
    };
    const desktopIpcClient = {
      sendFollowUpMessage: async (threadId: string) => ({
        threadId,
        ownerClientId: "native-owner",
        disposition: "started" as const,
        nativeResult: { turn: { id: "turn-native" } },
        transport: "desktop_ipc" as const,
      }),
    };
    const handle = createOmniCodexMcpServer({
      appServer,
      desktopIpcClient,
      responsesToolCatalog: new ResponsesNativeToolCatalog(source),
      responsesToolExecutor: new ResponsesNativeToolExecutor(source),
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "native-codex-app-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "codex_app__list_threads",
        "codex_app__read_thread",
        "codex_app__send_message_to_thread",
      ]),
    );
    expect(listed.tools.map((tool) => tool.name)).toContain("search_native_tools");
    expect(listed.tools.map((tool) => tool.name)).not.toContain("call_native_read_tool");
    expect(listed.tools.map((tool) => tool.name)).toContain("call_native_tool");

    const directList = await client.callTool({
      name: "codex_app__list_threads",
      arguments: { limit: 50 },
    });
    const routedList = await client.callTool({
      name: "call_native_tool",
      arguments: {
        name: "codex_app__list_threads",
        arguments: { limit: 50 },
      },
    });
    expect(routedList.content).toEqual(directList.content);
    expect(routedList.structuredContent).toEqual(directList.structuredContent);
    expect(objectValue(routedList._meta?.omnicodex)).toEqual(
      objectValue(directList._meta?.omnicodex),
    );
    expect(objectValue(directList._meta?.omnicodex)).toEqual({});
    await client.callTool({
      name: "codex_app__read_thread",
      arguments: {
        threadId: "target-1",
        hostId: "local",
        turnLimit: 10,
        includeOutputs: true,
        maxOutputCharsPerItem: 2_000,
      },
    });
    const sent = await client.callTool({
      name: "codex_app__send_message_to_thread",
      arguments: { threadId: "target-1", prompt: "기존 목표를 이어서 수행해 주세요." },
    });
    expect(sent.structuredContent).toMatchObject({
      threadId: "target-1",
      disposition: "started",
      transport: "desktop_ipc",
      clientUserMessageId: expect.any(String),
    });
    expect(nestedCalls).toEqual([]);

    await client.close();
    await handle.server.close();
  });

  it("sends desktop-owned task messages through Codex IPC without resuming a private App Server", async () => {
    const appServerCalls: Array<{ method: string; params: unknown }> = [];
    const desktopCalls: Array<{ threadId: string; prompt: string; options: unknown }> = [];
    const catalogObservations: unknown[] = [];
    const appServer = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        appServerCalls.push({ method, params });
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        if (method === "thread/list") {
          return {
            data: [
              {
                id: "desktop-thread",
                cwd: "C:\\workspace",
                latestModel: "gpt-5.6-terra",
                latestReasoningEffort: "medium",
                status: { type: "notLoaded" },
              },
            ],
          } as T;
        }
        if (method === "thread/read") {
          return {
            thread: {
              id: "desktop-thread",
              cwd: "C:\\workspace",
              latestModel: "gpt-5.6-terra",
              latestReasoningEffort: "medium",
              status: { type: "notLoaded" },
            },
          } as T;
        }
        if (method === "thread/turns/list") {
          return { data: [], nextCursor: null } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    const desktopIpcClient = {
      sendFollowUpMessage: async (threadId: string, prompt: string, options: unknown) => {
        desktopCalls.push({ threadId, prompt, options });
        return {
          threadId,
          ownerClientId: "desktop-owner",
          disposition: "started" as const,
          nativeResult: { turn: { id: "turn-new" } },
        };
      },
    };
    const handle = createOmniCodexMcpServer({
      appServer,
      desktopIpcClient,
      surface: "full",
      mutationReplayStore: MutationReplayStore.inMemory(),
      legacyMutationCoordinator: LegacyMutationCoordinator.inMemory(),
      authorizationBinding: "https://issuer.example\0owner-subject\0client\0omnicodex",
      correlationId: "catalog-proof-session",
      observeToolCatalog: (observation) => {
        catalogObservations.push(observation);
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "desktop-ipc-thread-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(catalogObservations).toEqual([
      expect.objectContaining({
        correlationId: "catalog-proof-session",
        surface: "full",
        cursorPresent: false,
        criticalToolCount: 0,
      }),
    ]);
    const sendTool = listed.tools.find((tool) => tool.name === "codex_app__send_message_to_thread");
    expect(sendTool).toMatchObject({
      inputSchema: {
        required: ["threadId", "prompt"],
        additionalProperties: false,
        properties: {
          model: { type: "string" },
          thinking: {
            type: "string",
            enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
          },
        },
      },
    });
    expect(Object.keys(objectValue(objectValue(sendTool?.inputSchema).properties)).sort()).toEqual([
      "hostId",
      "model",
      "prompt",
      "thinking",
      "threadId",
    ]);
    expect(sendTool?._meta?.omnicodex).toMatchObject({
      toolId: expect.any(String),
      catalogRevision: expect.any(String),
    });
    expect(sendTool?._meta?.omnicodex).not.toHaveProperty("stateEffect");
    await expect(
      handle.classifyToolCall("codex_app__send_message_to_thread", {
        threadId: "desktop-thread",
        prompt: "계속 진행해 주세요.",
      }),
    ).resolves.toBe("model");

    const read = await client.callTool({
      name: "codex_app__read_thread",
      arguments: { threadId: "desktop-thread", hostId: "local" },
    });
    expect(read.structuredContent).toMatchObject({
      thread: { id: "desktop-thread", cwd: "C:\\workspace", hostId: "local" },
      page: { order: "newest_first", hasMore: false },
      turns: [],
    });

    const sent = await client.callTool({
      name: "codex_app__send_message_to_thread",
      arguments: {
        threadId: "desktop-thread",
        prompt: "계속 진행해 주세요.",
        model: "gpt-5.6-sol",
        thinking: "xhigh",
      },
    });
    expect(sent.structuredContent).toMatchObject({
      threadId: "desktop-thread",
      disposition: "started",
      clientUserMessageId: expect.any(String),
    });
    expect(desktopCalls).toHaveLength(1);
    expect(desktopCalls[0]).toMatchObject({
      threadId: "desktop-thread",
      prompt: "계속 진행해 주세요.",
      options: {
        hostId: "local",
        cwd: "C:\\workspace",
        threadSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
        clientUserMessageId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        ),
      },
    });
    expect(appServerCalls.filter((call) => call.method === "thread/read")).toHaveLength(2);
    expect(
      appServerCalls.some((call) =>
        ["thread/resume", "turn/start", "turn/steer"].includes(call.method),
      ),
    ).toBe(false);

    await client.close();
    await handle.server.close();
  });

  it("keeps list and read available through the installed App Server when Responses host tools are absent", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const appServer = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        if (method === "thread/list") {
          if (
            (params as Record<string, unknown>).sectionId === "01984de2-8f74-7c91-a3b2-5c5e937cf318"
          ) {
            return { data: [], nextCursor: null } as T;
          }
          return {
            data: [
              {
                id: "thread-1",
                name: "실제 지원서 관련",
                preview: "최근 상태",
                projectId: "project-1",
                cwd: "C:\\work",
                status: { type: "active", activeFlags: [] },
                updatedAt: 123,
                turns: [],
              },
            ],
          } as T;
        }
        if (method === "thread/read") {
          return {
            thread: {
              id: "thread-1",
              name: "실제 지원서 관련",
              preview: "최근 상태",
              cwd: "C:\\work",
              status: { type: "active", activeFlags: [] },
              createdAt: 100,
              updatedAt: 123,
              turns: [],
            },
          } as T;
        }
        if (method === "thread/turns/list") {
          return {
            data: [{ id: "turn-new", status: "inProgress", items: [] }],
            nextCursor: "turn-old",
          } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    const source = {
      snapshot: { refreshedAtUnixMs: 1, requestCount: 1, tools: [], nestedTools: [] },
      call: async () => {
        throw new Error("Responses must not be used for the App Server fallback");
      },
    };
    const handle = createOmniCodexMcpServer({
      appServer,
      responsesToolCatalog: new ResponsesNativeToolCatalog(source),
      responsesToolExecutor: new ResponsesNativeToolExecutor(source),
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "app-server-codex-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    const listedTools = await client.listTools();
    expect(listedTools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["codex_app__list_threads", "codex_app__read_thread"]),
    );
    const listed = await client.callTool({
      name: "codex_app__list_threads",
      arguments: { limit: 50 },
    });
    expect(listed.structuredContent).toMatchObject({
      threads: [
        {
          id: "thread-1",
          title: "실제 지원서 관련",
          hostId: "local",
          status: "active",
        },
      ],
    });
    const read = await client.callTool({
      name: "codex_app__read_thread",
      arguments: { threadId: "thread-1", hostId: "local", turnLimit: 1 },
    });
    expect(read.structuredContent).toMatchObject({
      thread: { id: "thread-1", title: "실제 지원서 관련", hostId: "local" },
      page: { order: "newest_first", limit: 1, nextCursor: "turn-old", hasMore: true },
      turns: [{ id: "turn-new", status: "inProgress" }],
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          method: "thread/list",
          params: {
            limit: 50,
            archived: false,
            modelProviders: null,
            sortKey: "recency_at",
            sortDirection: "desc",
            useStateDbOnly: true,
          },
        },
        {
          method: "thread/read",
          params: {
            threadId: "thread-1",
            includeTurns: false,
          },
        },
        {
          method: "thread/turns/list",
          params: {
            threadId: "thread-1",
            limit: 1,
            itemsView: "summary",
            sortDirection: "desc",
          },
        },
      ]),
    );

    await client.close();
    await handle.server.close();
  });

  it("exposes native pinned, recent, and archived thread contracts without a session census", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const appServer = {
      request: async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
        calls.push({ method, params });
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        if (method !== "thread/list") throw new Error(`unexpected method ${method}`);
        if (params.archived === true) {
          if (params.cursor === "archived-page-2") {
            return {
              data: [{ id: "archived-2", name: "Second archived task", source: "vscode" }],
              nextCursor: null,
            } as T;
          }
          return {
            data: [{ id: "archived-1", name: "Archived task", source: "vscode" }],
            nextCursor: "archived-page-2",
          } as T;
        }
        if (params.sectionId === "01984de2-8f74-7c91-a3b2-5c5e937cf318") {
          return {
            data: [{ id: "pinned-1", name: "Pinned task", source: "vscode" }],
            nextCursor: null,
          } as T;
        }
        return {
          data: [{ id: "active-1", name: "First task", source: "vscode" }],
          nextCursor: null,
        } as T;
      },
    };
    const handle = createOmniCodexMcpServer({ appServer, surface: "full" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "thread-pagination-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    const first = await client.callTool({
      name: "codex_app__list_threads",
      arguments: { limit: 1 },
    });
    expect(first.structuredContent).toMatchObject({
      schemaVersion: 4,
      pinnedThreads: [{ id: "pinned-1", pinnedIndex: 1, archived: false }],
      threads: [{ id: "active-1", archived: false, source: "vscode" }],
    });
    const archived = await client.callTool({
      name: "codex_app__list_archived_threads",
      arguments: { limit: 1 },
    });
    expect(archived.structuredContent).toMatchObject({
      threads: [{ id: "archived-1", archived: true }],
      nextCursor: "archived-page-2",
    });
    const archivedSecond = await client.callTool({
      name: "codex_app__list_archived_threads",
      arguments: { limit: 1, cursor: "archived-page-2" },
    });
    expect(archivedSecond.structuredContent).toMatchObject({
      threads: [{ id: "archived-2", archived: true }],
      nextCursor: null,
    });
    expect(calls.filter((call) => call.method === "thread/list")).toHaveLength(4);

    await client.close();
    await handle.server.close();
  });

  it("requires a native turn acknowledgement and never reports a queue write as execution", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const appServer = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        if (method === "thread/list") {
          return {
            data: [
              {
                id: "idle-thread",
                cwd: "C:\\workspace",
                latestModel: "gpt-5.6-sol",
                latestReasoningEffort: "xhigh",
                status: { type: "notLoaded" },
              },
            ],
          } as T;
        }
        if (method === "thread/read") {
          return {
            thread: {
              id: "idle-thread",
              cwd: "C:\\workspace",
              latestModel: "gpt-5.6-sol",
              latestReasoningEffort: "xhigh",
              status: { type: "notLoaded" },
            },
          } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    const desktopIpcClient = {
      sendFollowUpMessage: async () => ({
        threadId: "idle-thread",
        ownerClientId: "detached-owner",
        disposition: "started" as const,
        nativeResult: { turn: { id: "turn-idle" } },
        transport: "detached_app_server" as const,
      }),
    };
    const handle = createOmniCodexMcpServer({ appServer, desktopIpcClient, surface: "full" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "queued-follow-up-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    const sent = await client.callTool({
      name: "codex_app__send_message_to_thread",
      arguments: { threadId: "idle-thread", prompt: "후속 작업을 계속해 주세요." },
    });
    expect(sent.structuredContent).toMatchObject({
      threadId: "idle-thread",
      disposition: "started",
      transport: "detached_app_server",
      clientUserMessageId: expect.any(String),
    });
    expect(calls.some((call) => call.method === "thread/queue/add")).toBe(false);
    expect(calls.some((call) => call.method === "thread/resume")).toBe(false);
    expect(calls.some((call) => call.method === "thread/queue/start")).toBe(false);
    expect(calls.some((call) => call.method === "thread/turns/list")).toBe(false);

    await client.close();
    await handle.server.close();
  });

  it("removes a downstream fallback wrapper before fake runtime dispatch", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const appServer = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "mcpServerStatus/list") {
          return {
            data: [
              {
                name: "schema-server",
                tools: {
                  flexible: { name: "flexible", inputSchema: { type: "string" } },
                },
              },
            ],
            nextCursor: null,
          } as T;
        }
        if (method === "thread/start") return { thread: { id: "fake-thread" } } as T;
        if (method === "mcpServer/tool/call") {
          return { content: [{ type: "text", text: "fake-ok" }] } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    const handle = createOmniCodexMcpServer({ appServer, surface: "full" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "schema-wrapper-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    const tool = (await client.listTools()).tools.find((entry) => entry.name === "flexible");
    if (tool === undefined) throw new Error("missing fallback tool");
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      properties: {
        arguments: { type: "string" },
      },
      required: ["arguments"],
      additionalProperties: false,
    });
    await client.callTool({
      name: tool.name,
      arguments: { arguments: "exact-native-input" },
    });
    const nativeCall = calls.at(-1);
    expect(nativeCall).toEqual({
      method: "mcpServer/tool/call",
      params: {
        _meta: {
          "x-codex-turn-metadata": expect.objectContaining({
            sandbox_mode: "danger-full-access",
            session_id: "fake-thread",
            thread_id: "fake-thread",
            thread_source: "user",
          }),
        },
        server: "schema-server",
        threadId: "fake-thread",
        tool: "flexible",
        arguments: "exact-native-input",
      },
    });
    const turnMetadata = (
      nativeCall?.params as { _meta?: { "x-codex-turn-metadata"?: Record<string, unknown> } }
    )?._meta?.["x-codex-turn-metadata"];
    expect(turnMetadata).not.toHaveProperty("model");
    expect(turnMetadata).not.toHaveProperty("reasoning_effort");

    await client.close();
    await handle.server.close();
  });

  it("omits blank optional native setting overrides through direct and router registry calls", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const observations: NativeToolExecutionObservation[] = [];
    const appServer = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "mcpServerStatus/list") {
          return {
            data: [
              {
                name: "settings-server",
                tools: {
                  continue_work: {
                    name: "continue_work",
                    annotations: { readOnlyHint: true },
                    inputSchema: {
                      type: "object",
                      properties: {
                        prompt: { type: "string" },
                        model: { type: "string" },
                        reasoningEffort: { type: "string" },
                      },
                      required: ["prompt"],
                      additionalProperties: false,
                    },
                  },
                },
              },
            ],
            nextCursor: null,
          } as T;
        }
        if (method === "thread/start") return { thread: { id: "settings-thread" } } as T;
        if (method === "mcpServer/tool/call") {
          return { content: [{ type: "text", text: "continued" }] } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    const handle = createOmniCodexMcpServer({
      appServer,
      surface: "full",
      observeNativeToolExecution: (observation) => {
        observations.push(observation);
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "blank-native-setting-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    const directTool = (await client.listTools()).tools.find(
      (tool) => tool.name === "continue_work",
    );
    expect(directTool).toBeDefined();
    await client.callTool({
      name: directTool?.name ?? "continue_work",
      arguments: { prompt: "direct", model: "  ", reasoningEffort: "" },
    });
    await client.callTool({
      name: "call_native_tool",
      arguments: {
        name: directTool?.name ?? "continue_work",
        arguments: { prompt: "router", model: "", reasoningEffort: " \t" },
      },
    });

    const dispatched = calls
      .filter((call) => call.method === "mcpServer/tool/call")
      .map((call) => objectValue(call.params).arguments);
    expect(dispatched).toEqual([{ prompt: "direct" }, { prompt: "router" }]);
    const settingObservations = observations.filter(
      (observation) => observation.targetNativeName === "continue_work",
    );
    expect(settingObservations).toHaveLength(2);
    expect(settingObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mcpToolName: directTool?.name,
          modelOverride: "blank",
          reasoningOverride: "blank",
          outcome: "succeeded",
        }),
        expect.objectContaining({
          mcpToolName: "call_native_tool",
          modelOverride: "blank",
          reasoningOverride: "blank",
          outcome: "succeeded",
        }),
      ]),
    );
    for (const observation of settingObservations) {
      expect(observation.requestArgumentsSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(observation.messageTransmissionRequested).toBeUndefined();
    }

    await client.close();
    await handle.server.close();
  });

  it("preserves native fields that share legacy OmniCodex session argument names", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const appServer = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "mcpServerStatus/list") {
          return {
            data: [
              {
                name: "future-native-server",
                tools: {
                  echo_native_context: {
                    name: "echo_native_context",
                    annotations: { readOnlyHint: true },
                    inputSchema: {
                      type: "object",
                      properties: {
                        workSessionBinding: { type: "string" },
                        continuationToken: { type: "string" },
                      },
                      required: ["workSessionBinding", "continuationToken"],
                      additionalProperties: false,
                    },
                  },
                },
              },
            ],
            nextCursor: null,
          } as T;
        }
        if (method === "thread/start") return { thread: { id: "future-native-thread" } } as T;
        if (method === "mcpServer/tool/call") {
          return { content: [{ type: "text", text: "native-context-preserved" }] } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    const handle = createOmniCodexMcpServer({ appServer, surface: "full" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "native-context-field-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tool = (await client.listTools()).tools.find(
        (candidate) => candidate.name === "echo_native_context",
      );
      expect(tool?.inputSchema).toMatchObject({
        required: ["workSessionBinding", "continuationToken"],
      });
      const result = await client.callTool({
        name: tool?.name ?? "echo_native_context",
        arguments: {
          workSessionBinding: "native-work-session-value",
          continuationToken: "native-continuation-value",
        },
      });
      expect(result.isError).not.toBe(true);
      const nativeCall = calls.find((call) => call.method === "mcpServer/tool/call");
      expect(objectValue(nativeCall?.params).arguments).toEqual({
        workSessionBinding: "native-work-session-value",
        continuationToken: "native-continuation-value",
      });
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("classifies ambiguous tool selection from its error identity, not candidate metadata", async () => {
    const observations: NativeToolExecutionObservation[] = [];
    let nativeCalls = 0;
    const call = async () => {
      nativeCalls += 1;
      throw new Error("Ambiguous selection must not execute a candidate");
    };
    const source = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: ["first", "second"].map((suffix) => ({
          type: "function" as const,
          name: `ambiguous_probe_${suffix}`,
          description: "A timeout, permission or connection reset may be reported by this tool.",
          parameters: {
            type: "object",
            properties: { timeout: { type: "number" } },
            additionalProperties: false,
          },
        })),
      },
      call,
    };
    const handle = createOmniCodexMcpServer({
      appServer: {
        request: async <T>(method: string): Promise<T> => {
          if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
          throw new Error(`unexpected method ${method}`);
        },
      },
      responsesToolCatalog: new ResponsesNativeToolCatalog(source),
      responsesToolExecutor: new ResponsesNativeToolExecutor(source),
      surface: "full",
      observeNativeToolExecution: (observation) => {
        observations.push(observation);
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ambiguous-error-observation-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "call_native_tool",
        arguments: { query: "ambiguous_probe" },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: "AMBIGUOUS_NATIVE_TOOL_QUERY",
          candidates: source.snapshot.tools.map((tool) => ({
            description: tool.description,
            inputSchema: tool.parameters,
          })),
        },
      });
      expect(nativeCalls).toBe(0);
      expect(observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            mcpToolName: "call_native_tool",
            errorCode: "AMBIGUOUS_NATIVE_TOOL_QUERY",
            errorClass: "invalid_request",
            outcome: "tool_error",
          }),
        ]),
      );
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("preserves native failure identity when its observation sink throws", async () => {
    const privateBrowserError = "Chrome is not available for C:\\private\\profile";
    const privateResponsesError = "Responses executor turn timed out: private-turn-id";
    const observations: NativeToolExecutionObservation[] = [];
    const responsesFailure = Object.assign(new Error(privateResponsesError), {
      code: "RESPONSES_TURN_TIMEOUT",
    });
    const responsesSource = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [
          {
            type: "function" as const,
            name: "native_failure",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      },
      call: async () => {
        throw responsesFailure;
      },
    };
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected method ${method}`);
      },
    };
    const handle = createOmniCodexMcpServer({
      appServer,
      browserNativeExecutor: {
        call: async () => ({
          content: [{ type: "text" as const, text: privateBrowserError }],
          isError: true,
          structuredContent: {
            error: { code: "BROWSER_SURFACE_UNAVAILABLE", message: privateBrowserError },
          },
        }),
      },
      responsesToolCatalog: new ResponsesNativeToolCatalog(responsesSource),
      responsesToolExecutor: new ResponsesNativeToolExecutor(responsesSource),
      surface: "full",
      observeNativeToolExecution: (observation) => {
        observations.push(observation);
        throw new Error("native execution observation failed");
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "native-error-observation-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    await client.listTools();
    const browserResult = await client.callTool({
      name: "chrome__control_chrome",
      arguments: { code: "return await browser.tabs.list();" },
    });
    const responsesResult = await client.callTool({ name: "native_failure", arguments: {} });

    expect(browserResult.isError).toBe(true);
    expect(responsesResult.isError).toBe(true);
    expect(browserResult.content).toEqual([{ type: "text", text: privateBrowserError }]);
    expect(browserResult.structuredContent).toEqual({
      error: { code: "BROWSER_SURFACE_UNAVAILABLE", message: privateBrowserError },
    });
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mcpToolName: "chrome__control_chrome",
          errorClass: "unavailable",
          errorCode: "BROWSER_SURFACE_UNAVAILABLE",
          outcome: "tool_error",
        }),
        expect.objectContaining({
          mcpToolName: "native_failure",
          errorClass: "timeout",
          errorName: "Error",
          errorCode: "RESPONSES_TURN_TIMEOUT",
          outcome: "failed",
        }),
      ]),
    );
    for (const observation of observations.filter((item) => item.errorClass !== undefined)) {
      expect(observation.errorDetailsSha256).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(JSON.stringify(observations)).not.toContain(privateBrowserError);
    expect(JSON.stringify(observations)).not.toContain(privateResponsesError);

    await client.close();
    await handle.server.close();
  });

  it("does not silently filter model-effect or future native targets from generic dispatch", async () => {
    const selected: unknown[] = [];
    const source = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [
          {
            type: "namespace",
            name: "collaboration",
            tools: [
              {
                type: "function",
                name: "spawn_agent",
                parameters: { type: "object", properties: { task_name: { type: "string" } } },
              },
            ],
          },
          { type: "future_native_tool", name: "unclassified" },
        ],
      },
      call: async (selection: unknown) => {
        selected.push(selection);
        return {
          callId: "forbidden",
          outputType: "function_call_output",
          executionStatus: "succeeded" as const,
          output: "",
          rawItem: {},
        };
      },
    };
    const appServer = {
      request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T,
    };
    const handle = createOmniCodexMcpServer({
      appServer,
      responsesToolCatalog: new ResponsesNativeToolCatalog(source),
      responsesToolExecutor: new ResponsesNativeToolExecutor(source),
      surface: "compat",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "generic-policy-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.listTools();

    const search = await client.callTool({
      name: "search_native_tools",
      arguments: { query: "*" },
    });
    const values = objectValue(search.structuredContent).tools;
    const results = Array.isArray(values) ? values.map((item) => objectValue(item)) : [];
    const model = results.find((item) => item.nativeName === "spawn_agent");
    const unknown = results.find((item) => item.nativeName === "unclassified");
    const modelResult = await client.callTool({
      name: "call_native_tool",
      arguments: { name: model?.name, arguments: { task_name: "worker", invokesModel: true } },
    });
    const unknownResult = await client.callTool({
      name: "call_native_tool",
      arguments: { name: unknown?.name, payload: null },
    });
    expect(modelResult.isError).not.toBe(true);
    expect(unknownResult.isError).not.toBe(true);
    expect(selected).toEqual([
      {
        kind: "function",
        name: "spawn_agent",
        namespace: "collaboration",
        arguments: { task_name: "worker", invokesModel: true },
      },
      { kind: "unknown", name: "unclassified", arguments: null },
    ]);

    await client.close();
    await handle.server.close();
  });

  it("returns every native search match through lossless byte-bounded pages", async () => {
    const source = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: Array.from({ length: 300 }, (_, index) => ({
          type: "function" as const,
          name: `native_${String(index).padStart(2, "0")}`,
          description: "A native tool with a deliberately verbose but bounded description.",
          parameters: { type: "object" },
        })),
      },
    };
    const appServer = {
      request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T,
    };
    const handle = createOmniCodexMcpServer({
      appServer,
      responsesToolCatalog: new ResponsesNativeToolCatalog(source),
      surface: "compat",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bounded-search-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    const names: string[] = [];
    let reportedTotalCount: number | undefined;
    let cursor: string | undefined;
    let pages = 0;
    do {
      const search = await client.callTool({
        name: "search_native_tools",
        arguments: cursor === undefined ? { query: "*" } : { query: "*", cursor },
      });
      const structured = objectValue(search.structuredContent);
      const tools = Array.isArray(structured.tools) ? structured.tools : [];
      names.push(...tools.map((tool) => String(objectValue(tool).nativeName)));
      expect(typeof structured.totalCount).toBe("number");
      if (reportedTotalCount === undefined) {
        reportedTotalCount = Number(structured.totalCount);
      } else {
        expect(structured.totalCount).toBe(reportedTotalCount);
      }
      expect(structured.query).toBe("*");
      expect(Buffer.byteLength(JSON.stringify(structured), "utf8")).toBeLessThanOrEqual(
        OMNICODEX_NATIVE_SEARCH_PAGE_BYTE_BUDGET,
      );
      cursor = typeof structured.nextCursor === "string" ? structured.nextCursor : undefined;
      pages += 1;
    } while (cursor !== undefined);
    expect(pages).toBeGreaterThan(1);
    expect(names).toHaveLength(reportedTotalCount);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("resource/attach-local-file");
    expect(names).toContain("native_299");

    await client.close();
    await handle.server.close();
  });

  it("returns only exact-name matches when another tool merely embeds that name in prose", async () => {
    const source = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [],
        nestedTools: [
          { name: "exec_command", description: "Run a shell command." },
          {
            name: "exec",
            description: "Orchestrate nested tools such as exec_command and many other tools.",
          },
        ],
      },
    };
    const appServer = {
      request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T,
    };
    const handle = createOmniCodexMcpServer({
      appServer,
      responsesToolCatalog: new ResponsesNativeToolCatalog(source),
      surface: "compat",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "exact-search-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    const search = await client.callTool({
      name: "search_native_tools",
      arguments: { query: "exec_command", modelEffect: "none", stateEffect: "mutate" },
    });
    const advertisedSearch = (await client.listTools()).tools.find(
      (tool) => tool.name === "search_native_tools",
    );
    expect(advertisedSearch?.inputSchema).toMatchObject({
      type: "object",
      required: ["query"],
      properties: { query: { type: "string", minLength: 1 } },
    });
    expect(advertisedSearch?.outputSchema).toMatchObject({
      type: "object",
      required: ["count", "totalCount", "query", "tools", "catalogRevision"],
    });
    const tools = objectValue(search.structuredContent).tools;
    expect(Array.isArray(tools) ? tools.map((item) => objectValue(item).name) : []).toEqual([
      "exec_command",
    ]);
    expect(objectValue(search.structuredContent).query).toBe("exec_command");
    const result = Array.isArray(tools) ? objectValue(tools[0]) : {};
    expect(result.nativeTool).toMatchObject({
      name: "exec_command",
      description: "Run a shell command.",
      parameters: { type: "object", additionalProperties: true },
    });
    expect(result).not.toHaveProperty("tool");
    expect(result).not.toHaveProperty("description");
    expect(result).not.toHaveProperty("inputSchema");
    expect(Buffer.byteLength(JSON.stringify(search), "utf8")).toBeLessThan(16 * 1024);

    await client.close();
    await handle.server.close();
  });

  it("keeps stable host tools on the full surface when the native registry fits one page", async () => {
    const appServer = {
      request: async <T>(): Promise<T> =>
        ({
          data: [
            {
              name: "small",
              tools: {
                ping: { name: "ping", description: "Ping", inputSchema: { type: "object" } },
              },
            },
          ],
          nextCursor: null,
        }) as T,
    };
    const handle = createOmniCodexMcpServer({ appServer, surface: "full" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "small-full-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["codex_app__list_threads", "codex_app__read_thread", "ping"]),
    );
    expect(listed.nextCursor).toBeUndefined();

    await client.close();
    await handle.server.close();
  });

  it("advertises the same deployment identity on every compatibility tool", async () => {
    const serverIdentity = "b".repeat(64);
    const appServer = {
      request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T,
    };
    const handle = createOmniCodexMcpServer({
      appServer,
      surface: "compat",
      serverIdentity,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "compat-identity-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.length).toBeGreaterThan(3);
      expect(
        listed.tools.every(
          (tool) =>
            objectValue(objectValue(tool._meta).omnicodex).serverIdentity === serverIdentity,
        ),
      ).toBe(true);
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("pages the complete full registry with a revision-bound cursor", async () => {
    const serverIdentity = "a".repeat(64);
    let tools = Object.fromEntries(
      Array.from({ length: 1_001 }, (_, index) => [
        `tool_${String(index).padStart(3, "0")}`,
        {
          name: `tool_${String(index).padStart(3, "0")}`,
          description: `${String(index).padStart(4, "0")}:${"x".repeat(1_024)}`,
          inputSchema: { type: "object" },
          ...(index === 0 ? { _meta: { vendor: { preserved: true } } } : {}),
        },
      ]),
    );
    const appServer = {
      request: async <T>(): Promise<T> =>
        ({ data: [{ name: "paged", tools }], nextCursor: null }) as T,
    };
    const handle = createOmniCodexMcpServer({
      appServer,
      appServerMethodCatalog: directWorkAppServerMethodCatalog(),
      responsesToolCatalog: directFunctionsExecCatalog(),
      surface: "full",
      serverIdentity,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "paging-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    let first = await client.listTools();
    const originalCursor = first.nextCursor;
    expect(originalCursor).toBeTypeOf("string");
    if (originalCursor === undefined) throw new Error("expected a paginated full catalog");
    expect(first.tools.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(
      OMNICODEX_FULL_CATALOG_PAGE_BYTE_BUDGET,
    );
    expect(first.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "codex_app__list_threads",
        "codex_app__read_thread",
        "codex__app_server__fs_readFile",
        "codex__functions__exec",
      ]),
    );
    const originalCatalog = [...first.tools];
    const originalPageToolCounts = [first.tools.length];
    while (first.nextCursor !== undefined) {
      first = await client.listTools({ cursor: first.nextCursor });
      expect(first.tools.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(
        OMNICODEX_FULL_CATALOG_PAGE_BYTE_BUDGET,
      );
      originalPageToolCounts.push(first.tools.length);
      originalCatalog.push(...first.tools);
    }
    expect(originalPageToolCounts.length).toBeGreaterThan(1);
    expect(originalCatalog.filter((tool) => tool.name.startsWith("tool_"))).toHaveLength(1_001);
    expect(new Set(originalCatalog.map((tool) => tool.name)).size).toBe(originalCatalog.length);
    expect(
      originalCatalog.find((tool) => tool.name === "codex__app_server__fs_writeFile")?.annotations,
    ).toEqual(ALL_FALSE_ANNOTATIONS);
    expect(
      originalCatalog.every(
        (tool) => objectValue(objectValue(tool._meta).omnicodex).serverIdentity === serverIdentity,
      ),
    ).toBe(true);
    expect(
      objectValue(originalCatalog.find((tool) => tool.name === "tool_000")?._meta).vendor,
    ).toEqual({ preserved: true });

    const tamperedCursor = `${originalCursor.slice(0, -1)}${originalCursor.endsWith("a") ? "b" : "a"}`;
    await expect(client.listTools({ cursor: tamperedCursor })).rejects.toThrow();
    tools = {
      ...tools,
      tool_1001: {
        name: "tool_1001",
        description: `1001:${"x".repeat(1_024)}`,
        inputSchema: { type: "object" },
      },
    };
    await handle.refresh();
    await expect(client.listTools({ cursor: "invalid-cursor" })).rejects.toThrow();
    await expect(client.listTools({ cursor: originalCursor })).rejects.toThrow(/CATALOG_CHANGED/u);
    let refreshedPage = await client.listTools();
    const refreshedCatalog = [...refreshedPage.tools];
    while (refreshedPage.nextCursor !== undefined) {
      refreshedPage = await client.listTools({ cursor: refreshedPage.nextCursor });
      refreshedCatalog.push(...refreshedPage.tools);
    }
    const refreshedNames = refreshedCatalog.map((tool) => tool.name);
    expect(refreshedNames).toContain("tool_1001");
    expect(refreshedNames).toHaveLength(originalCatalog.length + 1);
    expect(refreshedNames.slice(0, 12)).toEqual([
      "codex_app__list_threads",
      "codex_app__read_thread",
      "codex_app__wait_threads",
      "codex__app_server__fs_readFile",
      "codex__app_server__fs_writeFile",
      "codex__app_server__command_exec",
      "codex__app_server__fs_remove",
      "codex__functions__exec",
      "search_native_tools",
      "call_native_tool",
      "app_server_rpc",
      "codex_app__load_workspace_dependencies",
    ]);
    const remainingPagedTools = refreshedCatalog.filter((tool) => tool.name.startsWith("tool_"));
    expect(remainingPagedTools.map((tool) => tool.name)).toEqual(
      [...remainingPagedTools.map((tool) => tool.name)].sort((left, right) =>
        left.localeCompare(right, "en"),
      ),
    );
    await client.close();
    await handle.server.close();
  });

  it("returns an individually oversized catalog tool alone instead of omitting it", async () => {
    const oversizedDescription = "z".repeat(OMNICODEX_FULL_CATALOG_PAGE_BYTE_BUDGET + 1_024);
    const appServer = {
      request: async <T>(): Promise<T> =>
        ({
          data: [
            {
              name: "oversized",
              tools: {
                huge: {
                  name: "huge",
                  description: oversizedDescription,
                  inputSchema: { type: "object" },
                },
                tail: { name: "tail", inputSchema: { type: "object" } },
              },
            },
          ],
          nextCursor: null,
        }) as T,
    };
    const handle = createOmniCodexMcpServer({ appServer, surface: "full" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "oversized-catalog-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      let page = await client.listTools();
      const catalog = [...page.tools];
      let oversizedPageObserved = false;
      while (true) {
        expect(page.tools.length).toBeGreaterThan(0);
        if (
          Buffer.byteLength(JSON.stringify(page), "utf8") > OMNICODEX_FULL_CATALOG_PAGE_BYTE_BUDGET
        ) {
          expect(page.tools).toHaveLength(1);
          expect(page.tools[0]?.name).toBe("huge");
          oversizedPageObserved = true;
        }
        if (page.nextCursor === undefined) break;
        page = await client.listTools({ cursor: page.nextCursor });
        catalog.push(...page.tools);
      }
      expect(oversizedPageObserved).toBe(true);
      expect(catalog.map((tool) => tool.name)).toEqual(expect.arrayContaining(["huge", "tail"]));
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("advertises and calls distinct host and registry identities that prefer the same name", async () => {
    const downstreamCalls: unknown[] = [];
    const hostCalls: unknown[] = [];
    const appServer = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        if (method === "mcpServerStatus/list") {
          return {
            data: [
              {
                name: "collision-mcp",
                tools: {
                  collision__same: {
                    name: "collision__same",
                    description: "Registry collision route",
                    inputSchema: { type: "object", additionalProperties: true },
                  },
                },
              },
            ],
            nextCursor: null,
          } as T;
        }
        if (method === "thread/start") return { thread: { id: "thread-collision" } } as T;
        if (method === "mcpServer/tool/call") {
          downstreamCalls.push(params);
          return { content: [{ type: "text", text: "registry-called" }] } as T;
        }
        throw new Error(`unexpected App Server request: ${method}`);
      },
    };
    const host = new CodexAppHostToolExecutor(appServer, {
      appToolsContextThreadId: () => "desktop-thread",
      appTools: {
        close: () => undefined,
        listTools: async () => [
          {
            namespace: "collision",
            name: "same",
            description: "Direct collision route",
            inputSchema: { type: "object", additionalProperties: true },
          },
        ],
        callTool: async (params) => {
          hostCalls.push(params);
          return {
            success: true,
            contentItems: [{ type: "inputText", text: "host-called" }],
          };
        },
      },
    });
    const handle = createOmniCodexMcpServer({
      appServer,
      codexAppHostToolExecutor: host,
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "collision-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      let page = await client.listTools();
      const catalog = [...page.tools];
      while (page.nextCursor !== undefined) {
        page = await client.listTools({ cursor: page.nextCursor });
        catalog.push(...page.tools);
      }
      const direct = catalog.find((tool) => tool.description === "Direct collision route");
      const registry = catalog.find((tool) => tool.description === "Registry collision route");
      expect(direct?.name).toBe("collision__same");
      expect(registry?.name).toMatch(/^collision__same__[a-f0-9]{64}$/u);
      expect(registry?.name).not.toBe(direct?.name);

      const directResult = await client.callTool({ name: direct?.name ?? "", arguments: {} });
      const registryResult = await client.callTool({ name: registry?.name ?? "", arguments: {} });
      expect(directResult.content).toEqual([{ type: "text", text: "host-called" }]);
      expect(registryResult.content).toEqual([{ type: "text", text: "registry-called" }]);
      expect(hostCalls).toHaveLength(1);
      expect(downstreamCalls).toHaveLength(1);
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("keeps every native tool first-class while also exposing lossless recovery routers", async () => {
    const tools = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [
        `tool_${String(index).padStart(3, "0")}`,
        {
          name: `tool_${String(index).padStart(3, "0")}`,
          inputSchema: { type: "object" },
        },
      ]),
    );
    const appServer = {
      request: async <T>(): Promise<T> =>
        ({ data: [{ name: "bounded", tools }], nextCursor: null }) as T,
    };
    const handle = createOmniCodexMcpServer({
      appServer,
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bounded-chatgpt-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    let page = await client.listTools();
    const catalog = [...page.tools];
    while (page.nextCursor !== undefined) {
      page = await client.listTools({ cursor: page.nextCursor });
      catalog.push(...page.tools);
    }
    const names = catalog.map((tool) => tool.name);
    expect(names).toContain("tool_100");
    expect(names).toEqual(
      expect.arrayContaining(["search_native_tools", "call_native_tool", "app_server_rpc"]),
    );
    expect(names).not.toContain("call_native_read_tool");
    expect(new Set(names).size).toBe(names.length);

    await client.close();
    await handle.server.close();
  });

  it("publishes one revision-bound Goal surface only on full and preserves every direct schema", async () => {
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected method ${method}`);
      },
    };
    const appTools = {
      close: () => undefined,
      listTools: async (): Promise<readonly CodexAppNativeTool[]> => [
        {
          namespace: "goal_probe",
          name: "read_exact",
          description: "Read one exact path.",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
        {
          namespace: "goal_probe",
          name: "write_exact",
          description: "Write one exact path.",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" }, value: { type: "string" } },
            required: ["path", "value"],
            additionalProperties: false,
          },
        },
      ],
      callTool: async () => ({ success: true, contentItems: [] }),
    };
    const hostTools = new CodexAppHostToolExecutor(appServer, {
      appTools,
      appToolsContextThreadId: () => "goal-schema-thread",
    });
    const directGoalStore = DirectGoalStore.inMemory();
    const mutationReplayStore = MutationReplayStore.inMemory();
    const responsesToolCatalog = directFunctionsExecCatalog();
    const registryCatalog = new OmniCodexNativeToolRegistryCatalog({
      appServer,
      codexAppHostToolExecutor: hostTools,
      directGoalStore,
      mutationReplayStore,
      responsesToolCatalog,
    });
    expect(registryCatalog.directGoalsEnabled).toBe(true);
    expect(() =>
      createOmniCodexMcpServer({
        appServer,
        nativeToolRegistryCatalog: registryCatalog,
        codexAppHostToolExecutor: hostTools,
        mutationReplayStore,
        authorizationBinding: "issuer\0owner\0client\0resource",
        surface: "full",
      }),
    ).toThrow("Direct Goal capability does not match");

    const noGoalCatalog = new OmniCodexNativeToolRegistryCatalog({
      appServer,
      codexAppHostToolExecutor: hostTools,
    });
    expect(noGoalCatalog.directGoalsEnabled).toBe(false);
    expect(() =>
      createOmniCodexMcpServer({
        appServer,
        nativeToolRegistryCatalog: noGoalCatalog,
        codexAppHostToolExecutor: hostTools,
        directGoalStore,
        mutationReplayStore,
        authorizationBinding: "issuer\0owner\0client\0resource",
        surface: "full",
      }),
    ).toThrow("Direct Goal capability does not match");

    const createConnection = async (surface: "compat" | "full", name: string) => {
      const handle = createOmniCodexMcpServer({
        appServer,
        nativeToolRegistryCatalog: registryCatalog,
        codexAppHostToolExecutor: hostTools,
        directGoalStore,
        mutationReplayStore,
        responsesToolCatalog,
        authorizationBinding: "issuer\0owner\0client\0resource",
        surface,
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name, version: "1.0.0" });
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      return { client, handle };
    };
    const full = await createConnection("full", "goal-catalog-full");
    const compat = await createConnection("compat", "goal-catalog-compat");
    try {
      let page = await full.client.listTools();
      const firstPageNames = page.tools.map((tool) => tool.name);
      const allFullTools = [...page.tools];
      while (page.nextCursor !== undefined) {
        page = await full.client.listTools({ cursor: page.nextCursor });
        allFullTools.push(...page.tools);
      }
      const goalNames = [
        "omnicodex__goal_create",
        "omnicodex__goal_get",
        "omnicodex__goal_list",
        "omnicodex__goal_claim_next_step",
        "omnicodex__goal_complete",
        "omnicodex__goal_delete",
      ] as const;
      expect(firstPageNames).toEqual(expect.arrayContaining([...goalNames]));
      for (const name of goalNames) {
        expect(allFullTools.filter((tool) => tool.name === name)).toHaveLength(1);
      }
      expect((await compat.client.listTools()).tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([...goalNames]),
      );

      expect(
        allFullTools.every(
          (tool) => typeof tool._meta?.omnicodex === "object" && tool._meta?.omnicodex !== null,
        ),
      ).toBe(true);

      for (const tool of allFullTools) {
        if (
          (goalNames as readonly string[]).includes(tool.name) ||
          tool.name === "codex__omnicodex__session_identity" ||
          tool.name === OMNICODEX_ATTACH_LOCAL_FILE_TOOL
        ) {
          continue;
        }
        const schema = objectValue(tool.inputSchema);
        expect(schema.type, tool.name).toBe("object");
        expect(objectValue(schema.properties), tool.name).not.toHaveProperty(
          "omnicodexGoalContext",
        );
      }
      const readSchema = objectValue(
        allFullTools.find((tool) => tool.name === "goal_probe__read_exact")?.inputSchema,
      );
      expect(readSchema.required).toEqual(["path"]);
      expect(readSchema.additionalProperties).toBe(false);
      const writeSchema = objectValue(
        allFullTools.find((tool) => tool.name === "goal_probe__write_exact")?.inputSchema,
      );
      expect(writeSchema.required).toEqual(["path", "value"]);
      expect(writeSchema.additionalProperties).toBe(false);
      expect(Object.keys(objectValue(writeSchema.properties)).sort()).toEqual(["path", "value"]);

      const local = await registryCatalog.inspectFullCatalog();
      expect(local.catalogRevision).toMatch(/^[a-f0-9]{64}$/);
      expect(local.catalogToolCount).toBe(allFullTools.length);
      const expectedCatalogToolNames = allFullTools
        .map(({ name }) => name)
        .sort((left, right) => left.localeCompare(right, "en"));
      expect(local.catalogToolNames).toEqual(expectedCatalogToolNames);
      expect(local.catalogToolNamesSha256).toBe(
        createHash("sha256").update(JSON.stringify(expectedCatalogToolNames), "utf8").digest("hex"),
      );
    } finally {
      await compat.client.close();
      await compat.handle.server.close();
      await full.client.close();
      await full.handle.server.close();
    }
  });

  it("executes direct Goal read and mutation-readback flows while rejecting proxy evidence before dispatch", async () => {
    const nativeCalls: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
    const appServerCalls: string[] = [];
    let codeModeCalls = 0;
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        appServerCalls.push(method);
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected App Server method ${method}`);
      },
    };
    const appTools = {
      close: () => undefined,
      listTools: async (): Promise<readonly CodexAppNativeTool[]> => [
        {
          namespace: "goal_e2e",
          name: "read_marker",
          description: "Read one marker file.",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
        {
          namespace: "goal_e2e",
          name: "write_marker",
          description: "Write one marker file.",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" }, value: { type: "string" } },
            required: ["path", "value"],
            additionalProperties: false,
          },
        },
        {
          namespace: "codex_app",
          name: "run_natural_task",
          description: "Run a natural-language proxy task.",
          inputSchema: {
            type: "object",
            properties: { prompt: { type: "string" } },
            required: ["prompt"],
            additionalProperties: false,
          },
        },
      ],
      callTool: async (params: { tool: string; arguments: Record<string, unknown> }) => {
        nativeCalls.push({ tool: params.tool, arguments: params.arguments });
        return {
          success: true,
          contentItems: [
            {
              type: "inputText" as const,
              text: JSON.stringify({ tool: params.tool, arguments: params.arguments }),
            },
          ],
        };
      },
    };
    const hostTools = new CodexAppHostToolExecutor(appServer, {
      appTools,
      appToolsContextThreadId: () => "goal-e2e-thread",
    });
    const responsesToolCatalog = directFunctionsExecCatalog();
    const responsesToolExecutor = new ResponsesNativeToolExecutor({
      call: async () => {
        codeModeCalls += 1;
        return {
          callId: "goal-code-mode",
          outputType: "custom_tool_call_output" as const,
          executionStatus: "succeeded" as const,
          output: [{ type: "input_text" as const, text: "code-mode-ok" }],
          rawItem: {
            type: "custom_tool_call_output" as const,
            call_id: "goal-code-mode",
            output: [{ type: "input_text" as const, text: "code-mode-ok" }],
          },
        };
      },
    });
    const handle = createOmniCodexMcpServer({
      appServer,
      codexAppHostToolExecutor: hostTools,
      responsesToolCatalog,
      responsesToolExecutor,
      directGoalStore: DirectGoalStore.inMemory(),
      mutationReplayStore: MutationReplayStore.inMemory(),
      legacyMutationCoordinator: LegacyMutationCoordinator.inMemory(),
      authorizationBinding: "issuer\0owner\0client\0resource",
      correlationId: "web-pro-owner-session",
      resolveDurableWorkSessionBinding: () => ({
        workSessionBinding: "web-pro-durable-work-session",
        directGoalClaimantBinding: "web-pro-owner-session",
        directJobOwnerBinding: "web-pro-direct-job-owner",
        continuationToken: "web-pro-continuation-token",
        journalCursor: "web-pro-journal-cursor",
      }),
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "direct-goal-e2e-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const createGoal = async (key: string, mode: "successful_call" | "mutation_and_readback") => {
        const result = await client.callTool({
          name: "omnicodex__goal_create",
          arguments: {
            idempotencyKey: key,
            objective: `Verify ${mode}`,
            steps: [{ id: "step-1", description: "Execute one direct action", mode }],
          },
        });
        expect(result.isError).not.toBe(true);
        return objectValue(result.structuredContent);
      };
      const claimGoal = async (goalId: string) => {
        const result = await client.callTool({
          name: "omnicodex__goal_claim_next_step",
          arguments: { goalId },
        });
        expect(result.isError).not.toBe(true);
        return objectValue(result.structuredContent);
      };
      const completeGoal = async (goalId: string) =>
        client.callTool({ name: "omnicodex__goal_complete", arguments: { goalId } });

      const readGoal = await createGoal("goal-read-20260828-0001", "successful_call");
      const readGoalId = String(readGoal.id);
      const readClaim = await claimGoal(readGoalId);
      const readResult = await client.callTool({
        name: "goal_e2e__read_marker",
        arguments: {
          path: "C:/workspace/marker.txt",
          omnicodexInvocationId: "goal-read-envelope-20260828-0001",
          omnicodexGoalContext: String(readClaim.omnicodexGoalContext),
        },
      });
      expect(readResult.isError).not.toBe(true);
      expect(nativeCalls.at(-1)).toEqual({
        tool: "read_marker",
        arguments: { path: "C:/workspace/marker.txt" },
      });
      await expect(completeGoal(readGoalId)).resolves.toMatchObject({
        structuredContent: { state: "completed" },
      });

      const mutationGoal = await createGoal("goal-mutation-20260828-0001", "mutation_and_readback");
      const mutationGoalId = String(mutationGoal.id);
      const mutationClaim = await claimGoal(mutationGoalId);
      const writeResult = await client.callTool({
        name: "goal_e2e__write_marker",
        arguments: {
          path: "C:/workspace/marker.txt",
          value: "verified",
          omnicodexInvocationId: "goal-write-20260828-0001",
          omnicodexGoalContext: String(mutationClaim.omnicodexGoalContext),
        },
      });
      expect(writeResult.isError).not.toBe(true);
      expect(nativeCalls.at(-1)).toEqual({
        tool: "write_marker",
        arguments: { path: "C:/workspace/marker.txt", value: "verified" },
      });
      const awaiting = await client.callTool({
        name: "omnicodex__goal_get",
        arguments: { goalId: mutationGoalId },
      });
      const executionSteps = objectValue(awaiting.structuredContent).steps as unknown[];
      const referenceStep = objectValue(executionSteps[0]);
      expect(referenceStep.state).toBe("awaiting_readback");
      const receipts = referenceStep.receipts as unknown[];
      expect(String(objectValue(receipts[0]).operationId)).not.toHaveLength(0);
      const readbackClaim = await claimGoal(mutationGoalId);
      const readbackResult = await client.callTool({
        name: "goal_e2e__read_marker",
        arguments: {
          path: "C:/workspace/marker.txt",
          omnicodexGoalContext: String(readbackClaim.omnicodexGoalContext),
        },
      });
      expect(readbackResult.isError).not.toBe(true);
      await expect(completeGoal(mutationGoalId)).resolves.toMatchObject({
        structuredContent: { state: "completed" },
      });

      const dynamicCreated = await client.callTool({
        name: "omnicodex__goal_create",
        arguments: { objective: "Choose native work as needed" },
      });
      expect(dynamicCreated.isError).not.toBe(true);
      const dynamicGoalId = String(objectValue(dynamicCreated.structuredContent).id);
      const dynamicWrite = {
        name: "goal_e2e__write_marker",
        arguments: {
          path: "C:/workspace/dynamic.txt",
          value: "dynamic",
          omnicodexInvocationId: "dynamic-write-retry-20260906",
        },
      };
      const beforeDynamicCalls = nativeCalls.length;
      expect((await client.callTool(dynamicWrite)).isError).not.toBe(true);
      expect((await client.callTool(dynamicWrite)).isError).not.toBe(true);
      expect(nativeCalls).toHaveLength(beforeDynamicCalls + 1);
      const dynamicRead = {
        name: "goal_e2e__read_marker",
        arguments: {
          path: "C:/workspace/dynamic.txt",
          omnicodexInvocationId: "dynamic-read-retry-20260906",
        },
      };
      expect((await client.callTool(dynamicRead)).isError).not.toBe(true);
      expect((await client.callTool(dynamicRead)).isError).not.toBe(true);
      expect(nativeCalls).toHaveLength(beforeDynamicCalls + 2);
      for (const search of [
        { name: "search_native_tools", arguments: { query: "read_marker" } },
        {
          name: "call_native_tool",
          arguments: { name: "search_native_tools", arguments: { query: "write_marker" } },
        },
      ]) {
        const result = await client.callTool(search);
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
      }
      const dynamicCompleted = await completeGoal(dynamicGoalId);
      expect(dynamicCompleted.isError, JSON.stringify(dynamicCompleted)).not.toBe(true);
      expect(objectValue(dynamicCompleted.structuredContent).steps).toHaveLength(4);

      const blockedCreate = await client.callTool({
        name: "omnicodex__goal_create",
        arguments: {
          idempotencyKey: "goal-blocked-20260828-0001",
          objective: "Reject unmanifested nested Goal evidence",
          steps: [
            {
              id: "step-1",
              description: "Run one directly attributable action",
              mode: "successful_call",
              allowedToolNames: ["codex__functions__exec"],
            },
          ],
        },
      });
      const blockedGoal = objectValue(blockedCreate.structuredContent);
      const blockedGoalId = String(blockedGoal.id);
      await claimGoal(blockedGoalId);
      const callsBeforeBlockedEvidence = nativeCalls.length;
      const appCallsBeforeBlockedEvidence = appServerCalls.length;
      const execBlocked = await client.callTool({
        name: "codex__functions__exec",
        arguments: { input: 'text("must-not-run")' },
      });
      expect(execBlocked.isError).not.toBe(true);
      expect(JSON.stringify(execBlocked)).not.toContain("NESTED_CALL_MANIFEST_UNAVAILABLE");
      expect(codeModeCalls).toBe(1);
      expect(nativeCalls).toHaveLength(callsBeforeBlockedEvidence);
      expect(appServerCalls).toHaveLength(appCallsBeforeBlockedEvidence);

      const unrelatedDirectRead = await client.callTool({
        name: "goal_e2e__read_marker",
        arguments: {
          path: "C:/workspace/unrelated.txt",
        },
      });
      expect(unrelatedDirectRead.isError).not.toBe(true);
      expect(codeModeCalls).toBe(1);
      const stillPending = await client.callTool({
        name: "omnicodex__goal_get",
        arguments: { goalId: blockedGoalId },
      });
      expect(
        objectValue(
          (objectValue(stillPending.structuredContent).steps as unknown[] | undefined)?.[0],
        ).state,
      ).toBe("claimed");
      const observedSteps = objectValue(stillPending.structuredContent).steps as unknown[];
      expect(observedSteps.slice(1).map((step) => objectValue(step).state)).toEqual([
        "completed",
        "completed",
      ]);
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("reads the actual action catalog when native functions.exec is unavailable", async () => {
    const appServer = {
      request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T,
    };
    const appTools = {
      close: () => undefined,
      listTools: async (): Promise<readonly CodexAppNativeTool[]> => [],
      callTool: async () => ({ success: true, contentItems: [] }),
    };
    const registryCatalog = new OmniCodexNativeToolRegistryCatalog({
      appServer,
      codexAppHostToolExecutor: new CodexAppHostToolExecutor(appServer, { appTools }),
      mutationReplayStore: MutationReplayStore.inMemory(),
    });

    const local = await registryCatalog.inspectFullCatalog();
    expect(local.catalogToolNames).not.toContain("codex__functions__exec");
    expect(local).not.toHaveProperty("criticalToolInputSchemaSha256");
    expect(local).not.toHaveProperty("criticalToolDescriptionSha256");
    expect(local.chatGptCriticalToolName).toBe("call_native_tool");
    expect(local.chatGptActionToolNames).toContain("call_native_tool");
    expect(local.chatGptCriticalToolInputSchemaSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(local.chatGptActionToolCount).toBe(local.chatGptActionToolNames.length);
  });

  it("shares one live registry between MCP sessions and local full-catalog readback", async () => {
    let sendMessageDescription = "Send a follow-up message to a Codex thread.";
    let downstreamTools: Record<
      string,
      { readonly name: string; readonly inputSchema: Record<string, unknown> }
    > = {
      first: { name: "first", inputSchema: { type: "object" } },
    };
    const appServer = {
      request: async <T>(): Promise<T> =>
        ({ data: [{ name: "shared", tools: downstreamTools }], nextCursor: null }) as T,
    };
    const appTools = {
      close: () => undefined,
      listTools: async (): Promise<readonly CodexAppNativeTool[]> => [
        {
          namespace: "codex_app",
          name: "send_message_to_thread",
          description: sendMessageDescription,
          inputSchema: {
            type: "object",
            properties: {
              hostId: { type: "string" },
              model: { type: "string" },
              prompt: { type: "string" },
              thinking: { type: "string" },
              threadId: { type: "string" },
            },
            required: ["prompt", "threadId"],
          },
        },
      ],
      callTool: async () => ({ success: true, contentItems: [] }),
    };
    const hostTools = new CodexAppHostToolExecutor(appServer, { appTools });
    const mutationReplayStore = MutationReplayStore.inMemory();
    const responsesToolCatalog = directFunctionsExecCatalog();
    const registryCatalog = new OmniCodexNativeToolRegistryCatalog({
      appServer,
      codexAppHostToolExecutor: hostTools,
      responsesToolCatalog,
      mutationReplayStore,
    });
    const createSession = async (name: string) => {
      const handle = createOmniCodexMcpServer({
        appServer,
        nativeToolRegistryCatalog: registryCatalog,
        codexAppHostToolExecutor: hostTools,
        responsesToolCatalog,
        mutationReplayStore,
        authorizationBinding: "owner",
        surface: "full",
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name, version: "1.0.0" });
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      return { client, handle };
    };
    const first = await createSession("shared-first");
    const second = await createSession("shared-second");
    try {
      const firstPage = await first.client.listTools();
      const local = await registryCatalog.inspectFullCatalog();
      const secondPage = await second.client.listTools();
      expect(local.catalogRevision).toMatch(/^[a-f0-9]{64}$/);
      expect(
        firstPage.tools.every(
          (tool) => typeof tool._meta?.omnicodex === "object" && tool._meta?.omnicodex !== null,
        ),
      ).toBe(true);
      expect(firstPage.tools.map((tool) => tool.name)).toContain(
        "codex__omnicodex__session_identity",
      );
      const sendTool = firstPage.tools.find(
        (tool) => tool.name === "codex_app__send_message_to_thread",
      );
      expect(sendTool?._meta?.omnicodex).toMatchObject({
        toolId: expect.any(String),
        catalogRevision: expect.any(String),
      });
      expect(sendTool?._meta?.omnicodex).not.toHaveProperty("ownerSessionMessageAuthorization");
      expect(
        secondPage.tools.every(
          (tool) => typeof tool._meta?.omnicodex === "object" && tool._meta?.omnicodex !== null,
        ),
      ).toBe(true);
      expect(local.catalogPageToolCounts).toEqual([firstPage.tools.length]);
      expect(local.criticalToolProperties).toBe("input");
      expect(local.criticalToolRequired).toBe("input");
      expect(local.chatGptCriticalToolName).toBe("call_native_tool");
      expect(local.chatGptActionToolNames).toContain("search_native_tools");
      expect(local.chatGptActionToolNames).toContain("call_native_tool");
      expect(local.chatGptActionToolNames).toContain("codex__omnicodex__session_identity");
      expect(local.chatGptActionToolCount).toBe(local.chatGptActionToolNames.length);

      sendMessageDescription = "Send a follow-up message using the refreshed host presentation.";
      await hostTools.refreshTools();
      await hostTools.refreshTools();
      expect(hostTools.descriptor("codex_app__send_message_to_thread")?.tool.description).toBe(
        sendMessageDescription,
      );
      const hostOnlyChange = await registryCatalog.inspectFullCatalog();
      expect(hostOnlyChange.catalogRevision).toBe(local.catalogRevision);
      expect(hostOnlyChange.chatGptActionContractSha256).toBe(local.chatGptActionContractSha256);
      const stillPublished = await first.client.listTools();
      expect(
        stillPublished.tools.find((tool) => tool.name === "codex_app__send_message_to_thread")
          ?.description,
      ).toContain("Send a follow-up message to a Codex thread.");
      expect(
        stillPublished.tools.find((tool) => tool.name === "codex_app__send_message_to_thread")
          ?.description,
      ).not.toContain("already authorized");

      downstreamTools = {
        ...downstreamTools,
        second: { name: "second", inputSchema: { type: "object" } },
      };
      const unchanged = await registryCatalog.inspectFullCatalog();
      expect(unchanged.catalogRevision).toBe(local.catalogRevision);
      expect(unchanged.catalogToolNames).not.toContain("second");

      await registryCatalog.refresh();
      const changed = await registryCatalog.inspectFullCatalog();
      const refreshed = await second.client.listTools();
      expect(changed.catalogRevision).not.toBe(local.catalogRevision);
      expect(changed.catalogToolNames).toContain("second");
      expect(changed.catalogToolNamesSha256).not.toBe(local.catalogToolNamesSha256);
      expect(refreshed.tools.map((tool) => tool.name)).toContain("second");
    } finally {
      await first.client.close();
      await second.client.close();
      await first.handle.server.close();
      await second.handle.server.close();
    }
  });

  it("publishes host, App Server, and downstream catalogs as one atomic generation", async () => {
    let hostGeneration = 1;
    let downstreamGeneration = 1;
    let methodSchema: Record<string, unknown> = {
      oneOf: [
        {
          properties: {
            method: { enum: ["generation/one"] },
            params: { type: "object", additionalProperties: true },
          },
        },
      ],
    };
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method !== "mcpServerStatus/list") throw new Error(`unexpected method ${method}`);
        return {
          data: [
            {
              name: "atomic-downstream",
              tools: {
                current: {
                  name: `downstream_${downstreamGeneration}`,
                  inputSchema: { type: "object" },
                },
              },
            },
          ],
          nextCursor: null,
        } as T;
      },
    };
    const hostTools = new CodexAppHostToolExecutor(appServer, {
      appTools: {
        close: () => undefined,
        listTools: async (): Promise<readonly CodexAppNativeTool[]> => [
          {
            namespace: "codex_app",
            name: `host_generation_${hostGeneration}`,
            description: `Host generation ${hostGeneration}`,
            inputSchema: { type: "object", additionalProperties: false },
          },
        ],
        callTool: async () => ({ success: true, contentItems: [] }),
      },
    });
    const methodCatalog = new AppServerMethodCatalog({
      loadClientRequestSchema: async () => methodSchema,
    });
    const registryCatalog = new OmniCodexNativeToolRegistryCatalog({
      appServer,
      codexAppHostToolExecutor: hostTools,
      appServerMethodCatalog: methodCatalog,
    });

    const first = await registryCatalog.refresh();
    const firstDownstream = registryCatalog.nativeToolCatalog.snapshot;
    const firstMethods = methodCatalog.snapshot;
    expect(hostTools.tools.map((tool) => tool.name)).toContain("codex_app__host_generation_1");
    expect(first.entries.map((entry) => entry.originalName)).toEqual(
      expect.arrayContaining(["downstream_1", "generation/one"]),
    );

    hostGeneration = 2;
    downstreamGeneration = 2;
    methodSchema = {
      oneOf: [{ $ref: "#/definitions/missing_generation" }],
    };
    await expect(registryCatalog.refresh()).rejects.toMatchObject({
      code: "APP_SERVER_CATALOG_INCOMPATIBLE",
    });

    expect(registryCatalog.current).toBe(first);
    expect(registryCatalog.nativeToolCatalog.snapshot).toBe(firstDownstream);
    expect(methodCatalog.snapshot).toBe(firstMethods);
    expect(hostTools.tools.map((tool) => tool.name)).toContain("codex_app__host_generation_1");
    expect(hostTools.tools.map((tool) => tool.name)).not.toContain("codex_app__host_generation_2");

    methodSchema = {
      oneOf: [
        {
          properties: {
            method: { enum: ["generation/two"] },
            params: { type: "object", additionalProperties: true },
          },
        },
      ],
    };
    const second = await registryCatalog.refresh();
    expect(second.revision).not.toBe(first.revision);
    expect(hostTools.tools.map((tool) => tool.name)).toContain("codex_app__host_generation_2");
    expect(second.entries.map((entry) => entry.originalName)).toEqual(
      expect.arrayContaining(["downstream_2", "generation/two"]),
    );
  });

  it("does not regenerate the published catalog during tools/list", async () => {
    let sourceRevision = 0;
    const appServer = {
      request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T,
    };
    const responsesToolCatalog = new ResponsesNativeToolCatalog({
      get snapshot() {
        sourceRevision += 1;
        return {
          refreshedAtUnixMs: sourceRevision,
          requestCount: sourceRevision,
          tools: [
            {
              type: "namespace" as const,
              name: "functions",
              tools: [
                { type: "custom" as const, name: "exec", description: "Execute native tools" },
              ],
            },
            {
              type: "function" as const,
              name: `published_generation_${sourceRevision}`,
              parameters: { type: "object" },
            },
          ],
        };
      },
    });
    const appTools = {
      close: () => undefined,
      listTools: async (): Promise<readonly CodexAppNativeTool[]> => [
        {
          namespace: "codex_app",
          name: "send_message_to_thread",
          description: "Send a message only when explicitly requested.",
          inputSchema: {
            type: "object",
            properties: {
              prompt: { type: "string" },
              threadId: { type: "string" },
            },
            required: ["prompt", "threadId"],
          },
        },
      ],
      callTool: async () => ({ success: true, contentItems: [] }),
    };
    const hostTools = new CodexAppHostToolExecutor(appServer, { appTools });
    const registryCatalog = new OmniCodexNativeToolRegistryCatalog({
      appServer,
      codexAppHostToolExecutor: hostTools,
      responsesToolCatalog,
    });
    const handle = createOmniCodexMcpServer({
      appServer,
      nativeToolRegistryCatalog: registryCatalog,
      codexAppHostToolExecutor: hostTools,
      responsesToolCatalog,
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "atomic-generation-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(sourceRevision).toBe(1);
      expect(listed.tools.map((tool) => tool.name)).toContain("published_generation_1");
      expect(listed.tools.map((tool) => tool.name)).not.toContain("published_generation_2");
      expect(
        listed.tools.every(
          (tool) => typeof tool._meta?.omnicodex === "object" && tool._meta?.omnicodex !== null,
        ),
      ).toBe(true);
    } finally {
      await client.close();
      await handle.server.close();
    }
  });

  it("emits tools/list_changed when the full registry revision changes", async () => {
    let nativeTools: ResponsesNativeToolSpec[] = [
      { type: "function", name: "first", parameters: { type: "object" } },
    ];
    const source = {
      get snapshot() {
        return { refreshedAtUnixMs: 1, requestCount: 1, tools: nativeTools };
      },
    };
    const appServer = {
      request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T,
    };
    const handle = createOmniCodexMcpServer({
      appServer,
      responsesToolCatalog: new ResponsesNativeToolCatalog(source),
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "list-change-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.listTools();
    const changed = new Promise<void>((resolveChanged) => {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () =>
        resolveChanged(),
      );
    });

    nativeTools = [
      ...nativeTools,
      { type: "function", name: "second", parameters: { type: "object" } },
    ];
    await handle.refresh();
    await changed;
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["first", "second"]),
    );

    await client.close();
    await handle.server.close();
  });

  it("notifies the compatibility surface while keeping its three-tool list stable", async () => {
    let liveTools: CodexAppNativeTool[] = [
      {
        namespace: "codex_app",
        name: "live_first",
        description: "First live host tool.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ];
    const appServer = {
      request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T,
    };
    const hostExecutor = new CodexAppHostToolExecutor(appServer, {
      appToolsContextThreadId: () => "desktop-thread",
      appTools: {
        close: () => undefined,
        listTools: async () => liveTools,
        callTool: async () => ({ success: true, contentItems: [] }),
      },
    });
    const handle = createOmniCodexMcpServer({
      appServer,
      codexAppHostToolExecutor: hostExecutor,
      surface: "compat",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "host-list-change-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    const first = await client.listTools();
    expect(first.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["search_native_tools", "call_native_tool", "app_server_rpc"]),
    );
    const changed = new Promise<void>((resolveChanged) => {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () =>
        resolveChanged(),
      );
    });

    liveTools = [
      ...liveTools,
      {
        namespace: "codex_app",
        name: "live_second",
        description: "Second live host tool.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    ];
    await handle.refresh();
    await changed;

    const second = await client.listTools();
    expect(second.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([...first.tools.map((tool) => tool.name), "codex_app__live_second"]),
    );
    const search = await client.callTool({
      name: "search_native_tools",
      arguments: { query: "codex_app__live_second" },
    });
    expect(objectValue(search.structuredContent).tools).toEqual([
      expect.objectContaining({
        name: "codex_app__live_second",
        executeWith: "call_native_tool",
        executeArguments: expect.objectContaining({
          name: "codex_app__live_second",
          arguments: "Supply a value matching inputSchema here.",
        }),
        nativeTool: expect.objectContaining({
          inputSchema: expect.objectContaining({ required: ["value"] }),
        }),
      }),
    ]);

    await client.close();
    await handle.server.close();
  });

  it.each([
    ["compat", false],
    ["full", false],
    ["compat", true],
    ["full", true],
  ] as const)(
    "publishes the browser timeout and retains native browser metadata in %s tools with large schema %s",
    async (surface, largeSchema) => {
      const timeout = {
        type: "integer",
        default: 45_000,
        description: largeSchema
          ? `Installed deadline; defaults to 45000 ms. ${"schema detail ".repeat(1_500)}`
          : "Installed deadline; defaults to 45000 ms.",
      };
      const title = { type: "string", description: "Installed execution title." };
      const appServer = {
        request: async <T>(method: string): Promise<T> => {
          if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
          throw new Error(`unexpected method ${method}`);
        },
      };
      const hostExecutor = new CodexAppHostToolExecutor(appServer, {
        appTools: {
          close: () => undefined,
          listTools: async (): Promise<readonly CodexAppNativeTool[]> => [
            {
              namespace: "node_repl",
              name: "js",
              description: "Installed Node execution.",
              inputSchema: {
                type: "object",
                properties: { code: { type: "string" }, timeout_ms: timeout, title },
                required: ["code"],
              },
            },
          ],
          callTool: async () => ({ success: true, contentItems: [] }),
        },
      });
      await hostExecutor.refreshTools();
      const handle = createOmniCodexMcpServer({
        appServer,
        surface,
        codexAppHostToolExecutor: hostExecutor,
        browserNativeExecutor: { call: async () => ({ content: [] }) },
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "browser-metadata-parity", version: "1.0.0" });
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const listed = await client.listTools();
        for (const name of [
          "chrome__control_chrome",
          "browser__control_in_app_browser",
          "chrome__list_user_tabs",
        ]) {
          const direct = listed.tools.find((tool) => tool.name === name);
          expect(direct?.inputSchema.properties?.timeout_ms).toEqual({
            ...timeout,
            default: 90_000,
            description: expect.stringContaining("90000 ms"),
          });
          expect(
            (direct?.inputSchema.properties?.timeout_ms as { description?: string } | undefined)
              ?.description,
          ).toContain(timeout.description);
          expect(direct?.inputSchema.properties?.title).toEqual(title);
          expect(direct?.inputSchema.required ?? []).not.toContain("timeout_ms");
          const nativeSchema = structuredClone(direct?.inputSchema);
          if (name === "chrome__control_chrome") {
            expect(nativeSchema?.properties).toHaveProperty("omnicodexInvocationId");
            if (nativeSchema?.properties !== undefined) {
              delete nativeSchema.properties.omnicodexInvocationId;
            }
          }
          const search = await client.callTool({
            name: "search_native_tools",
            arguments: { query: name },
          });
          expect(objectValue(search.structuredContent).tools).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                name,
                nativeTool: expect.objectContaining({ inputSchema: nativeSchema }),
              }),
            ]),
          );
          const match = (objectValue(search.structuredContent).tools as unknown[])
            .map(objectValue)
            .find((entry) => entry.name === name);
          if (name === "chrome__control_chrome") {
            expect(match?.executionInputSchema).toEqual(direct?.inputSchema);
            const validate = new Ajv({ strict: false }).compile(
              match?.executionInputSchema as object,
            );
            expect(
              validate({
                operation: "exec",
                code: "return syntheticRead();",
                omnicodexInvocationId: "discovered-browser-identity-0001",
              }),
            ).toBe(true);
            expect(validate({ operation: "exec", omnicodexInvocationId: "short" })).toBe(false);
            const searchContent = Array.isArray(search.content)
              ? search.content.map(objectValue)
              : [];
            const manifest = searchContent.find(
              (item) =>
                item.type === "text" &&
                typeof item.text === "string" &&
                item.text.startsWith("OMNICODEX_NATIVE_SEARCH_V2:"),
            );
            expect(manifest?.type).toBe("text");
            if (typeof manifest?.text !== "string") throw new Error("search manifest missing");
            expect(
              JSON.parse(manifest.text.split("OMNICODEX_NATIVE_SEARCH_V2:")[1] ?? "").tools,
            ).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ name, executionInputSchema: direct?.inputSchema }),
              ]),
            );
            const inline = searchContent.find(
              (item) =>
                typeof item.text === "string" &&
                item.text.startsWith("OMNICODEX_NATIVE_SEARCH_EXECUTION_V1:"),
            );
            if (typeof inline?.text !== "string") throw new Error("inline search contract missing");
            const inlineContract = JSON.parse(
              inline.text.split("OMNICODEX_NATIVE_SEARCH_EXECUTION_V1:")[1] ?? "",
            );
            expect(inlineContract.executeWith).toBe(match?.executeWith);
            if (largeSchema) expect(inlineContract).not.toHaveProperty("executionInputSchema");
            else expect(inlineContract.executionInputSchema).toEqual(direct?.inputSchema);
          } else {
            expect(match).not.toHaveProperty("executionInputSchema");
          }
        }
      } finally {
        await client.close();
        await handle.server.close();
      }
    },
  );

  it("keeps the actual direct Node REPL name in the bounded ChatGPT action surface", async () => {
    const nativeCalls: unknown[] = [];
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected method ${method}`);
      },
    };
    const appTools = {
      close: () => undefined,
      listTools: async (): Promise<readonly CodexAppNativeTool[]> => [
        {
          namespace: "node_repl",
          name: "js",
          description: "Execute JavaScript in a persistent node_repl.",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: { code: { type: "string" } },
            required: ["code"],
            additionalProperties: false,
          },
        },
        {
          namespace: "node_repl",
          name: "js_reset",
          description: "Reset the persistent node_repl.",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        {
          namespace: "node_repl",
          name: "js_add_node_module_dir",
          description: "Add a node_modules directory to the persistent node_repl.",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      ],
      callTool: async (params: unknown) => {
        nativeCalls.push(params);
        return { success: true, contentItems: [] };
      },
    };
    const hostExecutor = new CodexAppHostToolExecutor(appServer, {
      appTools,
      appToolsContextThreadId: () => "browser-presentation-thread",
    });
    await hostExecutor.refreshTools();

    const connect = async (surface: "compat" | "full", actionCatalogByteBudget?: number) => {
      const handle = createOmniCodexMcpServer({
        appServer,
        codexAppHostToolExecutor: hostExecutor,
        surface,
        ...(actionCatalogByteBudget === undefined ? {} : { actionCatalogByteBudget }),
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: `browser-presentation-${surface}`, version: "1.0.0" });
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      return { client, handle };
    };
    const full = await connect("full");
    const compat = await connect("compat");
    const bounded = await connect("full", OMNICODEX_CHATGPT_ACTION_CATALOG_BYTE_BUDGET);
    try {
      const allTools: Tool[] = [];
      let page = await full.client.listTools();
      allTools.push(...page.tools);
      while (page.nextCursor !== undefined) {
        page = await full.client.listTools({ cursor: page.nextCursor });
        allTools.push(...page.tools);
      }
      const fullNodeRepl = allTools.find((tool) =>
        tool.description?.includes("Execute JavaScript in a persistent node_repl."),
      );
      expect(fullNodeRepl?.description).toBe("Execute JavaScript in a persistent node_repl.");
      expect(fullNodeRepl?.annotations).toEqual(ALL_FALSE_ANNOTATIONS);
      const fullNodeReplMetadata = objectValue(fullNodeRepl?._meta?.omnicodex);
      expect(fullNodeReplMetadata).not.toHaveProperty("stateEffect");
      expect(fullNodeReplMetadata).not.toHaveProperty("readOnly");
      expect(fullNodeReplMetadata).not.toHaveProperty("annotationCorrection");
      expect(fullNodeRepl?.name).toBe("node_repl__js");
      expect(OMNICODEX_FULL_CATALOG_PRIORITY).toEqual(
        expect.arrayContaining([
          "node_repl__js",
          "node_repl__js_reset",
          "node_repl__js_add_node_module_dir",
          "mcp__node_repl__js",
          "mcp__node_repl__js_reset",
          "mcp__node_repl__js_add_node_module_dir",
        ]),
      );

      const boundedTools = await bounded.client.listTools();
      const boundedNodeRepl = boundedTools.tools.find((tool) => tool.name === "node_repl__js");
      expect(boundedNodeRepl?.description).toBe("Execute JavaScript in a persistent node_repl.");
      expect(boundedNodeRepl?.annotations).toEqual(ALL_FALSE_ANNOTATIONS);
      expect(boundedTools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "node_repl__js",
          "node_repl__js_reset",
          "node_repl__js_add_node_module_dir",
        ]),
      );
      await expect(
        bounded.client.callTool({
          name: "node_repl__js",
          arguments: { code: "nodeRepl.write('native-ok')" },
        }),
      ).resolves.not.toMatchObject({ isError: true });
      expect(nativeCalls.at(-1)).toMatchObject({
        namespace: "node_repl",
        tool: "js",
        arguments: { code: "nodeRepl.write('native-ok')" },
      });

      const fullSearch = await full.client.callTool({
        name: "search_native_tools",
        arguments: { query: "node_repl__js" },
      });
      const fullMatches = objectValue(fullSearch.structuredContent).tools;
      const fullSearchMatch = Array.isArray(fullMatches) ? objectValue(fullMatches[0]) : {};
      expect(fullSearchMatch.executeWith).toBe(fullNodeRepl?.name);
      expect(fullSearchMatch.executeArguments).toMatchObject({
        code: "Supply code matching nativeTool.inputSchema.",
      });
      expect(objectValue(fullSearchMatch.nativeTool).name).toBe("js");
      expect(objectValue(fullSearchMatch.nativeTool).annotations).toEqual(ALL_FALSE_ANNOTATIONS);
      expect(fullSearchMatch.executionAnnotations).toBeUndefined();
      expect(fullSearchMatch).not.toHaveProperty("tool");
      expect(fullSearchMatch).not.toHaveProperty("description");
      expect(fullSearchMatch).not.toHaveProperty("inputSchema");

      const search = await compat.client.callTool({
        name: "search_native_tools",
        arguments: { query: "node_repl__js" },
      });
      const matches = objectValue(search.structuredContent).tools;
      const nodeRepl = Array.isArray(matches) ? objectValue(matches[0]) : {};
      expect(objectValue(nodeRepl.nativeTool).description).toBe(
        "Execute JavaScript in a persistent node_repl.",
      );
      expect(objectValue(nodeRepl.nativeTool).name).toBe("js");
      expect(objectValue(nodeRepl.nativeTool).annotations).toEqual(ALL_FALSE_ANNOTATIONS);
      expect(nodeRepl.executionAnnotations).toBeUndefined();
      await expect(
        compat.client.callTool({
          name: String(nodeRepl.executeWith),
          arguments: {
            ...objectValue(nodeRepl.executeArguments),
            arguments: { code: "nodeRepl.write('search-route-ok')" },
          },
        }),
      ).resolves.not.toMatchObject({ isError: true });
      expect(nativeCalls.at(-1)).toMatchObject({
        namespace: "node_repl",
        tool: "js",
        arguments: { code: "nodeRepl.write('search-route-ok')" },
      });
      expect(nodeRepl).not.toHaveProperty("tool");
      expect(nodeRepl).not.toHaveProperty("description");
      expect(nodeRepl).not.toHaveProperty("annotations");
      expect(nodeRepl).not.toHaveProperty("_meta");

      const staleSnapshotFallback = await compat.client.callTool({
        name: "call_native_tool",
        arguments: {
          name: "search_native_tools",
          arguments: { query: "node_repl__js" },
        },
      });
      expect(staleSnapshotFallback.isError).not.toBe(true);
      const staleMatches = objectValue(staleSnapshotFallback.structuredContent).tools;
      const staleNodeRepl = Array.isArray(staleMatches) ? objectValue(staleMatches[0]) : {};
      expect(staleNodeRepl.name).toBe("node_repl__js");
      expect(objectValue(staleNodeRepl.nativeTool).annotations).toEqual(ALL_FALSE_ANNOTATIONS);
      expect(staleNodeRepl.executionAnnotations).toBeUndefined();
    } finally {
      await bounded.client.close();
      await bounded.handle.server.close();
      await compat.client.close();
      await compat.handle.server.close();
      await full.client.close();
      await full.handle.server.close();
    }
  });

  it("deduplicates one mutable host invocation across independent MCP sessions", async () => {
    const mutationReplayStore = MutationReplayStore.inMemory();
    const legacyMutationCoordinator = LegacyMutationCoordinator.inMemory();
    const authorizationBinding = "https://issuer.example\0owner-subject\0client\0omnicodex";
    const nativeCalls: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
    const replayObservations: Array<{
      session: string;
      disposition: string;
      callerProvenance: McpMutationReplayObservation["callerProvenance"];
      chatGptConversationIdSha256: string | undefined;
      principalBindingSha256: string | undefined;
      jsonRpcIdHmac: string | undefined;
    }> = [];
    let releaseMutation!: () => void;
    const mutationReleased = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let mutationStarted!: () => void;
    const firstMutationStarted = new Promise<void>((resolve) => {
      mutationStarted = resolve;
    });
    const liveTools: CodexAppNativeTool[] = [
      {
        namespace: "codex_app",
        name: "write_marker",
        description: "Write one deterministic test marker.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
      {
        namespace: "codex_app",
        name: "read_marker",
        description: "Read one deterministic test marker.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    ];
    const appTools = {
      close: () => undefined,
      listTools: async () => liveTools,
      callTool: async (params: { tool: string; arguments: Record<string, unknown> }) => {
        nativeCalls.push({ tool: params.tool, arguments: params.arguments });
        if (params.tool === "write_marker") {
          mutationStarted();
          await mutationReleased;
          if (params.arguments.value === "explode") {
            throw new Error("native result channel failed after dispatch");
          }
        }
        return {
          success: true,
          contentItems: [
            {
              type: "inputText" as const,
              text: JSON.stringify({ tool: params.tool, arguments: params.arguments }),
            },
          ],
        };
      },
    };
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected method ${method}`);
      },
    };
    const createSession = async (session: string) => {
      const hostExecutor = new CodexAppHostToolExecutor(appServer, {
        appToolsContextThreadId: () => "bridge-thread",
        appTools,
      });
      const handle = createOmniCodexMcpServer({
        appServer,
        codexAppHostToolExecutor: hostExecutor,
        surface: "full",
        mutationReplayStore,
        legacyMutationCoordinator,
        authorizationBinding,
        correlationId: session,
        resolveRequestAttribution: () => ({
          principalBindingSha256: `principal-${session}`,
          callerProvenance: "chatgpt_conversation",
          chatGptConversationIdSha256: (session === "first" ? "d" : "e").repeat(64),
          jsonRpcIdHmac: `json-rpc-${session}`,
        }),
        observeMutationReplay: (observation) => {
          replayObservations.push({
            session,
            disposition: observation.disposition,
            callerProvenance: observation.callerProvenance,
            chatGptConversationIdSha256: observation.chatGptConversationIdSha256,
            principalBindingSha256: observation.principalBindingSha256,
            jsonRpcIdHmac: observation.jsonRpcIdHmac,
          });
          throw new Error("mutation replay observation failed");
        },
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: `mutation-${session}`, version: "1.0.0" });
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      return { client, handle };
    };
    const first = await createSession("first");
    const second = await createSession("second");

    try {
      const firstTools = await first.client.listTools();
      const mutableTool = firstTools.tools.find((tool) => tool.name === "codex_app__write_marker");
      const readTool = firstTools.tools.find((tool) => tool.name === "codex_app__read_marker");
      expect(mutableTool?.inputSchema).toMatchObject({
        properties: {
          value: { type: "string" },
        },
        required: ["value"],
        additionalProperties: false,
      });
      expect(objectValue(mutableTool?.inputSchema).required).not.toContain("omnicodexInvocationId");
      expect(objectValue(readTool?.inputSchema).required).toEqual(["value"]);
      expect(objectValue(objectValue(readTool?.inputSchema).properties)).not.toHaveProperty(
        "omnicodexInvocationId",
      );

      const invocationId = "web-gpt-mutation-20260827-0001";
      const firstCall = first.client.callTool({
        name: "codex_app__write_marker",
        arguments: { value: "alpha", omnicodexInvocationId: invocationId },
      });
      await firstMutationStarted;
      const duplicateCall = second.client.callTool({
        name: "codex_app__write_marker",
        arguments: { value: "alpha", omnicodexInvocationId: invocationId },
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      releaseMutation();
      const [firstResult, duplicateResult] = await Promise.all([firstCall, duplicateCall]);

      expect(firstResult).toEqual(duplicateResult);
      expect(nativeCalls).toEqual([{ tool: "write_marker", arguments: { value: "alpha" } }]);
      expect(replayObservations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            session: "first",
            disposition: "execute",
            callerProvenance: "chatgpt_conversation",
            chatGptConversationIdSha256: "d".repeat(64),
            principalBindingSha256: "principal-first",
            jsonRpcIdHmac: "json-rpc-first",
          }),
          expect.objectContaining({
            session: "second",
            disposition: "join",
            callerProvenance: "chatgpt_conversation",
            chatGptConversationIdSha256: "e".repeat(64),
            principalBindingSha256: "principal-second",
            jsonRpcIdHmac: "json-rpc-second",
          }),
        ]),
      );

      const conflicting = await second.client.callTool({
        name: "codex_app__write_marker",
        arguments: { value: "beta", omnicodexInvocationId: invocationId },
      });
      expect(conflicting.isError).toBe(true);
      expect(conflicting.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining("different mutation fingerprint"),
        },
      ]);
      expect(nativeCalls).toHaveLength(1);
      expect(replayObservations).toContainEqual(
        expect.objectContaining({
          session: "second",
          disposition: "conflict",
          callerProvenance: "chatgpt_conversation",
          chatGptConversationIdSha256: "e".repeat(64),
        }),
      );

      const read = await second.client.callTool({
        name: "codex_app__read_marker",
        arguments: { value: "alpha" },
      });
      expect(read.isError).not.toBe(true);
      expect(nativeCalls).toEqual([
        { tool: "write_marker", arguments: { value: "alpha" } },
        { tool: "read_marker", arguments: { value: "alpha" } },
      ]);

      const unknownInvocationId = "web-gpt-mutation-20260827-unknown";
      const unknown = await first.client.callTool({
        name: "codex_app__write_marker",
        arguments: { value: "explode", omnicodexInvocationId: unknownInvocationId },
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining("MUTATION_OUTCOME_UNKNOWN"),
        },
      ]);

      const blockedReplay = await second.client.callTool({
        name: "codex_app__write_marker",
        arguments: { value: "explode", omnicodexInvocationId: unknownInvocationId },
      });
      expect(blockedReplay.isError).toBe(true);
      expect(blockedReplay.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining("MUTATION_OUTCOME_UNKNOWN"),
        },
      ]);
      expect(nativeCalls.filter((call) => call.arguments.value === "explode")).toHaveLength(1);
      expect(replayObservations).toContainEqual(
        expect.objectContaining({
          session: "second",
          disposition: "outcome_unknown",
          callerProvenance: "chatgpt_conversation",
          chatGptConversationIdSha256: "e".repeat(64),
        }),
      );
    } finally {
      releaseMutation();
      await first.client.close();
      await first.handle.server.close();
      await second.client.close();
      await second.handle.server.close();
    }
  });

  it("does not reinterpret an exact browser timeout_ms argument as a scheduler deadline", async () => {
    const scheduler = new NativeExecutionScheduler();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = scheduler
      .run(
        {
          entry: {
            nativeNamespace: "chrome",
            originalName: "chrome__control_chrome",
            source: "codex_browser_client",
          },
        },
        () => held,
      )
      .catch(() => undefined);
    const browserCalls: unknown[] = [];
    const handle = createOmniCodexMcpServer({
      appServer: {
        request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T,
      },
      browserNativeExecutor: {
        call: async (args) => {
          browserCalls.push(args);
          return { content: [{ type: "text" as const, text: "browser-ok" }] };
        },
      },
      scheduler,
      mutationReplayStore: MutationReplayStore.inMemory(),
      authorizationBinding: "owner",
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "native-timeout-argument", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    const invocationId = "native-timeout-argument";
    try {
      const queued = client.callTool({
        name: "chrome__control_chrome",
        arguments: {
          code: "return await browser.tabs.list();",
          timeout_ms: 10,
          omnicodexInvocationId: invocationId,
        },
      });
      let settled = false;
      void queued.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(false);
      expect(browserCalls).toEqual([]);

      release();
      await blocker;
      const result = await queued;
      expect(result.isError).not.toBe(true);
      expect(browserCalls).toEqual([
        {
          operation: "list_tabs",
          surface: "chrome",
          code: "return await browser.tabs.list();",
          timeout_ms: 10,
        },
      ]);
    } finally {
      release();
      await blocker;
      await client.close();
      await handle.server.close();
    }
  });

  it("does not redispatch an ambiguous id-less mutation across independent MCP sessions", async () => {
    let releaseMutation!: () => void;
    const mutationReleased = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let mutationStarted!: () => void;
    const firstMutationStarted = new Promise<void>((resolve) => {
      mutationStarted = resolve;
    });
    const rig = createMutableHostTestRig(async () => {
      mutationStarted();
      await mutationReleased;
    });
    const first = await rig.createSession("legacy-first");
    const second = await rig.createSession("legacy-second");

    try {
      const firstCall = first.client.callTool({
        name: "codex_app__write_marker",
        arguments: { value: "cached-schema-value" },
      });
      await firstMutationStarted;
      const duplicateResult = await second.client.callTool({
        name: "codex_app__write_marker",
        arguments: { value: "cached-schema-value" },
      });
      expect(duplicateResult.isError).toBe(true);
      expect(JSON.stringify(duplicateResult)).toContain("AMBIGUOUS_LEGACY_MUTATION_COHORT");
      releaseMutation();

      const firstResult = await firstCall;
      expect(firstResult.isError).not.toBe(true);
      expect(rig.nativeCalls).toEqual([
        { tool: "write_marker", arguments: { value: "cached-schema-value" } },
      ]);
      expect(rig.replayObservations).toEqual(
        expect.arrayContaining([
          { session: "legacy-first", identityMode: "legacy", disposition: "execute" },
        ]),
      );
    } finally {
      releaseMutation();
      await rig.close();
    }
  });

  it("executes identical completed arguments again on a new MCP connection", async () => {
    const rig = createMutableHostTestRig();
    const first = await rig.createSession("fresh-connection-first");
    const second = await rig.createSession("fresh-connection-second");
    const call = { name: "codex_app__write_marker", arguments: { value: "same-intended-action" } };
    try {
      expect((await first.client.callTool(call)).isError).not.toBe(true);
      expect((await second.client.callTool(call)).isError).not.toBe(true);
      expect(rig.nativeCalls).toHaveLength(2);
      expect(rig.replayObservations.filter((item) => item.disposition === "execute")).toEqual([
        { session: "fresh-connection-first", identityMode: "legacy", disposition: "execute" },
        { session: "fresh-connection-second", identityMode: "legacy", disposition: "execute" },
      ]);
    } finally {
      await rig.close();
    }
  });

  it("replays authoritative OpenAI tool invocation identity across new MCP connections", async () => {
    const rig = createMutableHostTestRig();
    const first = await rig.createSession("authoritative-call-first");
    const second = await rig.createSession("authoritative-call-reconnect");
    const call = {
      name: "codex_app__write_marker",
      arguments: { value: "exact-authoritative-retry" },
      _meta: { "openai/toolInvocationId": "authoritative-tool-invocation-0001" },
    };
    try {
      const result = await first.client.callTool(call);
      expect(await second.client.callTool(call)).toEqual(result);
      expect(rig.nativeCalls).toHaveLength(1);
      expect(rig.replayObservations).toEqual([
        { session: "authoritative-call-first", identityMode: "explicit", disposition: "execute" },
        {
          session: "authoritative-call-reconnect",
          identityMode: "explicit",
          disposition: "replay",
        },
      ]);
    } finally {
      await rig.close();
    }
  });

  it("treats different request IDs in one legacy MCP session as distinct mutations", async () => {
    const rig = createMutableHostTestRig();
    const session = await rig.createSession("legacy-one-session");

    try {
      const first = await session.client.callTool({
        name: "codex_app__write_marker",
        arguments: { value: "repeat-intentionally" },
      });
      const second = await session.client.callTool({
        name: "codex_app__write_marker",
        arguments: { value: "repeat-intentionally" },
      });

      expect(first.isError).not.toBe(true);
      expect(second.isError).not.toBe(true);
      expect(rig.nativeCalls).toEqual([
        { tool: "write_marker", arguments: { value: "repeat-intentionally" } },
        { tool: "write_marker", arguments: { value: "repeat-intentionally" } },
      ]);
      expect(
        rig.replayObservations.filter(
          (observation) =>
            observation.session === "legacy-one-session" &&
            observation.identityMode === "legacy" &&
            observation.disposition === "execute",
        ),
      ).toHaveLength(2);
    } finally {
      await rig.close();
    }
  });

  it("keeps distinct explicit IDs independent and replays payloads larger than 8 KiB", async () => {
    const rig = createMutableHostTestRig();
    const first = await rig.createSession("large-first");
    const second = await rig.createSession("large-second");
    const largeValue = `large-${"x".repeat(9 * 1_024)}`;

    try {
      const firstResult = await first.client.callTool({
        name: "codex_app__write_marker",
        arguments: {
          value: largeValue,
          omnicodexInvocationId: "large-explicit-operation-a",
        },
      });
      const secondResult = await second.client.callTool({
        name: "codex_app__write_marker",
        arguments: {
          value: largeValue,
          omnicodexInvocationId: "large-explicit-operation-b",
        },
      });
      const replayedFirst = await second.client.callTool({
        name: "codex_app__write_marker",
        arguments: {
          value: largeValue,
          omnicodexInvocationId: "large-explicit-operation-a",
        },
      });

      expect(firstResult.isError).not.toBe(true);
      expect(secondResult.isError).not.toBe(true);
      expect(replayedFirst).toEqual(firstResult);
      expect(rig.nativeCalls).toHaveLength(2);
      expect(rig.nativeCalls.every((call) => call.arguments.value === largeValue)).toBe(true);
      expect(rig.replayObservations).toEqual(
        expect.arrayContaining([
          { session: "large-first", identityMode: "explicit", disposition: "execute" },
          { session: "large-second", identityMode: "explicit", disposition: "execute" },
          { session: "large-second", identityMode: "explicit", disposition: "replay" },
        ]),
      );
    } finally {
      await rig.close();
    }
  });

  it("routes every direct and registry execution surface through the injected scheduler", async () => {
    const scheduler = new RecordingNativeExecutionScheduler();
    const appServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error(`unexpected method ${method}`);
      },
    };
    const liveTools: CodexAppNativeTool[] = [
      {
        namespace: "codex_app",
        name: "read_path_probe",
        description: "Read a path for scheduler routing tests.",
        inputSchema: {
          type: "object",
          properties: {
            threadId: { type: "string" },
            thread_id: { type: "string" },
            processId: { type: "string" },
            process_id: { type: ["string", "number"] },
            path: { type: "string" },
            file_paths: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
      },
    ];
    const appTools = {
      close: () => undefined,
      listTools: async () => liveTools,
      callTool: async (params: { tool: string; arguments: Record<string, unknown> }) => ({
        success: true,
        contentItems: [
          {
            type: "inputText" as const,
            text: JSON.stringify({ tool: params.tool, arguments: params.arguments }),
          },
        ],
      }),
    };
    const hostExecutor = new CodexAppHostToolExecutor(appServer, {
      appToolsContextThreadId: () => "bridge-thread",
      appTools,
    });
    const responsesSource = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [{ type: "custom", name: "exec", description: "Execute native JavaScript" }],
          },
        ],
        nestedTools: [
          {
            name: "registry_path_probe",
            description: "Read one nested native path target.",
            inputSchema: {
              type: "object",
              properties: {
                target: {
                  type: "object",
                  properties: {
                    thread_id: { type: "string" },
                    process_id: { type: "string" },
                    paths: { type: "array", items: { type: "string" } },
                  },
                  required: ["thread_id", "process_id", "paths"],
                  additionalProperties: false,
                },
              },
              required: ["target"],
              additionalProperties: false,
            },
          },
        ],
      },
    };
    const responsesToolCatalog = new ResponsesNativeToolCatalog(responsesSource);
    const responsesToolExecutor = new ResponsesNativeToolExecutor({
      call: async () => ({
        callId: "scheduler-exec",
        outputType: "custom_tool_call_output" as const,
        executionStatus: "succeeded" as const,
        output: [{ type: "input_text", text: "exec-ok" }],
        rawItem: {
          type: "custom_tool_call_output",
          call_id: "scheduler-exec",
          output: [{ type: "input_text", text: "exec-ok" }],
        },
      }),
      callNested: async (name, argumentsValue) => ({
        content: [{ type: "text", text: JSON.stringify({ name, argumentsValue }) }],
      }),
    });
    const browserNativeExecutor = {
      call: async (argumentsValue: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify(argumentsValue) }],
      }),
    };

    const connect = async (surface: "compat" | "full", name: string) => {
      const handle = createOmniCodexMcpServer({
        appServer,
        browserNativeExecutor,
        codexAppHostToolExecutor: hostExecutor,
        responsesToolCatalog,
        responsesToolExecutor,
        scheduler,
        surface,
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name, version: "1.0.0" });
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      return { client, handle };
    };
    const full = await connect("full", "scheduler-full");
    const compat = await connect("compat", "scheduler-compat");
    try {
      await full.client.listTools();
      await compat.client.listTools();
      await full.client.callTool({
        name: "chrome__control_chrome",
        arguments: { code: "return await browser.tabs.list();" },
      });
      await full.client.callTool({
        name: "codex_app__read_path_probe",
        arguments: {
          threadId: "host-thread",
          process_id: 101,
          path: "C:/Room/host.txt",
        },
      });
      const readableExec = await full.client.callTool({
        name: "codex__functions__exec",
        arguments: { input: 'text("scheduler-ok")' },
      });
      expect(readableExec.content).toEqual([{ type: "text", text: "exec-ok" }]);
      expect(readableExec.structuredContent).toBeUndefined();
      await full.client.callTool({
        name: "registry_path_probe",
        arguments: {
          target: {
            thread_id: "registry-thread",
            process_id: "registry-process",
            paths: ["C:/Room/layout.tscn", "C:/Room/project.godot"],
          },
        },
      });
      await compat.client.callTool({
        name: "call_native_tool",
        arguments: {
          name: "codex_app__read_path_probe",
          arguments: {
            thread_id: "generic-thread",
            processId: "generic-process",
            file_paths: ["C:/Room/generic.txt"],
          },
        },
      });

      expect(scheduler.requests).toHaveLength(5);
      expect(
        scheduler.requests.every(
          (request) => typeof request.operationId === "string" && request.operationId.length > 0,
        ),
      ).toBe(true);
      expect(new Set(scheduler.requests.map((request) => request.operationId)).size).toBe(5);
      const browser = scheduler.requestFor("chrome/control");
      expect(browser.entry).toMatchObject({
        nativeNamespace: "codex_browser_client",
        source: "codex_browser_client",
      });
      const host = scheduler.requestFor("codex_app/read_path_probe", 0);
      expect(host.ordering).toEqual({
        threadId: "host-thread",
        processId: "101",
        filePaths: ["C:\\Room\\host.txt"],
      });
      const codeMode = scheduler.requestFor("exec");
      expect(codeMode.entry).toMatchObject({
        nativeNamespace: "functions",
        source: "codex_responses_runtime",
      });
      const registry = scheduler.requestFor("registry_path_probe");
      expect(registry.ordering).toEqual({
        threadId: "registry-thread",
        processId: "registry-process",
        filePaths: ["C:\\Room\\layout.tscn", "C:\\Room\\project.godot"],
      });
      const generic = scheduler.requestFor("codex_app/read_path_probe", 1);
      expect(generic.ordering).toEqual({
        threadId: "generic-thread",
        processId: "generic-process",
        filePaths: ["C:\\Room\\generic.txt"],
      });
    } finally {
      await compat.client.close();
      await compat.handle.server.close();
      await full.client.close();
      await full.handle.server.close();
    }
  });
});

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

class RecordingNativeExecutionScheduler extends NativeExecutionScheduler {
  readonly requests: NativeExecutionRequest[] = [];

  override async run<T>(
    request: NativeExecutionRequest,
    operation: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.requests.push(request);
    return super.run(request, operation);
  }

  requestFor(originalName: string, occurrence = 0): NativeExecutionRequest {
    const request = this.requests.filter(
      (candidate) => candidate.entry.originalName === originalName,
    )[occurrence];
    if (request === undefined) throw new Error(`Missing scheduler request for ${originalName}`);
    return request;
  }
}

class BoundarySignalScheduler extends NativeExecutionScheduler {
  readonly requests: NativeExecutionRequest[] = [];
  readonly #signal: AbortSignal;

  constructor(signal: AbortSignal) {
    super();
    this.#signal = signal;
  }

  override async run<T>(
    request: NativeExecutionRequest,
    operation: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.requests.push(request);
    await request.beforeOperation?.(this.#signal);
    return operation(this.#signal);
  }
}

function directFunctionsExecCatalog(): ResponsesNativeToolCatalog {
  return new ResponsesNativeToolCatalog({
    snapshot: {
      refreshedAtUnixMs: 1,
      requestCount: 1,
      tools: [
        {
          type: "namespace",
          name: "functions",
          tools: [{ type: "custom", name: "exec", description: "Execute native tools" }],
        },
      ],
    },
  });
}

function directWorkAppServerMethodCatalog(): AppServerMethodCatalog {
  return new AppServerMethodCatalog({
    loadClientRequestSchema: async () => ({
      definitions: {
        FsReadFileParams: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        FsWriteFileParams: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
        CommandExecParams: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
        FsRemoveParams: {
          type: "object",
          properties: {
            path: { type: "string" },
            recursive: { type: "boolean" },
            force: { type: "boolean" },
          },
          required: ["path"],
        },
      },
      oneOf: [
        requestSchema("Fs/readFileRequest", "fs/readFile", "FsReadFileParams"),
        requestSchema("Fs/writeFileRequest", "fs/writeFile", "FsWriteFileParams"),
        requestSchema("Fs/removeRequest", "fs/remove", "FsRemoveParams"),
        requestSchema("Command/execRequest", "command/exec", "CommandExecParams"),
      ],
    }),
  });
}

function requestSchema(title: string, method: string, definition: string): Record<string, unknown> {
  return {
    title,
    properties: {
      method: { enum: [method] },
      params: { $ref: `#/definitions/${definition}` },
    },
  };
}

function createMutableHostTestRig(onWrite?: (value: string) => Promise<void>) {
  const mutationReplayStore = MutationReplayStore.inMemory();
  const legacyMutationCoordinator = LegacyMutationCoordinator.inMemory();
  const authorizationBinding = "https://issuer.example\0owner-subject\0client\0omnicodex";
  const nativeCalls: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
  const replayObservations: Array<{
    session: string;
    identityMode: string;
    disposition: string;
  }> = [];
  const connected: Array<{
    client: Client;
    handle: ReturnType<typeof createOmniCodexMcpServer>;
  }> = [];
  const liveTools: CodexAppNativeTool[] = [
    {
      namespace: "codex_app",
      name: "write_marker",
      description: "Write one deterministic test marker.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
  ];
  const appTools = {
    close: () => undefined,
    listTools: async () => liveTools,
    callTool: async (params: { tool: string; arguments: Record<string, unknown> }) => {
      nativeCalls.push({ tool: params.tool, arguments: params.arguments });
      if (params.tool === "write_marker" && onWrite !== undefined) {
        await onWrite(String(params.arguments.value));
      }
      return {
        success: true,
        contentItems: [
          {
            type: "inputText" as const,
            text: JSON.stringify({ tool: params.tool, arguments: params.arguments }),
          },
        ],
      };
    },
  };
  const appServer = {
    request: async <T>(method: string): Promise<T> => {
      if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
      throw new Error(`unexpected method ${method}`);
    },
  };

  return {
    nativeCalls,
    replayObservations,
    createSession: async (session: string) => {
      const hostExecutor = new CodexAppHostToolExecutor(appServer, {
        appToolsContextThreadId: () => "bridge-thread",
        appTools,
      });
      const handle = createOmniCodexMcpServer({
        appServer,
        codexAppHostToolExecutor: hostExecutor,
        surface: "full",
        mutationReplayStore,
        legacyMutationCoordinator,
        authorizationBinding,
        correlationId: session,
        observeMutationReplay: (observation) => {
          replayObservations.push({
            session,
            identityMode: observation.identityMode ?? "missing",
            disposition: observation.disposition,
          });
        },
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: `mutation-${session}`, version: "1.0.0" });
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      connected.push({ client, handle });
      return { client, handle };
    },
    close: async () => {
      for (const connection of connected.reverse()) {
        await connection.client.close();
        await connection.handle.server.close();
      }
    },
  };
}
