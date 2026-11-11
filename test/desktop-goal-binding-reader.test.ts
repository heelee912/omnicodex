import { describe, expect, it, vi } from "vitest";
import type { CdpTarget } from "../src/infrastructure/chatgpt/chatgpt-cdp-transport.js";
import {
  isDesktopGoalBindingReadExpression,
  readDesktopGoalBindings,
} from "../src/infrastructure/windows/desktop-goal-binding-reader.js";

const conversationId = "6aa0402d-d934-83ee-bc94-42b9da04cde3";
const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
const accountSourceId = "chatgpt:account:user";
const scope = { accountSourceId, connectorIds: ["connector-a", "connector-b"] };
const target: CdpTarget = {
  id: "desktop",
  type: "page",
  url: "app://-/index.html",
  webSocketDebuggerUrl: "ws://127.0.0.1:9231/devtools/page/desktop",
};
function rawConversation() {
  const goal = (id: string, connector: string, parent: string | null) => ({
    parent,
    message: {
      id,
      author: { role: "tool", name: "api_tool.call_tool" },
      status: "finished_successfully",
      metadata: {
        invoked_resource: { resource_uri: `/${connector}/link_a/omnicodex__goal_create` },
      },
      content: {
        text: JSON.stringify({
          id: "52d9eb18-77e4-4f57-a73a-d6b7ec210a27",
          state: "active",
          revision: 1,
          createdAtUnixMs: 1,
          steps: [],
        }),
      },
    },
  });
  return {
    conversation_id: conversationId,
    current_node: "final",
    mapping: {
      a: goal("a", "connector-a", null),
      b: goal("b", "connector-b", "a"),
      final: {
        parent: "b",
        message: {
          id: "final",
          author: { role: "assistant" },
          channel: "final",
          end_turn: true,
          status: "finished_successfully",
        },
      },
    },
  };
}
function connection(raw: unknown = rawConversation()) {
  const command = vi.fn(async (_method: string, args: unknown) => {
    expect(isDesktopGoalBindingReadExpression((args as { expression: string }).expression)).toBe(
      true,
    );
    return { result: { value: { ok: true, value: raw } } };
  });
  const close = vi.fn();
  return {
    listTargets: vi.fn(async () => [target]),
    connect: vi.fn(async () => ({ command, close })),
    command,
    close,
  };
}
const input = () => ({
  endpoint: "http://127.0.0.1:9231",
  conversationUrl,
  ...scope,
  readScope: vi.fn(async () => scope),
});

