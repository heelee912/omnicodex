import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  DirectJobDispatchAdapter,
  DirectJobInvocationContext,
  DirectJobManager,
} from "./direct-job-mcp-tools.js";
import type {
  DirectScheduleAccessInput,
  DirectScheduleCreateInput,
  DirectScheduleRunStatus,
  DirectScheduleScope,
  DirectScheduleStatus,
  DirectScheduleStore,
} from "./direct-schedule-store.js";

export const directScheduleToolNames = [
  "omnicodex__schedule_create",
  "omnicodex__schedule_get",
  "omnicodex__schedule_list",
  "omnicodex__schedule_pause",
  "omnicodex__schedule_resume",
  "omnicodex__schedule_delete",
  "omnicodex__schedule_trigger",
  "omnicodex__schedule_runs",
] as const;

export type DirectScheduleToolName = (typeof directScheduleToolNames)[number];

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

export interface DirectScheduleInvocationContext extends DirectJobInvocationContext {
  /** Server-derived schedule sub-owner; it is never accepted from MCP arguments. */
  readonly directScheduleOwnerBinding: string;
}

export interface DirectSchedulePollingOptions {
  readonly pollIntervalMs?: number;
  readonly claimLimit?: number;
}

export interface DirectScheduleShutdownOptions {
  /** Time allowed for exact-native executions already admitted by this runtime. */
  readonly drainTimeoutMs?: number;
  /** Time allowed to persist cancellation/outcome-unknown fences after drain expiry. */
  readonly fenceTimeoutMs?: number;
}

interface ActiveScheduleExecution {
  readonly scheduleId: string;
  readonly runId: string;
  readonly callerSessionId: string;
  readonly completion: Promise<void>;
}

/**
 * Executes schedule occurrences exclusively through DirectJobManager.start.
 * It has no model, prompt, thread, shell, or alternate dispatch path.
 */
export class DirectScheduleManager {
  readonly #store: DirectScheduleStore;
  readonly #jobs: DirectJobManager;
  readonly #inFlight = new Map<string, ActiveScheduleExecution>();
  #timer: NodeJS.Timeout | undefined;
  #pollingAdapter: DirectJobDispatchAdapter | undefined;
  #claimLimit: number | undefined;

  constructor(store: DirectScheduleStore, jobs: DirectJobManager) {
    this.#store = store;
    this.#jobs = jobs;
  }

  get store(): DirectScheduleStore {
    return this.#store;
  }

  async create(
    input: Omit<DirectScheduleCreateInput, keyof DirectScheduleScope>,
    context: DirectScheduleInvocationContext,
    adapter: DirectJobDispatchAdapter,
  ) {
    await adapter.validate(input.toolName, input.arguments);
    const result = await this.#store.create({ ...input, ...scopeFromContext(context) });
    await this.pump(adapter);
    return result;
  }

  get(
    input: Pick<DirectScheduleAccessInput, "scheduleId">,
    context: DirectScheduleInvocationContext,
  ) {
    return this.#store.get({ ...input, ...scopeFromContext(context) });
  }

  list(
    input: {
      readonly statuses?: readonly DirectScheduleStatus[];
      readonly limit?: number;
      readonly cursor?: string;
    },
    context: DirectScheduleInvocationContext,
  ) {
    return this.#store.list({ ...input, ...scopeFromContext(context) });
  }

  pause(
    input: Pick<DirectScheduleAccessInput, "scheduleId">,
    context: DirectScheduleInvocationContext,
  ) {
    return this.#store.pause({ ...input, ...scopeFromContext(context) });
  }

  async resume(
    input: Pick<DirectScheduleAccessInput, "scheduleId">,
    context: DirectScheduleInvocationContext,
    adapter: DirectJobDispatchAdapter,
  ) {
    const result = await this.#store.resume({ ...input, ...scopeFromContext(context) });
    await this.pump(adapter);
    return result;
  }

  delete(
    input: Pick<DirectScheduleAccessInput, "scheduleId">,
    context: DirectScheduleInvocationContext,
  ) {
    return this.#store.delete({ ...input, ...scopeFromContext(context) });
  }

