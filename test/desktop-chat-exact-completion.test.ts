import { describe, expect, it, vi } from "vitest";
import {
  type DesktopExactCompletionInput,
  readDesktopExactCompletion,
} from "../src/infrastructure/windows/desktop-chat-exact-completion.js";
import type { DesktopGoalSnapshot } from "../src/infrastructure/windows/desktop-goal-binding-reader.js";

const url = "https://chatgpt.com/c/6aa0402d-d934-83ee-bc94-42b9da04cde3";
const principal = { accountId: "account", userId: "person" };
const accountSourceId = "chatgpt:account:person";
const candidate = { conversationUrl: url, finalMessageId: "final", streamTurnId: "turn" };
function fixture() {
  const input: DesktopExactCompletionInput = {
    endpoint: "http://127.0.0.1:39000",
    conversationUrl: url,
    accountSourceId,
    connectorIds: ["connector"],
    readScope: async () => ({ accountSourceId, connectorIds: ["connector"] }),
    readPrincipal: vi.fn(async () => principal),
    hasConversationSource: vi.fn(async () => true),
  };
  const snapshot: DesktopGoalSnapshot = {
    raw: {
      current_node: "final",
      mapping: { final: { parent: "input", message: { status: "finished_successfully" } } },
    },
    observation: {
      conversationUrl: url,
      source: { kind: "desktop", accountSourceId },
      goals: [],
      current: {
        id: "final",
        authorRole: "assistant",
        status: "finished_successfully",
        channel: "final",
        endTurn: true,
        ancestorMessageIds: ["input", "anchor"],
      },
    },
  };
  return {
    input,
    snapshot,
    signal: new AbortController().signal,
    read: vi.fn(async () => snapshot),
  };
}
describe("Desktop exact completion", () => {
  it("verifies the nominated final with all explicit parent edges and stream identity", async () => {
    const f = fixture();
    expect(
      await readDesktopExactCompletion(f.input, { candidate }, f.signal, f.read),
    ).toMatchObject({
      outcome: "verified",
      completion: candidate,
      ancestorMessageIds: ["input", "anchor"],
    });
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.input.readPrincipal).toHaveBeenCalledTimes(2);
  });
  it("reads a newer final only when its explicit ancestry contains the anchor", async () => {
    const f = fixture();
    expect(
      (await readDesktopExactCompletion(f.input, { anchor: "anchor" }, f.signal, f.read)).outcome,
    ).toBe("verified");
    expect(
      (await readDesktopExactCompletion(f.input, { anchor: "absent" }, f.signal, f.read)).outcome,
    ).toBe("awaiting_transcript");
    expect((await readDesktopExactCompletion(f.input, {}, f.signal, f.read)).outcome).toBe(
      "awaiting_transcript",
    );
  });
  it("does not turn a different or non-final current message into the candidate", async () => {
    const f = fixture();
    expect(
      (
        await readDesktopExactCompletion(
          f.input,
          { candidate: { ...candidate, finalMessageId: "old" } },
          f.signal,
          f.read,
        )
      ).outcome,
    ).toBe("awaiting_transcript");
    f.read.mockResolvedValue({
      ...f.snapshot,
      observation: {
        ...f.snapshot.observation,
        current: { ...f.snapshot.observation.current, id: "final", channel: "analysis" },
      },
    });
    expect(
      (await readDesktopExactCompletion(f.input, { candidate }, f.signal, f.read)).outcome,
    ).toBe("awaiting_transcript");
  });
  it("preserves native request failures and their original details", async () => {
    const f = fixture();
    const failure = Object.assign(new Error("Too many requests"), { status: 429, retryAtMs: 123 });
    f.read.mockRejectedValue(failure);
    await expect(readDesktopExactCompletion(f.input, { candidate }, f.signal, f.read)).rejects.toBe(
      failure,
    );
  });
  it("retains full current conversation failure in cause", async () => {
    const f = fixture();
    const raw = {
      status: { type: "systemError" },
      error: { message: "native failure", details: { original: true } },
    };
    f.read.mockResolvedValue({ ...f.snapshot, raw });
    await expect(
      readDesktopExactCompletion(f.input, { candidate }, f.signal, f.read),
    ).rejects.toMatchObject({ cause: raw, message: expect.stringContaining("native failure") });
  });
  it("rejects an account change before reading and after reading", async () => {
    const f = fixture();
    vi.spyOn(f.input, "readPrincipal").mockResolvedValue({ ...principal, accountId: "other" });
    expect(
      (await readDesktopExactCompletion(f.input, { candidate }, f.signal, f.read)).outcome,
    ).toBe("account_changed");
    expect(f.read).not.toHaveBeenCalled();
    vi.spyOn(f.input, "readPrincipal")
      .mockResolvedValueOnce(principal)
      .mockResolvedValueOnce({ ...principal, accountId: "other" });
    expect(
      (await readDesktopExactCompletion(f.input, { candidate }, f.signal, f.read)).outcome,
    ).toBe("account_changed");
  });
  it("does not read a conversation outside the verified source", async () => {
    const f = fixture();
    vi.spyOn(f.input, "hasConversationSource").mockResolvedValue(false);
    expect(
      (await readDesktopExactCompletion(f.input, { candidate }, f.signal, f.read)).outcome,
    ).toBe("conversation_source_mismatch");
    expect(f.read).not.toHaveBeenCalled();
  });
});
