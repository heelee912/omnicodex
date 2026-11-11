import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { structuredErrorDetails } from "../runtime/structured-error-details.js";
import type {
  DirectJobAccessInput,
  DirectJobCancelView,
  DirectJobScope,
  DirectJobStartInput,
  DirectJobStartView,
  DirectJobStatus,
  DirectJobStore,
  DirectJobTargetContract,
  DirectJobView,
} from "./direct-job-store.js";
import { validateDirectJobTargetContract } from "./direct-job-store.js";

export const directJobToolNames = [
  "omnicodex__job_start",
  "omnicodex__job_get",
  "omnicodex__job_list",
  "omnicodex__job_cancel",
] as const;

export type DirectJobToolName = (typeof directJobToolNames)[number];

export interface DirectJobInvocationContext {
  readonly authorizationBinding: string;
  /** Server-resolved durable owner-and-conversation identity. */
  readonly workSessionBinding: string;
  /** Server-resolved direct-job sub-binding; never selected by the remote model. */
  readonly directJobOwnerBinding: string;
  /** Server-resolved claimant identity for optional direct Goal evidence on a job target. */
  readonly directGoalClaimantBinding: string;
  /** Process-local MCP caller identity, used only for executor lifetime. */
  readonly callerSessionId: string;
}

export interface DirectJobDispatchRequest {
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly operationId: string;
  /** Stable authenticated owner identity used by the shared native scheduler. */
  readonly authorizationBinding: string;
  /** Stable Web conversation identity used by the shared native scheduler. */
  readonly workSessionBinding: string;
  /** Stable claimant used only when the exact target carries direct Goal evidence. */
  readonly directGoalClaimantBinding: string;
  readonly callerSessionId: string;
  /** Immutable target contract selected before the durable job was created. */
  readonly targetContract: DirectJobTargetContract;
  /** Must run at the scheduler's final pre-I/O boundary. */
  readonly beforeNativeDispatch: () => Promise<void>;
  readonly signal: AbortSignal;
}

export type DirectJobDispatchOutcome =
  | { readonly status: "succeeded"; readonly result: CallToolResult }
  | { readonly status: "failed"; readonly result: CallToolResult; readonly code?: string }
  | {
      readonly status: "outcome_unknown";
      readonly code: string;
      readonly message: string;
    }
  | { readonly status: "cancelled"; readonly code?: string; readonly message?: string };

export interface DirectJobDispatchAdapter {
  /** Resolve the selected tool's current contract and validate its arguments. */
  validate(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<DirectJobTargetContract> | DirectJobTargetContract;
  /** Uses the same first-class native dispatch/replay/scheduler boundary as a foreground call. */
  dispatch(request: DirectJobDispatchRequest): Promise<DirectJobDispatchOutcome>;
}

export interface DirectJobCallerDrainResult {
  readonly outcome: "idle" | "fenced";
}

interface ActiveDirectJob {
  readonly callerSessionId: string;
  readonly adapter: DirectJobDispatchAdapter;
  readonly controller: AbortController;
  readonly access: DirectJobAccessInput;
  readonly completion: Promise<void>;
}

interface DirectJobStartArguments {
  readonly idempotencyKey: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
}

/**
 * Gateway-wide runtime coordinator. A transport may disconnect while the
 * manager retains its adapter closure and executor lease until completion.
 */
export class DirectJobManager {
  readonly #store: DirectJobStore;
  readonly #active = new Map<string, ActiveDirectJob>();
  readonly #drainingAdapters = new WeakSet<DirectJobDispatchAdapter>();

  constructor(store: DirectJobStore) {
    this.#store = store;
  }

  get store(): DirectJobStore {
    return this.#store;
  }