  async trigger(
    input: { readonly scheduleId: string; readonly idempotencyKey: string },
    context: DirectScheduleInvocationContext,
    adapter: DirectJobDispatchAdapter,
  ) {
    const result = await this.#store.trigger({ ...input, ...scopeFromContext(context) });
    await this.pump(adapter);
    return result;
  }

  runs(
    input: {
      readonly scheduleId: string;
      readonly statuses?: readonly DirectScheduleRunStatus[];
      readonly limit?: number;
      readonly cursor?: string;
    },
    context: DirectScheduleInvocationContext,
  ) {
    return this.#store.runs({ ...input, ...scopeFromContext(context) });
  }

  /** Claim due work after boot or on a timer; calls return after durable dispatch admission. */
  async pump(adapter: DirectJobDispatchAdapter, nowUnixMs?: number): Promise<number> {
    const claims = await this.#store.claimDue(nowUnixMs, this.#claimLimit);
    for (const claim of claims) {
      if (this.#inFlight.has(claim.run.runId)) continue;
      let active!: ActiveScheduleExecution;
      const completion = this.#executeClaim(claim, adapter).finally(() => {
        if (this.#inFlight.get(claim.run.runId) === active) this.#inFlight.delete(claim.run.runId);
      });
      active = {
        scheduleId: claim.schedule.scheduleId,
        runId: claim.run.runId,
        callerSessionId: `schedule:${claim.run.runId}`,
        completion,
      };
      this.#inFlight.set(claim.run.runId, active);
    }
    return claims.length;
  }

