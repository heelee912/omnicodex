import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  type ResponsesCatalogIncompatibilityError,
  type ResponsesCatalogSource,
  ResponsesNativeToolCatalog,
  ResponsesNativeToolExecutor,
} from "../src/application/responses-native-tool-catalog.js";

describe("Responses native tool catalog", () => {
  it("removes only recursively discovered tools from the same OmniCodex deployment", async () => {
    const selfServerIdentity = "a".repeat(64);
    const otherServerIdentity = "b".repeat(64);
    const source: ResponsesCatalogSource = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [],
        nestedTools: [
          {
            name: "self_tool",
            inputSchema: { type: "object", properties: {} },
            _meta: { omnicodex: { serverIdentity: selfServerIdentity } },
          },
          {
            name: "other_tool",
            inputSchema: { type: "object", properties: {} },
            _meta: { omnicodex: { serverIdentity: otherServerIdentity } },
          },
          {
            name: "native_tool",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "OmniCodex.codex__app_server__fs_readFile",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    };
    const snapshot = await new ResponsesNativeToolCatalog(source, {
      selfServerIdentity,
      selfServerName: "OmniCodex",
    }).refresh();

    expect(snapshot.tools.map(({ nativeName }) => nativeName)).toEqual([
      "native_tool",
      "other_tool",
    ]);
  });

  it("drops thread goal tools that cannot run on the ephemeral loopback thread", async () => {
    const source: ResponsesCatalogSource = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [
          { type: "function", name: "get_goal", parameters: { type: "object", properties: {} } },
        ],
        nestedTools: [
          { name: "create_goal", inputSchema: { type: "object", properties: {} } },
          { name: "get_goal", inputSchema: { type: "object", properties: {} } },
          { name: "update_goal", inputSchema: { type: "object", properties: {} } },
          { name: "goal_tracker.get_goal", inputSchema: { type: "object", properties: {} } },
          { name: "native_tool", inputSchema: { type: "object", properties: {} } },
        ],
      },
    };
    const snapshot = await new ResponsesNativeToolCatalog(source).refresh();

    expect(snapshot.tools.map(({ nativeName }) => nativeName)).toEqual([
      "goal_tracker.get_goal",
      "native_tool",
    ]);
  });

  it("preserves the complete standard MCP presentation metadata", async () => {
    const icons = [
      {
        src: "data:image/png;base64,aWNvbg==",
        mimeType: "image/png",
        sizes: ["48x48"],
        theme: "dark",
      },
    ];
    const catalog = new ResponsesNativeToolCatalog({
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [
          {
            type: "function",
            name: "presented",
            title: "Presented tool",
            description: "Exact presentation metadata",
            parameters: { type: "object", properties: {} },
            icons,
          },
        ],
      },
    });

    const descriptor = (await catalog.refresh()).tools[0];
    expect(descriptor?.tool).toMatchObject({
      name: "presented",
      title: "Presented tool",
      description: "Exact presentation metadata",
      icons,
    });
    expect(descriptor?.nativeSpec.icons).toEqual(icons);
  });

  it("preserves function schemas and reversibly wraps custom, tool_search, and unknown tools", async () => {
    const source = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 2,
        tools: [
          {
            type: "namespace",
            name: "functions",
            description: "Native host tools",
            tools: [
              {
                type: "custom",
                name: "exec",
                description: "Execute JavaScript",
                format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
                _meta: {
                  vendorKey: "preserved",
                  omnicodex: { capabilityId: "native-exec" },
                },
              },
              {
                type: "function",
                name: "wait",
                description: "Wait for a yielded execution",
                parameters: {
                  type: "object",
                  properties: { cell_id: { type: "string" } },
                  required: ["cell_id"],
                },
              },
              {
                type: "computer_use_preview",
                name: "computer_use",
                description: "Unknown future named tool",
                parameters: { type: "object", properties: { action: { type: "string" } } },
              },
            ],
          },
          {
            type: "tool_search",
            description: "Discover deferred tools",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
      },
    };
    const catalog = new ResponsesNativeToolCatalog(source);
    const snapshot = await catalog.refresh();

    expect(snapshot.sourceRequestCount).toBe(2);
    expect(snapshot.tools.map((item) => item.exposedName)).toEqual([
      "codex__functions__computer_use",
      "codex__functions__exec",
      "codex__functions__wait",
      "tool_search",
    ]);
    const exec = snapshot.tools.find((item) => item.nativeName === "exec");
    expect(exec?.kind).toBe("custom");
    expect(exec?.tool.inputSchema).toEqual({
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
      additionalProperties: false,
    });
    expect(exec?.tool._meta?.omnicodex).toMatchObject({
      capabilityId: "native-exec",
      source: "codex_responses_runtime",
      nativeName: "exec",
      nativeNamespace: "functions",
      kind: "custom",
      invokesModel: false,
      inputSchemaTransform: "mcp_freeform_input_wrapper",
    });
    expect(exec?.tool._meta).toMatchObject({ vendorKey: "preserved" });
    expect(exec?.tool._meta?.omnicodex).toHaveProperty("originalNamespaceSpec.name", "functions");
    expect(snapshot.tools.find((item) => item.nativeName === "computer_use")?.kind).toBe("unknown");
  });

  it("keeps both functions.exec and functions.wait public", async () => {
    const source = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [
              { type: "custom", name: "exec", description: "Execute JavaScript" },
              {
                type: "function",
                name: "wait",
                description: "Wait for a yielded execution",
                parameters: {
                  type: "object",
                  properties: { cell_id: { type: "string" } },
                  required: ["cell_id"],
                },
              },
            ],
          },
        ],
      },
    };

    const snapshot = await new ResponsesNativeToolCatalog(source).refresh();

    expect(snapshot.tools.map((item) => item.exposedName)).toEqual([
      "codex__functions__exec",
      "codex__functions__wait",
    ]);
    expect(snapshot.tools.some((item) => item.nativeName === "wait")).toBe(true);
  });

  it("preserves future native schemas and metadata and forwards them without a local effect gate", async () => {
    const inputSchema = {
      oneOf: [
        { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        { $ref: "#/$defs/UriInput" },
      ],
      $defs: {
        UriInput: {
          type: "object",
          properties: { uri: { type: "string" } },
          required: ["uri"],
        },
      },
    };
    const outputSchema = { oneOf: [{ type: "string" }, { type: "null" }] };
    const annotations = { readOnlyHint: true, idempotentHint: true };
    const calls: unknown[] = [];
    const source = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [
          {
            type: "future_read",
            title: "Future read",
            description: "Installed future read contract.",
            parameters: inputSchema,
            outputSchema,
            annotations,
          },
        ],
      },
      call: async (selection: unknown) => {
        calls.push(selection);
        return {
          callId: "future-call",
          outputType: "function_call_output" as const,
          executionStatus: "succeeded" as const,
          output: "ok",
          rawItem: {},
        };
      },
    };

    const descriptor = (await new ResponsesNativeToolCatalog(source).refresh()).tools[0];
    if (descriptor === undefined) throw new Error("missing future descriptor");
    expect(descriptor.modelEffect).toBe("unknown");
    expect(descriptor.tool).toMatchObject({
      title: "Future read",
      description: "Installed future read contract.",
      inputSchema,
      outputSchema,
      annotations,
    });

    const result = objectValue(
      await new ResponsesNativeToolExecutor(source).call(descriptor, { uri: "omnicodex://item" }),
    );
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(result.structuredContent).toBeUndefined();
    expect(objectValue(result._meta).omnicodex).toMatchObject({
      continuation: { callId: "future-call", executionStatus: "succeeded" },
    });
    expect(calls).toEqual([
      {
        kind: "unknown",
        name: "future_read",
        arguments: { uri: "omnicodex://item" },
      },
    ]);
  });

  it("preserves a novel named namespace member without inventing or dropping source fields", async () => {
    const rawInner = {
      name: "future_without_type",
      description: "Installed novel shape.",
      parameters: {
        oneOf: [{ type: "object", properties: { exact: { type: "string" } } }],
      },
      futureMetadata: { revision: 7 },
    };
    const rawSnapshot: unknown = {
      refreshedAtUnixMs: 1,
      requestCount: 1,
      tools: [{ type: "namespace", name: "future", tools: [rawInner] }],
    };
    const source: ResponsesCatalogSource = {
      get snapshot() {
        return rawSnapshot as ResponsesCatalogSource["snapshot"];
      },
    };

    const descriptor = (await new ResponsesNativeToolCatalog(source).refresh()).tools[0];
    expect(descriptor).toMatchObject({
      nativeName: "future_without_type",
      nativeNamespace: "future",
      kind: "unknown",
      nativeSpec: rawInner,
    });
    expect(descriptor?.tool.inputSchema).toEqual(rawInner.parameters);
    expect(descriptor?.tool._meta?.omnicodex).toHaveProperty("originalSpec", rawInner);
  });

  it("rejects a non-callable namespace member atomically with source and index details", async () => {
    let rawSnapshot: unknown = {
      refreshedAtUnixMs: 1,
      requestCount: 1,
      tools: [
        {
          type: "function",
          name: "known_good",
          parameters: { type: "object", additionalProperties: true },
        },
      ],
    };
    const source: ResponsesCatalogSource = {
      get snapshot() {
        return rawSnapshot as ResponsesCatalogSource["snapshot"];
      },
    };
    const catalog = new ResponsesNativeToolCatalog(source);
    const knownGood = await catalog.refresh();
    rawSnapshot = {
      refreshedAtUnixMs: 2,
      requestCount: 2,
      tools: [
        {
          type: "namespace",
          name: "functions",
          tools: [{ type: "function", name: "still_valid" }, null],
        },
      ],
    };

    await expect(catalog.refresh()).rejects.toMatchObject({
      code: "RESPONSES_CATALOG_INCOMPATIBLE",
      details: {
        source: "codex_responses_runtime",
        variant: "namespace_inner",
        index: 0,
        nestedIndex: 1,
        location: "tools[0].tools[1]",
        rawShape: { kind: "null" },
      },
    } satisfies Partial<ResponsesCatalogIncompatibilityError>);
    expect(catalog.snapshot).toBe(knownGood);
  });

  it("allocates unique names for colliding function, custom, freeform, unknown, and namespace tools", async () => {
    const source = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [
          {
            type: "function",
            name: "same",
            parameters: { type: "object", properties: { value: { type: "string" } } },
          },
          { type: "freeform", name: "same", format: { type: "text" } },
          {
            type: "future_native_tool",
            name: "same",
            parameters: { type: "object", properties: { action: { type: "string" } } },
          },
          {
            type: "namespace",
            name: "functions",
            _meta: { namespaceKey: "preserved" },
            tools: [
              { type: "function", name: "same", parameters: { type: "object" } },
              { type: "custom", name: "same" },
            ],
          },
        ],
      },
    };
    const snapshot = await new ResponsesNativeToolCatalog(source).refresh();
    const names = snapshot.tools.map((item) => item.exposedName);

    expect(names).toHaveLength(5);
    expect(new Set(names).size).toBe(5);
    expect(snapshot.tools.map((item) => item.kind).sort()).toEqual([
      "custom",
      "freeform",
      "function",
      "function",
      "unknown",
    ]);
    const directFunction = snapshot.tools.find(
      (item) => item.nativeNamespace === undefined && item.kind === "function",
    );
    expect(directFunction?.tool.inputSchema).toEqual({
      type: "object",
      properties: { value: { type: "string" } },
    });
    const freeform = snapshot.tools.find((item) => item.kind === "freeform");
    expect(freeform?.tool.inputSchema).toEqual({
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
      additionalProperties: false,
    });
    const unknown = snapshot.tools.find((item) => item.kind === "unknown");
    expect(unknown?.tool.inputSchema).toEqual({
      type: "object",
      properties: { action: { type: "string" } },
    });
    expect(unknown?.modelEffect).toBe("unknown");
    const namespaceCustom = snapshot.tools.find(
      (item) => item.nativeNamespace === "functions" && item.kind === "custom",
    );
    expect(namespaceCustom?.tool._meta?.omnicodex).toMatchObject({
      nativeName: "same",
      nativeNamespace: "functions",
      kind: "custom",
      originalNamespaceSpec: {
        name: "functions",
        _meta: { namespaceKey: "preserved" },
      },
    });
  });

  it("returns the exact selected identity to the model-free execution source", async () => {
    const calls: Array<{ selection: unknown; signal: AbortSignal | undefined }> = [];
    const source = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [{ type: "custom", name: "exec", description: "Execute JavaScript" }],
          },
        ],
      },
    };
    const catalog = new ResponsesNativeToolCatalog(source);
    const descriptor = (await catalog.refresh()).tools[0];
    if (descriptor === undefined) {
      throw new Error("missing descriptor");
    }
    const executor = new ResponsesNativeToolExecutor({
      call: async (selection, signal) => {
        calls.push({ selection, signal });
        return {
          callId: "call-1",
          outputType: "custom_tool_call_output",
          executionStatus: "succeeded" as const,
          output: [{ type: "input_text", text: "ok" }],
          rawItem: { type: "custom_tool_call_output", call_id: "call-1", output: "ok" },
        };
      },
    });

    const controller = new AbortController();
    const result = await executor.call(descriptor, { input: 'text("ok")' }, controller.signal);
    expect(calls).toEqual([
      {
        selection: {
          kind: "custom",
          name: "exec",
          namespace: "functions",
          arguments: 'text("ok")',
        },
        signal: controller.signal,
      },
    ]);
    expect(result).toMatchObject({ content: [{ type: "text", text: "ok" }] });
    expect(objectValue(result).structuredContent).toBeUndefined();
    expect(objectValue(objectValue(result)._meta).omnicodex).toMatchObject({
      continuation: { callId: "call-1", executionStatus: "succeeded" },
    });
  });

  it.each([
    { route: "direct", encode: false },
    { route: "direct", encode: true },
    { route: "nested", encode: false },
    { route: "nested", encode: true },
  ])(
    "preserves native isError after successful $route delivery (JSON=$encode)",
    async ({ route, encode }) => {
      const native = {
        isError: true,
        content: [{ type: "text", text: "Native browser operation failed" }],
        structuredContent: { code: "NATIVE_ERROR", completedSteps: ["opened tab"] },
        _meta: { receipt: "native-receipt" },
      };
      const output = encode ? JSON.stringify(native) : native;
      const source = {
        snapshot: {
          refreshedAtUnixMs: 1,
          requestCount: 1,
          tools:
            route === "direct"
              ? [
                  {
                    type: "function" as const,
                    name: "native_failure",
                    parameters: { type: "object" as const, properties: {} },
                  },
                ]
              : [],
          nestedTools:
            route === "nested"
              ? [
                  {
                    name: "native_failure",
                    description: "Native operation",
                    inputSchema: { type: "object" as const, properties: {} },
                  },
                ]
              : [],
        },
        call: async () => ({
          callId: "delivered-failure",
          outputType: "function_call_output" as const,
          executionStatus: "succeeded" as const,
          output,
          rawItem: { type: "function_call_output", output },
        }),
        callNested: async () => output,
      };
      const descriptor = (await new ResponsesNativeToolCatalog(source).refresh()).tools[0];
      if (descriptor === undefined) throw new Error("missing native descriptor");
      const result = objectValue(
        await new ResponsesNativeToolExecutor(source).call(descriptor, {}),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toEqual(native.content);
      expect(result.structuredContent).toEqual(native.structuredContent);
      expect(objectValue(result._meta).receipt).toBe("native-receipt");
      expect(result.output).toBeUndefined();
    },
  );

  it("maps a typed failed code-cell result to MCP isError without parsing output text", async () => {
    const source = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [{ type: "custom", name: "exec", description: "Execute JavaScript" }],
          },
        ],
      },
      call: async () => ({
        callId: "call-failed",
        outputType: "custom_tool_call_output",
        executionStatus: "failed" as const,
        output: [{ type: "text", text: "ordinary text without an error marker" }],
        rawItem: { type: "custom_tool_call_output", call_id: "call-failed" },
      }),
    };
    const descriptor = (await new ResponsesNativeToolCatalog(source).refresh()).tools[0];
    if (descriptor === undefined) throw new Error("missing exec descriptor");

    await expect(
      new ResponsesNativeToolExecutor(source).call(descriptor, { input: "void 0" }),
    ).resolves.toMatchObject({
      isError: true,
      content: [{ type: "text", text: "ordinary text without an error marker" }],
      _meta: { omnicodex: { executionStatus: "failed" } },
    });
  });

  it("calls ALL_TOOLS entries directly with original structured and freeform arguments", async () => {
    const nestedCalls: unknown[] = [];
    const source = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 3,
        tools: [],
        nestedTools: [
          {
            name: "shell_command",
            description:
              "Runs PowerShell.\n\ndeclare const tools: { shell_command(args: { command: string; }): Promise<unknown>; };",
            inputSchema: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
              additionalProperties: false,
            },
          },
          {
            name: "apply_patch",
            description:
              "This is a FREEFORM tool.\n\ndeclare const tools: { apply_patch(input: string): Promise<unknown>; };",
          },
        ],
      },
      call: async (selection: unknown, signal?: AbortSignal) => {
        nestedCalls.push({ selection, signal });
        return {
          callId: "direct",
          outputType: "function_call_output",
          executionStatus: "succeeded" as const,
          output: "direct-ok",
          rawItem: { type: "function_call_output", output: "direct-ok" },
        };
      },
      callNested: async () => {
        throw new Error("code wrapper must not run");
      },
    };
    const catalog = new ResponsesNativeToolCatalog(source);
    const snapshot = await catalog.refresh();
    expect(snapshot.tools.map((item) => [item.exposedName, item.kind])).toEqual([
      ["apply_patch", "freeform"],
      ["shell_command", "function"],
    ]);
    const shell = snapshot.tools.find((item) => item.nativeName === "shell_command");
    if (shell === undefined) {
      throw new Error("missing shell descriptor");
    }
    expect(shell.tool.inputSchema).toEqual({
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    });
    const executor = new ResponsesNativeToolExecutor(source);
    const controller = new AbortController();
    const result = await executor.call(shell, { command: "Write-Output ok" }, controller.signal);
    expect(result).toMatchObject({ content: [{ type: "text", text: "direct-ok" }] });
    expect(nestedCalls).toEqual([
      {
        selection: {
          kind: "function",
          name: "shell_command",
          arguments: { command: "Write-Output ok" },
        },
        signal: controller.signal,
      },
    ]);
    const patch = snapshot.tools.find((item) => item.nativeName === "apply_patch");
    if (patch === undefined) throw new Error("missing patch descriptor");
    await executor.call(patch, { input: "*** Begin Patch\n*** End Patch" });
    expect(nestedCalls[1]).toEqual({
      selection: {
        kind: "freeform",
        name: "apply_patch",
        arguments: "*** Begin Patch\n*** End Patch",
      },
      signal: undefined,
    });
  });

  it("keeps the native exec schema and description unchanged", async () => {
    const inputSchema = {
      type: "object",
      properties: {
        cmd: { type: "string" },
        shell: { type: "string" },
        login: { type: "boolean" },
      },
      required: ["cmd"],
      additionalProperties: false,
    };
    const nativeDescription = "Run a command in a PTY using the selected shell.";
    const source = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [],
        nestedTools: [
          {
            name: "exec_command",
            description: nativeDescription,
            inputSchema,
          },
        ],
      },
    };

    const descriptor = (await new ResponsesNativeToolCatalog(source).refresh()).tools[0];
    if (descriptor === undefined) throw new Error("missing exec_command descriptor");

    expect(descriptor.tool.inputSchema).toBe(inputSchema);
    expect(descriptor.tool.description).toBe(nativeDescription);
    expect(descriptor.tool._meta?.omnicodex).toHaveProperty(
      "originalSpec.description",
      nativeDescription,
    );
  });

  it("keeps model effects in transport metadata without changing native arguments", async () => {
    const selections: unknown[] = [];
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
                parameters: {
                  type: "object",
                  properties: { task_name: { type: "string" } },
                  required: ["task_name"],
                  additionalProperties: false,
                },
              },
              {
                type: "function",
                name: "list_agents",
                parameters: { type: "object", properties: {} },
              },
            ],
          },
        ],
      },
      call: async (selection: unknown) => {
        selections.push(selection);
        return {
          callId: "call-model",
          outputType: "function_call_output" as const,
          executionStatus: "succeeded" as const,
          output: "ok",
          rawItem: {},
        };
      },
    };
    const catalog = new ResponsesNativeToolCatalog(source);
    const snapshot = await catalog.refresh();
    const spawn = snapshot.tools.find((item) => item.nativeName === "spawn_agent");
    const list = snapshot.tools.find((item) => item.nativeName === "list_agents");
    if (spawn === undefined || list === undefined) throw new Error("missing collaboration tools");

    expect(spawn.invokesModel).toBe(true);
    expect(spawn.tool.inputSchema).toEqual({
      type: "object",
      properties: { task_name: { type: "string" } },
      required: ["task_name"],
      additionalProperties: false,
    });
    expect(spawn.tool._meta?.omnicodex).toMatchObject({ modelEffect: "model", invokesModel: true });
    expect(list.invokesModel).toBe(false);

    const executor = new ResponsesNativeToolExecutor(source);
    await executor.call(spawn, { task_name: "worker" });
    expect(selections).toEqual([
      {
        kind: "function",
        name: "spawn_agent",
        namespace: "collaboration",
        arguments: { task_name: "worker" },
      },
    ]);
  });

  it("reverses fallback wrappers without coercing freeform or unknown payloads", async () => {
    const selections: unknown[] = [];
    const source = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [
          { type: "function", name: "fallback_function" },
          { type: "freeform", name: "raw_text" },
          { type: "tool_search" },
          {
            type: "future_native_tool",
            name: "future_payload",
            _meta: { omnicodex: { modelEffect: "none", evidence: "fake-no-provider" } },
          },
        ],
      },
      call: async (selection: unknown) => {
        selections.push(selection);
        return {
          callId: "call-fallback",
          outputType: "function_call_output" as const,
          executionStatus: "succeeded" as const,
          output: "ok",
          rawItem: {},
        };
      },
    };
    const snapshot = await new ResponsesNativeToolCatalog(source).refresh();
    const executor = new ResponsesNativeToolExecutor(source);
    const fallbackFunction = snapshot.tools.find((item) => item.nativeName === "fallback_function");
    const rawText = snapshot.tools.find((item) => item.nativeName === "raw_text");
    const futurePayload = snapshot.tools.find((item) => item.nativeName === "future_payload");
    const toolSearch = snapshot.tools.find((item) => item.nativeName === "tool_search");
    if (
      fallbackFunction === undefined ||
      rawText === undefined ||
      futurePayload === undefined ||
      toolSearch === undefined
    ) {
      throw new Error("missing fallback descriptors");
    }

    expect(fallbackFunction.tool.inputSchema).toEqual({
      type: "object",
      additionalProperties: true,
    });
    expect(toolSearch.tool.inputSchema).toEqual({ type: "object", additionalProperties: true });
    expect(toolSearch.tool.inputSchema).not.toHaveProperty("properties.limit");
    expect(futurePayload.tool._meta?.omnicodex).toMatchObject({
      evidence: "fake-no-provider",
      modelEffect: "none",
      inputSchemaTransform: "mcp_unknown_payload_wrapper",
      originalSpec: {
        type: "future_native_tool",
        name: "future_payload",
        _meta: { omnicodex: { modelEffect: "none", evidence: "fake-no-provider" } },
      },
    });

    await executor.call(fallbackFunction, { exact: [1, true, null] });
    await executor.call(rawText, { input: 'line 1\n{"not":"parsed"}\n한글' });
    await executor.call(toolSearch, { query: "native tools", nested: { exact: true } });
    await executor.call(futurePayload, { payload: null });
    expect(selections).toEqual([
      {
        kind: "function",
        name: "fallback_function",
        arguments: { exact: [1, true, null] },
      },
      {
        kind: "freeform",
        name: "raw_text",
        arguments: 'line 1\n{"not":"parsed"}\n한글',
      },
      {
        kind: "tool_search",
        name: "tool_search",
        arguments: { query: "native tools", nested: { exact: true } },
      },
      {
        kind: "unknown",
        name: "future_payload",
        arguments: null,
      },
    ]);
  });

  it("converts native image and resource output into MCP content without losing raw data", async () => {
    const output = [
      { type: "output_text", text: "generated" },
      { type: "image_generation_call", result: "aW1hZ2U=" },
      { type: "generated_image", image_url: "data:image/webp;base64,d2VicA==" },
      {
        type: "resource",
        resource: {
          uri: "omnicodex://generated/image",
          mimeType: "image/png",
          blob: "aW1hZ2U=",
        },
      },
      {
        type: "resource_link",
        name: "generated image",
        uri: "omnicodex://generated/image",
        mimeType: "image/png",
      },
    ];
    const source = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [
          {
            type: "function",
            name: "image_native",
            parameters: { type: "object", properties: { prompt: { type: "string" } } },
          },
        ],
      },
      call: async () => ({
        callId: "call-image",
        outputType: "function_call_output" as const,
        executionStatus: "succeeded" as const,
        output,
        rawItem: { type: "function_call_output", output },
      }),
    };
    const descriptor = (await new ResponsesNativeToolCatalog(source).refresh()).tools[0];
    if (descriptor === undefined) throw new Error("missing image descriptor");

    const result = objectValue(
      await new ResponsesNativeToolExecutor(source).call(descriptor, { prompt: "safe" }),
    );
    expect(result.content).toEqual([
      { type: "text", text: "generated" },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      { type: "image", data: "d2VicA==", mimeType: "image/webp" },
      output[3],
      output[4],
    ]);
    expect(result.structuredContent).toBeUndefined();
    expect(result.rawItem).toBeUndefined();
    expect(result.output).toBeUndefined();
    expect(objectValue(result._meta).omnicodex).toMatchObject({
      execution: "model_free_loopback",
      nativeName: "image_native",
      invokesModel: false,
    });
  });

  it.each([undefined, "input_image", "generated_image"])(
    "preserves view_image bytes and detail from a JSON-string %s result",
    async (type) => {
      const output = JSON.stringify({
        ...(type === undefined ? {} : { type }),
        detail: "original",
        image_url: "data:application/octet-stream;base64,iVBORw0KGgo=",
      });
      const source = {
        snapshot: {
          refreshedAtUnixMs: 1,
          requestCount: 1,
          tools: [],
          nestedTools: [
            {
              name: "view_image",
              description: "View a local image.",
              inputSchema: { type: "object", properties: { path: { type: "string" } } },
            },
          ],
        },
        call: async () => ({
          callId: "image",
          outputType: "function_call_output",
          executionStatus: "succeeded" as const,
          output,
          rawItem: { type: "function_call_output", output },
        }),
        callNested: async () => {
          throw new Error("code wrapper must not run");
        },
      };
      const descriptor = (await new ResponsesNativeToolCatalog(source).refresh()).tools[0];
      if (descriptor === undefined) throw new Error("missing view_image descriptor");

      const result = objectValue(
        await new ResponsesNativeToolExecutor(source).call(descriptor, { path: "C:\\image.png" }),
      );

      expect(result.content).toEqual([
        {
          type: "image",
          mimeType: "image/png",
          data: "iVBORw0KGgo=",
          detail: "original",
          _meta: { "codex/imageDetail": "original" },
        },
      ]);
      expect(CallToolResultSchema.parse(result).content[0]).toMatchObject({
        type: "image",
        data: "iVBORw0KGgo=",
        _meta: { "codex/imageDetail": "original" },
      });
      expect(result.output).toBeUndefined();
      expect(result.structuredContent).toBeUndefined();
      expect(result.rawItem).toBeUndefined();
      expect(JSON.stringify(result).split("iVBORw0KGgo=")).toHaveLength(2);
      expect(objectValue(result._meta).omnicodex).toMatchObject({
        execution: "model_free_loopback",
        nativeName: "view_image",
        invokesModel: false,
      });
    },
  );

  it("keeps native mixed media data and failures without serializing the execution envelope", async () => {
    const output = {
      content: [
        { type: "text", text: "one image available; second failed" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
      structuredContent: { completed: 1, failed: 1 },
      _meta: { nativeObservation: "retained" },
      isError: true,
    };
    const source = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [{ type: "function", name: "mixed_media", parameters: { type: "object" } }],
      },
      call: async () => ({
        callId: "mixed",
        outputType: "function_call_output",
        executionStatus: "succeeded" as const,
        output,
        rawItem: { type: "function_call_output", output },
        rawItems: [{ type: "function_call_output", output }],
      }),
    };
    const descriptor = (await new ResponsesNativeToolCatalog(source).refresh()).tools[0];
    if (descriptor === undefined) throw new Error("missing mixed media descriptor");
    const result = objectValue(await new ResponsesNativeToolExecutor(source).call(descriptor, {}));
    expect(result.content).toEqual(output.content);
    expect(result.structuredContent).toEqual(output.structuredContent);
    expect(result._meta).toMatchObject(output._meta);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result).split("iVBORw0KGgo=")).toHaveLength(2);
    expect(result.rawItems).toBeUndefined();
  });

  it("exposes separate exec notifications without collapsing equal messages", async () => {
    const rawItems = [
      {
        type: "custom_tool_call_output",
        id: "n1",
        call_id: "exec1",
        name: "exec",
        output: "progress",
      },
      {
        type: "custom_tool_call_output",
        id: "n2",
        call_id: "exec1",
        name: "exec",
        output: "progress",
      },
      { type: "function_call_output", id: "done", call_id: "wait1", output: "finished" },
    ];
    const source = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [{ type: "function", name: "wait", parameters: { type: "object", properties: {} } }],
      },
      call: async () => ({
        callId: "wait1",
        outputType: "function_call_output" as const,
        executionStatus: "succeeded" as const,
        output: "finished",
        rawItem: { type: "function_call_output", id: "done", call_id: "wait1", output: "finished" },
        rawItems,
      }),
    };
    const descriptor = (await new ResponsesNativeToolCatalog(source).refresh()).tools[0];
    if (descriptor === undefined) throw new Error("missing wait descriptor");
    const result = objectValue(await new ResponsesNativeToolExecutor(source).call(descriptor, {}));
    expect(result.content).toEqual([
      { type: "text", text: "progress" },
      { type: "text", text: "progress" },
      { type: "text", text: "finished" },
    ]);
    // The notifications stay ordered in content; the raw transcript is not
    // repeated into model-visible structured data.
    expect(result.structuredContent).toBeUndefined();
    expect(objectValue(result._meta).omnicodex).toMatchObject({
      continuation: { callId: "wait1", executionStatus: "succeeded" },
    });
    expect(JSON.stringify(result).split("progress")).toHaveLength(3);
  });

  it("sends text output once and keeps exec/wait continuation fields", async () => {
    const output = `OMNIMARK${"x".repeat(20_000)}`;
    const source = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [{ type: "custom", name: "exec", description: "Execute JavaScript" }],
          },
        ],
      },
      call: async () => ({
        callId: "exec1",
        outputType: "custom_tool_call_output" as const,
        executionStatus: "succeeded" as const,
        output,
        rawItem: { type: "custom_tool_call_output", call_id: "exec1", output },
        rawItems: [{ type: "custom_tool_call_output", call_id: "exec1", output }],
        yieldedCellId: "cell-7",
      }),
    };
    const descriptor = (await new ResponsesNativeToolCatalog(source).refresh()).tools[0];
    if (descriptor === undefined) throw new Error("missing exec descriptor");
    const result = objectValue(
      await new ResponsesNativeToolExecutor(source).call(descriptor, { input: "void 0" }),
    );
    expect(result.content).toEqual([{ type: "text", text: output }]);
    expect(result.structuredContent).toEqual({
      callId: "exec1",
      outputType: "custom_tool_call_output",
      executionStatus: "succeeded",
      yieldedCellId: "cell-7",
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result).split("OMNIMARK")).toHaveLength(2);
  });

  it("preserves JSON text when it contains no representable MCP content", async () => {
    const output = JSON.stringify({ value: 42 });
    const source = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [
          {
            type: "function",
            name: "structured_native",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      call: async () => ({
        callId: "call-structured",
        outputType: "function_call_output" as const,
        executionStatus: "succeeded" as const,
        output,
        rawItem: { type: "function_call_output", output },
      }),
    };
    const descriptor = (await new ResponsesNativeToolCatalog(source).refresh()).tools[0];
    if (descriptor === undefined) throw new Error("missing structured descriptor");

    const result = objectValue(await new ResponsesNativeToolExecutor(source).call(descriptor, {}));

    expect(result.content).toEqual([{ type: "text", text: output }]);
  });
});

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
