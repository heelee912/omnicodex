import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { omniCodexDataDirectory } from "../config/omnicodex-config-store.js";
import { canonicalJson } from "../safety/canonical-json.js";

const SCHEMA_VERSION = 1;

export type DirectScheduleStatus = "active" | "paused" | "deleted";
export type DirectScheduleRunStatus =
  | "pending"
  | "claimed"
  | "dispatched"
  | "retry_wait"
  | "succeeded"
  | "failed"
  | "outcome_unknown"
  | "cancelled"
  | "misfired";

export interface DirectScheduleScope {
  /** Server-derived authorization identity. The remote model never supplies this. */
  readonly authorizationBinding: string;
  /** Server-derived durable conversation/sub-owner identity. */
  readonly conversationId: string;
  /** Server-derived durable work-session identity. */
  readonly workSessionId: string;
}

export interface DirectScheduleRetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly multiplier: number;
  readonly maxDelayMs: number;
}

export interface DirectScheduleMisfirePolicy {
  readonly mode: "fire_once" | "skip" | "catch_up";
  readonly graceMs: number;
  /** Caller-selected retention for missed occurrences. Omitted means catch up every occurrence. */
  readonly maxCatchUp?: number;
}

export interface DirectScheduleCreateInput extends DirectScheduleScope {
  readonly idempotencyKey: string;
  readonly timezone: string;
  readonly rrule: string;
  readonly startAtUnixMs?: number;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly retry?: Partial<DirectScheduleRetryPolicy>;
  readonly misfire?: Partial<DirectScheduleMisfirePolicy>;
}

export interface DirectScheduleAccessInput extends DirectScheduleScope {
  readonly scheduleId: string;
}

export interface DirectScheduleListInput extends DirectScheduleScope {
  readonly statuses?: readonly DirectScheduleStatus[];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface DirectScheduleRunsInput extends DirectScheduleAccessInput {
  readonly statuses?: readonly DirectScheduleRunStatus[];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface DirectScheduleTriggerInput extends DirectScheduleAccessInput {
  readonly idempotencyKey: string;
}

export interface DirectScheduleView {
  readonly scheduleId: string;
  readonly status: DirectScheduleStatus;
  readonly timezone: string;
  readonly rrule: string;
  readonly toolName: string;
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
  readonly nextRunAtUnixMs?: number;
  readonly retry: DirectScheduleRetryPolicy;
  readonly misfire: DirectScheduleMisfirePolicy;
}

export interface DirectScheduleRunView {
  readonly runId: string;
  readonly scheduleId: string;
  readonly scheduledForUnixMs: number;
  readonly status: DirectScheduleRunStatus;
  readonly attempt: number;
  readonly source: "schedule" | "manual";
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
  readonly nextAttemptAtUnixMs?: number;
  readonly jobId?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface DirectScheduleClaim {
  readonly claimToken: string;
  readonly schedule: DirectScheduleView;
  readonly run: DirectScheduleRunView;
  readonly arguments: Record<string, unknown>;
  /** Stable HMAC pseudonyms used to scope the DirectJob created after reboot. */
  readonly executionScope: DirectScheduleScope;
}

export interface DirectScheduleStoreOptions {
  readonly dataDirectory?: string;
  readonly snapshotPath?: string;
  /** Stable secret bytes from the server credential store; minimum 32 bytes. */
  readonly integrityKey: Uint8Array;
  readonly maxSchedules?: number;
  readonly maxRuns?: number;
  readonly claimLeaseMs?: number;
  readonly nowUnixMs?: () => number;
  readonly randomUUID?: () => string;
}

export interface InMemoryDirectScheduleStoreOptions
  extends Omit<DirectScheduleStoreOptions, "dataDirectory" | "snapshotPath" | "integrityKey"> {
  readonly integrityKey?: Uint8Array;
}

interface ScopeDigests {
  readonly ownerDigest: string;
  readonly conversationDigest: string;
  readonly workSessionDigest: string;
}

interface StoredSchedule extends ScopeDigests {
  readonly sealedExecutionScope?: string;
  readonly scheduleId: string;
  readonly idempotencyDigest: string;
  readonly fingerprintDigest: string;
  readonly status: DirectScheduleStatus;
  readonly timezone: string;
  readonly rrule: string;
  readonly parsedRule: ParsedRule;
  readonly anchorUnixMs: number;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly retry: DirectScheduleRetryPolicy;
  readonly misfire: DirectScheduleMisfirePolicy;
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
  readonly nextRunAtUnixMs?: number;
}

interface StoredRun {
  readonly runId: string;
  readonly scheduleId: string;
  readonly scheduledForUnixMs: number;
  readonly status: DirectScheduleRunStatus;
  readonly attempt: number;
  readonly source: "schedule" | "manual";
  readonly triggerDigest?: string;
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
  readonly nextAttemptAtUnixMs?: number;
  readonly claimDigest?: string;
  readonly claimExpiresAtUnixMs?: number;
  readonly jobId?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

type ParsedRule =
  | { readonly frequency: "MINUTELY"; readonly interval: number }
  | {
      readonly frequency: "DAILY";
      readonly interval: number;
      readonly byHour: number;
      readonly byMinute: number;
    };

interface SnapshotPayload {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly revision: number;
  readonly schedules: readonly StoredSchedule[];
  readonly runs: readonly StoredRun[];
}

interface StoredSnapshot extends SnapshotPayload {
  readonly mac: string;
}

interface Configuration {
  readonly snapshotPath?: string;
  readonly key: Buffer;
  readonly maxSchedules: number | undefined;
  readonly maxRuns: number | undefined;
  readonly claimLeaseMs: number;
  readonly nowUnixMs: () => number;
  readonly randomUUID: () => string;
}

/**
 * Durable exact-native schedule ledger. Supported RRULE grammar is deliberately
 * small and unambiguous:
 * - FREQ=MINUTELY;INTERVAL=<positive safe integer>
 * - FREQ=DAILY;INTERVAL=<positive safe integer>;BYHOUR=0..23;BYMINUTE=0..59
 * DTSTART, COUNT, UNTIL, BYSECOND and every other RRULE field are rejected.
 */
export class DirectScheduleStore {
  readonly #configuration: Configuration;
  #revision: number;
  #schedules: Map<string, StoredSchedule>;
  #runs: Map<string, StoredRun>;
  #tail: Promise<void> = Promise.resolve();
  #claimRoundRobinCursor = 0;

  private constructor(
    configuration: Configuration,
    revision = 0,
    schedules = new Map<string, StoredSchedule>(),
    runs = new Map<string, StoredRun>(),
  ) {
    this.#configuration = configuration;
    this.#revision = revision;
    this.#schedules = schedules;
    this.#runs = runs;
  }

  static async open(options: DirectScheduleStoreOptions): Promise<DirectScheduleStore> {
    const configuration = durableConfiguration(options);
    const loaded = await loadSnapshot(configuration);
    return new DirectScheduleStore(configuration, loaded.revision, loaded.schedules, loaded.runs);
  }

  static inMemory(options: InMemoryDirectScheduleStoreOptions = {}): DirectScheduleStore {
    return new DirectScheduleStore(memoryConfiguration(options));
  }

  get snapshotPath(): string | undefined {
    return this.#configuration.snapshotPath;
  }

  create(
    input: DirectScheduleCreateInput,
  ): Promise<{ disposition: "created" | "existing"; schedule: DirectScheduleView }> {
    return this.#serialized(async () => {
      const normalized = normalizeCreate(input, this.#configuration.nowUnixMs());
      const scope = this.#scopeDigests(normalized);
      const idempotencyDigest = this.#digest(`idempotency\0${normalized.idempotencyKey}`);
      const identity = this.#digest(
        canonicalJson({ contract: "direct-schedule-id-v1", ...scope, idempotencyDigest }),
      );
      const scheduleId = uuidFromDigest(identity);
      const current = this.#schedules.get(scheduleId);
      // An omitted startAt is bound once at creation. Replaying an ambiguous
      // create after time advanced must still return the same schedule.
      const fingerprintAnchor =
        current !== undefined && input.startAtUnixMs === undefined
          ? current.anchorUnixMs
          : normalized.anchorUnixMs;
      const fingerprintDigest = this.#digest(
        canonicalJson({
          contract: "direct-schedule-v1",
          timezone: normalized.timezone,
          rrule: normalized.rrule,
          anchorUnixMs: fingerprintAnchor,
          toolName: normalized.toolName,
          arguments: normalized.arguments,
          retry: normalized.retry,
          misfire: normalized.misfire,
        }),
      );
      if (current !== undefined) {
        this.#assertScope(current, scope);
        if (current.fingerprintDigest !== fingerprintDigest) {
          throw new Error("DIRECT_SCHEDULE_IDEMPOTENCY_CONFLICT");
        }
        return { disposition: "existing", schedule: publicSchedule(current) };
      }
      if (
        this.#configuration.maxSchedules !== undefined &&
        this.#schedules.size >= this.#configuration.maxSchedules
      ) {
        throw new Error("DIRECT_SCHEDULE_CAPACITY_EXCEEDED");
      }
      const timestamp = this.#now();
      const schedule: StoredSchedule = {
        scheduleId,
        ...scope,
        sealedExecutionScope: this.#sealExecutionScope(scheduleId, normalized),
        idempotencyDigest,
        fingerprintDigest,
        status: "active",
        timezone: normalized.timezone,
        rrule: normalized.rrule,
        parsedRule: normalized.parsedRule,
        anchorUnixMs: normalized.anchorUnixMs,
        toolName: normalized.toolName,
        arguments: normalized.arguments,
        retry: normalized.retry,
        misfire: normalized.misfire,
        createdAtUnixMs: timestamp,
        updatedAtUnixMs: timestamp,
        nextRunAtUnixMs: firstOccurrence(
          normalized.parsedRule,
          normalized.anchorUnixMs,
          normalized.timezone,
        ),
      };
      const schedules = new Map(this.#schedules).set(scheduleId, schedule);
      await this.#commit(schedules, this.#runs);
      return { disposition: "created", schedule: publicSchedule(schedule) };
    });
  }

  get(input: DirectScheduleAccessInput): Promise<DirectScheduleView | undefined> {
    return this.#serialized(async () => {
      const schedule = this.#schedules.get(requiredUuid(input.scheduleId, "scheduleId"));
      if (schedule === undefined || !this.#scopeMatches(schedule, input)) return undefined;
      return publicSchedule(schedule);
    });
  }

  list(
    input: DirectScheduleListInput,
  ): Promise<{ schedules: readonly DirectScheduleView[]; nextCursor?: string }> {
    return this.#serialized(async () => {
      const scope = this.#scopeDigests(input);
      const statuses =
        input.statuses === undefined
          ? new Set<DirectScheduleStatus>(["active", "paused"])
          : new Set(input.statuses.map(requiredScheduleStatus));
      const rows = [...this.#schedules.values()]
        .filter((item) => sameScope(item, scope) && statuses.has(item.status))
        .sort(
          (a, b) =>
            b.createdAtUnixMs - a.createdAtUnixMs || b.scheduleId.localeCompare(a.scheduleId, "en"),
        );
      const start = cursorStart(rows, input.cursor, (item) => item.scheduleId);
      const limit = requiredLimit(input.limit);
      const page = limit === undefined ? rows.slice(start) : rows.slice(start, start + limit);
      return {
        schedules: page.map(publicSchedule),
        ...(start + page.length < rows.length && page.at(-1) !== undefined
          ? { nextCursor: encodeCursor(page.at(-1)?.scheduleId ?? "") }
          : {}),
      };
    });
  }

