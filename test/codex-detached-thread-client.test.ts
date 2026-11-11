import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServerRpcRequestOptions } from "../src/application/native-tool-catalog.js";
import type { RuntimeCandidate } from "../src/domain/runtime.js";
import type { CodexAppServerProcessOptions } from "../src/infrastructure/runtime/codex-app-server-process.js";
import {
  type CodexDetachedAppServerProcess,
  CodexDetachedThreadClient,
} from "../src/infrastructure/runtime/codex-detached-thread-client.js";
import { CodexThreadFollowUpQueueStore } from "../src/infrastructure/runtime/codex-thread-follow-up-queue-store.js";
import type { CodexAppServerOwnershipRegistry } from "../src/infrastructure/runtime/owned-codex-app-server-registry.js";

describe("CodexDetachedThreadClient", () => {
  let queueDirectory: string;
  let queueStore: CodexThreadFollowUpQueueStore;

  beforeEach(async () => {
    queueDirectory = await mkdtemp(join(tmpdir(), "omnicodex-follow-up-"));
    queueStore = new CodexThreadFollowUpQueueStore({
      path: join(queueDirectory, "queue.json"),
    });
  });

  afterEach(async () => {
    await rm(queueDirectory, { recursive: true, force: true });
  });

  it("resumes an arbitrary existing thread and acknowledges only a native turn id", async () => {
    const fixture = processFixture();
    const client = new CodexDetachedThreadClient(candidate, {
      createProcess: fixture.createProcess,
      queueStore,
      recoverQueue: false,
    });

    const started = await client.sendFollowUpMessage("thread-idle", "continue", {
      cwd: "C:\\workspace",
      threadSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
    });

    expect(started).toMatchObject({
      threadId: "thread-idle",
      disposition: "started",
      transport: "detached_app_server",
      nativeResult: { turn: { id: "turn-native" } },
    });
    expect(fixture.calls.slice(0, 2)).toEqual([
      {
        method: "thread/resume",
        params: {
          threadId: "thread-idle",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          excludeTurns: true,
          cwd: "C:\\workspace",
          model: "gpt-5.6-sol",
        },
        options: { awaitResponseAfterCancellation: true },
      },
      {
        method: "turn/start",
        params: {
          threadId: "thread-idle",
          input: [{ type: "text", text: "continue", text_elements: [] }],
          clientUserMessageId: expect.any(String),
          approvalPolicy: "never",
          cwd: "C:\\workspace",
          model: "gpt-5.6-sol",
          effort: "xhigh",
        },
        options: { awaitResponseAfterCancellation: true },
      },
    ]);
    expect(fixture.processOptions).not.toHaveProperty("requestTimeoutMs");

    fixture.notify({
      method: "turn/completed",
      params: { threadId: "thread-idle", turn: { id: "turn-native" } },
    });
    await vi.waitFor(() => expect(fixture.stops).toBe(1));
    expect(fixture.calls.at(-1)).toEqual({
      method: "thread/unsubscribe",
      params: { threadId: "thread-idle" },
    });
    await client.dispose();
  });

  it("omits a blank model so native follow-ups inherit the configured model", async () => {
    const fixture = processFixture();
    const client = new CodexDetachedThreadClient(candidate, {
      createProcess: fixture.createProcess,
      queueStore,
      recoverQueue: false,
    });

    await client.sendFollowUpMessage("thread-inherit-model", "continue", {
      threadSettings: { model: "   ", effort: "xhigh" },
    });

    expect(fixture.calls.slice(0, 2)).toEqual([
      {
        method: "thread/resume",
        params: {
          threadId: "thread-inherit-model",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          excludeTurns: true,
        },
        options: { awaitResponseAfterCancellation: true },
      },
      {
        method: "turn/start",
        params: {
          threadId: "thread-inherit-model",
          input: [{ type: "text", text: "continue", text_elements: [] }],
          clientUserMessageId: expect.any(String),
          approvalPolicy: "never",
          effort: "xhigh",
        },
        options: { awaitResponseAfterCancellation: true },
      },
    ]);
    expect(fixture.calls[0]?.params).not.toHaveProperty("model");
    expect(fixture.calls[1]?.params).not.toHaveProperty("model");

    fixture.notify({
      method: "turn/completed",
      params: { threadId: "thread-inherit-model", turn: { id: "turn-native" } },
    });
    await vi.waitFor(() => expect(fixture.stops).toBe(1));
    await client.dispose();
  });

  it("propagates caller signal, timeout, and deadline through resume and turn submission", async () => {
    const fixture = processFixture();
    const client = new CodexDetachedThreadClient(candidate, {
      createProcess: fixture.createProcess,
      queueStore,
      recoverQueue: false,
    });
    const controller = new AbortController();
    const deadlineUnixMs = Date.now() + 2_500_000_000;

    await client.sendFollowUpMessage("thread-bounded", "continue", {
      clientUserMessageId: "bounded-operation",
      deadlineUnixMs,
      signal: controller.signal,
      timeoutMs: 3_000_000_000,
    });

    for (const call of fixture.calls.filter((entry) =>
      ["thread/resume", "turn/start"].includes(entry.method),
    )) {
      expect(call.options).toEqual({
        awaitResponseAfterCancellation: true,
        deadlineUnixMs,
        signal: controller.signal,
        timeoutMs: 3_000_000_000,
      });
    }
    expect(fixture.processOptions?.requestTimeoutMs).toBeGreaterThan(2_147_483_647);
    expect(fixture.processOptions?.requestTimeoutMs).toBeLessThanOrEqual(2_500_000_000);
    await client.dispose();
  });

  it("durably queues an active follow-up and starts it only after the current turn completes", async () => {
    const fixture = processFixture();
    const client = new CodexDetachedThreadClient(candidate, {
      createProcess: fixture.createProcess,
      queueStore,
      recoverQueue: false,
    });

    await client.sendFollowUpMessage("thread-active", "first");
    const queued = await client.sendFollowUpMessage("thread-active", "second", {
      clientUserMessageId: "queued-operation",
    });

    expect(queued).toMatchObject({
      disposition: "queued",
      queue: {
        clientUserMessageId: "queued-operation",
        position: 1,
        persisted: true,
        dispatchAfter: "active_turn_terminal",
      },
    });
    expect(fixture.processes).toBe(1);
    expect(fixture.calls.some((call) => call.method === "turn/steer")).toBe(false);
    expect(await queueStore.list("detached_app_server", "thread-active")).toHaveLength(1);

    fixture.notify(
      {
        method: "turn/completed",
        params: { threadId: "thread-active", turn: { id: "turn-native" } },
      },
      0,
    );
    await vi.waitFor(() => {
      expect(fixture.processes).toBe(2);
      expect(fixture.calls.filter((call) => call.method === "turn/start")).toHaveLength(2);
    });
    expect(fixture.calls.filter((call) => call.method === "turn/start").at(-1)).toMatchObject({
      params: {
        threadId: "thread-active",
        input: [{ type: "text", text: "second", text_elements: [] }],
        clientUserMessageId: "queued-operation",
      },
    });
    await vi.waitFor(async () => {
      expect(await queueStore.list("detached_app_server", "thread-active")).toHaveLength(0);
    });
    await client.dispose();
  });

  it("recovers a persisted follow-up after restart and removes it only after native start ack", async () => {
    await queueStore.enqueue("detached_app_server", "thread-recovered", "resume after restart", {
      clientUserMessageId: "recovered-operation",
      cwd: "C:\\workspace",
    });
    const fixture = processFixture();
    const client = new CodexDetachedThreadClient(candidate, {
      createProcess: fixture.createProcess,
      queueStore,
    });

    await vi.waitFor(() => {
      expect(fixture.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    });
    expect(fixture.calls.filter((call) => call.method === "turn/start")[0]).toMatchObject({
      params: {
        threadId: "thread-recovered",
        input: [{ type: "text", text: "resume after restart", text_elements: [] }],
        clientUserMessageId: "recovered-operation",
        cwd: "C:\\workspace",
      },
    });
    await vi.waitFor(async () => {
      expect(await queueStore.list("detached_app_server", "thread-recovered")).toHaveLength(0);
    });
    await client.dispose();
  });

  it("coalesces identical concurrent requests before process creation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = processFixture({ startGate: gate });
    const client = new CodexDetachedThreadClient(candidate, {
      createProcess: fixture.createProcess,
      queueStore,
      recoverQueue: false,
    });

    const operation = { clientUserMessageId: randomUUID() };
    const first = client.sendFollowUpMessage("thread-same", "same", operation);
    const duplicate = client.sendFollowUpMessage("thread-same", "same", operation);
    release();

    await Promise.all([first, duplicate]);
    expect(fixture.processes).toBe(1);
    expect(fixture.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    await client.dispose();
  });

  it("removes a cancelled queued mutation before it can dispatch late", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = processFixture({ startGate: gate });
    const client = new CodexDetachedThreadClient(candidate, {
      createProcess: fixture.createProcess,
      queueStore,
      recoverQueue: false,
    });
    const first = client.sendFollowUpMessage("thread-serialized", "first", {
      clientUserMessageId: "first-operation",
    });
    await vi.waitFor(() => expect(fixture.processes).toBe(1));

    const controller = new AbortController();
    const cancelled = client.sendFollowUpMessage("thread-serialized", "cancelled", {
      clientUserMessageId: "cancelled-operation",
      signal: controller.signal,
    });
    controller.abort(new Error("caller stopped"));
    await expect(cancelled).rejects.toThrow("caller stopped");

    release();
    await first;
    expect(fixture.processes).toBe(1);
    expect(fixture.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    await client.dispose();
  });

  it("keeps an idempotency result available without an implicit replay expiry", async () => {
    const fixture = processFixture();
    const client = new CodexDetachedThreadClient(candidate, {
      createProcess: fixture.createProcess,
      queueStore,
      recoverQueue: false,
    });
    const options = { clientUserMessageId: "durable-process-replay" };

    const first = await client.sendFollowUpMessage("thread-stable", "same", options);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60_000);
    try {
      await expect(client.sendFollowUpMessage("thread-stable", "same", options)).resolves.toEqual(
        first,
      );
      expect(fixture.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      await client.dispose();
    }
  });

  it("marks only failures before turn submission as safe ownership races", async () => {
    const fixture = processFixture({ failResume: new Error("writer lock is owned") });
    const client = new CodexDetachedThreadClient(candidate, {
      createProcess: fixture.createProcess,
      queueStore,
      recoverQueue: false,
    });

    await expect(client.sendFollowUpMessage("thread-owned", "continue")).rejects.toMatchObject({
      name: "CodexThreadPreDispatchError",
      retryDesktopOwnerLookup: true,
    });
    expect(fixture.calls.some((call) => call.method === "turn/start")).toBe(false);
    await client.dispose();
  });

  it("does not classify a turn/start timeout as replay-safe", async () => {
    const fixture = processFixture({ failTurnStart: new Error("turn/start timed out") });
    const client = new CodexDetachedThreadClient(candidate, {
      createProcess: fixture.createProcess,
      queueStore,
      recoverQueue: false,
    });
    const options = { clientUserMessageId: "unknown-operation" };

    await expect(
      client.sendFollowUpMessage("thread-uncertain", "continue", options),
    ).rejects.toThrow("turn/start timed out");
    await expect(
      client.sendFollowUpMessage("thread-uncertain", "continue", options),
    ).rejects.toThrow("turn/start timed out");
    expect(fixture.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    await client.dispose();
  });

  it("rejects one client user-message id reused with different detached input", async () => {
    const fixture = processFixture();
    const client = new CodexDetachedThreadClient(candidate, {
      createProcess: fixture.createProcess,
      queueStore,
      recoverQueue: false,
    });
    const options = {
      clientUserMessageId: "conflicting-operation",
      cwd: "C:\\first",
      threadSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
    };

    await client.sendFollowUpMessage("thread-one", "first prompt", options);
    await expect(client.sendFollowUpMessage("thread-two", "first prompt", options)).rejects.toThrow(
      "reused with different input",
    );
    await expect(
      client.sendFollowUpMessage("thread-one", "second prompt", options),
    ).rejects.toThrow("reused with different input");
    await expect(
      client.sendFollowUpMessage("thread-one", "first prompt", {
        ...options,
        cwd: "C:\\second",
      }),
    ).rejects.toThrow("reused with different input");
    expect(fixture.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    await client.dispose();
  });

  it("propagates the daemon ownership registry to every detached worker process", async () => {
    const fixture = processFixture();
    const ownershipRegistry = {} as CodexAppServerOwnershipRegistry;
    const client = new CodexDetachedThreadClient(candidate, {
      createProcess: fixture.createProcess,
      ownershipRegistry,
      queueStore,
      recoverQueue: false,
    });

    await client.sendFollowUpMessage("thread-registered", "continue");
    expect(fixture.processOptions?.ownershipRegistry).toBe(ownershipRegistry);
    await client.dispose();
  });
});

const candidate: RuntimeCandidate = {
  executablePath: "C:\\Codex\\codex.exe",
  canonicalPath: "C:\\Codex\\codex.exe",
  source: "managed_install",
  buildSha256: "a".repeat(64),
};

function processFixture(
  options: {
    readonly startGate?: Promise<void>;
    readonly failResume?: Error;
    readonly failTurnStart?: Error;
  } = {},
) {
  const calls: Array<{
    method: string;
    params: unknown;
    options?: number | AppServerRpcRequestOptions;
  }> = [];
  const processOptions: CodexAppServerProcessOptions[] = [];
  let processes = 0;
  let stops = 0;
  const createProcess = (
    _candidate: RuntimeCandidate,
    selectedOptions: CodexAppServerProcessOptions,
  ): CodexDetachedAppServerProcess => {
    processOptions.push(selectedOptions);
    processes += 1;
    return {
      identity: { ownershipNonce: `nonce-${processes}` },
      start: async () => {
        await options.startGate;
      },
      stop: async () => {
        stops += 1;
      },
      client: {
        request: async <T>(
          method: string,
          params: unknown,
          requestOptions?: number | AppServerRpcRequestOptions,
        ): Promise<T> => {
          calls.push({
            method,
            params,
            ...(requestOptions === undefined ? {} : { options: requestOptions }),
          });
          if (method === "thread/resume" && options.failResume !== undefined) {
            throw options.failResume;
          }
          if (method === "turn/start") {
            if (options.failTurnStart !== undefined) throw options.failTurnStart;
            return { turn: { id: "turn-native" } } as T;
          }
          if (method === "turn/steer") return { turnId: "turn-native" } as T;
          if (method === "thread/resume" || method === "thread/unsubscribe") return {} as T;
          throw new Error(`unexpected method ${method}`);
        },
      },
    };
  };
  return {
    calls,
    createProcess,
    get processes() {
      return processes;
    },
    get stops() {
      return stops;
    },
    get processOptions() {
      return processOptions.at(-1);
    },
    notify(message: Record<string, unknown>, processIndex = processOptions.length - 1) {
      processOptions[processIndex]?.onNotification?.(message);
    },
  };
}