  /** Begin reboot-safe due polling. Timer is unref'd and never owns a UI process. */
  startPolling(
    adapter: DirectJobDispatchAdapter,
    options: DirectSchedulePollingOptions = {},
  ): void {
    if (this.#timer !== undefined) throw new Error("DIRECT_SCHEDULE_POLLING_ALREADY_STARTED");
    const interval = options.pollIntervalMs ?? 1_000;
    if (!Number.isSafeInteger(interval) || interval < 250 || interval > 60_000) {
      throw new TypeError("pollIntervalMs must be between 250 and 60000");
    }
    const claimLimit = options.claimLimit;
    if (claimLimit !== undefined && (!Number.isSafeInteger(claimLimit) || claimLimit < 1)) {
      throw new TypeError("claimLimit must be a positive safe integer");
    }
    this.#pollingAdapter = adapter;
    this.#claimLimit = claimLimit;
    const tick = () => void this.pump(adapter).catch(() => undefined);
    tick();
    this.#timer = setInterval(tick, interval);
    this.#timer.unref();
  }

  stopPollingAdmission(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#pollingAdapter = undefined;
  }

  async shutdown(options: DirectScheduleShutdownOptions = {}): Promise<void> {
    this.stopPollingAdmission();
    const admitted = [...this.#inFlight.values()];
    if (admitted.length === 0) return;
    const drain = Promise.allSettled(admitted.map((active) => active.completion));
    if (options.drainTimeoutMs === undefined) {
      await drain;
      return;
    }
    const drainTimeoutMs = shutdownTimeout(options.drainTimeoutMs, "drainTimeoutMs");
    if (await settlesWithin(drain, drainTimeoutMs)) return;

    const error = {
      code: "DIRECT_SCHEDULE_RUNTIME_DRAIN_TIMEOUT",
      message: "Runtime transition deadline expired before native schedule execution completed",
    } as const;
    const stillActive = admitted.filter((active) => this.#inFlight.get(active.runId) === active);
    const fence = Promise.allSettled(
      stillActive.map(async (active) => {
        const results = await Promise.allSettled([
          this.#jobs.fenceCallerOutcomeUnknown(active.callerSessionId, error),
          this.#store.settle(active.scheduleId, active.runId, "outcome_unknown", error),
        ]);
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason);
        if (failures.length > 0) throw new AggregateError(failures, error.message);
        if (this.#inFlight.get(active.runId) === active) this.#inFlight.delete(active.runId);
      }),
    ).then((results) => {
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, error.message);
    });
    if (options.fenceTimeoutMs === undefined) {
      await fence;
      return;
    }
    const fenceTimeoutMs = shutdownTimeout(options.fenceTimeoutMs, "fenceTimeoutMs");
    if (!(await settlesWithin(fence, fenceTimeoutMs))) {
      throw new Error("DIRECT_SCHEDULE_RUNTIME_FENCE_TIMEOUT");
    }
  }

  async #executeClaim(
    claim: Awaited<ReturnType<DirectScheduleStore["claimDue"]>>[number],
    adapter: DirectJobDispatchAdapter,
  ): Promise<void> {
    const callerSessionId = `schedule:${claim.run.runId}`;
    const context: DirectJobInvocationContext = {
      authorizationBinding: claim.executionScope.authorizationBinding,
      directJobOwnerBinding: claim.executionScope.conversationId,
      workSessionBinding: claim.executionScope.workSessionId,
      directGoalClaimantBinding: `schedule:${claim.schedule.scheduleId}`,
      callerSessionId,
    };
    try {
      if (claim.run.jobId !== undefined) {
        const recovered = await this.#jobs.get({ jobId: claim.run.jobId }, context);
        if (recovered === undefined) {
          await this.#store.settle(claim.schedule.scheduleId, claim.run.runId, "outcome_unknown", {
            code: "DIRECT_SCHEDULE_PERSISTED_JOB_MISSING",
            message: "Persisted schedule dispatch no longer has an authoritative direct job",
          });
          return;
        }
        if (recovered.status === "queued" || recovered.status === "running") {
          await this.#store.settle(claim.schedule.scheduleId, claim.run.runId, "outcome_unknown", {
            code: "DIRECT_SCHEDULE_PERSISTED_JOB_NONTERMINAL",
            message: "Recovered schedule dispatch has no authoritative terminal result",
          });
          return;
        }
        await this.#store.settle(
          claim.schedule.scheduleId,
          claim.run.runId,
          recovered.status,
          recovered.error,
        );
        return;
      }
      const started = await this.#jobs.start(
        {
          idempotencyKey: scheduleJobIdempotencyKey(
            claim.schedule.scheduleId,
            claim.run.scheduledForUnixMs,
            claim.run.attempt,
          ),
          toolName: claim.schedule.toolName,
          arguments: claim.arguments,
        },
        context,
        adapter,
      );
      await this.#store.markDispatched(claim, started.job.jobId);
      await this.#jobs.waitForCallerIdle(callerSessionId);
      const job = await this.#jobs.get({ jobId: started.job.jobId }, context);
      if (job === undefined || job.status === "queued" || job.status === "running") {
        await this.#store.settle(claim.schedule.scheduleId, claim.run.runId, "outcome_unknown", {
          code: "DIRECT_SCHEDULE_JOB_TERMINAL_STATE_MISSING",
          message: "Direct job did not expose an authoritative terminal state",
        });
        return;
      }
      await this.#store.settle(claim.schedule.scheduleId, claim.run.runId, job.status, job.error);
    } catch (error) {
      await this.#store
        .settle(claim.schedule.scheduleId, claim.run.runId, "failed", {
          code: "DIRECT_SCHEDULE_DISPATCH_ADMISSION_FAILED",
          message: errorMessage(error),
        })
        .catch(() => undefined);
    } finally {
      if (this.#pollingAdapter !== undefined) {
        void this.pump(this.#pollingAdapter).catch(() => undefined);
      }
    }
  }
}

export function isDirectScheduleTool(name: string): name is DirectScheduleToolName {
  return (directScheduleToolNames as readonly string[]).includes(name);
}