  pause(input: DirectScheduleAccessInput): Promise<DirectScheduleView> {
    return this.#changeStatus(input, "paused");
  }

  resume(input: DirectScheduleAccessInput): Promise<DirectScheduleView> {
    return this.#serialized(async () => {
      const current = this.#requiredScoped(input);
      if (current.status === "deleted") throw new Error("DIRECT_SCHEDULE_DELETED");
      if (current.status === "active") return publicSchedule(current);
      const now = this.#now();
      const updated: StoredSchedule = {
        ...current,
        status: "active",
        updatedAtUnixMs: now,
        nextRunAtUnixMs: firstAfter(
          current.parsedRule,
          current.anchorUnixMs,
          current.timezone,
          now,
        ),
      };
      await this.#commit(new Map(this.#schedules).set(current.scheduleId, updated), this.#runs);
      return publicSchedule(updated);
    });
  }

  delete(input: DirectScheduleAccessInput): Promise<DirectScheduleView> {
    return this.#changeStatus(input, "deleted");
  }

  trigger(
    input: DirectScheduleTriggerInput,
  ): Promise<{ disposition: "created" | "existing"; run: DirectScheduleRunView }> {
    return this.#serialized(async () => {
      const schedule = this.#requiredScoped(input);
      if (schedule.status === "deleted") throw new Error("DIRECT_SCHEDULE_DELETED");
      const triggerDigest = this.#digest(
        `trigger\0${requiredIdentifier(input.idempotencyKey, "idempotencyKey", 128, 16)}`,
      );
      const existing = [...this.#runs.values()].find(
        (run) => run.scheduleId === schedule.scheduleId && run.triggerDigest === triggerDigest,
      );
      if (existing !== undefined) return { disposition: "existing", run: publicRun(existing) };
      let scheduledForUnixMs = this.#now();
      while (this.#runAt(schedule.scheduleId, scheduledForUnixMs) !== undefined)
        scheduledForUnixMs += 1;
      const run = this.#newRun(schedule, scheduledForUnixMs, "manual", triggerDigest);
      await this.#commit(this.#schedules, this.#withRun(run));
      return { disposition: "created", run: publicRun(run) };
    });
  }

  runs(
    input: DirectScheduleRunsInput,
  ): Promise<{ runs: readonly DirectScheduleRunView[]; nextCursor?: string }> {
    return this.#serialized(async () => {
      const schedule = this.#requiredScoped(input);
      const statuses =
        input.statuses === undefined ? undefined : new Set(input.statuses.map(requiredRunStatus));
      const rows = [...this.#runs.values()]
        .filter(
          (run) => run.scheduleId === schedule.scheduleId && (statuses?.has(run.status) ?? true),
        )
        .sort(
          (a, b) =>
            b.scheduledForUnixMs - a.scheduledForUnixMs || b.runId.localeCompare(a.runId, "en"),
        );
      const start = cursorStart(rows, input.cursor, (item) => item.runId);
      const limit = requiredLimit(input.limit);
      const page = limit === undefined ? rows.slice(start) : rows.slice(start, start + limit);
      return {
        runs: page.map(publicRun),
        ...(start + page.length < rows.length && page.at(-1) !== undefined
          ? { nextCursor: encodeCursor(page.at(-1)?.runId ?? "") }
          : {}),
      };
    });
  }

  /** Materialize due occurrences and exclusively claim ready runs. */
  claimDue(nowUnixMs = this.#now(), limit?: number): Promise<readonly DirectScheduleClaim[]> {
    return this.#serialized(async () => {
      checkedTimestamp(nowUnixMs, "nowUnixMs");
      const claimLimit = requiredLimit(limit) ?? Number.POSITIVE_INFINITY;
      const schedules = new Map(this.#schedules);
      const runs = new Map(this.#runs);
      const runOccurrences = new Set(
        [...runs.values()].map((run) => runOccurrenceKey(run.scheduleId, run.scheduledForUnixMs)),
      );
      const dueOrder = roundRobinRows(
        [...schedules.values()].filter(
          (schedule) =>
            schedule.status === "active" &&
            schedule.nextRunAtUnixMs !== undefined &&
            schedule.nextRunAtUnixMs <= nowUnixMs,
        ),
        (schedule) => schedule.ownerDigest,
        (a, b) =>
          (a.nextRunAtUnixMs ?? Number.MAX_SAFE_INTEGER) -
            (b.nextRunAtUnixMs ?? Number.MAX_SAFE_INTEGER) ||
          a.scheduleId.localeCompare(b.scheduleId, "en"),
        this.#claimRoundRobinCursor,
      );
      let materializedCount = 0;
      let nonTerminalCapacity =
        this.#configuration.maxRuns === undefined
          ? Number.POSITIVE_INFINITY
          : this.#configuration.maxRuns -
            [...runs.values()].filter((run) => !isRunTerminal(run.status)).length;
      let passMadeProgress = true;
      while (materializedCount < claimLimit && passMadeProgress) {
        passMadeProgress = false;
        for (const orderedSchedule of dueOrder.rows) {
          if (materializedCount >= claimLimit) break;
          const schedule = schedules.get(orderedSchedule.scheduleId);
          if (
            schedule === undefined ||
            schedule.status !== "active" ||
            schedule.nextRunAtUnixMs === undefined ||
            schedule.nextRunAtUnixMs > nowUnixMs
          )
            continue;
          try {
            const materialized = materializeDue(schedule, nowUnixMs, (scheduledFor) =>
              this.#newRun(schedule, scheduledFor, "schedule"),
            );
            const missing = materialized.runs.find(
              (run) =>
                !runOccurrences.has(runOccurrenceKey(run.scheduleId, run.scheduledForUnixMs)),
            );
            if (
              missing !== undefined &&
              (isRunTerminal(missing.status) || nonTerminalCapacity > 0)
            ) {
              runs.set(missing.runId, missing);
              runOccurrences.add(runOccurrenceKey(missing.scheduleId, missing.scheduledForUnixMs));
              materializedCount += 1;
              passMadeProgress = true;
              if (!isRunTerminal(missing.status)) nonTerminalCapacity -= 1;
            }
            const fullyMaterialized = materialized.runs.every((run) =>
              runOccurrences.has(runOccurrenceKey(run.scheduleId, run.scheduledForUnixMs)),
            );
            if (fullyMaterialized) {
              schedules.set(schedule.scheduleId, materialized.schedule);
              passMadeProgress = true;
            }
          } catch (error) {
            // One malformed or out-of-range schedule must not block every owner
            // sharing the daemon. Quarantine it durably and continue the scan.
            const { nextRunAtUnixMs: dueAt, ...rest } = schedule;
            schedules.set(schedule.scheduleId, {
              ...rest,
              status: "paused",
              updatedAtUnixMs: nowUnixMs,
            });
            if (
              dueAt !== undefined &&
              !runOccurrences.has(runOccurrenceKey(schedule.scheduleId, dueAt))
            ) {
              const quarantined = this.#newRun(schedule, dueAt, "schedule");
              runs.set(quarantined.runId, {
                ...quarantined,
                status: "misfired",
                error: {
                  code: "DIRECT_SCHEDULE_CALCULATION_QUARANTINED",
                  message: errorMessage(error),
                },
              });
              runOccurrences.add(runOccurrenceKey(schedule.scheduleId, dueAt));
              materializedCount += 1;
            }
            passMadeProgress = true;
          }
        }
      }
      const readyOrder = roundRobinRows(
        [...runs.values()].filter((run) => {
          if (!isReadyRun(run, nowUnixMs)) return false;
          const schedule = schedules.get(run.scheduleId);
          return (
            schedule !== undefined &&
            schedule.status !== "deleted" &&
            !(schedule.status === "paused" && run.source === "schedule")
          );
        }),
        (run) => schedules.get(run.scheduleId)?.ownerDigest ?? "",
        (a, b) =>
          (a.nextAttemptAtUnixMs ?? a.scheduledForUnixMs) -
            (b.nextAttemptAtUnixMs ?? b.scheduledForUnixMs) || a.runId.localeCompare(b.runId, "en"),
        this.#claimRoundRobinCursor,
      );
      const ready = readyOrder.rows.slice(0, claimLimit);
      const ownerCount = Math.max(dueOrder.ownerCount, readyOrder.ownerCount);
      if (ownerCount > 0) {
        this.#claimRoundRobinCursor =
          (this.#claimRoundRobinCursor + Math.min(claimLimit, ownerCount)) % ownerCount;
      }
      const claims: DirectScheduleClaim[] = [];
      for (const run of ready) {
        const schedule = schedules.get(run.scheduleId);
        if (
          schedule === undefined ||
          schedule.status === "deleted" ||
          (schedule.status === "paused" && run.source === "schedule")
        )
          continue;
        const claimToken = this.#configuration.randomUUID();
        const { nextAttemptAtUnixMs: _nextAttemptAtUnixMs, ...claimable } = run;
        const firstAdmission = run.status === "pending" || run.status === "retry_wait";
        const claimed: StoredRun = {
          ...claimable,
          status: "claimed",
          attempt: firstAdmission ? run.attempt + 1 : run.attempt,
          updatedAtUnixMs: nowUnixMs,
          claimDigest: this.#digest(`claim\0${claimToken}`),
          claimExpiresAtUnixMs: checkedDeadline(
            nowUnixMs,
            this.#configuration.claimLeaseMs,
            "claim lease",
          ),
        };
        runs.set(claimed.runId, claimed);
        claims.push({
          claimToken,
          schedule: publicSchedule(schedule),
          run: publicRun(claimed),
          arguments: cloneObject(schedule.arguments),
          executionScope:
            schedule.sealedExecutionScope === undefined
              ? {
                  authorizationBinding: schedule.ownerDigest,
                  conversationId: schedule.conversationDigest,
                  workSessionId: schedule.workSessionDigest,
                }
              : this.#openExecutionScope(schedule),
        });
      }
      if (
        claims.length > 0 ||
        !mapsEqual(this.#schedules, schedules) ||
        !mapsEqual(this.#runs, runs)
      ) {
        await this.#commit(schedules, this.#pruneRuns(runs));
      }
      return claims;
    });
  }

  markDispatched(
    claim: Pick<DirectScheduleClaim, "claimToken" | "run">,
    jobId: string,
  ): Promise<DirectScheduleRunView> {
    return this.#claimTransition(claim, (run, now) => {
      const { claimDigest: _claimDigest, ...unclaimed } = run;
      return {
        ...unclaimed,
        status: "dispatched",
        jobId: requiredUuid(jobId, "jobId"),
        updatedAtUnixMs: now,
        claimExpiresAtUnixMs: checkedDeadline(
          now,
          this.#configuration.claimLeaseMs,
          "dispatch lease",
        ),
      };
    });
  }

  settle(
    scheduleId: string,
    runId: string,
    jobStatus: "succeeded" | "failed" | "outcome_unknown" | "cancelled",
    error?: { readonly code: string; readonly message: string },
  ): Promise<DirectScheduleRunView> {
    return this.#serialized(async () => {
      const run = this.#runs.get(requiredUuid(runId, "runId"));
      if (run === undefined || run.scheduleId !== requiredUuid(scheduleId, "scheduleId"))
        throw new Error("DIRECT_SCHEDULE_RUN_NOT_FOUND");
      if (isRunTerminal(run.status)) return publicRun(run);
      const schedule = this.#schedules.get(run.scheduleId);
      if (schedule === undefined) throw new Error("DIRECT_SCHEDULE_NOT_FOUND");
      const now = this.#now();
      let updated: StoredRun;
      if (jobStatus === "failed" && run.attempt < schedule.retry.maxAttempts) {
        const delay = retryDelay(schedule.retry, run.attempt);
        const {
          claimDigest: _claimDigest,
          claimExpiresAtUnixMs: _claimExpiresAtUnixMs,
          jobId: _jobId,
          ...retryable
        } = run;
        updated = {
          ...retryable,
          status: "retry_wait",
          updatedAtUnixMs: now,
          nextAttemptAtUnixMs: checkedDeadline(now, delay, "retry delay"),
          ...(error === undefined ? {} : { error: validateError(error) }),
        };
      } else {
        const {
          claimDigest: _claimDigest,
          claimExpiresAtUnixMs: _claimExpiresAtUnixMs,
          ...settled
        } = run;
        updated = {
          ...settled,
          status: jobStatus,
          updatedAtUnixMs: now,
          ...(error === undefined ? {} : { error: validateError(error) }),
        };
      }
      await this.#commit(this.#schedules, new Map(this.#runs).set(run.runId, updated));
      return publicRun(updated);
    });
  }

  async #changeStatus(
    input: DirectScheduleAccessInput,
    target: "paused" | "deleted",
  ): Promise<DirectScheduleView> {
    return this.#serialized(async () => {
      const current = this.#requiredScoped(input);
      if (current.status === "deleted" && target !== "deleted")
        throw new Error("DIRECT_SCHEDULE_DELETED");
      if (current.status === target) return publicSchedule(current);
      const updated: StoredSchedule = { ...current, status: target, updatedAtUnixMs: this.#now() };
      await this.#commit(new Map(this.#schedules).set(current.scheduleId, updated), this.#runs);
      return publicSchedule(updated);
    });
  }

  #claimTransition(
    claim: Pick<DirectScheduleClaim, "claimToken" | "run">,
    transition: (run: StoredRun, now: number) => StoredRun,
  ): Promise<DirectScheduleRunView> {
    return this.#serialized(async () => {
      const run = this.#runs.get(requiredUuid(claim.run.runId, "runId"));
      if (run === undefined || run.status !== "claimed" || run.claimDigest === undefined)
        throw new Error("DIRECT_SCHEDULE_CLAIM_LOST");
      const expected = Buffer.from(run.claimDigest, "hex");
      const actual = Buffer.from(this.#digest(`claim\0${claim.claimToken}`), "hex");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
        throw new Error("DIRECT_SCHEDULE_CLAIM_LOST");
      const updated = transition(run, this.#now());
      await this.#commit(this.#schedules, new Map(this.#runs).set(run.runId, updated));
      return publicRun(updated);
    });
  }

  #requiredScoped(input: DirectScheduleAccessInput): StoredSchedule {
    const schedule = this.#schedules.get(requiredUuid(input.scheduleId, "scheduleId"));
    if (schedule === undefined || !this.#scopeMatches(schedule, input))
      throw new Error("DIRECT_SCHEDULE_NOT_FOUND");
    return schedule;
  }

  #scopeMatches(schedule: StoredSchedule, scope: DirectScheduleScope): boolean {
    return sameScope(schedule, this.#scopeDigests(scope));
  }

  #assertScope(schedule: StoredSchedule, scope: ScopeDigests): void {
    if (!sameScope(schedule, scope)) throw new Error("DIRECT_SCHEDULE_SCOPE_MISMATCH");
  }

  #scopeDigests(scope: DirectScheduleScope): ScopeDigests {
    return {
      ownerDigest: this.#digest(
        `owner\0${requiredInternalBinding(scope.authorizationBinding, "authorizationBinding")}`,
      ),
      conversationDigest: this.#digest(
        `conversation\0${requiredInternalBinding(scope.conversationId, "conversationId")}`,
      ),
      workSessionDigest: this.#digest(
        `work-session\0${requiredInternalBinding(scope.workSessionId, "workSessionId")}`,
      ),
    };
  }

  #sealExecutionScope(scheduleId: string, scope: DirectScheduleScope): string {
    const key = createHmac("sha256", this.#configuration.key)
      .update("schedule-execution-scope-v1")
      .digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(scheduleId));
    const payload = JSON.stringify({
      authorizationBinding: scope.authorizationBinding,
      conversationId: scope.conversationId,
      workSessionId: scope.workSessionId,
    });
    const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
  }

  #openExecutionScope(schedule: StoredSchedule): DirectScheduleScope {
    const key = createHmac("sha256", this.#configuration.key)
      .update("schedule-execution-scope-v1")
      .digest();
    const bytes = Buffer.from(schedule.sealedExecutionScope ?? "", "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    decipher.setAAD(Buffer.from(schedule.scheduleId));
    const scope = JSON.parse(
      Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"),
    ) as DirectScheduleScope;
    this.#assertScope(schedule, this.#scopeDigests(scope));
    return scope;
  }

  #newRun(
    schedule: StoredSchedule,
    scheduledForUnixMs: number,
    source: "schedule" | "manual",
    triggerDigest?: string,
  ): StoredRun {
    const runId = uuidFromDigest(
      this.#digest(
        canonicalJson({
          contract: "direct-schedule-run-v1",
          scheduleId: schedule.scheduleId,
          scheduledForUnixMs,
        }),
      ),
    );
    const now = this.#now();
    return {
      runId,
      scheduleId: schedule.scheduleId,
      scheduledForUnixMs,
      status: "pending",
      attempt: 0,
      source,
      ...(triggerDigest === undefined ? {} : { triggerDigest }),
      createdAtUnixMs: now,
      updatedAtUnixMs: now,
    };
  }

  #runAt(scheduleId: string, scheduledForUnixMs: number, runs = this.#runs): StoredRun | undefined {
    return [...runs.values()].find(
      (run) => run.scheduleId === scheduleId && run.scheduledForUnixMs === scheduledForUnixMs,
    );
  }

  #withRun(run: StoredRun): Map<string, StoredRun> {
    return this.#pruneRuns(new Map(this.#runs).set(run.runId, run));
  }

  #pruneRuns(runs: Map<string, StoredRun>): Map<string, StoredRun> {
    const maximum = this.#configuration.maxRuns;
    if (maximum === undefined || runs.size <= maximum) return runs;
    const removable = [...runs.values()]
      .filter((run) => isRunTerminal(run.status))
      .sort((a, b) => a.updatedAtUnixMs - b.updatedAtUnixMs);
    const next = new Map(runs);
    for (const run of removable) {
      if (next.size <= maximum) break;
      next.delete(run.runId);
    }
    if (next.size > maximum) throw new Error("DIRECT_SCHEDULE_RUN_CAPACITY_EXCEEDED");
    return next;
  }

  #now(): number {
    return checkedTimestamp(this.#configuration.nowUnixMs(), "clock");
  }

  #digest(value: string): string {
    return createHmac("sha256", this.#configuration.key).update(value, "utf8").digest("hex");
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #commit(
    schedules: Map<string, StoredSchedule>,
    runs: Map<string, StoredRun>,
  ): Promise<void> {
    const revision = this.#revision + 1;
    if (this.#configuration.snapshotPath !== undefined) {
      await writeSnapshot(
        { ...this.#configuration, snapshotPath: this.#configuration.snapshotPath },
        revision,
        schedules,
        runs,
      );
    }
    this.#schedules = schedules;
    this.#runs = runs;
    this.#revision = revision;
  }
}

