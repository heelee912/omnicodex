import { describe, expect, it } from "vitest";
import { NativeExecutionScheduler } from "../src/application/native-execution-scheduler.js";
import type { NativeToolRegistryEntry } from "../src/application/native-tool-registry.js";

describe("NativeExecutionScheduler", () => {
  it("runs reads in parallel but fairly serializes desktop tools", async () => {
    const scheduler = new NativeExecutionScheduler({ shellConcurrency: 2 });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const first = scheduler.run({ entry: entry("browser.click") }, async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const second = scheduler.run({ entry: entry("computer_use") }, async () => {
      events.push("second:start");
    });
    const read = scheduler.run({ entry: entry("read_file") }, async () => {
      events.push("read");
    });
    await read;
    expect(events).toHaveLength(2);
    expect(events).toContain("first:start");
    expect(events).toContain("read");
    releaseFirst();
    await Promise.all([first, second]);
    expect(events.indexOf("first:end")).toBeLessThan(events.indexOf("second:start"));
  });

  it("orders calls sharing a process or normalized file key", async () => {
    const scheduler = new NativeExecutionScheduler();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    const first = scheduler.run(
      { entry: entry("write_file"), ordering: { filePaths: ["C:/Work/A.txt"] } },
      async () => {
        events.push("first");
        await gate;
      },
    );
    const second = scheduler.run(
      { entry: entry("read_file"), ordering: { filePaths: ["c:\\work\\a.TXT"] } },
      async () => {
        events.push("second");
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["first"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first", "second"]);
  });

  it("bounds shell concurrency and removes a cancelled queued call", async () => {
    const scheduler = new NativeExecutionScheduler({ shellConcurrency: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = scheduler.run({ entry: entry("shell_command") }, () => gate);
    const controller = new AbortController();
    const cancelled = scheduler.run(
      { entry: entry("exec_command"), signal: controller.signal },
      async () => "must-not-run",
    );
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    release();
    await first;
  });

  it("returns a bounded timeout error", async () => {
    const scheduler = new NativeExecutionScheduler();
    let release!: () => void;
    const stillRunning = new Promise<void>((resolve) => {
      release = resolve;
    });
    await expect(
      scheduler.run(
        {
          entry: entry("read_file"),
          timeoutMs: 5,
          ordering: { filePaths: ["C:\\work\\held.txt"] },
        },
        () => stillRunning,
      ),
    ).rejects.toThrow("Native tool timed out after 5ms");
    let secondStarted = false;
    const second = scheduler.run(
      { entry: entry("read_file"), ordering: { filePaths: ["C:\\work\\held.txt"] } },
      async () => {
        secondStarted = true;
      },
    );
    await Promise.resolve();
    expect(secondStarted).toBe(false);
    release();
    await second;
    expect(secondStarted).toBe(true);
  });
});

function entry(name: string): NativeToolRegistryEntry {
  return {
    exposedName: name,
    catalogExposedName: name,
    originalName: name,
    nativeNamespace: "test",
    kind: "host",
    origin: "test",
    source: "test",
    identity: `test:${name}`,
    toolId: `tool:${name}`,
    modelEffect: "none",
    invokesModel: false,
    stateEffect: name.includes("read") ? "read" : "mutate",
    route: "host",
    descriptor: {
      name,
      invokesModel: false,
      tool: { name, inputSchema: { type: "object" } },
    },
    tool: { name, inputSchema: { type: "object" } },
  };
}
