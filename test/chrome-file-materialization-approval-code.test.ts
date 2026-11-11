import { describe, expect, it } from "vitest";
import { chromeFileMaterializationApprovalCode } from "../src/application/omnicodex-gateway-service.js";

describe("Chrome file materialization approval dispatch", () => {
  it("claims only the exact open Loop conversation and activates one scoped OmniCodex prompt", () => {
    const code = chromeFileMaterializationApprovalCode(
      "https://chatgpt.com/c/6a99c621-cf78-83e8-ad6e-9b1aca804f0b?temporary=ignored",
    );

    expect(code).toContain(
      'const __omniExactConversationUrl = "https://chatgpt.com/c/6a99c621-cf78-83e8-ad6e-9b1aca804f0b";',
    );
    expect(code).toContain("await browser.user.openTabs()");
    expect(code).toContain("await browser.user.claimTab(__omniCandidates[0])");
    expect(code).toContain('name: "파일 생성을 허용할까요?"');
    expect(code).toContain('getByText("파일 생성을 허용할까요?", { exact: true })');
    expect(code).toContain("__omniDialogs !== 1");
    expect(code).toContain("__omniDialog.getByText");
    expect(code).toContain('__omniDialog.getByRole("button", { name: "허용하기"');
    expect(code).toContain("__omniDescriptions !== 1");
    expect(code).toContain("__omniAllows !== 1");
    expect(code).toContain("__omniRejects !== 1");
    expect(code).toContain('@data-testid="tool-approval-card"');
    expect(code).toContain('aria-label^="Allow OmniCodex"');
    expect(code).toContain('getByRole("menuitem", { name: "Always allow", exact: true })');
    expect(code).toContain(
      'getByRole("menuitem", { name: "Allow OmniCodex for this conversation", exact: true })',
    );
    expect(code).toContain("await __omniAlways.click");
    expect(code).toContain("await __omniAllow.click");
    expect(code).toContain("return { candidateCount:");
    expect(code).not.toContain("return JSON.stringify");
    expect(code).toContain('"persistent_activated" : "one_time_activated"');
    expect(code).not.toContain("browser.open(");
  });

  it("rejects non-conversation and non-ChatGPT targets before browser dispatch", () => {
    expect(() =>
      chromeFileMaterializationApprovalCode("https://example.com/c/not-chatgpt"),
    ).toThrow("Exact ChatGPT conversation URL required");
    expect(() => chromeFileMaterializationApprovalCode("https://chatgpt.com/g/gpt-id")).toThrow(
      "Exact ChatGPT conversation URL required",
    );
  });
});
