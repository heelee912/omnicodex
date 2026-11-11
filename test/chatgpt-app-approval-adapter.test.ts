import { describe, expect, it, vi } from "vitest";
import {
  assertExplicitLoopbackCdpEndpoint,
  ChatGptAppApprovalAdapter,
  type ChatGptApprovalSnapshot,
  supportedConsentControlStrength,
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
  nodes: [{ ref: "c", role: "button", name: "Connect", exactAppScope: true }],
  ...patch,
});
describe("ChatGptAppApprovalAdapter", () => {
  it("shares the current ChatGPT consent labels with target discovery", () => {
    expect(supportedConsentControlStrength("Connect")).toBe("connection");
    expect(supportedConsentControlStrength("저위험 액션 허용")).toBe("low_risk");
    expect(supportedConsentControlStrength("Always allow")).toBe("persistent");
    expect(supportedConsentControlStrength("모든 액션 허용")).toBe("full_access");
    expect(supportedConsentControlStrength("Allow once")).toBeUndefined();
  });

  it("connects, always allows, and stops idempotently at tool result", async () => {
    const states = [
      snap(),
      snap({
        domRevision: "2",
        connected: true,
        nodes: [{ ref: "a", role: "button", name: "항상 허용", exactAppScope: true }],
      }),
      snap({
        domRevision: "2",
        connected: true,
        nodes: [{ ref: "a", role: "button", name: "항상 허용", exactAppScope: true }],
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
    expect(result.receipts.map((r) => r.consentStrength)).toEqual(["connection", "persistent"]);
    expect(JSON.stringify(result.receipts)).not.toMatch(/prompt|screenshot|secret|raw/i);
  });
  it("keeps watching without an implicit 30-second or one-retry cutoff", async () => {
    let connected = false;
    let activationAttempts = 0;
    let clockReads = 0;
    const result = await new ChatGptAppApprovalAdapter(binding).watch(
      {
        snapshot: async () =>
          connected
            ? snap({
                domRevision: "after",
                connected: true,
                alwaysAllowed: true,
                toolResultPresent: true,
                nodes: [],
              })
            : snap({
                domRevision: "before",
                nodes: [
                  { ref: "full", role: "button", name: "모든 액션 허용", exactAppScope: true },
                ],
              }),
        activate: async () => {
          activationAttempts += 1;
          if (activationAttempts < 3) throw new Error("transient activation race");
          connected = true;
        },
      },
      {
        now: () => new Date(Date.UTC(2026, 7, 17) + clockReads++ * 31_000),
        sleep: async () => undefined,
      },
    );

    expect(activationAttempts).toBe(3);
    expect(result.state).toBe("tool_result");
  });
  it("does not fabricate a separate Connect receipt from one combined full-access click", async () => {
    let activated = false;
    const activate = vi.fn(async () => {
      activated = true;
    });
    const result = await new ChatGptAppApprovalAdapter(binding).watch(
      {
        snapshot: async () =>
          activated
            ? snap({
                domRevision: "after",
                connected: true,
                alwaysAllowed: true,
                toolResultPresent: true,
                nodes: [],
              })
            : snap({
                domRevision: "before",
                connected: false,
                alwaysAllowed: false,
                nodes: [
                  {
                    ref: "low",
                    role: "button",
                    name: "저위험 액션 허용",
                    exactAppScope: true,
                  },
                  {
                    ref: "full",
                    role: "button",
                    name: "모든 액션 허용",
                    exactAppScope: true,
                  },
                ],
              }),
        activate,
      },
      { sleep: async () => {} },
    );
    expect(activate).toHaveBeenCalledWith("full", "before", undefined);
    expect(
      result.receipts.map(({ action, consentStrength }) => ({ action, consentStrength })),
    ).toEqual([{ action: "always_allow", consentStrength: "full_access" }]);
  });
  it("prefers exact Always allow over the broader full-access control", async () => {
    let activated = false;
    const activate = vi.fn(async () => {
      activated = true;
    });
    const result = await new ChatGptAppApprovalAdapter(binding).watch(
      {
        snapshot: async () =>
          activated
            ? snap({
                domRevision: "after",
                connected: true,
                alwaysAllowed: true,
                toolResultPresent: true,
                nodes: [],
              })
            : snap({
                domRevision: "before",
                connected: true,
                nodes: [
                  {
                    ref: "full",
                    role: "button",
                    name: "모든 액션 허용",
                    exactAppScope: true,
                  },
                  {
                    ref: "persistent",
                    role: "button",
                    name: "항상 허용",
                    exactAppScope: true,
                  },
                ],
              }),
        activate,
      },
      { sleep: async () => {} },
    );
    expect(activate).toHaveBeenCalledWith("persistent", "before", undefined);
    expect(result.receipts.map((receipt) => receipt.consentStrength)).toEqual(["persistent"]);
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
              snap({
                nodes: [{ ref: "x", role: "button", name, destructive: true, exactAppScope: true }],
              }),
            activate,
          },
          { timeoutMs: 1 },
        ),
      ).rejects.toThrow(/MISSING/);
      expect(activate).not.toHaveBeenCalled();
    },
  );
  it("never clicks a matching label outside the exact app ancestor scope", async () => {
    const activate = vi.fn();
    await expect(
      new ChatGptAppApprovalAdapter(binding).watch(
        {
          snapshot: async () =>
            snap({
              connected: true,
              nodes: [
                {
                  ref: "foreign",
                  role: "button",
                  name: "Always allow",
                  exactAppScope: false,
                },
              ],
            }),
          activate,
        },
        { timeoutMs: 1 },
      ),
    ).rejects.toThrow("CONSENT_CONTROL_MISSING");
    expect(activate).not.toHaveBeenCalled();
  });
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
          snapshot: async () =>
            snap({ connected: true, alwaysAllowed: true, toolResultPresent: true, nodes: [] }),
          activate,
        })
      ).receipts,
    ).toEqual([]);
    expect(activate).not.toHaveBeenCalled();
  });
  it("does not accept a tool result without confirmed connection and persistent consent", async () => {
    await expect(
      new ChatGptAppApprovalAdapter(binding).watch({
        snapshot: async () => snap({ toolResultPresent: true, nodes: [] }),
        activate: async () => {},
      }),
    ).rejects.toThrow("CONSENT_FINAL_STATE_NOT_CONFIRMED");
  });
  it("requires authoritative persistent-consent state after clicking Always allow", async () => {
    const states = [
      snap({
        domRevision: "before",
        connected: true,
        nodes: [{ ref: "a", role: "button", name: "Always allow", exactAppScope: true }],
      }),
      snap({ domRevision: "after", connected: true, alwaysAllowed: false, nodes: [] }),
    ];
    await expect(
      new ChatGptAppApprovalAdapter(binding).watch(
        {
          snapshot: async () => states.shift() as ChatGptApprovalSnapshot,
          activate: async () => {},
        },
        { maxRetries: 0 },
      ),
    ).rejects.toThrow("PERSISTENT_CONSENT_STATE_NOT_CONFIRMED");
  });
  it("accepts only explicit loopback CDP", () => {
    expect(assertExplicitLoopbackCdpEndpoint("http://127.0.0.1:9222").port).toBe("9222");
    expect(() => assertExplicitLoopbackCdpEndpoint("http://example.com:9222")).toThrow(/loopback/);
  });
});
