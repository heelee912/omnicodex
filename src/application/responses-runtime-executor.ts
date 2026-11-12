import { randomUUID } from "node:crypto";
import type { CodexModelMetadataSnapshot } from "../infrastructure/runtime/codex-model-metadata-source.js";
import type { JsonObject } from "../infrastructure/runtime/jsonl-rpc-client.js";
import {
  type ResponsesCorrelatedToolOutput,
  ResponsesLoopbackDriver,
  type ResponsesNativeToolSpec,
  type ResponsesNestedToolMetadata,
  type ResponsesSelectedToolCall,
  type ResponsesToolExecutionResult,
  type ResponsesToolExecutionStatus,
} from "../infrastructure/runtime/responses-loopback-driver.js";
import { canonicalJson } from "../infrastructure/safety/canonical-json.js";
import {
  CODE_MODE_DISPATCH_NAME,
  CODE_MODE_DISPATCH_SPEC,
  CodeModeParallelDispatch,
  type DynamicDispatchResponse,
  withParallelDynamicTools,
} from "./code-mode-parallel-dispatch.js";
import { withCodeModeWebPlatformGlobals } from "./code-mode-web-platform-globals.js";
import type { AppServerRpcClient } from "./native-tool-catalog.js";
import { toolsForCatalogConvergence } from "./native-tool-convergence.js";
import { inputSchemaFromToolDescription } from "./typescript-tool-schema.js";

export const OMNICODEX_LOOPBACK_PROVIDER_ID = "omnicodex_loopback";

interface CodexAppServerProcessHandle {
  readonly client: AppServerRpcClient;
  stop(): Promise<void>;
}

export interface ResponsesRuntimeExecutorOptions {
  readonly modelMetadataSnapshot: CodexModelMetadataSnapshot;
  readonly cwd?: string;
  readonly dynamicTools?: () => readonly Record<string, unknown>[];
  readonly nestedToolExclusions?: () => readonly string[];
  readonly model?: string;
  readonly providerId?: string;
  /** Bind the provider to this execution thread when sharing an App Server. */
  readonly threadScopedProvider?: boolean;
  readonly turnTimeoutMs?: number;
  /** Bounded grace for an interrupted turn before its exact owned App Server is stopped. */
  readonly terminalGraceMs?: number;
  readonly onDiagnostic?: (message: JsonObject) => void;
  /** Runs after the exact App Server turn settles so native turn-owned resources can be reclaimed. */
  readonly onTurnSettled?: (turnId: string) => Promise<void> | void;
  /** Optional protocol-test status source; production reads the native terminal envelope. */
  readonly codeCellLifecycle?: ResponsesCodeCellLifecycleSource;
}

const DEFAULT_TERMINAL_GRACE_MS = 5_000;

export interface ResponsesCodeCellLifecycleSource {
  readToolExecutionStatus?(
    callId: string,
    signal?: AbortSignal,
    terminalTurnId?: string,
  ): Promise<ResponsesToolExecutionStatus>;
  readExecutionStatus(
    callId: string,
    signal?: AbortSignal,
    terminalTurnId?: string,
  ): Promise<ResponsesToolExecutionStatus>;
}

export class ResponsesCodeCellLifecycleError extends Error {
  override readonly name = "ResponsesCodeCellLifecycleError";
}

export class ResponsesNestedCatalogIncompatibilityError extends Error {
  override readonly name = "ResponsesNestedCatalogIncompatibilityError";
  readonly code = "OMNICODEX_RESPONSES_NESTED_CATALOG_INCOMPATIBLE";
  readonly data: Readonly<Record<string, unknown>>;

  constructor(message: string, data: Readonly<Record<string, unknown>>) {
    super(message);
    this.data = data;
  }
}

export interface ResponsesRuntimeExecutorBinding {
  readonly env: NodeJS.ProcessEnv;
  readonly configOverrides: readonly string[];
  onNotification(message: JsonObject): void;
}

interface TurnWaiter {
  resolve(value: JsonObject): void;
  reject(error: Error): void;
}

/**
 * Adds a loopback Responses provider to the Primary App Server and uses a
 * provider-bound ephemeral thread only as the native tool execution protocol.
 * The provider never calls or emulates a model, and no secondary App Server is
 * spawned for this route.
 */
export class ResponsesRuntimeExecutor {
  readonly #options: Required<
    Pick<ResponsesRuntimeExecutorOptions, "model" | "providerId" | "terminalGraceMs">
  > &
    ResponsesRuntimeExecutorOptions;
  readonly #driver: ResponsesLoopbackDriver;
  readonly #codeCellLifecycle: ResponsesCodeCellLifecycleSource | undefined;
  readonly #turnWaiters = new Map<string, TurnWaiter>();
  readonly #completedTurns = new Map<string, JsonObject>();
  readonly #failedNativeTurns = new Set<string>();
  readonly #executionSignalsByThread = new Map<string, AbortSignal>();
  readonly #execCallByCell = new Map<string, string>();
  readonly #parallelDispatch = new CodeModeParallelDispatch();
  readonly #dispatchGroupByCell = new Map<string, string>();
  #retainedTurn: { threadId: string; turnId: string; completion: Promise<JsonObject> } | undefined;
  #nestedTools: readonly ResponsesNestedToolMetadata[] = [];
  #executionThreadId: string | undefined;
  #executionDynamicToolsSignature: string | undefined;
  #completedExecutionThread = false;
  #process: CodexAppServerProcessHandle | undefined;
  #processFailure: Error | undefined;
  #binding: ResponsesRuntimeExecutorBinding | undefined;
  #preparePromise: Promise<ResponsesRuntimeExecutorBinding> | undefined;
  #startPromise: Promise<void> | undefined;
  #serialTail: Promise<void> = Promise.resolve();

