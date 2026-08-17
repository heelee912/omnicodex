import { describe, expect, it, vi } from "vitest";
import {
  assertExplicitLoopbackCdpEndpoint,
  ChatGptAppApprovalAdapter,
  type ChatGptApprovalSnapshot,
} from "../src/infrastructure/chatgpt/chatgpt-app-approval-adapter.js";

const binding = {
  appConnectorId: "connector_omni",
  appName: "OmniCodex",
  oracleRunId: "run-1",
  sessionId: "session-1",
  correlationId: "corr-1",
  mcpServerResource: "https://owner.example/mcp",
  mcpSurface: "/mcp/full",
};
const snap = (patch: Partial<ChatGptApprovalSnapshot> = {}): ChatGptApprovalSnapshot => ({
  ...binding,
  domRevision: "1",
  connected: false,
  alwaysAllowed: false,
  toolResultPresent: false,
  nodes: [{ ref: "c", role: "button", name: "Connect" }],
  ...patch,
});
describe("ChatGptAppApprovalAdapter", () => {
  it("connects, always allows, and stops idempotently at tool result", async () => {
    const states = [
      snap(),
      snap({
        domRevision: "2",
        connected: true,
        nodes: [{ ref: "a", role: "button", name: "항상 허용" }],
      }),
      snap({
        domRevision: "2",
        connected: true,
        nodes: [{ ref: "a", role: "button", name: "항상 허용" }],
      }),
      snap({
        domRevision: "3",
        connected: true,
        alwaysAllowed: true,
        toolResultPresent: true,
        nodes: [],
      }),
      snap({
        domRevision: "3",
        connected: true,
        alwaysAllowed: true,
        toolResultPresent: true,
        nodes: [],
      }),
    ];
    const activate = vi.fn();
    const result = await new ChatGptAppApprovalAdapter(binding).watch(
      {
        snapshot: async () => {
          const state = states.shift();
          if (state === undefined) throw new Error("test snapshot exhausted");
          return state;
        },
        activate,
      },
      { now: () => new Date("2026-08-17T00:00:00Z"), sleep: async () => {} },
    );
    expect(activate).toHaveBeenCalledTimes(2);
    expect(result.receipts.map((r) => r.action)).toEqual(["connect", "always_allow"]);
    expect(JSON.stringify(result.receipts)).not.toMatch(/prompt|screenshot|secret|raw/i);
  });
  it.each([{ appName: "Other" }, { oracleRunId: "stale" }, { mcpSurface: "/wrong" }])(
    "rejects wrong/stale identity %o",
    async (patch) => {
      await expect(
        new ChatGptAppApprovalAdapter(binding).watch(
          { snapshot: async () => snap(patch), activate: async () => {} },
          { timeoutMs: 1 },
        ),
      ).rejects.toThrow(/STALE_OR_WRONG/);
    },
  );
  it.each(["Delete", "Confirm", "Allow once", "삭제", "확인"])(
    "rejects destructive/general confirmation %s",
    async (name) => {
      const activate = vi.fn();
      await expect(
        new ChatGptAppApprovalAdapter(binding).watch(
          {
            snapshot: async () =>
              snap({ nodes: [{ ref: "x", role: "button", name, destructive: true }] }),
            activate,
          },
          { timeoutMs: 1 },
        ),
      ).rejects.toThrow(/MISSING/);
      expect(activate).not.toHaveBeenCalled();
    },
  );
  it("fails on stale DOM", async () => {
    await expect(
      new ChatGptAppApprovalAdapter(binding).watch(
        { snapshot: async () => snap(), activate: async () => {} },
        { maxRetries: 0 },
      ),
    ).rejects.toThrow("STALE_DOM");
  });
  it("does nothing if result exists", async () => {
    const activate = vi.fn();
    expect(
      (
        await new ChatGptAppApprovalAdapter(binding).watch({
          snapshot: async () => snap({ toolResultPresent: true }),
          activate,
        })
      ).receipts,
    ).toEqual([]);
    expect(activate).not.toHaveBeenCalled();
  });
  it("accepts only explicit loopback CDP", () => {
    expect(assertExplicitLoopbackCdpEndpoint("http://127.0.0.1:9222").port).toBe("9222");
    expect(() => assertExplicitLoopbackCdpEndpoint("http://example.com:9222")).toThrow(/loopback/);
  });
});
