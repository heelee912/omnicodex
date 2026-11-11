import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  CODE_MODE_DISPATCH_NAME,
  CodeModeParallelDispatch,
  type DynamicDispatchResponse,
  withParallelDynamicTools,
} from "../src/application/code-mode-parallel-dispatch.js";

const response = (text: string, success = true): DynamicDispatchResponse => ({
  success,
  contentItems: [{ type: "inputText", text }],
});
const decode = (value: DynamicDispatchResponse) => JSON.parse(value.contentItems[0]?.text ?? "");
const params = (args: Record<string, unknown>) => ({
  threadId: "thread",
  turnId: "turn",
  callId: randomUUID(),
  arguments: args,
});

describe("Code Mode parallel dispatch", () => {
  it.each([{ names: [] }, { names: ["other"] }])(
    "normalizes escalation once in an owned never/full-access runtime with dynamic tools %j",
    async ({ names }) => {
      const args = Object.freeze({
        cmd: "echo test",
        sandbox_permissions: "require_escalated",
        justification: "redundant",
        prefix_rule: ["echo"],
        workdir: "C:/work",
        yield_time_ms: 1000,
      });
      const expected = {
        cmd: args.cmd,
        sandbox_permissions: "use_default",
        workdir: args.workdir,
        yield_time_ms: args.yield_time_ms,
      };
      const exec = vi.fn(async () => ({ exit_code: 0, output: "test" }));
      const untouched = vi.fn(async () => "untouched");
      const tools = { exec_command: exec, read_file: untouched };
      const text = vi.fn();
      const source =
        '// @exec: {"yield_time_ms": 1000}\nconst run = globalThis.tools.exec_command; text(await run(args)); await tools.read_file(args);';
      const code = withParallelDynamicTools(source, names, "g", true);
      expect(code.startsWith('// @exec: {"yield_time_ms": 1000}\n')).toBe(true);
      await runInNewContext(`(async () => {${code}})()`, { tools, ALL_TOOLS: [], args, text });
      expect(exec).toHaveBeenCalledExactlyOnceWith(expected);
      expect(untouched).toHaveBeenCalledExactlyOnceWith(args);
      expect(args.sandbox_permissions).toBe("require_escalated");
      expect(text).toHaveBeenCalledWith({ exit_code: 0, output: "test" });
    },
  );

  it("preserves default arguments and propagates real execution failures without retry", async () => {
    const error = new Error("actual filesystem permission denied");
    const args = { cmd: "write-file", sandbox_permissions: "use_default" };
    const exec = vi.fn(async () => {
      throw error;
    });
    const code = withParallelDynamicTools("await tools.exec_command(args);", [], "", true);
    await expect(
      runInNewContext(`(async () => {${code}})()`, {
        tools: { exec_command: exec },
        ALL_TOOLS: [],
        args,
      }),
    ).rejects.toBe(error);
    expect(exec).toHaveBeenCalledExactlyOnceWith(args);
  });

  it("does not normalize escalation when the owned full-access policy is not enabled", async () => {
    const args = { cmd: "test", sandbox_permissions: "require_escalated" };
    const exec = vi.fn();
    const code = withParallelDynamicTools("await tools.exec_command(args);", ["other"], "g");
    await runInNewContext(`(async () => {${code}})()`, {
      tools: { exec_command: exec },
      ALL_TOOLS: [],
      args,
    });
    expect(exec).toHaveBeenCalledExactlyOnceWith(args);
  });

  it("overlaps two real child processes while serialized callbacks return their original handles", async () => {
    const dispatch = new CodeModeParallelDispatch();
    const invoke = vi.fn(
      () =>
        new Promise<DynamicDispatchResponse>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              "-e",
              "const start=Date.now(); setTimeout(()=>console.log(JSON.stringify({start,end:Date.now()})),500)",
            ],
            { windowsHide: true },
          );
          let stdout = "";
          child.stdout.on("data", (chunk) => {
            stdout += chunk;
          });
          child.on("error", reject);
          child.on("close", (code) =>
            code === 0 ? resolve(response(stdout)) : reject(new Error(`child exit ${code}`)),
          );
        }),
    );
    const handles: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      handles.push(
        decode(
          await dispatch.call(
            params({ action: "start", tool: "original", group: "g" }),
            ["original"],
            invoke,
          ),
        ).handle,
      );
    }
    const timings = await Promise.all(
      handles.map(async (handle) => {
        let result = decode(
          await dispatch.call(params({ action: "read", handle }), ["original"], invoke),
        );
        while (result.state === "pending") {
          result = decode(
            await dispatch.call(params({ action: "read", handle }), ["original"], invoke),
          );
        }
        expect(result.state).toBe("done");
        return JSON.parse(result.response.contentItems[0].text) as { start: number; end: number };
      }),
    );
    expect(
      Math.min(...timings.map((value) => value.end)) -
        Math.max(...timings.map((value) => value.start)),
    ).toBeGreaterThan(0);
    expect(invoke).toHaveBeenCalledTimes(2);
    dispatch.finishTurn("turn");
  });

  it("reuses a start callback's handle before and after completion without repeating execution", async () => {
    const dispatch = new CodeModeParallelDispatch();
    let finish!: (value: DynamicDispatchResponse) => void;
    const invoke = vi.fn(
      () =>
        new Promise<DynamicDispatchResponse>((resolve) => {
          finish = resolve;
        }),
    );
    const request = params({
      action: "start",
      tool: "original",
      group: "g",
      arguments: { value: 1 },
    });
    const first = decode(await dispatch.call(request, ["original"], invoke));
    expect(decode(await dispatch.call(structuredClone(request), ["original"], invoke))).toEqual(
      first,
    );
    expect(invoke).toHaveBeenCalledOnce();
    finish(response("done"));
    const read = params({ action: "read", handle: first.handle });
    expect(decode(await dispatch.call(read, ["original"], invoke)).response).toEqual(
      response("done"),
    );
    expect(decode(await dispatch.call(request, ["original"], invoke))).toEqual(first);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("rejects changed input under the same callback ID without merging independent identical calls", async () => {
    const dispatch = new CodeModeParallelDispatch();
    const invoke = vi.fn(async () => response("done"));
    const request = params({
      action: "start",
      tool: "original",
      group: "g",
      arguments: { value: 1 },
    });
    const first = decode(await dispatch.call(request, ["original"], invoke));
    const independent = decode(
      await dispatch.call({ ...request, callId: randomUUID() }, ["original"], invoke),
    );
    expect(independent.handle).not.toBe(first.handle);
    request.arguments.arguments = { value: 2 };
    await expect(dispatch.call(request, ["original"], invoke)).rejects.toThrow(
      "reused with different arguments",
    );
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("scopes callback IDs to their execution turn and releases their index with that turn", async () => {
    const dispatch = new CodeModeParallelDispatch();
    const invoke = vi.fn(async () => response("done"));
    const request = params({ action: "start", tool: "original", group: "g" });
    const first = decode(await dispatch.call(request, ["original"], invoke));
    const other = decode(
      await dispatch.call({ ...request, turnId: "other" }, ["original"], invoke),
    );
    expect(other.handle).not.toBe(first.handle);
    dispatch.finishTurn("turn");
    const next = decode(await dispatch.call(request, ["original"], invoke));
    expect(next.handle).not.toBe(first.handle);
    expect(
      decode(await dispatch.call({ ...request, turnId: "other" }, ["original"], invoke)),
    ).toEqual(other);
    expect(invoke).toHaveBeenCalledTimes(3);
    dispatch.close(new Error("closed"));
  });

  it.each(["tools", "globalThis.tools"])(
    "executes both children through %s before either completes even with serialized native callbacks",
    async (toolAccess) => {
      const dispatch = new CodeModeParallelDispatch();
      const started: string[] = [];
      let release!: () => void;
      const bothStarted = new Promise<void>((resolve) => {
        release = resolve;
      });
      const invoke = vi.fn(async (p: Record<string, unknown>) => {
        started.push(String(p.arguments));
        if (started.length === 2) release();
        await bothStarted;
        return response(String(p.arguments));
      });
      let tail: Promise<unknown> = Promise.resolve();
      const tools = {
        original: () => {
          throw new Error("must not use blocking callback");
        },
        [CODE_MODE_DISPATCH_NAME]: (args: Record<string, unknown>) => {
          const next = tail.then(() => dispatch.call(params(args), ["original"], invoke));
          tail = next;
          return next.then((value) => value.contentItems[0]?.text);
        },
      };
      const outputs: unknown[] = [];
      const code = withParallelDynamicTools(
        `text(await Promise.all([${toolAccess}.original("A"), ${toolAccess}.original("B")])); text(ALL_TOOLS); text(globalThis.ALL_TOOLS); text(globalThis.tools === tools);`,
        ["original"],
        "group",
      );
      await runInNewContext(`(async () => {${code}})()`, {
        tools,
        ALL_TOOLS: [{ name: "original" }, { name: CODE_MODE_DISPATCH_NAME }],
        text: (value: unknown) => outputs.push(value),
      });
      expect(started).toEqual(["A", "B"]);
      expect(outputs).toEqual([["A", "B"], [{ name: "original" }], [{ name: "original" }], true]);
      expect(invoke).toHaveBeenCalledTimes(2);
    },
  );

  it("preserves failed native response as text and media URLs in original order", async () => {
    const dispatch = new CodeModeParallelDispatch();
    const outputs: unknown[] = [];
    const tools = {
      [CODE_MODE_DISPATCH_NAME]: async (args: Record<string, unknown>) =>
        (
          await dispatch.call(params(args), ["original"], async () => ({
            success: false,
            contentItems: [
              { type: "inputText", text: ' {"error":"native"} ' },
              { type: "inputText", text: "  " },
              { type: "inputImage", imageUrl: "data:image/png;base64,AA==" },
              { type: "inputAudio", audioUrl: "data:audio/wav;base64,BB==" },
            ],
          }))
        ).contentItems[0]?.text,
    };
    await runInNewContext(
      `(async () => {${withParallelDynamicTools("text(await tools.original({}));", ["original"], "g")}})()`,
      {
        tools,
        ALL_TOOLS: [],
        text: (value: unknown) => outputs.push(value),
      },
    );
    expect(outputs).toEqual([
      ' {"error":"native"} \ndata:image/png;base64,AA==\ndata:audio/wav;base64,BB==',
    ]);
  });

  it("retains the same result after repeated reads and does not retry mutations", async () => {
    const dispatch = new CodeModeParallelDispatch();
    const invoke = vi.fn(async () => response("complete"));
    const start = decode(
      await dispatch.call(
        params({ action: "start", tool: "original", group: "g", arguments: {} }),
        ["original"],
        invoke,
      ),
    );
    const read = params({ action: "read", handle: start.handle });
    expect(decode(await dispatch.call(read, ["original"], invoke))).toEqual({
      state: "done",
      response: response("complete"),
    });
    expect(decode(await dispatch.call(read, ["original"], invoke))).toEqual({
      state: "done",
      response: response("complete"),
    });
    expect(invoke).toHaveBeenCalledOnce();
    await expect(
      dispatch.call({ ...read, turnId: "different" }, ["original"], invoke),
    ).rejects.toThrow("unavailable");
  });

  it("cancels only the selected cell group and preserves late completion", async () => {
    const dispatch = new CodeModeParallelDispatch();
    const signals: AbortSignal[] = [];
    const resolve: ((value: DynamicDispatchResponse) => void)[] = [];
    const invoke = (_p: Record<string, unknown>, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<DynamicDispatchResponse>((done) => resolve.push(done));
    };
    const a = decode(
      await dispatch.call(
        params({ action: "start", tool: "original", group: "a" }),
        ["original"],
        invoke,
      ),
    );
    await dispatch.call(
      params({ action: "start", tool: "original", group: "b" }),
      ["original"],
      invoke,
    );
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    dispatch.cancelGroup("a", new Error("terminated"));
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    resolve[0]?.(response("already completed before cancellation"));
    expect(
      decode(
        await dispatch.call(params({ action: "read", handle: a.handle }), ["original"], invoke),
      ).response,
    ).toEqual(response("already completed before cancellation"));
    dispatch.finishTurn("turn");
    expect(signals[1]?.aborted).toBe(true);
    resolve[1]?.(response("late"));
  });

  it("propagates parent cancellation and does not impose an operation timeout", async () => {
    const dispatch = new CodeModeParallelDispatch();
    const controller = new AbortController();
    let captured: AbortSignal | undefined;
    let finish!: (value: DynamicDispatchResponse) => void;
    const invoke = (_p: Record<string, unknown>, signal: AbortSignal) => {
      captured = signal;
      return new Promise<DynamicDispatchResponse>((resolve) => {
        finish = resolve;
      });
    };
    const start = decode(
      await dispatch.call(
        params({ action: "start", tool: "original", group: "g" }),
        ["original"],
        invoke,
        controller.signal,
      ),
    );
    expect(
      decode(
        await dispatch.call(params({ action: "read", handle: start.handle }), ["original"], invoke),
      ).state,
    ).toBe("pending");
    expect(captured?.aborted).toBe(false);
    controller.abort(new Error("parent deadline"));
    expect(captured?.reason.message).toBe("parent deadline");
    finish(response("late result"));
  });

  it("keeps the exec pragma and leaves unrelated native tools untouched", () => {
    const source = '// @exec: {"yield_time_ms": 1000}\ntext(1)';
    expect(
      withParallelDynamicTools(source, ["original"], "g").startsWith(
        '// @exec: {"yield_time_ms": 1000}\n',
      ),
    ).toBe(true);
    expect(withParallelDynamicTools(source, [], "g")).toBe(source);
  });
});
