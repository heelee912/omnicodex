import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { locateInstalledFirstPartyAsset } from "./installed-first-party-instructions.js";
import { PolicyDocumentationService } from "./policy-documentation-service.js";

export interface BrowserNativeExecutorOptions {
  readonly codexHome?: string;
  readonly environment?: "codex-app" | "training";
  /**
   * Product-owned rollout stream consumed by the installed first-party
   * Browser Use turn tracker. This must match the environment of the owned
   * App Server that hosts node_repl.
   */
  readonly browserRolloutSessionsRoot?: string;
  /** Resolve the live Codex app task whose first-party browser surfaces back this call. */
  readonly resolveContextThreadId?: (
    request: BrowserNativeContextRequest,
    boundary?: BrowserNativeContextBoundary,
  ) => Promise<string | undefined>;
  /**
   * Restores an app-global first-party browser surface when the installed
   * browser client authoritatively reports that the surface is unavailable.
   * Implementations are shared across work sessions and must coalesce an
   * outage into one physical recovery attempt.
   */
  readonly surfaceRecovery?: BrowserNativeSurfaceRecovery;
  /**
   * How long a surface listing keeps re-reading while the extension host
   * process is running but its extension has not connected yet (for example
   * right after Chrome was launched). Listing never launches a browser.
   */
  readonly lateExtensionSurfaceWaitMs?: number;
  readonly lateExtensionSurfacePollMs?: number;
}

export interface BrowserNativeSurfaceRecovery {
  recoverUnavailableSurface(
    request: BrowserNativeContextRequest,
    signal?: AbortSignal,
  ): Promise<void>;
  noteSurfaceAvailable(request: BrowserNativeContextRequest): void;
  /** Read-only: whether the browser that hosts the extension is running at all. */
  isExtensionHostRunning?(): Promise<boolean>;
}

/** Exact caller-owned cancellation/deadline boundary for browser context discovery. */
export interface BrowserNativeContextBoundary {
  readonly signal?: AbortSignal;
  readonly deadlineUnixMs?: number;
}

export interface BrowserNativeIdentityContext {
  /** Exact Codex desktop task whose task-scoped native browser is requested. */
  readonly contextThreadId?: string;
  /** Server-derived owner binding; never accepted from browser tool arguments. */
  readonly ownerBinding?: string;
  /** Server-derived durable work-session binding used to partition task-scoped browser state. */
  readonly workSessionBinding?: string;
  /** Stable transport-session identity used only when no durable work session is available. */
  readonly callerSessionId?: string;
  /** Server-derived identity of the current Web/Codex model turn. */
  readonly activityBinding?: string;
}

export type BrowserNativeContextRequest = BrowserNativeIdentityContext &
  (
    | { readonly operation: "list_surfaces" }
    | {
        readonly operation: "documentation" | "exec" | "inspect" | "list_tabs" | "list_user_tabs";
        readonly surface: BrowserNativeSurface;
        /** The caller's selected native browser; preserved across reconnects. */
        readonly browserId?: string;
        /** Profile name observed on this runtime's selected native connection. */
        readonly chromeProfileName?: string;
      }
  );

export interface BrowserThreadToolExecutor {
  callInContext(
    server: string,
    tool: string,
    argumentsValue: unknown,
    contextThreadId?: string,
    onProgress?: undefined,
    contextTurnId?: string,
    signal?: AbortSignal,
    contextSessionId?: string,
  ): Promise<unknown>;
}

export interface BrowserNativeCallContext extends BrowserNativeIdentityContext {
  /** Server-owned diagnostics only; never forwarded to caller code or the browser client. */
  readonly observeExecutionStage?: (stage: BrowserNativeExecutionStage) => void;
  /**
   * Gateway-derived caller class. Browser code and tool arguments cannot set
   * this value; it lets the MCP receipt distinguish a Web conversation from a
   * local or otherwise unattributed client without changing browser identity.
   */
  readonly callerProvenance?: "chatgpt_conversation" | "unattributed_mcp_client";
  /** SHA-256 of the validated originating ChatGPT conversation id, when available. */
  readonly chatGptConversationIdSha256?: string;
  /**
   * Validated exact ChatGPT conversation id used transiently by the runtime's
   * browser-activity coordinator. It is stripped before native dispatch and
   * must never be logged, persisted, or returned to an MCP caller.
   */
  readonly chatGptConversationId?: string;
  /**
   * Privacy-safe identity of the caller's current model activity, derived only
   * from authenticated MCP transport metadata. It is used by the lifecycle
   * coordinator and is never forwarded to the first-party browser service.
   */
  readonly callerActivityBinding?: string;
  /** Whether callerActivityBinding is an authoritative model-task boundary or transport trace. */
  readonly callerActivityBindingKind?: "related_task" | "transport_trace";
  /** Reserved for forward-compatible caller metadata; browser execution never resumes this task. */
  readonly threadId?: never;
  /** Cancels the underlying first-party browser tool call, not only the HTTP waiter. */
  readonly signal?: AbortSignal;
  /** Exact caller-selected absolute completion deadline. */
  readonly deadlineUnixMs?: number;
  /** Existing native turn context, when this call originated inside a Codex task. */
  readonly contextTurnId?: string;
  /** Stable mutation/read correlation owned by the scheduler. */
  readonly operationId?: string;
  /**
   * Continue an already active browser sequence selected by an authoritative
   * model-activity coordinator. Transport and JSON-RPC identities are not
   * model-turn boundaries.
   */
  readonly continueExistingActivity?: boolean;
}

export type BrowserNativeSurface = "chrome" | "iab" | "edge" | "extension" | "default";
export type BrowserNativeOperation = BrowserNativeContextRequest["operation"];
export type BrowserNativeExecutionStage =
  | "dispatch_pending"
  | "runtime_setup"
  | "native_dispatch"
  | "native_returned"
  | "runtime_recovery";
const DEFAULT_BROWSER_CALL_TIMEOUT_MS = 30_000;

function observeBrowserExecutionStage(
  context: BrowserNativeCallContext,
  stage: BrowserNativeExecutionStage,
): void {
  try {
    context.observeExecutionStage?.(stage);
  } catch {
    // Diagnostic failures cannot alter execution, cancellation, or native results.
  }
}

