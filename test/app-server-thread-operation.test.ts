import { describe, expect, it } from "vitest";
import {
  normalizedPersistentTitle,
  startAppServerThread,
} from "../src/application/app-server-thread-operation.js";

describe("App Server thread operations", () => {
  it("starts and names a persistent thread without forwarding the host-only title field", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "thread/start") return { thread: { id: "thread-new" } } as T;
        if (method === "thread/name/set") return { ok: true } as T;
        throw new Error(`unexpected method ${method}`);
      },
    };

    await expect(
      startAppServerThread(client, {
        title: "Bridge staging",
        ephemeral: false,
        dynamicTools: [{ type: "namespace", name: "codex_app", tools: [] }],
      }),
    ).resolves.toMatchObject({
      threadId: "thread-new",
      ephemeral: false,
      title: "[OmniCodex] Bridge staging",
    });

    expect(calls).toEqual([
      {
        method: "thread/start",
        params: {
          ephemeral: false,
          dynamicTools: [{ type: "namespace", name: "codex_app", tools: [] }],
        },
      },
      {
        method: "thread/name/set",
        params: { threadId: "thread-new", name: "[OmniCodex] Bridge staging" },
      },
    ]);
  });

  it("does not name an ephemeral thread and requires its null path", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        return { thread: { id: "ephemeral-new", path: null } } as T;
      },
    };

    await expect(
      startAppServerThread(client, { title: "ignored", ephemeral: true }),
    ).resolves.toMatchObject({ threadId: "ephemeral-new", ephemeral: true });
    expect(calls).toEqual([{ method: "thread/start", params: { ephemeral: true } }]);
  });

  it("rejects a caller-supplied runtime path", async () => {
    const client = { request: async <T>(): Promise<T> => ({}) as T };
    await expect(
      startAppServerThread(client, { path: "C:\\forbidden", ephemeral: false }),
    ).rejects.toThrow("Persistent thread path is runtime-owned");
  });

  it("normalizes one bounded OmniCodex title", () => {
    expect(normalizedPersistentTitle("  [OmniCodex]   Bridge    staging  ")).toBe(
      "[OmniCodex] Bridge staging",
    );
  });
});
