import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OwnerBoundResourceStore } from "./owner-bound-resource-store.js";
import type { HttpAuthorizationIdentity } from "./streamable-http-gateway.js";

const MAX_INLINE_TEXT_BYTES = 256 * 1024;
const MAX_INLINE_BINARY_BYTES = 1024 * 1024;

export interface ProtectedResultContext {
  readonly owner: HttpAuthorizationIdentity;
  readonly sessionId: string;
  readonly publicOrigin: string;
}

/** Converts only oversized inline MCP content into owner/session-bound resource links. */
export function protectOversizedResult(
  result: CallToolResult,
  context: ProtectedResultContext,
  resources: OwnerBoundResourceStore,
): CallToolResult {
  let changed = false;
  const content = result.content.map((item, index) => {
    const binary = inlineContent(item);
    if (binary === undefined || binary.bytes.byteLength <= binary.inlineLimitBytes) return item;
    const resource = resources.put({
      owner: context.owner,
      sessionId: context.sessionId,
      mimeType: binary.mimeType,
      bytes: binary.bytes,
    });
    changed = true;
    return {
      type: "resource_link" as const,
      name: `OmniCodex result ${index + 1}`,
      uri: new URL(`/resources/${resource.id}`, context.publicOrigin).href,
      mimeType: resource.mimeType,
      size: resource.bytes.byteLength,
      _meta: {
        omnicodex: {
          digest: resource.digest,
          expiresAtUnixMs: resource.expiresAtUnixMs,
          ownerBound: true,
          sessionBound: true,
        },
      },
    };
  });
  return changed ? { ...result, content } : result;
}

interface InlineContent {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly inlineLimitBytes: number;
}

function inlineContent(item: CallToolResult["content"][number]): InlineContent | undefined {
  if (item.type === "text") {
    return {
      bytes: Buffer.from(item.text, "utf8"),
      mimeType: "text/plain; charset=utf-8",
      inlineLimitBytes: MAX_INLINE_TEXT_BYTES,
    };
  }
  if (item.type === "image" || item.type === "audio") {
    const bytes = strictBase64(item.data);
    return bytes === undefined
      ? undefined
      : { bytes, mimeType: item.mimeType, inlineLimitBytes: MAX_INLINE_BINARY_BYTES };
  }
  if (item.type === "resource" && "blob" in item.resource) {
    const bytes = strictBase64(item.resource.blob);
    return bytes === undefined
      ? undefined
      : {
          bytes,
          mimeType: item.resource.mimeType ?? "application/octet-stream",
          inlineLimitBytes: MAX_INLINE_BINARY_BYTES,
        };
  }
  if (item.type === "resource" && "text" in item.resource) {
    return {
      bytes: Buffer.from(item.resource.text, "utf8"),
      mimeType: item.resource.mimeType ?? "text/plain; charset=utf-8",
      inlineLimitBytes: MAX_INLINE_TEXT_BYTES,
    };
  }
  return undefined;
}

function strictBase64(value: string): Uint8Array | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return undefined;
  }
  return Buffer.from(value, "base64");
}
