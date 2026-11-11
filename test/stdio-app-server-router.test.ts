import { once } from "node:events";
import { connect, createServer, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { PolicyDocumentationService } from "../src/application/policy-documentation-service.js";
import {
  attachOmniClientSocket,
  StdioAppServerRouter,
} from "../src/infrastructure/runtime/stdio-app-server-router.js";

const ownerKey = "test-owner-key-not-a-secret";
const markdown = "# 보호 정책\n\n원문입니다.\n";

function harness() {
  const server: Record<string, unknown>[] = [];
  const desktop: Record<string, unknown>[] = [];
  const clients = new Map<number, Record<string, unknown>[]>();
  const policyDocumentation = {
    readBrowserDocument: async () => markdown,
  } as unknown as PolicyDocumentationService;
  const router = new StdioAppServerRouter({
    sendServer: (line) => server.push(JSON.parse(line)),
    sendDesktop: (line) => desktop.push(JSON.parse(line)),
    policyDocumentation,
    ownerKey,
  });
  const addClient = (name = "omnicodex") => {
    const messages: Record<string, unknown>[] = [];
    const id = router.addClient((line) => messages.push(JSON.parse(line)));
    clients.set(id, messages);
    router.receiveClient(
      id,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name, version: "1" },
          capabilities: { extensions: { "omnicodex/thread-owner-key": ownerKey } },
        },
      }),
    );
    return { id, messages };
  };
  return { router, server, desktop, clients, addClient };
}

async function ready(h: ReturnType<typeof harness>) {
  h.router.receiveDesktop(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
      params: { clientInfo: { name: "Codex Desktop", version: "1" } },
    }),
  );
  await h.router.receiveServer(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      result: { codexHome: "C:\\Users\\ExampleUser\\.codex" },
    }),
  );
  expect(h.router.ready).toBe(true);
}

