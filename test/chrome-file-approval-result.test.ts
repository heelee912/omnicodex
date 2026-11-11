import { describe, expect, it } from "vitest";
import {
  chromeApprovalReceiptSynchronized,
  chromeFileApprovalResultSummary,
} from "../src/application/chrome-file-approval-result.js";

describe("Chrome file approval native result", () => {
  it("keeps an active response receipt for a later tab check", () => {
    expect(chromeApprovalReceiptSynchronized("response_in_progress")).toBe(false);
    expect(chromeApprovalReceiptSynchronized("refreshed")).toBe(true);
    expect(chromeApprovalReceiptSynchronized("approval_not_visible")).toBe(true);
  });

  it("preserves a Goal retry deadline through a native text envelope", () => {
    const expected = {
      outcome: "rate_limited",
      error: "Too many requests",
      rateLimit: { status: 429, retryAtUnixMs: 123456, backoffSource: "local_backoff" },
    };
    expect(
      chromeFileApprovalResultSummary({
        content: [{ type: "text", text: JSON.stringify(expected) }],
      }),
    ).toEqual(expected);
  });

  it("recovers structured, MCP text, and diagnostic-prefixed result envelopes", () => {
    const expected = {
      outcome: "persistent_activated",
      candidateCount: 1,
      activatedCount: 1,
    };

    expect(chromeFileApprovalResultSummary({ structuredContent: expected })).toEqual(expected);
    expect(
      chromeFileApprovalResultSummary({
        content: [{ type: "text", text: JSON.stringify(expected) }],
      }),
    ).toEqual(expected);
    expect(
      chromeFileApprovalResultSummary({
        result: {
          content: [{ type: "text", text: `Node REPL output\n${JSON.stringify(expected)}` }],
        },
      }),
    ).toEqual(expected);
  });

  it("does not invent success for an unclassified native result", () => {
    expect(chromeFileApprovalResultSummary({ content: [{ type: "text", text: "done" }] })).toEqual({
      outcome: "native_result_unclassified",
    });
  });

  it("preserves the native failure instead of logging it as an unclassified success", () => {
    expect(
      chromeFileApprovalResultSummary({
        isError: true,
        content: [{ type: "text", text: "Chrome browser surface is unavailable" }],
      }),
    ).toEqual({
      outcome: "native_call_failed",
      error: "Chrome browser surface is unavailable",
    });
  });
});
