import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserNativeContextBoundary,
  BrowserNativeContextRequest,
} from "../src/application/browser-native-executor.js";
import type { CodexAppHostToolExecutorOptions } from "../src/application/codex-app-host-tool-executor.js";
import type { RuntimeCandidate } from "../src/domain/runtime.js";
import { DesktopChatApiClient } from "../src/infrastructure/chatgpt/desktop-chat-api-client.js";
import { DesktopChatConversationSources } from "../src/infrastructure/windows/desktop-chat-completion.js";
import * as nativeSender from "../src/infrastructure/windows/desktop-chat-native-sender.js";

const harness = vi.hoisted(() => ({
  appServerCalls: [] as Array<{
    method: string;
    params: unknown;
    timeoutMs: number | undefined;
  }>,
  browserRequests: [] as BrowserNativeContextRequest[],
  browserBoundaries: [] as Array<BrowserNativeContextBoundary | undefined>,
  desktopOwnerCalls: [] as Array<{
    threadId: string;
    options: unknown;
  }>,
  resolveContextThreadId: undefined as
    | ((
        request: BrowserNativeContextRequest,
        boundary?: BrowserNativeContextBoundary,
      ) => Promise<string | undefined>)
    | undefined,
  globalContextPromise: undefined as
    | Promise<readonly [string | undefined, string | undefined]>
    | undefined,
  browserRolloutSessionsRoot: undefined as string | undefined,
  allowBrowserConstruction: false,
  skipGlobalContext: false,
  lifecycleEvents: [] as string[],
  coordinateChat: undefined as CodexAppHostToolExecutorOptions["coordinateNativeChatRequest"],
}));

vi.mock("../src/application/codex-app-host-tool-executor.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/application/codex-app-host-tool-executor.js")>();
  return {
    ...original,
    CodexAppHostToolExecutor: class extends original.CodexAppHostToolExecutor {
      constructor(...args: ConstructorParameters<typeof original.CodexAppHostToolExecutor>) {
        super(...args);
        harness.coordinateChat = args[1]?.coordinateNativeChatRequest;
      }
    },
  };
});

vi.mock("../src/application/codex-browser-context-resolver.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/application/codex-browser-context-resolver.js")>();
  return {
    ...original,
    createCodexBrowserContextResolver: (
      ...args: Parameters<typeof original.createCodexBrowserContextResolver>
    ) => {
      const resolve = original.createCodexBrowserContextResolver(...args);
      return (request?: BrowserNativeContextRequest, boundary?: BrowserNativeContextBoundary) => {
        if (request !== undefined) harness.browserRequests.push(request);
        harness.browserBoundaries.push(boundary);
        return resolve(request, boundary);
      };
    },
  };
});

vi.mock("../src/application/browser-native-executor.js", () => ({
  BrowserNativeExecutor: class BrowserNativeExecutor {
    constructor(
      _nativeExecutor: unknown,
      options: {
        browserRolloutSessionsRoot?: string;
        resolveContextThreadId?: (
          request: BrowserNativeContextRequest,
          boundary?: BrowserNativeContextBoundary,
        ) => Promise<string | undefined>;
      },
    ) {
      harness.browserRolloutSessionsRoot = options.browserRolloutSessionsRoot;
      harness.resolveContextThreadId = options.resolveContextThreadId;
      if (options.resolveContextThreadId !== undefined && !harness.skipGlobalContext) {
        harness.globalContextPromise = Promise.all([
          options.resolveContextThreadId({ operation: "list_surfaces" }),
          options.resolveContextThreadId({ operation: "exec", surface: "chrome" }),
        ]);
      }
      if (!harness.allowBrowserConstruction) throw new Error("BROWSER_WIRING_CAPTURED");
    }

    async close() {
      harness.lifecycleEvents.push("browser:close");
    }
  },
}));

vi.mock("../src/application/code-mode-native-tool-surface.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/application/code-mode-native-tool-surface.js")>();
  return {
    ...original,
    CodeModeNativeToolSurface: class extends original.CodeModeNativeToolSurface {
      constructor(...args: ConstructorParameters<typeof original.CodeModeNativeToolSurface>) {
        super(...args);
        if (harness.allowBrowserConstruction) throw new Error("FAILURE_AFTER_BROWSER_CREATION");
      }
    },
  };
});

vi.mock("../src/application/responses-runtime-executor.js", () => ({
  OMNICODEX_LOOPBACK_PROVIDER_ID: "omnicodex_loopback",
  ResponsesRuntimeExecutor: class ResponsesRuntimeExecutor {
    async prepare() {
      return {
        configOverrides: [] as string[],
        env: {} as NodeJS.ProcessEnv,
        onNotification: () => undefined,
      };
    }

    async stop() {}
  },
}));

