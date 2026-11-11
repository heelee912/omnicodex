import { describe, expect, it } from "vitest";
import {
  type AppServerCatalogIncompatibilityError,
  AppServerMethodCatalog,
  AppServerMethodExecutor,
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
    {
      title: "Thread/startRequest",
      properties: {
        method: { enum: ["thread/start"] },
        params: {
          type: "object",
          properties: { ephemeral: { type: "boolean" } },
          additionalProperties: false,
        },
      },
    },
  ],
};

describe("AppServerMethodCatalog", () => {
  it("turns every generated request variant into a deterministic MCP tool", () => {
    const parsed = parseAppServerMethodCatalog(schema);
    expect(parsed.methods.map((item) => item.method)).toEqual([
      "fs/readFile",
      "thread/start",
      "turn/start",
    ]);
    const read = parsed.methods[0];
    expect(read?.exposedName).toBe("codex__app_server__fs_readFile");
    expect(read?.tool.inputSchema).toEqual({
      $ref: "#/definitions/ReadParams",
      definitions: {
        ReadParams: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    });
    expect(read?.tool.description).toBe("Read a file directly.");
  });

  it("classifies model-backed methods without changing their native input schema", () => {
    const parsed = parseAppServerMethodCatalog(schema);
    const turn = parsed.methods.find((item) => item.method === "turn/start");
    expect(turn?.invokesModel).toBe(true);
    expect(turn?.tool.inputSchema).toHaveProperty("$ref", "#/definitions/TurnParams");
    expect(turn?.tool.inputSchema).toHaveProperty("definitions.TurnParams.required", ["threadId"]);
    expect(turn?.tool.inputSchema).not.toHaveProperty("properties.invokesModel");
    expect(turn?.tool.inputSchema).not.toHaveProperty("properties.allowPersistentStateMutation");
    expect(turn?.tool.inputSchema).toHaveProperty("definitions.ThreadId.type", "string");
  });

  it("adapts optional singleton-null params to an empty tool input and omits params on the wire", async () => {
    const parsed = parseAppServerMethodCatalog({
      oneOf: [
        {
          title: "Account/logoutRequest",
          type: "object",
          properties: {
            method: { enum: ["account/logout"] },
            params: { type: "null" },
          },
          required: ["method"],
        },
      ],
    });
    const descriptor = parsed.methods[0];
    expect(descriptor).toBeDefined();
    if (descriptor === undefined) throw new Error("logout descriptor was not discovered");
    expect(descriptor.requestParamsMode).toBe("omit");
    expect(descriptor.tool.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(descriptor.tool._meta?.omnicodex).toMatchObject({
      requestParamsMode: "omit",
      originalInputSchema: { type: "null" },
    });

    const calls: Array<{ method: string; params: unknown }> = [];
    const executor = new AppServerMethodExecutor({
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        return {} as T;
      },
    });
    await executor.call(descriptor, {});
    expect(calls).toEqual([{ method: "account/logout", params: undefined }]);
    await expect(executor.call(descriptor, { unexpected: true })).rejects.toThrow(
      "does not accept arguments",
    );
  });

  it("restores required singleton-null params as explicit null", async () => {
    const parsed = parseAppServerMethodCatalog({
      oneOf: [
        {
          type: "object",
          properties: {
            method: { const: "future/nullParams" },
            params: { const: null },
          },
          required: ["method", "params"],
        },
      ],
    });
    const descriptor = parsed.methods[0];
    expect(descriptor).toBeDefined();
    if (descriptor === undefined) throw new Error("null-params descriptor was not discovered");
    expect(descriptor.requestParamsMode).toBe("null");

    const calls: unknown[] = [];
    const executor = new AppServerMethodExecutor({
      request: async <T>(_method: string, params?: unknown): Promise<T> => {
        calls.push(params);
        return {} as T;
      },
    });
    await executor.call(descriptor, {});
    expect(calls).toEqual([null]);
  });

  it("preserves installed titles, descriptions, schemas, annotations, and metadata", () => {
    const directSchema = {
      oneOf: [
        {
          description: "Installed write contract.",
          properties: {
            method: { enum: ["fs/writeFile"] },
            params: {
              type: "object",
              properties: { path: { type: "string" }, contents: { type: "string" } },
              required: ["path", "contents"],
            },
          },
        },
        {
          title: "Installed command title",
          description: "Installed command contract.",
          annotations: { readOnlyHint: false, openWorldHint: true },
          _meta: { vendor: { revision: "native" }, omnicodex: { nativeField: "retained" } },
          properties: {
            method: { enum: ["command/exec"] },
            params: {
              title: "CommandExecParams",
              description: "Run a standalone command in the server sandbox.",
              $comment: "Installed comment",
              examples: [{ command: ["program.exe", "--version"] }],
              type: "object",
              properties: {
                command: {
                  title: "Command",
                  description: "Generated implementation prose.",
                  type: "array",
                  items: { type: "string" },
                },
                sandboxPolicy: {
                  description: "DangerFullAccess selects a sandbox policy.",
                  enum: ["DangerFullAccess", "ReadOnly"],
                },
              },
              required: ["command"],
            },
          },
        },
      ],
    };
    const parsed = parseAppServerMethodCatalog(directSchema);
    const write = parsed.methods.find((item) => item.method === "fs/writeFile");
    const command = parsed.methods.find((item) => item.method === "command/exec");

    expect(write?.tool.description).toBe("Installed write contract.");
    expect(command?.tool.title).toBe("Installed command title");
    expect(command?.tool.description).toBe("Installed command contract.");
    expect(command?.tool.inputSchema).toEqual(directSchema.oneOf[1]?.properties.params);
    expect(command?.tool.annotations).toEqual({ readOnlyHint: false, openWorldHint: true });
    expect(command?.tool._meta).toMatchObject({
      vendor: { revision: "native" },
      omnicodex: { nativeField: "retained" },
    });
    expect(command?.tool._meta?.omnicodex).not.toHaveProperty("executionBoundary");
    expect(command?.invokesModel).toBe(false);
  });

  it("supplies actionable native descriptions when installed file and command variants omit them", () => {
    const parsed = parseAppServerMethodCatalog({
      oneOf: [
        {
          properties: {
            method: { const: "fs/writeFile" },
            params: {
              type: "object",
              properties: { path: { type: "string" }, contents: { type: "string" } },
              required: ["path", "contents"],
            },
          },
        },
        {
          properties: {
            method: { const: "command/exec" },
            params: {
              type: "object",
              properties: { command: { type: "array", items: { type: "string" } } },
              required: ["command"],
            },
          },
        },
      ],
    });
    const write = parsed.methods.find((item) => item.method === "fs/writeFile");
    const command = parsed.methods.find((item) => item.method === "command/exec");

    expect(write?.tool.title).toBe("Write a file");
    expect(write?.tool.description).toContain("completed filesystem result");
    expect(command?.tool.title).toBe("Run a program");
    expect(command?.tool.description).toContain("stdout, stderr, exit status");
    expect(command?.tool.description).toContain("executable in command[0]");
    expect(command?.tool.description).toContain("powershell.exe with -Command");
    expect(command?.tool.description).toContain("cmd.exe with /c");
  });

  it("omits blank optional model overrides at the native App Server boundary", async () => {
    const descriptor = parseAppServerMethodCatalog({
      definitions: {
        TurnParams: {
          type: "object",
          properties: {
            threadId: { type: "string" },
            input: { type: "array" },
            model: { type: ["string", "null"] },
            modelProvider: { type: ["string", "null"] },
          },
          required: ["threadId", "input"],
        },
      },
      oneOf: [
        {
          properties: {
            method: { const: "turn/start" },
            params: { $ref: "#/definitions/TurnParams" },
          },
          required: ["method", "params"],
        },
      ],
    }).methods[0];
    if (descriptor === undefined) throw new Error("turn/start descriptor missing");
    const calls: unknown[] = [];
    const executor = new AppServerMethodExecutor({
      request: async <T>(_method: string, params?: unknown): Promise<T> => {
        calls.push(params);
        return { turn: { id: "turn-inherited-model" } } as T;
      },
    });

    await executor.call(descriptor, {
      threadId: "thread-inherited-model",
      input: [],
      model: "",
      modelProvider: "   ",
    });

    expect(calls).toEqual([{ threadId: "thread-inherited-model", input: [] }]);
    expect(descriptor.tool.description).toContain("blank string overrides are removed");
  });

  it("forwards native thread creation without adding a title or a second request", async () => {
    const descriptor = parseAppServerMethodCatalog(schema).methods.find(
      (item) => item.method === "thread/start",
    );
    expect(descriptor?.tool.inputSchema).toMatchObject({
      properties: {
        ephemeral: { type: "boolean" },
      },
    });
    expect(descriptor?.tool.inputSchema).not.toHaveProperty("properties.title");
    const calls: Array<{ method: string; params: unknown }> = [];
    const executor = new AppServerMethodExecutor({
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "thread/start") return { thread: { id: "thread-direct" } } as T;
        throw new Error(`unexpected method ${method}`);
      },
    });
    if (descriptor === undefined) throw new Error("thread/start descriptor missing");

    await expect(executor.call(descriptor, { ephemeral: false })).resolves.toEqual({
      thread: { id: "thread-direct" },
    });
    expect(calls).toEqual([{ method: "thread/start", params: { ephemeral: false } }]);
    expect(calls.some((call) => call.method === "turn/start")).toBe(false);
  });

  it("returns the native turn/start response without waiting for completion", async () => {
    const descriptor = parseAppServerMethodCatalog(schema).methods.find(
      (item) => item.method === "turn/start",
    );
    const listeners = new Set<(message: Record<string, unknown>) => void>();
    const executor = new AppServerMethodExecutor({
      subscribeNotifications: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      request: async <T>(method: string): Promise<T> => {
        expect(method).toBe("turn/start");
        return { turn: { id: "turn-direct" } } as T;
      },
    });
    if (descriptor === undefined) throw new Error("turn/start descriptor missing");

    await expect(executor.call(descriptor, { threadId: "thread-direct" })).resolves.toEqual({
      turn: { id: "turn-direct" },
    });
    expect(listeners.size).toBe(0);
  });

  it("refreshes from the installed-schema source rather than a fixed census", async () => {
    let current: Record<string, unknown> = schema;
    const catalog = new AppServerMethodCatalog({
      loadClientRequestSchema: async () => current,
    });
    await catalog.refresh();
    expect(catalog.snapshot.methods).toHaveLength(3);
    current = {
      ...schema,
      oneOf: [
        ...schema.oneOf,
        {
          title: "FutureRequest",
          properties: {
            method: { const: "future/native" },
            params: { type: "object", additionalProperties: true },
          },
        },
      ],
    };
    await catalog.refresh();
    expect(catalog.snapshot.methods.map((item) => item.method)).toContain("future/native");
  });

  it("allocates stable unique names for every full-set sanitization collision", () => {
    const collisionVariants = [
      {
        properties: {
          method: { const: "foo/bar" },
          params: { type: "object", properties: { slash: { type: "boolean" } } },
        },
      },
      {
        properties: {
          method: { const: "foo_bar" },
          params: { type: "object", properties: { underscore: { type: "boolean" } } },
        },
      },
    ];
    const forward = parseAppServerMethodCatalog({ oneOf: collisionVariants });
    const reversed = parseAppServerMethodCatalog({ oneOf: [...collisionVariants].reverse() });
    const namesByMethod = (methods: typeof forward.methods) =>
      Object.fromEntries(methods.map(({ method, exposedName }) => [method, exposedName]));

    expect(namesByMethod(forward.methods)).toEqual(namesByMethod(reversed.methods));
    expect(new Set(forward.methods.map(({ exposedName }) => exposedName))).toHaveProperty(
      "size",
      2,
    );
    for (const { exposedName } of forward.methods) {
      expect(exposedName).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
      expect(exposedName).toMatch(/__[a-f0-9]{64}$/);
    }
  });

  it("rejects an incompatible request variant atomically with its exact source shape", async () => {
    let current: Record<string, unknown> = schema;
    const catalog = new AppServerMethodCatalog({
      loadClientRequestSchema: async () => current,
    });
    const knownGood = await catalog.refresh();
    current = {
      definitions: {
        Valid: {
          properties: {
            method: { const: "valid/read" },
            params: { type: "object", additionalProperties: true },
          },
        },
      },
      oneOf: [{ $ref: "#/definitions/Valid" }, { $ref: "#/definitions/Missing" }],
    };

    await expect(catalog.refresh()).rejects.toMatchObject({
      code: "APP_SERVER_CATALOG_INCOMPATIBLE",
      details: {
        source: "codex_app_server_schema",
        variant: "oneOf",
        index: 1,
        variantIndex: 1,
        location: "schema.oneOf[1].$ref",
        rawShape: { kind: "string" },
      },
    } satisfies Partial<AppServerCatalogIncompatibilityError>);
    expect(catalog.snapshot).toBe(knownGood);
  });

  it("resolves a top-level local ref and expands every callable enum member", () => {
    const parsed = parseAppServerMethodCatalog({
      $ref: "#/$defs/ClientRequest",
      $defs: {
        ClientRequest: {
          oneOf: [
            {
              properties: {
                method: { enum: ["future/one", "future/two"] },
                params: { $ref: "#/$defs/FutureParams" },
              },
            },
          ],
        },
        FutureParams: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    });

    expect(parsed.methods.map(({ method }) => method)).toEqual(["future/one", "future/two"]);
    expect(parsed.methods[0]?.tool.inputSchema).toHaveProperty("$defs.FutureParams.type", "object");
  });

  it("preserves a top-level ref to a union and forwards native arguments unchanged", async () => {
    const unionSchema = {
      definitions: {
        LoginParams: {
          oneOf: [
            {
              type: "object",
              properties: { type: { type: "string", enum: ["chatgpt"] } },
              required: ["type"],
            },
            {
              type: "object",
              properties: { type: { type: "string", enum: ["apiKey"] } },
              required: ["type"],
            },
          ],
        },
      },
      oneOf: [
        {
          properties: {
            method: { enum: ["account/login/start"] },
            params: { $ref: "#/definitions/LoginParams" },
          },
        },
      ],
    };
    const descriptor = parseAppServerMethodCatalog(unionSchema).methods[0];
    expect(descriptor?.tool.inputSchema).toEqual({
      $ref: "#/definitions/LoginParams",
      definitions: {
        LoginParams: {
          oneOf: [
            {
              type: "object",
              properties: { type: { type: "string", enum: ["chatgpt"] } },
              required: ["type"],
            },
            {
              type: "object",
              properties: { type: { type: "string", enum: ["apiKey"] } },
              required: ["type"],
            },
          ],
        },
      },
    });
    expect(descriptor?.tool._meta?.omnicodex).not.toHaveProperty("inputSchemaTransform");

    const calls: Array<{ method: string; params: unknown }> = [];
    const executor = new AppServerMethodExecutor({
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        return {} as T;
      },
    });
    expect(descriptor).toBeDefined();
    if (descriptor === undefined) throw new Error("login descriptor was not discovered");
    await executor.call(descriptor, { type: "chatgpt" });
    expect(calls).toEqual([{ method: "account/login/start", params: { type: "chatgpt" } }]);
  });

  it("forwards exact caller boundaries and retains mutating App Server settlement", async () => {
    const parsed = parseAppServerMethodCatalog({
      oneOf: [
        {
          properties: {
            method: { const: "fs/readFile" },
            params: { type: "object", additionalProperties: true },
          },
        },
        {
          properties: {
            method: { const: "command/exec" },
            params: { type: "object", additionalProperties: true },
          },
        },
      ],
    });
    const read = parsed.methods.find(({ method }) => method === "fs/readFile");
    const command = parsed.methods.find(({ method }) => method === "command/exec");
    if (read === undefined || command === undefined) throw new Error("native descriptors missing");
    const calls: Array<{ method: string; params: unknown; options: unknown }> = [];
    const nativeResult = {
      stdout: `stdout-${"x".repeat(200_000)}`,
      stderr: `stderr-${"y".repeat(200_000)}`,
      events: [{ sequence: 1 }, { sequence: 2 }],
    };
    const executor = new AppServerMethodExecutor({
      request: async <T>(method: string, params: unknown, options?: unknown): Promise<T> => {
        calls.push({ method, params, options });
        return nativeResult as T;
      },
    });
    const controller = new AbortController();
    const deadlineUnixMs = Date.now() + 3_000_000_000;
    const boundary = {
      timeoutMs: 3_000_000_000,
      deadlineUnixMs,
      signal: controller.signal,
    };

    await expect(executor.call(read, { path: "C:\\large.txt" }, boundary)).resolves.toBe(
      nativeResult,
    );
    await expect(executor.call(command, { command: ["long-task"] }, boundary)).resolves.toBe(
      nativeResult,
    );

    expect(calls).toEqual([
      {
        method: "fs/readFile",
        params: { path: "C:\\large.txt" },
        options: boundary,
      },
      {
        method: "command/exec",
        params: { command: ["long-task"] },
        options: { ...boundary, awaitResponseAfterCancellation: true },
      },
    ]);
    expect(nativeResult.stdout).toHaveLength(200_007);
    expect(nativeResult.stderr).toHaveLength(200_007);
  });
});