function normalizeCreate(input: DirectScheduleCreateInput, now: number) {
  const timezone = requiredTimeZone(input.timezone);
  const parsedRule = parseRrule(input.rrule);
  const anchorUnixMs = checkedTimestamp(input.startAtUnixMs ?? now, "startAtUnixMs");
  return {
    ...input,
    authorizationBinding: requiredInternalBinding(
      input.authorizationBinding,
      "authorizationBinding",
    ),
    conversationId: requiredInternalBinding(input.conversationId, "conversationId"),
    workSessionId: requiredInternalBinding(input.workSessionId, "workSessionId"),
    idempotencyKey: requiredIdentifier(input.idempotencyKey, "idempotencyKey", 128, 16),
    timezone,
    rrule: canonicalRule(parsedRule),
    parsedRule,
    anchorUnixMs,
    toolName: requiredToolName(input.toolName),
    arguments: cloneObject(input.arguments),
    retry: normalizeRetry(input.retry),
    misfire: normalizeMisfire(input.misfire),
  };
}

export function parseDirectScheduleRrule(value: string): ParsedRule {
  return parseRrule(value);
}

function parseRrule(value: string): ParsedRule {
  const text = requiredOpaque(value, "rrule", 256).toUpperCase();
  const fields = new Map<string, string>();
  for (const part of text.split(";")) {
    const [key, fieldValue, extra] = part.split("=");
    if (key === undefined || fieldValue === undefined || extra !== undefined || fields.has(key))
      throw new TypeError("rrule contains an invalid or duplicate field");
    fields.set(key, fieldValue);
  }
  const frequency = fields.get("FREQ");
  if (frequency === "MINUTELY") {
    assertFields(fields, ["FREQ", "INTERVAL"]);
    return {
      frequency,
      interval: boundedInteger(
        fields.get("INTERVAL") ?? "1",
        1,
        Number.MAX_SAFE_INTEGER,
        "INTERVAL",
      ),
    };
  }
  if (frequency === "DAILY") {
    assertFields(fields, ["FREQ", "INTERVAL", "BYHOUR", "BYMINUTE"]);
    if (!fields.has("BYHOUR") || !fields.has("BYMINUTE"))
      throw new TypeError("DAILY rrule requires BYHOUR and BYMINUTE");
    return {
      frequency,
      interval: boundedInteger(
        fields.get("INTERVAL") ?? "1",
        1,
        Number.MAX_SAFE_INTEGER,
        "INTERVAL",
      ),
      byHour: boundedInteger(fields.get("BYHOUR") ?? "", 0, 23, "BYHOUR"),
      byMinute: boundedInteger(fields.get("BYMINUTE") ?? "", 0, 59, "BYMINUTE"),
    };
  }
  throw new TypeError("rrule FREQ must be MINUTELY or DAILY");
}

