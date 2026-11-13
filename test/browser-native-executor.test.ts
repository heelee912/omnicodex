import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rmdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type BrowserNativeContextBoundary,
  type BrowserNativeContextRequest,
  type BrowserNativeExecutionStage,
  BrowserNativeExecutor,
  waitForBrowserBoundary,
} from "../src/application/browser-native-executor.js";
import { structuredErrorDetails } from "../src/infrastructure/runtime/structured-error-details.js";

function createLifecycleTab(
  id: string,
  close: () => void,
  options: {
    readonly url?: string;
    readonly dom?: string;
    readonly onDomRead?: () => void;
  } = {},
) {
  const dom = options.dom ?? "";
  const messageCount =
    dom.split('heading "나의 말:"').length + dom.split('heading "ChatGPT의 말:"').length - 2;
  return {
    id,
    url: options.url ?? `https://example.invalid/${id}`,
    dom_cua: {
      get_visible_dom: async () => {
        options.onDomRead?.();
        return dom;
      },
    },
    playwright: {
      getByRole: () => ({
        count: async () => (dom.includes('aria-label="답변 중지"') ? 1 : 0),
      }),
      locator: () => ({ count: async () => messageCount }),
    },
    close: async () => close(),
    markHandoff: async () => undefined,
    markDeliverable: async () => undefined,
  };
}