/** Uses the installed first-party browser client inside the privileged Codex Node runtime. */
export class BrowserNativeExecutor {
  readonly #nativeExecutor: BrowserThreadToolExecutor;
  readonly #codexHome: string;
  readonly #environment: "codex-app" | "training";
  readonly #policyDocumentation: PolicyDocumentationService;
  readonly #browserRolloutSessionsRoot: string;
  readonly #resolveContextThreadId:
    | ((
        request: BrowserNativeContextRequest,
        boundary?: BrowserNativeContextBoundary,
      ) => Promise<string | undefined>)
    | undefined;
  readonly #surfaceRecovery: BrowserNativeSurfaceRecovery | undefined;
  readonly #lateExtensionSurfaceWaitMs: number;
  readonly #lateExtensionSurfacePollMs: number;
  #clientPath: string | undefined;
  /** runtime binding -> caller browser key -> identities of the surface it named. */
  readonly #browserIdentities = new Map<string, Map<string, BrowserKeyBinding>>();
  readonly #recoveryStates = new Map<string, BrowserRecoveryState>();
  readonly #currentActivities = new Map<string, string>();
  readonly #restoredActivities = new Set<string>();
  readonly #activityStateContexts = new Map<string, BrowserNativeIdentityContext>();
  readonly #retiringActivities = new Set<string>();
  readonly #activityTransitions = new Map<string, Promise<void>>();
  readonly #activityTurnLifecycles = new Map<string, Map<string, BrowserTurnLifecycle>>();
  readonly #cuaTurnLifecycles = new Map<string, Map<string, CuaTurnLifecycle>>();
  readonly #restoredCuaTurns = new Set<string>();
  readonly #unboundTurnLifecycles = new Map<string, BrowserTurnLifecycle>();
  readonly #durableUnboundTurnKeys = new Set<string>();
  readonly #restoredUnboundTurnKeys = new Set<string>();
  readonly #activityAliases = new Map<
    string,
    { readonly conversationKey: string; readonly canonicalActivity: string }
  >();
  readonly #nativeReleaseTargets = new Map<string, BrowserNativeReleaseTarget>();
  #requiresActiveNativeRelease = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    nativeExecutor: BrowserThreadToolExecutor,
    options: BrowserNativeExecutorOptions = {},
  ) {
    this.#nativeExecutor = nativeExecutor;
    const userProfile = process.env.USERPROFILE;
    const codexHome = options.codexHome ?? process.env.CODEX_HOME;
    if (codexHome === undefined && userProfile === undefined) {
      throw new Error("CODEX_HOME and USERPROFILE are unavailable");
    }
    this.#codexHome = codexHome ?? join(userProfile as string, ".codex");
    this.#environment = options.environment ?? "codex-app";
    this.#policyDocumentation = new PolicyDocumentationService(this.#codexHome);
    this.#browserRolloutSessionsRoot =
      options.browserRolloutSessionsRoot ?? join(this.#codexHome, "sessions");
    this.#resolveContextThreadId = options.resolveContextThreadId;
    this.#surfaceRecovery = options.surfaceRecovery;
    this.#lateExtensionSurfaceWaitMs = options.lateExtensionSurfaceWaitMs ?? 20_000;
    this.#lateExtensionSurfacePollMs = options.lateExtensionSurfacePollMs ?? 2_000;
  }

  async call(argumentsValue: unknown, context: BrowserNativeCallContext = {}): Promise<unknown> {
    const result = await this.#call(argumentsValue, context);
    if (
      isObject(result) &&
      result.isError !== true &&
      (result.success === false || result.ok === false)
    ) {
      return { ...result, isError: true };
    }
    return result;
  }

  get hasPendingActivities(): boolean {
    return (
      this.#activityTurnLifecycles.size > 0 ||
      this.#cuaTurnLifecycles.size > 0 ||
      this.#unboundTurnLifecycles.size > 0
    );
  }

  /** Execute the installed CUA API without substituting the older browser API. */
  async callCua(
    server: string,
    tool: string,
    argumentsValue: unknown,
    context: BrowserNativeCallContext = {},
  ): Promise<unknown> {
    if (!isCuaNativeTool(server, tool)) throw new Error("Invalid CUA lifecycle target");
    if (tool === "turn_ended") {
      // Hook arguments cannot select another caller's native session or turn.
      await this.finishCurrentActivity(context);
      return { content: [] };
    }
    const sessionId = cuaSessionId(context);
    const activity = context.activityBinding ?? `turn:cua:${browserConversationKey(context)}`;
    await this.beginActivity(activity, { ...context, continueExistingActivity: true });
    const canonical = this.#canonicalActivity(context, activity);
    const turnId = canonical;
    const key = browserActivityKey(context, canonical);
    const lifecycles = this.#cuaTurnLifecycles.get(key) ?? new Map<string, CuaTurnLifecycle>();
    const turnKey = `${server}\0${sessionId}\0${turnId}`;
    lifecycles.set(turnKey, {
      server,
      sessionId,
      turnId,
      ...(context.contextThreadId === undefined
        ? {}
        : { contextThreadId: context.contextThreadId }),
    });
    this.#cuaTurnLifecycles.set(key, lifecycles);
    await this.#persistActivity(context);
    const result = await this.#nativeExecutor.callInContext(
      server,
      tool,
      argumentsValue,
      context.contextThreadId,
      undefined,
      turnId,
      context.signal,
      sessionId,
    );
    if (nativeCallFailure(result) === undefined) {
      if (tool === "js_reset") this.#restoredCuaTurns.add(turnKey);
      else this.#restoredCuaTurns.delete(turnKey);
    }
    return result;
  }

  /**
   * Advances one authenticated conversation to its next model activity.
   *
   * ChatGPT can reconnect the MCP transport for every tool call, so transport
   * close and transport traces are not model-turn boundaries. Only the
   * authoritative coordinator may advance the activity. A replacement
   * executor adopts the same native session/turn before dispatching code.
   */
  async finishCurrentActivity(context: BrowserNativeCallContext = {}): Promise<void> {
    await this.#restoreActivity(context);
    const activity = this.#currentActivities.get(browserConversationKey(context));
    if (activity !== undefined) await this.finishActivity(activity, context);
  }

  async beginActivity(
    activityBinding: string,
    context: Omit<BrowserNativeCallContext, "activityBinding"> = {},
  ): Promise<void> {
    const normalizedActivity = requiredContextValue(activityBinding, "activityBinding", true);
    const key = browserConversationKey(context);
    const previousTransition = this.#activityTransitions.get(key) ?? Promise.resolve();
    const transition = previousTransition.then(async () => {
      if (context.continueExistingActivity === true) await this.#restoreActivity(context);
      const previousActivity = this.#currentActivities.get(key);
      if (previousActivity === normalizedActivity) return;
      if (previousActivity !== undefined) {
        const previousKey = browserActivityKey(context, previousActivity);
        const previousOwnsBrowserState =
          this.#activityTurnLifecycles.has(previousKey) || this.#cuaTurnLifecycles.has(previousKey);
        if (
          context.continueExistingActivity === true &&
          previousOwnsBrowserState &&
          !this.#retiringActivities.has(previousKey)
        ) {
          this.#activityAliases.set(browserActivityKey(context, normalizedActivity), {
            conversationKey: key,
            canonicalActivity: previousActivity,
          });
          return;
        }
        await this.finishActivity(previousActivity, context);
      }
      this.#activityAliases.delete(browserActivityKey(context, normalizedActivity));
      this.#currentActivities.set(key, normalizedActivity);
    });
    const settled = transition.finally(() => {
      if (this.#activityTransitions.get(key) === settled) {
        this.#activityTransitions.delete(key);
      }
    });
    this.#activityTransitions.set(key, settled);
    return settled;
  }

  /**
   * Publishes the native Browser Use lifecycle outcome for this activity.
   * Tab ownership and cleanup stay entirely inside the first-party runtime;
   * this adapter must not inventory, substitute, or close browser tabs.
   */
  async finishActivity(
    activityBinding: string,
    context: Omit<BrowserNativeCallContext, "activityBinding"> = {},
  ): Promise<void> {
    const requestedActivity = requiredContextValue(activityBinding, "activityBinding", true);
    // Completion can be the first event after a runtime replacement. Load the
    // owner-validated durable lifecycle before persisting anything; otherwise
    // an empty replacement erases the outstanding native turn without ending it.
    await this.#restoreActivity(context);
    const normalizedActivity = this.#canonicalActivity(context, requestedActivity);
    const key = browserActivityKey(context, normalizedActivity);
    const turnLifecycles = this.#activityTurnLifecycles.get(key);
    this.#retiringActivities.add(key);
    // Crash/replacement after one published ending must resume settlement,
    // not attach a new turn to handles already being detached.
    await this.#persistActivity(context);

    const failures: Error[] = [];
    const cuaLifecycles = this.#cuaTurnLifecycles.get(key);
    if (cuaLifecycles !== undefined) {
      try {
        await this.#releaseCuaTurns(cuaLifecycles);
        this.#cuaTurnLifecycles.delete(key);
      } catch (error) {
        failures.push(toError(error));
      }
    }
    if (turnLifecycles !== undefined) {
      try {
        await settleBrowserTurnLifecycles(
          turnLifecycles,
          failures.length === 0 ? "completed" : "aborted",
        );
        await this.#releaseActivityBrowserTurns(turnLifecycles, context);
      } catch (error) {
        failures.push(toError(error));
      }
      if (failures.length === 0) this.#activityTurnLifecycles.delete(key);
    }
    if (!this.#activityTurnLifecycles.has(key) && !this.#cuaTurnLifecycles.has(key)) {
      this.#retiringActivities.delete(key);
      const conversationKey = browserConversationKey(context);
      if (this.#currentActivities.get(conversationKey) === normalizedActivity) {
        this.#currentActivities.delete(conversationKey);
      }
      for (const [aliasKey, alias] of this.#activityAliases) {
        if (
          alias.conversationKey === conversationKey &&
          alias.canonicalActivity === normalizedActivity
        ) {
          this.#activityAliases.delete(aliasKey);
        }
      }
    }
    await this.#persistActivity(context);
    if (failures.length > 0) {
      throw new AggregateError(failures, `Browser activity cleanup failed: ${normalizedActivity}`);
    }
  }

  /**
   * Retires only OmniCodex-owned synthetic Browser Use sessions before their
   * native App Server execution context is released. Task-owned in-app browser
   * sessions are deliberately left to Codex Desktop.
   */
  async close(options: { readonly preserveActivities?: boolean } = {}): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    const operation = (async () => {
      const errors: Error[] = [];
      const transitions = [...this.#activityTransitions.values()];
      const transitionResults = await Promise.allSettled(transitions);
      for (const result of transitionResults) {
        if (result.status === "rejected") errors.push(toError(result.reason));
      }
      if (options.preserveActivities !== true) {
        for (const [key, lifecycles] of this.#cuaTurnLifecycles) {
          try {
            await this.#releaseCuaTurns(lifecycles);
            this.#cuaTurnLifecycles.delete(key);
          } catch (error) {
            errors.push(toError(error));
          }
        }
      }

      const pending = new Map(
        [...this.#unboundTurnLifecycles].filter(
          ([key]) => options.preserveActivities !== true || !this.#durableUnboundTurnKeys.has(key),
        ),
      );
      if (options.preserveActivities !== true) {
        for (const lifecycles of this.#activityTurnLifecycles.values()) {
          for (const [key, lifecycle] of lifecycles) pending.set(key, lifecycle);
        }
      }
      // Stable owner/work-session turns also survive service replacement even
      // without ChatGPT activity attribution. Transport-only turns still retire.
      if (pending.size > 0) {
        if (options.preserveActivities !== true) {
          for (const key of this.#activityTurnLifecycles.keys()) this.#retiringActivities.add(key);
          await Promise.all(
            [...this.#activityStateContexts.values()].map((context) =>
              this.#persistActivity(context),
            ),
          );
        }
        try {
          // Older Browser Use releases consume the rollout turn-end stream.
          // Publish every outstanding synthetic turn before the owned
          // Node/App Server context closes.
          await settleBrowserTurnLifecycles(pending, "aborted");
        } catch (error) {
          errors.push(toError(error));
        }
        // A replacement can be closed immediately after adopting durable
        // ownership, before it has dispatched any browser call. Reconstruct
        // the exact release targets instead of silently dropping that ledger.
        for (const context of this.#activityStateContexts.values()) {
          const sessionId = appGlobalBrowserSessionId({ operation: "list_surfaces", ...context });
          const ownedPending = new Map(
            [...pending].filter(([, lifecycle]) => lifecycle.sessionId === sessionId),
          );
          try {
            await this.#releaseActivityBrowserTurns(ownedPending, context);
          } catch (error) {
            errors.push(toError(error));
          }
        }
      }
      if (this.#requiresActiveNativeRelease) {
        try {
          await this.#releaseNativeBrowserTurns(pending.keys());
        } catch (error) {
          errors.push(toError(error));
        }
      }
      if (errors.length > 0) {
        await Promise.all(
          [...this.#activityStateContexts.values()].map((context) =>
            this.#persistActivity(context),
          ),
        );
        throw new AggregateError(errors, "OmniCodex browser sessions did not retire cleanly");
      }
      this.#unboundTurnLifecycles.clear();
      this.#durableUnboundTurnKeys.clear();
      this.#restoredUnboundTurnKeys.clear();
      this.#activityTurnLifecycles.clear();
      this.#cuaTurnLifecycles.clear();
      this.#restoredCuaTurns.clear();
      this.#currentActivities.clear();
      this.#activityAliases.clear();
      this.#retiringActivities.clear();
      this.#nativeReleaseTargets.clear();
      if (options.preserveActivities !== true) {
        await Promise.all(
          [...this.#activityStateContexts.values()].map((context) =>
            this.#persistActivity(context),
          ),
        );
      }
    })().catch((error: unknown) => {
      // Keep outstanding lifecycles available for a later shutdown attempt.
      // Sharing an in-flight close must not permanently cache its rejection.
      if (this.#closePromise === operation) this.#closePromise = undefined;
      throw error;
    });
    this.#closePromise = operation;
    return operation;
  }

  #activityStatePath(context: BrowserNativeIdentityContext): string | undefined {
    // A transport-only identity cannot be reclaimed by a different daemon.
    // Never persist raw caller/owner/conversation identifiers in this file.
    if (!context.ownerBinding || !context.workSessionBinding) return undefined;
    // Keep the existing durable owner ledger separate from native rollout
    // discovery. Moving the rollout stream must not strand active sessions.
    return join(
      this.#codexHome,
      "omnicodex",
      "browser-rollout-sessions",
      `activity-${browserConversationKey(context)}.json`,
    );
  }

  async #restoreActivity(context: BrowserNativeIdentityContext): Promise<void> {
    const key = browserConversationKey(context);
    const path = this.#activityStatePath(context);
    if (path === undefined || this.#restoredActivities.has(key)) return;
    this.#activityStateContexts.set(key, context);
    let state: unknown;
    try {
      state = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (!isObject(error) || error.code !== "ENOENT") throw error;
      this.#restoredActivities.add(key);
      return;
    }
    if (!isObject(state) || state.version !== 1 || !Array.isArray(state.lifecycles)) {
      throw new Error("BROWSER_ACTIVITY_STATE_INVALID");
    }
    if (state.unboundLifecycles !== undefined) {
      if (!Array.isArray(state.unboundLifecycles))
        throw new Error("BROWSER_ACTIVITY_STATE_INVALID");
      for (const item of state.unboundLifecycles) {
        if (
          !isObject(item) ||
          item.sessionId !==
            appGlobalBrowserSessionId({
              operation: "list_surfaces",
              ...context,
            })
        ) {
          throw new Error("BROWSER_ACTIVITY_STATE_IDENTITY_MISMATCH");
        }
        const lifecycle = await prepareBrowserTurnLifecycle(
          this.#browserRolloutSessionsRoot,
          String(item.sessionId),
          requiredContextValue(item.turnId, "contextTurnId", true),
        );
        if (item.publishedOutcome === "completed" || item.publishedOutcome === "aborted") {
          lifecycle.publishedOutcome = item.publishedOutcome;
        } else if (item.publishedOutcome !== undefined) {
          throw new Error("BROWSER_ACTIVITY_STATE_INVALID");
        }
        const turnKey = browserTurnLifecycleKey(lifecycle);
        this.#unboundTurnLifecycles.set(turnKey, lifecycle);
        this.#durableUnboundTurnKeys.add(turnKey);
        this.#restoredUnboundTurnKeys.add(turnKey);
      }
    }
    if (state.activity !== null) {
      const activity = requiredContextValue(state.activity, "activityBinding", true);
      const lifecycles = new Map<string, BrowserTurnLifecycle>();
      for (const item of state.lifecycles) {
        if (
          !isObject(item) ||
          item.sessionId !==
            appGlobalBrowserSessionId({
              operation: "list_surfaces",
              ...context,
            })
        ) {
          throw new Error("BROWSER_ACTIVITY_STATE_IDENTITY_MISMATCH");
        }
        const lifecycle = await prepareBrowserTurnLifecycle(
          this.#browserRolloutSessionsRoot,
          String(item.sessionId),
          requiredContextValue(item.turnId, "contextTurnId", true),
        );
        if (item.publishedOutcome === "completed" || item.publishedOutcome === "aborted") {
          lifecycle.publishedOutcome = item.publishedOutcome;
        } else if (item.publishedOutcome !== undefined) {
          throw new Error("BROWSER_ACTIVITY_STATE_INVALID");
        }
        lifecycles.set(browserTurnLifecycleKey(lifecycle), lifecycle);
      }
      this.#currentActivities.set(key, activity);
      if (state.retiring === true)
        this.#retiringActivities.add(browserActivityKey(context, activity));
      if (lifecycles.size > 0) {
        this.#activityTurnLifecycles.set(browserActivityKey(context, activity), lifecycles);
      }
      if (state.cuaLifecycles !== undefined) {
        if (!Array.isArray(state.cuaLifecycles)) throw new Error("BROWSER_ACTIVITY_STATE_INVALID");
        const restored = new Map<string, CuaTurnLifecycle>();
        for (const item of state.cuaLifecycles) {
          if (
            !isObject(item) ||
            typeof item.server !== "string" ||
            !isCuaNativeTool(item.server, "js") ||
            item.sessionId !== cuaSessionId(context) ||
            typeof item.turnId !== "string" ||
            (item.contextThreadId !== undefined && typeof item.contextThreadId !== "string")
          ) {
            throw new Error("BROWSER_ACTIVITY_STATE_IDENTITY_MISMATCH");
          }
          const lifecycle: CuaTurnLifecycle = {
            server: item.server,
            sessionId: item.sessionId,
            turnId: requiredContextValue(item.turnId, "contextTurnId", true),
            ...(typeof item.contextThreadId === "string"
              ? { contextThreadId: item.contextThreadId }
              : {}),
          };
          const turnKey = `${lifecycle.server}\0${lifecycle.sessionId}\0${lifecycle.turnId}`;
          restored.set(turnKey, lifecycle);
          this.#restoredCuaTurns.add(turnKey);
        }
        if (restored.size > 0)
          this.#cuaTurnLifecycles.set(browserActivityKey(context, activity), restored);
      }
    }
    this.#restoredActivities.add(key);
  }

  async #persistActivity(context: BrowserNativeIdentityContext): Promise<void> {
    const path = this.#activityStatePath(context);
    if (path === undefined) return;
    this.#activityStateContexts.set(browserConversationKey(context), context);
    const activity = this.#currentActivities.get(browserConversationKey(context));
    const lifecycles =
      activity === undefined
        ? undefined
        : this.#activityTurnLifecycles.get(browserActivityKey(context, activity));
    const state = {
      version: 1,
      activity: activity ?? null,
      retiring:
        activity !== undefined &&
        this.#retiringActivities.has(browserActivityKey(context, activity)),
      lifecycles: [...(lifecycles?.values() ?? [])].map(
        ({ sessionId, turnId, publishedOutcome }) => ({
          sessionId,
          turnId,
          ...(publishedOutcome === undefined ? {} : { publishedOutcome }),
        }),
      ),
      cuaLifecycles:
        activity === undefined
          ? []
          : [
              ...(this.#cuaTurnLifecycles.get(browserActivityKey(context, activity))?.values() ??
                []),
            ],
      unboundLifecycles: [...this.#unboundTurnLifecycles.values()]
        .filter(
          (lifecycle) =>
            lifecycle.sessionId ===
            appGlobalBrowserSessionId({
              operation: "list_surfaces",
              ...context,
            }),
        )
        .map(({ sessionId, turnId, publishedOutcome }) => ({
          sessionId,
          turnId,
          ...(publishedOutcome === undefined ? {} : { publishedOutcome }),
        })),
    };
    await serializeBrowserLifecycleWrite(path, async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(state), {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch((error: unknown) => {
          if (!isObject(error) || error.code !== "ENOENT") throw error;
        });
      }
    });
  }

  async #releaseCuaTurns(lifecycles: Map<string, CuaTurnLifecycle>): Promise<void> {
    for (const [key, lifecycle] of lifecycles) {
      const boundary = createBrowserCallBoundary(
        undefined,
        safeDeadlineFromTimeout(DEFAULT_BROWSER_CALL_TIMEOUT_MS),
      );
      try {
        if (this.#restoredCuaTurns.has(key)) {
          // Fresh CUA kernels have no Stop tracker. This read re-registers the
          // persisted owner before its first ending; never probe this session
          // again after Stop because doing so resumes handoff tabs.
          const prepared = await waitForBrowserBoundary(
            this.#nativeExecutor.callInContext(
              lifecycle.server,
              "js",
              { code: "await cua.getState();", title: "Restore CUA completion context" },
              lifecycle.contextThreadId,
              undefined,
              lifecycle.turnId,
              boundary.signal,
              lifecycle.sessionId,
            ),
            boundary.signal,
          );
          const state = cuaStateReadback(prepared);
          const preparationFailure = nativeCallFailure(prepared);
          if (
            preparationFailure !== undefined ||
            state === undefined ||
            (Array.isArray(state.errors) && state.errors.length > 0) ||
            state.browsers.length === 0
          ) {
            throw new Error(
              `CUA_CLEANUP_CONTEXT_UNAVAILABLE: ${preparationFailure ?? JSON.stringify(state?.errors ?? ["Browser state unavailable"])}`,
            );
          }
          this.#restoredCuaTurns.delete(key);
        }
        const result = await waitForBrowserBoundary(
          this.#nativeExecutor.callInContext(
            lifecycle.server,
            "turn_ended",
            {
              hook_event_name: "Stop",
              session_id: lifecycle.sessionId,
              turn_id: lifecycle.turnId,
            },
            lifecycle.contextThreadId,
            undefined,
            lifecycle.turnId,
            boundary.signal,
            lifecycle.sessionId,
          ),
          boundary.signal,
        );
        const failure = nativeCallFailure(result);
        if (failure !== undefined) throw new Error(failure);
        lifecycles.delete(key);
      } finally {
        boundary.clear();
      }
    }
  }

  async #call(argumentsValue: unknown, context: BrowserNativeCallContext): Promise<unknown> {
    if (!isObject(argumentsValue)) throw new Error("Browser arguments must be an object");
    const operation = classifyBrowserNativeOperation(argumentsValue.operation, argumentsValue.code);
    if (operation === "exec" && typeof argumentsValue.code !== "string") {
      const receivedShape = Object.keys(argumentsValue)
        .sort((left, right) => left.localeCompare(right, "en"))
        .map(
          (key) =>
            `${key}:${Array.isArray(argumentsValue[key]) ? "array" : typeof argumentsValue[key]}`,
        )
        .join(",");
      throw new Error(
        `Browser execution requires a JavaScript code string (received ${receivedShape || "empty object"})`,
      );
    }
    const timeoutMs = browserTimeout(argumentsValue.timeout_ms) ?? DEFAULT_BROWSER_CALL_TIMEOUT_MS;
    const deadlineUnixMs = minimumDefined(
      browserDeadline(context.deadlineUnixMs),
      timeoutMs === undefined ? undefined : safeDeadlineFromTimeout(timeoutMs),
    );
    const boundary = createBrowserCallBoundary(context.signal, deadlineUnixMs);
    try {
      if (operation === "documentation") {
        const name = browserDocumentationName(argumentsValue.documentation_name);
        if (name !== undefined) {
          const markdown = await waitForBrowserBoundary(
            this.#policyDocumentation.readBrowserDocument(
              name,
              browserSurface(argumentsValue),
              boundary.signal,
            ),
            boundary.signal,
          );
          if (markdown !== undefined) return { content: [{ type: "text", text: markdown }] };
        }
      }
      observeBrowserExecutionStage(context, "runtime_setup");
      throwIfBrowserCallAborted(boundary.signal);
      // Nested Responses tools supply an exact model activity directly, without
      // passing through the Web coordinator. Register it before writing its
      // native lifecycle so replacement can recover the outstanding owner.
      if (context.activityBinding !== undefined) {
        await this.beginActivity(context.activityBinding, context);
        throwIfBrowserCallAborted(boundary.signal);
      }
      const effectiveActivity =
        context.activityBinding === undefined
          ? undefined
          : this.#canonicalActivity(context, context.activityBinding);
      let effectiveContext =
        effectiveActivity === undefined || effectiveActivity === context.activityBinding
          ? context
          : { ...context, activityBinding: effectiveActivity };
      const identityContext = browserIdentityContext(effectiveContext);
      if (effectiveContext.activityBinding === undefined)
        await this.#restoreActivity(identityContext);
      const contextRequest: BrowserNativeContextRequest =
        operation === "list_surfaces"
          ? { operation, ...identityContext }
          : {
              operation,
              surface: browserSurface(argumentsValue),
              ...(typeof argumentsValue.browserId === "string"
                ? { browserId: argumentsValue.browserId }
                : {}),
              ...identityContext,
            };
      const initialTarget = await this.#resolveTarget(contextRequest, boundary);
      // A daemon replacement preserves the durable native turn, while the new
      // Node runtime has no local handles for tabs still attached to that old
      // turn. End only those restored unbound turns before this runtime tries
      // to claim the same user tab again.
      await this.#releaseRestoredUnboundBrowserTurns(initialTarget, identityContext, boundary);
      // NativeToolExecutor would otherwise generate a turn that this owner
      // cannot retire. Keep that same per-call lifetime explicit for MCP
      // callers which have no model-activity metadata.
      const turnId =
        effectiveContext.contextTurnId ?? effectiveContext.activityBinding ?? randomUUID();
      if (
        effectiveContext.contextTurnId === undefined &&
        effectiveContext.activityBinding === undefined
      )
        effectiveContext = { ...effectiveContext, contextTurnId: turnId };
      if (
        turnId !== undefined &&
        initialTarget.browserSessionId !== initialTarget.contextThreadId
      ) {
        // The installed tracker settles a turn by detaching every tab in its
        // Browser Use session. That is correct for an OmniCodex-owned
        // synthetic session, but not for a verified desktop-host session that
        // is deliberately shared with the local Codex client. Logical cleanup
        // below already closes only OmniCodex-created ephemeral tabs; never
        // detach the host's pre-existing/user tabs from the shared session.
        const lifecycle = await prepareBrowserTurnLifecycle(
          this.#browserRolloutSessionsRoot,
          initialTarget.browserSessionId,
          requiredContextValue(turnId, "contextTurnId", true),
        );
        const turnKey = browserTurnLifecycleKey(lifecycle);
        if (this.#requiresActiveNativeRelease) {
          this.#nativeReleaseTargets.set(turnKey, {
            target: initialTarget,
            turnId: lifecycle.turnId,
          });
        }
        if (effectiveContext.activityBinding !== undefined) {
          const activityKey = browserActivityKey(
            effectiveContext,
            effectiveContext.activityBinding,
          );
          let lifecycles = this.#activityTurnLifecycles.get(activityKey);
          if (lifecycles === undefined) {
            lifecycles = new Map<string, BrowserTurnLifecycle>();
            this.#activityTurnLifecycles.set(activityKey, lifecycles);
          }
          lifecycles.set(turnKey, lifecycle);
          // Persist before caller code runs, not only at graceful shutdown:
          // a replacement must keep the native turn id even after a crash.
          await this.#persistActivity(effectiveContext);
        } else {
          // A caller can provide an exact native turn without a higher-level
          // activity coordinator. Retain that lifecycle until close instead of
          // silently losing the only first-party cleanup signal.
          this.#unboundTurnLifecycles.set(turnKey, lifecycle);
          if (this.#activityStatePath(identityContext) !== undefined) {
            this.#durableUnboundTurnKeys.add(turnKey);
            await this.#persistActivity(identityContext);
          }
        }
      }
      const failedRuntimeKey = browserRuntimeKey(initialTarget);
      const observedRecoveryGeneration =
        this.#recoveryStates.get(failedRuntimeKey)?.generation ?? 0;
      let firstResult: unknown;
      try {
        firstResult = await this.#dispatch(
          argumentsValue,
          contextRequest,
          initialTarget,
          effectiveContext,
          boundary,
        );
      } catch (error) {
        const failedBeforeCallerDispatch = isBrowserPreDispatchFailure(error);
        if (!isRecoverableBrowserDisconnect(error)) throw error;
        observeBrowserExecutionStage(effectiveContext, "runtime_recovery");
        const recoveredTarget = await this.#recoverBrowserRuntime(
          failedRuntimeKey,
          observedRecoveryGeneration,
          this.#recoveryContextRequest(contextRequest, initialTarget),
          boundary,
          isBrowserSurfaceUnavailable(error),
          turnId,
        ).catch((recoveryFailure: unknown) => {
          throw browserRecoveryFailedError(
            error,
            recoveryFailure,
            !isReplaySafeBrowserOperation(contextRequest.operation) && !failedBeforeCallerDispatch,
          );
        });
        if (
          !isReplaySafeBrowserOperation(contextRequest.operation) &&
          !failedBeforeCallerDispatch
        ) {
          throw browserOutcomeUnknownError(error);
        }
        const recoveredResult = await this.#dispatch(
          argumentsValue,
          contextRequest,
          recoveredTarget,
          effectiveContext,
          boundary,
        );
        this.#noteSurfaceAvailable(contextRequest, recoveredResult);
        return recoveredResult;
      }

      if (contextRequest.operation === "list_surfaces" && lacksExtensionSurface(firstResult)) {
        return await this.#awaitLateExtensionSurface(
          argumentsValue,
          contextRequest,
          initialTarget,
          effectiveContext,
          boundary,
          firstResult,
        );
      }
      if (!isRecoverableBrowserDisconnectResult(firstResult)) {
        this.#noteSurfaceAvailable(contextRequest, firstResult);
        return firstResult;
      }
      const failedBeforeCallerDispatch = isBrowserPreDispatchFailure(firstResult);
      observeBrowserExecutionStage(effectiveContext, "runtime_recovery");
      const recoveredTarget = await this.#recoverBrowserRuntime(
        failedRuntimeKey,
        observedRecoveryGeneration,
        this.#recoveryContextRequest(contextRequest, initialTarget),
        boundary,
        isBrowserSurfaceUnavailable(firstResult),
        turnId,
      ).catch((recoveryFailure: unknown) => {
        throw browserRecoveryFailedError(
          firstResult,
          recoveryFailure,
          !isReplaySafeBrowserOperation(contextRequest.operation) && !failedBeforeCallerDispatch,
        );
      });
      if (!isReplaySafeBrowserOperation(contextRequest.operation) && !failedBeforeCallerDispatch) {
        throw browserOutcomeUnknownError(firstResult);
      }
      const recoveredResult = await this.#dispatch(
        argumentsValue,
        contextRequest,
        recoveredTarget,
        effectiveContext,
        boundary,
      );
      this.#noteSurfaceAvailable(contextRequest, recoveredResult);
      return recoveredResult;
    } finally {
      boundary.clear();
    }
  }

  #canonicalActivity(
    context: Omit<BrowserNativeCallContext, "activityBinding">,
    activityBinding: string,
  ): string {
    return (
      this.#activityAliases.get(browserActivityKey(context, activityBinding))?.canonicalActivity ??
      activityBinding
    );
  }

  async #resolveTarget(
    request: BrowserNativeContextRequest,
    boundary: ActiveBrowserCallBoundary,
  ): Promise<BrowserNativeTarget> {
    throwIfBrowserCallAborted(boundary.signal);
    if (!requiresTaskScopedBrowserContext(request)) {
      const contextResolution = this.#resolveContextThreadId?.(request, boundary);
      const contextThreadId =
        contextResolution === undefined
          ? undefined
          : await waitForBrowserBoundary(contextResolution, boundary.signal);
      throwIfBrowserCallAborted(boundary.signal);
      const runtimeBinding = appGlobalRuntimeBinding(request);
      return {
        clientPath: await this.#locateClient(boundary.signal),
        environment: this.#environment,
        // Chrome/Edge/extension use the authenticated Work executor and keep
        // mutable browser state partitioned by the caller's Work session.
        contextThreadId,
        browserSessionId: appGlobalBrowserSessionId(request),
        runtimeBinding,
      };
    }
    const requestedThreadId = request.contextThreadId;
    if (requestedThreadId === undefined) {
      throw new Error(
        "IAB_CONTEXT_THREAD_ID_REQUIRED: in-app browser control requires an exact Codex desktop task",
      );
    }
    if (this.#resolveContextThreadId === undefined) {
      throw new Error(
        "IAB_CONTEXT_VALIDATOR_UNAVAILABLE: in-app browser context ownership cannot be verified",
      );
    }
    const contextThreadId = await waitForBrowserBoundary(
      this.#resolveContextThreadId(request, boundary),
      boundary.signal,
    );
    throwIfBrowserCallAborted(boundary.signal);
    if (contextThreadId !== requestedThreadId) {
      throw new Error(
        "IAB_CONTEXT_NOT_DESKTOP_OWNED: the exact requested Codex task is not owned by a live desktop window",
      );
    }
    return {
      clientPath: await this.#locateClient(boundary.signal),
      environment: this.#environment,
      contextThreadId,
      // IAB is task-scoped in the first-party service, so its browser session
      // identity must remain the exact verified desktop task.
      browserSessionId: contextThreadId,
      runtimeBinding: taskScopedRuntimeBinding(request, contextThreadId),
    };
  }

  async #dispatch(
    argumentsValue: Record<string, unknown>,
    request: BrowserNativeContextRequest,
    target: BrowserNativeTarget,
    context: BrowserNativeCallContext,
    boundary: ActiveBrowserCallBoundary,
  ): Promise<unknown> {
    throwIfBrowserCallAborted(boundary.signal);
    let resolvedArguments = argumentsValue;
    if (request.operation !== "list_surfaces" && typeof argumentsValue.browserId === "string") {
      const discovery = await waitForBrowserBoundary(
        this.#nativeExecutor.callInContext(
          "node_repl",
          "js",
          {
            code: browserBootstrapCode(
              target,
              { operation: "list_surfaces" },
              {},
              context.activityBinding,
            ),
            ...(boundary.deadlineUnixMs === undefined
              ? {}
              : {
                  timeout_ms: remainingBrowserDeadline(boundary.deadlineUnixMs),
                }),
          },
          target.contextThreadId,
          undefined,
          context.contextTurnId ?? context.activityBinding,
          boundary.signal,
          target.browserSessionId,
        ),
        boundary.signal,
      );
      const failure = nativeCallFailure(discovery);
      if (failure !== undefined) throw new Error(failure);
      const surfaces = browserSurfaceReadback(discovery);
      if (surfaces === undefined)
        throw new Error(
          "BROWSER_SELECTION_STALE: native browser discovery did not return identities",
        );
      let identities = this.#browserIdentities.get(target.runtimeBinding);
      if (identities === undefined) {
        identities = new Map();
        this.#browserIdentities.set(target.runtimeBinding, identities);
      }
      const selector = argumentsValue.browserId;
      let binding = identities.get(selector);
      if (binding === undefined) {
        const named = surfaces.filter((entry) =>
          browserSelectorAliases(entry, surfaces).includes(selector),
        );
        const [namedSurface] = named;
        if (named.length === 1 && namedSurface !== undefined)
          binding = browserKeyBinding(namedSurface, surfaces, selector);
        if (binding === undefined && request.surface === "chrome" && /^\d+$/u.test(selector)) {
          const chromeProfiles = surfaces.filter(
            (entry) =>
              isChromeExtensionSurface(entry) && browserIdentityAliases(entry, surfaces).length > 0,
          );
          // A bare numeric id historically meant "the sole Chrome profile".
          if (chromeProfiles.length === 1)
            binding = {
              aliases: browserIdentityAliases(chromeProfiles[0], surfaces),
              familyKey: true,
            };
        }
        if (binding === undefined || binding.aliases.length === 0)
          throw new Error(
            "BROWSER_SELECTION_STALE: selected browser key is absent or ambiguous; list browser surfaces again and use its stable profile key",
          );
      }
      const matches = resolveBrowserKeyBinding(binding, surfaces);
      if (
        matches.length === 0 &&
        request.surface === "chrome" &&
        !surfaces.some((entry) => isChromeExtensionSurface(entry))
      ) {
        // The remembered selection is known but its entire Chrome surface is
        // gone. Reconnect that selection before treating its key as stale.
        throw new Error(`${BROWSER_PRE_DISPATCH_FAILURE_PREFIX}Browser is not available: chrome`);
      }
      if (matches.length !== 1)
        throw new Error(
          "BROWSER_SELECTION_STALE: selected native connection is absent or ambiguous; list browser surfaces again",
        );
      // Remember the identities the surface has now as well, so the key keeps
      // resolving when the visible profile count changes again.
      identities.set(selector, {
        aliases: [
          ...new Set([...binding.aliases, ...browserIdentityAliases(matches[0], surfaces)]),
        ],
        familyKey: binding.familyKey,
      });
      resolvedArguments = { ...argumentsValue, browserId: matches[0]?.id };
    }
    const bootstrap = browserBootstrapCode(
      target,
      request,
      resolvedArguments,
      context.activityBinding,
    );
    const remainingTimeoutMs = remainingBrowserDeadline(boundary.deadlineUnixMs);
    observeBrowserExecutionStage(context, "native_dispatch");
    const result = await waitForBrowserBoundary(
      this.#nativeExecutor.callInContext(
        "node_repl",
        "js",
        {
          code: bootstrap,
          ...(remainingTimeoutMs === undefined ? {} : { timeout_ms: remainingTimeoutMs }),
          ...(typeof argumentsValue.title === "string" ? { title: argumentsValue.title } : {}),
        },
        target.contextThreadId,
        undefined,
        context.contextTurnId ?? context.activityBinding,
        boundary.signal,
        target.browserSessionId,
      ),
      boundary.signal,
    );
    observeBrowserExecutionStage(context, "native_returned");
    if (request.operation === "list_surfaces" && nativeCallFailure(result) === undefined) {
      const surfaces = browserSurfaceReadback(result);
      if (surfaces !== undefined) {
        // Keys issued by earlier listings stay usable: each still resolves only
        // when its remembered aliases match exactly one current surface.
        this.#browserIdentities.set(
          target.runtimeBinding,
          new Map([
            ...(this.#browserIdentities.get(target.runtimeBinding) ?? []),
            ...surfaces.flatMap((entry) =>
              browserSelectorAliases(entry, surfaces).flatMap((selector) => {
                const binding = browserKeyBinding(entry, surfaces, selector);
                return binding.aliases.length === 0 ? [] : [[selector, binding] as const];
              }),
            ),
          ]),
        );
        return presentedBrowserSurfaceResult(result);
      }
    }
    return result;
  }

  #recoveryContextRequest(
    request: BrowserNativeContextRequest,
    target: BrowserNativeTarget,
  ): BrowserNativeContextRequest {
    if (request.operation === "list_surfaces") return request;
    const identities = this.#browserIdentities.get(target.runtimeBinding);
    if (request.browserId === undefined) {
      const names = new Set(
        [...(identities?.entries() ?? [])].flatMap(([id, binding]) => {
          const name = selectedChromeProfileName(binding, id);
          return name === undefined ? [] : [name];
        }),
      );
      const [onlyName] = names;
      return names.size === 1 && onlyName !== undefined
        ? { ...request, chromeProfileName: onlyName }
        : request;
    }
    const binding = identities?.get(request.browserId);
    const profileName = selectedChromeProfileName(binding, request.browserId);
    return profileName === undefined ? request : { ...request, chromeProfileName: profileName };
  }

  async #recoverBrowserRuntime(
    failedRuntimeKey: string,
    observedGeneration: number,
    request: BrowserNativeContextRequest,
    boundary: ActiveBrowserCallBoundary,
    surfaceUnavailable: boolean,
    contextTurnId: string,
  ): Promise<BrowserNativeTarget> {
    // A plugin update can invalidate the cached module path independently of
    // the selected Chrome/IAB runtime. Re-scan it before repairing this one
    // caller-bound runtime; other bindings remain live.
    this.#clientPath = undefined;
    const target = await this.#resolveTarget(request, boundary);
    const runtimeKey = browserRuntimeKey(target);
    const state = this.#recoveryStates.get(runtimeKey) ?? {
      generation: 0,
      flight: undefined,
    };
    if (!this.#recoveryStates.has(runtimeKey)) {
      this.#recoveryStates.set(runtimeKey, state);
    }
    // The physical browser runtime is shared, but the selected Chrome profile
    // belongs to each request and must be recovered before coalescing runtimes.
    if (surfaceUnavailable && this.#surfaceRecovery !== undefined) {
      throwIfBrowserCallAborted(boundary.signal);
      await waitForBrowserBoundary(
        this.#surfaceRecovery.recoverUnavailableSurface(request, boundary.signal),
        boundary.signal,
      );
    }
    if (runtimeKey === failedRuntimeKey && state.generation !== observedGeneration) return target;
    if (state.flight === undefined) {
      const nextGeneration = state.generation + 1;
      const recovery = (async () => {
        const result = await this.#nativeExecutor.callInContext(
          "node_repl",
          "js",
          {
            code: browserRecoveryCode(target, nextGeneration),
            title: "Reconnect first-party browser runtime",
            ...(boundary.deadlineUnixMs === undefined
              ? {}
              : {
                  timeout_ms: remainingBrowserDeadline(boundary.deadlineUnixMs),
                }),
          },
          target.contextThreadId,
          undefined,
          // Reconnecting belongs to the interrupted turn. A new native turn
          // can clear that turn's handoff/deliverable marks on existing tabs.
          contextTurnId,
          // Recovery is shared only by callers bound to this exact runtime.
          // A cancelled waiter must not poison that shared physical repair.
          undefined,
          target.browserSessionId,
        );
        const failure = nativeCallFailure(result);
        if (failure !== undefined) {
          throw new Error(`First-party browser runtime recovery failed: ${failure}`, {
            cause: result,
          });
        }
        state.generation = nextGeneration;
      })();
      const installed = recovery.then(() => undefined);
      state.flight = installed;
      void installed.then(
        () => {
          if (state.flight === installed) state.flight = undefined;
        },
        () => {
          if (state.flight === installed) state.flight = undefined;
        },
      );
    }
    const flight = state.flight;
    if (flight === undefined) {
      throw new Error("First-party browser runtime recovery was not installed");
    }
    await waitForBrowserBoundary(flight, boundary.signal);
    return target;
  }

  /**
   * An empty listing right after the browser was started usually means its
   * extension has not connected yet, not that no browser exists. Re-read the
   * listing for a bounded time only while the host browser is running; never
   * launch one from a listing, and return at once when it is not running.
   */
  async #awaitLateExtensionSurface(
    argumentsValue: Record<string, unknown>,
    request: BrowserNativeContextRequest,
    target: BrowserNativeTarget,
    context: BrowserNativeCallContext,
    boundary: ActiveBrowserCallBoundary,
    emptyListing: unknown,
  ): Promise<unknown> {
    const recovery = this.#surfaceRecovery;
    if (recovery?.isExtensionHostRunning === undefined) return emptyListing;
    let hostRunning: boolean;
    try {
      // The diagnostic has its own 15 s child timeout; the caller's deadline
      // and cancellation still bound this wait.
      hostRunning = await waitForBrowserBoundary(
        recovery.isExtensionHostRunning(),
        boundary.signal,
      );
    } catch (error) {
      if (boundary.signal?.aborted === true) throw error;
      // A failed diagnostic is not evidence that the browser is closed.
      throw new Error(
        `BROWSER_EXTENSION_HOST_DIAGNOSTIC_FAILED: could not determine whether the extension host browser is running: ${toError(error).message}`,
        { cause: error },
      );
    }
    if (!hostRunning) return emptyListing;
    const waitDeadline =
      minimumDefined(boundary.deadlineUnixMs, Date.now() + this.#lateExtensionSurfaceWaitMs) ??
      Date.now();
    while (Date.now() + this.#lateExtensionSurfacePollMs <= waitDeadline) {
      await waitForBrowserBoundary(delay(this.#lateExtensionSurfacePollMs), boundary.signal);
      const listing = await this.#dispatch(argumentsValue, request, target, context, boundary);
      // A failed re-read is returned as is; it is not an empty listing.
      if (!lacksExtensionSurface(listing)) return listing;
    }
    return emptyListing;
  }

  #noteSurfaceAvailable(request: BrowserNativeContextRequest, result: unknown): void {
    if (request.operation === "list_surfaces" || nativeCallFailure(result) !== undefined) return;
    this.#surfaceRecovery?.noteSurfaceAvailable(request);
  }

  async #locateClient(signal?: AbortSignal): Promise<string> {
    throwIfBrowserCallAborted(signal);
    const selected = await locateInstalledFirstPartyAsset({
      codexHome: this.#codexHome,
      plugins: ["*"],
      relativePath: ["scripts", "browser-client.mjs"],
      ...(signal === undefined ? {} : { signal }),
    });
    throwIfBrowserCallAborted(signal);
    if (this.#clientPath !== selected) {
      this.#requiresActiveNativeRelease = await browserServiceRequiresActiveNativeRelease(selected);
      this.#clientPath = selected;
    }
    return selected;
  }

  async #releaseNativeBrowserTurns(
    turnKeys: Iterable<string>,
    boundary?: ActiveBrowserCallBoundary,
  ): Promise<void> {
    const releases = new Map<string, BrowserNativeReleaseTarget>();
    for (const turnKey of turnKeys) {
      const release = this.#nativeReleaseTargets.get(turnKey);
      if (release === undefined) continue;
      releases.set(`${browserRuntimeKey(release.target)}\0${release.turnId}`, release);
    }
    const errors: Error[] = [];
    for (const release of releases.values()) {
      if (boundary?.signal?.aborted === true) {
        errors.push(browserAbortReason(boundary.signal));
        break;
      }
      let releaseStage: "rebind" | "Stop" = "rebind";
      try {
        // A replacement Node REPL has no first-party turn tracker yet. Rebind
        // only this exact synthetic session with read-only browser requests
        // before publishing Stop, otherwise the hook silently does nothing.
        const prepared = await waitForBrowserBoundary(
          this.#nativeExecutor.callInContext(
            "node_repl",
            "js",
            {
              code: `await (async () => { const { setupBrowserRuntime } = await import(${JSON.stringify(pathToFileURL(release.target.clientPath).href)}); const agent = await setupBrowserRuntime({ environment: ${JSON.stringify(release.target.environment)} }); for (const info of await agent.browsers.list()) { if (info.type !== "extension" && info.type !== "cdp") continue; const browser = await agent.browsers.get(info.id); await browser.tabs.list(); } })();`,
            },
            release.target.contextThreadId,
            undefined,
            release.turnId,
            boundary?.signal,
            release.target.browserSessionId,
          ),
          boundary?.signal,
        );
        const preparationFailure = nativeCallFailure(prepared);
        if (preparationFailure !== undefined) throw new Error(preparationFailure);
        // Current Browser Use releases replaced the rollout watcher with the
        // first-party node_repl Stop hook. Dispatch it under the exact native
        // session and turn so browser-service can detach that session's tabs.
        // Do not start a Stop hook after the caller's deadline. Its effects
        // would otherwise be unknowable to the caller and another session.
        releaseStage = "Stop";
        throwIfBrowserCallAborted(boundary?.signal);
        const result = await waitForBrowserBoundary(
          this.#nativeExecutor.callInContext(
            "node_repl",
            "turn_ended",
            {
              hook_event_name: "Stop",
              session_id: release.target.browserSessionId,
              turn_id: release.turnId,
            },
            release.target.contextThreadId,
            undefined,
            release.turnId,
            boundary?.signal,
            release.target.browserSessionId,
          ),
          boundary?.signal,
        );
        const failure = nativeCallFailure(result);
        if (failure !== undefined) throw new Error(failure);
        for (const [turnKey, candidate] of this.#nativeReleaseTargets) {
          if (
            browserRuntimeKey(candidate.target) === browserRuntimeKey(release.target) &&
            candidate.turnId === release.turnId
          ) {
            this.#nativeReleaseTargets.delete(turnKey);
          }
        }
      } catch (error) {
        errors.push(
          new Error(`Native browser ${releaseStage} failed: ${toError(error).message}`, {
            cause: error,
          }),
        );
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        `OmniCodex native browser sessions did not release cleanly (first: ${errors[0]?.message})`,
      );
    }
  }

  async #releaseActivityBrowserTurns(
    lifecycles: ReadonlyMap<string, BrowserTurnLifecycle>,
    context: BrowserNativeIdentityContext,
  ): Promise<void> {
    if (lifecycles.size === 0) return;
    const boundary = createBrowserCallBoundary(
      undefined,
      safeDeadlineFromTimeout(DEFAULT_BROWSER_CALL_TIMEOUT_MS),
    );
    try {
      // Completion may arrive before a replacement runtime executes any code.
      // Discover the installed cleanup contract and restore only this owner's
      // exact synthetic session; do not wait for another call or service close.
      await this.#locateClient(boundary.signal);
      if (!this.#requiresActiveNativeRelease) return;
      let target: BrowserNativeTarget | undefined;
      for (const [key, lifecycle] of lifecycles) {
        if (this.#nativeReleaseTargets.has(key)) continue;
        target ??= await this.#resolveTarget({ operation: "list_surfaces", ...context }, boundary);
        if (target.browserSessionId !== lifecycle.sessionId) {
          throw new Error("BROWSER_ACTIVITY_STATE_IDENTITY_MISMATCH");
        }
        this.#nativeReleaseTargets.set(key, { target, turnId: lifecycle.turnId });
      }
      await this.#releaseNativeBrowserTurns(lifecycles.keys(), boundary);
    } finally {
      boundary.clear();
    }
  }

  async #releaseRestoredUnboundBrowserTurns(
    target: BrowserNativeTarget,
    context: BrowserNativeIdentityContext,
    boundary: ActiveBrowserCallBoundary,
  ): Promise<void> {
    if (!this.#requiresActiveNativeRelease || this.#restoredUnboundTurnKeys.size === 0) return;
    const restored = [...this.#restoredUnboundTurnKeys].filter((turnKey) => {
      const lifecycle = this.#unboundTurnLifecycles.get(turnKey);
      return lifecycle?.sessionId === target.browserSessionId;
    });
    if (restored.length === 0) return;
    for (const turnKey of restored) {
      const lifecycle = this.#unboundTurnLifecycles.get(turnKey);
      if (lifecycle === undefined) continue;
      this.#nativeReleaseTargets.set(turnKey, {
        target,
        turnId: lifecycle.turnId,
      });
    }
    await this.#releaseNativeBrowserTurns(restored, boundary);
    for (const turnKey of restored) {
      this.#unboundTurnLifecycles.delete(turnKey);
      this.#durableUnboundTurnKeys.delete(turnKey);
      this.#restoredUnboundTurnKeys.delete(turnKey);
    }
    await this.#persistActivity(context);
  }
}

