import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  ResponsesNativeToolCatalog,
  ResponsesNativeToolExecutor,
} from "../src/application/responses-native-tool-catalog.js";
import { createOmniCodexMcpServer } from "../src/infrastructure/mcp/omnicodex-mcp-server.js";
import { OwnerBoundResourceStore } from "../src/infrastructure/mcp/owner-bound-resource-store.js";
import { protectOversizedResult } from "../src/infrastructure/mcp/protected-result-mapper.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("native tool search", () => {
  it("keeps the execution route and exact oversized descriptor inline without instruction text", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-search-result-"));
    temporaryDirectories.push(dataDirectory);
    const resources = new OwnerBoundResourceStore({ dataDirectory });
    const owner = {
      issuer: "https://owner.example/",
      subject: "auth0|owner",
      clientId: "client",
      resource: "https://owner.example/mcp/full",
    };
    const source = {
      snapshot: {
        refreshedAtUnixMs: 1,
        requestCount: 1,
        tools: [
          {
            type: "custom",
            name: "oversized_exact_tool",
            description: `Exact descriptor ${"x".repeat(300 * 1_024)}`,
          },
        ],
      },
      call: async () => ({
        callId: "oversized-exact",
        outputType: "custom_tool_call_output",
        executionStatus: "succeeded" as const,
        output: "ok",
        rawItem: {},
      }),
    };
    const responsesToolCatalog = new ResponsesNativeToolCatalog(source);
    const handle = createOmniCodexMcpServer({
      appServer: {
        request: async <T>(method: string): Promise<T> => {
          if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
          throw new Error(`unexpected method ${method}`);
        },
      },
      responsesToolCatalog,
      responsesToolExecutor: new ResponsesNativeToolExecutor(source),
      actionCatalogByteBudget: 64 * 1_024,
      protectResult: (result) =>
        protectOversizedResult(
          result,
          {
            owner,
            sessionId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          },
          resources,
        ),
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "protected-search-client", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const catalog = await client.listTools();
      expect(
        catalog.tools.find((tool) => tool.name === "search_native_tools")?.outputSchema,
      ).toBeDefined();
      const result = await client.callTool({
        name: "search_native_tools",
        arguments: { query: "oversized_exact_tool" },
      });
      const content = result.content as CallToolResult["content"];

      expect(content).toHaveLength(2);
      expect(content[0]).toMatchObject({
        type: "text",
        text: expect.stringMatching(
          /^OMNICODEX_NATIVE_SEARCH_EXECUTION_V1:.*"executeWith":"call_native_tool"/u,
        ),
      });
      expect(JSON.stringify(result)).not.toContain("OMNICODEX_PROTECTED_RESULT_V1:");
      if (content[0]?.type !== "text") throw new Error("Expected inline native route");
      const route = JSON.parse(
        content[0].text.slice("OMNICODEX_NATIVE_SEARCH_EXECUTION_V1:".length),
      ) as { executeWith: string; executeArguments: unknown; instruction?: string };
      expect(route.executeWith).toBe("call_native_tool");
      expect(route.executeArguments).toBeDefined();
      expect(route.instruction).toBeUndefined();
      const exact = result.structuredContent as unknown as {
        tools: Array<{ nativeTool: { description: string }; executeWith: string }>;
      };
      expect(exact.tools[0]?.executeWith).toBe("call_native_tool");
      expect(exact.tools[0]?.nativeTool.description).toHaveLength(
        "Exact descriptor ".length + 300 * 1_024,
      );
    } finally {
      await client.close();
      await handle.server.close();
    }
  });
});