function canonicalRule(rule: ParsedRule): string {
  return rule.frequency === "MINUTELY"
    ? `FREQ=MINUTELY;INTERVAL=${String(rule.interval)}`
    : `FREQ=DAILY;INTERVAL=${String(rule.interval)};BYHOUR=${String(rule.byHour)};BYMINUTE=${String(rule.byMinute)}`;
}

function firstOccurrence(rule: ParsedRule, anchor: number, timezone: string): number {
  if (rule.frequency === "MINUTELY") return anchor;
  const local = localParts(anchor, timezone);
  const candidate = localToUnixMs(
    {
      year: local.year,
      month: local.month,
      day: local.day,
      hour: rule.byHour,
      minute: rule.byMinute,
    },
    timezone,
  );
  return candidate >= anchor ? candidate : nextOccurrence(rule, candidate, timezone);
}

function firstAfter(rule: ParsedRule, anchor: number, timezone: string, after: number): number {
  const occurrence = firstOccurrence(rule, anchor, timezone);
  return occurrence > after
    ? occurrence
    : dueOccurrenceWindow(rule, occurrence, timezone, after).next;
}

function nextOccurrence(rule: ParsedRule, current: number, timezone: string): number {
  if (rule.frequency === "MINUTELY") return current + rule.interval * 60_000;
  const local = localParts(current, timezone);
  const target = addUtcDays(local.year, local.month, local.day, rule.interval);
  return localToUnixMs({ ...target, hour: rule.byHour, minute: rule.byMinute }, timezone);
}

