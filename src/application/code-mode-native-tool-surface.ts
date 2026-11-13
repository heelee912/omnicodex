import { createHash, randomUUID } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  directGoalOwnerBinding,
  directGoalResourceDigest,
} from "../infrastructure/mcp/direct-goal-mcp-tools.js";
import type {
  DirectGoalExecutionReservationInput,
  DirectGoalStore,
} from "../infrastructure/mcp/direct-goal-store.js";
import type {
  MutationReplayJsonValue,
  MutationReplayStore,
} from "../infrastructure/mcp/mutation-replay-store.js";
import { structuredErrorDetails } from "../infrastructure/runtime/structured-error-details.js";
import { canonicalJson } from "../infrastructure/safety/canonical-json.js";
import type {
  AppServerMethodCatalog,
  AppServerMethodDescriptor,
  AppServerMethodExecutor,
} from "./app-server-method-catalog.js";
import {
  type BrowserNativeCallContext,
  type BrowserNativeExecutor,
  classifyBrowserNativeOperation,
  isCuaNativeTool,
} from "./browser-native-executor.js";
import type {
  BrowserActivityLifecycleCoordinator,
  BrowserActivityLifecycleExecutor,
} from "./chatgpt-browser-activity-coordinator.js";
import type {
  CodexAppHostToolCallContext,
  CodexAppHostToolDescriptor,
  CodexAppHostToolExecutor,
  CodexDynamicToolCallObservation,
  CodexDynamicToolCallParams,
  CodexDynamicToolCallResponse,
} from "./codex-app-host-tool-executor.js";
import {
  type NativeExecutionDescriptor,
  NativeExecutionScheduler,
  nativeExecutionOrderingFromArguments,
} from "./native-execution-scheduler.js";
import type {
  NativeToolCatalog,
  NativeToolDescriptor,
  NativeToolExecutor,
} from "./native-tool-catalog.js";
import {
  type NativeToolPresentationIdentity,
  presentedNativeToolDescription,
  presentedNativeToolInputSchema,
  splitNativeIdentity,
} from "./native-tool-presentation.js";

interface HostToolExecutor extends Pick<CodexAppHostToolExecutor, "tools"> {
  callDynamic(
    params: CodexDynamicToolCallParams,
    context?: CodexAppHostToolCallContext,
  ): Promise<CodexDynamicToolCallResponse>;
}
type MethodCatalog = Pick<AppServerMethodCatalog, "snapshot">;
type MethodExecutor = Pick<AppServerMethodExecutor, "call">;
type BrowserExecutor = Pick<BrowserNativeExecutor, "call"> &
  Partial<
    Pick<
      BrowserNativeExecutor,
      "callCua" | "beginActivity" | "finishActivity" | "finishCurrentActivity"
    >
  >;
type DownstreamToolCatalog = Pick<NativeToolCatalog, "snapshot">;
type DownstreamToolExecutor = Pick<NativeToolExecutor, "callInContext">;

export interface CodeModeNativeToolSurfaceOptions {
  readonly directGoalStore?: DirectGoalStore;
  readonly mutationReplayStore?: MutationReplayStore;
  readonly hostTools: HostToolExecutor;
  readonly appServerMethodCatalog: MethodCatalog;
  readonly appServerMethodExecutor: MethodExecutor;
  readonly browserNativeExecutor: BrowserExecutor;
  readonly browserActivityCoordinator?: BrowserActivityLifecycleCoordinator;
  /** Server-derived browser identity; remote tool arguments cannot override it. */
  readonly browserCallContext?: (
    params: CodexDynamicToolCallParams,
  ) => Omit<BrowserNativeCallContext, "activityBinding" | "contextTurnId" | "signal">;
  readonly downstreamToolCatalog: DownstreamToolCatalog;
  readonly downstreamToolExecutor: DownstreamToolExecutor;
  readonly scheduler?: NativeExecutionScheduler;
  readonly observeDynamicToolCall?: (
    observation: CodexDynamicToolCallObservation,
  ) => Promise<void> | void;
}

interface SurfaceEntry {
  readonly name: string;
  readonly tool: Tool;
  readonly route: "host" | "app_server" | "browser" | "downstream";
  readonly hostDescriptor?: CodexAppHostToolDescriptor;
  readonly appServerDescriptor?: AppServerMethodDescriptor;
  readonly downstreamDescriptor?: NativeToolDescriptor;
}

