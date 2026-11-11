import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { join, resolve } from "node:path";
import type { RuntimeCandidate } from "../domain/runtime.js";
import { normalizeChatGptConversationUrl } from "../infrastructure/chatgpt/chatgpt-conversation-route.js";
import { DesktopChatApiClient } from "../infrastructure/chatgpt/desktop-chat-api-client.js";
import { omniCodexDataDirectory } from "../infrastructure/config/omnicodex-config-store.js";
import type { DirectGoalStore } from "../infrastructure/mcp/direct-goal-store.js";
import type {
  DirectJobDispatchAdapter,
  DirectJobManager,
} from "../infrastructure/mcp/direct-job-mcp-tools.js";
import { DirectScheduleManager } from "../infrastructure/mcp/direct-schedule-mcp-tools.js";
import type { DirectScheduleStore } from "../infrastructure/mcp/direct-schedule-store.js";
import type { DurableWorkSessionStore } from "../infrastructure/mcp/durable-work-session-store.js";
import type { LegacyMutationCoordinator } from "../infrastructure/mcp/legacy-mutation-coordinator.js";
import {
  compareNativeRequestIdentities,
  type NativeRequestIdentityComparison,
} from "../infrastructure/mcp/mcp-work-session-context.js";
import type { MutationReplayStore } from "../infrastructure/mcp/mutation-replay-store.js";
import {
  createOmniCodexMcpServer,
  type McpMutationReplayObservation,
  type McpProgressObservation,
  type McpReadInvocationObservation,
  type McpResultDeliveryObservation,
  type McpToolCatalogObservation,
  type NativeToolExecutionObservation,
  OMNICODEX_CHATGPT_ACTION_CATALOG_BYTE_BUDGET,
  OMNICODEX_MCP_SERVER_NAME,
  type OmniCodexFullCatalogSnapshot,
  type OmniCodexMcpServerHandle,
} from "../infrastructure/mcp/omnicodex-mcp-server.js";
import { ReadInvocationCoordinator } from "../infrastructure/mcp/read-invocation-coordinator.js";
import {
  type AuthorizationServerMetadataRequestObservation,
  type DurableMcpEventStoreFactory,
  type HttpAuthorizationDecision,
  type McpSessionExecutorContext,
  type McpSessionExecutors,
  StreamableHttpGateway,
  type StreamableHttpGatewayAddress,
  type StreamableHttpGatewayRequestObservation,
  type StreamableHttpGatewayRuntimeStatus,
} from "../infrastructure/mcp/streamable-http-gateway.js";
import { CodexAppServerConnection } from "../infrastructure/runtime/codex-app-server-connection.js";
import { CodexAppServerProcess } from "../infrastructure/runtime/codex-app-server-process.js";
import { CodexDetachedThreadClient } from "../infrastructure/runtime/codex-detached-thread-client.js";
import {
  CodexModelMetadataSource,
  type CodexModelMetadataSourceLike,
} from "../infrastructure/runtime/codex-model-metadata-source.js";
import { CodexSchemaBundleLoader } from "../infrastructure/runtime/codex-schema-bundle-loader.js";
import { CuaPluginServerReader } from "../infrastructure/runtime/cua-plugin-server-reader.js";
import type { DurableNativeResourceLeaseCoordinatorLike } from "../infrastructure/runtime/durable-native-resource-lease-coordinator.js";
import type { JsonObject } from "../infrastructure/runtime/jsonl-rpc-client.js";
import type { CodexAppServerOwnershipRegistry } from "../infrastructure/runtime/owned-codex-app-server-registry.js";
import {
  isRecoverableGenerationFailure,
  RestartableCodexAppServerProcess,
} from "../infrastructure/runtime/restartable-codex-app-server-process.js";
import type {
  CodexBoundaryGuard,
  CodexBoundarySnapshot,
} from "../infrastructure/safety/windows-codex-boundary-guard.js";
import {
  type CodexAppToolsClient,
  CodexAppToolsPipeClient,
  CodexAppToolsSharedReadinessError,
} from "../infrastructure/windows/codex-app-tools-pipe-client.js";
import { CodexDesktopIpcClient } from "../infrastructure/windows/codex-desktop-ipc-client.js";
import { CodexDesktopLifecycleController } from "../infrastructure/windows/codex-desktop-lifecycle-controller.js";
import { CodexRuntimeDiscovery } from "../infrastructure/windows/codex-runtime-discovery.js";
import { CodexWorkExecutorIdReader } from "../infrastructure/windows/codex-work-executor-id-reader.js";
import type { DesktopChatRendererEvaluate } from "../infrastructure/windows/desktop-chat-api-reader.js";
import {
  type DesktopChatCompletionCandidate,
  type DesktopChatCompletionVerification,
  DesktopChatConversationSources,
  desktopChatAccountSourceId,
} from "../infrastructure/windows/desktop-chat-completion.js";
import {
  type DesktopChatEventObservationStatus,
  DesktopChatEventSource,
} from "../infrastructure/windows/desktop-chat-event-source.js";
import { projectDesktopExactCompletion } from "../infrastructure/windows/desktop-chat-exact-completion.js";
import { continueDesktopChatGoal } from "../infrastructure/windows/desktop-chat-goal-continuation.js";
import {
  dispatchDesktopChatNativeSend,
  prepareDesktopChatNativeSend,
  sendDesktopChatNativeMessage,
} from "../infrastructure/windows/desktop-chat-native-sender.js";
import {
  desktopChatAccountConnectorIds,
  selectDesktopGoalConnectorId,
} from "../infrastructure/windows/desktop-chat-plugin-binding.js";
import { DesktopEngineBuildReader } from "../infrastructure/windows/desktop-engine-build-reader.js";
import { DesktopEngineRefreshRunner } from "../infrastructure/windows/desktop-engine-refresh-runner.js";
import type { DesktopGoalSnapshot } from "../infrastructure/windows/desktop-goal-binding-reader.js";
import { FirstPartyChromeSurfaceRecovery } from "../infrastructure/windows/first-party-chrome-surface-recovery.js";
import { AppServerMethodCatalog, AppServerMethodExecutor } from "./app-server-method-catalog.js";
import { answerAppServerApprovalRequest } from "./app-server-request-handler.js";
import {
  APP_SERVER_THREAD_INVENTORY_SOURCE_KINDS,
  type AppServerThreadInventory,
  probeAppServerThreadInventory,
  readAppServerThreadInventory,
} from "./app-server-thread-inventory.js";
import { BrowserNativeExecutor } from "./browser-native-executor.js";
import {
  ChatAccountRateLimitError,
  ChatAccountRequestCoordinator,
} from "./chat-account-request-coordinator.js";
import { ChatGptBrowserActivityCoordinator } from "./chatgpt-browser-activity-coordinator.js";
import {
  type ApprovedConversationSyncTarget,
  synchronizeApprovedChromeConversation,
} from "./chrome-approved-conversation-sync.js";
import {
  type ChromeGoalContinuationTarget,
  continueChromeGoal,
} from "./chrome-goal-continuation.js";
import { CodeModeNativeToolSurface } from "./code-mode-native-tool-surface.js";
import {
  type CodexAppHostToolCallContext,
  CodexAppHostToolExecutor,
  type CodexDynamicToolCallObservation,
} from "./codex-app-host-tool-executor.js";
import { createCodexBrowserContextResolver } from "./codex-browser-context-resolver.js";
import { CodexThreadMessageRouter } from "./codex-thread-message-router.js";
import { ComputerUseNativeExecutor } from "./computer-use-native-executor.js";
import { signalDesktopRuntimeDisconnection } from "./desktop-runtime-disconnection.js";
import {
  createDisposableNativeAppServerContext,
  type OmniCodexSessionNativeRuntime,
} from "./disposable-native-app-server-context.js";
import { EngineBuildFollower } from "./engine-build-follower.js";
import { NativeExecutionScheduler } from "./native-execution-scheduler.js";
import {
  type AppServerRpcClient,
  type AppServerRpcRequestOptions,
  NativeToolCatalog,
  NativeToolExecutor,
} from "./native-tool-catalog.js";
import { omniCodexServerIdentityFromMetadata } from "./native-tool-server-identity.js";
import {
  OMNICODEX_BRIDGE_CONTEXT_TOOLS,
  type OmniCodexBridgeReconcileResult,
  OmniCodexBridgeReconciler,
  type OmniCodexBridgeThreadLifecycle,
  omniCodexBridgeRegistryDigest,
} from "./omnicodex-bridge-reconciler.js";
import {
  type ResponsesExecutionSource,
  ResponsesNativeToolCatalog,
  ResponsesNativeToolExecutor,
} from "./responses-native-tool-catalog.js";
import {
  OMNICODEX_LOOPBACK_PROVIDER_ID,
  ResponsesRuntimeExecutor,
} from "./responses-runtime-executor.js";
import {
  SharedResponsesAppServer,
  type SharedResponsesLease,
} from "./shared-responses-app-server.js";

const STARTUP_READINESS_RETRY_DELAY_MS = 250;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;
const INTERACTIVE_CLIENT_IDLE_POLL_MS = 250;
// Durable Web work-session and Browser executor state remain resident, while
// their disposable native App Server execution thread is retired after a
// quiet minute so dormant conversations cannot accumulate child processes.
export const OMNICODEX_DURABLE_NATIVE_CONTEXT_IDLE_MS = 60_000;
// A Pro turn can reason for many minutes between browser calls; 30 minutes
// without any native call means the turn has ended and its activity was left open.
export const OMNICODEX_DURABLE_NATIVE_CONTEXT_PENDING_ACTIVITY_MAX_IDLE_MS = 30 * 60_000;
// This bounds one read-only liveness observation, not the lifecycle transition.
// A failed frame leaves or restores admission to open; an operator-supplied
// transition deadline remains the only total drain deadline.
const INTERACTIVE_CLIENT_PROBE_LIVENESS_MS = 30_000;
// This is the live Codex Desktop list_threads schema maximum, not an
// OmniCodex result cap. Active conversations are the most recently updated.
const CODEX_APP_LIST_THREADS_MAX = 50;
const TRANSIENT_STARTUP_READINESS_MESSAGES = [
  "app server request timed out:",
  "codex app server schema generation timed out",
  "jsonl app server stream ended",
  "jsonl app server client is closed",
  "jsonl app server client closed",
  "codex functions.exec returned no parseable json result",
] as const;

/**
 * Refresh the code-mode sources transactionally. Discovery may perform I/O in
 * parallel, but publication is synchronous and happens only after every
 * source has produced a complete candidate.
 */
async function refreshCodeModeCatalogsAtomically(
  hostTools: CodexAppHostToolExecutor,
  methodCatalog: AppServerMethodCatalog,
  downstreamCatalog: NativeToolCatalog,
  signal?: AbortSignal,
): Promise<void> {
  throwIfRuntimePreparationAborted(signal);
  const snapshots = Promise.all([
    hostTools.prepareToolsRefresh(signal),
    methodCatalog.prepareRefresh(),
    downstreamCatalog.prepareRefresh(undefined, signal === undefined ? {} : { signal }),
  ]);
  // Preparation can share another caller's read. Cancellation ends only this
  // publication attempt; a late shared result must never commit after stop.
  const [hostSnapshot, methodSnapshot, downstreamSnapshot] =
    signal === undefined ? await snapshots : await awaitSessionPromise(snapshots, signal);
  throwIfRuntimePreparationAborted(signal);
  hostTools.commitToolsRefresh(hostSnapshot);
  methodCatalog.commitRefresh(methodSnapshot);
  downstreamCatalog.commitRefresh(downstreamSnapshot);
}

export type OmniCodexGatewayLifecycle =
  | "stopped"
  | "starting"
  | "shadow_starting"
  | "draining"
  | "switching"
  | "observing"
  | "retiring_previous"
  | "cleanup_pending"
  | "rolling_back"
  | "recovering"
  | "converging"
  | "ready"
  | "stopping"
  | "failed";

export interface OmniCodexGatewayStatus {
  readonly lifecycle: OmniCodexGatewayLifecycle;
  readonly candidate?: RuntimeCandidate;
  readonly address?: StreamableHttpGatewayAddress;
  readonly appServerMethodCount?: number;
  readonly downstreamToolCount?: number;
  readonly responsesToolCount?: number;
  readonly hostToolCount?: number;
  readonly bridgeThreadId?: string;
  readonly bridgeDisposition?: "current" | "created" | "replaced" | "deferred_active_owner";
  readonly bridgeRegistryCurrent?: boolean;
  readonly bridgeConvergenceError?: string | undefined;
  readonly lastError?: string;
}

export interface OmniCodexRuntimeDiscoverySource {
  discover(desktopExecutablePath?: string): Promise<{
    readonly candidates: readonly RuntimeCandidate[];
    readonly warnings: readonly string[];
  }>;
}

export interface OmniCodexGatewayServiceOptions {
  /** Reuses account-bound exact observers only during the existing restart wait. */
  readonly createInteractiveActivityProbe?: () => (
    signal: AbortSignal,
    locallyTrackedConversationIds?: readonly string[],
  ) => Promise<OmniCodexAdditionalInteractiveActivity>;
  readonly evaluateDesktopNativeSend?: DesktopChatRendererEvaluate;
  /** Select the renderer route only while its transport is available, before dispatch. */
  readonly isDesktopNativeSendReady?: () => boolean;
  readonly readDesktopGoalSnapshot?: (
    conversationUrl: string,
    accountSourceId: string,
    signal: AbortSignal,
  ) => Promise<DesktopGoalSnapshot>;
  readonly cwd?: string;
  readonly browserEnvironment?: "codex-app" | "training";
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  readonly fullPath?: string;
  readonly allowedOrigins?: readonly string[];
  readonly allowedHosts?: readonly string[];
  readonly publicMetadataOrigin?: string;
  readonly protectedResourceMetadata?: Record<string, unknown>;
  readonly authorizationServerMetadata?: Record<string, unknown>;
  readonly directGoalStore?: DirectGoalStore;
  readonly directJobManager?: DirectJobManager;
  readonly directScheduleStore?: DirectScheduleStore;
  readonly durableWorkSessionStore?: DurableWorkSessionStore;
  readonly durableMcpEventStoreFactory?: DurableMcpEventStoreFactory;
  readonly mutationReplayStore?: MutationReplayStore;
  readonly legacyMutationCoordinator?: LegacyMutationCoordinator;
  /** One daemon-wide durable lease coordinator shared across runtime generations. */
  readonly nativeResourceLeaseCoordinator?: DurableNativeResourceLeaseCoordinatorLike;
  /** Supplies process-local credentials without granting the child a refresh token. */
  readonly runtimeEnvironment?: () => Promise<NodeJS.ProcessEnv>;
  readonly onStatusChange?: (status: OmniCodexGatewayStatus) => Promise<void> | void;
  readonly authorize: (
    request: IncomingMessage,
  ) => Promise<HttpAuthorizationDecision> | HttpAuthorizationDecision;
  readonly observeMcpRequest?: (
    observation: StreamableHttpGatewayRequestObservation,
  ) => Promise<void> | void;
  readonly prepareChatGptConversationRequest?: (input: {
    readonly surface: "compat" | "full";
    readonly chatGptConversationUrl: string;
  }) => Promise<void> | void;
  readonly observeAuthorizationServerMetadataRequest?: (
    observation: AuthorizationServerMetadataRequestObservation,
  ) => Promise<void> | void;
  readonly observeNativeToolExecution?: (
    observation: NativeToolExecutionObservation,
  ) => Promise<void> | void;
  readonly observeDynamicToolExecution?: (
    observation: CodexDynamicToolCallObservation,
  ) => Promise<void> | void;
  readonly prepareProtectedResultDelivery?: (input: {
    readonly surface: "compat" | "full";
    readonly mcpToolName: string;
    readonly chatGptConversationUrl?: string;
    readonly correlationId?: string;
  }) => Promise<void> | void;
  readonly observeProgress?: (observation: McpProgressObservation) => Promise<void> | void;
  readonly observeResultDelivery?: (
    observation: McpResultDeliveryObservation,
  ) => Promise<void> | void;
  readonly observeMutationReplay?: (
    observation: McpMutationReplayObservation,
  ) => Promise<void> | void;
  readonly observeReadInvocation?: (
    observation: McpReadInvocationObservation,
  ) => Promise<void> | void;
  readonly observeToolCatalog?: (observation: McpToolCatalogObservation) => Promise<void> | void;
  readonly discovery?: OmniCodexRuntimeDiscoverySource;
  readonly nonInterferenceBoundary?: CodexBoundaryGuard;
  readonly prepareRuntime?: (
    candidate: RuntimeCandidate,
    options?: OmniCodexPrepareRuntimeOptions,
  ) => Promise<OmniCodexPreparedRuntime>;
  readonly appToolsClientFactory?: () => CodexAppToolsClient;
  /** Injectable exact installed-model source; production reads Codex's own cache. */
  readonly modelMetadataSource?: CodexModelMetadataSourceLike;
  /** Optional caller policy; omitted keeps retrying transient readiness until lifecycle cancellation. */
  readonly startupReadinessMaxPasses?: number;
  readonly runtimeObservationMs?: number;
  /** Polls the live app-global tool catalog without restarting the gateway. */
  readonly catalogConvergenceIntervalMs?: number;
  /** Optional operator override; omitted serializes Responses calls. */
  readonly sessionResponsesRuntimeLimit?: number;
  /** Optional operator deadline for accepted MCP work; omitted waits for full settlement. */
  readonly shutdownDrainTimeoutMs?: number;
  /** Optional operator deadline for each shutdown/cleanup phase; omitted waits for settlement. */
  readonly shutdownPhaseTimeoutMs?: number;
  readonly observeRuntime?: (
    runtime: OmniCodexPreparedRuntime,
    address: StreamableHttpGatewayAddress,
    durationMs: number,
  ) => Promise<void>;
  readonly onDiagnostic?: (message: JsonObject) => void;
  readonly onUnexpectedRuntimeExit?: (error: Error) => Promise<void> | void;
  /** One registry shared by primary, detached, and Bridge bootstrap App Servers. */
  readonly ownershipRegistry?: CodexAppServerOwnershipRegistry;
}

export interface OmniCodexSessionResponsesRuntime extends ResponsesExecutionSource {
  close(): Promise<void>;
}

export interface OmniCodexSessionExecutorPoolOptions {
  /** Limits calls without evicting their native execution state. */
  readonly responsesCallConcurrency?: number;
  readonly maxActiveResponsesRuntimes?: number;
  readonly responsesRuntimeIdleMs?: number;
  /** Optional native App Server context retirement. Omit to keep the context resident. */
  readonly nativeContextIdleMs?: number;
  /**
   * Upper bound for keeping an idle native context only because a browser
   * activity is still open. A Web turn that ends without another call never
   * closes its activity, so without this bound its App Server tree stays
   * resident forever. Omit to keep such contexts until close.
   */
  readonly nativeContextPendingActivityMaxIdleMs?: number;
  /** Legacy test seam. Production supplies createNativeRuntime. */
  readonly createNativeToolExecutor?: (context: McpSessionExecutorContext) => NativeToolExecutor;
  readonly createNativeRuntime?: (
    context: McpSessionExecutorContext,
    signal: AbortSignal,
  ) => Promise<OmniCodexSessionNativeRuntime>;
  /** Browser clients keep mutable connection/recovery state per Web work session. */
  readonly createBrowserNativeExecutor?: (
    context: McpSessionExecutorContext,
    nativeToolExecutor: NativeToolExecutor,
  ) => BrowserNativeExecutor;
  readonly createResponsesRuntime: (
    context: McpSessionExecutorContext,
    nativeToolExecutor: NativeToolExecutor,
    signal: AbortSignal,
    browserNativeExecutor?: BrowserNativeExecutor,
  ) => Promise<OmniCodexSessionResponsesRuntime>;
}