  async start(
    input: DirectJobStartArguments,
    context: DirectJobInvocationContext,
    adapter: DirectJobDispatchAdapter,
  ): Promise<DirectJobStartView> {
    const args = cloneArguments(input.arguments);
    const storeInput: DirectJobStartInput = {
      authorizationBinding: context.authorizationBinding,
      conversationId: context.directJobOwnerBinding,
      workSessionId: context.workSessionBinding,
      idempotencyKey: input.idempotencyKey,
      toolName: input.toolName,
      arguments: args,
    };
    const existing = await this.#store.findExisting(storeInput);
    if (existing !== undefined) return existing;
    this.#assertAdapterAdmissionOpen(adapter);
    const targetContract = validateDirectJobTargetContract(
      await adapter.validate(input.toolName, args),
    );
    this.#assertAdapterAdmissionOpen(adapter);
    const pinnedStoreInput = { ...storeInput, targetContract };
    const acquisition = await this.#store.start(pinnedStoreInput);
    if (acquisition.disposition === "created") {
      if (this.#drainingAdapters.has(adapter)) {
        const job = await this.#store.fenceTerminal(
          accessInput(storeInput, acquisition.job.jobId),
          {
            code: "DIRECT_JOB_RUNTIME_DRAINING",
            message: "The exact native runtime began draining before this job could dispatch",
          },
        );
        return { ...acquisition, job };
      }
      this.#launch(pinnedStoreInput, acquisition.job, context, adapter, targetContract);
    }
    return acquisition;
  }

