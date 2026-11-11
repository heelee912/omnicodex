import { describe, expect, it } from "vitest";
import { normalizeChatGptConversationUrl } from "../src/infrastructure/chatgpt/chatgpt-conversation-route.js";

describe("approval conversation route normalization", () => {
  it("preserves project and custom-GPT conversation identity without an account lookup", () => {
    const id = "6a9a9046-9b10-83e9-a195-a92e893ee08c";
    for (const prefix of ["", "/g/g-p-project", "/g/g-custom-gpt"]) {
      expect(normalizeChatGptConversationUrl(`https://chatgpt.com${prefix}/c/${id}?ui=1`)).toBe(
        `https://chatgpt.com/c/${id}`,
      );
    }
  });

  it("rejects foreign hosts and routes without an exact conversation", () => {
    expect(normalizeChatGptConversationUrl("https://example.com/c/target")).toBeUndefined();
    expect(normalizeChatGptConversationUrl("https://chatgpt.com/g/g-p-project")).toBeUndefined();
    expect(
      normalizeChatGptConversationUrl("https://chatgpt.com/settings/c/target"),
    ).toBeUndefined();
  });
});