const browserNativeToolNames = [
  "browser__list_surfaces",
  "chrome__list_user_tabs",
  "chrome__control_chrome",
  "browser__control_in_app_browser",
] as const;

type BrowserNativeToolName = (typeof browserNativeToolNames)[number];

/**
 * One exact-name native tool surface shared by Responses code mode and the
 * persistent OmniCodex Bridge. Calls are dispatched directly to one existing
 * native executor; this layer never invokes another model or a search router.
 */
export class CodeModeNativeToolSurface {
  readonly #options: CodeModeNativeToolSurfaceOptions;
  readonly #scheduler: NativeExecutionScheduler;

  constructor(options: CodeModeNativeToolSurfaceOptions) {
    this.#options = options;
    this.#scheduler = options.scheduler ?? new NativeExecutionScheduler();
  }

  get nativeToolNames(): readonly string[] {
    return this.#entries().map((entry) => entry.name);
  }

  get dynamicToolSpecs(): readonly Record<string, unknown>[] {
    // `thread/start.dynamicTools` is a strict App Server protocol surface, not
    // an MCP Tool passthrough. In particular, a live MCP tool may legitimately
    // carry extension fields named `namespace`, `exposeToContext`, or `tools`;
    // copying those fields beside canonical `type: "function"` makes current
    // Codex reject the whole registry as a mixed canonical/legacy payload.
    //
    // Keep the authoritative MCP Tool (including all metadata) in the native
    // catalog, while projecting only the lossless fields supported by the
    // canonical DynamicToolFunctionSpec at this protocol boundary.
    return this.#entries().map((entry) => ({
      type: "function",
      name: entry.name,
      description: codeModeToolDescription(entry),
      inputSchema: presentedNativeToolInputSchema(entry.tool.inputSchema),
      deferLoading: false,
    }));
  }

  async callDynamic(
    params: CodexDynamicToolCallParams,
    hostContext: CodexAppHostToolCallContext = {},
  ): Promise<CodexDynamicToolCallResponse> {
    let observation: Omit<CodexDynamicToolCallObservation, "phase"> | undefined;
    try {
      const requestedTool = requiredString(params.tool, "tool");
      const namespace = optionalString(params.namespace);
      const name = canonicalDynamicToolName(namespace, requestedTool);
      observation = {
        name,
        ...(typeof params.callId === "string" && params.callId.length > 0
          ? { callId: params.callId }
          : {}),
        ...(typeof params.threadId === "string" && params.threadId.length > 0
          ? { threadId: params.threadId }
          : {}),
      };
      await this.#observe({ ...observation, phase: "started" });
      const entry = this.#entries().find((candidate) => candidate.name === name);
      if (entry === undefined) {
        const response = dynamicResponse(false, {
          error: `Unknown OmniCodex native tool: ${name}`,
        });
        await this.#observe({ ...observation, phase: "failed" });
        return response;
      }
      const args = isObject(params.arguments) ? params.arguments : {};
      // The caller thread identifies this code cell, not a resource targeted
      // by every nested tool. Only the native arguments establish resource
      // ordering; retain params.threadId below for native execution context.
      const ordering = nativeExecutionOrderingFromArguments(args);
      const execution = executionDescriptor(entry);
      const dispatch = (cleanup?: () => Promise<void>) =>
        this.#scheduler.run(
          {
            entry: execution,
            ordering,
            ...(hostContext.signal === undefined ? {} : { signal: hostContext.signal }),
            ...(hostContext.timeoutMs === undefined ? {} : { timeoutMs: hostContext.timeoutMs }),
            ...(hostContext.deadlineUnixMs === undefined
              ? {}
              : { deadlineUnixMs: hostContext.deadlineUnixMs }),
          },
          async (operationSignal): Promise<CodexDynamicToolCallResponse> => {
            if (cleanup !== undefined) {
              await cleanup();
              return dynamicResponse(true, { content: [] });
            }
            return this.#executeGoalBoundNative(entry, params, async () => {
              if (entry.route === "host") {
                return this.#options.hostTools.callDynamic(params, {
                  ...hostContext,
                  ...(operationSignal === undefined ? {} : { signal: operationSignal }),
                });
              }
              if (entry.route === "app_server") {
                const descriptor = entry.appServerDescriptor;
                if (descriptor === undefined) {
                  throw new Error(`App Server descriptor is unavailable: ${name}`);
                }
                const result = await this.#options.appServerMethodExecutor.call(descriptor, args, {
                  ...(operationSignal === undefined ? {} : { signal: operationSignal }),
                });
                return dynamicResponse(nativeCallSucceeded(result), result);
              }
              if (entry.route === "browser") {
                const contextThreadId =
                  name === "browser__control_in_app_browser"
                    ? optionalString(params.threadId)
                    : undefined;
                const turnId = optionalString(params.turnId);
                const browserContext = this.#options.browserCallContext?.(params) ?? {};
                const result = await this.#runBrowserActivity(
                  {
                    ...browserContext,
                    ...(contextThreadId === undefined ? {} : { contextThreadId }),
                    ...(operationSignal === undefined ? {} : { signal: operationSignal }),
                  },
                  turnId,
                  (coordinated) =>
                    this.#options.browserNativeExecutor.call(
                      browserArguments(name, args),
                      coordinated,
                    ),
                );
                return dynamicResponse(nativeCallSucceeded(result), unwrapNativeTextResult(result));
              }
              const descriptor = entry.downstreamDescriptor;
              if (descriptor === undefined) {
                throw new Error(`Downstream tool descriptor is unavailable: ${name}`);
              }
              const nativeContext = this.#options.browserCallContext?.(params);
              if (
                isCuaNativeTool(descriptor.server, descriptor.originalName) &&
                this.#options.browserNativeExecutor.callCua !== undefined
              ) {
                const browser = this.#options.browserNativeExecutor;
                const callCua = browser.callCua;
                if (callCua === undefined) throw new Error("CUA lifecycle executor is unavailable");
                const context: BrowserNativeCallContext = {
                  ...nativeContext,
                  ...(operationSignal === undefined ? {} : { signal: operationSignal }),
                };
                const dispatch = (coordinated: BrowserNativeCallContext) =>
                  callCua.call(
                    browser,
                    descriptor.server,
                    descriptor.originalName,
                    params.arguments ?? {},
                    coordinated,
                  );
                if (descriptor.originalName === "turn_ended")
                  return dynamicResponse(true, await dispatch(context));
                const result = await this.#runBrowserActivity(
                  context,
                  optionalString(params.turnId),
                  dispatch,
                );
                return dynamicResponse(nativeCallSucceeded(result), result);
              }
              const result = await this.#options.downstreamToolExecutor.callInContext(
                descriptor.server,
                descriptor.originalName,
                params.arguments === undefined ? {} : params.arguments,
                optionalString(params.threadId),
                undefined,
                optionalString(params.turnId),
                operationSignal,
                nativeContext?.workSessionBinding ?? nativeContext?.callerSessionId,
              );
              return dynamicResponse(nativeCallSucceeded(result), result);
            });
          },
        );
      const browser = this.#options.browserNativeExecutor;
      const coordinator = this.#options.browserActivityCoordinator;
      const descriptor = entry.downstreamDescriptor;
      let response: CodexDynamicToolCallResponse;
      if (
        descriptor?.originalName === "turn_ended" &&
        isCuaNativeTool(descriptor.server, descriptor.originalName) &&
        browser.callCua !== undefined &&
        coordinator?.finishCurrentActivity !== undefined &&
        browser.beginActivity !== undefined &&
        browser.finishActivity !== undefined
      ) {
        // Replayed Stop results cannot retire a newly admitted activity.
        response = await this.#executeGoalBoundNative(entry, params, async () => {
          await coordinator.finishCurrentActivity?.(
            browser as BrowserActivityLifecycleExecutor,
            this.#options.browserCallContext?.(params) ?? {},
            async (cleanup) => {
              await dispatch(cleanup);
            },
          );
          return dynamicResponse(true, { content: [] });
        });
      } else {
        response = await dispatch();
      }
      await this.#observe({
        ...observation,
        phase: response.success ? "succeeded" : "failed",
      });
      return response;
    } catch (error) {
      if (observation !== undefined) {
        await this.#observe({ ...observation, phase: "failed" });
      }
      return dynamicResponse(false, {
        error: toError(error).message,
        errorDetails: structuredErrorDetails(error),
      });
    }
  }

  async #runBrowserActivity<T>(
    context: BrowserNativeCallContext,
    turnId: string | undefined,
    dispatch: (context: BrowserNativeCallContext) => Promise<T>,
  ): Promise<T> {
    const coordinator = this.#options.browserActivityCoordinator;
    const browser = this.#options.browserNativeExecutor;
    if (
      coordinator?.runWithActivity !== undefined &&
      browser.beginActivity !== undefined &&
      browser.finishActivity !== undefined
    ) {
      return coordinator.runWithActivity(
        browser as BrowserActivityLifecycleExecutor,
        context,
        dispatch,
      );
    }
    return dispatch({
      ...context,
      ...(turnId === undefined ? {} : { activityBinding: `turn:${turnId}`, contextTurnId: turnId }),
    });
  }

  async #executeGoalBoundNative(
    entry: SurfaceEntry,
    params: CodexDynamicToolCallParams,
    execute: () => Promise<CodexDynamicToolCallResponse>,
  ): Promise<CodexDynamicToolCallResponse> {
    const store = this.#options.directGoalStore;
    const replayStore = this.#options.mutationReplayStore;
    const owner = this.#options.browserCallContext?.(params);
    if (
      store === undefined ||
      replayStore === undefined ||
      owner?.ownerBinding === undefined ||
      owner.workSessionBinding === undefined
    )
      return execute();
    const authorizationBinding = directGoalOwnerBinding(
      owner.ownerBinding,
      owner.workSessionBinding,
    );
    const descriptor = executionDescriptor(entry);
    const native = {
      authorizationBinding,
      claimantBinding: owner.workSessionBinding,
      toolName: entry.name,
      targetIdentity: `code-mode/native/${entry.name}`,
      stateEffect:
        descriptor.stateEffect ??
        (entry.tool.annotations?.readOnlyHint === true ? ("read" as const) : ("mutate" as const)),
      modelEffect: descriptor.modelEffect ?? ("unknown" as const),
      resourceDigest: directGoalResourceDigest(
        nativeExecutionOrderingFromArguments(params.arguments ?? {}),
        `code-mode/native/${entry.name}`,
      ),
    };
    const hash = (value: unknown) =>
      createHash("sha256").update(canonicalJson(value)).digest("hex");
    const acquired = await replayStore.acquire({
      authorizationBinding,
      idempotencyKey: `code-mode-${hash(optionalString(params.callId) ?? randomUUID())}`,
      fingerprint: canonicalJson({
        tool: entry.name,
        descriptor: entry.tool,
        arguments: params.arguments ?? {},
      }),
    });
    const recover = async (
      value: MutationReplayJsonValue,
    ): Promise<CodexDynamicToolCallResponse> => {
      const response = value as unknown as CodexDynamicToolCallResponse;
      const context = await store.resolvePendingExecution({
        ...native,
        operationId: acquired.operationId,
      });
      if (context !== undefined)
        await store.finalizeExecution({
          ...native,
          ...context,
          operationId: acquired.operationId,
          resultDigest: hash(response),
          outcome: response.success ? "succeeded" : "tool_error",
        });
      return response;
    };
    if (acquired.kind === "replay") return recover(acquired.value);
    if (acquired.kind === "outcome_unknown")
      throw new Error(`NATIVE_CHILD_OUTCOME_UNKNOWN: ${acquired.code}`);
    if (acquired.kind === "join") {
      const terminal = await acquired.completion;
      if (terminal.kind === "completed") return recover(terminal.value);
      throw new Error(`NATIVE_CHILD_${terminal.kind.toUpperCase()}: ${terminal.code}`);
    }
    let reservation: DirectGoalExecutionReservationInput | undefined;
    let dispatched = false;
    try {
      const goalContext = await store.resolvePendingExecution(native);
      if (goalContext !== undefined) {
        reservation = {
          ...native,
          ...goalContext,
          operationId: acquired.operationId,
        };
        const begun = await store.beginExecution(reservation);
        if (begun.disposition !== "created")
          throw new Error(`DIRECT_GOAL_EXECUTION_${begun.disposition.toUpperCase()}`);
      }
      await acquired.execution.markDispatched();
      if (reservation !== undefined) await store.markExecutionDispatched(reservation);
      dispatched = true;
      const response = await execute();
      const replayValue = JSON.parse(JSON.stringify(response)) as MutationReplayJsonValue;
      await acquired.execution.complete(replayValue);
      if (reservation !== undefined)
        await store.finalizeExecution({
          ...reservation,
          resultDigest: hash(replayValue),
          outcome: response.success ? "succeeded" : "tool_error",
        });
      return response;
    } catch (error) {
      if (dispatched) {
        await acquired.execution
          .markOutcomeUnknown("NATIVE_CHILD_RESULT_UNCONFIRMED")
          .catch(() => undefined);
        if (reservation !== undefined)
          await store.markExecutionOutcomeUnknown(reservation).catch(() => undefined);
      } else {
        await acquired.execution
          .failBeforeDispatch("NATIVE_CHILD_PRE_DISPATCH_FAILED")
          .catch(() => undefined);
        if (reservation !== undefined)
          await store.abortBeforeDispatch(reservation).catch(() => undefined);
      }
      throw error;
    }
  }

  async #observe(observation: CodexDynamicToolCallObservation): Promise<void> {
    await Promise.resolve(this.#options.observeDynamicToolCall?.(observation)).catch(
      () => undefined,
    );
  }

  #entries(): readonly SurfaceEntry[] {
    const coreEntries: SurfaceEntry[] = [
      ...this.#options.hostTools.tools.map((descriptor: CodexAppHostToolDescriptor) => ({
        name: descriptor.name,
        tool: descriptor.tool,
        route: "host" as const,
        hostDescriptor: descriptor,
      })),
      ...this.#options.appServerMethodCatalog.snapshot.methods.map((descriptor) => ({
        name: descriptor.exposedName,
        tool: descriptor.tool,
        route: "app_server" as const,
        appServerDescriptor: descriptor,
      })),
      ...browserNativeTools(
        this.#options.hostTools.tools.find((descriptor) => descriptor.nativeName === "node_repl/js")
          ?.tool ??
          this.#options.downstreamToolCatalog.snapshot.tools.find(
            (descriptor) => descriptor.server === "node_repl" && descriptor.originalName === "js",
          )?.tool,
      ).map((tool) => ({
        name: tool.name,
        tool,
        route: "browser" as const,
      })),
    ];
    const downstreamDescriptors = this.#options.downstreamToolCatalog.snapshot.tools;
    const reservedNames = new Set(coreEntries.map(({ name }) => name));
    const usedNames = new Set<string>();
    const downstreamEntries = downstreamDescriptors
      // Exclude only this exact deployment marker. Display names are not an
      // identity boundary and must never make a native tool disappear.
      .filter((descriptor) => descriptor.selfReferential !== true)
      .slice()
      .sort((left, right) =>
        downstreamIdentity(left).localeCompare(downstreamIdentity(right), "en"),
      )
      .map((descriptor): SurfaceEntry => {
        const identity = downstreamIdentity(descriptor);
        const name = allocateDownstreamCodeModeName(
          downstreamCodeModeBaseName(descriptor),
          identity,
          reservedNames,
          usedNames,
        );
        usedNames.add(name);
        return {
          name,
          tool: descriptor.tool,
          route: "downstream",
          downstreamDescriptor: descriptor,
        };
      });
    const entries = [...coreEntries, ...downstreamEntries];
    const byName = new Map<string, SurfaceEntry>();
    for (const entry of entries) {
      const existing = byName.get(entry.name);
      if (existing !== undefined) {
        throw new Error(
          `Conflicting code-mode native tool descriptors for ${entry.name}: ${existing.route} and ${entry.route}`,
        );
      }
      byName.set(entry.name, entry);
    }
    return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name, "en"));
  }
}