describe("Desktop stdio App Server routing", () => {
  it("isolates a failed client socket while another client continues", async () => {
    let nextClient = 0;
    const received: Array<{ client: number; line: string }> = [];
    const removed: number[] = [];
    const failures: unknown[] = [];
    const accepted: Socket[] = [];
    const router = {
      addClient: () => ++nextClient,
      removeClient: (client: number) => {
        removed.push(client);
      },
      receiveClient: (client: number, line: string) => {
        received.push({ client, line });
      },
    };
    const server = createServer((socket) => {
      accepted.push(socket);
      attachOmniClientSocket(
        socket,
        router,
        () => undefined,
        (error) => failures.push(error),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test address");
    const broken = connect(address.port, "127.0.0.1");
    const other = connect(address.port, "127.0.0.1");
    broken.on("error", () => undefined);
    other.on("error", () => undefined);
    try {
      await Promise.all([once(broken, "connect"), once(other, "connect")]);
      await vi.waitFor(() => expect(accepted).toHaveLength(2));
      accepted[0]?.destroy(new Error("simulated connection reset"));
      await vi.waitFor(() => expect(removed).toContain(1));
      other.write("second session remains connected\n");
      await vi.waitFor(() =>
        expect(received).toContainEqual({ client: 2, line: "second session remains connected" }),
      );
      expect(failures).toHaveLength(1);
      expect(removed).not.toContain(2);
    } finally {
      broken.destroy();
      other.destroy();
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("preserves Desktop initialization and isolates two Work threads", async () => {
    const h = harness();
    await ready(h);
    const first = h.addClient();
    const second = h.addClient();
    expect(first.messages[0]).toMatchObject({ id: 1, result: { codexHome: expect.any(String) } });
    expect(second.messages[0]).toMatchObject({ id: 1, result: { codexHome: expect.any(String) } });
    h.router.receiveClient(first.id, JSON.stringify({ id: 2, method: "thread/start", params: {} }));
    h.router.receiveClient(
      second.id,
      JSON.stringify({ id: 2, method: "thread/start", params: {} }),
    );
    const firstRequest = h.server.at(-2);
    const secondRequest = h.server.at(-1);
    expect(firstRequest?.id).not.toBe(secondRequest?.id);
    await h.router.receiveServer(
      JSON.stringify({ id: firstRequest?.id, result: { thread: { id: "thr-a" } } }),
    );
    await h.router.receiveServer(
      JSON.stringify({ id: secondRequest?.id, result: { thread: { id: "thr-b" } } }),
    );
    expect(first.messages.at(-1)).toMatchObject({ id: 2, result: { thread: { id: "thr-a" } } });
    expect(second.messages.at(-1)).toMatchObject({ id: 2, result: { thread: { id: "thr-b" } } });
    await h.router.receiveServer(
      JSON.stringify({ method: "turn/started", params: { threadId: "thr-a" } }),
    );
    expect(first.messages.at(-1)).toMatchObject({ method: "turn/started" });
    expect(second.messages.at(-1)).not.toMatchObject({ method: "turn/started" });
    expect(h.desktop.at(-1)).toMatchObject({ method: "turn/started" });
  });

  it("routes native tool requests only to their owner and replays after reconnect", async () => {
    const h = harness();
    await ready(h);
    const first = h.addClient();
    const second = h.addClient();
    h.router.receiveClient(
      first.id,
      JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "thr-a" } }),
    );
    await h.router.receiveServer(
      JSON.stringify({
        id: 99,
        method: "item/tool/call",
        params: { threadId: "thr-a", tool: "native_tool" },
      }),
    );
    expect(first.messages.at(-1)).toMatchObject({ id: 99, method: "item/tool/call" });
    expect(second.messages.at(-1)?.method).not.toBe("item/tool/call");
    h.router.receiveClient(second.id, JSON.stringify({ id: 99, result: { success: true } }));
    expect(h.server.at(-1)?.id).not.toBe(99);
    h.router.removeClient(first.id);
    await h.router.receiveServer(
      JSON.stringify({
        id: 100,
        method: "item/tool/call",
        params: { threadId: "thr-a", tool: "native_tool" },
      }),
    );
    expect(h.desktop.at(-1)?.id).not.toBe(100);
    const replacement = h.addClient();
    h.router.receiveClient(
      replacement.id,
      JSON.stringify({
        id: 3,
        method: "thread/resume",
        params: { threadId: "thr-a" },
      }),
    );
    expect(replacement.messages.some((message) => message.id === 99)).toBe(true);
    expect(replacement.messages.some((message) => message.id === 100)).toBe(true);
    h.router.receiveClient(replacement.id, JSON.stringify({ id: 100, result: { success: true } }));
    expect(h.server.at(-1)).toMatchObject({ id: 100, result: { success: true } });
  });

  it("answers protected documentation from the verified Korean Markdown and keeps verification in Desktop", async () => {
    const h = harness();
    await ready(h);
    const first = h.addClient();
    h.router.receiveClient(
      first.id,
      JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "thr-a" } }),
    );
    await h.router.receiveServer(
      JSON.stringify({
        id: 90,
        method: "item/tool/call",
        params: {
          threadId: "thr-a",
          namespace: "chrome",
          tool: "control_chrome",
          arguments: {
            operation: "documentation",
            documentation_name: "confirmations",
          },
        },
      }),
    );
    expect(h.server.at(-1)).toMatchObject({
      id: 90,
      result: { success: true, contentItems: [{ text: markdown }] },
    });
    expect(first.messages.some((message) => message.id === 90)).toBe(false);
    await h.router.receiveServer(
      JSON.stringify({
        id: 91,
        method: "mcpServer/elicitation/request",
        params: { threadId: "thr-a", mode: "openai/userVerification" },
      }),
    );
    expect(h.desktop.at(-1)).toMatchObject({ id: 91, method: "mcpServer/elicitation/request" });
    expect(first.messages.some((message) => message.id === 91)).toBe(false);
    h.router.receiveClient(
      first.id,
      JSON.stringify({ id: 4, method: "userVerification/verify", params: {} }),
    );
    expect(first.messages.at(-1)).toMatchObject({ id: 4, error: { code: -32600 } });

    const native = h.addClient("codex-native");
    h.router.receiveClient(
      native.id,
      JSON.stringify({ id: 5, method: "turn/start", params: { threadId: "native-thread" } }),
    );
    await h.router.receiveServer(
      JSON.stringify({
        id: 92,
        method: "item/tool/call",
        params: {
          threadId: "native-thread",
          namespace: "chrome",
          tool: "control_chrome",
          arguments: { operation: "documentation", documentation_name: "confirmations" },
        },
      }),
    );
    expect(h.server.at(-1)).toMatchObject({
      id: 92,
      result: { success: true, contentItems: [{ text: markdown }] },
    });
    expect(JSON.stringify(h.server.at(-1))).not.toContain('"allowed":false');
    expect(native.messages.some((message) => message.id === 92)).toBe(false);
  });

  it("keeps the shared Desktop subscription when an OmniCodex client unsubscribes", async () => {
    const h = harness();
    await ready(h);
    const client = h.addClient();
    h.router.receiveClient(
      client.id,
      JSON.stringify({
        id: 2,
        method: "turn/start",
        params: { threadId: "desktop-thread" },
      }),
    );
    const forwardedBefore = h.server.length;
    h.router.receiveClient(
      client.id,
      JSON.stringify({
        id: 3,
        method: "thread/unsubscribe",
        params: { threadId: "desktop-thread" },
      }),
    );
    expect(h.server).toHaveLength(forwardedBefore);
    expect(client.messages.at(-1)).toMatchObject({ id: 3, result: {} });
    await h.router.receiveServer(
      JSON.stringify({
        method: "turn/completed",
        params: { threadId: "desktop-thread" },
      }),
    );
    expect(h.desktop.at(-1)).toMatchObject({ method: "turn/completed" });
  });

  it.each(["thread/resume", "turn/start"])(
    "restores Desktop ownership when an external %s fails",
    async (method) => {
      const h = harness();
      await ready(h);
      const client = h.addClient();
      h.router.receiveClient(
        client.id,
        JSON.stringify({ id: 2, method, params: { threadId: "desktop-thread" } }),
      );
      const transitionId = h.server.at(-1)?.id;
      await h.router.receiveServer(
        JSON.stringify({
          id: 90,
          method: "item/tool/call",
          params: { threadId: "desktop-thread", turnId: "active-turn" },
        }),
      );
      expect(client.messages.at(-1)).toMatchObject({ id: 90 });
      await h.router.receiveServer(
        JSON.stringify({ id: transitionId, error: { code: -1, message: "failed" } }),
      );
      await h.router.receiveServer(
        JSON.stringify({
          id: 91,
          method: "item/tool/call",
          params: { threadId: "desktop-thread", turnId: "active-turn" },
        }),
      );
      expect(h.desktop.at(-1)).toMatchObject({ id: 91, method: "item/tool/call" });
      h.router.receiveClient(client.id, JSON.stringify({ id: 90, result: { success: true } }));
      expect(h.server.at(-1)).toMatchObject({ id: 90, result: { success: true } });
    },
  );

  it("does not undo a newer successful Work ownership claim when an older request fails", async () => {
    const h = harness();
    await ready(h);
    const client = h.addClient();
    h.router.receiveClient(
      client.id,
      JSON.stringify({ id: 2, method: "thread/resume", params: { threadId: "work-thread" } }),
    );
    const older = h.server.at(-1)?.id;
    h.router.receiveClient(
      client.id,
      JSON.stringify({ id: 3, method: "turn/start", params: { threadId: "work-thread" } }),
    );
    const newer = h.server.at(-1)?.id;
    await h.router.receiveServer(JSON.stringify({ id: newer, result: { turn: { id: "turn" } } }));
    await h.router.receiveServer(JSON.stringify({ id: older, error: { code: -1 } }));
    await h.router.receiveServer(
      JSON.stringify({ id: 91, method: "item/tool/call", params: { threadId: "work-thread" } }),
    );
    expect(client.messages.at(-1)).toMatchObject({ id: 91, method: "item/tool/call" });
  });

  it.each(["old-first", "new-first"])(
    "restores Desktop after overlapping Work claims both fail (%s)",
    async (order) => {
      const h = harness();
      await ready(h);
      const client = h.addClient();
      h.router.receiveClient(
        client.id,
        JSON.stringify({ id: 2, method: "thread/resume", params: { threadId: "thread" } }),
      );
      const older = h.server.at(-1)?.id;
      h.router.receiveClient(
        client.id,
        JSON.stringify({ id: 3, method: "turn/start", params: { threadId: "thread" } }),
      );
      const newer = h.server.at(-1)?.id;
      for (const id of order === "old-first" ? [older, newer] : [newer, older]) {
        await h.router.receiveServer(JSON.stringify({ id, error: { code: -1 } }));
      }
      await h.router.receiveServer(
        JSON.stringify({ id: 91, method: "item/tool/call", params: { threadId: "thread" } }),
      );
      expect(h.desktop.at(-1)).toMatchObject({ id: 91, method: "item/tool/call" });
    },
  );

  it("replays orphaned requests to Desktop only after a successful resume", async () => {
    const h = harness();
    await ready(h);
    const abandoned = h.addClient();
    const unrelated = h.addClient();
    h.router.receiveClient(
      abandoned.id,
      JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "desktop-thread" } }),
    );
    h.router.receiveClient(
      unrelated.id,
      JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "other-thread" } }),
    );
    h.router.removeClient(abandoned.id);
    await h.router.receiveServer(
      JSON.stringify({
        id: 90,
        method: "item/tool/call",
        params: { threadId: "desktop-thread", turnId: "active-turn" },
      }),
    );
    h.router.receiveDesktop(
      JSON.stringify({ id: 101, method: "thread/resume", params: { threadId: "desktop-thread" } }),
    );
    await h.router.receiveServer(
      JSON.stringify({
        id: 91,
        method: "item/tool/call",
        params: { threadId: "desktop-thread", turnId: "active-turn" },
      }),
    );
    expect(h.desktop.some((message) => message.id === 90 || message.id === 91)).toBe(false);
    await h.router.receiveServer(
      JSON.stringify({
        id: 101,
        result: {
          thread: { id: "desktop-thread", turns: [{ id: "active-turn", status: "inProgress" }] },
        },
      }),
    );
    expect(h.desktop.slice(-3)).toMatchObject([
      { id: 101, result: {} },
      { id: 90, method: "item/tool/call" },
      { id: 91, method: "item/tool/call" },
    ]);
    h.router.receiveDesktop(JSON.stringify({ id: 90, result: { success: true } }));
    expect(h.server.at(-1)).toMatchObject({ id: 90, result: { success: true } });
    await h.router.receiveServer(
      JSON.stringify({ id: 92, method: "item/tool/call", params: { threadId: "other-thread" } }),
    );
    expect(unrelated.messages.at(-1)).toMatchObject({ id: 92, method: "item/tool/call" });
  });

  it("keeps a connected Work owner when Desktop only resumes to view its thread", async () => {
    const h = harness();
    await ready(h);
    const owner = h.addClient();
    h.router.receiveClient(
      owner.id,
      JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "work-thread" } }),
    );
    h.router.receiveDesktop(
      JSON.stringify({ id: 101, method: "thread/resume", params: { threadId: "work-thread" } }),
    );
    await h.router.receiveServer(
      JSON.stringify({ id: 89, method: "item/tool/call", params: { threadId: "work-thread" } }),
    );
    expect(owner.messages.at(-1)).toMatchObject({ id: 89, method: "item/tool/call" });
    await h.router.receiveServer(
      JSON.stringify({ id: 101, result: { thread: { id: "work-thread" } } }),
    );
    await h.router.receiveServer(
      JSON.stringify({ id: 90, method: "item/tool/call", params: { threadId: "work-thread" } }),
    );
    expect(owner.messages.at(-1)).toMatchObject({ id: 90, method: "item/tool/call" });
    expect(h.desktop.some((message) => message.id === 90)).toBe(false);
  });

  it("does not block or take requests from a connected Work owner during a Desktop start", async () => {
    const h = harness();
    await ready(h);
    const owner = h.addClient();
    h.router.receiveClient(
      owner.id,
      JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "shared-thread" } }),
    );
    h.router.receiveDesktop(
      JSON.stringify({ id: 101, method: "turn/start", params: { threadId: "shared-thread" } }),
    );
    await h.router.receiveServer(
      JSON.stringify({
        id: 90,
        method: "item/tool/call",
        params: { threadId: "shared-thread", turnId: "new-turn" },
      }),
    );
    expect(owner.messages.at(-1)).toMatchObject({ id: 90, method: "item/tool/call" });
    h.router.receiveClient(owner.id, JSON.stringify({ id: 90, result: { success: true } }));
    expect(h.server.at(-1)).toMatchObject({ id: 90, result: { success: true } });
    await h.router.receiveServer(JSON.stringify({ id: 101, error: { code: -1, message: "busy" } }));
    h.router.receiveDesktop(
      JSON.stringify({ id: 102, method: "turn/start", params: { threadId: "shared-thread" } }),
    );
    await h.router.receiveServer(
      JSON.stringify({
        id: 91,
        method: "item/tool/call",
        params: { threadId: "shared-thread", turnId: "new-turn" },
      }),
    );
    expect(owner.messages.at(-1)).toMatchObject({ id: 91, method: "item/tool/call" });
    await h.router.receiveServer(JSON.stringify({ id: 102, result: { turn: { id: "new-turn" } } }));
    await h.router.receiveServer(
      JSON.stringify({
        id: 92,
        method: "item/tool/call",
        params: { threadId: "shared-thread", turnId: "new-turn" },
      }),
    );
    expect(owner.messages.at(-1)).toMatchObject({ id: 92, method: "item/tool/call" });
    expect(h.desktop.some((message) => message.id === 91 || message.id === 92)).toBe(false);
  });

  it.each(["thread/resume", "turn/start"])(
    "does not transfer orphaned requests on a failed Desktop %s",
    async (method) => {
      const h = harness();
      await ready(h);
      const owner = h.addClient();
      h.router.receiveClient(
        owner.id,
        JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "work-thread" } }),
      );
      h.router.removeClient(owner.id);
      h.router.receiveDesktop(
        JSON.stringify({ id: 101, method, params: { threadId: "work-thread" } }),
      );
      await h.router.receiveServer(
        JSON.stringify({ id: 90, method: "item/tool/call", params: { threadId: "work-thread" } }),
      );
      await h.router.receiveServer(
        JSON.stringify({ id: 101, error: { code: -1, message: "failed" } }),
      );
      expect(h.desktop.some((message) => message.id === 90)).toBe(false);
      const replacement = h.addClient();
      h.router.receiveClient(
        replacement.id,
        JSON.stringify({ id: 3, method: "thread/resume", params: { threadId: "work-thread" } }),
      );
      expect(replacement.messages.some((message) => message.id === 90)).toBe(true);
    },
  );

  it("replays orphaned requests after a successful Desktop start", async () => {
    const h = harness();
    await ready(h);
    const owner = h.addClient();
    h.router.receiveClient(
      owner.id,
      JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "shared-thread" } }),
    );
    await h.router.receiveServer(
      JSON.stringify({
        id: 90,
        method: "item/tool/call",
        params: { threadId: "shared-thread", turnId: "new-turn" },
      }),
    );
    expect(owner.messages.at(-1)).toMatchObject({ id: 90, method: "item/tool/call" });
    h.router.removeClient(owner.id);
    h.router.receiveDesktop(
      JSON.stringify({ id: 101, method: "turn/start", params: { threadId: "shared-thread" } }),
    );
    await h.router.receiveServer(
      JSON.stringify({
        id: 91,
        method: "item/tool/call",
        params: { threadId: "shared-thread", turnId: "new-turn" },
      }),
    );
    expect(h.desktop.some((message) => message.id === 90 || message.id === 91)).toBe(false);
    await h.router.receiveServer(JSON.stringify({ id: 101, result: { turn: { id: "new-turn" } } }));
    expect(h.desktop.slice(-3)).toMatchObject([
      { id: 101, result: { turn: { id: "new-turn" } } },
      { id: 90, method: "item/tool/call" },
      { id: 91, method: "item/tool/call" },
    ]);
    h.router.receiveDesktop(JSON.stringify({ id: 90, result: { success: true } }));
    expect(h.server.at(-1)).toMatchObject({ id: 90, result: { success: true } });
  });

  it("reclaims only the matching turn and keeps unknown or different turns pending", async () => {
    const h = harness();
    await ready(h);
    const owner = h.addClient();
    h.router.receiveClient(
      owner.id,
      JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "shared-thread" } }),
    );
    h.router.removeClient(owner.id);
    for (const [id, turnId] of [
      [90, "active-turn"],
      [91, "old-turn"],
      [92, undefined],
    ] as const) {
      await h.router.receiveServer(
        JSON.stringify({
          id,
          method: "item/tool/call",
          params: { threadId: "shared-thread", turnId },
        }),
      );
    }
    h.router.receiveDesktop(
      JSON.stringify({ id: 101, method: "turn/start", params: { threadId: "shared-thread" } }),
    );
    await h.router.receiveServer(
      JSON.stringify({ id: 101, result: { turn: { id: "active-turn" } } }),
    );
    expect(h.desktop.at(-1)).toMatchObject({ id: 90, method: "item/tool/call" });
    expect(h.desktop.some((message) => message.id === 91 || message.id === 92)).toBe(false);
    await h.router.receiveServer(
      JSON.stringify({
        id: 93,
        method: "item/tool/call",
        params: { threadId: "shared-thread", turnId: "active-turn" },
      }),
    );
    expect(h.desktop.at(-1)).toMatchObject({ id: 93, method: "item/tool/call" });
    await h.router.receiveServer(
      JSON.stringify({
        method: "turn/completed",
        params: { threadId: "shared-thread", turn: { id: "active-turn" } },
      }),
    );
    await h.router.receiveServer(
      JSON.stringify({
        id: 94,
        method: "item/tool/call",
        params: { threadId: "shared-thread", turnId: "active-turn" },
      }),
    );
    expect(h.desktop.some((message) => message.id === 94)).toBe(false);
    const replacement = h.addClient();
    h.router.receiveClient(
      replacement.id,
      JSON.stringify({ id: 3, method: "thread/resume", params: { threadId: "shared-thread" } }),
    );
    expect(
      replacement.messages.filter((message) => [91, 92, 94].includes(Number(message.id))),
    ).toHaveLength(3);
  });

  it("keeps orphaned requests pending if resume does not identify an active turn", async () => {
    const h = harness();
    await ready(h);
    const owner = h.addClient();
    h.router.receiveClient(
      owner.id,
      JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "shared-thread" } }),
    );
    h.router.removeClient(owner.id);
    await h.router.receiveServer(
      JSON.stringify({
        id: 90,
        method: "item/tool/call",
        params: { threadId: "shared-thread", turnId: "active-turn" },
      }),
    );
    h.router.receiveDesktop(
      JSON.stringify({ id: 101, method: "thread/resume", params: { threadId: "shared-thread" } }),
    );
    await h.router.receiveServer(
      JSON.stringify({ id: 101, result: { thread: { id: "shared-thread", turns: [] } } }),
    );
    expect(h.desktop.some((message) => message.id === 90)).toBe(false);
    const replacement = h.addClient();
    h.router.receiveClient(
      replacement.id,
      JSON.stringify({ id: 3, method: "thread/resume", params: { threadId: "shared-thread" } }),
    );
    expect(replacement.messages.some((message) => message.id === 90)).toBe(true);
  });

  it("keeps an adopted Desktop turn separate when the Work connection resumes", async () => {
    const h = harness();
    await ready(h);
    const original = h.addClient();
    h.router.receiveClient(
      original.id,
      JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "shared-thread" } }),
    );
    await h.router.receiveServer(
      JSON.stringify({
        id: 90,
        method: "item/tool/call",
        params: { threadId: "shared-thread", turnId: "active-turn" },
      }),
    );
    h.router.removeClient(original.id);
    h.router.receiveDesktop(
      JSON.stringify({ id: 101, method: "thread/resume", params: { threadId: "shared-thread" } }),
    );
    await h.router.receiveServer(
      JSON.stringify({
        id: 101,
        result: {
          thread: { id: "shared-thread", turns: [{ id: "active-turn", status: "inProgress" }] },
        },
      }),
    );
    expect(h.desktop.filter((message) => message.id === 90)).toHaveLength(1);
    const replacement = h.addClient();
    h.router.receiveClient(
      replacement.id,
      JSON.stringify({ id: 3, method: "thread/resume", params: { threadId: "shared-thread" } }),
    );
    await h.router.receiveServer(
      JSON.stringify({ id: h.server.at(-1)?.id, result: { thread: { id: "shared-thread" } } }),
    );
    expect(replacement.messages.some((message) => message.id === 90)).toBe(false);
    h.router.receiveDesktop(JSON.stringify({ id: 90, result: { success: true } }));
    expect(h.server.at(-1)).toMatchObject({ id: 90, result: { success: true } });
    await h.router.receiveServer(
      JSON.stringify({
        id: 91,
        method: "item/tool/call",
        params: { threadId: "shared-thread", turnId: "active-turn" },
      }),
    );
    expect(h.desktop.at(-1)).toMatchObject({ id: 91, method: "item/tool/call" });
    expect(replacement.messages.some((message) => message.id === 91)).toBe(false);
    await h.router.receiveServer(
      JSON.stringify({
        method: "turn/completed",
        params: { threadId: "shared-thread", turn: { id: "active-turn" } },
      }),
    );
    h.router.receiveClient(
      replacement.id,
      JSON.stringify({ id: 4, method: "turn/start", params: { threadId: "shared-thread" } }),
    );
    await h.router.receiveServer(
      JSON.stringify({ id: h.server.at(-1)?.id, result: { turn: { id: "next-turn" } } }),
    );
    await h.router.receiveServer(
      JSON.stringify({
        id: 92,
        method: "item/tool/call",
        params: { threadId: "shared-thread", turnId: "next-turn" },
      }),
    );
    expect(replacement.messages.at(-1)).toMatchObject({ id: 92, method: "item/tool/call" });
    expect(h.desktop.some((message) => message.id === 92)).toBe(false);
  });

  it("releases only the requesting client's idle ephemeral thread on the shared server", async () => {
    const h = harness();
    await ready(h);
    const owner = h.addClient();
    const other = h.addClient();
    h.router.receiveClient(
      owner.id,
      JSON.stringify({ id: 2, method: "thread/start", params: { ephemeral: true } }),
    );
    const start = h.server.at(-1);
    await h.router.receiveServer(
      JSON.stringify({ id: start?.id, result: { thread: { id: "ephemeral-thread" } } }),
    );

    const beforeOther = h.server.length;
    h.router.receiveClient(
      other.id,
      JSON.stringify({
        id: 3,
        method: "thread/unsubscribe",
        params: { threadId: "ephemeral-thread" },
      }),
    );
    expect(h.server).toHaveLength(beforeOther);

    h.router.receiveClient(
      owner.id,
      JSON.stringify({
        id: 4,
        method: "thread/unsubscribe",
        params: { threadId: "ephemeral-thread" },
      }),
    );
    const unsubscribe = h.server.at(-1);
    expect(unsubscribe).toMatchObject({
      method: "thread/unsubscribe",
      params: { threadId: "ephemeral-thread" },
    });
    await h.router.receiveServer(
      JSON.stringify({ id: unsubscribe?.id, result: { status: "unsubscribed" } }),
    );
    expect(owner.messages.at(-1)).toMatchObject({ id: 4, result: { status: "unsubscribed" } });
  });

  it("protects active ephemeral work and threads resumed by Desktop", async () => {
    const h = harness();
    await ready(h);
    const owner = h.addClient();
    h.router.receiveClient(
      owner.id,
      JSON.stringify({ id: 2, method: "thread/start", params: { ephemeral: true } }),
    );
    await h.router.receiveServer(
      JSON.stringify({ id: h.server.at(-1)?.id, result: { thread: { id: "ephemeral-thread" } } }),
    );
    h.router.receiveClient(
      owner.id,
      JSON.stringify({
        id: 3,
        method: "mcpServer/tool/call",
        params: { threadId: "ephemeral-thread" },
      }),
    );
    const pending = h.server.at(-1);
    h.router.receiveClient(
      owner.id,
      JSON.stringify({
        id: 4,
        method: "thread/unsubscribe",
        params: { threadId: "ephemeral-thread" },
      }),
    );
    expect(owner.messages.at(-1)).toMatchObject({ id: 4, error: { code: -32000 } });
    await h.router.receiveServer(JSON.stringify({ id: pending?.id, result: {} }));
    h.router.receiveDesktop(
      JSON.stringify({ id: 5, method: "thread/resume", params: { threadId: "ephemeral-thread" } }),
    );
    const before = h.server.length;
    h.router.receiveClient(
      owner.id,
      JSON.stringify({
        id: 6,
        method: "thread/unsubscribe",
        params: { threadId: "ephemeral-thread" },
      }),
    );
    expect(h.server).toHaveLength(before);
    expect(owner.messages.at(-1)).toMatchObject({ id: 6, error: { code: -32000 } });
    await h.router.receiveServer(
      JSON.stringify({ id: 5, result: { thread: { id: "ephemeral-thread" } } }),
    );
    h.router.receiveClient(
      owner.id,
      JSON.stringify({
        id: 7,
        method: "thread/unsubscribe",
        params: { threadId: "ephemeral-thread" },
      }),
    );
    expect(h.server).toHaveLength(before);
    expect(owner.messages.at(-1)).toMatchObject({ id: 7, result: {} });
  });

  it("keeps an ephemeral subscription releasable when Desktop resume fails", async () => {
    const h = harness();
    await ready(h);
    const owner = h.addClient();
    h.router.receiveClient(
      owner.id,
      JSON.stringify({ id: 2, method: "thread/start", params: { ephemeral: true } }),
    );
    await h.router.receiveServer(
      JSON.stringify({ id: h.server.at(-1)?.id, result: { thread: { id: "ephemeral-thread" } } }),
    );
    h.router.receiveDesktop(
      JSON.stringify({ id: 5, method: "thread/resume", params: { threadId: "ephemeral-thread" } }),
    );
    await h.router.receiveServer(
      JSON.stringify({ id: 5, error: { code: -1, message: "resume failed" } }),
    );
    h.router.receiveClient(
      owner.id,
      JSON.stringify({
        id: 6,
        method: "thread/unsubscribe",
        params: { threadId: "ephemeral-thread" },
      }),
    );
    expect(h.server.at(-1)).toMatchObject({
      method: "thread/unsubscribe",
      params: { threadId: "ephemeral-thread" },
    });
  });

  it("accepts native tool clients with the same owner key and routes their calls independently", async () => {
    const h = harness();
    await ready(h);
    const native = h.addClient("codex-native");
    const work = h.addClient();
    h.router.receiveClient(native.id, JSON.stringify({ id: 2, method: "thread/list", params: {} }));
    h.router.receiveClient(work.id, JSON.stringify({ id: 2, method: "thread/list", params: {} }));
    const [nativeCall, workCall] = h.server.slice(-2);
    expect(nativeCall?.id).not.toBe(workCall?.id);
    await h.router.receiveServer(JSON.stringify({ id: nativeCall?.id, result: { data: [] } }));
    expect(native.messages.at(-1)).toMatchObject({ id: 2, result: { data: [] } });
    expect(work.messages).toHaveLength(1);
    await h.router.receiveServer(JSON.stringify({ id: workCall?.id, result: { data: [] } }));
    expect(work.messages.at(-1)).toMatchObject({ id: 2, result: { data: [] } });
  });
});
