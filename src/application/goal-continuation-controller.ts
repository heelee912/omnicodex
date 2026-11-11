import type { OracleGoalConversation } from "../infrastructure/chatgpt/oracle-goal-conversation.js";
import type {
  DirectGoalContinuationWork,
  DirectGoalStore,
} from "../infrastructure/mcp/direct-goal-store.js";
import { chatAccountRateLimitRetryAt } from "./chat-account-request-coordinator.js";
import { chromeFileApprovalResultSummary } from "./chrome-file-approval-result.js";
import type { ChromeGoalContinuationTarget } from "./chrome-goal-continuation.js";

/** One dispatcher for the drafts held by DirectGoalStore, not a second Goal state machine. */
export class GoalContinuationController {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #flight: Promise<void> | undefined;
  readonly #goalFlights = new Map<
    string,
    { token: string; accountSourceId?: string; promise: Promise<void> }
  >();
  readonly #attempts = new Map<string, { token: string; wakeVersion: number }>();
  #wakeVersion = 0;
  #reportingFailure: Error | undefined;
  #wakeRequested = false;
  #stopped = false;
  readonly #abort = new AbortController();
  readonly #retries = new Map<string, { failures: number; retryAt: number }>();
  readonly #inspectionOutcomes = new Map<string, string>();
  constructor(
    private readonly store: DirectGoalStore,
    private readonly operate: (
      target: ChromeGoalContinuationTarget,
      signal: AbortSignal,
    ) => Promise<unknown>,
    private readonly report: (goalId: string, outcome: string, error?: string) => Promise<void>,
    private readonly conversationIsActive?: (
      target: DirectGoalContinuationWork,
      signal: AbortSignal,
    ) => Promise<boolean>,
  ) {}