function codeModeToolDescription(entry: SurfaceEntry): string {
  return presentedNativeToolDescription(entry.tool, presentationIdentity(entry)) ?? "";
}

function executionDescriptor(entry: SurfaceEntry): NativeExecutionDescriptor {
  if (entry.route === "app_server") {
    return {
      nativeNamespace: "app_server",
      originalName: entry.appServerDescriptor?.method ?? entry.name,
      source: "codex_app_server",
      modelEffect: entry.appServerDescriptor?.invokesModel === true ? "model" : "none",
      invokesModel: entry.appServerDescriptor?.invokesModel ?? null,
      stateEffect: entry.appServerDescriptor?.stateEffect ?? "read",
    };
  }
  if (entry.route === "browser") {
    return {
      nativeNamespace: entry.name.startsWith("chrome__") ? "chrome" : "browser",
      originalName: entry.name,
      source: "codex_browser_client",
      modelEffect: "none",
      stateEffect:
        entry.name === "browser__list_surfaces" || entry.name === "chrome__list_user_tabs"
          ? "read"
          : "mutate",
    };
  }
  if (entry.route === "downstream") {
    return {
      nativeNamespace: entry.downstreamDescriptor?.server ?? "downstream",
      originalName: entry.downstreamDescriptor?.originalName ?? entry.name,
      source: "downstream_mcp",
    };
  }
  const identity = presentationIdentity(entry);
  return {
    nativeNamespace: identity.nativeNamespace ?? "codex_app",
    originalName: identity.originalName ?? entry.name,
    source: "codex_app_host",
    modelEffect: entry.hostDescriptor?.modelEffect ?? "none",
    stateEffect: entry.hostDescriptor?.stateEffect ?? "read",
  };
}