export function directScheduleTools(): readonly Tool[] {
  const scheduleId = {
    type: "string",
    pattern: "^[a-f0-9-]{36}$",
    description: "Exact scheduleId returned by omnicodex__schedule_create.",
  };
  const accessSchema = {
    type: "object" as const,
    properties: { scheduleId },
    required: ["scheduleId"],
    additionalProperties: false,
  };
  return [
    {
      name: "omnicodex__schedule_create",
      title: "Create an exact native durable schedule",
      description:
        "Schedule an available OmniCodex tool with its supplied arguments. Supported RRULEs are FREQ=MINUTELY with optional INTERVAL, or FREQ=DAILY with optional INTERVAL and required BYHOUR/BYMINUTE. The server preserves the owner, work session, and selected tool's execution behavior.",
      inputSchema: {
        type: "object",
        properties: {
          idempotencyKey: stableKeySchema(),
          timezone: {
            type: "string",
            minLength: 3,
            maxLength: 128,
            description: "Explicit IANA region/city, for example Asia/Seoul.",
          },
          rrule: { type: "string", minLength: 1, maxLength: 256 },
          startAtUnixMs: { type: "integer", minimum: 0 },
          toolName: { type: "string", minLength: 1, maxLength: 512 },
          arguments: { type: "object", additionalProperties: true },
          retry: {
            type: "object",
            properties: {
              maxAttempts: { type: "integer", minimum: 1, default: 1 },
              initialDelayMs: {
                type: "integer",
                minimum: 0,
                default: 1_000,
              },
              multiplier: { type: "number", minimum: 1, default: 2 },
              maxDelayMs: { type: "integer", minimum: 0, default: 60_000 },
            },
            additionalProperties: false,
          },
          misfire: {
            type: "object",
            properties: {
              mode: { enum: ["fire_once", "skip", "catch_up"], default: "catch_up" },
              graceMs: { type: "integer", minimum: 0, default: 300_000 },
              maxCatchUp: {
                type: "integer",
                minimum: 1,
                description:
                  "Optional caller-selected catch-up limit. Omit to retain every missed occurrence.",
              },
            },
            additionalProperties: false,
          },
        },
        required: ["idempotencyKey", "timezone", "rrule", "toolName", "arguments"],
        additionalProperties: false,
      },
      annotations: mutationAnnotations(),
      _meta: scheduleMetadata("schedule/create", "mutate"),
    },
    scheduleTool(
      "omnicodex__schedule_get",
      "Read one exact native schedule",
      accessSchema,
      "schedule/get",
      "read",
    ),
    {
      name: "omnicodex__schedule_list",
      title: "List exact native schedules",
      description: "List schedules only in the server-bound owner and work-session scope.",
      inputSchema: {
        type: "object",
        properties: {
          statuses: {
            type: "array",
            uniqueItems: true,
            items: { enum: ["active", "paused", "deleted"] },
          },
          limit: { type: "integer", minimum: 1 },
          cursor: { type: "string", minLength: 1, maxLength: 1_024 },
        },
        additionalProperties: false,
      },
      annotations: readAnnotations(),
      _meta: scheduleMetadata("schedule/list", "read"),
    },
    scheduleTool(
      "omnicodex__schedule_pause",
      "Pause one exact native schedule",
      accessSchema,
      "schedule/pause",
      "mutate",
    ),
    scheduleTool(
      "omnicodex__schedule_resume",
      "Resume one exact native schedule",
      accessSchema,
      "schedule/resume",
      "mutate",
    ),
    scheduleTool(
      "omnicodex__schedule_delete",
      "Delete one exact native schedule",
      accessSchema,
      "schedule/delete",
      "mutate",
    ),
    {
      name: "omnicodex__schedule_trigger",
      title: "Trigger one exact native schedule now",
      description:
        "Create one idempotent manual occurrence and execute it through DirectJobManager.",
      inputSchema: {
        type: "object",
        properties: { scheduleId, idempotencyKey: stableKeySchema() },
        required: ["scheduleId", "idempotencyKey"],
        additionalProperties: false,
      },
      annotations: mutationAnnotations(),
      _meta: scheduleMetadata("schedule/trigger", "mutate"),
    },
    {
      name: "omnicodex__schedule_runs",
      title: "List exact native schedule runs",
      description:
        "Read durable run, attempt, job, retry, misfire, and terminal state within the bound schedule scope.",
      inputSchema: {
        type: "object",
        properties: {
          scheduleId,
          statuses: {
            type: "array",
            uniqueItems: true,
            items: {
              enum: [
                "pending",
                "claimed",
                "dispatched",
                "retry_wait",
                "succeeded",
                "failed",
                "outcome_unknown",
                "cancelled",
                "misfired",
              ],
            },
          },
          limit: { type: "integer", minimum: 1 },
          cursor: { type: "string", minLength: 1, maxLength: 1_024 },
        },
        required: ["scheduleId"],
        additionalProperties: false,
      },
      annotations: readAnnotations(),
      _meta: scheduleMetadata("schedule/runs", "read"),
    },
  ];
}