describe("Desktop Goal binding reader", () => {
  it("reads once for multiple connectors and preserves current-branch edges", async () => {
    const native = connection();
    const args = input();
    const observed = await readDesktopGoalBindings(args, new AbortController().signal, native);
    expect(observed.goals.map((goal) => goal.messageId)).toEqual(["a", "b"]);
    expect(observed.source).toEqual({ kind: "desktop", accountSourceId });
    expect(observed.current).toMatchObject({ id: "final", ancestorMessageIds: ["b", "a"] });
    expect(native.command).toHaveBeenCalledTimes(1);
    expect(args.readScope).toHaveBeenCalledTimes(2);
    expect(native.close).toHaveBeenCalledTimes(1);
  });

  it("does not query a conversation under a different account", async () => {
    const native = connection();
    const args = input();
    args.readScope.mockResolvedValue({ ...scope, accountSourceId: "chatgpt:other:user" });
    await expect(
      readDesktopGoalBindings(args, new AbortController().signal, native),
    ).rejects.toThrow("DESKTOP_CHAT_ACCOUNT_CHANGED");
    expect(native.command).not.toHaveBeenCalled();
  });

  it("discards binding output if the native account changes during the read", async () => {
    const native = connection();
    const args = input();
    args.readScope
      .mockResolvedValueOnce(scope)
      .mockResolvedValueOnce({ ...scope, accountSourceId: "chatgpt:other:user" });
    await expect(
      readDesktopGoalBindings(args, new AbortController().signal, native),
    ).rejects.toThrow("DESKTOP_CHAT_ACCOUNT_CHANGED");
    expect(native.close).toHaveBeenCalledTimes(1);
  });

  it("does not select a ChatGPT web guest or navigate the selected Desktop Chat", async () => {
    const native = connection();
    native.listTargets.mockResolvedValue([{ ...target, id: "web", url: conversationUrl }]);
    await expect(
      readDesktopGoalBindings(input(), new AbortController().signal, native),
    ).rejects.toThrow("DESKTOP_CHAT_RENDERER_NOT_FOUND");
    expect(native.connect).not.toHaveBeenCalled();
  });

  it("propagates native failure without a fallback request", async () => {
    const native = connection();
    native.command.mockRejectedValue(new Error("native error"));
    await expect(
      readDesktopGoalBindings(input(), new AbortController().signal, native),
    ).rejects.toThrow("native error");
    expect(native.command).toHaveBeenCalledTimes(1);
    expect(native.close).toHaveBeenCalledTimes(1);
  });

  it("rejects an exact-read response from another conversation", async () => {
    const native = connection({ ...rawConversation(), conversation_id: "different" });
    await expect(
      readDesktopGoalBindings(input(), new AbortController().signal, native),
    ).rejects.toThrow("DESKTOP_CHAT_CONVERSATION_CHANGED");
  });

  it("binds an exact terminal deleted error only after the second scope check", async () => {
    const native = connection();
    const args = input();
    const error = Object.assign(new Error("deleted"), {
      code: "conversation_deleted",
      can_retry: false,
      conversation_id: conversationId,
    });
    native.command.mockRejectedValue(error);
    await expect(
      readDesktopGoalBindings(args, new AbortController().signal, native),
    ).rejects.toMatchObject({
      code: "conversation_deleted",
      can_retry: false,
      accountSourceId,
      conversationUrl,
    });
    expect(args.readScope).toHaveBeenCalledTimes(2);
    expect(native.close).toHaveBeenCalledTimes(1);
  });

  it("does not bind a deleted error after the account changes", async () => {
    const native = connection();
    const args = input();
    const error = Object.assign(new Error("deleted"), {
      code: "conversation_deleted",
      can_retry: false,
      conversation_id: conversationId,
    });
    native.command.mockRejectedValue(error);
    args.readScope
      .mockResolvedValueOnce(scope)
      .mockResolvedValueOnce({ ...scope, accountSourceId: "chatgpt:other:user" });
    await expect(
      readDesktopGoalBindings(args, new AbortController().signal, native),
    ).rejects.toThrow("DESKTOP_CHAT_ACCOUNT_CHANGED");
    expect(error).not.toHaveProperty("accountSourceId");
  });

  it("preserves a JSON detail diagnostic and verifies its exact deleted target", async () => {
    const native = connection();
    const original = JSON.stringify({
      detail: { code: "conversation_deleted", can_retry: false, conversation_id: conversationId },
    });
    const error = new Error(original);
    native.command.mockRejectedValue(error);
    await expect(
      readDesktopGoalBindings(input(), new AbortController().signal, native),
    ).rejects.toMatchObject({
      message: original,
      code: "conversation_deleted",
      can_retry: false,
      accountSourceId,
      conversationUrl,
    });
    const wrong = Object.assign(new Error("deleted"), {
      code: "conversation_deleted",
      can_retry: false,
      conversation_id: "other",
    });
    native.command.mockRejectedValue(wrong);
    await expect(
      readDesktopGoalBindings(input(), new AbortController().signal, native),
    ).rejects.toBe(wrong);
    expect(wrong).not.toHaveProperty("accountSourceId");
  });

  it("recognizes only canonical read/cancel expressions, not appended code", async () => {
    const native = connection();
    await readDesktopGoalBindings(input(), new AbortController().signal, native);
    const expression =
      (native.command.mock.calls[0]?.[1] as { expression?: string } | undefined)?.expression ?? "";
    expect(isDesktopGoalBindingReadExpression(`${expression}; alert(1)`)).toBe(false);
    expect(expression).toContain("client.safeGet(");
    expect(
      isDesktopGoalBindingReadExpression(expression.replace("client.safeGet(", "client.safePost(")),
    ).toBe(false);
    const token = '"00000000-0000-0000-0000-000000000000"';
    const cancel = `(() => { const r = globalThis.__omnicodexDesktopExactReadOperations ??= new Map(); const c = r.get(${token}); if (c) c.abort(); else r.set(${token}, { signal: { aborted: true } }); })()`;
    expect(isDesktopGoalBindingReadExpression(cancel)).toBe(true);
    expect(isDesktopGoalBindingReadExpression(`${cancel}; 0`)).toBe(false);
  });
});
