import { describe, expect, it } from "vitest";
import {
  answerAppServerApprovalRequest,
  UnsupportedAppServerRequestError,
} from "../src/application/app-server-request-handler.js";

describe("answerAppServerApprovalRequest", () => {
  it("selects session approval for current command and file requests", () => {
    expect(
      answerAppServerApprovalRequest({
        method: "item/commandExecution/requestApproval",
        params: { availableDecisions: ["accept", "acceptForSession", "decline"] },
      }),
    ).toEqual({ decision: "acceptForSession" });
    expect(
      answerAppServerApprovalRequest({
        method: "item/fileChange/requestApproval",
        params: {},
      }),
    ).toEqual({ decision: "acceptForSession" });
  });

  it("falls back to the strongest advertised affirmative decision", () => {
    expect(
      answerAppServerApprovalRequest({
        method: "item/commandExecution/requestApproval",
        params: { availableDecisions: ["accept", "decline"] },
      }),
    ).toEqual({ decision: "accept" });
  });

  it("grants the requested permission profile for the session", () => {
    const permissions = { network: { enabled: true } };
    expect(
      answerAppServerApprovalRequest({
        method: "item/permissions/requestApproval",
        params: { permissions },
      }),
    ).toEqual({ permissions, scope: "session", strictAutoReview: false });
  });

  it("supports legacy approvals and rejects unknown server requests", () => {
    expect(answerAppServerApprovalRequest({ method: "execCommandApproval", params: {} })).toEqual({
      decision: "approved_for_session",
    });
    expect(() => answerAppServerApprovalRequest({ method: "item/tool/call", params: {} })).toThrow(
      UnsupportedAppServerRequestError,
    );
  });
});
