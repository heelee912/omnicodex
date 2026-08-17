import { describe, expect, it } from "vitest";
import {
  ResponsesNativeToolCatalog,
  ResponsesNativeToolExecutor,
} from "../src/application/responses-native-tool-catalog.js";

describe("Responses native tool catalog", () => {
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
      properties: { payload: true, contentType: { type: "string" } },
      required: ["payload"],
      additionalProperties: false,
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
    const calls: unknown[] = [];
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
      call: async (selection) => {
        calls.push(selection);
        return {
          callId: "call-1",
          outputType: "custom_tool_call_output",
          output: [{ type: "input_text", text: "ok" }],
          rawItem: { type: "custom_tool_call_output", call_id: "call-1", output: "ok" },
        };
      },
    });

    const result = await executor.call(descriptor, { input: 'text("ok")' });
    expect(calls).toEqual([
      {
        kind: "custom",
        name: "exec",
        namespace: "functions",
        arguments: 'text("ok")',
      },
    ]);
    expect(result).toMatchObject({
      outputType: "custom_tool_call_output",
      callId: "call-1",
    });
  });

  it("exposes direct ALL_TOOLS entries and routes them through functions.exec", async () => {
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
          },
          {
            name: "apply_patch",
            description:
              "This is a FREEFORM tool.\n\ndeclare const tools: { apply_patch(input: string): Promise<unknown>; };",
          },
        ],
      },
      call: async () => {
        throw new Error("direct Responses call should not be used");
      },
      callNested: async (name: string, args: unknown, freeform: boolean) => {
        nestedCalls.push({ name, args, freeform });
        return { content: [{ type: "text", text: "nested-ok" }] };
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
    const executor = new ResponsesNativeToolExecutor(source);
    const result = await executor.call(shell, { command: "Write-Output ok" });
    expect(result).toEqual({ content: [{ type: "text", text: "nested-ok" }] });
    expect(nestedCalls).toEqual([
      {
        name: "shell_command",
        args: { command: "Write-Output ok" },
        freeform: false,
      },
    ]);
  });

  it("requires explicit acknowledgement for native collaboration calls that invoke a model", async () => {
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
    expect(spawn.tool.inputSchema).toMatchObject({
      required: ["task_name", "invokesModel"],
      properties: { invokesModel: { type: "boolean", const: true } },
    });
    expect(list.invokesModel).toBe(false);

    const executor = new ResponsesNativeToolExecutor(source);
    await expect(executor.call(spawn, { task_name: "worker" })).rejects.toThrow(
      "requires invokesModel=true",
    );
    await executor.call(spawn, { task_name: "worker", invokesModel: true });
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
    if (fallbackFunction === undefined || rawText === undefined || futurePayload === undefined) {
      throw new Error("missing fallback descriptors");
    }

    expect(fallbackFunction.tool.inputSchema).toEqual({
      type: "object",
      properties: { arguments: { type: "object", additionalProperties: true } },
      required: ["arguments"],
      additionalProperties: false,
    });
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

    await executor.call(fallbackFunction, { arguments: { exact: [1, true, null] } });
    await executor.call(rawText, { input: 'line 1\n{"not":"parsed"}\n한글' });
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
    expect(objectValue(result.structuredContent).output).toEqual(output);
    expect(objectValue(result._meta).omnicodex).toMatchObject({
      execution: "model_free_loopback",
      nativeName: "image_native",
      invokesModel: false,
    });
  });
});

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