vi.mock("../src/infrastructure/runtime/codex-app-server-process.js", () => ({
  CodexAppServerProcess: class CodexAppServerProcess {
    readonly client = {
      request: async <T>(method: string, params: unknown, timeoutMs?: number): Promise<T> => {
        harness.appServerCalls.push({ method, params, timeoutMs });
        if (method !== "thread/list") throw new Error(`unexpected App Server request: ${method}`);
        return {
          data: [{ id: "not-loaded" }, { id: "desktop-global-host" }],
          nextCursor: null,
        } as T;
      },
      subscribeNotifications: () => () => undefined,
    };

    async start() {}

    async stop() {
      harness.lifecycleEvents.push("app-server:stop");
    }
  },
}));

vi.mock("../src/infrastructure/runtime/codex-app-server-connection.js", async () => {
  const { CodexAppServerProcess } = await import(
    "../src/infrastructure/runtime/codex-app-server-process.js"
  );
  return { CodexAppServerConnection: CodexAppServerProcess };
});

vi.mock("../src/infrastructure/runtime/codex-detached-thread-client.js", () => ({
  CodexDetachedThreadClient: class CodexDetachedThreadClient {
    async dispose() {}
  },
}));

vi.mock("../src/infrastructure/windows/codex-desktop-ipc-client.js", () => ({
  CodexDesktopIpcClient: class CodexDesktopIpcClient {
    async findThreadOwner(threadId: string, options?: unknown): Promise<string | null> {
      harness.desktopOwnerCalls.push({ threadId, options });
      return threadId === "iab-exact-task" || threadId === "desktop-global-host"
        ? `window:${threadId}`
        : null;
    }

    dispose() {}
  },
}));

import { OmniCodexGatewayService } from "../src/application/omnicodex-gateway-service.js";

const candidate: RuntimeCandidate = {
  executablePath: "C:\\Codex\\browser-wiring\\codex.exe",
  canonicalPath: "C:\\Codex\\browser-wiring\\codex.exe",
  source: "managed_install",
  buildSha256: "b".repeat(64),
};