function materializeDue(
  schedule: StoredSchedule,
  now: number,
  makeRun: (scheduledFor: number) => StoredRun,
): { schedule: StoredSchedule; runs: readonly StoredRun[] } {
  const first = schedule.nextRunAtUnixMs;
  if (first === undefined || first > now) return { schedule, runs: [] };
  const window = dueOccurrenceWindow(schedule.parsedRule, first, schedule.timezone, now);
  const selectedCount =
    schedule.misfire.mode === "catch_up"
      ? Math.min(window.count, schedule.misfire.maxCatchUp ?? window.count)
      : 1;
  const startIndex = window.count - selectedCount;
  let selected = Array.from({ length: selectedCount }, (_, offset) =>
    occurrenceAt(schedule.parsedRule, first, schedule.timezone, startIndex + offset),
  );
  if (schedule.misfire.mode === "skip") {
    selected = now - window.last <= schedule.misfire.graceMs ? [window.last] : [];
  }
  const runs: StoredRun[] = selected.map(makeRun);
  if (schedule.misfire.mode === "skip" && selected.length === 0) {
    runs.push({
      ...makeRun(window.last),
      status: "misfired",
      error: {
        code: "DIRECT_SCHEDULE_MISFIRE_SKIPPED",
        message: "Occurrence exceeded the configured misfire grace window",
      },
    });
  }
  return {
    schedule: {
      ...schedule,
      nextRunAtUnixMs: window.next,
      updatedAtUnixMs: now,
    },
    runs,
  };
}

