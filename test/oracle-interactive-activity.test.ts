import { describe, expect, it } from "vitest";

import { decideOracleInteractiveActivity } from "../src/application/oracle-interactive-activity.js";

describe("decideOracleInteractiveActivity", () => {
  it("uses the exact local task status even when an active Goal exists", () => {
    expect(decideOracleInteractiveActivity("active", "idle", true)).toBe("active");
    expect(decideOracleInteractiveActivity("idle", "active", true)).toBe("idle");
  });

  it("falls back to the observed Oracle turn when the local task is unavailable", () => {
    expect(decideOracleInteractiveActivity(undefined, "active", true)).toBe("active");
    expect(decideOracleInteractiveActivity(undefined, "idle", true)).toBe("idle");
  });

  it("probes only an unresolved active Goal conversation", () => {
    expect(decideOracleInteractiveActivity(undefined, undefined, true)).toBe("probe");
    expect(decideOracleInteractiveActivity(undefined, undefined, false)).toBe("skip");
  });
});
