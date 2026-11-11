import { describe, expect, it, vi } from "vitest";
import {
  SharedResponsesAppServer,
  type SharedResponsesBinding,
} from "../src/application/shared-responses-app-server.js";
import type { RuntimeCandidate } from "../src/domain/runtime.js";
import type { CodexAppServerProcessOptions } from "../src/infrastructure/runtime/codex-app-server-process.js";

const candidate = {
  executablePath: "codex.exe",
  source: "managed_install",
  buildSha256: "a".repeat(64),
} as RuntimeCandidate;
const owner = (thread: string): SharedResponsesBinding => ({
  ownsThread: (id) => id === thread,
  onNotification: vi.fn(),
  onServerRequest: vi.fn(async () => thread),
  onExit: vi.fn(),
});
function setup() {
  const starts = vi.fn(async () => {});
  const stops = vi.fn(async () => {});
  let callbacks: CodexAppServerProcessOptions = {};
  const host = new SharedResponsesAppServer(candidate, {}, (_runtime, options) => {
    callbacks = options;
    return { client: { request: async <T>() => undefined as T }, start: starts, stop: stops };
  });
  return { host, starts, stops, callbacks: () => callbacks };
}

describe("Shared Responses App Server", () => {
  it("keeps one process while routing tool calls to the exact thread owner", async () => {
    const s = setup();
    const a = owner("A");
    const b = owner("B");
    const [first, second] = await Promise.all([s.host.acquire(a), s.host.acquire(b)]);
    expect(s.starts).toHaveBeenCalledTimes(1);
    expect(
      await s
        .callbacks()
        .onServerRequest?.({ method: "item/tool/call", params: { threadId: "B" } }),
    ).toBe("B");
    expect(a.onServerRequest).not.toHaveBeenCalled();
    s.callbacks().onNotification?.({
      method: "turn/completed",
      params: { threadId: "B", turn: { id: "b-turn" } },
    });
    expect(a.onNotification).not.toHaveBeenCalled();
    expect(b.onNotification).toHaveBeenCalledTimes(1);
    await first.release();
    expect(s.stops).not.toHaveBeenCalled();
    expect(
      await s
        .callbacks()
        .onServerRequest?.({ method: "item/tool/call", params: { threadId: "B" } }),
    ).toBe("B");
    await second.release();
    expect(s.stops).toHaveBeenCalledTimes(1);
  });

  it("publishes forced generation loss to all owners without replay", async () => {
    const s = setup();
    const a = owner("A");
    const b = owner("B");
    const first = await s.host.acquire(a);
    const second = await s.host.acquire(b);
    await first.process.stop();
    expect(a.onExit).toHaveBeenCalledTimes(1);
    expect(b.onExit).toHaveBeenCalledTimes(1);
    expect(a.onServerRequest).not.toHaveBeenCalled();
    const next = await s.host.acquire(owner("C"));
    expect(s.starts).toHaveBeenCalledTimes(2);
    await first.release();
    await second.release();
    expect(s.stops).toHaveBeenCalledTimes(1);
    await next.release();
    expect(s.stops).toHaveBeenCalledTimes(2);
  });

  it("retries a failed last-owner stop instead of orphaning the process", async () => {
    const s = setup();
    s.stops.mockRejectedValueOnce(new Error("stop failed"));
    const lease = await s.host.acquire(owner("A"));
    await expect(lease.release()).rejects.toThrow("stop failed");
    await lease.release();
    expect(s.stops).toHaveBeenCalledTimes(2);
  });
});