  get(
    input: Pick<DirectJobAccessInput, "jobId">,
    context: Pick<
      DirectJobInvocationContext,
      "authorizationBinding" | "directJobOwnerBinding" | "workSessionBinding"
    >,
  ): Promise<DirectJobView | undefined> {
    return this.#store.get({
      ...scopeFromContext(context),
      jobId: input.jobId,
    });
  }

  list(
    input: {
      readonly statuses?: readonly DirectJobStatus[];
      readonly limit?: number;
      readonly cursor?: string;
    },
    context: Pick<
      DirectJobInvocationContext,
      "authorizationBinding" | "directJobOwnerBinding" | "workSessionBinding"
    >,
  ) {
    return this.#store.list({ ...input, ...scopeFromContext(context) });
  }

  async cancel(
    input: Pick<DirectJobAccessInput, "jobId">,
    context: Pick<
      DirectJobInvocationContext,
      "authorizationBinding" | "directJobOwnerBinding" | "workSessionBinding"
    >,
  ): Promise<DirectJobCancelView> {
    const scoped = { ...scopeFromContext(context), jobId: input.jobId };
    const result = await this.#store.requestCancel(scoped);
    if (result.disposition === "cancelled" || result.disposition === "cancellation_requested") {
      this.#active
        .get(result.job.jobId)
        ?.controller.abort(
          new Error("Direct job cancellation was requested by its owner work session"),
        );
    }
    return result;
  }

  /** Keeps per-session native executors alive after the HTTP/MCP transport closes. */
  async waitForCallerIdle(callerSessionId: string): Promise<void> {
    const pending = [...this.#active.values()]
      .filter((active) => active.callerSessionId === callerSessionId)
      .map((active) => active.completion);
    await Promise.allSettled(pending);
  }

  /** Closes new-job admission for exactly one runtime-generation dispatcher. */
  beginAdapterDrain(adapter: DirectJobDispatchAdapter): void {
    this.#drainingAdapters.add(adapter);
  }

  /** Reopens one dispatcher only when its listener rollback is authoritative. */
  resumeAdapterAdmission(adapter: DirectJobDispatchAdapter): void {
    this.#drainingAdapters.delete(adapter);
  }

  async waitForAdapterIdle(adapter: DirectJobDispatchAdapter): Promise<void> {
    const pending = [...this.#active.values()]
      .filter((active) => active.adapter === adapter)
      .map((active) => active.completion);
    await Promise.allSettled(pending);
  }

  /**
   * Drains only jobs owned by one retiring runtime adapter. Transport closure
   * never calls this boundary; runtime switch/final shutdown does.
   */
  async drainAdapter(
    adapter: DirectJobDispatchAdapter,
    timeoutMs: number,
    error: { readonly code: string; readonly message: string },
  ): Promise<DirectJobCallerDrainResult> {
    assertDrainTimeout(timeoutMs);
    this.beginAdapterDrain(adapter);
    const deadline = drainDeadline(timeoutMs, true);
    const outcome = await Promise.race([
      this.waitForAdapterIdle(adapter).then(() => "idle" as const),
      deadline.promise,
    ]).finally(deadline.cancel);
    if (outcome === "idle") return { outcome };
    await this.fenceAdapterOutcomeUnknown(adapter, error);
    return { outcome: "fenced" };
  }

  /**
   * Gives one caller's retained native work a bounded graceful drain, then
   * establishes a durable terminal fence before releasing its executor.
   */
  async drainCaller(
    callerSessionId: string,
    timeoutMs: number,
    error: { readonly code: string; readonly message: string },
  ): Promise<DirectJobCallerDrainResult> {
    assertDrainTimeout(timeoutMs);
    const deadline = drainDeadline(timeoutMs, false);
    const outcome = await Promise.race([
      this.waitForCallerIdle(callerSessionId).then(() => "idle" as const),
      deadline.promise,
    ]).finally(deadline.cancel);
    if (outcome === "idle") return { outcome };
    await this.fenceCallerOutcomeUnknown(callerSessionId, error);
    return { outcome: "fenced" };
  }

  /** Abort only jobs whose adapter depends on the shutting-down runtime. */
  requestCallerCancellation(callerSessionId: string): void {
    for (const active of this.#active.values()) {
      if (active.callerSessionId === callerSessionId) {
        active.controller.abort(new Error("OmniCodex runtime is shutting down"));
      }
    }
  }

  /**
   * Establishes a durable terminal fence when a runtime-owned executor misses
   * its drain deadline. A queued job is cancelled before dispatch; a running
   * job is recorded as outcome_unknown. A late adapter result cannot overwrite
   * either terminal state.
   */
  async fenceCallerOutcomeUnknown(
    callerSessionId: string,
    error: { readonly code: string; readonly message: string },
  ): Promise<void> {
    const targets = [...this.#active.entries()].filter(
      ([, active]) => active.callerSessionId === callerSessionId,
    );
    await Promise.all(
      targets.map(async ([jobId, active]) => {
        active.controller.abort(new Error(error.message));
        await this.#store.fenceTerminal(active.access, error);
        if (this.#active.get(jobId) === active) this.#active.delete(jobId);
      }),
    );
  }

  async fenceAdapterOutcomeUnknown(
    adapter: DirectJobDispatchAdapter,
    error: { readonly code: string; readonly message: string },
  ): Promise<void> {
    const targets = [...this.#active.entries()].filter(([, active]) => active.adapter === adapter);
    await Promise.all(
      targets.map(async ([jobId, active]) => {
        active.controller.abort(new Error(error.message));
        await this.#store.fenceTerminal(active.access, error);
        if (this.#active.get(jobId) === active) this.#active.delete(jobId);
      }),
    );
  }

  #assertAdapterAdmissionOpen(adapter: DirectJobDispatchAdapter): void {
    if (this.#drainingAdapters.has(adapter)) {
      throw new Error("DIRECT_JOB_RUNTIME_DRAINING");
    }
  }

  #launch(
    input: DirectJobStartInput,
    job: DirectJobView,
    context: DirectJobInvocationContext,
    adapter: DirectJobDispatchAdapter,
    targetContract: DirectJobTargetContract,
  ): void {
    const callerSessionId = context.callerSessionId;
    const controller = new AbortController();
    const access = accessInput(input, job.jobId);
    let nativeDispatchStarted = false;
    const completion = Promise.resolve()
      .then(async () => {
        const beforeDispatch = await this.#store.get(access);
        if (beforeDispatch?.status !== "queued") return;
        let outcome: DirectJobDispatchOutcome;
        try {
          outcome = await adapter.dispatch({
            toolName: input.toolName,
            arguments: input.arguments,
            operationId: job.operationId,
            authorizationBinding: context.authorizationBinding,
            workSessionBinding: context.workSessionBinding,
            directGoalClaimantBinding: context.directGoalClaimantBinding,
            callerSessionId,
            targetContract,
            beforeNativeDispatch: async () => {
              if (nativeDispatchStarted) {
                throw new Error(
                  "DIRECT_JOB_DISPATCH_PROTOCOL_VIOLATION: duplicate dispatch marker",
                );
              }
              await this.#store.markRunning(access);
              nativeDispatchStarted = true;
            },
            signal: controller.signal,
          });
        } catch (error) {
          const current = await this.#store.get(access);
          if (current?.status === "queued") {
            await this.#store.failBeforeDispatch(
              access,
              directJobError(error, "DIRECT_JOB_DISPATCH_EXCEPTION_BEFORE_NATIVE"),
            );
          } else if (controller.signal.aborted && current?.cancelRequestedAtUnixMs !== undefined) {
            await this.#store.finishCancelled(access, {
              code: "DIRECT_JOB_CANCELLED",
              message: "Native dispatch acknowledged cancellation without a terminal result",
            });
          } else if (current?.status === "running") {
            await this.#store.markOutcomeUnknown(
              access,
              directJobError(error, "DIRECT_JOB_DISPATCH_EXCEPTION"),
            );
          }
          return;
        }
        if (!nativeDispatchStarted) {
          await this.#finishBeforeNativeDispatch(access, outcome);
          return;
        }
        switch (outcome.status) {
          case "succeeded":
            await this.#store.succeed(access, outcome.result);
            return;
          case "failed":
            await this.#store.fail(
              access,
              {
                code: outcome.code ?? "DIRECT_JOB_NATIVE_TOOL_ERROR",
                message: firstText(outcome.result) ?? "Native direct tool returned an error result",
              },
              outcome.result,
            );
            return;
          case "outcome_unknown":
            await this.#store.markOutcomeUnknown(
              access,
              directJobError(outcome, outcome.code, outcome.message),
            );
            return;
          case "cancelled": {
            const current = await this.#store.get(access);
            if (current?.cancelRequestedAtUnixMs === undefined) {
              await this.#store.requestCancel(access);
            }
            await this.#store.finishCancelled(
              access,
              directJobError(
                outcome,
                outcome.code ?? "DIRECT_JOB_CANCELLED",
                outcome.message ?? "Native direct tool acknowledged cancellation",
              ),
            );
          }
        }
      })
      .catch(async (error) => {
        const current = await this.#store.get(access).catch(() => undefined);
        if (current?.status !== "running") return;
        await this.#store
          .markOutcomeUnknown(access, directJobError(error, "DIRECT_JOB_STATE_COMMIT_FAILED"))
          .catch(() => undefined);
      })
      .finally(() => {
        if (this.#active.get(job.jobId)?.completion === completion) this.#active.delete(job.jobId);
      });
    this.#active.set(job.jobId, { callerSessionId, adapter, controller, access, completion });
  }

  async #finishBeforeNativeDispatch(
    access: DirectJobAccessInput,
    outcome: DirectJobDispatchOutcome,
  ): Promise<void> {
    const current = await this.#store.get(access);
    if (current?.status !== "queued") return;
    if (outcome.status === "cancelled") {
      await this.#store.requestCancel(access);
      return;
    }
    if (outcome.status === "failed") {
      await this.#store.failBeforeDispatch(
        access,
        {
          code: outcome.code ?? "DIRECT_JOB_NATIVE_REJECTED_BEFORE_DISPATCH",
          message:
            firstText(outcome.result) ?? "Native direct tool rejected the job before dispatch",
        },
        outcome.result,
      );
      return;
    }
    await this.#store.failBeforeDispatch(access, {
      code: "DIRECT_JOB_DISPATCH_PROTOCOL_VIOLATION",
      message: `Native adapter returned ${outcome.status} without marking native dispatch`,
    });
  }
}

