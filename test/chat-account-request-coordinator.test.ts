import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  ChatAccountRateLimitError,
  ChatAccountRequestCoordinator,
  chatAccountRateLimitRetryAt,
} from "../src/application/chat-account-request-coordinator.js";

afterEach(() => vi.useRealTimers());

it.each(["responseStatus", "statusCode"])(
  "shares a native %s 429 without depending on its display message",
  async (statusField) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const coordinator = new ChatAccountRequestCoordinator();
    const error = Object.assign(new Error("native request rejected"), {
      [statusField]: 429,
      headers: { "Retry-After": "120" },
    });
    await expect(
      coordinator.run("A", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(await coordinator.readCooldown("A")).toEqual({
      observedAtUnixMs: 1_000_000,
      retryAtUnixMs: 1_120_000,
      serverRetryAtUnixMs: 1_120_000,
    });
    const next = vi.fn(async () => "unexpected");
    await expect(coordinator.run("A", next, undefined, "report")).rejects.toMatchObject({
      retryAtUnixMs: 1_120_000,
    });
    expect(next).not.toHaveBeenCalled();
  },
);

it("reads the exact nested Oracle retry timestamp without adding another backoff", () => {
  expect(
    chatAccountRateLimitRetryAt(
      {
        outcome: "rate_limited",
        error: "Too many requests",
        rateLimit: { status: 429, retryAtUnixMs: 105000 },
      },
      100000,
    ),
  ).toBe(105000);
});

it.each(["seconds", "date", "deadline"])(
  "honors repeated short server Retry-After via %s without adding local backoff",
  async (format) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });
    for (let rejection = 0; rejection < 8; rejection++) {
      const retryAt = Date.now() + 5_000;
      const error = Object.assign(new Error('Error: {"detail":"Too many requests"}'), {
        status: 429,
        ...(format === "deadline"
          ? { retryAtUnixMs: retryAt }
          : {
              headers: { "retry-after": format === "date" ? new Date(retryAt).toUTCString() : "5" },
            }),
      });
      await expect(
        coordinator.run("A", async () => {
          throw error;
        }),
      ).rejects.toBe(error);
      expect(await coordinator.readCooldown("A")).toEqual({
        observedAtUnixMs: Date.now(),
        retryAtUnixMs: retryAt,
        serverRetryAtUnixMs: retryAt,
      });
      const perform = vi.fn(async () => "done");
      await expect(coordinator.run("A", perform, undefined, "report")).rejects.toMatchObject({
        retryAtUnixMs: retryAt,
        nativeError: error,
        cause: error,
      });
      expect(perform).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
    }
    await expect(coordinator.run("A", async () => "recovered")).resolves.toBe("recovered");
  },
);

it("backs off repeated raw JSON errors exponentially when the server gives no deadline", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const coordinator = new ChatAccountRequestCoordinator();
  const error = new Error('Error: {"detail":"Too many requests"}');
  const backoffs = [30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000];
  for (const backoff of backoffs) {
    await expect(
      coordinator.run("A", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(await coordinator.readCooldown("A")).toEqual({
      observedAtUnixMs: Date.now(),
      retryAtUnixMs: Date.now() + backoff,
    });
    await vi.advanceTimersByTimeAsync(backoff);
  }
  await expect(coordinator.run("A", async () => "recovered")).resolves.toBe("recovered");
  await expect(
    coordinator.run("A", async () => ({ detail: "Too many requests" })),
  ).resolves.toEqual({ detail: "Too many requests" });
  expect(await coordinator.readCooldown("A")).toEqual({
    observedAtUnixMs: Date.now(),
    retryAtUnixMs: Date.now() + 30_000,
  });
});

it("keeps the fallback streak across partial recovery and resets it after five quiet minutes", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });
  const limited = { detail: "Too many requests" };

  await coordinator.run("A", async () => limited);
  await vi.advanceTimersByTimeAsync(30_000);
  await coordinator.run("A", async () => "partial recovery");
  await coordinator.run("A", async () => limited);
  expect(await coordinator.readCooldown("A")).toEqual({
    observedAtUnixMs: 1_030_000,
    retryAtUnixMs: 1_090_000,
  });

  await vi.advanceTimersByTimeAsync(60_000);
  await coordinator.run("A", async () => "stable again");
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  await coordinator.run("A", async () => "quiet-window success");
  await coordinator.run("A", async () => limited);
  expect(await coordinator.readCooldown("A")).toEqual({
    observedAtUnixMs: 1_390_000,
    retryAtUnixMs: 1_420_000,
  });
});

