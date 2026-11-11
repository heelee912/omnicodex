import { describe, expect, it } from "vitest";
import {
  NativeToolCatalog,
  type NativeToolDescriptor,
} from "../src/application/native-tool-catalog.js";
import {
  buildNativeToolRegistry,
  publicNativeToolAnnotations,
} from "../src/application/native-tool-registry.js";
import { ResponsesNativeToolCatalog } from "../src/application/responses-native-tool-catalog.js";

const ALL_FALSE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

describe("Native tool registry", () => {
  it("revisions and rejects conflicting source descriptors even when wire projections match", () => {
    const descriptor: NativeToolDescriptor = {
      server: "source",
      originalName: "probe",
      exposedName: "probe",
      tool: { name: "probe", inputSchema: { type: "object" } },
      nativeTool: { name: "probe", inputSchema: true },
    };
    const changed = { ...descriptor, nativeTool: { name: "probe", inputSchema: {} } };
    const first = buildNativeToolRegistry({ downstreamTools: [descriptor] });
    const second = buildNativeToolRegistry({ downstreamTools: [changed] });
    expect(first.revision).not.toBe(second.revision);
    expect(() => buildNativeToolRegistry({ downstreamTools: [descriptor, changed] })).toThrow(
      "Conflicting native descriptors",
    );
  });

  it("publishes every annotation field as false independently of native hints", () => {
    expect(publicNativeToolAnnotations({}, "custom", "fs/readFile", "read").annotations).toEqual(
      ALL_FALSE_ANNOTATIONS,
    );
    expect(publicNativeToolAnnotations({}, undefined, "apply_patch", "mutate").annotations).toEqual(
      ALL_FALSE_ANNOTATIONS,
    );
    expect(
      publicNativeToolAnnotations({}, "app_server", "fs/remove", "mutate").annotations,
    ).toEqual(ALL_FALSE_ANNOTATIONS);
    expect(
      publicNativeToolAnnotations(
        {
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        "custom",
        "exact",
        "mutate",
      ).annotations,
    ).toEqual(ALL_FALSE_ANNOTATIONS);
  });

  it.each(["fs/readFile", "fs/getMetadata", "fs/readDirectory", "thread/goal/get"])(
    "sets every public annotation false for %s",
    (name) => {
      expect(publicNativeToolAnnotations({}, "app_server", name, "read").annotations).toEqual(
        ALL_FALSE_ANNOTATIONS,
      );
      expect(publicNativeToolAnnotations({}, "app_server", name, "mutate").annotations).toEqual(
        ALL_FALSE_ANNOTATIONS,
      );
      const original = { annotations: { readOnlyHint: true, idempotentHint: true } };
      expect(publicNativeToolAnnotations(original, "app_server", name, "read").annotations).toEqual(
        ALL_FALSE_ANNOTATIONS,
      );
      expect(original).toEqual({ annotations: { readOnlyHint: true, idempotentHint: true } });
    },
  );

  it.each([
    ["codex_app", "list_threads", false],
    ["codex_app", "read_thread", false],
    ["codex_app", "wait_threads", false],
    ["codex_app", "load_workspace_dependencies", false],
    ["functions", "view_image", false],
    ["functions", "list_mcp_resources", true],
    ["functions", "list_mcp_resource_templates", true],
    ["functions", "read_mcp_resource", true],
    ["web", "run", true],
    ["", "web__run", true],
  ] as const)("sets every public annotation false for %s/%s", (namespace, name, _openWorldHint) => {
    expect(publicNativeToolAnnotations({}, namespace, name, "read").annotations).toEqual(
      ALL_FALSE_ANNOTATIONS,
    );
    if (namespace) {
      expect(
        publicNativeToolAnnotations({}, namespace, `${namespace}/${name}`, "read").annotations,
      ).toEqual(ALL_FALSE_ANNOTATIONS);
    }
    const explicit = { annotations: { readOnlyHint: false, destructiveHint: true } };
    expect(publicNativeToolAnnotations(explicit, namespace, name, "mutate").annotations).toEqual(
      ALL_FALSE_ANNOTATIONS,
    );
    expect(publicNativeToolAnnotations({}, "unrelated", name, "read").annotations).toEqual(
      ALL_FALSE_ANNOTATIONS,
    );
  });

  it.each([
    ["app_server", "command/exec"],
    ["functions", "exec"],
    ["functions", "exec_command"],
    [undefined, "exec_command"],
    ["node_repl", "js"],
    ["cua_repl", "js"],
  ])("publishes the exact general execution annotations for %s/%s", (namespace, name) => {
    expect(publicNativeToolAnnotations({}, namespace, name as string, "mutate")).toEqual({
      annotations: ALL_FALSE_ANNOTATIONS,
    });
  });

  it("keeps a discovered model proxy without letting it replace native tools", async () => {
    const responsesTools = (
      await new ResponsesNativeToolCatalog({
        snapshot: {
          refreshedAtUnixMs: 1,
          requestCount: 1,
          tools: [],
          nestedTools: [
            { name: "run_natural_task", description: "Start a second model task." },
            { name: "codex_app__list_threads", description: "List native Codex threads." },
          ],
        },
      }).refresh()
    ).tools;
    const registry = buildNativeToolRegistry({ responsesTools });

    expect(registry.entries.map((entry) => entry.originalName)).toContain("run_natural_task");
    expect(registry.entries.map((entry) => entry.originalName)).toContain(
      "codex_app__list_threads",
    );
    expect(
      registry.entries.find((entry) => entry.originalName === "run_natural_task"),
    ).toMatchObject({ route: "responses", modelEffect: "model", invokesModel: true });
  });

  it("excludes only the exact self server identity without hiding similarly named tools", async () => {
    const responsesTools = (
      await new ResponsesNativeToolCatalog({
        snapshot: {
          refreshedAtUnixMs: 1,
          requestCount: 1,
          tools: [
            {
              type: "namespace",
              name: "OmNiCoDeX_Generated_release_abc",
              tools: [
                {
                  type: "function",
                  name: "search_native_tools",
                  parameters: { type: "object", properties: {} },
                },
              ],
            },
            {
              type: "namespace",
              name: "omnicodexish",
              tools: [
                {
                  type: "function",
                  name: "search_native_tools",
                  parameters: { type: "object", properties: {} },
                },
              ],
            },
          ],
        },
      }).refresh()
    ).tools;
    const downstreamTools = [
      downstreamTool("codex_apps", "OmNiCoDeX.search_native_tools"),
      downstreamTool("codex_apps", "omnicodex_retiring_release_abc.search_native_tools"),
      downstreamTool("codex_apps", "OMNICODEX_GENERATED_release-2.call_native_tool"),
      downstreamTool("OmNiCoDeX_Retiring_release_abc", "search_native_tools"),
      downstreamTool("codex_apps", "omnicodexish.search_native_tools"),
      downstreamTool("codex_apps", "third_party.omnicodex_search_native_tools"),
      downstreamTool("codex_apps", "omnicodex-retiring.search_native_tools"),
      downstreamTool("codex_apps", "omnicodex_retiring_release_abc"),
      downstreamTool("omnicodexish", "search_native_tools"),
      {
        ...downstreamTool("renamed-exact-deployment", "search_native_tools"),
        selfReferential: true,
      },
      downstreamTool("OmniCodex", "same-display-name-remains"),
    ];

    const registry = buildNativeToolRegistry({ downstreamTools, responsesTools });
    const downstreamNames = registry.entries
      .filter((entry) => entry.route === "downstream")
      .map((entry) => entry.originalName);

    expect(downstreamNames).toContain("OmNiCoDeX.search_native_tools");
    expect(downstreamNames).toContain("omnicodex_retiring_release_abc.search_native_tools");
    expect(downstreamNames).toContain("OMNICODEX_GENERATED_release-2.call_native_tool");
    expect(
      registry.entries.some(
        (entry) =>
          entry.route === "downstream" &&
          entry.nativeNamespace === "OmNiCoDeX_Retiring_release_abc",
      ),
    ).toBe(true);
    expect(
      registry.entries.some(
        (entry) =>
          entry.route === "responses" &&
          entry.nativeNamespace === "OmNiCoDeX_Generated_release_abc",
      ),
    ).toBe(true);
    expect(
      registry.entries.some(
        (entry) =>
          entry.route === "downstream" && entry.nativeNamespace === "renamed-exact-deployment",
      ),
    ).toBe(false);
    expect(
      registry.entries.some(
        (entry) => entry.route === "downstream" && entry.nativeNamespace === "OmniCodex",
      ),
    ).toBe(true);

    expect(downstreamNames).toEqual(
      expect.arrayContaining([
        "omnicodexish.search_native_tools",
        "third_party.omnicodex_search_native_tools",
        "omnicodex-retiring.search_native_tools",
        "omnicodex_retiring_release_abc",
        "search_native_tools",
      ]),
    );
    expect(
      registry.entries.some(
        (entry) => entry.route === "responses" && entry.nativeNamespace === "omnicodexish",
      ),
    ).toBe(true);
  });

  it("keeps native titles and omitted annotations absent", async () => {
    const responsesTools = (
      await new ResponsesNativeToolCatalog({
        snapshot: {
          refreshedAtUnixMs: 1,
          requestCount: 1,
          tools: [],
          nestedTools: [
            {
              name: "codex_app__load_workspace_dependencies",
              description: "Locate installed workspace dependency runtimes.",
            },
            {
              name: "codex_app__set_thread_title",
              description: "Set a local thread title.",
            },
          ],
        },
      }).refresh()
    ).tools;
    const registry = buildNativeToolRegistry({
      responsesTools,
    });

    const readTool = registry.tools.find(
      (tool) => tool.name === "codex_app__load_workspace_dependencies",
    );
    expect(readTool?.title).toBeUndefined();
    expect(readTool?.annotations).toEqual(ALL_FALSE_ANNOTATIONS);
    const writeTool = registry.tools.find((tool) => tool.name === "codex_app__set_thread_title");
    expect(writeTool?.title).toBeUndefined();
    expect(writeTool?.annotations).toEqual(ALL_FALSE_ANNOTATIONS);
  });

  it("preserves every boolean JSON Schema node byte-for-byte", () => {
    const registry = buildNativeToolRegistry({
      downstreamTools: [
        {
          server: "schema-test",
          originalName: "boolean_schema_tool",
          exposedName: "boolean_schema_tool",
          tool: {
            name: "boolean_schema_tool",
            inputSchema: {
              type: "object",
              properties: {
                value: true,
                denied: false,
                option: { type: "boolean", default: false, const: true },
              },
              additionalProperties: false,
            } as never,
          },
        },
      ],
    });

    expect(registry.tools[0]?.inputSchema).toEqual({
      type: "object",
      properties: {
        value: true,
        denied: false,
        option: { type: "boolean", default: false, const: true },
      },
      additionalProperties: false,
    });
    expect(objectValue(registry.tools[0]?._meta?.omnicodex)).not.toHaveProperty(
      "mcpSchemaBooleanNormalized",
    );
  });

  it("keeps Node REPL scheduling separate from its native annotations", () => {
    const registry = buildNativeToolRegistry({
      downstreamTools: [
        {
          server: "node_repl",
          originalName: "js",
          exposedName: "node_repl__js",
          tool: {
            name: "js",
            description: "Execute JavaScript in a persistent Node REPL.",
            inputSchema: {
              type: "object",
              properties: { code: { type: "string" } },
              required: ["code"],
            },
            annotations: { readOnlyHint: true },
            _meta: { omnicodex: { stateEffect: "read" } },
          },
        },
      ],
    });

    expect(registry.entries).toHaveLength(1);
    expect(registry.entries[0]).toMatchObject({
      nativeNamespace: "node_repl",
      originalName: "js",
      stateEffect: "mutate",
      tool: {
        annotations: ALL_FALSE_ANNOTATIONS,
        _meta: {
          omnicodex: {
            stateEffect: "read",
          },
        },
      },
    });
    expect(objectValue(registry.entries[0]?.tool._meta?.omnicodex)).not.toHaveProperty(
      "annotationCorrection",
    );
  });

  it("preserves the same Node REPL annotations from the Responses catalog", async () => {
    const responsesTools = (
      await new ResponsesNativeToolCatalog({
        snapshot: {
          refreshedAtUnixMs: 1,
          requestCount: 1,
          tools: [
            {
              type: "namespace",
              name: "node_repl",
              tools: [
                {
                  type: "function",
                  name: "js",
                  description: "Execute JavaScript in a persistent Node REPL.",
                  parameters: {
                    type: "object",
                    properties: { code: { type: "string" } },
                    required: ["code"],
                  },
                  annotations: { readOnlyHint: true },
                },
              ],
            },
          ],
        },
      }).refresh()
    ).tools;

    const registry = buildNativeToolRegistry({ responsesTools });
    expect(registry.entries).toHaveLength(1);
    expect(registry.entries[0]).toMatchObject({
      route: "responses",
      nativeNamespace: "node_repl",
      originalName: "js",
      stateEffect: "mutate",
      tool: {
        annotations: ALL_FALSE_ANNOTATIONS,
      },
    });
    const publicMetadata = objectValue(registry.entries[0]?.tool._meta?.omnicodex);
    expect(publicMetadata).not.toHaveProperty("stateEffect");
    expect(publicMetadata).not.toHaveProperty("readOnly");
    expect(publicMetadata).not.toHaveProperty("annotationCorrection");
  });

  it("publishes CUA REPL with an interactive boundary while preserving its native contract", () => {
    const registry = buildNativeToolRegistry({
      downstreamTools: [
        {
          server: "cua_repl",
          originalName: "js",
          exposedName: "cua_repl__js",
          tool: {
            name: "js",
            description: "Control apps or browsers with the installed CUA runtime.",
            inputSchema: {
              type: "object",
              properties: { code: { type: "string" } },
              required: ["code"],
            },
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              openWorldHint: false,
            },
          },
        },
      ],
    });

    expect(registry.entries).toHaveLength(1);
    expect(registry.entries[0]).toMatchObject({
      nativeNamespace: "cua_repl",
      originalName: "js",
      stateEffect: "mutate",
      tool: {
        description: "Control apps or browsers with the installed CUA runtime.",
        annotations: ALL_FALSE_ANNOTATIONS,
      },
    });
  });

  it("normalizes general execution hints without modifying the source descriptor", () => {
    const original = {
      annotations: { readOnlyHint: true, destructiveHint: true, openWorldHint: true },
    };
    expect(publicNativeToolAnnotations(original, "node_repl", "js", "mutate")).toEqual({
      annotations: ALL_FALSE_ANNOTATIONS,
    });
    expect(original.annotations.readOnlyHint).toBe(true);
    expect(publicNativeToolAnnotations({}, "node_repl", "js", "mutate")).toEqual({
      annotations: ALL_FALSE_ANNOTATIONS,
    });
  });

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
                  annotations: { readOnlyHint: true },
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
    expect(names).toContain("shared");
    expect(names.some((name) => name.startsWith("codex__demo_server__shared"))).toBe(true);
    expect(names).toContain("codex__functions__exec");
    expect(names).toContain("codex__functions__wait");
    expect(
      registry.entries.find((entry) => entry.exposedName === "codex__functions__exec"),
    ).toMatchObject({ stateEffect: "none", modelEffect: "none" });
    const shared = registry.entries.filter((entry) => entry.originalName === "shared");
    expect(shared).toHaveLength(2);
    const responseShared = shared.find((entry) => entry.route === "responses");
    expect(responseShared?.exposedName).toBe("shared");
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
    expect(downstreamShared?.exposedName).toMatch(/^codex__demo_server__shared/u);
    expect(downstreamShared).toMatchObject({
      stateEffect: "read",
      tool: {
        annotations: ALL_FALSE_ANNOTATIONS,
      },
    });
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

  it("fails closed when a downstream tool does not declare read-only semantics", async () => {
    const downstreamCatalog = new NativeToolCatalog({
      request: async <T>(): Promise<T> =>
        ({
          data: [
            {
              name: "demo-server",
              tools: {
                unspecified: {
                  name: "unspecified",
                  inputSchema: { type: "object", properties: {} },
                },
              },
            },
          ],
          nextCursor: null,
        }) as T,
    });

    const registry = buildNativeToolRegistry({
      downstreamTools: (await downstreamCatalog.refresh()).tools,
    });

    expect(registry.entries[0]?.stateEffect).toBe("mutate");
    expect(registry.entries[0]?.tool.annotations).toEqual(ALL_FALSE_ANNOTATIONS);
    const publicMetadata = objectValue(registry.entries[0]?.tool._meta?.omnicodex);
    expect(publicMetadata).not.toHaveProperty("destructive");
    expect(publicMetadata).not.toHaveProperty("openWorld");
  });
});

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function downstreamTool(server: string, originalName: string): NativeToolDescriptor {
  return {
    server,
    originalName,
    exposedName: originalName,
    tool: {
      name: originalName,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  };
}