export function isDirectJobTool(name: string): name is DirectJobToolName {
  return (directJobToolNames as readonly string[]).includes(name);
}

/** Full-surface only, model-free controls for durable native direct execution. */
export function directJobTools(): readonly Tool[] {
  const access = {
    jobId: {
      type: "string",
      pattern: "^[a-f0-9-]{36}$",
      description: "Exact jobId returned by omnicodex__job_start.",
    },
  };
  return [
    {
      name: "omnicodex__job_start",
      title: "Start a durable native direct job",
      description:
        "Run an available OmniCodex tool in the background with its supplied arguments. The job survives MCP/Web disconnects and retains the selected tool's execution behavior. Reuse idempotencyKey only for the same target and arguments.",
      inputSchema: {
        type: "object",
        properties: {
          idempotencyKey: {
            type: "string",
            minLength: 16,
            maxLength: 128,
            pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
          },
          toolName: {
            type: "string",
            minLength: 1,
            maxLength: 512,
            description: "Exact advertised first-class direct tool name; aliases are rejected.",
          },
          arguments: { type: "object", additionalProperties: true },
        },
        required: ["idempotencyKey", "toolName", "arguments"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: directJobMetadata("job/start", "mutate"),
    },
    {
      name: "omnicodex__job_get",
      title: "Read one durable native direct job",
      description:
        "Read one job and its durable terminal result within the exact owner, conversation, and work-session boundary.",
      inputSchema: {
        type: "object",
        properties: access,
        required: ["jobId"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: directJobMetadata("job/get", "read"),
    },
    {
      name: "omnicodex__job_list",
      title: "List durable native direct jobs",
      description:
        "List jobs only within the exact owner, conversation, and work-session boundary, newest first.",
      inputSchema: {
        type: "object",
        properties: {
          statuses: {
            type: "array",
            uniqueItems: true,
            items: {
              enum: ["queued", "running", "succeeded", "failed", "outcome_unknown", "cancelled"],
            },
          },
          limit: { type: "integer", minimum: 1 },
          cursor: { type: "string", minLength: 1, maxLength: 1024 },
        },
        required: [],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: directJobMetadata("job/list", "read"),
    },
    {
      name: "omnicodex__job_cancel",
      title: "Cancel a durable native direct job",
      description:
        "Cancel a queued job authoritatively or request AbortSignal cancellation for a running native job. A running job remains non-terminal until native dispatch acknowledges cancellation or returns a result.",
      inputSchema: {
        type: "object",
        properties: access,
        required: ["jobId"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: directJobMetadata("job/cancel", "mutate"),
    },
  ];
}

export async function callDirectJobTool(
  manager: DirectJobManager,
  adapter: DirectJobDispatchAdapter,
  name: DirectJobToolName,
  args: Record<string, unknown>,
  context: DirectJobInvocationContext,
): Promise<CallToolResult> {
  switch (name) {
    case "omnicodex__job_start":
      return jsonResult(
        await manager.start(
          {
            idempotencyKey: requiredIdentifier(args.idempotencyKey, "idempotencyKey", 128, 16),
            toolName: requiredToolName(args.toolName),
            arguments: cloneArguments(args.arguments),
          },
          context,
          adapter,
        ),
      );
    case "omnicodex__job_get": {
      const job = await manager.get({ jobId: requiredJobId(args.jobId) }, context);
      return job === undefined ? errorResult("DIRECT_JOB_NOT_FOUND") : jsonResult(job);
    }
    case "omnicodex__job_list":
      return jsonResult(
        await manager.list(
          {
            ...(args.statuses === undefined ? {} : { statuses: requiredStatuses(args.statuses) }),
            ...(args.limit === undefined ? {} : { limit: requiredLimit(args.limit) }),
            ...(args.cursor === undefined
              ? {}
              : { cursor: requiredOpaque(args.cursor, "cursor", 1_024) }),
          },
          context,
        ),
      );
    case "omnicodex__job_cancel":
      return jsonResult(await manager.cancel({ jobId: requiredJobId(args.jobId) }, context));
  }
}

function accessInput(input: DirectJobScope, jobId: string): DirectJobAccessInput {
  return {
    authorizationBinding: input.authorizationBinding,
    conversationId: input.conversationId,
    workSessionId: input.workSessionId,
    jobId,
  };
}

function scopeFromContext(
  context: Pick<
    DirectJobInvocationContext,
    "authorizationBinding" | "directJobOwnerBinding" | "workSessionBinding"
  >,
): DirectJobScope {
  return {
    authorizationBinding: context.authorizationBinding,
    conversationId: context.directJobOwnerBinding,
    workSessionId: context.workSessionBinding,
  };
}

function directJobMetadata(nativeName: string, stateEffect: "read" | "mutate") {
  return {
    omnicodex: {
      nativeName,
      nativeNamespace: "omnicodex",
      route: "omnicodex_job",
      modelEffect: "none",
      invokesModel: false,
      stateEffect,
      readOnly: stateEffect === "read",
      destructive: false,
      retryClass: "explicit_idempotency",
    },
  };
}

function requiredStatuses(value: unknown): readonly DirectJobStatus[] {
  if (!Array.isArray(value)) throw new TypeError("statuses must be an array");
  const statuses = value.map((status) => {
    if (
      status !== "queued" &&
      status !== "running" &&
      status !== "succeeded" &&
      status !== "failed" &&
      status !== "outcome_unknown" &&
      status !== "cancelled"
    ) {
      throw new TypeError("statuses contains an invalid direct job status");
    }
    return status;
  });
  if (new Set(statuses).size !== statuses.length) throw new TypeError("statuses must be unique");
  return statuses;
}

function requiredLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError("limit must be a positive safe integer");
  }
  return value as number;
}

function requiredJobId(value: unknown): string {
  const text = requiredOpaque(value, "jobId", 128);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(text)) {
    throw new TypeError("jobId is invalid");
  }
  return text;
}

function requiredToolName(value: unknown): string {
  const text = requiredOpaque(value, "toolName", 512);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u.test(text)) {
    throw new TypeError("toolName must be an exact first-class tool name");
  }
  return text;
}

function requiredIdentifier(value: unknown, name: string, maximum: number, minimum = 1): string {
  const text = requiredOpaque(value, name, maximum);
  if (text.length < minimum || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(text)) {
    throw new TypeError(`${name} must be a stable identifier`);
  }
  return text;
}

function requiredOpaque(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`${name} must contain between 1 and ${String(maximum)} safe characters`);
  }
  return value;
}

function cloneArguments(value: unknown): Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) throw new TypeError("arguments must be an object");
  const cloned = JSON.parse(JSON.stringify(value)) as unknown;
  if (!isObject(cloned) || Array.isArray(cloned))
    throw new TypeError("arguments must be an object");
  return cloned;
}

