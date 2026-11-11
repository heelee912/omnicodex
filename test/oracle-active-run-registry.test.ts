import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OracleActiveRunRegistry } from "../src/application/oracle-active-run-registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OracleActiveRunRegistry", () => {
  it("binds only one live submitted run to its exact target and conversation", async () => {
    const root = await sessionRoot();
    await writeMeta(root, "oracle-live-run", {
      id: "oracle-live-run",
      status: "running",
      browser: {
        runtime: {
          chromeTargetId: "target-live",
          tabUrl: "https://chatgpt.com/c/exact-conversation?ignored=true",
          controllerPid: 41,
          promptSubmitted: true,
        },
      },
    });
    const registry = new OracleActiveRunRegistry({
      sessionRoot: root,
      isProcessAlive: (pid) => pid === 41,
    });

    await expect(
      registry.activeRunForTarget({
        id: "target-live",
        url: "https://chatgpt.com/c/exact-conversation",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/target-live",
      }),
    ).resolves.toMatchObject({
      oracleRunId: "oracle-live-run",
      targetId: "target-live",
      conversationUrl: "https://chatgpt.com/c/exact-conversation",
      controllerPid: 41,
    });
    await expect(
      registry.activeRunForTarget({
        id: "target-live",
        url: "https://chatgpt.com/c/another-conversation",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/target-live",
      }),
    ).resolves.toBeUndefined();
  });

  it("reconciles dead-controller metadata as stale instead of granting click authority", async () => {
    const root = await sessionRoot();
    await writeMeta(root, "oracle-dead-run", {
      id: "oracle-dead-run",
      status: "running",
      browser: {
        runtime: {
          chromeTargetId: "target-dead",
          tabUrl: "https://chatgpt.com/c/dead-conversation",
          controllerPid: 99,
          promptSubmitted: true,
        },
      },
    });
    const registry = new OracleActiveRunRegistry({
      sessionRoot: root,
      isProcessAlive: () => false,
    });

    await expect(registry.snapshot()).resolves.toEqual({
      active: [],
      staleRunIds: ["oracle-dead-run"],
    });
  });

  it("fails closed when two live runs claim the same target and conversation", async () => {
    const root = await sessionRoot();
    for (const id of ["oracle-live-one", "oracle-live-two"]) {
      await writeMeta(root, id, {
        id,
        status: "running",
        browser: {
          runtime: {
            chromeTargetId: "shared-target",
            tabUrl: "https://chatgpt.com/c/shared-conversation",
            controllerPid: 7,
            promptSubmitted: true,
          },
        },
      });
    }
    const registry = new OracleActiveRunRegistry({
      sessionRoot: root,
      isProcessAlive: () => true,
    });

    await expect(
      registry.activeRunForTarget({
        id: "shared-target",
        url: "https://chatgpt.com/c/shared-conversation",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/shared-target",
      }),
    ).resolves.toBeUndefined();
  });

  it("isolates one failed liveness probe instead of blocking every live run", async () => {
    const root = await sessionRoot();
    for (const [id, pid] of [
      ["oracle-probe-failed", 13],
      ["oracle-live-after-failure", 41],
    ] as const) {
      await writeMeta(root, id, {
        id,
        status: "running",
        browser: {
          runtime: {
            chromeTargetId: `target-${pid}`,
            tabUrl: `https://chatgpt.com/c/conversation-${pid}`,
            controllerPid: pid,
            promptSubmitted: true,
          },
        },
      });
    }
    const registry = new OracleActiveRunRegistry({
      sessionRoot: root,
      isProcessAlive: (pid) => {
        if (pid === 13) throw new Error("probe unavailable");
        return pid === 41;
      },
    });

    await expect(registry.snapshot()).resolves.toEqual({
      active: [
        expect.objectContaining({
          oracleRunId: "oracle-live-after-failure",
          controllerPid: 41,
        }),
      ],
      staleRunIds: [],
    });
  });
});

async function sessionRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omnicodex-oracle-runs-"));
  roots.push(root);
  return root;
}

async function writeMeta(root: string, id: string, value: unknown): Promise<void> {
  const directory = join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "meta.json"), JSON.stringify(value), "utf8");
}
