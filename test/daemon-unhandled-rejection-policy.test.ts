import { describe, expect, it } from "vitest";
import { isExpectedCancellationRejection } from "../src/application/daemon-unhandled-rejection-policy.js";

describe("daemon unhandled rejection policy", () => {
  it("keeps platform cancellation request-scoped", () => {
    expect(
      isExpectedCancellationRejection(
        Object.assign(new Error("cancelled"), { name: "AbortError" }),
      ),
    ).toBe(true);
    expect(
      isExpectedCancellationRejection(Object.assign(new Error("cancelled"), { code: "ABORT_ERR" })),
    ).toBe(true);
    expect(
      isExpectedCancellationRejection(
        Object.assign(new Error("transport cleanup failed"), {
          cause: Object.assign(new Error("cancelled"), { name: "AbortError" }),
        }),
      ),
    ).toBe(true);
  });

  it("does not downgrade real faults by message or shape", () => {
    expect(isExpectedCancellationRejection(new Error("This operation was aborted"))).toBe(false);
    expect(isExpectedCancellationRejection("AbortError")).toBe(false);
    expect(isExpectedCancellationRejection({ name: "TypeError", code: "EPIPE" })).toBe(false);
  });

  it("terminates bounded or cyclic cause traversal", () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(isExpectedCancellationRejection(cyclic)).toBe(false);
  });
});
