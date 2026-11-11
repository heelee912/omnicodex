import { describe, expect, it } from "vitest";
import { CodexWorkExecutorIdReader } from "../src/infrastructure/windows/codex-work-executor-id-reader.js";

describe("CodexWorkExecutorIdReader", () => {
  it("keeps one registered Work executor until its process exits", async () => {
    let inspections = 0;
    let alive = true;
    let currentId = "work-executor-a";
    const reader = new CodexWorkExecutorIdReader({
      inspect: async () => {
        inspections += 1;
        return [{ pid: 1234, environmentId: currentId }];
      },
      isAlive: () => alive,
      cacheTtlMs: 30_000,
    });

    expect(await reader.read()).toBe("work-executor-a");
    currentId = "work-executor-b";
    expect(await reader.read()).toBe("work-executor-a");
    alive = false;
    expect(await reader.read()).toBe("work-executor-b");
    expect(inspections).toBe(2);
  });

  it("fails closed when Desktop has no Work executor or two different registrations", async () => {
    const missing = new CodexWorkExecutorIdReader({ inspect: async () => [] });
    await expect(missing.read()).rejects.toThrow("CODEX_WORK_EXECUTOR_UNAVAILABLE");

    const ambiguous = new CodexWorkExecutorIdReader({
      inspect: async () => [
        { pid: 1234, environmentId: "work-executor-a" },
        { pid: 5678, environmentId: "work-executor-b" },
      ],
    });
    await expect(ambiguous.read()).rejects.toThrow("CODEX_WORK_EXECUTOR_AMBIGUOUS");
  });
});