export function isCuaNativeTool(server: string, tool: string): boolean {
  return /^(?:mcp__)?cua_repl$/u.test(server) && /^(?:js|js_reset|turn_ended)$/u.test(tool);
}

function cuaStateReadback(value: unknown): { browsers: unknown[]; errors?: unknown[] } | undefined {
  if (typeof value === "string") {
    try {
      return cuaStateReadback(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (!isObject(value)) return undefined;
  if (Array.isArray(value.browsers))
    return {
      browsers: value.browsers,
      ...(Array.isArray(value.errors) ? { errors: value.errors } : {}),
    };
  const structured = cuaStateReadback(value.structuredContent);
  if (structured !== undefined) return structured;
  if (Array.isArray(value.content)) {
    for (const item of value.content) {
      if (!isObject(item)) continue;
      const state = cuaStateReadback(item.text);
      if (state !== undefined) return state;
    }
  }
  return undefined;
}

interface CuaTurnLifecycle {
  readonly server: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly contextThreadId?: string;
}

function cuaSessionId(context: BrowserNativeIdentityContext): string {
  return (
    context.workSessionBinding ??
    context.callerSessionId ??
    appGlobalBrowserSessionId({ operation: "list_surfaces", ...context })
  );
}

interface BrowserNativeTarget {
  readonly clientPath: string;
  readonly environment: "codex-app" | "training";
  readonly contextThreadId: string | undefined;
  /** Browser Use's mutable attachment identity, distinct from its live UI host. */
  readonly browserSessionId: string;
  readonly runtimeBinding: string;
}

interface BrowserNativeReleaseTarget {
  readonly target: BrowserNativeTarget;
  readonly turnId: string;
}

interface BrowserRecoveryState {
  generation: number;
  flight: Promise<void> | undefined;
}

interface ActiveBrowserCallBoundary extends BrowserNativeContextBoundary {
  clear(): void;
}

function createBrowserCallBoundary(
  callerSignal: AbortSignal | undefined,
  deadlineUnixMs: number | undefined,
): ActiveBrowserCallBoundary {
  if (deadlineUnixMs === undefined) {
    return {
      ...(callerSignal === undefined ? {} : { signal: callerSignal }),
      clear: () => undefined,
    };
  }
  const deadlineController = new AbortController();
  const clear = scheduleBrowserDeadline(deadlineUnixMs, () => {
    deadlineController.abort(browserDeadlineError(deadlineUnixMs));
  });
  return {
    deadlineUnixMs,
    signal:
      callerSignal === undefined
        ? deadlineController.signal
        : AbortSignal.any([callerSignal, deadlineController.signal]),
    clear,
  };
}

/** @internal Keep late native rejections observed after a caller deadline. */
export function waitForBrowserBoundary<T>(
  completion: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return completion;
  if (signal.aborted) {
    // The caller may have created an already-rejected native Promise before
    // entering this boundary. Observe it even though this wait cannot start.
    void completion.catch(() => undefined);
    return Promise.reject(browserAbortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => finish(() => reject(browserAbortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    void completion.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function scheduleBrowserDeadline(deadlineUnixMs: number, action: () => void): () => void {
  const maxTimerDelayMs = 2_147_483_647;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleared = false;
  const arm = (): void => {
    if (cleared) return;
    const remainingMs = deadlineUnixMs - Date.now();
    if (remainingMs <= 0) {
      action();
      return;
    }
    timer = setTimeout(arm, Math.min(remainingMs, maxTimerDelayMs));
    timer.unref?.();
  };
  arm();
  return () => {
    cleared = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

function throwIfBrowserCallAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return;
  throw browserAbortReason(signal);
}

function browserAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Browser call was aborted");
}

function browserDeadlineError(deadlineUnixMs: number): Error {
  return new Error(`Browser call deadline exceeded (${deadlineUnixMs})`);
}

function browserTimeout(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Browser timeout_ms must be a positive safe integer");
  }
  return value;
}

function browserDeadline(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Browser deadlineUnixMs must be a positive safe integer");
  }
  return value;
}

function browserDocumentationName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Browser documentation_name must be a non-empty string");
  }
  return value.trim();
}

function safeDeadlineFromTimeout(timeoutMs: number): number {
  const now = Date.now();
  return timeoutMs > Number.MAX_SAFE_INTEGER - now ? Number.MAX_SAFE_INTEGER : now + timeoutMs;
}

function remainingBrowserDeadline(deadlineUnixMs: number | undefined): number | undefined {
  if (deadlineUnixMs === undefined) return undefined;
  const remainingMs = deadlineUnixMs - Date.now();
  if (remainingMs <= 0) throw browserDeadlineError(deadlineUnixMs);
  return Math.max(1, Math.ceil(remainingMs));
}

function lacksExtensionSurface(result: unknown): boolean {
  if (nativeCallFailure(result) !== undefined) return false;
  const surfaces = browserSurfaceReadback(result);
  return surfaces !== undefined && !surfaces.some((entry) => entry.type === "extension");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function minimumDefined(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return Math.min(first, second);
}

function browserBootstrapCode(
  target: BrowserNativeTarget,
  request: BrowserNativeContextRequest,
  value: Record<string, unknown>,
  activityBinding?: string,
): string {
  const serializedContextThreadId = JSON.stringify(target.contextThreadId ?? null);
  const serializedBrowserSessionId = JSON.stringify(target.browserSessionId);
  const serializedRuntimeBinding = JSON.stringify(target.runtimeBinding);
  const action =
    request.operation === "list_surfaces"
      ? "nodeRepl.write(JSON.stringify(await __omniAgent.browsers.list()));"
      : browserExecutionCode(request.surface, request.operation, value);
  return [
    "await (async () => {",
    `  const __omniContextThreadId = ${serializedContextThreadId};`,
    `  const __omniBrowserSessionId = ${serializedBrowserSessionId};`,
    `  const __omniBrowserEnvironment = ${JSON.stringify(target.environment)};`,
    `  const __omniBrowserRuntimeBinding = ${serializedRuntimeBinding};`,
    "  if (!(globalThis.__omniCodexBrowserRuntimes instanceof Map)) {",
    "    globalThis.__omniCodexBrowserRuntimes = new Map();",
    "  }",
    "  const __omniBrowserRuntimes = globalThis.__omniCodexBrowserRuntimes;",
    "  let __omniRuntime = __omniBrowserRuntimes.get(__omniBrowserRuntimeBinding);",
    "  if (__omniRuntime == null) {",
    "    __omniRuntime = { contextThreadId: __omniContextThreadId };",
    "    __omniBrowserRuntimes.set(__omniBrowserRuntimeBinding, __omniRuntime);",
    "  }",
    "  __omniRuntime.browserSessionId = __omniBrowserSessionId;",
    `  const __omniActivityBinding = ${JSON.stringify(activityBinding ?? null)};`,
    "  if (__omniActivityBinding !== null) {",
    "    if (__omniRuntime.activityBinding != null && __omniRuntime.activityBinding !== __omniActivityBinding) {",
    "      __omniRuntime.handleGeneration = (__omniRuntime.handleGeneration ?? 0) + 1;",
    "    }",
    "    __omniRuntime.activityBinding = __omniActivityBinding;",
    "  }",
    "  if (!(globalThis.__omniCodexBrowserPhysicalRuntimes instanceof Map)) {",
    "    globalThis.__omniCodexBrowserPhysicalRuntimes = new Map();",
    "  }",
    "  const __omniPhysicalRuntimes = globalThis.__omniCodexBrowserPhysicalRuntimes;",
    "  let __omniPhysicalRuntime = __omniPhysicalRuntimes.get(__omniBrowserSessionId);",
    "  if (__omniPhysicalRuntime == null) {",
    "    __omniPhysicalRuntime = { agent: __omniRuntime.agent };",
    "    __omniPhysicalRuntimes.set(__omniBrowserSessionId, __omniPhysicalRuntime);",
    "  }",
    "  if (__omniPhysicalRuntime.agent?.browsers == null) {",
    "    if (__omniPhysicalRuntime.setupFlight == null) {",
    "      __omniPhysicalRuntime.setupFlight = (async () => {",
    `        const { setupBrowserRuntime } = await import(${JSON.stringify(pathToFileURL(target.clientPath).href)});`,
    "        __omniPhysicalRuntime.agent = await setupBrowserRuntime({ environment: __omniBrowserEnvironment });",
    "      })();",
    "    }",
    "    const __omniSetupFlight = __omniPhysicalRuntime.setupFlight;",
    "    try {",
    "      await __omniSetupFlight;",
    "    } catch (error) {",
    `      const __omniSetupMessage = error instanceof Error ? error.message : String(error);`,
    `      throw new Error(${JSON.stringify(BROWSER_PRE_DISPATCH_FAILURE_PREFIX)} + __omniSetupMessage);`,
    "    } finally {",
    "      if (__omniPhysicalRuntime.setupFlight === __omniSetupFlight) {",
    "        __omniPhysicalRuntime.setupFlight = undefined;",
    "      }",
    "    }",
    "  }",
    "  __omniRuntime.agent = __omniPhysicalRuntime.agent;",
    "  const __omniAgent = __omniPhysicalRuntime.agent;",
    action,
    "})();",
  ].join("\n");
}

function browserRecoveryCode(target: BrowserNativeTarget, generation: number): string {
  const serializedContextThreadId = JSON.stringify(target.contextThreadId ?? null);
  const serializedBrowserSessionId = JSON.stringify(target.browserSessionId);
  const serializedRuntimeBinding = JSON.stringify(target.runtimeBinding);
  const clientUrl = new URL(pathToFileURL(target.clientPath).href);
  clientUrl.searchParams.set("omnicodex_recovery", String(generation));
  return [
    "await (async () => {",
    `  const __omniContextThreadId = ${serializedContextThreadId};`,
    `  const __omniBrowserSessionId = ${serializedBrowserSessionId};`,
    `  const __omniBrowserEnvironment = ${JSON.stringify(target.environment)};`,
    `  const __omniBrowserRuntimeBinding = ${serializedRuntimeBinding};`,
    "  if (!(globalThis.__omniCodexBrowserRuntimes instanceof Map)) {",
    "    globalThis.__omniCodexBrowserRuntimes = new Map();",
    "  }",
    "  const __omniBrowserRuntimes = globalThis.__omniCodexBrowserRuntimes;",
    "  let __omniRuntime = __omniBrowserRuntimes.get(__omniBrowserRuntimeBinding);",
    "  if (__omniRuntime == null) {",
    "    __omniRuntime = { contextThreadId: __omniContextThreadId };",
    "    __omniBrowserRuntimes.set(__omniBrowserRuntimeBinding, __omniRuntime);",
    "  }",
    "  __omniRuntime.browserSessionId = __omniBrowserSessionId;",
    "  if (!(globalThis.__omniCodexBrowserPhysicalRuntimes instanceof Map)) {",
    "    globalThis.__omniCodexBrowserPhysicalRuntimes = new Map();",
    "  }",
    "  const __omniPhysicalRuntimes = globalThis.__omniCodexBrowserPhysicalRuntimes;",
    "  let __omniPhysicalRuntime = __omniPhysicalRuntimes.get(__omniBrowserSessionId);",
    "  if (__omniPhysicalRuntime == null) {",
    "    __omniPhysicalRuntime = { agent: __omniRuntime.agent };",
    "    __omniPhysicalRuntimes.set(__omniBrowserSessionId, __omniPhysicalRuntime);",
    "  }",
    "  if (__omniPhysicalRuntime.recoveryFlight == null) {",
    "    __omniPhysicalRuntime.recoveryFlight = (async () => {",
    "      __omniPhysicalRuntime.agent = undefined;",
    "      __omniPhysicalRuntime.setupFlight = undefined;",
    "      for (const runtime of __omniBrowserRuntimes.values()) {",
    "        if (runtime?.browserSessionId === __omniBrowserSessionId) {",
    "          runtime.agent = undefined;",
    "          runtime.browserBindings = undefined;",
    "          runtime.handleGeneration = (runtime.handleGeneration ?? 0) + 1;",
    "        }",
    "      }",
    `      const { setupBrowserRuntime } = await import(${JSON.stringify(clientUrl.href)});`,
    "      const __omniFreshAgent = await setupBrowserRuntime({ environment: __omniBrowserEnvironment });",
    "      __omniPhysicalRuntime.agent = __omniFreshAgent;",
    "      for (const runtime of __omniBrowserRuntimes.values()) {",
    "        if (runtime?.browserSessionId === __omniBrowserSessionId) {",
    "          runtime.agent = __omniFreshAgent;",
    "          runtime.browserBindings = undefined;",
    "        }",
    "      }",
    "    })();",
    "  }",
    "  const __omniRecoveryFlight = __omniPhysicalRuntime.recoveryFlight;",
    "  try {",
    "    await __omniRecoveryFlight;",
    "  } finally {",
    "    if (__omniPhysicalRuntime.recoveryFlight === __omniRecoveryFlight) {",
    "      __omniPhysicalRuntime.recoveryFlight = undefined;",
    "    }",
    "  }",
    "})();",
  ].join("\n");
}

async function browserServiceRequiresActiveNativeRelease(clientPath: string): Promise<boolean> {
  try {
    const service = await readFile(join(dirname(clientPath), "browser-service.mjs"), "utf8");
    return !service.includes("BROWSER_USE_ROLLOUT_SESSIONS_ROOT");
  } catch (error) {
    // Older test fixtures and partial development installs expose only the
    // client. Preserve their rollout lifecycle contract unless an installed
    // service proves that the tracker was removed.
    if (isObject(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function browserIdentityContext(context: BrowserNativeCallContext): BrowserNativeIdentityContext {
  return {
    ...(context.contextThreadId === undefined
      ? {}
      : {
          contextThreadId: requiredContextValue(context.contextThreadId, "contextThreadId", false),
        }),
    ...(context.ownerBinding === undefined
      ? {}
      : {
          ownerBinding: requiredContextValue(context.ownerBinding, "ownerBinding", true),
        }),
    ...(context.workSessionBinding === undefined
      ? {}
      : {
          workSessionBinding: requiredContextValue(
            context.workSessionBinding,
            "workSessionBinding",
            true,
          ),
        }),
    ...(context.callerSessionId === undefined
      ? {}
      : {
          callerSessionId: requiredContextValue(context.callerSessionId, "callerSessionId", true),
        }),
    ...(context.activityBinding === undefined
      ? {}
      : {
          activityBinding: requiredContextValue(context.activityBinding, "activityBinding", true),
        }),
  };
}

function browserActivityKey(
  context: Pick<
    BrowserNativeCallContext,
    "contextThreadId" | "ownerBinding" | "workSessionBinding" | "callerSessionId"
  >,
  activityBinding: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        context.contextThreadId ?? null,
        context.ownerBinding ?? null,
        context.workSessionBinding ?? context.callerSessionId ?? null,
        activityBinding,
      ]),
      "utf8",
    )
    .digest("hex");
}

function browserConversationKey(
  context: Pick<
    BrowserNativeCallContext,
    "contextThreadId" | "ownerBinding" | "workSessionBinding" | "callerSessionId"
  >,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        context.contextThreadId ?? null,
        context.ownerBinding ?? null,
        context.workSessionBinding ?? context.callerSessionId ?? null,
      ]),
      "utf8",
    )
    .digest("hex");
}

function requiresTaskScopedBrowserContext(request: BrowserNativeContextRequest): boolean {
  return request.operation !== "list_surfaces" && request.surface === "iab";
}

function taskScopedRuntimeBinding(
  request: BrowserNativeContextRequest,
  contextThreadId: string,
): string {
  return runtimeBinding(["iab", contextThreadId], request);
}

function appGlobalRuntimeBinding(request: BrowserNativeContextRequest): string {
  return runtimeBinding(["app-global-browser"], request);
}

function appGlobalBrowserSessionId(request: BrowserNativeContextRequest): string {
  const binding = runtimeBinding(["app-global-browser-session"], request);
  // Browser Use accepts only [A-Za-z0-9_-] session ids and discovers its
  // lifecycle stream by a filename suffix containing this exact value.
  return `omnicodex_browser_${binding}`;
}

interface BrowserTurnLifecycle {
  readonly path: string;
  readonly sessionId: string;
  readonly turnId: string;
  publishedOutcome?: "completed" | "aborted";
}

const browserLifecycleWriteFlights = new Map<string, Promise<void>>();

async function prepareBrowserTurnLifecycle(
  sessionsRoot: string,
  sessionId: string,
  turnId: string,
): Promise<BrowserTurnLifecycle> {
  const normalizedSessionId = browserLifecycleSessionId(sessionId);
  const path = join(sessionsRoot, `rollout-omnicodex-${normalizedSessionId}.jsonl`);
  await serializeBrowserLifecycleWrite(path, async () => {
    await mkdir(sessionsRoot, { recursive: true });
    await appendFile(path, "", "utf8");
  });
  return { path, sessionId: normalizedSessionId, turnId };
}

async function settleBrowserTurnLifecycles(
  lifecycles: ReadonlyMap<string, BrowserTurnLifecycle>,
  outcome: "completed" | "aborted",
): Promise<void> {
  const errors: Error[] = [];
  for (const lifecycle of lifecycles.values()) {
    try {
      const record =
        outcome === "completed"
          ? {
              method: "turn/completed",
              params: { turn: { id: lifecycle.turnId } },
            }
          : {
              type: "event_msg",
              payload: { type: "turn_aborted", turn_id: lifecycle.turnId },
            };
      await serializeBrowserLifecycleWrite(lifecycle.path, async () => {
        // A partial batch failure must retry only unpublished turn endings.
        // Check inside the serialized write so concurrent retirement paths
        // cannot publish both completed and aborted for the same lifecycle.
        if (lifecycle.publishedOutcome !== undefined) return;
        await appendFile(lifecycle.path, `${JSON.stringify(record)}\n`, "utf8");
        lifecycle.publishedOutcome = outcome;
      });
    } catch (error) {
      errors.push(toError(error));
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Browser turn lifecycle settlement failed");
  }
}

function browserLifecycleSessionId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new Error(`BROWSER_SESSION_ID_INVALID: ${JSON.stringify(value)}`);
  }
  return value;
}

function browserTurnLifecycleKey(lifecycle: BrowserTurnLifecycle): string {
  return `${lifecycle.sessionId}\u0000${lifecycle.turnId}`;
}

async function serializeBrowserLifecycleWrite(
  path: string,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = browserLifecycleWriteFlights.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const settled = current.finally(() => {
    if (browserLifecycleWriteFlights.get(path) === settled) {
      browserLifecycleWriteFlights.delete(path);
    }
  });
  browserLifecycleWriteFlights.set(path, settled);
  return settled;
}

function runtimeBinding(
  namespace: readonly string[],
  request: BrowserNativeContextRequest,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        ...namespace,
        request.ownerBinding ?? null,
        request.workSessionBinding ?? request.callerSessionId ?? null,
      ]),
      "utf8",
    )
    .digest("hex");
}