describe("BrowserNativeExecutor", () => {
  it("forwards CUA JavaScript unchanged to the protected installed reader", async () => {
    const calls: unknown[] = [];
    const executor = new BrowserNativeExecutor({
      callInContext: async (_server, _tool, argumentsValue) => {
        calls.push(argumentsValue);
        return { content: [] };
      },
    });
    const argumentsValue = Object.freeze({
      code: "nodeRepl.write(await agent.documentation.get('confirmations'))",
    });

    try {
      await executor.callCua("cua_repl", "js", argumentsValue);
      expect(calls).toEqual([argumentsValue]);
      expect(calls[0]).toBe(argumentsValue);
    } finally {
      await executor.close();
    }
  });
  it.each(["success", "ok"] as const)(
    "preserves an explicit %s=false native browser refusal without replay",
    async (flag) => {
      const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-refusal-"));
      await installBrowserClient(root, "1.0.0");
      const native = {
        [flag]: false,
        error: { name: "SyntheticRefusal", message: "Synthetic safety-check refusal" },
      };
      let nativeCalls = 0;
      const executor = new BrowserNativeExecutor(
        {
          callInContext: async () => {
            nativeCalls += 1;
            return native;
          },
        },
        { codexHome: root, resolveContextThreadId: async () => "fixture-host" },
      );
      try {
        const result = await executor.call({
          operation: "exec",
          surface: "chrome",
          code: "return 'non-sensitive fixture';",
        });
        expect(result).toEqual({ ...native, isError: true });
        expect(native).not.toHaveProperty("isError");
        expect(nativeCalls).toBe(1);
      } finally {
        await executor.close();
      }
    },
  );

  it("runs an attributed Chrome call without requiring its ChatGPT tab to be open", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-origin-"));
    await installBrowserClient(root, "1.0.0");
    const generatedCodes: string[] = [];
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args) => {
          generatedCodes.push((args as { code: string }).code);
          return { content: [{ type: "text", text: "ok" }] };
        },
      },
      { codexHome: root, resolveContextThreadId: async () => "host" },
    );
    const digest = "a".repeat(64);

    await executor.call(
      {
        operation: "exec",
        surface: "chrome",
        code: "await browser.tabs.new(); return 'created';",
      },
      {
        callerProvenance: "chatgpt_conversation",
        chatGptConversationIdSha256: digest,
        ownerBinding: "owner",
        workSessionBinding: "work",
      },
    );

    const attributed = generatedCodes.at(-1) ?? "";
    expect(attributed).toContain("await browser.tabs.new()");
    expect(attributed).not.toContain(digest);
    expect(attributed).not.toContain("__omniOriginCandidates");
    expect(attributed).not.toContain("__omniBrowser.user.claimTab(");

    await executor.call(
      {
        operation: "exec",
        surface: "chrome",
        code: "return 'unattributed';",
      },
      {
        chatGptConversationIdSha256: digest,
        ownerBinding: "owner",
        workSessionBinding: "other-work",
      },
    );
    expect(generatedCodes.at(-1)).not.toContain("__omniOriginCandidates");
  });

  it("performs a fixed exact-tab accessibility inspection without evaluating caller code", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-inspect-"));
    await installBrowserClient(root, "1.0.0");
    let generatedCode = "";
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args) => {
          generatedCode = (args as { code: string }).code;
          return { content: [{ type: "text", text: "fresh state" }] };
        },
      },
      { codexHome: root, resolveContextThreadId: async () => "host" },
    );

    await executor.call({
      operation: "inspect",
      surface: "chrome",
      target_tab_id: "  tab-42  ",
      code: "throw new Error('caller supplied mutation')",
    });

    expect(generatedCode).toContain('const __omniTargetTabId = "tab-42";');
    expect(generatedCode).toContain("await browser.user.claimTab(__omniTargetTabId)");
    expect(generatedCode).toContain("await browser.tabs.get(__omniTargetTabId)");
    expect(generatedCode).toContain('await __omniTab.ax.get("state", { disableDiffing: true })');
    expect(generatedCode).not.toContain("caller supplied mutation");
    await expect(
      executor.call({
        operation: "inspect",
        surface: "chrome",
        target_tab_id: " ",
      }),
    ).rejects.toThrow("target_tab_id must be a non-empty native tab id");
  });

  it("retains exact browser handles in work-session state", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-state-"));
    await installBrowserClient(root, "1.0.0");
    const runtimes = new Map<string, Record<string, unknown>>();
    const handle = { read: async () => "continued" };
    let selections = 0;
    const originalDocumentation = "# Runtime browser API\n## Tabs\nTabs API.";
    const browser = {
      browserId: "1",
      tabs: {
        selected: async () => {
          selections += 1;
          return handle;
        },
      },
      documentation: async () => originalDocumentation,
    };
    const agent = {
      browsers: {
        get: async () => browser,
        getDefault: async () => browser,
        list: async () => [{ id: "1", type: "extension", family: "chrome" }],
      },
    };
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;
    const writes: unknown[] = [];
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args) => {
          const code = (args as { code: string }).code;
          const binding = /const __omniBrowserRuntimeBinding = "([^"]+)"/.exec(code)?.[1];
          if (binding === undefined) throw new Error("Missing runtime binding");
          let runtime = runtimes.get(binding);
          if (runtime === undefined) {
            runtime = {};
            runtimes.set(binding, runtime);
          }
          const start = code.indexOf("await (async () => {", code.indexOf("const __omniAgent ="));
          await new AsyncFunction(
            "__omniAgent",
            "__omniRuntime",
            "nodeRepl",
            code.slice(start, code.lastIndexOf("})();")),
          )(agent, runtime, {
            write: (value: unknown) => writes.push(value),
          });
          return { ok: true };
        },
      },
      { codexHome: root, resolveContextThreadId: async () => "host" },
    );
    const context = { ownerBinding: "owner-a", workSessionBinding: "work-a" };
    const exec = (code: string, identity = context) =>
      executor.call({ operation: "exec", surface: "chrome", code }, identity);
    await exec("state.tab = await browser.tabs.selected(); return state.tab;");
    const savedHandle = writes.at(-1);
    await exec("return state.tab;");
    expect(writes.at(-1)).toBe(savedHandle);
    await exec("return await state.tab.read();");
    expect(writes.at(-1)).toBe("continued");
    expect(selections).toBe(1);
    await exec("return typeof state.tab;", {
      ...context,
      workSessionBinding: "work-b",
    });
    expect(writes.at(-1)).toBe("undefined");
    await exec("return typeof state.tab;", {
      ...context,
      ownerBinding: "owner-b",
    });
    expect(writes.at(-1)).toBe("undefined");
    await exec("return await state.tab.read();");
    expect(writes.at(-1)).toBe("continued");
    await executor.call({ operation: "documentation", surface: "chrome" }, context);
    expect(writes.at(-1)).toBe(originalDocumentation);
  });

  it.each([undefined, "browser-api"])(
    "forwards default or named runtime documentation unchanged (%s)",
    async (documentationName) => {
      const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-documentation-syntax-"));
      await installBrowserClient(root, "1.0.0");
      const apiReference = "# API Reference\n## Tabs\nTabs API.";
      const documentation = `# Overview\nIntro.\n${apiReference}\n## node_repl + Chrome\nSeparate workflow.`;
      const browser = { browserId: "1", documentation: async () => documentation };
      const agent = {
        browsers: {
          get: async () => browser,
          getDefault: async () => browser,
          list: async () => [{ id: "1", type: "extension", family: "chrome" }],
        },
        documentation: { get: async () => documentation },
      };
      const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
        ...args: string[]
      ) => (...args: unknown[]) => Promise<unknown>;
      const writes: unknown[] = [];
      const executor = new BrowserNativeExecutor(
        {
          callInContext: async (_server, _tool, args) => {
            const code = (args as { code: string }).code;
            // Compile the complete payload, then execute only the generated action with mocks.
            new AsyncFunction(code);
            const start = code.indexOf("await (async () => {", code.indexOf("const __omniAgent ="));
            await new AsyncFunction(
              "__omniAgent",
              "__omniRuntime",
              "nodeRepl",
              code.slice(start, code.lastIndexOf("})();")),
            )(agent, {}, { write: (value: unknown) => writes.push(value) });
            return { ok: true };
          },
        },
        { codexHome: root, resolveContextThreadId: async () => "host" },
      );

      await executor.call({
        operation: "documentation",
        surface: "chrome",
        ...(documentationName === undefined ? {} : { documentation_name: documentationName }),
      });

      expect(writes).toHaveLength(1);
      expect(writes[0]).toBe(documentation);
    },
  );

  it("writes long JSON results losslessly while retaining native media and binary values", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-output-"));
    await installBrowserClient(root, "1.0.0");
    const longText = '한글 😀 "escaped"\\\n'.repeat(5_000);
    const json = { nested: [{ text: longText }], count: 5_000 };
    const binary = { screenshot: new Uint8Array([0, 128, 255]) };
    const media = {
      nested: { type: "image", data: "YWJj", mimeType: "image/png" },
    };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let accessorReads = 0;
    const accessor = Object.defineProperty({}, "privateValue", {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return "private-accessor-sentinel";
      },
    });
    const stages: BrowserNativeExecutionStage[] = [];
    const nativeEnvelope = { ok: true };
    const browser = { browserId: "1", result: json as unknown };
    const writes: unknown[] = [];
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args) => {
          const code = (args as { code: string }).code;
          const actionStart = code.indexOf(
            "await (async () => {",
            code.indexOf("const __omniAgent ="),
          );
          await new AsyncFunction(
            "__omniAgent",
            "__omniRuntime",
            "nodeRepl",
            code.slice(actionStart, code.lastIndexOf("})();")),
          )(
            {
              browsers: {
                get: async () => browser,
                getDefault: async () => browser,
                list: async () => [{ id: "1", type: "extension", family: "chrome" }],
              },
            },
            {},
            { write: (value: unknown) => writes.push(value) },
          );
          return nativeEnvelope;
        },
      },
      { codexHome: root, resolveContextThreadId: async () => "browser-host" },
    );
    for (const result of [json, binary, media, cycle, accessor]) {
      browser.result = result;
      expect(
        await executor.call(
          { operation: "exec", surface: "chrome", code: "return browser.result;" },
          {
            observeExecutionStage: (stage) => {
              stages.push(stage);
              throw new Error("diagnostic observer failed");
            },
          },
        ),
      ).toBe(nativeEnvelope);
    }
    expect(
      await executor.call(
        { operation: "exec", surface: "chrome", code: "await Promise.resolve();" },
        { observeExecutionStage: (stage) => stages.push(stage) },
      ),
    ).toBe(nativeEnvelope);
    expect(typeof writes[0]).toBe("string");
    expect(writes[0]).toBe(JSON.stringify(json));
    expect(JSON.parse(writes[0] as string)).toEqual(json);
    expect(writes[1]).toBe(binary);
    expect(writes[2]).toBe(media);
    expect(writes[3]).toBe(cycle);
    expect(writes[4]).toBe(accessor);
    expect(writes[5]).toBeUndefined();
    expect(accessorReads).toBe(0);
    expect(stages).toEqual(
      Array.from({ length: 6 }, () => [
        "runtime_setup",
        "native_dispatch",
        "native_returned",
      ]).flat(),
    );
    expect(JSON.stringify(stages)).not.toContain("private-accessor-sentinel");
  });

  it("keeps the original rejection and cancellation when stage observers fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-observation-"));
    await installBrowserClient(root, "1.0.0");
    const failure = new Error("private-native-failure-sentinel");
    let nativeCalls = 0;
    const stages: BrowserNativeExecutionStage[] = [];
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async () => {
          nativeCalls += 1;
          throw failure;
        },
      },
      { codexHome: root, resolveContextThreadId: async () => "browser-host" },
    );
    const observeExecutionStage = (stage: BrowserNativeExecutionStage) => {
      stages.push(stage);
      throw new Error("diagnostic failure");
    };
    const args = { operation: "exec", surface: "chrome", code: "await Promise.resolve();" };
    await expect(executor.call(args, { observeExecutionStage })).rejects.toBe(failure);
    expect(nativeCalls).toBe(1);
    expect(stages).toEqual(["runtime_setup", "native_dispatch"]);
    const controller = new AbortController();
    controller.abort(failure);
    await expect(
      executor.call(args, { observeExecutionStage, signal: controller.signal }),
    ).rejects.toBe(failure);
    expect(nativeCalls).toBe(1);
    expect(stages.at(-1)).toBe("runtime_setup");
    expect(JSON.stringify(stages)).not.toContain("private-native-failure-sentinel");
  });

  it.each(["native-id", "extension-id", "runtime-recovery", "activity-completed"] as const)(
    "rejects saved native handles before dispatch after %s changes and preserves ordinary state",
    async (change) => {
      const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-handles-"));
      await installBrowserClient(root, "1.0.0");
      const sent: string[] = [];
      class Locator {
        #browserId: string;
        constructor(browserId: string) {
          this.#browserId = browserId;
        }
        and(other: Locator) {
          expect(other.#browserId).toBe(this.#browserId);
          return this;
        }
        filter(options: { has: Locator }) {
          return this.and(options.has);
        }
        async all() {
          return [this];
        }
        async click() {
          sent.push(`click:${this.#browserId}`);
        }
      }
      class TabSurface {
        #browserId: string;
        constructor(browserId: string) {
          this.#browserId = browserId;
        }
        locator() {
          return new Locator(this.#browserId);
        }
        async read() {
          sent.push(`read:${this.#browserId}`);
          return this.#browserId;
        }
      }
      class Tab extends TabSurface {
        readonly id: string;
        readonly ax: TabSurface;
        readonly playwright: TabSurface;
        constructor(browserId: string, tabId: string) {
          super(browserId);
          this.id = tabId;
          this.ax = new TabSurface(browserId);
          this.playwright = new TabSurface(browserId);
        }
      }
      class Browser {
        readonly browserId: string;
        readonly tabs: { get: (id: string) => Promise<Tab> };
        readonly capabilities: {
          get: () => Promise<{
            call: () => void;
            windows: object;
          }>;
        };
        constructor(browserId: string) {
          this.browserId = browserId;
          this.tabs = { get: async (id) => new Tab(browserId, id) };
          this.capabilities = {
            get: async () =>
              Object.freeze({
                call: () => sent.push(`frozen:${browserId}`),
                windows: new Proxy(
                  {},
                  {
                    get: () => () => sent.push(`namespace:${browserId}`),
                  },
                ),
              }),
          };
        }
      }
      let selectedId = "1";
      let profileId = "1";
      let extensionId = "extension-a";
      let disconnect = false;
      const agent = {
        browsers: {
          get: async () => new Browser(selectedId),
          getDefault: async () => new Browser(selectedId),
          list: async () => {
            if (disconnect) {
              disconnect = false;
              throw new Error("Browser data session was terminated");
            }
            return [
              {
                id: profileId,
                type: "extension",
                family: "chrome",
                profileName: "A",
                metadata: { extensionInstanceId: extensionId },
              },
              {
                id: "2",
                type: "extension",
                family: "chrome",
                profileName: "B",
                metadata: { extensionInstanceId: "extension-b" },
              },
              ...(profileId === "1"
                ? []
                : [{ id: "1", type: "extension", profileName: "Replacement" }]),
            ];
          },
        },
      };
      const globals = globalThis as typeof globalThis & {
        __omniCodexBrowserPhysicalRuntimes?: unknown;
        __omniCodexBrowserRuntimes?: unknown;
      };
      const previousPhysical = globals.__omniCodexBrowserPhysicalRuntimes;
      const previousRuntimes = globals.__omniCodexBrowserRuntimes;
      delete globals.__omniCodexBrowserPhysicalRuntimes;
      delete globals.__omniCodexBrowserRuntimes;
      const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
        ...args: string[]
      ) => (...args: unknown[]) => Promise<unknown>;
      let lastWritten: unknown;
      const executor = new BrowserNativeExecutor(
        {
          callInContext: async (_server, _tool, args) => {
            // Vitest's VM has no dynamic-import callback for AsyncFunction.
            // Substitute only the SDK factory import, executing the complete
            // generated bootstrap, recovery and caller code unchanged.
            const code = (args as { code: string }).code.replace(
              /const \{ setupBrowserRuntime \} = await import\("[^"]*"\);/gu,
              "const setupBrowserRuntime = __setupBrowserRuntime;",
            );
            await new AsyncFunction("nodeRepl", "__setupBrowserRuntime", code)(
              {
                write: (value: unknown) => {
                  lastWritten = value;
                },
              },
              async () => agent,
            );
            return { content: [{ type: "text", text: String(lastWritten) }] };
          },
        },
        { codexHome: root, resolveContextThreadId: async () => "handle-host" },
      );
      const context = {
        ownerBinding: "owner",
        workSessionBinding: "work",
        activityBinding: "first-activity",
      };
      const exec = (code: string) =>
        executor.call({ operation: "exec", surface: "chrome", code }, context);
      try {
        await executor.beginActivity(context.activityBinding, context);
        await exec(`
          state.browser = browser;
          state.tab = await browser.tabs.get("same-tab");
          state.ax = state.tab.ax;
          state.locator = state.tab.playwright.locator("button");
          state.locators = await state.locator.all();
          state.click = state.locator.click;
          state.capability = await browser.capabilities.get();
          state.windows = state.capability.windows;
          state.capability.call();
          state.windows.getAll();
          state.data = { note: "preserved", count: 3 };
          return await state.locator.and(state.locator).filter({ has: state.locator }).click();
        `);
        expect(sent).toEqual(["frozen:1", "namespace:1", "click:1"]);
        selectedId = "2";
        await exec(`
          state.other = await browser.tabs.get("other-tab");
          await state.other.read();
          return await state.tab.read();
        `);
        expect(sent.slice(-2)).toEqual(["read:2", "read:1"]);

        if (change === "native-id") profileId = "7";
        else if (change === "extension-id") extensionId = "reconnected-a";
        else if (change === "activity-completed") {
          await executor.finishActivity(context.activityBinding, context);
          context.activityBinding = "next-activity";
          await executor.beginActivity(context.activityBinding, context);
        } else {
          // Execute the actual recovery bootstrap while the test factory even
          // returns the same agent object: generation must still invalidate.
          disconnect = true;
          await executor.call({ operation: "list_surfaces" }, context);
        }
        const beforeStale = [...sent];
        for (const code of [
          "return await state.tab.read();",
          "return await state.ax.read();",
          "return await state.locator.click();",
          "return await state.locators[0].click();",
          "return await state.click();",
          "return state.capability.call();",
          "return state.windows.getAll();",
          'return await state.browser.tabs.get("same-tab");',
          'return (await browser.tabs.get("other-tab")).playwright.locator("button").filter({ has: state.locator });',
        ]) {
          await expect(exec(code)).rejects.toThrow("BROWSER_HANDLE_STALE");
          expect(sent).toEqual(beforeStale);
        }
        if (change !== "runtime-recovery" && change !== "activity-completed") {
          await exec("return await state.other.read();");
          expect(sent.at(-1)).toBe("read:2");
        }
        await exec("return state.data;");
        expect(JSON.parse(String(lastWritten))).toEqual({
          note: "preserved",
          count: 3,
        });
        selectedId = profileId;
        await exec(`
          state.tab = await browser.tabs.get(state.tab.id);
          return await state.tab.read();
        `);
        expect(sent.at(-1)).toBe(`read:${profileId}`);
      } finally {
        globals.__omniCodexBrowserPhysicalRuntimes = previousPhysical;
        globals.__omniCodexBrowserRuntimes = previousRuntimes;
      }
    },
  );

  it("resolves each exact browser selector again after native connection ids change", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-selection-"));
    await installBrowserClient(root, "1.0.0");
    const runtime = { browserBindings: new Map<string, unknown>() };
    const selected: string[] = [];
    let connection = "original";
    let loopId = "2";
    let loopPresent = true;
    let otherPresent = true;
    const surfaces = () => [
      ...(otherPresent
        ? [
            {
              id: "1",
              type: "extension",
              family: "chrome",
              profileName: "Other",
              metadata: { extensionInstanceId: "other" },
            },
          ]
        : []),
      ...(loopPresent
        ? [
            {
              id: loopId,
              type: "extension",
              family: "chrome",
              profileName: "Loop",
              metadata: { extensionInstanceId: `loop-${connection}` },
            },
          ]
        : []),
      ...(loopId === "2"
        ? []
        : [
            {
              id: "2",
              type: "extension",
              family: "chrome",
              profileName: "Replacement",
              metadata: { extensionInstanceId: "replacement" },
            },
          ]),
    ];
    const getBrowser = async (id: string) => {
      selected.push(id);
      if (id === "missing") throw new Error("Native browser not found");
      const resolvedConnection = connection;
      return {
        browserId: id,
        tabs: {
          list: async () => [{ id: `tab-${id}-${resolvedConnection}` }],
        },
        user: {
          openTabs: async () => [{ id: `tab-${id}-${resolvedConnection}` }],
        },
      };
    };
    const agent = {
      browsers: {
        list: async () => surfaces(),
        get: getBrowser,
        getDefault: async () => getBrowser(loopId),
      },
    };
    const results: unknown[] = [];
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args) => {
          const code = (args as { code: string }).code;
          if (code.includes("nodeRepl.write(JSON.stringify(await __omniAgent.browsers.list()))")) {
            return {
              content: [{ type: "text", text: JSON.stringify(surfaces()) }],
            };
          }
          const actionStart = code.indexOf(
            "await (async () => {",
            code.indexOf("const __omniAgent ="),
          );
          expect(actionStart).toBeGreaterThan(0);
          const action = code.slice(actionStart, code.lastIndexOf("})();"));
          let written: unknown;
          await new AsyncFunction("__omniAgent", "__omniRuntime", "nodeRepl", action)(
            agent,
            runtime,
            {
              write: (value: unknown) => {
                written = value;
              },
            },
          );
          results.push(typeof written === "string" ? JSON.parse(written) : written);
          return { ok: true };
        },
      },
      { codexHome: root, resolveContextThreadId: async () => "browser-host" },
    );
    const listed = await executor.call({ operation: "list_surfaces" });
    expect(JSON.stringify(listed)).toContain("profile:chrome:Loop");
    expect(JSON.stringify(listed)).not.toContain('\\"id\\":\\"2\\"');
    for (const browserId of [
      "profile:chrome:Other",
      "profile:chrome:Loop",
      "profile:chrome:Other",
      undefined,
      "profile:chrome:Loop",
      undefined,
    ]) {
      await executor.call({
        operation: "list_tabs",
        surface: "chrome",
        browserId,
      });
    }
    expect(selected).toEqual(["1", "2", "1", "2", "2", "2"]);
    expect(results).toEqual(
      ["1", "2", "1", "2", "2", "2"].map((id) => [{ id: `tab-${id}-original` }]),
    );
    // A persisted old Browser object must not survive native reconnection or
    // a changed get_browser mapping, including an upgrade from the old cache.
    runtime.browserBindings = new Map([
      [
        JSON.stringify(["chrome", "2"]),
        { user: { openTabs: async () => [{ id: "wrong-profile" }] } },
      ],
    ]);
    connection = "reconnected";
    await executor.call({
      operation: "list_user_tabs",
      surface: "chrome",
      browserId: "profile:chrome:Loop",
    });
    expect(results.at(-1)).toEqual([{ id: "tab-2-reconnected", attachedToThisSession: true }]);
    await executor.call({
      operation: "exec",
      surface: "chrome",
      browserId: "profile:chrome:Loop",
      code: "const tabs = await browser.user.openTabs(); return tabs;",
    });
    expect(results.at(-1)).toEqual([{ id: "tab-2-reconnected" }]);
    expect(runtime.browserBindings).toBeUndefined();
    // The same connection moves to a different numeric id in a fresh kernel.
    // The old id is now a different profile and must never receive this call.
    loopId = "7";
    await executor.call({
      operation: "list_user_tabs",
      surface: "chrome",
      browserId: "profile:chrome:Loop",
    });
    expect(results.at(-1)).toEqual([{ id: "tab-7-reconnected", attachedToThisSession: true }]);
    await executor.call({
      operation: "exec",
      surface: "chrome",
      browserId: "profile:chrome:Loop",
      code: "const tabs = await browser.user.openTabs(); return tabs;",
    });
    expect(results.at(-1)).toEqual([{ id: "tab-7-reconnected" }]);
    loopPresent = false;
    await expect(
      executor.call({
        operation: "exec",
        surface: "chrome",
        browserId: "profile:chrome:Loop",
        code: "return browser.user.openTabs();",
      }),
    ).rejects.toThrow("selected native connection is absent or ambiguous");
    loopPresent = true;
    await expect(
      executor.call({
        operation: "list_tabs",
        surface: "chrome",
        browserId: "missing",
      }),
    ).rejects.toThrow("selected browser key is absent or ambiguous");
    expect(selected).not.toContain("default");
    await executor.call({
      operation: "list_tabs",
      surface: "chrome",
      browserId: "profile:chrome:Loop",
    });
    expect(results.at(-1)).toEqual([{ id: "tab-7-reconnected" }]);
    otherPresent = false;
    loopId = "2";
    await executor.call({
      operation: "list_tabs",
      surface: "chrome",
      browserId: "1",
    });
    expect(results.at(-1)).toEqual([{ id: "tab-2-reconnected" }]);
    expect(selected.at(-1)).toBe("2");
  });

  it("uses a stable family profile key when the sole live Chrome surface omits profileName", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-family-selection-"));
    await installBrowserClient(root, "1.0.0");
    let nativeId = "4";
    let extensionInstanceId = "first-extension";
    const selected: string[] = [];
    const surfaces = () => [
      {
        id: nativeId,
        type: "extension",
        family: "chrome",
        name: "Chrome",
        metadata: { extensionInstanceId },
      },
    ];
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args) => {
          const code = (args as { code: string }).code;
          if (code.includes("nodeRepl.write(JSON.stringify(await __omniAgent.browsers.list()))")) {
            return {
              content: [{ type: "text", text: JSON.stringify(surfaces()) }],
            };
          }
          const actionStart = code.indexOf(
            "await (async () => {",
            code.indexOf("const __omniAgent ="),
          );
          const action = code.slice(actionStart, code.lastIndexOf("})();"));
          await new AsyncFunction("__omniAgent", "__omniRuntime", "nodeRepl", action)(
            {
              browsers: {
                get: async (id: string) => {
                  selected.push(id);
                  return { tabs: { list: async () => [] } };
                },
              },
            },
            {},
            { write: () => undefined },
          );
          return { ok: true };
        },
      },
      { codexHome: root, resolveContextThreadId: async () => "browser-host" },
    );

    const listed = await executor.call({ operation: "list_surfaces" });
    expect(JSON.stringify(listed)).toContain("profile:chrome:default");
    expect(JSON.stringify(listed)).not.toContain("first-extension");

    await executor.call({
      operation: "list_tabs",
      surface: "chrome",
      browserId: "profile:chrome:default",
    });
    nativeId = "9";
    extensionInstanceId = "reconnected-extension";
    await executor.call({
      operation: "list_tabs",
      surface: "chrome",
      browserId: "profile:chrome:default",
    });
    expect(selected).toEqual(["4", "9"]);
  });

  it("keeps an unnamed Chrome key resolving when the visible profile count changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-count-change-"));
    await installBrowserClient(root, "1.0.0");
    let visible = [
      { nativeId: "4", instance: "extension-a" },
      { nativeId: "5", instance: "extension-b" },
    ];
    const selected: string[] = [];
    const surfaces = () =>
      visible.map(({ nativeId, instance }) => ({
        id: nativeId,
        type: "extension",
        family: "chrome",
        name: "Chrome",
        metadata: { extensionInstanceId: instance },
      }));
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;
    const createExecutor = () =>
      new BrowserNativeExecutor(
        {
          callInContext: async (_server, _tool, args) => {
            const code = (args as { code: string }).code;
            if (
              code.includes("nodeRepl.write(JSON.stringify(await __omniAgent.browsers.list()))")
            ) {
              return { content: [{ type: "text", text: JSON.stringify(surfaces()) }] };
            }
            const actionStart = code.indexOf(
              "await (async () => {",
              code.indexOf("const __omniAgent ="),
            );
            const action = code.slice(actionStart, code.lastIndexOf("})();"));
            await new AsyncFunction("__omniAgent", "__omniRuntime", "nodeRepl", action)(
              {
                browsers: {
                  get: async (id: string) => {
                    selected.push(id);
                    return { tabs: { list: async () => [] } };
                  },
                },
              },
              {},
              { write: () => undefined },
            );
            return { ok: true };
          },
        },
        { codexHome: root, resolveContextThreadId: async () => "browser-host" },
      );
    const executor = createExecutor();
    const listTabs = (browserId: string) =>
      executor.call({ operation: "list_tabs", surface: "chrome", browserId });

    const twoProfiles = JSON.stringify(await executor.call({ operation: "list_surfaces" }));
    expect(twoProfiles).toContain("extension:extension-a");
    await listTabs("extension:extension-a");

    // 2 -> 1: the other profile closed and the kept one reconnected under a new native id.
    visible = [{ nativeId: "7", instance: "extension-a" }];
    await listTabs("extension:extension-a");
    expect(JSON.stringify(await executor.call({ operation: "list_surfaces" }))).toContain(
      "profile:chrome:default",
    );
    await listTabs("profile:chrome:default");

    // 1 -> 2: the key issued while one profile was visible still names that profile.
    visible = [
      { nativeId: "7", instance: "extension-a" },
      { nativeId: "8", instance: "extension-b" },
    ];
    await listTabs("profile:chrome:default");
    await listTabs("extension:extension-a");
    expect(selected).toEqual(["4", "7", "7", "7", "7"]);

    // A exact key must not slide onto another profile that became the sole one.
    visible = [{ nativeId: "8", instance: "extension-b" }];
    await expect(listTabs("extension:extension-a")).rejects.toThrow("BROWSER_SELECTION_STALE");
    expect(selected).toEqual(["4", "7", "7", "7", "7"]);

    // A family key never bound to a profile stays ambiguous while two are open.
    visible = [
      { nativeId: "7", instance: "extension-a" },
      { nativeId: "8", instance: "extension-b" },
    ];
    await expect(
      createExecutor().call({
        operation: "list_tabs",
        surface: "chrome",
        browserId: "profile:chrome:default",
      }),
    ).rejects.toThrow("BROWSER_SELECTION_STALE");
  });

  describe("late extension connection on surface listing", () => {
    const chromeSurface = {
      id: "chrome-1",
      type: "extension",
      family: "chrome",
      name: "Chrome",
      metadata: { extensionInstanceId: "late-extension" },
    };

    const failedListing = {
      isError: true,
      content: [{ type: "text", text: "listing backend failed" }],
    };

    async function listingHarness(options: {
      readonly listings: readonly (readonly Record<string, unknown>[] | typeof failedListing)[];
      readonly hostRunning: boolean | (() => Promise<boolean>);
    }) {
      const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-late-extension-"));
      await installBrowserClient(root, "1.0.0");
      let listCalls = 0;
      let hostChecks = 0;
      let launches = 0;
      const executor = new BrowserNativeExecutor(
        {
          callInContext: async (_server, _tool, args) => {
            const code = (args as { code: string }).code;
            if (
              code.includes("nodeRepl.write(JSON.stringify(await __omniAgent.browsers.list()))")
            ) {
              const listing =
                options.listings[Math.min(listCalls, options.listings.length - 1)] ?? [];
              listCalls += 1;
              if (!Array.isArray(listing)) return listing;
              return { content: [{ type: "text", text: JSON.stringify(listing) }] };
            }
            return { ok: true };
          },
        },
        {
          codexHome: root,
          resolveContextThreadId: async () => "browser-host",
          lateExtensionSurfaceWaitMs: 400,
          lateExtensionSurfacePollMs: 50,
          surfaceRecovery: {
            recoverUnavailableSurface: async () => {
              launches += 1;
            },
            noteSurfaceAvailable: () => undefined,
            isExtensionHostRunning: async () => {
              hostChecks += 1;
              return typeof options.hostRunning === "function"
                ? options.hostRunning()
                : options.hostRunning;
            },
          },
        },
      );
      return {
        list: (context?: { readonly deadlineUnixMs?: number; readonly signal?: AbortSignal }) =>
          executor.call({ operation: "list_surfaces" }, context),
        counts: () => ({ listCalls, hostChecks, launches }),
      };
    }

    it("returns a failed re-read as the failure instead of an empty listing", async () => {
      const harness = await listingHarness({ listings: [[], failedListing], hostRunning: true });
      expect(await harness.list()).toEqual(failedListing);
      expect(harness.counts()).toEqual({ listCalls: 2, hostChecks: 1, launches: 0 });
    });

    it("surfaces a failed running diagnostic instead of treating Chrome as closed", async () => {
      const harness = await listingHarness({
        listings: [[]],
        hostRunning: async () => {
          throw new Error("chrome-is-running diagnostic crashed");
        },
      });
      await expect(harness.list()).rejects.toThrow(
        /BROWSER_EXTENSION_HOST_DIAGNOSTIC_FAILED.*chrome-is-running diagnostic crashed/u,
      );
      expect(harness.counts()).toEqual({ listCalls: 1, hostChecks: 1, launches: 0 });
    });

    it("bounds a slow running diagnostic by the caller deadline", async () => {
      const harness = await listingHarness({
        listings: [[]],
        hostRunning: () => new Promise<boolean>(() => undefined),
      });
      const startedAt = Date.now();
      await expect(harness.list({ deadlineUnixMs: Date.now() + 250 })).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(harness.counts()).toEqual({ listCalls: 1, hostChecks: 1, launches: 0 });
    });

    it("returns a connected listing at once", async () => {
      const harness = await listingHarness({ listings: [[chromeSurface]], hostRunning: true });
      expect(JSON.stringify(await harness.list())).toContain("profile:chrome:default");
      expect(harness.counts()).toEqual({ listCalls: 1, hostChecks: 0, launches: 0 });
    });

    it("returns an empty listing at once when the browser is not running", async () => {
      const harness = await listingHarness({ listings: [[]], hostRunning: false });
      expect(JSON.stringify(await harness.list())).not.toContain("chrome");
      expect(harness.counts()).toEqual({ listCalls: 1, hostChecks: 1, launches: 0 });
    });

    it("re-reads until a late extension connection appears", async () => {
      const harness = await listingHarness({
        listings: [[], [], [chromeSurface]],
        hostRunning: true,
      });
      expect(JSON.stringify(await harness.list())).toContain("profile:chrome:default");
      expect(harness.counts()).toEqual({ listCalls: 3, hostChecks: 1, launches: 0 });
    });

    it("returns the empty listing after the bounded wait without launching a browser", async () => {
      const harness = await listingHarness({ listings: [[]], hostRunning: true });
      const startedAt = Date.now();
      expect(JSON.stringify(await harness.list())).not.toContain("chrome");
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      const { listCalls, hostChecks, launches } = harness.counts();
      expect(hostChecks).toBe(1);
      expect(launches).toBe(0);
      expect(listCalls).toBeGreaterThan(1);
      expect(listCalls).toBeLessThanOrEqual(9);
    });
  });

  it("lists surfaces without selecting one and binds Chrome and in-app browser separately", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    const script = join(
      root,
      "plugins",
      "cache",
      "openai-bundled",
      "browser",
      "1.0.0",
      "scripts",
      "browser-client.mjs",
    );
    await mkdir(join(script, ".."), { recursive: true });
    await writeFile(script, "export const setupBrowserRuntime = async () => ({});", "utf8");
    const calls: Array<{
      server: string;
      tool: string;
      args: Record<string, unknown>;
      contextThreadId?: string;
      contextTurnId?: string;
      contextSessionId?: string;
    }> = [];
    const contextRequests: BrowserNativeContextRequest[] = [];
    const nativeExecutor = {
      callInContext: async (
        server: string,
        tool: string,
        args: Record<string, unknown>,
        contextThreadId?: string,
        _onProgress?: undefined,
        contextTurnId?: string,
        _signal?: AbortSignal,
        contextSessionId?: string,
      ) => {
        calls.push({
          server,
          tool,
          args,
          ...(contextThreadId === undefined ? {} : { contextThreadId }),
          ...(contextTurnId === undefined ? {} : { contextTurnId }),
          ...(contextSessionId === undefined ? {} : { contextSessionId }),
        });
        return { ok: true };
      },
    };
    const executor = new BrowserNativeExecutor(nativeExecutor, {
      codexHome: root,
      resolveContextThreadId: async (request) => {
        contextRequests.push(request);
        return request.operation === "exec" && request.surface === "iab"
          ? request.contextThreadId
          : "global-browser-host";
      },
    });

    await installProtectedBrowserDocuments(root);
    await executor.call({ operation: "list_surfaces" });
    await executor.call({ operation: "documentation", surface: "chrome" });
    await executor.call(
      {
        operation: "exec",
        surface: "chrome",
        code: "return browser.tabs.list();",
      },
      { activityBinding: "turn:web-activity-a" },
    );
    await executor.call(
      {
        operation: "exec",
        surface: "iab",
        code: "return browser.tabs.list();",
      },
      {
        contextThreadId: "desktop-iab-task",
        ownerBinding: "owner-a",
        workSessionBinding: "work-a",
      },
    );
    await executor.finishActivity("turn:web-activity-a");

    expect(calls).toHaveLength(4);
    expect(calls.map((call) => call.contextThreadId)).toEqual([
      "global-browser-host",
      "global-browser-host",
      "global-browser-host",
      "desktop-iab-task",
    ]);
    expect(calls[2]?.contextTurnId).toBe("turn:web-activity-a");
    expect(calls[3]?.contextSessionId).toBe("desktop-iab-task");
    expect(calls[2]?.contextSessionId).toMatch(/^omnicodex_browser_[a-f0-9]{64}$/u);
    expect(calls[0]?.args.code).toContain(
      "nodeRepl.write(JSON.stringify(await __omniAgent.browsers.list()))",
    );
    expect(calls[1]?.args.code).toContain("__omniAgent.browsers.getDefault()");
    expect(calls[1]?.args.code).toContain("return await browser.documentation();");
    expect(calls[1]?.args.code).toContain("nodeRepl.write(__omniBrowserResult)");
    expect(calls[1]?.args.code).not.toContain("firstPartySkillInstructions");
    expect(calls[1]?.args.code).not.toContain("runtimeDocumentation:");
    expect(calls[1]?.args.code).not.toContain("__omniReadFirstPartySkill");
    expect(calls[2]?.args.code).toContain("__omniAgent.browsers.getDefault()");
    expect(calls[2]?.args.code).toContain("globalThis.__omniCodexBrowserRuntimes");
    expect(calls[2]?.args.code).not.toContain("globalThis.__omniCodexChrome");
    expect(calls[2]?.args.code).toContain("__omniIsJson(__omniBrowserResult)");
    expect(calls[2]?.args.code).toContain("nodeRepl.write(__omniBrowserResult)");
    expect(calls[2]?.args.code).toContain("__omniRuntime.browserBindings");
    expect(calls[2]?.args.code).toContain("})(__omniBrowser, __omniRuntime.executionState)");
    expect(calls[2]?.args.code).not.toContain("__omniAttachedBefore");
    expect(calls[2]?.args.code).not.toContain("browser.user.openTabs()");
    expect(calls[2]?.args.code).toContain("BROWSER_HANDLE_STALE");
    expect(calls[2]?.args.code).not.toContain("get_visible_dom");
    expect(calls[2]?.args.code).not.toContain("tab.close()");
    expect(calls[2]?.args.code).not.toContain("__omniBrowser.nameSession");
    expect(calls[3]?.args.code).toContain('__omniAgent.browsers.get("iab")');
    expect(calls[3]?.args.code).not.toContain("globalThis.__omniCodexInAppBrowser");
    expect(contextRequests[3]).toMatchObject({
      operation: "exec",
      surface: "iab",
      contextThreadId: "desktop-iab-task",
      ownerBinding: "owner-a",
      workSessionBinding: "work-a",
    });
  });

  it("forwards exact installed named browser documentation without wrapping or truncating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-documentation-"));
    await installBrowserClient(root, "1.0.0");
    const calls: Array<Record<string, unknown>> = [];
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args) => {
          calls.push(args as Record<string, unknown>);
          return { ok: true };
        },
      },
      {
        codexHome: root,
        resolveContextThreadId: async () => "global-browser-host",
      },
    );

    await executor.call({
      operation: "documentation",
      surface: "chrome",
      documentation_name: "screenshots",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.code).toContain('return await __omniAgent.documentation.get("screenshots");');
    expect(calls[0]?.code).toContain("nodeRepl.write(__omniBrowserResult)");
    expect(calls[0]?.code).toContain('typeof __omniBrowserResult === "object"');
    expect(calls[0]?.code).not.toContain("__omniReadFirstPartySkill");
  });

  it("returns named Chrome policy from the protected Korean Markdown without starting Chrome", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-protected-confirmations-"));
    await installBrowserClient(root, "1.0.0");
    const protectedDirectory = join(root, "protected-confirmation-docs");
    await mkdir(protectedDirectory, { recursive: true });
    const expectedPolicy = "# 브라우저 확인 정책\n보호된 한글 원본문서입니다.\n";
    await writeFile(join(protectedDirectory, "chrome-confirmations.md"), expectedPolicy, "utf8");
    await writeFile(
      join(protectedDirectory, "manifest.json"),
      JSON.stringify([
        {
          Source: join(protectedDirectory, "chrome-confirmations.md"),
          SHA256: createHash("sha256").update(expectedPolicy).digest("hex"),
        },
      ]),
    );
    const calls: Array<Record<string, unknown>> = [];
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args) => {
          calls.push(args as Record<string, unknown>);
          throw new Error("Native Chrome should not be needed for a protected policy");
        },
      },
      { codexHome: root, resolveContextThreadId: async () => "global-browser-host" },
    );

    const result = await executor.call({
      operation: "documentation",
      surface: "chrome",
      documentation_name: "confirmations",
    });

    expect(result).toEqual({ content: [{ type: "text", text: expectedPolicy }] });
    expect(calls).toHaveLength(0);
  });

  it("refreshes the active Chrome client when the plugin package name and version change", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-client-refresh-"));
    const firstClient = await installBrowserClient(root, "1.0.0");
    const calls: Array<{ readonly tool: string; readonly code: string }> = [];
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, tool, args) => {
          calls.push({ tool, code: (args as { code: string }).code });
          return { content: [] };
        },
      },
      { codexHome: root, resolveContextThreadId: async () => "host" },
    );
    const secondClient = join(
      root,
      "plugins",
      "cache",
      "openai-bundled",
      "renamed-browser-package",
      "runtime-v2",
      "scripts",
      "browser-client.mjs",
    );

    try {
      await executor.call({ operation: "list_surfaces" });
      expect(calls[0]?.code).toContain("browser/1.0.0/scripts/browser-client.mjs");

      await mkdir(join(secondClient, ".."), { recursive: true });
      await writeFile(secondClient, "export const setupBrowserRuntime = async () => ({});", "utf8");
      await executor.call({ operation: "list_surfaces" });

      expect(calls[1]?.code).toContain(
        "renamed-browser-package/runtime-v2/scripts/browser-client.mjs",
      );
      expect(calls[1]?.code).not.toContain(firstClient.replaceAll("\\", "/"));
    } finally {
      await executor.close();
    }
  });

  it.each([false, true])(
    "publishes the native Browser Use turn lifecycle in its configured or native default directory (%s)",
    async (customRoot) => {
      const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-native-lifecycle-"));
      const lifecycleRoot = join(root, customRoot ? "owned-browser-rollouts" : "sessions");
      await installBrowserClient(root, "1.0.0");
      const calls: Array<{
        sessionId?: string;
        turnId?: string;
        code?: string;
      }> = [];
      const executor = new BrowserNativeExecutor(
        {
          callInContext: async (
            _server,
            _tool,
            args,
            _contextThreadId,
            _onProgress,
            contextTurnId,
            _signal,
            contextSessionId,
          ) => {
            calls.push({
              ...(contextSessionId === undefined ? {} : { sessionId: contextSessionId }),
              ...(contextTurnId === undefined ? {} : { turnId: contextTurnId }),
              ...(typeof (args as Record<string, unknown>).code === "string"
                ? { code: String((args as Record<string, unknown>).code) }
                : {}),
            });
            return { ok: true };
          },
        },
        {
          codexHome: root,
          ...(customRoot ? { browserRolloutSessionsRoot: lifecycleRoot } : {}),
        },
      );
      const conversation = {
        ownerBinding: "owner",
        workSessionBinding: "web",
      } as const;
      const activityBinding = "turn:web-trace";

      await executor.beginActivity(activityBinding, conversation);
      await executor.call(
        { operation: "exec", surface: "chrome", code: "return 1;" },
        { ...conversation, activityBinding },
      );

      const sessionId = calls[0]?.sessionId;
      expect(sessionId).toMatch(/^omnicodex_browser_[a-f0-9]{64}$/u);
      if (sessionId === undefined) throw new Error("browser session id was not forwarded");
      const lifecyclePath = join(lifecycleRoot, `rollout-omnicodex-${sessionId}.jsonl`);
      expect(await readFile(lifecyclePath, "utf8")).toBe("");

      await executor.finishActivity(activityBinding, conversation);

      expect(calls).toHaveLength(1);
      expect((await readFile(lifecyclePath, "utf8")).trim()).toBe(
        JSON.stringify({
          method: "turn/completed",
          params: { turn: { id: activityBinding } },
        }),
      );

      await executor.close();
      // Closing does not invent a nonexistent client-side dispose RPC. The
      // already-published native turn-end record is the first-party cleanup
      // contract, and retiring the owned App Server closes its transport.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ sessionId, turnId: activityBinding });
    },
  );

  it("actively releases the exact native Browser Use session when the installed tracker is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-active-release-"));
    const clientPath = await installBrowserClient(root, "1.0.0");
    await writeFile(
      join(clientPath, "..", "browser-service.mjs"),
      "export const browserServiceVersion = 'tracker-removed';",
      "utf8",
    );
    const cleanupStarted = deferred<void>();
    const releaseCleanup = deferred<void>();
    const calls: Array<{
      readonly server: string;
      readonly tool: string;
      readonly args: Record<string, unknown>;
      readonly contextThreadId?: string;
      readonly contextTurnId?: string;
      readonly contextSessionId?: string;
    }> = [];
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (
          server,
          tool,
          args,
          contextThreadId,
          _onProgress,
          contextTurnId,
          _signal,
          contextSessionId,
        ) => {
          const typedArgs = args as Record<string, unknown>;
          calls.push({
            server,
            tool,
            args: typedArgs,
            ...(contextThreadId === undefined ? {} : { contextThreadId }),
            ...(contextTurnId === undefined ? {} : { contextTurnId }),
            ...(contextSessionId === undefined ? {} : { contextSessionId }),
          });
          if (tool === "turn_ended") {
            cleanupStarted.resolve(undefined);
            await releaseCleanup.promise;
          }
          return { ok: true };
        },
      },
      {
        codexHome: root,
        resolveContextThreadId: async () => "exact-browser-host",
      },
    );

    const conversation = {
      ownerBinding: "owner",
      workSessionBinding: "web",
    } as const;
    const activityBinding = "browser-activity";
    await executor.beginActivity(activityBinding, conversation);
    await executor.call(
      { operation: "inspect", surface: "chrome", target_tab_id: "tab-42" },
      { ...conversation, activityBinding, contextTurnId: "native-turn" },
    );
    const finishing = executor.finishActivity(activityBinding, conversation);
    await cleanupStarted.promise;
    let settled = false;
    void finishing.finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseCleanup.resolve(undefined);
    await finishing;
    await executor.close();

    expect(calls).toHaveLength(3);
    expect(calls[1]).toMatchObject({
      server: "node_repl",
      tool: "js",
      args: { code: expect.stringContaining("await browser.tabs.list()") },
      contextThreadId: "exact-browser-host",
      contextTurnId: "native-turn",
      contextSessionId: calls[0]?.contextSessionId,
    });
    expect(calls[2]).toMatchObject({
      server: "node_repl",
      tool: "turn_ended",
      args: {
        hook_event_name: "Stop",
        session_id: calls[0]?.contextSessionId,
        turn_id: "native-turn",
      },
      contextThreadId: "exact-browser-host",
      contextTurnId: "native-turn",
      contextSessionId: calls[0]?.contextSessionId,
    });
  });

  it("retains failed cleanup for retry and releases every native turn in the same session", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-cleanup-retry-"));
    const clientPath = await installBrowserClient(root, "1.0.0");
    await writeFile(
      join(clientPath, "..", "browser-service.mjs"),
      "export const trackerRemoved = true;",
      "utf8",
    );
    const ended: string[] = [];
    let failRebind = false;
    const createExecutor = () =>
      new BrowserNativeExecutor(
        {
          callInContext: async (_server, tool, args, _thread, _progress, turnId) => {
            if (
              tool === "js" &&
              String((args as { code?: string }).code).includes("await browser.tabs.list()") &&
              failRebind
            ) {
              return {
                isError: true,
                content: [{ type: "text", text: "Browser connection unavailable" }],
              };
            }
            if (tool === "turn_ended") ended.push(turnId ?? "");
            return { ok: true };
          },
        },
        { codexHome: root },
      );
    const context = { ownerBinding: "owner", workSessionBinding: "same-session" };
    const first = createExecutor();
    for (const contextTurnId of ["native-one", "native-two"]) {
      await first.call(
        { operation: "exec", surface: "chrome", code: "return 1;" },
        {
          ...context,
          activityBinding: "activity",
          contextTurnId,
        },
      );
    }
    failRebind = true;
    await expect(first.finishActivity("activity", context)).rejects.toThrow(
      "Browser activity cleanup failed",
    );
    expect(ended).toEqual([]);
    await first.close({ preserveActivities: true });
    failRebind = false;
    const replacement = createExecutor();
    await replacement.finishActivity("activity", context);
    expect(ended.sort()).toEqual(["native-one", "native-two"]);
    await replacement.finishActivity("activity", context);
    expect(ended).toHaveLength(2);
    await replacement.close();
  });

  it("releases a restored unbound native turn before reclaiming its tab after daemon replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-restored-release-"));
    const clientPath = await installBrowserClient(root, "1.0.0");
    await writeFile(
      join(clientPath, "..", "browser-service.mjs"),
      "export const browserServiceVersion = 'tracker-removed';",
      "utf8",
    );
    const calls: Array<{ tool: string; turnId?: string; sessionId?: string; timeoutMs?: number }> =
      [];
    const createExecutor = () =>
      new BrowserNativeExecutor(
        {
          callInContext: async (
            _server,
            tool,
            args,
            _thread,
            _progress,
            turnId,
            _signal,
            sessionId,
          ) => {
            const timeoutMs = (args as { timeout_ms?: unknown }).timeout_ms;
            calls.push({
              tool,
              ...(turnId === undefined ? {} : { turnId }),
              ...(sessionId === undefined ? {} : { sessionId }),
              ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
            });
            return { ok: true };
          },
        },
        { codexHome: root, resolveContextThreadId: async () => "browser-host" },
      );
    const context = {
      ownerBinding: "owner",
      workSessionBinding: "web",
    } as const;
    const first = createExecutor();
    await first.call({ operation: "inspect", surface: "chrome", target_tab_id: "tab-42" }, context);
    const firstTurn = calls[0]?.turnId;
    const browserSession = calls[0]?.sessionId;
    await first.close({ preserveActivities: true });

    const second = createExecutor();
    await second.call(
      { operation: "inspect", surface: "chrome", target_tab_id: "tab-42", timeout_ms: 90_000 },
      context,
    );

    expect(calls.map((call) => call.tool)).toEqual(["js", "js", "turn_ended", "js"]);
    expect(calls[1]?.timeoutMs).toBeGreaterThan(30_000);
    expect(calls[3]?.timeoutMs).toBeGreaterThan(30_000);
    expect(calls[2]).toMatchObject({
      tool: "turn_ended",
      turnId: firstTurn,
      sessionId: browserSession,
    });
    expect(calls[3]?.sessionId).toBe(browserSession);
    await second.close({ preserveActivities: true });
  });

  it("does not start another native release after restored cleanup reaches its deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-release-deadline-"));
    const clientPath = await installBrowserClient(root, "1.0.0");
    await writeFile(
      join(clientPath, "..", "browser-service.mjs"),
      "export const browserServiceVersion = 'tracker-removed';",
      "utf8",
    );
    const calls: Array<{ tool: string; code: string }> = [];
    let holdRebind = false;
    const createExecutor = () =>
      new BrowserNativeExecutor(
        {
          callInContext: async (_server, tool, args, _thread, _progress, _turnId, signal) => {
            const code = String((args as { code?: string }).code ?? "");
            calls.push({ tool, code });
            if (holdRebind && tool === "js" && code.includes("await browser.tabs.list()")) {
              if (signal === undefined) throw new Error("Missing browser deadline signal");
              return await new Promise<never>((_resolve, reject) => {
                if (signal.aborted) return reject(signal.reason);
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              });
            }
            return { ok: true };
          },
        },
        { codexHome: root, resolveContextThreadId: async () => "browser-host" },
      );
    const context = { ownerBinding: "owner", workSessionBinding: "work" };
    const first = createExecutor();
    for (const contextTurnId of ["old-one", "old-two"]) {
      await first.call(
        { operation: "inspect", surface: "chrome", target_tab_id: "tab-1" },
        { ...context, contextTurnId },
      );
    }
    await first.close({ preserveActivities: true });
    calls.length = 0;
    holdRebind = true;
    const replacement = createExecutor();
    await expect(
      replacement.call(
        { operation: "inspect", surface: "chrome", target_tab_id: "tab-1", timeout_ms: 500 },
        context,
      ),
    ).rejects.toThrow(
      /OmniCodex native browser sessions did not release cleanly \(first: Native browser rebind failed: Browser call deadline exceeded/,
    );
    expect(calls.filter(({ code }) => code.includes("await browser.tabs.list()"))).toHaveLength(1);
    expect(calls.filter(({ tool }) => tool === "turn_ended")).toHaveLength(0);
    await replacement.close({ preserveActivities: true });
  });

  it("adopts a durable browser activity after service replacement without completing or replaying it", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-service-replacement-"));
    const lifecycleRoot = join(root, "browser-lifecycles");
    await installBrowserClient(root, "1.0.0");
    const calls: Array<{ sessionId?: string; turnId?: string }> = [];
    const createExecutor = () =>
      new BrowserNativeExecutor(
        {
          callInContext: async (
            _server,
            _tool,
            _args,
            _thread,
            _progress,
            turnId,
            _signal,
            sessionId,
          ) => {
            calls.push({
              ...(sessionId === undefined ? {} : { sessionId }),
              ...(turnId === undefined ? {} : { turnId }),
            });
            return { ok: true };
          },
        },
        { codexHome: root, browserRolloutSessionsRoot: lifecycleRoot },
      );
    const context = {
      ownerBinding: "owner",
      workSessionBinding: "web",
      continueExistingActivity: true,
    };
    const first = createExecutor();
    await first.beginActivity("original-model-activity", context);
    await first.call(
      { operation: "exec", surface: "chrome", code: "return 1;" },
      { ...context, activityBinding: "original-model-activity" },
    );
    const lifecyclePath = join(lifecycleRoot, `rollout-omnicodex-${calls[0]?.sessionId}.jsonl`);
    await first.close({ preserveActivities: true });
    expect(await readFile(lifecyclePath, "utf8")).toBe("");

    const replacement = createExecutor();
    await replacement.beginActivity("new-coordinator-id", context);
    // Adoption is metadata-only: it must never replay the prior caller code.
    expect(calls).toHaveLength(1);
    await replacement.call(
      { operation: "exec", surface: "chrome", code: "return 2;" },
      { ...context, activityBinding: "new-coordinator-id" },
    );
    expect(calls[1]).toEqual(calls[0]);
    expect(await readFile(lifecyclePath, "utf8")).toBe("");
    await replacement.finishActivity("new-coordinator-id", context);
    expect((await readFile(lifecyclePath, "utf8")).trim()).toBe(
      JSON.stringify({
        method: "turn/completed",
        params: { turn: { id: "original-model-activity" } },
      }),
    );
    await replacement.close({ preserveActivities: true });

    const later = createExecutor();
    await later.beginActivity("later-real-model-activity", context);
    await later.call(
      { operation: "exec", surface: "chrome", code: "return 3;" },
      { ...context, activityBinding: "later-real-model-activity" },
    );
    expect(calls[2]?.turnId).toBe("later-real-model-activity");
    await later.close();

    // Explicit retirement must not resurrect the previously completed state.
    const afterRetirement = createExecutor();
    await afterRetirement.beginActivity("after-retirement", context);
    await afterRetirement.call(
      { operation: "exec", surface: "chrome", code: "return 4;" },
      { ...context, activityBinding: "after-retirement" },
    );
    expect(calls[3]?.turnId).toBe("after-retirement");
    await afterRetirement.close();
  });

  it("persists a directly supplied model activity before nested browser code executes", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-direct-activity-"));
    const lifecycleRoot = join(root, "browser-lifecycles");
    const clientPath = await installBrowserClient(root, "1.0.0");
    await writeFile(
      join(clientPath, "..", "browser-service.mjs"),
      "export const trackerRemoved = true;",
      "utf8",
    );
    const calls: Array<{
      tool: string;
      turnId: string | undefined;
      sessionId: string | undefined;
    }> = [];
    const createExecutor = () =>
      new BrowserNativeExecutor(
        {
          callInContext: async (
            _server,
            tool,
            _args,
            _thread,
            _progress,
            turnId,
            _signal,
            sessionId,
          ) => {
            calls.push({ tool, turnId, sessionId });
            return { ok: true };
          },
        },
        { codexHome: root, browserRolloutSessionsRoot: lifecycleRoot },
      );
    const context = { ownerBinding: "owner", workSessionBinding: "nested-responses" };
    const first = createExecutor();
    // CodeModeNativeToolSurface supplies these fields without beginActivity.
    await first.call(
      { operation: "exec", surface: "chrome", code: "return 1;" },
      {
        ...context,
        activityBinding: "turn:model-1",
        contextTurnId: "model-1",
      },
    );
    await first.close({ preserveActivities: true });
    const replacement = createExecutor();
    await replacement.finishActivity("turn:model-1", context);
    expect(calls.map(({ tool }) => tool)).toEqual(["js", "js", "turn_ended"]);
    expect(calls[2]).toMatchObject({ turnId: "model-1", sessionId: calls[0]?.sessionId });
    const lifecyclePath = join(lifecycleRoot, `rollout-omnicodex-${calls[0]?.sessionId}.jsonl`);
    expect(JSON.parse((await readFile(lifecyclePath, "utf8")).trim())).toEqual({
      method: "turn/completed",
      params: { turn: { id: "model-1" } },
    });
    await replacement.close();
  });

  it("releases restored ownership when actual shutdown precedes any replacement browser call", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-restored-shutdown-"));
    const clientPath = await installBrowserClient(root, "1.0.0");
    await writeFile(
      join(clientPath, "..", "browser-service.mjs"),
      "export const trackerRemoved = true;",
      "utf8",
    );
    const calls: string[] = [];
    const createExecutor = () =>
      new BrowserNativeExecutor(
        {
          callInContext: async (_server, tool) => {
            calls.push(tool);
            return { ok: true };
          },
        },
        { codexHome: root },
      );
    const context = {
      ownerBinding: "owner",
      workSessionBinding: "shutdown",
      continueExistingActivity: true,
    };
    const first = createExecutor();
    await first.call(
      { operation: "exec", surface: "chrome", code: "return 1;" },
      {
        ...context,
        activityBinding: "turn:model-1",
        contextTurnId: "model-1",
      },
    );
    await first.close({ preserveActivities: true });
    const replacement = createExecutor();
    await replacement.beginActivity("turn:replacement", context);
    await replacement.close();
    expect(calls).toEqual(["js", "js", "turn_ended"]);
  });

  it.each([false, true])(
    "settles a restored activity when completion is the first event after replacement (active hook: %s)",
    async (activeHook) => {
      const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-restored-completion-"));
      const lifecycleRoot = join(root, "browser-lifecycles");
      const clientPath = await installBrowserClient(root, "1.0.0");
      if (activeHook)
        await writeFile(
          join(clientPath, "..", "browser-service.mjs"),
          "export const trackerRemoved = true;",
          "utf8",
        );
      let sessionId: string | undefined;
      let dispatchCount = 0;
      const createExecutor = () =>
        new BrowserNativeExecutor(
          {
            callInContext: async (
              _server,
              _tool,
              _args,
              _thread,
              _progress,
              _turn,
              _signal,
              id,
            ) => {
              sessionId = id;
              dispatchCount += 1;
              return { ok: true };
            },
          },
          { codexHome: root, browserRolloutSessionsRoot: lifecycleRoot },
        );
      const context = {
        ownerBinding: "owner",
        workSessionBinding: "completed-web",
      };
      const first = createExecutor();
      await first.beginActivity("completed-model-activity", context);
      await first.call(
        { operation: "exec", surface: "chrome", code: "return 1;" },
        { ...context, activityBinding: "completed-model-activity" },
      );
      await first.close({ preserveActivities: true });
      const lifecyclePath = join(lifecycleRoot, `rollout-omnicodex-${sessionId}.jsonl`);
      expect(await readFile(lifecyclePath, "utf8")).toBe("");

      const replacement = createExecutor();
      await replacement.finishActivity("completed-model-activity", context);
      const outcome = JSON.stringify({
        method: "turn/completed",
        params: { turn: { id: "completed-model-activity" } },
      });
      expect((await readFile(lifecyclePath, "utf8")).trim()).toBe(outcome);
      // Duplicate completion, including another replacement, must not replay
      // code or publish a second native turn ending.
      await replacement.finishActivity("completed-model-activity", context);
      await createExecutor().finishActivity("completed-model-activity", context);
      expect((await readFile(lifecyclePath, "utf8")).trim()).toBe(outcome);
      expect(dispatchCount).toBe(activeHook ? 3 : 1);
    },
  );

  it("does not adopt another owner's persisted browser activity", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-owner-replacement-"));
    await installBrowserClient(root, "1.0.0");
    const calls: Array<{ sessionId?: string; turnId?: string }> = [];
    const createExecutor = () =>
      new BrowserNativeExecutor(
        {
          callInContext: async (
            _server,
            _tool,
            _args,
            _thread,
            _progress,
            turnId,
            _signal,
            sessionId,
          ) => {
            calls.push({
              ...(sessionId === undefined ? {} : { sessionId }),
              ...(turnId === undefined ? {} : { turnId }),
            });
            return { ok: true };
          },
        },
        { codexHome: root },
      );
    const first = createExecutor();
    const a = {
      ownerBinding: "a",
      workSessionBinding: "same-work-name",
      continueExistingActivity: true,
    };
    await first.beginActivity("activity-a", a);
    await first.call(
      { operation: "exec", surface: "chrome", code: "return 1;" },
      { ...a, activityBinding: "activity-a" },
    );
    await first.close({ preserveActivities: true });
    const second = createExecutor();
    const b = { ...a, ownerBinding: "b" };
    await second.beginActivity("activity-b", b);
    await second.call(
      { operation: "exec", surface: "chrome", code: "return 2;" },
      { ...b, activityBinding: "activity-b" },
    );
    expect(calls[1]?.sessionId).not.toBe(calls[0]?.sessionId);
    expect(calls[1]?.turnId).toBe("activity-b");
    await second.close();
  });

  it.each([
    [true, false, true],
    [false, false, true],
    [false, true, true],
    [true, true, true],
    [false, true, false],
    [true, true, false],
  ])(
    "respects unbound turn lifetime with explicit metadata=%s, preservation=%s, durable binding=%s",
    async (explicitTurn, preserveActivities, durable) => {
      const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-unbound-retire-"));
      const lifecycleRoot = join(root, "browser-lifecycles");
      await installBrowserClient(root, "1.0.0");
      const calls: Array<{ sessionId?: string; turnId?: string }> = [];
      const executor = new BrowserNativeExecutor(
        {
          callInContext: async (
            _server,
            _tool,
            _args,
            _contextThreadId,
            _onProgress,
            contextTurnId,
            _signal,
            contextSessionId,
          ) => {
            calls.push({
              ...(contextSessionId === undefined ? {} : { sessionId: contextSessionId }),
              ...(contextTurnId === undefined ? {} : { turnId: contextTurnId }),
            });
            return { ok: true };
          },
        },
        {
          codexHome: root,
          browserRolloutSessionsRoot: lifecycleRoot,
        },
      );

      await executor.call(
        { operation: "exec", surface: "chrome", code: "return 1;" },
        {
          ownerBinding: "owner",
          ...(durable ? { workSessionBinding: "web" } : { callerSessionId: "temporary" }),
          ...(explicitTurn ? { contextTurnId: "native-turn-without-activity" } : {}),
        },
      );

      const sessionId = calls[0]?.sessionId;
      const turnId = calls[0]?.turnId;
      expect(turnId).toBeDefined();
      if (explicitTurn) expect(turnId).toBe("native-turn-without-activity");
      else expect(turnId).toMatch(/^[a-f0-9-]{36}$/);
      expect(sessionId).toMatch(/^omnicodex_browser_[a-f0-9]{64}$/u);
      if (sessionId === undefined) throw new Error("browser session id was not forwarded");
      const lifecyclePath = join(lifecycleRoot, `rollout-omnicodex-${sessionId}.jsonl`);
      expect(await readFile(lifecyclePath, "utf8")).toBe("");

      await executor.close({ preserveActivities });

      expect(calls).toHaveLength(1);
      expect((await readFile(lifecyclePath, "utf8")).trim()).toBe(
        preserveActivities && durable
          ? ""
          : JSON.stringify({
              type: "event_msg",
              payload: { type: "turn_aborted", turn_id: turnId },
            }),
      );
    },
  );

  it("adopts stable unbound turns after replacement and retires them only on real shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-unbound-adoption-"));
    const lifecycleRoot = join(root, "browser-lifecycles");
    await installBrowserClient(root, "1.0.0");
    const calls: Array<{ sessionId?: string; turnId?: string }> = [];
    const createExecutor = () =>
      new BrowserNativeExecutor(
        {
          callInContext: async (
            _server,
            _tool,
            _args,
            _contextThreadId,
            _onProgress,
            turnId,
            _signal,
            sessionId,
          ) => {
            calls.push({
              ...(sessionId === undefined ? {} : { sessionId }),
              ...(turnId === undefined ? {} : { turnId }),
            });
            return { ok: true };
          },
        },
        { codexHome: root, browserRolloutSessionsRoot: lifecycleRoot },
      );
    const context = {
      ownerBinding: "owner",
      workSessionBinding: "work-session",
    };
    const first = createExecutor();
    await first.call({ operation: "exec", surface: "chrome", code: "return 1;" }, context);
    const lifecyclePath = join(lifecycleRoot, `rollout-omnicodex-${calls[0]?.sessionId}.jsonl`);
    await first.close({ preserveActivities: true });
    expect(await readFile(lifecyclePath, "utf8")).toBe("");
    const replacement = createExecutor();
    await replacement.call({ operation: "exec", surface: "chrome", code: "return 2;" }, context);
    expect(calls[1]?.sessionId).toBe(calls[0]?.sessionId);
    expect(await readFile(lifecyclePath, "utf8")).toBe("");
    await replacement.close();
    const endings = (await readFile(lifecyclePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(endings).toEqual(
      calls.map(({ turnId }) => ({
        type: "event_msg",
        payload: { type: "turn_aborted", turn_id: turnId },
      })),
    );
    const later = createExecutor();
    await later.call({ operation: "exec", surface: "chrome", code: "return 3;" }, context);
    await later.close();
    expect((await readFile(lifecyclePath, "utf8")).trim().split("\n")).toHaveLength(3);
  });

  it("retries failed retirement without repeating successfully published turn endings", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-retirement-retry-"));
    const lifecycleRoot = join(root, "browser-lifecycles");
    await installBrowserClient(root, "1.0.0");
    const sessions: string[] = [];
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (
          _server,
          _tool,
          _args,
          _thread,
          _progress,
          _turn,
          _signal,
          session,
        ) => {
          if (session === undefined) throw new Error("Missing browser session");
          sessions.push(session);
          return { ok: true };
        },
      },
      { codexHome: root, browserRolloutSessionsRoot: lifecycleRoot },
    );
    for (const workSessionBinding of ["first", "second"]) {
      await executor.call(
        { operation: "exec", surface: "chrome", code: "return 1;" },
        {
          ownerBinding: "owner",
          workSessionBinding,
          contextTurnId: `turn-${workSessionBinding}`,
        },
      );
    }
    const firstPath = join(lifecycleRoot, `rollout-omnicodex-${sessions[0]}.jsonl`);
    const secondPath = join(lifecycleRoot, `rollout-omnicodex-${sessions[1]}.jsonl`);
    // Simulate one unavailable rollout without mocking away real filesystem writes.
    await rename(secondPath, `${secondPath}.saved`);
    await mkdir(secondPath);
    const failed = await Promise.allSettled([executor.close(), executor.close()]);
    expect(failed.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    const firstPublished = await readFile(firstPath, "utf8");
    expect(firstPublished.trim().split("\n")).toHaveLength(1);

    await rmdir(secondPath);
    await rename(`${secondPath}.saved`, secondPath);
    await executor.close();
    await executor.close();
    expect(await readFile(firstPath, "utf8")).toBe(firstPublished);
    expect((await readFile(secondPath, "utf8")).trim()).toBe(
      JSON.stringify({
        type: "event_msg",
        payload: { type: "turn_aborted", turn_id: "turn-second" },
      }),
    );
  });

  it("keeps consecutive remote browser calls in one native activity despite per-call traces", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-related-calls-"));
    await installBrowserClient(root, "1.0.0");
    const calls: string[] = [];
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args) => {
          calls.push(String((args as Record<string, unknown>).code));
          return { ok: true };
        },
      },
      { codexHome: root, resolveContextThreadId: async () => "browser-host" },
    );
    const conversation = {
      ownerBinding: "owner",
      workSessionBinding: "web",
    } as const;

    await executor.beginActivity("turn:transport-a", conversation);
    await executor.call(
      { operation: "exec", surface: "chrome", code: "return 'first';" },
      { ...conversation, activityBinding: "turn:transport-a" },
    );
    await executor.beginActivity("turn:transport-b", {
      ...conversation,
      continueExistingActivity: true,
    });
    await executor.call(
      { operation: "exec", surface: "chrome", code: "return 'second';" },
      { ...conversation, activityBinding: "turn:transport-b" },
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("__omniAgent.browsers.getDefault()");
    expect(calls[1]).not.toContain("get_visible_dom");
    expect(calls[1]).toContain("BROWSER_HANDLE_STALE");

    await executor.beginActivity("turn:non-browser", conversation);
    expect(calls).toHaveLength(2);
  });

  it("forgets an activity that finishes before it owns browser state", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-empty-activity-"));
    await installBrowserClient(root, "1.0.0");
    const calls: string[] = [];
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args) => {
          calls.push(String((args as Record<string, unknown>).code));
          return { ok: true };
        },
      },
      { codexHome: root, resolveContextThreadId: async () => "browser-host" },
    );
    const conversation = {
      ownerBinding: "owner",
      workSessionBinding: "web",
    } as const;

    await executor.beginActivity("turn:finished-before-call", conversation);
    await executor.finishActivity("turn:finished-before-call", conversation);
    await executor.beginActivity("turn:next", {
      ...conversation,
      continueExistingActivity: true,
    });
    await executor.call(
      { operation: "exec", surface: "chrome", code: "return 'next';" },
      { ...conversation, activityBinding: "turn:next" },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("__omniAgent.browsers.getDefault()");
    expect(calls[0]).not.toContain("turn:finished-before-call");
  });

  it("forwards the native browser object without automatic claiming, DOM scans, or tab substitution", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-lifecycle-"));
    const script = join(
      root,
      "plugins",
      "cache",
      "openai-bundled",
      "chrome",
      "1.0.0",
      "scripts",
      "browser-client.mjs",
    );
    await mkdir(join(script, ".."), { recursive: true });
    await writeFile(
      script,
      "export const setupBrowserRuntime = async () => globalThis.__omniBrowserLifecycleTestAgent;",
      "utf8",
    );

    const tabs = new Map<string, ReturnType<typeof createLifecycleTab>>();
    const closed: string[] = [];
    const created: string[] = [];
    const createTab = (
      id: string,
      options: {
        readonly url?: string;
        readonly dom?: string;
        readonly onDomRead?: () => void;
      } = {},
    ) => {
      const tab = createLifecycleTab(
        id,
        () => {
          closed.push(id);
          tabs.delete(id);
        },
        options,
      );
      tabs.set(id, tab);
      return tab;
    };
    const userTab = createTab("user-existing");
    const detachedUserTab = createLifecycleTab("user-detached", () => {
      closed.push("user-detached");
      tabs.delete("user-detached");
    });
    const additionalUserTabs: Array<ReturnType<typeof createLifecycleTab>> = [];
    let rawClaimCalls = 0;
    let browserSelectionCalls = 0;
    const browser = {
      browserId: "1",
      documentation: async () => "browser docs",
      tabs: {
        list: async () => [...tabs.values()],
        get: async (id: string) => {
          const tab = tabs.get(String(id));
          if (tab === undefined) throw new Error(`missing tab ${id}`);
          return tab;
        },
        new: async () => {
          const id = `owned-${created.length + 1}`;
          created.push(id);
          return createTab(id);
        },
      },
      user: {
        openTabs: async () => [userTab, detachedUserTab, ...additionalUserTabs],
        claimTab: async (tab: ReturnType<typeof createLifecycleTab>) => {
          rawClaimCalls += 1;
          if (tabs.has(tab.id)) {
            throw new Error(`Tab ${tab.id} is already part of browser session test-session`);
          }
          tabs.set(tab.id, tab);
          return tab;
        },
      },
    };
    const runtimeGlobals = globalThis as typeof globalThis & {
      __omniBrowserLifecycleTestAgent?: unknown;
      __omniCodexBrowserPhysicalRuntimes?: unknown;
      __omniCodexBrowserRuntimes?: unknown;
    };
    runtimeGlobals.__omniBrowserLifecycleTestAgent = {
      browsers: {
        list: async () => [{ id: "1", type: "extension", family: "chrome" }],
        get: async () => {
          browserSelectionCalls += 1;
          return browser;
        },
        getDefault: async () => {
          browserSelectionCalls += 1;
          return browser;
        },
      },
    };
    delete runtimeGlobals.__omniCodexBrowserPhysicalRuntimes;
    delete runtimeGlobals.__omniCodexBrowserRuntimes;
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
      ...parameters: string[]
    ) => (...args: unknown[]) => Promise<unknown>;
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args) => {
          const code = (args as { code: string }).code;
          const bindingLiteral = code.match(
            /const __omniBrowserRuntimeBinding = ("(?:[^"\\]|\\.)*");/u,
          )?.[1];
          if (bindingLiteral === undefined)
            throw new Error("browser runtime binding was not emitted");
          const runtimeBinding = JSON.parse(bindingLiteral) as string;
          const runtimes =
            runtimeGlobals.__omniCodexBrowserRuntimes instanceof Map
              ? runtimeGlobals.__omniCodexBrowserRuntimes
              : new Map<string, unknown>();
          runtimeGlobals.__omniCodexBrowserRuntimes = runtimes;
          if (!runtimes.has(runtimeBinding)) {
            runtimes.set(runtimeBinding, {
              agent: runtimeGlobals.__omniBrowserLifecycleTestAgent,
            });
          }
          let written: unknown;
          const evaluate = new AsyncFunction("nodeRepl", code);
          await evaluate({ write: (value: unknown) => (written = value) });
          return {
            content: [
              {
                type: "text",
                text: typeof written === "string" ? written : JSON.stringify(written),
              },
            ],
          };
        },
      },
      { codexHome: root, resolveContextThreadId: async () => "browser-host" },
    );
    const conversation = {
      ownerBinding: "owner-a",
      workSessionBinding: "work-a",
    } as const;
    const context = {
      ...conversation,
      activityBinding: "turn:web-a",
    } as const;

    try {
      await executor.beginActivity("turn:web-a", conversation);
      await executor.call(
        {
          operation: "exec",
          surface: "chrome",
          code: 'return (await browser.tabs.get("user-existing")).id;',
        },
        context,
      );
      expect(rawClaimCalls).toBe(0);

      await executor.call(
        {
          operation: "exec",
          surface: "chrome",
          code: [
            'const tab = (await browser.user.openTabs()).find((item) => item.id === "user-detached");',
            "return (await browser.user.claimTab(tab)).id;",
          ].join("\n"),
        },
        context,
      );
      expect(rawClaimCalls).toBe(1);

      const conversationUrl =
        "https://chatgpt.com/g/g-p-project/c/6a96db78-e8f8-83ee-a192-0ac5d8cd4f20";
      let heavyDomReads = 0;
      createTab("conversation-stale", {
        url: conversationUrl,
        dom: 'heading "나의 말:"\nheading "ChatGPT의 말:"',
        onDomRead: () => {
          heavyDomReads += 1;
        },
      });
      const detachedConversationActive = createLifecycleTab(
        "conversation-active",
        () => {
          closed.push("conversation-active");
          tabs.delete("conversation-active");
        },
        {
          url: `${conversationUrl}?messageId=latest`,
          dom: [
            'heading "나의 말:"',
            'heading "ChatGPT의 말:"',
            'heading "나의 말:"',
            '<button aria-disabled="false" aria-label="답변 중지" />',
          ].join("\n"),
          onDomRead: () => {
            heavyDomReads += 1;
          },
        },
      );
      additionalUserTabs.push(detachedConversationActive);
      const canonicalResult = await executor.call(
        {
          operation: "exec",
          surface: "chrome",
          code: 'return (await browser.tabs.get("conversation-stale")).id;',
        },
        context,
      );
      expect(canonicalResult).toEqual({
        content: [{ type: "text", text: "conversation-stale" }],
      });
      expect(rawClaimCalls).toBe(1);
      expect(heavyDomReads).toBe(0);
      const cachedCanonicalResult = await executor.call(
        {
          operation: "exec",
          surface: "chrome",
          code: 'return (await browser.tabs.get("conversation-stale")).id;',
        },
        context,
      );
      expect(cachedCanonicalResult).toEqual({
        content: [{ type: "text", text: "conversation-stale" }],
      });
      expect(rawClaimCalls).toBe(1);
      expect(heavyDomReads).toBe(0);
      tabs.delete("conversation-stale");
      additionalUserTabs.length = 0;

      await executor.call(
        {
          operation: "exec",
          surface: "chrome",
          code: [
            "const first = await browser.tabs.new();",
            "const second = await browser.tabs.new();",
            "return [first.id, second.id];",
          ].join("\n"),
        },
        context,
      );
      expect([...tabs.keys()]).toEqual(["user-existing", "user-detached", "owned-1", "owned-2"]);

      await executor.call(
        {
          operation: "exec",
          surface: "chrome",
          code: "return (await browser.tabs.list()).map((tab) => tab.id);",
        },
        context,
      );
      expect([...tabs.keys()]).toEqual(["user-existing", "user-detached", "owned-1", "owned-2"]);
      expect(closed).toEqual([]);

      await executor.call(
        { operation: "list_tabs", surface: "chrome" },
        { ownerBinding: "owner-a", workSessionBinding: "work-b" },
      );
      expect(
        runtimeGlobals.__omniCodexBrowserRuntimes instanceof Map
          ? runtimeGlobals.__omniCodexBrowserRuntimes.size
          : 0,
      ).toBe(2);
      expect(
        runtimeGlobals.__omniCodexBrowserPhysicalRuntimes instanceof Map
          ? runtimeGlobals.__omniCodexBrowserPhysicalRuntimes.size
          : 0,
      ).toBe(2);

      await executor.call(
        {
          operation: "exec",
          surface: "chrome",
          code: 'return (await browser.tabs.get("owned-1")).id;',
        },
        context,
      );
      expect([...tabs.keys()]).toEqual(["user-existing", "user-detached", "owned-1", "owned-2"]);
      expect(closed).toEqual([]);

      // The bridge only publishes the first-party turn lifecycle. It does not
      // issue a second browser call or close tabs itself; the installed Browser
      // Use tracker owns native cleanup semantics.
      await executor.beginActivity("turn:web-b", conversation);
      expect([...tabs.keys()]).toEqual(["user-existing", "user-detached", "owned-1", "owned-2"]);
      expect(closed).toEqual([]);
      expect(browserSelectionCalls).toBe(8);
    } finally {
      delete runtimeGlobals.__omniBrowserLifecycleTestAgent;
      delete runtimeGlobals.__omniCodexBrowserPhysicalRuntimes;
      delete runtimeGlobals.__omniCodexBrowserRuntimes;
    }
  });

  it("annotates user tabs with session attachment state so callers do not reclaim owned tabs", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    const script = join(
      root,
      "plugins",
      "cache",
      "openai-bundled",
      "chrome",
      "1.0.0",
      "scripts",
      "browser-client.mjs",
    );
    await mkdir(join(script, ".."), { recursive: true });
    await writeFile(script, "export const setupBrowserRuntime = async () => ({});", "utf8");
    const calls: Array<{ args: Record<string, unknown> }> = [];
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args) => {
          calls.push({ args: args as Record<string, unknown> });
          return { content: [] };
        },
      },
      { codexHome: root, resolveContextThreadId: async () => "browser-host" },
    );

    await executor.call({ operation: "list_user_tabs", surface: "chrome" });

    expect(calls[0]?.args.code).toContain("const __omniAttachedIds = new Set");
    expect(calls[0]?.args.code).toContain("attachedToThisSession");
    expect(calls[0]?.args.code).toContain("await browser.user.openTabs()");
  });

  it("gives each Web work session an independent stable Chrome session id", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    await installBrowserClient(root, "1.0.0");
    await installProtectedBrowserDocuments(root);
    const sessions: Array<string | undefined> = [];
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (
          _server,
          _tool,
          _args,
          _contextThreadId,
          _onProgress,
          _contextTurnId,
          _signal,
          contextSessionId,
        ) => {
          sessions.push(contextSessionId);
          return { ok: true };
        },
      },
      {
        codexHome: root,
        resolveContextThreadId: async () => "shared-desktop-host",
      },
    );

    await executor.call(
      { operation: "list_tabs", surface: "chrome" },
      { ownerBinding: "owner", workSessionBinding: "web-a" },
    );
    await executor.call(
      { operation: "list_tabs", surface: "chrome" },
      { ownerBinding: "owner", workSessionBinding: "web-b" },
    );
    await executor.call(
      { operation: "list_tabs", surface: "chrome" },
      { ownerBinding: "owner", workSessionBinding: "web-a" },
    );

    expect(sessions[0]).toMatch(/^omnicodex_browser_[a-f0-9]{64}$/u);
    expect(sessions[1]).toMatch(/^omnicodex_browser_[a-f0-9]{64}$/u);
    expect(sessions[0]).not.toBe(sessions[1]);
    expect(sessions[2]).toBe(sessions[0]);
  });

  it("keeps the Work browser session separate from a Desktop host", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    await installBrowserClient(root, "1.0.0");
    await installProtectedBrowserDocuments(root);
    const sessions: Array<string | undefined> = [];
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (
          _server,
          _tool,
          _args,
          _contextThreadId,
          _onProgress,
          _contextTurnId,
          _signal,
          contextSessionId,
        ) => {
          sessions.push(contextSessionId);
          return { ok: true };
        },
      },
      { codexHome: root, resolveContextThreadId: async () => "desktop-ui-thread" },
    );

    await executor.call(
      { operation: "list_tabs", surface: "chrome" },
      { ownerBinding: "owner", workSessionBinding: "web-a" },
    );

    expect(sessions[0]).toMatch(/^omnicodex_browser_[a-f0-9]{64}$/u);
    expect(sessions[0]).not.toBe("desktop-ui-thread");
  });

  it("keeps Chrome and extension identity app-global without requiring an IAB task", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    const script = join(
      root,
      "plugins",
      "cache",
      "openai-bundled",
      "browser",
      "1.0.0",
      "scripts",
      "browser-client.mjs",
    );
    await mkdir(join(script, ".."), { recursive: true });
    await writeFile(script, "export const setupBrowserRuntime = async () => ({});", "utf8");
    const directCalls: Array<{
      server: string;
      tool: string;
      args: Record<string, unknown>;
      threadId?: string;
    }> = [];
    const nativeExecutor = {
      callInContext: async (
        server: string,
        tool: string,
        args: Record<string, unknown>,
        contextThreadId?: string,
      ) => {
        directCalls.push({
          server,
          tool,
          args,
          ...(contextThreadId === undefined ? {} : { threadId: contextThreadId }),
        });
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const executor = new BrowserNativeExecutor(nativeExecutor, {
      codexHome: root,
    });

    await executor.call({ operation: "list_surfaces" });
    await executor.call({
      operation: "exec",
      surface: "chrome",
      code: "return 'chrome';",
    });
    await executor.call({
      operation: "exec",
      surface: "extension",
      code: "return 'extension';",
    });

    expect(directCalls).toHaveLength(3);
    expect(directCalls.every((call) => call.threadId === undefined)).toBe(true);
    expect(directCalls[1]?.args.code).toContain("__omniAgent.browsers.getDefault()");
    expect(directCalls[2]?.args.code).toContain('__omniAgent.browsers.get("extension")');
  });

  it("forwards cancellation to the underlying first-party browser call", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    await installBrowserClient(root, "1.0.0");
    const controller = new AbortController();
    const observedContexts: Array<{
      signal: AbortSignal | undefined;
      turnId: string | undefined;
    }> = [];
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (
          _server,
          _tool,
          _args,
          _contextThreadId,
          _onProgress,
          _contextTurnId,
          signal,
        ) => {
          observedContexts.push({ signal, turnId: _contextTurnId });
          return { ok: true };
        },
      },
      { codexHome: root },
    );

    await executor.call(
      { operation: "list_surfaces" },
      { contextTurnId: "native-turn", signal: controller.signal },
    );

    expect(observedContexts).toHaveLength(1);
    expect(observedContexts[0]?.turnId).toBe("native-turn");
    expect(observedContexts[0]?.signal).toBeDefined();
    controller.abort(new Error("caller cancelled after dispatch"));
    expect(observedContexts[0]?.signal?.aborted).toBe(true);
    expect(observedContexts[0]?.signal?.reason).toEqual(
      new Error("caller cancelled after dispatch"),
    );
  });

  it("applies the declared 90 second default to the whole browser call", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    await installBrowserClient(root, "1.0.0");
    let observedBoundary: BrowserNativeContextBoundary | undefined;
    let observedNativeTimeout: unknown;
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args) => {
          observedNativeTimeout = (args as Record<string, unknown>).timeout_ms;
          return { ok: true };
        },
      },
      {
        codexHome: root,
        resolveContextThreadId: async (_request, boundary) => {
          observedBoundary = boundary;
          return "global-browser-host";
        },
      },
    );

    const startedAt = Date.now();
    await executor.call({ operation: "list_surfaces" });

    expect(observedBoundary?.deadlineUnixMs).toEqual(expect.any(Number));
    expect((observedBoundary?.deadlineUnixMs as number) - startedAt).toBeGreaterThan(60_000);
    expect((observedBoundary?.deadlineUnixMs as number) - startedAt).toBeLessThanOrEqual(90_000);
    expect(observedNativeTimeout).toEqual(expect.any(Number));
    expect(observedNativeTimeout as number).toBeGreaterThan(60_000);
    expect(observedNativeTimeout as number).toBeLessThanOrEqual(90_000);
  });

  it("returns at the browser deadline even when native execution ignores cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    await installBrowserClient(root, "1.0.0");
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async () => new Promise<never>(() => undefined),
      },
      {
        codexHome: root,
        resolveContextThreadId: async () => "global-browser-host",
      },
    );

    await expect(executor.call({ operation: "list_surfaces", timeout_ms: 20 })).rejects.toThrow(
      "Browser call deadline exceeded",
    );
  });

  it("observes a native rejection when the browser deadline was already reached", async () => {
    const deadline = new Error("Browser call deadline exceeded");
    const controller = new AbortController();
    controller.abort(deadline);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const native = Promise.reject(new Error("late native rejection"));
      await expect(waitForBrowserBoundary(native, controller.signal)).rejects.toBe(deadline);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("propagates the caller boundary through context discovery and preserves the remaining deadline for dispatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    await installBrowserClient(root, "1.0.0");
    const controller = new AbortController();
    const deadlineUnixMs = Date.now() + 10_000;
    let observedBoundary: BrowserNativeContextBoundary | undefined;
    let observedNativeSignal: AbortSignal | undefined;
    let observedNativeTimeout: unknown;
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (
          _server,
          _tool,
          args,
          _contextThreadId,
          _onProgress,
          _contextTurnId,
          signal,
        ) => {
          observedNativeSignal = signal;
          observedNativeTimeout = (args as Record<string, unknown>).timeout_ms;
          return { ok: true };
        },
      },
      {
        codexHome: root,
        resolveContextThreadId: async (_request, boundary) => {
          observedBoundary = boundary;
          return "global-browser-host";
        },
      },
    );

    await executor.call(
      { operation: "list_surfaces" },
      { signal: controller.signal, deadlineUnixMs },
    );

    expect(observedBoundary?.deadlineUnixMs).toBe(deadlineUnixMs);
    expect(observedBoundary?.signal).toBe(observedNativeSignal);
    expect(observedNativeTimeout).toEqual(expect.any(Number));
    expect(observedNativeTimeout as number).toBeGreaterThan(0);
    expect(observedNativeTimeout as number).toBeLessThanOrEqual(10_000);
    controller.abort(new Error("caller cancelled after completion"));
    expect(observedBoundary?.signal?.aborted).toBe(true);
  });

  it("binds IAB to the exact verified task and partitions runtime state by owner/work session", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    const script = join(
      root,
      "plugins",
      "cache",
      "openai-bundled",
      "browser",
      "1.0.0",
      "scripts",
      "browser-client.mjs",
    );
    await mkdir(join(script, ".."), { recursive: true });
    await writeFile(script, "export const setupBrowserRuntime = async () => ({});", "utf8");
    const calls: Array<{ threadId?: string; code?: unknown }> = [];
    const contextRequests: BrowserNativeContextRequest[] = [];
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args, contextThreadId) => {
          calls.push({
            ...(contextThreadId === undefined ? {} : { threadId: contextThreadId }),
            code: (args as Record<string, unknown>).code,
          });
          return { ok: true };
        },
      },
      {
        codexHome: root,
        resolveContextThreadId: async (request) => {
          contextRequests.push(request);
          return request.contextThreadId;
        },
      },
    );

    await executor.call(
      { operation: "exec", surface: "iab", code: "return 'iab-a';" },
      {
        contextThreadId: "codex-thread-a",
        ownerBinding: "owner-a",
        workSessionBinding: "work-a",
      },
    );
    await executor.call(
      { operation: "exec", surface: "iab", code: "return 'iab-b';" },
      {
        contextThreadId: "codex-thread-b",
        ownerBinding: "owner-b",
        workSessionBinding: "work-b",
      },
    );

    expect(calls.map(({ threadId }) => ({ threadId }))).toEqual([
      { threadId: "codex-thread-a" },
      { threadId: "codex-thread-b" },
    ]);
    expect(calls[0]?.code).toContain('const __omniContextThreadId = "codex-thread-a"');
    expect(calls[1]?.code).toContain('const __omniContextThreadId = "codex-thread-b"');
    expect(calls[1]?.code).toContain("globalThis.__omniCodexBrowserRuntimes");
    expect(calls[1]?.code).not.toContain("globalThis.agent = undefined");
    expect(calls[1]?.code).not.toContain("globalThis.__omniCodexInAppBrowser");
    const runtimeBindings = calls.map(
      ({ code }) =>
        String(code).match(/const __omniBrowserRuntimeBinding = "([a-f0-9]{64})"/u)?.[1],
    );
    expect(runtimeBindings[0]).toEqual(expect.any(String));
    expect(runtimeBindings[1]).toEqual(expect.any(String));
    expect(runtimeBindings[0]).not.toBe(runtimeBindings[1]);
    expect(
      calls.every(
        ({ code }) => !String(code).includes("owner-") && !String(code).includes("work-"),
      ),
    ).toBe(true);
    expect(contextRequests).toEqual([
      expect.objectContaining({
        contextThreadId: "codex-thread-a",
        ownerBinding: "owner-a",
        workSessionBinding: "work-a",
      }),
      expect.objectContaining({
        contextThreadId: "codex-thread-b",
        ownerBinding: "owner-b",
        workSessionBinding: "work-b",
      }),
    ]);
  });

  it("uses one desktop Chrome host while isolating Web Browser Use sessions and runtimes", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    await installBrowserClient(root, "1.0.0");
    const calls: Array<{ contextSessionId?: string; code: string }> = [];
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (
          _server,
          _tool,
          args,
          _contextThreadId,
          _onProgress,
          _contextTurnId,
          _signal,
          contextSessionId,
        ) => {
          calls.push({
            ...(contextSessionId === undefined ? {} : { contextSessionId }),
            code: String((args as Record<string, unknown>).code),
          });
          return { ok: true };
        },
      },
      {
        codexHome: root,
        resolveContextThreadId: async () => "global-browser-host",
      },
    );

    await executor.call(
      { operation: "list_tabs", surface: "chrome" },
      { ownerBinding: "owner-a", workSessionBinding: "work-a" },
    );
    await executor.call(
      { operation: "list_tabs", surface: "chrome" },
      { ownerBinding: "owner-a", workSessionBinding: "work-b" },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.contextSessionId).toMatch(/^omnicodex_browser_[a-f0-9]{64}$/u);
    expect(calls[1]?.contextSessionId).toMatch(/^omnicodex_browser_[a-f0-9]{64}$/u);
    expect(calls[0]?.contextSessionId).not.toBe(calls[1]?.contextSessionId);
    const runtimeBindings = calls.map(
      ({ code }) => code.match(/const __omniBrowserRuntimeBinding = "([a-f0-9]{64})"/u)?.[1],
    );
    expect(runtimeBindings[0]).not.toBe(runtimeBindings[1]);
  });

  it("does not impose adapter length caps on opaque browser identity bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    await installBrowserClient(root, "1.0.0");
    const contextRequests: BrowserNativeContextRequest[] = [];
    const executor = new BrowserNativeExecutor(
      { callInContext: async () => ({ ok: true }) },
      {
        codexHome: root,
        resolveContextThreadId: async (request) => {
          contextRequests.push(request);
          return request.contextThreadId;
        },
      },
    );
    const contextThreadId = `thread-${"t".repeat(1_024)}`;
    const ownerBinding = `owner-${"o".repeat(12_000)}`;
    const workSessionBinding = `work-${"w".repeat(12_000)}`;
    const callerSessionId = `caller-${"c".repeat(12_000)}`;

    await expect(
      executor.call(
        { operation: "exec", surface: "iab", code: "return true;" },
        { contextThreadId, ownerBinding, workSessionBinding, callerSessionId },
      ),
    ).resolves.toEqual({ ok: true });
    expect(contextRequests).toEqual([
      expect.objectContaining({
        contextThreadId,
        ownerBinding,
        workSessionBinding,
        callerSessionId,
      }),
    ]);
  });

  it("re-discovers the latest browser client and retries read-only surface discovery once after a returned data-session termination", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    const firstScript = await installBrowserClient(root, "1.0.0");
    const calls: Array<{ args: Record<string, unknown>; threadId?: string }> = [];
    let operationAttempts = 0;
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args, contextThreadId) => {
          const typedArgs = args as Record<string, unknown>;
          calls.push({
            args: typedArgs,
            ...(contextThreadId === undefined ? {} : { threadId: contextThreadId }),
          });
          if (typedArgs.title === "Reconnect first-party browser runtime") {
            return {
              isError: false,
              content: [{ type: "text", text: "reconnected" }],
            };
          }
          operationAttempts += 1;
          if (operationAttempts === 1) {
            const latestScript = await installBrowserClient(root, "2.0.0");
            const future = new Date(Date.now() + 60_000);
            await utimes(latestScript, future, future);
            return {
              isError: true,
              content: [{ type: "text", text: "Browser data session was terminated" }],
            };
          }
          return { ok: true, value: "recovered" };
        },
      },
      {
        codexHome: root,
        environment: "training",
        resolveContextThreadId: async () => "global-browser-host",
      },
    );

    await expect(executor.call({ operation: "list_surfaces" })).resolves.toEqual({
      ok: true,
      value: "recovered",
    });

    expect(calls).toHaveLength(3);
    expect(calls.map(({ threadId }) => threadId)).toEqual([
      "global-browser-host",
      "global-browser-host",
      "global-browser-host",
    ]);
    const initialCode = String(calls[0]?.args.code);
    const recoveryCode = String(calls[1]?.args.code);
    const retryCode = String(calls[2]?.args.code);
    expect(initialCode).toContain(pathToImportFragment(firstScript));
    expect(recoveryCode).toContain("browser/2.0.0/scripts/browser-client.mjs");
    expect(recoveryCode).toContain("omnicodex_recovery=1");
    expect(initialCode).toContain('const __omniBrowserEnvironment = "training";');
    expect(recoveryCode).toContain('const __omniBrowserEnvironment = "training";');
    expect(
      recoveryCode.match(/setupBrowserRuntime\(\{ environment: __omniBrowserEnvironment \}\)/gu),
    ).toHaveLength(1);
    expect(recoveryCode).toContain("__omniPhysicalRuntime.agent = undefined");
    expect(recoveryCode).toContain("runtime.agent = undefined");
    expect(recoveryCode).not.toContain("globalThis.agent = undefined");
    expect(recoveryCode).not.toContain("globalThis.__omniCodexChrome");
    expect(recoveryCode).not.toContain("globalThis.__omniCodexInAppBrowser");
    expect(retryCode).toContain("__omniAgent.browsers.list()");
  });

  it.each(["Chrome data session was terminated", "Browser is not available: 1"])(
    "reconnects a server-generated Chrome user-tab read after %s without replaying caller code",
    async (failure) => {
      const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
      await installBrowserClient(root, "1.0.0");
      await installProtectedBrowserDocuments(root);
      const calls: Array<Record<string, unknown>> = [];
      let readAttempts = 0;
      const executor = new BrowserNativeExecutor(
        {
          callInContext: async (_server, _tool, args) => {
            const typedArgs = args as Record<string, unknown>;
            calls.push(typedArgs);
            if (typedArgs.title === "Reconnect first-party browser runtime") return { ok: true };
            readAttempts += 1;
            if (readAttempts === 1) {
              return {
                isError: true,
                content: [{ type: "text", text: failure }],
              };
            }
            return { ok: true, tabs: [{ id: "tab-1", title: "Recovered" }] };
          },
        },
        {
          codexHome: root,
          resolveContextThreadId: async () => "global-browser-host",
        },
      );

      await expect(
        executor.call({
          operation: "list_user_tabs",
          surface: "chrome",
          code: "throw new Error('caller code must never run');",
        }),
      ).resolves.toEqual({
        ok: true,
        tabs: [{ id: "tab-1", title: "Recovered" }],
      });

      expect(calls).toHaveLength(3);
      const operationCodes = calls
        .filter((args) => args.title !== "Reconnect first-party browser runtime")
        .map((args) => String(args.code));
      expect(operationCodes).toHaveLength(2);
      expect(operationCodes.every((code) => code.includes("browser.user.openTabs()"))).toBe(true);
      expect(operationCodes.every((code) => !code.includes("caller code must never run"))).toBe(
        true,
      );
    },
  );

  it("promotes only an exact legacy standalone tab read from cached clients", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    await installBrowserClient(root, "1.0.0");
    const calls: Array<Record<string, unknown>> = [];
    let readAttempts = 0;
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args) => {
          const typedArgs = args as Record<string, unknown>;
          calls.push(typedArgs);
          if (typedArgs.title === "Reconnect first-party browser runtime") return { ok: true };
          readAttempts += 1;
          if (readAttempts === 1) throw new Error("Chrome extension disconnected");
          return { ok: true, tabs: [] };
        },
      },
      {
        codexHome: root,
        resolveContextThreadId: async () => "global-browser-host",
      },
    );

    await expect(
      executor.call({
        surface: "chrome",
        code: "return await browser.user.openTabs();",
      }),
    ).resolves.toEqual({ ok: true, tabs: [] });
    expect(calls).toHaveLength(3);
    expect(String(calls[0]?.code)).toContain("browser.user.openTabs()");
    expect(String(calls[2]?.code)).toContain("browser.user.openTabs()");
  });

  it.each(["Chrome extension disconnected", "Browser is not available: 1"])(
    "rebinds after exec reports %s but never replays browser code with an unknown outcome",
    async (failure) => {
      const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
      await installBrowserClient(root, "1.0.0");
      const calls: Array<Record<string, unknown>> = [];
      const stages: BrowserNativeExecutionStage[] = [];
      const executor = new BrowserNativeExecutor(
        {
          callInContext: async (_server, _tool, args) => {
            const typedArgs = args as Record<string, unknown>;
            calls.push(typedArgs);
            if (typedArgs.title === "Reconnect first-party browser runtime") return { ok: true };
            return {
              isError: true,
              content: [{ type: "text", text: failure }],
            };
          },
        },
        {
          codexHome: root,
          resolveContextThreadId: async (request) =>
            request.operation === "exec" && request.surface === "iab"
              ? request.contextThreadId
              : "global-browser-host",
        },
      );

      await expect(
        executor.call(
          {
            operation: "exec",
            surface: "chrome",
            code: "await browser.tabs.new(); return 'mutation-finished';",
          },
          {
            observeExecutionStage: (stage) => {
              stages.push(stage);
              throw new Error("diagnostic observer failed");
            },
          },
        ),
      ).rejects.toThrow("BROWSER_OUTCOME_UNKNOWN_REBOUND");

      expect(calls).toHaveLength(2);
      expect(stages).toEqual([
        "runtime_setup",
        "native_dispatch",
        "native_returned",
        "runtime_recovery",
      ]);
      expect(String(calls[0]?.code).match(/mutation-finished/gu)).toHaveLength(1);
      expect(String(calls[0]?.code)).toContain("__omniAgent.browsers.getDefault()");
      expect(String(calls[1]?.code)).not.toContain("mutation-finished");
    },
  );

  it("recovers and retries exec once when Chrome fails before caller code is dispatched", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    await installBrowserClient(root, "1.0.0");
    const calls: Array<Record<string, unknown>> = [];
    const turns: Array<string | undefined> = [];
    let operationAttempts = 0;
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args, _thread, _progress, turnId) => {
          const typedArgs = args as Record<string, unknown>;
          calls.push(typedArgs);
          turns.push(turnId);
          if (typedArgs.title === "Reconnect first-party browser runtime") return { ok: true };
          operationAttempts += 1;
          if (operationAttempts === 1) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "BROWSER_PRE_DISPATCH_FAILED: Connection failed.",
                },
              ],
            };
          }
          return { ok: true, value: "caller-ran-once" };
        },
      },
      {
        codexHome: root,
        resolveContextThreadId: async () => "global-browser-host",
      },
    );

    await expect(
      executor.call({
        operation: "exec",
        surface: "chrome",
        code: "await browser.tabs.new(); return 'caller-ran-once';",
      }),
    ).resolves.toEqual({ ok: true, value: "caller-ran-once" });

    expect(calls).toHaveLength(3);
    expect(turns[0]).toBeTypeOf("string");
    expect(turns).toEqual([turns[0], turns[0], turns[0]]);
    expect(String(calls[0]?.code)).toContain("BROWSER_PRE_DISPATCH_FAILED: ");
    expect(String(calls[0]?.code)).toContain("caller-ran-once");
    expect(String(calls[1]?.code)).not.toContain("caller-ran-once");
    expect(String(calls[2]?.code)).toContain("caller-ran-once");
  });

  it.each([
    "BROWSER_PRE_DISPATCH_FAILED: Browser is not available: chrome",
    "Browser is not available: 1",
    "BROWSER_PRE_DISPATCH_FAILED: CHROME_SURFACE_UNAVAILABLE: no Chrome profile is connected",
  ])(
    "restores an unavailable Chrome surface after %s before refreshing a read",
    async (failure) => {
      const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
      await installBrowserClient(root, "1.0.0");
      await installProtectedBrowserDocuments(root);
      const events: string[] = [];
      let operationAttempts = 0;
      const executor = new BrowserNativeExecutor(
        {
          callInContext: async (_server, _tool, args) => {
            const typedArgs = args as Record<string, unknown>;
            if (typedArgs.title === "Reconnect first-party browser runtime") {
              events.push("runtime-refresh");
              return { ok: true };
            }
            operationAttempts += 1;
            if (operationAttempts === 1) {
              if (failure.includes("CHROME_SURFACE_UNAVAILABLE")) {
                expect(String(typedArgs.code)).toContain(
                  "CHROME_SURFACE_UNAVAILABLE: no Chrome profile is connected",
                );
                expect(String(typedArgs.code)).toContain("CHROME_PROFILE_UNAVAILABLE_OR_AMBIGUOUS");
              }
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: failure,
                  },
                ],
              };
            }
            return { ok: true, title: "Loop Chrome" };
          },
        },
        {
          codexHome: root,
          resolveContextThreadId: async () => "global-browser-host",
          surfaceRecovery: {
            recoverUnavailableSurface: async (request) => {
              events.push(
                `surface-recovery:${request.operation}:${"surface" in request ? request.surface : "none"}`,
              );
            },
            noteSurfaceAvailable: (request) => {
              events.push(
                `surface-available:${request.operation}:${"surface" in request ? request.surface : "none"}`,
              );
            },
          },
        },
      );

      await expect(
        executor.call({ operation: "documentation", surface: "chrome" }),
      ).resolves.toEqual({ ok: true, title: "Loop Chrome" });
      expect(events).toEqual([
        "surface-recovery:documentation:chrome",
        "runtime-refresh",
        "surface-available:documentation:chrome",
      ]);
      expect(operationAttempts).toBe(2);
    },
  );

  it("does not select or launch a profile when connected Chrome profiles are ambiguous", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    await installBrowserClient(root, "1.0.0");
    let surfaceRecoveryCalls = 0;
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args) => {
          const call = args as { title?: string };
          if (call.title === "Reconnect first-party browser runtime") return { ok: true };
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "BROWSER_PRE_DISPATCH_FAILED: CHROME_PROFILE_UNAVAILABLE_OR_AMBIGUOUS: list browser surfaces and select a Chrome profile",
              },
            ],
          };
        },
      },
      {
        codexHome: root,
        resolveContextThreadId: async () => "global-browser-host",
        surfaceRecovery: {
          recoverUnavailableSurface: async () => {
            surfaceRecoveryCalls += 1;
          },
          noteSurfaceAvailable: () => undefined,
        },
      },
    );
    const result = await executor.call({ operation: "list_tabs", surface: "chrome" });
    expect(result).toMatchObject({ isError: true });
    expect(surfaceRecoveryCalls).toBe(0);
  });

  it("preserves each session's selected browser identity when recovering Chrome", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    await installBrowserClient(root, "1.0.0");
    const surfaces = [
      {
        id: "1",
        type: "extension",
        family: "chrome",
        profileName: "Alpha",
        metadata: { extensionInstanceId: "alpha-connection" },
      },
      {
        id: "2",
        type: "extension",
        family: "chrome",
        profileName: "Beta",
        metadata: { extensionInstanceId: "beta-connection" },
      },
    ];
    const recovered: Array<{
      browserId?: string;
      chromeProfileName?: string;
      workSessionBinding?: string;
    }> = [];
    let operationAttempts = 0;
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args) => {
          const call = args as { code: string; title?: string };
          if (call.title === "Reconnect first-party browser runtime") return { ok: true };
          if (
            call.code.includes("nodeRepl.write(JSON.stringify(await __omniAgent.browsers.list()))")
          )
            return { content: [{ type: "text", text: JSON.stringify(surfaces) }] };
          operationAttempts += 1;
          if (operationAttempts % 2 === 1)
            return {
              isError: true,
              content: [{ type: "text", text: "Browser is not available: chrome" }],
            };
          return { ok: true };
        },
      },
      {
        codexHome: root,
        resolveContextThreadId: async () => "global-browser-host",
        surfaceRecovery: {
          recoverUnavailableSurface: async (request) => {
            if (request.operation !== "list_surfaces") recovered.push(request);
          },
          noteSurfaceAvailable: () => undefined,
        },
      },
    );
    const first = { ownerBinding: "owner", workSessionBinding: "work-a" };
    const second = { ownerBinding: "owner", workSessionBinding: "work-b" };
    await executor.call({ operation: "list_surfaces" }, first);
    await executor.call({ operation: "list_surfaces" }, second);
    await executor.call(
      { operation: "list_tabs", surface: "chrome", browserId: "extension:alpha-connection" },
      first,
    );
    await executor.call(
      { operation: "list_tabs", surface: "chrome", browserId: "extension:beta-connection" },
      second,
    );
    expect(recovered).toMatchObject([
      {
        browserId: "extension:alpha-connection",
        chromeProfileName: "Alpha",
        workSessionBinding: "work-a",
      },
      {
        browserId: "extension:beta-connection",
        chromeProfileName: "Beta",
        workSessionBinding: "work-b",
      },
    ]);
  });

  it("recovers a remembered selected profile when all Chrome connections disappear", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    await installBrowserClient(root, "1.0.0");
    const surface = {
      id: "1",
      type: "extension",
      family: "chrome",
      profileName: "Alpha",
      metadata: { extensionInstanceId: "alpha-connection" },
    };
    let connected = true;
    const recovered: unknown[] = [];
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args) => {
          const call = args as { code: string; title?: string };
          if (call.title === "Reconnect first-party browser runtime") return { ok: true };
          if (
            call.code.includes("nodeRepl.write(JSON.stringify(await __omniAgent.browsers.list()))")
          )
            return {
              content: [{ type: "text", text: JSON.stringify(connected ? [surface] : []) }],
            };
          return { ok: true };
        },
      },
      {
        codexHome: root,
        resolveContextThreadId: async () => "global-browser-host",
        surfaceRecovery: {
          recoverUnavailableSurface: async (request) => {
            recovered.push(request);
            connected = true;
          },
          noteSurfaceAvailable: () => undefined,
        },
      },
    );
    const context = { ownerBinding: "owner", workSessionBinding: "work-a" };
    await executor.call({ operation: "list_surfaces" }, context);
    connected = false;
    await expect(
      executor.call(
        { operation: "list_tabs", surface: "chrome", browserId: "extension:alpha-connection" },
        context,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(recovered).toMatchObject([
      {
        browserId: "extension:alpha-connection",
        chromeProfileName: "Alpha",
        workSessionBinding: "work-a",
      },
    ]);
  });

  it("isolates concurrent Chrome and IAB recovery flights without replaying either operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    await installBrowserClient(root, "1.0.0");
    const initialBarrier = deferred<void>();
    const recoveryGate = deferred<void>();
    const calls: Array<Record<string, unknown>> = [];
    let initialAttempts = 0;
    let recoveryAttempts = 0;
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args) => {
          const typedArgs = args as Record<string, unknown>;
          calls.push(typedArgs);
          if (typedArgs.title === "Reconnect first-party browser runtime") {
            recoveryAttempts += 1;
            await recoveryGate.promise;
            return { ok: true };
          }
          initialAttempts += 1;
          if (initialAttempts <= 2) {
            if (initialAttempts === 2) initialBarrier.resolve();
            await initialBarrier.promise;
            throw new Error("Selected browser disconnected");
          }
          return { ok: true, attempt: initialAttempts };
        },
      },
      {
        codexHome: root,
        resolveContextThreadId: async (request) =>
          request.operation === "exec" && request.surface === "iab"
            ? request.contextThreadId
            : "global-browser-host",
      },
    );

    const chromeCall = executor.call({
      operation: "exec",
      surface: "chrome",
      code: "return browser.tabs.list();",
    });
    const iabCall = executor.call(
      {
        operation: "exec",
        surface: "iab",
        code: "return browser.tabs.list();",
      },
      {
        contextThreadId: "desktop-iab-task",
        ownerBinding: "owner-a",
        workSessionBinding: "work-a",
      },
    );
    await waitUntil(() => recoveryAttempts === 2 && initialAttempts === 2);
    recoveryGate.resolve();
    const results = await Promise.allSettled([chromeCall, iabCall]);

    expect(recoveryAttempts).toBe(2);
    expect(results).toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringContaining("OUTCOME_UNKNOWN"),
        }),
      }),
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringContaining("OUTCOME_UNKNOWN"),
        }),
      }),
    ]);
    expect(calls).toHaveLength(4);
    const operationCodes = calls
      .filter((args) => args.title !== "Reconnect first-party browser runtime")
      .map((args) => String(args.code));
    expect(
      operationCodes.filter((code) => code.includes("__omniAgent.browsers.getDefault()")),
    ).toHaveLength(1);
    expect(
      operationCodes.filter((code) => code.includes('__omniAgent.browsers.get("iab")')),
    ).toHaveLength(1);
    const iabOperationCode = operationCodes.find((code) =>
      code.includes('__omniAgent.browsers.get("iab")'),
    );
    expect(iabOperationCode).toContain('__omniAgent.browsers.get("iab")');
    expect(iabOperationCode).not.toContain("CanonicalConversation");
    expect(iabOperationCode).not.toContain("get_visible_dom");
    expect(operationCodes.every((code) => !code.includes("computerUse"))).toBe(true);
  });

  it("does not let one cancelled waiter poison a shared browser-runtime recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    await installBrowserClient(root, "1.0.0");
    const initialBarrier = deferred<void>();
    const recoveryGate = deferred<void>();
    const firstController = new AbortController();
    let operationAttempts = 0;
    let recoveryAttempts = 0;
    let recoverySignal: AbortSignal | undefined;
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (
          _server,
          _tool,
          args,
          _contextThreadId,
          _onProgress,
          _contextTurnId,
          signal,
        ) => {
          const typedArgs = args as Record<string, unknown>;
          if (typedArgs.title === "Reconnect first-party browser runtime") {
            recoveryAttempts += 1;
            recoverySignal = signal;
            await recoveryGate.promise;
            return { ok: true };
          }
          signal?.throwIfAborted();
          operationAttempts += 1;
          if (operationAttempts <= 2) {
            if (operationAttempts === 2) initialBarrier.resolve();
            await initialBarrier.promise;
            return {
              isError: true,
              content: [{ type: "text", text: "Browser data session disconnected" }],
            };
          }
          return { ok: true, recovered: true };
        },
      },
      {
        codexHome: root,
        resolveContextThreadId: async () => "global-browser-host",
      },
    );

    const cancelled = executor.call(
      { operation: "list_surfaces" },
      { signal: firstController.signal },
    );
    const surviving = executor.call({ operation: "list_surfaces" });
    await waitUntil(() => recoveryAttempts === 1);
    firstController.abort(new Error("first caller stopped waiting"));

    // Cancellation detaches this waiter before the shared physical recovery
    // completes; the other caller remains joined to that same recovery.
    await expect(cancelled).rejects.toThrow("first caller stopped waiting");
    expect(recoveryAttempts).toBe(1);
    expect(recoverySignal).toBeUndefined();
    recoveryGate.resolve();
    await expect(surviving).resolves.toEqual({ ok: true, recovered: true });
  });

  it("honors the deadline while waiting for Chrome surface recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    await installBrowserClient(root, "1.0.0");
    const recoveryGate = deferred<void>();
    let surfaceRecoveryStarted = false;
    let runtimeRefreshes = 0;
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args) => {
          const call = args as { title?: string };
          if (call.title === "Reconnect first-party browser runtime") {
            runtimeRefreshes += 1;
            return { ok: true };
          }
          return {
            isError: true,
            content: [{ type: "text", text: "Browser is not available: chrome" }],
          };
        },
      },
      {
        codexHome: root,
        resolveContextThreadId: async () => "global-browser-host",
        surfaceRecovery: {
          recoverUnavailableSurface: async () => {
            surfaceRecoveryStarted = true;
            await recoveryGate.promise;
          },
          noteSurfaceAvailable: () => undefined,
        },
      },
    );
    const started = Date.now();
    await expect(
      executor.call({ operation: "list_tabs", surface: "chrome", timeout_ms: 100 }),
    ).rejects.toThrow("Browser call deadline exceeded");
    expect(surfaceRecoveryStarted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(runtimeRefreshes).toBe(0);
    recoveryGate.resolve();
  });

  it("does not cancel shared Chrome surface recovery when one session stops waiting", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    await installBrowserClient(root, "1.0.0");
    const recoveryGate = deferred<void>();
    const firstController = new AbortController();
    const attempts = new Map<string, number>();
    const recoverySignals = new Map<string, AbortSignal | undefined>();
    let surfaceWaiters = 0;
    let runtimeRefreshes = 0;
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async (_server, _tool, args, _thread, _progress, turnId) => {
          const call = args as { title?: string };
          if (call.title === "Reconnect first-party browser runtime") {
            runtimeRefreshes += 1;
            return { ok: true };
          }
          const turn = turnId ?? "unknown";
          const count = (attempts.get(turn) ?? 0) + 1;
          attempts.set(turn, count);
          return count === 1
            ? {
                isError: true,
                content: [{ type: "text", text: "Browser is not available: chrome" }],
              }
            : { ok: true, recovered: true };
        },
      },
      {
        codexHome: root,
        resolveContextThreadId: async () => "global-browser-host",
        surfaceRecovery: {
          recoverUnavailableSurface: async (request, signal) => {
            surfaceWaiters += 1;
            recoverySignals.set(request.workSessionBinding ?? "unknown", signal);
            await recoveryGate.promise;
          },
          noteSurfaceAvailable: () => undefined,
        },
      },
    );
    const cancelled = executor.call(
      { operation: "list_tabs", surface: "chrome" },
      { signal: firstController.signal, ownerBinding: "owner", workSessionBinding: "work-a" },
    );
    const surviving = executor.call(
      { operation: "list_tabs", surface: "chrome" },
      { ownerBinding: "owner", workSessionBinding: "work-b" },
    );
    await waitUntil(() => surfaceWaiters === 2);
    firstController.abort(new Error("first session stopped waiting"));
    await expect(cancelled).rejects.toThrow("first session stopped waiting");
    expect(recoverySignals.get("work-a")?.aborted).toBe(true);
    expect(recoverySignals.get("work-b")?.aborted).toBe(false);
    expect(runtimeRefreshes).toBe(0);
    recoveryGate.resolve();
    await expect(surviving).resolves.toEqual({ ok: true, recovered: true });
    expect(runtimeRefreshes).toBe(1);
  });

  it.each([
    { operation: "exec" as const, throws: false },
    { operation: "exec" as const, throws: true },
    { operation: "list_surfaces" as const, throws: false },
    { operation: "list_surfaces" as const, throws: true },
  ])(
    "preserves both native failures after $operation recovery (throws=$throws)",
    async ({ operation, throws }) => {
      const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
      await installBrowserClient(root, "1.0.0");
      const tail = "END_OF_NATIVE_BROWSER_ERROR";
      const fullMessage = `${"r".repeat(20_000)}${tail}`;
      const originalResult = {
        isError: true,
        content: [{ type: "text", text: "Browser data session disconnected" }],
        structuredContent: {
          completedSteps: [{ tabId: "owned-tab", step: "opened" }],
        },
        _meta: { nativeReceipt: "original-receipt" },
      };
      const originalFailure = throws
        ? new Error("Browser data session disconnected", {
            cause: originalResult,
          })
        : originalResult;
      const recoveryResult = {
        isError: true,
        content: [{ type: "text", text: fullMessage }],
        structuredContent: { code: "NATIVE_CONNECTION_LOST", retryable: true },
        _meta: { nativeReceipt: "recovery-receipt" },
      };
      let calls = 0;
      const executor = new BrowserNativeExecutor(
        {
          callInContext: async (_server, _tool, args) => {
            calls += 1;
            const typedArgs = args as Record<string, unknown>;
            if (typedArgs.title === "Reconnect first-party browser runtime") {
              return recoveryResult;
            }
            if (throws) throw originalFailure;
            return originalResult;
          },
        },
        {
          codexHome: root,
          resolveContextThreadId: async () => "global-browser-host",
        },
      );

      const failure = await executor
        .call(
          operation === "exec"
            ? {
                operation,
                surface: "chrome",
                code: "await browser.tabs.new();",
              }
            : { operation },
        )
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(tail);
      expect((failure as Error).message.length).toBeGreaterThan(20_000);
      expect((failure as Error).message).toContain(
        operation === "exec"
          ? "BROWSER_OUTCOME_UNKNOWN_RECOVERY_FAILED"
          : "BROWSER_RECOVERY_FAILED",
      );
      const serialized = JSON.parse(JSON.stringify(structuredErrorDetails(failure)));
      expect(serialized.cause.originalFailure).toEqual(
        throws ? structuredErrorDetails(originalFailure) : originalResult,
      );
      expect(serialized.cause.recoveryFailure.cause).toEqual(recoveryResult);
      expect(calls).toBe(2);
    },
  );

  it.each([
    { label: "tab-local failure", failure: new Error("Tab is closed") },
    {
      label: "tool timeout",
      failure: new Error("TimeoutError: browser tool timed out"),
    },
    {
      label: "user cancellation",
      failure: new Error("User cancelled browser operation"),
    },
    {
      label: "permission refusal",
      failure: new Error("Permission denied by browser extension"),
    },
    {
      label: "unavailable browser with permission refusal",
      failure: new Error("Browser is not available: chrome; permission denied"),
    },
  ])("does not recover for $label", async ({ failure }) => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    await installBrowserClient(root, "1.0.0");
    let calls = 0;
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async () => {
          calls += 1;
          throw failure;
        },
      },
      { codexHome: root },
    );

    await expect(
      executor.call({
        operation: "exec",
        surface: "chrome",
        code: "return 'x';",
      }),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  it.each(["error", "string", "result"] as const)(
    "preserves a tab-level Debugger unattached %s without rebuilding the browser runtime",
    async (format) => {
      for (const operation of ["exec", "list_user_tabs"] as const) {
        const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
        await installBrowserClient(root, "1.0.0");
        const result = {
          isError: true,
          content: [{ type: "text", text: "Debugger unattached" }],
          structuredContent: { tabId: "tab-1", error: "Debugger unattached" },
        };
        const failure =
          format === "error" ? new Error("Debugger unattached") : "Debugger unattached";
        const calls: Array<Record<string, unknown>> = [];
        const executor = new BrowserNativeExecutor(
          {
            callInContext: async (_server, _tool, args) => {
              calls.push(args as Record<string, unknown>);
              if (format === "result") return result;
              throw failure;
            },
          },
          {
            codexHome: root,
            resolveContextThreadId: async () => "global-browser-host",
          },
        );
        const pending = executor.call({
          operation,
          surface: "chrome",
          code: "return await (await browser.tabs.get('tab-1')).ax.get();",
        });
        if (format === "result") await expect(pending).resolves.toBe(result);
        else await expect(pending).rejects.toBe(failure);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.title).not.toBe("Reconnect first-party browser runtime");
        expect(String(calls[0]?.code)).not.toContain("omnicodex_recovery=");
      }
    },
  );

  it("does not treat successful tool text mentioning a disconnect as a recovery signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    await installBrowserClient(root, "1.0.0");
    let calls = 0;
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async () => {
          calls += 1;
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: "The report says browser disconnected yesterday",
              },
            ],
          };
        },
      },
      { codexHome: root },
    );

    await executor.call({ operation: "list_surfaces" });
    expect(calls).toBe(1);
  });

  it("rejects IAB before dispatch when no exact context task is supplied", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    const script = join(
      root,
      "plugins",
      "cache",
      "openai-bundled",
      "browser",
      "1.0.0",
      "scripts",
      "browser-client.mjs",
    );
    await mkdir(join(script, ".."), { recursive: true });
    await writeFile(script, "export const setupBrowserRuntime = async () => ({});", "utf8");
    let dispatched = false;
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async () => {
          dispatched = true;
          return { ok: true };
        },
      },
      { codexHome: root, resolveContextThreadId: async () => undefined },
    );

    await expect(
      executor.call({
        operation: "exec",
        surface: "iab",
        code: "return 'iab';",
      }),
    ).rejects.toThrow("IAB_CONTEXT_THREAD_ID_REQUIRED");
    expect(dispatched).toBe(false);
  });

  it("dispatches app-global browser calls without a Desktop host", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    await installBrowserClient(root, "1.0.0");
    let dispatched = false;
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async () => {
          dispatched = true;
          return { ok: true };
        },
      },
      { codexHome: root, resolveContextThreadId: async () => undefined },
    );

    await expect(executor.call({ operation: "list_surfaces" })).resolves.toEqual({ ok: true });
    expect(dispatched).toBe(true);
  });

  it("rejects IAB when the exact requested task is not desktop-owned", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-browser-"));
    await installBrowserClient(root, "1.0.0");
    let dispatched = false;
    const contextRequests: BrowserNativeContextRequest[] = [];
    const executor = new BrowserNativeExecutor(
      {
        callInContext: async () => {
          dispatched = true;
          return { ok: true };
        },
      },
      {
        codexHome: root,
        resolveContextThreadId: async (request) => {
          contextRequests.push(request);
          return undefined;
        },
      },
    );

    await expect(
      executor.call(
        { operation: "exec", surface: "iab", code: "return 'iab';" },
        {
          contextThreadId: "requested-not-owned",
          ownerBinding: "owner-a",
          workSessionBinding: "work-a",
        },
      ),
    ).rejects.toThrow("IAB_CONTEXT_NOT_DESKTOP_OWNED");
    expect(contextRequests).toEqual([
      expect.objectContaining({
        contextThreadId: "requested-not-owned",
        ownerBinding: "owner-a",
        workSessionBinding: "work-a",
      }),
    ]);
    expect(dispatched).toBe(false);
  });
});

async function installBrowserClient(root: string, version: string): Promise<string> {
  const script = join(
    root,
    "plugins",
    "cache",
    "openai-bundled",
    "browser",
    version,
    "scripts",
    "browser-client.mjs",
  );
  await mkdir(join(script, ".."), { recursive: true });
  await writeFile(script, "export const setupBrowserRuntime = async () => ({});", "utf8");
  return script;
}

async function installProtectedBrowserDocuments(root: string): Promise<void> {
  const protectedDirectory = join(root, "protected-confirmation-docs");
  await mkdir(protectedDirectory, { recursive: true });
  await writeFile(
    join(protectedDirectory, "chrome-browser-safety.md"),
    "# Browser Safety\nProtected browser safety.\n",
    "utf8",
  );
  await writeFile(
    join(protectedDirectory, "chrome-confirmations.md"),
    "# Agent Confirmations Policy\nProtected Chrome policy.\n",
    "utf8",
  );
}

function pathToImportFragment(path: string): string {
  return path.replaceAll("\\", "/").replace(/^([A-Za-z]):/u, "file:///$1:");
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for browser recovery test state");
}
