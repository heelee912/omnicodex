import { describe, expect, it } from "vitest";
import { CodexHostToolAdapter } from "../src/application/codex-host-tool-adapter.js";

describe("CodexHostToolAdapter", () => {
  it("maps read-only thread tools to App Server RPC without model invocation", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const adapter = new CodexHostToolAdapter(
      {
        request: async <T>(method: string, params: unknown): Promise<T> => {
          calls.push({ method, params });
          if (method === "thread/list") {
            return { data: [{ id: "thread-1", cwd: "C:\\repo" }] } as T;
          }
          if (method === "thread/read") {
            return { thread: { id: "thread-1" } } as T;
          }
          if (method === "thread/turns/list") {
            return { data: [] } as T;
          }
          throw new Error(`unexpected method ${method}`);
        },
      },
      { cwd: "C:\\repo" },
    );

    await adapter.call("codex_app__list_threads", { limit: 5, query: "Omni" });
    const read = await adapter.call("codex_app__read_thread", {
      threadId: "thread-1",
      turnLimit: 3,
      includeOutputs: true,
    });

    expect(calls).toEqual([
      {
        method: "thread/list",
        params: { limit: 5, searchTerm: "Omni", sortKey: "updated_at", sortDirection: "desc" },
      },
      { method: "thread/read", params: { threadId: "thread-1", includeTurns: false } },
      {
        method: "thread/turns/list",
        params: {
          threadId: "thread-1",
          limit: 3,
          itemsView: "full",
          sortDirection: "desc",
        },
      },
    ]);
    expect(read).toEqual({
      hostId: "local",
      metadata: { thread: { id: "thread-1" } },
      turns: { data: [] },
    });
  });

  it("requires explicit model acknowledgement before creating or continuing a thread", async () => {
    const adapter = new CodexHostToolAdapter({
      request: async <T>(): Promise<T> => {
        throw new Error("must not be called");
      },
    });

    await expect(
      adapter.call("codex_app__create_thread", {
        prompt: "hello",
        target: { type: "projectless" },
      }),
    ).rejects.toThrow("invokesModel=true");
    await expect(
      adapter.call("codex_app__send_message_to_thread", {
        threadId: "thread-1",
        prompt: "hello",
      }),
    ).rejects.toThrow("invokesModel=true");
  });

  it("exposes and routes the installed Computer Use surface without model invocation", async () => {
    const calls: Array<{ method: string; args: unknown }> = [];
    const computerUse = {
      call: async (method: string, args: unknown) => {
        calls.push({ method, args });
        return [{ id: "app-1" }];
      },
    };
    const adapter = new CodexHostToolAdapter(
      {
        request: async <T>(): Promise<T> => {
          throw new Error("must not use App Server RPC");
        },
      },
      { computerUse: computerUse as never },
    );

    const descriptors = adapter.tools.filter((tool) => tool.name.startsWith("codex.computer_use."));
    expect(descriptors).toHaveLength(13);
    expect(descriptors.every((tool) => tool.invokesModel === false)).toBe(true);
    await expect(adapter.call("codex.computer_use.list_apps", {})).resolves.toEqual([
      { id: "app-1" },
    ]);
    expect(calls).toEqual([{ method: "list_apps", args: {} }]);
  });
});
