import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeCandidate } from "../src/domain/runtime.js";
import { CodexAppServerProcess } from "../src/infrastructure/runtime/codex-app-server-process.js";
import type {
  CodexAppServerOwnershipRegistry,
  CodexAppServerRegistration,
} from "../src/infrastructure/runtime/owned-codex-app-server-registry.js";

const processBoundary = vi.hoisted(() => ({
  spawnHidden: vi.fn(),
  terminateOwnedHiddenChild: vi.fn(),
}));

vi.mock("../src/infrastructure/windows/hidden-child-process.js", async (importOriginal) => ({
  ...(await importOriginal()),
  spawnHidden: processBoundary.spawnHidden,
  terminateOwnedHiddenChild: processBoundary.terminateOwnedHiddenChild,
}));

describe("CodexAppServerProcess start cleanup", () => {
  beforeEach(() => {
    processBoundary.spawnHidden.mockReset();
    processBoundary.terminateOwnedHiddenChild.mockReset();
    processBoundary.terminateOwnedHiddenChild.mockReturnValue(true);
  });

  it("preserves the registration failure but waits for the exact child close", async () => {
    const child = new FakeOwnedChild();
    processBoundary.spawnHidden.mockReturnValue(child);
    const originalFailure = new Error("registry unavailable");
    const registry: CodexAppServerOwnershipRegistry = {
      register: vi.fn().mockRejectedValue(originalFailure),
    };
    const runtime = new CodexAppServerProcess(candidate, { ownershipRegistry: registry });
    let settled = false;

    const starting = runtime.start().then(
      () => undefined,
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await vi.waitFor(() => expect(child.stdin.writableEnded).toBe(true));
    expect(processBoundary.terminateOwnedHiddenChild).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    child.confirmClose(null, "SIGTERM");
    const failure = await starting;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "Codex App Server ownership registration failed: registry unavailable",
    );
    expect((failure as Error).cause).toBe(originalFailure);
    expect(runtime.identity.pid).toBeUndefined();
  });

  it("retains a registered early-exit handle until close and then releases its record", async () => {
    const child = new FakeOwnedChild();
    processBoundary.spawnHidden.mockReturnValue(child);
    const releaseAfterConfirmedExit = vi.fn(async () => undefined);
    const registration = {
      record: {},
      path: "owned.json",
      releaseAfterConfirmedExit,
    } as unknown as CodexAppServerRegistration;
    const registry: CodexAppServerOwnershipRegistry = {
      register: vi.fn(async () => {
        child.exitCode = 1;
        return registration;
      }),
    };
    const runtime = new CodexAppServerProcess(candidate, { ownershipRegistry: registry });
    let settled = false;

    const starting = runtime.start().then(
      () => undefined,
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    expect(runtime.identity.pid).toBe(child.pid);
    expect(processBoundary.terminateOwnedHiddenChild).not.toHaveBeenCalled();

    child.confirmClose(1, null);
    const failure = await starting;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "Codex App Server exited during ownership registration",
    );
    expect(releaseAfterConfirmedExit).toHaveBeenCalledOnce();
    expect(runtime.identity.pid).toBeUndefined();
  });
});

class FakeOwnedChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 6_161;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly ownership = {
    pid: this.pid,
    nonce: "start-cleanup-child-nonce",
    executable: candidate.executablePath,
    spawnedAtUnixMs: 1_000,
  };

  confirmClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }
}

const candidate: RuntimeCandidate = {
  executablePath: "C:\\Codex\\codex.exe",
  canonicalPath: "C:\\Codex\\codex.exe",
  source: "managed_install",
  productVersion: "1.2.3",
  buildSha256: "abc",
};
