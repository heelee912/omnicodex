import { describe, expect, it, vi } from "vitest";
import {
  canonicalNativeResourceKeys,
  canonicalWindowsPath,
  mergeNativeExecutionOrdering,
  type NativeExecutionDescriptor,
  NativeExecutionOverloadedError,
  NativeExecutionScheduler,
  nativeExecutionOrderingFromArguments,
  resolveNativeExecutionTimeout,
} from "../src/application/native-execution-scheduler.js";
import type {
  DurableNativeResourceLease,
  DurableNativeResourceLeaseAcquisition,
  DurableNativeResourceLeaseCoordinatorLike,
  DurableNativeResourceLeaseRequest,
  DurableNativeResourceLeaseView,
} from "../src/infrastructure/runtime/durable-native-resource-lease-coordinator.js";

describe("NativeExecutionScheduler", () => {
  it.each([
    ["cua_repl", "js"],
    ["cua_repl", "js_reset"],
    ["cua_repl", "turn_ended"],
    ["mcp__cua_repl", "js"],
    ["mcp__cua_repl", "js_reset"],
    ["mcp__cua_repl", "turn_ended"],
    ["functions", "codex__cua_repl__js"],
    ["functions", "codex__mcp__cua_repl__turn_ended"],
  ])(
    "serializes %s/%s with its browser kernel while other work sessions proceed",
    async (nativeNamespace, originalName) => {
      const scheduler = new NativeExecutionScheduler();
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const events: string[] = [];
      const blocker = scheduler.run(
        { entry: entry("chrome"), ownerId: "owner", sessionId: "work" },
        async () => {
          started();
          await gate;
        },
      );
      await entered;
      const descriptor = {
        nativeNamespace,
        originalName,
        source: "downstream_mcp",
        stateEffect: "mutate" as const,
      };
      const same = scheduler.run(
        { entry: descriptor, ownerId: "owner", sessionId: "work" },
        async () => {
          events.push("same");
        },
      );
      const other = scheduler.run(
        { entry: descriptor, ownerId: "owner", sessionId: "other" },
        async () => {
          events.push("other");
        },
      );
      try {
        await other;
        expect(events).toEqual(["other"]);
      } finally {
        release();
        await Promise.all([blocker, same]);
        await scheduler.shutdown();
      }
      expect(events).toEqual(["other", "same"]);
    },
  );

  it.each([undefined, "C:\\Work\\Room"])(
    "runs independent commands concurrently without treating cwd %s as a mutation scope",
    async (workdir) => {
      const scheduler = new NativeExecutionScheduler({ shellConcurrency: 2 });
      const started: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const calls = ["first", "second"].map((label) =>
        scheduler.run(
          {
            entry: entry("exec_command"),
            ordering: nativeExecutionOrderingFromArguments({
              cmd: `Write-Output '${label}'`,
              ...(workdir === undefined ? {} : { workdir }),
            }),
          },
          async () => {
            started.push(label);
            await gate;
          },
        ),
      );
      try {
        await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
      } finally {
        release();
        await Promise.all(calls);
        await scheduler.shutdown();
      }
    },
  );

  it("runs independent keyless calls of the same tool concurrently with durable claims", async () => {
    const coordinator = new RecordingLeaseCoordinator();
    const scheduler = new NativeExecutionScheduler({ resourceLeaseCoordinator: coordinator });
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = { entry: entry("command/exec") };
    const first = scheduler.run({ ...request, operationId: "independent-first" }, async () => {
      started.push("first");
      await gate;
      return "first-result";
    });
    const second = scheduler.run({ ...request, operationId: "independent-second" }, async () => {
      started.push("second");
      await gate;
      return "second-result";
    });
    try {
      await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
      expect(coordinator.requests).toHaveLength(2);
      expect(coordinator.requests[0]?.resourceKeys).not.toEqual(
        coordinator.requests[1]?.resourceKeys,
      );
    } finally {
      release();
      expect(await Promise.all([first, second])).toEqual(["first-result", "second-result"]);
      await scheduler.shutdown();
    }
  });

  it("canonicalizes Windows path spelling into one scheduler and evidence identity", () => {
    expect(canonicalWindowsPath("C:/Work/Room/Scenes/../MAIN.tscn/")).toBe(
      canonicalWindowsPath("c:\\work\\room\\main.tscn"),
    );
    expect(
      canonicalNativeResourceKeys({
        workspacePaths: ["C:/Work/Room/"],
        filePaths: ["SCENES/Main.tscn"],
      }),
    ).toEqual(
      canonicalNativeResourceKeys({
        workspacePaths: ["c:\\work\\room"],
        filePaths: ["c:\\WORK\\ROOM\\scenes\\main.tscn\\"],
      }),
    );
  });

  it("extracts equivalent Chrome, Computer Use, ADB, Godot, and terminal resource keys", () => {
    const equivalent = (left: unknown, right: unknown) =>
      expect(canonicalNativeResourceKeys(nativeExecutionOrderingFromArguments(left))).toEqual(
        canonicalNativeResourceKeys(nativeExecutionOrderingFromArguments(right)),
      );
    equivalent(
      { surface: "Chrome", browserId: 2, targetTabId: "tab-7", window: { id: 42 } },
      {
        browser_surface: "chrome",
        browser_id: "2",
        target_tab_id: "tab-7",
        window_handle: 42,
      },
    );
    equivalent(
      { browserId: "browser-2", tabId: "tab-7" },
      { browser_id: "browser-2", tab_id: "tab-7" },
    );
    equivalent({ deviceSerial: "R58M123" }, { adb_serial: "R58M123" });
    equivalent({ contextThreadId: "019f-browser-context" }, { thread_id: "019f-browser-context" });
    equivalent(
      { projectPath: "C:/Work/Game/", scenePath: "scenes/Main.tscn" },
      { project_path: "c:\\WORK\\GAME", scene_path: "C:\\work\\game\\scenes\\main.tscn" },
    );
    equivalent({ sessionId: 17, cellId: "cell-a" }, { session_id: 17, cell_id: "cell-a" });
  });

  it("scopes native tab identities to their exact browser and ignores provider or code text ids", () => {
    const browserOne = canonicalNativeResourceKeys(
      nativeExecutionOrderingFromArguments({ browser_id: 1, target_tab_id: 42 }),
    );
    const browserTwo = canonicalNativeResourceKeys(
      nativeExecutionOrderingFromArguments({ browserId: 2, targetTabId: 42 }),
    );

    expect(browserOne).not.toEqual(browserTwo);
    expect(browserOne).toEqual(
      canonicalNativeResourceKeys(
        nativeExecutionOrderingFromArguments({ browserId: "1", tabId: "42" }),
      ),
    );
    expect(
      nativeExecutionOrderingFromArguments({
        providerTabId: "provider-tab",
        code: 'await cua.getTab("42", { browser: "1" }); // target_tab_id=42',
      }),
    ).toEqual({});
  });

  it("runs reads in parallel but fairly serializes desktop tools", async () => {
    const scheduler = new NativeExecutionScheduler({ shellConcurrency: 2 });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const first = scheduler.run({ entry: entry("browser.click") }, async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const second = scheduler.run({ entry: entry("computer_use") }, async () => {
      events.push("second:start");
    });
    const read = scheduler.run({ entry: entry("read_file") }, async () => {
      events.push("read");
    });
    await read;
    expect(events).toHaveLength(2);
    expect(events).toContain("first:start");
    expect(events).toContain("read");
    releaseFirst();
    await Promise.all([first, second]);
    expect(events.indexOf("first:end")).toBeLessThan(events.indexOf("second:start"));
  });

  it("orders calls sharing a process or normalized file key", async () => {
    const scheduler = new NativeExecutionScheduler();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    const first = scheduler.run(
      { entry: entry("write_file"), ordering: { filePaths: ["C:/Work/A.txt"] } },
      async () => {
        events.push("first");
        await gate;
      },
    );
    const second = scheduler.run(
      { entry: entry("read_file"), ordering: { filePaths: ["c:\\work\\a.TXT"] } },
      async () => {
        events.push("second");
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["first"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first", "second"]);
  });

  it("does not let the functions.exec orchestrator block its nested Chrome call", async () => {
    const scheduler = new NativeExecutionScheduler();
    const codeMode: NativeExecutionDescriptor = {
      nativeNamespace: "functions",
      originalName: "exec",
      source: "codex_responses_runtime",
      stateEffect: "none",
    };
    const chrome: NativeExecutionDescriptor = {
      nativeNamespace: "chrome",
      originalName: "chrome__control_chrome",
      source: "codex_browser_client",
      stateEffect: "mutate",
    };
    const events: string[] = [];
    await scheduler.run({ entry: codeMode }, async () => {
      events.push("exec:start");
      await scheduler.run({ entry: chrome }, async () => {
        events.push("chrome");
      });
      events.push("exec:end");
    });
    expect(events).toEqual(["exec:start", "chrome", "exec:end"]);
  });

  it("serializes high-level browser work with raw Node REPL work", async () => {
    const scheduler = new NativeExecutionScheduler();
    const rawNodeRepl: NativeExecutionDescriptor = {
      nativeNamespace: "node_repl",
      originalName: "js",
      source: "downstream_mcp",
    };
    const highLevelChrome: NativeExecutionDescriptor = {
      nativeNamespace: "chrome",
      originalName: "chrome__control_chrome",
      source: "codex_browser_client",
      stateEffect: "mutate",
    };
    let releaseRaw!: () => void;
    const rawGate = new Promise<void>((resolve) => {
      releaseRaw = resolve;
    });
    const events: string[] = [];
    const raw = scheduler.run({ entry: rawNodeRepl }, async () => {
      events.push("raw:start");
      await rawGate;
      events.push("raw:end");
    });
    const browser = scheduler.run({ entry: highLevelChrome }, async () => {
      events.push("browser:start");
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["raw:start"]);
    releaseRaw();
    await Promise.all([raw, browser]);
    expect(events).toEqual(["raw:start", "raw:end", "browser:start"]);
  });

  it("runs Chrome work concurrently across distinct Web work sessions", async () => {
    const scheduler = new NativeExecutionScheduler();
    const chrome: NativeExecutionDescriptor = {
      nativeNamespace: "chrome",
      originalName: "chrome__control_chrome",
      source: "codex_browser_client",
      stateEffect: "mutate",
    };
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const first = scheduler.run(
      {
        entry: chrome,
        ownerId: "owner",
        sessionId: "web-conversation-a",
        ordering: { surface: "chrome" },
      },
      async () => {
        events.push("a:start");
        await firstGate;
        events.push("a:end");
      },
    );
    const second = scheduler.run(
      {
        entry: chrome,
        ownerId: "owner",
        sessionId: "web-conversation-b",
        ordering: { surface: "chrome" },
      },
      async () => {
        events.push("b");
      },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["a:start", "b"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["a:start", "b", "a:end"]);
  });

  it("serializes distinct sessions that target the same browser and tab through schema aliases", async () => {
    const scheduler = new NativeExecutionScheduler();
    const chrome: NativeExecutionDescriptor = {
      nativeNamespace: "chrome",
      originalName: "chrome__control_chrome",
      source: "codex_browser_client",
      stateEffect: "mutate",
    };
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const first = scheduler.run(
      {
        entry: chrome,
        ownerId: "owner",
        sessionId: "web-conversation-a",
        ordering: nativeExecutionOrderingFromArguments({
          surface: "chrome",
          browser_id: 2,
          target_tab_id: 91,
        }),
      },
      async () => {
        events.push("a:start");
        await firstGate;
        events.push("a:end");
      },
    );
    const second = scheduler.run(
      {
        entry: chrome,
        ownerId: "owner",
        sessionId: "web-conversation-b",
        ordering: nativeExecutionOrderingFromArguments({
          surface: "chrome",
          browserId: "2",
          targetTabId: "91",
        }),
      },
      async () => {
        events.push("b");
      },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["a:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["a:start", "a:end", "b"]);
  });

  it("runs different tabs and the same numeric tab in different browsers concurrently", async () => {
    const scheduler = new NativeExecutionScheduler();
    const chrome: NativeExecutionDescriptor = {
      nativeNamespace: "chrome",
      originalName: "chrome__control_chrome",
      source: "codex_browser_client",
      stateEffect: "mutate",
    };
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const call = (
      sessionId: string,
      argumentsValue: Record<string, unknown>,
      operation: () => Promise<void>,
    ) =>
      scheduler.run(
        {
          entry: chrome,
          ownerId: "owner",
          sessionId,
          ordering: nativeExecutionOrderingFromArguments(argumentsValue),
        },
        operation,
      );
    const first = call(
      "web-conversation-a",
      { surface: "chrome", browser_id: 1, target_tab_id: 42 },
      async () => {
        events.push("first:start");
        await firstGate;
        events.push("first:end");
      },
    );
    const otherTab = call(
      "web-conversation-b",
      { surface: "chrome", browserId: "1", tabId: "43" },
      async () => {
        events.push("other-tab");
      },
    );
    const otherBrowser = call(
      "web-conversation-c",
      { surface: "chrome", browserId: "2", targetTabId: "42" },
      async () => {
        events.push("other-browser");
      },
    );

    try {
      await vi.waitFor(() => {
        expect(events).toHaveLength(3);
        expect(events).toEqual(
          expect.arrayContaining(["first:start", "other-tab", "other-browser"]),
        );
        expect(events).not.toContain("first:end");
      });
    } finally {
      releaseFirst();
      await Promise.all([first, otherTab, otherBrowser]);
      await scheduler.shutdown();
    }
    expect(events.at(-1)).toBe("first:end");
  });

  it("serializes only mutating Computer Use desktop input across work sessions", async () => {
    const scheduler = new NativeExecutionScheduler();
    const click: NativeExecutionDescriptor = {
      nativeNamespace: "codex.computer_use",
      originalName: "codex__computer_use__click",
      source: "codex_app_host",
      stateEffect: "mutate",
    };
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const first = scheduler.run(
      {
        entry: click,
        ownerId: "owner",
        sessionId: "web-conversation-a",
        ordering: { surface: "computer_use", windowId: "window-a" },
      },
      async () => {
        events.push("a:start");
        await firstGate;
        events.push("a:end");
      },
    );
    const second = scheduler.run(
      {
        entry: click,
        ownerId: "owner",
        sessionId: "web-conversation-b",
        ordering: { surface: "computer_use", windowId: "window-b" },
      },
      async () => {
        events.push("b");
      },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["a:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["a:start", "a:end", "b"]);
  });

  it("bounds shell concurrency and removes a cancelled queued call", async () => {
    const scheduler = new NativeExecutionScheduler({ shellConcurrency: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = scheduler.run({ entry: entry("shell_command") }, () => gate);
    const controller = new AbortController();
    const cancelled = scheduler.run(
      { entry: entry("exec_command"), signal: controller.signal },
      async () => "must-not-run",
    );
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    release();
    await first;
  });

  it("rejects an already-cancelled call before native dispatch", async () => {
    const scheduler = new NativeExecutionScheduler();
    const controller = new AbortController();
    controller.abort();
    let dispatched = false;

    await expect(
      scheduler.run({ entry: entry("read_file"), signal: controller.signal }, async () => {
        dispatched = true;
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(dispatched).toBe(false);
  });

  it("returns a bounded timeout error", async () => {
    const scheduler = new NativeExecutionScheduler();
    let release!: () => void;
    const stillRunning = new Promise<void>((resolve) => {
      release = resolve;
    });
    await expect(
      scheduler.run(
        {
          entry: entry("read_file"),
          timeoutMs: 5,
          ordering: { filePaths: ["C:\\work\\held.txt"] },
        },
        () => stillRunning,
      ),
    ).rejects.toThrow("Native tool timed out after 5ms");
    let secondStarted = false;
    const second = scheduler.run(
      { entry: entry("read_file"), ordering: { filePaths: ["C:\\work\\held.txt"] } },
      async () => {
        secondStarted = true;
      },
    );
    await Promise.resolve();
    expect(secondStarted).toBe(false);
    release();
    await second;
    expect(secondStarted).toBe(true);
  });

  it("classifies native work without inventing a completion timeout", () => {
    const cases: Array<{
      descriptor: NativeExecutionDescriptor;
      timeoutClass: string;
    }> = [
      {
        descriptor: {
          ...entry("read_thread"),
          stateEffect: "read",
        },
        timeoutClass: "catalog_read",
      },
      {
        descriptor: entry("exec_command"),
        timeoutClass: "shell_background",
      },
      {
        descriptor: {
          nativeNamespace: "chrome",
          originalName: "chrome__control_chrome",
          source: "codex_browser_client",
        },
        timeoutClass: "browser_ui",
      },
      {
        descriptor: {
          nativeNamespace: "functions",
          originalName: "exec",
          source: "codex_responses_runtime",
        },
        timeoutClass: "node_repl",
      },
      {
        descriptor: {
          ...entry("opaque_turn_operation"),
          modelEffect: "model",
        },
        timeoutClass: "explicit_model",
      },
    ];

    for (const testCase of cases) {
      expect(resolveNativeExecutionTimeout(testCase.descriptor)).toEqual({
        timeoutClass: testCase.timeoutClass,
        timeoutMs: undefined,
        callerSpecified: false,
      });
    }
    expect(resolveNativeExecutionTimeout(entry("send_message_to_thread")).timeoutClass).toBe(
      "explicit_model",
    );
    expect(resolveNativeExecutionTimeout(entry("read_thread"), 10_000)).toMatchObject({
      timeoutMs: 10_000,
      callerSpecified: true,
    });
  });

  it("propagates a caller timeout exactly without an adapter maximum", () => {
    const descriptor: NativeExecutionDescriptor = {
      nativeNamespace: "computer_use",
      originalName: "computer_use",
      source: "codex_computer_use_host",
    };
    expect(resolveNativeExecutionTimeout(descriptor, 24 * 60 * 60_000)).toEqual({
      timeoutClass: "browser_ui",
      timeoutMs: 24 * 60 * 60_000,
      callerSpecified: true,
    });
  });

  it("honors an absolute deadline and does not overflow long caller timeouts", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new NativeExecutionScheduler();
      let releaseLong!: () => void;
      const longGate = new Promise<void>((resolve) => {
        releaseLong = resolve;
      });
      let longSignal: AbortSignal | undefined;
      const long = scheduler.run(
        { entry: entry("read_file"), timeoutMs: 3_000_000_000 },
        async (signal) => {
          longSignal = signal;
          await longGate;
        },
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(longSignal?.aborted).toBe(false);
      releaseLong();
      await long;

      let releaseExpired!: () => void;
      const expiredGate = new Promise<void>((resolve) => {
        releaseExpired = resolve;
      });
      const expired = scheduler.run(
        { entry: entry("read_file"), deadlineUnixMs: Date.now() + 25 },
        () => expiredGate,
      );
      const assertion = expect(expired).rejects.toThrow("Native tool deadline exceeded at");
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      releaseExpired();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits indefinitely without a caller timeout and retains the UI lane", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new NativeExecutionScheduler();
      let receivedSignal: AbortSignal | undefined;
      let settleNative!: () => void;
      let markStarted!: () => void;
      const nativeSettlement = new Promise<void>((resolve) => {
        settleNative = resolve;
      });
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const first = scheduler.run({ entry: entry("browser.click") }, async (signal) => {
        receivedSignal = signal;
        markStarted();
        await nativeSettlement;
      });
      await started;
      expect(receivedSignal?.aborted).toBe(false);

      let firstSettled = false;
      void first.finally(() => {
        firstSettled = true;
      });
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(firstSettled).toBe(false);
      expect(receivedSignal?.aborted).toBe(false);

      let secondStarted = false;
      const second = scheduler.run({ entry: entry("computer_use") }, async () => {
        secondStarted = true;
      });
      await Promise.resolve();
      expect(secondStarted).toBe(false);
      settleNative();
      await first;
      await second;
      expect(secondStarted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not invent admission caps when the caller leaves limits undefined", async () => {
    const scheduler = new NativeExecutionScheduler({
      globalMaxRequests: undefined,
      globalMaxRequestBytes: undefined,
      sessionMaxRequests: undefined,
      sessionMaxRequestBytes: undefined,
    });
    await expect(
      scheduler.run(
        {
          entry: entry("read_large_file"),
          ownerId: "owner",
          sessionId: "session",
          requestBytes: 64 * 1024 * 1024 + 1,
        },
        async () => "large-request-retained",
      ),
    ).resolves.toBe("large-request-retained");

    let releaseBlocker!: () => void;
    let markBlockerStarted!: () => void;
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blockerStarted = new Promise<void>((resolve) => {
      markBlockerStarted = resolve;
    });
    const blocker = scheduler.run(
      {
        entry: entry("computer_use"),
        ownerId: "owner",
        sessionId: "session",
      },
      async () => {
        markBlockerStarted();
        await blockerGate;
        return "blocker";
      },
    );
    await blockerStarted;

    const queued = Array.from({ length: 128 }, (_, index) =>
      scheduler.run(
        {
          entry: entry("computer_use"),
          ownerId: "owner",
          sessionId: "session",
        },
        async () => `queued-${index}`,
      ),
    );
    releaseBlocker();

    const results = await Promise.all([blocker, ...queued]);
    expect(results).toHaveLength(129);
    expect(results.at(-1)).toBe("queued-127");
  });

  it("bounds global and per-session retained requests with an explicit retry contract", async () => {
    const scheduler = new NativeExecutionScheduler({
      globalMaxRequests: 2,
      globalMaxRequestBytes: 20,
      sessionMaxRequests: 1,
      sessionMaxRequestBytes: 10,
      overloadRetryAfterMs: 375,
    });
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const first = scheduler.run(
      {
        entry: entry("read_file"),
        ownerId: "owner",
        sessionId: "session-a",
        requestBytes: 10,
      },
      () => firstGate,
    );

    const sameSession = scheduler.run(
      {
        entry: entry("read_file"),
        ownerId: "owner",
        sessionId: "session-a",
        requestBytes: 1,
      },
      async () => undefined,
    );
    await expect(sameSession).rejects.toMatchObject({
      name: "NativeExecutionOverloadedError",
      code: "OVERLOADED",
      retryAfterMs: 375,
      message: "OVERLOADED retryAfterMs=375",
    });

    const second = scheduler.run(
      {
        entry: entry("read_file"),
        ownerId: "owner",
        sessionId: "session-b",
        requestBytes: 10,
      },
      () => secondGate,
    );
    await expect(
      scheduler.run(
        {
          entry: entry("read_file"),
          ownerId: "other-owner",
          sessionId: "session-c",
          requestBytes: 1,
        },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(NativeExecutionOverloadedError);

    releaseFirst();
    releaseSecond();
    await Promise.all([first, second]);
    await expect(
      scheduler.run(
        {
          entry: entry("read_file"),
          ownerId: "owner",
          sessionId: "session-a",
          requestBytes: 10,
        },
        async () => "capacity-released",
      ),
    ).resolves.toBe("capacity-released");
  });

  it("keeps authenticated admission identity and explicit ordering authoritative", async () => {
    const scheduler = new NativeExecutionScheduler({
      globalMaxRequests: 2,
      globalMaxRequestBytes: 20,
      sessionMaxRequests: 1,
      sessionMaxRequestBytes: 10,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = scheduler.withRequestContext(
      { ownerId: "authenticated-owner", sessionId: "authenticated-session", requestBytes: 10 },
      () =>
        scheduler.run(
          {
            entry: entry("read_file"),
            ownerId: "spoofed-owner",
            sessionId: "spoofed-session",
            requestBytes: 0,
          },
          () => gate,
        ),
    );

    await expect(
      scheduler.withRequestContext(
        { ownerId: "authenticated-owner", sessionId: "authenticated-session", requestBytes: 1 },
        () => scheduler.run({ entry: entry("read_file") }, async () => undefined),
      ),
    ).rejects.toBeInstanceOf(NativeExecutionOverloadedError);
    expect(
      mergeNativeExecutionOrdering(
        { threadId: "untrusted-argument-thread", processId: "untrusted-argument-process" },
        { threadId: "dispatch-thread", processId: "dispatch-process" },
      ),
    ).toMatchObject({ threadId: "dispatch-thread", processId: "dispatch-process" });

    release();
    await first;
  });

  it("serializes Chrome within one work session without blocking another", async () => {
    const scheduler = new NativeExecutionScheduler();
    let releaseBlocker!: () => void;
    let blockerStarted!: () => void;
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const started = new Promise<void>((resolve) => {
      blockerStarted = resolve;
    });
    const events: string[] = [];
    const blocker = scheduler.run(
      { entry: entry("chrome"), ownerId: "owner-a", sessionId: "session-a1" },
      async () => {
        events.push("a1-blocker");
        blockerStarted();
        await blockerGate;
      },
    );
    await started;
    const sameSession = scheduler.run(
      { entry: entry("chrome"), ownerId: "owner-a", sessionId: "session-a1" },
      async () => {
        events.push("a1-next");
      },
    );
    const otherSession = scheduler.run(
      { entry: entry("chrome"), ownerId: "owner-a", sessionId: "session-a2" },
      async () => {
        events.push("a2");
      },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["a1-blocker", "a2"]);
    releaseBlocker();
    await Promise.all([blocker, sameSession, otherSession]);

    expect(events).toEqual(["a1-blocker", "a2", "a1-next"]);
  });

  it("keeps task-scoped in-app browser sessions independent", async () => {
    const scheduler = new NativeExecutionScheduler();
    const iab: NativeExecutionDescriptor = {
      nativeNamespace: "browser",
      originalName: "browser__control_in_app_browser",
      source: "codex_browser_client",
      stateEffect: "mutate",
    };
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const first = scheduler.run({ entry: iab, ownerId: "owner", sessionId: "iab-a" }, async () => {
      events.push("a:start");
      await firstGate;
      events.push("a:end");
    });
    const second = scheduler.run({ entry: iab, ownerId: "owner", sessionId: "iab-b" }, async () => {
      events.push("b");
    });

    await vi.waitFor(() => expect(events).toEqual(["a:start", "b"]));
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["a:start", "b", "a:end"]);
  });

  it("resolves explicit file targets against cwd and preserves their collision scope", async () => {
    const workspace = "C:\\Work\\Room";
    const patchOrdering = nativeExecutionOrderingFromArguments({
      workdir: workspace,
      input:
        "*** Begin Patch\n*** Update File: scenes/main.tscn\n*** Move to: scenes/final.tscn\n*** End Patch",
    });
    const commandOrdering = nativeExecutionOrderingFromArguments({
      cmd: "godot --headless --editor --quit",
      workdir: workspace.toLowerCase(),
      path: "scenes/main.tscn",
    });
    expect(patchOrdering).toEqual({
      filePaths: ["C:\\Work\\Room\\scenes\\main.tscn", "C:\\Work\\Room\\scenes\\final.tscn"],
    });
    expect(commandOrdering).toEqual({ filePaths: ["c:\\work\\room\\scenes\\main.tscn"] });

    const scheduler = new NativeExecutionScheduler();
    let releasePatch!: () => void;
    const patchGate = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });
    const events: string[] = [];
    const patch = scheduler.run(
      { entry: entry("apply_patch"), ordering: patchOrdering },
      async () => {
        events.push("patch");
        await patchGate;
      },
    );
    await vi.waitFor(() => expect(events).toEqual(["patch"]));
    const command = scheduler.run(
      { entry: entry("exec_command"), ordering: commandOrdering },
      async () => {
        events.push("command");
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["patch"]);
    releasePatch();
    await Promise.all([patch, command]);
    expect(events).toEqual(["patch", "command"]);
  });

  it("propagates cancellation to a native operation and retains its lane until settlement", async () => {
    const scheduler = new NativeExecutionScheduler();
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let settleNative!: () => void;
    let markStarted!: () => void;
    const nativeSettlement = new Promise<void>((resolve) => {
      settleNative = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const first = scheduler.run(
      { entry: entry("computer_use"), signal: controller.signal },
      async (signal) => {
        receivedSignal = signal;
        markStarted();
        await nativeSettlement;
      },
    );
    await started;
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(receivedSignal?.aborted).toBe(true);

    let secondStarted = false;
    const second = scheduler.run({ entry: entry("computer_use") }, async () => {
      secondStarted = true;
    });
    await Promise.resolve();
    expect(secondStarted).toBe(false);
    settleNative();
    await second;
    expect(secondStarted).toBe(true);
  });

  it("does not let transport-context lifetime cancel a dispatched native operation", async () => {
    const scheduler = new NativeExecutionScheduler();
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let settleNative!: () => void;
    const nativeSettlement = new Promise<void>((resolve) => {
      settleNative = resolve;
    });
    // Models an older gateway object at the runtime boundary. Validation must
    // strip the transport signal even if stale JavaScript still supplies it.
    const legacyTransportContext = {
      ownerId: "owner",
      sessionId: "session",
      requestBytes: 42,
      signal: controller.signal,
    };
    const operation = scheduler.withRequestContext(legacyTransportContext, () =>
      scheduler.run({ entry: entry("computer_use") }, async (signal) => {
        receivedSignal = signal;
        await nativeSettlement;
      }),
    );
    await vi.waitFor(() => expect(receivedSignal).toBeDefined());
    controller.abort();
    expect(receivedSignal?.aborted).toBe(false);
    settleNative();
    await expect(operation).resolves.toBeUndefined();
  });

  it("cancels an authoritative read when its HTTP transport disconnects", async () => {
    const scheduler = new NativeExecutionScheduler();
    const transport = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const operation = scheduler.withRequestContext(
      {
        ownerId: "owner",
        sessionId: "session",
        requestBytes: 42,
        transportDisconnectSignal: transport.signal,
      },
      () =>
        scheduler.run({ entry: { ...entry("read_file"), stateEffect: "read" } }, async (signal) => {
          receivedSignal = signal;
          markStarted();
          if (signal === undefined) throw new Error("missing read cancellation signal");
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          signal.throwIfAborted();
        }),
    );

    await started;
    transport.abort();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("keeps a mutation running when only its HTTP transport disconnects", async () => {
    const scheduler = new NativeExecutionScheduler();
    const transport = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let settleNative!: () => void;
    const nativeSettlement = new Promise<void>((resolve) => {
      settleNative = resolve;
    });

    const operation = scheduler.withRequestContext(
      {
        ownerId: "owner",
        sessionId: "session",
        requestBytes: 42,
        transportDisconnectSignal: transport.signal,
      },
      () =>
        scheduler.run(
          { entry: { ...entry("computer_use"), stateEffect: "mutate" } },
          async (signal) => {
            receivedSignal = signal;
            await nativeSettlement;
          },
        ),
    );

    await vi.waitFor(() => expect(receivedSignal).toBeDefined());
    transport.abort();
    expect(receivedSignal?.aborted).toBe(false);
    settleNative();
    await expect(operation).resolves.toBeUndefined();
  });

  it("acquires the durable resource after the in-process key and before lane dispatch", async () => {
    const coordinator = new RecordingLeaseCoordinator();
    const scheduler = new NativeExecutionScheduler({ resourceLeaseCoordinator: coordinator });
    let releaseFirstAcquire!: () => void;
    const firstAcquireGate = new Promise<void>((resolve) => {
      releaseFirstAcquire = resolve;
    });
    coordinator.acquireGate = firstAcquireGate;
    const events: string[] = [];
    const first = scheduler.run(
      {
        operationId: "operation-first",
        entry: entry("computer_use"),
        ordering: { windowId: "window-1" },
      },
      async () => {
        events.push("first:native");
      },
    );
    await coordinator.waitForAcquireCount(1);
    const second = scheduler.run(
      {
        operationId: "operation-second",
        entry: entry("computer_use"),
        ordering: { windowId: "window-1" },
      },
      async () => {
        events.push("second:native");
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(coordinator.requests).toHaveLength(1);
    expect(events).toEqual([]);
    releaseFirstAcquire();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:native", "second:native"]);
    expect(coordinator.events).toEqual([
      "operation-first:acquire",
      "operation-first:dispatched",
      "operation-first:settled",
      "operation-second:acquire",
      "operation-second:dispatched",
      "operation-second:settled",
    ]);
  });

  it("does not persist outcome-unknown leases for authoritative read-only calls", async () => {
    const coordinator = new RecordingLeaseCoordinator();
    const scheduler = new NativeExecutionScheduler({ resourceLeaseCoordinator: coordinator });

    await expect(
      scheduler.run(
        {
          operationId: "read-only-operation",
          entry: { ...entry("read_thread"), stateEffect: "read" },
          ordering: { threadId: "thread-read-only" },
        },
        async () => "read-result",
      ),
    ).resolves.toBe("read-result");

    expect(coordinator.requests).toEqual([]);
  });

  it("retires stale resource fences only after a successful authoritative read", async () => {
    const coordinator = new RecordingLeaseCoordinator();
    const scheduler = new NativeExecutionScheduler({ resourceLeaseCoordinator: coordinator });
    const readEntry = { ...entry("chrome/list_user_tabs"), stateEffect: "read" as const };
    const ordering = { surface: "chrome", windowId: "window-one" };

    await expect(
      scheduler.run(
        {
          operationId: "authoritative-browser-read",
          entry: readEntry,
          ordering,
          recoverUnknownResourcesWhen: (result) => result === "authoritative-success",
        },
        async () => "authoritative-success",
      ),
    ).resolves.toBe("authoritative-success");
    expect(coordinator.recoveryResourceKeys).toHaveLength(1);
    expect(coordinator.recoveryResourceKeys[0]).not.toContain("shared-chrome-runtime");
    expect(coordinator.recoveryResourceKeys[0]?.some((key) => key.startsWith("0:lane:ui:"))).toBe(
      true,
    );
    expect(coordinator.recoveryResourceKeys[0]).toContain("4:window:window-one");
    expect(coordinator.recoveryProofs).toEqual([true]);

    await scheduler.run(
      {
        operationId: "failed-browser-readback",
        entry: readEntry,
        ordering,
        recoverUnknownResourcesWhen: () => false,
      },
      async () => "tool-error",
    );
    expect(coordinator.recoveryResourceKeys).toHaveLength(1);
  });

  it("does not head-of-line block concurrent readers of the same native resource", async () => {
    const scheduler = new NativeExecutionScheduler();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted = false;
    const readEntry = { ...entry("read_thread"), stateEffect: "read" as const };
    const ordering = { threadId: "shared-thread" };

    const first = scheduler.run(
      { operationId: "reader-one", entry: readEntry, ordering },
      () => firstGate,
    );
    const second = scheduler.run(
      { operationId: "reader-two", entry: readEntry, ordering },
      async () => {
        secondStarted = true;
      },
    );

    await vi.waitFor(() => expect(secondStarted).toBe(true));
    releaseFirst();
    await Promise.all([first, second]);
  });

  it("joins one explicit operationId in-process and executes the native callback once", async () => {
    const coordinator = new RecordingLeaseCoordinator();
    const scheduler = new NativeExecutionScheduler({ resourceLeaseCoordinator: coordinator });
    let releaseNative!: () => void;
    const nativeGate = new Promise<void>((resolve) => {
      releaseNative = resolve;
    });
    let executions = 0;
    const request = {
      operationId: "joined-operation",
      entry: entry("write_file"),
      ordering: { filePaths: ["C:\\work\\joined.txt"] },
    } as const;
    const first = scheduler.run(request, async () => {
      executions += 1;
      await nativeGate;
      return "one-result";
    });
    const joined = scheduler.run(request, async () => {
      executions += 1;
      return "must-not-run";
    });
    await coordinator.waitForAcquireCount(1);
    releaseNative();
    await expect(Promise.all([first, joined])).resolves.toEqual(["one-result", "one-result"]);
    expect(executions).toBe(1);
    expect(coordinator.requests).toHaveLength(1);
  });

  it("digests oversized runtime descriptors before durable lease acquisition", async () => {
    const coordinator = new RecordingLeaseCoordinator();
    const scheduler = new NativeExecutionScheduler({ resourceLeaseCoordinator: coordinator });
    const oversizedRuntimeEntry = {
      ...entry("exec"),
      description: "x".repeat(645_036),
      tool: {
        nativeSpec: {
          description: "y".repeat(645_036),
        },
      },
    } as NativeExecutionDescriptor;

    await expect(
      scheduler.run(
        {
          operationId: "oversized-runtime-entry",
          entry: oversizedRuntimeEntry,
        },
        async () => "executed",
      ),
    ).resolves.toBe("executed");

    expect(coordinator.requests).toHaveLength(1);
    expect(coordinator.requests[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps the durable lease after caller timeout until the native promise settles", async () => {
    const coordinator = new RecordingLeaseCoordinator();
    const scheduler = new NativeExecutionScheduler({ resourceLeaseCoordinator: coordinator });
    let releaseNative!: () => void;
    const nativeGate = new Promise<void>((resolve) => {
      releaseNative = resolve;
    });
    await expect(
      scheduler.run(
        {
          operationId: "timed-operation",
          entry: entry("write_file"),
          timeoutMs: 5,
          ordering: { filePaths: ["C:\\work\\timed.txt"] },
        },
        () => nativeGate,
      ),
    ).rejects.toThrow("Native tool timed out after 5ms");
    expect(coordinator.events).toContain("timed-operation:dispatched");
    expect(coordinator.events).not.toContain("timed-operation:settled");
    releaseNative();
    await vi.waitFor(() => expect(coordinator.events).toContain("timed-operation:settled"));
  });

  it("waits indefinitely for native settlement when shutdown has no caller timeout", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new RecordingLeaseCoordinator();
      const scheduler = new NativeExecutionScheduler({ resourceLeaseCoordinator: coordinator });
      let releaseNative!: () => void;
      let operationSignal: AbortSignal | undefined;
      const nativeGate = new Promise<void>((resolve) => {
        releaseNative = resolve;
      });
      const running = scheduler.run(
        { operationId: "unbounded-shutdown-operation", entry: entry("computer_use") },
        async (signal) => {
          operationSignal = signal;
          await nativeGate;
        },
      );
      await coordinator.waitForAcquireCount(1);

      const shuttingDown = scheduler.shutdown();
      let shutdownSettled = false;
      void shuttingDown.finally(() => {
        shutdownSettled = true;
      });
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(shutdownSettled).toBe(false);
      expect(operationSignal?.aborted).toBe(false);
      expect(coordinator.interruptCount).toBe(0);
      expect(coordinator.events).not.toContain("unbounded-shutdown-operation:unknown");

      releaseNative();
      await expect(Promise.all([running, shuttingDown])).resolves.toEqual([undefined, undefined]);
      expect(coordinator.events).toContain("unbounded-shutdown-operation:settled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arms a caller-supplied shutdown timeout beyond the native timer maximum", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new NativeExecutionScheduler();
      let releaseNative!: () => void;
      let operationSignal: AbortSignal | undefined;
      const nativeGate = new Promise<void>((resolve) => {
        releaseNative = resolve;
      });
      const running = scheduler.run({ entry: entry("computer_use") }, async (signal) => {
        operationSignal = signal;
        await nativeGate;
      });
      await vi.advanceTimersByTimeAsync(1);

      const shuttingDown = scheduler.shutdown(3_000_000_000);
      let shutdownSettled = false;
      void shuttingDown.finally(() => {
        shutdownSettled = true;
      });
      await vi.advanceTimersByTimeAsync(2_147_483_648);
      expect(shutdownSettled).toBe(false);
      expect(operationSignal?.aborted).toBe(false);

      releaseNative();
      await expect(Promise.all([running, shuttingDown])).resolves.toEqual([undefined, undefined]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences new admission and records unknown without failing intentional deadline cleanup", async () => {
    const coordinator = new RecordingLeaseCoordinator();
    const scheduler = new NativeExecutionScheduler({ resourceLeaseCoordinator: coordinator });
    let releaseNative!: () => void;
    const nativeGate = new Promise<void>((resolve) => {
      releaseNative = resolve;
    });
    const running = scheduler.run(
      { operationId: "shutdown-operation", entry: entry("computer_use") },
      () => nativeGate,
    );
    await coordinator.waitForAcquireCount(1);
    await expect(scheduler.shutdown(5)).resolves.toBeUndefined();
    expect(coordinator.interruptCount).toBe(1);
    await expect(
      scheduler.run({ entry: entry("read_file") }, async () => undefined),
    ).rejects.toThrow("shutting down");
    releaseNative();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });
});

function entry(name: string): NativeExecutionDescriptor {
  return {
    originalName: name,
    nativeNamespace: "test",
    source: "test",
  };
}

class RecordingLeaseCoordinator implements DurableNativeResourceLeaseCoordinatorLike {
  readonly requests: DurableNativeResourceLeaseRequest[] = [];
  readonly events: string[] = [];
  readonly recoveryResourceKeys: string[][] = [];
  readonly recoveryProofs: boolean[] = [];
  acquireGate: Promise<void> | undefined;
  interruptCount = 0;

  async acquire(
    input: DurableNativeResourceLeaseRequest,
  ): Promise<DurableNativeResourceLeaseAcquisition> {
    this.requests.push(input);
    this.events.push(`${input.operationId}:acquire`);
    await this.acquireGate;
    this.acquireGate = undefined;
    return {
      kind: "acquired",
      lease: new RecordingLease(input.operationId, this.events),
    };
  }

  async interruptOwnedOperations(): Promise<number> {
    this.interruptCount += 1;
    return 1;
  }

  async recoverUnknownResources(
    resourceKeys: readonly string[],
    proveSettled: (lease: DurableNativeResourceLeaseView) => Promise<boolean>,
  ): Promise<number> {
    this.recoveryResourceKeys.push([...resourceKeys]);
    const proven = await proveSettled({
      operationDigest: "operation".padEnd(64, "0"),
      fingerprintDigest: "fingerprint".padEnd(64, "0"),
      resourceDigests: ["resource".padEnd(64, "0")],
      generation: 1,
      state: "outcome_unknown",
      owner: {
        pid: 1,
        processStartedAtIso: "2026-01-01T00:00:00.000Z",
        instanceNonce: "nonce",
        daemonStartedAtUnixMs: 1,
      },
      acquiredAtUnixMs: 1,
      heartbeatAtUnixMs: 1,
      expiresAtUnixMs: 1,
      dispatchedAtUnixMs: 1,
      outcomeUnknownAtUnixMs: 1,
    });
    this.recoveryProofs.push(proven);
    return proven ? 1 : 0;
  }

  async waitForAcquireCount(count: number): Promise<void> {
    await vi.waitFor(() => expect(this.requests).toHaveLength(count));
  }
}

class RecordingLease implements DurableNativeResourceLease {
  readonly generation = 1;
  readonly resourceDigests: readonly string[] = [];
  readonly operationId: string;
  readonly #events: string[];

  constructor(operationId: string, events: string[]) {
    this.operationId = operationId;
    this.#events = events;
  }

  async markDispatched(): Promise<void> {
    this.#events.push(`${this.operationId}:dispatched`);
  }

  async abandonBeforeDispatch(): Promise<void> {
    this.#events.push(`${this.operationId}:abandoned`);
  }

  async settle(): Promise<void> {
    this.#events.push(`${this.operationId}:settled`);
  }

  async markOutcomeUnknown(): Promise<void> {
    this.#events.push(`${this.operationId}:unknown`);
  }
}
