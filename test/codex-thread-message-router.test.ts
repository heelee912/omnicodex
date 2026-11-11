import { describe, expect, it, vi } from "vitest";
import type { CodexThreadMessageClient } from "../src/application/codex-thread-message-client.js";
import {
  CodexThreadPreDispatchError,
  CodexThreadUnknownDispatchError,
  normalizeCodexThreadSettingsOverride,
} from "../src/application/codex-thread-message-client.js";
import { CodexThreadMessageRouter } from "../src/application/codex-thread-message-router.js";

describe("CodexThreadMessageRouter", () => {
  it("inherits configured model and effort when optional overrides are blank", () => {
    expect(normalizeCodexThreadSettingsOverride({ model: "  ", effort: "\t" })).toBeUndefined();
    expect(
      normalizeCodexThreadSettingsOverride({ model: " gpt-5.6-sol ", effort: " xhigh " }),
    ).toEqual({ model: "gpt-5.6-sol", effort: "xhigh" });
    expect(normalizeCodexThreadSettingsOverride({ effort: null })).toEqual({ effort: null });
  });

  it("uses the current desktop owner without starting a detached runtime", async () => {
    const calls: string[] = [];
    const desktop = client(async () => {
      calls.push("desktop");
      return result("desktop_ipc", "started");
    });
    const detached = client(async () => {
      calls.push("detached");
      return result("detached_app_server", "started");
    });

    const routed = await new CodexThreadMessageRouter(desktop, detached).sendFollowUpMessage(
      "thread-1",
      "continue",
    );

    expect(routed.transport).toBe("desktop_ipc");
    expect(calls).toEqual(["desktop"]);
  });

  it("falls back to the detached native App Server when no desktop owns the thread", async () => {
    const calls: string[] = [];
    const desktop = client(async () => {
      calls.push("desktop");
      throw noOwner("thread-2");
    });
    const detached = client(async () => {
      calls.push("detached");
      return result("detached_app_server", "started");
    });

    const routed = await new CodexThreadMessageRouter(desktop, detached).sendFollowUpMessage(
      "thread-2",
      "continue",
    );

    expect(routed.transport).toBe("detached_app_server");
    expect(calls).toEqual(["desktop", "detached"]);
  });

  it("closes a pre-submission ownership race with one final desktop lookup", async () => {
    let desktopCalls = 0;
    const desktop = client(async () => {
      desktopCalls += 1;
      if (desktopCalls === 1) throw noOwner("thread-race");
      return result("desktop_ipc", "started");
    });
    const detached = client(async () => {
      throw new CodexThreadPreDispatchError("writer moved to the desktop");
    });

    await expect(
      new CodexThreadMessageRouter(desktop, detached).sendFollowUpMessage(
        "thread-race",
        "continue",
      ),
    ).resolves.toMatchObject({ transport: "desktop_ipc" });
    expect(desktopCalls).toBe(2);
  });

  it("never replays an unknown-outcome detached turn failure", async () => {
    let desktopCalls = 0;
    const desktop = client(async () => {
      desktopCalls += 1;
      throw noOwner("thread-uncertain");
    });
    let detachedCalls = 0;
    const detached = client(async () => {
      detachedCalls += 1;
      throw new CodexThreadUnknownDispatchError(
        "turn/start response timed out",
        "unknown-operation",
      );
    });
    const router = new CodexThreadMessageRouter(desktop, detached);
    const options = { clientUserMessageId: "unknown-operation" };

    await expect(
      router.sendFollowUpMessage("thread-uncertain", "continue", options),
    ).rejects.toThrow("turn/start response timed out");
    await expect(
      router.sendFollowUpMessage("thread-uncertain", "continue", options),
    ).rejects.toThrow("turn/start response timed out");
    expect(desktopCalls).toBe(1);
    expect(detachedCalls).toBe(1);
  });

  it("retains a completed operation for the process lifetime unless the caller selects expiry", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    let calls = 0;
    const desktop = client(async () => {
      calls += 1;
      return result("desktop_ipc", "started");
    });
    const router = new CodexThreadMessageRouter(
      desktop,
      client(async () => result("detached_app_server", "started")),
    );
    const operation = { clientUserMessageId: "operation-retained" };
    try {
      const first = await router.sendFollowUpMessage("thread-retained", "continue", operation);
      now += 365 * 24 * 60 * 60_000;
      const replay = await router.sendFollowUpMessage("thread-retained", "continue", operation);
      expect(replay).toBe(first);
      expect(calls).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("coalesces only the same operation id into one native dispatch", async () => {
    let calls = 0;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const desktop = client(async () => {
      calls += 1;
      await waiting;
      return result("desktop_ipc", "started");
    });
    const detached = client(async () => result("detached_app_server", "started"));
    const router = new CodexThreadMessageRouter(desktop, detached);

    const operation = { clientUserMessageId: "operation-1" };
    const first = router.sendFollowUpMessage("thread-replay", "one prompt", operation);
    const duplicate = router.sendFollowUpMessage("thread-replay", "one prompt", operation);
    release();

    await expect(Promise.all([first, duplicate])).resolves.toHaveLength(2);
    expect(calls).toBe(1);
  });

  it("rejects one operation id reused for a different thread, prompt, or dispatch arguments", async () => {
    let calls = 0;
    const desktop = client(async () => {
      calls += 1;
      return result("desktop_ipc", "started");
    });
    const detached = client(async () => result("detached_app_server", "started"));
    const router = new CodexThreadMessageRouter(desktop, detached);
    const operation = {
      clientUserMessageId: "operation-conflict",
      cwd: "C:\\first",
      threadSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
    };

    await router.sendFollowUpMessage("thread-one", "first prompt", operation);
    await expect(
      router.sendFollowUpMessage("thread-two", "first prompt", operation),
    ).rejects.toThrow("reused with different input");
    await expect(
      router.sendFollowUpMessage("thread-one", "second prompt", operation),
    ).rejects.toThrow("reused with different input");
    await expect(
      router.sendFollowUpMessage("thread-one", "first prompt", {
        ...operation,
        cwd: "C:\\second",
      }),
    ).rejects.toThrow("reused with different input");
    expect(calls).toBe(1);
  });
});

function client(send: CodexThreadMessageClient["sendFollowUpMessage"]): CodexThreadMessageClient {
  return { sendFollowUpMessage: send };
}

function noOwner(threadId: string): Error {
  return new Error(`No running Codex desktop window owns thread ${threadId}`);
}

function result(
  transport: "desktop_ipc" | "detached_app_server",
  disposition: "started" | "queued",
) {
  return {
    threadId: "thread-result",
    ownerClientId: "owner",
    disposition,
    nativeResult: { turn: { id: "turn-1" } },
    transport,
  } as const;
}