it("does not add a fallback when the server explicitly permits an immediate retry", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const coordinator = new ChatAccountRequestCoordinator();
  await coordinator.run("A", async () => ({ status: 429, headers: { "retry-after": "0" } }));
  expect(await coordinator.readCooldown("A")).toBeUndefined();
  await expect(coordinator.run("A", async () => "ok", undefined, "report")).resolves.toBe("ok");
});

it("preserves the exact cooldown after the native boundary serializes the error", () => {
  const now = Date.parse("2026-09-08T11:06:30Z");
  const retryAt = Date.parse("2026-09-08T11:08:26.883Z");
  const original = new ChatAccountRateLimitError(retryAt, undefined);
  expect(
    chatAccountRateLimitRetryAt(
      {
        name: "Error",
        message: original.message,
        status: 429,
        retryAtUnixMs: retryAt,
      },
      now,
    ),
  ).toBe(retryAt);
  expect(chatAccountRateLimitRetryAt(new Error(original.message), now)).toBe(retryAt);
  expect(
    chatAccountRateLimitRetryAt(new Error(`Native read failed: ${original.message}`), now),
  ).toBe(retryAt);
});

it("does not accept malformed cooldown timestamps or turn an unrelated timestamp into a 429", () => {
  const now = 1_000_000;
  expect(chatAccountRateLimitRetryAt({ retryAtUnixMs: now + 60_000 }, now)).toBeUndefined();
  expect(
    chatAccountRateLimitRetryAt(new Error("CHAT_ACCOUNT_RATE_LIMITED: retry at invalid"), now),
  ).toBeUndefined();
  expect(chatAccountRateLimitRetryAt({ status: 429, retryAtUnixMs: NaN }, now)).toBe(now);
});

it("reports a shared cooldown immediately instead of holding a public tool request open", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });
  const snapshot = { observedAtUnixMs: Date.now(), retryAtUnixMs: Date.now() + 1_200_000 };
  await coordinator.observeCooldown("A", snapshot);
  const perform = vi.fn(async () => "done");
  await expect(coordinator.run("A", perform, undefined, "report")).rejects.toMatchObject({
    status: 429,
    retryAtUnixMs: snapshot.retryAtUnixMs,
  });
  expect(perform).not.toHaveBeenCalled();
  expect(Date.now()).toBe(1_000_000);
  await expect(coordinator.run("B", perform, undefined, "report")).resolves.toBe("done");
  await vi.advanceTimersByTimeAsync(1_200_000);
  await expect(coordinator.run("A", perform, undefined, "report")).resolves.toBe("done");
});

it("escalates newer headerless Oracle snapshots without counting a replay twice", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });

  const first = { observedAtUnixMs: Date.now(), retryAtUnixMs: Date.now() + 30_000 };
  await coordinator.observeCooldown("A", first);
  await coordinator.observeCooldown("A", first);
  expect(await coordinator.readCooldown("A")).toEqual(first);

  await vi.advanceTimersByTimeAsync(30_000);
  const second = { observedAtUnixMs: Date.now(), retryAtUnixMs: Date.now() + 30_000 };
  await coordinator.observeCooldown("A", second);
  await coordinator.observeCooldown("A", second);
  expect(await coordinator.readCooldown("A")).toEqual({
    observedAtUnixMs: 1_030_000,
    retryAtUnixMs: 1_090_000,
  });
});

