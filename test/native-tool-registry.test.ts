import { describe, expect, it } from "vitest";
import { NativeToolCatalog } from "../src/application/native-tool-catalog.js";
import { buildNativeToolRegistry } from "../src/application/native-tool-registry.js";
import { ResponsesNativeToolCatalog } from "../src/application/responses-native-tool-catalog.js";

describe("Native tool registry", () => {
  it("builds one collision-free full surface while preserving schemas and OmniCodex metadata", async () => {
    const downstreamCatalog = new NativeToolCatalog({
      request: async <T>(): Promise<T> =>
        ({
          data: [
            {
              name: "demo-server",
              tools: {
                shared: {
                  name: "shared",
                  description: "Downstream shared function",
                  inputSchema: {
                    type: "object",
                    properties: { downstream: { type: "boolean" } },
                    required: ["downstream"],
                  },
                  _meta: { vendor: "downstream", omnicodex: { downstreamId: "d-1" } },
                },
              },
            },
          ],
          nextCursor: null,
        }) as T,
    });
    const responsesCatalog = new ResponsesNativeToolCatalog({
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
            _meta: { vendor: "responses", omnicodex: { responseId: "r-1" } },
          },
          { type: "freeform", name: "patch", description: "Patch text" },
          {
            type: "future_native_tool",
            name: "future",
            parameters: { type: "object", properties: { action: { type: "string" } } },
          },
          {
            type: "namespace",
            name: "functions",
            tools: [
              { type: "custom", name: "exec", description: "Execute text" },
              { type: "function", name: "wait", parameters: { type: "object" } },
            ],
          },
        ],
      },
    });
    const registry = buildNativeToolRegistry({
      reservedNames: ["search_native_tools", "call_native_tool"],
      downstreamTools: (await downstreamCatalog.refresh()).tools,
      responsesTools: (await responsesCatalog.refresh()).tools,
    });
    const names = registry.tools.map((tool) => tool.name);

    expect(names).toHaveLength(6);
    expect(new Set(names).size).toBe(6);
    expect(names).not.toContain("shared");
    const shared = registry.entries.filter((entry) => entry.originalName === "shared");
    expect(shared).toHaveLength(2);
    expect(
      shared.every((entry) => /^codex__b32_[a-z2-7]*__b32_[a-z2-7]+$/.test(entry.exposedName)),
    ).toBe(true);
    expect(
      shared.every(
        (entry) => objectValue(entry.tool._meta?.omnicodex).nameCollisionResolved === true,
      ),
    ).toBe(true);
    const responseShared = shared.find((entry) => entry.route === "responses");
    expect(responseShared?.tool.inputSchema).toEqual({
      type: "object",
      properties: { response: { type: "string" } },
      required: ["response"],
    });
    expect(responseShared?.tool._meta).toMatchObject({
      vendor: "responses",
      omnicodex: {
        responseId: "r-1",
        nativeName: "shared",
        kind: "function",
        route: "loopback_responses",
        modelEffect: "none",
        catalogRevision: registry.revision,
      },
    });
    const downstreamShared = shared.find((entry) => entry.route === "downstream");
    expect(downstreamShared?.tool.inputSchema).toEqual({
      type: "object",
      properties: { downstream: { type: "boolean" } },
      required: ["downstream"],
    });
    expect(downstreamShared?.tool._meta).toMatchObject({
      vendor: "downstream",
      omnicodex: { downstreamId: "d-1", originalName: "shared" },
    });
    const toolIds = registry.entries.map(
      (entry) => objectValue(entry.tool._meta?.omnicodex).toolId,
    );
    expect(
      toolIds.every((toolId) => typeof toolId === "string" && /^[a-z2-7]+$/.test(toolId)),
    ).toBe(true);
    expect(new Set(toolIds).size).toBe(registry.entries.length);
    expect(
      registry.entries.find((entry) => entry.originalName === "patch")?.tool._meta,
    ).toMatchObject({
      omnicodex: {
        inputSchemaTransform: "mcp_freeform_input_wrapper",
        originalSpec: { type: "freeform", name: "patch" },
      },
    });
  });
});

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