function requiredContextValue(value: unknown, name: string, allowNul: boolean): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    /[\r\n]/u.test(value) ||
    (!allowNul && value.includes("\0"))
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function browserRuntimeKey(target: BrowserNativeTarget): string {
  return `${target.contextThreadId ?? ""}\0${target.runtimeBinding}`;
}

function isRecoverableBrowserDisconnectResult(value: unknown): boolean {
  return nativeCallFailure(value) !== undefined && isRecoverableBrowserDisconnect(value);
}

function browserOutcomeUnknownError(cause: unknown): Error {
  return new Error(
    "BROWSER_OUTCOME_UNKNOWN_REBOUND: The first-party browser runtime disconnected while " +
      "browser code was in flight. " +
      "Its outcome is unknown; OmniCodex recovered the runtime but did not replay the operation.",
    { cause },
  );
}

function browserRecoveryFailedError(
  originalFailure: unknown,
  recoveryFailure: unknown,
  outcomeUnknown: boolean,
): Error {
  const code = outcomeUnknown
    ? "BROWSER_OUTCOME_UNKNOWN_RECOVERY_FAILED"
    : "BROWSER_RECOVERY_FAILED";
  return new Error(
    `${code}: ${toError(recoveryFailure).message}. ` +
      (outcomeUnknown ? "The original browser operation's outcome remains unknown. " : "") +
      "The original operation was not replayed.",
    { cause: { originalFailure, recoveryFailure } },
  );
}