function dueOccurrenceWindow(
  rule: ParsedRule,
  first: number,
  timezone: string,
  now: number,
): { readonly count: number; readonly last: number; readonly next: number } {
  if (first > now) throw new Error("DIRECT_SCHEDULE_DUE_WINDOW_EMPTY");
  if (rule.frequency === "MINUTELY") {
    const step = rule.interval * 60_000;
    const count = Math.floor((now - first) / step) + 1;
    const last = first + (count - 1) * step;
    return { count, last, next: last + step };
  }

  const firstLocal = localParts(first, timezone);
  const nowLocal = localParts(now, timezone);
  const elapsedDays = Math.max(0, calendarDay(nowLocal) - calendarDay(firstLocal));
  let index = Math.floor(elapsedDays / rule.interval);
  let last = occurrenceAt(rule, first, timezone, index);
  while (last > now && index > 0) {
    index -= 1;
    last = occurrenceAt(rule, first, timezone, index);
  }
  let next = occurrenceAt(rule, first, timezone, index + 1);
  while (next <= now) {
    index += 1;
    last = next;
    next = occurrenceAt(rule, first, timezone, index + 1);
  }
  return { count: index + 1, last, next };
}

function occurrenceAt(rule: ParsedRule, first: number, timezone: string, index: number): number {
  if (!Number.isSafeInteger(index) || index < 0)
    throw new Error("DIRECT_SCHEDULE_OCCURRENCE_INDEX_INVALID");
  if (rule.frequency === "MINUTELY") return first + index * rule.interval * 60_000;
  const local = localParts(first, timezone);
  const target = addUtcDays(local.year, local.month, local.day, index * rule.interval);
  return localToUnixMs({ ...target, hour: rule.byHour, minute: rule.byMinute }, timezone);
}

function calendarDay(local: {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}) {
  return Math.floor(Date.UTC(local.year, local.month - 1, local.day) / 86_400_000);
}

function localParts(
  unixMs: number,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(unixMs));
  const take = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: take("year"),
    month: take("month"),
    day: take("day"),
    hour: take("hour"),
    minute: take("minute"),
  };
}

function localToUnixMs(
  local: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
): number {
  const targetWall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  let guess = targetWall;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const shown = localParts(guess, timezone);
    const shownWall = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute);
    const next = guess + (targetWall - shownWall);
    if (next === guess) return guess;
    guess = next;
  }
  const exact = localParts(guess, timezone);
  if (
    exact.year !== local.year ||
    exact.month !== local.month ||
    exact.day !== local.day ||
    exact.hour !== local.hour ||
    exact.minute !== local.minute
  ) {
    // DST gap: choose the first representable minute after the requested wall time.
    for (let offset = 1; offset <= 180; offset += 1) {
      const candidate = guess + offset * 60_000;
      const shown = localParts(candidate, timezone);
      const shownWall = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute);
      if (shownWall >= targetWall) return candidate;
    }
  }
  return guess;
}

function addUtcDays(year: number, month: number, day: number, amount: number) {
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function normalizeRetry(
  value: Partial<DirectScheduleRetryPolicy> | undefined,
): DirectScheduleRetryPolicy {
  const policy = {
    maxAttempts: value?.maxAttempts ?? 1,
    initialDelayMs: value?.initialDelayMs ?? 1_000,
    multiplier: value?.multiplier ?? 2,
    maxDelayMs: value?.maxDelayMs ?? 60_000,
  };
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1)
    throw new TypeError("retry.maxAttempts must be a positive safe integer");
  if (!Number.isSafeInteger(policy.initialDelayMs) || policy.initialDelayMs < 0)
    throw new TypeError("retry.initialDelayMs is invalid");
  if (!Number.isFinite(policy.multiplier) || policy.multiplier < 1)
    throw new TypeError("retry.multiplier is invalid");
  if (!Number.isSafeInteger(policy.maxDelayMs) || policy.maxDelayMs < policy.initialDelayMs)
    throw new TypeError("retry.maxDelayMs is invalid");
  return policy;
}

function normalizeMisfire(
  value: Partial<DirectScheduleMisfirePolicy> | undefined,
): DirectScheduleMisfirePolicy {
  const policy = {
    mode: value?.mode ?? "catch_up",
    graceMs: value?.graceMs ?? 300_000,
    ...(value?.maxCatchUp === undefined ? {} : { maxCatchUp: value.maxCatchUp }),
  };
  if (policy.mode !== "fire_once" && policy.mode !== "skip" && policy.mode !== "catch_up")
    throw new TypeError("misfire.mode is invalid");
  if (!Number.isSafeInteger(policy.graceMs) || policy.graceMs < 0)
    throw new TypeError("misfire.graceMs is invalid");
  if (
    policy.maxCatchUp !== undefined &&
    (!Number.isSafeInteger(policy.maxCatchUp) || policy.maxCatchUp < 1)
  )
    throw new TypeError("misfire.maxCatchUp is invalid");
  return policy as DirectScheduleMisfirePolicy;
}

