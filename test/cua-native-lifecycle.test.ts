import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import {
  type BrowserNativeCallContext,
  BrowserNativeExecutor,
} from "../src/application/browser-native-executor.js";
import { ChatGptBrowserActivityCoordinator } from "../src/application/chatgpt-browser-activity-coordinator.js";
import { CodeModeNativeToolSurface } from "../src/application/code-mode-native-tool-surface.js";
import { NativeToolExecutor } from "../src/application/native-tool-catalog.js";
import { OmniCodexSessionExecutorPool } from "../src/application/omnicodex-gateway-service.js";
import { DirectGoalStore } from "../src/infrastructure/mcp/direct-goal-store.js";
import { LegacyMutationCoordinator } from "../src/infrastructure/mcp/legacy-mutation-coordinator.js";
import { MutationReplayStore } from "../src/infrastructure/mcp/mutation-replay-store.js";
import { createOmniCodexMcpServer } from "../src/infrastructure/mcp/omnicodex-mcp-server.js";

const conversationId = "11111111-1111-4111-8111-111111111111";
const context: BrowserNativeCallContext = {
  ownerBinding: "owner",
  workSessionBinding: "work-session",
  callerSessionId: "transport",
  callerProvenance: "chatgpt_conversation",
  chatGptConversationId: conversationId,
};
const tool = {
  name: "js",
  inputSchema: { type: "object" as const, properties: { code: { type: "string" } } },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omnicodex-cua-lifecycle-"));
  const protectedRoot = join(root, "protected-confirmation-docs");
  await mkdir(protectedRoot, { recursive: true });
  await Promise.all(
    (
      [
        ["tinysky-alt-confirmations.md", "# Confirmations\n"],
        ["browser-safety-training.md", "# Browser Safety\n"],
        ["computer-use-guidance.md", "# Computer Use\n"],
      ] as const
    ).map(([name, content]) => writeFile(join(protectedRoot, name), content, "utf8")),
  );
  const callInContext = vi.fn(async (..._args: unknown[]) => ({
    content: [{ type: "text", text: "ok" }],
  }));
  const browser = new BrowserNativeExecutor({ callInContext }, { codexHome: root });
  const coordinator = new ChatGptBrowserActivityCoordinator({
    readActiveConversationIds: async () => [conversationId],
  });
  return { root, callInContext, browser, coordinator };
}