function nativeCallFailure(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  if (value.isError !== true && value.success !== false && value.ok !== false) return undefined;
  const messages = collectErrorMessages(value);
  return messages.length === 0 ? "Native browser call failed" : messages.join(" | ");
}

function isRecoverableBrowserDisconnect(error: unknown): boolean {
  const message = collectErrorMessages(error).join(" | ");
  if (message.length === 0 || nonRecoverableBrowserFailure.test(message)) return false;
  if (isBrowserPreDispatchFailure(error)) return true;
  if (isBrowserSurfaceUnavailable(error)) return true;
  return browserDisconnectPatterns.some((pattern) => pattern.test(message));
}

function isBrowserPreDispatchFailure(error: unknown): boolean {
  return collectErrorMessages(error).some((message) =>
    message.includes(BROWSER_PRE_DISPATCH_FAILURE_PREFIX),
  );
}

function isBrowserSurfaceUnavailable(error: unknown): boolean {
  return collectErrorMessages(error).some((message) =>
    /\b(?:browser|chrome|edge|extension)\s+is\s+not\s+available\b|\bCHROME_SURFACE_UNAVAILABLE\b/iu.test(
      message,
    ),
  );
}

function collectErrorMessages(value: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  const pending: unknown[] = [value];
  for (let index = 0; index < pending.length; index += 1) {
    const candidate = pending[index];
    if (seen.has(candidate)) continue;
    if (typeof candidate === "string") {
      if (candidate.length > 0) messages.push(candidate);
      continue;
    }
    if (candidate instanceof Error) {
      seen.add(candidate);
      if (candidate.name.length > 0) messages.push(candidate.name);
      if (candidate.message.length > 0) messages.push(candidate.message);
      if (candidate.cause !== undefined) pending.push(candidate.cause);
      continue;
    }
    if (!isObject(candidate) && !Array.isArray(candidate)) continue;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) pending.push(item);
      continue;
    }
    for (const field of [
      "name",
      "message",
      "error",
      "cause",
      "content",
      "contentItems",
      "structuredContent",
    ]) {
      if (field in candidate) pending.push(candidate[field]);
    }
    if (typeof candidate.text === "string") pending.push(candidate.text);
  }
  return messages;
}

