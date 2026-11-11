import { describe, expect, it, vi } from "vitest";
import {
  desktopRuntimeRecoveryDelayMs,
  recoverDesktopRuntimeUntilReady,
  signalDesktopRuntimeDisconnection,
} from "../src/application/desktop-runtime-disconnection.js";

describe("Desktop runtime disconnection", () => {
  it("retires the lost connection and starts the owner's rediscovery exactly once", () => {
    const failure = new Error("Desktop app-server connection disconnected");
    const events: string[] = [];
    signalDesktopRuntimeDisconnection(failure, {
      isActive: true,
      retireResponses: async (error) => {
        expect(error).toBe(failure);
        events.push("responses");
      },
      retireConnection: async () => {
        events.push("connection");
      },
      notifyOwner: (error) => {
        expect(error).toBe(failure);
        events.push("rediscover");
      },
    });
    expect(events).toEqual(["responses", "connection", "rediscover"]);
  });

  it("does not disturb the active runtime when an inactive candidate disconnects", () => {
    const operation = vi.fn(async () => undefined);
    signalDesktopRuntimeDisconnection(new Error("shadow disconnected"), {
      isActive: false,
      retireResponses: operation,
      retireConnection: operation,
      notifyOwner: operation,
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it("still notifies the owner when one cleanup action fails", () => {
    const reportFailure = vi.fn();
    const notifyOwner = vi.fn();
    signalDesktopRuntimeDisconnection(new Error("disconnected"), {
      isActive: true,
      retireResponses: () => {
        throw new Error("cleanup failed");
      },
      retireConnection: async () => undefined,
      notifyOwner,
      reportFailure,
    });
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(notifyOwner).toHaveBeenCalledOnce();
  });

  it("keeps retry delays bounded while Desktop is unavailable", () => {
    expect([1, 2, 3, 7, 20].map(desktopRuntimeRecoveryDelayMs)).toEqual([
      500, 1_000, 2_000, 30_000, 30_000,
    ]);
    expect(() => desktopRuntimeRecoveryDelayMs(0)).toThrow("positive integer");
  });

  it("recovers after more than three failed attempts without a busy loop", async () => {
    const waits: number[] = [];
    const failures: number[] = [];
    const recover = vi.fn(async (attempt: number) => {
      if (attempt < 5) throw new Error("Desktop still starting");
    });
    await recoverDesktopRuntimeUntilReady({
      isStopping: () => false,
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
      recover,
      onFailure: async (_error, attempt) => {
        failures.push(attempt);
      },
    });
    expect(recover).toHaveBeenCalledTimes(5);
    expect(waits).toEqual([500, 1_000, 2_000, 4_000, 8_000]);
    expect(failures).toEqual([1, 2, 3, 4]);
  });
});
