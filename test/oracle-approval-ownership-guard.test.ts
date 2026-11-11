import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  CdpFrameError,
  CdpProtocolError,
  type CdpWebSocketLike,
  ORACLE_APPROVAL_CONTROL_SNAPSHOT_EXPRESSION,
  ORACLE_APPROVAL_OWNER_CLAIM_EXPRESSION,
} from "../src/infrastructure/chatgpt/chatgpt-cdp-transport.js";
import { OracleApprovalOwnershipGuard } from "../src/infrastructure/chatgpt/oracle-approval-ownership-guard.js";

describe("OracleApprovalOwnershipGuard", () => {
  it("attaches each new page without pausing and installs the owner for current and future documents", async () => {
    const socket = new FakeBrowserSocket();
    const guard = new OracleApprovalOwnershipGuard({
      endpoint: "http://127.0.0.1:9222",
      websocketFactory: () => socket,
      fetch: async () =>
        new Response(
          JSON.stringify({
            Browser: "Chrome/151.0.0.0",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/exact-browser",
          }),
          { status: 200 },
        ),
    });

    const started = guard.start();
    socket.open();
    await started;
    const autoAttach = socket.sent.find((message) => message.method === "Target.setAutoAttach");
    expect(autoAttach?.params).toEqual({
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "page", exclude: false }, { exclude: true }],
    });

    socket.event("Target.attachedToTarget", {
      sessionId: "new-page-session",
      targetInfo: { targetId: "new-page", type: "page", url: "about:blank" },
      waitingForDebugger: false,
    });
    await socket.waitForMethod("Runtime.evaluate", "new-page-session");
    const newPageCommands = socket.sent.filter(
      (message) => message.sessionId === "new-page-session",
    );
    expect(newPageCommands.map((message) => message.method)).toEqual([
      "Page.addScriptToEvaluateOnNewDocument",
      "Runtime.evaluate",
    ]);
    expect(newPageCommands[0]?.params).toEqual({
      source: ORACLE_APPROVAL_OWNER_CLAIM_EXPRESSION,
    });
    await guard.stop();
  });

  it("renews one owner timer and atomically replaces an Oracle timer", () => {
    const cleared: number[] = [];
    let nextTimer = 0;
    const browserWindow: Record<string, unknown> = {
      setInterval: () => ++nextTimer,
      clearInterval: (timer: number) => cleared.push(timer),
      clearTimeout: (timer: number) => cleared.push(timer),
    };
    const context = { window: browserWindow, Date };

    expect(runInNewContext(ORACLE_APPROVAL_OWNER_CLAIM_EXPRESSION, context)).toMatchObject({
      owner: "omnicodex-daemon/v1",
      replacedOracleWatcher: false,
    });
    expect(nextTimer).toBe(1);
    expect(runInNewContext(ORACLE_APPROVAL_OWNER_CLAIM_EXPRESSION, context)).toMatchObject({
      owner: "omnicodex-daemon/v1",
      replacedOracleWatcher: false,
    });
    expect(nextTimer).toBe(1);

    browserWindow.__oracleAppApprovalWatcher = {
      wanted: "omnicodex",
      timer: 77,
      events: [],
      reportedCount: 0,
    };
    expect(runInNewContext(ORACLE_APPROVAL_OWNER_CLAIM_EXPRESSION, context)).toMatchObject({
      owner: "omnicodex-daemon/v1",
      replacedOracleWatcher: true,
    });
    expect(nextTimer).toBe(2);
    expect(cleared).toEqual([77, 77]);
  });

  it("refreshes legacy owners and reads hydration readiness without rescanning approvals", () => {
    const disconnect = vi.fn();
    const clearInterval = vi.fn();
    let composer: object | null = null;
    let responseInProgress = false;
    const querySelectorAll = vi.fn((selector: string) =>
      selector.includes("stop-button") && responseInProgress
        ? [{ getBoundingClientRect: () => ({ width: 30, height: 30 }) }]
        : [],
    );
    const document = {
      readyState: "loading",
      getElementById: () => composer,
      querySelectorAll,
    };
    const window = {
      __oracleAppApprovalWatcher: {
        owner: "omnicodex-daemon/v1",
        wanted: "omnicodex",
        version: 2,
        implementation: 5,
        timer: 1,
        observer: { disconnect },
      },
      setInterval: () => 2,
      clearInterval,
      clearTimeout: vi.fn(),
    };
    const context = {
      window,
      document,
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    };
    runInNewContext(ORACLE_APPROVAL_OWNER_CLAIM_EXPRESSION, context);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(clearInterval).toHaveBeenCalledWith(1);
    const read = () => runInNewContext(ORACLE_APPROVAL_CONTROL_SNAPSHOT_EXPRESSION, context);
    expect(read()).toMatchObject({
      implementation: 10,
      documentReady: false,
      responseInProgress: false,
    });
    document.readyState = "complete";
    expect(read()).toMatchObject({ documentReady: false });
    composer = {};
    expect(read()).toMatchObject({ documentReady: true });
    responseInProgress = true;
    expect(read()).toMatchObject({ responseInProgress: true });
    expect(
      querySelectorAll.mock.calls.filter(([selector]) => !selector.includes("stop-button")),
    ).toHaveLength(1);
  });

  it("indexes approval dialogs once and rescans only after a relevant DOM mutation", () => {
    let scans = 0;
    let observerCallback: ((records: unknown[]) => void) | undefined;
    const button = {
      nodeType: 1,
      innerText: "Always allow",
      textContent: "Always allow",
      isConnected: true,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 120, height: 32 }),
      matches: () => false,
      closest: () => scope,
      querySelector: () => null,
    };
    const scope = {
      nodeType: 1,
      innerText: "OmniCodex needs approval Always allow",
      textContent: "OmniCodex needs approval Always allow",
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 400, height: 220 }),
      matches: () => true,
      closest: () => scope,
      querySelector: () => button,
      querySelectorAll: () => [button],
    };
    const document = {
      readyState: "complete",
      getElementById: () => ({}),
      querySelectorAll: (selector: string) => {
        if (selector.includes("stop-button")) return [];
        scans += 1;
        return [scope];
      },
    };
    class MutationObserver {
      constructor(callback: (records: unknown[]) => void) {
        observerCallback = callback;
      }
      observe() {}
      disconnect() {}
    }
    const browserWindow: Record<string, unknown> = {
      setInterval: () => 1,
      clearInterval: () => undefined,
      clearTimeout: () => undefined,
    };
    const context = {
      window: browserWindow,
      document,
      MutationObserver,
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    };

    runInNewContext(ORACLE_APPROVAL_OWNER_CLAIM_EXPRESSION, context);
    expect(runInNewContext(ORACLE_APPROVAL_CONTROL_SNAPSHOT_EXPRESSION, context)).toMatchObject({
      revision: "oracle-v2-1",
      controls: [{ ref: "oa-0", name: "Always allow" }],
    });
    runInNewContext(ORACLE_APPROVAL_CONTROL_SNAPSHOT_EXPRESSION, context);
    expect(scans).toBe(1);

    observerCallback?.([
      {
        target: {
          nodeType: 1,
          matches: () => false,
          closest: () => null,
          querySelector: () => null,
        },
        addedNodes: [],
        removedNodes: [],
      },
    ]);
    runInNewContext(ORACLE_APPROVAL_CONTROL_SNAPSHOT_EXPRESSION, context);
    expect(scans).toBe(1);

    observerCallback?.([{ target: scope, addedNodes: [], removedNodes: [] }]);
    expect(runInNewContext(ORACLE_APPROVAL_CONTROL_SNAPSHOT_EXPRESSION, context)).toMatchObject({
      revision: "oracle-v2-2",
    });
    expect(scans).toBe(2);
  });

  it("indexes a minimized approval card when its allow button still has a visible box", () => {
    const button = {
      nodeType: 1,
      innerText: "허용하기",
      textContent: "허용하기",
      isConnected: true,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 25, height: 36 }),
      matches: () => false,
      closest: () => scope,
      querySelector: () => null,
    };
    const scope = {
      nodeType: 1,
      innerText:
        "OmniCodex 파일 생성을 허용할까요? ChatGPT가 반환된 1개의 파일 첨부를 생성합니다. 허용하기",
      textContent:
        "OmniCodex 파일 생성을 허용할까요? ChatGPT가 반환된 1개의 파일 첨부를 생성합니다. 허용하기",
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 0, height: 2499 }),
      matches: () => true,
      closest: () => scope,
      querySelector: () => button,
      querySelectorAll: () => [button],
    };
    const document = {
      readyState: "complete",
      getElementById: () => ({}),
      querySelectorAll: (selector: string) => (selector.includes("stop-button") ? [] : [scope]),
    };
    const context = {
      window: {
        setInterval: () => 1,
        clearInterval: () => undefined,
        clearTimeout: () => undefined,
      },
      document,
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    };

    runInNewContext(ORACLE_APPROVAL_OWNER_CLAIM_EXPRESSION, context);

    expect(runInNewContext(ORACLE_APPROVAL_CONTROL_SNAPSHOT_EXPRESSION, context)).toMatchObject({
      implementation: 10,
      controls: [{ ref: "oa-0", name: "허용하기", exactAppScope: true }],
    });
  });

  it("bootstraps pages that existed before the guard connected", async () => {
    const socket = new FakeBrowserSocket([
      { targetId: "existing-page", type: "page", url: "https://chatgpt.com/" },
    ]);
    const guard = new OracleApprovalOwnershipGuard({
      endpoint: "http://127.0.0.1:9222",
      websocketFactory: () => socket,
      fetch: async () =>
        new Response(
          JSON.stringify({
            Browser: "Chrome/151.0.0.0",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/exact-browser",
          }),
          { status: 200 },
        ),
    });

    const started = guard.start();
    socket.open();
    await started;
    await vi.waitFor(() =>
      expect(
        socket.sent.some(
          (message) =>
            message.method === "Page.addScriptToEvaluateOnNewDocument" &&
            message.sessionId === "session-existing-page",
        ),
      ).toBe(true),
    );
    await guard.stop();
  });

  it("resumes every concurrent auto-attached session for the same page", async () => {
    const socket = new FakeBrowserSocket();
    const guard = new OracleApprovalOwnershipGuard({
      endpoint: "http://127.0.0.1:9222",
      websocketFactory: () => socket,
      fetch: browserVersionFetch(),
    });

    const started = guard.start();
    socket.open();
    await started;
    for (const sessionId of ["auto-session-1", "auto-session-2"]) {
      socket.event("Target.attachedToTarget", {
        sessionId,
        waitingForDebugger: true,
        targetInfo: {
          targetId: "shared-page",
          type: "page",
          url: "https://chatgpt.com/c/shared",
        },
      });
    }

    await socket.waitForMethod("Runtime.runIfWaitingForDebugger", "auto-session-1");
    await socket.waitForMethod("Runtime.runIfWaitingForDebugger", "auto-session-2");
    expect(
      socket.sent
        .filter((message) => message.method === "Runtime.runIfWaitingForDebugger")
        .map((message) => message.sessionId),
    ).toEqual(["auto-session-1", "auto-session-2"]);
    await guard.stop();
  });

  it("retries an idempotent resume response loss on the same attached session", async () => {
    const failures: Error[] = [];
    const socket = new FakeBrowserSocket([], {
      "Runtime.runIfWaitingForDebugger": [
        { code: -32_000, message: "temporary renderer startup gap" },
        undefined,
      ],
    });
    const guard = new OracleApprovalOwnershipGuard({
      endpoint: "http://127.0.0.1:9222",
      websocketFactory: () => socket,
      fetch: browserVersionFetch(),
      onUnhealthy: (error) => {
        failures.push(error);
      },
    });

    const started = guard.start();
    socket.open();
    await started;
    socket.event("Target.attachedToTarget", {
      sessionId: "startup-gap-session",
      waitingForDebugger: true,
      targetInfo: { targetId: "startup-gap", type: "page", url: "about:blank" },
    });

    await vi.waitFor(() =>
      expect(
        socket.sent.filter(
          (message) =>
            message.method === "Runtime.runIfWaitingForDebugger" &&
            message.sessionId === "startup-gap-session",
        ),
      ).toHaveLength(2),
    );
    expect(failures).toEqual([]);
    await guard.stop();
  });

  it("does not recycle the browser tunnel when one existing renderer bootstrap fails", async () => {
    const failures: Error[] = [];
    const socket = new FakeBrowserSocket(
      [{ targetId: "busy-page", type: "page", url: "https://chatgpt.com/c/busy" }],
      {
        "Page.addScriptToEvaluateOnNewDocument": {
          code: -32_000,
          message: "renderer is busy",
        },
      },
    );
    const guard = new OracleApprovalOwnershipGuard({
      endpoint: "http://127.0.0.1:9222",
      websocketFactory: () => socket,
      fetch: browserVersionFetch(),
      onUnhealthy: (error) => {
        failures.push(error);
      },
    });

    const started = guard.start();
    socket.open();
    await expect(started).resolves.toBeUndefined();
    await vi.waitFor(() =>
      expect(
        socket.sent.some((message) => message.method === "Page.addScriptToEvaluateOnNewDocument"),
      ).toBe(true),
    );
    expect(failures).toEqual([]);
    await guard.stop();
  });

  it("waits for browser open without the former implicit five-second timeout", async () => {
    const socket = new FakeBrowserSocket();
    const guard = new OracleApprovalOwnershipGuard({
      endpoint: "http://127.0.0.1:9222",
      websocketFactory: () => socket,
      fetch: browserVersionFetch(),
    });
    const started = guard.start();
    let settled = false;
    void started.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(5_001);
      expect(settled).toBe(false);
      socket.open();
      await started;
      await guard.stop();
    } finally {
      vi.useRealTimers();
      await guard.stop();
    }
  });

  it("accepts a browser frame above the former one-million-byte internal cap", async () => {
    const socket = new FakeBrowserSocket();
    const guard = new OracleApprovalOwnershipGuard({
      endpoint: "http://127.0.0.1:9222",
      websocketFactory: () => socket,
      fetch: browserVersionFetch(),
    });
    const started = guard.start();
    socket.open();
    await started;

    socket.event("Runtime.consoleAPICalled", { payload: "x".repeat(1_000_001) });
    await guard.stop();
    expect(socket.sent).toContainEqual(
      expect.objectContaining({
        method: "Target.setAutoAttach",
        params: expect.objectContaining({ autoAttach: false }),
      }),
    );
  });

  it("enforces only an explicit browser-frame budget and preserves the complete frame", async () => {
    const failures: Error[] = [];
    const socket = new FakeBrowserSocket();
    const guard = new OracleApprovalOwnershipGuard({
      endpoint: "http://127.0.0.1:9222",
      websocketFactory: () => socket,
      fetch: browserVersionFetch(),
      maxFrameBytes: 128,
      onUnhealthy: (error) => {
        failures.push(error);
      },
    });
    const started = guard.start();
    socket.open();
    await started;

    const completeFrame = "x".repeat(129);
    socket.raw(completeFrame);
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(failures[0]).toBeInstanceOf(CdpFrameError);
    expect(failures[0]).toMatchObject({
      message: "CDP_BROWSER_FRAME_OVERSIZED",
      payload: completeFrame,
    });
  });

  it("rejects a non-object browser frame without discarding its parsed payload", async () => {
    const failures: Error[] = [];
    const socket = new FakeBrowserSocket();
    const guard = new OracleApprovalOwnershipGuard({
      endpoint: "http://127.0.0.1:9222",
      websocketFactory: () => socket,
      fetch: browserVersionFetch(),
      onUnhealthy: (error) => {
        failures.push(error);
      },
    });
    const started = guard.start();
    socket.open();
    await started;

    socket.raw('"primitive-frame"');
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(failures[0]).toBeInstanceOf(CdpFrameError);
    expect(failures[0]).toMatchObject({
      message: "CDP_BROWSER_FRAME_SHAPE_INVALID",
      payload: "primitive-frame",
    });
  });

  it("preserves the browser CDP error code, message, data, cause, and payload", async () => {
    const payload = {
      code: -32_002,
      message: `inventory failed\n${"detail".repeat(1_000)}`,
      data: { target: "exact-browser", retryable: false },
    };
    const socket = new FakeBrowserSocket([], { "Target.getTargets": payload });
    const guard = new OracleApprovalOwnershipGuard({
      endpoint: "http://127.0.0.1:9222",
      websocketFactory: () => socket,
      fetch: browserVersionFetch(),
      timeoutMs: 30_001,
    });
    const started = guard.start();
    socket.open();
    const error = await started.catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(CdpProtocolError);
    expect(error).toMatchObject({
      message: `Target.getTargets: ${payload.message}`,
      code: payload.code,
      data: payload.data,
      payload,
      cause: payload,
    });
  });

  it("reports one unhealthy transition when the browser-target socket dies", async () => {
    const socket = new FakeBrowserSocket();
    const failures: string[] = [];
    const guard = new OracleApprovalOwnershipGuard({
      endpoint: "http://127.0.0.1:9222",
      websocketFactory: () => socket,
      fetch: async () =>
        new Response(
          JSON.stringify({
            Browser: "Chrome/151.0.0.0",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/exact-browser",
          }),
          { status: 200 },
        ),
      onUnhealthy: (error) => {
        failures.push(error.message);
      },
    });

    const started = guard.start();
    socket.open();
    await started;
    socket.fail();
    socket.fail();
    await Promise.resolve();
    expect(failures).toEqual(["CDP browser socket failed"]);
  });
});

