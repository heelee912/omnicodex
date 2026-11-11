import { describe, expect, it } from "vitest";
import { ChatGptForegroundActivityTracker } from "../src/application/chatgpt-foreground-activity-tracker.js";

const conversationA = "a".repeat(64);
const conversationB = "b".repeat(64);
const workSessionA = "c".repeat(64);

describe("ChatGptForegroundActivityTracker", () => {
  it("settles each conversation independently after daemon startup", () => {
    let now = 1_000;
    const tracker = new ChatGptForegroundActivityTracker({ quietPeriodMs: 30_000, now: () => now });

    expect(tracker.snapshot({ chatGptConversationIdSha256: conversationA }).stage).toBe("settling");
    now += 30_000;
    expect(tracker.snapshot({ chatGptConversationIdSha256: conversationA }).stage).toBe("idle");
    expect(tracker.snapshot({ chatGptConversationIdSha256: conversationB }).stage).toBe("idle");
  });

  it("does not let one active Web conversation block another", () => {
    let now = 1_000;
    const tracker = new ChatGptForegroundActivityTracker({ quietPeriodMs: 30_000, now: () => now });
    now = 31_000;
    tracker.observe({
      callerProvenance: "chatgpt_conversation",
      correlationId: "foreground-call",
      chatGptConversationIdSha256: conversationA,
      phase: "started",
    });

    expect(tracker.snapshot({ chatGptConversationIdSha256: conversationA })).toMatchObject({
      active: true,
      activeCallCount: 1,
      stage: "active",
    });
    expect(tracker.snapshot({ chatGptConversationIdSha256: conversationB }).stage).toBe("idle");

    tracker.complete({
      callerProvenance: "chatgpt_conversation",
      correlationId: "foreground-call",
      chatGptConversationIdSha256: conversationA,
    });
    expect(tracker.snapshot({ chatGptConversationIdSha256: conversationA }).stage).toBe("settling");
    expect(tracker.snapshot({ chatGptConversationIdSha256: conversationB }).stage).toBe("idle");
  });

  it("attributes an opaque Web request to its durable work session when learned later", () => {
    let now = 1_000;
    const tracker = new ChatGptForegroundActivityTracker({ quietPeriodMs: 30_000, now: () => now });
    now = 31_000;
    tracker.observe({
      callerProvenance: "chatgpt_conversation",
      correlationId: "opaque-call",
      phase: "started",
    });
    expect(tracker.snapshot({ workSessionBindingSha256s: [workSessionA] }).stage).toBe("idle");

    tracker.attribute({
      callerProvenance: "chatgpt_conversation",
      correlationId: "opaque-call",
      workSessionBindingSha256: workSessionA,
    });
    expect(tracker.snapshot({ workSessionBindingSha256s: [workSessionA] }).stage).toBe("active");

    tracker.complete({
      callerProvenance: "chatgpt_conversation",
      correlationId: "opaque-call",
      workSessionBindingSha256: workSessionA,
    });
    expect(tracker.snapshot({ workSessionBindingSha256s: [workSessionA] }).stage).toBe("settling");
    now += 30_000;
    expect(tracker.snapshot({ workSessionBindingSha256s: [workSessionA] }).stage).toBe("idle");
  });

  it("uses HTTP completion identity when the progress-complete event is missing", () => {
    let now = 1_000;
    const tracker = new ChatGptForegroundActivityTracker({ quietPeriodMs: 30_000, now: () => now });
    now = 31_000;
    tracker.observe({
      callerProvenance: "chatgpt_conversation",
      correlationId: "missing-progress-completion",
      phase: "started",
    });
    tracker.complete({
      callerProvenance: "chatgpt_conversation",
      correlationId: "missing-progress-completion",
      workSessionBindingSha256: workSessionA,
    });

    expect(tracker.snapshot({ workSessionBindingSha256s: [workSessionA] }).stage).toBe("settling");
    now += 30_000;
    expect(tracker.snapshot({ workSessionBindingSha256s: [workSessionA] }).stage).toBe("idle");
  });

  it("ignores unrelated and incomplete observations", () => {
    let now = 1;
    const tracker = new ChatGptForegroundActivityTracker({ quietPeriodMs: 0, now: () => now });
    tracker.observe({
      callerProvenance: "local_operator",
      correlationId: "local-call",
      chatGptConversationIdSha256: conversationA,
      phase: "started",
    });
    tracker.observe({ callerProvenance: "chatgpt_conversation", phase: "started" });
    expect(tracker.snapshot({ chatGptConversationIdSha256: conversationA }).active).toBe(false);
    now += 1;
  });
});