const nonRecoverableBrowserFailure =
  /\b(?:permission|forbidden|unauthori[sz]ed|approval|denied|declined|cancel(?:led)?|abort(?:ed)?|user\s+(?:stopped|interrupted)|auth(?:entication)?\s+broker)\b/iu;

const BROWSER_PRE_DISPATCH_FAILURE_PREFIX = "BROWSER_PRE_DISPATCH_FAILED: ";

const browserDisconnectPatterns = [
  /\b(?:selected\s+)?browser(?:\s+(?:connection|data\s+session|session|service|plugin|runtime|backend(?:\s+pipe)?))?\s+(?:(?:is|was|has\s+been|became)\s+)?(?:disconnected|closed|terminated|ended|lost|reset)\b/iu,
  /\b(?:connection|data\s+session|session)\s+(?:to|for|with|from)\s+(?:the\s+)?(?:selected\s+)?browser\s+(?:(?:is|was|has\s+been)\s+)?(?:disconnected|closed|terminated|ended|lost|reset)\b/iu,
  /\b(?:chrome|edge|extension|in-app\s+browser|iab)(?:\s+browser)?(?:\s+(?:connection|data\s+session|session|service|plugin|runtime|backend))?\s+(?:(?:is|was|has\s+been|became)\s+)?(?:disconnected|closed|terminated|ended|lost|reset)\b/iu,
  /\b(?:browser\s+)?data\s+session\s+(?:(?:is|was|has\s+been|became)\s+)?(?:disconnected|closed|terminated|ended|lost|reset)\b/iu,
];