it("lets only one foreground or background recovery probe enter an account slot", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const coordinator = new ChatAccountRequestCoordinator({
    spacingMs: 0,
    recoveryProbeGuardMs: 120_000,
  });

  await coordinator.run("A", async () => ({ detail: "Too many requests" }));
  await vi.advanceTimersByTimeAsync(30_000);
  await expect(coordinator.reserveRecoveryRequest("A", 120_000)).resolves.toEqual({
    admitted: true,
    retryAtUnixMs: 1_150_000,
  });
  await expect(
    coordinator.run("A", async () => "must wait", undefined, "report"),
  ).rejects.toMatchObject({ retryAtUnixMs: 1_150_000 });

  await vi.advanceTimersByTimeAsync(120_000);
  let finish!: (value: string) => void;
  const foreground = coordinator.run(
    "A",
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  await vi.advanceTimersByTimeAsync(0);
  await expect(coordinator.reserveRecoveryRequest("A", 120_000)).resolves.toEqual({
    admitted: false,
    retryAtUnixMs: 1_270_000,
  });
  finish("recovered");
  await expect(foreground).resolves.toBe("recovered");
});

it("reports a 429 arriving during admission spacing without starting or replaying native I/O", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 100 });
  await coordinator.run("A", async () => "ok", undefined, "report");
  const perform = vi.fn(async () => "not started");
  const pending = coordinator.run("A", perform, undefined, "report");
  const rejected = expect(pending).rejects.toBeInstanceOf(ChatAccountRateLimitError);
  await vi.advanceTimersByTimeAsync(50);
  await coordinator.observeCooldown("A", {
    observedAtUnixMs: Date.now(),
    retryAtUnixMs: Date.now() + 1_200_000,
  });
  await vi.advanceTimersByTimeAsync(50);
  await rejected;
  expect(perform).not.toHaveBeenCalled();
});

it("joins external deadlines without replay escalation and extends an already waiting queue", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });
  const first = { observedAtUnixMs: Date.now(), retryAtUnixMs: Date.now() + 60_000 };
  await coordinator.observeCooldown("A", first);
  const perform = vi.fn(async () => "ok");
  const queued = coordinator.run("A", perform);
  await vi.advanceTimersByTimeAsync(10_000);
  const second = { observedAtUnixMs: Date.now(), retryAtUnixMs: Date.now() + 120_000 };
  await coordinator.observeCooldown("A", second);
  await coordinator.observeCooldown("A", second);
  await coordinator.observeCooldown("A", { ...first, retryAtUnixMs: Date.now() + 999_000 });
  expect(await coordinator.readCooldown("A")).toEqual(second);
  expect(await coordinator.readCooldown("B")).toBeUndefined();
  await expect(coordinator.run("B", async () => "B")).resolves.toBe("B");
  await vi.advanceTimersByTimeAsync(119_999);
  expect(perform).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(queued).resolves.toBe("ok");
  await coordinator.observeCooldown("A", second);
  expect(await coordinator.readCooldown("A")).toBeUndefined();
  await expect(coordinator.run("A", perform)).resolves.toBe("ok");
});

it("does not let an in-flight success clear a newer external rate limit", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });
  let finish!: () => void;
  const inflight = coordinator.run(
    "A",
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await vi.advanceTimersByTimeAsync(0);
  const snapshot = { observedAtUnixMs: Date.now(), retryAtUnixMs: Date.now() + 60_000 };
  await coordinator.observeCooldown("A", snapshot);
  finish();
  await inflight;
  expect(await coordinator.readCooldown("A")).toEqual(snapshot);
});

it("keeps the maximum active deadline when a newer observation has a shorter wait", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });
  await coordinator.observeCooldown("A", {
    observedAtUnixMs: Date.now(),
    retryAtUnixMs: Date.now() + 120_000,
  });
  await vi.advanceTimersByTimeAsync(1_000);
  await coordinator.observeCooldown("A", {
    observedAtUnixMs: Date.now(),
    retryAtUnixMs: Date.now() + 10_000,
  });
  expect(await coordinator.readCooldown("A")).toEqual({
    observedAtUnixMs: 1_001_000,
    retryAtUnixMs: 1_120_000,
  });
});