function firstText(result: CallToolResult): string | undefined {
  const text = result.content.find((item) => item.type === "text");
  return text?.type === "text" ? text.text : undefined;
}

function errorCode(error: unknown, fallback: string): string {
  if (isObject(error) && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_:-]*$/u.test(code)) return code;
  }
  const message = errorMessage(error);
  const prefix = /^([A-Z][A-Z0-9_:-]*)(?::|$)/u.exec(message)?.[1];
  return prefix ?? fallback;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || "Unknown error";
  if (isObject(error) && typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }
  return String(error) || "Unknown error";
}

function directJobError(
  error: unknown,
  fallbackCode: string,
  message = errorMessage(error),
): {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
} {
  return {
    code: errorCode(error, fallbackCode),
    message,
    details: structuredErrorDetails(error),
  };
}

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

function assertDrainTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("timeoutMs must be a positive safe integer");
  }
}

/**
 * Node clamps an oversized setTimeout delay to one millisecond. Chaining timer
 * frames preserves a caller-selected deadline without turning a long drain
 * into an immediate outcome-unknown fence.
 */
function drainDeadline(
  timeoutMs: number,
  unref: boolean,
): { readonly promise: Promise<"timeout">; readonly cancel: () => void } {
  let cancelled = false;
  let timer: NodeJS.Timeout | undefined;
  const startedAt = performance.now();
  let resolveDeadline!: (value: "timeout") => void;
  const promise = new Promise<"timeout">((resolve) => {
    resolveDeadline = resolve;
  });
  const schedule = (): void => {
    if (cancelled) return;
    const remainingMs = timeoutMs - (performance.now() - startedAt);
    if (remainingMs <= 0) {
      resolveDeadline("timeout");
      return;
    }
    const delayMs = Math.min(Math.ceil(remainingMs), MAX_NODE_TIMER_DELAY_MS);
    timer = setTimeout(() => {
      schedule();
    }, delayMs);
    if (unref) timer.unref?.();
  };
  schedule();
  return {
    promise,
    cancel: () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: isObject(value) ? value : { value },
  };
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