function retryDelay(policy: DirectScheduleRetryPolicy, completedAttempts: number): number {
  return Math.min(
    policy.maxDelayMs,
    Math.round(policy.initialDelayMs * policy.multiplier ** Math.max(0, completedAttempts - 1)),
  );
}

function publicSchedule(value: StoredSchedule): DirectScheduleView {
  return {
    scheduleId: value.scheduleId,
    status: value.status,
    timezone: value.timezone,
    rrule: value.rrule,
    toolName: value.toolName,
    createdAtUnixMs: value.createdAtUnixMs,
    updatedAtUnixMs: value.updatedAtUnixMs,
    ...(value.nextRunAtUnixMs === undefined ? {} : { nextRunAtUnixMs: value.nextRunAtUnixMs }),
    retry: { ...value.retry },
    misfire: { ...value.misfire },
  };
}

function publicRun(value: StoredRun): DirectScheduleRunView {
  return {
    runId: value.runId,
    scheduleId: value.scheduleId,
    scheduledForUnixMs: value.scheduledForUnixMs,
    status: value.status,
    attempt: value.attempt,
    source: value.source,
    createdAtUnixMs: value.createdAtUnixMs,
    updatedAtUnixMs: value.updatedAtUnixMs,
    ...(value.nextAttemptAtUnixMs === undefined
      ? {}
      : { nextAttemptAtUnixMs: value.nextAttemptAtUnixMs }),
    ...(value.jobId === undefined ? {} : { jobId: value.jobId }),
    ...(value.error === undefined ? {} : { error: { ...value.error } }),
  };
}

function sameScope(left: ScopeDigests, right: ScopeDigests): boolean {
  return (
    left.ownerDigest === right.ownerDigest &&
    left.conversationDigest === right.conversationDigest &&
    left.workSessionDigest === right.workSessionDigest
  );
}

function isRunTerminal(status: DirectScheduleRunStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "outcome_unknown" ||
    status === "cancelled" ||
    status === "misfired"
  );
}

function mapsEqual<K, V>(left: Map<K, V>, right: Map<K, V>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (right.get(key) !== value) return false;
  return true;
}

function isReadyRun(run: StoredRun, nowUnixMs: number): boolean {
  if (run.status === "pending") return true;
  if (run.status === "retry_wait")
    return (run.nextAttemptAtUnixMs ?? Number.MAX_SAFE_INTEGER) <= nowUnixMs;
  return (
    (run.status === "claimed" || run.status === "dispatched") &&
    (run.claimExpiresAtUnixMs ?? Number.MAX_SAFE_INTEGER) <= nowUnixMs
  );
}

function roundRobinRows<T>(
  values: readonly T[],
  ownerOf: (value: T) => string,
  compare: (left: T, right: T) => number,
  cursor: number,
): { readonly rows: readonly T[]; readonly ownerCount: number } {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const owner = ownerOf(value);
    const group = groups.get(owner);
    if (group === undefined) groups.set(owner, [value]);
    else group.push(value);
  }
  const owners = [...groups.keys()].sort((a, b) => a.localeCompare(b, "en"));
  if (owners.length === 0) return { rows: [], ownerCount: 0 };
  const start = cursor % owners.length;
  const rotated = [...owners.slice(start), ...owners.slice(0, start)];
  for (const rows of groups.values()) rows.sort(compare);
  const rows: T[] = [];
  for (let index = 0; ; index += 1) {
    let added = false;
    for (const owner of rotated) {
      const value = groups.get(owner)?.[index];
      if (value === undefined) continue;
      rows.push(value);
      added = true;
    }
    if (!added) break;
  }
  return { rows, ownerCount: owners.length };
}

function runOccurrenceKey(scheduleId: string, scheduledForUnixMs: number): string {
  return `${scheduleId}\0${String(scheduledForUnixMs)}`;
}

function requiredTimeZone(value: unknown): string {
  const timezone = requiredOpaque(value, "timezone", 128);
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
  } catch {
    throw new TypeError("timezone must be an IANA time-zone identifier supported by this runtime");
  }
  if (timezone === "UTC" || !timezone.includes("/"))
    throw new TypeError("timezone must be an explicit IANA region/city identifier");
  return timezone;
}

function requiredScheduleStatus(value: unknown): DirectScheduleStatus {
  if (value !== "active" && value !== "paused" && value !== "deleted")
    throw new TypeError("schedule status is invalid");
  return value;
}

function requiredRunStatus(value: unknown): DirectScheduleRunStatus {
  const allowed: readonly DirectScheduleRunStatus[] = [
    "pending",
    "claimed",
    "dispatched",
    "retry_wait",
    "succeeded",
    "failed",
    "outcome_unknown",
    "cancelled",
    "misfired",
  ];
  if (!allowed.includes(value as DirectScheduleRunStatus))
    throw new TypeError("schedule run status is invalid");
  return value as DirectScheduleRunStatus;
}

function requiredToolName(value: unknown): string {
  const name = requiredOpaque(value, "toolName", 512);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u.test(name))
    throw new TypeError("toolName must be an exact first-class MCP tool name");
  return name;
}

function requiredIdentifier(value: unknown, name: string, maximum: number, minimum = 1): string {
  const text = requiredOpaque(value, name, maximum);
  if (text.length < minimum || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(text))
    throw new TypeError(`${name} must be a stable identifier`);
  return text;
}

function requiredUuid(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[45][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)
  )
    throw new TypeError(`${name} is invalid`);
  return value;
}

function requiredOpaque(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\0\r\n]/u.test(value)
  )
    throw new TypeError(`${name} is invalid`);
  return value;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)) || "Unknown error";
}

/**
 * Validates an identity binding manufactured by the gateway, not a remotely
 * supplied identifier. `authorizationBinding()` deliberately uses NUL field
 * separators so its components cannot collide. The raw value is never
 * persisted: schedule scope stores only a keyed digest of it.
 */
function requiredInternalBinding(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1 || /[\r\n]/u.test(value))
    throw new TypeError(`${name} is invalid`);
  return value;
}

function requiredLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new TypeError("limit must be a positive safe integer");
  return value as number;
}

