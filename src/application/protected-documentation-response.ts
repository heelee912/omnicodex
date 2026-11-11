import type { PolicyDocumentationService } from "./policy-documentation-service.js";

export interface ProtectedDocumentationResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly result: {
    readonly success: boolean;
    readonly contentItems: readonly { readonly type: "inputText"; readonly text: string }[];
  };
}

/** Answers Desktop policy documentation from the verified protected Markdown source. */
export async function protectedDocumentationResponse(
  message: unknown,
  service: PolicyDocumentationService,
): Promise<ProtectedDocumentationResponse | undefined> {
  const request = objectValue(message);
  if (request?.method !== "item/tool/call") return undefined;
  const id = request.id;
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  const params = objectValue(request.params);
  const argumentsValue = objectValue(params?.arguments);
  if (
    argumentsValue?.operation !== "documentation" ||
    typeof argumentsValue.documentation_name !== "string"
  ) {
    return undefined;
  }
  const surface = browserSurface(params?.namespace, params?.tool);
  if (surface === undefined) return undefined;
  let markdown: string | undefined;
  let success = true;
  try {
    markdown = await service.readBrowserDocument(argumentsValue.documentation_name, surface);
  } catch {
    markdown = "# 보호 문서 오류\n\n보호된 한글 Markdown을 확인할 수 없습니다.";
    success = false;
  }
  if (markdown === undefined) return undefined;
  return {
    jsonrpc: "2.0",
    id,
    result: { success, contentItems: [{ type: "inputText", text: markdown }] },
  };
}

function browserSurface(namespace: unknown, tool: unknown): "chrome" | "iab" | undefined {
  if (
    (tool === "chrome__control_chrome" && (namespace == null || namespace === "chrome")) ||
    (tool === "control_chrome" && namespace === "chrome")
  ) {
    return "chrome";
  }
  if (
    (tool === "browser__control_in_app_browser" &&
      (namespace == null || namespace === "browser")) ||
    (tool === "control_in_app_browser" && namespace === "browser")
  ) {
    return "iab";
  }
  return undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