it.each([false, true])(
  "persists native429 observation and stale-snapshot watermark after restart (recover=%s)",
  async (recover) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const root = await mkdtemp(join(tmpdir(), "chat-cooldown-watermark-"));
    try {
      const statePath = join(root, "state.json");
      const original = new ChatAccountRequestCoordinator({ statePath, spacingMs: 0 });
      await original.run("A", async () => ({ status: 429 }));
      const snapshot = { observedAtUnixMs: 1_000_000, retryAtUnixMs: 1_030_000 };
      expect(await original.readCooldown("A")).toEqual(snapshot);
      const restored = new ChatAccountRequestCoordinator({ statePath, spacingMs: 0 });
      expect(await restored.readCooldown("A")).toEqual(snapshot);
      await vi.advanceTimersByTimeAsync(30_000);
      if (recover) await restored.run("A", async () => "ok");
      expect(await restored.readCooldown("A")).toBeUndefined();
      const again = new ChatAccountRequestCoordinator({ statePath, spacingMs: 0 });
      await again.observeCooldown("A", snapshot);
      // Even a delayed larger deadline from the same old observation must not
      // resurrect a cooldown that expired or whose recovery already succeeded.
      await again.observeCooldown("A", { ...snapshot, retryAtUnixMs: Date.now() + 60_000 });
      expect(await again.readCooldown("A")).toBeUndefined();
      expect(JSON.parse(await readFile(statePath, "utf8")).version).toBe(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("loads a version1 native deadline without inventing a new observation or extending its wait", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const root = await mkdtemp(join(tmpdir(), "chat-cooldown-v1-"));
  try {
    const statePath = join(root, "state.json");
    const key = createHash("sha256").update("A").digest("hex");
    await writeFile(
      statePath,
      JSON.stringify({ version: 1, accounts: { [key]: { retryAt: 1_060_000, failures: 2 } } }),
    );
    const coordinator = new ChatAccountRequestCoordinator({ statePath, spacingMs: 0 });
    expect(await coordinator.readCooldown("A")).toEqual({
      observedAtUnixMs: 0,
      retryAtUnixMs: 1_060_000,
    });
    const perform = vi.fn(async () => "ok");
    const run = coordinator.run("A", perform);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(run).resolves.toBe("ok");
    expect(perform).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(statePath, "utf8")).version).toBe(4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves an escalated version2 local fallback during migration", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const root = await mkdtemp(join(tmpdir(), "chat-cooldown-v2-local-"));
  try {
    const statePath = join(root, "state.json");
    const key = createHash("sha256").update("A").digest("hex");
    await writeFile(
      statePath,
      JSON.stringify({
        version: 2,
        accounts: {
          [key]: { retryAt: 2_800_000, failures: 5, observedAt: 1_000_000 },
        },
      }),
    );
    const coordinator = new ChatAccountRequestCoordinator({ statePath, spacingMs: 0 });
    expect(await coordinator.readCooldown("A")).toEqual({
      observedAtUnixMs: 1_000_000,
      retryAtUnixMs: 2_800_000,
    });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
      version: 4,
      accounts: {
        [key]: {
          retryAt: 2_800_000,
          serverRetryAt: 0,
          backgroundNextAt: 0,
          failures: 5,
          observedAt: 1_000_000,
        },
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("shares one persisted background recovery budget per account without blocking foreground calls", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const root = await mkdtemp(join(tmpdir(), "chat-background-budget-"));
  try {
    const statePath = join(root, "state.json");
    const first = new ChatAccountRequestCoordinator({ statePath, spacingMs: 0 });
    await expect(first.reserveBackgroundRequest("A", 120_000)).resolves.toEqual({
      admitted: true,
      retryAtUnixMs: 1_120_000,
    });
    await expect(first.reserveBackgroundRequest("A", 120_000)).resolves.toEqual({
      admitted: false,
      retryAtUnixMs: 1_120_000,
    });
    await expect(first.reserveBackgroundRequest("B", 120_000)).resolves.toEqual({
      admitted: true,
      retryAtUnixMs: 1_120_000,
    });
    await expect(first.run("A", async () => "foreground", undefined, "report")).resolves.toBe(
      "foreground",
    );

    const restored = new ChatAccountRequestCoordinator({ statePath, spacingMs: 0 });
    await expect(restored.reserveBackgroundRequest("A", 120_000)).resolves.toEqual({
      admitted: false,
      retryAtUnixMs: 1_120_000,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(restored.reserveBackgroundRequest("A", 120_000)).resolves.toEqual({
      admitted: true,
      retryAtUnixMs: 1_240_000,
    });
    expect(JSON.parse(await readFile(statePath, "utf8")).version).toBe(4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("gives a queued foreground request the next provider-safe account slot", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });

  await expect(coordinator.reserveBackgroundRequest("A", 120_000)).resolves.toEqual({
    admitted: true,
    retryAtUnixMs: 1_120_000,
  });
  const foreground = coordinator.reserveForegroundRequest("A", 120_000);
  await vi.advanceTimersByTimeAsync(0);

  await expect(coordinator.reserveBackgroundRequest("A", 120_000)).resolves.toEqual({
    admitted: false,
    retryAtUnixMs: 1_120_000,
  });
  await expect(coordinator.reserveRecoveryRequest("A", 120_000)).resolves.toEqual({
    admitted: false,
    retryAtUnixMs: 1_120_000,
  });
  await vi.advanceTimersByTimeAsync(120_000);
  await expect(foreground).resolves.toEqual({
    admitted: true,
    retryAtUnixMs: 1_240_000,
  });
  await expect(coordinator.reserveBackgroundRequest("A", 120_000)).resolves.toEqual({
    admitted: false,
    retryAtUnixMs: 1_240_000,
  });
});

it("releases foreground priority when its caller is cancelled", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });
  const controller = new AbortController();

  await coordinator.reserveBackgroundRequest("A", 120_000);
  const foreground = coordinator.reserveForegroundRequest("A", 120_000, controller.signal);
  await vi.advanceTimersByTimeAsync(0);
  controller.abort(new Error("caller left"));
  await expect(foreground).rejects.toThrow("caller left");

  await vi.advanceTimersByTimeAsync(120_000);
  await expect(coordinator.reserveBackgroundRequest("A", 120_000)).resolves.toEqual({
    admitted: true,
    retryAtUnixMs: 1_240_000,
  });
});

it("holds a healthy account slot until its native response settles", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const coordinator = new ChatAccountRequestCoordinator();
  let finishFirst!: (value: string) => void;
  const firstPerform = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finishFirst = resolve;
      }),
  );
  const secondPerform = vi.fn(async () => "second result");
  const first = coordinator.run("A", firstPerform);
  const second = coordinator.run("A", secondPerform);
  await vi.advanceTimersByTimeAsync(0);
  expect(firstPerform).toHaveBeenCalledOnce();
  expect(secondPerform).not.toHaveBeenCalled();
  expect(Date.now()).toBe(1_000_000);
  expect(vi.getTimerCount()).toBe(0);
  finishFirst("first result");
  await expect(first).resolves.toBe("first result");
  await expect(second).resolves.toBe("second result");
  expect(secondPerform).toHaveBeenCalledOnce();
});

it("executes queued independent reads exactly once while keeping another account moving", async () => {
  const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });
  const finishes: Array<(value: string) => void> = [];
  const blocked = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finishes.push(resolve);
      }),
  );
  const first = coordinator.run("A", blocked);
  const duplicate = coordinator.run("A", blocked);
  await expect(coordinator.run("B", async () => "B done")).resolves.toBe("B done");
  expect(blocked).toHaveBeenCalledTimes(1);
  finishes[0]?.("first A result");
  await expect(first).resolves.toBe("first A result");
  await vi.waitFor(() => expect(blocked).toHaveBeenCalledTimes(2));
  finishes[1]?.("second A result");
  await expect(duplicate).resolves.toBe("second A result");
});