  constructor(options: ResponsesRuntimeExecutorOptions) {
    const metadataModel = options.modelMetadataSnapshot.rawModel.slug;
    if (typeof metadataModel !== "string" || metadataModel.length === 0) {
      throw new Error("Codex model metadata descriptor is missing its slug");
    }
    const requestedModel = nonBlankOverride(options.model);
    if (requestedModel !== undefined && requestedModel !== metadataModel) {
      throw new Error(
        `Responses model ${requestedModel} does not match installed metadata ${metadataModel}`,
      );
    }
    const providerId = nonBlankOverride(options.providerId) ?? OMNICODEX_LOOPBACK_PROVIDER_ID;
    this.#options = {
      ...options,
      model: metadataModel,
      providerId,
      terminalGraceMs: optionalNonNegativeInteger(
        options.terminalGraceMs ?? DEFAULT_TERMINAL_GRACE_MS,
        "Responses terminalGraceMs",
      ) as number,
      ...(options.turnTimeoutMs === undefined
        ? {}
        : {
            turnTimeoutMs: optionalNonNegativeInteger(
              options.turnTimeoutMs,
              "Responses turnTimeoutMs",
            ) as number,
          }),
    };
    this.#driver = new ResponsesLoopbackDriver({
      modelMetadata: options.modelMetadataSnapshot,
    });
    this.#codeCellLifecycle = options.codeCellLifecycle;
  }

  get snapshot() {
    const snapshot = this.#driver.snapshot;
    return {
      ...snapshot,
      tools: snapshot.tools.filter((tool) => tool.name !== CODE_MODE_DISPATCH_NAME),
      nestedTools: this.#nestedTools.map((tool) => ({ ...tool })),
    };
  }

  get running(): boolean {
    return this.#process !== undefined;
  }

  isExecutionThread(threadId: unknown): boolean {
    return typeof threadId === "string" && threadId === this.#executionThreadId;
  }

  executionSignal(threadId: unknown): AbortSignal | undefined {
    return typeof threadId === "string" ? this.#executionSignalsByThread.get(threadId) : undefined;
  }

  async dispatchDynamic(
    params: Record<string, unknown>,
    invoke: (
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<DynamicDispatchResponse>,
  ): Promise<DynamicDispatchResponse> {
    const signal = this.executionSignal(params.threadId);
    if (params.tool !== CODE_MODE_DISPATCH_NAME) return invoke(params, signal);
    if (!this.isExecutionThread(params.threadId)) {
      throw new Error("Internal native dispatch requires the current execution thread");
    }
    return this.#parallelDispatch.call(params, this.#dynamicNames(), invoke, signal);
  }

  #dynamicNames(): string[] {
    return (this.#options.dynamicTools?.() ?? []).flatMap((tool) =>
      tool.type === "function" && typeof tool.name === "string" ? [tool.name] : [],
    );
  }

  async prepare(): Promise<ResponsesRuntimeExecutorBinding> {
    if (this.#binding !== undefined) {
      return this.#binding;
    }
    this.#preparePromise ??= this.#prepareBinding().finally(() => {
      this.#preparePromise = undefined;
    });
    return this.#preparePromise;
  }

  async start(process: CodexAppServerProcessHandle, signal?: AbortSignal): Promise<void> {
    if (this.#process !== undefined) {
      if (this.#process !== process) {
        throw new Error("Responses runtime executor is already attached to another App Server");
      }
      return this.#startPromise;
    }
    if (this.#binding === undefined) {
      throw new Error("Responses runtime executor must be prepared before the App Server starts");
    }
    this.#processFailure = undefined;
    this.#process = process;
    const startPromise = (async () => {
      try {
        throwIfAborted(signal);
        await this.#waitForMcpCatalogStability(signal);
        await this.#refreshCatalog(signal);
        if (this.#processFailure !== undefined) throw this.#processFailure;
        throwIfAborted(signal);
      } catch (error) {
        // The first turn can fail after thread/start has already installed
        // plugin processes. Retire that exact ephemeral thread before clearing
        // its id so a failed startup cannot leak another plugin generation.
        if (this.#options.threadScopedProvider && this.#executionThreadId !== undefined) {
          try {
            await process.client.request(
              "thread/unsubscribe",
              { threadId: this.#executionThreadId },
              { timeoutMs: 3_000 },
            );
          } catch (cleanupError) {
            // Keep the process and exact thread id so stop() can retry cleanup.
            throw new AggregateError(
              [toError(error), toError(cleanupError)],
              "Responses runtime startup and thread cleanup failed",
            );
          }
        }
        if (this.#process === process) this.#process = undefined;
        this.#resetExecutionState(toError(error));
        await this.#driver.stop().catch(() => undefined);
        this.#binding = undefined;
        throw error;
      }
    })();
    this.#startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.#startPromise === startPromise) this.#startPromise = undefined;
    }
  }

  async stop(): Promise<void> {
    const process = this.#process;
    const threadId = this.#executionThreadId;
    if (this.#options.threadScopedProvider && process !== undefined && threadId !== undefined) {
      await process.client.request("thread/unsubscribe", { threadId }, { timeoutMs: 3_000 });
    }
    this.#process = undefined;
    const error = new Error("Responses runtime executor stopped");
    this.#resetExecutionState(error);
    await this.#driver.stop().catch(() => undefined);
    this.#binding = undefined;
  }

  /** Settle calls whose turn/start RPC completed before their child exited. */
  async handleProcessExit(cause: Error): Promise<void> {
    const error = new Error(`Responses App Server exited: ${cause.message}`, { cause });
    this.#processFailure = error;
    this.#process = undefined;
    const retainedTurnId = this.#retainedTurn?.turnId;
    this.#resetExecutionState(error);
    this.#binding = undefined;
    await this.#driver.stopAfterTransportFailure(error);
    // In-flight turns settle in #runTurn's finally. A yielded turn no longer
    // has a waiting call, so its browser activity needs explicit settlement.
    if (retainedTurnId !== undefined) await this.#settleTurnActivity(retainedTurnId);
  }

  async refreshCatalog(signal?: AbortSignal): Promise<void> {
    await this.#enqueue(() => this.#refreshCatalog(signal), signal);
  }

  /** Rebind provider state after the owned App Server transport is replaced in place. */
  async recoverAfterProcessRestart(signal?: AbortSignal): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#process === undefined) {
        throw new Error("Responses runtime executor is not running");
      }
      this.#resetExecutionState(new Error("Responses App Server generation was replaced"));
      await this.#waitForMcpCatalogStability(signal);
      await this.#refreshCatalog(signal);
    }, signal);
  }

  async #refreshCatalog(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.#retainedTurn !== undefined) {
      // Every native Responses request captures its current tool definitions,
      // including the request retained after yield. Read that live contract
      // without clearing it or ending the turn that owns the pending cells.
      await this.#discoverNestedTools(signal);
      return;
    }
    this.#driver.resetCatalog();
    await this.#runTurn(undefined, undefined, signal);
    throwIfAborted(signal);
    const process = this.#process;
    const catalogThreadId = this.#executionThreadId;
    if (
      this.#options.threadScopedProvider &&
      process !== undefined &&
      catalogThreadId !== undefined
    ) {
      // Codex 0.167 can replay the catalog turn as the first Responses request
      // of a subsequent selected-tool turn. Do not reuse that catalog thread.
      await process.client.request(
        "thread/unsubscribe",
        { threadId: catalogThreadId },
        { timeoutMs: 3_000 },
      );
      if (this.#executionThreadId === catalogThreadId) {
        this.#executionThreadId = undefined;
        this.#executionDynamicToolsSignature = undefined;
        this.#completedExecutionThread = false;
      }
    }
    await this.#discoverNestedTools(signal);
  }

  async call(
    selection: ResponsesSelectedToolCall,
    signal?: AbortSignal,
  ): Promise<ResponsesToolExecutionResult> {
    return this.#enqueue(async () => {
      const native =
        selection.namespace === undefined
          ? this.#nestedTools.find((tool) => tool.name === selection.name)
          : undefined;
      const directSelection =
        native?.nativeNamespace === undefined
          ? selection
          : {
              ...selection,
              namespace: native.nativeNamespace,
              name: native.nativeName ?? selection.name,
            };
      const result = await this.#runTurn(
        normalizeNeverFullAccessSelection(directSelection),
        undefined,
        signal,
      );
      if (result === undefined) {
        throw new Error("Responses runtime did not return a native tool result");
      }
      if (this.#options.threadScopedProvider && result.turnRetained !== true) {
        // Deliver the settled result before retiring its thread. The next
        // independent call must not inherit a completed turn's history.
        this.#completedExecutionThread = true;
      }
      return result;
    }, signal);
  }

  async callNested(
    name: string,
    argumentsValue: unknown,
    freeform: boolean,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const nativeArguments =
      freeform && isObject(argumentsValue) && typeof argumentsValue.input === "string"
        ? argumentsValue.input
        : argumentsValue;
    const result = await this.call(
      { kind: freeform ? "freeform" : "function", name, arguments: nativeArguments },
      signal,
    );
    return result.output;
  }

  async callMcp(
    server: string,
    tool: string,
    argumentsValue: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const nestedName = `mcp__${nestedToolSegment(server)}__${nestedToolSegment(tool)}`;
    return this.callNested(nestedName, argumentsValue, false, signal);
  }

  async #runTurn(
    selection?: ResponsesSelectedToolCall,
    inputOverride?: readonly JsonObject[],
    signal?: AbortSignal,
    pinnedThreadId?: string,
    awaitYieldedExec = false,
  ): Promise<ResponsesToolExecutionResult | undefined> {
    const process = this.#process;
    if (process === undefined) {
      throw new Error("Responses runtime executor is not running");
    }
    throwIfAborted(signal);
    const retainedTurn = this.#retainedTurn;
    const threadId =
      retainedTurn?.threadId ??
      pinnedThreadId ??
      (await this.#ensureExecutionThread(process, signal));
    if (retainedTurn !== undefined && selection === undefined) {
      throw new Error("Native code cells are still active; catalog refresh cannot end their turn");
    }
    if (signal !== undefined) this.#executionSignalsByThread.set(threadId, signal);
    const dynamicNames = this.#dynamicNames();
    const dispatchGroup =
      selection !== undefined && isFunctionsExecSelection(selection) && dynamicNames.length > 0
        ? randomUUID()
        : undefined;
    if (
      selection?.namespace === "functions" &&
      selection.name === "wait" &&
      isObject(selection.arguments) &&
      selection.arguments.terminate === true &&
      typeof selection.arguments.cell_id === "string"
    ) {
      const group = this.#dispatchGroupByCell.get(selection.arguments.cell_id);
      if (group !== undefined)
        this.#parallelDispatch.cancelGroup(group, new Error("Native code cell terminated"));
    }
    const effectiveSelection = withCodeModeGlobals(
      selection !== undefined &&
        isFunctionsExecSelection(selection) &&
        typeof selection.arguments === "string"
        ? {
            ...selection,
            arguments: withParallelDynamicTools(
              selection.arguments,
              dynamicNames,
              dispatchGroup ?? "",
              true,
            ),
          }
        : selection,
    );
    const prepared =
      effectiveSelection === undefined
        ? undefined
        : this.#driver.prepareToolCall(effectiveSelection, {
            awaitYieldedExec,
            preserveYieldedTurn: true,
          });
    let activeTurnId: string | undefined;
    let activitySettled = false;
    let deferActivityCleanup = false;
    try {
      const baseInput = inputOverride ?? [
        {
          type: "text",
          text_elements: [],
          text:
            selection === undefined
              ? "Capture the native tool catalog and complete."
              : "Execute the tool call already selected by the OmniCodex loopback driver.",
        },
      ];
      const input = [
        ...(prepared === undefined
          ? []
          : [
              {
                type: "text",
                text: prepared.executionNonce,
                text_elements: [],
              } satisfies JsonObject,
            ]),
        ...baseInput,
      ];
      let turnResponse: unknown;
      try {
        turnResponse =
          retainedTurn === undefined
            ? await process.client.request<unknown>(
                "turn/start",
                {
                  threadId,
                  input,
                  approvalPolicy: "never",
                  sandboxPolicy: { type: "dangerFullAccess" },
                  model: this.#options.model,
                },
                {
                  ...(this.#options.turnTimeoutMs === undefined
                    ? {}
                    : { timeoutMs: this.#options.turnTimeoutMs }),
                  ...(signal === undefined ? {} : { signal }),
                  awaitResponseAfterCancellation: true,
                },
              )
            : { turn: { id: retainedTurn.turnId } };
      } catch (error) {
        const lateResponse =
          typeof error === "object" && error !== null
            ? Reflect.get(error, "rpcResponse")
            : undefined;
        const lateTurnId = nestedString(lateResponse, "turn", "id");
        if (lateTurnId !== undefined) {
          activeTurnId = lateTurnId;
          await this.#interruptTurnAndAwaitTerminal(
            process,
            threadId,
            lateTurnId,
            this.#waitForTurn(lateTurnId),
            toError(error),
          );
        }
        throw error;
      }
      const turnId = nestedString(turnResponse, "turn", "id");
      if (turnId === undefined) {
        throw new Error("Codex App Server did not return an executor turn id");
      }
      activeTurnId = turnId;
      const turnCompletion = retainedTurn?.completion ?? this.#waitForTurn(turnId);
      const toolResult = await this.#awaitTurnOutcome(
        process,
        threadId,
        turnId,
        turnCompletion,
        prepared?.completion,
        signal,
      );
      if (toolResult === undefined) return undefined;
      if (effectiveSelection === undefined) {
        throw new Error("Responses executor selection was lost before status correlation");
      }
      this.#retainedTurn =
        toolResult.turnRetained === true
          ? { threadId, turnId, completion: turnCompletion }
          : undefined;
      deferActivityCleanup = toolResult.turnRetained === true;
      if (toolResult.yieldedCellId !== undefined) {
        // Returning a continuation handle is the successful terminal condition
        // of the native `functions.exec` call. The cell itself is intentionally
        // still running and is observed by a later explicit `functions.wait`.
        if (isFunctionsExecSelection(effectiveSelection)) {
          this.#execCallByCell.set(toolResult.yieldedCellId, toolResult.callId);
          if (dispatchGroup !== undefined)
            this.#dispatchGroupByCell.set(toolResult.yieldedCellId, dispatchGroup);
        }
        return { ...toolResult, executionStatus: "succeeded" };
      }
      if (!deferActivityCleanup) {
        await this.#settleTurnActivity(turnId);
        activitySettled = true;
      }
      let executionStatus: ResponsesToolExecutionStatus;
      try {
        executionStatus = await this.#executionStatus(
          effectiveSelection,
          toolResult.callId,
          toolResult.output,
          signal,
          turnId,
        );
      } catch (error) {
        if (!(error instanceof ResponsesCodeCellLifecycleError)) throw error;
        const failure = toolExecutionError(error.message, {
          ...toolResult,
          executionStatus: "failed",
        });
        Reflect.set(failure, "cause", error);
        throw failure;
      }
      return { ...toolResult, executionStatus };
    } catch (error) {
      this.#retainedTurn = undefined;
      this.#driver.cancelActiveToolCall(toError(error));
      throw error;
    } finally {
      if (activeTurnId !== undefined && !deferActivityCleanup)
        this.#failedNativeTurns.delete(activeTurnId);
      if (activeTurnId !== undefined && !activitySettled && !deferActivityCleanup) {
        await this.#settleTurnActivity(activeTurnId);
      }
      if (signal !== undefined && this.#executionSignalsByThread.get(threadId) === signal) {
        this.#executionSignalsByThread.delete(threadId);
      }
    }
  }

  async #settleTurnActivity(turnId: string): Promise<void> {
    this.#parallelDispatch.finishTurn(turnId);
    try {
      await this.#options.onTurnSettled?.(turnId);
    } catch (error) {
      this.#options.onDiagnostic?.({
        method: "omnicodex/turnResourceCleanupFailed",
        params: { turnId, error: toError(error).message },
      });
    }
  }

  async #awaitTurnOutcome(
    process: CodexAppServerProcessHandle,
    threadId: string,
    turnId: string,
    turnCompletion: Promise<JsonObject>,
    toolCompletion: Promise<ResponsesCorrelatedToolOutput> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ResponsesCorrelatedToolOutput | undefined> {
    let normalCompleted = false;
    let cancellation: Promise<never> | undefined;
    let rejectCancellation!: (reason: unknown) => void;
    const cancellationOutcome = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const startCancellation = (reason: Error): void => {
      if (normalCompleted || cancellation !== undefined) return;
      cancellation = this.#interruptTurnAndAwaitTerminal(
        process,
        threadId,
        turnId,
        turnCompletion,
        reason,
      );
      void cancellation.catch(rejectCancellation);
    };
    const onAbort = () => startCancellation(abortError(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer =
      this.#options.turnTimeoutMs === undefined
        ? undefined
        : setTimeout(
            () => startCancellation(new Error(`Responses executor turn timed out: ${turnId}`)),
            this.#options.turnTimeoutMs,
          );
    timer?.unref?.();

    const normalOperation = (async () => {
      if (toolCompletion === undefined) {
        await turnCompletion;
        if (cancellation !== undefined) return cancellation;
        return undefined;
      }
      const toolResult = await Promise.race([
        toolCompletion,
        turnCompletion.then(() => {
          throw new Error("Responses executor turn completed without the selected tool output");
        }),
      ]);
      if (toolResult.turnRetained === true) return toolResult;
      await turnCompletion;
      if (cancellation !== undefined) return cancellation;
      return toolResult;
    })().then(
      (value) => {
        normalCompleted = true;
        return value;
      },
      async (error: unknown) => {
        if (cancellation !== undefined) return cancellation;
        normalCompleted = true;
        throw error;
      },
    );

    if (signal?.aborted === true) onAbort();
    try {
      return await Promise.race([normalOperation, cancellationOutcome]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async #interruptTurnAndAwaitTerminal(
    process: CodexAppServerProcessHandle,
    threadId: string,
    turnId: string,
    turnCompletion: Promise<JsonObject>,
    reason: Error,
  ): Promise<never> {
    this.#driver.cancelActiveToolCall(reason);
    // `turn/interrupt` with both IDs is the cancellation contract advertised
    // by the installed App Server schema. Do not settle this operation merely
    // because the interrupt request was accepted: the terminal turn event (or
    // an owned App Server shutdown that rejects it) proves the work stopped.
    const interruptRequest = process.client
      .request("turn/interrupt", { threadId, turnId })
      .catch(() => undefined);
    const terminalGraceMs = this.#options.terminalGraceMs;
    if (!(await settlesWithin(turnCompletion, terminalGraceMs))) {
      let stopFailure: Error | undefined;
      try {
        // CodexAppServerProcess owns only the exact hidden child it spawned;
        // this never targets or attaches to the desktop Codex App Server.
        await process.stop();
      } catch (error) {
        stopFailure = toError(error);
      }
      if (this.#process === process) this.#process = undefined;
      this.#resetExecutionState(reason);
      await this.#driver.stop().catch(() => undefined);
      this.#binding = undefined;
      await Promise.allSettled([interruptRequest, turnCompletion]);
      if (stopFailure !== undefined) {
        throw new AggregateError(
          [reason, stopFailure],
          `Responses executor turn ${turnId} exceeded terminal grace and its owned App Server did not stop cleanly`,
        );
      }
      throw reason;
    }
    // The terminal event is authoritative. The interrupt acknowledgement may
    // arrive later on the same bounded RPC client, but it cannot keep this call
    // or recovery blocked once terminal state is observed.
    void interruptRequest;
    throw reason;
  }

  async #executionStatus(
    selection: ResponsesSelectedToolCall,
    callId: string,
    output: unknown,
    signal?: AbortSignal,
    terminalTurnId?: string,
  ): Promise<ResponsesToolExecutionStatus> {
    let lifecycleCallId = callId;
    let waitedCell: string | undefined;
    if (!isFunctionsExecSelection(selection)) {
      if (
        selection.namespace !== "functions" ||
        selection.name !== "wait" ||
        !isObject(selection.arguments)
      )
        return terminalTurnId !== undefined && this.#failedNativeTurns.has(terminalTurnId)
          ? "failed"
          : ((await this.#codeCellLifecycle?.readToolExecutionStatus?.(
              callId,
              signal,
              terminalTurnId,
            )) ?? nativeDirectToolExecutionStatus(selection.name, output));
      waitedCell =
        typeof selection.arguments.cell_id === "string" ? selection.arguments.cell_id : undefined;
      const origin = waitedCell === undefined ? undefined : this.#execCallByCell.get(waitedCell);
      if (origin === undefined)
        throw new ResponsesCodeCellLifecycleError(
          "Native wait result has no originating exec cell correlation",
        );
      lifecycleCallId = origin;
    }
    const status =
      this.#codeCellLifecycle === undefined
        ? nativeCodeCellExecutionStatus(output)
        : await this.#codeCellLifecycle.readExecutionStatus(
            lifecycleCallId,
            signal,
            terminalTurnId,
          );
    if (waitedCell !== undefined) {
      this.#execCallByCell.delete(waitedCell);
      this.#dispatchGroupByCell.delete(waitedCell);
    }
    return status;
  }

  async #discoverNestedTools(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const capturedCatalog = nestedToolsFromResponsesCatalog(this.#driver.snapshot.tools);
    this.#installNestedTools(capturedCatalog);
    throwIfAborted(signal);
  }

  #installNestedTools(value: readonly unknown[]): void {
    const nestedToolsByName = new Map<string, ResponsesNestedToolMetadata>();
    const sourceIndexesByName = new Map<string, number>();
    const excludedNames = new Set([
      CODE_MODE_DISPATCH_NAME,
      ...(this.#options.nestedToolExclusions?.() ?? []),
    ]);
    for (const [index, item] of value.entries()) {
      if (
        !isObject(item) ||
        typeof item.name !== "string" ||
        item.name.length === 0 ||
        typeof item.description !== "string"
      ) {
        throw new ResponsesNestedCatalogIncompatibilityError(
          `Codex ALL_TOOLS entry ${index} is not a callable tool descriptor`,
          { index, entry: item },
        );
      }
      if (excludedNames.has(item.name)) continue;
      const previousIndex = sourceIndexesByName.get(item.name);
      if (previousIndex !== undefined) {
        throw new ResponsesNestedCatalogIncompatibilityError(
          `Codex ALL_TOOLS contains duplicate tool name ${item.name}`,
          {
            index,
            previousIndex,
            toolName: item.name,
            entry: item,
          },
        );
      }
      const inputSchema = inputSchemaFromToolDescription(item.name, item.description);
      sourceIndexesByName.set(item.name, index);
      nestedToolsByName.set(item.name, {
        name: item.name,
        description: item.description,
        ...(typeof item.nativeNamespace === "string" && typeof item.nativeName === "string"
          ? { nativeNamespace: item.nativeNamespace, nativeName: item.nativeName }
          : {}),
        ...(inputSchema === undefined ? {} : { inputSchema }),
      });
    }
    const nestedTools = [...nestedToolsByName.values()];
    if (nestedTools.length === 0) {
      throw new Error("Codex ALL_TOOLS catalog was empty");
    }
    this.#nestedTools = nestedTools.sort((left, right) =>
      left.name.localeCompare(right.name, "en"),
    );
  }

  async #ensureExecutionThread(
    process: CodexAppServerProcessHandle,
    signal?: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
    const dynamicTools = [...structuredClone(this.#options.dynamicTools?.() ?? [])];
    if (this.#dynamicNames().length > 0) {
      dynamicTools.push(structuredClone(CODE_MODE_DISPATCH_SPEC));
    }
    const dynamicToolsSignature = canonicalJson(dynamicTools);
    if (
      this.#executionThreadId !== undefined &&
      this.#executionDynamicToolsSignature === dynamicToolsSignature &&
      !this.#completedExecutionThread
    ) {
      return this.#executionThreadId;
    }
    if (this.#executionThreadId !== undefined) {
      // A changed registry or a completed selected turn needs a fresh thread.
      // Retire the exact old subscription before any new tool dispatch; keep
      // its id on failure so a retry cannot orphan another generation.
      await process.client.request(
        "thread/unsubscribe",
        { threadId: this.#executionThreadId },
        { timeoutMs: 3_000 },
      );
      this.#executionThreadId = undefined;
      this.#executionDynamicToolsSignature = undefined;
      this.#completedExecutionThread = false;
      throwIfAborted(signal);
    }
    let threadResponse: unknown;
    try {
      threadResponse = await process.client.request<unknown>(
        "thread/start",
        {
          approvalPolicy: "never",
          baseInstructions:
            "Execute only the exact tool call selected by the OmniCodex loopback driver.",
          cwd: this.#options.cwd ?? null,
          developerInstructions: "No inference is performed in this thread.",
          config: {
            thread_unload_delay_secs: 0,
            ...(this.#options.threadScopedProvider
              ? {
                  // A thread-scoped provider must also be the current provider
                  // when the installed App Server starts its first turn.
                  model_provider: this.#options.providerId,
                  model_providers: {
                    [this.#options.providerId]: {
                      name: "OmniCodex Loopback",
                      base_url: this.#driver.baseUrl,
                      wire_api: "responses",
                      requires_openai_auth: true,
                      http_headers: { "X-OmniCodex-Loopback-Key": this.#driver.apiKey },
                      supports_standalone_web_search: true,
                      supports_websockets: false,
                    },
                  },
                  features: {
                    code_mode_host: true,
                    image_generation: true,
                    standalone_web_search: true,
                  },
                }
              : {}),
          },
          ...(dynamicTools.length === 0 ? {} : { dynamicTools }),
          ephemeral: true,
          experimentalRawEvents: true,
          model: this.#options.model,
          modelProvider: this.#options.providerId,
          sandbox: "danger-full-access",
          serviceName: "omnicodex",
        },
        {
          ...(signal === undefined ? {} : { signal }),
          awaitResponseAfterCancellation: true,
        },
      );
    } catch (error) {
      const lateResponse =
        typeof error === "object" && error !== null ? Reflect.get(error, "rpcResponse") : undefined;
      const lateThreadId = nestedString(lateResponse, "thread", "id");
      if (lateThreadId !== undefined) {
        // A dispatched thread/start may acknowledge after cancellation. Keep
        // that exact id for the caller's bounded unsubscribe/retry path.
        this.#executionThreadId = lateThreadId;
        this.#executionDynamicToolsSignature = dynamicToolsSignature;
      }
      throw error;
    }
    const threadId = nestedString(threadResponse, "thread", "id");
    if (threadId === undefined) {
      throw new Error("Codex App Server did not return an ephemeral executor thread id");
    }
    if (this.#process !== process) {
      throw new Error("Responses runtime executor stopped while creating its ephemeral thread");
    }
    throwIfAborted(signal);
    this.#executionThreadId = threadId;
    this.#executionDynamicToolsSignature = dynamicToolsSignature;
    return threadId;
  }

  async #prepareBinding(): Promise<ResponsesRuntimeExecutorBinding> {
    try {
      await this.#driver.start();
      const providerId = this.#options.providerId;
      const binding: ResponsesRuntimeExecutorBinding = {
        env: { OMNICODEX_LOOPBACK_API_KEY: this.#driver.apiKey },
        configOverrides: [
          'approval_policy="never"',
          'sandbox_mode="danger-full-access"',
          "features.code_mode_host=true",
          `model_providers.${providerId}.name=${tomlString("OmniCodex Loopback")}`,
          `model_providers.${providerId}.base_url=${tomlString(this.#driver.baseUrl)}`,
          `model_providers.${providerId}.wire_api=${tomlString("responses")}`,
          // The Responses body is still authenticated independently by the
          // loopback-only secret above.  Keep installed Codex account auth on
          // this provider so first-party native endpoints (standalone web
          // search and image generation) receive the same bearer/account
          // headers as they do in an ordinary Codex task.  The loopback relay
          // strips its private secret before forwarding those native calls.
          `model_providers.${providerId}.requires_openai_auth=true`,
          `model_providers.${providerId}.env_http_headers={ ${tomlString("X-OmniCodex-Loopback-Key")} = ${tomlString("OMNICODEX_LOOPBACK_API_KEY")} }`,
          `model_providers.${providerId}.supports_standalone_web_search=true`,
          `model_providers.${providerId}.supports_websockets=false`,
          "features.image_generation=true",
          "features.standalone_web_search=true",
        ],
        onNotification: (message) => this.#onNotification(message),
      };
      this.#binding = binding;
      return binding;
    } catch (error) {
      await this.#driver.stop().catch(() => undefined);
      throw error;
    }
  }

  #resetExecutionState(error: Error): void {
    this.#parallelDispatch.close(error);
    this.#dispatchGroupByCell.clear();
    this.#driver.cancelActiveToolCall(error);
    for (const [turnId, waiter] of this.#turnWaiters) {
      this.#turnWaiters.delete(turnId);
      waiter.reject(error);
    }
    this.#completedTurns.clear();
    this.#failedNativeTurns.clear();
    this.#executionSignalsByThread.clear();
    this.#execCallByCell.clear();
    this.#retainedTurn = undefined;
    this.#nestedTools = [];
    this.#executionThreadId = undefined;
    this.#executionDynamicToolsSignature = undefined;
    this.#completedExecutionThread = false;
  }

  async #waitForMcpCatalogStability(signal?: AbortSignal): Promise<void> {
    const process = this.#process;
    if (process === undefined) {
      throw new Error("Responses runtime executor is not running");
    }
    let previousSignature: string | undefined;
    let stableSamples = 0;
    for (;;) {
      throwIfAborted(signal);
      const signature = await this.#readMcpCatalogSignature(process, signal);
      if (previousSignature !== undefined && signature === previousSignature) {
        stableSamples += 1;
        if (stableSamples >= 2) {
          return;
        }
      } else {
        stableSamples = 0;
        previousSignature = signature;
      }
      await abortableDelay(250, signal);
    }
  }

  async #readMcpCatalogSignature(
    process: CodexAppServerProcessHandle,
    signal?: AbortSignal,
  ): Promise<string> {
    const statuses: Record<string, unknown>[] = [];
    const observedCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      throwIfAborted(signal);
      const response = await process.client.request<unknown>(
        "mcpServerStatus/list",
        {
          detail: "full",
          // This is a transport page size, not a total catalog limit. Every
          // returned cursor is exhausted below without an internal page cap.
          limit: 1_000,
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal === undefined ? undefined : { signal },
      );
      if (!isObject(response) || !Array.isArray(response.data)) {
        throw new Error("Responses MCP catalog returned an invalid status page");
      }
      for (const status of response.data) {
        if (!isObject(status)) {
          throw new Error("Responses MCP catalog returned an invalid server status");
        }
        statuses.push(status);
      }
      const nextCursor =
        typeof response.nextCursor === "string" && response.nextCursor.length > 0
          ? response.nextCursor
          : undefined;
      if (nextCursor === undefined) break;
      if (observedCursors.has(nextCursor)) {
        throw new Error("Responses MCP catalog repeated a pagination cursor");
      }
      observedCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return (
      statuses
        // Readiness follows the callable contract. Runtime health counters and
        // connection timestamps can change on every status read without changing
        // any tool that the Responses execution thread will receive.
        .map((status) =>
          canonicalJson({ name: status.name, tools: toolsForCatalogConvergence(status.tools) }),
        )
        .sort((left, right) => left.localeCompare(right, "en"))
        .join("\n")
    );
  }

  #waitForTurn(turnId: string): Promise<JsonObject> {
    const completed = this.#completedTurns.get(turnId);
    if (completed !== undefined) {
      this.#completedTurns.delete(turnId);
      const error = turnCompletionError(completed);
      return error === undefined ? Promise.resolve(completed) : Promise.reject(error);
    }
    return new Promise<JsonObject>((resolve, reject) => {
      this.#turnWaiters.set(turnId, { resolve, reject });
    });
  }

  #onNotification(message: JsonObject): void {
    this.#options.onDiagnostic?.(message);
    if (
      message.method === "item/completed" &&
      isObject(message.params) &&
      message.params.threadId === this.#executionThreadId &&
      typeof message.params.turnId === "string"
    ) {
      const item = message.params.item;
      if (
        isObject(item) &&
        (item.status === "failed" ||
          (item.type === "commandExecution" &&
            typeof item.exitCode === "number" &&
            item.exitCode !== 0))
      ) {
        this.#failedNativeTurns.add(message.params.turnId);
      }
    }
    if (message.method !== "turn/completed") {
      return;
    }
    const turnId = nestedString(message.params, "turn", "id");
    if (turnId === undefined) {
      return;
    }
    const waiter = this.#turnWaiters.get(turnId);
    if (waiter === undefined) {
      this.#completedTurns.set(turnId, message);
      return;
    }
    this.#turnWaiters.delete(turnId);
    const error = turnCompletionError(message);
    if (error === undefined) waiter.resolve(message);
    else waiter.reject(error);
  }

  #enqueue<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted === true) return Promise.reject(abortError(signal));
    let started = false;
    let onAbort: (() => void) | undefined;
    const guarded = () => {
      started = true;
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
      throwIfAborted(signal);
      if (this.#processFailure !== undefined) throw this.#processFailure;
      return operation();
    };
    const run = this.#serialTail.then(guarded, guarded);
    this.#serialTail = run.then(
      () => undefined,
      () => undefined,
    );
    if (signal === undefined) return run;
    // Only a queued caller may leave early. Once dispatched, retain the native
    // terminal wait and serialization even if the caller aborts.
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      onAbort = () => {
        if (started || settled) return;
        settled = true;
        reject(abortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      void run.then(
        (value) => {
          signal.removeEventListener("abort", onAbort as () => void);
          if (!settled) resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort as () => void);
          if (!settled) reject(error);
        },
      );
    });
  }
}

