import { describe, expect, it } from "vitest";
import {
  assertAppServerModelPolicy,
  isModelInvokingAppServerMethod,
  NativeToolCatalog,
  NativeToolCatalogIncompatibilityError,
  NativeToolExecutor,
} from "../src/application/native-tool-catalog.js";
import { omniCodexServerIdentityFromMetadata } from "../src/application/native-tool-server-identity.js";

describe("NativeToolCatalog", () => {
  it("reuses a confirmed inventory for unchanged refreshes and checks changed inventories twice", async () => {
    let calls = 0;
    let description = "Initial callable contract.";
    const catalog = new NativeToolCatalog({
      request: async <T>() => {
        calls += 1;
        return {
          data: [
            {
              name: "native",
              tools: { scan: { name: "scan", description, inputSchema: { type: "object" } } },
            },
          ],
          nextCursor: null,
        } as T;
      },
    });

    await catalog.refresh();
    expect(calls).toBe(2);
    await catalog.refresh();
    expect(calls).toBe(3);

    description = "Updated callable contract.";
    const updated = await catalog.refresh();
    expect(calls).toBe(5);
    expect(updated.tools[0]?.tool.description).toBe(description);
  });

  it("converges when presentation metadata changes while retaining the latest native descriptor", async () => {
    let calls = 0;
    const catalog = new NativeToolCatalog({
      request: async <T>() => {
        calls += 1;
        const description =
          calls % 2 === 0
            ? "Read scan history. This tool is part of plugin `Codex Security Cloud`."
            : "Read scan history.";
        return {
          data: [
            {
              name: "codex_apps",
              tools: {
                scan: {
                  name: "scan",
                  description,
                  icons: [{ src: `https://example.test/icon-${calls}.svg` }],
                  inputSchema: { type: "object" },
                },
              },
            },
          ],
          nextCursor: null,
        } as T;
      },
    });

    const result = await catalog.refresh();
    expect(calls).toBe(2);
    expect(result.tools[0]?.tool.description).toBe(
      "Read scan history. This tool is part of plugin `Codex Security Cloud`.",
    );
    expect(result.tools[0]?.nativeTool?.description).toBe(result.tools[0]?.tool.description);
    expect(result.tools[0]?.nativeTool?.icons).toEqual([
      { src: "https://example.test/icon-2.svg" },
    ]);
    expect(result.tools[0]?.tool.icons).toEqual(result.tools[0]?.nativeTool?.icons);
  });

  it("waits for substantive tool description changes to converge", async () => {
    let calls = 0;
    const catalog = new NativeToolCatalog({
      request: async <T>() => {
        calls += 1;
        const description = calls === 1 ? "Previous contract." : "Updated contract.";
        return {
          data: [
            {
              name: "codex_apps",
              tools: { scan: { name: "scan", description, inputSchema: { type: "object" } } },
            },
          ],
          nextCursor: null,
        } as T;
      },
    });

    const result = await catalog.refresh();
    expect(calls).toBe(3);
    expect(result.tools[0]?.tool.description).toBe("Updated contract.");
  });

  it("converges a stable tool inventory when failure diagnostic text changes", async () => {
    let calls = 0;
    const catalog = new NativeToolCatalog({
      request: async <T>() =>
        ({
          data: [{ name: "cua_repl", tools: {}, toolsError: `request ${++calls} failed` }],
          nextCursor: null,
        }) as T,
    });
    expect((await catalog.refresh()).serverErrors).toEqual([
      { server: "cua_repl", toolsError: "request 2 failed" },
    ]);
    expect(calls).toBe(2);
  });

  it("preserves upstream toolsError without inventing tools or retaining recovered errors", async () => {
    let toolsError: string | null = "MCP startup failed: 액세스가 거부되었습니다. (os error 5)";
    const catalog = new NativeToolCatalog({
      request: async <T>() =>
        ({
          data: [{ name: "cua_repl", tools: {}, toolsError }],
          nextCursor: null,
        }) as T,
    });
    const failed = await catalog.refresh();
    expect(failed.tools).toEqual([]);
    expect(failed.serverErrors).toEqual([{ server: "cua_repl", toolsError }]);
    toolsError = null;
    expect((await catalog.refresh()).serverErrors).toEqual([]);
  });

  it.each(["js", "js_reset", "js_add_node_module_dir"])(
    "keeps %s names and native dispatch stable across REPL additions, removals, and restart",
    async (name) => {
      const nativeTool = {
        name,
        description: "Original REPL contract.",
        inputSchema: { type: "object", properties: { value: { type: "string" } } },
        annotations: { readOnlyHint: false },
      };
      const nodeServer = { name: "node_repl", tools: { [name]: nativeTool } };
      const secondServer = { name: "cua_repl", tools: { [name]: nativeTool } };
      let servers = [nodeServer];
      const calls: unknown[] = [];
      const client = {
        request: async <T>(method: string, params: unknown): Promise<T> => {
          if (method === "mcpServerStatus/list") {
            return { data: servers, nextCursor: null } as T;
          }
          calls.push({ method, params });
          return { content: [{ type: "text", text: "native result" }] } as T;
        },
      };
      let catalog = new NativeToolCatalog(client);
      const executor = new NativeToolExecutor(client);
      for (const phase of ["single", "added", "removed", "restarted"]) {
        servers = phase === "added" ? [nodeServer, secondServer] : [nodeServer];
        if (phase === "restarted") catalog = new NativeToolCatalog(client);
        const snapshot = await catalog.refresh();
        expect(snapshot.tools.map((tool) => tool.exposedName)).toEqual(
          phase === "added"
            ? [`codex__cua_repl__${name}`, `codex__node_repl__${name}`]
            : [`codex__node_repl__${name}`],
        );
        const descriptor = snapshot.tools.find((tool) => tool.server === "node_repl");
        if (descriptor === undefined) throw new Error("node REPL descriptor missing");
        expect(descriptor.originalName).toBe(name);
        expect(descriptor.nativeTool).toEqual(nativeTool);
        expect(descriptor.tool.inputSchema).toEqual(nativeTool.inputSchema);
        expect(descriptor.tool.description).toBe(nativeTool.description);
        await expect(
          executor.call(descriptor.server, descriptor.originalName, { value: phase }, "caller"),
        ).resolves.toEqual({ content: [{ type: "text", text: "native result" }] });
        expect(calls.at(-1)).toMatchObject({
          method: "mcpServer/tool/call",
          params: { server: "node_repl", tool: name, arguments: { value: phase } },
        });
      }
    },
  );

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

  it("preserves valid root-union output schemas without rewriting them", async () => {
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

    expect(tool?.outputSchema).toEqual(originalOutputSchema);
    expect(tool?._meta?.omnicodex).not.toHaveProperty("outputSchemaTransform");
  });

  it("preserves a downstream root ref instead of forcing an object wrapper", async () => {
    const originalInputSchema = {
      $ref: "#/$defs/Arguments",
      $defs: {
        Arguments: {
          oneOf: [
            { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            { type: "object", properties: { uri: { type: "string" } }, required: ["uri"] },
          ],
        },
      },
    };
    const catalog = new NativeToolCatalog({
      request: async <T>(): Promise<T> =>
        ({
          data: [
            {
              name: "schema-server",
              tools: {
                flexible: {
                  name: "flexible",
                  title: "Flexible input",
                  description: "Installed flexible-input contract.",
                  inputSchema: originalInputSchema,
                  annotations: { readOnlyHint: true },
                  execution: { taskSupport: "optional" },
                },
              },
            },
          ],
          nextCursor: null,
        }) as T,
    });

    const tool = (await catalog.refresh()).tools[0]?.tool;
    expect(tool?.inputSchema).toEqual(originalInputSchema);
    expect(tool).toMatchObject({
      title: "Flexible input",
      description: "Installed flexible-input contract.",
      annotations: { readOnlyHint: true },
      execution: { taskSupport: "optional" },
    });
    expect(tool?._meta?.omnicodex).not.toHaveProperty("inputSchemaTransform");
  });

  it("does not impose a default total-page cap and rejects cursor cycles", async () => {
    let pageCalls = 0;
    const catalog = new NativeToolCatalog({
      request: async <T>(_method: string, paramsValue: unknown): Promise<T> => {
        pageCalls += 1;
        const params = paramsValue as Record<string, unknown>;
        const page = typeof params.cursor === "string" ? Number(params.cursor) : 0;
        return {
          data: [],
          ...(page < 100 ? { nextCursor: String(page + 1) } : {}),
        } as T;
      },
    });

    await expect(catalog.refresh()).resolves.toMatchObject({ tools: [] });
    expect(pageCalls).toBe(202);

    let cyclePage = 0;
    const cyclic = new NativeToolCatalog({
      request: async <T>(): Promise<T> =>
        ({ data: [], nextCursor: cyclePage++ % 2 === 0 ? "a" : "b" }) as T,
    });
    await expect(cyclic.refresh()).rejects.toThrow("repeated a pagination cursor");
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

  it("marks recursion by exact deployment identity instead of a display name", async () => {
    const expectedIdentity = omniCodexServerIdentityFromMetadata({
      resource: "https://owner.example/mcp/full",
    });
    expect(expectedIdentity).toMatch(/^[a-f0-9]{64}$/u);
    if (expectedIdentity === undefined) throw new Error("Expected a deployment identity");
    const catalog = new NativeToolCatalog(
      {
        request: async <T>(): Promise<T> =>
          ({
            data: [
              {
                name: "OmniCodex",
                tools: {
                  same_name_not_self: {
                    name: "same_name_not_self",
                    inputSchema: { type: "object" },
                    _meta: { omnicodex: { serverIdentity: "f".repeat(64) } },
                  },
                },
              },
              {
                name: "renamed-exact-deployment",
                tools: {
                  exact_self: {
                    name: "exact_self",
                    inputSchema: { type: "object" },
                    _meta: { omnicodex: { serverIdentity: expectedIdentity } },
                  },
                },
              },
            ],
            nextCursor: null,
          }) as T,
      },
      { selfServerIdentity: expectedIdentity },
    );

    const snapshot = await catalog.refresh();
    expect(
      snapshot.tools.find(({ originalName }) => originalName === "same_name_not_self"),
    ).not.toHaveProperty("selfReferential");
    expect(snapshot.tools.find(({ originalName }) => originalName === "exact_self")).toMatchObject({
      server: "renamed-exact-deployment",
      selfReferential: true,
    });
  });

  it("marks the exact configured self server when the host strips tool metadata", async () => {
    const catalog = new NativeToolCatalog(
      {
        request: async <T>(): Promise<T> =>
          ({
            data: [
              {
                name: "omnicodex",
                tools: {
                  recursive: {
                    name: "recursive",
                    inputSchema: { type: "object" },
                  },
                },
              },
              {
                name: "omnicodex-compatible",
                tools: {
                  external: {
                    name: "external",
                    inputSchema: { type: "object" },
                  },
                },
              },
              {
                name: "responses-runtime",
                tools: {
                  projected_self: {
                    name: "OmniCodex.codex_app__read_thread",
                    inputSchema: { type: "object" },
                  },
                },
              },
            ],
            nextCursor: null,
          }) as T,
      },
      { selfServerName: "OmniCodex" },
    );

    const snapshot = await catalog.refresh();

    expect(snapshot.tools.find(({ server }) => server === "omnicodex")).toMatchObject({
      selfReferential: true,
    });
    expect(
      snapshot.tools.find(({ server }) => server === "omnicodex-compatible"),
    ).not.toHaveProperty("selfReferential");
    expect(
      snapshot.tools.find(
        ({ originalName }) => originalName === "OmniCodex.codex_app__read_thread",
      ),
    ).toMatchObject({ selfReferential: true });
  });

  it("shares a flight only within the same thread context", async () => {
    const requestCounts = new Map<string, number>();
    let firstPassStarts = 0;
    let releaseFirstPasses!: () => void;
    let markBothStarted!: () => void;
    const firstPassGate = new Promise<void>((resolve) => {
      releaseFirstPasses = resolve;
    });
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    const catalog = new NativeToolCatalog({
      request: async <T>(_method: string, params: unknown): Promise<T> => {
        const threadId = (params as { threadId?: string }).threadId;
        if (threadId === undefined) throw new Error("Expected a thread context");
        const count = (requestCounts.get(threadId) ?? 0) + 1;
        requestCounts.set(threadId, count);
        if (count === 1) {
          firstPassStarts += 1;
          if (firstPassStarts === 2) markBothStarted();
          await firstPassGate;
        }
        return {
          data: [
            {
              name: `${threadId}-server`,
              tools: {
                [threadId]: { name: threadId, inputSchema: { type: "object" } },
              },
            },
          ],
          nextCursor: null,
        } as T;
      },
    });

    const first = catalog.refresh("first-thread");
    const overlappingSameContext = catalog.refresh("first-thread");
    const second = catalog.refresh("second-thread");
    expect(overlappingSameContext).toBe(first);
    expect(second).not.toBe(first);

    await bothStarted;
    expect(requestCounts).toEqual(
      new Map([
        ["first-thread", 1],
        ["second-thread", 1],
      ]),
    );
    releaseFirstPasses();

    const [firstSnapshot, duplicateSnapshot, secondSnapshot] = await Promise.all([
      first,
      overlappingSameContext,
      second,
    ]);
    expect(duplicateSnapshot).toBe(firstSnapshot);
    expect(firstSnapshot.tools.map((tool) => tool.originalName)).toEqual(["first-thread"]);
    expect(secondSnapshot.tools.map((tool) => tool.originalName)).toEqual(["second-thread"]);
    expect(requestCounts).toEqual(
      new Map([
        ["first-thread", 2],
        ["second-thread", 2],
      ]),
    );
  });

  it("clears a completed or failed flight so a later refresh can discover again", async () => {
    const failure = new Error("catalog discovery failed");
    let requestCount = 0;
    const catalog = new NativeToolCatalog({
      request: async <T>(): Promise<T> => {
        requestCount += 1;
        if (requestCount === 1) {
          throw failure;
        }
        return {
          data: [
            {
              name: "recovered-server",
              tools: { recovered: { name: "recovered", inputSchema: { type: "object" } } },
            },
          ],
          nextCursor: null,
        } as T;
      },
    });

    const first = catalog.refresh();
    const overlapping = catalog.refresh();
    expect(overlapping).toBe(first);
    await expect(first).rejects.toBe(failure);
    await expect(overlapping).rejects.toBe(failure);
    expect(catalog.snapshot.refreshedAtUnixMs).toBe(0);

    const recovered = await catalog.refresh();
    expect(requestCount).toBe(3);
    expect(recovered.tools.map((tool) => tool.exposedName)).toEqual(["recovered"]);
    expect(catalog.snapshot).toBe(recovered);
  });

  it.each([
    {
      expected: {
        stage: "response.data",
        page: 1,
        rawShape: { kind: "object", keys: ["unexpected"] },
      },
      malformed: { data: { unexpected: [] }, nextCursor: null },
    },
    {
      expected: {
        stage: "server.tools",
        page: 1,
        serverIndex: 0,
        serverName: "changed-server",
        rawShape: { kind: "array", length: 0 },
      },
      malformed: {
        data: [{ name: "changed-server", tools: [] }],
        nextCursor: null,
      },
    },
    {
      expected: {
        stage: "rawTool",
        page: 1,
        serverIndex: 0,
        serverName: "changed-server",
        toolIndex: 0,
        toolKey: "changed",
        rawShape: { kind: "array", length: 1 },
      },
      malformed: {
        data: [{ name: "changed-server", tools: { changed: ["new-shape"] } }],
        nextCursor: null,
      },
    },
  ])(
    "fails the whole refresh on incompatible $expected.stage without replacing the prior snapshot",
    async ({ expected, malformed }) => {
      let response: unknown = {
        data: [
          {
            name: "baseline-server",
            tools: { baseline: { name: "baseline", inputSchema: { type: "object" } } },
          },
        ],
        nextCursor: null,
      };
      const catalog = new NativeToolCatalog({
        request: async <T>(): Promise<T> => response as T,
      });
      const baseline = await catalog.refresh("baseline");
      response = malformed;

      const error = await catalog.refresh("changed").catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(NativeToolCatalogIncompatibilityError);
      expect(error).toMatchObject({
        code: "NATIVE_TOOL_CATALOG_INCOMPATIBLE",
        details: expected,
      });
      expect(catalog.snapshot).toBe(baseline);
    },
  );

  it("publishes only after two consecutive full multi-page passes have the same digest", async () => {
    let pass = 0;
    let requestCount = 0;
    let markThirdPassStarted!: () => void;
    let releaseThirdPass!: () => void;
    const thirdPassStarted = new Promise<void>((resolve) => {
      markThirdPassStarted = resolve;
    });
    const thirdPassGate = new Promise<void>((resolve) => {
      releaseThirdPass = resolve;
    });
    const catalog = new NativeToolCatalog({
      request: async <T>(_method: string, paramsValue: unknown): Promise<T> => {
        requestCount += 1;
        const params = paramsValue as { cursor?: string };
        if (params.cursor === undefined) {
          pass += 1;
          if (pass === 3) {
            markThirdPassStarted();
            await thirdPassGate;
          }
          return {
            data: [
              {
                name: "version-server",
                tools: {
                  version: {
                    name: pass === 1 ? "version-one" : "version-two",
                    inputSchema: { type: "object" },
                  },
                },
              },
            ],
            nextCursor: "second-page",
          } as T;
        }
        return {
          data: [{ name: "stable-server", tools: {} }],
          nextCursor: null,
        } as T;
      },
    });

    const refreshing = catalog.refresh("thread-torn-snapshot");
    await thirdPassStarted;
    expect(catalog.snapshot).toMatchObject({ refreshedAtUnixMs: 0, servers: [], tools: [] });
    releaseThirdPass();

    const snapshot = await refreshing;
    expect(requestCount).toBe(6);
    expect(snapshot.tools.map((tool) => tool.originalName)).toEqual(["version-two"]);
    expect(catalog.snapshot).toBe(snapshot);
  });

  it("passes the caller signal to every page request and never publishes an aborted partial pass", async () => {
    const controller = new AbortController();
    let phase: "abort" | "baseline" = "baseline";
    let abortedPhaseCalls = 0;
    const requestOptions: unknown[] = [];
    const catalog = new NativeToolCatalog({
      request: async <T>(_method: string, _params: unknown, options?: unknown): Promise<T> => {
        if (phase === "abort") {
          abortedPhaseCalls += 1;
          requestOptions.push(options);
          if (abortedPhaseCalls === 2) controller.abort(new Error("stop catalog refresh"));
        }
        return {
          data: [
            {
              name: `${phase}-server`,
              tools: {
                [phase]: { name: phase, inputSchema: { type: "object" } },
              },
            },
          ],
          nextCursor: null,
        } as T;
      },
    });
    const baseline = await catalog.refresh("baseline");
    phase = "abort";

    await expect(catalog.refresh("aborted", { signal: controller.signal })).rejects.toThrow(
      "stop catalog refresh",
    );
    expect(abortedPhaseCalls).toBe(2);
    expect(requestOptions).toEqual([{ signal: controller.signal }, { signal: controller.signal }]);
    expect(catalog.snapshot).toBe(baseline);
  });
});

describe("NativeToolExecutor", () => {
  it("uses the registered Work executor for both browser tools and preserves each session id", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const executor = new NativeToolExecutor(
      {
        request: async <T>(method: string, params: unknown): Promise<T> => {
          calls.push({ method, params });
          if (method === "thread/start") {
            return { thread: { id: "owned-ephemeral" } } as T;
          }
          return { content: [{ type: "text", text: "READY" }] } as T;
        },
      },
      {
        resolveWorkExecutorId: async () => "registered-work-executor",
        resolveCuaServerConfig: async (id) => ({
          command: "native-cua",
          env: { BROWSER_USE_ACCESS_EXECUTOR_ID: id },
        }),
      },
    );

    await executor.callInContext(
      "node_repl",
      "js",
      { code: "return 1" },
      "desktop-ui-thread",
      undefined,
      undefined,
      undefined,
      "work-session-a",
    );
    await executor.callInContext(
      "cua_repl",
      "js",
      { code: "await cua.getState()" },
      "desktop-ui-thread",
      undefined,
      undefined,
      undefined,
      "work-session-b",
    );

    expect(calls.map((call) => call.method)).toEqual([
      "thread/start",
      "mcpServer/tool/call",
      "mcpServer/tool/call",
    ]);
    expect(calls[0]?.params).toMatchObject({
      ephemeral: true,
      config: {
        thread_unload_delay_secs: 0,
        "mcp_servers.node_repl.env.BROWSER_USE_ACCESS_EXECUTOR_ID": "registered-work-executor",
        "mcp_servers.cua_repl": {
          command: "native-cua",
          env: { BROWSER_USE_ACCESS_EXECUTOR_ID: "registered-work-executor" },
        },
      },
    });
    expect(calls[1]?.params).toMatchObject({
      server: "node_repl",
      threadId: "owned-ephemeral",
      _meta: {
        "x-codex-turn-metadata": {
          session_id: "work-session-a",
          thread_id: "desktop-ui-thread",
        },
      },
    });
    expect(calls[2]?.params).toMatchObject({
      server: "cua_repl",
      threadId: "owned-ephemeral",
      _meta: {
        "x-codex-turn-metadata": {
          session_id: "work-session-b",
          thread_id: "desktop-ui-thread",
        },
      },
    });
  });

  it("recreates an owned execution thread when Desktop rotates its Work executor", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    let workExecutorId = "work-executor-a";
    let starts = 0;
    const executor = new NativeToolExecutor(
      {
        request: async <T>(method: string, params: unknown): Promise<T> => {
          calls.push({ method, params });
          if (method === "thread/start") {
            starts += 1;
            return { thread: { id: `owned-${starts}` } } as T;
          }
          return { content: [] } as T;
        },
      },
      {
        resolveWorkExecutorId: async () => workExecutorId,
        resolveCuaServerConfig: async (id) => ({
          command: "native-cua",
          env: { BROWSER_USE_ACCESS_EXECUTOR_ID: id },
        }),
      },
    );

    await executor.callInContext(
      "node_repl",
      "js",
      { code: "return 1" },
      undefined,
      undefined,
      undefined,
      undefined,
      "work-a",
    );
    workExecutorId = "work-executor-b";
    await executor.callInContext(
      "node_repl",
      "js",
      { code: "return 2" },
      undefined,
      undefined,
      undefined,
      undefined,
      "work-b",
    );

    expect(calls.map(({ method }) => method)).toEqual([
      "thread/start",
      "mcpServer/tool/call",
      "thread/unsubscribe",
      "thread/start",
      "mcpServer/tool/call",
    ]);
    expect(calls[3]?.params).toMatchObject({
      config: {
        "mcp_servers.node_repl.env.BROWSER_USE_ACCESS_EXECUTOR_ID": "work-executor-b",
        "mcp_servers.cua_repl": {
          command: "native-cua",
          env: { BROWSER_USE_ACCESS_EXECUTOR_ID: "work-executor-b" },
        },
      },
    });
    expect(calls[4]?.params).toMatchObject({
      threadId: "owned-2",
      _meta: { "x-codex-turn-metadata": { session_id: "work-b" } },
    });
  });

  it("deletes only its owned ephemeral thread and recreates it on demand", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    let starts = 0;
    const executor = new NativeToolExecutor({
      request: async <T>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "thread/start") {
          starts += 1;
          return { thread: { id: `ephemeral-${starts}` } } as T;
        }
        return { content: [{ type: "text", text: "READY" }] } as T;
      },
    });

    await executor.call("server", "tool", {});
    await executor.retireOwnedExecutionThread();
    await executor.call("server", "tool", {});

    expect(calls.map((call) => call.method)).toEqual([
      "thread/start",
      "mcpServer/tool/call",
      "thread/delete",
      "thread/start",
      "mcpServer/tool/call",
    ]);
    expect(calls[0]?.params).toMatchObject({
      ephemeral: true,
      config: { thread_unload_delay_secs: 0 },
    });
    expect(calls[2]?.params).toEqual({ threadId: "ephemeral-1" });
    expect(calls[4]?.params).toMatchObject({ threadId: "ephemeral-2" });
  });

  it("reuses a live ephemeral thread when App Server requires unsubscribe lifecycle", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    let starts = 0;
    const executor = new NativeToolExecutor({
      request: async <T>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "thread/start") {
          starts += 1;
          return { thread: { id: `ephemeral-${starts}` } } as T;
        }
        if (method === "thread/delete") {
          throw new Error("thread is not persisted and cannot be deleted: ephemeral-1");
        }
        if (method === "thread/unsubscribe") {
          return { status: "unsubscribed" } as T;
        }
        return { content: [{ type: "text", text: "READY" }] } as T;
      },
    });

    await executor.call("server", "tool", {});
    await executor.retireOwnedExecutionThread();
    await executor.call("server", "tool", {});

    expect(calls.map((call) => call.method)).toEqual([
      "thread/start",
      "mcpServer/tool/call",
      "thread/delete",
      "thread/unsubscribe",
      "mcpServer/tool/call",
    ]);
    expect(calls[4]?.params).toMatchObject({ threadId: "ephemeral-1" });
    expect(starts).toBe(1);
  });

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
      sandbox: "danger-full-access",
    });
    expect(calls[0]?.params).not.toHaveProperty("model");
    expect(calls[0]?.params).not.toHaveProperty("modelProvider");
    expect(calls[1]?.params).toMatchObject({
      server: "server",
      threadId: "urn:uuid:ephemeral",
      tool: "tool",
    });
    const firstCall = calls[1];
    if (firstCall === undefined) throw new Error("first dynamic tool call missing");
    const firstMetadata = (
      firstCall.params as {
        _meta: { "x-codex-turn-metadata": Record<string, unknown> };
      }
    )._meta["x-codex-turn-metadata"];
    expect(firstMetadata).toMatchObject({
      auto_review_enabled: false,
      node_repl_auto_review_required: false,
      node_repl_disabled: false,
      sandbox: "none",
      sandbox_mode: "danger-full-access",
      session_id: "urn:uuid:ephemeral",
      thread_id: "urn:uuid:ephemeral",
      thread_source: "user",
      workspace_kind: "project",
    });
    expect(firstMetadata).not.toHaveProperty("model");
    expect(firstMetadata).not.toHaveProperty("reasoning_effort");
    expect(firstMetadata.turn_id).toEqual(expect.any(String));
    expect(firstMetadata.turn_id).not.toBe("");
    expect(firstMetadata.turn_started_at_unix_ms).toEqual(expect.any(Number));
    const secondCall = calls[2];
    if (secondCall === undefined) throw new Error("second dynamic tool call missing");
    const secondMetadata = (
      secondCall.params as {
        _meta: { "x-codex-turn-metadata": Record<string, unknown> };
      }
    )._meta["x-codex-turn-metadata"];
    expect(secondMetadata.turn_id).not.toBe(firstMetadata.turn_id);
  });

  it("forwards model metadata only when the native caller explicitly supplies it", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const executor = new NativeToolExecutor(
      {
        request: async <T>(method: string, params: unknown): Promise<T> => {
          calls.push({ method, params });
          return { content: [{ type: "text", text: "READY" }] } as T;
        },
      },
      { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
    );

    await executor.call("server", "tool", {}, "caller-thread");

    const call = calls[0];
    if (call === undefined) throw new Error("native dynamic tool call missing");
    const metadata = (
      call.params as { _meta: { "x-codex-turn-metadata": Record<string, unknown> } }
    )._meta["x-codex-turn-metadata"];
    expect(metadata).toMatchObject({ model: "gpt-5.6-sol", reasoning_effort: "xhigh" });
  });

  it("omits blank native caller model metadata", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const executor = new NativeToolExecutor(
      {
        request: async <T>(method: string, params: unknown): Promise<T> => {
          calls.push({ method, params });
          return { content: [{ type: "text", text: "READY" }] } as T;
        },
      },
      { model: "  ", reasoningEffort: "\t" },
    );

    await executor.call("server", "tool", {}, "caller-thread");

    const call = calls[0];
    if (call === undefined) throw new Error("native dynamic tool call missing");
    const metadata = (
      call.params as { _meta: { "x-codex-turn-metadata": Record<string, unknown> } }
    )._meta["x-codex-turn-metadata"];
    expect(metadata).not.toHaveProperty("model");
    expect(metadata).not.toHaveProperty("reasoning_effort");
  });

  it("serializes concurrent calls that share its default ephemeral thread", async () => {
    const toolStarts: number[] = [];
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const executor = new NativeToolExecutor({
      request: async <T>(method: string, params: unknown): Promise<T> => {
        if (method === "thread/start") return { thread: { id: "thread-shared" } } as T;
        const value = (params as { arguments: { value: number } }).arguments.value;
        toolStarts.push(value);
        if (value === 1) {
          markFirstStarted?.();
          await firstGate;
        }
        return { content: [{ type: "text", text: String(value) }] } as T;
      },
    });

    const first = executor.call("server", "tool", { value: 1 });
    const second = executor.call("server", "tool", { value: 2 });
    await firstStarted;
    expect(toolStarts).toEqual([1]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(toolStarts).toEqual([1, 2]);
  });

  it("deletes an aborted owned execution thread before releasing its lane and recreates it", async () => {
    const toolStarts: number[] = [];
    const deletedThreads: string[] = [];
    let starts = 0;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const executor = new NativeToolExecutor({
      request: async <T>(method: string, params: unknown): Promise<T> => {
        if (method === "thread/start") {
          starts += 1;
          return { thread: { id: `thread-cancel-${starts}` } } as T;
        }
        if (method === "thread/delete") {
          deletedThreads.push((params as { threadId: string }).threadId);
          return {} as T;
        }
        const value = (params as { arguments: { value: number } }).arguments.value;
        toolStarts.push(value);
        if (value === 1) {
          markFirstStarted();
          await new Promise<never>(() => undefined);
        }
        return { content: [{ type: "text", text: String(value) }] } as T;
      },
    });
    const controller = new AbortController();
    let firstSettled = false;
    const first = executor
      .call("server", "tool", { value: 1 }, undefined, undefined, controller.signal)
      .finally(() => {
        firstSettled = true;
      });
    const second = executor.call("server", "tool", { value: 2 });

    await firstStarted;
    controller.abort(new Error("stop downstream"));
    await expect(first).rejects.toThrow("stop downstream");
    expect(firstSettled).toBe(true);
    expect(deletedThreads).toEqual(["thread-cancel-1"]);
    await expect(second).resolves.toMatchObject({
      content: [{ type: "text", text: "2" }],
    });
    expect(toolStarts).toEqual([1, 2]);
    expect(starts).toBe(2);
  });

  it("unsubscribes and replaces a cancelled non-deletable ephemeral thread", async () => {
    const calls: Array<{ method: string; params: unknown; options: unknown }> = [];
    const toolStarts: number[] = [];
    let starts = 0;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const executor = new NativeToolExecutor({
      request: async <T>(method: string, params: unknown, options?: unknown): Promise<T> => {
        calls.push({ method, params, options });
        if (method === "thread/start") {
          starts += 1;
          return { thread: { id: `thread-unsubscribe-${starts}` } } as T;
        }
        if (method === "thread/delete") {
          const { threadId } = params as { threadId: string };
          throw new Error(`thread is not persisted and cannot be deleted: ${threadId}`);
        }
        if (method === "thread/unsubscribe") {
          return { status: "unsubscribed" } as T;
        }
        const value = (params as { arguments: { value: number } }).arguments.value;
        toolStarts.push(value);
        if (value === 1) {
          markFirstStarted();
          await new Promise<never>(() => undefined);
        }
        return { content: [{ type: "text", text: String(value) }] } as T;
      },
    });
    const controller = new AbortController();
    const first = executor.call(
      "server",
      "tool",
      { value: 1 },
      undefined,
      undefined,
      controller.signal,
    );
    const second = executor.call("server", "tool", { value: 2 });

    await firstStarted;
    controller.abort(new Error("stop non-deletable downstream"));
    await expect(first).rejects.toThrow("stop non-deletable downstream");
    const unsubscribe = calls[3];
    expect(unsubscribe).toMatchObject({
      method: "thread/unsubscribe",
      params: { threadId: "thread-unsubscribe-1" },
      options: { awaitResponseAfterCancellation: true },
    });

    await expect(second).resolves.toMatchObject({
      content: [{ type: "text", text: "2" }],
    });
    expect(toolStarts).toEqual([1, 2]);
    expect(starts).toBe(2);
    expect(calls.at(-1)?.params).toMatchObject({ threadId: "thread-unsubscribe-2" });
    expect(calls.map((call) => call.method)).toEqual([
      "thread/start",
      "mcpServer/tool/call",
      "thread/delete",
      "thread/unsubscribe",
      "thread/start",
      "mcpServer/tool/call",
    ]);
  });

  it("never retires a caller-owned thread when its signal is aborted", async () => {
    const methods: string[] = [];
    let markStarted!: () => void;
    let releaseCall!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const callGate = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    const executor = new NativeToolExecutor({
      request: async <T>(method: string): Promise<T> => {
        methods.push(method);
        markStarted();
        await callGate;
        return { content: [{ type: "text", text: "DONE" }] } as T;
      },
    });
    const controller = new AbortController();
    const call = executor.call(
      "server",
      "tool",
      {},
      "caller-owned-thread",
      undefined,
      controller.signal,
    );

    await started;
    controller.abort(new Error("stop caller-owned downstream"));
    expect(methods).toEqual(["mcpServer/tool/call"]);
    releaseCall();
    await expect(call).rejects.toThrow("stop caller-owned downstream");
    expect(methods).toEqual(["mcpServer/tool/call"]);
  });

  it("detaches a canceled queued default-thread waiter without dispatching it", async () => {
    const toolStarts: number[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const executor = new NativeToolExecutor({
      request: async <T>(method: string, params: unknown): Promise<T> => {
        if (method === "thread/start") return { thread: { id: "thread-queued-cancel" } } as T;
        const value = (params as { arguments: { value: number } }).arguments.value;
        toolStarts.push(value);
        if (value === 1) {
          markFirstStarted();
          await firstGate;
        }
        return { content: [{ type: "text", text: String(value) }] } as T;
      },
    });
    const controller = new AbortController();
    const first = executor.call("server", "tool", { value: 1 });
    const canceled = executor
      .call("server", "tool", { value: 2 }, undefined, undefined, controller.signal)
      .catch((error: unknown) => error);
    const third = executor.call("server", "tool", { value: 3 });

    await firstStarted;
    controller.abort(new Error("cancel queued waiter"));
    await expect(canceled).resolves.toMatchObject({ message: "cancel queued waiter" });
    expect(toolStarts).toEqual([1]);

    releaseFirst();
    await expect(first).resolves.toBeDefined();
    await expect(third).resolves.toMatchObject({
      content: [{ type: "text", text: "3" }],
    });
    expect(toolStarts).toEqual([1, 3]);
  });

  it("separates its owned execution thread from a UI session context", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const executor = new NativeToolExecutor({
      request: async <T>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "thread/start") return { thread: { id: "owned-ephemeral" } } as T;
        return { content: [{ type: "text", text: "READY" }] } as T;
      },
    });

    await executor.callInContext("node_repl", "js", { code: "return 1" }, "desktop-ui-thread");

    const nativeCall = calls.find((call) => call.method === "mcpServer/tool/call");
    expect(nativeCall?.params).toMatchObject({
      threadId: "owned-ephemeral",
      _meta: {
        "x-codex-turn-metadata": {
          session_id: "desktop-ui-thread",
          thread_id: "desktop-ui-thread",
        },
      },
    });
  });

  it("separates Browser Use session identity from its live Codex UI host", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const executor = new NativeToolExecutor({
      request: async <T>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "thread/start") return { thread: { id: "owned-ephemeral" } } as T;
        return { content: [{ type: "text", text: "READY" }] } as T;
      },
    });

    await executor.callInContext(
      "node_repl",
      "js",
      { code: "return browser.tabs.list()" },
      "desktop-browser-host",
      undefined,
      "web-model-turn",
      undefined,
      "omnicodex-browser:work-session-a",
    );

    const nativeCall = calls.find((call) => call.method === "mcpServer/tool/call");
    expect(nativeCall?.params).toMatchObject({
      threadId: "owned-ephemeral",
      _meta: {
        "x-codex-turn-metadata": {
          session_id: "omnicodex-browser:work-session-a",
          thread_id: "desktop-browser-host",
          turn_id: "web-model-turn",
        },
      },
    });
  });

  it("replaces a stale owned execution thread after an App Server reconnect", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    let starts = 0;
    const executor = new NativeToolExecutor({
      request: async <T>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "thread/start") {
          starts += 1;
          return { thread: { id: starts === 1 ? "stale-owned" : "replacement-owned" } } as T;
        }
        const threadId = (params as { threadId: string }).threadId;
        if (threadId === "stale-owned") {
          throw new Error("App Server RPC error (-32600): thread not found: stale-owned");
        }
        return { content: [{ type: "text", text: "RECOVERED" }] } as T;
      },
    });

    await expect(
      executor.callInContext(
        "node_repl",
        "js",
        { code: "return 'ok'" },
        "desktop-ui-thread",
        undefined,
        "outer-turn",
      ),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "RECOVERED" }] });

    expect(calls.map((call) => call.method)).toEqual([
      "thread/start",
      "mcpServer/tool/call",
      "thread/start",
      "mcpServer/tool/call",
    ]);
    const nativeCalls = calls.filter((call) => call.method === "mcpServer/tool/call");
    expect(nativeCalls.map((call) => (call.params as { threadId: string }).threadId)).toEqual([
      "stale-owned",
      "replacement-owned",
    ]);
    expect(nativeCalls[1]?.params).toMatchObject({
      _meta: {
        "x-codex-turn-metadata": {
          session_id: "desktop-ui-thread",
          thread_id: "desktop-ui-thread",
          turn_id: "outer-turn",
        },
      },
    });
  });

  it("does not replay an ambiguous native failure on a live owned thread", async () => {
    let starts = 0;
    let nativeCalls = 0;
    const executor = new NativeToolExecutor({
      request: async <T>(method: string): Promise<T> => {
        if (method === "thread/start") {
          starts += 1;
          return { thread: { id: "owned-live" } } as T;
        }
        nativeCalls += 1;
        throw new Error("Chrome extension disconnected after dispatch");
      },
    });

    await expect(
      executor.callInContext("node_repl", "js", { code: "return 'ambiguous'" }),
    ).rejects.toThrow("Chrome extension disconnected after dispatch");
    expect(starts).toBe(1);
    expect(nativeCalls).toBe(1);
  });

  it("keeps native session metadata on the outer turn boundary", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const executor = new NativeToolExecutor({
      request: async <T>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "thread/start") return { thread: { id: "owned-ephemeral" } } as T;
        return { content: [{ type: "text", text: "READY" }] } as T;
      },
    });

    await executor.callInContext(
      "computer_use",
      "get_window_state",
      { window: { id: 7 } },
      "desktop-ui-thread",
      undefined,
      "outer-turn-1",
    );
    await executor.callInContext(
      "computer_use",
      "click",
      { screenshotId: "screenshot-0", x: 10, y: 20 },
      "desktop-ui-thread",
      undefined,
      "outer-turn-1",
    );
    await executor.callInContext(
      "computer_use",
      "get_window_state",
      { window: { id: 7 } },
      "desktop-ui-thread",
      undefined,
      "outer-turn-2",
    );

    const metadata = calls
      .filter((call) => call.method === "mcpServer/tool/call")
      .map(
        (call) =>
          (
            call.params as {
              _meta: { "x-codex-turn-metadata": Record<string, unknown> };
            }
          )._meta["x-codex-turn-metadata"],
      );
    expect(metadata).toHaveLength(3);
    expect(metadata[0]).toMatchObject({
      session_id: "desktop-ui-thread",
      thread_id: "desktop-ui-thread",
      turn_id: "outer-turn-1",
    });
    expect(metadata[1]).toMatchObject({
      session_id: "desktop-ui-thread",
      thread_id: "desktop-ui-thread",
      turn_id: "outer-turn-1",
    });
    expect(metadata[2]).toMatchObject({
      session_id: "desktop-ui-thread",
      thread_id: "desktop-ui-thread",
      turn_id: "outer-turn-2",
    });
    expect(metadata[1]?.turn_id).toBe(metadata[0]?.turn_id);
    expect(metadata[2]?.turn_id).not.toBe(metadata[0]?.turn_id);
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
