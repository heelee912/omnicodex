import { createHash } from "node:crypto";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  canonicalNativeResourceKeys,
  type NativeExecutionOrdering,
  nativeExecutionOrderingFromArguments,
} from "../../application/native-execution-scheduler.js";
import { canonicalJson } from "../safety/canonical-json.js";
import type {
  DirectGoalClaimView,
  DirectGoalExecutionReceiptInput,
  DirectGoalExecutionReservationInput,
  DirectGoalExecutionReservationView,
  DirectGoalState,
  DirectGoalStepInput,
  DirectGoalStore,
} from "./direct-goal-store.js";

export const DIRECT_GOAL_CONTEXT_FIELD = "omnicodexGoalContext";

const DIRECT_GOAL_CONTEXT_VERSION = 1;
const DIRECT_GOAL_CONTEXT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,2048}$/u;

export const directGoalToolNames = [
  "omnicodex__goal_create",
  "omnicodex__goal_get",
  "omnicodex__goal_list",
  "omnicodex__goal_claim_next_step",
  "omnicodex__goal_complete",
  "omnicodex__goal_update",
  "omnicodex__goal_delete",
] as const;

export type DirectGoalToolName = (typeof directGoalToolNames)[number];

export interface DirectGoalInvocationContext {
  readonly goalId: string;
  readonly stepId: string;
  readonly claimToken?: string;
  readonly claimTokenDigest?: string;
  readonly role: "work" | "readback";
  readonly provesOperationId?: string;
}

export interface ParsedDirectGoalArguments {
  readonly arguments: Record<string, unknown>;
  readonly goal?: DirectGoalInvocationContext;
}

export interface DirectGoalExecutionRecord {
  readonly authorizationBinding: string;
  readonly claimantBinding: string;
  readonly context: DirectGoalInvocationContext;
  readonly operationId: string;
  readonly toolName: string;
  readonly targetIdentity: string;
  readonly stateEffect: "none" | "read" | "mutate";
  readonly modelEffect: "none" | "model" | "unknown";
  readonly outcome: "succeeded" | "tool_error" | "failed";
  readonly arguments: Record<string, unknown>;
  readonly result: CallToolResult;
}

export type DirectGoalExecutionAuthorization = Omit<
  DirectGoalExecutionRecord,
  "outcome" | "result"
>;

export function isDirectGoalTool(name: string): name is DirectGoalToolName {
  return (directGoalToolNames as readonly string[]).includes(name);
}

/** Goal ownership includes the server-resolved conversation, never a transport or caller argument. */
export function directGoalOwnerBinding(
  authorizationBinding: string,
  workSessionBinding: string,
): string {
  if (authorizationBinding.trim().length === 0 || workSessionBinding.trim().length === 0) {
    throw new Error("DURABLE_WORK_SESSION_UNAVAILABLE");
  }
  return [
    "omnicodex-goal-owner-v1",
    digest(authorizationBinding),
    digest(workSessionBinding),
    "conversation",
  ].join("\0");
}

