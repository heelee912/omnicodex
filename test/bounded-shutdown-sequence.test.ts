import { describe, expect, it } from "vitest";
import {
  runBoundedShutdownSequence,
  shutdownSequenceErrors,
} from "../src/application/bounded-shutdown-sequence.js";

describe("bounded shutdown sequence", () => {
  it("runs ordered phases while settling independent siblings after one rejects", async () => {
    const events: string[] = [];
    const results = await runBoundedShutdownSequence([
      {
        name: "admission",
        budgetMs: 100,
        run: () => [
          Promise.resolve().then(() => events.push("listener-closed")),
          Promise.reject(new Error("audit unavailable")),
          Promise.resolve().then(() => events.push("accepted-work-drained")),
        ],
      },
      {
        name: "children",
        budgetMs: 100,
        run: () => [Promise.resolve().then(() => events.push("owned-children-stopped"))],
      },
    ]);

    expect(events).toEqual(["listener-closed", "accepted-work-drained", "owned-children-stopped"]);
    expect(results).toMatchObject([
      { name: "admission", timedOut: false },
      { name: "children", timedOut: false, errors: [] },
    ]);
    expect(results[0]?.errors[0]?.message).toBe("audit unavailable");
  });

  it("continues to later cleanup after a phase exceeds its own deadline", async () => {
    const events: string[] = [];
    const never = new Promise<void>(() => undefined);
    const results = await runBoundedShutdownSequence([
      { name: "drain", budgetMs: 10, run: () => [never] },
      {
        name: "terminal-state",
        budgetMs: 100,
        run: () => [Promise.resolve().then(() => events.push("terminal-state-written"))],
      },
    ]);

    expect(results).toMatchObject([
      { name: "drain", timedOut: true, errors: [] },
      { name: "terminal-state", timedOut: false, errors: [] },
    ]);
    expect(events).toEqual(["terminal-state-written"]);
    expect(shutdownSequenceErrors(results).map((error) => error.message)).toEqual([
      "Shutdown phase drain exceeded its deadline",
    ]);
  });

  it("waits for complete phase settlement when the caller supplies no deadline", async () => {
    const events: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = runBoundedShutdownSequence([
      {
        name: "uncapped-drain",
        run: () => [
          pending.then(() => {
            events.push("fully-drained");
          }),
        ],
      },
      {
        name: "terminal-state",
        run: () => [Promise.resolve().then(() => events.push("terminal-state-written"))],
      },
    ]);

    await Promise.resolve();
    expect(events).toEqual([]);
    release();

    await expect(running).resolves.toMatchObject([
      { name: "uncapped-drain", timedOut: false, errors: [] },
      { name: "terminal-state", timedOut: false, errors: [] },
    ]);
    expect(events).toEqual(["fully-drained", "terminal-state-written"]);
  });
});