function boundedInteger(value: string, minimum: number, maximum: number, name: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new TypeError(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new TypeError(`${name} is outside its supported range`);
  return parsed;
}

function assertFields(fields: Map<string, string>, allowed: readonly string[]): void {
  const set = new Set(allowed);
  if ([...fields.keys()].some((key) => !set.has(key)))
    throw new TypeError("rrule contains an unsupported field");
}

function validateError(value: { readonly code: string; readonly message: string }) {
  const code = requiredOpaque(value.code, "error.code", 128);
  if (!/^[A-Z][A-Z0-9_:-]*$/u.test(code)) throw new TypeError("error.code is invalid");
  if (typeof value.message !== "string" || value.message.length === 0) {
    throw new TypeError("error.message is invalid");
  }
  return { code, message: value.message };
}

function checkedDeadline(nowUnixMs: number, durationMs: number, name: string): number {
  const deadline = nowUnixMs + durationMs;
  if (!Number.isSafeInteger(deadline)) throw new TypeError(`${name} exceeds epoch range`);
  return deadline;
}

function checkedTimestamp(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${name} must be a non-negative epoch millisecond`);
  return value;
}

function cloneObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("arguments must be an object");
  const cloned = JSON.parse(canonicalJson(value)) as unknown;
  if (typeof cloned !== "object" || cloned === null || Array.isArray(cloned))
    throw new TypeError("arguments must be an object");
  return cloned as Record<string, unknown>;
}

function uuidFromDigest(digest: string): string {
  const bytes = Buffer.from(digest.slice(0, 32), "hex");
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

function cursorStart<T>(
  rows: readonly T[],
  cursor: string | undefined,
  identity: (row: T) => string,
): number {
  if (cursor === undefined) return 0;
  const id = Buffer.from(requiredOpaque(cursor, "cursor", 1_024), "base64url").toString("utf8");
  const index = rows.findIndex((row) => identity(row) === id);
  if (index < 0) throw new TypeError("cursor is stale or outside this scope");
  return index + 1;
}

function configurationBase(
  options: InMemoryDirectScheduleStoreOptions | DirectScheduleStoreOptions,
  key: Uint8Array,
): Configuration {
  if (key.byteLength < 32) throw new TypeError("integrityKey must contain at least 32 bytes");
  const maxSchedules = options.maxSchedules;
  const maxRuns = options.maxRuns;
  const claimLeaseMs = options.claimLeaseMs ?? 60_000;
  if (maxSchedules !== undefined && (!Number.isSafeInteger(maxSchedules) || maxSchedules < 1))
    throw new TypeError("maxSchedules is invalid");
  if (maxRuns !== undefined && (!Number.isSafeInteger(maxRuns) || maxRuns < 1))
    throw new TypeError("maxRuns is invalid");
  if (!Number.isSafeInteger(claimLeaseMs) || claimLeaseMs < 1)
    throw new TypeError("claimLeaseMs is invalid");
  return {
    key: Buffer.from(key),
    maxSchedules,
    maxRuns,
    claimLeaseMs,
    nowUnixMs: options.nowUnixMs ?? Date.now,
    randomUUID: options.randomUUID ?? randomUUID,
  };
}

function durableConfiguration(
  options: DirectScheduleStoreOptions,
): Configuration & { readonly snapshotPath: string } {
  const base = configurationBase(options, options.integrityKey);
  const dataDirectory = resolve(options.dataDirectory ?? omniCodexDataDirectory());
  return {
    ...base,
    snapshotPath: resolve(
      options.snapshotPath ?? join(dataDirectory, "state", "direct-schedule-store.json"),
    ),
  };
}

function memoryConfiguration(options: InMemoryDirectScheduleStoreOptions): Configuration {
  return configurationBase(options, options.integrityKey ?? randomBytes(32));
}

async function loadSnapshot(
  configuration: Configuration & { readonly snapshotPath: string },
): Promise<{
  revision: number;
  schedules: Map<string, StoredSchedule>;
  runs: Map<string, StoredRun>;
}> {
  let raw: string;
  try {
    raw = await readFile(configuration.snapshotPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { revision: 0, schedules: new Map(), runs: new Map() };
    throw error;
  }
  const snapshot = JSON.parse(raw) as StoredSnapshot;
  if (
    snapshot.schemaVersion !== SCHEMA_VERSION ||
    !Number.isSafeInteger(snapshot.revision) ||
    !Array.isArray(snapshot.schedules) ||
    !Array.isArray(snapshot.runs) ||
    typeof snapshot.mac !== "string"
  )
    throw new Error("DIRECT_SCHEDULE_SNAPSHOT_INVALID");
  const { mac, ...payload } = snapshot;
  const expected = createHmac("sha256", configuration.key)
    .update(canonicalJson(payload), "utf8")
    .digest("hex");
  const actualBytes = Buffer.from(mac, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes))
    throw new Error("DIRECT_SCHEDULE_SNAPSHOT_MAC_INVALID");
  // Re-validate all executable fields before admitting durable state.
  const schedules = new Map<string, StoredSchedule>();
  for (const rawSchedule of snapshot.schedules) {
    const parsedRule = parseRrule(rawSchedule.rrule);
    const schedule: StoredSchedule = {
      ...rawSchedule,
      scheduleId: requiredUuid(rawSchedule.scheduleId, "scheduleId"),
      status: requiredScheduleStatus(rawSchedule.status),
      timezone: requiredTimeZone(rawSchedule.timezone),
      rrule: canonicalRule(parsedRule),
      parsedRule,
      toolName: requiredToolName(rawSchedule.toolName),
      arguments: cloneObject(rawSchedule.arguments),
      retry: normalizeRetry(rawSchedule.retry),
      misfire: normalizeMisfire(rawSchedule.misfire),
    };
    schedules.set(schedule.scheduleId, schedule);
  }
  const runs = new Map<string, StoredRun>();
  for (const rawRun of snapshot.runs) {
    const run: StoredRun = {
      ...rawRun,
      runId: requiredUuid(rawRun.runId, "runId"),
      scheduleId: requiredUuid(rawRun.scheduleId, "scheduleId"),
      status: requiredRunStatus(rawRun.status),
    };
    runs.set(run.runId, run);
  }
  return { revision: snapshot.revision, schedules, runs };
}

async function writeSnapshot(
  configuration: Configuration & { readonly snapshotPath: string },
  revision: number,
  schedules: Map<string, StoredSchedule>,
  runs: Map<string, StoredRun>,
): Promise<void> {
  const payload: SnapshotPayload = {
    schemaVersion: SCHEMA_VERSION,
    revision,
    schedules: [...schedules.values()].sort((a, b) =>
      a.scheduleId.localeCompare(b.scheduleId, "en"),
    ),
    runs: [...runs.values()].sort((a, b) => a.runId.localeCompare(b.runId, "en")),
  };
  const snapshot: StoredSnapshot = {
    ...payload,
    mac: createHmac("sha256", configuration.key)
      .update(canonicalJson(payload), "utf8")
      .digest("hex"),
  };
  await mkdir(dirname(configuration.snapshotPath), { recursive: true });
  const temporary = `${configuration.snapshotPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(canonicalJson(snapshot), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, configuration.snapshotPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