  start(): void {
    this.wake();
  }
  async observe(observations: readonly OracleGoalConversation[]): Promise<void> {
    const failures: unknown[] = [];
    let accepted = false;
    for (const observation of observations) {
      try {
        await this.store.observeConversation(observation);
        accepted = true;
      } catch (error) {
        failures.push(error);
      }
    }
    // A rejected account or conversation cannot suppress another valid event.
    // Preserve each original failure while still scheduling accepted work.
    if (accepted) this.wake();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "GOAL_OBSERVATIONS_REJECTED");
  }

  wake(): void {
    if (this.#stopped) return;
    this.#wakeVersion += 1;
    this.#schedule();
  }

  // A scan reads the local Goal store only. Host operations have independent
  // flights so a slow account cannot hold up another account's work.
  #schedule(): void {
    if (this.#stopped) return;
    if (this.#flight !== undefined) {
      this.#wakeRequested = true;
      return;
    }
    this.#wakeRequested = false;
    this.#flight = this.#run()
      .catch((error) => this.#reportFailure(error))
      .finally(() => {
        this.#flight = undefined;
        if (this.#stopped) return;
        if (this.#wakeRequested) this.#schedule();
        else if (this.#timer === undefined) {
          this.#timer = setTimeout(() => {
            this.#timer = undefined;
            this.wake();
          }, 30_000);
          this.#timer.unref();
        }
      });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#abort.abort();
    await this.#flight;
    await Promise.all([...this.#goalFlights.values()].map((flight) => flight.promise));
    if (this.#reportingFailure !== undefined) throw this.#reportingFailure;
  }

  async #reportFailure(error: unknown): Promise<void> {
    try {
      await this.report("controller", "failed", String(error));
    } catch (reportingError) {
      // Drain every flight before surfacing a failed operational log at stop.
      // No detached Promise may reject without an attached recovery path.
      this.#reportingFailure ??= new Error("GOAL_CONTINUATION_REPORT_FAILED", {
        cause: reportingError,
      });
    }
  }

  async #run(): Promise<void> {
    const pending = await this.store.pendingContinuations();
    const wakeVersion = this.#wakeVersion;
    const pendingTokens = new Set([
      ...pending.map((work) => work.draft.token),
      ...[...this.#goalFlights.values()].map((flight) => flight.token),
    ]);
    for (const token of this.#retries.keys())
      if (!pendingTokens.has(token)) this.#retries.delete(token);
    for (const token of this.#inspectionOutcomes.keys())
      if (!pendingTokens.has(token)) this.#inspectionOutcomes.delete(token);
    const pendingGoals = new Set(pending.map((work) => work.goalId));
    for (const goalId of this.#attempts.keys())
      if (!pendingGoals.has(goalId) && !this.#goalFlights.has(goalId))
        this.#attempts.delete(goalId);
    const activeAccounts = new Set(
      [...this.#goalFlights.values()].flatMap((flight) =>
        flight.accountSourceId === undefined ? [] : [flight.accountSourceId],
      ),
    );
    for (const work of pending) {
      if (this.#stopped) return;
      if (this.#goalFlights.has(work.goalId)) continue;
      // Request admission can pace HTTP calls, but the account and utility
      // renderer are also used before admission to establish the exact signed-in
      // identity. Keep that whole inspection/send transaction single-flight per
      // known account. The store orders newer work first, so an old uncertain
      // dispatch cannot race a newly selected Goal for the same browser account.
      if (work.accountSourceId !== undefined && activeAccounts.has(work.accountSourceId)) continue;
      if ((this.#retries.get(work.draft.token)?.retryAt ?? 0) > Date.now()) continue;
      const previous = this.#attempts.get(work.goalId);
      if (previous?.token === work.draft.token && previous.wakeVersion === wakeVersion) continue;
      this.#attempts.set(work.goalId, { token: work.draft.token, wakeVersion });
      const promise = this.#continue(work)
        .catch((error) => this.#reportFailure(error))
        .finally(() => {
          this.#goalFlights.delete(work.goalId);
          // Reconcile in-flight events and drafts promoted by the store.
          // An unchanged draft cannot retry itself in this wake version.
          this.#schedule();
        });
      this.#goalFlights.set(work.goalId, {
        token: work.draft.token,
        ...(work.accountSourceId === undefined ? {} : { accountSourceId: work.accountSourceId }),
        promise,
      });
      if (work.accountSourceId !== undefined) activeAccounts.add(work.accountSourceId);
    }
  }
  async #continue(work: DirectGoalContinuationWork): Promise<void> {
    try {
      // Goal recovery is low-priority background work. A live user/model turn
      // already owns the conversation and must finish before we spend another
      // account request inspecting or continuing it.
      if (await this.conversationIsActive?.(work, this.#abort.signal)) {
        this.#retries.delete(work.draft.token);
        await this.#reportInspection(work.goalId, work.draft.token, "generating");
        return;
      }
      const resumePreparedDraft = work.draft.state === "prepared";
      const inspected = chromeFileApprovalResultSummary(
        await this.operate(
          { ...work, operation: "inspect", resumePreparedDraft },
          this.#abort.signal,
        ),
      );
      // A native read may settle after shutdown even when it ignored abort.
      // Its late result must not authorize a new dispatch.
      if (this.#stopped) return;
      if (inspected.outcome === "sent" || inspected.outcome === "superseded") {
        await this.store.transitionContinuation(
          work,
          inspected.outcome === "sent" ? "sent" : "cancelled",
        );
        await this.report(work.goalId, inspected.outcome);
        this.#retries.delete(work.draft.token);
        this.#inspectionOutcomes.delete(work.draft.token);
        return;
      }
      if (work.draft.state === "dispatching" && inspected.outcome === "send_not_started") {
        await this.store.transitionContinuation(work, "ready");
        await this.report(work.goalId, inspected.outcome);
        this.#retries.delete(work.draft.token);
        this.#inspectionOutcomes.delete(work.draft.token);
        return;
      }
      if (inspected.outcome !== "ready") {
        if (inspected.error !== undefined || inspected.outcome === "native_call_failed") {
          this.#defer(work.draft.token, inspected);
          this.#inspectionOutcomes.delete(work.draft.token);
          await this.report(work.goalId, inspected.outcome, inspected.error);
        } else {
          this.#retries.delete(work.draft.token);
          await this.#reportInspection(work.goalId, work.draft.token, inspected.outcome);
        }
        return;
      }
      // A successful inspection does not mean the preceding send succeeded.
      // Preserve consecutive send rejections so 30s/60s/120s backoff survives
      // the read-before-send cycle. Terminal resolution or a new draft clears it.
      // A crash/lost response after dispatch never authorizes a second send.
      // Retry only the transcript readback until its actual outcome is known.
      if (work.draft.state === "dispatching") {
        await this.#reportInspection(work.goalId, work.draft.token, "awaiting_send_confirmation");
        return;
      }
      this.#inspectionOutcomes.delete(work.draft.token);
      if (!(await this.store.transitionContinuation(work, "dispatching"))) return;
      const dispatched = { ...work, draft: { ...work.draft, state: "dispatching" as const } };
      if (this.#stopped) {
        // The claim completed after stop but the sender was never called.
        // Preserve a proven unsent draft rather than an uncertain dispatch.
        await this.store.transitionContinuation(
          dispatched,
          resumePreparedDraft ? "prepared" : "ready",
        );
        return;
      }
      const sent = chromeFileApprovalResultSummary(
        await this.operate(
          { ...dispatched, operation: "send", resumePreparedDraft },
          this.#abort.signal,
        ),
      );
      if (sent.outcome === "sent") await this.store.transitionContinuation(dispatched, "sent");
      else if (sent.outcome === "superseded")
        await this.store.transitionContinuation(dispatched, "cancelled");
      else if (sent.outcome === "inserted_not_sent")
        await this.store.transitionContinuation(dispatched, "prepared");
      else if (
        [
          "conversation_ambiguous",
          "conversation_not_open",
          "conversation_changed",
          "anchor_not_visible",
          "draft_preserved",
          "generating",
          "not_settled",
          "runtime_not_ready",
          "rate_limited",
          "goal_binding_unverified",
          "account_binding_unverified",
          "account_changed",
          "account_source_mismatch",
          "conversation_read_only",
          "model_settings_unavailable",
          "send_rejected",
          "send_not_started",
        ].includes(sent.outcome)
      )
        await this.store.transitionContinuation(
          dispatched,
          resumePreparedDraft ? "prepared" : "ready",
        );
      if (sent.error !== undefined || sent.outcome === "native_call_failed")
        this.#defer(work.draft.token, sent);
      await this.report(work.goalId, sent.outcome, sent.error);
    } catch (error) {
      this.#defer(work.draft.token, error);
      this.#inspectionOutcomes.delete(work.draft.token);
      await this.report(work.goalId, "failed", String(error));
    }
  }

  async #reportInspection(goalId: string, token: string, outcome: string): Promise<void> {
    if (this.#inspectionOutcomes.get(token) === outcome) return;
    await this.report(goalId, outcome);
    this.#inspectionOutcomes.set(token, outcome);
  }

  #defer(token: string, failure?: unknown): void {
    const failures = (this.#retries.get(token)?.failures ?? 0) + 1;
    const now = Date.now();
    const accountRetryAt = chatAccountRateLimitRetryAt(failure, now);
    this.#retries.set(token, {
      failures,
      retryAt:
        accountRetryAt !== undefined && accountRetryAt > now
          ? accountRetryAt
          : now + Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4)),
    });
  }
}
