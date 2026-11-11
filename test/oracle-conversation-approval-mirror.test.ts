import { describe, expect, it, vi } from "vitest";
import {
  conversationUrlsFromChromeInventory,
  OracleConversationApprovalMirror,
  singleConversationUrlFromChromeInventory,
} from "../src/application/oracle-conversation-approval-mirror.js";

const ENDPOINT = "http://127.0.0.1:19222";
const FIRST = "https://chatgpt.com/c/WEB:a6b0d2f0-7590-4197-a40c-29a6de66da22";
const SECOND = "https://chatgpt.com/c/6a96d948-c6f8-83e8-83c5-e265bcba2930";

describe("Oracle conversation approval mirror", () => {
  it("recovers every exact Loop conversation from native and node_repl result shapes", () => {
    const urls = conversationUrlsFromChromeInventory({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            tabs: [
              { url: `${FIRST}?model=pro` },
              { url: "https://example.com/" },
              { url: `${SECOND}#bottom` },
            ],
          }),
        },
      ],
    });

    expect([...urls].sort()).toEqual([FIRST, SECOND].sort());
  });

  it("targets one exact request conversation and deduplicates only that conversation", async () => {
    const readChromeUserTabs = vi.fn(async () => ({ tabs: [{ url: SECOND }] }));
    const recoverTarget = vi.fn(async (_endpoint, url: string) => ({
      target: target("first", `${url}?omnicodex_oracle_mirror=owned`),
      resolution: "created" as const,
      callerOwned: true as const,
    }));
    const mirror = new OracleConversationApprovalMirror({
      cdpEndpoint: ENDPOINT,
      readChromeUserTabs,
      recoverTarget,
    });

    const [left, right] = await Promise.all([
      mirror.prepareForProtectedResult(FIRST),
      mirror.prepareForProtectedResult(`${FIRST}?model=pro`),
    ]);
    expect(left).toEqual(right);
    expect(readChromeUserTabs).not.toHaveBeenCalled();
    expect(recoverTarget).toHaveBeenCalledOnce();
    expect(
      mirror.activeRunForTarget(target("first", `${FIRST}?omnicodex_oracle_mirror=owned`))
        ?.conversationUrl,
    ).toBe(FIRST);
  });

  it("keeps concurrent exact conversations in independent flights", async () => {
    const readChromeUserTabs = vi.fn(async () => ({ tabs: [] }));
    const recoverTarget = vi.fn(async (_endpoint, url: string) => ({
      target: target(url === FIRST ? "first" : "second", url),
      resolution: "created" as const,
      callerOwned: true as const,
    }));
    const mirror = new OracleConversationApprovalMirror({
      cdpEndpoint: ENDPOINT,
      readChromeUserTabs,
      recoverTarget,
    });

    await Promise.all([
      mirror.prepareForProtectedResult(FIRST),
      mirror.prepareForProtectedResult(SECOND),
    ]);

    expect(readChromeUserTabs).not.toHaveBeenCalled();
    expect(recoverTarget).toHaveBeenCalledTimes(2);
    expect(mirror.activeRunForTarget(target("first", FIRST))?.conversationUrl).toBe(FIRST);
    expect(mirror.activeRunForTarget(target("second", SECOND))?.conversationUrl).toBe(SECOND);
  });

  it("re-adopts an exact owned mirror from target inventory after a daemon restart", () => {
    const mirror = new OracleConversationApprovalMirror({
      cdpEndpoint: ENDPOINT,
      readChromeUserTabs: async () => ({ tabs: [] }),
    });
    const restored = target(
      "restored",
      `${FIRST}?omnicodex_oracle_mirror=omnicodex-approval-mirror-v1`,
    );

    expect(mirror.activeRunForTarget(restored)?.conversationUrl).toBe(FIRST);
    expect(mirror.activeRunForTarget(target("foreign", FIRST))).toBeUndefined();
  });

  it("mirrors only the uniquely foreground Loop conversation when request attribution is unavailable", async () => {
    const recoverTarget = vi.fn(async (_endpoint, url: string) => ({
      target: target(url === FIRST ? "first" : "second", url),
      resolution: "created" as const,
      callerOwned: true as const,
    }));
    const mirror = new OracleConversationApprovalMirror({
      cdpEndpoint: ENDPOINT,
      readChromeUserTabs: async () => ({
        tabs: [
          { url: FIRST, active: false },
          { url: SECOND, active: true },
        ],
      }),
      recoverTarget,
    });

    const prepared = await mirror.prepareForProtectedResult();

    expect(prepared.conversationUrls).toEqual([SECOND]);
    expect(prepared.targets.map((candidate) => candidate.targetId)).toEqual(["second"]);
    expect(recoverTarget).toHaveBeenCalledOnce();
    expect(mirror.activeRunForTarget(target("first", FIRST))).toBeUndefined();
    expect(mirror.activeRunForTarget(target("second", SECOND))?.conversationUrl).toBe(SECOND);
  });

  it("rejects an ambiguous unattributed inventory instead of multiplying Oracle targets", async () => {
    const recoverTarget = vi.fn();
    const mirror = new OracleConversationApprovalMirror({
      cdpEndpoint: ENDPOINT,
      readChromeUserTabs: async () => ({ tabs: [{ url: FIRST }, { url: SECOND }] }),
      recoverTarget,
    });

    await expect(mirror.prepareForProtectedResult()).rejects.toThrow(
      "ORACLE_APPROVAL_MIRROR_AMBIGUOUS_LOOP_CONVERSATION",
    );
    expect(recoverTarget).not.toHaveBeenCalled();
  });

  it("reclaims owned mirrors that are no longer open in Loop", async () => {
    const closeTarget = vi.fn(async () => undefined);
    let inventory = { tabs: [{ url: FIRST, active: true }] };
    const mirror = new OracleConversationApprovalMirror({
      cdpEndpoint: ENDPOINT,
      readChromeUserTabs: async () => inventory,
      recoverTarget: async (_endpoint, url: string) => ({
        target: target(url === FIRST ? "first" : "second", url),
        resolution: "created" as const,
        callerOwned: true as const,
      }),
      closeTarget,
    });
    await mirror.prepareForProtectedResult();
    inventory = { tabs: [{ url: SECOND, active: true }] };

    const prepared = await mirror.prepareForProtectedResult();

    expect(closeTarget).toHaveBeenCalledWith(ENDPOINT, "first");
    expect(prepared.reclaimedTargetCount).toBe(1);
    expect(mirror.activeRunForTarget(target("first", FIRST))).toBeUndefined();
    expect(mirror.activeRunForTarget(target("second", SECOND))?.conversationUrl).toBe(SECOND);
  });

  it("selects a uniquely attached tab before a merely foreground tab", () => {
    expect(
      singleConversationUrlFromChromeInventory({
        tabs: [
          { url: FIRST, active: true, attachedToThisSession: false },
          { url: SECOND, attachedToThisSession: true },
        ],
      }),
    ).toBe(SECOND);
  });

  it("selects the conversation with the uniquely greatest lastActiveAt", () => {
    expect(
      singleConversationUrlFromChromeInventory({
        tabs: [
          { url: FIRST, lastActiveAt: 1_700_000_000_100 },
          { url: SECOND, lastActiveAt: 1_700_000_000_300 },
        ],
      }),
    ).toBe(SECOND);
  });

  it("reclaims only a superseded owned mirror for the same exact conversation", async () => {
    const closeTarget = vi.fn(async () => undefined);
    let recovery = 0;
    const mirror = new OracleConversationApprovalMirror({
      cdpEndpoint: ENDPOINT,
      readChromeUserTabs: async () => ({ tabs: [] }),
      recoverTarget: async (_endpoint, url: string) => ({
        target: target(recovery++ === 0 ? "owned-old" : "owned-current", url),
        resolution: "created" as const,
        callerOwned: true as const,
      }),
      closeTarget,
    });
    await mirror.prepareForProtectedResult(FIRST);
    const refreshed = await mirror.prepareForProtectedResult(FIRST);

    expect(closeTarget).toHaveBeenCalledOnce();
    expect(closeTarget).toHaveBeenCalledWith(ENDPOINT, "owned-old");
    expect(refreshed.reclaimedTargetCount).toBe(1);
    expect(refreshed.reclaimFailureCount).toBe(0);
    expect(mirror.activeRunForTarget(target("owned-current", FIRST))?.conversationUrl).toBe(FIRST);
  });

  it("replaces only the exact unresponsive automation-owned mirror", async () => {
    const closeTarget = vi.fn(async () => undefined);
    const recoverTarget = vi.fn(async (_endpoint, url: string) => ({
      target: target("replacement", `${url}?omnicodex_oracle_mirror=omnicodex-approval-mirror-v1`),
      resolution: "created" as const,
      callerOwned: true as const,
    }));
    const mirror = new OracleConversationApprovalMirror({
      cdpEndpoint: ENDPOINT,
      readChromeUserTabs: async () => ({ tabs: [] }),
      recoverTarget,
      closeTarget,
    });
    const stale = target(
      "stale-owned",
      `${FIRST}?omnicodex_oracle_mirror=omnicodex-approval-mirror-v1`,
    );

    const [left, right] = await Promise.all([
      mirror.recoverUnresponsiveOwnedTarget(stale),
      mirror.recoverUnresponsiveOwnedTarget(stale),
    ]);

    expect(left).toEqual(right);
    expect(closeTarget).toHaveBeenCalledOnce();
    expect(closeTarget).toHaveBeenCalledWith(ENDPOINT, stale.id);
    expect(recoverTarget).toHaveBeenCalledOnce();
    expect(
      mirror.activeRunForTarget(
        target("replacement", `${FIRST}?omnicodex_oracle_mirror=omnicodex-approval-mirror-v1`),
      )?.conversationUrl,
    ).toBe(FIRST);
    await expect(mirror.recoverUnresponsiveOwnedTarget(target("foreign", FIRST))).rejects.toThrow(
      "ORACLE_APPROVAL_MIRROR_RECOVERY_TARGET_NOT_OWNED",
    );
  });

  it("serializes prepare behind same-conversation recovery without blocking another conversation", async () => {
    const closing = deferred();
    const closeStarted = deferred();
    const recoverTarget = vi.fn(async (_endpoint: string, url: string) => ({
      target: target(url === FIRST ? "replacement" : "independent", url),
      resolution: "existing" as const,
      callerOwned: true as const,
    }));
    const mirror = new OracleConversationApprovalMirror({
      cdpEndpoint: ENDPOINT,
      recoverTarget,
      closeTarget: async () => {
        closeStarted.resolve();
        await closing.promise;
      },
    });
    const stale = target("stale", `${FIRST}?omnicodex_oracle_mirror=omnicodex-approval-mirror-v1`);
    const recovery = mirror.recoverUnresponsiveOwnedTarget(stale);
    await closeStarted.promise;
    const preparation = mirror.prepareForProtectedResult(FIRST);
    await mirror.prepareForProtectedResult(SECOND);
    expect(recoverTarget.mock.calls.map(([, url]) => url)).toEqual([SECOND]);
    closing.resolve();
    const [recovered, prepared] = await Promise.all([recovery, preparation]);
    expect(recovered.targets).toEqual(prepared.targets);
    expect(recoverTarget.mock.calls.map(([, url]) => url)).toEqual([SECOND, FIRST, FIRST]);
  });

  it("preserves a release failure and lets the next preparation proceed", async () => {
    const closeStarted = deferred();
    const closing = deferred();
    const recoverTarget = vi.fn(async (_endpoint: string, url: string) => ({
      target: target("retained", url),
      resolution: "existing" as const,
      callerOwned: true as const,
    }));
    const mirror = new OracleConversationApprovalMirror({
      cdpEndpoint: ENDPOINT,
      recoverTarget,
      closeTarget: async () => {
        closeStarted.resolve();
        await closing.promise;
      },
    });
    const owned = target(
      "retained",
      `${FIRST}?omnicodex_oracle_mirror=omnicodex-approval-mirror-v1`,
    );
    const release = mirror.releaseStableIdleOwnedTarget(owned);
    const failed = expect(release).rejects.toThrow("close failed");
    await closeStarted.promise;
    const preparation = mirror.prepareForProtectedResult(FIRST);
    await Promise.resolve();
    expect(recoverTarget).not.toHaveBeenCalled();
    closing.reject(new Error("close failed"));
    await failed;
    expect((await preparation).targets[0]?.targetId).toBe("retained");
  });

  it("does not begin queued recovery or release after their caller is cancelled", async () => {
    const started = deferred();
    const prepared = deferred();
    const recoverTarget = vi.fn(async (_endpoint: string, url: string) => {
      started.resolve();
      await prepared.promise;
      return { target: target("retained", url), resolution: "existing" as const };
    });
    const closeTarget = vi.fn(async () => undefined);
    const mirror = new OracleConversationApprovalMirror({
      cdpEndpoint: ENDPOINT,
      recoverTarget,
      closeTarget,
    });
    const first = mirror.prepareForProtectedResult(FIRST);
    await started.promise;
    const abort = new AbortController();
    const reason = new Error("caller stopped");
    const owned = target(
      "retained",
      `${FIRST}?omnicodex_oracle_mirror=omnicodex-approval-mirror-v1`,
    );
    const recovery = expect(
      mirror.recoverUnresponsiveOwnedTarget(owned, abort.signal),
    ).rejects.toBe(reason);
    const release = expect(mirror.releaseStableIdleOwnedTarget(owned, abort.signal)).rejects.toBe(
      reason,
    );
    abort.abort(reason);
    prepared.resolve();
    await Promise.all([first, recovery, release]);
    expect(closeTarget).not.toHaveBeenCalled();
    expect(recoverTarget).toHaveBeenCalledOnce();
    await mirror.prepareForProtectedResult(SECOND);
    expect(recoverTarget).toHaveBeenCalledTimes(2);
  });

  it("cancels close readback and never opens a replacement after cancellation", async () => {
    const abort = new AbortController();
    const reason = new Error("shutdown during close readback");
    const reading = deferred();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      expect(init?.signal).toBe(abort.signal);
      if (init?.method === "PUT") return new Response("{}");
      reading.resolve();
      return new Promise<Response>((_resolve, reject) => {
        abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true });
      });
    });
    const recoverTarget = vi.fn();
    const mirror = new OracleConversationApprovalMirror({
      cdpEndpoint: ENDPOINT,
      fetch,
      recoverTarget,
    });
    const owned = target(
      "retained",
      `${FIRST}?omnicodex_oracle_mirror=omnicodex-approval-mirror-v1`,
    );
    const recovery = expect(
      mirror.recoverUnresponsiveOwnedTarget(owned, abort.signal),
    ).rejects.toBe(reason);
    await reading.promise;
    abort.abort(reason);
    await recovery;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(recoverTarget).not.toHaveBeenCalled();
  });

  it("releases only the exact stable-idle automation-owned mirror", async () => {
    const closeTarget = vi.fn(async () => undefined);
    const mirror = new OracleConversationApprovalMirror({
      cdpEndpoint: ENDPOINT,
      closeTarget,
    });
    const owned = target(
      "idle-owned",
      `${FIRST}?omnicodex_oracle_mirror=omnicodex-approval-mirror-v1`,
    );
    expect(mirror.activeRunForTarget(owned)?.conversationUrl).toBe(FIRST);

    const [left, right] = await Promise.all([
      mirror.releaseStableIdleOwnedTarget(owned),
      mirror.releaseStableIdleOwnedTarget(owned),
    ]);

    expect(left).toBeUndefined();
    expect(right).toBeUndefined();
    expect(closeTarget).toHaveBeenCalledOnce();
    expect(closeTarget).toHaveBeenCalledWith(ENDPOINT, owned.id);
    expect(mirror.activeRunForTarget(target(owned.id, FIRST))).toBeUndefined();
    await expect(mirror.releaseStableIdleOwnedTarget(target("foreign", FIRST))).rejects.toThrow(
      "ORACLE_APPROVAL_MIRROR_RELEASE_TARGET_NOT_OWNED",
    );
  });

  it("waits for an asynchronously closing target to disappear before replacement", async () => {
    const stale = target(
      "stale-owned",
      `${FIRST}?omnicodex_oracle_mirror=omnicodex-approval-mirror-v1`,
    );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([stale]), { status: 200 }))
      .mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const recoverTarget = vi.fn(async (_endpoint, url: string) => ({
      target: target("replacement", `${url}?omnicodex_oracle_mirror=omnicodex-approval-mirror-v1`),
      resolution: "created" as const,
      callerOwned: true as const,
    }));
    const mirror = new OracleConversationApprovalMirror({
      cdpEndpoint: ENDPOINT,
      readChromeUserTabs: async () => ({ tabs: [] }),
      fetch,
      recoverTarget,
    });

    await mirror.recoverUnresponsiveOwnedTarget(stale);

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(
      fetch.mock.calls.map(
        ([request]) => new URL(request instanceof Request ? request.url : request).pathname,
      ),
    ).toEqual([`/json/close/${stale.id}`, "/json/list", "/json/list"]);
    expect(recoverTarget).toHaveBeenCalledOnce();
  });
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function target(id: string, url: string) {
  return {
    id,
    type: "page",
    url,
    webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${id}`,
  } as const;
}
