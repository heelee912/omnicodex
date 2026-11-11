import { describe, expect, it, vi } from "vitest";
import {
  type OracleSettingsTargetLifecycle,
  runOracleSettingsTargetPhases,
} from "../src/application/oracle-settings-target-lifecycle.js";
import type {
  ChatGptSettingsSnapshot,
  ChatGptSettingsSurface,
} from "../src/infrastructure/chatgpt/chatgpt-app-settings-reconciler.js";

describe("Oracle settings target lifecycle", () => {
  it("reports the failed phase and preserves its original cause", async () => {
    const failure = new Error("ORACLE_SETTINGS_DEADLINE_EXCEEDED");
    const events: string[] = [];
    const result = runOracleSettingsTargetPhases({
      execute: true,
      lifecycle: fakeLifecycle(events, ["owned"]),
      reconcile: async () => "reused",
      reuseTargetForRefresh: () => true,
      refresh: async () => {
        throw failure;
      },
    });
    await expect(result).rejects.toMatchObject({
      message: "ORACLE_SETTINGS_DEADLINE_EXCEEDED [oracle_settings_phase=refresh_actions]",
      cause: failure,
    });
    expect(events.slice(-2)).toEqual(["session-close:owned", "target-close:owned"]);
  });
  it("hands off to a distinct owned target before closing the post-consent target", async () => {
    const events: string[] = [];
    const lifecycle = fakeLifecycle(events, ["reconcile-target", "refresh-target"]);

    const result = await runOracleSettingsTargetPhases({
      execute: true,
      lifecycle,
      reconcile: async (surface) => {
        events.push(`reconcile:${await targetId(surface)}`);
        return "reconciled";
      },
      refresh: async (surface) => {
        events.push(`refresh:${await targetId(surface)}`);
        return "refreshed";
      },
    });

    expect(result).toEqual({ reconcile: "reconciled", refresh: "refreshed" });
    expect(events).toEqual([
      "open:reconcile-target",
      "reconcile:reconcile-target",
      "open:refresh-target",
      "session-close:reconcile-target",
      "target-close:reconcile-target",
      "refresh:refresh-target",
      "session-close:refresh-target",
      "target-close:refresh-target",
    ]);
  });

  it("does not open a second target for a dry-run", async () => {
    const events: string[] = [];
    const lifecycle = fakeLifecycle(events, ["inspection-target"]);

    const result = await runOracleSettingsTargetPhases({
      execute: false,
      lifecycle,
      reconcile: async () => "inspected",
      refresh: async () => {
        throw new Error("refresh must not run");
      },
    });

    expect(result).toEqual({ reconcile: "inspected" });
    expect(events).toEqual([
      "open:inspection-target",
      "session-close:inspection-target",
      "target-close:inspection-target",
    ]);
  });

  it("reuses the exact target when reconciliation did not perform OAuth Connect", async () => {
    const events: string[] = [];
    const lifecycle = fakeLifecycle(events, ["shared-target"]);

    const result = await runOracleSettingsTargetPhases({
      execute: true,
      lifecycle,
      reconcile: async (surface) => {
        events.push(`reconcile:${await targetId(surface)}`);
        return { connectedNow: false };
      },
      reuseTargetForRefresh: (reconcile) => !reconcile.connectedNow,
      refresh: async (surface) => {
        events.push(`refresh:${await targetId(surface)}`);
        return "refreshed";
      },
    });

    expect(result).toEqual({ reconcile: { connectedNow: false }, refresh: "refreshed" });
    expect(events).toEqual([
      "open:shared-target",
      "reconcile:shared-target",
      "refresh:shared-target",
      "session-close:shared-target",
      "target-close:shared-target",
    ]);
  });

  it("rejects target identity reuse and closes the one acquired lease", async () => {
    const events: string[] = [];
    const lifecycle = fakeLifecycle(events, ["same-target", "same-target"]);

    await expect(
      runOracleSettingsTargetPhases({
        execute: true,
        lifecycle,
        reconcile: async () => "reconciled",
        refresh: async () => "must-not-refresh",
      }),
    ).rejects.toThrow("CHATGPT_FRESH_SETTINGS_TARGET_NOT_ACQUIRED");

    expect(events).toEqual([
      "open:same-target",
      "open:same-target",
      "session-close:same-target",
      "target-close:same-target",
      "session-close:same-target",
      "target-close:same-target",
    ]);
  });

  it("preserves the phase failure when target cleanup also fails", async () => {
    const surface = fakeSurface("target-1");
    const lifecycle: OracleSettingsTargetLifecycle = {
      open: async () => ({ targetId: "target-1", surface, closeSession: () => undefined }),
      closeTarget: async () => {
        throw new Error("cleanup failed");
      },
    };

    await expect(
      runOracleSettingsTargetPhases({
        execute: false,
        lifecycle,
        reconcile: async () => {
          throw new Error("reconcile failed");
        },
        refresh: async () => "unused",
      }),
    ).rejects.toThrow("reconcile failed");
  });

  it("shares one absolute timeout budget across open, reconcile, and refresh", async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const lifecycle = fakeLifecycle(events, ["reconcile-target", "refresh-target"]);
      const resultPromise = runOracleSettingsTargetPhases({
        execute: true,
        timeoutMs: 100,
        lifecycle,
        reconcile: async (_surface, budget) => {
          expect(budget.remainingMs()).toBe(100);
          await vi.advanceTimersByTimeAsync(70);
          return "reconciled";
        },
        refresh: async (_surface, budget) => {
          expect(budget.remainingMs()).toBe(30);
          return "refreshed";
        },
      });

      await expect(resultPromise).resolves.toEqual({
        reconcile: "reconciled",
        refresh: "refreshed",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

function fakeLifecycle(
  events: string[],
  targetIds: readonly string[],
): OracleSettingsTargetLifecycle {
  let cursor = 0;
  return {
    open: async () => {
      const targetId = targetIds[cursor++];
      if (targetId === undefined) throw new Error("no fake target available");
      events.push(`open:${targetId}`);
      return {
        targetId,
        surface: fakeSurface(targetId),
        closeSession: () => events.push(`session-close:${targetId}`),
      };
    },
    closeTarget: async (targetId) => {
      events.push(`target-close:${targetId}`);
    },
  };
}

function fakeSurface(id: string): ChatGptSettingsSurface {
  return {
    snapshot: async () =>
      ({
        targetId: id,
        route: "https://chatgpt.com/#settings/Connectors",
        domRevision: id,
        exactAppVisible: true,
        detailVisible: true,
        connectorMatched: true,
        resourceMatched: true,
        connected: true,
        fullAccess: true,
        controls: {},
      }) satisfies ChatGptSettingsSnapshot,
    activate: async () => undefined,
  };
}

async function targetId(surface: ChatGptSettingsSurface): Promise<string> {
  return (await surface.snapshot()).targetId;
}