interface ResponsesRuntimeCapacityWaiter {
  readonly lease: OmniCodexSessionExecutorLease;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

/**
 * Owns mutable native execution state per durable principal + Web work
 * session. MCP transports are only attachment points: reconnecting transports
 * for the same conversation resolve the same native lease, while deployments
 * without durable work-session identity retain the original per-transport
 * lifecycle. Responses children are lazy; catalogs, the primary
 * App Server transport, and resource scheduling remain runtime-wide shared
 * infrastructure.
 */
export class OmniCodexSessionExecutorPool {
  readonly #options: OmniCodexSessionExecutorPoolOptions;
  readonly #sessions = new Set<OmniCodexSessionExecutorLease>();
  readonly #workSessionLeases = new Map<string, OmniCodexSessionExecutorLease>();
  readonly #runtimeOwners = new Set<OmniCodexSessionExecutorLease>();
  readonly #capacityWaiters: ResponsesRuntimeCapacityWaiter[] = [];
  readonly #callWaiters = new Set<() => void>();
  #activeRuntimeCalls = 0;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: OmniCodexSessionExecutorPoolOptions) {
    if (
      (options.createNativeRuntime === undefined) ===
      (options.createNativeToolExecutor === undefined)
    ) {
      throw new TypeError("Session executor pool requires exactly one native runtime factory");
    }
    const maxActiveResponsesRuntimes = optionalPositiveSafeInteger(
      options.maxActiveResponsesRuntimes,
      "Session Responses runtime limit",
    );
    const responsesRuntimeIdleMs = optionalPositiveSafeInteger(
      options.responsesRuntimeIdleMs,
      "Session Responses runtime idle timeout",
    );
    const nativeContextIdleMs = optionalPositiveSafeInteger(
      options.nativeContextIdleMs,
      "Session native context idle timeout",
    );
    const nativeContextPendingActivityMaxIdleMs = optionalPositiveSafeInteger(
      options.nativeContextPendingActivityMaxIdleMs,
      "Session native context pending-activity idle bound",
    );
    this.#options = {
      ...options,
      ...(options.responsesCallConcurrency === undefined
        ? {}
        : {
            responsesCallConcurrency: optionalPositiveSafeInteger(
              options.responsesCallConcurrency,
              "Responses call concurrency",
            ) as number,
          }),
      ...(maxActiveResponsesRuntimes === undefined ? {} : { maxActiveResponsesRuntimes }),
      ...(responsesRuntimeIdleMs === undefined ? {} : { responsesRuntimeIdleMs }),
      ...(nativeContextIdleMs === undefined ? {} : { nativeContextIdleMs }),
      ...(nativeContextPendingActivityMaxIdleMs === undefined
        ? {}
        : { nativeContextPendingActivityMaxIdleMs }),
    };
  }

  get nativeContextPendingActivityMaxIdleMs(): number | undefined {
    return this.#options.nativeContextPendingActivityMaxIdleMs;
  }

  get activeResponsesRuntimeCount(): number {
    return this.#runtimeOwners.size;
  }

  createSessionExecutors(context: McpSessionExecutorContext): McpSessionExecutors {
    if (this.#closed) throw new Error("OmniCodex session executor pool is closed");
    if (context.resolveWorkSessionBinding !== undefined) {
      return new OmniCodexWorkSessionExecutorHandle(
        context,
        (workSessionBinding) => this.#resolveWorkSessionLease(context, workSessionBinding),
        this.#options.createBrowserNativeExecutor !== undefined,
      ).executors;
    }
    return this.#createTransportExecutors(context);
  }

  #createTransportExecutors(context: McpSessionExecutorContext): McpSessionExecutors {
    const lease = new OmniCodexSessionExecutorLease(
      this,
      context,
      (signal) => this.#createNativeRuntime(context, signal),
      this.#options.createBrowserNativeExecutor,
    );
    const browserNativeExecutor = lease.browserNativeExecutor;
    this.#sessions.add(lease);
    return {
      nativeToolExecutor: lease.nativeToolExecutor,
      ...(browserNativeExecutor === undefined ? {} : { browserNativeExecutor }),
      responsesToolExecutor: responsesToolExecutorForLease(() => lease),
      close: () => lease.close(),
    };
  }

  #resolveWorkSessionLease(
    context: McpSessionExecutorContext,
    workSessionBinding: string,
  ): OmniCodexSessionExecutorLease {
    if (this.#closed) throw new Error("OmniCodex session executor pool is closed");
    const key = JSON.stringify([context.authorizationBinding, workSessionBinding]);
    const existing = this.#workSessionLeases.get(key);
    if (existing !== undefined) return existing;
    const lease = new OmniCodexSessionExecutorLease(
      this,
      context,
      (signal) => this.#createNativeRuntime(context, signal),
      this.#options.createBrowserNativeExecutor,
      key,
    );
    this.#sessions.add(lease);
    this.#workSessionLeases.set(key, lease);
    return lease;
  }

  async close(options: { readonly preserveBrowserActivities?: boolean } = {}): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    for (const wake of this.#callWaiters) wake();
    const closedError = new Error("OmniCodex session executor pool is closed");
    for (const waiter of this.#capacityWaiters.splice(0)) waiter.reject(closedError);
    const operation = Promise.all([...this.#sessions].map((lease) => lease.close(options))).then(
      () => undefined,
    );
    this.#closePromise = operation;
    try {
      await operation;
    } catch (error) {
      if (this.#closePromise === operation) this.#closePromise = undefined;
      throw error;
    }
  }

  async acquireRuntime(
    lease: OmniCodexSessionExecutorLease,
    context: McpSessionExecutorContext,
    nativeToolExecutor: NativeToolExecutor,
    signal: AbortSignal,
  ): Promise<OmniCodexSessionResponsesRuntime> {
    while (true) {
      throwIfSessionAborted(signal);
      this.#assertOpen(lease);
      if (this.#runtimeOwners.has(lease)) {
        throw new Error("OmniCodex session already owns a Responses runtime slot");
      }
      if (
        this.#options.maxActiveResponsesRuntimes === undefined ||
        this.#runtimeOwners.size < this.#options.maxActiveResponsesRuntimes
      ) {
        this.#runtimeOwners.add(lease);
        try {
          return await this.#options.createResponsesRuntime(
            context,
            nativeToolExecutor,
            signal,
            lease.browserNativeExecutor,
          );
        } catch (error) {
          this.#runtimeOwners.delete(lease);
          this.#wakeNextCapacityWaiter();
          throw error;
        }
      }
      const evictable = [...this.#runtimeOwners]
        .filter((candidate) => candidate !== lease && candidate.isIdle)
        .sort((left, right) => left.lastUsedAtUnixMs - right.lastUsedAtUnixMs)[0];
      if (evictable !== undefined) {
        await evictable.evictIdleRuntime();
        continue;
      }
      await this.#waitForCapacity(lease, signal);
    }
  }

  async withRuntimeCall<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const limit = this.#options.responsesCallConcurrency;
    while (limit !== undefined && this.#activeRuntimeCalls >= limit) {
      if (this.#closed) throw new Error("OmniCodex session executor pool is closed");
      let wake!: () => void;
      const ready = new Promise<void>((resolve) => {
        wake = resolve;
      });
      this.#callWaiters.add(wake);
      try {
        await awaitSessionPromise(ready, signal);
      } finally {
        this.#callWaiters.delete(wake);
      }
    }
    throwIfSessionAborted(signal);
    if (this.#closed) throw new Error("OmniCodex session executor pool is closed");
    this.#activeRuntimeCalls += 1;
    try {
      return await operation();
    } finally {
      this.#activeRuntimeCalls -= 1;
      for (const wake of this.#callWaiters) wake();
    }
  }

  releaseRuntimeOwner(lease: OmniCodexSessionExecutorLease): void {
    if (this.#runtimeOwners.delete(lease)) this.#wakeNextCapacityWaiter();
  }

  releaseSession(lease: OmniCodexSessionExecutorLease): void {
    this.#sessions.delete(lease);
    const workSessionKey = lease.workSessionKey;
    if (workSessionKey !== undefined && this.#workSessionLeases.get(workSessionKey) === lease) {
      this.#workSessionLeases.delete(workSessionKey);
    }
    for (let index = this.#capacityWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#capacityWaiters[index];
      if (waiter?.lease !== lease) continue;
      this.#capacityWaiters.splice(index, 1);
      waiter.reject(new Error("OmniCodex MCP session executor is closed"));
    }
  }

  scheduleIdleEviction(lease: OmniCodexSessionExecutorLease): (() => void) | undefined {
    if (this.#options.responsesRuntimeIdleMs === undefined) return undefined;
    return scheduleLongTimeout(this.#options.responsesRuntimeIdleMs, () => {
      void lease.evictIdleRuntime().catch(() => undefined);
    });
  }

  scheduleIdleNativeContextRetirement(
    lease: OmniCodexSessionExecutorLease,
  ): (() => void) | undefined {
    if (this.#options.nativeContextIdleMs === undefined) return undefined;
    return scheduleLongTimeout(this.#options.nativeContextIdleMs, () => {
      void lease.retireIdleNativeContext().catch(() => undefined);
    });
  }

  async #createNativeRuntime(
    context: McpSessionExecutorContext,
    signal: AbortSignal,
  ): Promise<OmniCodexSessionNativeRuntime> {
    if (this.#options.createNativeRuntime !== undefined) {
      return this.#options.createNativeRuntime(context, signal);
    }
    throwIfSessionAborted(signal);
    const nativeToolExecutor = this.#options.createNativeToolExecutor?.(context);
    if (nativeToolExecutor === undefined) {
      throw new Error("Session native runtime factory is unavailable");
    }
    return {
      nativeToolExecutor,
      close: async () => {
        await nativeToolExecutor.retireOwnedExecutionThread();
        nativeToolExecutor.clearOwnedExecutionThreadAfterProcessStop();
      },
    };
  }

  notifyRuntimeBecameIdle(): void {
    this.#wakeNextCapacityWaiter();
  }

  #assertOpen(lease: OmniCodexSessionExecutorLease): void {
    if (this.#closed) throw new Error("OmniCodex session executor pool is closed");
    if (!this.#sessions.has(lease)) throw new Error("OmniCodex MCP session executor is closed");
  }

  #wakeNextCapacityWaiter(): void {
    this.#capacityWaiters.shift()?.resolve();
  }

  #waitForCapacity(lease: OmniCodexSessionExecutorLease, signal: AbortSignal): Promise<void> {
    throwIfSessionAborted(signal);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let waiter!: ResponsesRuntimeCapacityWaiter;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        const index = this.#capacityWaiters.indexOf(waiter);
        if (index >= 0) this.#capacityWaiters.splice(index, 1);
        operation();
      };
      const onAbort = () =>
        finish(() => {
          try {
            throwIfSessionAborted(signal);
          } catch (error) {
            reject(error);
          }
        });
      waiter = {
        lease,
        resolve: () => finish(resolve),
        reject: (error) => finish(() => reject(error)),
      };
      this.#capacityWaiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
}

class OmniCodexWorkSessionExecutorHandle {
  readonly #context: McpSessionExecutorContext;
  readonly #resolveSharedLease: (workSessionBinding: string) => OmniCodexSessionExecutorLease;
  readonly #nativeToolExecutor: NativeToolExecutor;
  readonly #browserNativeExecutor: BrowserNativeExecutor | undefined;
  readonly #responsesToolExecutor: ResponsesNativeToolExecutor;
  #workSessionBinding: string | undefined;
  #lease: OmniCodexSessionExecutorLease | undefined;

  constructor(
    context: McpSessionExecutorContext,
    resolveSharedLease: (workSessionBinding: string) => OmniCodexSessionExecutorLease,
    hasBrowserNativeExecutor: boolean,
  ) {
    this.#context = context;
    this.#resolveSharedLease = resolveSharedLease;
    this.#nativeToolExecutor = new WorkSessionNativeToolExecutor(
      () => this.#resolveLease().nativeToolExecutor,
    );
    this.#browserNativeExecutor = hasBrowserNativeExecutor
      ? new WorkSessionBrowserNativeExecutor(() => this.#resolveLease().browserNativeExecutor)
      : undefined;
    this.#responsesToolExecutor = responsesToolExecutorForLease(() => this.#resolveLease());
  }

  get executors(): McpSessionExecutors {
    return {
      nativeToolExecutor: this.#nativeToolExecutor,
      ...(this.#browserNativeExecutor === undefined
        ? {}
        : { browserNativeExecutor: this.#browserNativeExecutor }),
      responsesToolExecutor: this.#responsesToolExecutor,
      // A durable work-session lease outlives any one transport. The runtime
      // pool closes it after direct jobs and protocol sessions have drained.
      close: () => undefined,
    };
  }

  #resolveLease(): OmniCodexSessionExecutorLease {
    const workSessionBinding = this.#context.resolveWorkSessionBinding?.();
    if (typeof workSessionBinding !== "string" || workSessionBinding.length === 0) {
      throw new Error("WORK_SESSION_CONTEXT_UNAVAILABLE");
    }
    if (this.#workSessionBinding !== undefined && this.#workSessionBinding !== workSessionBinding) {
      throw new Error("WORK_SESSION_BINDING_CONFLICT");
    }
    this.#workSessionBinding = workSessionBinding;
    this.#lease ??= this.#resolveSharedLease(workSessionBinding);
    return this.#lease;
  }
}

class WorkSessionNativeToolExecutor extends NativeToolExecutor {
  readonly #resolveExecutor: () => NativeToolExecutor;

  constructor(resolveExecutor: () => NativeToolExecutor) {
    super({
      request: async <T>(): Promise<T> => {
        throw new Error("WORK_SESSION_CONTEXT_UNAVAILABLE");
      },
    });
    this.#resolveExecutor = resolveExecutor;
  }

  override async call(...args: Parameters<NativeToolExecutor["call"]>): Promise<unknown> {
    return this.#resolveExecutor().call(...args);
  }

  override executionContextIdentity(): object {
    return this.#resolveExecutor().executionContextIdentity();
  }

  override async callInContext(
    ...args: Parameters<NativeToolExecutor["callInContext"]>
  ): Promise<unknown> {
    return this.#resolveExecutor().callInContext(...args);
  }
}

class WorkSessionBrowserNativeExecutor extends BrowserNativeExecutor {
  readonly #resolveExecutor: () => BrowserNativeExecutor | undefined;

  constructor(resolveExecutor: () => BrowserNativeExecutor | undefined) {
    super({
      callInContext: async () => {
        throw new Error("WORK_SESSION_CONTEXT_UNAVAILABLE");
      },
    });
    this.#resolveExecutor = resolveExecutor;
  }

  override async call(...args: Parameters<BrowserNativeExecutor["call"]>): Promise<unknown> {
    const executor = this.#resolveExecutor();
    if (executor === undefined) throw new Error("BROWSER_EXECUTOR_UNAVAILABLE");
    return executor.call(...args);
  }

  override async callCua(...args: Parameters<BrowserNativeExecutor["callCua"]>): Promise<unknown> {
    const executor = this.#resolveExecutor();
    if (executor === undefined) throw new Error("BROWSER_EXECUTOR_UNAVAILABLE");
    return executor.callCua(...args);
  }

  override async finishCurrentActivity(
    ...args: Parameters<BrowserNativeExecutor["finishCurrentActivity"]>
  ): Promise<void> {
    const executor = this.#resolveExecutor();
    if (executor === undefined) throw new Error("BROWSER_EXECUTOR_UNAVAILABLE");
    return executor.finishCurrentActivity(...args);
  }

  override async beginActivity(
    ...args: Parameters<BrowserNativeExecutor["beginActivity"]>
  ): Promise<void> {
    const executor = this.#resolveExecutor();
    if (executor === undefined) throw new Error("BROWSER_EXECUTOR_UNAVAILABLE");
    return executor.beginActivity(...args);
  }

  override async finishActivity(
    ...args: Parameters<BrowserNativeExecutor["finishActivity"]>
  ): Promise<void> {
    const executor = this.#resolveExecutor();
    if (executor === undefined) throw new Error("BROWSER_EXECUTOR_UNAVAILABLE");
    return executor.finishActivity(...args);
  }
}

function responsesToolExecutorForLease(
  resolveLease: () => OmniCodexSessionExecutorLease,
): ResponsesNativeToolExecutor {
  const source: ResponsesExecutionSource = {
    call: (selection, signal) =>
      resolveLease().withRuntime(
        (runtime, effectiveSignal) => runtime.call(selection, effectiveSignal),
        signal,
      ),
    callNested: (name, argumentsValue, freeform, signal) =>
      resolveLease().withRuntime((runtime, effectiveSignal) => {
        if (runtime.callNested === undefined) {
          throw new Error("Codex functions.exec nested-tool bridge is unavailable");
        }
        return runtime.callNested(name, argumentsValue, freeform, effectiveSignal);
      }, signal),
    callMcp: (server, tool, argumentsValue, signal) =>
      resolveLease().withRuntime((runtime, effectiveSignal) => {
        if (runtime.callMcp === undefined) {
          throw new Error("Codex downstream MCP Responses bridge is unavailable");
        }
        return runtime.callMcp(server, tool, argumentsValue, effectiveSignal);
      }, signal),
  };
  return new ResponsesNativeToolExecutor(source);
}

class OmniCodexSessionExecutorLease {
  readonly #pool: OmniCodexSessionExecutorPool;
  readonly #context: McpSessionExecutorContext;
  readonly #createNativeRuntime: (signal: AbortSignal) => Promise<OmniCodexSessionNativeRuntime>;
  readonly #leasedNativeToolExecutor: NativeToolExecutor;
  readonly #browserCleanupNativeToolExecutor: NativeToolExecutor;
  readonly #createBrowserNativeExecutor: OmniCodexSessionExecutorPoolOptions["createBrowserNativeExecutor"];
  // Replaced only by an idle retirement that preserves open activities.
  #browserNativeExecutor: BrowserNativeExecutor | undefined;
  readonly #workSessionKey: string | undefined;
  readonly #lifecycle = new AbortController();
  readonly #nativeLifecycle = new AbortController();
  #nativeRuntime: OmniCodexSessionNativeRuntime | undefined;
  #nativeRuntimePromise: Promise<OmniCodexSessionNativeRuntime> | undefined;
  #nativeRuntimeClosePromise: Promise<void> | undefined;
  #nativeRuntimeAcquisition: AbortController | undefined;
  #nativeRuntimeRequiresRetirement = false;
  #runtime: OmniCodexSessionResponsesRuntime | undefined;
  #runtimePromise: Promise<OmniCodexSessionResponsesRuntime> | undefined;
  #runtimeClosePromise: Promise<void> | undefined;
  #runtimeRequiresRetirement = false;
  #idleTimer: (() => void) | undefined;
  #nativeIdleTimer: (() => void) | undefined;
  #runtimeAcquisition: AbortController | undefined;
  #activeCalls = 0;
  #activeNativeCalls = 0;
  #lastUsedAtUnixMs = Date.now();
  #lastNativeCallUnixMs = Date.now();
  #closing = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    pool: OmniCodexSessionExecutorPool,
    context: McpSessionExecutorContext,
    createNativeRuntime: (signal: AbortSignal) => Promise<OmniCodexSessionNativeRuntime>,
    createBrowserNativeExecutor?: OmniCodexSessionExecutorPoolOptions["createBrowserNativeExecutor"],
    workSessionKey?: string,
  ) {
    this.#pool = pool;
    this.#context = context;
    this.#createNativeRuntime = createNativeRuntime;
    this.#leasedNativeToolExecutor = new LeaseNativeToolExecutor(this, false);
    this.#browserCleanupNativeToolExecutor = new LeaseNativeToolExecutor(this, true);
    this.#createBrowserNativeExecutor = createBrowserNativeExecutor;
    this.#browserNativeExecutor = createBrowserNativeExecutor?.(
      context,
      this.#browserCleanupNativeToolExecutor,
    );
    this.#workSessionKey = workSessionKey;
  }

  get nativeToolExecutor(): NativeToolExecutor {
    return this.#leasedNativeToolExecutor;
  }

  get browserNativeExecutor(): BrowserNativeExecutor | undefined {
    return this.#browserNativeExecutor;
  }

  get workSessionKey(): string | undefined {
    return this.#workSessionKey;
  }

  get isIdle(): boolean {
    return (
      !this.#closed &&
      this.#activeCalls === 0 &&
      this.#runtime !== undefined &&
      this.#runtimeClosePromise === undefined
    );
  }

  get lastUsedAtUnixMs(): number {
    return this.#lastUsedAtUnixMs;
  }

  async withRuntime<T>(
    operation: (runtime: OmniCodexSessionResponsesRuntime, signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const signal = combinedAbortSignal(this.#lifecycle.signal, callerSignal);
    return this.#pool.withRuntimeCall(() => this.#withRuntime(operation, signal), signal);
  }

  async #withRuntime<T>(
    operation: (runtime: OmniCodexSessionResponsesRuntime, signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    if (this.#closed || this.#closing) {
      throw new Error("OmniCodex MCP session executor is closed");
    }
    const signal = combinedAbortSignal(this.#lifecycle.signal, callerSignal);
    throwIfSessionAborted(signal);
    this.#activeCalls += 1;
    this.#clearIdleTimer();
    try {
      const runtime = await awaitSessionPromise(this.#ensureRuntime(), signal);
      if (this.#closed) throw new Error("OmniCodex MCP session executor is closed");
      throwIfSessionAborted(signal);
      try {
        return await operation(runtime, signal);
      } catch (error) {
        if (isRecoverableGenerationFailure(toError(error))) {
          // Preserve the failed mutation's outcome. Only the next independent
          // call may use a replacement; never replay this operation.
          if (this.#runtime === runtime) this.#runtimeRequiresRetirement = true;
          try {
            if (this.#runtime === runtime) await this.#closeRuntime();
            else await this.#runtimeClosePromise;
          } catch (cleanupError) {
            throw new AggregateError(
              [toError(error), toError(cleanupError)],
              "Failed Responses runtime did not stop cleanly",
            );
          }
        }
        throw error;
      }
    } finally {
      this.#activeCalls -= 1;
      this.#lastUsedAtUnixMs = Date.now();
      if (
        !this.#closed &&
        this.#activeCalls === 0 &&
        this.#runtime === undefined &&
        this.#runtimePromise !== undefined
      ) {
        this.#runtimeAcquisition?.abort(
          new Error("Responses runtime acquisition has no active callers"),
        );
      }
      if (!this.#closed && this.#activeCalls === 0 && this.#runtime !== undefined) {
        this.#idleTimer = this.#pool.scheduleIdleEviction(this);
        this.#pool.notifyRuntimeBecameIdle();
      }
    }
  }

  async evictIdleRuntime(): Promise<void> {
    if (!this.isIdle) return;
    await this.#closeRuntime();
  }

  async callNative(
    kind: "call" | "callInContext",
    args: readonly unknown[],
    allowDuringClose = false,
  ): Promise<unknown> {
    if (this.#closed || (this.#closing && !allowDuringClose)) {
      throw new Error("OmniCodex MCP session executor is closed");
    }
    const callerSignal = nativeCallSignal(kind, args);
    const signal = allowDuringClose
      ? combinedAbortSignal(this.#nativeLifecycle.signal, callerSignal)
      : combinedAbortSignal(this.#lifecycle.signal, callerSignal);
    throwIfSessionAborted(signal);
    this.#activeNativeCalls += 1;
    this.#lastNativeCallUnixMs = Date.now();
    this.#clearNativeIdleTimer();
    try {
      const nativeRuntime = await this.#awaitNativeRuntime(signal);
      throwIfSessionAborted(signal);
      if (this.#closed || (this.#closing && !allowDuringClose)) {
        throw new Error("OmniCodex MCP session executor is closed");
      }
      const callArguments = nativeCallArgumentsWithoutSignal(kind, args);
      const operation =
        kind === "call"
          ? nativeRuntime.nativeToolExecutor.call(
              ...(callArguments as Parameters<NativeToolExecutor["call"]>),
            )
          : nativeRuntime.nativeToolExecutor.callInContext(
              ...(callArguments as Parameters<NativeToolExecutor["callInContext"]>),
            );
      return await this.#awaitNativeCall(nativeRuntime, operation, signal);
    } finally {
      this.#activeNativeCalls -= 1;
      this.#lastNativeCallUnixMs = Date.now();
      if (
        !this.#closed &&
        !this.#closing &&
        this.#activeNativeCalls === 0 &&
        this.#nativeRuntime !== undefined
      ) {
        this.#nativeIdleTimer = this.#pool.scheduleIdleNativeContextRetirement(this);
      }
      if (
        this.#activeNativeCalls === 0 &&
        this.#nativeRuntime === undefined &&
        this.#nativeRuntimePromise !== undefined
      ) {
        this.#nativeRuntimeAcquisition?.abort(
          new Error("Native runtime acquisition has no active callers"),
        );
      }
    }
  }

  async retireIdleNativeContext(): Promise<void> {
    if (this.#closed || this.#activeNativeCalls !== 0) return;
    this.#clearNativeIdleTimer();
    // CUA variables and native Stop callbacks are process-local. Preserve the
    // owner until exact activity completion, including long reasoning gaps.
    if (this.#browserNativeExecutor?.hasPendingActivities) {
      const pendingBoundMs = this.#pool.nativeContextPendingActivityMaxIdleMs;
      const withinPendingBound =
        pendingBoundMs === undefined || Date.now() - this.#lastNativeCallUnixMs < pendingBoundMs;
      // Past the bound, hand the open activities over exactly as a service
      // replacement does: persist them, and let the next call adopt and
      // re-register them in a fresh App Server. Nothing is aborted here.
      if (withinPendingBound || !(await this.#replaceBrowserExecutorPreservingActivities())) {
        this.#nativeIdleTimer = this.#pool.scheduleIdleNativeContextRetirement(this);
        return;
      }
      // A call may have started while the handover was awaited. It owns the
      // context now; its completion schedules the next idle retirement.
      if (this.#closed || this.#activeNativeCalls !== 0) return;
    }
    await this.#closeNativeRuntime();
  }

  async #replaceBrowserExecutorPreservingActivities(): Promise<boolean> {
    const previous = this.#browserNativeExecutor;
    const create = this.#createBrowserNativeExecutor;
    if (previous === undefined || create === undefined) return false;
    // Only a durable owner/work-session identity has an activity ledger that a
    // replacement can adopt; transport-scoped sessions retire with their transport.
    if (this.#context.resolveWorkSessionBinding === undefined) return false;
    this.#browserNativeExecutor = create(this.#context, this.#browserCleanupNativeToolExecutor);
    try {
      await previous.close({ preserveActivities: true });
      return true;
    } catch {
      // The previous executor persisted its outstanding ledger before failing;
      // keep the native context so a later retirement or close can finish it.
      return false;
    }
  }

  async close(options: { readonly preserveBrowserActivities?: boolean } = {}): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closing = true;
    this.#lifecycle.abort(new Error("OmniCodex MCP session executor is closed"));
    this.#clearIdleTimer();
    this.#clearNativeIdleTimer();
    const operation = (async () => {
      // Service replacement is not a Web model-turn completion. Its stable
      // browser identity/lifecycle is adopted by the next session executor.
      const cleanupResults = await Promise.allSettled([
        this.#closeRuntime(),
        this.#browserNativeExecutor?.close({
          preserveActivities: options.preserveBrowserActivities === true,
        }),
      ]);
      const errors = cleanupResults.flatMap((result) =>
        result.status === "rejected" ? [toError(result.reason)] : [],
      );
      try {
        await this.#closeNativeRuntime();
      } catch (error) {
        errors.push(toError(error));
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "OmniCodex session executor cleanup failed");
      }
      this.#nativeLifecycle.abort(new Error("OmniCodex MCP session executor is closed"));
      this.#closed = true;
      // Keep failed retirements reachable by pool.close() until every owned
      // resource has actually retired. A rejected close is not disposal.
      this.#pool.releaseSession(this);
    })();
    this.#closePromise = operation;
    try {
      await operation;
    } catch (error) {
      if (this.#closePromise === operation) this.#closePromise = undefined;
      throw error;
    }
  }

  async #ensureNativeRuntime(): Promise<OmniCodexSessionNativeRuntime> {
    if (this.#nativeRuntimeClosePromise !== undefined) {
      await this.#nativeRuntimeClosePromise;
    }
    if (this.#nativeRuntimeRequiresRetirement) await this.#closeNativeRuntime();
    if (this.#nativeRuntime !== undefined) return this.#nativeRuntime;
    if (this.#closed) throw new Error("OmniCodex MCP session executor is closed");
    if (this.#nativeRuntimePromise !== undefined) return this.#nativeRuntimePromise;
    const acquisition = new AbortController();
    this.#nativeRuntimeAcquisition = acquisition;
    const creationSignal = combinedAbortSignal(this.#nativeLifecycle.signal, acquisition.signal);
    this.#nativeRuntimePromise = this.#createNativeRuntime(creationSignal)
      .then(async (runtime) => {
        this.#nativeRuntime = runtime;
        if (this.#closed || creationSignal.aborted) {
          this.#nativeRuntimeRequiresRetirement = true;
          await this.#closeNativeRuntime();
          throwIfSessionAborted(creationSignal);
          throw new Error("OmniCodex MCP session executor is closed");
        }
        return runtime;
      })
      .finally(() => {
        this.#nativeRuntimePromise = undefined;
        if (this.#nativeRuntimeAcquisition === acquisition) {
          this.#nativeRuntimeAcquisition = undefined;
        }
      });
    return this.#nativeRuntimePromise;
  }

  async #awaitNativeRuntime(signal: AbortSignal): Promise<OmniCodexSessionNativeRuntime> {
    const operation = this.#ensureNativeRuntime();
    let abortObserved = signal.aborted;
    let cancellationPromise: Promise<never> | undefined;
    const cancel = (): Promise<never> => {
      abortObserved = true;
      cancellationPromise ??= (async () => {
        const cancellationError = sessionAbortReason(signal);
        this.#nativeRuntimeAcquisition?.abort(cancellationError);
        let runtime: OmniCodexSessionNativeRuntime | undefined;
        try {
          runtime = await operation;
        } catch (error) {
          try {
            await this.#nativeRuntimeClosePromise;
          } catch (cleanupError) {
            throw new AggregateError(
              [cancellationError, toError(error), toError(cleanupError)],
              "Cancelled native runtime startup did not stop cleanly",
            );
          }
          if (error instanceof AggregateError) {
            throw new AggregateError(
              [cancellationError, error],
              "Cancelled native runtime startup did not stop cleanly",
            );
          }
          throw cancellationError;
        }
        await this.#retireNativeRuntime(runtime);
        throw cancellationError;
      })();
      return cancellationPromise;
    };
    let rejectCancellation: (error: unknown) => void = () => undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const beginCancellation = () => {
      void cancel().catch(rejectCancellation);
    };
    if (signal.aborted) beginCancellation();
    else signal.addEventListener("abort", beginCancellation, { once: true });
    try {
      const runtime = await Promise.race([operation, cancellation]);
      if (abortObserved || signal.aborted) return await cancel();
      return runtime;
    } catch (error) {
      if (abortObserved || signal.aborted) return await cancel();
      throw error;
    } finally {
      signal.removeEventListener("abort", beginCancellation);
      void operation.catch(() => undefined);
    }
  }

  async #awaitNativeCall<T>(
    runtime: OmniCodexSessionNativeRuntime,
    operation: Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    let abortObserved = signal.aborted;
    let cancellationPromise: Promise<never> | undefined;
    const cancel = (): Promise<never> => {
      abortObserved = true;
      cancellationPromise ??= (async () => {
        try {
          await this.#retireNativeRuntime(runtime);
        } catch (error) {
          throw new AggregateError(
            [sessionAbortReason(signal), toError(error)],
            "Cancelled native runtime did not stop cleanly",
          );
        }
        throw sessionAbortReason(signal);
      })();
      return cancellationPromise;
    };
    let rejectCancellation: (error: unknown) => void = () => undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const beginCancellation = () => {
      void cancel().catch(rejectCancellation);
    };
    if (signal.aborted) beginCancellation();
    else signal.addEventListener("abort", beginCancellation, { once: true });
    try {
      const result = await Promise.race([operation, cancellation]);
      if (abortObserved || signal.aborted) return await cancel();
      return result;
    } catch (error) {
      if (abortObserved || signal.aborted) return await cancel();
      if (isRecoverableGenerationFailure(toError(error))) {
        // A timed-out mutation may already have executed. Retire its exact
        // process, preserve the original failure, and never replay the call.
        try {
          await this.#retireNativeRuntime(runtime);
        } catch (cleanupError) {
          throw new AggregateError(
            [toError(error), toError(cleanupError)],
            "Failed native runtime did not stop cleanly",
          );
        }
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", beginCancellation);
      void operation.catch(() => undefined);
    }
  }

  async #retireNativeRuntime(runtime: OmniCodexSessionNativeRuntime): Promise<void> {
    if (this.#nativeRuntime !== runtime) {
      await this.#nativeRuntimeClosePromise;
      return;
    }
    this.#nativeRuntimeRequiresRetirement = true;
    await this.#closeNativeRuntime();
  }

  async #closeNativeRuntime(): Promise<void> {
    if (this.#nativeRuntimeClosePromise !== undefined) return this.#nativeRuntimeClosePromise;
    const runtime = this.#nativeRuntime;
    if (runtime === undefined) return;
    this.#nativeRuntimeRequiresRetirement = true;
    const operation = (async () => {
      await runtime.close();
      runtime.nativeToolExecutor.clearOwnedExecutionThreadAfterProcessStop();
      if (this.#nativeRuntime === runtime) this.#nativeRuntime = undefined;
      this.#nativeRuntimeRequiresRetirement = false;
    })().finally(() => {
      if (this.#nativeRuntimeClosePromise === operation) {
        this.#nativeRuntimeClosePromise = undefined;
      }
    });
    this.#nativeRuntimeClosePromise = operation;
    return operation;
  }

  async #ensureRuntime(): Promise<OmniCodexSessionResponsesRuntime> {
    if (this.#runtimeClosePromise !== undefined) await this.#runtimeClosePromise;
    if (this.#runtimeRequiresRetirement) await this.#closeRuntime();
    if (this.#closed || this.#closing) throw new Error("OmniCodex MCP session executor is closed");
    if (this.#runtime !== undefined) return this.#runtime;
    if (this.#runtimePromise !== undefined) return this.#runtimePromise;
    const acquisition = new AbortController();
    this.#runtimeAcquisition = acquisition;
    const creationSignal = combinedAbortSignal(this.#lifecycle.signal, acquisition.signal);
    this.#runtimePromise = this.#pool
      .acquireRuntime(this, this.#context, this.#leasedNativeToolExecutor, creationSignal)
      .then(async (runtime) => {
        this.#runtime = runtime;
        if (this.#closed || creationSignal.aborted) {
          await runtime.close();
          if (this.#runtime === runtime) this.#runtime = undefined;
          this.#pool.releaseRuntimeOwner(this);
          throwIfSessionAborted(creationSignal);
          throw new Error("OmniCodex MCP session executor is closed");
        }
        if (this.#activeCalls === 0) {
          this.#idleTimer = this.#pool.scheduleIdleEviction(this);
          this.#pool.notifyRuntimeBecameIdle();
        }
        return runtime;
      })
      .finally(() => {
        this.#runtimePromise = undefined;
        if (this.#runtimeAcquisition === acquisition) this.#runtimeAcquisition = undefined;
      });
    return this.#runtimePromise;
  }

  async #closeRuntime(): Promise<void> {
    if (this.#runtimeClosePromise !== undefined) return this.#runtimeClosePromise;
    const operation = (async () => {
      const pending = this.#runtimePromise;
      if (this.#runtime === undefined && pending !== undefined) {
        await pending.catch(() => undefined);
      }
      const runtime = this.#runtime;
      if (runtime !== undefined) this.#runtimeRequiresRetirement = true;
      if (runtime !== undefined) await runtime.close();
      // A failed close can leave a live child. Retain both its handle and its
      // capacity ownership so a retry can close it instead of leaking it.
      if (this.#runtime === runtime) this.#runtime = undefined;
      this.#runtimeRequiresRetirement = false;
      this.#pool.releaseRuntimeOwner(this);
    })().finally(() => {
      if (this.#runtimeClosePromise === operation) this.#runtimeClosePromise = undefined;
    });
    this.#runtimeClosePromise = operation;
    return operation;
  }

  #clearIdleTimer(): void {
    this.#idleTimer?.();
    this.#idleTimer = undefined;
  }

  #clearNativeIdleTimer(): void {
    this.#nativeIdleTimer?.();
    this.#nativeIdleTimer = undefined;
  }
}

class LeaseNativeToolExecutor extends NativeToolExecutor {
  readonly #lease: OmniCodexSessionExecutorLease;
  readonly #allowDuringClose: boolean;

  constructor(lease: OmniCodexSessionExecutorLease, allowDuringClose: boolean) {
    super({
      request: async <T>(): Promise<T> => {
        throw new Error("leased native executor does not call App Server RPC directly");
      },
    });
    this.#lease = lease;
    this.#allowDuringClose = allowDuringClose;
  }

  override call(...args: Parameters<NativeToolExecutor["call"]>): Promise<unknown> {
    return this.#lease.callNative("call", args, this.#allowDuringClose);
  }

  override callInContext(
    ...args: Parameters<NativeToolExecutor["callInContext"]>
  ): Promise<unknown> {
    return this.#lease.callNative("callInContext", args, this.#allowDuringClose);
  }

  override retireOwnedExecutionThread(): Promise<void> {
    return this.#lease.retireIdleNativeContext();
  }
}

export interface OmniCodexRuntimeGateway {
  compareNativeRequestIds?(candidates: readonly unknown[]): NativeRequestIdentityComparison;
  readonly runtimeStatus: StreamableHttpGatewayRuntimeStatus;
  /** Present on concrete listeners; undefined means the listener is closed. */
  readonly address: StreamableHttpGatewayAddress | undefined;
  start(): Promise<StreamableHttpGatewayAddress>;
  /** Must settle within the supplied hard deadline. */
  stop(hardTimeoutMs?: number): Promise<void>;
  beginDrain(): StreamableHttpGatewayRuntimeStatus;
  awaitDrained(timeoutMs: number): Promise<void>;
  resumeAdmission(): StreamableHttpGatewayRuntimeStatus;
  /** Web conversations that actually called this exact runtime generation. */
  observedChatGptConversationIds(): readonly string[];
  /** Opaque OpenAI Web work sessions that called this exact runtime generation. */
  observedOpenAiWorkSessionCount?(): number;
  refreshTools?(): Promise<void>;
  readFullCatalogSnapshot?(): Promise<OmniCodexFullCatalogSnapshot>;
}

export interface OmniCodexPreparedRuntime {
  readonly candidate: RuntimeCandidate;
  readonly gateway: OmniCodexRuntimeGateway;
  readonly appServerMethodCount: number;
  readonly downstreamToolCount: number;
  readonly responsesToolCount: number;
  readonly hostToolCount: number;
  readonly bridgeThreadId: string;
  readonly bridgeDisposition: "current" | "created" | "replaced" | "deferred_active_owner";
  readonly bridgeRegistryCurrent: boolean;
  /** Registry digest expected by this exact runtime generation. */
  readonly bridgeRegistryDigest: string;
  readonly bridgeConvergenceError?: string | undefined;
  /** Runtime-generation dispatcher retained independently of MCP transports. */
  readonly directJobDispatchAdapter?: DirectJobDispatchAdapter;
  directProbe(): Promise<void>;
  /** Complete task inventory read through this runtime's already-owned primary App Server. */
  readThreadInventory(): Promise<AppServerThreadInventory>;
  /** Live Codex Desktop task state used only to protect planned transitions. */
  readInteractiveThreadActivity(timeoutMs?: number): Promise<unknown>;
  /** Exact native reader for a Web conversation omitted from the recent inventory. */
  readInteractiveConversationActivity?(threadId: string, timeoutMs?: number): Promise<unknown>;
  /** Read-only first-party inventory from the user's actual Loop Chrome profile. */
  readChromeUserTabs(): Promise<unknown>;
  /** One exact post-delivery OmniCodex approval in the user's Loop Chrome. */
  approveChromeFileMaterialization?(chatGptConversationUrl: string): Promise<unknown>;
  synchronizeApprovedChromeConversation?(
    target: ApprovedConversationSyncTarget,
    signal?: AbortSignal,
  ): Promise<unknown>;
  continueChromeGoal?(target: ChromeGoalContinuationTarget, signal?: AbortSignal): Promise<unknown>;
  continueDesktopGoal?(
    target: ChromeGoalContinuationTarget,
    signal?: AbortSignal,
  ): Promise<unknown>;
  inspectDesktopChatEvents?(): Promise<DesktopChatEventObservationStatus>;
  readDesktopCompletion?(
    conversationUrl: string,
    anchor: string | undefined,
    signal: AbortSignal,
  ): Promise<DesktopChatCompletionVerification>;
  readDesktopChatScope?(
    signal: AbortSignal,
  ): Promise<{ accountSourceId: string; connectorIds: readonly string[] }>;
  verifyDesktopCompletion?(
    candidate: DesktopChatCompletionCandidate,
    signal: AbortSignal,
  ): Promise<DesktopChatCompletionVerification>;
  /**
   * Promotes and authoritatively reads back this runtime's canonical Bridge.
   * Runtime-switch shadows defer this mutation until observation succeeds.
   */
  promoteBridge(): Promise<OmniCodexCatalogConvergenceSnapshot>;
  stopChildren(): Promise<void>;
  startConvergenceMonitor?(onStateChange: () => Promise<void> | void): void;
}

export interface OmniCodexInteractiveClientStatus {
  readonly observedConversationIds: readonly string[];
  readonly activeConversationIds: readonly string[];
  readonly observedOpaqueWorkSessions: number;
  /** A provider-paced pass is incomplete, so this snapshot cannot authorize drain. */
  readonly nextScanAtUnixMs?: number;
}

export interface OmniCodexAdditionalInteractiveActivity {
  readonly observedConversationIds: readonly string[];
  readonly activeConversationIds: readonly string[];
  /** The current pass is incomplete; no idle decision is permitted before retry. */
  readonly nextScanAtUnixMs?: number;
}

export async function resolveChatGptConversationActivity(
  value: unknown,
  requiredConversationIds: readonly string[],
  readConversation: ((id: string) => Promise<unknown>) | undefined,
  preserveUnknown = false,
): Promise<unknown> {
  const root =
    isObject(value) && isObject(value.structuredContent) ? value.structuredContent : value;
  if (
    readConversation === undefined ||
    !isObject(root) ||
    (isObject(value) && value.isError === true) ||
    root.isError === true ||
    !Array.isArray(root.pinnedThreads) ||
    !Array.isArray(root.threads)
  ) {
    return value;
  }
  const listed = [...root.pinnedThreads, ...root.threads];
  const supplemental = await Promise.all(
    requiredConversationIds.map(async (id) => {
      const matching = listed.filter(
        (item) =>
          isObject(item) &&
          item.kind === "chatgpt" &&
          typeof item.id === "string" &&
          item.id.trim().toLocaleLowerCase("en-US") === id,
      );
      if (
        matching.length > 0 &&
        matching.every((item) => isObject(item) && item.status === "active")
      )
        return [];
      // Inventory idle can lag a submitted input. Confirm only conversations
      // already tracked by this runtime before releasing their browser state.
      const unconfirmed = [{ id, kind: "chatgpt", status: "notSettled" }];
      let response: unknown;
      try {
        response = await readConversation(id);
      } catch (error) {
        if (preserveUnknown) return unconfirmed;
        throw error;
      }
      const result =
        isObject(response) && isObject(response.structuredContent)
          ? response.structuredContent
          : response;
      if (
        !isObject(result) ||
        (isObject(response) && response.isError === true) ||
        result.isError === true ||
        !isObject(result.thread) ||
        typeof result.thread.id !== "string" ||
        result.thread.id.trim().toLocaleLowerCase("en-US") !== id ||
        result.thread.kind !== "chatgpt"
      ) {
        if (preserveUnknown) return unconfirmed;
        throw new Error(`LIVE_CODEX_APP_THREAD_ACTIVITY_UNAVAILABLE: exact read failed for ${id}`);
      }
      const rawStatus = result.thread.status ?? result.status;
      const status = isObject(rawStatus) ? (rawStatus.type ?? rawStatus.status) : rawStatus;
      // A completed historical turn does not prove the conversation is idle.
      // Only the reader's current conversation status may authorize retirement.
      if (status !== "active" && status !== "idle") {
        if (preserveUnknown) return unconfirmed;
        throw new Error(
          `LIVE_CODEX_APP_THREAD_ACTIVITY_UNAVAILABLE: exact status missing for ${id}`,
        );
      }
      // The exact native task status is authoritative. A latest user-only turn
      // can be an idle failed/interrupted submission and must not block restart
      // forever after the app has already reported the task idle.
      return [{ id, kind: "chatgpt", status }];
    }),
  );
  // Exact reads belong to independent conversations. Serial fallback makes
  // every missing/stalled conversation delay all later owners by its entire
  // read duration. Preserve input order, but do not serialize those reads.
  const refreshed = supplemental.flat();
  const refreshedIds = new Set(refreshed.map((item) => item.id));
  const retainUnrefreshed = (item: unknown): boolean =>
    !(
      isObject(item) &&
      item.kind === "chatgpt" &&
      typeof item.id === "string" &&
      refreshedIds.has(item.id.trim().toLocaleLowerCase("en-US"))
    );
  // A successful exact read supersedes incomplete inventory entries. Keeping
  // both would let a stale unknown status veto the authoritative replacement.
  // Failed exact reads replace potentially stale idle with unknown.
  return {
    ...root,
    pinnedThreads: root.pinnedThreads.filter(retainUnrefreshed),
    threads: [...root.threads.filter(retainUnrefreshed), ...refreshed],
  };
}

export function activeChatGptConversationIds(
  value: unknown,
  requiredConversationIds: readonly string[] = [],
): readonly string[] {
  const root =
    isObject(value) && isObject(value.structuredContent) ? value.structuredContent : value;
  if (
    (isObject(value) && value.isError === true) ||
    !isObject(root) ||
    root.isError === true ||
    !Array.isArray(root.pinnedThreads) ||
    !Array.isArray(root.threads)
  ) {
    throw new Error("LIVE_CODEX_APP_THREAD_ACTIVITY_UNAVAILABLE");
  }
  const active = new Set<string>();
  const observed = new Set<string>();
  for (const candidate of [...root.pinnedThreads, ...root.threads]) {
    if (!isObject(candidate) || candidate.kind !== "chatgpt" || typeof candidate.id !== "string") {
      continue;
    }
    const id = candidate.id.trim().toLocaleLowerCase("en-US");
    if (id.length === 0) continue;
    if (candidate.status !== "active" && candidate.status !== "idle") {
      throw new Error(`LIVE_CODEX_APP_THREAD_ACTIVITY_UNAVAILABLE: unknown status for ${id}`);
    }
    observed.add(id);
    if (candidate.status === "active") active.add(id);
  }
  // A finite or stale inventory is not evidence that a missing conversation
  // finished. Preserve the serving runtime until its state can be established.
  for (const id of requiredConversationIds) {
    if (!observed.has(id.trim().toLocaleLowerCase("en-US"))) {
      throw new Error(`LIVE_CODEX_APP_THREAD_ACTIVITY_UNAVAILABLE: missing conversation ${id}`);
    }
  }
  return [...active];
}

/** Partial app inventories preserve unknown owners without blocking known ones. */
export function browserConversationActivityObservation(
  value: unknown,
  requiredConversationIds: readonly string[],
): { activeConversationIds: readonly string[]; unknownConversationIds: readonly string[] } {
  const root =
    isObject(value) && isObject(value.structuredContent) ? value.structuredContent : value;
  if (
    (isObject(value) && value.isError === true) ||
    !isObject(root) ||
    root.isError === true ||
    !Array.isArray(root.pinnedThreads) ||
    !Array.isArray(root.threads)
  ) {
    throw new Error("LIVE_CODEX_APP_THREAD_ACTIVITY_UNAVAILABLE");
  }
  const statuses = new Map<string, unknown[]>();
  for (const candidate of [...root.pinnedThreads, ...root.threads]) {
    if (!isObject(candidate) || candidate.kind !== "chatgpt" || typeof candidate.id !== "string") {
      continue;
    }
    const id = candidate.id.trim().toLocaleLowerCase("en-US");
    statuses.set(id, [...(statuses.get(id) ?? []), candidate.status]);
  }
  const activeConversationIds: string[] = [];
  const unknownConversationIds: string[] = [];
  for (const value of requiredConversationIds) {
    const id = value.trim().toLocaleLowerCase("en-US");
    const observed = statuses.get(id);
    if (!observed?.length || observed.some((status) => status !== "active" && status !== "idle")) {
      unknownConversationIds.push(id);
    } else if (observed.includes("active")) {
      activeConversationIds.push(id);
    }
  }
  return { activeConversationIds, unknownConversationIds };
}

export interface OmniCodexThreadInventorySnapshot extends AppServerThreadInventory {
  /** Canonical control task identity; inventory records themselves remain unfiltered. */
  readonly canonicalBridgeThreadId: string;
}

export interface OmniCodexPrepareRuntimeOptions {
  /** Do not mutate the canonical Bridge while this runtime is only a shadow. */
  readonly deferBridgeReconciliation?: boolean;
  /** Canonical Bridge identity inherited read-only while shadow validation runs. */
  readonly initialBridge?: OmniCodexBridgeReconcileResult;
  /** Service-owned cancellation for an in-flight exact-runtime preparation. */
  readonly signal?: AbortSignal;
}

export interface OmniCodexCatalogGeneration {
  readonly codeModeCatalogDigest: string;
  readonly bridgeRegistryDigest: string;
}

export interface OmniCodexCatalogConvergenceSnapshot {
  readonly bridgeThreadId: string;
  readonly bridgeDisposition: OmniCodexPreparedRuntime["bridgeDisposition"];
  readonly bridgeRegistryCurrent: boolean;
  readonly bridgeConvergenceError?: string | undefined;
}

export interface OmniCodexCatalogConvergenceOptions {
  readonly intervalMs: number;
  readonly initialBridge: OmniCodexBridgeReconcileResult;
  readonly initialGeneration: OmniCodexCatalogGeneration;
  readonly refreshCatalog: (signal: AbortSignal) => Promise<OmniCodexCatalogGeneration>;
  readonly refreshMcpSessions: () => Promise<void>;
  readonly reconcileBridge: () => Promise<OmniCodexBridgeReconcileResult>;
  readonly onDiagnostic?: (message: JsonObject) => void;
}

/** Tracks the canonical Bridge identity returned by successful reconciliation. */
export class OmniCodexBridgeThreadContext {
  #threadId: string | undefined;

  get currentThreadId(): string | undefined {
    return this.#threadId;
  }

  accept(result: OmniCodexBridgeReconcileResult): OmniCodexBridgeReconcileResult {
    const threadId = nonEmptyString(result.threadId);
    if (threadId === undefined) {
      throw new Error("Bridge reconciliation did not return a canonical thread id");
    }
    this.#threadId = threadId;
    return result;
  }
}

/**
 * Serializes app-catalog detection, MCP notification, and Bridge replacement.
 * Every attempt and retry delay is bounded; failures remain visible and are
 * retried without restarting the gateway or competing for a desktop writer.
 */
export class OmniCodexCatalogConvergence {
  readonly #options: OmniCodexCatalogConvergenceOptions;
  readonly #lifetime = new AbortController();
  #generation: OmniCodexCatalogGeneration;
  #snapshot: OmniCodexCatalogConvergenceSnapshot;
  #refreshInFlight: Promise<OmniCodexCatalogConvergenceSnapshot> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  #started = false;
  #listener: (() => Promise<void> | void) | undefined;
  #mcpPropagationPending = false;
  /**
   * Separate from the fail-closed snapshot flag: a code-mode-only catalog
   * change blocks callers until MCP propagation completes, but it must not
   * reconcile (and spawn a bootstrap App Server for) an unchanged Bridge.
   */
  #bridgeReconcileRequired: boolean;

  constructor(options: OmniCodexCatalogConvergenceOptions) {
    if (
      !Number.isSafeInteger(options.intervalMs) ||
      options.intervalMs < 10 ||
      options.intervalMs > 300_000
    ) {
      throw new Error("Catalog convergence interval must be between 10 and 300000 milliseconds");
    }
    this.#options = options;
    this.#generation = options.initialGeneration;
    this.#snapshot = {
      bridgeThreadId: options.initialBridge.threadId,
      bridgeDisposition: options.initialBridge.disposition,
      bridgeRegistryCurrent:
        options.initialBridge.disposition !== "deferred_active_owner" &&
        options.initialBridge.registryDigest === options.initialGeneration.bridgeRegistryDigest,
      ...(options.initialBridge.disposition === "deferred_active_owner"
        ? {
            bridgeConvergenceError:
              "Bridge convergence is waiting for the active owner to release the thread",
          }
        : options.initialBridge.registryDigest !== options.initialGeneration.bridgeRegistryDigest
          ? { bridgeConvergenceError: "Bridge registry changed during initial reconciliation" }
          : {}),
    };
    this.#bridgeReconcileRequired = !this.#snapshot.bridgeRegistryCurrent;
  }

  get snapshot(): OmniCodexCatalogConvergenceSnapshot {
    return this.#snapshot;
  }

  get bridgeRegistryDigest(): string {
    return this.#generation.bridgeRegistryDigest;
  }

  start(onStateChange: () => Promise<void> | void): void {
    this.#listener = onStateChange;
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#schedule(0);
  }

  async refreshNow(): Promise<OmniCodexCatalogConvergenceSnapshot> {
    if (this.#stopped) return this.#snapshot;
    if (this.#refreshInFlight !== undefined) return this.#refreshInFlight;
    let operation!: Promise<OmniCodexCatalogConvergenceSnapshot>;
    operation = this.#refresh(false).finally(() => {
      if (this.#refreshInFlight === operation) this.#refreshInFlight = undefined;
    });
    this.#refreshInFlight = operation;
    return operation;
  }

  /**
   * Runs a serialized, authoritative Bridge reconciliation even when the
   * cached convergence snapshot says the registry is current.
   */
  async reconcileNow(): Promise<OmniCodexCatalogConvergenceSnapshot> {
    if (this.#stopped) return this.#snapshot;
    await this.#refreshInFlight;
    if (this.#stopped) return this.#snapshot;
    let operation!: Promise<OmniCodexCatalogConvergenceSnapshot>;
    operation = this.#refresh(true).finally(() => {
      if (this.#refreshInFlight === operation) this.#refreshInFlight = undefined;
    });
    this.#refreshInFlight = operation;
    return operation;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#lifetime.abort(new Error("Catalog convergence stopped"));
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#refreshInFlight?.catch(() => undefined);
  }

  async #refresh(forceBridgeReconcile: boolean): Promise<OmniCodexCatalogConvergenceSnapshot> {
    // An authoritative request survives failures that happen before the
    // Bridge step; only a current reconciliation result clears it.
    if (forceBridgeReconcile) this.#bridgeReconcileRequired = true;
    try {
      const nextGeneration = await this.#options.refreshCatalog(this.#lifetime.signal);
      if (this.#stopped) return this.#snapshot;
      const codeModeCatalogChanged =
        nextGeneration.codeModeCatalogDigest !== this.#generation.codeModeCatalogDigest;
      const bridgeCatalogChanged =
        nextGeneration.bridgeRegistryDigest !== this.#generation.bridgeRegistryDigest;
      if (codeModeCatalogChanged) this.#mcpPropagationPending = true;
      if (bridgeCatalogChanged) this.#bridgeReconcileRequired = true;
      if (codeModeCatalogChanged || bridgeCatalogChanged) {
        await this.#publish({
          ...this.#snapshot,
          bridgeRegistryCurrent: false,
          bridgeConvergenceError: "Native tool catalog changed; convergence is in progress",
        });
      }
      if (this.#stopped) return this.#snapshot;
      this.#generation = nextGeneration;

      if (this.#mcpPropagationPending) {
        await this.#options.refreshMcpSessions();
        if (this.#stopped) return this.#snapshot;
        this.#mcpPropagationPending = false;
      }

      let bridge = this.#snapshot;
      if (this.#bridgeReconcileRequired) {
        const result = await this.#options.reconcileBridge();
        if (this.#stopped) return this.#snapshot;
        const resultCurrent =
          result.disposition !== "deferred_active_owner" &&
          result.registryDigest === nextGeneration.bridgeRegistryDigest;
        this.#bridgeReconcileRequired = !resultCurrent;
        bridge = {
          bridgeThreadId: result.threadId,
          bridgeDisposition: result.disposition,
          bridgeRegistryCurrent: resultCurrent,
          ...(resultCurrent
            ? {}
            : {
                bridgeConvergenceError:
                  result.disposition === "deferred_active_owner"
                    ? "Bridge convergence is waiting for the active owner to release the thread"
                    : "Bridge registry changed during reconciliation",
              }),
        };
      } else {
        bridge = { ...bridge, bridgeRegistryCurrent: true, bridgeConvergenceError: undefined };
      }
      await this.#publish(bridge);
    } catch (error) {
      if (this.#stopped) return this.#snapshot;
      const message = toError(error).message;
      await this.#publish({
        ...this.#snapshot,
        bridgeRegistryCurrent: false,
        bridgeConvergenceError: message,
      });
      this.#diagnose({
        method: "omnicodex/catalogConvergenceFailed",
        params: { message },
      });
    } finally {
      if (this.#started && !this.#stopped) this.#schedule(this.#options.intervalMs);
    }
    return this.#snapshot;
  }

  async #publish(snapshot: OmniCodexCatalogConvergenceSnapshot): Promise<void> {
    if (this.#stopped) return;
    if (sameConvergenceSnapshot(this.#snapshot, snapshot)) return;
    this.#snapshot = snapshot;
    await Promise.resolve(this.#listener?.()).catch((error) => {
      this.#diagnose({
        method: "omnicodex/catalogConvergenceStatusFailed",
        params: { message: toError(error).message },
      });
    });
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.refreshNow();
    }, delayMs);
    this.#timer.unref?.();
  }

  #diagnose(message: JsonObject): void {
    try {
      this.#options.onDiagnostic?.(message);
    } catch {
      // Diagnostics cannot change convergence or retry semantics.
    }
  }
}

/**
 * Starts only OmniCodex-owned hidden children and binds the MCP listener to
 * loopback. It never attaches to, signals, or reconfigures the desktop app.
 */
export function createBridgeThreadLifecycle(
  hostTools: Pick<CodexAppHostToolExecutor, "callRequiredNative">,
): OmniCodexBridgeThreadLifecycle {
  return {
    setTitle: async (threadId, title) => {
      await hostTools.callRequiredNative("codex_app__set_thread_title", { threadId, title });
    },
    setArchived: async (threadId, archived) => {
      // These Bridges belong to the local state database. Global host discovery
      // cannot resolve an old state-only row whose rollout no longer exists.
      await hostTools.callRequiredNative("codex_app__set_thread_archived", {
        threadId,
        archived,
        hostId: "local",
      });
    },
  };
}

export class OmniCodexGatewayService {
  get chatAccountRequests(): ChatAccountRequestCoordinator {
    return this.#chatAccountRequests;
  }
  readonly #chatAccountRequests = new ChatAccountRequestCoordinator({
    statePath: join(omniCodexDataDirectory(), "chat-account-cooldowns.json"),
    // User-directed reads and sends may run alongside Oracle recovery, but the
    // provider still accounts them against one ChatGPT account. Prevent an
    // idle queue from releasing a burst of native requests at once.
    spacingMs: 5_000,
    recoveryProbeGuardMs: 120_000,
  });
  readonly #options: OmniCodexGatewayServiceOptions;
  readonly #discovery: OmniCodexRuntimeDiscoverySource;
  readonly #engineBuildFollower: EngineBuildFollower;
  readonly #shutdownDrainTimeoutMs: number | undefined;
  readonly #shutdownPhaseTimeoutMs: number | undefined;
  readonly #startupReadinessMaxPasses: number | undefined;
  readonly #directScheduleManager: DirectScheduleManager | undefined;
  #schedulePollingRuntime: OmniCodexPreparedRuntime | undefined;
  #scheduleStopPromise: Promise<void> | undefined;
  #components: OmniCodexPreparedRuntime | undefined;
  #status: OmniCodexGatewayStatus = { lifecycle: "stopped" };
  #transition: Promise<OmniCodexGatewayStatus> | undefined;
  #runtimeTransition: Promise<OmniCodexGatewayStatus> | undefined;
  #stopPromise: Promise<OmniCodexGatewayStatus> | undefined;
  #lifecycleGeneration = 0;
  #shutdownRequested = false;
  readonly #ownedRuntimes = new Set<OmniCodexPreparedRuntime>();
  readonly #runtimePreparationAbortControllers = new Set<AbortController>();
  readonly #shutdownDrainStarted = new Set<OmniCodexPreparedRuntime>();
  readonly #pendingCleanupRuntimes = new Set<OmniCodexPreparedRuntime>();
  readonly #pendingCleanupOperations = new Set<() => Promise<void>>();
  readonly #runtimeChildStopOperations = new WeakMap<OmniCodexPreparedRuntime, Promise<void>>();

  constructor(options: OmniCodexGatewayServiceOptions) {
    if ((options.host ?? "127.0.0.1") !== "127.0.0.1") {
      throw new Error("OmniCodex must bind to 127.0.0.1; use an outbound tunnel for remote access");
    }
    this.#options = options;
    this.#startupReadinessMaxPasses = optionalPositiveSafeInteger(
      options.startupReadinessMaxPasses,
      "Startup readiness pass limit",
    );
    if (options.directScheduleStore !== undefined && options.directJobManager === undefined) {
      throw new Error("Direct schedules require the durable direct-job manager");
    }
    this.#directScheduleManager =
      options.directScheduleStore === undefined || options.directJobManager === undefined
        ? undefined
        : new DirectScheduleManager(options.directScheduleStore, options.directJobManager);
    const desktopEngine = new DesktopEngineBuildReader();
    this.#discovery =
      options.discovery ??
      new CodexRuntimeDiscovery({
        readDesktopExecutablePath: () => desktopEngine.readExecutablePath(),
      });
    this.#engineBuildFollower = new EngineBuildFollower({
      readDesktopExecutablePath: () => desktopEngine.readExecutablePath(),
      discover: (desktopPath) => this.#discovery.discover(desktopPath),
      activeCandidate: () =>
        this.#status.lifecycle === "ready" ? this.#components?.candidate : undefined,
      switchRuntime: (path) => this.switchRuntime(path),
      ...(process.platform === "win32"
        ? { refreshEngine: () => new DesktopEngineRefreshRunner().refresh() }
        : {}),
      onRefreshOutcome: (outcome) => {
        try {
          this.#options.onDiagnostic?.({
            method:
              outcome.status === "staged"
                ? "omnicodex/runtime/desktopEngineStaged"
                : "omnicodex/runtime/desktopEngineInstalled",
            params: {
              status: outcome.status,
              activeExecutablePath: outcome.activeExecutablePath,
              restartRequired: outcome.restartRequired === true,
            },
          });
        } catch {
          // A diagnostic observer cannot change runtime ownership.
        }
      },
      onError: (error) => {
        try {
          this.#options.onDiagnostic?.({
            method: "omnicodex/runtime/desktopBuildFollowFailed",
            params: { message: error.message },
          });
        } catch {
          // A diagnostic observer cannot change runtime ownership.
        }
      },
    });
    this.#shutdownDrainTimeoutMs = optionalPositiveSafeInteger(
      options.shutdownDrainTimeoutMs,
      "Shutdown drain timeout",
    );
    this.#shutdownPhaseTimeoutMs = optionalPositiveSafeInteger(
      options.shutdownPhaseTimeoutMs,
      "Shutdown phase timeout",
    );
  }

  get status(): OmniCodexGatewayStatus {
    return this.#status;
  }

  compareDesktopNativeRequestIds(candidates: readonly unknown[]): NativeRequestIdentityComparison {
    return (
      this.#components?.gateway.compareNativeRequestIds?.(candidates) ??
      compareNativeRequestIdentities([], candidates)
    );
  }

  async readChromeUserTabs(): Promise<unknown> {
    const runtime = this.#components;
    if (runtime === undefined) {
      throw new Error("OmniCodex runtime is not ready for Chrome user-tab discovery");
    }
    // Catalog convergence can temporarily publish `starting` while the exact
    // runtime generation and its first-party Chrome executor remain live. The
    // approval path must use that owned component instead of converting an
    // unrelated catalog refresh into a false browser outage.
    return runtime.readChromeUserTabs();
  }

  async readChatGptConversationStatus(
    conversationId: string,
    timeoutMs = INTERACTIVE_CLIENT_PROBE_LIVENESS_MS,
  ): Promise<"active" | "idle"> {
    const runtime = this.#components;
    if (runtime === undefined) throw new Error("OmniCodex runtime is not ready for task activity");
    const id = conversationId.trim().toLocaleLowerCase("en-US");
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error("CHATGPT_CONVERSATION_ID_INVALID");
    const boundedTimeoutMs = optionalPositiveSafeInteger(
      timeoutMs,
      "Task activity timeout",
    ) as number;
    const readConversation = runtime.readInteractiveConversationActivity;
    const activity = await resolveChatGptConversationActivity(
      await runtime.readInteractiveThreadActivity(boundedTimeoutMs),
      [id],
      readConversation === undefined
        ? undefined
        : (targetId) => readConversation.call(runtime, targetId, boundedTimeoutMs),
    );
    const root =
      isObject(activity) && isObject(activity.structuredContent)
        ? activity.structuredContent
        : activity;
    if (!isObject(root) || !Array.isArray(root.pinnedThreads) || !Array.isArray(root.threads))
      throw new Error(`LIVE_CODEX_APP_THREAD_ACTIVITY_UNAVAILABLE: exact read failed for ${id}`);
    const match = [...root.pinnedThreads, ...root.threads].find(
      (item) =>
        isObject(item) &&
        item.kind === "chatgpt" &&
        typeof item.id === "string" &&
        item.id.trim().toLocaleLowerCase("en-US") === id,
    );
    if (!isObject(match) || (match.status !== "active" && match.status !== "idle"))
      throw new Error(`LIVE_CODEX_APP_THREAD_ACTIVITY_UNAVAILABLE: exact status missing for ${id}`);
    return match.status;
  }

  async approveChromeFileMaterialization(chatGptConversationUrl: string): Promise<unknown> {
    const runtime = this.#components;
    if (runtime?.approveChromeFileMaterialization === undefined) {
      throw new Error("OmniCodex runtime is not ready for Chrome approval dispatch");
    }
    return runtime.approveChromeFileMaterialization(chatGptConversationUrl);
  }

  async synchronizeApprovedChromeConversation(
    target: ApprovedConversationSyncTarget,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const runtime = this.#components;
    if (runtime?.synchronizeApprovedChromeConversation === undefined) {
      throw new Error("OmniCodex runtime is not ready for Chrome approval synchronization");
    }
    return runtime.synchronizeApprovedChromeConversation(target, signal);
  }

  async continueChromeGoal(
    target: ChromeGoalContinuationTarget,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const runtime = this.#components;
    if (runtime?.continueChromeGoal === undefined)
      throw new Error("OmniCodex runtime is not ready for Goal continuation");
    return runtime.continueChromeGoal(target, signal);
  }

  async inspectDesktopChatEvents(): Promise<DesktopChatEventObservationStatus> {
    const runtime = this.#components;
    if (!runtime?.inspectDesktopChatEvents) throw new Error("DESKTOP_CHAT_RUNTIME_NOT_READY");
    return runtime.inspectDesktopChatEvents();
  }

  async readDesktopChatScope(
    signal: AbortSignal,
  ): Promise<{ accountSourceId: string; connectorIds: readonly string[] }> {
    if (!this.#components?.readDesktopChatScope) throw new Error("DESKTOP_CHAT_RUNTIME_NOT_READY");
    return this.#components.readDesktopChatScope(signal);
  }

  async verifyDesktopCompletion(
    candidate: DesktopChatCompletionCandidate,
    signal: AbortSignal,
  ): Promise<DesktopChatCompletionVerification> {
    if (!this.#components?.verifyDesktopCompletion)
      throw new Error("DESKTOP_CHAT_RUNTIME_NOT_READY");
    return this.#components.verifyDesktopCompletion(candidate, signal);
  }

  async readDesktopCompletion(
    conversationUrl: string,
    anchor: string | undefined,
    signal: AbortSignal,
  ): Promise<DesktopChatCompletionVerification> {
    if (!this.#components?.readDesktopCompletion) throw new Error("DESKTOP_CHAT_RUNTIME_NOT_READY");
    return this.#components.readDesktopCompletion(conversationUrl, anchor, signal);
  }

  async continueDesktopGoal(
    target: ChromeGoalContinuationTarget,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const runtime = this.#components;
    if (runtime?.continueDesktopGoal === undefined) return { outcome: "runtime_not_ready" };
    return runtime.continueDesktopGoal(target, signal);
  }

  async #startSchedulePolling(runtime: OmniCodexPreparedRuntime): Promise<void> {
    const manager = this.#directScheduleManager;
    if (manager === undefined) return;
    if (this.#schedulePollingRuntime === runtime) return;
    await this.#stopSchedulePolling();
    const adapter = runtime.directJobDispatchAdapter;
    if (adapter === undefined) {
      throw new Error("Runtime-owned exact-native schedule dispatcher is unavailable");
    }
    manager.startPolling(adapter);
    this.#schedulePollingRuntime = runtime;
  }

  #stopSchedulePolling(drainTimeoutMs = this.#shutdownDrainTimeoutMs): Promise<void> {
    const manager = this.#directScheduleManager;
    if (manager === undefined) return Promise.resolve();
    if (this.#scheduleStopPromise !== undefined) return this.#scheduleStopPromise;
    if (this.#schedulePollingRuntime === undefined) return Promise.resolve();
    this.#schedulePollingRuntime = undefined;
    let operation!: Promise<void>;
    const fenceTimeoutMs = minimumDefined(drainTimeoutMs, this.#shutdownPhaseTimeoutMs);
    operation = manager
      .shutdown({
        ...(drainTimeoutMs === undefined ? {} : { drainTimeoutMs }),
        ...(fenceTimeoutMs === undefined ? {} : { fenceTimeoutMs }),
      })
      .finally(() => {
        if (this.#scheduleStopPromise === operation) this.#scheduleStopPromise = undefined;
      });
    this.#scheduleStopPromise = operation;
    return operation;
  }

  async start(): Promise<OmniCodexGatewayStatus> {
    this.#assertServiceActive();
    if (this.#components !== undefined) {
      return this.#status;
    }
    if (this.#transition !== undefined) {
      return this.#transition;
    }
    this.#engineBuildFollower.start();
    const generation = this.#lifecycleGeneration;
    this.#transition = this.#start(generation);
    try {
      return await this.#transition;
    } finally {
      this.#transition = undefined;
    }
  }

  stop(timeoutMs?: number): Promise<OmniCodexGatewayStatus> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    const operatorTimeoutMs = optionalPositiveSafeInteger(timeoutMs, "Gateway shutdown timeout");
    const drainTimeoutMs = minimumDefined(operatorTimeoutMs, this.#shutdownDrainTimeoutMs);
    const phaseTimeoutMs = minimumDefined(operatorTimeoutMs, this.#shutdownPhaseTimeoutMs);
    // This is intentionally synchronous. A start/switch that resumes from an
    // await after this line can clean its own exact-owned resources, but it can
    // no longer publish or reopen admission.
    this.#shutdownRequested = true;
    this.#engineBuildFollower.stop();
    const stopGeneration = ++this.#lifecycleGeneration;
    for (const controller of this.#runtimePreparationAbortControllers) {
      controller.abort(new Error("OmniCodex runtime preparation cancelled by shutdown"));
    }
    const scheduleStop = this.#stopSchedulePolling(drainTimeoutMs);
    this.#beginDrainForKnownRuntimes();
    let operation!: Promise<OmniCodexGatewayStatus>;
    operation = this.#stop(stopGeneration, scheduleStop, drainTimeoutMs, phaseTimeoutMs).finally(
      () => {
        if (this.#stopPromise === operation && this.#status.lifecycle === "failed") {
          // A second exact stop may retry retained owned handles before the
          // daemon reaches its final bounded-exit barrier.
          this.#stopPromise = undefined;
        }
      },
    );
    this.#stopPromise = operation;
    return operation;
  }

  async #stop(
    stopGeneration: number,
    scheduleStop: Promise<void>,
    drainTimeoutMs: number | undefined,
    phaseTimeoutMs: number | undefined,
  ): Promise<OmniCodexGatewayStatus> {
    const errors: Error[] = [];
    await captureStopError(errors, () =>
      this.#setStatus({ ...this.#status, lifecycle: "stopping" }, stopGeneration),
    );
    await captureStopError(errors, () =>
      this.#shutdownStep("exact-native-schedules", async () => {
        const scheduleDrain = await settleBefore(scheduleStop, phaseTimeoutMs);
        if (!scheduleDrain.settled) {
          throw new Error("Exact-native schedule drain did not finish before shutdown deadline");
        }
      }),
    );

    const firstTransitionWait = await this.#shutdownStep("runtime-transitions", () =>
      settleBefore(Promise.allSettled(this.#activeTransitionPromises()), phaseTimeoutMs),
    );
    if (!firstTransitionWait.settled) {
      try {
        this.#options.onDiagnostic?.({
          method: "omnicodex/shutdown/transitionStillQuiescing",
          params: { deadlineMs: phaseTimeoutMs ?? null },
        });
      } catch {
        // Diagnostics never change shutdown ownership or retry semantics.
      }
    }

    await this.#drainAndStopOwnedRuntimeSnapshot(errors, drainTimeoutMs, phaseTimeoutMs);
    await this.#runPendingCleanupSnapshot(errors, phaseTimeoutMs);

    // A preparation that was already inside an await when stop was requested
    // may only reveal its owned runtime after the first snapshot. The
    // generation fence prevents publication; when the operator supplied a
    // deadline, this second barrier gives it one final chance to hand that
    // exact handle to cleanup without weakening the publication fence.
    if (!firstTransitionWait.settled) {
      const finalTransitionWait = await settleBefore(
        Promise.allSettled(this.#activeTransitionPromises()),
        phaseTimeoutMs,
      );
      if (!finalTransitionWait.settled) {
        errors.push(
          new Error("Owned runtime transition remained active after the final shutdown deadline"),
        );
      }
      await this.#drainAndStopOwnedRuntimeSnapshot(errors, drainTimeoutMs, phaseTimeoutMs);
      await this.#runPendingCleanupSnapshot(errors, phaseTimeoutMs);
    }

    if (
      this.#ownedRuntimes.size > 0 ||
      this.#pendingCleanupRuntimes.size > 0 ||
      this.#pendingCleanupOperations.size > 0
    ) {
      errors.push(new Error("Exact-owned runtime cleanup remains pending after shutdown"));
    }

    if (errors.length === 0) {
      this.#components = undefined;
      try {
        await this.#setStatus({ lifecycle: "stopped" }, stopGeneration);
        return this.#status;
      } catch (error) {
        errors.push(toError(error));
      }
    }

    let failure = new AggregateError(errors, "OmniCodex gateway did not stop cleanly");
    try {
      await this.#setStatus(
        { ...this.#status, lifecycle: "failed", lastError: errorSummary(failure) },
        stopGeneration,
      );
    } catch (error) {
      errors.push(toError(error));
      failure = new AggregateError(errors, "OmniCodex gateway did not stop cleanly");
    }
    throw failure;
  }

  #activeTransitionPromises(): readonly Promise<OmniCodexGatewayStatus>[] {
    return [...new Set([this.#transition, this.#runtimeTransition].filter(isDefined))];
  }

  #knownOwnedRuntimes(): readonly OmniCodexPreparedRuntime[] {
    return [
      ...new Set([
        ...(this.#components === undefined ? [] : [this.#components]),
        ...this.#ownedRuntimes,
        ...this.#pendingCleanupRuntimes,
      ]),
    ];
  }

  #beginDrainForKnownRuntimes(): void {
    for (const runtime of this.#knownOwnedRuntimes()) {
      if (this.#shutdownDrainStarted.has(runtime)) continue;
      try {
        runtime.gateway.beginDrain();
        this.#shutdownDrainStarted.add(runtime);
      } catch (error) {
        try {
          this.#options.onDiagnostic?.({
            method: "omnicodex/shutdown/admissionCloseFailed",
            params: { message: errorSummary(error) },
          });
        } catch {
          // Diagnostics never change shutdown ownership or retry semantics.
        }
      }
    }
  }

  async #drainAndStopOwnedRuntimeSnapshot(
    errors: Error[],
    drainTimeoutMs = this.#shutdownDrainTimeoutMs,
    phaseTimeoutMs = this.#shutdownPhaseTimeoutMs,
  ): Promise<void> {
    const runtimes = this.#knownOwnedRuntimes();
    if (runtimes.length === 0) return;
    for (const runtime of runtimes) {
      if (this.#shutdownDrainStarted.has(runtime)) continue;
      try {
        runtime.gateway.beginDrain();
        this.#shutdownDrainStarted.add(runtime);
      } catch (error) {
        errors.push(
          new Error(`Owned runtime admission close failed: ${errorSummary(error)}`, {
            cause: toError(error),
          }),
        );
      }
    }
    const drainResults = await Promise.allSettled(
      runtimes.map(async (runtime) => {
        await this.#shutdownStep("admitted-mcp-requests", () =>
          awaitRuntimeDrained(runtime.gateway, drainTimeoutMs),
        );
        return runtime;
      }),
    );
    const drainedRuntimes: OmniCodexPreparedRuntime[] = [];
    for (const result of drainResults) {
      if (result.status === "rejected") errors.push(toError(result.reason));
      else drainedRuntimes.push(result.value);
    }

    // Never retire a runtime that still owns an admitted request. With an
    // explicit deadline, stop() reports failure and retains the exact runtime;
    // its late completion can settle authoritatively and a later stop() retries
    // cleanup. Without a deadline this waits until every admitted request ends.
    const stopResults = await Promise.allSettled(
      drainedRuntimes.map((runtime) => this.#stopPreparedRuntime(runtime, phaseTimeoutMs)),
    );
    for (const result of stopResults) {
      if (result.status === "rejected") errors.push(toError(result.reason));
    }
  }

  async #runPendingCleanupSnapshot(
    errors: Error[],
    phaseTimeoutMs = this.#shutdownPhaseTimeoutMs,
  ): Promise<void> {
    const cleanups = [...this.#pendingCleanupOperations];
    const results = await Promise.allSettled(
      cleanups.map(async (cleanup) => {
        const outcome = await settleBefore(cleanup(), phaseTimeoutMs);
        if (!outcome.settled) throw new Error("Owned partial-runtime cleanup timed out");
        this.#pendingCleanupOperations.delete(cleanup);
      }),
    );
    for (const result of results) {
      if (result.status === "rejected") errors.push(toError(result.reason));
    }
  }

  async recoverRuntime(drainTimeoutMs?: number): Promise<OmniCodexGatewayStatus> {
    this.#assertServiceActive();
    if (this.#transition !== undefined) await this.#transition.catch(() => undefined);
    this.#assertServiceActive();
    if (this.#runtimeTransition !== undefined) return this.#runtimeTransition;
    const requestedDrainTimeoutMs = optionalPositiveSafeInteger(
      drainTimeoutMs,
      "Runtime recovery drain timeout",
    );
    const generation = this.#lifecycleGeneration;
    this.#runtimeTransition = this.#recoverRuntime(requestedDrainTimeoutMs, generation);
    try {
      return await this.#runtimeTransition;
    } finally {
      this.#runtimeTransition = undefined;
    }
  }

  beginDrain(): StreamableHttpGatewayRuntimeStatus {
    return this.#runningGateway().beginDrain();
  }

  /**
   * A planned restart must not cut a Web model turn merely because it is
   * currently thinking between two finite MCP requests. Keep admission open
   * while a conversation that actually used this runtime remains active, then
   * close admission and verify the state once more. A racing active turn
   * reopens admission and repeats instead of being stranded.
   */
  async beginDrainWhenInteractiveIdle(
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<StreamableHttpGatewayRuntimeStatus> {
    signal?.throwIfAborted();
    const runtime = this.#runningRuntime();
    const requestedTimeoutMs = optionalPositiveSafeInteger(timeoutMs, "Interactive drain timeout");
    const deadline = requestedTimeoutMs === undefined ? undefined : Date.now() + requestedTimeoutMs;
    return this.#beginDrainWhenInteractiveIdle(runtime, deadline, signal);
  }

  async awaitDrained(timeoutMs?: number): Promise<StreamableHttpGatewayRuntimeStatus> {
    const gateway = this.#runningGateway();
    await awaitRuntimeDrained(
      gateway,
      optionalPositiveSafeInteger(timeoutMs, "Runtime drain timeout"),
    );
    return gateway.runtimeStatus;
  }

  resumeAdmission(): StreamableHttpGatewayRuntimeStatus {
    return this.#runningGateway().resumeAdmission();
  }

  async readFullCatalogSnapshot(): Promise<OmniCodexFullCatalogSnapshot> {
    const gateway = this.#runningGateway();
    if (gateway.readFullCatalogSnapshot === undefined) {
      throw new Error("LIVE_LOCAL_CATALOG_SOURCE_UNAVAILABLE");
    }
    return gateway.readFullCatalogSnapshot();
  }

  async readThreadInventory(): Promise<OmniCodexThreadInventorySnapshot> {
    const runtime = this.#runningRuntime();
    const inventory = await runtime.readThreadInventory();
    return {
      ...inventory,
      canonicalBridgeThreadId: runtime.bridgeThreadId,
    };
  }

  async #beginDrainWhenInteractiveIdle(
    runtime: OmniCodexPreparedRuntime,
    deadlineUnixMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<StreamableHttpGatewayRuntimeStatus> {
    const probe = this.#options.createInteractiveActivityProbe?.();
    while (true) {
      signal?.throwIfAborted();
      await this.#awaitInteractiveClientsIdle(runtime, deadlineUnixMs, probe, signal);
      const draining = runtime.gateway.beginDrain();
      try {
        const activity = await this.#interactiveClientStatus(
          runtime,
          deadlineUnixMs,
          probe,
          signal,
          false,
        );
        if (activity.nextScanAtUnixMs !== undefined) {
          runtime.gateway.resumeAdmission();
          const waitMs = Math.max(1, activity.nextScanAtUnixMs - Date.now());
          await delayWithSignal(
            deadlineUnixMs === undefined
              ? waitMs
              : Math.min(waitMs, Math.max(1, deadlineUnixMs - Date.now())),
            signal,
          );
          assertInteractiveDrainDeadline(deadlineUnixMs, activity.activeConversationIds);
          continue;
        }
        if (activity.activeConversationIds.length === 0) return draining;
      } catch (error) {
        if (runtime.gateway.runtimeStatus.admission === "draining") {
          runtime.gateway.resumeAdmission();
        }
        throw error;
      }
      if (runtime.gateway.runtimeStatus.admission === "draining") {
        runtime.gateway.resumeAdmission();
      }
      assertInteractiveDrainDeadline(deadlineUnixMs, []);
    }
  }

  async #awaitInteractiveClientsIdle(
    runtime: OmniCodexPreparedRuntime,
    deadlineUnixMs: number | undefined,
    probe?: ReturnType<
      NonNullable<OmniCodexGatewayServiceOptions["createInteractiveActivityProbe"]>
    >,
    signal?: AbortSignal,
  ): Promise<OmniCodexInteractiveClientStatus> {
    let consecutiveIdleObservations = 0;
    while (true) {
      signal?.throwIfAborted();
      const activity = await this.#interactiveClientStatus(runtime, deadlineUnixMs, probe, signal);
      if (
        activity.observedConversationIds.length === 0 &&
        activity.observedOpaqueWorkSessions === 0
      ) {
        return activity;
      }
      if (activity.activeConversationIds.length === 0) consecutiveIdleObservations += 1;
      else consecutiveIdleObservations = 0;
      if (consecutiveIdleObservations >= 2) return activity;
      assertInteractiveDrainDeadline(deadlineUnixMs, activity.activeConversationIds);
      const delayMs =
        deadlineUnixMs === undefined
          ? INTERACTIVE_CLIENT_IDLE_POLL_MS
          : Math.min(INTERACTIVE_CLIENT_IDLE_POLL_MS, Math.max(1, deadlineUnixMs - Date.now()));
      await delayWithSignal(delayMs, signal);
    }
  }

  async #interactiveClientStatus(
    runtime: OmniCodexPreparedRuntime,
    deadlineUnixMs: number | undefined,
    probe?: ReturnType<
      NonNullable<OmniCodexGatewayServiceOptions["createInteractiveActivityProbe"]>
    >,
    callerSignal?: AbortSignal,
    waitForProviderPacing = true,
  ): Promise<OmniCodexInteractiveClientStatus> {
    const exactConversationIds = [
      ...new Set(
        runtime.gateway
          .observedChatGptConversationIds()
          .map((id) => id.trim().toLocaleLowerCase("en-US"))
          .filter((id) => id.length > 0),
      ),
    ];
    const opaqueWorkSessionCount = runtime.gateway.observedOpenAiWorkSessionCount?.() ?? 0;
    let additional: OmniCodexAdditionalInteractiveActivity | undefined;
    if (probe !== undefined) {
      while (true) {
        callerSignal?.throwIfAborted();
        assertInteractiveDrainDeadline(deadlineUnixMs, []);
        // One probe may read several accounts and conversations. Each transport
        // retains its own liveness checks; the complete pass follows the caller.
        const deadlineSignal =
          deadlineUnixMs === undefined
            ? new AbortController().signal
            : AbortSignal.timeout(Math.max(1, deadlineUnixMs - Date.now()));
        const signal =
          callerSignal === undefined
            ? deadlineSignal
            : AbortSignal.any([callerSignal, deadlineSignal]);
        additional = await probe(signal, exactConversationIds);
        assertInteractiveDrainDeadline(deadlineUnixMs, additional.activeConversationIds);
        if (additional.nextScanAtUnixMs === undefined) break;
        if (!waitForProviderPacing) break;
        // Provider pacing is part of this bounded restart wait, not a new poller.
        const waitMs = Math.max(1, additional.nextScanAtUnixMs - Date.now());
        await delayWithSignal(
          deadlineUnixMs === undefined ? waitMs : Math.min(waitMs, deadlineUnixMs - Date.now()),
          callerSignal,
        );
      }
    }
    const activeIds = new Set<string>(additional?.activeConversationIds);
    const localConversationIds = exactConversationIds.filter(
      (id) => !additional?.observedConversationIds.includes(id),
    );
    if (localConversationIds.length > 0 || opaqueWorkSessionCount > 0) {
      assertInteractiveDrainDeadline(deadlineUnixMs, [...activeIds]);
      const remainingMs = Math.min(
        INTERACTIVE_CLIENT_PROBE_LIVENESS_MS,
        deadlineUnixMs === undefined
          ? INTERACTIVE_CLIENT_PROBE_LIVENESS_MS
          : Math.max(1, deadlineUnixMs - Date.now()),
      );
      const inventory = await runtime.readInteractiveThreadActivity(remainingMs);
      const readConversation = runtime.readInteractiveConversationActivity;
      const activity = await resolveChatGptConversationActivity(
        inventory,
        localConversationIds,
        readConversation === undefined
          ? undefined
          : (id) => {
              assertInteractiveDrainDeadline(deadlineUnixMs, [...activeIds]);
              return readConversation.call(
                runtime,
                id,
                deadlineUnixMs === undefined
                  ? INTERACTIVE_CLIENT_PROBE_LIVENESS_MS
                  : Math.min(
                      INTERACTIVE_CLIENT_PROBE_LIVENESS_MS,
                      Math.max(1, deadlineUnixMs - Date.now()),
                    ),
              );
            },
      );
      for (const id of activeChatGptConversationIds(activity, localConversationIds)) {
        // Exact conversation metadata lets us protect only the Web task that
        // used this runtime. For opaque OpenAI sessions, Codex Desktop's own
        // task inventory is the non-invasive authority: protect every active
        // ChatGPT task instead of attaching to or claiming any Chrome tab.
        if (opaqueWorkSessionCount > 0 || localConversationIds.includes(id)) activeIds.add(id);
      }
    }
    const observedConversationIds = [
      ...new Set([
        ...exactConversationIds,
        ...(additional?.observedConversationIds ?? []),
        ...activeIds,
      ]),
    ];
    return {
      observedConversationIds,
      activeConversationIds: observedConversationIds.filter((id) => activeIds.has(id)),
      observedOpaqueWorkSessions: opaqueWorkSessionCount,
      ...(additional?.nextScanAtUnixMs === undefined
        ? {}
        : { nextScanAtUnixMs: additional.nextScanAtUnixMs }),
    };
  }

  async switchRuntime(
    targetCanonicalPath: string,
    drainTimeoutMs?: number,
  ): Promise<OmniCodexGatewayStatus> {
    this.#assertServiceActive();
    if (this.#transition !== undefined) await this.#transition;
    this.#assertServiceActive();
    if (this.#runtimeTransition !== undefined) return this.#runtimeTransition;
    const requestedDrainTimeoutMs = optionalPositiveSafeInteger(
      drainTimeoutMs,
      "Runtime drain timeout",
    );
    const generation = this.#lifecycleGeneration;
    this.#runtimeTransition = this.#switchRuntime(
      targetCanonicalPath,
      requestedDrainTimeoutMs,
      generation,
    );
    try {
      return await this.#runtimeTransition;
    } finally {
      this.#runtimeTransition = undefined;
    }
  }

  #runningRuntime(): OmniCodexPreparedRuntime {
    if (
      this.#components === undefined ||
      (this.#status.lifecycle !== "ready" &&
        this.#status.lifecycle !== "converging" &&
        this.#status.lifecycle !== "retiring_previous" &&
        this.#status.lifecycle !== "cleanup_pending")
    ) {
      throw new Error("OmniCodex gateway is not ready");
    }
    return this.#components;
  }

  #runningGateway(): OmniCodexRuntimeGateway {
    return this.#runningRuntime().gateway;
  }

  async #switchRuntime(
    targetCanonicalPath: string,
    drainTimeoutMs: number | undefined,
    generation: number,
  ): Promise<OmniCodexGatewayStatus> {
    this.#assertTransitionActive(generation);
    const current = this.#components;
    if (current === undefined || this.#status.lifecycle !== "ready") {
      throw new Error("OmniCodex gateway is not ready for a runtime switch");
    }
    const targetPath = resolve(targetCanonicalPath);
    if (resolve(current.candidate.canonicalPath) === targetPath) {
      throw new Error("Selected Codex runtime is already active");
    }
    const report = await this.#discovery.discover();
    this.#assertTransitionActive(generation);
    const candidate = report.candidates.find(
      (item) =>
        resolve(item.canonicalPath).toLocaleLowerCase("en-US") ===
        targetPath.toLocaleLowerCase("en-US"),
    );
    if (candidate === undefined) {
      throw new Error("Selected Codex runtime is not an installed discovery candidate");
    }
    const boundaryBaseline = await this.#options.nonInterferenceBoundary?.capture();
    this.#assertTransitionActive(generation);
    await this.#setStatus({ ...this.#status, lifecycle: "shadow_starting" }, generation);
    this.#assertTransitionActive(generation);
    let shadow: OmniCodexPreparedRuntime | undefined;
    let shadowAddress: StreamableHttpGatewayAddress | undefined;
    let currentGatewayStopped = false;
    let candidateCommitted = false;
    let previousRuntimeRetired = false;
    let bridgePromotionAttempted = false;
    try {
      shadow = await this.#prepareRuntime(candidate, {
        deferBridgeReconciliation: true,
        initialBridge: {
          threadId: current.bridgeThreadId,
          registryDigest: current.bridgeRegistryDigest,
          disposition: current.bridgeDisposition,
        },
      });
      this.#ownedRuntimes.add(shadow);
      this.#assertTransitionActive(generation);
      await shadow.directProbe();
      this.#assertTransitionActive(generation);
      await this.#verifyBoundary(boundaryBaseline);
      this.#assertTransitionActive(generation);
      const drainDeadlineUnixMs =
        drainTimeoutMs === undefined ? undefined : Date.now() + drainTimeoutMs;
      await this.#beginDrainWhenInteractiveIdle(current, drainDeadlineUnixMs);
      this.#assertTransitionActive(generation);
      await this.#setStatus({ ...this.#status, lifecycle: "draining" }, generation);
      this.#assertTransitionActive(generation);
      await this.#stopSchedulePolling(drainTimeoutMs);
      this.#assertTransitionActive(generation);
      const remainingDrainTimeoutMs =
        drainDeadlineUnixMs === undefined
          ? undefined
          : Math.max(1, drainDeadlineUnixMs - Date.now());
      await awaitRuntimeDrained(current.gateway, remainingDrainTimeoutMs);
      this.#assertTransitionActive(generation);
      await this.#setStatus({ ...this.#status, lifecycle: "switching" }, generation);
      this.#assertTransitionActive(generation);
      try {
        const remainingStopTimeoutMs =
          drainDeadlineUnixMs === undefined
            ? undefined
            : Math.max(1, drainDeadlineUnixMs - Date.now());
        const stopped = await settleBefore(
          current.gateway.stop(remainingStopTimeoutMs),
          remainingStopTimeoutMs,
        );
        if (!stopped.settled) {
          throw new Error(
            `Current runtime gateway stop exceeded its ${String(remainingStopTimeoutMs)}ms deadline`,
          );
        }
        currentGatewayStopped = true;
      } catch (error) {
        currentGatewayStopped = gatewayListenerStopped(current.gateway);
        throw error;
      }
      this.#assertTransitionActive(generation);
      const address = await shadow.gateway.start();
      shadowAddress = address;
      this.#assertTransitionActive(generation);
      await this.#verifyBoundary(boundaryBaseline);
      this.#assertTransitionActive(generation);
      await this.#startSchedulePolling(shadow);
      this.#assertTransitionActive(generation);
      this.#components = shadow;
      await this.#setStatus(
        { ...this.#readyStatus(shadow, address), lifecycle: "observing" },
        generation,
      );
      this.#assertTransitionActive(generation);
      await this.#observeRuntime(shadow, address, this.#options.runtimeObservationMs ?? 600_000);
      this.#assertTransitionActive(generation);
      await this.#verifyBoundary(boundaryBaseline);
      this.#assertTransitionActive(generation);
      // Shadow validation is intentionally Bridge-read-only. Only after the
      // candidate listener and non-interference observation have succeeded may
      // its registry become canonical. The returned state is an authoritative
      // reconcile readback, not the shadow's cached readiness bit.
      bridgePromotionAttempted = true;
      await this.#promoteRuntimeBridge(shadow);
      this.#assertTransitionActive(generation);
      // Observation plus the final non-interference readback is the commit
      // point. The previous runtime is no longer rollback-capable once its
      // children begin retiring, so no later failure may tear down `shadow`.
      candidateCommitted = true;
      this.#startConvergenceMonitor(shadow, address, generation);
      await this.#setStatus(
        {
          ...this.#readyStatus(shadow, address),
          lifecycle: "retiring_previous",
        },
        generation,
      );
      this.#assertTransitionActive(generation);
      await this.#retirePreviousRuntime(current);
      previousRuntimeRetired = true;
      this.#assertTransitionActive(generation);
      await this.#setStatus(this.#readyStatus(shadow, address), generation);
      return this.#status;
    } catch (error) {
      const originalError = toError(error);
      if (!this.#isTransitionActive(generation)) {
        if (shadow !== undefined) this.#pendingCleanupRuntimes.add(shadow);
        throw new RuntimeTransitionInvalidatedError(originalError);
      }
      if (candidateCommitted && shadow !== undefined && shadowAddress !== undefined) {
        this.#components = shadow;
        if (!previousRuntimeRetired) this.#pendingCleanupRuntimes.add(current);
        const failure = new CommittedRuntimeSwitchFailure(
          previousRuntimeRetired
            ? "ready status publication failed"
            : "previous runtime cleanup failed",
          originalError,
        );
        await this.#setStatus(
          {
            ...this.#readyStatus(shadow, shadowAddress),
            lifecycle: "cleanup_pending",
            lastError: failure.message,
          },
          generation,
        ).catch(() => undefined);
        throw failure;
      }
      const cleanupErrors: Error[] = [];
      if (error instanceof OwnedRuntimeCleanupFailure) {
        this.#pendingCleanupOperations.add(error.retryCleanup);
        cleanupErrors.push(error);
      }
      if (shadow !== undefined) {
        try {
          await this.#stopPreparedRuntime(shadow, drainTimeoutMs);
        } catch (cleanupError) {
          cleanupErrors.push(toError(cleanupError));
          this.#pendingCleanupRuntimes.add(shadow);
        }
      }
      if (currentGatewayStopped) {
        try {
          await this.#setStatus({ ...this.#status, lifecycle: "rolling_back" }, generation);
          this.#assertTransitionActive(generation);
          const restoredAddress = await current.gateway.start();
          this.#assertTransitionActive(generation);
          await current.directProbe();
          this.#assertTransitionActive(generation);
          if (bridgePromotionAttempted) {
            await this.#promoteRuntimeBridge(current);
            this.#assertTransitionActive(generation);
          }
          await this.#startSchedulePolling(current);
          this.#assertTransitionActive(generation);
          current.gateway.resumeAdmission();
          this.#components = current;
          if (cleanupErrors.length === 0) {
            await this.#setStatus(this.#readyStatus(current, restoredAddress), generation);
          }
        } catch (rollbackError) {
          cleanupErrors.push(
            new Error(`Previous runtime rollback failed: ${errorSummary(rollbackError)}`, {
              cause: toError(rollbackError),
            }),
          );
        }
      } else {
        this.#assertTransitionActive(generation);
        await this.#startSchedulePolling(current);
        this.#assertTransitionActive(generation);
        current.gateway.resumeAdmission();
        this.#components = current;
        const address = this.#status.address;
        if (address !== undefined && cleanupErrors.length === 0) {
          await this.#setStatus(this.#readyStatus(current, address), generation);
        }
      }
      if (cleanupErrors.length > 0) {
        const failure = new AggregateError(
          [originalError, ...cleanupErrors],
          "Runtime switch failed and an owned shadow runtime did not stop cleanly",
        );
        await this.#setStatus(
          { ...this.#status, lifecycle: "failed", lastError: failure.message },
          generation,
        );
        throw failure;
      }
      throw originalError;
    }
  }

  async #retirePreviousRuntime(runtime: OmniCodexPreparedRuntime): Promise<void> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const outcome = await settleBefore(
          this.#stopRuntimeChildren(runtime),
          this.#shutdownPhaseTimeoutMs,
        );
        if (!outcome.settled) {
          lastError = new Error(
            `Previous runtime child cleanup exceeded its ${String(this.#shutdownPhaseTimeoutMs)}ms deadline`,
          );
          this.#pendingCleanupRuntimes.add(runtime);
          throw lastError;
        }
        this.#pendingCleanupRuntimes.delete(runtime);
        this.#ownedRuntimes.delete(runtime);
        return;
      } catch (error) {
        lastError = toError(error);
        this.#options.onDiagnostic?.({
          method: "omnicodex/runtime/previousRuntimeCleanupRetry",
          params: {
            attempt,
            message: errorSummary(lastError),
          },
        });
        if (this.#runtimeChildStopOperations.has(runtime)) break;
        if (attempt < 3) await delay(50 * attempt);
      }
    }
    this.#pendingCleanupRuntimes.add(runtime);
    throw new Error(
      `Previous owned runtime cleanup failed after 3 attempts: ${errorSummary(lastError)}`,
      { cause: lastError },
    );
  }

  async #recoverRuntime(
    drainTimeoutMs: number | undefined,
    generation: number,
  ): Promise<OmniCodexGatewayStatus> {
    this.#assertTransitionActive(generation);
    const current = this.#components;
    if (current !== undefined) {
      await this.#setStatus({ ...this.#status, lifecycle: "recovering" }, generation);
      this.#assertTransitionActive(generation);
      await this.#stopSchedulePolling(drainTimeoutMs);
      this.#assertTransitionActive(generation);
      current.gateway.beginDrain();
      try {
        await awaitRuntimeDrained(current.gateway, drainTimeoutMs);
      } catch (error) {
        // A recovery deadline is an operator deadline, not permission to kill
        // accepted native work. Restore the same runtime's admission and let
        // the still-owned completion settle before a later recovery attempt.
        const originalError = toError(error);
        try {
          await this.#startSchedulePolling(current);
          current.gateway.resumeAdmission();
          const address = this.#status.address;
          if (address !== undefined) {
            await this.#setStatus(this.#readyStatus(current, address), generation);
          }
        } catch (rollbackError) {
          throw new AggregateError(
            [originalError, toError(rollbackError)],
            "Runtime recovery deadline expired and admission restoration failed",
          );
        }
        throw originalError;
      }
      this.#assertTransitionActive(generation);
      try {
        await this.#stopPreparedRuntime(current, drainTimeoutMs);
      } catch (error) {
        this.#pendingCleanupRuntimes.add(current);
        const failure = toError(error);
        await this.#setStatus(
          { ...this.#status, lifecycle: "failed", lastError: failure.message },
          generation,
        );
        throw failure;
      }
      if (this.#components === current) this.#components = undefined;
    }
    this.#assertTransitionActive(generation);
    return this.#start(generation);
  }

  async #observeRuntime(
    runtime: OmniCodexPreparedRuntime,
    address: StreamableHttpGatewayAddress,
    durationMs: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 600_000) {
      throw new Error("Runtime observation must be between 0 and 600000 milliseconds");
    }
    if (this.#options.observeRuntime !== undefined) {
      await this.#options.observeRuntime(runtime, address, durationMs);
      return;
    }
    const deadline = Date.now() + durationMs;
    while (true) {
      await probeRuntimeEndpoint(address);
      if (Date.now() >= deadline) return;
      await delay(Math.min(10_000, deadline - Date.now()));
    }
  }

  async #start(generation: number): Promise<OmniCodexGatewayStatus> {
    this.#assertTransitionActive(generation);
    await this.#setStatus({ lifecycle: "starting" }, generation);
    this.#assertTransitionActive(generation);
    const report = await this.#discovery.discover();
    this.#assertTransitionActive(generation);
    let boundaryBaseline: CodexBoundarySnapshot | undefined;
    try {
      boundaryBaseline = await this.#options.nonInterferenceBoundary?.capture();
      this.#assertTransitionActive(generation);
    } catch (error) {
      const message = toError(error).message;
      await this.#setStatus({ lifecycle: "failed", lastError: message }, generation);
      throw error;
    }
    const failures: string[] = [];
    let candidatesForPass: readonly RuntimeCandidate[] = report.candidates;

    for (
      let startupPass = 1;
      (this.#startupReadinessMaxPasses === undefined ||
        startupPass <= this.#startupReadinessMaxPasses) &&
      candidatesForPass.length > 0;
      startupPass += 1
    ) {
      const retryableCandidates: RuntimeCandidate[] = [];
      for (const candidate of candidatesForPass) {
        let runtime: OmniCodexPreparedRuntime | undefined;
        try {
          runtime = await this.#prepareRuntime(candidate);
          this.#ownedRuntimes.add(runtime);
          this.#assertTransitionActive(generation);
          await runtime.directProbe();
          this.#assertTransitionActive(generation);
          await this.#verifyBoundary(boundaryBaseline);
          this.#assertTransitionActive(generation);
          const address = await runtime.gateway.start();
          this.#assertTransitionActive(generation);
          await this.#verifyBoundary(boundaryBaseline);
          this.#assertTransitionActive(generation);
          await this.#startSchedulePolling(runtime);
          this.#assertTransitionActive(generation);
          this.#components = runtime;
          await this.#setStatus(this.#readyStatus(runtime, address), generation);
          this.#assertTransitionActive(generation);
          this.#startConvergenceMonitor(runtime, address, generation);
          return this.#status;
        } catch (error) {
          const failure = toError(error);
          if (!this.#isTransitionActive(generation)) {
            if (runtime !== undefined) this.#pendingCleanupRuntimes.add(runtime);
            throw new RuntimeTransitionInvalidatedError(failure);
          }
          const passLabel =
            this.#startupReadinessMaxPasses === undefined
              ? String(startupPass)
              : `${startupPass}/${this.#startupReadinessMaxPasses}`;
          failures.push(
            `${candidate.canonicalPath} (startup pass ${passLabel}): ${errorSummary(failure)}`,
          );
          if (error instanceof OwnedRuntimeCleanupFailure) {
            this.#pendingCleanupOperations.add(error.retryCleanup);
            await this.#setStatus({ lifecycle: "failed", lastError: error.message }, generation);
            throw error;
          }
          if (runtime !== undefined) {
            try {
              await this.#stopPreparedRuntime(runtime);
            } catch (cleanupError) {
              this.#pendingCleanupRuntimes.add(runtime);
              const cleanupFailure = new AggregateError(
                [failure, toError(cleanupError)],
                "Runtime start failed and the owned candidate did not stop cleanly",
              );
              await this.#setStatus(
                {
                  lifecycle: "failed",
                  lastError: cleanupFailure.message,
                },
                generation,
              );
              throw cleanupFailure;
            }
          }
          try {
            await this.#verifyBoundary(boundaryBaseline);
          } catch (boundaryError) {
            const boundaryFailure = toError(boundaryError);
            await this.#setStatus(
              { lifecycle: "failed", lastError: boundaryFailure.message },
              generation,
            );
            throw boundaryFailure;
          }
          if (error instanceof CodexBoundaryViolation) {
            await this.#setStatus({ lifecycle: "failed", lastError: error.message }, generation);
            throw error;
          }
          const startupFailure = classifyRuntimeStartupFailure(failure);
          if (
            (this.#startupReadinessMaxPasses === undefined ||
              startupPass < this.#startupReadinessMaxPasses) &&
            (startupFailure.kind === "shared_desktop_readiness" ||
              startupFailure.kind === "transient_candidate_readiness")
          ) {
            retryableCandidates.push(candidate);
          }

          // The Desktop renderer's app-global pipe is shared by all CLI
          // candidates. Falling through to an older executable cannot repair
          // that endpoint and can silently pin OmniCodex to stale schemas.
          // Other transient readiness failures also retry the selected,
          // highest-priority candidate. An older runtime is considered only
          // when the failure proves a candidate-specific protocol mismatch.
          if (startupFailure.kind !== "candidate_local_incompatibility") {
            break;
          }
        }
      }

      if (retryableCandidates.length === 0) break;
      this.#diagnoseStartupReadinessRetry(startupPass + 1, retryableCandidates, failures);
      candidatesForPass = retryableCandidates;
      await delay(STARTUP_READINESS_RETRY_DELAY_MS);
      this.#assertTransitionActive(generation);
    }

    const message =
      failures.length > 0
        ? failures.join("; ")
        : `No installed Codex runtime was found${
            report.warnings.length === 0 ? "" : ` (${report.warnings.join("; ")})`
          }`;
    await this.#setStatus({ lifecycle: "failed", lastError: message }, generation);
    throw new Error(message);
  }

  #diagnoseStartupReadinessRetry(
    nextPass: number,
    candidates: readonly RuntimeCandidate[],
    failures: readonly string[],
  ): void {
    try {
      this.#options.onDiagnostic?.({
        method: "omnicodex/startupReadinessRetry",
        params: {
          nextPass,
          maximumPasses: this.#startupReadinessMaxPasses ?? null,
          candidatePaths: candidates.map((candidate) => candidate.canonicalPath),
          previousFailures: failures,
        },
      });
    } catch {
      // Diagnostics cannot alter startup recovery.
    }
  }

  async #setStatus(status: OmniCodexGatewayStatus, generation: number): Promise<void> {
    if (generation !== this.#lifecycleGeneration) return;
    this.#status = status;
    await this.#options.onStatusChange?.(status);
  }

  async #stopPreparedRuntime(
    runtime: OmniCodexPreparedRuntime,
    phaseTimeoutMs = this.#shutdownPhaseTimeoutMs,
  ): Promise<void> {
    const errors: Error[] = [];
    if (this.#schedulePollingRuntime === runtime) {
      await captureBoundedStopError(errors, "exact-native schedules", phaseTimeoutMs, () =>
        this.#stopSchedulePolling(phaseTimeoutMs),
      );
    }
    await captureBoundedStopError(errors, "gateway listener", phaseTimeoutMs, () =>
      this.#shutdownStep("gateway-listener", () => runtime.gateway.stop(phaseTimeoutMs)),
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "Owned Codex runtime did not stop cleanly");
    }
    await captureBoundedStopError(errors, "owned children", phaseTimeoutMs, () =>
      this.#stopRuntimeChildren(runtime),
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "Owned Codex runtime did not stop cleanly");
    }
    this.#pendingCleanupRuntimes.delete(runtime);
    this.#ownedRuntimes.delete(runtime);
  }

  #stopRuntimeChildren(runtime: OmniCodexPreparedRuntime): Promise<void> {
    const existing = this.#runtimeChildStopOperations.get(runtime);
    if (existing !== undefined) return existing;
    let operation!: Promise<void>;
    operation = Promise.resolve()
      .then(() => runtime.stopChildren())
      .finally(() => {
        if (this.#runtimeChildStopOperations.get(runtime) === operation) {
          this.#runtimeChildStopOperations.delete(runtime);
        }
      });
    this.#runtimeChildStopOperations.set(runtime, operation);
    return operation;
  }

  async #shutdownStep<T>(component: string, operation: () => Promise<T>): Promise<T> {
    const report = (state: string, failure?: unknown) => {
      try {
        this.#options.onDiagnostic?.({
          method: "omnicodex/shutdown/component",
          params: {
            component,
            state,
            ...(failure === undefined ? {} : { message: errorSummary(failure) }),
          },
        });
      } catch {
        /* Diagnostics cannot change shutdown settlement. */
      }
    };
    report("starting");
    try {
      const result = await operation();
      report("completed");
      return result;
    } catch (error) {
      report("failed", error);
      throw error;
    }
  }

  #startConvergenceMonitor(
    runtime: OmniCodexPreparedRuntime,
    address: StreamableHttpGatewayAddress,
    generation: number,
  ): void {
    runtime.startConvergenceMonitor?.(() => {
      if (!this.#isTransitionActive(generation)) return;
      if (this.#components !== runtime) return;
      if (this.#status.lifecycle !== "ready" && this.#status.lifecycle !== "converging") return;
      return this.#setStatus(this.#readyStatus(runtime, address), generation).catch((error) => {
        this.#options.onDiagnostic?.({
          method: "omnicodex/bridgeConvergenceStatusFailed",
          params: { message: toError(error).message },
        });
      });
    });
  }

  async #promoteRuntimeBridge(runtime: OmniCodexPreparedRuntime): Promise<void> {
    const snapshot = await runtime.promoteBridge();
    if (!snapshot.bridgeRegistryCurrent) {
      throw new Error(
        snapshot.bridgeConvergenceError ??
          `Bridge ${snapshot.bridgeThreadId} did not accept registry ${runtime.bridgeRegistryDigest}`,
      );
    }
  }

  #assertServiceActive(): void {
    if (this.#shutdownRequested) {
      throw new Error("OmniCodex gateway service is stopping");
    }
  }

  #isTransitionActive(generation: number): boolean {
    return !this.#shutdownRequested && generation === this.#lifecycleGeneration;
  }

  #assertTransitionActive(generation: number): void {
    if (!this.#isTransitionActive(generation)) {
      throw new RuntimeTransitionInvalidatedError();
    }
  }

  async #prepareRuntime(
    candidate: RuntimeCandidate,
    options: OmniCodexPrepareRuntimeOptions = {},
  ): Promise<OmniCodexPreparedRuntime> {
    const cancellation = new AbortController();
    const signal = combinedAbortSignal(cancellation.signal, options.signal);
    this.#runtimePreparationAbortControllers.add(cancellation);
    try {
      return await this.#prepareRuntimeWithCancellation(candidate, { ...options, signal });
    } finally {
      this.#runtimePreparationAbortControllers.delete(cancellation);
    }
  }

  async #prepareRuntimeWithCancellation(
    candidate: RuntimeCandidate,
    options: OmniCodexPrepareRuntimeOptions,
  ): Promise<OmniCodexPreparedRuntime> {
    throwIfRuntimePreparationAborted(options.signal);
    if (this.#options.prepareRuntime !== undefined) {
      return this.#options.prepareRuntime(candidate, options);
    }
    // One coordinator is shared by every transport in this prepared runtime,
    // but never across a hot runtime switch where native snapshots may differ.
    const readInvocationCoordinator = new ReadInvocationCoordinator();
    const desktopIpc = new CodexDesktopIpcClient();
    const appTools = this.#options.appToolsClientFactory?.() ?? new CodexAppToolsPipeClient();
    const runtimeEnvironment = await this.#options.runtimeEnvironment?.();
    const codexHome =
      runtimeEnvironment?.CODEX_HOME ??
      process.env.CODEX_HOME ??
      (process.env.USERPROFILE === undefined
        ? undefined
        : resolve(process.env.USERPROFILE, ".codex"));
    const browserRolloutSessionsRoot =
      nonEmptyString(runtimeEnvironment?.BROWSER_USE_ROLLOUT_SESSIONS_ROOT) ??
      resolve(codexHome ?? this.#options.cwd ?? process.cwd(), "sessions");
    const responsesModel = "gpt-5.6-sol";
    const modelMetadataSnapshot = await (
      this.#options.modelMetadataSource ??
      new CodexModelMetadataSource(
        runtimeEnvironment?.CODEX_HOME === undefined
          ? {}
          : { codexHome: runtimeEnvironment.CODEX_HOME },
      )
    ).read(responsesModel);
    let hostTools: CodexAppHostToolExecutor | undefined;
    let codeModeSurface: CodeModeNativeToolSurface | undefined;
    let sessionExecutorPool: OmniCodexSessionExecutorPool | undefined;
    let nativeExecutionScheduler: NativeExecutionScheduler | undefined;
    let runtimeDispatchMcp: OmniCodexMcpServerHandle | undefined;
    const responses = new ResponsesRuntimeExecutor({
      modelMetadataSnapshot,
      threadScopedProvider: true,
      ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
      dynamicTools: () => codeModeSurface?.dynamicToolSpecs ?? [],
      nestedToolExclusions: () => codeModeSurface?.nativeToolNames ?? [],
      ...(this.#options.onDiagnostic === undefined
        ? {}
        : { onDiagnostic: this.#options.onDiagnostic }),
    });
    let refreshPrimaryGenerationBindings: (() => Promise<void>) | undefined;
    let primary: RestartableCodexAppServerProcess | undefined;
    let operatorResponsesLease: SharedResponsesLease | undefined;
    let ownedBrowserNativeExecutor: BrowserNativeExecutor | undefined;
    const detachedThreads = new CodexDetachedThreadClient(candidate, {
      createProcess: (runtime, processOptions) =>
        new CodexAppServerConnection(runtime, processOptions),
      ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
      ...(this.#options.onDiagnostic === undefined
        ? {}
        : { onDiagnostic: this.#options.onDiagnostic }),
      onDynamicToolCall: (params) =>
        codeModeSurface?.callDynamic(params) ?? unavailableDynamicToolResponse(),
    });
    const threadMessages = new CodexThreadMessageRouter(desktopIpc, detachedThreads);
    try {
      const responsesBinding = await responses.prepare();
      // Codex 0.167 rejects a loopback thread on an App Server whose current
      // process provider is openai, even when thread/start selects loopback.
      // Keep Desktop native tools on its own server and share one isolated
      // provider-scoped server across operator and per-conversation turns.
      const sharedResponsesHost = new SharedResponsesAppServer(
        candidate,
        {
          ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
          ...(this.#options.ownershipRegistry === undefined
            ? {}
            : { ownershipRegistry: this.#options.ownershipRegistry }),
          env: responsesBinding.env,
          configOverrides: [
            ...responsesBinding.configOverrides,
            `model_provider="${OMNICODEX_LOOPBACK_PROVIDER_ID}"`,
          ],
          onNotification: (message) => this.#options.onDiagnostic?.(message),
          onServerRequest: answerAppServerApprovalRequest,
        },
        (runtime, processOptions) => new CodexAppServerProcess(runtime, processOptions),
      );
      primary = new RestartableCodexAppServerProcess(candidate, {
        processFactory: (runtime, processOptions) =>
          new CodexAppServerConnection(runtime, processOptions),
        ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
        onNotification: (message) => this.#options.onDiagnostic?.(message),
        onServerRequest: answerAppServerApprovalRequest,
        onRecoveryDiagnostic: (message) => this.#options.onDiagnostic?.(message),
        onDisconnected: (error) => {
          const notifyOwner = this.#options.onUnexpectedRuntimeExit;
          if (notifyOwner === undefined) return;
          signalDesktopRuntimeDisconnection(error, {
            isActive:
              !this.#shutdownRequested &&
              this.#components?.candidate === candidate &&
              (this.#status.lifecycle === "ready" || this.#status.lifecycle === "converging"),
            retireResponses: (failure) => responses.handleProcessExit(failure),
            retireConnection: () => primary?.stop() ?? Promise.resolve(),
            notifyOwner,
            reportFailure: (failure) =>
              this.#options.onDiagnostic?.({
                method: "omnicodex/runtime/disconnectionCleanupFailed",
                params: { message: toError(failure).message },
              }),
          });
        },
        onGenerationReplaced: async () => {
          await refreshPrimaryGenerationBindings?.();
        },
      });
      // Bind every executor after the shared pipe's initialize handshake.
      await primary.start();
      throwIfRuntimePreparationAborted(options.signal);
      const bridgeThreadContext = new OmniCodexBridgeThreadContext();
      const initialAppToolsContextThreadId =
        nonEmptyString(runtimeEnvironment?.CODEX_THREAD_ID) ??
        nonEmptyString(process.env.CODEX_THREAD_ID) ??
        nonEmptyString(runtimeEnvironment?.CODEX_SESSION_ID) ??
        nonEmptyString(process.env.CODEX_SESSION_ID);
      // Browser service IAB identity is keyed by session_id, so prefer the
      // inherited Codex session over an executor thread id. Desktop ownership
      // is still authoritatively verified by the resolver before every call.
      const initialBrowserContextThreadId =
        nonEmptyString(runtimeEnvironment?.CODEX_SESSION_ID) ??
        nonEmptyString(process.env.CODEX_SESSION_ID) ??
        nonEmptyString(runtimeEnvironment?.CODEX_THREAD_ID) ??
        nonEmptyString(process.env.CODEX_THREAD_ID);
      const appToolsContextThreadId = createCodexAppToolsContextResolver(primary.client, appTools, {
        ...(initialAppToolsContextThreadId === undefined
          ? {}
          : { initialPreferredThreadId: initialAppToolsContextThreadId }),
        // A model-free Responses execution thread is not a desktop renderer
        // context. Once the canonical Bridge exists, probe it before any
        // App Server inventory fallback; the current App Server may be
        // waiting for this exact dynamic-tool response and is not reentrant.
        fallbackThreadId: () => bridgeThreadContext.currentThreadId,
      });
      const methodCatalog = new AppServerMethodCatalog(new CodexSchemaBundleLoader(candidate));
      const appServerMethodExecutor = new AppServerMethodExecutor(primary.client);
      const workExecutorIds = new CodexWorkExecutorIdReader();
      const cuaServer = new CuaPluginServerReader(primary.client);
      const nativeToolExecutor = new NativeToolExecutor(primary.client, {
        ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
        resolveWorkExecutorId: () => workExecutorIds.read(),
        resolveCuaServerConfig: (workExecutorId) => cuaServer.read(workExecutorId),
      });
      const computerUse = new ComputerUseNativeExecutor(nativeToolExecutor);
      const desktopLifecycle = new CodexDesktopLifecycleController({
        enableChatEvents: true,
        nativeToolsReady: async (boundary) => {
          const tools = await appTools.listTools(boundary);
          return tools.some(
            (tool) => tool.namespace === "codex_app" && tool.name === "list_projects",
          );
        },
      });
      hostTools = new CodexAppHostToolExecutor(primary.client, {
        coordinateNativeChatRequest: async (namespace, tool, args, context, perform) => {
          if (
            namespace !== "codex_app" ||
            !["read_thread", "send_message_to_thread"].includes(tool) ||
            typeof args.threadId !== "string"
          )
            return perform();
          const sources = new DesktopChatConversationSources(codexHome);
          if (!(await sources.isChatConversation(args.threadId))) return perform();
          const client = primary?.client;
          if (client === undefined) throw new Error("DESKTOP_CHAT_RUNTIME_NOT_READY");
          const readAccount = async (signal: AbortSignal) =>
            desktopChatAccountSourceId(
              await new DesktopChatApiClient((method, params) =>
                client.request(method, params, { signal }),
              ).readPrincipal(signal),
            );
          const account = await readAccount(context.signal ?? new AbortController().signal);
          const cooldown = await this.#chatAccountRequests.readCooldown(account);
          if (cooldown !== undefined)
            throw new ChatAccountRateLimitError(cooldown.retryAtUnixMs, undefined);
          return this.#chatAccountRequests.run(
            account,
            async (signal) => {
              if ((await readAccount(signal)) !== account)
                throw new Error("DESKTOP_CHAT_ACCOUNT_CHANGED");
              if (
                tool === "send_message_to_thread" &&
                !(await sources.hasConversationSource(account, args.threadId as string))
              )
                throw new Error("DESKTOP_CHAT_ACCOUNT_CHANGED");
              if (
                tool === "send_message_to_thread" &&
                this.#options.evaluateDesktopNativeSend !== undefined &&
                this.#options.isDesktopNativeSendReady?.() !== false &&
                args.model === undefined &&
                args.thinking === undefined
              ) {
                const prompt = nonEmptyString(args.prompt);
                if (prompt === undefined) throw new Error("prompt is required");
                const result = await sendDesktopChatNativeMessage(
                  {
                    operationId: context.operationId ?? randomUUID(),
                    conversationUrl: `https://chatgpt.com/c/${args.threadId as string}`,
                    accountSourceId: account,
                    prompt,
                  },
                  {
                    evaluate: this.#options.evaluateDesktopNativeSend,
                    readAccountSourceId: readAccount,
                  },
                  signal,
                  context.beforeNativeDispatch,
                );
                return {
                  success: true,
                  contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
                };
              }
              return perform(signal);
            },
            context.signal,
            "report",
          );
        },
        ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
        appTools,
        appToolsContextThreadId,
        threadMessages,
        threadSnapshots: desktopIpc,
        computerUse,
        desktopLifecycle,
      });
      // Code Mode and the public MCP registry must observe the same live
      // downstream MCP inventory. First-party host routes such as Computer Use
      // are injected above by CodexAppHostToolExecutor and do not belong here.
      // A second downstream catalog can drift between refresh boundaries.
      const selfServerIdentity = omniCodexServerIdentityFromMetadata(
        this.#options.protectedResourceMetadata,
      );
      const downstreamCatalog = new NativeToolCatalog(primary.client, {
        ...(selfServerIdentity === undefined ? {} : { selfServerIdentity }),
        selfServerName: OMNICODEX_MCP_SERVER_NAME,
      });
      const resolveDesktopBrowserContext = createCodexBrowserContextResolver(
        primary.client,
        desktopIpc,
        {
          ...(initialBrowserContextThreadId === undefined
            ? {}
            : { initialPreferredThreadId: initialBrowserContextThreadId }),
          validationTtlMs: 0,
        },
      );
      // One physical Chrome extension outage is shared by every authenticated
      // Web work session. Keep the recovery owner app-global so concurrent Pro
      // calls cannot fan out into duplicate Chrome windows.
      const browserSurfaceRecovery = new FirstPartyChromeSurfaceRecovery({
        ...(codexHome === undefined ? {} : { codexHome }),
      });
      const createBrowserNativeExecutor = (executor: NativeToolExecutor) =>
        new BrowserNativeExecutor(executor, {
          ...(codexHome === undefined ? {} : { codexHome }),
          browserRolloutSessionsRoot,
          environment: this.#options.browserEnvironment ?? "codex-app",
          surfaceRecovery: browserSurfaceRecovery,
          resolveContextThreadId: async (request, boundary) => {
            // The Work executor owns Chrome sessions directly. An in-app
            // browser tied to a Codex task still requires that exact task.
            return request.operation !== "list_surfaces" && request.surface === "iab"
              ? resolveDesktopBrowserContext(request, boundary)
              : undefined;
          },
        });
      const browserNativeExecutor = createBrowserNativeExecutor(nativeToolExecutor);
      ownedBrowserNativeExecutor = browserNativeExecutor;
      nativeExecutionScheduler = new NativeExecutionScheduler({
        ...(this.#options.nativeResourceLeaseCoordinator === undefined
          ? {}
          : { resourceLeaseCoordinator: this.#options.nativeResourceLeaseCoordinator }),
      });
      codeModeSurface = new CodeModeNativeToolSurface({
        hostTools,
        appServerMethodCatalog: methodCatalog,
        appServerMethodExecutor,
        downstreamToolCatalog: downstreamCatalog,
        downstreamToolExecutor: nativeToolExecutor,
        browserNativeExecutor,
        scheduler: nativeExecutionScheduler,
        ...(this.#options.observeDynamicToolExecution === undefined
          ? {}
          : { observeDynamicToolCall: this.#options.observeDynamicToolExecution }),
      });
      await refreshCodeModeCatalogsAtomically(hostTools, methodCatalog, downstreamCatalog);
      throwIfRuntimePreparationAborted(options.signal);
      operatorResponsesLease = await sharedResponsesHost.acquire({
        ownsThread: (threadId) => responses.isExecutionThread(threadId),
        onNotification: responsesBinding.onNotification,
        onServerRequest: (message) => {
          if (message.method !== "item/tool/call") return answerAppServerApprovalRequest(message);
          const params = jsonRecord(message.params);
          return responses.dispatchDynamic(params, (nativeParams, signal) =>
            codeModeSurface === undefined
              ? Promise.resolve(unavailableDynamicToolResponse())
              : codeModeSurface.callDynamic(nativeParams, {
                  executionOnlyCallingThread: responses.isExecutionThread(nativeParams.threadId),
                  ...(signal === undefined ? {} : { signal }),
                }),
          );
        },
        onExit: (error) => {
          // Even before the gateway is published, a lost auxiliary transport
          // must settle the operator turn waiting for native completion.
          void responses.handleProcessExit(error).catch((failure) =>
            this.#options.onDiagnostic?.({
              method: "omnicodex/runtime/loopbackRetirementFailed",
              params: { message: toError(failure).message },
            }),
          );
          if (
            this.#shutdownRequested ||
            this.#components?.candidate !== candidate ||
            (this.#status.lifecycle !== "ready" && this.#status.lifecycle !== "converging")
          )
            return;
          void Promise.resolve()
            .then(() => this.#options.onUnexpectedRuntimeExit?.(error))
            .catch((failure) =>
              this.#options.onDiagnostic?.({
                method: "omnicodex/runtime/loopbackRecoveryNotificationFailed",
                params: { message: toError(failure).message },
              }),
            );
        },
      });
      await responses.start(operatorResponsesLease.process, options.signal);
      const ownedHostTools = hostTools;
      const ownedCodeModeSurface = codeModeSurface;
      const ownedNativeExecutionScheduler = nativeExecutionScheduler;
      let inventoryFlight: Promise<AppServerThreadInventory> | undefined;
      const readIsolatedThreadInventory = (): Promise<AppServerThreadInventory> => {
        if (inventoryFlight !== undefined) return inventoryFlight;
        const operation = (async () => {
          // A separate pipe connection keeps inventory requests independent
          // of long native calls without creating another App Server process.
          const reader = new CodexAppServerConnection(candidate, {
            ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
            onServerRequest: answerAppServerApprovalRequest,
            onNotification: (message) => this.#options.onDiagnostic?.(message),
          });
          try {
            await reader.start();
            return await readAppServerThreadInventory(reader.client);
          } finally {
            await reader.stop();
          }
        })();
        const flight = operation.finally(() => {
          if (inventoryFlight === flight) inventoryFlight = undefined;
        });
        inventoryFlight = flight;
        return flight;
      };
      for (const requiredLifecycleTool of [
        "codex_app__set_thread_archived",
        "codex_app__set_thread_title",
      ]) {
        if (ownedHostTools.descriptor(requiredLifecycleTool) === undefined) {
          throw new Error(`Codex app lifecycle tool is unavailable: ${requiredLifecycleTool}`);
        }
      }
      // The long-lived primary App Server must never create, resume, or own the
      // Bridge writer. Every initial or hot-update reconciliation uses a fresh,
      // bounded bootstrap that is stopped before the result is returned.
      const reconcileBridge = async () =>
        bridgeThreadContext.accept(
          await new OmniCodexBridgeReconciler({
            candidate,
            dynamicTools: OMNICODEX_BRIDGE_CONTEXT_TOOLS,
            bootstrapFactory: () => new CodexAppServerConnection(candidate),
            ownerInspector: desktopIpc,
            threadLifecycle: createBridgeThreadLifecycle(ownedHostTools),
            env: runtimeEnvironment ?? {},
            ...(this.#options.ownershipRegistry === undefined
              ? {}
              : { ownershipRegistry: this.#options.ownershipRegistry }),
            ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
          }).reconcile(),
        );
      const initialGeneration = codexCatalogGeneration(ownedCodeModeSurface);
      let bridge: OmniCodexBridgeReconcileResult;
      if (options.deferBridgeReconciliation === true) {
        if (options.initialBridge === undefined) {
          throw new Error("Deferred Bridge reconciliation requires the current canonical identity");
        }
        // A switch shadow may read the existing Bridge identity for browser
        // context, but it must not create/archive/rename any Bridge thread
        // until the candidate has passed its full observation window.
        bridge = bridgeThreadContext.accept(options.initialBridge);
      } else {
        bridge = await reconcileBridge();
      }
      const responsesCatalog = new ResponsesNativeToolCatalog(responses, {
        ...(selfServerIdentity === undefined ? {} : { selfServerIdentity }),
        selfServerName: OMNICODEX_MCP_SERVER_NAME,
      });
      await responsesCatalog.refresh();
      const ownedPrimary = primary;
      const runtimeNativeToolExecutor = new NativeToolExecutor(ownedPrimary.client, {
        ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
        resolveWorkExecutorId: () => workExecutorIds.read(),
        resolveCuaServerConfig: (workExecutorId) => cuaServer.read(workExecutorId),
      });
      const browserActivityCoordinator = new ChatGptBrowserActivityCoordinator({
        readActiveConversationIds: async (signal, requiredConversationIds = []) =>
          browserConversationActivityObservation(
            await resolveChatGptConversationActivity(
              await ownedHostTools.callRequiredNative(
                "codex_app__list_threads",
                { limit: CODEX_APP_LIST_THREADS_MAX },
                {
                  operationId: `browser-activity-${randomUUID()}`,
                  timeoutMs: INTERACTIVE_CLIENT_PROBE_LIVENESS_MS,
                  ...(signal === undefined ? {} : { signal }),
                },
              ),
              requiredConversationIds,
              (threadId) =>
                ownedHostTools.callRequiredNative(
                  "codex_app__read_thread",
                  { threadId, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 },
                  {
                    operationId: `browser-activity-conversation-${randomUUID()}`,
                    timeoutMs: INTERACTIVE_CLIENT_PROBE_LIVENESS_MS,
                    ...(signal === undefined ? {} : { signal }),
                  },
                ),
              true,
            ),
            requiredConversationIds,
          ),
        // Use the coordinator's long-turn cadence. The faster transition
        // probe interval must not become a permanent renderer polling loop.
        ...(this.#options.onDiagnostic === undefined
          ? {}
          : { onDiagnostic: this.#options.onDiagnostic }),
      });
      sessionExecutorPool = new OmniCodexSessionExecutorPool({
        ...(this.#options.sessionResponsesRuntimeLimit === undefined
          ? {}
          : { responsesCallConcurrency: this.#options.sessionResponsesRuntimeLimit }),
        nativeContextIdleMs: OMNICODEX_DURABLE_NATIVE_CONTEXT_IDLE_MS,
        nativeContextPendingActivityMaxIdleMs:
          OMNICODEX_DURABLE_NATIVE_CONTEXT_PENDING_ACTIVITY_MAX_IDLE_MS,
        createNativeRuntime: (context, creationSignal) =>
          createDisposableNativeAppServerContext(
            {
              candidate,
              processFactory: (runtime, processOptions) =>
                new CodexAppServerConnection(runtime, processOptions),
              processOptions: {
                correlationId: context.correlationId,
                ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
                onNotification: (message) => this.#options.onDiagnostic?.(message),
                onServerRequest: answerAppServerApprovalRequest,
                onUnexpectedExit: (error) => {
                  this.#options.onDiagnostic?.({
                    method: "omnicodex/sessionNativeRuntimeExited",
                    params: {
                      correlationId: context.correlationId,
                      message: error.message,
                    },
                  });
                },
              },
              executorOptions: {
                ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
                resolveWorkExecutorId: () => workExecutorIds.read(),
                resolveCuaServerConfig: (workExecutorId) => cuaServer.read(workExecutorId),
              },
            },
            creationSignal,
          ),
        createBrowserNativeExecutor: (_context, executor) => createBrowserNativeExecutor(executor),
        createResponsesRuntime: async (
          context,
          sessionNativeToolExecutor,
          creationSignal,
          workSessionBrowser,
        ) => {
          const sessionBrowserNativeExecutor =
            workSessionBrowser ?? createBrowserNativeExecutor(sessionNativeToolExecutor);
          const sessionBrowserCallContext = () => {
            const workSessionBinding = context.resolveWorkSessionBinding?.();
            return {
              ownerBinding: context.authorizationBinding,
              callerProvenance: "chatgpt_conversation" as const,
              ...(workSessionBinding === undefined ? {} : { workSessionBinding }),
              callerSessionId: context.correlationId,
            };
          };
          const sessionCodeModeSurface = new CodeModeNativeToolSurface({
            ...(this.#options.directGoalStore === undefined
              ? {}
              : { directGoalStore: this.#options.directGoalStore }),
            ...(this.#options.mutationReplayStore === undefined
              ? {}
              : { mutationReplayStore: this.#options.mutationReplayStore }),
            hostTools: ownedHostTools,
            appServerMethodCatalog: methodCatalog,
            appServerMethodExecutor,
            downstreamToolCatalog: downstreamCatalog,
            downstreamToolExecutor: sessionNativeToolExecutor,
            browserNativeExecutor: sessionBrowserNativeExecutor,
            browserActivityCoordinator,
            browserCallContext: sessionBrowserCallContext,
            scheduler: ownedNativeExecutionScheduler,
            ...(this.#options.observeDynamicToolExecution === undefined
              ? {}
              : { observeDynamicToolCall: this.#options.observeDynamicToolExecution }),
          });
          const sessionResponses = new ResponsesRuntimeExecutor({
            modelMetadataSnapshot,
            threadScopedProvider: true,
            ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
            dynamicTools: () => sessionCodeModeSurface.dynamicToolSpecs,
            nestedToolExclusions: () => sessionCodeModeSurface.nativeToolNames,
            ...(this.#options.onDiagnostic === undefined
              ? {}
              : { onDiagnostic: this.#options.onDiagnostic }),
            onTurnSettled: (turnId) =>
              sessionBrowserNativeExecutor.finishActivity(`turn:${turnId}`, {
                ...sessionBrowserCallContext(),
                contextTurnId: turnId,
              }),
          });
          let sessionAppServer: SharedResponsesLease | undefined;
          let sessionAppServerAcquisition: Promise<SharedResponsesLease> | undefined;
          let cleanupPromise: Promise<void> | undefined;
          const cleanup = (): Promise<void> => {
            if (cleanupPromise !== undefined) return cleanupPromise;
            const operation = (async () => {
              const errors: Error[] = [];
              // Cancellation may arrive while the shared child is initializing.
              // Adopt that exact lease before cleanup; never cache a successful
              // cleanup that ran before the pending acquisition returned.
              if (sessionAppServerAcquisition !== undefined) {
                sessionAppServer ??= await sessionAppServerAcquisition.catch(() => undefined);
              }
              await captureStopError(errors, () => sessionResponses.stop());
              if (sessionAppServer !== undefined) {
                const ownedSessionAppServer = sessionAppServer;
                await captureStopError(errors, () => ownedSessionAppServer.release());
              }
              if (errors.length > 0) {
                throw new AggregateError(
                  errors,
                  "Session-owned App Server and Responses runtime did not stop cleanly",
                );
              }
            })();
            cleanupPromise = operation;
            void operation.catch(() => {
              // Keep failed cleanup retryable; a rejected cached promise must
              // not permanently strand this exact child and its pool slot.
              if (cleanupPromise === operation) cleanupPromise = undefined;
            });
            return operation;
          };
          const onCreationAbort = () => {
            void cleanup().catch((error) => {
              this.#options.onDiagnostic?.({
                method: "omnicodex/sessionResponsesRuntimeAbortCleanupFailed",
                params: {
                  correlationId: context.correlationId,
                  message: toError(error).message,
                },
              });
            });
          };
          creationSignal.addEventListener("abort", onCreationAbort, { once: true });
          try {
            throwIfSessionAborted(creationSignal);
            const binding = await sessionResponses.prepare();
            throwIfSessionAborted(creationSignal);
            sessionAppServerAcquisition = sharedResponsesHost.acquire({
              ownsThread: (threadId) => sessionResponses.isExecutionThread(threadId),
              onNotification: binding.onNotification,
              onServerRequest: (message) => {
                if (message.method !== "item/tool/call") {
                  return answerAppServerApprovalRequest(message);
                }
                const params = jsonRecord(message.params);
                return sessionResponses.dispatchDynamic(params, (nativeParams, signal) =>
                  sessionCodeModeSurface.callDynamic(nativeParams, {
                    executionOnlyCallingThread: sessionResponses.isExecutionThread(
                      nativeParams.threadId,
                    ),
                    ...(signal === undefined ? {} : { signal }),
                  }),
                );
              },
              onExit: (error) => {
                void sessionResponses.handleProcessExit(error).catch((cleanupError) => {
                  this.#options.onDiagnostic?.({
                    method: "omnicodex/sessionResponsesRuntimeExitCleanupFailed",
                    params: {
                      correlationId: context.correlationId,
                      message: toError(cleanupError).message,
                    },
                  });
                });
                this.#options.onDiagnostic?.({
                  method: "omnicodex/sessionResponsesRuntimeExited",
                  params: {
                    correlationId: context.correlationId,
                    message: error.message,
                  },
                });
              },
            });
            sessionAppServer = await sessionAppServerAcquisition;
            throwIfSessionAborted(creationSignal);
            await sessionResponses.start(sessionAppServer.process, creationSignal);
            throwIfSessionAborted(creationSignal);
            return {
              call: (selection, signal) => sessionResponses.call(selection, signal),
              callNested: (name, argumentsValue, freeform, signal) =>
                sessionResponses.callNested(name, argumentsValue, freeform, signal),
              callMcp: (server, tool, argumentsValue, signal) =>
                sessionResponses.callMcp(server, tool, argumentsValue, signal),
              close: cleanup,
            };
          } catch (error) {
            try {
              await cleanup();
            } catch (cleanupError) {
              throw new AggregateError(
                [toError(error), toError(cleanupError)],
                "Session-owned Responses runtime startup and cleanup failed",
              );
            }
            throw error;
          } finally {
            creationSignal.removeEventListener("abort", onCreationAbort);
          }
        },
      });
      const ownedSessionExecutorPool = sessionExecutorPool;
      if (this.#directScheduleManager !== undefined) {
        runtimeDispatchMcp = createOmniCodexMcpServer({
          appServer: ownedPrimary.client,
          nativeToolCatalog: downstreamCatalog,
          nativeToolExecutor: runtimeNativeToolExecutor,
          appServerMethodCatalog: methodCatalog,
          appServerMethodExecutor,
          responsesToolCatalog: responsesCatalog,
          responsesToolExecutor: new ResponsesNativeToolExecutor(responses),
          browserNativeExecutor,
          codexAppHostToolExecutor: ownedHostTools,
          scheduler: ownedNativeExecutionScheduler.contextualView(),
          ...(this.#options.nativeResourceLeaseCoordinator === undefined
            ? {}
            : {
                nativeResourceLeaseCoordinator: this.#options.nativeResourceLeaseCoordinator,
              }),
          ...(this.#options.directGoalStore === undefined
            ? {}
            : { directGoalStore: this.#options.directGoalStore }),
          ...(this.#options.directJobManager === undefined
            ? {}
            : { directJobManager: this.#options.directJobManager }),
          directScheduleManager: this.#directScheduleManager,
          ...(this.#options.mutationReplayStore === undefined
            ? {}
            : { mutationReplayStore: this.#options.mutationReplayStore }),
          ...(this.#options.legacyMutationCoordinator === undefined
            ? {}
            : { legacyMutationCoordinator: this.#options.legacyMutationCoordinator }),
          readInvocationCoordinator,
          runtimeDispatchOnly: true,
          surface: "full",
        });
      }
      const ownedRuntimeDispatchMcp = runtimeDispatchMcp;
      const gateway = new StreamableHttpGateway({
        appServer: primary.client,
        nativeToolCatalog: downstreamCatalog,
        nativeToolExecutor: runtimeNativeToolExecutor,
        browserNativeExecutor,
        browserActivityCoordinator,
        codexAppHostToolExecutor: hostTools,
        appServerMethodCatalog: methodCatalog,
        responsesToolCatalog: responsesCatalog,
        createSessionExecutors: (context) =>
          ownedSessionExecutorPool.createSessionExecutors(context),
        desktopIpcClient: threadMessages,
        scheduler: ownedNativeExecutionScheduler,
        ...(this.#options.nativeResourceLeaseCoordinator === undefined
          ? {}
          : { nativeResourceLeaseCoordinator: this.#options.nativeResourceLeaseCoordinator }),
        host: "127.0.0.1",
        port: this.#options.port ?? 0,
        path: this.#options.path ?? "/mcp",
        fullPath: this.#options.fullPath ?? "/mcp/full",
        actionCatalogByteBudget: OMNICODEX_CHATGPT_ACTION_CATALOG_BYTE_BUDGET,
        authorize: this.#options.authorize,
        ...(this.#options.directGoalStore === undefined
          ? {}
          : { directGoalStore: this.#options.directGoalStore }),
        ...(this.#options.directJobManager === undefined
          ? {}
          : { directJobManager: this.#options.directJobManager }),
        ...(this.#directScheduleManager === undefined || ownedRuntimeDispatchMcp === undefined
          ? {}
          : {
              directScheduleManager: this.#directScheduleManager,
              directJobDispatchAdapter: ownedRuntimeDispatchMcp.directJobDispatchAdapter,
            }),
        ...(this.#options.durableWorkSessionStore === undefined
          ? {}
          : { durableWorkSessionStore: this.#options.durableWorkSessionStore }),
        ...(this.#options.durableMcpEventStoreFactory === undefined
          ? {}
          : { durableMcpEventStoreFactory: this.#options.durableMcpEventStoreFactory }),
        ...(this.#options.mutationReplayStore === undefined
          ? {}
          : { mutationReplayStore: this.#options.mutationReplayStore }),
        ...(this.#options.legacyMutationCoordinator === undefined
          ? {}
          : { legacyMutationCoordinator: this.#options.legacyMutationCoordinator }),
        readInvocationCoordinator,
        ...(this.#options.observeMcpRequest === undefined
          ? {}
          : { observeMcpRequest: this.#options.observeMcpRequest }),
        ...(this.#options.prepareChatGptConversationRequest === undefined
          ? {}
          : {
              prepareChatGptConversationRequest: this.#options.prepareChatGptConversationRequest,
            }),
        ...(this.#options.observeAuthorizationServerMetadataRequest === undefined
          ? {}
          : {
              observeAuthorizationServerMetadataRequest:
                this.#options.observeAuthorizationServerMetadataRequest,
            }),
        ...(this.#options.observeNativeToolExecution === undefined
          ? {}
          : { observeNativeToolExecution: this.#options.observeNativeToolExecution }),
        ...(this.#options.prepareProtectedResultDelivery === undefined
          ? {}
          : {
              prepareProtectedResultDelivery: this.#options.prepareProtectedResultDelivery,
            }),
        ...(this.#options.observeProgress === undefined
          ? {}
          : { observeProgress: this.#options.observeProgress }),
        ...(this.#options.observeResultDelivery === undefined
          ? {}
          : { observeResultDelivery: this.#options.observeResultDelivery }),
        ...(this.#options.observeMutationReplay === undefined
          ? {}
          : { observeMutationReplay: this.#options.observeMutationReplay }),
        ...(this.#options.observeReadInvocation === undefined
          ? {}
          : { observeReadInvocation: this.#options.observeReadInvocation }),
        ...(this.#options.observeToolCatalog === undefined
          ? {}
          : { observeToolCatalog: this.#options.observeToolCatalog }),
        ...(this.#options.allowedOrigins === undefined
          ? {}
          : { allowedOrigins: this.#options.allowedOrigins }),
        ...(this.#options.allowedHosts === undefined
          ? {}
          : { allowedHosts: this.#options.allowedHosts }),
        ...(this.#options.publicMetadataOrigin === undefined
          ? {}
          : { publicMetadataOrigin: this.#options.publicMetadataOrigin }),
        ...(this.#options.protectedResourceMetadata === undefined
          ? {}
          : { protectedResourceMetadata: this.#options.protectedResourceMetadata }),
        ...(this.#options.authorizationServerMetadata === undefined
          ? {}
          : { authorizationServerMetadata: this.#options.authorizationServerMetadata }),
        ...(selfServerIdentity === undefined ? {} : { serverIdentity: selfServerIdentity }),
      });
      let responsesCodeModeCatalogDigest = initialGeneration.codeModeCatalogDigest;
      const convergence = new OmniCodexCatalogConvergence({
        intervalMs: this.#options.catalogConvergenceIntervalMs ?? 5_000,
        initialBridge: bridge,
        initialGeneration,
        refreshCatalog: async (signal) => {
          await refreshCodeModeCatalogsAtomically(
            ownedHostTools,
            methodCatalog,
            downstreamCatalog,
            signal,
          );
          throwIfRuntimePreparationAborted(signal);
          const nextGeneration = codexCatalogGeneration(ownedCodeModeSurface);
          if (nextGeneration.codeModeCatalogDigest !== responsesCodeModeCatalogDigest) {
            await responses.refreshCatalog(signal);
            throwIfRuntimePreparationAborted(signal);
            responsesCodeModeCatalogDigest = nextGeneration.codeModeCatalogDigest;
          }
          return nextGeneration;
        },
        refreshMcpSessions: () => gateway.refreshTools(),
        reconcileBridge,
        ...(this.#options.onDiagnostic === undefined
          ? {}
          : { onDiagnostic: this.#options.onDiagnostic }),
      });
      refreshPrimaryGenerationBindings = async () => {
        // The public HTTP/MCP gateway and its durable Web work-session leases
        // remain alive. Recover provider state first, let convergence refresh
        // the complete code-mode generation, then let each MCP registry stage
        // and publish Responses together with host/App Server/downstream
        // descriptors. Publishing Responses here first would expose a mixed
        // generation to calls arriving during App Server recovery.
        // The loopback provider runs on its own generation; a Desktop pipe
        // replacement must not interrupt its active operator turn.
        await convergence.refreshNow();
        await gateway.refreshTools();
      };
      const evaluateDesktopNativeSend = this.#options.evaluateDesktopNativeSend;
      return {
        candidate,
        gateway,
        ...(ownedRuntimeDispatchMcp === undefined
          ? {}
          : { directJobDispatchAdapter: ownedRuntimeDispatchMcp.directJobDispatchAdapter }),
        appServerMethodCount: methodCatalog.snapshot.methods.length,
        downstreamToolCount: downstreamCatalog.snapshot.tools.length,
        responsesToolCount: responsesCatalog.snapshot.tools.length,
        get hostToolCount() {
          return ownedHostTools.tools.length;
        },
        get bridgeThreadId() {
          return convergence.snapshot.bridgeThreadId;
        },
        get bridgeDisposition() {
          return convergence.snapshot.bridgeDisposition;
        },
        get bridgeRegistryCurrent() {
          return convergence.snapshot.bridgeRegistryCurrent;
        },
        get bridgeRegistryDigest() {
          return convergence.bridgeRegistryDigest;
        },
        get bridgeConvergenceError() {
          return convergence.snapshot.bridgeConvergenceError;
        },
        promoteBridge: async () => {
          const snapshot = await convergence.reconcileNow();
          if (!snapshot.bridgeRegistryCurrent) {
            throw new Error(
              snapshot.bridgeConvergenceError ??
                `Bridge ${snapshot.bridgeThreadId} did not accept registry ${convergence.bridgeRegistryDigest}`,
            );
          }
          return snapshot;
        },
        directProbe: async () => {
          await probeAppServerThreadInventory(ownedPrimary.client);
        },
        readThreadInventory: readIsolatedThreadInventory,
        readInteractiveThreadActivity: (timeoutMs) =>
          ownedHostTools.callRequiredNative(
            "codex_app__list_threads",
            { limit: CODEX_APP_LIST_THREADS_MAX },
            {
              operationId: `planned-transition-${randomUUID()}`,
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            },
          ),
        readInteractiveConversationActivity: (threadId, timeoutMs) =>
          ownedHostTools.callRequiredNative(
            "codex_app__read_thread",
            { threadId, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 },
            {
              operationId: `planned-transition-conversation-${randomUUID()}`,
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            },
          ),
        readChromeUserTabs: () =>
          browserNativeExecutor.call({ operation: "list_user_tabs", surface: "chrome" }),
        synchronizeApprovedChromeConversation: (target, signal) =>
          synchronizeApprovedChromeConversation(browserNativeExecutor, target, signal),
        continueChromeGoal: (target, signal) =>
          continueChromeGoal(browserNativeExecutor, target, signal),
        continueDesktopGoal: (target, signal) =>
          continueDesktopChatGoal(
            ownedHostTools,
            target,
            undefined,
            signal,
            async (expectedSource, conversationId, operationSignal) => {
              const boundary = operationSignal ?? new AbortController().signal;
              const auth = new DesktopChatApiClient((method, params) =>
                ownedPrimary.client.request(method, params, { signal: boundary }),
              );
              const principal = await auth.readPrincipal(boundary);
              if (desktopChatAccountSourceId(principal) !== expectedSource) return false;
              return new DesktopChatConversationSources(
                runtimeEnvironment?.CODEX_HOME,
              ).hasConversationSource(expectedSource, conversationId);
            },
            this.#options.directGoalStore === undefined
              ? undefined
              : (receipt) =>
                  this.#options.directGoalStore?.recordNativeContinuationReceipt(target, receipt) ??
                  Promise.resolve(false),
            async () => {
              const boundary = signal ?? new AbortController().signal;
              const auth = new DesktopChatApiClient((method, params) =>
                ownedPrimary.client.request(method, params, { signal: boundary }),
              );
              const principal = await auth.readPrincipal(boundary);
              if (desktopChatAccountSourceId(principal) !== target.accountSourceId)
                throw new Error("DESKTOP_GOAL_ACCOUNT_SOURCE_CHANGED");
              const connectors = await desktopChatAccountConnectorIds(
                codexHome ?? resolve(process.env.USERPROFILE ?? "", ".codex"),
                principal.accountId,
              );
              return selectDesktopGoalConnectorId(connectors, target.connectorId);
            },
            () =>
              this.#options.directGoalStore?.canDispatchContinuation(target) ??
              Promise.resolve(false),
            async (conversationId, operationSignal) => {
              const readSnapshot = this.#options.readDesktopGoalSnapshot;
              if (!readSnapshot) throw new Error("DIRECT_GOAL_DESKTOP_EXACT_READER_REQUIRED");
              if (!target.accountSourceId) throw new Error("DESKTOP_GOAL_ACCOUNT_SOURCE_CHANGED");
              return (
                await readSnapshot(
                  `https://chatgpt.com/c/${conversationId}`,
                  target.accountSourceId,
                  operationSignal ?? new AbortController().signal,
                )
              ).raw;
            },
            evaluateDesktopNativeSend === undefined
              ? undefined
              : {
                  prepare: (prompt, operationId, operationSignal) => {
                    const boundary = operationSignal ?? new AbortController().signal;
                    if (!target.accountSourceId)
                      throw new Error("DESKTOP_GOAL_ACCOUNT_SOURCE_CHANGED");
                    return prepareDesktopChatNativeSend(
                      {
                        prompt,
                        operationId,
                        conversationUrl: target.conversationUrl,
                        accountSourceId: target.accountSourceId,
                      },
                      {
                        evaluate: evaluateDesktopNativeSend,
                        readAccountSourceId: async (accountSignal) => {
                          const auth = new DesktopChatApiClient((method, params) =>
                            ownedPrimary.client.request(method, params, { signal: accountSignal }),
                          );
                          return desktopChatAccountSourceId(
                            await auth.readPrincipal(accountSignal),
                          );
                        },
                      },
                      boundary,
                    );
                  },
                  dispatch: (prepared, operationSignal) =>
                    dispatchDesktopChatNativeSend(
                      prepared,
                      {
                        evaluate: evaluateDesktopNativeSend,
                        readAccountSourceId: async (accountSignal) => {
                          const auth = new DesktopChatApiClient((method, params) =>
                            ownedPrimary.client.request(method, params, { signal: accountSignal }),
                          );
                          return desktopChatAccountSourceId(
                            await auth.readPrincipal(accountSignal),
                          );
                        },
                      },
                      operationSignal ?? new AbortController().signal,
                    ),
                },
          ),
        readDesktopChatScope: async (signal) => {
          const auth = new DesktopChatApiClient((method, params) =>
            ownedPrimary.client.request(method, params, { signal }),
          );
          const principal = await auth.readPrincipal(signal);
          const before = desktopChatAccountSourceId(principal);
          const connectorIds = await desktopChatAccountConnectorIds(
            codexHome ?? resolve(process.env.USERPROFILE ?? "", ".codex"),
            principal.accountId,
          );
          if (desktopChatAccountSourceId(await auth.readPrincipal(signal)) !== before)
            throw new Error("DESKTOP_CHAT_ACCOUNT_CHANGED");
          return { accountSourceId: before, connectorIds };
        },
        readDesktopCompletion: async (conversationUrl, anchor, signal) => {
          const url = normalizeChatGptConversationUrl(conversationUrl);
          if (!url) throw new Error("DESKTOP_CHAT_COMPLETION_INVALID");
          const id = url.slice("https://chatgpt.com/c/".length);
          const auth = new DesktopChatApiClient((method, params) =>
            ownedPrimary.client.request(method, params, { signal }),
          );
          const principal = await auth.readPrincipal(signal);
          const accountSourceId = desktopChatAccountSourceId(principal);
          if (
            !(await new DesktopChatConversationSources(codexHome).hasConversationSource(
              accountSourceId,
              id,
            ))
          )
            return { outcome: "conversation_source_mismatch" };
          const readSnapshot = this.#options.readDesktopGoalSnapshot;
          if (!readSnapshot) throw new Error("DIRECT_GOAL_DESKTOP_EXACT_READER_REQUIRED");
          const snapshot = await readSnapshot(url, accountSourceId, signal);
          if (desktopChatAccountSourceId(await auth.readPrincipal(signal)) !== accountSourceId)
            return { outcome: "account_changed" };
          signal.throwIfAborted();
          return projectDesktopExactCompletion(
            snapshot,
            url,
            anchor === undefined ? {} : { anchor },
            principal,
          );
        },
        verifyDesktopCompletion: async (candidate, signal) => {
          signal.throwIfAborted();
          const url = normalizeChatGptConversationUrl(candidate.conversationUrl);
          if (!url || !candidate.finalMessageId) throw new Error("DESKTOP_CHAT_COMPLETION_INVALID");
          const auth = new DesktopChatApiClient((method, params) =>
            ownedPrimary.client.request(method, params, { signal }),
          );
          const principal = await auth.readPrincipal(signal);
          const accountSourceId = desktopChatAccountSourceId(principal);
          if (
            !(await new DesktopChatConversationSources(codexHome).hasConversationSource(
              accountSourceId,
              url.slice("https://chatgpt.com/c/".length),
            ))
          )
            return { outcome: "conversation_source_mismatch" };
          const readSnapshot = this.#options.readDesktopGoalSnapshot;
          if (!readSnapshot) throw new Error("DIRECT_GOAL_DESKTOP_EXACT_READER_REQUIRED");
          const snapshot = await readSnapshot(url, accountSourceId, signal);
          if (desktopChatAccountSourceId(await auth.readPrincipal(signal)) !== accountSourceId)
            return { outcome: "account_changed" };
          signal.throwIfAborted();
          return projectDesktopExactCompletion(snapshot, url, { candidate }, principal);
        },
        inspectDesktopChatEvents: async () => {
          const events = new DesktopChatEventSource();
          try {
            await events.ensureConnected(() => {}, AbortSignal.timeout(15_000));
            const status = events.status;
            if (status === undefined) throw new Error("DESKTOP_CHAT_EVENT_CONNECTION_LOST");
            return status;
          } finally {
            await events.stop();
          }
        },
        approveChromeFileMaterialization: (chatGptConversationUrl) =>
          browserNativeExecutor.call({
            operation: "exec",
            surface: "chrome",
            title: "Approve exact OmniCodex file materialization",
            code: chromeFileMaterializationApprovalCode(chatGptConversationUrl),
          }),
        startConvergenceMonitor: (onStateChange) => convergence.start(onStateChange),
        stopChildren: async () => {
          const errors: Error[] = [];
          // Stop callbacks that can publish status before independently owned
          // clients and App Servers begin retiring.
          // Admission has drained. Stop the shared discovery Responses driver
          // alongside convergence so an aborted refresh cannot remain queued
          // behind a discovery turn whose stop used to come after this wait.
          await Promise.all([
            captureStopError(errors, () =>
              this.#shutdownStep("catalog-convergence", () => convergence.stop()),
            ),
            captureStopError(errors, () =>
              this.#shutdownStep("operator-responses", () => responses.stop()),
            ),
          ]);
          await captureStopError(errors, () =>
            this.#shutdownStep("browser-activity-coordinator", () =>
              browserActivityCoordinator.close({ preserveActivities: true }),
            ),
          );
          if (ownedRuntimeDispatchMcp !== undefined) {
            await captureStopError(errors, () =>
              this.#shutdownStep("runtime-dispatch-mcp", () =>
                ownedRuntimeDispatchMcp.server.close(),
              ),
            );
          }
          // Native promises retain their lane and durable resource lease until
          // authoritative settlement. At the deadline shutdown() persists an
          // outcome-unknown fence before any underlying client is retired.
          await captureStopError(errors, () =>
            this.#shutdownStep("native-execution-scheduler", () =>
              ownedNativeExecutionScheduler.shutdown(this.#shutdownPhaseTimeoutMs),
            ),
          );
          // Session executors retire their owned native threads through the
          // stable primary client. Closing that client in the same Promise.all
          // races those final RPCs and turns an otherwise clean deployment into
          // `Restartable Codex App Server client is closed`. Quiesce every
          // client first, then retire the primary transport last.
          await captureStopError(errors, () =>
            this.#shutdownStep("work-session-executors", () =>
              ownedSessionExecutorPool.close({ preserveBrowserActivities: true }),
            ),
          );
          // The shared operator/UI executor is outside the per-Chat pool.
          // Publish its outstanding native turn endings before stopping its
          // App Server; preserving remote Chat activities does not own it.
          await captureStopError(errors, () =>
            this.#shutdownStep(
              "operator-responses-lease",
              () => operatorResponsesLease?.release() ?? Promise.resolve(),
            ),
          );
          await captureStopError(errors, () =>
            this.#shutdownStep("operator-browser", () => browserNativeExecutor.close()),
          );
          collectSettledErrors(
            errors,
            await Promise.allSettled([
              this.#shutdownStep("detached-threads", async () => detachedThreads.dispose()),
              this.#shutdownStep("desktop-ipc", async () => desktopIpc.dispose()),
              this.#shutdownStep("app-tools", async () => appTools.close()),
            ]),
          );
          await captureStopError(errors, () =>
            this.#shutdownStep("primary-app-server", () => ownedPrimary.stop()),
          );
          if (errors.length > 0) {
            throw new AggregateError(errors, "OmniCodex owned runtime did not stop cleanly");
          }
        },
      };
    } catch (error) {
      desktopIpc.dispose();
      appTools.close();
      const retryCleanup = async () => {
        const cleanupErrors: Error[] = [];
        const partialSessionExecutorPool = sessionExecutorPool;
        const partialNativeExecutionScheduler = nativeExecutionScheduler;
        const primaryToStop = primary;
        const runtimeDispatchToClose = runtimeDispatchMcp;
        if (ownedBrowserNativeExecutor !== undefined) {
          const browserToClose = ownedBrowserNativeExecutor;
          await captureStopError(cleanupErrors, () => browserToClose.close());
        }
        collectSettledErrors(
          cleanupErrors,
          await Promise.allSettled([
            Promise.resolve().then(() => detachedThreads.dispose()),
            ...(runtimeDispatchToClose === undefined
              ? []
              : [Promise.resolve().then(() => runtimeDispatchToClose.server.close())]),
            ...(partialNativeExecutionScheduler === undefined
              ? []
              : [
                  Promise.resolve().then(() =>
                    partialNativeExecutionScheduler.shutdown(this.#shutdownPhaseTimeoutMs),
                  ),
                ]),
            ...(partialSessionExecutorPool === undefined
              ? []
              : [Promise.resolve().then(() => partialSessionExecutorPool.close())]),
            Promise.resolve().then(() => responses.stop()),
            ...(primaryToStop === undefined
              ? []
              : [Promise.resolve().then(() => primaryToStop.stop())]),
          ]),
        );
        const operatorLeaseToRelease = operatorResponsesLease;
        if (operatorLeaseToRelease !== undefined) {
          await captureStopError(cleanupErrors, () => operatorLeaseToRelease.release());
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(cleanupErrors, "Owned partial runtime did not stop cleanly");
        }
      };
      try {
        await retryCleanup();
      } catch (cleanupError) {
        throw new OwnedRuntimeCleanupFailure(error, cleanupError, retryCleanup);
      }
      throw error;
    }
  }

  #readyStatus(
    runtime: OmniCodexPreparedRuntime,
    address: StreamableHttpGatewayAddress,
  ): OmniCodexGatewayStatus {
    return {
      lifecycle: runtime.bridgeRegistryCurrent ? "ready" : "converging",
      candidate: runtime.candidate,
      address,
      appServerMethodCount: runtime.appServerMethodCount,
      downstreamToolCount: runtime.downstreamToolCount,
      responsesToolCount: runtime.responsesToolCount,
      hostToolCount: runtime.hostToolCount,
      bridgeThreadId: runtime.bridgeThreadId,
      bridgeDisposition: runtime.bridgeDisposition,
      bridgeRegistryCurrent: runtime.bridgeRegistryCurrent,
      ...(runtime.bridgeConvergenceError === undefined
        ? {}
        : {
            bridgeConvergenceError: runtime.bridgeConvergenceError,
            lastError: runtime.bridgeConvergenceError,
          }),
    };
  }

  async #verifyBoundary(baseline: CodexBoundarySnapshot | undefined): Promise<void> {
    if (baseline === undefined || this.#options.nonInterferenceBoundary === undefined) return;
    try {
      await this.#options.nonInterferenceBoundary.assertUnchanged(baseline);
    } catch (error) {
      throw new CodexBoundaryViolation(toError(error));
    }
  }
}

class CodexBoundaryViolation extends Error {
  constructor(cause: Error) {
    super(cause.message, { cause });
    this.name = "CodexBoundaryViolation";
  }
}

class RuntimeTransitionInvalidatedError extends Error {
  constructor(cause?: Error) {
    super("OmniCodex runtime transition was invalidated by shutdown", {
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = "RuntimeTransitionInvalidatedError";
  }
}

export class CommittedRuntimeSwitchFailure extends Error {
  readonly reasonCode = "committed_runtime_finalization_failed" as const;

  constructor(phase: string, cause: Error) {
    super(`Runtime switch committed, but ${phase}: ${errorSummary(cause)}`, { cause });
    this.name = "CommittedRuntimeSwitchFailure";
  }
}

class OwnedRuntimeCleanupFailure extends Error {
  readonly retryCleanup: () => Promise<void>;

  constructor(originalError: unknown, cleanupError: unknown, retryCleanup: () => Promise<void>) {
    super("Owned Codex runtime cleanup failed; refusing a replacement runtime", {
      cause: new AggregateError([toError(originalError), toError(cleanupError)]),
    });
    this.name = "OwnedRuntimeCleanupFailure";
    this.retryCleanup = retryCleanup;
  }
}

function unavailableDynamicToolResponse(): {
  success: boolean;
  contentItems: { type: "inputText"; text: string }[];
} {
  return {
    success: false,
    contentItems: [
      { type: "inputText", text: "The OmniCodex native host tool executor is not ready." },
    ],
  };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface CodexAppToolsContextResolverOptions {
  readonly initialPreferredThreadId?: string;
  /** Late-bound durable Bridge context used when an executor-only thread is rejected by the renderer. */
  readonly fallbackThreadId?: () => string | undefined;
  readonly now?: () => number;
  readonly validationTtlMs?: number;
  readonly deadlineMs?: number;
  readonly probeTimeoutMs?: number;
  readonly maxCandidates?: number;
}

/**
 * Resolves a calling context accepted by the installed app-global tools host.
 * Desktop writer ownership is intentionally irrelevant: the native renderer
 * decides whether a thread is a valid calling context, while each tool's
 * target remains in its arguments.
 */
export function createCodexAppToolsContextResolver(
  appServer: AppServerRpcClient,
  appTools: Pick<CodexAppToolsClient, "callTool">,
  options: CodexAppToolsContextResolverOptions = {},
): (
  preferredThreadId?: string,
  excludedThreadIds?: readonly string[],
  context?: Pick<CodexAppHostToolCallContext, "deadlineUnixMs" | "signal" | "timeoutMs">,
) => Promise<string | undefined> {
  const now = options.now ?? Date.now;
  const validationTtlMs =
    optionalNonNegativeSafeInteger(
      options.validationTtlMs,
      "Codex app-tools context validation TTL",
    ) ?? 0;
  const deadlineMs = optionalPositiveSafeInteger(
    options.deadlineMs,
    "Codex app-tools context discovery deadline",
  );
  const probeTimeoutMs = optionalPositiveSafeInteger(
    options.probeTimeoutMs,
    "Codex app-tools context probe timeout",
  );
  const maxCandidates = optionalPositiveSafeInteger(
    options.maxCandidates,
    "Codex app-tools context candidate limit",
  );
  let cachedThreadId: string | undefined;
  let cachedValidatedAt = 0;
  const resolvingByPreferred = new Map<string, Promise<string | undefined>>();

  const isAcceptedNativeContext = async (
    threadId: string,
    deadlineUnixMs?: number,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const operationId = randomUUID();
    const remainingMs =
      deadlineUnixMs === undefined ? undefined : remainingDuration(deadlineUnixMs, now);
    const timeoutMs =
      probeTimeoutMs === undefined
        ? remainingMs
        : remainingMs === undefined
          ? probeTimeoutMs
          : Math.min(probeTimeoutMs, remainingMs);
    const response = await appTools.callTool(
      {
        arguments: { limit: 1 },
        callId: operationId,
        namespace: "codex_app",
        threadId,
        tool: "list_threads",
        turnId: `omnicodex-context-${operationId}`,
      },
      appToolsRequestBoundary(timeoutMs, deadlineUnixMs, signal),
    );
    return response.success === true;
  };

  const firstAcceptedNativeContext = async (
    threadIds: readonly string[],
    deadlineUnixMs?: number,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    if (threadIds.length === 0) return undefined;
    const accepted = await Promise.all(
      threadIds.map((threadId) => isAcceptedNativeContext(threadId, deadlineUnixMs, signal)),
    );
    return threadIds[accepted.findIndex(Boolean)];
  };

  const discover = async (
    preferredThreadId?: string,
    excludedThreadIds: readonly string[] = [],
    context: Pick<CodexAppHostToolCallContext, "deadlineUnixMs" | "signal" | "timeoutMs"> = {},
  ): Promise<string | undefined> => {
    const deadline = appToolsContextDeadline(context, deadlineMs, now);
    throwIfAppToolsContextBoundaryElapsed(deadline, context.signal, now);
    const excluded = new Set(
      excludedThreadIds.flatMap((value) => {
        const normalized = nonEmptyString(value);
        return normalized === undefined ? [] : [normalized];
      }),
    );
    const priority = [
      ...new Set(
        [
          preferredThreadId,
          cachedThreadId,
          options.initialPreferredThreadId,
          options.fallbackThreadId?.(),
        ].filter(
          (value): value is string =>
            nonEmptyString(value) !== undefined && !excluded.has(value as string),
        ),
      ),
    ];
    for (const threadId of priority) {
      if (await isAcceptedNativeContext(threadId, deadline, context.signal)) {
        cachedThreadId = threadId;
        cachedValidatedAt = now();
        return threadId;
      }
    }
    cachedThreadId = undefined;
    cachedValidatedAt = 0;

    let cursor: string | undefined;
    const observedCursors = new Set<string>();
    const observedThreadIds = new Set(priority);
    let inspectedCandidates = 0;
    while (maxCandidates === undefined || inspectedCandidates < maxCandidates) {
      const remainingMs = deadline === undefined ? undefined : remainingDuration(deadline, now);
      const remainingCandidates =
        maxCandidates === undefined ? 100 : maxCandidates - inspectedCandidates;
      const page = await appServer.request<unknown>(
        "thread/list",
        {
          archived: false,
          limit: Math.min(100, remainingCandidates),
          modelProviders: [],
          sourceKinds: [...APP_SERVER_THREAD_INVENTORY_SOURCE_KINDS],
          sortDirection: "desc",
          sortKey: "recency_at",
          useStateDbOnly: true,
          ...(cursor === undefined ? {} : { cursor }),
        },
        appServerRequestBoundary(remainingMs, deadline, context.signal),
      );
      if (!isObject(page) || !Array.isArray(page.data)) {
        throw new Error("Codex App Server did not return threads for app-tools context discovery");
      }
      const discoveredCandidates = page.data.flatMap((value) => {
        if (!isObject(value) || typeof value.id !== "string") return [];
        if (observedThreadIds.has(value.id) || excluded.has(value.id)) return [];
        observedThreadIds.add(value.id);
        return [value.id];
      });
      const candidates =
        maxCandidates === undefined
          ? discoveredCandidates
          : discoveredCandidates.slice(0, maxCandidates - inspectedCandidates);
      inspectedCandidates += candidates.length;
      for (let offset = 0; offset < candidates.length; offset += 4) {
        const match = await firstAcceptedNativeContext(
          candidates.slice(offset, offset + 4),
          deadline,
          context.signal,
        );
        if (match !== undefined) {
          cachedThreadId = match;
          cachedValidatedAt = now();
          return match;
        }
      }
      const nextCursor = nonEmptyString(page.nextCursor);
      if (nextCursor === undefined) return undefined;
      if (observedCursors.has(nextCursor)) {
        throw new Error("Codex App Server repeated an app-tools context discovery cursor");
      }
      observedCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return undefined;
  };

  return async (
    preferredThreadId?: string,
    excludedThreadIds: readonly string[] = [],
    context: Pick<CodexAppHostToolCallContext, "deadlineUnixMs" | "signal" | "timeoutMs"> = {},
  ) => {
    const callerDeadline = appToolsContextDeadline(context, undefined, now);
    throwIfAppToolsContextBoundaryElapsed(callerDeadline, context.signal, now);
    const normalizedContext = {
      ...context,
      ...(callerDeadline === undefined ? {} : { deadlineUnixMs: callerDeadline }),
    };
    const excluded = new Set(
      excludedThreadIds.flatMap((value) => {
        const normalized = nonEmptyString(value);
        return normalized === undefined ? [] : [normalized];
      }),
    );
    if (
      cachedThreadId !== undefined &&
      !excluded.has(cachedThreadId) &&
      (preferredThreadId === undefined || preferredThreadId === cachedThreadId) &&
      now() - cachedValidatedAt < validationTtlMs
    ) {
      return cachedThreadId;
    }
    const key = `${nonEmptyString(preferredThreadId) ?? "<fallback>"}\u0000${[...excluded]
      .sort((left, right) => left.localeCompare(right, "en"))
      .join("\u0000")}`;
    const callerBound = context.signal !== undefined || callerDeadline !== undefined;
    const existing = callerBound ? undefined : resolvingByPreferred.get(key);
    if (existing !== undefined) return existing;
    let current!: Promise<string | undefined>;
    current = discover(preferredThreadId, [...excluded], normalizedContext).finally(() => {
      if (!callerBound && resolvingByPreferred.get(key) === current) {
        resolvingByPreferred.delete(key);
      }
    });
    if (!callerBound) resolvingByPreferred.set(key, current);
    return current;
  };
}

const OMNICODEX_BRIDGE_CONTEXT_REGISTRY_DIGEST = omniCodexBridgeRegistryDigest(
  OMNICODEX_BRIDGE_CONTEXT_TOOLS,
);

function codexCatalogGeneration(
  codeModeSurface: CodeModeNativeToolSurface,
): OmniCodexCatalogGeneration {
  return {
    codeModeCatalogDigest: omniCodexBridgeRegistryDigest(codeModeSurface.dynamicToolSpecs),
    // Catalog changes refresh code-mode and Responses surfaces only; they
    // never replace the context-only Bridge thread.
    bridgeRegistryDigest: OMNICODEX_BRIDGE_CONTEXT_REGISTRY_DIGEST,
  };
}

function sameConvergenceSnapshot(
  left: OmniCodexCatalogConvergenceSnapshot,
  right: OmniCodexCatalogConvergenceSnapshot,
): boolean {
  return (
    left.bridgeThreadId === right.bridgeThreadId &&
    left.bridgeDisposition === right.bridgeDisposition &&
    left.bridgeRegistryCurrent === right.bridgeRegistryCurrent &&
    left.bridgeConvergenceError === right.bridgeConvergenceError
  );
}

async function probeRuntimeEndpoint(address: StreamableHttpGatewayAddress): Promise<void> {
  const origin = `http://${address.host}:${address.port}`;
  const [metadata, unauthorized] = await Promise.all([
    fetch(`${origin}/.well-known/oauth-protected-resource${address.fullPath}`, {
      headers: { "User-Agent": "OmniCodex-Runtime-Observation/1" },
    }),
    fetch(`${origin}${address.fullPath}`, {
      headers: {
        Accept: "application/json, text/event-stream",
        "User-Agent": "OmniCodex-Runtime-Observation/1",
      },
    }),
  ]);
  if (metadata.status !== 200 || unauthorized.status !== 401) {
    throw new Error(
      `Runtime observation failed (metadata=${metadata.status}, unauthorized=${unauthorized.status})`,
    );
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function delayWithSignal(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (signal === undefined) return delay(milliseconds);
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function assertInteractiveDrainDeadline(
  deadlineUnixMs: number | undefined,
  activeConversationIds: readonly string[],
): void {
  if (deadlineUnixMs === undefined || Date.now() < deadlineUnixMs) return;
  const active =
    activeConversationIds.length === 0
      ? ""
      : `: ${activeConversationIds
          .slice()
          .sort((a, b) => a.localeCompare(b, "en"))
          .join(", ")}`;
  throw new Error(`Interactive Web conversations did not become idle before the deadline${active}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function optionalPositiveSafeInteger(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function optionalNonNegativeSafeInteger(
  value: number | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function appToolsContextDeadline(
  context: Pick<CodexAppHostToolCallContext, "deadlineUnixMs" | "timeoutMs">,
  configuredTimeoutMs: number | undefined,
  now: () => number,
): number | undefined {
  const current = now();
  const deadlines: number[] = [];
  for (const [timeoutMs, label] of [
    [context.timeoutMs, "Codex app-tools caller timeout"],
    [configuredTimeoutMs, "Codex app-tools configured timeout"],
  ] as const) {
    if (timeoutMs === undefined) continue;
    const normalized = optionalNonNegativeSafeInteger(timeoutMs, label) as number;
    if (normalized > Number.MAX_SAFE_INTEGER - current) {
      throw new RangeError(`${label} exceeds the representable timestamp range`);
    }
    deadlines.push(current + normalized);
  }
  if (context.deadlineUnixMs !== undefined) {
    deadlines.push(
      optionalNonNegativeSafeInteger(
        context.deadlineUnixMs,
        "Codex app-tools caller deadline",
      ) as number,
    );
  }
  return deadlines.length === 0 ? undefined : Math.min(...deadlines);
}

function appToolsRequestBoundary(
  timeoutMs: number | undefined,
  deadlineUnixMs: number | undefined,
  signal: AbortSignal | undefined,
):
  | { readonly deadlineUnixMs?: number; readonly signal?: AbortSignal; readonly timeoutMs?: number }
  | undefined {
  if (timeoutMs === undefined && deadlineUnixMs === undefined && signal === undefined)
    return undefined;
  return {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(deadlineUnixMs === undefined ? {} : { deadlineUnixMs }),
    ...(signal === undefined ? {} : { signal }),
  };
}

function appServerRequestBoundary(
  timeoutMs: number | undefined,
  deadlineUnixMs: number | undefined,
  signal: AbortSignal | undefined,
): AppServerRpcRequestOptions | undefined {
  return appToolsRequestBoundary(timeoutMs, deadlineUnixMs, signal);
}

function throwIfAppToolsContextBoundaryElapsed(
  deadlineUnixMs: number | undefined,
  signal: AbortSignal | undefined,
  now: () => number,
): void {
  if (signal?.aborted === true) {
    if (signal.reason instanceof Error) throw signal.reason;
    const error = new Error("Codex app-tools context resolution was aborted");
    error.name = "AbortError";
    throw error;
  }
  if (deadlineUnixMs !== undefined && deadlineUnixMs <= now()) {
    const error = new Error("Codex app-tools context discovery deadline exceeded");
    error.name = "TimeoutError";
    throw error;
  }
}

function remainingDuration(deadlineUnixMs: number, now: () => number): number {
  const remaining = deadlineUnixMs - now();
  if (remaining <= 0) throw new Error("Codex app-tools context discovery deadline exceeded");
  return remaining;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function nativeCallSignal(
  kind: "call" | "callInContext",
  args: readonly unknown[],
): AbortSignal | undefined {
  const candidate = args[kind === "call" ? 5 : 6];
  return candidate instanceof AbortSignal ? candidate : undefined;
}

function nativeCallArgumentsWithoutSignal(
  kind: "call" | "callInContext",
  args: readonly unknown[],
): unknown[] {
  const forwarded = [...args];
  forwarded[kind === "call" ? 5 : 6] = undefined;
  return forwarded;
}

function sessionAbortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  const error = new Error(
    reason instanceof Error ? reason.message : String(reason ?? "Native call cancelled"),
    { cause: reason },
  );
  error.name = "AbortError";
  return error;
}

function combinedAbortSignal(
  lifecycleSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): AbortSignal {
  return callerSignal === undefined
    ? lifecycleSignal
    : AbortSignal.any([lifecycleSignal, callerSignal]);
}

function throwIfRuntimePreparationAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("OmniCodex runtime preparation was aborted");
}

function throwIfSessionAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("OmniCodex MCP session executor was aborted");
}

function awaitSessionPromise<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfSessionAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () =>
      finish(() => {
        try {
          throwIfSessionAborted(signal);
        } catch (error) {
          reject(error);
        }
      });
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function isTransientStartupReadinessError(value: unknown): boolean {
  return visitStartupReadinessError(toError(value), new Set<Error>());
}

function visitStartupReadinessError(error: Error, visited: Set<Error>): boolean {
  if (visited.has(error)) return false;
  visited.add(error);
  if (error instanceof CodexAppToolsSharedReadinessError) return true;
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.every((nested) => visitStartupReadinessError(toError(nested), visited));
  }
  if (error.cause !== undefined) {
    return visitStartupReadinessError(toError(error.cause), visited);
  }
  const message = error.message.toLocaleLowerCase("en-US");
  return TRANSIENT_STARTUP_READINESS_MESSAGES.some((fragment) => message.includes(fragment));
}

function containsSharedAppToolsReadinessError(value: unknown): boolean {
  return visitErrorTree(value, (error) => error instanceof CodexAppToolsSharedReadinessError);
}

type RuntimeStartupFailureClassification =
  | { readonly kind: "shared_desktop_readiness" }
  | { readonly kind: "transient_candidate_readiness" }
  | {
      readonly kind: "candidate_local_incompatibility";
      readonly reason: "process_launch" | "process_exit" | "protocol" | "schema";
    }
  | { readonly kind: "fatal_or_common" };

function classifyRuntimeStartupFailure(value: unknown): RuntimeStartupFailureClassification {
  if (containsSharedAppToolsReadinessError(value)) {
    return { kind: "shared_desktop_readiness" };
  }
  if (isTransientStartupReadinessError(value)) {
    return { kind: "transient_candidate_readiness" };
  }
  const candidateLocal = candidateLocalFailureReason(value);
  return candidateLocal === undefined
    ? { kind: "fatal_or_common" }
    : { kind: "candidate_local_incompatibility", reason: candidateLocal };
}

function candidateLocalFailureReason(
  value: unknown,
): "process_launch" | "process_exit" | "protocol" | "schema" | undefined {
  let result: "process_launch" | "process_exit" | "protocol" | "schema" | undefined;
  visitErrorTree(value, (error) => {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { readonly code?: unknown }).code).toUpperCase()
        : "";
    const syscall =
      typeof error === "object" && error !== null && "syscall" in error
        ? String((error as { readonly syscall?: unknown }).syscall).toLocaleLowerCase("en-US")
        : "";
    const message = error.message.toLocaleLowerCase("en-US");
    if (
      code === "CODEX_RUNTIME_CANDIDATE_LOCAL" ||
      (["ENOENT", "ENOEXEC", "EACCES", "EPERM", "EINVAL", "UNKNOWN"].includes(code) &&
        (syscall.startsWith("spawn") || message.includes("spawn ")))
    ) {
      result = "process_launch";
      return true;
    }
    if (
      message.includes("codex app server exited (") ||
      message.includes("codex app server exited during ownership registration") ||
      message.includes("codex app server did not expose stdio pipes")
    ) {
      result = "process_exit";
      return true;
    }
    if (
      message.includes("codex app server schema generation failed") ||
      message.includes("generated codex clientrequest schema is invalid")
    ) {
      result = "schema";
      return true;
    }
    if (code === "CODEX_APP_SERVER_PROTOCOL_INCOMPATIBLE") {
      result = "protocol";
      return true;
    }
    const namesCandidateProtocol =
      message.includes("codex app server") || message.includes("app server protocol");
    const provesIncompatibility =
      message.includes("unsupported") || message.includes("incompatible");
    if (namesCandidateProtocol && provesIncompatibility) {
      result = "protocol";
      return true;
    }
    return false;
  });
  return result;
}

function visitErrorTree(value: unknown, predicate: (error: Error) => boolean): boolean {
  const pending = [toError(value)];
  const visited = new Set<Error>();
  while (pending.length > 0) {
    const error = pending.pop();
    if (error === undefined || visited.has(error)) continue;
    visited.add(error);
    if (predicate(error)) return true;
    if (error instanceof AggregateError) {
      for (const nested of error.errors) pending.push(toError(nested));
    }
    if (error.cause !== undefined) pending.push(toError(error.cause));
  }
  return false;
}

function errorSummary(value: unknown): string {
  const visited = new Set<Error>();
  const summarize = (candidate: unknown): string => {
    const error = toError(candidate);
    if (visited.has(error)) return `[circular ${error.name}: ${error.message}]`;
    visited.add(error);
    const code = "code" in error && error.code !== undefined ? ` code=${String(error.code)}` : "";
    const head = `${error.name}${code}: ${error.message}`;
    const nested =
      error instanceof AggregateError
        ? error.errors.map(summarize)
        : error.cause === undefined
          ? []
          : [summarize(error.cause)];
    return nested.length === 0 ? head : `${head} (${nested.join("; ")})`;
  };
  return summarize(value);
}

async function captureStopError(errors: Error[], operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(toError(error));
  }
}

function collectSettledErrors(
  errors: Error[],
  results: readonly PromiseSettledResult<unknown>[],
): void {
  for (const result of results) {
    if (result.status === "rejected") errors.push(toError(result.reason));
  }
}

async function captureBoundedStopError(
  errors: Error[],
  phase: string,
  timeoutMs: number | undefined,
  operation: () => Promise<void>,
): Promise<void> {
  if (timeoutMs === undefined) {
    await captureStopError(errors, operation);
    return;
  }
  try {
    const outcome = await settleBefore(operation(), timeoutMs);
    if (!outcome.settled) {
      errors.push(new Error(`Owned runtime ${phase} stop exceeded its ${timeoutMs}ms deadline`));
    }
  } catch (error) {
    errors.push(toError(error));
  }
}

function settleBefore<T>(
  operation: Promise<T>,
  timeoutMs: number | undefined,
): Promise<{ readonly settled: true; readonly value: T } | { readonly settled: false }> {
  if (timeoutMs === undefined) {
    return operation.then((value) => ({ settled: true as const, value }));
  }
  return new Promise((resolveOutcome, rejectOutcome) => {
    let finished = false;
    const cancelTimeout = scheduleLongTimeout(timeoutMs, () => {
      if (finished) return;
      finished = true;
      resolveOutcome({ settled: false });
    });
    void operation.then(
      (value) => {
        if (finished) return;
        finished = true;
        cancelTimeout();
        resolveOutcome({ settled: true, value });
      },
      (error: unknown) => {
        if (finished) return;
        finished = true;
        cancelTimeout();
        rejectOutcome(error);
      },
    );
  });
}

async function awaitRuntimeDrained(
  gateway: OmniCodexRuntimeGateway,
  timeoutMs: number | undefined,
): Promise<void> {
  // The runtime gateway API represents a wait with one Node timer. Chaining
  // the largest physically supported timer frame preserves its notifications
  // without turning that frame into a total lifecycle deadline or overflowing
  // an explicitly longer operator deadline.
  const startedAt = performance.now();
  while (true) {
    const remainingMs =
      timeoutMs === undefined ? undefined : timeoutMs - (performance.now() - startedAt);
    if (remainingMs !== undefined && remainingMs <= 0) {
      const status = gateway.runtimeStatus;
      throw new Error(
        `Runtime drain deadline expired with ${status.activeMcpRequests} active request(s)`,
      );
    }
    const frameMs = Math.min(
      remainingMs === undefined ? MAX_NODE_TIMER_DELAY_MS : Math.ceil(remainingMs),
      MAX_NODE_TIMER_DELAY_MS,
    );
    let frameSettled: boolean;
    try {
      frameSettled = (await settleBefore(gateway.awaitDrained(frameMs), frameMs)).settled;
    } catch (error) {
      if (
        gateway.runtimeStatus.activeMcpRequests > 0 &&
        errorSummary(error).toLocaleLowerCase("en-US").includes("drain timed out")
      ) {
        frameSettled = false;
      } else {
        throw error;
      }
    }
    if (frameSettled || gateway.runtimeStatus.activeMcpRequests === 0) return;
    if (timeoutMs === undefined) continue;
  }
}

function scheduleLongTimeout(timeoutMs: number, action: () => void): () => void {
  const startedAt = performance.now();
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (cancelled) return;
    const remainingMs = timeoutMs - (performance.now() - startedAt);
    if (remainingMs <= 0) {
      action();
      return;
    }
    const frameMs = Math.min(Math.ceil(remainingMs), MAX_NODE_TIMER_DELAY_MS);
    timer = setTimeout(() => {
      schedule();
    }, frameMs);
    timer.unref?.();
  };
  schedule();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

function minimumDefined(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return Math.min(first, second);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function gatewayListenerStopped(gateway: OmniCodexRuntimeGateway): boolean {
  return "address" in gateway && gateway.address === undefined;
}

export function chromeFileMaterializationApprovalCode(chatGptConversationUrl: string): string {
  const exactConversationUrl = normalizeChatGptConversationUrl(chatGptConversationUrl);
  if (exactConversationUrl === undefined) {
    throw new Error("Exact ChatGPT conversation URL required for Chrome approval dispatch");
  }
  return [
    `await browser.nameSession("🔐 OmniCodex approval");`,
    `const __omniExactConversationUrl = ${JSON.stringify(exactConversationUrl)};`,
    `const __omniNormalizeConversationUrl = (value) => {`,
    `  try { const url = new URL(value); return url.origin + url.pathname; } catch { return undefined; }`,
    `};`,
    `const __omniCandidates = (await browser.user.openTabs()).filter((tab) =>`,
    `  typeof tab.url === "string" && __omniNormalizeConversationUrl(tab.url) === __omniExactConversationUrl`,
    `);`,
    `if (__omniCandidates.length === 0) return { candidateCount: 0, activatedCount: 0, outcome: "conversation_not_open" };`,
    `const __omniTab = await browser.user.claimTab(__omniCandidates[0]);`,
    `const __omniHeading = __omniTab.playwright.getByRole("heading", { name: "파일 생성을 허용할까요?", exact: true })`,
    `  .or(__omniTab.playwright.getByRole("heading", { name: "Allow file materialization?", exact: true }))`,
    `  .or(__omniTab.playwright.getByText("파일 생성을 허용할까요?", { exact: true }))`,
    `  .or(__omniTab.playwright.getByText("Allow file materialization?", { exact: true }));`,
    `try { await __omniHeading.waitFor({ state: "visible", timeoutMs: 30000 }); } catch {`,
    `  return { candidateCount: __omniCandidates.length, activatedCount: 0, outcome: "approval_not_visible" };`,
    `}`,
    `const __omniDialog = __omniHeading.locator('xpath=ancestor::*[@data-testid="tool-approval-card" or self::dialog or @role="dialog" or @role="alertdialog" or @aria-modal="true"][1]');`,
    `const __omniDescription = __omniDialog.getByText(/(?:ChatGPT가 OmniCodex에서 반환된 .*파일 첨부를 실제로 생성하려면 승인이 필요합니다|ChatGPT needs your approval to materialize .*file attachments returned by OmniCodex)/i);`,
    `const __omniAllow = __omniDialog.getByRole("button", { name: "허용하기", exact: true })`,
    `  .or(__omniDialog.getByRole("button", { name: "Allow", exact: true }));`,
    `const __omniReject = __omniDialog.getByRole("button", { name: "거절하기", exact: true })`,
    `  .or(__omniDialog.getByRole("button", { name: "Reject", exact: true }));`,
    `const [__omniHeadings, __omniDialogs, __omniDescriptions, __omniAllows, __omniRejects] = await Promise.all([`,
    `  __omniHeading.count(), __omniDialog.count(), __omniDescription.count(), __omniAllow.count(), __omniReject.count(),`,
    `]);`,
    `if (__omniHeadings !== 1 || __omniDialogs !== 1 || __omniDescriptions !== 1 || __omniAllows !== 1 || __omniRejects !== 1) {`,
    `  return { candidateCount: __omniCandidates.length, activatedCount: 0, outcome: "approval_scope_ambiguous" };`,
    `}`,
    `const __omniOptions = __omniDialog.locator('button[aria-haspopup="menu"][aria-label^="Allow OmniCodex"],button[aria-haspopup="menu"][aria-label^="OmniCodex 허용"],button[aria-haspopup="menu"]:not(:has-text("허용하기")):not(:has-text("Allow"))');`,
    `const __omniOptionCount = await __omniOptions.count();`,
    `if (__omniOptionCount === 1) {`,
    `  await __omniOptions.click({ timeoutMs: 5000 });`,
    `  const __omniAlways = __omniTab.playwright.getByRole("menuitem", { name: "항상 허용", exact: true })`,
    `    .or(__omniTab.playwright.getByRole("menuitem", { name: "Always allow", exact: true }))`,
    `    .or(__omniTab.playwright.getByRole("menuitem", { name: "Allow OmniCodex for this conversation", exact: true }))`,
    `    .or(__omniTab.playwright.getByRole("menuitemradio", { name: "항상 허용", exact: true }))`,
    `    .or(__omniTab.playwright.getByRole("menuitemradio", { name: "Always allow", exact: true }))`,
    `    .or(__omniTab.playwright.getByRole("button", { name: "항상 허용", exact: true }))`,
    `    .or(__omniTab.playwright.getByRole("button", { name: "Always allow", exact: true }));`,
    `  await __omniAlways.waitFor({ state: "visible", timeoutMs: 5000 });`,
    `  if (await __omniAlways.count() !== 1) return { candidateCount: __omniCandidates.length, activatedCount: 0, outcome: "persistent_scope_ambiguous" };`,
    `  await __omniAlways.click({ timeoutMs: 5000 });`,
    `} else {`,
    `  await __omniAllow.click({ timeoutMs: 5000 });`,
    `}`,
    `await __omniHeading.waitFor({ state: "hidden", timeoutMs: 10000 });`,
    `return { candidateCount: __omniCandidates.length, activatedCount: 1, outcome: __omniOptionCount === 1 ? "persistent_activated" : "one_time_activated" };`,
  ].join("\n");
}