interface SentCommand {
  readonly id: number;
  readonly method: string;
  readonly params: unknown;
  readonly sessionId?: string;
}

class FakeBrowserSocket implements CdpWebSocketLike {
  readyState = 0;
  readonly sent: SentCommand[] = [];
  readonly #listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  readonly #targets: readonly Record<string, unknown>[];
  readonly #errors: Readonly<Record<string, unknown | readonly unknown[]>>;
  readonly #errorAttempts = new Map<string, number>();

  constructor(
    targets: readonly Record<string, unknown>[] = [],
    errors: Readonly<Record<string, unknown | readonly unknown[]>> = {},
  ) {
    this.#targets = targets;
    this.#errors = errors;
  }

  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void,
  ): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  send(data: string): void {
    const command = JSON.parse(data) as SentCommand;
    this.sent.push(command);
    queueMicrotask(() => {
      const configuredError = this.#errors[command.method];
      const attempt = this.#errorAttempts.get(command.method) ?? 0;
      this.#errorAttempts.set(command.method, attempt + 1);
      const error = Array.isArray(configuredError) ? configuredError[attempt] : configuredError;
      if (error !== undefined) {
        this.#emit("message", { data: JSON.stringify({ id: command.id, error }) });
      } else if (command.method === "Target.getTargets") {
        this.#respond(command.id, { targetInfos: this.#targets });
      } else if (command.method === "Target.attachToTarget") {
        const targetId = (command.params as { targetId: string }).targetId;
        this.#respond(command.id, { sessionId: `session-${targetId}` });
      } else {
        this.#respond(command.id, {});
      }
    });
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#emit("close", {});
  }

  open(): void {
    this.readyState = 1;
    this.#emit("open", {});
  }

  event(method: string, params: unknown): void {
    this.#emit("message", { data: JSON.stringify({ method, params }) });
  }

  raw(data: unknown): void {
    this.#emit("message", { data });
  }

  fail(): void {
    this.#emit("error", {});
  }

  async waitForMethod(method: string, sessionId?: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        this.sent.some((message) => message.method === method && message.sessionId === sessionId)
      ) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`Timed out waiting for ${method}`);
  }

  #respond(id: number, result: unknown): void {
    this.#emit("message", { data: JSON.stringify({ id, result }) });
  }

  #emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

function browserVersionFetch(): typeof globalThis.fetch {
  return async () =>
    new Response(
      JSON.stringify({
        Browser: "Chrome/151.0.0.0",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/exact-browser",
      }),
      { status: 200 },
    );
}