it("shares Retry-After across reads and sends without replaying a rejected request", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });
  const error = Object.assign(new Error("Too many requests"), {
    status: 429,
    headers: { "retry-after": "120" },
  });
  const send = vi.fn(async () => "sent");
  await expect(
    coordinator.run("A", async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  const queued = Array.from({ length: 4 }, () => coordinator.run("A", send));
  await vi.advanceTimersByTimeAsync(119_999);
  expect(send).not.toHaveBeenCalled();
  await expect(coordinator.run("B", async () => "ok")).resolves.toBe("ok");
  await vi.advanceTimersByTimeAsync(1);
  await expect(Promise.all(queued)).resolves.toEqual(["sent", "sent", "sent", "sent"]);
  await expect(coordinator.run("A", send)).resolves.toBe("sent");
  expect(send).toHaveBeenCalledTimes(5);
});

it("preserves native error responses and delays another call until their cooldown", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });
  const native = {
    success: false,
    contentItems: [{ type: "inputText", text: '{"detail":"Too many requests"}' }],
  };
  await expect(coordinator.run("A", async () => native)).resolves.toBe(native);
  const perform = vi.fn(async () => "ok");
  const next = coordinator.run("A", perform);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(perform).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(next).resolves.toBe("ok");
  expect(perform).toHaveBeenCalledTimes(1);
});