export async function callDirectScheduleTool(
  manager: DirectScheduleManager,
  adapter: DirectJobDispatchAdapter,
  name: DirectScheduleToolName,
  args: Record<string, unknown>,
  context: DirectScheduleInvocationContext,
): Promise<CallToolResult> {
  switch (name) {
    case "omnicodex__schedule_create":
      return jsonResult(
        await manager.create(
          {
            idempotencyKey: requiredStableKey(args.idempotencyKey),
            timezone: requiredString(args.timezone, "timezone", 128),
            rrule: requiredString(args.rrule, "rrule", 256),
            ...(args.startAtUnixMs === undefined
              ? {}
              : { startAtUnixMs: requiredTimestamp(args.startAtUnixMs) }),
            toolName: requiredString(args.toolName, "toolName", 512),
            arguments: requiredObject(args.arguments, "arguments"),
            ...(args.retry === undefined ? {} : { retry: requiredObject(args.retry, "retry") }),
            ...(args.misfire === undefined
              ? {}
              : { misfire: requiredObject(args.misfire, "misfire") }),
          },
          context,
          adapter,
        ),
      );
    case "omnicodex__schedule_get": {
      const schedule = await manager.get({ scheduleId: requiredUuid(args.scheduleId) }, context);
      return schedule === undefined
        ? errorResult("DIRECT_SCHEDULE_NOT_FOUND")
        : jsonResult(schedule);
    }
    case "omnicodex__schedule_list":
      return jsonResult(await manager.list(listArguments(args), context));
    case "omnicodex__schedule_pause":
      return jsonResult(
        await manager.pause({ scheduleId: requiredUuid(args.scheduleId) }, context),
      );
    case "omnicodex__schedule_resume":
      return jsonResult(
        await manager.resume({ scheduleId: requiredUuid(args.scheduleId) }, context, adapter),
      );
    case "omnicodex__schedule_delete":
      return jsonResult(
        await manager.delete({ scheduleId: requiredUuid(args.scheduleId) }, context),
      );
    case "omnicodex__schedule_trigger":
      return jsonResult(
        await manager.trigger(
          {
            scheduleId: requiredUuid(args.scheduleId),
            idempotencyKey: requiredStableKey(args.idempotencyKey),
          },
          context,
          adapter,
        ),
      );
    case "omnicodex__schedule_runs":
      return jsonResult(
        await manager.runs(
          {
            scheduleId: requiredUuid(args.scheduleId),
            ...(args.statuses === undefined
              ? {}
              : { statuses: requiredRunStatuses(args.statuses) }),
            ...(args.limit === undefined ? {} : { limit: requiredLimit(args.limit) }),
            ...(args.cursor === undefined
              ? {}
              : { cursor: requiredString(args.cursor, "cursor", 1_024) }),
          },
          context,
        ),
      );
  }
}

function scopeFromContext(context: DirectScheduleInvocationContext): DirectScheduleScope {
  return {
    authorizationBinding: context.authorizationBinding,
    conversationId: context.directScheduleOwnerBinding,
    workSessionId: context.workSessionBinding,
  };
}

function scheduleJobIdempotencyKey(
  scheduleId: string,
  scheduledForUnixMs: number,
  attempt: number,
): string {
  return `schedule:${scheduleId}:${String(scheduledForUnixMs)}:${String(attempt)}`;
}

