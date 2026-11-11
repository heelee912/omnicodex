import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexThreadFollowUpQueueStore } from "../src/infrastructure/runtime/codex-thread-follow-up-queue-store.js";
import { CodexDesktopIpcClient } from "../src/infrastructure/windows/codex-desktop-ipc-client.js";

describe("CodexDesktopIpcClient", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  let queueDirectory: string;
  let queueStore: CodexThreadFollowUpQueueStore;

  beforeEach(async () => {
    queueDirectory = await mkdtemp(join(tmpdir(), "omnicodex-desktop-follow-up-"));
    queueStore = new CodexThreadFollowUpQueueStore({
      path: join(queueDirectory, "queue.json"),
    });
  });

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
    await rm(queueDirectory, { recursive: true, force: true });
  });

  it("starts an idle desktop thread through the native owner without resuming it", async () => {
    const fixture = await ipcFixture((request) => {
      if (request.method === "initialize") {
        return success(request, { clientId: "omni-client" }, "desktop-router");
      }
      if (request.method === "thread-owner-discovery") {
        return success(request, {}, "desktop-owner");
      }
      if (isFollowingBroadcast(request, true)) {
        return threadSnapshot("thread-desktop", 1, { turns: [] });
      }
      if (request.type === "broadcast") return undefined;
      if (request.method === "thread-follower-update-thread-settings") {
        return success(request, { ok: true }, "desktop-owner");
      }
      if (request.method === "thread-follower-start-turn") {
        return success(request, { result: { turn: { id: "turn-new" } } }, "desktop-owner");
      }
      throw new Error(`unexpected method ${String(request.method)}`);
    });
    cleanups.push(fixture.close);
    const client = new CodexDesktopIpcClient({
      endpoint: fixture.endpoint,
      queueStore,
      recoverQueue: false,
    });
    cleanups.push(() => client.dispose());

    await expect(
      client.sendFollowUpMessage("thread-desktop", "계속 진행해 주세요.", {
        cwd: "C:\\workspace",
        threadSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
        clientUserMessageId: "idle-operation",
      }),
    ).resolves.toMatchObject({
      threadId: "thread-desktop",
      ownerClientId: "desktop-owner",
      disposition: "started",
      clientUserMessageId: "idle-operation",
    });

    expect(fixture.requests.map((request) => request.method)).toEqual([
      "initialize",
      "thread-owner-discovery",
      "thread-stream-following-changed",
      "thread-stream-following-changed",
      "thread-follower-update-thread-settings",
      "thread-follower-start-turn",
    ]);
    expect(
      fixture.requests.find((request) => request.method === "thread-follower-start-turn"),
    ).toMatchObject({
      version: 2,
      targetClientId: "desktop-owner",
      params: {
        conversationId: "thread-desktop",
        turnStart: {
          request: {
            threadId: "thread-desktop",
            input: [{ type: "text", text: "계속 진행해 주세요.", text_elements: [] }],
            clientUserMessageId: "idle-operation",
          },
          context: { inheritThreadSettings: true },
        },
      },
    });
    expect(
      fixture.requests.some((request) =>
        ["thread/resume", "turn/start", "turn/steer", "thread-follower-steer-turn"].includes(
          String(request.method),
        ),
      ),
    ).toBe(false);
    expect(
      fixture.requests
        .filter((request) => request.type === "request" && request.method !== "initialize")
        .every((request) => !("timeoutMs" in request)),
    ).toBe(true);
  });

  it("serializes distinct follow-ups before reading the same desktop thread again", async () => {
    let firstStart: Record<string, unknown> | undefined;
    let firstTurnStarted = false;
    const fixture = await ipcFixture((request) => {
      if (request.method === "initialize") {
        return success(request, { clientId: "omni-client" }, "desktop-router");
      }
      if (request.method === "thread-owner-discovery") {
        return success(request, {}, "desktop-owner");
      }
      if (isFollowingBroadcast(request, true)) {
        return threadSnapshot(
          "thread-serialized",
          firstTurnStarted ? 2 : 1,
          firstTurnStarted
            ? {
                threadRuntimeStatus: { type: "active" },
                turns: [{ turnId: "turn-first", status: "inProgress" }],
              }
            : { threadRuntimeStatus: { type: "idle" }, turns: [] },
        );
      }
      if (request.type === "broadcast") return undefined;
      if (request.method === "thread-follower-start-turn") {
        if (firstStart !== undefined) throw new Error("overlapping desktop turn starts");
        firstStart = request;
        return undefined;
      }
      throw new Error(`unexpected method ${String(request.method)}`);
    });
    cleanups.push(fixture.close);
    const client = new CodexDesktopIpcClient({
      endpoint: fixture.endpoint,
      queueStore,
      recoverQueue: false,
    });
    cleanups.push(() => client.dispose());

    const first = client.sendFollowUpMessage("thread-serialized", "첫 메시지", {
      clientUserMessageId: "first-message",
    });
    await vi.waitFor(() => expect(firstStart).toBeDefined());
    const second = client.sendFollowUpMessage("thread-serialized", "두 번째 메시지", {
      clientUserMessageId: "second-message",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      fixture.requests.filter((request) => request.method === "thread-owner-discovery"),
    ).toHaveLength(1);

    firstTurnStarted = true;
    if (firstStart === undefined) throw new Error("first desktop turn was not started");
    fixture.send(success(firstStart, { result: { turn: { id: "turn-first" } } }, "desktop-owner"));
    await expect(first).resolves.toMatchObject({ disposition: "started" });
    await expect(second).resolves.toMatchObject({ disposition: "queued" });
    expect(
      fixture.requests.filter((request) => request.method === "thread-follower-start-turn"),
    ).toHaveLength(1);
    expect(await queueStore.list("desktop_ipc", "thread-serialized")).toMatchObject([
      { clientUserMessageId: "second-message" },
    ]);
  });

  it("queues an active desktop follow-up and dispatches it as a new turn after terminal state", async () => {
    let followingTrueCount = 0;
    let active = true;
    const fixture = await ipcFixture((request) => {
      if (request.method === "initialize") {
        return success(request, { clientId: "omni-client" }, "desktop-router");
      }
      if (request.method === "thread-owner-discovery") {
        return success(request, {}, "desktop-owner");
      }
      if (isFollowingBroadcast(request, true)) {
        followingTrueCount += 1;
        return threadSnapshot(
          "thread-active",
          active ? 1 : 2,
          active
            ? {
                threadRuntimeStatus: { type: "active" },
                turns: [{ turnId: "turn-active", status: "inProgress" }],
              }
            : {
                threadRuntimeStatus: { type: "idle" },
                turns: [{ turnId: "turn-active", status: "completed" }],
              },
        );
      }
      if (request.type === "broadcast") return undefined;
      if (request.method === "thread-follower-start-turn") {
        return success(request, { result: { turn: { id: "turn-follow-up" } } }, "desktop-owner");
      }
      throw new Error(`unexpected method ${String(request.method)}`);
    });
    cleanups.push(fixture.close);
    const client = new CodexDesktopIpcClient({
      endpoint: fixture.endpoint,
      queueStore,
      recoverQueue: false,
    });
    cleanups.push(() => client.dispose());

    await expect(
      client.sendFollowUpMessage("thread-active", "현재 응답 뒤에 실행해 주세요.", {
        clientUserMessageId: "queued-desktop-operation",
      }),
    ).resolves.toMatchObject({
      disposition: "queued",
      queue: {
        clientUserMessageId: "queued-desktop-operation",
        position: 1,
        persisted: true,
        dispatchAfter: "active_turn_terminal",
      },
    });
    expect(await queueStore.list("desktop_ipc", "thread-active")).toHaveLength(1);
    expect(
      fixture.requests.some((request) => request.method === "thread-follower-steer-turn"),
    ).toBe(false);

    await vi.waitFor(() => expect(followingTrueCount).toBeGreaterThanOrEqual(2));
    active = false;
    fixture.send(
      threadSnapshot("thread-active", 2, {
        threadRuntimeStatus: { type: "idle" },
        turns: [{ turnId: "turn-active", status: "completed" }],
      }),
    );

    await vi.waitFor(() => {
      expect(
        fixture.requests.filter((request) => request.method === "thread-follower-start-turn"),
      ).toHaveLength(1);
    });
    expect(
      fixture.requests.find((request) => request.method === "thread-follower-start-turn"),
    ).toMatchObject({
      params: {
        conversationId: "thread-active",
        turnStart: {
          request: {
            input: [{ type: "text", text: "현재 응답 뒤에 실행해 주세요.", text_elements: [] }],
            clientUserMessageId: "queued-desktop-operation",
          },
        },
      },
    });
    await vi.waitFor(async () => {
      expect(await queueStore.list("desktop_ipc", "thread-active")).toHaveLength(0);
    });
  });

  it("coalesces only one operation id and rejects reusing it for different input", async () => {
    const fixture = await ipcFixture((request) => {
      if (request.method === "initialize") {
        return success(request, { clientId: "omni-client" }, "desktop-router");
      }
      if (request.method === "thread-owner-discovery") {
        return success(request, {}, "desktop-owner");
      }
      if (isFollowingBroadcast(request, true)) {
        const threadId = String(
          (request.params as { conversationId?: string } | undefined)?.conversationId,
        );
        return threadSnapshot(threadId, 1, { turns: [] });
      }
      if (request.type === "broadcast") return undefined;
      if (request.method === "thread-follower-start-turn") {
        return success(request, { result: { turn: { id: randomUUID() } } }, "desktop-owner");
      }
      throw new Error(`unexpected method ${String(request.method)}`);
    });
    cleanups.push(fixture.close);
    const client = new CodexDesktopIpcClient({
      endpoint: fixture.endpoint,
      queueStore,
      recoverQueue: false,
    });
    cleanups.push(() => client.dispose());

    const operation = { clientUserMessageId: "same-operation", cwd: "C:\\first" };
    const first = await client.sendFollowUpMessage("thread-replayed", "한 번만", operation);
    await expect(
      client.sendFollowUpMessage("thread-replayed", "한 번만", operation),
    ).resolves.toEqual(first);
    await expect(
      client.sendFollowUpMessage("thread-replayed", "다른 입력", operation),
    ).rejects.toThrow("reused with different input");
    await client.sendFollowUpMessage("thread-replayed", "한 번만", {
      clientUserMessageId: "distinct-operation",
      cwd: "C:\\first",
    });

    expect(
      fixture.requests.filter((request) => request.method === "thread-follower-start-turn"),
    ).toHaveLength(2);
  });

  it("tombstones an unknown native start outcome instead of replaying it", async () => {
    const fixture = await ipcFixture((request) => {
      if (request.method === "initialize") {
        return success(request, { clientId: "omni-client" }, "desktop-router");
      }
      if (request.method === "thread-owner-discovery") {
        return success(request, {}, "desktop-owner");
      }
      if (isFollowingBroadcast(request, true)) {
        return threadSnapshot("thread-unknown", 1, { turns: [] });
      }
      if (request.type === "broadcast") return undefined;
      if (request.method === "thread-follower-start-turn") return undefined;
      throw new Error(`unexpected method ${String(request.method)}`);
    });
    cleanups.push(fixture.close);
    const client = new CodexDesktopIpcClient({
      endpoint: fixture.endpoint,
      queueStore,
      recoverQueue: false,
      followUpReplayWindowMs: 1_000,
    });
    cleanups.push(() => client.dispose());
    const options = { clientUserMessageId: "unknown-operation", timeoutMs: 25 };

    await expect(
      client.sendFollowUpMessage("thread-unknown", "한 번만", options),
    ).rejects.toMatchObject({
      name: "CodexThreadUnknownDispatchError",
      clientUserMessageId: "unknown-operation",
    });
    await expect(
      client.sendFollowUpMessage("thread-unknown", "한 번만", options),
    ).rejects.toMatchObject({
      name: "CodexThreadUnknownDispatchError",
      clientUserMessageId: "unknown-operation",
    });
    expect(
      fixture.requests.filter((request) => request.method === "thread-follower-start-turn"),
    ).toHaveLength(1);
  });

  it("loads complete history and applies revision-matched native desktop patches", async () => {
    let followingTrueCount = 0;
    const fixture = await ipcFixture((request) => {
      if (request.method === "initialize") {
        return success(request, { clientId: "omni-client" }, "desktop-router");
      }
      if (request.method === "thread-owner-discovery") {
        return success(request, {}, "desktop-owner");
      }
      if (request.method === "thread-follower-load-complete-history") {
        return success(request, { revision: 2 }, "desktop-owner");
      }
      if (isFollowingBroadcast(request, true)) {
        followingTrueCount += 1;
        if (followingTrueCount === 1) {
          return threadSnapshot("thread-history", 1, { turns: [] });
        }
        return {
          type: "broadcast",
          method: "thread-stream-state-changed",
          sourceClientId: "desktop-owner",
          targetClientIds: ["omni-client"],
          version: 11,
          params: {
            conversationId: "thread-history",
            hostId: "local",
            change: {
              type: "patches",
              baseRevision: 1,
              revision: 2,
              patches: [
                {
                  op: "add",
                  path: ["turns", 0],
                  value: { turnId: "turn-from-patch", status: "completed" },
                },
              ],
            },
          },
        };
      }
      if (request.type === "broadcast") return undefined;
      throw new Error(`unexpected method ${String(request.method)}`);
    });
    cleanups.push(fixture.close);
    const client = new CodexDesktopIpcClient({
      endpoint: fixture.endpoint,
      queueStore,
      recoverQueue: false,
    });
    cleanups.push(() => client.dispose());

    await expect(client.readThreadSnapshot("thread-history")).resolves.toMatchObject({
      revision: 2,
      conversationState: {
        turns: [{ turnId: "turn-from-patch", status: "completed" }],
      },
    });
    expect(
      fixture.requests
        .filter((request) => request.type === "request" && request.method !== "initialize")
        .every((request) => !("timeoutMs" in request)),
    ).toBe(true);
  });

  it("recovers a late native mutation acknowledgement without dispatching the turn twice", async () => {
    const fixture = await ipcFixture((request) => {
      if (request.method === "initialize") {
        return success(request, { clientId: "omni-client" }, "desktop-router");
      }
      if (request.method === "thread-owner-discovery") {
        return success(request, {}, "desktop-owner");
      }
      if (isFollowingBroadcast(request, true)) {
        return threadSnapshot("thread-late-terminal", 1, { turns: [] });
      }
      if (request.type === "broadcast") return undefined;
      if (request.method === "thread-follower-start-turn") return undefined;
      throw new Error(`unexpected method ${String(request.method)}`);
    });
    cleanups.push(fixture.close);
    const client = new CodexDesktopIpcClient({
      endpoint: fixture.endpoint,
      queueStore,
      recoverQueue: false,
    });
    cleanups.push(() => client.dispose());
    const operation = {
      clientUserMessageId: "late-terminal-operation",
      timeoutMs: 25,
    };

    await expect(
      client.sendFollowUpMessage("thread-late-terminal", "한 번만 실행", operation),
    ).rejects.toMatchObject({
      name: "CodexThreadUnknownDispatchError",
      clientUserMessageId: "late-terminal-operation",
    });
    const startRequest = fixture.requests.find(
      (request) => request.method === "thread-follower-start-turn",
    );
    if (startRequest === undefined) throw new Error("native start request was not dispatched");
    fixture.send(success(startRequest, { result: { turn: { id: "turn-late" } } }, "desktop-owner"));

    await expect(
      client.sendFollowUpMessage("thread-late-terminal", "한 번만 실행", {
        ...operation,
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({
      disposition: "started",
      clientUserMessageId: "late-terminal-operation",
      nativeResult: { result: { turn: { id: "turn-late" } } },
    });
    expect(
      fixture.requests.filter((request) => request.method === "thread-follower-start-turn"),
    ).toHaveLength(1);
  });

  it("honors caller abort before mutation dispatch without creating a turn", async () => {
    const fixture = await ipcFixture((request) => {
      if (request.method === "initialize") {
        return success(request, { clientId: "omni-client" }, "desktop-router");
      }
      if (request.method === "thread-owner-discovery") return undefined;
      if (request.type === "broadcast") return undefined;
      throw new Error(`unexpected method ${String(request.method)}`);
    });
    cleanups.push(fixture.close);
    const client = new CodexDesktopIpcClient({
      endpoint: fixture.endpoint,
      queueStore,
      recoverQueue: false,
    });
    cleanups.push(() => client.dispose());
    const controller = new AbortController();
    const completion = client.sendFollowUpMessage("thread-aborted", "실행하지 마세요", {
      clientUserMessageId: "aborted-before-dispatch",
      signal: controller.signal,
    });

    await vi.waitFor(() => {
      expect(
        fixture.requests.filter((request) => request.method === "thread-owner-discovery"),
      ).toHaveLength(1);
    });
    controller.abort(new Error("caller stopped"));

    await expect(completion).rejects.toThrow("caller stopped");
    expect(
      fixture.requests.filter((request) => request.method === "thread-follower-start-turn"),
    ).toHaveLength(0);
  });

  it("does not start a turn after cancellation while a settings mutation is awaiting acknowledgement", async () => {
    const fixture = await ipcFixture((request) => {
      if (request.method === "initialize") {
        return success(request, { clientId: "omni-client" }, "desktop-router");
      }
      if (request.method === "thread-owner-discovery") {
        return success(request, {}, "desktop-owner");
      }
      if (isFollowingBroadcast(request, true)) {
        return threadSnapshot("thread-settings-aborted", 1, { turns: [] });
      }
      if (request.type === "broadcast") return undefined;
      if (request.method === "thread-follower-update-thread-settings") return undefined;
      throw new Error(`unexpected method ${String(request.method)}`);
    });
    cleanups.push(fixture.close);
    const client = new CodexDesktopIpcClient({
      endpoint: fixture.endpoint,
      queueStore,
      recoverQueue: false,
    });
    cleanups.push(() => client.dispose());
    const controller = new AbortController();
    const completion = client.sendFollowUpMessage("thread-settings-aborted", "do not start", {
      clientUserMessageId: "settings-aborted-operation",
      signal: controller.signal,
      threadSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
    });

    await vi.waitFor(() => {
      expect(
        fixture.requests.filter(
          (request) => request.method === "thread-follower-update-thread-settings",
        ),
      ).toHaveLength(1);
    });
    controller.abort(new Error("caller stopped"));
    await expect(completion).rejects.toMatchObject({
      name: "CodexThreadUnknownDispatchError",
      clientUserMessageId: "settings-aborted-operation",
    });

    const settingsRequest = fixture.requests.find(
      (request) => request.method === "thread-follower-update-thread-settings",
    );
    if (settingsRequest === undefined) throw new Error("settings request was not dispatched");
    fixture.send(success(settingsRequest, { ok: true }, "desktop-owner"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      fixture.requests.filter((request) => request.method === "thread-follower-start-turn"),
    ).toHaveLength(0);
  });

  it("supports caller deadlines beyond the Node timer ceiling without shortening them", async () => {
    const fixture = await ipcFixture((request) => {
      if (request.method === "initialize") {
        return success(request, { clientId: "omni-client" }, "desktop-router");
      }
      if (request.method === "thread-owner-discovery") {
        return success(request, {}, "desktop-owner");
      }
      if (request.method === "thread-follower-load-complete-history") {
        return success(request, { revision: 1 }, "desktop-owner");
      }
      if (isFollowingBroadcast(request, true)) {
        return threadSnapshot("thread-long-boundary", 1, { turns: [] });
      }
      if (request.type === "broadcast") return undefined;
      throw new Error(`unexpected method ${String(request.method)}`);
    });
    cleanups.push(fixture.close);
    const client = new CodexDesktopIpcClient({
      endpoint: fixture.endpoint,
      queueStore,
      recoverQueue: false,
    });
    cleanups.push(() => client.dispose());

    await expect(
      client.readThreadSnapshot("thread-long-boundary", { timeoutMs: 3_000_000_000 }),
    ).resolves.toMatchObject({ revision: 1 });
    const boundedRequests = fixture.requests.filter(
      (request) => request.type === "request" && request.method !== "initialize",
    );
    expect(boundedRequests.length).toBeGreaterThan(0);
    expect(
      boundedRequests.every(
        (request) => typeof request.timeoutMs === "number" && request.timeoutMs > 2_147_483_647,
      ),
    ).toBe(true);
  });

  it("finds queued operation ids anywhere in complete history without an item cap", async () => {
    let followingTrueCount = 0;
    const fixture = await ipcFixture((request) => {
      if (request.method === "initialize") {
        return success(request, { clientId: "omni-client" }, "desktop-router");
      }
      if (request.method === "thread-owner-discovery") {
        return success(request, {}, "desktop-owner");
      }
      if (isFollowingBroadcast(request, true)) {
        followingTrueCount += 1;
        return threadSnapshot("thread-large-history", 1, {
          threadRuntimeStatus: { type: "active" },
          turns: [{ turnId: "active-turn", status: "inProgress" }],
        });
      }
      if (request.type === "broadcast") return undefined;
      if (request.method === "thread-follower-start-turn") {
        return success(request, { result: { turn: { id: "unexpected-turn" } } }, "desktop-owner");
      }
      throw new Error(`unexpected method ${String(request.method)}`);
    });
    cleanups.push(fixture.close);
    const client = new CodexDesktopIpcClient({
      endpoint: fixture.endpoint,
      queueStore,
      recoverQueue: false,
    });
    cleanups.push(() => client.dispose());

    await expect(
      client.sendFollowUpMessage("thread-large-history", "이미 기록된 작업", {
        clientUserMessageId: "large-history-operation",
      }),
    ).resolves.toMatchObject({ disposition: "queued" });
    await vi.waitFor(() => expect(followingTrueCount).toBeGreaterThanOrEqual(2));
    const turns = Array.from({ length: 50_001 }, (_, index) =>
      index === 0
        ? { clientUserMessageId: "large-history-operation", status: "completed" }
        : { turnId: `turn-${index}`, status: "completed" },
    );
    fixture.send(
      threadSnapshot("thread-large-history", 2, {
        threadRuntimeStatus: { type: "idle" },
        turns,
      }),
    );

    await vi.waitFor(async () => {
      expect(await queueStore.list("desktop_ipc", "thread-large-history")).toHaveLength(0);
    });
    expect(
      fixture.requests.filter((request) => request.method === "thread-follower-start-turn"),
    ).toHaveLength(0);
  });
});

interface Fixture {
  readonly endpoint: string;
  readonly requests: Array<Record<string, unknown>>;
  send(message: Record<string, unknown>): void;
  close(): Promise<void>;
}

async function ipcFixture(
  respond: (request: Record<string, unknown>) => Record<string, unknown> | undefined,
): Promise<Fixture> {
  const endpoint = `\\\\.\\pipe\\omnicodex-ipc-test-${randomUUID()}`;
  const requests: Array<Record<string, unknown>> = [];
  let clientSocket: Socket | undefined;
  const server = createServer((socket) => {
    clientSocket = socket;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < 4 + length) return;
        const request = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")) as Record<
          string,
          unknown
        >;
        buffer = buffer.subarray(4 + length);
        requests.push(request);
        const response = respond(request);
        if (response !== undefined) socket.write(frame(response));
      }
    });
  });
  await listen(server, endpoint);
  return {
    endpoint,
    requests,
    send: (message) => {
      if (clientSocket === undefined) throw new Error("fixture client is not connected");
      clientSocket.write(frame(message));
    },
    close: async () => {
      clientSocket?.destroy();
      await close(server);
    },
  };
}

function isFollowingBroadcast(request: Record<string, unknown>, following: boolean): boolean {
  return (
    request.type === "broadcast" &&
    request.method === "thread-stream-following-changed" &&
    (request.params as { following?: boolean } | undefined)?.following === following
  );
}

function threadSnapshot(
  threadId: string,
  revision: number,
  conversationState: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop-owner",
    targetClientIds: ["omni-client"],
    version: 11,
    params: {
      conversationId: threadId,
      hostId: "local",
      change: { type: "snapshot", revision, conversationState },
    },
  };
}

function success(
  request: Record<string, unknown>,
  result: unknown,
  handledByClientId: string,
): Record<string, unknown> {
  return {
    type: "response",
    requestId: request.requestId,
    resultType: "success",
    method: request.method,
    handledByClientId,
    result,
  };
}

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const output = Buffer.allocUnsafe(4 + payload.length);
  output.writeUInt32LE(payload.length, 0);
  payload.copy(output, 4);
  return output;
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