it("recognizes the native detail error without altering it and restores cooldown after restart", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const root = await mkdtemp(join(tmpdir(), "chat-cooldown-"));
  try {
    const statePath = join(root, "state.json");
    const first = new ChatAccountRequestCoordinator({ statePath, spacingMs: 0 });
    const native = { detail: "Too many requests" };
    await expect(first.run("A", async () => native)).resolves.toBe(native);
    const restored = new ChatAccountRequestCoordinator({ statePath, spacingMs: 0 });
    const request = vi.fn(async () => "recovered");
    const recovered = restored.run("A", request);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(request).not.toHaveBeenCalled();
    await expect(restored.run("B", async () => "ok")).resolves.toBe("ok");
    await vi.advanceTimersByTimeAsync(1);
    await expect(recovered).resolves.toBe("recovered");
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("runs only one recovery probe before releasing other conversations", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });
  await coordinator.run("A", async () => ({
    detail: "Too many requests",
  }));
  let recover!: (value: string) => void;
  const firstPerform = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        recover = resolve;
      }),
  );
  const secondPerform = vi.fn(async () => "second");
  const first = coordinator.run("A", firstPerform);
  const second = coordinator.run("A", secondPerform);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(firstPerform).toHaveBeenCalledTimes(1);
  expect(secondPerform).not.toHaveBeenCalled();
  recover("first");
  await expect(first).resolves.toBe("first");
  await expect(second).resolves.toBe("second");
});

it("turns an already queued start into the single recovery probe when an earlier call is limited", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 1_000 });
  let rejectFirst!: (error: Error) => void;
  const first = coordinator.run(
    "A",
    () =>
      new Promise<string>((_resolve, reject) => {
        rejectFirst = reject;
      }),
  );
  const secondPerform = vi.fn(async () => "second");
  const thirdPerform = vi.fn(async () => "third");
  const second = coordinator.run("A", secondPerform);
  const third = coordinator.run("A", thirdPerform);
  await vi.advanceTimersByTimeAsync(500);
  const limited = Object.assign(new Error("Too many requests"), { status: 429 });
  rejectFirst(limited);
  await expect(first).rejects.toBe(limited);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(secondPerform).not.toHaveBeenCalled();
  expect(thirdPerform).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(second).resolves.toBe("second");
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(third).resolves.toBe("third");
  expect(secondPerform).toHaveBeenCalledTimes(1);
  expect(thirdPerform).toHaveBeenCalledTimes(1);
});

it("cancels a queued cooldown wait without dispatching the request", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });
  await coordinator.run("A", async () => ({
    detail: "Too many requests",
  }));
  const abort = new AbortController();
  const perform = vi.fn(async () => "unexpected");
  const queued = coordinator.run("A", perform, abort.signal);
  abort.abort(new Error("caller stopped"));
  await expect(queued).rejects.toThrow("caller stopped");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(perform).not.toHaveBeenCalled();
  const next = vi.fn(async () => "next completed");
  const resumed = coordinator.run("A", next);
  await vi.advanceTimersByTimeAsync(0);
  expect(next).toHaveBeenCalledTimes(1);
  await expect(resumed).resolves.toBe("next completed");
});

it("releases a cancelled spacing slot so later work can start", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 1_000 });
  await coordinator.run("A", async () => "first");
  const abort = new AbortController();
  const cancelledPerform = vi.fn(async () => "unexpected");
  const cancelled = coordinator.run("A", cancelledPerform, abort.signal);
  await vi.advanceTimersByTimeAsync(100);
  abort.abort(new Error("cancelled during spacing"));
  await expect(cancelled).rejects.toThrow("cancelled during spacing");
  const nextPerform = vi.fn(async () => "next");
  const next = coordinator.run("A", nextPerform);
  await vi.advanceTimersByTimeAsync(900);
  expect(cancelledPerform).not.toHaveBeenCalled();
  expect(nextPerform).toHaveBeenCalledTimes(1);
  await expect(next).resolves.toBe("next");
});

