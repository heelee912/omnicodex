import { describe, expect, it } from "vitest";
import { protectedBrowserPolicyFile } from "../src/domain/protected-policy-document.js";

describe("protected browser policy documents", () => {
  it.each([
    ["confirmations", "chrome", "chrome-confirmations.md"],
    ["agent-confirmations-policy", "chrome", "chrome-confirmations.md"],
    ["browser-safety", "chrome", "chrome-browser-safety.md"],
    ["browser-safety", "iab", "codex-app-browser-safety.md"],
    ["browser-safety-training", "chrome", "browser-safety-training.md"],
    ["browser-safety-training-cua-reference", "chrome", "browser-safety-training-cua-reference.md"],
    ["browser-browser-safety", "chrome", "browser-browser-safety.md"],
    ["chrome-backup-browser-safety", "chrome", "chrome-backup-browser-safety.md"],
    ["cloud-browser-safety", "chrome", "cloud-browser-safety.md"],
    ["orbit-browser-safety", "chrome", "orbit-browser-safety.md"],
    ["tinysky-alt-confirmations", "chrome", "tinysky-alt-confirmations.md"],
    ["computer-use-guidance", "chrome", "computer-use-guidance.md"],
  ] as const)("routes %s on %s to %s", (name, surface, expected) => {
    expect(protectedBrowserPolicyFile(name, surface)).toBe(expected);
  });

  it("normalizes a protected Markdown name but leaves unrelated documentation to the native reader", () => {
    expect(protectedBrowserPolicyFile(" CHROME-CONFIRMATIONS.MD ", "chrome")).toBe(
      "chrome-confirmations.md",
    );
    expect(protectedBrowserPolicyFile("screenshots", "chrome")).toBeUndefined();
    expect(protectedBrowserPolicyFile("accessibility", "iab")).toBeUndefined();
    expect(protectedBrowserPolicyFile("api-use-behavior", "chrome")).toBeUndefined();
    expect(protectedBrowserPolicyFile("capabilities/tab/botDetection", "chrome")).toBeUndefined();
    expect(protectedBrowserPolicyFile("core-cua-repl", "iab")).toBeUndefined();
  });
});