/** Goal controls for the authenticated Chat conversation. */
export function directGoalTools(): readonly Tool[] {
  return [
    {
      name: "omnicodex__goal_create",
      description: "Set the Goal for this Chat conversation",
      inputSchema: {
        type: "object",
        properties: {
          idempotencyKey: {
            type: "string",
            minLength: 16,
            maxLength: 128,
            pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
          },
          objective: {
            type: "string",
            minLength: 1,
            description: "Goal objective.",
          },
          steps: {
            type: "array",
            minItems: 1,
            description: "Optional Goal steps.",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  minLength: 1,
                  maxLength: 256,
                  pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
                },
                description: { type: "string", minLength: 1 },
              },
              required: ["id", "description"],
              additionalProperties: false,
            },
          },
        },
        required: ["objective"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: directGoalMetadata("goal/create", "mutate"),
    },
    {
      name: "omnicodex__goal_get",
      description: "Get a Goal",
      inputSchema: {
        ...goalIdSchema(),
        properties: {
          goalId: goalIdProperty(),
          conversationUrl: { type: "string", minLength: 1, description: "Chat conversation URL." },
        },
        required: [],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: directGoalMetadata("goal/get", "read"),
    },
    {
      name: "omnicodex__goal_list",
      description: "List manageable Goals across this account's Chat conversations",
      inputSchema: {
        type: "object",
        properties: {
          states: {
            type: "array",
            uniqueItems: true,
            items: { enum: ["active", "paused", "completed", "blocked"] },
            description: "Optional Goal states to include.",
          },
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
      _meta: directGoalMetadata("goal/list", "read"),
    },
    {
      name: "omnicodex__goal_claim_next_step",
      description: "Claim the next Goal step",
      inputSchema: {
        type: "object",
        properties: {
          goalId: goalIdProperty(),
          leaseMs: { type: "integer", minimum: 1, default: 300000 },
        },
        required: ["goalId"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: directGoalMetadata("goal/claim_next_step", "mutate"),
    },
    {
      name: "omnicodex__goal_complete",
      description: "Complete a Goal",
      inputSchema: goalIdSchema(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: directGoalMetadata("goal/complete", "mutate"),
    },
    {
      name: "omnicodex__goal_update",
      description: "Update a Goal",
      inputSchema: {
        type: "object",
        properties: {
          goalId: goalIdProperty(),
          objective: {
            type: "string",
            minLength: 1,
            description: "Goal objective.",
          },
          status: { enum: ["active", "complete", "paused", "blocked"] },
          reason: {
            type: "string",
            minLength: 1,
          },
        },
        required: ["goalId"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: directGoalMetadata("goal/update", "mutate"),
    },
    {
      name: "omnicodex__goal_delete",
      description: "Delete a Goal",
      inputSchema: goalIdSchema(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: directGoalMetadata("goal/delete", "mutate"),
    },
  ];
}

/**
 * Keep native schemas byte-for-byte native. Goal claims are associated with
 * the exact authenticated durable work session by the server, not copied into
 * every action contract. The reserved-name check only prevents a native tool
 * from colliding with the legacy token parser during a rolling upgrade.
 */
export function withDirectGoalContext(tool: Tool): Tool {
  if (isDirectGoalTool(tool.name)) return tool;
  const schema = tool.inputSchema;
  if (schema.type !== "object") return tool;
  const properties = isObject(schema.properties) ? schema.properties : {};
  if (Object.hasOwn(properties, DIRECT_GOAL_CONTEXT_FIELD)) {
    throw new Error(
      `Native tool ${tool.name} conflicts with reserved field ${DIRECT_GOAL_CONTEXT_FIELD}`,
    );
  }
  return tool;
}

export function splitDirectGoalContext(args: Record<string, unknown>): ParsedDirectGoalArguments {
  if (!Object.hasOwn(args, DIRECT_GOAL_CONTEXT_FIELD)) return { arguments: args };
  const raw = args[DIRECT_GOAL_CONTEXT_FIELD];
  const nativeArguments = { ...args };
  delete nativeArguments[DIRECT_GOAL_CONTEXT_FIELD];
  return {
    arguments: nativeArguments,
    goal: decodeDirectGoalContextToken(raw),
  };
}

/**
 * Encode the exact Goal claim into a compact copy-safe token. Authorization,
 * claimant, lease, role, and readback proof are still authoritatively checked
 * by DirectGoalStore before any native I/O is dispatched.
 */
export function encodeDirectGoalContextToken(context: DirectGoalInvocationContext): string {
  const role = context.role === "work" ? "w" : "r";
  const payload = [
    DIRECT_GOAL_CONTEXT_VERSION,
    requiredIdentifier(context.goalId, "goalId"),
    requiredIdentifier(context.stepId, "stepId"),
    requiredToken(context.claimToken, "claimToken"),
    role,
    ...(context.provesOperationId === undefined
      ? []
      : [requiredIdentifier(context.provesOperationId, "provesOperationId")]),
  ];
  if ((context.role === "readback") !== (context.provesOperationId !== undefined)) {
    throw new Error("Goal readback context must identify the work operation it proves");
  }
  return Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
}

export async function callDirectGoalTool(
  store: DirectGoalStore,
  name: DirectGoalToolName,
  args: Record<string, unknown>,
  authorizationBinding: string,
  claimantBinding: string,
  managementAuthorizationBindings: readonly string[] = [authorizationBinding],
): Promise<CallToolResult> {
  switch (name) {
    case "omnicodex__goal_create":
      return jsonResult(
        await store.create({
          authorizationBinding,
          ...(args.idempotencyKey === undefined
            ? {}
            : {
                idempotencyKey: requiredIdentifier(args.idempotencyKey, "idempotencyKey", 128, 16),
              }),
          objective: requiredString(args.objective, "objective"),
          ...(args.steps === undefined ? {} : { steps: parseSteps(args.steps) }),
        }),
      );
    case "omnicodex__goal_get": {
      const goal = await store.get(
        authorizationBinding,
        args.goalId === undefined ? undefined : requiredIdentifier(args.goalId, "goalId"),
      );
      return goal === undefined ? errorResult("DIRECT_GOAL_NOT_FOUND") : jsonResult(goal);
    }
    case "omnicodex__goal_list": {
      const goals = await store.list(
        managementAuthorizationBindings,
        args.states === undefined ? undefined : goalStates(args.states),
      );
      return jsonResult({
        goals,
        total: goals.length,
        counts: {
          active: goals.filter((goal) => goal.state === "active").length,
          paused: goals.filter((goal) => goal.state === "paused").length,
          completed: goals.filter((goal) => goal.state === "completed").length,
          blocked: goals.filter((goal) => goal.state === "blocked").length,
        },
      });
    }
    case "omnicodex__goal_claim_next_step": {
      const claim = await store.claimNext({
        authorizationBinding,
        claimantBinding,
        goalId: requiredIdentifier(args.goalId, "goalId"),
        ...(args.leaseMs === undefined ? {} : { leaseMs: requiredLease(args.leaseMs) }),
      });
      return jsonResult(
        claim === undefined
          ? undefined
          : {
              ...claim,
              [DIRECT_GOAL_CONTEXT_FIELD]: encodeDirectGoalContextToken(
                directGoalInvocationContext(claim),
              ),
            },
      );
    }
    case "omnicodex__goal_complete":
      return jsonResult(
        await store.complete({
          authorizationBinding,
          goalId: requiredIdentifier(args.goalId, "goalId"),
        }),
      );
    case "omnicodex__goal_update": {
      const status = args.status;
      if (
        status !== undefined &&
        status !== "active" &&
        status !== "complete" &&
        status !== "paused" &&
        status !== "blocked"
      )
        throw new Error("DIRECT_GOAL_STATUS_INVALID");
      return jsonResult(
        await store.updateStatus({
          authorizationBinding,
          goalId: requiredIdentifier(args.goalId, "goalId"),
          ...(args.objective === undefined
            ? {}
            : { objective: requiredString(args.objective, "objective") }),
          ...(status === undefined ? {} : { status }),
          ...(args.reason === undefined ? {} : { reason: requiredString(args.reason, "reason") }),
        }),
      );
    }
    case "omnicodex__goal_delete":
      return jsonResult(
        await store.delete({
          authorizationBinding,
          goalId: requiredIdentifier(args.goalId, "goalId"),
        }),
      );
  }
}

/** Atomically binds an exact operation identity before native dispatch. */
export async function beginDirectGoalExecution(
  store: DirectGoalStore,
  input: DirectGoalExecutionAuthorization,
): Promise<DirectGoalExecutionReservationView> {
  return store.beginExecution(reservationInput(input));
}

/** Call immediately before invoking native I/O, after all pre-dispatch checks pass. */
export async function markDirectGoalExecutionDispatched(
  store: DirectGoalStore,
  input: DirectGoalExecutionAuthorization,
): Promise<DirectGoalExecutionReservationView> {
  return store.markExecutionDispatched(reservationInput(input));
}

/** Release an exact reservation only when native I/O demonstrably never started. */
export async function abortDirectGoalExecutionBeforeDispatch(
  store: DirectGoalStore,
  input: DirectGoalExecutionAuthorization,
): Promise<void> {
  await store.abortBeforeDispatch(reservationInput(input));
}

/** Preserve the reservation when timeout/disconnect makes the native result ambiguous. */
export async function markDirectGoalExecutionOutcomeUnknown(
  store: DirectGoalStore,
  input: DirectGoalExecutionAuthorization,
): Promise<DirectGoalExecutionReservationView> {
  return store.markExecutionOutcomeUnknown(reservationInput(input));
}

/** Finalize only the server-observed result for the exact durable reservation. */
export async function finalizeDirectGoalExecution(
  store: DirectGoalStore,
  input: DirectGoalExecutionRecord,
): Promise<void> {
  const reservation = reservationInput(input);
  const receipt: DirectGoalExecutionReceiptInput = {
    ...reservation,
    resultDigest: digest(input.result),
    outcome: input.outcome,
  };
  await store.finalizeExecution(receipt);
}

/** @deprecated Use beginDirectGoalExecution. */
export const authorizeDirectGoalExecution = beginDirectGoalExecution;

/** @deprecated Use finalizeDirectGoalExecution. */
export const recordDirectGoalExecution = finalizeDirectGoalExecution;

function reservationInput(
  input: DirectGoalExecutionAuthorization,
): DirectGoalExecutionReservationInput {
  const ordering = nativeExecutionOrderingFromArguments(input.arguments);
  return {
    authorizationBinding: input.authorizationBinding,
    claimantBinding: input.claimantBinding,
    goalId: input.context.goalId,
    stepId: input.context.stepId,
    role: input.context.role,
    operationId: input.operationId,
    toolName: input.toolName,
    targetIdentity: input.targetIdentity,
    resourceDigest: directGoalResourceDigest(ordering, input.targetIdentity, input.context.role),
    stateEffect: input.stateEffect,
    modelEffect: input.modelEffect,
    ...(input.context.provesOperationId === undefined
      ? {}
      : { provesOperationId: input.context.provesOperationId }),
    ...(input.context.claimToken === undefined ? {} : { claimToken: input.context.claimToken }),
    ...(input.context.claimTokenDigest === undefined
      ? {}
      : { claimTokenDigest: input.context.claimTokenDigest }),
  };
}

export function directGoalResourceDigest(
  ordering: NativeExecutionOrdering,
  fallbackTargetIdentity: string,
  role: DirectGoalInvocationContext["role"] = "work",
): string {
  const resourceKeys = directGoalEvidenceResourceKeys(canonicalNativeResourceKeys(ordering), role);
  return digest(
    resourceKeys.length > 0 ? { resourceKeys } : { targetIdentity: fallbackTargetIdentity },
  );
}

/**
 * A generic command is intentionally serialized at its explicit workspace root.
 * Its later readback can be a narrower file read inside that same workspace.  For
 * readback only, collapse descendant file/scene keys under an explicit workspace
 * or project scope so the proof binds to the already-recorded broader mutation
 * resource.  Files outside every declared scope remain in the digest and cannot
 * satisfy the broader receipt.
 */
function directGoalEvidenceResourceKeys(
  resourceKeys: readonly string[],
  role: DirectGoalInvocationContext["role"],
): readonly string[] {
  if (role !== "readback") return resourceKeys;
  const roots = resourceKeys.flatMap((key) => {
    const match = /^0:(?:workspace|project):(.*)$/u.exec(key);
    return match?.[1] === undefined ? [] : [match[1]];
  });
  if (roots.length === 0) return resourceKeys;
  return resourceKeys.filter((key) => {
    const match = /^3:(?:file|scene):(.*)$/u.exec(key);
    if (match?.[1] === undefined) return true;
    return !roots.some((root) => sameOrDescendantWindowsPath(match[1] as string, root));
  });
}

function sameOrDescendantWindowsPath(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}\\`);
}

function directGoalMetadata(nativeName: string, stateEffect: "read" | "mutate") {
  return {
    omnicodex: {
      nativeName,
      nativeNamespace: "omnicodex",
      route: "omnicodex_goal",
      modelEffect: "none",
      invokesModel: false,
      stateEffect,
      readOnly: stateEffect === "read",
      destructive: false,
      retryClass: stateEffect === "read" ? "read_once" : "explicit_idempotency",
    },
  };
}

function goalIdSchema() {
  return {
    type: "object" as const,
    properties: { goalId: goalIdProperty() },
    required: ["goalId"],
    additionalProperties: false,
  };
}

function goalIdProperty() {
  return {
    type: "string",
    minLength: 1,
    maxLength: 256,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
  };
}

function goalStates(value: unknown): readonly DirectGoalState[] {
  if (!Array.isArray(value)) throw new Error("states must be an array");
  const states = value.map((state) => {
    if (state !== "active" && state !== "paused" && state !== "completed" && state !== "blocked")
      throw new Error("DIRECT_GOAL_STATUS_INVALID");
    return state;
  });
  if (new Set(states).size !== states.length) throw new Error("states must be unique");
  return states;
}

function parseSteps(value: unknown): readonly DirectGoalStepInput[] {
  if (!Array.isArray(value)) throw new Error("steps must be an array");
  return value.map((raw, index) => {
    if (!isObject(raw)) throw new Error(`steps[${String(index)}] must be an object`);
    const mode = raw.mode ?? "successful_call";
    if (mode !== "successful_call" && mode !== "mutation_and_readback") {
      throw new Error(`steps[${String(index)}].mode is invalid`);
    }
    const allowedToolNames = raw.allowedToolNames;
    if (allowedToolNames !== undefined && !Array.isArray(allowedToolNames)) {
      throw new Error(`steps[${String(index)}].allowedToolNames must be an array`);
    }
    return {
      id: requiredIdentifier(raw.id, `steps[${String(index)}].id`),
      description: requiredString(raw.description, `steps[${String(index)}].description`),
      mode,
      ...(allowedToolNames === undefined
        ? {}
        : {
            allowedToolNames: allowedToolNames.map((name, toolIndex) =>
              requiredIdentifier(
                name,
                `steps[${String(index)}].allowedToolNames[${String(toolIndex)}]`,
              ),
            ),
          }),
    };
  });
}

function requiredLease(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error("leaseMs must be a positive safe integer");
  }
  return value as number;
}

function requiredString(value: unknown, name: string, maximum?: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const text = value.trim();
  if (text.length === 0 || (maximum !== undefined && text.length > maximum) || /\0/u.test(text)) {
    throw new Error(
      maximum === undefined
        ? `${name} must be a non-empty string without NUL characters`
        : `${name} must contain between 1 and ${maximum} characters`,
    );
  }
  return text;
}

function requiredIdentifier(value: unknown, name: string, maximum = 256, minimum = 1): string {
  const text = requiredString(value, name, maximum);
  if (
    text.length < minimum ||
    !new RegExp(
      `^[A-Za-z0-9][A-Za-z0-9._:/-]{${String(minimum - 1)},${String(maximum - 1)}}$`,
      "u",
    ).test(text)
  ) {
    throw new Error(`${name} is not a valid stable identifier`);
  }
  return text;
}

function optionalIdentifier(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requiredIdentifier(value, name);
}

function decodeDirectGoalContextToken(value: unknown): DirectGoalInvocationContext {
  if (typeof value !== "string" || !DIRECT_GOAL_CONTEXT_TOKEN_PATTERN.test(value)) {
    throw new Error(`${DIRECT_GOAL_CONTEXT_FIELD} must be a valid Goal action token`);
  }
  let decoded: unknown;
  try {
    const json = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(json, "utf8").toString("base64url") !== value) throw new Error("non-canonical");
    decoded = JSON.parse(json);
  } catch {
    throw new Error(`${DIRECT_GOAL_CONTEXT_FIELD} must be a valid Goal action token`);
  }
  if (!Array.isArray(decoded) || (decoded.length !== 5 && decoded.length !== 6)) {
    throw new Error(`${DIRECT_GOAL_CONTEXT_FIELD} must be a valid Goal action token`);
  }
  const [version, goalId, stepId, claimToken, compactRole, rawProof] = decoded;
  if (version !== DIRECT_GOAL_CONTEXT_VERSION || (compactRole !== "w" && compactRole !== "r")) {
    throw new Error(`${DIRECT_GOAL_CONTEXT_FIELD} must be a valid Goal action token`);
  }
  const role = compactRole === "w" ? "work" : "readback";
  const provesOperationId = optionalIdentifier(rawProof, "provesOperationId");
  if ((role === "readback") !== (provesOperationId !== undefined)) {
    throw new Error("Goal readback context must identify the work operation it proves");
  }
  return {
    goalId: requiredIdentifier(goalId, "goalId"),
    stepId: requiredIdentifier(stepId, "stepId"),
    claimToken: requiredToken(claimToken, "claimToken"),
    role,
    ...(provesOperationId === undefined ? {} : { provesOperationId }),
  };
}

function directGoalInvocationContext(claim: DirectGoalClaimView): DirectGoalInvocationContext {
  if (claim.step.state !== "awaiting_readback") {
    return {
      goalId: claim.goal.id,
      stepId: claim.step.id,
      claimToken: claim.claimToken,
      role: "work",
    };
  }
  const workReceipt = claim.step.receipts.findLast((receipt) => receipt.role === "work");
  if (workReceipt === undefined) {
    throw new Error("DIRECT_GOAL_READBACK_PROOF_UNAVAILABLE");
  }
  return {
    goalId: claim.goal.id,
    stepId: claim.step.id,
    claimToken: claim.claimToken,
    role: "readback",
    provesOperationId: workReceipt.operationId,
  };
}

function requiredToken(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,256}$/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function jsonResult(value: unknown): CallToolResult {
  const structured = value === undefined ? null : value;
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: isObject(structured) ? structured : { value: structured },
  };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