it("does not join an abandoned read when an identical request is issued immediately", async () => {
  const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });
  const abort = new AbortController();
  const perform = vi.fn(async () => "fresh read");
  const abandoned = coordinator.run("A", perform, abort.signal);
  const abandonedResult = expect(abandoned).rejects.toThrow("abandoned");
  abort.abort(new Error("abandoned"));
  const next = coordinator.run("A", perform);
  await abandonedResult;
  await expect(next).resolves.toBe("fresh read");
  expect(perform).toHaveBeenCalledTimes(1);
});

it("does not accumulate native requests behind a stalled response after spacing expires", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 5_000 });
  const finishes: Array<(value: number) => void> = [];
  const starts: number[] = [];
  const perform = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        starts.push(Date.now());
        finishes.push(resolve);
      }),
  );
  const requests = Array.from({ length: 6 }, () => coordinator.run("A", perform));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(perform).toHaveBeenCalledTimes(1);
  for (let index = 0; index < requests.length; index++) {
    finishes[index]?.(index);
    await expect(requests[index]).resolves.toBe(index);
    await vi.advanceTimersByTimeAsync(index === 0 ? 0 : 5_000);
    expect(perform).toHaveBeenCalledTimes(Math.min(index + 2, requests.length));
  }
  expect(starts).toEqual([1_000_000, 1_120_000, 1_125_000, 1_130_000, 1_135_000, 1_140_000]);
});

it("keeps a cancelled native request in flight until it settles and then admits the next read", async () => {
  const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 0 });
  const cancelled = new AbortController();
  const nativeSignals: AbortSignal[] = [];
  const finishes: Array<(value: string) => void> = [];
  const run = vi.fn((signal: AbortSignal) => {
    nativeSignals.push(signal);
    return new Promise<string>((resolve) => {
      finishes.push(resolve);
    });
  });
  const first = coordinator.run("A", run, cancelled.signal);
  const second = coordinator.run("A", run);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  cancelled.abort(new Error("cancelled caller"));
  await expect(first).rejects.toThrow("cancelled caller");
  expect(nativeSignals[0]?.aborted).toBe(true);
  expect(run).toHaveBeenCalledTimes(1);
  await expect(coordinator.run("B", async () => "other account")).resolves.toBe("other account");
  finishes[0]?.("late cancelled result");
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(nativeSignals[1]?.aborted).toBe(false);
  finishes[1]?.("ok");
  await expect(second).resolves.toBe("ok");
});

it("skips a cancelled queued request after a stalled call and honors its late Retry-After", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const coordinator = new ChatAccountRequestCoordinator({ spacingMs: 5_000 });
  let rejectFirst!: (error: Error) => void;
  const stalled = vi.fn(
    () =>
      new Promise<string>((_resolve, reject) => {
        rejectFirst = reject;
      }),
  );
  const first = coordinator.run("A", stalled);
  const abort = new AbortController();
  const cancelledPerform = vi.fn(async () => "must not start");
  const cancelled = coordinator.run("A", cancelledPerform, abort.signal);
  const nextPerform = vi.fn(async () => "recovered");
  const next = coordinator.run("A", nextPerform);
  await vi.advanceTimersByTimeAsync(60_000);
  abort.abort(new Error("queued caller left"));
  await expect(cancelled).rejects.toThrow("queued caller left");
  const limited = Object.assign(new Error("Too many requests"), {
    status: 429,
    headers: { "retry-after": "120" },
  });
  rejectFirst(limited);
  await expect(first).rejects.toBe(limited);
  await vi.advanceTimersByTimeAsync(119_999);
  expect(cancelledPerform).not.toHaveBeenCalled();
  expect(nextPerform).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(next).resolves.toBe("recovered");
  expect(stalled).toHaveBeenCalledOnce();
  expect(nextPerform).toHaveBeenCalledOnce();
});
