import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { LegacyMutationCoordinator } from "./legacy-mutation-coordinator.js";

export const LEGACY_MUTATION_STATUS_TOOL = "codex__omnicodex__read_legacy_mutation_status";

interface StatusArguments {
  readonly operationId?: string;
  readonly request?: { readonly toolName: string; readonly arguments: Record<string, unknown> };
  readonly cursor?: string;
  readonly limit?: number;
}

/** Same trusted current-contract fingerprint as admission, without native dispatch. */
export type LegacyRequestFingerprint = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<string>;

export async function readLegacyMutationStatus(input: {
  readonly coordinator: LegacyMutationCoordinator;
  readonly authorizationBinding: string;
  readonly arguments: Record<string, unknown>;
  readonly fingerprint: LegacyRequestFingerprint;
}): Promise<CallToolResult> {
  const args = statusArguments(input.arguments);
  const semanticDigest =
    args.request === undefined
      ? undefined
      : await input.fingerprint(args.request.toolName, args.request.arguments);
  const page = await input.coordinator.readStatus({
    authorizationBinding: input.authorizationBinding,
    ...(args.operationId === undefined ? {} : { operationId: args.operationId }),
    ...(semanticDigest === undefined ? {} : { semanticDigest }),
    ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
  });
  const structuredContent = {
    schemaVersion: 1,
    outcome:
      page.matchCount === 0
        ? "not_found_or_not_owned"
        : args.request !== undefined && page.matchCount > 1
          ? "multiple_semantic_candidates"
          : "matched",
    selectionBasis:
      args.request === undefined
        ? "operation_id_only"
        : args.operationId === undefined
          ? "exact_semantics_under_current_contract"
          : "operation_id_and_exact_semantics_under_current_contract",
    originalRequestIdentity: "not_retained",
    historicalActionLink:
      args.request === undefined || page.matchCount === 0
        ? "unavailable"
        : "semantic_candidates_only",
    deliveryEvidence: "not_retained",
    nativeOutcomeInference: "none",
    replayPermittedByThisRead: false,
    ...page,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

export function legacyMutationStatusTool(toolId: string): Tool {
  return {
    name: LEGACY_MUTATION_STATUS_TOOL,
    title: "Read your existing legacy mutation status",
    description:
      "Read-only lookup of the authenticated execution owner's existing legacy cohorts. Select an operationId, or supply an original toolName and unchanged arguments to find exact semantic candidates using the current tool contract. This never executes or retries a tool. Equal semantics do not establish original transport request identity. No match also covers another owner's operation or a changed historical contract. Returns status metadata only; raw request/session IDs, arguments, tokens, stored results and delivery evidence are unavailable. UNKNOWN and ambiguity guards stay unchanged. Continue with the exact nextCursor if present.",
    inputSchema: {
      type: "object",
      properties: {
        operationId: { type: "string", pattern: "^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$" },
        request: {
          type: "object",
          properties: { toolName: { type: "string", minLength: 1 }, arguments: { type: "object" } },
          required: ["toolName", "arguments"],
          additionalProperties: false,
        },
        cursor: { type: "string", pattern: "^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
      anyOf: [{ required: ["operationId"] }, { required: ["request"] }],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    _meta: {
      omnicodex: {
        toolId,
        nativeName: "legacy-mutation/status",
        nativeNamespace: "omnicodex",
        kind: "function",
        origin: "omnicodex",
        route: "omnicodex_legacy_status",
        modelEffect: "none",
        invokesModel: false,
        stateEffect: "read",
      },
    },
  };
}

function statusArguments(raw: Record<string, unknown>): StatusArguments {
  if (Object.keys(raw).some((key) => !["operationId", "request", "cursor", "limit"].includes(key)))
    throw new TypeError("LEGACY_STATUS_ARGUMENTS_INVALID");
  const request = raw.request;
  if (
    request !== undefined &&
    (!isObject(request) ||
      Object.keys(request).some((key) => !["toolName", "arguments"].includes(key)) ||
      typeof request.toolName !== "string" ||
      request.toolName.length === 0 ||
      !isObject(request.arguments))
  )
    throw new TypeError("LEGACY_STATUS_REQUEST_INVALID");
  if (raw.operationId !== undefined && typeof raw.operationId !== "string")
    throw new TypeError("LEGACY_STATUS_OPERATION_ID_INVALID");
  if (raw.cursor !== undefined && typeof raw.cursor !== "string")
    throw new TypeError("LEGACY_STATUS_OPERATION_ID_INVALID");
  if (raw.limit !== undefined && typeof raw.limit !== "number")
    throw new TypeError("LEGACY_STATUS_LIMIT_INVALID");
  return raw as unknown as StatusArguments;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