function presentationIdentity(entry: SurfaceEntry): NativeToolPresentationIdentity {
  if (entry.route === "app_server") {
    return {
      nativeNamespace: "app_server",
      originalName: entry.appServerDescriptor?.method ?? entry.name,
    };
  }
  if (entry.route === "browser") {
    return {
      nativeNamespace: entry.name.startsWith("chrome__") ? "chrome" : "browser",
      originalName: entry.name,
    };
  }
  if (entry.route === "downstream") {
    return {
      nativeNamespace: entry.downstreamDescriptor?.server ?? "downstream",
      originalName: entry.downstreamDescriptor?.originalName ?? entry.name,
    };
  }
  const parsed = splitNativeIdentity(entry.hostDescriptor?.nativeName);
  if (parsed.namespace !== undefined || parsed.name !== undefined) {
    return {
      ...(parsed.namespace === undefined ? {} : { nativeNamespace: parsed.namespace }),
      ...(parsed.name === undefined ? {} : { originalName: parsed.name }),
    };
  }
  const separator = entry.name.indexOf("__");
  return {
    nativeNamespace: separator > 0 ? entry.name.slice(0, separator) : "codex_app",
    originalName: separator > 0 ? entry.name.slice(separator + 2) : entry.name,
  };
}

export function codeModeBrowserNativeTools(nativeExecutionTool?: Tool): readonly Tool[] {
  return browserNativeTools(nativeExecutionTool);
}