function browserSurface(value: Record<string, unknown>): BrowserNativeSurface {
  switch (value.surface) {
    case "chrome":
    case "iab":
    case "edge":
    case "extension":
    case "default":
      return value.surface;
    default:
      throw new Error("Browser surface must be chrome, iab, edge, extension, or default");
  }
}

export function classifyBrowserNativeOperation(
  value: unknown,
  legacyCode?: unknown,
): BrowserNativeOperation {
  switch (value) {
    case "list_surfaces":
    case "documentation":
    case "inspect":
    case "list_tabs":
    case "list_user_tabs":
    case "exec":
      return value;
    case undefined:
      // Preserve already-connected Codex and Web clients whose cached schema
      // only exposes `code`. Only an exact standalone native read expression is
      // promoted; arbitrary JavaScript remains an unknown-outcome exec.
      return legacyBrowserReadOperation(legacyCode) ?? "exec";
    default:
      throw new Error(
        "Browser operation must be documentation, exec, inspect, list_tabs, list_user_tabs, or list_surfaces",
      );
  }
}

function legacyBrowserReadOperation(
  code: unknown,
): Extract<BrowserNativeOperation, "list_tabs" | "list_user_tabs"> | undefined {
  if (typeof code !== "string") return undefined;
  const standalone = code.trim();
  if (/^return\s+(?:await\s+)?browser\.tabs\.list\(\)\s*;?$/u.test(standalone)) {
    return "list_tabs";
  }
  if (/^return\s+(?:await\s+)?browser\.user\.openTabs\(\)\s*;?$/u.test(standalone)) {
    return "list_user_tabs";
  }
  return undefined;
}

function isReplaySafeBrowserOperation(
  operation: BrowserNativeContextRequest["operation"],
): boolean {
  return operation !== "exec";
}

function stableBrowserSelector(
  entry: Record<string, unknown> | undefined,
  surfaces?: readonly Record<string, unknown>[],
): string | undefined {
  return browserSelectorAliases(entry, surfaces)[0];
}

/**
 * Every stable identity one browser surface answers to, most specific first.
 * The primary form depends on how many surfaces of the family are visible (a
 * sole unnamed profile is keyed by family, two by extension instance), so a
 * key handed out while two profiles were open must still resolve after one of
 * them closes, and vice versa.  Callers match on any shared alias and still
 * require exactly one surface.
 */
function browserIdentityAliases(
  entry: Record<string, unknown> | undefined,
  surfaces?: readonly Record<string, unknown>[],
): string[] {
  if (entry === undefined) return [];
  const { metadata, profileName, family } = browserSurfaceNaming(entry);
  const aliases: string[] = [];
  if (entry.type === "extension" && profileName !== undefined)
    aliases.push(JSON.stringify([entry.type, "profile", family ?? "browser", profileName]));
  // Some installed browser-service builds omit profileName even though the
  // desktop inventory knows it.  A sole extension surface of one browser
  // family still has a stable logical identity: its family selector resolves
  // to the current native connection after every reconnect.  Do not use this
  // fallback when two unnamed profiles of the same family are present.
  if (family !== undefined && isSoleExtensionOfFamily(entry, family, surfaces))
    aliases.push(JSON.stringify([entry.type, "family", family]));
  if (typeof metadata.extensionInstanceId === "string" && metadata.extensionInstanceId.length > 0)
    aliases.push(JSON.stringify([entry.type, "extension", metadata.extensionInstanceId]));
  if (typeof metadata.codexSessionId === "string" && metadata.codexSessionId.length > 0)
    aliases.push(JSON.stringify([entry.type, "session", metadata.codexSessionId]));
  return aliases;
}

interface BrowserKeyBinding {
  readonly aliases: readonly string[];
  /**
   * True only for the logical "sole profile of this family" key.  Such a key
   * may follow the family to a reconnected surface; an exact extension,
   * profile or session key must never fall back to another profile that
   * happens to be the only one left.
   */
  readonly familyKey: boolean;
}

function selectedChromeProfileName(
  binding: BrowserKeyBinding | undefined,
  browserId: string,
): string | undefined {
  const names = new Set<string>();
  for (const alias of binding?.aliases ?? []) {
    try {
      const parsed: unknown = JSON.parse(alias);
      if (
        Array.isArray(parsed) &&
        parsed[1] === "profile" &&
        parsed[2] === "chrome" &&
        typeof parsed[3] === "string"
      ) {
        names.add(parsed[3]);
      }
    } catch {
      // Other aliases are not profile identities.
    }
  }
  if (names.size === 1) return [...names][0];
  if (names.size > 1 || binding !== undefined) return undefined;
  const prefix = "profile:chrome:";
  if (!browserId.startsWith(prefix) || browserId === `${prefix}default`) return undefined;
  try {
    const name = decodeURIComponent(browserId.slice(prefix.length));
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

function browserKeyBinding(
  entry: Record<string, unknown>,
  surfaces: readonly Record<string, unknown>[],
  selector: string,
): BrowserKeyBinding {
  const family = browserSurfaceNaming(entry).family ?? "browser";
  const familySelector = isSoleExtensionOfFamily(entry, family, surfaces)
    ? `profile:${encodeURIComponent(family)}:default`
    : undefined;
  return {
    aliases: browserIdentityAliases(entry, surfaces),
    familyKey: selector === familySelector,
  };
}

function isFamilyIdentityAlias(alias: string): boolean {
  try {
    const parsed: unknown = JSON.parse(alias);
    return Array.isArray(parsed) && parsed[1] === "family";
  } catch {
    return false;
  }
}

/** Surfaces a remembered key still names: exact identities first, family only for family keys. */
function resolveBrowserKeyBinding(
  binding: BrowserKeyBinding,
  surfaces: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const matching = (aliases: readonly string[]) =>
    surfaces.filter((entry) =>
      browserIdentityAliases(entry, surfaces).some((alias) => aliases.includes(alias)),
    );
  const exact = matching(binding.aliases.filter((alias) => !isFamilyIdentityAlias(alias)));
  if (exact.length > 0 || !binding.familyKey) return exact;
  return matching(binding.aliases.filter(isFamilyIdentityAlias));
}

/** Every caller-facing key one browser surface answers to; the first is the one listed. */
function browserSelectorAliases(
  entry: Record<string, unknown> | undefined,
  surfaces?: readonly Record<string, unknown>[],
): string[] {
  if (entry === undefined) return [];
  const naming = browserSurfaceNaming(entry);
  const { metadata, profileName } = naming;
  const family = naming.family ?? "browser";
  const selectors: string[] = [];
  if (entry.type === "extension" && profileName !== undefined)
    selectors.push(`profile:${encodeURIComponent(family)}:${encodeURIComponent(profileName)}`);
  if (isSoleExtensionOfFamily(entry, family, surfaces))
    selectors.push(`profile:${encodeURIComponent(family)}:default`);
  if (typeof metadata.extensionInstanceId === "string" && metadata.extensionInstanceId.length > 0)
    selectors.push(`extension:${encodeURIComponent(metadata.extensionInstanceId)}`);
  if (typeof metadata.codexSessionId === "string" && metadata.codexSessionId.length > 0)
    selectors.push(`session:${encodeURIComponent(metadata.codexSessionId)}`);
  return selectors;
}

function browserSurfaceNaming(entry: Record<string, unknown>): {
  readonly metadata: Record<string, unknown>;
  readonly profileName: string | undefined;
  readonly family: string | undefined;
} {
  const metadata = isObject(entry.metadata) ? entry.metadata : {};
  const profileName =
    typeof entry.profileName === "string" && entry.profileName.length > 0
      ? entry.profileName
      : typeof metadata.profileName === "string" && metadata.profileName.length > 0
        ? metadata.profileName
        : undefined;
  const family =
    typeof entry.family === "string" && entry.family.length > 0
      ? entry.family.toLowerCase()
      : typeof entry.name === "string" && entry.name.length > 0
        ? entry.name.toLowerCase()
        : undefined;
  return { metadata, profileName, family };
}

function isSoleExtensionOfFamily(
  entry: Record<string, unknown>,
  family: string,
  surfaces: readonly Record<string, unknown>[] | undefined,
): boolean {
  return (
    entry.type === "extension" &&
    surfaces !== undefined &&
    surfaces.filter(
      (candidate) => candidate.type === "extension" && browserSurfaceFamily(candidate) === family,
    ).length === 1
  );
}

function isChromeExtensionSurface(entry: Record<string, unknown>): boolean {
  if (entry.type !== "extension") return false;
  if (typeof entry.family === "string") return entry.family.toLowerCase() === "chrome";
  return typeof entry.name === "string" && entry.name.toLowerCase().includes("chrome");
}

function browserSurfaceFamily(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.family === "string" && entry.family.length > 0)
    return entry.family.toLowerCase();
  if (typeof entry.name === "string" && entry.name.length > 0) return entry.name.toLowerCase();
  return undefined;
}

function presentedBrowserSurfaceResult(value: unknown): unknown {
  return mapBrowserSurfaceResult(value)[0];
}

function mapBrowserSurfaceResult(value: unknown): readonly [unknown, boolean] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      const [presented, changed] = mapBrowserSurfaceResult(parsed);
      return changed ? [JSON.stringify(presented), true] : [value, false];
    } catch {
      return [value, false];
    }
  }
  if (Array.isArray(value)) {
    if (
      value.every(
        (entry) =>
          isObject(entry) && typeof entry.id === "string" && typeof entry.type === "string",
      )
    ) {
      let changed = false;
      const presented = value.map((entry) => {
        const selector = stableBrowserSelector(entry, value);
        const metadata = isObject(entry.metadata) ? { ...entry.metadata } : undefined;
        if (entry.type === "extension" && metadata !== undefined) {
          delete metadata.extensionInstanceId;
        }
        const presentedMetadata =
          metadata === undefined || Object.keys(metadata).length > 0 ? metadata : undefined;
        const hidesEphemeralIdentity =
          isObject(entry.metadata) &&
          entry.type === "extension" &&
          typeof entry.metadata.extensionInstanceId === "string";
        if (selector === undefined || (selector === entry.id && !hidesEphemeralIdentity))
          return entry;
        changed = true;
        const result = { ...entry, id: selector };
        if (presentedMetadata === undefined) delete result.metadata;
        else result.metadata = presentedMetadata;
        return result;
      });
      return [presented, changed];
    }
    let changed = false;
    const presented = value.map((entry) => {
      const [mapped, entryChanged] = mapBrowserSurfaceResult(entry);
      changed ||= entryChanged;
      return mapped;
    });
    return changed ? [presented, true] : [value, false];
  }
  if (!isObject(value)) return [value, false];
  let changed = false;
  const presented: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const [mapped, entryChanged] = mapBrowserSurfaceResult(entry);
    changed ||= entryChanged;
    presented[key] = mapped;
  }
  return changed ? [presented, true] : [value, false];
}

