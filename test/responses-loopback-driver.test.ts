import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import type { CodexModelMetadataSnapshot } from "../src/infrastructure/runtime/codex-model-metadata-source.js";
import { ResponsesLoopbackDriver } from "../src/infrastructure/runtime/responses-loopback-driver.js";

const TEST_MODEL = Object.freeze({
  slug: "gpt-5.6-sol",
  context_window: 272_000,
  max_context_window: 872_000,
  shell_type: "unified_exec",
  unknown_nested_field: Object.freeze({ preserved: "그대로" }),
});
const TEST_MODEL_METADATA: CodexModelMetadataSnapshot = Object.freeze({
  rawModel: TEST_MODEL,
  modelDigest: "0".repeat(64),
  cachePath: "C:\\test\\.codex\\models_cache.json",
});

interface FetchCall {
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
  readonly method: string | undefined;
  readonly redirect: "error" | "follow" | "manual" | undefined;
  readonly signal: AbortSignal | null | undefined;
}

describe("ResponsesLoopbackDriver", () => {
  it("preserves distinct same-name tool specifications and deduplicates only exact copies", async () => {
    const driver = new ResponsesLoopbackDriver();
    await driver.start();
    try {
      const first = {
        type: "function",
        name: "same_name",
        description: "first",
        parameters: { type: "object", properties: { first: { type: "string" } } },
        _meta: { source: "first" },
      };
      const second = {
        type: "function",
        name: "same_name",
        description: "second",
        parameters: { type: "object", properties: { second: { type: "number" } } },
        _meta: { source: "second" },
      };
      const response = await postResponses(driver, {
        model: "loopback",
        input: [],
        tools: [first, second, structuredClone(first)],
      });
      expect(response.status).toBe(200);
      await response.text();

      expect(driver.snapshot.tools).toEqual([first, second]);
    } finally {
      await driver.stop();
    }
  });

  it("single-flights concurrent stops, retains the live handle, and retries a failed close", async () => {
    let server: Server | undefined;
    const driver = new ResponsesLoopbackDriver({
      binding: {
        host: "127.0.0.1",
        listen: async (candidate) => {
          server = candidate;
          return await listenOnLoopback(candidate);
        },
      },
    });
    await driver.start();
    const activeServer = server;
    if (activeServer === undefined) throw new Error("Test binding did not capture the server");
    const originalClose = activeServer.close;
    let closeCalls = 0;
    let failFirstClose: (() => void) | undefined;
    activeServer.close = function (this: Server, callback) {
      closeCalls += 1;
      if (closeCalls === 1) {
        failFirstClose = () => callback?.(new Error("synthetic close failure"));
        return this;
      }
      return originalClose.call(this, callback);
    } as Server["close"];

    const baseUrl = driver.baseUrl;
    const first = driver.stop();
    const concurrent = driver.stop();
    expect(concurrent).toBe(first);
    expect(closeCalls).toBe(1);
    expect(driver.baseUrl).toBe(baseUrl);
    await expect(driver.start()).rejects.toThrow("already started");

    failFirstClose?.();
    await expect(first).rejects.toThrow("synthetic close failure");
    await expect(concurrent).rejects.toThrow("synthetic close failure");
    expect(driver.baseUrl).toBe(baseUrl);

    await expect(driver.stop()).resolves.toBeUndefined();
    expect(closeCalls).toBe(2);
    expect(() => driver.baseUrl).toThrow("has not been started");
  });

  it("drains an active tool call to its complete response when stop has no deadline", async () => {
    const driver = new ResponsesLoopbackDriver();
    await driver.start();
    const active = driver.prepareToolCall({
      kind: "function",
      namespace: "functions",
      name: "exec_command",
      arguments: { cmd: "long but finite operation" },
    });

    let stopSettled = false;
    const stopped = driver.stop().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    expect(() =>
      driver.prepareToolCall({ kind: "function", name: "other", arguments: {} }),
    ).toThrow("is draining");

    const selected = await postResponses(driver, {
      model: "loopback",
      input: [active.executionNonce],
      tools: [],
    });
    expect(selected.status).toBe(200);
    await selected.text();
    expect(stopSettled).toBe(false);

    const output = {
      stdout: "complete stdout",
      stderr: "complete stderr",
      structuredContent: { all: [1, 2, 3] },
    };
    const completed = await postResponses(driver, {
      model: "loopback",
      input: [{ type: "function_call_output", call_id: active.callId, output }],
      tools: [],
    });
    expect(completed.status).toBe(200);
    expect(await completed.text()).toContain("OMNICODEX_LOOPBACK_COMPLETE");
    await expect(active.completion).resolves.toMatchObject({ output });
    await stopped;
    expect(stopSettled).toBe(true);
    expect(() => driver.baseUrl).toThrow("has not been started");
  });

  it("finishes an already-draining loopback when its app-server transport has disappeared", async () => {
    const driver = new ResponsesLoopbackDriver();
    await driver.start();
    const active = driver.prepareToolCall({ kind: "function", name: "test", arguments: {} });
    const rejected = expect(active.completion).rejects.toThrow("Desktop connection lost");
    const draining = driver.stop();
    await driver.stopAfterTransportFailure(new Error("Desktop connection lost"));
    await draining;
    await rejected;
    expect(() => driver.baseUrl).toThrow("has not been started");
  });

  it("binds each selected call to one execution nonce and one exact output type", async () => {
    const upstreamCalls: string[] = [];
    const driver = new ResponsesLoopbackDriver({
      fetchImpl: async (input) => {
        upstreamCalls.push(String(input));
        throw new Error("A local executor turn must not make a model request");
      },
    });
    expect(() =>
      driver.prepareToolCall({ kind: "function", name: "exec_command", arguments: {} }),
    ).toThrow("is not started");

    await driver.start();
    try {
      const missingNonce = driver.prepareToolCall({
        kind: "function",
        name: "exec_command",
        arguments: { cmd: "adb devices" },
      });
      const missingNonceFailure = missingNonce.completion.catch((error: unknown) => error);
      const rejected = await postResponses(driver, { model: "loopback", input: [], tools: [] });
      expect(rejected.status).toBe(409);
      await expect(errorCode(rejected)).resolves.toBe("RESPONSES_EXECUTION_NONCE_MISMATCH");
      await expect(missingNonceFailure).resolves.toMatchObject({
        code: "RESPONSES_EXECUTION_NONCE_MISMATCH",
      });

      const repeated = driver.prepareToolCall({
        kind: "function",
        name: "exec_command",
        arguments: { cmd: "adb devices" },
      });
      const repeatedFailure = repeated.completion.catch((error: unknown) => error);
      const selected = await postResponses(driver, {
        model: "loopback",
        input: [repeated.executionNonce],
        tools: [],
      });
      expect(selected.status).toBe(200);
      expect(await selected.text()).toContain('"name":"exec_command"');
      const duplicate = await postResponses(driver, {
        model: "loopback",
        input: [repeated.executionNonce],
        tools: [],
      });
      expect(duplicate.status).toBe(409);
      await expect(errorCode(duplicate)).resolves.toBe("RESPONSES_TOOL_OUTPUT_MISMATCH");
      await expect(repeatedFailure).resolves.toMatchObject({
        code: "RESPONSES_TOOL_OUTPUT_MISMATCH",
      });

      const wrongOutput = driver.prepareToolCall({
        kind: "custom",
        name: "exec",
        arguments: 'text("ok")',
      });
      const wrongOutputFailure = wrongOutput.completion.catch((error: unknown) => error);
      const customSelected = await postResponses(driver, {
        model: "loopback",
        input: [wrongOutput.executionNonce],
        tools: [],
      });
      expect(customSelected.status).toBe(200);
      await customSelected.text();
      const mismatched = await postResponses(driver, {
        model: "loopback",
        input: [
          {
            type: "function_call_output",
            call_id: wrongOutput.callId,
            output: "wrong protocol form",
          },
        ],
        tools: [],
      });
      expect(mismatched.status).toBe(409);
      await expect(errorCode(mismatched)).resolves.toBe("RESPONSES_TOOL_OUTPUT_MISMATCH");
      await expect(wrongOutputFailure).resolves.toMatchObject({
        code: "RESPONSES_TOOL_OUTPUT_MISMATCH",
      });
      expect(upstreamCalls).toEqual([]);
    } finally {
      await driver.stop();
    }

    expect(driver.snapshot.tools).toEqual([]);
    await driver.start();
    await driver.stop();
  });

  it.each(["text", "multipart", "json-multipart", "completed-with-lookalike-payload"])(
    "reads the native functions.exec status header for %s output",
    async (format) => {
      const driver = new ResponsesLoopbackDriver();
      await driver.start();
      try {
        const active = driver.prepareToolCall({
          kind: "custom",
          namespace: "functions",
          name: "exec",
          arguments: "await new Promise(() => undefined);",
        });
        const selected = await postResponses(driver, {
          model: "loopback",
          input: [active.executionNonce],
          tools: [],
        });
        await selected.text();

        const header = "Script running with cell ID cell-native\nWall time 30.0 seconds\nOutput:\n";
        const parts = [
          { type: "input_text", text: header },
          { type: "input_text", text: "earlier text() output" },
        ];
        const yielded =
          format === "text"
            ? header
            : format === "multipart"
              ? parts
              : format === "json-multipart"
                ? JSON.stringify(parts)
                : [
                    {
                      type: "input_text",
                      text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
                    },
                    { type: "input_text", text: header },
                  ];
        const completed = await postResponses(driver, {
          model: "loopback",
          input: [
            {
              type: "custom_tool_call_output",
              call_id: active.callId,
              output: yielded,
            },
          ],
          tools: [],
        });
        const stream = await completed.text();
        expect(stream).toContain("OMNICODEX_LOOPBACK_COMPLETE");
        expect(stream).not.toContain('"name":"wait"');
        await expect(active.completion).resolves.toMatchObject({
          callId: active.callId,
          outputType: "custom_tool_call_output",
          output: yielded,
          ...(format === "completed-with-lookalike-payload"
            ? {}
            : { yieldedCellId: "cell-native" }),
          rawItem: {
            type: "custom_tool_call_output",
            call_id: active.callId,
            output: yielded,
          },
          rawItems: [
            {
              type: "custom_tool_call_output",
              call_id: active.callId,
              output: yielded,
            },
          ],
        });
        if (format === "completed-with-lookalike-payload") {
          expect((await active.completion).yieldedCellId).toBeUndefined();
        }
      } finally {
        await driver.stop();
      }
    },
  );

  it.each([false, true])(
    "preserves post-yield exec notifications without replay or cross-call mixing (internal=%s)",
    async (internal) => {
      const driver = new ResponsesLoopbackDriver();
      await driver.start();
      try {
        const original = driver.prepareToolCall(
          {
            kind: "custom",
            namespace: "functions",
            name: "exec",
            arguments: 'notify("before"); await work(); notify("after"); text("final");',
          },
          { awaitYieldedExec: internal, preserveYieldedTurn: !internal },
        );
        await (await postResponses(driver, { input: [original.executionNonce], tools: [] })).text();
        const before = {
          type: "custom_tool_call_output",
          call_id: original.callId,
          name: "exec",
          output: "before",
        };
        const after = { ...before, output: "after" };
        const yieldOutput =
          "Script running with cell ID notification-cell\nWall time 1.0 seconds\nOutput:\n";
        const yielded = {
          type: "custom_tool_call_output",
          call_id: original.callId,
          output: yieldOutput,
        };
        const initialResponse = postResponses(driver, { input: [before, yielded], tools: [] });
        let completion = original.completion;
        let waitId: unknown;
        if (internal) {
          waitId = completedFunctionCall(await (await initialResponse).text()).call_id;
        } else {
          expect((await original.completion).rawItems).toEqual([before, yielded]);
          const waiting = driver.prepareToolCall(
            {
              kind: "function",
              namespace: "functions",
              name: "wait",
              arguments: { cell_id: "notification-cell" },
            },
            { preserveYieldedTurn: true },
          );
          completion = waiting.completion;
          waitId = waiting.callId;
          await (await initialResponse).text();
        }
        const waitYield = { type: "function_call_output", call_id: waitId, output: yieldOutput };
        const nextResponse = postResponses(driver, {
          input: [before, yielded, after, waitYield],
          tools: [],
        });
        if (internal) {
          waitId = completedFunctionCall(await (await nextResponse).text()).call_id;
        } else {
          expect((await completion).rawItems).toEqual([after, waitYield]);
          const waiting = driver.prepareToolCall(
            {
              kind: "function",
              namespace: "functions",
              name: "wait",
              arguments: { cell_id: "notification-cell" },
            },
            { preserveYieldedTurn: true },
          );
          completion = waiting.completion;
          waitId = waiting.callId;
          await (await nextResponse).text();
        }
        // Replay prior notifications, then emit a second identical notification.
        const final = { type: "function_call_output", call_id: waitId, output: "final" };
        await (
          await postResponses(driver, {
            input: [
              before,
              yielded,
              after,
              waitYield,
              { ...after, call_id: "unrelated" },
              after,
              final,
            ],
            tools: [],
          })
        ).text();
        expect((await completion).rawItems).toEqual(
          internal ? [before, yielded, after, waitYield, after, final] : [after, final],
        );
      } finally {
        driver.cancelActiveToolCall(new Error("test cleanup"));
        await driver.stop();
      }
    },
  );

  it("waits through repeated functions.exec yields for an internal adapter script", async () => {
    const driver = new ResponsesLoopbackDriver();
    await driver.start();
    try {
      const active = driver.prepareToolCall(
        {
          kind: "custom",
          namespace: "functions",
          name: "exec",
          arguments: "const result = await tools.long_running({}); text(result);",
        },
        { awaitYieldedExec: true },
      );
      let completionSettled = false;
      const completion = active.completion.then((result) => {
        completionSettled = true;
        return result;
      });

      const selected = await postResponses(driver, {
        model: "loopback",
        input: [active.executionNonce],
        tools: [],
      });
      expect(selected.status).toBe(200);
      await selected.text();

      const firstWaitResponse = await postResponses(driver, {
        model: "loopback",
        input: [
          {
            type: "custom_tool_call_output",
            call_id: active.callId,
            output: "Script running with cell ID cell-1\nWall time 30.0 seconds\nOutput:\n",
          },
        ],
        tools: [],
      });
      expect(firstWaitResponse.status).toBe(200);
      const firstWaitStream = await firstWaitResponse.text();
      expect(firstWaitStream).not.toContain("OMNICODEX_LOOPBACK_COMPLETE");
      const firstWait = completedFunctionCall(firstWaitStream);
      expect(firstWait).toMatchObject({
        type: "function_call",
        namespace: "functions",
        name: "wait",
      });
      expect(JSON.parse(String(firstWait.arguments))).toEqual({
        cell_id: "cell-1",
        yield_time_ms: 30_000,
      });
      await Promise.resolve();
      expect(completionSettled).toBe(false);

      const longCellId = `cell-${"x".repeat(300)}`;
      const deeplyNestedYield = Array.from({ length: 16 }).reduce<unknown>(
        (nested) => ({ nested }),
        { Yielded: { cell_id: longCellId, content_items: [] } },
      );
      const secondWaitResponse = await postResponses(driver, {
        model: "loopback",
        input: [
          {
            type: "function_call_output",
            call_id: firstWait.call_id,
            output: deeplyNestedYield,
          },
        ],
        tools: [],
      });
      expect(secondWaitResponse.status).toBe(200);
      const secondWaitStream = await secondWaitResponse.text();
      expect(secondWaitStream).not.toContain("OMNICODEX_LOOPBACK_COMPLETE");
      const secondWait = completedFunctionCall(secondWaitStream);
      expect(secondWait.call_id).not.toBe(firstWait.call_id);
      expect(JSON.parse(String(secondWait.arguments))).toEqual({
        cell_id: longCellId,
        yield_time_ms: 30_000,
      });
      await Promise.resolve();
      expect(completionSettled).toBe(false);

      const completedResponse = await postResponses(driver, {
        model: "loopback",
        input: [
          {
            type: "function_call_output",
            call_id: secondWait.call_id,
            output: "final native output",
          },
        ],
        tools: [],
      });
      expect(completedResponse.status).toBe(200);
      expect(await completedResponse.text()).toContain("OMNICODEX_LOOPBACK_COMPLETE");
      await expect(completion).resolves.toMatchObject({
        callId: active.callId,
        outputType: "custom_tool_call_output",
        output: "final native output",
        rawItem: {
          type: "custom_tool_call_output",
          call_id: active.callId,
          output: "final native output",
        },
      });
      expect(completionSettled).toBe(true);
    } finally {
      await driver.stop();
    }
  });

  it("settles functions.exec from its one terminal output while preserving notify events", async () => {
    const driver = new ResponsesLoopbackDriver();
    await driver.start();
    try {
      const active = driver.prepareToolCall({
        kind: "custom",
        namespace: "functions",
        name: "exec",
        arguments: 'notify("started"); text("terminal result"); notify("finished");',
      });
      const selected = await postResponses(driver, {
        model: "loopback",
        input: [active.executionNonce],
        tools: [],
      });
      expect(selected.status).toBe(200);
      await selected.text();

      const completed = await postResponses(driver, {
        model: "loopback",
        input: [
          {
            type: "custom_tool_call_output",
            call_id: active.callId,
            output: [
              { type: "input_text", text: "Script completed\nOutput:\n" },
              { type: "input_text", text: "terminal result" },
            ],
          },
          {
            type: "custom_tool_call_output",
            call_id: active.callId,
            name: "exec",
            output: "started",
          },
          {
            type: "custom_tool_call_output",
            call_id: active.callId,
            name: "exec",
            output: "finished",
          },
        ],
        tools: [],
      });

      expect(completed.status).toBe(200);
      expect(await completed.text()).toContain("OMNICODEX_LOOPBACK_COMPLETE");
      await expect(active.completion).resolves.toMatchObject({
        callId: active.callId,
        outputType: "custom_tool_call_output",
        output: [
          { type: "input_text", text: "Script completed\nOutput:\n" },
          { type: "input_text", text: "terminal result" },
        ],
        rawItem: {
          type: "custom_tool_call_output",
          call_id: active.callId,
        },
        rawItems: [
          {
            type: "custom_tool_call_output",
            call_id: active.callId,
            output: [
              { type: "input_text", text: "Script completed\nOutput:\n" },
              { type: "input_text", text: "terminal result" },
            ],
          },
          {
            type: "custom_tool_call_output",
            call_id: active.callId,
            name: "exec",
            output: "started",
          },
          {
            type: "custom_tool_call_output",
            call_id: active.callId,
            name: "exec",
            output: "finished",
          },
        ],
      });
    } finally {
      await driver.stop();
    }
  });

  it("accepts only the matching function_call_output for an internal functions.wait call", async () => {
    const driver = new ResponsesLoopbackDriver();
    await driver.start();
    try {
      const active = driver.prepareToolCall(
        {
          kind: "custom",
          namespace: "functions",
          name: "exec",
          arguments: "await tools.long_running({});",
        },
        { awaitYieldedExec: true },
      );
      const failure = active.completion.catch((error: unknown) => error);
      const selected = await postResponses(driver, {
        model: "loopback",
        input: [active.executionNonce],
        tools: [],
      });
      await selected.text();
      const waitResponse = await postResponses(driver, {
        model: "loopback",
        input: [
          {
            type: "custom_tool_call_output",
            call_id: active.callId,
            output: "Script running with cell ID 2\nWall time 30.0 seconds\nOutput:\n",
          },
        ],
        tools: [],
      });
      const waitCall = completedFunctionCall(await waitResponse.text());

      const rejected = await postResponses(driver, {
        model: "loopback",
        input: [
          {
            type: "custom_tool_call_output",
            call_id: waitCall.call_id,
            output: "wrong output protocol",
          },
        ],
        tools: [],
      });
      expect(rejected.status).toBe(409);
      await expect(errorCode(rejected)).resolves.toBe("RESPONSES_TOOL_OUTPUT_MISMATCH");
      await expect(failure).resolves.toMatchObject({ code: "RESPONSES_TOOL_OUTPUT_MISMATCH" });
    } finally {
      await driver.stop();
    }
  });

  it("uses a process-specific secret and emits every selected tool form without inference", async () => {
    const driver = new ResponsesLoopbackDriver();
    const otherDriver = new ResponsesLoopbackDriver();
    expect(driver.apiKey).not.toBe(otherDriver.apiKey);
    expect(driver.apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      () =>
        new ResponsesLoopbackDriver({
          binding: { host: "0.0.0.0", listen: async () => 1 } as never,
        }),
    ).toThrow("must bind to 127.0.0.1");

    await driver.start();
    try {
      const unauthorized = await fetch(`${driver.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(unauthorized.status).toBe(401);
      await expect(errorCode(unauthorized)).resolves.toBe("LOOPBACK_UNAUTHORIZED");

      const functionStream = await selectAndRead(driver, {
        kind: "function",
        name: "shell_command",
        arguments: {},
      });
      expect(functionStream).toContain("event: response.function_call_arguments.delta");
      expect(functionStream).toContain('"delta":"{}"');
      expect(functionStream).toContain("event: response.function_call_arguments.done");
      expect(functionStream).toContain('"arguments":"{}"');

      const customStream = await selectAndRead(driver, {
        kind: "custom",
        name: "exec",
        arguments: 'text("ok")',
      });
      expect(customStream).toContain("event: response.custom_tool_call_input.delta");
      expect(customStream).toContain('"delta":"text(\\"ok\\")"');

      const freeformStream = await selectAndRead(driver, {
        kind: "freeform",
        name: "apply_patch",
        arguments: 'line 1\n{"not":"parsed"}\n한글',
      });
      expect(freeformStream).toContain("response.custom_tool_call_input.done");
      expect(freeformStream).toContain("한글");

      const searchStream = await selectAndRead(driver, {
        kind: "tool_search",
        name: "tool_search",
        arguments: { query: "calendar", limit: 20 },
      });
      expect(searchStream).toContain('"type":"tool_search_call"');
      expect(searchStream).toContain('"execution":"client"');

      const namespaceStream = await selectAndRead(driver, {
        kind: "function",
        namespace: "web",
        name: "run",
        arguments: { search_query: [{ q: "native web" }] },
      });
      expect(namespaceStream).toContain('"namespace":"web"');
      expect(namespaceStream).toContain('"name":"run"');

      const unknownStream = await selectAndRead(driver, {
        kind: "unknown",
        name: "future_native",
        arguments: null,
      });
      expect(unknownStream).toContain('"arguments":"null"');
    } finally {
      await driver.stop();
    }
  });

  it("relays only the three fixed native endpoints with minimal headers", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(fetchCall(input, init));
      return new Response(JSON.stringify({ output: "native-result" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "must-not-leak=1",
          "x-request-id": "request_123",
        },
      });
    };
    const driver = new ResponsesLoopbackDriver({ fetchImpl });
    await driver.start();
    try {
      for (const [localPath, upstreamPath] of [
        ["alpha/search", "alpha/search"],
        ["images/generations", "images/generations"],
        ["images/edits", "images/edits"],
      ] as const) {
        const response = await fetch(`${driver.baseUrl}/${localPath}`, {
          method: "POST",
          headers: nativeHeaders(driver, {
            "x-openai-actor-authorization": "must-not-win-over-bearer",
            "x-untrusted-local-header": "must-not-forward",
          }),
          body: JSON.stringify({ prompt: "safe" }),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-request-id")).toBe("request_123");
        expect(response.headers.get("set-cookie")).toBeNull();
        await expect(response.json()).resolves.toEqual({ output: "native-result" });
        const call = calls.at(-1);
        expect(call?.url).toBe(`https://chatgpt.com/backend-api/codex/${upstreamPath}`);
        expect(call?.method).toBe("POST");
        expect(call?.redirect).toBe("manual");
        expect(call?.signal).toBeInstanceOf(AbortSignal);
        expect(call?.headers.get("authorization")).toBe("Bearer real-chatgpt-token");
        expect(call?.headers.get("chatgpt-account-id")).toBe("account_123");
        expect(call?.headers.get("x-openai-actor-authorization")).toBeNull();
        expect(call?.headers.get("x-omnicodex-loopback-key")).toBeNull();
        expect(call?.headers.get("x-untrusted-local-header")).toBeNull();
        expect(call?.headers.get("user-agent")).toBeNull();
        expect(call?.body).toBe('{"prompt":"safe"}');
      }

      const noUpstreamAuth = await fetch(`${driver.baseUrl}/alpha/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-omnicodex-loopback-key": driver.apiKey,
        },
        body: "{}",
      });
      expect(noUpstreamAuth.status).toBe(401);
      await expect(errorCode(noUpstreamAuth)).resolves.toBe(
        "NATIVE_TOOL_UPSTREAM_AUTH_UNAVAILABLE",
      );

      for (const path of ["files", "chat/completions", "models/gpt-5.6-sol"]) {
        const rejected = await fetch(`${driver.baseUrl}/${path}`, {
          method: "POST",
          headers: nativeHeaders(driver),
          body: "{}",
        });
        expect(rejected.status).toBe(404);
        await expect(errorCode(rejected)).resolves.toBe("LOOPBACK_PATH_NOT_ALLOWED");
      }
      expect(calls).toHaveLength(3);
      expect(calls.every((call) => !call.url.includes("responses"))).toBe(true);
    } finally {
      await driver.stop();
    }
  });

  it("fails closed for method, request media type, size, redirect, upstream errors, and timeout", async () => {
    let mode: "redirect" | "oversize" | "upstream-error" | "timeout" = "redirect";
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(fetchCall(input, init));
      switch (mode) {
        case "redirect":
          return new Response(null, {
            status: 302,
            headers: { location: "https://evil.example/steal" },
          });
        case "oversize":
          return new Response("{}", {
            headers: { "content-length": "1000", "content-type": "application/json" },
          });
        case "upstream-error":
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        case "timeout":
          return await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) reject(signal.reason);
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
      }
    };
    const driver = new ResponsesLoopbackDriver({
      fetchImpl,
      maxNativeToolRequestBytes: 32,
      maxNativeToolResponseBytes: 128,
      searchTimeoutMs: 10,
    });
    await driver.start();
    try {
      const methodRejected = await fetch(`${driver.baseUrl}/alpha/search`, {
        method: "GET",
        headers: nativeHeaders(driver),
      });
      expect(methodRejected.status).toBe(405);
      await expect(errorCode(methodRejected)).resolves.toBe("NATIVE_TOOL_METHOD_NOT_ALLOWED");

      const queryRejected = await fetch(`${driver.baseUrl}/alpha/search?redirect=evil`, {
        method: "POST",
        headers: nativeHeaders(driver),
        body: "{}",
      });
      expect(queryRejected.status).toBe(400);
      await expect(errorCode(queryRejected)).resolves.toBe("NATIVE_TOOL_QUERY_REJECTED");

      const mediaRejected = await fetch(`${driver.baseUrl}/alpha/search`, {
        method: "POST",
        headers: nativeHeaders(driver, { "content-type": "text/plain" }),
        body: "{}",
      });
      expect(mediaRejected.status).toBe(415);
      await expect(errorCode(mediaRejected)).resolves.toBe("NATIVE_TOOL_CONTENT_TYPE_REJECTED");

      const requestTooLarge = await fetch(`${driver.baseUrl}/alpha/search`, {
        method: "POST",
        headers: nativeHeaders(driver),
        body: JSON.stringify({ payload: "x".repeat(100) }),
      });
      expect(requestTooLarge.status).toBe(413);
      await expect(errorCode(requestTooLarge)).resolves.toBe("NATIVE_TOOL_REQUEST_TOO_LARGE");
      expect(calls).toHaveLength(0);

      const redirect = await nativeSearch(driver);
      expect(redirect.status).toBe(502);
      await expect(errorCode(redirect)).resolves.toBe("NATIVE_TOOL_UPSTREAM_REDIRECT_BLOCKED");

      mode = "oversize";
      const oversize = await nativeSearch(driver);
      expect(oversize.status).toBe(502);
      await expect(errorCode(oversize)).resolves.toBe("NATIVE_TOOL_RESPONSE_TOO_LARGE");

      mode = "upstream-error";
      const upstreamError = await nativeSearch(driver);
      expect(upstreamError.status).toBe(429);
      await expect(upstreamError.json()).resolves.toEqual({
        error: { message: "rate limited" },
      });

      mode = "timeout";
      const timeout = await nativeSearch(driver);
      expect(timeout.status).toBe(504);
      await expect(errorCode(timeout)).resolves.toBe("NATIVE_TOOL_UPSTREAM_TIMEOUT");
      expect(calls).toHaveLength(4);
    } finally {
      await driver.stop();
    }
  });

  it("preserves an upstream problem+json error response without rewriting it", async () => {
    const body = JSON.stringify({
      type: "https://chatgpt.com/problems/native-tool",
      title: "Native tool input was not accepted",
      status: 422,
      detail: "정확한 upstream 진단",
      extensions: { retryable: false, rejectedFields: ["query", "scope"] },
    });
    const driver = new ResponsesLoopbackDriver({
      fetchImpl: async () =>
        new Response(body, {
          status: 422,
          statusText: "Native Tool Rejected",
          headers: {
            "content-type": "application/problem+json; charset=utf-8",
            "retry-after": "23",
            "x-request-id": "problem-json-request",
          },
        }),
    });
    await driver.start();
    try {
      const response = await nativeSearch(driver);
      expect(response.status).toBe(422);
      expect(response.statusText).toBe("Native Tool Rejected");
      expect(response.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
      expect(response.headers.get("retry-after")).toBe("23");
      expect(response.headers.get("x-request-id")).toBe("problem-json-request");
      await expect(response.text()).resolves.toBe(body);
    } finally {
      await driver.stop();
    }
  });

  it("preserves an upstream text error response without rewriting or truncating it", async () => {
    const body = `native diagnostic start\n${"세부 진단 줄\n".repeat(20_000)}native diagnostic end`;
    const driver = new ResponsesLoopbackDriver({
      fetchImpl: async () =>
        new Response(body, {
          status: 503,
          statusText: "Native Tool Temporarily Unavailable",
          headers: {
            "content-language": "ko",
            "content-type": "text/plain; charset=utf-8",
            "retry-after": "7",
            "x-request-id": "plain-text-request",
          },
        }),
    });
    await driver.start();
    try {
      const response = await nativeSearch(driver);
      expect(response.status).toBe(503);
      expect(response.statusText).toBe("Native Tool Temporarily Unavailable");
      expect(response.headers.get("content-language")).toBe("ko");
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("retry-after")).toBe("7");
      expect(response.headers.get("x-request-id")).toBe("plain-text-request");
      await expect(response.text()).resolves.toBe(body);
    } finally {
      await driver.stop();
    }
  });

  it("preserves a large native upstream error body, status, and retry metadata by default", async () => {
    const message = `native-error-start:${"문제-세부정보".repeat(20_000)}:native-error-end`;
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { code: "native_code", message, retryable: true } }), {
        status: 503,
        headers: {
          "content-type": "application/json",
          "retry-after": "17",
          "x-request-id": "native-request-large-error",
        },
      });
    const driver = new ResponsesLoopbackDriver({ fetchImpl });
    await driver.start();
    try {
      const response = await nativeSearch(driver);
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("17");
      expect(response.headers.get("x-request-id")).toBe("native-request-large-error");
      await expect(response.json()).resolves.toEqual({
        error: { code: "native_code", message, retryable: true },
      });
    } finally {
      await driver.stop();
    }
  });

  it("forwards the complete account identity and does not overflow a long explicit timeout", async () => {
    const accountId = `account_${"identity-segment-".repeat(80)}`;
    let forwardedAccountId: string | null = null;
    const fetchImpl: typeof fetch = async (_input, init) => {
      forwardedAccountId = new Headers(init?.headers).get("chatgpt-account-id");
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      return new Response('{"complete":true}', {
        headers: { "content-type": "application/json" },
      });
    };
    const driver = new ResponsesLoopbackDriver({
      fetchImpl,
      searchTimeoutMs: 2_147_483_647 + 10_000,
    });
    await driver.start();
    try {
      const response = await fetch(`${driver.baseUrl}/alpha/search`, {
        method: "POST",
        headers: nativeHeaders(driver, { "chatgpt-account-id": accountId }),
        body: '{"query":"safe"}',
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ complete: true });
      expect(forwardedAccountId).toBe(accountId);
    } finally {
      await driver.stop();
    }
  });

  it("preserves complete upstream transport error details", async () => {
    const upstreamFailure = Object.assign(
      new Error("native upstream socket failed", {
        cause: { code: "TLS_ALERT", diagnostic: "full diagnostic" },
      }),
      {
        code: "ECONNRESET",
        data: { requestId: "request-error-details", retryable: true },
      },
    );
    const driver = new ResponsesLoopbackDriver({
      modelMetadata: TEST_MODEL_METADATA,
      fetchImpl: async () => {
        throw upstreamFailure;
      },
    });
    await driver.start();
    try {
      const response = await nativeSearch(driver);
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "NATIVE_TOOL_UPSTREAM_UNAVAILABLE",
          cause: {
            name: "Error",
            message: "native upstream socket failed",
            code: "ECONNRESET",
            cause: { code: "TLS_ALERT", diagnostic: "full diagnostic" },
            data: { requestId: "request-error-details", retryable: true },
          },
        },
      });
    } finally {
      await driver.stop();
    }
  });

  it("lets an in-flight native upstream request settle when stop has no deadline", async () => {
    let forwardedSignal: AbortSignal | null | undefined;
    let signalObserved!: () => void;
    let resolveUpstream!: (response: Response) => void;
    const observed = new Promise<void>((resolve) => {
      signalObserved = resolve;
    });
    const fetchImpl: typeof fetch = async (_input, init) => {
      forwardedSignal = init?.signal;
      signalObserved();
      return await new Promise<Response>((resolve) => {
        resolveUpstream = resolve;
      });
    };
    const driver = new ResponsesLoopbackDriver({ fetchImpl });
    await driver.start();
    const pending = nativeSearch(driver);
    await observed;
    let stopSettled = false;
    const stopped = driver.stop().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();

    expect(forwardedSignal?.aborted).toBe(false);
    expect(stopSettled).toBe(false);
    resolveUpstream(
      new Response('{"settled":true}', { headers: { "content-type": "application/json" } }),
    );
    const response = await pending;
    await stopped;

    expect(forwardedSignal?.aborted).toBe(false);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ settled: true });
    expect(stopSettled).toBe(true);
  });

  it("forces an in-flight relay only when the caller supplies a stop deadline", async () => {
    let forwardedSignal: AbortSignal | null | undefined;
    let signalObserved!: () => void;
    const observed = new Promise<void>((resolve) => {
      signalObserved = resolve;
    });
    const fetchImpl: typeof fetch = async (_input, init) => {
      forwardedSignal = init?.signal;
      signalObserved();
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const driver = new ResponsesLoopbackDriver({ fetchImpl });
    await driver.start();
    const pending = nativeSearch(driver).catch((error: unknown) => error);
    await observed;

    await expect(driver.stop(10)).rejects.toThrow("stop timed out after 10ms");
    expect(forwardedSignal?.aborted).toBe(true);
    await expect(pending).resolves.toBeInstanceOf(Error);
  });

  it("ends an already-draining unresponsive relay after the app-server disconnects", async () => {
    let signalObserved!: () => void;
    let finishUpstream!: (response: Response) => void;
    const observed = new Promise<void>((resolve) => {
      signalObserved = resolve;
    });
    const driver = new ResponsesLoopbackDriver({
      fetchImpl: async () => {
        signalObserved();
        return await new Promise<Response>((resolve) => {
          finishUpstream = resolve;
        });
      },
    });
    await driver.start();
    const pending = nativeSearch(driver).catch((error: unknown) => error);
    await observed;
    const draining = driver.stop();
    await driver.stopAfterTransportFailure(new Error("Desktop connection lost"));
    await draining;
    await expect(pending).resolves.toBeInstanceOf(Error);
    expect(() => driver.baseUrl).toThrow("has not been started");
    finishUpstream(new Response("{}"));
  });

  it("isolates late work from a force-closed server generation after restart", async () => {
    let signalObserved!: () => void;
    let resolveRetiredUpstream!: (response: Response) => void;
    const observed = new Promise<void>((resolve) => {
      signalObserved = resolve;
    });
    const driver = new ResponsesLoopbackDriver({
      modelMetadata: TEST_MODEL_METADATA,
      fetchImpl: async () => {
        signalObserved();
        return await new Promise<Response>((resolve) => {
          resolveRetiredUpstream = resolve;
        });
      },
    });
    await driver.start();
    const retiredRequest = nativeSearch(driver).catch((error: unknown) => error);
    await observed;
    await expect(driver.stop(10)).rejects.toThrow("stop timed out after 10ms");
    await expect(retiredRequest).resolves.toBeInstanceOf(Error);

    await driver.start();
    resolveRetiredUpstream(
      new Response('{"late":true}', { headers: { "content-type": "application/json" } }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const models = await fetch(`${driver.baseUrl}/models`, {
      headers: { "x-omnicodex-loopback-key": driver.apiKey },
    });
    expect(models.status).toBe(200);
    await expect(models.json()).resolves.toEqual({ models: [TEST_MODEL] });
    await expect(driver.stop(100)).resolves.toBeUndefined();
  });

  it("streams an allowed upstream SSE response in order within the response cap", async () => {
    const chunks = Array.from({ length: 128 }, (_, index) => `data: ${index}\n\n`);
    const fetchImpl: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const driver = new ResponsesLoopbackDriver({
      fetchImpl,
      maxNativeToolResponseBytes: 64 * 1024,
    });
    await driver.start();
    try {
      const response = await nativeSearch(driver);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      await expect(response.text()).resolves.toBe(chunks.join(""));
    } finally {
      await driver.stop();
    }
  });

  it("round-trips a selected web__run call and media/resource output with zero model fetches", async () => {
    const upstreamCalls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      upstreamCalls.push(fetchCall(input, init));
      return new Response(JSON.stringify({ results: [{ title: "Native result" }] }), {
        headers: { "content-type": "application/json" },
      });
    };
    const driver = new ResponsesLoopbackDriver({ fetchImpl });
    await driver.start();
    try {
      const active = driver.prepareToolCall({
        kind: "function",
        namespace: "web",
        name: "run",
        arguments: { search_query: [{ q: "native search" }] },
      });
      const selected = await postResponses(driver, {
        model: "loopback",
        input: [active.executionNonce],
        tools: [],
      });
      const selectedText = await selected.text();
      expect(selectedText).toContain('"namespace":"web"');
      expect(selectedText).toContain('"name":"run"');

      const nativeResult = await nativeSearch(driver);
      await expect(nativeResult.json()).resolves.toEqual({
        results: [{ title: "Native result" }],
      });

      const output = [
        { type: "image_generation_call", result: "aW1hZ2U=" },
        {
          type: "resource",
          resource: { uri: "omnicodex://image/result", mimeType: "image/png", blob: "aW1hZ2U=" },
        },
      ];
      const completed = await postResponses(driver, {
        model: "loopback",
        input: [{ type: "function_call_output", call_id: active.callId, output }],
        tools: [],
      });
      expect(completed.status).toBe(200);
      await completed.text();
      await expect(active.completion).resolves.toMatchObject({ output });

      const modelPath = await fetch(`${driver.baseUrl}/chat/completions`, {
        method: "POST",
        headers: nativeHeaders(driver),
        body: "{}",
      });
      expect(modelPath.status).toBe(404);
      expect(upstreamCalls).toHaveLength(1);
      expect(upstreamCalls[0]?.url).toBe("https://chatgpt.com/backend-api/codex/alpha/search");
      expect(
        upstreamCalls.some((call) => /responses|chat\/completions|models/.test(call.url)),
      ).toBe(false);
    } finally {
      await driver.stop();
    }
  });
});

function listenOnLoopback(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (typeof address === "object" && address !== null) resolve(address.port);
      else reject(new Error("Test server did not receive a TCP address"));
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

async function selectAndRead(
  driver: ResponsesLoopbackDriver,
  selection: Parameters<ResponsesLoopbackDriver["prepareToolCall"]>[0],
): Promise<string> {
  const active = driver.prepareToolCall(selection);
  void active.completion.catch(() => undefined);
  const response = await postResponses(driver, {
    model: "gpt-5.6-sol",
    input: [active.executionNonce],
    tools: [],
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  driver.cancelActiveToolCall(new Error("test call completed at stream boundary"));
  return text;
}

function postResponses(
  driver: ResponsesLoopbackDriver,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${driver.baseUrl}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-omnicodex-loopback-key": driver.apiKey,
    },
    body: JSON.stringify(body),
  });
}

function completedFunctionCall(stream: string): Record<string, unknown> {
  for (const line of stream.split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const event: unknown = JSON.parse(line.slice("data: ".length));
    const eventObject = objectValue(event);
    const item = objectValue(eventObject.item);
    if (eventObject.type === "response.output_item.done" && item.type === "function_call") {
      return item;
    }
  }
  throw new Error("SSE response did not contain a completed function call");
}

function nativeSearch(driver: ResponsesLoopbackDriver): Promise<Response> {
  return fetch(`${driver.baseUrl}/alpha/search`, {
    method: "POST",
    headers: nativeHeaders(driver),
    body: '{"query":"safe"}',
  });
}

function nativeHeaders(
  driver: ResponsesLoopbackDriver,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    authorization: "Bearer real-chatgpt-token",
    "chatgpt-account-id": "account_123",
    "content-type": "application/json",
    "x-omnicodex-loopback-key": driver.apiKey,
    ...overrides,
  };
}

function fetchCall(input: string | URL | Request, init: RequestInit | undefined): FetchCall {
  return {
    url: String(input),
    headers: new Headers(init?.headers),
    body: Buffer.from(init?.body as Buffer).toString("utf8"),
    method: init?.method,
    redirect: init?.redirect,
    signal: init?.signal,
  };
}

async function errorCode(response: Response): Promise<unknown> {
  const value: unknown = await response.json();
  return objectValue(objectValue(value).error).code;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
