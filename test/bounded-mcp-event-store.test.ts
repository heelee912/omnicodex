import { describe, expect, it } from "vitest";
import { BoundedMcpEventStore } from "../src/infrastructure/mcp/bounded-mcp-event-store.js";

describe("BoundedMcpEventStore", () => {
  it("uses monotonic IDs and replays only the same stream after the exact event", async () => {
    let now = 1_000;
    const store = new BoundedMcpEventStore({ now: () => now, nonce: "session", maxEvents: 4 });
    const first = await store.storeEvent("stream-a", notification("first"));
    now += 1;
    await store.storeEvent("stream-b", notification("other"));
    now += 1;
    const third = await store.storeEvent("stream-a", notification("third"));
    const replayed: unknown[] = [];

    await expect(
      store.replayEventsAfter(first, {
        send: async (id, message) => {
          replayed.push({ id, message });
        },
      }),
    ).resolves.toBe("stream-a");
    expect(replayed).toEqual([{ id: third, message: notification("third") }]);
    expect(first).toBe("session.1");
    expect(third).toBe("session.3");
  });

  it("retains the complete ordered history by default without a count or TTL cutoff", async () => {
    let now = 0;
    const store = new BoundedMcpEventStore({ now: () => now, nonce: "lossless" });
    const first = await store.storeEvent("stream", notification("0"));
    for (let index = 1; index <= 1_024; index += 1) {
      await store.storeEvent("stream", notification(String(index)));
    }
    now = 10 * 60_000 + 1;
    const replayed: string[] = [];

    await expect(
      store.replayEventsAfter(first, {
        send: async (_id, message) => {
          replayed.push(
            String(
              (message as unknown as { readonly params: { readonly progressToken: unknown } })
                .params.progressToken,
            ),
          );
        },
      }),
    ).resolves.toBe("stream");
    expect(replayed).toHaveLength(1_024);
    expect(replayed[0]).toBe("1");
    expect(replayed.at(-1)).toBe("1024");
  });

  it("fails closed when the requested range was evicted or expired", async () => {
    let now = 0;
    const store = new BoundedMcpEventStore({
      now: () => now,
      nonce: "bounded",
      maxEvents: 2,
      ttlMs: 10,
    });
    const evicted = await store.storeEvent("stream", notification("one"));
    await store.storeEvent("stream", notification("two"));
    await store.storeEvent("stream", notification("three"));
    await expect(store.replayEventsAfter(evicted, { send: async () => undefined })).rejects.toThrow(
      "EVENT_HISTORY_EXPIRED",
    );

    const expiring = await store.storeEvent("stream", notification("four"));
    now = 11;
    await expect(store.getStreamIdForEventId(expiring)).resolves.toBeUndefined();
    await expect(
      store.replayEventsAfter(expiring, { send: async () => undefined }),
    ).rejects.toThrow("EVENT_HISTORY_EXPIRED");
  });
});

function notification(value: string) {
  return {
    jsonrpc: "2.0" as const,
    method: "notifications/progress" as const,
    params: { progressToken: value, progress: 1 },
  };
}
