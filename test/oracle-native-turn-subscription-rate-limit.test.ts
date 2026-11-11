import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { oracleNativeTurnSubscriptionExpression } from "../src/infrastructure/chatgpt/oracle-native-turn-subscription.js";

const expression = oracleNativeTurnSubscriptionExpression();
const asset = "https://chatgpt.com/cdn/assets/current-hash.js";

function renderer(retryAfter: string | null) {
  let now = Date.UTC(2026, 8, 9);
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: { get: (name: string) => (name === "retry-after" ? retryAfter : null) },
    })
    .mockResolvedValue({ ok: true, text: async () => "export{}" });
  const context = {
    Date: { now: () => now, parse: Date.parse },
    document: { querySelectorAll: () => [{ href: asset }] },
    fetch,
  };
  return {
    fetch,
    context,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    run: () => runInNewContext(expression, context) as Promise<unknown>,
  };
}

describe("native PubSub asset request admission", () => {
  it("preserves Retry-After and the original error across reconnects, then reuses successful discovery", async () => {
    const subject = renderer("120");
    const first = await subject.run().catch((error: unknown) => error);
    expect(first).toMatchObject({
      message: "ORACLE_PUBSUB_ASSET_HTTP_429",
      status: 429,
      assetUrl: asset,
      retryAfter: "120",
      retryAtUnixMs: Date.UTC(2026, 8, 9) + 120_000,
      backoffSource: "retry_after",
    });
    for (let retry = 0; retry < 7; retry += 1) {
      subject.advance(15_000);
      expect(await subject.run().catch((error: unknown) => error)).toBe(first);
    }
    expect(subject.fetch).toHaveBeenCalledTimes(1);
    subject.advance(15_000);
    await expect(subject.run()).rejects.toThrow("ORACLE_NATIVE_PUBSUB_CLIENT_MISSING");
    await expect(subject.run()).rejects.toThrow("ORACLE_NATIVE_PUBSUB_CLIENT_MISSING");
    expect(subject.fetch).toHaveBeenCalledTimes(2);
  });

  it("uses an HTTP-date without extending its deadline on a retry", async () => {
    const subject = renderer("Wed, 09 Sep 2026 00:03:00 GMT");
    await expect(subject.run()).rejects.toMatchObject({
      retryAtUnixMs: Date.UTC(2026, 8, 9, 0, 3),
      backoffSource: "retry_after",
    });
    subject.advance(179_999);
    await expect(subject.run()).rejects.toThrow("ORACLE_PUBSUB_ASSET_HTTP_429");
    expect(subject.fetch).toHaveBeenCalledTimes(1);
    subject.advance(1);
    await expect(subject.run()).rejects.toThrow("ORACLE_NATIVE_PUBSUB_CLIENT_MISSING");
    expect(subject.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([null, "not-a-date"])(
    "uses a short non-escalating interval when Retry-After is %s",
    async (header) => {
      const subject = renderer(header);
      await expect(subject.run()).rejects.toMatchObject({
        retryAfter: header,
        retryAtUnixMs: Date.UTC(2026, 8, 9) + 30_000,
        backoffSource: "local_backoff",
      });
      subject.advance(15_000);
      await expect(subject.run()).rejects.toThrow("ORACLE_PUBSUB_ASSET_HTTP_429");
      expect(subject.fetch).toHaveBeenCalledTimes(1);
      subject.advance(15_000);
      await expect(subject.run()).rejects.toThrow("ORACLE_NATIVE_PUBSUB_CLIENT_MISSING");
      expect(subject.fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("coalesces concurrent discovery and keeps account renderers independent", async () => {
    const first = renderer("60");
    const results = await Promise.allSettled([first.run(), first.run(), first.run()]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(first.fetch).toHaveBeenCalledTimes(1);
    const second = renderer("0");
    await expect(second.run()).rejects.toThrow("ORACLE_PUBSUB_ASSET_HTTP_429");
    await expect(second.run()).rejects.toThrow("ORACLE_NATIVE_PUBSUB_CLIENT_MISSING");
    expect(second.fetch).toHaveBeenCalledTimes(2);
    await expect(first.run()).rejects.toThrow("ORACLE_PUBSUB_ASSET_HTTP_429");
    expect(first.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not escalate a repeated headerless 429 into a long lockout", async () => {
    const subject = renderer(null);
    subject.fetch.mockResolvedValue({ ok: false, status: 429 });
    await expect(subject.run()).rejects.toThrow("ORACLE_PUBSUB_ASSET_HTTP_429");
    subject.advance(30_000);
    await expect(subject.run()).rejects.toMatchObject({
      status: 429,
      retryAtUnixMs: Date.UTC(2026, 8, 9) + 60_000,
      backoffSource: "local_backoff",
    });
    subject.advance(15_000);
    await expect(subject.run()).rejects.toThrow("ORACLE_PUBSUB_ASSET_HTTP_429");
    expect(subject.fetch).toHaveBeenCalledTimes(2);
  });
});
