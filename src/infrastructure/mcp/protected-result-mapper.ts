import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OwnerBoundResourceStore } from "./owner-bound-resource-store.js";
import type { HttpAuthorizationIdentity } from "./streamable-http-gateway.js";

// This is a transport control header, never a projection of the protected
// payload. Keep it comfortably inside the MCP envelope while the exact result
// remains available through the durable handle below.
const MAX_INLINE_CONTROL_BYTES = 16 * 1024;
const COMPLETE_RESULT_MIME_TYPE =
  "application/vnd.omnicodex.mcp-call-tool-result+json; charset=utf-8";
export const PROTECTED_RESULT_READ_TOOL = "codex__omnicodex__read_protected_result";
export const PROTECTED_RESULT_HANDLE_PREFIX = "OMNICODEX_PROTECTED_RESULT_V1:";
const protectedResultInlineControl = Symbol("omnicodex.protectedResultInlineControl");

export interface ProtectedResultContext {
  readonly owner: HttpAuthorizationIdentity;
  readonly sessionId: string;
  /**
   * Server-issued durable conversation binding copied into the retrieval
   * arguments. This lets a short-lived MCP transport reconnect without
   * weakening the owner-and-work-session boundary of the stored result.
   */
  readonly retrievalSession?: {
    readonly workSessionBinding: string;
    readonly continuationToken: string;
  };
  /** Optional caller-selected retention. Omit it to retain until explicit cleanup. */
  readonly retentionMs?: number;
}

/**
 * Attach a small server-authored execution header without replacing the native
 * content or structured output. The native result remains directly visible.
 */
export function withProtectedResultInlineControl(
  result: CallToolResult,
  text: string,
): CallToolResult {
  const content =
    Buffer.byteLength(text, "utf8") <= MAX_INLINE_CONTROL_BYTES
      ? ([
          {
            type: "text" as const,
            text,
            _meta: {
              omnicodex: {
                protectedResultInlineControl: true,
              },
            },
          },
        ] satisfies CallToolResult["content"])
      : [];
  const resultWithVisibleControl =
    content.length === 0 ? result : { ...result, content: [...content, ...result.content] };
  return Object.defineProperty(resultWithVisibleControl, protectedResultInlineControl, {
    value: content,
    // Result adapters use object spread; retain this private marker across
    // those copies. Symbol keys still never enter the JSON wire payload.
    enumerable: true,
    configurable: false,
    writable: false,
  });
}

/** Normal native results remain immediate and unchanged; failures retain a durable receipt. */
export async function protectOversizedResult(
  result: CallToolResult,
  context: ProtectedResultContext,
  resources: OwnerBoundResourceStore,
): Promise<CallToolResult> {
  if (hasNativeMedia(result) || result.isError !== true) return result;
  const resultMeta = isObject(result._meta) ? result._meta : {};
  const omniCodexMeta = isObject(resultMeta.omnicodex) ? resultMeta.omnicodex : {};
  if (omniCodexMeta.protectedResult !== undefined) return result;
  try {
    const protectedResult = await persistCompleteResult(
      result,
      serializeCompleteResult(result),
      context,
      resources,
    );
    // Publish only the server-issued locator and fixed read instructions. The
    // private continuation credentials remain exclusively in _meta; retrieval
    // still resolves the authenticated caller's original work session.
    const readGuide = `${PROTECTED_RESULT_HANDLE_PREFIX}${JSON.stringify({
      schemaVersion: 1,
      resourceId: protectedResult.resourceId,
      digest: protectedResult.digest,
      retrievalTool: PROTECTED_RESULT_READ_TOOL,
      readArguments: {
        resourceId: protectedResult.resourceId,
        offset: 0,
        expectedDigest: protectedResult.digest,
      },
      reconstruction:
        "In the same approved work session, call retrievalTool with readArguments and preserve expectedDigest on every chunk. Each gateway chunk requires snapshotIntegrity=verified for the complete stored snapshot; deliveryState=partial or end_of_snapshot describes only this chunk, not completed client reconstruction. Follow nextOffset until null and concatenate chunk in order. Verify the SHA-256 base64url digest of the complete UTF-8 text against the original guide digest before JSON.parse or use. Keep the original conversation attribution on every call. If unavailable, verification is missing, or the digest differs, stop; do not repeat the original operation.",
    })}`;
    return {
      ...result,
      content: [...result.content, { type: "text", text: readGuide }],
      _meta: { ...resultMeta, omnicodex: { ...omniCodexMeta, protectedResult } },
    };
  } catch {
    return withUnavailablePersistence(result);
  }
}

