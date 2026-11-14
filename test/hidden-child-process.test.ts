import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { HashChainedActionLedger } from "../src/infrastructure/safety/hash-chained-action-ledger.js";
import {
  configureDefaultHiddenChildActionLedger,
  HiddenChildProcessBoundary,
} from "../src/infrastructure/windows/hidden-child-process.js";

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

  it("durably records child and signal intent without arguments before returning", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnicodex-child-ledger-"));
    try {
      const ledgerPath = join(directory, "actions.jsonl");
      const spawned = new FakeChild(5151);
      const boundary = new HiddenChildProcessBoundary(() => spawned as never, ledgerPath);
      const owned = boundary.spawnHidden("C:\\owned\\codex.exe", ["--secret", "must-not-leak"]);
      expect(boundary.terminateOwnedHiddenChild(owned)).toBe(true);

      const raw = await readFile(ledgerPath, "utf8");
      const records = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.map((record) => record.phase)).toEqual([
        "intent",
        "completed",
        "intent",
        "completed",
      ]);
      expect(records.map((record) => record.kind)).toEqual([
        "child_process",
        "child_process",
        "process_signal",
        "process_signal",
      ]);
      expect(records[0]?.targetClass).toBe("omnicodex_owned_codex_runtime");
      expect(raw).not.toContain("must-not-leak");
      expect(raw).not.toContain("--secret");
      const view = await new HashChainedActionLedger(ledgerPath).readHead();
      expect(view.integrity).toBe("valid");
      expect(view.headSequence).toBe(4);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not create the configured default ledger until the first child launch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnicodex-default-child-ledger-"));
    try {
      const ledgerPath = join(directory, "actions.jsonl");
      configureDefaultHiddenChildActionLedger(ledgerPath);
      await expect(access(ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });

      const boundary = new HiddenChildProcessBoundary(() => new FakeChild(6161) as never);
      boundary.spawnHidden("owned.exe", []);

      await expect(access(ledgerPath)).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")(
    "inspects and terminates a recovered Windows identity through the same hidden boundary",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "omnicodex-recovered-child-ledger-"));
      try {
        const ledgerPath = join(directory, "actions.jsonl");
        const expected = {
          pid: 7171,
          parentPid: 6161,
          name: "ngrok.exe",
          executablePath: "C:\\owned\\ngrok.exe",
          commandLine: '"C:\\owned\\ngrok.exe" http http://127.0.0.1:8787',
          startedAtIso: "2026-08-27T00:00:00.0000000Z",
        };
        const outputs = [
          { status: "observed", process: expected },
          { status: "observed", process: expected },
          { status: "terminated" },
        ];
        const spawnCalls: Array<{
          readonly executable: string;
          readonly args: readonly string[];
          readonly options: SpawnOptions;
        }> = [];
        const boundary = new HiddenChildProcessBoundary((executable, args, options) => {
          const output = outputs.shift();
          if (output === undefined) throw new Error("Unexpected PowerShell probe");
          spawnCalls.push({ executable, args, options });
          return new FakeJsonChild(8181 + spawnCalls.length, output) as never;
        }, ledgerPath);

        await expect(
          boundary.inspectWindowsProcess(expected.pid, {
            systemRoot: "C:\\Windows",
            timeoutMs: 1_000,
          }),
        ).resolves.toEqual(expected);
        await expect(
          boundary.inspectWindowsLoopbackTcpListener(9222, {
            systemRoot: "C:\\Windows",
            timeoutMs: 1_000,
          }),
        ).resolves.toEqual(expected);
        await expect(
          boundary.terminateExactRecoveredWindowsProcess(expected, {
            systemRoot: "C:\\Windows",
            timeoutMs: 1_000,
          }),
        ).resolves.toBe("terminated");

        expect(spawnCalls).toHaveLength(3);
        for (const call of spawnCalls) {
          expect(call.executable).toBe(
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          );
          expect(call.args).toContain("-NonInteractive");
          expect(call.args).toContain("-WindowStyle");
          expect(call.args).toContain("Hidden");
          expect(call.options.windowsHide).toBe(true);
          expect(call.options.shell).toBe(false);
        }
        const raw = await readFile(ledgerPath, "utf8");
        expect(raw).not.toContain(expected.commandLine);
        expect(raw).not.toContain(expected.executablePath);
        const view = await new HashChainedActionLedger(ledgerPath).readHead();
        expect(view.integrity).toBe("valid");
        expect(view.headSequence).toBe(8);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "preserves Windows process metadata larger than 128 KiB",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "omnicodex-large-process-probe-"));
      try {
        const expected = {
          pid: 9191,
          parentPid: 8181,
          name: "codex.exe",
          executablePath: "C:\\owned\\codex.exe",
          commandLine: "x".repeat(160 * 1024),
          startedAtIso: "2026-08-29T00:00:00.0000000Z",
        };
        const boundary = new HiddenChildProcessBoundary(
          () => new FakeJsonChild(9292, { status: "observed", process: expected }) as never,
          join(directory, "actions.jsonl"),
        );

        await expect(
          boundary.inspectWindowsProcess(expected.pid, { systemRoot: "C:\\Windows" }),
        ).resolves.toEqual(expected);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  // A real CIM/PowerShell child can exceed its bounded probe deadline on the
  // hosted runner. Keep this live integration check on local Windows.
  it.skipIf(process.platform !== "win32" || process.env.GITHUB_ACTIONS === "true")(
    "recognizes a PID reused by a different image before reading protected process metadata",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "omnicodex-reused-pid-probe-"));
      try {
        const boundary = new HiddenChildProcessBoundary(
          undefined,
          join(directory, "actions.jsonl"),
        );
        await expect(
          boundary.inspectWindowsProcess(process.pid, {
            expectedProcessName: "not-the-current-node.exe",
            timeoutMs: 10_000,
          }),
        ).resolves.toBeUndefined();
        await expect(
          boundary.inspectWindowsProcess(process.pid, {
            expectedProcessName: "node.exe",
            timeoutMs: 10_000,
          }),
        ).resolves.toMatchObject({ pid: process.pid, name: "node.exe" });
        await expect(
          boundary.inspectWindowsProcess(process.pid, {
            expectedProcessName: "../node.exe",
          }),
        ).rejects.toThrow("expected process name");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "does not impose an inspection timeout when the caller omits one",
    async () => {
      vi.useFakeTimers();
      const directory = await mkdtemp(join(tmpdir(), "omnicodex-unbounded-process-probe-"));
      try {
        const expected = {
          pid: 9393,
          parentPid: 8383,
          name: "codex.exe",
          executablePath: "C:\\owned\\codex.exe",
          commandLine: '"C:\\owned\\codex.exe" app-server --stdio',
          startedAtIso: "2026-08-29T00:00:00.0000000Z",
        };
        const child = new ControllableJsonChild(9494);
        const boundary = new HiddenChildProcessBoundary(
          () => child as never,
          join(directory, "actions.jsonl"),
        );
        let settled = false;
        const inspection = boundary
          .inspectWindowsProcess(expected.pid, { systemRoot: "C:\\Windows" })
          .then(
            (value) => {
              settled = true;
              return value;
            },
            (error: unknown) => {
              settled = true;
              throw error;
            },
          );

        await vi.advanceTimersByTimeAsync(15_001);
        expect(settled).toBe(false);
        expect(child.signalCount).toBe(0);

        child.complete({ status: "observed", process: expected });
        await expect(inspection).resolves.toEqual(expected);
      } finally {
        vi.useRealTimers();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "win32")("preserves native probe failure details", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnicodex-process-probe-error-"));
    try {
      const child = new FailingJsonChild(9595, "complete native stderr detail");
      const boundary = new HiddenChildProcessBoundary(
        () => child as never,
        join(directory, "actions.jsonl"),
      );

      const error = await boundary
        .inspectWindowsProcess(9696, {
          systemRoot: "C:\\Windows",
          timeoutMs: 1_000,
        })
        .catch((failure: unknown) => failure);

      expect(error).toMatchObject({
        message: "OWNED_PROCESS_BOUNDARY_UNVERIFIABLE:probe failure",
        exitCode: 7,
        signal: null,
        stderr: "complete native stderr detail",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

class FakeJsonChild extends FakeChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  constructor(pid: number, output: unknown) {
    super(pid);
    this.stdin.once("finish", () => {
      setImmediate(() => {
        this.stdout.end(JSON.stringify(output));
        this.exitCode = 0;
        this.emit("close", 0, null);
      });
    });
  }
}

class ControllableJsonChild extends FakeChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  complete(output: unknown): void {
    this.stdout.end(JSON.stringify(output));
    this.exitCode = 0;
    this.emit("close", 0, null);
  }
}

class FailingJsonChild extends FakeChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  constructor(pid: number, errorOutput: string) {
    super(pid);
    this.stdin.once("finish", () => {
      setImmediate(() => {
        this.stderr.end(errorOutput);
        this.exitCode = 7;
        this.emit("close", 7, null);
      });
    });
  }
}
