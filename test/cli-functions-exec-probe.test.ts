import { describe, expect, it, vi } from "vitest";
import {
  assertFunctionsExecProbeResult,
  type FunctionsExecProbeResult,
  functionsExecProbeInput,
} from "../src/cli.js";

const requiredToolNames = [
  "codex_app__list_threads",
  "codex_app__list_archived_threads",
  "codex_app__read_thread",
  "codex_app__send_message_to_thread",
  "codex__app_server__fs_readFile",
  "codex__app_server__fs_writeFile",
  "codex__app_server__command_exec",
  "mcp__node_repl__js",
  "browser__list_surfaces",
  "chrome__list_user_tabs",
  "chrome__control_chrome",
  "browser__control_in_app_browser",
] as const;

type ProbeTool = (args?: Record<string, unknown>) => Promise<unknown>;
type ProbeRunner = (
  metadata: readonly { readonly name: string }[],
  tools: Readonly<Record<string, ProbeTool>>,
  text: (value: string) => void,
) => Promise<void>;

describe("CLI functions.exec thread-kind parity probe", () => {
  it("discovers every returned backing kind and reads one bounded representative of each", async () => {
    const threadKinds = new Map([
      ["codex-current", "codex"],
      ["codex-other", "codex"],
      ["chatgpt-active", "chatgpt"],
      ["future-archived", "future-cloud"],
      ["codex-archived", "codex"],
    ]);
    const readThread = vi.fn(async (args?: Record<string, unknown>) => {
      const threadId = String(args?.threadId ?? "");
      const kind = threadKinds.get(threadId);
      return {
        thread: { id: threadId, kind },
        turns: kind === "chatgpt" ? [{ id: "turn-1" }] : [],
        page:
          kind === "chatgpt" ? { hasMore: true, nextCursor: "chatgpt-next" } : { hasMore: false },
      };
    });
    const listThreads = vi.fn(async () => ({
      structuredContent: {
        pinnedThreads: [{ id: "codex-current", kind: "codex", hostId: "local" }],
        threads: [
          { id: "codex-other", kind: "codex", hostId: "local" },
          { id: "chatgpt-active", kind: "chatgpt", hostId: "cloud" },
        ],
      },
    }));
    const listArchivedThreads = vi.fn(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            threads: [
              { id: "future-archived", kind: "future-cloud", hostId: "future-host" },
              { id: "codex-archived", kind: "codex", hostId: "local" },
            ],
          }),
        },
      ],
    }));
    const tools: Record<string, ProbeTool> = {
      codex_app__list_threads: listThreads,
      codex_app__list_archived_threads: listArchivedThreads,
      codex_app__read_thread: readThread,
      mcp__node_repl__js: async () => ({ success: true }),
      browser__list_surfaces: async () => ({ success: true }),
    };

    const result = await runProbe("codex-current", tools);

    assertFunctionsExecProbeResult(result);
    expect(listThreads).toHaveBeenCalledWith({ limit: 50 });
    expect(listArchivedThreads).toHaveBeenCalledWith({ limit: 50 });
    expect(result.sessionParity.threadKinds).toEqual(["chatgpt", "codex", "future-cloud"]);
    expect(result.sessionParity.readThreadCount).toBe(3);
    expect(result.sessionParity.kindParity).toEqual([
      {
        kind: "chatgpt",
        activeCount: 1,
        archivedCount: 0,
        totalCount: 1,
        readThreadCount: 1,
        representativeThreadId: "chatgpt-active",
      },
      {
        kind: "codex",
        activeCount: 2,
        archivedCount: 1,
        totalCount: 3,
        readThreadCount: 1,
        representativeThreadId: "codex-other",
      },
      {
        kind: "future-cloud",
        activeCount: 0,
        archivedCount: 1,
        totalCount: 1,
        readThreadCount: 1,
        representativeThreadId: "future-archived",
      },
    ]);
    expect(readThread.mock.calls.map(([args]) => args)).toEqual([
      {
        threadId: "chatgpt-active",
        turnLimit: 1,
        includeOutputs: false,
        hostId: "cloud",
      },
      {
        threadId: "codex-other",
        turnLimit: 1,
        includeOutputs: false,
        hostId: "local",
      },
      {
        threadId: "future-archived",
        turnLimit: 1,
        includeOutputs: false,
        hostId: "future-host",
      },
    ]);

    const incomplete = structuredClone(result) as FunctionsExecProbeResult;
    (incomplete.sessionParity.representativeReads as unknown[]).pop();
    expect(() => assertFunctionsExecProbeResult(incomplete)).toThrow(
      "invalid session parity counts",
    );
  });

  it("fails instead of accepting a representative read from a different backing kind", async () => {
    await expect(
      runProbe(null, {
        codex_app__list_threads: async () => ({
          pinnedThreads: [],
          threads: [{ id: "future-thread", kind: "future-cloud" }],
        }),
        codex_app__list_archived_threads: async () => ({ threads: [] }),
        codex_app__read_thread: async () => ({
          thread: { id: "future-thread", kind: "codex" },
          turns: [],
        }),
        mcp__node_repl__js: async () => ({ success: true }),
        browser__list_surfaces: async () => ({ success: true }),
      }),
    ).rejects.toThrow("Wrong or incomplete future-cloud thread readback");
  });
});

async function runProbe(
  callingThreadId: string | null,
  tools: Readonly<Record<string, ProbeTool>>,
): Promise<unknown> {
  let output: string | undefined;
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
    ...args: string[]
  ) => ProbeRunner;
  const runner = new AsyncFunction(
    "ALL_TOOLS",
    "tools",
    "text",
    functionsExecProbeInput(callingThreadId),
  );
  await runner(
    requiredToolNames.map((name) => ({ name })),
    tools,
    (value) => {
      output = value;
    },
  );
  if (output === undefined) throw new Error("Probe emitted no result");
  return JSON.parse(output) as unknown;
}
