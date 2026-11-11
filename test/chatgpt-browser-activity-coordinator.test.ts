import { describe, expect, it, vi } from "vitest";
import type { BrowserNativeCallContext } from "../src/application/browser-native-executor.js";
import {
  type BrowserConversationActivityObservation,
  ChatGptBrowserActivityCoordinator,
} from "../src/application/chatgpt-browser-activity-coordinator.js";
import { NativeExecutionScheduler } from "../src/application/native-execution-scheduler.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const context: BrowserNativeCallContext = {
  ownerBinding: "owner-a",
  workSessionBinding: "work-a",
  callerProvenance: "chatgpt_conversation",
  chatGptConversationId: A,
};

function fixture() {
  const read = vi.fn(
    async (): Promise<readonly string[] | BrowserConversationActivityObservation> => [A],
  );
  const beginActivity = vi.fn(async (_id: string, _context?: unknown) => undefined);
  const finishActivity = vi.fn(async (_id: string, _context?: unknown) => undefined);
  const coordinator = new ChatGptBrowserActivityCoordinator({
    readActiveConversationIds: read,
    observationIntervalMs: 5,
  });
  return { read, beginActivity, finishActivity, coordinator };
}

describe("ChatGptBrowserActivityCoordinator conversation lifetime", () => {
  it("does not deadlock restored Stop against CodeMode holding a lane before activity registration", async () => {
    const f = fixture();
    const scheduler = new NativeExecutionScheduler();
    const { chatGptConversationId: _id, ...opaque } = context;
    const executor = { ...f, finishCurrentActivity: vi.fn(async () => undefined) };
    const request = {
      entry: { nativeNamespace: "cua_repl", originalName: "js", source: "downstream_mcp" },
      ownerId: "owner-a",
      sessionId: "work-a",
    };
    let enter!: () => void;
    let register!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const registration = new Promise<void>((resolve) => {
      register = resolve;
    });
    const admittedCodeMode = scheduler.run(request, async () => {
      enter();
      await registration;
      await expect(f.coordinator.coordinate(executor, opaque)).rejects.toThrow(
        "BROWSER_ACTIVITY_RETIRING",
      );
    });
    await entered;
    const stop = f.coordinator.finishCurrentActivity(executor, opaque, (cleanup) =>
      scheduler.run(
        {
          ...request,
          entry: { ...request.entry, originalName: "turn_ended" },
        },
        cleanup,
      ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    register();
    await Promise.all([admittedCodeMode, stop]);
    expect(executor.finishCurrentActivity).toHaveBeenCalledOnce();
    await f.coordinator.close();
    await scheduler.shutdown();
  });

  it("drains the stopped owner before scheduling cleanup and rejects new admission", async () => {
    const f = fixture();
    const { chatGptConversationId: _id, ...opaque } = context;
    let settle!: () => void;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const pending = f.coordinator.runWithActivity(f, opaque, async () => {
      enter();
      await new Promise<void>((resolve) => {
        settle = resolve;
      });
    });
    await entered;
    const other = await f.coordinator.coordinate(f, { ...opaque, ownerBinding: "other" });
    const schedule = vi.fn(async (cleanup: () => Promise<void>) => cleanup());
    const stop = f.coordinator.finishCurrentActivity(f, opaque, schedule);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(schedule).not.toHaveBeenCalled();
    await expect(f.coordinator.coordinate(f, opaque)).rejects.toThrow("BROWSER_ACTIVITY_RETIRING");
    expect(f.finishActivity).not.toHaveBeenCalled();
    settle();
    await pending;
    await stop;
    expect(schedule).toHaveBeenCalledOnce();
    expect(f.finishActivity).toHaveBeenCalledOnce();
    expect(f.finishActivity.mock.calls[0]?.[0]).not.toBe(other.activityBinding);
    const next = await f.coordinator.coordinate(f, opaque);
    expect(next.activityBinding).not.toBe(f.finishActivity.mock.calls[0]?.[0]);
    await f.coordinator.close({ preserveActivities: true });
  });

  it("serializes restored Stop ahead of a new activity and retains failed cleanup for retry", async () => {
    const f = fixture();
    const { chatGptConversationId: _id, ...opaque } = context;
    let release!: () => void;
    const restored = {
      ...f,
      finishCurrentActivity: vi.fn(
        async () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const stop = f.coordinator.finishCurrentActivity(restored, opaque);
    await vi.waitFor(() => expect(restored.finishCurrentActivity).toHaveBeenCalledOnce());
    await expect(f.coordinator.coordinate(restored, opaque)).rejects.toThrow(
      "BROWSER_ACTIVITY_RETIRING",
    );
    expect(f.beginActivity).not.toHaveBeenCalled();
    release();
    await stop;
    const activity = await f.coordinator.coordinate(restored, opaque);
    f.finishActivity.mockRejectedValueOnce(new Error("cleanup unavailable"));
    await expect(f.coordinator.finishCurrentActivity(restored, opaque)).rejects.toThrow(
      "cleanup unavailable",
    );
    await expect(f.coordinator.coordinate(restored, opaque)).rejects.toThrow(
      "BROWSER_ACTIVITY_RETIRING",
    );
    await f.coordinator.finishCurrentActivity(restored, opaque);
    expect(f.finishActivity).toHaveBeenNthCalledWith(
      2,
      activity.activityBinding,
      expect.anything(),
    );
    await f.coordinator.close();
  });

  it("keeps the same native activity while active and across transport reconnections", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const first = await f.coordinator.coordinate(f, {
        ...context,
        callerActivityBinding: "trace:first",
        callerActivityBindingKind: "transport_trace",
      });
      await vi.advanceTimersByTimeAsync(10);
      await f.coordinator.observeActivityBoundary({
        ...context,
        callerActivityBinding: "trace:next",
        callerActivityBindingKind: "transport_trace",
      });
      const nextExecutor = {
        beginActivity: vi.fn(async () => undefined),
        finishActivity: vi.fn(async () => undefined),
      };
      const next = await f.coordinator.coordinate(nextExecutor, {
        ...context,
        callerActivityBinding: "trace:next",
        callerActivityBindingKind: "transport_trace",
      });
      expect(next.activityBinding).toBe(first.activityBinding);
      expect(next.continueExistingActivity).toBe(true);
      expect(nextExecutor.beginActivity).toHaveBeenCalledWith(
        first.activityBinding,
        expect.objectContaining({ continueExistingActivity: true }),
      );
      expect(f.finishActivity).not.toHaveBeenCalled();
      expect(f.read).toHaveBeenCalledTimes(2);
      await f.coordinator.close();
      expect(nextExecutor.finishActivity).toHaveBeenCalledOnce();
      expect(f.finishActivity).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes after two exact idle observations and stops polling until another activity", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const first = await f.coordinator.coordinate(f, context);
      f.read.mockResolvedValue([]);
      await vi.advanceTimersByTimeAsync(5);
      expect(f.finishActivity).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5);
      expect(f.finishActivity).toHaveBeenCalledWith(first.activityBinding, expect.anything());
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.read).toHaveBeenCalledTimes(2);
      const next = await f.coordinator.coordinate(f, context);
      expect(next.activityBinding).not.toBe(first.activityBinding);
      await f.coordinator.close({ preserveActivities: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves unknown tasks and backs off failed observations without overlapping reads", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.coordinator.coordinate(f, context);
      f.read.mockRejectedValueOnce(new Error("status unavailable"));
      f.read.mockResolvedValue({ activeConversationIds: [], unknownConversationIds: [A] });
      await vi.advanceTimersByTimeAsync(5);
      expect(f.read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(9);
      expect(f.read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.read).toHaveBeenCalledTimes(2);
      expect(f.finishActivity).not.toHaveBeenCalled();
      let resolve!: (ids: readonly string[]) => void;
      f.read.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(f.read).toHaveBeenCalledTimes(3);
      resolve([A]);
      await vi.advanceTimersByTimeAsync(0);
      await f.coordinator.close({ preserveActivities: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retire a queued or executing browser call and clears its reservation after failure", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      f.read.mockResolvedValue([]);
      let reject!: (error: Error) => void;
      let started!: () => void;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      const call = f.coordinator.runWithActivity(f, context, async (coordinated) => {
        expect(coordinated.chatGptConversationId).toBeUndefined();
        started();
        return new Promise<void>((_resolve, fail) => {
          reject = fail;
        });
      });
      const failed = expect(call).rejects.toThrow("caller cancelled");
      await startedPromise;
      await vi.advanceTimersByTimeAsync(50);
      expect(f.read).not.toHaveBeenCalled();
      expect(f.finishActivity).not.toHaveBeenCalled();
      reject(new Error("caller cancelled"));
      await failed;
      await vi.advanceTimersByTimeAsync(10);
      expect(f.finishActivity).toHaveBeenCalledOnce();
      await f.coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a stale idle result when another browser call starts during observation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.coordinator.coordinate(f, context);
      f.read.mockResolvedValue([]);
      await vi.advanceTimersByTimeAsync(5);
      let resolve!: (ids: readonly string[]) => void;
      f.read.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      await vi.advanceTimersByTimeAsync(5);
      await f.coordinator.runWithActivity(f, context, async () => undefined);
      resolve([]);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.finishActivity).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5);
      expect(f.finishActivity).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5);
      expect(f.finishActivity).toHaveBeenCalledOnce();
      await f.coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never sends a different activity id to beginActivity on a subsequent reply", async () => {
    const f = fixture();
    let current: string | undefined;
    const syntheticCompleted: string[] = [];
    const nativeLifecycle = {
      beginActivity: async (id: string) => {
        // BrowserNativeExecutor retires a previous activity when its id changes.
        if (current !== undefined && current !== id) syntheticCompleted.push(current);
        current = id;
      },
      finishActivity: async (id: string) => {
        syntheticCompleted.push(id);
      },
    };
    const first = await f.coordinator.coordinate(nativeLifecycle, context);
    for (const trace of ["response-2", "response-3"]) {
      await f.coordinator.observeActivityBoundary(context);
      const next = await f.coordinator.coordinate(nativeLifecycle, {
        ...context,
        callerActivityBinding: trace,
        callerActivityBindingKind: "transport_trace",
      });
      expect(next.activityBinding).toBe(first.activityBinding);
    }
    expect(syntheticCompleted).toEqual([]);
    await f.coordinator.close({ preserveActivities: true });
    expect(syntheticCompleted).toEqual([]);
  });

  it("adopts exact attribution on an opaque session without replacing its native activity", async () => {
    const f = fixture();
    const { chatGptConversationId: _id, ...opaque } = context;
    const first = await f.coordinator.coordinate(f, opaque);
    const next = await f.coordinator.coordinate(f, context);
    expect(next.activityBinding).toBe(first.activityBinding);
    expect(next.chatGptConversationId).toBeUndefined();
    expect(f.finishActivity).not.toHaveBeenCalled();
    await f.coordinator.close();
  });

  it("learns exact attribution from a later non-browser call so an opaque CUA activity can retire", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const { chatGptConversationId: _id, ...opaque } = context;
      const first = await f.coordinator.coordinate(f, opaque);
      f.read.mockResolvedValue([]);
      await vi.advanceTimersByTimeAsync(30);
      expect(f.read).not.toHaveBeenCalled();
      await f.coordinator.observeActivityBoundary(context);
      await vi.advanceTimersByTimeAsync(10);
      expect(f.finishActivity).toHaveBeenCalledWith(first.activityBinding, expect.anything());
      await f.coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps owners and work sessions isolated", async () => {
    const f = fixture();
    const contexts = [
      context,
      { ...context, ownerBinding: "owner-b" },
      { ...context, workSessionBinding: "work-b", chatGptConversationId: B },
    ];
    const activities = await Promise.all(contexts.map((c) => f.coordinator.coordinate(f, c)));
    expect(new Set(activities.map((c) => c.activityBinding)).size).toBe(3);
    await f.coordinator.close();
    expect(f.finishActivity).toHaveBeenCalledTimes(3);
  });

  it("rejects a conflicting exact conversation in the same authenticated work session", async () => {
    const f = fixture();
    await f.coordinator.coordinate(f, context);
    await expect(
      f.coordinator.coordinate(f, { ...context, chatGptConversationId: B }),
    ).rejects.toThrow("identity conflicts");
    expect(f.beginActivity).toHaveBeenCalledOnce();
    await f.coordinator.close();
  });

  it("does not coordinate a generic caller or infer its session from request traces", async () => {
    const f = fixture();
    const generic = {
      callerActivityBinding: "trace",
      callerActivityBindingKind: "transport_trace" as const,
    };
    expect(await f.coordinator.coordinate(f, generic)).toEqual(generic);
    expect(f.beginActivity).not.toHaveBeenCalled();
    await f.coordinator.close();
    expect(f.finishActivity).not.toHaveBeenCalled();
  });

  it("serializes concurrent adoption of the same conversation", async () => {
    const f = fixture();
    const replies = await Promise.all(
      Array.from({ length: 3 }, () => f.coordinator.coordinate(f, context)),
    );
    expect(new Set(replies.map((c) => c.activityBinding)).size).toBe(1);
    await f.coordinator.close();
    expect(f.finishActivity).toHaveBeenCalledOnce();
  });

  it("keeps the original lifecycle handle if native adoption fails", async () => {
    const f = fixture();
    const first = await f.coordinator.coordinate(f, context);
    const failedExecutor = {
      beginActivity: vi.fn(async () => {
        throw new Error("native adoption failed");
      }),
      finishActivity: vi.fn(async () => undefined),
    };
    await expect(f.coordinator.coordinate(failedExecutor, context)).rejects.toThrow(
      "native adoption failed",
    );
    expect(f.finishActivity).not.toHaveBeenCalled();
    await f.coordinator.close();
    expect(f.finishActivity).toHaveBeenCalledWith(first.activityBinding, expect.anything());
    expect(failedExecutor.finishActivity).not.toHaveBeenCalled();
  });

  it("preserves native activities when the service observer is replaced", async () => {
    const f = fixture();
    await f.coordinator.coordinate(f, context);
    await f.coordinator.close({ preserveActivities: true });
    expect(f.finishActivity).not.toHaveBeenCalled();
    await expect(f.coordinator.coordinate(f, context)).rejects.toThrow("coordinator is closed");
  });

  it("waits for adoption before actual shutdown and finishes through the adopted executor", async () => {
    const f = fixture();
    await f.coordinator.coordinate(f, context);
    let resolveAdoption!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveAdoption = resolve;
    });
    const replacement = {
      beginActivity: vi.fn(async () => pending),
      finishActivity: vi.fn(async () => undefined),
    };
    const adoption = f.coordinator.coordinate(replacement, context);
    await vi.waitFor(() => expect(replacement.beginActivity).toHaveBeenCalledOnce());
    const closing = f.coordinator.close();
    expect(f.finishActivity).not.toHaveBeenCalled();
    resolveAdoption();
    await adoption;
    await closing;
    expect(replacement.finishActivity).toHaveBeenCalledOnce();
  });

  it("retains a failed actual-shutdown cleanup for an explicit retry", async () => {
    const f = fixture();
    f.finishActivity.mockRejectedValueOnce(new Error("native cleanup failed"));
    await f.coordinator.coordinate(f, context);
    await expect(f.coordinator.close()).rejects.toThrow("cleanup remains pending");
    await f.coordinator.close();
    expect(f.finishActivity).toHaveBeenCalledTimes(2);
  });

  it("waits for an admitted browser call to settle before actual shutdown releases its tabs", async () => {
    const f = fixture();
    let finishCall!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const call = f.coordinator.runWithActivity(f, context, async () => {
      started();
      await new Promise<void>((resolve) => {
        finishCall = resolve;
      });
    });
    await entered;
    const closing = f.coordinator.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.finishActivity).not.toHaveBeenCalled();
    finishCall();
    await call;
    await closing;
    expect(f.finishActivity).toHaveBeenCalledOnce();
  });
});
