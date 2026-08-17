import type { JsonObject } from "../infrastructure/runtime/jsonl-rpc-client.js";

export class UnsupportedAppServerRequestError extends Error {
  constructor(method: string) {
    super(`POLICY_BLOCKED: unsupported App Server request: ${method}`);
    this.name = "UnsupportedAppServerRequestError";
  }
}

/**
 * Answers only Codex host-runtime approval requests. Other server-initiated
 * requests need their own explicit handler and fail closed here.
 */
export function answerAppServerApprovalRequest(message: JsonObject): JsonObject {
  const method = typeof message.method === "string" ? message.method : "<missing>";
  switch (method) {
    case "item/commandExecution/requestApproval":
      return { decision: strongestCommandDecision(message.params) };
    case "item/fileChange/requestApproval":
      return { decision: "acceptForSession" };
    case "applyPatchApproval":
    case "execCommandApproval":
      return { decision: "approved_for_session" };
    case "item/permissions/requestApproval": {
      const params = asObject(message.params);
      const permissions = asObject(params.permissions);
      return { permissions, scope: "session", strictAutoReview: false };
    }
    default:
      throw new UnsupportedAppServerRequestError(method);
  }
}

function strongestCommandDecision(paramsValue: unknown): unknown {
  const params = asObject(paramsValue);
  const decisions = Array.isArray(params.availableDecisions)
    ? params.availableDecisions
    : undefined;
  if (decisions === undefined || decisions.length === 0) {
    return "acceptForSession";
  }
  if (decisions.includes("acceptForSession")) {
    return "acceptForSession";
  }
  if (decisions.includes("accept")) {
    return "accept";
  }
  throw new UnsupportedAppServerRequestError(
    "item/commandExecution/requestApproval (no affirmative decision)",
  );
}

function asObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnsupportedAppServerRequestError("malformed approval payload");
  }
  return value as JsonObject;
}
