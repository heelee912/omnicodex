import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ComputerUseNativeExecutor,
  ComputerUseNativeResponseError,
} from "../src/application/computer-use-native-executor.js";
import type { NativeToolExecutor } from "../src/application/native-tool-catalog.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ComputerUseNativeExecutor", () => {
  it("executes a first-party sky method through node_repl without a model selection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnicodex-sky-"));
    temporaryDirectories.push(directory);
    const entry = join(directory, "index.js");
    await writeFile(entry, "export const sky = {};\n", "utf8");
    const calls: Array<{
      server: string;
      tool: string;
      args: unknown;
      contextThreadId: string | undefined;
      onProgress: unknown;
      contextTurnId: string | undefined;
      signal: AbortSignal | undefined;
    }> = [];
    const nativeTools = {
      callInContext: async (
        server: string,
        tool: string,
        args: unknown,
        contextThreadId?: string,
        onProgress?: unknown,
        contextTurnId?: string,
        signal?: AbortSignal,
      ) => {
        calls.push({ server, tool, args, contextThreadId, onProgress, contextTurnId, signal });
        const code = objectValue(args).code;
        if (typeof code !== "string") throw new Error("missing generated code");
        const encodedMarker = code.match(/console\.log\(("OMNICODEX_SKY_[^"]+:") \+/)?.[1];
        if (encodedMarker === undefined) throw new Error("missing correlation marker");
        const marker = JSON.parse(encodedMarker) as string;
        return {
          content: [
            {
              type: "text",
              text: `${marker}{"ok":true,"value":[{"id":"app-1"}]}`,
            },
          ],
        };
      },
    } as unknown as NativeToolExecutor;
    const executor = new ComputerUseNativeExecutor(nativeTools, { skyEntryPath: entry });
    const controller = new AbortController();

    await expect(
      executor.call("list_apps", {}, "desktop-context", "desktop-turn", controller.signal),
    ).resolves.toEqual([{ id: "app-1" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.server).toBe("node_repl");
    expect(calls[0]?.tool).toBe("js");
    expect(calls[0]?.contextThreadId).toBe("desktop-context");
    expect(calls[0]?.onProgress).toBeUndefined();
    expect(calls[0]?.contextTurnId).toBe("desktop-turn");
    expect(calls[0]?.signal).toBe(controller.signal);
    expect(objectValue(calls[0]?.args)).not.toHaveProperty("timeout_ms");
    const code = objectValue(calls[0]?.args).code;
    expect(code).toContain(
      `const { sky: __omniImportedSky } = await import(${JSON.stringify(pathToFileURL(entry).href)});`,
    );
    expect(code).toContain("globalThis.__omnicodexSky = __omniImportedSky");
    expect(code).not.toContain('import("@oai/sky")');
    expect(code).not.toContain("create_client");
    expect(code).not.toContain("createClient");
    expect(code).not.toContain("sessions: new Map()");
    expect(code).not.toContain("__omniSession");
    expect(code).toContain('__omniSky["list_apps"]()');
  });

  it("passes structured action arguments without executing arbitrary method names", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnicodex-sky-"));
    temporaryDirectories.push(directory);
    const entry = join(directory, "index.js");
    await writeFile(entry, "export const sky = {};\n", "utf8");
    let generatedCode = "";
    const nativeTools = {
      callInContext: async (_server: string, _tool: string, args: unknown) => {
        generatedCode = String(objectValue(args).code);
        const encodedMarker = generatedCode.match(/console\.log\(("OMNICODEX_SKY_[^"]+:") \+/)?.[1];
        if (encodedMarker === undefined) throw new Error("missing correlation marker");
        const method = generatedMethod(generatedCode);
        const envelope =
          method === "get_window_state"
            ? stateEnvelope({ app: "notepad", id: 42, title: "Document" }, "frame-1")
            : actionEnvelope();
        return { text: `${JSON.parse(encodedMarker) as string}${JSON.stringify(envelope)}` };
      },
    } as unknown as NativeToolExecutor;
    const executor = new ComputerUseNativeExecutor(nativeTools, { skyEntryPath: entry });
    const window = { app: "notepad", id: 42, title: "Document" };

    await executor.call("get_window_state", { window }, "caller-1", "turn-1");
    await expect(
      executor.call(
        "click",
        { window, screenshotId: "frame-1", x: 12, y: 34 },
        "caller-1",
        "turn-2",
      ),
    ).resolves.toBeNull();
    expect(generatedCode).toContain(
      'const __omniInput = {"window":{"app":"notepad","id":42,"title":"Document"},"screenshotId":"frame-1","x":12,"y":34};',
    );
    expect(generatedCode).toContain('__omniSky["click"](__omniInput)');
    expect(generatedCode).not.toContain("__omniSky.get_window_state");
    expect(generatedCode).not.toContain("await __omniSky.get_window(");
    await expect(executor.call("click", { window, x: 12, y: 34 })).rejects.toThrow("caller");
    await expect(executor.call("constructor" as never, {})).rejects.toThrow(
      "Unknown Computer Use method",
    );
  });

  it("uses the bundled package name and returns the native input result without extra readback", async () => {
    const generatedCodes: string[] = [];
    const nativeTools = {
      callInContext: async (_server: string, _tool: string, args: unknown) => {
        const generatedCode = String(objectValue(args).code);
        generatedCodes.push(generatedCode);
        const encodedMarker = generatedCode.match(/console\.log\(("OMNICODEX_SKY_[^"]+:") \+/)?.[1];
        if (encodedMarker === undefined) throw new Error("missing correlation marker");
        const method = generatedMethod(generatedCode);
        const window = { app: "notepad", id: 42 };
        const envelope =
          method === "get_window_state"
            ? stateEnvelope(window, "screenshot-1", true)
            : actionEnvelope();
        return {
          text: `${JSON.parse(encodedMarker) as string}${JSON.stringify(envelope)}`,
        };
      },
    } as unknown as NativeToolExecutor;
    const executor = new ComputerUseNativeExecutor(nativeTools);
    const window = { app: "notepad", id: 42 };

    await executor.call(
      "get_window_state",
      { window, include_text: true },
      "desktop-thread",
      "observe-turn",
      undefined,
      "observe-operation",
    );

    await expect(
      executor.call(
        "type_text",
        { window, text: "hello" },
        "desktop-thread",
        "action-turn",
        undefined,
        "action-operation",
      ),
    ).resolves.toBeNull();
    expect(generatedCodes).toHaveLength(2);
    expect(generatedCodes[0]).toContain('await import("@oai/sky")');
    expect(generatedCodes[1]).not.toContain("globalThis.__omnicodexSkyGeneration !==");
    expect(generatedCodes[1]).toContain("globalThis.__omnicodexSky");
  });

  it.each([
    ["click", { x: 10, y: 20 }],
    ["scroll", { x: 10, y: 20, scrollX: 0, scrollY: 100 }],
    ["drag", { from_x: 10, from_y: 20, to_x: 30, to_y: 40 }],
  ] as const)(
    "uses the caller's latest screenshot when %s omits its optional ID",
    async (method, target) => {
      const window = { app: "notepad", id: 7 };
      const calls: string[] = [];
      let inputCode = "";
      const executor = testExecutor((called, code) => {
        calls.push(called);
        if (called === "get_window_state") return stateEnvelope(window, "owned-frame");
        inputCode = code;
        return actionEnvelope();
      });
      await executor.call("get_window_state", { window }, "owner");
      const args = { window, ...target };
      await expect(executor.call(method, args, "other-owner")).rejects.toThrow("another caller");
      expect(calls).toEqual(["get_window_state"]);
      await expect(executor.call(method, args, "owner")).resolves.toBeNull();
      expect(inputCode).toContain(`const __omniInput = ${JSON.stringify(args)};`);
      expect(inputCode).toContain("stale helper generation");
      expect(calls).toEqual(["get_window_state", method]);
    },
  );

  it("rejects a screenshot observation issued to another caller before native input", async () => {
    const calls: string[] = [];
    const window = { app: "Godot", id: 7, title: "Room" };
    const executor = testExecutor((method) => {
      calls.push(method);
      return stateEnvelope(window, "caller-a-frame");
    });

    await executor.call("get_window_state", { window }, "caller-a", "turn-a");
    await expect(
      executor.call(
        "click",
        { window, screenshotId: "caller-a-frame", x: 10, y: 20 },
        "caller-b",
        "turn-b",
      ),
    ).rejects.toThrow("issued to another caller");
    expect(calls).toEqual(["get_window_state"]);
  });

  it("binds sequential MCP operations to one stable opaque caller session", async () => {
    const window = { app: "Godot", id: 17 };
    const executor = testExecutor((method) =>
      method === "get_window_state" ? stateEnvelope(window, "session-frame") : actionEnvelope(),
    );

    await executor.call(
      "get_window_state",
      { window },
      undefined,
      undefined,
      undefined,
      "read-operation",
      "opaque-session-a",
    );
    await expect(
      executor.call(
        "click",
        { window, screenshotId: "session-frame", x: 10, y: 20 },
        undefined,
        undefined,
        undefined,
        "different-action-operation",
        "opaque-session-a",
      ),
    ).resolves.toBeNull();
  });

  it.each([
    ["click", { screenshotId: "screenshot-0", x: 10, y: 20 }],
    ["set_value", { element_index: 0, value: "replacement" }],
  ] as const)(
    "preserves the native observation session and implicit turn for %s",
    async (method, input) => {
      const window = { app: "notepad", id: 42 };
      const calls: Array<{ method: string; context: NativeTestCallContext }> = [];
      const executor = testExecutor((called, _code, context) => {
        calls.push({ method: called, context });
        return called === "get_window_state"
          ? stateEnvelope(window, "screenshot-0", true)
          : actionEnvelope();
      });
      for (const session of ["caller-a", "caller-b"]) {
        await executor.call(
          "get_window_state",
          { window },
          undefined,
          undefined,
          undefined,
          undefined,
          session,
        );
        await expect(
          executor.call(
            method,
            { window, ...input },
            undefined,
            undefined,
            undefined,
            undefined,
            `${session}-other`,
          ),
        ).rejects.toThrow("another caller");
        await expect(
          executor.call(
            method,
            { window, ...input },
            undefined,
            undefined,
            undefined,
            undefined,
            session,
          ),
        ).resolves.toBeNull();
      }
      expect(calls).toHaveLength(4);
      for (const index of [0, 2]) {
        const observed = calls[index]?.context;
        expect(observed?.contextTurnId).toEqual(expect.any(String));
        expect(calls[index + 1]?.context).toEqual(observed);
      }
      expect(calls[0]?.context.contextSessionId).toBe("caller-a");
      expect(calls[2]?.context.contextSessionId).toBe("caller-b");
      expect(calls[0]?.context.contextTurnId).not.toBe(calls[2]?.context.contextTurnId);
    },
  );

  it("preserves explicit native turn changes instead of replacing them with the observation turn", async () => {
    const window = { app: "notepad", id: 42 };
    const contexts: NativeTestCallContext[] = [];
    const executor = testExecutor((method, _code, context) => {
      contexts.push(context);
      return method === "get_window_state"
        ? stateEnvelope(window, "explicit-frame")
        : actionEnvelope();
    });
    await executor.call(
      "get_window_state",
      { window },
      "thread",
      "observe-turn",
      undefined,
      undefined,
      "session",
    );
    await executor.call(
      "click",
      { window, screenshotId: "explicit-frame", x: 10, y: 20 },
      "thread",
      "input-turn",
      undefined,
      undefined,
      "session",
    );
    expect(contexts).toEqual([
      { contextThreadId: "thread", contextTurnId: "observe-turn", contextSessionId: "session" },
      { contextThreadId: "thread", contextTurnId: "input-turn", contextSessionId: "session" },
    ]);
  });

  it("keeps read-only observations isolated until a physical input invalidates the window", async () => {
    const window = { app: "Godot", id: 27, title: "Shared editor" };
    let readCount = 0;
    const executor = testExecutor((method) => {
      if (method === "get_window_state") {
        readCount += 1;
        return stateEnvelope(window, `caller-${readCount}-frame`);
      }
      return actionEnvelope();
    });

    await executor.call(
      "get_window_state",
      { window },
      undefined,
      undefined,
      undefined,
      "observe-a",
      "session-a",
    );
    await executor.call(
      "get_window_state",
      { window },
      undefined,
      undefined,
      undefined,
      "observe-b",
      "session-b",
    );

    await expect(
      executor.call(
        "click",
        { window, screenshotId: "caller-1-frame", x: 10, y: 20 },
        undefined,
        undefined,
        undefined,
        "act-a",
        "session-a",
      ),
    ).resolves.toBeNull();

    await expect(
      executor.call(
        "click",
        { window, screenshotId: "caller-2-frame", x: 30, y: 40 },
        undefined,
        undefined,
        undefined,
        "act-b",
        "session-b",
      ),
    ).rejects.toThrow("stale or unknown");
  });

  it("rejects expired and unknown screenshot frames", async () => {
    let now = 1_000;
    const window = { app: "Godot", id: 8 };
    const executor = testExecutor(
      (method) =>
        method === "get_window_state" ? stateEnvelope(window, "expiring-frame") : actionEnvelope(),
      { now: () => now, observationFrameTtlMs: 50 },
    );

    await executor.call("get_window_state", { window }, "caller", "turn-1");
    now += 51;
    await expect(
      executor.call(
        "click",
        { window, screenshotId: "expiring-frame", x: 1, y: 2 },
        "caller",
        "turn-2",
      ),
    ).rejects.toThrow("expired");

    await executor.call("get_window_state", { window }, "caller", "turn-3");
    await expect(
      executor.call(
        "click",
        { window, screenshotId: "never-issued", x: 1, y: 2 },
        "caller",
        "turn-4",
      ),
    ).rejects.toThrow("stale or unknown");
  });

  it("evicts the oldest immutable frame when bounded storage is full", async () => {
    const windows = [
      { app: "app", id: 1 },
      { app: "app", id: 2 },
      { app: "app", id: 3 },
    ];
    const executor = testExecutor(
      (method, code) => {
        const args = generatedInput(code);
        const window = objectValue(args.window);
        return method === "get_window_state"
          ? stateEnvelope(window, `frame-${String(window.id)}`)
          : actionEnvelope();
      },
      { maxObservationFrames: 2 },
    );

    for (const window of windows) {
      await executor.call("get_window_state", { window }, "caller", `turn-${window.id}`);
    }

    await expect(
      executor.call("click", { window: windows[0], screenshotId: "frame-1", x: 1, y: 1 }, "caller"),
    ).rejects.toThrow("stale or unknown");
    await expect(
      executor.call("click", { window: windows[2], screenshotId: "frame-3", x: 1, y: 1 }, "caller"),
    ).resolves.toBeNull();
  });

  it("retains more than 256 observations beyond five minutes by default", async () => {
    let now = 1_000;
    const executor = testExecutor(
      (method, code) => {
        const args = generatedInput(code);
        const window = objectValue(args.window);
        return method === "get_window_state"
          ? stateEnvelope(window, `frame-${String(window.id)}`)
          : actionEnvelope();
      },
      { now: () => now },
    );
    const windows = Array.from({ length: 257 }, (_, index) => ({
      app: "many-windows",
      id: index + 1,
    }));

    for (const window of windows) {
      await executor.call("get_window_state", { window }, "caller", `turn-${window.id}`);
    }
    now += 365 * 24 * 60 * 60_000;

    await expect(
      executor.call("click", { window: windows[0], screenshotId: "frame-1", x: 1, y: 1 }, "caller"),
    ).resolves.toBeNull();
  });

  it("consumes an input frame and uses a separate fresh observation for the next input", async () => {
    const window = { app: "canvas", id: 99 };
    let actionCount = 0;
    const executor = testExecutor((method) => {
      if (method === "get_window_state") return stateEnvelope(window, `frame-${actionCount + 1}`);
      actionCount += 1;
      return actionEnvelope();
    });

    await executor.call("get_window_state", { window }, "caller", "observe");
    await expect(
      executor.call(
        "click",
        { window, screenshotId: "frame-1", x: 10, y: 10 },
        "caller",
        "click-turn",
      ),
    ).resolves.toBeNull();

    await expect(
      executor.call(
        "scroll",
        { window, screenshotId: "frame-1", x: 10, y: 10, scrollX: 0, scrollY: 100 },
        "caller",
      ),
    ).rejects.toThrow("stale or unknown");
    await expect(executor.call("get_window_state", { window }, "caller")).resolves.toMatchObject({
      screenshots: [{ id: "frame-2" }],
    });
    await expect(
      executor.call(
        "scroll",
        { window, screenshotId: "frame-2", x: 10, y: 10, scrollX: 0, scrollY: 100 },
        "caller",
        "scroll-turn",
      ),
    ).resolves.toBeNull();
  });

  it("rejects per-call operation ids as caller identity and accepts a stable calling turn", async () => {
    const window = { app: "notepad", id: 4 };
    const executor = testExecutor((method) =>
      method === "get_window_state" ? stateEnvelope(window, "frame") : actionEnvelope(),
    );

    await expect(executor.call("get_window_state", { window })).rejects.toThrow(
      "stable caller session, calling thread, or calling turn identity",
    );

    await expect(
      executor.call(
        "get_window_state",
        { window },
        undefined,
        "stable-turn",
        undefined,
        "read-operation",
      ),
    ).resolves.toMatchObject({ screenshots: [{ id: "frame" }] });

    await expect(
      executor.call(
        "click",
        { window, screenshotId: "frame", x: 10, y: 20 },
        undefined,
        "stable-turn",
        undefined,
        "different-action-operation",
      ),
    ).resolves.toBeNull();

    await expect(
      executor.call(
        "get_window_state",
        { window },
        undefined,
        undefined,
        undefined,
        "operation-only-is-not-stable",
      ),
    ).rejects.toThrow("stable caller session, calling thread, or calling turn identity");
  });

  it("keeps a successful native input successful when a subsequent explicit observation fails", async () => {
    const calls: string[] = [];
    const observationError = Object.assign(new Error("Window capture is temporarily unavailable"), {
      name: "NativeCaptureError",
      code: "CAPTURE_UNAVAILABLE",
      cause: new Error("Capture helper disconnected"),
    });
    const nativeGlobal = {
      __omnicodexSky: {
        activate_window() {
          calls.push("activate_window");
        },
        get_window_state() {
          calls.push("get_window_state");
          throw observationError;
        },
      },
    };
    const nativeTools = {
      callInContext: async (_server: string, _tool: string, args: unknown) => {
        const output: string[] = [];
        const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
          ...args: string[]
        ) => (...values: unknown[]) => Promise<void>;
        await new AsyncFunction("console", "globalThis", String(objectValue(args).code))(
          { log: (value: unknown) => output.push(String(value)) },
          nativeGlobal,
        );
        return { text: output.join("\n") };
      },
    } as unknown as NativeToolExecutor;
    const executor = new ComputerUseNativeExecutor(nativeTools);
    const window = { app: "notepad", id: 42 };

    await expect(executor.call("activate_window", { window }, "caller")).resolves.toBeNull();
    expect(calls).toEqual(["activate_window"]);
    await expect(executor.call("get_window_state", { window }, "caller")).rejects.toMatchObject({
      name: "NativeCaptureError",
      message: observationError.message,
      code: "CAPTURE_UNAVAILABLE",
      cause: { message: "Capture helper disconnected" },
    });
    expect(calls).toEqual(["activate_window", "get_window_state"]);
  });

  it("passes a current screenshot input through after the native window title changes", async () => {
    const window = { app: "notepad", id: 42, title: "Original document" };
    const renamedWindow = { ...window, title: "Renamed document" };
    const calls: Array<{ method: string; input?: unknown }> = [];
    const executor = runtimeExecutor({
      get_window_state(input: unknown) {
        calls.push({ method: "get_window_state", input });
        return windowState(window, "title-change-frame", false);
      },
      get_window() {
        calls.push({ method: "get_window" });
        throw new Error("A separate title lookup is not required for native input");
      },
      click(input: unknown) {
        calls.push({ method: "click", input });
      },
    });
    await executor.call("get_window_state", { window }, "caller");
    const input = { window: renamedWindow, screenshotId: "title-change-frame", x: 12, y: 34 };
    await expect(executor.call("click", input, "caller")).resolves.toBeNull();
    expect(calls).toEqual([
      { method: "get_window_state", input: { window } },
      { method: "click", input },
    ]);
    await expect(executor.call("click", input, "caller")).rejects.toThrow("stale or unknown");
  });

  it("sends consecutive key and text inputs without an adapter-only observation prerequisite", async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    const executor = runtimeExecutor({
      press_key(input: unknown) {
        calls.push({ method: "press_key", input });
      },
      type_text(input: unknown) {
        calls.push({ method: "type_text", input });
      },
    });
    const window = { app: "notepad", id: 42 };
    const select = { window, key: "Control_L+a" };
    const text = { window, text: "한국어 日本語 😀" };
    const submit = { window, key: "Return" };
    await expect(executor.call("press_key", select, "caller")).resolves.toBeNull();
    await expect(executor.call("type_text", text, "caller")).resolves.toBeNull();
    await expect(executor.call("press_key", submit, "caller")).resolves.toBeNull();
    expect(calls).toEqual([
      { method: "press_key", input: select },
      { method: "type_text", input: text },
      { method: "press_key", input: submit },
    ]);
  });

  it("still requires a current accessibility observation for an indexed action", async () => {
    const calls: string[] = [];
    const window = { app: "notepad", id: 42 };
    const executor = testExecutor((method) => {
      calls.push(method);
      return method === "get_window_state"
        ? stateEnvelope(window, "indexed-frame", true)
        : actionEnvelope();
    });
    const input = { window, element_index: 0, value: "replacement" };
    await expect(executor.call("set_value", input, "caller")).rejects.toThrow(
      "no current observation",
    );
    expect(calls).toEqual([]);
    await executor.call("get_window_state", { window, include_text: true }, "caller");
    await expect(executor.call("set_value", input, "caller")).resolves.toBeNull();
    await expect(executor.call("set_value", input, "caller")).rejects.toThrow(
      "no current observation",
    );
    expect(calls).toEqual(["get_window_state", "set_value"]);
  });

  it("does not truncate the first-party Computer Use error identity or message", async () => {
    const tail = "END_OF_NATIVE_COMPUTER_USE_ERROR";
    const message = `${"x".repeat(12_000)}${tail}`;
    const nativeTools = {
      callInContext: async (_server: string, _tool: string, args: unknown) => {
        const code = String(objectValue(args).code);
        expect(code).not.toContain(".slice(0, 2000)");
        expect(code).not.toContain(".slice(0, 100)");
        const encodedMarker = code.match(/console\.log\(("OMNICODEX_SKY_[^"]+:") \+/)?.[1];
        if (encodedMarker === undefined) throw new Error("missing correlation marker");
        return {
          text: `${JSON.parse(encodedMarker) as string}${JSON.stringify({
            ok: false,
            error: {
              name: "NativeComputerUseError",
              code: 57,
              message,
              stack: "NativeComputerUseError: original stack\n    at native-input:1:2",
              data: { retryable: true, stdout: "complete stdout", stderr: "complete stderr" },
              cause: { name: "NativeCause", message: "complete cause", code: "CAUSE_CODE" },
            },
          })}`,
        };
      },
    } as unknown as NativeToolExecutor;
    const executor = new ComputerUseNativeExecutor(nativeTools);

    const failure = await executor.call("list_apps", {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toBeInstanceOf(ComputerUseNativeResponseError);
    expect((failure as Error).name).toBe("NativeComputerUseError");
    expect((failure as Error).message).toContain(tail);
    expect((failure as Error).message.length).toBeGreaterThan(12_000);
    expect(failure).toMatchObject({
      code: 57,
      stack: "NativeComputerUseError: original stack\n    at native-input:1:2",
      data: { retryable: true, stdout: "complete stdout", stderr: "complete stderr" },
      cause: { name: "NativeCause", message: "complete cause", code: "CAUSE_CODE" },
    });
  });

  it("reports a non-Error runtime rejection without replacing it with an unknown error", async () => {
    const nativeTools = {
      callInContext: async (_server: string, _tool: string, args: unknown) => {
        const code = String(objectValue(args).code);
        const encodedMarker = code.match(/console\.log\(("OMNICODEX_SKY_[^"]+:") \+/)?.[1];
        if (encodedMarker === undefined) throw new Error("missing correlation marker");
        return {
          text: `${JSON.parse(encodedMarker) as string}${JSON.stringify({ ok: false, error: null })}`,
        };
      },
    } as unknown as NativeToolExecutor;
    const executor = new ComputerUseNativeExecutor(nativeTools);

    const failure = await executor.call("list_apps", {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ComputerUseNativeResponseError);
    expect(failure).toHaveProperty("message", "Computer Use runtime rejected with null");
  });

  it.each(["transport", "truncated", "missing-marker", "invalid-envelope", "missing-error"])(
    "does not classify a %s failure as an explicit native response error",
    async (failureKind) => {
      const transportError = new Error("Native transport closed before returning a response");
      const nativeTools = {
        callInContext: async (_server: string, _tool: string, args: unknown) => {
          if (failureKind === "transport") throw transportError;
          const code = String(objectValue(args).code);
          const encodedMarker = code.match(/console\.log\(("OMNICODEX_SKY_[^"]+:") \+/)?.[1];
          if (encodedMarker === undefined) throw new Error("missing correlation marker");
          const marker = JSON.parse(encodedMarker) as string;
          const output = {
            truncated: `${marker}{"ok":false,"error":`,
            "missing-marker": 'uncorrelated {"ok":false,"error":{"message":"failure"}}',
            "invalid-envelope": `${marker}{"error":{"message":"failure"}}`,
            "missing-error": `${marker}{"ok":false}`,
          }[failureKind];
          return { text: output };
        },
      } as unknown as NativeToolExecutor;
      const executor = new ComputerUseNativeExecutor(nativeTools);
      const failure = await executor.call("list_apps", {}).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(ComputerUseNativeResponseError);
      if (failureKind === "transport") expect(failure).toBe(transportError);
    },
  );

  it("preserves inherited DOMException diagnostics across the node_repl realm", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnicodex-sky-domexception-"));
    temporaryDirectories.push(directory);
    const entry = join(directory, "index.js");
    await writeFile(entry, "export const sky = {};\n", "utf8");
    const nativeTools = {
      callInContext: async (_server: string, _tool: string, args: unknown) => {
        const code = String(objectValue(args).code);
        const runnable = code.replace(
          / {4}const \{ sky: __omniImportedSky \} = await import\([^\n]+\);/,
          [
            "    const __omniInheritedError = Object.create({",
            "      name: 'NotAllowedError',",
            "      message: 'Chrome window capture was denied',",
            "      constructor: { name: 'DOMException' },",
            "      [Symbol.toStringTag]: 'DOMException',",
            "    });",
            "    const __omniImportedSky = { list_apps() { throw __omniInheritedError; } };",
          ].join("\n"),
        );
        const output: string[] = [];
        const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
          ...args: string[]
        ) => (...values: unknown[]) => Promise<void>;
        await new AsyncFunction("console", runnable)({
          log(value: unknown) {
            output.push(String(value));
          },
        });
        return { text: output.join("\n") };
      },
    } as unknown as NativeToolExecutor;
    const executor = new ComputerUseNativeExecutor(nativeTools, { skyEntryPath: entry });

    const failure = await executor.call("list_apps", {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Chrome window capture was denied");
    expect((failure as Error).name).toBe("NotAllowedError");
    expect(failure).toBeInstanceOf(ComputerUseNativeResponseError);
    expect(failure).toMatchObject({
      constructorName: "DOMException",
      objectTag: "[object DOMException]",
    });
  });
});

function runtimeExecutor(sky: Record<string, unknown>): ComputerUseNativeExecutor {
  const nativeGlobal = { __omnicodexSky: sky };
  const nativeTools = {
    callInContext: async (_server: string, _tool: string, args: unknown) => {
      const output: string[] = [];
      const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
        ...args: string[]
      ) => (...values: unknown[]) => Promise<void>;
      await new AsyncFunction("console", "globalThis", String(objectValue(args).code))(
        { log: (value: unknown) => output.push(String(value)) },
        nativeGlobal,
      );
      return { text: output.join("\n") };
    },
  } as unknown as NativeToolExecutor;
  return new ComputerUseNativeExecutor(nativeTools);
}

interface NativeTestCallContext {
  readonly contextThreadId: string | undefined;
  readonly contextTurnId: string | undefined;
  readonly contextSessionId: string | undefined;
}

function testExecutor(
  resultFor: (
    method: string,
    code: string,
    context: NativeTestCallContext,
  ) => Record<string, unknown>,
  options: ConstructorParameters<typeof ComputerUseNativeExecutor>[1] = {},
): ComputerUseNativeExecutor {
  const nativeTools = {
    callInContext: async (
      _server: string,
      _tool: string,
      args: unknown,
      contextThreadId?: string,
      _onProgress?: unknown,
      contextTurnId?: string,
      _signal?: AbortSignal,
      contextSessionId?: string,
    ) => {
      const code = String(objectValue(args).code);
      const encodedMarker = code.match(/console\.log\(("OMNICODEX_SKY_[^"]+:") \+/)?.[1];
      if (encodedMarker === undefined) throw new Error("missing correlation marker");
      return {
        text: `${JSON.parse(encodedMarker) as string}${JSON.stringify(resultFor(generatedMethod(code), code, { contextThreadId, contextTurnId, contextSessionId }))}`,
      };
    },
  } as unknown as NativeToolExecutor;
  return new ComputerUseNativeExecutor(nativeTools, options);
}

function stateEnvelope(
  window: Record<string, unknown>,
  screenshotId: string,
  accessibility = false,
): Record<string, unknown> {
  return {
    ok: true,
    value: windowState(window, screenshotId, accessibility),
    helperGeneration: "helper-generation-1",
  };
}

function actionEnvelope(): Record<string, unknown> {
  return {
    ok: true,
    value: null,
    helperGeneration: "helper-generation-1",
  };
}

function windowState(
  window: Record<string, unknown>,
  screenshotId: string,
  accessibility: boolean,
): Record<string, unknown> {
  return {
    window,
    accessibility: accessibility ? { tree: "[0] edit", focused_element: "[0] edit" } : null,
    screenshots: [
      {
        id: screenshotId,
        url: "data:image/png;base64,AA==",
        width: 640,
        height: 480,
        originX: 5,
        originY: 6,
        zIndex: 1,
      },
    ],
  };
}

function generatedMethod(code: string): string {
  const method = code.match(/const __omniResult = await __omniSky\["([^"]+)"\]/)?.[1];
  if (method === undefined) throw new Error("missing generated method");
  return method;
}

function generatedInput(code: string): Record<string, unknown> {
  const encoded = code.match(/const __omniInput = (\{.*\});/)?.[1];
  if (encoded === undefined) throw new Error("missing generated input");
  return JSON.parse(encoded) as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}
