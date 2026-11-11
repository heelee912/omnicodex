import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, Server as NodeHttpServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  Client as ModernMcpClient,
  StreamableHTTPClientTransport as ModernStreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { AppServerMethodCatalog } from "../src/application/app-server-method-catalog.js";
import { CodexAppHostToolExecutor } from "../src/application/codex-app-host-tool-executor.js";
import {
  type NativeExecutionRequest,
  type NativeExecutionRequestContext,
  NativeExecutionScheduler,
} from "../src/application/native-execution-scheduler.js";
import {
  type AppServerRpcClient,
  NativeToolCatalog,
} from "../src/application/native-tool-catalog.js";
import {
  ResponsesNativeToolCatalog,
  ResponsesNativeToolExecutor,
} from "../src/application/responses-native-tool-catalog.js";
import {
  type DirectJobDispatchAdapter,
  type DirectJobDispatchOutcome,
  DirectJobManager,
} from "../src/infrastructure/mcp/direct-job-mcp-tools.js";
import { DirectJobStore } from "../src/infrastructure/mcp/direct-job-store.js";
import { DirectScheduleManager } from "../src/infrastructure/mcp/direct-schedule-mcp-tools.js";
import { DirectScheduleStore } from "../src/infrastructure/mcp/direct-schedule-store.js";
import {
  DurableMcpEventStore,
  type DurableMcpEventStoreOptions,
} from "../src/infrastructure/mcp/durable-mcp-event-store.js";
import { DurableWorkSessionStore } from "../src/infrastructure/mcp/durable-work-session-store.js";
import {
  type McpMutationReplayObservation,
  type McpProgressObservation,
  type McpReadInvocationObservation,
  type McpResultDeliveryObservation,
  type McpToolCatalogObservation,
  type NativeToolExecutionObservation,
  OMNICODEX_FULL_CATALOG_PRIORITY,
} from "../src/infrastructure/mcp/omnicodex-mcp-server.js";
import { OwnerBoundResourceStore } from "../src/infrastructure/mcp/owner-bound-resource-store.js";
import {
  PROTECTED_RESULT_HANDLE_PREFIX,
  PROTECTED_RESULT_READ_TOOL,
} from "../src/infrastructure/mcp/protected-result-mapper.js";
import {
  awaitFiniteMcpPostSettlement,
  DeferredDurableMcpEventStore,
  type DurableMcpEventStoreFactory,
  type HttpAuthorizationDecision,
  type HttpAuthorizationIdentity,
  type McpSessionExecutorContext,
  StreamableHttpGateway,
  type StreamableHttpGatewayOptions,
  type StreamableHttpGatewayRequestObservation,
  writeServerResponseWithBackpressure,
} from "../src/infrastructure/mcp/streamable-http-gateway.js";

const metadata = {
  resource: "https://owner.example/native",
  authorization_servers: ["https://owner.us.auth0.com/"],
  scopes_supported: ["omnicodex:full"],
  bearer_methods_supported: ["header"],
};

