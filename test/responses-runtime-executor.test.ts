import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODE_MODE_DISPATCH_NAME,
  CODE_MODE_DISPATCH_SPEC,
} from "../src/application/code-mode-parallel-dispatch.js";
import {
  nativeCodeCellExecutionStatus,
  nativeDirectToolExecutionStatus,
  ResponsesRuntimeExecutor as ProductionResponsesRuntimeExecutor,
  type ResponsesCodeCellLifecycleSource,
  type ResponsesRuntimeExecutorBinding,
  type ResponsesRuntimeExecutorOptions,
} from "../src/application/responses-runtime-executor.js";
import type { CodexAppServerProcess } from "../src/infrastructure/runtime/codex-app-server-process.js";
import type { CodexModelMetadataSnapshot } from "../src/infrastructure/runtime/codex-model-metadata-source.js";

const TEST_MODEL: Readonly<Record<string, unknown>> = Object.freeze({
  slug: "gpt-5.6-sol",
  display_name: "Exact test model",
  context_window: 272_000,
  max_context_window: 872_000,
  shell_type: "unified_exec",
  truncation_policy: Object.freeze({ mode: "tokens", limit: 10_000 }),
  unknown_nested_field: Object.freeze({ preserved: "그대로" }),
});
const TEST_MODEL_METADATA: CodexModelMetadataSnapshot = Object.freeze({
  rawModel: TEST_MODEL,
  fetchedAt: "2026-08-29T00:00:00Z",
  clientVersion: "test",
  etag: "test-etag",
  modelDigest: "0".repeat(64),
  cachePath: "C:\\test\\.codex\\models_cache.json",
});

class ResponsesRuntimeExecutor extends ProductionResponsesRuntimeExecutor {
  constructor(options: Omit<ResponsesRuntimeExecutorOptions, "modelMetadataSnapshot"> = {}) {
    super({ modelMetadataSnapshot: TEST_MODEL_METADATA, ...options });
  }
}

const executors: ResponsesRuntimeExecutor[] = [];

afterEach(async () => {
  await Promise.all(executors.splice(0).map((executor) => executor.stop()));
});

