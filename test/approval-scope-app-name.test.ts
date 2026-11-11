import { describe, expect, it, vi } from "vitest";
import {
  approvalScopeNamesApp,
  conversationApprovalAppName,
  isFileMaterializationApprovalScopeText,
  ORACLE_APPROVAL_CONTROL_POINT_FUNCTION,
} from "../src/infrastructure/chatgpt/chatgpt-cdp-transport.js";

describe("approval scope registration names", () => {
  it("extracts the actual registration from conversation approval labels", () => {
    expect(conversationApprovalAppName("Allow omnicodex2 for this conversation")).toBe(
      "omnicodex2",
    );
    expect(conversationApprovalAppName("Allow Work\n tools for this conversation")).toBe(
      "Work tools",
    );
    expect(conversationApprovalAppName("Always allow")).toBeUndefined();
    expect(
      conversationApprovalAppName("Do not allow OmniCodex for this conversation"),
    ).toBeUndefined();
  });
  it("recognizes materialization independently of registration name", () => {
    for (const name of ["OmniCodex", "omnicodex2", "Work tools"]) {
      const english = `Allow file materialization? 1 file attachment returned by ${name}`;
      const korean = `파일 생성을 허용할까요? ${name}에서 반환된 1개의 파일 첨부`;
      expect(isFileMaterializationApprovalScopeText(english)).toBe(true);
      expect(isFileMaterializationApprovalScopeText(korean)).toBe(true);
      expect(approvalScopeNamesApp(english, name)).toBe(true);
      expect(approvalScopeNamesApp(korean, name)).toBe(true);
    }
    expect(isFileMaterializationApprovalScopeText("OmniCodex allow a command")).toBe(false);
  });
  it("does not confuse a registration with its numbered or prefixed sibling", () => {
    expect(approvalScopeNamesApp("omnicodex2 needs approval", "OmniCodex")).toBe(false);
    expect(approvalScopeNamesApp("OtherOmniCodex needs approval", "OmniCodex")).toBe(false);
    expect(approvalScopeNamesApp("OmniCodex needs approval", "omnicodex2")).toBe(false);
    expect(approvalScopeNamesApp("omnicodex2 needs approval", "omnicodex2")).toBe(true);
  });
  it("preserves Korean suffixes, case, and whitespace in actual card text", () => {
    expect(approvalScopeNamesApp("OmniCodex에서 반환한 파일", "omnicodex")).toBe(true);
    expect(approvalScopeNamesApp("Allow My\n App for this conversation", "My App")).toBe(true);
  });
  it("treats registration punctuation literally and rejects empty names", () => {
    expect(approvalScopeNamesApp("Tools (work)+ needs approval", "Tools (work)+")).toBe(true);
    expect(approvalScopeNamesApp("Tools work needs approval", "Tools (work)+")).toBe(false);
    expect(approvalScopeNamesApp("any card", " ")).toBe(false);
  });
  it("rechecks the bound registration immediately before clicking", () => {
    const click = vi.fn();
    const scope = { innerText: "omnicodex2 needs approval" };
    const element = {
      isConnected: true,
      closest: () => scope,
      getBoundingClientRect: () => ({ width: 50, height: 20 }),
      click,
    };
    const document = {
      querySelectorAll: () => [],
      defaultView: {
        __oracleAppApprovalWatcher: {
          owner: "omnicodex-daemon/v1",
          version: 2,
          read: () => ({ revision: "oracle-v2-1" }),
          elements: new Map([["oa-0", { element, name: "Allow" }]]),
        },
      },
    };
    const activate = new Function(
      "getComputedStyle",
      `return (${ORACLE_APPROVAL_CONTROL_POINT_FUNCTION});`,
    )(() => ({ display: "block", visibility: "visible" }));
    expect(() => activate.call(document, "oa-0", "oracle-v2-1", "OmniCodex")).toThrow(
      "approval scope changed",
    );
    expect(click).not.toHaveBeenCalled();
    expect(activate.call(document, "oa-0", "oracle-v2-1", "omnicodex2")).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
  });
});