describe("CUA native activity lifetime", () => {
  it("re-registers a reset CUA kernel and retains cleanup when the state readback is invalid", async () => {
    const f = await fixture();
    await f.browser.callCua(
      "cua_repl",
      "js_reset",
      {},
      { ...context, activityBinding: "activity" },
    );
    // A successful outer MCP result without a valid state must not erase ownership.
    await expect(f.browser.finishActivity("activity", context)).rejects.toThrow(
      "Browser activity cleanup failed",
    );
    expect(f.browser.hasPendingActivities).toBe(true);
    expect(f.callInContext.mock.calls.map((args) => args[1])).toEqual(["js_reset", "js"]);
    f.callInContext.mockResolvedValueOnce({
      content: [
        { type: "text", text: JSON.stringify({ browsers: [{ id: "1", type: "extension" }] }) },
      ],
    });
    await f.browser.finishActivity("activity", context);
    expect(f.callInContext.mock.calls.map((args) => args[1])).toEqual([
      "js_reset",
      "js",
      "js",
      "turn_ended",
    ]);
    expect(f.browser.hasPendingActivities).toBe(false);
    await f.coordinator.close();
  });

  it("keeps direct and nested CUA calls in one work-session activity until real completion", async () => {
    const f = await fixture();
    const call = () =>
      f.coordinator.runWithActivity(f.browser, context, (current) =>
        f.browser.callCua("cua_repl", "js", { code: "await cua.getState();" }, current),
      );
    await call();
    const surface = new CodeModeNativeToolSurface({
      directGoalStore: DirectGoalStore.inMemory(),
      mutationReplayStore: MutationReplayStore.inMemory(),
      hostTools: { tools: [], callDynamic: async () => ({ success: true, contentItems: [] }) },
      appServerMethodCatalog: {
        snapshot: { refreshedAtUnixMs: 1, schemaDigest: "schema", methods: [] },
      },
      appServerMethodExecutor: { call: async () => undefined },
      browserNativeExecutor: f.browser,
      browserActivityCoordinator: f.coordinator,
      browserCallContext: () => context,
      downstreamToolCatalog: {
        snapshot: {
          refreshedAtUnixMs: 1,
          servers: ["cua_repl"],
          tools: [
            { exposedName: "codex__cua_repl__js", server: "cua_repl", originalName: "js", tool },
            {
              exposedName: "codex__cua_repl__turn_ended",
              server: "cua_repl",
              originalName: "turn_ended",
              tool: { ...tool, name: "turn_ended" },
            },
          ],
        },
      },
      downstreamToolExecutor: {
        callInContext: async () => {
          throw new Error("untracked dispatch");
        },
      },
    });
    expect(
      (
        await surface.callDynamic({
          tool: "codex__cua_repl__js",
          arguments: { code: "await cua.getState();" },
          threadId: "responses-thread",
          turnId: "temporary-code-cell",
        })
      ).success,
    ).toBe(true);
    // A Responses code cell is not the originating ChatGPT model activity.
    await f.browser.finishActivity("turn:temporary-code-cell", context);
    await call();
    expect(f.callInContext.mock.calls.map((args) => args[1])).toEqual(["js", "js", "js"]);
    expect(new Set(f.callInContext.mock.calls.map((args) => args[5])).size).toBe(1);
    expect(f.callInContext.mock.calls.every((args) => args[7] === "work-session")).toBe(true);
    expect(f.browser.hasPendingActivities).toBe(true);
    const stopRequest = {
      callId: "explicit-stop",
      tool: "codex__cua_repl__turn_ended",
      arguments: {
        hook_event_name: "Stop",
        session_id: "another-owner",
        turn_id: "untrusted-turn",
      },
    };
    expect((await surface.callDynamic(stopRequest)).success).toBe(true);
    expect(f.callInContext.mock.calls.at(-1)).toMatchObject({
      0: "cua_repl",
      1: "turn_ended",
      2: { hook_event_name: "Stop", session_id: "work-session" },
      7: "work-session",
    });
    expect(f.browser.hasPendingActivities).toBe(false);
    await call();
    const nextActivity = f.callInContext.mock.calls.at(-1)?.[5];
    expect((await surface.callDynamic(stopRequest)).success).toBe(true);
    expect(f.callInContext.mock.calls.filter((args) => args[1] === "turn_ended")).toHaveLength(1);
    await call();
    expect(f.callInContext.mock.calls.at(-1)?.[5]).toBe(nextActivity);
    await f.coordinator.close();
  });

  it("restores only the exact CUA owner and sends completion to CUA instead of node_repl", async () => {
    const f = await fixture();
    await f.browser.callCua(
      "mcp__cua_repl",
      "js",
      { code: "await cua.getState();" },
      { ...context, activityBinding: "activity" },
    );
    await f.browser.close({ preserveActivities: true });
    const other = new BrowserNativeExecutor(
      { callInContext: f.callInContext },
      { codexHome: f.root },
    );
    await other.finishActivity("activity", { ...context, ownerBinding: "another-owner" });
    expect(f.callInContext).toHaveBeenCalledTimes(1);
    const restored = new BrowserNativeExecutor(
      { callInContext: f.callInContext },
      { codexHome: f.root },
    );
    f.callInContext.mockResolvedValueOnce({
      content: [
        { type: "text", text: JSON.stringify({ browsers: [{ id: "1", type: "extension" }] }) },
      ],
    });
    await restored.finishCurrentActivity(context);
    expect(f.callInContext.mock.calls.at(-1)).toMatchObject({
      0: "mcp__cua_repl",
      1: "turn_ended",
      2: { session_id: "work-session", turn_id: "activity" },
    });
    await restored.finishActivity("activity", context);
    expect(f.callInContext.mock.calls.filter((args) => args[1] === "turn_ended")).toHaveLength(1);
  });

  it.each(["direct", "generic"])(
    "routes %s explicit CUA Stop through the coordinator and releases opaque ownership",
    async (endingRoute) => {
      const f = await fixture();
      const appServer = {
        request: async <T>(method: string): Promise<T> => {
          if (method === "mcpServerStatus/list")
            return {
              data: [
                {
                  name: "cua_repl",
                  tools: { js: tool, turn_ended: { ...tool, name: "turn_ended" } },
                },
                { name: "node_repl", tools: { turn_ended: { ...tool, name: "turn_ended" } } },
              ],
              nextCursor: null,
            } as T;
          throw new Error(`Unexpected untracked request: ${method}`);
        },
      };
      const handle = createOmniCodexMcpServer({
        appServer,
        browserNativeExecutor: f.browser,
        browserActivityCoordinator: f.coordinator,
        surface: "full",
        correlationId: "transport",
        runtimeDispatchOnly: true,
        authorizationBinding: "owner",
        mutationReplayStore: MutationReplayStore.inMemory(),
        legacyMutationCoordinator: LegacyMutationCoordinator.inMemory(),
        resolveDurableWorkSessionBinding: () => ({
          workSessionBinding: "work-session",
          directGoalClaimantBinding: "claimant",
          directJobOwnerBinding: "job-owner",
          continuationToken: "continue",
          journalCursor: "cursor",
        }),
        resolveRequestAttribution: () => ({
          callerProvenance: "chatgpt_conversation",
          principalBindingSha256: "owner",
        }),
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "cua-lifecycle", version: "1" });
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const args = { code: "await cua.getState();" };
        const direct = await client.callTool({ name: "codex__cua_repl__js", arguments: args });
        const generic = await client.callTool({
          name: "call_native_tool",
          arguments: { name: "codex__cua_repl__js", arguments: args },
        });
        expect(direct.isError, JSON.stringify(direct)).not.toBe(true);
        expect(generic.isError, JSON.stringify(generic)).not.toBe(true);
        expect(f.callInContext).toHaveBeenCalledTimes(2);
        expect(f.callInContext.mock.calls[0]?.[5]).toBe(f.callInContext.mock.calls[1]?.[5]);
        const endingArgs = {
          hook_event_name: "Stop",
          session_id: "another-owner",
          turn_id: "arbitrary-turn",
        };
        const ended = await client.callTool(
          endingRoute === "direct"
            ? { name: "codex__cua_repl__turn_ended", arguments: endingArgs }
            : {
                name: "call_native_tool",
                arguments: { name: "codex__cua_repl__turn_ended", arguments: endingArgs },
              },
        );
        expect(ended.isError, JSON.stringify(ended)).not.toBe(true);
        expect(f.callInContext.mock.calls.at(-1)?.[1]).toBe("turn_ended");
        expect(f.callInContext.mock.calls.at(-1)?.[2]).toMatchObject({
          session_id: "work-session",
          turn_id: f.callInContext.mock.calls[0]?.[5],
        });
        expect(f.browser.hasPendingActivities).toBe(false);
        await client.callTool({ name: "codex__cua_repl__js", arguments: args });
        expect(f.callInContext.mock.calls.at(-1)?.[5]).not.toBe(f.callInContext.mock.calls[0]?.[5]);
        await f.coordinator.close();
      } finally {
        await client.close();
        await handle.server.close();
      }
    },
  );

  it("keeps the native kernel during a CUA activity and retires it after completion", async () => {
    const f = await fixture();
    let retired = 0;
    const native = new NativeToolExecutor(
      { request: async <T>() => ({ content: [] }) as T },
      { ensureThread: async () => "owned" },
    );
    const pool = new OmniCodexSessionExecutorPool({
      nativeContextIdleMs: 5,
      createNativeRuntime: async () => ({
        nativeToolExecutor: native,
        close: async () => {
          retired += 1;
        },
      }),
      createBrowserNativeExecutor: (_context, executor) =>
        new BrowserNativeExecutor(executor, { codexHome: f.root }),
      createResponsesRuntime: async (_context, _executor, _signal, browser) => {
        expect(browser).toBeDefined();
        return {
          call: async () => {
            throw new Error("unused Responses call");
          },
          close: async () => undefined,
        };
      },
    });
    const session = pool.createSessionExecutors({
      identity: { subject: "s", issuer: "issuer", clientId: "client", resource: "resource" },
      authorizationBinding: "owner",
      correlationId: "transport",
      resolveWorkSessionBinding: () => "work-session",
    });
    const browser = session.browserNativeExecutor;
    if (browser?.callCua === undefined || browser.finishActivity === undefined)
      throw new Error("Missing CUA lifecycle executor");
    await browser.callCua("cua_repl", "js", {}, { ...context, activityBinding: "activity" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(retired).toBe(0);
    await browser.finishActivity("activity", context);
    await vi.waitFor(() => expect(retired).toBe(1));
    await pool.close();
  });
});

describe("CUA activity past the pending-activity bound", () => {
  it("frees the native kernel without aborting the activity and resumes it in a fresh kernel", async () => {
    const f = await fixture();
    let created = 0;
    let retired = 0;
    const native = new NativeToolExecutor(
      { request: async <T>() => ({ content: [] }) as T },
      { ensureThread: async () => "owned" },
    );
    const pool = new OmniCodexSessionExecutorPool({
      nativeContextIdleMs: 5,
      nativeContextPendingActivityMaxIdleMs: 30,
      createNativeRuntime: async () => {
        created += 1;
        return {
          nativeToolExecutor: native,
          close: async () => {
            retired += 1;
          },
        };
      },
      createBrowserNativeExecutor: (_context, executor) =>
        new BrowserNativeExecutor(executor, { codexHome: f.root }),
      createResponsesRuntime: async () => ({
        call: async () => {
          throw new Error("unused Responses call");
        },
        close: async () => undefined,
      }),
    });
    const session = pool.createSessionExecutors({
      identity: { subject: "s", issuer: "issuer", clientId: "client", resource: "resource" },
      authorizationBinding: "owner",
      correlationId: "transport",
      resolveWorkSessionBinding: () => "work-session",
    });
    const browser = session.browserNativeExecutor;
    if (browser?.callCua === undefined || browser.finishActivity === undefined)
      throw new Error("Missing CUA lifecycle executor");
    const live = { ...context, activityBinding: "activity" };

    await browser.callCua("cua_repl", "js", {}, live);
    // The turn is still open but silent for longer than the bound.
    await vi.waitFor(() => expect(retired).toBe(1));
    expect(created).toBe(1);
    // The open activity was persisted for adoption, not settled as aborted.
    const ledger = await readdir(join(f.root, "omnicodex", "browser-rollout-sessions"));
    expect(ledger.some((name) => name.startsWith("activity-"))).toBe(true);

    // The same turn continues: the activity is adopted and the kernel is recreated.
    await expect(browser.callCua("cua_repl", "js", {}, live)).resolves.toBeDefined();
    expect(created).toBe(2);
    await browser.finishActivity("activity", context);
    await vi.waitFor(() => expect(retired).toBe(2));
    await pool.close();
  });
});
