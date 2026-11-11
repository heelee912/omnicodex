import { describe, expect, it } from "vitest";
import {
  APP_SERVER_THREAD_INVENTORY_SOURCE_KINDS,
  probeAppServerThreadInventory,
  readAppServerThreadInventory,
} from "../src/application/app-server-thread-inventory.js";

describe("App Server thread inventory", () => {
  it("probes readiness without hydrating recent rollout lineage", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        return { data: [] } as T;
      },
    };

    await probeAppServerThreadInventory(client);

    expect(calls).toEqual([
      {
        method: "thread/list",
        params: {
          limit: 1,
          archived: false,
          useStateDbOnly: true,
          sortKey: "updated_at",
          sortDirection: "desc",
          modelProviders: [],
          sourceKinds: APP_SERVER_THREAD_INVENTORY_SOURCE_KINDS,
        },
      },
    ]);
  });

  it("walks every active and archived page without discarding native task fields", async () => {
    const calls: Array<{
      method: string;
      params: Record<string, unknown>;
      timeoutMs: number | undefined;
    }> = [];
    const pages = new Map([
      [
        "active:first",
        {
          data: [
            {
              id: "active-1",
              name: "Current task",
              cwd: "C:\\work\\current",
              source: "appServer",
              updatedAt: 101,
              status: { type: "idle" },
              provider: "openai",
            },
          ],
          nextCursor: "active-next",
        },
      ],
      [
        "active:active-next",
        {
          data: [
            {
              id: "active-2",
              title: "Second task",
              updated_at: 102,
              customNativeField: { retained: true },
            },
          ],
        },
      ],
      [
        "archived:first",
        {
          data: [
            {
              id: "archived-1",
              name: "Historical task",
              cwd: "C:\\work\\historical",
              source: "cli",
              updatedAt: 90,
            },
          ],
        },
      ],
    ]);
    const client = {
      request: async <T>(method: string, paramsValue: unknown, timeoutMs?: number): Promise<T> => {
        const params = paramsValue as Record<string, unknown>;
        calls.push({ method, params, timeoutMs });
        const partition = params.archived === true ? "archived" : "active";
        const cursor = typeof params.cursor === "string" ? params.cursor : "first";
        const response = pages.get(`${partition}:${cursor}`);
        if (response === undefined) throw new Error("unexpected inventory page");
        return response as T;
      },
    };

    const inventory = await readAppServerThreadInventory(client);

    expect(inventory).toEqual({
      active: [
        {
          id: "active-1",
          name: "Current task",
          cwd: "C:\\work\\current",
          source: "appServer",
          updatedAt: 101,
          status: { type: "idle" },
          provider: "openai",
          archived: false,
        },
        {
          id: "active-2",
          title: "Second task",
          updated_at: 102,
          customNativeField: { retained: true },
          archived: false,
        },
      ],
      archived: [
        {
          id: "archived-1",
          name: "Historical task",
          cwd: "C:\\work\\historical",
          source: "cli",
          updatedAt: 90,
          archived: true,
        },
      ],
    });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.method).toBe("thread/list");
      expect(call.params).toMatchObject({
        limit: 100,
        modelProviders: [],
        useStateDbOnly: true,
        sourceKinds: APP_SERVER_THREAD_INVENTORY_SOURCE_KINDS,
        sortKey: "updated_at",
        sortDirection: "desc",
      });
      expect(call.timeoutMs).toBeUndefined();
    }
  });

  it("fails closed when App Server repeats a partition cursor", async () => {
    const client = {
      request: async <T>(_method: string, paramsValue: unknown): Promise<T> => {
        const params = paramsValue as Record<string, unknown>;
        if (params.archived === true) return { data: [] } as T;
        return { data: [], nextCursor: "same-cursor" } as T;
      },
    };

    await expect(readAppServerThreadInventory(client)).rejects.toThrow(
      "repeated active thread inventory cursor",
    );
  });

  it("honors an explicit caller page limit", async () => {
    const client = {
      request: async <T>(_method: string, paramsValue: unknown): Promise<T> => {
        const params = paramsValue as Record<string, unknown>;
        if (params.archived === true) return { data: [] } as T;
        const cursor = typeof params.cursor === "string" ? Number(params.cursor) : 0;
        return { data: [], nextCursor: String(cursor + 1) } as T;
      },
    };

    await expect(readAppServerThreadInventory(client, { maxPages: 2 })).rejects.toThrow(
      "active thread inventory exceeded the caller page limit",
    );
  });

  it("does not impose a default total-page or deadline cap", async () => {
    const timeouts: Array<number | undefined> = [];
    const client = {
      request: async <T>(_method: string, paramsValue: unknown, timeoutMs?: number): Promise<T> => {
        timeouts.push(timeoutMs);
        const params = paramsValue as Record<string, unknown>;
        if (params.archived === true) return { data: [] } as T;
        const page = typeof params.cursor === "string" ? Number(params.cursor) : 0;
        return {
          data: [{ id: `thread-${page}` }],
          ...(page < 100 ? { nextCursor: String(page + 1) } : {}),
        } as T;
      },
    };

    const inventory = await readAppServerThreadInventory(client);

    expect(inventory.active).toHaveLength(101);
    expect(timeouts).toHaveLength(102);
    expect(timeouts.every((timeout) => timeout === undefined)).toBe(true);
  });
});
