import { describe, expect, it } from "vitest";
import { startModelTurnAndWait } from "../src/application/app-server-model-turn.js";

describe("App Server model turn evidence", () => {
  it("waits for the exact terminal turn and positive per-turn token usage", async () => {
    const listeners = new Set<(message: Record<string, unknown>) => void>();
    const client = {
      subscribeNotifications: (listener: (message: Record<string, unknown>) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      request: async <T>(method: string, _params: unknown, timeoutMs?: number): Promise<T> => {
        expect(method).toBe("turn/start");
        expect(timeoutMs).toBeUndefined();
        emit(listeners, {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "other-turn",
            tokenUsage: { last: { totalTokens: 999 } },
          },
        });
        emit(listeners, {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: { last: { totalTokens: 42 } },
          },
        });
        queueMicrotask(() => {
          emit(listeners, {
            method: "turn/completed",
            params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
          });
        });
        return { turn: { id: "turn-1" } } as T;
      },
    };

    await expect(
      startModelTurnAndWait(client, {
        threadId: "thread-1",
        input: [{ type: "text", text: "bounded test" }],
      }),
    ).resolves.toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      modelUsage: 42,
      completed: { id: "turn-1", status: "completed" },
    });
    expect(listeners.size).toBe(0);
  });

  it("fails closed when the exact model turn does not complete successfully", async () => {
    const listeners = new Set<(message: Record<string, unknown>) => void>();
    const client = {
      subscribeNotifications: (listener: (message: Record<string, unknown>) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      request: async <T>(): Promise<T> => {
        queueMicrotask(() => {
          emit(listeners, {
            method: "turn/completed",
            params: { threadId: "thread-1", turn: { id: "turn-1", status: "failed" } },
          });
        });
        return { turn: { id: "turn-1" } } as T;
      },
    };

    await expect(
      startModelTurnAndWait(client, { threadId: "thread-1", input: [] }),
    ).rejects.toThrow("status failed");
    expect(listeners.size).toBe(0);
  });

  it("accepts caller deadlines beyond the former two-hour ceiling", async () => {
    const listeners = new Set<(message: Record<string, unknown>) => void>();
    const timeoutMs = 3_000_000_000;
    const client = {
      subscribeNotifications: (listener: (message: Record<string, unknown>) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      request: async <T>(_method: string, _params: unknown, received?: number): Promise<T> => {
        expect(received).toBe(timeoutMs);
        queueMicrotask(() => {
          emit(listeners, {
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "thread-1",
              turnId: "turn-long",
              tokenUsage: { last: { totalTokens: 7 } },
            },
          });
          emit(listeners, {
            method: "turn/completed",
            params: { threadId: "thread-1", turn: { id: "turn-long", status: "completed" } },
          });
        });
        return { turn: { id: "turn-long" } } as T;
      },
    };

    await expect(
      startModelTurnAndWait(client, { threadId: "thread-1", input: [] }, timeoutMs),
    ).resolves.toMatchObject({ turnId: "turn-long", modelUsage: 7 });
    expect(listeners.size).toBe(0);
  });
});

function emit(
  listeners: ReadonlySet<(message: Record<string, unknown>) => void>,
  message: Record<string, unknown>,
): void {
  for (const listener of listeners) listener(message);
}
