import { describe, expect, it, vi } from "vitest";
import {
  OracleConversationApprovalMirror,
  OracleMirrorLifecycle,
} from "../src/application/oracle-conversation-approval-mirror.js";

const ENDPOINT = "http://127.0.0.1:29222";
const URL = "https://chatgpt.com/c/6aa09203-0b38-83e8-886b-2d486cb6dc12";
const target = {
  id: "shared",
  type: "page",
  url: `${URL}?omnicodex_oracle_mirror=omnicodex-approval-mirror-v1`,
  webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/shared",
};

describe("endpoint-scoped mirror leases", () => {
  function setup() {
    const lifecycle = new OracleMirrorLifecycle(ENDPOINT);
    const closeTarget = vi.fn(async () => {});
    const recoverTarget = vi.fn(async () => ({
      target,
      resolution: "existing" as const,
      callerOwned: true as const,
    }));
    const options = { cdpEndpoint: ENDPOINT, lifecycle, closeTarget, recoverTarget };
    return {
      options,
      closeTarget,
      first: new OracleConversationApprovalMirror(options),
      second: new OracleConversationApprovalMirror(options),
    };
  }

  it("keeps the target while another connector uses it and closes once after concurrent final releases", async () => {
    const { first, second, closeTarget } = setup();
    await Promise.all([
      first.prepareForProtectedResult(URL),
      second.prepareForProtectedResult(URL),
    ]);
    await first.releaseStableIdleOwnedTarget(target);
    expect(closeTarget).not.toHaveBeenCalled();
    expect(second.activeRunForTarget(target)?.targetId).toBe(target.id);
    await Promise.all([
      second.releaseStableIdleOwnedTarget(target),
      first.releaseStableIdleOwnedTarget(target),
    ]);
    await second.releaseStableIdleOwnedTarget(target);
    expect(closeTarget).toHaveBeenCalledTimes(1);
    expect(first.activeRunForTarget(target)).toBeUndefined();
  });

  it("re-adopts browser inventory after daemon restart without inheriting old closed tombstones", async () => {
    const { first, closeTarget } = setup();
    expect(first.activeRunForTarget(target)).toBeDefined();
    await first.releaseStableIdleOwnedTarget(target);
    const restarted = new OracleConversationApprovalMirror({
      cdpEndpoint: ENDPOINT,
      lifecycle: new OracleMirrorLifecycle(ENDPOINT),
      closeTarget,
    });
    expect(restarted.activeRunForTarget(target)).toBeDefined();
    await restarted.releaseStableIdleOwnedTarget(target);
    expect(closeTarget).toHaveBeenCalledTimes(2);
  });

  it("does not leak a new consumer lease when readiness fails", async () => {
    const { first, options, closeTarget } = setup();
    expect(first.activeRunForTarget(target)).toBeDefined();
    const failing = new OracleConversationApprovalMirror({
      ...options,
      ensureTargetReady: async () => {
        throw new Error("not ready");
      },
    });
    await expect(failing.prepareForProtectedResult(URL)).rejects.toThrow("not ready");
    await first.releaseStableIdleOwnedTarget(target);
    expect(closeTarget).toHaveBeenCalledTimes(1);
  });

  it("restores the last lease after close failure and permits retry without closing another consumer's target", async () => {
    const { first, second, closeTarget } = setup();
    first.activeRunForTarget(target);
    closeTarget.mockRejectedValueOnce(new Error("close failed"));
    await expect(first.releaseStableIdleOwnedTarget(target)).rejects.toThrow("close failed");
    expect(second.activeRunForTarget(target)).toBeDefined();
    await second.releaseStableIdleOwnedTarget(target);
    expect(closeTarget).toHaveBeenCalledTimes(1);
    await first.releaseStableIdleOwnedTarget(target);
    expect(closeTarget).toHaveBeenCalledTimes(2);
  });

  it("replaces a failed shared renderer once and fans out its new leases", async () => {
    const { first, second, closeTarget, options } = setup();
    first.activeRunForTarget(target);
    second.activeRunForTarget(target);
    const replacement = { ...target, id: "replacement" };
    options.recoverTarget.mockResolvedValue({
      target: replacement,
      resolution: "existing",
      callerOwned: true,
    });
    const [left, right] = await Promise.all([
      first.recoverUnresponsiveOwnedTarget(target),
      second.recoverUnresponsiveOwnedTarget(target),
    ]);
    expect(left).toEqual(right);
    expect(options.recoverTarget).toHaveBeenCalledTimes(1);
    expect(closeTarget).toHaveBeenCalledTimes(1);
    expect(first.activeRunForTarget(target)).toBeUndefined();
    expect(second.activeRunForTarget(target)).toBeUndefined();
    await first.releaseStableIdleOwnedTarget(replacement);
    expect(closeTarget).toHaveBeenCalledTimes(1);
    await second.releaseStableIdleOwnedTarget(replacement);
    expect(closeTarget).toHaveBeenCalledTimes(2);
  });

  it("rejects sharing a registry across different browser endpoints", () => {
    expect(
      () =>
        new OracleConversationApprovalMirror({
          cdpEndpoint: "http://127.0.0.1:29223",
          lifecycle: new OracleMirrorLifecycle(ENDPOINT),
        }),
    ).toThrow("ORACLE_APPROVAL_MIRROR_LIFECYCLE_ENDPOINT_MISMATCH");
  });
});
