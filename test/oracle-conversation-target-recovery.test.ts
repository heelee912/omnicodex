import { describe, expect, it, vi } from "vitest";
import { ensureExactOracleConversationTarget } from "../src/infrastructure/chatgpt/oracle-conversation-target-recovery.js";

const ENDPOINT = "http://127.0.0.1:19222";
const CONVERSATION_URL = "https://chatgpt.com/c/WEB:a6b0d2f0-7590-4197-a40c-29a6de66da22";

describe("Oracle conversation target recovery", () => {
  it("allows a live target inventory to complete after fifteen seconds", async () => {
    vi.useFakeTimers();
    const nativeTimeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("Timed out", "TimeoutError")),
        milliseconds,
      );
      return controller.signal;
    });
    try {
      const abort = new AbortController();
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        await new Promise<void>((resolve, reject) => {
          setTimeout(resolve, 20_000);
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
        return jsonResponse([target("existing", CONVERSATION_URL)]);
      });
      const pending = ensureExactOracleConversationTarget({
        endpoint: ENDPOINT,
        conversationUrl: CONVERSATION_URL,
        signal: abort.signal,
        fetch,
      });
      const result = expect(pending).resolves.toMatchObject({ resolution: "existing" });
      await vi.advanceTimersByTimeAsync(20_000);
      await result;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[1]?.signal).toBe(abort.signal);
    } finally {
      nativeTimeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("preserves caller cancellation during creation without starting a recovery read", async () => {
    const abort = new AbortController();
    const reason = new Error("caller stopped mirror recovery");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockImplementationOnce(async (_url, init) => {
        expect(init?.signal).toBe(abort.signal);
        abort.abort(reason);
        throw reason;
      });
    await expect(
      ensureExactOracleConversationTarget({
        endpoint: ENDPOINT,
        conversationUrl: CONVERSATION_URL,
        signal: abort.signal,
        fetch,
      }),
    ).rejects.toBe(reason);
    expect(fetch.mock.calls.map((call) => call[1]?.method)).toEqual(["GET", "PUT"]);
  });

  it("reuses the exact conversation target without creating another page", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse([target("existing", CONVERSATION_URL)]));

    await expect(
      ensureExactOracleConversationTarget({
        endpoint: ENDPOINT,
        conversationUrl: `${CONVERSATION_URL}?ignored=1#ignored`,
        fetch,
      }),
    ).resolves.toEqual({ target: target("existing", CONVERSATION_URL), resolution: "existing" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  it("recovers an ambiguously created page by URL and never replays the mutation", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(
        jsonResponse([target("created-despite-socket-error", CONVERSATION_URL)]),
      );

    await expect(
      ensureExactOracleConversationTarget({
        endpoint: ENDPOINT,
        conversationUrl: CONVERSATION_URL,
        fetch,
      }),
    ).resolves.toEqual({
      target: target("created-despite-socket-error", CONVERSATION_URL),
      resolution: "ambiguous_create_recovered",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.map((call) => call[1]?.method)).toEqual(["GET", "PUT", "GET"]);
  });

  it("reports an unresolved create failure after one mutation attempt", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(jsonResponse([]));

    await expect(
      ensureExactOracleConversationTarget({
        endpoint: ENDPOINT,
        conversationUrl: CONVERSATION_URL,
        fetch,
      }),
    ).rejects.toThrow("socket hang up");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.filter((call) => call[1]?.method === "PUT")).toHaveLength(1);
  });

  it("marks and reclaims only the caller-owned mirror for an exact conversation", async () => {
    const markedUrl = `${CONVERSATION_URL}?omnicodex_oracle_mirror=mirror-owner`;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse([target("foreign", CONVERSATION_URL), target("owned", markedUrl)]),
      );

    await expect(
      ensureExactOracleConversationTarget({
        endpoint: ENDPOINT,
        conversationUrl: CONVERSATION_URL,
        ownershipMarker: "mirror-owner",
        fetch,
      }),
    ).resolves.toEqual({
      target: target("owned", markedUrl),
      resolution: "existing",
      callerOwned: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("creates a durable owned mirror instead of borrowing a foreign exact conversation", async () => {
    const markedUrl = `${CONVERSATION_URL}?omnicodex_oracle_mirror=mirror-owner`;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse([target("foreign", CONVERSATION_URL)]))
      .mockResolvedValueOnce(jsonResponse(target("owned", markedUrl)));

    await expect(
      ensureExactOracleConversationTarget({
        endpoint: ENDPOINT,
        conversationUrl: CONVERSATION_URL,
        ownershipMarker: "mirror-owner",
        fetch,
      }),
    ).resolves.toEqual({
      target: target("owned", markedUrl),
      resolution: "created",
      callerOwned: true,
    });
    expect(fetch.mock.calls.map((call) => call[1]?.method)).toEqual(["GET", "PUT"]);
  });
});

function target(id: string, url: string) {
  return {
    id,
    type: "page",
    url,
    webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${id}`,
  } as const;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
