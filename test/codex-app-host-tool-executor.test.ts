import { Ajv } from "ajv";
import { describe, expect, it, vi } from "vitest";
import { CodexAppHostToolExecutor } from "../src/application/codex-app-host-tool-executor.js";
import type { AppServerRpcClient } from "../src/application/native-tool-catalog.js";
import { JsonlRpcError } from "../src/infrastructure/runtime/jsonl-rpc-client.js";
import type {
  CodexAppNativeToolCallParams,
  CodexAppNativeToolCallResponse,
  CodexAppToolsRequestOptions,
} from "../src/infrastructure/windows/codex-app-tools-pipe-client.js";
import { CodexAppToolsSharedReadinessError } from "../src/infrastructure/windows/codex-app-tools-pipe-client.js";

const ALL_FALSE_CATALOG_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

describe("CodexAppHostToolExecutor", () => {
  it("cancels catalog discovery through the existing app-tools request boundary", async () => {
    const cancellation = new AbortController();
    const reason = new Error("catalog convergence stopped");
    const listTools = vi.fn(
      (options?: CodexAppToolsRequestOptions) =>
        new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    const executor = new CodexAppHostToolExecutor(
      { request: async <T>(): Promise<T> => null as T },
      {
        appTools: {
          close: () => undefined,
          listTools,
          callTool: async () => ({ success: true, contentItems: [] }),
        },
      },
    );
    const before = executor.tools;
    const refresh = executor.prepareToolsRefresh(cancellation.signal);
    const rejected = expect(refresh).rejects.toBe(reason);
    expect(listTools).toHaveBeenCalledWith({ timeoutMs: 2_000, signal: cancellation.signal });

    cancellation.abort(reason);
    await rejected;
    expect(executor.tools).toBe(before);
    await expect(executor.prepareToolsRefresh(cancellation.signal)).rejects.toBe(reason);
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it("cancels a catalog refresh waiter without cancelling the shared discovery", async () => {
    const discovery = deferred<never[]>();
    const listTools = vi.fn(() => discovery.promise);
    const executor = new CodexAppHostToolExecutor(
      { request: async <T>(): Promise<T> => null as T },
      {
        appTools: {
          close: () => undefined,
          listTools,
          callTool: async () => ({ success: true, contentItems: [] }),
        },
      },
    );
    const shared = executor.prepareToolsRefresh();
    const cancellation = new AbortController();
    const cancelled = executor.prepareToolsRefresh(cancellation.signal);
    const reason = new Error("catalog refresh waiter stopped");
    const rejected = expect(cancelled).rejects.toBe(reason);
    cancellation.abort(reason);
    await rejected;

    expect(executor.prepareToolsRefresh()).toBe(shared);
    expect(listTools).toHaveBeenCalledTimes(1);
    discovery.resolve([]);
    await expect(shared).resolves.toHaveProperty("tools");
    await executor.prepareToolsRefresh();
    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it("keeps the built-in host catalog available while the app-global pipe rotates", async () => {
    const listTools = vi.fn(async () => {
      throw new CodexAppToolsSharedReadinessError("renderer pipe is rotating");
    });
    const executor = new CodexAppHostToolExecutor(
      { request: async <T>(): Promise<T> => null as T },
      {
        appTools: {
          close: () => undefined,
          listTools,
          callTool: async () => ({ success: true, contentItems: [] }),
        },
        appToolsCatalogReadinessTimeoutMs: 250,
      },
    );

    const before = executor.tools.map((tool) => tool.name);
    await expect(executor.refreshTools()).resolves.toBeUndefined();
    expect(executor.tools.map((tool) => tool.name)).toEqual(before);
    expect(executor.descriptor("codex_app__read_thread")).toBeDefined();
    expect(listTools).toHaveBeenCalledWith({ timeoutMs: 250 });
  });

  it.each([
    ["click", { x: 12, y: 34 }],
    ["click", { element_index: 2, screenshotId: "frame" }],
    ["scroll", { x: 12, y: 34, scrollX: 0, scrollY: 100 }],
    ["drag", { from_x: 12, from_y: 34, to_x: 20, to_y: 40 }],
  ])("preserves native optional screenshot arguments for %s", async (method, target) => {
    const call = vi.fn(async () => null);
    const executor = new CodexAppHostToolExecutor(
      { request: async <T>(): Promise<T> => null as T },
      { computerUse: { call } },
    );
    const name = `codex__computer_use__${method}`;
    const args = { window: { app: "notepad", id: 7 }, ...target };
    const schema = executor.descriptor(name)?.tool.inputSchema;
    expect(schema).toBeDefined();
    expect(new Ajv({ strict: false }).validate(schema as object, args)).toBe(true);
    await executor.call(name, args);
    expect(call.mock.calls[0]?.slice(0, 2)).toEqual([method, args]);
  });

  it("does not churn a native generation when only renderer prose alternates", async () => {
    const descriptions = ["native A", "native B", "native A", "native B", "native B"];
    let index = 0;
    const executor = new CodexAppHostToolExecutor(
      { request: async <T>(): Promise<T> => null as T },
      {
        appTools: {
          close: () => undefined,
          listTools: async () => {
            const call = index++;
            return [
              {
                namespace: "codex_app",
                name: "create_thread",
                title: "Create task",
                description: descriptions[Math.min(call, descriptions.length - 1)] as string,
                inputSchema: {
                  type: "object",
                  additionalProperties: false,
                  properties: { prompt: { type: "string" } },
                  required: ["prompt"],
                },
                annotations: { readOnlyHint: false },
                _meta: { native: { generation: call >= descriptions.length ? 2 : 1 } },
              },
            ];
          },
          callTool: async () => ({ success: true, contentItems: [] }),
        },
      },
    );

    await executor.refreshTools();
    expect(executor.descriptor("codex_app__create_thread")?.tool.description).toBe("native A");

    await executor.refreshTools();
    expect(executor.descriptor("codex_app__create_thread")?.tool.description).toBe("native A");
    await executor.refreshTools();
    expect(executor.descriptor("codex_app__create_thread")?.tool.description).toBe("native A");

    await executor.refreshTools();
    expect(executor.descriptor("codex_app__create_thread")?.tool.description).toBe("native A");
    await executor.refreshTools();
    expect(executor.descriptor("codex_app__create_thread")?.tool.description).toBe("native B");

    await executor.refreshTools();
    expect(executor.descriptor("codex_app__create_thread")?.tool._meta).toEqual({
      native: { generation: 2 },
    });
  });

  it("publishes external Codex Desktop lifecycle actions and routes their call boundary", async () => {
    const calls: Array<{ method: string; boundary: unknown }> = [];
    const executor = new CodexAppHostToolExecutor(
      { request: async <T>(): Promise<T> => null as T },
      {
        desktopLifecycle: {
          status: async (boundary) => {
            calls.push({ method: "status", boundary });
            return {
              installed: true,
              running: true,
              responding: true,
              nativeToolsReady: true,
              processes: [],
            };
          },
          ensureRunning: async (boundary) => {
            calls.push({ method: "ensure", boundary });
            throw new Error("not called");
          },
          restart: async (boundary) => {
            calls.push({ method: "restart", boundary });
            return {
              disposition: "restarted",
              before: {
                installed: true,
                running: true,
                responding: true,
                nativeToolsReady: false,
                processes: [],
              },
              after: {
                installed: true,
                running: true,
                responding: true,
                nativeToolsReady: true,
                processes: [],
              },
            };
          },
        },
      },
    );

    expect(executor.descriptor("codex__desktop_lifecycle__restart")).toMatchObject({
      stateEffect: "mutate",
      modelEffect: "none",
      tool: {
        annotations: { readOnlyHint: false },
        inputSchema: { additionalProperties: false },
      },
    });
    expect(executor.descriptor("codex__desktop_lifecycle__restart")?.tool.description).toContain(
      "wait for responsive native app-tools readiness",
    );
    expect(
      executor.descriptor("codex__desktop_lifecycle__restart")?.tool.description,
    ).not.toContain("recover one missing");
    const deadlineUnixMs = Date.now() + 20_000;
    await expect(
      executor.call("codex__desktop_lifecycle__restart", { timeoutMs: 9_000 }, { deadlineUnixMs }),
    ).resolves.toMatchObject({ disposition: "restarted" });
    expect(calls).toEqual([
      {
        method: "restart",
        boundary: { timeoutMs: 9_000, deadlineUnixMs },
      },
    ]);
  });

  it("publishes and calls the first-party Computer Use surface without a model turn", async () => {
    const calls: Array<{ method: string; args: unknown }> = [];
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(): Promise<T> => {
          throw new Error("Computer Use must not call the App Server directly");
        },
      },
      {
        computerUse: {
          call: async (method, args) => {
            calls.push({ method, args });
            return method === "list_apps" ? [{ id: "app-1" }] : null;
          },
        },
      },
    );

    const descriptor = executor.descriptor("codex__computer_use__list_apps");
    expect(descriptor).toMatchObject({
      name: "codex__computer_use__list_apps",
      nativeName: "codex.computer_use.list_apps",
      stateEffect: "read",
      modelEffect: "none",
      tool: {
        inputSchema: { type: "object", additionalProperties: false },
        annotations: ALL_FALSE_CATALOG_ANNOTATIONS,
        _meta: {
          omnicodex: {
            nativeNamespace: "codex.computer_use",
            route: "computer_use_native",
            invokesModel: false,
          },
        },
      },
    });
    expect(
      executor.tools.filter((tool) => tool.name.startsWith("codex__computer_use__")),
    ).toHaveLength(13);
    expect(executor.descriptor("codex__computer_use__get_window_state")?.tool).toMatchObject({
      description: expect.stringMatching(
        /include_screenshot defaults to true.*Closing Codex Desktop terminates this Computer Use host/,
      ),
      inputSchema: {
        required: ["window"],
      },
    });
    expect(
      executor.descriptor("codex__computer_use__get_window_state")?.tool.inputSchema.anyOf,
    ).toBeUndefined();
    expect(executor.descriptor("codex__computer_use__click")?.tool.inputSchema).toMatchObject({
      required: ["window"],
    });
    expect(executor.descriptor("codex__computer_use__scroll")?.tool.inputSchema).toMatchObject({
      required: ["window", "scrollX", "scrollY", "x", "y"],
    });
    expect(executor.descriptor("codex__computer_use__drag")?.tool.inputSchema).toMatchObject({
      required: ["window", "from_x", "from_y", "to_x", "to_y"],
    });
    await expect(
      executor.call("codex__computer_use__get_window_state", {
        window: { app: "ChatGPT", id: 7 },
      }),
    ).resolves.toBeNull();
    await expect(executor.call("codex__computer_use__list_apps", {})).resolves.toEqual([
      { id: "app-1" },
    ]);
    expect(calls).toEqual([
      { method: "get_window_state", args: { window: { app: "ChatGPT", id: 7 } } },
      { method: "list_apps", args: {} },
    ]);
  });

  it("passes the dynamic thread and turn scope through to Computer Use", async () => {
    const calls: Array<{
      method: string;
      args: unknown;
      contextThreadId: string | undefined;
      contextTurnId: string | undefined;
      operationId: string | undefined;
      callerSessionId: string | undefined;
    }> = [];
    const executor = new CodexAppHostToolExecutor(
      { request: async <T>(): Promise<T> => null as T },
      {
        computerUse: {
          call: async (
            method,
            args,
            contextThreadId,
            contextTurnId,
            _signal,
            operationId,
            callerSessionId,
          ) => {
            calls.push({
              method,
              args,
              contextThreadId,
              contextTurnId,
              operationId,
              callerSessionId,
            });
            return { screenshots: [{ id: "screenshot-1" }] };
          },
        },
      },
    );

    const response = await executor.callDynamic(
      {
        tool: "codex__computer_use__get_window_state",
        arguments: { window: { app: "Godot", id: 42 }, include_screenshot: true },
        callId: "computer-use-operation",
        threadId: "calling-thread",
        turnId: "calling-turn",
      },
      { callerSessionId: "mcp-session" },
    );

    expect(response.success).toBe(true);
    expect(calls).toEqual([
      {
        method: "get_window_state",
        args: { window: { app: "Godot", id: 42 }, include_screenshot: true },
        contextThreadId: "calling-thread",
        contextTurnId: "calling-turn",
        operationId: "computer-use-operation",
        callerSessionId: "mcp-session",
      },
    ]);
  });

  it("describes every window-taking Computer Use tool with its exact nested window contract", () => {
    const executor = new CodexAppHostToolExecutor(
      { request: async <T>(): Promise<T> => null as T },
      { computerUse: { call: async () => null } },
    );
    const expectedRequired = new Map<string, readonly string[]>([
      ["get_window_state", ["window"]],
      ["click", ["window"]],
      ["press_key", ["window", "key"]],
      ["type_text", ["window", "text"]],
      ["scroll", ["window", "scrollX", "scrollY", "x", "y"]],
      ["set_value", ["window", "element_index", "value"]],
      ["drag", ["window", "from_x", "from_y", "to_x", "to_y"]],
      ["perform_secondary_action", ["window", "element_index", "action"]],
      ["activate_window", ["window"]],
    ]);

    for (const [method, required] of expectedRequired) {
      const descriptor = executor.descriptor(`codex__computer_use__${method}`);
      expect(descriptor?.tool.description, method).not.toContain("same call refreshes");
      expect(descriptor?.tool.description, method).not.toContain("authoritative postcondition");
      expect(descriptor?.tool.description, method).toContain(
        "Pass the exact object returned by list_windows or get_window as nested window",
      );
      expect(descriptor?.tool.description, method).toContain(
        "{window:{app:string,id:number,title?:string}}",
      );
      expect(descriptor?.tool.description, method).toContain("as nested window");
      expect(descriptor?.tool.inputSchema, method).toMatchObject({
        type: "object",
        additionalProperties: false,
        required,
        properties: {
          window: {
            type: "object",
            required: ["app", "id"],
            additionalProperties: false,
            properties: {
              app: { type: "string", minLength: 1 },
              id: { type: "number" },
              title: { type: "string" },
            },
          },
        },
      });
      expect(descriptor?.tool.inputSchema.properties, method).not.toHaveProperty("app");
      expect(descriptor?.tool.inputSchema.properties, method).not.toHaveProperty("id");
    }

    expect(executor.descriptor("codex__computer_use__list_windows")?.tool.description).toContain(
      "Each returned object is a complete window value",
    );
    expect(executor.descriptor("codex__computer_use__get_window")?.tool.description).toContain(
      "using top-level id and optional app",
    );
    expect(
      executor.descriptor("codex__computer_use__get_window_state")?.tool.description,
    ).toContain("image(state.screenshots[0].url)");
    expect(
      executor.descriptor("codex__computer_use__get_window_state")?.tool.description,
    ).toContain("state.screenshots[0].id as the current screenshotId");
    for (const method of ["click", "scroll", "drag"]) {
      expect(executor.descriptor(`codex__computer_use__${method}`)?.tool.description).toContain(
        "screenshotId is optional; when supplied, use the current screenshotId",
      );
    }
  });

  it("preserves live schemas while routing every live tool through the native app context", async () => {
    const nativeCalls: unknown[] = [];
    const appServerCalls: Array<{ method: string; params: unknown }> = [];
    const rendererContextCalls: Array<string | undefined> = [];
    const exactSchema = {
      type: "object",
      additionalProperties: false,
      properties: { threadId: { type: "string", description: "Exact thread" } },
      required: ["threadId"],
    };
    const exactListSchema = { type: "object", additionalProperties: false, properties: {} };
    const exactOutputSchema = {
      oneOf: [{ $ref: "#/$defs/opened" }],
      $defs: { opened: { type: "object", properties: { opened: { type: "boolean" } } } },
    };
    const exactAnnotations = {
      readOnlyHint: false,
      destructiveHint: true,
      audience: ["assistant", "user"],
    };
    const exactMetadata = { codex: { surface: "desktop" }, future: { revision: 7 } };
    const exactLiveTool = {
      namespace: "codex_app",
      name: "open_in_codex",
      title: "Installed Open In Codex",
      description: "Open this exact thread in Codex.",
      inputSchema: exactSchema,
      outputSchema: exactOutputSchema,
      annotations: exactAnnotations,
      _meta: exactMetadata,
      futureRuntimeField: { preserve: ["all", "unknown", "fields"] },
    };
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(method: string, params: unknown): Promise<T> => {
          appServerCalls.push({ method, params });
          if (method === "thread/list") {
            const request = params as Record<string, unknown>;
            return {
              data:
                request.sectionId === "01984de2-8f74-7c91-a3b2-5c5e937cf318"
                  ? []
                  : [{ id: "direct-thread", name: "Direct" }],
              nextCursor: null,
            } as T;
          }
          throw new Error(`unexpected ${method}`);
        },
      },
      {
        appToolsContextThreadId: (preferred) => {
          rendererContextCalls.push(preferred);
          return preferred ?? "desktop-thread";
        },
        appTools: {
          close: () => undefined,
          listTools: async () => [
            exactLiveTool,
            {
              namespace: "codex_app",
              name: "list_threads",
              description: "Installed renderer list contract.",
              inputSchema: exactListSchema,
            },
            {
              namespace: "plugin_management",
              name: "uninstall_plugin",
              description: "Installed renderer plugin contract.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: { pluginId: { type: "string" } },
                required: ["pluginId"],
              },
            },
            {
              namespace: "experimental",
              name: "publish_world",
              description: "A future live mutation without a known safety contract.",
              inputSchema: { type: "object", additionalProperties: false, properties: {} },
            },
            {
              namespace: "node_repl",
              name: "js",
              description: "Execute JavaScript in a persistent node_repl.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: { code: { type: "string" } },
                required: ["code"],
              },
            },
          ],
          callTool: async (params) => {
            nativeCalls.push(params);
            return {
              success: true,
              contentItems: [
                {
                  type: "inputText",
                  text:
                    params.tool === "list_threads"
                      ? '{"schemaVersion":4,"threads":[{"id":"native-thread"}]}'
                      : "native-result",
                },
              ],
            };
          },
        },
      },
    );

    await executor.refreshTools();

    expect(executor.tools.slice(0, 3).map((entry) => entry.name)).toEqual([
      "codex_app__open_in_codex",
      "codex_app__list_threads",
      "plugin_management__uninstall_plugin",
    ]);
    const presentedOpenTool = executor.descriptor("codex_app__open_in_codex")?.tool;
    expect(presentedOpenTool).not.toBe(exactLiveTool);
    expect(presentedOpenTool).toEqual({
      ...exactLiveTool,
      annotations: ALL_FALSE_CATALOG_ANNOTATIONS,
    });
    const codexDynamicNamespace = executor.dynamicToolSpecs.find(
      (namespace) => namespace.name === "codex_app",
    );
    const dynamicOpenTool = Array.isArray(codexDynamicNamespace?.tools)
      ? codexDynamicNamespace.tools.find(
          (tool) => typeof tool === "object" && tool !== null && tool.name === "open_in_codex",
        )
      : undefined;
    expect(dynamicOpenTool).toEqual({
      type: "function",
      name: "open_in_codex",
      description: "Open this exact thread in Codex.",
      inputSchema: exactSchema,
      deferLoading: false,
    });
    const nodeReplNamespace = executor.dynamicToolSpecs.find(
      (namespace) => namespace.name === "node_repl",
    );
    const dynamicJsTool = Array.isArray(nodeReplNamespace?.tools)
      ? nodeReplNamespace.tools.find(
          (tool) => typeof tool === "object" && tool !== null && tool.name === "js",
        )
      : undefined;
    expect(dynamicJsTool).toMatchObject({
      description: "Execute JavaScript in a persistent node_repl.",
    });
    const liveListSchema = executor.descriptor("codex_app__list_threads")?.tool.inputSchema;
    expect(liveListSchema).toBe(exactListSchema);
    const liveListDescription = executor.descriptor("codex_app__list_threads")?.tool.description;
    expect(liveListDescription).toBe("Installed renderer list contract.");
    expect(executor.descriptor("codex_app__list_threads")?.tool.title).toBeUndefined();
    expect(executor.descriptor("codex_app__list_threads")?.tool._meta).toBeUndefined();
    expect(executor.descriptor("experimental__publish_world")?.tool.annotations).toEqual(
      ALL_FALSE_CATALOG_ANNOTATIONS,
    );
    expect(executor.descriptor("codex_app__read_thread")?.tool._meta).toMatchObject({
      omnicodex: {
        descriptorSource: "synthetic_host_fallback",
        syntheticFallback: true,
      },
    });
    await expect(
      executor.call(
        "codex_app__list_threads",
        {},
        { callingThreadId: "desktop-thread", operationId: "native-list" },
      ),
    ).resolves.toMatchObject({
      structuredContent: {
        schemaVersion: 4,
        threads: [{ id: "native-thread" }],
      },
    });
    expect(nativeCalls).toEqual([
      {
        arguments: {},
        callId: "native-list",
        namespace: "codex_app",
        threadId: "desktop-thread",
        tool: "list_threads",
        turnId: "omnicodex-native-list",
      },
    ]);
    expect(rendererContextCalls).toEqual(["desktop-thread"]);
    expect(appServerCalls).toEqual([]);

    const futureArguments = {
      payload: "unchanged",
      threadId: "native-payload-thread",
      turnId: "native-payload-turn",
      callId: "native-payload-call",
    };
    await expect(
      executor.call("experimental__publish_world", futureArguments, {
        callingThreadId: "desktop-thread",
        operationId: "native-future",
      }),
    ).resolves.toEqual({
      content: [{ type: "text", text: "native-result" }],
      isError: false,
    });
    expect(nativeCalls).toEqual([
      {
        arguments: {},
        callId: "native-list",
        namespace: "codex_app",
        threadId: "desktop-thread",
        tool: "list_threads",
        turnId: "omnicodex-native-list",
      },
      {
        arguments: futureArguments,
        callId: "native-future",
        namespace: "experimental",
        threadId: "desktop-thread",
        tool: "publish_world",
        turnId: "omnicodex-native-future",
      },
    ]);
    expect(rendererContextCalls).toEqual(["desktop-thread", "desktop-thread"]);
  });

  it("preserves the live schema and sends through the installed tool even with an IPC fallback", async () => {
    const nativeCalls: unknown[] = [];
    const messageCalls: unknown[][] = [];
    const liveSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        threadId: { type: "string" },
        prompt: { type: "string" },
        model: { type: "string" },
        thinking: { type: "string", enum: ["low", "xhigh"] },
      },
      required: ["threadId", "prompt"],
    };
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(method: string): Promise<T> => {
          if (method === "thread/read") {
            return { thread: { id: "target-thread", cwd: "C:\\workspace" } } as T;
          }
          throw new Error(`unexpected ${method}`);
        },
      },
      {
        appToolsContextThreadId: () => "calling-thread",
        appTools: {
          close: () => undefined,
          listTools: async () => [
            {
              namespace: "codex_app",
              name: "send_message_to_thread",
              description: "Installed complete thread-message contract.",
              inputSchema: liveSchema,
            },
          ],
          callTool: async (params) => {
            nativeCalls.push(params);
            return {
              success: true,
              contentItems: [{ type: "inputText", text: '{"threadId":"target-thread"}' }],
            };
          },
        },
        threadMessages: {
          sendFollowUpMessage: async (...args) => {
            messageCalls.push(args);
            return {
              threadId: "target-thread",
              ownerClientId: "desktop-owner",
              disposition: "started" as const,
              nativeResult: { turn: { id: "turn-1" } },
            };
          },
        },
      },
    );

    await executor.refreshTools();

    expect(executor.hasNativeTool("codex_app__send_message_to_thread")).toBe(true);
    expect(executor.descriptor("codex_app__send_message_to_thread")?.tool).toMatchObject({
      namespace: "codex_app",
      name: "send_message_to_thread",
      description: "Installed complete thread-message contract.",
      inputSchema: liveSchema,
    });
    expect(
      JSON.stringify(executor.descriptor("codex_app__send_message_to_thread")?.tool._meta ?? {}),
    ).not.toContain("executionGuidance");
    expect(executor.descriptor("codex_app__send_message_to_thread")?.tool.inputSchema).toBe(
      liveSchema,
    );

    const explicitAnnotations = {
      title: "Installed annotation title",
      readOnlyHint: true,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
      audience: ["assistant"],
    };
    const explicitlyAnnotatedExecutor = new CodexAppHostToolExecutor(
      {
        request: async <T>(method: string): Promise<T> => {
          throw new Error(`annotated native tool must not fall through to ${method}`);
        },
      },
      {
        appTools: {
          close: () => undefined,
          listTools: async () => [
            {
              namespace: "codex_app",
              name: "send_message_to_thread",
              title: "Installed live title",
              description: "Installed live description.",
              annotations: explicitAnnotations,
              inputSchema: liveSchema,
            },
          ],
          callTool: async () => ({ success: true, contentItems: [] }),
        },
      },
    );
    await explicitlyAnnotatedExecutor.refreshTools();
    expect(
      explicitlyAnnotatedExecutor.descriptor("codex_app__send_message_to_thread")?.tool,
    ).toMatchObject({
      namespace: "codex_app",
      name: "send_message_to_thread",
      title: "Installed live title",
      description: "Installed live description.",
      annotations: ALL_FALSE_CATALOG_ANNOTATIONS,
      inputSchema: liveSchema,
    });
    expect(
      JSON.stringify(
        explicitlyAnnotatedExecutor.descriptor("codex_app__send_message_to_thread")?.tool._meta ??
          {},
      ),
    ).not.toContain("executionGuidance");
    await expect(
      executor.call(
        "codex_app__send_message_to_thread",
        {
          threadId: "target-thread",
          prompt: "continue",
          model: "gpt-5.6-sol",
          thinking: "xhigh",
        },
        { operationId: "complete-live-operation" },
      ),
    ).resolves.toMatchObject({
      isError: false,
      structuredContent: { threadId: "target-thread" },
    });
    expect(messageCalls).toEqual([]);
    expect(nativeCalls).toEqual([
      expect.objectContaining({
        tool: "send_message_to_thread",
        callId: "complete-live-operation",
        arguments: {
          threadId: "target-thread",
          prompt: "continue",
          model: "gpt-5.6-sol",
          thinking: "xhigh",
        },
      }),
    ]);

    await expect(
      executor.call(
        "codex_app__send_message_to_thread",
        {
          threadId: "target-thread",
          prompt: "inherit current settings",
          model: "   ",
          thinking: "\t",
        },
        { operationId: "blank-live-operation" },
      ),
    ).resolves.toMatchObject({
      isError: false,
      structuredContent: { threadId: "target-thread" },
    });
    expect(messageCalls).toEqual([]);
    expect(nativeCalls.at(-1)).toMatchObject({
      callId: "blank-live-operation",
      arguments: {
        threadId: "target-thread",
        prompt: "inherit current settings",
      },
    });
  });

  it("preserves not-loaded when no native Chat message transport is available", async () => {
    const desktopMessages = vi.fn();
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(method: string): Promise<T> => {
          if (method === "thread/read") {
            throw new JsonlRpcError({
              code: -32600,
              message: "thread not loaded: web-conversation",
            });
          }
          throw new Error(`unexpected ${method}`);
        },
      },
      {
        appToolsContextThreadId: () => "calling-codex-task",
        threadMessages: {
          sendFollowUpMessage: desktopMessages,
        },
      },
    );

    await expect(
      executor.call(
        "codex_app__send_message_to_thread",
        {
          threadId: "web-conversation",
          prompt: "Web Pro가 직접 계속하세요.",
          model: "gpt-5.6-sol",
          thinking: "xhigh",
        },
        { operationId: "web-message-operation" },
      ),
    ).rejects.toThrow("thread not loaded: web-conversation");
    expect(desktopMessages).not.toHaveBeenCalled();
  });

  it.each(
    ["direct", "dynamic"].flatMap((surface) => [
      { surface, setting: "omitted", overrides: {}, expectedOverrides: {} },
      { surface, setting: "empty", overrides: { model: "", thinking: "" }, expectedOverrides: {} },
      {
        surface,
        setting: "whitespace",
        overrides: { model: " \t ", thinking: "\t" },
        expectedOverrides: {},
      },
      {
        surface,
        setting: "explicit",
        overrides: { model: "gpt-5.6-sol", thinking: "xhigh" },
        expectedOverrides: { model: "gpt-5.6-sol", thinking: "xhigh" },
      },
    ]),
  )(
    "routes an explicit Chat message through the $surface surface with $setting settings",
    async ({ surface, overrides, expectedOverrides }) => {
      const desktopMessages = vi.fn();
      const nativeSend = vi.fn(async () => ({
        success: true,
        contentItems: [{ type: "inputText" as const, text: '{"threadId":"web-conversation"}' }],
      }));
      const executor = new CodexAppHostToolExecutor(
        {
          request: async <T>(): Promise<T> => {
            throw new JsonlRpcError({
              code: -32600,
              message: "thread not loaded: web-conversation",
            });
          },
        },
        {
          appToolsContextThreadId: () => "calling-codex-task",
          appTools: {
            close: () => undefined,
            listTools: async () => [
              {
                namespace: "codex_app",
                name: "send_message_to_thread",
                description: "Send a follow-up prompt to an existing thread or chat.",
                inputSchema: {
                  type: "object",
                  properties: { threadId: { type: "string" }, prompt: { type: "string" } },
                },
              },
            ],
            callTool: nativeSend,
          },
          threadMessages: { sendFollowUpMessage: desktopMessages },
        },
      );
      await executor.refreshTools();
      const nativeInputs = {
        threadId: "web-conversation",
        prompt: "Read the requested existing file.",
        futureOption: { preserve: true },
      };
      const args = { ...nativeInputs, ...overrides };
      if (surface === "direct") {
        const result = await executor.call("codex_app__send_message_to_thread", args, {
          operationId: "chat-message",
        });
        expect(result).toEqual({
          content: [{ type: "text", text: '{"threadId":"web-conversation"}' }],
          isError: false,
          structuredContent: { threadId: "web-conversation" },
        });
      } else {
        const result = await executor.callDynamic({
          namespace: "codex_app",
          tool: "send_message_to_thread",
          arguments: args,
          callId: "chat-message",
          threadId: "calling-codex-task",
        });
        expect(result.success).toBe(true);
      }
      expect(desktopMessages).not.toHaveBeenCalled();
      expect(nativeSend).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          arguments: { ...nativeInputs, ...expectedOverrides },
          namespace: "codex_app",
          tool: "send_message_to_thread",
          callId: "chat-message",
          threadId: "calling-codex-task",
        }),
        {},
      );
    },
  );

  it("preserves native send failures without attempting an IPC fallback", async () => {
    const failure = new JsonlRpcError({ code: -32600, message: "permission denied" });
    const nativeSend = vi.fn().mockRejectedValue(failure);
    const fallback = vi.fn();
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(): Promise<T> => {
          throw failure;
        },
      },
      {
        appToolsContextThreadId: () => "calling-codex-task",
        appTools: {
          close: () => undefined,
          listTools: async () => [{ namespace: "codex_app", name: "send_message_to_thread" }],
          callTool: nativeSend,
        },
        threadMessages: { sendFollowUpMessage: fallback },
      },
    );
    await executor.refreshTools();
    await expect(
      executor.call("codex_app__send_message_to_thread", {
        threadId: "web-conversation",
        prompt: "Read the file.",
      }),
    ).rejects.toBe(failure);
    expect(nativeSend).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each(["direct", "dynamic"] as const)(
    "preserves an explicit remote host through the %s native message route",
    async (surface) => {
      const desktopMessages = vi.fn();
      const localRequests = vi.fn(() => {
        throw new Error("A remote native target must not enter local App Server lookup");
      });
      const response = {
        success: true,
        contentItems: [
          {
            type: "inputText" as const,
            text: '{"threadId":"remote-thread","hostId":"remote-host","disposition":"queued"}',
          },
        ],
      };
      const nativeSend = vi.fn(async () => response);
      const executor = new CodexAppHostToolExecutor(
        { request: async <T>(): Promise<T> => localRequests() },
        {
          appToolsContextThreadId: () => "calling-codex-task",
          appTools: {
            close: () => undefined,
            listTools: async () => [
              {
                namespace: "codex_app",
                name: "send_message_to_thread",
                inputSchema: {
                  type: "object",
                  properties: {
                    hostId: { type: "string" },
                    threadId: { type: "string" },
                    prompt: { type: "string" },
                  },
                },
              },
            ],
            callTool: nativeSend,
          },
          threadMessages: { sendFollowUpMessage: desktopMessages },
        },
      );
      await executor.refreshTools();
      const args = {
        hostId: "remote-host",
        threadId: "remote-thread",
        prompt: "Continue the requested work.",
        futureOption: { preserve: true },
      };
      if (surface === "direct") {
        expect(
          await executor.call("codex_app__send_message_to_thread", args, {
            operationId: "remote-message",
          }),
        ).toMatchObject({
          isError: false,
          structuredContent: {
            threadId: "remote-thread",
            hostId: "remote-host",
            disposition: "queued",
          },
        });
      } else {
        expect(
          await executor.callDynamic({
            namespace: "codex_app",
            tool: "send_message_to_thread",
            arguments: args,
            callId: "remote-message",
            threadId: "calling-codex-task",
          }),
        ).toBe(response);
      }
      expect(nativeSend).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          arguments: args,
          callId: "remote-message",
          threadId: "calling-codex-task",
        }),
        expect.anything(),
      );
      expect(localRequests).not.toHaveBeenCalled();
      expect(desktopMessages).not.toHaveBeenCalled();
    },
  );

  it.each(["model", "thinking"] as const)(
    "preserves explicit settings in the native call when an older schema omits %s",
    async (missingProperty) => {
      const nativeCalls: unknown[] = [];
      const messageCalls: unknown[][] = [];
      const schemaProperties: Record<string, unknown> = {
        threadId: { type: "string" },
        prompt: { type: "string" },
        model: { type: "string" },
        thinking: { type: "string", enum: ["xhigh"] },
      };
      delete schemaProperties[missingProperty];
      const liveSchema = {
        type: "object",
        additionalProperties: false,
        properties: schemaProperties,
        required: ["threadId", "prompt"],
      };
      const executor = new CodexAppHostToolExecutor(
        {
          request: async <T>(method: string, params: unknown): Promise<T> => {
            if (method === "thread/read") {
              return { thread: { id: "target-thread", cwd: "C:\\workspace" } } as T;
            }
            throw new Error(`unexpected ${method} ${JSON.stringify(params)}`);
          },
        },
        {
          appToolsContextThreadId: () => "calling-thread",
          appTools: {
            close: () => undefined,
            listTools: async () => [
              {
                namespace: "codex_app",
                name: "send_message_to_thread",
                description: "Installed reduced thread-message contract.",
                inputSchema: liveSchema,
              },
            ],
            callTool: async (params) => {
              nativeCalls.push(params);
              return { success: true, contentItems: [] };
            },
          },
          threadMessages: {
            sendFollowUpMessage: async (...args) => {
              messageCalls.push(args);
              return {
                threadId: "target-thread",
                ownerClientId: "desktop-owner",
                disposition: "started" as const,
                nativeResult: { turn: { id: "turn-1" } },
              };
            },
          },
        },
      );

      await executor.refreshTools();

      expect(executor.hasNativeTool("codex_app__send_message_to_thread")).toBe(true);
      expect(executor.descriptor("codex_app__send_message_to_thread")?.tool.inputSchema).toBe(
        liveSchema,
      );
      await expect(
        executor.call(
          "codex_app__send_message_to_thread",
          {
            threadId: "target-thread",
            prompt: "continue",
            model: "gpt-5.6-sol",
            thinking: "xhigh",
          },
          { operationId: `fallback-${missingProperty}` },
        ),
      ).resolves.toEqual({ content: [], isError: false });
      expect(messageCalls).toEqual([]);
      expect(nativeCalls).toEqual([
        expect.objectContaining({
          callId: `fallback-${missingProperty}`,
          arguments: {
            threadId: "target-thread",
            prompt: "continue",
            model: "gpt-5.6-sol",
            thinking: "xhigh",
          },
        }),
      ]);
    },
  );

  it("serializes the complete controlled fallback mutation for one thread", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const messageOrder: string[] = [];
    let reads = 0;
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(method: string): Promise<T> => {
          if (method === "thread/read") {
            reads += 1;
            return { thread: { id: "serialized-thread", cwd: "C:\\workspace" } } as T;
          }
          throw new Error(`unexpected ${method}`);
        },
      },
      {
        appTools: {
          close: () => undefined,
          listTools: async () => [
            {
              namespace: "codex_app",
              name: "send_message_to_thread",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  threadId: { type: "string" },
                  prompt: { type: "string" },
                },
                required: ["threadId", "prompt"],
              },
            },
          ],
          callTool: async () => {
            throw new Error("reduced live tool must not be called");
          },
        },
        threadMessages: {
          sendFollowUpMessage: async (threadId, prompt) => {
            messageOrder.push(prompt);
            if (prompt === "first") {
              markFirstStarted();
              await firstGate;
            }
            return {
              threadId,
              ownerClientId: "desktop-owner",
              disposition: "started" as const,
              nativeResult: { turn: { id: `turn-${prompt}` } },
            };
          },
        },
      },
    );
    await executor.refreshTools();

    const first = executor.call(
      "codex_app__send_message_to_thread",
      {
        threadId: "serialized-thread",
        prompt: "first",
        model: "gpt-5.6-sol",
        thinking: "xhigh",
      },
      { operationId: "serialized-first" },
    );
    await firstStarted;
    const second = executor.call(
      "codex_app__send_message_to_thread",
      {
        threadId: "serialized-thread",
        prompt: "second",
        model: "gpt-5.6-terra",
        thinking: "low",
      },
      { operationId: "serialized-second" },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(messageOrder).toEqual(["first"]);
    expect(reads).toBe(1);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      {
        threadId: "serialized-thread",
        disposition: "started",
        clientUserMessageId: "serialized-first",
      },
      {
        threadId: "serialized-thread",
        disposition: "started",
        clientUserMessageId: "serialized-second",
      },
    ]);
    expect(messageOrder).toEqual(["first", "second"]);
    expect(reads).toBe(2);
  });

  it("removes a cancelled queued thread mutation before it can dispatch late", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const dispatchedPrompts: string[] = [];
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(method: string, params: unknown): Promise<T> => {
          if (method === "thread/read") {
            const threadId = (params as { threadId: string }).threadId;
            return { thread: { id: threadId, cwd: "C:\\workspace" } } as T;
          }
          throw new Error(`unexpected ${method}`);
        },
      },
      {
        threadMessages: {
          sendFollowUpMessage: async (threadId, prompt) => {
            dispatchedPrompts.push(prompt);
            if (prompt === "first") {
              markFirstStarted();
              await firstGate;
            }
            return {
              threadId,
              ownerClientId: "desktop-owner",
              disposition: "started" as const,
              nativeResult: { turn: { id: `turn-${prompt}` } },
            };
          },
        },
      },
    );

    const first = executor.call(
      "codex_app__send_message_to_thread",
      { threadId: "cancelled-lane", prompt: "first" },
      { operationId: "lane-first" },
    );
    await firstStarted;

    const controller = new AbortController();
    const cancelled = executor.call(
      "codex_app__send_message_to_thread",
      { threadId: "cancelled-lane", prompt: "must-not-dispatch" },
      { operationId: "lane-cancelled", signal: controller.signal },
    );
    const cancelledAssertion = expect(cancelled).rejects.toThrow("caller cancelled queued work");
    controller.abort(new Error("caller cancelled queued work"));
    await cancelledAssertion;

    releaseFirst();
    await first;
    await expect(
      executor.call(
        "codex_app__send_message_to_thread",
        { threadId: "cancelled-lane", prompt: "third" },
        { operationId: "lane-third" },
      ),
    ).resolves.toMatchObject({ disposition: "started" });
    expect(dispatchedPrompts).toEqual(["first", "third"]);
  });

  it("fails closed when a required live native tool is absent or rejects the operation", async () => {
    const nativeCalls: unknown[] = [];
    const appServerCalls: Array<{ method: string; params: unknown }> = [];
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(method: string, params: unknown): Promise<T> => {
          appServerCalls.push({ method, params });
          if (method === "thread/name/set") {
            throw new Error(
              "thread writer rejected the mutation\nauthoritative acknowledgement missing",
            );
          }
          throw new Error(`unexpected ${method}`);
        },
      },
      {
        appToolsContextThreadId: () => "bridge-thread",
        appTools: {
          close: () => undefined,
          listTools: async () => [
            {
              namespace: "codex_app",
              name: "set_thread_title",
              description: "Set the exact thread title.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: { title: { type: "string" } },
                required: ["title"],
              },
            },
          ],
          callTool: async (params) => {
            nativeCalls.push(params);
            return {
              success: false,
              contentItems: [
                {
                  type: "inputText",
                  text: "thread writer rejected the mutation\nauthoritative acknowledgement missing",
                },
              ],
            };
          },
        },
      },
    );

    await executor.refreshTools();

    await expect(
      executor.callRequiredNative(
        "codex_app__set_thread_title",
        { threadId: "bridge-thread", title: "OmniCodex" },
        { operationId: "required-title", timeoutMs: 30_000 },
      ),
    ).rejects.toThrow(
      "Required Codex app native tool codex_app__set_thread_title failed: thread writer rejected the mutation\nauthoritative acknowledgement missing",
    );
    await expect(
      executor.callRequiredNative("codex_app__set_thread_archived", { archived: true }),
    ).rejects.toThrow(
      "Required live Codex app native tool is unavailable: codex_app__set_thread_archived",
    );
    expect(appServerCalls).toEqual([]);
    expect(nativeCalls).toEqual([
      {
        arguments: { threadId: "bridge-thread", title: "OmniCodex" },
        callId: "required-title",
        namespace: "codex_app",
        threadId: "bridge-thread",
        tool: "set_thread_title",
        turnId: "omnicodex-required-title",
      },
    ]);
  });

  it("preserves a native root union and forwards the caller object without a wrapper", async () => {
    const calls: unknown[] = [];
    const nativeUnion = {
      oneOf: [{ $ref: "#/$defs/view" }, { $ref: "#/$defs/update" }],
      $defs: {
        view: {
          type: "object",
          properties: { mode: { const: "view" }, id: { type: "string" } },
          required: ["mode", "id"],
          additionalProperties: false,
        },
        update: {
          type: "object",
          properties: { mode: { const: "update" }, id: { type: "string" } },
          required: ["mode", "id"],
          additionalProperties: false,
        },
      },
    };
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(method: string): Promise<T> => {
          throw new Error(`native tool must not fall through to ${method}`);
        },
      },
      {
        appToolsContextThreadId: () => "bridge-thread",
        appTools: {
          close: () => undefined,
          listTools: async () => [
            {
              namespace: "codex_app",
              name: "automation_update",
              description: "Update one automation.",
              inputSchema: nativeUnion,
            },
          ],
          callTool: async (params) => {
            calls.push(params);
            return { success: true, contentItems: [{ type: "inputText", text: "ok" }] };
          },
        },
      },
    );

    await executor.refreshTools();

    expect(executor.descriptor("codex_app__automation_update")?.tool).toEqual({
      namespace: "codex_app",
      name: "automation_update",
      description: "Update one automation.",
      inputSchema: nativeUnion,
      annotations: ALL_FALSE_CATALOG_ANNOTATIONS,
    });
    const nativeArguments = { mode: "view", id: "automation-1" };
    await expect(
      executor.call("codex_app__automation_update", nativeArguments, { operationId: "union-call" }),
    ).resolves.toMatchObject({ isError: false });
    expect(calls).toEqual([
      expect.objectContaining({
        arguments: nativeArguments,
        namespace: "codex_app",
        tool: "automation_update",
      }),
    ]);
  });

  it("advertises namespace-qualified dynamic tools and calls the same native implementation", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client: AppServerRpcClient = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "thread/list") {
          const request = params as Record<string, unknown>;
          if (request.sectionId === "01984de2-8f74-7c91-a3b2-5c5e937cf318") {
            return { data: [{ id: "thread-pinned", name: "Pinned" }], nextCursor: null } as T;
          }
          return { data: [{ id: "thread-recent", name: "Recent" }], nextCursor: null } as T;
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const executor = new CodexAppHostToolExecutor(client, {
      threadMessages: {
        sendFollowUpMessage: async () => {
          throw new Error("not called");
        },
      },
    });

    expect(executor.dynamicToolSpecs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "namespace",
          name: "codex_app",
          tools: expect.arrayContaining([
            expect.objectContaining({ type: "function", name: "list_threads" }),
            expect.objectContaining({ type: "function", name: "send_message_to_thread" }),
          ]),
        }),
        expect.objectContaining({
          type: "namespace",
          name: "plugin_management",
          tools: [expect.objectContaining({ name: "uninstall_plugin" })],
        }),
      ]),
    );

    const response = await executor.callDynamic({
      namespace: "codex_app",
      tool: "list_threads",
      arguments: { limit: 4 },
    });

    expect(response.success).toBe(true);
    expect(JSON.parse(response.contentItems[0]?.text ?? "null")).toMatchObject({
      schemaVersion: 4,
      pinnedThreads: [{ id: "thread-pinned", pinnedIndex: 1 }],
      threads: [{ id: "thread-recent" }],
    });
    expect(calls).toEqual([
      {
        method: "thread/list",
        params: expect.objectContaining({
          limit: 100,
          sectionId: "01984de2-8f74-7c91-a3b2-5c5e937cf318",
          sortKey: "section_position",
          useStateDbOnly: true,
        }),
      },
      {
        method: "thread/list",
        params: expect.objectContaining({
          archived: false,
          limit: 5,
          sortKey: "recency_at",
          useStateDbOnly: true,
        }),
      },
    ]);
  });

  it("passes nested thread sends unchanged to the installed tool without IPC duplication", async () => {
    const nativeCalls: unknown[] = [];
    const messageCalls: unknown[][] = [];
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(method: string): Promise<T> => {
          if (method === "thread/read") {
            return { thread: { id: "target-thread", cwd: "C:\\workspace" } } as T;
          }
          throw new Error(`unexpected ${method}`);
        },
      },
      {
        appToolsContextThreadId: () => "calling-thread",
        appTools: {
          close: () => undefined,
          listTools: async () => [
            {
              namespace: "codex_app",
              name: "send_message_to_thread",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  threadId: { type: "string" },
                  prompt: { type: "string" },
                },
                required: ["threadId", "prompt"],
              },
            },
          ],
          callTool: async (params) => {
            nativeCalls.push(params);
            return { success: true, contentItems: [] };
          },
        },
        threadMessages: {
          sendFollowUpMessage: async (...args) => {
            messageCalls.push(args);
            return {
              threadId: "target-thread",
              ownerClientId: "desktop-owner",
              disposition: "started" as const,
              nativeResult: { turn: { id: "turn-plain" } },
            };
          },
        },
      },
    );
    await executor.refreshTools();

    const response = await executor.callDynamic({
      namespace: "codex_app",
      tool: "send_message_to_thread",
      arguments: { threadId: "target-thread", prompt: "  <plain>&  " },
      callId: "nested-plain-operation",
      threadId: "calling-thread",
      turnId: "calling-turn",
    });

    expect(response.success).toBe(true);
    expect(messageCalls).toEqual([]);
    expect(nativeCalls).toEqual([
      {
        namespace: "codex_app",
        tool: "send_message_to_thread",
        arguments: { threadId: "target-thread", prompt: "  <plain>&  " },
        callId: "nested-plain-operation",
        threadId: "calling-thread",
        turnId: "calling-turn",
      },
    ]);
    expect(response).toEqual({ success: true, contentItems: [] });
  });

  it("paginates every pinned thread while keeping archived pagination separate", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client: AppServerRpcClient = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method !== "thread/list") throw new Error(`unexpected ${method}`);
        const request = params as Record<string, unknown>;
        if (request.archived === true) {
          return { data: [{ id: "archived-1" }], nextCursor: "archived-next" } as T;
        }
        if (
          request.sectionId === "01984de2-8f74-7c91-a3b2-5c5e937cf318" &&
          request.cursor === "pinned-next"
        ) {
          return { data: [{ id: "pinned-2" }], nextCursor: null } as T;
        }
        if (request.sectionId === "01984de2-8f74-7c91-a3b2-5c5e937cf318") {
          return { data: [{ id: "pinned-1" }], nextCursor: "pinned-next" } as T;
        }
        return { data: [{ id: "recent-1" }], nextCursor: "ignored-recent-cursor" } as T;
      },
    };
    const executor = new CodexAppHostToolExecutor(client);

    await expect(executor.call("codex_app__list_threads", { limit: 1 })).resolves.toMatchObject({
      schemaVersion: 4,
      pinnedThreads: [
        { id: "pinned-1", pinnedIndex: 1 },
        { id: "pinned-2", pinnedIndex: 2 },
      ],
      threads: [{ id: "recent-1" }],
    });
    await expect(
      executor.call("codex_app__list_archived_threads", {
        limit: 1,
        cursor: "archived-cursor",
      }),
    ).resolves.toMatchObject({
      threads: [{ id: "archived-1", archived: true }],
      nextCursor: "archived-next",
    });
    expect(calls.at(-1)).toEqual({
      method: "thread/list",
      params: expect.objectContaining({
        archived: true,
        cursor: "archived-cursor",
        limit: 1,
        sortKey: "updated_at",
      }),
    });
  });

  it("forwards caller-selected thread list limits above the former adapter cap", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client: AppServerRpcClient = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        if (method !== "thread/list") throw new Error(`unexpected ${method}`);
        const request = params as Record<string, unknown>;
        calls.push({ method, params: request });
        if (request.sectionId === "01984de2-8f74-7c91-a3b2-5c5e937cf318") {
          return { data: [], nextCursor: null } as T;
        }
        const limit = request.limit as number;
        return {
          data: Array.from({ length: limit }, (_, index) => ({
            id: `${request.archived === true ? "archived" : "recent"}-${index}`,
            ...(index === 0
              ? {
                  preview: "p".repeat(200),
                  futureRuntimeField: { revision: 7 },
                }
              : {}),
          })),
          nextCursor: null,
        } as T;
      },
    };
    const executor = new CodexAppHostToolExecutor(client);

    const listed = (await executor.call("codex_app__list_threads", { limit: 75 })) as {
      threads: unknown[];
    };
    const archived = (await executor.call("codex_app__list_archived_threads", {
      limit: 75,
    })) as { threads: unknown[] };

    expect(listed.threads).toHaveLength(75);
    expect(archived.threads).toHaveLength(75);
    expect(listed.threads[0]).toMatchObject({
      title: "p".repeat(200),
      summary: "p".repeat(200),
      futureRuntimeField: { revision: 7 },
    });
    expect(calls.some((call) => call.params.limit === 75 && call.params.archived === true)).toBe(
      true,
    );
    expect(
      executor.descriptor("codex_app__list_threads")?.tool.inputSchema.properties?.limit,
    ).not.toHaveProperty("maximum");
    expect(
      executor.descriptor("codex_app__list_archived_threads")?.tool.inputSchema.properties?.limit,
    ).not.toHaveProperty("maximum");
  });

  it("requires authoritative pinned-state acknowledgement from App Server", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    let section: Record<string, unknown> | null = null;
    const client: AppServerRpcClient = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "thread/read") {
          return { thread: { id: "thread-1", section } } as T;
        }
        if (method === "thread/section/move") {
          section = { id: "01984de2-8f74-7c91-a3b2-5c5e937cf318", name: "Pinned" };
          return {} as T;
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const executor = new CodexAppHostToolExecutor(client);

    await expect(
      executor.call("codex_app__set_thread_pinned", { threadId: "thread-1", pinned: true }),
    ).resolves.toEqual({ threadId: "thread-1", pinned: true });
    expect(calls).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: false },
      },
      {
        method: "thread/section/move",
        params: {
          beforeThreadId: null,
          sectionId: "01984de2-8f74-7c91-a3b2-5c5e937cf318",
          threadId: "thread-1",
        },
      },
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: false },
      },
    ]);

    const unconfirmed = new CodexAppHostToolExecutor({
      request: async <T>(method: string): Promise<T> =>
        (method === "thread/read" ? { thread: { id: "thread-1", section: null } } : {}) as T,
    });
    await expect(
      unconfirmed.call("codex_app__set_thread_pinned", {
        threadId: "thread-1",
        pinned: true,
      }),
    ).rejects.toThrow("did not confirm the requested pinned state");
  });

  it("delegates project, create, and worktree fork behavior to the app-global native host", async () => {
    const nativeCalls: unknown[] = [];
    const client: AppServerRpcClient = {
      request: async <T>(method: string): Promise<T> => {
        throw new Error(`App Server must not handle app-global ${method}`);
      },
    };
    const executor = new CodexAppHostToolExecutor(client, {
      appToolsContextThreadId: () => "bridge-thread",
      appTools: {
        listTools: async () => [],
        close: () => undefined,
        callTool: async (params) => {
          nativeCalls.push(params);
          const value =
            params.tool === "list_projects"
              ? { schemaVersion: 2, projects: [{ projectId: "project-1" }] }
              : params.tool === "create_thread"
                ? { hostId: "local", threadId: "thread-new", status: "started" }
                : { clientThreadId: "pending-worktree-thread" };
          return {
            success: true,
            contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
          };
        },
      },
    });

    await expect(
      executor.call("codex_app__list_projects", {}, { operationId: "list-operation" }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"schemaVersion":2,"projects":[{"projectId":"project-1"}]}',
        },
      ],
      structuredContent: { schemaVersion: 2, projects: [{ projectId: "project-1" }] },
      isError: false,
    });

    await expect(
      executor.call(
        "codex_app__create_thread",
        {
          prompt: "기본 설정을 상속하세요.",
          target: { type: "projectless" },
          model: " ",
          thinking: "\t",
        },
        { operationId: "create-inherited-operation" },
      ),
    ).resolves.toMatchObject({
      structuredContent: { threadId: "thread-new", status: "started" },
      isError: false,
    });

    await expect(
      executor.call(
        "codex_app__create_thread",
        {
          title: "새 작업",
          prompt: "실제 작업을 시작하세요.",
          target: {
            type: "project",
            projectId: "project-1",
            environment: { type: "local" },
          },
          model: "gpt-5.6-sol",
          thinking: "xhigh",
        },
        { operationId: "create-operation" },
      ),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"hostId":"local","threadId":"thread-new","status":"started"}',
        },
      ],
      structuredContent: { hostId: "local", threadId: "thread-new", status: "started" },
      isError: false,
    });

    await expect(
      executor.call(
        "codex_app__fork_thread",
        { threadId: "source-thread", environment: { type: "worktree" } },
        { operationId: "fork-operation" },
      ),
    ).resolves.toEqual({
      content: [{ type: "text", text: '{"clientThreadId":"pending-worktree-thread"}' }],
      structuredContent: { clientThreadId: "pending-worktree-thread" },
      isError: false,
    });

    expect(nativeCalls).toEqual([
      {
        arguments: {},
        callId: "list-operation",
        namespace: "codex_app",
        threadId: "bridge-thread",
        tool: "list_projects",
        turnId: "omnicodex-list-operation",
      },
      {
        arguments: {
          prompt: "기본 설정을 상속하세요.",
          target: { type: "projectless" },
        },
        callId: "create-inherited-operation",
        namespace: "codex_app",
        threadId: "bridge-thread",
        tool: "create_thread",
        turnId: "omnicodex-create-inherited-operation",
      },
      {
        arguments: {
          title: "새 작업",
          prompt: "실제 작업을 시작하세요.",
          target: {
            type: "project",
            projectId: "project-1",
            environment: { type: "local" },
          },
          model: "gpt-5.6-sol",
          thinking: "xhigh",
        },
        callId: "create-operation",
        namespace: "codex_app",
        threadId: "bridge-thread",
        tool: "create_thread",
        turnId: "omnicodex-create-operation",
      },
      {
        arguments: { threadId: "source-thread", environment: { type: "worktree" } },
        callId: "fork-operation",
        namespace: "codex_app",
        threadId: "bridge-thread",
        tool: "fork_thread",
        turnId: "omnicodex-fork-operation",
      },
    ]);
  });

  it("uses the dynamic calling thread as the native app context", async () => {
    const nativeCalls: unknown[] = [];
    const observations: unknown[] = [];
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(method: string): Promise<T> => {
          throw new Error(`unexpected ${method}`);
        },
      },
      {
        appToolsContextThreadId: (preferred) => preferred ?? "bridge-thread",
        observeDynamicToolCall: (observation) => {
          observations.push(observation);
        },
        appTools: {
          listTools: async () => [],
          close: () => undefined,
          callTool: async (params) => {
            nativeCalls.push(params);
            return {
              success: true,
              contentItems: [{ type: "inputText", text: '{"threadId":"child"}' }],
            };
          },
        },
      },
    );

    await executor.callDynamic({
      namespace: "codex_app",
      tool: "fork_thread",
      arguments: { environment: { type: "same-directory" } },
      callId: "dynamic-operation",
      threadId: "calling-thread",
      turnId: "calling-turn",
    });

    expect(nativeCalls[0]).toMatchObject({
      callId: "dynamic-operation",
      threadId: "calling-thread",
      tool: "fork_thread",
      turnId: "calling-turn",
    });
    expect(observations).toEqual([
      {
        name: "codex_app__fork_thread",
        phase: "started",
        callId: "dynamic-operation",
        threadId: "calling-thread",
      },
      {
        name: "codex_app__fork_thread",
        phase: "succeeded",
        callId: "dynamic-operation",
        threadId: "calling-thread",
      },
    ]);
  });

  it("uses the Bridge context for a model-free execution thread", async () => {
    const preferredContexts: Array<string | undefined> = [];
    const nativeCalls: Array<{ threadId: string }> = [];
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(method: string): Promise<T> => {
          throw new Error(`unexpected ${method}`);
        },
      },
      {
        appToolsContextThreadId: (preferred) => {
          preferredContexts.push(preferred);
          return "bridge-thread";
        },
        appTools: {
          listTools: async () => [
            {
              namespace: "codex_app",
              name: "list_threads",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: { limit: { type: "integer", minimum: 1 } },
              },
            },
          ],
          close: () => undefined,
          callTool: async (params) => {
            nativeCalls.push({ threadId: params.threadId });
            return { success: true, contentItems: [] };
          },
        },
      },
    );
    await executor.refreshTools();

    await executor.callDynamic(
      {
        namespace: "codex_app",
        tool: "list_threads",
        arguments: { limit: 1 },
        threadId: "model-free-execution-thread",
      },
      { executionOnlyCallingThread: true },
    );

    expect(preferredContexts).toEqual([undefined]);
    expect(nativeCalls).toEqual([{ threadId: "bridge-thread" }]);
  });

  it("observes a nested failure without exposing arguments or result content", async () => {
    const observations: unknown[] = [];
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(method: string): Promise<T> => {
          throw new Error(`unexpected ${method}`);
        },
      },
      {
        appToolsContextThreadId: () => "bridge-thread",
        observeDynamicToolCall: (observation) => {
          observations.push(observation);
        },
        appTools: {
          listTools: async () => [],
          close: () => undefined,
          callTool: async () => ({
            success: false,
            contentItems: [{ type: "inputText", text: "private failure details" }],
          }),
        },
      },
    );

    const result = await executor.callDynamic({
      namespace: "codex_app",
      tool: "fork_thread",
      arguments: { privateValue: "must-not-be-observed" },
      callId: "failed-operation",
      threadId: "calling-thread",
    });

    expect(result.success).toBe(false);
    expect(observations).toEqual([
      {
        name: "codex_app__fork_thread",
        phase: "started",
        callId: "failed-operation",
        threadId: "calling-thread",
      },
      {
        name: "codex_app__fork_thread",
        phase: "failed",
        callId: "failed-operation",
        threadId: "calling-thread",
      },
    ]);
    expect(JSON.stringify(observations)).not.toContain("must-not-be-observed");
    expect(JSON.stringify(observations)).not.toContain("private failure details");
  });

  it("waits through the live native app context without falling back to App Server", async () => {
    const nativeCalls: unknown[] = [];
    const resolverCalls: unknown[] = [];
    const appServerCalls: Array<{ method: string; params: unknown }> = [];
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(method: string, params: unknown): Promise<T> => {
          appServerCalls.push({ method, params });
          if (method === "thread/read") {
            return {
              thread: { id: "target-thread", name: "Target", status: { type: "idle" } },
            } as T;
          }
          if (method === "thread/turns/list") {
            return { data: [], nextCursor: null } as T;
          }
          throw new Error(`unexpected ${method}`);
        },
      },
      {
        appToolsContextThreadId: (preferred, excluded = []) => {
          resolverCalls.push({ preferred, excluded });
          return "source-thread";
        },
        appTools: {
          close: () => undefined,
          listTools: async () => [
            {
              namespace: "codex_app",
              name: "wait_threads",
              description: "Wait for another Codex thread.",
              inputSchema: {
                type: "object",
                properties: {
                  targets: { type: "array", items: { type: "object" } },
                  timeoutMs: { type: "integer" },
                },
                required: ["targets"],
                additionalProperties: false,
              },
            },
          ],
          callTool: async (params) => {
            nativeCalls.push(params);
            return {
              success: true,
              contentItems: [{ type: "inputText", text: '{"timedOut":false}' }],
            };
          },
        },
      },
    );
    await executor.refreshTools();

    await expect(
      executor.call("codex_app__wait_threads", {
        targets: [{ threadId: "target-thread" }],
        timeoutMs: 0,
      }),
    ).resolves.toMatchObject({ structuredContent: { timedOut: false } });
    expect(resolverCalls).toEqual([{ preferred: undefined, excluded: ["target-thread"] }]);
    expect(nativeCalls).toEqual([
      {
        arguments: {
          targets: [{ threadId: "target-thread" }],
          timeoutMs: 0,
        },
        callId: expect.any(String),
        namespace: "codex_app",
        threadId: "source-thread",
        tool: "wait_threads",
        turnId: expect.stringMatching(/^omnicodex-/u),
      },
    ]);
    expect(appServerCalls).toEqual([]);
  });

  it("sends through the native thread transport exactly once and preserves explicit settings", async () => {
    const appCalls: Array<{ method: string; params: unknown; options: unknown }> = [];
    const messageCalls: unknown[][] = [];
    const controller = new AbortController();
    const deadlineUnixMs = Date.now() + 60_000;
    const client: AppServerRpcClient = {
      request: async <T>(method: string, params: unknown, options?: unknown): Promise<T> => {
        appCalls.push({ method, params, options });
        if (method === "thread/read") {
          return {
            thread: {
              id: "thread-existing",
              cwd: "C:\\workspace",
              latestModel: "gpt-5.6-sol",
              latestReasoningEffort: "high",
              status: { type: "idle" },
            },
          } as T;
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const executor = new CodexAppHostToolExecutor(client, {
      threadMessages: {
        sendFollowUpMessage: async (...args) => {
          messageCalls.push(args);
          return {
            threadId: "thread-existing",
            ownerClientId: "desktop-owner",
            disposition: "started" as const,
            nativeResult: { turn: { id: "turn-1" } },
            transport: "desktop_ipc" as const,
          };
        },
      },
    });

    await expect(
      executor.call(
        "codex_app__send_message_to_thread",
        {
          threadId: "thread-existing",
          prompt: "계속하세요.",
          thinking: "xhigh",
        },
        {
          signal: controller.signal,
          timeoutMs: 3_000_000_000,
          deadlineUnixMs,
        },
      ),
    ).resolves.toMatchObject({
      threadId: "thread-existing",
      ownerClientId: "desktop-owner",
      disposition: "started",
      transport: "desktop_ipc",
      clientUserMessageId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
      nativeResult: { turn: { id: "turn-1" } },
    });

    expect(appCalls).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-existing", includeTurns: false },
        options: {
          signal: controller.signal,
          timeoutMs: 3_000_000_000,
          deadlineUnixMs,
        },
      },
    ]);
    expect(messageCalls).toEqual([
      [
        "thread-existing",
        "계속하세요.",
        {
          hostId: "local",
          cwd: "C:\\workspace",
          clientUserMessageId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          ),
          signal: controller.signal,
          timeoutMs: 3_000_000_000,
          deadlineUnixMs,
          threadSettings: { effort: "xhigh" },
        },
      ],
    ]);
  });

  it("waits for the native thread status notification and returns the confirmed idle snapshot", async () => {
    let listener: ((message: Record<string, unknown>) => void) | undefined;
    let reads = 0;
    const client: AppServerRpcClient = {
      subscribeNotifications: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      request: async <T>(method: string): Promise<T> => {
        if (method === "thread/turns/list") {
          return {
            data: [
              {
                id: "turn-wait",
                status: reads === 0 ? "inProgress" : "completed",
                items: [{ id: "assistant-1", type: "agentMessage", text: "완료했습니다." }],
              },
            ],
            nextCursor: null,
          } as T;
        }
        if (method !== "thread/read") throw new Error(`unexpected ${method}`);
        reads += 1;
        return {
          thread: {
            id: "thread-wait",
            updatedAt: reads,
            status: { type: reads === 1 ? "active" : "idle" },
          },
        } as T;
      },
    };
    const executor = new CodexAppHostToolExecutor(client, { waitPollIntervalMs: 5_000 });
    const waiting = executor.call("codex_app__wait_threads", {
      targets: [{ threadId: "thread-wait" }],
      timeoutMs: 10_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    listener?.({ method: "thread/status/changed", params: { threadId: "thread-wait" } });

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      wake: {
        threadId: "thread-wait",
        reason: "turnCompleted",
        status: { status: "idle" },
        latestAssistantMessage: { text: "완료했습니다." },
      },
    });
    expect(reads).toBe(2);
  });

  it("keeps waiting through the desktop start transition until the dispatched turn really completes", async () => {
    let listener: ((message: Record<string, unknown>) => void) | undefined;
    let reads = 0;
    let markSecondRead!: () => void;
    const secondRead = new Promise<void>((resolve) => {
      markSecondRead = resolve;
    });
    const client: AppServerRpcClient = {
      subscribeNotifications: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      request: async <T>(method: string): Promise<T> => {
        throw new Error(`desktop snapshot unexpectedly fell back to ${method}`);
      },
    };
    const executor = new CodexAppHostToolExecutor(client, {
      waitPollIntervalMs: 5_000,
      threadSnapshots: {
        readThreadSnapshot: async () => {
          reads += 1;
          if (reads === 2) markSecondRead();
          const phase = Math.min(reads, 3);
          const status = phase === 1 ? "interrupted" : phase === 2 ? "inProgress" : "completed";
          const items =
            phase === 3
              ? [{ id: "assistant-transition", type: "agentMessage", text: "TRANSITION_ACK" }]
              : [];
          return {
            threadId: "thread-transition",
            hostId: "local",
            ownerClientId: "desktop-owner",
            revision: phase,
            conversationState: {
              id: "thread-transition",
              threadRuntimeStatus: {
                type: phase === 1 ? "notLoaded" : phase === 2 ? "active" : "idle",
                activeFlags: [],
              },
              turns: [
                {
                  id: "turn-transition",
                  status,
                  startedAt: 100,
                  ...(phase === 3 ? { completedAt: 101, durationMs: 1_000 } : {}),
                  items,
                },
              ],
            },
          };
        },
      },
    });

    const waiting = executor.call("codex_app__wait_threads", {
      targets: [{ threadId: "thread-transition" }],
      timeoutMs: 10_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    listener?.({ method: "thread/status/changed", params: { threadId: "thread-transition" } });
    await secondRead;
    listener?.({ method: "turn/completed", params: { threadId: "thread-transition" } });

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      wake: {
        threadId: "thread-transition",
        reason: "turnCompleted",
        status: { status: "idle" },
        latestTurn: { id: "turn-transition", status: "completed" },
        latestAssistantMessage: { text: "TRANSITION_ACK" },
      },
    });
    expect(reads).toBe(3);
  });

  it("keeps the newer live turn state while retaining richer canonical items", async () => {
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(method: string): Promise<T> => {
          throw new Error(`desktop snapshot unexpectedly fell back to ${method}`);
        },
      },
      {
        threadSnapshots: {
          readThreadSnapshot: async () => ({
            threadId: "thread-merge",
            hostId: "local",
            ownerClientId: "desktop-owner",
            revision: 1,
            conversationState: {
              id: "thread-merge",
              threadRuntimeStatus: { type: "notLoaded", activeFlags: [] },
              turnHistory: {
                kind: "canonical",
                history: {
                  entitiesByKey: {
                    "turn-key": {
                      id: "turn-merge",
                      status: "interrupted",
                      startedAt: 100,
                      items: [{ id: "user-merge", type: "userMessage", text: "queued" }],
                    },
                  },
                  islands: [{ entries: [{ value: "turn-key" }] }],
                },
              },
              turns: [{ id: "turn-merge", status: "inProgress", startedAt: 100, items: [] }],
            },
          }),
        },
      },
    );

    await expect(
      executor.call("codex_app__wait_threads", {
        targets: [{ threadId: "thread-merge" }],
        timeoutMs: 0,
      }),
    ).resolves.toMatchObject({
      timedOut: true,
      wake: null,
      polls: [
        {
          status: { status: "notLoaded" },
          latestTurn: { id: "turn-merge", status: "inProgress" },
        },
      ],
    });
  });

  it("accepts a caller-selected wait above the former cap and wakes without wall-clock delay", async () => {
    let listener: ((message: Record<string, unknown>) => void) | undefined;
    let fakeNow = 50_000;
    let reads = 0;
    let markInitialRead!: () => void;
    const initialRead = new Promise<void>((resolve) => {
      markInitialRead = resolve;
    });
    const client: AppServerRpcClient = {
      subscribeNotifications: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      request: async <T>(method: string): Promise<T> => {
        if (method === "thread/read") {
          reads += 1;
          if (reads === 1) markInitialRead();
          return {
            thread: {
              id: "thread-long-wait",
              status: { type: reads === 1 ? "active" : "idle" },
            },
          } as T;
        }
        if (method === "thread/turns/list") {
          return {
            data: [
              {
                id: "turn-long-wait",
                status: reads === 1 ? "inProgress" : "completed",
                items: [],
              },
            ],
            nextCursor: null,
          } as T;
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const executor = new CodexAppHostToolExecutor(client, {
      now: () => fakeNow,
      waitPollIntervalMs: 5_000,
    });
    expect(executor.descriptor("codex_app__wait_threads")?.tool.inputSchema).toMatchObject({
      properties: {
        timeoutMs: { default: 120_000 },
      },
    });
    expect(
      executor.descriptor("codex_app__wait_threads")?.tool.inputSchema.properties?.timeoutMs,
    ).not.toHaveProperty("maximum");

    const waiting = executor.call("codex_app__wait_threads", {
      targets: [{ threadId: "thread-long-wait" }],
      timeoutMs: 60 * 60_000,
    });
    await initialRead;
    fakeNow += 1_000;
    listener?.({
      method: "thread/status/changed",
      params: { threadId: "thread-long-wait" },
    });

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      wake: {
        threadId: "thread-long-wait",
        reason: "turnCompleted",
        status: { status: "idle" },
      },
    });
    expect(reads).toBe(2);
  });

  it("propagates the caller request timeout to the desktop wait snapshot unchanged", async () => {
    const snapshotOptions: unknown[] = [];
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(method: string): Promise<T> => {
          throw new Error(`desktop snapshot unexpectedly fell back to ${method}`);
        },
      },
      {
        threadSnapshots: {
          readThreadSnapshot: async (_threadId, options) => {
            snapshotOptions.push(options);
            return {
              threadId: "thread-timeout",
              hostId: "local",
              ownerClientId: "desktop-owner",
              revision: 1,
              conversationState: {
                id: "thread-timeout",
                threadRuntimeStatus: { type: "active", activeFlags: [] },
                turns: [{ id: "turn-timeout", status: "inProgress", items: [] }],
              },
            };
          },
        },
      },
    );

    await expect(
      executor.call(
        "codex_app__wait_threads",
        { targets: [{ threadId: "thread-timeout" }], timeoutMs: 0 },
        { timeoutMs: 3_000_000_000 },
      ),
    ).resolves.toMatchObject({ timedOut: true });
    expect(snapshotOptions).toEqual([
      {
        hostId: "local",
        completeHistory: false,
        timeoutMs: 3_000_000_000,
        deadlineUnixMs: expect.any(Number),
      },
    ]);
  });

  it("preserves the prompt bytes and returns the native dispatch correlation", async () => {
    const messageCalls: unknown[][] = [];
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(method: string): Promise<T> => {
          if (method === "thread/read") {
            return { thread: { id: "target", cwd: "C:\\workspace" } } as T;
          }
          throw new Error(`unexpected ${method}`);
        },
      },
      {
        threadMessages: {
          sendFollowUpMessage: async (...args) => {
            messageCalls.push(args);
            return {
              threadId: "target",
              ownerClientId: "desktop",
              disposition: "started" as const,
              nativeResult: { turn: { id: "turn-1" } },
            };
          },
        },
      },
    );

    await expect(
      executor.call(
        "codex_app__send_message_to_thread",
        { threadId: "target", prompt: "  <keep>&  " },
        { callingThreadId: "source<&", operationId: "operation-1" },
      ),
    ).resolves.toEqual({
      threadId: "target",
      ownerClientId: "desktop",
      disposition: "started",
      clientUserMessageId: "operation-1",
      nativeResult: { turn: { id: "turn-1" } },
    });
    expect(messageCalls).toEqual([
      [
        "target",
        "  <keep>&  ",
        {
          hostId: "local",
          cwd: "C:\\workspace",
          clientUserMessageId: "operation-1",
        },
      ],
    ]);
  });

  it("uses generation revisions so an unchanged final answer is not emitted twice", async () => {
    const executor = new CodexAppHostToolExecutor({
      request: async <T>(method: string): Promise<T> => {
        if (method === "thread/read") {
          return { thread: { id: "thread-final", name: "Final", status: { type: "idle" } } } as T;
        }
        if (method === "thread/turns/list") {
          return {
            data: [
              {
                id: "turn-final",
                status: "completed",
                items: [{ id: "answer", type: "agentMessage", text: "최종 응답" }],
              },
            ],
            nextCursor: null,
          } as T;
        }
        throw new Error(`unexpected ${method}`);
      },
    });

    const first = (await executor.call("codex_app__wait_threads", {
      targets: [{ threadId: "thread-final" }],
      timeoutMs: 0,
    })) as { wake: { cursor: string } };
    expect(first.wake.cursor).toMatch(/^[0-9a-f-]+:1$/);

    await expect(
      executor.call("codex_app__wait_threads", {
        targets: [{ threadId: "thread-final", afterCursor: first.wake.cursor }],
        timeoutMs: 0,
      }),
    ).resolves.toMatchObject({
      timedOut: true,
      wake: null,
      polls: [
        {
          changed: false,
          revision: 1,
          latestAssistantMessageId: "answer",
          latestAssistantMessage: null,
        },
      ],
    });
  });

  it("wakes for actionable active flags and preserves another target read failure", async () => {
    const executor = new CodexAppHostToolExecutor({
      request: async <T>(method: string, params: unknown): Promise<T> => {
        const threadId = (params as { threadId?: string }).threadId;
        if (threadId === "broken") {
          throw Object.assign(
            new Error("broken thread store", { cause: new Error("writer lock unavailable") }),
            { code: "THREAD_STORE_BROKEN", retryable: true },
          );
        }
        if (method === "thread/read") {
          return {
            thread: {
              id: "actionable",
              status: { type: "active", activeFlags: ["waitingOnApproval"] },
            },
          } as T;
        }
        if (method === "thread/turns/list") {
          return { data: [{ id: "turn-active", status: "inProgress", items: [] }] } as T;
        }
        throw new Error(`unexpected ${method}`);
      },
    });

    await expect(
      executor.call("codex_app__wait_threads", {
        targets: [{ threadId: "broken" }, { threadId: "actionable" }],
        timeoutMs: 0,
      }),
    ).resolves.toMatchObject({
      timedOut: false,
      wake: {
        threadId: "actionable",
        reason: "actionableStatus",
        status: { activeFlags: ["waitingOnApproval"] },
      },
      errors: [
        {
          threadId: "broken",
          message: "broken thread store",
          error: {
            name: "Error",
            message: "broken thread store",
            code: "THREAD_STORE_BROKEN",
            retryable: true,
            cause: { name: "Error", message: "writer lock unavailable" },
          },
        },
      ],
    });
  });

  it("keeps semantic item fields while omitting only bulky outputs", async () => {
    const executor = new CodexAppHostToolExecutor({
      request: async <T>(method: string): Promise<T> => {
        if (method === "thread/read") {
          return { thread: { id: "thread-read", name: "Read", preview: "not a title" } } as T;
        }
        if (method === "thread/turns/list") {
          return {
            data: [
              {
                id: "turn-1",
                items: [
                  {
                    id: "command-id-must-survive",
                    type: "commandExecution",
                    command: "long-command-name",
                    cwd: "C:\\workspace",
                    output: "0123456789",
                  },
                  {
                    id: "file-id",
                    type: "fileChange",
                    changes: [{ path: "C:\\workspace\\a.ts", diff: "abcdefghij" }],
                  },
                  {
                    id: "mcp-id",
                    type: "mcpToolCall",
                    tool: "native_tool",
                    status: "completed",
                    result: {
                      content: [{ type: "text", text: "0123456789" }],
                      structuredContent: { value: "abcdefghij" },
                    },
                  },
                ],
              },
            ],
            nextCursor: null,
          } as T;
        }
        throw new Error(`unexpected ${method}`);
      },
    });

    await expect(
      executor.call("codex_app__read_thread", {
        threadId: "thread-read",
        includeOutputs: false,
        maxOutputCharsPerItem: 4,
      }),
    ).resolves.toMatchObject({
      thread: { title: "Read", preview: "not a title" },
      page: { nextCursor: null },
      turns: [
        {
          items: [
            {
              id: "command-id-must-survive",
              command: "long-command-name",
              cwd: "C:\\workspace",
            },
            { id: "file-id", changes: [{ path: "C:\\workspace\\a.ts" }] },
            {
              id: "mcp-id",
              type: "mcpToolCall",
              tool: "native_tool",
              status: "completed",
            },
          ],
        },
      ],
    });

    const included = (await executor.call("codex_app__read_thread", {
      threadId: "thread-read",
      includeOutputs: true,
      maxOutputCharsPerItem: 4,
    })) as { turns: Array<{ items: Array<Record<string, unknown>> }> };
    expect(included.turns[0]?.items[0]?.output).toEqual({
      text: "0123",
      truncated: true,
      originalChars: 10,
    });
    const projectedChanges = included.turns[0]?.items[1]?.changes;
    expect(Array.isArray(projectedChanges) ? projectedChanges[0] : undefined).toMatchObject({
      path: "C:\\workspace\\a.ts",
      diff: { text: "abcd", truncated: true, originalChars: 10 },
    });
    expect(included.turns[0]?.items[2]?.result).toEqual({
      content: [{ type: "text", text: "0123" }],
      structuredContent: { value: "abcd" },
      _meta: {
        omnicodex: {
          outputProjection: {
            limitPerString: 4,
            truncatedStrings: 2,
            originalCharacters: 20,
          },
        },
      },
    });

    const defaultLossless = (await executor.call("codex_app__read_thread", {
      threadId: "thread-read",
    })) as { turns: Array<{ items: Array<Record<string, unknown>> }> };
    expect(defaultLossless.turns[0]?.items[0]?.output).toBe("0123456789");
    expect(defaultLossless.turns[0]?.items[1]?.changes).toEqual([
      { path: "C:\\workspace\\a.ts", diff: "abcdefghij" },
    ]);
    expect(defaultLossless.turns[0]?.items[2]?.result).toEqual({
      content: [{ type: "text", text: "0123456789" }],
      structuredContent: { value: "abcdefghij" },
    });
  });

  it("uses the lossless App Server thread cursor instead of the renderer convenience cursor", async () => {
    const appServerCalls: Array<{ method: string; params: unknown }> = [];
    const nativeCall = vi.fn(
      async (params: CodexAppNativeToolCallParams): Promise<CodexAppNativeToolCallResponse> => ({
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({
              thread: { id: "large-thread" },
              turns: [{ id: "turn-large", items: [{ type: "agentMessage", text: "done" }] }],
              receivedArguments: params.arguments,
            }),
          },
        ],
      }),
    );
    const liveReadSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        threadId: { type: "string" },
        turnLimit: { type: "integer" },
      },
      required: ["threadId"],
    };
    const liveReadOutputSchema = {
      type: "object",
      properties: { turns: { type: "array" } },
    };
    const liveReadAnnotations = {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    };
    const liveReadMeta = {
      ui: { invocation: "Reading task" },
      vendor: { generation: 7 },
    };
    const liveReadIcons = [
      { src: "data:image/svg+xml;base64,PHN2Zy8+", mimeType: "image/svg+xml" },
    ];
    const liveReadExecution = { taskSupport: "forbidden" };
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(method: string, params: unknown): Promise<T> => {
          appServerCalls.push({ method, params });
          if (method === "thread/turns/list") {
            return {
              data: [{ id: "turn-large", items: [{ type: "agentMessage", text: "done" }] }],
              nextCursor: null,
            } as T;
          }
          if (method === "thread/read") {
            return { thread: { id: "large-thread", name: "Large" } } as T;
          }
          throw new Error(`unexpected ${method}`);
        },
      },
      {
        appToolsContextThreadId: () => "calling-thread",
        appTools: {
          close: () => undefined,
          listTools: async () => [
            {
              namespace: "codex_app",
              name: "read_thread",
              title: "Installed Read Thread",
              description: "Installed renderer read contract.",
              inputSchema: liveReadSchema,
              outputSchema: liveReadOutputSchema,
              annotations: liveReadAnnotations,
              _meta: liveReadMeta,
              icons: liveReadIcons,
              execution: liveReadExecution,
              vendorFutureField: { preserve: true },
            },
          ],
          callTool: nativeCall,
        },
      },
    );
    await executor.refreshTools();

    const readDescriptor = executor.descriptor("codex_app__read_thread");
    const readTool = readDescriptor?.tool as unknown as Record<string, unknown>;
    const readSchema = readDescriptor?.tool.inputSchema;
    expect(readSchema).not.toBe(liveReadSchema);
    expect(readSchema).toMatchObject({
      properties: {
        threadId: { type: "string" },
        cursor: { type: "string" },
      },
      required: ["threadId"],
    });
    expect(readTool).toMatchObject({
      name: "read_thread",
      title: "Installed Read Thread",
      description: "Installed renderer read contract.",
      outputSchema: liveReadOutputSchema,
      annotations: ALL_FALSE_CATALOG_ANNOTATIONS,
      _meta: liveReadMeta,
      icons: liveReadIcons,
      execution: liveReadExecution,
      vendorFutureField: { preserve: true },
    });

    const args = { threadId: "large-thread", turnLimit: 1 };
    const context = { callingThreadId: "calling-thread", operationId: "read-one" };
    await expect(executor.call("codex_app__read_thread", args, context)).resolves.toMatchObject({
      thread: { id: "large-thread" },
      page: { hasMore: false, nextCursor: null },
      turns: [{ id: "turn-large" }],
    });
    expect(nativeCall).not.toHaveBeenCalled();
    expect(appServerCalls.map((call) => call.method)).toEqual(["thread/read", "thread/turns/list"]);

    appServerCalls.length = 0;
    const dynamicRead = await executor.callDynamic({
      namespace: "codex_app",
      tool: "read_thread",
      arguments: args,
      callId: "dynamic-read-one",
      threadId: "calling-thread",
    });
    expect(dynamicRead.success).toBe(true);
    expect(JSON.parse(dynamicRead.contentItems[0]?.text ?? "null")).toMatchObject({
      thread: { id: "large-thread" },
      page: { hasMore: false, nextCursor: null },
      turns: [{ id: "turn-large" }],
    });
    expect(nativeCall).not.toHaveBeenCalled();
    expect(appServerCalls.map((call) => call.method)).toEqual(["thread/read", "thread/turns/list"]);
  });

  it("falls back to the live renderer reader only for a Web conversation not loaded by App Server", async () => {
    const appServerCalls: string[] = [];
    const nativeRead = vi.fn(
      async (_params: CodexAppNativeToolCallParams): Promise<CodexAppNativeToolCallResponse> => ({
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({
              schemaVersion: 1,
              thread: { id: "web-conversation", kind: "chatgpt", title: "Web conversation" },
              page: { order: "newest_first", nextCursor: null, hasMore: false },
              turns: [
                {
                  id: "web-turn",
                  text: "renderer result",
                  items: Array.from({ length: 10 }, (_, index) => ({
                    id: `web-item-${String(index)}`,
                    type: "agentMessage",
                    text: `item ${String(index)}`,
                  })),
                },
              ],
            }),
          },
        ],
      }),
    );
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(method: string): Promise<T> => {
          appServerCalls.push(method);
          throw new JsonlRpcError({
            code: -32600,
            message: "thread not loaded: web-conversation",
          });
        },
      },
      {
        appToolsContextThreadId: () => "calling-codex-task",
        appTools: {
          close: () => undefined,
          listTools: async () => [
            {
              namespace: "codex_app",
              name: "read_thread",
              description: "Read a Codex task or ChatGPT conversation.",
              inputSchema: {
                type: "object",
                properties: { threadId: { type: "string" } },
                required: ["threadId"],
              },
            },
          ],
          callTool: nativeRead,
        },
      },
    );
    await executor.refreshTools();

    await expect(
      executor.call(
        "codex_app__read_thread",
        {
          threadId: "web-conversation",
          hostId: "local",
          cursor: "web-cursor",
          turnLimit: 2,
          includeOutputs: true,
          maxOutputCharsPerItem: 4096,
          maxItemsPerTurn: 4,
          itemOffset: 8,
          itemTurnId: "web-turn",
        },
        { callingThreadId: "calling-codex-task", operationId: "web-read" },
      ),
    ).resolves.toMatchObject({
      thread: { id: "web-conversation", kind: "chatgpt" },
      turns: [
        {
          id: "web-turn",
          text: "renderer result",
          items: [
            { id: "web-item-8", type: "agentMessage", text: "item 8" },
            { id: "web-item-9", type: "agentMessage", text: "item 9" },
          ],
          itemsPage: {
            order: "source_order",
            limit: 4,
            offset: 8,
            totalItems: 10,
            returnedItems: 2,
            nextItemOffset: null,
          },
        },
      ],
    });
    expect(appServerCalls).toEqual(["thread/read", "thread/turns/list"]);
    expect(nativeRead).toHaveBeenCalledTimes(1);
    expect(nativeRead).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: {
          threadId: "web-conversation",
          hostId: "local",
          cursor: "web-cursor",
          turnLimit: 2,
          includeOutputs: true,
          maxOutputCharsPerItem: 4096,
        },
        callId: "web-read",
        namespace: "codex_app",
        threadId: "calling-codex-task",
        tool: "read_thread",
      }),
      expect.any(Object),
    );
  });

  it("exhausts renderer pages for explicit large reads and omitted caller limits", async () => {
    const nativeRead = vi.fn(
      async (params: CodexAppNativeToolCallParams): Promise<CodexAppNativeToolCallResponse> => {
        const args = params.arguments as Record<string, unknown>;
        const cursor = args.cursor;
        const start = cursor === "cursor-10" ? 10 : 0;
        const count = Number(args.turnLimit);
        const turns = Array.from({ length: count }, (_, offset) => ({
          id: `web-turn-${String(start + offset)}`,
          text: `renderer page ${String(start + offset)}`,
        }));
        return {
          success: true,
          contentItems: [
            {
              type: "inputText",
              text: JSON.stringify({
                schemaVersion: 1,
                attachments: [{ name: "shared.png", path: "C:\\Temp\\shared.png" }],
                thread: { id: "web-conversation", kind: "chatgpt" },
                page: {
                  order: "newest_first",
                  nextCursor: start === 0 ? "cursor-10" : null,
                  hasMore: start === 0,
                },
                turns,
              }),
            },
          ],
        };
      },
    );
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(): Promise<T> => {
          throw new JsonlRpcError({
            code: -32600,
            message: "thread not loaded: web-conversation",
          });
        },
      },
      {
        appToolsContextThreadId: () => "calling-codex-task",
        appTools: {
          close: () => undefined,
          listTools: async () => [
            {
              namespace: "codex_app",
              name: "read_thread",
              description: "Read a Codex task or ChatGPT conversation.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          callTool: nativeRead,
        },
      },
    );
    await executor.refreshTools();

    await expect(
      executor.call(
        "codex_app__read_thread",
        {
          threadId: "web-conversation",
          turnLimit: 12,
          includeOutputs: true,
          maxOutputCharsPerItem: 1_000_000,
        },
        { callingThreadId: "calling-codex-task", operationId: "large-web-read" },
      ),
    ).resolves.toMatchObject({
      attachments: [{ name: "shared.png", path: "C:\\Temp\\shared.png" }],
      thread: { id: "web-conversation", kind: "chatgpt" },
      page: {
        limit: 12,
        returnedTurns: 12,
        hasMore: false,
        nextCursor: null,
        sourcePageLimit: 10,
      },
      turns: Array.from({ length: 12 }, (_, index) => ({ id: `web-turn-${String(index)}` })),
    });
    expect(nativeRead).toHaveBeenCalledTimes(2);
    expect(nativeRead.mock.calls.map(([params]) => params.arguments)).toEqual([
      expect.objectContaining({ turnLimit: 10, maxOutputCharsPerItem: 1_000_000 }),
      expect.objectContaining({
        cursor: "cursor-10",
        turnLimit: 2,
        maxOutputCharsPerItem: 1_000_000,
      }),
    ]);
    expect(nativeRead.mock.calls.map(([params]) => params.callId)).toEqual([
      "large-web-read:renderer-page:0",
      "large-web-read:renderer-page:1",
    ]);

    nativeRead.mockClear();
    await expect(
      executor.call(
        "codex_app__read_thread",
        { threadId: "web-conversation", includeOutputs: true },
        { callingThreadId: "calling-codex-task", operationId: "complete-web-read" },
      ),
    ).resolves.toMatchObject({
      page: {
        limit: null,
        returnedTurns: 20,
        hasMore: false,
        nextCursor: null,
        sourcePageLimit: 10,
      },
      turns: Array.from({ length: 20 }, (_, index) => ({ id: `web-turn-${String(index)}` })),
    });
    expect(nativeRead).toHaveBeenCalledTimes(2);
    expect(nativeRead.mock.calls.map(([params]) => params.arguments)).toEqual([
      expect.objectContaining({ turnLimit: 10 }),
      expect.objectContaining({ cursor: "cursor-10", turnLimit: 10 }),
    ]);
  });

  it.each(["native-error", "transport-error", "unstructured-page", "cursor-cycle"])(
    "retains completed renderer pages and resumes at the failed cursor after %s",
    async (failureMode) => {
      const firstPage = {
        thread: { id: "web-conversation", kind: "chatgpt" },
        attachments: [{ name: "source.txt", futureField: "retain" }],
        page: { nextCursor: "cursor-10", hasMore: true },
        turns: Array.from({ length: 10 }, (_, index) => ({ id: `turn-${index}` })),
        futureMetadata: { preserve: true },
      };
      const failureText = JSON.stringify({ code: "SOURCE_UNAVAILABLE", retryAfterMs: 2500 });
      let failContinuation = true;
      const nativeRead = vi.fn(
        async (params: CodexAppNativeToolCallParams): Promise<CodexAppNativeToolCallResponse> => {
          const args = params.arguments as Record<string, unknown>;
          if (args.cursor === "cursor-10" && failContinuation) {
            if (failureMode === "transport-error") {
              throw Object.assign(new Error("source disconnected"), { code: "ECONNRESET" });
            }
            return {
              success: failureMode === "unstructured-page" || failureMode === "cursor-cycle",
              contentItems: [
                {
                  type: "inputText",
                  text:
                    failureMode === "native-error"
                      ? failureText
                      : failureMode === "cursor-cycle"
                        ? JSON.stringify(firstPage)
                        : "not a page",
                },
              ],
            };
          }
          return {
            success: true,
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify(
                  args.cursor === "cursor-10"
                    ? {
                        thread: firstPage.thread,
                        page: { nextCursor: null, hasMore: false },
                        turns: [{ id: "turn-10" }, { id: "turn-11" }],
                      }
                    : firstPage,
                ),
              },
            ],
          };
        },
      );
      const executor = new CodexAppHostToolExecutor(
        {
          request: async <T>(): Promise<T> => {
            throw new JsonlRpcError({
              code: -32600,
              message: "thread not loaded: web-conversation",
            });
          },
        },
        {
          appToolsContextThreadId: () => "calling-codex-task",
          appTools: {
            close: () => undefined,
            listTools: async () => [
              {
                namespace: "codex_app",
                name: "read_thread",
                description: "Read history",
                inputSchema: { type: "object", properties: {} },
              },
            ],
            callTool: nativeRead,
          },
        },
      );
      await executor.refreshTools();
      const args = {
        threadId: "web-conversation",
        hostId: "local",
        turnLimit: 12,
        includeOutputs: true,
        maxOutputCharsPerItem: 8192,
      };
      const result = (await executor.call("codex_app__read_thread", args)) as {
        isError: boolean;
        content: unknown[];
        structuredContent: {
          complete: boolean;
          completedPages: (typeof firstPage)[];
          continuation: { tool: string; arguments: Record<string, unknown> };
          failure: unknown;
        };
      };
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        complete: false,
        completedPages: [firstPage],
        continuation: {
          tool: "codex_app__read_thread",
          arguments: { ...args, cursor: "cursor-10", turnLimit: 2 },
        },
      });
      if (failureMode === "native-error") {
        expect(result.content[0]).toEqual({ type: "text", text: failureText });
      } else if (failureMode === "transport-error") {
        expect(result.structuredContent.failure).toMatchObject({
          error: { code: "ECONNRESET", message: "source disconnected" },
        });
      } else if (failureMode === "cursor-cycle") {
        expect(result.structuredContent.failure).toMatchObject({
          error: { code: "ERR_THREAD_READ_CURSOR_CYCLE", cursor: "cursor-10" },
          response: { content: [{ type: "text", text: JSON.stringify(firstPage) }] },
        });
      } else {
        expect(result.structuredContent.failure).toMatchObject({
          response: { content: [{ type: "text", text: "not a page" }] },
        });
      }
      failContinuation = false;
      const continuation = result.structuredContent.continuation;
      const resumed = (await executor.call(continuation.tool, continuation.arguments)) as {
        turns: { id: string }[];
      };
      expect(
        [
          ...result.structuredContent.completedPages.flatMap((page) => page.turns),
          ...resumed.turns,
        ].map((turn) => turn.id),
      ).toEqual(Array.from({ length: 12 }, (_, index) => `turn-${index}`));
      expect(
        nativeRead.mock.calls.map(
          ([params]) => (params.arguments as Record<string, unknown>).cursor,
        ),
      ).toEqual([undefined, "cursor-10", "cursor-10"]);
    },
  );

  it("detects a renderer cursor cycle against the caller's initial cursor without rereading it", async () => {
    const page = {
      thread: { id: "web-conversation", kind: "chatgpt" },
      page: { nextCursor: "caller-cursor", hasMore: true },
      turns: [{ id: "turn-at-caller-cursor" }],
    };
    const nativeRead = vi.fn(
      async (): Promise<CodexAppNativeToolCallResponse> => ({
        success: true,
        contentItems: [{ type: "inputText", text: JSON.stringify(page) }],
      }),
    );
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(): Promise<T> => {
          throw new JsonlRpcError({ code: -32600, message: "thread not loaded: web-conversation" });
        },
      },
      {
        appToolsContextThreadId: () => "calling-codex-task",
        appTools: {
          close: () => undefined,
          listTools: async () => [
            {
              namespace: "codex_app",
              name: "read_thread",
              description: "Read history",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          callTool: nativeRead,
        },
      },
    );
    await executor.refreshTools();
    const args = { threadId: "web-conversation", cursor: "caller-cursor", turnLimit: 12 };
    await expect(executor.call("codex_app__read_thread", args)).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        complete: false,
        completedPages: [],
        failure: {
          error: { code: "ERR_THREAD_READ_CURSOR_CYCLE", cursor: "caller-cursor" },
          response: { content: [{ type: "text", text: JSON.stringify(page) }] },
        },
        continuation: { tool: "codex_app__read_thread", arguments: args },
      },
    });
    expect(nativeRead).toHaveBeenCalledTimes(1);
  });

  it("does not hide unrelated App Server read failures behind the renderer reader", async () => {
    const nativeRead = vi.fn(
      async (): Promise<CodexAppNativeToolCallResponse> => ({
        success: true,
        contentItems: [],
      }),
    );
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(): Promise<T> => {
          throw new JsonlRpcError({ code: -32600, message: "state database unavailable" });
        },
      },
      {
        appToolsContextThreadId: () => "calling-codex-task",
        appTools: {
          close: () => undefined,
          listTools: async () => [
            {
              namespace: "codex_app",
              name: "read_thread",
              description: "Read a Codex task or ChatGPT conversation.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          callTool: nativeRead,
        },
      },
    );
    await executor.refreshTools();

    await expect(
      executor.call(
        "codex_app__read_thread",
        { threadId: "codex-task" },
        { callingThreadId: "calling-codex-task" },
      ),
    ).rejects.toThrow("state database unavailable");
    expect(nativeRead).not.toHaveBeenCalled();
  });

  it("single-flights concurrent raw projections but refetches after external thread changes", async () => {
    let turnReads = 0;
    const executor = new CodexAppHostToolExecutor({
      request: async <T>(method: string, params: unknown): Promise<T> => {
        const threadId = (params as { threadId?: string }).threadId ?? "projection-thread";
        if (method === "thread/read") {
          return { thread: { id: threadId, name: "Projection" } } as T;
        }
        if (method === "thread/turns/list") {
          if (threadId === "projection-thread") turnReads += 1;
          return {
            data: [
              {
                id: `turn-${threadId}`,
                items: [
                  { id: "user", type: "userMessage", text: "work" },
                  { id: "command", type: "commandExecution", output: "0123456789" },
                  { id: "answer", type: "agentMessage", text: `done-${turnReads}` },
                ],
              },
            ],
            nextCursor: null,
          } as T;
        }
        throw new Error(`unexpected ${method}`);
      },
    });

    const [compact, detailed] = (await Promise.all([
      executor.call("codex_app__read_thread", {
        threadId: "projection-thread",
        includeOutputs: false,
        maxItemsPerTurn: 2,
      }),
      executor.call("codex_app__read_thread", {
        threadId: "projection-thread",
        includeOutputs: true,
        maxItemsPerTurn: 3,
        maxOutputCharsPerItem: 4,
      }),
    ])) as [
      { turns: Array<{ items: Array<Record<string, unknown>> }> },
      { turns: Array<{ items: Array<Record<string, unknown>> }> },
    ];

    expect(turnReads).toBe(1);
    expect(compact.turns[0]?.items).toHaveLength(2);
    expect(compact.turns[0]?.items[1]).not.toHaveProperty("output");
    expect(detailed.turns[0]?.items).toHaveLength(3);
    expect(detailed.turns[0]?.items[1]?.output).toEqual({
      text: "0123",
      truncated: true,
      originalChars: 10,
    });

    const refreshed = (await executor.call("codex_app__read_thread", {
      threadId: "projection-thread",
    })) as { turns: Array<{ items: Array<Record<string, unknown>> }> };
    expect(turnReads).toBe(2);
    expect(refreshed.turns[0]?.items[2]?.text).toBe("done-2");
  });

  it("omits response-item outputs and encrypted reasoning only when the caller excludes outputs", async () => {
    const executor = new CodexAppHostToolExecutor({
      request: async <T>(method: string): Promise<T> => {
        if (method === "thread/read") {
          return { thread: { id: "response-items", name: "Response items" } } as T;
        }
        if (method === "thread/turns/list") {
          return {
            data: [
              {
                id: "turn-response-items",
                items: [
                  {
                    id: "reasoning",
                    type: "reasoning",
                    summary: [{ type: "summary_text", text: "kept" }],
                    content: "reasoning-content",
                    encrypted_content: "encrypted-reasoning",
                  },
                  {
                    id: "custom-output",
                    type: "custom_tool_call_output",
                    call_id: "call-custom",
                    output: "custom-output-value",
                  },
                  {
                    id: "function-output",
                    type: "function_call_output",
                    call_id: "call-function",
                    output: "function-output-value",
                  },
                  {
                    id: "search-output",
                    type: "tool_search_output",
                    call_id: "call-search",
                    output: "search-output-value",
                  },
                ],
              },
            ],
            nextCursor: null,
          } as T;
        }
        throw new Error(`unexpected ${method}`);
      },
    });

    const compact = (await executor.call("codex_app__read_thread", {
      threadId: "response-items",
      includeOutputs: false,
    })) as { turns: Array<{ items: Array<Record<string, unknown>> }> };
    expect(compact.turns[0]?.items[0]).toMatchObject({
      id: "reasoning",
      summary: [{ type: "summary_text", text: "kept" }],
    });
    expect(compact.turns[0]?.items[0]).not.toHaveProperty("content");
    expect(compact.turns[0]?.items[0]).not.toHaveProperty("encrypted_content");
    for (const item of compact.turns[0]?.items.slice(1) ?? []) {
      expect(item).not.toHaveProperty("output");
    }

    const detailed = (await executor.call("codex_app__read_thread", {
      threadId: "response-items",
      includeOutputs: true,
      maxOutputCharsPerItem: 6,
    })) as { turns: Array<{ items: Array<Record<string, unknown>> }> };
    expect(detailed.turns[0]?.items[0]?.content).toEqual({
      text: "reason",
      truncated: true,
      originalChars: 17,
    });
    expect(detailed.turns[0]?.items[0]?.encrypted_content).toEqual({
      text: "encryp",
      truncated: true,
      originalChars: 19,
    });
    expect(detailed.turns[0]?.items[1]?.output).toMatchObject({ value: "custom" });
    expect(detailed.turns[0]?.items[2]?.output).toMatchObject({ value: "functi" });
    expect(detailed.turns[0]?.items[3]?.output).toMatchObject({ value: "search" });
  });

  it("clears a failed raw thread read flight before retrying", async () => {
    let turnReads = 0;
    const executor = new CodexAppHostToolExecutor({
      request: async <T>(method: string): Promise<T> => {
        if (method === "thread/read") {
          return { thread: { id: "retry-thread", name: "Retry" } } as T;
        }
        if (method === "thread/turns/list") {
          turnReads += 1;
          if (turnReads === 1) throw new Error("transient materialization failure");
          return { data: [], nextCursor: null } as T;
        }
        throw new Error(`unexpected ${method}`);
      },
    });

    await expect(
      executor.call("codex_app__read_thread", { threadId: "retry-thread" }),
    ).rejects.toThrow("transient materialization failure");
    await expect(
      executor.call("codex_app__read_thread", { threadId: "retry-thread" }),
    ).resolves.toMatchObject({ thread: { id: "retry-thread" }, turns: [] });
    expect(turnReads).toBe(2);
  });

  it("observes both parallel App Server failures for an invalid thread", async () => {
    let rejectMetadata!: (error: Error) => void;
    let rejectTurns!: (error: Error) => void;
    const metadata = new Promise<never>((_resolve, reject) => {
      rejectMetadata = reject;
    });
    const turns = new Promise<never>((_resolve, reject) => {
      rejectTurns = reject;
    });
    const executor = new CodexAppHostToolExecutor({
      request: async <T>(method: string): Promise<T> => {
        if (method === "thread/read") return metadata as Promise<T>;
        if (method === "thread/turns/list") return turns as Promise<T>;
        throw new Error(`unexpected ${method}`);
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const pending = executor.call("codex_app__read_thread", {
        threadId: "not-a-codex-thread",
      });
      rejectTurns(new Error("thread not loaded: not-a-codex-thread"));
      await expect(pending).rejects.toThrow("thread not loaded: not-a-codex-thread");
      rejectMetadata(new Error("thread not loaded: not-a-codex-thread"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("exhausts terminal and command-item cursors independently without truncating output", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const executor = new CodexAppHostToolExecutor({
      request: async <T>(method: string, params: unknown): Promise<T> => {
        const typed = params as Record<string, unknown>;
        calls.push({ method, params: typed });
        const cursor = typed.cursor;
        if (method === "thread/backgroundTerminals/list") {
          return (
            cursor === undefined
              ? { data: [{ id: "terminal-2" }], nextCursor: "terminal-page-2" }
              : { data: [{ id: "terminal-1" }], nextCursor: null }
          ) as T;
        }
        if (method === "thread/items/list") {
          return (
            cursor === undefined
              ? {
                  data: [
                    {
                      item: {
                        id: "command-2",
                        type: "commandExecution",
                        output: "x".repeat(10_000),
                      },
                    },
                  ],
                  nextCursor: "item-page-2",
                }
              : {
                  data: [
                    { item: { id: "message", type: "agentMessage", text: "ignored" } },
                    {
                      item: {
                        id: "command-1",
                        type: "commandExecution",
                        output: "complete-output",
                      },
                    },
                  ],
                  nextCursor: null,
                }
          ) as T;
        }
        throw new Error(`unexpected ${method}`);
      },
    });

    const result = (await executor.call("codex_app__read_thread_terminal", {
      threadId: "terminal-thread",
    })) as {
      terminals: Array<{ id: string }>;
      commandItems: Array<{ id: string; output: string }>;
      terminalPage: Record<string, unknown>;
      itemPage: Record<string, unknown>;
    };
    expect(result.terminals.map(({ id }) => id)).toEqual(["terminal-2", "terminal-1"]);
    expect(result.commandItems.map(({ id }) => id)).toEqual(["command-2", "command-1"]);
    expect(result.commandItems[0]?.output).toHaveLength(10_000);
    expect(result.terminalPage).toEqual({ limit: null, returnedItems: 2, nextCursor: null });
    expect(result.itemPage).toEqual({ limit: null, returnedItems: 3, nextCursor: null });
    expect(calls.map(({ method }) => method)).toEqual([
      "thread/backgroundTerminals/list",
      "thread/items/list",
      "thread/backgroundTerminals/list",
      "thread/items/list",
    ]);
  });

  it("serializes distinct raw pages for one thread without blocking another thread", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted = false;
    let sameThreadSecondStarted = false;
    let otherThreadStarted = false;
    const executor = new CodexAppHostToolExecutor({
      request: async <T>(method: string, params: unknown): Promise<T> => {
        const request = params as { cursor?: string; threadId: string };
        if (method === "thread/read") {
          return { thread: { id: request.threadId, name: request.threadId } } as T;
        }
        if (method !== "thread/turns/list") throw new Error(`unexpected ${method}`);
        if (request.threadId === "lane-thread" && request.cursor === undefined) {
          firstStarted = true;
          await firstGate;
        } else if (request.threadId === "lane-thread") {
          sameThreadSecondStarted = true;
        } else {
          otherThreadStarted = true;
        }
        return { data: [], nextCursor: null } as T;
      },
    });

    const first = executor.call("codex_app__read_thread", { threadId: "lane-thread" });
    await vi.waitFor(() => expect(firstStarted).toBe(true));
    const sameThreadSecond = executor.call("codex_app__read_thread", {
      threadId: "lane-thread",
      cursor: "older",
    });
    const otherThread = executor.call("codex_app__read_thread", { threadId: "parallel-thread" });
    await vi.waitFor(() => expect(otherThreadStarted).toBe(true));
    expect(sameThreadSecondStarted).toBe(false);

    releaseFirst();
    await Promise.all([first, sameThreadSecond, otherThread]);
    expect(sameThreadSecondStarted).toBe(true);
  });

  it("returns an 868-item active turn fully by default and supports caller paging", async () => {
    const items = Array.from({ length: 868 }, (_, index) => {
      if (index === 7) {
        return { id: "first-user", type: "userMessage", text: "Build the requested product." };
      }
      if (index === 867) {
        return { id: "latest-answer", type: "agentMessage", text: "Latest progress." };
      }
      return {
        id: `item-${index}`,
        type: "commandExecution",
        command: `step-${index}`,
        output: `bulky-output-${index}`,
      };
    });
    const pageCalls: Array<{ offset?: number; limit?: number }> = [];
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(method: string): Promise<T> => {
          if (method === "thread/read") {
            return {
              thread: {
                id: "active-thread",
                name: "Active",
                status: { type: "active" },
                path: "C:\\rollouts\\active-thread.jsonl",
              },
            } as T;
          }
          if (method === "thread/turns/list") {
            return {
              data: [
                {
                  id: "turn-868",
                  status: "inProgress",
                  startedAt: 123,
                  items: [{ id: "summary", type: "agentMessage", text: "summary" }],
                },
              ],
              nextCursor: null,
            } as T;
          }
          throw new Error(`unexpected ${method}`);
        },
      },
      {
        rolloutItems: {
          readTurnPage: async ({ offset = 0, limit }) => {
            pageCalls.push({ offset, ...(limit === undefined ? {} : { limit }) });
            const effectiveLimit = limit ?? items.length;
            const selected = items.slice(offset, offset + effectiveLimit);
            const end = offset + selected.length;
            return {
              items: selected,
              page: {
                order: "source_order" as const,
                source: "rollout_jsonl" as const,
                limit: limit ?? null,
                callerSelectedLimit: limit !== undefined,
                offset,
                totalItems: items.length,
                returnedItems: selected.length,
                returnedBytes: 123,
                omittedItems: items.length - selected.length,
                selection: limit === undefined ? ("all" as const) : ("caller_window" as const),
                previousItemOffset: offset === 0 ? null : Math.max(0, offset - effectiveLimit),
                nextItemOffset: end < items.length ? end : null,
              },
            };
          },
        },
      },
    );

    const completeByDefault = (await executor.call("codex_app__read_thread", {
      threadId: "active-thread",
    })) as {
      page: Record<string, unknown>;
      turns: Array<{ items: unknown[]; itemsPage: Record<string, unknown> }>;
    };
    expect(completeByDefault.page).toEqual({
      order: "newest_first",
      limit: null,
      callerSelectedLimit: false,
      returnedTurns: 1,
      hasMore: false,
      nextCursor: null,
    });
    expect(completeByDefault.turns[0]?.items).toHaveLength(868);
    expect(completeByDefault.turns[0]?.itemsPage).toMatchObject({
      limit: null,
      returnedItems: 868,
      omittedItems: 0,
      selection: "all",
      nextItemOffset: null,
    });

    const bounded = (await executor.call("codex_app__read_thread", {
      threadId: "active-thread",
      includeOutputs: false,
      maxItemsPerTurn: 64,
      itemOffset: 0,
    })) as {
      thread: Record<string, unknown>;
      page: Record<string, unknown>;
      turns: Array<{
        id: string;
        status: string;
        items: Array<Record<string, unknown>>;
        itemsPage: Record<string, unknown>;
      }>;
    };

    expect(bounded.thread).toMatchObject({ id: "active-thread", title: "Active" });
    expect(bounded.page).toEqual({
      order: "newest_first",
      limit: null,
      callerSelectedLimit: false,
      returnedTurns: 1,
      hasMore: false,
      nextCursor: null,
    });
    expect(bounded.turns[0]).toMatchObject({ id: "turn-868", status: "inProgress" });
    expect(bounded.turns[0]?.items).toHaveLength(64);
    expect(bounded.turns[0]?.items[0]).toMatchObject({ id: "item-0", command: "step-0" });
    expect(bounded.turns[0]?.items[0]).not.toHaveProperty("output");
    expect(bounded.turns[0]?.items[7]).toMatchObject({
      id: "first-user",
      type: "userMessage",
      text: "Build the requested product.",
    });
    expect(bounded.turns[0]?.items.at(-1)).toMatchObject({ id: "item-63" });
    expect(bounded.turns[0]?.itemsPage).toEqual({
      order: "source_order",
      source: "rollout_jsonl",
      limit: 64,
      callerSelectedLimit: true,
      offset: 0,
      totalItems: 868,
      returnedItems: 64,
      omittedItems: 804,
      returnedBytes: 123,
      selection: "caller_window",
      previousItemOffset: null,
      nextItemOffset: 64,
      readArguments: {
        threadId: "active-thread",
        includeOutputs: false,
        maxItemsPerTurn: 64,
        itemTurnId: "turn-868",
        itemOffset: 64,
      },
    });

    const secondPage = (await executor.call("codex_app__read_thread", {
      threadId: "active-thread",
      maxItemsPerTurn: 64,
      itemTurnId: "turn-868",
      itemOffset: 64,
    })) as {
      turns: Array<{
        items: unknown[];
        itemsPage: Record<string, unknown>;
      }>;
    };
    expect(secondPage.turns[0]?.items).toHaveLength(64);
    expect(secondPage.turns[0]?.items[0]).toMatchObject({ id: "item-64" });
    expect(secondPage.turns[0]?.itemsPage).toMatchObject({
      offset: 64,
      previousItemOffset: 0,
      nextItemOffset: 128,
    });

    const full = (await executor.call("codex_app__read_thread", {
      threadId: "active-thread",
      maxItemsPerTurn: 868,
    })) as {
      turns: Array<{
        items: unknown[];
        itemsPage: Record<string, unknown>;
      }>;
    };
    expect(full.turns[0]?.items).toHaveLength(868);
    expect(full.turns[0]?.itemsPage).toEqual({
      order: "source_order",
      source: "rollout_jsonl",
      limit: 868,
      callerSelectedLimit: true,
      offset: 0,
      totalItems: 868,
      returnedItems: 868,
      returnedBytes: 123,
      omittedItems: 0,
      selection: "caller_window",
      previousItemOffset: null,
      nextItemOffset: null,
    });
    expect(pageCalls).toEqual([
      { offset: 0 },
      { offset: 0, limit: 64 },
      { offset: 64, limit: 64 },
      { offset: 0, limit: 868 },
    ]);
  });

  it("continues one large turn without applying its offset to sibling turns", async () => {
    const calls: Array<{ turnId: string; offset: number; limit?: number }> = [];
    const itemsByTurn = new Map<string, unknown[]>([
      ["turn-large", Array.from({ length: 130 }, (_, index) => ({ id: `large-${index}` }))],
      ["turn-small", [{ id: "small-0" }]],
    ]);
    const executor = new CodexAppHostToolExecutor(
      {
        request: async <T>(method: string): Promise<T> => {
          if (method === "thread/read") {
            return {
              thread: {
                id: "multi-turn-items",
                name: "Multi turn items",
                path: "C:\\rollouts\\multi-turn-items.jsonl",
              },
            } as T;
          }
          if (method === "thread/turns/list") {
            return {
              data: [
                { id: "turn-large", items: [] },
                { id: "turn-small", items: [] },
              ],
              nextCursor: null,
            } as T;
          }
          throw new Error(`unexpected ${method}`);
        },
      },
      {
        rolloutItems: {
          readTurnPage: async ({ turnId, offset = 0, limit }) => {
            calls.push({ turnId, offset, ...(limit === undefined ? {} : { limit }) });
            const all = itemsByTurn.get(turnId) ?? [];
            const effectiveLimit = limit ?? all.length;
            const items = all.slice(offset, offset + effectiveLimit);
            const end = offset + items.length;
            return {
              items,
              page: {
                order: "source_order" as const,
                source: "rollout_jsonl" as const,
                limit: limit ?? null,
                callerSelectedLimit: limit !== undefined,
                offset,
                totalItems: all.length,
                returnedItems: items.length,
                returnedBytes: 1,
                omittedItems: all.length - items.length,
                selection: limit === undefined ? ("all" as const) : ("caller_window" as const),
                previousItemOffset: offset === 0 ? null : Math.max(0, offset - effectiveLimit),
                nextItemOffset: end < all.length ? end : null,
              },
            };
          },
        },
      },
    );

    const first = (await executor.call("codex_app__read_thread", {
      threadId: "multi-turn-items",
      maxItemsPerTurn: 64,
    })) as {
      turns: Array<{
        id: string;
        items: Array<{ id: string }>;
        itemsPage: Record<string, unknown>;
      }>;
    };
    expect(first.turns[0]?.itemsPage).toMatchObject({
      nextItemOffset: 64,
      readArguments: {
        threadId: "multi-turn-items",
        maxItemsPerTurn: 64,
        itemTurnId: "turn-large",
        itemOffset: 64,
      },
    });

    const continued = (await executor.call("codex_app__read_thread", {
      threadId: "multi-turn-items",
      maxItemsPerTurn: 64,
      itemTurnId: "turn-large",
      itemOffset: 64,
    })) as { turns: Array<{ id: string; items: Array<{ id: string }> }> };
    expect(continued.turns[0]?.items[0]?.id).toBe("large-64");
    expect(continued.turns[1]?.items).toEqual([{ id: "small-0" }]);
    expect(calls.slice(-2)).toEqual([
      { turnId: "turn-large", offset: 64, limit: 64 },
      { turnId: "turn-small", offset: 0 },
    ]);
  });

  it("exhausts App Server pages by default and preserves explicit turn limits", async () => {
    const calls: unknown[] = [];
    const executor = new CodexAppHostToolExecutor({
      request: async <T>(method: string, params: unknown): Promise<T> => {
        if (method === "thread/read") {
          return { thread: { id: "multi-page-thread", name: "Multi page" } } as T;
        }
        if (method !== "thread/turns/list") throw new Error(`unexpected ${method}`);
        calls.push(params);
        const cursor = (params as { cursor?: string }).cursor;
        if (cursor === undefined) {
          return { data: [{ id: "turn-3", items: [] }], nextCursor: "page-2" } as T;
        }
        if (cursor === "page-2") {
          return { data: [{ id: "turn-2", items: [] }], nextCursor: "page-3" } as T;
        }
        return { data: [{ id: "turn-1", items: [] }], nextCursor: null } as T;
      },
    });

    const firstPage = (await executor.call("codex_app__read_thread", {
      threadId: "multi-page-thread",
    })) as { turns: Array<{ id: string }>; page: Record<string, unknown> };
    expect(firstPage.turns.map((turn) => turn.id)).toEqual(["turn-3", "turn-2", "turn-1"]);
    expect(firstPage.page).toMatchObject({
      limit: null,
      returnedTurns: 3,
      hasMore: false,
      nextCursor: null,
    });

    const secondPage = (await executor.call("codex_app__read_thread", {
      threadId: "multi-page-thread",
      cursor: "page-2",
    })) as { turns: Array<{ id: string }>; page: Record<string, unknown> };
    expect(secondPage.turns.map((turn) => turn.id)).toEqual(["turn-2", "turn-1"]);
    expect(secondPage.page).toMatchObject({ hasMore: false, nextCursor: null });

    const finalPage = (await executor.call("codex_app__read_thread", {
      threadId: "multi-page-thread",
      cursor: "page-3",
    })) as { turns: Array<{ id: string }>; page: Record<string, unknown> };
    expect(finalPage.turns.map((turn) => turn.id)).toEqual(["turn-1"]);
    expect(finalPage.page).toMatchObject({ hasMore: false, nextCursor: null });

    const limited = (await executor.call("codex_app__read_thread", {
      threadId: "multi-page-thread",
      turnLimit: 2,
    })) as { turns: Array<{ id: string }>; page: Record<string, unknown> };
    expect(limited.turns.map((turn) => turn.id)).toEqual(["turn-3", "turn-2"]);
    expect(limited.page).toMatchObject({
      limit: 2,
      returnedTurns: 2,
      nextCursor: "page-3",
    });
    const largeCallerPage = (await executor.call("codex_app__read_thread", {
      threadId: "multi-page-thread",
      turnLimit: 200,
    })) as { turns: Array<{ id: string }>; page: Record<string, unknown> };
    expect(largeCallerPage.turns.map((turn) => turn.id)).toEqual(["turn-3", "turn-2", "turn-1"]);
    expect(largeCallerPage.page).toMatchObject({
      limit: 200,
      callerSelectedLimit: true,
      returnedTurns: 3,
      nextCursor: null,
    });
    expect(calls).toHaveLength(11);
    expect(calls[0]).toMatchObject({ limit: 100, itemsView: "summary" });
    expect(calls[1]).toMatchObject({ cursor: "page-2", limit: 100 });
    expect(calls[2]).toMatchObject({ cursor: "page-3", limit: 100 });
    expect(calls[6]).toMatchObject({ limit: 2 });
    expect(calls[7]).toMatchObject({ cursor: "page-2", limit: 1 });
    expect(calls[8]).toMatchObject({ limit: 100, itemsView: "summary" });
    expect(calls[9]).toMatchObject({ cursor: "page-2", limit: 100 });
    expect(calls[10]).toMatchObject({ cursor: "page-3", limit: 100 });
  });
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
