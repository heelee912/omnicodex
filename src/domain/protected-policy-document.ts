export function protectedBrowserPolicyFile(
  name: string,
  surface: "chrome" | "iab" | "edge" | "extension" | "default",
): string | undefined {
  const documentName = name.trim().toLowerCase().replace(/\.md$/u, "");
  if (
    documentName === "confirmations" ||
    documentName === "confirmation" ||
    documentName === "agent-confirmations-policy"
  ) {
    return "chrome-confirmations.md";
  }
  if (documentName === "browser-safety" || documentName === "safety" || documentName === "policy") {
    return surface === "iab" ? "codex-app-browser-safety.md" : "chrome-browser-safety.md";
  }
  return protectedPolicyFiles.get(documentName);
}

const protectedPolicyFiles = new Map([
  ["tinysky-alt-confirmations", "tinysky-alt-confirmations.md"],
  ["chrome-confirmations", "chrome-confirmations.md"],
  ["chrome-browser-safety", "chrome-browser-safety.md"],
  ["browser-browser-safety", "browser-browser-safety.md"],
  ["chrome-backup-browser-safety", "chrome-backup-browser-safety.md"],
  ["browser-safety-training", "browser-safety-training.md"],
  ["browser-safety-training-cua-reference", "browser-safety-training-cua-reference.md"],
  ["codex-app-browser-safety", "codex-app-browser-safety.md"],
  ["cloud-browser-safety", "cloud-browser-safety.md"],
  ["orbit-browser-safety", "orbit-browser-safety.md"],
  ["computer-use-guidance", "computer-use-guidance.md"],
]);
