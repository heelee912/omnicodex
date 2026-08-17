import { describe, expect, it } from "vitest";
import {
  AppServerMethodCatalog,
  parseAppServerMethodCatalog,
} from "../src/application/app-server-method-catalog.js";

const schema = {
  definitions: {
    ReadParams: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    TurnParams: {
      type: "object",
      properties: { threadId: { $ref: "#/definitions/ThreadId" } },
      required: ["threadId"],
    },
    ThreadId: { type: "string", minLength: 1 },
  },
  oneOf: [
    {
      title: "Fs/readFileRequest",
      description: "Read a file directly.",
      properties: {
        method: { enum: ["fs/readFile"] },
        params: { $ref: "#/definitions/ReadParams" },
      },
    },
    {
      title: "Turn/startRequest",
      properties: {
        method: { enum: ["turn/start"] },
        params: { $ref: "#/definitions/TurnParams" },
      },
    },
  ],
};

describe("AppServerMethodCatalog", () => {
  it("turns every generated request variant into a deterministic MCP tool", () => {
    const parsed = parseAppServerMethodCatalog(schema);
    expect(parsed.methods.map((item) => item.method)).toEqual(["fs/readFile", "turn/start"]);
    const read = parsed.methods[0];
    expect(read?.exposedName).toBe("codex__app_server__fs_readFile");
    expect(read?.tool.inputSchema).toMatchObject({
      $ref: "#/$defs/ReadParams",
      $defs: { ReadParams: { type: "object" } },
    });
  });

  it("requires an explicit model acknowledgement only for model-backed methods", () => {
    const parsed = parseAppServerMethodCatalog(schema);
    const turn = parsed.methods.find((item) => item.method === "turn/start");
    expect(turn?.invokesModel).toBe(true);
    expect(turn?.tool.inputSchema).toMatchObject({
      required: ["invokesModel"],
      properties: { invokesModel: { const: true } },
    });
    expect(turn?.tool.inputSchema).toHaveProperty("$defs.ThreadId.type", "string");
  });

  it("refreshes from the installed-schema source rather than a fixed census", async () => {
    let current: Record<string, unknown> = schema;
    const catalog = new AppServerMethodCatalog({
      loadClientRequestSchema: async () => current,
    });
    await catalog.refresh();
    expect(catalog.snapshot.methods).toHaveLength(2);
    current = {
      ...schema,
      oneOf: [
        ...schema.oneOf,
        {
          title: "FutureRequest",
          properties: {
            method: { enum: ["future/native"] },
            params: { type: "object", additionalProperties: true },
          },
        },
      ],
    };
    await catalog.refresh();
    expect(catalog.snapshot.methods.map((item) => item.method)).toContain("future/native");
  });
});