function browserSurfaceReadback(value: unknown): Record<string, unknown>[] | undefined {
  if (typeof value === "string") {
    try {
      return browserSurfaceReadback(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    if (
      value.every(
        (entry) =>
          isObject(entry) && typeof entry.id === "string" && typeof entry.type === "string",
      )
    )
      return value;
    for (const entry of value) {
      const found = browserSurfaceReadback(entry);
      if (found !== undefined) return found;
    }
  } else if (isObject(value)) {
    for (const key of ["content", "contentItems", "text", "result", "output"]) {
      if (value[key] === undefined) continue;
      const found = browserSurfaceReadback(value[key]);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function browserExecutionCode(
  surface: BrowserNativeSurface,
  operation: Exclude<BrowserNativeContextRequest["operation"], "list_surfaces">,
  value: Record<string, unknown>,
): string {
  const documentationName =
    operation === "documentation" ? browserDocumentationName(value.documentation_name) : undefined;
  const inspectionTarget =
    operation === "inspect" ? browserInspectionTarget(value.target_tab_id) : undefined;
  const browserId = value.browserId;
  if (browserId !== undefined && (typeof browserId !== "string" || browserId.length === 0)) {
    throw new TypeError("browserId must be a non-empty native browser id");
  }
  const select =
    browserId !== undefined
      ? `await __omniAgent.browsers.get(${JSON.stringify(browserId)})`
      : surface === "chrome"
        ? [
            "await (async () => {",
            "  const profiles = (await __omniAgent.browsers.list()).filter((entry) =>",
            '    entry.type === "extension" &&',
            '    (entry.family?.toLowerCase() === "chrome" ||',
            '      (entry.family == null && entry.name?.toLowerCase().includes("chrome"))));',
            "  if (profiles.length === 0) {",
            '    throw new Error("CHROME_SURFACE_UNAVAILABLE: no Chrome profile is connected");',
            "  }",
            "  const preferred = await __omniAgent.browsers.getDefault();",
            "  if (profiles.some((entry) => entry.id === preferred.browserId)) return preferred;",
            "  if (profiles.length !== 1) {",
            '    throw new Error("CHROME_PROFILE_UNAVAILABLE_OR_AMBIGUOUS: list browser surfaces and select a Chrome profile");',
            "  }",
            "  return __omniAgent.browsers.get(profiles[0].id);",
            "})()",
          ].join("\n")
        : surface === "default"
          ? "await __omniAgent.browsers.getDefault()"
          : `await __omniAgent.browsers.get(${JSON.stringify(surface)})`;
  const body =
    operation === "list_tabs"
      ? "return await browser.tabs.list();"
      : operation === "list_user_tabs"
        ? [
            `const __omniAttachedIds = new Set((await browser.tabs.list()).map((tab) => String(tab.id)));`,
            `const __omniUserTabs = await browser.user.openTabs();`,
            `return __omniUserTabs.map((tab) => ({ ...tab, attachedToThisSession: __omniAttachedIds.has(String(tab.id)) }));`,
          ].join("\n")
        : operation === "documentation"
          ? documentationName === undefined
            ? "return await browser.documentation();"
            : `return await __omniAgent.documentation.get(${JSON.stringify(documentationName)});`
          : operation === "inspect"
            ? [
                `const __omniTargetTabId = ${JSON.stringify(inspectionTarget)};`,
                `const __omniAttachedTab = (await browser.tabs.list()).find((tab) => String(tab.id) === __omniTargetTabId);`,
                `const __omniTab = __omniAttachedTab === undefined`,
                `  ? await browser.user.claimTab(__omniTargetTabId)`,
                `  : await browser.tabs.get(__omniTargetTabId);`,
                `return await __omniTab.ax.get("state", { disableDiffing: true });`,
              ].join("\n")
            : (value.code as string);
  return [
    `await (async () => {`,
    // Native get_browser resolves a public selector to the current connection's
    // browserInfo.id. Browser objects capture that resolved id, so retaining one
    // across extension reconnects or runtime changes can target another profile.
    // Keep the agent/session, but resolve the exact selector on every operation.
    `  __omniRuntime.browserBindings = undefined;`,
    `  let __omniBrowser;`,
    `    try {`,
    `      __omniBrowser = ${select};`,
    `    } catch (error) {`,
    ...(browserId === undefined ? [] : ["      throw error;"]),
    `      const __omniSelectionMessage = error instanceof Error ? error.message : String(error);`,
    `      throw new Error(${JSON.stringify(BROWSER_PRE_DISPATCH_FAILURE_PREFIX)} + __omniSelectionMessage);`,
    `    }`,
    `  __omniRuntime.executionState ??= Object.create(null);`,
    ...(operation === "exec" ? browserHandleGuardCode() : []),
    `  let __omniBrowserResult = await (async (browser, state) => {`,
    body,
    `  })(__omniBrowser, __omniRuntime.executionState);`,
    // Object inspection truncates long strings. Serialize only plain JSON data;
    // media, binary, accessor-backed and other native values retain their renderer.
    `  const __omniJsonAncestors = new Set();`,
    `  const __omniIsJson = (value) => {`,
    `    if (value === null || typeof value === "string" || typeof value === "boolean") return true;`,
    `    if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);`,
    `    if (typeof value !== "object" || __omniJsonAncestors.has(value)) return false;`,
    `    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;`,
    `    const descriptors = Object.getOwnPropertyDescriptors(value);`,
    `    if (["image", "audio", "resource", "resource_link"].includes(descriptors.type?.value)) return false;`,
    `    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !("value" in descriptors[key]))) return false;`,
    `    if (Object.entries(descriptors).some(([key, descriptor]) => !descriptor.enumerable && !(Array.isArray(value) && key === "length"))) return false;`,
    `    if (Array.isArray(value) && (Object.keys(descriptors).length !== value.length + 1 || Object.keys(value).some((key, index) => key !== String(index)))) return false;`,
    `    __omniJsonAncestors.add(value);`,
    `    const valid = Object.values(descriptors).every((descriptor) => __omniIsJson(descriptor.value));`,
    `    __omniJsonAncestors.delete(value);`,
    `    return valid;`,
    `  };`,
    `  if (typeof __omniBrowserResult === "object" && __omniBrowserResult !== null && __omniIsJson(__omniBrowserResult)) {`,
    `    nodeRepl.write(JSON.stringify(__omniBrowserResult));`,
    `  } else {`,
    `    nodeRepl.write(__omniBrowserResult);`,
    `  }`,
    `})();`,
  ].join("\n");
}

/** Preserve saved native handles, but never send their captured ids after reconnect. */
function browserHandleGuardCode(): string[] {
  return [
    `  const __omniInventory = await __omniAgent.browsers.list();`,
    `  __omniRuntime.handleConnections = new Map(__omniInventory.map((entry) => [entry.id, JSON.stringify([entry.type, entry.family ?? entry.name, entry.profileName ?? entry.metadata?.profileName, entry.metadata?.extensionInstanceId, entry.metadata?.codexSessionId])]));`,
    `  __omniRuntime.handleAgent = __omniAgent;`,
    `  __omniRuntime.handleOriginals ??= new WeakMap();`,
    `  const __omniHandleBrowserId = __omniBrowser.browserId;`,
    `  const __omniHandleConnection = __omniRuntime.handleConnections.get(__omniHandleBrowserId);`,
    `  if (__omniHandleConnection === undefined) throw new Error("BROWSER_HANDLE_STALE: selected browser connection is absent; list browser surfaces again");`,
    `  const __omniHandleGeneration = __omniRuntime.handleGeneration ?? 0;`,
    `  const __omniHandleViews = new WeakMap();`,
    `  const __omniCheckHandle = () => {`,
    `    if (__omniRuntime.handleAgent !== __omniAgent || (__omniRuntime.handleGeneration ?? 0) !== __omniHandleGeneration || __omniRuntime.handleConnections.get(__omniHandleBrowserId) !== __omniHandleConnection) {`,
    `      throw new Error("BROWSER_HANDLE_STALE: saved browser handle belongs to a previous connection; reacquire the same tab or locator from the current browser");`,
    `    }`,
    `  };`,
    `  const __omniUnwrapHandle = (value) => {`,
    `    if (value === null || typeof value !== "object") return value;`,
    `    const saved = __omniRuntime.handleOriginals.get(value);`,
    `    if (saved !== undefined) { saved.check(); return saved.original; }`,
    `    if (Array.isArray(value)) return value.map(__omniUnwrapHandle);`,
    `    if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, __omniUnwrapHandle(item)]));`,
    `    return value;`,
    `  };`,
    // Mirror the SDK's method receiver handling: its classes and locators use
    // private fields. Plain results and binary/media outputs retain identity.
    `  const __omniWrapHandle = (value, force = false) => {`,
    `    if (value === null || typeof value !== "object") return value;`,
    `    if (value instanceof Promise) return value.then(__omniWrapHandle);`,
    `    if (Array.isArray(value)) {`,
    `      const mapped = value.map((item) => __omniWrapHandle(item));`,
    `      return mapped.some((item, index) => item !== value[index]) ? mapped : value;`,
    `    }`,
    `    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date || value instanceof RegExp) return value;`,
    `    const prototype = Object.getPrototypeOf(value);`,
    `    if (!force && (prototype === Object.prototype || prototype === null) && !Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => typeof descriptor.value === "function")) return value;`,
    `    const cached = __omniHandleViews.get(value);`,
    `    if (cached !== undefined) return cached;`,
    `    const methods = new Map();`,
    // A facade also supports the SDK's frozen WebMCP method records without
    // violating Proxy invariants for non-configurable function properties.
    `    const view = new Proxy(Object.create(prototype), {`,
    `      get(_target, key) {`,
    `        const member = Reflect.get(value, key, value);`,
    `        if (key === "constructor") return member;`,
    // Management namespaces are dynamic Proxy({}) objects with no own keys.
    `        if (typeof member !== "function") return __omniWrapHandle(member, member !== null && typeof member === "object" && Reflect.ownKeys(member).length === 0);`,
    `        if (!methods.has(key)) methods.set(key, (...args) => {`,
    `          __omniCheckHandle();`,
    `          return __omniWrapHandle(Reflect.apply(member, value, args.map(__omniUnwrapHandle)));`,
    `        });`,
    `        return methods.get(key);`,
    `      },`,
    `      set(_target, key, member) { return Reflect.set(value, key, member, value); },`,
    `      has(_target, key) { return Reflect.has(value, key); },`,
    `      ownKeys() { return Reflect.ownKeys(value); },`,
    `      getOwnPropertyDescriptor(_target, key) {`,
    `        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);`,
    `        return descriptor === undefined ? undefined : { ...descriptor, configurable: true, ...("value" in descriptor ? { value: Reflect.get(view, key) } : {}) };`,
    `      },`,
    `    });`,
    `    __omniHandleViews.set(value, view);`,
    `    __omniRuntime.handleOriginals.set(view, { original: value, check: __omniCheckHandle });`,
    `    return view;`,
    `  };`,
    `  __omniBrowser = __omniWrapHandle(__omniBrowser, true);`,
  ];
}

function browserInspectionTarget(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\0\r\n]/u.test(value)) {
    throw new TypeError("target_tab_id must be a non-empty native tab id");
  }
  return value.trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