describe("OmniCodex Gateway browser resolver wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    harness.appServerCalls.length = 0;
    harness.browserRequests.length = 0;
    harness.browserBoundaries.length = 0;
    harness.desktopOwnerCalls.length = 0;
    harness.resolveContextThreadId = undefined;
    harness.globalContextPromise = undefined;
    harness.browserRolloutSessionsRoot = undefined;
    harness.allowBrowserConstruction = false;
    harness.skipGlobalContext = false;
    harness.lifecycleEvents.length = 0;
    harness.coordinateChat = undefined;
  });

  it.each(["unavailable", "ready", "dispatch failure", "wrong account"])(
    "routes Chat sends without requiring desktop debug: %s",
    async (state) => {
      vi.stubEnv("OMNICODEX_DATA_DIR", await mkdtemp(join(tmpdir(), "omnicodex-browser-wiring-")));
      harness.skipGlobalContext = true;
      vi.spyOn(DesktopChatConversationSources.prototype, "isChatConversation").mockResolvedValue(
        true,
      );
      vi.spyOn(DesktopChatConversationSources.prototype, "hasConversationSource").mockResolvedValue(
        state !== "wrong account",
      );
      vi.spyOn(DesktopChatApiClient.prototype, "readPrincipal").mockResolvedValue({
        accountId: "routing-test",
        userId: "user",
      });
      const renderer = vi
        .spyOn(nativeSender, "sendDesktopChatNativeMessage")
        .mockRejectedValue(new Error("dispatch result unknown"));
      if (state === "ready")
        renderer.mockResolvedValue({
          threadId: "chat",
          accepted: true,
          clientUserMessageId: "native-id",
        });
      const perform = vi.fn(async () => ({ success: true, contentItems: [] }));
      const service = new OmniCodexGatewayService({
        authorize: () => ({ ok: false, status: 401 }),
        discovery: { discover: async () => ({ candidates: [candidate], warnings: [] }) },
        appToolsClientFactory: () => ({
          callTool: async () => ({ success: true, contentItems: [] }),
          close: () => undefined,
          listTools: async () => [],
        }),
        modelMetadataSource: {
          read: async () => ({
            rawModel: { slug: "gpt-5.6-sol" },
            modelDigest: "m".repeat(64),
            cachePath: "unused",
          }),
        },
        runtimeObservationMs: 0,
        runtimeEnvironment: async () => ({ CODEX_HOME: "C:\\CodexHome\\OmniCodex" }),
        evaluateDesktopNativeSend: async () => {
          throw new Error("DESKTOP_CHAT_RUNTIME_NOT_READY");
        },
        isDesktopNativeSendReady: () => state === "ready" || state === "dispatch failure",
      });
      await expect(service.start()).rejects.toThrow("BROWSER_WIRING_CAPTURED");
      const coordinate = harness.coordinateChat;
      if (!coordinate) throw new Error("Chat coordinator was not wired");
      const call = coordinate(
        "codex_app",
        "send_message_to_thread",
        { threadId: "chat", prompt: "continue" },
        {},
        perform,
      );
      if (state === "wrong account") {
        await expect(call).rejects.toThrow("DESKTOP_CHAT_ACCOUNT_CHANGED");
      } else if (state === "dispatch failure") {
        await expect(call).rejects.toThrow("dispatch result unknown");
      } else {
        await expect(call).resolves.toMatchObject({ success: true });
      }
      expect(perform).toHaveBeenCalledTimes(state === "unavailable" ? 1 : 0);
      expect(renderer).toHaveBeenCalledTimes(
        state === "ready" || state === "dispatch failure" ? 1 : 0,
      );
    },
  );

  it("retires an already-created shared browser before the App Server after startup failure", async () => {
    harness.allowBrowserConstruction = true;
    const service = new OmniCodexGatewayService({
      authorize: () => ({ ok: false, status: 401 }),
      discovery: { discover: async () => ({ candidates: [candidate], warnings: [] }) },
      appToolsClientFactory: () => ({
        callTool: async () => ({ success: true, contentItems: [] }),
        close: () => undefined,
        listTools: async () => [],
      }),
      modelMetadataSource: {
        read: async () => ({
          rawModel: { slug: "gpt-5.6-sol" },
          modelDigest: "m".repeat(64),
          cachePath: "C:\\CodexHome\\OmniCodex\\models_cache.json",
        }),
      },
      runtimeObservationMs: 0,
      runtimeEnvironment: async () => ({ CODEX_HOME: "C:\\CodexHome\\OmniCodex" }),
    });
    await expect(service.start()).rejects.toThrow("FAILURE_AFTER_BROWSER_CREATION");
    expect(harness.lifecycleEvents).toEqual(["browser:close", "app-server:stop"]);
  });

  it("preserves exact bound IAB identity while Chrome and list use the Work executor", async () => {
    vi.stubEnv("CODEX_SESSION_ID", "");
    vi.stubEnv("CODEX_THREAD_ID", "");
    const service = new OmniCodexGatewayService({
      authorize: () => ({ ok: false, status: 401 }),
      discovery: {
        discover: async () => ({ candidates: [candidate], warnings: [] }),
      },
      appToolsClientFactory: () => ({
        callTool: async () => ({ success: true, contentItems: [] }),
        close: () => undefined,
        listTools: async () => [],
      }),
      nonInterferenceBoundary: {
        capture: async () => ({
          observation: {
            observedAtUnixMs: 1,
            protectedFiles: [],
            desktopProcesses: [],
            loginContinuity: "authenticated",
            appUsability: "usable",
          },
        }),
        assertUnchanged: async (snapshot) => snapshot,
      },
      modelMetadataSource: {
        read: async () => ({
          rawModel: { slug: "gpt-5.6-sol" },
          modelDigest: "m".repeat(64),
          cachePath: "C:\\CodexHome\\OmniCodex\\models_cache.json",
        }),
      },
      runtimeObservationMs: 0,
      runtimeEnvironment: async () => ({ CODEX_HOME: "C:\\CodexHome\\OmniCodex" }),
    });

    await expect(service.start()).rejects.toThrow("BROWSER_WIRING_CAPTURED");
    const resolveContextThreadId = harness.resolveContextThreadId;
    expect(resolveContextThreadId).toBeTypeOf("function");
    expect(harness.browserRolloutSessionsRoot).toBe(
      resolve("C:\\CodexHome\\OmniCodex", "sessions"),
    );
    if (resolveContextThreadId === undefined) throw new Error("browser resolver was not wired");
    await expect(harness.globalContextPromise).resolves.toEqual([undefined, undefined]);
    expect(harness.appServerCalls).toHaveLength(0);
    expect(harness.desktopOwnerCalls).toEqual([]);

    const exactRequest: BrowserNativeContextRequest = {
      operation: "exec",
      surface: "iab",
      contextThreadId: "iab-exact-task",
      ownerBinding: "authenticated-owner",
      workSessionBinding: "durable-work-session",
    };
    const controller = new AbortController();
    const deadlineUnixMs = Date.now() + 60_000;
    await expect(
      resolveContextThreadId(exactRequest, { signal: controller.signal, deadlineUnixMs }),
    ).resolves.toBe("iab-exact-task");
    expect(harness.browserRequests.slice(-1)).toEqual([exactRequest]);
    expect(harness.browserBoundaries.slice(-1)).toEqual([
      { signal: controller.signal, deadlineUnixMs },
    ]);
    expect(harness.desktopOwnerCalls.slice(-1)).toEqual([
      {
        threadId: "iab-exact-task",
        options: { hostId: "local", signal: controller.signal, deadlineUnixMs },
      },
    ]);

    await expect(
      resolveContextThreadId({ operation: "exec", surface: "iab" }),
    ).resolves.toBeUndefined();
    expect(harness.appServerCalls).toHaveLength(0);
  });
});
