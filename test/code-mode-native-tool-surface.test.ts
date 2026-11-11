import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  type AppServerMethodDescriptor,
  parseAppServerMethodCatalog,
} from "../src/application/app-server-method-catalog.js";
import {
  CodeModeNativeToolSurface,
  codeModeBrowserNativeTools,
} from "../src/application/code-mode-native-tool-surface.js";
import type {
  CodexAppHostToolCallContext,
  CodexAppHostToolDescriptor,
  CodexDynamicToolCallParams,
  CodexDynamicToolCallResponse,
} from "../src/application/codex-app-host-tool-executor.js";
import { NativeExecutionScheduler } from "../src/application/native-execution-scheduler.js";
import {
  type NativeToolDescriptor,
  NativeToolExecutor,
} from "../src/application/native-tool-catalog.js";
import { directGoalOwnerBinding } from "../src/infrastructure/mcp/direct-goal-mcp-tools.js";
import { DirectGoalStore } from "../src/infrastructure/mcp/direct-goal-store.js";
import { MutationReplayStore } from "../src/infrastructure/mcp/mutation-replay-store.js";

const COMPUTER_USE_HOST_NAME = "codex__computer_use__list_apps";
const DOWNSTREAM_CODE_MODE_NAME = "read_file";

describe("CodeModeNativeToolSurface", () => {
  it("does not turn a shared caller thread into a lock for independent nested commands", async () => {
    const descriptor = {
      ...methodDescriptor("codex__app_server__command_exec", objectSchema({})),
      stateEffect: "mutate" as const,
    };
    const fixture = makeSurface({ hostTools: [], methods: [descriptor] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.methodCall.mockImplementation(async (_descriptor, args) => {
      await gate;
      return args;
    });
    const calls = ["first", "second"].map((label) =>
      fixture.surface.callDynamic({
        tool: descriptor.exposedName,
        threadId: "same-caller-thread",
        callId: label,
        arguments: { command: ["node", "-e", label] },
      }),
    );
    try {
      await vi.waitFor(() => expect(fixture.methodCall).toHaveBeenCalledTimes(2));
    } finally {
      release();
      const results = await Promise.all(calls);
      expect(results.every((result) => result.success)).toBe(true);
    }
  });

  it("recovers a committed child result from disk after both store instances restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-goal-child-"));
    try {
      const goalPath = join(root, "goal.json");
      const replayPath = join(root, "replay.json");
      const targetPath = join(root, "native-result.txt");
      const ownerBinding = "issuer\0owner\0client\0resource";
      const workSessionBinding = "restart-chat";
      const authorizationBinding = directGoalOwnerBinding(ownerBinding, workSessionBinding);
      const goalStore = await DirectGoalStore.open({ snapshotPath: goalPath });
      const replayStore = await MutationReplayStore.open({ snapshotPath: replayPath });
      const goal = await goalStore.create({
        authorizationBinding,
        objective: "Write the requested result exactly once",
      });
      const make = (directGoalStore: DirectGoalStore, mutationReplayStore: MutationReplayStore) =>
        makeSurface({
          hostTools: [
            { ...hostDescriptor("native__write", objectSchema({})), stateEffect: "mutate" },
          ],
          methods: [],
          directGoalStore,
          mutationReplayStore,
          browserCallContext: () => ({ ownerBinding, workSessionBinding }),
        });
      const beforeRestart = make(goalStore, replayStore);
      beforeRestart.hostCall.mockImplementation(async () => {
        await writeFile(targetPath, "original native result", "utf8");
        return {
          success: true,
          contentItems: [{ type: "inputText", text: "native write completed" }],
        };
      });
      goalStore.finalizeExecution = async () => {
        throw new Error("receipt writer interrupted after result commit");
      };
      const call = {
        tool: "native__write",
        callId: "persisted-native-child",
        arguments: { path: targetPath },
      };
      expect((await beforeRestart.surface.callDynamic(call)).success).toBe(false);
      for (const [symbolName, path] of [
        ["@heelee912/omnicodex/direct-goal-cores/v2", goalPath],
        ["@heelee912/omnicodex/mutation-replay-cores/v1", replayPath],
      ]) {
        const registry = Reflect.get(globalThis, Symbol.for(symbolName as string)) as Map<
          string,
          unknown
        >;
        registry.delete(
          process.platform === "win32"
            ? (path as string).toLocaleLowerCase("en-US")
            : (path as string),
        );
      }
      const reopenedGoal = await DirectGoalStore.open({ snapshotPath: goalPath });
      const reopenedReplay = await MutationReplayStore.open({ snapshotPath: replayPath });
      const afterRestart = make(reopenedGoal, reopenedReplay);
      expect((await afterRestart.surface.callDynamic(call)).success).toBe(true);
      expect(afterRestart.hostCall).not.toHaveBeenCalled();
      expect(await readFile(targetPath, "utf8")).toBe("original native result");
      expect(
        (await reopenedGoal.complete({ authorizationBinding, goalId: goal.id })).steps,
      ).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("records individual native children in the owning Goal and replays them without executing again", async () => {
    const directGoalStore = DirectGoalStore.inMemory();
    const mutationReplayStore = MutationReplayStore.inMemory();
    const ownerBinding = "issuer\0owner\0client\0resource";
    const workSessionBinding = "chat-one";
    const authorizationBinding = directGoalOwnerBinding(ownerBinding, workSessionBinding);
    const goal = await directGoalStore.create({
      authorizationBinding,
      objective: "Perform and verify the requested native work",
    });
    const fixture = makeSurface({
      hostTools: [
        {
          ...hostDescriptor("native__work", objectSchema({})),
          stateEffect: "mutate",
          modelEffect: "model",
        },
      ],
      methods: [],
      directGoalStore,
      mutationReplayStore,
      browserCallContext: () => ({ ownerBinding, workSessionBinding }),
    });
    const call = {
      tool: "native__work",
      callId: "nested-work-one",
      arguments: { path: "C:/work/result.txt" },
    };
    const result = await fixture.surface.callDynamic(call);
    expect(result.success).toBe(true);
    expect(await fixture.surface.callDynamic(call)).toEqual(result);
    expect(fixture.hostCall).toHaveBeenCalledTimes(1);
    const stored = await directGoalStore.get(authorizationBinding);
    expect(stored?.steps).toHaveLength(1);
    expect(stored?.steps[0]?.receipts[0]).toMatchObject({
      toolName: "native__work",
      stateEffect: "mutate",
      role: "work",
    });
    expect(
      (await fixture.surface.callDynamic({ ...call, arguments: { path: "C:/work/different.txt" } }))
        .success,
    ).toBe(false);
    expect(fixture.hostCall).toHaveBeenCalledTimes(1);
    await directGoalStore.complete({ authorizationBinding, goalId: goal.id });
    expect(await fixture.surface.callDynamic(call)).toEqual(result);
    expect(fixture.hostCall).toHaveBeenCalledTimes(1);
  });

  it("repairs a child receipt from its committed result after surface recreation, preserving owner isolation", async () => {
    const directGoalStore = DirectGoalStore.inMemory();
    const mutationReplayStore = MutationReplayStore.inMemory();
    const ownerBinding = "issuer\0owner\0client\0resource";
    const authorizationBinding = directGoalOwnerBinding(ownerBinding, "chat-one");
    const goal = await directGoalStore.create({
      authorizationBinding,
      objective: "Deliver the native result once",
    });
    const finalize = directGoalStore.finalizeExecution.bind(directGoalStore);
    let failReceipt = true;
    directGoalStore.finalizeExecution = async (input) => {
      if (failReceipt) {
        failReceipt = false;
        throw new Error("receipt commit interrupted");
      }
      return finalize(input);
    };
    const make = (workSessionBinding: string) =>
      makeSurface({
        hostTools: [hostDescriptor("native__work", objectSchema({}))],
        methods: [],
        directGoalStore,
        mutationReplayStore,
        browserCallContext: () => ({ ownerBinding, workSessionBinding }),
      });
    const original = make("chat-one");
    const call = { tool: "native__work", callId: "same-native-child", arguments: {} };
    expect(await original.surface.callDynamic(call)).toMatchObject({ success: false });
    expect(original.hostCall).toHaveBeenCalledTimes(1);
    expect((await directGoalStore.complete({ authorizationBinding, goalId: goal.id })).state).toBe(
      "completed",
    );
    const reopened = make("chat-one");
    expect((await reopened.surface.callDynamic(call)).success).toBe(true);
    expect(reopened.hostCall).not.toHaveBeenCalled();
    expect(
      (await directGoalStore.complete({ authorizationBinding, goalId: goal.id })).steps,
    ).toHaveLength(1);
    const other = make("chat-two");
    expect((await other.surface.callDynamic(call)).success).toBe(true);
    expect(other.hostCall).toHaveBeenCalledTimes(1);
  });

  it("retains an unknown child outcome and never retries the physical operation", async () => {
    const directGoalStore = DirectGoalStore.inMemory();
    const mutationReplayStore = MutationReplayStore.inMemory();
    const ownerBinding = "issuer\0owner\0client\0resource";
    const workSessionBinding = "unknown-chat";
    const authorizationBinding = directGoalOwnerBinding(ownerBinding, workSessionBinding);
    const goal = await directGoalStore.create({
      authorizationBinding,
      objective: "Observe the exact native result",
    });
    const fixture = makeSurface({
      hostTools: [hostDescriptor("native__work", objectSchema({}))],
      methods: [],
      directGoalStore,
      mutationReplayStore,
      browserCallContext: () => ({ ownerBinding, workSessionBinding }),
    });
    fixture.hostCall.mockRejectedValueOnce(new Error("native connection lost after dispatch"));
    const call = { tool: "native__work", callId: "unknown-child", arguments: {} };
    expect((await fixture.surface.callDynamic(call)).success).toBe(false);
    const retried = await fixture.surface.callDynamic(call);
    expect(retried.success).toBe(false);
    expect(JSON.stringify(retried)).toContain("NATIVE_CHILD_OUTCOME_UNKNOWN");
    expect(fixture.hostCall).toHaveBeenCalledTimes(1);
    const completed = await directGoalStore.complete({ authorizationBinding, goalId: goal.id });
    expect(completed.state).toBe("completed");
    expect(completed.steps[0]?.reservation?.state).toBe("outcome_unknown");
  });
  it.each(["host", "downstream"] as const)(
    "preserves installed browser execution parameter metadata from %s and refreshes it with the native catalog",
    (route) => {
      const timeout = {
        type: "integer",
        description: "Native execution deadline. Omitted values default to 45000 ms.",
        default: 45_000,
        minimum: 1,
        examples: [90_000],
      };
      const title = { type: "string", description: "Native user-facing execution title." };
      const native = downstreamDescriptor(
        "node_repl__js",
        "node_repl",
        "js",
        objectSchema(
          {
            code: { type: "string" },
            timeout_ms: timeout,
            title,
          },
          ["code"],
        ),
      );
      const fixture = makeSurface({
        hostTools:
          route === "host"
            ? [
                {
                  name: "node_repl__js",
                  nativeName: "node_repl/js",
                  stateEffect: "mutate",
                  modelEffect: "none",
                  tool: native.tool,
                },
              ]
            : [],
        methods: [],
        downstreamTools: route === "downstream" ? [native] : [],
      });
      const names = [
        "chrome__control_chrome",
        "browser__control_in_app_browser",
        "chrome__list_user_tabs",
      ];
      const published = codeModeBrowserNativeTools(native.tool);
      for (const name of names) {
        const schema = published.find((tool) => tool.name === name)?.inputSchema;
        expect(schema?.properties?.timeout_ms).toEqual(timeout);
        expect(schema?.properties?.title).toEqual(title);
        expect(schema?.required ?? []).not.toContain("timeout_ms");
        expect(
          flattenDynamicTools(fixture.surface.dynamicToolSpecs).get(name)?.inputSchema,
        ).toEqual(schema);
      }
      timeout.description =
        "Updated native execution deadline. Omitted values default to 60000 ms.";
      timeout.default = 60_000;
      expect(
        published.find((tool) => tool.name === names[0])?.inputSchema.properties?.timeout_ms,
      ).toMatchObject({ default: 45_000 });
      const refreshed = flattenDynamicTools(fixture.surface.dynamicToolSpecs);
      for (const name of names) {
        expect(refreshed.get(name)?.inputSchema).toMatchObject({
          properties: { timeout_ms: timeout, title },
        });
      }
    },
  );

  it("describes the selected browser binding without adapter policy prose", () => {
    const tools = codeModeBrowserNativeTools();
    for (const name of ["chrome__control_chrome", "browser__control_in_app_browser"]) {
      const code = tools.find((tool) => tool.name === name)?.inputSchema.properties?.code;
      expect(code).toMatchObject({ type: "string" });
      expect((code as { description: string }).description).toContain(
        "selected browser binding available as `browser` and the work-session-persistent `state`",
      );
      expect((code as { description: string }).description).not.toContain("authenticated");
    }
  });

  it("publishes and dispatches the first-party Computer Use host route", async () => {
    const schema = objectSchema({});
    const fixture = makeSurface({
      hostTools: [
        {
          name: COMPUTER_USE_HOST_NAME,
          nativeName: "codex.computer_use.list_apps",
          stateEffect: "read",
          modelEffect: "none",
          tool: {
            name: COMPUTER_USE_HOST_NAME,
            description: "List applications visible to Codex Computer Use.",
            inputSchema: schema,
          } as Tool,
        },
      ],
      methods: [],
    });

    expect(
      flattenDynamicTools(fixture.surface.dynamicToolSpecs).get(COMPUTER_USE_HOST_NAME),
    ).toMatchObject({
      name: COMPUTER_USE_HOST_NAME,
      inputSchema: schema,
    });
    const response = await fixture.surface.callDynamic({
      tool: COMPUTER_USE_HOST_NAME,
      arguments: {},
      callId: "computer-use-host-call",
    });
    expect(fixture.hostCall).toHaveBeenCalledWith(
      {
        tool: COMPUTER_USE_HOST_NAME,
        arguments: {},
        callId: "computer-use-host-call",
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(response.success).toBe(true);
  });

  it("publishes exact core and Responses-safe downstream names with exact schemas", () => {
    const hostSchema = objectSchema({ limit: { type: "integer" } });
    const appServerSchema = objectSchema({ threadId: { type: "string" } }, ["threadId"]);
    const downstreamSchema = objectSchema({});
    const hostTool = hostDescriptor("codex_app__list_threads", hostSchema);
    const method = methodDescriptor("codex__app_server__thread_read", appServerSchema);
    const baseDownstream = downstreamDescriptor(
      "read_file",
      "filesystem",
      "read_file",
      downstreamSchema,
    );
    const downstream: NativeToolDescriptor = {
      ...baseDownstream,
      tool: {
        ...baseDownstream.tool,
        title: "Read file",
        outputSchema: {
          type: "object",
          properties: { content: { type: "string" } },
        },
        annotations: { readOnlyHint: true, destructiveHint: false },
        execution: { taskSupport: "optional" },
        _meta: { vendor: { revision: "native-1" } },
      },
    };
    const surface = makeSurface({
      hostTools: [hostTool],
      methods: [method],
      downstreamTools: [downstream],
    }).surface;

    const tools = flattenDynamicTools(surface.dynamicToolSpecs);
    expect(tools.get("codex_app__list_threads")?.inputSchema).toEqual(hostSchema);
    expect(tools.get("codex__app_server__thread_read")?.inputSchema).toEqual(appServerSchema);
    expect(tools.get(DOWNSTREAM_CODE_MODE_NAME)?.inputSchema).toEqual(downstreamSchema);
    expect(tools.get(DOWNSTREAM_CODE_MODE_NAME)?.description).toBe("Downstream read_file");
    expect(Object.keys(tools.get(DOWNSTREAM_CODE_MODE_NAME) ?? {}).sort()).toEqual([
      "deferLoading",
      "description",
      "inputSchema",
      "name",
      "type",
    ]);

    const browserSchemas = new Map(
      codeModeBrowserNativeTools().map((tool) => [tool.name, tool.inputSchema]),
    );
    for (const name of [
      "browser__list_surfaces",
      "chrome__list_user_tabs",
      "chrome__control_chrome",
      "browser__control_in_app_browser",
    ]) {
      expect(tools.get(name)?.inputSchema).toEqual(browserSchemas.get(name));
    }

    for (const name of ["chrome__control_chrome", "browser__control_in_app_browser"]) {
      const tool = tools.get(name);
      expect(objectValue(tool?.inputSchema).required).toEqual(["operation"]);
      const codeDescription = objectValue(
        objectValue(objectValue(tool?.inputSchema).properties).code,
      ).description;
      expect(
        objectValue(objectValue(objectValue(tool?.inputSchema).properties).operation).enum,
      ).toEqual(expect.arrayContaining(["documentation", "inspect"]));
      expect(
        objectValue(objectValue(objectValue(tool?.inputSchema).properties).target_tab_id),
      ).toMatchObject({
        type: "string",
        minLength: 1,
      });
      expect(
        objectValue(objectValue(objectValue(tool?.inputSchema).properties).documentation_name)
          .description,
      ).toContain("Optional installed documentation name");
      expect(tool?.description).toContain("operation=documentation");
      expect(tool?.description).toContain("requested browser action");
      expect(tool?.description).not.toMatch(/authoriz|approv|confirm|ask again/iu);
      expect(tool?.description).not.toContain("complete persistent");
      expect(tool?.description).not.toContain("OmniCodex execution contract");
      expect(tool?.description).not.toContain("Preserve the selected Web conversation");
      expect(tool?.description).not.toContain("human-authored user message");
      expect(codeDescription).toContain(
        "selected browser binding available as `browser` and the work-session-persistent `state`",
      );
      expect(codeDescription).toContain("live API reference");
      expect(codeDescription).not.toContain("committed-turn readback");
      expect(codeDescription).not.toContain("authors and submits");
    }
    const chromeTool = tools.get("chrome__control_chrome");
    for (const name of ["chrome__control_chrome", "chrome__list_user_tabs"]) {
      expect(tools.get(name)?.inputSchema).toMatchObject({
        properties: {
          browserId: {
            type: "string",
            minLength: 1,
          },
        },
      });
      expect(tools.get(name)?.inputSchema).not.toHaveProperty(
        "required",
        expect.arrayContaining(["browserId"]),
      );
    }
    expect(tools.get("browser__control_in_app_browser")?.inputSchema).not.toHaveProperty(
      "properties.browserId",
    );
    expect(chromeTool?.description).toContain(
      "installed extension-backed signed-in Chrome profile",
    );
    expect(chromeTool?.description).toContain("requested browser action");
    const inAppBrowserTool = tools.get("browser__control_in_app_browser");
    expect(inAppBrowserTool?.description).toContain("Codex task's in-app browser");
    const nativeChromeTool = codeModeBrowserNativeTools().find(
      (tool) => tool.name === "chrome__control_chrome",
    );
    expect(objectValue(objectValue(nativeChromeTool?._meta).omnicodex)).not.toHaveProperty(
      "executionGuidance",
    );
    expect(tools.get("browser__list_surfaces")?.description).toContain(
      "extension-backed signed-in Chrome Use and the Codex in-app browser identified separately",
    );
    expect(tools.get("chrome__list_user_tabs")?.description).toContain(
      "profile-wide native tab inventory",
    );
    expect(tools.get("chrome__list_user_tabs")?.description).toContain(
      "inventory spans every Chrome window",
    );
    expect(tools.get("chrome__list_user_tabs")?.description).toContain(
      "does not prove that the group is visible in the current foreground window",
    );
    expect(tools.get("chrome__control_chrome")?.description).toContain(
      "Each work session keeps its own browser binding and tab-group ownership",
    );
    expect(tools.get("chrome__control_chrome")?.description).toContain(
      "read the requested content using native DOM or accessibility state",
    );
    expect(tools.has("mcp__node_repl__js")).toBe(false);
    expect(tools.has("functions__exec")).toBe(false);
    expect([...tools.keys()].every((name) => /^[a-zA-Z0-9_-]+$/u.test(name))).toBe(true);
    expect([...tools.keys()]).toHaveLength(7);
  });

  it("removes tool-use workflow gates from code-mode input descriptions", () => {
    const workflowGate =
      "Only specify this when the user explicitly asks to start from a particular git state.";
    const schema = objectSchema({
      target: {
        type: "string",
        description: workflowGate,
      },
    });
    const surface = makeSurface({
      hostTools: [hostDescriptor("codex_app__create_thread", schema)],
      methods: [],
    }).surface;

    const tools = flattenDynamicTools(surface.dynamicToolSpecs);
    expect(tools.get("codex_app__create_thread")?.inputSchema).toMatchObject({
      properties: { target: { description: "" } },
    });
    expect(workflowGate).toContain("explicitly asks");
  });

  it("preserves the exact Node REPL description without adapter policy prose", () => {
    const schema = objectSchema({ code: { type: "string" } }, ["code"]);
    const surface = makeSurface({
      hostTools: [
        {
          name: "node_repl__js",
          nativeName: "node_repl/js",
          stateEffect: "read",
          modelEffect: "none",
          tool: {
            name: "js",
            description: "Execute JavaScript in a persistent node_repl.",
            inputSchema: schema,
          } as Tool,
        },
      ],
      methods: [],
    }).surface;

    const tool = flattenDynamicTools(surface.dynamicToolSpecs).get("node_repl__js");
    expect(tool?.inputSchema).toBe(schema);
    expect(tool?.description).toBe("Execute JavaScript in a persistent node_repl.");
  });

  it("projects MCP extension fields into one canonical App Server dynamic-tool format", () => {
    const schema = objectSchema({ path: { type: "string" } }, ["path"]);
    const base = downstreamDescriptor("read_file", "filesystem", "read_file", schema);
    const toolWithExtensions = {
      ...base.tool,
      namespace: "legacy_filesystem",
      exposeToContext: true,
      tools: [{ name: "legacy_nested_without_type" }],
      title: "Read file",
      outputSchema: { type: "object", properties: { content: { type: "string" } } },
      annotations: { readOnlyHint: true },
      _meta: { vendor: { revision: "preserved-in-native-catalog" } },
    } as Tool;
    const surface = makeSurface({
      hostTools: [],
      methods: [],
      downstreamTools: [
        {
          ...base,
          tool: toolWithExtensions,
        },
      ],
    }).surface;

    const dynamicTool = flattenDynamicTools(surface.dynamicToolSpecs).get(
      DOWNSTREAM_CODE_MODE_NAME,
    );
    expect(dynamicTool).toEqual({
      type: "function",
      name: DOWNSTREAM_CODE_MODE_NAME,
      description: "Downstream read_file",
      inputSchema: schema,
      deferLoading: false,
    });
    expect(toolWithExtensions).toMatchObject({
      namespace: "legacy_filesystem",
      exposeToContext: true,
      tools: [{ name: "legacy_nested_without_type" }],
      _meta: { vendor: { revision: "preserved-in-native-catalog" } },
    });
  });

  it("dispatches a mapped downstream tool by its exact native identity", async () => {
    const schema = objectSchema({});
    const descriptor = downstreamDescriptor("read_file", "filesystem", "read_file", schema);
    const fixture = makeSurface({
      hostTools: [],
      methods: [],
      downstreamTools: [descriptor],
    });
    fixture.downstreamCall.mockResolvedValueOnce([{ id: "app-1" }]);

    const response = await fixture.surface.callDynamic({
      tool: DOWNSTREAM_CODE_MODE_NAME,
      arguments: {},
      callId: "computer-use-call",
      threadId: "desktop-context-thread",
    });

    expect(
      flattenDynamicTools(fixture.surface.dynamicToolSpecs).get(DOWNSTREAM_CODE_MODE_NAME)
        ?.inputSchema,
    ).toEqual(schema);
    expect(fixture.downstreamCall).toHaveBeenCalledTimes(1);
    expect(fixture.downstreamCall).toHaveBeenCalledWith(
      "filesystem",
      "read_file",
      {},
      "desktop-context-thread",
      undefined,
      undefined,
      expect.any(AbortSignal),
      undefined,
    );
    expect(response).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: '[{"id":"app-1"}]' }],
    });
    expect(fixture.observe.mock.calls.map(([value]) => value)).toEqual([
      {
        name: DOWNSTREAM_CODE_MODE_NAME,
        callId: "computer-use-call",
        threadId: "desktop-context-thread",
        phase: "started",
      },
      {
        name: DOWNSTREAM_CODE_MODE_NAME,
        callId: "computer-use-call",
        threadId: "desktop-context-thread",
        phase: "succeeded",
      },
    ]);
  });

  it("preserves downstream CUA work-session isolation and caller turn metadata", async () => {
    const requests: Record<string, unknown>[] = [];
    const executor = new NativeToolExecutor(
      {
        request: async <T>(_method: string, params: unknown): Promise<T> => {
          requests.push(objectValue(params));
          return { content: [] } as T;
        },
      },
      { ensureThread: async () => "owned-native-thread" },
    );
    let context: { workSessionBinding?: string; callerSessionId?: string } = {};
    const fixture = makeSurface({
      hostTools: [],
      methods: [],
      downstreamTools: [
        downstreamDescriptor("codex__cua_repl__js", "cua_repl", "js", objectSchema({})),
      ],
      downstreamToolExecutor: executor,
      browserCallContext: () => context,
    });
    const code = 'const tab = await cua.getTab("known-tab", { browser: "1" });';
    const cases = [
      {
        context: { workSessionBinding: "work-a", callerSessionId: "transport-a" },
        session: "work-a",
      },
      {
        context: { workSessionBinding: "work-a", callerSessionId: "transport-reconnected" },
        session: "work-a",
      },
      {
        context: { workSessionBinding: "work-b", callerSessionId: "transport-a" },
        session: "work-b",
      },
      { context: { callerSessionId: "transport-b" }, session: "transport-b" },
      { context: {}, session: "runtime-thread-4" },
    ];
    for (const [index, current] of cases.entries()) {
      context = current.context;
      const response = await fixture.surface.callDynamic({
        tool: "codex__cua_repl__js",
        arguments: { code },
        threadId: `runtime-thread-${index}`,
        turnId: `runtime-turn-${index}`,
      });
      expect(response.success).toBe(true);
      expect(requests[index]).toMatchObject({
        server: "cua_repl",
        tool: "js",
        arguments: { code },
        threadId: "owned-native-thread",
        _meta: {
          "x-codex-turn-metadata": {
            session_id: current.session,
            thread_id: `runtime-thread-${index}`,
            turn_id: `runtime-turn-${index}`,
          },
        },
      });
    }
    expect(fixture.browserCall).not.toHaveBeenCalled();
  });

  it("maps dotted names deterministically and resolves sanitized-name collisions", async () => {
    const dottedSchema = objectSchema({ dot: { type: "boolean" } });
    const dashedSchema = objectSchema({ dash: { type: "integer" } });
    const dotted = downstreamDescriptor("tool.name", "server.name", "tool.name", dottedSchema);
    const dashed = downstreamDescriptor("tool-name", "server-name", "tool-name", dashedSchema);
    const fixture = makeSurface({
      hostTools: [],
      methods: [],
      downstreamTools: [dashed, dotted],
    });

    const tools = flattenDynamicTools(fixture.surface.dynamicToolSpecs);
    const dottedName = dynamicNameForSchema(tools, dottedSchema);
    const dashedName = dynamicNameForSchema(tools, dashedSchema);
    expect(dottedName).toMatch(/^[a-zA-Z0-9_-]+$/u);
    expect(dashedName).toMatch(/^[a-zA-Z0-9_-]+$/u);
    expect(new Set([dottedName, dashedName])).toHaveLength(2);
    expect(dottedName).toBe("codex__server_name__tool_name");
    expect(dashedName).toBe("tool-name");
    expect(tools.get(dottedName)?.inputSchema).toBe(dottedSchema);
    expect(tools.get(dashedName)?.inputSchema).toBe(dashedSchema);
    expect(tools.get(dottedName)?.description).toBe("Downstream tool.name");
    expect(tools.get(dashedName)?.description).toBe("Downstream tool-name");

    const reversedTools = flattenDynamicTools(
      makeSurface({
        hostTools: [],
        methods: [],
        downstreamTools: [dotted, dashed],
      }).surface.dynamicToolSpecs,
    );
    expect(dynamicNameForSchema(reversedTools, dottedSchema)).toBe(dottedName);
    expect(dynamicNameForSchema(reversedTools, dashedSchema)).toBe(dashedName);

    await fixture.surface.callDynamic({
      tool: dottedName,
      arguments: { dot: true },
      threadId: "dotted-context",
    });
    await fixture.surface.callDynamic({
      tool: dashedName,
      arguments: { dash: 7 },
      threadId: "dashed-context",
    });
    expect(fixture.downstreamCall).toHaveBeenNthCalledWith(
      1,
      "server.name",
      "tool.name",
      { dot: true },
      "dotted-context",
      undefined,
      undefined,
      expect.any(AbortSignal),
      undefined,
    );
    expect(fixture.downstreamCall).toHaveBeenNthCalledWith(
      2,
      "server-name",
      "tool-name",
      { dash: 7 },
      "dashed-context",
      undefined,
      undefined,
      expect.any(AbortSignal),
      undefined,
    );
  });

  it("preserves valid downstream exposed names without synthetic namespaces", () => {
    const exposedTargetSchema = objectSchema({ exposedTarget: { type: "boolean" } });
    const originalTargetSchema = objectSchema({ originalTarget: { type: "boolean" } });
    const exposedReservedAlias = "omnicodex_native__alpha__tool";
    const originalReservedAlias = "omnicodex_native__beta__tool";
    const surface = makeSurface({
      hostTools: [],
      methods: [],
      downstreamTools: [
        downstreamDescriptor("target-a", "alpha", "tool", exposedTargetSchema),
        downstreamDescriptor(exposedReservedAlias, "reservation-a", "noop-a", objectSchema({})),
        downstreamDescriptor("target-b", "beta", "tool", originalTargetSchema),
        downstreamDescriptor(
          "reservation-b",
          "reservation-b",
          originalReservedAlias,
          objectSchema({}),
        ),
      ],
    }).surface;

    const tools = flattenDynamicTools(surface.dynamicToolSpecs);
    expect(dynamicNameForSchema(tools, exposedTargetSchema)).toBe("target-a");
    expect(dynamicNameForSchema(tools, originalTargetSchema)).toBe("target-b");
    expect(tools.has(exposedReservedAlias)).toBe(true);
    expect(tools.has(originalReservedAlias)).toBe(false);
  });

  it("dispatches each exact route once to its existing native executor", async () => {
    const hostTool = hostDescriptor("codex_app__list_threads", objectSchema({}));
    const method = methodDescriptor(
      "codex__app_server__thread_read",
      objectSchema({ threadId: { type: "string" } }, ["threadId"]),
    );
    const fixture = makeSurface({
      hostTools: [hostTool],
      methods: [method],
      browserCallContext: () => ({
        ownerBinding: "owner-a",
        workSessionBinding: "work-session-a",
        callerSessionId: "transport-a",
      }),
    });

    await expect(
      fixture.surface.callDynamic({
        tool: "codex_app__list_threads",
        arguments: { limit: 1, timeoutMs: 1 },
        callId: "host-call",
      }),
    ).resolves.toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "host-result" }],
    });
    expect(fixture.hostCall).toHaveBeenCalledTimes(1);
    expect(fixture.hostCall).toHaveBeenCalledWith(
      {
        tool: "codex_app__list_threads",
        arguments: { limit: 1, timeoutMs: 1 },
        callId: "host-call",
      },
      { signal: expect.any(AbortSignal) },
    );

    const appServerResponse = await fixture.surface.callDynamic({
      tool: "codex__app_server__thread_read",
      arguments: { threadId: "thread-1", timeoutMs: 1 },
    });
    expect(appServerResponse).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: '{"threadId":"thread-1","timeoutMs":1}' }],
    });
    expect(JSON.parse(appServerResponse.contentItems[0]?.text ?? "null")).toEqual({
      threadId: "thread-1",
      timeoutMs: 1,
    });
    expect(fixture.methodCall).toHaveBeenCalledTimes(1);
    expect(fixture.methodCall).toHaveBeenCalledWith(
      method,
      { threadId: "thread-1", timeoutMs: 1 },
      {
        signal: expect.any(AbortSignal),
      },
    );

    await fixture.surface.callDynamic({ tool: "browser__list_surfaces" });
    await fixture.surface.callDynamic({
      tool: "chrome__list_user_tabs",
      arguments: { timeout_ms: 10_000, title: "visible tabs", browserId: "2" },
    });
    await fixture.surface.callDynamic({
      tool: "chrome__control_chrome",
      arguments: { operation: "list_user_tabs", title: "tabs", browserId: "1" },
      turnId: "web-turn-a",
    });
    await fixture.surface.callDynamic({
      tool: "browser__control_in_app_browser",
      arguments: { operation: "exec", code: "return browser.url();" },
      threadId: "iab-context-thread",
    });
    await fixture.surface.callDynamic({
      tool: "chrome__control_chrome",
      arguments: {
        operation: "inspect",
        target_tab_id: "tab-42",
        code: "caller code is ignored by the fixed inspection",
        surface: "iab",
      },
    });
    expect(fixture.browserCall).toHaveBeenCalledTimes(5);
    expect(fixture.browserCall).toHaveBeenNthCalledWith(
      1,
      { operation: "list_surfaces" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fixture.browserCall).toHaveBeenNthCalledWith(
      2,
      {
        operation: "list_user_tabs",
        surface: "chrome",
        timeout_ms: 10_000,
        title: "visible tabs",
        browserId: "2",
      },
      expect.objectContaining({
        ownerBinding: "owner-a",
        workSessionBinding: "work-session-a",
        callerSessionId: "transport-a",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fixture.browserCall).toHaveBeenNthCalledWith(
      3,
      {
        operation: "list_user_tabs",
        surface: "chrome",
        title: "tabs",
        browserId: "1",
      },
      expect.objectContaining({
        ownerBinding: "owner-a",
        workSessionBinding: "work-session-a",
        callerSessionId: "transport-a",
        activityBinding: "turn:web-turn-a",
        contextTurnId: "web-turn-a",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fixture.browserCall).toHaveBeenNthCalledWith(
      4,
      {
        operation: "exec",
        surface: "iab",
        code: "return browser.url();",
      },
      expect.objectContaining({
        contextThreadId: "iab-context-thread",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fixture.browserCall).toHaveBeenNthCalledWith(
      5,
      {
        operation: "inspect",
        surface: "chrome",
        target_tab_id: "tab-42",
        code: "caller code is ignored by the fixed inspection",
      },
      expect.objectContaining({
        ownerBinding: "owner-a",
        workSessionBinding: "work-session-a",
        callerSessionId: "transport-a",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("observes every nested route and unwraps the native browser text envelope", async () => {
    const hostTool = hostDescriptor("codex_app__list_threads", objectSchema({}));
    const method = methodDescriptor("codex__app_server__thread_read", objectSchema({}));
    const observe = vi.fn();
    const fixture = makeSurface({ hostTools: [hostTool], methods: [method], observe });
    let browserEnvelope: unknown = {
      isError: false,
      content: [{ type: "text", text: '[{"id":"chrome-tab-1"}]' }],
    };
    for (let depth = 0; depth < 12; depth += 1) {
      browserEnvelope = { structuredContent: browserEnvelope };
    }
    fixture.browserCall.mockResolvedValueOnce(browserEnvelope);

    await fixture.surface.callDynamic({
      tool: "codex_app__list_threads",
      callId: "host-call",
      threadId: "context-thread",
    });
    await fixture.surface.callDynamic({
      tool: "codex__app_server__thread_read",
      callId: "app-server-call",
    });
    const browser = await fixture.surface.callDynamic({
      tool: "chrome__control_chrome",
      arguments: { code: "return await browser.tabs.list();" },
      callId: "browser-call",
    });

    expect(JSON.parse(browser.contentItems[0]?.text ?? "null")).toEqual([{ id: "chrome-tab-1" }]);
    expect(observe.mock.calls.map(([value]) => value)).toEqual([
      {
        name: "codex_app__list_threads",
        callId: "host-call",
        threadId: "context-thread",
        phase: "started",
      },
      {
        name: "codex_app__list_threads",
        callId: "host-call",
        threadId: "context-thread",
        phase: "succeeded",
      },
      {
        name: "codex__app_server__thread_read",
        callId: "app-server-call",
        phase: "started",
      },
      {
        name: "codex__app_server__thread_read",
        callId: "app-server-call",
        phase: "succeeded",
      },
      {
        name: "chrome__control_chrome",
        callId: "browser-call",
        phase: "started",
      },
      {
        name: "chrome__control_chrome",
        callId: "browser-call",
        phase: "succeeded",
      },
    ]);
  });

  it("reads live host, App Server, and downstream descriptors for hot catalog convergence", () => {
    const hostTools: CodexAppHostToolDescriptor[] = [
      hostDescriptor("codex_app__list_threads", objectSchema({})),
    ];
    let methods: AppServerMethodDescriptor[] = [];
    let downstreamTools: NativeToolDescriptor[] = [];
    const fixture = makeSurface({
      get hostTools() {
        return hostTools;
      },
      get methods() {
        return methods;
      },
      get downstreamTools() {
        return downstreamTools;
      },
    });
    expect(
      flattenDynamicTools(fixture.surface.dynamicToolSpecs).has("codex__app_server__thread_read"),
    ).toBe(false);

    hostTools.push(hostDescriptor("codex_app__read_thread", objectSchema({})));
    methods = [
      methodDescriptor(
        "codex__app_server__thread_read",
        objectSchema({ threadId: { type: "string" } }, ["threadId"]),
      ),
    ];
    downstreamTools = [
      downstreamDescriptor("read_file", "filesystem", "read_file", objectSchema({})),
    ];
    const refreshed = flattenDynamicTools(fixture.surface.dynamicToolSpecs);
    expect(refreshed.has("codex_app__read_thread")).toBe(true);
    expect(refreshed.has("codex__app_server__thread_read")).toBe(true);
    expect(refreshed.has(DOWNSTREAM_CODE_MODE_NAME)).toBe(true);
  });

  it("dispatches every sanitization-colliding App Server name to its original method", async () => {
    const methods = parseAppServerMethodCatalog({
      oneOf: [
        {
          properties: {
            method: { const: "foo/bar" },
            params: { type: "object", additionalProperties: true },
          },
        },
        {
          properties: {
            method: { const: "foo_bar" },
            params: { type: "object", additionalProperties: true },
          },
        },
      ],
    }).methods;
    const fixture = makeSurface({ hostTools: [], methods });

    for (const descriptor of methods) {
      await expect(
        fixture.surface.callDynamic({
          tool: descriptor.exposedName,
          arguments: { marker: descriptor.method },
        }),
      ).resolves.toMatchObject({ success: true });
    }

    const calledMethods = fixture.methodCall.mock.calls.map(([descriptor, args]) => ({
      method: descriptor.method,
      marker: (args as { marker?: unknown }).marker,
    }));
    expect(calledMethods).toEqual(methods.map(({ method }) => ({ method, marker: method })));
    expect(new Set(calledMethods.map(({ method }) => method))).toEqual(
      new Set(["foo/bar", "foo_bar"]),
    );
  });

  it("forwards timeoutMs only as an exact native argument and keeps the scheduler signal", async () => {
    const method = methodDescriptor(
      "codex__app_server__command_exec",
      objectSchema({ command: { type: "array" }, timeoutMs: { type: "integer" } }, ["command"]),
    );
    const fixture = makeSurface({ hostTools: [], methods: [method] });

    await expect(
      fixture.surface.callDynamic({
        tool: method.exposedName,
        arguments: { command: ["long-task"], timeoutMs: 3_000_000_000 },
      }),
    ).resolves.toMatchObject({ success: true });

    expect(fixture.methodCall).toHaveBeenCalledWith(
      method,
      { command: ["long-task"], timeoutMs: 3_000_000_000 },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("propagates the parent execution cancellation boundary into the native scheduler", async () => {
    const fixture = makeSurface({
      hostTools: [hostDescriptor("codex_app__list_threads", objectSchema({}))],
      methods: [],
    });
    let observedSignal: AbortSignal | undefined;
    fixture.hostCall.mockImplementationOnce(async (_params, context) => {
      observedSignal = context?.signal;
      await new Promise<void>((resolve) => {
        if (context?.signal?.aborted) resolve();
        else context?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        success: true,
        contentItems: [{ type: "inputText" as const, text: "host-result" }],
      };
    });
    const controller = new AbortController();

    const pending = fixture.surface.callDynamic(
      { tool: "codex_app__list_threads", arguments: {} },
      { signal: controller.signal },
    );

    await vi.waitFor(() => expect(observedSignal).toBeInstanceOf(AbortSignal));
    expect(observedSignal?.aborted).toBe(false);
    controller.abort(new Error("cancel parent native execution"));
    expect(observedSignal?.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ success: false });
  });

  it("does not validate or consume a native timeoutMs field at the adapter boundary", async () => {
    const method = methodDescriptor(
      "codex__app_server__command_exec",
      objectSchema({ timeoutMs: { type: "number" } }),
    );
    const fixture = makeSurface({ hostTools: [], methods: [method] });

    await expect(
      fixture.surface.callDynamic({
        tool: method.exposedName,
        arguments: { timeoutMs: 1.5 },
      }),
    ).resolves.toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: '{"timeoutMs":1.5}' }],
    });
    expect(fixture.methodCall).toHaveBeenCalledWith(
      method,
      { timeoutMs: 1.5 },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("omits only the exact deployment marker and not the OmniCodex display name", () => {
    const surface = makeSurface({
      hostTools: [],
      methods: [],
      downstreamTools: [
        {
          ...downstreamDescriptor("nested", "renamed-self", "native.read", objectSchema({})),
          selfReferential: true,
        },
        downstreamDescriptor(
          "same-display-name",
          "OmniCodex",
          "other.native.read",
          objectSchema({}),
        ),
        downstreamDescriptor(
          "nested-alias",
          "other-server",
          "omnicodex_workspace.native.read",
          objectSchema({}),
        ),
        downstreamDescriptor("read_file", "filesystem", "read_file", objectSchema({})),
      ],
    }).surface;

    const tools = flattenDynamicTools(surface.dynamicToolSpecs);
    expect(tools.has("nested")).toBe(false);
    expect(tools.has("same-display-name")).toBe(true);
    expect(tools.has("nested-alias")).toBe(true);
    expect(tools.has(DOWNSTREAM_CODE_MODE_NAME)).toBe(true);
  });

  it("keeps historical and similarly named non-self tools", () => {
    const surface = makeSurface({
      hostTools: [],
      methods: [],
      downstreamTools: [
        downstreamDescriptor(
          "historic-server",
          "OmniCodex-historical-name",
          "native.read",
          objectSchema({}),
        ),
        downstreamDescriptor(
          "historic-native-name",
          "other-server",
          "OmniCodex-historical-name.native.read",
          objectSchema({}),
        ),
        downstreamDescriptor(
          "unrelated",
          "NotOmniCodex-historical-name",
          "native.read",
          objectSchema({}),
        ),
      ],
    }).surface;

    const names = [...flattenDynamicTools(surface.dynamicToolSpecs).keys()];
    expect(names).toEqual(
      expect.arrayContaining(["historic-server", "historic-native-name", "unrelated"]),
    );
  });

  it("fails closed on conflicting exact names and unknown calls without dispatch", async () => {
    const conflictingName = "browser__list_surfaces";
    const fixture = makeSurface({
      hostTools: [hostDescriptor(conflictingName, objectSchema({}))],
      methods: [],
    });
    expect(() => fixture.surface.dynamicToolSpecs).toThrow(
      `Conflicting code-mode native tool descriptors for ${conflictingName}`,
    );

    const clean = makeSurface({ hostTools: [], methods: [] });
    await expect(
      clean.surface.callDynamic({ namespace: "unknown", tool: "missing", arguments: {} }),
    ).resolves.toEqual({
      success: false,
      contentItems: [
        { type: "inputText", text: '{"error":"Unknown OmniCodex native tool: unknown__missing"}' },
      ],
    });
    expect(clean.hostCall).not.toHaveBeenCalled();
    expect(clean.methodCall).not.toHaveBeenCalled();
    expect(clean.browserCall).not.toHaveBeenCalled();
  });

  it("uses the complete SHA-256 identity suffix for a reserved downstream name", () => {
    const schema = objectSchema({});
    const surface = makeSurface({
      hostTools: [],
      methods: [],
      downstreamTools: [
        downstreamDescriptor(
          "browser__list_surfaces",
          "downstream-with-reserved-name",
          "list_surfaces",
          schema,
        ),
      ],
    }).surface;

    const mappedName = dynamicNameForSchema(flattenDynamicTools(surface.dynamicToolSpecs), schema);
    expect(mappedName).toMatch(/^browser__list_surfaces__h_[a-f0-9]{64}$/u);
    expect(mappedName.length).toBeLessThanOrEqual(128);
  });

  it("preserves native browser error status instead of reporting a false success", async () => {
    const fixture = makeSurface({ hostTools: [], methods: [] });
    fixture.browserCall.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "browser unavailable" }],
    });

    await expect(
      fixture.surface.callDynamic({
        tool: "chrome__control_chrome",
        arguments: {
          code: "return await browser.tabs.list();",
        },
      }),
    ).resolves.toMatchObject({ success: false });
    expect(fixture.browserCall).toHaveBeenCalledTimes(1);
  });

  it("shares the injected UI lane with first-class native calls", async () => {
    const scheduler = new NativeExecutionScheduler();
    const fixture = makeSurface({ hostTools: [], methods: [], scheduler });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstClass = scheduler.run(
      {
        entry: {
          nativeNamespace: "chrome",
          originalName: "chrome__control_chrome",
          source: "codex_browser_client",
        },
      },
      () => gate,
    );
    const codeMode = fixture.surface.callDynamic({
      tool: "browser__control_in_app_browser",
      arguments: { code: "return await browser.tabs.list();" },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.browserCall).not.toHaveBeenCalled();
    release();
    await firstClass;
    await expect(codeMode).resolves.toMatchObject({ success: true });
    expect(fixture.browserCall).toHaveBeenCalledTimes(1);
  });

  it("preserves a downstream native failure and observes it as failed", async () => {
    const fixture = makeSurface({
      hostTools: [],
      methods: [],
      downstreamTools: [
        downstreamDescriptor("read_file", "filesystem", "read_file", objectSchema({})),
      ],
    });
    const nativeFailure = {
      isError: true,
      content: [{ type: "text", text: "downstream tool unavailable" }],
    };
    fixture.downstreamCall.mockResolvedValueOnce(nativeFailure);

    await expect(
      fixture.surface.callDynamic({
        tool: DOWNSTREAM_CODE_MODE_NAME,
        arguments: {},
        callId: "failed-computer-use-call",
      }),
    ).resolves.toEqual({
      success: false,
      contentItems: [
        { type: "inputText", text: "downstream tool unavailable" },
        {
          type: "inputText",
          text: `OMNICODEX_CALL_TOOL_RESULT_V1:${JSON.stringify(nativeFailure)}`,
        },
      ],
    });
    expect(fixture.observe.mock.calls.map(([value]) => value)).toEqual([
      {
        name: DOWNSTREAM_CODE_MODE_NAME,
        callId: "failed-computer-use-call",
        phase: "started",
      },
      {
        name: DOWNSTREAM_CODE_MODE_NAME,
        callId: "failed-computer-use-call",
        phase: "failed",
      },
    ]);
  });

  it("preserves ordered native media and an exact reconstructable result envelope", async () => {
    const fixture = makeSurface({
      hostTools: [],
      methods: [],
      downstreamTools: [downstreamDescriptor("media", "media-server", "media", objectSchema({}))],
    });
    const nativeResult = {
      content: [
        { type: "text", text: "first", annotations: { audience: ["assistant"] } },
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        {
          type: "resource_link",
          name: "complete artifact",
          uri: "https://owner.example/resources/1",
          _meta: { ordinal: 3 },
        },
        { type: "audio", mimeType: "audio/wav", data: "YXVkaW8=" },
      ],
      structuredContent: { ordered: [1, 2, 3, 4] },
      isError: false,
      _meta: { nativeReceipt: "complete" },
      futureField: { preserved: true },
    };
    fixture.downstreamCall.mockResolvedValueOnce(nativeResult);

    const response = await fixture.surface.callDynamic({ tool: "media", arguments: {} });

    expect(response).toEqual({
      success: true,
      contentItems: [
        { type: "inputText", text: "first" },
        { type: "inputImage", imageUrl: "data:image/png;base64,aW1hZ2U=" },
        {
          type: "inputText",
          text: `OMNICODEX_MCP_CONTENT_BLOCK_V1:${JSON.stringify(nativeResult.content[2])}`,
        },
        { type: "inputAudio", audioUrl: "data:audio/wav;base64,YXVkaW8=" },
        {
          type: "inputText",
          text: `OMNICODEX_CALL_TOOL_RESULT_V1:${JSON.stringify(nativeResult)}`,
        },
      ],
    });
    const completeEnvelope = response.contentItems.at(-1)?.text;
    expect(
      JSON.parse(completeEnvelope?.replace("OMNICODEX_CALL_TOOL_RESULT_V1:", "") ?? "null"),
    ).toEqual(nativeResult);
  });

  it("preserves structured exception code, data, rpc error, cause, and retry details", async () => {
    const fixture = makeSurface({
      hostTools: [],
      methods: [methodDescriptor("codex__app_server__thread_read", objectSchema({}))],
    });
    const cause = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    const failure = Object.assign(new Error("App Server request failed"), {
      code: -32_001,
      data: { threadId: "thread-1", retryable: true },
      rpcError: { code: -32_001, message: "upstream unavailable" },
      retryAfterMs: 750,
      cause,
    });
    fixture.methodCall.mockRejectedValueOnce(failure);

    const response = await fixture.surface.callDynamic({
      tool: "codex__app_server__thread_read",
      arguments: {},
    });

    expect(response.success).toBe(false);
    const payload = JSON.parse(response.contentItems[0]?.text ?? "null") as Record<string, unknown>;
    expect(payload).toMatchObject({
      error: "App Server request failed",
      errorDetails: {
        name: "Error",
        message: "App Server request failed",
        code: -32_001,
        data: { threadId: "thread-1", retryable: true },
        rpcError: { code: -32_001, message: "upstream unavailable" },
        retryAfterMs: 750,
        cause: { name: "Error", message: "socket reset", code: "ECONNRESET" },
      },
    });
  });
});

function makeSurface(input: {
  readonly directGoalStore?: DirectGoalStore;
  readonly mutationReplayStore?: MutationReplayStore;
  readonly hostTools: readonly CodexAppHostToolDescriptor[];
  readonly methods: readonly AppServerMethodDescriptor[];
  readonly downstreamTools?: readonly NativeToolDescriptor[];
  readonly downstreamToolExecutor?: Pick<NativeToolExecutor, "callInContext">;
  readonly observe?: (value: unknown) => void;
  readonly scheduler?: NativeExecutionScheduler;
  readonly browserCallContext?: () => {
    readonly ownerBinding?: string;
    readonly workSessionBinding?: string;
    readonly callerSessionId?: string;
  };
}) {
  const hostCall = vi.fn(
    async (
      _params: CodexDynamicToolCallParams,
      _context?: CodexAppHostToolCallContext,
    ): Promise<CodexDynamicToolCallResponse> => ({
      success: true,
      contentItems: [{ type: "inputText" as const, text: "host-result" }],
    }),
  );
  const methodCall = vi.fn(async (_descriptor: AppServerMethodDescriptor, args: unknown) => args);
  const browserCall = vi.fn(async (args: unknown) => args);
  const downstreamCall = vi.fn(async (_server: string, _tool: string, args: unknown) => args);
  const observe = vi.fn(input.observe);
  const hostTools = {
    get tools() {
      return input.hostTools;
    },
    callDynamic: hostCall,
  };
  const appServerMethodCatalog = {
    get snapshot() {
      return {
        refreshedAtUnixMs: 1,
        schemaDigest: "schema",
        methods: input.methods,
      };
    },
  };
  const downstreamToolCatalog = {
    get snapshot() {
      return {
        refreshedAtUnixMs: 1,
        servers: [...new Set((input.downstreamTools ?? []).map(({ server }) => server))],
        tools: input.downstreamTools ?? [],
      };
    },
  };
  const surface = new CodeModeNativeToolSurface({
    ...(input.directGoalStore === undefined ? {} : { directGoalStore: input.directGoalStore }),
    ...(input.mutationReplayStore === undefined
      ? {}
      : { mutationReplayStore: input.mutationReplayStore }),
    hostTools,
    appServerMethodCatalog,
    appServerMethodExecutor: { call: methodCall },
    browserNativeExecutor: { call: browserCall },
    ...(input.browserCallContext === undefined
      ? {}
      : { browserCallContext: input.browserCallContext }),
    downstreamToolCatalog,
    downstreamToolExecutor: input.downstreamToolExecutor ?? { callInContext: downstreamCall },
    ...(input.scheduler === undefined ? {} : { scheduler: input.scheduler }),
    observeDynamicToolCall: observe,
  });
  return { surface, hostCall, methodCall, browserCall, downstreamCall, observe };
}

function hostDescriptor(
  name: string,
  inputSchema: Tool["inputSchema"],
): CodexAppHostToolDescriptor {
  return {
    name,
    nativeName: name,
    stateEffect: "read",
    modelEffect: "none",
    tool: { name, description: `Host ${name}`, inputSchema } as Tool,
  };
}

function methodDescriptor(
  exposedName: string,
  inputSchema: Tool["inputSchema"],
): AppServerMethodDescriptor {
  return {
    exposedName,
    method: exposedName.replace(/^codex__app_server__/, "").replaceAll("_", "/"),
    invokesModel: false,
    stateEffect: "read",
    requestTitle: undefined,
    tool: { name: exposedName, description: `App Server ${exposedName}`, inputSchema } as Tool,
  };
}

function downstreamDescriptor(
  exposedName: string,
  server: string,
  originalName: string,
  inputSchema: Tool["inputSchema"],
): NativeToolDescriptor {
  return {
    exposedName,
    server,
    originalName,
    tool: {
      name: originalName,
      description: `Downstream ${originalName}`,
      inputSchema,
    } as Tool,
  };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Tool["inputSchema"] {
  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required: [...required] }),
    additionalProperties: false,
  } as Tool["inputSchema"];
}

function flattenDynamicTools(
  specs: readonly Record<string, unknown>[],
): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const spec of specs) {
    if (spec.type === "function" && typeof spec.name === "string") {
      result.set(spec.name, spec);
      continue;
    }
    if (typeof spec.name !== "string" || !Array.isArray(spec.tools)) continue;
    for (const value of spec.tools) {
      if (!isObject(value) || typeof value.name !== "string") continue;
      result.set(`${spec.name}__${value.name}`, value);
    }
  }
  return result;
}

function dynamicNameForSchema(
  tools: ReadonlyMap<string, Record<string, unknown>>,
  schema: Tool["inputSchema"],
): string {
  const match = [...tools.entries()].find(([, spec]) => spec.inputSchema === schema);
  if (match === undefined) throw new Error("Dynamic tool schema was not published");
  return match[0];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectValue(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}