function nonBlankOverride(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function withCodeModeGlobals(
  selection: ResponsesSelectedToolCall | undefined,
): ResponsesSelectedToolCall | undefined {
  if (
    selection === undefined ||
    !isFunctionsExecSelection(selection) ||
    typeof selection.arguments !== "string"
  ) {
    return selection;
  }
  return {
    ...selection,
    arguments: withCodeModeWebPlatformGlobals(selection.arguments),
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function nestedString(value: unknown, objectKey: string, fieldKey: string): string | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const nested = value[objectKey];
  return isObject(nested) && typeof nested[fieldKey] === "string" ? nested[fieldKey] : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedToolsFromResponsesCatalog(
  tools: readonly ResponsesNativeToolSpec[],
): readonly ResponsesNestedToolMetadata[] {
  const functionNamespaces = tools.filter(
    (tool) => tool.type === "namespace" && tool.name === "functions",
  );

  const execTools: Record<string, unknown>[] = [];
  for (const namespace of functionNamespaces) {
    if (!Array.isArray(namespace.tools)) continue;
    for (const candidate of namespace.tools) {
      if (isObject(candidate) && candidate.type === "custom" && candidate.name === "exec") {
        execTools.push(candidate);
      }
    }
  }
  if (functionNamespaces.length !== 1 || execTools.length !== 1) {
    throw new ResponsesNestedCatalogIncompatibilityError(
      "Codex Responses catalog did not contain one unambiguous functions.exec descriptor",
      {
        functionNamespaceCount: functionNamespaces.length,
        functionsExecCount: execTools.length,
      },
    );
  }

  const description = execTools[0]?.description;
  if (typeof description !== "string" || description.length === 0) {
    throw new ResponsesNestedCatalogIncompatibilityError(
      "Codex Responses functions.exec descriptor omitted its nested tool catalog",
      { functionsExecDescriptionType: typeof description },
    );
  }
  return parseRenderedNestedToolCatalog(description);
}

function parseRenderedNestedToolCatalog(
  description: string,
): readonly ResponsesNestedToolMetadata[] {
  const headingPattern = /^### `([^`\r\n]+)`\r?\n/gmu;
  const headings = [...description.matchAll(headingPattern)];
  if (headings.length === 0) {
    throw new ResponsesNestedCatalogIncompatibilityError(
      "Codex Responses functions.exec description contained no nested tool entries",
      { descriptionChars: description.length },
    );
  }

  const tools: ResponsesNestedToolMetadata[] = [];
  for (const [index, heading] of headings.entries()) {
    const name = heading[1];
    const headingStart = heading.index;
    if (name === undefined || headingStart === undefined || name.length === 0) {
      throw new ResponsesNestedCatalogIncompatibilityError(
        `Codex Responses nested tool heading ${index} was malformed`,
        { index },
      );
    }
    const descriptionStart = headingStart + heading[0].length;
    let descriptionEnd = headings[index + 1]?.index ?? description.length;
    // Namespace introductions belong to the enclosing catalog, not the last
    // tool in the preceding namespace. Only look after its appended declaration
    // so headings in the tool's own prose and examples stay unchanged.
    const section = description.slice(descriptionStart, descriptionEnd);
    const declarationBlock =
      /^exec tool declaration:\r?\n```[^\r\n]*\r?\n[\s\S]*?^```[ \t]*(?:\r?\n|$)/mu.exec(section);
    const namespaceStart =
      declarationBlock === null
        ? -1
        : section
            .slice(declarationBlock.index + declarationBlock[0].length)
            .search(/^## [^\r\n]+\r?\n/mu);
    if (declarationBlock !== null && namespaceStart >= 0) {
      descriptionEnd =
        descriptionStart + declarationBlock.index + declarationBlock[0].length + namespaceStart;
    }
    if (descriptionEnd < description.length) {
      if (description.slice(descriptionEnd - 4, descriptionEnd) === "\r\n\r\n") {
        descriptionEnd -= 4;
      } else if (description.slice(descriptionEnd - 2, descriptionEnd) === "\n\n") {
        descriptionEnd -= 2;
      } else {
        throw new ResponsesNestedCatalogIncompatibilityError(
          `Codex Responses nested tool ${name} did not end at an exact catalog boundary`,
          { index, toolName: name },
        );
      }
    }
    const toolDescription = description.slice(descriptionStart, descriptionEnd);
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const declaration = new RegExp(
      `declare\\s+const\\s+tools\\s*:\\s*\\{\\s*${escapedName}\\s*\\(`,
      "u",
    );
    if (!toolDescription.includes("exec tool declaration:") || !declaration.test(toolDescription)) {
      throw new ResponsesNestedCatalogIncompatibilityError(
        `Codex Responses nested tool ${name} did not contain its exact executable declaration`,
        { index, toolName: name, descriptionChars: toolDescription.length },
      );
    }
    // Code-mode identifiers flatten a namespace, but the native dispatcher
    // still accepts its original namespace/name without a JavaScript wrapper.
    const namespace = [
      ...description.slice(0, headingStart).matchAll(/^## ([A-Za-z0-9_]+)\r?$/gmu),
    ].at(-1)?.[1];
    const prefix = namespace === undefined ? undefined : `${namespace}__`;
    tools.push({
      name,
      description: toolDescription,
      ...(namespace !== undefined && prefix !== undefined && name.startsWith(prefix)
        ? { nativeNamespace: namespace, nativeName: name.slice(prefix.length) }
        : {}),
    });
  }
  return tools;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function normalizeNeverFullAccessSelection(
  selection: ResponsesSelectedToolCall,
): ResponsesSelectedToolCall {
  if (
    selection.namespace !== undefined ||
    selection.name !== "exec_command" ||
    !isObject(selection.arguments) ||
    selection.arguments.sandbox_permissions !== "require_escalated"
  )
    return selection;
  const args = { ...selection.arguments, sandbox_permissions: "use_default" };
  Reflect.deleteProperty(args, "justification");
  Reflect.deleteProperty(args, "prefix_rule");
  return { ...selection, arguments: args };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError(signal);
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("Responses runtime tool call cancelled");
  error.name = "AbortError";
  return error;
}

function turnCompletionError(message: JsonObject): Error | undefined {
  const params = isObject(message.params) ? message.params : {};
  const turn = isObject(params.turn) ? params.turn : {};
  if (turn.status === "completed") return undefined;
  const status = typeof turn.status === "string" ? turn.status : "missing terminal status";
  const error = errorFromNativeRecord(
    turn.error,
    `Responses executor turn ${String(turn.id ?? "unknown")} ${status}`,
  );
  Reflect.set(error, "appServerError", turn.error);
  Reflect.set(error, "appServerTurn", turn);
  Reflect.set(error, "appServerNotification", message);
  return error;
}

function toolExecutionError(message: string, result: ResponsesToolExecutionResult): Error {
  const error = new Error(message);
  error.name = "ResponsesToolExecutionError";
  Reflect.set(error, "executionResult", result);
  Reflect.set(error, "callId", result.callId);
  Reflect.set(error, "outputType", result.outputType);
  Reflect.set(error, "output", result.output);
  Reflect.set(error, "rawItem", result.rawItem);
  Reflect.set(error, "executionStatus", result.executionStatus);
  return error;
}

function errorFromNativeRecord(value: unknown, fallbackMessage: string): Error {
  const native = isObject(value) ? value : undefined;
  const message =
    native !== undefined && typeof native.message === "string" && native.message.length > 0
      ? native.message
      : typeof value === "string" && value.length > 0
        ? value
        : fallbackMessage;
  const error = new Error(message);
  if (native === undefined) {
    if (value !== undefined) Reflect.set(error, "value", value);
    return error;
  }
  if (typeof native.name === "string" && native.name.length > 0) error.name = native.name;
  if (typeof native.stack === "string" && native.stack.length > 0) error.stack = native.stack;
  for (const [key, fieldValue] of Object.entries(native)) {
    if (key === "name" || key === "message" || key === "stack") continue;
    Reflect.set(error, key, fieldValue);
  }
  return error;
}

function nestedToolSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function isFunctionsExecSelection(selection: ResponsesSelectedToolCall): boolean {
  return (
    (selection.kind === "custom" || selection.kind === "freeform") &&
    selection.namespace === "functions" &&
    selection.name === "exec"
  );
}

/** Image delivery has a concrete native result shape; a missing-file error
 * must not become a successful delivery just because the outer turn ended.
 */
export function nativeDirectToolExecutionStatus(
  name: string,
  output: unknown,
): ResponsesToolExecutionStatus {
  if (name === "view_image") {
    return Array.isArray(output) &&
      output.some((item) => isObject(item) && item.type === "input_image")
      ? "succeeded"
      : "failed";
  }
  return isObject(output) && output.isError === true ? "failed" : "succeeded";
}

/** Read only the native envelope, never text printed by caller JavaScript.
 * The first content block is emitted by the installed Code Mode host. Unknown
 * envelopes fail closed with the original output attached by the caller.
 */
export function nativeCodeCellExecutionStatus(output: unknown): ResponsesToolExecutionStatus {
  // The native host returns a plain error string when it cannot create the
  // normal envelope (startup, parse, or IPC frame-size failure). Pass that
  // error through instead of obscuring it with an adapter lifecycle error.
  if (typeof output === "string") return "failed";
  const first = Array.isArray(output) ? output[0] : undefined;
  const header = isObject(first) && first.type === "input_text" ? first.text : undefined;
  if (typeof header === "string") {
    const match =
      /^Script (completed|failed)\nWall time [0-9]+(?:\.[0-9]+)? seconds\nOutput:\n$/u.exec(header);
    if (match !== null) return match[1] === "completed" ? "succeeded" : "failed";
  }
  throw new ResponsesCodeCellLifecycleError(
    "Native Code Mode terminal envelope was missing or unsupported",
  );
}

function optionalNonNegativeInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveSettlement) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveSettlement(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    void promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return delay(milliseconds);
  throwIfAborted(signal);
  return new Promise((resolveDelay, rejectDelay) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error === undefined) resolveDelay();
      else rejectDelay(error);
    };
    const onAbort = () => finish(abortError(signal));
    const timer = setTimeout(() => finish(), milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