describe("StreamableHttpGateway", () => {
  it("resolves an explicit Goal through authenticated HTTP conversation bindings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnicodex-http-goal-target-"));
    const workSessions = await DurableWorkSessionStore.open({ dataDirectory: directory });
    const fixture = fakeAppServer();
    const gateway = gatewayFor(fixture.appServer, { durableWorkSessionStore: workSessions });
    const address = await gateway.start();
    const url = `http://${address.host}:${address.port}${address.fullPath}`;
    const first = new TestMcpClient(url, "owner");
    const second = new TestMcpClient(url, "owner-rotated-client");
    const other = new TestMcpClient(url, "other");
    const call = (
      client: TestMcpClient,
      session: string,
      action: string,
      args: Record<string, unknown> = {},
    ) =>
      client.request("tools/call", {
        name: `omnicodex__goal_${action}`,
        arguments: args,
        _meta: { "openai/session": session },
      });
    const content = (result: unknown) => {
      expect(isObject(result) && result.isError, JSON.stringify(result)).not.toBe(true);
      if (!isObject(result) || !isObject(result.structuredContent)) throw new Error("missing Goal");
      return result.structuredContent;
    };
    try {
      await Promise.all([first.connect(), second.connect(), other.connect()]);
      const firstGoal = content(
        await call(first, "first-chat", "create", { objective: "First Goal" }),
      );
      const secondGoal = content(
        await call(second, "second-chat", "create", { objective: "Second Goal" }),
      );
      const goalId = firstGoal.id;
      expect(content(await call(second, "second-chat", "get", { goalId })).id).toBe(goalId);
      expect(
        content(await call(second, "second-chat", "update", { goalId, status: "paused" })),
      ).toMatchObject({ id: goalId, state: "paused" });
      expect(content(await call(first, "first-chat", "get"))).toMatchObject({
        id: goalId,
        state: "paused",
      });
      expect(content(await call(second, "second-chat", "get"))).toEqual(secondGoal);
      const denied = await call(other, "other-chat", "get", { goalId });
      expect(denied).toMatchObject({ isError: true });
      expect(JSON.stringify(denied)).not.toContain("First Goal");
      const deleted = content(await call(second, "second-chat", "delete", { goalId }));
      expect(deleted).toMatchObject({ goalId, deleted: true });
      expect(content(await call(second, "second-chat", "delete", { goalId }))).toEqual(deleted);
      expect(await call(first, "first-chat", "get")).toMatchObject({ isError: true });
      expect(content(await call(second, "second-chat", "get"))).toEqual(secondGoal);
    } finally {
      await Promise.allSettled([first.close(), second.close(), other.close()]);
      await gateway.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serves pinned 2026-07-28 clients without a rejected legacy fallback", async () => {
    const fixture = fakeAppServer();
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-modern-protocol-"));
    const workSessions = await DurableWorkSessionStore.open({
      dataDirectory,
      hmacKey: Buffer.alloc(32, 47),
    });
    const gateway = gatewayFor(fixture.appServer, {
      durableWorkSessionStore: workSessions,
    });
    const address = await gateway.start();
    const client = new ModernMcpClient(
      { name: "omnicodex-modern-test", version: "1.0.0" },
      {
        capabilities: {},
        versionNegotiation: { mode: { pin: "2026-07-28" } },
      },
    );
    const transport = new ModernStreamableHTTPClientTransport(
      new URL(`http://${address.host}:${address.port}${address.fullPath}`),
      { requestInit: { headers: { Authorization: "Bearer owner" } } },
    );
    try {
      await client.connect(transport);
      expect(client.getInstructions()).toBeUndefined();
      const toolNames: string[] = [];
      let cursor: string | undefined;
      do {
        const listed = await client.listTools(cursor === undefined ? undefined : { cursor });
        toolNames.push(...listed.tools.map(({ name }) => name));
        cursor = listed.nextCursor;
      } while (cursor !== undefined);
      expect(toolNames.length).toBeGreaterThan(0);
      const result = await client.callTool({
        name: "search_native_tools",
        arguments: { query: "threads" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      const identityResult = await client.callTool({
        name: "codex__omnicodex__session_identity",
        arguments: {},
        _meta: { "io.modelcontextprotocol/related-task": { taskId: "modern-web-chat" } },
      });
      const firstIdentity = isObject(identityResult.structuredContent)
        ? identityResult.structuredContent
        : {};
      expect(firstIdentity).toMatchObject({
        workSessionBinding: expect.stringMatching(/^wsb1_/u),
        continuationToken: expect.stringMatching(/^wct1_/u),
      });
      const resumedIdentity = await client.callTool({
        name: "codex__omnicodex__session_identity",
        arguments: {},
        _meta: { "io.modelcontextprotocol/related-task": { taskId: "modern-web-chat" } },
      });
      expect(
        isObject(resumedIdentity.structuredContent) ? resumedIdentity.structuredContent : {},
      ).toMatchObject({
        workSessionBinding: firstIdentity.workSessionBinding,
        continuationToken: firstIdentity.continuationToken,
      });
    } finally {
      await client.close().catch(() => undefined);
      await gateway.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("marks a modern request transport disconnected while its mutation settles", async () => {
    const fixture = fakeAppServer();
    const scheduler = new RecordingRequestContextScheduler();
    const gateway = gatewayFor(fixture.appServer, { scheduler });
    const address = await gateway.start();
    const url = `http://${address.host}:${address.port}${address.fullPath}`;
    const client = new ModernMcpClient(
      { name: "modern-disconnect-signal", version: "1.0.0" },
      { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const transport = new ModernStreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: "Bearer owner" } },
    });
    const controller = new AbortController();

    try {
      await client.connect(transport);
      const pending = client.callTool(
        {
          name: "slow",
          arguments: { omnicodexInvocationId: "10000000-0000-4000-8000-000000000991" },
        },
        { signal: controller.signal },
      );
      await fixture.slowStarted;
      const activeContext = scheduler.contexts.at(-1);
      expect(activeContext?.transportDisconnectSignal?.aborted).toBe(false);

      controller.abort();
      await expect(pending).rejects.toThrow(/AbortError/u);
      await vi.waitFor(() => expect(activeContext?.transportDisconnectSignal?.aborted).toBe(true));
    } finally {
      fixture.releaseSlow();
      controller.abort();
      await client.close().catch(() => undefined);
      await gateway.stop(1_000);
    }
  });

  it("keeps execution scopes separate when modern requests share a trace across conversations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnicodex-modern-shared-trace-"));
    const workSessions = await DurableWorkSessionStore.open({ dataDirectory: directory });
    const scopes: McpSessionExecutorContext[] = [];
    const closed: string[] = [];
    const gateway = gatewayFor(fakeAppServer().appServer, {
      durableWorkSessionStore: workSessions,
      createSessionExecutors: (context) => {
        scopes.push(context);
        return {
          close: async () => {
            closed.push(context.correlationId);
          },
        };
      },
    });
    const address = await gateway.start();
    const client = new ModernMcpClient(
      { name: "shared-trace-conversations", version: "1.0.0" },
      { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await client.connect(
        new ModernStreamableHTTPClientTransport(
          new URL(`http://${address.host}:${address.port}${address.fullPath}`),
          {
            requestInit: {
              headers: {
                Authorization: "Bearer owner",
                traceparent: "00-1234567890abcdef1234567890abcdef-1111111111111111-01",
              },
            },
          },
        ),
      );
      const before = scopes.length;
      const bindings: string[] = [];
      for (const session of ["conversation-a", "conversation-b", "conversation-a"]) {
        const result = await client.callTool({
          name: "codex__omnicodex__session_identity",
          arguments: {},
          _meta: { "openai/session": session },
        });
        expect(result.isError).not.toBe(true);
        const identity = result.structuredContent;
        if (!isObject(identity) || typeof identity.workSessionBinding !== "string") {
          throw new Error("Expected an actual work-session identity response");
        }
        bindings.push(identity.workSessionBinding);
      }
      expect(bindings[0]).not.toBe(bindings[1]);
      expect(bindings[2]).toBe(bindings[0]);
      // Completed HTTP requests do not end the surrounding Web model turn.
      expect(gateway.observedChatGptConversationIds()).toEqual([]);
      expect(gateway.observedOpenAiWorkSessionCount()).toBe(2);
      const callScopes = scopes.slice(before);
      expect(callScopes).toHaveLength(3);
      expect(new Set(callScopes.map((scope) => scope.correlationId)).size).toBe(3);
      expect(callScopes.map((scope) => scope.resolveWorkSessionBinding?.())).toEqual(bindings);
      expect(closed).toEqual(
        expect.arrayContaining(callScopes.map((scope) => scope.correlationId)),
      );
    } finally {
      await client.close().catch(() => undefined);
      await gateway.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serves an authenticated ChatGPT tool call without a transport session or version header", async () => {
    const fixture = fakeAppServer();
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-chatgpt-stateless-"));
    const workSessions = await DurableWorkSessionStore.open({
      dataDirectory,
      hmacKey: Buffer.alloc(32, 48),
    });
    const preparedConversationUrls: string[] = [];
    const gateway = gatewayFor(fixture.appServer, {
      durableWorkSessionStore: workSessions,
      prepareChatGptConversationRequest: ({ chatGptConversationUrl }) => {
        preparedConversationUrls.push(chatGptConversationUrl);
      },
    });
    const address = await gateway.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}${address.fullPath}`, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer owner",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "chatgpt-stateless-call",
          method: "tools/call",
          params: {
            name: "search_native_tools",
            arguments: { query: "threads" },
            _meta: {
              "openai/organization": "owner-account",
              "openai/session": "6a96d948-c6f8-83e8-83c5-e265bcba2930",
              "openai/subject": "owner-subject",
            },
          },
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      const data = body
        .split(/\r?\n/u)
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length);
      if (data === undefined) throw new Error("Stateless ChatGPT call returned no SSE data");
      const payload = JSON.parse(data) as unknown;
      expect(payload).toMatchObject({
        jsonrpc: "2.0",
        id: "chatgpt-stateless-call",
        result: {
          structuredContent: {
            query: "threads",
            count: 3,
          },
        },
      });
      expect(preparedConversationUrls).toEqual([
        "https://chatgpt.com/c/6a96d948-c6f8-83e8-83c5-e265bcba2930",
      ]);
    } finally {
      await gateway.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("falls back to a fetch-safe ephemeral port when the configured loopback port is unavailable", async () => {
    const blocker = new NodeHttpServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", () => {
        blocker.removeListener("error", reject);
        resolve();
      });
    });
    const blockedAddress = blocker.address();
    if (blockedAddress === null || typeof blockedAddress === "string") {
      throw new Error("Port blocker did not receive a TCP address");
    }
    const gateway = gatewayFor(fakeAppServer().appServer, { port: blockedAddress.port });
    try {
      const address = await gateway.start();
      expect(address.host).toBe("127.0.0.1");
      expect(address.port).not.toBe(blockedAddress.port);
      await expect(
        fetch(`http://${address.host}:${address.port}/.well-known/oauth-protected-resource/native`),
      ).resolves.toMatchObject({ status: 200 });
    } finally {
      await gateway.stop();
      await new Promise<void>((resolve, reject) =>
        blocker.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it("does not accept the next SSE frame until a slow HTTP consumer drains", async () => {
    const response = new EventEmitter() as ServerResponse;
    let needsDrain = true;
    Object.defineProperties(response, {
      destroyed: { configurable: true, get: () => false },
      writableEnded: { configurable: true, get: () => false },
      writableNeedDrain: { configurable: true, get: () => needsDrain },
      write: { configurable: true, value: vi.fn(() => false) },
    });

    let settled = false;
    const writing = writeServerResponseWithBackpressure(response, "event: message\n\n").then(
      (value) => {
        settled = true;
        return value;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    needsDrain = false;
    response.emit("drain");
    await expect(writing).resolves.toBe(true);
    expect(response.write).toHaveBeenCalledTimes(1);
  });

  it("releases a finite POST after its terminal HTTP response even if the SDK handler stays pending", async () => {
    const response = new EventEmitter() as ServerResponse;
    let writableEnded = false;
    Object.defineProperties(response, {
      destroyed: { configurable: true, get: () => false },
      writableEnded: { configurable: true, get: () => writableEnded },
    });
    const neverSettles = new Promise<void>(() => undefined);
    let settled = false;
    const waiting = awaitFiniteMcpPostSettlement(response, neverSettles).then(() => {
      settled = true;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    writableEnded = true;
    response.emit("finish");
    await expect(waiting).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it("keeps a finite POST admitted when the SDK handler resolves before its SSE response", async () => {
    const response = new EventEmitter() as ServerResponse;
    let writableEnded = false;
    Object.defineProperties(response, {
      destroyed: { configurable: true, get: () => false },
      writableEnded: { configurable: true, get: () => writableEnded },
    });
    let settled = false;
    const waiting = awaitFiniteMcpPostSettlement(response, Promise.resolve()).then(() => {
      settled = true;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    writableEnded = true;
    response.emit("finish");
    await expect(waiting).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it("keeps every deferred bootstrap event by default until durable adoption", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-deferred-lossless-"));
    let now = 0;
    const staged = new DeferredDurableMcpEventStore({
      nowUnixMs: () => now,
      nonce: "lossless-bootstrap",
    });
    const first = await staged.storeEvent("stream", progressNotification("0"));
    for (let index = 1; index <= 1_024; index += 1) {
      await staged.storeEvent("stream", progressNotification(String(index)));
    }
    now = 10 * 60_000 + 1;
    const latest = await staged.storeEvent("stream", progressNotification("latest"));
    const replayed: string[] = [];
    try {
      await expect(
        staged.replayEventsAfter(first, {
          send: async (eventId) => {
            replayed.push(eventId);
          },
        }),
      ).resolves.toBe("stream");
      expect(replayed).toHaveLength(1_025);
      expect(replayed.at(-1)).toBe(latest);

      const eventDirectory = join(dataDirectory, "events");
      const factory = durableEventFactory(eventDirectory, Buffer.alloc(32, 38), {
        nowUnixMs: () => now,
      });
      const binding = {
        ownerBinding: "owner",
        surface: "full",
        workSessionBinding: "work-lossless",
        transportSessionId: "transport-lossless",
      } as const;
      await staged.bind(factory, binding);
      const durable = await DurableMcpEventStore.rehydrate({
        dataDirectory: eventDirectory,
        hmacKey: Buffer.alloc(32, 38),
        nowUnixMs: () => now,
        ...binding,
      });
      await expect(durable.getSessionMetadata()).resolves.toMatchObject({
        retainedEventCount: 1_026,
        earliestEventId: first,
        latestEventId: latest,
      });
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("adopts only retained bootstrap events with original IDs, order, and timestamps", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-deferred-events-"));
    const eventDirectory = join(dataDirectory, "events");
    let now = 100;
    const factory = durableEventFactory(eventDirectory, Buffer.alloc(32, 37), {
      nowUnixMs: () => now,
      eventTtlMs: 10_000,
    });
    const binding = {
      ownerBinding: "owner",
      surface: "full",
      workSessionBinding: "work-overflow",
      transportSessionId: "transport-overflow",
    } as const;
    const staged = new DeferredDurableMcpEventStore({
      maxEvents: 2,
      ttlMs: 10,
      nowUnixMs: () => now,
      nonce: "bootstrap",
    });
    try {
      const evicted = await staged.storeEvent("stream", progressNotification("one"));
      now = 101;
      const retained = await staged.storeEvent("stream", progressNotification("two"));
      now = 102;
      const latest = await staged.storeEvent("stream", progressNotification("three"));
      await staged.bind(factory, binding);

      const durable = await DurableMcpEventStore.rehydrate({
        dataDirectory: eventDirectory,
        hmacKey: Buffer.alloc(32, 37),
        nowUnixMs: () => now,
        eventTtlMs: 10_000,
        ...binding,
      });
      await expect(durable.getStreamIdForEventId(evicted)).resolves.toBeUndefined();
      await expect(durable.getStreamIdForEventId(retained)).resolves.toBe("stream");
      const replayed: string[] = [];
      await durable.replayEventsAfter(retained, {
        send: async (eventId) => {
          replayed.push(eventId);
        },
      });
      expect(replayed).toEqual([latest]);
      const snapshotName = (await readdir(eventDirectory)).find((name) =>
        name.endsWith(".snapshot.json"),
      );
      if (snapshotName === undefined) throw new Error("Missing durable event snapshot");
      const snapshot = JSON.parse(
        gunzipSync(await readFile(join(eventDirectory, snapshotName))).toString("utf8"),
      ) as {
        readonly events: readonly { readonly id: string; readonly storedAtUnixMs: number }[];
      };
      expect(snapshot.events.map((event) => [event.id, event.storedAtUnixMs])).toEqual([
        [retained, 101],
        [latest, 102],
      ]);

      const ttlBinding = {
        ...binding,
        workSessionBinding: "work-ttl",
        transportSessionId: "transport-ttl",
      };
      const ttlStaged = new DeferredDurableMcpEventStore({
        maxEvents: 4,
        ttlMs: 10,
        nowUnixMs: () => now,
        nonce: "ttl",
      });
      const expired = await ttlStaged.storeEvent("stream", progressNotification("expired"));
      now = 113;
      const live = await ttlStaged.storeEvent("stream", progressNotification("live"));
      await ttlStaged.bind(factory, ttlBinding);
      const ttlDurable = await DurableMcpEventStore.rehydrate({
        dataDirectory: eventDirectory,
        hmacKey: Buffer.alloc(32, 37),
        nowUnixMs: () => now,
        eventTtlMs: 10_000,
        ...ttlBinding,
      });
      await expect(ttlDurable.getStreamIdForEventId(expired)).resolves.toBeUndefined();
      await expect(ttlDurable.getStreamIdForEventId(live)).resolves.toBe("stream");

      const terminated = new DeferredDurableMcpEventStore({ nonce: "terminated" });
      const discarded = await terminated.storeEvent("stream", progressNotification("discarded"));
      await terminated.tombstoneSession();
      await expect(terminated.getStreamIdForEventId(discarded)).resolves.toBeUndefined();
      await expect(
        terminated.replayEventsAfter(discarded, { send: async () => undefined }),
      ).rejects.toThrow("EVENT_HISTORY_EXPIRED");
      await expect(terminated.storeEvent("stream", progressNotification("late"))).rejects.toThrow(
        "MCP_EVENT_SESSION_TERMINATED",
      );
      await expect(
        terminated.bind(factory, {
          ...binding,
          workSessionBinding: "work-terminated",
          transportSessionId: "transport-terminated",
        }),
      ).rejects.toThrow("MCP_EVENT_SESSION_TERMINATED");
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("fails fast when direct schedules lack a runtime-owned dispatch adapter", () => {
    const jobs = new DirectJobManager(DirectJobStore.inMemory());
    const schedules = new DirectScheduleManager(
      DirectScheduleStore.inMemory({ integrityKey: Buffer.alloc(32, 43) }),
      jobs,
    );
    expect(() =>
      gatewayFor(fakeAppServer().appServer, {
        directJobManager: jobs,
        directScheduleManager: schedules,
        durableWorkSessionStore: {} as DurableWorkSessionStore,
      }),
    ).toThrow(
      "Direct schedules require direct jobs, durable work sessions, and a runtime-owned dispatcher",
    );
  });

  it("keeps due exact-native schedule dispatch alive after its MCP session closes", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-gateway-schedule-session-"));
    const workSessions = await DurableWorkSessionStore.open({
      dataDirectory,
      hmacKey: Buffer.alloc(32, 47),
    });
    const jobs = new DirectJobManager(DirectJobStore.inMemory());
    const schedules = new DirectScheduleManager(
      DirectScheduleStore.inMemory({
        integrityKey: Buffer.alloc(32, 53),
        nowUnixMs: () => 1_000,
      }),
      jobs,
    );
    const adapter: DirectJobDispatchAdapter = {
      validate: vi.fn(async () => directTargetContract("schedule")),
      dispatch: vi.fn(async (request) => {
        await request.beforeNativeDispatch();
        return {
          status: "succeeded" as const,
          result: { content: [{ type: "text" as const, text: "runtime-native-ok" }] },
        };
      }),
    };
    const gateway = gatewayFor(fakeAppServer().appServer, {
      directJobManager: jobs,
      directScheduleManager: schedules,
      directJobDispatchAdapter: adapter,
      durableWorkSessionStore: workSessions,
    });
    const address = await gateway.start();
    const client = new TestMcpClient(
      `http://${address.host}:${address.port}${address.fullPath}`,
      "owner",
    );
    try {
      await client.connect();
      const created = await client.request("tools/call", {
        name: "omnicodex__schedule_create",
        arguments: {
          idempotencyKey: "gateway-schedule-create-0001",
          timezone: "Asia/Seoul",
          rrule: "FREQ=MINUTELY;INTERVAL=5",
          startAtUnixMs: 61_000,
          toolName: "mcp__demo__ping",
          arguments: {},
        },
        _meta: { "io.modelcontextprotocol/related-task": { taskId: "schedule-web-chat" } },
      });
      expect(created).not.toMatchObject({ isError: true });
      expect(adapter.validate).toHaveBeenCalledWith("mcp__demo__ping", {});
      expect(adapter.dispatch).not.toHaveBeenCalled();

      await client.terminateSession();
      await client.close();
      await schedules.pump(adapter, 61_000);
      await schedules.shutdown();

      expect(adapter.dispatch).toHaveBeenCalledTimes(1);
      expect(adapter.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "mcp__demo__ping",
          arguments: {},
          callerSessionId: expect.stringMatching(/^schedule:/u),
        }),
      );
    } finally {
      await client.close().catch(() => undefined);
      await schedules.shutdown();
      await gateway.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("lets a runtime-owned direct job finish after DELETE and reads it from a new transport", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-gateway-job-delete-"));
    const workSessions = await DurableWorkSessionStore.open({
      dataDirectory,
      hmacKey: Buffer.alloc(32, 71),
    });
    const jobs = new DirectJobManager(DirectJobStore.inMemory());
    let dispatchStarted!: () => void;
    let finishDispatch!: (outcome: DirectJobDispatchOutcome) => void;
    const started = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    const pending = new Promise<DirectJobDispatchOutcome>((resolve) => {
      finishDispatch = resolve;
    });
    const adapter: DirectJobDispatchAdapter = {
      validate: vi.fn(async () => directTargetContract("delete-survival")),
      dispatch: vi.fn(async (request) => {
        await request.beforeNativeDispatch();
        dispatchStarted();
        return pending;
      }),
    };
    const gateway = gatewayFor(fakeAppServer().appServer, {
      directJobManager: jobs,
      directJobDispatchAdapter: adapter,
      durableWorkSessionStore: workSessions,
      shutdownHardTimeoutMs: 100,
    });
    const address = await gateway.start();
    const url = `http://${address.host}:${address.port}${address.fullPath}`;
    const first = new TestMcpClient(url, "owner");
    let second: TestMcpClient | undefined;
    try {
      await first.connect();
      const startResult = await first.request("tools/call", {
        name: "omnicodex__job_start",
        arguments: {
          idempotencyKey: "gateway-delete-survival-0001",
          toolName: "mcp__demo__ping",
          arguments: {},
        },
        _meta: { "io.modelcontextprotocol/related-task": { taskId: "job-delete-chat" } },
      });
      const jobId = directJobFromResult(startResult).jobId;
      await started;

      await expect(
        Promise.race([
          first.terminateSession(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("DELETE waited for a runtime-owned job")), 500),
          ),
        ]),
      ).resolves.toBeUndefined();
      finishDispatch({
        status: "succeeded",
        result: { content: [{ type: "text", text: "DELETE_SURVIVAL_OK" }] },
      });
      await jobs.waitForAdapterIdle(adapter);

      second = new TestMcpClient(url, "owner");
      await second.connect();
      const readback = await second.request("tools/call", {
        name: "omnicodex__job_get",
        arguments: { jobId },
        _meta: { "io.modelcontextprotocol/related-task": { taskId: "job-delete-chat" } },
      });
      expect(directJobFromResult(readback)).toMatchObject({
        jobId,
        status: "succeeded",
        result: { content: [{ type: "text", text: "DELETE_SURVIVAL_OK" }] },
      });
    } finally {
      await Promise.allSettled([first.close(), second?.close()]);
      await gateway.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("fences a hung runtime-owned job before stop and reopens its adapter after rollback", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-gateway-job-fence-"));
    const workSessions = await DurableWorkSessionStore.open({
      dataDirectory,
      hmacKey: Buffer.alloc(32, 73),
    });
    const jobs = new DirectJobManager(DirectJobStore.inMemory());
    const drainSpy = vi.spyOn(jobs, "drainAdapter");
    let dispatchStarted!: () => void;
    let finishDispatch!: (outcome: DirectJobDispatchOutcome) => void;
    const started = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    const pending = new Promise<DirectJobDispatchOutcome>((resolve) => {
      finishDispatch = resolve;
    });
    const adapter: DirectJobDispatchAdapter = {
      validate: vi.fn(async () => directTargetContract("runtime-fence")),
      dispatch: vi.fn(async (request) => {
        await request.beforeNativeDispatch();
        dispatchStarted();
        return pending;
      }),
    };
    const gateway = gatewayFor(fakeAppServer().appServer, {
      directJobManager: jobs,
      directJobDispatchAdapter: adapter,
      durableWorkSessionStore: workSessions,
      shutdownHardTimeoutMs: 100,
    });
    const firstAddress = await gateway.start();
    const firstUrl = `http://${firstAddress.host}:${firstAddress.port}${firstAddress.fullPath}`;
    const first = new TestMcpClient(firstUrl, "owner");
    let rollbackClient: TestMcpClient | undefined;
    try {
      await first.connect();
      const startResult = await first.request("tools/call", {
        name: "omnicodex__job_start",
        arguments: {
          idempotencyKey: "gateway-runtime-fence-0001",
          toolName: "mcp__demo__ping",
          arguments: {},
        },
        _meta: { "io.modelcontextprotocol/related-task": { taskId: "job-fence-chat" } },
      });
      const jobId = directJobFromResult(startResult).jobId;
      await started;

      await expect(gateway.stop(100)).resolves.toBeUndefined();
      expect(gateway.address).toBeUndefined();
      expect(drainSpy).toHaveBeenCalledWith(
        adapter,
        expect.any(Number),
        expect.objectContaining({ code: "DIRECT_JOB_RUNTIME_DRAIN_TIMEOUT" }),
      );
      const appliedDrainTimeoutMs = drainSpy.mock.calls[0]?.[1] ?? 0;
      expect(appliedDrainTimeoutMs).toBeGreaterThan(0);
      expect(appliedDrainTimeoutMs).toBeLessThanOrEqual(100);

      const rollbackAddress = await gateway.start();
      gateway.resumeAdmission();
      rollbackClient = new TestMcpClient(
        `http://${rollbackAddress.host}:${rollbackAddress.port}${rollbackAddress.fullPath}`,
        "owner",
      );
      await rollbackClient.connect();
      const fenced = await rollbackClient.request("tools/call", {
        name: "omnicodex__job_get",
        arguments: { jobId },
        _meta: { "io.modelcontextprotocol/related-task": { taskId: "job-fence-chat" } },
      });
      expect(directJobFromResult(fenced)).toMatchObject({
        jobId,
        status: "outcome_unknown",
        error: { code: "DIRECT_JOB_RUNTIME_DRAIN_TIMEOUT" },
      });

      finishDispatch({
        status: "succeeded",
        result: { content: [{ type: "text", text: "TOO_LATE" }] },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const resumedStart = await rollbackClient.request("tools/call", {
        name: "omnicodex__job_start",
        arguments: {
          idempotencyKey: "gateway-runtime-fence-0002",
          toolName: "mcp__demo__ping",
          arguments: {},
        },
        _meta: { "io.modelcontextprotocol/related-task": { taskId: "job-fence-chat" } },
      });
      const resumedJobId = directJobFromResult(resumedStart).jobId;
      await jobs.waitForAdapterIdle(adapter);
      const resumedReadback = await rollbackClient.request("tools/call", {
        name: "omnicodex__job_get",
        arguments: { jobId: resumedJobId },
        _meta: { "io.modelcontextprotocol/related-task": { taskId: "job-fence-chat" } },
      });
      expect(directJobFromResult(resumedReadback)).toMatchObject({
        jobId: resumedJobId,
        status: "succeeded",
      });

      const stillFenced = await rollbackClient.request("tools/call", {
        name: "omnicodex__job_get",
        arguments: { jobId },
        _meta: { "io.modelcontextprotocol/related-task": { taskId: "job-fence-chat" } },
      });
      expect(directJobFromResult(stillFenced)).toMatchObject({
        status: "outcome_unknown",
        error: { code: "DIRECT_JOB_RUNTIME_DRAIN_TIMEOUT" },
      });
    } finally {
      finishDispatch?.({
        status: "succeeded",
        result: { content: [{ type: "text", text: "FINALIZE" }] },
      });
      await Promise.allSettled([first.close(), rollbackClient?.close()]);
      await gateway.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("single-flights concurrent stops, retains the live handle, and retries a failed close", async () => {
    const gateway = gatewayFor(fakeAppServer().appServer);
    const address = await gateway.start();
    const originalClose = NodeHttpServer.prototype.close;
    let closeCalls = 0;
    let failFirstClose: (() => void) | undefined;
    const closeSpy = vi.spyOn(NodeHttpServer.prototype, "close").mockImplementation(function (
      this: NodeHttpServer,
      callback,
    ) {
      closeCalls += 1;
      if (closeCalls === 1) {
        failFirstClose = () => callback?.(new Error("synthetic close failure"));
        return this;
      }
      return originalClose.call(this, callback);
    });

    try {
      const first = gateway.stop();
      const concurrent = gateway.stop();
      expect(concurrent).toBe(first);
      expect(closeCalls).toBe(1);
      expect(gateway.address).toEqual(address);
      await expect(gateway.start()).resolves.toEqual(address);

      failFirstClose?.();
      await expect(first).rejects.toThrow("synthetic close failure");
      await expect(concurrent).rejects.toThrow("synthetic close failure");
      expect(gateway.address).toEqual(address);

      await expect(gateway.stop()).resolves.toBeUndefined();
      expect(closeCalls).toBe(2);
      expect(gateway.address).toBeUndefined();
    } finally {
      closeSpy.mockRestore();
      await gateway.stop();
    }
  });

  it("closes the listener immediately and begins all session executor closes in parallel", async () => {
    const closeReleases = new Map<string, () => void>();
    const gateway = gatewayFor(fakeAppServer().appServer, {
      shutdownHardTimeoutMs: 100,
      createSessionExecutors: (context) => ({
        responsesToolExecutor: codeModeResponsesExecutor(),
        close: () =>
          new Promise<void>((resolve) => {
            closeReleases.set(context.correlationId, resolve);
          }),
      }),
    });
    const address = await gateway.start();
    const fullUrl = `http://${address.host}:${address.port}${address.fullPath}`;
    const first = new TestMcpClient(fullUrl, "owner");
    const second = new TestMcpClient(fullUrl, "owner");
    const originalClose = NodeHttpServer.prototype.close;
    const closeSpy = vi.spyOn(NodeHttpServer.prototype, "close").mockImplementation(function (
      this: NodeHttpServer,
      callback,
    ) {
      return originalClose.call(this, callback);
    });
    try {
      await Promise.all([first.connect(), second.connect()]);
      const stopping = gateway.stop();

      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(closeReleases.size).toBe(2);
      for (const release of closeReleases.values()) release();
      await expect(stopping).resolves.toBeUndefined();
      expect(gateway.address).toBeUndefined();
    } finally {
      for (const release of closeReleases.values()) release();
      closeSpy.mockRestore();
      await gateway.stop();
      void first.close().catch(() => undefined);
      void second.close().catch(() => undefined);
    }
  });

  it("waits without an implicit shutdown deadline for session-owned executors", async () => {
    let releaseClose!: () => void;
    let closeCalls = 0;
    const closePending = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const gateway = gatewayFor(fakeAppServer().appServer, {
      createSessionExecutors: () => ({
        responsesToolExecutor: codeModeResponsesExecutor(),
        close: () => {
          closeCalls += 1;
          return closePending;
        },
      }),
    });
    const address = await gateway.start();
    const client = new TestMcpClient(
      `http://${address.host}:${address.port}${address.fullPath}`,
      "owner",
    );
    try {
      await client.connect();
      vi.useFakeTimers();
      const stopping = gateway.stop();
      let settled = false;
      void stopping.finally(() => {
        settled = true;
      });

      expect(closeCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(settled).toBe(false);

      releaseClose();
      await expect(stopping).resolves.toBeUndefined();
      expect(closeCalls).toBe(1);
    } finally {
      releaseClose();
      vi.useRealTimers();
      await gateway.stop().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  });

  it("does not close session executors before an admitted MCP request completes", async () => {
    const fixture = fakeAppServer();
    let executorCloseCalls = 0;
    const gateway = gatewayFor(fixture.appServer, {
      createSessionExecutors: () => ({
        responsesToolExecutor: codeModeResponsesExecutor(),
        close: () => {
          executorCloseCalls += 1;
        },
      }),
    });
    const address = await gateway.start();
    const client = new TestMcpClient(
      `http://${address.host}:${address.port}${address.fullPath}`,
      "owner",
    );
    try {
      await client.connect();
      const slowRequest = client.request("tools/call", {
        name: "slow",
        arguments: {
          omnicodexInvocationId: "10000000-0000-4000-8000-000000000007",
        },
      });
      await fixture.slowStarted;

      vi.useFakeTimers();
      const stopping = gateway.stop();
      let settled = false;
      void stopping.finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(5_001);
      expect(settled).toBe(false);
      expect(executorCloseCalls).toBe(0);

      fixture.releaseSlow();
      await expect(slowRequest).resolves.toMatchObject({
        content: [{ type: "text", text: "late" }],
      });
      await expect(stopping).resolves.toBeUndefined();
      expect(executorCloseCalls).toBe(1);
    } finally {
      fixture.releaseSlow();
      vi.useRealTimers();
      await gateway.stop().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  });

  it("bounds a hung session executor close and retries the same owned close after it settles", async () => {
    let releaseClose!: () => void;
    let closeCalls = 0;
    const closePending = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const gateway = gatewayFor(fakeAppServer().appServer, {
      shutdownHardTimeoutMs: 25,
      createSessionExecutors: () => ({
        responsesToolExecutor: codeModeResponsesExecutor(),
        close: () => {
          closeCalls += 1;
          return closePending;
        },
      }),
    });
    const address = await gateway.start();
    const client = new TestMcpClient(
      `http://${address.host}:${address.port}${address.fullPath}`,
      "owner",
    );
    try {
      await client.connect();
      await expect(gateway.stop(25)).rejects.toThrow("executor close exceeded");
      expect(gateway.address).toBeUndefined();
      expect(closeCalls).toBe(1);

      releaseClose();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(gateway.stop(25)).resolves.toBeUndefined();
      expect(closeCalls).toBe(1);
    } finally {
      releaseClose();
      await gateway.stop().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  });

  it("retries a rejected session executor close on the next gateway stop", async () => {
    let closeCalls = 0;
    const gateway = gatewayFor(fakeAppServer().appServer, {
      shutdownHardTimeoutMs: 500,
      createSessionExecutors: () => ({
        responsesToolExecutor: codeModeResponsesExecutor(),
        close: () => {
          closeCalls += 1;
          if (closeCalls === 1)
            return Promise.reject(new Error("temporary browser cleanup failure"));
          return Promise.resolve();
        },
      }),
    });
    const address = await gateway.start();
    const client = new TestMcpClient(
      `http://${address.host}:${address.port}${address.fullPath}`,
      "owner",
    );
    try {
      await client.connect();
      await expect(gateway.stop()).rejects.toThrow("temporary browser cleanup failure");
      expect(closeCalls).toBe(1);
      await expect(gateway.stop()).resolves.toBeUndefined();
      expect(closeCalls).toBe(2);
    } finally {
      await gateway.stop().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  });

  it("hard-bounds HTTP close after force-closing lingering connections", async () => {
    const gateway = gatewayFor(fakeAppServer().appServer, { shutdownHardTimeoutMs: 25 });
    await gateway.start();
    const originalClose = NodeHttpServer.prototype.close;
    const closeSpy = vi.spyOn(NodeHttpServer.prototype, "close").mockImplementation(function (
      this: NodeHttpServer,
    ) {
      // Close the listener for real, but deliberately omit the callback to
      // emulate a server whose close completion never arrives.
      return originalClose.call(this);
    });
    vi.useFakeTimers();
    try {
      const stopping = gateway.stop();
      await vi.advanceTimersByTimeAsync(25);
      await expect(stopping).resolves.toBeUndefined();
      expect(gateway.address).toBeUndefined();
    } finally {
      vi.useRealTimers();
      closeSpy.mockRestore();
      await gateway.stop();
    }
  });

  it("rebinds a Web conversation across fresh MCP transports without a provisional-session conflict", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-gateway-work-session-"));
    const workSessions = await DurableWorkSessionStore.open({
      dataDirectory,
      hmacKey: Buffer.alloc(32, 19),
    });
    const gateway = gatewayFor(fakeAppServer().appServer, {
      durableWorkSessionStore: workSessions,
    });
    const address = await gateway.start();
    const url = `http://${address.host}:${address.port}${address.fullPath}`;
    const first = new TestMcpClient(url, "owner");
    const second = new TestMcpClient(url, "owner");
    try {
      await first.connect();
      const firstResult = await first.request("tools/call", {
        name: "mcp__demo__ping",
        arguments: {
          omnicodexInvocationId: "21000000-0000-4000-8000-000000000001",
        },
        _meta: { "io.modelcontextprotocol/related-task": { taskId: "web-chat-42" } },
      });
      const firstBinding = workSessionMetadata(firstResult);
      expect(firstBinding.workSessionBinding).toMatch(/^wsb1_/u);
      expect(firstBinding.continuationToken).toMatch(/^wct1_/u);
      expect(firstBinding.journalCursor).toMatch(/^wsc1_/u);
      await first.close();

      await second.connect();
      const resumedResult = await second.request("tools/call", {
        name: "mcp__demo__ping",
        arguments: {
          omnicodexInvocationId: "21000000-0000-4000-8000-000000000002",
        },
        _meta: { "io.modelcontextprotocol/related-task": { taskId: "web-chat-42" } },
      });
      expect(workSessionMetadata(resumedResult)).toMatchObject({
        workSessionBinding: firstBinding.workSessionBinding,
        continuationToken: firstBinding.continuationToken,
      });
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
      await gateway.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("rebinds documented ChatGPT openai/session metadata across model-turn transports", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-gateway-openai-session-"));
    const workSessions = await DurableWorkSessionStore.open({
      dataDirectory: join(dataDirectory, "work-sessions"),
      hmacKey: Buffer.alloc(32, 20),
    });
    const eventDirectory = join(dataDirectory, "events");
    const gateway = gatewayFor(fakeAppServer().appServer, {
      durableWorkSessionStore: workSessions,
      durableMcpEventStoreFactory: durableEventFactory(eventDirectory, Buffer.alloc(32, 22)),
    });
    const address = await gateway.start();
    const url = `http://${address.host}:${address.port}${address.fullPath}`;
    const first = new TestMcpClient(url, "owner");
    const laterTurn = new TestMcpClient(url, "owner");
    try {
      await first.connect();
      const firstTransportSessionId = first.sessionId ?? "";
      const firstResult = await first.request("tools/call", {
        name: "mcp__demo__ping",
        arguments: { omnicodexInvocationId: "21010000-0000-4000-8000-000000000001" },
        _meta: { "openai/session": "anonymous-chat-session-42" },
      });
      const firstBinding = workSessionMetadata(firstResult);

      await laterTurn.connect();
      const laterResult = await laterTurn.request("tools/call", {
        name: "mcp__demo__ping",
        arguments: { omnicodexInvocationId: "21010000-0000-4000-8000-000000000002" },
        _meta: { "openai/session": "anonymous-chat-session-42" },
      });
      expect(workSessionMetadata(laterResult)).toMatchObject({
        workSessionBinding: firstBinding.workSessionBinding,
        continuationToken: firstBinding.continuationToken,
      });
      expect(
        (await readdir(eventDirectory)).filter((name) => name.endsWith(".snapshot.json")),
      ).toHaveLength(1);
      const supersededPost = await mcpPost(
        url,
        { jsonrpc: "2.0", id: 93, method: "tools/list", params: {} },
        "owner",
        {
          "MCP-Session-Id": firstTransportSessionId,
          "MCP-Protocol-Version": "2025-06-18",
        },
      );
      expect(supersededPost.status).toBe(404);
    } finally {
      await Promise.allSettled([first.close(), laterTurn.close()]);
      await gateway.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("reuses a server-issued work session when ChatGPT echoes it on a fresh transport", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-gateway-explicit-session-"));
    const workSessions = await DurableWorkSessionStore.open({
      dataDirectory,
      hmacKey: Buffer.alloc(32, 21),
    });
    const gateway = gatewayFor(fakeAppServer().appServer, {
      durableWorkSessionStore: workSessions,
    });
    const address = await gateway.start();
    const url = `http://${address.host}:${address.port}${address.fullPath}`;
    const first = new TestMcpClient(url, "owner");
    const second = new TestMcpClient(url, "owner");
    try {
      await first.connect();
      const identity = (await first.request("tools/call", {
        name: "codex__omnicodex__session_identity",
        arguments: {},
      })) as { readonly structuredContent: unknown };
      const session = identity.structuredContent as {
        workSessionBinding: string;
        continuationToken: string;
      };
      expect(session.workSessionBinding).toMatch(/^wsb1_/u);
      expect(session.continuationToken).toMatch(/^wct1_/u);
      await first.close();

      await second.connect();
      const resumed = await second.request("tools/call", {
        name: "mcp__demo__ping",
        arguments: {
          _omnicodexSession: session,
          omnicodexInvocationId: "21100000-0000-4000-8000-000000000001",
        },
      });
      expect(workSessionMetadata(resumed)).toMatchObject({
        workSessionBinding: session.workSessionBinding,
        continuationToken: session.continuationToken,
      });
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
      await gateway.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("publishes one stable Web-conversation binding to reconnecting executor transports", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-gateway-executor-binding-"));
    const workSessions = await DurableWorkSessionStore.open({
      dataDirectory,
      hmacKey: Buffer.alloc(32, 23),
    });
    const executorContexts: McpSessionExecutorContext[] = [];
    const gateway = gatewayFor(fakeAppServer().appServer, {
      durableWorkSessionStore: workSessions,
      createSessionExecutors: (context) => {
        executorContexts.push(context);
        return { responsesToolExecutor: codeModeResponsesExecutor(), close: () => undefined };
      },
    });
    const address = await gateway.start();
    const url = `http://${address.host}:${address.port}${address.fullPath}`;
    const first = new TestMcpClient(url, "owner");
    const second = new TestMcpClient(url, "owner");
    try {
      await first.connect();
      expect(executorContexts[0]?.resolveWorkSessionBinding?.()).toBeUndefined();
      await first.request("tools/call", {
        name: "mcp__demo__ping",
        arguments: { omnicodexInvocationId: "21200000-0000-4000-8000-000000000001" },
        _meta: { "io.modelcontextprotocol/related-task": { taskId: "executor-web-chat" } },
      });
      const firstBinding = executorContexts[0]?.resolveWorkSessionBinding?.();
      expect(firstBinding).toMatch(/^wsb1_/u);
      await first.close();
      expect(executorContexts[0]?.resolveWorkSessionBinding?.()).toBe(firstBinding);

      await second.connect();
      await second.request("tools/call", {
        name: "mcp__demo__ping",
        arguments: { omnicodexInvocationId: "21200000-0000-4000-8000-000000000002" },
        _meta: { "io.modelcontextprotocol/related-task": { taskId: "executor-web-chat" } },
      });
      expect(executorContexts[1]?.authorizationBinding).toBe(
        executorContexts[0]?.authorizationBinding,
      );
      expect(executorContexts[1]?.resolveWorkSessionBinding?.()).toBe(firstBinding);
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
      await gateway.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("keeps durable owner state across OAuth client rotation without sharing a live transport", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-gateway-client-rotation-"));
    const workSessions = await DurableWorkSessionStore.open({
      dataDirectory,
      hmacKey: Buffer.alloc(32, 67),
    });
    const gateway = gatewayFor(fakeAppServer().appServer, {
      durableWorkSessionStore: workSessions,
    });
    const address = await gateway.start();
    const url = `http://${address.host}:${address.port}${address.fullPath}`;
    const first = new TestMcpClient(url, "owner");
    const rotated = new TestMcpClient(url, "owner-rotated-client");
    try {
      await first.connect();
      const firstResult = await first.request("tools/call", {
        name: "mcp__demo__ping",
        arguments: {
          omnicodexInvocationId: "21500000-0000-4000-8000-000000000001",
        },
        _meta: { "io.modelcontextprotocol/related-task": { taskId: "rotated-web-chat" } },
      });
      const firstBinding = workSessionMetadata(firstResult);

      const crossClientTransport = await mcpPost(
        url,
        { jsonrpc: "2.0", id: 91, method: "tools/list", params: {} },
        "owner-rotated-client",
        {
          "MCP-Session-Id": first.sessionId ?? "",
          "MCP-Protocol-Version": "2025-06-18",
        },
      );
      expect(crossClientTransport.status).toBe(404);
      await first.close();

      await rotated.connect();
      const resumedResult = await rotated.request("tools/call", {
        name: "mcp__demo__ping",
        arguments: {
          omnicodexInvocationId: "21500000-0000-4000-8000-000000000002",
        },
        _meta: { "io.modelcontextprotocol/related-task": { taskId: "rotated-web-chat" } },
      });
      expect(workSessionMetadata(resumedResult)).toMatchObject({
        workSessionBinding: firstBinding.workSessionBinding,
        continuationToken: firstBinding.continuationToken,
      });
    } finally {
      await Promise.allSettled([first.close(), rotated.close()]);
      await gateway.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("durably replays an unknown old transport after restart without reviving POST state", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-gateway-durable-events-"));
    const workSessions = await DurableWorkSessionStore.open({
      dataDirectory: join(dataDirectory, "work-sessions"),
      hmacKey: Buffer.alloc(32, 29),
    });
    let now = Date.now();
    const eventFactory = durableEventFactory(join(dataDirectory, "events"), Buffer.alloc(32, 31), {
      nowUnixMs: () => now,
      sessionTtlMs: 100,
      eventTtlMs: 10_000,
    });
    const fixture = fakeAppServer();
    const firstGateway = gatewayFor(fixture.appServer, {
      durableWorkSessionStore: workSessions,
      durableMcpEventStoreFactory: eventFactory,
    });
    const firstAddress = await firstGateway.start();
    const firstUrl = `http://${firstAddress.host}:${firstAddress.port}${firstAddress.fullPath}`;
    const client = new TestMcpClient(firstUrl, "owner");
    let oldSessionId = "";
    let firstEventId = "";
    let secondEventId = "";
    try {
      // initialize carries no related-task. The first tool call supplies it and
      // promotes all buffered initialize history into the durable store.
      await client.connect();
      oldSessionId = client.sessionId ?? "";
      expect(oldSessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      now = Date.now();
      await Promise.race([
        client.request("tools/call", {
          name: "mcp__demo__ping",
          arguments: { omnicodexInvocationId: "22000000-0000-4000-8000-000000000001" },
          _meta: { "io.modelcontextprotocol/related-task": { taskId: "durable-web-chat" } },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Durable first tool call timed out")), 2_000),
        ),
      ]);
      const resumableResponse = await mcpPost(
        firstUrl,
        { jsonrpc: "2.0", id: 77, method: "tools/list", params: {} },
        "owner",
        { "MCP-Session-Id": oldSessionId, "MCP-Protocol-Version": "2025-11-25" },
      );
      expect(resumableResponse.status).toBe(200);
      const resumableText = await resumableResponse.text();
      const resumableEventIds = [...resumableText.matchAll(/^id: ([^\r\n]+)$/gmu)].map(
        (match) => match[1],
      );
      expect(resumableEventIds).toHaveLength(2);
      firstEventId = resumableEventIds[0] ?? "";
      secondEventId = resumableEventIds[1] ?? "";
    } finally {
      await client.close();
      await firstGateway.stop();
    }

    const secondGateway = gatewayFor(fixture.appServer, {
      durableWorkSessionStore: workSessions,
      durableMcpEventStoreFactory: eventFactory,
    });
    const secondAddress = await secondGateway.start();
    const secondFullUrl = `http://${secondAddress.host}:${secondAddress.port}${secondAddress.fullPath}`;
    const secondCompatUrl = `http://${secondAddress.host}:${secondAddress.port}${secondAddress.path}`;
    try {
      const replayed = await fetch(secondFullUrl, {
        headers: {
          ...standaloneSseHeaders(oldSessionId),
          "Last-Event-ID": firstEventId,
        },
      });
      expect(replayed.status).toBe(200);
      expect(replayed.headers.get("mcp-session-id")).toBe(oldSessionId);
      const replayText = await replayed.text();
      expect(sseEventId(replayText)).toBe(secondEventId);

      const oldPost = await mcpPost(
        secondFullUrl,
        { jsonrpc: "2.0", id: 50, method: "tools/list", params: {} },
        "owner",
        { "MCP-Session-Id": oldSessionId, "MCP-Protocol-Version": "2025-06-18" },
      );
      expect(oldPost.status).toBe(404);

      for (const [url, authorizationValue, sessionValue] of [
        [secondFullUrl, "Bearer other", oldSessionId],
        [secondCompatUrl, "Bearer owner", oldSessionId],
        [secondFullUrl, "Bearer owner", "unknown-transport"],
      ] as const) {
        const rejected = await fetch(url, {
          headers: {
            Accept: "text/event-stream",
            Authorization: authorizationValue,
            "MCP-Protocol-Version": "2025-06-18",
            "MCP-Session-Id": sessionValue,
            "Last-Event-ID": firstEventId,
          },
        });
        expect(rejected.status).toBe(404);
      }

      now += 101;
      const expired = await fetch(secondFullUrl, {
        headers: {
          ...standaloneSseHeaders(oldSessionId),
          "Last-Event-ID": firstEventId,
        },
      });
      expect(expired.status).toBe(404);
    } finally {
      await secondGateway.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("tombstones durable replay before a same-owner DELETE completes", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-gateway-deleted-events-"));
    const workSessions = await DurableWorkSessionStore.open({
      dataDirectory: join(dataDirectory, "work-sessions"),
      hmacKey: Buffer.alloc(32, 41),
    });
    const eventFactory = durableEventFactory(join(dataDirectory, "events"), Buffer.alloc(32, 43));
    const gateway = gatewayFor(fakeAppServer().appServer, {
      durableWorkSessionStore: workSessions,
      durableMcpEventStoreFactory: eventFactory,
    });
    const address = await gateway.start();
    const fullUrl = `http://${address.host}:${address.port}${address.fullPath}`;
    const client = new TestMcpClient(fullUrl, "owner");
    try {
      await client.connect();
      const sessionId = client.sessionId ?? "";
      await client.request("tools/call", {
        name: "mcp__demo__ping",
        arguments: { omnicodexInvocationId: "23000000-0000-4000-8000-000000000001" },
        _meta: { "io.modelcontextprotocol/related-task": { taskId: "deleted-web-chat" } },
      });
      const resumableResponse = await mcpPost(
        fullUrl,
        { jsonrpc: "2.0", id: 78, method: "tools/list", params: {} },
        "owner",
        { "MCP-Session-Id": sessionId, "MCP-Protocol-Version": "2025-11-25" },
      );
      expect(resumableResponse.status).toBe(200);
      const eventIds = [...(await resumableResponse.text()).matchAll(/^id: ([^\r\n]+)$/gmu)].map(
        (match) => match[1],
      );
      expect(eventIds.length).toBeGreaterThan(0);
      const lastEventId = eventIds[0] ?? "";

      await client.terminateSession();

      const replayed = await fetch(fullUrl, {
        headers: {
          ...standaloneSseHeaders(sessionId),
          "Last-Event-ID": lastEventId,
        },
      });
      expect(replayed.status).toBe(404);
      await expect(replayed.text()).resolves.toBe("Session invalid");
    } finally {
      await Promise.allSettled([client.close(), gateway.stop()]);
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("enforces loopback bind and exact protected-resource/CORS configuration", () => {
    const appServer = fakeAppServer().appServer;
    expect(
      () =>
        new StreamableHttpGateway({
          appServer,
          host: "0.0.0.0",
          authorize: () => authorization("owner"),
        }),
    ).toThrow("127.0.0.1");
    expect(
      () =>
        new StreamableHttpGateway({
          appServer,
          allowedOrigins: ["*"],
          authorize: () => authorization("owner"),
        }),
    ).toThrow();
    expect(
      () =>
        new StreamableHttpGateway({
          appServer,
          protectedResourceMetadata: {
            ...metadata,
            bearer_methods_supported: ["query"],
          },
          authorize: () => authorization("owner"),
        }),
    ).toThrow("headers only");
  });

  it("serves path-based authorization-server discovery with exact trailing-slash issuer variants", async () => {
    const fixture = fakeAppServer();
    const issuer = "https://owner.example/oauth/omnicodex-v2/";
    const gateway = gatewayFor(fixture.appServer, {
      protectedResourceMetadata: {
        ...metadata,
        authorization_servers: [issuer],
      },
      authorizationServerMetadata: {
        issuer,
        authorization_endpoint: "https://identity.example/authorize",
        token_endpoint: "https://identity.example/oauth/token",
        registration_endpoint: "https://identity.example/oidc/register",
        jwks_uri: "https://identity.example/.well-known/jwks.json",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
      },
    });
    const address = await gateway.start();
    try {
      for (const discoveryPath of [
        "/.well-known/oauth-authorization-server/oauth/omnicodex-v2",
        "/.well-known/oauth-authorization-server/oauth/omnicodex-v2/",
        "/.well-known/openid-configuration/oauth/omnicodex-v2",
        "/.well-known/openid-configuration/oauth/omnicodex-v2/",
        "/oauth/omnicodex-v2/.well-known/oauth-authorization-server",
        "/oauth/omnicodex-v2/.well-known/oauth-authorization-server/",
        "/oauth/omnicodex-v2/.well-known/openid-configuration",
        "/oauth/omnicodex-v2/.well-known/openid-configuration/",
      ]) {
        const response = await fetch(`http://${address.host}:${address.port}${discoveryPath}`);
        expect(response.status, discoveryPath).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          issuer,
          code_challenge_methods_supported: ["S256"],
        });
      }
    } finally {
      await gateway.stop();
    }
  });

  it("discovers local OAuth metadata without changing the resource audience or issuer", async () => {
    const fixture = fakeAppServer();
    const gateway = gatewayFor(fixture.appServer, {
      publicMetadataOrigin: "https://owner.example",
    });
    const address = await gateway.start();
    const origin = `http://${address.host}:${address.port}`;
    try {
      const response = await mcpPost(`${origin}${address.fullPath}`, {}, undefined);
      const location = response.headers
        .get("www-authenticate")
        ?.match(/resource_metadata="([^"]+)"/u)?.[1];
      expect(location).toBe(`${origin}/.well-known/oauth-protected-resource/native/full`);
      const document = await fetch(location as string);
      expect(document.status).toBe(200);
      await expect(document.json()).resolves.toEqual({
        ...metadata,
        resource: "https://owner.example/native/full",
      });

      const forwarded = await mcpPost(`${origin}${address.fullPath}`, {}, undefined, {
        "X-Forwarded-Host": "owner.example",
      });
      expect(forwarded.headers.get("www-authenticate")).toContain(
        'resource_metadata="https://owner.example/.well-known/oauth-protected-resource/native/full"',
      );
    } finally {
      await gateway.stop();
    }
  });

  it("uses the reverse-proxy host and public origin in OAuth challenges", async () => {
    const fixture = fakeAppServer();
    const publicOrigin = "https://omnicodex.203.0.113.10.sslip.io";
    const gateway = gatewayFor(fixture.appServer, {
      allowedHosts: ["omnicodex.203.0.113.10.sslip.io"],
      publicMetadataOrigin: publicOrigin,
    });
    const address = await gateway.start();
    const url = `http://${address.host}:${address.port}${address.path}`;
    try {
      // Node fetch may replace Host with the URL authority. Send the actual
      // reverse-proxy Host so this regression exercises the external route.
      const unauthorized = await new Promise<{
        status: number | undefined;
        challenge: string | undefined;
      }>((resolve, reject) => {
        const request = httpRequest(
          url,
          {
            method: "POST",
            headers: {
              Host: "omnicodex.203.0.113.10.sslip.io",
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
          },
          (response) => {
            response.resume();
            response.once("end", () =>
              resolve({
                status: response.statusCode,
                challenge: response.headers["www-authenticate"],
              }),
            );
          },
        );
        request.once("error", reject);
        request.end("{}");
      });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.challenge).toContain(
        `resource_metadata="${publicOrigin}/.well-known/oauth-protected-resource/native"`,
      );
    } finally {
      await gateway.stop();
    }
  });

  it.each(["missing-header", "bare-scheme", "authorizer-error", "insufficient-scope"])(
    "emits a parseable Bearer challenge when authorization fails with %s",
    async (failure) => {
      const fixture = fakeAppServer();
      const gateway = new StreamableHttpGateway({
        appServer: fixture.appServer,
        protectedResourceMetadata: metadata,
        authorize: () => {
          if (failure === "authorizer-error") throw new Error("identity provider unavailable");
          return {
            ok: false,
            status: failure === "insufficient-scope" ? 403 : 401,
            ...(failure === "bare-scheme" ? { headers: { "WWW-Authenticate": "Bearer" } } : {}),
          };
        },
      });
      const address = await gateway.start();
      try {
        const response = await mcpPost(
          `http://${address.host}:${address.port}${address.path}`,
          {},
          undefined,
        );
        const error = failure === "insufficient-scope" ? "insufficient_scope" : "invalid_token";
        expect(response.status).toBe(failure === "insufficient-scope" ? 403 : 401);
        const challenge = response.headers.get("www-authenticate");
        expect(challenge).toMatch(new RegExp(`^Bearer error="${error}"`));
        expect(challenge).toContain('scope="omnicodex:full"');
        expect(challenge).toContain(`resource_metadata="http://${address.host}:${address.port}/`);
        await expect(response.json()).resolves.toMatchObject({ error });
      } finally {
        await gateway.stop();
      }
    },
  );

  it("rejects credential, origin, host, query-token, media, body, and protocol violations", async () => {
    const fixture = fakeAppServer();
    const gateway = gatewayFor(fixture.appServer);
    const address = await gateway.start();
    const url = `http://${address.host}:${address.port}${address.path}`;
    try {
      const unauthorized = await mcpPost(url, {}, undefined);
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("www-authenticate")).toBe(
        `Bearer realm="OmniCodex", error="invalid_token", error_description="Access token is invalid", scope="omnicodex:full", resource_metadata="http://${address.host}:${address.port}/.well-known/oauth-protected-resource/native"`,
      );
      expect(unauthorized.headers.get("content-type")).toBe("application/json; charset=utf-8");
      await expect(unauthorized.json()).resolves.toEqual({
        error: "invalid_token",
        error_description: "Access token is invalid",
      });

      const metadataResources = new Map([
        ["/.well-known/oauth-protected-resource/native", "https://owner.example/native"],
        ["/.well-known/oauth-protected-resource/native/full", "https://owner.example/native/full"],
      ]);
      for (const [metadataPath, expectedResource] of metadataResources) {
        const response = await fetch(`http://${address.host}:${address.port}${metadataPath}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        await expect(response.json()).resolves.toMatchObject({
          ...metadata,
          authorization_servers: ["https://owner.us.auth0.com/"],
          resource: expectedResource,
        });
      }
      const rootMetadata = await fetch(
        `http://${address.host}:${address.port}/.well-known/oauth-protected-resource`,
      );
      expect(rootMetadata.status).toBe(200);
      await expect(rootMetadata.json()).resolves.toMatchObject({
        ...metadata,
        authorization_servers: ["https://owner.us.auth0.com/"],
        resource: "https://owner.example/native/full",
      });

      for (const discoveryPath of [
        "/.well-known/oauth-authorization-server",
        "/.well-known/openid-configuration",
      ]) {
        const authorizationServerMetadata = await fetch(
          `http://${address.host}:${address.port}${discoveryPath}`,
        );
        expect(authorizationServerMetadata.status).toBe(200);
        expect(authorizationServerMetadata.headers.get("cache-control")).toBe("no-store");
        await expect(authorizationServerMetadata.json()).resolves.toMatchObject({
          issuer: "https://owner.us.auth0.com/",
          authorization_endpoint: "https://owner.us.auth0.com/authorize",
          token_endpoint: "https://owner.us.auth0.com/oauth/token",
          registration_endpoint: "https://owner.us.auth0.com/oidc/register",
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: [
            "none",
            "client_secret_basic",
            "client_secret_post",
          ],
        });
      }

      const queryToken = await mcpPost(`${url}?access_token=secret`, {}, "owner");
      expect(queryToken.status).toBe(400);
      const unknownOrigin = await mcpPost(url, {}, "owner", {
        Origin: "https://evil.example",
      });
      expect(unknownOrigin.status).toBe(403);
      expect(unknownOrigin.headers.get("access-control-allow-origin")).toBeNull();
      const attributedPreflight = await fetch(url, {
        method: "OPTIONS",
        headers: {
          Origin: "https://client.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers":
            "authorization, content-type, idempotency-key, x-correlation-id",
        },
      });
      expect(attributedPreflight.status).toBe(204);
      expect(attributedPreflight.headers.get("access-control-allow-origin")).toBe(
        "https://client.example",
      );
      expect(attributedPreflight.headers.get("access-control-allow-headers")).toContain(
        "idempotency-key",
      );
      expect(attributedPreflight.headers.get("access-control-allow-headers")).toContain(
        "x-correlation-id",
      );
      const unknownHost = await mcpPost(url, {}, "owner", { Host: "evil.example" });
      expect([400, 421]).toContain(unknownHost.status);

      const unsupportedMedia = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: "Bearer owner",
          Accept: "application/json, text/event-stream",
          "Content-Type": "text/plain",
        },
        body: "{}",
      });
      expect(unsupportedMedia.status).toBe(415);
      const largeUnbounded = await mcpPost(url, { value: "x".repeat(2 * 1024 * 1024) }, "owner");
      expect(largeUnbounded.status).toBe(400);
      await expect(largeUnbounded.text()).resolves.not.toBe("Payload Too Large");

      const unsupportedVersion = await mcpPost(url, initializeRequest("2099-01-01"), "owner");
      expect(unsupportedVersion.status).toBe(400);
      await expect(unsupportedVersion.json()).resolves.toMatchObject({
        error: {
          code: -32600,
          data: {
            supportedProtocolVersions: [
              "2026-07-28",
              "2025-11-25",
              "2025-06-18",
              "2025-03-26",
              "2024-11-05",
              "2024-10-07",
            ],
          },
        },
      });
      expect(fixture.calls).toEqual([]);
    } finally {
      await gateway.stop();
    }
  });

  it("enforces a request-body cap only when the caller explicitly configures one", async () => {
    const gateway = gatewayFor(fakeAppServer().appServer, { maxRequestBodyBytes: 1_024 });
    const address = await gateway.start();
    try {
      const response = await mcpPost(
        `http://${address.host}:${address.port}${address.path}`,
        { value: "x".repeat(2_048) },
        "owner",
      );
      expect(response.status).toBe(413);
      await expect(response.text()).resolves.toBe("Payload Too Large");
    } finally {
      await gateway.stop();
    }
  });

  it("marks finite POST event streams as non-bufferable without changing SSE semantics", async () => {
    const gateway = gatewayFor(fakeAppServer().appServer);
    const address = await gateway.start();
    try {
      const response = await mcpPost(
        `http://${address.host}:${address.port}${address.fullPath}`,
        initializeRequest("2025-06-18"),
        "owner",
        { "Accept-Encoding": "br" },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
      expect(response.headers.get("transfer-encoding")).toBe("chunked");
      expect(response.headers.get("content-length")).toBeNull();
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("mcp-session-id")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const body = await response.text();
      expect(body).toContain("event: message");
      expect(body).toContain('"protocolVersion":"2025-06-18"');
    } finally {
      await gateway.stop();
    }
  });

  it("preserves durable replay error code, message, data, retry, and cause in JSON-RPC", async () => {
    const workSessionDirectory = await mkdtemp(join(tmpdir(), "omnicodex-replay-error-"));
    const durableWorkSessionStore = await DurableWorkSessionStore.open({
      dataDirectory: workSessionDirectory,
      hmacKey: Buffer.alloc(32, 71),
    });
    const replayError = Object.assign(new Error("durable replay storage is unavailable"), {
      code: -32042,
      data: { partition: "events-7" },
      retry: { allowed: true, afterMs: 125 },
      cause: Object.assign(new Error("read failed"), { code: "EIO" }),
    });
    const durableMcpEventStoreFactory: DurableMcpEventStoreFactory = {
      open: async () => {
        throw new Error("unexpected open");
      },
      rehydrateByTransport: async () => {
        throw replayError;
      },
    };
    const gateway = gatewayFor(fakeAppServer().appServer, {
      durableMcpEventStoreFactory,
      durableWorkSessionStore,
    });
    const address = await gateway.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}${address.fullPath}`, {
        headers: {
          Accept: "text/event-stream",
          Authorization: "Bearer owner",
          "Last-Event-ID": "event.1",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": "S".repeat(43),
        },
      });
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32042,
          message: "durable replay storage is unavailable",
          data: {
            code: -32042,
            data: { partition: "events-7" },
            retry: { allowed: true, afterMs: 125 },
            cause: { message: "read failed", code: "EIO" },
          },
        },
      });
    } finally {
      await gateway.stop();
      await rm(workSessionDirectory, { recursive: true, force: true });
    }
  });

  it("reads issued attachment URIs through MCP without losing bytes or crossing owners", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-linked-resource-read-"));
    const owner = authorization("owner", `${metadata.resource}/full`).identity;
    if (owner === undefined) throw new Error("Missing test owner identity");
    const bytes = Uint8Array.from({ length: 1024 * 1024 + 37 }, (_, index) => index % 251);
    const resourceStore = new OwnerBoundResourceStore({ dataDirectory });
    const resource = await resourceStore.put({
      owner,
      sessionId: "R".repeat(43),
      mimeType: "application/octet-stream",
      bytes,
    });
    const gateway = gatewayFor(fakeAppServer().appServer, { resourceStore });
    const address = await gateway.start();
    const endpoint = new URL(`http://${address.host}:${address.port}${address.fullPath}`);
    const uri = `https://owner.example/resources/${resource.id}`;
    const clients: ModernMcpClient[] = [];
    try {
      for (const token of ["owner", "owner-rotated-client", "other"]) {
        const client = new ModernMcpClient(
          { name: "resource-read-test", version: "1.0.0" },
          { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } },
        );
        clients.push(client);
        await client.connect(
          new ModernStreamableHTTPClientTransport(endpoint, {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
          }),
        );
        if (token === "other") {
          await expect(client.readResource({ uri })).rejects.toMatchObject({ code: -32602 });
        } else {
          const received = await client.readResource({ uri });
          expect(received.contents).toHaveLength(1);
          const content = received.contents[0];
          expect(content?.uri).toBe(uri);
          expect(content?.mimeType).toBe(resource.mimeType);
          const decoded = Buffer.from(
            content !== undefined && "blob" in content ? content.blob : "",
            "base64",
          );
          expect(decoded.length).toBe(bytes.length);
          expect(decoded.equals(Buffer.from(bytes))).toBe(true);
          for (const invalid of [
            uri.replace("owner.example", "other.example"),
            `${uri}?token=secret`,
            `${uri}#fragment`,
            "file:///C:/private/secret.txt",
          ]) {
            await expect(client.readResource({ uri: invalid })).rejects.toMatchObject({
              code: -32602,
            });
          }
        }
      }
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await gateway.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("serves durable owner-bound results through exact HTTP byte ranges", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-range-results-"));
    const owner = authorization("owner", `${metadata.resource}/full`).identity;
    if (owner === undefined) throw new Error("Missing test owner identity");
    const bytes = Uint8Array.from({ length: 1_024 }, (_, index) => index % 251);
    const resourceStore = new OwnerBoundResourceStore({ dataDirectory });
    const resource = await resourceStore.put({
      owner,
      sessionId: "R".repeat(43),
      mimeType: "application/octet-stream",
      bytes,
    });
    const gateway = gatewayFor(fakeAppServer().appServer, { resourceStore });
    const address = await gateway.start();
    const url = `http://${address.host}:${address.port}/resources/${resource.id}`;
    try {
      expect((await fetch(url)).status).toBe(401);
      expect((await resourceFetch(url, "other")).status).toBe(404);

      const complete = await resourceFetch(url, "owner");
      expect(complete.status).toBe(200);
      expect(complete.headers.get("accept-ranges")).toBe("bytes");
      expect(complete.headers.get("content-length")).toBe("1024");
      expect(complete.headers.get("etag")).toBe(`"sha256-${resource.digest}"`);
      expect(new Uint8Array(await complete.arrayBuffer())).toEqual(bytes);

      const rotatedClient = await resourceFetch(url, "owner-rotated-client");
      expect(rotatedClient.status).toBe(200);
      expect(new Uint8Array(await rotatedClient.arrayBuffer())).toEqual(bytes);

      const middle = await resourceFetch(url, "owner", undefined, "bytes=100-199");
      expect(middle.status).toBe(206);
      expect(middle.headers.get("content-range")).toBe("bytes 100-199/1024");
      expect(new Uint8Array(await middle.arrayBuffer())).toEqual(bytes.slice(100, 200));

      const suffix = await resourceFetch(url, "owner", undefined, "bytes=-7");
      expect(suffix.status).toBe(206);
      expect(suffix.headers.get("content-range")).toBe("bytes 1017-1023/1024");
      expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(bytes.slice(-7));

      const invalid = await resourceFetch(url, "owner", undefined, "bytes=1024-");
      expect(invalid.status).toBe(416);
      expect(invalid.headers.get("content-range")).toBe("bytes */1024");

      await gateway.stop();
      const restartedStore = new OwnerBoundResourceStore({ dataDirectory });
      expect((await restartedStore.get(resource.id, owner))?.bytes).toEqual(bytes);
    } finally {
      await gateway.stop();
      await resourceStore.clear({ reason: "user_requested" });
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("supports owner-bound compat/full initialize, list, call, notification, cancellation, and session close", async () => {
    const fixture = fakeAppServer();
    const resourceDirectory = await mkdtemp(join(tmpdir(), "omnicodex-protected-results-"));
    let nowUnixMs = Date.now();
    const resourceStore = new OwnerBoundResourceStore({
      dataDirectory: resourceDirectory,
      nowUnixMs: () => nowUnixMs,
    });
    const workSessions = await DurableWorkSessionStore.open({
      dataDirectory: join(resourceDirectory, "work-sessions"),
      hmacKey: Buffer.alloc(32, 90),
    });
    const gateway = gatewayFor(fixture.appServer, {
      resourceStore,
      durableWorkSessionStore: workSessions,
    });
    const address = await gateway.start();
    const compatUrl = `http://${address.host}:${address.port}${address.path}`;
    const fullUrl = `http://${address.host}:${address.port}${address.fullPath}`;
    const compat = new TestMcpClient(compatUrl, "owner");
    const full = new TestMcpClient(fullUrl, "owner");
    try {
      await compat.connect();
      expect(compat.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const compatTools = await compat.request("tools/list", {});
      expect(toolNames(compatTools)).toEqual(
        expect.arrayContaining([
          "search_native_tools",
          "call_native_tool",
          "app_server_rpc",
          "codex__functions__exec",
        ]),
      );

      await full.connect();
      expect(full.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const expiredHistory = await fetch(fullUrl, {
        headers: {
          Accept: "text/event-stream",
          Authorization: "Bearer owner",
          "Last-Event-ID": "missing.1",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": full.sessionId as string,
        },
      });
      expect(expiredHistory.status).toBe(400);
      await expect(expiredHistory.json()).resolves.toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32016, message: "EVENT_HISTORY_EXPIRED" },
      });
      const fullCatalog = await listCompleteToolCatalog(full);
      const fullToolNames = fullCatalog.tools.map((tool) => tool.name);
      const goalToolNames = [
        "omnicodex__goal_create",
        "omnicodex__goal_get",
        "omnicodex__goal_list",
        "omnicodex__goal_claim_next_step",
        "omnicodex__goal_complete",
        "omnicodex__goal_delete",
      ];
      for (const name of goalToolNames) {
        expect(fullToolNames.filter((candidate) => candidate === name)).toHaveLength(1);
      }
      expect(fullToolNames).toContain("codex_app__send_message_to_thread");
      expect(fullToolNames).toContain("codex__functions__exec");
      expect(fullToolNames).toContain("ping");
      expect(new Set(fullToolNames).size).toBe(fullToolNames.length);

      const publicSend = fullCatalog.tools.find(
        (tool) => tool.name === "codex_app__send_message_to_thread",
      );
      expect(publicSend?.inputSchema).toMatchObject({
        type: "object",
        properties: {
          threadId: { type: "string" },
          hostId: { type: "string" },
          prompt: { type: "string", minLength: 1 },
          model: { type: "string" },
          thinking: {
            type: "string",
            enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
          },
        },
        required: ["threadId", "prompt"],
        additionalProperties: false,
      });
      const publicSendSchema = isObject(publicSend?.inputSchema) ? publicSend.inputSchema : {};
      expect(
        isObject(publicSendSchema.properties)
          ? publicSendSchema.properties.omnicodexGoalContext
          : undefined,
      ).toBeUndefined();
      expect(
        isObject(publicSendSchema.properties)
          ? publicSendSchema.properties.omnicodexInvocationId
          : undefined,
      ).toBeUndefined();

      const publicExec = fullCatalog.tools.find((tool) => tool.name === "codex__functions__exec");
      expect(publicExec).toMatchObject({
        name: "codex__functions__exec",
        inputSchema: {
          type: "object",
          properties: {
            input: { type: "string" },
          },
          required: ["input"],
          additionalProperties: false,
        },
      });
      expect(isObject(publicExec) ? publicExec.description : undefined).toContain(
        "native Codex tools",
      );
      const repeatedFirstPage = await full.request("tools/list", {});
      expect(toolNames(repeatedFirstPage)).toEqual(fullCatalog.firstPageToolNames);
      expect(
        fullCatalog.tools.some(
          (tool) => isObject(tool._meta) && Object.hasOwn(tool._meta, "omnicodex"),
        ),
      ).toBe(true);

      const catalogSnapshot = await gateway.readFullCatalogSnapshot();
      expect(catalogSnapshot).toMatchObject({
        catalogRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
        catalogToolCount: fullCatalog.tools.length,
        catalogPageToolCounts: fullCatalog.pageToolCounts,
        criticalToolProperties: "input",
        criticalToolRequired: "input",
      });
      expect(catalogSnapshot.criticalToolInputSchemaSha256).toBe(
        semanticDigest(publicExec?.inputSchema),
      );
      expect(catalogSnapshot.criticalToolDescriptionSha256).toBe(
        semanticDigest(isObject(publicExec) ? (publicExec.description ?? "") : ""),
      );
      await expect(
        full.request("tools/call", {
          name: "ping",
          arguments: {
            omnicodexInvocationId: "10000000-0000-4000-8000-000000000001",
          },
        }),
      ).resolves.toMatchObject({ content: [{ type: "text", text: "pong" }] });

      const wrongOwner = await mcpPost(
        fullUrl,
        { jsonrpc: "2.0", id: 99, method: "tools/list", params: {} },
        "other",
        { "MCP-Session-Id": full.sessionId as string, "MCP-Protocol-Version": "2025-06-18" },
      );
      expect(wrongOwner.status).toBe(404);

      const toolListChanged = full.waitForNotification("notifications/tools/list_changed");
      fixture.catalogRevision = 2;
      await gateway.refreshTools();
      await expect(toolListChanged).resolves.toMatchObject({
        method: "notifications/tools/list_changed",
      });
      const changedCatalog = await listCompleteToolCatalog(full);
      expect(changedCatalog.tools.map((tool) => tool.name)).toContain("second_revision");
      expect(changedCatalog.tools).toHaveLength(fullCatalog.tools.length + 1);
      const calledRevision = await full.request("tools/call", {
        name: "second_revision",
        arguments: {
          omnicodexInvocationId: "10000000-0000-4000-8000-000000000007",
        },
      });
      expect(JSON.stringify(calledRevision)).toContain("second");

      const slowRequest = full.requestWithId(50, "tools/call", {
        name: "slow",
        arguments: {
          omnicodexInvocationId: "10000000-0000-4000-8000-000000000002",
        },
      });
      await fixture.slowStarted;
      await full.notify("notifications/cancelled", { requestId: 50, reason: "test cancellation" });
      fixture.releaseSlow();
      void slowRequest.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(full.hasPendingRequest(50)).toBe(true);
      await expect(full.request("tools/list", {})).resolves.toBeDefined();

      const large = await full.request("tools/call", {
        name: "large",
        arguments: {
          omnicodexInvocationId: "10000000-0000-4000-8000-000000000003",
        },
      });
      expect(isObject(large) ? large.structuredContent : undefined).toEqual({
        marker: "structured-only-sentinel",
        payload: "y".repeat(256 * 1024 + 1),
      });
      expect(resourceLinks(large)).toHaveLength(0);
      expect(isObject(large) ? large.content : undefined).toEqual([
        { type: "text", text: "x".repeat(256 * 1024 + 1) },
      ]);
      expect(JSON.stringify(isObject(large) ? large.content : undefined)).not.toContain(
        "structured-only-sentinel",
      );
      const handle = await issueProtectedResultFixture(resourceStore, large);
      expect(handle.resourceId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      const localResourceUrl = `${new URL(fullUrl).origin}/resources/${handle.resourceId}`;
      expect((await fetch(localResourceUrl)).status).toBe(401);
      expect((await resourceFetch(localResourceUrl, "other")).status).toBe(404);
      const delivered = await resourceFetch(
        localResourceUrl,
        "owner",
        undefined,
        undefined,
        "identity",
      );
      expect(delivered.status).toBe(200);
      expect(delivered.headers.get("accept-ranges")).toBe("bytes");
      expect(delivered.headers.get("cache-control")).toBe("private, no-store");
      expect(delivered.headers.get("content-encoding")).toBeNull();
      expect(delivered.headers.get("content-length")).toBe(String(handle.byteLength));
      const deliveredText = await delivered.text();
      expect(deliveredText).toBe(JSON.stringify(large));
      const brotliDelivered = await resourceFetch(
        localResourceUrl,
        "owner",
        undefined,
        undefined,
        "br",
      );
      expect(brotliDelivered.status).toBe(200);
      expect(brotliDelivered.headers.get("content-encoding")).toBe("br");
      expect(brotliDelivered.headers.get("vary")).toContain("Accept-Encoding");
      expect(brotliDelivered.headers.get("content-length")).toBeNull();
      await expect(brotliDelivered.text()).resolves.toBe(deliveredText);
      const gzipDelivered = await resourceFetch(
        localResourceUrl,
        "owner",
        undefined,
        undefined,
        "gzip",
      );
      expect(gzipDelivered.status).toBe(200);
      expect(gzipDelivered.headers.get("content-encoding")).toBe("gzip");
      expect(gzipDelivered.headers.get("vary")).toContain("Accept-Encoding");
      await expect(gzipDelivered.text()).resolves.toBe(deliveredText);
      const firstChunkResult = await full.request("tools/call", {
        name: PROTECTED_RESULT_READ_TOOL,
        arguments: {
          resourceId: handle.resourceId,
          offset: 0,
          ...(handle.readArguments?._omnicodexSession === undefined
            ? {}
            : { _omnicodexSession: handle.readArguments._omnicodexSession }),
        },
      });
      expect(Buffer.byteLength(JSON.stringify(firstChunkResult), "utf8")).toBeLessThan(64 * 1024);
      if (!isObject(firstChunkResult) || !isObject(firstChunkResult.structuredContent)) {
        throw new Error("Missing protected result chunk");
      }
      expect(
        Buffer.byteLength(String(firstChunkResult.structuredContent.chunk), "utf8"),
      ).toBeLessThanOrEqual(64 * 1024);
      expect(firstChunkResult.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringMatching(/^OMNICODEX_PROTECTED_RESULT_CHUNK_V1:/u),
        }),
      ]);
      await expect(readProtectedResultViaTool(full, handle)).resolves.toBe(deliveredText);
      const completeLarge = JSON.parse(deliveredText) as Record<string, unknown>;
      expect(completeLarge.content).toEqual([{ type: "text", text: "x".repeat(256 * 1024 + 1) }]);
      expect(completeLarge.structuredContent).toEqual({
        marker: "structured-only-sentinel",
        payload: "y".repeat(256 * 1024 + 1),
      });
      expect(completeLarge._meta).toMatchObject({
        omnicodex: {
          catalogExposedName: "large",
        },
      });
      const deliveredBytes = Buffer.byteLength(deliveredText, "utf8");
      const middle = await resourceFetch(localResourceUrl, "owner", undefined, "bytes=10-19");
      expect(middle.status).toBe(206);
      expect(middle.headers.get("content-encoding")).toBeNull();
      expect(middle.headers.get("content-range")).toBe(`bytes 10-19/${String(deliveredBytes)}`);
      expect(middle.headers.get("content-length")).toBe("10");
      expect(await middle.text()).toBe(deliveredText.slice(10, 20));
      const suffix = await resourceFetch(localResourceUrl, "owner", undefined, "bytes=-5");
      expect(suffix.status).toBe(206);
      expect(await suffix.text()).toBe(deliveredText.slice(-5));
      const unsatisfiable = await resourceFetch(
        localResourceUrl,
        "owner",
        undefined,
        `bytes=${String(deliveredBytes)}-`,
      );
      expect(unsatisfiable.status).toBe(416);
      expect(unsatisfiable.headers.get("content-range")).toBe(`bytes */${String(deliveredBytes)}`);
      const traversal = await resourceFetch(
        `${new URL(fullUrl).origin}/resources/..%2Fsecret`,
        "owner",
        full.sessionId as string,
      );
      expect(traversal.status).toBe(404);
      const closedSessionId = full.sessionId as string;
      await full.terminateSession();
      const deliveredAfterTransportClose = await resourceFetch(localResourceUrl, "owner");
      expect(deliveredAfterTransportClose.status).toBe(200);
      expect(await deliveredAfterTransportClose.text()).toBe(deliveredText);
      nowUnixMs += 1_001;
      expect((await resourceFetch(localResourceUrl, "owner")).status).toBe(200);
      const afterClose = await mcpPost(
        fullUrl,
        { jsonrpc: "2.0", id: 100, method: "tools/list", params: {} },
        "owner",
        { "MCP-Session-Id": closedSessionId, "MCP-Protocol-Version": "2025-06-18" },
      );
      expect(afterClose.status).toBe(404);

      await gateway.stop();
      const restartedStore = new OwnerBoundResourceStore({
        dataDirectory: resourceDirectory,
        nowUnixMs: () => nowUnixMs,
      });
      const persistedId = handle.resourceId;
      const persistedOwner = authorization("owner", `${metadata.resource}/full`).identity;
      if (persistedOwner === undefined) throw new Error("Missing test owner identity");
      expect((await restartedStore.get(persistedId, persistedOwner))?.byteLength).toBe(
        deliveredBytes,
      );
      await restartedStore.clear({ reason: "user_requested" });
    } finally {
      fixture.releaseSlow();
      await compat.close();
      await full.close();
      await gateway.stop();
      await rm(resourceDirectory, { recursive: true, force: true });
    }
  });

  it("reads the complete native failure using only the model-visible guide and original session attribution", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-model-visible-guide-"));
    const workSessions = await DurableWorkSessionStore.open({
      dataDirectory: join(dataDirectory, "work-sessions"),
      hmacKey: Buffer.alloc(32, 79),
    });
    let now = 0;
    const resourceStore = new OwnerBoundResourceStore({
      dataDirectory: join(dataDirectory, "protected-results"),
      nowUnixMs: () => now,
      defaultTtlMs: 60_000,
    });
    const persist = vi.spyOn(resourceStore, "put");
    const fixture = fakeAppServer();
    const originalRequest = fixture.appServer.request;
    let nativeCalls = 0;
    const native = {
      isError: true,
      content: [{ type: "text", text: `native-failure:${"한🙂".repeat(90_000)}` }],
      structuredContent: { code: "NATIVE_FAILURE", finalRow: "exact-final-row" },
      _meta: {
        nativeTrace: "private-native-trace-fixture",
        browser_use: { screenshot: { url: "data:image/png;base64,Zml4dHVyZQ==" } },
      },
    };
    fixture.appServer.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "mcpServer/tool/call" && isObject(params) && params.tool === "large") {
        nativeCalls += 1;
        return native as T;
      }
      return originalRequest<T>(method, params);
    };
    const gateway = gatewayFor(fixture.appServer, {
      durableWorkSessionStore: workSessions,
      resourceStore,
    });
    const address = await gateway.start();
    const fullUrl = `http://${address.host}:${address.port}${address.fullPath}`;
    const first = new TestMcpClient(fullUrl, "owner");
    const clients = [first];
    const originalAttribution = { "openai/session": "guide-original-approved-conversation" };
    let expectedDigest: string | undefined;
    const read = (
      client: TestMcpClient,
      resourceId: string,
      offset = 0,
      attribution: Record<string, string> = originalAttribution,
    ) =>
      client.request("tools/call", {
        name: PROTECTED_RESULT_READ_TOOL,
        arguments: {
          resourceId,
          offset,
          ...(expectedDigest === undefined ? {} : { expectedDigest }),
        },
        _meta: attribution,
      });
    const newClient = async (owner = "owner") => {
      const client = new TestMcpClient(fullUrl, owner);
      clients.push(client);
      await client.connect();
      return client;
    };
    try {
      await first.connect();
      const wire = await first.request("tools/call", {
        name: "large",
        arguments: { omnicodexInvocationId: "10000000-0000-4000-8000-000000000079" },
        _meta: originalAttribution,
      });
      if (!isObject(wire)) throw new Error("Missing native result");
      // Discard _meta entirely, matching the documented model-visible surface.
      const model = JSON.parse(
        JSON.stringify({ content: wire.content, structuredContent: wire.structuredContent }),
      );
      const guides = model.content.filter(
        (item: { type?: string; text?: string }) =>
          item.type === "text" && item.text?.startsWith(PROTECTED_RESULT_HANDLE_PREFIX),
      );
      expect(guides).toHaveLength(1);
      const guide = JSON.parse(guides[0].text.slice(PROTECTED_RESULT_HANDLE_PREFIX.length));
      expect(Object.keys(guide.readArguments).sort()).toEqual([
        "expectedDigest",
        "offset",
        "resourceId",
      ]);
      expect(guide.readArguments.expectedDigest).toBe(guide.digest);
      expectedDigest = guide.readArguments.expectedDigest;
      expect(guide.retrievalTool).toBe(PROTECTED_RESULT_READ_TOOL);
      expect(model.content[0]).toEqual(native.content[0]);
      expect(model.structuredContent).toEqual(native.structuredContent);
      for (const excluded of [
        "continuationToken",
        "workSessionBinding",
        "_omnicodexSession",
        "journalCursor",
        native._meta.nativeTrace,
      ]) {
        expect(JSON.stringify(model)).not.toContain(excluded);
      }

      const firstChunk = await read(
        first,
        guide.readArguments.resourceId,
        guide.readArguments.offset,
      );
      expect(isObject(firstChunk) && firstChunk.isError).not.toBe(true);
      await first.terminateSession();
      await first.close();
      const reconnected = await newClient();
      const readComplete = async () => {
        let offset = guide.readArguments.offset;
        let complete = "";
        let chunks = 0;
        while (true) {
          const result = await read(reconnected, guide.readArguments.resourceId, offset);
          if (!isObject(result) || !isObject(result.structuredContent))
            throw new Error("Missing chunk");
          const chunk = result.structuredContent;
          expect(result.isError).not.toBe(true);
          expect(chunk.resourceId).toBe(guide.resourceId);
          expect(chunk.digest).toBe(guide.digest);
          expect(chunk.offset).toBe(offset);
          expect(chunk.snapshotIntegrity).toBe("verified");
          expect(chunk.deliveryState).toBe(
            chunk.nextOffset === null ? "end_of_snapshot" : "partial",
          );
          const control =
            isObject(result) && Array.isArray(result.content) ? result.content[0] : undefined;
          expect(isObject(control) && control.text).toContain('"snapshotIntegrity":"verified"');
          if (typeof chunk.chunk !== "string") throw new Error("Invalid chunk");
          complete += chunk.chunk;
          chunks += 1;
          if (chunk.nextOffset === null) break;
          if (typeof chunk.nextOffset !== "number" || chunk.nextOffset <= offset || chunks > 100)
            throw new Error("Invalid cursor");
          offset = chunk.nextOffset;
        }
        expect(chunks).toBeGreaterThan(1);
        if (createHash("sha256").update(complete, "utf8").digest("base64url") !== guide.digest) {
          throw new Error("PROTECTED_RESULT_DIGEST_MISMATCH");
        }
        return complete;
      };
      const complete = await readComplete();
      const persisted = persist.mock.calls[0]?.[0];
      if (persisted === undefined) throw new Error("Missing durable original result");
      expect(persist).toHaveBeenCalledOnce();
      expect(complete).toBe(Buffer.from(persisted.bytes).toString("utf8"));
      expect(JSON.parse(complete)).toMatchObject(native);
      expect(createHash("sha256").update(complete, "utf8").digest("base64url")).toBe(guide.digest);
      const end = await read(reconnected, guide.resourceId, Buffer.byteLength(complete, "utf8"));
      expect(isObject(end) && end.structuredContent).toMatchObject({
        snapshotIntegrity: "verified",
        deliveryState: "end_of_snapshot",
        nextOffset: null,
        chunk: "",
      });

      const denied = async (
        client: TestMcpClient,
        attribution: Record<string, string>,
        id = guide.resourceId,
      ) => {
        const result = await read(client, id, 0, attribution);
        expect(isObject(result) && result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain("exact-final-row");
        expect(JSON.stringify(result)).not.toContain("native-failure:");
        expect(JSON.stringify(result)).not.toContain('"snapshotIntegrity":"verified"');
        expect(
          isObject(result) && isObject(result.structuredContent) && result.structuredContent.chunk,
        ).toBeFalsy();
      };
      await denied(await newClient("other"), originalAttribution);
      await denied(await newClient(), { "openai/session": "guide-different-conversation" });
      await denied(await newClient(), {});
      const tamperedId = `${guide.resourceId[0] === "A" ? "B" : "A"}${guide.resourceId.slice(1)}`;
      await denied(reconnected, originalAttribution, tamperedId);
      const invalidContinuation = await reconnected
        .request("tools/call", {
          name: PROTECTED_RESULT_READ_TOOL,
          arguments: {
            resourceId: guide.resourceId,
            offset: 0,
            _omnicodexSession: {
              workSessionBinding: "wsb1_invalid-fixture",
              continuationToken: "invalid-fixture",
            },
          },
          _meta: originalAttribution,
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : JSON.stringify(error);
          expect(message).toMatch(/WORK_SESSION|work.session|continuation/iu);
          return { isError: true };
        });
      expect(isObject(invalidContinuation) && invalidContinuation.isError).toBe(true);
      const unauthorized = await mcpPost(
        fullUrl,
        {
          jsonrpc: "2.0",
          id: 99,
          method: "tools/call",
          params: {
            name: PROTECTED_RESULT_READ_TOOL,
            arguments: guide.readArguments,
            _meta: originalAttribution,
          },
        },
        undefined,
      );
      expect(unauthorized.status).toBe(401);
      const payloadPath = join(dataDirectory, "protected-results", guide.resourceId, "payload.bin");
      const originalBytes = Buffer.from(persisted.bytes);
      const corrupted = Buffer.from(originalBytes);
      corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 0x01;
      await writeFile(payloadPath, corrupted);
      await denied(reconnected, originalAttribution);
      const manifestPath = join(
        dataDirectory,
        "protected-results",
        guide.resourceId,
        "manifest.json",
      );
      const manifestBytes = await readFile(manifestPath);
      const changedManifest = JSON.parse(manifestBytes.toString("utf8"));
      changedManifest.digest = createHash("sha256").update(corrupted).digest("base64url");
      await writeFile(manifestPath, JSON.stringify(changedManifest));
      await denied(reconnected, originalAttribution);
      await writeFile(manifestPath, manifestBytes);
      const corruptEnd = await read(reconnected, guide.resourceId, originalBytes.byteLength);
      expect(isObject(corruptEnd) && corruptEnd.isError).toBe(true);
      expect(
        isObject(corruptEnd) &&
          isObject(corruptEnd.structuredContent) &&
          corruptEnd.structuredContent.chunk,
      ).toBeFalsy();
      await writeFile(payloadPath, originalBytes.subarray(0, -1));
      await denied(reconnected, originalAttribution);
      await writeFile(payloadPath, Buffer.concat([originalBytes, Buffer.of(0)]));
      await denied(reconnected, originalAttribution);
      await writeFile(payloadPath, originalBytes);
      now = 60_001;
      await denied(reconnected, originalAttribution);
      expect(nativeCalls).toBe(1);
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await gateway.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("reads a protected result from a new MCP transport using the durable handle binding", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-protected-reconnect-"));
    const workSessions = await DurableWorkSessionStore.open({
      dataDirectory: join(dataDirectory, "work-sessions"),
      hmacKey: Buffer.alloc(32, 89),
    });
    const resourceStore = new OwnerBoundResourceStore({
      dataDirectory: join(dataDirectory, "protected-results"),
    });
    const gateway = gatewayFor(fakeAppServer().appServer, {
      durableWorkSessionStore: workSessions,
      resourceStore,
    });
    const address = await gateway.start();
    const fullUrl = `http://${address.host}:${address.port}${address.fullPath}`;
    const first = new TestMcpClient(fullUrl, "owner");
    let second: TestMcpClient | undefined;

    try {
      await first.connect();
      const large = await first.request("tools/call", {
        name: "large",
        arguments: {
          omnicodexInvocationId: "10000000-0000-4000-8000-000000000019",
        },
        _meta: { "openai/session": "protected-result-web-conversation" },
      });
      const handle = await issueProtectedResultFixture(resourceStore, large);
      expect(handle.readArguments).toMatchObject({
        resourceId: handle.resourceId,
        offset: 0,
        _omnicodexSession: {
          workSessionBinding: expect.any(String),
          continuationToken: expect.any(String),
        },
      });

      await first.terminateSession();
      await first.close();
      second = new TestMcpClient(fullUrl, "owner");
      await second.connect();

      const recovered = await readProtectedResultViaTool(second, handle);
      expect(recovered).toBe(JSON.stringify(large));
      const exactResult = JSON.parse(recovered) as Record<string, unknown>;
      expect(exactResult.content).toEqual([{ type: "text", text: "x".repeat(256 * 1024 + 1) }]);
      expect(exactResult.structuredContent).toEqual({
        marker: "structured-only-sentinel",
        payload: "y".repeat(256 * 1024 + 1),
      });
    } finally {
      await Promise.allSettled([first.close(), second?.close()]);
      await gateway.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("emits unref'ed SSE comment keepalives without JSON-RPC and preserves replay validation", async () => {
    const gateway = gatewayFor(fakeAppServer().appServer);
    const address = await gateway.start();
    const fullUrl = `http://${address.host}:${address.port}${address.fullPath}`;
    const client = new TestMcpClient(fullUrl, "owner");
    const streamAbort = new AbortController();
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    let stream: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      await client.connect(false);
      await completeRawInitialization(fullUrl, client.sessionId as string);
      const headers = standaloneSseHeaders(client.sessionId as string);

      stream = await fetch(fullUrl, { headers, signal: streamAbort.signal });
      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      expect(stream.headers.get("x-accel-buffering")).toBe("no");

      const expiredHistory = await fetch(fullUrl, {
        headers: { ...headers, "Last-Event-ID": "missing.1" },
      });
      expect(expiredHistory.status).toBe(400);
      await expect(expiredHistory.json()).resolves.toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32016, message: "EVENT_HISTORY_EXPIRED" },
      });

      let keepaliveCallIndex = -1;
      for (let attempt = 0; attempt < 20 && keepaliveCallIndex < 0; attempt += 1) {
        keepaliveCallIndex = intervalSpy.mock.calls.findIndex((call) => call[1] === 15_000);
        if (keepaliveCallIndex < 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(keepaliveCallIndex).toBeGreaterThanOrEqual(0);
      const keepaliveTimer = intervalSpy.mock.results[keepaliveCallIndex]?.value as NodeJS.Timeout;
      expect(keepaliveTimer.hasRef()).toBe(false);
      const keepaliveTick = intervalSpy.mock.calls[keepaliveCallIndex]?.[0];
      if (typeof keepaliveTick !== "function") throw new Error("Missing keepalive callback");

      reader = stream.body?.getReader();
      keepaliveTick();
      const chunk = await reader?.read();
      expect(chunk?.done).toBe(false);
      const text = new TextDecoder().decode(chunk?.value);
      expect(text).toBe(": keepalive\n\n");
      expect(text).not.toContain("jsonrpc");
    } finally {
      streamAbort.abort();
      await Promise.allSettled([reader?.cancel(), stream?.body?.cancel(), client.close()]);
      await gateway.stop();
      intervalSpy.mockRestore();
    }
  });

  it("keeps multiple same-session SSE GETs open with single-stream delivery and independent close", async () => {
    const fixture = fakeAppServer();
    const gateway = gatewayFor(fixture.appServer);
    const address = await gateway.start();
    const fullUrl = `http://${address.host}:${address.port}${address.fullPath}`;
    const client = new TestMcpClient(fullUrl, "owner");
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    let firstStream: Response | undefined;
    let secondStream: Response | undefined;
    let firstReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let secondReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      await client.connect(false);
      await completeRawInitialization(fullUrl, client.sessionId as string);
      await client.request("tools/list", {});
      const headers = standaloneSseHeaders(client.sessionId as string);
      firstStream = await fetch(fullUrl, { headers, signal: firstAbort.signal });
      expect(firstStream.status).toBe(200);
      secondStream = await fetch(fullUrl, { headers, signal: secondAbort.signal });
      expect(secondStream.status).toBe(200);
      expect(secondStream.headers.get("content-type")).toContain("text/event-stream");
      expect(secondStream.headers.get("x-accel-buffering")).toBe("no");
      firstReader = firstStream.body?.getReader();
      secondReader = secondStream.body?.getReader();
      const secondRead = secondReader?.read().catch(() => ({ done: true, value: undefined }));

      fixture.catalogRevision = 2;
      await gateway.refreshTools();
      const delivered = await Promise.race([
        firstReader?.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Primary SSE delivery timed out")), 1_000),
        ),
      ]);
      const deliveredText = new TextDecoder().decode(delivered?.value);
      expect(deliveredText).toContain('"method":"notifications/tools/list_changed"');
      expect(
        await Promise.race([
          secondRead?.then(() => "delivered" as const),
          new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
        ]),
      ).toBe("pending");

      const keepaliveCalls = intervalSpy.mock.calls.filter(
        (call) => call[1] === 15_000 && typeof call[0] === "function",
      );
      expect(keepaliveCalls).toHaveLength(2);
      firstAbort.abort();
      await Promise.allSettled([firstReader?.cancel()]);
      await new Promise((resolve) => setTimeout(resolve, 50));

      fixture.catalogRevision = 3;
      await gateway.refreshTools();
      const promotedChunk = await Promise.race([
        secondRead,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Passive SSE was not promoted for delivery")), 1_000),
        ),
      ]);
      const promotedText = new TextDecoder().decode(promotedChunk?.value);
      expect(promotedChunk?.done).toBe(false);
      expect(promotedText).toContain('"method":"notifications/tools/list_changed"');

      const passiveKeepaliveTick = keepaliveCalls[1]?.[0];
      if (typeof passiveKeepaliveTick !== "function") throw new Error("Missing passive keepalive");
      const passiveKeepalive = secondReader?.read();
      passiveKeepaliveTick();
      const passiveChunk = await Promise.race([
        passiveKeepalive,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Passive SSE closed with primary")), 1_000),
        ),
      ]);
      const passiveText = new TextDecoder().decode(passiveChunk?.value);
      expect(passiveChunk?.done).toBe(false);
      expect(passiveText).toBe(": keepalive\n\n");
      expect(passiveText).not.toContain("jsonrpc");

      await expect(client.request("tools/list", {})).resolves.toBeDefined();
    } finally {
      firstAbort.abort();
      secondAbort.abort();
      await Promise.allSettled([
        firstReader?.cancel(),
        secondReader?.cancel(),
        firstStream?.body?.cancel(),
        secondStream?.body?.cancel(),
        client.close(),
      ]);
      await gateway.stop();
      intervalSpy.mockRestore();
    }
  });

  it("accepts concurrent Last-Event-ID resumes and replays only the originating stream", async () => {
    const fixture = fakeAppServer();
    const gateway = gatewayFor(fixture.appServer);
    const address = await gateway.start();
    const fullUrl = `http://${address.host}:${address.port}${address.fullPath}`;
    const client = new TestMcpClient(fullUrl, "owner");
    const primaryAbort = new AbortController();
    const passiveAbort = new AbortController();
    const resumeAbort = new AbortController();
    let primary: Response | undefined;
    let passive: Response | undefined;
    let resumed: Response | undefined;
    let primaryReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let passiveReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let resumedReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      await client.connect(false);
      await completeRawInitialization(fullUrl, client.sessionId as string);
      await client.request("tools/list", {});
      const headers = standaloneSseHeaders(client.sessionId as string);
      primary = await fetch(fullUrl, { headers, signal: primaryAbort.signal });
      passive = await fetch(fullUrl, { headers, signal: passiveAbort.signal });
      expect(primary.status).toBe(200);
      expect(passive.status).toBe(200);
      primaryReader = primary.body?.getReader();
      passiveReader = passive.body?.getReader();

      fixture.catalogRevision = 2;
      await gateway.refreshTools();
      const firstText = new TextDecoder().decode((await primaryReader?.read())?.value);
      const firstEventId = sseEventId(firstText);

      // This response is stored under a POST response stream between the two
      // standalone events and must not be replayed by the originating-stream cursor.
      await client.request("tools/list", {});
      fixture.catalogRevision = 3;
      await gateway.refreshTools();
      const secondText = new TextDecoder().decode((await primaryReader?.read())?.value);
      const secondEventId = sseEventId(secondText);

      resumed = await fetch(fullUrl, {
        headers: { ...headers, "Last-Event-ID": firstEventId },
        signal: resumeAbort.signal,
      });
      expect(resumed.status).toBe(200);
      expect(resumed.headers.get("content-type")).toContain("text/event-stream");
      expect(resumed.headers.get("x-accel-buffering")).toBe("no");
      resumedReader = resumed.body?.getReader();
      const replayText = new TextDecoder().decode((await resumedReader?.read())?.value);
      expect(sseEventId(replayText)).toBe(secondEventId);
      expect(replayText).toContain('"method":"notifications/tools/list_changed"');

      const passiveRead = passiveReader?.read().catch(() => ({ done: true, value: undefined }));
      const resumedRead = resumedReader?.read().catch(() => ({ done: true, value: undefined }));
      fixture.catalogRevision = 4;
      await gateway.refreshTools();
      const primaryOnlyText = new TextDecoder().decode((await primaryReader?.read())?.value);
      expect(primaryOnlyText).toContain('"method":"notifications/tools/list_changed"');
      expect(
        await Promise.race([
          passiveRead?.then(() => "delivered" as const),
          new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
        ]),
      ).toBe("pending");
      expect(
        await Promise.race([
          resumedRead?.then(() => "delivered" as const),
          new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
        ]),
      ).toBe("pending");

      primaryAbort.abort();
      await Promise.allSettled([primaryReader?.cancel()]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      fixture.catalogRevision = 5;
      await gateway.refreshTools();
      const promotedText = new TextDecoder().decode((await passiveRead)?.value);
      expect(promotedText).toContain('"method":"notifications/tools/list_changed"');
      expect(
        await Promise.race([
          resumedRead?.then(() => "delivered" as const),
          new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
        ]),
      ).toBe("pending");
      await expect(client.request("tools/list", {})).resolves.toBeDefined();
    } finally {
      primaryAbort.abort();
      passiveAbort.abort();
      resumeAbort.abort();
      await Promise.allSettled([
        primaryReader?.cancel(),
        passiveReader?.cancel(),
        resumedReader?.cancel(),
        primary?.body?.cancel(),
        passive?.body?.cancel(),
        resumed?.body?.cancel(),
        client.close(),
      ]);
      await gateway.stop();
    }
  });

  it("delivers five 240 KiB image results while a standalone GET remains alive", async () => {
    const gateway = gatewayFor(fakeAppServer(0, true).appServer);
    const address = await gateway.start();
    const fullUrl = `http://${address.host}:${address.port}${address.fullPath}`;
    const client = new TestMcpClient(fullUrl, "owner");
    const streamAbort = new AbortController();
    let stream: Response | undefined;

    try {
      await client.connect(false);
      await completeRawInitialization(fullUrl, client.sessionId as string);
      stream = await fetch(fullUrl, {
        headers: standaloneSseHeaders(client.sessionId as string),
        signal: streamAbort.signal,
      });
      expect(stream.status).toBe(200);

      const result = await client.request("tools/call", {
        name: "images",
        arguments: {
          omnicodexInvocationId: "10000000-0000-4000-8000-000000000007",
        },
      });
      if (!isObject(result) || !Array.isArray(result.content)) {
        throw new Error("Missing image result content");
      }
      expect(result.content.map((item) => (isObject(item) ? item.type : undefined))).toEqual([
        "image",
        "image",
        "image",
        "image",
        "image",
      ]);
      expect(
        result.content.map((item) =>
          isObject(item) ? { type: item.type, data: item.data, mimeType: item.mimeType } : item,
        ),
      ).toEqual(
        Array.from({ length: 5 }, (_, index) => ({
          type: "image",
          data: Buffer.alloc(240 * 1024, index + 1).toString("base64"),
          mimeType: "image/png",
        })),
      );
      expect(stream.body).not.toBeNull();
    } finally {
      streamAbort.abort();
      await Promise.allSettled([stream?.body?.cancel(), client.close()]);
      await gateway.stop();
    }
  });

  it("shares native execution lanes across independent MCP sessions", async () => {
    let shellCallCount = 0;
    let resolveFirstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const appServer: AppServerRpcClient = {
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "mcpServerStatus/list") {
          return {
            data: [
              {
                name: "demo",
                tools: {
                  shell_command: {
                    name: "shell_command",
                    inputSchema: { type: "object" },
                  },
                },
              },
            ],
            nextCursor: null,
          } as T;
        }
        if (method === "thread/start") {
          return { thread: { id: "urn:uuid:ephemeral" } } as T;
        }
        if (method === "mcpServer/tool/call") {
          expect(isObject(params) ? params.tool : undefined).toBe("shell_command");
          shellCallCount += 1;
          const callNumber = shellCallCount;
          if (callNumber === 1) {
            resolveFirstStarted();
            await firstGate;
          }
          return {
            content: [{ type: "text", text: `shell-${callNumber}` }],
          } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    const gateway = gatewayFor(appServer);
    const address = await gateway.start();
    const fullUrl = `http://${address.host}:${address.port}${address.fullPath}`;
    const firstClient = new TestMcpClient(fullUrl, "owner");
    const secondClient = new TestMcpClient(fullUrl, "owner");
    try {
      await Promise.all([firstClient.connect(), secondClient.connect()]);
      const firstCall = firstClient.request("tools/call", {
        name: "shell_command",
        arguments: {
          omnicodexInvocationId: "10000000-0000-4000-8000-000000000101",
        },
      });
      await firstStarted;

      const secondCall = secondClient.request("tools/call", {
        name: "shell_command",
        arguments: {
          omnicodexInvocationId: "10000000-0000-4000-8000-000000000102",
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(shellCallCount).toBe(1);

      releaseFirst();
      await expect(firstCall).resolves.toMatchObject({
        content: [{ type: "text", text: "shell-1" }],
      });
      await expect(secondCall).resolves.toMatchObject({
        content: [{ type: "text", text: "shell-2" }],
      });
      expect(shellCallCount).toBe(2);
    } finally {
      releaseFirst();
      await Promise.allSettled([firstClient.close(), secondClient.close()]);
      await gateway.stop();
    }
  });

  it("joins and replays one explicit read across independent Web transports", async () => {
    const threadId = "thread-shared-read-private";
    const privatePath = "C:\\private\\shared-read.txt";
    let threadReadCalls = 0;
    let metadataCalls = 0;
    let releaseThreadRead!: () => void;
    let markThreadReadStarted!: () => void;
    const threadReadStarted = new Promise<void>((resolve) => {
      markThreadReadStarted = resolve;
    });
    const threadReadGate = new Promise<void>((resolve) => {
      releaseThreadRead = resolve;
    });
    const appServer: AppServerRpcClient = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        if (method === "thread/read") {
          threadReadCalls += 1;
          if (threadReadCalls === 1) {
            markThreadReadStarted();
            await threadReadGate;
          }
          return {
            thread: { id: threadId, cwd: "C:\\private", status: { type: "idle" } },
          } as T;
        }
        if (method === "thread/turns/list" || method === "thread/items/list") {
          return { data: [], nextCursor: null } as T;
        }
        if (method === "fs/getMetadata") {
          metadataCalls += 1;
          return { kind: "file", size: 7 } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    const appServerMethodCatalog = new AppServerMethodCatalog({
      loadClientRequestSchema: async () => ({
        definitions: {
          FsGetMetadataParams: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
        oneOf: [
          {
            title: "Fs/getMetadataRequest",
            properties: {
              method: { enum: ["fs/getMetadata"] },
              params: { $ref: "#/definitions/FsGetMetadataParams" },
            },
          },
        ],
      }),
    });
    const readObservations: McpReadInvocationObservation[] = [];
    const nativeObservations: NativeToolExecutionObservation[] = [];
    let markJoinObserved!: () => void;
    const joinObserved = new Promise<void>((resolve) => {
      markJoinObserved = resolve;
    });
    const gateway = gatewayFor(appServer, {
      appServerMethodCatalog,
      observeReadInvocation: (observation) => {
        readObservations.push(observation);
        if (observation.disposition === "join") markJoinObserved();
      },
      observeNativeToolExecution: (observation) => {
        nativeObservations.push(observation);
      },
    });
    const address = await gateway.start();
    const fullUrl = `http://${address.host}:${address.port}${address.fullPath}`;
    const first = new TestMcpClient(fullUrl, "owner");
    const second = new TestMcpClient(fullUrl, "owner");
    const other = new TestMcpClient(fullUrl, "other");
    const invocationId = "10000000-0000-4000-8000-000000000301";
    const readArguments = {
      threadId,
      turnLimit: 1,
      maxItemsPerTurn: 64,
    };
    const invocationMeta = { "openai/toolInvocationId": invocationId };
    try {
      await Promise.all([first.connect(), second.connect(), other.connect()]);
      const leader = first.requestWithId(301, "tools/call", {
        name: "codex_app__read_thread",
        arguments: readArguments,
        _meta: invocationMeta,
      });
      await threadReadStarted;
      await first.notify("notifications/cancelled", {
        requestId: 301,
        reason: "transport retry while native read continues",
      });
      const joined = second.request("tools/call", {
        name: "codex_app__read_thread",
        arguments: readArguments,
        _meta: invocationMeta,
      });
      await Promise.race([
        joinObserved,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("cross-transport read did not join")), 1_000),
        ),
      ]);
      expect(threadReadCalls).toBe(1);
      releaseThreadRead();
      const joinedResult = await joined;
      void leader.catch(() => undefined);
      expect(threadReadCalls).toBe(1);

      await expect(
        second.request("tools/call", {
          name: "codex_app__read_thread",
          arguments: readArguments,
          _meta: invocationMeta,
        }),
      ).resolves.toEqual(joinedResult);
      expect(threadReadCalls).toBe(1);

      await Promise.all([
        first.request("tools/call", {
          name: "codex__app_server__fs_getMetadata",
          arguments: { path: privatePath },
          _meta: invocationMeta,
        }),
        second.request("tools/call", {
          name: "codex__app_server__fs_getMetadata",
          arguments: { path: privatePath },
          _meta: invocationMeta,
        }),
      ]);
      expect(metadataCalls).toBe(1);

      await expect(
        second.request("tools/call", {
          name: "codex_app__read_thread",
          arguments: { ...readArguments, turnLimit: 2 },
          _meta: invocationMeta,
        }),
      ).resolves.toMatchObject({ isError: true });
      expect(threadReadCalls).toBe(1);

      await expect(
        other.request("tools/call", {
          name: "codex__app_server__fs_getMetadata",
          arguments: { path: privatePath },
          _meta: invocationMeta,
        }),
      ).resolves.not.toMatchObject({ isError: true });
      expect(metadataCalls).toBe(2);

      expect(readObservations.map((observation) => observation.disposition)).toEqual(
        expect.arrayContaining(["execute", "dispatch", "join", "replay", "conflict"]),
      );
      expect(
        nativeObservations.filter((observation) => observation.invocationIdSha256 !== undefined),
      ).toHaveLength(3);
      const serializedObservations = JSON.stringify(readObservations);
      expect(serializedObservations).not.toContain(threadId);
      expect(serializedObservations).not.toContain(privatePath);
      expect(serializedObservations).not.toContain(invocationId);
    } finally {
      releaseThreadRead();
      await Promise.allSettled([first.close(), second.close(), other.close()]);
      await gateway.stop();
    }
  });

  it("executes traced reads from distinct ChatGPT sessions independently", async () => {
    const threadId = "thread-traced-transport-read";
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-gateway-traced-turn-"));
    const workSessions = await DurableWorkSessionStore.open({
      dataDirectory,
      hmacKey: Buffer.alloc(32, 61),
    });
    let physicalReads = 0;
    const appServer: AppServerRpcClient = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        if (method === "thread/read") {
          physicalReads += 1;
          return {
            thread: { id: threadId, cwd: "C:\\traced", status: { type: "idle" } },
          } as T;
        }
        if (method === "thread/turns/list" || method === "thread/items/list") {
          return { data: [], nextCursor: null } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    const observations: McpReadInvocationObservation[] = [];
    const scheduler = new RecordingGatewayScheduler();
    const gateway = gatewayFor(appServer, {
      scheduler,
      durableWorkSessionStore: workSessions,
      observeReadInvocation: (observation) => {
        observations.push(observation);
      },
    });
    const address = await gateway.start();
    const fullUrl = `http://${address.host}:${address.port}${address.fullPath}`;
    const client = (traceId: string, spanId: string) =>
      new TestMcpClient(fullUrl, "owner", {
        traceparent: `00-${traceId}-${spanId}-01`,
      });
    const first = client("1234567890abcdef1234567890abcde1", "1111111111111111");
    const second = client("1234567890abcdef1234567890abcde2", "2222222222222222");
    const third = client("1234567890abcdef1234567890abcde3", "3333333333333333");
    const call = (target: TestMcpClient, requestId: number, session: string) =>
      target.requestWithId(requestId, "tools/call", {
        name: "codex_app__read_thread",
        arguments: { threadId, turnLimit: 1 },
        _meta: { "openai/session": session },
      });
    try {
      await Promise.all([first.connect(), second.connect()]);
      const [leaderResult, independentResult] = await Promise.all([
        call(first, 501, "transport-chat-a"),
        call(second, 502, "transport-chat-b"),
      ]);
      expect(isObject(independentResult) ? independentResult.content : undefined).toEqual(
        isObject(leaderResult) ? leaderResult.content : undefined,
      );
      expect(physicalReads).toBe(2);

      await third.connect();
      const thirdResult = await call(third, 503, "transport-chat-c");
      expect(isObject(thirdResult) ? thirdResult.content : undefined).toEqual(
        isObject(leaderResult) ? leaderResult.content : undefined,
      );
      expect(physicalReads).toBe(3);
      expect(observations).toHaveLength(6);
      expect(observations.map((observation) => observation.disposition)).toEqual([
        "execute",
        "dispatch",
        "execute",
        "dispatch",
        "execute",
        "dispatch",
      ]);
      expect(observations.every((observation) => observation.identityMode === "transport")).toBe(
        true,
      );
      expect(scheduler.requests).toHaveLength(3);
    } finally {
      await Promise.allSettled([first.close(), second.close(), third.close()]);
      await gateway.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("joins concurrent traced reads but refreshes a later read without a tool invocation id", async () => {
    const threadId = "thread-live-transport-read";
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-gateway-live-read-"));
    const workSessions = await DurableWorkSessionStore.open({
      dataDirectory,
      hmacKey: Buffer.alloc(32, 62),
    });
    let physicalReads = 0;
    let releaseFirstRead!: () => void;
    let markFirstReadStarted!: () => void;
    const firstReadStarted = new Promise<void>((resolve) => {
      markFirstReadStarted = resolve;
    });
    const firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    const appServer: AppServerRpcClient = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        if (method === "thread/read") {
          physicalReads += 1;
          if (physicalReads === 1) {
            markFirstReadStarted();
            await firstReadGate;
          }
          return {
            thread: {
              id: threadId,
              cwd: "C:\\live",
              name: `physical-read-${String(physicalReads)}`,
              status: { type: "idle" },
            },
          } as T;
        }
        if (method === "thread/turns/list" || method === "thread/items/list") {
          return { data: [], nextCursor: null } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    const observations: McpReadInvocationObservation[] = [];
    let markJoinObserved!: () => void;
    const joinObserved = new Promise<void>((resolve) => {
      markJoinObserved = resolve;
    });
    const gateway = gatewayFor(appServer, {
      durableWorkSessionStore: workSessions,
      observeReadInvocation: (observation) => {
        observations.push(observation);
        if (observation.disposition === "join") markJoinObserved();
      },
    });
    const address = await gateway.start();
    const fullUrl = `http://${address.host}:${address.port}${address.fullPath}`;
    const traceId = "abcdefabcdefabcdefabcdefabcdefab";
    const client = (spanId: string) =>
      new TestMcpClient(fullUrl, "owner", {
        traceparent: `00-${traceId}-${spanId}-01`,
      });
    const first = client("1111111111111111");
    const second = client("2222222222222222");
    const third = client("3333333333333333");
    const callWithSameTransportIdentity = (target: TestMcpClient) =>
      target.requestWithId(401, "tools/call", {
        name: "codex_app__read_thread",
        arguments: { threadId, turnLimit: 1 },
      });
    try {
      await Promise.all([first.connect(), second.connect()]);
      const leader = callWithSameTransportIdentity(first);
      await firstReadStarted;
      const joined = callWithSameTransportIdentity(second);
      await Promise.race([
        joinObserved,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("traced transport read did not join")), 1_000),
        ),
      ]);
      expect(physicalReads).toBe(1);
      releaseFirstRead();
      const [leaderResult, joinedResult] = await Promise.all([leader, joined]);
      expect(isObject(joinedResult) ? joinedResult.content : undefined).toEqual(
        isObject(leaderResult) ? leaderResult.content : undefined,
      );
      expect(physicalReads).toBe(1);

      await third.connect();
      const freshResult = await callWithSameTransportIdentity(third);
      expect(physicalReads).toBe(2);
      expect(JSON.stringify(freshResult)).toContain("physical-read-2");
      expect(JSON.stringify(leaderResult)).toContain("physical-read-1");
      expect(observations.map((observation) => observation.disposition)).toEqual(
        expect.arrayContaining(["execute", "dispatch", "join"]),
      );
      expect(observations.some((observation) => observation.disposition === "replay")).toBe(false);
    } finally {
      releaseFirstRead();
      await Promise.allSettled([first.close(), second.close(), third.close()]);
      await gateway.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("binds opaque owner/session identity and exact request bytes to native admission", async () => {
    const scheduler = new RecordingGatewayScheduler();
    const gateway = gatewayFor(fakeAppServer().appServer, { scheduler });
    const address = await gateway.start();
    const fullUrl = `http://${address.host}:${address.port}${address.fullPath}`;
    const first = new TestMcpClient(fullUrl, "owner");
    const second = new TestMcpClient(fullUrl, "owner");
    try {
      await Promise.all([first.connect(), second.connect()]);
      await Promise.all([
        first.request("tools/call", {
          name: "ping",
          arguments: { omnicodexInvocationId: "10000000-0000-4000-8000-000000000201" },
        }),
        second.request("tools/call", {
          name: "ping",
          arguments: { omnicodexInvocationId: "10000000-0000-4000-8000-000000000202" },
        }),
      ]);
      expect(scheduler.requests).toHaveLength(2);
      const [firstRequest, secondRequest] = scheduler.requests;
      expect(firstRequest?.ownerId).toMatch(/^[a-f0-9]{64}$/u);
      expect(secondRequest?.ownerId).toBe(firstRequest?.ownerId);
      expect(firstRequest?.sessionId).toMatch(/^[a-f0-9]{32}$/);
      expect(secondRequest?.sessionId).toMatch(/^[a-f0-9]{32}$/);
      expect(secondRequest?.sessionId).not.toBe(firstRequest?.sessionId);
      expect(firstRequest?.requestBytes).toBeGreaterThan(0);
      expect(secondRequest?.requestBytes).toBeGreaterThan(0);
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
      await gateway.stop();
    }
  });

  it("creates and closes mutable executors exactly once per authenticated MCP session", async () => {
    const created: string[] = [];
    const closed: string[] = [];
    const gateway = gatewayFor(fakeAppServer().appServer, {
      createSessionExecutors: (context) => {
        created.push(context.correlationId);
        expect(context.authorizationBinding).toContain("auth0|owner");
        return {
          responsesToolExecutor: codeModeResponsesExecutor(),
          close: async () => {
            closed.push(context.correlationId);
          },
        };
      },
    });
    const address = await gateway.start();
    const fullUrl = `http://${address.host}:${address.port}${address.fullPath}`;
    const first = new TestMcpClient(fullUrl, "owner");
    const second = new TestMcpClient(fullUrl, "owner");
    try {
      await Promise.all([first.connect(), second.connect()]);
      expect(created).toHaveLength(2);
      expect(new Set(created).size).toBe(2);
      await first.terminateSession();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toHaveLength(1);
      expect(created).toContain(closed[0]);
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
      await gateway.stop();
    }
    expect([...closed].sort()).toEqual([...created].sort());
  });

  it("retires an abandoned local operator session after its idle time but keeps Web sessions", async () => {
    const closed: string[] = [];
    const gateway = gatewayFor(fakeAppServer().appServer, {
      localTransportSessionIdleMs: 50,
      createSessionExecutors: (context) => ({
        close: async () => {
          closed.push(context.identity.clientId);
        },
      }),
    });
    const address = await gateway.start();
    const fullUrl = `http://${address.host}:${address.port}${address.fullPath}`;
    const local = new TestMcpClient(fullUrl, "transport-owner");
    const web = new TestMcpClient(fullUrl, "owner");
    try {
      await Promise.all([local.connect(), web.connect()]);
      // Drop the local transport without DELETE, like a script that exits after one call.
      await local.close();
      const deadline = Date.now() + 5_000;
      while (!closed.includes("omnicodex-cli") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(closed).toContain("omnicodex-cli");
      expect(closed).not.toContain("client-id");
    } finally {
      await Promise.allSettled([local.close(), web.close()]);
      await gateway.stop();
    }
  });

  it("keeps local operator executors transport-scoped while Web conversations remain durable", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-local-operator-lifecycle-"));
    const workSessions = await DurableWorkSessionStore.open({
      dataDirectory,
      hmacKey: Buffer.alloc(32, 97),
    });
    const contexts: Array<{ readonly clientId: string; readonly durable: boolean }> = [];
    const closed: string[] = [];
    let noteLocalCloseStarted!: () => void;
    const localCloseStarted = new Promise<void>((resolve) => {
      noteLocalCloseStarted = resolve;
    });
    let releaseLocalClose!: () => void;
    const localCloseRelease = new Promise<void>((resolve) => {
      releaseLocalClose = resolve;
    });
    const gateway = gatewayFor(fakeAppServer().appServer, {
      durableWorkSessionStore: workSessions,
      createSessionExecutors: (context) => {
        contexts.push({
          clientId: context.identity.clientId,
          durable: context.resolveWorkSessionBinding !== undefined,
        });
        return {
          close: async () => {
            if (context.identity.clientId === "omnicodex-cli") {
              noteLocalCloseStarted();
              await localCloseRelease;
            }
            closed.push(context.identity.clientId);
          },
        };
      },
    });
    const address = await gateway.start();
    const fullUrl = `http://${address.host}:${address.port}${address.fullPath}`;
    const local = new TestMcpClient(fullUrl, "transport-owner");
    const web = new TestMcpClient(fullUrl, "owner");
    try {
      await Promise.all([local.connect(), web.connect()]);
      expect(contexts).toEqual(
        expect.arrayContaining([
          { clientId: "omnicodex-cli", durable: false },
          { clientId: "client-id", durable: true },
        ]),
      );
      const terminating = local.terminateSession();
      await localCloseStarted;
      let deleteSettled = false;
      void terminating.finally(() => {
        deleteSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(deleteSettled).toBe(false);
      releaseLocalClose();
      await terminating;
      expect(closed).toContain("omnicodex-cli");
      expect(closed).not.toContain("client-id");
    } finally {
      releaseLocalClose();
      await Promise.allSettled([local.close(), web.close()]);
      await gateway.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
    expect(closed).toContain("client-id");
  });

  it("keeps the injected downstream catalog shared across full-surface refreshes", async () => {
    const primary = fakeAppServer();
    let downstreamRevision = 1;
    const downstreamAppServer: AppServerRpcClient = {
      request: async <T>(method: string): Promise<T> => {
        if (method !== "mcpServerStatus/list") {
          throw new Error(`unexpected injected catalog method ${method}`);
        }
        const computerUseTools: Record<string, unknown> = {
          "codex.computer_use.list_apps": {
            name: "codex.computer_use.list_apps",
            description: "List visible applications.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true },
          },
        };
        if (downstreamRevision > 1) {
          computerUseTools["codex.computer_use.take_screenshot"] = {
            name: "codex.computer_use.take_screenshot",
            description: "Capture the current desktop.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true },
          };
        }
        return {
          data: [
            { name: "codex.computer_use", tools: computerUseTools },
            {
              name: "omnicodex",
              tools: {
                "omnicodex.self_ping": {
                  name: "omnicodex.self_ping",
                  inputSchema: { type: "object" },
                },
              },
            },
            {
              name: "omnicodex_stage",
              tools: {
                hidden_stage_tool: {
                  name: "hidden_stage_tool",
                  inputSchema: { type: "object" },
                },
              },
            },
          ],
          nextCursor: null,
        } as T;
      },
    };
    const nativeToolCatalog = new NativeToolCatalog(downstreamAppServer);
    const prepareRefreshSpy = vi.spyOn(nativeToolCatalog, "prepareRefresh");
    const commitRefreshSpy = vi.spyOn(nativeToolCatalog, "commitRefresh");
    const gateway = gatewayFor(primary.appServer, { nativeToolCatalog });
    const address = await gateway.start();
    const full = new TestMcpClient(
      `http://${address.host}:${address.port}${address.fullPath}`,
      "owner",
    );
    try {
      await full.connect();
      const initial = await listCompleteToolCatalog(full);
      expect(initial.tools.map((tool) => tool.name)).toContain("codex.computer_use.list_apps");
      expect(initial.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["omnicodex.self_ping", "hidden_stage_tool"]),
      );
      expect(
        initial.tools.some(
          (tool) => isObject(tool._meta) && Object.hasOwn(tool._meta, "omnicodex"),
        ),
      ).toBe(true);
      const initialRefreshCount = prepareRefreshSpy.mock.calls.length;
      expect(initialRefreshCount).toBeGreaterThan(0);
      expect(commitRefreshSpy.mock.calls.length).toBe(initialRefreshCount);

      downstreamRevision = 2;
      await gateway.refreshTools();
      expect(prepareRefreshSpy.mock.calls.length).toBeGreaterThan(initialRefreshCount);
      expect(commitRefreshSpy.mock.calls.length).toBe(prepareRefreshSpy.mock.calls.length);

      const refreshed = await listCompleteToolCatalog(full);
      expect(refreshed.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "codex.computer_use.list_apps",
          "codex.computer_use.take_screenshot",
        ]),
      );
      expect(refreshed.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["omnicodex.self_ping", "hidden_stage_tool"]),
      );
    } finally {
      prepareRefreshSpy.mockRestore();
      commitRefreshSpy.mockRestore();
      await full.close();
      await gateway.stop();
    }
  });

  it("returns the complete canonical full catalog through lossless cursor pages without a total cap", async () => {
    const fixture = fakeAppServer(1_010);
    const gateway = gatewayFor(fixture.appServer);
    const address = await gateway.start();
    const fullUrl = `http://${address.host}:${address.port}${address.fullPath}`;
    const owner = new TestMcpClient(fullUrl, "owner");
    const otherOwner = new TestMcpClient(fullUrl, "other");
    try {
      await owner.connect();
      await otherOwner.connect();

      const catalog = await listCompleteToolCatalog(owner);
      expect(catalog.pageToolCounts.length).toBeGreaterThan(0);
      expect(catalog.pageToolCounts.reduce((sum, count) => sum + count, 0)).toBe(
        catalog.tools.length,
      );
      expect(catalog.tools.length).toBeGreaterThan(1_000);

      expect(
        catalog.tools.some(
          (tool) => isObject(tool._meta) && Object.hasOwn(tool._meta, "omnicodex"),
        ),
      ).toBe(true);
      const catalogNames = catalog.tools.map((tool) => tool.name);
      expect(new Set(catalogNames).size).toBe(catalogNames.length);
      const presentNames = new Set(catalogNames);
      const expectedPriority = OMNICODEX_FULL_CATALOG_PRIORITY.filter((name) =>
        presentNames.has(name),
      );
      expect(catalogNames.slice(0, expectedPriority.length)).toEqual(expectedPriority);
      expect((await listCompleteToolCatalog(owner)).tools.map((tool) => tool.name)).toEqual(
        catalogNames,
      );
      expect((await listCompleteToolCatalog(otherOwner)).tools.map((tool) => tool.name)).toEqual(
        catalogNames,
      );
      const snapshot = await gateway.readFullCatalogSnapshot();
      expect(snapshot.catalogToolNames).toEqual(
        [...catalogNames].sort((left, right) => left.localeCompare(right, "en")),
      );
      expect(snapshot.catalogPageToolCounts).toEqual(catalog.pageToolCounts);

      fixture.catalogRevision = 2;
      await gateway.refreshTools();
      await expect(
        owner.request("tools/list", { cursor: "not-a-valid-cursor" }),
      ).rejects.toMatchObject({ message: expect.stringContaining("INVALID_CURSOR") });
    } finally {
      await owner.close();
      await otherOwner.close();
      await gateway.stop();
    }
  });

  it("drains active MCP work without killing it, rejects new work, and resumes after a timeout", async () => {
    const fixture = fakeAppServer();
    const gateway = gatewayFor(fixture.appServer);
    const address = await gateway.start();
    const fullUrl = `http://${address.host}:${address.port}${address.fullPath}`;
    const full = new TestMcpClient(fullUrl, "owner");
    try {
      await full.connect();
      const slowRequest = full.request("tools/call", {
        name: "slow",
        arguments: {
          omnicodexInvocationId: "10000000-0000-4000-8000-000000000004",
        },
      });
      await fixture.slowStarted;

      expect(gateway.beginDrain()).toEqual({
        admission: "draining",
        activeMcpRequests: 1,
        activeModelTurns: 0,
      });
      // Opening a saved conversation must still load its immutable status UI
      // while native work drains, including a newly connected resource client.
      const resourceClient = new TestMcpClient(fullUrl, "owner");
      try {
        await resourceClient.connect();
        await expect(
          resourceClient.request("resources/read", {
            uri: "ui://omnicodex/activity/v1.html",
          }),
        ).resolves.toMatchObject({
          contents: [
            {
              uri: "ui://omnicodex/activity/v1.html",
              mimeType: "text/html;profile=mcp-app",
              text: expect.stringContaining("<!doctype html>"),
            },
          ],
        });
      } finally {
        await resourceClient.close();
      }
      const rejected = await mcpPost(
        fullUrl,
        { jsonrpc: "2.0", id: 91, method: "tools/list", params: {} },
        "owner",
        {
          "MCP-Session-Id": full.sessionId as string,
          "MCP-Protocol-Version": "2025-06-18",
        },
      );
      expect(rejected.status).toBe(503);
      expect(rejected.headers.get("retry-after")).toBe("1");
      await expect(rejected.text()).resolves.toBe("Runtime draining");
      await expect(gateway.awaitDrained(20)).rejects.toThrow(
        "MCP drain timed out with 1 non-model and 0 model request(s)",
      );
      expect(gateway.runtimeStatus).toEqual({
        admission: "draining",
        activeMcpRequests: 1,
        activeModelTurns: 0,
      });

      fixture.releaseSlow();
      await expect(slowRequest).resolves.toMatchObject({
        content: [{ type: "text", text: "late" }],
      });
      await expect(gateway.awaitDrained(1_000)).resolves.toBeUndefined();
      expect(gateway.resumeAdmission()).toEqual({
        admission: "open",
        activeMcpRequests: 0,
        activeModelTurns: 0,
      });
      await expect(full.request("tools/list", {})).resolves.toBeDefined();
    } finally {
      fixture.releaseSlow();
      await full.close();
      await gateway.stop();
    }
  });

  it("compares native IDs only while their real MCP request attribution is active", async () => {
    const fixture = fakeAppServer();
    const gateway = gatewayFor(fixture.appServer);
    const address = await gateway.start();
    const full = new TestMcpClient(
      `http://${address.host}:${address.port}${address.fullPath}`,
      "owner",
    );
    const exactId = "native-request-comparison";
    try {
      await full.connect();
      const pending = full.request("tools/call", {
        name: "slow",
        arguments: { omnicodexInvocationId: "10000000-0000-4000-8000-000000000219" },
        _meta: { "openai/requestId": exactId },
      });
      await fixture.slowStarted;
      expect(gateway.compareNativeRequestIds([exactId])).toEqual({
        outcome: "match",
        activeRequestCount: 1,
        nativeRequestCount: 1,
        matchedNativeRequestCount: 1,
      });
      expect(gateway.compareNativeRequestIds(["another-request"]).outcome).toBe("mismatch");
      expect(JSON.stringify(gateway.compareNativeRequestIds([exactId]))).not.toContain(exactId);
      fixture.releaseSlow();
      await pending;
      await vi.waitFor(() =>
        expect(gateway.compareNativeRequestIds([exactId]).outcome).toBe("no_active_request"),
      );
    } finally {
      fixture.releaseSlow();
      await full.close().catch(() => undefined);
      await gateway.stop(1_000);
    }
  });

  it.each([
    ["Native-Request-ID", "Native-Request-ID", "match"],
    ["Native-Request-ID", "native-request-id", "mismatch"],
    ["Native-Request-ID, another-id", "Native-Request-ID", "mismatch"],
  ])(
    "compares the actual request header %s exactly against %s",
    async (header, candidate, outcome) => {
      const fixture = fakeAppServer();
      const gateway = gatewayFor(fixture.appServer);
      const address = await gateway.start();
      const url = `http://${address.host}:${address.port}${address.fullPath}`;
      const full = new TestMcpClient(url, "owner");
      try {
        await full.connect();
        const pending = fetch(url, {
          method: "POST",
          headers: {
            Authorization: "Bearer owner",
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            "MCP-Session-Id": full.sessionId as string,
            "MCP-Protocol-Version": "2025-06-18",
            "X-Request-ID": header,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 93,
            method: "tools/call",
            params: {
              name: "slow",
              arguments: { omnicodexInvocationId: "10000000-0000-4000-8000-000000000220" },
            },
          }),
        });
        await fixture.slowStarted;
        expect(gateway.compareNativeRequestIds([candidate]).outcome).toBe(outcome);
        fixture.releaseSlow();
        await (await pending).text();
        await vi.waitFor(() =>
          expect(gateway.compareNativeRequestIds([candidate]).outcome).toBe("no_active_request"),
        );
      } finally {
        fixture.releaseSlow();
        await full.close().catch(() => undefined);
        await gateway.stop(1_000);
      }
    },
  );

  it("releases an HTTP request when its caller disconnects while native settlement continues", async () => {
    const fixture = fakeAppServer();
    const gateway = gatewayFor(fixture.appServer);
    const address = await gateway.start();
    const fullUrl = `http://${address.host}:${address.port}${address.fullPath}`;
    const full = new TestMcpClient(fullUrl, "owner");
    const controller = new AbortController();
    try {
      await full.connect();
      const pending = fetch(fullUrl, {
        method: "POST",
        headers: {
          Authorization: "Bearer owner",
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "MCP-Session-Id": full.sessionId as string,
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 92,
          method: "tools/call",
          params: {
            name: "slow",
            arguments: {
              omnicodexInvocationId: "10000000-0000-4000-8000-000000000009",
            },
          },
        }),
        signal: controller.signal,
      });
      await fixture.slowStarted;
      expect(gateway.runtimeStatus.activeMcpRequests).toBe(1);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(gateway.runtimeStatus.activeMcpRequests).toBe(0));
    } finally {
      fixture.releaseSlow();
      await full.close().catch(() => undefined);
      await gateway.stop(1_000);
    }
  });

  it("replays a caller-disconnected native result without executing the mutation twice", async () => {
    const fixture = fakeAppServer();
    let resolveDelivered!: () => void;
    const delivered = new Promise<void>((resolve) => {
      resolveDelivered = resolve;
    });
    const gateway = gatewayFor(fixture.appServer, {
      observeResultDelivery: (observation) => {
        if (observation.mcpToolName === "slow") resolveDelivered();
      },
    });
    const address = await gateway.start();
    const fullUrl = `http://${address.host}:${address.port}${address.fullPath}`;
    const full = new TestMcpClient(fullUrl, "owner");
    const controller = new AbortController();
    const invocationId = "10000000-0000-4000-8000-000000000012";
    try {
      await full.connect();
      const disconnected = fetch(fullUrl, {
        method: "POST",
        headers: {
          Authorization: "Bearer owner",
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "MCP-Session-Id": full.sessionId as string,
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 93,
          method: "tools/call",
          params: {
            name: "slow",
            arguments: { omnicodexInvocationId: invocationId },
          },
        }),
        signal: controller.signal,
      });
      await fixture.slowStarted;
      controller.abort();
      await expect(disconnected).rejects.toMatchObject({ name: "AbortError" });

      fixture.releaseSlow();
      await Promise.race([
        delivered,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Disconnected native result was not committed")),
            1_000,
          ),
        ),
      ]);

      await expect(
        full.request("tools/call", {
          name: "slow",
          arguments: { omnicodexInvocationId: invocationId },
        }),
      ).resolves.toMatchObject({
        content: [{ type: "text", text: "late" }],
      });
      expect(fixture.calls.filter((method) => method === "mcpServer/tool/call")).toHaveLength(1);
    } finally {
      fixture.releaseSlow();
      await full.close().catch(() => undefined);
      await gateway.stop(1_000);
    }
  });

  it("reserves shutdown time to cancel a Web request before closing owned sessions", async () => {
    const fixture = fakeAppServer();
    const gateway = gatewayFor(fixture.appServer);
    const address = await gateway.start();
    const client = new TestMcpClient(
      `http://${address.host}:${address.port}${address.fullPath}`,
      "owner",
    );
    try {
      await client.connect();
      const slowRequest = client.request("tools/call", {
        name: "slow",
        arguments: {
          omnicodexInvocationId: "10000000-0000-4000-8000-000000000010",
        },
      });
      void slowRequest.catch(() => undefined);
      await fixture.slowStarted;

      await expect(gateway.stop(250)).resolves.toBeUndefined();
      expect(gateway.address).toBeUndefined();
    } finally {
      fixture.releaseSlow();
      void client.close().catch(() => undefined);
      await gateway.stop().catch(() => undefined);
    }
  });

  it("re-arms caller drain deadlines beyond Node's maximum timer frame", async () => {
    const fixture = fakeAppServer();
    const gateway = gatewayFor(fixture.appServer);
    const address = await gateway.start();
    const full = new TestMcpClient(
      `http://${address.host}:${address.port}${address.fullPath}`,
      "owner",
    );
    let timeoutSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await full.connect();
      const slowRequest = full.request("tools/call", {
        name: "slow",
        arguments: {
          omnicodexInvocationId: "10000000-0000-4000-8000-000000000008",
        },
      });
      await fixture.slowStarted;

      timeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const drain = gateway.awaitDrained(2_147_483_647 + 60_000);
      expect(
        timeoutSpy.mock.calls.some((call: readonly unknown[]) => call[1] === 2_147_483_647),
      ).toBe(true);

      fixture.releaseSlow();
      await expect(slowRequest).resolves.toMatchObject({
        content: [{ type: "text", text: "late" }],
      });
      await expect(drain).resolves.toBeUndefined();
    } finally {
      timeoutSpy?.mockRestore();
      fixture.releaseSlow();
      await full.close().catch(() => undefined);
      await gateway.stop();
    }
  });

  it("uses the caller's drain deadline for every admitted request", async () => {
    const listeners = new Set<(message: Record<string, unknown>) => void>();
    let releaseTurn: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const turnStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const turnReleased = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const appServer: AppServerRpcClient = {
      subscribeNotifications: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        if (method === "turn/start") {
          markStarted?.();
          await turnReleased;
          for (const listener of listeners) {
            listener({
              method: "thread/tokenUsage/updated",
              params: {
                threadId: "thread-model",
                turnId: "turn-model",
                tokenUsage: { last: { totalTokens: 42 } },
              },
            });
            listener({
              method: "turn/completed",
              params: {
                threadId: "thread-model",
                turn: { id: "turn-model", status: "completed" },
              },
            });
          }
          return { turn: { id: "turn-model" } } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    const appServerMethodCatalog = new AppServerMethodCatalog({
      loadClientRequestSchema: async () => ({
        oneOf: [
          {
            properties: {
              method: { enum: ["turn/start"] },
              params: {
                type: "object",
                properties: {
                  threadId: { type: "string" },
                  prompt: { type: "string" },
                },
                required: ["threadId", "prompt"],
              },
            },
          },
        ],
      }),
    });
    const gateway = gatewayFor(appServer, { appServerMethodCatalog });
    const address = await gateway.start();
    const full = new TestMcpClient(
      `http://${address.host}:${address.port}${address.path}`,
      "owner",
    );
    try {
      await full.connect();
      const modelRequest = full.request("tools/call", {
        name: "app_server_rpc",
        arguments: {
          omnicodexInvocationId: "10000000-0000-4000-8000-000000000005",
          method: "turn/start",
          params: { threadId: "thread-model", prompt: "bounded" },
          allowModelInvocation: true,
          allowPersistentStateMutation: true,
          timeoutMs: 1_000,
        },
      });
      await Promise.race([
        turnStarted,
        modelRequest.then((result) => {
          throw new Error(`model request ended before turn start: ${JSON.stringify(result)}`);
        }),
      ]);
      expect(gateway.beginDrain()).toEqual({
        admission: "draining",
        activeMcpRequests: 1,
        activeModelTurns: 1,
      });
      let drainSettled = false;
      const drain = gateway.awaitDrained(250).finally(() => {
        drainSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(drainSettled).toBe(false);
      releaseTurn?.();
      await expect(modelRequest).resolves.toMatchObject({
        content: [{ type: "text" }],
      });
      await expect(drain).resolves.toBeUndefined();
    } finally {
      releaseTurn?.();
      await full.close();
      await gateway.stop();
    }
  });

  it.each([
    ["ui://native/missing-widget.html", "ui://native/missing-widget.html"],
    ["https://files.example/result?token=secret", undefined],
    ["file:///C:/private/secret.txt", undefined],
    ["ui://user:secret@native/widget.html", undefined],
    ["ui://native/widget.html?token=secret", undefined],
    ["ui://native/widget.html#secret", undefined],
  ])("observes only credential-free UI resource identities: %s", async (uri, expected) => {
    const observations: StreamableHttpGatewayRequestObservation[] = [];
    const gateway = gatewayFor(fakeAppServer().appServer, {
      observeMcpRequest: (observation) => {
        observations.push(observation);
      },
    });
    const address = await gateway.start();
    const client = new TestMcpClient(
      `http://${address.host}:${address.port}${address.fullPath}`,
      "owner",
    );
    try {
      await client.connect();
      await expect(client.request("resources/read", { uri })).rejects.toBeDefined();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const reads = observations.filter((entry) => entry.rpcMethod === "resources/read");
      expect(reads).toHaveLength(1);
      expect(reads[0]?.uiResourceUri).toBe(expected);
      expect(JSON.stringify(observations)).not.toContain("secret");
    } finally {
      await client.close();
      await gateway.stop();
    }
  });

  it("observes only metadata needed to diagnose authenticated MCP negotiation", async () => {
    const fixture = fakeAppServer();
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-gateway-observation-"));
    const workSessions = await DurableWorkSessionStore.open({
      dataDirectory,
      hmacKey: Buffer.alloc(32, 71),
    });
    const observations: StreamableHttpGatewayRequestObservation[] = [];
    const preparedConversationUrls: string[] = [];
    const executions: NativeToolExecutionObservation[] = [];
    const progress: McpProgressObservation[] = [];
    const results: McpResultDeliveryObservation[] = [];
    const mutations: McpMutationReplayObservation[] = [];
    const catalogs: McpToolCatalogObservation[] = [];
    const preparations: Array<{
      readonly surface: "compat" | "full";
      readonly mcpToolName: string;
      readonly chatGptConversationUrl?: string;
    }> = [];
    const gateway = gatewayFor(fixture.appServer, {
      observeMcpRequest: (observation) => {
        observations.push(observation);
      },
      prepareChatGptConversationRequest: ({ chatGptConversationUrl }) => {
        preparedConversationUrls.push(chatGptConversationUrl);
      },
      observeNativeToolExecution: (observation) => {
        executions.push(observation);
      },
      prepareProtectedResultDelivery: (input) => {
        preparations.push(input);
      },
      observeProgress: (observation) => {
        progress.push(observation);
      },
      observeResultDelivery: (observation) => {
        results.push(observation);
      },
      observeMutationReplay: (observation) => {
        mutations.push(observation);
      },
      observeToolCatalog: (observation) => {
        catalogs.push(observation);
      },
      durableWorkSessionStore: workSessions,
    });
    const address = await gateway.start();
    const client = new TestMcpClient(
      `http://${address.host}:${address.port}${address.fullPath}`,
      "owner",
      {
        "Idempotency-Key": "observation-idempotency",
        "X-Correlation-Id": "observation-correlation",
      },
    );
    try {
      await client.connect();
      await client.request("tools/list", {});
      await client.request("tools/call", {
        name: "ping",
        arguments: {
          omnicodexInvocationId: "10000000-0000-4000-8000-000000000006",
        },
        _meta: {
          "io.modelcontextprotocol/related-task": { taskId: "observation-web-chat" },
          "openai/session": "6a96d948-c6f8-83e8-83c5-e265bcba2930",
          progressToken: "observation-progress",
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(gateway.observedChatGptConversationIds()).toEqual([
        "6a96d948-c6f8-83e8-83c5-e265bcba2930",
      ]);
      expect(preparedConversationUrls).toEqual([
        "https://chatgpt.com/c/6a96d948-c6f8-83e8-83c5-e265bcba2930",
      ]);
      const chatGptConversationIdSha256 = createHash("sha256")
        .update("6a96d948-c6f8-83e8-83c5-e265bcba2930", "utf8")
        .digest("hex");

      expect(observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            httpMethod: "POST",
            surface: "full",
            rpcMethod: "initialize",
            sessionHeaderPresent: false,
            status: 200,
            outcome: "new_session_transport",
          }),
          expect.objectContaining({
            rpcMethod: "notifications/initialized",
            sessionHeaderPresent: true,
            status: 202,
            outcome: "existing_session_transport",
          }),
          expect.objectContaining({
            rpcMethod: "tools/list",
            sessionHeaderPresent: true,
            status: 200,
            outcome: "existing_session_transport",
          }),
          expect.objectContaining({
            rpcMethod: "tools/call",
            callerProvenance: "chatgpt_conversation",
            openAiSessionIdentityKind: "conversation_id",
            chatGptConversationIdSha256,
          }),
        ]),
      );
      const serialized = JSON.stringify(observations);
      expect(serialized).not.toContain("fake-owner-access-token");
      expect(serialized).not.toContain("auth0|owner");
      const correlationIds = observations.flatMap((observation) =>
        observation.correlationId === undefined ? [] : [observation.correlationId],
      );
      expect(correlationIds.length).toBeGreaterThan(0);
      expect(new Set(correlationIds).size).toBe(1);
      expect(correlationIds[0]).toMatch(/^[a-f0-9]{32}$/);
      expect(executions).toEqual([
        expect.objectContaining({
          correlationId: correlationIds[0],
          callerProvenance: "chatgpt_conversation",
          surface: "full",
          mcpToolName: "ping",
          operation: "native_call",
          targetNativeName: "ping",
          targetNamespace: "demo",
          targetRoute: "downstream",
          chatGptConversationIdSha256,
          workSessionBindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          outcome: "succeeded",
        }),
      ]);
      const pingProgress = progress.filter((item) => item.mcpToolName === "ping");
      const pingResults = results.filter((item) => item.mcpToolName === "ping");
      const pingMutations = mutations.filter((item) => item.mcpToolName === "ping");
      expect(pingProgress.map((item) => item.phase)).toEqual(["started", "completed"]);
      expect(preparations).toEqual([]);
      expect(pingResults).toHaveLength(1);
      expect(pingResults[0]?.chatGptConversationUrl).toBe(
        "https://chatgpt.com/c/6a96d948-c6f8-83e8-83c5-e265bcba2930",
      );
      expect(pingResults[0]?.approvalTargetSource).toBe("request_metadata");
      expect(pingMutations).toEqual([
        expect.objectContaining({ identityMode: "explicit", disposition: "execute" }),
      ]);
      expect(catalogs.length).toBeGreaterThan(0);

      const principalDigests = [
        ...executions,
        ...pingProgress,
        ...pingResults,
        ...pingMutations,
        ...catalogs,
      ].map((item) => item.principalBindingSha256);
      expect(principalDigests.every((digest) => /^[a-f0-9]{64}$/u.test(digest ?? ""))).toBe(true);
      expect(new Set(principalDigests).size).toBe(1);

      const toolObservations = [...executions, ...pingProgress, ...pingResults, ...pingMutations];
      expect(
        toolObservations.every(
          (item) =>
            item.callerProvenance === "chatgpt_conversation" &&
            item.chatGptConversationIdSha256 === chatGptConversationIdSha256 &&
            item.invocationIdSha256 ===
              createHash("sha256")
                .update("10000000-0000-4000-8000-000000000006", "utf8")
                .digest("hex") &&
            /^[a-f0-9]{64}$/u.test(item.workSessionBindingSha256 ?? "") &&
            item.jsonRpcIdHmac !== undefined,
        ),
      ).toBe(true);
      const identityNames = new Set(
        toolObservations.flatMap(
          (item) => item.transportIdentityDigests?.map((identity) => identity.name) ?? [],
        ),
      );
      expect(
        [
          "header:idempotency-key",
          "header:mcp-session-id",
          "header:x-correlation-id",
          "meta:io.modelcontextprotocol/related-task",
          "meta:openai/session",
          "meta:progressToken",
        ].every((name) => identityNames.has(name)),
      ).toBe(true);
      const serializedToolObservations = JSON.stringify([
        ...executions,
        ...pingProgress,
        ...pingMutations,
      ]);
      expect(serializedToolObservations).not.toContain("pong");
      expect(serializedToolObservations).not.toContain("observation-idempotency");
      expect(serializedToolObservations).not.toContain("observation-correlation");
      expect(serializedToolObservations).not.toContain("observation-web-chat");
      expect(serializedToolObservations).not.toContain("6a96d948-c6f8-83e8-83c5-e265bcba2930");
    } finally {
      await client.close();
      await gateway.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});

function gatewayFor(
  appServer: AppServerRpcClient,
  options: {
    readonly resourceStore?: OwnerBoundResourceStore;
    readonly observeMcpRequest?: (
      observation: StreamableHttpGatewayRequestObservation,
    ) => Promise<void> | void;
    readonly prepareChatGptConversationRequest?: (input: {
      readonly surface: "compat" | "full";
      readonly chatGptConversationUrl: string;
    }) => Promise<void> | void;
    readonly observeNativeToolExecution?: (
      observation: NativeToolExecutionObservation,
    ) => Promise<void> | void;
    readonly prepareProtectedResultDelivery?: (input: {
      readonly surface: "compat" | "full";
      readonly mcpToolName: string;
      readonly chatGptConversationUrl?: string;
    }) => Promise<void> | void;
    readonly observeProgress?: (observation: McpProgressObservation) => Promise<void> | void;
    readonly observeResultDelivery?: (
      observation: McpResultDeliveryObservation,
    ) => Promise<void> | void;
    readonly observeMutationReplay?: (
      observation: McpMutationReplayObservation,
    ) => Promise<void> | void;
    readonly observeToolCatalog?: (observation: McpToolCatalogObservation) => Promise<void> | void;
    readonly observeReadInvocation?: (
      observation: McpReadInvocationObservation,
    ) => Promise<void> | void;
    readonly maxRequestBodyBytes?: number;
    readonly shutdownHardTimeoutMs?: number;
    readonly localTransportSessionIdleMs?: number;
    readonly appServerMethodCatalog?: AppServerMethodCatalog;
    readonly nativeToolCatalog?: NativeToolCatalog;
    readonly scheduler?: NativeExecutionScheduler;
    readonly createSessionExecutors?: StreamableHttpGatewayOptions["createSessionExecutors"];
    readonly directJobManager?: DirectJobManager;
    readonly directScheduleManager?: DirectScheduleManager;
    readonly directJobDispatchAdapter?: DirectJobDispatchAdapter;
    readonly durableWorkSessionStore?: DurableWorkSessionStore;
    readonly durableMcpEventStoreFactory?: DurableMcpEventStoreFactory;
    readonly protectedResourceMetadata?: Record<string, unknown>;
    readonly authorizationServerMetadata?: Record<string, unknown>;
    readonly allowedHosts?: readonly string[];
    readonly publicMetadataOrigin?: string;
    readonly port?: number;
  } = {},
): StreamableHttpGateway {
  const responsesToolCatalog = codeModeResponsesCatalog();
  return new StreamableHttpGateway({
    appServer,
    responsesToolCatalog,
    responsesToolExecutor: codeModeResponsesExecutor(),
    codexAppHostToolExecutor: new CodexAppHostToolExecutor(appServer, {
      threadMessages: {
        sendFollowUpMessage: async (threadId) => ({
          threadId,
          ownerClientId: "gateway-test-owner",
          disposition: "started",
          nativeResult: { accepted: true },
        }),
      },
    }),
    path: "/native",
    fullPath: "/native/full",
    ...(options.port === undefined ? {} : { port: options.port }),
    allowedOrigins: ["https://client.example"],
    protectedResourceMetadata: options.protectedResourceMetadata ?? metadata,
    ...(options.authorizationServerMetadata === undefined
      ? {}
      : { authorizationServerMetadata: options.authorizationServerMetadata }),
    ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
    ...(options.publicMetadataOrigin === undefined
      ? {}
      : { publicMetadataOrigin: options.publicMetadataOrigin }),
    ...(options.resourceStore === undefined ? {} : { resourceStore: options.resourceStore }),
    ...(options.observeMcpRequest === undefined
      ? {}
      : { observeMcpRequest: options.observeMcpRequest }),
    ...(options.prepareChatGptConversationRequest === undefined
      ? {}
      : { prepareChatGptConversationRequest: options.prepareChatGptConversationRequest }),
    ...(options.observeNativeToolExecution === undefined
      ? {}
      : { observeNativeToolExecution: options.observeNativeToolExecution }),
    ...(options.prepareProtectedResultDelivery === undefined
      ? {}
      : { prepareProtectedResultDelivery: options.prepareProtectedResultDelivery }),
    ...(options.observeProgress === undefined ? {} : { observeProgress: options.observeProgress }),
    ...(options.observeResultDelivery === undefined
      ? {}
      : { observeResultDelivery: options.observeResultDelivery }),
    ...(options.observeMutationReplay === undefined
      ? {}
      : { observeMutationReplay: options.observeMutationReplay }),
    ...(options.observeToolCatalog === undefined
      ? {}
      : { observeToolCatalog: options.observeToolCatalog }),
    ...(options.observeReadInvocation === undefined
      ? {}
      : { observeReadInvocation: options.observeReadInvocation }),
    ...(options.maxRequestBodyBytes === undefined
      ? {}
      : { maxRequestBodyBytes: options.maxRequestBodyBytes }),
    ...(options.shutdownHardTimeoutMs === undefined
      ? {}
      : { shutdownHardTimeoutMs: options.shutdownHardTimeoutMs }),
    ...(options.localTransportSessionIdleMs === undefined
      ? {}
      : { localTransportSessionIdleMs: options.localTransportSessionIdleMs }),
    ...(options.appServerMethodCatalog === undefined
      ? {}
      : { appServerMethodCatalog: options.appServerMethodCatalog }),
    ...(options.nativeToolCatalog === undefined
      ? {}
      : { nativeToolCatalog: options.nativeToolCatalog }),
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(options.createSessionExecutors === undefined
      ? {}
      : { createSessionExecutors: options.createSessionExecutors }),
    ...(options.directJobManager === undefined
      ? {}
      : { directJobManager: options.directJobManager }),
    ...(options.directScheduleManager === undefined
      ? {}
      : { directScheduleManager: options.directScheduleManager }),
    ...(options.directJobDispatchAdapter === undefined
      ? {}
      : { directJobDispatchAdapter: options.directJobDispatchAdapter }),
    ...(options.durableWorkSessionStore === undefined
      ? {}
      : { durableWorkSessionStore: options.durableWorkSessionStore }),
    ...(options.durableMcpEventStoreFactory === undefined
      ? {}
      : { durableMcpEventStoreFactory: options.durableMcpEventStoreFactory }),
    authorize: (request) => {
      const requestPath = new URL(request.url ?? "/native", metadata.resource).pathname;
      const resource = requestPath === "/native" ? metadata.resource : `${metadata.resource}/full`;
      if (request.headers.authorization === "Bearer transport-owner") {
        return authorization("owner", resource, "omnicodex-cli", "transport");
      }
      if (request.headers.authorization === "Bearer owner") return authorization("owner", resource);
      if (request.headers.authorization === "Bearer owner-rotated-client") {
        return authorization("owner", resource, "rotated-client-id");
      }
      if (request.headers.authorization === "Bearer other") return authorization("other", resource);
      return {
        ok: false,
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="OmniCodex"' },
        message: "Unauthorized",
      };
    },
  });
}

function durableEventFactory(
  dataDirectory: string,
  hmacKey: Uint8Array,
  overrides: Partial<
    Pick<
      DurableMcpEventStoreOptions,
      "eventTtlMs" | "sessionTtlMs" | "tombstoneTtlMs" | "maxEvents" | "maxEventBytes" | "nowUnixMs"
    >
  > = {},
): DurableMcpEventStoreFactory {
  return {
    open: (binding) =>
      DurableMcpEventStore.open({ dataDirectory, hmacKey, ...binding, ...overrides }),
    rehydrateByTransport: (binding) =>
      DurableMcpEventStore.rehydrateByTransport({
        dataDirectory,
        hmacKey,
        ...binding,
        ...overrides,
      }),
  };
}

class RecordingGatewayScheduler extends NativeExecutionScheduler {
  readonly requests: NativeExecutionRequest[] = [];

  override run<T>(
    request: NativeExecutionRequest,
    operation: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.requests.push(request);
    return super.run(request, operation);
  }
}

class RecordingRequestContextScheduler extends NativeExecutionScheduler {
  readonly contexts: NativeExecutionRequestContext[] = [];

  override withRequestContext<T>(
    context: NativeExecutionRequestContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.contexts.push(context);
    return super.withRequestContext(context, operation);
  }
}

function codeModeResponsesCatalog(): ResponsesNativeToolCatalog {
  return new ResponsesNativeToolCatalog({
    snapshot: {
      refreshedAtUnixMs: 1,
      requestCount: 1,
      tools: [
        {
          type: "namespace",
          name: "functions",
          tools: [
            {
              type: "custom",
              name: "exec",
              description: "Execute exact native Codex tools from JavaScript.",
            },
          ],
        },
      ],
    },
  });
}

function codeModeResponsesExecutor(): ResponsesNativeToolExecutor {
  return new ResponsesNativeToolExecutor({
    call: async () => ({
      callId: "call-code-mode",
      outputType: "custom_tool_call_output",
      executionStatus: "succeeded",
      output: [{ type: "input_text", text: "code-mode-ok" }],
      rawItem: {
        type: "custom_tool_call_output",
        call_id: "call-code-mode",
        output: [{ type: "input_text", text: "code-mode-ok" }],
      },
    }),
  });
}

function authorization(
  subject: "owner" | "other",
  resource = metadata.resource,
  clientId = "client-id",
  executorLifecycle?: HttpAuthorizationIdentity["executorLifecycle"],
): HttpAuthorizationDecision {
  const identity: HttpAuthorizationIdentity = {
    issuer: "https://owner.us.auth0.com/",
    subject: `auth0|${subject}`,
    clientId,
    resource,
    ...(executorLifecycle === undefined ? {} : { executorLifecycle }),
  };
  return {
    ok: true,
    identity,
    authInfo: {
      token: `fake-${subject}-access-token`,
      clientId: identity.clientId,
      scopes: ["omnicodex:full"],
      resource: new URL(identity.resource),
      extra: { issuer: identity.issuer, subject: identity.subject },
    },
  };
}

function fakeAppServer(extraToolCount = 0, includeImages = false) {
  const calls: string[] = [];
  let resolveSlowStarted: (() => void) | undefined;
  let releaseSlowCall: (() => void) | undefined;
  const slowStarted = new Promise<void>((resolve) => {
    resolveSlowStarted = resolve;
  });
  const slowResult = new Promise<void>((resolve) => {
    releaseSlowCall = resolve;
  });
  const fixture = {
    calls,
    catalogRevision: 1,
    slowStarted,
    releaseSlow: () => releaseSlowCall?.(),
    appServer: {
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push(method);
        if (method === "mcpServerStatus/list") {
          const tools: Record<string, unknown> = {
            ping: { name: "ping", inputSchema: { type: "object" } },
            slow: { name: "slow", inputSchema: { type: "object" } },
            large: { name: "large", inputSchema: { type: "object" } },
          };
          if (includeImages) {
            tools.images = { name: "images", inputSchema: { type: "object" } };
          }
          for (let index = 0; index < extraToolCount; index += 1) {
            const name = `bulk_${String(extraToolCount - index).padStart(3, "0")}`;
            tools[name] = { name, inputSchema: { type: "object" } };
          }
          if (fixture.catalogRevision > 1) {
            tools.second_revision = {
              name: "second_revision",
              inputSchema: { type: "object" },
            };
          }
          if (fixture.catalogRevision > 2) {
            tools.third_revision = {
              name: "third_revision",
              inputSchema: { type: "object" },
            };
          }
          if (fixture.catalogRevision > 3) {
            const revisionName = `revision_${fixture.catalogRevision}`;
            tools[revisionName] = {
              name: revisionName,
              inputSchema: { type: "object" },
            };
          }
          return { data: [{ name: "demo", tools }], nextCursor: null } as T;
        }
        if (method === "thread/start") {
          return { thread: { id: "urn:uuid:ephemeral" } } as T;
        }
        if (method === "mcpServer/tool/call") {
          const tool = isObject(params) ? params.tool : undefined;
          if (tool === "ping") return { content: [{ type: "text", text: "pong" }] } as T;
          if (tool === "large") {
            return {
              content: [{ type: "text", text: "x".repeat(256 * 1024 + 1) }],
              structuredContent: {
                marker: "structured-only-sentinel",
                payload: "y".repeat(256 * 1024 + 1),
              },
            } as T;
          }
          if (tool === "images") {
            return {
              content: Array.from({ length: 5 }, (_, index) => ({
                type: "image",
                data: Buffer.alloc(240 * 1024, index + 1).toString("base64"),
                mimeType: "image/png",
              })),
            } as T;
          }
          if (tool === "slow") {
            resolveSlowStarted?.();
            await slowResult;
            return { content: [{ type: "text", text: "late" }] } as T;
          }
          return { content: [{ type: "text", text: "second" }] } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    },
  };
  return fixture;
}

class TestMcpClient {
  readonly #transport: StreamableHTTPClientTransport;
  readonly #pending = new Map<
    number,
    { readonly resolve: (value: unknown) => void; readonly reject: (reason: unknown) => void }
  >();
  readonly #notificationWaiters = new Map<string, (message: Record<string, unknown>) => void>();
  #nextId = 1;

  constructor(url: string, accessToken: string, headers: Readonly<Record<string, string>> = {}) {
    this.#transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}`, ...headers } },
    });
    this.#transport.onmessage = (message) => this.#onMessage(message);
  }

  get sessionId(): string | undefined {
    return this.#transport.sessionId;
  }

  async connect(sendInitializedNotification = true): Promise<void> {
    await this.#transport.start();
    await this.requestWithId(
      0,
      "initialize",
      (initializeRequest("2025-06-18") as { params: Record<string, unknown> }).params,
    );
    this.#transport.setProtocolVersion("2025-06-18");
    if (sendInitializedNotification) await this.notify("notifications/initialized", {});
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.requestWithId(this.#nextId++, method, params);
  }

  async requestWithId(
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    try {
      await this.#transport.send({ jsonrpc: "2.0", id, method, params } as JSONRPCMessage);
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
    return response;
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.#transport.send({ jsonrpc: "2.0", method, params } as JSONRPCMessage);
  }

  waitForNotification(method: string): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve) => {
      this.#notificationWaiters.set(method, resolve);
    });
  }

  async terminateSession(): Promise<void> {
    await this.#transport.terminateSession();
  }

  hasPendingRequest(id: number): boolean {
    return this.#pending.has(id);
  }

  async close(): Promise<void> {
    await this.#transport.close();
  }

  #onMessage(message: JSONRPCMessage): void {
    if (!("id" in message) || (typeof message.id !== "number" && typeof message.id !== "string")) {
      if ("method" in message && typeof message.method === "string") {
        const waiter = this.#notificationWaiters.get(message.method);
        if (waiter !== undefined) {
          this.#notificationWaiters.delete(message.method);
          waiter(message as Record<string, unknown>);
        }
      }
      return;
    }
    const numericId = Number(message.id);
    const pending = this.#pending.get(numericId);
    if (pending === undefined) return;
    this.#pending.delete(numericId);
    if ("error" in message) pending.reject(message.error);
    else if ("result" in message) pending.resolve(message.result);
  }
}

async function mcpPost(
  url: string,
  body: unknown,
  accessToken: string | undefined,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  const value = JSON.stringify(body);
  return fetch(url, {
    method: "POST",
    headers: {
      ...(accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` }),
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...headers,
    },
    body: value,
  });
}

function initializeRequest(protocolVersion: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: { tools: { listChanged: true } },
      clientInfo: { name: "fake-owner-client", version: "1.0.0" },
    },
  };
}

async function resourceFetch(
  url: string,
  accessToken: string,
  sessionId?: string,
  range?: string,
  acceptEncoding?: string,
): Promise<Response> {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(sessionId === undefined ? {} : { "MCP-Session-Id": sessionId }),
      ...(range === undefined ? {} : { Range: range }),
      ...(acceptEncoding === undefined ? {} : { "Accept-Encoding": acceptEncoding }),
    },
  });
}

function standaloneSseHeaders(sessionId: string): Record<string, string> {
  return {
    Accept: "text/event-stream",
    Authorization: "Bearer owner",
    "MCP-Protocol-Version": "2025-06-18",
    "MCP-Session-Id": sessionId,
  };
}

async function completeRawInitialization(url: string, sessionId: string): Promise<void> {
  const response = await mcpPost(
    url,
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    "owner",
    {
      "MCP-Protocol-Version": "2025-06-18",
      "MCP-Session-Id": sessionId,
    },
  );
  if (response.status !== 202) {
    throw new Error(`Raw initialization failed with ${response.status}`);
  }
}

function toolNames(value: unknown): string[] {
  if (!isObject(value) || !Array.isArray(value.tools)) throw new Error("Missing tools result");
  return value.tools.map((tool) =>
    isObject(tool) && typeof tool.name === "string" ? tool.name : "",
  );
}

async function listCompleteToolCatalog(client: TestMcpClient): Promise<{
  readonly tools: ReadonlyArray<Record<string, unknown> & { readonly name: string }>;
  readonly pageToolCounts: readonly number[];
  readonly firstPageToolNames: readonly string[];
}> {
  const tools: Array<Record<string, unknown> & { readonly name: string }> = [];
  const pageToolCounts: number[] = [];
  const seenCursors = new Set<string>();
  let firstPageToolNames: readonly string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.request("tools/list", cursor === undefined ? {} : { cursor });
    if (!isObject(page) || !Array.isArray(page.tools)) {
      throw new Error("Missing full tool catalog page");
    }
    const pageTools = page.tools.map((tool) => {
      if (!isObject(tool) || typeof tool.name !== "string") {
        throw new Error("Full tool catalog contains an invalid tool");
      }
      return tool as Record<string, unknown> & { readonly name: string };
    });
    if (pageToolCounts.length === 0) {
      firstPageToolNames = pageTools.map((tool) => tool.name);
    }
    tools.push(...pageTools);
    pageToolCounts.push(pageTools.length);
    const nextCursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    if (nextCursor !== undefined && seenCursors.has(nextCursor)) {
      throw new Error("Full tool catalog repeated a pagination cursor");
    }
    if (nextCursor !== undefined) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor !== undefined);
  return { tools, pageToolCounts, firstPageToolNames };
}

function semanticDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)), "utf8")
    .digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right, "en"))
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function resourceLinks(value: unknown): ReadonlyArray<Record<string, unknown>> {
  if (!isObject(value) || !Array.isArray(value.content)) throw new Error("Missing content result");
  return value.content.filter((item) => isObject(item) && item.type === "resource_link");
}

interface ProtectedResultHandle {
  readonly resourceId: string;
  readonly byteLength: number;
  readonly digest: string;
  readonly readArguments?: {
    readonly resourceId: string;
    readonly offset: number;
    readonly _omnicodexSession?: {
      readonly workSessionBinding: string;
      readonly continuationToken: string;
    };
  };
}

async function issueProtectedResultFixture(
  store: OwnerBoundResourceStore,
  value: unknown,
): Promise<ProtectedResultHandle> {
  const session = workSessionMetadata(value);
  const owner = authorization("owner", `${metadata.resource}/full`).identity;
  if (owner === undefined) throw new Error("Missing test owner identity");
  // Model an already-issued durable handle without restoring automatic size
  // conversion of ordinary successful results in the production mapper.
  const resource = await store.put({
    owner,
    sessionId: createHash("sha256")
      .update("omnicodex-protected-result-work-session\0", "utf8")
      .update(session.workSessionBinding, "utf8")
      .digest("base64url"),
    mimeType: "application/json",
    bytes: Buffer.from(JSON.stringify(value), "utf8"),
  });
  return {
    resourceId: resource.id,
    byteLength: resource.byteLength,
    digest: resource.digest,
    readArguments: {
      resourceId: resource.id,
      offset: 0,
      _omnicodexSession: {
        workSessionBinding: session.workSessionBinding,
        continuationToken: session.continuationToken,
      },
    },
  };
}

async function readProtectedResultViaTool(
  client: TestMcpClient,
  handle: ProtectedResultHandle,
): Promise<string> {
  let offset = 0;
  let complete = "";
  const seen = new Set<number>();
  const durableSession = handle.readArguments?._omnicodexSession;
  while (offset < handle.byteLength) {
    if (seen.has(offset)) throw new Error("Protected result cursor repeated");
    seen.add(offset);
    const result = await client.request("tools/call", {
      name: PROTECTED_RESULT_READ_TOOL,
      arguments: {
        resourceId: handle.resourceId,
        offset,
        ...(durableSession === undefined ? {} : { _omnicodexSession: durableSession }),
      },
    });
    if (!isObject(result) || !isObject(result.structuredContent)) {
      throw new Error("Missing protected result chunk");
    }
    const chunk = result.structuredContent;
    if (
      chunk.resourceId !== handle.resourceId ||
      chunk.offset !== offset ||
      typeof chunk.endOffset !== "number" ||
      typeof chunk.chunk !== "string" ||
      (chunk.nextOffset !== null && typeof chunk.nextOffset !== "number")
    ) {
      throw new Error("Invalid protected result chunk");
    }
    complete += chunk.chunk;
    if (chunk.nextOffset === null) {
      offset = handle.byteLength;
    } else {
      if (chunk.nextOffset <= offset) throw new Error("Protected result cursor did not advance");
      offset = chunk.nextOffset;
    }
  }
  return complete;
}

function sseEventId(value: string): string {
  const match = /^id: ([^\r\n]+)$/m.exec(value);
  if (match?.[1] === undefined) throw new Error("Missing SSE event id");
  return match[1];
}

function progressNotification(value: string): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken: value, progress: 1 },
  };
}

function workSessionMetadata(value: unknown): {
  readonly workSessionBinding: string;
  readonly continuationToken: string;
  readonly journalCursor: string;
} {
  if (!isObject(value) || !isObject(value._meta) || !isObject(value._meta.omnicodex)) {
    throw new Error("Missing durable work-session metadata");
  }
  const metadata = value._meta.omnicodex;
  if (
    typeof metadata.workSessionBinding !== "string" ||
    typeof metadata.continuationToken !== "string" ||
    typeof metadata.journalCursor !== "string"
  ) {
    throw new Error("Durable work-session metadata is incomplete");
  }
  return {
    workSessionBinding: metadata.workSessionBinding,
    continuationToken: metadata.continuationToken,
    journalCursor: metadata.journalCursor,
  };
}

function directJobFromResult(value: unknown): Record<string, unknown> & { readonly jobId: string } {
  if (!isObject(value) || !Array.isArray(value.content)) {
    throw new Error("Missing direct-job result content");
  }
  const text = value.content.find(
    (item) => isObject(item) && item.type === "text" && typeof item.text === "string",
  );
  if (!isObject(text) || typeof text.text !== "string") {
    throw new Error("Missing direct-job JSON result");
  }
  const parsed: unknown = JSON.parse(text.text);
  if (!isObject(parsed)) throw new Error("Invalid direct-job JSON result");
  const job = isObject(parsed.job) ? parsed.job : parsed;
  if (!isObject(job) || typeof job.jobId !== "string") {
    throw new Error("Direct-job result did not include jobId");
  }
  return job as Record<string, unknown> & { readonly jobId: string };
}

function directTargetContract(identity: string) {
  return {
    catalogRevision: "c".repeat(64),
    targetIdentity: `mcp__demo__${identity}`,
    targetContractDigest: "d".repeat(64),
    modelEffect: "none" as const,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