/** Keep the native result intact when its optional durable copy cannot be written. */
function withUnavailablePersistence(result: CallToolResult): CallToolResult {
  const resultMeta = isObject(result._meta) ? result._meta : {};
  const omniCodexMeta = isObject(resultMeta.omnicodex) ? resultMeta.omnicodex : {};
  if (omniCodexMeta.protectedResultPersistence !== undefined) return result;
  return {
    ...result,
    _meta: {
      ...resultMeta,
      omnicodex: {
        ...omniCodexMeta,
        protectedResultPersistence: { status: "unavailable", nativeResultPreserved: true },
      },
    },
  };
}

/** Whether the native failure needs an owner-bound durable receipt. */
export function requiresProtectedResultTransport(result: CallToolResult): boolean {
  return !hasNativeMedia(result) && result.isError === true;
}

async function persistCompleteResult(
  result: CallToolResult,
  serialized: Uint8Array,
  context: ProtectedResultContext,
  resources: OwnerBoundResourceStore,
) {
  const resource = await resources.put({
    owner: context.owner,
    sessionId: context.sessionId,
    mimeType: COMPLETE_RESULT_MIME_TYPE,
    bytes: serialized,
    ...(context.retentionMs === undefined ? {} : { ttlMs: context.retentionMs }),
  });
  return {
    schemaVersion: 3,
    resourceId: resource.id,
    mimeType: resource.mimeType,
    digest: resource.digest,
    digestAlgorithm: "sha-256",
    byteLength: resource.byteLength,
    ...(resource.expiresAtUnixMs === undefined
      ? {}
      : { expiresAtUnixMs: resource.expiresAtUnixMs }),
    ownerBound: true,
    workSessionAttributed: true,
    transportSessionIndependent: true,
    retrievalTool: PROTECTED_RESULT_READ_TOOL,
    readArguments: {
      resourceId: resource.id,
      offset: 0,
      ...(context.retrievalSession === undefined
        ? {}
        : {
            _omnicodexSession: {
              workSessionBinding: context.retrievalSession.workSessionBinding,
              continuationToken: context.retrievalSession.continuationToken,
            },
          }),
    },
    reconstruction:
      "call retrievalTool with readArguments, then continue with each returned nextOffset while preserving readArguments._omnicodexSession; concatenate chunk in order and JSON.parse the complete UTF-8 text",
    retrievalPolicy:
      "required for protected text/data when the task needs the complete value; optional for typed image/audio perception and used there only when exact raw bytes or serialized result metadata were explicitly requested",
    resultPart: "callToolResult",
    complete: true,
    encoding: "utf-8",
    contentItemCount: result.content.length,
    structuredContentPresent: result.structuredContent !== undefined,
    originalIsError: result.isError === true,
  } as const;
}

/** Typed perception stays immediate; private preview metadata must not hide a text error receipt. */
function hasNativeMedia(result: CallToolResult): boolean {
  return result.content.some(isNativePerceptualContent);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNativePerceptualContent(item: CallToolResult["content"][number]): boolean {
  if (item.type === "image" || item.type === "audio") return true;
  if (item.type !== "resource") return false;
  const mimeType = item.resource.mimeType;
  return typeof mimeType === "string" && /^(image|audio|video)\//i.test(mimeType);
}

function serializeCompleteResult(result: CallToolResult): Uint8Array {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(result);
  } catch {
    throw new Error("MCP_CALL_TOOL_RESULT_SERIALIZATION_FAILED");
  }
  if (serialized === undefined) throw new Error("MCP_CALL_TOOL_RESULT_SERIALIZATION_FAILED");
  return Buffer.from(serialized, "utf8");
}
