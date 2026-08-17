import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { RuntimeSupervisor } from "../src/application/runtime-supervisor.js";
import type { RuntimeCandidate } from "../src/domain/runtime.js";
import { JsonlRpcClient } from "../src/infrastructure/runtime/jsonl-rpc-client.js";

const candidate: RuntimeCandidate = {
  executablePath: "C:\\Codex\\codex.exe",
  canonicalPath: "C:\\Codex\\codex.exe",
  source: "managed_install",
};

describe("RuntimeSupervisor", () => {
  it("fails closed before starting a child", async () => {
    let created = false;
    const supervisor = new RuntimeSupervisor({
      safetyGate: {
        assertSafeToStart: async () => {
          throw new Error("baseline required");
        },
      },
      discovery: {
        discover: async () => ({ platform: "win32", candidates: [candidate], warnings: [] }),
      },
      processFactory: () => {
        created = true;
        throw new Error("must not be created");
      },
    });

    await expect(supervisor.start()).rejects.toThrow("baseline required");
    expect(created).toBe(false);
    expect(supervisor.status.lifecycle).toBe("stopped");
  });

  it("starts the first compatible candidate and stops only the owned process", async () => {
    const events: string[] = [];
    const process = {
      identity: { candidate, pid: 123, correlationId: "omni-test" },
      start: async () => {
        events.push("start");
      },
      stop: async () => {
        events.push("stop");
      },
      client: new JsonlRpcClient({
        readable: new PassThrough(),
        writable: new PassThrough(),
      }),
    };
    const supervisor = new RuntimeSupervisor({
      safetyGate: { assertSafeToStart: async () => undefined },
      discovery: {
        discover: async () => ({ platform: "win32", candidates: [candidate], warnings: [] }),
      },
      processFactory: () => process,
    });

    await expect(supervisor.start()).resolves.toMatchObject({ lifecycle: "ready", pid: 123 });
    expect(events).toEqual(["start"]);
    await supervisor.stop();
    expect(events).toEqual(["start", "stop"]);
    expect(supervisor.status.lifecycle).toBe("stopped");
  });
});