function scheduleTool(
  name: DirectScheduleToolName,
  title: string,
  inputSchema: Tool["inputSchema"],
  nativeName: string,
  stateEffect: "read" | "mutate",
): Tool {
  return {
    name,
    title,
    description: `${title} within the server-bound owner and work-session scope.`,
    inputSchema,
    annotations: stateEffect === "read" ? readAnnotations() : mutationAnnotations(),
    _meta: scheduleMetadata(nativeName, stateEffect),
  };
}

function scheduleMetadata(nativeName: string, stateEffect: "read" | "mutate") {
  return {
    omnicodex: {
      nativeName,
      nativeNamespace: "omnicodex",
      route: "omnicodex_schedule",
      modelEffect: "none",
      invokesModel: false,
      stateEffect,
      readOnly: stateEffect === "read",
      destructive: false,
      retryClass: "explicit_idempotency",
    },
  };
}

function readAnnotations() {
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  };
}

function mutationAnnotations() {
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  };
}

function stableKeySchema() {
  return {
    type: "string",
    minLength: 16,
    maxLength: 128,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
  };
}

function listArguments(args: Record<string, unknown>) {
  return {
    ...(args.statuses === undefined ? {} : { statuses: requiredScheduleStatuses(args.statuses) }),
    ...(args.limit === undefined ? {} : { limit: requiredLimit(args.limit) }),
    ...(args.cursor === undefined ? {} : { cursor: requiredString(args.cursor, "cursor", 1_024) }),
  };
}

function requiredScheduleStatuses(value: unknown): readonly DirectScheduleStatus[] {
  if (!Array.isArray(value)) throw new TypeError("statuses must be an array");
  const statuses = value.map((item) => {
    if (item !== "active" && item !== "paused" && item !== "deleted")
      throw new TypeError("statuses contains an invalid value");
    return item;
  });
  if (new Set(statuses).size !== statuses.length) throw new TypeError("statuses must be unique");
  return statuses;
}

function requiredRunStatuses(value: unknown): readonly DirectScheduleRunStatus[] {
  if (!Array.isArray(value)) throw new TypeError("statuses must be an array");
  const allowed = new Set<DirectScheduleRunStatus>([
    "pending",
    "claimed",
    "dispatched",
    "retry_wait",
    "succeeded",
    "failed",
    "outcome_unknown",
    "cancelled",
    "misfired",
  ]);
  const statuses = value.map((item) => {
    if (!allowed.has(item as DirectScheduleRunStatus))
      throw new TypeError("statuses contains an invalid value");
    return item as DirectScheduleRunStatus;
  });
  if (new Set(statuses).size !== statuses.length) throw new TypeError("statuses must be unique");
  return statuses;
}

function requiredObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${name} must be an object`);
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    /[\0\r\n]/u.test(value)
  )
    throw new TypeError(`${name} is invalid`);
  return value;
}

function requiredStableKey(value: unknown): string {
  const key = requiredString(value, "idempotencyKey", 128);
  if (key.length < 16 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(key))
    throw new TypeError("idempotencyKey is invalid");
  return key;
}

function requiredUuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[45][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)
  )
    throw new TypeError("scheduleId is invalid");
  return value;
}

function requiredTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError("startAtUnixMs is invalid");
  return value as number;
}

function requiredLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new TypeError("limit is invalid");
  return value as number;
}

function shutdownTimeout(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function settlesWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cancelTimeout = scheduleLongTimeout(timeoutMs, () => {
      if (settled) return;
      settled = true;
      resolve(false);
    });
    void operation.then(
      () => {
        if (settled) return;
        settled = true;
        cancelTimeout();
        resolve(true);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cancelTimeout();
        reject(error);
      },
    );
  });
}

function scheduleLongTimeout(timeoutMs: number, action: () => void): () => void {
  const startedAt = performance.now();
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    if (cancelled) return;
    const remainingMs = timeoutMs - (performance.now() - startedAt);
    if (remainingMs <= 0) {
      action();
      return;
    }
    timer = setTimeout(arm, Math.min(Math.ceil(remainingMs), MAX_NODE_TIMER_DELAY_MS));
    timer.unref?.();
  };
  arm();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)) || "Unknown error";
}

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent:
      typeof value === "object" && value !== null ? (value as Record<string, unknown>) : { value },
  };
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}