function browserNativeTools(nativeExecutionTool?: Tool): Tool[] {
  const nativeProperties = nativeExecutionTool?.inputSchema.properties ?? {};
  // Preserve native validation and explanatory text while distinguishing the
  // wrapper's effective deadline from the underlying node_repl/js default.
  const timeoutDescription =
    "Optional browser call timeout in milliseconds. OmniCodex defaults to 90000 ms when omitted; an explicit shorter timeout or earlier caller deadline still applies.";
  const nativeTimeout = nativeProperties.timeout_ms;
  const nativeTimeoutDescription =
    typeof nativeTimeout === "object" &&
    nativeTimeout !== null &&
    "description" in nativeTimeout &&
    typeof nativeTimeout.description === "string"
      ? nativeTimeout.description
      : undefined;
  const timeoutSchema =
    nativeProperties.timeout_ms === undefined
      ? {
          type: "integer",
          minimum: 1,
          default: 90_000,
          description: timeoutDescription,
        }
      : {
          ...structuredClone(nativeProperties.timeout_ms),
          default: 90_000,
          description:
            nativeTimeoutDescription === undefined
              ? timeoutDescription
              : `${timeoutDescription} Installed node_repl/js parameter: ${nativeTimeoutDescription}`,
        };
  const titleSchema =
    nativeProperties.title === undefined
      ? { type: "string" }
      : structuredClone(nativeProperties.title);
  const executionProperties = {
    operation: {
      type: "string",
      enum: ["documentation", "exec", "inspect", "list_tabs", "list_user_tabs"],
      description:
        "Selects the browser action: documentation returns the live API reference, inspect returns a fresh full accessibility state for one tab, list_tabs and list_user_tabs return tab inventories, and exec evaluates the supplied browser code.",
    },
    documentation_name: {
      type: "string",
      minLength: 1,
      description:
        "Optional installed documentation name for operation=documentation. Omit it to return the selected browser API reference.",
    },
    code: {
      type: "string",
      description:
        "JavaScript function body with the selected browser binding available as `browser` and the work-session-persistent `state` object. Keep reusable handles on state; local variables last for this call. Return the requested value. Use operation=documentation to read the live API reference.",
    },
    target_tab_id: {
      type: "string",
      minLength: 1,
      description:
        "Exact native tab id to read with operation=inspect. The inspection is fixed to a full accessibility-state read and cannot execute caller-supplied code.",
    },
    timeout_ms: timeoutSchema,
    title: titleSchema,
  } as const;
  const executionSchema = {
    type: "object",
    properties: executionProperties,
    required: ["operation"],
    additionalProperties: false,
  } as const;
  const browserIdSchema = {
    type: "string",
    minLength: 1,
    description:
      "Optional stable browser profile key from browser__list_surfaces. It remains usable when the runtime reconnects and its numeric connection id changes. A supplied key binds the operation to that profile; omission uses the current default Chrome selection.",
  } as const;
  return [
    {
      name: "browser__list_surfaces",
      title: "List available browser surfaces",
      description:
        "Returns the live browser surfaces with stable profile keys, with extension-backed signed-in Chrome Use and the Codex in-app browser identified separately. The keys remain usable when numeric runtime connection ids change.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    {
      name: "chrome__list_user_tabs",
      title: "List actual Chrome user tabs",
      description:
        "Returns the profile-wide native tab inventory from the installed extension-backed signed-in Chrome Use surface, including each tab's user-visible group name when present and whether it is attached to this work session. The inventory spans every Chrome window: a tabGroup value does not prove that the group is visible in the current foreground window. Use chrome__control_chrome to read or operate a selected tab.",
      inputSchema: {
        type: "object",
        properties: {
          browserId: browserIdSchema,
          timeout_ms: structuredClone(timeoutSchema),
          title: structuredClone(titleSchema),
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    {
      name: "chrome__control_chrome",
      title: "Use signed-in Chrome",
      description:
        "Reads and interacts with the installed extension-backed signed-in Chrome profile. Each work session keeps its own browser binding and tab-group ownership; an attributed ChatGPT call does not require its conversation tab to be open in Chrome. A successful navigation does not establish that a dynamic page has rendered: read the requested content using native DOM or accessibility state, and treat an unmatched locator as a selector outcome. Use operation=list_user_tabs to select a tab, operation=inspect with target_tab_id to read its current accessibility state, operation=documentation to read the live API, or operation=exec to perform the requested browser action.",
      inputSchema: {
        ...executionSchema,
        properties: { ...executionProperties, browserId: browserIdSchema },
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    {
      name: "browser__control_in_app_browser",
      title: "Use the Codex in-app browser",
      description:
        "Reads and interacts with tabs in the selected Codex task's in-app browser. Use operation=inspect with target_tab_id to read current accessibility state, operation=documentation to read the live API, or operation=exec to perform the requested browser action.",
      inputSchema: executionSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
  ] as Tool[];
}

function browserArguments(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!isBrowserNativeTool(name)) throw new Error(`Unknown browser native tool: ${name}`);
  if (name === "browser__list_surfaces") return { operation: "list_surfaces" };
  if (name === "chrome__list_user_tabs") {
    return { operation: "list_user_tabs", surface: "chrome", ...args };
  }
  return {
    ...args,
    operation: classifyBrowserNativeOperation(args.operation, args.code),
    surface: name === "chrome__control_chrome" ? "chrome" : "iab",
  };
}

function isBrowserNativeTool(name: string): name is BrowserNativeToolName {
  return (browserNativeToolNames as readonly string[]).includes(name);
}

function downstreamCodeModeBaseName(descriptor: NativeToolDescriptor): string {
  if (isResponsesSafeToolName(descriptor.exposedName)) return descriptor.exposedName;
  const base =
    `codex__${downstreamNameSegment(descriptor.server)}` +
    `__${downstreamNameSegment(descriptor.originalName)}`;
  return base.length <= 128 ? base : withDownstreamNameSuffix(base, downstreamIdentity(descriptor));
}

function allocateDownstreamCodeModeName(
  base: string,
  identity: string,
  reserved: ReadonlySet<string>,
  used: ReadonlySet<string>,
): string {
  if (!reserved.has(base) && !used.has(base)) return base;
  let candidate = withDownstreamNameSuffix(base, identity);
  if (!reserved.has(candidate) && !used.has(candidate)) return candidate;
  for (let ordinal = 2n; ; ordinal += 1n) {
    candidate = withDownstreamNameSuffix(base, `${identity}\0${ordinal.toString()}`);
    if (!reserved.has(candidate) && !used.has(candidate)) return candidate;
  }
}

function withDownstreamNameSuffix(base: string, identity: string): string {
  const suffix = `__h_${createHash("sha256").update(identity, "utf8").digest("hex")}`;
  return `${base.slice(0, 128 - suffix.length)}${suffix}`;
}

function downstreamNameSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function isResponsesSafeToolName(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/u.test(value);
}

function downstreamIdentity(descriptor: NativeToolDescriptor): string {
  return `${descriptor.server}\0${descriptor.originalName}`;
}

function canonicalDynamicToolName(namespace: string | undefined, tool: string): string {
  if (namespace === undefined || tool.startsWith(`${namespace}__`)) return tool;
  return `${namespace}__${tool}`;
}

function dynamicResponse(success: boolean, value: unknown): CodexDynamicToolCallResponse {
  const nativeContentItems = nativeContentItemsFromCallToolResult(value);
  return {
    success,
    contentItems: nativeContentItems ?? [{ type: "inputText", text: stringify(value) }],
  };
}

function nativeContentItemsFromCallToolResult(
  value: unknown,
): CodexDynamicToolCallResponse["contentItems"] | undefined {
  if (!isObject(value) || !Array.isArray(value.content)) return undefined;
  const contentItems: Array<CodexDynamicToolCallResponse["contentItems"][number]> = [];
  for (const block of value.content) {
    if (isObject(block) && block.type === "text" && typeof block.text === "string") {
      contentItems.push({ type: "inputText", text: block.text });
      continue;
    }
    if (
      isObject(block) &&
      block.type === "image" &&
      typeof block.mimeType === "string" &&
      typeof block.data === "string"
    ) {
      contentItems.push({
        type: "inputImage",
        imageUrl: `data:${block.mimeType};base64,${block.data}`,
      });
      continue;
    }
    if (
      isObject(block) &&
      block.type === "audio" &&
      typeof block.mimeType === "string" &&
      typeof block.data === "string"
    ) {
      contentItems.push({
        type: "inputAudio",
        audioUrl: `data:${block.mimeType};base64,${block.data}`,
      });
      continue;
    }
    // Dynamic tool responses have no resource or future-block variant. Keep
    // the exact block at its original position as a typed reconstruction item.
    contentItems.push({
      type: "inputText",
      text: `OMNICODEX_MCP_CONTENT_BLOCK_V1:${stringify(block)}`,
    });
  }
  // Native media items intentionally optimize the immediate model view, while
  // this complete envelope retains annotations, result-level metadata,
  // structuredContent, isError, resource blocks, and future extension fields.
  contentItems.push({
    type: "inputText",
    text: `OMNICODEX_CALL_TOOL_RESULT_V1:${stringify(value)}`,
  });
  return contentItems;
}

function nativeCallSucceeded(value: unknown): boolean {
  return !(isObject(value) && value.isError === true);
}

/**
 * Browser execution is backed by the native Node REPL, whose CallToolResult
 * wraps the value in one text block. Code Mode already transports values as
 * JSON text, so remove only those known transport envelopes before encoding
 * the dynamic result. Non-JSON text and media-bearing results remain intact.
 */
function unwrapNativeTextResult(value: unknown): unknown {
  let current = value;
  const seenStrings = new Set<string>();
  const seenObjects = new WeakSet<object>();
  for (;;) {
    if (typeof current === "string") {
      if (seenStrings.has(current)) return current;
      seenStrings.add(current);
      try {
        current = JSON.parse(current) as unknown;
        continue;
      } catch {
        return current;
      }
    }
    if (!isObject(current)) return current;
    if (seenObjects.has(current)) return current;
    seenObjects.add(current);
    if (isObject(current.structuredContent)) {
      current = current.structuredContent;
      continue;
    }
    const blocks = Array.isArray(current.contentItems)
      ? current.contentItems
      : Array.isArray(current.content)
        ? current.content
        : undefined;
    if (blocks === undefined || blocks.length !== 1) return current;
    const block = blocks[0];
    if (!isObject(block) || typeof block.text !== "string") return current;
    current = block.text;
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export { structuredErrorDetails };

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