describe("ResponsesRuntimeExecutor primary-process binding", () => {
  it("binds a shared-process provider to its own native thread", async () => {
    const executor = new ResponsesRuntimeExecutor({
      threadScopedProvider: true,
      providerId: "shared_owner",
      codeCellLifecycle: successfulCodeCellLifecycle,
    });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding);
    await executor.start(runtime.process);
    const start = runtime.requests.find((r) => r.method === "thread/start");
    expect(start?.params).toMatchObject({
      modelProvider: "shared_owner",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      config: {
        thread_unload_delay_secs: 0,
        model_provider: "shared_owner",
        model_providers: {
          shared_owner: {
            base_url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
            http_headers: { "X-OmniCodex-Loopback-Key": binding.env.OMNICODEX_LOOPBACK_API_KEY },
            requires_openai_auth: true,
          },
        },
      },
    });
    const turns = runtime.requests.filter((request) => request.method === "turn/start");
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.every((request) => !("modelProvider" in request.params))).toBe(true);
    await executor.stop();
    expect(runtime.requests.some((r) => r.method === "thread/unsubscribe")).toBe(true);
  });

  it("retires the catalog thread before starting a selected tool turn", async () => {
    const executor = new ResponsesRuntimeExecutor({ threadScopedProvider: true });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding);
    await executor.start(runtime.process);
    const lifecycle = () =>
      runtime.requests
        .filter((request) =>
          ["thread/start", "thread/unsubscribe", "turn/start"].includes(request.method),
        )
        .map((request) => request.method);
    expect(lifecycle()).toEqual(["thread/start", "turn/start", "thread/unsubscribe"]);
    await executor.callNested("exec_command", { cmd: "adb devices" }, false);
    expect(lifecycle()).toEqual([
      "thread/start",
      "turn/start",
      "thread/unsubscribe",
      "thread/start",
      "turn/start",
    ]);
  });

  it("starts a fresh thread before a second independent selected tool call", async () => {
    const executor = new ResponsesRuntimeExecutor({ threadScopedProvider: true });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding);
    await executor.start(runtime.process);
    await executor.callNested("exec_command", { cmd: "adb devices" }, false);
    await executor.callNested("exec_command", { cmd: "adb devices" }, false);
    expect(
      runtime.requests
        .filter((request) =>
          ["thread/start", "turn/start", "thread/unsubscribe"].includes(request.method),
        )
        .map((request) => request.method),
    ).toEqual([
      "thread/start",
      "turn/start",
      "thread/unsubscribe",
      "thread/start",
      "turn/start",
      "thread/unsubscribe",
      "thread/start",
      "turn/start",
    ]);
  });

  it("unsubscribes a new execution thread when its first turn is rejected", async () => {
    const executor = new ResponsesRuntimeExecutor({ threadScopedProvider: true });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding, { startTurnError: new Error("modelProviderMismatch") });
    await expect(executor.start(runtime.process)).rejects.toThrow("modelProviderMismatch");
    expect(
      runtime.requests.find((request) => request.method === "thread/unsubscribe")?.params,
    ).toEqual({
      threadId: "ephemeral-model-free-thread",
    });
  });

  it("retires a thread acknowledged after thread/start cancellation", async () => {
    const executor = new ResponsesRuntimeExecutor({ threadScopedProvider: true });
    executors.push(executor);
    const binding = await executor.prepare();
    const late = new Error("thread/start deadline elapsed");
    Reflect.set(late, "rpcResponse", { thread: { id: "ephemeral-model-free-thread" } });
    const runtime = fakeRuntime(binding, { startThreadError: late });
    await expect(executor.start(runtime.process)).rejects.toThrow("thread/start deadline elapsed");
    expect(
      runtime.requests.find((request) => request.method === "thread/unsubscribe")?.params,
    ).toEqual({ threadId: "ephemeral-model-free-thread" });
  });

  it("retains the exact thread for retry when startup unsubscribe fails", async () => {
    const executor = new ResponsesRuntimeExecutor({ threadScopedProvider: true });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding, {
      startTurnError: new Error("modelProviderMismatch"),
      unsubscribeFailures: 1,
    });
    await expect(executor.start(runtime.process)).rejects.toThrow(
      "Responses runtime startup and thread cleanup failed",
    );
    expect(executor.running).toBe(true);
    await executor.stop();
    expect(executor.running).toBe(false);
    expect(
      runtime.requests.filter((request) => request.method === "thread/unsubscribe"),
    ).toHaveLength(2);
  });

  it("bounds shutdown unsubscribe and retries its exact thread after failure", async () => {
    const executor = new ResponsesRuntimeExecutor({ threadScopedProvider: true });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding);
    await executor.start(runtime.process);
    await executor.callNested("exec_command", { cmd: "adb devices" }, false);
    runtime.failNextUnsubscribe();
    await expect(executor.stop()).rejects.toThrow("unsubscribe transport failed");
    expect(executor.running).toBe(true);
    await executor.stop();
    expect(executor.running).toBe(false);
    const releases = runtime.requests.filter((request) => request.method === "thread/unsubscribe");
    expect(releases).toHaveLength(3);
    expect(
      releases.every(
        (request) => isObject(request.requestOptions) && request.requestOptions.timeoutMs === 3_000,
      ),
    ).toBe(true);
  });

  it("rejects an in-flight turn after its App Server exits and settles browser ownership", async () => {
    const onTurnSettled = vi.fn();
    const executor = new ResponsesRuntimeExecutor({
      codeCellLifecycle: successfulCodeCellLifecycle,
      onTurnSettled,
    });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding);
    await executor.start(runtime.process);
    onTurnSettled.mockClear();
    runtime.holdNextTurn();
    const pending = executor.call({
      kind: "custom",
      namespace: "functions",
      name: "exec",
      arguments: 'text("held until exit")',
    });
    const rejected = expect(pending).rejects.toThrow("Responses App Server exited: child died");
    const turnId = await runtime.waitForHeldTurn();
    await executor.handleProcessExit(new Error("child died"));
    await rejected;
    expect(onTurnSettled).toHaveBeenCalledWith(turnId);
    expect(executor.running).toBe(false);
    await expect(executor.callNested("unrelated", {}, false)).rejects.toThrow(
      "Responses App Server exited",
    );
    const nextBinding = await executor.prepare();
    const nextRuntime = fakeRuntime(nextBinding);
    await executor.start(nextRuntime.process);
    expect(executor.running).toBe(true);
  });

  it("binds parallel dispatch to the execution thread and preserves native arguments", async () => {
    const original = {
      type: "function",
      name: "native_echo",
      description: "Echo.",
      inputSchema: { type: "object" },
      deferLoading: false,
    };
    const executor = new ResponsesRuntimeExecutor({ dynamicTools: () => [original] });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding);
    await executor.start(runtime.process);
    expect(runtime.requests.find((r) => r.method === "thread/start")?.params.dynamicTools).toEqual([
      original,
      CODE_MODE_DISPATCH_SPEC,
    ]);
    expect(executor.snapshot.nestedTools.some((t) => t.name === CODE_MODE_DISPATCH_NAME)).toBe(
      false,
    );
    const invoke = vi.fn(async () => ({
      success: true,
      contentItems: [{ type: "inputText", text: "exact" }],
    }));
    const args = { path: "C:\\original", timeoutMs: 0, futureField: { unchanged: true } };
    const call = {
      threadId: "ephemeral-model-free-thread",
      turnId: "retained-turn",
      callId: "call-original",
      tool: CODE_MODE_DISPATCH_NAME,
      arguments: { action: "start", tool: "native_echo", group: "cell-group", arguments: args },
    };
    const start = await executor.dispatchDynamic(call, invoke);
    const handle = JSON.parse(start.contentItems[0]?.text ?? "").handle;
    const result = await executor.dispatchDynamic(
      { ...call, arguments: { action: "read", handle } },
      invoke,
    );
    expect(JSON.parse(result.contentItems[0]?.text ?? "")).toEqual({
      state: "done",
      response: { success: true, contentItems: [{ type: "inputText", text: "exact" }] },
    });
    expect(invoke).toHaveBeenCalledWith(
      { ...call, tool: "native_echo", arguments: args },
      expect.any(AbortSignal),
    );
    await expect(executor.dispatchDynamic({ ...call, threadId: "other" }, invoke)).rejects.toThrow(
      "current execution thread",
    );
  });

  it("keeps Codex account auth on the loopback provider without replacing the primary provider", async () => {
    const executor = new ResponsesRuntimeExecutor();
    executors.push(executor);

    const binding = await executor.prepare();

    expect(binding.env.OMNICODEX_LOOPBACK_API_KEY).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(binding.configOverrides).toContain(
      'model_providers.omnicodex_loopback.wire_api="responses"',
    );
    expect(binding.configOverrides).toContain(
      "model_providers.omnicodex_loopback.requires_openai_auth=true",
    );
    expect(binding.configOverrides).toContain('approval_policy="never"');
    expect(binding.configOverrides).toContain('sandbox_mode="danger-full-access"');
    expect(binding.configOverrides).toContain("features.code_mode_host=true");
    expect(binding.configOverrides.some((value) => value.startsWith("model_provider="))).toBe(
      false,
    );
    expect(executor.running).toBe(false);
  });

  it("treats blank model and provider overrides as absent instead of serializing invalid names", async () => {
    const executor = new ResponsesRuntimeExecutor({ model: "   ", providerId: "\t" });
    executors.push(executor);

    const binding = await executor.prepare();

    expect(binding.configOverrides).toContain(
      'model_providers.omnicodex_loopback.wire_api="responses"',
    );
    expect(binding.configOverrides.some((value) => value.includes("model_providers.."))).toBe(
      false,
    );
    expect(binding.configOverrides.some((value) => value.startsWith("model_provider="))).toBe(
      false,
    );
  });

  it("requires preparation and never creates an App Server on its own", async () => {
    const executor = new ResponsesRuntimeExecutor();
    executors.push(executor);
    const process = {} as Parameters<ResponsesRuntimeExecutor["start"]>[0];

    await expect(executor.start(process)).rejects.toThrow(
      "must be prepared before the App Server starts",
    );
    expect(executor.running).toBe(false);
  });

  it("runs shell and file-capable nested tools only on a never-approved ephemeral thread", async () => {
    const executor = new ResponsesRuntimeExecutor({
      turnTimeoutMs: 5_000,
      codeCellLifecycle: successfulCodeCellLifecycle,
    });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding);

    await executor.start(runtime.process);

    expect(executor.snapshot.nestedTools.map((tool) => tool.name)).toEqual([
      "apply_patch",
      "exec_command",
    ]);
    await expect(
      executor.callNested("exec_command", { cmd: "adb devices" }, false),
    ).resolves.toEqual({ exit_code: 0, output: "device-123\tdevice" });

    const threadStart = runtime.requests.find((request) => request.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      approvalPolicy: "never",
      ephemeral: true,
      modelProvider: "omnicodex_loopback",
      sandbox: "danger-full-access",
      config: { thread_unload_delay_secs: 0 },
    });
    expect(threadStart?.requestOptions).toEqual({ awaitResponseAfterCancellation: true });
    const turns = runtime.requests.filter((request) => request.method === "turn/start");
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(
      turns.every(
        ({ params }) =>
          Array.isArray(params.input) &&
          params.input.every(
            (item: unknown) =>
              isObject(item) &&
              item.type === "text" &&
              Array.isArray(item.text_elements) &&
              item.text_elements.length === 0,
          ),
      ),
    ).toBe(true);
    expect(
      turns.every(
        ({ requestOptions }) =>
          isObject(requestOptions) &&
          requestOptions.timeoutMs === 5_000 &&
          requestOptions.awaitResponseAfterCancellation === true,
      ),
    ).toBe(true);
    expect(
      turns.every(
        ({ params }) =>
          params.approvalPolicy === "never" &&
          isObject(params.sandboxPolicy) &&
          params.sandboxPolicy.type === "dangerFullAccess",
      ),
    ).toBe(true);
    expect(runtime.selectedStreams.some((stream) => stream.includes("adb devices"))).toBe(true);
    expect(runtime.selectedStreams.some((stream) => stream.includes("__excludedNames"))).toBe(
      false,
    );
    expect(
      runtime.requests.some(({ method }) =>
        ["thread/resume", "config/write", "skills/config/write"].includes(method),
      ),
    ).toBe(false);

    await executor.stop();
    expect(executor.running).toBe(false);
    expect(executor.snapshot.tools).toEqual([]);

    const restartedBinding = await executor.prepare();
    expect(restartedBinding).not.toBe(binding);
    const modelResponse = await fetch(`${loopbackBaseUrl(restartedBinding)}/models`, {
      headers: {
        "x-omnicodex-loopback-key": restartedBinding.env.OMNICODEX_LOOPBACK_API_KEY ?? "",
      },
    });
    expect(modelResponse.status).toBe(200);
    await expect(modelResponse.json()).resolves.toEqual({ models: [TEST_MODEL] });
  });

  it("settles each completed native turn exactly once so turn-owned browser tabs can be reclaimed", async () => {
    const settledTurns: string[] = [];
    const executor = new ResponsesRuntimeExecutor({
      turnTimeoutMs: 5_000,
      codeCellLifecycle: successfulCodeCellLifecycle,
      onTurnSettled: async (turnId) => {
        settledTurns.push(turnId);
      },
    });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding);
    await executor.start(runtime.process);
    settledTurns.length = 0;

    await expect(
      executor.callNested("exec_command", { cmd: "adb devices" }, false),
    ).resolves.toEqual({ exit_code: 0, output: "device-123\tdevice" });

    expect(settledTurns.length).toBeGreaterThan(0);
    expect(new Set(settledTurns).size).toBe(settledTurns.length);
    expect(settledTurns.every((turnId) => /^turn-\d+$/u.test(turnId))).toBe(true);
  });

  it("does not rediscover exact dynamic tools through the nested catalog transfer", async () => {
    const executor = new ResponsesRuntimeExecutor({
      turnTimeoutMs: 5_000,
      nestedToolExclusions: () => ["exec_command"],
      codeCellLifecycle: successfulCodeCellLifecycle,
    });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding);

    await executor.start(runtime.process);

    expect(executor.snapshot.nestedTools.map((tool) => tool.name)).toEqual(["apply_patch"]);
    expect(runtime.requests.some((request) => request.method === "skills/list")).toBe(false);
  });

  it("uses the complete catalog already present in the first Responses request", async () => {
    const executor = new ResponsesRuntimeExecutor({
      turnTimeoutMs: 5_000,
      nestedToolExclusions: () => ["excluded_tool"],
      codeCellLifecycle: successfulCodeCellLifecycle,
    });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding, {
      catalogInAdditionalTools: true,
      directTools: [
        {
          name: "exec_command",
          description:
            "Runs a hidden child process.\n\nexec tool declaration:\n```ts\ndeclare const tools: { exec_command(args: { cmd: string; }): Promise<unknown>; };\n```",
        },
        {
          name: "apply_patch",
          description:
            'This is a FREEFORM tool with 漢字🧪, quotes "x", and slash \\\\.\n\nexec tool declaration:\n```ts\ndeclare const tools: { apply_patch(input: string): Promise<unknown>; };\n```\n',
        },
        {
          name: "excluded_tool",
          description:
            "Self-recursive route.\n\nexec tool declaration:\n```ts\ndeclare const tools: { excluded_tool(args: {}): Promise<unknown>; };\n```",
        },
      ],
    });

    await executor.start(runtime.process);

    expect(executor.snapshot.nestedTools.map((tool) => tool.name)).toEqual([
      "apply_patch",
      "exec_command",
    ]);
    expect(
      executor.snapshot.nestedTools.find((tool) => tool.name === "apply_patch")?.description,
    ).toBe(
      'This is a FREEFORM tool with 漢字🧪, quotes "x", and slash \\\\.\n\nexec tool declaration:\n```ts\ndeclare const tools: { apply_patch(input: string): Promise<unknown>; };\n```\n',
    );
    expect(runtime.requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
    expect(runtime.selectedStreams.some((stream) => stream.includes("ALL_TOOLS"))).toBe(false);
  });

  it("recovers a dense Unicode direct-tool catalog from the initial Responses envelope", async () => {
    const densePadding = '漢字🧪\\"\n'.repeat(12_000);
    const executor = new ResponsesRuntimeExecutor({
      turnTimeoutMs: 5_000,
      codeCellLifecycle: successfulCodeCellLifecycle,
    });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding, {
      directTools: [
        {
          name: "exec_command",
          description: `${densePadding}Runs a hidden child process.\n\nexec tool declaration:\n\`\`\`ts\ndeclare const tools: { exec_command(args: { cmd: string; }): Promise<unknown>; };\n\`\`\`\n`,
        },
        {
          name: "apply_patch",
          description:
            "This is a FREEFORM tool.\n\nexec tool declaration:\n```ts\ndeclare const tools: { apply_patch(input: string): Promise<unknown>; };\n```",
        },
      ],
    });

    await executor.start(runtime.process);

    expect(
      executor.snapshot.nestedTools.find((tool) => tool.name === "exec_command")?.description,
    ).toBe(
      `${densePadding}Runs a hidden child process.\n\nexec tool declaration:\n\`\`\`ts\ndeclare const tools: { exec_command(args: { cmd: string; }): Promise<unknown>; };\n\`\`\`\n`,
    );
    expect(runtime.requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
    expect(runtime.selectedStreams.some((stream) => stream.includes("ALL_TOOLS"))).toBe(false);
  });

  it.each(["\n", "\r\n"])(
    "keeps namespace introductions out of native tool descriptions (%j)",
    async (newline) => {
      const executor = new ResponsesRuntimeExecutor({
        turnTimeoutMs: 5_000,
        codeCellLifecycle: successfulCodeCellLifecycle,
      });
      executors.push(executor);
      const binding = await executor.prepare();
      const writeDescription = [
        "Writes characters to an existing session.",
        "",
        "exec tool declaration:",
        "```ts",
        "declare const tools: { write_stdin(args: { session_id: number; }): Promise<unknown>; };",
        "```",
      ].join(newline);
      const imageDescription = [
        "Generate an image.",
        "",
        "exec tool declaration:",
        "```ts",
        "declare const tools: { image_gen__imagegen(args: { prompt: string; }): Promise<unknown>; };",
        "```",
      ].join(newline);
      const runtime = fakeRuntime(binding, {
        catalogDescription: [
          "Run JavaScript code.",
          `### \`write_stdin\`${newline}${writeDescription}`,
          `## image_gen${newline}Tools in the image_gen namespace.`,
          `### \`image_gen__imagegen\`${newline}${imageDescription}`,
        ].join(newline + newline),
      });

      await executor.start(runtime.process);

      expect(executor.snapshot.nestedTools).toEqual([
        expect.objectContaining({ name: "image_gen__imagegen", description: imageDescription }),
        expect.objectContaining({ name: "write_stdin", description: writeDescription }),
      ]);
      await executor.call({
        kind: "function",
        name: "image_gen__imagegen",
        arguments: { prompt: "test" },
      });
      expect(runtime.selectedStreams.at(-1)).toContain('"namespace":"image_gen"');
      expect(runtime.selectedStreams.at(-1)).toContain('"name":"imagegen"');
      expect(runtime.selectedStreams.at(-1)).not.toContain('"name":"exec"');
      expect(executor.snapshot.nestedTools[1]?.inputSchema).toMatchObject({
        properties: { session_id: { type: "number" } },
        required: ["session_id"],
      });
    },
  );

  it("fails atomically instead of silently omitting malformed or duplicate direct tools", async () => {
    const malformed = new ResponsesRuntimeExecutor({
      turnTimeoutMs: 5_000,
      codeCellLifecycle: successfulCodeCellLifecycle,
    });
    executors.push(malformed);
    const malformedBinding = await malformed.prepare();
    const malformedRuntime = fakeRuntime(malformedBinding, {
      catalogDescription: [
        "Run JavaScript code to orchestrate/compose tool calls",
        "### `valid`\nexec tool declaration:\n```ts\ndeclare const tools: { valid(args: { value: string; }): Promise<unknown>; };\n```",
        "### `missing-description`\nNo executable declaration was published.",
      ].join("\n\n"),
    });

    await expect(malformed.start(malformedRuntime.process)).rejects.toMatchObject({
      code: "OMNICODEX_RESPONSES_NESTED_CATALOG_INCOMPATIBLE",
      data: { index: 1, toolName: "missing-description" },
    });
    expect(malformed.snapshot.nestedTools).toEqual([]);

    const duplicate = new ResponsesRuntimeExecutor({
      turnTimeoutMs: 5_000,
      codeCellLifecycle: successfulCodeCellLifecycle,
    });
    executors.push(duplicate);
    const duplicateBinding = await duplicate.prepare();
    const duplicateRuntime = fakeRuntime(duplicateBinding, {
      directTools: [
        {
          name: "same",
          description:
            "first\n\nexec tool declaration:\n```ts\ndeclare const tools: { same(args: {}): Promise<unknown>; };\n```",
        },
        {
          name: "same",
          description:
            "second\n\nexec tool declaration:\n```ts\ndeclare const tools: { same(args: {}): Promise<unknown>; };\n```",
        },
      ],
    });

    await expect(duplicate.start(duplicateRuntime.process)).rejects.toMatchObject({
      code: "OMNICODEX_RESPONSES_NESTED_CATALOG_INCOMPATIBLE",
      data: { index: 1, previousIndex: 0, toolName: "same" },
    });
    expect(duplicate.snapshot.nestedTools).toEqual([]);
  });

  it("exhausts every MCP status cursor and stabilizes on the complete page contents", async () => {
    const executor = new ResponsesRuntimeExecutor({
      turnTimeoutMs: 5_000,
      codeCellLifecycle: successfulCodeCellLifecycle,
    });
    executors.push(executor);
    const binding = await executor.prepare();
    let sample = 0;
    const runtime = fakeRuntime(binding, {
      mcpStatusPage: (params) => {
        if (params.cursor === undefined) {
          sample += 1;
          return {
            data: [{ name: "first-page", tools: { native: { description: "stable" } } }],
            nextCursor: "tail-page",
          };
        }
        if (params.cursor !== "tail-page") throw new Error("Unexpected MCP status cursor");
        return {
          data: [
            {
              name: "tail-page",
              tools: {
                native: { description: sample === 1 ? "initial" : "updated" },
              },
            },
          ],
          nextCursor: null,
        };
      },
    });

    await executor.start(runtime.process);

    const statusRequests = runtime.requests.filter(
      (request) => request.method === "mcpServerStatus/list",
    );
    expect(statusRequests.filter(({ params }) => params.cursor === undefined)).toHaveLength(4);
    expect(statusRequests.filter(({ params }) => params.cursor === "tail-page")).toHaveLength(4);
    expect(statusRequests.every(({ params }) => params.limit === 1_000)).toBe(true);
  });

  it("rejects a repeated MCP status cursor instead of truncating or looping", async () => {
    const executor = new ResponsesRuntimeExecutor({
      turnTimeoutMs: 5_000,
      codeCellLifecycle: successfulCodeCellLifecycle,
    });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding, {
      mcpStatusPage: () => ({
        data: [{ name: "cyclic", tools: {} }],
        nextCursor: "same-cursor",
      }),
    });

    const controller = new AbortController();
    await expect(executor.start(runtime.process, controller.signal)).rejects.toThrow(
      "repeated a pagination cursor",
    );
    expect(
      runtime.requests
        .filter(({ method }) => method === "mcpServerStatus/list")
        .every(({ requestOptions }) =>
          isObject(requestOptions) ? requestOptions.signal === controller.signal : false,
        ),
    ).toBe(true);
  });

  it("stabilizes when plugin provenance and icon addresses change", async () => {
    const executor = new ResponsesRuntimeExecutor({
      turnTimeoutMs: 5_000,
      codeCellLifecycle: successfulCodeCellLifecycle,
    });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding, {
      mcpStatusPage: (_params, requestOrdinal) => ({
        data: [
          {
            name: "codex_apps",
            tools: {
              scan: {
                icons: [{ src: `https://example.test/icon-${requestOrdinal}.svg` }],
                description:
                  requestOrdinal % 2 === 0
                    ? "Read scan history. This tool is part of plugin `Codex Security Cloud`."
                    : "Read scan history.",
              },
            },
          },
        ],
      }),
    });

    await executor.start(runtime.process, AbortSignal.timeout(5_000));

    expect(runtime.requests.filter(({ method }) => method === "mcpServerStatus/list")).toHaveLength(
      3,
    );
  });

  it("ignores changing MCP health fields when the callable catalog is stable", async () => {
    const executor = new ResponsesRuntimeExecutor({
      turnTimeoutMs: 5_000,
      codeCellLifecycle: successfulCodeCellLifecycle,
    });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding, {
      mcpStatusPage: (_params, requestOrdinal) => ({
        data: [
          {
            name: "native",
            tools: { node_repl: { description: "stable" } },
            connectedAtUnixMs: requestOrdinal,
            requestsServed: requestOrdinal,
          },
        ],
      }),
    });

    await executor.start(runtime.process);

    expect(runtime.requests.filter(({ method }) => method === "mcpServerStatus/list")).toHaveLength(
      3,
    );
  });

  it("returns a large native result directly without code cells or transfer turns", async () => {
    const largeOutput = ["first-line", "한글-결과-".repeat(20_000), "last-line"].join("\n");
    const nestedResult = {
      exit_code: 0,
      stdout: largeOutput,
      stderr: "warning-stream-preserved",
      structured: Array.from({ length: 512 }, (_, index) => ({ index, value: `item-${index}` })),
    };
    const executor = new ResponsesRuntimeExecutor({
      turnTimeoutMs: 5_000,
      codeCellLifecycle: successfulCodeCellLifecycle,
    });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding, { nestedResult });
    await executor.start(runtime.process);

    await expect(
      executor.callNested("exec_command", { cmd: "large-output" }, false),
    ).resolves.toEqual(nestedResult);
    const calls = runtime.selectedStreams.filter((stream) =>
      stream.includes('"type":"function_call"'),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('"name":"exec_command"');
    expect(runtime.selectedStreams.some((stream) => stream.includes("__omnicodexTransfer"))).toBe(
      false,
    );
  });

  it("preserves never/full-access execution and typed nonzero command failure on the direct route", async () => {
    const executor = new ResponsesRuntimeExecutor({
      codeCellLifecycle: {
        readExecutionStatus: async () => "succeeded",
        readToolExecutionStatus: async () => "succeeded",
      },
    });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding);
    await executor.start(runtime.process);
    binding.onNotification({
      method: "item/completed",
      params: {
        threadId: "ephemeral-model-free-thread",
        turnId: "turn-2",
        item: { type: "commandExecution", status: "completed", exitCode: 7 },
      },
    });
    const result = await executor.call({
      kind: "function",
      name: "exec_command",
      arguments: {
        cmd: "exit 7",
        sandbox_permissions: "require_escalated",
        justification: "unneeded",
        prefix_rule: ["pwsh"],
      },
    });
    expect(result.executionStatus).toBe("failed");
    const selected = runtime.selectedStreams.at(-1) ?? "";
    expect(selected).toContain("use_default");
    expect(selected).not.toContain("require_escalated");
    expect(selected).not.toContain("justification");
    binding.onNotification({
      method: "item/completed",
      params: {
        threadId: "other-thread",
        turnId: "turn-3",
        item: { type: "commandExecution", status: "completed", exitCode: 7 },
      },
    });
    await expect(
      executor.call({ kind: "function", name: "exec_command", arguments: { cmd: "exit 0" } }),
    ).resolves.toMatchObject({ executionStatus: "succeeded" });
  });

  it("preserves native failure data without starting a code cell", async () => {
    const failure = {
      isError: true,
      code: "NATIVE_FAILURE",
      stderr: "complete diagnostic",
      content: [{ type: "text", text: "failed" }],
    };
    const lifecycle = {
      readExecutionStatus: vi.fn(async () => {
        throw new Error("code cell must not run");
      }),
    };
    const executor = new ResponsesRuntimeExecutor({ codeCellLifecycle: lifecycle });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding, { nestedResult: failure });
    await executor.start(runtime.process);
    await expect(
      executor.callNested("exec_command", { cmd: "failing-command" }, false),
    ).resolves.toEqual(failure);
    expect(lifecycle.readExecutionStatus).not.toHaveBeenCalled();
  });

  it("preserves native App Server turn error fields and terminal context", async () => {
    const executor = new ResponsesRuntimeExecutor({
      turnTimeoutMs: 5_000,
      codeCellLifecycle: successfulCodeCellLifecycle,
    });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding);
    await executor.start(runtime.process);
    const nativeError = {
      name: "NativeRpcError",
      message: "native execution rejected",
      stack: "native-stack",
      code: "E_NATIVE_EXECUTION",
      details: { stderr: "full native stderr", retryable: false },
      structured: { stage: "tool-dispatch", ordinal: 7 },
    };
    runtime.failNextTurn(nativeError);

    let caught: unknown;
    try {
      await executor.call({
        kind: "function",
        namespace: "codex_app",
        name: "read_thread",
        arguments: { threadId: "thread-native-error" },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject(nativeError);
    expect(Reflect.get(caught as object, "appServerError")).toEqual(nativeError);
    expect(Reflect.get(caught as object, "appServerTurn")).toMatchObject({
      status: "failed",
      error: nativeError,
    });
    expect(Reflect.get(caught as object, "appServerNotification")).toMatchObject({
      method: "turn/completed",
    });
  });

  it("injects the live Codex app tool registry into functions.exec and refreshes it atomically", async () => {
    let dynamicTools: readonly Record<string, unknown>[] = [
      {
        type: "namespace",
        name: "codex_app",
        tools: [
          {
            type: "function",
            name: "send_message_to_thread",
            description: "Send a follow-up prompt to an existing Codex thread.",
            inputSchema: {
              type: "object",
              properties: {
                threadId: { type: "string" },
                prompt: { type: "string" },
              },
              required: ["threadId", "prompt"],
              additionalProperties: false,
            },
          },
        ],
      },
    ];
    const executor = new ResponsesRuntimeExecutor({
      turnTimeoutMs: 5_000,
      dynamicTools: () => dynamicTools,
      codeCellLifecycle: successfulCodeCellLifecycle,
    });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding);

    await executor.start(runtime.process);

    const initialThread = runtime.requests.find((request) => request.method === "thread/start");
    expect(initialThread?.params.dynamicTools).toEqual(dynamicTools);

    dynamicTools = [
      ...dynamicTools,
      {
        type: "namespace",
        name: "codex_app_runtime",
        tools: [
          {
            type: "function",
            name: "read_thread",
            description: "Read a Codex thread.",
            inputSchema: { type: "object", additionalProperties: true },
          },
        ],
      },
    ];
    await expect(
      executor.callNested("exec_command", { cmd: "adb devices" }, false),
    ).resolves.toEqual({ exit_code: 0, output: "device-123\tdevice" });

    const threadStarts = runtime.requests.filter((request) => request.method === "thread/start");
    expect(threadStarts).toHaveLength(2);
    expect(threadStarts[1]?.params.dynamicTools).toEqual(dynamicTools);
    expect(threadStarts[1]?.params.ephemeral).toBe(true);
    const replacement = threadStarts[1];
    if (replacement === undefined) throw new Error("Missing replacement execution thread");
    const replacementIndex = runtime.requests.indexOf(replacement);
    expect(runtime.requests[replacementIndex - 1]).toMatchObject({
      method: "thread/unsubscribe",
      params: { threadId: "ephemeral-model-free-thread" },
    });
  });

  it("retains the old registry thread when unsubscribe fails instead of spawning another MCP stack", async () => {
    let dynamicTools: readonly Record<string, unknown>[] = [];
    const executor = new ResponsesRuntimeExecutor({
      dynamicTools: () => dynamicTools,
      codeCellLifecycle: successfulCodeCellLifecycle,
    });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding);
    await executor.start(runtime.process);
    dynamicTools = [{ type: "function", name: "new_tool", inputSchema: { type: "object" } }];
    const request = runtime.process.client.request.bind(runtime.process.client);
    let failUnsubscribe = true;
    vi.spyOn(runtime.process.client, "request").mockImplementation(
      async (method, params, options) => {
        if (method === "thread/unsubscribe" && failUnsubscribe) {
          throw new Error("unsubscribe transport failed");
        }
        return request(method, params, options);
      },
    );
    await expect(executor.refreshCatalog()).rejects.toThrow("unsubscribe transport failed");
    expect(runtime.requests.filter((request) => request.method === "thread/start")).toHaveLength(1);
    failUnsubscribe = false;
    await executor.refreshCatalog();
    expect(runtime.requests.filter((request) => request.method === "thread/start")).toHaveLength(2);
    expect(runtime.requests.filter((request) => request.method === "thread/unsubscribe")).toEqual([
      expect.objectContaining({ params: { threadId: "ephemeral-model-free-thread" } }),
    ]);
  });

  it("reuses the execution thread when catalog object keys arrive in a different order", async () => {
    let dynamicTools: readonly Record<string, unknown>[] = [
      { type: "function", name: "stable_tool", inputSchema: { type: "object", properties: {} } },
    ];
    const executor = new ResponsesRuntimeExecutor({
      dynamicTools: () => dynamicTools,
      codeCellLifecycle: successfulCodeCellLifecycle,
    });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding);
    await executor.start(runtime.process);
    dynamicTools = [
      { inputSchema: { properties: {}, type: "object" }, name: "stable_tool", type: "function" },
    ];
    await executor.refreshCatalog();
    expect(runtime.requests.filter((request) => request.method === "thread/start")).toHaveLength(1);
    expect(
      runtime.requests.filter((request) => request.method === "thread/unsubscribe"),
    ).toHaveLength(0);
  });

  it("keeps yielded dynamic calls in one native turn and reads final wait status from the original cell", async () => {
    const statusCalls: string[] = [];
    const settled = vi.fn();
    const executor = new ResponsesRuntimeExecutor({
      onTurnSettled: settled,
      codeCellLifecycle: {
        readExecutionStatus: async (callId) => {
          statusCalls.push(callId);
          return "failed";
        },
      },
    });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding, {
      publicCellOutputs: [
        "Script running with cell ID retained-cell\n",
        "Script running with cell ID retained-cell\n",
        "Script failed\nOutput:\ndynamic tool call was cancelled before receiving a response",
      ],
    });
    await executor.start(runtime.process);
    settled.mockClear();
    const startsBefore = runtime.requests.filter(
      (request) => request.method === "turn/start",
    ).length;
    const first = await executor.call({
      kind: "custom",
      namespace: "functions",
      name: "exec",
      arguments: "// retained-public-cell\ntext(1);",
    });
    expect(first).toMatchObject({ yieldedCellId: "retained-cell", turnRetained: true });
    expect(settled).not.toHaveBeenCalled();
    const waiting = await executor.call({
      kind: "function",
      namespace: "functions",
      name: "wait",
      arguments: { cell_id: "retained-cell" },
    });
    expect(waiting).toMatchObject({ yieldedCellId: "retained-cell", turnRetained: true });
    expect(statusCalls).toEqual([]);
    const finished = await executor.call({
      kind: "function",
      namespace: "functions",
      name: "wait",
      arguments: { cell_id: "retained-cell" },
    });
    expect(finished.executionStatus).toBe("failed");
    expect(statusCalls).toEqual([first.callId]);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(runtime.requests.filter((request) => request.method === "turn/start")).toHaveLength(
      startsBefore + 1,
    );
  });

  it("preserves the live catalog when refresh arrives between exec yield and wait", async () => {
    const executor = new ResponsesRuntimeExecutor({
      codeCellLifecycle: successfulCodeCellLifecycle,
    });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding, {
      publicCellOutputs: ["Script running with cell ID retained-cell\n", "Script completed\n"],
    });
    await executor.start(runtime.process);
    const first = await executor.call({
      kind: "custom",
      namespace: "functions",
      name: "exec",
      arguments: "// retained-public-cell\ntext(1);",
    });
    expect(first.yieldedCellId).toBe("retained-cell");
    const before = executor.snapshot;
    const startsBefore = runtime.requests.filter(
      (request) => request.method === "turn/start",
    ).length;
    await expect(executor.refreshCatalog()).resolves.toBeUndefined();
    expect(executor.snapshot.tools).toEqual(before.tools);
    expect(executor.snapshot.nestedTools).toEqual(before.nestedTools);
    expect(runtime.requests.filter((request) => request.method === "turn/start")).toHaveLength(
      startsBefore,
    );
    const result = await executor.call({
      kind: "function",
      namespace: "functions",
      name: "wait",
      arguments: { cell_id: "retained-cell" },
    });
    expect(result.executionStatus).toBe("succeeded");
    await executor.refreshCatalog();
    expect(runtime.requests.filter((request) => request.method === "turn/start")).toHaveLength(
      startsBefore + 1,
    );
    expect(executor.snapshot.nestedTools.length).toBeGreaterThan(0);
  });

  it("preserves native startup failure output when a terminal turn has no code cell", async () => {
    const rawFailure =
      "failed to spawn code-mode host C:\\missing\\codex-code-mode-host.exe: os error 2";
    const executor = new ResponsesRuntimeExecutor();
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding, { publicCellOutputs: [rawFailure] });
    await executor.start(runtime.process);
    await expect(
      executor.call({
        kind: "custom",
        namespace: "functions",
        name: "exec",
        arguments: 'text("retained-public-cell")',
      }),
    ).resolves.toMatchObject({
      output: rawFailure,
      executionStatus: "failed",
    });
  });

  it("uses typed code-cell lifecycle status and does not infer functions.exec success", async () => {
    let status: "succeeded" | "failed" = "succeeded";
    const executor = new ResponsesRuntimeExecutor({
      turnTimeoutMs: 5_000,
      codeCellLifecycle: {
        readExecutionStatus: async () => status,
      },
    });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding);
    await executor.start(runtime.process);

    status = "failed";
    await expect(
      executor.call({
        kind: "custom",
        namespace: "functions",
        name: "exec",
        arguments: 'text("not-success")',
      }),
    ).resolves.toMatchObject({ executionStatus: "failed" });
    const forwardedCodeModeCall = runtime.selectedStreams.at(-1) ?? "";
    expect(forwardedCodeModeCall).toContain("OMNICODEX_CODE_MODE_WEB_PLATFORM_GLOBALS_V1");
    expect(forwardedCodeModeCall).not.toContain("OMNICODEX_CODE_MODE_NATIVE_TOOL_RESULTS_V1");
    expect(forwardedCodeModeCall).toContain('text(\\"not-success\\")');
    expect(forwardedCodeModeCall).not.toMatch(/\bprocess\b|\bBuffer\b/u);

    const unobserved = new ResponsesRuntimeExecutor({ turnTimeoutMs: 5_000 });
    executors.push(unobserved);
    const unobservedBinding = await unobserved.prepare();
    const unobservedRuntime = fakeRuntime(unobservedBinding);
    await unobserved.start(unobservedRuntime.process);
    await expect(
      unobserved.call({
        kind: "custom",
        namespace: "functions",
        name: "exec",
        arguments: 'text("not-observed")',
      }),
    ).rejects.toThrow("terminal envelope was missing or unsupported");
  });

  it("preserves native apply_patch values and thrown errors in the emitted Code Mode script", async () => {
    const executor = new ResponsesRuntimeExecutor({
      turnTimeoutMs: 5_000,
      codeCellLifecycle: successfulCodeCellLifecycle,
    });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding);
    await executor.start(runtime.process);
    await executor.call({
      kind: "custom",
      namespace: "functions",
      name: "exec",
      arguments: '// @exec: {"yield_time_ms": 10000}\ntext(await tools.apply_patch("patch"));',
    });
    const source = completedCustomToolInput(runtime.selectedStreams.at(-1) ?? "");
    expect(source).toBeDefined();
    expect(source).toMatch(/^\/\/ @exec: \{"yield_time_ms": 10000\}\n/u);
    const nativeError = new Error("native patch error");
    for (const result of [
      {},
      { success: true, stdout: "Updated example.txt" },
      { isError: true, content: [{ type: "text", text: "patch rejected" }] },
      nativeError,
    ]) {
      const applyPatch = vi.fn(async () => result);
      const tools = { apply_patch: applyPatch };
      const text = vi.fn();
      await runInNewContext(`(async () => {\n${source}\n})()`, { tools, text, ALL_TOOLS: [] });
      expect(text).toHaveBeenCalledOnce();
      expect(text.mock.calls[0]?.[0]).toBe(result);
      expect(applyPatch).toHaveBeenCalledExactlyOnceWith("patch");
    }
    await expect(
      runInNewContext(`(async () => {\n${source}\n})()`, {
        tools: {
          apply_patch: async () => {
            throw nativeError;
          },
        },
        text: vi.fn(),
        ALL_TOOLS: [],
      }),
    ).rejects.toBe(nativeError);
  });

  it("calls freeform tools directly and preserves an empty native result", async () => {
    const executor = new ResponsesRuntimeExecutor();
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding, { nestedResult: {} });
    await executor.start(runtime.process);
    const patch = "*** Begin Patch\n*** End Patch";
    await expect(executor.callNested("apply_patch", { input: patch }, true)).resolves.toEqual({});
    expect(completedCustomToolInput(runtime.selectedStreams.at(-1) ?? "")).toBe(patch);
    expect(runtime.selectedStreams.at(-1)).toContain('"name":"apply_patch"');
    expect(runtime.selectedStreams.at(-1)).not.toContain('"name":"exec"');
  });

  it("interrupts an aborted turn through the installed App Server contract and waits for terminal state", async () => {
    const executor = new ResponsesRuntimeExecutor({
      turnTimeoutMs: 5_000,
      codeCellLifecycle: successfulCodeCellLifecycle,
    });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding);
    await executor.start(runtime.process);
    runtime.holdNextTurn();

    const controller = new AbortController();
    let settled = false;
    const pending = executor
      .call(
        {
          kind: "custom",
          namespace: "functions",
          name: "exec",
          arguments: 'text("held")',
        },
        controller.signal,
      )
      .finally(() => {
        settled = true;
      });
    const turnId = await runtime.waitForHeldTurn();
    expect(executor.executionSignal("ephemeral-model-free-thread")).toBe(controller.signal);
    controller.abort(new Error("cancel held Responses tool"));
    await runtime.waitForInterrupt();
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(
      runtime.requests.find(
        (request) => request.method === "turn/interrupt" && request.params.turnId === turnId,
      )?.params,
    ).toEqual({ threadId: "ephemeral-model-free-thread", turnId });

    runtime.releaseInterruptedTurn();
    await expect(pending).rejects.toThrow("cancel held Responses tool");
    expect(settled).toBe(true);
    expect(executor.executionSignal("ephemeral-model-free-thread")).toBeUndefined();
  });

  it("hard-stops only the attached owned App Server when the default terminal grace expires", async () => {
    const executor = new ResponsesRuntimeExecutor({
      turnTimeoutMs: 5_000,
      codeCellLifecycle: successfulCodeCellLifecycle,
    });
    executors.push(executor);
    const binding = await executor.prepare();
    const runtime = fakeRuntime(binding);
    await executor.start(runtime.process);
    runtime.holdNextTurn();

    vi.useFakeTimers();
    try {
      const pending = executor.call({
        kind: "custom",
        namespace: "functions",
        name: "exec",
        arguments: 'text("never terminal")',
      });
      const rejected = expect(pending).rejects.toThrow("Responses executor turn timed out");
      const turnId = await runtime.waitForHeldTurn();
      await vi.advanceTimersByTimeAsync(5_000);
      await runtime.waitForInterrupt();
      expect(runtime.stopCalls()).toBe(0);

      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(turnId).toMatch(/^turn-/u);
      expect(runtime.stopCalls()).toBe(1);
      expect(executor.running).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("native Code Mode envelope without diagnostic files", () => {
  it("preserves native host failures emitted before an envelope exists", () => {
    expect(
      nativeCodeCellExecutionStatus(
        "code-mode initial response exceeds the IPC frame limit: code-mode IPC frame length 81918949 exceeds 67108864 bytes",
      ),
    ).toBe("failed");
    expect(nativeCodeCellExecutionStatus("failed to spawn code-mode host: os error 2")).toBe(
      "failed",
    );
    expect(nativeCodeCellExecutionStatus("Script completed")).toBe("failed");
  });
  it("marks a missing native image as failure and accepts actual image content", () => {
    expect(
      nativeDirectToolExecutionStatus("view_image", "unable to locate image: os error 2"),
    ).toBe("failed");
    expect(
      nativeDirectToolExecutionStatus("view_image", [
        { type: "input_image", image_url: "data:image/png;base64,test" },
      ]),
    ).toBe("succeeded");
  });
  const header = (state: string) => ({
    type: "input_text",
    text: `Script ${state}\nWall time 0.0 seconds\nOutput:\n`,
  });
  it("uses the host envelope and ignores contradictory caller text", () => {
    expect(nativeCodeCellExecutionStatus([header("completed"), header("failed")])).toBe(
      "succeeded",
    );
    expect(nativeCodeCellExecutionStatus([header("failed"), header("completed")])).toBe("failed");
  });
  it("does not reinterpret caller strings, missing headers or unknown native formats as success", () => {
    for (const output of [
      undefined,
      [],
      [{ type: "input_text", text: "Script completed" }],
      [header("running")],
      [{ type: "input_image", image_url: "private" }, header("completed")],
    ]) {
      expect(() => nativeCodeCellExecutionStatus(output)).toThrow(
        "terminal envelope was missing or unsupported",
      );
    }
  });
});

interface RecordedRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly requestOptions?: unknown;
}

const successfulCodeCellLifecycle: ResponsesCodeCellLifecycleSource = {
  readExecutionStatus: async () => "succeeded",
};

function fakeRuntime(
  binding: ResponsesRuntimeExecutorBinding,
  options: {
    readonly publicCellOutputs?: readonly unknown[];
    readonly catalogInAdditionalTools?: boolean;
    readonly catalogDescription?: string;
    readonly directTools?: readonly unknown[];
    readonly mcpStatusPage?: (params: Record<string, unknown>, requestOrdinal: number) => unknown;
    readonly nestedResult?: unknown;
    readonly startTurnError?: Error;
    readonly startThreadError?: Error;
    readonly unsubscribeFailures?: number;
  } = {},
): {
  readonly process: CodexAppServerProcess;
  readonly requests: RecordedRequest[];
  readonly selectedStreams: string[];
  holdNextTurn(): void;
  waitForHeldTurn(): Promise<string>;
  waitForInterrupt(): Promise<void>;
  releaseInterruptedTurn(): void;
  failNextTurn(error: unknown, status?: string): void;
  failNextUnsubscribe(): void;
  stopCalls(): number;
} {
  const requests: RecordedRequest[] = [];
  const selectedStreams: string[] = [];
  const baseUrl = loopbackBaseUrl(binding);
  const secret = binding.env.OMNICODEX_LOOPBACK_API_KEY ?? "";
  let turnOrdinal = 0;
  let holdNextTurn = false;
  let heldTurnId: string | undefined;
  let heldTurnStarted: Promise<string> = Promise.reject(
    new Error("No fake Responses turn was held"),
  );
  heldTurnStarted.catch(() => undefined);
  let markHeldTurnStarted: ((turnId: string) => void) | undefined;
  let interruptObserved: Promise<void> = Promise.reject(
    new Error("No fake Responses interrupt was observed"),
  );
  interruptObserved.catch(() => undefined);
  let markInterruptObserved: (() => void) | undefined;
  let interruptTerminal: Promise<void> = Promise.resolve();
  let releaseInterruptTerminal: (() => void) | undefined;
  let nextTurnFailure: { readonly error: unknown; readonly status: string } | undefined;
  let mcpStatusRequestOrdinal = 0;
  let ownedStopCalls = 0;
  let unsubscribeFailures = options.unsubscribeFailures ?? 0;
  const process = {
    client: {
      request: async (
        method: string,
        paramsValue: unknown,
        requestOptions?: unknown,
      ): Promise<unknown> => {
        const params = isObject(paramsValue) ? paramsValue : {};
        requests.push({
          method,
          params,
          ...(requestOptions === undefined ? {} : { requestOptions }),
        });
        if (method === "mcpServerStatus/list") {
          const customPage = options.mcpStatusPage?.(params, mcpStatusRequestOrdinal);
          mcpStatusRequestOrdinal += 1;
          if (customPage !== undefined) return customPage;
          return { data: [{ name: "native", tools: { node_repl: {} } }] };
        }
        if (method === "skills/list") {
          return {
            data: [
              {
                skills: [
                  {
                    enabled: true,
                    name: "android-remote-device-lab",
                    path: "C:/skills/android-remote-device-lab/SKILL.md",
                    scope: "user",
                  },
                  {
                    enabled: true,
                    name: "chrome:control-chrome",
                    path: "C:/skills/chrome/SKILL.md",
                    scope: "system",
                  },
                ],
              },
            ],
          };
        }
        if (method === "thread/start") {
          if (options.startThreadError !== undefined) throw options.startThreadError;
          return { thread: { id: "ephemeral-model-free-thread" } };
        }
        if (method === "thread/unsubscribe") {
          if (unsubscribeFailures > 0) {
            unsubscribeFailures -= 1;
            throw new Error("unsubscribe transport failed");
          }
          return { status: "unsubscribed" };
        }
        if (method === "turn/interrupt") {
          if (params.turnId !== heldTurnId) {
            throw new Error(`Unexpected fake Responses interrupt target ${String(params.turnId)}`);
          }
          markInterruptObserved?.();
          void interruptTerminal.then(() => {
            binding.onNotification({
              method: "turn/completed",
              params: { turn: { id: heldTurnId, status: "interrupted" } },
            });
          });
          return {};
        }
        if (method !== "turn/start") throw new Error(`Unexpected fake runtime method ${method}`);
        if (options.startTurnError !== undefined) throw options.startTurnError;
        turnOrdinal += 1;
        const turnId = `turn-${turnOrdinal}`;
        if (nextTurnFailure !== undefined) {
          const failure = nextTurnFailure;
          nextTurnFailure = undefined;
          queueMicrotask(() => {
            binding.onNotification({
              method: "turn/completed",
              params: {
                turn: {
                  id: turnId,
                  status: failure.status,
                  error: failure.error,
                },
              },
            });
          });
          return { turn: { id: turnId } };
        }
        if (holdNextTurn) {
          holdNextTurn = false;
          heldTurnId = turnId;
          markHeldTurnStarted?.(turnId);
          return { turn: { id: turnId } };
        }
        void emulateResponsesTurn(
          baseUrl,
          secret,
          params,
          turnId,
          binding,
          selectedStreams,
          options,
        ).catch((error: unknown) => {
          binding.onNotification({
            method: "turn/completed",
            params: {
              turn: {
                id: turnId,
                status: "failed",
                error: { message: error instanceof Error ? error.message : String(error) },
              },
            },
          });
        });
        return { turn: { id: turnId } };
      },
    },
    stop: async () => {
      ownedStopCalls += 1;
      if (heldTurnId === undefined) return;
      binding.onNotification({
        method: "turn/completed",
        params: {
          turn: {
            id: heldTurnId,
            status: "failed",
            error: { message: "exact owned App Server stopped" },
          },
        },
      });
    },
  } as unknown as CodexAppServerProcess;
  return {
    process,
    requests,
    selectedStreams,
    holdNextTurn: () => {
      if (holdNextTurn || heldTurnId !== undefined) {
        throw new Error("A fake Responses turn is already held");
      }
      holdNextTurn = true;
      heldTurnStarted = new Promise<string>((resolve) => {
        markHeldTurnStarted = resolve;
      });
      interruptObserved = new Promise<void>((resolve) => {
        markInterruptObserved = resolve;
      });
      interruptTerminal = new Promise<void>((resolve) => {
        releaseInterruptTerminal = resolve;
      });
    },
    waitForHeldTurn: () => heldTurnStarted,
    waitForInterrupt: () => interruptObserved,
    releaseInterruptedTurn: () => releaseInterruptTerminal?.(),
    failNextTurn: (error, status = "failed") => {
      nextTurnFailure = { error, status };
    },
    failNextUnsubscribe: () => {
      unsubscribeFailures += 1;
    },
    stopCalls: () => ownedStopCalls,
  };
}

async function emulateResponsesTurn(
  baseUrl: string,
  secret: string,
  params: Record<string, unknown>,
  turnId: string,
  binding: ResponsesRuntimeExecutorBinding,
  selectedStreams: string[],
  options: {
    readonly publicCellOutputs?: readonly unknown[];
    readonly catalogInAdditionalTools?: boolean;
    readonly catalogDescription?: string;
    readonly directTools?: readonly unknown[];
    readonly nestedResult?: unknown;
  },
): Promise<void> {
  const directTools = options.directTools ?? [
    {
      name: "exec_command",
      description:
        "Runs a hidden child process.\n\nexec tool declaration:\n```ts\ndeclare const tools: { exec_command(args: { cmd: string; }): Promise<unknown>; };\n```",
    },
    {
      name: "apply_patch",
      description:
        "This is a FREEFORM tool.\n\nexec tool declaration:\n```ts\ndeclare const tools: { apply_patch(input: string): Promise<unknown>; };\n```",
    },
  ];
  const input = Array.isArray(params.input) ? [...params.input] : [];
  if (options.catalogInAdditionalTools !== false) {
    input.push({
      type: "additional_tools",
      role: "developer",
      tools: [
        {
          type: "namespace",
          name: "functions",
          description: "",
          tools: [
            {
              type: "custom",
              name: "exec",
              description: options.catalogDescription ?? renderedExecCatalog(directTools),
              format: { type: "grammar", syntax: "lark", definition: "start: /[\\s\\S]+/" },
            },
          ],
        },
      ],
    });
  }
  const first = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-omnicodex-loopback-key": secret },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input,
      tools: [{ type: "custom", name: "exec", description: "Execute native code-mode tools." }],
    }),
  });
  const selected = await first.text();
  if (!first.ok) throw new Error(selected);
  const callId = /"call_id":"([^"]+)"/.exec(selected)?.[1];
  if (options.publicCellOutputs !== undefined && selected.includes("retained-public-cell")) {
    let nextStream = selected;
    for (const output of options.publicCellOutputs) {
      const nextCallId = /"call_id":"([^"]+)"/.exec(nextStream)?.[1];
      if (nextCallId === undefined) throw new Error("Native turn ended before the cell settled");
      selectedStreams.push(nextStream);
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-omnicodex-loopback-key": secret },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          input: [
            {
              type: nextStream.includes('"type":"custom_tool_call"')
                ? "custom_tool_call_output"
                : "function_call_output",
              call_id: nextCallId,
              output,
            },
          ],
          tools: [],
        }),
      });
      nextStream = await response.text();
      if (!response.ok) throw new Error(nextStream);
    }
    if (!nextStream.includes("OMNICODEX_LOOPBACK_COMPLETE"))
      throw new Error("Cell finished without terminal response");
    binding.onNotification({
      method: "turn/completed",
      params: { turn: { id: turnId, status: "completed" } },
    });
    return;
  }
  if (callId !== undefined) {
    selectedStreams.push(selected);
    const selectedInput = completedCustomToolInput(selected) ?? selected;
    const discovery = selectedInput.includes("const __excludedNames = new Set(");
    const excludedNamesSource =
      /const __excludedNames = new Set\((\[[^;]*\])\);/.exec(selectedInput)?.[1] ?? "[]";
    const excludedNames = new Set(JSON.parse(excludedNamesSource) as string[]);
    const serializedDirectTools = JSON.stringify(
      directTools.filter(
        (tool) => !isObject(tool) || typeof tool.name !== "string" || !excludedNames.has(tool.name),
      ),
    );
    const offset = Number(/const __offset = (\d+);/.exec(selectedInput)?.[1] ?? "0");
    const chunkChars = Number(/const __chunkChars = (\d+);/.exec(selectedInput)?.[1] ?? "8000");
    const chunk = serializedDirectTools.slice(offset, offset + chunkChars);
    let output: unknown;
    const notificationOutputs: unknown[] = [];
    if (discovery) {
      output = [
        {
          type: "input_text",
          text: JSON.stringify({
            schemaVersion: 1,
            totalChars: serializedDirectTools.length,
            checksum: testCatalogChecksum(serializedDirectTools),
            offset,
            nextOffset: offset + chunk.length,
            chunk,
          }),
        },
      ];
    } else {
      output =
        selected.includes('"type":"function_call"') || selected.includes('"name":"apply_patch"')
          ? (options.nestedResult ?? { exit_code: 0, output: "device-123\tdevice" })
          : [
              {
                type: "text",
                text: 'OMNICODEX_NESTED_RESULT_V1:{"exit_code":0,"output":"device-123\\tdevice"}',
              },
            ];
    }

    const completed = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-omnicodex-loopback-key": secret },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: [
          ...notificationOutputs.map((notificationOutput) => ({
            type: "custom_tool_call_output",
            call_id: callId,
            name: "exec",
            output: notificationOutput,
          })),
          {
            type: selected.includes('"type":"function_call"')
              ? "function_call_output"
              : "custom_tool_call_output",
            call_id: callId,
            output,
          },
        ],
        tools: [],
      }),
    });
    if (!completed.ok) throw new Error(await completed.text());
    await completed.text();
  }
  binding.onNotification({
    method: "turn/completed",
    params: { turn: { id: turnId, status: "completed" } },
  });
}

