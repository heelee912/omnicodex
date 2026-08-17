import { describe, expect, it } from "vitest";
import {
  assertAppServerModelPolicy,
  isModelInvokingAppServerMethod,
  NativeToolCatalog,
  NativeToolExecutor,
} from "../src/application/native-tool-catalog.js";

describe("NativeToolCatalog", () => {
  it("preserves safe unique names and namespaces collisions deterministically", async () => {
    const client = {
      request: async <T>(method: string, _params: unknown): Promise<T> => {
        if (method !== "mcpServerStatus/list") {
          throw new Error(`unexpected method ${method}`);
        }
        return {
          data: [
            {
              name: "z-server",
              tools: {
                "same.tool": { name: "same.tool", inputSchema: { type: "object" } },
                "bad name": { name: "bad name", inputSchema: { type: "object" } },
              },
            },
            {
              name: "a-server",
              tools: {
                "same.tool": { name: "same.tool", inputSchema: { type: "object" } },
                search_native_tools: {
                  name: "search_native_tools",
                  inputSchema: { type: "object" },
                },
              },
            },
          ],
          nextCursor: null,
        } as T;
      },
    };
    const catalog = new NativeToolCatalog(client, {
      reservedNames: ["search_native_tools"],
    });
    const snapshot = await catalog.refresh();

    expect(snapshot.servers).toEqual(["a-server", "z-server"]);
    expect(snapshot.tools.map((tool) => tool.exposedName)).toEqual([
      "codex__a-server__same.tool",
      "codex__a-server__search_native_tools",
      "codex__z-server__bad_name",
      "codex__z-server__same.tool",
    ]);
    expect(snapshot.tools[0]?.tool._meta).toMatchObject({
      omnicodex: {
        server: "a-server",
        originalName: "same.tool",
      },
    });
  });

  it("keeps non-object output schemas in metadata without emitting invalid MCP tools", async () => {
    const originalOutputSchema = { type: ["object", "null"], properties: { value: true } };
    const client = {
      request: async <T>(): Promise<T> =>
        ({
          data: [
            {
              name: "schema-server",
              tools: {
                flexible: {
                  name: "flexible",
                  inputSchema: { type: "object", properties: {} },
                  outputSchema: originalOutputSchema,
                },
              },
            },
          ],
          nextCursor: null,
        }) as T,
    };
    const catalog = new NativeToolCatalog(client);
    const snapshot = await catalog.refresh();
    const tool = snapshot.tools[0]?.tool;

    expect(tool?.outputSchema).toBeUndefined();
    expect(tool?._meta).toMatchObject({
      omnicodex: {
        originalOutputSchema,
        outputSchemaTransform: "omitted_invalid_mcp_object_schema",
      },
    });
  });

  it("uses the fixed arguments wrapper for an invalid downstream input schema", async () => {
    const originalInputSchema = { type: "string", pattern: ".+" };
    const catalog = new NativeToolCatalog({
      request: async <T>(): Promise<T> =>
        ({
          data: [
            {
              name: "schema-server",
              tools: {
                flexible: { name: "flexible", inputSchema: originalInputSchema },
              },
            },
          ],
          nextCursor: null,
        }) as T,
    });

    const tool = (await catalog.refresh()).tools[0]?.tool;
    expect(tool?.inputSchema).toEqual({
      type: "object",
      properties: { arguments: { type: "object", additionalProperties: true } },
      required: ["arguments"],
      additionalProperties: false,
    });
    expect(tool?._meta?.omnicodex).toMatchObject({
      originalInputSchema,
      inputSchemaTransform: "mcp_arguments_wrapper",
      inputSchemaValidationError: 'Native input schema type was not "object"',
    });
  });

  it("uses the runtime-supplied name and retains its original OmniCodex metadata", async () => {
    const catalog = new NativeToolCatalog({
      request: async <T>(): Promise<T> =>
        ({
          data: [
            {
              name: "native-server",
              tools: {
                dictionary_alias: {
                  name: "native.exact",
                  inputSchema: { type: "object" },
                  _meta: { omnicodex: { runtimeEvidence: "preserve-me" } },
                },
              },
            },
          ],
          nextCursor: null,
        }) as T,
    });

    const descriptor = (await catalog.refresh()).tools[0];
    expect(descriptor?.originalName).toBe("native.exact");
    expect(descriptor?.exposedName).toBe("native.exact");
    expect(descriptor?.tool._meta?.omnicodex).toMatchObject({
      runtimeEvidence: "preserve-me",
      nativeOmnicodex: { runtimeEvidence: "preserve-me" },
      originalName: "native.exact",
    });
  });
});

describe("NativeToolExecutor", () => {
  it("uses one ephemeral non-model thread when the caller omits a thread", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "thread/start") {
          return { thread: { id: "urn:uuid:ephemeral" } } as T;
        }
        return { content: [{ type: "text", text: "READY" }] } as T;
      },
    };
    const executor = new NativeToolExecutor(client);

    await executor.call("server", "tool", { value: 1 });
    await executor.call("server", "tool", { value: 2 });

    expect(calls.map((call) => call.method)).toEqual([
      "thread/start",
      "mcpServer/tool/call",
      "mcpServer/tool/call",
    ]);
    expect(calls[0]?.params).toMatchObject({
      approvalPolicy: "never",
      cwd: null,
      ephemeral: true,
      model: null,
      modelProvider: null,
      sandbox: "danger-full-access",
    });
    expect(calls[1]?.params).toMatchObject({
      server: "server",
      threadId: "urn:uuid:ephemeral",
      tool: "tool",
    });
  });
});

describe("App Server model policy", () => {
  it("requires an explicit model opt-in for model-backed methods", () => {
    expect(isModelInvokingAppServerMethod("turn/start")).toBe(true);
    expect(() => assertAppServerModelPolicy("turn/start")).toThrow(/invokesModel=true/);
    expect(() => assertAppServerModelPolicy("turn/start", { invokesModel: true })).not.toThrow();
    expect(() => assertAppServerModelPolicy("thread/list")).not.toThrow();
  });
});
