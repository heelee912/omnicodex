import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PolicyDocumentationService } from "../src/application/policy-documentation-service.js";
import { protectedDocumentationResponse } from "../src/application/protected-documentation-response.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("Desktop protected documentation response", () => {
  it("returns the exact verified Korean Markdown in the native tool result", async () => {
    const home = await protectedHome(
      "chrome-confirmations.md",
      "# 확인 정책\n\n원문 그대로입니다.\n",
    );
    const service = new PolicyDocumentationService(home);
    const response = await protectedDocumentationResponse(
      {
        id: 9,
        method: "item/tool/call",
        params: {
          namespace: "chrome",
          tool: "control_chrome",
          arguments: { operation: "documentation", documentation_name: "confirmations" },
        },
      },
      service,
    );
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 9,
      result: {
        success: true,
        contentItems: [{ type: "inputText", text: "# 확인 정책\n\n원문 그대로입니다.\n" }],
      },
    });
  });

  it("fails closed with Korean Markdown when the protected document changes", async () => {
    const home = await protectedHome("codex-app-browser-safety.md", "# 브라우저 정책\n");
    await writeFile(
      join(home, "protected-confirmation-docs", "codex-app-browser-safety.md"),
      "변조",
    );
    const response = await protectedDocumentationResponse(
      {
        id: "request-2",
        method: "item/tool/call",
        params: {
          tool: "browser__control_in_app_browser",
          arguments: { operation: "documentation", documentation_name: "browser-safety" },
        },
      },
      new PolicyDocumentationService(home),
    );
    expect(response?.result.success).toBe(false);
    expect(response?.result.contentItems[0]?.text).toMatch(/^# 보호 문서 오류\n\n/u);
  });
});

async function protectedHome(fileName: string, markdown: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "omnicodex-policy-response-"));
  homes.push(home);
  const root = join(home, "protected-confirmation-docs");
  await mkdir(root);
  await writeFile(join(root, fileName), markdown);
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify([
      {
        Source: fileName,
        SHA256: createHash("sha256").update(markdown).digest("hex"),
      },
    ]),
  );
  return home;
}