function completedCustomToolInput(stream: string): string | undefined {
  for (const block of stream.split(/\r?\n\r?\n/u)) {
    const lines = block.split(/\r?\n/u);
    if (lines[0] !== "event: response.custom_tool_call_input.done") continue;
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
    if (data === undefined) continue;
    const value: unknown = JSON.parse(data);
    if (isObject(value) && typeof value.input === "string") return value.input;
  }
  return undefined;
}

function renderedExecCatalog(tools: readonly unknown[]): string {
  const sections = tools.map((tool, index) => {
    if (
      !isObject(tool) ||
      typeof tool.name !== "string" ||
      tool.name.length === 0 ||
      typeof tool.description !== "string"
    ) {
      throw new Error(`Cannot render malformed fake catalog entry ${index}`);
    }
    return `### \`${tool.name}\`\n${tool.description}`;
  });
  return [
    "Run JavaScript code to orchestrate/compose tool calls",
    "All nested tools are available on the global `tools` object and listed in `ALL_TOOLS`.",
    ...sections,
  ].join("\n\n");
}

function loopbackBaseUrl(binding: ResponsesRuntimeExecutorBinding): string {
  const entry = binding.configOverrides.find((value) =>
    /^model_providers\.[^.]+\.base_url=/.test(value),
  );
  if (entry === undefined) throw new Error("Loopback base URL override missing");
  return JSON.parse(entry.slice(entry.indexOf("=") + 1)) as string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function testCatalogChecksum(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
