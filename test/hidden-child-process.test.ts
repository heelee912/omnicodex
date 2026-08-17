import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { HiddenChildProcessBoundary } from "../src/infrastructure/windows/hidden-child-process.js";

describe("HiddenChildProcessBoundary", () => {
  it("signals only the exact active handle created by the same ownership registry", () => {
    const spawned = new FakeChild(4242);
    const boundary = new HiddenChildProcessBoundary((_executable, _args, options) => {
      expect(options.windowsHide).toBe(true);
      expect(options.shell).toBe(false);
      return spawned as never;
    });
    const owned = boundary.spawnHidden("owned.exe", ["--safe"]);
    const unknown = new FakeChild(4242);

    expect(owned.ownership.pid).toBe(4242);
    expect(owned.ownership.nonce).toHaveLength(36);
    expect(boundary.terminateOwnedHiddenChild(unknown as never)).toBe(false);
    expect(unknown.signalCount).toBe(0);
    expect(boundary.terminateOwnedHiddenChild(owned)).toBe(true);
    expect(spawned.signalCount).toBe(1);
  });

  it("fails closed after close or when creation metadata no longer matches", () => {
    const closedChild = new FakeChild(1111);
    const closedBoundary = new HiddenChildProcessBoundary(() => closedChild as never);
    const closedOwned = closedBoundary.spawnHidden("closed.exe", []);
    closedChild.emit("close", 0, null);
    expect(closedBoundary.terminateOwnedHiddenChild(closedOwned)).toBe(false);

    const mismatchedChild = new FakeChild(2222);
    const mismatchedBoundary = new HiddenChildProcessBoundary(() => mismatchedChild as never);
    const mismatchedOwned = mismatchedBoundary.spawnHidden("mismatched.exe", []);
    mismatchedChild.pid = 3333;
    expect(mismatchedBoundary.terminateOwnedHiddenChild(mismatchedOwned)).toBe(false);
    expect(mismatchedChild.signalCount).toBe(0);
  });
});

class FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signalCount = 0;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(): boolean {
    this.signalCount += 1;
    return true;
  }
}
